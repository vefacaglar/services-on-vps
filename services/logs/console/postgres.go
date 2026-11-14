package main

import (
	"context"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// PostgreSQL inspector with an opt-in write mode. The browser never sees the
// DSN: every /api/pg/* route is allowlisted here and runs fixed catalog
// queries (or one user statement from the SQL editor) server-side. One DSN
// (POSTGRES_URL) serves both modes; reads and writes use separate connection
// configs built from it. Writes live in postgres_write.go.
//
// Read path, defence in depth regardless of the role's own grants:
//   - every request uses its own short-lived connection, at most pgMaxConns at
//     once, so no session state survives a request and the role's
//     CONNECTION LIMIT is never exceeded;
//   - the connection starts with default_transaction_read_only=on and all work
//     runs inside BEGIN READ ONLY with local statement, lock and
//     idle-in-transaction timeouts, then ROLLBACK;
//   - user SQL goes through the extended protocol, which rejects multiple
//     statements;
//   - rows, cell values and the response size are capped;
//   - the DSN and password are scrubbed from every error;
//   - COPY and server-file/program functions are refused lexically in user
//     SQL (best effort; see postgres_guard.go). The real protection is a
//     non-superuser role, and the UI warns when connected as superuser.

const (
	pgMaxConns       = 3
	pgStatementLimit = "5s"
	pgRequestTimeout = 15 * time.Second
	pgMaxRows        = 500
	pgMaxCell        = 2000
	pgMaxResponse    = 4 << 20
	pgMaxSQL         = 20000
	pgLongQuery      = 5 * time.Second
)

type pgState struct {
	config  *pgx.ConnConfig // read connections; nil when the DSN is unset or invalid
	write   *pgx.ConnConfig // write-mode connections from the same DSN
	invalid bool
	// writeDisabled is the POSTGRES_WRITE_ENABLED=false kill switch.
	writeDisabled bool
	secrets       []string // DSN and password, scrubbed from every message
	slots         chan struct{}
	mu            sync.Mutex
	dbs           []string
	dbsAt         time.Time
	// superuser is learned on the first successful connection.
	superChecked bool
	superuser    bool
}

type pgError struct {
	status   int
	message  string
	code     string
	pgCode   string
	position int32
}

func (e *pgError) Error() string { return e.message }

// postgresDSN picks POSTGRES_URL, falling back to the older
// POSTGRES_READONLY_URL name.
func postgresDSN(getenv func(string) string) string {
	if dsn := getenv("POSTGRES_URL"); dsn != "" {
		return dsn
	}
	return getenv("POSTGRES_READONLY_URL")
}

// postgresWriteEnabled reads the POSTGRES_WRITE_ENABLED kill switch: unset
// or "true" enables write mode, anything else disables it (fail safe).
func postgresWriteEnabled(value string) bool {
	return value == "" || value == "true"
}

// configurePostgres parses the DSN once at startup. Errors are logged without
// the DSN; pgx parse errors can quote it.
func (s *server) configurePostgres(dsn string) {
	s.pg = &pgState{slots: make(chan struct{}, pgMaxConns)}
	if dsn == "" {
		return
	}
	scheme, _, _ := strings.Cut(dsn, "://")
	config, err := pgx.ParseConfig(dsn)
	if err != nil || (scheme != "postgres" && scheme != "postgresql") {
		s.pg.invalid = true
		log.Print("POSTGRES_URL is invalid; PostgreSQL views are disabled")
		return
	}
	config.ConnectTimeout = 5 * time.Second
	if config.RuntimeParams == nil {
		config.RuntimeParams = map[string]string{}
	}
	config.RuntimeParams["application_name"] = "logs-console"
	config.RuntimeParams["default_transaction_read_only"] = "on"
	config.RuntimeParams["statement_timeout"] = pgStatementLimit
	config.RuntimeParams["idle_in_transaction_session_timeout"] = "15s"
	if config.Database == "" {
		config.Database = "postgres"
	}
	s.pg.config = config
	// Write mode: same server and role, but no read-only session default;
	// every write transaction is still explicitly scoped and time-limited.
	write := config.Copy()
	write.RuntimeParams["application_name"] = "logs-console-write"
	write.RuntimeParams["default_transaction_read_only"] = "off"
	s.pg.write = write
	s.pg.secrets = []string{dsn}
	if config.Password != "" {
		s.pg.secrets = append(s.pg.secrets, config.Password, url.QueryEscape(config.Password), url.PathEscape(config.Password))
	}
}

func (s *server) pgScrub(text string) string {
	for _, secret := range s.pg.secrets {
		if len(secret) < 4 {
			continue
		}
		text = strings.ReplaceAll(text, secret, "[redacted]")
		if quoted, err := json.Marshal(secret); err == nil {
			text = strings.ReplaceAll(text, string(quoted[1:len(quoted)-1]), "[redacted]")
		}
	}
	return text
}

// pgFail turns any error into a readable, scrubbed message.
func (s *server) pgFail(w http.ResponseWriter, err error) {
	var e *pgError
	if !errors.As(err, &e) {
		e = s.pgClassify(err)
	}
	body := map[string]any{"error": s.pgScrub(e.message), "code": e.code}
	if e.pgCode != "" {
		body["pgCode"] = e.pgCode
	}
	if e.position > 0 {
		body["position"] = e.position
	}
	respond(w, e.status, body)
}

func (s *server) pgClassify(err error) *pgError {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		message := pe.Message
		if pe.Detail != "" {
			message += "\n" + pe.Detail
		}
		if pe.Hint != "" {
			message += "\n" + pe.Hint
		}
		e := &pgError{status: 400, message: message, code: "query_error", pgCode: pe.Code, position: pe.Position}
		switch {
		case pe.Code == "25006":
			e.code = "read_only"
		case pe.Code == "57014":
			e.code = "timeout"
		case pe.Code == "53300":
			e.status, e.code = 503, "too_many_connections"
		case pe.Code == "28P01" || pe.Code == "28000":
			e.status, e.code, e.message = 502, "auth_failed", "PostgreSQL kimlik doğrulaması başarısız; POSTGRES_URL değerini kontrol et."
		case pe.Code == "3D000":
			e.status, e.code = 404, "not_found"
		}
		return e
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &pgError{status: 504, message: "PostgreSQL zamanında yanıt vermedi.", code: "timeout"}
	}
	var ce *pgconn.ConnectError
	if errors.As(err, &ce) {
		log.Print("postgres connect failed: ", s.pgScrub(err.Error()))
		return &pgError{status: 502, message: "PostgreSQL'e bağlanılamıyor.", code: "unreachable"}
	}
	log.Print("postgres request failed: ", s.pgScrub(err.Error()))
	return &pgError{status: 502, message: "PostgreSQL isteği tamamlanamadı.", code: "request_failed"}
}

// pgConn opens a dedicated read connection to db.
func (s *server) pgConn(ctx context.Context, db string) (*pgx.Conn, func(), error) {
	return s.pgConnect(ctx, s.pg.config, db)
}

// pgConnect opens a dedicated connection to db with base, bounded by the
// shared slot semaphore (reads and writes together never exceed pgMaxConns).
func (s *server) pgConnect(ctx context.Context, base *pgx.ConnConfig, db string) (*pgx.Conn, func(), error) {
	select {
	case s.pg.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	config := base.Copy()
	config.Database = db
	if notices, ok := ctx.Value(pgNoticesKey{}).(*pgNotices); ok {
		config.OnNotice = func(_ *pgconn.PgConn, notice *pgconn.Notice) { notices.add(notice) }
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		<-s.pg.slots
		return nil, nil, err
	}
	s.pgCheckSuperuser(ctx, conn)
	release := func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = conn.Close(closeCtx)
		cancel()
		<-s.pg.slots
	}
	return conn, release, nil
}

// pgCheckSuperuser records, once, whether the DSN's role is a superuser and
// logs a warning if so. A failed check is retried on the next connection.
func (s *server) pgCheckSuperuser(ctx context.Context, conn *pgx.Conn) {
	s.pg.mu.Lock()
	checked := s.pg.superChecked
	s.pg.mu.Unlock()
	if checked {
		return
	}
	var super bool
	if err := conn.QueryRow(ctx, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&super); err != nil {
		return
	}
	s.pg.mu.Lock()
	first := !s.pg.superChecked
	s.pg.superChecked, s.pg.superuser = true, super
	s.pg.mu.Unlock()
	if first && super {
		log.Print("WARNING: POSTGRES_URL connects as a PostgreSQL superuser; use a dedicated non-superuser role (docs/postgres-inspector.md)")
	}
}

// pgRead runs fn in BEGIN READ ONLY with local timeouts and always rolls back.
func (s *server) pgRead(ctx context.Context, db string, fn func(pgx.Tx) error) error {
	conn, release, err := s.pgConn(ctx, db)
	if err != nil {
		return err
	}
	defer release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = tx.Rollback(rollbackCtx)
		cancel()
	}()
	if _, err := tx.Exec(ctx, `SELECT set_config('statement_timeout', $1, true),
		set_config('lock_timeout', '2s', true),
		set_config('idle_in_transaction_session_timeout', '15s', true)`, pgStatementLimit); err != nil {
		return err
	}
	return fn(tx)
}

// pgDatabases lists connectable, non-template databases; cached briefly.
func (s *server) pgDatabases(ctx context.Context) ([]string, error) {
	s.pg.mu.Lock()
	if time.Since(s.pg.dbsAt) < 30*time.Second && s.pg.dbs != nil {
		dbs := s.pg.dbs
		s.pg.mu.Unlock()
		return dbs, nil
	}
	s.pg.mu.Unlock()
	var dbs []string
	err := s.pgRead(ctx, s.pg.config.Database, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT datname FROM pg_database
			WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname`)
		if err != nil {
			return err
		}
		dbs, err = pgx.CollectRows(rows, pgx.RowTo[string])
		return err
	})
	if err != nil {
		return nil, err
	}
	s.pg.mu.Lock()
	s.pg.dbs, s.pg.dbsAt = dbs, time.Now()
	s.pg.mu.Unlock()
	return dbs, nil
}

// validName limits URL-supplied identifiers before any catalog lookup.
func validName(name string) bool {
	return name != "" && len(name) <= 128 && utf8.ValidString(name) && !strings.ContainsRune(name, 0)
}

// pgPath splits the escaped path into unescaped segments.
func pgPath(escaped, prefix string) ([]string, bool) {
	rest, ok := strings.CutPrefix(escaped, prefix)
	if !ok {
		return nil, false
	}
	if rest == "" {
		return []string{}, true
	}
	parts := strings.Split(rest, "/")
	for i, part := range parts {
		value, err := url.PathUnescape(part)
		if err != nil || !validName(value) {
			return nil, false
		}
		parts[i] = value
	}
	return parts, true
}

// pgPage reports whether the escaped path is a client-side PostgreSQL screen.
func pgPage(escaped string) bool {
	if escaped == "/postgres" {
		return true
	}
	parts, ok := pgPath(escaped, "/postgres/")
	if !ok || len(parts) < 2 || parts[0] != "db" {
		return false
	}
	switch len(parts) {
	case 2:
		return true
	case 3:
		return parts[2] == "query"
	case 5:
		return parts[2] == "table"
	}
	return false
}

func (s *server) pgAPI(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Requested-With") != "logs-ui" || ((r.Method != "GET" || r.Header.Get("Origin") != "") && !s.sameOrigin(r)) {
		fail(w, 403, "Geçersiz istek kaynağı.")
		return
	}
	parts, ok := pgPath(r.URL.EscapedPath(), "/api/pg/")
	if !ok || len(parts) == 0 {
		http.NotFound(w, r)
		return
	}
	route, method := "", "GET"
	switch {
	case len(parts) == 1 && parts[0] == "overview":
		route = "overview"
	case len(parts) == 1 && parts[0] == "status":
		route = "status"
	case len(parts) == 4 && parts[0] == "db" && parts[2] == "write" && (parts[3] == "preview" || parts[3] == "commit"):
		route, method = "write"+parts[3], "POST"
	case len(parts) == 6 && parts[0] == "db" && parts[2] == "table" && parts[5] == "write":
		route, method = "writerow", "POST"
	case len(parts) == 2 && parts[0] == "db":
		route = "db"
	case len(parts) == 3 && parts[0] == "db" && parts[2] == "schema":
		route = "schema"
	case len(parts) == 3 && parts[0] == "db" && parts[2] == "query":
		route, method = "query", "POST"
	case len(parts) == 5 && parts[0] == "db" && parts[2] == "table":
		route = "table"
	case len(parts) == 6 && parts[0] == "db" && parts[2] == "table" && parts[5] == "rows":
		route = "rows"
	default:
		http.NotFound(w, r)
		return
	}
	if r.Method != method {
		fail(w, 405, "Bu yöntem desteklenmiyor.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), pgRequestTimeout)
	defer cancel()
	if route == "status" {
		respond(w, 200, s.pgStatus(ctx))
		return
	}
	if strings.HasPrefix(route, "write") && s.pg.writeDisabled {
		respond(w, 403, map[string]string{"error": "Yazma modu bu sunucuda kapatıldı (POSTGRES_WRITE_ENABLED=false).", "code": "write_disabled"})
		return
	}
	if s.pg.config == nil {
		code, message := "not_configured", "PostgreSQL bu konsol için yapılandırılmamış (POSTGRES_URL yok)."
		if s.pg.invalid {
			code, message = "invalid_config", "POSTGRES_URL geçersiz; postgres:// biçiminde bir DSN olmalı."
		}
		respond(w, 503, map[string]string{"error": message, "code": code})
		return
	}
	var input pgQueryInput
	var writeInput pgWriteInput
	var rowInput pgRowInput
	switch route {
	case "query":
		if !decode(w, r, &input) {
			return
		}
	case "writepreview", "writecommit":
		if !decode(w, r, &writeInput) {
			return
		}
	case "writerow":
		if !decode(w, r, &rowInput) {
			return
		}
	}
	db := ""
	if route != "overview" {
		db = parts[1]
		dbs, err := s.pgDatabases(ctx)
		if err != nil {
			s.pgFail(w, err)
			return
		}
		known := false
		for _, name := range dbs {
			known = known || name == db
		}
		if !known {
			respond(w, 404, map[string]string{"error": "Veritabanı bulunamadı veya bağlanılamıyor.", "code": "not_found"})
			return
		}
	}
	var result any
	var err error
	switch route {
	case "overview":
		result, err = s.pgOverview(ctx)
	case "db":
		result, err = s.pgDatabase(ctx, db)
	case "schema":
		result, err = s.pgSchema(ctx, db)
	case "table":
		result, err = s.pgTable(ctx, db, parts[3], parts[4])
	case "rows":
		limit, ok1 := intParam(r.URL.Query(), "limit", 50, 1, 200)
		offset, ok2 := intParam(r.URL.Query(), "offset", 0, 0, 10_000_000)
		if !ok1 || !ok2 {
			fail(w, 400, "Geçersiz sayfa.")
			return
		}
		result, err = s.pgRows(ctx, db, parts[3], parts[4], limit, offset)
	case "query":
		result, err = s.pgQuery(ctx, db, input)
	case "writepreview", "writecommit":
		result, err = s.pgWriteSQL(ctx, db, writeInput, route == "writecommit", s.pgActor(r))
	case "writerow":
		result, err = s.pgWriteRow(ctx, db, parts[3], parts[4], rowInput, s.pgActor(r))
	}
	if err != nil {
		s.pgFail(w, err)
		return
	}
	data, err := json.Marshal(result)
	if err != nil {
		fail(w, 500, "Yanıt oluşturulamadı.")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write([]byte(s.pgScrub(string(data))))
}

// passwordLiteral matches PASSWORD '...' in statement texts, e.g. CREATE or
// ALTER ROLE kept in pg_stat_statements or pg_stat_activity.
var passwordLiteral = regexp.MustCompile(`(?i)(password\s*)'(?:[^']|'')*'`)

// rowsToMaps collects rows into JSON-friendly maps (catalog queries only).
func rowsToMaps(rows pgx.Rows) ([]map[string]any, error) {
	out := []map[string]any{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := map[string]any{}
		for i, field := range rows.FieldDescriptions() {
			row[field.Name] = pgValue(values[i])
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func queryMaps(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]map[string]any, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return rowsToMaps(rows)
}

func truncate(text string) string {
	if len(text) <= pgMaxCell {
		return text
	}
	cut := pgMaxCell
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "…"
}

// pgValue converts pgx values into JSON-safe, size-limited values.
func pgValue(v any) any {
	switch x := v.(type) {
	case nil, bool, float32, int8, int16, int32, uint8, uint16, uint32:
		return x
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return strconv.FormatFloat(x, 'g', -1, 64)
		}
		return x
	case int64:
		if x > 1<<53 || x < -(1<<53) {
			return strconv.FormatInt(x, 10)
		}
		return x
	case uint64:
		return strconv.FormatUint(x, 10)
	case int:
		return pgValue(int64(x))
	case string:
		return truncate(passwordLiteral.ReplaceAllString(x, "$1'[redacted]'"))
	case time.Time:
		return x.Format(time.RFC3339Nano)
	case []byte:
		if len(x) > pgMaxCell/2 {
			return `\x` + hex.EncodeToString(x[:pgMaxCell/2]) + "…"
		}
		return `\x` + hex.EncodeToString(x)
	case [16]byte:
		h := hex.EncodeToString(x[:])
		return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
	case fmt.Stringer:
		return truncate(x.String())
	case map[string]any, []any:
		data, err := json.Marshal(x)
		if err != nil {
			return truncate(fmt.Sprint(x))
		}
		if len(data) > pgMaxCell {
			return truncate(string(data))
		}
		return json.RawMessage(data)
	}
	if valuer, ok := v.(driver.Valuer); ok {
		if value, err := valuer.Value(); err == nil {
			if _, again := value.(driver.Valuer); !again {
				return pgValue(value)
			}
		}
	}
	data, err := json.Marshal(v)
	if err == nil && len(data) <= pgMaxCell {
		return json.RawMessage(data)
	}
	return truncate(fmt.Sprint(v))
}

func (s *server) pgOverview(ctx context.Context) (any, error) {
	out := map[string]any{}
	err := s.pgRead(ctx, s.pg.config.Database, func(tx pgx.Tx) error {
		server, err := queryMaps(ctx, tx, `SELECT current_setting('server_version') AS version, version() AS "fullVersion",
			pg_postmaster_start_time() AS "startedAt", extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS "uptimeSeconds",
			current_setting('max_connections')::int AS "maxConnections", current_user AS "user", current_database() AS database,
			(SELECT count(*) FROM pg_locks WHERE NOT granted) AS "waitingLocks"`)
		if err != nil {
			return err
		}
		out["server"] = server[0]
		if out["connections"], err = queryMaps(ctx, tx, `SELECT coalesce(state, 'unknown') AS state, count(*) AS count
			FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC`); err != nil {
			return err
		}
		totals, err := queryMaps(ctx, tx, `SELECT sum(xact_commit) AS commits, sum(xact_rollback) AS rollbacks, sum(deadlocks) AS deadlocks,
			CASE WHEN sum(blks_hit) + sum(blks_read) > 0 THEN sum(blks_hit)::float8 / (sum(blks_hit) + sum(blks_read)) END AS "cacheHitRatio"
			FROM pg_stat_database WHERE datname IS NOT NULL`)
		if err != nil {
			return err
		}
		out["totals"] = totals[0]
		if out["databases"], err = queryMaps(ctx, tx, `SELECT d.datname AS name, pg_database_size(d.datname) AS size,
			coalesce(s.numbackends, 0) AS connections, s.xact_commit AS commits, s.xact_rollback AS rollbacks, s.deadlocks,
			CASE WHEN s.blks_hit + s.blks_read > 0 THEN s.blks_hit::float8 / (s.blks_hit + s.blks_read) END AS "cacheHitRatio"
			FROM pg_database d LEFT JOIN pg_stat_database s ON s.datid = d.oid
			WHERE NOT d.datistemplate AND d.datallowconn AND has_database_privilege(d.datname, 'CONNECT')
			ORDER BY pg_database_size(d.datname) DESC`); err != nil {
			return err
		}
		out["longRunning"], err = queryMaps(ctx, tx, `SELECT pid, datname AS database, usename AS "user", application_name AS application,
			client_addr::text AS client, state, wait_event_type AS "waitEventType", wait_event AS "waitEvent",
			extract(epoch FROM now() - query_start)::float8 AS seconds, left(query, 1000) AS query
			FROM pg_stat_activity
			WHERE state IS DISTINCT FROM 'idle' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
			AND query_start < now() - $1::interval
			ORDER BY query_start LIMIT 50`, fmt.Sprintf("%d seconds", int(pgLongQuery.Seconds())))
		return err
	})
	return out, err
}

func (s *server) pgDatabase(ctx context.Context, db string) (any, error) {
	out := map[string]any{"database": db}
	err := s.pgRead(ctx, db, func(tx pgx.Tx) error {
		var err error
		if out["size"], err = scalar(ctx, tx, `SELECT pg_database_size(current_database())`); err != nil {
			return err
		}
		if out["schemas"], err = queryMaps(ctx, tx, `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
			(SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p')) AS tables
			FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1`); err != nil {
			return err
		}
		if out["tables"], err = queryMaps(ctx, tx, `SELECT n.nspname AS schema, c.relname AS name,
			CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' END AS kind,
			greatest(c.reltuples, -1)::bigint AS "estimatedRows", pg_total_relation_size(c.oid) AS "totalSize",
			pg_table_size(c.oid) AS "tableSize", pg_indexes_size(c.oid) AS "indexSize",
			s.seq_scan AS "seqScans", s.idx_scan AS "idxScans", s.n_live_tup AS "liveRows", s.n_dead_tup AS "deadRows",
			greatest(s.last_vacuum, s.last_autovacuum) AS "lastVacuum", greatest(s.last_analyze, s.last_autoanalyze) AS "lastAnalyze",
			has_table_privilege(c.oid, 'SELECT') AS readable
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
			WHERE c.relkind IN ('r', 'p', 'm', 'f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
			ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 2000`); err != nil {
			return err
		}
		if out["views"], err = queryMaps(ctx, tx, `SELECT n.nspname AS schema, c.relname AS name
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relkind = 'v' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1, 2 LIMIT 2000`); err != nil {
			return err
		}
		extensions, err := queryMaps(ctx, tx, `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
			FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1`)
		if err != nil {
			return err
		}
		out["extensions"] = extensions
		out["statements"] = nil
		for _, ext := range extensions {
			if ext["name"] != "pg_stat_statements" {
				continue
			}
			schema, _ := ext["schema"].(string)
			// Savepoint: a missing view or privilege must not fail the whole page.
			if _, err := tx.Exec(ctx, "SAVEPOINT statements"); err != nil {
				return err
			}
			rows, err := queryMaps(ctx, tx, `SELECT left(query, 500) AS query, calls, total_exec_time AS "totalMs",
				mean_exec_time AS "meanMs", rows FROM `+pgx.Identifier{schema, "pg_stat_statements"}.Sanitize()+`
				WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
				ORDER BY total_exec_time DESC LIMIT 20`)
			if err != nil {
				if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT statements"); err != nil {
					return err
				}
				out["statementsError"] = s.pgClassify(err).message
			} else {
				out["statements"] = rows
			}
		}
		return nil
	})
	return out, err
}

const pgSchemaTables = 2000

type pgSchemaColumn struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	PK       bool   `json:"pk"`
}

// pgSchema lists relations and their columns for the editor's completion
// and object explorer: {"schemas": {schema: {table: [{name, type, nullable,
// pk}]}}, "kinds": {schema: {table: "table"|"view"|…}}, "truncated": bool}.
func (s *server) pgSchema(ctx context.Context, db string) (any, error) {
	schemas := map[string]map[string][]pgSchemaColumn{}
	kinds := map[string]map[string]string{}
	tables := 0
	err := s.pgRead(ctx, db, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `WITH t AS (
			SELECT c.oid, n.nspname, c.relname,
			CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' ELSE 'table' END AS kind
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
			ORDER BY n.nspname, c.relname LIMIT $1)
			SELECT t.nspname, t.relname, t.kind, a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
			EXISTS (SELECT 1 FROM pg_index x WHERE x.indrelid = t.oid AND x.indisprimary AND a.attnum = ANY (x.indkey))
			FROM t LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
			ORDER BY t.nspname, t.relname, a.attnum`, pgSchemaTables+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var schema, table, kind string
			var column, typ *string
			var nullable, pk *bool
			if err := rows.Scan(&schema, &table, &kind, &column, &typ, &nullable, &pk); err != nil {
				return err
			}
			if schemas[schema] == nil {
				schemas[schema] = map[string][]pgSchemaColumn{}
				kinds[schema] = map[string]string{}
			}
			columns, seen := schemas[schema][table]
			if !seen {
				if tables++; tables > pgSchemaTables {
					continue
				}
				columns = []pgSchemaColumn{}
				kinds[schema][table] = kind
			}
			if column != nil && typ != nil {
				columns = append(columns, pgSchemaColumn{Name: *column, Type: *typ, Nullable: nullable != nil && *nullable, PK: pk != nil && *pk})
			}
			schemas[schema][table] = columns
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	for name, tables := range schemas {
		if len(tables) == 0 {
			delete(schemas, name)
			delete(kinds, name)
		}
	}
	return map[string]any{"schemas": schemas, "kinds": kinds, "truncated": tables > pgSchemaTables}, nil
}

func scalar(ctx context.Context, tx pgx.Tx, sql string, args ...any) (any, error) {
	var value any
	err := tx.QueryRow(ctx, sql, args...).Scan(&value)
	return pgValue(value), err
}

// pgRelation resolves schema.table through the catalog; user input is only
// ever a query parameter here, never interpolated.
func pgRelation(ctx context.Context, tx pgx.Tx, schema, table string) (uint32, string, error) {
	var oid uint32
	var kind string
	err := tx.QueryRow(ctx, `SELECT c.oid, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`, schema, table).Scan(&oid, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", &pgError{status: 404, message: "Tablo bulunamadı.", code: "not_found"}
	}
	return oid, kind, err
}

func (s *server) pgTable(ctx context.Context, db, schema, table string) (any, error) {
	out := map[string]any{"database": db, "schema": schema, "name": table}
	err := s.pgRead(ctx, db, func(tx pgx.Tx) error {
		oid, kind, err := pgRelation(ctx, tx, schema, table)
		if err != nil {
			return err
		}
		out["kind"] = kind
		info, err := queryMaps(ctx, tx, `SELECT greatest(c.reltuples, -1)::bigint AS "estimatedRows",
			pg_total_relation_size(c.oid) AS "totalSize", pg_table_size(c.oid) AS "tableSize", pg_indexes_size(c.oid) AS "indexSize",
			obj_description(c.oid, 'pg_class') AS comment, has_table_privilege(c.oid, 'SELECT') AS readable,
			pg_get_userbyid(c.relowner) AS owner
			FROM pg_class c WHERE c.oid = $1`, oid)
		if err != nil {
			return err
		}
		out["info"] = info[0]
		if out["columns"], err = queryMaps(ctx, tx, `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
			NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default", col_description(a.attrelid, a.attnum) AS comment
			FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, oid); err != nil {
			return err
		}
		if out["constraints"], err = queryMaps(ctx, tx, `SELECT conname AS name,
			CASE contype WHEN 'p' THEN 'primary key' WHEN 'f' THEN 'foreign key' WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check'
			WHEN 'x' THEN 'exclusion' WHEN 'n' THEN 'not null' ELSE contype::text END AS type,
			pg_get_constraintdef(oid) AS definition
			FROM pg_constraint WHERE conrelid = $1 ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'f' THEN 1 WHEN 'u' THEN 2 ELSE 3 END, conname`, oid); err != nil {
			return err
		}
		if out["indexes"], err = queryMaps(ctx, tx, `SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition,
			pg_relation_size(x.indexrelid) AS size, coalesce(s.idx_scan, 0) AS scans, x.indisunique AS unique, x.indisprimary AS primary,
			(coalesce(s.idx_scan, 0) = 0 AND NOT x.indisunique AND NOT x.indisprimary) AS unused
			FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
			LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = x.indexrelid
			WHERE x.indrelid = $1 ORDER BY x.indisprimary DESC, i.relname`, oid); err != nil {
			return err
		}
		out["triggers"], err = queryMaps(ctx, tx, `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition,
			tgenabled <> 'D' AS enabled FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal ORDER BY tgname`, oid)
		return err
	})
	return out, err
}

// pgRows browses a table with LIMIT/OFFSET, ordered by the primary key when
// present. Identifiers come from the catalog and are quoted by pgx.
func (s *server) pgRows(ctx context.Context, db, schema, table string, limit, offset int) (any, error) {
	var out *pgResult
	err := s.pgRead(ctx, db, func(tx pgx.Tx) error {
		oid, _, err := pgRelation(ctx, tx, schema, table)
		if err != nil {
			return err
		}
		keys, err := tx.Query(ctx, `SELECT a.attname FROM pg_index x
			JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
			WHERE x.indrelid = $1 AND x.indisprimary ORDER BY array_position(x.indkey::int2[], a.attnum)`, oid)
		if err != nil {
			return err
		}
		pk, err := pgx.CollectRows(keys, pgx.RowTo[string])
		if err != nil {
			return err
		}
		sql := "SELECT * FROM " + pgx.Identifier{schema, table}.Sanitize()
		if len(pk) > 0 {
			quoted := make([]string, len(pk))
			for i, column := range pk {
				quoted[i] = pgx.Identifier{column}.Sanitize()
			}
			sql += " ORDER BY " + strings.Join(quoted, ", ")
		}
		sql += " LIMIT $1 OFFSET $2"
		started := time.Now()
		rows, err := tx.Query(ctx, sql, limit, offset)
		if err != nil {
			return err
		}
		out, err = collectResult(rows, tx.Conn().TypeMap(), started, nil)
		if out != nil {
			out.OrderBy = pk
		}
		return err
	})
	return out, err
}

type pgQueryInput struct {
	SQL     string `json:"sql"`
	Explain bool   `json:"explain"`
}

type pgColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type pgResult struct {
	Columns    []pgColumn       `json:"columns"`
	Rows       []map[string]any `json:"rows"`
	Truncated  bool             `json:"truncated"`
	DurationMs float64          `json:"durationMs"`
	Command    string           `json:"command,omitempty"`
	OrderBy    []string         `json:"orderBy,omitempty"`
	Notices    []string         `json:"notices,omitempty"`
}

// pgNotices collects server notices (RAISE NOTICE, warnings) for one
// request; attached through the context so each connection reports to it.
type pgNotices struct {
	mu   sync.Mutex
	list []string
}

type pgNoticesKey struct{}

func withNotices(ctx context.Context) (context.Context, *pgNotices) {
	n := &pgNotices{}
	return context.WithValue(ctx, pgNoticesKey{}, n), n
}

func (n *pgNotices) add(notice *pgconn.Notice) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if len(n.list) < 50 {
		n.list = append(n.list, notice.Severity+": "+truncate(notice.Message))
	}
}

func (n *pgNotices) all() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.list...)
}

// collectResult caps rows, cells and total size. stop aborts an unfinished
// statement once the cap is hit.
func collectResult(rows pgx.Rows, types *pgtype.Map, started time.Time, stop func()) (*pgResult, error) {
	defer rows.Close()
	fields := rows.FieldDescriptions()
	result := &pgResult{Columns: make([]pgColumn, len(fields)), Rows: []map[string]any{}}
	names := make([]string, len(fields))
	seen := map[string]int{}
	for i, field := range fields {
		name := field.Name
		if seen[name]++; seen[name] > 1 {
			name = fmt.Sprintf("%s (%d)", name, seen[name])
		}
		names[i] = name
		typ := strconv.FormatUint(uint64(field.DataTypeOID), 10)
		if t, ok := types.TypeForOID(field.DataTypeOID); ok {
			typ = t.Name
		}
		result.Columns[i] = pgColumn{Name: name, Type: typ}
	}
	size := 0
	for rows.Next() {
		if len(result.Rows) >= pgMaxRows || size >= pgMaxResponse {
			result.Truncated = true
			if stop != nil {
				stop()
			}
			break
		}
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := make(map[string]any, len(values))
		for i, value := range values {
			converted := pgValue(value)
			row[names[i]] = converted
			if text, ok := converted.(string); ok {
				size += len(text)
			} else if raw, ok := converted.(json.RawMessage); ok {
				size += len(raw)
			} else {
				size += 8
			}
		}
		result.Rows = append(result.Rows, row)
	}
	if stop == nil {
		// Writes must finish: drain the rest instead of cancelling, so the
		// command tag (rows affected) is complete.
		rows.Close()
	}
	if err := rows.Err(); err != nil && !result.Truncated {
		return nil, err
	}
	result.DurationMs = math.Round(float64(time.Since(started).Microseconds())) / 1000
	result.Command = rows.CommandTag().String()
	return result, nil
}

// pgQuery runs one user statement in the read-only transaction. The extended
// protocol (DescribeExec) refuses multiple statements; the connection is
// closed afterwards, so nothing the statement changes in the session survives.
func (s *server) pgQuery(ctx context.Context, db string, input pgQueryInput) (any, error) {
	sql, err := cleanSQL(input.SQL)
	if err != nil {
		return nil, err
	}
	if reason := analyzeSQL(sql).blocked; reason != "" {
		return nil, blockedError(reason)
	}
	if input.Explain {
		sql = "EXPLAIN " + sql
	}
	ctx, notices := withNotices(ctx)
	var out *pgResult
	err = s.pgRead(ctx, db, func(tx pgx.Tx) error {
		queryCtx, stop := context.WithCancel(ctx)
		defer stop()
		started := time.Now()
		rows, err := tx.Query(queryCtx, sql, pgx.QueryExecModeDescribeExec)
		if err != nil {
			return err
		}
		out, err = collectResult(rows, tx.Conn().TypeMap(), started, stop)
		return err
	})
	if out != nil && err != nil && out.Truncated {
		err = nil // The aborted remainder of a capped result is expected.
	}
	if err != nil {
		shift := 0
		if input.Explain {
			shift = -len("EXPLAIN ")
		}
		return nil, s.pgPositioned(err, input.SQL, shift)
	}
	out.Notices = notices.all()
	return out, nil
}

// cleanSQL trims whitespace and one trailing semicolon and checks the size.
func cleanSQL(text string) (string, error) {
	sql := strings.TrimSpace(text)
	sql = strings.TrimSpace(strings.TrimSuffix(sql, ";"))
	if sql == "" || len(sql) > pgMaxSQL || !utf8.ValidString(sql) {
		return "", &pgError{status: 400, message: "Sorgu boş veya çok uzun.", code: "invalid_sql"}
	}
	return sql, nil
}

// pgPositioned maps an error position back onto the text the user typed.
func (s *server) pgPositioned(err error, typed string, shift int) error {
	shift += utf8.RuneCountInString(typed) - utf8.RuneCountInString(strings.TrimLeftFunc(typed, unicode.IsSpace))
	if e := s.pgClassify(err); e.position > 0 {
		if e.position += int32(shift); e.position < 1 {
			e.position = 0
		}
		return e
	}
	return err
}

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Opt-in write mode. Same DSN as the read views (POSTGRES_URL), but its own
// connection config without the read-only session default. Every write:
//   - goes to the database named in the URL, validated against pg_database;
//   - runs in an explicit READ WRITE transaction with local statement, lock
//     and idle timeouts, on a fresh connection closed afterwards;
//   - is a single statement (extended protocol), never transaction control,
//     COPY or a server-file/program function;
//   - is previewed first: executed, measured, then rolled back. Commit
//     re-executes and needs confirm=true, the expected row count, and for
//     DDL or UPDATE/DELETE without WHERE the database name typed back;
//   - is logged once committed (actor, database, redacted statement, rows).
// Row edits identify a row by its full primary key, use only parameters and
// catalog-checked, pgx-quoted identifiers, and must touch exactly one row.

const pgLockLimit = "3s"

type pgWriteInput struct {
	SQL             string `json:"sql"`
	Confirm         bool   `json:"confirm"`
	ConfirmDatabase string `json:"confirmDatabase"`
	ExpectedRows    *int64 `json:"expectedRows"`
}

type pgWriteResult struct {
	pgResult
	RowsAffected int64    `json:"rowsAffected"`
	DDL          bool     `json:"ddl"`
	Dangerous    bool     `json:"dangerous"`
	Reasons      []string `json:"reasons"`
	Committed    bool     `json:"committed"`
}

type pgRowInput struct {
	Op      string                     `json:"op"`
	Key     map[string]json.RawMessage `json:"key"`
	Values  map[string]json.RawMessage `json:"values"`
	Confirm bool                       `json:"confirm"`
}

type pgRowResult struct {
	Command      string         `json:"command"`
	RowsAffected int64          `json:"rowsAffected"`
	Row          map[string]any `json:"row"`
}

// pgActor names the console user and session for the audit log without
// revealing the session token (a prefix of its SHA-256, as kept in memory).
func (s *server) pgActor(r *http.Request) string {
	session := "-"
	if c, err := r.Cookie(s.cookieName()); err == nil {
		sum := sha256.Sum256([]byte(c.Value))
		session = hex.EncodeToString(sum[:])[:12]
	}
	return fmt.Sprintf("user=%q session=%s", s.username, session)
}

// pgStatus tells the UI whether PostgreSQL (and so write mode) is configured
// and whether the role is a superuser. Never fails.
func (s *server) pgStatus(ctx context.Context) map[string]any {
	out := map[string]any{"configured": s.pg.config != nil, "invalid": s.pg.invalid, "superuser": nil, "writeEnabled": !s.pg.writeDisabled}
	if s.pg.config == nil {
		return out
	}
	s.pg.mu.Lock()
	checked := s.pg.superChecked
	s.pg.mu.Unlock()
	if !checked {
		checkCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		_ = s.pgRead(checkCtx, s.pg.config.Database, func(pgx.Tx) error { return nil })
		cancel()
	}
	s.pg.mu.Lock()
	if s.pg.superChecked {
		out["superuser"] = s.pg.superuser
	}
	s.pg.mu.Unlock()
	return out
}

// pgWriteTx runs fn in a READ WRITE transaction on db and commits only when
// commit is true and fn succeeded; otherwise it rolls back.
func (s *server) pgWriteTx(ctx context.Context, db string, commit bool, fn func(pgx.Tx) error) error {
	conn, release, err := s.pgConnect(ctx, s.pg.write, db)
	if err != nil {
		return err
	}
	defer release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadWrite})
	if err != nil {
		return err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = tx.Rollback(rollbackCtx) // No-op after a successful commit.
		cancel()
	}()
	if _, err := tx.Exec(ctx, `SELECT set_config('statement_timeout', $1, true),
		set_config('lock_timeout', $2, true),
		set_config('idle_in_transaction_session_timeout', '15s', true)`, pgStatementLimit, pgLockLimit); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	if !commit {
		return nil
	}
	return tx.Commit(ctx)
}

// dmlTag reports whether a command tag is plain data manipulation.
func dmlTag(tag pgconn.CommandTag) bool {
	verb, _, _ := strings.Cut(tag.String(), " ")
	switch verb {
	case "INSERT", "UPDATE", "DELETE", "MERGE", "SELECT":
		return true
	}
	return false
}

func (s *server) auditSQL(sql string) string {
	return truncate(s.pgScrub(passwordLiteral.ReplaceAllString(sql, "$1'[redacted]'")))
}

// pgWriteSQL previews (commit=false) or commits one statement from the
// SQL editor.
func (s *server) pgWriteSQL(ctx context.Context, db string, input pgWriteInput, commit bool, actor string) (any, error) {
	sql, err := cleanSQL(input.SQL)
	if err != nil {
		return nil, err
	}
	info := analyzeSQL(sql)
	if info.blocked != "" {
		return nil, blockedError(info.blocked)
	}
	if info.transactionControl() {
		return nil, &pgError{status: 400, code: "transaction_control",
			message: "İşlem kontrol ifadeleri (BEGIN, COMMIT, ROLLBACK, SAVEPOINT…) kullanılamaz; konsol işlemi kendisi yönetir."}
	}
	if commit && !input.Confirm {
		return nil, &pgError{status: 400, code: "confirmation_required", message: "Yazmak için açık onay (confirm) gerekli."}
	}
	ctx, notices := withNotices(ctx)
	out := &pgWriteResult{Reasons: []string{}}
	err = s.pgWriteTx(ctx, db, commit, func(tx pgx.Tx) error {
		started := time.Now()
		rows, err := tx.Query(ctx, sql, pgx.QueryExecModeDescribeExec)
		if err != nil {
			return err
		}
		result, err := collectResult(rows, tx.Conn().TypeMap(), started, nil)
		if err != nil {
			return err
		}
		tag := rows.CommandTag()
		out.pgResult = *result
		out.RowsAffected = tag.RowsAffected()
		dmlStart := statementVerbs[info.first] || info.first == "with"
		out.DDL = !dmlStart || info.selectInto || !dmlTag(tag)
		if out.DDL {
			out.Reasons = append(out.Reasons, "ddl")
		}
		if (info.verb == "update" || info.verb == "delete") && !info.topWhere {
			out.Reasons = append(out.Reasons, "no_where")
		}
		out.Dangerous = len(out.Reasons) > 0
		if !commit {
			return nil
		}
		if out.Dangerous && input.ConfirmDatabase != db {
			return &pgError{status: 400, code: "database_confirmation_required",
				message: "Bu ifade için veritabanı adını yazarak onaylaman gerekiyor. Hiçbir şey değişmedi."}
		}
		if input.ExpectedRows != nil && *input.ExpectedRows != out.RowsAffected {
			return &pgError{status: 409, code: "rows_changed",
				message: fmt.Sprintf("Önizlemede %d satır vardı, şimdi %d. Hiçbir şey değişmedi; tekrar önizle.", *input.ExpectedRows, out.RowsAffected)}
		}
		return nil
	})
	if err != nil {
		return nil, s.pgPositioned(err, input.SQL, 0)
	}
	out.Committed = commit
	out.Notices = notices.all()
	if commit {
		log.Printf("postgres write committed %s db=%q command=%q rows=%d statement=%q",
			actor, db, out.Command, out.RowsAffected, s.auditSQL(sql))
	}
	return out, nil
}

// jsonText turns a JSON value from the client into PostgreSQL input text.
// Objects and arrays stay JSON (json/jsonb columns).
func jsonText(raw json.RawMessage) (text string, null bool, ok bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "", false, false
	}
	switch raw[0] {
	case 'n':
		return "", true, string(raw) == "null"
	case '"':
		if err := json.Unmarshal(raw, &text); err != nil || strings.ContainsRune(text, 0) {
			return "", false, false
		}
		return text, false, true
	case 't', 'f':
		return string(raw), false, string(raw) == "true" || string(raw) == "false"
	case '{', '[':
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw); err != nil {
			return "", false, false
		}
		return compact.String(), false, true
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return "", false, false
	}
	return number.String(), false, true
}

type pgColumnInfo struct {
	name, typ string
	generated bool
}

// pgTableColumns returns the relation's live columns (catalog order) and
// its primary key, or an error for anything but a plain/partitioned table.
func pgTableColumns(ctx context.Context, tx pgx.Tx, schema, table string) ([]pgColumnInfo, []string, error) {
	oid, kind, err := pgRelation(ctx, tx, schema, table)
	if err != nil {
		return nil, nil, err
	}
	if kind != "r" && kind != "p" {
		return nil, nil, &pgError{status: 400, code: "not_a_table", message: "Satır düzenleme yalnız tablolarda yapılabilir."}
	}
	rows, err := tx.Query(ctx, `SELECT a.attname, format_type(a.atttypid, NULL), a.attgenerated <> ''
		FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, oid)
	if err != nil {
		return nil, nil, err
	}
	var columns []pgColumnInfo
	for rows.Next() {
		var c pgColumnInfo
		if err := rows.Scan(&c.name, &c.typ, &c.generated); err != nil {
			rows.Close()
			return nil, nil, err
		}
		columns = append(columns, c)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	keys, err := tx.Query(ctx, `SELECT a.attname FROM pg_index x
		JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
		WHERE x.indrelid = $1 AND x.indisprimary ORDER BY array_position(x.indkey::int2[], a.attnum)`, oid)
	if err != nil {
		return nil, nil, err
	}
	pk, err := pgx.CollectRows(keys, pgx.RowTo[string])
	if err != nil {
		return nil, nil, err
	}
	if len(pk) == 0 {
		return nil, nil, &pgError{status: 400, code: "no_primary_key",
			message: "Bu tablonun birincil anahtarı yok; satırlar güvenle tek tek seçilemediği için düzenlenemez."}
	}
	return columns, pk, nil
}

var errInvalidRow = &pgError{status: 400, code: "invalid_row", message: "Geçersiz satır isteği."}

// buildRowSQL validates a row operation against the catalog and returns
// parameterized SQL. Identifiers are pgx-quoted catalog names; values are
// parameters cast from text to the column's catalog type.
func buildRowSQL(schema, table string, columns []pgColumnInfo, pk []string, input pgRowInput) (string, []any, error) {
	known := map[string]pgColumnInfo{}
	for _, c := range columns {
		known[c.name] = c
	}
	for name := range input.Values {
		c, ok := known[name]
		if !validName(name) || !ok {
			return "", nil, &pgError{status: 400, code: "invalid_row", message: "Bilinmeyen kolon: " + name}
		}
		if c.generated {
			return "", nil, &pgError{status: 400, code: "invalid_row", message: "Üretilen kolon değiştirilemez: " + name}
		}
	}
	var args []any
	value := func(c pgColumnInfo, raw json.RawMessage) (string, error) {
		text, null, ok := jsonText(raw)
		if !ok {
			return "", &pgError{status: 400, code: "invalid_row", message: "Geçersiz değer: " + c.name}
		}
		if null {
			return "NULL", nil
		}
		args = append(args, text)
		return fmt.Sprintf("CAST($%d::text AS %s)", len(args), c.typ), nil
	}
	where := func() (string, error) {
		if len(input.Key) != len(pk) {
			return "", &pgError{status: 400, code: "invalid_row", message: "Satır, birincil anahtarın tüm kolonlarıyla belirtilmeli."}
		}
		parts := make([]string, len(pk))
		for i, name := range pk {
			raw, ok := input.Key[name]
			if !ok {
				return "", &pgError{status: 400, code: "invalid_row", message: "Birincil anahtar kolonu eksik: " + name}
			}
			trimmed := bytes.TrimSpace(raw)
			if _, null, ok := jsonText(raw); !ok || null || trimmed[0] == '{' || trimmed[0] == '[' {
				return "", &pgError{status: 400, code: "invalid_row", message: "Birincil anahtar değeri geçersiz: " + name}
			}
			expr, err := value(known[name], raw)
			if err != nil {
				return "", err
			}
			parts[i] = pgx.Identifier{name}.Sanitize() + " = " + expr
		}
		return " WHERE " + strings.Join(parts, " AND "), nil
	}
	target := pgx.Identifier{schema, table}.Sanitize()
	switch input.Op {
	case "insert":
		if len(input.Key) > 0 {
			return "", nil, errInvalidRow
		}
		var names, exprs []string
		for _, c := range columns {
			raw, ok := input.Values[c.name]
			if !ok {
				continue
			}
			expr, err := value(c, raw)
			if err != nil {
				return "", nil, err
			}
			names = append(names, pgx.Identifier{c.name}.Sanitize())
			exprs = append(exprs, expr)
		}
		if len(names) == 0 {
			return "INSERT INTO " + target + " DEFAULT VALUES RETURNING *", args, nil
		}
		return "INSERT INTO " + target + " (" + strings.Join(names, ", ") + ") VALUES (" + strings.Join(exprs, ", ") + ") RETURNING *", args, nil
	case "update":
		if len(input.Values) == 0 {
			return "", nil, &pgError{status: 400, code: "invalid_row", message: "Değiştirilecek kolon yok."}
		}
		var sets []string
		for _, c := range columns {
			raw, ok := input.Values[c.name]
			if !ok {
				continue
			}
			expr, err := value(c, raw)
			if err != nil {
				return "", nil, err
			}
			sets = append(sets, pgx.Identifier{c.name}.Sanitize()+" = "+expr)
		}
		clause, err := where()
		if err != nil {
			return "", nil, err
		}
		return "UPDATE " + target + " SET " + strings.Join(sets, ", ") + clause + " RETURNING *", args, nil
	case "delete":
		if len(input.Values) > 0 {
			return "", nil, errInvalidRow
		}
		clause, err := where()
		if err != nil {
			return "", nil, err
		}
		return "DELETE FROM " + target + clause + " RETURNING *", args, nil
	}
	return "", nil, &pgError{status: 400, code: "invalid_row", message: "İşlem insert, update veya delete olmalı."}
}

// pgWriteRow inserts, updates or deletes exactly one row and commits.
func (s *server) pgWriteRow(ctx context.Context, db, schema, table string, input pgRowInput, actor string) (any, error) {
	if !input.Confirm {
		return nil, &pgError{status: 400, code: "confirmation_required", message: "Yazmak için açık onay (confirm) gerekli."}
	}
	if input.Op != "insert" && input.Op != "update" && input.Op != "delete" {
		return nil, errInvalidRow
	}
	if len(input.Key) > 32 || len(input.Values) > 1600 {
		return nil, errInvalidRow
	}
	var out pgRowResult
	var sql string
	err := s.pgWriteTx(ctx, db, true, func(tx pgx.Tx) error {
		columns, pk, err := pgTableColumns(ctx, tx, schema, table)
		if err != nil {
			return err
		}
		var args []any
		if sql, args, err = buildRowSQL(schema, table, columns, pk, input); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return err
		}
		result, err := collectResult(rows, tx.Conn().TypeMap(), time.Now(), nil)
		if err != nil {
			return err
		}
		out.Command = result.Command
		out.RowsAffected = rows.CommandTag().RowsAffected()
		if out.RowsAffected != 1 {
			return &pgError{status: 409, code: "row_count",
				message: fmt.Sprintf("%d satır etkilenecekti; tam 1 bekleniyordu. Hiçbir şey değişmedi.", out.RowsAffected)}
		}
		if len(result.Rows) > 0 {
			out.Row = result.Rows[0]
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	key, _ := json.Marshal(input.Key)
	log.Printf("postgres write committed %s db=%q table=%q op=%s rows=%d statement=%q key=%s",
		actor, db, schema+"."+table, input.Op, out.RowsAffected, s.auditSQL(sql), s.auditSQL(string(key)))
	return out, nil
}

package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPostgresNotConfiguredAndInvalid(t *testing.T) {
	s := testServer(t, "http://localhost:9428", false)
	for _, path := range []string{"/api/pg/overview", "/api/pg/db/app", "/postgres"} {
		w := request(s, "GET", path, "", nil)
		if (path == "/postgres" && w.Code != 303) || (path != "/postgres" && w.Code != 401) {
			t.Fatalf("%s anonymous: %d", path, w.Code)
		}
	}
	c := signIn(t, s)
	w := request(s, "GET", "/api/pg/overview", "", c)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "not_configured") {
		t.Fatalf("not configured: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/api/session", "", c); w.Code != 200 {
		t.Fatalf("logs UI broke: %d", w.Code)
	}
	secret := "postgres://ro:hunter2-secret@db:5432/app?sslmode=bogus"
	s.configurePostgres(secret)
	w = request(s, "GET", "/api/pg/overview", "", c)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "invalid_config") || strings.Contains(w.Body.String(), "hunter2") {
		t.Fatalf("invalid: %d %s", w.Code, w.Body)
	}
	s.configurePostgres("mysql://ro:pw@db/app")
	if s.pg.config != nil || !s.pg.invalid {
		t.Fatal("non-postgres scheme accepted")
	}
}

func TestPostgresRoutingAndOrigin(t *testing.T) {
	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres("postgres://ro:hunter2-secret@127.0.0.1:1/app?connect_timeout=1")
	c := signIn(t, s)
	for path, want := range map[string]int{
		"/api/pg/":                               404,
		"/api/pg/nothing":                        404,
		"/api/pg/db":                             404,
		"/api/pg/db/app/tables":                  404,
		"/api/pg/db/app/table/public":            404,
		"/api/pg/db/app/table/a/b/c":             404,
		"/api/pg/db/app/query":                   405, // GET on a POST route
		"/api/pg/db/" + strings.Repeat("a", 129): 404,
	} {
		if w := request(s, "GET", path, "", c); w.Code != want {
			t.Fatalf("%s: want %d got %d %s", path, want, w.Code, w.Body)
		}
	}
	r := httptest.NewRequest("POST", "http://logs.example.test/api/pg/db/app/query", strings.NewReader(`{"sql":"select 1"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Requested-With", "logs-ui")
	r.Header.Set("Origin", "https://evil.example")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-origin query: %d", w.Code)
	}
	// Unreachable server: readable error, no DSN or password.
	w = request(s, "GET", "/api/pg/overview", "", c)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "unreachable") || strings.Contains(w.Body.String(), "hunter2") || strings.Contains(w.Body.String(), "127.0.0.1") {
		t.Fatalf("unreachable: %d %s", w.Code, w.Body)
	}
}

func TestPostgresPagesAndPaths(t *testing.T) {
	for path, want := range map[string]bool{
		"/postgres": true, "/postgres/db/app": true, "/postgres/db/my%20db": true, "/postgres/db/app/query": true,
		"/postgres/db/app/table/public/users": true, "/postgres/db/app/table/Sales%20Data/We%22ird": true,
		"/postgres/": false, "/postgres/db": false, "/postgres/db/app/other": false, "/postgres/db/app/table/public": false,
		"/postgres/db/%ZZ": false, "/postgres/db/a%00b": false, "/postgres/x/app": false,
	} {
		if pgPage(path) != want {
			t.Fatalf("%s: want %v", path, want)
		}
	}
	parts, ok := pgPath("/api/pg/db/a%2Fb/table/s/t", "/api/pg/")
	if !ok || len(parts) != 5 || parts[1] != "a/b" {
		t.Fatalf("escaped segment: %v %v", parts, ok)
	}
}

func TestPostgresIdentifierQuoting(t *testing.T) {
	got := pgx.Identifier{`Sales "Data"`, `x"; DROP TABLE users; --`}.Sanitize()
	want := `"Sales ""Data"""."x""; DROP TABLE users; --"`
	if got != want {
		t.Fatalf("quoting: %s", got)
	}
}

func TestPostgresScrubAndValues(t *testing.T) {
	s := testServer(t, "http://localhost:9428", false)
	dsn := "postgres://ro:p%40ss-word-123@db:5432/app"
	s.configurePostgres(dsn)
	if s.pg.config == nil {
		t.Fatal("valid DSN rejected")
	}
	if s.pg.config.RuntimeParams["default_transaction_read_only"] != "on" || s.pg.config.ConnectTimeout != 5*time.Second {
		t.Fatal("read-only session defaults missing")
	}
	text := s.pgScrub("failed " + dsn + " with p@ss-word-123 and p%40ss-word-123")
	if strings.Contains(text, "ss-word") {
		t.Fatalf("not scrubbed: %s", text)
	}
	long := strings.Repeat("ç", pgMaxCell)
	if v := pgValue(long).(string); len(v) > pgMaxCell+4 || !strings.HasSuffix(v, "…") || !json.Valid([]byte(`"`+v+`"`)) {
		t.Fatalf("truncate: %d", len(v))
	}
	cases := map[string]any{
		"big":   pgValue(int64(1) << 60),
		"small": pgValue(int64(42)),
		"nan":   pgValue(math.NaN()),
		"bytes": pgValue([]byte{0xde, 0xad}),
		"uuid":  pgValue([16]byte{0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0}),
		"time":  pgValue(time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)),
		"json":  pgValue(map[string]any{"a": []any{1.0}}),
	}
	data, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"big":"1152921504606846976"`, `"small":42`, `"nan":"NaN"`, `"bytes":"\\xdead"`,
		`"uuid":"12345678-9abc-def0-1234-56789abcdef0"`, `"time":"2026-11-15T10:00:00Z"`, `"json":{"a":[1]}`} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %s in %s", want, data)
		}
	}
}

func TestPostgresPasswordLiteralsAreRedacted(t *testing.T) {
	got := pgValue("ALTER ROLE app WITH ENCRYPTED PASSWORD 'it''s secret' VALID UNTIL 'x'").(string)
	if strings.Contains(got, "secret") || !strings.Contains(got, "PASSWORD '[redacted]'") || !strings.Contains(got, "VALID UNTIL 'x'") {
		t.Fatalf("redaction: %s", got)
	}
}

func TestPostgresDSNFallback(t *testing.T) {
	env := map[string]string{"POSTGRES_READONLY_URL": "postgres://old@db/app"}
	if got := postgresDSN(func(k string) string { return env[k] }); got != "postgres://old@db/app" {
		t.Fatalf("fallback: %s", got)
	}
	env["POSTGRES_URL"] = "postgres://new@db/app"
	if got := postgresDSN(func(k string) string { return env[k] }); got != "postgres://new@db/app" {
		t.Fatalf("preferred: %s", got)
	}
	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres("postgres://u:pw-123456@db:5432/app")
	if s.pg.config.RuntimeParams["default_transaction_read_only"] != "on" || s.pg.write.RuntimeParams["default_transaction_read_only"] != "off" {
		t.Fatal("read and write configs must differ only in read-only default")
	}
	if s.pg.write.Password != s.pg.config.Password || s.pg.write.Host != s.pg.config.Host {
		t.Fatal("write config must use the same DSN")
	}
}

func TestSQLAnalysis(t *testing.T) {
	for sql, want := range map[string]sqlInfo{
		"UPDATE t SET a = 1":                                       {first: "update", second: "t", verb: "update"},
		"update t set a = (select b from c where d) ":              {first: "update", second: "t", verb: "update"},
		"DELETE FROM t WHERE id = 1":                               {first: "delete", second: "from", verb: "delete", topWhere: true},
		"DELETE FROM t -- WHERE id = 1":                            {first: "delete", second: "from", verb: "delete"},
		"DELETE FROM t /* WHERE /* nested */ x */":                 {first: "delete", second: "from", verb: "delete"},
		"DELETE FROM t WHERE note = 'it''s'":                       {first: "delete", second: "from", verb: "delete", topWhere: true},
		`DELETE FROM "where" `:                                     {first: "delete", second: "from", verb: "delete"},
		"DELETE FROM t WHERE x = $1":                               {first: "delete", second: "from", verb: "delete", topWhere: true},
		"WITH x AS (DELETE FROM a WHERE b) UPDATE c SET d = 1":     {first: "with", second: "x", verb: "update"},
		"WITH x AS (SELECT 1) DELETE FROM c WHERE d IN (SELECT 1)": {first: "with", second: "x", verb: "delete", topWhere: true},
		"SELECT * INTO new_table FROM t":                           {first: "select", second: "into", verb: "select", selectInto: true},
		"PREPARE TRANSACTION 'x'":                                  {first: "prepare", second: "transaction", verb: "prepare"},
	} {
		if got := analyzeSQL(sql); got != want {
			t.Fatalf("%q: got %+v want %+v", sql, got, want)
		}
	}
	for _, sql := range []string{"COMMIT", "begin", "/* x */ ROLLBACK", "savepoint a", "END", "PREPARE TRANSACTION 'x'"} {
		if !analyzeSQL(sql).transactionControl() {
			t.Fatalf("%q not treated as transaction control", sql)
		}
	}
	if analyzeSQL("PREPARE q AS SELECT 1").transactionControl() {
		t.Fatal("PREPARE statement is not transaction control")
	}
}

func TestSQLGuardBlocksFilesProgramsAndCopy(t *testing.T) {
	for _, sql := range []string{
		"COPY t TO '/tmp/x'",
		"copy (select 1) to program 'id'",
		"/* hi */ COPY t FROM PROGRAM 'curl x'",
		"SELECT pg_read_file('/etc/passwd')",
		"SELECT pg_catalog.PG_READ_BINARY_FILE('x')",
		`SELECT "pg_ls_dir"('.')`,
		"SELECT * FROM pg_stat_file('x')",
		"SELECT lo_import('/etc/passwd')",
		"SELECT lo_export(1, '/tmp/x')",
		"SELECT dblink_exec('host=x', 'drop table t')",
		"CREATE EXTENSION dblink",
		"CREATE EXTENSION file_fdw",
		"CREATE FUNCTION f() RETURNS int LANGUAGE plpython3u AS 'return 1'",
		"DO $$ BEGIN PERFORM pg_read_file('x'); END $$",
		"DO $body$ BEGIN EXECUTE 'COPY t TO PROGRAM ''id'''; END $body$",
		"DO 'BEGIN EXECUTE ''copy t from ''''/etc/passwd''''''; END'",
	} {
		if analyzeSQL(sql).blocked == "" {
			t.Fatalf("not blocked: %s", sql)
		}
	}
	for _, sql := range []string{
		"SELECT * FROM copy_jobs WHERE note = 'copy'",
		"SELECT copy FROM t",
		"GRANT pg_read_all_data TO x",
		"SELECT $1::int",
	} {
		if b := analyzeSQL(sql).blocked; b != "" {
			t.Fatalf("falsely blocked (%s): %s", b, sql)
		}
	}
	// Literals are scanned too, so a mention inside a string is refused.
	if analyzeSQL("SELECT 'pg_read_file is mentioned here'").blocked == "" {
		t.Fatal("literal not scanned")
	}
	// The guard also applies to the read-only editor, before connecting.
	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres("postgres://ro:pw-123456@127.0.0.1:1/app?connect_timeout=1")
	_, err := s.pgQuery(context.Background(), "app", pgQueryInput{SQL: "SELECT pg_read_file('/etc/passwd')"})
	if e, ok := err.(*pgError); !ok || e.code != "blocked_statement" {
		t.Fatalf("read path not guarded: %v", err)
	}
}

func TestPostgresWriteRequiresConfirmAndRefusesControl(t *testing.T) {
	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres("postgres://rw:pw-123456@127.0.0.1:1/app?connect_timeout=1")
	ctx := context.Background()
	for input, code := range map[pgWriteInput]string{
		{SQL: "UPDATE t SET a = 1 WHERE id = 1"}:         "confirmation_required",
		{SQL: "COMMIT", Confirm: true}:                   "transaction_control",
		{SQL: "COPY t FROM PROGRAM 'id'", Confirm: true}: "blocked_statement",
		{SQL: "  ;  "}: "invalid_sql",
		{SQL: "SELECT lo_export(1, '/tmp/x')", Confirm: true}: "blocked_statement",
	} {
		_, err := s.pgWriteSQL(ctx, "app", input, true, "test")
		if e, ok := err.(*pgError); !ok || e.code != code {
			t.Fatalf("%q: want %s got %v", input.SQL, code, err)
		}
	}
	// Preview needs no confirmation; it fails only because nothing listens.
	if _, err := s.pgWriteSQL(ctx, "app", pgWriteInput{SQL: "UPDATE t SET a = 1"}, false, "test"); err == nil || strings.Contains(err.Error(), "onay") {
		t.Fatalf("preview: %v", err)
	}
	_, err := s.pgWriteRow(ctx, "app", "public", "t", pgRowInput{Op: "delete", Key: map[string]json.RawMessage{"id": json.RawMessage("1")}}, "test")
	if e, ok := err.(*pgError); !ok || e.code != "confirmation_required" {
		t.Fatalf("row without confirm: %v", err)
	}
	_, err = s.pgWriteRow(ctx, "app", "public", "t", pgRowInput{Op: "truncate", Confirm: true}, "test")
	if e, ok := err.(*pgError); !ok || e.code != "invalid_row" {
		t.Fatalf("bad op: %v", err)
	}
}

func TestPostgresWriteRoutes(t *testing.T) {
	s := testServer(t, "http://localhost:9428", false)
	c := signIn(t, s)
	for _, path := range []string{"/api/pg/db/app/write/preview", "/api/pg/db/app/write/commit", "/api/pg/db/app/table/public/t/write"} {
		if w := request(s, "POST", path, `{"sql":"select 1"}`, nil); w.Code != 401 {
			t.Fatalf("%s anonymous: %d", path, w.Code)
		}
		w := request(s, "POST", path, `{}`, c)
		if w.Code != 503 || !strings.Contains(w.Body.String(), "not_configured") {
			t.Fatalf("%s unconfigured: %d %s", path, w.Code, w.Body)
		}
		if w := request(s, "GET", path, "", c); w.Code != 405 {
			t.Fatalf("%s GET: %d", path, w.Code)
		}
	}
	for _, path := range []string{"/api/pg/db/app/write", "/api/pg/db/app/write/other", "/api/pg/db/app/table/public/t/rows/write"} {
		if w := request(s, "POST", path, `{}`, c); w.Code != 404 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	w := request(s, "GET", "/api/pg/status", "", c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"configured":false`) {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	s.configurePostgres("postgres://rw:hunter2-secret@127.0.0.1:1/app?connect_timeout=1")
	r := httptest.NewRequest("POST", "http://logs.example.test/api/pg/db/app/write/commit", strings.NewReader(`{"sql":"delete from t","confirm":true}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Requested-With", "logs-ui")
	r.Header.Set("Origin", "https://evil.example")
	r.AddCookie(c)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	if rec.Code != 403 {
		t.Fatalf("cross-origin write: %d", rec.Code)
	}
	w = request(s, "GET", "/api/pg/status", "", c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"configured":true`) || !strings.Contains(w.Body.String(), `"superuser":null`) || strings.Contains(w.Body.String(), "hunter2") {
		t.Fatalf("status configured: %d %s", w.Code, w.Body)
	}
	if w := request(s, "POST", "/api/pg/db/app/write/preview", `{"sql":"select 1","bogus":1}`, c); w.Code != 400 {
		t.Fatalf("unknown field: %d", w.Code)
	}
}

func TestBuildRowSQL(t *testing.T) {
	columns := []pgColumnInfo{{name: "id", typ: "integer"}, {name: `Na"me`, typ: "text"}, {name: "meta", typ: "jsonb"}, {name: "total", typ: "numeric", generated: true}}
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	sql, args, err := buildRowSQL("Sales Data", `We"ird`, columns, []string{"id"}, pgRowInput{Op: "update",
		Key: map[string]json.RawMessage{"id": raw("7")}, Values: map[string]json.RawMessage{`Na"me`: raw(`"x'); DROP TABLE t; --"`), "meta": raw(`{"a": [1, 2]}`)}})
	if err != nil {
		t.Fatal(err)
	}
	want := `UPDATE "Sales Data"."We""ird" SET "Na""me" = CAST($1::text AS text), "meta" = CAST($2::text AS jsonb) WHERE "id" = CAST($3::text AS integer) RETURNING *`
	if sql != want || len(args) != 3 || args[0] != "x'); DROP TABLE t; --" || args[1] != `{"a":[1,2]}` || args[2] != "7" {
		t.Fatalf("update:\n%s\n%v", sql, args)
	}
	sql, args, err = buildRowSQL("public", "t", columns, []string{"id"}, pgRowInput{Op: "insert", Values: map[string]json.RawMessage{"meta": raw("null"), "id": raw(`"5"`)}})
	if err != nil || sql != `INSERT INTO "public"."t" ("id", "meta") VALUES (CAST($1::text AS integer), NULL) RETURNING *` || len(args) != 1 {
		t.Fatalf("insert: %s %v %v", sql, args, err)
	}
	sql, _, err = buildRowSQL("public", "t", columns, []string{"id"}, pgRowInput{Op: "insert"})
	if err != nil || sql != `INSERT INTO "public"."t" DEFAULT VALUES RETURNING *` {
		t.Fatalf("default insert: %s %v", sql, err)
	}
	sql, _, err = buildRowSQL("public", "t", columns, []string{"id"}, pgRowInput{Op: "delete", Key: map[string]json.RawMessage{"id": raw("1")}})
	if err != nil || sql != `DELETE FROM "public"."t" WHERE "id" = CAST($1::text AS integer) RETURNING *` {
		t.Fatalf("delete: %s %v", sql, err)
	}
	for name, input := range map[string]pgRowInput{
		"unknown column":   {Op: "update", Key: map[string]json.RawMessage{"id": raw("1")}, Values: map[string]json.RawMessage{"nope": raw(`"x"`)}},
		"generated column": {Op: "update", Key: map[string]json.RawMessage{"id": raw("1")}, Values: map[string]json.RawMessage{"total": raw(`"1"`)}},
		"no values":        {Op: "update", Key: map[string]json.RawMessage{"id": raw("1")}},
		"missing key":      {Op: "delete"},
		"wrong key":        {Op: "delete", Key: map[string]json.RawMessage{"Na\"me": raw(`"x"`)}},
		"extra key":        {Op: "delete", Key: map[string]json.RawMessage{"id": raw("1"), "meta": raw("1")}},
		"null key":         {Op: "delete", Key: map[string]json.RawMessage{"id": raw("null")}},
		"object key":       {Op: "delete", Key: map[string]json.RawMessage{"id": raw(`{"a":1}`)}},
		"bad value":        {Op: "update", Key: map[string]json.RawMessage{"id": raw("1")}, Values: map[string]json.RawMessage{"meta": raw("nul")}},
		"key on insert":    {Op: "insert", Key: map[string]json.RawMessage{"id": raw("1")}},
		"values on delete": {Op: "delete", Key: map[string]json.RawMessage{"id": raw("1")}, Values: map[string]json.RawMessage{"meta": raw("1")}},
		"bad op":           {Op: "upsert"},
	} {
		if _, _, err := buildRowSQL("public", "t", columns, []string{"id"}, input); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	for in, want := range map[string]string{`"a"`: "a", `12345678901234567890`: "12345678901234567890", `1.5e3`: "1.5e3", `true`: "true", `[1, "x"]`: `[1,"x"]`} {
		if got, null, ok := jsonText(json.RawMessage(in)); !ok || null || got != want {
			t.Fatalf("jsonText(%s) = %q %v %v", in, got, null, ok)
		}
	}
	for _, in := range []string{``, `nul`, `"a\u0000b"`, `{`, `x`} {
		if _, _, ok := jsonText(json.RawMessage(in)); ok {
			t.Fatalf("jsonText(%q) accepted", in)
		}
	}
}

func TestPostgresWriteKillSwitch(t *testing.T) {
	for value, want := range map[string]bool{"": true, "true": true, "false": false, "0": false, "TRUE": false, "no": false} {
		if postgresWriteEnabled(value) != want {
			t.Fatalf("%q: want %v", value, want)
		}
	}
	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres("postgres://rw:pw-123456@127.0.0.1:1/app?connect_timeout=1")
	s.pg.writeDisabled = true
	c := signIn(t, s)
	for _, path := range []string{"/api/pg/db/app/write/preview", "/api/pg/db/app/write/commit", "/api/pg/db/app/table/public/t/write"} {
		w := request(s, "POST", path, `{"sql":"delete from t","confirm":true}`, c)
		if w.Code != 403 || !strings.Contains(w.Body.String(), "write_disabled") {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if w := request(s, "GET", "/api/pg/status", "", c); !strings.Contains(w.Body.String(), `"writeEnabled":false`) {
		t.Fatalf("status: %s", w.Body)
	}
	// Reads are unaffected by the switch (here: unreachable, not refused).
	if w := request(s, "GET", "/api/pg/overview", "", c); w.Code != 502 {
		t.Fatalf("read with writes disabled: %d", w.Code)
	}
	s.pg.writeDisabled = false
	if w := request(s, "GET", "/api/pg/status", "", c); !strings.Contains(w.Body.String(), `"writeEnabled":true`) {
		t.Fatalf("status enabled: %s", w.Body)
	}
	if w := request(s, "POST", "/api/pg/db/app/write/preview", `{"sql":"select 1"}`, c); w.Code == 403 {
		t.Fatalf("enabled writes refused: %s", w.Body)
	}
}

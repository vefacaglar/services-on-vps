package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Integration tests against a real PostgreSQL 17.
//
//   - POSTGRES_TEST_ADMIN_URL set: use that server (a superuser DSN).
//   - otherwise, if Docker is reachable, start a throwaway container.
//   - POSTGRES_INTEGRATION=1 makes a missing Docker a failure (CI);
//     POSTGRES_INTEGRATION=skip skips the test.
const postgresTestImage = "postgres:17-alpine@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065"

// readOnlyRoleSQL is the optional read-only role documented in
// docs/postgres-inspector.md.
const readOnlyRoleSQL = `
CREATE ROLE logs_console_ro LOGIN PASSWORD '%s' CONNECTION LIMIT 3;
GRANT pg_read_all_data, pg_monitor TO logs_console_ro;
ALTER ROLE logs_console_ro SET default_transaction_read_only = on;
ALTER ROLE logs_console_ro SET statement_timeout = '5s';
`

// consoleRoleSQL is the recommended single role for reads and write mode.
const consoleRoleSQL = `
CREATE ROLE logs_console LOGIN PASSWORD '%s' CONNECTION LIMIT 3;
GRANT pg_read_all_data, pg_write_all_data, pg_monitor TO logs_console;
ALTER ROLE logs_console SET statement_timeout = '5s';
`

func postgresAdmin(t *testing.T) string {
	t.Helper()
	mode := os.Getenv("POSTGRES_INTEGRATION")
	if mode == "skip" {
		t.Skip("POSTGRES_INTEGRATION=skip")
	}
	if dsn := os.Getenv("POSTGRES_TEST_ADMIN_URL"); dsn != "" {
		return dsn
	}
	if exec.Command("docker", "info").Run() != nil {
		if mode == "1" {
			t.Fatal("POSTGRES_INTEGRATION=1 but Docker is not available")
		}
		t.Skip("Docker not available; set POSTGRES_TEST_ADMIN_URL to run against a server")
	}
	password := randomHex(t)
	name := "logs-console-pg-test-" + randomHex(t)[:8]
	env := append(os.Environ(), "POSTGRES_PASSWORD="+password)
	run := exec.Command("docker", "run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD",
		"-p", "127.0.0.1::5432", postgresTestImage, "-c", "shared_preload_libraries=pg_stat_statements")
	run.Env = env
	if out, err := run.CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", "-v", name).Run() })
	out, err := exec.Command("docker", "port", name, "5432/tcp").Output()
	if err != nil {
		t.Fatalf("docker port: %v", err)
	}
	address := strings.TrimSpace(strings.Split(string(out), "\n")[0])
	dsn := fmt.Sprintf("postgres://postgres:%s@%s/postgres?sslmode=disable", password, address)
	deadline := time.Now().Add(60 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		conn, err := pgx.Connect(ctx, dsn)
		if err == nil {
			// The entrypoint restarts the server once after init; wait for a stable one.
			err = conn.Ping(ctx)
			_ = conn.Close(ctx)
		}
		cancel()
		if err == nil {
			time.Sleep(time.Second)
			if c, err := pgx.Connect(context.Background(), dsn); err == nil {
				_ = c.Close(context.Background())
				return dsn
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("postgres did not start: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func randomHex(t *testing.T) string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func execAll(t *testing.T, dsn string, statements ...string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, sql := range statements {
		if _, err := conn.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
}

func withDatabase(dsn, db string) string {
	u, _ := url.Parse(dsn)
	u.Path = "/" + db
	return u.String()
}

func withUser(dsn, user, password string) string {
	u, _ := url.Parse(dsn)
	u.User = url.UserPassword(user, password)
	return u.String()
}

func decodeBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return out
}

func countProducts(t *testing.T, dsn string) int {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), withDatabase(dsn, "shop"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var n int
	if err := conn.QueryRow(context.Background(), "SELECT count(*) FROM public.products").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPostgresIntegration(t *testing.T) {
	admin := postgresAdmin(t)
	password := "ro-" + randomHex(t)
	execAll(t, admin,
		"DROP DATABASE IF EXISTS shop", "DROP DATABASE IF EXISTS analytics", "DROP ROLE IF EXISTS logs_console_ro",
		fmt.Sprintf(readOnlyRoleSQL, password), "CREATE DATABASE shop", "CREATE DATABASE analytics")
	execAll(t, withDatabase(admin, "shop"),
		"CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
		`CREATE TABLE products (id serial PRIMARY KEY, name text NOT NULL, price numeric(10,2) CHECK (price >= 0),
			tags text[], meta jsonb, uid uuid DEFAULT gen_random_uuid(), created timestamptz DEFAULT now(), UNIQUE (name))`,
		"CREATE INDEX products_price ON products (price)",
		`INSERT INTO products (name, price, tags, meta) SELECT 'item ' || g, g * 1.5, ARRAY['a', 'b'], jsonb_build_object('n', g)
			FROM generate_series(1, 120) g`,
		"CREATE VIEW cheap AS SELECT * FROM products WHERE price < 10", "ANALYZE products")
	execAll(t, withDatabase(admin, "analytics"),
		`CREATE SCHEMA "Sales Data"`, `CREATE TABLE "Sales Data"."We""ird" ("Key" int PRIMARY KEY, "val ue" text)`,
		`INSERT INTO "Sales Data"."We""ird" VALUES (2, 'two'), (1, 'one')`)

	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres(withUser(withDatabase(admin, "postgres"), "logs_console_ro", password))
	c := signIn(t, s)
	get := func(path string) (int, map[string]any) {
		w := request(s, "GET", path, "", c)
		if strings.Contains(w.Body.String(), password) {
			t.Fatalf("%s leaked the password", path)
		}
		return w.Code, decodeBody(t, w.Body.String())
	}
	query := func(sql string, explain bool) (int, map[string]any) {
		body, _ := json.Marshal(map[string]any{"sql": sql, "explain": explain})
		w := request(s, "POST", "/api/pg/db/shop/query", string(body), c)
		if strings.Contains(w.Body.String(), password) {
			t.Fatalf("query leaked the password")
		}
		return w.Code, decodeBody(t, w.Body.String())
	}

	code, overview := get("/api/pg/overview")
	if code != 200 || !strings.Contains(fmt.Sprint(overview["databases"]), "shop") || overview["server"].(map[string]any)["maxConnections"] == nil {
		t.Fatalf("overview: %d %v", code, overview)
	}
	code, db := get("/api/pg/db/shop")
	if code != 200 || !strings.Contains(fmt.Sprint(db["tables"]), "products") || !strings.Contains(fmt.Sprint(db["views"]), "cheap") {
		t.Fatalf("db: %d %v", code, db)
	}
	if db["statements"] == nil && db["statementsError"] == nil {
		t.Fatalf("pg_stat_statements not reported: %v", db)
	}
	code, table := get("/api/pg/db/shop/table/public/products")
	if code != 200 || !strings.Contains(fmt.Sprint(table["constraints"]), "primary key") ||
		!strings.Contains(fmt.Sprint(table["indexes"]), "products_price") || len(table["columns"].([]any)) != 7 {
		t.Fatalf("table: %d %v", code, table)
	}
	code, rows := get("/api/pg/db/shop/table/public/products/rows?limit=5&offset=10")
	list := rows["rows"].([]any)
	if code != 200 || len(list) != 5 || list[0].(map[string]any)["id"].(float64) != 11 || fmt.Sprint(rows["orderBy"]) != "[id]" {
		t.Fatalf("rows: %d %v", code, rows)
	}
	first := list[0].(map[string]any)
	if first["price"] != "16.50" || !strings.Contains(fmt.Sprint(first["meta"]), "11") || len(fmt.Sprint(first["uid"])) != 36 {
		t.Fatalf("value conversion: %v", first)
	}
	code, weird := get("/api/pg/db/analytics/table/" + url.PathEscape("Sales Data") + "/" + url.PathEscape(`We"ird`) + "/rows")
	if code != 200 || len(weird["rows"].([]any)) != 2 || weird["rows"].([]any)[0].(map[string]any)["Key"].(float64) != 1 {
		t.Fatalf("quoted identifiers: %d %v", code, weird)
	}
	code, schema := get("/api/pg/db/analytics/schema")
	weirdColumns := fmt.Sprint(schema["schemas"].(map[string]any)["Sales Data"].(map[string]any)[`We"ird`])
	if code != 200 || schema["truncated"] != false || weirdColumns != "[map[name:Key nullable:false pk:true type:integer] map[name:val ue nullable:true pk:false type:text]]" ||
		fmt.Sprint(schema["kinds"]) != `map[Sales Data:map[We"ird:table]]` {
		t.Fatalf("schema: %d %v", code, schema)
	}
	code, schema = get("/api/pg/db/shop/schema")
	if public := schema["schemas"].(map[string]any)["public"].(map[string]any); code != 200 || len(public["products"].([]any)) != 7 || public["cheap"] == nil {
		t.Fatalf("shop schema: %d %v", code, schema)
	}
	for path, want := range map[string]int{
		"/api/pg/db/nope":                                    404,
		"/api/pg/db/nope/schema":                             404,
		"/api/pg/db/template1":                               404,
		"/api/pg/db/shop/table/public/missing":               404,
		"/api/pg/db/shop/table/public/products/rows?limit=0": 400,
	} {
		if code, body := get(path); code != want {
			t.Fatalf("%s: want %d got %d %v", path, want, code, body)
		}
	}

	code, result := query("SELECT id, name FROM products ORDER BY id LIMIT 3", false)
	if code != 200 || len(result["rows"].([]any)) != 3 || result["truncated"] != false {
		t.Fatalf("select: %d %v", code, result)
	}
	code, result = query("DO $$ BEGIN RAISE NOTICE 'hello %', 42; END $$", false)
	if code != 200 || fmt.Sprint(result["notices"]) != "[NOTICE: hello 42]" {
		t.Fatalf("notices: %d %v", code, result)
	}
	code, result = query("SELECT g FROM generate_series(1, 100000) g", false)
	if code != 200 || len(result["rows"].([]any)) != pgMaxRows || result["truncated"] != true {
		t.Fatalf("cap: %d %v", code, result["truncated"])
	}
	code, result = query("SELECT * FROM products WHERE price > 10", true)
	if code != 200 || !strings.Contains(fmt.Sprint(result["rows"]), "Seq Scan") && !strings.Contains(fmt.Sprint(result["rows"]), "Index") {
		t.Fatalf("explain: %d %v", code, result)
	}

	// Error positions point into the text as typed, with or without EXPLAIN.
	for _, explain := range []bool{false, true} {
		code, result = query("  SELECT\n  nosuch FROM products", explain)
		if code != 400 || result["position"] != float64(12) {
			t.Fatalf("position (explain=%v): %d %v", explain, code, result)
		}
	}

	before := countProducts(t, admin)
	for _, sql := range []string{
		"INSERT INTO products (name, price) VALUES ('x', 1)",
		"UPDATE products SET price = 0",
		"DELETE FROM products",
		"CREATE TABLE evil (id int)",
		"DROP TABLE products",
		"DO $$ BEGIN INSERT INTO products (name, price) VALUES ('y', 1); END $$",
		"SELECT 1; DROP TABLE products",
		"COMMIT; INSERT INTO products (name, price) VALUES ('z', 1)",
		"SET transaction_read_only = off",
	} {
		code, body := query(sql, false)
		if code < 400 {
			t.Fatalf("write accepted: %s → %d %v", sql, code, body)
		}
	}
	// Session changes die with the connection; the next write is still refused.
	if code, _ := query("SELECT set_config('default_transaction_read_only', 'off', false)", false); code != 200 {
		t.Fatalf("set_config: %d", code)
	}
	if code, body := query("INSERT INTO products (name, price) VALUES ('w', 1)", false); code != 400 || body["code"] != "read_only" {
		t.Fatalf("write after set_config: %d %v", code, body)
	}
	if countProducts(t, admin) != before {
		t.Fatal("rows changed")
	}
	started := time.Now()
	if code, body := query("SELECT pg_sleep(30)", false); code != 400 || body["code"] != "timeout" || time.Since(started) > 10*time.Second {
		t.Fatalf("timeout: %d %v after %s", code, body, time.Since(started))
	}

	// Even with a superuser DSN the console only reads.
	su := testServer(t, "http://localhost:9428", false)
	su.configurePostgres(withDatabase(admin, "postgres"))
	sc := signIn(t, su)
	w := request(su, "POST", "/api/pg/db/shop/query", `{"sql":"INSERT INTO products (name, price) VALUES ('su', 1)"}`, sc)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "read_only") {
		t.Fatalf("superuser write: %d %s", w.Code, w.Body)
	}
	if countProducts(t, admin) != before {
		t.Fatal("superuser write changed rows")
	}
	if w := request(su, "GET", "/api/pg/status", "", sc); w.Code != 200 || !strings.Contains(w.Body.String(), `"superuser":true`) {
		t.Fatalf("superuser not flagged: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/api/pg/status", "", c); w.Code != 200 || !strings.Contains(w.Body.String(), `"superuser":false`) {
		t.Fatalf("read-only role flagged as superuser: %d %s", w.Code, w.Body)
	}
	// File and program access is refused even for a superuser DSN.
	for _, sql := range []string{"SELECT pg_read_file('postgresql.conf')", "SELECT * FROM pg_ls_dir('.')", "COPY products TO STDOUT"} {
		body, _ := json.Marshal(map[string]any{"sql": sql})
		if w := request(su, "POST", "/api/pg/db/shop/query", string(body), sc); w.Code != 400 || !strings.Contains(w.Body.String(), "blocked_statement") {
			t.Fatalf("superuser %s: %d %s", sql, w.Code, w.Body)
		}
	}

	// A wrong password is reported without echoing it.
	bad := testServer(t, "http://localhost:9428", false)
	bad.configurePostgres(withUser(withDatabase(admin, "postgres"), "logs_console_ro", "wrong-password-123"))
	bc := signIn(t, bad)
	w = request(bad, "GET", "/api/pg/overview", "", bc)
	if w.Code != http.StatusBadGateway || strings.Contains(w.Body.String(), "wrong-password-123") {
		t.Fatalf("bad password: %d %s", w.Code, w.Body)
	}

	// Role-level guarantees from the documented SQL.
	ro := withUser(withDatabase(admin, "shop"), "logs_console_ro", password)
	conn, err := pgx.Connect(context.Background(), ro)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(context.Background(), "INSERT INTO products (name, price) VALUES ('direct', 1)"); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("role allowed a direct write: %v", err)
	}
}

func scalarInt(t *testing.T, dsn, sql string) int {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var n int
	if err := conn.QueryRow(context.Background(), sql).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func TestPostgresWriteIntegration(t *testing.T) {
	admin := postgresAdmin(t)
	password := "rw-" + randomHex(t)
	execAll(t, admin,
		"DROP DATABASE IF EXISTS store", "DROP DATABASE IF EXISTS archive", "DROP ROLE IF EXISTS logs_console",
		fmt.Sprintf(consoleRoleSQL, password), "CREATE DATABASE store", "CREATE DATABASE archive")
	store, archive := withDatabase(admin, "store"), withDatabase(admin, "archive")
	execAll(t, store,
		`CREATE TABLE products (id serial PRIMARY KEY, name text NOT NULL UNIQUE, price numeric(10,2) CHECK (price >= 0), tags text[], meta jsonb)`,
		`INSERT INTO products (name, price) SELECT 'item ' || g, g FROM generate_series(1, 10) g`,
		`CREATE TABLE notes (body text)`, `INSERT INTO notes VALUES ('a')`,
		`CREATE VIEW cheap AS SELECT * FROM products WHERE price < 5`)
	execAll(t, archive, `CREATE TABLE "Old Items" ("Key" text PRIMARY KEY, n int)`)

	var audit strings.Builder
	log.SetOutput(&audit)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	s := testServer(t, "http://localhost:9428", false)
	s.configurePostgres(withUser(withDatabase(admin, "postgres"), "logs_console", password))
	c := signIn(t, s)
	call := func(path string, body any) (int, map[string]any) {
		t.Helper()
		data, _ := json.Marshal(body)
		w := request(s, "POST", path, string(data), c)
		if strings.Contains(w.Body.String(), password) {
			t.Fatalf("%s leaked the password", path)
		}
		return w.Code, decodeBody(t, w.Body.String())
	}
	sum := func() int { return scalarInt(t, store, "SELECT sum(price)::int FROM products") }

	if w := request(s, "GET", "/api/pg/status", "", c); !strings.Contains(w.Body.String(), `"superuser":false`) || !strings.Contains(w.Body.String(), `"configured":true`) {
		t.Fatalf("status: %s", w.Body)
	}
	// The read editor still refuses writes with a DSN that may write.
	if code, body := call("/api/pg/db/store/query", map[string]any{"sql": "UPDATE products SET price = 0"}); code != 400 || body["code"] != "read_only" {
		t.Fatalf("read path wrote: %d %v", code, body)
	}

	// Preview executes, reports and rolls back.
	before := sum()
	code, body := call("/api/pg/db/store/write/preview", map[string]any{"sql": "UPDATE products SET price = price + 1 WHERE id <= 3 RETURNING id"})
	if code != 200 || body["rowsAffected"] != float64(3) || body["committed"] != false || body["dangerous"] != false || len(body["rows"].([]any)) != 3 {
		t.Fatalf("preview: %d %v", code, body)
	}
	if sum() != before {
		t.Fatal("preview changed data")
	}
	code, body = call("/api/pg/db/store/write/preview", map[string]any{"sql": "DELETE FROM products"})
	if code != 200 || body["dangerous"] != true || fmt.Sprint(body["reasons"]) != "[no_where]" || body["rowsAffected"] != float64(10) {
		t.Fatalf("no-where preview: %d %v", code, body)
	}
	if countRows := scalarInt(t, store, "SELECT count(*) FROM products"); countRows != 10 {
		t.Fatal("dangerous preview changed data")
	}

	// Commit guards: confirm flag, database name for dangerous statements,
	// unchanged row count.
	for _, tc := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"sql": "UPDATE products SET price = 1 WHERE id = 1"}, "confirmation_required"},
		{map[string]any{"sql": "DELETE FROM products", "confirm": true}, "database_confirmation_required"},
		{map[string]any{"sql": "DELETE FROM products", "confirm": true, "confirmDatabase": "postgres"}, "database_confirmation_required"},
		{map[string]any{"sql": "UPDATE products SET price = 1 WHERE id <= 3", "confirm": true, "expectedRows": 2}, "rows_changed"},
		{map[string]any{"sql": "COMMIT", "confirm": true}, "transaction_control"},
		{map[string]any{"sql": "COPY products TO STDOUT", "confirm": true}, "blocked_statement"},
		{map[string]any{"sql": "SELECT lo_import('/etc/passwd')", "confirm": true}, "blocked_statement"},
		{map[string]any{"sql": "UPDATE products SET price = -1 WHERE id = 1", "confirm": true}, "query_error"},
	} {
		if code, body := call("/api/pg/db/store/write/commit", tc.body); code < 400 || body["code"] != tc.code {
			t.Fatalf("%v: want %s got %d %v", tc.body, tc.code, code, body)
		}
	}
	if sum() != before {
		t.Fatal("refused commit changed data")
	}
	code, body = call("/api/pg/db/store/write/commit", map[string]any{"sql": "UPDATE products SET price = price + 1 WHERE id <= 3", "confirm": true, "expectedRows": 3})
	if code != 200 || body["committed"] != true || body["rowsAffected"] != float64(3) || sum() != before+3 {
		t.Fatalf("commit: %d %v", code, body)
	}
	code, body = call("/api/pg/db/store/write/commit", map[string]any{"sql": "DELETE FROM notes", "confirm": true, "confirmDatabase": "store"})
	if code != 200 || scalarInt(t, store, "SELECT count(*) FROM notes") != 0 {
		t.Fatalf("confirmed dangerous commit: %d %v", code, body)
	}
	started := time.Now()
	if code, body := call("/api/pg/db/store/write/preview", map[string]any{"sql": "SELECT pg_sleep(30)"}); code != 400 || body["code"] != "timeout" || time.Since(started) > 10*time.Second {
		t.Fatalf("write timeout: %d %v", code, body)
	}

	// A second database: the target comes from the URL, not the DSN.
	code, body = call("/api/pg/db/archive/write/commit", map[string]any{"sql": `INSERT INTO "Old Items" VALUES ('a', 1), ('b', 2)`, "confirm": true, "expectedRows": 2})
	if code != 200 || scalarInt(t, archive, `SELECT count(*) FROM "Old Items"`) != 2 {
		t.Fatalf("second database: %d %v", code, body)
	}
	if code, _ := call("/api/pg/db/nope/write/preview", map[string]any{"sql": "SELECT 1"}); code != 404 {
		t.Fatalf("unknown database: %d", code)
	}

	// Row edits by primary key.
	rowPath := "/api/pg/db/store/table/public/products/write"
	code, body = call(rowPath, map[string]any{"op": "insert", "confirm": true, "values": map[string]any{"name": "new", "price": "2.50", "tags": "{a,b}", "meta": map[string]any{"k": 1}}})
	if code != 200 || body["rowsAffected"] != float64(1) {
		t.Fatalf("insert: %d %v", code, body)
	}
	row := body["row"].(map[string]any)
	id := row["id"]
	if row["price"] != "2.50" || fmt.Sprint(row["tags"]) != "[a b]" || id != float64(11) {
		t.Fatalf("inserted row: %v", row)
	}
	code, body = call(rowPath, map[string]any{"op": "update", "confirm": true, "key": map[string]any{"id": id}, "values": map[string]any{"name": "renamed", "meta": nil}})
	if code != 200 || scalarInt(t, store, "SELECT count(*) FROM products WHERE name = 'renamed' AND meta IS NULL AND id = 11") != 1 {
		t.Fatalf("update: %d %v", code, body)
	}
	code, body = call(rowPath, map[string]any{"op": "update", "confirm": true, "key": map[string]any{"id": 999}, "values": map[string]any{"name": "ghost"}})
	if code != 409 || body["code"] != "row_count" {
		t.Fatalf("update missing row: %d %v", code, body)
	}
	if code, body := call(rowPath, map[string]any{"op": "update", "confirm": true, "key": map[string]any{"id": "1"}, "values": map[string]any{"name": "item 2"}}); code != 400 || body["pgCode"] != "23505" {
		t.Fatalf("unique violation: %d %v", code, body)
	}
	code, body = call(rowPath, map[string]any{"op": "delete", "confirm": true, "key": map[string]any{"id": id}})
	if code != 200 || scalarInt(t, store, "SELECT count(*) FROM products WHERE id = 11") != 0 {
		t.Fatalf("delete: %d %v", code, body)
	}
	weird := "/api/pg/db/archive/table/public/" + url.PathEscape("Old Items") + "/write"
	if code, body := call(weird, map[string]any{"op": "update", "confirm": true, "key": map[string]any{"Key": "a"}, "values": map[string]any{"n": "42"}}); code != 200 ||
		scalarInt(t, archive, `SELECT n FROM "Old Items" WHERE "Key" = 'a'`) != 42 {
		t.Fatalf("quoted identifiers: %d %v", code, body)
	}
	for path, want := range map[string]string{
		"/api/pg/db/store/table/public/notes/write":   "no_primary_key",
		"/api/pg/db/store/table/public/cheap/write":   "not_a_table",
		"/api/pg/db/store/table/public/missing/write": "not_found",
	} {
		if code, body := call(path, map[string]any{"op": "delete", "confirm": true, "key": map[string]any{"id": 1}}); code < 400 || body["code"] != want {
			t.Fatalf("%s: want %s got %d %v", path, want, code, body)
		}
	}
	if code, body := call(rowPath, map[string]any{"op": "delete", "key": map[string]any{"id": 1}}); code != 400 || body["code"] != "confirmation_required" {
		t.Fatalf("row without confirm: %d %v", code, body)
	}
	if scalarInt(t, store, "SELECT count(*) FROM products") != 10 {
		t.Fatal("refused row edits changed data")
	}

	// Every commit is audited without the password; previews are not.
	logged := audit.String()
	if strings.Count(logged, "postgres write committed") != 7 || strings.Contains(logged, password) ||
		!strings.Contains(logged, `db="archive"`) || !strings.Contains(logged, `user="vefa"`) || !strings.Contains(logged, "op=delete") {
		t.Fatalf("audit log:\n%s", logged)
	}

	// Superuser DSN: flagged, DDL preview rolls back, confirmed DDL commits.
	su := testServer(t, "http://localhost:9428", false)
	su.configurePostgres(withDatabase(admin, "postgres"))
	sc := signIn(t, su)
	if w := request(su, "GET", "/api/pg/status", "", sc); !strings.Contains(w.Body.String(), `"superuser":true`) {
		t.Fatalf("superuser status: %s", w.Body)
	}
	if !strings.Contains(audit.String(), "connects as a PostgreSQL superuser") {
		t.Fatal("superuser warning not logged")
	}
	w := request(su, "POST", "/api/pg/db/store/write/preview", `{"sql":"CREATE TABLE ddl_test (id int)"}`, sc)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ddl":true`) || !strings.Contains(w.Body.String(), `"dangerous":true`) ||
		scalarInt(t, store, "SELECT count(*) FROM pg_class WHERE relname = 'ddl_test'") != 0 {
		t.Fatalf("ddl preview: %d %s", w.Code, w.Body)
	}
	for _, sql := range []string{"SELECT pg_read_file('postgresql.conf')", "COPY products TO PROGRAM 'id'", "DO $$ BEGIN PERFORM pg_ls_dir('.'); END $$"} {
		data, _ := json.Marshal(map[string]any{"sql": sql})
		if w := request(su, "POST", "/api/pg/db/store/write/preview", string(data), sc); w.Code != 400 || !strings.Contains(w.Body.String(), "blocked_statement") {
			t.Fatalf("superuser %s: %d %s", sql, w.Code, w.Body)
		}
	}
	w = request(su, "POST", "/api/pg/db/store/write/commit", `{"sql":"CREATE TABLE ddl_test (id int)","confirm":true,"confirmDatabase":"store"}`, sc)
	if w.Code != 200 || scalarInt(t, store, "SELECT count(*) FROM pg_class WHERE relname = 'ddl_test'") != 1 {
		t.Fatalf("ddl commit: %d %s", w.Code, w.Body)
	}
}

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

// readOnlyRoleSQL is the role documented in docs/postgres-inspector.md.
const readOnlyRoleSQL = `
CREATE ROLE logs_console_ro LOGIN PASSWORD '%s' CONNECTION LIMIT 3;
GRANT pg_read_all_data, pg_monitor TO logs_console_ro;
ALTER ROLE logs_console_ro SET default_transaction_read_only = on;
ALTER ROLE logs_console_ro SET statement_timeout = '5s';
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
	for path, want := range map[string]int{
		"/api/pg/db/nope":                                    404,
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

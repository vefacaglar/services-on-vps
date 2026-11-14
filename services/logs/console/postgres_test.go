package main

import (
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

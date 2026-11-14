package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const fakeMeiliKey = "fake-master-key-0123456789abcdef"

type fakeMeili struct {
	mu       sync.Mutex
	requests []string
	bodies   []string
}

func (f *fakeMeili) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI())
		f.bodies = append(f.bodies, string(body))
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+fakeMeiliKey {
			w.WriteHeader(401)
			_, _ = io.WriteString(w, `{"message":"The provided API key is invalid.","code":"invalid_api_key"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/version":
			_, _ = io.WriteString(w, `{"pkgVersion":"1.56.2","commitSha":"x"}`)
		case "/health":
			_, _ = io.WriteString(w, `{"status":"available"}`)
		case "/stats":
			_, _ = io.WriteString(w, `{"databaseSize":4096,"usedDatabaseSize":2048,"lastUpdate":"2026-11-14T10:00:00Z","indexes":{"products":{"numberOfDocuments":6,"indexSize":1024,"isIndexing":false,"fieldDistribution":{"id":6}}}}`)
		case "/indexes":
			_, _ = io.WriteString(w, `{"results":[{"uid":"products","primaryKey":"id","createdAt":"2026-11-14T09:00:00Z","updatedAt":"2026-11-14T10:00:00Z"}],"offset":0,"limit":1000,"total":1}`)
		case "/experimental-features":
			_, _ = io.WriteString(w, `{"metrics":false}`)
		case "/keys":
			_, _ = io.WriteString(w, `{"results":[{"name":"Default Search API Key","description":"search","key":"abcdef0123456789secretsecret","uid":"u-1","actions":["search"],"indexes":["*"],"expiresAt":null,"createdAt":"2026-11-14T09:00:00Z","updatedAt":"2026-11-14T09:00:00Z"},{"name":"Master echo","description":null,"key":"`+fakeMeiliKey+`","uid":"u-2","actions":["*"],"indexes":["*"],"expiresAt":null,"createdAt":"2026-11-14T09:00:00Z","updatedAt":"2026-11-14T09:00:00Z"}],"offset":0,"limit":200,"total":2}`)
		case "/tasks":
			_, _ = io.WriteString(w, `{"results":[{"uid":3,"type":"indexSwap","status":"succeeded","details":{"swaps":[{"indexes":["a_v2","a"],"rename":true}]}}],"total":1,"limit":20,"from":3,"next":null}`)
		case "/indexes/products", "/indexes/products/stats", "/indexes/products/settings":
			_, _ = io.WriteString(w, `{"ok":true}`)
		case "/indexes/products/documents":
			_, _ = io.WriteString(w, `{"results":[{"id":1}],"offset":0,"limit":20,"total":1}`)
		case "/indexes/products/search":
			_, _ = io.WriteString(w, `{"hits":[{"id":1}],"query":"x","estimatedTotalHits":1}`)
		case "/indexes/leaky", "/indexes/leaky/stats", "/indexes/leaky/settings":
			w.WriteHeader(400)
			_, _ = io.WriteString(w, `{"message":"bad thing near `+fakeMeiliKey+`","code":"bad_request"}`)
		default:
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"message":"Index `+"`"+`missing`+"`"+` not found.","code":"index_not_found"}`)
		}
	})
}

func meiliServer(t *testing.T, key string) (*server, *fakeMeili, *http.Cookie) {
	t.Helper()
	fake := &fakeMeili{}
	upstream := httptest.NewServer(fake.handler(t))
	t.Cleanup(upstream.Close)
	s := testServer(t, "http://localhost:9428", false)
	s.meiliURL, s.meiliKey = upstream.URL, key
	return s, fake, signIn(t, s)
}

func noLeak(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if strings.Contains(w.Body.String(), fakeMeiliKey) || strings.Contains(w.Body.String(), "secretsecret") {
		t.Fatalf("key leaked: %s", w.Body)
	}
}

func TestMeiliRequiresSession(t *testing.T) {
	s, fake, _ := meiliServer(t, fakeMeiliKey)
	for _, path := range []string{"/api/meili/overview", "/api/meili/keys", "/api/meili/tasks", "/api/meili/indexes/products"} {
		if w := request(s, "GET", path, "", nil); w.Code != 401 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	if w := request(s, "GET", "/meilisearch/keys", "", nil); w.Code != 303 || !strings.HasPrefix(w.Header().Get("Location"), "/login?next=") {
		t.Fatalf("page redirect: %d %s", w.Code, w.Header().Get("Location"))
	}
	if len(fake.requests) != 0 {
		t.Fatalf("upstream called without session: %v", fake.requests)
	}
}

func TestMeiliNotConfigured(t *testing.T) {
	s, _, c := meiliServer(t, "")
	w := request(s, "GET", "/api/meili/overview", "", c)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "not_configured") {
		t.Fatalf("not configured: %d %s", w.Code, w.Body)
	}
	// Logs UI keeps working.
	if w := request(s, "GET", "/api/session", "", c); w.Code != 200 {
		t.Fatalf("session broke: %d", w.Code)
	}
	if w := request(s, "GET", "/meilisearch", "", c); w.Code == 404 || w.Code == 401 {
		t.Fatalf("page not served: %d", w.Code)
	}
}

func TestMeiliKeysAreRedacted(t *testing.T) {
	s, _, c := meiliServer(t, fakeMeiliKey)
	w := request(s, "GET", "/api/meili/keys", "", c)
	if w.Code != 200 {
		t.Fatalf("keys: %d %s", w.Code, w.Body)
	}
	noLeak(t, w)
	var out struct {
		Results []map[string]any `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || len(out.Results) != 2 {
		t.Fatalf("decode: %v %s", err, w.Body)
	}
	if out.Results[0]["keyPrefix"] != "abcdef01" || out.Results[0]["key"] != nil || out.Results[0]["name"] != "Default Search API Key" {
		t.Fatalf("bad redaction: %v", out.Results[0])
	}
	if p, _ := out.Results[1]["keyPrefix"].(string); len(p) > 10 {
		t.Fatalf("master key prefix too long: %q", p)
	}
}

func TestMeiliEndpointsAndValidation(t *testing.T) {
	s, fake, c := meiliServer(t, fakeMeiliKey)
	w := request(s, "GET", "/api/meili/overview", "", c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"numberOfDocuments":6`) || !strings.Contains(w.Body.String(), `"version":"1.56.2"`) {
		t.Fatalf("overview: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/api/meili/tasks?types=indexSwap&statuses=succeeded,failed&indexUids=products&limit=5&from=9", "", c); w.Code != 200 || !strings.Contains(w.Body.String(), "rename") {
		t.Fatalf("tasks: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/api/meili/indexes/products/documents?limit=10&offset=5&filter=id%20%3E%201", "", c); w.Code != 200 {
		t.Fatalf("documents: %d %s", w.Code, w.Body)
	}
	if w := request(s, "POST", "/api/meili/indexes/products/search", `{"q":"x","limit":5,"facets":["brand"]}`, c); w.Code != 200 {
		t.Fatalf("search: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/api/meili/indexes/products", "", c); w.Code != 200 || !strings.Contains(w.Body.String(), "settings") {
		t.Fatalf("index: %d %s", w.Code, w.Body)
	}
	fake.mu.Lock()
	seen := strings.Join(fake.requests, "\n")
	lastBody := ""
	for i, req := range fake.requests {
		if strings.HasPrefix(req, "POST ") {
			lastBody = fake.bodies[i]
		}
	}
	fake.mu.Unlock()
	if !strings.Contains(seen, "GET /tasks?") || !strings.Contains(seen, "from=9") || !strings.Contains(seen, "offset=5") {
		t.Fatalf("upstream params: %s", seen)
	}
	if !strings.Contains(lastBody, `"facets":["brand"]`) {
		t.Fatalf("search body not whitelisted: %s", lastBody)
	}

	bad := map[string]string{
		"/api/meili/indexes/bad.name":                    "GET",
		"/api/meili/indexes/%2e%2e":                      "GET",
		"/api/meili/indexes/" + strings.Repeat("a", 401): "GET",
		"/api/meili/tasks?statuses=deleted":              "GET",
		"/api/meili/tasks?types=index%20Swap":            "GET",
		"/api/meili/tasks?indexUids=a/b":                 "GET",
		"/api/meili/tasks?limit=1000":                    "GET",
		"/api/meili/tasks?from=-1":                       "GET",
		"/api/meili/indexes/products/documents?limit=0":  "GET",
		"/api/meili/indexes/products/documents?offset=x": "GET",
	}
	before := len(fake.requests)
	for path, method := range bad {
		if w := request(s, method, path, "", c); w.Code != 400 {
			t.Fatalf("%s: want 400, got %d %s", path, w.Code, w.Body)
		}
	}
	for _, body := range []string{`{"limit":500}`, `{"q":"x","attributesToRetrieve":["*"]}`, `{"offset":-1}`} {
		if w := request(s, "POST", "/api/meili/indexes/products/search", body, c); w.Code != 400 {
			t.Fatalf("search %s: %d", body, w.Code)
		}
	}
	if len(fake.requests) != before {
		t.Fatalf("invalid input reached upstream: %v", fake.requests[before:])
	}
	// No generic proxy: unknown routes and methods stay closed.
	for _, path := range []string{"/api/meili/keys/u-1", "/api/meili/dumps", "/api/meili/indexes", "/api/meili/indexes/products/settings", "/api/meili/swap-indexes"} {
		if w := request(s, "GET", path, "", c); w.Code != 404 {
			t.Fatalf("%s: want 404, got %d", path, w.Code)
		}
	}
	if w := request(s, "DELETE", "/api/meili/indexes/products", "", c); w.Code != 405 {
		t.Fatalf("delete: %d", w.Code)
	}
	if w := request(s, "GET", "/api/meili/indexes/products/search", "", c); w.Code != 405 {
		t.Fatalf("search via GET: %d", w.Code)
	}
}

func TestMeiliRequestOriginChecks(t *testing.T) {
	s, _, c := meiliServer(t, fakeMeiliKey)
	r := httptest.NewRequest("GET", "http://logs.example.test/api/meili/overview", nil)
	r.AddCookie(c)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("missing custom header: %d", w.Code)
	}
	r = httptest.NewRequest("POST", "http://logs.example.test/api/meili/indexes/products/search", strings.NewReader(`{}`))
	r.Header.Set("X-Requested-With", "logs-ui")
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(c)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("cross origin search: %d", w.Code)
	}
}

func TestMeiliErrorsNeverLeakKey(t *testing.T) {
	s, _, c := meiliServer(t, fakeMeiliKey)
	w := request(s, "GET", "/api/meili/indexes/leaky", "", c)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "[redacted]") {
		t.Fatalf("leaky: %d %s", w.Code, w.Body)
	}
	noLeak(t, w)
	w = request(s, "GET", "/api/meili/indexes/missing", "", c)
	if w.Code != 404 || !strings.Contains(w.Body.String(), "not found") {
		t.Fatalf("missing: %d %s", w.Code, w.Body)
	}
	// A wrong key must not look like an expired console session.
	s.meiliKey = "wrong-key-0123456789abcdef"
	w = request(s, "GET", "/api/meili/overview", "", c)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "invalid_key") || strings.Contains(w.Body.String(), s.meiliKey) {
		t.Fatalf("wrong key: %d %s", w.Code, w.Body)
	}
	// Unreachable upstream.
	s.meiliKey, s.meiliURL = fakeMeiliKey, "http://127.0.0.1:1"
	w = request(s, "GET", "/api/meili/keys", "", c)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "unreachable") {
		t.Fatalf("unreachable: %d %s", w.Code, w.Body)
	}
	noLeak(t, w)
}

func TestMeiliPagesAndURL(t *testing.T) {
	for path, want := range map[string]bool{"/meilisearch": true, "/meilisearch/tasks": true, "/meilisearch/keys": true,
		"/meilisearch/indexes/products": true, "/meilisearch/indexes/a.b": false, "/meilisearch/other": false, "/meilisearch/indexes/": false} {
		if meiliPage(path) != want {
			t.Fatalf("%s: %v", path, !want)
		}
	}
	for raw, ok := range map[string]bool{"http://meilisearch:7700": true, "https://m.example": true, "http://u:p@m:7700": false, "ftp://m": false, "http://m:7700/x": false, "http://m?x=1": false} {
		if (validMeiliURL(raw) == nil) != ok {
			t.Fatalf("%s: want ok=%v", raw, ok)
		}
	}
}

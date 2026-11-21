package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const fakeCIToken = "eyJhbGciOiJIUzI1NiJ9.fake-ci-token.signature-0123456789"

type fakeCI struct {
	mu       sync.Mutex
	requests []string
	bodies   []string
}

func (f *fakeCI) seen() ([]string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.requests...), append([]string{}, f.bodies...)
}

func (f *fakeCI) handler() http.Handler {
	pipeline := `{"number":7,"status":"running","event":"manual","branch":"release/1.2","commit":"abc1234def","message":"ship it\n\nbody","author":"octo","created":100,"started":110,"finished":0,"deploy_to":"","variables":{"DEPLOY_ENV":"production","REGION":"eu"},"forge_url":"https://github.com/octo/app/commit/abc","errors":[{"message":"deprecated key","is_warning":true}],"workflows":[{"id":3,"name":"build","state":"running","started":110,"finished":0,"error":"","children":[{"id":11,"name":"clone","state":"success","type":"clone","started":110,"finished":112,"exit_code":0,"error":""},{"id":12,"name":"deploy","state":"running","type":"commands","started":112,"finished":0,"exit_code":0,"error":""}]}]}`
	repo := `{"id":5,"forge_remote_id":"900","full_name":"octo/app","private":true,"active":true,"default_branch":"main","forge_url":"https://github.com/octo/app"}`
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.requests = append(f.requests, r.Method+" "+r.URL.RequestURI())
		f.bodies = append(f.bodies, string(body))
		f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+fakeCIToken {
			w.WriteHeader(401)
			_, _ = io.WriteString(w, "User not authorized")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/user":
			_, _ = io.WriteString(w, `{"id":1,"login":"octo","admin":true}`)
		case "GET /version":
			_, _ = io.WriteString(w, `{"source":"x","version":"3.20.1"}`)
		case "GET /api/user/repos":
			if r.URL.Query().Get("all") == "true" {
				_, _ = io.WriteString(w, `[`+repo+`,{"id":0,"forge_remote_id":"901","full_name":"octo/other","private":true,"active":false}]`)
				return
			}
			_, _ = io.WriteString(w, `[{"id":5,"forge_remote_id":"900","full_name":"octo/app","private":true,"active":true,"default_branch":"main","forge_url":"https://github.com/octo/app","last_pipeline":`+pipeline+`},{"id":6,"full_name":"octo/idle","active":false}]`)
		case "POST /api/repos":
			_, _ = io.WriteString(w, `{"id":9,"forge_remote_id":"901","full_name":"octo/other","private":true,"active":true,"default_branch":"main"}`)
		case "GET /api/repos/5":
			_, _ = io.WriteString(w, repo)
		case "GET /api/repos/5/branches":
			if r.URL.Query().Get("page") == "1" {
				names := make([]string, 50)
				for i := range names {
					names[i] = "b" + string(rune('a'+i%26)) + string(rune('a'+i/26))
				}
				data, _ := json.Marshal(names)
				_, _ = w.Write(data)
				return
			}
			_, _ = io.WriteString(w, `["main","release/1.2"]`)
		case "GET /api/repos/5/pipelines":
			_, _ = io.WriteString(w, `[`+pipeline+`]`)
		case "POST /api/repos/5/pipelines":
			_, _ = io.WriteString(w, pipeline)
		case "GET /api/repos/5/pipelines/7":
			_, _ = io.WriteString(w, pipeline)
		case "POST /api/repos/5/pipelines/7/cancel":
			w.WriteHeader(200)
		case "GET /api/repos/5/logs/7/12":
			line := func(text string) string { return base64.StdEncoding.EncodeToString([]byte(text)) }
			_, _ = io.WriteString(w, `[{"id":1,"step_id":12,"time":0,"line":0,"type":0,"data":"`+line("+ docker compose up -d")+`"},{"id":2,"step_id":12,"time":3,"line":1,"type":1,"data":"`+line("token "+fakeCIToken+" çıktı")+`"},{"id":3,"step_id":12,"time":4,"line":2,"type":0,"data":[111,107]}]`)
		case "POST /api/repos/5/pipelines/8/cancel":
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(400)
			_, _ = io.WriteString(w, "Cannot cancel a non-running or non-pending or non-blocked pipeline "+fakeCIToken)
		case "POST /api/repos/6/pipelines":
			w.WriteHeader(500)
			_, _ = io.WriteString(w, "could not load config from forge")
		default:
			w.WriteHeader(404)
			_, _ = io.WriteString(w, "not found")
		}
	})
}

func ciServer(t *testing.T, token string) (*server, *fakeCI, *http.Cookie) {
	t.Helper()
	fake := &fakeCI{}
	upstream := httptest.NewServer(fake.handler())
	t.Cleanup(upstream.Close)
	s := testServer(t, "http://localhost:9428", false)
	s.ciURL, s.ciToken, s.ciPublicURL = upstream.URL, token, "https://ci.example.test"
	return s, fake, signIn(t, s)
}

func ciNoLeak(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if strings.Contains(w.Body.String(), fakeCIToken) {
		t.Fatalf("token leaked: %s", w.Body)
	}
}

func TestCIRequiresSessionAndConfiguration(t *testing.T) {
	s, fake, c := ciServer(t, "")
	for _, path := range []string{"/api/ci/overview", "/api/ci/available", "/api/ci/repos/5", "/api/ci/repos/5/pipelines/7"} {
		if w := request(s, "GET", path, "", nil); w.Code != 401 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
	if w := request(s, "POST", "/api/ci/repos/5/pipelines", `{"branch":"main"}`, nil); w.Code != 401 {
		t.Fatalf("anonymous trigger: %d", w.Code)
	}
	if w := request(s, "GET", "/ci/repos/5", "", nil); w.Code != 303 || !strings.HasPrefix(w.Header().Get("Location"), "/login?next=") {
		t.Fatalf("page redirect: %d %s", w.Code, w.Header().Get("Location"))
	}
	w := request(s, "GET", "/api/ci/overview", "", c)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "not_configured") {
		t.Fatalf("not configured: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/ci", "", c); w.Code == 404 || w.Code == 401 {
		t.Fatalf("page not served: %d", w.Code)
	}
	if requests, _ := fake.seen(); len(requests) != 0 {
		t.Fatalf("upstream called: %v", requests)
	}
}

func TestCIOverviewRepoAndPipelineViews(t *testing.T) {
	s, _, c := ciServer(t, fakeCIToken)
	w := request(s, "GET", "/api/ci/overview", "", c)
	var overview struct {
		User, Version, URL string
		Repos              []struct {
			ID           int64
			FullName     string
			LastPipeline *struct {
				Number      int64
				Environment string
				Variables   map[string]string
				Workflows   []any
			}
		}
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &overview) != nil {
		t.Fatalf("overview: %d %s", w.Code, w.Body)
	}
	if overview.User != "octo" || overview.Version != "3.20.1" || overview.URL != "https://ci.example.test" || len(overview.Repos) != 1 {
		t.Fatalf("overview fields: %+v", overview)
	}
	last := overview.Repos[0].LastPipeline
	if last == nil || last.Environment != "production" || last.Variables["REGION"] != "eu" || len(last.Variables) != 1 || last.Workflows != nil {
		t.Fatalf("last pipeline: %+v", last)
	}

	w = request(s, "GET", "/api/ci/available", "", c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"forgeRemoteId":"901"`) || !strings.Contains(w.Body.String(), `"active":false`) {
		t.Fatalf("available: %d %s", w.Code, w.Body)
	}

	w = request(s, "GET", "/api/ci/repos/5", "", c)
	var page struct {
		Repo      struct{ DefaultBranch string }
		Branches  []string
		Pipelines []struct{ Number int64 }
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
		t.Fatalf("repo: %d %s", w.Code, w.Body)
	}
	// 50 from the first page plus 2 from the second: pagination is followed.
	if page.Repo.DefaultBranch != "main" || len(page.Branches) != 52 || page.Branches[51] != "release/1.2" || len(page.Pipelines) != 1 {
		t.Fatalf("repo page: %+v", page)
	}

	w = request(s, "GET", "/api/ci/repos/5/pipelines/7", "", c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"steps":[{"id":11,"name":"clone"`) || !strings.Contains(w.Body.String(), `"exitCode":0`) ||
		!strings.Contains(w.Body.String(), `"errors":[{"message":"deprecated key","isWarning":true}]`) {
		t.Fatalf("pipeline: %d %s", w.Code, w.Body)
	}
}

func TestCITriggerValidationAndForwarding(t *testing.T) {
	s, fake, c := ciServer(t, fakeCIToken)
	w := request(s, "POST", "/api/ci/repos/5/pipelines", `{"branch":"release/1.2","environment":"production","variables":{"REGION":"eu"}}`, c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"number":7`) {
		t.Fatalf("trigger: %d %s", w.Code, w.Body)
	}
	requests, bodies := fake.seen()
	var sent struct {
		Branch    string
		Variables map[string]string
	}
	if requests[0] != "POST /api/repos/5/pipelines" || json.Unmarshal([]byte(bodies[0]), &sent) != nil ||
		sent.Branch != "release/1.2" || sent.Variables["DEPLOY_ENV"] != "production" || sent.Variables["REGION"] != "eu" || len(sent.Variables) != 2 {
		t.Fatalf("forwarded: %v %v", requests, bodies)
	}
	for _, body := range []string{
		`{"branch":""}`, `{"branch":"main\nx"}`, `{"branch":"` + strings.Repeat("b", 256) + `"}`,
		`{"branch":"main","environment":"prod env"}`, `{"branch":"main","environment":"-prod"}`,
		`{"branch":"main","variables":{"CI_COMMIT_SHA":"x"}}`, `{"branch":"main","variables":{"woodpecker_x":"x"}}`,
		`{"branch":"main","variables":{"DEPLOY_ENV":"x"}}`, `{"branch":"main","variables":{"BAD NAME":"x"}}`,
		`{"branch":"main","variables":{"A":"` + strings.Repeat("v", 4097) + `"}}`,
		`{"branch":"main","unknown":true}`,
	} {
		if w := request(s, "POST", "/api/ci/repos/5/pipelines", body, c); w.Code != 400 {
			t.Fatalf("accepted %s: %d %s", body[:min(len(body), 60)], w.Code, w.Body)
		}
	}
	if requests, _ := fake.seen(); len(requests) != 1 {
		t.Fatalf("invalid triggers reached upstream: %v", requests)
	}
	// Without an environment no DEPLOY_ENV variable is sent.
	request(s, "POST", "/api/ci/repos/5/pipelines", `{"branch":"main","environment":"","variables":{}}`, c)
	if _, bodies := fake.seen(); strings.Contains(bodies[1], "DEPLOY_ENV") {
		t.Fatalf("empty environment forwarded: %s", bodies[1])
	}
}

func TestCIActivateCancelAndLogs(t *testing.T) {
	s, fake, c := ciServer(t, fakeCIToken)
	w := request(s, "POST", "/api/ci/repos", `{"forgeRemoteId":"901"}`, c)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"fullName":"octo/other"`) {
		t.Fatalf("activate: %d %s", w.Code, w.Body)
	}
	if requests, _ := fake.seen(); requests[0] != "POST /api/repos?forge_remote_id=901" {
		t.Fatalf("activate forwarded: %v", requests)
	}
	if w := request(s, "POST", "/api/ci/repos", `{"forgeRemoteId":"901&x=1"}`, c); w.Code != 400 {
		t.Fatalf("unsafe remote id: %d", w.Code)
	}
	if w := request(s, "POST", "/api/ci/repos/5/pipelines/7/cancel", "", c); w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("cancel: %d %s", w.Code, w.Body)
	}
	w = request(s, "GET", "/api/ci/repos/5/pipelines/7/steps/12/logs", "", c)
	var logs struct {
		Lines []struct {
			Line, Type int
			Text       string
		}
		Truncated bool
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &logs) != nil || len(logs.Lines) != 3 || logs.Truncated {
		t.Fatalf("logs: %d %s", w.Code, w.Body)
	}
	if logs.Lines[0].Text != "+ docker compose up -d" || logs.Lines[1].Type != 1 || logs.Lines[1].Text != "token [redacted] çıktı" || logs.Lines[2].Text != "ok" {
		t.Fatalf("log lines: %+v", logs.Lines)
	}
	ciNoLeak(t, w)
}

func TestCIErrorsNeverLeakTokenOrExpireSession(t *testing.T) {
	s, _, c := ciServer(t, fakeCIToken)
	w := request(s, "POST", "/api/ci/repos/5/pipelines/8/cancel", "", c)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "Cannot cancel") {
		t.Fatalf("upstream 400: %d %s", w.Code, w.Body)
	}
	ciNoLeak(t, w)
	if w := request(s, "POST", "/api/ci/repos/6/pipelines", `{"branch":"main"}`, c); w.Code != 502 || !strings.Contains(w.Body.String(), "could not load config") {
		t.Fatalf("upstream 500: %d %s", w.Code, w.Body)
	}
	if w := request(s, "GET", "/api/ci/repos/77", "", c); w.Code != 404 {
		t.Fatalf("missing repo: %d", w.Code)
	}
	// A rejected token must not look like an expired console session.
	s.ciToken = "wrong-token-000000000000"
	w = request(s, "GET", "/api/ci/overview", "", c)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "invalid_token") || strings.Contains(w.Body.String(), "wrong-token") {
		t.Fatalf("invalid token: %d %s", w.Code, w.Body)
	}
}

func TestCIRoutesMethodsAndOriginChecks(t *testing.T) {
	s, fake, c := ciServer(t, fakeCIToken)
	for path, want := range map[string]int{
		"/api/ci/unknown": 404, "/api/ci/repos/abc": 400, "/api/ci/repos/0": 400, "/api/ci/repos/5/secrets": 404,
		"/api/ci/repos/5/pipelines/7/steps/x/logs": 400, "/api/ci/repos/5/pipelines/7/steps/12": 404,
		"/api/ci/repos": 405, "/api/ci/repos/5/pipelines": 405, "/api/ci/repos/5/pipelines/7/cancel": 405,
	} {
		if w := request(s, "GET", path, "", c); w.Code != want {
			t.Fatalf("GET %s: %d, want %d", path, w.Code, want)
		}
	}
	for _, method := range []string{"DELETE", "PATCH", "PUT"} {
		if w := request(s, method, "/api/ci/repos/5", "", c); w.Code != 405 {
			t.Fatalf("%s repo: %d", method, w.Code)
		}
	}
	foreign := func(method, path, origin, header string) int {
		r := httptest.NewRequest(method, "http://logs.example.test"+path, strings.NewReader(`{"branch":"main"}`))
		r.Header.Set("Content-Type", "application/json")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if header != "" {
			r.Header.Set("X-Requested-With", header)
		}
		r.AddCookie(c)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	if code := foreign("POST", "/api/ci/repos/5/pipelines", "https://evil.example", "logs-ui"); code != 403 {
		t.Fatalf("cross-origin trigger: %d", code)
	}
	if code := foreign("POST", "/api/ci/repos/5/pipelines", "", "logs-ui"); code != 403 {
		t.Fatalf("trigger without origin: %d", code)
	}
	if code := foreign("GET", "/api/ci/overview", "", ""); code != 403 {
		t.Fatalf("GET without custom header: %d", code)
	}
	if requests, _ := fake.seen(); len(requests) != 0 {
		t.Fatalf("rejected requests reached upstream: %v", requests)
	}
}

func TestCIPagesAndURL(t *testing.T) {
	for path, want := range map[string]bool{
		"/ci": true, "/ci/repos/5": true, "/ci/repos/5/pipelines/7": true,
		"/ci/": false, "/ci/repos": false, "/ci/repos/x": false, "/ci/repos/5/pipelines": false, "/ci/repos/5/pipelines/7/x": false, "/cix": false,
	} {
		if ciPage(path) != want {
			t.Fatalf("ciPage(%q) = %v", path, !want)
		}
	}
	for raw, ok := range map[string]bool{"http://woodpecker-server:8000": true, "https://ci.example.test/": true,
		"ftp://x": false, "http://user:pw@x": false, "http://x/path": false, "http://x?y=1": false} {
		if (validCIURL(raw) == nil) != ok {
			t.Fatalf("validCIURL(%q)", raw)
		}
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// CI section backed by Woodpecker. The browser never talks to Woodpecker: every
// /api/ci/* route is allowlisted here and calls Woodpecker server-side with a
// personal API token, which never appears in a response, error or log line.
// The console can add repositories, start a manual pipeline on a branch with
// variables, read results and cancel; it cannot change pipeline definitions,
// secrets or repository settings.

const (
	ciTimeout      = 30 * time.Second
	ciBodyLimit    = 8 << 20
	ciLogBodyLimit = 16 << 20
	ciLogLines     = 5000
	ciLogBytes     = 2 << 20
	ciPageSize     = 50
	ciBranchPages  = 6
	ciEnvVariable  = "DEPLOY_ENV"
)

var (
	ciID          = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
	ciRemoteID    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	ciEnvironment = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)
	ciVariable    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	ciPagePath    = regexp.MustCompile(`^/ci(/repos/[1-9][0-9]{0,15}(/pipelines/[1-9][0-9]{0,15})?)?$`)
)

type ciError struct {
	status  int
	message string
	code    string
}

func (e *ciError) Error() string { return e.message }

func validCIURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("invalid WOODPECKER_URL")
	}
	return nil
}

// ciPage reports whether path is one of the client-side CI screens.
func ciPage(path string) bool { return ciPagePath.MatchString(path) }

func (s *server) ciScrub(data []byte) []byte {
	if s.ciToken == "" {
		return data
	}
	return bytes.ReplaceAll(data, []byte(s.ciToken), []byte("[redacted]"))
}

// ciCall performs one upstream request and decodes a successful JSON body into target.
func (s *server) ciCall(ctx context.Context, method, path string, query url.Values, body, target any, limit int64) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return &ciError{502, "Woodpecker isteği oluşturulamadı.", "request_failed"}
		}
		reader = bytes.NewReader(data)
	}
	endpoint := strings.TrimSuffix(s.ciURL, "/") + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return &ciError{502, "Woodpecker isteği oluşturulamadı.", "request_failed"}
	}
	req.Header.Set("Authorization", "Bearer "+s.ciToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.ciClient.Do(req)
	if err != nil {
		return &ciError{502, "Woodpecker'a ulaşılamıyor.", "unreachable"}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return &ciError{502, "Woodpecker yanıtı okunamadı veya çok büyük.", "invalid_response"}
	}
	data = s.ciScrub(data)
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		if target == nil || len(bytes.TrimSpace(data)) == 0 {
			return nil
		}
		if err := json.Unmarshal(data, target); err != nil {
			return &ciError{502, "Woodpecker yanıtı okunamadı.", "invalid_response"}
		}
		return nil
	}
	// Woodpecker answers errors as short plain text.
	detail := strings.Join(strings.Fields(string(data)), " ")
	if len(detail) > 300 {
		detail = detail[:300] + "…"
	}
	switch {
	case res.StatusCode == 401 || res.StatusCode == 403:
		// Never surface as 401: the browser would treat it as an expired session.
		return &ciError{502, "Woodpecker token'ı reddedildi; WOODPECKER_API_TOKEN değerini kontrol et.", "invalid_token"}
	case res.StatusCode == 404:
		return &ciError{404, "Woodpecker'da bulunamadı.", "not_found"}
	case res.StatusCode < 500:
		if detail == "" {
			detail = "Woodpecker isteği reddetti."
		}
		return &ciError{400, detail, "rejected"}
	default:
		message := "Woodpecker hata döndürdü (" + strconv.Itoa(res.StatusCode) + ")."
		if detail != "" {
			message += " " + detail
		}
		return &ciError{502, message, "upstream_error"}
	}
}

func ciFail(w http.ResponseWriter, err error) {
	if e, ok := err.(*ciError); ok {
		respond(w, e.status, map[string]string{"error": e.message, "code": e.code})
		return
	}
	respond(w, 502, map[string]string{"error": "Woodpecker isteği tamamlanamadı.", "code": "request_failed"})
}

// Upstream shapes (Woodpecker v3 API); only the fields the console shows.
type wpStep struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	State    string `json:"state"`
	Type     string `json:"type"`
	Started  int64  `json:"started"`
	Finished int64  `json:"finished"`
	ExitCode int    `json:"exit_code"`
	Error    string `json:"error"`
}

type wpWorkflow struct {
	ID       int64    `json:"id"`
	Name     string   `json:"name"`
	State    string   `json:"state"`
	Started  int64    `json:"started"`
	Finished int64    `json:"finished"`
	Error    string   `json:"error"`
	Children []wpStep `json:"children"`
}

type wpPipeline struct {
	Number    int64             `json:"number"`
	Status    string            `json:"status"`
	Event     string            `json:"event"`
	Branch    string            `json:"branch"`
	Commit    string            `json:"commit"`
	Message   string            `json:"message"`
	Author    string            `json:"author"`
	Created   int64             `json:"created"`
	Started   int64             `json:"started"`
	Finished  int64             `json:"finished"`
	DeployTo  string            `json:"deploy_to"`
	Variables map[string]string `json:"variables"`
	ForgeURL  string            `json:"forge_url"`
	Errors    []struct {
		Message   string `json:"message"`
		IsWarning bool   `json:"is_warning"`
	} `json:"errors"`
	Workflows []wpWorkflow `json:"workflows"`
}

type wpRepo struct {
	ID            int64       `json:"id"`
	ForgeRemoteID string      `json:"forge_remote_id"`
	FullName      string      `json:"full_name"`
	Private       bool        `json:"private"`
	Active        bool        `json:"active"`
	DefaultBranch string      `json:"default_branch"`
	ForgeURL      string      `json:"forge_url"`
	LastPipeline  *wpPipeline `json:"last_pipeline"`
}

type ciStepView struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	State    string `json:"state"`
	Type     string `json:"type"`
	Started  int64  `json:"started"`
	Finished int64  `json:"finished"`
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error"`
}

type ciWorkflowView struct {
	ID       int64        `json:"id"`
	Name     string       `json:"name"`
	State    string       `json:"state"`
	Started  int64        `json:"started"`
	Finished int64        `json:"finished"`
	Error    string       `json:"error"`
	Steps    []ciStepView `json:"steps"`
}

type ciIssue struct {
	Message   string `json:"message"`
	IsWarning bool   `json:"isWarning"`
}

type ciPipelineView struct {
	Number      int64             `json:"number"`
	Status      string            `json:"status"`
	Event       string            `json:"event"`
	Branch      string            `json:"branch"`
	Commit      string            `json:"commit"`
	Message     string            `json:"message"`
	Author      string            `json:"author"`
	Created     int64             `json:"created"`
	Started     int64             `json:"started"`
	Finished    int64             `json:"finished"`
	Environment string            `json:"environment"`
	Variables   map[string]string `json:"variables"`
	Errors      []ciIssue         `json:"errors"`
	ForgeURL    string            `json:"forgeUrl"`
	Workflows   []ciWorkflowView  `json:"workflows,omitempty"`
}

type ciRepoView struct {
	ID            int64           `json:"id"`
	FullName      string          `json:"fullName"`
	Private       bool            `json:"private"`
	DefaultBranch string          `json:"defaultBranch"`
	ForgeURL      string          `json:"forgeUrl"`
	LastPipeline  *ciPipelineView `json:"lastPipeline"`
}

func ciPipeline(p wpPipeline, withWorkflows bool) ciPipelineView {
	view := ciPipelineView{Number: p.Number, Status: p.Status, Event: p.Event, Branch: p.Branch, Commit: p.Commit,
		Message: p.Message, Author: p.Author, Created: p.Created, Started: p.Started, Finished: p.Finished,
		Environment: p.DeployTo, Variables: map[string]string{}, Errors: []ciIssue{}, ForgeURL: p.ForgeURL}
	for name, value := range p.Variables {
		if name == ciEnvVariable {
			view.Environment = value
		} else {
			view.Variables[name] = value
		}
	}
	for _, issue := range p.Errors {
		view.Errors = append(view.Errors, ciIssue{issue.Message, issue.IsWarning})
	}
	if withWorkflows {
		view.Workflows = make([]ciWorkflowView, 0, len(p.Workflows))
		for _, wf := range p.Workflows {
			steps := make([]ciStepView, 0, len(wf.Children))
			for _, step := range wf.Children {
				steps = append(steps, ciStepView(step))
			}
			view.Workflows = append(view.Workflows, ciWorkflowView{wf.ID, wf.Name, wf.State, wf.Started, wf.Finished, wf.Error, steps})
		}
	}
	return view
}

func ciRepo(r wpRepo) ciRepoView {
	view := ciRepoView{ID: r.ID, FullName: r.FullName, Private: r.Private, DefaultBranch: r.DefaultBranch, ForgeURL: r.ForgeURL}
	if r.LastPipeline != nil && r.LastPipeline.Number > 0 {
		last := ciPipeline(*r.LastPipeline, false)
		view.LastPipeline = &last
	}
	return view
}

type ciTrigger struct {
	Branch      string            `json:"branch"`
	Environment string            `json:"environment"`
	Variables   map[string]string `json:"variables"`
}

// variables validates a trigger and returns what Woodpecker injects into the steps.
func (in ciTrigger) variables() (map[string]string, error) {
	if in.Branch == "" || len(in.Branch) > 255 || strings.ContainsFunc(in.Branch, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return nil, &ciError{400, "Geçerli bir branch seç.", "invalid_branch"}
	}
	if in.Environment != "" && !ciEnvironment.MatchString(in.Environment) {
		return nil, &ciError{400, "Ortam adı harf, rakam, nokta, tire veya alt çizgi içerebilir (en fazla 64 karakter).", "invalid_environment"}
	}
	if len(in.Variables) > 20 {
		return nil, &ciError{400, "En fazla 20 değişken gönderilebilir.", "invalid_variables"}
	}
	out := map[string]string{}
	for name, value := range in.Variables {
		upper := strings.ToUpper(name)
		if !ciVariable.MatchString(name) || name == ciEnvVariable || strings.HasPrefix(upper, "CI_") || strings.HasPrefix(upper, "WOODPECKER_") {
			return nil, &ciError{400, "Geçersiz değişken adı: " + strconv.Quote(name) + ".", "invalid_variables"}
		}
		if len(value) > 4096 || strings.ContainsRune(value, 0) {
			return nil, &ciError{400, "Değişken değeri çok uzun veya geçersiz: " + name + ".", "invalid_variables"}
		}
		out[name] = value
	}
	if in.Environment != "" {
		out[ciEnvVariable] = in.Environment
	}
	return out, nil
}

func (s *server) ciAPI(w http.ResponseWriter, r *http.Request) {
	// Custom header (and Origin when sent) keeps cross-site pages out even for GETs;
	// POST always needs the full same-origin check.
	if r.Header.Get("X-Requested-With") != "logs-ui" || ((r.Method != "GET" || r.Header.Get("Origin") != "") && !s.sameOrigin(r)) {
		fail(w, 403, "Geçersiz istek kaynağı.")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/ci/"), "/")
	route, method := "", ""
	var repo, number, step string
	switch {
	case len(parts) == 1 && parts[0] == "overview":
		route, method = "overview", "GET"
	case len(parts) == 1 && parts[0] == "available":
		route, method = "available", "GET"
	case len(parts) == 1 && parts[0] == "repos":
		route, method = "activate", "POST"
	case len(parts) >= 2 && parts[0] == "repos":
		repo = parts[1]
		switch {
		case len(parts) == 2:
			route, method = "repo", "GET"
		case len(parts) == 3 && parts[2] == "pipelines":
			route, method = "trigger", "POST"
		case len(parts) == 4 && parts[2] == "pipelines":
			route, method, number = "pipeline", "GET", parts[3]
		case len(parts) == 5 && parts[2] == "pipelines" && parts[4] == "cancel":
			route, method, number = "cancel", "POST", parts[3]
		case len(parts) == 7 && parts[2] == "pipelines" && parts[4] == "steps" && parts[6] == "logs":
			route, method, number, step = "logs", "GET", parts[3], parts[5]
		}
	}
	if route == "" {
		http.NotFound(w, r)
		return
	}
	for _, id := range []string{repo, number, step} {
		if id != "" && !ciID.MatchString(id) {
			fail(w, 400, "Geçersiz kimlik.")
			return
		}
	}
	if r.Method != method {
		fail(w, 405, "Bu yöntem desteklenmiyor.")
		return
	}
	if s.ciToken == "" {
		respond(w, 503, map[string]string{"error": "CI bu konsol için yapılandırılmamış (WOODPECKER_API_TOKEN yok).", "code": "not_configured"})
		return
	}
	select {
	case s.ciSlots <- struct{}{}:
		defer func() { <-s.ciSlots }()
	case <-r.Context().Done():
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ciTimeout)
	defer cancel()
	base := "/api/repos/" + repo
	var result any
	var err error
	switch route {
	case "overview":
		result, err = s.ciOverview(ctx)
	case "available":
		result, err = s.ciAvailable(ctx)
	case "activate":
		var input struct {
			ForgeRemoteID string `json:"forgeRemoteId"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !ciRemoteID.MatchString(input.ForgeRemoteID) {
			fail(w, 400, "Geçersiz repo kimliği.")
			return
		}
		var activated wpRepo
		if err = s.ciCall(ctx, "POST", "/api/repos", url.Values{"forge_remote_id": {input.ForgeRemoteID}}, nil, &activated, ciBodyLimit); err == nil {
			log.Printf("ci repo added id=%d name=%q", activated.ID, activated.FullName)
			result = ciRepo(activated)
		}
	case "repo":
		result, err = s.ciRepoPage(ctx, base)
	case "trigger":
		var input ciTrigger
		if !decode(w, r, &input) {
			return
		}
		variables, invalid := input.variables()
		if invalid != nil {
			ciFail(w, invalid)
			return
		}
		var started wpPipeline
		body := map[string]any{"branch": input.Branch, "variables": variables}
		if err = s.ciCall(ctx, "POST", base+"/pipelines", nil, body, &started, ciBodyLimit); err == nil {
			// Names only: variable values may be sensitive.
			log.Printf("ci pipeline started repo=%s number=%d branch=%q environment=%q variables=%d", repo, started.Number, input.Branch, input.Environment, len(input.Variables))
			result = ciPipeline(started, false)
		}
	case "pipeline":
		var info wpRepo
		var pipeline wpPipeline
		if err = s.ciCall(ctx, "GET", base, nil, nil, &info, ciBodyLimit); err == nil {
			err = s.ciCall(ctx, "GET", base+"/pipelines/"+number, nil, nil, &pipeline, ciBodyLimit)
		}
		result = map[string]any{"repo": ciRepo(info), "pipeline": ciPipeline(pipeline, true)}
	case "cancel":
		if err = s.ciCall(ctx, "POST", base+"/pipelines/"+number+"/cancel", nil, nil, nil, ciBodyLimit); err == nil {
			log.Printf("ci pipeline canceled repo=%s number=%s", repo, number)
			result = map[string]bool{"ok": true}
		}
	case "logs":
		result, err = s.ciLogs(ctx, base+"/logs/"+number+"/"+step)
	}
	if err != nil {
		ciFail(w, err)
		return
	}
	respond(w, 200, result)
}

func (s *server) ciOverview(ctx context.Context) (any, error) {
	var user struct {
		Login string `json:"login"`
	}
	var version struct {
		Version string `json:"version"`
	}
	var repos []wpRepo
	if err := s.ciCall(ctx, "GET", "/api/user", nil, nil, &user, ciBodyLimit); err != nil {
		return nil, err
	}
	// Optional: the version endpoint sits outside /api and may be filtered by a proxy.
	_ = s.ciCall(ctx, "GET", "/version", nil, nil, &version, ciBodyLimit)
	if err := s.ciCall(ctx, "GET", "/api/user/repos", nil, nil, &repos, ciBodyLimit); err != nil {
		return nil, err
	}
	views := make([]ciRepoView, 0, len(repos))
	for _, repo := range repos {
		if repo.Active {
			views = append(views, ciRepo(repo))
		}
	}
	return map[string]any{"user": user.Login, "version": version.Version, "url": s.ciPublicURL, "repos": views}, nil
}

func (s *server) ciAvailable(ctx context.Context) (any, error) {
	var repos []wpRepo
	// all=true asks the forge for every repository the token's user can reach.
	if err := s.ciCall(ctx, "GET", "/api/user/repos", url.Values{"all": {"true"}}, nil, &repos, ciBodyLimit); err != nil {
		return nil, err
	}
	type available struct {
		ForgeRemoteID string `json:"forgeRemoteId"`
		FullName      string `json:"fullName"`
		Private       bool   `json:"private"`
		Active        bool   `json:"active"`
		ID            int64  `json:"id"`
	}
	views := make([]available, 0, len(repos))
	for _, repo := range repos {
		views = append(views, available{repo.ForgeRemoteID, repo.FullName, repo.Private, repo.Active, repo.ID})
	}
	return map[string]any{"repos": views}, nil
}

func (s *server) ciRepoPage(ctx context.Context, base string) (any, error) {
	var info wpRepo
	if err := s.ciCall(ctx, "GET", base, nil, nil, &info, ciBodyLimit); err != nil {
		return nil, err
	}
	branches := []string{}
	for page := 1; page <= ciBranchPages; page++ {
		var batch []string
		query := url.Values{"page": {strconv.Itoa(page)}, "perPage": {strconv.Itoa(ciPageSize)}}
		if err := s.ciCall(ctx, "GET", base+"/branches", query, nil, &batch, ciBodyLimit); err != nil {
			return nil, err
		}
		branches = append(branches, batch...)
		if len(batch) < ciPageSize {
			break
		}
	}
	var pipelines []wpPipeline
	if err := s.ciCall(ctx, "GET", base+"/pipelines", url.Values{"perPage": {"25"}}, nil, &pipelines, ciBodyLimit); err != nil {
		return nil, err
	}
	views := make([]ciPipelineView, 0, len(pipelines))
	for _, pipeline := range pipelines {
		views = append(views, ciPipeline(pipeline, false))
	}
	return map[string]any{"repo": ciRepo(info), "branches": branches, "pipelines": views}, nil
}

type ciLogLine struct {
	Line int    `json:"line"`
	Time int64  `json:"time"`
	Type int    `json:"type"`
	Text string `json:"text"`
}

func (s *server) ciLogs(ctx context.Context, path string) (any, error) {
	var entries []struct {
		Line int             `json:"line"`
		Time int64           `json:"time"`
		Type int             `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if err := s.ciCall(ctx, "GET", path, nil, nil, &entries, ciLogBodyLimit); err != nil {
		return nil, err
	}
	// Keep the newest lines: the end of a failing step is what matters.
	truncated := len(entries) > ciLogLines
	if truncated {
		entries = entries[len(entries)-ciLogLines:]
	}
	lines := make([]ciLogLine, 0, len(entries))
	size := 0
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		text := ciLogText(entry.Data)
		if size += len(text); size > ciLogBytes {
			truncated = true
			break
		}
		lines = append(lines, ciLogLine{entry.Line, entry.Time, entry.Type, string(s.ciScrub([]byte(text)))})
	}
	for i, j := 0, len(lines)-1; i < j; i, j = i+1, j-1 {
		lines[i], lines[j] = lines[j], lines[i]
	}
	return map[string]any{"lines": lines, "truncated": truncated}, nil
}

// ciLogText decodes a log entry payload: base64 (Go []byte), or a byte array.
func ciLogText(raw json.RawMessage) string {
	var encoded string
	if json.Unmarshal(raw, &encoded) == nil {
		if data, err := base64.StdEncoding.DecodeString(encoded); err == nil {
			return strings.ToValidUTF8(string(data), "�")
		}
		return encoded
	}
	var numbers []int
	if json.Unmarshal(raw, &numbers) == nil {
		data := make([]byte, 0, len(numbers))
		for _, n := range numbers {
			data = append(data, byte(n))
		}
		return strings.ToValidUTF8(string(data), "�")
	}
	return ""
}

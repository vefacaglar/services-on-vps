package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Read-only Meilisearch views. The browser never talks to Meilisearch: every
// /api/meili/* route is allowlisted here and calls Meilisearch server-side with
// the master key, which never appears in a response, error or log line.

const (
	meiliTimeout   = 10 * time.Second
	meiliBodyLimit = 8 << 20
	meiliPageLimit = 100
)

var (
	meiliUID      = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,400}$`)
	meiliTaskType = regexp.MustCompile(`^[a-zA-Z]{1,64}$`)
	meiliStatuses = map[string]bool{"enqueued": true, "processing": true, "succeeded": true, "failed": true, "canceled": true}
)

type meiliError struct {
	status  int
	message string
	code    string
}

func (e *meiliError) Error() string { return e.message }

func validMeiliURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("invalid MEILISEARCH_URL")
	}
	return nil
}

func (s *server) scrub(data []byte) []byte {
	if s.meiliKey == "" {
		return data
	}
	return bytes.ReplaceAll(data, []byte(s.meiliKey), []byte("[redacted]"))
}

// meiliCall performs one upstream request and returns the scrubbed body.
func (s *server) meiliCall(ctx context.Context, method, path string, query url.Values, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	target := strings.TrimSuffix(s.meiliURL, "/") + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, &meiliError{502, "Meilisearch isteği oluşturulamadı.", "request_failed"}
	}
	req.Header.Set("Authorization", "Bearer "+s.meiliKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.meiliClient.Do(req)
	if err != nil {
		return nil, &meiliError{502, "Meilisearch'e ulaşılamıyor.", "unreachable"}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, meiliBodyLimit+1))
	if err != nil || len(data) > meiliBodyLimit {
		return nil, &meiliError{502, "Meilisearch yanıtı okunamadı veya çok büyük.", "invalid_response"}
	}
	data = s.scrub(data)
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return data, nil
	}
	var upstream struct{ Message, Code string }
	_ = json.Unmarshal(data, &upstream)
	message := upstream.Message
	if len(message) > 600 {
		message = message[:600] + "…"
	}
	switch {
	case res.StatusCode == 401 || res.StatusCode == 403:
		// Never surface as 401: the browser would treat it as an expired session.
		return nil, &meiliError{502, "Meilisearch anahtarı reddedildi; MEILI_MASTER_KEY değerini kontrol et.", "invalid_key"}
	case res.StatusCode == 404:
		if message == "" {
			message = "Bulunamadı."
		}
		return nil, &meiliError{404, message, upstream.Code}
	case res.StatusCode >= 400 && res.StatusCode < 500:
		if message == "" {
			message = "Meilisearch isteği reddetti."
		}
		return nil, &meiliError{400, message, upstream.Code}
	default:
		return nil, &meiliError{502, "Meilisearch hata döndürdü (" + strconv.Itoa(res.StatusCode) + ").", upstream.Code}
	}
}

func meiliFail(w http.ResponseWriter, err error) {
	if e, ok := err.(*meiliError); ok {
		respond(w, e.status, map[string]string{"error": e.message, "code": e.code})
		return
	}
	respond(w, 502, map[string]string{"error": "Meilisearch isteği tamamlanamadı.", "code": "request_failed"})
}

func intParam(q url.Values, name string, fallback, lo, hi int) (int, bool) {
	raw := q.Get(name)
	if raw == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(raw)
	return n, err == nil && n >= lo && n <= hi
}

func (s *server) meiliAPI(w http.ResponseWriter, r *http.Request) {
	// Custom header (and Origin when sent) keeps cross-site pages out even for GETs;
	// POST always needs the full same-origin check.
	if r.Header.Get("X-Requested-With") != "logs-ui" || ((r.Method != "GET" || r.Header.Get("Origin") != "") && !s.sameOrigin(r)) {
		fail(w, 403, "Geçersiz istek kaynağı.")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/meili/")
	parts := strings.Split(rest, "/")
	route, uid := rest, ""
	if parts[0] == "indexes" && len(parts) >= 2 && len(parts) <= 3 {
		uid = parts[1]
		route = "index"
		if len(parts) == 3 {
			route = "index/" + parts[2]
		}
		if !meiliUID.MatchString(uid) {
			fail(w, 400, "Geçersiz index adı.")
			return
		}
	}
	method := map[string]string{"overview": "GET", "tasks": "GET", "keys": "GET", "index": "GET",
		"index/documents": "GET", "index/search": "POST"}[route]
	if method == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != method {
		fail(w, 405, "Bu yöntem desteklenmiyor.")
		return
	}
	if s.meiliKey == "" {
		respond(w, 503, map[string]string{"error": "Meilisearch bu konsol için yapılandırılmamış (MEILI_MASTER_KEY yok).", "code": "not_configured"})
		return
	}
	select {
	case s.meiliSlots <- struct{}{}:
		defer func() { <-s.meiliSlots }()
	case <-r.Context().Done():
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), meiliTimeout)
	defer cancel()
	var result any
	var err error
	switch route {
	case "overview":
		result, err = s.meiliOverview(ctx)
	case "tasks":
		result, err = s.meiliTasks(ctx, r.URL.Query())
	case "keys":
		result, err = s.meiliKeys(ctx)
	case "index":
		result, err = s.meiliIndex(ctx, uid)
	case "index/documents":
		result, err = s.meiliDocuments(ctx, uid, r.URL.Query())
	case "index/search":
		var input meiliSearch
		if !decode(w, r, &input) {
			return
		}
		result, err = s.meiliSearchIndex(ctx, uid, input)
	}
	if err != nil {
		meiliFail(w, err)
		return
	}
	respond(w, 200, result)
}

func (s *server) meiliOverview(ctx context.Context) (any, error) {
	var version struct {
		PkgVersion string `json:"pkgVersion"`
	}
	var health struct {
		Status string `json:"status"`
	}
	var stats struct {
		DatabaseSize     int64                      `json:"databaseSize"`
		UsedDatabaseSize int64                      `json:"usedDatabaseSize"`
		LastUpdate       *string                    `json:"lastUpdate"`
		Indexes          map[string]json.RawMessage `json:"indexes"`
	}
	var indexes struct {
		Results []map[string]any `json:"results"`
		Total   int              `json:"total"`
	}
	var features map[string]any
	calls := []struct {
		path   string
		query  url.Values
		target any
	}{
		{"/version", nil, &version}, {"/health", nil, &health}, {"/stats", nil, &stats},
		{"/indexes", url.Values{"limit": {"1000"}}, &indexes}, {"/experimental-features", nil, &features},
	}
	for _, call := range calls {
		data, err := s.meiliCall(ctx, "GET", call.path, call.query, nil)
		if err != nil {
			if call.path == "/experimental-features" {
				continue // Optional; older keys or versions may refuse it.
			}
			return nil, err
		}
		if err := json.Unmarshal(data, call.target); err != nil {
			return nil, &meiliError{502, "Meilisearch yanıtı okunamadı.", "invalid_response"}
		}
	}
	rows := make([]map[string]any, 0, len(indexes.Results))
	for _, index := range indexes.Results {
		uid, _ := index["uid"].(string)
		row := map[string]any{"uid": uid, "primaryKey": index["primaryKey"], "createdAt": index["createdAt"], "updatedAt": index["updatedAt"]}
		var st map[string]any
		if raw, ok := stats.Indexes[uid]; ok && json.Unmarshal(raw, &st) == nil {
			for _, key := range []string{"numberOfDocuments", "indexSize", "isIndexing", "numberOfEmbeddedDocuments"} {
				row[key] = st[key]
			}
		}
		rows = append(rows, row)
	}
	return map[string]any{"version": version.PkgVersion, "health": health.Status, "databaseSize": stats.DatabaseSize,
		"usedDatabaseSize": stats.UsedDatabaseSize, "lastUpdate": stats.LastUpdate, "indexes": rows,
		"totalIndexes": indexes.Total, "features": features}, nil
}

func (s *server) meiliTasks(ctx context.Context, q url.Values) (any, error) {
	params := url.Values{}
	limit, ok := intParam(q, "limit", 20, 1, meiliPageLimit)
	if !ok {
		return nil, &meiliError{400, "Geçersiz limit.", "invalid_limit"}
	}
	params.Set("limit", strconv.Itoa(limit))
	if raw := q.Get("from"); raw != "" {
		if n, err := strconv.ParseUint(raw, 10, 32); err != nil {
			return nil, &meiliError{400, "Geçersiz başlangıç görevi.", "invalid_from"}
		} else {
			params.Set("from", strconv.FormatUint(n, 10))
		}
	}
	lists := map[string]func(string) bool{
		"statuses":  func(v string) bool { return meiliStatuses[v] },
		"types":     meiliTaskType.MatchString,
		"indexUids": meiliUID.MatchString,
	}
	for name, valid := range lists {
		raw := q.Get(name)
		if raw == "" {
			continue
		}
		values := strings.Split(raw, ",")
		if len(values) > 20 {
			return nil, &meiliError{400, "Çok fazla filtre değeri.", "invalid_filter"}
		}
		for _, v := range values {
			if !valid(v) {
				return nil, &meiliError{400, "Geçersiz görev filtresi: " + name + ".", "invalid_filter"}
			}
		}
		params.Set(name, raw)
	}
	data, err := s.meiliCall(ctx, "GET", "/tasks", params, nil)
	return data, err
}

type meiliKeyView struct {
	Name        *string  `json:"name"`
	Description *string  `json:"description"`
	UID         string   `json:"uid"`
	KeyPrefix   string   `json:"keyPrefix"`
	Actions     []string `json:"actions"`
	Indexes     []string `json:"indexes"`
	ExpiresAt   *string  `json:"expiresAt"`
	CreatedAt   string   `json:"createdAt"`
	UpdatedAt   string   `json:"updatedAt"`
}

func (s *server) meiliKeys(ctx context.Context) (any, error) {
	data, err := s.meiliCall(ctx, "GET", "/keys", url.Values{"limit": {"200"}}, nil)
	if err != nil {
		return nil, err
	}
	var keys struct {
		Results []struct {
			meiliKeyView
			Key string `json:"key"`
		} `json:"results"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, &meiliError{502, "Meilisearch yanıtı okunamadı.", "invalid_response"}
	}
	views := make([]meiliKeyView, 0, len(keys.Results))
	for _, k := range keys.Results {
		view := k.meiliKeyView
		// Only a short prefix for recognition; full keys never leave the server.
		view.KeyPrefix = k.Key
		if len(view.KeyPrefix) > 8 {
			view.KeyPrefix = view.KeyPrefix[:8]
		}
		views = append(views, view)
	}
	return map[string]any{"results": views, "total": keys.Total}, nil
}

func (s *server) meiliIndex(ctx context.Context, uid string) (any, error) {
	out := map[string]json.RawMessage{}
	base := "/indexes/" + uid
	// Fixed order: a missing index fails on the first call with its 404.
	for _, part := range []struct{ name, path string }{{"index", base}, {"stats", base + "/stats"}, {"settings", base + "/settings"}} {
		data, err := s.meiliCall(ctx, "GET", part.path, nil, nil)
		if err != nil {
			return nil, err
		}
		out[part.name] = data
	}
	return out, nil
}

func (s *server) meiliDocuments(ctx context.Context, uid string, q url.Values) (any, error) {
	limit, ok1 := intParam(q, "limit", 20, 1, meiliPageLimit)
	offset, ok2 := intParam(q, "offset", 0, 0, 1000000)
	if !ok1 || !ok2 || len(q.Get("filter")) > 2048 || len(q.Get("fields")) > 1024 {
		return nil, &meiliError{400, "Geçersiz sayfa veya filtre.", "invalid_params"}
	}
	params := url.Values{"limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}
	for _, name := range []string{"filter", "fields"} {
		if v := strings.TrimSpace(q.Get(name)); v != "" {
			params.Set(name, v)
		}
	}
	return s.meiliCall(ctx, "GET", "/indexes/"+uid+"/documents", params, nil)
}

type meiliSearch struct {
	Q      string   `json:"q"`
	Filter string   `json:"filter"`
	Sort   []string `json:"sort"`
	Facets []string `json:"facets"`
	Limit  int      `json:"limit"`
	Offset int      `json:"offset"`
}

func (s *server) meiliSearchIndex(ctx context.Context, uid string, in meiliSearch) (any, error) {
	if in.Limit == 0 {
		in.Limit = 20
	}
	if len(in.Q) > 1024 || len(in.Filter) > 2048 || len(in.Sort) > 10 || len(in.Facets) > 20 ||
		in.Limit < 1 || in.Limit > meiliPageLimit || in.Offset < 0 || in.Offset > 10000 {
		return nil, &meiliError{400, "Geçersiz arama isteği.", "invalid_params"}
	}
	for _, v := range append(append([]string{}, in.Sort...), in.Facets...) {
		if len(v) == 0 || len(v) > 256 {
			return nil, &meiliError{400, "Geçersiz sıralama veya facet.", "invalid_params"}
		}
	}
	body := map[string]any{"q": in.Q, "limit": in.Limit, "offset": in.Offset}
	if strings.TrimSpace(in.Filter) != "" {
		body["filter"] = in.Filter
	}
	if len(in.Sort) > 0 {
		body["sort"] = in.Sort
	}
	if len(in.Facets) > 0 {
		body["facets"] = in.Facets
	}
	return s.meiliCall(ctx, "POST", "/indexes/"+uid+"/search", nil, body)
}

// meiliPage reports whether path is one of the client-side Meilisearch screens.
func meiliPage(path string) bool {
	switch path {
	case "/meilisearch", "/meilisearch/tasks", "/meilisearch/keys":
		return true
	}
	uid, ok := strings.CutPrefix(path, "/meilisearch/indexes/")
	return ok && meiliUID.MatchString(uid)
}

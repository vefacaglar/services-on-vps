package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	apiID    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	workerID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	idleID   = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	nestedID = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeGroup(t *testing.T, dir string, current, inactive, file uint64, max string, usage uint64) {
	t.Helper()
	writeFile(t, filepath.Join(dir, "memory.current"), fmt.Sprintf("%d\n", current))
	writeFile(t, filepath.Join(dir, "memory.stat"), fmt.Sprintf("anon 1\nfile %d\nactive_file 5\ninactive_file %d\n", file, inactive))
	writeFile(t, filepath.Join(dir, "memory.max"), max+"\n")
	writeFile(t, filepath.Join(dir, "cpu.stat"), fmt.Sprintf("usage_usec %d\nuser_usec 1\nsystem_usec 1\n", usage))
}

const fakeMeminfo = `MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    5000000 kB
Buffers:          100000 kB
Cached:          3000000 kB
SwapCached:            0 kB
Shmem:            200000 kB
SReclaimable:     300000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
`

func fakeHost(t *testing.T) (cgroup, meminfo string) {
	t.Helper()
	dir := t.TempDir()
	cgroup = filepath.Join(dir, "cgroup")
	meminfo = filepath.Join(dir, "meminfo")
	writeFile(t, meminfo, fakeMeminfo)
	writeFile(t, filepath.Join(cgroup, "cgroup.controllers"), "cpu memory pids\n")
	sys := filepath.Join(cgroup, "system.slice")
	fakeGroup(t, filepath.Join(sys, "docker-"+apiID+".scope"), 600<<20, 100<<20, 150<<20, "max", 1_000_000)
	fakeGroup(t, filepath.Join(sys, "docker-"+workerID+".scope"), 900<<20, 50<<20, 60<<20, "1073741824", 2_000_000)
	fakeGroup(t, filepath.Join(sys, "docker-"+idleID+".scope"), 10<<20, 10<<20, 10<<20, "max", 0)
	fakeGroup(t, filepath.Join(sys, "docker.service"), 120<<20, 20<<20, 30<<20, "max", 5_000_000)
	fakeGroup(t, filepath.Join(sys, "system-getty.slice", "getty@tty1.service"), 2<<20, 0, 0, "max", 1)
	// Nested container from the cgroupfs driver; the service cgroup itself is
	// charged only for its own processes.
	fakeGroup(t, filepath.Join(cgroup, "docker", nestedID), 50<<20, 0, 0, "max", 10)
	fakeGroup(t, filepath.Join(cgroup, "user.slice"), 40<<20, 10<<20, 20<<20, "max", 10)
	fakeGroup(t, filepath.Join(cgroup, "init.scope"), 8<<20, 0, 1<<20, "max", 10)
	return cgroup, meminfo
}

type systemResponse struct {
	Memory          memorySummary
	Disk            *diskSummary
	Groups          []map[string]any
	Accounted       uint64
	CgroupAvailable bool
	SampledAt       string
}

func getSystem(t *testing.T, s *server, c *http.Cookie) systemResponse {
	t.Helper()
	w := request(s, "GET", "/api/system", "", c)
	if w.Code != 200 {
		t.Fatalf("system: %d %s", w.Code, w.Body)
	}
	var result systemResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSystemReportsHostMemoryAndApps(t *testing.T) {
	var lookups atomic.Int32
	var metrics atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			metrics.Add(1)
			fmt.Fprint(w, "# HELP vl_data_size_bytes x\nvl_data_size_bytes{type=\"indexdb\"} 1000\nvl_data_size_bytes{type=\"storage\"} 2.5e3\nvl_data_size_bytes_total 7\nvl_compressed_data_size_bytes{type=\"storage/big\"} 9\n")
			return
		}
		lookups.Add(1)
		if err := r.ParseForm(); err != nil || r.Form.Get("query") != containerNamesQuery {
			t.Errorf("unexpected name query: %q", r.Form.Get("query"))
		}
		fmt.Fprintf(w, "{\"container_id\":%q,\"container_name\":\"api-old\",\"compose_service\":\"api\",\"compose_project\":\"site\",\"t\":\"2026-11-01T10:00:00Z\"}\n", apiID)
		fmt.Fprintf(w, "{\"container_id\":%q,\"container_name\":\"/api-blue\",\"compose_service\":\"api\",\"compose_project\":\"site\",\"t\":\"2026-11-01T10:00:00.5Z\"}\n", apiID)
		fmt.Fprintf(w, "{\"container_id\":%q,\"container_name\":\"worker\",\"compose_service\":\"worker\",\"compose_project\":\"site\",\"t\":\"2026-11-01T09:00:00Z\"}\n", workerID)
	}))
	defer upstream.Close()
	s := testServer(t, upstream.URL, false)
	s.cgroupRoot, s.meminfoPath = fakeHost(t)
	s.diskPath = t.TempDir()
	if code := request(s, "GET", "/api/system", "", nil).Code; code != 401 {
		t.Fatalf("anonymous system access: %d", code)
	}
	c := signIn(t, s)
	if code := request(s, "POST", "/api/system", `{}`, c).Code; code != 405 {
		t.Fatalf("POST system: %d", code)
	}
	if w := request(s, "GET", "/system", "", c); w.Code != 200 || !strings.Contains(w.Body.String(), `id="root"`) {
		t.Fatal("system page route failed")
	}
	first := getSystem(t, s, c)
	m := first.Memory
	if m.Total != 8000000*1024 || m.Available != 5000000*1024 || m.Used != 3000000*1024 || m.Free != 1000000*1024 ||
		m.Buffers != 100000*1024 || m.Cached != 3100000*1024 || m.SwapTotal != 2000000*1024 || m.SwapUsed != 500000*1024 {
		t.Fatalf("meminfo: %+v", m)
	}
	if d := first.Disk; d == nil || d.Total == 0 || d.Used+d.Free != d.Total || d.Available > d.Free || d.LogData == nil || *d.LogData != 3500 {
		t.Fatalf("disk: %+v", first.Disk)
	}
	if !first.CgroupAvailable {
		t.Fatal("cgroup not detected")
	}
	var names []string
	var accounted uint64
	byName := map[string]map[string]any{}
	for _, g := range first.Groups {
		name := g["name"].(string)
		names = append(names, name)
		byName[name] = g
		accounted += uint64(g["memory"].(float64))
		if g["cpu"] != nil {
			t.Fatalf("first sample must have null cpu: %v", g)
		}
	}
	want := "worker,api-blue,docker,container " + nestedID[:12] + ",user.slice,init.scope,getty@tty1"
	if strings.Join(names, ",") != want {
		t.Fatalf("groups: %s", strings.Join(names, ","))
	}
	if accounted != first.Accounted {
		t.Fatal("accounted mismatch")
	}
	api := byName["api-blue"]
	if api["memory"].(float64) != 500<<20 || api["cache"].(float64) != 150<<20 || api["limit"] != nil ||
		api["kind"] != "container" || api["project"] != "site" || api["service"] != "api" || api["id"] != apiID {
		t.Fatalf("api group: %v", api)
	}
	if byName["worker"]["limit"].(float64) != 1<<30 {
		t.Fatal("numeric limit not reported")
	}
	if byName["docker"]["kind"] != "service" || byName["user.slice"]["kind"] != "other" || byName["getty@tty1"]["kind"] != "service" {
		t.Fatal("kinds")
	}

	// Second sample: CPU percent from usage delta over wall time.
	time.Sleep(10 * time.Millisecond)
	s.sys.mu.Lock()
	for path, sample := range s.sys.cpu {
		sample.at = sample.at.Add(-2 * time.Second)
		s.sys.cpu[path] = sample
	}
	s.sys.mu.Unlock()
	fakeGroup(t, filepath.Join(s.cgroupRoot, "system.slice", "docker.service"), 120<<20, 20<<20, 30<<20, "max", 6_000_000)
	second := getSystem(t, s, c)
	for _, g := range second.Groups {
		if g["name"] == "docker" {
			cpu, ok := g["cpu"].(float64)
			if !ok || cpu < 45 || cpu > 51 {
				t.Fatalf("docker cpu: %v", g["cpu"])
			}
		}
	}
	if metrics.Load() != 1 {
		t.Fatalf("metrics not cached: %d", metrics.Load())
	}
	if lookups.Load() != 1 {
		t.Fatalf("names not cached: %d lookups", lookups.Load())
	}
}

func TestSystemWithoutCgroupOrNames(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "down", 500) }))
	defer upstream.Close()
	s := testServer(t, upstream.URL, false)
	cgroup, meminfo := fakeHost(t)
	c := signIn(t, s)

	s.cgroupRoot, s.meminfoPath = filepath.Join(t.TempDir(), "missing"), meminfo
	s.diskPath = filepath.Join(t.TempDir(), "missing")
	result := getSystem(t, s, c)
	if result.Disk != nil {
		t.Fatal("unreadable disk path must be null")
	}
	s.diskPath = t.TempDir()
	if result = getSystem(t, s, c); result.Disk == nil || result.Disk.Total == 0 || result.Disk.LogData != nil {
		t.Fatalf("metrics failure must give null logData: %+v", result.Disk)
	}
	if result.CgroupAvailable || len(result.Groups) != 0 || result.Memory.Total == 0 {
		t.Fatalf("missing cgroup: %+v", result)
	}
	s.meminfoPath = filepath.Join(t.TempDir(), "missing")
	if result = getSystem(t, s, c); result.Memory.Total != 0 || result.Groups == nil {
		t.Fatalf("missing meminfo: %+v", result)
	}

	// Name lookup failure falls back to short ids instead of failing.
	s.cgroupRoot, s.meminfoPath = cgroup, meminfo
	result = getSystem(t, s, c)
	if !result.CgroupAvailable || result.Groups[0]["name"] != "container "+workerID[:12] {
		t.Fatalf("fallback names: %v", result.Groups[0])
	}
}

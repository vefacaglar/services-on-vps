package main

import (
	"bufio"
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Read-only view of host memory and per-app cgroup usage. The browser container
// gets the host cgroup v2 tree as a read-only bind mount; no Docker socket.

const (
	cgroupWalkDepth  = 4
	cgroupWalkLimit  = 4000
	containerNameTTL = 60 * time.Second
	containerNameErr = 15 * time.Second
	cpuMinInterval   = time.Second
)

var containerDir = regexp.MustCompile(`^(?:docker-)?([0-9a-f]{64})(?:\.scope)?$`)

// containerNamesQuery maps container ids to the latest names seen in logs. The
// basic stats/sort pipes keep it valid across VictoriaLogs versions; the newest
// row per container_id is picked in Go.
const containerNamesQuery = `_time:7d container_id:* | stats by (container_id, container_name, compose_service, compose_project) max(_time) as t | sort by (t desc) | limit 500`

type memorySummary struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
	Free      uint64 `json:"free"`
	Buffers   uint64 `json:"buffers"`
	Cached    uint64 `json:"cached"`
	SwapTotal uint64 `json:"swapTotal"`
	SwapUsed  uint64 `json:"swapUsed"`
}

type appGroup struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Kind    string   `json:"kind"`
	Project string   `json:"project,omitempty"`
	Service string   `json:"service,omitempty"`
	Memory  uint64   `json:"memory"`
	Cache   uint64   `json:"cache"`
	Limit   *uint64  `json:"limit"`
	CPU     *float64 `json:"cpu"`
	path    string
	usage   uint64
	hasCPU  bool
}

type systemReport struct {
	Memory          memorySummary `json:"memory"`
	Groups          []appGroup    `json:"groups"`
	Accounted       uint64        `json:"accounted"`
	CgroupAvailable bool          `json:"cgroupAvailable"`
	SampledAt       time.Time     `json:"sampledAt"`
}

type cpuSample struct {
	usage   uint64
	at      time.Time
	percent *float64
}

type containerInfo struct{ name, service, project string }

type systemState struct {
	mu          sync.Mutex
	cpu         map[string]cpuSample
	names       map[string]containerInfo
	namesAt     time.Time
	namesFailed bool
}

// readMeminfo parses /proc/meminfo. Cached follows free(1)'s buff/cache minus
// buffers: Cached + SReclaimable - Shmem (shared memory is not reclaimable).
func readMeminfo(path string) (memorySummary, bool) {
	f, err := os.Open(path)
	if err != nil {
		return memorySummary{}, false
	}
	defer f.Close()
	v := map[string]uint64{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		name, rest, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		if len(fields) > 1 && fields[1] == "kB" {
			n *= 1024
		}
		v[name] = n
	}
	if v["MemTotal"] == 0 {
		return memorySummary{}, false
	}
	m := memorySummary{Total: v["MemTotal"], Free: v["MemFree"], Buffers: v["Buffers"], SwapTotal: v["SwapTotal"]}
	m.Available = v["MemAvailable"]
	if _, ok := v["MemAvailable"]; !ok {
		m.Available = v["MemFree"] + v["Buffers"] + v["Cached"]
	}
	m.Available = min(m.Available, m.Total)
	m.Used = m.Total - m.Available
	m.Cached = sub(v["Cached"]+v["SReclaimable"], v["Shmem"])
	m.SwapUsed = sub(v["SwapTotal"], v["SwapFree"])
	return m, true
}

func sub(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

func readUint(path string) (uint64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	return n, err == nil
}

func readKeyed(path string, keys ...string) map[string]uint64 {
	out := map[string]uint64{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		for _, want := range keys {
			if k == want {
				if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil {
					out[k] = n
				}
			}
		}
	}
	return out
}

// readGroup reads one cgroup. Memory excludes inactive file cache like
// `docker stats`; cache is the whole page cache charged to the group.
func readGroup(dir string, g *appGroup) bool {
	current, ok := readUint(filepath.Join(dir, "memory.current"))
	if !ok {
		return false
	}
	stat := readKeyed(filepath.Join(dir, "memory.stat"), "inactive_file", "file")
	g.Memory = sub(current, stat["inactive_file"])
	g.Cache = stat["file"]
	if limit, ok := readUint(filepath.Join(dir, "memory.max")); ok {
		g.Limit = &limit
	}
	if usage, ok := readKeyed(filepath.Join(dir, "cpu.stat"), "usage_usec")["usage_usec"]; ok {
		g.usage, g.hasCPU = usage, true
	}
	return true
}

// discoverGroups walks the cgroup tree (bounded) for container scopes, host
// systemd services and the user/init groups.
func discoverGroups(root string) []appGroup {
	var groups []appGroup
	visited := 0
	var walk func(rel string, depth int)
	walk = func(rel string, depth int) {
		entries, err := os.ReadDir(filepath.Join(root, rel))
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() || visited >= cgroupWalkLimit {
				continue
			}
			visited++
			name := e.Name()
			child := filepath.ToSlash(filepath.Join(rel, name))
			g := appGroup{path: child}
			switch {
			case containerDir.MatchString(name):
				g.ID, g.Kind = containerDir.FindStringSubmatch(name)[1], "container"
			case depth == 0 && (name == "user.slice" || name == "init.scope"):
				g.ID, g.Kind, g.Name = name, "other", name
			case strings.HasSuffix(name, ".service") && strings.HasPrefix(child, "system.slice/"):
				g.ID, g.Kind, g.Name = name, "service", strings.TrimSuffix(name, ".service")
			default:
				if depth+1 < cgroupWalkDepth {
					walk(child, depth+1)
				}
				continue
			}
			if readGroup(filepath.Join(root, child), &g) && g.Memory > 0 {
				groups = append(groups, g)
			}
		}
	}
	walk("", 0)
	return groups
}

func (s *server) systemReport(r *http.Request) systemReport {
	now := time.Now()
	report := systemReport{Groups: []appGroup{}, SampledAt: now.UTC()}
	report.Memory, _ = readMeminfo(s.meminfoPath)
	if _, err := os.Stat(filepath.Join(s.cgroupRoot, "cgroup.controllers")); err != nil {
		return report
	}
	report.CgroupAvailable = true
	groups := discoverGroups(s.cgroupRoot)
	s.applyCPU(groups, now)
	needNames := false
	for _, g := range groups {
		needNames = needNames || g.Kind == "container"
	}
	var names map[string]containerInfo
	if needNames {
		names = s.containerNames(r, groups, now)
	}
	for i := range groups {
		g := &groups[i]
		if g.Kind == "container" {
			if info, ok := names[g.ID]; ok && info.name != "" {
				g.Name, g.Service, g.Project = info.name, info.service, info.project
			} else {
				g.Name = "container " + g.ID[:12]
			}
		}
		report.Accounted += g.Memory
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if groups[i].Memory != groups[j].Memory {
			return groups[i].Memory > groups[j].Memory
		}
		return groups[i].Name < groups[j].Name
	})
	report.Groups = groups
	return report
}

// applyCPU turns cumulative usage into percent of one core since the previous
// sample. Samples closer than cpuMinInterval reuse the last value so several
// open tabs do not produce noisy short deltas.
func (s *server) applyCPU(groups []appGroup, now time.Time) {
	s.sys.mu.Lock()
	defer s.sys.mu.Unlock()
	seen := map[string]bool{}
	for i := range groups {
		g := &groups[i]
		if !g.hasCPU {
			continue
		}
		seen[g.path] = true
		prev, ok := s.sys.cpu[g.path]
		switch {
		case !ok || g.usage < prev.usage:
			s.sys.cpu[g.path] = cpuSample{usage: g.usage, at: now}
		case now.Sub(prev.at) < cpuMinInterval:
			g.CPU = prev.percent
		default:
			percent := float64(g.usage-prev.usage) / float64(now.Sub(prev.at).Microseconds()) * 100
			percent = float64(int64(percent*10+0.5)) / 10
			g.CPU = &percent
			s.sys.cpu[g.path] = cpuSample{usage: g.usage, at: now, percent: &percent}
		}
	}
	for path := range s.sys.cpu {
		if !seen[path] {
			delete(s.sys.cpu, path)
		}
	}
}

// containerNames returns the cached id → name mapping, refreshing it from
// VictoriaLogs when stale or when an unknown container shows up. Failures are
// cached briefly and never fail the endpoint.
func (s *server) containerNames(r *http.Request, groups []appGroup, now time.Time) map[string]containerInfo {
	s.sys.mu.Lock()
	names, at, failed := s.sys.names, s.sys.namesAt, s.sys.namesFailed
	s.sys.mu.Unlock()
	age := now.Sub(at)
	stale := names == nil || age > containerNameTTL || (failed && age > containerNameErr)
	if !stale && age > containerNameErr {
		for _, g := range groups {
			if _, ok := names[g.ID]; g.Kind == "container" && !ok {
				stale = true
				break
			}
		}
	}
	if !stale {
		return names
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	rows, err := s.query(r.WithContext(ctx), url.Values{"query": {containerNamesQuery}, "timeout": {"4s"}})
	s.sys.mu.Lock()
	defer s.sys.mu.Unlock()
	s.sys.namesAt = now
	if err != nil {
		s.sys.namesFailed = true
		if s.sys.names == nil {
			s.sys.names = map[string]containerInfo{}
		}
		return s.sys.names
	}
	fresh := map[string]containerInfo{}
	latest := map[string]time.Time{}
	for _, row := range rows {
		id, _ := row["container_id"].(string)
		raw, _ := row["t"].(string)
		t, err := time.Parse(time.RFC3339Nano, raw)
		if len(id) != 64 || err != nil {
			continue
		}
		if prev, ok := latest[id]; ok && !t.After(prev) {
			continue
		}
		latest[id] = t
		str := func(k string) string { v, _ := row[k].(string); return v }
		fresh[id] = containerInfo{name: strings.TrimPrefix(str("container_name"), "/"), service: str("compose_service"), project: str("compose_project")}
	}
	s.sys.names, s.sys.namesFailed = fresh, false
	return fresh
}

func (s *server) systemStatus(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, s.systemReport(r))
}

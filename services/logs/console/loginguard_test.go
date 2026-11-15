package main

import (
	"bytes"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// guardedServer returns a test server whose login guard uses a fake clock and whose
// hash comparison is counted.
func guardedServer(t *testing.T) (*server, *fakeClock, *int) {
	t.Helper()
	s := testServer(t, "http://localhost:9428", false)
	clock := &fakeClock{t: time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)}
	s.loginGuard.now = clock.now
	calls := new(int)
	real := s.compareHash
	s.compareHash = func(hash, password []byte) error {
		*calls++
		return real(hash, password)
	}
	return s, clock, calls
}

func loginFrom(s *server, ip, password string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "https://logs.example.test/api/login", strings.NewReader(`{"username":"vefa","password":"`+password+`"}`))
	r.RemoteAddr = ip + ":40000"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Requested-With", "logs-ui")
	r.Header.Set("Origin", "https://logs.example.test")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev, flags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(prev); log.SetFlags(flags) })
	return &buf
}

func TestPerIPLockoutDoublesAndSkipsBcrypt(t *testing.T) {
	logs := captureLog(t)
	s, clock, calls := guardedServer(t)
	const ip = "203.0.113.7"
	for round, want := range []time.Duration{15 * time.Minute, 30 * time.Minute, time.Hour} {
		for i := 0; i < loginFailureLimit; i++ {
			if w := loginFrom(s, ip, "wrong"); w.Code != 401 {
				t.Fatalf("round %d attempt %d: %d", round, i, w.Code)
			}
		}
		before := *calls
		for _, password := range []string{"wrong", "test-password-123"} {
			w := loginFrom(s, ip, password)
			if w.Code != 429 || w.Header().Get("Retry-After") != fmt.Sprint(int(want.Seconds())) {
				t.Fatalf("round %d: locked response %d retry=%q", round, w.Code, w.Header().Get("Retry-After"))
			}
			if !strings.Contains(w.Body.String(), "Çok fazla başarısız deneme") {
				t.Fatalf("unexpected body %s", w.Body)
			}
		}
		if *calls != before {
			t.Fatal("bcrypt ran while the IP was locked")
		}
		// Another IP is unaffected.
		if w := loginFrom(s, "198.51.100.9", "wrong"); w.Code != 401 {
			t.Fatalf("other IP: %d", w.Code)
		}
		clock.advance(want - time.Second)
		if loginFrom(s, ip, "wrong").Code != 429 {
			t.Fatal("lock ended early")
		}
		clock.advance(time.Second)
	}
	if !strings.Contains(logs.String(), `login locked ip=203.0.113.7 user="vefa" failures=5 lock=1h0m0s`) ||
		!strings.Contains(logs.String(), `login failed ip=203.0.113.7 user="vefa" failures=1`) {
		t.Fatalf("missing log lines:\n%s", logs)
	}
	if strings.Contains(logs.String(), "wrong") || strings.Contains(logs.String(), "test-password-123") {
		t.Fatal("password logged")
	}
}

func TestLockoutCapsAndDecays(t *testing.T) {
	want := []time.Duration{15 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour, 4 * time.Hour, 8 * time.Hour, 16 * time.Hour, 24 * time.Hour, 24 * time.Hour}
	for i, d := range want {
		if got := lockoutDuration(i + 1); got != d {
			t.Fatalf("lockout %d: %s want %s", i+1, got, d)
		}
	}
	g := newLoginGuard()
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g.now = clock.now
	fail := func() time.Duration {
		var lock time.Duration
		for i := 0; i < loginFailureLimit; i++ {
			if d, _ := g.begin("203.0.113.1"); d != loginAllowed {
				t.Fatalf("unexpected decision %d", d)
			}
			_, lock = g.finish("203.0.113.1", false)
		}
		return lock
	}
	fail()
	clock.advance(15 * time.Minute)
	if fail() != 30*time.Minute {
		t.Fatal("second lockout did not double")
	}
	clock.advance(30*time.Minute + loginLockoutDecay + time.Second)
	if fail() != 15*time.Minute {
		t.Fatal("lockout count did not decay after a quiet day")
	}
}

func TestSuccessResetsFailures(t *testing.T) {
	logs := captureLog(t)
	s, clock, _ := guardedServer(t)
	const ip = "203.0.113.8"
	for i := 0; i < loginFailureLimit-1; i++ {
		loginFrom(s, ip, "wrong")
	}
	if w := loginFrom(s, ip, "test-password-123"); w.Code != 200 {
		t.Fatalf("login: %d", w.Code)
	}
	if !strings.Contains(logs.String(), "login succeeded ip=203.0.113.8") {
		t.Fatalf("missing success log:\n%s", logs)
	}
	for i := 0; i < loginFailureLimit-1; i++ {
		if w := loginFrom(s, ip, "wrong"); w.Code != 401 {
			t.Fatalf("failure count not reset: %d", w.Code)
		}
	}
	// Failures older than the window are forgotten.
	clock.advance(loginFailureWindow)
	for i := 0; i < loginFailureLimit-1; i++ {
		if w := loginFrom(s, ip, "wrong"); w.Code != 401 {
			t.Fatalf("window did not slide: %d", w.Code)
		}
	}
}

func TestGlobalLimitWithTrustedBypass(t *testing.T) {
	captureLog(t)
	s, clock, calls := guardedServer(t)
	const home = "203.0.113.50"
	if loginFrom(s, home, "test-password-123").Code != 200 {
		t.Fatal("initial login failed")
	}
	// A distributed attack: many IPs, each below the per-IP limit.
	for i := 0; i < loginGlobalLimit; i++ {
		ip := fmt.Sprintf("198.18.%d.%d", i/200, i%200+1)
		if w := loginFrom(s, ip, "wrong"); w.Code != 401 {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	before := *calls
	w := loginFrom(s, "192.0.2.200", "test-password-123")
	if w.Code != 429 || w.Header().Get("Retry-After") == "" || *calls != before {
		t.Fatalf("new IP not held back by the global limit: %d", w.Code)
	}
	if w := loginFrom(s, home, "test-password-123"); w.Code != 200 {
		t.Fatalf("trusted IP blocked by the global limit: %d", w.Code)
	}
	// The trusted IP still has its own per-IP limit.
	for i := 0; i < loginFailureLimit; i++ {
		loginFrom(s, home, "wrong")
	}
	if loginFrom(s, home, "test-password-123").Code != 429 {
		t.Fatal("trusted IP bypassed its per-IP limit")
	}
	clock.advance(time.Hour)
	if w := loginFrom(s, "192.0.2.200", "test-password-123"); w.Code != 200 {
		t.Fatalf("global limit did not expire: %d", w.Code)
	}
	clock.advance(loginTrustedFor)
	if s.loginGuard.isTrusted(home, clock.now()) {
		t.Fatal("trust did not expire")
	}
}

func TestLoginGuardMemoryIsBounded(t *testing.T) {
	g := newLoginGuard()
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	g.now = clock.now
	for i := 0; i < loginMaxTrackedIPs+500; i++ {
		ip := fmt.Sprintf("10.%d.%d.%d", i>>16&255, i>>8&255, i&255)
		g.begin(ip)
		g.finish(ip, false)
		clock.advance(time.Millisecond)
	}
	if len(g.ips) > loginMaxTrackedIPs {
		t.Fatalf("tracked %d IPs", len(g.ips))
	}
	if _, ok := g.ips["10.0.0.0"]; ok {
		t.Fatal("oldest entry was not evicted")
	}
	for i := 0; i < loginMaxTrusted+10; i++ {
		ip := fmt.Sprintf("172.16.%d.%d", i>>8, i&255)
		g.begin(ip)
		g.finish(ip, true)
		clock.advance(time.Millisecond)
	}
	if len(g.trusted) > loginMaxTrusted {
		t.Fatalf("trusted %d IPs", len(g.trusted))
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		remote string
		xff    []string
		want   string
	}{
		{"203.0.113.9:5000", nil, "203.0.113.9"},
		// Untrusted peer: XFF is ignored.
		{"203.0.113.9:5000", []string{"198.51.100.1"}, "203.0.113.9"},
		// Caddy on the Docker network: right-most entry wins over spoofed ones.
		{"172.18.0.5:5000", []string{"1.2.3.4, 198.51.100.1"}, "198.51.100.1"},
		{"172.18.0.5:5000", []string{"1.2.3.4", "198.51.100.2"}, "198.51.100.2"},
		{"127.0.0.1:5000", []string{"198.51.100.3"}, "198.51.100.3"},
		{"172.18.0.5:5000", []string{"garbage"}, "172.18.0.5"},
		{"172.18.0.5:5000", nil, "172.18.0.5"},
		// IPv6 collapses to its /64; mapped IPv4 is unmapped.
		{"172.18.0.5:5000", []string{"2001:db8:1:2:aaaa::1"}, "2001:db8:1:2::/64"},
		{"[2001:db8:1:2:bbbb::9]:5000", nil, "2001:db8:1:2::/64"},
		{"[::ffff:203.0.113.4]:5000", nil, "203.0.113.4"},
		{"[fd00::1]:5000", []string{"198.51.100.4"}, "198.51.100.4"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/login", nil)
		r.RemoteAddr = c.remote
		for _, v := range c.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := clientIP(r); got != c.want {
			t.Errorf("%s %v: got %s want %s", c.remote, c.xff, got, c.want)
		}
	}
}

func TestLogUsernameIsBounded(t *testing.T) {
	if got := logUsername(strings.Repeat("ş", 40)); len(got) > 64 || !strings.HasPrefix(strings.Repeat("ş", 40), got) {
		t.Fatalf("bad truncation %q", got)
	}
	if got := logUsername("a\xffb"); got != "a?b" {
		t.Fatalf("invalid UTF-8 kept: %q", got)
	}
}

func TestSpoofedForwardedForDoesNotEscapeLockout(t *testing.T) {
	captureLog(t)
	s, _, _ := guardedServer(t)
	for i := 0; i < loginFailureLimit+1; i++ {
		r := httptest.NewRequest("POST", "https://logs.example.test/api/login", strings.NewReader(`{"username":"vefa","password":"wrong"}`))
		r.RemoteAddr = "203.0.113.66:1234"
		r.Header.Set("X-Forwarded-For", fmt.Sprintf("10.0.0.%d", i))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Requested-With", "logs-ui")
		r.Header.Set("Origin", "https://logs.example.test")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if i == loginFailureLimit && w.Code != http.StatusTooManyRequests {
			t.Fatalf("spoofed XFF escaped the lockout: %d", w.Code)
		}
	}
}

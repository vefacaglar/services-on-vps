package main

import (
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Brute-force limits for /api/login. Only failed attempts count.
const (
	loginFailureLimit  = 5                   // failures per IP inside loginFailureWindow before a lockout
	loginFailureWindow = 15 * time.Minute    // sliding window for per-IP failures
	loginBaseLockout   = 15 * time.Minute    // first lockout; each further one doubles
	loginMaxLockout    = 24 * time.Hour      // lockout cap
	loginLockoutDecay  = 24 * time.Hour      // quiet time after a lock ends before the doubling resets
	loginGlobalLimit   = 100                 // failures per hour across all IPs before the safety net engages
	loginTrustedFor    = 30 * 24 * time.Hour // IPs with a successful login this recently bypass the global limit
	loginMaxTrackedIPs = 10000
	loginMaxTrusted    = 256
)

type loginDecision int

const (
	loginAllowed loginDecision = iota
	loginLocked                // per-IP lockout
	loginBusy                  // another attempt from the same IP is in flight
	loginGlobal                // global safety net engaged and the IP is not trusted
)

type ipLoginState struct {
	failures    []time.Time
	lockedUntil time.Time
	lockouts    int
	inflight    int
	lastSeen    time.Time
}

type loginGuard struct {
	mu            sync.Mutex
	now           func() time.Time
	ips           map[string]*ipLoginState
	trusted       map[string]time.Time
	buckets       [60]struct{ minute, n int64 }
	globalTripped bool
}

func newLoginGuard() *loginGuard {
	return &loginGuard{now: time.Now, ips: make(map[string]*ipLoginState), trusted: make(map[string]time.Time)}
}

func lockoutDuration(n int) time.Duration {
	d := loginBaseLockout
	for i := 1; i < n && d < loginMaxLockout; i++ {
		d *= 2
	}
	return min(d, loginMaxLockout)
}

// idle reports whether the entry carries no information worth keeping.
func (st *ipLoginState) idle(now time.Time) bool {
	return st.inflight == 0 && now.After(st.lockedUntil) && (st.lockouts == 0 || now.After(st.lockedUntil.Add(loginLockoutDecay))) &&
		(len(st.failures) == 0 || now.Sub(st.failures[len(st.failures)-1]) >= loginFailureWindow)
}

func (g *loginGuard) state(ip string, now time.Time) *ipLoginState {
	st := g.ips[ip]
	if st == nil {
		if len(g.ips) >= loginMaxTrackedIPs {
			for k, v := range g.ips {
				if v.idle(now) {
					delete(g.ips, k)
				}
			}
		}
		if len(g.ips) >= loginMaxTrackedIPs {
			var oldest string
			var oldestSeen time.Time
			for k, v := range g.ips {
				if oldest == "" || v.lastSeen.Before(oldestSeen) {
					oldest, oldestSeen = k, v.lastSeen
				}
			}
			delete(g.ips, oldest)
		}
		st = &ipLoginState{}
		g.ips[ip] = st
	}
	st.lastSeen = now
	fresh := st.failures[:0]
	for _, t := range st.failures {
		if now.Sub(t) < loginFailureWindow {
			fresh = append(fresh, t)
		}
	}
	st.failures = fresh
	if st.lockouts > 0 && now.After(st.lockedUntil.Add(loginLockoutDecay)) {
		st.lockouts = 0
	}
	return st
}

func (g *loginGuard) globalCount(now time.Time) int64 {
	minute := now.Unix() / 60
	var total int64
	for _, b := range g.buckets {
		if b.minute > minute-60 {
			total += b.n
		}
	}
	return total
}

// globalRetry is how long until the hourly failure count drops below the limit.
func (g *loginGuard) globalRetry(now time.Time) time.Duration {
	minute := now.Unix() / 60
	excess := g.globalCount(now) - loginGlobalLimit + 1
	for m := minute - 59; m <= minute && excess > 0; m++ {
		b := g.buckets[m%60]
		if b.minute == m {
			excess -= b.n
			if excess <= 0 {
				return time.Unix((m+60)*60, 0).Sub(now)
			}
		}
	}
	return time.Minute
}

func (g *loginGuard) isTrusted(ip string, now time.Time) bool {
	t, ok := g.trusted[ip]
	return ok && now.Sub(t) < loginTrustedFor
}

// begin decides whether an attempt may run bcrypt. When it returns loginAllowed the
// caller must call finish exactly once.
func (g *loginGuard) begin(ip string) (loginDecision, time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	st := g.state(ip, now)
	if now.Before(st.lockedUntil) {
		return loginLocked, st.lockedUntil.Sub(now)
	}
	if st.inflight > 0 {
		return loginBusy, time.Second
	}
	if count := g.globalCount(now); count < loginGlobalLimit {
		g.globalTripped = false
	} else if !g.isTrusted(ip, now) {
		if !g.globalTripped {
			g.globalTripped = true
			log.Printf("login global limit engaged failures_last_hour=%d limit=%d", count, loginGlobalLimit)
		}
		return loginGlobal, g.globalRetry(now)
	}
	st.inflight++
	return loginAllowed, 0
}

// finish records the outcome. On failure it returns the IP's failure count and,
// when this failure caused a lockout, its duration.
func (g *loginGuard) finish(ip string, ok bool) (failures int, lock time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	st := g.state(ip, now)
	if st.inflight > 0 {
		st.inflight--
	}
	if ok {
		delete(g.ips, ip)
		if _, known := g.trusted[ip]; !known && len(g.trusted) >= loginMaxTrusted {
			var oldest string
			for k, t := range g.trusted {
				if oldest == "" || t.Before(g.trusted[oldest]) {
					oldest = k
				}
			}
			delete(g.trusted, oldest)
		}
		g.trusted[ip] = now
		return 0, 0
	}
	minute := now.Unix() / 60
	b := &g.buckets[minute%60]
	if b.minute != minute {
		b.minute, b.n = minute, 0
	}
	b.n++
	st.failures = append(st.failures, now)
	failures = len(st.failures)
	if failures >= loginFailureLimit {
		st.lockouts++
		lock = lockoutDuration(st.lockouts)
		st.lockedUntil = now.Add(lock)
		st.failures = st.failures[:0]
	}
	return failures, lock
}

// clientIP returns the caller's address, normalized (IPv6 to its /64). X-Forwarded-For
// is only trusted when the direct peer is on a private or loopback network (Caddy on the
// shared Docker network); then the right-most entry, the one Caddy appended, is used.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	peer = peer.Unmap()
	if peer.IsPrivate() || peer.IsLoopback() {
		if values := r.Header.Values("X-Forwarded-For"); len(values) > 0 {
			parts := strings.Split(values[len(values)-1], ",")
			if addr, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
				peer = addr.Unmap()
			}
		}
	}
	if peer.Is6() {
		prefix, _ := peer.WithZone("").Prefix(64)
		return prefix.String()
	}
	return peer.String()
}

// logUsername makes an attempted username safe for a log line: valid UTF-8, at most
// 64 bytes. Callers format it with %q so control characters are escaped.
func logUsername(name string) string {
	name = strings.ToValidUTF8(name, "?")
	if len(name) > 64 {
		cut := 64
		for cut > 0 && !utf8.RuneStart(name[cut]) {
			cut--
		}
		name = name[:cut]
	}
	return name
}

// cancel releases an allowed attempt that never reached the password check.
func (g *loginGuard) cancel(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if st := g.ips[ip]; st != nil && st.inflight > 0 {
		st.inflight--
	}
}

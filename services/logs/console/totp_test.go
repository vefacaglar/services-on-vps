package main

import (
	"encoding/base32"
	"fmt"
	"testing"
	"time"
)

// RFC 6238 appendix B secret; its SHA-1 vectors truncated to six digits.
const rfcSecret = "12345678901234567890"

var rfcSecretBase32 = base32.StdEncoding.EncodeToString([]byte(rfcSecret))

func totpServer(t *testing.T, at time.Time) (*server, *time.Time) {
	t.Helper()
	s := testServer(t, "http://localhost:9428", false)
	if err := s.configureTOTP(rfcSecretBase32); err != nil {
		t.Fatal(err)
	}
	clock := at
	s.now = func() time.Time { return clock }
	return s, &clock
}

func loginBody(password, code string) string {
	return fmt.Sprintf(`{"username":"vefa","password":%q,"code":%q}`, password, code)
}

func TestTOTPCodeMatchesRFC6238Vectors(t *testing.T) {
	for unix, want := range map[int64]string{59: "287082", 1111111109: "081804", 1111111111: "050471",
		1234567890: "005924", 2000000000: "279037", 20000000000: "353130"} {
		if got := totpCode([]byte(rfcSecret), uint64(unix/totpPeriod)); got != want {
			t.Errorf("t=%d: got %s, want %s", unix, got, want)
		}
	}
}

func TestTOTPSecretParsing(t *testing.T) {
	for _, value := range []string{rfcSecretBase32, "gezd gnbv-gy3t qojq gezd gnbv gy3t qojq", rfcSecretBase32 + "======"} {
		if key, err := parseTOTPSecret(value); err != nil || string(key) != rfcSecret {
			t.Errorf("%q: %v", value, err)
		}
	}
	for _, value := range []string{"", "JBSWY3DPEHPK3PXP", "not base32 !!!!!!!!!!!!!!!!!!!!!!", "0189018901890189018901890189018901"} {
		if _, err := parseTOTPSecret(value); err == nil {
			t.Errorf("%q was accepted", value)
		}
	}
	s := testServer(t, "http://localhost:9428", false)
	if err := s.configureTOTP("too-short"); err == nil || s.totpKey != nil {
		t.Fatal("invalid secret must fail closed at startup")
	}
}

func TestLoginWithoutTOTPSecretIsUnchanged(t *testing.T) {
	s := testServer(t, "http://localhost:9428", false)
	if w := request(s, "GET", "/api/login", "", nil); w.Code != 200 || w.Body.String() != "{\"totp\":false}\n" {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	signIn(t, s)
	// A client that always sends the field keeps working.
	if w := request(s, "POST", "/api/login", loginBody("test-password-123", ""), nil); w.Code != 200 {
		t.Fatalf("login with empty code: %d %s", w.Code, w.Body)
	}
	if w := request(s, "POST", "/api/login", `{"username":"vefa","password":"incorrect"}`, nil); w.Code != 401 ||
		w.Body.String() != "{\"error\":\"Kullanıcı adı veya şifre yanlış.\"}\n" {
		t.Fatalf("wrong password: %d %s", w.Code, w.Body)
	}
}

func TestLoginRequiresTOTPCode(t *testing.T) {
	at := time.Unix(1111111109, 0)
	s, _ := totpServer(t, at)
	if w := request(s, "GET", "/api/login", "", nil); w.Code != 200 || w.Body.String() != "{\"totp\":true}\n" {
		t.Fatalf("status: %d %s", w.Code, w.Body)
	}
	wrongPassword := request(s, "POST", "/api/login", loginBody("incorrect", "081804"), nil)
	if wrongPassword.Code != 401 {
		t.Fatalf("wrong password: %d", wrongPassword.Code)
	}
	// Missing, wrong and malformed codes look exactly like a wrong password.
	for _, body := range []string{`{"username":"vefa","password":"test-password-123"}`, loginBody("test-password-123", "000000"),
		loginBody("test-password-123", "81804"), loginBody("test-password-123", "0818040"), loginBody("test-password-123", "12345678901234567")} {
		s.loginGuard = newLoginGuard()
		w := request(s, "POST", "/api/login", body, nil)
		if w.Code != wrongPassword.Code || w.Body.String() != wrongPassword.Body.String() || len(w.Result().Cookies()) != 0 {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body)
		}
	}
	s.loginGuard = newLoginGuard()
	w := request(s, "POST", "/api/login", loginBody("test-password-123", "081804"), nil)
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("correct code: %d %s", w.Code, w.Body)
	}
	if got := request(s, "GET", "/api/session", "", w.Result().Cookies()[0]).Code; got != 200 {
		t.Fatalf("session: %d", got)
	}
}

func TestWrongTOTPCodeCountsTowardLockout(t *testing.T) {
	s, _ := totpServer(t, time.Unix(1111111109, 0))
	for i := 0; i < loginFailureLimit; i++ {
		if w := request(s, "POST", "/api/login", loginBody("test-password-123", "000000"), nil); w.Code != 401 {
			t.Fatalf("attempt %d: %d", i, w.Code)
		}
	}
	// Locked now: even the right password and code are refused.
	w := request(s, "POST", "/api/login", loginBody("test-password-123", "081804"), nil)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("no lockout after wrong codes: %d %s", w.Code, w.Body)
	}
}

func TestTOTPCodeCannotBeReused(t *testing.T) {
	s, clock := totpServer(t, time.Unix(1111111109, 0))
	// A wrong password must not burn the code.
	if w := request(s, "POST", "/api/login", loginBody("incorrect", "081804"), nil); w.Code != 401 {
		t.Fatalf("wrong password: %d", w.Code)
	}
	if w := request(s, "POST", "/api/login", loginBody("test-password-123", "081804"), nil); w.Code != 200 {
		t.Fatalf("first use: %d %s", w.Code, w.Body)
	}
	if w := request(s, "POST", "/api/login", loginBody("test-password-123", "081804"), nil); w.Code != 401 {
		t.Fatalf("replay in the same step: %d", w.Code)
	}
	// Still inside the tolerance window one step later, and still refused.
	*clock = clock.Add(totpPeriod * time.Second)
	if w := request(s, "POST", "/api/login", loginBody("test-password-123", "081804"), nil); w.Code != 401 {
		t.Fatalf("replay in the next step: %d", w.Code)
	}
	next := totpCode([]byte(rfcSecret), uint64(clock.Unix()/totpPeriod))
	if w := request(s, "POST", "/api/login", loginBody("test-password-123", next), nil); w.Code != 200 {
		t.Fatalf("next code: %d %s", w.Code, w.Body)
	}
}

func TestTOTPClockDriftTolerance(t *testing.T) {
	base := time.Unix(1111111109, 0)
	step := base.Unix() / totpPeriod
	for delta, want := range map[int64]int{-2: 401, -1: 200, 0: 200, 1: 200, 2: 401} {
		s, _ := totpServer(t, base)
		code := totpCode([]byte(rfcSecret), uint64(step+delta))
		if w := request(s, "POST", "/api/login", loginBody("test-password-123", code), nil); w.Code != want {
			t.Errorf("drift %+d steps: got %d, want %d", delta, w.Code, want)
		}
	}
}

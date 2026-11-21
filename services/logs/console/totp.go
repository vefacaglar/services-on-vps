package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// Optional second factor: TOTP as in RFC 6238 with the defaults every
// authenticator app uses (HMAC-SHA1, 6 digits, 30 second steps).
const (
	totpPeriod = 30
	totpSkew   = 1 // Accepted clock drift, in steps, on either side.
)

// parseTOTPSecret decodes LOGS_UI_TOTP_SECRET. Spaces, hyphens, lower case and
// "=" padding are tolerated because authenticator apps display secrets that way.
func parseTOTPSecret(value string) ([]byte, error) {
	clean := strings.ToUpper(strings.TrimRight(strings.NewReplacer(" ", "", "-", "").Replace(value), "="))
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(clean)
	if err != nil || len(key) < 16 || len(key) > 64 {
		// Never echo the value: this message reaches the service log.
		return nil, fmt.Errorf("LOGS_UI_TOTP_SECRET must be base32 for 16-64 bytes")
	}
	return key, nil
}

// totpCode is HOTP (RFC 4226) for one counter value, as six digits.
func totpCode(key []byte, counter uint64) string {
	var message [8]byte
	binary.BigEndian.PutUint64(message[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(message[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000)
}

// totpMatch reports which time step the code belongs to. Every step in the
// tolerance window is always computed and compared in constant time.
func totpMatch(key []byte, code string, now time.Time) (step int64, ok bool) {
	current := now.Unix() / totpPeriod
	for delta := int64(-totpSkew); delta <= totpSkew; delta++ {
		candidate := current + delta
		if candidate < 0 {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(code), []byte(totpCode(key, uint64(candidate)))) == 1 {
			step, ok = candidate, true
		}
	}
	return step, ok
}

// configureTOTP turns the second factor on; an empty secret leaves it off.
func (s *server) configureTOTP(secret string) error {
	if secret == "" {
		return nil
	}
	key, err := parseTOTPSecret(secret)
	if err != nil {
		return err
	}
	s.totpKey = key
	return nil
}

// claimTOTP makes a code single-use: a step is accepted once, and no step at or
// before the last accepted one is accepted again.
func (s *server) claimTOTP(step int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if step <= s.totpUsed {
		return false
	}
	s.totpUsed = step
	return true
}

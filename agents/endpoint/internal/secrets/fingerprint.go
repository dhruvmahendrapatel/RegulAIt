package secrets

// Credential-reuse fingerprints (ADR-0350 §11). A fingerprint is a keyed HMAC-SHA256 of a discovered secret under a
// per-tenant key the admin deploys in the agent config. The value never leaves the device and is not kept; the
// control plane compares fingerprints only, so the same credential on several devices or users is found without
// anyone learning it.
//
// The tenant key is on every enrolled device and readable by its local users (the config is 0644, and on macOS the
// collector runs as the user), so it is not a secret from them: it keeps the values from anyone without an enrolled
// device. The control plane adds the protection that matters for a copy of its database: it stores
// HMAC(server key, key id ‖ fingerprint) under a key derived from its own data key, never this fingerprint.
//
// What is fingerprinted is the credential itself, not the field around it: a recognised token is cut out of its
// field (so "Bearer ghp_X", a URL carrying ghp_X and ghp_X alone give one fingerprint), and an auth scheme in front of
// an unrecognised value is dropped. Values too short or too uniform to be a real secret, and common placeholders,
// get no fingerprint: they would be fleet-wide false findings and the easiest values to guess. Off when no key is
// configured.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// FingerprintKeyBytes is the per-tenant key length.
const FingerprintKeyBytes = 32

const (
	fingerprintDomain = "regulait.credential-reuse/1\x00"
	keyIDDomain       = "regulait.credential-reuse.key-id/1\x00"
)

// Fingerprinter computes credential-reuse fingerprints under one tenant key.
type Fingerprinter struct {
	key   []byte
	keyID string
}

// NewFingerprinter reads a base64url (no padding) 32-byte key.
func NewFingerprinter(encoded string) (*Fingerprinter, error) {
	key, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(key) != FingerprintKeyBytes {
		return nil, errors.New("the credential-reuse key is not 32 bytes of base64url")
	}
	id := sha256.Sum256(append([]byte(keyIDDomain), key...))
	return &Fingerprinter{key: key, keyID: hex.EncodeToString(id[:8])}, nil
}

// KeyID names the key (16 hex characters) without revealing it, so the control plane compares fingerprints made
// under the same key only.
func (f *Fingerprinter) KeyID() string { return f.keyID }

// Of is the fingerprint of the credential in one field (64 hex characters), or "" when the field holds nothing
// worth fingerprinting (see the package note). Surrounding space is ignored.
func (f *Fingerprinter) Of(value string) string {
	material := credentialMaterial(value)
	if !fingerprintable(material) {
		return ""
	}
	m := hmac.New(sha256.New, f.key)
	m.Write([]byte(fingerprintDomain))
	m.Write([]byte(material))
	return hex.EncodeToString(m.Sum(nil))
}

// MinFingerprintBytes is the shortest value that gets a fingerprint.
const MinFingerprintBytes = 8

// authSchemes are dropped from the front of a value before it is fingerprinted (an Authorization header value).
var authSchemes = []string{"bearer ", "basic ", "token ", "bot ", "apikey "}

// tokenRules are the rules whose match is the credential itself; for the others (an assignment, a private-key
// header) the match is not the whole secret, so the field is used.
var tokenRules = map[string]bool{
	"dlp.secret.aws_key": true, "dlp.secret.jwt": true, "dlp.secret.provider_token": true, "dlp.secret.anthropic_key": true,
	"dlp.secret.openai_key": true, "dlp.secret.github_fine_grained_pat": true, "dlp.secret.stripe_key": true,
	"dlp.secret.google_api_key": true, "dlp.secret.gitlab_pat": true, "dlp.secret.huggingface_token": true,
	"dlp.secret.regulait_token": true,
}

// credentialMaterial is what is fingerprinted for one field. It stays inside this package.
func credentialMaterial(value string) string {
	v := strings.TrimSpace(value)
	if len(v) > MaxValueBytes {
		v = v[:MaxValueBytes]
	}
	for _, r := range rules {
		if !tokenRules[r.id] {
			continue
		}
		for _, m := range r.re.FindAllStringSubmatch(v, -1) {
			if r.accept != nil && !r.accept(m) {
				continue
			}
			// the RE2 rewrites of a lookaround consume one boundary character on either side
			return strings.TrimFunc(m[0], func(c rune) bool { return !tokenChar(c) })
		}
	}
	lower := strings.ToLower(v)
	for _, s := range authSchemes {
		if strings.HasPrefix(lower, s) {
			return strings.TrimSpace(v[len(s):])
		}
	}
	return v
}

func tokenChar(c rune) bool {
	return c == '_' || c == '-' || c == '.' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// placeholders are values seen in templates and docs, compared case-insensitively.
var placeholders = map[string]bool{
	"changeme": true, "change-me": true, "change_me": true, "password": true, "passw0rd": true, "placeholder": true,
	"your-key-here": true, "your_key_here": true, "your-api-key": true, "your_api_key": true, "yourapikey": true,
	"your-token-here": true, "your_token_here": true, "insert-key-here": true, "replace-me": true, "replace_me": true,
	"redacted": true, "example": true, "secret123": true, "password123": true, "12345678": true, "123456789": true,
	"qwertyuiop": true, "notasecret": true, "dummy-key": true, "test-key": true,
}

// fingerprintable: long enough, varied enough and not a known placeholder.
func fingerprintable(v string) bool {
	if len(v) < MinFingerprintBytes || placeholders[strings.ToLower(v)] {
		return false
	}
	if strings.HasPrefix(v, "<") && strings.HasSuffix(v, ">") {
		return false
	}
	distinct := map[rune]bool{}
	for _, c := range v {
		distinct[c] = true
	}
	return len(distinct) >= 5
}

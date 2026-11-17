package secrets

// Credential-reuse fingerprints (ADR-0350 §11). A fingerprint is a keyed HMAC-SHA256 of a discovered secret under a
// per-tenant key the admin deploys in the agent's root-owned config. The value never leaves the device and is not
// kept; the control plane compares fingerprints only, so the same credential on several devices or users is found
// without anyone learning it. The control plane never holds the key, so a copy of its database cannot be used to
// test guesses against the fingerprints. Off when no key is configured.

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

// Of is the fingerprint of one secret value (64 hex characters). Surrounding space is ignored.
func (f *Fingerprinter) Of(value string) string {
	m := hmac.New(sha256.New, f.key)
	m.Write([]byte(fingerprintDomain))
	m.Write([]byte(strings.TrimSpace(value)))
	return hex.EncodeToString(m.Sum(nil))
}

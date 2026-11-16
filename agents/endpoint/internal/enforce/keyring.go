package enforce

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
)

// The device-policy signer (owner decision B4, 2026-11-15): one rotatable Ed25519 signer on the control plane signs
// both the endpoint enforcement policy and the managed-browser policy, in the same envelope (keyId, payload,
// signature). Its key is operator-managed or install-generated, so it cannot be compiled in. The admin pins its
// public key in the agent's MDM-deployed, root-owned config file, as the browser extension pins it in managed
// storage. Two pins at most: the current key and the next one, so a rotation never leaves a device unable to
// verify.

// MaxPinnedKeys is the current key plus the next one.
const MaxPinnedKeys = 2

// PinnedKey is one device-policy public key: its key id and the raw Ed25519 public key, base64url without padding
// (the JWK `x` member, as the browser extension's managed storage carries it).
type PinnedKey struct {
	KeyID string `json:"keyId"`
	X     string `json:"x"`
}

// KeyringFrom validates pinned keys into a keyring. Any malformed pin refuses the whole list, so a damaged config
// never silently drops to a different key set.
func KeyringFrom(pins []PinnedKey) (Keyring, error) {
	if len(pins) > MaxPinnedKeys {
		return nil, fmt.Errorf("at most %d device-policy keys may be pinned", MaxPinnedKeys)
	}
	k := Keyring{}
	for _, p := range pins {
		if !keyIDShape.MatchString(p.KeyID) {
			return nil, errors.New("a device-policy key id is not well formed")
		}
		if _, dup := k[p.KeyID]; dup {
			return nil, errors.New("a device-policy key id is pinned twice")
		}
		raw, err := base64.RawURLEncoding.DecodeString(p.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, errors.New("a device-policy key is not an Ed25519 public key")
		}
		k[p.KeyID] = ed25519.PublicKey(raw)
	}
	return k, nil
}

// With is k plus other's keys; on the same key id, k wins (the compiled keyring is never overridden by a pin).
func (k Keyring) With(other Keyring) Keyring {
	out := Keyring{}
	for id, pub := range other {
		out[id] = pub
	}
	for id, pub := range k {
		out[id] = pub
	}
	return out
}

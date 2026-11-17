package enforce

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
)

// VerifyEnvelope checks a device-policy signer envelope ({keyId, payload, signature}: Ed25519 over the exact payload
// bytes, standard base64) against the pinned keyring and returns the verified payload bytes. It decides nothing about
// the payload: the enforcement policy (LoadPolicy) and the update directive (ADR-0360) each validate their own.
func VerifyEnvelope(raw []byte, keys Keyring) ([]byte, error) {
	var env Envelope
	if err := strictJSON(raw, &env); err != nil {
		return nil, fmt.Errorf("envelope: %v", err)
	}
	if !keyIDShape.MatchString(env.KeyID) {
		return nil, errors.New("key id not well formed")
	}
	key, ok := keys[env.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("key %q is not pinned in this build", env.KeyID)
	}
	payload, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		return nil, errors.New("payload encoding")
	}
	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, errors.New("signature encoding")
	}
	if !ed25519.Verify(key, payload, sig) {
		return nil, errors.New("signature does not verify")
	}
	return payload, nil
}

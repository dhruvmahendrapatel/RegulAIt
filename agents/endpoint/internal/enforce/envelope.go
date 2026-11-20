package enforce

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
)

// ErrUnverified wraps every reason a signed envelope is refused.
var ErrUnverified = errors.New("signed envelope does not verify")

func unverified(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrUnverified, fmt.Sprintf(format, a...))
}

// VerifyEnvelope checks one signed envelope against the keyring and returns the signed payload bytes. It is the one
// signature check for everything the control plane signs for the device's enforcement path: the enforcement policy
// (ADR-0298) and the add-on removal directive (ADR-0331). Every failure wraps ErrUnverified.
func VerifyEnvelope(raw []byte, keys Keyring) ([]byte, error) {
	var env Envelope
	if err := strictJSON(raw, &env); err != nil {
		return nil, unverified("envelope: %v", err)
	}
	if !keyIDShape.MatchString(env.KeyID) {
		return nil, unverified("key id not well formed")
	}
	key, ok := keys[env.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, unverified("key %q is not pinned in this build", env.KeyID)
	}
	payload, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		return nil, unverified("payload encoding")
	}
	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, unverified("signature encoding")
	}
	if !ed25519.Verify(key, payload, sig) {
		return nil, unverified("signature does not verify")
	}
	return payload, nil
}

// StrictJSON decodes one JSON value, refusing unknown members and trailing data: the decoder every signed payload
// uses.
func StrictJSON(data []byte, v any) error { return strictJSON(data, v) }

// Package devicekey holds the device's signing key (ADR-0195 owner decision d, R15 §3.1).
//
// The key is a P-256 ECDSA key, so ES256, whether it lives in hardware or not: Secure Enclave and TPM keys are
// P-256, and one algorithm keeps one signing path. Hardware is the default. The software fallback is taken only
// where no key hardware is reachable, the reason is logged and sent with the registration so posture flags the
// device, and hardware that is present but fails is an error, never a reason to fall back.
//
// Per OS, in this build:
//   - Linux: the TPM through /dev/tpmrm0 (go-tpm), only where the user can already open it; otherwise a 0600 file.
//   - Windows: the TPM through the Platform Crypto Provider (NCrypt); where it cannot be opened, a DPAPI-protected
//     file. Not run on Windows yet (pending execution).
//   - macOS: the Secure Enclave needs a cgo build on the macOS runner (SD4j), which this build is not. The darwin
//     binary therefore refuses to create a device key at all, rather than fall back on hardware that every
//     supported Mac has.
package devicekey

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Key is a device key. Sign takes a SHA-256 digest and returns an ASN.1 DER signature, as crypto/ecdsa does.
type Key interface {
	crypto.Signer
	ID() string
	Store() Store
}

// Store creates and loads keys of one provider.
type Store interface {
	Provider() string
	Protection() contract.KeyProtection
	// Probe returns nil when the store is usable, an error wrapping ErrNoHardware when its hardware does not exist
	// or is not reachable by this user (the one case a fallback is allowed), and any other error when the
	// hardware is there but failing.
	Probe() error
	Create() (Key, error)
	Load(id string) (Key, error)
	Delete(id string) error
}

// ErrNoHardware marks "no key hardware here", the only condition under which the software fallback is used.
var ErrNoHardware = errors.New("no key hardware reachable")

// ErrNotFound is a missing key id.
var ErrNotFound = errors.New("device key not found")

// Selection is the chosen store and, for a software store, why.
type Selection struct {
	Store          Store
	FallbackReason string
}

// Select picks hardware when it probes usable, the software store only when the hardware probe says there is no
// hardware, and refuses otherwise.
func Select(hardware, software Store, log *slog.Logger) (Selection, error) {
	if hardware == nil {
		return Selection{}, errors.New("this build has no hardware key store for this OS")
	}
	err := hardware.Probe()
	if err == nil {
		log.Info("device key: hardware", "provider", hardware.Provider())
		return Selection{Store: hardware}, nil
	}
	if !errors.Is(err, ErrNoHardware) {
		return Selection{}, fmt.Errorf("the %s key store is present but not usable, and a software key is not used in its place (owner decision d): %w", hardware.Provider(), err)
	}
	if software == nil {
		return Selection{}, fmt.Errorf("no hardware key store (%v) and no software fallback in this build", err)
	}
	if perr := software.Probe(); perr != nil {
		return Selection{}, fmt.Errorf("software key store %s: %w", software.Provider(), perr)
	}
	reason := err.Error()
	log.Warn("device key: SOFTWARE fallback; posture will flag this device", "provider", software.Provider(), "reason", reason)
	return Selection{Store: software, FallbackReason: reason}, nil
}

// newID is a random store-local key id.
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// validID admits ids newID made, so an id from a state file cannot name another path.
func validID(id string) bool {
	if len(id) != 32 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

// softwareKey is a P-256 key held in process memory, loaded from a software store.
type softwareKey struct {
	*ecdsa.PrivateKey
	id    string
	store Store
}

func (k *softwareKey) ID() string   { return k.id }
func (k *softwareKey) Store() Store { return k.store }

func generateP256() (*ecdsa.PrivateKey, error) {
	return ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
}

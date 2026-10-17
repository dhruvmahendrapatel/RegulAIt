//go:build windows

package devicekey

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/sha256"
	"errors"
	"testing"
)

func roundTrip(t *testing.T, s Store) {
	t.Helper()
	k, err := s.Create()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Delete(k.ID())
	again, err := s.Load(k.ID())
	if err != nil {
		t.Fatal(err)
	}
	d := sha256.Sum256([]byte("report"))
	sig, err := again.Sign(nil, d[:], crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if !ecdsa.VerifyASN1(k.Public().(*ecdsa.PublicKey), d[:], sig) {
		t.Fatal("signature does not verify")
	}
}

// Runs on the CI Windows runner.
func TestDPAPIStore(t *testing.T) {
	roundTrip(t, DPAPIStore{Dir: t.TempDir()})
}

// A runner without a usable TPM must answer "no hardware" (the fallback case), never another error; one with a
// TPM must create, sign with and delete a key.
func TestNCryptStore(t *testing.T) {
	err := NCryptStore{}.Probe()
	if err != nil {
		if !errors.Is(err, ErrNoHardware) {
			t.Fatalf("probe: %v", err)
		}
		t.Skipf("no TPM on this runner: %v", err)
	}
	roundTrip(t, NCryptStore{})
}

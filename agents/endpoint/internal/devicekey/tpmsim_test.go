//go:build linux && tpmsim

// The TPM store against the Microsoft reference TPM 2.0 simulator (go-tpm-tools, cgo). Run with
// `go test -tags tpmsim ./internal/devicekey/`; CI's endpoint-agent workflow does.
package devicekey

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/go-tpm/tpm2/transport"
	"github.com/google/go-tpm/tpm2/transport/simulator"
)

// shared keeps one simulator for the whole test: the store opens and closes the transport per operation, and the
// simulator's seeds must survive that, as a real TPM's do.
type shared struct{ transport.TPMCloser }

func (shared) Close() error { return nil }

func TestTPMStoreOnSimulator(t *testing.T) {
	sim, err := simulator.OpenSimulator()
	if err != nil {
		t.Fatal(err)
	}
	defer sim.Close()
	store := TPMStore{Dir: filepath.Join(t.TempDir(), "keys"), Open: func() (transport.TPMCloser, error) { return shared{sim}, nil }}
	if err := store.Probe(); err != nil {
		t.Fatal(err)
	}
	k, err := store.Create()
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("report"))
	sig, err := k.Sign(nil, digest[:], crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	if !ecdsa.VerifyASN1(k.Public().(*ecdsa.PublicKey), digest[:], sig) {
		t.Fatal("TPM signature does not verify")
	}
	// reloaded from its file, the same key signs again
	again, err := store.Load(k.ID())
	if err != nil {
		t.Fatal(err)
	}
	sig2, err := again.Sign(nil, digest[:], crypto.SHA256)
	if err != nil || !ecdsa.VerifyASN1(k.Public().(*ecdsa.PublicKey), digest[:], sig2) {
		t.Fatalf("reloaded key: %v", err)
	}
	// the file holds the TPM-wrapped private area, not a usable key
	raw, _ := os.ReadFile(filepath.Join(store.Dir, k.ID()+".tpm"))
	if len(raw) == 0 {
		t.Fatal("no key file")
	}
	st, _ := os.Stat(filepath.Join(store.Dir, k.ID()+".tpm"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", st.Mode().Perm())
	}
	if err := store.Delete(k.ID()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(k.ID()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted key loaded: %v", err)
	}
}

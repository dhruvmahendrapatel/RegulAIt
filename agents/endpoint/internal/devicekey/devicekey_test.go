//go:build linux

package devicekey

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

type probeStore struct {
	FileStore
	provider string
	prot     contract.KeyProtection
	probe    error
}

func (p probeStore) Provider() string                   { return p.provider }
func (p probeStore) Protection() contract.KeyProtection { return p.prot }
func (p probeStore) Probe() error                       { return p.probe }

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSelect(t *testing.T) {
	soft := probeStore{provider: "file", prot: contract.KeySoftware}
	hw := func(err error) probeStore { return probeStore{provider: "tpm", prot: contract.KeyHardware, probe: err} }

	sel, err := Select(hw(nil), soft, quiet())
	if err != nil || sel.Store.Provider() != "tpm" || sel.FallbackReason != "" {
		t.Fatalf("usable hardware not chosen: %+v %v", sel, err)
	}
	sel, err = Select(hw(fmt.Errorf("%w: no device", ErrNoHardware)), soft, quiet())
	if err != nil || sel.Store.Provider() != "file" || !strings.Contains(sel.FallbackReason, "no device") {
		t.Fatalf("absent hardware did not fall back with a reason: %+v %v", sel, err)
	}
	// present but failing hardware is never a reason to fall back
	if _, err := Select(hw(errors.New("TPM in failure mode")), soft, quiet()); err == nil {
		t.Fatal("fell back from failing hardware")
	}
	if _, err := Select(nil, soft, quiet()); err == nil {
		t.Fatal("no hardware store accepted")
	}
	if _, err := Select(hw(fmt.Errorf("%w", ErrNoHardware)), nil, quiet()); err == nil {
		t.Fatal("no fallback store accepted")
	}
}

func TestSelectLogsTheFallback(t *testing.T) {
	var b strings.Builder
	log := slog.New(slog.NewTextHandler(&b, nil))
	_, err := Select(probeStore{provider: "tpm", probe: fmt.Errorf("%w: absent", ErrNoHardware)}, probeStore{provider: "file"}, log)
	if err != nil || !strings.Contains(b.String(), "SOFTWARE fallback") || !strings.Contains(b.String(), "absent") {
		t.Fatalf("fallback not logged: %q %v", b.String(), err)
	}
}

func TestTPMProbeWithoutDevice(t *testing.T) {
	err := TPMStore{Dir: t.TempDir(), Device: filepath.Join(t.TempDir(), "no-tpm")}.Probe()
	if !errors.Is(err, ErrNoHardware) {
		t.Fatalf("a missing device is not 'no hardware': %v", err)
	}
	if os.Getuid() != 0 {
		dev := filepath.Join(t.TempDir(), "tpmrm0")
		os.WriteFile(dev, nil, 0o600)
		os.Chmod(dev, 0o000)
		if err := (TPMStore{Dir: t.TempDir(), Device: dev}).Probe(); !errors.Is(err, ErrNoHardware) || !strings.Contains(err.Error(), "tss") {
			t.Fatalf("an unreachable device is not 'no hardware': %v", err)
		}
	}
}

func TestFileStore(t *testing.T) {
	s := FileStore{Dir: filepath.Join(t.TempDir(), "keys")}
	if err := s.Probe(); err != nil {
		t.Fatal(err)
	}
	k, err := s.Create()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(filepath.Join(s.Dir, k.ID()+".p8"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode %o", st.Mode().Perm())
	}
	d := sha256.Sum256([]byte("x"))
	again, err := s.Load(k.ID())
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := again.Sign(nil, d[:], crypto.SHA256)
	if !ecdsa.VerifyASN1(k.Public().(*ecdsa.PublicKey), d[:], sig) {
		t.Fatal("reloaded key does not match")
	}
	if _, err := s.Load("../../etc/passwd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("path-like id: %v", err)
	}

	// a key file another user could read is refused
	os.Chmod(filepath.Join(s.Dir, k.ID()+".p8"), 0o644)
	if _, err := s.Load(k.ID()); err == nil {
		t.Fatal("group/world-readable key loaded")
	}
	os.Chmod(filepath.Join(s.Dir, k.ID()+".p8"), 0o600)

	// a symlink in the key's place is never followed
	target := filepath.Join(t.TempDir(), "elsewhere.p8")
	data, _ := os.ReadFile(filepath.Join(s.Dir, k.ID()+".p8"))
	os.WriteFile(target, data, 0o600)
	link := newID()
	os.Symlink(target, filepath.Join(s.Dir, link+".p8"))
	if _, err := s.Load(link); err == nil {
		t.Fatal("followed a symlink")
	}

	// a directory other users can enter is refused
	os.Chmod(s.Dir, 0o755)
	if err := s.Probe(); err == nil {
		t.Fatal("open key directory accepted")
	}
}

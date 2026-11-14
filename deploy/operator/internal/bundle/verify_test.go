package bundle

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func pemOf(t *testing.T, pub crypto.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func manifest(version, minInstalled, keyID string) []byte {
	return []byte(fmt.Sprintf(`{
  "schema": "regulait.update-bundle/1",
  "product": "regulait",
  "version": "%s",
  "minInstalledVersion": "%s",
  "signingKeyId": "%s",
  "createdAt": "2026-11-14T00:00:00Z",
  "files": [
    { "path": "a.txt", "sha256": "%064x", "bytes": 1 }
  ]
}
`, version, minInstalled, keyID, 1))
}

type signer struct {
	id   string
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

func newSigner(t *testing.T, id string) signer {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{id, priv, pub}
}

func (s signer) sign(m []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, m)))
}

func wantRefusal(t *testing.T, err error, reason string) {
	t.Helper()
	var r *Refusal
	if !errors.As(err, &r) {
		t.Fatalf("want refusal %s, got %v", reason, err)
	}
	if r.Reason != reason {
		t.Fatalf("want refusal %s, got %s (%s)", reason, r.Reason, r.Message)
	}
}

func TestVerifyAcceptsPristine(t *testing.T) {
	s := newSigner(t, "rel-1")
	m := manifest("0.2.0", "0.1.0", s.id)
	res, err := Verify(Input{Manifest: m, Signature: s.sign(m), Keyring: map[string]string{"rel-1.pub": pemOf(t, s.pub)}, WantVersion: "0.2.0", InstalledVersion: "0.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(m)
	if res.Manifest.Version != "0.2.0" || res.SHA256 != fmt.Sprintf("%x", sum) {
		t.Fatalf("unexpected result %+v", res)
	}
	// Same-version re-apply and a first install pass, as in the script.
	if _, err := Verify(Input{Manifest: m, Signature: s.sign(m), Keyring: map[string]string{"rel-1.pub": pemOf(t, s.pub)}, WantVersion: "0.2.0", InstalledVersion: "0.2.0"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(Input{Manifest: m, Signature: s.sign(m), Keyring: map[string]string{"rel-1.pub": pemOf(t, s.pub)}, WantVersion: "0.2.0"}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyRefusals(t *testing.T) {
	s := newSigner(t, "rel-1")
	other := newSigner(t, "rel-1")
	ring := map[string]string{"rel-1.pub": pemOf(t, s.pub)}
	good := manifest("0.2.0", "0.1.0", "rel-1")
	tampered := append([]byte{}, good...)
	tampered[len(tampered)-3] = ' '

	cases := []struct {
		name, reason string
		in           Input
	}{
		{"missing manifest", "ManifestMissing", Input{Signature: s.sign(good), Keyring: ring, WantVersion: "0.2.0"}},
		{"stripped signature", "SignatureMissing", Input{Manifest: good, Keyring: ring, WantVersion: "0.2.0"}},
		{"modified manifest", "SignatureInvalid", Input{Manifest: tampered, Signature: s.sign(good), Keyring: ring, WantVersion: "0.2.0"}},
		{"same key id, different private key", "SignatureInvalid", Input{Manifest: good, Signature: other.sign(good), Keyring: ring, WantVersion: "0.2.0"}},
		{"unpinned key id", "UnknownSigningKey", func() Input {
			m := manifest("0.2.0", "", "rel-2")
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.2.0"}
		}()},
		{"path traversal key id", "BadKeyID", func() Input {
			m := manifest("0.2.0", "", "../../etc/x")
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.2.0"}
		}()},
		{"signed downgrade", "Downgrade", func() Input {
			m := manifest("0.1.0", "", "rel-1")
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.1.0", InstalledVersion: "0.2.0"}
		}()},
		{"prerelease of the installed version", "Downgrade", func() Input {
			m := manifest("0.2.0-rc.1", "", "rel-1")
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.2.0-rc.1", InstalledVersion: "0.2.0"}
		}()},
		{"below minInstalledVersion", "MinInstalledVersion", func() Input {
			m := manifest("0.3.0", "0.2.0", "rel-1")
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.3.0", InstalledVersion: "0.1.0"}
		}()},
		{"spec asks for another version", "VersionMismatch", Input{Manifest: good, Signature: s.sign(good), Keyring: ring, WantVersion: "0.3.0"}},
		{"short version", "BadVersion", func() Input {
			m := manifest("0.2", "", "rel-1")
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.2"}
		}()},
		{"wrong schema", "UnknownSchema", func() Input {
			m := []byte(`{"schema":"regulait.update-bundle/9","product":"regulait","version":"0.2.0","signingKeyId":"rel-1"}`)
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.2.0"}
		}()},
		{"duplicate version key", "DuplicateKey", func() Input {
			m := []byte(`{"schema":"regulait.update-bundle/1","product":"regulait","version":"0.2.0","version":"9.9.9","signingKeyId":"rel-1"}`)
			return Input{Manifest: m, Signature: s.sign(m), Keyring: ring, WantVersion: "0.2.0"}
		}()},
		{"not json", "ManifestNotJSON", Input{Manifest: []byte("nope"), Signature: s.sign([]byte("nope")), Keyring: ring, WantVersion: "0.2.0"}},
		{"bad base64", "SignatureNotBase64", Input{Manifest: good, Signature: []byte("!!!"), Keyring: ring, WantVersion: "0.2.0"}},
		{"garbage pinned key", "BadPinnedKey", Input{Manifest: good, Signature: s.sign(good), Keyring: map[string]string{"rel-1.pub": "x"}, WantVersion: "0.2.0"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Verify(c.in)
			wantRefusal(t, err, c.reason)
		})
	}
}

func TestVerifyRSAAndECDSAFallback(t *testing.T) {
	m := manifest("1.0.0", "", "k")
	d := sha256.Sum256(m)

	rk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rs, _ := rsa.SignPKCS1v15(rand.Reader, rk, crypto.SHA256, d[:])
	if _, err := Verify(Input{Manifest: m, Signature: []byte(base64.StdEncoding.EncodeToString(rs)), Keyring: map[string]string{"k.pub": pemOf(t, &rk.PublicKey)}, WantVersion: "1.0.0"}); err != nil {
		t.Fatalf("rsa: %v", err)
	}

	ek, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	es, _ := ecdsa.SignASN1(rand.Reader, ek, d[:])
	if _, err := Verify(Input{Manifest: m, Signature: []byte(base64.StdEncoding.EncodeToString(es)), Keyring: map[string]string{"k.pub": pemOf(t, &ek.PublicKey)}, WantVersion: "1.0.0"}); err != nil {
		t.Fatalf("ecdsa: %v", err)
	}
}

// TestInteropWithOpenSSL signs exactly as scripts/build-update-bundle.sh does (openssl pkeyutl -rawin, base64 -A)
// and checks the operator accepts it, so the two verifiers cannot drift apart on encoding.
func TestInteropWithOpenSSL(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl not installed")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("openssl", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("openssl %v: %v\n%s", args, err, out)
		}
	}
	m := manifest("0.4.0", "", "interop")
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), m, 0o600); err != nil {
		t.Fatal(err)
	}
	run("genpkey", "-algorithm", "ed25519", "-out", "k.pem")
	run("pkey", "-in", "k.pem", "-pubout", "-out", "k.pub")
	run("pkeyutl", "-sign", "-inkey", "k.pem", "-rawin", "-in", "manifest.json", "-out", "sig.bin")
	run("base64", "-A", "-in", "sig.bin", "-out", "manifest.json.sig")
	sig, _ := os.ReadFile(filepath.Join(dir, "manifest.json.sig"))
	pub, _ := os.ReadFile(filepath.Join(dir, "k.pub"))
	if _, err := Verify(Input{Manifest: m, Signature: sig, Keyring: map[string]string{"interop.pub": string(pub)}, WantVersion: "0.4.0"}); err != nil {
		t.Fatal(err)
	}
}

func TestEmbeddedKeyringMatchesTheReleaseKeys(t *testing.T) {
	got := EmbeddedKeyring()
	files, err := filepath.Glob(filepath.Join("..", "..", "..", "..", "infra", "release-keys", "*.pub"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no release keys found: %v", err)
	}
	if len(got) != len(files) {
		t.Fatalf("embedded %d keys, infra/release-keys has %d", len(got), len(files))
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		if got[filepath.Base(f)] != string(b) {
			t.Errorf("%s differs from the embedded copy", filepath.Base(f))
		}
		if _, err := parsePublicKey(string(b)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
}

func TestMergeKeyrings(t *testing.T) {
	pinned := map[string]string{"rel.pub": "A\n"}
	m, err := MergeKeyrings(pinned, map[string]string{"rel.pub": "A", "cust.pub": "B"})
	if err != nil || len(m) != 2 || m["rel.pub"] != "A\n" {
		t.Fatalf("merge: %v %v", m, err)
	}
	_, err = MergeKeyrings(pinned, map[string]string{"rel.pub": "Z"})
	wantRefusal(t, err, "KeyIDShadowsPinned")
}

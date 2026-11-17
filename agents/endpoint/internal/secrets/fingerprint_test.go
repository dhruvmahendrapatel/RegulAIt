package secrets

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestFingerprinter(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("k", FingerprintKeyBytes)))
	other := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("o", FingerprintKeyBytes)))
	f, err := NewFingerprinter(key)
	if err != nil {
		t.Fatal(err)
	}
	g, _ := NewFingerprinter(other)
	secret := "ghp_" + strings.Repeat("a", 36)
	a, b := f.Of(secret), f.Of("  "+secret+"\n")
	if a != b || len(a) != 64 || strings.Contains(a, secret) {
		t.Errorf("fingerprint unstable or leaky: %q %q", a, b)
	}
	if f.Of(secret) == g.Of(secret) || f.KeyID() == g.KeyID() || len(f.KeyID()) != 16 {
		t.Error("two tenant keys give the same fingerprint or key id")
	}
	if f.Of(secret) == f.Of(secret+"x") {
		t.Error("different secrets share a fingerprint")
	}
	for _, bad := range []string{"", "short", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 31)))} {
		if _, err := NewFingerprinter(bad); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}
}

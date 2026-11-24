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

// ADR-0350 §11 (review of #970, R2 [5] and [6]): the credential is fingerprinted, not the field around it, and
// placeholders and short or uniform values get no fingerprint.
func TestFingerprintMaterial(t *testing.T) {
	f, _ := NewFingerprinter(base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("m", FingerprintKeyBytes))))
	pat := "ghp_" + strings.Repeat("Ab3", 12)
	want := f.Of(pat)
	if want == "" {
		t.Fatal("a provider token got no fingerprint")
	}
	for _, field := range []string{"Bearer " + pat, "token " + pat, "https://mcp.example.test/sse?key=" + pat, "https://other.example.test/x/" + pat + "/y", `"` + pat + `"`} {
		if got := f.Of(field); got != want {
			t.Errorf("%q: the token in a field gives another fingerprint", field)
		}
	}
	// an unrecognised value behind an auth scheme is the value
	if f.Of("Bearer s3cr3t-Value-99") != f.Of("s3cr3t-Value-99") {
		t.Error("the auth scheme is part of the fingerprint")
	}
	for _, weak := range []string{"", "short", "changeme", "CHANGEME", "your-key-here", "xxxxxxxxxxxx", "aaaabbbbaaaa", "<your-token>", "12345678"} {
		if f.Of(weak) != "" {
			t.Errorf("%q got a fingerprint", weak)
		}
	}
}

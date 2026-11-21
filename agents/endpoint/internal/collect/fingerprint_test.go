package collect

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/secrets"
)

// ADR-0350 §11: with a tenant key every reported key carries a fingerprint and the key id; without one, neither. The
// value never appears in what is reported.
func TestKeyFingerprints(t *testing.T) {
	secret := "ghp_" + strings.Repeat("b", 36)
	in := map[string]any{"GITHUB_TOKEN": secret, "OTHER": "${env:REF}"}
	if keys := envKeys(in); len(keys) != 1 || keys[0].Fingerprint != "" || keys[0].FingerprintKeyID != "" {
		t.Fatalf("fingerprints without a key: %+v", keys)
	}
	f, err := secrets.NewFingerprinter(base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("t", 32))))
	if err != nil {
		t.Fatal(err)
	}
	activeFingerprint = f
	defer func() { activeFingerprint = nil }()
	keys := envKeys(in)
	if len(keys) != 1 || keys[0].Fingerprint != f.Of(secret) || keys[0].FingerprintKeyID != f.KeyID() {
		t.Fatalf("no fingerprint with a key: %+v", keys)
	}
	_, _, urlKeys := describeURL("https://user:" + secret + "@mcp.example.test/sse")
	if len(urlKeys) == 0 || urlKeys[len(urlKeys)-1].Fingerprint == "" {
		t.Errorf("a URL password is not fingerprinted: %+v", urlKeys)
	}
	b, _ := json.Marshal(append(keys, urlKeys...))
	if strings.Contains(string(b), secret) {
		t.Error("a secret value reached the report")
	}
	// two distinct secrets under one name are both kept
	if got := mergeKeys(append(envKeys(map[string]any{"(x)": secret}), envKeys(map[string]any{"(x)": secret + "z"})...)); len(got) != 2 {
		t.Errorf("mergeKeys dropped a distinct fingerprint: %d", len(got))
	}
}

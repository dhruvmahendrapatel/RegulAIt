package bundle

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunVerifyCommand(t *testing.T) {
	s := newSigner(t, "rel-1")
	ring := map[string]string{"rel-1.pub": pemOf(t, s.pub)}
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	m := manifest("2.0.0", "1.0.0", "rel-1")
	mp, sp := write("manifest.json", m), write("manifest.json.sig", s.sign(m))
	run := func(keyring map[string]string, args ...string) (int, string) {
		var out, errb bytes.Buffer
		code := RunVerifyCommand(args, keyring, &out, &errb)
		return code, out.String() + errb.String()
	}

	if code, out := run(ring, "--manifest", mp, "--signature", sp, "--version", "2.0.0", "--installed-version", "1.5.0"); code != 0 || !strings.Contains(out, "verified 2.0.0") {
		t.Fatalf("pristine: %d %s", code, out)
	}
	cases := []struct {
		name   string
		ring   map[string]string
		args   []string
		code   int
		reason string
	}{
		{"usage", ring, []string{"--manifest", mp}, 2, "usage"},
		{"wrong version", ring, []string{"--manifest", mp, "--signature", sp, "--version", "2.0.1"}, 1, "VersionMismatch"},
		{"downgrade", ring, []string{"--manifest", mp, "--signature", sp, "--version", "2.0.0", "--installed-version", "3.0.0"}, 1, "Downgrade"},
		{"below minimum", ring, []string{"--manifest", mp, "--signature", sp, "--version", "2.0.0", "--installed-version", "0.9.0"}, 1, "MinInstalledVersion"},
		{"missing signature file", ring, []string{"--manifest", mp, "--signature", filepath.Join(dir, "nope"), "--version", "2.0.0"}, 1, "SignatureMissing"},
		{"no compiled-in key", nil, []string{"--manifest", mp, "--signature", sp, "--version", "2.0.0"}, 1, "no release key"},
		{"tampered", ring, []string{"--manifest", write("t.json", append([]byte(" "), m...)), "--signature", sp, "--version", "2.0.0"}, 1, "SignatureInvalid"},
	}
	for _, c := range cases {
		code, out := run(c.ring, c.args...)
		if code != c.code || !strings.Contains(out, c.reason) {
			t.Errorf("%s: got %d %q, want %d containing %q", c.name, code, out, c.code, c.reason)
		}
	}
}

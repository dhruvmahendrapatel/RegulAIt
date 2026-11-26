package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanBundlePathRefusesEscapes(t *testing.T) {
	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a/./b", "a\\b", "a\x00b", "a/\x01", strings.Repeat("a", maxPathBytes+1)} {
		if got := cleanBundlePath(bad); got != "" {
			t.Errorf("cleanBundlePath(%q) = %q, want refusal", bad, got)
		}
	}
	for _, good := range []string{".claude/settings.json", "AGENTS.md", ".cursor/skills/x/SKILL.md"} {
		if got := cleanBundlePath(good); got != good {
			t.Errorf("cleanBundlePath(%q) = %q", good, got)
		}
	}
}

func writeInput(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, inputFile), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLoadBundleFailsClosed(t *testing.T) {
	cases := map[string]string{
		"input_invalid":        `{"schema":"other","files":[{"path":"a","content":""}]}`,
		"input_invalid_path":   `{"schema":"regulait.agent-config-bundle.v1","files":[{"path":"../a","content":""}]}`,
		"input_duplicate_path": `{"schema":"regulait.agent-config-bundle.v1","files":[{"path":"a","content":""},{"path":"a","content":""}]}`,
	}
	for want, body := range cases {
		if _, _, _, err := loadBundle(writeInput(t, body)); err == nil || err.Error() != want {
			t.Errorf("%s: got %v", want, err)
		}
	}
	// an unknown field, trailing data, a file that is also a directory
	for _, body := range []string{
		`{"schema":"regulait.agent-config-bundle.v1","files":[{"path":"a","content":"","mode":1}]}`,
		`{"schema":"regulait.agent-config-bundle.v1","files":[{"path":"a","content":""}]} {}`,
		`{"schema":"regulait.agent-config-bundle.v1","files":[{"path":"a","content":""},{"path":"a/b","content":""}]}`,
	} {
		if _, _, _, err := loadBundle(writeInput(t, body)); err == nil {
			t.Errorf("accepted %s", body)
		}
	}
	if _, _, _, err := loadBundle(t.TempDir()); err == nil || err.Error() != "input_unreadable" {
		t.Errorf("missing input: %v", err)
	}
}

func TestLoadBundleAcceptsAValidBundle(t *testing.T) {
	fsys, digest, n, err := loadBundle(writeInput(t, `{"schema":"regulait.agent-config-bundle.v1","files":[{"path":".claude/settings.json","content":"{}"}]}`))
	if err != nil || n != 1 || len(digest) != 64 || fsys[".claude/settings.json"] == nil {
		t.Fatalf("got %v %d %q", err, n, digest)
	}
}

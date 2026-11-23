//go:build linux

package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const mcpInput = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"bypassPermissions","tool_name":"mcp__regulait__search","tool_input":{"q":"secret-argument"},"mcp_server":{"name":"regulait","source":"managed"}}`

// runHook runs the hook command with stdin and returns what it wrote and its exit code.
func runHook(t *testing.T, stdin string, args ...string) (string, string, int) {
	t.Helper()
	in := filepath.Join(t.TempDir(), "stdin.json")
	os.WriteFile(in, []byte(stdin), 0o600)
	f, _ := os.Open(in)
	defer f.Close()
	outR, outW, _ := os.Pipe()
	errR, errW, _ := os.Pipe()
	oldIn, oldOut, oldErr := os.Stdin, os.Stdout, os.Stderr
	os.Stdin, os.Stdout, os.Stderr = f, outW, errW
	code := hook(args)
	os.Stdin, os.Stdout, os.Stderr = oldIn, oldOut, oldErr
	outW.Close()
	errW.Close()
	out, _ := io.ReadAll(outR)
	errOut, _ := io.ReadAll(errR)
	return string(out), string(errOut), code
}

func TestHookSpoolsWithoutChangingTheAnswer(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	out, errOut, code := runHook(t, mcpInput, "claude-code", "-policy", filepath.Join(state, "no-policy.json"))
	if code != 2 || !strings.Contains(out, `"permissionDecision":"deny"`) {
		t.Fatalf("%d %s %s", code, out, errOut)
	}
	dir := filepath.Join(state, "regulait-agent", "decisions")
	entries, _ := os.ReadDir(dir)
	var events []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			events = append(events, string(b))
		}
	}
	if len(events) != 1 || !strings.Contains(events[0], `"verdict":"deny"`) || !strings.Contains(events[0], `"mode":"no_policy"`) ||
		strings.Contains(events[0], "secret-argument") || strings.Contains(events[0], `"s-1"`) {
		t.Fatalf("spooled: %v", events)
	}

	// a spool that cannot be written changes nothing: same answer, same exit code, same streams
	blocked := filepath.Join(t.TempDir(), "a-file")
	os.WriteFile(blocked, nil, 0o600)
	t.Setenv("XDG_STATE_HOME", blocked)
	out2, errOut2, code2 := runHook(t, mcpInput, "claude-code", "-policy", filepath.Join(state, "no-policy.json"))
	if code2 != code || out2 != out || errOut2 != errOut {
		t.Fatalf("answer changed: %d %q %q", code2, out2, errOut2)
	}
}

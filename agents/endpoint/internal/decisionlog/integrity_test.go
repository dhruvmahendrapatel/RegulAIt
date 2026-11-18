package decisionlog

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// The registrations agents/endpoint/README.md documents, and the ways each can be weakened or lost.
var hookStatusCases = []struct {
	name, file, body, want string
}{
	{"claude registered", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"matcher": "mcp__.*", "hooks": [
		{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/etc/regulait/policy.json"], "onFailure": "block"}]}]}}`, contract.HookRegistered},
	{"claude no onFailure", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"matcher": "mcp__.*", "hooks": [
		{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/p"]}]}]}}`, contract.HookWeakened},
	{"claude managed-only off", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": false, "hooks": {"PreToolUse": [{"hooks": [
		{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/p"], "onFailure": "block"}]}]}}`, contract.HookWeakened},
	{"claude other hook", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"hooks": [
		{"type": "command", "command": "/usr/bin/other-tool hook claude-code"}]}]}}`, contract.HookAbsent},
	{"claude wrong adapter", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"hooks": [
		{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "cursor"], "onFailure": "block"}]}]}}`, contract.HookAbsent},
	{"claude other event", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PostToolUse": [{"hooks": [
		{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code"], "onFailure": "block"}]}]}}`, contract.HookAbsent},
	{"claude not json", contract.ManagedFileClaudeCode, `{"hooks": `, contract.HookUnparseable},
	{"claude not an object", contract.ManagedFileClaudeCode, `[1, 2]`, contract.HookUnparseable},
	{"cursor registered", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "'/usr/local/bin/regulait-agent' 'hook' 'cursor' '-policy' '/etc/regulait/policy.json'", "failClosed": true}]}}`, contract.HookRegistered},
	{"cursor windows", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "& 'C:\\Program Files\\RegulAIt\\regulait-agent.exe' 'hook' 'cursor' '-policy' 'C:\\p.json'", "failClosed": true}]}}`, contract.HookRegistered},
	{"cursor fail open", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "'/usr/local/bin/regulait-agent' 'hook' 'cursor' '-policy' '/p'"}]}}`, contract.HookWeakened},
	{"cursor shell event fail open", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "/usr/local/bin/regulait-agent hook cursor -policy /p", "failClosed": true}],
		"beforeShellExecution": [{"command": "/usr/local/bin/regulait-agent hook cursor -policy /p", "failClosed": false}]}}`, contract.HookWeakened},
	{"cursor absent", contract.ManagedFileCursor, `{"version": 1, "hooks": {}}`, contract.HookAbsent},
	{"copilot registered", contract.ManagedFileCopilotCLI, `{"version": 1, "hooks": {"preToolUse": [{"type": "command", "exec": "/usr/local/bin/regulait-agent", "args": ["hook", "copilot-cli", "-policy", "/etc/regulait/policy.json"]}]}}`, contract.HookRegistered},
	{"copilot absent", contract.ManagedFileCopilotCLI, `{"version": 1, "hooks": {"preToolUse": [{"type": "command", "bash": "echo hi"}]}}`, contract.HookAbsent},
	{"copilot unparseable", contract.ManagedFileCopilotCLI, `{"version": 1,}`, contract.HookUnparseable},
	{"codex registered", contract.ManagedFileCodex, `allow_managed_hooks_only = true

[features]
hooks = true

[[hooks.PreToolUse]]
matcher = ".*"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "/usr/local/bin/regulait-agent hook codex -policy /etc/regulait/policy.json"
`, contract.HookRegistered},
	{"codex managed-only in hooks table", contract.ManagedFileCodex, `[hooks]
allow_managed_hooks_only = true

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p"
`, contract.HookRegistered},
	{"codex managed-only off", contract.ManagedFileCodex, `allow_managed_hooks_only = false

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p"
`, contract.HookWeakened},
	{"codex absent", contract.ManagedFileCodex, "allow_managed_hooks_only = true\n", contract.HookAbsent},
	{"codex unparseable", contract.ManagedFileCodex, "allow_managed_hooks_only = = true\n", contract.HookUnparseable},
}

func TestHookStatus(t *testing.T) {
	for _, c := range hookStatusCases {
		if got := HookStatus(c.file, []byte(c.body)); got != c.want {
			t.Fatalf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

func TestCheckIntegrity(t *testing.T) {
	dir := t.TempDir()
	owner := os.Getuid() // tests run unprivileged: the test's own uid stands in for root
	claude := `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/p"], "onFailure": "block"}]}]}}`
	write := func(name, body string, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), mode); err != nil {
			t.Fatal(err)
		}
		os.Chmod(p, mode)
		return p
	}
	files := []ManagedFile{
		{File: contract.ManagedFileClaudeCode, Path: write("managed-settings.json", claude, 0o644)},
		{File: contract.ManagedFileCursor, Path: filepath.Join(dir, "missing.json")},
		{File: contract.ManagedFileCopilotCLI, Path: write("regulait.json", `{"version": 1}`, 0o666)},
		{File: contract.ManagedFileCodex, Path: dir}, // a directory, not a file
	}
	got := CheckIntegrity(files, owner)
	sum := sha256.Sum256([]byte(claude))
	if got[0].State != contract.FileStatePresent || *got[0].SHA256 != hex.EncodeToString(sum[:]) || *got[0].HookStatus != contract.HookRegistered {
		t.Fatalf("present: %+v", got[0])
	}
	if got[1].State != contract.FileStateMissing || got[1].SHA256 != nil || got[1].HookStatus != nil {
		t.Fatalf("missing: %+v", got[1])
	}
	if runtime.GOOS != "windows" && (got[2].State != contract.FileStateNotSystemOwned || got[2].SHA256 != nil || got[2].HookStatus != nil) {
		t.Fatalf("world-writable: %+v", got[2])
	}
	if got[3].State != contract.FileStateUnreadable || got[3].SHA256 != nil {
		t.Fatalf("directory: %+v", got[3])
	}
	if runtime.GOOS == "windows" {
		return
	}
	// another owner, and a symlink in place of the file, are not system-owned
	if e := CheckIntegrity(files[:1], owner+1)[0]; e.State != contract.FileStateNotSystemOwned {
		t.Fatalf("other owner: %+v", e)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(files[0].Path, link); err != nil {
		t.Fatal(err)
	}
	if e := CheckIntegrity([]ManagedFile{{File: contract.ManagedFileClaudeCode, Path: link}}, owner)[0]; e.State != contract.FileStateNotSystemOwned {
		t.Fatalf("symlink: %+v", e)
	}
	// unreadable: no read permission (skipped as root, who reads anyway)
	if os.Getuid() != 0 {
		p := write("noread.json", "{}", 0o200)
		if e := CheckIntegrity([]ManagedFile{{File: contract.ManagedFileCursor, Path: p}}, owner)[0]; e.State != contract.FileStateUnreadable {
			t.Fatalf("no read: %+v", e)
		}
	}
}

func TestDefaultManagedFiles(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		files := DefaultManagedFiles(goos)
		seen := map[string]bool{}
		for _, f := range files {
			if f.Path == "" || seen[f.File] {
				t.Fatalf("%s: %+v", goos, f)
			}
			seen[f.File] = true
		}
		for _, want := range []string{contract.ManagedFileClaudeCode, contract.ManagedFileCursor, contract.ManagedFileCopilotCLI, contract.ManagedFileCodex} {
			if !seen[want] {
				t.Fatalf("%s: no %s", goos, want)
			}
		}
	}
	if got := DefaultManagedFiles("linux")[0].Path; got != "/etc/claude-code/managed-settings.json" {
		t.Fatal(got)
	}
	if got := DefaultManagedFiles("darwin")[1].Path; got != "/Library/Application Support/Cursor/hooks.json" {
		t.Fatal(got)
	}
}

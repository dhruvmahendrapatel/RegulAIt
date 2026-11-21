package decisionlog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// The registrations agents/endpoint/README.md documents, and the ways each can be weakened or lost.
var hookStatusCases = []struct {
	name, file, body, want string
}{
	{"claude registered", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"matcher": "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|mcp__.*", "hooks": [
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
	{"claude matcher misses the built-ins", contract.ManagedFileClaudeCode, claudeWith(`"matcher": "mcp__.*",`, claudeArgs, ""), contract.HookWeakened},
	{"claude matcher never matches", contract.ManagedFileClaudeCode, claudeWith(`"matcher": "NoSuchTool",`, claudeArgs, ""), contract.HookWeakened},
	{"claude matcher does not compile", contract.ManagedFileClaudeCode, claudeWith(`"matcher": "(",`, claudeArgs, ""), contract.HookWeakened},
	{"claude matcher is a substring only", contract.ManagedFileClaudeCode, claudeWith(`"matcher": "Bas|Rea|Writ|Edi|mcp__",`, claudeArgs, ""), contract.HookWeakened},
	{"claude no matcher matches every tool", contract.ManagedFileClaudeCode, claudeWith("", claudeArgs, ""), contract.HookRegistered},
	{"claude star matcher", contract.ManagedFileClaudeCode, claudeWith(`"matcher": "*",`, claudeArgs, ""), contract.HookRegistered},
	{"claude matchers split across groups", contract.ManagedFileClaudeCode, `{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [
		{"matcher": "mcp__.*", "hooks": [` + claudeArgs + `]}, {"matcher": "Bash|Read|Write|Edit", "hooks": [` + claudeArgs + `]}]}}`, contract.HookRegistered},
	{"claude disableAllHooks", contract.ManagedFileClaudeCode, claudeWith("", claudeArgs, `"disableAllHooks": true,`), contract.HookWeakened},
	{"claude echo", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("echo regulait-agent hook claude-code"), ""), contract.HookWeakened},
	{"claude echo exec form", contract.ManagedFileClaudeCode, claudeWith("", `{"type": "command", "args": ["/bin/echo", "regulait-agent", "hook", "claude-code"], "onFailure": "block"}`, ""), contract.HookWeakened},
	{"claude shell wrapper", contract.ManagedFileClaudeCode, claudeWith("", `{"type": "command", "args": ["/bin/sh", "-c", "regulait-agent hook claude-code -policy /p"], "onFailure": "block"}`, ""), contract.HookWeakened},
	{"claude simple command string", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("/usr/local/bin/regulait-agent hook claude-code -policy /p"), ""), contract.HookRegistered},
	{"claude || exit 0", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy p || exit 0"), ""), contract.HookWeakened},
	{"claude &&", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy p && true"), ""), contract.HookWeakened},
	{"claude second command", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy p; exit 0"), ""), contract.HookWeakened},
	{"claude pipe", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy p | cat"), ""), contract.HookWeakened},
	{"claude background", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy p &"), ""), contract.HookWeakened},
	{"claude subshell", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("(regulait-agent hook claude-code -policy p)"), ""), contract.HookWeakened},
	{"claude redirect", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy p 2>/dev/null"), ""), contract.HookWeakened},
	{"claude substitution", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("regulait-agent hook claude-code -policy $(cat /tmp/p)"), ""), contract.HookWeakened},
	{"claude call operator is Cursor's only", contract.ManagedFileClaudeCode, claudeWith("", claudeCommand("& 'regulait-agent' 'hook' 'claude-code'"), ""), contract.HookWeakened},
	{"claude not json", contract.ManagedFileClaudeCode, `{"hooks": `, contract.HookUnparseable},
	{"claude not an object", contract.ManagedFileClaudeCode, `[1, 2]`, contract.HookUnparseable},
	{"cursor registered", contract.ManagedFileCursor, cursorAll(`"'/usr/local/bin/regulait-agent' 'hook' 'cursor' '-policy' '/etc/regulait/policy.json'"`, "true"), contract.HookRegistered},
	{"cursor windows", contract.ManagedFileCursor, cursorAll(`"& 'C:\\Program Files\\RegulAIt\\regulait-agent.exe' 'hook' 'cursor' '-policy' 'C:\\p.json'"`, "true"), contract.HookRegistered},
	{"cursor MCP event only", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "'/usr/local/bin/regulait-agent' 'hook' 'cursor' '-policy' '/p'", "failClosed": true}]}}`, contract.HookWeakened},
	{"cursor read event missing", contract.ManagedFileCursor, `{"version": 1, "hooks": {
		"beforeMCPExecution": [{"command": "/usr/local/bin/regulait-agent hook cursor -policy /p", "failClosed": true}],
		"beforeShellExecution": [{"command": "/usr/local/bin/regulait-agent hook cursor -policy /p", "failClosed": true}]}}`, contract.HookWeakened},
	{"cursor every event fail open", contract.ManagedFileCursor, cursorAll(`"/usr/local/bin/regulait-agent hook cursor -policy /p"`, "false"), contract.HookWeakened},
	{"cursor verdict discarded", contract.ManagedFileCursor, cursorAll(`"/usr/local/bin/regulait-agent hook cursor -policy /p || exit 0"`, "true"), contract.HookWeakened},
	{"cursor echo", contract.ManagedFileCursor, cursorAll(`"echo regulait-agent hook cursor"`, "true"), contract.HookWeakened},
	{"cursor fail open", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "'/usr/local/bin/regulait-agent' 'hook' 'cursor' '-policy' '/p'"}]}}`, contract.HookWeakened},
	{"cursor shell event fail open", contract.ManagedFileCursor, `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "/usr/local/bin/regulait-agent hook cursor -policy /p", "failClosed": true}],
		"beforeShellExecution": [{"command": "/usr/local/bin/regulait-agent hook cursor -policy /p", "failClosed": false}]}}`, contract.HookWeakened},
	{"cursor absent", contract.ManagedFileCursor, `{"version": 1, "hooks": {}}`, contract.HookAbsent},
	{"copilot registered", contract.ManagedFileCopilotCLI, `{"version": 1, "hooks": {"preToolUse": [{"type": "command", "exec": "/usr/local/bin/regulait-agent", "args": ["hook", "copilot-cli", "-policy", "/etc/regulait/policy.json"]}]}}`, contract.HookRegistered},
	{"copilot absent", contract.ManagedFileCopilotCLI, `{"version": 1, "hooks": {"preToolUse": [{"type": "command", "bash": "echo hi"}]}}`, contract.HookAbsent},
	{"copilot exec echo", contract.ManagedFileCopilotCLI, `{"version": 1, "hooks": {"preToolUse": [{"type": "command", "exec": "/bin/echo", "args": ["regulait-agent", "hook", "copilot-cli"]}]}}`, contract.HookWeakened},
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
	{"codex managed-only in hooks table", contract.ManagedFileCodex, `[features]
hooks = true

[hooks]
allow_managed_hooks_only = true

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p"
`, contract.HookRegistered},
	{"codex hooks feature off", contract.ManagedFileCodex, `allow_managed_hooks_only = true

[features]
hooks = false

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p"
`, contract.HookWeakened},
	{"codex hooks feature unset", contract.ManagedFileCodex, `allow_managed_hooks_only = true

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p"
`, contract.HookWeakened},
	{"codex verdict discarded", contract.ManagedFileCodex, `allow_managed_hooks_only = true

[features]
hooks = true

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p || true"
`, contract.HookWeakened},
	{"codex managed-only off", contract.ManagedFileCodex, `allow_managed_hooks_only = false

[[hooks.PreToolUse]]
command = "/usr/local/bin/regulait-agent hook codex -policy /p"
`, contract.HookWeakened},
	{"codex absent", contract.ManagedFileCodex, "allow_managed_hooks_only = true\n", contract.HookAbsent},
	{"codex unparseable", contract.ManagedFileCodex, "allow_managed_hooks_only = = true\n", contract.HookUnparseable},
}

// claudeArgs is the README's exec-form Claude Code entry.
const claudeArgs = `{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/p"], "onFailure": "block"}`

// claudeWith is a managed-settings file with one PreToolUse group: matcher is its "matcher" member (with a trailing
// comma) or empty, entry the hook entry, and root extra top-level members (with a trailing comma).
func claudeWith(matcher, entry, root string) string {
	return `{` + root + `"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{` + matcher + `"hooks": [` + entry + `]}]}}`
}

func claudeCommand(line string) string {
	b, _ := json.Marshal(line)
	return `{"type": "command", "command": ` + string(b) + `, "onFailure": "block"}`
}

// cursorAll registers the JSON-quoted command under all three Cursor events with failClosed set to failClosed.
func cursorAll(command, failClosed string) string {
	entry := `[{"command": ` + command + `, "failClosed": ` + failClosed + `}]`
	return `{"version": 1, "hooks": {"beforeMCPExecution": ` + entry + `, "beforeShellExecution": ` + entry + `, "beforeReadFile": ` + entry + `}}`
}

func TestHookStatus(t *testing.T) {
	for _, c := range hookStatusCases {
		if got := HookStatus(c.file, []byte(c.body)); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
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
	if runtime.GOOS == "windows" {
		// a file in the test's temp directory belongs to the runner's user, not SYSTEM or Administrators, so on
		// Windows it must never read as present: fail closed (integrity_windows_test.go covers the owner checks)
		if got[0].State != contract.FileStateNotSystemOwned || got[0].SHA256 != nil || got[0].HookStatus != nil {
			t.Fatalf("user-owned on windows: %+v", got[0])
		}
	} else if got[0].State != contract.FileStatePresent || *got[0].SHA256 != hex.EncodeToString(sum[:]) || *got[0].HookStatus != contract.HookRegistered {
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

// Windows paths come from the known-folder API, never from %ProgramData% or %ProgramFiles%, which the user may set.
func TestWindowsManagedFilesIgnoreTheEnvironment(t *testing.T) {
	t.Setenv("ProgramData", `C:\Users\Public\Fake`)
	t.Setenv("ProgramFiles", `C:\Users\Public\Fake`)
	for _, f := range DefaultManagedFiles("windows") {
		if strings.Contains(f.Path, "Fake") {
			t.Fatalf("%s follows the environment: %s", f.File, f.Path)
		}
	}
	if runtime.GOOS != "windows" {
		if got := DefaultManagedFiles("windows")[1].Path; got != `C:\ProgramData\Cursor\hooks.json` {
			t.Fatal(got)
		}
		if got := DefaultManagedFiles("windows")[0].Path; got != `C:\Program Files\ClaudeCode\managed-settings.json` {
			t.Fatal(got)
		}
	}
	if joinUnder("", "Cursor", "hooks.json") != "" {
		t.Fatal("an unresolved known folder gave a relative path")
	}
}

// A path that could not be resolved (an unresolved known folder) is unreadable, never present.
func TestCheckIntegrityEmptyPathIsUnreadable(t *testing.T) {
	if e := CheckIntegrity([]ManagedFile{{File: contract.ManagedFileCursor, Path: ""}}, -1)[0]; e.State != contract.FileStateUnreadable || e.SHA256 != nil {
		t.Fatalf("%+v", e)
	}
}

// Unix modes: an executable-but-not-writable file is fine; group or other write is not system-owned.
func TestCheckIntegrityModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix modes")
	}
	dir := t.TempDir()
	for _, c := range []struct {
		mode os.FileMode
		want string
	}{{0o755, contract.FileStatePresent}, {0o644, contract.FileStatePresent}, {0o664, contract.FileStateNotSystemOwned}, {0o646, contract.FileStateNotSystemOwned}} {
		p := filepath.Join(dir, c.mode.String())
		if err := os.WriteFile(p, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, c.mode); err != nil {
			t.Fatal(err)
		}
		if e := CheckIntegrity([]ManagedFile{{File: contract.ManagedFileCursor, Path: p}}, os.Getuid())[0]; e.State != c.want {
			t.Errorf("mode %o: %s, want %s", c.mode, e.State, c.want)
		}
	}
}

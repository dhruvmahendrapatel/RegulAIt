package decisionlog

// Tamper reporting (ADR-0310 addendum): each cycle the agent reads each vendor's managed hook file and reports, per
// file, whether it is there, whether it is system-owned, the SHA-256 of its exact bytes, and whether it still
// registers the RegulAIt hook with the vendor's fail-closed or managed-only setting. It reports; it never restores.
// The registrations are the ones agents/endpoint/README.md documents ("Registrations").

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

// maxManagedFile bounds what is read of a managed file; a larger one is reported unreadable.
const maxManagedFile = 1 << 20

// ManagedFile is one vendor's managed hook file on this device.
type ManagedFile struct {
	File string // a contract.ManagedFile* name
	Path string
}

// DefaultManagedFiles are the documented admin locations on goos.
func DefaultManagedFiles(goos string) []ManagedFile {
	var claude, cursor, copilot, codex string
	switch goos {
	case "darwin":
		claude = "/Library/Application Support/ClaudeCode/managed-settings.json"
		cursor = "/Library/Application Support/Cursor/hooks.json"
		copilot = "/etc/github-copilot/policy.d/regulait.json"
		codex = "/etc/codex/requirements.toml"
	case "windows":
		programData := os.Getenv("ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		programFiles := os.Getenv("ProgramFiles")
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		claude = filepath.Join(programFiles, "ClaudeCode", "managed-settings.json")
		cursor = filepath.Join(programData, "Cursor", "hooks.json")
		copilot = filepath.Join(programData, "GitHub", "Copilot", "policy.d", "regulait.json")
		codex = filepath.Join(programData, "OpenAI", "Codex", "requirements.toml")
	default:
		claude = "/etc/claude-code/managed-settings.json"
		cursor = "/etc/cursor/hooks.json"
		copilot = "/etc/github-copilot/policy.d/regulait.json"
		codex = "/etc/codex/requirements.toml"
	}
	return []ManagedFile{
		{File: contract.ManagedFileClaudeCode, Path: claude},
		{File: contract.ManagedFileCursor, Path: cursor},
		{File: contract.ManagedFileCopilotCLI, Path: copilot},
		{File: contract.ManagedFileCodex, Path: codex},
	}
}

// CheckIntegrity reports each file. systemOwner is the uid a managed file must belong to (0; a negative value skips
// the uid check, tests only); on Windows ownership is not checked.
func CheckIntegrity(files []ManagedFile, systemOwner int) []contract.IntegrityEntry {
	out := make([]contract.IntegrityEntry, 0, len(files))
	for _, f := range files {
		e := contract.IntegrityEntry{File: f.File}
		data, state := readManaged(f.Path, systemOwner)
		e.State = state
		if state == contract.FileStatePresent {
			d := sha256.Sum256(data)
			sum, status := hex.EncodeToString(d[:]), HookStatus(f.File, data)
			e.SHA256, e.HookStatus = &sum, &status
		}
		out = append(out, e)
	}
	return out
}

// readManaged opens a managed file without following a final symlink and checks its owner and mode
// (integrity_unix.go, integrity_windows.go).
func readManaged(path string, systemOwner int) ([]byte, string) {
	f, err := openManaged(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return nil, contract.FileStateMissing
	case isSymlinkRefusal(err):
		return nil, contract.FileStateNotSystemOwned
	default:
		return nil, contract.FileStateUnreadable
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, contract.FileStateUnreadable
	}
	if !systemOwned(st, systemOwner) {
		return nil, contract.FileStateNotSystemOwned
	}
	b, err := io.ReadAll(io.LimitReader(f, maxManagedFile+1))
	if err != nil || len(b) > maxManagedFile {
		return nil, contract.FileStateUnreadable
	}
	return b, contract.FileStatePresent
}

// vendor is how one managed file registers the RegulAIt hook.
type vendor struct {
	adapter string
	toml    bool
	// events are the hook events the registration uses
	events []string
	// entryFailClosed: the regulait hook entry sets the vendor's fail-closed switch (nil: the vendor has none)
	entryFailClosed func(entry map[string]any) bool
	// rootManagedOnly: the file sets the vendor's managed-hooks-only switch (nil: the vendor has none)
	rootManagedOnly func(root map[string]any) bool
}

var vendors = map[string]vendor{
	contract.ManagedFileClaudeCode: {
		adapter: enforce.AgentClaudeCode, events: []string{"PreToolUse"},
		entryFailClosed: func(e map[string]any) bool { return e["onFailure"] == "block" },
		rootManagedOnly: func(r map[string]any) bool { return r["allowManagedHooksOnly"] == true },
	},
	contract.ManagedFileCursor: {
		adapter: enforce.AgentCursor, events: []string{"beforeMCPExecution", "beforeShellExecution", "beforeReadFile"},
		entryFailClosed: func(e map[string]any) bool { return e["failClosed"] == true },
	},
	// Copilot CLI documents no fail-closed switch: policy.d hooks deny on error (1.0.57 or later) and cannot be
	// disabled by users, so the exec registration alone is registered.
	contract.ManagedFileCopilotCLI: {adapter: enforce.AgentCopilotCLI, events: []string{"preToolUse", "PreToolUse"}},
	contract.ManagedFileCodex: {
		adapter: enforce.AgentCodex, toml: true, events: []string{"PreToolUse"},
		rootManagedOnly: func(r map[string]any) bool {
			if r["allow_managed_hooks_only"] == true {
				return true
			}
			h, _ := r["hooks"].(map[string]any)
			return h != nil && h["allow_managed_hooks_only"] == true
		},
	},
}

// HookStatus says what a present managed file registers: the RegulAIt hook with its fail-closed and managed-only
// settings (registered), the hook without them (weakened), no RegulAIt hook (absent), or a file that does not parse.
func HookStatus(file string, data []byte) string {
	v, ok := vendors[file]
	if !ok {
		return contract.HookUnparseable
	}
	var root map[string]any
	var err error
	if v.toml {
		err = toml.Unmarshal(data, &root)
	} else {
		dec := json.NewDecoder(bytes.NewReader(data))
		if err = dec.Decode(&root); err == nil && dec.More() {
			err = errors.New("trailing data")
		}
	}
	if err != nil || root == nil {
		return contract.HookUnparseable
	}
	hooks, _ := root["hooks"].(map[string]any)
	found, weakened := false, false
	for _, ev := range v.events {
		walkEntries(hooks[ev], func(entry map[string]any) {
			if !invokesHook(entryWords(entry), v.adapter) {
				return
			}
			found = true
			if v.entryFailClosed != nil && !v.entryFailClosed(entry) {
				weakened = true
			}
		})
	}
	switch {
	case !found:
		return contract.HookAbsent
	case weakened || v.rootManagedOnly != nil && !v.rootManagedOnly(root):
		return contract.HookWeakened
	}
	return contract.HookRegistered
}

// commandKeys are the members a hook entry names its command with, across the four vendors' formats.
var commandKeys = []string{"command", "exec", "args", "bash", "powershell"}

// walkEntries calls fn for every hook entry under an event's value: an object with a command member, at any depth
// (Claude Code and Codex nest entries under a matcher group; Cursor and Copilot CLI list them directly).
func walkEntries(v any, fn func(map[string]any)) {
	switch t := v.(type) {
	case []any:
		for _, x := range t {
			walkEntries(x, fn)
		}
	case map[string]any:
		for _, k := range commandKeys {
			if _, ok := t[k]; ok {
				fn(t)
				break
			}
		}
		for _, x := range t {
			if _, isMap := x.(map[string]any); isMap {
				walkEntries(x, fn)
			} else if _, isList := x.([]any); isList {
				walkEntries(x, fn)
			}
		}
	}
}

// entryWords is the entry's command as words: exec form members as they are, a shell string split with its quotes
// removed (POSIX shells and PowerShell alike: only quoting matters to find the program and its first arguments).
func entryWords(e map[string]any) []string {
	var words []string
	for _, k := range commandKeys {
		switch t := e[k].(type) {
		case string:
			if k == "exec" {
				words = append(words, t)
			} else {
				words = append(words, splitQuoted(t)...)
			}
		case []any:
			for _, x := range t {
				if s, ok := x.(string); ok {
					words = append(words, s)
				}
			}
		}
	}
	return words
}

// invokesHook: some word runs regulait-agent, and later words are `hook <adapter>`.
func invokesHook(words []string, adapter string) bool {
	for i, w := range words {
		if base := strings.ToLower(baseName(w)); base != "regulait-agent" && base != "regulait-agent.exe" {
			continue
		}
		for j := i + 1; j+1 < len(words); j++ {
			if words[j] == "hook" {
				return words[j+1] == adapter
			}
		}
	}
	return false
}

// baseName takes the last element of a POSIX or Windows path.
func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// splitQuoted splits a command line on unquoted whitespace and removes single and double quotes.
func splitQuoted(s string) []string {
	var out []string
	var cur strings.Builder
	quote, started := rune(0), false
	for _, r := range s {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote, started = r, true
		case r == ' ' || r == '\t' || r == '\n' || r == '\r':
			if started {
				out = append(out, cur.String())
				cur.Reset()
				started = false
			}
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	if started {
		out = append(out, cur.String())
	}
	return out
}

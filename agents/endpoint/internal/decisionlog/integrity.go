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
	"regexp"
	"strings"

	"github.com/pelletier/go-toml/v2"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
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
		// the known-folder API, never %ProgramData% or %ProgramFiles%: the environment is the user's to change, and
		// would point the check at a pristine copy of the user's choosing. A folder that cannot be resolved leaves
		// the path empty, which CheckIntegrity reports unreadable.
		programData, programFiles := windowsProgramDirs()
		claude = joinUnder(programFiles, "ClaudeCode", "managed-settings.json")
		cursor = joinUnder(programData, "Cursor", "hooks.json")
		copilot = joinUnder(programData, "GitHub", "Copilot", "policy.d", "regulait.json")
		codex = joinUnder(programData, "OpenAI", "Codex", "requirements.toml")
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

// joinUnder joins elem under dir with Windows separators, or is empty when dir is (an unresolved known folder).
func joinUnder(dir string, elem ...string) string {
	if dir == "" {
		return ""
	}
	return strings.TrimRight(dir, `\`) + `\` + strings.Join(elem, `\`)
}

// CheckIntegrity reports each file. systemOwner is the uid a managed file must belong to (0; a negative value skips
// the uid check, tests only). On Windows systemOwner is not used: the owner must be SYSTEM or Administrators, and
// only they (and TrustedInstaller) may write the file (fsutil's DACL check).
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

// readManaged opens a managed file without following a final symlink or reparse point (fsutil.OpenNoFollow) and
// checks its owner and mode, or its owner SID and DACL (fsutil.CheckMode). A link, a reparse point, another owner or
// a mode or DACL that lets anyone else write it is not system-owned; a check that cannot be completed is unreadable,
// never present.
func readManaged(path string, systemOwner int) ([]byte, string) {
	if path == "" {
		return nil, contract.FileStateUnreadable
	}
	f, err := fsutil.OpenNoFollow(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return nil, contract.FileStateMissing
	case fsutil.IsUnsafeOpen(err):
		return nil, contract.FileStateNotSystemOwned
	default:
		return nil, contract.FileStateUnreadable
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return nil, contract.FileStateUnreadable
	}
	if err := fsutil.CheckMode(f, st, systemOwner, fsutil.WorldReadExec); err != nil {
		if errors.Is(err, fsutil.ErrCannotCheck) {
			return nil, contract.FileStateUnreadable
		}
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
	// rootOK: the file's top-level switches keep hooks on and managed-only (nil: the vendor has none)
	rootOK func(root map[string]any) bool
	// required are what the registrations must cover between them (nil: one registration under any event is enough);
	// covers says what one fail-closed registration under event ev, in a group whose matcher is matcher, covers
	required []string
	covers   func(ev string, matcher any) []string
}

// claudeGoverned are the tool names a Claude Code registration's matcher must match: an MCP tool and the governed
// built-ins (agents/endpoint/README.md, "Command rules").
var claudeGoverned = []string{"mcp__x__y", "Bash", "Read", "Write", "Edit"}

var vendors = map[string]vendor{
	contract.ManagedFileClaudeCode: {
		adapter: enforce.AgentClaudeCode, events: []string{"PreToolUse"},
		entryFailClosed: func(e map[string]any) bool { return e["onFailure"] == "block" },
		rootOK: func(r map[string]any) bool {
			return r["allowManagedHooksOnly"] == true && r["disableAllHooks"] != true
		},
		required: claudeGoverned,
		covers:   func(_ string, m any) []string { return matcherMatches(m, claudeGoverned) },
	},
	contract.ManagedFileCursor: {
		adapter: enforce.AgentCursor, events: []string{"beforeMCPExecution", "beforeShellExecution", "beforeReadFile"},
		entryFailClosed: func(e map[string]any) bool { return e["failClosed"] == true },
		required:        []string{"beforeMCPExecution", "beforeShellExecution", "beforeReadFile"},
		covers:          func(ev string, _ any) []string { return []string{ev} },
	},
	// Copilot CLI documents no fail-closed switch: policy.d hooks deny on error (1.0.57 or later) and cannot be
	// disabled by users, so the exec registration alone is registered.
	contract.ManagedFileCopilotCLI: {adapter: enforce.AgentCopilotCLI, events: []string{"preToolUse", "PreToolUse"}},
	contract.ManagedFileCodex: {
		adapter: enforce.AgentCodex, toml: true, events: []string{"PreToolUse"},
		rootOK: func(r map[string]any) bool {
			features, _ := r["features"].(map[string]any)
			if features == nil || features["hooks"] != true {
				return false // [features] hooks = false (or unset) turns every hook off
			}
			if r["allow_managed_hooks_only"] == true {
				return true
			}
			h, _ := r["hooks"].(map[string]any)
			return h != nil && h["allow_managed_hooks_only"] == true
		},
	},
}

// HookStatus says what a present managed file registers: the RegulAIt hook with its fail-closed and managed-only
// settings on every event (and, for Claude Code, every governed tool) it must cover (registered); the hook without
// them, on only some events, or a mention of regulait-agent that is not a clean registration, such as one behind
// `echo` or followed by `|| exit 0` (weakened); no RegulAIt hook (absent); or a file that does not parse. It fails
// closed: anything it cannot show is enforcing is not registered.
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
	covered := map[string]bool{}
	for _, ev := range v.events {
		walkEntries(hooks[ev], nil, func(entry map[string]any, matcher any) {
			switch registration(entry, v.adapter) {
			case regOther:
				return
			case regUnclean:
				weakened = true
				return
			}
			found = true
			if v.entryFailClosed != nil && !v.entryFailClosed(entry) {
				weakened = true
				return
			}
			if v.covers != nil {
				for _, c := range v.covers(ev, matcher) {
					covered[c] = true
				}
			}
		})
	}
	for _, r := range v.required {
		if found && !covered[r] {
			weakened = true // registered, but not on every event or governed tool it must cover
		}
	}
	switch {
	case !found && !weakened:
		return contract.HookAbsent
	case !found || weakened || v.rootOK != nil && !v.rootOK(root):
		return contract.HookWeakened
	}
	return contract.HookRegistered
}

// matcherMatches is the names a Claude Code matcher selects: an absent, empty or "*" matcher selects every tool;
// anything else is a regular expression that must match the whole name. One that does not compile selects nothing.
func matcherMatches(m any, names []string) []string {
	if m == nil || m == "" || m == "*" {
		return names
	}
	s, ok := m.(string)
	if !ok {
		return nil
	}
	re, err := regexp.Compile(`^(?:` + s + `)$`)
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range names {
		if re.MatchString(n) {
			out = append(out, n)
		}
	}
	return out
}

// commandKeys are the members a hook entry names its command with, across the four vendors' formats.
var commandKeys = []string{"command", "exec", "args", "bash", "powershell"}

// walkEntries calls fn for every hook entry under an event's value: an object with a command member, at any depth
// (Claude Code and Codex nest entries under a matcher group; Cursor and Copilot CLI list them directly), with the
// nearest enclosing group's matcher (nil when there is none).
func walkEntries(v any, matcher any, fn func(entry map[string]any, matcher any)) {
	switch t := v.(type) {
	case []any:
		for _, x := range t {
			walkEntries(x, matcher, fn)
		}
	case map[string]any:
		if m, ok := t["matcher"]; ok {
			matcher = m
		}
		for _, k := range commandKeys {
			if _, ok := t[k]; ok {
				fn(t, matcher)
				break
			}
		}
		for _, x := range t {
			if _, isMap := x.(map[string]any); isMap {
				walkEntries(x, matcher, fn)
			} else if _, isList := x.([]any); isList {
				walkEntries(x, matcher, fn)
			}
		}
	}
}

// What one hook entry is to the RegulAIt registration.
const (
	regOther   = iota // not RegulAIt's: no mention of regulait-agent, or a clean call of another adapter
	regOurs           // exactly `regulait-agent hook <adapter> ...` in every form the entry gives
	regUnclean        // mentions regulait-agent but is not a clean call: its verdict can be discarded or never run
)

// registration classifies an entry. Every command form it gives (an exec form: exec plus args, or args alone with
// the program first; a shell string: command, bash or powershell) must be a clean call for it to be ours.
func registration(e map[string]any, adapter string) int {
	forms, clean := commandForms(e, adapter)
	allForms := func(pred func(argv []string) bool) bool {
		for _, argv := range forms {
			if !pred(argv) {
				return false
			}
		}
		return len(forms) > 0
	}
	switch {
	case clean && allForms(func(argv []string) bool { return invokesHook(argv, adapter) }):
		return regOurs
	case !mentionsAgent(e):
		return regOther
	case clean && allForms(func(argv []string) bool { return isAgentProgram(argv[0]) && !invokesHook(argv, adapter) }):
		return regOther // a clean call of regulait-agent for another adapter or subcommand is not this registration
	}
	return regUnclean
}

// commandForms is each command form of the entry as an argv; clean is false when any form is not a literal argv or
// a single simple shell command (enforce.SimpleCommand).
func commandForms(e map[string]any, adapter string) (forms [][]string, clean bool) {
	clean = true
	if _, hasExec := e["exec"]; hasExec || e["args"] != nil {
		argv, ok := execArgv(e)
		clean = clean && ok
		if ok {
			forms = append(forms, argv)
		}
	}
	for _, k := range []string{"command", "bash", "powershell"} {
		x, present := e[k]
		if !present {
			continue
		}
		line, isString := x.(string)
		if adapter == enforce.AgentCursor {
			// Cursor on Windows runs the command through PowerShell, with the call operator before the quoted path
			// (agents/endpoint/README.md); the rest is a simple command PowerShell and bash quote alike
			line = strings.TrimPrefix(line, "& ")
		}
		argv, ok := enforce.SimpleCommand(line)
		clean = clean && isString && ok
		if isString && ok {
			forms = append(forms, argv)
		}
	}
	return forms, clean
}

// execArgv is an exec form's argv: exec then args, or args alone with the program first. Every member must be a
// string.
func execArgv(e map[string]any) ([]string, bool) {
	var argv []string
	if x, ok := e["exec"]; ok {
		s, isString := x.(string)
		if !isString {
			return nil, false
		}
		argv = append(argv, s)
	}
	if x, ok := e["args"]; ok {
		list, isList := x.([]any)
		if !isList {
			return nil, false
		}
		for _, a := range list {
			s, isString := a.(string)
			if !isString {
				return nil, false
			}
			argv = append(argv, s)
		}
	}
	return argv, len(argv) > 0
}

// mentionsAgent: some string in the entry's command members names regulait-agent.
func mentionsAgent(e map[string]any) bool {
	for _, k := range commandKeys {
		switch t := e[k].(type) {
		case string:
			if strings.Contains(strings.ToLower(t), "regulait-agent") {
				return true
			}
		case []any:
			for _, x := range t {
				if s, ok := x.(string); ok && strings.Contains(strings.ToLower(s), "regulait-agent") {
					return true
				}
			}
		}
	}
	return false
}

// invokesHook: the program, the first word, is regulait-agent, and the next words are `hook <adapter>`.
func invokesHook(argv []string, adapter string) bool {
	return len(argv) >= 3 && isAgentProgram(argv[0]) && argv[1] == "hook" && argv[2] == adapter
}

func isAgentProgram(w string) bool {
	base := strings.ToLower(baseName(w))
	return base == "regulait-agent" || base == "regulait-agent.exe"
}

// baseName takes the last element of a POSIX or Windows path.
func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

package enforce

// Reading the few tool-input fields command rules need (ADR-0350). Only the named field is decoded; the rest of
// the tool input (file contents, edit text, patch bodies) is never decoded, kept or echoed.

import (
	"encoding/json"
	"strings"
)

// inputField returns one string field of a tool-input object. A tool input that is itself a JSON string holding an
// object (Copilot CLI's toolArgs) is read through.
func inputField(raw json.RawMessage, key string) (string, bool) {
	obj, ok := inputObject(raw)
	if !ok {
		return "", false
	}
	var s string
	if v, ok := obj[key]; ok && json.Unmarshal(v, &s) == nil && s != "" {
		return s, true
	}
	return "", false
}

// inputArgv returns a field that is a non-empty array of strings (an argv), if it is one.
func inputArgv(raw json.RawMessage, key string) ([]string, bool) {
	obj, ok := inputObject(raw)
	if !ok {
		return nil, false
	}
	var argv []string
	if v, ok := obj[key]; ok && json.Unmarshal(v, &argv) == nil && len(argv) > 0 && argv[0] != "" {
		return argv, true
	}
	return nil, false
}

func inputObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil && obj != nil {
		return obj, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil && json.Unmarshal([]byte(s), &obj) == nil && obj != nil {
		return obj, true
	}
	return nil, false
}

// shellCall builds the command call for a shell tool from its command field, which is a command line or an argv.
func shellCall(raw json.RawMessage, key, cwd string, roots []string) *CommandCall {
	c := &CommandCall{Cwd: cwd, Workspace: roots}
	if line, ok := inputField(raw, key); ok {
		c.Shell = line
	} else if argv, ok := inputArgv(raw, key); ok {
		c.Argv = argv
	} else {
		c.Unresolved = "the coding agent's hook input does not show the command"
	}
	return c
}

// fileCall builds the command call for a file tool from its path field.
func fileCall(raw json.RawMessage, key, cwd string, roots []string, write bool) *CommandCall {
	c := &CommandCall{Cwd: cwd, Workspace: roots}
	if p, ok := inputField(raw, key); ok {
		c.Files = []FileAccess{{Path: p, Write: write}}
	} else {
		c.Unresolved = "the coding agent's hook input does not show the file"
	}
	return c
}

// patchPaths reads the file names an apply_patch envelope names ("*** Add File: p", "*** Update File: p",
// "*** Delete File: p", "*** Move to: p"). Every one is a write.
func patchPaths(patch string) []FileAccess {
	var out []FileAccess
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimRight(line, "\r")
		for _, h := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
			if p, ok := strings.CutPrefix(line, h); ok && strings.TrimSpace(p) != "" {
				out = append(out, FileAccess{Path: strings.TrimSpace(p), Write: true})
			}
		}
	}
	return out
}

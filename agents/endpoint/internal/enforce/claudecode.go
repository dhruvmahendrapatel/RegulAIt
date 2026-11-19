package enforce

// The Claude Code PreToolUse command-hook adapter (contract checked against code.claude.com/docs/en/hooks on
// 2026-11-14):
//   - input on stdin: JSON with hook_event_name, tool_name, tool_input, tool_use_id and, for an MCP tool, mcp_server
//     {name, source} (Claude Code v2.1.274 or later). MCP tool names are mcp__<server>__<tool>.
//   - output: exit 0 with {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow" |
//     "deny", "permissionDecisionReason": ...}}, or exit 0 with no output for no decision. Exit 2 blocks with stderr
//     as the reason; any other failure blocks only when the hook is registered with "onFailure": "block"
//     (v2.1.295 or later), which the registration this ADR documents always sets, in exec form ("args").
//
// Built-in tools (ADR-0350, contract re-checked 2026-11-17): Bash and PowerShell carry tool_input.command; Read
// carries tool_input.file_path; Write and Edit carry tool_input.file_path; NotebookEdit's notebook_path and MultiEdit
// are not in the field table, so they are read the same way and an input without the field is unresolved. Every one
// takes "ask" (permissionDecision), which shows Claude Code's own prompt. Files @-mentioned in a prompt are read
// with no tool call, so no hook sees them. The registration's matcher must name these tools
// (Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|mcp__.*) for command rules to apply.
//
// Trust is based on mcp_server.source, never on the tool-name prefix, as the contract advises. An MCP-shaped tool
// name without mcp_server (an older Claude Code, or a changed contract) is denied: the source cannot be checked.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
)

// ExitBlock is Claude Code's blocking exit code.
const ExitBlock = 2

type claudeInput struct {
	HookEventName string          `json:"hook_event_name"`
	ToolName      string          `json:"tool_name"`
	Cwd           string          `json:"cwd"`
	ToolInput     json.RawMessage `json:"tool_input"`
	// session_id and permission_mode are common input fields, read only for the decision record
	SessionID      string `json:"session_id"`
	PermissionMode string `json:"permission_mode"`
	MCPServer      *struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	} `json:"mcp_server"`
}

// ParseClaudeCodePreToolUse reads a PreToolUse hook input. Unknown fields are expected (the contract grows) and
// ignored; of tool_input only the command or path field of a built-in tool is read (ADR-0350).
func ParseClaudeCodePreToolUse(r io.Reader) (Call, error) {
	var in claudeInput
	if err := readHookInput(r, &in); err != nil {
		return Call{}, err
	}
	if in.HookEventName != "PreToolUse" {
		return Call{}, errors.New("not a PreToolUse event")
	}
	if in.ToolName == "" {
		return Call{}, errors.New("no tool_name")
	}
	c := Call{Tool: in.ToolName, SessionID: in.SessionID, PermissionMode: in.PermissionMode}
	// the cwd is never a workspace root by itself (review #941 S-B1): only a root the agent declares counts
	var roots []string
	switch in.ToolName {
	case "Bash":
		c.Command = shellCall(in.ToolInput, "command", in.Cwd, roots)
		return c, nil
	case "PowerShell":
		c.Command = &CommandCall{ShellUnparsable: true, Cwd: in.Cwd, Workspace: roots}
		return c, nil
	case "Read":
		c.Command = fileCall(in.ToolInput, "file_path", in.Cwd, roots, false)
		return c, nil
	case "Write", "Edit", "MultiEdit":
		c.Command = fileCall(in.ToolInput, "file_path", in.Cwd, roots, true)
		return c, nil
	case "NotebookEdit":
		c.Command = fileCall(in.ToolInput, "notebook_path", in.Cwd, roots, true)
		return c, nil
	}
	if in.MCPServer != nil {
		c.MCP = &MCPCall{Server: in.MCPServer.Name, Source: in.MCPServer.Source, Tool: mcpToolFromToolName(in.ToolName, in.MCPServer.Name)}
	} else if strings.HasPrefix(in.ToolName, "mcp__") {
		// MCP-shaped but without provenance: decided as an MCP call from an unknown source (denied unless the policy
		// accepts an empty source, which validate never allows)
		c.MCP = &MCPCall{Server: mcpServerFromToolName(in.ToolName)}
	}
	return c, nil
}

// readHookInput reads one bounded JSON hook input. Unknown fields are expected (every contract grows) and ignored.
func readHookInput(r io.Reader, v any) error {
	raw, err := io.ReadAll(io.LimitReader(r, maxEventBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxEventBytes {
		return errors.New("hook input too large")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(v); err != nil {
		return errors.New("hook input is not JSON")
	}
	if dec.More() {
		return errors.New("hook input has trailing data")
	}
	return nil
}

// mcpToolFromToolName reads the tool out of an mcp__<server>__<tool> name for a known server, or returns "". The
// agent writes the server part with every character outside [A-Za-z0-9_-] replaced by "_" (a server named gh.x is
// mcp__gh_x__...), so the name is matched in that form (review #952).
func mcpToolFromToolName(name, server string) string {
	for _, s := range []string{server, mcpNameForm.ReplaceAllString(server, "_")} {
		if t, ok := strings.CutPrefix(name, "mcp__"+s+"__"); ok && t != "" {
			return t
		}
	}
	return ""
}

var mcpNameForm = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// mcpServerFromToolName reads the server out of an mcp__<server>__<tool> name. Only Codex has no better source; for
// Claude Code it names the server of a call that arrived without provenance (which is then denied anyway).
func mcpServerFromToolName(tool string) string {
	rest := strings.TrimPrefix(tool, "mcp__")
	if i := strings.Index(rest, "__"); i > 0 {
		return rest[:i]
	}
	return ""
}

type claudeOutput struct {
	HookSpecificOutput struct {
		HookEventName            string `json:"hookEventName"`
		PermissionDecision       string `json:"permissionDecision"`
		PermissionDecisionReason string `json:"permissionDecisionReason"`
	} `json:"hookSpecificOutput"`
}

// RenderClaudeCode turns a decision into stdout bytes and an exit code. A deny is written both ways (JSON and exit
// 2) so it blocks even if the JSON were rejected by a future schema.
func RenderClaudeCode(d Decision) (stdout []byte, stderr string, exit int) {
	// "allow" would skip the user's permission prompt; an allowed server or command stays subject to Claude Code's
	// own permission flow, so an allow is reported as no decision. An ask shows that prompt even where the user's
	// settings would allow the call.
	if d.Verdict == Ask {
		var out claudeOutput
		out.HookSpecificOutput.HookEventName = "PreToolUse"
		out.HookSpecificOutput.PermissionDecision = "ask"
		out.HookSpecificOutput.PermissionDecisionReason = d.Reason
		b, _ := json.Marshal(out)
		return b, "", 0
	}
	return renderPreToolUseDeny(d)
}

// renderPreToolUseDeny is the hookSpecificOutput deny shape Claude Code and Codex share; anything but a deny is no
// output at all.
func renderPreToolUseDeny(d Decision) (stdout []byte, stderr string, exit int) {
	if d.Verdict != Deny {
		return nil, "", 0
	}
	var out claudeOutput
	out.HookSpecificOutput.HookEventName = "PreToolUse"
	out.HookSpecificOutput.PermissionDecision = "deny"
	out.HookSpecificOutput.PermissionDecisionReason = d.Reason
	b, _ := json.Marshal(out)
	return b, d.Reason, ExitBlock
}

// unreadable is the answer to a hook input that cannot be parsed: a block, with the reason but no input echoed.
func unreadable(err error) string {
	return "RegulAIt: the enforcement hook could not read this tool call (" + err.Error() + "), so it is blocked."
}

var claudeCodeAdapter = Adapter{
	Name: AgentClaudeCode,
	Contract: Contract{
		Version: "2026-11-17", Event: "PreToolUse",
		AgentVersions: "v2.1.274 or later (mcp_server); v2.1.295 or later (onFailure: block)",
		Docs:          []string{"https://code.claude.com/docs/en/hooks"},
	},
	Capabilities: Capabilities{
		CanBlock: true, MCPServer: ServerFromField, MCPProvenance: true,
		OnError: FailClosedIfConfigured, OnTimeout: FailClosedIfConfigured, ExecForm: true, ManagedLocation: true,
		Commands: CommandCapabilities{Shell: CoverAsk, FileRead: CoverAsk, FileWrite: CoverAsk, Notes: []string{
			"Files @-mentioned in a prompt are read without a tool call; no hook sees them.",
			"PowerShell commands are not parsed: each is unresolved (ask or deny by policy).",
			"NotebookEdit's notebook_path and MultiEdit are not in the vendor's field table; a missing path is unresolved.",
		}},
	},
	Coverage:        CoverageEnforce,
	RecommendedMode: ModeEnforce,
	Parse:           ParseClaudeCodePreToolUse,
	Render:          RenderClaudeCode,
}

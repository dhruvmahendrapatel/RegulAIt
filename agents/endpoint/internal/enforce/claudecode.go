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
// Trust is based on mcp_server.source, never on the tool-name prefix, as the contract advises. An MCP-shaped tool
// name without mcp_server (an older Claude Code, or a changed contract) is denied: the source cannot be checked.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// ExitBlock is Claude Code's blocking exit code.
const ExitBlock = 2

type claudeInput struct {
	HookEventName string `json:"hook_event_name"`
	ToolName      string `json:"tool_name"`
	MCPServer     *struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	} `json:"mcp_server"`
}

// ParseClaudeCodePreToolUse reads a PreToolUse hook input. Unknown fields are expected (the contract grows) and
// ignored; tool_input is never decoded, so arguments are never read.
func ParseClaudeCodePreToolUse(r io.Reader) (Call, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxEventBytes+1))
	if err != nil {
		return Call{}, err
	}
	if len(raw) > maxEventBytes {
		return Call{}, errors.New("hook input too large")
	}
	var in claudeInput
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&in); err != nil {
		return Call{}, errors.New("hook input is not JSON")
	}
	if in.HookEventName != "PreToolUse" {
		return Call{}, errors.New("not a PreToolUse event")
	}
	if in.ToolName == "" {
		return Call{}, errors.New("no tool_name")
	}
	c := Call{Tool: in.ToolName}
	if in.MCPServer != nil {
		c.MCP = &MCPCall{Server: in.MCPServer.Name, Source: in.MCPServer.Source}
	} else if strings.HasPrefix(in.ToolName, "mcp__") {
		// MCP-shaped but without provenance: decided as an MCP call from an unknown source (denied unless the policy
		// accepts an empty source, which validate never allows)
		c.MCP = &MCPCall{Server: mcpServerFromToolName(in.ToolName)}
	}
	return c, nil
}

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
	if d.Verdict == NoDecision {
		return nil, "", 0
	}
	var out claudeOutput
	out.HookSpecificOutput.HookEventName = "PreToolUse"
	out.HookSpecificOutput.PermissionDecisionReason = d.Reason
	if d.Verdict == Allow {
		// "allow" would skip the user's permission prompt; an allowed server stays subject to Claude Code's own
		// permission flow, so an allow is reported as no decision
		return nil, "", 0
	}
	out.HookSpecificOutput.PermissionDecision = "deny"
	b, _ := json.Marshal(out)
	return b, d.Reason, ExitBlock
}

// HookClaudeCode is the whole hook: parse, decide, render. A parse failure on an MCP-capable hook is a deny.
func HookClaudeCode(stdin io.Reader, policy *Policy) (stdout []byte, stderr string, exit int) {
	call, err := ParseClaudeCodePreToolUse(stdin)
	if err != nil {
		return nil, "RegulAIt: the enforcement hook could not read this tool call (" + err.Error() + "), so it is blocked.", ExitBlock
	}
	return RenderClaudeCode(Decide(policy, call))
}

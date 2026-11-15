package enforce

// The OpenAI Codex CLI PreToolUse command-hook adapter (ADR-0330; contract checked against
// developers.openai.com/codex/hooks and developers.openai.com/codex/enterprise/managed-configuration on 2026-11-15;
// hooks first shipped in rust-v0.114.0 and are on by default through [features].hooks):
//   - input on stdin: JSON with session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id,
//     tool_name, tool_use_id, tool_input. MCP tool names are mcp__<server>__<tool>; nothing else names the server.
//   - output: {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
//     "permissionDecisionReason": ...}}, or exit 2 with the reason on stderr. No output is no decision.
//   - failure: Codex documents no fail-closed setting, and documents that MCP-tool hook errors, missing servers and
//     unavailable tools do not block. THIS ADAPTER CANNOT FAIL CLOSED: a crash or timeout lets the call run. The
//     deny path itself is reliable (JSON and exit 2).
//   - registration: managed hooks in the [hooks] table of requirements.toml (/etc/codex/requirements.toml,
//     %ProgramData%\OpenAI\Codex\requirements.toml, or MDM), with allow_managed_hooks_only = true and
//     [features].hooks pinned on. The command is a shell string.
//
// What Codex cannot tell us: where a server was defined, or anything about it beyond the name inside the tool name.
// Calls are reported with source SourceCodexUnattested. Codex's own requirements.toml [mcp_servers.<name>] identity
// allow-list (command or URL) is the stronger, vendor-native control and is recommended alongside this hook.

import (
	"errors"
	"io"
	"strings"
)

type codexInput struct {
	HookEventName string `json:"hook_event_name"`
	ToolName      string `json:"tool_name"`
	// tool_input is never decoded
}

// ParseCodexPreToolUse reads a Codex PreToolUse hook input.
func ParseCodexPreToolUse(r io.Reader) (Call, error) {
	var in codexInput
	if err := readHookInput(r, &in); err != nil {
		return Call{}, err
	}
	if in.HookEventName != "PreToolUse" {
		return Call{}, errors.New("not a PreToolUse event")
	}
	if in.ToolName == "" {
		return Call{}, errors.New("no tool_name")
	}
	c := Call{Agent: AgentCodex, Tool: in.ToolName}
	if strings.HasPrefix(in.ToolName, "mcp__") {
		// a name that does not split into mcp__<server>__<tool> leaves Server empty, which Decide denies
		c.MCP = &MCPCall{Server: mcpServerFromToolName(in.ToolName), Source: SourceCodexUnattested}
	}
	return c, nil
}

// HookCodex is the whole Codex hook: parse, decide, render. An allow is no output (Codex's own approval policy
// still applies); a deny is the shared hookSpecificOutput JSON and exit 2. A parse failure is a deny.
func HookCodex(stdin io.Reader, policy *Policy) (stdout []byte, stderr string, exit int) {
	call, err := ParseCodexPreToolUse(stdin)
	if err != nil {
		return renderPreToolUseDeny(Decision{Verdict: Deny, Reason: unreadable(err)})
	}
	return renderPreToolUseDeny(Decide(policy, call))
}

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
// Built-in actions (ADR-0350, contract re-checked 2026-11-17): shell commands arrive as tool_name "Bash" with
// tool_input.command (a command line, or an argv); apply_patch arrives as tool_name "apply_patch" with the patch in
// tool_input.command, whose "*** Add/Update/Delete File:" and "*** Move to:" lines name the files written. Codex
// answers deny only ("ask" is parsed but not supported, and the call continues), so every ask rule is a deny here.
// There is no built-in read tool hook: reads happen through the shell (cat) and are decided as commands.
//
// What Codex cannot tell us: where a server was defined, or anything about it beyond the name inside the tool name.
// Calls are reported with the adapter's unattested source. Codex's own requirements.toml [mcp_servers.<name>] identity
// allow-list (command or URL) is the stronger, vendor-native control and is recommended alongside this hook.

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
)

type codexInput struct {
	HookEventName string          `json:"hook_event_name"`
	ToolName      string          `json:"tool_name"`
	Cwd           string          `json:"cwd"`
	ToolInput     json.RawMessage `json:"tool_input"`
	// of tool_input only the command field of Bash and apply_patch is read
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
	c := Call{Tool: in.ToolName, NoAsk: true}
	// the cwd is never a workspace root by itself (review #941 S-B1): only a root the agent declares counts
	var roots []string
	switch in.ToolName {
	case "Bash":
		c.Command = shellCall(in.ToolInput, "command", in.Cwd, roots)
		return c, nil
	case "apply_patch":
		cc := &CommandCall{Cwd: in.Cwd, Workspace: roots}
		if patch, ok := inputField(in.ToolInput, "command"); ok {
			cc.Files = patchPaths(patch)
		}
		if len(cc.Files) == 0 {
			cc.Unresolved = "the patch names no file this hook can read"
		}
		c.Command = cc
		return c, nil
	}
	if strings.HasPrefix(in.ToolName, "mcp__") {
		// a name that does not split into mcp__<server>__<tool> leaves Server empty, which Decide denies
		server := mcpServerFromToolName(in.ToolName)
		c.MCP = &MCPCall{Server: server, Tool: mcpToolFromToolName(in.ToolName, server)}
	}
	return c, nil
}

// An allow is no output (Codex's own approval policy still applies); a deny is the shared hookSpecificOutput JSON
// and exit 2.
var codexAdapter = Adapter{
	Name: AgentCodex,
	Contract: Contract{
		Version: "2026-11-17", Event: "PreToolUse",
		AgentVersions: "rust-v0.114.0 or later (hooks); on by default via [features].hooks",
		Docs: []string{"https://developers.openai.com/codex/hooks",
			"https://developers.openai.com/codex/enterprise/managed-configuration"},
	},
	Capabilities: Capabilities{
		CanBlock: true, MCPServer: ServerFromToolName, MCPProvenance: false,
		OnError: FailOpen, OnTimeout: FailOpen, ExecForm: false, ManagedLocation: true,
		Commands: CommandCapabilities{Shell: CoverBlock, FileRead: CoverNone, FileWrite: CoverBlock, Notes: []string{
			"Deny only: ask is not supported by Codex, so an ask rule is a deny.",
			"No read tool hook: reads through the shell are decided as commands, others are not seen.",
			"Writes are seen through apply_patch's file headers only.",
			"No declared workspace root: every patched file gets the outside-the-workspace default for writes.",
			"A hook error or timeout lets the call run (vendor behaviour): a guardrail, not a boundary.",
		}},
	},
	UnattestedSource: SourceCodexUnattested,
	// owner decision H2 (2026-11-15): presented as audit-grade (its hook errors fail open), paired with Codex's own
	// requirements.toml server-identity allow-list; its denies still block, so enforce mode stays recommended
	Coverage:        CoverageAudit,
	RecommendedMode: ModeEnforce,
	VendorControl:   "requirements.toml [mcp_servers.<name>] identity allow-list",
	Parse:           ParseCodexPreToolUse,
	Render:          renderPreToolUseDeny,
}

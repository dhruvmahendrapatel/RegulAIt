package enforce

// The GitHub Copilot CLI preToolUse command-hook adapter (ADR-0330; contract checked against
// docs.github.com/en/copilot/reference/hooks-reference and the Copilot CLI changelog, latest 1.0.112, on 2026-11-15):
//   - input on stdin, two documented forms:
//     camelCase (registered as "preToolUse"): {sessionId, timestamp, cwd, toolName, toolArgs};
//     PascalCase (registered as "PreToolUse"): {hook_event_name: "PreToolUse", session_id, timestamp, cwd,
//     tool_name, tool_input}, where tool_name is the Claude tool name for built-ins that have one.
//   - output: exit 0 with {"permissionDecision": "allow" | "deny" | "ask", "permissionDecisionReason": ...}. Exit 2
//     denies even if the JSON says allow. Empty stdout means no decision (the normal permission flow).
//   - failure: since 1.0.57 a crash or any non-zero exit denies (fail closed). A TIMEOUT ALWAYS FAILS OPEN, including
//     for admin policy hooks, and no setting changes that (default timeoutSec 30). The hook does no I/O beyond one
//     policy file read, so it stays far inside the timeout, but a stalled device can still let a call through.
//   - registration: policy hooks in /etc/github-copilot/policy.d/*.json (root-owned) or
//     C:\ProgramData\GitHub\Copilot\policy.d\*.json; they cannot be disabled by disableAllHooks. Exec form ("exec"
//     plus "args") runs without a shell.
//
// What Copilot CLI cannot tell us: the hook input names no MCP server and no definition source, and the reference
// does not document how MCP tool names are formed. This adapter therefore never guesses a server from a tool name.
// A tool named in the reference's built-in table gets no decision; every other tool (an MCP tool, an extension tool,
// or a built-in the table does not list) is an unattributed call, which Decide denies in enforce mode and reports as
// "would deny" in audit mode. Allowing MCP servers by name on Copilot CLI waits for GitHub to document server
// identity in the hook input; until then the vendor's own MCP registry allow-list is the server-level control.

import (
	"encoding/json"
	"errors"
	"io"
)

// copilotBuiltins is the built-in table in the hooks reference (runtime names and their Claude tool names), as
// checked on 2026-11-15. A name not listed here is decided as an unattributed call (fail closed).
var copilotBuiltins = map[string]bool{
	"bash": true, "powershell": true, "view": true, "create": true, "edit": true, "str_replace_editor": true,
	"apply_patch": true, "grep": true, "rg": true, "glob": true, "web_fetch": true, "web_search": true,
	"ask_user": true, "update_todo": true, "task": true,
	"Bash": true, "Read": true, "Write": true, "Edit": true, "Grep": true, "Glob": true, "WebFetch": true,
	"WebSearch": true, "AskUserQuestion": true, "TodoWrite": true, "Agent": true, "Task": true,
}

type copilotInput struct {
	// camelCase form
	ToolName string `json:"toolName"`
	// PascalCase form
	HookEventName string `json:"hook_event_name"`
	ToolNameSnake string `json:"tool_name"`
	// toolArgs and tool_input are never decoded
}

// ParseCopilotPreToolUse reads either documented preToolUse input form.
func ParseCopilotPreToolUse(r io.Reader) (Call, error) {
	var in copilotInput
	if err := readHookInput(r, &in); err != nil {
		return Call{}, err
	}
	tool := in.ToolName
	switch {
	case in.HookEventName == "" && in.ToolName != "" && in.ToolNameSnake == "":
	case in.HookEventName == "PreToolUse" && in.ToolNameSnake != "" && in.ToolName == "":
		tool = in.ToolNameSnake
	default:
		return Call{}, errors.New("not a preToolUse event")
	}
	c := Call{Tool: tool}
	if !copilotBuiltins[tool] {
		// an unattributed call: no server, so Decide denies it in enforce mode
		c.MCP = &MCPCall{}
	}
	return c, nil
}

type copilotOutput struct {
	PermissionDecision       string `json:"permissionDecision"`
	PermissionDecisionReason string `json:"permissionDecisionReason"`
}

// RenderCopilot turns a decision into stdout bytes and an exit code. An allow is no decision, so Copilot CLI's own
// permission flow still asks the user; a deny is JSON and exit 2.
func RenderCopilot(d Decision) (stdout []byte, stderr string, exit int) {
	if d.Verdict != Deny {
		return nil, "", 0
	}
	b, _ := json.Marshal(copilotOutput{PermissionDecision: "deny", PermissionDecisionReason: d.Reason})
	return b, d.Reason, ExitBlock
}

var copilotAdapter = Adapter{
	Name: AgentCopilotCLI,
	Contract: Contract{
		Version: "2026-11-15", Event: "preToolUse",
		AgentVersions: "1.0.57 or later (hook errors deny); checked up to 1.0.112",
		Docs: []string{"https://docs.github.com/en/copilot/reference/hooks-reference",
			"https://github.com/github/copilot-cli/blob/main/changelog.md"},
	},
	Capabilities: Capabilities{
		CanBlock: true, MCPServer: ServerNotVisible, MCPProvenance: false,
		OnError: FailClosed, OnTimeout: FailOpen, ExecForm: true, ManagedLocation: true,
	},
	UnattestedSource: SourceCopilotUnattested,
	Parse:            ParseCopilotPreToolUse,
	Render:           RenderCopilot,
}

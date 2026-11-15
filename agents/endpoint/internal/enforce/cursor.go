package enforce

// The Cursor beforeMCPExecution command-hook adapter (ADR-0330; contract checked against cursor.com/docs/hooks on
// 2026-11-15, Cursor 1.7 or later per the docs' sample cursor_version):
//   - input on stdin: JSON with the common fields (hook_event_name, cursor_version, conversation_id, ...) and, for
//     beforeMCPExecution, tool_name, tool_input (a JSON string), mcp_server_name (the server's key in mcp.json), and
//     url / mcp_server_url (HTTP and SSE servers) or command (stdio servers).
//   - output: exit 0 with {"permission": "allow" | "deny" | "ask", "user_message": ..., "agent_message": ...}. Exit 2
//     blocks. Invalid JSON blocks.
//   - failure: a crash, timeout or other non-zero exit lets the call proceed UNLESS the hook entry sets
//     "failClosed": true, which the registration ADR-0330 documents always sets. Team (dashboard) hooks cannot set
//     it, so only the enterprise (MDM) hooks.json location is supported.
//
// What Cursor cannot tell us: which mcp.json defined the server (enterprise, project or user). Every call is
// therefore reported with the adapter's unattested source, and a policy accepts Cursor's calls only by listing that
// source. The docs advise treating a missing mcp_server_name as a deny, and this adapter does.

import (
	"encoding/json"
	"errors"
	"io"
)

type cursorInput struct {
	HookEventName string `json:"hook_event_name"`
	CursorVersion string `json:"cursor_version"`
	ToolName      string `json:"tool_name"`
	MCPServerName string `json:"mcp_server_name"`
	// tool_input, url, mcp_server_url and command are never decoded: the decision does not use them, and a stdio
	// launch command can carry secrets in its arguments.
}

// ParseCursorBeforeMCP reads a beforeMCPExecution hook input. Every call on this event is an MCP call.
func ParseCursorBeforeMCP(r io.Reader) (Call, error) {
	var in cursorInput
	if err := readHookInput(r, &in); err != nil {
		return Call{}, err
	}
	if in.HookEventName != "beforeMCPExecution" {
		return Call{}, errors.New("not a beforeMCPExecution event")
	}
	if in.ToolName == "" {
		return Call{}, errors.New("no tool_name")
	}
	if in.CursorVersion == "" {
		// a common field on every documented event; its absence means a contract this adapter was not checked against
		return Call{}, errors.New("no cursor_version")
	}
	// a missing mcp_server_name leaves Server empty, which Decide denies
	return Call{Tool: in.ToolName, MCP: &MCPCall{Server: in.MCPServerName}}, nil
}

type cursorOutput struct {
	Permission   string `json:"permission"`
	UserMessage  string `json:"user_message,omitempty"`
	AgentMessage string `json:"agent_message,omitempty"`
}

// RenderCursor turns a decision into stdout bytes and an exit code. Cursor treats empty or invalid stdout as a
// block, so every answer is explicit JSON. An allow is "allow": the org approved the server, and Cursor's own
// run-confirmation settings are a separate control the hook does not replace. A deny is also exit 2.
func RenderCursor(d Decision) (stdout []byte, stderr string, exit int) {
	if d.Verdict == Deny {
		b, _ := json.Marshal(cursorOutput{Permission: "deny", UserMessage: d.Reason, AgentMessage: d.Reason})
		return b, d.Reason, ExitBlock
	}
	// NoDecision only arises in audit mode here (every call is MCP); audit never blocks
	b, _ := json.Marshal(cursorOutput{Permission: "allow"})
	return b, "", 0
}

var cursorAdapter = Adapter{
	Name: AgentCursor,
	Contract: Contract{
		Version: "2026-11-15", Event: "beforeMCPExecution",
		AgentVersions: "hooks as documented on 2026-11-15 (sample cursor_version 1.7.2; no minimum stated)",
		Docs:          []string{"https://cursor.com/docs/hooks"},
	},
	Capabilities: Capabilities{
		CanBlock: true, MCPServer: ServerFromField, MCPProvenance: false,
		OnError: FailClosedIfConfigured, OnTimeout: FailClosedIfConfigured, ExecForm: false, ManagedLocation: true,
	},
	UnattestedSource: SourceCursorUnattested,
	Parse:            ParseCursorBeforeMCP,
	Render:           RenderCursor,
}

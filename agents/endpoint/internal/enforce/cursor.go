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
// Built-in actions (ADR-0350, contract re-checked 2026-11-17): beforeShellExecution {command, cwd} answers allow,
// deny or ask and honours failClosed; beforeReadFile {file_path, content} answers allow or deny only, so an ask rule
// is answered as a deny there. File writes have no documented pre-hook with a path field (afterFileEdit runs after
// the edit; preToolUse's Write input is not documented), so this adapter decides no writes. The workspace is the
// common workspace_roots field. The registration adds these two events beside beforeMCPExecution.
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
	// beforeShellExecution and beforeReadFile; content (the whole file) is never decoded
	Command        string   `json:"command"`
	Cwd            string   `json:"cwd"`
	FilePath       string   `json:"file_path"`
	WorkspaceRoots []string `json:"workspace_roots"`
	// tool_input, url and mcp_server_url are never decoded. command is read only on beforeShellExecution; on
	// beforeMCPExecution (a stdio launch command, which can carry secrets) it is never used or echoed.
}

// ParseCursorBeforeMCP reads a beforeMCPExecution hook input. Every call on this event is an MCP call.
func ParseCursorBeforeMCP(r io.Reader) (Call, error) {
	var in cursorInput
	if err := readHookInput(r, &in); err != nil {
		return Call{}, err
	}
	if in.CursorVersion == "" {
		// a common field on every documented event; its absence means a contract this adapter was not checked against
		return Call{}, errors.New("no cursor_version")
	}
	roots := append([]string{}, in.WorkspaceRoots...)
	switch in.HookEventName {
	case "beforeShellExecution":
		c := &CommandCall{Shell: in.Command, Cwd: in.Cwd, Workspace: roots}
		if in.Command == "" {
			c.Unresolved = "the coding agent's hook input does not show the command"
		}
		return Call{Tool: "shell", Command: c}, nil
	case "beforeReadFile":
		c := &CommandCall{Workspace: roots}
		if in.FilePath == "" {
			c.Unresolved = "the coding agent's hook input does not show the file"
		} else {
			c.Files = []FileAccess{{Path: in.FilePath}}
		}
		return Call{Tool: "read", Command: c, NoAsk: true}, nil
	case "beforeMCPExecution":
	default:
		return Call{}, errors.New("not a beforeMCPExecution, beforeShellExecution or beforeReadFile event")
	}
	if in.ToolName == "" {
		return Call{}, errors.New("no tool_name")
	}
	// a missing mcp_server_name leaves Server empty, which Decide denies
	return Call{Tool: in.ToolName, MCP: &MCPCall{Server: in.MCPServerName, Tool: in.ToolName}}, nil
}

type cursorOutput struct {
	Permission   string `json:"permission"`
	UserMessage  string `json:"user_message,omitempty"`
	AgentMessage string `json:"agent_message,omitempty"`
}

// RenderCursor turns a decision into stdout bytes and an exit code. Every answer is explicit JSON: with failClosed,
// Cursor blocks on no output, and it blocks on invalid JSON always. Only a policy allow is "allow" (owner decision
// H3, 2026-11-15); a deny is "deny" and exit 2. Anything else (audit mode's would-deny) is "ask": audit observes and
// never approves a call the policy would block, so Cursor's own confirmation still applies (ADR-0180). Whether a hook "allow" skips Cursor's own run confirmation is NOT
// documented (cursor.com/docs/hooks, re-checked 2026-11-15: responses merge across sources, deny beats ask beats
// allow, nothing more). ADR-0330 §8 records it as a manual check against a real Cursor install.
func RenderCursor(d Decision) (stdout []byte, stderr string, exit int) {
	if d.Verdict == Deny {
		b, _ := json.Marshal(cursorOutput{Permission: "deny", UserMessage: d.Reason, AgentMessage: d.Reason})
		return b, d.Reason, ExitBlock
	}
	if d.Verdict == Allow && !d.WouldDeny {
		b, _ := json.Marshal(cursorOutput{Permission: "allow"})
		return b, "", 0
	}
	if d.Verdict == Ask {
		b, _ := json.Marshal(cursorOutput{Permission: "ask", UserMessage: d.Reason, AgentMessage: d.Reason})
		return b, "", 0
	}
	if d.NoAsk {
		// audit mode on beforeReadFile, which has no ask: audit never blocks, and a read has no Cursor confirmation
		// that an allow would skip (ADR-0350 §4)
		b, _ := json.Marshal(cursorOutput{Permission: "allow"})
		return b, "", 0
	}
	// NoDecision only arises in audit mode here (every call is MCP): never block, never approve
	b, _ := json.Marshal(cursorOutput{Permission: "ask"})
	return b, "", 0
}

var cursorAdapter = Adapter{
	Name: AgentCursor,
	Contract: Contract{
		Version: "2026-11-17", Event: "beforeMCPExecution, beforeShellExecution, beforeReadFile",
		AgentVersions: "hooks as documented on 2026-11-15 (sample cursor_version 1.7.2; no minimum stated)",
		Docs:          []string{"https://cursor.com/docs/hooks"},
	},
	Capabilities: Capabilities{
		CanBlock: true, MCPServer: ServerFromField, MCPProvenance: false,
		OnError: FailClosedIfConfigured, OnTimeout: FailClosedIfConfigured, ExecForm: false, ManagedLocation: true,
		Commands: CommandCapabilities{Shell: CoverAsk, FileRead: CoverBlock, FileWrite: CoverNone, Notes: []string{
			"beforeReadFile answers allow or deny only: an ask rule on a read is a deny.",
			"No documented pre-write hook with a path: file writes are not decided (afterFileEdit runs after the edit).",
			"Only the enterprise (MDM) hooks.json can set failClosed; dashboard hooks cannot.",
		}},
	},
	UnattestedSource: SourceCursorUnattested,
	Coverage:         CoverageEnforce,
	RecommendedMode:  ModeEnforce,
	Parse:            ParseCursorBeforeMCP,
	Render:           RenderCursor,
}

package enforce

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// adapterPolicy accepts the regulait server from Claude Code's managed source and, explicitly, from Cursor and Codex,
// which cannot attest where a server was defined (ADR-0330).
func adapterPolicy(mode string) *Policy {
	p := basePolicy()
	p.Mode = mode
	p.MCP.AllowSources = []string{"managed", SourceCursorUnattested, SourceCodexUnattested}
	return &p
}

func fixture(t *testing.T, agent, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "hooks", agent, name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

const (
	outNone  = "none"  // no stdout, exit 0: no decision
	outAllow = "allow" // explicit allow JSON, exit 0 (Cursor only)
	outDeny  = "deny"  // deny JSON and exit 2
)

func TestAdapterFixtures(t *testing.T) {
	enforcing, audit := adapterPolicy(ModeEnforce), adapterPolicy(ModeAudit)
	cases := []struct {
		agent, file string
		policy      *Policy
		want        string
	}{
		{AgentClaudeCode, "mcp-managed.json", enforcing, outNone},
		{AgentClaudeCode, "mcp-managed.json", nil, outDeny},

		{AgentCursor, "mcp-stdio-allowed.json", enforcing, outAllow},
		{AgentCursor, "mcp-stdio-allowed.json", nil, outDeny},
		{AgentCursor, "mcp-http-unlisted.json", enforcing, outDeny},
		{AgentCursor, "mcp-http-unlisted.json", audit, outAllow},
		{AgentCursor, "mcp-no-server-name.json", enforcing, outDeny},
		{AgentCursor, "mcp-no-server-name.json", audit, outAllow},
		{AgentCursor, "shell-event.json", enforcing, outDeny},

		{AgentCopilotCLI, "builtin-bash.json", enforcing, outNone},
		{AgentCopilotCLI, "builtin-bash.json", nil, outNone},
		{AgentCopilotCLI, "builtin-pascal.json", enforcing, outNone},
		{AgentCopilotCLI, "unlisted-tool.json", enforcing, outDeny},
		{AgentCopilotCLI, "unlisted-tool.json", audit, outNone},
		{AgentCopilotCLI, "unlisted-tool.json", nil, outDeny},

		{AgentCodex, "mcp-allowed.json", enforcing, outNone},
		{AgentCodex, "mcp-allowed.json", nil, outDeny},
		{AgentCodex, "mcp-unlisted.json", enforcing, outDeny},
		{AgentCodex, "mcp-unlisted.json", audit, outNone},
		{AgentCodex, "builtin-shell.json", nil, outNone},
	}
	for _, c := range cases {
		name := c.agent + "/" + c.file
		if c.policy == nil {
			name += " (no policy)"
		} else {
			name += " (" + c.policy.Mode + ")"
		}
		stdout, stderr, exit := Hooks[c.agent](bytes.NewReader(fixture(t, c.agent, c.file)), c.policy)
		if strings.Contains(string(stdout)+stderr, "secret-argument") {
			t.Errorf("%s: a tool argument or launch command reached the hook output", name)
		}
		switch c.want {
		case outNone:
			if exit != 0 || len(stdout) != 0 {
				t.Errorf("%s: want no decision, got exit %d %s", name, exit, stdout)
			}
		case outAllow:
			if exit != 0 || !bytes.Equal(stdout, []byte(`{"permission":"allow"}`)) {
				t.Errorf("%s: want an explicit allow, got exit %d %s", name, exit, stdout)
			}
		case outDeny:
			if exit != ExitBlock || stderr == "" || !isDenyJSON(c.agent, stdout) {
				t.Errorf("%s: want a deny, got exit %d %s", name, exit, stdout)
			}
		}
	}
}

// isDenyJSON checks the agent's own documented deny shape.
func isDenyJSON(agent string, stdout []byte) bool {
	var m map[string]any
	if json.Unmarshal(stdout, &m) != nil {
		return false
	}
	switch agent {
	case AgentCursor:
		return m["permission"] == "deny" && m["user_message"] != "" && m["agent_message"] != ""
	case AgentCopilotCLI:
		return m["permissionDecision"] == "deny" && m["permissionDecisionReason"] != ""
	default:
		h, _ := m["hookSpecificOutput"].(map[string]any)
		return h["hookEventName"] == "PreToolUse" && h["permissionDecision"] == "deny" && h["permissionDecisionReason"] != ""
	}
}

func TestAdaptersFailClosedOnUnreadableInput(t *testing.T) {
	p := adapterPolicy(ModeEnforce)
	bad := []string{"", "not json", `{"a":1} {"b":2}`, strings.Repeat(" ", maxEventBytes+1),
		`{"hook_event_name":"PostToolUse","tool_name":"mcp__a__b"}`}
	for agent, hook := range Hooks {
		for _, in := range bad {
			if stdout, _, exit := hook(strings.NewReader(in), p); exit != ExitBlock || !isDenyJSON(agent, stdout) {
				t.Errorf("%s: unreadable input %.20q does not block: %d %s", agent, in, exit, stdout)
			}
		}
	}
	// Copilot: both forms at once, or neither, is not a documented input
	for _, in := range []string{`{"toolName":"bash","tool_name":"Bash"}`, `{"hook_event_name":"PreToolUse","toolName":"bash"}`, `{"cwd":"/"}`} {
		if _, _, exit := HookCopilot(strings.NewReader(in), p); exit != ExitBlock {
			t.Errorf("copilot: ambiguous input %s does not block", in)
		}
	}
	// Cursor: an input without cursor_version is a contract this adapter was not checked against
	if _, _, exit := HookCursor(strings.NewReader(`{"hook_event_name":"beforeMCPExecution","tool_name":"t","mcp_server_name":"regulait"}`), p); exit != ExitBlock {
		t.Error("cursor: an input without cursor_version is decided")
	}
}

func TestUnattestedSourcesAreOptIn(t *testing.T) {
	// a policy that accepts only Claude Code's managed source does not admit the same server name from the agents
	// that cannot attest provenance
	p := basePolicy()
	p.MCP.AllowSources = []string{"managed"}
	for _, a := range []string{AgentCursor, AgentCodex} {
		file := map[string]string{AgentCursor: "mcp-stdio-allowed.json", AgentCodex: "mcp-allowed.json"}[a]
		if _, _, exit := Hooks[a](bytes.NewReader(fixture(t, a, file)), &p); exit != ExitBlock {
			t.Errorf("%s: an allowed name was admitted without its unattested source being accepted", a)
		}
	}
}

func TestAgentModes(t *testing.T) {
	p := adapterPolicy(ModeEnforce)
	p.AgentModes = map[string]string{AgentCopilotCLI: ModeAudit}
	if _, _, exit := HookCopilot(bytes.NewReader(fixture(t, AgentCopilotCLI, "unlisted-tool.json")), p); exit != 0 {
		t.Error("a per-agent audit mode did not apply")
	}
	if _, _, exit := HookCodex(bytes.NewReader(fixture(t, AgentCodex, "mcp-unlisted.json")), p); exit != ExitBlock {
		t.Error("a per-agent mode leaked to another agent")
	}

	keys, env := signed(t, func() Policy { q := basePolicy(); q.AgentModes = map[string]string{AgentCursor: ModeAudit}; return q }())
	if got, err := LoadPolicy(bytes.NewReader(env), keys, now); err != nil || got.modeFor(AgentCursor) != ModeAudit || got.modeFor(AgentCodex) != ModeEnforce {
		t.Errorf("agentModes did not load: %v", err)
	}
	for name, modes := range map[string]map[string]string{
		"unknown agent": {"vim": ModeAudit},
		"unknown mode":  {AgentCursor: "off"},
	} {
		q := basePolicy()
		q.AgentModes = modes
		keys, env := signed(t, q)
		if _, err := LoadPolicy(bytes.NewReader(env), keys, now); err == nil {
			t.Errorf("%s: agentModes accepted", name)
		}
	}
}

func TestEveryKnownAgentHasAHook(t *testing.T) {
	if len(Hooks) != len(KnownAgents) {
		t.Fatalf("%d hooks for %d agents", len(Hooks), len(KnownAgents))
	}
	for _, a := range KnownAgents {
		if Hooks[a] == nil {
			t.Errorf("no hook for %s", a)
		}
	}
}

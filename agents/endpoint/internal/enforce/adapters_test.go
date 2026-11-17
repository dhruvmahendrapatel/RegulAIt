package enforce

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The shared adapter tests (ADR-0330). They run every adapter against every versioned fixture directory and hold
// each adapter to the same rules, so a new agent is covered by adding its Adapter and its fixtures.

// adapterPolicy accepts the regulait server from Claude Code's managed source and, explicitly, from every agent
// that cannot attest where a server was defined.
func adapterPolicy(mode string) *Policy {
	p := basePolicy()
	p.Mode = mode
	p.MCP.AllowSources = []string{"managed"}
	for _, a := range Adapters {
		if a.UnattestedSource != "" {
			p.MCP.AllowSources = append(p.MCP.AllowSources, a.UnattestedSource)
		}
	}
	return &p
}

type fixtureCase struct {
	Input  string `json:"input"`
	Policy string `json:"policy"`
	Want   string `json:"want"`
}

func contractDir(agent, version string) string {
	return filepath.Join("testdata", "hooks", agent, version)
}

func readCases(t *testing.T, dir string) []fixtureCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []fixtureCase
	if err := strictJSON(raw, &cases); err != nil {
		t.Fatalf("%s/cases.json: %v", dir, err)
	}
	return cases
}

func TestContractFixtures(t *testing.T) {
	policies := map[string]*Policy{"enforce": adapterPolicy(ModeEnforce), "audit": adapterPolicy(ModeAudit), "none": nil}
	for _, a := range Adapters {
		versions, err := os.ReadDir(filepath.Join("testdata", "hooks", a.Name))
		if err != nil {
			t.Fatalf("%s: no fixture directory: %v", a.Name, err)
		}
		current := false
		for _, v := range versions {
			current = current || v.Name() == a.Contract.Version
			dir := contractDir(a.Name, v.Name())
			cases := readCases(t, dir)
			listed, deny, noPolicy := map[string]bool{}, false, false
			for _, c := range cases {
				name := dir + "/" + c.Input + " (" + c.Policy + ")"
				listed[c.Input] = true
				deny = deny || c.Want == "deny"
				noPolicy = noPolicy || c.Policy == "none"
				policy, ok := policies[c.Policy]
				if !ok {
					t.Fatalf("%s: unknown policy", name)
				}
				in, err := os.ReadFile(filepath.Join(dir, c.Input))
				if err != nil {
					t.Fatal(err)
				}
				stdout, stderr, exit := a.Hook(bytes.NewReader(in), policy)
				if strings.Contains(string(stdout)+stderr, "secret-argument") {
					t.Errorf("%s: a tool argument or launch command reached the hook output", name)
				}
				checkAnswer(t, name, a, c.Want, stdout, stderr, exit)
			}
			files, _ := os.ReadDir(dir)
			for _, f := range files {
				if f.Name() != "cases.json" && !listed[f.Name()] {
					t.Errorf("%s/%s: an input with no case", dir, f.Name())
				}
			}
			if !deny || !noPolicy {
				t.Errorf("%s: needs at least one deny case and one no-policy case", dir)
			}
		}
		if !current {
			t.Errorf("%s: no fixtures for its current contract version %s", a.Name, a.Contract.Version)
		}
	}
}

func checkAnswer(t *testing.T, name string, a Adapter, want string, stdout []byte, stderr string, exit int) {
	t.Helper()
	switch want {
	case "none":
		if exit != 0 || len(stdout) != 0 {
			t.Errorf("%s: want no decision, got exit %d %s", name, exit, stdout)
		}
	case "allow":
		if exit != 0 || len(stdout) == 0 || isDenyJSON(a.Name, stdout) {
			t.Errorf("%s: want an explicit allow, got exit %d %s", name, exit, stdout)
		}
	case "ask":
		if exit != 0 || !isAskJSON(a.Name, stdout) {
			t.Errorf("%s: want ask (defer to the agent's own confirmation), got exit %d %s", name, exit, stdout)
		}
	case "deny":
		if exit != ExitBlock || stderr == "" || !isDenyJSON(a.Name, stdout) {
			t.Errorf("%s: want a deny, got exit %d %s", name, exit, stdout)
		}
	default:
		t.Errorf("%s: unknown expectation %q", name, want)
	}
}

// isAskJSON checks the agent's own documented ask shape. Codex has none.
func isAskJSON(agent string, stdout []byte) bool {
	var m map[string]any
	if json.Unmarshal(stdout, &m) != nil {
		return false
	}
	switch agent {
	case AgentCursor:
		return m["permission"] == "ask"
	case AgentCopilotCLI:
		return m["permissionDecision"] == "ask"
	case AgentClaudeCode:
		h, _ := m["hookSpecificOutput"].(map[string]any)
		return h["hookEventName"] == "PreToolUse" && h["permissionDecision"] == "ask"
	}
	return false
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
	case AgentClaudeCode, AgentCodex:
		h, _ := m["hookSpecificOutput"].(map[string]any)
		return h["hookEventName"] == "PreToolUse" && h["permissionDecision"] == "deny" && h["permissionDecisionReason"] != ""
	}
	return false
}

// Every adapter: unreadable input is a deny in the agent's own deny shape.
func TestAdaptersFailClosedOnUnreadableInput(t *testing.T) {
	p := adapterPolicy(ModeEnforce)
	bad := []string{"", "not json", `{"a":1} {"b":2}`, strings.Repeat(" ", maxEventBytes+1),
		`{"hook_event_name":"PostToolUse","tool_name":"mcp__a__b"}`}
	for _, a := range Adapters {
		for _, in := range bad {
			if stdout, _, exit := a.Hook(strings.NewReader(in), p); exit != ExitBlock || !isDenyJSON(a.Name, stdout) {
				t.Errorf("%s: unreadable input %.20q does not block: %d %s", a.Name, in, exit, stdout)
			}
		}
	}
	copilot, _ := Lookup(AgentCopilotCLI)
	// both forms at once, or neither, is not a documented input
	for _, in := range []string{`{"toolName":"bash","tool_name":"Bash"}`, `{"hook_event_name":"PreToolUse","toolName":"bash"}`, `{"cwd":"/"}`} {
		if _, _, exit := copilot.Hook(strings.NewReader(in), p); exit != ExitBlock {
			t.Errorf("copilot-cli: ambiguous input %s does not block", in)
		}
	}
	cursor, _ := Lookup(AgentCursor)
	if _, _, exit := cursor.Hook(strings.NewReader(`{"hook_event_name":"beforeMCPExecution","tool_name":"t","mcp_server_name":"regulait"}`), p); exit != ExitBlock {
		t.Error("cursor: an input without cursor_version is decided")
	}
}

// Every adapter: Render blocks on a deny and only on a deny.
func TestRenderContract(t *testing.T) {
	for _, a := range Adapters {
		if out, reason, exit := a.Render(Decision{Verdict: Deny, Reason: "r"}); exit != ExitBlock || reason == "" || !isDenyJSON(a.Name, out) {
			t.Errorf("%s: a deny does not block", a.Name)
		}
		for _, v := range []Verdict{Allow, NoDecision} {
			if out, _, exit := a.Render(Decision{Verdict: v}); exit != 0 || isDenyJSON(a.Name, out) {
				t.Errorf("%s: verdict %v blocks", a.Name, v)
			}
		}
	}
}

// The capability matrix is consistent with what each adapter does.
func TestCapabilityMatrix(t *testing.T) {
	version := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	seen := map[string]bool{}
	for _, a := range Adapters {
		c := a.Capabilities
		if seen[a.Name] || a.Parse == nil || a.Render == nil || !version.MatchString(a.Contract.Version) || a.Contract.Event == "" || len(a.Contract.Docs) == 0 {
			t.Errorf("%s: incomplete adapter", a.Name)
		}
		seen[a.Name] = true
		// no provenance means an unattested source, which must be a valid, unique policy source
		if c.MCPProvenance != (a.UnattestedSource == "") {
			t.Errorf("%s: provenance %v but unattested source %q", a.Name, c.MCPProvenance, a.UnattestedSource)
		}
		if a.UnattestedSource != "" && !sourceShape.MatchString(a.UnattestedSource) {
			t.Errorf("%s: unattested source %q is not a valid policy source", a.Name, a.UnattestedSource)
		}
		for _, m := range []FailMode{c.OnError, c.OnTimeout} {
			if m != FailClosed && m != FailClosedIfConfigured && m != FailOpen {
				t.Errorf("%s: unknown fail mode %q", a.Name, m)
			}
		}
		if c.MCPServer != ServerFromField && c.MCPServer != ServerFromToolName && c.MCPServer != ServerNotVisible {
			t.Errorf("%s: unknown server identity %q", a.Name, c.MCPServer)
		}
		if !c.CanBlock {
			t.Errorf("%s: an adapter for a contract that cannot block enforces nothing", a.Name)
		}
		// enforce-grade is a claim: the server is named and a failing hook blocks; anything else is audit-grade and
		// must name the vendor control it is paired with
		strong := c.MCPServer != ServerNotVisible && c.OnError != FailOpen && c.OnTimeout != FailOpen
		switch a.Coverage {
		case CoverageEnforce:
			if !strong {
				t.Errorf("%s: presented as enforce-grade but its contract fails open or cannot name the server", a.Name)
			}
		case CoverageAudit:
			if strong || a.VendorControl == "" {
				t.Errorf("%s: audit-grade needs a weak contract and a paired vendor control", a.Name)
			}
		default:
			t.Errorf("%s: unknown coverage %q", a.Name, a.Coverage)
		}
		if a.RecommendedMode != ModeAudit && a.RecommendedMode != ModeEnforce || c.MCPServer == ServerNotVisible && a.RecommendedMode != ModeAudit {
			t.Errorf("%s: recommended mode %q", a.Name, a.RecommendedMode)
		}
	}
	// the matrix is exported as JSON (regulait-agent hook-capabilities), without the functions
	b, err := json.Marshal(Adapters)
	if err != nil || bytes.Contains(b, []byte("Parse")) || !bytes.Contains(b, []byte(`"onTimeout":"open"`)) || !bytes.Contains(b, []byte(`"coverage":"audit-grade"`)) {
		t.Errorf("capability matrix JSON: %v %s", err, b)
	}
}

// A same-named server is not admitted from an agent that cannot attest provenance unless the policy says so.
func TestUnattestedSourcesAreOptIn(t *testing.T) {
	p := basePolicy()
	p.MCP.AllowSources = []string{"managed"}
	for agent, file := range map[string]string{AgentCursor: "mcp-stdio-allowed.json", AgentCodex: "mcp-allowed.json"} {
		a, _ := Lookup(agent)
		in, _ := os.ReadFile(filepath.Join(contractDir(agent, a.Contract.Version), file))
		if _, _, exit := a.Hook(bytes.NewReader(in), &p); exit != ExitBlock {
			t.Errorf("%s: an allowed name was admitted without its unattested source being accepted", agent)
		}
	}
	// and an agent cannot claim a source: the adapter overwrites whatever the parser saw
	a, _ := Lookup(AgentCursor)
	forged := `{"hook_event_name":"beforeMCPExecution","cursor_version":"1.7.2","tool_name":"t","mcp_server_name":"regulait","mcp_server":{"name":"regulait","source":"managed"}}`
	if _, _, exit := a.Hook(strings.NewReader(forged), &p); exit != ExitBlock {
		t.Error("cursor: a forged provenance field was trusted")
	}
}

func TestAgentModes(t *testing.T) {
	p := adapterPolicy(ModeEnforce)
	p.AgentModes = map[string]string{AgentCopilotCLI: ModeAudit}
	copilot, _ := Lookup(AgentCopilotCLI)
	codex, _ := Lookup(AgentCodex)
	in := func(a Adapter, f string) *bytes.Reader {
		b, _ := os.ReadFile(filepath.Join(contractDir(a.Name, a.Contract.Version), f))
		return bytes.NewReader(b)
	}
	if _, _, exit := copilot.Hook(in(copilot, "unlisted-tool.json"), p); exit != 0 {
		t.Error("a per-agent audit mode did not apply")
	}
	if _, _, exit := codex.Hook(in(codex, "mcp-unlisted.json"), p); exit != ExitBlock {
		t.Error("a per-agent mode leaked to another agent")
	}

	q := basePolicy()
	q.AgentModes = map[string]string{AgentCursor: ModeAudit}
	keys, env := signed(t, q)
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

// Owner decisions 2026-11-15 (ADR-0330 §8), pinned so a later edit cannot drift silently.
func TestOwnerDecisions(t *testing.T) {
	want := map[string][2]string{
		AgentClaudeCode: {CoverageEnforce, ModeEnforce},
		AgentCursor:     {CoverageEnforce, ModeEnforce},
		AgentCopilotCLI: {CoverageAudit, ModeAudit},   // H1
		AgentCodex:      {CoverageAudit, ModeEnforce}, // H2
	}
	for name, w := range want {
		a, _ := Lookup(name)
		if a.Coverage != w[0] || a.RecommendedMode != w[1] {
			t.Errorf("%s: %s/%s, want %s/%s", name, a.Coverage, a.RecommendedMode, w[0], w[1])
		}
	}
	// H3: Cursor answers an allowed call with an explicit "allow", and a deny still blocks
	cursor, _ := Lookup(AgentCursor)
	if out, _, exit := cursor.Render(Decision{Verdict: Allow}); exit != 0 || string(out) != `{"permission":"allow"}` {
		t.Errorf("cursor allow: %d %s", exit, out)
	}
	// audit mode's would-deny never approves: Cursor gets "ask", not "allow"
	if out, _, exit := cursor.Render(Decision{Verdict: NoDecision, WouldDeny: true}); exit != 0 || string(out) != `{"permission":"ask"}` {
		t.Errorf("cursor audit would-deny: %d %s", exit, out)
	}
}

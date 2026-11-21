package decisionlog

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

var testNow = time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)

// testPolicy is decided against directly (DecideWith does not need a signed envelope).
func testPolicy(mode string) *enforce.Policy {
	return &enforce.Policy{
		Schema: enforce.PolicySchema, Subject: "u-1", Mode: mode, IssuedAt: testNow.Add(-time.Hour), NotAfter: testNow.Add(time.Hour),
		MCP: enforce.MCPRules{AllowServers: []string{"regulait"}, AllowSources: []string{"managed", enforce.SourceCodexUnattested, enforce.SourceCursorUnattested}},
		Commands: enforce.CommandRules{
			Default: enforce.RuleAllow, Unresolved: enforce.RuleAsk,
			Exec: []enforce.ExecRule{
				{ID: "git-push", Argv: []string{"git", "push", "**"}, Verdict: enforce.RuleAsk},
				{ID: "rm-rf", Argv: []string{"rm", "-rf", "**"}, Verdict: enforce.RuleDeny},
			},
			Files: enforce.FileRules{OutsideRead: enforce.RuleAsk, OutsideWrite: enforce.RuleDeny},
			Packages: enforce.PkgRules{Default: enforce.RuleAsk, Rules: []enforce.PkgRule{
				{ID: "left-pad", Ecosystem: "npm", Name: "left-pad", Verdict: enforce.RuleDeny},
			}},
		},
	}
}

func hook(t *testing.T, agent, input string, policy *enforce.Policy) (enforce.HookResult, Event) {
	t.Helper()
	a, ok := enforce.Lookup(agent)
	if !ok {
		t.Fatal(agent)
	}
	env := enforce.HookEnv{}
	if agent == enforce.AgentClaudeCode {
		env.ProjectDir = "/work"
	}
	r := a.HookDecide(strings.NewReader(input), policy, env)
	ref := strings.Repeat("a", 64)
	ev := NewEvent(agent, r.Call, r.Decision, policy, &ref, testNow)
	if err := Validate(ev); err != nil {
		t.Fatalf("%s: %v (%+v)", input, err, ev)
	}
	return r, ev
}

const (
	claudeMCPManaged = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"bypassPermissions","tool_name":"mcp__regulait__search","tool_input":{"q":"secret-argument"},"mcp_server":{"name":"regulait","source":"managed"}}`
	claudeMCPShadow  = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"mcp__shadow__x","tool_input":{"q":"secret-argument"},"mcp_server":{"name":"shadow","source":"project"}}`
	claudeGitPush    = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"git push origin main secret-argument"}}`
	claudeRmRf       = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"rm -rf /work/secret-argument"}}`
	claudeNpmLeftPad = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"npm install left-pad"}}`
	claudeReadOut    = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Read","tool_input":{"file_path":"/etc/secret-argument"}}`
	claudeWriteOut   = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Write","tool_input":{"file_path":"/etc/secret-argument"}}`
	claudeTodo       = `{"session_id":"s-1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"bypassPermissions","tool_name":"TodoWrite","tool_input":{"todos":"secret-argument"}}`
	codexGitPush     = `{"session_id":"thr_1","cwd":"/work","hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"git push secret-argument"}}`
	cursorShellPush  = `{"conversation_id":"c-1","hook_event_name":"beforeShellExecution","cursor_version":"1.7.2","workspace_roots":["/work"],"command":"git push secret-argument","cwd":"/work"}`
	copilotUnlisted  = `{"hook_event_name":"PreToolUse","session_id":"s-9","timestamp":"2026-11-15T10:00:00Z","cwd":"/work","tool_name":"some_mcp_tool","tool_input":{"q":"secret-argument"}}`
)

func TestDecisionEventMapping(t *testing.T) {
	enforcing, auditing := testPolicy(enforce.ModeEnforce), testPolicy(enforce.ModeAudit)
	type want struct {
		kind, emitter, action, verdict, mode string
		wouldDeny, wouldAsk                  bool
		rule                                 string // "" means null
	}
	cases := []struct {
		name, agent, input string
		policy             *enforce.Policy
		want               want
	}{
		{"mcp allowed", enforce.AgentClaudeCode, claudeMCPManaged, enforcing, want{kind: "decision", emitter: "mcp-rules", action: "mcp", verdict: "allow", mode: "enforce"}},
		{"mcp deny", enforce.AgentClaudeCode, claudeMCPShadow, enforcing, want{kind: "decision", emitter: "mcp-rules", action: "mcp", verdict: "deny", mode: "enforce"}},
		{"mcp no policy", enforce.AgentClaudeCode, claudeMCPManaged, nil, want{kind: "decision", emitter: "mcp-rules", action: "mcp", verdict: "deny", mode: "no_policy"}},
		{"mcp audit would deny", enforce.AgentClaudeCode, claudeMCPShadow, auditing, want{kind: "decision", emitter: "mcp-rules", action: "mcp", verdict: "none", mode: "audit", wouldDeny: true}},
		{"command ask", enforce.AgentClaudeCode, claudeGitPush, enforcing, want{kind: "decision", emitter: "command-rules", action: "command", verdict: "ask", mode: "enforce", rule: "git-push"}},
		{"command deny", enforce.AgentClaudeCode, claudeRmRf, enforcing, want{kind: "decision", emitter: "command-rules", action: "command", verdict: "deny", mode: "enforce", rule: "rm-rf"}},
		{"command audit would ask", enforce.AgentClaudeCode, claudeGitPush, auditing, want{kind: "decision", emitter: "command-rules", action: "command", verdict: "none", mode: "audit", wouldAsk: true, rule: "git-push"}},
		{"package deny", enforce.AgentClaudeCode, claudeNpmLeftPad, enforcing, want{kind: "decision", emitter: "command-rules", action: "package", verdict: "deny", mode: "enforce", rule: "left-pad"}},
		{"file read ask", enforce.AgentClaudeCode, claudeReadOut, enforcing, want{kind: "decision", emitter: "command-rules", action: "file_read", verdict: "ask", mode: "enforce", rule: "default.outside-read"}},
		{"file write deny", enforce.AgentClaudeCode, claudeWriteOut, enforcing, want{kind: "decision", emitter: "command-rules", action: "file_write", verdict: "deny", mode: "enforce", rule: "default.outside-write"}},
		{"command no policy", enforce.AgentClaudeCode, claudeGitPush, nil, want{kind: "decision", emitter: "command-rules", action: "command", verdict: "deny", mode: "no_policy", rule: "no-policy"}},
		// Codex cannot ask: the ask it was answered as a deny is what is recorded
		{"NoAsk ask becomes deny", enforce.AgentCodex, codexGitPush, enforcing, want{kind: "decision", emitter: "command-rules", action: "command", verdict: "deny", mode: "enforce", rule: "git-push"}},
		{"cursor shell ask", enforce.AgentCursor, cursorShellPush, enforcing, want{kind: "decision", emitter: "command-rules", action: "command", verdict: "ask", mode: "enforce", rule: "git-push"}},
		{"copilot unattributed audit", enforce.AgentCopilotCLI, copilotUnlisted, auditing, want{kind: "decision", emitter: "mcp-rules", action: "mcp", verdict: "none", mode: "audit", wouldDeny: true}},
		{"unreadable input", enforce.AgentClaudeCode, `not json`, enforcing, want{kind: "decision", emitter: "hook-input", action: "other", verdict: "deny", mode: "enforce", rule: enforce.RuleUnreadableInput}},
		// a plain no-decision is no decision event: a session event instead
		{"no decision", enforce.AgentClaudeCode, claudeTodo, enforcing, want{kind: "session"}},
	}
	for _, c := range cases {
		r, ev := hook(t, c.agent, c.input, c.policy)
		if ev.Kind != c.want.kind {
			t.Fatalf("%s: kind %s, want %s (%+v)", c.name, ev.Kind, c.want.kind, r.Decision)
		}
		if c.want.kind == "session" {
			if ev.Decision != nil {
				t.Fatalf("%s: session event with a decision", c.name)
			}
			continue
		}
		d := ev.Decision
		rule := ""
		if d.RuleID != nil {
			rule = *d.RuleID
		}
		got := want{kind: ev.Kind, emitter: d.Emitter, action: d.Action, verdict: d.Verdict, mode: d.Mode, wouldDeny: d.WouldDeny, wouldAsk: d.WouldAsk, rule: rule}
		if got != c.want {
			t.Fatalf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
		// the verdict recorded is the one answered: a deny is exit 2 for every adapter
		if (d.Verdict == "deny") != (r.Exit == enforce.ExitBlock) {
			t.Fatalf("%s: verdict %s but exit %d", c.name, d.Verdict, r.Exit)
		}
	}
}

func TestEventCarriesNoCallContent(t *testing.T) {
	for _, in := range []struct{ agent, input string }{
		{enforce.AgentClaudeCode, claudeMCPShadow}, {enforce.AgentClaudeCode, claudeRmRf}, {enforce.AgentClaudeCode, claudeWriteOut},
		{enforce.AgentCodex, codexGitPush}, {enforce.AgentCursor, cursorShellPush}, {enforce.AgentCopilotCLI, copilotUnlisted},
	} {
		_, ev := hook(t, in.agent, in.input, testPolicy(enforce.ModeEnforce))
		b, _ := json.Marshal(ev)
		for _, forbidden := range []string{"secret-argument", "/work", "/etc", "s-1", "thr_1", "c-1", "s-9", "shadow", "git push"} {
			if strings.Contains(string(b), forbidden) {
				t.Fatalf("%s event carries %q: %s", in.agent, forbidden, b)
			}
		}
	}
}

func TestPermissionMode(t *testing.T) {
	enforcing := testPolicy(enforce.ModeEnforce)
	mode := func(ev Event) string {
		if ev.PermissionMode == nil {
			return "<null>"
		}
		return *ev.PermissionMode
	}
	if _, ev := hook(t, enforce.AgentClaudeCode, claudeMCPManaged, enforcing); mode(ev) != "bypassPermissions" {
		t.Fatalf("claude-code mode %s", mode(ev))
	}
	if _, ev := hook(t, enforce.AgentCodex, codexGitPush, enforcing); mode(ev) != "default" {
		t.Fatalf("codex mode %s", mode(ev))
	}
	// a value that is not mode-shaped is not sent
	odd := strings.Replace(claudeGitPush, `"permission_mode":"default"`, `"permission_mode":"has space/../x"`, 1)
	if _, ev := hook(t, enforce.AgentClaudeCode, odd, enforcing); mode(ev) != "<null>" {
		t.Fatalf("odd mode sent: %s", mode(ev))
	}
	// Cursor and Copilot CLI report no mode, so their events never claim one, whatever the call says
	for _, agent := range []string{enforce.AgentCursor, enforce.AgentCopilotCLI} {
		ev := NewEvent(agent, enforce.Call{PermissionMode: "bypassPermissions", MCP: &enforce.MCPCall{}}, enforce.Decision{Verdict: enforce.Deny}, enforcing, nil, testNow)
		if ev.PermissionMode != nil || Validate(ev) != nil {
			t.Fatalf("%s: mode %s", agent, mode(ev))
		}
	}
}

func TestSessionIDsAreParsedForTheRecord(t *testing.T) {
	for _, c := range []struct{ agent, input, id string }{
		{enforce.AgentClaudeCode, claudeMCPManaged, "s-1"}, {enforce.AgentCodex, codexGitPush, "thr_1"},
		{enforce.AgentCursor, cursorShellPush, "c-1"}, {enforce.AgentCopilotCLI, copilotUnlisted, "s-9"},
		{enforce.AgentCopilotCLI, `{"sessionId":"s-cc","timestamp":1,"cwd":"/w","toolName":"bash","toolArgs":{"command":"ls"}}`, "s-cc"},
	} {
		if r, _ := hook(t, c.agent, c.input, nil); r.Call.SessionID != c.id {
			t.Fatalf("%s: session %q, want %q", c.agent, r.Call.SessionID, c.id)
		}
	}
}

func TestDecisionNeverBothWould(t *testing.T) {
	h, ok := Decision("command-rules", contract.ActionCommand, enforce.AgentClaudeCode, enforce.Decision{WouldDeny: true, WouldAsk: true, Rule: "not a rule id"}, testPolicy(enforce.ModeAudit))
	if !ok || h.WouldAsk || !h.WouldDeny || h.Verdict != "none" || h.RuleID != nil {
		t.Fatalf("%+v", h)
	}
	if _, ok := Decision("command-rules", contract.ActionCommand, enforce.AgentClaudeCode, enforce.Decision{}, nil); ok {
		t.Fatal("a plain no-decision became a decision")
	}
}

func TestValidateRefuses(t *testing.T) {
	ref := strings.Repeat("b", 64)
	good := NewEvent(enforce.AgentClaudeCode, enforce.Call{MCP: &enforce.MCPCall{}}, enforce.Decision{Verdict: enforce.Deny}, nil, &ref, testNow)
	if err := Validate(good); err != nil {
		t.Fatal(err)
	}
	str := func(s string) *string { return &s }
	for name, mut := range map[string]func(*Event){
		"eventId":         func(e *Event) { e.EventID = "x" },
		"occurredAt":      func(e *Event) { e.OccurredAt = "2026-11-18T12:00:00.5Z" },
		"offset":          func(e *Event) { e.OccurredAt = "2026-11-18T12:00:00+01:00" },
		"agent":           func(e *Event) { e.Agent = "other" },
		"sessionRef":      func(e *Event) { e.SessionRef = str("raw-session-id") },
		"kind":            func(e *Event) { e.Kind = "other" },
		"no decision":     func(e *Event) { e.Decision = nil },
		"session with":    func(e *Event) { e.Kind = "session" },
		"emitter":         func(e *Event) { e.Decision.Emitter = "Bad" },
		"verdict none":    func(e *Event) { e.Decision.Verdict = "none" },
		"mode":            func(e *Event) { e.Decision.Mode = "off" },
		"cursor mode":     func(e *Event) { e.Agent = enforce.AgentCursor; e.PermissionMode = str("default") },
		"ruleId":          func(e *Event) { e.Decision.RuleID = str("has space") },
		"both would":      func(e *Event) { e.Decision.WouldDeny, e.Decision.WouldAsk = true, true },
		"unknown action":  func(e *Event) { e.Decision.Action = "network" },
		"unknown verdict": func(e *Event) { e.Decision.Verdict = "maybe" },
	} {
		ev := good
		d := *good.Decision
		ev.Decision = &d
		mut(&ev)
		if Validate(ev) == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}

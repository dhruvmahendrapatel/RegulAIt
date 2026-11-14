package enforce

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)

func testKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{7}, 64)))
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func basePolicy() Policy {
	return Policy{
		Schema: PolicySchema, Subject: "u-0123456789abcdef", Mode: ModeEnforce,
		IssuedAt: now.Add(-time.Hour), NotAfter: now.Add(72 * time.Hour),
		MCP: MCPRules{AllowServers: []string{"regulait", "docs"}, DenyServers: []string{"docs"}, AllowSources: []string{"managed", "user"}},
	}
}

func sign(t *testing.T, priv ed25519.PrivateKey, keyID string, payload []byte) []byte {
	t.Helper()
	env := Envelope{KeyID: keyID, Payload: base64.StdEncoding.EncodeToString(payload),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))}
	b, _ := json.Marshal(env)
	return b
}

func signed(t *testing.T, p Policy) (Keyring, []byte) {
	t.Helper()
	pub, priv := testKey(t)
	payload, _ := json.Marshal(p)
	return Keyring{"regulait-policy-test": pub}, sign(t, priv, "regulait-policy-test", payload)
}

func TestLoadPolicyVerifies(t *testing.T) {
	keys, env := signed(t, basePolicy())
	p, err := LoadPolicy(bytes.NewReader(env), keys, now)
	if err != nil || p.Mode != ModeEnforce {
		t.Fatalf("a signed policy did not load: %v", err)
	}
}

func TestLoadPolicyRefuses(t *testing.T) {
	keys, env := signed(t, basePolicy())
	_, otherPriv, _ := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{9}, 64)))
	payload, _ := json.Marshal(basePolicy())
	tampered := bytes.Replace(env, []byte(`"payload":"`), []byte(`"payload":"A`), 1)

	mutate := func(f func(*Policy)) []byte {
		p := basePolicy()
		f(&p)
		_, e := signed(t, p)
		return e
	}
	cases := map[string]struct {
		keys Keyring
		env  []byte
	}{
		"the compiled keyring is empty": {CompiledKeyring, env},
		"wrong key":                     {keys, sign(t, otherPriv, "regulait-policy-test", payload)},
		"unpinned key id":               {keys, sign(t, otherPriv, "regulait-policy-other", payload)},
		"tampered payload":              {keys, tampered},
		"unknown envelope member":       {keys, bytes.Replace(env, []byte(`{`), []byte(`{"x":1,`), 1)},
		"not JSON":                      {keys, []byte("nope")},
		"expired":                       {keys, mutate(func(p *Policy) { p.NotAfter = now.Add(-time.Second) })},
		"from the future":               {keys, mutate(func(p *Policy) { p.IssuedAt = now.Add(time.Hour); p.NotAfter = now.Add(2 * time.Hour) })},
		"unknown mode":                  {keys, mutate(func(p *Policy) { p.Mode = "off" })},
		"unknown schema":                {keys, mutate(func(p *Policy) { p.Schema = "regulait.endpoint-enforcement/2" })},
		"bad server name":               {keys, mutate(func(p *Policy) { p.MCP.AllowServers = []string{"a b"} })},
		"empty source":                  {keys, mutate(func(p *Policy) { p.MCP.AllowSources = []string{""} })},
		"too large":                     {keys, bytes.Repeat([]byte(" "), maxPolicyBytes+1)},
	}
	for name, c := range cases {
		// testKey is deterministic, so every signed() case is signed by the key in keys
		if _, err := LoadPolicy(bytes.NewReader(c.env), c.keys, now); !errors.Is(err, ErrNoPolicy) {
			t.Errorf("%s: loaded (err %v)", name, err)
		}
	}
}

func TestDecide(t *testing.T) {
	p := basePolicy()
	audit := basePolicy()
	audit.Mode = ModeAudit
	mcp := func(server, source string) Call {
		return Call{Tool: "mcp__" + server + "__t", MCP: &MCPCall{Server: server, Source: source}}
	}
	cases := []struct {
		name   string
		policy *Policy
		call   Call
		want   Verdict
	}{
		{"non-MCP tools are not ours", &p, Call{Tool: "Bash"}, NoDecision},
		{"non-MCP tools without a policy are not ours either", nil, Call{Tool: "Edit"}, NoDecision},
		{"no policy: fail closed", nil, mcp("regulait", "managed"), Deny},
		{"allowed server and source", &p, mcp("regulait", "managed"), Allow},
		{"deny beats allow", &p, mcp("docs", "user"), Deny},
		{"unlisted server", &p, mcp("shadow", "user"), Deny},
		{"allowed name from an unaccepted source", &p, mcp("regulait", "project"), Deny},
		{"allowed name with no source", &p, mcp("regulait", ""), Deny},
		{"audit mode never blocks", &audit, mcp("shadow", "user"), NoDecision},
	}
	for _, c := range cases {
		if got := Decide(c.policy, c.call); got.Verdict != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got.Verdict, c.want)
		}
	}
	if d := Decide(&audit, mcp("shadow", "user")); !d.WouldDeny {
		t.Error("audit mode does not record what enforce would deny")
	}
}

func TestClaudeCodeHook(t *testing.T) {
	p := basePolicy()
	in := func(s string) *strings.Reader { return strings.NewReader(s) }
	mcpIn := `{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"mcp__regulait__search","tool_use_id":"t1",
	  "tool_input":{"q":"secret-argument"},"mcp_server":{"name":"regulait","source":"managed"},"future_field":true}`

	if out, _, code := HookClaudeCode(in(mcpIn), &p); code != 0 || out != nil {
		t.Errorf("an allowed call is not left to Claude Code's own permission flow: %d %s", code, out)
	}

	shadow := strings.ReplaceAll(mcpIn, `"regulait"`, `"shadow"`)
	out, reason, code := HookClaudeCode(in(shadow), &p)
	if code != ExitBlock || !strings.Contains(string(out), `"permissionDecision":"deny"`) || !strings.Contains(string(out), `"hookEventName":"PreToolUse"`) || reason == "" {
		t.Errorf("a denied call does not block: %d %s %q", code, out, reason)
	}
	if strings.Contains(string(out)+reason, "secret-argument") {
		t.Error("a tool argument reached the hook output")
	}

	if _, _, code := HookClaudeCode(in(mcpIn), nil); code != ExitBlock {
		t.Error("no policy does not fail closed")
	}
	if out, _, code := HookClaudeCode(in(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{}}`), nil); code != 0 || out != nil {
		t.Error("a non-MCP tool got a decision")
	}
	noProvenance := `{"hook_event_name":"PreToolUse","tool_name":"mcp__regulait__search","tool_input":{}}`
	if _, _, code := HookClaudeCode(in(noProvenance), &p); code != ExitBlock {
		t.Error("an MCP call without mcp_server provenance is allowed")
	}
	for _, bad := range []string{"", "not json", `{"hook_event_name":"PostToolUse","tool_name":"mcp__a__b"}`, `{"hook_event_name":"PreToolUse"}`} {
		if _, _, code := HookClaudeCode(in(bad), &p); code != ExitBlock {
			t.Errorf("unreadable input %q does not block", bad)
		}
	}
}

func TestToolNameServer(t *testing.T) {
	for in, want := range map[string]string{"mcp__memory__create": "memory", "mcp__brave-search__q": "brave-search", "mcp__x": "", "mcp____t": ""} {
		if got := mcpServerFromToolName(in); got != want {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}
}

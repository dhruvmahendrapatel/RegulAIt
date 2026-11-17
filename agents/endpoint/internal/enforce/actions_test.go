package enforce

import (
	"os"
	"path/filepath"
	"testing"
)

// The cross-route conformance test (ADR-0350 §9). It runs packages/shared/src/endpoint-actions-conformance.json, the
// file the TypeScript suite also runs against the gateway's decisions: every route of every case must give the
// expected verdict on the device too.

type conformance struct {
	Comment   string `json:"comment"`
	Scenarios []struct {
		Name    string `json:"name"`
		Servers []struct {
			ServerID     string   `json:"serverId"`
			Name         string   `json:"name"`
			UpstreamHost string   `json:"upstreamHost"`
			Tools        []string `json:"tools"`
		} `json:"servers"`
		Overrides []struct {
			Action  string `json:"action"`
			Verdict string `json:"verdict"`
		} `json:"overrides"`
		DeviceRules []ActionRule `json:"deviceRules"`
		Cases       []struct {
			Action string `json:"action"`
			Expect string `json:"expect"`
			MCP    *struct {
				Server string `json:"server"`
				Tool   string `json:"tool"`
			} `json:"mcp"`
			HTTP []struct {
				Method string `json:"method"`
				URL    string `json:"url"`
			} `json:"http"`
			CLI []string `json:"cli"`
		} `json:"cases"`
	} `json:"scenarios"`
}

var verdictName = map[Verdict]string{Allow: "allow", Ask: "ask", Deny: "deny", NoDecision: "none"}

func TestOnePolicyConformance(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "shared", "src", "endpoint-actions-conformance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx conformance
	if err := strictJSON(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Scenarios) == 0 {
		t.Fatal("no scenarios")
	}
	for _, s := range fx.Scenarios {
		p := basePolicy()
		// the compiled shape: the subject's servers allowed from the managed source, a strict default for every
		// other command, and the compiled action rules
		p.MCP = MCPRules{AllowSources: []string{"managed"}}
		for _, srv := range s.Servers {
			p.MCP.AllowServers = append(p.MCP.AllowServers, srv.Name)
		}
		p.Commands = CommandRules{Default: RuleAsk, Unresolved: RuleAsk,
			Files:    FileRules{OutsideRead: RuleAsk, OutsideWrite: RuleDeny},
			Packages: PkgRules{Default: RuleAsk}, Actions: s.DeviceRules}
		if err := p.validate(now); err != nil {
			t.Fatalf("%s: compiled policy refused: %v", s.Name, err)
		}
		for _, c := range s.Cases {
			name := s.Name + ": " + c.Action
			if c.MCP != nil {
				d := Decide(&p, Call{Agent: AgentClaudeCode, Tool: "mcp__" + c.MCP.Server + "__" + c.MCP.Tool,
					MCP: &MCPCall{Server: c.MCP.Server, Source: "managed", Tool: c.MCP.Tool}})
				if got := verdictName[d.Verdict]; got != c.Expect {
					t.Errorf("%s: MCP route gave %s, want %s", name, got, c.Expect)
				}
			}
			for _, h := range c.HTTP {
				if id, ok := httpActionID(h.Method, h.URL); !ok || id != c.Action {
					t.Errorf("%s: %s %s is not recognised as the action", name, h.Method, h.URL)
				}
				line := "curl -X " + h.Method + " '" + h.URL + "'"
				if got := verdictName[Decide(&p, shell(line)).Verdict]; got != c.Expect {
					t.Errorf("%s: %s gave %s, want %s", name, line, got, c.Expect)
				}
			}
			for _, line := range c.CLI {
				if got := verdictName[Decide(&p, shell(line)).Verdict]; got != c.Expect {
					t.Errorf("%s: %q gave %s, want %s", name, line, got, c.Expect)
				}
			}
		}
	}
}

func TestHTTPClients(t *testing.T) {
	for line, want := range map[string]string{
		"curl https://api.github.com/gists":                     "GET https://api.github.com/gists",
		"curl -d x https://api.github.com/gists":                "POST https://api.github.com/gists",
		"curl -XPUT --url https://a.test/x -H 'A: b'":           "PUT https://a.test/x",
		"curl -H 'X: https://no.test' https://api.github.com/x": "GET https://api.github.com/x",
		"wget --post-data=a https://a.test/p":                   "POST https://a.test/p",
		"http POST api.github.com/gists a=b":                    "POST http://api.github.com/gists",
		"https api.github.com/gists a=b":                        "POST https://api.github.com/gists",
		"gh api repos/o/r/issues -f title=x":                    "POST https://api.github.com/repos/o/r/issues",
		"gh api --hostname ghe.test -X DELETE /repos/o/r":       "DELETE https://api.ghe.test/repos/o/r",
	} {
		argv := shellActions(line)[0].argv
		m, u, ok := httpCall(argv)
		if got := m + " " + u; !ok || got != want {
			t.Errorf("%q: got %q (%v), want %q", line, got, ok, want)
		}
	}
	if _, _, ok := httpCall([]string{"gh", "api", "graphql", "-f", "query=x"}); ok {
		t.Error("gh api graphql is read as a REST call")
	}
}

func TestActionRulesRefused(t *testing.T) {
	for name, rules := range map[string][]ActionRule{
		"unknown action":  {{ID: "a1", Action: "github.repo.nuke", Verdict: RuleDeny}},
		"repeated action": {{ID: "a1", Action: "github.gist.create", Verdict: RuleDeny}, {ID: "a2", Action: "github.gist.create", Verdict: RuleDeny}},
		"bad verdict":     {{ID: "a1", Action: "github.gist.create", Verdict: "maybe"}},
		"bad server":      {{ID: "a1", Action: "github.gist.create", Verdict: RuleDeny, MCPServers: []string{"a b"}}},
	} {
		p := basePolicy()
		p.Commands.Actions = rules
		if err := p.validate(now); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

package enforce

// One policy, every route (ADR-0350 §9). The action catalogue (action-catalogue.json, generated from packages/shared
// ENDPOINT_ACTIONS and held equal to it by scripts/check-actions.mjs) names actions an agent can reach as an MCP
// tool, a CLI or a direct HTTP call. The control plane compiles one rule per action from the subject's gateway
// entitlements (commands.actions), and the device applies that rule on every route it can see: the MCP tool, the
// CLI argv, and the HTTP call inside curl, wget, httpie or gh api. The gateway applies the same rule to the MCP and
// connector routes, so the same action gets the same answer wherever it is reached.

import (
	_ "embed"
	"net/url"
	"path"
	"slices"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

//go:embed action-catalogue.json
var actionsJSON []byte

// EndpointAction is one catalogue entry.
type EndpointAction struct {
	ID    string       `json:"id"`
	Title string       `json:"title"`
	MCP   ActionMCP    `json:"mcp"`
	CLI   [][]string   `json:"cli"`
	HTTP  []ActionHTTP `json:"http"`
}

// ActionMCP names the upstream servers and tools that perform an action.
type ActionMCP struct {
	UpstreamHosts []string `json:"upstreamHosts"`
	Tools         []string `json:"tools"`
}

// ActionHTTP is one direct API call that performs an action; Path uses "*" for one segment.
type ActionHTTP struct {
	Method string `json:"method"`
	Host   string `json:"host"`
	Path   string `json:"path"`
}

// ActionRule is a compiled rule for one action (ADR-0350 §9).
type ActionRule struct {
	ID         string   `json:"id"`
	Action     string   `json:"action"`
	Verdict    string   `json:"verdict"`
	MCPServers []string `json:"mcpServers"`
}

// Actions is the embedded catalogue.
var Actions = mustActions()

func mustActions() []EndpointAction {
	var a []EndpointAction
	if err := strictJSON(actionsJSON, &a); err != nil || len(a) == 0 {
		panic("enforce: action-catalogue.json does not parse")
	}
	return a
}

func actionByID(id string) (EndpointAction, bool) {
	for _, a := range Actions {
		if a.ID == id {
			return a, true
		}
	}
	return EndpointAction{}, false
}

// actionRule is the policy's rule for an action, if it has one.
func (c *CommandRules) actionRule(id string) (ActionRule, bool) {
	for _, r := range c.Actions {
		if r.Action == id {
			return r, true
		}
	}
	return ActionRule{}, false
}

// actionMatch is one catalogue action an argv performs. exact: the argv was read completely and calls only its one
// target, so an "allow" for the action may relax the default for commands (review #952).
type actionMatch struct {
	id    string
	exact bool
}

// cliActions are the catalogue actions an argv performs, by its CLI form or by the HTTP call it makes.
func cliActions(argv []string) []actionMatch {
	var out []actionMatch
	if path.Base(argv[0]) == "gh" {
		g := ghWords(argv)
		norm := append(append([]string{argv[0]}, g.words...), g.rest...)
		_, complete := ghCall(g)
		for _, a := range Actions {
			for _, pats := range a.CLI {
				if argvMatch(pats, norm) {
					out = append(out, actionMatch{a.ID, complete})
					break
				}
			}
		}
	}
	if c, ok := httpClient(argv); ok {
		exact := c.complete && c.exact && len(c.urls) == 1
		for _, u := range c.urls {
			if id, ok := httpActionID(c.method, u); ok {
				out = append(out, actionMatch{id, exact})
			}
		}
	}
	return out
}

// mcpActions are the catalogue actions an MCP tool call performs under the policy's rules. With no tool name, every
// rule that names the server applies: the call may be any of them.
func mcpActions(c *CommandRules, server, tool string) []ActionRule {
	var out []ActionRule
	for _, r := range c.Actions {
		a, ok := actionByID(r.Action)
		if !ok || !servesAs(r.MCPServers, server) || (tool != "" && !slices.Contains(a.MCP.Tools, tool)) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// servesAs: the call's server is one of names, as written or in the mcp__<server>__ form an agent derives from it.
func servesAs(names []string, server string) bool {
	return slices.ContainsFunc(names, func(n string) bool { return n == server || mcpNameForm.ReplaceAllString(n, "_") == server })
}

// httpActionID is the catalogue action a request performs. The URL is read the way the gateway reads it
// (packages/shared httpAction): host lower case without a trailing dot, path with dot segments removed and
// compared case-insensitively.
func httpActionID(method, raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", false
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	p := strings.TrimRight(path.Clean("/"+strings.ReplaceAll(strings.ToLower(u.EscapedPath()), "%2e", ".")), "/")
	if p == "" {
		p = "/"
	}
	for _, a := range Actions {
		for _, h := range a.HTTP {
			// "*" is one non-empty segment; doublestar's * never crosses a "/"
			if ok, _ := doublestar.Match(h.Path, p); ok && h.Method == strings.ToUpper(method) && h.Host == host {
				return a.ID, true
			}
		}
	}
	return "", false
}

// validateActions checks the policy's action rules against the catalogue.
func validateActions(rules []ActionRule, use func(id, verdict string) error) error {
	seen := map[string]bool{}
	for _, r := range rules {
		if err := use(r.ID, r.Verdict); err != nil {
			return err
		}
		if _, ok := actionByID(r.Action); !ok || seen[r.Action] {
			return refuse("commands: action rule %q names an unknown or repeated action", r.ID)
		}
		seen[r.Action] = true
		if len(r.MCPServers) > 64 {
			return refuse("commands: action rule %q lists too many servers", r.ID)
		}
		for _, s := range r.MCPServers {
			if !serverShape.MatchString(s) {
				return refuse("commands: action rule %q server name", r.ID)
			}
		}
	}
	return nil
}

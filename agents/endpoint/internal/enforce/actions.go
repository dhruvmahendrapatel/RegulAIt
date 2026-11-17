package enforce

// One policy, every route (ADR-0350 §9). The action catalogue (actions.json, generated from packages/shared
// ENDPOINT_ACTIONS and held equal to it by scripts/check-actions.mjs) names actions an agent can reach as an MCP
// tool, a CLI or a direct HTTP call. The control plane compiles one rule per action from the subject's gateway
// entitlements (commands.actions), and the device applies that rule on every route it can see: the MCP tool, the
// CLI argv, and the HTTP call inside curl, wget, httpie or gh api. The gateway applies the same rule to the MCP and
// connector routes, so the same action gets the same answer wherever it is reached.

import (
	_ "embed"
	"net/url"
	"path"
	"strings"
)

//go:embed actions.json
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
		panic("enforce: actions.json does not parse")
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

// cliActions are the catalogue actions an argv performs, by its CLI form or by the HTTP call it makes.
func cliActions(argv []string) []string {
	var ids []string
	for _, a := range Actions {
		for _, pats := range a.CLI {
			if argvMatch(pats, argv) {
				ids = append(ids, a.ID)
				break
			}
		}
	}
	if method, raw, ok := httpCall(argv); ok {
		if id, ok := httpActionID(method, raw); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// mcpActions are the catalogue actions an MCP tool call performs under the policy's rules.
func mcpActions(c *CommandRules, server, tool string) []ActionRule {
	var out []ActionRule
	for _, r := range c.Actions {
		a, ok := actionByID(r.Action)
		if !ok || !contains(r.MCPServers, server) || !contains(a.MCP.Tools, tool) {
			continue
		}
		out = append(out, r)
	}
	return out
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func httpActionID(method, raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	p := strings.TrimRight(u.EscapedPath(), "/")
	if p == "" {
		p = "/"
	}
	for _, a := range Actions {
		for _, h := range a.HTTP {
			if h.Method == strings.ToUpper(method) && h.Host == host && segmentGlob(h.Path, p) {
				return a.ID, true
			}
		}
	}
	return "", false
}

func segmentGlob(pattern, p string) bool {
	ps, ss := strings.Split(pattern, "/"), strings.Split(p, "/")
	if len(ps) != len(ss) {
		return false
	}
	for i := range ps {
		if ps[i] == "*" {
			if ss[i] == "" {
				return false
			}
		} else if ps[i] != ss[i] {
			return false
		}
	}
	return true
}

// HTTP clients on a command line: the method and URL they will call. A call whose method or URL this table cannot
// read is not an action (it is still an exec action, decided by the exec rules).
var (
	curlValueOpts = set("-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer",
		"-b", "--cookie", "-c", "--cookie-jar", "-x", "--proxy", "-w", "--write-out", "-m", "--max-time",
		"--connect-timeout", "--retry", "-K", "--config", "--cacert", "--cert", "--key", "-E", "-r", "--range",
		"--resolve", "--connect-to", "-U", "--proxy-user", "--limit-rate", "-y", "-Y", "-z", "--oauth2-bearer")
	curlDataOpts = set("-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-F",
		"--form", "--form-string", "--json")
	ghAPIValueOpts = set("-H", "--header", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview")
	ghAPIDataOpts  = set("-f", "--raw-field", "-F", "--field", "--input")
	httpMethods    = set("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
)

func httpCall(argv []string) (method, raw string, ok bool) {
	switch path.Base(argv[0]) {
	case "curl":
		return curlCall(argv[1:])
	case "wget":
		return wgetCall(argv[1:])
	case "http", "https", "xh":
		return httpieCall(argv)
	case "gh":
		if len(argv) > 1 && argv[1] == "api" {
			return ghAPICall(argv[2:])
		}
	}
	return "", "", false
}

func curlCall(args []string) (string, string, bool) {
	method, raw, data := "", "", false
	for i := 0; i < len(args); i++ {
		a := args[i]
		k, v, eq := strings.Cut(a, "=")
		switch {
		case a == "-X" || a == "--request":
			if i+1 < len(args) {
				method, i = args[i+1], i+1
			}
		case strings.HasPrefix(a, "-X") && len(a) > 2:
			method = a[2:]
		case eq && k == "--request":
			method = v
		case a == "--url":
			if i+1 < len(args) {
				raw, i = args[i+1], i+1
			}
		case a == "-G" || a == "--get":
			method = "GET"
		case a == "-I" || a == "--head":
			method = "HEAD"
		case a == "-T" || a == "--upload-file":
			if method == "" {
				method = "PUT"
			}
			i++
		case curlDataOpts[a]:
			data, i = true, i+1
		case eq && curlDataOpts[k]:
			data = true
		case curlValueOpts[a]:
			i++
		case strings.HasPrefix(a, "-"):
		case raw == "":
			raw = a
		}
	}
	if method == "" {
		method = "GET"
		if data {
			method = "POST"
		}
	}
	return strings.ToUpper(method), raw, raw != ""
}

func wgetCall(args []string) (string, string, bool) {
	method, raw := "GET", ""
	for _, a := range args {
		k, v, _ := strings.Cut(a, "=")
		switch {
		case k == "--method":
			method = v
		case k == "--post-data" || k == "--post-file":
			method = "POST"
		case strings.HasPrefix(a, "-"):
		case raw == "":
			raw = a
		}
	}
	return strings.ToUpper(method), raw, raw != ""
}

func httpieCall(argv []string) (string, string, bool) {
	method, raw, data := "", "", false
	for _, a := range argv[1:] {
		switch {
		case strings.HasPrefix(a, "-"):
		case method == "" && raw == "" && httpMethods[strings.ToUpper(a)] && a == strings.ToUpper(a):
			method = a
		case raw == "":
			raw = a
			if !strings.Contains(raw, "://") {
				scheme := "http://"
				if path.Base(argv[0]) == "https" {
					scheme = "https://"
				}
				raw = scheme + raw
			}
		case strings.Contains(a, "="):
			data = true
		}
	}
	if method == "" {
		method = "GET"
		if data {
			method = "POST"
		}
	}
	return method, raw, raw != ""
}

func ghAPICall(args []string) (string, string, bool) {
	method, endpoint, host, data := "", "", "api.github.com", false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-X" || a == "--method":
			if i+1 < len(args) {
				method, i = args[i+1], i+1
			}
		case strings.HasPrefix(a, "--method="):
			method = strings.TrimPrefix(a, "--method=")
		case a == "--hostname":
			if i+1 < len(args) {
				host, i = "api."+args[i+1], i+1
			}
		case ghAPIDataOpts[a]:
			data, i = true, i+1
		case ghAPIValueOpts[a]:
			i++
		case strings.HasPrefix(a, "-"):
		case endpoint == "":
			endpoint = a
		}
	}
	if endpoint == "" || strings.Contains(endpoint, "{") || endpoint == "graphql" {
		return "", "", false
	}
	if method == "" {
		method = "GET"
		if data {
			method = "POST"
		}
	}
	return strings.ToUpper(method), "https://" + host + "/" + strings.TrimPrefix(endpoint, "/"), true
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

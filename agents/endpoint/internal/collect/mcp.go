package collect

// The mcp_config collector (ADR-0259): which MCP servers an MCP host's client config on this device names.
//
// The signed manifest names the config files (detection is data); this file holds only format knowledge (where
// each host keeps its server map) and a closed set of compiled risk checks. It is read-only: a config is read
// as bytes, parsed as plain JSON and dropped, and no configured server is ever started, contacted or resolved.
//
// What leaves the device for each server: an identifier-shaped entry name, the transport, the launch command's
// base name, the package or image it runs (without arguments), a remote server's host, a disabled flag, risk
// flag names, risky auto-approved tool names, and key presence (name and rule id, never a value). Arguments,
// environment values, header values and URL paths and queries are checked on the device and dropped.
//
// Design reference only (not a dependency, ADR-0176): apisec-inc/mcp-audit (MIT) for the hosts' config paths and
// its secret and risk categories. See ADR-0259 for why it is not run or vendored.

import (
	"bytes"
	"encoding/json"
	"net"
	"net/url"
	"sort"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/secrets"
)

const (
	// maxMCPServersPerFile caps the servers one config file yields.
	maxMCPServersPerFile = 100
	// maxRiskyTools caps the risky tool names one server reports.
	maxRiskyTools = 20
	// unnamed stands in for any entry, command, header or key name that is not identifier-shaped.
	unnamed = "(unnamed)"
)

// Pseudo rule ids for embedded secrets that no compiled `dlp.secret.*` pattern names. They are reported in the
// same `ruleId` field so the gateway can show the secret's type.
const (
	RuleNamedLiteral = "mcp.secret.named_literal"        // a secret-named env entry holds a literal, not a reference
	RuleAuthHeader   = "mcp.secret.authorization_header" // an Authorization header holds a literal credential
	RuleURLUserinfo  = "mcp.secret.url_userinfo"         // a server URL carries a user name and password
	RuleURLKey       = "mcp.secret.url_key"              // a server URL's query or path holds a key-shaped value
)

func (c *collector) mcpConfigs(entries []pack.Entry) {
	k := contract.KindMCPConfig
	for _, e := range entries {
		for _, l := range e.Files {
			fsys, files := c.glob(k, l)
			for _, name := range files {
				raw, ok := c.readBounded(k, fsys, name, 0)
				if !ok {
					continue
				}
				servers, parsed := mcpServersIn(raw)
				if !parsed {
					c.gap(k, GapMCPConfigUnparsed)
					continue
				}
				if len(servers) > maxMCPServersPerFile {
					c.gap(k, GapMCPServersTruncated)
					servers = servers[:maxMCPServersPerFile]
				}
				for _, s := range servers {
					srv := s
					c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "mcpServer", Identifier: l.Path,
						Location: contract.Location{Root: l.Root, Path: name}, Server: &srv})
				}
			}
		}
	}
}

// mcpServersIn parses a config as plain JSON and describes every server entry under the keys MCP hosts use.
// parsed is false when the file is not a JSON object (JSONC with comments, TOML, or damaged JSON).
func mcpServersIn(raw []byte) (out []contract.MCPServer, parsed bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var doc map[string]any
	if json.Unmarshal(trimmed, &doc) != nil {
		return nil, false
	}
	for _, m := range serverMaps(doc) {
		names := make([]string, 0, len(m))
		for n := range m {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			entry, ok := m[n].(map[string]any)
			if !ok || !looksLikeServer(entry) {
				continue
			}
			out = append(out, describeServer(n, entry))
		}
	}
	return out, true
}

// serverMaps returns the server maps of a parsed config, in a fixed order:
//   - `mcpServers` (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI, a project's .mcp.json)
//   - `servers` (VS Code mcp.json) and `mcp.servers` (VS Code settings.json)
//   - `context_servers` (Zed)
//   - `projects.<project>.mcpServers` (Claude Code's per-project servers; the project key, a path, is never kept)
func serverMaps(doc map[string]any) []map[string]any {
	var out []map[string]any
	pick := func(v any) {
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	pick(doc["mcpServers"])
	pick(doc["servers"])
	if mcp, ok := doc["mcp"].(map[string]any); ok {
		pick(mcp["servers"])
	}
	pick(doc["context_servers"])
	if projects, ok := doc["projects"].(map[string]any); ok {
		keys := make([]string, 0, len(projects))
		for p := range projects {
			keys = append(keys, p)
		}
		sort.Strings(keys)
		for _, p := range keys {
			if proj, ok := projects[p].(map[string]any); ok {
				pick(proj["mcpServers"])
			}
		}
	}
	return out
}

// looksLikeServer: an entry that names a command or a URL. Anything else under a server key (a VS Code
// `servers` map of something else, a Zed extension entry) is not a server.
func looksLikeServer(e map[string]any) bool {
	for _, k := range []string{"command", "url", "serverUrl", "httpUrl"} {
		if s, ok := e[k].(string); ok && strings.TrimSpace(s) != "" {
			return true
		}
	}
	// Zed: {"command": {"path": …, "args": […]}}
	if cmd, ok := e["command"].(map[string]any); ok {
		_, has := cmd["path"].(string)
		return has
	}
	return false
}

func describeServer(name string, e map[string]any) contract.MCPServer {
	s := contract.MCPServer{Name: name}
	if !serverName(name) {
		s.Name = unnamed
	}
	risks := map[string]bool{}
	command, args := commandOf(e)
	rawURL := firstString(e, "url", "serverUrl", "httpUrl")

	switch t := strings.ToLower(firstString(e, "type", "transport")); {
	case t == "stdio":
		s.Transport = contract.MCPTransportStdio
	case t == "sse":
		s.Transport = contract.MCPTransportSSE
	case t == "http" || t == "streamable-http" || t == "streamablehttp" || t == "streamable_http":
		s.Transport = contract.MCPTransportHTTP
	case rawURL != "":
		s.Transport = contract.MCPTransportHTTP
		if u, err := url.Parse(rawURL); err == nil && strings.HasSuffix(strings.TrimRight(u.Path, "/"), "/sse") {
			s.Transport = contract.MCPTransportSSE
		}
	case command != "":
		s.Transport = contract.MCPTransportStdio
	default:
		s.Transport = contract.MCPTransportUnknown
	}

	var keys []contract.KeyFound
	if command != "" {
		base := commandBase(command)
		// Windows wraps launchers in `cmd /c`: describe what it runs
		if base == "cmd" && len(args) >= 2 && (strings.EqualFold(args[0], "/c") || strings.EqualFold(args[0], "/k")) {
			base, args = commandBase(args[1]), args[2:]
		}
		if commandName(base) {
			s.Command = base
		} else {
			s.Command = unnamed
		}
		if shellLauncher(base, args) {
			risks[contract.MCPRiskShellLauncher] = true
		}
		pkg, version, pinned, container := packageOf(base, args)
		if pkg != "" {
			s.Package, s.PackageVersion = pkg, version
			if !pinned {
				risks[contract.MCPRiskUnpinnedPackage] = true
			}
		}
		if container && containerPrivileged(args) {
			risks[contract.MCPRiskContainerPrivileged] = true
		}
		if rootMount(args, container) {
			risks[contract.MCPRiskHostRootMount] = true
		}
		for _, a := range args {
			v := a
			if i := strings.IndexByte(a, '='); i > 0 && strings.HasPrefix(a, "-") {
				v = a[i+1:]
			}
			if secrets.Match(v) != "" {
				risks[contract.MCPRiskSecretInArgs] = true
				break
			}
		}
	}
	if rawURL != "" {
		host, plaintext, urlKeys := describeURL(rawURL)
		s.Host = host
		if plaintext {
			risks[contract.MCPRiskPlaintextRemote] = true
		}
		keys = append(keys, urlKeys...)
	}
	keys = append(keys, envKeys(e["env"])...)
	keys = append(keys, headerKeys(e["headers"])...)
	s.Keys = mergeKeys(keys)

	if b, ok := e["disabled"].(bool); ok && b {
		s.Disabled = true
	}
	if b, ok := e["enabled"].(bool); ok && !b {
		s.Disabled = true
	}

	// auto-approval: Cline/Roo `alwaysAllow`, Cline/Amazon Q `autoApprove`; Gemini CLI `trust: true` skips every
	// confirmation for the server
	if b, ok := e["trust"].(bool); ok && b {
		risks[contract.MCPRiskAutoApproveAll] = true
	}
	seen := map[string]bool{}
	for _, k := range []string{"alwaysAllow", "autoApprove"} {
		list, _ := e[k].([]any)
		for _, item := range list {
			tool, ok := item.(string)
			if !ok {
				continue
			}
			tool = strings.TrimSpace(tool)
			if tool == "*" {
				risks[contract.MCPRiskAutoApproveAll] = true
				continue
			}
			if tool == "" || seen[tool] {
				continue
			}
			seen[tool] = true
			s.AutoApprovedTools++
			if riskyToolName(tool) {
				risks[contract.MCPRiskRiskyToolAutoApproved] = true
				if toolName(tool) && len(s.RiskyTools) < maxRiskyTools {
					s.RiskyTools = append(s.RiskyTools, tool)
				}
			}
		}
		if b, ok := e[k].(bool); ok && b {
			risks[contract.MCPRiskAutoApproveAll] = true
		}
	}
	sort.Strings(s.RiskyTools)
	for _, r := range contract.MCPRiskFlags {
		if risks[r] {
			s.Risks = append(s.Risks, r)
		}
	}
	return s
}

// commandOf reads `command` and `args`, including Zed's {"command": {"path", "args"}} form. Non-string
// arguments are skipped.
func commandOf(e map[string]any) (string, []string) {
	command := stringOf(e["command"])
	rawArgs, _ := e["args"].([]any)
	if zed, ok := e["command"].(map[string]any); ok {
		command = stringOf(zed["path"])
		rawArgs, _ = zed["args"].([]any)
	}
	command = strings.TrimSpace(command)
	args := make([]string, 0, len(rawArgs))
	for _, a := range rawArgs {
		if s, ok := a.(string); ok {
			args = append(args, s)
		}
	}
	// a command line in one string ("npx -y pkg"): split on spaces, which is how hosts that accept it split it
	if !strings.ContainsAny(command, `/\`) && strings.Contains(command, " ") {
		parts := strings.Fields(command)
		command, args = parts[0], append(parts[1:], args...)
	}
	return command, args
}

// commandBase is the base name of a command path, lower-cased, without a Windows executable suffix.
func commandBase(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	if i := strings.LastIndexAny(cmd, `/\`); i >= 0 {
		cmd = cmd[i+1:]
	}
	cmd = strings.ToLower(cmd)
	for _, suf := range []string{".exe", ".cmd", ".bat", ".ps1"} {
		if len(cmd) > len(suf) && strings.HasSuffix(cmd, suf) {
			return cmd[:len(cmd)-len(suf)]
		}
	}
	return cmd
}

var shells = map[string]bool{"sh": true, "bash": true, "zsh": true, "fish": true, "dash": true, "ksh": true, "pwsh": true, "powershell": true}

// shellLauncher: a shell given a command string to run.
func shellLauncher(base string, args []string) bool {
	if !shells[base] {
		return false
	}
	for _, a := range args {
		switch strings.ToLower(a) {
		case "-c", "-lc", "-ic", "-command", "-encodedcommand", "-ec", "/c":
			return true
		}
	}
	return false
}

// valueFlags are the container run options that take a separate value.
var valueFlags = map[string]bool{
	"-e": true, "--env": true, "--env-file": true, "-v": true, "--volume": true, "--mount": true, "-p": true, "--publish": true,
	"--name": true, "--network": true, "--net": true, "-w": true, "--workdir": true, "-u": true, "--user": true,
	"--entrypoint": true, "-l": true, "--label": true, "--add-host": true, "--cap-add": true, "--cap-drop": true,
	"--platform": true, "--pid": true, "--userns": true, "--security-opt": true, "--hostname": true, "-h": true,
	"--memory": true, "-m": true, "--cpus": true, "--device": true, "--ipc": true, "--uts": true, "--pull": true,
}

// packageOf finds what a package runner or container engine runs. pinned is true only for an exact version (or a
// digest); container is true for docker and podman.
func packageOf(base string, args []string) (pkg, version string, pinned, container bool) {
	switch base {
	case "npx", "bunx", "pnpx":
		return npmSpec(firstOperand(args, map[string]bool{"-p": true, "--package": true}, []string{"--package", "-p"}))
	case "pnpm", "yarn", "bun":
		if len(args) > 0 && (args[0] == "dlx" || args[0] == "x") {
			return npmSpec(firstOperand(args[1:], map[string]bool{"-p": true, "--package": true}, []string{"--package", "-p"}))
		}
	case "uvx":
		return pypiSpec(firstOperand(args, map[string]bool{"--from": true, "--with": true, "--python": true, "-p": true, "--index-url": true, "--extra-index-url": true}, []string{"--from"}))
	case "uv":
		if len(args) > 1 && args[0] == "tool" && args[1] == "run" {
			return pypiSpec(firstOperand(args[2:], map[string]bool{"--from": true, "--with": true, "--python": true, "-p": true}, []string{"--from"}))
		}
	case "pipx":
		if len(args) > 0 && args[0] == "run" {
			return pypiSpec(firstOperand(args[1:], map[string]bool{"--spec": true, "--python": true}, []string{"--spec"}))
		}
	case "docker", "podman":
		if len(args) > 0 && (args[0] == "run" || (len(args) > 1 && args[0] == "container" && args[1] == "run")) {
			rest := args[1:]
			if args[0] == "container" {
				rest = args[2:]
			}
			p, v, pin, _ := imageSpec(firstOperand(rest, valueFlags, nil))
			return p, v, pin, true
		}
		return "", "", false, true
	}
	return "", "", false, false
}

// firstOperand returns the value of the first preferred flag present (`--from pkg`, `--from=pkg`), else the first
// argument that is not a flag or a flag's value.
func firstOperand(args []string, takesValue map[string]bool, preferred []string) string {
	for _, p := range preferred {
		for i, a := range args {
			if a == p && i+1 < len(args) {
				return args[i+1]
			}
			if strings.HasPrefix(a, p+"=") {
				return a[len(p)+1:]
			}
		}
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		}
		if strings.HasPrefix(a, "-") {
			if takesValue[a] {
				i++
			}
			continue
		}
		return a
	}
	return ""
}

// movingVersions are tags or ranges that do not pin what runs.
func movingVersion(v string) bool {
	l := strings.ToLower(v)
	return l == "" || l == "latest" || l == "next" || l == "*" || l == "x" || strings.ContainsAny(l, "^~<>*| ") || strings.HasSuffix(l, ".x")
}

func npmSpec(spec string) (pkg, version string, pinned, container bool) {
	spec = strings.TrimPrefix(strings.TrimSpace(spec), "npm:")
	if spec == "" {
		return "", "", false, false
	}
	name, ver := spec, ""
	if i := strings.LastIndexByte(spec, '@'); i > 0 {
		name, ver = spec[:i], spec[i+1:]
	}
	if !npmName(name) {
		return "", "", false, false
	}
	if ver != "" && !versionShape(ver) {
		ver = ""
	}
	return name, ver, !movingVersion(ver), false
}

func pypiSpec(spec string) (pkg, version string, pinned, container bool) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return "", "", false, false
	}
	name, ver := spec, ""
	if i := strings.Index(spec, "=="); i > 0 {
		name, ver = spec[:i], spec[i+2:]
	} else if i := strings.IndexByte(spec, '@'); i > 0 {
		name, ver = spec[:i], spec[i+1:]
	} else if i := strings.IndexAny(spec, "<>=!~"); i > 0 {
		name, ver = spec[:i], "*"
	}
	if i := strings.IndexByte(name, '['); i > 0 {
		name = name[:i]
	}
	name = strings.ToLower(name)
	if !pypiName(name) {
		return "", "", false, false
	}
	if ver != "" && !versionShape(ver) {
		ver = ""
	}
	return name, ver, !movingVersion(ver), false
}

func imageSpec(ref string) (pkg, version string, pinned, container bool) {
	ref = strings.ToLower(strings.TrimSpace(ref))
	if ref == "" {
		return "", "", false, true
	}
	if i := strings.Index(ref, "@sha256:"); i > 0 {
		digest := ref[i+len("@sha256:"):]
		if len(digest) == 64 && hexOnly(digest) && imageName(ref[:i]) {
			name := ref[:i]
			if j := strings.LastIndexByte(name, ':'); j > strings.LastIndexByte(name, '/') {
				name = name[:j]
			}
			return name, "sha256:" + digest[:12], true, true
		}
		return "", "", false, true
	}
	name, tag := ref, ""
	if j := strings.LastIndexByte(ref, ':'); j > strings.LastIndexByte(ref, '/') {
		name, tag = ref[:j], ref[j+1:]
	}
	if !imageName(name) {
		return "", "", false, true
	}
	if tag != "" && !versionShape(tag) {
		tag = ""
	}
	return name, tag, !movingVersion(tag), true
}

// containerPrivileged: options that give the container the host's privileges.
func containerPrivileged(args []string) bool {
	for i, a := range args {
		l := strings.ToLower(a)
		next := ""
		if i+1 < len(args) {
			next = strings.ToLower(args[i+1])
		}
		switch {
		case l == "--privileged" || l == "--privileged=true":
			return true
		case l == "--cap-add" || strings.HasPrefix(l, "--cap-add="):
			return true
		case l == "--pid=host" || l == "--network=host" || l == "--net=host" || l == "--userns=host" || l == "--ipc=host" || l == "--uts=host":
			return true
		case (l == "--pid" || l == "--network" || l == "--net" || l == "--userns" || l == "--ipc" || l == "--uts") && next == "host":
			return true
		case (l == "--security-opt" && strings.Contains(next, "unconfined")) || (strings.HasPrefix(l, "--security-opt=") && strings.Contains(l, "unconfined")):
			return true
		}
	}
	return false
}

// rootPaths are values that name the filesystem root or the user's home directory as a whole.
func rootPath(v string) bool {
	v = strings.TrimSpace(v)
	switch strings.ToLower(v) {
	case "/", "~", "~/", "$home", "${home}", "%userprofile%", "${userhome}", "${env:home}", "${env:userprofile}":
		return true
	}
	if len(v) >= 2 && len(v) <= 3 && (v[0] >= 'a' && v[0] <= 'z' || v[0] >= 'A' && v[0] <= 'Z') && v[1] == ':' && (len(v) == 2 || v[2] == '\\' || v[2] == '/') {
		return true // C:, C:\ or C:/
	}
	return false
}

// rootMount: an argument names the root or home directory (a filesystem server given "/"), or a container bind
// mount's source does.
func rootMount(args []string, container bool) bool {
	for i, a := range args {
		if rootPath(a) {
			return true
		}
		if !container {
			continue
		}
		l := strings.ToLower(a)
		val := ""
		switch {
		case (l == "-v" || l == "--volume" || l == "--mount") && i+1 < len(args):
			val = args[i+1]
		case strings.HasPrefix(l, "-v=") || strings.HasPrefix(l, "--volume=") || strings.HasPrefix(l, "--mount="):
			val = a[strings.IndexByte(a, '=')+1:]
		default:
			continue
		}
		if l == "--mount" || strings.HasPrefix(l, "--mount=") {
			for _, part := range strings.Split(val, ",") {
				k, v, ok := strings.Cut(part, "=")
				if ok && (k == "source" || k == "src") && rootPath(v) {
					return true
				}
			}
			continue
		}
		src := val
		// a Windows drive letter keeps its colon: C:\:/host
		if len(val) >= 2 && val[1] == ':' && (val[0] >= 'a' && val[0] <= 'z' || val[0] >= 'A' && val[0] <= 'Z') {
			if j := strings.IndexByte(val[2:], ':'); j >= 0 {
				src = val[:j+2]
			}
		} else if j := strings.IndexByte(val, ':'); j >= 0 {
			src = val[:j]
		}
		if rootPath(src) {
			return true
		}
	}
	return false
}

// describeURL keeps a remote server's host only. Embedded credentials and key-shaped values are reported as key
// presence; the path, query and fragment are dropped.
func describeURL(raw string) (host string, plaintext bool, keys []contract.KeyFound) {
	raw = strings.TrimSpace(raw)
	if r := secrets.Match(raw); r != "" {
		keys = append(keys, contract.KeyFound{KeyName: "(url)", RuleID: r, Present: true})
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", false, keys
	}
	if u.User != nil {
		if _, has := u.User.Password(); has {
			keys = append(keys, contract.KeyFound{KeyName: "(url)", RuleID: RuleURLUserinfo, Present: true})
		}
	}
	if len(keys) == 0 {
		for _, vs := range u.Query() {
			for _, v := range vs {
				if secrets.Match(v) != "" {
					keys = append(keys, contract.KeyFound{KeyName: "(url)", RuleID: RuleURLKey, Present: true})
				}
			}
		}
	}
	h := strings.ToLower(u.Hostname())
	if !hostShape(h) {
		return "", false, keys
	}
	port := u.Port()
	scheme := strings.ToLower(u.Scheme)
	if port != "" && !(scheme == "https" && port == "443") && !(scheme == "http" && port == "80") {
		host = net.JoinHostPort(h, port)
	} else if strings.Contains(h, ":") {
		host = "[" + h + "]"
	} else {
		host = h
	}
	plaintext = scheme == "http" && !loopback(h)
	return host, plaintext, keys
}

func loopback(h string) bool {
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// envKeys reports a key in an env map: a value matching a compiled pattern, or a literal under a secret-shaped
// name. References (${VAR}, $VAR, ${input:…}, ${env:…}, op://…) are not secrets.
func envKeys(v any) []contract.KeyFound {
	m, _ := v.(map[string]any)
	var out []contract.KeyFound
	for name, raw := range m {
		val, ok := raw.(string)
		if !ok || strings.TrimSpace(val) == "" {
			continue
		}
		reported := name
		if !reportableName(name) {
			reported = unnamed
		}
		if r := secrets.Match(val); r != "" {
			out = append(out, contract.KeyFound{KeyName: reported, RuleID: r, Present: true})
		} else if secretName(name) && !reference(val) {
			out = append(out, contract.KeyFound{KeyName: reported, RuleID: RuleNamedLiteral, Present: true})
		}
	}
	return out
}

// headerKeys reports a key in a headers map: a value matching a compiled pattern, a literal Authorization
// header, or a literal under a secret-shaped header name. Header names are reported when header-shaped.
func headerKeys(v any) []contract.KeyFound {
	m, _ := v.(map[string]any)
	var out []contract.KeyFound
	for name, raw := range m {
		val, ok := raw.(string)
		if !ok || strings.TrimSpace(val) == "" {
			continue
		}
		reported := name
		if !headerName(name) {
			reported = unnamed
		}
		lower := strings.ToLower(name)
		switch {
		case secrets.Match(val) != "":
			out = append(out, contract.KeyFound{KeyName: reported, RuleID: secrets.Match(val), Present: true})
		case lower == "authorization" || lower == "proxy-authorization":
			cred := strings.TrimSpace(val)
			if i := strings.IndexByte(cred, ' '); i > 0 {
				cred = strings.TrimSpace(cred[i+1:])
			}
			if cred != "" && !reference(cred) {
				out = append(out, contract.KeyFound{KeyName: reported, RuleID: RuleAuthHeader, Present: true})
			}
		case secretName(strings.ReplaceAll(strings.ToUpper(name), "-", "_")) && !reference(val):
			out = append(out, contract.KeyFound{KeyName: reported, RuleID: RuleNamedLiteral, Present: true})
		}
	}
	return out
}

// mergeKeys keeps one entry per name and rule, sorted, so a report is stable.
func mergeKeys(in []contract.KeyFound) []contract.KeyFound {
	seen := map[string]bool{}
	var out []contract.KeyFound
	for _, k := range in {
		id := k.KeyName + "\x00" + k.RuleID
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].KeyName != out[j].KeyName {
			return out[i].KeyName < out[j].KeyName
		}
		return out[i].RuleID < out[j].RuleID
	})
	return out
}

var secretWords = map[string]bool{"TOKEN": true, "SECRET": true, "PASSWORD": true, "PASSWD": true, "APIKEY": true, "PAT": true, "CREDENTIAL": true}

// secretName: an upper-cased env-style name whose LAST `_` part names a secret (GITHUB_TOKEN, OPENAI_API_KEY,
// DB_PASSWORD), so TOKEN_URL or SSH_KEY_PATH, which name where a secret is, are not reported.
func secretName(name string) bool {
	parts := strings.Split(strings.ToUpper(name), "_")
	last := parts[len(parts)-1]
	if secretWords[last] {
		return true
	}
	// …_KEY with a qualifier: API_KEY, ACCESS_KEY, PRIVATE_KEY, OPENAI_KEY (a bare KEY is too vague)
	return last == "KEY" && len(parts) > 1
}

// reference: a value that points at a secret held elsewhere rather than holding it.
func reference(v string) bool {
	v = strings.TrimSpace(v)
	switch {
	case strings.HasPrefix(v, "${") && strings.HasSuffix(v, "}"):
		return true
	case strings.HasPrefix(v, "$") && reportableName(strings.TrimPrefix(v, "$")):
		return true
	case strings.HasPrefix(v, "%") && strings.HasSuffix(v, "%") && len(v) > 2:
		return true
	case strings.HasPrefix(v, "{{") && strings.HasSuffix(v, "}}"):
		return true
	case strings.HasPrefix(v, "op://") || strings.HasPrefix(v, "env:") || strings.HasPrefix(v, "keychain:"):
		return true
	}
	return false
}

// riskyVerbs mark a tool that writes, runs or deletes. Compiled, matched against whole name parts only.
var riskyVerbs = map[string]bool{
	"write": true, "delete": true, "remove": true, "rm": true, "exec": true, "execute": true, "run": true, "shell": true,
	"command": true, "cmd": true, "bash": true, "eval": true, "kill": true, "drop": true, "truncate": true, "push": true,
	"deploy": true, "create": true, "update": true, "edit": true, "modify": true, "move": true, "rename": true,
	"send": true, "post": true, "put": true, "patch": true, "merge": true, "commit": true, "transfer": true, "pay": true,
	"install": true, "upload": true, "terminal": true, "sudo": true, "overwrite": true, "destroy": true, "insert": true,
}

// riskyToolName splits a tool name on separators and lower-to-upper case changes and looks for a risky verb.
func riskyToolName(tool string) bool {
	var parts []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			parts = append(parts, strings.ToLower(string(cur)))
			cur = cur[:0]
		}
	}
	prevLower := false
	for _, r := range tool {
		switch {
		case r == '_' || r == '-' || r == '.' || r == ':' || r == '/' || r == ' ':
			flush()
			prevLower = false
		case r >= 'A' && r <= 'Z':
			if prevLower {
				flush()
			}
			cur = append(cur, r)
			prevLower = false
		default:
			cur = append(cur, r)
			prevLower = r >= 'a' && r <= 'z'
		}
	}
	flush()
	for _, p := range parts {
		if riskyVerbs[p] {
			return true
		}
	}
	return false
}

// ---- shapes: what may leave the device ----------------------------------------------------------------------

func shaped(s string, max int, first func(rune) bool, rest func(rune) bool) bool {
	if s == "" || len(s) > max {
		return false
	}
	for i, r := range s {
		if i == 0 && !first(r) || i > 0 && !rest(r) {
			return false
		}
	}
	return true
}

func alnum(r rune) bool      { return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' }
func lowerAlnum(r rune) bool { return r >= 'a' && r <= 'z' || r >= '0' && r <= '9' }

func serverName(s string) bool {
	return shaped(s, 64, alnum, func(r rune) bool { return alnum(r) || r == '.' || r == '_' || r == '-' })
}

func commandName(s string) bool {
	return shaped(s, 64, alnum, func(r rune) bool { return alnum(r) || r == '.' || r == '_' || r == '-' || r == '+' })
}

func toolName(s string) bool {
	return shaped(s, 64, alnum, func(r rune) bool { return alnum(r) || r == '.' || r == '_' || r == '-' || r == ':' })
}

func headerName(s string) bool {
	return shaped(s, 64, alnum, func(r rune) bool { return alnum(r) || r == '-' || r == '_' })
}

func versionShape(s string) bool {
	return shaped(s, 64, func(r rune) bool {
		return alnum(r) || r == '^' || r == '~' || r == '*' || r == '<' || r == '>' || r == '='
	},
		func(r rune) bool { return alnum(r) || strings.ContainsRune(".-+_^~*<>=|x ", r) })
}

// npmName: `name` or `@scope/name`, npm's lower-case rules, at most 214 characters.
func npmName(s string) bool {
	if len(s) > 214 {
		return false
	}
	part := func(p string) bool {
		return shaped(p, 214, lowerAlnum, func(r rune) bool { return lowerAlnum(r) || r == '.' || r == '_' || r == '-' || r == '~' })
	}
	if strings.HasPrefix(s, "@") {
		scope, name, ok := strings.Cut(s[1:], "/")
		return ok && part(scope) && part(name)
	}
	return part(s)
}

func pypiName(s string) bool {
	return shaped(s, 100, lowerAlnum, func(r rune) bool { return lowerAlnum(r) || r == '.' || r == '_' || r == '-' })
}

// imageName: `name`, `org/name` or `registry.example:5000/org/name`, lower-case, no empty or dot-dot segment.
func imageName(s string) bool {
	if s == "" || len(s) > 255 || strings.Contains(s, "..") || strings.Contains(s, "//") || strings.HasPrefix(s, "/") || strings.HasSuffix(s, "/") {
		return false
	}
	for i, seg := range strings.Split(s, "/") {
		ok := shaped(seg, 128, lowerAlnum, func(r rune) bool { return lowerAlnum(r) || r == '.' || r == '_' || r == '-' || (i == 0 && r == ':') })
		if !ok {
			return false
		}
	}
	return true
}

func hostShape(h string) bool {
	if ip := net.ParseIP(h); ip != nil {
		return true
	}
	return shaped(h, 253, lowerAlnum, func(r rune) bool { return lowerAlnum(r) || r == '.' || r == '-' })
}

func hexOnly(s string) bool {
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

func stringOf(v any) string {
	s, _ := v.(string)
	return s
}

func firstString(e map[string]any, keys ...string) string {
	for _, k := range keys {
		if s := strings.TrimSpace(stringOf(e[k])); s != "" {
			return s
		}
	}
	return ""
}

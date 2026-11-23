package collect

// Read-side helpers for governed add-on removal (ADR-0331). The removal applier reuses exactly the code that
// discovered an MCP server: the same locator glob, the same config parser, the same server maps and the same server
// describer, so it can only act on an entry this agent would itself have reported.

import (
	"bytes"
	"slices"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
	"github.com/tidwall/jsonc"
)

// LocatorMatches reports whether name (a path relative to the locator's root) is one of the files the locator
// matches on this device now, by the same glob the collectors use.
func LocatorMatches(env *Env, l pack.Locator, name string) bool {
	c := &collector{env: env, gaps: map[string]contract.Gap{}, seen: map[string]bool{}}
	_, files := c.glob(contract.KindMCPConfig, l)
	return slices.Contains(files, name)
}

// ServerAt is one MCP server entry of a config file: the key path to its entry and its description.
type ServerAt struct {
	// Path is the key path to the entry, ending in the entry name.
	Path   []string
	Server contract.MCPServer
}

// MCPServersAt parses a config as the mcp_config collector does and returns every server entry with its key path.
// parsed is false when the file is not an object in its format.
func MCPServersAt(name string, raw []byte) (out []ServerAt, parsed bool) {
	doc, ok := parseConfig(name, raw)
	if !ok {
		return nil, false
	}
	for _, m := range serverMapsAt(doc) {
		for n, v := range m.servers {
			entry, ok := v.(map[string]any)
			if !ok || !looksLikeServer(entry) {
				continue
			}
			out = append(out, ServerAt{Path: append(slices.Clone(m.path), n), Server: describeServer(n, entry)})
		}
	}
	return out, true
}

// PlainJSON reports whether raw is plain JSON: JSONC comments or trailing commas would be lost by an edit.
func PlainJSON(raw []byte) bool { return bytes.Equal(jsonc.ToJSON(raw), raw) }

// MCPIdentity is the identity the gateway derives for a server (endpoint-mcp-config.ts mcpIdentityOf): the
// package, else the remote host, else the command. ok is false when none is known.
func MCPIdentity(s contract.MCPServer) (kind, identity string, ok bool) {
	switch {
	case s.Package != "":
		return "package", s.Package, true
	case s.Host != "":
		return "host", s.Host, true
	case s.Command != "":
		return "command", s.Command, true
	}
	return "", "", false
}

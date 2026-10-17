package collect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"sort"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/secrets"
)

// maxLines caps how many lines of one file the key scan looks at.
const maxLines = 20000

// assignment is one name = value pair found in a file. Value is held only for the key check.
type assignment struct {
	name  string
	value string
}

// assistantConfigs: each manifest-listed file that exists is a fact; its values are checked for keys and its
// key names against the manifest's, and only names and rule ids are kept.
func (c *collector) assistantConfigs(entries []pack.Entry) {
	k := contract.KindAssistantConfig
	for _, e := range entries {
		for _, l := range e.Files {
			fsys, files := c.glob(k, l)
			for _, name := range files {
				raw, ok := c.readBounded(k, fsys, name, 0)
				if !ok {
					continue
				}
				c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "file", Identifier: l.Path,
					Location: contract.Location{Root: l.Root, Path: name}, Keys: keysIn(assignments(raw), e.KeyNames)})
			}
		}
	}
}

// keysIn reduces assignments to key presence: a manifest-listed name with a non-empty value, or any name whose
// value matches a compiled key pattern. The values are dropped here.
func keysIn(as []assignment, listed []string) []contract.KeyFound {
	byName := map[string]contract.KeyFound{}
	for _, a := range as {
		rule := secrets.Match(a.value)
		_, isListed := matchFold(a.name, listed)
		if rule == "" && !(isListed && strings.TrimSpace(a.value) != "") {
			continue
		}
		name := a.name
		if !reportableName(name) {
			name = "(unnamed)"
		}
		prev, had := byName[name]
		if had && prev.RuleID != "" {
			continue
		}
		byName[name] = contract.KeyFound{KeyName: name, RuleID: rule, Present: true}
	}
	out := make([]contract.KeyFound, 0, len(byName))
	for _, kf := range byName {
		out = append(out, kf)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].KeyName < out[j].KeyName })
	if len(out) == 0 {
		return nil
	}
	return out
}

// reportableName admits a field or variable name that is a plain identifier: a name made of anything else (a
// JSON key holding free text, say) is reported as "(unnamed)" so the report cannot carry it.
func reportableName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}

// assignments parses a config file as JSON when it is JSON (every string value under its leaf key), and
// otherwise as lines of `name = value`, `name: value`, `export name=value`, `set -x name value` (fish) or
// `$env:name = value` (PowerShell). A line that is none of those is checked whole, with no name.
func assignments(raw []byte) []assignment {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		var v any
		if json.Unmarshal(trimmed, &v) == nil {
			var out []assignment
			walkJSON("", v, &out, 0)
			return out
		}
	}
	var out []assignment
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 64<<10), DefaultMaxFileBytes)
	for n := 0; sc.Scan() && n < maxLines; n++ {
		if a, ok := parseLine(sc.Text()); ok {
			out = append(out, a)
		}
	}
	return out
}

func walkJSON(key string, v any, out *[]assignment, depth int) {
	if depth > 64 {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			walkJSON(k, child, out, depth+1)
		}
	case []any:
		for _, child := range t {
			walkJSON(key, child, out, depth+1)
		}
	case string:
		*out = append(*out, assignment{name: key, value: t})
	}
}

func parseLine(line string) (assignment, bool) {
	s := strings.TrimSpace(line)
	if s == "" || strings.HasPrefix(s, "#") || strings.HasPrefix(s, "//") || strings.HasPrefix(s, ";") {
		return assignment{}, false
	}
	s = strings.TrimPrefix(s, "export ")
	if strings.HasPrefix(s, "set ") {
		// fish: set [-x] [-g] [-U] NAME VALUE…
		fields := strings.Fields(s)[1:]
		for len(fields) > 0 && strings.HasPrefix(fields[0], "-") {
			fields = fields[1:]
		}
		if len(fields) >= 2 {
			return assignment{name: fields[0], value: unquote(strings.Join(fields[1:], " "))}, true
		}
		return assignment{}, false
	}
	if strings.HasPrefix(strings.ToLower(s), "$env:") {
		s = s[len("$env:"):]
	}
	i := strings.IndexAny(s, "=:")
	if i <= 0 {
		return assignment{value: s}, true
	}
	name := strings.TrimSpace(strings.Trim(strings.TrimSpace(s[:i]), `"'`))
	if !reportableName(name) {
		return assignment{value: s}, true
	}
	return assignment{name: name, value: unquote(strings.TrimSpace(s[i+1:]))}, true
}

func unquote(v string) string {
	v = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), ","))
	if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
		return v[1 : len(v)-1]
	}
	return v
}

// DefaultStartupFiles are the home-relative files env_name reads on each OS.
func DefaultStartupFiles(goos string) []string {
	switch goos {
	case "windows":
		return []string{"Documents/PowerShell/Microsoft.PowerShell_profile.ps1", "Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"}
	case "darwin":
		return []string{".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile", ".config/fish/config.fish"}
	default:
		return []string{".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile", ".config/fish/config.fish", ".config/environment.d/*.conf"}
	}
}

// envNames: manifest-listed variable names set in the user's start-up files or, on Windows, the registry. A fact
// carries the name and whether a key-shaped value is present, never the value.
func (c *collector) envNames(entries []pack.Entry) {
	k := contract.KindEnvName
	type source struct {
		loc contract.Location
		as  []assignment
	}
	var sources []source
	if home, ok := c.env.Roots[contract.RootHome]; ok {
		for _, f := range c.env.StartupFiles {
			_, names := c.glob(k, pack.Locator{OS: c.env.OS, Root: contract.RootHome, Path: f})
			for _, name := range names {
				raw, ok := c.readBounded(k, home, name, 0)
				if ok {
					sources = append(sources, source{loc: contract.Location{Root: contract.RootHome, Path: name}, as: assignments(raw)})
				}
			}
		}
	}
	if c.env.OS == "windows" {
		if c.env.Registry == nil {
			c.gap(k, GapNoRegistry)
		} else if vals, err := c.env.Registry.Environment(); err != nil {
			c.gap(k, GapNoRegistry)
		} else {
			byView := map[string][]assignment{}
			for _, v := range vals {
				byView[v.View] = append(byView[v.View], assignment{name: v.Name, value: v.Value})
			}
			for view, as := range byView {
				sources = append(sources, source{loc: contract.Location{Root: contract.RootRegistry, Path: view + `\Environment`}, as: as})
			}
		}
	}
	for _, s := range sources {
		for _, e := range entries {
			for _, a := range s.as {
				m, hit := matchFold(a.name, e.EnvNames)
				if !hit {
					continue
				}
				f := contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "envName", Identifier: m, Location: s.loc}
				if strings.TrimSpace(a.value) != "" {
					f.Keys = []contract.KeyFound{{KeyName: m, RuleID: secrets.Match(a.value), Present: true}}
				}
				c.add(f)
			}
		}
	}
}

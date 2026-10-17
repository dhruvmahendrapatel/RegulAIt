package collect

import (
	"io/fs"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

// localRuntimes: processes by executable name, and listening ports. A listener whose owner is another user has no
// readable name (the agent runs unprivileged, R15 call 1), so it can match on its port only, and says so.
func (c *collector) localRuntimes(entries []pack.Entry) {
	k := contract.KindLocalRuntime
	if c.env.Processes == nil {
		c.gap(k, GapNoProcessTable)
		return
	}
	procs, err := c.env.Processes.Processes()
	if err != nil {
		c.gap(k, GapNoProcessTable)
	}
	for _, p := range procs {
		for _, e := range entries {
			if m, hit := matchFold(stripExe(p.Name), stripAll(e.ProcessNames)); hit {
				c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "processName", Identifier: m,
					Location: contract.Location{Root: contract.RootProcessTable}})
			}
		}
	}
	listeners, err := c.env.Processes.Listeners()
	if err != nil {
		c.gap(k, GapNoProcessTable)
		return
	}
	for _, l := range listeners {
		if l.Name == "" {
			c.gap(k, GapOtherUsersPortOnly)
		}
		for _, e := range entries {
			if !hasPort(e.Ports, l.Port) {
				continue
			}
			f := contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "port", Identifier: itoa(l.Port),
				Location: contract.Location{Root: contract.RootProcessTable}, Port: l.Port, PortOnly: l.Name == ""}
			// a readable owner that the entry names upgrades the match; another process's name is never reported
			if m, hit := matchFold(stripExe(l.Name), stripAll(e.ProcessNames)); hit && l.Name != "" {
				f.MatchedOn, f.Identifier = "processName+port", m
			}
			c.add(f)
		}
	}
}

func hasPort(ports []int, p int) bool {
	for _, q := range ports {
		if q == p {
			return true
		}
	}
	return false
}

func stripAll(names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = stripExe(n)
	}
	return out
}

// clis: executable names in each PATH directory. Only names are compared; no file is opened.
func (c *collector) clis(entries []pack.Entry) {
	k := contract.KindCLI
	for _, d := range c.env.PathDirs {
		for _, e := range entries {
			for _, name := range e.Executables {
				for _, candidate := range c.exeNames(name) {
					st, err := fs.Stat(d.FS, candidate)
					if err != nil {
						c.errGap(k, err)
						continue
					}
					if st.IsDir() || (c.env.OS != "windows" && st.Mode().Perm()&0o111 == 0) {
						continue
					}
					c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "executable", Identifier: name,
						Location: contract.Location{Root: d.Root, Path: join(d.Path, candidate)}})
					break
				}
			}
		}
	}
}

func (c *collector) exeNames(name string) []string {
	if c.env.OS != "windows" {
		return []string{name}
	}
	out := []string{name}
	for _, ext := range c.env.PathExt {
		if !strings.HasSuffix(strings.ToLower(name), strings.ToLower(ext)) {
			out = append(out, name+ext)
		}
	}
	return out
}

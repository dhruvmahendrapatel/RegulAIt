package collect

import (
	"encoding/json"
	"io/fs"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

// maxFirefoxIndexBytes caps extensions.json, which lists every add-on with its metadata and outgrows the general cap.
const maxFirefoxIndexBytes = 4 << 20

type seenExtension struct {
	id, version string
	root        contract.Root
	path        string
}

// ideExtensions: one subdirectory per extension under each listed directory. A VS Code-family extension names
// itself in package.json (`publisher.name`); a directory without one (a JetBrains plugin) is named by the
// directory itself.
func (c *collector) ideExtensions(entries []pack.Entry) {
	k := contract.KindIDEExtension
	var found []seenExtension
	for _, l := range locatorsOf(entries, func(e pack.Entry) []pack.Locator { return e.ExtensionDirs }) {
		fsys, dirs := c.glob(k, l)
		for _, dir := range dirs {
			for _, ent := range c.listDir(k, fsys, dir) {
				if !ent.IsDir() {
					continue
				}
				sub := join(dir, ent.Name())
				id, version := ent.Name(), ""
				if raw, ok := c.readOptional(k, fsys, sub+"/package.json"); ok {
					var pj struct {
						Publisher string `json:"publisher"`
						Name      string `json:"name"`
						Version   string `json:"version"`
					}
					if json.Unmarshal(raw, &pj) == nil && pj.Publisher != "" && pj.Name != "" {
						id, version = pj.Publisher+"."+pj.Name, pj.Version
					}
				}
				found = append(found, seenExtension{id: id, version: version, root: l.Root, path: sub})
			}
		}
	}
	c.matchExtensions(k, entries, found)
}

// browserExtensions: Chromium-family `…/Extensions/<id>/<version>/`, and Firefox-family profiles' extensions.json.
func (c *collector) browserExtensions(entries []pack.Entry) {
	k := contract.KindBrowserExtension
	var found []seenExtension
	for _, l := range locatorsOf(entries, func(e pack.Entry) []pack.Locator { return e.ExtensionDirs }) {
		fsys, dirs := c.glob(k, l)
		for _, dir := range dirs {
			for _, ent := range c.listDir(k, fsys, dir) {
				if !ent.IsDir() {
					continue
				}
				sub := join(dir, ent.Name())
				version := ""
				for _, v := range c.listDir(k, fsys, sub) {
					if v.IsDir() {
						version = v.Name()
					}
				}
				found = append(found, seenExtension{id: ent.Name(), version: version, root: l.Root, path: sub})
			}
		}
	}
	for _, l := range locatorsOf(entries, func(e pack.Entry) []pack.Locator { return e.FirefoxProfiles }) {
		fsys, profiles := c.glob(k, l)
		for _, p := range profiles {
			index := join(p, "extensions.json")
			raw, ok := c.readOptional(k, fsys, index, maxFirefoxIndexBytes)
			if !ok {
				continue
			}
			var doc struct {
				Addons []struct {
					ID      string `json:"id"`
					Version string `json:"version"`
				} `json:"addons"`
			}
			if json.Unmarshal(raw, &doc) != nil {
				c.gap(k, GapReadError)
				continue
			}
			for _, a := range doc.Addons {
				found = append(found, seenExtension{id: a.ID, version: a.Version, root: l.Root, path: index})
			}
		}
	}
	c.matchExtensions(k, entries, found)
}

func (c *collector) matchExtensions(k contract.Kind, entries []pack.Entry, found []seenExtension) {
	for _, x := range found {
		for _, e := range entries {
			if m, hit := matchFold(x.id, e.ExtensionIDs); hit {
				c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "extensionId", Identifier: m,
					Location: contract.Location{Root: x.root, Path: x.path}, Version: cleanVersion(x.version)})
			}
		}
	}
}

// readOptional reads a file that may legitimately be absent, with an optional larger cap.
func (c *collector) readOptional(k contract.Kind, fsys fs.FS, name string, limit ...int64) ([]byte, bool) {
	if _, err := fs.Stat(fsys, name); err != nil {
		c.errGap(k, err)
		return nil, false
	}
	var l int64
	if len(limit) > 0 {
		l = limit[0]
	}
	return c.readBounded(k, fsys, name, l)
}

// locatorsOf collects the distinct locators of entries, so a directory several entries name is read once.
func locatorsOf(entries []pack.Entry, of func(pack.Entry) []pack.Locator) []pack.Locator {
	seen := map[string]bool{}
	var out []pack.Locator
	for _, e := range entries {
		for _, l := range of(e) {
			key := strings.Join([]string{l.OS, string(l.Root), l.Path}, "\x00")
			if !seen[key] {
				seen[key] = true
				out = append(out, l)
			}
		}
	}
	return out
}

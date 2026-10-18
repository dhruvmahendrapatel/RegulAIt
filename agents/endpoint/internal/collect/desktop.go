package collect

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

// desktopApps: macOS bundle ids from each app's Info.plist, Linux desktop file ids, Windows uninstall entries.
func (c *collector) desktopApps(entries []pack.Entry) {
	k := contract.KindDesktopApp
	switch c.env.OS {
	case "darwin":
		for _, root := range []struct {
			root contract.Root
			dir  string
		}{{contract.RootSystemApplications, "."}, {contract.RootHome, "Applications"}} {
			fsys, ok := c.env.Roots[root.root]
			if !ok {
				continue
			}
			for _, ent := range c.listDir(k, fsys, root.dir) {
				if !ent.IsDir() || !strings.HasSuffix(ent.Name(), ".app") {
					continue
				}
				app := join(root.dir, ent.Name())
				raw, ok := c.readBounded(k, fsys, app+"/Contents/Info.plist", 0)
				if !ok {
					continue
				}
				id, version, ok := c.bundleInfo(raw)
				if !ok {
					continue
				}
				for _, e := range entries {
					if m, hit := matchFold(id, e.BundleIDs); hit {
						c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "bundleId", Identifier: m,
							Location: contract.Location{Root: root.root, Path: app}, Version: cleanVersion(version)})
					}
				}
			}
		}
	case "linux":
		for _, root := range []struct {
			root contract.Root
			dir  string
		}{{contract.RootSystemApplications, "."}, {contract.RootHome, ".local/share/applications"}} {
			fsys, ok := c.env.Roots[root.root]
			if !ok {
				continue
			}
			for _, ent := range c.listDir(k, fsys, root.dir) {
				if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".desktop") {
					continue
				}
				for _, e := range entries {
					if m, hit := matchFold(ent.Name(), e.DesktopIDs); hit {
						c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "desktopId", Identifier: m,
							Location: contract.Location{Root: root.root, Path: join(root.dir, ent.Name())}})
					}
				}
			}
		}
	case "windows":
		if c.env.Registry == nil {
			c.gap(k, GapNoRegistry)
			return
		}
		list, err := c.env.Registry.Uninstall()
		if err != nil {
			c.gap(k, GapNoRegistry)
			return
		}
		for _, u := range list {
			for _, e := range entries {
				if m, hit := matchFold(strings.TrimSpace(u.DisplayName), e.UninstallNames); hit {
					c.add(contract.Fact{Kind: k, SignatureID: e.SignatureID, Provider: e.Provider, MatchedOn: "uninstallName", Identifier: m,
						Location: contract.Location{Root: contract.RootRegistry, Path: u.View + `\` + u.Key}, Version: cleanVersion(u.Version)})
				}
			}
		}
	}
}

// bundleInfo reads CFBundleIdentifier and CFBundleShortVersionString from an XML property list, converting a
// binary one first when the platform can.
func (c *collector) bundleInfo(raw []byte) (id, version string, ok bool) {
	if bytes.HasPrefix(raw, []byte("bplist")) {
		if c.env.PlistToXML == nil {
			c.gap(contract.KindDesktopApp, GapBinaryPlist)
			return "", "", false
		}
		x, err := c.env.PlistToXML(raw)
		if err != nil {
			c.gap(contract.KindDesktopApp, GapBinaryPlist)
			return "", "", false
		}
		raw = x
	}
	vals, err := plistTopStrings(raw, "CFBundleIdentifier", "CFBundleShortVersionString")
	if err != nil {
		c.gap(contract.KindDesktopApp, GapReadError)
		return "", "", false
	}
	id = vals["CFBundleIdentifier"]
	return id, vals["CFBundleShortVersionString"], id != ""
}

// plistTopStrings returns the <string> values of the named keys of an XML plist's top-level <dict>. Nested dicts
// and arrays are skipped. encoding/xml does not resolve external entities, so a hostile plist cannot make it read
// anything.
func plistTopStrings(raw []byte, keys ...string) (map[string]string, error) {
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	out := map[string]string{}
	dec := xml.NewDecoder(bytes.NewReader(raw))
	dec.Strict = true
	depth := 0 // element depth; the top-level dict's children are at depth 3 (plist > dict > child)
	var pendingKey string
	var inTopDict bool
	for {
		tok, err := dec.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return out, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			if depth == 2 && t.Name.Local == "dict" {
				inTopDict = true
				continue
			}
			if !inTopDict || depth != 3 {
				continue
			}
			var text string
			switch t.Name.Local {
			case "key":
				if err := dec.DecodeElement(&text, &t); err != nil {
					return out, err
				}
				depth--
				pendingKey = text
			case "string":
				if err := dec.DecodeElement(&text, &t); err != nil {
					return out, err
				}
				depth--
				if want[pendingKey] {
					out[pendingKey] = strings.TrimSpace(text)
				}
				pendingKey = ""
			default:
				pendingKey = ""
			}
		case xml.EndElement:
			if depth == 2 && inTopDict {
				return out, nil
			}
			depth--
		}
	}
}

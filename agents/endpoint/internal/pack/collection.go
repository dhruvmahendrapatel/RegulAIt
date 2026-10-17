package pack

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Collection is the collection manifest (`regulait.endpoint-collection/1`): catalogue entries naming exactly what
// the agent may look for. The agent hard-codes no product names; every identifier comes from here.
type Collection struct {
	Schema  string  `json:"schema"`
	Entries []Entry `json:"entries"`
}

// Entry is one catalogue signature. Only the fields of its kind may be set.
type Entry struct {
	SignatureID string        `json:"signatureId"`
	Kind        contract.Kind `json:"kind"`
	Provider    string        `json:"provider"`

	// desktop_app: macOS CFBundleIdentifier, Windows uninstall DisplayName (exact, case-insensitive), Linux
	// desktop file id
	BundleIDs      []string `json:"bundleIds,omitempty"`
	UninstallNames []string `json:"uninstallNames,omitempty"`
	DesktopIDs     []string `json:"desktopIds,omitempty"`

	// ide_extension and browser_extension: ids matched case-insensitively; the directories holding one
	// subdirectory per extension; for browsers, Firefox-style profiles holding extensions.json
	ExtensionIDs    []string  `json:"extensionIds,omitempty"`
	ExtensionDirs   []Locator `json:"extensionDirs,omitempty"`
	FirefoxProfiles []Locator `json:"firefoxProfiles,omitempty"`

	// local_runtime: process executable names (exact) and listening ports
	ProcessNames []string `json:"processNames,omitempty"`
	Ports        []int    `json:"ports,omitempty"`

	// assistant_config: files to look at, and key names whose presence is reported
	Files    []Locator `json:"files,omitempty"`
	KeyNames []string  `json:"keyNames,omitempty"`

	// cli: executable names on PATH
	Executables []string `json:"executables,omitempty"`

	// env_name: environment variable names
	EnvNames []string `json:"envNames,omitempty"`
}

// Locator is a path, relative to a root, on one OS. Path segments may use `*` and `?` as globs, nothing else.
type Locator struct {
	OS   string        `json:"os"`
	Root contract.Root `json:"root"`
	Path string        `json:"path"`
}

const (
	maxEntries   = 4000
	maxListItems = 128
	maxNameLen   = 200
	maxPathLen   = 512
)

var locatorRoots = map[contract.Root]bool{
	contract.RootHome: true, contract.RootSystemApplications: true, contract.RootAppData: true, contract.RootLocalAppData: true,
}

var knownOS = map[string]bool{"darwin": true, "windows": true, "linux": true}

// ParseCollection parses and validates a collection manifest.
func ParseCollection(data []byte) (*Collection, error) {
	var c Collection
	if err := strictJSON(data, &c); err != nil {
		return nil, refuse("the collection manifest does not parse: %v", err)
	}
	if c.Schema != contract.SchemaCollection {
		return nil, refuse("unknown collection schema %q", c.Schema)
	}
	if len(c.Entries) > maxEntries {
		return nil, refuse("%d entries is more than %d", len(c.Entries), maxEntries)
	}
	seen := map[string]bool{}
	for i := range c.Entries {
		e := &c.Entries[i]
		if err := validateEntry(e); err != nil {
			return nil, refuse("entry %d (%q): %v", i, e.SignatureID, err)
		}
		if seen[e.SignatureID] {
			return nil, refuse("signature id %q appears twice", e.SignatureID)
		}
		seen[e.SignatureID] = true
	}
	return &c, nil
}

type fieldErr string

func (f fieldErr) Error() string { return string(f) }

func isIDChar(c rune) bool {
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-'
}

func validID(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for i, c := range s {
		if !isIDChar(c) || (i == 0 && !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

// patternChars are what make a string read as a regular expression or a shell pattern. A name or path carrying
// one is refused, so nothing in the manifest can be mistaken for, or later turned into, a pattern (decision 5).
const patternChars = `^$|\[]{}()+`

// bracedGUID reports whether s is exactly `{8-4-4-4-12 hex}`, the form Firefox-family add-on ids take. It is the
// one place braces are allowed in a name.
func bracedGUID(s string) bool {
	if len(s) != 38 || s[0] != '{' || s[37] != '}' {
		return false
	}
	for i, c := range s[1:37] {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// validName accepts an exact identifier or display name: printable, no pattern characters, no globs.
func validName(s string) error {
	if s == "" || len(s) > maxNameLen || !utf8.ValidString(s) {
		return fieldErr("a name is empty, too long or not UTF-8")
	}
	if bracedGUID(s) {
		return nil
	}
	if strings.ContainsAny(s, patternChars+"*?") {
		return fieldErr("a name contains a pattern character: " + s)
	}
	for _, c := range s {
		if !unicode.IsPrint(c) {
			return fieldErr("a name contains a non-printable character")
		}
	}
	if strings.TrimSpace(s) != s {
		return fieldErr("a name has leading or trailing space")
	}
	return nil
}

func validNames(list []string) error {
	if len(list) > maxListItems {
		return fieldErr("a list is too long")
	}
	for _, s := range list {
		if err := validName(s); err != nil {
			return err
		}
	}
	return nil
}

// validLocator accepts a relative, forward-slash path whose segments may hold `*` or `?` globs.
func validLocator(l Locator) error {
	if !knownOS[l.OS] {
		return fieldErr("unknown os " + l.OS)
	}
	if !locatorRoots[l.Root] {
		return fieldErr("unknown root " + string(l.Root))
	}
	if l.Root == contract.RootSystemApplications && l.OS == "windows" || (l.Root == contract.RootAppData || l.Root == contract.RootLocalAppData) && l.OS != "windows" {
		return fieldErr("root " + string(l.Root) + " does not exist on " + l.OS)
	}
	p := l.Path
	if p == "" || len(p) > maxPathLen || !utf8.ValidString(p) || strings.HasPrefix(p, "/") || strings.ContainsAny(p, patternChars) {
		return fieldErr("path is empty, absolute, too long or contains a pattern character: " + p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.Contains(seg, "**") {
			return fieldErr("path has an empty, relative or recursive segment: " + p)
		}
		for _, c := range seg {
			if !unicode.IsPrint(c) {
				return fieldErr("path contains a non-printable character")
			}
		}
	}
	return nil
}

func validLocators(list []Locator) error {
	if len(list) > maxListItems {
		return fieldErr("a list is too long")
	}
	for _, l := range list {
		if err := validLocator(l); err != nil {
			return err
		}
	}
	return nil
}

func validateEntry(e *Entry) error {
	if !validID(e.SignatureID, 128) {
		return fieldErr("signatureId must be lowercase [a-z0-9._:-]")
	}
	if !validID(e.Provider, 64) {
		return fieldErr("provider must be lowercase [a-z0-9._:-]")
	}
	known := false
	for _, k := range contract.Kinds {
		if e.Kind == k {
			known = true
		}
	}
	if !known {
		return fieldErr("unknown kind " + string(e.Kind) + " (known: " + sortedKinds() + ")")
	}
	for _, list := range [][]string{e.BundleIDs, e.UninstallNames, e.DesktopIDs, e.ExtensionIDs, e.ProcessNames, e.KeyNames, e.Executables, e.EnvNames} {
		if err := validNames(list); err != nil {
			return err
		}
	}
	for _, list := range [][]Locator{e.ExtensionDirs, e.FirefoxProfiles, e.Files} {
		if err := validLocators(list); err != nil {
			return err
		}
	}
	if len(e.Ports) > maxListItems {
		return fieldErr("too many ports")
	}
	for _, p := range e.Ports {
		if p < 1 || p > 65535 {
			return fieldErr("a port is out of range")
		}
	}
	// each kind may set only its own fields, and must set at least one identifier
	set := map[string]bool{
		"bundleIds": len(e.BundleIDs) > 0, "uninstallNames": len(e.UninstallNames) > 0, "desktopIds": len(e.DesktopIDs) > 0,
		"extensionIds": len(e.ExtensionIDs) > 0, "extensionDirs": len(e.ExtensionDirs) > 0, "firefoxProfiles": len(e.FirefoxProfiles) > 0,
		"processNames": len(e.ProcessNames) > 0, "ports": len(e.Ports) > 0, "files": len(e.Files) > 0, "keyNames": len(e.KeyNames) > 0,
		"executables": len(e.Executables) > 0, "envNames": len(e.EnvNames) > 0,
	}
	allowed := map[contract.Kind][]string{
		contract.KindDesktopApp:       {"bundleIds", "uninstallNames", "desktopIds"},
		contract.KindIDEExtension:     {"extensionIds", "extensionDirs"},
		contract.KindBrowserExtension: {"extensionIds", "extensionDirs", "firefoxProfiles"},
		contract.KindLocalRuntime:     {"processNames", "ports"},
		contract.KindAssistantConfig:  {"files", "keyNames"},
		contract.KindCLI:              {"executables"},
		contract.KindEnvName:          {"envNames"},
	}
	required := map[contract.Kind][]string{
		contract.KindDesktopApp:       {"bundleIds", "uninstallNames", "desktopIds"},
		contract.KindIDEExtension:     {"extensionIds"},
		contract.KindBrowserExtension: {"extensionIds"},
		contract.KindLocalRuntime:     {"processNames", "ports"},
		contract.KindAssistantConfig:  {"files"},
		contract.KindCLI:              {"executables"},
		contract.KindEnvName:          {"envNames"},
	}
	ok := map[string]bool{}
	for _, f := range allowed[e.Kind] {
		ok[f] = true
	}
	for f, isSet := range set {
		if isSet && !ok[f] {
			return fieldErr("field " + f + " does not belong to kind " + string(e.Kind))
		}
	}
	any := false
	for _, f := range required[e.Kind] {
		any = any || set[f]
	}
	if !any {
		return fieldErr("kind " + string(e.Kind) + " needs one of " + strings.Join(required[e.Kind], ", "))
	}
	return nil
}

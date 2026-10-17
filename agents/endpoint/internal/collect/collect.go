// Package collect gathers the ADR-0195 decision-18 facts the signed collection manifest names, and nothing else.
//
// Detection is data (decision 5): every identifier the collectors compare against comes from the manifest, and
// comparison is equality (case-insensitive where the OS treats the identifier so). No pattern from data is ever
// evaluated. Key values are checked on the device against the compiled patterns of package secrets and dropped at
// once; a fact carries key presence only (R15 call 2).
//
// Every read goes through an fs.FS rooted at a known directory (os.Root in production, so a symlink cannot lead a
// read out of the home directory), is bounded in size, and reports where it looked only as a root plus a relative
// path. Collector errors become Gap reason codes, never error strings, because an OS error message carries the
// absolute path and so the user name.
package collect

import (
	"errors"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

// Gap reason codes. They are the only text a collector reports about what went wrong.
const (
	GapPermissionDenied      = "permission_denied"
	GapReadError             = "read_error"
	GapTooLarge              = "file_too_large"
	GapBinaryPlist           = "binary_plist_not_converted"
	GapNoProcessTable        = "process_table_unavailable"
	GapOtherUsersPortOnly    = "other_users_listeners_port_only"
	GapNoRegistry            = "registry_unavailable"
	GapRootMissing           = "root_not_present"
	GapDisabledByOrgPolicy   = "disabled_by_org_policy"
	GapDisabledByLocalPolicy = "disabled_by_local_policy"
	GapListingTruncated      = "listing_truncated"
)

// Env is what the collectors may read. Tests build one over fstest.MapFS fixtures.
type Env struct {
	OS string
	// Roots maps each root that exists on this OS to a filesystem rooted there.
	Roots map[contract.Root]fs.FS
	// PathDirs are the PATH directories, already resolved to a root and a path the report may carry.
	PathDirs []PathDir
	// PathExt is the Windows executable suffixes tried for a `cli` name (".exe", ".cmd", …); empty elsewhere.
	PathExt []string
	// Registry is nil off Windows.
	Registry Registry
	// Processes is nil where the process table cannot be read; local_runtime then reports a gap.
	Processes ProcessLister
	// PlistToXML converts a binary property list (macOS `plutil`); nil means binary plists are a gap.
	PlistToXML func([]byte) ([]byte, error)
	// StartupFiles are the home-relative shell and profile files env_name reads.
	StartupFiles []string
	// MaxFileBytes caps each file read (R15 §2.3: for example 256 KiB).
	MaxFileBytes int64
}

// PathDir is one PATH directory: Root is RootHome (Path relative to the home) or RootPath (Path absolute, never
// under the home directory).
type PathDir struct {
	Root contract.Root
	Path string
	FS   fs.FS
}

// Registry is the slice of the Windows registry the collectors read.
type Registry interface {
	// Uninstall lists HKLM and HKCU uninstall entries.
	Uninstall() ([]UninstallEntry, error)
	// Environment lists HKCU and HKLM environment variables. Values are for the on-device key check only.
	Environment() ([]EnvValue, error)
}

// UninstallEntry is one uninstall key.
type UninstallEntry struct {
	View        string // "HKLM" or "HKCU"
	Key         string // the key path under the view, without the view
	DisplayName string
	Version     string
}

// EnvValue is one environment variable.
type EnvValue struct {
	View  string
	Name  string
	Value string
}

// ProcessLister reads the process and socket tables.
type ProcessLister interface {
	Processes() ([]Process, error)
	Listeners() ([]Listener, error)
}

// Process is one process the agent's user can see.
type Process struct {
	PID  int32
	Name string
}

// Listener is one listening TCP socket. Name is "" when the owning process belongs to another user.
type Listener struct {
	Port int
	Name string
}

// DefaultMaxFileBytes is the per-file read cap.
const DefaultMaxFileBytes = 256 << 10

// maxListing caps how many directory entries one listing yields.
const maxListing = 5000

type collector struct {
	env   *Env
	facts []contract.Fact
	gaps  map[string]contract.Gap
	seen  map[string]bool
}

// Collect runs every collector whose kind is not disabled and returns the facts sorted and the gaps sorted.
func Collect(env *Env, col *pack.Collection, disabled map[contract.Kind]string) ([]contract.Fact, []contract.Gap) {
	if env.MaxFileBytes <= 0 {
		env.MaxFileBytes = DefaultMaxFileBytes
	}
	c := &collector{env: env, gaps: map[string]contract.Gap{}, seen: map[string]bool{}}
	byKind := map[contract.Kind][]pack.Entry{}
	for _, e := range col.Entries {
		byKind[e.Kind] = append(byKind[e.Kind], e)
	}
	run := map[contract.Kind]func([]pack.Entry){
		contract.KindDesktopApp:       c.desktopApps,
		contract.KindIDEExtension:     c.ideExtensions,
		contract.KindBrowserExtension: c.browserExtensions,
		contract.KindLocalRuntime:     c.localRuntimes,
		contract.KindAssistantConfig:  c.assistantConfigs,
		contract.KindCLI:              c.clis,
		contract.KindEnvName:          c.envNames,
	}
	for _, k := range contract.Kinds {
		entries := byKind[k]
		if len(entries) == 0 {
			continue
		}
		if reason, off := disabled[k]; off {
			c.gap(k, reason)
			continue
		}
		run[k](entries)
	}
	sort.Slice(c.facts, func(i, j int) bool { return factKey(c.facts[i]) < factKey(c.facts[j]) })
	gaps := make([]contract.Gap, 0, len(c.gaps))
	for _, g := range c.gaps {
		gaps = append(gaps, g)
	}
	sort.Slice(gaps, func(i, j int) bool {
		return string(gaps[i].Kind)+"\x00"+gaps[i].Reason < string(gaps[j].Kind)+"\x00"+gaps[j].Reason
	})
	return c.facts, gaps
}

func factKey(f contract.Fact) string {
	return strings.Join([]string{string(f.Kind), f.SignatureID, string(f.Location.Root), f.Location.Path, f.MatchedOn, f.Identifier, itoa(f.Port)}, "\x00")
}

func itoa(n int) string {
	if n == 0 {
		return ""
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func (c *collector) add(f contract.Fact) {
	k := factKey(f)
	if c.seen[k] {
		return
	}
	c.seen[k] = true
	c.facts = append(c.facts, f)
}

func (c *collector) gap(k contract.Kind, reason string) {
	c.gaps[string(k)+"\x00"+reason] = contract.Gap{Kind: k, Reason: reason}
}

// errGap maps a filesystem error to a gap, ignoring "does not exist" (absence is the common, honest answer).
func (c *collector) errGap(k contract.Kind, err error) {
	switch {
	case err == nil, errors.Is(err, fs.ErrNotExist):
	case errors.Is(err, fs.ErrPermission):
		c.gap(k, GapPermissionDenied)
	default:
		c.gap(k, GapReadError)
	}
}

// glob expands a locator on this OS to existing paths in its root, sorted.
func (c *collector) glob(k contract.Kind, l pack.Locator) (fs.FS, []string) {
	if l.OS != c.env.OS {
		return nil, nil
	}
	fsys, ok := c.env.Roots[l.Root]
	if !ok {
		c.gap(k, GapRootMissing)
		return nil, nil
	}
	if !strings.ContainsAny(l.Path, "*?") {
		if _, err := fs.Stat(fsys, l.Path); err != nil {
			c.errGap(k, err)
			return fsys, nil
		}
		return fsys, []string{l.Path}
	}
	// fs.Glob would also honour `[…]` classes; the manifest validator has already refused them
	matches, err := fs.Glob(fsys, l.Path)
	if err != nil {
		c.errGap(k, err)
		return fsys, nil
	}
	if len(matches) > maxListing {
		c.gap(k, GapListingTruncated)
		matches = matches[:maxListing]
	}
	return fsys, matches
}

// readBounded reads at most env.MaxFileBytes (or limit when larger) of a regular file.
func (c *collector) readBounded(k contract.Kind, fsys fs.FS, name string, limit int64) ([]byte, bool) {
	if limit < c.env.MaxFileBytes {
		limit = c.env.MaxFileBytes
	}
	f, err := fsys.Open(name)
	if err != nil {
		c.errGap(k, err)
		return nil, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		c.errGap(k, err)
		return nil, false
	}
	if st.Size() > limit {
		c.gap(k, GapTooLarge)
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(b)) > limit {
		c.gap(k, GapReadError)
		return nil, false
	}
	return b, true
}

// listDir lists a directory's entries, capped.
func (c *collector) listDir(k contract.Kind, fsys fs.FS, dir string) []fs.DirEntry {
	ents, err := fs.ReadDir(fsys, dir)
	if err != nil {
		c.errGap(k, err)
		return nil
	}
	if len(ents) > maxListing {
		c.gap(k, GapListingTruncated)
		ents = ents[:maxListing]
	}
	return ents
}

func join(dir, name string) string {
	if dir == "." || dir == "" {
		return name
	}
	return path.Join(dir, name)
}

// stripExe removes a Windows ".exe" suffix for name comparisons.
func stripExe(name string) string {
	if len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".exe") {
		return name[:len(name)-4]
	}
	return name
}

// matchFold returns the first candidate equal to s ignoring case.
func matchFold(s string, candidates []string) (string, bool) {
	for _, c := range candidates {
		if strings.EqualFold(s, c) {
			return c, true
		}
	}
	return "", false
}

// cleanVersion keeps a version string only when it looks like one (digits, letters, dots, dashes, plus,
// underscores; at most 64), so a free-form field cannot carry anything else into a report.
func cleanVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > 64 {
		return ""
	}
	for _, r := range v {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '.' || r == '-' || r == '+' || r == '_') {
			return ""
		}
	}
	return v
}

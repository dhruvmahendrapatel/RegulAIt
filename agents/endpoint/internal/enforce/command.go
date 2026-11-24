package enforce

// The neutral Command decision (ADR-0350): shell commands, file reads and writes, and package installs that a coding
// agent's built-in tools perform on this device. An adapter turns the agent's hook input into a CommandCall (a shell
// command line, or one file access); Decide then reduces it to actions (one argv, one file access or one package
// install each) and checks every action against the policy's closed rule list. Rules are data, never code: an argv
// pattern (one glob per argument), a path glob or a package-name glob, each with a verdict of allow, ask or deny.
// The strictest verdict of every action wins (deny, then ask, then allow), so an allow never overrides a deny.
//
// This is a guardrail, not containment. Matching is on what the command line says, after parsing it as a shell
// would (mvdan.cc/sh), never on what a program does once it runs: a renamed binary, a script file or an interpreter
// one-liner is not seen through. Anything the parser cannot resolve to fixed words (a variable, a command
// substitution, eval, a PowerShell command) is an "unresolved" action, whose verdict is ask or deny, never allow.
// The gateway stays the enforcement point that cannot be bypassed for model and MCP calls.

import (
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/bmatcuk/doublestar/v4"
)

// Verdicts a command rule can carry, from least to most strict.
const (
	RuleAllow = "allow"
	RuleAsk   = "ask"
	RuleDeny  = "deny"
)

// Bounds on what a policy may carry and what one call may expand to.
const (
	maxRules          = 2000
	maxArgvPatterns   = 32
	maxPatternBytes   = 512
	maxExceptions     = 64
	maxActions        = 256
	maxCommandBytes   = 64 << 10
	maxShellDepth     = 3
	MaxExceptionLife  = 7 * 24 * time.Hour
	unresolvedRuleID  = "unresolved"
	defaultExecRuleID = "default.exec"
)

// CommandRules is the policy's command section. Every field is required: a policy that leaves one out is refused,
// so the device never invents a default.
type CommandRules struct {
	// Default is the verdict for a command no exec rule matches.
	Default string `json:"default"`
	// Unresolved is the verdict for anything the parser cannot resolve to fixed words: ask or deny.
	Unresolved string     `json:"unresolved"`
	Exec       []ExecRule `json:"exec"`
	Files      FileRules  `json:"files"`
	Packages   PkgRules   `json:"packages"`
	// Actions are the compiled one-policy rules (ADR-0350 §9), one per catalogue action at most.
	Actions []ActionRule `json:"actions"`
}

// ExecRule matches one argv. Argv holds one doublestar glob per argument, compared position by position; argv[0] is
// compared with the program's base name unless the pattern holds a "/". A final element "**" matches any number of
// remaining arguments, including none; anywhere else it is an ordinary glob.
type ExecRule struct {
	ID      string   `json:"id"`
	Argv    []string `json:"argv"`
	Verdict string   `json:"verdict"`
}

// FileRules decides file accesses. A rule matches an absolute path glob ("/", "~/" for the user's home, "**/", or a
// Windows drive "C:/"). With no matching rule, an access inside the workspace is allowed and one outside it gets
// OutsideRead or OutsideWrite.
type FileRules struct {
	OutsideRead  string     `json:"outsideRead"`
	OutsideWrite string     `json:"outsideWrite"`
	Rules        []FileRule `json:"rules"`
}

// FileRule matches a path for one kind of access.
type FileRule struct {
	ID      string `json:"id"`
	Access  string `json:"access"` // read, write or any
	Path    string `json:"path"`
	Verdict string `json:"verdict"`
}

// PkgRules decides package installs, including run-a-package launchers (npx, uvx, pnpm dlx).
type PkgRules struct {
	Default string    `json:"default"`
	Rules   []PkgRule `json:"rules"`
}

// PkgRule matches a package by ecosystem (PackageEcosystems, or "*") and a name glob. An install from a lockfile or
// manifest, with no names on the command line, is one install whose name is empty, which only "*" or "**" matches.
type PkgRule struct {
	ID        string `json:"id"`
	Ecosystem string `json:"ecosystem"`
	Name      string `json:"name"`
	Verdict   string `json:"verdict"`
}

// Exception relaxes one rule on one device until NotAfter (ADR-0350 §5). It is issued only after an approval with
// step-up, and the device applies it only while its own clock is before NotAfter and only when the policy names this
// device, so it lapses on time even offline.
type Exception struct {
	ID       string    `json:"id"`
	RuleID   string    `json:"ruleId"`
	Verdict  string    `json:"verdict"`
	NotAfter time.Time `json:"notAfter"`
}

var (
	ruleIDShape  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	ecosystems   = map[string]bool{"npm": true, "pypi": true, "apt": true, "dnf": true, "apk": true, "brew": true, "cargo": true, "go": true, "gem": true, "*": true}
	absPathShape = regexp.MustCompile(`^(/|~/|\*\*/|[A-Za-z]:/)`)
)

func strictness(v string) int {
	switch v {
	case RuleAllow:
		return 1
	case RuleAsk:
		return 2
	case RuleDeny:
		return 3
	}
	return 0
}

func validVerdict(v string) bool { return strictness(v) > 0 }

func validGlob(p string) bool {
	return p != "" && len(p) <= maxPatternBytes && doublestar.ValidatePattern(p)
}

func wildcardOnly(p string) bool { return strings.Trim(p, "*/") == "" }

func (c *CommandRules) validate(p *Policy) error {
	if !validVerdict(c.Default) || !validVerdict(c.Files.OutsideRead) || !validVerdict(c.Files.OutsideWrite) || !validVerdict(c.Packages.Default) {
		return refuse("commands: a default verdict is missing or not allow, ask or deny")
	}
	if c.Unresolved != RuleAsk && c.Unresolved != RuleDeny {
		return refuse("commands: unresolved must be ask or deny")
	}
	if len(c.Exec)+len(c.Files.Rules)+len(c.Packages.Rules) > maxRules {
		return refuse("commands: too many rules")
	}
	ids := map[string]string{}
	use := func(id, verdict string) error {
		if !ruleIDShape.MatchString(id) || id == unresolvedRuleID || strings.HasPrefix(id, "default.") {
			return refuse("commands: rule id %q not well formed", id)
		}
		if _, dup := ids[id]; dup {
			return refuse("commands: rule id %q used twice", id)
		}
		if !validVerdict(verdict) {
			return refuse("commands: rule %q verdict", id)
		}
		ids[id] = verdict
		return nil
	}
	for _, r := range c.Exec {
		if err := use(r.ID, r.Verdict); err != nil {
			return err
		}
		if len(r.Argv) == 0 || len(r.Argv) > maxArgvPatterns {
			return refuse("commands: rule %q argv length", r.ID)
		}
		for _, g := range r.Argv {
			if !validGlob(g) {
				return refuse("commands: rule %q has a bad pattern", r.ID)
			}
		}
		// a catch-all allow is refused: an allow names the program it allows (the default verdict is the catch-all)
		if r.Verdict == RuleAllow && wildcardOnly(r.Argv[0]) {
			return refuse("commands: rule %q is a catch-all allow", r.ID)
		}
	}
	for _, r := range c.Files.Rules {
		if err := use(r.ID, r.Verdict); err != nil {
			return err
		}
		if r.Access != "read" && r.Access != "write" && r.Access != "any" {
			return refuse("commands: rule %q access", r.ID)
		}
		if !validGlob(r.Path) || !absPathShape.MatchString(r.Path) {
			return refuse("commands: rule %q path must be an absolute glob", r.ID)
		}
		if r.Verdict == RuleAllow && wildcardOnly(r.Path) {
			return refuse("commands: rule %q is a catch-all allow", r.ID)
		}
	}
	for _, r := range c.Packages.Rules {
		if err := use(r.ID, r.Verdict); err != nil {
			return err
		}
		if !ecosystems[r.Ecosystem] || !validGlob(r.Name) {
			return refuse("commands: rule %q ecosystem or name", r.ID)
		}
		if r.Verdict == RuleAllow && wildcardOnly(r.Name) {
			return refuse("commands: rule %q is a catch-all allow", r.ID)
		}
	}
	if err := validateActions(c.Actions, use); err != nil {
		return err
	}
	if len(p.Exceptions) > maxExceptions {
		return refuse("exceptions: too many")
	}
	if len(p.Exceptions) > 0 && p.Device == "" {
		return refuse("exceptions: a policy with exceptions must name its device")
	}
	seen := map[string]bool{}
	for _, e := range p.Exceptions {
		base, ok := ids[e.RuleID]
		if !ruleIDShape.MatchString(e.ID) || seen[e.ID] || !ok {
			return refuse("exceptions: %q is malformed, repeated or names no rule", e.ID)
		}
		seen[e.ID] = true
		// an exception only relaxes, and only for a bounded time inside the policy's own window
		if !validVerdict(e.Verdict) || strictness(e.Verdict) >= strictness(base) {
			return refuse("exceptions: %q does not relax its rule", e.ID)
		}
		if e.NotAfter.IsZero() || e.NotAfter.After(p.NotAfter) || e.NotAfter.Sub(p.IssuedAt) > MaxExceptionLife {
			return refuse("exceptions: %q expiry", e.ID)
		}
	}
	return nil
}

// CommandCall is one built-in tool call in neutral form: a shell command line, or file accesses.
type CommandCall struct {
	// Shell is the command line (bash syntax); ShellUnparsable marks a shell the parser cannot read (PowerShell).
	Shell           string
	ShellUnparsable bool
	// Argv is a command given as an argv rather than a command line (Codex may send one).
	Argv []string
	// Files are file accesses the tool itself performs (a Read or Write tool, or the paths an apply_patch names).
	Files []FileAccess
	// Cwd is the working directory relative paths resolve against.
	Cwd string
	// Workspace are the roots the agent itself declares (Cursor's workspace_roots); with HookEnv.ProjectDir they are
	// the only workspace. The cwd never counts on its own, and a root that is a filesystem or drive root, the home
	// directory or an ancestor of it is ignored (review #941 S-B1), so a session started from / or ~ has no workspace
	// and every file action gets the outside defaults.
	Workspace []string
	// Unresolved is set by an adapter that saw a governed tool but could not find what it acts on.
	Unresolved string
}

// FileAccess is one path and whether it is written.
type FileAccess struct {
	Path  string
	Write bool
}

// HookEnv is what a decision needs from the device besides the policy. The zero value is valid: no home directory
// (a "~/" rule then matches nothing), no device id (exceptions then never apply), the system clock, and paths
// taken as given.
type HookEnv struct {
	Home       string
	DeviceID   string
	Now        time.Time
	ProjectDir string
	// Resolve maps a cleaned absolute path to its real location (symlinks resolved), or returns it unchanged.
	Resolve func(string) string

	roots []string // the call's workspace roots, set by decideCommand
}

// action is one thing a call does, decided on its own.
type action struct {
	kind  string // exec, read, write, package, unresolved
	argv  []string
	path  string
	eco   string
	name  string
	cause string
	// envSet: the program runs with an environment the command line changed (FOO=x prog, env FOO=x prog, or an
	// export, declare or set earlier in the line). A proxy, config home or preload there is not visible to the
	// check, so an action allow does not relax the default for it (review #952).
	envSet bool
}

// outcome is one action's verdict and why.
type outcome struct {
	verdict string
	rule    string
	reason  string
	// kind is the deciding action's kind (Decision.Action), set by decideCommand; "" for an unresolved one
	kind string
}

// decideCommand returns the strictest outcome across the call's actions. It never returns no verdict.
func decideCommand(p *Policy, c CommandCall, env HookEnv) outcome {
	env.roots = acceptableRoots(append(append([]string{}, c.Workspace...), env.ProjectDir), env.Home)
	acts := commandActions(c, env)
	best := outcome{verdict: RuleAllow, rule: "default.workspace", reason: "inside the workspace"}
	first := true
	for _, a := range acts {
		o := decideAction(p, a, env)
		if first || strictness(o.verdict) > strictness(best.verdict) {
			best, first = o, false
			best.kind = actionKind(a.kind)
		}
	}
	return best
}

// actionKind names an action's kind for the decision record; an unresolved action names none.
func actionKind(kind string) string {
	switch kind {
	case "exec":
		return KindExec
	case "package":
		return KindPackage
	case "read":
		return KindRead
	case "write":
		return KindWrite
	}
	return ""
}

func commandActions(c CommandCall, env HookEnv) []action {
	var acts []action
	if c.Unresolved != "" {
		acts = append(acts, action{kind: "unresolved", cause: c.Unresolved})
	}
	switch {
	case c.ShellUnparsable:
		acts = append(acts, action{kind: "unresolved", cause: "a shell this hook cannot parse"})
	case c.Shell != "":
		acts = append(acts, shellActions(c.Shell)...)
	case len(c.Argv) > 0:
		acts = append(acts, argvActions(c.Argv, 0)...)
	}
	for _, f := range c.Files {
		k := "read"
		if f.Write {
			k = "write"
		}
		acts = append(acts, action{kind: k, path: f.Path})
	}
	if len(acts) > maxActions {
		return []action{{kind: "unresolved", cause: "a command with too many parts"}}
	}
	// resolve every path once, against the call's working directory
	for i := range acts {
		if acts[i].kind != "read" && acts[i].kind != "write" {
			continue
		}
		if p := acts[i].path; strings.HasPrefix(p, "~") && p != "~" && !strings.HasPrefix(p, "~/") {
			// ~user is another account's home: the check does not resolve it, so it is not a relative path
			acts[i] = action{kind: "unresolved", cause: "a path under another user's home (~user)"}
			continue
		}
		acts[i].path = absolute(acts[i].path, c.Cwd, env)
	}
	return acts
}

func absolute(p, cwd string, env HookEnv) string {
	if strings.HasPrefix(p, "~/") && env.Home != "" {
		p = filepath.Join(env.Home, p[2:])
	}
	if !rooted(p) && cwd != "" {
		p = filepath.Join(cwd, p)
	}
	p = filepath.Clean(p)
	if env.Resolve != nil {
		p = env.Resolve(p)
	}
	return p
}

// rooted: an absolute path, or on Windows a path rooted on the current drive (`\x`, `/x`), which must never be
// joined to the working directory (that would make `/etc/hosts` look like a file inside the workspace).
func rooted(p string) bool {
	return filepath.IsAbs(p) || strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`)
}

func decideAction(p *Policy, a action, env HookEnv) outcome {
	r := &p.Commands
	switch a.kind {
	case "unresolved":
		return outcome{verdict: r.Unresolved, rule: unresolvedRuleID, reason: "RegulAIt: this command cannot be checked (" + a.cause + ")."}
	case "exec":
		byPath := strings.ContainsAny(a.argv[0], `/\`)
		o := strictest(p, env, func(yield func(id, verdict string)) {
			for _, x := range r.Exec {
				if !argvMatch(x.Argv, a.argv) {
					continue
				}
				// a bare-name rule matches a program named by path for deny and ask (/bin/rm is still rm), but it
				// never ALLOWS one: an allow names the program found on PATH, or names its full path (review #941)
				if x.Verdict == RuleAllow && byPath && !strings.Contains(x.Argv[0], "/") {
					continue
				}
				yield(x.ID, x.Verdict)
			}
		})
		if o.verdict == RuleAllow && byPath && o.rule != "" {
			// an exception may relax a bare-name rule, but not to an allow of a program named by path
			if x, ok := execRule(r, o.rule); ok && !strings.Contains(x.Argv[0], "/") {
				o.verdict = RuleAsk
			}
		}
		if o.rule == "" {
			o = outcome{verdict: r.Default, rule: defaultExecRuleID, reason: "RegulAIt: `" + a.argv[0] + "` is decided by your organisation's default for commands."}
		} else {
			o.reason = "RegulAIt: `" + a.argv[0] + "` matches your organisation's command rule " + o.rule + "."
		}
		return withActions(r, a, byPath, o)
	case "package":
		o := strictest(p, env, func(yield func(id, verdict string)) {
			for _, x := range r.Packages.Rules {
				if (x.Ecosystem == "*" || x.Ecosystem == a.eco) && globMatch(x.Name, a.name) {
					yield(x.ID, x.Verdict)
				}
			}
		})
		label := a.eco + " package " + a.name
		if a.name == "" {
			label = a.eco + " install from a manifest"
		}
		if o.rule == "" {
			return outcome{verdict: r.Packages.Default, rule: "default.package", reason: "RegulAIt: " + label + " is decided by your organisation's default for package installs."}
		}
		o.reason = "RegulAIt: " + label + " matches your organisation's package rule " + o.rule + "."
		return o
	default: // read, write
		write := a.kind == "write"
		slash := filepath.ToSlash(a.path)
		home := filepath.ToSlash(env.Home)
		o := strictest(p, env, func(yield func(id, verdict string)) {
			for _, x := range r.Files.Rules {
				if x.Access != "any" && (x.Access == "write") != write {
					continue
				}
				if pathMatch(x.Path, slash, home) {
					yield(x.ID, x.Verdict)
				}
			}
		})
		if o.rule != "" {
			o.reason = "RegulAIt: " + a.kind + " of " + a.path + " matches your organisation's file rule " + o.rule + "."
			return o
		}
		if insideAny(a.path, env.roots) {
			return outcome{verdict: RuleAllow, rule: "default.workspace", reason: "inside the workspace"}
		}
		v, id := r.Files.OutsideRead, "default.outside-read"
		if write {
			v, id = r.Files.OutsideWrite, "default.outside-write"
		}
		return outcome{verdict: v, rule: id, reason: "RegulAIt: " + a.kind + " of " + a.path + " is outside the workspace."}
	}
}

// withActions applies the one-policy action rules (ADR-0350 §9) to an exec outcome. An action rule always tightens.
// It relaxes only the default for commands, and only when every action the argv performs is allowed and was read
// exactly by a program named by its bare name (review #952): an allowed issue create never carries a second URL, an
// unread option or a look-alike binary through. Device exceptions never apply to action rules: they come from the
// subject's gateway entitlements, and only the gateway may loosen them.
func withActions(r *CommandRules, a action, byPath bool, o outcome) outcome {
	argv := a.argv
	matches := cliActions(argv)
	relax := o.rule == defaultExecRuleID && !byPath && !a.envSet && len(matches) > 0
	allowRule := ""
	for _, m := range matches {
		ar, ok := r.actionRule(m.id)
		if !ok {
			relax = false
			continue
		}
		if ar.Verdict != RuleAllow || !m.exact {
			relax = false
		} else if allowRule == "" {
			allowRule = ar.ID
		}
		if strictness(ar.Verdict) > strictness(o.verdict) {
			o = outcome{verdict: ar.Verdict, rule: ar.ID, reason: "RegulAIt: `" + argv[0] + "` performs an action your organisation's rule " + ar.ID + " decides."}
		}
	}
	if relax && strictness(o.verdict) > strictness(RuleAllow) {
		o = outcome{verdict: RuleAllow, rule: allowRule, reason: "RegulAIt: `" + argv[0] + "` performs an action your organisation's rule " + allowRule + " allows."}
	}
	return o
}

// strictest applies active exceptions and keeps the strictest matching rule.
func strictest(p *Policy, env HookEnv, each func(func(id, verdict string))) outcome {
	var best outcome
	each(func(id, verdict string) {
		verdict = relaxed(p, env, id, verdict)
		if best.rule == "" || strictness(verdict) > strictness(best.verdict) {
			best = outcome{verdict: verdict, rule: id}
		}
	})
	return best
}

func relaxed(p *Policy, env HookEnv, id, verdict string) string {
	if p.Device == "" || env.DeviceID != p.Device {
		return verdict
	}
	now := env.Now
	if now.IsZero() {
		now = time.Now()
	}
	for _, e := range p.Exceptions {
		if e.RuleID == id && now.Before(e.NotAfter) && strictness(e.Verdict) < strictness(verdict) {
			verdict = e.Verdict
		}
	}
	return verdict
}

var driveRoot = regexp.MustCompile(`^[A-Za-z]:[\\/]?$`)

// acceptableRoots drops roots that would make most of the disk "inside the workspace": empty, relative, a filesystem
// or drive root, the home directory, or an ancestor of the home directory.
func acceptableRoots(roots []string, home string) []string {
	var out []string
	for _, r := range roots {
		if r == "" || driveRoot.MatchString(r) || !rooted(r) {
			continue
		}
		c := filepath.Clean(r)
		if c == string(filepath.Separator) || c == "/" || c == `\` {
			continue
		}
		if home != "" {
			h := filepath.Clean(home)
			if c == h || strings.HasPrefix(h, strings.TrimSuffix(c, string(filepath.Separator))+string(filepath.Separator)) {
				continue
			}
		}
		out = append(out, c)
	}
	return out
}

func insideAny(p string, roots []string) bool {
	for _, r := range roots {
		if r == "" {
			continue
		}
		r = filepath.Clean(r)
		if p == r || strings.HasPrefix(p, strings.TrimSuffix(r, string(filepath.Separator))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func globMatch(pattern, s string) bool {
	ok, err := doublestar.Match(pattern, s)
	return err == nil && ok
}

func pathMatch(pattern, p, home string) bool {
	if strings.HasPrefix(pattern, "~/") {
		if home == "" {
			return false
		}
		pattern = strings.TrimSuffix(home, "/") + "/" + pattern[2:]
	}
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		// case-insensitive file systems by default: a case change must not step around a rule
		pattern, p = strings.ToLower(pattern), strings.ToLower(p)
	}
	return globMatch(pattern, p)
}

func execRule(r *CommandRules, id string) (ExecRule, bool) {
	for _, x := range r.Exec {
		if x.ID == id {
			return x, true
		}
	}
	return ExecRule{}, false
}

func argvMatch(pats, argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	for i, pat := range pats {
		if pat == "**" && i == len(pats)-1 {
			return true
		}
		if i >= len(argv) {
			return false
		}
		s := argv[i]
		if i == 0 && !strings.Contains(pat, "/") {
			s = path.Base(filepath.ToSlash(s))
		}
		if !globMatch(pat, s) {
			return false
		}
	}
	return len(argv) == len(pats)
}

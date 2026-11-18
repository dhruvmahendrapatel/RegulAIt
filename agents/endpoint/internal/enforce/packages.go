package enforce

// Package installs on a command line (ADR-0350 §3): a declared table of package managers, the sub-commands that
// install (or download and run) a package, and the options that take a value, so a value is never read as a
// package name. Names are reduced to the package itself (no version, extra or tag) so a rule names a package once.
// A manager or sub-command not in the table is an ordinary command, decided by the exec rules.

import (
	"path"
	"regexp"
	"strings"
)

// PackageEcosystems are the ecosystems a package rule may name.
var PackageEcosystems = []string{"npm", "pypi", "apt", "dnf", "apk", "brew", "cargo", "go", "gem"}

type pkgManager struct {
	eco string
	// subs are the installing sub-commands (one word, or two joined by a space, such as "pip install")
	subs map[string]bool
	// bare: the manager with no sub-command installs from the manifest (yarn)
	bare bool
	// launcher: the program itself downloads and runs its first argument (npx, bunx, uvx)
	launcher  bool
	valueOpts map[string]bool
	// manifestOpts name a requirements or lock file: the install reads its names from a file
	manifestOpts map[string]bool
	// nameOpts name the package in their value (npx -p NAME, uvx --from NAME, pipx --spec NAME)
	nameOpts map[string]bool
}

var npmInstall = set("install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci")

var pkgManagers = map[string]pkgManager{
	"npm":     {eco: "npm", subs: npmInstall, valueOpts: set("--prefix", "-w", "--workspace", "--registry", "--tag", "--omit", "--include", "--cache")},
	"pnpm":    {eco: "npm", subs: set("add", "install", "i", "dlx"), valueOpts: set("-C", "--dir", "--filter", "-F", "--registry")},
	"yarn":    {eco: "npm", subs: set("add", "install", "dlx"), bare: true, valueOpts: set("--cwd", "--registry")},
	"bun":     {eco: "npm", subs: set("add", "install", "i", "x"), valueOpts: set("--cwd", "--registry")},
	"npx":     {eco: "npm", launcher: true, valueOpts: set("-p", "--package", "-c", "--call"), nameOpts: set("-p", "--package")},
	"bunx":    {eco: "npm", launcher: true},
	"pip":     {eco: "pypi", subs: set("install", "download"), valueOpts: set("-i", "--index-url", "--extra-index-url", "-t", "--target", "--prefix", "--root", "-f", "--find-links", "-e", "--editable"), manifestOpts: set("-r", "--requirement", "-c", "--constraint")},
	"uv":      {eco: "pypi", subs: set("pip install", "add", "tool install", "tool run", "sync"), valueOpts: set("--index-url", "--extra-index-url", "-p", "--python", "--with"), manifestOpts: set("-r", "--requirements", "-c", "--constraint")},
	"uvx":     {eco: "pypi", launcher: true, valueOpts: set("--from", "--with", "-p", "--python"), nameOpts: set("--from")},
	"pipx":    {eco: "pypi", subs: set("install", "run", "inject"), valueOpts: set("--python", "--spec", "--index-url"), nameOpts: set("--spec")},
	"apt":     {eco: "apt", subs: set("install", "reinstall"), valueOpts: set("-o", "-t", "-c", "--target-release")},
	"apt-get": {eco: "apt", subs: set("install", "reinstall"), valueOpts: set("-o", "-t", "-c", "--target-release")},
	"dnf":     {eco: "dnf", subs: set("install", "reinstall"), valueOpts: set("--repo", "--setopt")},
	"yum":     {eco: "dnf", subs: set("install", "reinstall"), valueOpts: set("--enablerepo", "--setopt")},
	"apk":     {eco: "apk", subs: set("add"), valueOpts: set("-X", "--repository")},
	"brew":    {eco: "brew", subs: set("install", "reinstall")},
	"cargo":   {eco: "cargo", subs: set("install", "add"), valueOpts: set("--git", "--path", "--version", "--registry", "--features", "-F", "--root")},
	"go":      {eco: "go", subs: set("install", "get")},
	"gem":     {eco: "gem", subs: set("install"), valueOpts: set("-v", "--version", "-s", "--source", "-i", "--install-dir")},
}

func init() {
	pkgManagers["pip3"] = pkgManagers["pip"]
}

var pythons = regexp.MustCompile(`^python(\d+(\.\d+)?)?$`)

func packageActions(argv []string) []action {
	prog := path.Base(argv[0])
	args := argv[1:]
	if pythons.MatchString(prog) && len(args) >= 2 && args[0] == "-m" && (args[1] == "pip" || args[1] == "pip3") {
		prog, args = "pip", args[2:]
	}
	m, ok := pkgManagers[prog]
	if !ok {
		return nil
	}
	if m.launcher {
		names, _ := packageNames(args, m, true)
		if len(names) == 0 {
			return nil
		}
		return []action{pkgAction(m.eco, names[0])}
	}
	// find the sub-command: the first argument that is not an option (or the first two, for uv)
	rest, sub := args, ""
	for i := 0; i < len(rest); i++ {
		if strings.HasPrefix(rest[i], "-") {
			if m.valueOpts[rest[i]] {
				i++
			}
			continue
		}
		sub, rest = rest[i], rest[i+1:]
		if !m.subs[sub] && len(rest) > 0 && m.subs[sub+" "+rest[0]] {
			sub, rest = sub+" "+rest[0], rest[1:]
		}
		break
	}
	if sub == "" {
		if m.bare {
			return []action{pkgAction(m.eco, "")}
		}
		return nil
	}
	if !m.subs[sub] {
		return nil
	}
	launch := sub == "dlx" || sub == "x" || sub == "run" || sub == "tool run"
	names, manifest := packageNames(rest, m, launch)
	if launch && len(names) > 1 {
		names = names[:1]
	}
	var acts []action
	for _, n := range names {
		acts = append(acts, pkgAction(m.eco, n))
	}
	if len(acts) == 0 || manifest {
		acts = append(acts, pkgAction(m.eco, ""))
	}
	return acts
}

// packageNames returns the non-option arguments (only the first, for a launcher), and whether a manifest option was
// given.
func packageNames(args []string, m pkgManager, first bool) (names []string, manifest bool) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			if first && i+1 < len(args) && len(names) == 0 {
				names = append(names, args[i+1])
			}
			break
		}
		if strings.HasPrefix(a, "-") && len(a) > 1 {
			if k, v, ok := strings.Cut(a, "="); ok {
				a = k
				if m.manifestOpts[a] {
					manifest = true
				}
				if m.nameOpts[a] && v != "" {
					names = append(names, v)
				}
				continue
			}
			if m.manifestOpts[a] {
				manifest = true
				i++
				continue
			}
			if m.valueOpts[a] {
				if m.nameOpts[a] && i+1 < len(args) {
					names = append(names, args[i+1])
				}
				i++
			}
			continue
		}
		names = append(names, a)
		if first {
			break
		}
	}
	return names, manifest
}

var pypiCut = regexp.MustCompile(`[=<>!~\[;@ ]`)
var pypiSep = regexp.MustCompile(`[-_.]+`)

func pkgAction(eco, raw string) action {
	return action{kind: "package", eco: eco, name: packageName(eco, raw)}
}

// packageName reduces a command-line package spec to its name. Paths and URLs are kept as written.
func packageName(eco, s string) string {
	if s == "" || strings.Contains(s, "://") || strings.HasPrefix(s, ".") || strings.HasPrefix(s, "/") {
		return s
	}
	switch eco {
	case "npm":
		if strings.HasPrefix(s, "@") {
			if i := strings.Index(s[1:], "@"); i >= 0 {
				return s[:i+1]
			}
			return s
		}
		if i := strings.Index(s, "@"); i > 0 {
			return s[:i]
		}
	case "pypi":
		if i := pypiCut.FindStringIndex(s); i != nil {
			s = s[:i[0]]
		}
		return pypiSep.ReplaceAllString(strings.ToLower(s), "-")
	case "go", "cargo":
		if i := strings.Index(s, "@"); i > 0 {
			return s[:i]
		}
	case "apt", "dnf":
		if i := strings.IndexAny(s, "="); i > 0 {
			return s[:i]
		}
	}
	return s
}

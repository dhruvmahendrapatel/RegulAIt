package collect

import (
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// NewEnv builds the production environment for the logged-in user. Each root is an os.Root, so a symlink inside it
// cannot reach outside it (R15 §2.3: "never follows symlinks out of the home directory"). The roots stay open for
// the life of the process.
func NewEnv(home string) (*Env, error) {
	env := &Env{OS: runtime.GOOS, Roots: map[contract.Root]fs.FS{}, StartupFiles: DefaultStartupFiles(runtime.GOOS), MaxFileBytes: DefaultMaxFileBytes}
	if err := addRoot(env, contract.RootHome, home); err != nil {
		return nil, err
	}
	for root, dir := range platformRoots() {
		_ = addRoot(env, root, dir) // an absent root is reported as a gap by the collectors that need it
	}
	env.PathDirs = pathDirs(home, filepath.SplitList(os.Getenv("PATH")))
	if runtime.GOOS == "windows" {
		env.PathExt = pathExt(os.Getenv("PATHEXT"))
	}
	env.Registry = platformRegistry()
	env.Processes = processTable{}
	env.PlistToXML = platformPlistToXML()
	return env, nil
}

func addRoot(env *Env, root contract.Root, dir string) error {
	if dir == "" {
		return os.ErrNotExist
	}
	r, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	env.Roots[root] = r.FS()
	return nil
}

// pathDirs resolves PATH entries to a root and a reportable path: under the home directory a relative path, and
// otherwise the absolute path, which then names no user. Relative and duplicate entries are dropped.
func pathDirs(home string, entries []string) []PathDir {
	var out []PathDir
	seen := map[string]bool{}
	for _, dir := range entries {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		dir = filepath.Clean(dir)
		key := dir
		if runtime.GOOS == "windows" {
			key = strings.ToLower(dir)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		r, err := os.OpenRoot(dir)
		if err != nil {
			continue
		}
		if rel, ok := under(home, dir); ok {
			out = append(out, PathDir{Root: contract.RootHome, Path: filepath.ToSlash(rel), FS: r.FS()})
		} else {
			out = append(out, PathDir{Root: contract.RootPath, Path: filepath.ToSlash(dir), FS: r.FS()})
		}
	}
	return out
}

// under reports whether dir is home or inside it, and dir's path relative to home.
func under(home, dir string) (string, bool) {
	if home == "" {
		return "", false
	}
	rel, err := filepath.Rel(home, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return rel, true
}

func pathExt(v string) []string {
	if v == "" {
		v = ".COM;.EXE;.BAT;.CMD"
	}
	var out []string
	for _, e := range strings.Split(v, ";") {
		e = strings.TrimSpace(e)
		if strings.HasPrefix(e, ".") && len(e) <= 8 {
			out = append(out, strings.ToLower(e))
		}
	}
	return out
}

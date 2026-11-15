package directive

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"reflect"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
	"github.com/tidwall/sjson"
)

// Result is what applying one verified directive did.
type Result struct {
	Outcome string
	Code    string
	// Provider is the manifest entry's provider name, for the developer's notice.
	Provider string
}

func failed(code string) Result { return Result{Outcome: contract.OutcomeFailed, Code: code} }

// Apply removes the directive's server entry, or explains why it did not. It never touches anything but the one
// file the manifest locates, and in it only the named entries whose identity matches.
func Apply(d *Directive, col *pack.Collection, env *collect.Env) Result {
	a := d.Asset
	var entry *pack.Entry
	for i := range col.Entries {
		if col.Entries[i].SignatureID == a.SignatureID && col.Entries[i].Kind == contract.KindMCPConfig {
			entry = &col.Entries[i]
			break
		}
	}
	if entry == nil {
		return failed("not_in_manifest")
	}
	if !fs.ValidPath(a.Path) || a.Path == "." {
		return failed("path_refused")
	}
	located, present := false, false
	for _, l := range entry.Files {
		if l.OS != env.OS || l.Root != a.Root || !locatorPattern(l.Path, a.Path) {
			continue
		}
		located = true
		if collect.LocatorMatches(env, l, a.Path) {
			present = true
			break
		}
	}
	if !located {
		return failed("not_in_manifest")
	}
	res := Result{Provider: entry.Provider}
	if !present {
		res.Outcome, res.Code = contract.OutcomeNothingToRemove, "not_present"
		return res
	}
	root, ok := env.UserRoots[a.Root]
	if !ok {
		return failed("path_refused")
	}
	st, err := root.Lstat(a.Path)
	if err != nil {
		if os.IsNotExist(err) {
			res.Outcome, res.Code = contract.OutcomeNothingToRemove, "not_present"
			return res
		}
		return failed("path_refused")
	}
	if !st.Mode().IsRegular() {
		// a symlink, even one inside the root, is never written through
		return failed("path_refused")
	}
	limit := env.MaxFileBytes
	if limit <= 0 {
		limit = collect.DefaultMaxFileBytes
	}
	if st.Size() > limit || strings.EqualFold(path.Ext(a.Path), ".toml") {
		return failed("unsupported_format")
	}
	raw, err := readAll(root, a.Path, limit)
	if err != nil {
		return failed("path_refused")
	}
	if !collect.PlainJSON(raw) {
		// JSONC comments and trailing commas would be lost by any rewrite
		return failed("unsupported_format")
	}
	servers, parsed := collect.MCPServersAt(a.Path, raw)
	if !parsed {
		return failed("parse_failed")
	}
	var named, matched [][]string
	for _, s := range servers {
		if s.Path[len(s.Path)-1] != a.ServerName {
			continue
		}
		named = append(named, s.Path)
		kind, id, ok := collect.MCPIdentity(s.Server)
		if ok && kind == a.IdentityKind && id == a.Identity && (a.PackageVersion == "" || s.Server.PackageVersion == a.PackageVersion) {
			matched = append(matched, s.Path)
		}
	}
	switch {
	case len(named) == 0:
		res.Outcome, res.Code = contract.OutcomeNothingToRemove, "not_present"
		return res
	case len(matched) == 0:
		res.Outcome, res.Code = contract.OutcomeNothingToRemove, "identity_differs"
		return res
	}
	out, ok := removeEntries(raw, matched)
	if !ok {
		return failed("write_failed")
	}
	if err := replaceFile(root, a.Path, out, st.Mode().Perm()); err != nil {
		return failed("write_failed")
	}
	res.Outcome, res.Code = contract.OutcomeRemoved, "removed"
	return res
}

// locatorPattern: the locator's path, literal or with `*` and `?` segment globs, names this path.
func locatorPattern(pattern, name string) bool {
	if !strings.ContainsAny(pattern, "*?") {
		return pattern == name
	}
	ok, err := path.Match(pattern, name)
	return err == nil && ok
}

func readAll(root *os.Root, name string, limit int64) ([]byte, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}

// removeEntries deletes each key path from raw, keeping every other byte, and proves the result is exactly the
// original document minus those entries. Any doubt (an escaping surprise, a library change) is a refusal.
func removeEntries(raw []byte, paths [][]string) ([]byte, bool) {
	var want map[string]any
	if json.Unmarshal(raw, &want) != nil {
		return nil, false
	}
	out := raw
	for _, p := range paths {
		next, err := sjson.DeleteBytes(out, escapePath(p))
		if err != nil {
			return nil, false
		}
		out = next
		deleteAt(want, p)
	}
	var got map[string]any
	if json.Unmarshal(out, &got) != nil || !reflect.DeepEqual(got, want) || bytes.Equal(out, raw) {
		return nil, false
	}
	return out, true
}

func deleteAt(doc map[string]any, p []string) {
	m := doc
	for _, k := range p[:len(p)-1] {
		next, ok := m[k].(map[string]any)
		if !ok {
			return
		}
		m = next
	}
	delete(m, p[len(p)-1])
}

// escapePath writes a key path in gjson/sjson syntax, escaping every character that is not a plain identifier
// character, so a project path or a dotted server name is always one literal key.
func escapePath(p []string) string {
	var b strings.Builder
	for i, seg := range p {
		if i > 0 {
			b.WriteByte('.')
		}
		for _, r := range seg {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
				b.WriteByte('\\')
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}

// replaceFile writes data to a new file beside name (same mode), syncs it, and renames it over name, all through
// the root, so the developer never sees a half-written config and nothing escapes the root.
func replaceFile(root *os.Root, name string, data []byte, mode fs.FileMode) error {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmp := path.Join(path.Dir(name), ".regulait-removal-"+hex.EncodeToString(suffix[:])+".tmp")
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	serr := f.Sync()
	cerr := f.Close()
	if werr != nil || serr != nil || cerr != nil {
		_ = root.Remove(tmp)
		return errors.Join(werr, serr, cerr)
	}
	if err := root.Rename(tmp, name); err != nil {
		_ = root.Remove(tmp)
		return err
	}
	return nil
}

package directive

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

var now = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

const (
	identity = "5b0c7a3e-2f1d-4c8b-9a6e-0d4f3b2a1c9e"
	keyID    = "regulait-policy-test"
)

func key(t *testing.T) (enforce.Keyring, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{3}, 64)))
	if err != nil {
		t.Fatal(err)
	}
	return enforce.Keyring{keyID: pub}, priv
}

func base() Directive {
	return Directive{
		Schema: Schema, DirectiveID: "0f8e6a52-3c4b-4d1e-8f2a-6b7c9d0e1f2a", RemovalID: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
		IdentityID: identity, IssuedAt: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour), Action: ActionRemoveServer,
		Asset: Asset{SignatureID: "cursor-mcp", Root: contract.RootHome, Path: ".cursor/mcp.json", ServerName: "shadow",
			IdentityKind: "package", Identity: "@evil/shadow-mcp"},
	}
}

func envelope(t *testing.T, priv ed25519.PrivateKey, payload []byte) []byte {
	t.Helper()
	b, _ := json.Marshal(enforce.Envelope{KeyID: keyID, Payload: base64.StdEncoding.EncodeToString(payload),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))})
	return b
}

func signedDirective(t *testing.T, priv ed25519.PrivateKey, d Directive) []byte {
	t.Helper()
	p, _ := json.Marshal(d)
	return envelope(t, priv, p)
}

func TestVerify(t *testing.T) {
	keys, priv := key(t)
	if d, code, err := Verify(signedDirective(t, priv, base()), keys, identity, now); err != nil || code != "" || d.Asset.ServerName != "shadow" {
		t.Fatalf("a valid directive did not verify: %v %q", err, code)
	}
	_, other, _ := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{4}, 64)))
	mut := func(f func(*Directive)) []byte { d := base(); f(&d); return signedDirective(t, priv, d) }
	refused := map[string][]byte{
		"the compiled keyring is empty": nil, // checked below with enforce.CompiledKeyring
		"another key":                   signedDirective(t, other, base()),
		"unknown member":                envelope(t, priv, []byte(`{"schema":"regulait.endpoint-directive/1","x":1}`)),
		"unknown schema":                mut(func(d *Directive) { d.Schema = "regulait.endpoint-directive/2" }),
		"unknown action":                mut(func(d *Directive) { d.Action = "delete_file" }),
		"bad directive id":              mut(func(d *Directive) { d.DirectiveID = "x" }),
		"bad server name":               mut(func(d *Directive) { d.Asset.ServerName = "a b" }),
		"unknown identity kind":         mut(func(d *Directive) { d.Asset.IdentityKind = "unknown" }),
		"too large":                     bytes.Repeat([]byte(" "), maxEnvelope+1),
	}
	for name, raw := range refused {
		k := keys
		if raw == nil {
			raw, k = signedDirective(t, priv, base()), enforce.CompiledKeyring
		}
		if _, _, err := Verify(raw, k, identity, now); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: not refused (%v)", name, err)
		}
	}
	reported := map[string]struct {
		raw  []byte
		code string
	}{
		"another identity":     {mut(func(d *Directive) { d.IdentityID = "6c1d8b4f-3a2e-4d9c-8b7f-1e5a4c3b2d0f" }), "wrong_identity"},
		"expired":              {mut(func(d *Directive) { d.NotAfter = now.Add(-time.Second) }), "expired"},
		"window too long":      {mut(func(d *Directive) { d.NotAfter = d.IssuedAt.Add(MaxValidity + time.Second) }), "expired"},
		"issued in the future": {mut(func(d *Directive) { d.IssuedAt = now.Add(time.Hour); d.NotAfter = now.Add(2 * time.Hour) }), "expired"},
	}
	for name, c := range reported {
		if _, code, err := Verify(c.raw, keys, identity, now); err != nil || code != c.code {
			t.Errorf("%s: got %q %v, want %q", name, code, err, c.code)
		}
	}
}

// fixture: a home directory with one MCP config, a manifest that locates it, and the env the collector would use.
type fixture struct {
	home string
	col  *pack.Collection
	env  *collect.Env
}

func newFixture(t *testing.T, rel, content string, locators ...string) *fixture {
	t.Helper()
	home := t.TempDir()
	if rel != "" {
		p := filepath.Join(home, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if len(locators) == 0 {
		locators = []string{".cursor/mcp.json"}
	}
	e := pack.Entry{SignatureID: "cursor-mcp", Kind: contract.KindMCPConfig, Provider: "cursor"}
	for _, l := range locators {
		e.Files = append(e.Files, pack.Locator{OS: runtime.GOOS, Root: contract.RootHome, Path: l})
	}
	env, err := collect.NewEnv(home)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{home: home, col: &pack.Collection{Schema: contract.SchemaCollection, Entries: []pack.Entry{e}}, env: env}
}

func (f *fixture) read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(f.home, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const cursorConfig = `{
  "mcpServers": {
    "regulait": {"command": "npx", "args": ["-y", "@regulait/mcp@1.0.0"]},
    "shadow":   {"command": "npx", "args": ["-y", "@evil/shadow-mcp@2.1.0"]}
  },
  "theme": "dark"
}
`

func TestApplyRemovesOnlyTheNamedEntry(t *testing.T) {
	f := newFixture(t, ".cursor/mcp.json", cursorConfig)
	d := base()
	r := Apply(&d, f.col, f.env)
	if r.Outcome != contract.OutcomeRemoved || r.Code != "removed" || r.Provider != "cursor" {
		t.Fatalf("got %+v", r)
	}
	got := f.read(t, ".cursor/mcp.json")
	if strings.Contains(got, "shadow") || !strings.Contains(got, `"regulait": {"command": "npx", "args": ["-y", "@regulait/mcp@1.0.0"]}`) || !strings.Contains(got, `"theme": "dark"`) {
		t.Errorf("the edit touched more than the entry:\n%s", got)
	}
	if st, _ := os.Stat(filepath.Join(f.home, ".cursor", "mcp.json")); runtime.GOOS != "windows" && st.Mode().Perm() != 0o640 {
		t.Errorf("the file mode changed: %v", st.Mode())
	}
	entries, _ := os.ReadDir(filepath.Join(f.home, ".cursor"))
	if len(entries) != 1 {
		t.Errorf("a temporary file was left behind: %v", entries)
	}
	// applying again finds nothing
	if r := Apply(&d, f.col, f.env); r.Outcome != contract.OutcomeNothingToRemove || r.Code != "not_present" {
		t.Errorf("second apply: %+v", r)
	}
}

func TestApplyVersionAndIdentity(t *testing.T) {
	f := newFixture(t, ".cursor/mcp.json", cursorConfig)
	d := base()
	d.Asset.PackageVersion = "9.9.9"
	if r := Apply(&d, f.col, f.env); r.Code != "identity_differs" {
		t.Errorf("another version was removed: %+v", r)
	}
	d = base()
	d.Asset.Identity = "@other/pkg"
	if r := Apply(&d, f.col, f.env); r.Code != "identity_differs" {
		t.Errorf("a same-named server with another identity was removed: %+v", r)
	}
	d = base()
	d.Asset.PackageVersion = "2.1.0"
	if r := Apply(&d, f.col, f.env); r.Outcome != contract.OutcomeRemoved {
		t.Errorf("the named version was not removed: %+v", r)
	}
}

func TestApplyRefusals(t *testing.T) {
	cases := []struct {
		name    string
		rel     string
		content string
		mutate  func(*Directive)
		code    string
	}{
		{"signature id not in the manifest", ".cursor/mcp.json", cursorConfig, func(d *Directive) { d.Asset.SignatureID = "other" }, "not_in_manifest"},
		{"path the manifest does not locate", ".cursor/mcp.json", cursorConfig, func(d *Directive) { d.Asset.Path = ".ssh/config" }, "not_in_manifest"},
		{"a path escaping the root", ".cursor/mcp.json", cursorConfig, func(d *Directive) { d.Asset.Path = "../etc/passwd" }, "path_refused"},
		{"a root the agent never writes", ".cursor/mcp.json", cursorConfig, func(d *Directive) { d.Asset.Root = contract.RootSystemApplications }, "not_in_manifest"},
		{"JSONC would lose comments", ".cursor/mcp.json", "{\n  // a comment\n  \"mcpServers\": {\"shadow\": {\"command\": \"npx\", \"args\": [\"@evil/shadow-mcp\"]}}\n}\n", nil, "unsupported_format"},
		{"trailing commas", ".cursor/mcp.json", `{"mcpServers": {"shadow": {"command": "npx", "args": ["@evil/shadow-mcp"]},}}`, nil, "unsupported_format"},
		{"not an object", ".cursor/mcp.json", `[1,2]`, nil, "parse_failed"},
		{"file gone", "", "", nil, "not_present"},
	}
	for _, c := range cases {
		f := newFixture(t, c.rel, c.content)
		d := base()
		if c.mutate != nil {
			c.mutate(&d)
		}
		before := ""
		if c.rel != "" {
			before = f.read(t, c.rel)
		}
		if r := Apply(&d, f.col, f.env); r.Code != c.code {
			t.Errorf("%s: got %+v, want %s", c.name, r, c.code)
		}
		if c.rel != "" && f.read(t, c.rel) != before {
			t.Errorf("%s: the file changed", c.name)
		}
	}
}

func TestApplyTOMLIsNotEdited(t *testing.T) {
	f := newFixture(t, ".codex/config.toml", "[mcp_servers.shadow]\ncommand = \"npx\"\nargs = [\"@evil/shadow-mcp\"]\n", ".codex/config.toml")
	d := base()
	d.Asset.Path = ".codex/config.toml"
	if r := Apply(&d, f.col, f.env); r.Code != "unsupported_format" {
		t.Errorf("a TOML config was edited: %+v", r)
	}
}

func TestApplyGlobLocatorAndNestedProjects(t *testing.T) {
	// a Claude Code-style per-project server under a key that is a path with dots and slashes
	content := `{"projects": {"/work/my.app": {"mcpServers": {"shadow": {"command": "npx", "args": ["@evil/shadow-mcp"]}, "keep": {"command": "uvx", "args": ["keep-mcp"]}}}}, "mcpServers": {"shadow": {"command": "npx", "args": ["@evil/shadow-mcp"]}}}`
	f := newFixture(t, ".config/tool/mcp.json", content, ".config/*/mcp.json")
	d := base()
	d.Asset.Path = ".config/tool/mcp.json"
	if r := Apply(&d, f.col, f.env); r.Outcome != contract.OutcomeRemoved {
		t.Fatalf("got %+v", r)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(f.read(t, ".config/tool/mcp.json")), &doc); err != nil {
		t.Fatal(err)
	}
	proj := doc["projects"].(map[string]any)["/work/my.app"].(map[string]any)["mcpServers"].(map[string]any)
	if _, ok := proj["shadow"]; ok || proj["keep"] == nil || len(doc["mcpServers"].(map[string]any)) != 0 {
		t.Errorf("nested removal wrong: %v", doc)
	}
}

func TestApplyRefusesSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	f := newFixture(t, "real/mcp.json", cursorConfig)
	if err := os.MkdirAll(filepath.Join(f.home, ".cursor"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(f.home, "real", "mcp.json"), filepath.Join(f.home, ".cursor", "mcp.json")); err != nil {
		t.Fatal(err)
	}
	d := base()
	if r := Apply(&d, f.col, f.env); r.Code != "path_refused" && r.Code != "not_present" {
		t.Errorf("a symlinked config was written through: %+v", r)
	}
	if strings.Contains(f.read(t, "real/mcp.json"), "shadow") == false {
		t.Error("the symlink target was edited")
	}
}

func TestEscapePath(t *testing.T) {
	if got := escapePath([]string{"projects", "/work/my.app", "mcpServers", "a.b*c?"}); got != `projects.\/work\/my\.app.mcpServers.a\.b\*c\?` {
		t.Errorf("got %s", got)
	}
}

func TestLedger(t *testing.T) {
	l := NewLedger()
	d := base()
	o := contract.DirectiveOutcome{DirectiveID: d.DirectiveID, Outcome: contract.OutcomeRemoved, Code: "removed"}
	if !l.Record(&d, o) {
		t.Fatal("not recorded")
	}
	if got, ok := l.Seen(d.DirectiveID); !ok || got != o {
		t.Error("not seen")
	}
	l.Prune(d.NotAfter)
	if _, ok := l.Seen(d.DirectiveID); !ok {
		t.Error("pruned while it could still verify")
	}
	l.Prune(d.NotAfter.Add(MaxSkew + time.Second))
	if _, ok := l.Seen(d.DirectiveID); ok {
		t.Error("kept past its window")
	}
}

func TestNotifierNeverUsesAShell(t *testing.T) {
	text := Notice(`shadow`, "Cursor", `.cursor/mcp.json"; do shell script "rm -rf ~"`)
	for _, goos := range []string{"darwin", "linux", "windows"} {
		name, args := notifierCommand(goos, "dev", text)
		if name == "" || strings.Contains(name, "sh") && name != "notify-send" {
			t.Errorf("%s: notifier %q", goos, name)
		}
		// the text is passed as exactly one argv item, never inside the script
		n := 0
		for _, a := range args {
			if a == text {
				n++
			} else if strings.Contains(a, "rm -rf") {
				t.Errorf("%s: the text reached the script: %q", goos, a)
			}
		}
		if n != 1 {
			t.Errorf("%s: the text is not one argv item: %v", goos, args)
		}
	}
	if name, _ := notifierCommand("windows", `bad user`, text); name != "" {
		t.Error("an unusual Windows user name was used as a msg target")
	}
}

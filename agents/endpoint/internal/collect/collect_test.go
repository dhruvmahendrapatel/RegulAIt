package collect

import (
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

// A synthetic catalogue: no real product appears in the fixtures.
const fixtureCollection = `{"schema":"regulait.endpoint-collection/1","entries":[
 {"signatureId":"sig.app","kind":"desktop_app","provider":"example","bundleIds":["com.example.assistant"],
  "desktopIds":["example-assistant.desktop"],"uninstallNames":["Example Assistant"]},
 {"signatureId":"sig.ide","kind":"ide_extension","provider":"example","extensionIds":["examplepub.example-helper","example-plugin"],
  "extensionDirs":[{"os":"linux","root":"home","path":".example-editor/extensions"},
                   {"os":"linux","root":"home","path":".local/share/ExampleIDE/*/plugins"},
                   {"os":"darwin","root":"home","path":".example-editor/extensions"}]},
 {"signatureId":"sig.browser","kind":"browser_extension","provider":"example",
  "extensionIds":["abcdefghijklmnopabcdefghijklmnop","helper@example.invalid"],
  "extensionDirs":[{"os":"linux","root":"home","path":".config/example-browser/*/Extensions"}],
  "firefoxProfiles":[{"os":"linux","root":"home","path":".example-fox/*"}]},
 {"signatureId":"sig.runtime","kind":"local_runtime","provider":"example","processNames":["example-serve"],"ports":[11434]},
 {"signatureId":"sig.config","kind":"assistant_config","provider":"example","keyNames":["EXAMPLE_API_KEY"],
  "files":[{"os":"linux","root":"home","path":".config/example/*.json"},{"os":"linux","root":"home","path":".example.env"}]},
 {"signatureId":"sig.cli","kind":"cli","provider":"example","executables":["example-cli"]},
 {"signatureId":"sig.env","kind":"env_name","provider":"example","envNames":["EXAMPLE_API_KEY"]}
]}`

// fakeKey builds a key-shaped value at run time (gitleaks runs over the repo).
func fakeKey() string { return "sk-ant-" + "api03-" + strings.Repeat("Q", 40) }

func linuxHome() fstest.MapFS {
	return fstest.MapFS{
		".local/share/applications/example-assistant.desktop":                                               {Data: []byte("[Desktop Entry]\nName=x\n")},
		".local/share/applications/unrelated.desktop":                                                       {Data: []byte("[Desktop Entry]\n")},
		".example-editor/extensions/examplepub.example-helper-1.2.3/package.json":                           {Data: []byte(`{"publisher":"ExamplePub","name":"example-helper","version":"1.2.3"}`)},
		".example-editor/extensions/other.thing-0.1/package.json":                                           {Data: []byte(`{"publisher":"other","name":"thing","version":"0.1"}`)},
		".local/share/ExampleIDE/2026.1/plugins/example-plugin/lib/x.jar":                                   {Data: []byte("jar")},
		".config/example-browser/Default/Extensions/abcdefghijklmnopabcdefghijklmnop/4.5.6_0/manifest.json": {Data: []byte("{}")},
		".config/example-browser/Profile 2/Extensions/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/1.0/manifest.json":   {Data: []byte("{}")},
		".example-fox/abc.default/extensions.json":                                                          {Data: []byte(`{"addons":[{"id":"helper@example.invalid","version":"2.0"},{"id":"x@y","version":"1"}]}`)},
		".config/example/settings.json":                                                                     {Data: []byte(`{"mcpServers":{"Alice's server":{"env":{"EXAMPLE_API_KEY":"` + fakeKey() + `","OTHER":"plain value"}}},"theme":"dark","Alice's token":"` + fakeKey() + `"}`)},
		".example.env":                                                                                      {Data: []byte("# comment\nexport EXAMPLE_API_KEY=\nTOKEN=" + fakeKey() + "\n")},
		".bashrc":                                                                                           {Data: []byte("alias ll='ls -l'\nexport EXAMPLE_API_KEY=\"" + fakeKey() + "\"\n")},
		".zshrc":                                                                                            {Data: []byte("export PATH=$PATH:/opt/x\n")},
		"bin/example-cli":                                                                                   {Data: []byte("#!/bin/sh\n"), Mode: 0o755},
	}
}

type fakeProcs struct {
	procs     []Process
	listeners []Listener
	err       error
}

func (f fakeProcs) Processes() ([]Process, error)  { return f.procs, f.err }
func (f fakeProcs) Listeners() ([]Listener, error) { return f.listeners, f.err }

func mustCollection(t *testing.T) *pack.Collection {
	t.Helper()
	c, err := pack.ParseCollection([]byte(fixtureCollection))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func find(facts []contract.Fact, sig string) []contract.Fact {
	var out []contract.Fact
	for _, f := range facts {
		if f.SignatureID == sig {
			out = append(out, f)
		}
	}
	return out
}

func hasGap(gaps []contract.Gap, k contract.Kind, reason string) bool {
	for _, g := range gaps {
		if g.Kind == k && g.Reason == reason {
			return true
		}
	}
	return false
}

func linuxEnv() *Env {
	home := linuxHome()
	return &Env{
		OS: "linux",
		Roots: map[contract.Root]fs.FS{
			contract.RootHome:               home,
			contract.RootSystemApplications: fstest.MapFS{"example-assistant.desktop": {Data: []byte("[Desktop Entry]\n")}},
		},
		PathDirs:     []PathDir{{Root: contract.RootHome, Path: "bin", FS: mustSub(home, "bin")}, {Root: contract.RootPath, Path: "/usr/bin", FS: fstest.MapFS{}}},
		Processes:    fakeProcs{procs: []Process{{PID: 10, Name: "example-serve"}, {PID: 11, Name: "bash"}}, listeners: []Listener{{Port: 11434, Name: "example-serve"}, {Port: 22, Name: ""}}},
		StartupFiles: DefaultStartupFiles("linux"),
	}
}

func mustSub(f fs.FS, dir string) fs.FS {
	s, err := fs.Sub(f, dir)
	if err != nil {
		panic(err)
	}
	return s
}

func TestLinuxFixture(t *testing.T) {
	facts, gaps := Collect(linuxEnv(), mustCollection(t), nil)

	app := find(facts, "sig.app")
	if len(app) != 2 || app[0].Location.Root != contract.RootHome || app[1].Location != (contract.Location{Root: contract.RootSystemApplications, Path: "example-assistant.desktop"}) {
		t.Errorf("desktop apps: %+v", app)
	}
	ide := find(facts, "sig.ide")
	if len(ide) != 2 {
		t.Fatalf("ide: %+v", ide)
	}
	if ide[0].Identifier != "examplepub.example-helper" || ide[0].Version != "1.2.3" || ide[0].Location.Path != ".example-editor/extensions/examplepub.example-helper-1.2.3" {
		t.Errorf("vscode-style: %+v", ide[0])
	}
	if ide[1].Identifier != "example-plugin" || ide[1].Location.Path != ".local/share/ExampleIDE/2026.1/plugins/example-plugin" {
		t.Errorf("plugin dir: %+v", ide[1])
	}
	br := find(facts, "sig.browser")
	if len(br) != 2 || br[0].Version != "4.5.6_0" || br[1].Identifier != "helper@example.invalid" || br[1].Location.Path != ".example-fox/abc.default/extensions.json" {
		t.Errorf("browser: %+v", br)
	}
	rt := find(facts, "sig.runtime")
	if len(rt) != 2 || rt[0].MatchedOn != "processName" || rt[1].MatchedOn != "processName+port" || rt[1].Port != 11434 {
		t.Errorf("runtime: %+v", rt)
	}
	if !hasGap(gaps, contract.KindLocalRuntime, GapOtherUsersPortOnly) {
		t.Errorf("the other user's listener is not reported as a coverage gap: %+v", gaps)
	}
	cfg := find(facts, "sig.config")
	if len(cfg) != 2 {
		t.Fatalf("config: %+v", cfg)
	}
	// sorted by path: ".config/…" before ".example.env"
	settings, env := cfg[0], cfg[1]
	// a key under a free-text JSON name is reported, but as "(unnamed)"
	if len(settings.Keys) != 2 || settings.Keys[0] != (contract.KeyFound{KeyName: "(unnamed)", RuleID: "dlp.secret.anthropic_key", Present: true}) ||
		settings.Keys[1] != (contract.KeyFound{KeyName: "EXAMPLE_API_KEY", RuleID: "dlp.secret.anthropic_key", Present: true}) {
		t.Errorf("settings keys: %+v", settings.Keys)
	}
	// the empty listed name is not a key; the unlisted TOKEN is, because its value has a key's shape
	if len(env.Keys) != 1 || env.Keys[0].KeyName != "TOKEN" || env.Keys[0].RuleID != "dlp.secret.anthropic_key" {
		t.Errorf("env-file keys: %+v", env.Keys)
	}
	cli := find(facts, "sig.cli")
	if len(cli) != 1 || cli[0].Location != (contract.Location{Root: contract.RootHome, Path: "bin/example-cli"}) {
		t.Errorf("cli: %+v", cli)
	}
	en := find(facts, "sig.env")
	if len(en) != 1 || en[0].Location.Path != ".bashrc" || len(en[0].Keys) != 1 || en[0].Keys[0].RuleID != "dlp.secret.anthropic_key" {
		t.Errorf("env names: %+v", en)
	}
}

// Nothing a collector returns carries a key value, a file's other contents, or free text from a JSON key.
func TestFactsCarryNoValues(t *testing.T) {
	facts, gaps := Collect(linuxEnv(), mustCollection(t), nil)
	out, _ := json.Marshal(struct {
		F []contract.Fact
		G []contract.Gap
	}{facts, gaps})
	for _, forbidden := range []string{fakeKey()[:12], strings.Repeat("Q", 10), "plain value", "Alice", "dark", "alias"} {
		if strings.Contains(string(out), forbidden) {
			t.Errorf("report carries %q: %s", forbidden, out)
		}
	}
}

func TestDarwinBundles(t *testing.T) {
	plist := func(id, v string) []byte {
		return []byte(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>X</string><key>Nested</key><dict><key>CFBundleIdentifier</key><string>com.decoy</string></dict>
<key>CFBundleIdentifier</key><string>` + id + `</string><key>CFBundleShortVersionString</key><string>` + v + `</string></dict></plist>`)
	}
	apps := fstest.MapFS{
		"Example.app/Contents/Info.plist": {Data: plist("com.example.assistant", "3.1")},
		"Decoy.app/Contents/Info.plist":   {Data: plist("com.other", "1")},
		"Binary.app/Contents/Info.plist":  {Data: []byte("bplist00\x00\x01")},
		"NotAnApp/Contents/Info.plist":    {Data: plist("com.example.assistant", "1")},
	}
	env := &Env{OS: "darwin", Roots: map[contract.Root]fs.FS{contract.RootSystemApplications: apps, contract.RootHome: fstest.MapFS{}}}
	facts, gaps := Collect(env, mustCollection(t), nil)
	app := find(facts, "sig.app")
	if len(app) != 1 || app[0].Location.Path != "Example.app" || app[0].Version != "3.1" || app[0].Identifier != "com.example.assistant" {
		t.Fatalf("%+v", app)
	}
	if !hasGap(gaps, contract.KindDesktopApp, GapBinaryPlist) {
		t.Errorf("binary plist without a converter is not a gap: %+v", gaps)
	}
	// with a converter (plutil on macOS) the binary plist is read
	env.PlistToXML = func([]byte) ([]byte, error) { return plist("com.example.assistant", "9"), nil }
	facts, _ = Collect(env, mustCollection(t), nil)
	if len(find(facts, "sig.app")) != 2 {
		t.Fatalf("converted plist not matched: %+v", facts)
	}
}

type fakeRegistry struct {
	uninstall []UninstallEntry
	env       []EnvValue
	err       error
}

func (f fakeRegistry) Uninstall() ([]UninstallEntry, error) { return f.uninstall, f.err }
func (f fakeRegistry) Environment() ([]EnvValue, error)     { return f.env, f.err }

func TestWindowsRegistry(t *testing.T) {
	reg := fakeRegistry{
		uninstall: []UninstallEntry{{View: "HKCU", Key: `Software\Microsoft\Windows\CurrentVersion\Uninstall\{1}`, DisplayName: "example assistant ", Version: "5.0"}, {View: "HKLM", Key: "x", DisplayName: "Other"}},
		env:       []EnvValue{{View: "HKCU", Name: "EXAMPLE_API_KEY", Value: fakeKey()}, {View: "HKCU", Name: "PATH", Value: "C:/x"}},
	}
	home := fstest.MapFS{}
	env := &Env{OS: "windows", Registry: reg, Roots: map[contract.Root]fs.FS{contract.RootHome: home}, PathExt: []string{".exe", ".cmd"},
		PathDirs: []PathDir{{Root: contract.RootPath, Path: "C:/Tools", FS: fstest.MapFS{"example-cli.cmd": {Data: []byte("@echo")}}}}}
	facts, _ := Collect(env, mustCollection(t), nil)
	app := find(facts, "sig.app")
	if len(app) != 1 || app[0].Location.Root != contract.RootRegistry || app[0].Version != "5.0" || !strings.HasPrefix(app[0].Location.Path, `HKCU\`) {
		t.Errorf("uninstall: %+v", app)
	}
	en := find(facts, "sig.env")
	if len(en) != 1 || en[0].Location.Path != `HKCU\Environment` || en[0].Keys[0].RuleID == "" {
		t.Errorf("registry env: %+v", en)
	}
	cli := find(facts, "sig.cli")
	if len(cli) != 1 || cli[0].Location.Path != "C:/Tools/example-cli.cmd" {
		t.Errorf("windows cli: %+v", cli)
	}
	env.Registry = fakeRegistry{err: errors.New("denied")}
	_, gaps := Collect(env, mustCollection(t), nil)
	if !hasGap(gaps, contract.KindDesktopApp, GapNoRegistry) {
		t.Errorf("registry failure not a gap: %+v", gaps)
	}
}

func TestDisabledKindsAndMissingTables(t *testing.T) {
	env := linuxEnv()
	env.Processes = nil
	facts, gaps := Collect(env, mustCollection(t), map[contract.Kind]string{contract.KindEnvName: GapDisabledByOrgPolicy})
	if len(find(facts, "sig.env")) != 0 || !hasGap(gaps, contract.KindEnvName, GapDisabledByOrgPolicy) {
		t.Errorf("disabled kind still collected: %+v %+v", facts, gaps)
	}
	if len(find(facts, "sig.runtime")) != 0 || !hasGap(gaps, contract.KindLocalRuntime, GapNoProcessTable) {
		t.Errorf("missing process table not a gap: %+v", gaps)
	}
}

// A file over the cap is not read at all, and says so.
func TestBoundedReads(t *testing.T) {
	env := linuxEnv()
	home := linuxHome()
	home[".config/example/big.json"] = &fstest.MapFile{Data: []byte(`{"EXAMPLE_API_KEY":"` + fakeKey() + `","pad":"` + strings.Repeat("x", 300<<10) + `"}`)}
	env.Roots[contract.RootHome] = home
	facts, gaps := Collect(env, mustCollection(t), nil)
	for _, f := range find(facts, "sig.config") {
		if f.Location.Path == ".config/example/big.json" {
			t.Errorf("oversized file read: %+v", f)
		}
	}
	if !hasGap(gaps, contract.KindAssistantConfig, GapTooLarge) {
		t.Errorf("no gap for the oversized file: %+v", gaps)
	}
}

// A file that is not regular (a named pipe here) is never read, even when its name matches a locator.
func TestIrregularFileIsNotRead(t *testing.T) {
	env := linuxEnv()
	home := linuxHome()
	home[".config/example/pipe.json"] = &fstest.MapFile{Data: []byte(`{"EXAMPLE_API_KEY":"` + fakeKey() + `"}`), Mode: fs.ModeNamedPipe}
	env.Roots[contract.RootHome] = home
	facts, _ := Collect(env, mustCollection(t), nil)
	for _, f := range find(facts, "sig.config") {
		if f.Location.Path == ".config/example/pipe.json" {
			t.Errorf("a named pipe was read: %+v", f)
		}
	}
}

// A version field holding free text is dropped, never reported.
func TestCleanVersion(t *testing.T) {
	for in, want := range map[string]string{
		"1.2.3":                             "1.2.3",
		" 4.5.6_0 ":                         "4.5.6_0",
		"2026.1+build-7":                    "2026.1+build-7",
		"1.0 by Alice Smith":                "",
		"1.0; rm -rf ~":                     "",
		"/home/alice/1.0":                   "",
		"":                                  "",
		strings.Repeat("1", 65):             "",
		"1.0\nsecond line":                  "",
		"version " + strings.Repeat("x", 3): "",
	} {
		if got := cleanVersion(in); got != want {
			t.Errorf("cleanVersion(%q) = %q, want %q", in, got, want)
		}
	}
	// and through a collector: an extension whose package.json version is free text has no version
	env := linuxEnv()
	home := linuxHome()
	home[".example-editor/extensions/examplepub.example-helper-1.2.3/package.json"] = &fstest.MapFile{Data: []byte(`{"publisher":"ExamplePub","name":"example-helper","version":"1.2.3 alice.smith@corp"}`)}
	env.Roots[contract.RootHome] = home
	facts, _ := Collect(env, mustCollection(t), nil)
	ide := find(facts, "sig.ide")
	if len(ide) == 0 || ide[0].Version != "" {
		t.Errorf("free-text version reported: %+v", ide)
	}
}

// Unlisted key names leave the device only when env-style; a listed name is reported in the manifest's spelling.
func TestKeyNamesAreEnvStyleOrUnnamed(t *testing.T) {
	k := fakeKey()
	got := keysIn([]assignment{
		{name: "alice.smith", value: k},
		{name: "apiKey", value: k},
		{name: "Alice-Token", value: k},
		{name: "_HIDDEN", value: k},
		{name: "OPENAPI_TOKEN_2", value: k},
		{name: "example_api_key", value: "listed and non-empty"},
	}, []string{"EXAMPLE_API_KEY"})
	names := map[string]bool{}
	for _, kf := range got {
		names[kf.KeyName] = true
	}
	for _, want := range []string{"(unnamed)", "OPENAPI_TOKEN_2", "EXAMPLE_API_KEY"} {
		if !names[want] {
			t.Errorf("missing %q in %+v", want, got)
		}
	}
	for _, leaked := range []string{"alice.smith", "apiKey", "Alice-Token", "_HIDDEN", "example_api_key"} {
		if names[leaked] {
			t.Errorf("name %q left the device: %+v", leaked, got)
		}
	}
	if len(got) != 3 {
		t.Errorf("want 3 names, got %+v", got)
	}
}

func TestParseLine(t *testing.T) {
	cases := map[string]assignment{
		`export A_B="v"`:        {name: "A_B", value: "v"},
		`A: 'v'`:                {name: "A", value: "v"},
		`set -gx NAME some val`: {name: "NAME", value: "some val"},
		`$env:NAME = "v"`:       {name: "NAME", value: "v"},
		`free text line`:        {value: "free text line"},
	}
	for in, want := range cases {
		got, ok := parseLine(in)
		if !ok || got != want {
			t.Errorf("%q: got %+v", in, got)
		}
	}
	if _, ok := parseLine("# c"); ok {
		t.Error("comment parsed")
	}
}

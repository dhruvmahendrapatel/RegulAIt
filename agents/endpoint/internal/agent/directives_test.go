//go:build !windows

package agent

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/directive"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

// ADR-0331 end to end through the agent's cycle: a verified directive removes exactly one entry from a config the
// signed manifest locates, the developer is notified, the outcome is posted, and a replay changes nothing.

const removalConfig = `{"mcpServers": {"keep": {"command": "uvx", "args": ["keep-mcp"]}, "shadow": {"command": "npx", "args": ["@evil/shadow-mcp@2.1.0"]}}}`

type directiveFixture struct {
	*fixture
	home     string
	priv     ed25519.PrivateKey
	pub      ed25519.PublicKey
	keys     enforce.Keyring
	notices  []string
	identity string
}

func newDirectiveFixture(t *testing.T) *directiveFixture {
	f := newFixture(t, 5)
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config", "example"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "example", "mcp.json"), []byte(removalConfig), 0o600)
	col := fmt.Sprintf(`{"schema":"regulait.endpoint-collection/1","entries":[
 {"signatureId":"sig.mcp","kind":"mcp_config","provider":"example","files":[{"os":%q,"root":"home","path":".config/example/mcp.json"}]}]}`, runtime.GOOS)
	f.gw.Lock()
	f.gw.Config = contract.ConfigResponse{Pack: f.signer.Pack("1.0.0", []byte(col)), OrgPolicy: contract.OrgPolicy{IntervalSeconds: 60}}
	f.gw.Unlock()
	Redeem(context.Background(), f.opts)
	pub, priv, _ := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{5}, 64)))
	return &directiveFixture{fixture: f, home: home, priv: priv, pub: pub, keys: enforce.Keyring{"regulait-policy-test": pub}}
}

func (f *directiveFixture) run(t *testing.T) *Result {
	t.Helper()
	c := f.cycle()
	c.Env = func() (*collect.Env, error) { return collect.NewEnv(f.home) }
	c.Identity.HomeDir = f.home
	c.DirectiveKeyring = f.keys
	c.Notify = func(_ context.Context, text string) bool { f.notices = append(f.notices, text); return true }
	r, err := c.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("%v\n%s", err, f.logs)
	}
	if f.identity == "" {
		s, _ := loadState(f.opts)
		f.identity = s.IdentityID
	}
	return r
}

func (f *directiveFixture) serve(t *testing.T, d directive.Directive) {
	t.Helper()
	payload, _ := json.Marshal(d)
	env, _ := json.Marshal(enforce.Envelope{KeyID: "regulait-policy-test", Payload: base64.StdEncoding.EncodeToString(payload),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.priv, payload))})
	f.gw.Lock()
	f.gw.DirectiveSigner = true
	f.gw.Directives = append(f.gw.Directives, env)
	f.gw.Unlock()
}

func (f *directiveFixture) directive(id string) directive.Directive {
	return directive.Directive{Schema: directive.Schema, DirectiveID: id, RemovalID: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
		IdentityID: f.identity, IssuedAt: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour), Action: directive.ActionRemoveServer,
		Asset: directive.Asset{SignatureID: "sig.mcp", Root: contract.RootHome, Path: ".config/example/mcp.json", ServerName: "shadow",
			IdentityKind: "package", Identity: "@evil/shadow-mcp"}}
}

func (f *directiveFixture) config(t *testing.T) string {
	b, _ := os.ReadFile(filepath.Join(f.home, ".config", "example", "mcp.json"))
	return string(b)
}

func TestDirectivesOffUntilASignerExists(t *testing.T) {
	f := newDirectiveFixture(t)
	if r := f.run(t); r.Directives != nil {
		t.Fatalf("a cycle without a directive signer acted: %+v", r.Directives)
	}
	if f.config(t) != removalConfig {
		t.Fatal("the config changed")
	}
}

func TestDirectiveRemovesNotifiesReportsAndIsNotReplayed(t *testing.T) {
	f := newDirectiveFixture(t)
	f.run(t) // registers, so the identity id is known
	f.serve(t, f.directive("0f8e6a52-3c4b-4d1e-8f2a-6b7c9d0e1f2a"))
	r := f.run(t)
	if r.Directives == nil || len(r.Directives.Outcomes) != 1 || r.Directives.Outcomes[0].Outcome != contract.OutcomeRemoved || !r.Directives.Outcomes[0].Notified {
		t.Fatalf("outcomes: %+v\n%s", r.Directives, f.logs)
	}
	if got := f.config(t); strings.Contains(got, "shadow") || !strings.Contains(got, `"keep": {"command": "uvx", "args": ["keep-mcp"]}`) {
		t.Fatalf("config after removal: %s", got)
	}
	if len(f.notices) != 1 || !strings.Contains(f.notices[0], `"shadow"`) || !strings.Contains(f.notices[0], "example") {
		t.Fatalf("notices: %v", f.notices)
	}
	// the same directive again (a replay, or a lost answer): the recorded outcome is re-sent, nothing is done
	os.WriteFile(filepath.Join(f.home, ".config", "example", "mcp.json"), []byte(removalConfig), 0o600)
	r = f.run(t)
	if len(r.Directives.Outcomes) != 1 || r.Directives.Outcomes[0].Outcome != contract.OutcomeRemoved || f.config(t) != removalConfig || len(f.notices) != 1 {
		t.Fatalf("a replayed directive acted again: %+v", r.Directives)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Outcomes) != 2 || f.gw.Outcomes[0].DirectiveID != "0f8e6a52-3c4b-4d1e-8f2a-6b7c9d0e1f2a" {
		t.Fatalf("posted outcomes: %+v", f.gw.Outcomes)
	}
}

func TestDirectiveRefusals(t *testing.T) {
	f := newDirectiveFixture(t)
	f.run(t)
	other := f.directive("2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e")
	other.IdentityID = "6c1d8b4f-3a2e-4d9c-8b7f-1e5a4c3b2d0f"
	f.serve(t, other)
	// a directive signed by a key this build does not pin
	_, stranger, _ := ed25519.GenerateKey(bytes.NewReader(bytes.Repeat([]byte{6}, 64)))
	good := f.priv
	f.priv = stranger
	f.serve(t, f.directive("3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f"))
	f.priv = good
	r := f.run(t)
	if r.Directives.Refused != 1 || len(r.Directives.Outcomes) != 1 || r.Directives.Outcomes[0].Code != "wrong_identity" {
		t.Fatalf("refusals: %+v", r.Directives)
	}
	if f.config(t) != removalConfig || len(f.notices) != 0 {
		t.Fatal("a refused directive changed the config")
	}
	// a damaged ledger is never silently replaced (that would re-open replay)
	os.WriteFile(filepath.Join(f.opts.Paths.StateDir, ledgerFile), []byte("{"), 0o600)
	if r := f.run(t); r.Directives != nil {
		t.Fatal("directives were processed with a damaged ledger")
	}
}

// Owner decision B4 (ADR-0330 §8): a directive signed only by a device-policy key the admin pinned in the root-owned
// agent config verifies, with no compiled key; without the pin the same directive is refused and nothing changes.
func TestDirectiveVerifiesUnderAPinnedDevicePolicyKey(t *testing.T) {
	f := newDirectiveFixture(t)
	f.keys = enforce.Keyring{} // the compiled keyring is empty until SD4
	f.run(t)
	f.serve(t, f.directive("2c4e6a8b-1d3f-4a5c-9e7b-0f2a4c6e8a1b"))
	if r := f.run(t); r.Directives != nil && len(r.Directives.Outcomes) != 0 || f.config(t) != removalConfig {
		t.Fatalf("an unpinned directive was acted on: %+v", r.Directives)
	}
	raw, err := os.ReadFile(f.opts.Paths.ConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	cfg["devicePolicyKeys"] = []map[string]string{{"keyId": "regulait-policy-test", "x": base64.RawURLEncoding.EncodeToString(f.pub)}}
	out, _ := json.Marshal(cfg)
	if err := os.WriteFile(f.opts.Paths.ConfigFile, out, 0o644); err != nil {
		t.Fatal(err)
	}
	r := f.run(t)
	if r.Directives == nil || len(r.Directives.Outcomes) != 1 || r.Directives.Outcomes[0].Outcome != contract.OutcomeRemoved {
		t.Fatalf("a pinned-key directive was not applied: %+v\n%s", r.Directives, f.logs)
	}
	if strings.Contains(f.config(t), "shadow") {
		t.Fatal("the server entry is still there")
	}
}

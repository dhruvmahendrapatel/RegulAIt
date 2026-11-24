package update

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

type signer struct {
	id  string
	pub ed25519.PublicKey
	key ed25519.PrivateKey
}

func newSigner(t *testing.T, id string) signer {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{id, pub, key}
}

func (s signer) keyring() enforce.Keyring { return enforce.Keyring{s.id: s.pub} }

// envelope signs the bare payload (a release manifest).
func (s signer) envelope(t *testing.T, payload any) []byte {
	t.Helper()
	return s.envelopeIn(t, nil, payload)
}

// directiveEnvelope signs an update directive the way the gateway does: over its domain, then the payload.
func (s signer) directiveEnvelope(t *testing.T, payload any) []byte {
	t.Helper()
	return s.envelopeIn(t, DirectiveSignatureDomain, payload)
}

func (s signer) envelopeIn(t *testing.T, domain []byte, payload any) []byte {
	t.Helper()
	p, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	signed := append(append([]byte{}, domain...), p...)
	env, _ := json.Marshal(enforce.Envelope{KeyID: s.id, Payload: base64.StdEncoding.EncodeToString(p), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(s.key, signed))})
	return env
}

const device = "0b5e2c1a-7f00-4a3e-9c61-2d8f0e4b9a10"
const rollout = "9a6c1f2e-3b4d-4e5f-8a7b-1c2d3e4f5a6b"

var now = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

func directive(over func(*Directive)) Directive {
	d := Directive{Schema: SchemaDirective, DeviceID: device, RolloutID: rollout, TargetVersion: "1.2.0", IssuedAt: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	if over != nil {
		over(&d)
	}
	return d
}

func TestVerifyDirective(t *testing.T) {
	policy := newSigner(t, "device-policy-aaaaaaaaaaaaaaaaaaaaaaaa")
	other := newSigner(t, "device-policy-bbbbbbbbbbbbbbbbbbbbbbbb")
	if d, err := VerifyDirective(policy.directiveEnvelope(t, directive(nil)), policy.keyring(), device, now); err != nil || d.TargetVersion != "1.2.0" {
		t.Fatalf("a valid directive: %v %+v", err, d)
	}
	cases := map[string]struct {
		raw  []byte
		code string
	}{
		"another signer":     {other.directiveEnvelope(t, directive(nil)), CodeDirectiveInvalid},
		"another device":     {policy.directiveEnvelope(t, directive(func(d *Directive) { d.DeviceID = rollout })), CodeWrongDevice},
		"expired":            {policy.directiveEnvelope(t, directive(func(d *Directive) { d.NotAfter = now })), CodeDirectiveStale},
		"from the future":    {policy.directiveEnvelope(t, directive(func(d *Directive) { d.IssuedAt = now.Add(10 * time.Minute); d.NotAfter = now.Add(time.Hour) })), CodeDirectiveStale},
		"lives too long":     {policy.directiveEnvelope(t, directive(func(d *Directive) { d.IssuedAt = now.Add(-time.Hour); d.NotAfter = now.Add(24 * time.Hour) })), CodeDirectiveInvalid},
		"bad version":        {policy.directiveEnvelope(t, directive(func(d *Directive) { d.TargetVersion = "v1.2" })), CodeDirectiveInvalid},
		"another schema":     {policy.directiveEnvelope(t, directive(func(d *Directive) { d.Schema = SchemaManifest })), CodeDirectiveInvalid},
		"unknown member":     {policy.directiveEnvelope(t, map[string]any{"schema": SchemaDirective, "deviceId": device, "rolloutId": rollout, "targetVersion": "1.2.0", "issuedAt": now, "notAfter": now.Add(time.Hour), "force": true}), CodeDirectiveInvalid},
		"not an envelope":    {[]byte(`{"targetVersion":"9.9.9"}`), CodeDirectiveInvalid},
		"tampered payload":   {bytes.Replace(policy.directiveEnvelope(t, directive(nil)), []byte(`"payload":"`), []byte(`"payload":"A`), 1), CodeDirectiveInvalid},
		"oversized document": {bytes.Repeat([]byte(" "), MaxDirectiveBytes+1), CodeDirectiveInvalid},
		// #1033: the device-policy key also signs policies (bare payload) and removal directives (their own domain);
		// neither signature may count as an update directive's
		"signed over the bare payload":        {policy.envelope(t, directive(nil)), CodeDirectiveInvalid},
		"signed as a removal directive":       {policy.envelopeIn(t, []byte("regulait.endpoint-directive/1\x00"), directive(nil)), CodeDirectiveInvalid},
		"signed over the domain only, no NUL": {policy.envelopeIn(t, []byte(SchemaDirective), directive(nil)), CodeDirectiveInvalid},
	}
	for name, c := range cases {
		if _, err := VerifyDirective(c.raw, policy.keyring(), device, now); CodeOf(err) != c.code {
			t.Errorf("%s: %v, want %s", name, err, c.code)
		}
	}
}

func manifest(version string, targets ...Target) Manifest {
	return Manifest{Schema: SchemaManifest, Version: version, IssuedAt: now, Targets: targets}
}

func TestVerifyManifest(t *testing.T) {
	release := newSigner(t, "release-aaaaaaaaaaaaaaaaaaaaaaaa")
	policy := newSigner(t, "device-policy-aaaaaaaaaaaaaaaaaaaaaaaa")
	sum := strings.Repeat("a", 64)
	linux := Target{OS: "linux", Arch: "amd64", SHA256: sum, Length: 10}
	mac := Target{OS: "darwin", Arch: "arm64", SHA256: sum, Length: 10}
	if tg, err := VerifyManifest(release.envelope(t, manifest("1.2.0", mac, linux)), release.keyring(), "1.2.0", "linux", "amd64"); err != nil || *tg != linux {
		t.Fatalf("a valid manifest: %v %+v", err, tg)
	}
	cases := map[string]struct {
		raw  []byte
		code string
	}{
		// one key per purpose: a document the device-policy signer signed is no release
		"signed by the device-policy key": {policy.envelope(t, manifest("1.2.0", linux)), CodeManifestInvalid},
		"another version":                 {release.envelope(t, manifest("1.3.0", linux)), CodeVersionMismatch},
		"no binary for this platform":     {release.envelope(t, manifest("1.2.0", mac)), CodeNoTarget},
		"a platform twice":                {release.envelope(t, manifest("1.2.0", linux, linux)), CodeManifestInvalid},
		"a malformed digest":              {release.envelope(t, manifest("1.2.0", Target{OS: "linux", Arch: "amd64", SHA256: "abc", Length: 10})), CodeManifestInvalid},
		"too large a binary":              {release.envelope(t, manifest("1.2.0", Target{OS: "linux", Arch: "amd64", SHA256: sum, Length: MaxBinaryBytes + 1})), CodeManifestInvalid},
	}
	for name, c := range cases {
		if _, err := VerifyManifest(c.raw, release.keyring(), "1.2.0", "linux", "amd64"); CodeOf(err) != c.code {
			t.Errorf("%s: %v, want %s", name, err, c.code)
		}
	}
}

func TestNewerRefusesADowngrade(t *testing.T) {
	for _, c := range []struct {
		cand, cur string
		want      bool
	}{
		{"1.2.0", "1.1.9", true},
		{"1.10.0", "1.9.0", true},
		{"1.2.0", "1.2.0", false},
		{"1.1.0", "1.2.0", false},
		{"1.2.0", "1.2.0-rc.1", true},
		{"1.2.0-rc.1", "1.2.0", false},
		// a development build is never updated, and a malformed version is never newer
		{"1.2.0", "0.0.0-dev", true},
		{"1.2.0", "dev", false},
		{"v1.2.0", "1.0.0", false},
	} {
		if got := Newer(c.cand, c.cur); got != c.want {
			t.Errorf("Newer(%s, %s) = %v", c.cand, c.cur, got)
		}
	}
}

func target(b []byte) *Target {
	h := sha256.Sum256(b)
	return &Target{OS: "linux", Arch: "amd64", SHA256: hex.EncodeToString(h[:]), Length: int64(len(b))}
}

func TestStageChecksTheCopy(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, ".bin.next")
	bin := []byte("#!/bin/sh\necho hi\n")
	if err := Stage(bytes.NewReader(bin), dst, target(bin)); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(dst); err != nil || (runtime.GOOS != "windows" && st.Mode().Perm() != 0o755) {
		t.Fatalf("staged mode: %v %v", st, err)
	}
	for name, src := range map[string][]byte{"another binary": []byte("#!/bin/sh\necho no\n"), "a longer one": append(bin, 'x'), "a shorter one": bin[:5]} {
		if err := Stage(bytes.NewReader(src), dst, target(bin)); CodeOf(err) != CodeBinaryMismatch {
			t.Errorf("%s: %v", name, err)
		}
		if _, err := os.Stat(dst); !os.IsNotExist(err) {
			t.Errorf("%s: a refused binary was left staged", name)
		}
	}
}

func TestSwapKeepsThePreviousBinaryAndRollsBack(t *testing.T) {
	dir := t.TempDir()
	installed := filepath.Join(dir, "regulait-agent")
	os.WriteFile(installed, []byte("old"), 0o755)
	staged := StagedPath(installed)
	os.WriteFile(staged, []byte("new"), 0o755)
	if err := Swap(installed, staged); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(installed); string(b) != "new" {
		t.Fatalf("installed: %s", b)
	}
	if b, _ := os.ReadFile(PreviousPath(installed)); string(b) != "old" {
		t.Fatalf("previous: %s", b)
	}
	if err := Rollback(installed); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(installed); string(b) != "old" {
		t.Fatalf("after rollback: %s", b)
	}
	// a missing staged file leaves the installed binary in place
	if err := Swap(installed, filepath.Join(dir, "missing")); CodeOf(err) != CodeInstallFailed {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(installed); string(b) != "old" {
		t.Fatalf("after a failed swap: %s", b)
	}
}

//go:build !windows

package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/update"
)

type edKey struct {
	id  string
	key ed25519.PrivateKey
}

func newEdKey(t *testing.T, id string) edKey {
	t.Helper()
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return edKey{id, k}
}

func (k edKey) pin() enforce.PinnedKey {
	return enforce.PinnedKey{KeyID: k.id, X: base64.RawURLEncoding.EncodeToString(k.key.Public().(ed25519.PublicKey))}
}

func (k edKey) sign(t *testing.T, payload any) []byte {
	t.Helper()
	p, _ := json.Marshal(payload)
	b, _ := json.Marshal(enforce.Envelope{KeyID: k.id, Payload: base64.StdEncoding.EncodeToString(p), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(k.key, p))})
	return b
}

// fakeBinary is a shell script that answers `health` as version v; healthyOnlyStaged answers healthy only while it is
// the staged copy (its own name ends in .next), so the post-install check fails.
func fakeBinary(v string, healthyOnlyStaged bool) []byte {
	ok := `printf '{"schema":"regulait.endpoint-health/1","version":"%s","ok":true}\n'`
	if healthyOnlyStaged {
		return []byte(fmt.Sprintf("#!/bin/sh\ncase \"$0\" in *.next) %s ;; *) exit 1 ;; esac\n", fmt.Sprintf(ok, v)))
	}
	return []byte(fmt.Sprintf("#!/bin/sh\n%s\n", fmt.Sprintf(ok, v)))
}

type updateFixture struct {
	*fixture
	policy, release edKey
	installed       string
	deviceID        string
}

func newUpdateFixture(t *testing.T) *updateFixture {
	t.Helper()
	f := newFixture(t, 2)
	if st := Redeem(context.Background(), f.opts); st.Outcome != OutcomeRedeemed {
		t.Fatalf("%+v", st)
	}
	u := &updateFixture{fixture: f, policy: newEdKey(t, "device-policy-aaaaaaaaaaaaaaaaaaaaaaaa"), release: newEdKey(t, "release-aaaaaaaaaaaaaaaaaaaaaaaa")}
	raw, _ := os.ReadFile(f.opts.Paths.TicketFile)
	var tf TicketFile
	_ = json.Unmarshal(raw, &tf)
	u.deviceID = tf.TicketID
	u.writeConfig(true, true)
	os.MkdirAll(f.opts.Paths.SpoolDir, 0o755)
	bin := filepath.Join(f.dir, "bin")
	os.MkdirAll(bin, 0o755)
	u.installed = filepath.Join(bin, "regulait-agent")
	os.WriteFile(u.installed, fakeBinary("1.0.0", false), 0o755)
	prev := Version
	Version = "1.0.0"
	t.Cleanup(func() { Version = prev })
	return u
}

func (u *updateFixture) writeConfig(policyKeys, releaseKeys bool) {
	var lc map[string]any
	raw, _ := os.ReadFile(u.opts.Paths.ConfigFile)
	_ = json.Unmarshal(raw, &lc)
	delete(lc, "devicePolicyKeys")
	delete(lc, "releaseKeys")
	if policyKeys {
		lc["devicePolicyKeys"] = []enforce.PinnedKey{u.policy.pin()}
	}
	if releaseKeys {
		lc["releaseKeys"] = []enforce.PinnedKey{u.release.pin()}
	}
	b, _ := json.Marshal(lc)
	os.WriteFile(u.opts.Paths.ConfigFile, b, 0o644)
}

func (u *updateFixture) spool(t *testing.T, version string, bin []byte, signedBin []byte) {
	t.Helper()
	now := time.Now().UTC()
	d := update.Directive{Schema: update.SchemaDirective, DeviceID: u.deviceID, RolloutID: "9a6c1f2e-3b4d-4e5f-8a7b-1c2d3e4f5a6b", TargetVersion: version, IssuedAt: now.Add(-time.Minute), NotAfter: now.Add(time.Hour)}
	h := sha256.Sum256(signedBin)
	m := update.Manifest{Schema: update.SchemaManifest, Version: version, IssuedAt: now, Targets: []update.Target{{OS: runtime.GOOS, Arch: runtime.GOARCH, SHA256: hex.EncodeToString(h[:]), Length: int64(len(signedBin))}}}
	sp := u.opts.Paths.SpoolDir
	os.WriteFile(filepath.Join(sp, SpoolDirective), u.policy.sign(t, d), 0o644)
	os.WriteFile(filepath.Join(sp, SpoolManifest), u.release.sign(t, m), 0o644)
	os.WriteFile(filepath.Join(sp, SpoolBinary), bin, 0o644)
}

func (u *updateFixture) run(t *testing.T) UpdateResult {
	t.Helper()
	return SelfUpdate(context.Background(), u.opts, u.installed)
}

func (u *updateFixture) installedVersion(t *testing.T) string {
	t.Helper()
	b, _ := os.ReadFile(u.installed)
	for _, v := range []string{"1.0.0", "1.1.0", "0.9.0"} {
		if strings.Contains(string(b), `"version":"`+v+`"`) {
			return v
		}
	}
	return "?"
}

func TestSelfUpdateIsOffUntilBothKeyringsArePinned(t *testing.T) {
	u := newUpdateFixture(t)
	bin := fakeBinary("1.1.0", false)
	u.spool(t, "1.1.0", bin, bin)
	for _, c := range [][2]bool{{false, false}, {true, false}, {false, true}} {
		u.writeConfig(c[0], c[1])
		if r := u.run(t); r.Outcome != UpdateNotEnabled || r.Code != "keys_not_pinned" {
			t.Fatalf("%v: %+v", c, r)
		}
	}
	if u.installedVersion(t) != "1.0.0" {
		t.Fatal("installed without pinned keys")
	}
	// one key per purpose: the same key pinned for both is refused, so the config does not load
	lc := map[string]any{}
	raw, _ := os.ReadFile(u.opts.Paths.ConfigFile)
	_ = json.Unmarshal(raw, &lc)
	lc["devicePolicyKeys"] = []enforce.PinnedKey{u.policy.pin()}
	lc["releaseKeys"] = []enforce.PinnedKey{u.policy.pin()}
	b, _ := json.Marshal(lc)
	os.WriteFile(u.opts.Paths.ConfigFile, b, 0o644)
	if r := u.run(t); r.Outcome != UpdateNotEnabled || r.Code != "config_invalid" {
		t.Fatalf("shared key: %+v", r)
	}
}

func TestSelfUpdateInstallsASignedNewerRelease(t *testing.T) {
	u := newUpdateFixture(t)
	if r := u.run(t); r.Outcome != UpdateNothing {
		t.Fatalf("empty spool: %+v", r)
	}
	bin := fakeBinary("1.1.0", false)
	u.spool(t, "1.1.0", bin, bin)
	r := u.run(t)
	if r.Outcome != UpdateInstalled || r.FromVersion != "1.0.0" || r.ToVersion != "1.1.0" {
		t.Fatalf("%+v\n%s", r, u.logs)
	}
	if u.installedVersion(t) != "1.1.0" {
		t.Fatal("not installed")
	}
	if b, _ := os.ReadFile(update.PreviousPath(u.installed)); !strings.Contains(string(b), `"version":"1.0.0"`) {
		t.Fatal("the previous binary was not kept")
	}
	res, _ := os.ReadFile(filepath.Join(u.opts.Paths.SpoolDir, SpoolResult))
	if !strings.Contains(string(res), `"outcome": "installed"`) {
		t.Fatalf("result file: %s", res)
	}
}

func TestSelfUpdateRefusals(t *testing.T) {
	good := fakeBinary("1.1.0", false)
	for name, c := range map[string]struct {
		version     string
		bin, signed []byte
		prep        func(t *testing.T, u *updateFixture)
		outcome     string
		code        string
	}{
		"a downgrade":        {version: "0.9.0", bin: fakeBinary("0.9.0", false), signed: fakeBinary("0.9.0", false), outcome: UpdateRefused, code: update.CodeNotNewer},
		"the same version":   {version: "1.0.0", bin: fakeBinary("1.0.0", false), signed: fakeBinary("1.0.0", false), outcome: UpdateAlreadyAtTop},
		"a tampered binary":  {version: "1.1.0", bin: append([]byte{}, append(good, '#')...), signed: good, outcome: UpdateRefused, code: update.CodeBinaryMismatch},
		"a binary that lies": {version: "1.1.0", bin: fakeBinary("1.0.5", false), signed: fakeBinary("1.0.5", false), outcome: UpdateFailed, code: update.CodeStagedUnhealthy},
		"a link in the spool": {version: "1.1.0", bin: good, signed: good, prep: func(t *testing.T, u *updateFixture) {
			p := filepath.Join(u.opts.Paths.SpoolDir, SpoolBinary)
			os.Remove(p)
			os.Symlink(u.installed, p)
		}, outcome: UpdateRefused, code: update.CodeBinaryMismatch},
		"another device": {version: "1.1.0", bin: good, signed: good, prep: func(t *testing.T, u *updateFixture) {
			u.deviceID = "0b5e2c1a-7f00-4a3e-9c61-2d8f0e4b9a10"
			u.spool(t, "1.1.0", good, good)
		}, outcome: UpdateRefused, code: update.CodeWrongDevice},
		"an unsigned directive": {version: "1.1.0", bin: good, signed: good, prep: func(t *testing.T, u *updateFixture) {
			os.WriteFile(filepath.Join(u.opts.Paths.SpoolDir, SpoolDirective), []byte(`{"keyId":"x","payload":"","signature":""}`), 0o644)
		}, outcome: UpdateRefused, code: update.CodeDirectiveInvalid},
	} {
		t.Run(name, func(t *testing.T) {
			u := newUpdateFixture(t)
			u.spool(t, c.version, c.bin, c.signed)
			if c.prep != nil {
				c.prep(t, u)
			}
			r := u.run(t)
			if r.Outcome != c.outcome || r.Code != c.code {
				t.Fatalf("%+v, want %s %s\n%s", r, c.outcome, c.code, u.logs)
			}
			if u.installedVersion(t) != "1.0.0" {
				t.Fatal("the installed binary changed")
			}
			if _, err := os.Stat(update.StagedPath(u.installed)); !os.IsNotExist(err) {
				t.Fatal("a staged binary was left behind")
			}
		})
	}
}

func TestSelfUpdateRollsBackAnUnhealthyInstall(t *testing.T) {
	u := newUpdateFixture(t)
	bin := fakeBinary("1.1.0", true)
	u.spool(t, "1.1.0", bin, bin)
	r := u.run(t)
	if r.Outcome != UpdateRolledBack || r.Code != update.CodeInstalledHealth {
		t.Fatalf("%+v\n%s", r, u.logs)
	}
	if u.installedVersion(t) != "1.0.0" {
		t.Fatal("not rolled back")
	}
}

func TestEnrolReadsTheTokenFromStandardInput(t *testing.T) {
	token := "rgea_" + strings.Repeat("ab", 32)
	f := newFixtureToken(t, 1, token)
	os.Remove(f.opts.Paths.EnrolFile)
	for _, bad := range []string{"", "not-a-token\n", "rgea_short\n", "bulk-" + strings.Repeat("t", 24) + "\n"} {
		if st := Enrol(context.Background(), f.opts, strings.NewReader(bad)); st.Outcome != OutcomeTokenFileInvalid {
			t.Fatalf("%q: %+v", bad, st)
		}
	}
	st := Enrol(context.Background(), f.opts, strings.NewReader(token+"\n"))
	if st.Outcome != OutcomeRedeemed || st.TicketID == "" {
		t.Fatalf("%+v\n%s", st, f.logs)
	}
	status, _ := os.ReadFile(f.opts.Paths.StatusFile)
	if strings.Contains(string(status), token) || strings.Contains(f.logs.String(), token) {
		t.Fatal("the token reached the status file or the log")
	}
	if _, err := os.Stat(f.opts.Paths.EnrolFile); !os.IsNotExist(err) {
		t.Fatal("enrol wrote the token to disk")
	}
	// a device with a valid ticket keeps it, and the token is not spent again
	if st := Enrol(context.Background(), f.opts, strings.NewReader(token+"\n")); st.Outcome != OutcomeTicketValid {
		t.Fatalf("%+v", st)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if f.gw.Devices != 1 {
		t.Fatalf("devices: %d", f.gw.Devices)
	}
}

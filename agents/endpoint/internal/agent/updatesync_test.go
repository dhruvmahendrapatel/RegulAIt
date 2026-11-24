//go:build !windows

package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/update"
)

// ADR-0360 §4 (slice 1c): the per-user agent carries the offer into the spool and the root updater's result back.

const attemptID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

// offer serves an update to version with bin as the binary and returns the exact envelope bytes served.
func (u *updateFixture) offer(t *testing.T, version string, bin []byte) (directive, manifest []byte) {
	t.Helper()
	now := time.Now().UTC()
	d := update.Directive{Schema: update.SchemaDirective, DeviceID: u.deviceID, RolloutID: "9a6c1f2e-3b4d-4e5f-8a7b-1c2d3e4f5a6b", TargetVersion: version, IssuedAt: now.Add(-time.Minute), NotAfter: now.Add(time.Hour)}
	h := sha256.Sum256(bin)
	m := update.Manifest{Schema: update.SchemaManifest, Version: version, IssuedAt: now, Targets: []update.Target{{OS: runtime.GOOS, Arch: runtime.GOARCH, SHA256: hex.EncodeToString(h[:]), Length: int64(len(bin))}}}
	directive, manifest = u.policy.signDirective(t, d), u.release.sign(t, m)
	u.gw.Lock()
	u.gw.UpdateSigner = true
	u.gw.Update = &contract.UpdateOffer{AttemptID: attemptID, Directive: directive, Manifest: manifest,
		Binary: contract.UpdateBinary{Path: contract.RouteUpdateBinary, OS: runtime.GOOS, Arch: runtime.GOARCH, Length: int64(len(bin)), SHA256: hex.EncodeToString(h[:])}}
	u.gw.UpdateBinary = bin
	u.gw.Unlock()
	return directive, manifest
}

func (u *updateFixture) sync(t *testing.T) *UpdateRun {
	t.Helper()
	r, err := u.cycle().RunOnce(context.Background())
	if err != nil {
		t.Fatalf("%v\n%s", err, u.logs)
	}
	if r.Update == nil {
		t.Fatal("the update sync did not run")
	}
	return r.Update
}

func (u *updateFixture) spoolFile(name string) string {
	return filepath.Join(u.opts.Paths.SpoolDir, name)
}

func (u *updateFixture) requests(path string) int {
	u.gw.Lock()
	defer u.gw.Unlock()
	n := 0
	for _, r := range u.gw.Requests {
		if r.Path == path {
			n++
		}
	}
	return n
}

func (u *updateFixture) writeResult(t *testing.T, r UpdateResult) []byte {
	t.Helper()
	b, _ := json.Marshal(r)
	if err := os.WriteFile(u.spoolFile(SpoolResult), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return b
}

func sampleResult() UpdateResult {
	return UpdateResult{Schema: update.SchemaResult, Outcome: UpdateInstalled, RolloutID: "9a6c1f2e-3b4d-4e5f-8a7b-1c2d3e4f5a6b", FromVersion: "1.0.0", ToVersion: "1.1.0", At: "2026-11-24T10:00:00Z"}
}

// spoolNames lists the spool, temporary files included.
func (u *updateFixture) spoolNames(t *testing.T) []string {
	t.Helper()
	es, _ := os.ReadDir(u.opts.Paths.SpoolDir)
	var n []string
	for _, e := range es {
		n = append(n, e.Name())
	}
	return n
}

func TestUpdateSyncIsOffUntilBothKeyringsArePinned(t *testing.T) {
	u := newUpdateFixture(t)
	u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
	for _, keys := range [][2]bool{{false, false}, {true, false}, {false, true}} {
		u.writeConfig(keys[0], keys[1])
		if run := u.sync(t); run.Offer != UpdateSyncNotConfigured {
			t.Fatalf("%v: %+v", keys, run)
		}
	}
	if u.requests(contract.RouteUpdate) != 0 || len(u.spoolNames(t)) != 0 {
		t.Fatal("an unpinned agent fetched or wrote an update")
	}
}

func TestUpdateSyncSpoolsTheOfferAndReportsTheResult(t *testing.T) {
	u := newUpdateFixture(t)
	bin := fakeBinary("1.1.0", false)
	directive, manifest := u.offer(t, "1.1.0", bin)
	// an earlier attempt's directive is in the spool: it must be gone before a new binary lands
	os.WriteFile(u.spoolFile(SpoolDirective), []byte(`{"old":true}`), 0o644)
	var midSync []string
	u.gw.Lock()
	u.gw.OnUpdateBinary = func() { midSync = u.spoolNames(t) }
	u.gw.Unlock()

	run := u.sync(t)
	if run.Offer != UpdateSyncSpooled || run.AttemptID != attemptID || !run.Downloaded || run.Result != UpdateResultNone {
		t.Fatalf("%+v\n%s", run, u.logs)
	}
	if len(midSync) != 0 {
		t.Fatalf("the spool held %v while the binary downloaded (the directive is written last)", midSync)
	}
	for name, want := range map[string][]byte{SpoolDirective: directive, SpoolManifest: manifest, SpoolBinary: bin} {
		got, err := os.ReadFile(u.spoolFile(name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: %v\n%s", name, err, got)
		}
		if fi, _ := os.Lstat(u.spoolFile(name)); fi.Mode().Perm() != 0o644 {
			t.Fatalf("%s mode %v", name, fi.Mode())
		}
	}
	if names := u.spoolNames(t); len(names) != 3 {
		t.Fatalf("spool: %v", names)
	}
	// the attempt id is in the agent's own state, never the spool
	if raw, err := os.ReadFile(filepath.Join(u.opts.Paths.StateDir, updateAttemptFile)); err != nil || !strings.Contains(string(raw), attemptID) {
		t.Fatalf("attempt state: %v %s", err, raw)
	}

	// what the agent spooled is what the root updater installs
	if res := u.run(t); res.Outcome != UpdateInstalled {
		t.Fatalf("%+v\n%s", res, u.logs)
	}
	u.gw.Lock()
	u.gw.Update = nil
	u.gw.Unlock()
	run = u.sync(t)
	if run.Result != UpdateResultReported || run.Offer != UpdateSyncNone {
		t.Fatalf("%+v\n%s", run, u.logs)
	}
	u.gw.Lock()
	got := u.gw.UpdateResults
	u.gw.Unlock()
	if len(got) != 1 || got[0].AttemptID != attemptID || got[0].Result.Outcome != UpdateInstalled || got[0].Result.ToVersion != "1.1.0" {
		t.Fatalf("%+v", got)
	}
	if _, err := os.Lstat(u.spoolFile(SpoolResult)); !os.IsNotExist(err) {
		t.Fatal("the reported result was not removed")
	}
	// the root updater consumed the directive; a null update removes nothing else
	if _, err := os.Lstat(u.spoolFile(SpoolDirective)); !os.IsNotExist(err) {
		t.Fatal("the root updater left the directive it consumed")
	}
	for _, n := range []string{SpoolManifest, SpoolBinary} {
		if _, err := os.Lstat(u.spoolFile(n)); err != nil {
			t.Fatalf("a null update removed %s", n)
		}
	}
	if strings.Contains(u.logs.String(), u.gw.Issuer) || strings.Contains(u.logs.String(), "127.0.0.1") {
		t.Fatalf("a host name was logged:\n%s", u.logs)
	}
}

func TestUpdateSyncSkipsABinaryItAlreadyHas(t *testing.T) {
	u := newUpdateFixture(t)
	bin := fakeBinary("1.1.0", false)
	u.offer(t, "1.1.0", bin)
	os.WriteFile(u.spoolFile(SpoolBinary), bin, 0o644)
	if run := u.sync(t); run.Offer != UpdateSyncSpooled || run.Downloaded {
		t.Fatalf("%+v", run)
	}
	if u.requests(contract.RouteUpdateBinary) != 0 {
		t.Fatal("the binary was downloaded again")
	}
}

func TestUpdateSyncWritesNothingForABadBinaryOrOffer(t *testing.T) {
	good := fakeBinary("1.1.0", false)
	for name, c := range map[string]struct {
		prep func(u *updateFixture)
		code string
	}{
		"a mismatched sha256":             {func(u *updateFixture) { u.gw.UpdateBinary = append([]byte{}, fakeBinary("1.1.1", false)...) }, UpdateSyncBinaryMismatch},
		"a longer binary":                 {func(u *updateFixture) { u.gw.UpdateBinary = append(append([]byte{}, good...), '#') }, UpdateSyncBinaryMismatch},
		"a shorter binary":                {func(u *updateFixture) { u.gw.UpdateBinary = good[:len(good)-1] }, UpdateSyncBinaryMismatch},
		"not octet-stream":                {func(u *updateFixture) { u.gw.UpdateBinaryType = "text/html" }, UpdateSyncBinaryFailed},
		"another platform":                {func(u *updateFixture) { u.gw.Update.Binary.Arch = "sparc" }, UpdateSyncOfferMalformed},
		"another path":                    {func(u *updateFixture) { u.gw.Update.Binary.Path = "/v1/endpoint-agent/config" }, UpdateSyncOfferMalformed},
		"a bad attempt id":                {func(u *updateFixture) { u.gw.Update.AttemptID = "../../x" }, UpdateSyncOfferMalformed},
		"too large":                       {func(u *updateFixture) { u.gw.Update.Binary.Length = update.MaxBinaryBytes + 1 }, UpdateSyncOfferMalformed},
		"an empty binary":                 {func(u *updateFixture) { u.gw.Update.Binary.Length = 0 }, UpdateSyncOfferMalformed},
		"upper-case hex":                  {func(u *updateFixture) { u.gw.Update.Binary.SHA256 = strings.ToUpper(u.gw.Update.Binary.SHA256) }, UpdateSyncOfferMalformed},
		"a directive that is no envelope": {func(u *updateFixture) { u.gw.Update.Directive = json.RawMessage(`{"targetVersion":"9.9.9"}`) }, UpdateSyncOfferMalformed},
		"a null manifest":                 {func(u *updateFixture) { u.gw.Update.Manifest = json.RawMessage(`null`) }, UpdateSyncOfferMalformed},
	} {
		t.Run(name, func(t *testing.T) {
			u := newUpdateFixture(t)
			u.offer(t, "1.1.0", good)
			u.gw.Lock()
			c.prep(u)
			u.gw.Unlock()
			if run := u.sync(t); run.Offer != c.code {
				t.Fatalf("%+v, want %s\n%s", run, c.code, u.logs)
			}
			if names := u.spoolNames(t); len(names) != 0 {
				t.Fatalf("written: %v", names)
			}
			if _, err := os.Lstat(filepath.Join(u.opts.Paths.StateDir, updateAttemptFile)); !os.IsNotExist(err) {
				t.Fatal("the attempt was recorded")
			}
		})
	}
}

func TestUpdateSyncLeavesTheSpoolAloneWithoutAnOffer(t *testing.T) {
	for name, prep := range map[string]func(u *updateFixture){
		"a null update":        func(u *updateFixture) { u.gw.UpdateSigner, u.gw.Update = true, nil },
		"no signer (503)":      func(u *updateFixture) { u.gw.UpdateSigner = false },
		"a malformed response": func(u *updateFixture) { u.gw.UpdateSigner, u.gw.Update = true, &contract.UpdateOffer{} },
	} {
		t.Run(name, func(t *testing.T) {
			u := newUpdateFixture(t)
			u.spool(t, "1.1.0", fakeBinary("1.1.0", false), fakeBinary("1.1.0", false))
			before := map[string][]byte{}
			for _, n := range []string{SpoolDirective, SpoolManifest, SpoolBinary} {
				before[n], _ = os.ReadFile(u.spoolFile(n))
			}
			u.gw.Lock()
			prep(u)
			u.gw.Unlock()
			run := u.sync(t)
			if run.Offer == UpdateSyncSpooled {
				t.Fatalf("%+v", run)
			}
			for n, b := range before {
				if got, err := os.ReadFile(u.spoolFile(n)); err != nil || !bytes.Equal(got, b) {
					t.Fatalf("%s changed", n)
				}
			}
		})
	}
	u := newUpdateFixture(t)
	if run := u.sync(t); run.Offer != UpdateSyncSignerUnavailable {
		t.Fatalf("%+v", run)
	}
}

func TestUpdateSyncResultReporting(t *testing.T) {
	for name, c := range map[string]struct {
		status  int
		code    string
		result  string
		removed bool
		halts   bool
	}{
		"recorded":         {0, "", UpdateResultReported, true, false},
		"recorded, halted": {0, "", UpdateResultReported, true, true},
		"already reported": {409, contract.ErrAlreadyReported, UpdateResultReported, true, false},
		"a server error":   {500, "internal", UpdateResultKept, false, false},
		"forbidden":        {403, "device_revoked", UpdateResultKept, false, false},
		"rate limited":     {429, "rate_limited", UpdateResultKept, false, false},
		// a 4xx a resend cannot change finishes the result, so later syncs are never stuck on result_pending
		"a version mismatch": {400, "version_mismatch", UpdateResultDropped, true, false},
		"an unknown attempt": {404, "attempt_not_found", UpdateResultDropped, true, false},
		"another conflict":   {409, "attempt_closed", UpdateResultDropped, true, false},
	} {
		t.Run(name, func(t *testing.T) {
			u := newUpdateFixture(t)
			u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
			if run := u.sync(t); run.Offer != UpdateSyncSpooled {
				t.Fatalf("%+v\n%s", run, u.logs)
			}
			u.writeResult(t, sampleResult())
			u.gw.Lock()
			u.gw.UpdateResultStatus, u.gw.UpdateResultCode, u.gw.UpdateResultHalts = c.status, c.code, c.halts
			u.gw.Update.AttemptID = "7d6c5b4a-3928-4170-8a9b-cdef01234567"
			u.gw.Unlock()
			offers := u.requests(contract.RouteUpdate)
			run := u.sync(t)
			if run.Result != c.result {
				t.Fatalf("%+v, want %s\n%s", run, c.result, u.logs)
			}
			_, err := os.Lstat(u.spoolFile(SpoolResult))
			if removed := os.IsNotExist(err); removed != c.removed {
				t.Fatalf("removed %v, want %v", removed, c.removed)
			}
			if c.removed {
				// the next offer is taken once the result is in
				if run.Offer != UpdateSyncSpooled || run.AttemptID != "7d6c5b4a-3928-4170-8a9b-cdef01234567" {
					t.Fatalf("%+v", run)
				}
				return
			}
			// a kept result holds the next offer back, so it is never reported against the wrong attempt
			if run.Offer != UpdateSyncResultPending || u.requests(contract.RouteUpdate) != offers {
				t.Fatalf("%+v", run)
			}
			u.gw.Lock()
			u.gw.UpdateResultStatus = 0
			u.gw.Unlock()
			if run := u.sync(t); run.Result != UpdateResultReported {
				t.Fatalf("%+v", run)
			}
			u.gw.Lock()
			defer u.gw.Unlock()
			if r := u.gw.UpdateResults; len(r) != 1 || r[0].AttemptID != attemptID {
				t.Fatalf("%+v", r)
			}
		})
	}
}

func TestUpdateSyncDoesNotResendAResultItCannotRemove(t *testing.T) {
	u := newUpdateFixture(t)
	u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
	u.sync(t)
	raw := u.writeResult(t, sampleResult())
	if run := u.sync(t); run.Result != UpdateResultReported {
		t.Fatalf("%+v\n%s", run, u.logs)
	}
	// as when the sticky spool keeps root's file from the agent: the same bytes are there again
	os.WriteFile(u.spoolFile(SpoolResult), raw, 0o644)
	if run := u.sync(t); run.Result != UpdateResultAlreadyReported {
		t.Fatalf("%+v", run)
	}
	u.gw.Lock()
	defer u.gw.Unlock()
	if len(u.gw.UpdateResults) != 1 {
		t.Fatalf("the same result was sent %d times", len(u.gw.UpdateResults))
	}
}

func TestUpdateSyncRefusesLinksAndForgeries(t *testing.T) {
	t.Run("a linked result file", func(t *testing.T) {
		u := newUpdateFixture(t)
		u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
		u.sync(t)
		outside := filepath.Join(u.dir, "outside.json")
		b, _ := json.Marshal(sampleResult())
		os.WriteFile(outside, b, 0o644)
		os.Symlink(outside, u.spoolFile(SpoolResult))
		if run := u.sync(t); run.Result != UpdateResultRefused {
			t.Fatalf("%+v", run)
		}
		u.gw.Lock()
		defer u.gw.Unlock()
		if len(u.gw.UpdateResults) != 0 {
			t.Fatal("a linked result was reported")
		}
	})
	t.Run("a result file another user wrote", func(t *testing.T) {
		if os.Getuid() != 0 {
			t.Skip("needs root to give the file another owner")
		}
		u := newUpdateFixture(t)
		u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
		u.sync(t)
		u.writeResult(t, sampleResult())
		os.Chown(u.spoolFile(SpoolResult), 65534, 65534)
		if run := u.sync(t); run.Result != UpdateResultRefused {
			t.Fatalf("%+v", run)
		}
	})
	t.Run("a malformed or oversized result file", func(t *testing.T) {
		for _, body := range [][]byte{[]byte(`{"schema":"regulait.endpoint-update-result/1","outcome":"installed","fromVersion":"1.0.0","at":"x","extra":1}`),
			[]byte(`{"schema":"regulait.endpoint-update-result/1","outcome":"pwned","fromVersion":"1.0.0","at":"x"}`),
			bytes.Repeat([]byte(" "), MaxResultBytes+1)} {
			u := newUpdateFixture(t)
			u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
			u.sync(t)
			os.WriteFile(u.spoolFile(SpoolResult), body, 0o644)
			if run := u.sync(t); run.Result != UpdateResultRefused || run.Offer != UpdateSyncSpooled {
				t.Fatalf("%+v", run)
			}
		}
	})
	t.Run("a linked binary is replaced, never followed", func(t *testing.T) {
		u := newUpdateFixture(t)
		bin := fakeBinary("1.1.0", false)
		u.offer(t, "1.1.0", bin)
		outside := filepath.Join(u.dir, "outside.bin")
		os.WriteFile(outside, []byte("keep"), 0o644)
		os.Symlink(outside, u.spoolFile(SpoolBinary))
		if run := u.sync(t); run.Offer != UpdateSyncSpooled || !run.Downloaded {
			t.Fatalf("%+v", run)
		}
		if b, _ := os.ReadFile(outside); string(b) != "keep" {
			t.Fatal("the link was followed")
		}
		if fi, _ := os.Lstat(u.spoolFile(SpoolBinary)); !fi.Mode().IsRegular() {
			t.Fatal("the spool binary is still a link")
		}
	})
	t.Run("a linked spool directory", func(t *testing.T) {
		u := newUpdateFixture(t)
		u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
		elsewhere := filepath.Join(u.dir, "elsewhere")
		os.MkdirAll(elsewhere, 0o755)
		os.Remove(u.opts.Paths.SpoolDir)
		os.Symlink(elsewhere, u.opts.Paths.SpoolDir)
		if run := u.sync(t); run.Offer != UpdateSyncSpoolUnavailable {
			t.Fatalf("%+v", run)
		}
		if es, _ := os.ReadDir(elsewhere); len(es) != 0 {
			t.Fatal("written through the link")
		}
	})
}

// The real gateway's config route answers 503 collection_pack_unavailable today: the report fails, and the update
// offer and the root updater's result still go through.
func TestUpdateSyncRunsWhenTheConfigRouteRefuses(t *testing.T) {
	u := newUpdateFixture(t)
	directive, _ := u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
	u.gw.Lock()
	u.gw.ConfigStatus, u.gw.ConfigCode = 503, "collection_pack_unavailable"
	u.gw.Unlock()
	r, err := u.cycle().RunOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "collection_pack_unavailable") {
		t.Fatalf("the report's error is not returned: %v", err)
	}
	if r == nil || r.Update == nil || r.Update.Offer != UpdateSyncSpooled || r.Update.AttemptID != attemptID {
		t.Fatalf("%+v\n%s", r, u.logs)
	}
	if got, err := os.ReadFile(u.spoolFile(SpoolDirective)); err != nil || !bytes.Equal(got, directive) {
		t.Fatalf("the directive was not spooled: %v", err)
	}
	// the root updater's result is reported on the next refused cycle
	if res := u.run(t); res.Outcome != UpdateInstalled {
		t.Fatalf("%+v\n%s", res, u.logs)
	}
	r, err = u.cycle().RunOnce(context.Background())
	if err == nil || r == nil || r.Update == nil || r.Update.Result != UpdateResultReported {
		t.Fatalf("%v %+v\n%s", err, r, u.logs)
	}
	u.gw.Lock()
	defer u.gw.Unlock()
	if len(u.gw.UpdateResults) != 1 || u.gw.UpdateResults[0].Result.Outcome != UpdateInstalled || len(u.gw.Reports) != 0 {
		t.Fatalf("results %+v, reports %d", u.gw.UpdateResults, len(u.gw.Reports))
	}
}

// A 400 version_mismatch finishes the result: it is removed and the same sync goes on to the next offer; the next sync
// has nothing waiting.
func TestUpdateSyncDropsAResultTheGatewayRefusesForGood(t *testing.T) {
	u := newUpdateFixture(t)
	u.offer(t, "1.1.0", fakeBinary("1.1.0", false))
	u.sync(t)
	u.writeResult(t, sampleResult())
	u.gw.Lock()
	u.gw.UpdateResultStatus, u.gw.UpdateResultCode = 400, "version_mismatch"
	u.gw.Update.AttemptID = "7d6c5b4a-3928-4170-8a9b-cdef01234567"
	u.gw.Unlock()
	offers := u.requests(contract.RouteUpdate)
	run := u.sync(t)
	if run.Result != UpdateResultDropped || run.Offer != UpdateSyncSpooled || u.requests(contract.RouteUpdate) != offers+1 {
		t.Fatalf("%+v\n%s", run, u.logs)
	}
	if _, err := os.Lstat(u.spoolFile(SpoolResult)); !os.IsNotExist(err) {
		t.Fatal("the refused result was kept")
	}
	if run := u.sync(t); run.Result != UpdateResultNone || run.Offer != UpdateSyncSpooled {
		t.Fatalf("%+v", run)
	}
	if !strings.Contains(u.logs.String(), "result_refused_by_gateway") {
		t.Fatalf("no fixed code logged:\n%s", u.logs)
	}
}

// When the sticky spool keeps root's result file from the agent, a finished result is acknowledged by its SHA-256.
func TestUpdateSyncAcknowledgesAResultItCannotRemove(t *testing.T) {
	u := newUpdateFixture(t)
	// a non-empty directory under the result's name cannot be removed, as root's file under the sticky bit cannot
	stuck := u.spoolFile(SpoolResult)
	os.MkdirAll(filepath.Join(stuck, "x"), 0o755)
	u.cycle().finishUpdateResult(stuck, strings.Repeat("ab", 32))
	if b, err := os.ReadFile(u.spoolFile(SpoolResultAck)); err != nil || string(b) != strings.Repeat("ab", 32)+"\n" {
		t.Fatalf("%v %q", err, b)
	}
	// a removable result takes its acknowledgement with it
	os.RemoveAll(stuck)
	os.WriteFile(stuck, []byte("{}"), 0o644)
	u.cycle().finishUpdateResult(stuck, strings.Repeat("ab", 32))
	if names := u.spoolNames(t); len(names) != 0 {
		t.Fatalf("spool: %v", names)
	}
}

func TestUpdateResultVersionsAreBoundedAt32Characters(t *testing.T) {
	r := sampleResult()
	r.ToVersion = "1.1.0-" + strings.Repeat("a", update.MaxVersionLength-6)
	if !validResult(&r) {
		t.Fatal("a 32-character version was refused")
	}
	r.ToVersion += "a"
	if validResult(&r) {
		t.Fatal("a 33-character version was accepted")
	}
}

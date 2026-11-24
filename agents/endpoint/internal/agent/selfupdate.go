package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/update"
)

// Spool file names (ADR-0360 §4). The per-user agent writes the first three and the acknowledgement; the root updater
// writes the result.
const (
	SpoolDirective = "directive.json"
	SpoolManifest  = "release.json"
	SpoolBinary    = "regulait-agent.bin"
	SpoolResult    = "result.json"
	// SpoolResultAck is the per-user agent's acknowledgement that the result is finished (reported, or one the gateway
	// will never take): the hex SHA-256 of the result file's bytes. The spool's sticky bit keeps the agent from removing
	// root's result file, so the root updater removes it once the acknowledgement names exactly those bytes.
	SpoolResultAck = "result.ack"
	maxAckBytes    = 128
)

// Update outcomes, written to the result file the per-user agent reports. None carries a secret.
const (
	UpdateNothing      = "nothing_to_do"
	UpdateNotEnabled   = "not_configured"
	UpdateInstalled    = "installed"
	UpdateRefused      = "refused"
	UpdateFailed       = "failed"
	UpdateRolledBack   = "rolled_back"
	UpdateAlreadyAtTop = "up_to_date"
	// UpdatePending: the previous result is not yet reported, so nothing is done and nothing is written (the first real
	// outcome of an attempt is the one the gateway sees, and its automatic halt counts).
	UpdatePending = "result_pending"
)

// writesResult reports whether an outcome is written to the result file (and consumes the directive).
func writesResult(outcome string) bool {
	return outcome != UpdateNothing && outcome != UpdateNotEnabled && outcome != UpdatePending
}

// UpdateResult is the root updater's outcome (the wire type, so the result file and the report are one shape).
type UpdateResult = contract.UpdateResult

// HealthReport is what `regulait-agent health` prints: the binary starts, reads its config and knows its version.
type HealthReport struct {
	Schema  string `json:"schema"`
	Version string `json:"version"`
	OK      bool   `json:"ok"`
}

// Health is the staged and installed binary's self-check. It contacts nothing.
func Health(o Options) HealthReport {
	o.defaults()
	_, err := LoadConfig(o.Paths.ConfigFile, o.SystemOwner)
	return HealthReport{Schema: update.SchemaHealth, Version: Version, OK: err == nil}
}

// readSpool reads one spool file: a regular file (not a link), at most max bytes. The spool is writable by local users,
// so what it returns is untrusted until verified.
func readSpool(path string, max int64) ([]byte, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	f, err := fsutil.OpenNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("too large")
	}
	return b, nil
}

// ticketDeviceID is the device id the ticket file names (an expired ticket still names its device).
func ticketDeviceID(o Options, cfg *Config) (string, error) {
	raw, err := readChecked(o.Paths.TicketFile, o.SystemOwner, fsutil.GroupRead)
	if err != nil {
		return "", err
	}
	var t TicketFile
	if err := fsutil.StrictJSON(raw, &t); err != nil || t.Schema != contract.SchemaTicketFile || t.Issuer != cfg.Issuer || t.TicketID == "" {
		return "", errors.New("the ticket file is malformed")
	}
	return t.TicketID, nil
}

// SelfUpdate is the root updater (ADR-0360 §4), run by the package's system timer: `regulait-agent update`.
// installed is the path of the binary to replace (the running executable in production).
//
// It installs only when the config pins both the device-policy keys and the release keys, the spool holds a
// directive the device-policy signer signed for this device and still valid, and a release manifest the release keys
// signed for exactly that version, which is newer than this binary. It stages the binary beside the installed one,
// checks the staged copy's length and SHA-256, runs its health check, swaps it in, runs the installed binary's health
// check and rolls back when that fails. Every outcome is logged with its code.
//
// Each directive is consumed exactly once: once read, it is removed from the spool whatever the outcome, and the
// outcome is written to the spool's result file. A result file is never overwritten while it is unreported: until the
// per-user agent has reported it (removed it, or acknowledged its exact bytes in SpoolResultAck), a run does nothing
// and returns UpdatePending, so hourly runs between the agent's syncs can neither re-install a rolled-back binary nor
// replace a failure with a later refusal.
func SelfUpdate(ctx context.Context, o Options, installed string) UpdateResult {
	o.defaults()
	res := UpdateResult{Schema: update.SchemaResult, FromVersion: Version}
	done := func(outcome, code string) UpdateResult {
		res.Outcome, res.Code, res.At = outcome, code, o.Now().UTC().Format(time.RFC3339)
		if writesResult(outcome) {
			if b, err := json.MarshalIndent(res, "", "  "); err == nil {
				if err := fsutil.WriteAtomic(filepath.Join(o.Paths.SpoolDir, SpoolResult), append(b, '\n'), 0o644, -1, true); err != nil {
					o.Log.Error("update: could not write the result file", "err", err)
				}
			}
		}
		o.Log.Info("update", "outcome", outcome, "code", code, "from", res.FromVersion, "to", res.ToVersion)
		return res
	}
	cfg, err := LoadConfig(o.Paths.ConfigFile, o.SystemOwner)
	if err != nil {
		o.Log.Warn("update", "err", err)
		return done(UpdateNotEnabled, "config_invalid")
	}
	if len(cfg.DevicePolicyKeys) == 0 || len(cfg.ReleaseKeys) == 0 {
		// secure by default: nothing is pinned, so no signature can count
		return done(UpdateNotEnabled, "keys_not_pinned")
	}
	if resultPending(o) {
		return done(UpdatePending, "")
	}
	directivePath := filepath.Join(o.Paths.SpoolDir, SpoolDirective)
	rawDirective, err := readSpool(directivePath, update.MaxDirectiveBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return done(UpdateNothing, "")
	}
	// consumed exactly once: whatever follows, this directive (or whatever sits under its name) is not read again
	if rerr := os.Remove(directivePath); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		o.Log.Error("update: could not consume the directive", "err", rerr)
	}
	if err != nil {
		return done(UpdateRefused, update.CodeDirectiveInvalid)
	}
	deviceID, err := ticketDeviceID(o, cfg)
	if err != nil {
		return done(UpdateRefused, update.CodeWrongDevice)
	}
	d, err := update.VerifyDirective(rawDirective, cfg.DevicePolicyKeys, deviceID, o.Now())
	if err != nil {
		return done(UpdateRefused, update.CodeOf(err))
	}
	res.RolloutID, res.ToVersion = d.RolloutID, d.TargetVersion
	if d.TargetVersion == Version {
		return done(UpdateAlreadyAtTop, "")
	}
	if !update.Newer(d.TargetVersion, Version) {
		// a downgrade (or a development build, which is never updated) is refused
		return done(UpdateRefused, update.CodeNotNewer)
	}
	rawManifest, err := readSpool(filepath.Join(o.Paths.SpoolDir, SpoolManifest), update.MaxManifestBytes)
	if err != nil {
		return done(UpdateRefused, update.CodeManifestInvalid)
	}
	target, err := update.VerifyManifest(rawManifest, cfg.ReleaseKeys, d.TargetVersion, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return done(UpdateRefused, update.CodeOf(err))
	}
	staged := update.StagedPath(installed)
	if err := stageFromSpool(filepath.Join(o.Paths.SpoolDir, SpoolBinary), staged, target); err != nil {
		return done(UpdateRefused, update.CodeOf(err))
	}
	if err := update.Health(ctx, staged, d.TargetVersion); err != nil {
		_ = os.Remove(staged)
		o.Log.Warn("update: the staged binary is not healthy", "err", err)
		return done(UpdateFailed, update.CodeStagedUnhealthy)
	}
	if err := update.Swap(installed, staged); err != nil {
		_ = os.Remove(staged)
		return done(UpdateFailed, update.CodeOf(err))
	}
	if err := update.Health(ctx, installed, d.TargetVersion); err != nil {
		o.Log.Warn("update: the installed binary is not healthy; restoring the previous one", "err", err)
		if rerr := update.Rollback(installed); rerr != nil {
			o.Log.Error("update: rollback failed", "err", rerr)
			return done(UpdateFailed, update.CodeInstallFailed)
		}
		return done(UpdateRolledBack, update.CodeInstalledHealth)
	}
	return done(UpdateInstalled, "")
}

// resultPending reports whether the spool holds a result the per-user agent has not finished with. A result file that
// is not root's own (a link, another owner, too large) was never written by this updater and is removed. A result the
// agent acknowledged (SpoolResultAck names its SHA-256) is removed with the acknowledgement. An acknowledgement left
// without a result is removed.
func resultPending(o Options) bool {
	resultPath, ackPath := filepath.Join(o.Paths.SpoolDir, SpoolResult), filepath.Join(o.Paths.SpoolDir, SpoolResultAck)
	raw, err := fsutil.ReadChecked(resultPath, o.SystemOwner, fsutil.WorldRead, MaxResultBytes)
	if errors.Is(err, fs.ErrNotExist) {
		_ = os.Remove(ackPath)
		return false
	}
	if errors.Is(err, fsutil.ErrUnsafeFile) {
		o.Log.Warn("update: removing a result file this updater did not write", "err", err)
		if rerr := os.Remove(resultPath); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
			return true
		}
		_ = os.Remove(ackPath)
		return false
	}
	if err != nil {
		// unreadable for another reason: never overwritten blind
		return true
	}
	ack, err := readSpool(ackPath, maxAckBytes)
	sum := sha256.Sum256(raw)
	if err != nil || strings.TrimSpace(string(ack)) != hex.EncodeToString(sum[:]) {
		return true
	}
	if rerr := os.Remove(resultPath); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return true
	}
	_ = os.Remove(ackPath)
	return false
}

func stageFromSpool(src, dst string, t *update.Target) error {
	st, err := os.Lstat(src)
	if err != nil || !st.Mode().IsRegular() {
		return &update.Error{Code: update.CodeBinaryMismatch, Detail: "no regular binary in the spool"}
	}
	f, err := fsutil.OpenNoFollow(src)
	if err != nil {
		return &update.Error{Code: update.CodeBinaryMismatch, Detail: fmt.Sprint(err)}
	}
	defer f.Close()
	return update.Stage(f, dst, t)
}

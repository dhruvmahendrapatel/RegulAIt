// Package update is the endpoint agent's self-update core (ADR-0360 §4): it verifies the gateway's signed update
// directive and the release pipeline's signed release manifest, refuses a downgrade, stages a binary beside the
// installed one, checks the staged copy's length and SHA-256, runs its health check, swaps it in and rolls back when
// the installed binary's health check fails.
//
// Trust. Both documents are the device-policy signer's envelope ({keyId, payload, signature}: Ed25519 over the exact
// payload bytes), verified by enforce.VerifyEnvelope against a pinned keyring: the directive against the device-policy
// keys, the manifest against the separate release keys (one key per purpose; the release key stays with the release
// pipeline). The files arrive through a spool any local user can write, so nothing here trusts them until verified, and
// the binary is hashed only after it is copied to a root-only path, so a later change to the spool cannot change what
// runs.
//
// Open source first (ADR-0176): go-tuf v2 was compared and failed admission on unmaintained transitive modules
// (ADR-0360); the envelope verifier is the agent's own, already shipped; versions compare with golang.org/x/mod/semver.
package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"golang.org/x/mod/semver"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

// Schemas of the two signed documents, the health answer and the result file.
const (
	SchemaDirective = "regulait.endpoint-update-directive/1"
	SchemaManifest  = "regulait.endpoint-release/1"
	SchemaHealth    = "regulait.endpoint-health/1"
	SchemaResult    = "regulait.endpoint-update-result/1"
)

// Bounds (secure by default, ADR-0180: compiled in, none is a setting).
const (
	MaxDirectiveBytes = 16 << 10
	MaxManifestBytes  = 64 << 10
	MaxBinaryBytes    = 256 << 20
	// a directive lives at most a day, and one from the future is refused beyond this skew
	MaxDirectiveLifetime = 24 * time.Hour
	ClockSkew            = 5 * time.Minute
	HealthTimeout        = 30 * time.Second
)

// Fixed refusal and failure codes (the result file and the gateway report carry only these).
const (
	CodeDirectiveInvalid = "directive_invalid"
	CodeWrongDevice      = "wrong_device"
	CodeDirectiveStale   = "directive_stale"
	CodeNotNewer         = "not_newer"
	CodeManifestInvalid  = "manifest_invalid"
	CodeVersionMismatch  = "version_mismatch"
	CodeNoTarget         = "no_target_for_platform"
	CodeBinaryMismatch   = "binary_mismatch"
	CodeStagedUnhealthy  = "staged_health_failed"
	CodeInstallFailed    = "install_failed"
	CodeInstalledHealth  = "installed_health_failed"
)

// Error is a refusal or failure with its fixed code.
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string { return e.Code + ": " + e.Detail }

func fail(code, format string, a ...any) error {
	return &Error{Code: code, Detail: fmt.Sprintf(format, a...)}
}

// CodeOf is the fixed code of err, or install_failed for any other error.
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return CodeInstallFailed
}

// Directive is the gateway's signed instruction to one device (ADR-0360 §4).
type Directive struct {
	Schema        string    `json:"schema"`
	DeviceID      string    `json:"deviceId"`
	RolloutID     string    `json:"rolloutId"`
	TargetVersion string    `json:"targetVersion"`
	IssuedAt      time.Time `json:"issuedAt"`
	NotAfter      time.Time `json:"notAfter"`
}

// Target is one platform's binary in a release.
type Target struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	SHA256 string `json:"sha256"`
	Length int64  `json:"length"`
}

// Manifest is the release pipeline's signed description of one version.
type Manifest struct {
	Schema   string    `json:"schema"`
	Version  string    `json:"version"`
	IssuedAt time.Time `json:"issuedAt"`
	Targets  []Target  `json:"targets"`
}

var (
	uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hexShape  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// the gateway's rollout CHECK: x.y.z with an optional pre-release
	versionShape = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$`)
)

func strictJSON(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

// ValidVersion reports whether v is a version this updater can compare.
func ValidVersion(v string) bool {
	return versionShape.MatchString(v) && semver.IsValid("v"+v)
}

// Newer reports whether candidate is strictly greater than current. A current version that is not a release version
// (a development build) is never updated: it is refused, not guessed at.
func Newer(candidate, current string) bool {
	if !ValidVersion(candidate) || !ValidVersion(current) {
		return false
	}
	return semver.Compare("v"+candidate, "v"+current) > 0
}

// VerifyDirective verifies a directive envelope against the device-policy keys and checks that it names this device
// and is fresh.
func VerifyDirective(raw []byte, keys enforce.Keyring, deviceID string, now time.Time) (*Directive, error) {
	if len(raw) > MaxDirectiveBytes {
		return nil, fail(CodeDirectiveInvalid, "directive too large")
	}
	payload, err := enforce.VerifyEnvelope(raw, keys)
	if err != nil {
		return nil, fail(CodeDirectiveInvalid, "%v", err)
	}
	var d Directive
	if err := strictJSON(payload, &d); err != nil || d.Schema != SchemaDirective {
		return nil, fail(CodeDirectiveInvalid, "payload is not a %s", SchemaDirective)
	}
	if !uuidShape.MatchString(d.DeviceID) || !uuidShape.MatchString(d.RolloutID) || !ValidVersion(d.TargetVersion) {
		return nil, fail(CodeDirectiveInvalid, "malformed member")
	}
	if d.DeviceID != deviceID {
		return nil, fail(CodeWrongDevice, "the directive names another device")
	}
	if d.IssuedAt.IsZero() || !d.NotAfter.After(d.IssuedAt) || d.NotAfter.Sub(d.IssuedAt) > MaxDirectiveLifetime {
		return nil, fail(CodeDirectiveInvalid, "validity window")
	}
	if d.IssuedAt.After(now.Add(ClockSkew)) || !now.Before(d.NotAfter) {
		return nil, fail(CodeDirectiveStale, "the directive is not valid now")
	}
	return &d, nil
}

// VerifyManifest verifies a release manifest against the release keys and returns this platform's target of version.
func VerifyManifest(raw []byte, keys enforce.Keyring, version, goos, goarch string) (*Target, error) {
	if len(raw) > MaxManifestBytes {
		return nil, fail(CodeManifestInvalid, "manifest too large")
	}
	payload, err := enforce.VerifyEnvelope(raw, keys)
	if err != nil {
		return nil, fail(CodeManifestInvalid, "%v", err)
	}
	var m Manifest
	if err := strictJSON(payload, &m); err != nil || m.Schema != SchemaManifest || !ValidVersion(m.Version) || m.IssuedAt.IsZero() {
		return nil, fail(CodeManifestInvalid, "payload is not a %s", SchemaManifest)
	}
	if m.Version != version {
		return nil, fail(CodeVersionMismatch, "the manifest is for %s, not %s", m.Version, version)
	}
	var found *Target
	for i, t := range m.Targets {
		if !hexShape.MatchString(t.SHA256) || t.Length <= 0 || t.Length > MaxBinaryBytes {
			return nil, fail(CodeManifestInvalid, "malformed target")
		}
		if t.OS == goos && t.Arch == goarch {
			if found != nil {
				return nil, fail(CodeManifestInvalid, "a platform is listed twice")
			}
			found = &m.Targets[i]
		}
	}
	if found == nil {
		return nil, fail(CodeNoTarget, "no binary for %s/%s", goos, goarch)
	}
	return found, nil
}

// Stage copies at most t.Length+1 bytes of src to dst (created 0700, replacing any earlier staged file), then checks
// the copy's length and SHA-256 and makes it executable. The hash is of the copy, never of the source.
func Stage(src io.Reader, dst string, t *Target) error {
	_ = os.Remove(dst)
	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return fail(CodeInstallFailed, "staging: %v", err)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(src, t.Length+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(dst)
		return fail(CodeInstallFailed, "staging: %v", err)
	}
	if n != t.Length || hex.EncodeToString(h.Sum(nil)) != t.SHA256 {
		_ = os.Remove(dst)
		return fail(CodeBinaryMismatch, "the binary is not the one the release names")
	}
	if err := os.Chmod(dst, 0o755); err != nil {
		_ = os.Remove(dst)
		return fail(CodeInstallFailed, "staging: %v", err)
	}
	return nil
}

// Health runs `<bin> health` and checks that it answers healthy with version want.
func Health(ctx context.Context, bin, want string) error {
	ctx, cancel := context.WithTimeout(ctx, HealthTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "health")
	var out bytes.Buffer
	cmd.Stdout = &limitedBuffer{buf: &out, max: 4 << 10}
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("health check: %v", err)
	}
	var h struct {
		Schema  string `json:"schema"`
		Version string `json:"version"`
		OK      bool   `json:"ok"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &h); err != nil || h.Schema != SchemaHealth || !h.OK {
		return errors.New("health check: not healthy")
	}
	if h.Version != want {
		return fmt.Errorf("health check: version %q, want %q", h.Version, want)
	}
	return nil
}

type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}

// PreviousPath is where Swap keeps the binary it replaced.
func PreviousPath(installed string) string { return installed + ".previous" }

// StagedPath is where a new binary is staged: beside the installed one, so the swap is a rename on one filesystem.
func StagedPath(installed string) string {
	return filepath.Join(filepath.Dir(installed), "."+filepath.Base(installed)+".next")
}

// Swap moves installed to its previous path and staged into place. On a failure midway the installed binary is put
// back. Renaming a running executable is allowed on Linux, macOS and Windows.
func Swap(installed, staged string) error {
	prev := PreviousPath(installed)
	_ = os.Remove(prev)
	if err := os.Rename(installed, prev); err != nil {
		return fail(CodeInstallFailed, "keeping the previous binary: %v", err)
	}
	if err := os.Rename(staged, installed); err != nil {
		_ = os.Rename(prev, installed)
		return fail(CodeInstallFailed, "installing: %v", err)
	}
	return nil
}

// Rollback puts the previous binary back in place.
func Rollback(installed string) error {
	return os.Rename(PreviousPath(installed), installed)
}

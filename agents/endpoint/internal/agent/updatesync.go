package agent

// ADR-0360 §4 (slice 1c): the per-user agent's half of self-update. It carries the gateway's offer (the signed directive,
// the signed release manifest and the binary) into the update spool, and the root updater's result back to the gateway.
// It verifies no signature: the root updater verifies everything it reads from the spool and trusts none of it, so this
// side only bounds and shapes what it writes, writes nothing outside the spool directory and follows no link there.
// Its failures never fail the cycle, and it logs fixed codes only (never an error text, which can name the issuer).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/auth"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/update"
)

const (
	// updateAttemptFile is in the agent's own state directory (never the spool, which other local users can write).
	updateAttemptFile   = "update-attempt.json"
	SchemaUpdateAttempt = "regulait.endpoint-update-attempt/1"
	// MaxResultBytes bounds the result file the per-user agent reads.
	MaxResultBytes = 4 << 10
)

// Fixed codes of one update sync (logged and returned; none carries a secret or a host name).
const (
	UpdateSyncNotConfigured     = "not_configured"     // the config pins no device-policy or no release key
	UpdateSyncStateInvalid      = "state_invalid"      // the attempt state file is damaged; nothing is done
	UpdateSyncSpoolUnavailable  = "spool_unavailable"  // the spool is missing, not a directory, or a link
	UpdateSyncNone              = "none"               // the gateway offers nothing
	UpdateSyncSignerUnavailable = "signer_unavailable" // 503 update_signer_unavailable
	UpdateSyncFetchFailed       = "fetch_failed"       // the offer could not be fetched
	UpdateSyncOfferMalformed    = "offer_malformed"    // the offer is not the contract's shape
	UpdateSyncBinaryFailed      = "binary_failed"      // the binary could not be downloaded
	UpdateSyncBinaryMismatch    = "binary_mismatch"    // the binary is not the length and SHA-256 offered
	UpdateSyncSpoolWriteFailed  = "spool_write_failed" // a spool file could not be written
	UpdateSyncSpooled           = "spooled"            // the offer is in the spool
	UpdateSyncResultPending     = "result_pending"     // an unreported result waits; no new offer is taken this run

	UpdateResultNone            = "none"             // no result file
	UpdateResultRefused         = "refused"          // the result file is a link, not root's, too large or malformed
	UpdateResultNoAttempt       = "no_attempt"       // a result, but this agent never carried an attempt
	UpdateResultAlreadyReported = "already_reported" // these exact bytes were recorded before
	UpdateResultReported        = "reported"         // the gateway recorded it (200, or 409 already_reported)
	UpdateResultDropped         = "dropped"          // the gateway refused it for good (another 4xx); it is finished, not resent
	UpdateResultKept            = "kept"             // the report failed in a way a resend can change; kept for the next run
)

// UpdateRun is what one update sync did.
type UpdateRun struct {
	Result string // UpdateResult* code
	Offer  string // UpdateSync* code
	// AttemptID is the attempt now in the spool (set with Offer == UpdateSyncSpooled).
	AttemptID string
	// Downloaded is false when the spool already held the offered binary.
	Downloaded bool
}

// updateAttempt is the per-user agent's memory of the attempt it last carried into the spool.
type updateAttempt struct {
	Schema    string `json:"schema"`
	AttemptID string `json:"attemptId,omitempty"`
	// ReportedResult is the hex SHA-256 of the last result file the gateway recorded. The spool's sticky bit keeps
	// the per-user agent from deleting a file root wrote, so this is what stops the same bytes being sent again.
	ReportedResult string `json:"reportedResult,omitempty"`
}

var (
	attemptIDShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	sha256Shape    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	resultCode     = regexp.MustCompile(`^[a-z_]{1,64}$`)
	// one version limit across the agent: update.MaxVersionLength characters
	resultVersion  = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,32}$`)
	resultOutcomes = map[string]bool{UpdateInstalled: true, UpdateRefused: true, UpdateFailed: true, UpdateRolledBack: true, UpdateAlreadyAtTop: true}

	errBinaryMismatch = errors.New("binary mismatch")
)

// syncUpdate reports the root updater's result, then takes the gateway's offer. It runs only when the config pins both
// the device-policy and the release keys: the condition the root updater needs to install anything at all.
func (c *Cycle) syncUpdate(ctx context.Context, cl *auth.Client, cfg *Config) *UpdateRun {
	run := &UpdateRun{}
	defer func() { c.Log.Info("self-update sync", "result", run.Result, "offer", run.Offer) }()
	if len(cfg.DevicePolicyKeys) == 0 || len(cfg.ReleaseKeys) == 0 {
		run.Result, run.Offer = UpdateResultNone, UpdateSyncNotConfigured
		return run
	}
	if fi, err := os.Lstat(c.Paths.SpoolDir); err != nil || !fi.IsDir() {
		// missing, or a link: nothing is read from or written through it
		run.Result, run.Offer = UpdateResultNone, UpdateSyncSpoolUnavailable
		return run
	}
	st, err := c.loadUpdateAttempt()
	if err != nil {
		// a damaged state file is never replaced: a result could then be reported against the wrong attempt
		run.Result, run.Offer = UpdateResultNone, UpdateSyncStateInvalid
		return run
	}
	run.Result = c.reportUpdateResult(ctx, cl, st)
	if run.Result == UpdateResultKept {
		// a new attempt id now would have the waiting result reported against it
		run.Offer = UpdateSyncResultPending
		return run
	}
	run.Offer = c.takeUpdateOffer(ctx, cl, st, run)
	return run
}

// reportUpdateResult posts the spool's result file, when there is one, against the attempt last carried. A result is
// finished when the gateway records it (200, or 409 already_reported), when it refuses it for good (any other 4xx but
// 401, 403, 408 and 429), or when it can never be reported (malformed, or no attempt carried); a finished result is
// removed or, when the sticky spool keeps root's file, acknowledged (SpoolResultAck) so the root updater removes it and
// takes the next directive. Authentication, rate limits, server and network errors keep it for the next run.
func (c *Cycle) reportUpdateResult(ctx context.Context, cl *auth.Client, st *updateAttempt) string {
	path := filepath.Join(c.Paths.SpoolDir, SpoolResult)
	// root writes it 0644; a link, another owner (a local user's forgery) or a larger file is refused
	raw, err := fsutil.ReadChecked(path, c.SystemOwner, fsutil.WorldRead, MaxResultBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return UpdateResultNone
	}
	if err != nil {
		return UpdateResultRefused
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	if digest == st.ReportedResult {
		c.finishUpdateResult(path, digest)
		return UpdateResultAlreadyReported
	}
	var r contract.UpdateResult
	if err := fsutil.StrictJSON(raw, &r); err != nil || !validResult(&r) {
		// root's own file, but nothing the gateway would take: finished, or no later directive is ever processed
		c.finishUpdateResult(path, digest)
		return UpdateResultRefused
	}
	if st.AttemptID == "" {
		c.finishUpdateResult(path, digest)
		return UpdateResultNoAttempt
	}
	body, err := json.Marshal(contract.UpdateResultRequest{AttemptID: st.AttemptID, Result: r})
	if err != nil {
		return UpdateResultKept
	}
	res, err := cl.Do(ctx, http.MethodPost, contract.RouteUpdateResults, body, nil)
	if err != nil {
		return UpdateResultKept
	}
	outcome := UpdateResultReported
	switch {
	case res.Status == http.StatusOK:
		var rr contract.UpdateResultResponse
		if err := fsutil.StrictJSON(res.Body, &rr); err != nil || !rr.Recorded {
			return UpdateResultKept
		}
	case res.Status == http.StatusConflict && res.Code() == contract.ErrAlreadyReported:
	case permanentResultRefusal(res.Status):
		// a resend of the same bytes gets the same answer: finished, so later syncs are not stuck on result_pending
		c.Log.Warn("self-update sync", "code", "result_refused_by_gateway", "status", res.Status)
		outcome = UpdateResultDropped
	default:
		return UpdateResultKept
	}
	st.ReportedResult = digest
	if err := c.saveUpdateAttempt(st); err != nil {
		c.Log.Warn("self-update sync", "code", "state_write_failed")
	}
	c.finishUpdateResult(path, digest)
	return outcome
}

// permanentResultRefusal is a 4xx a resend cannot change. 401 and 403 (credentials, a revocation being undone), 408 and
// 429 may pass; a 409 other than already_reported (the attempt closed) is final.
func permanentResultRefusal(status int) bool {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusRequestTimeout, http.StatusTooManyRequests:
		return false
	}
	return status >= 400 && status < 500
}

// finishUpdateResult removes a finished result file. When the spool's sticky bit keeps root's file from this user, it
// writes the acknowledgement (the file's SHA-256) instead, and the root updater removes both before its next directive.
func (c *Cycle) finishUpdateResult(path, digest string) {
	ack := filepath.Join(c.Paths.SpoolDir, SpoolResultAck)
	if err := os.Remove(path); err == nil || errors.Is(err, fs.ErrNotExist) {
		if err := os.Remove(ack); err != nil && !errors.Is(err, fs.ErrNotExist) {
			c.Log.Info("self-update sync", "code", "ack_not_removed")
		}
		return
	}
	if err := fsutil.WriteAtomic(ack, []byte(digest+"\n"), 0o644, -1, true); err != nil {
		c.Log.Warn("self-update sync", "code", "result_not_acknowledged")
	}
}

func validResult(r *contract.UpdateResult) bool {
	return r.Schema == update.SchemaResult && resultOutcomes[r.Outcome] && (r.Code == "" || resultCode.MatchString(r.Code)) &&
		(r.RolloutID == "" || attemptIDShape.MatchString(r.RolloutID)) && resultVersion.MatchString(r.FromVersion) &&
		(r.ToVersion == "" || resultVersion.MatchString(r.ToVersion)) && r.At != "" && len(r.At) <= 64
}

// takeUpdateOffer fetches the offer and, when there is one, writes it to the spool: the binary first (downloaded to a
// temporary file, checked against the offered length and SHA-256, then renamed), then the release manifest, and the
// directive last, so the root updater never finds this attempt's directive without its binary. A directive from an
// earlier attempt is removed before a new binary lands, so it is never paired with the wrong binary either.
func (c *Cycle) takeUpdateOffer(ctx context.Context, cl *auth.Client, st *updateAttempt, run *UpdateRun) string {
	spool := c.Paths.SpoolDir
	res, err := cl.Do(ctx, http.MethodGet, contract.RouteUpdate, nil, nil)
	if err != nil {
		return UpdateSyncFetchFailed
	}
	if res.Status == http.StatusServiceUnavailable && res.Code() == contract.ErrUpdateSignerUnavailable {
		return UpdateSyncSignerUnavailable
	}
	if res.Status != http.StatusOK {
		return UpdateSyncFetchFailed
	}
	var ur contract.UpdateResponse
	if err := fsutil.StrictJSON(res.Body, &ur); err != nil {
		return UpdateSyncOfferMalformed
	}
	if ur.Update == nil {
		return UpdateSyncNone
	}
	off := ur.Update
	if !validOffer(off) {
		return UpdateSyncOfferMalformed
	}
	binPath := filepath.Join(spool, SpoolBinary)
	directivePath := filepath.Join(spool, SpoolDirective)
	if !spooledBinaryMatches(binPath, &off.Binary) {
		if err := os.Remove(directivePath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return UpdateSyncSpoolWriteFailed
		}
		if code := c.downloadBinary(ctx, cl, binPath, &off.Binary); code != "" {
			return code
		}
		run.Downloaded = true
	}
	if err := fsutil.WriteAtomic(filepath.Join(spool, SpoolManifest), off.Manifest, 0o644, -1, true); err != nil {
		return UpdateSyncSpoolWriteFailed
	}
	if err := fsutil.WriteAtomic(directivePath, off.Directive, 0o644, -1, true); err != nil {
		return UpdateSyncSpoolWriteFailed
	}
	if st.AttemptID != off.AttemptID {
		st.AttemptID = off.AttemptID
		if err := c.saveUpdateAttempt(st); err != nil {
			c.Log.Warn("self-update sync", "code", "state_write_failed")
		}
	}
	run.AttemptID = off.AttemptID
	return UpdateSyncSpooled
}

func validOffer(o *contract.UpdateOffer) bool {
	b := o.Binary
	return attemptIDShape.MatchString(o.AttemptID) && b.Path == contract.RouteUpdateBinary && b.OS == runtime.GOOS && b.Arch == runtime.GOARCH &&
		b.Length >= 1 && b.Length <= update.MaxBinaryBytes && sha256Shape.MatchString(b.SHA256) &&
		envelopeShaped(o.Directive, update.MaxDirectiveBytes) && envelopeShaped(o.Manifest, update.MaxManifestBytes)
}

// envelopeShaped checks only the shape of a signed envelope ({keyId, payload, signature}, nothing else, bounded): the
// root updater verifies the signature.
func envelopeShaped(raw json.RawMessage, max int) bool {
	if t := bytes.TrimSpace(raw); len(t) == 0 || len(raw) > max || t[0] != '{' {
		return false
	}
	var e enforce.Envelope
	return fsutil.StrictJSON(raw, &e) == nil && e.KeyID != "" && e.Payload != "" && e.Signature != ""
}

// spooledBinaryMatches reports whether the spool already holds the offered binary (a regular file, not a link).
func spooledBinaryMatches(path string, b *contract.UpdateBinary) bool {
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != b.Length {
		return false
	}
	f, err := fsutil.OpenNoFollow(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, b.Length+1))
	return err == nil && n == b.Length && hex.EncodeToString(h.Sum(nil)) == b.SHA256
}

// downloadBinary streams the binary into a temporary spool file, at most b.Length+1 bytes, hashing as it writes, and
// renames it into place only when the length and SHA-256 are the offered ones. It returns "" or a fixed code.
func (c *Cycle) downloadBinary(ctx context.Context, cl *auth.Client, path string, b *contract.UpdateBinary) string {
	res, err := cl.Download(ctx, b.Path, func(h http.Header, body io.Reader) error {
		if mt, _, err := mime.ParseMediaType(h.Get("Content-Type")); err != nil || mt != "application/octet-stream" {
			return errors.New("content type")
		}
		return fsutil.StreamAtomic(path, 0o644, func(w io.Writer) error {
			sum := sha256.New()
			n, err := io.Copy(io.MultiWriter(w, sum), io.LimitReader(body, b.Length+1))
			if err != nil {
				return err
			}
			if n != b.Length || hex.EncodeToString(sum.Sum(nil)) != b.SHA256 {
				return errBinaryMismatch
			}
			return nil
		})
	})
	if errors.Is(err, errBinaryMismatch) {
		return UpdateSyncBinaryMismatch
	}
	if err != nil || res.Status != http.StatusOK {
		return UpdateSyncBinaryFailed
	}
	return ""
}

func (c *Cycle) loadUpdateAttempt() (*updateAttempt, error) {
	raw, err := readChecked(filepath.Join(c.Paths.StateDir, updateAttemptFile), ownUID(), fsutil.OwnerOnly)
	if errors.Is(err, fs.ErrNotExist) {
		return &updateAttempt{Schema: SchemaUpdateAttempt}, nil
	}
	if err != nil {
		return nil, err
	}
	var st updateAttempt
	if err := fsutil.StrictJSON(raw, &st); err != nil || st.Schema != SchemaUpdateAttempt ||
		(st.AttemptID != "" && !attemptIDShape.MatchString(st.AttemptID)) || (st.ReportedResult != "" && !sha256Shape.MatchString(st.ReportedResult)) {
		return nil, errors.New("the update attempt state is malformed")
	}
	return &st, nil
}

func (c *Cycle) saveUpdateAttempt(st *updateAttempt) error {
	if err := ensurePrivateDir(c.Paths.StateDir); err != nil {
		return err
	}
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return fsutil.WriteAtomic(filepath.Join(c.Paths.StateDir, updateAttemptFile), append(b, '\n'), 0o600, -1, true)
}

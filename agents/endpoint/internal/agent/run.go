package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/auth"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/devicekey"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/privacy"
)

// Compiled bounds on the org policy (R15 §3.4): the gateway may choose within them, never outside.
const (
	DefaultInterval = 24 * time.Hour
	MinInterval     = time.Hour
	MaxInterval     = 7 * 24 * time.Hour
	Jitter          = 30 * time.Minute
)

// Cycle is what one collection run needs beyond Options.
type Cycle struct {
	Options
	// Keyring is the pinned pack keyring (pack.CompiledKeyring in production).
	Keyring pack.Keyring
	// Env builds the collectors' environment.
	Env func() (*collect.Env, error)
	// Identity is what the pseudonymity guard refuses to send.
	Identity privacy.Identity

	lastConfig *auth.Response
}

// Result is one cycle's outcome.
type Result struct {
	Interval time.Duration
	Report   *contract.Report
	Rotated  bool
}

func clampInterval(seconds int) time.Duration {
	if seconds <= 0 {
		return DefaultInterval
	}
	d := time.Duration(seconds) * time.Second
	if d < MinInterval {
		return MinInterval
	}
	if d > MaxInterval {
		return MaxInterval
	}
	return d
}

// client returns the authenticated client for the saved key. If the gateway refuses the key and a rotation was in
// flight, the pending key is tried: the rotation's answer was lost after the gateway switched (ADR-0188 S7 point 4).
func (c *Cycle) client(ctx context.Context, cfg *Config, s *State) (*auth.Client, devicekey.Store, error) {
	store, err := storeByName(c.Options, s.KeyProvider)
	if err != nil {
		return nil, nil, err
	}
	httpc, err := c.HTTP(cfg.Issuer, cfg.CABundle)
	if err != nil {
		return nil, nil, err
	}
	for _, id := range []string{s.KeyID, s.PendingKeyID} {
		if id == "" {
			continue
		}
		key, err := store.Load(id)
		if err != nil {
			continue
		}
		clientID, err := auth.ClientID(key.Public())
		if err != nil {
			return nil, nil, err
		}
		cl := &auth.Client{Issuer: cfg.Issuer, HTTP: httpc, Key: key, ClientID: clientID}
		res, err := cl.Do(ctx, http.MethodGet, contract.RouteConfig, nil, nil)
		var he *auth.HTTPError
		if errors.As(err, &he) && he.Status == http.StatusUnauthorized && id == s.KeyID && s.PendingKeyID != "" {
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		if id == s.PendingKeyID {
			old := s.KeyID
			s.KeyID, s.ClientID, s.PendingKeyID = id, clientID, ""
			if err := saveState(c.Options, s); err != nil {
				return nil, nil, err
			}
			_ = store.Delete(old)
			c.Log.Info("key rotation completed after a lost answer")
		}
		c.lastConfig = res
		return cl, store, nil
	}
	return nil, nil, errors.New("no device key of this user loads; re-registration is needed")
}

// RunOnce registers if needed, fetches and verifies the collection pack, collects, and uploads one signed report.
func (c *Cycle) RunOnce(ctx context.Context) (*Result, error) {
	c.defaults()
	s, err := Register(ctx, c.Options)
	if err != nil {
		return nil, err
	}
	cfg, err := LoadConfig(c.Paths.ConfigFile, c.SystemOwner)
	if err != nil {
		return nil, err
	}
	cl, store, err := c.client(ctx, cfg, s)
	if err != nil {
		return nil, err
	}
	res := c.lastConfig
	if res.Status != http.StatusOK {
		return nil, &auth.HTTPError{Op: "config", Status: res.Status, Code: res.Code()}
	}
	var conf contract.ConfigResponse
	if err := strictJSON(res.Body, &conf); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	verified, err := pack.Verify(conf.Pack, c.Keyring, s.PackVersion)
	if err != nil {
		// nothing is collected without a manifest this agent trusts
		c.Log.Error("collection pack refused; nothing collected", "err", err)
		return nil, err
	}
	if verified.Version != s.PackVersion {
		s.PackVersion = verified.Version
		if err := saveState(c.Options, s); err != nil {
			return nil, err
		}
	}
	disabled := map[contract.Kind]string{}
	for k := range cfg.Disabled {
		disabled[k] = collect.GapDisabledByLocalPolicy
	}
	for _, k := range conf.OrgPolicy.DisabledKinds {
		if _, ok := disabled[k]; !ok {
			disabled[k] = collect.GapDisabledByOrgPolicy
		}
	}
	env, err := c.Env()
	if err != nil {
		return nil, err
	}
	facts, gaps := collect.Collect(env, verified.Collection, disabled)
	if facts == nil {
		facts = []contract.Fact{}
	}
	if gaps == nil {
		gaps = []contract.Gap{}
	}
	factsJSON, err := json.Marshal(facts)
	if err != nil {
		return nil, err
	}
	fd := sha256.Sum256(factsJSON)
	rep := &contract.Report{
		Schema: contract.SchemaReport, SnapshotID: uuidV4(), CollectedAt: c.Now().UTC().Format(time.RFC3339), AgentVersion: Version,
		OS: runtime.GOOS, Arch: runtime.GOARCH, ManifestVersion: verified.Version, ManifestDigest: verified.CollectionDigest,
		KeyProtection: s.KeyProtection, DroppedSnapshots: s.DroppedSnapshots, Facts: facts, Gaps: gaps, FactsDigest: hex.EncodeToString(fd[:]),
	}
	if err := c.upload(ctx, cl, rep); err != nil {
		var he *auth.HTTPError
		if errors.As(err, &he) && he.Retryable() || !errors.As(err, &he) && !errors.Is(err, privacy.ErrIdentifying) {
			// R15 §3.4: snapshots restate state, so a lost one costs nothing but is counted (the buffer is SD4f)
			s.DroppedSnapshots++
			_ = saveState(c.Options, s)
		}
		return nil, err
	}
	s.DroppedSnapshots, s.LastFactsDigest = 0, rep.FactsDigest
	if err := saveState(c.Options, s); err != nil {
		return nil, err
	}
	out := &Result{Interval: clampInterval(conf.OrgPolicy.IntervalSeconds), Report: rep}
	if cl.RotateDue(c.Now()) {
		if err := c.rotate(ctx, cfg, cl, store, s); err != nil {
			c.Log.Warn("key rotation failed; the next run retries", "err", err)
		} else {
			out.Rotated = true
		}
	}
	return out, nil
}

// upload sends one report: the exact body bytes, their RFC 9530 Content-Digest, and a report signature by the
// device key binding the digest, the snapshot id and the reports URL. The pseudonymity guard sees the bytes first.
func (c *Cycle) upload(ctx context.Context, cl *auth.Client, rep *contract.Report) error {
	body, err := json.Marshal(rep)
	if err != nil {
		return err
	}
	if err := c.Identity.Check(body); err != nil {
		c.Log.Error("report not sent", "err", err)
		return err
	}
	digest := auth.ContentDigest(body)
	res, err := cl.Do(ctx, http.MethodPost, contract.RouteReports, body, func(h http.Header) error {
		sig, err := auth.ReportSignature(cl.Key, cl.ClientID, cl.Issuer+contract.RouteReports, rep.SnapshotID, digest)
		if err != nil {
			return err
		}
		h.Set(contract.HeaderContentDigest, digest)
		h.Set(contract.HeaderReportSignature, sig)
		return nil
	})
	if err != nil {
		return err
	}
	if res.Status != http.StatusAccepted {
		return &auth.HTTPError{Op: "report", Status: res.Status, Code: res.Code()}
	}
	var rr contract.ReportResponse
	if err := strictJSON(res.Body, &rr); err != nil || !rr.Accepted {
		return errors.New("the report answer is malformed")
	}
	return nil
}

// rotate replaces the device key (ADR-0188 S7 point 4): a new key in the same store, its proof of possession, and
// the request authenticated by the current key. The new key id is saved as pending first, so a lost answer is
// recovered by trying it next time.
func (c *Cycle) rotate(ctx context.Context, cfg *Config, cl *auth.Client, store devicekey.Store, s *State) error {
	next, err := store.Create()
	if err != nil {
		return err
	}
	s.PendingKeyID = next.ID()
	if err := saveState(c.Options, s); err != nil {
		return err
	}
	jwk, err := auth.PublicJWK(next.Public())
	if err != nil {
		return err
	}
	proof, err := auth.RotationProof(next, cfg.Issuer+contract.RouteCredentials)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(contract.RotateRequest{PublicJWK: jwk, Proof: proof})
	res, err := cl.Do(ctx, http.MethodPost, contract.RouteCredentials, body, nil)
	if err != nil {
		return err
	}
	if res.Status != http.StatusCreated {
		return &auth.HTTPError{Op: "rotate", Status: res.Status, Code: res.Code()}
	}
	var rr contract.RegisterResponse
	newID, _ := auth.ClientID(next.Public())
	if err := strictJSON(res.Body, &rr); err != nil || rr.ClientID != newID {
		return errors.New("the rotation answer is malformed")
	}
	old := s.KeyID
	s.KeyID, s.ClientID, s.PendingKeyID = next.ID(), newID, ""
	if err := saveState(c.Options, s); err != nil {
		return err
	}
	return store.Delete(old)
}

// Daemon runs cycles until ctx ends: the org's interval with ±30 min jitter so a fleet does not stampede the
// gateway, and exponential backoff (5 min doubling to 6 h) after a failure.
func (c *Cycle) Daemon(ctx context.Context) error {
	backoff := 5 * time.Minute
	for {
		wait := DefaultInterval
		r, err := c.RunOnce(ctx)
		if err != nil {
			c.Log.Warn("cycle failed", "err", err)
			wait = backoff
			if backoff *= 2; backoff > 6*time.Hour {
				backoff = 6 * time.Hour
			}
		} else {
			backoff = 5 * time.Minute
			wait = r.Interval
		}
		wait += time.Duration(rand.Int64N(int64(2*Jitter))) - Jitter
		if wait < time.Minute {
			wait = time.Minute
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// ProductionIdentity is what the guard compares reports against on this device.
func ProductionIdentity() privacy.Identity {
	home, _ := os.UserHomeDir()
	host, _ := os.Hostname()
	return privacy.Identity{HomeDir: home, UserName: currentUserName(), Hostname: host}
}

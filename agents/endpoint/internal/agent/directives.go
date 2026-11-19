package agent

// ADR-0331: governed add-on removal, the agent's side of one sync. It runs only after the collection pack has
// verified in the same cycle (a directive is bounded by that manifest), and its failures never fail the cycle: the
// report has already been sent.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/auth"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/collect"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/directive"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/pack"
)

const ledgerFile = "directive-ledger.json"

// DirectiveRun is what one directive sync did.
type DirectiveRun struct {
	Outcomes []contract.DirectiveOutcome
	// Refused counts envelopes that did not verify (they carry no id this agent can trust, so they are not reported).
	Refused int
}

// syncDirectives fetches, verifies, applies and reports this device's removal directives.
// keys is the compiled keyring plus this cycle's pinned device-policy keys.
func (c *Cycle) syncDirectives(ctx context.Context, cl *auth.Client, s *State, col *pack.Collection, env *collect.Env, keys enforce.Keyring) (*DirectiveRun, error) {
	res, err := cl.Do(ctx, http.MethodGet, contract.RouteDirectives, nil, nil)
	if err != nil {
		return nil, err
	}
	if res.Status != http.StatusOK {
		// 503 directive_signer_unavailable until SD4: nothing to do
		return nil, &auth.HTTPError{Op: "directives", Status: res.Status, Code: res.Code()}
	}
	var dr contract.DirectivesResponse
	if err := strictJSON(res.Body, &dr); err != nil || len(dr.Directives) > contract.MaxDirectivesPerSync {
		return nil, errors.New("the directives answer is malformed")
	}
	ledger, err := c.loadLedger()
	if err != nil {
		return nil, err
	}
	now := c.Now()
	ledger.Prune(now)
	notify := c.Notify
	if notify == nil {
		notify = directive.PlatformNotifier
	}
	run := &DirectiveRun{}
	for _, raw := range dr.Directives {
		d, code, err := directive.Verify(raw, keys, s.IdentityID, now)
		if err != nil {
			run.Refused++
			c.Log.Warn("removal directive refused", "err", err)
			continue
		}
		if prior, ok := ledger.Seen(d.DirectiveID); ok {
			// a replay, or a lost outcome: report what was done, do nothing again
			run.Outcomes = append(run.Outcomes, prior)
			continue
		}
		o := contract.DirectiveOutcome{DirectiveID: d.DirectiveID}
		if code != "" {
			o.Outcome, o.Code = contract.OutcomeFailed, code
		} else {
			r := directive.Apply(d, col, env)
			o.Outcome, o.Code = r.Outcome, r.Code
			if r.Outcome == contract.OutcomeRemoved {
				o.Notified = notify(ctx, directive.Notice(d.Asset.ServerName, r.Provider, d.Asset.Path))
			}
		}
		if !ledger.Record(d, o) {
			c.Log.Warn("removal directive ledger is full; directive not acted on")
			continue
		}
		run.Outcomes = append(run.Outcomes, o)
		c.Log.Info("removal directive", "directive", d.DirectiveID, "outcome", o.Outcome, "code", o.Code)
	}
	if err := c.saveLedger(ledger); err != nil {
		return run, err
	}
	if len(run.Outcomes) == 0 {
		return run, nil
	}
	body, err := json.Marshal(contract.DirectiveOutcomesRequest{Outcomes: run.Outcomes})
	if err != nil {
		return run, err
	}
	out, err := cl.Do(ctx, http.MethodPost, contract.RouteDirectiveOutcomes, body, nil)
	if err != nil {
		return run, err
	}
	if out.Status != http.StatusOK {
		return run, &auth.HTTPError{Op: "directive-outcomes", Status: out.Status, Code: out.Code()}
	}
	return run, nil
}

func (c *Cycle) loadLedger() (*directive.Ledger, error) {
	raw, err := readChecked(filepath.Join(c.Paths.StateDir, ledgerFile), ownUID(), OwnerOnly)
	if errors.Is(err, os.ErrNotExist) {
		return directive.NewLedger(), nil
	}
	if err != nil {
		return nil, err
	}
	var l directive.Ledger
	if err := strictJSON(raw, &l); err != nil || l.Schema != directive.LedgerSchema || l.Entries == nil {
		// a damaged ledger is never replaced by an empty one: that would re-open replay
		return nil, errors.New("the directive ledger is malformed")
	}
	return &l, nil
}

func (c *Cycle) saveLedger(l *directive.Ledger) error {
	if err := ensurePrivateDir(c.Paths.StateDir); err != nil {
		return err
	}
	b, err := json.Marshal(l)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(c.Paths.StateDir, ledgerFile), append(b, '\n'), 0o600, -1)
}

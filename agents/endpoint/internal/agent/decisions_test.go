//go:build !windows

package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/decisionlog"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
)

// spoolDecisions stands in for the hook: n decisions and one bypass session in the user's spool.
func spoolDecisions(t *testing.T, f *fixture, n int) *decisionlog.Spool {
	t.Helper()
	s := decisionlog.New(f.opts.Paths.StateDir)
	ref := s.SessionRef("vendor-session-jdoe-laptop")
	for i := range n {
		call := enforce.Call{SessionID: "vendor-session-jdoe-laptop", PermissionMode: "bypassPermissions", MCP: &enforce.MCPCall{Server: "shadow"}}
		ev := decisionlog.NewEvent(enforce.AgentClaudeCode, call, enforce.Decision{Verdict: enforce.Deny}, nil, ref, time.Now().Add(time.Duration(i)*time.Second))
		if err := s.Emit(ev); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func (f *fixture) decisionRequests() []contract.DecisionBatch {
	f.gw.Lock()
	defer f.gw.Unlock()
	var out []contract.DecisionBatch
	for _, q := range f.gw.Requests {
		if q.Path == contract.RouteDecisions {
			var b contract.DecisionBatch
			if fsutil.StrictJSON(q.Body, &b) == nil {
				out = append(out, b)
			}
		}
	}
	return out
}

func TestRunOnceUploadsSignedDecisions(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	spoolDecisions(t, f, 3)
	// a registered Claude Code managed file, owned by the test's uid (standing in for root)
	os.MkdirAll(filepath.Join(f.dir, "managed"), 0o755)
	os.WriteFile(filepath.Join(f.dir, "managed", "managed-settings.json"), []byte(`{"allowManagedHooksOnly": true, "hooks": {"PreToolUse": [{"hooks": [
		{"type": "command", "args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/p"], "onFailure": "block"}]}]}}`), 0o644)
	if _, err := f.cycle().RunOnce(context.Background()); err != nil {
		t.Fatalf("%v\n%s", err, f.logs)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	// the fake verified the DPoP token, Content-Digest and decisions signature (typ, kid, iss, aud, batchId)
	if len(f.gw.Batches) != 1 || len(f.gw.Reports) != 1 {
		t.Fatalf("batches %d reports %d\n%s", len(f.gw.Batches), len(f.gw.Reports), f.logs)
	}
	b, body := f.gw.Batches[0], string(f.gw.BatchBodies[0])
	if len(b.Events) != 3 || len(b.Integrity) != 4 || b.AgentVersion != Version {
		t.Fatalf("batch: %s", body)
	}
	states := map[string]string{}
	for _, e := range b.Integrity {
		states[e.File] = e.State
		if e.File == contract.ManagedFileClaudeCode && (e.HookStatus == nil || *e.HookStatus != contract.HookRegistered) {
			t.Fatalf("claude-code: %+v", e)
		}
	}
	if states[contract.ManagedFileClaudeCode] != contract.FileStatePresent || states[contract.ManagedFileCodex] != contract.FileStateMissing {
		t.Fatalf("states %v", states)
	}
	for _, forbidden := range []string{"jdoe", "vendor-session", "shadow", f.dir} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("batch carries %q: %s", forbidden, body)
		}
	}
	if n, _ := os.ReadDir(filepath.Join(f.opts.Paths.StateDir, "decisions", "outbox")); len(n) != 0 {
		t.Fatalf("outbox left: %v", n)
	}
}

func TestDecisionRetryReusesTheBatch(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	spoolDecisions(t, f, 2)
	c := f.cycle()
	f.gw.Lock()
	f.gw.DecisionsStatus, f.gw.DecisionsCode = http.StatusServiceUnavailable, "unavailable"
	f.gw.Unlock()
	// the report still succeeds; the batch waits
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatalf("%v\n%s", err, f.logs)
	}
	f.gw.Lock()
	f.gw.DecisionsStatus = 0
	f.gw.Unlock()
	// the answer to the resend is lost after the gateway accepted it: the next cycle's resend is a duplicate
	working := c.HTTP
	c.HTTP = func(issuer string, ca []byte) (*http.Client, error) {
		cl, err := working(issuer, ca)
		if err != nil {
			return nil, err
		}
		cl.Transport = loseAnswer{next: cl.Transport, path: contract.RouteDecisions}
		return cl, nil
	}
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.HTTP = working
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	sent := f.decisionRequests()
	if len(sent) < 3 || sent[0].BatchID != sent[1].BatchID || sent[1].BatchID != sent[2].BatchID || len(sent[0].Events) != 2 {
		t.Fatalf("sent %d batches: %+v", len(sent), sent)
	}
	f.gw.Lock()
	accepted := len(f.gw.Batches)
	f.gw.Unlock()
	// accepted once (the lost answer); the duplicate resend finished it, and the cycle then sent the new integrity
	// report in a batch of its own
	if accepted != 2 {
		t.Fatalf("accepted %d", accepted)
	}
	if n, _ := os.ReadDir(filepath.Join(f.opts.Paths.StateDir, "decisions", "outbox")); len(n) != 0 {
		t.Fatalf("outbox left: %v", n)
	}
}

func TestReportFailureStillSendsDecisions(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	spoolDecisions(t, f, 1)
	c := f.cycle()
	working := c.HTTP
	c.HTTP = func(issuer string, ca []byte) (*http.Client, error) {
		cl, err := working(issuer, ca)
		if err != nil {
			return nil, err
		}
		cl.Transport = failReports{cl.Transport}
		return cl, nil
	}
	if _, err := c.RunOnce(context.Background()); err == nil {
		t.Fatal("the report error was not returned")
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Batches) != 1 || len(f.gw.Batches[0].Events) != 1 {
		t.Fatalf("batches %d", len(f.gw.Batches))
	}
}

func TestDecisionsPermanentRefusalAndGuard(t *testing.T) {
	f := newFixture(t, 5)
	Redeem(context.Background(), f.opts)
	s := spoolDecisions(t, f, 2)
	c := f.cycle()
	f.gw.Lock()
	f.gw.DecisionsStatus, f.gw.DecisionsCode = http.StatusBadRequest, "invalid_body"
	f.gw.Unlock()
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.Dropped() != 2 {
		t.Fatalf("dropped %d", s.Dropped())
	}
	f.gw.Lock()
	f.gw.DecisionsStatus = 0
	f.gw.Unlock()
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.gw.Lock()
	if len(f.gw.Batches) != 1 || f.gw.Batches[0].DroppedEvents != 2 || len(f.gw.Batches[0].Events) != 0 {
		t.Fatalf("%+v", f.gw.Batches)
	}
	f.gw.Unlock()
	// the pseudonymity guard sees every body: one it refuses is not sent, and its events are counted as dropped
	spoolDecisions(t, f, 3)
	c.Identity.UserName = "bypassPermissions"
	if _, err := c.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.gw.Lock()
	defer f.gw.Unlock()
	if len(f.gw.Batches) != 1 || s.Dropped() != 3 || !strings.Contains(f.logs.String(), "decision batch not sent") {
		t.Fatalf("batches %d dropped %d", len(f.gw.Batches), s.Dropped())
	}
}

type loseAnswer struct {
	next http.RoundTripper
	path string
}

func (l loseAnswer) RoundTrip(r *http.Request) (*http.Response, error) {
	res, err := l.next.RoundTrip(r)
	if err == nil && r.URL.Path == l.path {
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		return nil, errors.New("connection reset after the gateway answered")
	}
	return res, err
}

package decisionlog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
)

func decisionEvent(at time.Time) Event {
	return NewEvent(enforce.AgentClaudeCode, enforce.Call{MCP: &enforce.MCPCall{}}, enforce.Decision{Verdict: enforce.Deny}, nil, nil, at)
}

func sessionEvent(ref, mode *string) Event {
	ev := NewEvent(enforce.AgentClaudeCode, enforce.Call{}, enforce.Decision{}, nil, ref, testNow)
	ev.PermissionMode = mode
	return ev
}

func spooled(t *testing.T, s *Spool) int {
	t.Helper()
	n, err := s.count()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSpoolWritesPrivateFiles(t *testing.T) {
	s := New(t.TempDir())
	ev := decisionEvent(testNow)
	if err := s.Emit(ev); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(s.Dir, ev.EventID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var back Event
	if err := fsutil.StrictJSON(b, &back); err != nil || back.EventID != ev.EventID {
		t.Fatalf("%v %s", err, b)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{s.Dir: 0o700, filepath.Join(s.Dir, ev.EventID+".json"): 0o600, s.outboxDir(): 0o700, s.seenDir(): 0o700} {
			if st, err := os.Stat(path); err != nil || st.Mode().Perm() != want {
				t.Fatalf("%s: %v %v", path, st.Mode(), err)
			}
		}
	}
	// an event that breaks the contract is never spooled
	bad := decisionEvent(testNow)
	bad.Decision.Mode = "off"
	if err := s.Emit(bad); err == nil || spooled(t, s) != 1 {
		t.Fatalf("invalid event spooled: %v", err)
	}
}

func TestSpoolBoundCountsDropped(t *testing.T) {
	s := New(t.TempDir())
	s.MaxEvents = 3
	for i := range 5 {
		err := s.Emit(decisionEvent(testNow.Add(time.Duration(i) * time.Second)))
		if i < 3 && err != nil || i >= 3 && !errors.Is(err, ErrFull) {
			t.Fatalf("event %d: %v", i, err)
		}
	}
	if spooled(t, s) != 3 || s.Dropped() != 2 {
		t.Fatalf("spooled %d dropped %d", spooled(t, s), s.Dropped())
	}
}

func TestSessionEventsOncePerSessionAndMode(t *testing.T) {
	s := New(t.TempDir())
	ref := s.SessionRef("vendor-session-1")
	other := s.SessionRef("vendor-session-2")
	bypass, def := "bypassPermissions", "default"
	for _, ev := range []Event{sessionEvent(ref, &bypass), sessionEvent(ref, &bypass), sessionEvent(ref, &def), sessionEvent(other, &bypass), sessionEvent(nil, nil), sessionEvent(nil, nil)} {
		if err := s.Emit(ev); err != nil {
			t.Fatal(err)
		}
	}
	if n := spooled(t, s); n != 4 {
		t.Fatalf("session events spooled: %d, want 4", n)
	}
	// a decision already shows the session in its mode: no session event follows it
	d := decisionEvent(testNow)
	plan := "plan"
	d.SessionRef, d.PermissionMode = ref, &plan
	if err := s.Emit(d); err != nil {
		t.Fatal(err)
	}
	if err := s.Emit(sessionEvent(ref, &plan)); err != nil {
		t.Fatal(err)
	}
	if n := spooled(t, s); n != 5 {
		t.Fatalf("spooled %d, want 5", n)
	}
	// Cursor (no mode): its session event still carries the session ref
	cur := NewEvent(enforce.AgentCursor, enforce.Call{}, enforce.Decision{}, nil, ref, testNow)
	if cur.Kind != contract.EventSession || cur.SessionRef == nil || cur.PermissionMode != nil {
		t.Fatalf("%+v", cur)
	}
}

func TestSessionRef(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	a, a2, b := s.SessionRef("vendor-session-1"), s.SessionRef("vendor-session-1"), s.SessionRef("vendor-session-2")
	if a == nil || b == nil || *a != *a2 || *a == *b || !hex64.MatchString(*a) {
		t.Fatalf("%v %v %v", a, a2, b)
	}
	if s.SessionRef("") != nil {
		t.Fatal("an empty id got a ref")
	}
	salt, err := os.ReadFile(filepath.Join(s.Dir, "salt"))
	if err != nil || len(salt) != saltBytes {
		t.Fatalf("salt %d %v", len(salt), err)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(filepath.Join(s.Dir, "salt")); st.Mode().Perm() != 0o600 {
			t.Fatalf("salt mode %v", st.Mode())
		}
	}
	// a second spool (the next hook process) reads the same salt
	if c := New(dir).SessionRef("vendor-session-1"); *c != *a {
		t.Fatal("the salt changed")
	}
	// another device (another salt) gets another ref for the same session id
	if d := New(t.TempDir()).SessionRef("vendor-session-1"); *d == *a {
		t.Fatal("refs are linkable across devices")
	}
	// a malformed salt gives no ref, never the raw id
	os.WriteFile(filepath.Join(s.Dir, "salt"), []byte("short"), 0o600)
	if s.SessionRef("vendor-session-1") != nil {
		t.Fatal("ref from a malformed salt")
	}
}

// fakeGateway records what Drain sends and answers with the next queued result.
type fakeGateway struct {
	bodies  [][]byte
	ids     []string
	answers []error
}

func (f *fakeGateway) send(_ context.Context, id string, body []byte) error {
	f.ids = append(f.ids, id)
	f.bodies = append(f.bodies, append([]byte{}, body...))
	if len(f.answers) == 0 {
		return nil
	}
	err := f.answers[0]
	f.answers = f.answers[1:]
	return err
}

func (f *fakeGateway) batch(t *testing.T, i int) contract.DecisionBatch {
	t.Helper()
	var b contract.DecisionBatch
	if err := fsutil.StrictJSON(f.bodies[i], &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func integrityFixture() []contract.IntegrityEntry {
	return []contract.IntegrityEntry{{File: contract.ManagedFileCursor, State: contract.FileStateMissing}}
}

func TestDrainBatchesOldestFirst(t *testing.T) {
	s := New(t.TempDir())
	s.MaxEvents = 2000
	for i := range 1203 {
		if err := s.Emit(decisionEvent(testNow.Add(-time.Duration(i) * time.Second))); err != nil {
			t.Fatal(err)
		}
	}
	_ = s.addDropped(7)
	gw := &fakeGateway{}
	res, err := s.Drain(context.Background(), DrainOptions{AgentVersion: "0.0.0-dev", Integrity: integrityFixture(), Send: gw.send, Now: func() time.Time { return testNow }})
	if err != nil || res.Batches != 3 || res.Events != 1203 {
		t.Fatalf("%+v %v", res, err)
	}
	var last string
	for i, want := range []int{500, 500, 203} {
		b := gw.batch(t, i)
		if len(b.Events) != want || b.Schema != contract.SchemaDecisions || b.SentAt != "2026-11-18T12:00:00Z" || b.BatchID != gw.ids[i] || !uuidV4Shape.MatchString(b.BatchID) {
			t.Fatalf("batch %d: %d events %+v", i, len(b.Events), b.BatchID)
		}
		// integrity rides in the first batch only, and the dropped count once
		if i == 0 && (len(b.Integrity) != 1 || b.DroppedEvents != 7) || i > 0 && (len(b.Integrity) != 0 || b.DroppedEvents != 0) {
			t.Fatalf("batch %d: integrity %d dropped %d", i, len(b.Integrity), b.DroppedEvents)
		}
		for _, e := range b.Events {
			if e.OccurredAt < last {
				t.Fatal("not oldest first")
			}
			last = e.OccurredAt
		}
	}
	if spooled(t, s) != 0 || s.Dropped() != 0 {
		t.Fatalf("left: %d events, %d dropped", spooled(t, s), s.Dropped())
	}
	if out, _ := os.ReadDir(s.outboxDir()); len(out) != 0 {
		t.Fatalf("outbox left: %v", out)
	}
	// with nothing spooled, a batch still carries the integrity report
	res, err = s.Drain(context.Background(), DrainOptions{AgentVersion: "0.0.0-dev", Integrity: integrityFixture(), Send: gw.send})
	if b := gw.batch(t, 3); err != nil || res.Batches != 1 || len(b.Events) != 0 || len(b.Integrity) != 1 || !strings.Contains(string(gw.bodies[3]), `"events":[]`) {
		t.Fatalf("%+v %v %s", res, err, gw.bodies[3])
	}
}

func TestDrainRetryResendsTheSameBatch(t *testing.T) {
	s := New(t.TempDir())
	for i := range 3 {
		_ = s.Emit(decisionEvent(testNow.Add(time.Duration(i) * time.Second)))
	}
	gw := &fakeGateway{answers: []error{errors.New("connection reset")}}
	opts := DrainOptions{AgentVersion: "1", Integrity: integrityFixture(), Send: gw.send}
	if _, err := s.Drain(context.Background(), opts); err == nil {
		t.Fatal("no error")
	}
	// the batch waits in the outbox, its events still spooled; a new event arrives meanwhile
	if out, _ := os.ReadDir(s.outboxDir()); len(out) != 1 || out[0].Name() != gw.ids[0]+".json" || spooled(t, s) != 3 {
		t.Fatalf("outbox: %v", out)
	}
	_ = s.Emit(decisionEvent(testNow.Add(time.Minute)))
	res, err := s.Drain(context.Background(), opts)
	if err != nil || res.Batches != 2 || res.Events != 4 {
		t.Fatalf("%+v %v", res, err)
	}
	if gw.ids[1] != gw.ids[0] || string(gw.bodies[1]) != string(gw.bodies[0]) {
		t.Fatal("the retry did not resend the same batch id and bytes")
	}
	if b := gw.batch(t, 2); len(b.Events) != 1 || gw.ids[2] == gw.ids[0] {
		t.Fatalf("new batch: %+v", b)
	}
	if spooled(t, s) != 0 {
		t.Fatal("events left")
	}
}

func TestDrainRefusedAndGuardedBatchesAreCounted(t *testing.T) {
	s := New(t.TempDir())
	for i := range 4 {
		_ = s.Emit(decisionEvent(testNow.Add(time.Duration(i) * time.Second)))
	}
	gw := &fakeGateway{answers: []error{errors.Join(ErrRefused, errors.New("400 invalid_body"))}}
	res, err := s.Drain(context.Background(), DrainOptions{AgentVersion: "1", Send: gw.send})
	if err != nil || res.Dropped != 4 || res.Batches != 0 || spooled(t, s) != 0 || s.Dropped() != 4 {
		t.Fatalf("%+v %v dropped %d", res, err, s.Dropped())
	}
	// the guard refuses the next body: nothing is sent, and the count carries over
	_ = s.Emit(decisionEvent(testNow))
	refuse := func([]byte) error { return errors.New("names the user") }
	sent := len(gw.bodies)
	res, err = s.Drain(context.Background(), DrainOptions{AgentVersion: "1", Integrity: integrityFixture(), Guard: refuse, Send: gw.send})
	if err != nil || len(gw.bodies) != sent || res.Dropped != 1 || s.Dropped() != 5 {
		t.Fatalf("%+v %v dropped %d", res, err, s.Dropped())
	}
	// the next accepted batch reports every one of them, then the counter is reset
	if _, err := s.Drain(context.Background(), DrainOptions{AgentVersion: "1", Integrity: integrityFixture(), Send: gw.send}); err != nil {
		t.Fatal(err)
	}
	if b := gw.batch(t, len(gw.bodies)-1); b.DroppedEvents != 5 || s.Dropped() != 0 {
		t.Fatalf("reported %d, left %d", b.DroppedEvents, s.Dropped())
	}
}

func TestDrainBoundsAndHousekeeping(t *testing.T) {
	s := New(t.TempDir())
	s.MaxEvents = 5000
	for i := range 1600 {
		_ = s.Emit(decisionEvent(testNow.Add(time.Duration(i) * time.Millisecond)))
	}
	// an unreadable event file is discarded and counted
	os.WriteFile(filepath.Join(s.Dir, newUUID()+".json"), []byte("{"), 0o600)
	// a dropped count whose batch was never written goes back to the counter
	os.WriteFile(filepath.Join(s.outboxDir(), newUUID()+".dropped"), []byte("..."), 0o600)
	gw := &fakeGateway{}
	res, err := s.Drain(context.Background(), DrainOptions{AgentVersion: "1", Send: gw.send, MaxBatches: 2})
	if err != nil || res.Batches != 2 || res.Events != 1000 || res.Dropped != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	if b := gw.batch(t, 0); b.DroppedEvents != 4 {
		t.Fatalf("dropped reported %d", b.DroppedEvents)
	}
	if spooled(t, s) != 600 {
		t.Fatalf("left %d", spooled(t, s))
	}
}

func TestBatchBodyFitsTheGatewayLimit(t *testing.T) {
	ref := strings.Repeat("f", 64)
	mode := "bypassPermissions"
	rule := strings.Repeat("r", 128)
	evs := make([]Event, contract.MaxDecisionEvents)
	for i := range evs {
		evs[i] = NewEvent(enforce.AgentClaudeCode, enforce.Call{Command: &enforce.CommandCall{Shell: "x"}}, enforce.Decision{Verdict: enforce.Deny, Rule: rule}, nil, &ref, testNow)
		evs[i].PermissionMode = &mode
	}
	body, _ := json.Marshal(contract.DecisionBatch{Schema: contract.SchemaDecisions, Events: evs, Integrity: fullIntegrity()})
	if len(body) > 512<<10 {
		t.Fatalf("a full batch is %d bytes", len(body))
	}
}

func fullIntegrity() []contract.IntegrityEntry {
	sum, status := strings.Repeat("c", 64), contract.HookWeakened
	var out []contract.IntegrityEntry
	for _, f := range []string{contract.ManagedFileClaudeCode, contract.ManagedFileCursor, contract.ManagedFileCopilotCLI, contract.ManagedFileCodex} {
		out = append(out, contract.IntegrityEntry{File: f, State: contract.FileStatePresent, SHA256: &sum, HookStatus: &status})
	}
	return out
}

// The seen marker follows the event write: a write that fails leaves no marker, so the session's first event is
// spooled on the next call instead of being lost.
func TestSeenMarkerOnlyAfterTheEventIsWritten(t *testing.T) {
	s := New(t.TempDir())
	ref := s.SessionRef("vendor-session-1")
	bypass := "bypassPermissions"
	ev := sessionEvent(ref, &bypass)
	// a non-empty directory where the event file goes: the rename into place fails
	blocker := filepath.Join(s.Dir, ev.EventID+".json")
	if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := s.Emit(ev); err == nil {
		t.Fatal("the event write did not fail")
	}
	if _, err := os.Lstat(s.seenMarker(ev)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a seen marker was left after a failed write: %v", err)
	}
	if err := os.RemoveAll(blocker); err != nil {
		t.Fatal(err)
	}
	again := sessionEvent(ref, &bypass)
	if err := s.Emit(again); err != nil {
		t.Fatal(err)
	}
	if n := spooled(t, s); n != 1 {
		t.Fatalf("spooled %d, want the session's first event", n)
	}
	if _, err := os.Lstat(s.seenMarker(again)); err != nil {
		t.Fatalf("no seen marker after the write: %v", err)
	}
}

package decisionlog

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/fsutil"
)

// DefaultMaxBatches bounds the batches one Drain sends.
const DefaultMaxBatches = 10

// Housekeeping ages: a temporary file this old was left by a crash; a session marker this old is forgotten (the
// gateway refuses events older than seven days anyway).
const (
	staleTemp   = time.Hour
	staleMarker = 30 * 24 * time.Hour
)

// Sender posts one batch body. It returns nil when the gateway accepted it (a duplicate included), an error wrapping
// ErrRefused when the gateway refused it for good (the batch is dropped and its events counted), and any other error
// when it may succeed later (the batch stays in the outbox and the same bytes are resent).
type Sender func(ctx context.Context, batchID string, body []byte) error

// ErrRefused marks a permanent refusal by the gateway.
var ErrRefused = errors.New("the gateway refused the decision batch")

// DrainOptions is what one Drain needs.
type DrainOptions struct {
	AgentVersion string
	// Integrity is this cycle's managed-file report, sent in the first new batch (a batch goes even with no events).
	Integrity []contract.IntegrityEntry
	// Guard is the pseudonymity guard; a body it refuses is not sent, and its events are counted as dropped.
	Guard func(body []byte) error
	Send  Sender
	// MaxBatches bounds the sends (DefaultMaxBatches when zero).
	MaxBatches int
	Now        func() time.Time
	Log        *slog.Logger
}

// DrainResult is what one Drain did.
type DrainResult struct {
	// Batches sent and accepted; Events in them.
	Batches, Events int
	// Dropped events: refused by the guard or the gateway, or unreadable in the spool.
	Dropped int
}

// Drain sends the spool, oldest first: first the outbox's unaccepted batches with their original bytes, then new
// batches of at most contract.MaxDecisionEvents events, each written to the outbox before it is sent. It stops at the
// first error that may pass, which it returns; the next Drain resumes from the outbox.
func (s *Spool) Drain(ctx context.Context, o DrainOptions) (DrainResult, error) {
	var res DrainResult
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	maxBatches := o.MaxBatches
	if maxBatches <= 0 {
		maxBatches = DefaultMaxBatches
	}
	if err := s.ensure(); err != nil {
		return res, err
	}
	s.housekeep(o.Now())

	sends := 0
	pending, inFlight := s.pending(&res, o.Log)
	for _, p := range pending {
		if sends >= maxBatches {
			return res, nil
		}
		sends++
		if err := s.send(ctx, o, p.id, p.body, p.events, &res); err != nil {
			return res, err
		}
	}
	if len(pending) >= maxBatches {
		return res, nil
	}

	events := s.load(inFlight, &res, o.Log)
	first := true
	for sends < maxBatches && (len(events) > 0 || first && len(o.Integrity) > 0) {
		n := min(len(events), contract.MaxDecisionEvents)
		chunk := append([]Event{}, events[:n]...)
		events = events[n:]
		integrity := []contract.IntegrityEntry{}
		if first && o.Integrity != nil {
			integrity = o.Integrity
		}
		first = false
		id := newUUID()
		dropped, err := s.takeDropped(id)
		if err != nil {
			return res, err
		}
		body, err := json.Marshal(contract.DecisionBatch{
			Schema: contract.SchemaDecisions, BatchID: id, SentAt: o.Now().UTC().Format(time.RFC3339), AgentVersion: o.AgentVersion,
			DroppedEvents: dropped, Events: chunk, Integrity: integrity,
		})
		if err != nil {
			return res, err
		}
		ids := eventIDs(chunk)
		if o.Guard != nil {
			if err := o.Guard(body); err != nil {
				o.Log.Error("decision batch not sent", "err", err, "events", n)
				res.Dropped += n
				s.drop(id, ids, n)
				continue
			}
		}
		if err := fsutil.WriteAtomic(filepath.Join(s.outboxDir(), id+".json"), body, 0o600, -1, true); err != nil {
			s.drop(id, nil, 0) // the events stay spooled; the taken count goes back to the counter
			return res, err
		}
		sends++
		if err := s.send(ctx, o, id, body, ids, &res); err != nil {
			return res, err
		}
	}
	return res, nil
}

func (s *Spool) send(ctx context.Context, o DrainOptions, id string, body []byte, ids []string, res *DrainResult) error {
	err := o.Send(ctx, id, body)
	switch {
	case err == nil:
		res.Batches++
		res.Events += len(ids)
		s.finish(id, ids)
		return nil
	case errors.Is(err, ErrRefused):
		o.Log.Error("decision batch refused by the gateway; its events are counted as dropped", "err", err, "events", len(ids))
		res.Dropped += len(ids)
		s.drop(id, ids, len(ids))
		return nil
	default:
		return err
	}
}

// finish removes an accepted batch: its events, then its dropped count, then the batch itself (so a crash part-way
// leaves a batch that is resent, answered as a duplicate, and finished again).
func (s *Spool) finish(id string, ids []string) {
	for _, e := range ids {
		_ = os.Remove(filepath.Join(s.Dir, e+".json"))
	}
	_ = os.Remove(filepath.Join(s.outboxDir(), id+".dropped"))
	_ = os.Remove(filepath.Join(s.outboxDir(), id+".json"))
}

// drop removes a batch that will never be accepted and counts n of its events, plus the count it carried, as
// dropped.
func (s *Spool) drop(id string, ids []string, n int) {
	carried := filepath.Join(s.outboxDir(), id+".dropped")
	_ = s.addDropped(n + sizeOf(carried))
	for _, e := range ids {
		_ = os.Remove(filepath.Join(s.Dir, e+".json"))
	}
	_ = os.Remove(carried)
	_ = os.Remove(filepath.Join(s.outboxDir(), id+".json"))
}

type pendingBatch struct {
	id     string
	body   []byte
	events []string
	mod    time.Time
}

// pending lists the outbox's batches, oldest first, and the ids of the events they carry. A batch file that does not
// parse is dropped (its events stay spooled and are sent again in a new batch).
func (s *Spool) pending(res *DrainResult, log *slog.Logger) ([]pendingBatch, map[string]bool) {
	inFlight := map[string]bool{}
	entries, _ := os.ReadDir(s.outboxDir())
	var out []pendingBatch
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !uuidV4Shape.MatchString(id) {
			continue
		}
		path := filepath.Join(s.outboxDir(), e.Name())
		body, err := os.ReadFile(path)
		var b contract.DecisionBatch
		if err == nil {
			err = fsutil.StrictJSON(body, &b)
		}
		if err != nil || b.BatchID != id {
			log.Warn("an unreadable decision batch was discarded; its events are sent again", "err", err)
			s.drop(id, nil, 0)
			continue
		}
		info, _ := e.Info()
		p := pendingBatch{id: id, body: body, events: eventIDs(b.Events)}
		if info != nil {
			p.mod = info.ModTime()
		}
		for _, ev := range p.events {
			inFlight[ev] = true
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].mod.Equal(out[j].mod) {
			return out[i].mod.Before(out[j].mod)
		}
		return out[i].id < out[j].id
	})
	return out, inFlight
}

// load reads the spooled events not already in a pending batch, oldest first. An event file that does not parse or
// meet the contract is removed and counted as dropped.
func (s *Spool) load(inFlight map[string]bool, res *DrainResult, log *slog.Logger) []Event {
	names, err := s.eventNames()
	if err != nil {
		log.Warn("the decision spool could not be listed", "err", err)
		return nil
	}
	var out []Event
	bad := 0
	for _, n := range names {
		id := strings.TrimSuffix(n, ".json")
		if inFlight[id] {
			continue
		}
		path := filepath.Join(s.Dir, n)
		b, err := os.ReadFile(path)
		var ev Event
		if err == nil {
			err = fsutil.StrictJSON(b, &ev)
		}
		if err == nil {
			err = Validate(ev)
		}
		if err != nil || ev.EventID != id {
			bad++
			_ = os.Remove(path)
			continue
		}
		out = append(out, ev)
	}
	if bad > 0 {
		log.Warn("unreadable decision events were discarded and counted as dropped", "events", bad)
		res.Dropped += bad
		_ = s.addDropped(bad)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].OccurredAt != out[j].OccurredAt {
			return out[i].OccurredAt < out[j].OccurredAt
		}
		return out[i].EventID < out[j].EventID
	})
	return out
}

// housekeep removes temporary files left by a crash, forgets old session markers, and gives a dropped count whose
// batch was never written back to the counter.
func (s *Spool) housekeep(now time.Time) {
	for _, dir := range []string{s.Dir, s.outboxDir()} {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), ".") || !strings.HasSuffix(e.Name(), ".tmp") {
				continue
			}
			if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > staleTemp {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	entries, _ := os.ReadDir(s.outboxDir())
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".dropped")
		if !ok {
			continue
		}
		if _, err := os.Stat(filepath.Join(s.outboxDir(), id+".json")); errors.Is(err, fs.ErrNotExist) {
			s.drop(id, nil, 0)
		}
	}
	markers, _ := os.ReadDir(s.seenDir())
	for _, e := range markers {
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > staleMarker {
			_ = os.Remove(filepath.Join(s.seenDir(), e.Name()))
		}
	}
}

func eventIDs(evs []Event) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.EventID
	}
	return out
}

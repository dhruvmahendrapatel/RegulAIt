package decisionlog

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Spool bounds. A full spool drops new events and counts them; the count is reported in the next batch.
const (
	DefaultMaxEvents = 10000
	// maxDropped is the most the dropped counter holds (the gateway's bound on droppedEvents).
	maxDropped = 1_000_000
	saltBytes  = 32
)

// Spool is the decision log on the device: one directory per device user (agent.Paths.StateDir/decisions, 0700),
// written by the hook and drained by the agent's run loop, both running as that user. Layout:
//
//	<eventId>.json          one event each, 0600, written to a temporary file and renamed
//	salt                    32 random bytes, the sessionRef HMAC key; never sent
//	seen/<hash>             one marker per (agent, sessionRef, permissionMode) already reported
//	dropped                 the dropped-event counter: one byte per dropped event (appends never race)
//	outbox/<batchId>.json   a batch's exact body, kept until the gateway accepts it, so a retry resends the same
//	                        id and bytes; outbox/<batchId>.dropped is the dropped count that batch reports
//
// The directory belongs to the device user, so it is evidence of what the hook answered, not proof against that
// user: the gateway's audit chain starts when a batch is accepted.
type Spool struct {
	Dir string
	// MaxEvents bounds the spooled events (DefaultMaxEvents when zero).
	MaxEvents int
}

// New is the spool under a user's state directory.
func New(stateDir string) *Spool {
	return &Spool{Dir: filepath.Join(stateDir, "decisions"), MaxEvents: DefaultMaxEvents}
}

// ErrFull is returned by Emit when the spool is full; the event was counted as dropped.
var ErrFull = errors.New("the decision spool is full; the event was counted as dropped")

func (s *Spool) max() int {
	if s.MaxEvents <= 0 {
		return DefaultMaxEvents
	}
	return s.MaxEvents
}

func (s *Spool) seenDir() string   { return filepath.Join(s.Dir, "seen") }
func (s *Spool) outboxDir() string { return filepath.Join(s.Dir, "outbox") }

func (s *Spool) ensure() error {
	for _, d := range []string{s.Dir, s.seenDir(), s.outboxDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// Emit spools one event. A session event is kept only the first time its (agent, sessionRef, permissionMode) is seen;
// a decision event marks it seen too, since it already shows the session in that mode.
func (s *Spool) Emit(ev Event) error {
	if err := Validate(ev); err != nil {
		return err
	}
	if err := s.ensure(); err != nil {
		return err
	}
	if first := s.markSeen(ev); !first && ev.Kind == contract.EventSession {
		return nil
	}
	n, err := s.count()
	if err != nil {
		return err
	}
	if n >= s.max() {
		if err := s.addDropped(1); err != nil {
			return err
		}
		return ErrFull
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	return writeFile(filepath.Join(s.Dir, ev.EventID+".json"), body, false)
}

// markSeen creates the session's marker and reports whether it is new. A marker that cannot be written counts as
// new, so a broken marker directory costs duplicate session events, never a missing one.
func (s *Spool) markSeen(ev Event) bool {
	h := sha256.New()
	for _, part := range []*string{&ev.Agent, ev.SessionRef, ev.PermissionMode} {
		if part == nil {
			h.Write([]byte{0})
		} else {
			h.Write([]byte{1})
			h.Write([]byte(*part))
		}
		h.Write([]byte{0xff})
	}
	f, err := os.OpenFile(filepath.Join(s.seenDir(), hex.EncodeToString(h.Sum(nil))), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return false
	}
	if err == nil {
		_ = f.Close()
	}
	return true
}

// SessionRef is hex(HMAC-SHA256(salt, id)), or nil when id is empty or the salt cannot be had (never the raw id).
func (s *Spool) SessionRef(id string) *string {
	if id == "" {
		return nil
	}
	salt, err := s.salt()
	if err != nil {
		return nil
	}
	m := hmac.New(sha256.New, salt)
	m.Write([]byte(id))
	ref := hex.EncodeToString(m.Sum(nil))
	return &ref
}

// salt reads the spool's salt, creating it once. A new salt is written in full to a temporary file and linked into
// place, so a concurrent hook either links first or reads the winner's complete salt.
func (s *Spool) salt() ([]byte, error) {
	path := filepath.Join(s.Dir, "salt")
	if b, err := os.ReadFile(path); err == nil {
		if len(b) != saltBytes {
			return nil, errors.New("the decision spool salt is malformed")
		}
		return b, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err := s.ensure(); err != nil {
		return nil, err
	}
	b := make([]byte, saltBytes)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	tmp, err := writeTemp(s.Dir, "salt", b, false)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)
	if err := os.Link(tmp, path); err != nil && !errors.Is(err, fs.ErrExist) {
		// no hard links here: a rename can race another hook's, which costs only a few unlinkable session refs
		if err := os.Rename(tmp, path); err != nil {
			return nil, err
		}
	}
	got, err := os.ReadFile(path)
	if err != nil || len(got) != saltBytes {
		return nil, errors.New("the decision spool salt is malformed")
	}
	return got, nil
}

// count is the number of spooled events.
func (s *Spool) count() (int, error) {
	names, err := s.eventNames()
	return len(names), err
}

func (s *Spool) eventNames() ([]string, error) {
	f, err := os.Open(s.Dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []string
	for {
		names, err := f.Readdirnames(1024)
		for _, n := range names {
			if isEventName(n) {
				out = append(out, n)
			}
		}
		if errors.Is(err, io.EOF) || len(names) == 0 {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func isEventName(n string) bool {
	id, ok := strings.CutSuffix(n, ".json")
	return ok && uuidV4Shape.MatchString(id)
}

func (s *Spool) droppedPath() string { return filepath.Join(s.Dir, "dropped") }

// addDropped counts n dropped events: one appended byte each, so concurrent hooks never lose a count.
func (s *Spool) addDropped(n int) error {
	if n <= 0 {
		return nil
	}
	if err := s.ensure(); err != nil {
		return err
	}
	if st, err := os.Stat(s.droppedPath()); err == nil {
		n = min(n, maxDropped-int(st.Size()))
	}
	if n <= 0 {
		return nil
	}
	f, err := os.OpenFile(s.droppedPath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write([]byte(strings.Repeat(".", n)))
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	return werr
}

// Dropped is the count of events dropped since the last batch took the counter.
func (s *Spool) Dropped() int {
	st, err := os.Stat(s.droppedPath())
	if err != nil {
		return 0
	}
	return min(int(st.Size()), maxDropped)
}

// takeDropped moves the counter to the batch, which reports it; later drops start a new counter.
func (s *Spool) takeDropped(batchID string) (int, error) {
	to := filepath.Join(s.outboxDir(), batchID+".dropped")
	if err := os.Rename(s.droppedPath(), to); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	return sizeOf(to), nil
}

func sizeOf(path string) int {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return min(int(st.Size()), maxDropped)
}

// writeFile writes data to path through a temporary file in the same directory, 0600, and renames it into place.
func writeFile(path string, data []byte, sync bool) error {
	tmp, err := writeTemp(filepath.Dir(path), filepath.Base(path), data, sync)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func writeTemp(dir, base string, data []byte, sync bool) (string, error) {
	var r [8]byte
	if _, err := rand.Read(r[:]); err != nil {
		return "", err
	}
	tmp := filepath.Join(dir, "."+base+"."+hex.EncodeToString(r[:])+".tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	_, err = f.Write(data)
	if err == nil && sync {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}

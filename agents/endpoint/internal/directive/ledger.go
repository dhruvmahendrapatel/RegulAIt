package directive

import (
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
)

// Ledger is the replay record: every directive this agent acted on, with its outcome, kept until its notAfter has
// passed (after which the directive itself is refused as expired). The agent package stores it in its private
// state directory.
type Ledger struct {
	Schema  string                 `json:"schema"`
	Entries map[string]LedgerEntry `json:"entries"`
}

// LedgerEntry is one acted-on directive.
type LedgerEntry struct {
	NotAfter time.Time                 `json:"notAfter"`
	Outcome  contract.DirectiveOutcome `json:"outcome"`
}

// LedgerSchema is the ledger file's schema.
const LedgerSchema = "regulait.endpoint-directive-ledger/1"

// maxLedger bounds the ledger: at most MaxDirectivesPerSync a sync, kept for at most MaxValidity.
const maxLedger = 10000

// NewLedger is an empty ledger.
func NewLedger() *Ledger { return &Ledger{Schema: LedgerSchema, Entries: map[string]LedgerEntry{}} }

// Prune drops entries whose directive can no longer verify (past notAfter plus the skew).
func (l *Ledger) Prune(now time.Time) {
	for id, e := range l.Entries {
		if now.After(e.NotAfter.Add(MaxSkew)) {
			delete(l.Entries, id)
		}
	}
}

// Seen returns the recorded outcome of a directive already acted on.
func (l *Ledger) Seen(id string) (contract.DirectiveOutcome, bool) {
	e, ok := l.Entries[id]
	return e.Outcome, ok
}

// Record adds an outcome. It refuses when the ledger is full, so a flood cannot grow it without bound; the
// directive is then not acted on.
func (l *Ledger) Record(d *Directive, o contract.DirectiveOutcome) bool {
	if len(l.Entries) >= maxLedger {
		return false
	}
	l.Entries[d.DirectiveID] = LedgerEntry{NotAfter: d.NotAfter, Outcome: o}
	return true
}

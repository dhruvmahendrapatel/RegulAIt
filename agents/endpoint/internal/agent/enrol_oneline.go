package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"time"
)

// oneLineToken is the enrolment token's shape (the gateway's `rgea_` prefix and 64 hex characters).
var oneLineToken = regexp.MustCompile(`^rgea_[0-9a-f]{64}$`)

// maxTokenInput bounds what Enrol reads from standard input.
const maxTokenInput = 1024

// Enrol is the one-line enrolment (ADR-0360 §5), run as root: `printf '%s\n' '<token>' | sudo regulait-agent enrol`.
// The token is read from in (standard input), never from an argument (an argument is in every user's process list),
// and it is never logged, written to the status file or written to disk. A device that already holds a valid ticket
// keeps it and the token is not spent. Unlike the MDM install step, the caller reports a failure with a non-zero exit.
func Enrol(ctx context.Context, o Options, in io.Reader) RedeemStatus {
	o.defaults()
	st := func(outcome, code, ticketID string) RedeemStatus {
		s := RedeemStatus{Schema: "regulait.endpoint-redeem-status/1", Outcome: outcome, Code: code, TicketID: ticketID, At: o.Now().UTC().Format(time.RFC3339)}
		if b, err := json.MarshalIndent(s, "", "  "); err == nil {
			if err := writeAtomic(o.Paths.StatusFile, append(b, '\n'), 0o644, -1); err != nil {
				o.Log.Error("enrol: could not write the status file", "err", err)
			}
		}
		level := slog.LevelInfo
		if outcome != OutcomeRedeemed && outcome != OutcomeTicketValid {
			level = slog.LevelWarn
		}
		o.Log.Log(ctx, level, "enrol: enrolment ticket", "outcome", outcome, "code", code)
		return s
	}
	cfg, err := LoadConfig(o.Paths.ConfigFile, o.SystemOwner)
	if err != nil {
		o.Log.Warn("enrol", "err", err)
		return st(OutcomeConfigInvalid, "", "")
	}
	if t, err := readTicket(o, cfg); err == nil {
		return st(OutcomeTicketValid, "", t.TicketID)
	}
	line, err := bufio.NewReader(io.LimitReader(in, maxTokenInput)).ReadString('\n')
	if err != nil && err != io.EOF {
		return st(OutcomeTokenFileInvalid, "unreadable", "")
	}
	token := strings.TrimSpace(line)
	if !oneLineToken.MatchString(token) || !validSecret(token) {
		return st(OutcomeTokenFileInvalid, "malformed", "")
	}
	return redeemToken(ctx, o, cfg, token, st)
}

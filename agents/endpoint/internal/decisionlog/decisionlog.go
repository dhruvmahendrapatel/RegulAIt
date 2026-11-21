// Package decisionlog is the endpoint decision audit (ADR-0310 addendum, lane E1): the one path by which an
// on-device rule set records what it answered a coding agent, and the agent's report of each vendor's managed hook
// file (tamper reporting).
//
// Every on-device rule set emits through this package and nothing else: the MCP rules (ADR-0298, ADR-0330), the
// command, file and package rules (ADR-0350, lane E31), and any later one. A rule set names itself in the event's
// decision.emitter; nothing else about the path differs, so there is no second audit path. The hook builds the
// event with NewEvent (or Record) and hands it to an Emitter; in production that is the Spool, a bounded per-user
// directory the agent's run loop drains into signed batches (Spool.Drain, POST /v1/endpoint-agent/decisions).
//
// Privacy: an event carries the agent, the kind of action, the verdict, the policy mode and the deciding rule's id.
// It never carries a tool's arguments, a command, a file path, a prompt, a working directory or the vendor's session
// id: a session is named only by an HMAC of its id under a per-device salt that never leaves the device. The batch
// still passes the pseudonymity guard (internal/privacy) before it is sent.
//
// Recording never changes a decision: the hook ignores every error from it (cmd/regulait-agent).
package decisionlog

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/contract"
	"github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/enforce"
)

// Event is one decision-log event, exactly as it is sent (contract.DecisionEvent).
type Event = contract.DecisionEvent

// Emitter records events. Emit must not block for long and must never panic: it runs inside a coding agent's hook.
type Emitter interface {
	Emit(Event) error
}

// SessionRefs turns a vendor session id into the pseudonymous sessionRef (nil for an empty id).
type SessionRefs interface {
	SessionRef(vendorSessionID string) *string
}

var (
	emitterShape = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	ruleShape    = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	modeShape    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,31}$`)
	hex64        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	uuidV4Shape  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

// modeReported: the agents whose hook input carries a permission mode. The others never claim one.
var modeReported = map[string]bool{enforce.AgentClaudeCode: true, enforce.AgentCodex: true}

// Classify names the rule set that decided a call and the kind of action it was about. A call with neither an MCP
// nor a command part was decided by no rule set; only an unreadable input's deny reaches the log that way.
func Classify(call enforce.Call, d enforce.Decision) (emitter, action string) {
	switch {
	case call.MCP != nil:
		return contract.DecisionEmitterMCP, contract.ActionMCP
	case call.Command != nil:
		switch d.Action {
		case enforce.KindExec:
			return contract.DecisionEmitterCommand, contract.ActionCommand
		case enforce.KindPackage:
			return contract.DecisionEmitterCommand, contract.ActionPackage
		case enforce.KindRead:
			return contract.DecisionEmitterCommand, contract.ActionFileRead
		case enforce.KindWrite:
			return contract.DecisionEmitterCommand, contract.ActionFileWrite
		}
		// unresolved: by what the call is
		c := call.Command
		if c.Shell != "" || c.ShellUnparsable || len(c.Argv) > 0 {
			return contract.DecisionEmitterCommand, contract.ActionCommand
		}
		for _, f := range c.Files {
			if f.Write {
				return contract.DecisionEmitterCommand, contract.ActionFileWrite
			}
		}
		if len(c.Files) > 0 {
			return contract.DecisionEmitterCommand, contract.ActionFileRead
		}
		return contract.DecisionEmitterCommand, contract.ActionOther
	}
	return contract.DecisionEmitterHookInput, contract.ActionOther
}

// DecisionOf is the decision record of one answered call, with d as answered to the agent (after an ask the agent
// cannot show became a deny). policy is nil when none verified. ok is false when the answer is not a decision: a
// plain NoDecision (not ours to decide) is never an event; audit mode's would-deny or would-ask is, as verdict none.
func DecisionOf(call enforce.Call, d enforce.Decision, policy *enforce.Policy) (contract.HookDecision, bool) {
	emitter, action := Classify(call, d)
	return Decision(emitter, action, call.Agent, d, policy)
}

// Decision is DecisionOf for a rule set that names its own emitter and action (a contract.Action* value).
func Decision(emitter, action, agent string, d enforce.Decision, policy *enforce.Policy) (contract.HookDecision, bool) {
	h := contract.HookDecision{Emitter: emitter, Action: action, WouldDeny: d.WouldDeny, WouldAsk: d.WouldAsk}
	switch d.Verdict {
	case enforce.Allow:
		h.Verdict = contract.VerdictAllow
	case enforce.Deny:
		h.Verdict = contract.VerdictDeny
	case enforce.Ask:
		h.Verdict = contract.VerdictAsk
	default:
		if !d.WouldDeny && !d.WouldAsk {
			return contract.HookDecision{}, false
		}
		h.Verdict = contract.VerdictNone
	}
	if h.WouldDeny && h.WouldAsk {
		// never both on the wire; the stricter one stands
		h.WouldAsk = false
	}
	switch {
	case policy == nil:
		h.Mode = contract.DecisionModeNoPolicy
	case policy.ModeFor(agent) == enforce.ModeAudit:
		h.Mode = contract.DecisionModeAudit
	default:
		h.Mode = contract.DecisionModeEnforce
	}
	if ruleShape.MatchString(d.Rule) {
		r := d.Rule
		h.RuleID = &r
	}
	return h, true
}

// NewEvent is the event of one answered hook call: a decision event when DecisionOf says the answer is a decision,
// otherwise a session event (which the Spool keeps only the first time it sees the session in that mode).
// sessionRef comes from SessionRefs; the vendor's id itself never enters an event.
func NewEvent(agent string, call enforce.Call, d enforce.Decision, policy *enforce.Policy, sessionRef *string, now time.Time) Event {
	ev := Event{EventID: newUUID(), OccurredAt: now.UTC().Format(time.RFC3339), Kind: contract.EventSession, Agent: agent, SessionRef: sessionRef}
	if modeReported[agent] && modeShape.MatchString(call.PermissionMode) {
		m := call.PermissionMode
		ev.PermissionMode = &m
	}
	call.Agent = agent
	if h, ok := DecisionOf(call, d, policy); ok {
		ev.Kind, ev.Decision = contract.EventDecision, &h
	}
	return ev
}

// Record builds the event of one answered hook call and emits it.
func Record(em Emitter, refs SessionRefs, agent string, call enforce.Call, d enforce.Decision, policy *enforce.Policy, now time.Time) error {
	var ref *string
	if refs != nil {
		ref = refs.SessionRef(call.SessionID)
	}
	return em.Emit(NewEvent(agent, call, d, policy, ref, now))
}

// Validate checks an event against the wire contract, so nothing the gateway would refuse is spooled or sent.
func Validate(ev Event) error {
	bad := func(what string) error { return fmt.Errorf("decision event: %s", what) }
	if !uuidV4Shape.MatchString(ev.EventID) {
		return bad("eventId")
	}
	if t, err := time.Parse(time.RFC3339, ev.OccurredAt); err != nil || !strings.HasSuffix(ev.OccurredAt, "Z") || strings.Contains(ev.OccurredAt, ".") || t.IsZero() {
		return bad("occurredAt")
	}
	if _, ok := enforce.Lookup(ev.Agent); !ok {
		return bad("agent")
	}
	if ev.SessionRef != nil && !hex64.MatchString(*ev.SessionRef) {
		return bad("sessionRef")
	}
	if ev.PermissionMode != nil && (!modeReported[ev.Agent] || !modeShape.MatchString(*ev.PermissionMode)) {
		return bad("permissionMode")
	}
	switch ev.Kind {
	case contract.EventSession:
		if ev.Decision != nil {
			return bad("a session event carries a decision")
		}
		return nil
	case contract.EventDecision:
	default:
		return bad("kind")
	}
	d := ev.Decision
	if d == nil {
		return bad("a decision event carries no decision")
	}
	if !emitterShape.MatchString(d.Emitter) {
		return bad("emitter")
	}
	switch d.Action {
	case contract.ActionMCP, contract.ActionCommand, contract.ActionFileRead, contract.ActionFileWrite, contract.ActionPackage, contract.ActionOther:
	default:
		return bad("action")
	}
	switch d.Verdict {
	case contract.VerdictAllow, contract.VerdictDeny, contract.VerdictAsk:
	case contract.VerdictNone:
		if !d.WouldDeny && !d.WouldAsk {
			return bad("a none verdict is a would-deny or would-ask")
		}
	default:
		return bad("verdict")
	}
	if d.WouldDeny && d.WouldAsk {
		return bad("wouldDeny and wouldAsk")
	}
	switch d.Mode {
	case contract.DecisionModeAudit, contract.DecisionModeEnforce, contract.DecisionModeNoPolicy:
	default:
		return bad("mode")
	}
	if d.RuleID != nil && !ruleShape.MatchString(*d.RuleID) {
		return bad("ruleId")
	}
	return nil
}

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

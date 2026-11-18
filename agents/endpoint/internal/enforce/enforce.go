// Package enforce is on-device enforcement of on-device enforcement (PENDING §2b P1, ADR-0298).
//
// It decides whether a coding agent's MCP tool call may run on this device, from a signed enforcement policy the
// control plane issues, and answers the agent through its hook contract. There is one decision (Decide): MCP tool
// calls, against an allow-list of MCP server names and definition sources; every other tool call gets no decision
// from us. Each coding agent has an adapter that turns its documented hook input into a Call and the Decision back
// into its documented output: Claude Code (ADR-0298), Cursor, GitHub Copilot CLI and Codex (ADR-0330). What each
// contract can see, and whether it can fail closed, differs; each adapter file records it.
//
// It is OFF by default, twice over: nothing registers the hook (an admin does so through Claude Code managed
// settings), and the compiled policy keyring is empty until the ADR-0195 SD4 signer lands, so no policy verifies.
// A registered hook with no valid policy denies (fail closed): there is no fail-open mode and no local switch that
// widens one. Design reference only, no code: the DefenseClaw comparison (internal/reviews/2026-11-07).
package enforce

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
)

// PolicySchema is the only policy schema this build reads.
// Schema 2 (ADR-0350) adds the required commands section; nothing ever issued schema 1, so it is not read.
const PolicySchema = "regulait.endpoint-enforcement/2"

// Modes. "audit" decides but never blocks; "enforce" blocks. There is no "off": an org that wants it off does not
// register the hook.
const (
	ModeAudit   = "audit"
	ModeEnforce = "enforce"
)

// maxPolicyBytes and maxEventBytes bound what is read before parsing.
const (
	maxPolicyBytes = 256 << 10
	maxEventBytes  = 4 << 20
	maxListEntries = 1000
)

// Keyring maps a policy-signing key id to its pinned Ed25519 public key.
type Keyring map[string]ed25519.PublicKey

// CompiledKeyring is EMPTY on purpose: the control-plane signer is the ADR-0195 SD4 pack signer, which is pending
// (owner-blocked). Until a key is pinned here no policy verifies, so a registered hook denies every MCP call.
var CompiledKeyring = Keyring{}

// Envelope is the signed policy as delivered: the policy JSON bytes, base64, signed with Ed25519 under keyId.
type Envelope struct {
	KeyID     string `json:"keyId"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// Policy is the verified enforcement policy for one device user.
type Policy struct {
	Schema string `json:"schema"`
	// Subject is the pseudonymous user the policy was issued for (the same pseudonym the agent reports under).
	Subject  string    `json:"subject"`
	Mode     string    `json:"mode"`
	IssuedAt time.Time `json:"issuedAt"`
	// NotAfter bounds offline use: past it the policy is stale and the hook denies (the honest offline mode).
	NotAfter time.Time `json:"notAfter"`
	MCP      MCPRules  `json:"mcp"`
	// AgentModes optionally sets the mode for one coding agent (ADR-0330), overriding Mode for that agent only. Keys
	// are adapter names (Adapters); an unknown key or mode is refused. It exists because the agents' hook contracts differ
	// in what they can see: an org may enforce on an agent that names MCP servers and only audit on one that cannot.
	AgentModes map[string]string `json:"agentModes,omitempty"`
	// Commands decides built-in shell, file and package actions (ADR-0350). Required.
	Commands CommandRules `json:"commands"`
	// Device is the pseudonymous device the policy was issued for. It is required when Exceptions is not empty,
	// and an exception applies only on that device.
	Device     string      `json:"device,omitempty"`
	Exceptions []Exception `json:"exceptions,omitempty"`
}

// Coding agents with a hook adapter (ADR-0298 slice 1, ADR-0330).
const (
	AgentClaudeCode = "claude-code"
	AgentCursor     = "cursor"
	AgentCopilotCLI = "copilot-cli"
	AgentCodex      = "codex"
)

// Unattested sources: an agent whose hook input cannot say where an MCP server was defined reports one of these as
// the call's source (Adapter.UnattestedSource). A policy accepts calls from such an agent only by listing its
// unattested source in allowSources, so trusting a server by name alone is an explicit, signed choice per agent,
// never a default.
const (
	SourceCursorUnattested  = "cursor-unattested"
	SourceCopilotUnattested = "copilot-unattested"
	SourceCodexUnattested   = "codex-unattested"
)

// modeFor is the mode that applies to one agent's calls.
func (p *Policy) modeFor(agent string) string {
	if m, ok := p.AgentModes[agent]; ok {
		return m
	}
	return p.Mode
}

// MCPRules: an MCP tool call runs only when its server name is allowed AND its definition source is allowed.
// Deny beats allow.
type MCPRules struct {
	AllowServers []string `json:"allowServers"`
	DenyServers  []string `json:"denyServers"`
	// AllowSources lists Claude Code's mcp_server.source values the org accepts (for example "user", "project",
	// "managed"). A server whose source is missing or not listed is denied, so a same-named server from an
	// unexpected place does not inherit an allowed name.
	AllowSources []string `json:"allowSources"`
}

var (
	keyIDShape  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,63}$`)
	serverShape = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	sourceShape = regexp.MustCompile(`^[a-z][a-z_-]{0,31}$`)
)

// ErrNoPolicy wraps every reason a policy is unusable; the hook then denies.
var ErrNoPolicy = errors.New("no valid enforcement policy")

func refuse(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrNoPolicy, fmt.Sprintf(format, a...))
}

func strictJSON(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

// LoadPolicy reads, verifies and validates a signed policy. now is the device clock.
func LoadPolicy(r io.Reader, keys Keyring, now time.Time) (*Policy, error) {
	raw, err := io.ReadAll(io.LimitReader(r, maxPolicyBytes+1))
	if err != nil {
		return nil, refuse("read: %v", err)
	}
	if len(raw) > maxPolicyBytes {
		return nil, refuse("policy too large")
	}
	payload, err := VerifyEnvelope(raw, keys)
	if err != nil {
		return nil, refuse("%v", err)
	}
	var p Policy
	if err := strictJSON(payload, &p); err != nil {
		return nil, refuse("policy: %v", err)
	}
	if err := p.validate(now); err != nil {
		return nil, err
	}
	return &p, nil
}

func (p *Policy) validate(now time.Time) error {
	if p.Schema != PolicySchema {
		return refuse("schema %q", p.Schema)
	}
	if p.Mode != ModeAudit && p.Mode != ModeEnforce {
		return refuse("mode %q", p.Mode)
	}
	if len(p.AgentModes) > len(Adapters) {
		return refuse("agentModes")
	}
	for a, m := range p.AgentModes {
		if !knownAgent(a) || (m != ModeAudit && m != ModeEnforce) {
			return refuse("agentModes entry %q", a)
		}
	}
	if p.Subject == "" || len(p.Subject) > 128 {
		return refuse("subject")
	}
	if p.IssuedAt.IsZero() || p.NotAfter.IsZero() || !p.NotAfter.After(p.IssuedAt) {
		return refuse("validity window")
	}
	// a policy from the future is refused (allowing five minutes of clock skew), and so is a stale one
	if p.IssuedAt.After(now.Add(5 * time.Minute)) {
		return refuse("issued in the future")
	}
	if !now.Before(p.NotAfter) {
		return refuse("expired at %s", p.NotAfter.UTC().Format(time.RFC3339))
	}
	for _, list := range [][]string{p.MCP.AllowServers, p.MCP.DenyServers} {
		if len(list) > maxListEntries {
			return refuse("server list too long")
		}
		for _, s := range list {
			if !serverShape.MatchString(s) {
				return refuse("server name not well formed")
			}
		}
	}
	if len(p.MCP.AllowSources) > 32 {
		return refuse("source list too long")
	}
	for _, s := range p.MCP.AllowSources {
		if !sourceShape.MatchString(s) {
			return refuse("source not well formed")
		}
	}
	if len(p.Device) > 128 {
		return refuse("device")
	}
	return p.Commands.validate(p)
}

// Call is one tool call an agent asks about, in adapter-neutral form.
type Call struct {
	// Agent is the adapter that parsed the call (an adapter name, set by Adapter.Hook); it selects the policy's per-agent mode.
	Agent string
	Tool  string
	// MCP is set only for MCP tool calls.
	MCP *MCPCall
	// Command is set only for a governed built-in tool call: a shell command, a file read or write (ADR-0350).
	Command *CommandCall
	// NoAsk: the agent cannot show its own confirmation for this call, so an ask is answered as a deny.
	NoAsk bool
}

// MCPCall names the server a tool call goes to and where the agent says the server was defined.
type MCPCall struct {
	Server string
	Source string
	// Tool is the tool's own name on its server, when the hook input shows it (for ADR-0350 §9 action rules).
	Tool string
}

// Verdict is what the hook answers.
type Verdict int

const (
	// NoDecision: not ours to decide (a non-MCP tool); the agent's own permission flow applies.
	NoDecision Verdict = iota
	Allow
	Deny
	// Ask: the agent's own permission prompt asks the user (ADR-0350). Only command decisions ask.
	Ask
)

// Decision is a verdict and the reason shown to the agent.
type Decision struct {
	Verdict Verdict
	Reason  string
	// WouldDeny is set in audit mode when enforce mode would have denied; WouldAsk when it would have asked.
	WouldDeny bool
	WouldAsk  bool
	// Rule is the rule (or default) that decided a command call, for the decision record.
	Rule string
	// NoAsk: the call came on an event that has no ask answer (set by Adapter.HookWith for Render).
	NoAsk bool
}

// Decide is DecideWith with no device environment.
func Decide(policy *Policy, c Call) Decision { return DecideWith(policy, c, HookEnv{}) }

// DecideWith is pure given env. policy is nil when none verified: then every MCP and command call is denied (fail
// closed).
func DecideWith(policy *Policy, c Call, env HookEnv) Decision {
	if c.Command != nil {
		return decideCommandCall(policy, c, env)
	}
	if c.MCP == nil {
		return Decision{Verdict: NoDecision}
	}
	if policy == nil {
		return Decision{Verdict: Deny, Reason: "RegulAIt: no valid enforcement policy on this device, so MCP tool calls are blocked. Ask your administrator."}
	}
	deny, reason := mcpDenied(policy.MCP, *c.MCP)
	if !deny {
		d := Decision{Verdict: Allow, Reason: "RegulAIt: MCP server allowed by policy"}
		// the one-policy action rules for this tool (ADR-0350 §9): the device gives the gateway's answer
		// (no device exception applies: these rules come from the gateway entitlements). A call whose tool name cannot
		// be read may be any action the server's rules name: the strictest of them, and never less than ask.
		{
			var o outcome
			for _, r := range mcpActions(&policy.Commands, c.MCP.Server, c.MCP.Tool) {
				if o.rule == "" || strictness(r.Verdict) > strictness(o.verdict) {
					o = outcome{verdict: r.Verdict, rule: r.ID}
				}
			}
			if o.rule != "" && c.MCP.Tool == "" && o.verdict == RuleAllow {
				o.verdict = RuleAsk
			}
			if o.rule != "" && o.verdict != RuleAllow {
				d = Decision{Verdict: Ask, Rule: o.rule, Reason: "RegulAIt: this MCP tool matches your organisation's action rule " + o.rule + "."}
				if o.verdict == RuleDeny {
					d.Verdict = Deny
				}
				if policy.modeFor(c.Agent) == ModeAudit {
					d.WouldDeny, d.WouldAsk, d.Verdict = d.Verdict == Deny, d.Verdict == Ask, NoDecision
				}
			}
		}
		return d
	}
	if policy.modeFor(c.Agent) == ModeAudit {
		return Decision{Verdict: NoDecision, WouldDeny: true, Reason: reason}
	}
	return Decision{Verdict: Deny, Reason: reason}
}

func mcpDenied(r MCPRules, c MCPCall) (bool, string) {
	if c.Server == "" {
		return true, "RegulAIt: this tool's MCP server cannot be identified from the coding agent's hook input, so it is blocked."
	}
	for _, s := range r.DenyServers {
		if s == c.Server {
			return true, "RegulAIt: this MCP server is blocked by your organisation's policy."
		}
	}
	named := false
	for _, s := range r.AllowServers {
		if s == c.Server {
			named = true
			break
		}
	}
	if !named {
		return true, "RegulAIt: this MCP server is not on your organisation's approved list."
	}
	for _, s := range r.AllowSources {
		if s == c.Source {
			return false, ""
		}
	}
	return true, "RegulAIt: this MCP server is approved, but not when it is defined in this location."
}

func decideCommandCall(policy *Policy, c Call, env HookEnv) Decision {
	if policy == nil {
		return Decision{Verdict: Deny, Rule: "no-policy", Reason: "RegulAIt: no valid enforcement policy on this device, so this command is blocked. Ask your administrator."}
	}
	o := decideCommand(policy, *c.Command, env)
	d := Decision{Rule: o.rule, Reason: o.reason}
	switch o.verdict {
	case RuleAllow:
		d.Verdict = Allow
		return d
	case RuleAsk:
		d.Verdict = Ask
	default:
		d.Verdict = Deny
	}
	if policy.modeFor(c.Agent) == ModeAudit {
		d.WouldDeny, d.WouldAsk = d.Verdict == Deny, d.Verdict == Ask
		d.Verdict = NoDecision
	}
	return d
}

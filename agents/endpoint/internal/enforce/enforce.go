// Package enforce is the first clean-room slice of on-device enforcement (PENDING §2b P1, ADR-0298).
//
// It decides whether a coding agent's MCP tool call may run on this device, from a signed enforcement policy the
// control plane issues, and answers the agent through its hook contract. Slice 1 has one adapter, Claude Code's
// PreToolUse command hook (code.claude.com/docs/en/hooks, checked 2026-11-14), and one decision: MCP tool calls,
// against an allow-list of MCP server names and definition sources. Every other tool call gets no decision from us.
//
// It is OFF by default, twice over: nothing registers the hook (an admin does so through Claude Code managed
// settings), and the compiled policy keyring is empty until the ADR-0195 SD4 signer lands, so no policy verifies.
// A registered hook with no valid policy denies (fail closed): there is no fail-open mode and no local switch that
// widens one. Design reference only, no code: the DefenseClaw comparison (internal/reviews/2026-11-07).
package enforce

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"
)

// PolicySchema is the only policy schema this build reads.
const PolicySchema = "regulait.endpoint-enforcement/1"

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
	var env Envelope
	if err := strictJSON(raw, &env); err != nil {
		return nil, refuse("envelope: %v", err)
	}
	if !keyIDShape.MatchString(env.KeyID) {
		return nil, refuse("key id not well formed")
	}
	key, ok := keys[env.KeyID]
	if !ok || len(key) != ed25519.PublicKeySize {
		return nil, refuse("key %q is not pinned in this build", env.KeyID)
	}
	payload, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		return nil, refuse("payload encoding")
	}
	sig, err := base64.StdEncoding.DecodeString(env.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, refuse("signature encoding")
	}
	if !ed25519.Verify(key, payload, sig) {
		return nil, refuse("signature does not verify")
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
	return nil
}

// Call is one tool call an agent asks about, in adapter-neutral form.
type Call struct {
	Tool string
	// MCP is set only for MCP tool calls.
	MCP *MCPCall
}

// MCPCall names the server a tool call goes to and where the agent says the server was defined.
type MCPCall struct {
	Server string
	Source string
}

// Verdict is what the hook answers.
type Verdict int

const (
	// NoDecision: not ours to decide (a non-MCP tool); the agent's own permission flow applies.
	NoDecision Verdict = iota
	Allow
	Deny
)

// Decision is a verdict and the reason shown to the agent.
type Decision struct {
	Verdict Verdict
	Reason  string
	// WouldDeny is set in audit mode when enforce mode would have denied.
	WouldDeny bool
}

// Decide is pure. policy is nil when none verified: then every MCP call is denied (fail closed).
func Decide(policy *Policy, c Call) Decision {
	if c.MCP == nil {
		return Decision{Verdict: NoDecision}
	}
	if policy == nil {
		return Decision{Verdict: Deny, Reason: "RegulAIt: no valid enforcement policy on this device, so MCP tool calls are blocked. Ask your administrator."}
	}
	deny, reason := mcpDenied(policy.MCP, *c.MCP)
	if !deny {
		return Decision{Verdict: Allow, Reason: "RegulAIt: MCP server allowed by policy"}
	}
	if policy.Mode == ModeAudit {
		return Decision{Verdict: NoDecision, WouldDeny: true, Reason: reason}
	}
	return Decision{Verdict: Deny, Reason: reason}
}

func mcpDenied(r MCPRules, c MCPCall) (bool, string) {
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

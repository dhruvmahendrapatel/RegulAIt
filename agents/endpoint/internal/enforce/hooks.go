package enforce

// The adapter layer (ADR-0330). A coding agent is supported by one Adapter value: data that describes the agent's
// documented hook contract and what that contract can do (Contract, Capabilities), and two thin functions that
// translate the agent's input into a neutral Call and a Decision back into the agent's output. Everything between
// the two, the policy and Decide, is shared and never agent-specific. Adding an agent is one Adapter in Adapters plus
// a versioned fixture directory; the shared tests then hold it to the same rules as every other adapter.

import "io"

// FailMode is what a coding agent does with a call when its hook crashes, errors or times out.
type FailMode string

const (
	// FailClosed: the agent blocks the call, whatever the registration says.
	FailClosed FailMode = "closed"
	// FailClosedIfConfigured: the agent blocks only when the registration sets the vendor's documented switch (the
	// registration this ADR documents always sets it).
	FailClosedIfConfigured FailMode = "closed-if-configured"
	// FailOpen: the call runs. Nothing the hook can do changes that.
	FailOpen FailMode = "open"
)

// ServerIdentity is how the agent's hook input names the MCP server a call goes to.
type ServerIdentity string

const (
	ServerFromField    ServerIdentity = "field"     // a documented input field names the server
	ServerFromToolName ServerIdentity = "tool-name" // only the documented tool-name convention carries it
	ServerNotVisible   ServerIdentity = "none"      // the input cannot identify the server
)

// Capabilities is one row of the per-agent capability matrix: what the agent's hook contract lets enforcement do.
// It is a claim about the vendor's documentation, so it changes only with a new Contract version.
type Capabilities struct {
	// CanBlock: the contract has a documented deny.
	CanBlock bool `json:"canBlock"`
	// MCPServer: how a call's MCP server is identified.
	MCPServer ServerIdentity `json:"mcpServer"`
	// MCPProvenance: the input says where the server was defined (which config file or scope).
	MCPProvenance bool `json:"mcpProvenance"`
	// OnError and OnTimeout: what the agent does when the hook fails.
	OnError   FailMode `json:"onError"`
	OnTimeout FailMode `json:"onTimeout"`
	// ExecForm: the hook can be registered as an argv list, run without a shell.
	ExecForm bool `json:"execForm"`
	// ManagedLocation: the vendor documents an admin location a user cannot override or disable.
	ManagedLocation bool `json:"managedLocation"`
	// Commands is what the contract lets command rules do (ADR-0350).
	Commands CommandCapabilities `json:"commands"`
}

// ActionCoverage is what a hook can do with one kind of built-in action.
type ActionCoverage string

const (
	// CoverAsk: the hook sees the action before it runs and can allow, ask (the agent's own prompt) or deny.
	CoverAsk ActionCoverage = "ask"
	// CoverBlock: the hook sees it and can deny, but cannot ask, so an ask rule is answered as a deny.
	CoverBlock ActionCoverage = "block"
	// CoverNone: the hook cannot see the action before it runs, or cannot tell what it acts on. We decide nothing.
	CoverNone ActionCoverage = "none"
)

// CommandCapabilities is the command row of the capability matrix, one cell per kind of action, with the vendor's
// own limits stated in Notes. Matching is textual on every agent (a guardrail, not containment).
type CommandCapabilities struct {
	Shell     ActionCoverage `json:"shell"`
	FileRead  ActionCoverage `json:"fileRead"`
	FileWrite ActionCoverage `json:"fileWrite"`
	// Packages follows Shell: installs are found on the shell command line.
	Notes []string `json:"notes"`
}

// Coverage grades: what we tell a customer an adapter is (owner decisions 2026-11-15, ADR-0330 §8).
const (
	// CoverageEnforce: the contract names the server and the agent blocks when the hook fails.
	CoverageEnforce = "enforce-grade"
	// CoverageAudit: a deny is reliable, but the contract cannot identify servers or fails open, so the adapter is
	// a guardrail and an audit source, paired with the vendor's own control.
	CoverageAudit = "audit-grade"
)

// Contract identifies the vendor contract an adapter was written and tested against.
type Contract struct {
	// Version names the contract as checked. It is also the fixture directory, testdata/hooks/<agent>/<version>/.
	// A changed contract is a new version with new fixtures; an old version's fixtures are never edited.
	Version string `json:"version"`
	// Event is the hook event the adapter answers.
	Event string `json:"event"`
	// AgentVersions is the agent version range the docs describe, as the docs state it.
	AgentVersions string `json:"agentVersions"`
	// Docs are the first-party pages the contract was checked against.
	Docs []string `json:"docs"`
}

// Adapter is one coding agent's hook adapter.
type Adapter struct {
	Name         string       `json:"name"`
	Contract     Contract     `json:"contract"`
	Capabilities Capabilities `json:"capabilities"`
	// UnattestedSource is the source every call from this agent carries when the contract cannot attest provenance
	// (Capabilities.MCPProvenance false). A policy accepts such calls only by listing it in allowSources.
	UnattestedSource string `json:"unattestedSource,omitempty"`
	// Coverage is the grade presented for this agent (CoverageEnforce or CoverageAudit).
	Coverage string `json:"coverage"`
	// RecommendedMode is the policy mode recommended for this agent (agentModes), audit or enforce.
	RecommendedMode string `json:"recommendedMode"`
	// VendorControl is the vendor's own control recommended alongside the hook, when the hook alone is not enough.
	VendorControl string `json:"vendorControl,omitempty"`

	// Parse reads one hook input. It never decodes tool arguments.
	Parse func(io.Reader) (Call, error) `json:"-"`
	// Render writes a decision in the agent's documented output form. A Deny must block (exit 2 and the agent's
	// deny JSON); anything else must not.
	Render func(Decision) (stdout []byte, stderr string, exit int) `json:"-"`
}

// Hook is HookWith with no device environment.
func (a Adapter) Hook(stdin io.Reader, policy *Policy) (stdout []byte, stderr string, exit int) {
	return a.HookWith(stdin, policy, HookEnv{})
}

// HookWith answers one hook call: parse, decide, render. Unreadable input is a deny. policy is nil when none
// verified. An ask the agent cannot show for this call is a deny (fail closed, ADR-0350 §4).
func (a Adapter) HookWith(stdin io.Reader, policy *Policy, env HookEnv) (stdout []byte, stderr string, exit int) {
	r := a.HookDecide(stdin, policy, env)
	return r.Stdout, r.Stderr, r.Exit
}

// HookResult is one answered hook call: the call as parsed, the decision as answered (after an unshowable ask became
// a deny) and the rendered answer. Parsed is false when the input could not be read (the decision is then a deny).
type HookResult struct {
	Call     Call
	Parsed   bool
	Decision Decision
	Stdout   []byte
	Stderr   string
	Exit     int
}

// RuleUnreadableInput is the rule id of the deny an unreadable hook input gets.
const RuleUnreadableInput = "hook.unreadable-input"

// HookDecide is HookWith returning the call and the decision too, so the decision can be recorded
// (internal/decisionlog). It answers exactly what HookWith answers.
func (a Adapter) HookDecide(stdin io.Reader, policy *Policy, env HookEnv) HookResult {
	r := HookResult{Call: Call{Agent: a.Name}}
	call, err := a.Parse(stdin)
	if err != nil {
		r.Decision = Decision{Verdict: Deny, Reason: unreadable(err), Rule: RuleUnreadableInput}
	} else {
		call.Agent = a.Name
		r.Call, r.Parsed, r.Decision = call, true, a.decide(call, policy, env)
	}
	r.Stdout, r.Stderr, r.Exit = a.Render(r.Decision)
	return r
}

func (a Adapter) decide(call Call, policy *Policy, env HookEnv) Decision {
	if call.MCP != nil && a.UnattestedSource != "" {
		call.MCP.Source = a.UnattestedSource
	}
	d := DecideWith(policy, call, env)
	d.NoAsk = call.NoAsk
	if d.Verdict == Ask && call.NoAsk {
		d.Verdict = Deny
		d.Reason += " This coding agent cannot ask you to confirm it here, so it is blocked."
	}
	return d
}

// Adapters is every supported coding agent, in a fixed order.
var Adapters = []Adapter{claudeCodeAdapter, cursorAdapter, copilotAdapter, codexAdapter}

// Lookup finds an adapter by name.
func Lookup(name string) (Adapter, bool) {
	for _, a := range Adapters {
		if a.Name == name {
			return a, true
		}
	}
	return Adapter{}, false
}

func knownAgent(name string) bool {
	_, ok := Lookup(name)
	return ok
}

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
}

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

	// Parse reads one hook input. It never decodes tool arguments.
	Parse func(io.Reader) (Call, error) `json:"-"`
	// Render writes a decision in the agent's documented output form. A Deny must block (exit 2 and the agent's
	// deny JSON); anything else must not.
	Render func(Decision) (stdout []byte, stderr string, exit int) `json:"-"`
}

// Hook answers one hook call: parse, decide, render. Unreadable input is a deny. policy is nil when none verified.
func (a Adapter) Hook(stdin io.Reader, policy *Policy) (stdout []byte, stderr string, exit int) {
	call, err := a.Parse(stdin)
	if err != nil {
		return a.Render(Decision{Verdict: Deny, Reason: unreadable(err)})
	}
	call.Agent = a.Name
	if call.MCP != nil && a.UnattestedSource != "" {
		call.MCP.Source = a.UnattestedSource
	}
	return a.Render(Decide(policy, call))
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

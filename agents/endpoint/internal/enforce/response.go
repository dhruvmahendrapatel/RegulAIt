package enforce

// ADR-0354 — the graduated, agent-steering response vocabulary, as the endpoint agent sees it.
//
// The declaration lives in the control plane (`@regulait/policy-kernel`, agent-response.ts). This file is its
// mirror: the same seven responses, the same effects and side effects, the same ranks. The golden file
// testdata/responses/v1.json is written from the TypeScript table and read by BOTH test suites, so the gateway and
// this agent cannot disagree about what "correct" or "block session" means.
//
// Nothing here decides yet. Decide (ADR-0298) and the command rules (ADR-0350, lane E31) produce Allow, Ask and
// Deny; a later slice maps a signed policy's graduated response onto Decision once E31's verdict shape has merged,
// so the two lanes never edit the same struct at once. Guidance is static, admin-reviewed text that the control
// plane validated and signed; an adapter renders it only into the agent's documented plain-text fields.

// Response is one graduated response.
type Response string

// The vocabulary, from least to most restrictive (AGENT_RESPONSES).
const (
	ResponseAllow        Response = "allow"
	ResponseAdvise       Response = "advise"
	ResponseAsk          Response = "ask"
	ResponseCorrect      Response = "correct"
	ResponseDeny         Response = "deny"
	ResponseBlockSession Response = "block_session"
	ResponseDisable      Response = "disable"
)

// ResponseOrder is the vocabulary in its declared order.
var ResponseOrder = []Response{
	ResponseAllow, ResponseAdvise, ResponseAsk, ResponseCorrect, ResponseDeny, ResponseBlockSession, ResponseDisable,
}

// PolicyModes are the responses a control-plane policy may name (POLICY_RESPONSES); "allow" is absent because a
// policy never grants.
var PolicyModes = []string{"advise", "require_approval", "correct", "forbid", "block_session", "disable"}

// ResponseSpec is one row of the declared table. JSON names match the golden file exactly.
type ResponseSpec struct {
	Kind        Response `json:"kind"`
	Effect      string   `json:"effect"`
	Guidance    string   `json:"guidance"`
	Alternative string   `json:"alternative"`
	Session     string   `json:"session"`
	Agent       string   `json:"agent"`
	Rank        int      `json:"rank"`
	AuditRuleID string   `json:"auditRuleId"`
}

// ResponseTable is the mirror of AGENT_RESPONSE_TABLE.
var ResponseTable = map[Response]ResponseSpec{
	ResponseAllow:        {ResponseAllow, "allow", "none", "none", "continues", "unchanged", 0, "response-allow"},
	ResponseAdvise:       {ResponseAdvise, "allow", "required", "none", "continues", "unchanged", 0, "response-advise"},
	ResponseAsk:          {ResponseAsk, "require_approval", "none", "none", "continues", "unchanged", 1, "response-ask"},
	ResponseCorrect:      {ResponseCorrect, "deny", "required", "required", "continues", "unchanged", 2, "response-correct"},
	ResponseDeny:         {ResponseDeny, "deny", "none", "none", "continues", "unchanged", 2, "response-deny"},
	ResponseBlockSession: {ResponseBlockSession, "deny", "none", "none", "ends", "unchanged", 3, "response-block-session"},
	ResponseDisable:      {ResponseDisable, "deny", "none", "none", "ends", "quarantine", 4, "response-disable"},
}

// IsRelaxation reports whether moving from one response to another restricts less afterwards.
func IsRelaxation(from, to Response) bool {
	return ResponseTable[to].Rank < ResponseTable[from].Rank
}

# ADR-0354: Graduated, agent-steering responses: advise, correct, block session, disable

- **Status**: Proposed (lane E35, slice 1 built: the vocabulary, Cedar policy modes, advise and correct on the MCP
  path; block session and disable are declared and refused at write time until slice 2 wires their side effects)
- **Date**: 2026-11-17
- **Index**: Graduated, agent-steering responses (advise, correct, block session, disable) on one vocabulary
- **Builds on**: [ADR-0040](0040-abac-policy-as-code.md) (Cedar ABAC), [ADR-0251](0251-one-governed-decision-core.md)
  (one governed decision core), [ADR-0298](0298-on-device-enforcement.md) and
  [ADR-0330](0330-hook-adapters-cursor-copilot-codex.md) (endpoint hook adapters), [ADR-0124](0124-kill-switch-and-safe-modes.md)
  (kill switch and agent halt), [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) (admission scan), ADR-0180 (secure by
  default), ADR-0176 (open source first)
- **Coordinates with**: lane E31 / ADR-0350 (on-device command rules, branch `builder/e31-command-rules`, which adds
  `Ask` to the Go verdict), lane E19 / ADR-0338 (#881, the kill-switch "narrowing only" guard)
- **Source**: owner approval 2026-11-17 of gap 2 in
  [GAP_ANALYSIS_MANIFOLD_2026-11.md](../product/GAP_ANALYSIS_MANIFOLD_2026-11.md). Vendor features are ideas only: no
  competitor proxy is embedded, and the ADR-0251 gateway stays the single decision point.
- **Migration**: pending `abac_agent_responses` (`packages/db/migrations/pending/abac_agent_responses.sql`; numbered at
  merge under ADR-0252)

## Context

Our decision model has three effects: allow, deny and require approval (`DecisionEffect`). A refusal tells the agent
why, in fixed prose, and nothing else. Three responses are missing that an agent-governance buyer expects:

- **advise**: let the call run, and tell the agent the better way for next time;
- **correct**: refuse the call, and give the agent the approved alternative, so it retries the right way instead of
  hunting for a bypass (the gap analysis's example: a GitHub MCP refusal that sends the agent to the `gh` CLI);
- **block session**: refuse, and stop the agent's session on a strong signal;
- **disable**: refuse, and quarantine the agent, narrowing only.

These must be one vocabulary for the gateway (ADR-0251) and the endpoint hook adapters (ADR-0298/0330), every
response must be audited, and steering text must never become an injection channel back into the agent.

## Decision

### 1. A response is not a new effect: it maps onto exactly one effect

`DecisionEffect` is unchanged. A response says what the agent is told and what happens to its session or to the
agent. Every response maps onto one effect, so every existing consumer of `effect` (dispatch, approvals, the audit
writer, metrics) keeps acting correctly on a response it has never heard of.

### 2. The declared table (`packages/policy-kernel/src/agent-response.ts`)

| Response | Effect | Guidance | Alternative | Session | Agent | Rank | Audit rule id |
|---|---|---|---|---|---|---|---|
| allow | allow | none | none | continues | unchanged | 0 | `response-allow` |
| advise | allow | required | none | continues | unchanged | 0 | `response-advise` |
| ask | require_approval | none | none | continues | unchanged | 1 | `response-ask` |
| correct | deny | required | required | continues | unchanged | 2 | `response-correct` |
| deny | deny | none | none | continues | unchanged | 2 | `response-deny` |
| block_session | deny | none | none | ends | unchanged | 3 | `response-block-session` |
| disable | deny | none | none | ends | quarantine | 4 | `response-disable` |

- **Rank** is how much a response restricts. Responses with the same effect and side effects share a rank: moving
  between deny and correct neither widens nor narrows what runs.
- **One vocabulary, two languages.** The Go endpoint agent carries a mirror (`agents/endpoint/internal/enforce/
  response.go`). The golden file `agents/endpoint/internal/enforce/testdata/responses/v1.json` is written from the
  TypeScript table and read by both test suites, so the gateway and the device cannot disagree.
- The response "states" are this one table. A response has no lifecycle of its own; the policy version that names it
  keeps ADR-0040's immutable-version lifecycle, and moving a live policy to a lower rank is a relaxation (section 5).

### 3. Where a response comes from: the Cedar policy's mode (ADR-0040, reused)

A policy's `mode` (until now `forbid` or `require_approval`) admits the graduated responses: `advise`,
`require_approval`, `correct`, `forbid`, `block_session` and `disable`. A policy is still one Cedar `forbid`
statement; the mode says what a match does. ABAC still cannot grant: `allow` is not a mode, a `permit` is refused, and
an `advise` match leaves the call exactly as allowed or denied as it was.

- **Precedence** among matched policies: strictest wins (disable, block_session, forbid, correct, require_approval,
  advise), then by name. A plain forbid beats a correct, so guidance written for one rule is never shown as the answer
  to a refusal another rule made.
- **The resolver** (`resolveAgentResponse`, `withAgentResponse`) attaches a response to the kernel's final decision
  only when the decision's effect equals the response's effect, and (except for advise on an allow) only when the
  decision's rule id is that policy's id. So a response can never change what is enforced: advise never rescues a
  deny, a correct never decorates a default-deny or a rate limit, and missing guidance degrades to the plain response
  of the same effect. A decision no graduated policy touched is byte-identical to before (no `response` member).

### 4. Guidance is static, plain, scanned text (never HTML, never model output)

- Stored on the policy version (`guidance_message`, `guidance_alternative`), written by an admin, reviewed with the
  version, and never built from call arguments or model output.
- Validated by one function, `parseAgentGuidance` (`packages/shared/src/agent-guidance.ts`): one line of printable
  text, NFC-normalised, at most 500 (message) and 300 (alternative) characters; `<` and `>` refused, so it can never
  be rendered as markup; no placeholders (`${…}`, `{{…}}`, `%s`); and the same admission scan as an MCP tool
  description or a skill (`scanAdmissionUnits`, ADR-0097/0175), so injection phrasing, hidden or bidi Unicode,
  exfiltration directives and credentials are refused. The rule that flags text for addressing the model is skipped,
  as for skills, because guidance is by definition addressed to the agent.
- The database repeats the rules: CHECKs bound the length, refuse `<`, `>` and control characters, require a message
  for advise and a message plus alternative for correct, and refuse guidance on every other mode.
- **Surfaces send it as data.** On the MCP path a correct refusal carries the message and alternative in the
  JSON-RPC error message (plain text) and in error data under `regulait.ai/response`; an advise answer keeps the
  upstream result unchanged, adds the guidance under `_meta["regulait.ai/response"]`, and appends one labelled text
  item (`[RegulAIt policy advice] …`) after the upstream content, so it is never mistaken for tool output.

### 5. Correct never widens access, and relaxing is a step-up

- A correct response carries text only: no grant, no consent, no token. The agent's retry is a new call, decided
  afresh by the same core.
- Activating a version whose response ranks lower than the live one (forbid → advise, block_session → forbid) is a
  `settings_relax` step-up bound to the exact change (`abacPolicyId`, from, to, version), and the activation audit row
  records `mode: { from, to }` and `relaxed`. Tightening needs no step-up.
- The default mode stays `forbid`; advise is never the default for anything.

### 6. Every response is audited

Every MCP tool decision row carries `detail.agentResponse` (`agentResponseAuditFacts`): the response kind, its audit
rule id, the policy that chose it (or null for a plain response), and whether it ends the session or quarantines the
agent. Allow and deny rows carry it too, so one history covers all responses.

### 7. Block session and disable (slice 2)

Both are declared in the table and accepted by the kernel and the Cedar engine, but the policy route refuses them
(`422 response_not_yet_enforced`) until their side effects are wired, so no admin ever believes a session is being
ended when it is not. Slice 2 wires them on the proposed secure defaults:

- **disable** reuses ADR-0124's agent halt (`haltAgentInTx`): it can set a halt, never lift one; lifting stays on the
  execution-control route with its own step-up. This is the same narrowing-only rule lane E19 (#881, ADR-0338) encodes
  as `kill_switch_narrowing_only`: under a non-normal dial a narrowing action still applies and a widening one is
  refused. Disable is narrowing by construction, so it applies under every dial.
- **block_session** ends the narrowest session the call belongs to: the orchestration run for a delegated worker
  (pillar 7), and on the device the coding agent's own session through its documented stop field (Claude Code
  `continue: false`). A call with no session (an API key's single request) is refused as a plain deny, recorded with
  `endSession: true` and `sessionEnded: false`.

### 8. The endpoint adapters (slice 3, after E31)

The Go mirror decides nothing yet. ADR-0350 (lane E31) is adding `Ask` and a `Rule` field to the Go `Decision`; to
avoid two lanes editing one struct, slice 3 maps a signed policy's graduated response onto `Decision` after E31
merges, renders guidance only into each agent's documented plain-text fields (Claude Code `permissionDecisionReason`
and `additionalContext`), and adds the decision-record fields E1 needs. E31's device rules and the gateway rules then
share this vocabulary, which is the gap analysis's "one rule, every route" requirement for responses.

## Open-source comparison (ADR-0176, owner rule 9)

| Need | Option A | Option B | Chosen |
|---|---|---|---|
| Where a response is declared | Cedar policy annotations (`@response("correct")`, Apache-2.0 engine we already use) | the existing `mode` column on the policy version | **B**: a typed column gets a DB CHECK and a validated route; an annotation is a free string inside the source and would need a second parser |
| Decision objects with reasons | OPA structured decision documents (Apache-2.0) | the kernel's own decision plus one declared table | **B**: a second policy engine on the decision path is out (ADR-0040 chose Cedar); response semantics are RegulAIt policy semantics (ADR-0176 rule 4) |
| Steering-text safety | DOMPurify / sanitize-html (sanitise HTML into safe HTML) | refuse markup outright, plus the shared admission scan | **B**: we want no HTML at all; refusing `<`/`>` is stricter and smaller, and the admission scan is already ours and reused |
| Agent-side response shapes | Claude Code hook output (`permissionDecision`, `additionalContext`, `continue`), NeMo Guardrails refusal messages (Apache-2.0) | — | design reference only: both confirm the shape (a verdict plus a short message the agent reads); nothing is vendored |

Repo-first search: reused `DecisionEffect` and the kernel decision, Cedar's `mode`, ADR-0040's version/activation
routes, `requireStepUp(settings_relax)`, `scanAdmissionUnits` and `SKILL_SKIPPED_MCP_RULES`, `haltAgentInTx` (slice
2) and the endpoint golden-file pattern (`internal/contract`). No new dependency.

## Consequences

- A policy author can steer an agent instead of only refusing it, without any path that widens access.
- One table defines what each response means in every language and surface.
- New UI: the ABAC policy editor needs the new modes and the guidance fields; the design builder owns screens (#453).
  The `/v1/abac/schema` route already lists the modes.
- Model, connector and A2A refusals (ADR-0251's `governedEvaluateResource`) get the same rendering in slice 2; Cedar v5
  policies already evaluate there, so their modes resolve, but their refusal bodies do not yet carry guidance.

## Owner questions open

None blocking. Slice 2 builds block_session and disable on the secure defaults in section 7.

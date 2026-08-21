# ADR-0091: Toxic-combination segregation of duties at the grant choke point (gap L23)

- **Status**: Accepted
- **Date**: 2026-08-21
- **Driver**: [GAP_ANALYSIS_SAVIYNT_2026-08.md](../product/GAP_ANALYSIS_SAVIYNT_2026-08.md) §L23
- **Migration**: 0093 (`sod_rules`, `sod_override_requests`)

## Context

Saviynt's SoD franchise is preventive + detective rulesets across enterprise applications —
"requester cannot hold A and B" over SAP/Oracle transaction codes, the ERP-audit business.
The gap analysis split L23: replicating cross-application ERP SoD is Saviynt's decades-deep
fight and **stays refused** on the comparison page; what is *ours* is the same control at the
call plane — **combinations of GATEWAY capabilities one identity may not hold together**. The
repo already had SoD as *decision separation* (requester-cannot-approve-own-request,
deploy-handoff, strict-SoD org mode) but nothing could declare that two *grants* conflict:
nothing stopped one user from holding both the payment-initiation MCP tool and the
vendor-master-edit tool, and therefore (per pillar 7's tighten-only inheritance) every agent
run they initiate from holding both.

## Decision

**An admin declares that capability A and capability B are toxic together; from then on no
single identity can *come to hold* both — refused where grants are minted, by name, audited,
overridable only through the real approvals queue.**

### 1. A dedicated table + mint-time check — NOT a new ABAC policy kind

ADR-0040's Cedar layer was the obvious candidate and was rejected deliberately:

- ABAC evaluates **one call** against one attribute context, on the kernel's allow path. SoD
  is a claim about a **pair of grant rows across an identity's whole holding set**, evaluated
  at **mint** time — a different question at a different moment against different data. A
  Cedar policy cannot see "everything this user already holds" without the gateway assembling
  exactly the holdings enumeration this module needs anyway; the policy language would add
  authoring surface without removing any work.
- Keeping SoD out of the kernel keeps ADR-0040's own invariant intact: the kernel remains the
  ONE call-time evaluation path, byte-identical when no SoD rule exists (the check is one
  indexed query on the mint endpoints, which the kernel never touches).
- So: `sod_rules` (migration 0093) + `refuseSodMint` in `apps/gateway/src/sod.ts`, called by
  every grant-creating endpoint. One check function, one refusal shape, no second call-time
  evaluator. Config-versioning (ADR-0048/0074) is **not** wired in and does not need to be:
  the check reads `sod_rules` live at every mint, there is no read-model to diverge from, and
  the only edit surface (enable/disable, delete) therefore changes what is enforced the
  moment it commits — each such edit is an audited act (`sod-rule-enabled/-disabled/-deleted`).
  Rule *content* is immutable after creation: changing a pair is a new rule.

### 2. The rule object — concrete, two-sided, with a required reason

A rule names two selectors, each `kind ∈ {agent, connector, mcp_tool, mcp_server}` + the
concrete object id (mcp_tool sides also carry the tool name; connector sides may carry a
`read|readwrite` mode qualifier, with containment — a readwrite holder satisfies a `read`
side). `reason` is NOT NULL and length-checked in the DB: an SoD rule without a recorded
rationale is cargo cult, and every refusal quotes the reason back. A side cannot equal the
other side (DB CHECK), selectors must reference existing objects (400 `invalid_reference`),
and `created_by_user_id` is SET NULL on user deletion — the rule outlives its author, because
a cascade would silently un-enforce a control when an admin leaves.

### 3. Enforcement at EVERY mint path

`refuseSodMint` gates all nine mint paths — the four direct grants
(`POST /v1/grants/{agents,connectors,tools,servers}`), the four role grants
(`POST /v1/roles/:roleId/grants/*` — checked against **every current assignee**, because an
SoD check that ignored role-derived holdings would be vacuous), and role **assignment**
(`POST /v1/users/:userId/roles` — the role's whole bundle against the assignee's effective
holdings, *including bundle-internal pairs*: a role bundling both sides refuses assignment to
anyone). A grant to a role with **no** assignees is allowed — it confers nothing yet; the
assignment gate is where that conflict lands, and the suite pins exactly that hand-off.

"Holds" means what enforcement means: **direct ∪ role-derived − revocations**, computed
against the same tables the kernel's entitlement loaders read — for agents by importing
ADR-0082/0090's `buildAgentHolderIndex` (the one granted computation), never a parallel
notion of access. An ADR-0019 revocation genuinely *subtracts*: a user whose side-A holding
is revoked may mint side B (pinned in the suite).

A refusal is `409 sod_conflict` naming the rule, its reason, the identity, and the existing
holding that conflicts ("via role 'finance' (connector grant, readwrite)"), audited as
`sod-conflict-refused`, with **no grant row written** (delta-0 pinned).

### 4. Existing violations — visible, never auto-revoked

Creating or enabling a rule whose sides are already co-held **strips nobody**. Silent
revocation by side effect is exactly the kind of magic this project refuses. Instead the
violators are **computed at read time** and surfaced in four places: the rule-creation
response, `GET /v1/sod/rules`, the inventory (`GET /v1/inventory/agents` gains a `sod`
block), and the posture report (rules active / current violations, with "no SoD rule is
defined" stated outright). Resolution is a human act: an ADR-0090 certification campaign or
ordinary revocation. Enforcement is preventive from the moment the rule exists; it is never
retroactive.

### 5. Override through the ONE queue, arm's-length by construction

`POST /v1/sod/overrides` escalates a refused mint. The conflict is **re-computed
server-side** from the stored mint payload — a client cannot assert which rule it is
overriding — and a mint no enabled rule refuses is turned away (`no_sod_conflict`). The
escalation stores the *exact* refused payload, names an approver who is not the requester
(`approver_is_requester` refused at request time), and creates one ordinary `approvals` row
(`objectType='sod_override'`, TS-only widening, the request id in the stageId sentinel — the
ADR-0045/0090 idiom). Decisions ride `decideOneApproval` exclusively:

- **The bar is DECIDER-keyed** (the ADR-0022 lesson): the requester deciding their own
  escalation is refused by name (`cannot_approve_own_sod_override`) even with an
  admin-override reason, so neither delegation nor the admin override can launder a
  self-signed exception.
- **Approval re-checks OTHER rules** (excluding only the overridden one): a second rule that
  began conflicting after escalation refuses the approval — one override lifts one named
  rule, never a blanket.
- **Approval executes the stored mint inside the decision's transaction**, with
  `sodOverride: {ruleId, approvalId}` in the audit detail (`sod-override-minted`) — the
  grant's paper trail says it exists despite a named rule, signed by a named arm's-length
  human. **Denied mints nothing** (delta-0 pinned, `sod-override-denied`).

### 6. Pillar-7 inheritance needs no separate check — verified, not asserted

Workers/lead agents inherit — and never exceed — the *initiating user's* entitlements at
dispatch time (`pillar7-inheritance.test.ts` pins the mechanism, including mid-run
revocation). Agents hold no grant rows of their own, so the only way a worker could hold a
toxic pair is for its user to hold it — which the mint gate makes unreachable. The SoD suite
verifies this from the outside: a run naming the SoD-refused capability for the refused user
is rejected by the same entitlement wall, while the granted side proceeds.

### 7. UI

*SoD rules* under Governance (`/admin/sod`): create-with-reason, enable/disable/delete,
per-rule violator list ("surfaced, never auto-revoked"), the escalation form, and the
override-request ledger. The refusal itself surfaces **verbatim** wherever grants are minted
— the existing grant forms already render the gateway's own `error — detail` sentence, so
`sod_conflict — SoD rule '…' refuses this: …` appears inline with no new plumbing. Posture
gains a *Separation of duties* card. Playwright drives the whole loop in the real SPA:
declare → refused at the real grant form → escalate → arm's-length approve → the grant
exists (asserted against the gateway's grant read) with the override recorded.

## Non-vacuity (M-002)

- **Mint-time check no-op'd** (`refuseSodMint` returns null): **10 tests redden** — every
  direct-path and role-path refusal, the disable-window control, and the pillar-7 probe.
- **Role-assignment path alone unchecked** (the named vacuity trap): **3 tests redden** —
  the empty-role→assignment hand-off, the bundle-internal pair, the role-derived-holding case.
- **Decider-keyed override bar dropped**: **2 tests redden** — the self-sign refusal and the
  arm's-length approval that follows it.

All three probes reverted by exact Edit reversal (M-016).

## Honest limits — stated, not buried

1. **Concrete selectors only.** A side is one id (plus tool name / mode). Pattern or
   category selectors ("any payment-tagged tool") are named follow-up, not smuggled in.
2. **Two-sided rules only.** No N-way toxic sets; model an N-way constraint as pairs.
3. **SoD sees gateway grants, not external access.** A rule cannot know what a user may do
   inside SAP directly — that is the refused ERP half. Our rules bound what crosses *this*
   gateway.
4. **Enforcement is at mint.** A rule created after the fact only *reports* its existing
   violators — it never revokes. The detective loop is ADR-0090's campaigns.
5. **IdP-driven role assignments bypass the gate by design.** SCIM/SAML/group-mapping
   reconciliation (`auth.ts`, `saml.ts`, `group-roles.ts`) writes `role_assignments` without
   the SoD check — refusing there would break a directory sync or a login mid-flight. Those
   acquisitions surface as read-time violations instead. The admin assignment endpoint is
   gated.
6. **MCP holding semantics are grant-level, not call-level.** A `read_only`-scoped MCP
   revocation narrows call kinds but does not remove the holding here; a server-wide
   read-all grant is matched by an `mcp_server` side, not per-tool. The kernel remains the
   only authority on any individual call.
7. **The duplicate-grant edge:** an override approving a mint whose row meanwhile appeared
   records `alreadyExisted` rather than failing — the audit trail stays truthful about what
   the approval actually did.

## Consequences

- Agentic SoD — a real, marketable control no gateway-tier competitor has — exists at the
  only place it can be cheap and airtight: the mint. With zero rules defined, every mint
  path's behavior is byte-identical to pre-0091 (one indexed query).
- The one-queue discipline holds: no second inbox, no second decide path, and the override's
  arm's-length property is structural (decider-keyed), not procedural.
- The comparison page can now say: toxic-combination SoD over gateway capabilities — ours,
  preventive and detective; ERP cross-application SoD — theirs, refused.

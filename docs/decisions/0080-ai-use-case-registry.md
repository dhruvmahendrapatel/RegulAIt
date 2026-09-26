# ADR-0080: An AI use-case registry with an intake front-door, on pillar-2 rails

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: `0086_ai_use_cases.sql` — one table (`ai_use_cases`), three FKs, no columns
  anywhere else.
- **Driver**: [GAP_ANALYSIS_CREDO_AI_2026-08.md](../product/GAP_ANALYSIS_CREDO_AI_2026-08.md)
  gap **L1** — "a pre-build use-case intake and approval front-door", named there as *"the
  highest-leverage Credo-shaped gap … buildable now, on existing rails."*
- **Extends**: [ADR-0018](0018-workflow-engine-slice.md) (the pillar-2 kernel the intake runs
  on), [ADR-0077](0077-cascade-demo-headline-template-gallery.md) (the gallery the intake shape
  joins, and the derive-never-duplicate rule the cascade card copies),
  [ADR-0079](0079-plan-only-stage-enforcement.md) (the resting plan stage the intake uses as its
  refinement step), [ADR-0021](0021-shared-approvals-queue.md)/[ADR-0045](0045-model-risk-management.md)
  (the one approvals queue and the decide-hook pattern the lifecycle join follows).

## Context

Credo AI's governance starts BEFORE anything runs: propose an AI use case, fill an intake
questionnaire, get risks/controls recommended, and approval registers the use case. RegulAIt's
governance started at the first call or the first change workflow — there was no "propose an AI
use case" object, no intake questionnaire, and no approval that *creates* the governed thing.
The gap analysis also noted that our own pillar-2 shape (intake → artifact → sign-off) is
literally this pattern, unshipped.

## Decision

### 1. The object: `ai_use_cases`, whose approval is a decision, never a write

One lean table: name, description, owner, business context, intended agent references, a data
sensitivity level, **compliance tags**, an optional project reference, a status lifecycle
(`proposed → under_review → approved/rejected`, plus `retired`), and a link to the workflow
instance that governs it. The anti-Credo move is in what the compliance tags ARE: **the same
vocabulary the §8.3 cascade enforces** (`compliance_profiles.tag` / `projects.classifications`).
An approved use case is therefore a governance object the enforcement plane can reference — not
a registry entry in a parallel GRC vocabulary.

`approved` and `rejected` are reachable **only** through the linked intake instance's terminal
decision on the one approvals queue. There is no status-writing endpoint: a `PATCH` naming
`status` is refused by name (`status_is_decided_not_patched`, 422, pointing at the decide path),
and retirement is its own audited, admin-only, reason-required endpoint. Decided and retired
statuses are terminal for the sync — an instance event can never resurrect a retired use case.

### 2. The rails: a pillar-2 template, not a parallel intake engine

The intake is a **workflow template** (`ai-use-case-intake`: trigger → `planning` →
`artifact_generation(use_case_questionnaire)` → `human_approval`), published as an ADR-0077
gallery shape so it is discoverable next to every other starting shape. `POST /v1/use-cases`
starts its instance through `startWorkflowInstanceWithTemplates` — the instance-creation tail
**extracted from** `POST /v1/workflows/instances` (retired-template refusal, ordered merge,
attribution, kernel `start`), so there is still exactly one creation path and the route now
calls it too. The instance rests at the ADR-0079 plan stage (where the proposal is refined),
the questionnaire is an ordinary versioned workflow artifact, and the sign-off rides the one
approvals queue with every separation-of-duties guard the decide endpoint already applies —
proven in the test suite by the self-review-reason refusal firing on a proposer-approved intake.

The template resolution is **find-or-create by name**: the newest active template named
`ai-use-case-intake` wins, so an admin can route use-case approvals to a governance owner by
instantiating the gallery shape with a concrete `approverUserId` under that name; only when no
such template exists is the built-in shape minted (through `createWorkflowTemplateValidated`,
the one template-creation path). The default approver is the `requesting_user` placeholder —
i.e. self-review — which the decide endpoint already forces to carry a recorded reason.

### 3. The lifecycle join: the existing decide-hook pattern, plus one options callback

`syncUseCaseForInstance` maps instance status → use-case status (`blocked_on_approval` →
`under_review`; `completed` → `approved`; `denied`/`aborted` → `rejected`; earlier stages →
`proposed`) and is called from two places:

- **the decide path** (app.ts), immediately after `applyWorkflowApprovalDecision`, *inside the
  decision's transaction* — exactly the ADR-0045 `model_card` hook pattern — so "approval
  registers the use case" commits or rolls back with the decision itself;
- **the workflow driving routes** (artifact submit / advance / abort) via a new optional
  `WorkflowRouteOptions.onInstanceTransition` callback wired in app.ts. Dependency injection
  rather than an import, because `use-cases.ts` imports `workflows.ts` for the creation path and
  a reverse import would be a cycle.

Non-vacuity was proven the M-002 way, both halves: no-op the decide-path hook → the approve and
deny e2e tests fail (use case stuck at `under_review`); no-op the transition callback → the
`under_review` and abort tests fail. Both probes reverted by reversing the exact edit.

### 4. The enforcement hook: derived consequences, no new enforcement

The use-case detail surfaces which cascade consequences its tags force — resolved live through
`complianceProfilesForTags` + `effectiveCompliancePolicy`, the exact functions
`requiredTemplateIdsFor` enforces with (ADR-0077's derive-never-duplicate rule; the test proves
it by writing a profile for an invented tag and watching the card change). The card is honest
about *where* enforcement binds: the cascade reads a **project's** classifications, so the card
names which of the use case's tags the linked project actually carries and which it does not.
Tags with no profile are listed as `unrecognizedTags`, never silently dropped.

**Deliberately not built**: no new enforcement. Approval registers intent; the object plugs into
what already enforces via its shared tag vocabulary.

### 5. The questionnaire: a form, honestly

The `artifact_generation` stage's deliverable is a structured markdown questionnaire (purpose,
affected parties, data, models, compliance rationale, risks/mitigations, rollout/oversight,
decommission criteria) served blank by the API and filled by the proposer. **No AI pre-fill — a
GAIA-equivalent is explicitly out of scope**: this deployment holds no model credential, and a
"pre-filled" questionnaire would be mechanism-without-instrument (the ADR-0065/L6 discipline).
The form is the deliverable; the filled form is the versioned artifact the sign-off decides on.

### 6. Surfaces

- Gateway: `POST/GET /v1/use-cases`, `GET/PATCH /v1/use-cases/:id` (owner-or-admin scoped
  in-handler, non-admin route class), `POST /v1/use-cases/:id/retire` (admin, audited). All
  writes audit as objectType `ai_use_case` on the one trail.
- Web: an admin "Use cases" page (governance group) — propose form, status-badged registry,
  detail with the linked workflow's stages/state, the questionnaire (fill-and-submit while the
  instance awaits it), the cascade-consequences card, and retire.

## Honest limits

- **Approval does not yet gate dispatch.** Nothing refuses an agent call for lacking an
  approved use case. That gate — "this project/agent may dispatch only under an approved use
  case" — is the obvious next step and is *named* here rather than silently implied as shipped.
- **No auto-discovery feeds the registry.** Every row was proposed by a person; shadow-AI
  findings (ADR-0071) do not create proposals.
- **The intake instance carries no `projectId`.** The proposal governs itself; the named
  project is a reference the cascade card reads, not an attribution target — so a classified
  project's required templates are not merged into the *intake* workflow. Revisit if a customer
  wants HIPAA-gated intakes.
- **Retiring does not abort a live intake instance**; the instance runs out and the terminal
  guard simply ignores its outcome.
- **No risk register.** Linking a use case to named risks/controls is gap L2, not this ADR.

---

## Amendment (2026-08-22, batch B3a) — approval now gates dispatch, as an org opt-in (migration 0098)

The first honest limit above ("approval does not yet gate dispatch — the obvious next step") is
closed, the only way a gate should arrive in a shipped enforcement plane: **default-off,
byte-identical until an admin acts**.

**The knob**: `org_settings.use_case_gate_mode ∈ off | warn | enforce`, default `off` (set via
the audited `PUT /v1/org/settings`; no new route — the ADR-0021 machinery). Off is proven
byte-identical by test: the exact dispatch that refuses under enforce succeeds with the provider
called, no response annotation, and zero rows under either gate ruleId.

**The join, stated as honestly as the schema allows**: `ai_use_cases.project_id` is the ONLY
join between the register and dispatch attribution, and it is **optional** (a use case may be
proposed before any project exists). So the gate applies exactly **where a link exists**: a
governed dispatch attributed to a project that at least one use case names. A dispatch
attributed to a project no use case links — or attributed to no project at all — is untouched
in every mode. What this enforces is therefore *"a project the register governs does not
dispatch on unapproved intent"* — NOT *"every dispatch runs under an approved use case"*, which
this deployment has no data to enforce and does not claim.

**The mechanics** (`apps/gateway/src/use-case-gate.ts`, called from the ONE dispatch core
beside the ADR-0045 MRM rung — after the caller's entitlement decision, before any provider
work, cost, or content processing, so a refusal costs nothing):

- **enforce**: refused **409 `use_case_approval_required`** (audited `use-case-gate-refused`,
  effect deny, the linked use cases and their statuses in the detail) unless at least one
  linked use case is `approved`. Proven with a recording provider spy at zero calls, and an
  approval through the one decide path flips the same dispatch live in the same test.
- **warn**: the dispatch proceeds; the refusal-shaped fact is recorded — an audit row
  (`use-case-gate-warned`, effect allow) plus a `useCaseGate` annotation on the dispatch
  result — so an operator can see exactly what enforce would refuse before arming it.
- A **retired** use case does not satisfy the gate (its status is no longer `approved`):
  retirement takes the approval out of service for dispatch exactly as for the register.
- Fully reversible: turning the knob off restores dispatch with every registry row intact.

Non-vacuity the M-002 way: no-op the enforce branch → exactly the two enforce-refusal tests
fail; drop the warn annotation → exactly the warn-annotation test fails. Both probes reverted
by reversing the exact edit.

**Still not built**: nothing requires a dispatch to BE attributed to a use-case-linked project
— attribution remains the pillar-5 opt-in it always was, so the gate cannot see a call that
names no project. Closing that would be an attribution-mandate decision (its own ADR), not a
wider join.

## Amendment (2026-08-22, batch B6b) — the attribution mandate closes B3a's own hole (migration 0101)

B3a's last paragraph names exactly one thing it did not build: *"nothing requires a dispatch to
BE attributed to a use-case-linked project — attribution remains the pillar-5 opt-in it always
was, so the gate cannot see a call that names no project."* It also named the shape of the fix —
"an attribution-mandate decision" — and this is it. It lands here rather than in a new ADR
because it is the same knob family on the same rung of the same gate, and splitting it would put
the composition rule in a document that neither knob's reader is holding.

**The knob**: `org_settings.dispatch_attribution_required` (boolean, migration 0101), default
**false** — byte-identical to everything shipped. When **true**, a governed dispatch that names
**no `projectId`** is refused **409 `attribution_required`**, audited (`attribution-required`,
effect deny), before any provider work, cost or content processing — the same placement
discipline as the MRM rung and the use-case gate it sits above.

### The composition, stated because two knobs on one rung invite a precedence question

**There is no precedence rule, by construction.** The attribution gate acts only where
`projectId IS NULL`; the use-case gate's first line returns for exactly that case and it acts
only where `projectId IS NOT NULL`. The two can never see the same dispatch, so all four
combinations are simply the union of two independent behaviours:

| `dispatchAttributionRequired` | `useCaseGateMode` | a dispatch naming NO project | a dispatch attributed to a use-case-linked project with no approved use case |
|---|---|---|---|
| off | off | runs | runs |
| off | enforce | runs — **this is the B3a hole** | 409 `use_case_approval_required` |
| on | off | 409 `attribution_required` | runs |
| on | enforce | 409 `attribution_required` | 409 `use_case_approval_required` |

All four cells are a committed test, each asserting both kinds of dispatch and the provider
spy's call count. Mandating attribution **without** the use-case gate is a legitimate posture on
its own — chargeback completeness — which is why this is a separate knob and not a fourth mode
of the other one.

### Blast radius, named honestly rather than described as "dispatch"

The gate sits inside `dispatchAttempt`, the one governed model-dispatch core, so it binds every
caller of that core. Which of those actually become refusable depends on whether the path
carries a `projectId` at all:

| Path | Carries a projectId? | What an ON knob does to it |
|---|---|---|
| `POST /v1/agents/:id/invoke` | optional (`body.projectId`) | a call omitting it is refused 409 — the headline case |
| conversations (the same invoke, `conversationId`) | the conversation's own project | refusable only for a conversation created without one |
| compat shims (`compat-core.ts`) | `x-regulait-project-id` header | refusable — **but see below**: these already have their own edge guard |
| orchestration worker nodes | the run's project | refusable for a run planned without one |
| `POST /v1/runs/decompose` (the lead turn) | `body.projectId` | refused, surfaced as the route's own error passthrough |
| the compaction summarizer | the conversation's project | refused → compaction **fails open** (audited, the turn proceeds on the full history), or 502 under `fail_closed` |
| the copilot narrator | `body.projectId` | refused → the narration is **discarded and the grounded, count-derived answer stands** (the existing `narrationFailed` path); the copilot does not break |
| evals / judges, red-team runner, recommendation judge | their run's project | refusable where the run named none |
| **the MCP proxy's tool calls** | yes, but **not a model dispatch** | **untouched** — MCP has its own `interception_settings.require_mcp_attribution` (ADR-0024 O11, 400 `mcp_attribution_required`) |

Two pre-existing attribution mandates already covered *their own edges* and are neither replaced
nor duplicated: **`interception_settings.require_project_attribution`** (ADR-0020) refuses a
header-less compat call **400 `project_attribution_required`** at the compat edge, upstream of
this gate; and **`require_mcp_attribution`** does the same for MCP tool calls. Neither reaches
the native governed dispatch, which is precisely the surface this knob covers. A deployment that
wants attribution everywhere sets all three; they are independent switches with three distinct
error names, and that is deliberate — an operator reading a refusal should be able to tell which
control fired.

### Surfaced

Settings → Organization, card **5b2 · Project attribution mandate**, beside the 5b use-case gate,
with plain-language help that states the default, what the refusal looks like, why it pairs with
the use-case gate, that the two are independent, and that the compat/MCP knobs live elsewhere and
are not replaced. No new route (`PUT /v1/org/settings` is a partial update), so the OpenAPI
registry is unchanged.

### Verified (`attribution-gate.test.ts`, 8 cases; non-vacuous per M-002, probes reverted by exact Edit reversal per M-016)

- Ships off (the settings read reports `false`).
- Default-off byte-identical: the **exact** projectless dispatch that refuses when on returns
  200, reaches the provider (spy = 1 call), and writes **zero** rows under the gate's ruleId — a
  delta, M-008.
- On → **409 `attribution_required`** with the provider spy at **zero** calls for that attempt,
  one new audited deny whose detail records `projectId: null`.
- On + attributed → 200, provider called, and **zero** gate rows: the mandate never looks at an
  attributed call.
- The four-combination matrix above, in full.

| Probe (the fix removed) | Reddens |
|---|---|
| the refusal no-oped (`return null` after the knob read, so the knob is read and ignored) | **3** — the 409 case and the two `on/*` matrix cells. The default-off tests and both `off/*` cells stay green: they are the controls |
| the knob ignored the other way (the gate refuses regardless of the setting) | **3** — the default-off byte-identical test and both `off/*` cells, which is what proves the default-off claim is not vacuous |
| — in both probes `use-case-gate.test.ts` stays **fully green**, which is the independence claim measured rather than asserted |  |

### Honest limits (this amendment)

- **B3a's "still not built" paragraph is superseded** for the attribution half. What the pair
  now enforces is "no unattributed governed dispatch, and no dispatch on unapproved registered
  intent" — still **not** "every dispatch runs under an approved use case", because a project
  that no use case links remains untouched in every mode. That limit is ADR-0080's honest join
  and this knob does not change it.
- The gate refuses a **missing** project, not a **wrong** one. Choosing a project you belong to
  in order to charge someone else's budget is an attribution-quality problem, not one a boolean
  can see; `assertProjectAttribution` already bounds it to projects the caller may use.
- **Turning it on can break in-flight automation** that has never sent a project — deliberately,
  since that is the point — and the paths above degrade differently (a refusal, a fail-open, a
  discarded narration). Read the table before flipping it on a live deployment.
- No backfill: historical unattributed usage rows stay unattributed. The knob is a gate, not a
  repair.

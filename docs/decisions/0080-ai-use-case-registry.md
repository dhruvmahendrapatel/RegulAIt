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

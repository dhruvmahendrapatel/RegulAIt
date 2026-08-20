# ADR-0089: Agent ownership, lifecycle, and intended-vs-granted alignment — identity-lifecycle governance at the call plane

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: 0091 (`owner_user_id` nullable FK + CHECK-constrained `lifecycle_status`/
  `lifecycle_reason`/`lifecycle_changed_at` on `agents`). Everything else — the orphan flag, the
  posture coverage, all three alignment flags — is computed at read time in the ADR-0082
  discipline: no stored flag, no rollup, no denormalization anywhere an admin could set.
- **Driver**: [GAP_ANALYSIS_SAVIYNT_2026-08.md](../product/GAP_ANALYSIS_SAVIYNT_2026-08.md) gaps
  **L20** (*"the `agents` registry row has no `ownerUserId`, no lifecycle status beyond an
  `enabled` boolean, and no decommissioned state … nothing detects the orphan case"*) and **L21**
  (*"both halves exist but the comparison does not … no view answers intended vs granted"*).
- **Extends**: [ADR-0082](0082-inventory-and-posture.md) (both flags land on its inventory and
  posture surfaces, same read-time aggregation rule), [ADR-0080](0080-ai-use-case-registry.md)
  (`intendedAgentIds` is the intent half of L21), [ADR-0045](0045-model-risk-management.md) (the
  dispatch-gate idiom the retired refusal copies), [ADR-0022](0022-identity-lifecycle-approver-visibility.md)/
  [ADR-0037](0037-scim-provisioning.md) (`users.disabled_at` — deactivate-never-delete — is the
  state the orphan flag reads; SCIM deprovisioning writes it).

## Context

Saviynt governs who an agent IS: registered ownership, a lifecycle from registration to
decommissioning, and registration-time intent-vs-permission mapping are the accountability spine
of their AI story. The two deltas that are genuinely ours to close at the call plane: our agents
had no owner and no lifecycle state (ownership existed only indirectly through use cases), and
nothing compared a use case's approved intended agents against what its participants may actually
invoke — even though ADR-0080 stores the intent and ADR-0082 computes the grants. This is
identity-lifecycle governance done where we enforce (the gateway), not fabric IGA: no
cross-application identity plumbing, no connectors into HR systems, no certification campaigns.

## Decision

### 1. L20 — ownership and lifecycle on the agent row (migration 0091)

- **`owner_user_id` is nullable, and null is honest.** Every existing agent has no owner;
  inventing one (first admin? creator?) would forge an accountability record. The ADR-0082
  inventory renders null as an explicit `ownership: "unowned"` flag — a warning, never a default
  and never a blank. FK `ON DELETE SET NULL` (users are deactivated, never deleted; the FK path
  is exceptional cleanup and an agent must survive it as unowned).
- **`lifecycle_status` is a closed vocabulary** (`active | deprecated | retired`, DB CHECK), with
  `lifecycle_reason` required exactly for the non-active states (a second CHECK pins
  `(status='active') = (reason IS NULL)`) and `lifecycle_changed_at` alongside.
- **Retired refuses dispatch; deprecated only warns.** The recorded decision: a retired agent's
  **grants still evaluate** — nothing deletes or bypasses entitlement rows, every caller still
  runs `evaluateAgent` — and the refusal is a lifecycle gate layered after them in the ONE
  dispatch core (`dispatchAttempt`), before any provider work, cost, or content processing: a
  named **409 `agent_retired`**, audited (`agent-retired-dispatch-refused`) with the lifecycle
  reason — the exact ADR-0045 gate shape. Keeping the grants intact keeps the entitlement
  history readable and the retirement reversible as a *record*, never as a dispatch. Because the
  gate sits in the shared core, direct invokes, orchestration workers, fallback hops and both
  compat shims inherit it — a retired fallback hop refuses through the same gate and the chain
  moves on. `deprecated` deliberately appears nowhere in the dispatch path: it is a migration
  signal the inventory and posture WARN about, not a control.
- **Retired is terminal for governance purposes.** Transitions out of `retired` are refused by
  name (`agent_retired_terminal`) — the decommissioning record cannot be flipped back;
  re-registering is a new agent. (Mirrors the ADR-0080 retire-is-terminal discipline.)
- **Endpoints**: `POST /v1/agents/:agentId/owner` (set/clear; validates the user exists and is
  active — assigning to a deactivated account would mint an orphan, refused 409
  `owner_deactivated`) and `POST /v1/agents/:agentId/lifecycle` (reason-required 422 by name for
  non-active targets). Both admin-only via the default gate, both audited acts — never silent
  PATCH writes. Tagged internal in the ADR-0053 registry.

### 2. L20 — the orphan signal, computed at read time

The ADR-0082 inventory (list and detail) renders `ownership: "owned" | "unowned" | "orphaned"`:
`orphaned` means the recorded owner's user row carries `disabled_at` — the ADR-0022 state that
SCIM deprovisioning (ADR-0037) writes. ONE shared computation (`ownershipFlagFor`) is used by
the inventory and by the posture page so the two surfaces can never disagree. The posture
one-pager gains an **agent-ownership coverage section** (owned/unowned/orphaned + lifecycle
counts) — every count a SELECT at request time, "unowned" an explicit figure, "unmeasured"
never implied.

### 3. L21 — intended vs granted, three flags, never blended with traffic

For every **APPROVED** use case naming intended agents, the participants are the proposing owner
plus the linked project's members; an intended agent is *provisioned* when at least one
participant is among the agent's effective grant-holders — the SAME granted computation ADR-0082
already runs (direct ∪ role-derived − revocations, `buildAgentHolderIndex`), **imported, never
reimplemented**. Three read-time flags on the inventory (list + detail):

- **`aligned`** — every approved use case naming this agent has a provisioned path;
- **`undershoot`** — some approved intent has no granted path among its participants (a
  provisioning gap, with the gap list naming the use cases — the worklist);
- **`overreach`** — the agent is granted yet named by NO approved use case (the Saviynt
  "over-privilege" story told with our own objects). A *proposed* use case clears nothing:
  unapproved intent is not intent the register stands behind.

The use-case detail carries the same comparison from the use case's side (`intendedVsGranted`):
per intended agent, is it provisioned to the participants — `aligned`/`undershoot` per use case,
`not_approved` for undecided/rejected/retired rows, and `no_intent_recorded` for an approved use
case naming no agents (the honest boundary: **no intent-capture flow was added in this slice**;
where the data does not exist the payload says so rather than guessing).

**The never-blend rule, extended to a third block**: granted is what the entitlement rows say
MAY happen; observed is what the run history says DID happen; alignment is grants vs APPROVED
INTENT — never a claim about observed traffic. Each block carries its note on the payload, and
grant rows count regardless of a holder's active state (a deactivated owner surfaces through the
ownership flag, not through alignment).

### 4. Registry, SPA and tests

Both new routes tagged in the ADR-0053 registry (internal, `agents`). SPA: the ADR-0082
inventory page gains "Owner / lifecycle" and "Intent alignment" columns plus two detail cards
with the notes rendered; the posture page gains the "Agent ownership" card. A read-only
Playwright spec (`zz-` prefixed, order-independent sign-in) pins that "no owner recorded"
renders as a badge and the notes survive to the DOM.

Non-vacuity, proven the M-002 way (each probe reverted by reversing the exact edit):
- no-op the retired-dispatch gate (`if (false && …)`) → exactly the retired-refuses-dispatch
  test fails (deprecated control still green);
- constant-ify the alignment computation (always-aligned) → exactly the undershoot, overreach,
  and neither-flag tests fail;
- no-op the orphan branch (`ownershipFlagFor` returns owned) → exactly the orphan-flip test and
  the posture coverage delta test fail.

The suite also carries the two blend-controls: a NON-participant's grant must not provision an
approved intent, and a PROPOSED use case must not clear overreach.

## Honest limits

- **Ownership is a governance record, not authentication.** Nothing about who may invoke an
  agent changes when its owner changes; the flag changes what the inventory and posture SAY
  about accountability.
- **Orphan detection sees only this deployment's user rows.** An owner who left the company but
  was never deactivated here (no SCIM, no manual deactivate) reads as `owned` — the flag is a
  floor over recorded state, not an HR feed.
- **Alignment compares grants to approved intent, never to traffic.** An `aligned` agent may be
  unused and an `overreach` agent may be legitimately mid-registration; the observed block (and
  only it) says what actually ran. `overreach` is deliberately coarse — *any* grant on an agent
  no approved use case intends — because use cases name participants only as owner + project
  members, and claiming per-holder precision beyond that model would overstate the data.
- **Approved intent is read from register rows, not re-adjudicated.** The comparison trusts
  `status='approved'` as ADR-0080 wrote it; it does not replay the decision.
- **Retirement does not touch the registry row's grants, fallback chains, or routing tables.**
  Pillar-6 routing may still select a retired agent and be refused by the gate — an audible 409,
  never a silent substitution.
- **No certification campaigns yet.** Periodic owner-driven review of grants with
  attest/revoke/auto-revoke is L22, next in the queue — this ADR ships the ownership spine those
  campaigns need, not the campaigns.

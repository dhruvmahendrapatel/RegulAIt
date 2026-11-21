# ADR-0366: Rogue-agent containment (OWASP Agentic ASI10): halt an agent that acts outside its declared role

- **Status**: Accepted (lane E52 brief, owner decision D-2026-11-21-01 via the master; slice 1 built)
- **Date**: 2026-11-21
- **Index**: **Rogue-agent containment (OWASP ASI10), slice 1: a containment signal interface, an admin-set severity
  threshold ('critical' by default) above which the agent is halted at once through ADR-0124's halt, a proposal in
  the one Approvals Queue below it, an admin-only audited release with a step-up, and builder agents gaining their own
  halt.**
- **Backlog item**: `internal/fragments/2026-11-20-master-agentic-governance-gaps-pending.md` ("New: rogue-agent
  containment", #1123)
- **Built in**: lane E52, branch `builder/e52-rogue-containment` (slice 1)
- **Migration**: `pending/rogue_agent_containment.sql`, numbered at merge (ADR-0252)
- **Related**: ADR-0124 (kill switch and safe modes), ADR-0157 (governance monitor), ADR-0159 and ADR-0182 S5
  (remediation and the suggested halt), ADR-0180 (secure by default; A8 autonomy classes), ADR-0223 (classical-model
  drift), ADR-0234 (row-level security), ADR-0338 §7 (the kill-switch narrowing-only guard), ADR-0348 (declared state
  machines), ADR-0176 (open source first), ADR-0200 (3NF, security checklist), ADR-0252 (merge-time numbering).
  Behaviour baselines are lane E40, open PR #966 (cited by PR and lane, not by its ADR number, while it is unmerged).

## Context

OWASP's Top 10 for Agentic Applications names ASI10, rogue agents: an agent that, through compromise, drift or
misconfiguration, acts outside the role it was approved for. The product already *detects* several forms of that:

- `autonomy_declared_below_observed` (ADR-0180 A8, `apps/gateway/src/autonomy.ts`): a builder agent observed acting
  at a higher autonomy class (schedules, inbound channels, unasked write tools, computer use) than its steward
  declared;
- `classical_model_drift` (ADR-0223, `classical-drift-monitor.ts`): a model card, possibly bound to a registry agent,
  drifted past an alert threshold;
- `unregistered_ai_traffic` (`governance-monitor.ts`): AI traffic attributed to no approved use case.

Each of these raises a governance alert (notify only). The ADR-0124 machinery can stop an agent (`haltAgentInTx`,
reused by incident containment and ADR-0182 S5's approved halt proposal), but nothing connects a detection to a halt,
and ADR-0182 S5 deliberately said "nothing ever trips on its own" for KRI-suggested halts. The owner's new direction
for this lane (D-2026-11-21-01) is: notify plus a containment proposal by default, and an automatic halt only at or
above an admin-set severity, on by default for critical findings, every automatic action audited and reversible by an
admin. That is a new, narrower path; it does not change ADR-0182 S5's KRI halt, which still files only on a click.

Two facts shape slice 1:

- **Builder agents had no halt.** A builder agent (`builder_agents`) binds to a registry model agent
  (`model_agent_id`) that many builder agents share. Halting that registry agent would stop every builder agent on the
  same model, so a builder agent needs its own halt.
- **The monitor's severity scale stops at `high`.** "Critical" has to come from the signal adapter, which knows what
  the finding means (an agent declared `assist`, a person on every step, seen acting `autonomous` is critical; a
  one-class gap is the monitor's `medium`).

## Options compared (ADR-0176, owner build rules 2026-11-17)

The problem is "a detection at or above a level triggers an automatic, reversible response; below it, a person
decides". Two mature open-source responders solve it for hosts and clusters:

| | Falco Talon (falcosecurity) | Wazuh active response | Build on ADR-0124 + the Approvals Queue |
|---|---|---|---|
| Licence | Apache-2.0 | GPL-2.0 (excluded from shipped code by ADR-0176) | ours |
| Maintenance | active, incubating in the Falco organisation | active | n/a |
| Trigger model | rules match Falco events by rule name, priority and tags; each rule runs "actionners" | `level` threshold per response, optional `timeout` that reverts the action (stateful response) | severity threshold per org; proposal below it |
| What it acts on | Kubernetes objects (terminate or label a pod, network policy, exec a script) | hosts (firewall drop, disable account, script) | our agent registry and builder agents |
| Fit | a separate Go service over Falco's event stream; no notion of our agents, approvals or audit chain | a manager and agents on hosts; no notion of our agents | the halt, step-up, audit, row-level security and queue already exist and are reviewed |

**Decision: build on ADR-0124's halt and the one Approvals Queue, adopting the trigger model both responders share.**
Neither is a library this process can call: both are separate daemons that act on infrastructure, and our action is a
governance decision on our own registry, which is the part the owner's rule says we write ourselves. What we take
from them: a severity threshold selects the automatic response (Talon's priority matching, Wazuh's `level`); below it
the event is only a notification; an automatic response is reversible. Wazuh's automatic *timeout* revert is
deliberately **not** adopted: a containment ends only when an administrator releases it (owner direction "reversible
by an admin"; an automatic un-halt would widen access with no person deciding).

## Decision

### 1. The signal interface (`packages/shared/src/rogue-containment.ts`)

A `ContainmentSignal` is `{ source: { kind, ruleId, refId }, subject: { kind: agent | builder_agent, id }, severity:
low | medium | high | critical, explanation, evidence }`. `source.kind` is `monitor` in slice 1; `behaviour_baseline`
is reserved so lane E40's explainable findings (open PR #966) plug in by producing the same shape and calling the
same `fileContainment`, with no schema change (the producing record is `signal_ref_id`, FK-free on purpose).

Slice 1's adapter, `containmentSignalFromAlert`, maps:

- `autonomy_declared_below_observed` → the builder agent; severity from the class gap: one class `medium`, two `high`,
  `assist` declared and `autonomous` observed `critical`;
- `classical_model_drift` → the registry agent its card is bound to (no agent = no signal); the monitor's `high`;
- `unregistered_ai_traffic` → **no signal**: its subject is a project, a virtual key or a user, never an agent.
  Containing a key or a project is a later slice.

### 2. The decision and the policy

`decideContainmentAction(severity, threshold)`: `auto_contain` when the severity is at or above the threshold,
otherwise `propose`. The threshold is `org_settings.containment_auto_severity` (`off`, `low` … `critical`), default
**`critical`** (ADR-0180). A lower threshold contains more and is a tightening; raising it, or `off`, is a relaxation:
a `settings_relax` step-up through the one strictness registry, named in the audit row. The proposal approver is
`org_settings.containment_approver_user_id`, which must be an active administrator (validated on write).

### 3. Filing (`apps/gateway/src/rogue-containment.ts`)

`applyMonitorFindings` calls `containRaisedAlerts` for the episodes a pass newly raised, before chat notifications,
under the `system_task` RLS reason (the platform acts, whoever's request ran the pass). A failure never fails the pass
and is audited (`containment-failed`). One row per signal (unique `(signal_source, signal_ref_id)`), so a concurrent
pass files nothing twice.

- **Automatic**: the row is created `contained`, the agent is halted in the same transaction (`haltAgentInTx`, or
  `haltBuilderAgentInTx` for a builder agent), with a reason prefixed `contained (ADR-0366): `, audited
  `containment-auto-contained` with the severity and the threshold in force.
- **Proposal**: the row is created `proposed` with an `approvals` row (objectType `agent_containment`, stageId
  `agent-containment:<id>`) for the named administrator; the approval's requester is the agent's steward, the person
  whose work it gates. Audited `containment-proposed`. **Unrouted** (no approval row, audited
  `containment-proposal-unrouted`) when no approver is named, the approver is no longer an active admin, the agent has
  no steward, or the approver is the steward. The alert still notifies, and automatic containment does not depend on
  an approver.

### 4. Deciding a proposal (the one decide path)

`precheckContainmentDecision`: only an active administrator decides, never the agent's steward
(`cannot_decide_own_agent_containment`), and the subject must still exist. `applyContainmentDecision`, inside the
decision's transaction: approved halts the agent through the same halt and moves `proposed → contained`; denied
moves `proposed → declined` and the agent keeps running.

### 5. Release (admin only)

`POST /v1/containments/:id/release` with a reason (at least ten characters) and a `settings_relax` step-up bound to the
containment. A release widens access, so it is refused while the execution dial is not `normal` (ADR-0338 §7's shared
`killSwitchNarrowingOnly`). It lifts the halt **only** when the current halt was set by a containment (the prefix)
**and** no other `contained` row holds the same agent; otherwise the halt stays and the audit row says why. A halt a
person threw by hand is never lifted by a release.

### 6. Enforcement of a builder agent's halt

`withAgentGate` (the one gate every builder turn passes: chat, schedule, inbound message, resume) reads the halt
fresh and refuses with `builder_agent_halted`, audited `builder-agent-halted-refused`.

### 7. The lifecycle (ADR-0348)

`CONTAINMENT_MACHINE` (`agent_containments.status`): initial `proposed` or `contained`; `approve` and `decline` from
`proposed` (by an approver); `release` from `contained` (by an admin); `declined` and `released` terminal. Every UPDATE
is guarded by `sourcesOf(event)`; `GET /v1/containments/:id` returns `describe(state)`.

### 8. Data (third normal form, forced row-level security)

`agent_containments` holds the subject (exactly one of `agent_id` / `builder_agent_id`, CHECK), the signal, the
severity and the threshold in force, `automatic`, the status, the approval, whether this containment set the halt,
and who decided and released it. `explanation` and `evidence` are the point-in-time snapshot of the signal as decided
(commented ADR-0200 exception): the alert's live detail is refreshed and later resolved, and the record of why an
agent was halted must not change with it. RLS: admin, `system_task` and `migration` only. `builder_agents` gains the
three halt columns with the same CHECK as `agents`; `release_reason` and the builder halt reason are prose-scrubbed.

### Routes (admin-only by default; API-only in slice 1, screen requested on #453)

`GET /v1/containments` (keyset-paginated, `status` filter), `GET /v1/containments/:id`, `POST
/v1/containments/:id/release`. Known UI gaps in `scripts/known-ui-gaps/adr-0366-e52-rogue-containment.json`.

## Consequences

- An agent seen acting fully autonomously while declared `assist` is halted the moment the monitor raises the episode,
  on every install, without configuration; every other agent-subject finding becomes a decision in the queue an
  administrator already works.
- The threshold and the approver are admin settings; turning automatic containment off is a step-up and is audited.
- **Limits, stated:** containment acts only on registry agents and builder agents. Unregistered traffic (projects,
  keys, users) is not contained. Only episodes raised after this ships are considered (the product is not live; no
  backfill, ADR-0180). A proposal stays decidable after its alert resolves: the approver decides on the evidence
  snapshot. A registry agent with no steward gets an unrouted proposal (the alert and automatic containment still
  apply).

## Follow-ups (later slices)

- Lane E40's behaviour-baseline findings (open PR #966) as a `behaviour_baseline` signal source once it merges and
  leaves shadow mode.
- Containment of a virtual key or a project for `unregistered_ai_traffic`.
- Re-evaluating a refreshed episode whose severity escalated (slice 1 decides at raise).
- The admin screen (#453): containments list, release with step-up, policy settings.

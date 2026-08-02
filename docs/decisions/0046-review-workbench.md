# ADR-0046: Review workbench — routing, SLA timers, escalation, saved views, and bulk actions over the one `approvals` table

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0011 (conflicts ride the one approvals queue), ADR-0016 (budget-ceiling
  escalations post to approvals), ADR-0017 (infra findings + the one Approvals Queue), ADR-0018
  (six-dimension assignment matching — the routing dimensions reused here), ADR-0021 (`org_settings`
  ceiling), ADR-0022 (approver READ visibility, delegation windows), ADR-0027 (per-stage approval
  quorum)
- **Cross-refs (forward)**: ADR-0061 (ChatOps — two-way approve/deny from Slack/Teams),
  ADR-0045 (MRM sign-offs route through here)
- **Pillars**: 1 (governance — the Approvals Queue is a §6 functional surface), 2 (workflow — every
  human-approval stage posts here)
- **Migration**: proposed, next free number (0049+). Nothing here ships until this ADR is Accepted.

## Context

The `approvals` table is already the product's single approval spine. By deliberate design across
many ADRs, *everything* that needs a human decision lands in it: MCP write-tool approvals
(GOVERNANCE_LAYER_SPEC §3/§6), workflow human-approval stages (WORKFLOW_ENGINE_SPEC §5, "exactly one
approvals inbox"), Shared-Project conflict resolution (ADR-0011), orchestration budget escalations
(ADR-0016), infra drift/remediation (ADR-0017), and per-stage quorum (ADR-0027). The row already
carries `object_type` (`mcp_tool|workflow|run|project|infra_operation`), `approver_user_id`,
`status` (`pending|approved|denied|consumed|superseded`), `requested_at`, `decided_by`/`decided_at`,
`decision_reason`, and the linking `instance_id`/`run_id`/`project_id`/`stage_id`.

What it lacks is everything that makes a queue *survivable at volume*. Each approval names exactly one
`approver_user_id` chosen at creation time. There is no concept of a **team or role** owning a class
of approvals, no **due date**, no **escalation** when an approver is out, no **saved filters**, no
**per-reviewer workload** view, and no **bulk** action. At ten approvals a day one named approver is
fine; at a thousand — the volume a default-deny, approval-heavy governance product *generates* — a
single-assignee flat list is where governance goes to die, because reviewers rubber-stamp or ignore
it and the control becomes theatre.

The tension: scale the queue into a real reviewer tool **without forking it**. The moment there are
two approval stores or two decision paths, the "exactly one audit trail / one inbox" invariant that
the whole product rests on is broken. So this must be a routing/SLA/view layer *on top of* the one
table, not a parallel system.

## Decision

Build a **review workbench** as an additive layer over `approvals` — the same rows, the same
decision endpoints, the same audit trail.

### 1. Routing / assignment by role, team, and data-sensitivity

Proposed `approval_assignment_rules`: id, match conditions (`object_type`, `project_id` nullable,
`data_sensitivity` nullable, `stage_id` pattern nullable, workflow-template nullable), `assignee_kind`
∈ `user|role|team`, `assignee_id`, `quorum` (default 1, composing with ADR-0027), `priority`,
`created_by`. These reuse the **same matching dimensions ADR-0018 already established** for workflow
assignment (target-system / path / change-type / data-sensitivity / role / environment) rather than
inventing a second matching vocabulary. On creation an approval is matched against these rules to
determine an **assignment** rather than a single hard-coded `approver_user_id`.

To keep `approver_user_id` (NOT NULL today, and load-bearing for ADR-0022's approver READ
visibility) meaningful, add a sidecar `approval_assignments` (approval_id, `assignee_kind`,
`assignee_id`, `assigned_at`, `claimed_by` nullable, `claimed_at` nullable) that carries the
role/team ownership and the claim state, while `approver_user_id` continues to hold the resolved
individual (the rule's user, or — for a role/team assignment — the eventual claimer). A role/team
approval is claimable by any eligible member; claiming is audited. **This does not widen who can
decide** — eligibility is still the §2–§6 entitlement model; routing decides *whose queue it shows
in*, never *who is allowed to act*.

### 2. SLA timers + escalation paths

Add `due_at` and `sla_policy_id` to the assignment. A proposed `approval_sla_policies` table carries
`{ warn_after, breach_after, escalate_to (user|role|team), escalate_action }`. A scheduler (the
ADR-0032/0035 posture: loud, admin-visible, ledgered) marks approaching and breached SLAs and, on
breach, **reassigns/adds an escalation assignee** — it **never auto-approves and never auto-denies**.
Escalation moves a decision to someone who can make it; a governance queue that clears itself by
timeout is a bypass, and the compliance-beats-approval principle (ADR-0023/0027) forbids it. Breaches
surface as findings on the same one findings/queue surface, not a new alert channel.

### 3. Saved views + per-reviewer workload

Server-side **saved views** = named filter+sort presets over the existing approval columns
(`status`, `object_type`, `project_id`, `data_sensitivity`, `due_at`, assignee) — the same
keyset-paginated, filtered read pattern ADR-0031 built for `/v1/audit`, so the workbench inherits
cursor pagination and the row-cap discipline rather than loading an unbounded list. **Per-reviewer
workload** is an aggregate query (open / due-soon / breached counts per assignee) — read-only, and
scoped by ADR-0022's approver-visibility rules so a reviewer sees only queues they are party to.

### 4. Bulk actions — capped, audited per-item, sensitivity-fenced

Bulk approve/deny/reassign over a selected set, executed as **N individual decisions through the one
decision endpoint** — each writes its own audit row with the shared `decision_reason`, so a bulk
action is N recorded decisions, never one opaque event. Bulk is **capped** (an admin-set max per
action) and **forbidden on high-sensitivity classes** (e.g. anything the compliance cascade flags
production/PII), because frictionless bulk approval of sensitive items is precisely the rubber-stamp
failure mode a governance product must not ship. This is a deliberate, disclosed limit, not an
oversight.

### 5. Two-way ChatOps (ADR-0061)

The workbench is the in-product surface; ChatOps (ADR-0061) is a **client** of the same endpoints. An
approve/deny from Slack/Teams calls the one decision endpoint, resolves to the same `authCtx`, writes
the same audit row, and respects the same entitlement + sensitivity fences — Slack is a UI, **never a
second decision path or a second audit trail**. ADR-0061 owns the ChatOps transport, identity binding,
and message format; this ADR owns the queue it drives.

## Consequences

### Easier
- The single approvals inbox becomes usable at enterprise volume: work reaches the right team, ages
  visibly, escalates when stuck, and can be triaged in bulk — the difference between a governance
  control that is *used* and one that is *routed around*.
- Every downstream that already posts to the queue (workflow stages, budget escalations, infra
  findings, Shared-Project conflicts, MRM sign-offs per ADR-0045) inherits routing, SLAs, and views
  for free, because they still just create `approvals` rows.
- ChatOps and the MRM lifecycle both plug into one queue rather than each growing its own.

### Harder / given up
- **`approver_user_id` semantics get subtler.** A NOT-NULL individual column coexisting with a
  role/team assignment sidecar needs care so ADR-0022's "party to the instance" READ checks and the
  ADR-0027 quorum count stay correct. Migration must preserve every existing single-assignee approval
  byte-for-byte (the assignment layer is additive; an approval with no matching rule keeps exactly
  its current single-approver behaviour).
- **Escalation never clears work by itself** — by design. An org that wants timeouts to auto-decide
  cannot have that here; it is a bypass. Stated plainly so it is not filed as a missing feature.
- **Bulk is deliberately fenced** (§4). Reviewers with large sensitive queues will still have to act
  item-by-item on the highest-risk classes. That friction is the control.
- **This is a layer, not a new store.** No second approvals table, no second decision endpoint — a
  constraint that makes some UI conveniences (e.g. cross-store dashboards) simply not applicable,
  which is the correct trade for one audit trail.

### Follow-up
- ADR-0061 defines the ChatOps transport and identity binding that drives §5.
- Decide whether saved views are per-user or shareable per-team (leaning per-user with an admin-
  publishable shared set), consistent with the entitlement model.

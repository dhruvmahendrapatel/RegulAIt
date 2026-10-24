# ADR-0046: Review workbench — routing, SLA timers, escalation, saved views, and bulk actions over the one `approvals` table

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0058)
- **Relates to**: ADR-0011 (conflicts ride the one approvals queue), ADR-0016 (budget-ceiling
  escalations post to approvals), ADR-0017 (infra findings + the one Approvals Queue), ADR-0018
  (six-dimension assignment matching — the routing dimensions reused here), ADR-0021 (`org_settings`
  ceiling), ADR-0022 (approver READ visibility, delegation windows), ADR-0027 (per-stage approval
  quorum)
- **Cross-refs (forward)**: ADR-0061 (ChatOps — two-way approve/deny from Slack/Teams),
  ADR-0045 (MRM sign-offs route through here)
- **Pillars**: 1 (governance — the Approvals Queue is a §6 functional surface), 2 (workflow — every
  human-approval stage posts here)
- **Migration**: **0058** (`0058_review_workbench`) — see the implementation amendment at the bottom
  of this file for what actually shipped, what is genuinely enforced, and what nothing drives.

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

---

## Implementation amendment — 2026-08-02 (migration 0058)

Accepted and built. This section records what shipped, where it deviates from the proposal above,
and — most importantly — **what is genuinely enforced versus what has nothing driving it**. Read
the honesty section before assuming an SLA timer fires on its own here. It does not.

### What shipped

**Migration 0058 (`0058_review_workbench`)** — four tables plus two `org_settings` columns, and
**no column added to `approvals`**:

- `approval_sla_policies` — `warn_after_minutes`, `breach_after_minutes`, and `escalate_action` ∈
  `add_assignee | reassign | notify_only`. **There is no auto-approve and no auto-deny, and that
  absence is a DB CHECK rather than a convention** — a queue that clears itself on a timeout is a
  bypass (ADR-0023/0027). Further CHECKs: breach must be strictly after warn; an escalation must
  name a target unless it is `notify_only`; `reassign` must name a *user*, because a role cannot
  become the one NOT-NULL `approver_user_id`.
- `approval_assignment_rules` — matched on the ADR-0018 dimensions (`object_type`, `project_id`,
  `data_sensitivity`, `stage_pattern`, `template_id`), ANDed. A rule with **no** conditions matches
  **nothing** (DB CHECK), the discipline `workflow_assignment_rules` already follows.
- `approval_assignments` — one row per approval (UNIQUE), carrying the routed owner, the claim
  state, the SLA clock, the evaluated state and the escalation target.
- `approval_saved_views` — per-user, with `user_id IS NULL` meaning an admin-published shared view.
  This resolves the ADR's own open question toward "per-user with an admin-publishable shared set".
- `org_settings.approval_bulk_max_items` (25) and `approval_bulk_sensitive_blocked` (true).

New `audit_log.object_type` value `approval_assignment_rule` (plain text, no DDL). Every routing,
SLA, claim and bulk event audits on the **approval's own** objectType with a stable ruleId
(`approval-routed`, `approval-sla-warning`, `approval-sla-breached`, `approval-claimed`,
`approval-bulk-decision`, `approval-bulk-item-refused`), so "what happened to this approval" stays
one query.

**`packages/shared/src/workbench.ts`** — the pure half: `ruleMatches` / `selectAssignmentRule`
(a TOTAL ordering — priority, then `createdAt`, then id — so two equally specific rules never
produce a non-deterministic queue), `stagePatternMatches` (`*` glob only, regex metacharacters
escaped — an admin-typed regex in the read path of every reviewer's inbox is an availability risk
for no expressive gain), `slaDeadlines`, `evaluateSla`, and the bulk fences.

**`apps/gateway/src/workbench.ts`** — materialization, SLA evaluation + escalation, claiming,
saved views, workload, the routing/SLA admin API, and the bulk endpoint.

**`apps/gateway/src/app.ts`** — the decide handler's body was **extracted into
`decideOneApproval`** and the route now calls it. Bulk is handed that same function. This is the
mechanical guarantee behind §4: there is no second implementation of "approve an approval" for a
bulk item to take a shortcut through.

**SPA** — `/admin/review-workbench` under Governance: workload, SLA policies, routing rules, and a
triage table with claim + bulk. The Approvals Queue page is untouched and still works exactly as
before.

### Deviations from the proposal above

1. **ROUTING IS MATERIALIZED LAZILY, NOT AT APPROVAL CREATION.** §1 says "on creation an approval
   is matched against these rules". There are roughly a dozen `INSERT INTO approvals` sites in this
   codebase (workflow stages, MCP write-tool gates, budget escalations, infra remediations, context
   conflicts, orchestration escalations, MRM sign-offs). Editing every one would be a dozen chances
   to miss one, and a missed one is an approval that silently never routes. Instead the assignment
   is created on the first READ of the queue, on a DECIDE, or by the sweep — computed from columns
   already stored on the approval row. The result is **identical** to eager routing (every matching
   input is stored state, and the SLA deadlines derive from `requested_at`), and it is impossible
   for a future insert site to forget. The whole path is guarded by "is any rule enabled?", so a
   deployment with an empty rules table — the shipped state — materializes nothing, writes nothing,
   and behaves byte-identically to pre-0058.
2. **The queue read WIDENS for role/team assignees.** §1 promised routing decides "whose queue it
   shows in", which requires the members of an assigned role/team to actually see the row. `GET
   /v1/approvals` therefore also returns approvals assigned (or escalated) to a role or team the
   caller belongs to. This is **not** a widening of who may decide: the decide path re-checks
   `approver_user_id` independently, and the tests assert that an unclaimed team member is refused
   with the queue's own `not_the_named_approver`.
3. **Bulk `reassign` did not ship.** §4 lists "bulk approve/deny/reassign". Only approve and deny
   shipped. Bulk reassignment is not a decision and does not ride `decideOneApproval`, so it would
   have needed its own authorization path — exactly the second path this ADR exists to prevent. It
   is a follow-up, not an oversight.
4. **The sensitivity fence has a concrete definition.** §4 says "forbidden on high-sensitivity
   classes (e.g. anything the compliance cascade flags production/PII)". Shipped as: an approval
   attributed to a project whose effective compliance policy sets `piiMode: 'block'`. It is
   evaluated **per item**, so a mixed batch refuses the sensitive item and decides the rest, and it
   is switchable org-wide (`approvalBulkSensitiveBlocked`, default on).
5. **Saved views are stored and served but not yet applied server-side.** `filters`/`sort` are
   persisted and returned; `GET /v1/approvals` does not yet consume a view id, and §3's promised
   keyset pagination over the approvals read did **not** ship — that read is still the pre-existing
   `limit(100)`. Real, and listed as a follow-up rather than implied.
6. **Bulk returns 207 with per-item results**, not a single status. A partial batch is the normal
   case once per-item authorization is real, and collapsing it to one code would hide exactly the
   information a reviewer needs.

### What is GENUINELY ENFORCED vs. what NOTHING DRIVES

**Genuinely enforced — asserted end to end, on state rather than on flags:**

- **BULK APPLIES THE SAME PER-ITEM AUTHORIZATION AS A SINGLE DECIDE.** The decisive test puts an
  approval the caller is *not* the named approver for into a batch with two they are. The batch
  returns 207: two decided, one refused with **the queue's own `not_the_named_approver`** — the
  error only reachable through `decideOneApproval` — and the unauthorized approval is asserted
  **still `pending` with a NULL `decided_by`**. A batch-level authorization shortcut cannot produce
  that result. Bootstrap-token bulk is refused with `bootstrap_cannot_decide`, and an
  already-decided item comes back `already_decided` rather than being silently skipped.
- **BULK IS AUDITED PER ITEM.** `approval-bulk-decision` rows are counted and matched to the
  decided ids; `approval-bulk-item-refused` rows are counted and matched to the refused ones, with
  `effect: deny`. The assertions are on counts per item and per batch id — one row per batch would
  fail them.
- **SLA BREACH IS DETECTED AND ESCALATES.** The test backdates an approval's `requested_at` past a
  10-minute breach window and then performs a plain **READ** of the queue. The assignment flips to
  `breached`, `breached_at` is set, the escalation target is recorded, and an
  `approval-sla-breached` audit row appears carrying how many minutes late it was. A second and
  third read do **not** re-escalate (the evaluation is monotonic). A separate case takes a
  backdated approval **straight to a decision with no read in between** and asserts the breach is
  still recorded — so a queue only ever touched by decisions still registers its breaches.
- **ESCALATION MOVES WORK, IT NEVER DECIDES.** Every SLA case asserts the approval is still
  `pending` after the breach. The `reassign` case asserts `approvals.approver_user_id` actually
  moved to the escalation target — a real column, not a badge — while `status` stayed `pending` and
  `decided_by` stayed NULL.
- **ROUTING ROUTES, AND ONLY ROUTES.** A team rule makes the approval visible to a team member who
  is not the named approver; that member is still **refused** by the decide path; a non-member is
  refused the CLAIM; an eligible member's claim resolves `approver_user_id` (audited,
  `approval-claimed`) without deciding anything; a second claimer gets 409; and the claimer can
  then decide through the ordinary endpoint. A `user`-kind rule resolves the named approver at
  materialization so ADR-0022 visibility and ADR-0027 quorum keep reading a meaningful column.
- **THE FENCES HOLD.** An over-cap bulk is refused **whole** (422) with nothing decided; a bulk with
  no reason is refused; the PII-blocking project's approval is refused `bulk_forbidden_sensitive`
  per item while its ordinary sibling succeeds — and is then shown to be perfectly decidable **one
  at a time**, because the fence is friction, not a lock.
- **ADMIN-GATING IS WHERE IT BELONGS.** Authoring routing rules and SLA policies, and running the
  sweep, are admin-only. Bulk, claim, workload and saved views are reviewer-facing (a reviewer is
  not an admin) and each applies the caller's own eligibility inside the handler. Publishing a
  shared saved view is admin-only; another reviewer's private view cannot be deleted.
- **THE LAYER IS INERT UNTIL TURNED ON.** With no enabled rule, the queue read writes no assignment
  row, evaluates no SLA, and returns the identical response shape (no `assignment` field). Asserted.

**Nothing drives it — stated plainly:**

- **THERE IS NO IN-PROCESS SCHEDULER OR JOB RUNNER IN THIS CODEBASE, AND THIS SLICE DID NOT ADD
  ONE.** No timer fires. SLA breach becomes visible in exactly three ways: a read of
  `GET /v1/approvals`, a decision on the approval, or an explicit `POST /v1/approvals/sla/sweep`
  that an operator or an external cron must call. The design survives this only because the
  deadlines are a **pure function of `requested_at` and the policy**, so a breach detected late is
  byte-identical to what a timer would have produced and reports how late it was found. **Do not
  read anything in this ADR as a claim that timers fire on their own.** In a deployment where
  nobody opens the queue and nothing calls the sweep, a breach exists in the data and is simply not
  yet observed.
- **Escalation notifies nobody.** `add_assignee` widens who *sees* the item in the product;
  `notify_only` writes an audit row. There is no email, no Slack, no push. §2's "breaches surface as
  findings on the same one findings/queue surface" shipped as *the queue and the audit trail*, not
  as a row in the ADR-0017 findings table.
- **ChatOps (§5) is out of scope here** and belongs to ADR-0061, which does not exist yet.
- **Quorum composition with ADR-0027 is stored, not yet composed.** `approval_assignment_rules.
  quorum` and `approval_assignments.quorum` are carried through, but the per-stage quorum logic in
  the workflow engine has not been changed to read them. A rule that sets `quorum: 3` today records
  the intent and changes no behaviour.

### Verification performed

- Migrations 0001–0058 apply clean to a fresh database.
- `pnpm -r build` clean; web bundle builds clean.
- `packages/shared`: 86 → 116 tests, all passing (30 new pure workbench cases).
- `policy-kernel`: 129, unchanged. `workflow-kernel`: 39, unchanged.
- Full gateway suite: **1281 → 1308 tests, all passing** (27 new integration cases in
  `apps/gateway/src/workbench.test.ts`), run twice against two independently created fresh
  databases. Routing rules are global shared state that would re-route another suite's approvals,
  so `afterAll` deletes every rule, policy, assignment, saved view and approval this file created.

### Follow-ups this slice leaves open

- **Nothing drives the SLA sweep.** A scheduler (or a documented cron entry) is the obvious next
  step; the endpoint is deliberately shaped for one.
- **Saved views are not applied server-side**, and §3's keyset pagination over `GET /v1/approvals`
  did not ship — that read is still `limit(100)`.
- **Bulk reassign**, deliberately deferred (see deviation 3).
- **Quorum composition** with ADR-0027's per-stage quorum.
- **Escalation notification** — an actual push channel, which is ADR-0061's territory.

---

## Amendment (2026-08-03) — this ADR's scheduling gap is closed by ADR-0064

[ADR-0064](0064-in-process-scheduler.md) added an **in-process scheduler** to the gateway, with a
Postgres row-lock claim so a second instance cannot double-fire a job, and registered this ADR's
sweep as one of its six jobs. The sweep's logic was **not reimplemented** — the job calls the same
function this ADR's endpoint calls, so there is exactly one implementation and the endpoint
remains available for manual/on-demand runs.

Three things about that are worth stating here rather than only in ADR-0064:

1. **It is OFF by default**, in every environment (`REGULAIT_SCHEDULER`). A deployment that does
   not opt in behaves exactly as this ADR originally described, and its endpoint is still the way
   to drive the sweep from an operator's own cron.
2. **Nothing about enforcement changed, and nothing was allowed to.** This ADR's sweep was
   deliberately built so that correctness never depended on it having run; that property is
   asserted in `scheduler.test.ts` precisely so a future change which moves a control into the
   timer breaks a test rather than a customer. The scheduler buys **timeliness**.
3. **Timeliness is bounded by the box being up.** [ADR-0032](0032-scheduled-power-off-dev-infra.md)
   powers this deployment's infrastructure off nightly; a sweep due inside the off-window does not
   run, is not queued, and is picked up once — late — on the first tick after power-on.

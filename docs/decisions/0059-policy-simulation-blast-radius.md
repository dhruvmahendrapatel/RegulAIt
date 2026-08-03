# ADR-0059: Policy-simulation blast radius — impact set + differential replay before commit

- **Status**: Accepted
- **Date**: 2026-08-01
- **Amended**: 2026-08-02 — implemented as **migration 0071**. See the amendment at the foot of
  this file for what is genuinely enforced, what is structural, and the honest limits.

## Context

The governance layer already ships a Simulation / Access-preview surface. `POST /v1/evaluate`
(`apps/gateway/src/app.ts`) runs a full governed evaluation — `governedEvaluate`
(`apps/gateway/src/governed-evaluate.ts`) → the pure `evaluate()` in
`packages/policy-kernel` — and returns the decision for a single `(user, server, tool)` tuple.
`GOVERNANCE_LAYER_SPEC.md` §5 mandates exactly this: "before saving a policy change, an admin
can simulate *what would User X be able to do right now*."

That surface answers one question well: **what can this one user do, on this one tool, right
now.** It does not answer the two questions an admin actually has *before committing a rule,
role, or policy change*:

1. **WHO does this change touch** — which users, agents, and workflows fall inside its blast
   radius? A single edit does not stay local. `scopedRuleWhere` in `governed-evaluate.ts` shows
   why: a rule is bound to one of `user | role | team | fleet`, and enforcement widens every
   load from the exact `(userId, serverId)` match to *every scope the user matches*. So a role
   edit fans out to every member, a fleet rule to everyone, and a data-scope tightening to every
   call that touched that argument. An admin cannot eyeball that reach.
2. **What would have been decided DIFFERENTLY** — if this change had been live for the last N
   days, which real, audited decisions would have flipped from allow to block (or the reverse,
   or to approval-required)?

The substrate for question 2 already exists. `audit_log` is append-only and FK-free by design
(`packages/db/src/schema.ts`: "No FKs on purpose: audit records must survive user/server
deletion"), and every row carries the decision context the kernel needs to re-decide:
`userId`, `serverId`, `toolName`, `effect`, `ruleId`, `ruleChain`, `reason`. It is, in effect, a
replayable transcript of what the gateway actually decided.

Two forward dependencies bound this design and are named here as the anchors they will be:

- **Attribute-based access control (planned, ADR-0040).** Once matching is attribute-driven,
  "who is affected" stops being a static role/team-membership lookup and becomes "which subjects
  satisfy the changed attribute predicate." The impact-set computation must be written so that
  swap is a resolver change, not a rearchitecture.
- **Policy/role versioning (planned, ADR-0048).** A blast-radius run is inherently a *diff of two
  policy states* — the live one and the candidate one. Versioning is what gives us two clean,
  addressable snapshots to diff without racing a concurrent edit.

## Decision

Extend the existing Simulation / Access-preview into a **blast-radius** tool. It is **strictly
dry-run with zero side effects** — no `audit_log` rows, no `approvals` queue entries, no rate
counters consumed, no usage metered — and it computes two things for a proposed change.

### 1. WHO — the impact set

Given a proposed delta (a new/edited/deleted `approval_rules` / `rate_limits` /
`data_scope_rules` row, a role grant, or an entitlement change), resolve the concrete set of
subjects it touches by reusing the *same* membership resolver enforcement uses
(`loadScopeMemberships`), then expand to the agents, workflows, and orchestration runs those
users can initiate. Present as counts with drill-down. Reusing the enforcement resolver — not a
parallel query — is load-bearing: it is the same discipline ADR-0024 applied to its effective-
value preview, so the preview can never drift from what the gate actually does.

### 2. REPLAY — differential decision replay

Take the last N days of `audit_log` rows (bounded window, sensible default such as 30 days,
under a hard row cap), and for each recorded decision re-run the kernel's `evaluate()` under the
**candidate** policy — the proposed delta overlaid, in memory, on the current rule/entitlement
state, never committed — then diff the recomputed effect against the recorded effect. Emit four
buckets: **newly allowed**, **newly blocked**, **newly approval-required**, and **unchanged**.
That is the concrete answer to "what would break, and for whom," measured against real traffic
rather than a hand-picked tuple.

### Constraints that make this honest and safe

- **Zero side effects — a distinct pure path.** Blast-radius runs must never write. This is a
  real divergence from today's `/v1/evaluate`, which writes one `audit_log` row per call
  (`app.ts` ~L1506). Blast radius gets its own path that touches nothing; a follow-up decides
  whether `/v1/evaluate` itself should become side-effect-free or stay the "single-tuple audited
  probe."
- **Replay fidelity is bounded, and we say so.** `evaluate()` is a pure function of rules,
  entitlements, tool, **args**, rate-limit **counts/windows**, and context. `audit_log` stores
  `ruleChain`/`effect`/`reason` but **not** the call arguments and **not** the decision-time
  rate counters. So replay is **exact** for grant/deny and approval-rule flips, and only
  **best-effort, explicitly flagged indeterminate** for data-scope rules (which need the arg
  values) and rate-limit outcomes (which need the historical count in-window). This is disclosed
  in the output, not silently smoothed over.
- **Bounded cost.** Replay is `O(rows × rule-eval)`. Cap the window and row count; run
  large windows asynchronously. The tool is admin-only and invoked pre-commit, so batch/async
  latency is acceptable.
- **Candidate assembly.** Overlay the delta on an in-memory copy of the loaded rule/entitlement
  set. This is cleanest once ADR-0048 versioning can hand us an immutable "current" snapshot;
  until then, overlay on a point-in-time read and accept a small, documented TOCTOU window
  between read and commit.
- **ABAC forward-compat.** Write the impact-set step against the resolver interface so that when
  ADR-0040 lands, "who is affected" becomes "which subjects match the changed predicate" without
  touching the replay engine.

### Output shape

The tool returns a single structured verdict, not a wall of rows:

- **Impact summary** — counts by subject kind (`N users, M agents, K in-flight workflows/runs`)
  with an expandable list, each entry labeled by *why* it is in scope (direct user grant, role
  membership, team membership, fleet-wide).
- **Replay diff** — the four buckets (newly allowed / newly blocked / newly approval-required /
  unchanged) with per-bucket counts, a sample of representative flipped decisions (user, tool,
  old effect → new effect, the rule that now fires), and an explicit **indeterminate** count for
  decisions whose replay could not be made exact (arg-dependent or volume-dependent — see the
  fidelity caveat above).
- **A single headline** an admin can act on: e.g. "this change blocks 3 tools for 47 users who
  are using them today, and newly requires approval on 1,204 calls/week."

### Worked example

An admin edits a fleet-scoped `approval_rules` row to require approval on any write tool. WHO
resolves the fleet to all active users plus every agent/workflow they can drive. REPLAY re-runs
the last 30 days of `audit_log` allow rows for write tools under the candidate rule: they flip
`allow → require_approval`. The diff shows 1,204 such calls across 47 users last month — the
admin now knows this rule turns roughly 40 approvals/day onto whoever is named approver, and can
right-size the approver set (or scope the rule down) *before* committing, instead of discovering
the load after it goes live.

### Composition with the rest of the product

- **Compliance cascade (§8.3).** A blast-radius run is a natural gate to attach to
  classification changes: reclassifying an Initiative already re-applies the cascade and surfaces
  a diff for admin review (spec §8.3), and blast radius is the mechanism that makes that diff
  concrete against real traffic rather than a list of abstract control changes.
- **Orchestration (pillar 7).** Because worker/lead agents inherit — and never exceed — the
  initiating user's entitlements, a rule change that blocks a user silently narrows every
  in-flight run they lead. The impact set must therefore expand users to their in-flight
  orchestration runs, so an admin sees "this also constrains 6 running task graphs," not just a
  user count.
- **Deployment modes (§8.5).** Replay reads only the local `audit_log`, so the tool works
  unchanged in BYOC and **air-gapped** installs — there is no dependency on the hosted control
  plane to answer "what would have flipped here." This is a direct benefit of the FK-free,
  self-contained audit design.

## Consequences

- **Easier.** Admins see the true reach of a change *before* committing it, and see it against
  real historical traffic, not a single tuple they thought to test. Over- and under-provisioning
  are caught pre-commit. This closes the gap between §5's one-tuple preview and the actual
  question — "will this quietly break someone, or quietly open something."
- **Harder / given up.** Replay fidelity is capped by what `audit_log` records: exact for
  entitlement and approval-rule flips, flagged-indeterminate for arg-dependent and volume-
  dependent rules — unless we widen `audit_log` to store (redacted/fingerprinted) arg values and
  decision-time counters, which is its own schema + retention + PII decision, entangled with the
  compliance-cascade retention rules (spec §8.3) and therefore deliberately deferred. Replay over
  large windows costs compute; mitigated by caps and async. A clean candidate-vs-current diff
  wants real policy snapshots, which is why this leans on ADR-0048; the interim overlay carries a
  disclosed TOCTOU window.
- **Follow-up.** Build the pure batch-replay path (and decide `/v1/evaluate`'s side-effect
  future); decide whether to widen `audit_log` to raise replay fidelity, weighed against
  PII/retention; surface the impact-set drill-down in the admin SPA beside the existing
  Access-preview; converge with ADR-0040 (ABAC) and ADR-0048 (versioning) when they land.

---

## Amendment — 2026-08-02: implemented as migration 0071

**Status: Accepted.** Shipped as `packages/shared/src/policy-simulation.ts` (pure),
`apps/gateway/src/policy-simulation.ts` (gateway), migration
`packages/db/migrations/0071_policy_simulation.sql`, a blast-radius panel added to the existing
`apps/web/src/views/admin/governance/SimulationPage.tsx`, and the proof-by-attack suite
`apps/gateway/src/policy-simulation.test.ts` (19 tests).

### This is the consumer ADR-0040 promised

ADR-0040 shipped the *hook* — `POST /v1/abac/simulate`, one `(user, server, tool)` tuple — and
named this ADR as the intended consumer of Cedar's analyzability. `POST /v1/policy-simulations` is
that consumer: given a **proposed policy version**, it dry-runs the candidate against **recorded
history** (`audit_log`, with project attribution reconstructed from `usage_events`) and reports
what it *would have* newly denied or newly sent to approval, before activation. Attribute assembly
is `assembleAbacRequest` — the very function enforcement calls, reused rather than re-implemented,
so the preview cannot drift from the gate.

### Genuinely enforced (asserted by test, not by comment)

- **Zero dispatches, proved with a counter.** A provider spy wraps `resolveModelProvider` and
  counts every dispatch; simulating a *forbid-everything* candidate — the policy most likely to
  tempt an implementation into re-executing something — leaves the count at exactly **0**, and the
  file's closing assertion re-checks it after every simulation it ran. Structurally, the module
  cannot dispatch: `executeGovernedDispatch` is not reachable from it.
- **No mutation.** `usage_events` count unchanged, approvals queue empty, and
  `abac_policies.active_version_id` / `enabled` byte-identical before and after. The **only** new
  row is one `audit_log` entry recording that a preview happened, under which scope, over which
  window — deliberate, because a preview reads other people's traffic.
- **The blast radius is concrete.** The output names the affected users (with labels), the
  projects (with names), the tools, and persists a bounded sample of the **specific calls** that
  would flip, `allow → forbid`. The test asserts real user ids and real project names out of real
  history, not a percentage.
- **The numbers reconcile.** The bucket counts are checked against an **independent SQL count** of
  the historical rows, computed in the test rather than read back from the preview, and a DB CHECK
  makes the five buckets sum to `considered` at the storage layer.
- **Entitlement-scoped the way ADR-0047 scopes reports.** A team lead's preview replays only their
  own team's history — the other team's users are *absent from every bucket*, not merely hidden in
  a UI. Explicitly naming an out-of-team subject is **refused** (never silently narrowed — a silent
  narrowing would let someone probe team membership by watching counts move) and the refusal is an
  audit row. A narrower caller also cannot read a wider stored preview back out of the archive.
- **Friction on activation.** Every activation records `blastRadiusPreviewed` on its audit row and
  returns a warning when false; with `policy_simulation_settings.requirePreviewBeforeActivate` on,
  the activation is **refused** (409) until that exact version has been previewed. Composed with
  ADR-0048 versioning: a simulation always targets an immutable `abac_policy_versions` row, and the
  FK is `RESTRICT` so the artifact an admin relied on cannot be deleted underneath the preview.

### Structural, not behavioural

- **The impact set (§1, "WHO") is delivered as the replay's named output, not as a separate
  membership expansion.** The blast radius names the users, projects and tools that actually appear
  in flipped history, which is strictly more concrete than expanding a rule's scope to its
  membership — but it therefore says nothing about a subject who *would* be in scope and simply had
  no traffic in the window. Expanding to agents, workflows and in-flight orchestration runs (§1 and
  the pillar-7 composition note) is **not built**.
- **The candidate is an ABAC policy version only.** §1's other deltas — a proposed
  `approval_rules` / `rate_limits` / `data_scope_rules` row, a role grant — are not simulable yet.
  The classifier and the storage shape are delta-agnostic, so adding them is a new candidate
  evaluator rather than a rearchitecture, but today only the Cedar path exists.
- **Everything runs synchronously under a row cap.** §"bounded cost" asks for large windows to run
  asynchronously; there is no job runner here (the same admission ADR-0044 through ADR-0049 made),
  so the caps (180 days, 20 000 rows) are the whole mitigation. When the cap is hit the run is
  flagged `capped` and the counts are reported as a **lower bound** rather than a total.

### Honest limits

- **Replay fidelity is bounded, and the bound is derived from the candidate's own source.**
  `analyzeReplayFidelity` scans the Cedar text for attributes the audit trail cannot reproduce —
  decision-time rate counters, session origin, MFA state, and anything project-derived — and stamps
  the caveats on the stored run. The caller never gets to assert its own fidelity.
- **Project attribution is reconstructed, not recorded.** `audit_log` has no project column (its
  FK-free, deletion-surviving shape is deliberate), so the project is inferred from `usage_events`
  by `(user, server, tool)` inside the same window: exact when a user drives one tool from one
  project, best-effort otherwise, and flagged whenever the candidate actually reads a
  project-derived attribute. Widening `audit_log` instead is the PII/retention decision this ADR
  deliberately deferred.
- **`newly_allowed` is structurally always zero** for an ABAC candidate, because a Cedar `permit`
  is not a grant (ADR-0040). The bucket is reported rather than hidden so the zero reads as a
  property of the model instead of an absence of evidence.
- **`/v1/evaluate` still writes its one audit row.** The follow-up asking whether the single-tuple
  probe should also become side-effect-free is *not* resolved here; the blast-radius path simply
  has its own pure path, which is what the ADR required.
- **A preview is of the recorded past, never a promise about future traffic.** That sentence ships
  on every response as `REPLAY_FIDELITY_DISCLOSURE` and renders on the admin screen next to the
  numbers.

# ADR-0059: Policy-simulation blast radius — impact set + differential replay before commit

- **Status**: Proposed
- **Date**: 2026-08-01

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

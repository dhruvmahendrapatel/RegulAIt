# ADR-0086: Model-card autofill from the ledgers — the card becomes a window you sign

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: **none.** That is the decision's spine (ADR-0082's posture, restated): the
  autofill block is computed by SELECT at read time, and the one durable artifact — the
  sign-off snapshot — lives in the decision's own `audit_log.detail` jsonb, not in a card
  column. There is nothing anywhere an author or admin could set to change what the computed
  block says.
- **Driver**: [GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](../product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md)
  gap **L12** — watsonx factsheets *auto-collect* lifecycle metadata into the card; our
  ADR-0045 evidence attach was manual. Named there *"build next"*, with the shape prescribed:
  *"a read-time aggregation in the ADR-0082 idiom … our version is better-grounded than a
  factsheet (every figure a query)"*.
- **Extends**: [ADR-0045](0045-model-risk-management.md) (the card, chain, and decide hook this
  rides — its RESTRICT evidence FKs and one-queue sign-off are untouched),
  [ADR-0082](0082-inventory-and-posture.md) (the read-time aggregation idiom and the
  granted/observed two-block discipline), [ADR-0081](0081-ai-risk-register.md) (the
  acceptance-freeze pattern and the "unmeasured, not resisted" phrasing),
  [ADR-0067](0067-groundedness-evaluation.md)/[ADR-0068](0068-redteam-depth.md)/[ADR-0042](0042-guardrail-engine.md)/[ADR-0044](0044-agent-evaluation-harness.md)/[ADR-0064](0064-in-process-scheduler.md)
  (the ledgers the sections read), [ADR-0080](0080-ai-use-case-registry.md)/[ADR-0084](0084-vendor-ai-risk-portal.md)
  (the linked objects).

## Context

An ADR-0045 model card recorded what a human typed and what a human chose to attach. The
platform meanwhile *already measured* most of what a reviewer wants to know about the card's
subject — eval scores, red-team ASR, guardrail posture, spend, entitlement standing, drift
baselines — in ledgers the card never read. watsonx sells the collection of exactly this into
"factsheets". Our data was stronger and our card blinder: keeping the evidence sections current
was manual work, and a signed card said nothing about whether the world it certified had since
moved.

## Decision

### 1. Read-time autofill: the detail read fills the evidence-shaped sections itself

`GET /v1/mrm/cards/:id` (and only the detail read — the list stays cheap) gains an `autofill`
block computed per request in `apps/gateway/src/mrm-autofill.ts`, scoped to the card's subject
(the agent, or — for an endpoint-level card — every registered agent backed by that custom
provider, the same both-ways reading `mrmDispatchGate` applies):

- **evals**: run counts (ever / 90-day window) and the latest run's figures, plus a
  groundedness sub-block counting only ADR-0067 scorer kinds — via the **imported**
  `GROUNDEDNESS_SCORER_KINDS` constant, never a restated list.
- **redteam**: the latest run's ASR **verbatim with its Wilson interval, trial denominator and
  measurement-quality label** (ADR-0068's rule — a rate never travels alone), or `measured:
  false` with ADR-0081's phrasing: *unmeasured, not resisted*.
- **guardrails**: the org default and any agent overrides currently in force (ADR-0042) —
  labelled configuration evidence, not proof a runtime control fired.
- **usage**: metered dispatches / cost in window and last-seen, from the one pillar-5 ledger.
- **grants**: effective holders (direct ∪ role-derived, minus revocations) — an inventory of
  grant rows, not a policy simulation (ADR-0082's caveat, inherited verbatim).
- **drift**: pinned ADR-0044 baselines, the latest scheduled sweep run, regressions in window —
  the drift "ledger" is `eval_runs` itself (`isBaseline`, `trigger='scheduled'`, `regression`).
- **links**: the ADR-0080 use cases, ADR-0081 risks, and ADR-0084 vendors whose own references
  name this subject — links, never copies.

**Computed and manually-attached evidence never blend** (the ADR-0081/0082 two-block
discipline): the `evidence` array stays what a human attached; the `autofill` block is labelled
*"computed from ledgers at read time"* on the payload and on the page, and nothing is summed
across the boundary. **Nothing writes at read time** — no card row, no audit row, no cache; the
suite pins both (a repeated read moves neither the audit trail nor the card's `updatedAt`).

### 2. Snapshot-on-sign-off: the one honest write, into the decision's audit detail

At the moment the ONE decide path resolves a model-card sign-off
(`applyModelCardApprovalDecision`, inside the decision's own transaction), the autofill block is
recomputed and its compact summary is frozen into that decision's `audit_log.detail` as
`autofillSnapshot` — the ADR-0081 acceptance-freeze pattern: **the record shows what the
decider saw**, and later ledger movement never rewrites it. It lives in audit `detail` jsonb
deliberately, not in a queryable card column: no migration, no second copy of ledger data an
admin could edit, and the artifact sits in the hash-chained trail beside the decision it
belongs to. The suite proves the freeze by moving the ledgers after the decision and asserting
the snapshot holds while the live block moves on.

### 3. Staleness: a certified card whose world moved says so

The detail read also carries a `staleness` block: the latest *granting* decision (a record now
`approved`, or one approved and since expired/superseded/revoked — a denial starts no clock) is
the reference point, and per-section counts of ledger rows **timestamped after it** (eval runs,
red-team runs, guardrail changes, grant changes, risk-register changes, drift regressions) are
rolled into a human sentence — *"2 eval runs and 1 guardrail change since certification"*. A
card never certified says staleness is **undefined** ("never certified"), not a reassuring
zero. This is L12's differentiator over collect-and-display: the card *tells you* when its
certification has drifted from the evidence.

**Staleness informs; it does not gate.** ADR-0045's expiry enforcement — `validUntil`
recomputed at every dispatch — is untouched, and drift changes no enforcement anywhere. Wiring
"N changes since certification" into the dispatch gate would silently change the meaning of an
already-granted acceptance (a unilateral contract change on the sign-off), so it is named here
as a possible **follow-up** — an org-level opt-in ("drift beyond X requires recertification")
that would need its own ADR and its own toggle — not smuggled in.

### 4. Surfaces, registry, tests

- **Web**: the Model risk page's card detail renders the computed block under a *"Computed from
  ledgers at read time"* badge, the manual attachments under an *"Attached evidence (manual)"*
  badge, and the staleness sentence as a *certification drift* banner at the top of the card
  when non-empty. No route changes — `GET /v1/mrm/cards/:id` was already registered
  (ADR-0053 registry unchanged).
- **Tests**: `mrm-autofill.test.ts` proves the block by attack — deltas around real ledger
  writes with different-agent controls, the read-writes-nothing pin, the snapshot freeze, the
  staleness clock (undefined → clean → drifted → reset by recertification), and the absence of
  any fairness key. A `zz-` Playwright spec proves the headline end-to-end in the real SPA: an
  eval run appears in the card's autofill **without any card edit**. Non-vacuity the M-002 way,
  all three claims: no-op the autofill computation → 7 tests redden; null the sign-off snapshot
  → the freeze tests redden; force the staleness comparison always-empty → the drift test
  reddens. Each probe reverted by reversing the exact edit.

## Honest limits

- **Autofill sees only this deployment's ledgers.** An eval run elsewhere, a red-team exercise
  outside the gateway, a guardrail in front of a different proxy — invisible. The block is a
  window over what *this* deployment measured, not a census of the model's life.
- **A quiet ledger is absence of measurement, not evidence of quality.** Every section says
  "unmeasured" in words when empty; none of those words should be read as "safe".
- **The snapshot is an audit artifact, not a queryable column.** Finding "what did the approver
  see" means reading the decision's audit row (where it belongs, hash-chained); there is no
  SQL-joinable card field for it, by design — a follow-up could add a projection if reporting
  ever needs one.
- **Staleness counts movements; it does not judge them.** Ten passing eval runs and one
  catastrophic regression both read as ledger movement; the reviewer, not the counter, decides
  what warrants recertification.
- **Bias/fairness slots remain declared-only** (ADR-0045 §2). Autofill deliberately computes
  **no** fairness number — no section, key, or note synthesizes one, and the suite pins that
  absence. The four-vendor doc's **L9 stays open**; this ADR does not close it by implication.
- **Endpoint-level cards inherit agent-shaped blind spots.** Red-team runs, grants, and usage
  attach to agents; a custom-provider card with no registered backing agent honestly shows
  those sections empty/unmeasured rather than inventing endpoint-level attribution.

---

## Amendment (2026-08-22, batch B3b) — §3's follow-up built: staleness forces recertification, as an org opt-in deepening the ADR-0045 gate (migration 0098)

§3 named the follow-up rather than smuggling it in: *"an org-level opt-in ('drift beyond X
requires recertification') that would need … its own toggle"*. Built exactly so.

**Where it lives, and why org-level**: the change lands inside `mrmDispatchGate`
(apps/gateway/src/mrm.ts) — ADR-0045's gate anatomy is an `org_settings` pair
(`mrm_enforced` + `mrm_expiry_warn_days`) read by the one gate, so the natural home for a
deepening of that gate is two more columns beside them: `mrm_staleness_recert_enabled`
(default **false**) and `mrm_staleness_recert_threshold` (default 1). A per-card flag was
considered and rejected: it would put authorable per-card state next to a block this ADR
deliberately keeps un-authorable, and it would fork "is this card enforced" across two places.
Both knobs are set through the existing audited `POST /v1/mrm/enforcement` (no new route;
`GET /v1/mrm/status` reports them).

**Semantics**:

- The knob **deepens the ONE gate; it creates none of its own**. It is evaluated only after
  `evaluateMrmGate` allows on a live approval — so with `mrmEnforced` off there is no gate to
  deepen and the knob gates nothing (pinned by test). Default off = this ADR's shipped posture
  byte-identically, even enforced, even drifted.
- When armed: the live card's drift is read from **`computeCardStaleness` — the one staleness
  computation, never re-derived** — and when the summed `changesSinceCertification` counts
  reach the threshold, the dispatch refuses on the **same 409 `mrm_approval_required` path the
  expiry gate uses** (extended, never forked; the caller-facing code stays one, per ADR-0045's
  deviation-1 rule), audited under its own ruleId **`mrm-staleness-recert-required`** with the
  staleness evidence (per-section counts, total, threshold, last-certified instant) in the
  audit detail and the human summary named in the response.
- **Recertifying clears it**: a new superseding sign-off through the one decide path resets
  the clock (the reference point is the latest granting decision, exactly as §3 defined it),
  and fresh drift after the recertification refuses again.

Non-vacuity the M-002 way: no-op the deepening branch → exactly the three armed-refusal tests
fail (the off-is-identical and threshold-dial controls stay green). Probe reverted by
reversing the exact edit.

**§3's sentence above stands corrected in one word**: staleness informs — and, where an org
opts in, forces recertification at dispatch. The unilateral-contract-change concern §3 raised
is answered by the shape: nothing changes for any deployment until its own admin arms the
toggle, and disarming restores the shipped meaning of every existing acceptance.

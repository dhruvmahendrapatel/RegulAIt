# ADR-0214: Posture estimate — objective cards, one explainable score, and ranked actions over the posture report

- **Status**: Accepted
- **Date**: 2026-10-30
- **Driver**: [PENDING.md](../product/PENDING.md) row **P3** ("Ranked actions and an explainable score"), owner backlog
  wave 1 on #453 (comment 6522850568).
- **Extends**: [ADR-0082](0082-inventory-and-posture.md) (the posture report this reads), [ADR-0047](0047-executive-compliance-reporting.md)
  (computed at request time, no rollup), [ADR-0180](0180-continuous-assurance-strict-by-default.md) (strict by default).
- **Migration**: **none.** The estimate is a pure function of the ADR-0082 document, computed in the same request.
- **Setting**: **none.** Read-only and additive (common rule 3 on #453): it changes no enforcement and stores nothing.

## Context

The ADR-0082 posture report already shows pack coverage, open risks, red-team results, evaluations, audit anchoring,
governance activity over 30 days, agent ownership, separation of duties, certification campaigns and spend against
budget. It answers "what do our records say" but not "how are we doing overall" or "what should we fix first". A board
reader wants one figure and a short list; a governance lead wants to know why each item is on the list and where to
fix it. Neither may be told the organisation is "compliant": the platform measures coverage of its own records, not
legal compliance (ADR-0058, ADR-0081).

Open-source check (ADR-0176): no library computes a governance posture score from these ledgers. The objectives,
weights and formulae are RegulAIt's own policy semantics, which rule 4 reserves for our own code. The UI uses the kit
`Meter` and `Table`; no chart library is added.

## Decision

`GET /v1/reports/posture` gains one `score` block, computed by `scorePosture()` in
`apps/gateway/src/posture-score.ts` from the document's own sections. The Posture page renders it as a new top section.

1. **Seven objectives, each with an outcome metric, a published weight, its inputs and its formula in words.**

   | Objective | Weight | Outcome metric | Score (0–100) |
   |---|---|---|---|
   | Control coverage | 20 | mean evidenced share across active packs | the mean; no active pack scores 0 |
   | Risk treatment | 20 | registered risks with a treatment | not-open ÷ total; empty register scores 0 |
   | Adversarial resilience | 15 | attacks resisted, worst case | (1 − upper bound of the ASR 95% interval) × 100, halved if no run in the window |
   | Access hygiene | 15 | agents with an active owner | owned share − 10 per SoD violator and per lapsed campaign, floored at 0 |
   | Answer quality | 10 | latest groundedness pass rate | pass rate × 100; no run in the window scores 0 |
   | Audit integrity | 10 | anchoring | 100 tamper-resistant, 50 rewritable, 0 not anchored |
   | Spend control | 10 | budgeted projects within budget | within ÷ budgeted; no budget scores 0 |

   The weights sum to 100 and are constants, shown verbatim on the page. No admin setting changes them, so two
   deployments' estimates are computed the same way.
2. **One estimate**: the weighted mean of the seven sub-scores, rounded to a whole number. It is labelled an estimate
   on its face with a disclaimer ("not a compliance verdict, an audit opinion or a certification"), and no field or
   copy says "compliant" or "certified" (pinned by tests).
3. **Unmeasured scores 0.** An objective with no data behind it is shown as unmeasured and contributes nothing; empty
   never reads as good (the ADR-0082 honesty rule, carried into the arithmetic and consistent with ADR-0180).
4. **Ranked actions.** Each objective names the deficits that cost it points. An action's points are the
   counterfactual: the objective is re-scored with that one deficit removed and the gain weighted into the estimate.
   Actions are ranked by points, then by the published objective order, then by a stable key, so the same records always
   give the same ranking regardless of row order. Each action carries its reason ("Worth N points: …; X is at S of
   100 and carries W% of the estimate") and a link to the operator page where it is fixed. Actions worth 0 points are
   left out.
5. **Deterministic, no AI.** `scorePosture` reads no clock, no randomness and no I/O; every input is already in the
   posture document.
6. **Scoping** is ADR-0082's: admin-only through the default gate, org-wide.

## Consequences

- One figure and a ranked list for the board, each explainable to the line: weights, inputs and formulae are one
  disclosure away on the page and in the payload.
- The page's lazy chunk grows by about 0.9 kB gzip; entry JS and CSS are unchanged.
- The integration suite asserts the served `score` equals `scorePosture` of the served sections, so nothing else can
  feed it.

## Honest limits

- **An estimate of the records, not of real-world exposure.** A high figure means the ledgers look well covered; it
  does not mean an obligation is met.
- **The weights are a judgement.** They are fixed and published so the figure is comparable and explainable; changing
  them is a new ADR, not a setting.
- **Organisation-wide only.** PENDING P3 also asks for a score per asset (agent, project). That needs per-asset slices of
  the same sections (the inventory already holds most of them) and is left as a follow-up.
- **Access hygiene deductions are linear and uncapped per item type** (10 points each); a large SoD backlog floors the
  objective at 0 rather than distinguishing 10 violations from 100.

## Amendment (2026-11-07): one explainable score per asset

- **Driver**: the follow-up this ADR left open under "Honest limits" and PENDING **P3** ("one score per asset and per
  organisation"). Builder lane `builder/p3-asset-scores`.
- **Migration**: **none.** Like the org-wide estimate, a per-asset score is a pure function of ledger rows read in the
  same request. **Setting**: none; read-only and additive.

### Which assets, and why

An asset is scored only where ADR-0214's objectives can be measured on it from rows that name it:

| Asset | Scored | Objectives that apply | Why |
|---|---|---|---|
| Agent | yes | risk treatment (20), adversarial resilience (15), access hygiene (15), answer quality (10) | `ai_risks.agent_id`, `redteam_runs.agent_id` and `eval_runs.agent_id` name it; `agents.owner_user_id` is its steward |
| Use case | yes | risk treatment (20), access hygiene (15) | `ai_risks.use_case_id` names it; `ai_use_cases.owner_user_id` is its owner |
| Model card | no | none | a card describes an agent or a custom provider; no risk, red-team or evaluation row names the card, so its outcomes are its agent's (scoring it would count the agent twice) |
| MCP server, connector | no | none | no risk, red-team or evaluation row names one; every objective would be unmeasured, so the score would always read 0 and say nothing |

Control coverage, audit integrity and spend control are **not applicable** to any single asset: packs are evaluated for
the organisation or a project, the audit trail is anchored once per deployment, and budgets sit on projects. A use
case's adversarial resilience and answer quality belong to the agents it names, which are scored as agents (a use-case
owner cannot necessarily read those agents' red-team results, so folding them in would also leak them).

### Decision

`apps/gateway/src/asset-score.ts`, sharing `combineObjectives()` with `scorePosture()` (extracted, so the arithmetic,
rounding, counterfactual points and tie-break are one implementation):

1. **Same weights, applicable subset.** Each asset's score is the weighted mean of the ADR-0214 objectives that apply
   to its kind, with the published constants: an agent divides by 60, a use case by 35. Each objective's `sharePct`
   (weight ÷ divisor) is on the payload. The org-wide estimate is unchanged (all seven, divisor 100).
2. **Not applicable is not unmeasured.** An objective that applies but has no rows scores 0 (an agent with no risk
   registered, no red-team run, no groundedness run in the window). An objective that cannot be measured per asset is
   listed under `notApplicable` with its reason and is left out of the divisor, so an org-wide fact neither punishes nor
   flatters one asset.
3. **Formulae per asset**, in words on the payload: risk treatment = risks naming the asset that are not open ÷ all
   risks naming it; adversarial resilience = (1 − upper bound of the agent's latest attack-success rate) × 100, halved
   when none of its runs falls in the 30-day window; answer quality = the agent's latest groundedness pass rate in the
   window × 100; access hygiene = 100 when the recorded owner is an active account, else 0. (Separation of duties and
   certification campaigns attach to people and campaigns, not to one asset, so the org objective's deductions do not
   apply.)
4. **Ranked actions per asset, each with a link to fix it**: the risk register, red-team runs, evaluations or the agent
   inventory for an agent; the use case's own page for a use case.
5. **Estimate, disclaimer, never "compliant"; deterministic, no AI** — `scoreAsset()` reads no clock, randomness or
   I/O; the window start comes from the database clock (M-075).

### API

- `GET /v1/reports/posture/assets?kind=agent|use_case&limit=1..100&cursor=` — one page in name order, keyset on
  (name, id), default 25, at most 100; `nextCursor` is null on the last page. The page is scored with one query per
  ledger for all its rows (no N+1).
- `GET /v1/reports/posture/assets/:kind/:assetId` — one asset.

**Object-level authorisation.** Both routes are open to any authenticated user (NON_ADMIN_ROUTES) and scope in the
handler to what the caller can already read: an admin sees every asset; anyone else sees the agents they steward (the
`agent-stewardship.ts` rule) and the use cases they own (the `GET /v1/use-cases` list scope; the detail route also
admits whoever `canReadUseCase` admits). An asset the caller cannot read is the same 404 as one that does not exist.

**Caching.** None on the server. Both responses carry `Cache-Control: private, no-store`, so no cache is shared
between users or outlives the authorisation check made on the request.

### Tests

- `asset-score.test.ts` — golden scores worked by hand from the weights (agent 85, stale red-team 75, orphaned 60,
  empty 0; use case 43, 0, 100), the ranked actions with their points and reasons, the not-applicable list, and no
  "compliant"/"certified".
- `asset-score-authz.test.ts` — two stewards cannot see each other's agents or use cases (404, identical to a missing
  id), an admin sees all, keyset pages, bounds (limit 101, unknown kind and forged cursor refused), `private, no-store`,
  and the served score equals `scoreAsset()` of the seeded ledger rows (73).
- The extraction keeps every ADR-0214 org-wide test green. One arithmetic change rides with it: the estimate now
  divides the whole weighted sum once instead of summing per-term quotients, so an exact half is not lost to float
  error. For the org-wide divisor of 100 the two agree except at such a boundary.

### Honest limits

- **No sort by score.** Pages are in name order; ranking all of a large fleet by score would mean scoring every asset
  on each request. A "worst first" view is a follow-up if the UI needs one.
- **Access hygiene per asset is binary.** It is ownership only; an overdue stewardship review does not cost points.
- **UI not built here.** The per-asset display is requested from the Governed Designer on #453.

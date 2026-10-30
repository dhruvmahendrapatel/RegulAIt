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
   | Audit integrity | 10 | anchoring, as observed | 100 tamper-resistant, 50 rewritable, 0 not anchored |
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

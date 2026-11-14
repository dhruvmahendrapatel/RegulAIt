# ADR-0297: SR 11-7 and NYC Local Law 144 packs, and the evaluator catalog on OWASP LLM 2026 numbering

- **Status**: Accepted (P18 lane B6 and the P24 open item, master brief 2026-11-14; built by builder lane L8 in two PRs)
- **Date**: 2026-11-14
- **Index**: SR 11-7 and NYC LL144 packs; evaluator OWASP LLM ids on 2026 numbering (P18 B6, P24)
- **Backlog**: [PENDING, P18 and P24](../product/PENDING.md); audit [2026-11-07 P18 coverage](../reviews/2026-11-07-p18-framework-coverage.md) lane B6
- **Migration**: none

## Context

The P18 audit rated financial model risk and hiring "partial" and proposed sector packs: SR 11-7 on the ADR-0045 model
risk registry, and NYC Local Law 144 with a bias-audit evaluator on the ADR-0222 fairness runs. P24 left one item open:
the evaluator catalog's `owasp:llm:NN` ids are on the 2025 numbering while `owasp-llm-top-10@2` (ADR-0243) follows the
2026 edition, which renumbers the list. Open source first: no maintained, permissively licensed control set for either
text exists; fairlearn (already the reference for ADR-0222's metrics) computes the selection rates and ratio LL144's
rules define, so no new metric code is needed.

## Decision

### Part 1 — sector packs (first PR)

1. **`sr-11-7@1`**: thirteen controls over parts IV (development, implementation, use), V (validation: conceptual
   soundness, ongoing monitoring, outcomes analysis, effective challenge) and VI (governance: inventory, annual review,
   policies, roles, internal audit, vendor models, documentation) of SR 11-7 / OCC 2011-12, on model-card approvals
   (the inventory, effective challenge and vendor models; annual review is **enforced** by approval expiry) and
   evaluation runs. Organisational parts are attestation-required. Every control is on the reliability trust dimension.
2. **`nyc-ll144@1`**: seven controls over NYC Admin. Code §§ 20-870 and 20-871 and 6 RCNY § 5-301. The bias audit
   rests on `model_card_fairness` (an ADR-0222 fairness run computes each group's selection rate and the impact ratio,
   including for a combined sex-by-race attribute); the owner note says the independent auditor and the yearly repeat
   are the employer's to attest. Publication and the candidate notices are attestation-required. The audit controls are
   bias controls; the notices are compliance.
3. Cited by section in our own words; no text reproduced.

### Part 2 — OWASP LLM 2026 ids in the evaluator catalog (second PR)

Recorded with that PR.

## Consequences

- Financial model risk and hiring move from partial to mapped; the bias axis of the trust radar gains two controls.
- Not done: PRA SS1/23, consumer protection (CFPB, FTC s. 5, Colorado) and medical devices (B6's later items).

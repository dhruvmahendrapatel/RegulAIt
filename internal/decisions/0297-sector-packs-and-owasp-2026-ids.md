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

1. **`sr-11-7@1`, a historical mapping of superseded guidance.** SR 11-7 was superseded and replaced on 17 April 2026
   by SR 26-2, "Revised Guidance on Model Risk Management" (Federal Reserve, OCC and FDIC). Footnote 3 of SR 26-2 puts
   generative AI and agentic AI models outside its scope. We keep `sr-11-7@1` (review option b) rather than re-basing
   on SR 26-2 in this PR, because some institutions still map their programme to the 2011 text, and a re-based pack
   needs every section re-checked against the 2026 text. The title, description, `catalogueRevision` and
   `provenance.note` all say "superseded" and state SR 26-2's scope, so no reader takes it for current guidance or for
   guidance on LLMs and agents. A test pins the label (`SR_11_7_SUPERSESSION_NOTE`). An `sr-26-2@1` pack is a later
   item.
   - Thirteen controls cover parts IV (development, implementation, use), V (validation: conceptual soundness,
     ongoing monitoring, outcomes analysis, effective challenge cited "III, V", annual review, vendor and third-party
     products) and VI (governance: inventory, policies, roles, internal audit, documentation). The slugs carry the
     part (`v-periodic-review`, `v-vendor-models`).
   - The annual review is **partial**, not enforced. Its frequency follows each approver's `validUntil`; nothing caps
     it at a year; and a sign-off recorded as never expiring (`acknowledgeNoExpiry`) still counts in
     `model_cards_approved`. The dispatch gate (`mrmEnforced`, on by default, ADR-0181) refuses a lapsed approval. The
     owner attests that every recertification date is within a year. No SR 11-7 control claims "enforced".
   - Organisational parts are attestation-required. Every control is on the reliability trust dimension.
2. **`nyc-ll144@1`**: seven controls over NYC Admin. Code §§ 20-870 and 20-871 and 6 RCNY § 5-301.
   - The bias audit rests on `model_card_fairness`: an assessment documented on the model card, ungraded and with no
     time window. The owner note says the independent auditor, and the audit within the year before use, are the
     employer's to attest.
   - The impact-ratio control says what the platform does and does not compute:
     - ADR-0222 fairness runs report each group's selection rate for binary predictions, from which each category's
       impact ratio follows. They report one min/max ratio per attribute, not the per-category table.
     - Score-output tools need the median-based scoring rate, which runs do not compute.
     - Runs drop groups under 30 rows from every count. This differs from the rule's optional exclusion of categories
       under 2%.
   - The notice titles carry the statutory timing and scope: residents of the city; at least ten business days before
     use; and for (b)(3), on the website or within 30 days of a written request.
   - Publication and the candidate notices are attestation-required. The audit controls are bias controls; the
     notices are compliance.
3. Cited by section in our own words; no text reproduced.

### Part 2 — OWASP LLM 2026 ids in the evaluator catalog (second PR)

Recorded with that PR.

## Consequences

- Financial model risk and hiring move from partial to mapped; the bias axis of the trust radar gains two controls.
- Not done: an `sr-26-2@1` pack on the revised guidance; PRA SS1/23, consumer protection (CFPB, FTC s. 5, Colorado) and medical devices (B6's later items).

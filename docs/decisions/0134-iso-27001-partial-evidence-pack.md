# ADR-0134 - ISO/IEC 27001 partial evidence pack

- Status: Accepted
- Date: 2026-09-30
- Amends: ADR-0058 seed catalogue

## Decision

Ship an ISO/IEC 27001:2022 pack as versioned seed data under the existing
compliance-pack evaluator. It maps selected Annex A references to platform
configuration or ledger counts, marks all automated mappings `partial`, and
requires a named human attestation for risk treatment/applicability and internal
audit. The pack has no cascade preset and changes no enforcement posture.

This is neither a Statement of Applicability nor a certification. The customer
must decide which controls are necessary for its own risks, justify inclusion
and exclusion, and assess effectiveness beyond this platform. Amendment
1:2024 is acknowledged in provenance but not asserted as implemented.
Control text is paraphrased, not reproduced.

## Evidence boundary

An ABAC policy, an audit row, or a configured DLP guardrail proves only that
the specified platform record exists. It cannot establish organization-wide
access control, log completeness/review, or DLP detection quality. The pack
therefore includes owner notes and never labels these mappings `enforced`.

## Verification

The shared seed/schema suite passes 18 tests, including the pack's partial
coverage and SoA/certification disclaimers. The gateway pack suite passes 15
tests, including seed installation and idempotence. Gateway collector behavior
is unchanged; no new evidence source or external audit was added.

## Sources

- ISO/IEC 27001 overview: https://www.iso.org/standard/27001
- ISO/IEC 27001 Auditing Practices Group, Annex A:
  https://committee.iso.org/files/live/sites/jtc1sc27/files/resources/ISO-IECJTC1-SC27-WG1_N3297_Auditing%20Practices%20Note%20-%20Annex%20A.pdf
- ISO/IEC 27001 Auditing Practices Group, Statement of Applicability:
  https://committee.iso.org/files/live/sites/jtc1sc27/files/resources/ISO-IECJTC1-SC27-WG1_N3298_Auditing%20Practices%20Note%20-%20SoA.pdf
- Amendment 1:2024: https://www.iso.org/standard/88435.html

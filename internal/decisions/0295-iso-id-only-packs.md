# ADR-0295: ISO/IEC 42001 widened, and ISO/IEC 23894 and 42005 packs, cited by identifier only

- **Status**: Accepted (P18 lane B4, master brief 2026-11-14; built by builder lane L8)
- **Date**: 2026-11-14
- **Index**: ISO/IEC 42001@2 (every clause and Annex A), 23894@1 and 42005@1, ID-only (P18 B4)
- **Backlog**: [PENDING, P18](../product/PENDING.md); audit [2026-11-07 P18 coverage](../reviews/2026-11-07-p18-framework-coverage.md) lane B4
- **Migration**: none

## Context

The P18 audit rated ISO/IEC 42001 "partial (4 controls)" and 23894 and 42005 "missing". ISO/IEC standards are
copyrighted and sold, so no text may be stored (ADR-0176; ADR-0215 decision 2): packs cite clause identifiers and
describe each clause in our own words, as `iso-42001@1` already did. Open source first: no permissively licensed
machine-readable form of these standards exists; the clause structure was checked against each standard's published
table of contents (ISO's own preview requires accepting its terms, so the publicly posted preview samples of the
same editions were used), and only numbers were taken from it.

`iso-42001@1` cites its impact-assessment control as `8.3-ai-system-impact-assessment`. In ISO/IEC 42001:2023 the
impact assessment is 8.4; 8.3 is AI risk treatment. intake-assist, the demo regulatory feed and the decision-regression
goldens cite the v1 ref.

## Decision

1. **`iso-42001@2`**: every requirement clause (4.1 to 10.2, 26 controls) and all 38 Annex A controls, plus v1's
   three valid controls carried over byte for byte (5.3, 9.1, and the A.6 lifecycle group the evaluator catalog
   cites). v1 is never edited (ADR-0058). v2 uses the correct `8.4-ai-system-impact-assessment` with v1's evidence
   and adds `8.3-ai-risk-treatment`; the ADR-0087 diff shows the admin one removed control and no changed one.
2. **`iso-23894@1`**: the framework (5.2 to 5.7) and process (6.2 to 6.7) subclauses, 18 controls. 23894 is guidance;
   the pack maps it, it does not claim it is followed.
3. **`iso-42005@1`**: the process (5.2 to 5.12) and documentation (6.2 to 6.9) subclauses, 19 controls. Four controls
   name P18 lane C1 (the impact-assessment record, not built) as what would evidence them.
4. **Coverage on existing collectors only.** Organisational clauses are attestation-required and say what to attest;
   collectors used are policy and training acknowledgements, model-card approvals, approvals, ABAC policies, lineage,
   usage attribution, eval runs, detector configuration, the incident register, the feedback channel and audit
   decisions. Each attested control gets a trust dimension from `ISO_PACK_DIMENSIONS` (organisational → compliance,
   data clauses → privacy).
5. **22989** (vocabulary) is not a pack: it has no requirements to evidence. A glossary is out of this lane.

## Consequences

- ISO/IEC 42001 moves to full clause coverage by identifier; 23894 and 42005 move from missing to mapped.
- Every title is our wording; a reader needs the standard for its requirements. No conformity claim is made.
- **Follow-up (PENDING fragment):** move intake-assist, the demo feed and the decision-regression goldens from the v1
  `8.3-ai-system-impact-assessment` ref to `8.4-ai-system-impact-assessment` once v2 is the active pack in the demo;
  those files are outside this lane.
- Console labels for the two new frameworks are a UI item (#453).

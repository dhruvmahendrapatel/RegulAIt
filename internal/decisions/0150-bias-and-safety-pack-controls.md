# ADR-0150: Bias and Safety Controls as Second Pack Versions

Status: Accepted (implemented)
Date: 2026-10-01
Related: ADR-0148 (trust dashboard), ADR-0058/0087 (packs, versioning and
diff), ADR-0063 (model cards); demo task C1b in `AgentCoordination.md`
Migration: none (collector names are data; no DB constraint)

## Context

ADR-0148 recorded that no default pack control evidences bias, so the trust
dashboard's bias axis is a gap on every install, and safety rested on one
attestation-only control. Both frameworks the demo activates name these
obligations: EU AI Act Art. 10(2)(f) (examination for possible biases) and
NIST AI RMF MEASURE 2.11 (fairness and bias) and 2.6 (safety).

## Decision

1. **A collector `model_card_fairness`:** model cards documenting at least one
   *completed* (`assessed`) bias/fairness assessment. Documentation evidence
   — the platform records that an examination was done and where its result
   lives; it does not compute or grade fairness. An `in_progress` entry is
   not evidence (tested).
2. **New versions, not edits:** `eu-ai-act@2` adds
   `eu-ai-act:art-10-bias-examination`; `nist-ai-rmf@2` adds
   `nist-ai-rmf:MEASURE-2.11` (fairness, the collector above) and
   `nist-ai-rmf:MEASURE-2.6` (safety, toxicity guardrail at block). Each v2 is
   exactly v1's controls plus the additions (tested), so an activated v1 keeps
   producing its reports and activating v2 retires v1 through the normal path
   with its diff on record.
3. **Demo setup activates the latest version** of each demo framework.

## Consequences

- A deployment that keeps v1 active still shows bias as unmeasured — correct.
- Seeding now creates ten pack rows, not eight. The catalogue test asserted
  "the first seed creates everything", which only held when it ran before any
  other seeding suite; it now asserts the first seed creates exactly what is
  missing (M-040). Proved by seeding with another suite first.

## Verification

- Shared: full suite 1102/1102, including trust-dimensions 5/5 (v1 reaches
  five dimensions, v1+v2 all six; v2 = v1 + additions with unique refs; the
  two bias controls are exactly the two named above) and the catalogue's
  framework@version list.
- Gateway on fresh databases: the trust dashboard suite 5/5 — activating
  `eu-ai-act@2` makes bias measured; an `in_progress` card does not move it; an
  `assessed` card evidences it to 100%; v1 is restored after. All twelve
  pack-consuming suites pass (130 tests); `compliance-packs.test` passes both
  first-in-order and after another suite seeded the catalogue.

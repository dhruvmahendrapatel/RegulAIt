# ADR-0147: Trust Dimensions, Declared Residual Risk and Control Links

Status: Accepted (implemented)
Date: 2026-10-01
Related: ADR-0081/0087 (risk register), ADR-0063 (MRM), ADR-0042 (guardrails),
ADR-0058 (collectors); demo plan in `AgentCoordination.md` (task C4)
Migration: 0123

## Context

The governance dashboard for the 2026-10-05 intake demo shows six trust
dimensions — bias, security, privacy, reliability, safety, compliance — as a
radar. The register's nine categories covered none of bias or safety, and a
risk had only an inherent position: no residual position and no link to the
controls that mitigate it. Credo models inherent → residual scoring with
linked controls; the register must show mitigation, not only a catalogue.

## Decision

1. **Two categories**, each with resolvers that report only what a ledger can
   show:
   - `bias_fairness` → `model_card_fairness`: model cards' documented
     bias/fairness entries by status. Reported as *configuration* evidence
     with the explicit statement that the platform computes no disparity
     metric — an attestation, never a measurement.
   - `unsafe_output` → `output_safety_config` (toxicity and jailbreak
     detectors at block) and `guardrail_blocks` (`guardrail-blocked` denials
     in the window).
2. **Six trust dimensions** (`TRUST_DIMENSIONS`, fixed axis order) with a
   total `RISK_CATEGORY_DIMENSION` map: every category belongs to exactly one
   dimension (tested), so the dashboard never drops or double-counts a risk.
   `budget_overrun` sits under compliance (an unauthorized spend breaches an
   approved control).
3. **Residual position** `residual_likelihood/impact`: the same declared
   three-level scale as the inherent one — still no arithmetic, no blended
   score (ADR-0087's rule stands). Both or neither (DB CHECK + schema),
   owner-or-admin, refused on accepted/closed risks, audited
   (`risk-residual-set`).
4. **Control links** `ai_risk_controls(risk_id, control_ref)`: a link must
   name a `controlRef` some compliance pack defines (422 otherwise — a
   mitigation claim with nothing behind it is refused), is idempotent (409),
   removable, and audited (`risk-control-linked/unlinked`). List and detail
   responses carry the links with the pack control title.

The 5×5 scale Credo uses was considered and rejected for now: moving to five
levels changes every existing row and would imply a precision these declared
judgments do not have. Revisit if customers ask for it.

## Verification

- `packages/shared/src/risks.test.ts` 15/15: dimension map is total and
  ordered; new categories have library entries and non-`none` resolvers;
  residual both-or-neither.
- `apps/gateway/src/zz-adr0147-risk-residual-controls.test.ts` 4/4 on a fresh
  database: new categories store and report their evidence kind honestly;
  residual set/clear/audit, stranger 403, decided-risk 409 after a positive
  control; link/duplicate/invented-ref/unlink/audit; list carries links.
- Route-class and OpenAPI registry suites pass with the three new routes
  classified.

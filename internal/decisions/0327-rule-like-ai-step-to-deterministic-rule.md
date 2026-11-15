# ADR-0327: Replace a rule-like AI step with a deterministic rule (detect, suggest, shadow, approve, revert)

- **Status**: Accepted (owner direction 2026-11-15 via lane E12 brief; slice 1 built)
- **Date**: 2026-11-15
- **Index**: **Rule-like AI step → deterministic rule (pillar 6): find AI steps whose output is an exact-match function of a few input fields (held-out agreement, strict org-tunable floors), suggest a readable rule table with test cases and projected savings, run it in shadow, switch only on an approval, revert in one action; inputs outside the table always fall back to the AI. Off by default.**
- **Backlog item**: owner direction 2026-11-15 (lane E12, item 1); PENDING fragment `2026-11-15-e12-rule-like-steps-pending.md`
- **Built in**: lane E12, one PR per slice (slice 1: this ADR and the detector in `packages/optimizer-kernel/src/rule-induction.ts`)
- **Migration**: none in slice 1; slice 2 adds `pending/rule_step_settings.sql` (settings and suggestions), numbered at merge
- **Related**: [TOKEN_OPTIMIZATION_SPEC §8, §12](../product/TOKEN_OPTIMIZATION_SPEC.md), ADR-0172 (builder agents),
  ADR-0044 (eval harness), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (3NF, security
  checklist), ADR-0251 (one governed decision core), ADR-0252 (merge-time numbering), the repetitive-ask lane item (repetitive ask →
  smaller model, the same shadow/approve/revert pattern)

## Context

Owner direction (2026-11-15), quoted from the lane brief: "detect workflow steps that use AI but behave like fixed
rules, and offer to replace them with a deterministic script to save cost." Opt-in local fine-tuning is post-pilot
(recorded separately, post-pilot) and is not part of this decision.

Facts read from the code on `main` (19f2a1f1):

- The workflow kernel has no AI classification stage type (`EXECUTABLE_STAGE_TYPES`,
  `packages/workflow-kernel/src/index.ts`). The AI steps that triage, label, route and summarise are builder agents
  (ADR-0172; `apps/gateway/src/builder-catalog.ts`, e.g. `incident-triage`), run by `runBuilderTurn`
  (`builder-runtime.ts`), and the LLM review check (`workflow-review-checks.ts`).
- Each governed call can leave a `trace_spans` row with `input_preview` and `output_preview` when capture is on, linked
  to `usage_events` (measured `cost_usd`) by `usage_event_id`. Estimated savings go to `cost_events` with a `technique`
  and an `estimation_basis`, and project cost reporting already sums them per technique.
- Approvals are rows in `approvals` decided through `POST /v1/approvals/:id/decide`, which dispatches on `object_type`
  to an `apply…ApprovalDecision` function in the same transaction.
- The deployment is single-tenant: "per org" settings are a singleton row (`model_drift_settings` is the pattern:
  `enabled` default false, step-up to relax, audit row in the same transaction).
- There is no in-process script sandbox in the repo (no isolated-vm, QuickJS or `node:vm` in product code).

Open source search (ADR-0176): `ml-cart` (MIT) last released 2022-01 and fails "maintained"; `decision-tree` (MIT) is
ID3 over categorical fields only, last released 2025-09 (over 12 months), with a lodash dependency; `ml-random-forest`
depends on `ml-cart`. `ydf` (Apache-2.0) ships inference-only JS packages last released 2024. scikit-learn (BSD-3) is
maintained but needs a Python engine image. Exact-match table induction itself is a group-by with a held-out check,
about 150 lines, and the thresholds and fallback semantics are RegulAIt policy, so slice 1 writes it. Decision-tree
induction over numeric ranges is deferred to a sandboxed engine image with scikit-learn, following the existing
`engines/` pattern, if exact-match tables prove too narrow.

## Decision

1. **Detector (slice 1, read-only).** `induceStepRule(runs, options)` in `@regulait/optimizer-kernel` takes one step's
   recorded runs (structured input fields and the output) and returns the smallest set of input fields (0 to
   `maxFields`) whose exact-match table reproduces the output, or a reason it is not rule-like.
   - Agreement and coverage are measured on held-out folds (deterministic, by run index), never on training rows.
   - A cell is trusted only with at least `minCellSupport` runs and a majority share of at least `minAgreement`.
     Impure and thin cells are left out and fall back to the AI.
   - Outputs must be enumerated (at most `maxOutputClasses` distinct values after trimming and collapsing whitespace;
     case is kept). Free text is never rule-like.
   - Strict defaults: `minRuns` 200, `minAgreement` 0.99, `minCoverage` 0.9, `minCellSupport` 5, `maxFields` 3.
     An org may tighten any of them and relax only down to the floors (50, 0.95, 0.5, 3). Search size has hard ceilings
     (`maxFields` 4, `maxCandidateFields` 32, `maxRuns` 20 000, `maxCells` 1 000). Worst case at the defaults
     (5 000 runs, 24 candidate fields) is about 3 s, so detection runs as a background job, not on a request.
   - Inputs are extracted from a recorded JSON object (top level and one nested level of scalars). A preview that is
     not a JSON object, including a truncated one, is skipped, never guessed.
2. **Suggestion (slice 2).** For a rule-like step the gateway stores a suggestion: the rule table rendered readably
   (one line per cell, "when severity = high and source = phone → on-call"), test cases drawn from history (each cell's
   recorded runs, plus fallback cases), and the projected monthly saving from the step's measured `usage_events` cost
   over the last 30 days times coverage. The "script" is **data, not code**: a table executed by `applyInducedRule`.
   Nothing is generated, compiled or evaluated, so it has no network, no file system and a runtime bounded by the
   number of cells by construction. This is a stricter posture than a sandboxed script, and it is the reason no sandbox
   is added.
3. **Shadow, approval and switch (slices 3 and 4).** Shadow mode runs the rule beside the AI for a configured period
   and records agreement on live traffic. The switch is an `approvals` row (`object_type` `rule_step_switch`) decided by
   a person through the existing queue; the decision, the switch and every revert are audited. Revert is one action and
   needs no approval. While switched, an input the table does not cover goes to the AI as before, and the rule's
   served share is reported as a `cost_events` technique (`rule_replacement`) with its estimation basis.
4. **Off by default.** A singleton settings row (`enabled` false): while off, nothing is computed. Enabling,
   relaxing a threshold and switching are step-up and audited (the `model_drift_settings` pattern).
5. **Scope guard.** This applies to AI steps that triage, route, label, classify, extract fields or produce templated
   summaries. It never applies to an authorisation decision: those go through the policy kernel and never call a
   model. The detector is fed only rows the caller may already read; it changes no routing or entitlement.

## Consequences

- Admins get a cost lever that is explainable: a table a person can read, with the evidence that produced it.
- A rule only covers inputs it has seen often enough; anything new still goes to the AI, so coverage, not accuracy, is
  what a switch gives up.
- The detector only sees what tracing captured. Where capture is off or inputs are not JSON, no step is ever
  suggested; slice 2 reports that count rather than hiding it.
- Numeric thresholds ("amount > 1000") are out of scope until a decision-tree engine lands.
- Security review note (not a finding under the scope guard): `workflow-review-checks.ts` lets an LLM review verdict
  fail an `automated_check` stage. It is a quality gate, fails closed and is not an authorisation decision; it stays
  as designed.

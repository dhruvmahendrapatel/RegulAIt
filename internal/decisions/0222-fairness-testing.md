# ADR-0222: Fairness and bias testing for a model card

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

[ADR-0045](0045-model-risk-management.md) records bias and fairness on a model card as a declared assessment: the card
says what was assessed and links evidence, but RegulAIt itself measures nothing. PENDING.md §2c P7 and P13 named this
gap. On 2026-10-30 the owner decided to build all four P13 parts, each as its own default-off lane (#453 c6527069781);
this ADR is part (a), fairness and bias testing. The reservation is migration 0243 and this ADR number (#453
c6527158879). Runtime detectors are P7 and classical-model drift is P13(b); neither is built here.

What a customer needs is the standard group-fairness check a model-risk reviewer asks for: on a labelled evaluation
dataset, does the model favour one group over another, measured by named metrics against stated thresholds, with the
result attached to the risk record and able to hold the model.

## Decision

1. **A fairness run measures group metrics on an uploaded, labelled dataset, for one model card.** Each row of the
   dataset holds the true outcome, the model's prediction and one or more protected attributes (up to five, up to 50
   groups each, binary outcomes, up to 100,000 rows and 5 MiB). The gateway computes, per attribute: demographic parity
   difference, disparate impact ratio, equal opportunity difference and equalised odds difference, plus each group's
   selection rate, true positive rate and false positive rate. The predictions are the ones in the file: RegulAIt does
   not run the model against the dataset, and every response and screen says so.
2. **The definitions are fairlearn's.** The four metrics follow the open-source fairlearn library's definitions
   (`demographic_parity_difference`, `demographic_parity_ratio`, `equal_opportunity_difference`,
   `equalized_odds_difference`). A golden test pins our values to fairlearn 0.13.0's on 240 synthetic rows, to 12
   decimal places; the generator script sits beside the fixture.
3. **Thresholds, with strict defaults.** Each metric has a limit and an action: `fail` (the default) or `flag`. The
   defaults check all four metrics: at most 0.1 for each difference, at least 0.8 for the ratio (the four-fifths
   rule). A group with fewer rows than the minimum group size (default 30) is reported but left out of the metrics.
   The outcome is `fail` if a failing threshold is breached, otherwise `inconclusive` if a checked metric could not be
   computed (fewer than two groups of the minimum size, or a group with no favourable labels), otherwise `flag` if a
   flag threshold is breached, otherwise `pass`. Inconclusive is never read as a pass.
4. **A failing or inconclusive latest run holds the model card.** While blocking is on (the default), a card whose
   latest run failed or was inconclusive cannot be sent for sign-off (409 `fairness_test_failed`), and dispatch under
   it is refused on the model-risk gate's existing 409 path (`mrm_approval_required`, audit rule
   `fairness-dispatch-held`). A dispatch that evaluates the agent (an eval case or red-team probe) is not held, as with
   staleness. A card with no run is not held. Turning blocking off records results without holding anything.
5. **Off by default, and turning it on is a relaxation.** Three org settings (migration 0243): fairness testing off,
   blocking on, datasets kept 30 days (1 to 365). Turning the feature on starts storing protected attributes, so it
   needs a `settings_relax` step-up, as do turning blocking off and a longer retention (judged against the strict
   default and the stored value). They are written by `PUT /v1/mrm/fairness/settings`, not the general settings PUT,
   with a compare-and-set and the audit row in the same transaction.
6. **Datasets are minimised, encrypted, admin-only, audited and retention-bounded.** Only the outcome, prediction and
   protected attribute columns are kept; every other column of the upload is dropped before storage. The kept rows are
   enveloped under the data key (`fairness_datasets.rows_ciphertext`, registered for the custody probe and the
   re-encryption walk). No route returns rows or ciphertext. Refusals name a line and a column, never a cell, and
   never the CSV parser's own message (which can quote one). Audit rows carry names, counts and the sha256 only. The
   rows are deleted (ciphertext set to NULL) at the retention date by a scheduled sweep or on an admin's delete; the
   metadata row, the sha256 and every run that cites it stay for the audit trail. Runs store aggregates only. Every
   route is admin-only through the default-deny gate; uploads and runs are rate-limited per person.
7. **The run sits on the model card's record.** A run is stored against its card (`fairness_runs.card_id`) with the
   dataset's sha256, the metrics version, the thresholds and the result; its audit row is on the model card. The card
   screen links to its tests, and the hold is read at sign-off and at dispatch. A run is not yet a row in
   `model_card_evidence`: that table feeds the signed AI-BOM evidence format (ADR-0189), and adding a kind there
   changes that format, so it is a follow-up below rather than part of this lane.
8. **The screen sits beside Model risk.** A lazy-loaded "Fairness testing" page in AI Governance, after Model risk
   (placement note on #453, c6527324508): settings, upload, datasets, run, results.

### Open source first (ADR-0176)

Searched npm for "fairness", "fairlearn", "bias-metrics", "disparate impact" and "demographic parity" on 2026-10-30.
No maintained, permissively licensed JavaScript fairness library exists: the fairlearn packages on npm are dashboard
widgets last released in 2019–2020, and the rest are unrelated. fairlearn (MIT) and AIF360 (Apache-2.0) are Python.
Running fairlearn would mean a new Python sidecar image, its isolation and its supply chain, for four closed-form ratios
over a confusion matrix. **Narrow exception:** the formulas are written in `packages/shared/src/fairness.ts`, with
fairlearn as the reference that pins them (decision 2). Re-check when a maintained JavaScript library appears, or when
P7's scorer sidecar can host fairlearn at no extra image cost.

CSV parsing uses `csv-parse` 7.0.3 (MIT, no dependencies, no install script, released 2026-09-25, no OSV advisory),
pinned exactly, listed in the gateway's THIRD_PARTY.md. It works air-gapped.

## Consequences

- A model-risk reviewer can see measured group fairness on a card, and a failing result holds the model until a later
  test passes or an admin turns blocking off (audited, with a step-up).
- The result is only as good as the predictions supplied; the copy says so plainly.
- Postgres row-level security does not apply: each deployment is single-tenant with one org (ARCHITECTURE.md), as for
  every other table.
- Follow-ups, not built in this lane:
  - cite a run in `model_card_evidence` and the signed AI-BOM evidence format (needs an ADR-0189 format change);
  - optionally require a passing run before a card's sign-off (a per-card or per-risk-tier requirement);
  - intersectional groups (combinations of attributes), multi-class outcomes and confidence intervals;
  - re-check the open-source exception when P7's scorer sidecar lands.

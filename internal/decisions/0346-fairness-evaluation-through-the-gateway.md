# ADR-0346: Scheduled fairness evaluation of a model through the governed gateway

- **Status**: Accepted (slice 1 of 3 built: this ADR and the schema; see "As built")
- **Date**: 2026-11-17
- **Index**: Fairness evaluation that runs the model through the gateway: Fairlearn in an isolated engine, schedules, signed evidence on the model card and in compliance packs, breach approvals, an opt-in promotion gate, red-team bias results in the same view (extends ADR-0222)
- **Extends**: [ADR-0222](0222-fairness-testing.md) (fairness testing on uploaded predictions). Everything ADR-0222
  decided stands; this ADR adds to it and changes nothing it says, except where §9 closes one of its follow-ups.
- **Builds on**: [ADR-0045](0045-model-risk-management.md) (model cards), [ADR-0057](0057-continuous-red-teaming.md)
  (red-team bias probes), [ADR-0058](0058-compliance-packs.md) and [ADR-0150](0150-bias-and-safety-pack-controls.md)
  (compliance packs), [ADR-0187](0187-batch5-sidecar-engines.md) and [ADR-0245](0245-spikee-pyrit-redteam-engines.md)
  (sidecar engines), [ADR-0189](0189-batch6-decision-bom-ai-bom.md) (signed evidence), [ADR-0176](0176-open-source-first.md),
  [ADR-0180](0180-continuous-assurance-strict-by-default.md), [ADR-0200](0200-engineering-best-practice-guidelines.md).
- **Migration**: `pending/fairness_evaluation.sql` (numbered at merge).

## Context

The owner asked on 2026-11-17 (builder lane E27) to add fairness evaluation to the responsible-AI controls: scheduled,
explainable fairness evaluation of registered models and agents. An admin defines an evaluation dataset (supplied by
the customer, schema-validated, PII handled by the compliance cascade) and the sensitive attributes to compare;
RegulAIt runs the model through the governed gateway, computes the standard group-fairness metrics against thresholds
and records the result as signed evidence on the model risk card and in the compliance packs. A breached threshold
raises an approvals-queue item and can be made a required gate for model promotion: opt-in per tenant, strict by
default where a compliance tag requires it. The red-team bias probes' results join the same view rather than a
parallel one.

ADR-0222 already measures group fairness, but only on predictions the admin uploads ("RegulAIt does not run the model
against the dataset"). It holds a card whose latest run failed, and it listed as follow-ups: citing a run as card
evidence in the signed format, and an optional requirement for a passing run before sign-off. This ADR builds those
and the parts ADR-0222 left out (running the model, schedules, breach approvals, the red-team view). It adds no second
fairness store, metric module, hold or screen.

**Repository search (ADR-0176 rule 1), 2026-11-17.** `fairness`, `bias`, `demographic parity`, `fairlearn`,
`promotion` across `apps/`, `packages/` and `internal/decisions/`: ADR-0222's `packages/shared/src/fairness.ts`
(metrics, thresholds, small-group suppression), `apps/gateway/src/fairness.ts` (datasets, runs, the hold, the
retention sweep); ADR-0045's `bias_fairness` slots and `mrmDispatchGate`; ADR-0057's `bias` attack class and the
built-in `bias-matched-pair` probe; ADR-0150's `model_card_fairness` collector (which counts declared slots only);
ADR-0187's engine runner, leases, `engine_schedules` and `engine-ledger.ts`; the signed-row pattern of
`ai_bom_snapshots` and `receipt_signing_keys`. There is no model lifecycle "promotion" stage apart from the model
card's sign-off (draft → pending → approved), so that sign-off is the promotion point here.

**Open-source search (ADR-0176), 2026-11-17.**

| Candidate | Licence | Latest release | Verdict |
|---|---|---|---|
| fairlearn 0.15.0 (PyPI) | MIT | 2026-10-12 | **Chosen** for the engine: maintained, MIT, wheel-only (`py3-none-any`), its closure (numpy, pandas, scipy, scikit-learn, narwhals) is BSD/MIT/Apache and installs offline from a hash-pinned lockfile |
| aif360 0.6.1 (PyPI) | Apache-2.0 | 2024-04-08 | Rejected: no release in the last 12 months (ADR-0176 rule 3), and its base install pulls matplotlib |
| aequitas 1.1.0 (PyPI) | not declared in the package metadata | 2026-02-03 | Rejected: licence not stated in the release metadata (ADR-0176 needs it verified), and it is an audit-report toolkit rather than a metric library |
| fairness-indicators 0.52.0 (PyPI) | Apache-2.0 | 2026-07-10 | Rejected: built on TensorFlow Model Analysis, a far larger closure for the same four metrics |
| GitHub search "fairness metrics machine learning" (by stars) | — | — | Trusted-AI/AIF360 is the only maintained library in the top results (the repository is active, its PyPI release is not); the rest are demos and papers |
| npm search "fairness metrics", "fairlearn", "demographic parity" | — | — | Nothing maintained and relevant (as ADR-0222 found on 2026-10-30) |

## Decision

1. **A fairness evaluation is a saved definition on one model card.** It names the card, a dataset, the attributes to
   compare (a subset of the dataset's protected attributes), the thresholds, the minimum group size, a prompt template
   and the two model outputs that count as the favourable and unfavourable decision. The thresholds and attributes are
   rows of their own (`fairness_evaluation_thresholds`, `fairness_evaluation_attributes`), not jsonb lists (ADR-0200
   addendum). ADR-0222's strict defaults and its hard floor of 30 for the minimum group size apply unchanged; a
   definition looser than the defaults is a relaxation that needs a `settings_relax` step-up when it is saved, and
   the run records it (ADR-0222 decision 3).
2. **A model-input dataset.** ADR-0222's `fairness_datasets` gains a kind: `supplied_predictions` (ADR-0222, the
   default for every existing row) or `model_inputs`. A model-input dataset holds the true label, the protected
   attributes and one to eight input columns (rows of `fairness_dataset_input_columns`), and no prediction column; the
   database ties the kind to the prediction column's presence. The upload is validated against a declared schema
   (column names, the label values, cell and row limits) and refused with a line and column, never a cell, as in
   ADR-0222. Rows are minimised, enveloped under the data key, admin-only and deleted at the retention date, exactly
   as ADR-0222 decision 6.
3. **PII follows the compliance cascade.** At upload, every input cell is scanned with the gateway's PII detector. The
   mode is the strictest of the org default PII mode and the PII mode of the target card's project
   (`projectPiiMode`): `block` refuses an upload with any finding (naming the column and line, never the value),
   `redact` stores the redacted text, `warn` and `log` store the text and record the count. The dataset row keeps the
   mode it was checked under and the finding count as a point-in-time snapshot. The model calls then go through the
   gateway, which applies the run's own PII mode again, so a stricter tag added later still governs every call.
4. **RegulAIt runs the model through the governed gateway, in an isolated engine.** A run is an ADR-0187 engine run of a
   new sidecar engine, `fairlearn`, packaged exactly as garak and spikee are: a runner and a task in one image built
   from `engines/fairlearn/`, every base pinned by digest, fairlearn 0.15.0 and its closure installed offline from a
   hash-pinned `requirements.txt` with the licence gate, an offline proof at build time, no network in the task but the
   gateway channel, and off until its first signed image publish. The task fills the prompt template per row, calls
   the card's model through the gateway's OpenAI-compatible endpoint with the run's virtual key (so entitlement, cost
   attribution, the per-run budget, PII mode, guardrails and audit all apply to every call), maps each reply to
   favourable, unfavourable or unparseable by exact match after trimming and case-folding (no judge model, no fuzzy
   match), and computes the group metrics with `fairlearn.metrics.MetricFrame`.
5. **The gateway decides; fairlearn is checked, not trusted.** The engine returns each row's mapped prediction (never
   the reply text) and fairlearn's metric values. The gateway applies ADR-0222's small-group suppression and computes
   the metrics again with `computeFairness`; it records the run only when both agree to 1e-9 on every metric. A
   disagreement, a missing value or an unparseable share above the definition's cap (default 0, at most 5%) makes the
   run `inconclusive`, which holds the card (ADR-0222 decision 4). The result lands as an ordinary `fairness_runs` row
   (mode `model`, linked to its evaluation and its engine run), so ADR-0222's hold, staleness and screens read it
   unchanged. ADR-0222's narrow exception for supplied-prediction runs stands: they need no engine, and the golden test
   ties their formulas to fairlearn.
6. **Schedules reuse `engine_schedules`.** A definition may carry an interval (1 to 720 hours, as every engine
   schedule); the schedule row holds the engine-run request and the person it runs as, and the existing sweep starts
   each run. A definition with no schedule runs on demand.
7. **Every result is signed evidence on the card and in the packs.** Each run, supplied or model, gets one
   `fairness_run_evidence` row: the canonical JSON body (text, never jsonb), its sha256 checked by the database, and an
   Ed25519 signature under the receipt signing key (`receipt_signing_keys`), the shape of `ai_bom_snapshots`. The row
   is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE (migration 0185's rule). `model_card_evidence` gains
   the kind `fairness_run` (ON DELETE RESTRICT, like a cited eval run), closing ADR-0222's first follow-up and changing
   the ADR-0189 evidence format by one evidence kind. ADR-0150's `model_card_fairness` collector counts a card with a
   signed, passing, non-stale run as measured evidence, alongside the declared slots it counts today, and a pack names
   which of the two it found.
8. **A breach raises an approvals-queue item.** A run whose outcome is `fail` or `flag` opens one item in the one
   Approvals Queue (`approvals.object_type` `fairness_breach`, a TS-only value as ADR-0045 did), bound to the run's
   evidence sha256, assigned by the queue's usual routing for the card's owner, with every separation-of-duties guard
   the queue applies. Approving records a risk acceptance with a reason and an end date of at most 90 days
   (`fairness_breach_reviews`); while it is in force the run no longer holds the card, and its evidence still shows
   the breach. Denying, or the acceptance lapsing, keeps the hold. A later passing run supersedes the item. An
   `inconclusive` run raises no item: there is nothing to accept, only a test to fix.
9. **The promotion gate: opt-in per tenant, forced by a compliance tag.** A new org setting
   `fairness_promotion_gate` (default **off**) and a new compliance-profile column `fairness_gate_required`
   (OR-composed across a project's profiles, like ADR-0045's `mrm_required`; NULL and false never relax the org
   setting). Where the gate applies, a model card's sign-off (its promotion) needs a fairness run on the card's
   current model version that passed, or whose breach is accepted, no older than `fairness_run_max_age_days`
   (default 90, 1 to 365). This is ADR-0222's second follow-up. Turning the org gate off is a stepped-up, audited
   relaxation; a tag that requires it cannot be overridden by the org setting.
10. **Red-team bias results in the same view.** `GET /v1/mrm/cards/:id/fairness` returns the card's fairness runs
    (supplied and model), its evaluations and schedules, open breach items, the gate's verdict and the card agent's
    red-team results for the `bias` attack class (ADR-0057's runs and engine runs, read from the existing red-team
    tables, not copied). The red-team results are shown as a separate section with their own verdicts; they never
    change a fairness outcome.
11. **APIs, no new screen in this lane.** The routes sit under `/v1/mrm/fairness/evaluations` and
    `/v1/mrm/cards/:id/fairness`, admin-only through the default-deny gate, rate-limited as ADR-0222's, with audit rows on
    the model card. Each new route is in the route census as a known UI gap tracked on #453; the existing Fairness
    testing page gains them in a UI lane.
12. **Row-level security.** The new tables are admin-only under RLS (ENABLE and FORCE), with the `system_task` reason
    for the scheduler and `credential_request` for the engine runner's result on the run-related tables, and
    `migration`; nothing else reads them.

### Secure-by-default notes (ADR-0180)

- Every new setting starts strict except the org promotion gate, which the brief makes opt-in. The reason is ADR-0222
  decision 4's: many cards (a general assistant) have no binary decision a fairness dataset could cover, so a default-on
  gate would refuse every such card's sign-off. Where a compliance tag requires it the gate is on and cannot be relaxed.
  **Owner question open:** should a risk tier (rather than only a tag) also force the gate?
- The engine is off until its first signed image publish, and a model run needs fairness testing turned on (ADR-0222's
  stepped-up setting).

## Consequences

- A reviewer can see on one card what the model actually did on a fairness dataset, run by RegulAIt under governance,
  signed, on a schedule, with red-team bias results beside it.
- One more sidecar image to build, sign, scan and keep patched; its closure (numpy, pandas, scipy, scikit-learn) is
  large. It is accepted because the model calls must run isolated with a revocable key, as every other engine's.
- The metrics are computed twice (fairlearn in the engine, `computeFairness` in the gateway). That is deliberate: the
  engine's output is untrusted, and two independent implementations agreeing is stronger evidence than either.
- Follow-ups: intersectional groups, multi-class outcomes and confidence intervals (ADR-0222's list); a judge-model
  mapping for free-text outputs, which this ADR excludes on purpose.

## As built

### Slice 1 (this PR): the ADR and the schema

- `pending/fairness_evaluation.sql`: `fairness_datasets.kind`, `pii_mode`, `pii_findings`, the nullable prediction
  column and the kind CHECK; `fairness_dataset_input_columns`; `fairness_evaluations`,
  `fairness_evaluation_attributes`, `fairness_evaluation_thresholds`; `fairness_runs.mode`, `evaluation_id`,
  `engine_run_id`, `unparseable_count`, `metrics_engine` and the mode CHECK; `fairness_run_evidence` (append-only);
  `fairness_breach_reviews`; `model_card_evidence.fairness_run_id` and the widened kind and shape CHECKs;
  `org_settings.fairness_promotion_gate` and `fairness_run_max_age_days`; `compliance_profiles.fairness_gate_required`;
  RLS on the new tables.
- `packages/shared/src/fairness-evaluation.ts`: the definition and model-input dataset schemas, the reply mapping, the
  definition relaxation check and the promotion gate's pure verdict.
- The content-credential guard (ADR-0233) covers `fairness_evaluations.name` and
  `fairness_dataset_input_columns.column_name` (which has a surrogate `id` for the guard's report); the signed
  evidence body is excluded as `signed_evidence`. ADR-0233's generated inventory is regenerated.
- The two status fields have one declared lifecycle each. Slice 1 shipped them as plain transition tables; slice 2
  moved them onto ADR-0348's `defineMachine` (`FAIRNESS_BREACH_REVIEW_MACHINE`, `FAIRNESS_EVALUATION_MACHINE`,
  registered in `STATE_MACHINES`) once that landed, so there is one machine pattern in the app.
- `rule-loosening.ts` classifies `fairness_gate_required` true → false/NULL as a loosening.
- A card whose runs carry signed evidence cannot be deleted (RESTRICT). No evidence row is written until slice 2,
  which makes the card delete route refuse it with a named 409.
- Slices 2 (engine, metrics, evidence) and 3 (gate and APIs) follow in their own PRs.

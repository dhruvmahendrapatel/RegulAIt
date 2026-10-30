# ADR-0223: Drift and explainability for classical (non-LLM) models

- **Status**: Accepted
- **Date**: 2026-10-30
- **Backlog item**: P13(b) in `internal/product/PENDING.md` §2c. Owner decision on #453 (comment 6527069781, 2026-10-30):
  build all four P13 parts, each as its own lane and off by default. Numbers reserved in comment 6527158879
  (migration 0244, this ADR).

## Context

The model register ([ADR-0045](0045-model-risk-management.md)) holds a card per model subject (an agent binding or a
custom provider). It records declared assessments and linked evidence, and [ADR-0086](0086-model-card-autofill.md)
adds a computed block from the ledgers. Nothing in it measures whether a deployed classical model (a credit score, a
churn model, a fraud classifier) still sees the population it was validated on, and nothing records how the model
weighs its inputs. Model risk guidance expects both: ongoing monitoring of input and output stability, and an
explanation of the drivers of a model's output.

RegulAIt does not run the customer's classical models. Their pipelines do, so the data has to come to us. It must
come as aggregates: production feature rows are personal data, and the governance layer has no need to hold them.

Two neighbouring lanes run in parallel and are not duplicated here: P13(a) fairness testing and P16 automatic
re-testing after a model change (#615).

## Decision

1. **Monitors on the model card.** An admin registers a *drift monitor* on a model card: a name, a *reference
   distribution* and alert thresholds. The reference is a list of features, each either a histogram (bin edges and
   counts) or a category table (labels and counts). Its SHA-256 is stored and audited.
2. **Summaries in, statistics out.** A pipeline pushes, or an admin uploads, a *production summary* in the same
   shape for a time window. The gateway computes, per feature:
   - the **population stability index** (Σ (p − q) · ln(p / q));
   - the **Jensen–Shannon divergence** (nats, 0 … ln 2);
   - for numeric features, the two-sample **Kolmogorov–Smirnov distance** D over the shared bin edges, with its
     asymptotic p-value. On binned data D is a lower bound on the raw-sample statistic, and the screen says so.
   Empty bins are floored at 10⁻⁴ and renormalised. A feature is `drift` when any statistic reaches its alert
   threshold, `warn` when PSI reaches the warning threshold, and `insufficient` when it has fewer production samples
   than the minimum. The report takes the worst status (drift > insufficient > warn > within).
3. **Aggregates only.** Every name and label is bounded and run through the existing PII detector; a match is refused
   with the detector category, never the text. Sizes are bounded (200 features, 100 bins or categories each, 500
   importance entries, a 512 KiB body). A summary must name exactly the reference's features; a numeric feature must
   use the reference's bin edges.
4. **Alerts through the one alerts table.** A `drift` report opens or refreshes a `classical_model_drift` episode on
   `governance_alerts` in the same transaction as the report and its audit row, with the owner and due time the
   [ADR-0182](0182-batch-d4-accountability.md) S5 rules derive. The [ADR-0157](0157-governance-monitor.md) monitor
   reads the latest report per monitor and resolves the episode when it is back within thresholds; an `insufficient`
   latest report holds the episode. ChatOps notification uses the existing courier. This is a monitor, not a control:
   no dispatch decision reads these rows.
5. **Explainability as evidence.** An admin (or the pipeline, with an admin's key) records a *global feature
   importance* or a *SHAP summary* produced by the customer's own tooling on the card: a method label, one value per
   feature, an optional note. RegulAIt stores and shows it with its SHA-256; it does not compute it.
6. **Off by default, strict by default (ADR-0180).** A singleton settings row, absent on a first load, means off.
   With it off, reads work and every write is refused (`409 model_drift_disabled`), and the monitor input reports no
   breach, so open episodes resolve. Each of these is a `settings_relax` step-up, audited: turning it on, raising the
   per-monitor hourly cap above 12, lowering the minimum sample count below 100, a threshold looser than both its
   current and its strict value (PSI warn 0.1, PSI alert 0.25, KS 0.1, JS 0.05), and deleting a monitor or an artefact
   (both remove evidence).
7. **Ingestion.** The ingestion route is admin-only, like the rest of the register: a pipeline uses an admin's API key
   (a header credential, so not CSRF-able), and a person uses the page's upload (cookie session, CSRF header). It is
   rate-limited by the gateway's per-credential limiter and by a per-monitor hourly cap counted in the database under a
   transaction-scoped advisory lock, so replicas share one count. A window that ends more than five minutes in the
   future, on the database clock, is refused.
8. **Open source first (ADR-0176).** PSI is the Jeffreys divergence and JS is the Jensen–Shannon divergence; both come
   from `ml-distance` 5.0.0 (MIT, released 2026-09-08, no install script, no runtime network use; its closure is MIT
   and CC0-1.0). Searched and not used: `@stdlib/stats-kstest` (Apache-2.0) runs KS on raw samples, which this design
   refuses to accept; no maintained package computes KS on binned aggregates, and `simple-statistics` (already
   pinned) has no KS or divergence. The narrow exception is therefore the KS cumulative maximum over the bin edges and
   the Kolmogorov survival series (`classical-drift-stats.ts`), about twenty lines, re-checked when a binned-KS
   library appears.

## Consequences

- An admin sees, on the model card, whether each classical model's inputs still look like its validation data, and
  why it decides what it decides, with tamper-evident hashes in the audit chain.
- The ingestion route needs an admin API key. A narrowly scoped ingestion credential (one monitor, write-only) is a
  follow-up; it needs a new virtual-key purpose, which is a shared contract.
- Statistics are only as good as the binning the customer chooses. RegulAIt does not see rows, so it cannot rebin.
- The deployment is single-tenant, so the new tables carry no tenant column for row-level security, like the rest of
  the register.
- Follow-ups: the scoped ingestion credential; prediction-drift presets (a monitor over the model's score is already
  possible as a numeric feature); a drift summary in the ADR-0086 computed block and the AI BOM; retention for old
  reports; linking a drift episode to P16's re-test once that lane merges.

## As built (2026-10-30)

- Migration `0244_classical_model_drift.sql`: `model_drift_settings`, `model_drift_monitors`, `model_drift_reports`,
  `model_explainability_artefacts`. No function or trigger.
- Gateway: `classical-drift-stats.ts` (pure), `classical-drift-monitor.ts` (settings and the monitor input, kept apart
  so the governance monitor imports it without a cycle), `classical-drift.ts` (routes).
- Shared: the `classical_model_drift` rule in `MONITOR_RULES` and the `modelDrift` monitor input.
- Web: a lazy-loaded "Drift and explainability" tab on a card in Model risk.

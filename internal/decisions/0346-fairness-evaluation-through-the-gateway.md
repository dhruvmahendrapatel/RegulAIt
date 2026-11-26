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
   **What is and is not verified (review S8 2 / R8 [2], 2026-11-21).**
   - **Verified by the gateway:**
     - the metric arithmetic (recomputed and compared, as above);
     - that the result names this run, evaluation and pinned input;
     - that every answered row is backed by a model call the gateway itself served under the run's keys since the
       input was placed (its own `usage_events` ledger). Fewer served calls than answered rows is `calls_missing`;
       more calls than rows is `calls_exceed_rows`, which would let an engine choose favourable replies. Either one
       makes the run `inconclusive`.
   - **Still the engine's report:** which reply mapped to which prediction. The signed result says so
     (`predictionsSource: "engine"`, with `servedCalls`, `answered` and `rows`), so a verifier knows what the signature
     covers.
   - Matching each reply's digest to its row is a follow-up.
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
   **Amended (owner, 2026-11-21): a risk tier forces the gate too.** Four org settings,
   `fairness_gate_tier_{prohibited,high,limited,minimal}`, name the ADR-0085 risk tiers whose model cards the gate
   always covers. Secure by default (ADR-0180): `prohibited` and `high` are on, `limited` and `minimal` off
   (migration `fairness_gate_risk_tiers`). A card's tier is its effective ADR-0085 tier: the strictest among the use
   cases that intend its agent, after jurisdiction floors (`effectiveRiskTier`). An unscreened card is not forced by
   tier, since screening is its own sign-off step. An admin may turn a tier off; that is a stepped-up, audited settings
   relaxation, and an admin may also turn a tier on. The sources compose by OR and none relaxes another
   (`fairnessGateRequirement` in `@regulait/shared`): a requiring tag, a forcing tier or the org setting is each
   enough.
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
13. **libgomp is a narrow ADR-0176 exception (owner, 2026-11-21).** The fairlearn image ships the GNU OpenMP runtime
    that scikit-learn's wheel bundles.
    - **What exactly:** `scikit_learn.libs/libgomp-e985bcbb.so.1.0.0`, built by GCC 8.5.0 (2021-05-14), file sha256
      `a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a`. It ships inside the hash-pinned
      `scikit-learn==1.9.1` wheel (sha256 `e5d7b18a5b9dca241a74695f3275fa4c895a9dadc72b3d8df5fa9d1083c9b83e`).
    - **Licence:** GPL-3.0-or-later WITH GCC-exception-3.1. The GCC Runtime Library Exception permits linking and
      distributing it with code under any licence.
    - **Unmet requirement:** scikit-learn's published wheels compile OpenMP in and always bundle libgomp. fairlearn
      requires scikit-learn, and no validated alternative to fairlearn fits (the comparison in the PR).
    - **How it is pinned:** the lockfile (`requirements.txt`, `--require-hashes`) pins the wheel. The licence gate's
      allow entry pins the file's sha256: any other libgomp is DENIED and the image build fails. The gate also refuses
      any owner-accepted GPL-family entry that does not pin its file.
    - **Re-check when:** scikit-learn's version or wheel hash changes; the bundled libgomp changes (the gate fails the
      build first); or scikit-learn ships a wheel without libgomp.
    - **Recorded in:** `engines/fairlearn/licence-allow.json` ("accepted by owner 2026-11-21 (ADR-0346 decision 13)")
      and `engines/fairlearn/THIRD_PARTY.md`.

### Secure-by-default notes (ADR-0180)

- Every new setting starts strict except the org promotion gate, which the brief makes opt-in. The reason is ADR-0222
  decision 4's: many cards (a general assistant) have no binary decision a fairness dataset could cover, so a default-on
  gate would refuse every such card's sign-off. Where a compliance tag requires it the gate is on and cannot be relaxed.
  The high-risk tiers force it by default (decision 9 as amended, owner 2026-11-21); relaxing a tier is audited.
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

### Slice 2: the engine, the gateway's measurement and signed evidence

- **The engine.** `packages/engine-fairlearn` (runner adapter, task, exchange, self-test) and `engines/fairlearn/`
  (the image: the spikee/garak shape, every base pinned by digest, the hash-pinned closure in `requirements.txt`, the
  licence gate on the installed closure, an offline `--network=none` proof that runs `fairlearn_metrics.py`). The
  engine id joins `ENGINE_IDS` as kind `eval` with a null lock entry, so it cannot be enabled until a signed publish
  (pending migration `fairlearn_engine` adds the `engines` row, off). Calls are one at a time; a 402/429 answer stops
  the run `budget_exhausted`, another refusal `gateway_refused`, a 5xx leaves only that row unanswered. The metric
  step reads the kept rows from a scratch file (the engine-runner's spawn guard gives a child no stdin pipe).
  Licence-gate admissions reuse ADR-0187 decision 106 for numpy's and scipy's bundled GCC runtime and quadmath
  libraries. scikit-learn's bundled `libgomp` is the owner's narrow exception (decision 13): an accepted entry pinned
  to the file's sha256, which the gate enforces (a fourth gate addition, file pins).
- **Owner answers folded in (2026-11-21).** Decision 13 (libgomp) and decision 9's risk-tier amendment: the four
  `fairness_gate_tier_*` org settings (pending migration `fairness_gate_risk_tiers`) and the pure
  `fairnessGateRequirement`. Slice 3's gate reads them with the card's effective tier, and its settings route makes
  turning a tier off a `settings_relax` step-up with an audit row.
- **Verified on 2026-11-17:** the closure installs with no network in the pinned `python:3.12-slim-trixie` base
  (`--require-hashes --no-deps --only-binary :all:`, `pip check` clean), and fairlearn 0.15.0 reproduces ADR-0222's
  golden fixture exactly. A local image build passed every step (1.08 GB on disk).
- **The input never passes through the runner.** A fairlearn job directory holds `job.json` and a
  `gateway-input.json` marker; the task bridge turns the marker into the upload's `subject` (ADR-0242's mechanism,
  widened to this one agent-run case), and the gateway's task start builds `fairness-input.json` from the evaluation
  and its encrypted dataset (`fairnessInputTx`) and pins its sha256 in `fairness_engine_inputs` (pending migration
  `fairness_evaluation_engine_input`). A wrong path is refused before anything is pinned. A refusal to build ends the
  run `not_run` with `fairness_<code>`.
- **Bounds of a model run:** at most 2,000 rows (one gateway call each), prompts of at most 16,000 characters after
  the template is filled, an 8 MiB input file and a 2 MiB result.
- **The measurement** (`measureModelRun`): the result must name the run, the evaluation and the pinned input sha256;
  the parseable rows are measured with `computeFairness` and compared with fairlearn's values to 1e-9 (a metric the
  gateway cannot compute is not compared: it is already inconclusive). The run is `inconclusive`, with a closed
  problem code on the result, for no result, an invalid or mismatched result, an engine problem, unparseable replies
  over the cap, a disagreement or purged rows. A cancelled, refused or expired run records nothing.
- **Signed evidence for every run.** `signFairnessRunEvidenceTx` signs the canonical body (`canonicalJson`) with the
  receipt key (ADR-0189), stores it in `fairness_run_evidence` and cites the run as `model_card_evidence` kind
  `fairness_run`; ADR-0222's supplied-prediction runs are signed too. With no usable key the run is kept, no evidence
  row is stored, and an audit row says why.
- **Deviation from decision 3:** a model card has no project, so the upload names the project the evaluation's runs
  attribute to (`projectId`, optional); the PII mode is the stricter of that project's cascade mode and the org
  default, and `redact` stores the redacted text. Model-input datasets hold at most 2,000 rows.
- **The card keeps its evidence.** `DELETE /v1/mrm/cards/:id` answers 409 `model_card_has_fairness_evidence` for a
  card with signed evidence or an evaluation that ran. `mrm.test.ts` and `zz-adr0222-fairness.test.ts` no longer wipe
  such cards in their cleanup.
- **Compliance packs.** ADR-0150's `model_card_fairness` collector also counts a card whose latest run passed on its
  current model version with signed evidence (`fairnessCardMeasuredSql`, a leaf module so the packs import no signing
  code). Naming in a pack which of the two kinds it found is left for slice 3, with the card view.

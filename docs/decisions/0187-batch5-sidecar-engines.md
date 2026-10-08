# ADR-0187: Batch 5 — the sidecar engine contract, promptfoo, modelscan and garak, and the Engines page

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** owner (four decisions, 2026-10-08); two conventional defaults taken by the design pass and marked below as
  open to the owner; the rest follows ADR-0180 (secure by default), ADR-0176 (open source first) and ADR-0177 (how
  open-source projects are admitted)
- **Builds on:** ADR-0183 batch 5 (DELIVERY_PLAN_2026-10-06 §Batch 5), PathForward PF-23 (with PF-04, PF-10, PF-12),
  ADR-0177 §1, §3 and §4, ADR-0184 (own security CI: Trivy, CycloneDX, cosign), ADR-0066 (virtual keys), ADR-0057 and
  ADR-0068 (red-teaming), ADR-0088 (external scorers), ADR-0044 (eval-bound checks), ADR-0180 §4 (A3 required tests),
  ADR-0186 (step-up, vendored detection content, format)

## Context

**What PF-23 asks for** (`PathForward.md`, PF-23): one contract for every external engine that runs as its own process.
The image is pinned by digest and listed in the SBOM; every usage-data and remote-fetch switch is off and an egress test
proves it; egress is denied by default except to our gateway; the run has a killable timeout and a budget; output is
normalised into our existing records; an engine error is `unknown` or `not_run`, never clean; model calls go through the
governed gateway as the person who started the run. One admin page, **Engines** (Integrations group), lists each engine
and vendored content set. DELIVERY_PLAN_2026-10-06 §Batch 5 adds a verified signature, an SBOM entry and a disclosed
reduced set when air-gapped. ADR-0183 orders the batch: the contract first, then promptfoo, modelscan and garak (one PR
each), then the Engines page.

**Constraints from earlier decisions.**
- ADR-0177 §1: a single-maintainer project may not be a required sidecar (only vendored content); never an engine that
  grants access; never an engine failure reported as clean; usage-data switches off and proven by an egress test.
  ADR-0177 §3: no new top-level navigation group; an engine is an option on a page that already exists. ADR-0177 §4: the
  Engines page comes once two engines exist.
- ADR-0180 and CLAUDE.md: every setting defaults to its strict value; a relaxation is audited.
- ADR-0184: our build already uses Trivy, CycloneDX SBOMs and cosign signing; engine images join that pipeline.
- ADR-0176: we write our own code only for the governance parts (contract, normalisation, policy). The engines are
  used, not rewritten.
- ADR-0183: batches 3 to 5 are serial because they share `schema.ts`, the migration journal, `app.ts` and
  `mcp-proxy.ts`.

**What exists on `main` @ 5af81f4 (checked for this ADR).**
- Red-teaming and evals run in-process through `executeGovernedDispatch` (`apps/gateway/src/redteam.ts`,
  `redteam-agentic.ts`, `evals.ts`). Records: `eval_runs`, `eval_results`, `redteam_runs` (pooled `asr` with a Wilson
  interval in `asr_lower`/`asr_upper`, `measurement_quality`, `not_run_probes`, `trigger` typed
  `manual | scheduled | workflow`), `redteam_trials`, `redteam_probe_trials`, `redteam_findings`.
- `eval-catalog.ts`: an evaluator is "tested" only by a completed run that passed. A3 (ADR-0180 §4) counts a class only
  when a completed run on the current configuration hash measured it, by default within 30 days.
- `scheduler-jobs.ts`: the scheduler has no identity; the red-team sweep (`redteam-sweep`) re-runs as the human who last
  ran the probe and skips with a stated reason when that human is gone.
- Workflow `automated_check` stages can carry eval bindings (ADR-0044) that run as the instance initiator; a check that
  could not run fails, and an unreported check stays pending (ADR-0167, AER-047).
- `virtual_keys` (ADR-0066) carry `allowed_models`, `budget_usd`, `expires_at`, `revoked_at` and a `purpose` of
  `dispatch | pdp`; `routesForPurpose` gives an unknown purpose an empty route set. There is no project column: the
  compat routes (`compat-openai.ts`, `compat-anthropic.ts` via `compat-core.ts`) take the project from the caller's
  `x-regulait-project-id` header.
- `egress-guard.ts` denies gateway fetches by default. There is no egress control for containers.
- `trusted-proxy.ts` trusts nothing unless `REGULAIT_TRUSTED_PROXIES` names a hop; its comment already warns about a
  future sidecar forging forwarding headers.
- `docker-compose.yml` has one network (`regulait`, pinned subnet); of its images only SeaweedFS is pinned by digest.
  `scripts/build-image-bundle.sh` builds the air-gap tarball and has no engine support yet.
- Model-scan anchors: `training_artifacts`, `model_cards`, `model_card_evidence` (kind `eval_run | external`, enforced
  by a check constraint), `AdmissionReviewPage`.
- promptfoo's OWASP mapping tables are vendored at `promptfoo@0.123.1`
  (`packages/shared/src/owasp-framework-mappings.ts`).
- Batch 4: the foundation is on `main` (PR #172, migration 0170, the `settings_relax` step-up action defined in
  `packages/shared/src/batch4.ts`, a 501 stub for `GET /v1/detection-content`). The slices that enforce step-up and
  fill the vendored detection content are still on `b4-int` and not merged. Batch 5 depends on both.
- Free numbers: ADR 0187; migration 0172 with journal `when` 1785107000000 (0171 went to the Batch 4 review fix, the approver-role snapshot).

**Verification status** (`docs/research/R9-engine-reverification.md`, task G18, source review only: no engine was
installed or run, no image pulled, no signature or isolation experiment done).
- **promptfoo:** MIT; 0.124.0 released 2026-10-06; the README says "Promptfoo is now part of OpenAI". Telemetry is on
  by default. `PROMPTFOO_DISABLE_TELEMETRY=1` and `PROMPTFOO_DISABLE_UPDATE=1` are documented, but the source routes a
  disabled `record()` to `sendEvent()`, which still calls `fetchWithProxy` unconditionally. The opt-out is therefore not
  a zero-egress switch.
- **modelscan:** Apache-2.0; v0.8.8 released 2026-02-18; ADR-0177 classes it as maintenance only. Under the 12-month
  release rule it lapses around 2027-02. No telemetry is documented.
- **garak:** Apache-2.0 code; v0.17.0 released 2026-09-09 (NVIDIA). Bundled data is mixed: `nyt_cloze.tsv` and
  `potter_cloze.tsv` are copyrighted excerpts that must never ship (ADR-0177). No global usage-data opt-out was found.
  The `ModelAsJudge` detector defaults to a remote NIM model. Hugging Face downloads need separate control.
- **UNVERIFIED for all three:** official images, digests and signatures; air-gapped runtime behaviour (including
  whether `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` fully localise garak); maintainer counts; transitive licences inside
  each image; exit codes and report schemas. These are research task G19 below and gate each engine's PR.

## Decision

### Owner decisions (2026-10-08)
1. **Runtime: sidecar containers.** One long-running runner container per engine, pinned by digest. It pulls work
   from the gateway over a lease, on an internal-only `engines` network. The gateway gets no Docker socket and no
   Kubernetes API access.
2. **Model access only through the gateway.** Each run gets a run-scoped virtual key: owner = the person the run
   executes as, `allowedModels` = the target plus the judge, a budget, an expiry at the run deadline, purpose `engine`,
   and the project pinned on the key. It is revoked at completion, cancel or timeout. Air-gapped, an engine can reach
   only the models the gateway can reach.
3. **All engines off by default.** An admin enables each engine only after its runner's self-test passes. Enabling is
   audited and needs a `settings_relax` step-up.
4. **All three triggers are in scope for Batch 5:** on demand, a workflow `automated_check` stage, and scheduled.
   A scheduled re-run executes as the person who configured it. Agentic or offensive plugin sets, and a run whose
   budget is over the org threshold, go to the approvals queue before they run.

### Defaults taken (not asked; default taken, owner may revisit)
- **Retention.** Normalised results follow the audit-retention cascade. The raw engine report is stored encrypted for
  90 days (an admin may change this; the change is audited), and its sha256 is kept for as long as the normalised
  result.
- **Images.** We build and sign our own engine images from pinned upstream source and do not run upstream images,
  because no upstream image, signature or zero-egress behaviour is verified. For promptfoo we may carry a minimal patch
  that stops the disabled-telemetry path from sending (the `sendEvent` fetch above). The patch is listed in the SBOM and
  the Engines page; network denial stays the real control either way.

### The contract

**Runner (pull model).** Each engine has a thin shim at `engines/<id>/runner` with no listening port. It leases a job
from the gateway, runs the tool as a child process group, sends heartbeats, posts the normalised result, wipes its
tmpfs and loops. The gateway never starts containers. The same protocol later serves a customer-operated runner (BYOC).
A runner leases only jobs for its own engine.

**Runner API.** Authenticated by a per-runner token (`rge_…`, stored as sha256) whose route allow-list is exactly these
routes:
- `POST /v1/engine-runner/register` — one-time enrolment token (minted on the Engines page) exchanged for the runner
  token; the runner reports its image digest, engine version and self-test result.
- `POST /v1/engine-runner/lease` → `{runId, engineId, engineVersion, spec, target: {baseUrl, model, apiKey}, artifacts:
  [{id, sha256, size}], deadlineAt, budgetUsd}` or 204. `apiKey` is the run's virtual key.
- `POST /v1/engine-runner/runs/:id/heartbeat` `{phase, progress}` → `{cancel}`.
- `GET /v1/engine-runner/artifacts/:id` — streamed through the gateway; the runner verifies the sha256.
- `POST /v1/engine-runner/runs/:id/result` — a `regulait.engine-result.v1` envelope.

**Admin and user API.** `GET /v1/engines`, `GET /v1/engines/:id`, `PATCH /v1/engines/:id` (enabled, timeout, budget,
concurrency; a relaxation needs `settings_relax` and is audited with `detail.transitions`), `POST
/v1/engines/:id/self-test`, `POST /v1/engines/:id/enrollment-tokens`, `DELETE /v1/engine-runners/:id`, `POST
/v1/engine-runs` `{engineId, target: {agentId} | {artifactId}, config, projectId, budgetUsd, trials}` → 202, `GET
/v1/engine-runs`, `GET /v1/engine-runs/:id`, `POST /v1/engine-runs/:id/cancel`, `POST /v1/model-artifacts`
(size-capped upload to the object store, sha256 recorded). Schedules and workflow bindings name the same run request.

**Result envelope** (`regulait.engine-result.v1`, a strict shared zod schema under `packages/shared/src/engines/`,
about a 5 MB cap and per-string caps):
- `status`: `completed | failed | timeout | cancelled | not_run`.
- `items[]`: `{key, sourceTaxonomy: {system, id}, mappedClass | null, severity, attempts, defeated, verdict: pass |
  fail | unknown | not_run, reason, dispatchAuditIds[]}`.
- `notRun[]`: `{key, reason}` with reason `cloud_only | excluded_licence | egress_denied | unsupported_format |
  missing_preseed | engine_error`.
- `rawReport`: `{sha256, bytes}`.
- No model text in the envelope; the gateway already holds it by dispatch id.

**Not-clean semantics.** The server recomputes every aggregate (ASR, Wilson interval); it never trusts the engine's
own totals. A missing, invalid or late result makes every item `unknown`. A run that is not `completed` never counts
toward A3 or the eval catalog, and a completed run counts only for the classes it actually measured. The taxonomy map
(promptfoo plugin → OWASP id, garak tag → OWASP id) is a pure, versioned shared table; an unmapped item is reported but
never counts toward A3. Not-run and unknown are never shown as pass.

**Tables (migration 0172, journal `when` 1785107000000; outline, names final in the foundation).**
- `engines`: id, kind `redteam | eval | model_scan`, version, image digest, licence, maintainer count, usage-data
  posture (jsonb), last verified, re-check-by, `enabled` default false, timeout, budget, `max_concurrent` default 1.
  Digest and version are seeded from a shipped manifest; an admin cannot point an engine at an arbitrary image.
- `engine_runners`: token hash, reported digest and version, self-test (jsonb), last heartbeat, `revoked_at`.
- `engine_runs`: status, the person it runs as, project, target, config and `config_hash`, `virtual_key_id`, budget and
  cost, deadline, lease and heartbeat times, `cancel_requested_at`, error code, summary, raw-report sha256 and the
  optional encrypted blob, links to `redteam_runs`/`eval_runs`, trigger `manual | workflow | scheduled`, and the
  approval when one was required.
- `model_artifacts` and `artifact_scans`: sha256, format, verdict `clean | unsafe | unknown | not_run`, issues, scanner
  version.
- `model_card_evidence`: the kind check gains `engine_scan`.
- `virtual_keys`: purpose gains `engine` (routes limited to the compat model routes) and a `project_id` column; a call
  whose project header differs from the key's project is refused.
- `org_settings`, all strict: maximum run timeout (30 minutes default, 2 hours ceiling), default run budget, the budget
  above which a run needs approval, raw-report retention (90 days), and approval required for agentic and offensive
  plugin sets (on). Every relaxation is audited and needs a `settings_relax` step-up.

**Governance hooks.**
- Pillar 1: starting a run needs the same entitlement on the target agent as `POST /v1/redteam/runs`. The engine never
  grants access. Agentic probes stay adjudicate-only (ADR-0068).
- The run-scoped virtual key (owner decision 2) bounds every model call by the owner's ceiling, the allowed models, the
  budget and the deadline. A spent budget makes later calls fail mid-run, and the run reports what it measured.
- Pillar 5: usage rows carry `detail.purpose = "engine:<id>"` and the `engineRunId`; `engine_runs.cost_usd` is summed
  from `usage_events`.
- Kill switch: cancel is delivered on the next heartbeat, and the server revokes the key at once, so later calls get
  401 whether or not the runner stops. A scheduler sweep marks expired leases and passed deadlines `timeout` and
  revokes their keys. The runner is never trusted to stop itself.
- Audit: run start, lease, cancel, timeout, key mint and revoke, and result ingestion (with the raw-report sha256).
  Every ingested string passes the Batch 4 vendored detection scrub.
- Scheduled runs execute as the person who configured them and skip, with a stated reason, when that person is gone or
  no longer entitled. Workflow-bound runs execute as the instance initiator on the instance's project, like eval
  bindings; the check stays pending until the run finishes, and a run that fails, times out or is cancelled fails the
  check.

**Secure defaults.**
- Every engine is disabled. Engine services sit under the compose profile `engines`.
- Enabling needs a passing runner self-test: the reported digest matches the manifest, the usage-data environment is
  present, and an egress probe to an external host, including DNS resolution, fails.
- The `engines` network is `internal: true`. The gateway joins it; the database and object store do not. It is not in
  `REGULAIT_TRUSTED_PROXIES`.
- Runner containers: read-only root filesystem, tmpfs for work, `cap_drop: ALL`, `no-new-privileges`, non-root user,
  memory, CPU and pids limits, and no secret except the runner token. Air-gapped: `pull_policy: never`. Kubernetes: a
  deny-all NetworkPolicy except to the gateway.

**Air-gapped packaging.** Images are built from pinned upstream source (npm lockfile; `pip --require-hashes`) on
digest-pinned bases, with allow-listed data and weights pre-seeded. Each is cosign-signed, scanned by Trivy including a
licence scan that fails on GPL, AGPL, SSPL or BSL, and has a CycloneDX SBOM (ADR-0184). `build-image-bundle.sh` gains
`--with-engines`. Each engine publishes its air-gapped reduced set (the `notRun` reasons) as data.

### Per engine

**promptfoo** (first engine after the contract). Provider `openai:chat` with `apiBaseUrl` set to the gateway's `/v1`,
the run's virtual key and the agent alias. Grading must point at a judge model behind the gateway; otherwise promptfoo
falls back to a remote grader, egress is denied and the result is `unknown`. Remote and cloud generation are off, so
the plugins and strategies that need them are `not_run` with reason `cloud_only` (G19 lists them exactly). The AGPL
`pliny` plugin is `excluded_licence`. Results map into `redteam_runs`, `redteam_probe_trials` and `eval_runs`. Pin the
same release as the vendored OWASP tables (today 0.123.1 against engine 0.124.0; one moves to match the other).
Risks: the disabled-telemetry path still attempts HTTP, so network denial is the control and the egress test proves no
egress succeeded; the change of ownership; its sqlite store and cache live on tmpfs.

**modelscan** (behind the PF-12 model-scanner contract). It scans an uploaded artifact streamed through the gateway and
needs no virtual key. Formats: pickle, PyTorch, Keras, TensorFlow SavedModel; GGUF, ONNX and others are `not_run` with
`unsupported_format`. Results land in `artifact_scans`, model-card evidence and a Model artifacts view in Admission
review. Every artifact is treated as hostile input, so the runner uses a stricter profile (no network at all, smaller
limits). Risk: maintenance only; the fallback is `modelaudit` (MIT, also from promptfoo). fickling stays excluded
(LGPL-3.0, ADR-0177).

**garak.** Its OpenAI-compatible (or REST) generator points at the gateway with the run's virtual key. Probes run from an
allow-list. Excluded: the copyrighted cloze and leak-replay data, and probes that fetch remotely. Probes and detectors
that need Hugging Face models are pinned and pre-seeded with the offline environment set (UNVERIFIED), or else
excluded. `ModelAsJudge` points at a judge behind the gateway or is excluded. `report.jsonl` and the hit log map
through probe tags. Risks: a large image and CVE surface, and provenance checked file by file. The CyberSecEval
datasets (an MIT component inside a Llama-licensed repository) are vendored as eval datasets in the same PR or a
follow-up.

### Engines page

`/admin/engines` in the Integrations group. It lists each engine and each vendored content set (from `GET
/v1/detection-content` and the promptfoo mapping manifest): version, digest, signature status, licence, maintainer count
and owner with ownership-change notes, usage-data posture (switches and the last egress test), health (heartbeat,
self-test), last run, timeout and budget, the pages that use it, re-check-by, and the air-gapped reduced set. Actions:
enable or disable (strict copy, step-up on relax), mint an enrolment token (shown once), revoke a runner, run the
self-test. Run surfaces go on existing pages (ADR-0177 §3): the engine choice and run form on Red-teaming and
Evaluations; run detail (status, heartbeat, cancel, the not-run list, findings with an engine provenance chip); a Model
artifacts upload and scan tab in Admission review; an engine-scan evidence chip on model cards. The UI never shows
not-run or unknown as pass and never renders raw model text.

### Work split and slices

- **Claude:**
  - **B5-F foundation.** This ADR, migration 0172, `schema.ts`, the shared zod schemas and envelope, the taxonomy
    interface, settings, runner-token auth and route allow-list, the virtual-key `engine` purpose and project pinning,
    every route as a 501 stub, the compose `engines` profile and internal network, the AgentCoordination §4.10 contract
    table and mock fixtures.
  - **B5-E runner core** (in the same PR as F): lease, heartbeat and cancel; the timeout and lease sweep; key mint and
    revoke; normalisation into `redteam_runs`/`eval_runs`; audit; the A3 and eval-catalog hooks; the detection scrub on
    ingest; the self-test harness and egress test; the workflow `automated_check` binding and the scheduled trigger
    (owner decision 4).
  - **B5-P promptfoo, B5-M modelscan** (with the scanner contract and artifact upload), **B5-G garak** (with
    CyberSecEval): one PR each, with the image, config generator, mapper, SBOM and signing, and red proofs at least for
    engine error → `unknown`, egress denied → `not_run`, budget spent → 401 mid-run, and cancel revokes the key.
- **Codex:** **X26 (B5-W)** the Engines page, built against the stubs and merged once two engines exist; **X27 (B5-R)**
  run and result views on Red-teaming and Evaluations; **X28 (B5-A)** Model artifacts in Admission review and model-card
  evidence; **X29** cross-review of F, E, P, M and G (runner-token scope, the virtual-key ceiling and project pinning,
  the kill switch, not-clean semantics, the validity of the egress test, hostile artifact parsing).
- **Claude reviews** W, R and A (strict copy, not-run shown as pass, raw text, keyboard and axe). Finding IDs `B5X-NN`
  (raised by Codex) and `B5C-NN` (raised by Claude), in the ADR-0186 format and rules.
- **Research G19** (`docs/research/R10-engine-admission.md`): maintainer counts; promptfoo 0.124.0 remote-generation,
  sharing and cloud switches, the exact cloud-only plugin list, where `pliny` lives, the default grader, and whether the
  disabled-telemetry fetch is fixed; garak v0.17.0 data licence and provenance probe by probe, which probes and
  detectors need Hugging Face or remote access, the tag → OWASP mapping and the report schema; modelscan v0.8.8 exit
  codes, JSON report schema, formats and optional-dependency licences; a transitive licence inventory per image (no
  GPL or AGPL); CyberSecEval licences per file.
- **Hot files:** `app.ts`, `schema.ts`, migrations, the lockfile and shared zod are Claude's; `App.tsx`, `suites.tsx`
  and `api/client.ts` are Codex's. Each asks the other for one-line changes on the board.

### Sequencing

The foundation code starts after Batch 4 lands on `main`: its slices on `b4-int` edit the same hot files (ADR-0183), and
Batch 5 relies on the Batch 4 step-up enforcement and vendored detection scrub. Until then only this ADR and research
G19 proceed. Each engine PR follows the foundation and needs its G19 findings first. The Engines page merges once two
engines exist (ADR-0177 §4).

## Consequences

- Engines run outside the gateway process with no way out except the gateway, and every model call they make is
  governed, attributed and revocable like a person's.
- A3 required tests and the eval catalog can be met by engine runs, but only by completed runs that measured the class.
- Air-gapped installs get a smaller, disclosed set of probes; nothing missing is presented as passed.
- We take on building, signing and patching three engine images, and re-checking their ownership and maintenance.
- Batch 5 waits for Batch 4 to merge.

## Open questions

1. **Maintainer-count admission.** ADR-0177 forbids a single-maintainer project as a required sidecar. Counts are not
   yet checked (G19). Every engine is optional (off by default), but if A3 comes to depend on one engine in practice, a
   low count must be decided explicitly.
2. **promptfoo's ownership change.** It is now part of OpenAI. Re-check licence, telemetry and release behaviour at each
   pin, and record the outcome on the Engines page; the same applies to `modelaudit`, which has the same owner.
3. **modelscan is maintenance only.** If no release lands by about 2027-02, it fails the 12-month rule; `modelaudit`
   (MIT) is the fallback, subject to point 2. fickling stays excluded.
4. **garak data provenance.** Admission is per file. Anything whose licence or provenance G19 cannot establish is
   excluded and reported as `excluded_licence`.
5. **Scheduled runs and the approvals rule.** A scheduled run executes as the person who configured it. Still to
   settle: whether approval for an agentic or offensive set is given once per schedule (bound to its `config_hash`, so
   any change re-queues it) or for every run, and exactly which plugin sets count as offensive. promptfoo and garak here
   target only agents and models reachable through our gateway; tools that attack external hosts (Strix, PentestGPT)
   stay import-only under PF-10 and ADR-0177.

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
- Free numbers: ADR 0187; migration 0173 with journal `when` 1785108000000 (0171 and 0172 went to the Batch 4 review fixes: the approver-role snapshot, then the persisted named approver and the first-passkey flag).

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

**Tables (migration 0173, journal `when` 1785108000000; outline, names final in the foundation).**
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
  - **B5-F foundation.** This ADR, migration 0173, `schema.ts`, the shared zod schemas and envelope, the taxonomy
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

### Implementation decisions (B5-F + B5-E, 2026-10-08, branch `b5-foundation`)

Built in one branch as the ADR splits it: migration 0173 (journal `when` 1785108000000), `schema.ts`, the shared
contract (`packages/shared/src/engines/`), the gateway (`engines.ts`, `engine-runs.ts`, `engine-ledger.ts`,
`engine-runner-auth.ts`, `engine-scrub.ts`), the runner core (`packages/engine-runner`), the compose profile and the
§4.10 contract with mock fixtures (`apps/web/e2e/engines-fixtures.ts`). Tests: `zz-b5-engines.test.ts` (23, real
database), `zz-b5-compose.test.ts` (4), `packages/shared/src/engines/engines.test.ts` (13),
`packages/engine-runner/src/runner.test.ts` (8). Each security test was shown red by breaking the guard it pins.

1. **Runner credentials.** `rge_…` (runner) and `rgee_…` (one-time enrolment, at most 60 minutes, spent atomically
   by register) are stored as sha256, resolve to no user and are never admin. One hook, before the admin gate,
   confines each to its allow-list (`ENGINE_RUNNER_ROUTES`, `ENGINE_ENROLLMENT_ROUTES`; 403 `engine_runner_scope`)
   and refuses every other credential on the runner routes (401 `engine_runner_token_required`). The runner routes
   are their own route auth class, `engine-runner`, like SCIM. A revoked runner gets 401 `engine_runner_revoked`;
   revoking one ends the runs it holds (`cancelled`, keys revoked).
2. **Enabling.** `PATCH /v1/engines/:id` needs a fresh (24 h) passing self-test recorded against the manifest as it
   is now (409 `engine_self_test_required`), and a `settings_relax` step-up bound to `{values: {"engine.<id>.<field>":
   value}}` for each relaxation: enabling, a longer timeout, a higher budget ceiling, more concurrency (judged against
   the stored row; tightening asks nothing). Decided on the unlocked read and again on the locked row (409
   `changed_concurrently`). A failing self-test, or a manifest change of version or digest, switches the engine off.
   The self-test is the runner's own report from inside its container (digest, version, each usage-data switch at its
   required value, an egress probe whose name resolution AND TCP connect must both fail); the gateway cannot observe
   a container, so the digest pin, the image signature (B5-P/M/G) and the internal network are what make the report
   trustworthy.
3. **No engine can be enabled yet.** The shipped manifest has no image digest for any engine (images come with
   B5-P/M/G), so every self-test fails `image_not_built`: the secure default holds by construction. Tests pass a
   manifest with synthetic digests through a code-only `buildApp({engines})` seam (never env or admin input).
4. **The run-scoped key is minted at LEASE**, not at creation: a queued or awaiting-approval run holds no key, and
   the deadline (= the key's expiry) runs from the lease. The key reaches only `POST /v1/chat/completions`,
   `POST /v1/messages` and `GET /v1/models` (not `GET /v1/me`, not the native invoke route); its allow-list is the
   target and judge agent ids; it is pinned to the run's project (a call naming another project is 403
   `virtual_key_project_mismatch`, an unattributed call is attributed to the pin) — so an agent-target run requires a
   `projectId` (422 `project_required`); nobody can PATCH it (409 `engine_key_immutable`). **A spent budget revokes
   it at once** (audited `engine-run-key-revoked`, cause `budget_exhausted`): the crossing call is billed, every later
   call is 401. Entitlement is re-checked at lease; a run-as person gone or no longer entitled ends the run `not_run`
   (`run_as_gone`, `run_as_not_entitled`) with no key. Usage rows carry `detail.purpose = "engine:<id>"` and
   `engineRunId`; `engine_runs.cost_usd` is summed from `usage_events` by the run's key.
5. **Kill switch.** Cancel ends the run at once (`cancelled`) and revokes its key; the runner learns on its next
   heartbeat (`{cancel: true}`), and a result that arrives after any end is refused 409 `engine_run_finished` and
   audited (`engine-run-result-late`). The sweep (`engine-run-sweep`, every 60 s) ends a leased run whose deadline
   passed or whose lease (90 s, extended by heartbeats, never past the deadline) expired as `timeout` and revokes its
   key; a queued run nobody leased in 24 h ends `not_run` (`no_runner`).
6. **Not-clean semantics as built.** The pure normaliser re-derives every verdict, strictest wins: a defeat fails;
   a claimed pass with no attempt is unknown; a run that did not complete has no clean item; an item in `notRun` is
   `not_run` (a DB CHECK also refuses a not-run reason on any other verdict). Aggregates are recomputed with the
   in-process red-team functions. Only a COMPLETED agent run is written into `eval_runs`/`redteam_runs`
   (`redteam_probe_trials` for mapped items only; unknown and not-run items as one errored trial, outside every
   denominator); A3 and the evaluator catalog additionally ignore any red-team or eval run linked to an engine run
   that did not complete. `classSummary` is written in the in-process shape so the catalog reads it unchanged. Every
   item, mapped or not, is kept in `engine_run_items`.
7. **One detection-scrub interface** (`engine-scrub.ts`, coordinator direction 2026-10-08): every engine string
   (item key, taxonomy id, reason) passes `engineDetectionScrub` before it is normalised, stored or copied into the
   ledgers. Its default is the scrub on `main`, ADR-0099's `scrubAuditText`, which already consults the vendored
   `pipelock-secrets` spans; **when Codex's X23 (ADR-0186 V) lands, its rules apply through that path with no change
   here**, and a different ruleset can be wired once at boot (`setEngineDetectionScrub`). Fail closed: a scrub that
   throws makes the item `unknown` with its key and reason withheld. `engine_run_items.reason` and `verdict_note` are
   also registered with the ADR-0102 prose scrub (belt and braces).
8. **Raw reports** ride the envelope as an optional `rawReport.contentBase64`; the gateway verifies its sha256 and
   length (a mismatch fails the run, `raw_report_mismatch`), stores it encrypted under the data key for
   `engineRawReportRetentionDays` (none stored without a data key; the sha256 is kept either way), and the sweep
   deletes it after. No route returns it yet.
9. **Approvals (owner decision 4; open question 5 answered strictly, owner may revisit).** A run needs approval when
   it uses a set the manifest classes agentic or offensive, **or any set the manifest does not list** (fail closed),
   or when its budget is over `engineRunApprovalThresholdUsd`. The approver is `approverUserId` or the org's
   `infraApproverUserId` (422 `engine_approver_required` when neither); the run-as person cannot approve it. Approval
   is **per run, scheduled runs included** (not once per schedule). New approval kind `engine_run`: approved → queued,
   denied → `not_run` (`approval_denied`); cancelling supersedes a pending approval.
10. **Org settings (all strict, in the strictness registry, stored-value rule):** `engineMaxRunTimeoutMinutes` 30
    (1–120), `engineDefaultRunBudgetUsd` 2, `engineRunApprovalThresholdUsd` 10, `engineRawReportRetentionDays` 90,
    `engineSensitiveSetApproval` true. Every number is looser when larger. **Default taken, owner may revisit:** a
    longer raw-report retention is the relaxation (raw output can quote model text; the normalised result and the
    sha256 stay whatever the setting), so shortening it needs no step-up.
11. **Schedules** were not in the route list above; added as `POST/GET /v1/engine-schedules` and `PATCH
    /v1/engine-schedules/:id` (`{enabled}`; only the creator re-enables). A schedule stores the run request and its
    configuration hash; each due run (`engine-schedule-sweep`, every 5 minutes) is created as the creator through the
    same path as a manual run, and is skipped with an audited reason when the creator is gone or deactivated, no
    longer entitled, the engine is off, or the stored request no longer matches its hash.
12. **Workflow binding.** An `automated_check` stage may carry `engines: [{check, engine, agent, judgeAgent?, sets,
    params?, trials?, budgetUsd?}]` (agents by registry name, as eval bindings). The run starts on stage entry as the
    instance initiator on the instance's project, one per (instance, stage, check, round) (unique index); the check
    is pending until it ends, passes only when the run completed with verdict `pass` (no failed or unknown item, at
    least one pass), and fails otherwise. A run's end re-evaluates the stage. Reported results for such a check are
    refused (422 `engine_check_cannot_be_reported`). **Flag:** a `not_run` item (an air-gapped reduced set) does not
    fail the check on its own; the owner may want a gate that requires every requested item to run. **Amended by
    decision 61 (PR #205 review round 3):** only a DECLARED planning-time exclusion (a key in the manifest's reduced set,
    with a declarable reason) is excused; any not-run that happens at run time makes the run incomplete, so the check
    fails.
13. **Runner core** (`packages/engine-runner`, stdlib + shared): the client for the five routes, the self-test
    report, the egress probe (fail closed: only no-route, no-resolver and timeout count as denied; a refusal or reset
    from the far end counts as reached), the engine as a child process group killed whole on cancel or deadline, and
    `runOnce` (an engine that throws is posted `failed`/`engine_error` with no items; a cancelled run posts nothing;
    the work directory is wiped). B5-P/M/G build each engine's shim on it.
14. **Compose.** `engines` network `internal: true`; the gateway joins it, the database and object store do not; it
    is not in `REGULAIT_TRUSTED_PROXIES`. `x-engine-runner` is the hardened template each engine service merges
    (profile `engines`, read-only root, tmpfs work dir, `cap_drop: ALL`, `no-new-privileges`, uid 10001, memory/CPU/pids
    limits, `pull_policy: never` by default, no secret but the enrolment token). No Docker socket anywhere.
15. **Open-source check (ADR-0176).** No new dependency. pg-boss and graphile-worker (MIT) were considered for the run
    queue and not taken: the queue is the governed evidence record itself, consumed by an external container over
    an HTTP lease, and a second copy of each run's state would be the drift risk. execa (MIT) was considered for
    process groups; `spawn({detached})` plus `kill(-pid)` is the whole need. The Wilson interval, ASR and
    measurement labels reuse `redteam-stats.ts`.

**Review round 1 (PR #203, Codex, 2026-10-08; 16 findings, each red first).** Tests: `zz-b5-engines.test.ts`
"review round 1" (12), `packages/shared/src/engines/engines.test.ts` "review round 1" (4), the workflow-kernel and
runner-core cases. **Migration 0173 was edited in place** (unmerged; `engine_runs.workflow_notified_at` and its partial
index): a dev database that applied 0173 from `b5-foundation` before this round must be rebuilt (§4.1).

16. **A defeat always fails the item** [1], whatever verdict it claims and however the run ended, and it counts in
    the ASR; a run with any failed item reads `fail` even when it did not complete (a defeat is never hidden). A
    defeat also clears a contradictory not-run listing (the DB CHECK keeps not-run reasons on not-run verdicts only).
17. **Every engine-controlled string is scrubbed** [2] before it is mapped, stored or returned: item key, taxonomy
    system and id, claimed class, reason, not-run keys and the error code (one the scrub changed or could not clear is
    stored as `engine_error`). Any throw fails the item closed. Enum, numeric and uuid fields are schema-validated.
18. **Lease decides the self-test now** [3]: the runner's stored report is re-evaluated against the manifest
    (including its 24-hour freshness) and the engine's recorded self-test must still admit enabling (fresh, same
    build); otherwise 409 `engine_self_test_required`. No stored boolean is trusted.
19. **The egress probe always tries a public literal address** [4] with no resolver, reported as
    `egress.address`/`addressConnected`. The self-test fails `egress_address_missing` when none was probed or it is
    not globally routable (private, loopback, link-local, CGNAT, multicast, benchmarking and documentation ranges
    are refused), and `egress_address_connected` when it connected. The runner reads it from
    `REGULAIT_EGRESS_PROBE_ADDRESS`; a blocked resolver no longer masks routable egress.
20. **The workflow hand-off is durable** [5]: `workflow_notified_at` is stamped only when the check stage evaluated
    (or is no longer current); a failure, or another executor holding the stage, leaves it unset and the engine sweep
    retries every minute.
21. **Raw-report retention is the setting now** [6]: the sweep deletes a report once `finished_at` + the CURRENT
    retention has passed (or its stored expiry, whichever is sooner), so lowering the setting shortens reports
    already stored.
22. **Attempts are capped at 25 per item** [7] (the governed trial limit, `RED_TEAM_MAX_TRIALS`), so no envelope can
    expand into more than 125,000 outcomes; aggregates over that bound need no special path.
23. **A result is accepted only while the run is live** [8], decided under the row lock: after the deadline or the
    lease (before the sweep has run) the run ends `timeout` (`deadline_passed`/`lease_expired`), the key is revoked,
    nothing of the envelope counts, and the runner gets 409 `engine_run_timed_out`.
24. **The workflow engine stage resolves the initiator's current standing** [9] (admin or not, active or not)
    instead of assuming non-admin.
25. **Lease re-checks project attribution** [10] in the lease transaction: a run-as person who can no longer bill
    to the project ends the run `not_run` (`project_not_attributable`) with no key.
26. **`eval_runs.cases`/`passed_cases` count only measured mapped items** [11] (pass or fail with a class or scorer);
    unmapped, unknown and not-run items are not cases.
27. **An envelope for another engine version is refused** [12] (`result_mismatch`, the run fails).
28. **A schedule is validated by the same function as a run** [13] (`validateEngineRunRequest`: engine on, target
    kind, project, target AND judge entitlement, attribution, budget ceiling, approver), with nothing written.
29. **Workflow bindings exclude artifact-only engines** [14]: `stage.engines[].engine` is `promptfoo | garak`
    (artifact targets come with B5-M).
30. **One summary shape for every terminal path** [15] (`runSummary`), the approval denial included.
31. **A workflow with engine-bound checks cannot start without a project** [16]: 422
    `project_required_for_engine_checks` at instance start (an engine run's calls are project-pinned).

**Review round 2 (PR #203, Codex, 2026-10-08; 7 findings, each red first; branch `b5-followup`, its own PR after #203).**
Tests: `zz-b5-engines.test.ts` "review round 2" (4), `packages/shared/src/engines/engines.test.ts` "review round 2" (1),
`packages/engine-runner/src/runner.test.ts` (3). No migration change.

32. **A lease re-reads the runner's revocation under its row lock** [17]: the lease transaction first takes the runner
    row `FOR SHARE` and refuses a revoked runner with 401 `engine_runner_revoked` (nothing leased, no key). Revocation
    UPDATEs that same row, so it either waits for an in-flight lease to commit (and then ends the run that lease
    took) or the lease waits for it and sees it.
33. **The runner retries its result until the gateway answers definitively** [18]: a network error, 5xx, 408 or 429
    is retried with exponential backoff (doubling from 1 s, capped at 30 s, at most 8 attempts, never past the run's
    deadline); a 2xx or any other 4xx (409 finished/timed out, 401 revoked, 422 invalid) ends it. The heartbeat keeps
    running through the retries, and the work directory is kept (outcome `undelivered`) when nothing definitive
    arrived — the gateway's sweep then times the run out.
34. **A mapped item that says `fail` with zero defeats is inconsistent and reads `unknown`** [19] (noted on the
    item); it contributes neither a failure nor clean trials.
35. **A heartbeat never renews an expired lease** [20]: decided under the run's row lock, a lease that has expired or
    a deadline that has passed ends the run `timeout` (`lease_expired`/`deadline_passed`, key revoked) and the
    heartbeat answers 409 `engine_run_timed_out`.
36. **A workflow that ends takes its engine runs with it** [21]: when an instance becomes completed, denied, aborted
    or rolled back, every live run it started (awaiting approval, queued or leased) is cancelled (`workflow_ended`),
    its key revoked and its pending approval superseded — in the transition's own transaction, under the instance
    row lock. A re-open does the same for the runs of the rounds it left behind. The engine-run approval now carries
    `approvals.instance_id`; the blanket "supersede the instance's pending gates" step skips `engine_run` approvals
    (they end only with their run), and the decision-regression baseline reads only `workflow` sign-offs.
37. **The process runner detaches its abort listener** [22] on both `error` and `close`, so a long-lived signal does
    not accumulate listeners.
38. **A due schedule whose run creation throws is an audited skip** [23]: the claim (the advanced `next_run_at`) is
    already committed, so the error is caught and stored as `last_skip` ("the run could not be created: …") with an
    `engine-schedule-skipped` audit row; a due run is never lost silently.

### Implementation decisions (B5-P promptfoo, 2026-10-08, branch `b5-promptfoo`)

Built without the G19 research (not started): every fact the ADR expected from G19 for promptfoo was read from the
pinned package itself and recorded with its method in `docs/research/R10-engine-admission.md` §promptfoo; what could
not be established fails closed and is listed under open questions 6–9. No migration. Tests:
`packages/engine-promptfoo/src/promptfoo.test.ts` (10), `image.test.ts` (4), `promptfoo-real.test.ts` (3, opt-in: the
real promptfoo 0.123.1 against a fake gateway), `apps/gateway/src/zz-b5-promptfoo.test.ts` (5, the real gateway),
`zz-b5-compose.test.ts` (+1). Each guard was shown red by breaking it.

39. **One shared catalogue decides what runs** (`packages/shared/src/engines/promptfoo.ts`, pinned to 0.123.1, the
    vendored OWASP tables' release): each plugin and strategy is `local`, `cloud_only` (upstream returns nothing or
    throws with remote generation off), `missing_preseed` (dataset plugins that download at run time) or
    `excluded_licence` (`pliny`); anything unlisted is not run (`engine_error`) and never reaches promptfoo. The
    manifest's `sets` are generated from it (only sets that run are classed; the rest stay offensive by default), as
    are the reduced set and the usage-data switches. A run-config set is a plugin id or `strategy:<id>`.
40. **Taxonomy v2.** Items are (plugin, strategy) pairs keyed `<plugin>/<strategy>`; a `basic` item maps by its plugin
    id, a strategy item by `strategy:<id>` (what it measures is the evasion technique): prompt-extraction →
    system_prompt_extraction; pii:* and harmful:privacy → pii_leak; cross-session-leak, divergent-repetition →
    data_exfiltration; the encodings → encoding_evasion; jailbreak-templates, jailbreak:tree, crescendo → jailbreak.
    **Deliberately unmapped (reported, never counted):** the agentic-named plugins (excessive-agency, shell-injection,
    sql-injection, rbac, debug-access, tool-discovery) — a promptfoo run reaches the agent over the chat compat route
    and cannot show whether a tool call was made, so claiming ADR-0068's agentic classes from it would overstate
    coverage; and the content-quality plugins, which have no class here.
41. **The config generator never leaves the gateway, and an invariant re-checks it** (`assertGatewayOnly`, before
    anything is written): exactly three providers (target, `redteam.provider` generator, `defaultTest.options.provider`
    grader — unset, promptfoo grades with a vendor default), each `openai:chat:<model>` at the lease's base URL with
    `apiKeyEnvar` set to the one run-key variable and `useDefaultApiKey: false`; no URL off the gateway anywhere; no
    inline key; `sharing: false`. The child environment is an allow-list built from nothing (PATH, HOME and the config
    and cache directories on the run's tmpfs, the switches, the key): a proxy, a vendor key or a remote-URL override is
    refused. A refused config, a missing judge or nothing runnable ends the run `not_run` without starting promptfoo.
42. **The mapper decides verdicts from promptfoo's results, never its exit code alone**: a graded failure is a defeat;
    an error is not an attempt — a 401 (the key revoked: budget, cancel, timeout) or any engine error makes the item
    `unknown`, and an item whose every attempt failed to connect is `not_run` (`egress_denied`); a planned plugin with no
    result is `not_run` (`engine_error`); a result for something not planned, or with no plugin, is `unknown` and
    unmapped. Exit codes 0 and 100 are a completed run; anything else `failed`. promptfoo aborts a scan on a 401 and
    still exits 0, which is why the 401 rule matters. No model text leaves the runner: every reason is a fixed sentence
    with counts. The raw output rides as the raw report when it fits (3 MB), else only its sha256.
43. **The telemetry patch** (`engines/promptfoo/patches/telemetry-disabled-sends-nothing.mjs`, the ADR's "minimal
    patch"): one `if (this.disabled) return;` at the top of each of the four bundled copies of `sendEvent`. It refuses to
    apply unless it finds exactly four, once each. Measured: unpatched, each promptfoo process made one blocked connect
    to the vendor's event collector with telemetry disabled; patched, none.
44. **The image** (`engines/promptfoo/Dockerfile`, built from the repository root): the gateway's digest-pinned base in
    every stage; the npm closure from its own lockfile (`npm ci --omit=optional --ignore-scripts`; the native sqlite
    binding pinned as a direct dependency so it survives `--omit=optional`, which makes the image linux/amd64 only);
    an offline licence gate on the lockfile before install (`licence-gate.mjs`: fails on the GPL family, SSPL, BUSL,
    EPL, MPL or no licence); npm's own CycloneDX SBOM of the installed closure shipped at `/opt/promptfoo/sbom.cdx.json`;
    the patch; the shim deployed production-only; npm, npx and corepack removed; uid 10001; every switch and
    `REGULAIT_EGRESS_PROBE_ADDRESS` in the image env; no port. `image.test.ts` keeps the Dockerfile, the lockfile and the
    manifest in lockstep. **Not built here** (no Docker daemon): the manifest digest stays null, so the engine still
    cannot be enabled. Signing and the image-level Trivy scan join `publish-image.yml`/`security.yml` when the image is
    first built in CI.
45. **Two lockfile overrides** lift simple-git to 4.0.2 and basic-ftp to 6.2.2 past published critical/high advisories
    (`npm audit --omit=optional`: 3 critical, 4 high → 0). Both paths are unreachable in the runner (no git command, no
    proxy); overridden because ADR-0176 admits no unpatched critical advisory. The real-engine tests pass on the
    overridden closure.
46. **Compose `engine-promptfoo`** merges the hardened `x-engine-runner` template and overrides only its image (by
    env, so an operator pins it by digest; no digest is shipped) and its three variables (gateway URL, enrolment token,
    the image digest it reports).
47. **Runner core fix found by the real-gateway test:** the runner sent `content-type: application/json` on the
    bodiless lease POST, which the gateway refuses with 400 — no runner could ever have leased against the real app
    (the B5-E tests used a fake transport). The content type is now sent only with a body.

**Review (PR #205, Codex, 2026-10-09; 4 findings, each red first).** Tests: `packages/engine-runner/src/loop.test.ts`
(4), `zz-b5-promptfoo.test.ts` "PR #205 review" (1), `promptfoo.test.ts` [50], `image.test.ts` and
`zz-b5-compose.test.ts` [51]. No migration.

48. **A runner waits while its engine is off** [4225536095]. The documented flow is register → an admin enables; until
    then a lease answers 409 `engine_disabled` (or `engine_self_test_required`), and the runner threw and exited. The
    loop now lives in the shared runner core (`runRunnerLoop`, `packages/engine-runner/src/loop.ts`), so every engine
    shim inherits it: a refused lease, a network error or a 5xx waits with a doubling backoff (5 s to 5 min); work
    resumes when the lease is accepted. Only a refused credential that cannot be replaced (decision 49) ends the process.
49. **The runner token survives a restart** [4225536098]. The enrolment token is single-use, so a token kept only in
    memory bricked the runner on any restart. Registration's token is written to a file on the runner's own volume
    (`FileRunnerTokenStore`: 0600, atomic replace, never logged; compose volume `engine-promptfoo-state` on `/state`,
    created 0700 and owned by uid 10001 in the image). At start a stored token is used and the enrolment token is
    ignored. A 401 on the stored token (revoked or unknown) falls back to the enrolment token once; with none, or one
    the gateway refuses (spent, expired), the runner stops with a message naming the admin's next step. The gateway
    still refuses a second registration with the same enrolment token.
50. **Every planned (plugin, strategy) pair is accounted for** [4225536103]. Missing-output detection tracked plugins
    only, so a strategy that rewrote nothing for a plugin vanished silently. The mapper now walks the planned product
    (each plugin × `basic` and every planned strategy) and reports each pair with no result `not_run` (`engine_error`).
51. **The image is linux/amd64 only, explicitly** [4225536109]. `@libsql/linux-x64-gnu` is a hard x64 binding on a
    multi-arch base: every Dockerfile stage names `--platform=linux/amd64` and the compose service
    `platform: linux/amd64`, so an arm64 host emulates amd64 rather than building an image whose native binding cannot
    load. arm64 is open question 10.

**Review round 2 (PR #205, Codex, 2026-10-09; 8 findings, each red first).** Tests: `loop.test.ts` [53] [54] [55],
`promptfoo.test.ts` [52] [56] [57] [58] [59], `promptfoo-real.test.ts` [59] drift (opt-in), `zz-b5-promptfoo.test.ts`
"review round 2" [53] [54], `zz-b5-engines.test.ts` (register replay), `zz-b5-compose.test.ts` [55]. No migration: the
runner-generated credential uses the existing `engine_runners.token_hash`, `enrollment_token_id` and
`engine_enrollment_tokens.used_at` / `runner_id`.

52. **No model text in the raw report** [4225756959]. The envelope carried promptfoo's whole output file (generated
    prompts, model responses, grader text) as `rawReport.contentBase64`. It now carries only the sha256 of the original
    bytes with `bytes: 0` (nothing attached); the gateway stores the mapper's own items (ids, verdicts, counts) and the
    hash. The encrypted raw-report store (decision 8) is unused for promptfoo.
53. **A runner refreshes its own self-test** [4225756949]. After 24 hours the lease refuses the runner's report
    (`engine_self_test_required`) and only registration accepted a new one. New runner-token route `POST
    /v1/engine-runner/self-test` (on the allow-list): the report is evaluated exactly like registration's (manifest,
    digest, version, switches, egress, freshness), must describe the image the runner registered with (else 422
    `engine_self_test_inconsistent`), and is audited (`engine-runner-self-test-refreshed` / `-failed`). A passing report
    also refreshes the engine's recorded self-test, but only for the build an admin enabled (the engine's record passed,
    for the manifest's digest and version); a failing one switches the engine off. The shared loop re-runs the self-test
    and submits it on that refusal (once per refusal streak), then leases again. **Default taken, owner may revisit:**
    the refresh keeps an enabled engine enabled without a new admin action while the build is unchanged; the admin's
    step-up was for that build.
54. **The runner brings its own credential** [4225756962]. A registration response lost after the gateway spent the
    enrolment token left the runner unrecoverable. The runner now generates its own token (`rge_` + 256 CSPRNG bits),
    persists it (0600) BEFORE calling register, and sends only its sha256 (`tokenHash`), which the gateway stores as the
    credential; nothing secret is returned. A transient failure is retried with the same secret, and the gateway answers a
    spent (unexpired) enrolment token presented with the SAME hash with the same runner (`replayed: true`, audited
    `engine-runner-register-replayed`); any other hash is 401 `engine_enrollment_invalid`, a revoked runner is never
    replayed, and a spent token never mints a second runner. After a crash, the stored secret either is the credential
    (the registration landed) or is refused and replaced with a new one. A hash already registered is 409
    `engine_runner_token_conflict`.
55. **The reported digest is a consistency check, not proof** [4225756971]. A container cannot prove which image it
    runs: any digest it reports is a claim. What we can make true: the compose image reference and the digest the runner
    reports are built from ONE variable (`REGULAIT_ENGINE_PROMPTFOO_DIGEST`; image `<repository>@<digest>`, never a tag;
    the default is an all-zero digest that names no image), and the runner refuses to start unless the reference it was
    given is digest-pinned and agrees with the digest (and is not the placeholder). Real admission is verifying the
    image's signature at deploy time (cosign, ADR-0184), which is not built yet: **open item** (question 11).
56. **The URL rule covers the transport, not prompt text** [4225756968]. The invariant scanned every string, so a
    purpose that mentioned a URL was refused. It now checks every string inside the three provider objects (strict as
    before) and makes the rest of the config's shape an allow-list (top-level keys, `redteam`, plugin and strategy
    entries, `evaluateOptions`, `defaultTest`), so no other field can carry a transport setting at all.
57. **Egress is only an off-gateway destination** [4225756975]. Any connection error was classified `egress_denied`,
    including a refused or reset connection to the gateway itself. A connection error is now egress only when the error
    names a destination host and none of them is the gateway's; a failure to reach the gateway, or one naming no host, is
    an engine error (`unknown`).
58. **An unplanned bucket counts nothing** [4225756965]. A result for a plugin or strategy the run did not plan is now
    decided first: `unknown` with zero attempts and zero defeats, so it never counts as a pass or a fail.
59. **The cloud-only list is generated from the pinned package** [4225756981]. `engines/promptfoo/extract-plugin-lists.mjs`
    parses (does not execute) the pinned package's constants chunk and writes `packages/shared/src/engines/promptfoo-upstream.ts`
    (source chunk and its sha256 recorded); the catalogue's cloud-only list is `REMOTE_ONLY_PLUGIN_IDS` (now including the
    coding-agent collections and plugins and the medical, financial, pharmacy, insurance, ecommerce, telecom and realestate
    lists: 93 ids) ∪ the unaligned harm set ∪ `bias:*`, and its dataset list is upstream's `DATASET_PLUGINS`. A test refuses
    a local plugin that upstream needs remote generation for, a local id upstream does not have, or a dataset plugin
    without a not-run disposition; the opt-in drift test re-extracts from an installed package and compares.

**Review round 3 (PR #205, Codex, 2026-10-09; 4 findings, each red first).** Tests: `loop.test.ts` [60],
`engines.test.ts` [61], `promptfoo.test.ts` [61] [62] [63], `zz-b5-promptfoo.test.ts` [61]. No migration.

60. **A transient failure to submit a self-test is retried** [4226054063]. The refresh-once latch was set before the
    submission, so one network blip or 5xx left the runner waiting forever. Now only a definitive answer latches (a
    verdict, or a 4xx refusal with a reason); a network error, 5xx, 408 or 429 goes back into the normal backoff and the
    refresh is tried again. The latch still opens again when a lease succeeds.
61. **A run with a runtime not-run never passes** [4226054067]. A completed run with some passes and some not-run items
    (a refused set, a planned pair with no result, denied egress) read `pass`, so a workflow check passed on a partial
    run. The shared normaliser (every engine) now distinguishes two kinds of not-run: a **planning-time exclusion**
    declared before the run — its key is in the manifest's reduced set and its reason is declarable (`cloud_only`,
    `excluded_licence`, `unsupported_format`, `missing_preseed`) — may be not-run without blocking a pass; **any other
    not-run** (`engine_error`, `egress_denied`, missing output, a refused config, an undeclared set, or a declared key with
    a runtime reason) happened at run time and makes the run incomplete: `unknown` (or `not_run` when nothing passed),
    so the check fails. `runtimeNotRun` is in the normalised result and the run summary. Runtime not-run pairs are
    reported as items with their taxonomy id, and a standalone not-run key that is itself a mapped id gets its class, so
    both appear in the probe stats as not measured. **Decision 12's flag is amended accordingly.**
62. **A refused run reports every planned pair** [4226054072]. The preflight refusal (and a failed generation) reported
    only `<plugin>/basic`; both now use the mapper's single enumeration (`plannedPairs`: each plugin × `basic` and every
    planned strategy) to report every pair not run.
63. **The results file is bounded before it is read** [4226054076]. The runner stats promptfoo's output and refuses one
    over 64 MiB (`PROMPTFOO_MAX_RESULTS_BYTES`: 1/32 of the runner's 2 GiB `mem_limit`, since JSON.parse costs several
    times a file's size in heap) without reading or parsing it: the run fails (`results_too_large`, every reading
    unknown, every planned pair not run) and only the file's sha256 is recorded, computed by streaming.

**Review round 4 (PR #205, Codex, 2026-10-09; 3 findings, each red first).** Tests: `loop.test.ts` [64],
`promptfoo.test.ts` [66], `zz-b5-promptfoo.test.ts` "review round 4" [64] [65] [66]. No migration (see [66]).

64. **A runner disabled for its own failed report keeps re-proving itself, slowly** [4226325872]. A failing report
    switched the engine off; later leases answered `engine_disabled` and the loop refreshed only on
    `engine_self_test_required`, so after a temporary network-policy problem the runner could not present a passing
    report without re-enrolling. The lease refusal now carries a `reason`: `runner_self_test_failed` when this runner's
    own stored report failed, `disabled` otherwise (an admin switched it off, or this runner's report already passes).
    On `runner_self_test_failed` the shared loop re-runs and submits the self-test every 15 minutes
    (`failedSelfTestRefreshMs`), and a transient submission failure does not use up that cadence; on `disabled` it
    submits nothing. A passing refresh updates ONLY the runner's stored report: it never re-enables the engine.
    Re-enabling after a failure stays an audited admin action with a step-up, whose self-test then evaluates the fresh
    stored report (secure by default). *Amended by decisions 67 and 69 (round 5):* the `reason` field is replaced by
    the `next` signal; a runner whose own report fails or is stale is told `self_test_required` whatever the engine's
    state, and the 15-minute cadence (`selfTestRefreshMs`) applies to every refused report.
65. **A self-test report never lands after a revocation** [4226325882]. The self-test route read the runner without a
    lock and updated unconditionally, so a report racing a revocation could still write the runner's report and switch
    the whole engine off. The transaction now takes the runner row `FOR UPDATE` and re-reads `revoked_at` before touching
    the runner or the engine (revocation UPDATEs that row, so one waits for the other); revoked → 401
    `engine_runner_revoked`. A race test revokes the runner between the route's pre-checks and its transaction
    (`engineRunTestHooks.beforeSelfTestTx`).
66. **A strategy needs a plugin** [4226325878]. A strategy-only plan produced neither items nor not-run entries. Run
    creation (and schedule validation, which shares it) now refuses a promptfoo set list made only of `strategy:` sets
    (422 `engine_config_invalid`). When every requested plugin is excluded at planning time, each requested strategy is
    recorded not run with reason `engine_error` and the run's error code is `no_runnable_plugin`. **Decided (coordinator,
    2026-10-09): no migration.** A dedicated `no_runnable_plugin` not-run reason would need migration 0174 (0173's CHECK
    on `engine_run_items.not_run_reason`); it is not worth one, since strategy-only plans are refused at validation and
    this path is a residual (every requested plugin excluded at planning time). The error code names the cause.

**Review round 5 (PR #205, Codex, 2026-10-09; 4 findings, each red first).** Three were runner-lifecycle gaps again,
so the root cause is fixed rather than patched: the loop is now an explicit state machine driven by one gateway
signal. Tests: `loop.test.ts` (the table row by row, then the driver per transition), `runner.test.ts` [68],
`zz-b5-promptfoo.test.ts` "review round 5" [67] [69] [70]. No migration.

67. **The runner loop is a state machine driven by one gateway signal; a build change re-enrols** [4226623285]. After
    an image or version upgrade the stored token authenticated the old-build runner row: the lease said
    `engine_self_test_required`, the fresh report was refused 422 `engine_self_test_inconsistent`, and the loop
    waited forever. Every lease refusal and every self-test answer now carries `next`, one of:

    | `next` | when the gateway says it | runner |
    |---|---|---|
    | `ok` | a 200/204 lease; a passing report while the engine is on | lease |
    | `admin_disabled` | the engine is off and this runner's report passes now | wait (capped backoff), lease again |
    | `self_test_required` | this runner's report is stale (24 h), failing, or for a build the manifest no longer names, *whatever the engine's state*; or the engine's own record no longer admits it | refresh if the cadence allows, else wait |
    | `reenrol_required` | the build the runner presents differs from the one its credential registered | re-enrol, or stop |
    | `revoked` | the credential authenticates nothing (also any 401 without a signal) | re-enrol with an unused enrolment token, or stop |

    The lease now carries `{imageDigest, engineVersion}` (the build running now) and decides in this order:
    reenrol_required, self_test_required (runner), admin_disabled, self_test_required (engine record). The runner's
    states and transitions (`transition` in `packages/engine-runner/src/loop.ts`, every row pinned by a table test):

    | state | event | next state |
    |---|---|---|
    | enrolling, reenrolling | registered | leasing |
    | enrolling, reenrolling | no unused enrolment token, or it is refused, or retries exhausted | stopped |
    | enrolling, reenrolling | transient | the same (same secret, backoff) |
    | leasing | `ok` | leasing |
    | leasing | `admin_disabled` | waiting |
    | leasing | `self_test_required` and the cadence allows | refreshing |
    | leasing | `self_test_required` within the cadence | waiting |
    | leasing, refreshing | `reenrol_required` or `revoked` with an unused enrolment token | reenrolling |
    | leasing, refreshing | `reenrol_required` or `revoked` without one | stopped |
    | leasing | transient | leasing (backoff) |
    | leasing | too many retained results (decision 68) | waiting |
    | refreshing | `ok` | leasing (at once) |
    | refreshing | `admin_disabled` or `self_test_required` | waiting |
    | refreshing | transient | leasing (backoff; the cadence is not used up) |
    | waiting | the wait is over | leasing |
    | stopped | anything | stopped (the process says what the admin must do, and exits) |

    The cadence: after a definitive submission (a verdict, or a refusal with a signal) the next waits 15 minutes
    (`selfTestRefreshMs`); a lease that succeeds resets it. An enrolment token is tried at most once per process (it is
    single-use). **Picked for the old registration: it is revoked on a successful re-enrolment**, not left for the
    admin. The re-enrolling runner presents the token it held as `supersedes` (proof of possession); in the
    registration's transaction the gateway revokes that runner if it is a live runner of the same engine, then ends
    the runs it held (and their keys) and audits `engine-runner-superseded`; anything else is ignored. So an upgrade
    never leaves a live credential behind. Without an enrolment token the runner stops with what to do; the state
    volume is never deleted (the token file is replaced only when an enrolment is under way, decision 54).
68. **Undelivered results are retried, then dropped, and capped** [4226623288]. An `undelivered` run's work directory
    stayed in the 1 GiB tmpfs forever. Now it keeps only `undelivered-result.json` (the envelope, the run id and its
    deadline; the engine's own files go at once). In `leasing`, before every lease, each retained result is posted once
    (the same definitive/transient rule as `postResultWithRetry`; the loop's backoff spaces the attempts); the
    directory is removed on a definitive answer (a 2xx, or a 4xx such as 409 the run ended or timed out), when the
    run's deadline has passed (the gateway has ended it), or when it holds no readable result. Only run-id directories
    are touched. With 3 retained (`maxRetainedResults`) the runner leases nothing and waits.
69. **A runner keeps its report fresh while the engine is off** [4226623293]. While an engine was off for more than
    24 hours (including a fresh install before its first enable) the runner's report went stale, nothing refreshed it,
    and the admin's self-test could never pass. The lease now judges the runner's own report before the engine's state
    (decision 67's order), so the runner refreshes on `self_test_required` whatever the engine's state; with a fresh
    report and the engine off it just waits (`admin_disabled`). A passing report still never switches the engine on.
70. **An agent with no provider model is never dispatched** [4226623279]. A target or judge with `agents.model = null`
    was accepted, and the lease substituted the display name as the model. Run validation (and so schedule
    validation) now refuses it: 422 `agent_not_dispatchable`, naming the role. The lease no longer falls back to the
    display name: the lease transaction refuses such an agent and the run ends `not_run` with error code
    `agent_not_dispatchable`. The promptfoo config already refuses an empty model string (`model_invalid`); the shim
    cannot tell a display name from a model, so the gateway is where this is enforced.

**Review round 6 (PR #205, Codex, 2026-10-09; 3 findings, each red first).** Tests: `loop.test.ts` [72],
`zz-b5-promptfoo.test.ts` "review round 6" [71] [72] [73]; engine-test fixtures that queued a promptfoo run or schedule
without a judge now name one. No migration.

71. **The lease decides its admission again under locks** [4226962955]. The admission (decision 67's order) was
    decided before the lease transaction, which re-read only the runner's revocation, so an admin's disable or a
    concurrent failing report landing in between still let the lease mint a key. The admission is now one function
    (`leaseAdmission`); the first call is only a fast path, and inside the transaction the lease takes the runner row
    `FOR UPDATE` (revocation, report, build), then the engine row `FOR SHARE` (enabled, recorded self-test), and
    decides again on those rows before it reads the queue. Every path that switches the engine off or records a
    failing verdict holds the engine row `FOR UPDATE`: the admin PATCH (already), the runner self-test route (already,
    after the runner row: the same lock order), the admin self-test route and the manifest sync on a build change (both
    now in a transaction that takes it). So each either commits first and is seen, or waits for the lease to commit
    (and a run it leased is then ended like any other on a disable or a revocation). Race tests switch the engine off,
    and land a failing report, between the fast path and the transaction (`engineRunTestHooks.beforeLeaseTx`): 409 with
    the right `next`, no key, the run still queued.
72. **An interrupted re-enrolment is resumed, so the superseded credential is still revoked** [4226962963]. The loop
    wrote the new secret over the stored token before registering, so a crash in between lost `supersedes` and the old
    registration stayed live. Now an enrolment writes a pending record (`<token file>.pending`: the new secret and the
    token it supersedes, or null; 0600, atomic) before the request leaves, and leaves the stored token alone. Only after
    a 201 is the stored token replaced and the record deleted. A start that finds a valid pending record resumes that
    enrolment first, with the same secret and `supersedes` (the gateway replays a same-hash registration, and the
    revocation was in the original transaction if it landed). A failure to write the token after the 201 is not
    retried as a registration failure: it propagates, and the next start resumes the record (the gateway test crashes
    at both points: before anything is sent, and after the registration landed but before the token was stored). A
    refused enrolment keeps the record; with no enrolment
    token set the runner stops and says so. An invalid record is never used. This refines decision 54 (the secret is
    still persisted before the request leaves, as the pending record).
73. **A judge is required where the manifest says so** [4226962969]. promptfoo needs a judge, but a run or schedule
    without `judgeAgentId` was accepted and then always failed at the runner (`judge_required`). The manifest now says
    it per engine (`requiresJudge`: promptfoo true, modelscan and garak false), and run validation, which schedule
    creation and the workflow stage share, refuses an agent run without a judge with 422 `judge_required`. No engine
    name is hard-coded in the check.

**Review round 7 (PR #205, Codex, 2026-10-09; 3 findings, each red first).** Tests: `loop.test.ts` [74],
`zz-b5-promptfoo.test.ts` "review round 7" [75] [76]. No migration.

74. **A committed enrolment is recognised at start** [4227454987]. A crash after the new token was stored but before
    the pending record was deleted left both; at the next start the pending record won, the stored (valid) credential
    was never used, and without an enrolment token the runner stopped. At start, a stored token equal to the pending
    secret means the enrolment committed: the stored token is used and the stale record deleted (three tries; a failure
    to delete is logged and never blocks the credential, and the next start finds the same match).
75. **Leases and queues follow the build** [4227454974]. After a build change, queued runs kept their old engine
    version, the lease picked by engine id only, and the new build leased a pre-upgrade run that always ended
    `result_mismatch`. Now (a) the lease takes only a queued run whose `engine_version` is the version the runner
    presents; and (b) **picked: cancel, not re-version.** When the manifest sync sees a build change (version or
    digest), in the transaction that holds the engine row `FOR UPDATE` and decided on that locked row, every run of
    the engine still waiting (queued, or awaiting approval) is cancelled with `engine_build_changed` (its key, if any,
    revoked; its pending approval superseded; audited `engine-run-cancelled`; a workflow-bound run's workflow told
    after the commit). A run was requested, and approved, against the old build; carrying that approval to another
    build silently is not acceptable, and the requester re-runs.
76. **Supersession ends the old runner's runs in the same transaction** [4227454968]. The superseded runner was
    revoked inside the registration transaction but its leased runs were ended, and their keys revoked, only after the
    commit, so a crash or an audit failure in between left usable keys, and a replay never reconciled. Now the
    registration transaction revokes the runner, ends every run it still leases (cancelled `runner_revoked`, key
    revoked, audited) and audits `engine-runner-superseded`; only the workflow notification follows the commit. A
    registration replay reconciles idempotently: any run still leased by a revoked runner of the engine ends, with
    its key (audited `engine-runner-revoked-runs-reconciled`). The admin revocation route (`DELETE
    /v1/engine-runners/:id`) had the same post-commit gap and now ends the runs in its own transaction too (and
    reconciles when called on an already-revoked runner). A test fails the step right after the commit
    (`engineRunTestHooks.afterRegisterTx`): the run is already cancelled and its key revoked.

**Review round 8 (PR #205, Codex, 2026-10-09; 2 findings, each red first).** Tests: `loop.test.ts` [77],
`zz-b5-promptfoo.test.ts` "review round 8" [77] [78]. No migration.

77. **A committed registration whose response was lost survives its enrolment token's expiry** [4227906414]. If a
    registration committed but every response was lost until the enrolment token expired, a replay was refused (the
    token expired) and a fresh token hit the unique token-hash constraint: the runner was stranded. No gateway
    relaxation (an expired enrolment token is still refused). Instead, a runner resuming a pending enrolment FIRST tries
    the pending secret as its credential, with a lease: any answer but a 401 means the registration committed — the
    secret is stored, the pending record dropped, and the loop carries on (a run that lease handed out is run). Only a
    401 sends it back to registering, with the same secret. A fresh enrolment token with a hash that is already a
    runner's credential is now a clear 409 `engine_runner_already_registered`, decided before the token is spent
    (replacing decision 54's `engine_runner_token_conflict`, which a unique violation still maps to under a race); the
    loop then tries the secret directly, once — refused there too (the runner was revoked), it stops and says so.
78. **The manifest sync decides a build change only from the locked row** [4227906421]. `changedBuild` came from an
    unlocked read, so a second concurrent sync could switch the engine off and clear its self-test after the first had
    installed the new build and a self-test had been refreshed. The unlocked read now only decides whether to look
    closer; inside the transaction, on the engine row taken `FOR UPDATE`, the build comparison decides switching off,
    clearing the self-test, cancelling waiting runs (decision 75) and the audit. When the locked row already carries the
    new build, the sync changes nothing about the build. A two-connection test installs the new build, a passing
    self-test and an enable between a sync's unlocked read and its transaction
    (`engineRunTestHooks.beforeSyncTx`): the engine stays enabled with its self-test, and no disable is audited.

**Review round 9 (PR #205, Codex, 2026-10-09; 4 findings, each red first).** Tests: `promptfoo.test.ts` [80],
`zz-b5-promptfoo.test.ts` "review round 9" [79] [81] [82]. No migration.

79. **The runner credential is not isolated from the engine process yet: the engine stays off until an admin
    accepts that, audited** [4228369415]. The promptfoo child runs as the runner's own user (10001), which owns the
    runner token and its pending record (0600), so a compromised promptfoo process could read the credential from the
    state volume, or from the runner's memory and environment through `/proc` or ptrace (same user); the environment
    allow-list does not help. **What the credential can do:** lease this engine's runs (each with a run-scoped virtual
    key: the run-as person's ceiling, one project, the run's budget, until its deadline), heartbeat them, post their
    results and refresh this runner's self-test report. **What it cannot do:** reach any other route (the runner-route
    allow-list), enable an engine, mint keys outside a lease, or register another runner. A different OS identity for
    the child is not possible under the current posture (non-root, `cap_drop: [ALL]`, `no-new-privileges`): changing
    user needs CAP_SETUID/SETGID, which a non-root process gets only through file capabilities or a setuid helper, and
    `no-new-privileges` disables both at exec; user namespaces are blocked by the default seccomp profile.
    **Rejected:** (A) dropping `no-new-privileges` and giving a dedicated runner binary SETUID/SETGID file capabilities
    (weakens the whole container: any setuid or file-capability binary in the image becomes usable); (B) a root
    process with only SETUID/SETGID that spawns the runner and the engine (a root process in the container).
    **Chosen (coordinator, 2026-10-09, pending owner confirmation):** (C) the two-container split, as the next slice
    (B5-P2, open question 13); and (D) in this PR, the risk recorded here and enforced fail-closed in code. The manifest
    says per build whether it isolates the credential (`credentialIsolation`, false for every build today); enabling
    an engine whose build does not is refused, 409 `engine_credential_isolation_missing` with the reason, unless the
    request carries `acceptCredentialIsolationRisk: true`. That acceptance is a relaxation bound into the
    `settings_relax` step-up (`engine.<id>.acceptCredentialIsolationRisk`) and audited on its own
    (`engine-credential-isolation-risk-accepted`, with the build). Secure by default; the relaxation is explicit and
    audited (ADR-0180).
80. **`vlsu` is a planning-time `missing_preseed` exclusion** [4228369423]. It downloads its dataset at run time
    (R10), but upstream's `DATASET_PLUGINS` omits it, so planning treated it as unknown and a mixed run went unknown.
    A local supplement to the generated list (`PROMPTFOO_DATASET_PLUGINS_SUPPLEMENT`, with a comment) classifies it as
    `missing_preseed`; a test fails once upstream lists it, so the supplement can then be dropped.
81. **The required judge is checked again at lease** [4228369430]. A judge agent deleted after queueing nulls the
    run's `judge_agent_id`, and the lease skipped the judge check and dispatched a `requiresJudge` run with no judge.
    The lease transaction now applies the manifest's `requiresJudge` again: such a run ends `not_run` with
    `judge_required` (audited `engine-run-not-run`) before any key is minted.
82. **A build change cancels runs in flight on the old build too** [4228369436]. A run leased to the old build was
    normalised with the current catalogue after an upgrade. **Picked: cancel**, the simpler secure option: the
    locked-row build change of decisions 75 and 78 now also cancels every leased run of the engine
    (`engine_build_changed`, key revoked, audited), so its result arrives late and is refused (409), never ingested.
    Normalising against the catalogue a run was leased under would need that catalogue kept per build on every
    replica (or stored per run), and a replica still on the old manifest could then judge the same result differently
    from one on the new; with cancellation no result is ever normalised against a catalogue other than the one in the
    manifest every replica now has.

**Review round 10 (PR #205, Codex, 2026-10-09; 3 findings, each red first).** Tests: `runner.test.ts` [83],
`zz-b5-promptfoo.test.ts` "review round 10" [84] [85]; the engines test of an admin's disable now expects its queued run
ended. No migration.

83. **A transient failure of the starting heartbeat no longer abandons a leased run** (review body, no thread). The
    first heartbeat after a lease threw on a transport error, `runOnce` threw, the work directory was deleted and the
    run was left to time out. The starting heartbeat is now retried on a transient failure (a network error, a 5xx, a
    408, a 429; the client throws for those) with a bounded backoff (`maxStartAttempts`, default 8, doubling from
    `retryBaseMs`, capped at 30 s), never past the run's deadline. Only a definitive refusal (401, 404, 409: the
    gateway no longer knows the lease) or running out of attempts or time abandons it, reported as `cancelled`, not
    thrown, so the loop does not treat it as a crash. The periodic heartbeat likewise no longer cancels the run on a
    5xx (it is transient and ignored; the lease's own expiry is the backstop).
84. **Every path that switches an engine off ends its active runs in the same transaction** [4228874846]. A failing
    self-test switched the engine off but left other runners' leases and their virtual keys alive, so a run could keep
    calling models after an egress-policy failure. One helper (`endActiveRunsOfEngineTx`) ends every leased, queued and
    awaiting-approval run of the engine (cancelled, key revoked, pending approval superseded, audited; workflows told
    after the commit), inside the transaction that holds the engine row `FOR UPDATE`, with the reason as the error code.
    **Paths covered:** a failing runner self-test (`engine_self_test_failed`), a failing admin self-test
    (`engine_self_test_failed`), an admin's disable (`engine_disabled`), and a build change in the manifest sync
    (`engine_build_changed`, decisions 75 and 82). A runner's revocation (admin, or a supersession) does not switch the
    engine off; it ends that runner's leased runs in its own transaction (decision 76). Once a run is not leased, its
    heartbeat answers `cancel: true` and its result is refused (409), as before.
85. **An obsolete-build runner can never change the current build's engine** [4228874856]. During a rolling upgrade an
    old runner presenting its own (old) registered build was told `self_test_required`; its old-build report was then
    accepted and could switch the newly enabled engine off, repeatedly. The lease admission now also compares the
    runner's registered build with the CURRENT manifest build (a null manifest digest never matches): a mismatch is
    `reenrol_required`. The runner self-test route refuses any report whose build is not the current manifest build:
    409 `engine_runner_reenrol_required`, no change to the runner's stored report or to the engine, audited
    `engine-runner-self-test-obsolete-build`. A two-build test registers a runner of an obsolete build and has it try
    to switch the upgraded engine off.

**Review round 11 (PR #205, Codex, 2026-10-09; 5 findings, three in the review body; each red first) and a sweep for
the pattern behind them.** Tests: `runner.test.ts` and `loop.test.ts` [89] [90], `zz-b5-promptfoo.test.ts` "review round
11" [86] [87] [88] and the sweep's re-check. No migration. **The rule from here on:** an engine state change is decided
and written in ONE transaction, on rows it holds locked (or with the condition in the write's own predicate), together
with its audit; work that follows a commit is limited to notifying workflows, which the workflow sweep retries.

86. **Cancellation is one transaction** (review body). The cancel route committed `cancel_requested_at`, then ended the
    run in a second transaction, so a crash in between left a run marked cancelled but live with its key. The marker,
    the terminal transition, the key's revocation, the approval's supersession and the audit now commit together on
    the run row taken `FOR UPDATE`; a test crashes inside it (`engineRunTestHooks.afterCancelMarked`) and finds the
    run untouched (still leased, no marker, key live), then cancels it in one go.
87. **Run creation re-validates the engine inside its insert transaction** (review body). The engine's state and limits
    were checked before the transaction and the run inserted without a lock, so a concurrent disable or ceiling drop
    could miss it. The insert transaction now takes the engine row `FOR SHARE` (every switch-off takes it `FOR UPDATE`,
    decision 84) and decides again there: on (409 `engine_disabled`), its recorded self-test admitting it (409
    `engine_self_test_required`), the budget within the ceiling as it is now (422 `engine_budget_exceeds_ceiling`), and
    the timeout clamped to the engine's ceiling as it is now; the creation's audit commits with the run. Schedules and
    workflow stages create runs through the same function. (One test changed order: the round 2 [53] test now queues
    its run while the engine's record is fresh, since creation itself now needs it to admit the engine.)
88. **A schedule's claim requires it to be on** (review body). The claim compared only the id and the old `next_run_at`,
    so a schedule switched off after the sweep's read still started a run. The claim's predicate now includes
    `enabled = true`; the schedule's outcome (`last_run_id`, `last_skip`) and its skip audit then commit together.
89. **Every runner request is bounded** [4229319159]. Runner fetches had no timeout. Every request, body included, is
    now aborted after `requestTimeoutMs` (default 30 s), or at the run's deadline when that is sooner (heartbeats and
    results carry it). A timeout throws like a network error (`RunnerTimeoutError`), so each caller's existing transient
    handling applies: the loop backs off and retries, the result post retries, the starting heartbeat retries (decision
    83). The bound holds even for a transport that ignores the abort signal (the request races the timer).
90. **Undelivered results survive a restart** [4229319167]. They were kept under the tmpfs `/work` and lost on restart.
    `runOnce` now writes an undelivered envelope under `retainRoot`, which the promptfoo runner sets to
    `/state/undelivered` on its persistent state volume (0700, the runner's own), apart from the engine's work dirs;
    before every lease the loop delivers or drops what is retained there (and anything left in the work root), as in
    decision 68. No new exposure: per decision 79 the engine process shares the runner's user and could already read the
    state volume; the retained envelope holds no credential, only the run's own result.

**The sweep (round 11): every other instance found in this PR's engine code, now fixed the same way.**
- The lease's refused path (run-as gone, not entitled, no project, no model, no judge) ended the run in a second
  transaction after the lease transaction decided; it now ends on the row the lease transaction holds.
- An expired heartbeat ended the run in a second transaction; it now ends under the heartbeat's own row lock.
- The run sweep's timeouts and the queue-expiry sweep read their candidates without a lock and ended them by status
  alone; each now re-checks its condition (still overdue, still expired) on the locked row, so a lease a heartbeat
  renewed in between is not timed out (a test renews one between the sweep's read and its end).
- The admin self-test read the newest runner's report outside its transaction; it now reads it `FOR SHARE` inside,
  before taking the engine row (the lock order of the lease and the runner self-test).
- Audit rows written after their state change had committed, now in the same transaction: run creation, schedule
  creation, a schedule's switch on or off (now also decided under the schedule's row lock), a schedule sweep's skip, the
  manifest sync's switch-off, the admin self-test, an enrolment token's minting, a runner's registration, revocation
  and replay reconciliation, and a runner's self-test report. (Audits of refusals that change nothing, such as a late
  result or an obsolete-build report, stay single writes.)
- Checked and left as is: the PATCH engines route, the runner self-test route and the lease already decide under their
  locks; the approval decision runs inside the approvals transaction; the result route ends the run through a
  status-checked transaction under the run's lock; the schedule sweep's claim is committed before creating the run on
  purpose (PR #203 review round 2 [23]: a creation that throws is then an audited skip, never lost).

**Review round 12 (PR #205, Codex, 2026-10-09; 3 findings, each red first).** Tests: `loop.test.ts` [91] [92],
`zz-b5-promptfoo.test.ts` "review round 12" [91] [92] [93], and the engines test of a wrong-digest registration (now
refused). No migration. **The root cause, fixed once:** there was no single definition of which runner reports count for
the current build. There is now one: `isCurrentBuild(manifest, build)` (the manifest's digest, never null, and version)
and `runnerCountsForCurrentBuild(manifest, runner, report?)` (the runner's registered build is the current build, and so
is the report it presents, if any), both in `apps/gateway/src/engines.ts`. **Every reader and writer of self-test state
goes through them:**
1. the lease's admission (`leaseAdmission`): a runner that does not count is told `reenrol_required`;
2. the runner self-test route: a report from a runner, or of a build, that does not count changes nothing (409,
   audited), and its "the engine's record is for the current build" check uses `isCurrentBuild`;
3. the admin self-test: only a runner that counts is judged (decision 91);
4. registration: a build that is not the current one is refused (decision 91);
5. `selfTestAdmitsEnable` (the engine's recorded self-test), which the enable PATCH, the lease and run creation use.

Two checks stay apart on purpose: the shared `evaluateRunnerSelfTest` still reports `digest_mismatch` and
`version_mismatch` as verdict failures (what a report says, not whose report counts), and the manifest sync compares the
engine row's stored build with the manifest's (a build change of the engine, not of a runner).

91. **Only current-build runners count, and an obsolete build cannot register** [4229889819]. The admin self-test took the
    newest live runner whatever its build, so an obsolete runner's report could fail the verdict and switch the current
    engine off. It now judges the newest live runner whose registered build is the current build (selected by that build
    and checked with the predicate); with none, it refuses with 409 `engine_no_current_build_runner` and changes nothing.
    **Decided: registration refuses an obsolete build outright** (secure by default: an old container can never come back
    as a live runner): 409 `engine_runner_build_obsolete`, decided before the enrolment token is spent, audited
    `engine-runner-register-obsolete-build`. The runner loop treats that refusal as final: it stops with a
    `RunnerObsoleteBuildError` saying to deploy the current image, and the promptfoo shim then parks (stays up and idle,
    repeating the reason once a day) instead of exiting into the restart policy's loop. Tests that need a runner of an
    earlier build now make one the way an upgrade leaves it: registered while its build was current, its row then naming
    the old build.
92. **A lost, then revoked, pending secret is replaced** [4229889826]. A runner that registered, lost the response before
    storing its credential, and was then revoked was stuck: its pending secret got 401 as a credential, and registering it
    again with a fresh token got 409 `engine_runner_already_registered` (the revoked row still owns the hash). Now, when the
    pending secret was refused as a credential AND its hash is registered, the loop discards it, generates a new secret
    (persisted as the pending enrolment first, with the same `supersedes`), and registers that with the same, still
    unused, enrolment token (once; a second refusal stops with the reason). On the gateway a revoked runner's hash still
    blocks reuse of that hash; a new hash registers normally. A gateway test registers a runner, loses every response so
    nothing is stored, revokes it, and restarts with a fresh token: the runner ends up registered with a new credential
    and the revoked one stays dead.
93. **A failing current-build report always clears the engine's pass** [4229889832]. A failing report while the engine
    was already off left its passing self-test in place, so an admin could re-enable it on contradicted evidence. A
    failing report from a runner that counts now always records the failure and clears `self_test_passed_at`, whatever
    the engine's state; only ending its active runs (decision 84) depends on it switching the engine off. A test switches
    the engine off, submits a failing report, and finds re-enabling refused with `engine_self_test_required`.

**Review round 13 (PR #205, Codex, 2026-10-09; 3 findings, each red first) and a sweep of the runner client.** Tests:
`loop.test.ts` [94] [95] [96], `durable.test.ts` [96], `zz-b5-promptfoo.test.ts` "review round 13" [94] [95].
**Migration 0174** (`0174_engine_lease_request_and_manifest_generation`, hand-written): `engine_runs.lease_request_id`
(uuid, unique per runner where set) and `engines.manifest_generation` (integer, default 0, never negative).

**The sweep (round 13), of the runner client, for two classes of bug.**
- (a) A request whose server side commits state, where a timeout or a lost response leaves the runner unable to learn
  the outcome:
  - **the lease**: the only one with no recovery. A lost 200 left a leased run, with a minted key, that no runner ran
    until its lease expired. Fixed by decision 94.
  - registration: already idempotent (a same-hash replay returns the same runner, decision 54; a pending secret is
    probed as a credential, decision 77; a revoked pending secret is replaced, decision 92). No change.
  - the runner self-test: a resubmitted report overwrites the stored one with the same verdict. Idempotent; no change.
  - heartbeats: a repeated heartbeat renews the same lease. Idempotent; no change.
  - the result post: a retry after a lost 2xx gets a definitive 409 `engine_run_finished`, which ends the retries and
    removes the retained envelope. No change.
- (b) A persisted file that can be left truncated:
  - the runner token file and the pending enrolment record were renamed into place atomically but never fsynced (the
    file or its directory), so a power cut could leave an empty or partial token. Fixed by decision 96.
  - the retained result envelope was written in place with a plain `writeFile` (neither atomic nor fsynced). Fixed by
    decision 96.
  - the engine's own work files live on a tmpfs and are discarded on restart by design. Not persisted; no change.

94. **The lease is idempotent** [4230481439]. The runner now sends a `requestId` (a UUID it generated) with every lease
    attempt and keeps it while the attempt's outcome is unknown: a timeout, a dropped connection, a 5xx, or a refusal
    with no `next` signal. It drops the id once the gateway answers definitively (a lease, 204, or a refusal carrying
    `next`), so its next attempt is a new one. The gateway records the id on the run it leases. A retry with the same
    id, from the same runner, while that run is still leased to it (not ended, not cancelled, lease and deadline not
    passed), returns that run again instead of leasing a second one. The lookup is by (runner, request id), under the
    runner's row lock, and the unique index is per runner: another runner presenting the same id matches nothing of the
    first runner's and is treated as a fresh lease. A request id whose run is no longer live leases nothing (204).
    **Credentials are re-issued by ROTATION, not by re-showing the key.** Only the key's hash is stored, so the original
    key cannot be returned again. In the re-issuing transaction the old key is revoked (audited
    `engine-run-key-revoked`, cause `lease_reissued`) and a new key is minted with the same models, the same project and
    the run's deadline. Its budget is the run's budget, and it carries what the run's earlier keys already spent
    (`spent_usd`), so the run's ceiling holds across keys. At most one key of the run ever works. The run points at the
    new key, its lease is renewed like a heartbeat, and the re-issue is audited `engine-run-lease-reissued`. Minting a
    second key alongside the first was rejected: it would leave two working credentials for one run. A run's cost
    (`runCostUsd`) is now summed over every key the run has held. Tests: a retry gets the same run with a different key
    and the old key revoked; usage on both keys counts toward the run's cost; a second runner presenting the id never
    gets the run nor rotates its key; a retry after the run ended gets 204.
95. **The manifest sync is monotonic** [4230481454]. Each shipped manifest entry carries a `generation` (a positive
    integer, bumped with every build change), and the engine row records the generation it was written from. The sync
    compares them under the row's `FOR UPDATE` lock. A replica whose manifest generation is older than the row's (an old
    replica during a rolling upgrade) writes nothing, cancels nothing and disables nothing. On that replica the engine is
    unavailable: the lease (no `next` signal, so the runner keeps its state and retries), run validation and creation
    (both the unlocked check and the one under the row's `FOR SHARE` lock), enabling, the admin self-test, the runner
    self-test and registration all refuse with 409 `engine_manifest_outdated`. Each decides from the row it reads or
    locks, so a newer replica that syncs after this one started is seen at once. Switching the engine off and lowering
    its limits stay available, since they only tighten. The refusal is audited `engine-manifest-outdated` once per
    replica (per manifest in use, engine and row generation), not once per request. The runner treats this refusal as
    transient everywhere, and at registration it does not use up the registration attempts. Registration checks the row
    without a lock, before the enrolment token is spent; a registration that slips past a concurrent upgrade is of an
    obsolete build, which every later report and lease refuses through the current-build predicate (round 12). An equal
    generation with different content keeps the earlier behaviour (the build comparison under the lock); bumping the
    generation with every build change is part of the manifest's contract. Tests: with the row at a newer generation and
    build, this replica's sync leaves the row, the engine's enabled state and pass, and a waiting run untouched; a lease,
    a creation, an enable and a runner self-test each get 409 `engine_manifest_outdated`; one audit row covers all of
    them.
96. **Persisted runner files are written durably** [4230481447]. Open-source check (ADR-0176): `write-file-atomic`
    (npm's own, ISC, 8.0.0) writes a temp file beside the target, fsyncs it, sets mode 0600 and renames it over the
    target. It does not fsync the directory, so `packages/engine-runner/src/durable.ts` adds that one step. The runner
    token, the pending enrolment record and the retained result envelope all go through it, and clearing the pending
    record fsyncs the directory too. On startup the retained-result scan acts on the final file name only: a directory
    with just the temp file of an unfinished write holds no result and is removed as before; a valid result next to a
    stray temp file is delivered as usual. A result file that exists but cannot be read or parsed is never a reason to
    delete anything: it is renamed aside to `undelivered-result.json.corrupt-<time>`, logged, and its directory is left
    alone from then on (not delivered, not counted against the retention cap, never removed) for an operator to
    inspect. Tests: the file and directory fsyncs are observed for the token, the pending record and an undelivered
    envelope; a simulated crash before the rename leaves the previous token intact; a truncated result is quarantined
    and survives a second start.

**Review round 14 (PR #205, Codex, 2026-10-09; 2 findings, each red first) and a sweep of the run-policy reads.**
Tests: `zz-b5-promptfoo.test.ts` "review round 14" [97] [98]. No migration.

97. **Run creation decides its approval in the insert transaction** (review body). The approval decision (an
    agentic, offensive or unclassified set while sensitive-set approval is on, or a budget over the org's threshold),
    the default budget, the timeout clamp and the approver came from org settings read before the transaction. A
    concurrent tightening could be missed, and the lease does not recompute approval. `runPolicyDecision` is now the
    one decision. Validation calls it on unlocked reads. Creation calls it again inside its insert transaction, on
    the org settings row taken `FOR SHARE` and then the engine row `FOR SHARE`, and acts only on that second
    decision. That decision covers the budget ceiling, the timeout, whether approval is needed, and a valid approver
    (one exists, is active, and is not the person the run executes as).
    - **Lock order:** org settings, then engine. No path locks them the other way round: the engine writers never
      touch org settings, and the org-settings writers never touch an engine row.
    - **The writer serialises with it.** `PUT /v1/org/settings` takes the org row `FOR UPDATE` before it writes.
      Every other org-settings writer UPDATEs that row, which conflicts with `FOR SHARE` too. A tightening either
      commits before the creation reads the row, or waits for the creation to commit.
    - **Test:** the threshold drops below a run's budget between validation and insert (`beforeCreateTx`). The run
      is created `awaiting_approval`, with its approval, not `queued`.
98. **A retried lease is resolved before freshness** [4231351179]. The idempotent-lease lookup ran after the
    freshness admission (the runner's and the engine's self-test age). A retry just past the 24-hour boundary was
    therefore refused with `self_test_required`. The runner dropped its request id, and the run the lost attempt
    leased was orphaned until its lease expired.
    - **Both paths resolve it first.** The unlocked fast path skips its early admission when the request id names
      one of this runner's runs. The locked path looks the run up before the admission, under the runner row
      (`FOR UPDATE`) and the engine row (`FOR SHARE`) it already holds.
    - **Only the hard gates apply:**
      - the runner is live (a revoked runner's runs are already ended by its revocation);
      - the presented build is the one it registered;
      - the engine is on;
      - the manifest is not outdated;
      - the run is still leased (not ended, lease and deadline not passed).
    - **When a gate fails, the run is ended in that transaction, never left leased.** A failed build or engine gate
      cancels it (`lease_retry_refused`, key revoked, audited) and returns that gate's refusal with its `next`. A
      passed lease or deadline ends it as a timeout and returns 204.
    - **An outdated manifest is the one exception: nothing is ended.** The retry gets 409
      `engine_manifest_outdated`, and a current replica resolves it (decision 95: an outdated replica cancels
      nothing).
    - **A retry of a run that already ended re-issues nothing.** The runner is told why when a lease would be refused
      now (for example 409 `engine_disabled` after an admin disabled the engine and decision 84 ended its runs), and
      otherwise gets 204.
    - **Tests:**
      - A lease commits and its response is lost. Both self-tests then pass the 24-hour mark: a fresh attempt is
        refused for freshness, but the retry gets the same run back with its key rotated.
      - The engine is switched off with the run left leased. The retry gets 409 `engine_disabled`, and the run is
        ended with its key revoked.
      - An admin disables the engine, which ends the run. The retry gets 409 `engine_disabled`, and the run stays
        ended.

**The sweep (round 14): policy values that gate engine runs, and where each is decided.**
- **Fixed in this round (decision 97), now decided in the creation transaction:**
  - the org's approval threshold;
  - sensitive-set approval;
  - the default run budget;
  - the maximum run timeout;
  - the default approver and the approver's validity.
- **Already decided in the transaction that acts on them (no change):**
  - the engine's budget, timeout and concurrency ceilings, and its enabled state and recorded self-test (creation
    transaction, decision 87; lease transaction, decision 71);
  - target and judge entitlement, each agent's provider model, the manifest's required judge, and project
    attribution. Creation only queues a run, which needs no key. The lease transaction re-decides all of these before
    it mints a key, and ends the run `not_run` when one fails (decisions 70 and 81, and PR #203 review [10]). The
    key's allowed models are derived there, from the run's own target and judge.
  - an approval's release, which is decided inside the approvals transaction.
- **Not a gate:**
  - the raw-report retention days, read when a result is stored and by the purge sweep. This is a retention
    setting, not a gate on a run.
  - data sensitivity. Engine runs carry no data-sensitivity classification, so nothing gates on it.

**Review round 15 (PR #205, Codex, 2026-10-09; 2 findings, each red first; Codex's security review was clean) and a
sweep of lock orders.** Tests: `loop.test.ts` [99], and `zz-b5-promptfoo.test.ts` "review round 15" [100]. No
migration.

99. **Nothing after the lease is acquired re-leases the run** [4231888495]. The lease's request id stayed live for the
    whole of `runOnce`. Any exception after acquisition that was not an HTTP error was treated as transient, for example
    a failure to persist `undelivered-result.json` on a full volume. The loop then retried with the same id, the gateway
    re-issued the still-live lease (decision 94), and the evaluation and its paid model calls ran again. `runOnce` now
    has two explicit phases:
    - **Phase 1, the lease request.** Its outcome can be ambiguous: a timeout, a lost response or a 5xx. Only an error
      thrown here reaches the loop, which keeps the request id when the error is transient.
    - **The id is retired.** As soon as the answer is definitive (a lease parsed, or 204), `onLeaseSettled` retires it,
      before anything else runs.
    - **Phase 2, post-acquisition (`runLeased`).** Nothing here surfaces as an error the loop could retry. A failure is
      reconciled by `reconcileAfterAcquisition`. The envelope, if one is in memory, gets one more delivery attempt; with
      none, the run is reported `failed` with code `engine_error` (the reason goes to the runner's log, since the
      envelope schema is strict). If that post is not definitive either, the outcome is `abandoned`: the run is left to
      time out at the gateway, which ends it and revokes its key. The run is never executed twice.
    - **Test.** A lease succeeds, the adapter runs, delivery fails and persisting the envelope throws ENOSPC. The
      adapter ran exactly once. No lease reused the request id: the second lease carried a new id, although the fake
      gateway re-issues a known one. The envelope in memory was delivered by the reconciliation.
100. **One lock order for engine state: engine (where taken) → run → approval** [4231888491]. The approval decide path
     wrote the approval row and then locked its run. Cancel, a workflow ending, and every switch-off lock the run and
     then supersede its approval, so a cancel racing a decision could deadlock (a 500). The decide route now calls
     `lockEngineRunOfApprovalTx` inside its transaction before it writes the approval. It locks the run with that
     approval `FOR UPDATE`, which is the same run → approval order as every other path. The approvals module allowed
     this: its transaction is ours to order, and the engine-run hook already ran inside it. A test cancels a run awaiting
     approval and, while the cancel holds the run, starts the decision on another connection. The cancel completes, and
     the decision waits, then gets a clean 409 `approval_superseded`. Before the fix, Postgres aborted one side as a
     deadlock.

**The sweep (round 15): every pair of rows the engine code locks, and the order each path takes.** The order is
**runner → engine → run → approval / key**, with org settings before engine.
- **Runner ↔ engine.**
  - The lease: runner `FOR UPDATE`, then engine `FOR SHARE`.
  - The runner self-test: runner `FOR UPDATE`, then engine `FOR UPDATE`.
  - The admin self-test: runner `FOR SHARE`, then engine `FOR UPDATE`.
  - No path locks the engine and then a runner. Registration and revocation lock runners, then runs, and never the
    engine.
  - Consistent; no change.
- **Org settings ↔ engine.** Run creation takes org settings `FOR SHARE`, then engine `FOR SHARE` (decision 97). Nothing
  else takes both. Consistent.
- **Engine ↔ run.**
  - The lease: engine, then the queued run (`SKIP LOCKED`) or the retried run.
  - Creation: engine, then inserts the run.
  - The manifest sync, an admin's disable and the self-tests: engine `FOR UPDATE`, then the engine's runs.
  - No path that holds a run then locks an engine: cancel, heartbeat, result and the sweeps touch only runs, keys,
    items, ledgers and approvals.
  - Consistent.
- **Runner ↔ run.** The lease and revocation lock the runner, then runs. The heartbeat and result paths lock only the
  run. Consistent.
- **Run ↔ approval.** Fixed by decision 100.
  - Every path now takes the run first: cancel, `cancelEngineRunsOfInstance` (whose workflow caller supersedes only the
    instance's non-engine approvals first), `endActiveRunsOfEngineTx`, and the decide route.
  - The workflow instance row, where one is held, comes before both.
- **Run ↔ key.**
  - Ending a run (`endLockedRun`) and a lease re-issue (decision 94) lock the run, then revoke or mint its key.
  - The model-call path updates a key's `spent_usd` and never locks a run.
  - Consistent.

**PR #205 follow-up (2026-10-09, branch `b5-p-followup`; 2 findings from the merged PR's review threads, each red
first).** Tests: `runner.test.ts` and `loop.test.ts` "follow-up [101]", `zz-b5-promptfoo.test.ts` "[102]". No migration.

101. **A 2xx whose body is not a valid answer is transient, never definitive** [4232403372]. The runner client turned a
     body that did not parse as JSON into `null`. A lease that committed at the gateway, answered 200, and lost the end of
     its body therefore read as "no work": `runOnce` retired the request id, reported idle, and the run with its minted key
     sat orphaned until its lease expired. Now:
     - **Only a 204, or a 200 whose body parses AND matches the lease schema, is definitive.** The answer schemas live in
       the shared contract (`engineLeaseResponseSchema` and its siblings, typed against `EngineLease`; not strict, so a
       newer gateway may add fields). Any other 2xx (a body cut off, not JSON, the wrong shape, or an unexpected 2xx status)
       throws `RunnerMalformedResponseError`.
     - **It is transient, exactly like a timeout (decision 94).** It is not a `RunnerHttpError` and carries no `next`, so
       the loop keeps the request id and retries; the gateway returns the run that attempt leased, its key rotated.
     - **A refusal keeps its old reading.** A non-2xx whose body does not parse is a refusal with no code and no `next`,
       which was already transient.
     - **Test.** A lease answers a truncated 200, then a 200 that is JSON but not a lease, then the lease. All three
       attempts carry the same request id, the adapter runs once, the result is posted, and the next attempt is a new id.
       Red with the parse failure mapped back to `null`: the first answer reads as idle and the run never runs.

     **The sweep (follow-up [101]): every runner-client call that read a body, by its own idempotency.**
     - **Lease:** fixed as above.
     - **Registration:** a malformed 201 threw `register refused (201)`, which the loop counted as a definitive refusal and
       STOPPED the runner, although the registration had committed. It now throws `RunnerMalformedResponseError`; the loop
       then confirms the same secret as the credential (decision 77's path: any authenticated answer keeps it, a 401
       registers it again, which the gateway replays for the same hash, decision 54). The attempts cap still bounds a
       gateway that never answers well. Red: the old mapping stops the loop with "registration did not succeed (201)".
     - **Heartbeat:** a malformed 200 returned `null`; the caller's `hb.cancel` then threw a `TypeError` that happened to be
       treated as transient, and a 200 with `{}` read as "carry on". Now it throws `RunnerMalformedResponseError`: neither
       "carry on" nor "stop" is read into it, and both callers already retry a throw (a heartbeat is idempotent). A
       definitive refusal (409, 404, 401) still stops the run.
     - **Self-test:** a malformed 200 threw a `RunnerHttpError` with status 200 (transient only by accident), and a body
       with any truthy `selfTest` passed unchecked. Now it is schema-checked and throws `RunnerMalformedResponseError`;
       resubmitting a report is idempotent.
     - **Result post:** no change. Its status line is the whole answer and the body is never read: a 2xx means the gateway
       stored the result, and a retry after it gets the definitive 409 `engine_run_finished` anyway.
     - **Retained results** (`retryRetainedResults`) and the reconciliation after acquisition (decision 99) go through the
       result post: covered by the line above.
102. **A re-issued lease carries the run's real spend** [4232403382]. Decision 94's rotation minted the new key at the SUM
     of every key's `spent_usd`. Each replacement key starts at the amount carried into it, so from the second re-issue on
     that sum counted the carried amount again: $0.20 spent on each of the first three keys carried $0.20, then $0.60, then $1.40 into the next,
     and retries alone exhausted a $1 budget. The carried amount is now what the run actually spent, read off the usage
     ledger over every key the run has held (`runCostUsd`, the same figure the run's cost reports). This also counts a
     late charge to a key revoked by an earlier rotation, which the newest key's counter alone would miss. No column was
     needed. The decision 94 text "carries what the run's earlier keys already spent" stands; its arithmetic was wrong.
     **Test:** three rotations with $0.20 spent at each step (the ledger row and the key's counter, as a model call
     writes them). The fourth key carries $0.60, a model call on it is served (200), and the key's counter and the run's
     cost both equal the ledger. Red with the old sum: the fourth key carries $1.40 and the call is refused 402.

103. **A malformed registration answer at the attempt cap is still confirmed** (#210 review, [4234145857]). Decision
     101 sent a 2xx registration answer with no valid body to the confirmation path (try the secret as a credential),
     but checked the attempt cap first: the last permitted attempt (or the only one, `registerAttempts: 1`) stopped the
     runner although the registration may have committed, spending the enrolment token and leaving a live credential.
     The cap now applies only after the confirmation: the secret is always tried first, and the loop stops only if
     that confirmation is refused (401). A malformed answer also clears an earlier refusal, since that attempt may
     itself have committed. **Test:** `registerAttempts: 1` and a truncated 201: the secret is stored and leases
     (red before the fix: a fatal stop); and the same with the confirmation refused: a fatal stop, nothing stored.

**Test-only, not a decision:** `api-key-expiry.test.ts` "EXPIRED and REVOKED are different answers" failed once in CI
(3 audit rows, not 2). It selected rows with `at >=` a JS-clock timestamp, so the revoke's own audit row could be counted:
a pre-existing clock dependence, not engine code. That test and its two siblings now assert on the id-set difference of
the audit rows, as the Outlook courier test does.

### Implementation decisions (B5-M modelscan, 2026-10-09, branch `b5-modelscan`)

Built from G19's "Consequences for B5-M" (`docs/research/R10-engine-admission.md`) with the coordinator's brief. **Migration
0175** (`0175_model_artifact_scans`, hand-written, journal `when` 1785110000000): the upload-size setting, the
`no_known_unsafe` verdict, a format CHECK on artifacts and scans, `clean` only for safetensors, one scan per run, and
content-addressed storage keys. Code: `packages/shared/src/engines/modelscan.ts` (the scanner contract), the shim
`packages/engine-modelscan` (runner, scanner, exchange, adapter, settings mirror), `packages/engine-runner/src/artifact.ts`,
`apps/gateway/src/model-artifacts.ts`, `engines/modelscan` (image, lockfile, settings, patch, licence gate), compose
`engine-modelscan` and `engine-modelscan-scanner`. Tests: `packages/engine-modelscan/src/modelscan.test.ts` (20),
`exchange.test.ts` (7), `image.test.ts` (5), `settings.test.ts` (3), `modelscan-real.test.ts` (5, opt-in: the pinned
modelscan itself, `REGULAIT_MODELSCAN_BIN`), `apps/gateway/src/zz-b5-modelscan.test.ts` (11, the real gateway),
`model-artifacts.test.ts` (5), `zz-b5-compose.test.ts` (+1). Each guard was shown red by breaking it (mutations recorded
with each decision).

104. **Two containers, one image: the process that parses the artifact has no network and no credential.** G19's
     profile asks for `network_mode: none`, but a runner must reach the gateway to lease, heartbeat, fetch and post.
     So the image runs as two compose services. The **runner** (`engine-modelscan`) merges the hardened template: on
     `engines`, its own state volume, never running modelscan. The **scanner** (`engine-modelscan-scanner`) has
     `network_mode: none`, a read-only root, uid 10001, `cap_drop: [ALL]`, `no-new-privileges`, 1 GiB memory, 1 CPU,
     64 pids, no token, no state; it mounts the job volume (the artifact) read-only and has one writable tmpfs, `/out`
     (the result volume). Both exchange volumes are tmpfs-backed. The runner downloads into `jobs/<runId>.staging`,
     writes `job.json`, and renames the directory (a job appears whole); the scanner writes `report.json` then
     `done.json` (exit code, killed or cancelled, the report's sha256); a cancel is a `cancel` file; the runner reads
     the report only if its sha256 matches. Run ids must be UUIDs and the artifact name `artifact.(pkl|pt|npy|zip|h5)`,
     so neither side can be steered to another path. The scanner enforces the wall-clock limit (the run's remaining
     time less a margin) by killing modelscan's process group; the runner gives up a grace period later and reports
     `engine_timeout`. **The scanner's own egress self-test** (the same probe, run inside the no-network container) is
     written to the result volume hourly; the runner reports it as the manifest's one usage-data entry,
     `REGULAIT_MODELSCAN_SCANNER_ISOLATED`, true only when fresh (2 h), naming the pinned version and reaching nothing,
     so a scanner with a network, or none at all, fails the self-test and the engine cannot be enabled.
     **`credentialIsolation` stays false** (coordinator's brief; decision 79's audited, stepped-up acceptance applies):
     this layout does keep the credential out of the scanner, but the flag waits for a built and verified image.
     Red: the compose test fails with the scanner given `networks: [engines]`.
105. **What clean means: safe formats only — owner decision, 2026-10-09.** Built strict and confirmed by the owner
     as built. modelscan is one signal and a deny-list, so it cannot certify that an executable format is safe to
     load. Rejected: extending the deny-list alone, and our own allow-list of pickle globals (open question 14). The gateway derives the
     artifact's verdict (`deriveArtifactScanVerdict`) from the format IT detected at upload, never from the runner:
     - any unsafe operator → `unsafe`, however the run ended;
     - a run that did not complete → `unknown` (`not_run` when it never ran);
     - the runner reporting a different format → `unknown`;
     - an unsupported format → `not_run`;
     - any unknown item or run-time not-run → `unknown`;
     - otherwise the format's ceiling: **`clean` only for a verified safetensors file**; an executable format (pickle,
       joblib, dill, legacy or zip PyTorch, numpy, Keras H5) is at best **`no_known_unsafe`**, always with an
       `executable_format` finding; a zip of unknown layout, an opaque zip or an unrecognised file is never better
       than `unknown`.

     Only `clean` is admissible (`artifactScanAdmissible`). The engine run's own verdict for an executable format is
     `fail` (the `format` item is a finding). The DB refuses `clean` for any format but safetensors
     (`artifact_scans_clean_format_check`). The chip wording is fixed and never says "safe": "Non-executable format
     verified; no finding", "No known-unsafe operator found (executable format)", "Unsafe operator found", "Scan
     inconclusive", "Not scanned (unsupported format)". Red: making pickle's ceiling `clean` fails the clean-pickle
     proof; trusting the runner's format claim, or ignoring an error item beside a passing scan, fails the
     consistency proof; a forged runner envelope through the real gateway reads `unknown`.
106. **The licence gate and its allow file; numpy's runtime code accepted with a recorded exception — owner
     decision, 2026-10-09.** `engines/modelscan/licence-gate.mjs` runs in the build on the INSTALLED site-packages:
     every distribution by its METADATA licence, every native library a wheel bundles (`<pkg>.libs/*.so*`) by a fixed
     table, and the Python runtime. A term on the ADR-0176 list passes; anything else passes only when
     `licence-allow.json` names that subject and that licence AND the entry's decision is either a recorded owner
     acceptance, "accepted by owner <YYYY-MM-DD> (ADR-NNNN decision N)", or exactly "pending owner decision"; an entry
     with any other decision, or matching nothing (stale), fails the build.
     - **Accepted by the owner, 2026-10-09 (a recorded exception to ADR-0176), covering numpy's bundled runtime code:**
       numpy's Zlib code (a permissive licence, no copyleft); `libgfortran`, GPL-3.0-or-later WITH
       GCC-exception-3.1 (a runtime-library exception: independent code may use the GCC runtime without GPL
       obligations); `libquadmath`, LGPL-2.1-or-later (an unmodified, dynamically linked LGPL library shipped as its
       own shared object). Each of the three entries reads "accepted by owner 2026-10-09 (ADR-0187 decision 106)"
       with that reason, in the allow file and in `engines/modelscan/THIRD_PARTY.md`.
     - **Not put to the owner, still pending:** h5py's bundled HDF5 libraries (the HDF Group's BSD-style licence) and
       CPython (PSF-2.0); their entries still say "pending owner decision" (open question 15).
     - **garak reuses this decision** for the same numpy runtime code.

     Run on the cp312 wheels the lockfile pins: 15 allowed, 6 admitted by the allow file (3 accepted, 3 pending), 0
     denied. The image stays inadmissible while any entry is pending; the manifest lists it as unverified.
107. **One patch: modelscan 0.8.8 cannot scan anything from a settings file.** Measured: with any `--settings-file`,
     every scanner raises on `format_property.value` (a TOML file can only hold string keys, the in-code defaults hold
     `Property` objects), so an `os.system` pickle exits 3, nothing scanned, seven `MODEL_SCAN` errors (fail closed,
     but blind). G19 requires our own settings file, so the image patches ONE function
     (`engines/modelscan/patches/format-names-from-settings.py`): a format named by a string resolves to modelscan's
     own property of that value, and an unknown name raises (an error, so unknown). The patch refuses to apply unless it
     finds exactly the expected code, once, and refuses a second application; it is on the image label. Negative
     control: the real-engine suite run against stock 0.8.8 fails 4 of 5 (everything reads unknown); patched, 5 of 5.
108. **modelscan's NumPy scanner does not work on numpy 2.x: every `.npy` reads `unknown`.** It calls
     `np.lib.format._check_version`, which numpy 2.x removed (measured: a `MODEL_SCAN` error on an object array holding
     `os.system`). Fail closed, and pinned by a real-engine test that turns red the day it works. Options for the
     owner (open question 15): pin numpy 1.26 for the image, or have the runner strip the `.npy` header and hand the
     object payload over as a pickle (our code).
109. **The format is decided from the bytes, on both sides** (`detectArtifactFormat`, G19 2). In order: empty; pickle
     protocol 2–5 (`PROTO`), and PyTorch's legacy layout by its magic-number pickle; a zip classified from its central
     directory (zip64 included; a nested archive or an encrypted member makes it `zip_opaque`; a `data.pkl` member makes
     it `pytorch_zip`; Keras v3 and `.npz` layouts); HDF5 at any of its superblock offsets; NumPy; GGUF; a compression
     container; tar; then safetensors, which counts only when its header is UTF-8 JSON, every entry is exactly
     `{dtype, shape, data_offsets}` with a known byte-sized dtype and a byte length equal to its shape, and the offsets
     tile the data from 0 to the end with no gap, overlap or trailing byte (else `safetensors_invalid`, `unknown`).
     Anything else is `unrecognised`, handed to modelscan as a pickle (old protocols carry no signature) and never
     better than `unknown`. modelscan is handed the file as `artifact<ext>`, the extension of the real format; **the
     legacy PyTorch layout goes as `.pkl`**, because modelscan's PyTorch scanner reads only the first pickle of that
     layout and its pickle scanner reads every pickle in the stream (measured: `os.system` in the third pickle exits 0
     as `.pt`, 1 as `.pkl`). modelscan is never started for safetensors or an unsupported format (Keras v3 needs
     TensorFlow, which the image does not ship; GGUF, compressed, tar, empty): the format item decides, and the
     unsupported ones are declared planning-time exclusions in the manifest's reduced set. Red: legacy handed as `.pt`
     fails the legacy proof; dropping the tiling rule fails the safetensors proofs.
110. **The mapper (G19 3).** Only the `-o` report (bounded at 4 MiB before it is read) and the exit code; stdout is never
     parsed. Every `issues[]` entry is a finding whatever the exit code; any `errors[]` entry makes the scan `unknown`;
     an empty `scanned_files` is a run-time not-run (`engine_error`); exit 4, a missing, oversized or unparsable
     report, or a time-out fail the run and every reading is unknown; a report naming another file, or an exit code
     the report contradicts, fails the run (`report_inconsistent`) with its findings kept. No artifact text is copied:
     operator names and member paths are reduced to `[A-Za-z0-9_./-]` (else `?`), error descriptions are dropped,
     every reason is a fixed sentence; the raw report travels as its sha256 only. Red: dropping the findings of an
     inconsistent report fails the mapper test.
111. **Settings, argv and environment are ours.** `engines/modelscan/modelscan-settings.toml` is baked read-only
     (0444) and always passed with `--settings-file`; modelscan runs from a fresh empty directory on the scanner's
     tmpfs, with a fixed argv (`scan -p <artifact> -r json -o <out>/report.json --show-skipped -l ERROR
     --settings-file <ours>`) and an environment built from nothing (the venv's PATH, no user site, no bytecode
     writes). The settings keep modelscan's defaults and add the deny-list entries G19 measured slipping through
     (`importlib`, `ctypes`, `http.client`, `code`, `marshal`, `types`, `operator.methodcaller`, and the rest listed
     in the file); every additional class it names is modelscan's own. `settings.test.ts` parses the file and compares
     it with `MODELSCAN_SETTINGS`. Measured on the real engine: each of those seven is now a finding.
112. **The upload.** `POST /v1/model-artifacts?filename=&projectId=` takes `application/octet-stream` only (415
     `artifact_content_type`), streams it to a private temporary file while hashing and counting, and cuts it off past
     the org's `modelArtifactMaxMegabytes` (strict 512 MiB, 1–8192, in the strictness registry: raising it is a
     `settings_relax` step-up, audited) with 413 `artifact_too_large`, the connection closed, nothing kept, and a
     `model-artifact-upload-refused` audit; a declared length over the limit is refused before reading. The request is
     drained, never destroyed under the response. The format is decided from the bytes; `filename` is display only
     (no path, printable). The bytes go to the content-addressed store once (`sha256/<hex>`, a CHECK on the row):
     a directory (`REGULAIT_MODEL_ARTIFACT_DIR`, 0600 files written by rename) or an S3 bucket
     (`REGULAIT_MODEL_ARTIFACT_S3_BUCKET`, the SDK the gateway already ships; the bucket verifies our sha256). With
     neither, uploads are refused (503 `artifact_store_unavailable`). The row and its `model-artifact-uploaded` audit
     (sha256, size, format and its evidence, declared extension, stored new or not) commit together. The uploader, or
     an admin, lists and views an artifact with its scans. Red: removing the streaming bound fails the chunked-upload
     case.
113. **The runner's stream.** `GET /v1/engine-runner/artifacts/:artifactId` answers only the runner holding a LIVE
     lease (leased, lease and deadline not passed) on a run that targets the artifact: bytes with `content-length`
     and `x-regulait-artifact-sha256`, audited `engine-run-artifact-streamed`; anything else is 409
     `engine_artifact_not_leased`, audited `engine-run-artifact-refused`. The runner (`downloadArtifact`, a new module
     in the runner core so the runner client is unchanged; the token comes from the runner's own token store) writes
     exclusively to a 0600 file, never more bytes than the lease names, and refuses a short body or another sha256;
     the adapter then reports `failed` (`artifact_fetch_failed`) and modelscan is never started. Red: serving a run in
     any status fails the stream proofs; dropping the sha256 check fails the same-length tampered-body proof.
114. **One scan record per run, in the run's terminal transaction.** `endLockedRun` (every terminal path: result,
     cancel, time-out, not-run, an engine switched off) writes the `artifact_scans` row with the gateway-derived
     verdict and its findings, and a `model-artifact-scanned` audit, in the same transaction (a unique index makes it
     idempotent). The lease also re-checks an artifact run: the artifact still exists and the run-as person may still
     use it, else the run ends `not_run` (`artifact_gone`, `artifact_not_accessible`) before anything is leased.
115. **Only the uploader, or an admin, may scan an artifact** (403 `artifact_not_accessible` at creation, and at
     lease as above): it is hostile input, and its scans become evidence. Red: removing the check lets another user
     queue a scan of it.
116. **`engine_scan` model-card evidence.** `POST /v1/mrm/cards/:id/evidence` `{kind: "engine_scan",
     artifactScanId}` cites a scan (RESTRICT, like a cited eval run; 409 on a duplicate), audited with the scan's
     verdict and the artifact's sha256; the card view carries the scan, its chip and whether it is admissible.
117. **Red proofs, and the two that do not apply.** Through the real gateway and in the package: a renamed pickle,
     a legacy-layout `.pt` and an `importlib` pickle are `unsafe`; a truncated malicious pickle and a nested zip are
     `unknown`; none is ever clean; the real pinned modelscan (opt-in suite) agrees on all five. **Engine error →
     unknown:** exit 4, no report, a time-out. **Cancel:** this engine has no key to revoke (no model access; the
     lease mints none, `virtualKeyId` stays null), so cancel ends the run at once and the runner's artifact fetch, its
     heartbeat (`cancel: true`) and its result (409) are all refused; the scan reads `unknown`. **Egress denied →
     not_run and budget spent → 401 do not apply**: the scanner has no network at all (its self-test proves it) and the
     engine makes no model call, so there is no egress to deny and no budget to spend.
118. **What was not built or run here.** No Docker daemon in this environment: the image was not built, so its
     digest, its signature, the Trivy OS-layer scan and the in-image self-test are not done, and the manifest digest
     stays null (the engine cannot be enabled). The Python closure was checked by downloading the exact cp312 wheels
     with `--require-hashes` (all nine verified) and running the licence gate on them; the engine was run from a
     Python 3.11 venv of the same pinned versions for that interpreter (numpy 2.4.6 there, 2.5.3 in the image), with
     the patch applied. **Correction to the brief's assumption:** CI's `docker-build` job builds only the gateway
     image (`docker build .`); neither engine image is built in CI today (open question 16).
119. **Open-source check (ADR-0176).** modelscan is used, not rewritten. Our own code is the governance part: the
     format decision (`file-type`, MIT, does not know pickle protocols, the legacy PyTorch magic pickle, a zip's
     PyTorch or Keras layout, or the safetensors tiling rule), the verdict, the mapper and the exchange. The licence
     gate reads `dist-info` itself because `pip-licenses` (MIT) would add a package to the image and does not see a
     wheel's bundled native libraries. `smol-toml` (BSD-3-Clause, 1.9.0, a dev dependency only) parses the settings in
     the test. The stores use node:fs and the AWS SDK the gateway already ships.

**Deferred, with the owner of each:** ~~artifact upload, artifact streaming to runners and `engine_scan` model-card
evidence~~ (built in B5-M, decisions 104-119); per-engine images, SBOMs, signatures, taxonomy rows, set
classes, the `--with-engines` bundle and the Kubernetes NetworkPolicy manifest (B5-P/M/G); the Engines page and run
views (X26–X28; the runner-revocation route is exempt from the affordance census until X26's button). Residuals:
`engine_run_items` and engine runs follow no retention cascade yet (only the raw report expires); a result's
`dispatchAuditIds` are stored as reported, not cross-checked against the run's key; enabling does not check that a
compat surface is on (a run then fails at its first call); concurrency is per engine, not per runner.

### Implementation decision (engine images in CI, 2026-10-09, branch `ci-engine-images`)

Decisions 104–119 belong to B5-M (PR #212); this slice starts at 120.

120. **Every engine image is built, scanned and signed in `security.yml`, found from `engines/*/Dockerfile`** (closes
     open question 16). Three jobs join `.github/workflows/security.yml`:
     - **`engines`** lists every `engines/*/Dockerfile` as a matrix, with no hand-kept list, so modelscan is picked up
       when PR #212 merges and any later engine is picked up by the PR that adds it. A directory name outside
       `[a-z0-9-]` fails the job, because the name becomes an image tag and an artifact name.
     - **`engine-image`** (one leg per engine, `fail-fast: false`) runs on the gateway `image` job's triggers (every PR,
       push to main, the weekly schedule, a manual run), with no self-skip. It uses the same build: plain
       `docker build` (BuildKit through the runner's Docker; neither job uses a buildx setup action, and none was
       added), with `-f engines/<name>/Dockerfile` from the repository root. Its gates match the gateway's: Trivy
       pinned by version, SHA-256 and Sigstore bundle; a failure on any fixable HIGH or CRITICAL not in
       the engine's own allow-list, `security/image-allowlist.engine-<name>.json` (an empty list when the file is
       absent; the gateway keeps `security/image-allowlist.json`, because the gate fails on stale entries and one
       shared file would let an exception for one image fail every other image); `--expect-classes
       os-pkgs,lang-pkgs`; and a CycloneDX image SBOM. Engine directory names must follow Docker's repository
       component grammar, `[a-z0-9]+(-[a-z0-9]+)*`, or the discovery job fails. The
       gateway's runtime-contents gate is not applied, because it checks the gateway's `/app` tree. Each engine
       Dockerfile removes its own package managers. **Licence:** an engine's `licence-gate.mjs` judges what the build
       installs, so it runs inside `docker build`, and a denied licence fails the build. The job fails if a
       `licence-gate.mjs` exists but the Dockerfile never calls it. It also re-runs an npm-lockfile gate from the
       tree, and warns if an engine has no gate. A Trivy licence report of the image, including the OS layer, is kept
       as evidence only. It is not a gate, because admitting licences outside the ADR-0176 list is the owner's
       decision (open questions 6 and 15). **Digest:** the image ID (what `docker load` reproduces) and the manifest
       digest from the job's throwaway `registry:3` service are written to the job summary and to `digest.json` in the
       `engine-<name>-scan` artifact (30 days). That artifact also holds the SBOM, the Trivy reports and the build log,
       which contains the licence gate's output. On every run that does not sign, the same red proof as the gateway
       runs: `security-cosign-verify.sh <ref> unsigned` must refuse the image.
     - **`engine-sign`** uses the gateway `sign` job's condition and steps unchanged. It runs on a push to main only,
       after `sast`, `secrets`, `dependencies` and `engine-image` have passed, so it is skipped on PRs, schedules and
       manual runs. It loads the exact scanned image and checks its ID against that engine's digest record (a matrix
       job has one set of outputs for all its legs). It then pushes the image to its own throwaway registry, signs it
       with cosign keyless under `security.yml@refs/heads/main`, verifies it with `security-cosign-verify.sh … signed`,
       and records the signed digest in the summary and the `engine-<name>-signed` artifact (90 days).

     **Why `security.yml` and not `ci.yml`'s `docker-build`:** the verify script pins the signing identity to
     `security.yml@refs/heads/main`, so the gateway and engine images share one identity and one verify command.
     **Nothing is published:** no registry is added and none is pushed to except the in-job throwaway ones, and
     `publish-image.yml` is unchanged. **Open-source check (ADR-0176):** no new action or tool. The job reuses the
     pinned `actions/checkout`, `upload-artifact` and `download-artifact` SHAs, the pinned `registry:3` digest, and the
     pinned Trivy and cosign binaries. The PR-diff warning now also covers `engines/*/Dockerfile`,
     `engines/*/licence-gate.mjs` and `engines/*/licence-allow.json`. actionlint 1.7.7 validated the workflow locally
     and is not part of CI. **Not verified here:** this environment has no Docker daemon, so neither image was built,
     scanned or signed, and the first CI run is the first build of each. The image allow-list is empty, so any fixable
     HIGH or CRITICAL in an engine image fails that engine's leg. The gateway's `sign` job does not depend on the
     engine jobs. **Still open:** the shipped manifest's digest stays null. A digest from a throwaway registry names no
     image anyone can pull, so recording one waits for engine images to be published (a `publish-image.yml` change)
     and for question 8's choice between the image ID and the manifest digest for `docker load` installs.

**Review round 1 (PR #212, Codex, 2026-10-09; 6 findings, each red first; Codex's security review was clean).**
Tests: `exchange.test.ts` [121] and the sweep of [124]; `modelscan.test.ts` [122] [123];
`packages/engine-runner/src/artifact.test.ts` [124]; `apps/gateway/src/model-artifacts.test.ts` [126];
`zz-b5-modelscan.test.ts` [125]. (Decision 120 belongs to #213.) **Migration 0175 was edited in place** (unmerged; [125]
adds a unique index): a dev database that applied 0175 from `b5-modelscan` before this round must be rebuilt.

121. **The exchange is restart-safe** [4234946104]. A runner that crashed after staging (`<runId>.staging`) or after
     publishing (`<runId>`) left job directories nothing would ever remove, so the jobs tmpfs filled. Every executor
     now has `reconcile(keepRunId)`: it removes every published or staging job whose run is not `keepRunId`. The runner
     calls it at start with nothing to keep (it holds no run), and the adapter calls it before each scan, keeping the
     run it holds. The runner cannot write the result volume (read-only there), so results are reconciled by the
     scanner, which already drops every result whose job is gone; the scanner takes only directories named exactly by
     a UUID, never `<uuid>.staging`. Red: with `reconcile` a no-op, a crash after staging and after publishing leaves
     both directories behind.
122. **A report that contradicts itself decides nothing** [4234946100]. The mapper trusted `summary` beside the lists.
     `modelscanSummaryProblem` now checks `total_issues` against `issues[]`, each per-severity count (an unknown
     severity counted is itself a contradiction), `total_scanned` against `scanned_files` and `total_skipped` against
     `skipped_files` (always listed: the runner passes `--show-skipped`). Any disagreement fails the run
     `report_inconsistent` (every reading unknown), with its findings kept. Red: `total_issues: 1`, no issue, exit 0
     read as a passing scan without the check. Measured: the pinned modelscan's real reports satisfy every check (the
     opt-in real-engine suite passes).
123. **Anything not proven safetensors is executable** [4234946089]. A file with a safetensors prefix whose header
     does not verify was `executable: false`, so it carried no `executable_format` finding. The rule is now general and
     pinned by a test: only `safetensors` (magic and a verified header) is non-executable; `safetensors_invalid`, `gguf`
     and `empty` became executable too. Ceilings are unchanged (`unknown`, `not_run`, `not_run`), so no verdict
     improves; each such scan now also lists the finding. Red: a corrupt safetensors header lacked the finding.
124. **An already-aborted signal starts nothing** [4234946096]. `downloadArtifact` wired the abort listener after the
     signal had fired, so a cancelled run still fetched. It now refuses an aborted signal before opening a file or
     making a request (`artifact_aborted`). **Sweep** (every abort wiring in this PR): the exchange no longer publishes
     a job for an aborted signal, and `runModelscan` no longer spawns modelscan for one; `runProcessGroup` (runner
     core) already kills at once on an aborted signal, and the scanner's per-job controller is created fresh. Red: a
     pre-aborted download fetched once; the exchange published the job and waited for its 5-second cancel grace.
125. **Scan evidence is unique by the database** [4234946093]. Attaching a scan to a card checked for a duplicate by
     a read before the write, so two concurrent attaches both succeeded. Migration 0175 (edited in place) adds
     `model_card_evidence_card_scan_unique` on `(card_id, artifact_scan_id)` where a scan is cited; the read stays as a
     fast path and the unique violation maps to the promised 409 `evidence_already_attached`. **Sweep** (read-before-
     write uniqueness in this PR): one scan per run is already the unique index `artifact_scans_engine_run_unique` with
     `ON CONFLICT DO NOTHING`; the content-addressed store's "exists, else write" is idempotent (the same bytes under
     the same key, written by rename); model artifacts carry no uniqueness by design (one row per upload). The eval-run
     citation's read-before-write predates this PR and is not changed here. Red: without the index two concurrent
     attaches both answered 201.
126. **The filesystem store is durable before the row commits** [4234946106]. It fsynced the temp file but not the
     directory after the rename, nor the directories `mkdir -p` created. It now fsyncs the parent of every directory it
     newly created, then the directory holding the object after the rename, all before `putFile` returns (so before the
     upload's transaction). The directory fsync is the runner core's `fsyncDir` (`packages/engine-runner/src/
     durable.ts`, now exported), not a second copy; `@regulait/engine-runner` becomes a gateway runtime dependency,
     bringing `write-file-atomic` 8.0.0 (ISC, already admitted) into the image (`apps/gateway/THIRD_PARTY.md`).
     `write-file-atomic` itself does not fit: it writes from memory, and an artifact is streamed (up to 8 GiB). Red:
     without the post-rename fsync the store's directory was never synced. **Sweep** (summaries trusted over lists):
     the artifact verdict reads the normalised items, never a summary, and the run's aggregates are recomputed by the
     shared normaliser; the report summary was the only instance.

**Review round 2 (PR #212's five deferred Codex findings, 2026-10-09, branch `b5-m-followup`; each red first).**
**Migration 0176** (`0176_model_artifact_quotas_retention`, hand-written, journal `when` 1785111000000; 0175 is merged
and not edited). Tests: `apps/gateway/src/zz-b5-modelscan-storage.test.ts` (12, the real gateway) [127] [128];
`model-artifacts.test.ts` (+2) [127] [130]; `packages/engine-modelscan/src/image.test.ts` [129];
`modelscan.test.ts` (+1) [131]. The mutation that turned each proof red is named with its decision.

127. **Model-artifact storage is bounded: quotas, deletion and retention, strict by default** [4235322397]. Any
     user could upload without limit and nothing was ever removed.
     - **Quotas.** Five new org settings, each in the strictness registry (raising one is a `settings_relax`
       step-up, audited; lowering needs nothing): `modelArtifactUploaderQuotaMegabytes` **2048** (1–1048576),
       `modelArtifactUploaderQuotaCount` **20** (1–100000), `modelArtifactOrgQuotaMegabytes` **20480**
       (1–10485760), `modelArtifactOrgQuotaCount` **200** (1–1000000). A quota counts every artifact row at its
       own size, so the same bytes uploaded twice count twice (the per-row view the uploader sees; the store
       may hold one object). "Org" is the deployment: `org_settings` is one row. An upload past a count quota is
       refused **409**, past a byte quota **413**, both `artifact_quota_exceeded` with `{scope, measure, setting,
       limit, used}` and a `model-artifact-upload-refused` audit; nothing of it is kept.
     - **Decided under one lock.** Every quota decision, every object write a row will name and every object
       delete take one transaction-scoped advisory lock (`regulait:model-artifact-storage`). The upload reads
       what is stored and inserts its row inside that transaction, so concurrent uploads cannot both fit; an
       unlocked fast check refuses early before anything is written to the store. Red: with the lock a no-op
       (and the decision widened by a test seam), six concurrent uploads under a quota of one all answered 201.
       Concurrent uploads serialise only for the short decision, not for the bytes: the object is written
       before the lock and re-checked under it.
     - **Write-ahead, so an object is never left unnamed.** Before an upload writes a NEW object it queues that
       key in `model_artifact_object_deletions` with `not_before` six hours ahead; the upload's locked
       transaction removes the entry when its row lands (or makes it due at once when the quota refuses). A
       crash between the write and the row therefore leaves a queued delete, not an orphan. If a delete removed
       the object between the upload's write and its lock, the upload writes it again under the lock.
     - **DELETE `/v1/model-artifacts/:artifactId`.** The uploader or an admin (404 `unknown_artifact` for anyone
       else), with a `settings_relax` step-up bound to `{modelArtifactId, values:{deleted:true}}` (an API key can
       never step up, so it is refused 403). **409 `artifact_in_use`** `{citedScans, unfinishedRuns}` while a scan
       of it is cited as model-card evidence or a run on it is not in a terminal status, audited
       `model-artifact-delete-refused`; checked before the step-up is asked for (so no grant is spent) and again on
       the locked row. Otherwise the row and its uncited scans go in one transaction with a `model-artifact-deleted`
       audit (sha256, size, format, the scan ids); finished runs keep their history (`target_artifact_id` set
       null). Red: without the in-use check the cited and the queued-run artifacts went to the step-up instead of
       409.
     - **The object goes only after the row is gone and committed.** The delete's transaction queues the key
       only when no other row names it (content addressing: `object: "shared"` when one does). After it
       commits, each queued key is deleted in its own transaction under the lock, re-checking that no row names
       it; the queue entry goes with the object. A failed delete keeps the entry (`attempts` + 1,
       `last_error_code`, retried after 5 minutes per attempt, at most a day) with a
       `model-artifact-object-delete-failed` audit; it is never half-done. Success is audited
       `model-artifact-object-deleted`. Red: re-throwing the store error answered 500 with the row gone and no
       record; skipping the "still named" re-check deleted an object a row named. The test store records, from
       a second connection, that no row was visible at each delete.
     - **Retention.** The scheduler job `model-artifact-retention-sweep` (hourly, ADR-0187) deletes artifacts older
       than `modelArtifactRetentionDays` (**30**, 1–3650, larger relaxes it) that nothing keeps (the same two
       references), with their uncited scans, audited `model-artifact-expired`; then it drains every due queued
       delete, retrying failures. The setting is read on every run, so lowering it applies to what is stored.
       Red: with the cutoff removed, a recent artifact was deleted.
     - **`ArtifactStore.delete`** for both stores: the filesystem store removes the file (`rm --force`, so a retry
       is idempotent) and fsyncs its directory; the S3 store sends `DeleteObjectCommand` (S3 answers success for
       a missing key). Both refuse any key that is not `sha256/<hex>`.
     - **Not built:** the button. No Model artifacts page exists yet (X28, reassigned to Claude by the owner on 10-10); the route is a TEMPORARY
       `DELIBERATELY_API_ONLY` entry in `scripts/preflight-ui-affordances.mjs` (M-053), and deleting it is part
       of X28's acceptance. The mock fixtures (`apps/web/e2e/engines-fixtures.ts`) answer the new refusals.
     - **Open-source check (ADR-0176):** quotas, references and retention are governance semantics, our own
       code; the lock is Postgres's advisory lock; the S3 delete is the AWS SDK the gateway already ships. No new
       dependency.
128. **`clean` with no format is refused by the database** [4235322386]. 0175's CHECK `verdict <> 'clean' OR
     format = 'safetensors'` is NULL, not false, when `format` is NULL, so a clean scan with no format passed. 0176
     replaces it with `verdict <> 'clean' OR (format IS NOT NULL AND format = 'safetensors')`, after turning any
     such row (none can exist on a first load) into `unknown`, never better. `format` stays nullable for the
     other verdicts. Red: with 0175's CHECK put back on the test database, a clean scan with a NULL format was
     accepted.
129. **The modelscan runtime proves at build time that Node runs on its base** [4235322394]. The Node binary is
     copied from the node image into `python:3.12-slim-trixie`, which links `libstdc++.so.6` and `libgcc_s.so.1`.
     **Measured from CI:** the `engine-image` leg for modelscan passed on main (Security run 38004560910, PR
     #212's merge), and its build ran `node licence-gate.mjs` in the CLOSURE stage, whose base is the same digest
     as the runtime stage, so that base does carry both libraries; nothing checked the runtime stage itself.
     Chosen: keep them as the base's own Debian packages (so Trivy scans them), and fail the build in the
     runtime stage unless `dpkg-query` finds `libstdc++6` and `libgcc-s1`, `ldd` resolves every library node
     links, and `node --version` runs. Rejected: copying node's library closure from the node image (files no
     package manager owns, which the image scan would not see). **Correction to the brief:** the gateway image
     installs nothing from a pinned Debian snapshot; no Dockerfile here pins one. Red (static): removing the
     `node --version` line fails `image.test.ts`. **Not run here:** no Docker daemon; CI's engine-image job is
     the proof.
130. **A failed filesystem-store write leaves nothing behind** [4235322391]. The temp file was left in the
     persistent directory when the copy, the fsync or the rename failed. `putFile` now closes the handle and
     removes the temp file in a `finally` that cannot itself throw; only a completed rename keeps it. Red:
     with the removal disabled, an injected failure at each of the three steps left a `.tmp` file.
131. **The HDF5 probe covers every superblock offset up to the file size** [4235322383]. The format probe
     stopped at offset 2048, so an HDF5 file behind a larger user block read `unrecognised` (still never better
     than `unknown`, but scanned as a pickle and not as HDF5). The HDF5 library looks for the superblock at 0 and
     at every power of two from 512, so `hdf5SuperblockOffsets(size)` probes exactly those while the 8-byte
     signature fits in the file. **The bound is the file size**, not a fixed 1 MiB: it covers every offset the
     library would accept, and costs at most 24 eight-byte reads at the 8 GiB upload ceiling. Red: a header at
     4096 read `unrecognised` with the old bound.
132. **A safetensors header that repeats a key is never verified** (Codex review B5X-01, MEDIUM). The verifier read
     the header with `JSON.parse`, which silently keeps the last of two equal keys, so a duplicate tensor name whose
     first entry had an invalid dtype (`PICKLE`), or a tensor with `dtype` given twice (`U8` then `I8`), read as
     verified `safetensors` (ceiling `clean`). **Measured against the reference parser** (safetensors 0.7.0, in a
     scratch venv): it refuses the invalid-dtype duplicate, a repeated `dtype`, `shape` or `data_offsets`, and a
     repeated `__metadata__`; it ACCEPTS a tensor name repeated with two valid entries and a key repeated inside
     `__metadata__` (the last wins), and it accepts names that are escaped but distinct (`"w"` and `"wx"`,
     `"a\"b"` and `"a\\b"`). **Chosen, stricter than the reference:** any key repeated in one object, at any level
     (tensor names, a tensor's fields, `__metadata__` and its keys), makes the file `safetensors_invalid` (never
     better than `unknown`). Keys are compared after unescaping, so `"w"` and `"w"` are one key (the
     reference refuses that file too); escaped-but-distinct names stay accepted. **Open-source check (ADR-0176):**
     `@humanwhocodes/momoa` 3.3.13 (Apache-2.0, released 2026-09-02, no dependencies, no install script, pure
     JavaScript, so it works air-gapped) parses JSON to a syntax tree that keeps every member;
     `jsonHasDuplicateKey` walks that tree without recursion. It is a new exact-pinned dependency of
     `@regulait/shared`, with its row in `packages/shared/THIRD_PARTY.md`. `JSON.parse` still produces the values
     the existing checks read, and the evidence string is a fixed sentence (no artifact text). Red: with the
     duplicate refusal disabled, six of the seven duplicate shapes read as verified `safetensors` (the escaped
     duplicate already failed the tiling rule).

### Implementation decisions (B5-P2 promptfoo runner/worker split and upgrade, 2026-10-10, branch `b5-p2-promptfoo-split`)

Closes open question 13 for promptfoo (decision 79's gate stays for every other build). No migration. Code:
`packages/engine-promptfoo/src/{job,exchange,worker-selftest,worker-main,version}.ts` (new), `adapter.ts`, `config.ts`,
`main.ts`; the manifest entry; compose `engine-promptfoo` and `engine-promptfoo-worker`; `engines/promptfoo` (Dockerfile,
lockfile, THIRD_PARTY.md). Tests: `packages/engine-promptfoo/src/split.test.ts` (11), `image.test.ts` (+1),
`promptfoo-real.test.ts` (+1, opt-in), `zz-b5-compose.test.ts` (+1), `zz-b5-promptfoo.test.ts` [79] (rewritten, +1). Each
guard was shown red by breaking it (recorded with each decision). `packages/engine-runner` is unchanged.

170. **promptfoo runs in its own container; the runner never runs it.** One image, two compose services, the modelscan
     pattern (decision 104) adapted to an engine that calls models. The **runner** (`engine-promptfoo`, the hardened
     template, default CMD `dist/main.js`) keeps the runner token on its state volume, leases, heartbeats and posts
     results; it mounts the job volume read-write and the result volume read-only. The **worker**
     (`engine-promptfoo-worker`, `dist/worker-main.js`) runs promptfoo: on `engines`, read-only root, uid 10001,
     `cap_drop: [ALL]`, `no-new-privileges`, the template's limits, its own `/work` tmpfs; **no state volume, no
     enrolment or runner token, no gateway URL of the runner's, no `pid`/`ipc`/`network_mode`/`volumes_from` sharing**
     (so its own PID namespace: it cannot read the runner's memory, environment or descriptors through `/proc` or
     ptrace); the job volume read-only and the result volume (`/out`) its one shared writable place. It does not merge
     `x-engine-runner`, because the template carries the enrolment token. Both exchange volumes are tmpfs-backed (a job
     holds the run key, which never reaches a disk). Red: the compose test fails with the state volume added to the
     worker.
171. **The worker's credential is the run-scoped virtual key, the narrowest one that works.** promptfoo must call the
     target, the generator and the grader, so whatever runs it can make model calls; the run key bounds exactly that
     (the compat model routes only, one project, the run's budget, until its deadline, revoked at cancel, timeout or end;
     decisions 4 and 5). The runner token can lease runs (each minting a key), post results and refresh the self-test;
     none of that is in the worker's reach. **Rejected:** (A) a forwarding proxy in the runner, with the worker on
     `network_mode: none` and no key: the worker could still make every model call the key allows through the proxy
     (no capability removed), while the credential-holding runner would gain a listening port parsing requests from the
     hostile process; (B) the worker on its own network with only the gateway: the gateway's routes are one listener,
     so route-level authorisation (the key's purpose) is the boundary either way, and the runner has no port to reach on
     `engines`; it would also change the gateway service, which other slices share.
172. **The exchange** (`exchange.ts`; the job, `job.ts`). The runner writes `jobs/<runId>.staging/job.json` — exactly
     `{runId, baseUrl, apiKey, config, deadlineAt}`, the run key and nothing else secret; the adapter is never given
     the runner token — and renames it into place. The worker parses it strictly (an extra field is `job_invalid`),
     re-builds the child environment for its own `/work/<runId>` from nothing (`promptfooEnvFor`) and re-runs
     `assertGatewayOnly` before promptfoo starts; a refusal is answered (`done.json`, a fixed-vocabulary code) and maps
     to `not_run` with every planned pair. It runs generate then eval under the run's deadline, writes
     `results/<runId>/results.json` and, last and atomically, `done.json` with the results' sha256. A cancel (the
     `cancel` file, or the job disappearing) kills promptfoo's process group; the runner gives up 15 s after the
     deadline (never clean). The runner reads the results only if their sha256 is the one `done.json` names (else
     `failed`, `results_inconsistent`), with the 64 MiB bound of decision 63 unchanged; it reconciles stale jobs at start
     and before each run, and the worker drops results whose job is gone. Red: skipping the worker's invariant ran
     promptfoo on an off-gateway job; a `passthrough` job schema ran a job carrying an extra field; dropping the sha256
     check accepted a swapped results file.
173. **The worker proves the isolation at run time** (`worker-selftest.ts`). Hourly, on its own timer (a long run never
     lets it go stale, which would fail the runner's refresh and switch the engine off, decision 93), the worker writes
     `.worker-selftest.json` to the result volume: the same egress probe as the runner's, run inside the worker, and
     what of the runner's credential it can reach — environment variables named `REGULAIT_ENGINE_ENROLLMENT_TOKEN` or
     holding an `rge_`/`rgee_` value, any entry in the runner state directory (the image ships `/state` empty; unreadable
     counts as reachable), and any process in its `/proc` running the runner's `dist/main.js`. The runner reports it as
     the manifest's new promptfoo usage-data entry `REGULAIT_PROMPTFOO_WORKER_ISOLATED`, true only when the report is
     fresh (2 h), names the pinned version, reached nothing and found nothing; a missing, stale or failing report fails
     the self-test, so the engine cannot be enabled. Red: ignoring the state entries, or never flagging a visible runner
     process, passed a worker that shared the runner's volume or PID namespace; reporting the switch true regardless
     passed a self-test with no worker report.
174. **`credentialIsolation` is true for promptfoo** (the manifest), so decision 79's acceptance no longer applies to it:
     enabling needs the step-up for enabling alone and writes no `engine-credential-isolation-risk-accepted` audit. The
     claim rests on the compose layout (decision 170, pinned by the compose test), on the job and adapter carrying no
     runner credential (pinned by `split.test.ts`, which also checks promptfoo's environment against a runner token and
     an enrolment token planted beside it), and on the worker's run-time proof (decision 173), which is a required
     usage-data entry. The gate itself is unchanged and still proven on a build without isolation (`zz-b5-promptfoo`
     [79], through a second app with that manifest; the test restores the module-wide engine runtime that `buildApp`
     installs). modelscan and garak keep `false` (open question 18 unchanged). **Not verified here:** the image was not
     built and neither container was run (this environment's disk could not hold the build; see the report), so the
     layout's run-time behaviour, the worker's self-test inside a real container and the in-image egress test are first
     exercised by CI's image build (decision 120) and a deployment; the manifest digest stays null, so the engine still
     cannot be enabled. Red: with the shipped flag false, the "isolating build enables with the step-up alone" proof
     fails.
175. **No change to the runner core.** The split lives in the promptfoo shim. `promptfooAdapter` keeps its options and
     gains `executor` (default: `LocalPromptfooExecutor`, the in-process path the existing tests and the gateway's
     stand-in use); the image's runner always passes the exchange (a test reads `main.ts` and refuses the local path
     there). The exchange is a candidate to move into `packages/engine-runner` once a second model-calling engine
     (garak) needs it.
176. **promptfoo 0.123.1 → 0.124.1** (released 2026-10-08, MIT, Node ≥ 22.22.0 as before; manifest generation 2,
     decision 95). Re-checked on the published package, not assumed: the telemetry patch still finds exactly four
     copies and the disabled path is the same code (measured with the real engine: unpatched, every run connects to
     the vendor's event collector, blocked; patched, nothing); the extracted plugin and strategy lists are identical
     (only the chunk name and hash change; `promptfoo-upstream.ts` regenerated, the drift test passes); the usage-data
     switches are all still read (`PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS` moved into one helper that still withholds
     `process.env` from templates); `ResultFailureReason` is unchanged. The vendored OWASP file is byte-identical
     (sha256 `9c78fc85…`) at tag `0.124.1` = commit `421e7959642c5d4cc1c983259a268de1c6f847b9` (this release publishes
     no `gitHead`), so only its provenance moved. The real-engine suite (opt-in) passes on the patched 0.124.1, including
     a new run through the exchange. The mapper fixtures stay the 0.123.1 captures (the real 0.124.1 runs agree).
177. **npm advisories: what the upgrade does and does not clear.** `npm audit --omit=dev` on 0.123.1 reported 6 high
     and 2 moderate and offered "promptfoo 0.116.7" — a downgrade (to a release before these dependencies), not a fix,
     so it was not taken. On 0.124.1 the 2 moderate are gone (smol-toml left the closure; Dependabot PR #209 becomes
     redundant), and 6 high remain: braces (≤ 3.0.3, its latest release) and node-forge (≤ 1.4.0, its latest release),
     neither with a patched release, reached only through optional packages (chokidar 3 as nunjucks' optional peer, and
     jks-js). The image installs with `npm ci --omit=optional`, so none of them ships: `npm audit --omit=optional`
     reports 0, as it did at 0.123.1. A new `image.test.ts` case fails if any of them stops being optional. promptfoo
     0.124.1 itself requires `simple-git ^4.0.2`, so that override is dropped; `basic-ftp` 6.2.2 stays (without it 5.3.1
     resolves). The licence gate's result is unchanged (11 pending, open question 6).

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
6. **promptfoo's transitive licences outside the ADR-0176 list (B5-P).** 11 npm packages in the image carry Artistic-2.0
   (5), BlueOak-1.0.0 (5) or Python-2.0 (1): permissive, not copyleft, not on the list. The image is not admissible
   until the owner admits these licences (or they are replaced); the build does not fail on them, and the manifest
   lists the question as unverified. The image's OS layer has not been licence-scanned (Trivy, at the first CI build).
7. **promptfoo facts G19 still owes (B5-P, fail closed meanwhile):** the maintainer count (5 npm publishers is not a
   maintainer count; the manifest keeps null); the `pliny` source's licence (taken from this ADR as AGPL, not re-read;
   excluded either way); the base image's Node version (promptfoo needs ≥ 22.22.0; the registry rate-limited the
   check).
8. **promptfoo image build, digest, signature and in-image self-test (B5-P).** Pending a Docker-capable build: until
   then the manifest digest is null and the engine cannot be enabled. Also open: which digest the manifest pins for an
   air-gapped install loaded with `docker load` (a registry manifest digest needs a push; the image ID does not).
   *2026-10-09, decision 120:* CI now builds, scans and (on main) signs the image and records both identities. The
   manifest digest stays null until an engine image is published, and the digest choice above is still open.
9. **Agentic-named promptfoo plugins are unmapped (decision 40).** If the owner wants them to count toward the
   agentic classes, the run must reach the agent through a path where tool calls are governed and visible (ADR-0068
   adjudication), which a compat-route run is not.
10. **promptfoo on arm64 (decision 51).** The image is amd64 only because libsql's native binding is pinned per
    architecture. An arm64 image needs the matching binding chosen per build platform (and its licence and advisories
    checked); not attempted in B5-P.
11. **Engine image admission at deploy time (decision 55).** The runner's self-reported digest only checks consistency
    with its deployment. Proof needs the deployer to verify the image signature (cosign, against our signing identity)
    before the container starts, and the engine images are not signed yet (they are not built). Until then an enabled
    engine rests on the operator deploying the digest the manifest names. *2026-10-09, decision 120:* engine
    images are now signed on every push to main, but only in CI's throwaway registry; deploy-time verification
    still needs a published, signed image.
12. ~~A `no_runnable_plugin` not-run reason~~ — **decided 2026-10-09 (coordinator), see decision 66: no migration.**
13. **B5-P2: isolate the runner credential from the engine process (decision 79), the next slice.** Split each
    engine into two containers: a runner container that holds the token volume and talks to the gateway, and an
    engine worker (same image, its own entrypoint and user, no state volume) that reaches only the gateway's compat
    routes; jobs and results pass through a shared work volume (job in, result out, cancellation, deadlines). The
    container posture stays as it is (non-root, `cap_drop: [ALL]`, `no-new-privileges`, read-only root). When it ships,
    the manifest's `credentialIsolation` becomes true and the enable gate of decision 79 no longer applies. Chosen by
    the coordinator 2026-10-09, pending the owner's confirmation. *2026-10-10, decisions 170–177:* **built for
    promptfoo** (runner and worker containers, the worker holding only the run's virtual key and proving at run time
    that no runner credential is in its reach); its `credentialIsolation` is now true. Still open: the image has not
    been built or run in two containers (CI's build is the first), modelscan's flag (question 18), and garak.
14. ~~What a clean model-artifact scan means (B5-M, decision 105)~~ — **decided by the owner 2026-10-09: safe formats
    only**, as built (only a verified safetensors file can be `clean`; an executable format is at best
    `no_known_unsafe`, with an `executable_format` finding; the chip never says "safe"). Rejected: extending the
    deny-list alone, and our own allow-list of pickle globals.
15. **The modelscan image's licences and numpy (B5-M, decisions 106 and 108).** numpy's bundled runtime code (Zlib,
    `libgfortran`, `libquadmath`) was **accepted by the owner 2026-10-09** (decision 106). **Still open:** (a) h5py's
    bundled HDF5 libraries (LicenseRef-HDF5) and CPython's PSF-2.0, not yet put to the owner (their allow-file entries
    say "pending owner decision", so the image is not admissible yet); (b) modelscan 0.8.8's NumPy scanner fails on
    numpy 2.x, so every `.npy` reads `unknown` (fail safe, kept): pin numpy 1.26 for the image, or strip the header in
    the runner and scan the object payload as a pickle.
16. ~~Building the engine images in CI (B5-P and B5-M)~~ — **closed 2026-10-09 by decision 120.** `security.yml`
    builds every `engines/*/Dockerfile`, scans it and records its digests on every run, and signs it on each push to
    main.
17. **TensorFlow for `.keras` and SavedModel files (B5-M, decision 109).** Not installed: those formats are `not_run`.
    Adding it is a separate decision (a large native parser of hostile protobuf; its saved-metadata import path is
    unverified for the TensorFlow the extra resolves to).
18. **`credentialIsolation` for the modelscan two-container build (B5-M, decision 104).** The scanner, which parses
    the artifact, runs in its own container with no network and no runner token, so this build keeps the credential
    out of the engine process. The manifest keeps `credentialIsolation: false` until the image is built and that
    layout verified; whether it then becomes true (and decision 79's acceptance stops applying to modelscan) is open.

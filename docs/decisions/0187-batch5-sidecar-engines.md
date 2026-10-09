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

**Deferred, with the owner of each:** artifact upload, artifact streaming to runners and `engine_scan` model-card
evidence (B5-M; both runner and upload routes answer 501); per-engine images, SBOMs, signatures, taxonomy rows, set
classes, the `--with-engines` bundle and the Kubernetes NetworkPolicy manifest (B5-P/M/G); the Engines page and run
views (X26–X28; the runner-revocation route is exempt from the affordance census until X26's button). Residuals:
`engine_run_items` and engine runs follow no retention cascade yet (only the raw report expires); a result's
`dispatchAuditIds` are stored as reported, not cross-checked against the run's key; enabling does not check that a
compat surface is on (a run then fails at its first call); concurrency is per engine, not per runner.

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
9. **Agentic-named promptfoo plugins are unmapped (decision 40).** If the owner wants them to count toward the
   agentic classes, the run must reach the agent through a path where tool calls are governed and visible (ADR-0068
   adjudication), which a compat-route run is not.
10. **promptfoo on arm64 (decision 51).** The image is amd64 only because libsql's native binding is pinned per
    architecture. An arm64 image needs the matching binding chosen per build platform (and its licence and advisories
    checked); not attempted in B5-P.
11. **Engine image admission at deploy time (decision 55).** The runner's self-reported digest only checks consistency
    with its deployment. Proof needs the deployer to verify the image signature (cosign, against our signing identity)
    before the container starts, and the engine images are not signed yet (they are not built). Until then an enabled
    engine rests on the operator deploying the digest the manifest names.
12. ~~A `no_runnable_plugin` not-run reason~~ — **decided 2026-10-09 (coordinator), see decision 66: no migration.**

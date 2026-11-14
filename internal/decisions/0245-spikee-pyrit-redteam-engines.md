# ADR-0245: Spikee and PyRIT as sidecar red-team engines

- **Status**: Accepted (Spikee built; PyRIT designed, its build deferred to a follow-up slice: see "As built")
- **Date**: 2026-11-07
- **Index**: Spikee and PyRIT as sidecar red-team engines (P26): Spikee built, PyRIT designed and deferred; the ADR-0217 re-test repeats engine runs
- **Migration**: pending `spikee_engine_and_engine_retest`

## Context

The owner approved backlog item P26 on 2026-11-07 (PENDING §2g, "AI security tools from the 2026 roadmap scan"): add
two red-team engines beside garak and promptfoo, run as sidecars the way [ADR-0187](0187-batch5-sidecar-engines.md)
runs its engines.

- **Spikee** (WithSecure, Apache-2.0, Python; 0.9.4, 2026-11). It covers **indirect prompt injection**: it builds a
  dataset of payloads hidden in documents (an e-mail, a web page, a tool's output) from a seed folder, sends each
  document to the target and judges the reply with a local canary or regex judge.
- **PyRIT** (Microsoft, MIT, Python; 1.1.0). It covers **multi-turn attacks** such as Crescendo, TAP and PAIR: an
  attacker model writes each next turn from the target's last reply, and a scorer model judges whether the objective
  was met.

The internal docs named PyRIT only as a parity target ([ADR-0068](0068-redteam-depth.md),
COMPETITIVE_PARITY_PLAN.md §1 Slice B, PathForward.md). No PyRIT adapter or plan existed to build on, so nothing is
duplicated.

The brief's constraints: pin versions and digests; no runtime downloads; disable every hosted or cloud module; route
PyRIT's attacker model through RegulAIt's own governed dispatch (entitlement, cost attribution, audit and the per-run
budget), never straight to a provider; flow runs, results and grading into the existing red-team records
([ADR-0057](0057-continuous-red-teaming.md), ADR-0187) so the [ADR-0217](0217-mrm-auto-retest.md) automatic re-test
can pick them up; fail closed; verify both licences and add THIRD_PARTY.md rows. Backend and engine images only; UI
needs go to #453.

**Licences, verified from the pinned wheels (2026-11-07).** `spikee-0.9.4-py3-none-any.whl` carries
`licenses/LICENSE.txt`, the Apache License 2.0, and its METADATA says `License: Apache-2.0`.
`pyrit-1.1.0-py3-none-any.whl` carries `licenses/LICENSE` (MIT, "Copyright (c) Microsoft Corporation") and
`licenses/NOTICE.txt`, and its classifier is MIT. Both are on the ADR-0176 list. Each image's transitive closure
goes through its own licence gate at build time (decision 8).

## Decision

1. **Both run as ADR-0187 sidecar engines, unchanged in shape.** Each has a runner (`packages/engine-<id>`, image
   `engines/<id>/Dockerfile`) that leases work from the gateway and never runs the tool itself, and, under ADR-0190
   I5, a task that runs the tool in the executor's sandbox under the run's `engine_worker` placement, with the run's
   virtual key as the task secret and the gateway channel as its only route. Nothing new is added to the contract:
   `ENGINE_IDS` gains each engine as it is built (this slice: `spikee`; the pending migration `spikee_engine_and_engine_retest` widens
   `engines_id_check` and seeds its row, off). Each has a manifest entry, a shared catalogue (`packages/shared/src/engines/<id>.ts`), taxonomy rows
   (`ENGINE_TAXONOMY` version 4), compose services under the `engines` profile, and a lock entry in
   `engines/images.lock.json`.

2. **PyRIT's attacker and scorer are the run's judge agent, through the gateway.** `ENGINE_MANIFEST.pyrit.requiresJudge`
   is true. That reuses garak's agent_breaker mechanism (ADR-0187 decisions 203-208) with no second path: run
   validation refuses a run without a judge (422 `judge_required`); the judge needs the same entitlement as the target
   (403 `judge_not_entitled`); the run's key has `allowedModels` = target + judge; and the lease carries
   `judge: {model, headers}`. PyRIT's `OpenAIChatTarget` instances for the objective target, the adversarial chat and
   the scorer all point at the gateway's compat route with the run's own key, so each call is entitled, costed to the
   run's project as `engine:pyrit`, audited per dispatch and bounded by the run's one budget and deadline. A spent
   budget refuses the next attacker call with 401 like a target call, and that objective reads `unknown`. PyRIT never
   holds a provider key. Its memory is in-memory SQLite (never Azure SQL), no `.env` file is loaded, and no Azure
   authenticator runs. A separate attacker agent (distinct from the scorer) is open question 1.

3. **Who covers what.** Spikee covers payloads hidden in content the prompt carries; PyRIT covers conversations.
   Spikee's own LLM-driven attacks and plugins (`llm_jailbreaker` and similar) are `cloud_only` in this build, because
   they would call a hosted model and multi-turn attacker work belongs to PyRIT's governed path. Both reach the target
   over the chat compat route only, so, as garak's latent injection (ADR-0187 decision 147), nothing claims an
   agentic class. A Spikee payload in a document counts as `prompt_injection`, never `indirect_prompt_injection`,
   which ADR-0068 §4 reserves for a tool or connector gateway. System-prompt extraction counts as
   `data_exfiltration`, and every PyRIT attack counts as `jailbreak`.

4. **Dispositions, as garak's.** Each set is `local` (runs), `cloud_only`, `excluded_licence` or `missing_preseed`.
   Each catalogue publishes its reduced set as data (`airGappedReducedSet`). A set the catalogue does not know never
   reaches the tool: it is reported not run and classed `offensive`.

5. **Spikee's catalogue** (set ids `dataset:<seed>` and `plugin:<name>`). The local datasets are the seed folders
   WithSecure wrote inside the Apache-2.0 wheel and judges with canary or regex judges: `cybersec-2026-01`,
   `llm-mailbox`, `sysmsg-extraction-2025-04` and `mini-test`. Five folders hold no data, only a script that downloads
   a third-party Hub dataset at run time; they are `cloud_only`. Three are judged by Spikee's LLM judge, which calls a
   hosted model; they are `cloud_only` too (open question 2). The local plugins are the deterministic obfuscations
   (`base64`, `hex`, `1337`, `homoglyph`, `ascii_smuggler`, `best_of_n`, ...). Translation, speech, image, shortener
   and LLM-rewrite plugins are `cloud_only`, and `opus_translate` is `missing_preseed`. A run needs at least one
   dataset (a plugin only transforms one), and Spikee takes no run params. Every Spikee set is `standard`, judged
   locally, with no judge model.

6. **Spikee in the sandbox.** The worker generates the dataset offline from the image's own seed folders and points
   Spikee's target at the gateway channel with the run key and `x-regulait-*` headers only. The `assertGatewayOnly`
   invariant refuses any other host, key or provider before anything runs. The viewer (Flask), the Hub fetch scripts
   and every provider except the gateway-pointed one never run.

7. **PyRIT's catalogue** (set ids `attack:<name>`). Local: `crescendo`, `tap`, `pair`, `red_teaming` (multi-turn,
   attacker and scorer), and `prompt_sending` and `skeleton_key` (single-turn, scorer). Not run:
   `many_shot_jailbreak` (`excluded_licence`: its bundled examples file has no authorship or licence record) and `gcg`
   (`cloud_only`: Azure ML and local weights). Objectives come only from PyRIT's own AI Red Team seed files
   (`datasets/seed_datasets/local/airt/*.prompt`, MIT), each pinned by sha256; the seed sets PyRIT took from third
   parties (AdvBench, 0din, garak, psfuzz) are not used. Every admitted
   attack is classed **`offensive`**, so a PyRIT run waits for an approver (ADR-0187 owner decision 4). Each run spends
   attacker and scorer calls on top of the target's and produces harmful intermediate text by design. One param,
   `max_turns` (an integer from 1 to 10, default 5), bounds a conversation. The run's budget is the hard stop either
   way.

8. **Images: pinned, offline and gated, as garak's.** Each Dockerfile uses garak's digest-pinned node and Python
   bases, installs a fully hash-pinned closure (`pip --require-hashes --no-deps --only-binary :all:`), runs
   `pip check`, asserts the pinned version, runs a licence gate over the installed site-packages and removes pip.
   It runs as uid 10001 with the offline switches in `{SPIKEE,PYRIT}_USAGE_DATA_ENV`. No extra (torch, Azure ML,
   playwright, speech) is installed. Each image is built in CI (`engine-images-build.yml`, twice, for
   reproducibility), and on main it is published and keylessly signed (`engine-images.yml`). Its digest enters the
   lock only through the signed-publish PR, which a person merges.

9. **Fail closed, by construction.** The lock entries are null until that first signed publish, so the manifest's
   `imageDigest` and `taskImage` are null. No runner passes the self-test (`image_not_built`), neither engine can be
   enabled, and no task can be placed (`policy_unresolved`). Once published, everything ADR-0187 already enforces
   applies: off by default, enabling needs a fresh passing self-test and a `settings_relax` step-up, the worker's own
   self-test switch, and egress denial. Inside a run, the adapter ends the run `not_run` when nothing is runnable,
   when the target or (for PyRIT) the judge is missing, or when the invariant refuses the config. A missing,
   unreadable or errored result is `unknown`, never a pass, and the server recomputes every aggregate.

10. **Results flow into the existing records.** A completed run's items are normalised by the shared
    `normaliseEngineResult` against the taxonomy table and written to `redteam_runs`, `redteam_probe_trials` and
    `eval_runs` by `writeEngineRunLedgers`, exactly as garak's are. A3 and the evaluator catalog count only the mapped
    classes.

11. **The ADR-0217 automatic re-test repeats engine runs** (all four red-team engines, not only these two). Before
    this, the re-test re-ran only pinned eval baselines and red-team libraries, and no engine run of any engine was
    ever repeated. Now:
    - A third kind, `engine`, covers each completed red-team engine run a person made against the certified agent.
      There is one per engine and configuration hash, the newest first. A run a re-test started is never itself a
      source.
    - It is created again through `createEngineRun` as that person, on that project, with the same sets, judge,
      trials and budget, so every gate applies: entitlement, project, budget, the approvals rule, and the engine being
      on and self-tested. The `MRM_AUTO_RETEST_MAX_SUITES` cap still counts it.
    - An engine run is asynchronous. The re-test row is claimed `running` and linked to the run it started
      (`mrm_retest_runs.engine_run_id`, the same migration) under that run's row lock. It is settled in the same
      transaction that ends the run (`settleEngineRetestTx`, called from every terminal path: `endLockedRun` and the
      approval refusal), from the gateway's normalised verdict:

      | The engine run ends | The re-test becomes |
      |---|---|
      | completed, fail | `failed_gate` |
      | completed, pass with at least one measured item | `passed` |
      | completed, anything else | `reported` |
      | refused in the Approvals Queue | `refused` |
      | timeout, cancelled, failed or not_run | `reported` |

      A run that ended before the link is settled at the link.
    - With an engine off (the default), the re-test is `refused` with `engine_disabled`, and no run is made.
    - It never signs anything off (ADR-0217 decision 6).

12. **Alternates documented, not built.**
    - **DeepTeam** (Confident AI, Apache-2.0, Python). An LLM red-teaming framework with vulnerability and attack
      modules (including multi-turn jailbreaks). It overlaps PyRIT's multi-turn coverage and promptfoo's plugin
      coverage, and its attacks and grading lean on an LLM it calls through its own model wrappers, so it would need
      the same re-pointing PyRIT gets. Held as the alternate if PyRIT's closure or maintenance becomes a problem.
    - **Augustus** (Apache-2.0, Go). A single static binary with no Python closure, which would make a much smaller,
      easier-to-scan image. Held as the alternate for a slim air-gapped image. Not built because its attack catalogue
      overlaps garak's and Spikee's, and a third Go toolchain in the engine build is not justified until an install
      needs it.

    Re-check both at the next engine review (`reCheckBy` 2027-02-07).

13. **Open source first (ADR-0176).** Spikee's CLI and PyRIT's attack classes do the attacking and the scoring. The
    gateway's existing judge path, run key, lease, ledgers and re-test runner are reused. Our code is the governance
    part: the catalogues and their dispositions, the gateway-only invariants, the mappers to the shared envelope, and
    the re-test link. None fits for that part, because it is RegulAIt's own policy semantics.

## Consequences

- Two more engines appear on `GET /v1/engines`, off and `not_built` until their first signed publish. The merge to
  main triggers the publish workflow (a never-published engine always publishes), and its lock PR is a HOLD draft that
  a person merges.
- A PyRIT run always needs a judge agent and always waits for an approver. That is deliberate: it is the most
  expensive and least predictable run type.
- The automatic re-test now spends engine budgets too, under the same off-by-default org setting
  (`mrmAutoRetestEnabled`).
- **UI follow-ups (posted on #453, not built here):** the Engines page and run form name the two new engines, the
  `dataset:`/`plugin:`/`attack:` sets and PyRIT's `max_turns`. The judge field's help says that PyRIT uses the judge
  as attacker and scorer. The re-test results on the Model risk page show kind `engine` with a link to the engine
  run (`RetestResults.tsx` types `kind` as `eval | redteam` today).

## Open questions

1. **A separate attacker agent for PyRIT.** Today one judge agent is both attacker and scorer. A distinct
   `attackerAgentId` (its own entitlement, in `allowedModels`) would let an org use an uncensored attacker and a
   conservative scorer. This is an owner decision, because it widens what a run key can reach.
2. **Spikee's LLM judge through the gateway.** The three LLM-judged seed folders could run with the run's judge,
   as garak's judge probes do. They stay `cloud_only` until the owner admits them.
3. **Licences outside the ADR-0176 list in the two closures.** Any found are listed in each engine's
   `licence-allow.json` as reused from ADR-0187 decision 193 and await the owner's confirmation for these engines
   (see the "As built" section).
4. **Finishing PyRIT** (see "As built"): a builder working in a session that can review and write PyRIT's attack
   driver and its seed handling, or the owner's call to drop PyRIT for DeepTeam (decision 12).

## As built (2026-11-07, branch `builder/p26-spikee-pyrit-engines`)

**Spikee: built.** `packages/engine-spikee` mirrors garak's runner and task modules, and `engines/spikee` holds the
image (70 hash-pinned wheels, a licence gate, a data prune and the THIRD_PARTY notes).
- **Target.** Every built-in LLM path in Spikee 0.9.4 goes through any-llm's provider registry, which reads a hosted
  endpoint and key from the environment or `.env` and has no per-request header setting. So the target is a small
  workspace module, `targets/regulait_gateway.py`, using Spikee's own `<cwd>/targets/` hook. It uses the standard
  `urllib` with proxies off and redirects refused. It calls one URL, `<base>/chat/completions`, with the run key from
  `REGULAIT_SPIKEE_API_KEY` and only `x-regulait-*` headers.
- **Processes.** Each dataset runs as two isolated Spikee processes (`python -I -B`, Spikee's own CLI): `generate`
  from the image's read-only seeds, then `test --target regulait_gateway --threads 1 --attempts 1 --max-retries 1`.
  No target, judge or plugin options and no attack module are ever passed. The trials cap selects entries
  deterministically.
- **Measured.** Real Spikee in the pinned closure against a fake gateway passes 5 cases:
  - a complying target reads `fail` and a refusing one `pass`;
  - exactly 6 calls for 3 entries × 2 items, each a POST to `/v1/chat/completions` with the run key and only the
    agent and project headers;
  - a 401 reads `unknown`, never a pass;
  - system-prompt extraction against a leaking target reads `fail`.
- **Guards.** Every guard was shown red once by breaking it (the builder's report on the PR lists them).
- **Image.** It built locally, with the sandbox's TLS proxy CA passed only as a BuildKit secret. `pip check` passes,
  the prune removed 8 excluded paths, and the licence gate reports 77 allowed, 9 admitted by the allow file and
  0 denied (before the fsspec fix below; after it, 57 allowed, 8 admitted, 0 denied). Inside the image (`--network=none`, uid 10001), the offline generate step works.

**Catalogue corrections from reading the 0.9.4 wheel:**
- `plugin:mask` is `cloud_only`: it asks a hosted LLM which words to mask.
- `plugin:text2image` is `unsupported_format`: it renders an image locally, which the chat route cannot carry.
- `dataset:cybersec-2026-01` stays local. Its two `poetry` jailbreaks cite a Hub sample with no stated licence and
  are never generated (`--jailbreak-filter` names the other 20 types).
- `dataset:sysmsg-extraction-2025-04` is generated with `--include-system-message`. Its regex judge looks for
  Spikee's own demo system message, so without it every reply would read as a false pass.

**Licences outside the ADR-0176 list.** Eight are listed in `engines/spikee/licence-allow.json` as "reused from
ADR-0187 decision 193 (or 106) for spikee; owner to confirm (ADR-0245)": PSF-2.0 (python, typing_extensions), MPL-2.0 unmodified (certifi, tqdm), CNRI-Python (regex), and numpy's Zlib, libgfortran and
libquadmath. The gate accepts that wording as a third form, which admits like "pending". This is open question 3.

**PyRIT: designed, not built in this slice.** Two builder attempts were stopped by a content-safety filter while
handling PyRIT's harmful-objective seed data and attack code, before any file compiled. The design above
(decisions 2 and 7) stands. In this slice:
- `pyrit` is not in `ENGINE_IDS`, the lock, compose or the migration, so nothing half-built ships.
- The partial work (the run plan, the driver config and the gateway-only invariant, uncompiled) is kept on branch
  `builder/p26-pyrit-wip`.
- The follow-up adds the engine with its own migration.

Findings recorded for that follow-up:
- **av.** PyRIT's hard dependency `av` 19.0.2 bundles GPL libx264 and libx265, so its `av.libs` must be pruned at
  build time, with the build asserting that `av` cannot be imported. This needs the owner's confirmation.
- **scipy.** Its bundled libgfortran and libquadmath are a new subject for the owner's decision 106.
- **Memory.** It must be set to in-memory SQLite directly; `initialize_pyrit_async` must not be called, because it
  loads `.env` files and can read Azure Key Vault.
- **Request fields.** `OpenAIChatTarget` sends only fields the compat route allows (temperature, top_p, seed and n
  stay unset).
- **Scorers.** TAP and PAIR need a `FloatScaleThresholdScorer` over a `SelfAskScaleScorer`.
- **Objectives.** Only the AI Red Team seed files, each pinned by sha256 and referred to by index. Output and logs
  must never echo seed or model text.

**The engine re-test (decision 11) is built for every red-team engine.** The re-test was measured on Postgres 16
(`zz-adr0245-engine-retest.test.ts`):
- one suite per engine and configuration, run as its person;
- `refused` with `engine_disabled` while the engine is off, and no run made;
- a cancel through the real route settles it `reported`, once, with its audit row (red with the hook removed);
- the database refuses an engine link on a non-engine row.


## Addendum (2026-11-07): msoedov/agentic_security coverage diff (owner scope added to P26)

The owner added to P26: compare **msoedov/agentic_security** (Apache-2.0, Python, 1.0.0, released 2026-05-14; the
previous release was 0.7.4 on 2025-05-27) against garak, promptfoo, Spikee and PyRIT. Add only what fills a real gap.
Check air-gapped operation, and remove or vendor any remote fetch.

**Method.** I read the 1.0.0 sdist from PyPI (no wheel is published) by its code and metadata only: URLs, dataset
ids, network calls and module structure. No probe text was read. The licence is the Apache License 2.0 (`LICENSE`).

| Area | What agentic_security 1.0.0 does | Already covered here | Air-gapped? | Verdict |
|---|---|---|---|---|
| Jailbreak prompt sets | `probe_data/data.py` downloads its sets at run time: `load_dataset` on Hub datasets (JailbreakHub, JailbreakBench, rubend18, sevdeawesome, an AdvBench-derived set) and raw GitHub CSVs (verazuo/jailbreak_llms, tml-epfl harmful behaviours). None of it ships in the package. | garak's admitted probes, Spikee's local seeds, promptfoo's plugins | No | Not added. The data is third-party with no licence established for these copies, and the in-the-wild set is the one Spikee already marks `cloud_only`. |
| `prompts.csv` | A user-supplied CSV read from `./datasets/` (an example in the README); none is shipped. | A customer's own red-team library (ADR-0057) does this, governed | Yes | Not added; it is a format, not data. |
| Fuzzing / encodings | `stenography_fn.py`: rot13, rot5, base64, mirroring, case and scrambling noise, Caesar, substitution and Vigenère ciphers. | Spikee's plugins (base64, hex, leetspeak, atbash, caesar, homoglyph, ascii_smuggler, best_of_n, ...) and garak's encoding probes | Yes | Not added; no gap. |
| Many-shot | `msj_data.py` loads its examples with `load_dataset` at run time. | (PyRIT's many-shot is `excluded_licence`, decision 7) | No | Not added: remote, third-party data. |
| Multimodal: image | `image_generator.py` renders the prompt text into an image (matplotlib) and sends it base64-encoded. | None | Yes, it renders locally | **Real gap, not fillable yet.** The gateway's compat route that engines use carries text only, which is why Spikee's `text2image` is `unsupported_format`. It needs a governed multimodal route first (follow-up below). |
| Multimodal: audio | `audio_generator.py` uses gTTS (Google's hosted text-to-speech), or macOS `say`. | None | No (gTTS is hosted) | **Real gap, not fillable**: a hosted service and a text-only route. |
| RL-guided selection | `rl_model.py`'s default is `CloudRLPromptSelector`, which posts to a hosted service with a token hard-coded in the source (`AS_TOKEN` default). A local `QLearningPromptSelector` picks the next prompt from refusal feedback. `fine_tuned.py` calls a hosted model at `mcp.metaheuristic.co/infer`. | Adaptive attacker search is PyRIT's TAP/PAIR (designed, decision 7) | Cloud default: no; local Q-learning: yes | Not added. The default is hosted. The local selector only reorders prompts from the remote sets above, and its refusal signal is a bundled scikit-learn model loaded from `.joblib` pickles of unknown training data, an arbitrary-code-on-load format we do not admit (the ADR-0187 modelscan stance). |
| Garak and Inspect bridges | `garak_tool.py` and `inspect_ai_tool.py` shell out to those tools. | garak is our own engine | n/a | Not added; it duplicates garak. |
| Telemetry | `routes/telemetry.py` starts Sentry with `send_default_pii=True` and full tracing unless `DISABLE_TELEMETRY` is set. | n/a | No | It must be off in any use. Recorded, not used. |
| Providers | `llm_providers/`, plus hard-coded hosted endpoints (OpenAI, Anthropic, Together, Groq, DeepSeek, Cohere, Replicate, OpenRouter, AssemblyAI). | The gateway is the only route | No | Never used. |

**Decision.** Nothing from agentic_security is added, as probe data or as an engine. Every part that would fill a gap
either needs data downloaded at run time from third parties with no established licence, a hosted service, or a
multimodal route the gateway does not yet offer. What is left (encodings, a CSV format, a garak bridge) is already
covered. A third engine is therefore not justified: it would ship a FastAPI app, Sentry, gTTS and a joblib-pickle
classifier to run nothing the existing engines do not. Vendoring the remote sets is not done: their licences are the
problem, not the download.

**The one real gap: multimodal attacks.** Image and audio prompt injection is not covered by any engine here. It
needs a governed multimodal compat route (image and audio content parts, with their own scrub, size caps and cost
attribution) before any engine can exercise it. Recorded as open question 5. agentic_security's local image renderer
is a 141-line matplotlib module, and Spikee's `text2image` plugin does the same, so once the route exists the cheaper
path is to admit Spikee's plugin, not a new engine.

**Open question 5 (owner).** Should a governed multimodal compat route (image and audio parts) be built? It would
unlock multimodal red-teaming (Spikee's `text2image`, or another tool) under the same entitlement, cost and audit
path.

## As built (2026-11-07): fsspec CVE-2026-104851 in the Spikee closure

CI's image scan of the first Spikee build found **CVE-2026-104851** (HIGH, fixed in 2026.6.0) in `fsspec` 2026.2.0.
Spikee pins `datasets==4.8.4`, and that release caps `fsspec<=2026.2.0`, so fsspec cannot be upgraded while `datasets`
is installed.

No module Spikee runs imports `datasets`. Its only importers are the five Hub fetch scripts the image already removes.
So the dependency is **removed, not allow-listed** (the security checklist forbids allow-listing a vulnerable
dependency):
- **The lockfile** drops `datasets` and the 18 distributions only it needs: the aiohttp stack, attrs, dill, filelock,
  fsspec, hf-xet, huggingface-hub, multiprocess, packaging, pyarrow, pyyaml and xxhash. 70 pins become 51.
- **The metadata.** `drop-unused-requirement.py` deletes exactly the `Requires-Dist: datasets==4.8.4` line from
  Spikee's installed METADATA. The script is pinned to the reviewed file's sha256, fails if that line is not there
  exactly once, and rewrites RECORD. `pip check` then runs unchanged.
- **The build** asserts that `datasets`, `fsspec`, `huggingface_hub`, `pyarrow` and `aiohttp` cannot be found.
- **The licence gate** has one allow entry fewer (`aiohappyeyeballs` is gone): 57 allowed, 8 admitted, 0 denied.

Measured in the pinned base image: the trimmed closure installs by hash, `pip check` passes, the absence check passes,
the prune passes, and the offline `spikee generate` of `mini-test` writes its dataset.

The other image-scan failures on this PR (promptfoo, modelscan and Spikee: zlib1g CVE-2026-76844 and CVE-2026-85091,
fixed in `+deb13u1`) come from the shared pinned Debian bases, not from this change. They are left for a base-digest
bump across all engines once upstream rebuilds.


# ADR-0242: Cisco mcp-scanner and skill-scanner as offline admission-scan engines (P23)

- **Status:** Proposed (phase 1 built; phase 2 named below)
- **Date:** 2026-11-07
- **Deciders:** owner (backlog item P23 approved 2026-11-07); the builder's defaults are marked and open to the owner
- **Builds on:** ADR-0187 (the sidecar engine contract), ADR-0097 and ADR-0100 (MCP admission scanning and re-scans),
  ADR-0175 A6 (builder-skill admission), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200
  (engineering guidelines, normalised schema)

## Context

The owner approved P23 on 2026-11-07: add Cisco's `mcp-scanner` and `skill-scanner` as **offline** scan engines.

- mcp-scanner joins the existing MCP server admission scan and its re-scans. It runs YARA and static analysis on
  tools, prompts and resources in its offline JSON (`static`) mode.
- skill-scanner covers agent skills and plugins (SKILL.md and bundles). Nothing scans that supply-chain surface with
  an external engine today.

Both must run as sidecars, the way ADR-0187 runs garak and modelscan. The constraints are: exact versions and digests
are pinned, the YARA rules are baked into the image, nothing downloads at run time, every cloud, LLM or VirusTotal
analyzer is off by configuration and proven off, mcp-scanner's Docker-based PyPI package scan is left out unless it
fits the sidecar model safely, findings flow into the existing admission states and audit, and an engine error is
never a pass.

**Where skills enter the product (checked on `main` @ `d8d6480`).** A skill is a `builder_skills` row. It enters
through five doors, all of which already run the in-process ADR-0175 A6 scan (`admitSkillText`): create, SKILL.md
import, update, template seeding and agent-bundle import. A skill is attached to an agent as a pinned copy
(`builder_agent_skills`), and the pinned body is what reaches a prompt. There is no plugin or bundle-with-scripts
upload yet. A skill is text: its name and body. skill-scanner can also scan scripts and binaries bundled beside a
SKILL.md, and that capability waits for the day the product accepts such bundles. So the subject skill-scanner scans
today is one SKILL.md, written from the stored name and body.

**What was verified for this ADR (2026-11-07, by the builder, not taken from release notes).**

| | mcp-scanner | skill-scanner |
|---|---|---|
| PyPI package and version | `cisco-ai-mcp-scanner` 4.8.7 | `cisco-ai-skill-scanner` 2.3.2 |
| Wheel sha256 | `55142609…8906350` (py3-none-any) | `0222d84c…16f0efa5`, a manylinux x86_64 wheel that bundles a Go CEL helper |
| LICENSE, read from the sdist | the full Apache License 2.0 text; its sha256 `c71d239d…0ab4` is the canonical text | the Apache-2.0 notice ("Copyright 2026 Cisco Systems, Inc."), sha256 `6f8bdae6…ae5998`; `pyproject.toml` says `Apache-2.0` |
| Offline analyzers | `yara` (ten bundled rule files) and `schema` | the core set: static (YARA-X rule packs, signatures, CEL gates), bytecode, pipeline taint, correlation |
| Remote analyzers (never built) | Cisco AI Defense `api`, `llm`, `meta`, `virustotal`, `behavioral`, `vulnerable_package` (pip-audit, which reaches PyPI and OSV), `readiness` | `llm`, `meta`, the behavioural LLM path, `virustotal`, `aidefense`, `osv`, `trigger`, System One |
| Hard dependencies on cloud clients | `litellm` 1.93.2, `openai` | `litellm` 1.108.2, `openai`, `anthropic` |

Measured with `strace -f -e trace=connect` on the real closures, and again inside the built images with
`--network=none`:
- **litellm fetches a remote price map at import** (`raw.githubusercontent.com/BerriAI/litellm/…`) unless
  `LITELLM_LOCAL_MODEL_COST_MAP=True`. mcpscanner's package root imports litellm, so a plain `mcp-scanner static` made
  six `AF_INET` `connect()` calls. With the switch set: none.
- skill-scanner's core path made no `connect()` at all, and imports none of litellm, openai or anthropic.
- mcp-scanner's CLI defaults to `--analyzers api,yara,llm`. Without keys it only prints warnings, but a key in the
  environment would turn on a cloud call. That is why the driver does not use the CLI (§2).

**Two supply-chain findings in the upstream closures.**
1. **yara-python 4.5.4's wheel (the latest release) bundles OpenSSL 1.1.1w** (`libcrypto.so.1.1`, end of life since
   2023-09). mcp-scanner's rules import no YARA module (no `hash`, `pe` or `magic`), so yara-python can be built
   without OpenSSL at all.
2. **skill-scanner pulls `pcodedmp` (GPL-3.0) through `oletools`.** skill-scanner reaches oletools only through
   `oletools.oleid`, for Office files. That path never imports pcodedmp (olevba imports it lazily, inside a `try`, for
   P-code disassembly). oletools also carries `thirdparty/xxxswf`, which states no licence and which oleid only names
   in a comment.

**mcp-scanner's PyPI and npm package scans** build a container (`core/docker_build.py`, `package_sandbox.py`) and
fetch the package from the internet. They need a Docker daemon in the sidecar and egress to registries. That is the
opposite of the sidecar model (no socket, no network), so they are left out (§5).

## Decision

### 1. Two ADR-0187 engines of a new kind, `admission_scan`

`mcpscanner` (Cisco mcp-scanner 4.8.7) and `skillscanner` (Cisco skill-scanner 2.3.2) join `ENGINE_IDS`, with kind
`admission_scan`. Migration 0298 widens the 0173 CHECKs and inserts both rows. Their manifest entries follow the
ADR-0187 contract: `needsModelAccess: false`, one `scan` set, a worker-attested offline switch, and **no image
digest** until the image is published and recorded in `engines/images.lock.json`. With no digest, no self-test can
match the build, so **neither engine can be enabled yet** (ADR-0187 decision 3; ADR-0180). This is deliberate: an
engine that holds every subject while no runner exists would stop the product.

An admission-scan run is started by the admission gate, never by a person. `POST /v1/engine-runs` keeps refusing a
target it does not know (phase 2 adds the subject target).

### 2. Our driver, one per engine (`engines/<id>/scan.py`)

The driver is the only code we write around each engine (ADR-0176). It is run as `python -I scan.py <in> <out>`:
- **It builds only the local analyzers, by construction.** For mcp-scanner:
  `StaticAnalyzer([YaraAnalyzer(rules_dir=<baked>), SchemaReferenceAnalyzer()])`. For skill-scanner: its own
  `build_core_analyzers(policy)`, never `build_analyzers`. Each driver checks that the analyzer set it got is exactly
  the expected one, and fails otherwise.
- **It refuses to start when a cloud credential is in its environment**, for example `MCP_SCANNER_API_KEY`,
  `MCP_SCANNER_LLM_API_KEY`, `SKILL_SCANNER_LLM_API_KEY`, `VIRUSTOTAL_API_KEY`, `AI_DEFENSE_API_KEY`, the OpenAI,
  Anthropic and Gemini keys, or AWS credentials. It sets `LITELLM_LOCAL_MODEL_COST_MAP=True`,
  `LITELLM_TELEMETRY=False` and `HF_HUB_OFFLINE=1` before any import. The skill driver also fails if litellm, openai
  or anthropic ended up imported.
- **It checks the rule digest.** The rules the engine actually reads must hash to the committed digest:
  `yara-rules.sha256` for mcp-scanner, and `rules.sha256` over skill-scanner's packs. A rules change is therefore a
  reviewed change, never a silent one.
- **It writes a `regulait.admission-scan.v1` report** of rule ids, severities, item kinds and names. It never
  includes a description, resource text or a skill snippet. mcp-scanner's raw output echoes the tool description; the
  driver drops it.
- **It fails closed.** An analyzer error, an unscanned item, an unknown severity, an unreadable input or a digest
  mismatch makes the report `failed`, and the process exits 2.

### 3. The images (`engines/<id>/Dockerfile`)

- Every base image is pinned by digest: `python:3.12-slim-trixie@sha256:4840d514…`, `node:22-trixie-slim@sha256:be1e2a3d…`
  for the licence gate, `python:3.12-trixie@sha256:cad37dd2…` to build yara-python (all CPython 3.12.16), and
  `golang:1.27-trixie@sha256:af1bfc26…` (Go 1.27.3) to rebuild skill-scanner's CEL helper.
- The closure comes from our lockfile (`requirements.txt`): every wheel is pinned by sha256 and installed with
  `--require-hashes --no-deps --only-binary :all:`. That is 110 wheels for mcp-scanner and 99 for skill-scanner,
  resolved for cp312 manylinux x86_64. pip is removed from the image.
- **yara-python is built from its hashed sdist with no OpenSSL** (`requirements-sdist.txt`). The OpenSSL headers are
  deleted before the build, and the build fails if the module links `libcrypto`. setuptools is pinned by hash
  (`requirements-build.txt`) and never ships.
- **Three published advisories are fixed in the image, not allow-listed** (found by the CI-pinned Trivy 0.74.0 on the
  first local build):
  - mcp-scanner pins `litellm==1.93.2` (CVE-2026-114612, GHSA-g5ff-637f-6q2m). Our lockfile overrides it to 1.108.2,
    the version skill-scanner already uses (`uv pip compile --override`). mcp-scanner imports litellm and never calls
    it on our path.
  - `filelock` 3.32.7 (CVE-2026-112940) is fixed only in 4.2.1. litellm 1.108.2 declares `filelock<4.0`, so both
    lockfiles override filelock to 4.2.9. garak already ships filelock 4.x with litellm; the smoke scans prove both
    engines still run.
  - skill-scanner's wheel bundles a Go CEL helper built with Go 1.27.1, whose standard library carries four advisories.
    The image rebuilds it from skill-scanner's own sdist (sha256 checked) with Go 1.27.3 (`golang:1.27-trixie`, pinned
    by digest) and the flags of its packaging script. `cel-helper.py` swaps it in and rewrites the four
    build-describing fields of its manifest, which skill-scanner checks at every start. The module downloads are
    checked against the sdist's `go.sum` and happen at build time only.
  The remaining HIGH findings are in Debian packages of the pinned base image with no fix published. They are the same
  as the modelscan image's, and the CI gate only fails on fixable ones.
- **pcodedmp is not installed and xxxswf is pruned.** The build fails if pcodedmp is present, and checks that
  `oletools.oleid` still imports.
- **The YARA rules are baked in.** For mcp-scanner they are copied read-only to `/opt/mcpscanner/yara_rules`; for
  skill-scanner they are its packs inside the venv. Both are hashed against the committed digest at build and at
  every run. Everything under `/opt/<id>` is made read-only.
- **The licence gate** (garak's `licence-gate.mjs`, copied) runs on the installed closure, with readings for packages
  whose metadata names no SPDX licence. The terms outside the ADR-0176 list are PSF-2.0, MPL-2.0, MIT-0 and
  CNRI-Python, plus numpy's Zlib and GCC-runtime libraries for skill-scanner. These are the same subjects with the
  same licences that the owner accepted for garak (ADR-0187 decisions 106 and 193), and they carry those decisions
  (**builder's default; the owner may object**, open question 1).
- **An offline smoke scan runs in the image as built, under `RUN --network=none`.** The known-bad fixture must be
  flagged at high or above, and the clean one must pass, or the build fails.
- The image runs as uid 10001.

**Measured, 2026-11-07.** Both images were built locally (the scratch build added only this sandbox's TLS-proxy CA
for pip; the committed Dockerfiles do not). The mcpscanner licence gate gave 109 allowed, 8 admitted and 0 denied,
and yara-python linked no libcrypto. The skillscanner gate gave 104 allowed, 10 admitted and 0 denied. Each image ran
both fixtures with `--network=none --read-only --cap-drop=ALL` and no `/tmp`. The first run found that litellm 1.108.2 needs a writable temp directory at import, and a read-only container
has none. The driver now falls back to its output directory, and it reports `failed` (never nothing) when the engine
cannot start. The reports are committed as test fixtures
(`packages/shared/src/engines/fixtures/admission-scan`). Image sizes are 739 MB (mcpscanner) and 1.54 GB
(skillscanner; onnxruntime and magika come in through skill-scanner's file-type detection). The pinned Trivy
0.74.0 with CI's gate (`scripts/security-gate.mjs`, empty allow-list) passed on both: 0 fixable HIGH or CRITICAL.

### 4. The verdict flows into the existing admission states (fail closed)

`interpretAdmissionScanReport` (shared, pure) turns a report into `pass`, `fail` or `unknown`, with counts-only
findings in the admission vocabulary `{rule, severity, tool, where: "engine:<id>:<kind>", count}`. A missing,
invalid, failed or wrong-version report is `unknown`, and so is one that scanned nothing or left an item unscanned.
The hold line is the subject's own: `high` for an MCP server (MCP_ADMISSION_HOLD_AT) and `medium` for a skill
(SKILL_ADMISSION_HOLD_AT). An `info` finding, such as skill-scanner's missing-licence note, is advice and not a
finding.

`admission_engine_scans` (migration 0298) holds one row per scan of one subject at one digest. The subject is a real
foreign key (`mcp_server_id` or `builder_skill_id`, exactly one set). `findings` is a point-in-time evidence snapshot,
the ADR-0200 addendum exception. With the engine **on**, only a `pass` for the subject's **current digest** admits;
no scan yet (`pending`), `unknown` and `fail` all hold. With it **off**, the shipped default, the engine has no say
and nothing changes. The engine's say reaches the existing states in two places:
- **Recording a scan** (`recordAdmissionEngineScan`) folds it into the stored state when it is about the current
  digest. A `clean`, `unscanned` or `grandfathered` subject becomes `held` on a `fail` or `unknown`. A `held` subject
  whose only findings were the engine's becomes `clean` on a `pass`. Every scan writes an audit row
  (`admission-engine-held` with effect deny, or `admission-engine-passed` with effect allow), counts only. An admin's
  decision for the digest stands: `cleared` and `admitted` are not overridden, and neither is a `refused` skill. The
  engine's findings are on the row, so the admin can re-review. **This is the builder's default.** The alternative,
  re-holding a clearance that was given before the engine's verdict existed, is open question 2.
- **The gates consult the engine live** (`engineAdmissionFor`), so a new digest with no scan yet is held:
  - the MCP manifest sync folds the engine's say into the scan (`withEngineMcpFindings`), so under `enforce` a
    pending manifest is held and its tools are never stored;
  - `assertAdmitted` and `admissionHidesTools` refuse and hide the tools of a server whose stored state admits but
    whose current digest the engine has not passed;
  - `skillAttachRefusal` and the run-time loader (`pinnedBodyWithheld`) hold a skill or pinned copy whose digest the
    engine has not passed.

### 5. Out of scope

- **mcp-scanner's PyPI and npm package scans** (`pypi`, `npm`, `vulnerable-packages`): they need Docker in the sidecar
  and registry egress. Our existing supply-chain controls cover packages: the ADR-0175 A5 release-age cooldown, and
  ADR-0216's signatures and supply-chain block.
- The `remote`, `stdio`, `config` and `known-configs` modes: the engine never connects to an MCP server. The gateway
  hands it the manifest it already fetched through its own guarded connect (ADR-0043, ADR-0185).
- `behavioral` (source-code analysis of an MCP server's code): we do not hold server source.
- Prompts and resources: the driver accepts `prompts.json` and `resources.json`, but the gateway syncs and scans tools
  only today. When the proxy stores prompts and resources, they join the same input.

### 6. Phase 2 (named, not built here)

1. **The runner stage.** A Node shim per image, as for modelscan: lease, heartbeat, and a task run in the executor's
   gVisor sandbox with no network. A new engine target kind `subject` carries the manifest or SKILL.md as inline task
   input (engine-tasks.ts already supports inline input). The result route calls `recordAdmissionEngineScan` in the
   run's transaction, beside `recordArtifactScanTx`.
2. **Queueing.** A scan run is enqueued for a subject's new digest when its engine is on: at MCP sync, at skill save,
   and in the ADR-0100 re-scan sweep. Until it reports, the subject is held (§4).
3. **Publish.** `engines/images.lock.json`, the publish workflow, `scripts/build-engine-image.sh`, the compose
   services and the image-level Trivy and SBOM scan in CI (ADR-0184). Only then does the manifest carry a digest, and
   only then can an admin enable the engine (audited, with a `settings_relax` step-up, ADR-0187 decision 3).
4. **UI** (posted on #453): the Engines page rows, and the engine's status and findings on the MCP and skill
   admission review pages.

### 7. Scope the owner added on 2026-11-07 (relayed by two scheduled master notes), and what this PR did with it

1. **The `anthropics/skills` corpus as a false-positive measure.** This PR measured it and cites it; it does not
   vendor it. At commit `2c5958ec`, 18 of the 19 skills under `skills/` carry an Apache-2.0 `LICENSE.txt`, and
   `doc-coauthoring` carries none. So the corpus is not vendored, and a CI fetch from that pinned commit is a
   follow-up. Measured with the built skillscanner image (`--network=none --read-only`), with the verdict at the skill
   hold line (`medium`):
   - **SKILL.md only**, which is the subject the product scans today: 18 of 19 pass. `docx` is held by
     `compound_extract_execute` (high, two hits). Its instructions legitimately unzip a document and run scripts, so
     this is a false positive.
   - **Full bundles, with the skill's scripts**: 10 of 19 are held. This is the scope a future bundle upload would
     bring. The owner should decide the hold line and per-rule tuning for bundles before skills arrive with scripts
     (open question 5).
2. **Dart's `skills` CLI (dart-lang/ai, BSD-3-Clause) as a second distribution channel.** It is **recorded as a gap,
   not built.** Skills enter the product only through the builder doors listed in Context, each of which stores a
   `builder_skills` row, and that row is what this engine scans. Nothing installs skills from packages or git
   repositories today. When such an import door is added, it must create the same row (and so get the same in-process
   and engine scans), never a side path.
3. **SKILL.md frontmatter validation** (`name`, `description`, and the progressive-loading layout; malformed or
   oversized frontmatter fails admission). This is **a follow-up for the skill import path** (ADR-0175 A6), outside
   this engine. skill-scanner already reports manifest problems as findings (for example `MANIFEST_MISSING_LICENSE`
   at `info`). A strict, size-capped frontmatter parse at import is ours to build and is small. It belongs with the
   import route and its tests, not with the engine contract.
4. **An offline OSV check at MCP-server admission** (design reference: `StacklokLabs/osv-mcp`, Apache-2.0). **This is
   a follow-up.** It needs a declared package and version on the server record, which `mcp_servers` does not hold
   today, and a vendored OSV snapshot with an update path for air-gapped installs. mcp-scanner's own
   `vulnerable_package` analyzer reaches OSV and PyPI over the network and stays off (§2, §5).
5. **Agent Threat Rules (ATR; npm `agent-threat-rules`, MIT, latest 4.3.0 as of 2026-11-06, checked in the npm
   registry).** **For skills, it already applies.** skill-scanner 2.3.2 ships ATR **3.5.6** as its `atr` pack (712
   signatures in 10 files, MIT per the pack's README). The pack is loaded by the core static analyzer and pinned by our
   `rules.sha256`. **Follow-ups:**
   - move the pack to ATR 4.3.0. That is a reviewed rules change, so the digest moves;
   - carry each ATR rule's MITRE ATLAS and OWASP ids into our findings. Our report keeps only the slugged rule id
     today;
   - apply ATR to MCP tool descriptions. mcp-scanner reads YARA, not ATR's Sigma-style YAML, so this needs either a
     converted rule set or our own matcher over the vendored snapshot.
   Neither fits this PR cleanly.

## Consequences

- Phase 1 changes no behaviour on an install: the engines are off and cannot be turned on. It adds two engine rows,
  one table, and one primary-key read of the engine row in each MCP and skill gate check while the engine is off.
- Turning an engine on (after phase 2) holds every subject until its current digest is scanned. That is the fail-closed
  rule the owner asked for, and admins should expect a burst of re-scans.
- The closures are large, because cloud SDKs are hard upstream dependencies. They are never imported on our path
  (skill-scanner) or never called (mcp-scanner), and the task has no network. They still raise the image's
  vulnerability surface, and Trivy will report on them in phase 2.

## Open questions for the owner

1. **Licences.** May the licence acceptances recorded for garak (ADR-0187 decision 193: PSF-2.0, MPL-2.0, MIT-0,
   CNRI-Python; and decision 106 for numpy) cover the same packages in these two images? The builder applied them.
2. **Clearance versus a later engine verdict.** Should an admin's `cleared` or `admitted` decision given before the
   engine scanned that digest be re-held by a later `fail`? The builder's default keeps the person's decision.
3. **yara-x's statically linked Rust crates** carry Apache-2.0 WITH LLVM-exception, Zlib and Unicode-3.0 terms
   (from the wheel's own CycloneDX SBOM). They are not on the ADR-0176 list, and the gate cannot see inside a static
   binary. Accept them, or replace skill-scanner's YARA-X path?
4. **oletools' public-domain `oledump` code and BSD `tablestream`/`xglob`** ship as oletools' own thirdparty folder.
   Accept them as listed, or prune skill-scanner's Office-document check (and with it oletools)?
5. **The hold line for skill bundles with scripts.** On the `anthropics/skills` corpus, 10 of 19 full bundles hold at
   `medium` (§7.1). Keep `medium` for bundles, or raise it and tune rules first?

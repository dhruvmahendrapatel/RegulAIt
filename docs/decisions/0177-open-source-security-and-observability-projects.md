# ADR-0177: How 22 open-source AI security, evaluation and observability projects fit into RegulAIt

- **Status**: Accepted as a plan (owner, 2026-10-05: "let us see how we are able to use these projects … to make our tool
  better … I want all these features on the tool. But we need to be careful how we fit all of the unique features in our
  UI. We do not have to build all of these right now, just document these in path forward and next to build with ADRs and
  we will pick these up slowly."). Nothing here is built yet; each "next" item gets its own batch and, where noted, its own
  ADR.
- **Date**: 2026-10-05
- **Builds on**: ADR-0176 (open source first, admission rules), PathForward ("integrate, don't rebuild"; PF-06 to PF-20),
  ADR-0068 (red teaming; air-gapped is the primary deployment, so no runtime corpus fetching), ADR-0042 (guardrail engine),
  ADR-0135 (SIEM export), ADR-0160 (trace evaluation).

## Context

The owner supplied 22 GitHub projects and asked how RegulAIt can use them. The owner's working assumption was that they
are all open source, so we can use them directly as long as we keep their licence. **We checked that assumption and it
holds for most projects but not all of them.** Three research passes cloned every repository and read its LICENSE,
NOTICE files, enterprise directories, release history and telemetry defaults. They found:

- **Licences that are not open source in the ADR-0176 sense:**
  - Elastic License 2.0: asqav-sdk, the Phoenix server, pipelock's `enterprise/` directory, and the Guardrails AI server.
  - Business Source License: trylonai/gateway.
  - AGPL-3.0: the Langtrace server, and a jailbreak collection that one promptfoo plugin downloads.
  - LGPL-3.0: fickling.
  - Llama Community License (not OSI-approved; the multimodal models withhold rights from EU-domiciled companies): the
    Llama Guard and Prompt Guard models.
  - A commercial licence on langfuse's `ee/` directories, which hold exactly the governance features (audit-log viewer,
    data retention, masking, SSO).
- **Projects that are no longer maintained:**
  - whylogs: the vendor ceased operations in January 2025; last release December 2024.
  - Langtrace: dormant since 2025.
  - The Adversarial Robustness Toolbox: no release since July 2025.
  - trylonai/gateway: no commit since June 2025.
  - The LlamaFirewall and CodeShield packages: last published 2024–2025.
- **Usage data sent to the vendor by default:** garak's judge endpoint, NeMo Guardrails, OpenShell, Phoenix, Evidently,
  langfuse, Strix and promptfoo all phone home or fetch content by default. Each needs its switches turned off and our egress
  posture to enforce it, because air-gapped is our primary deployment.
- **Supply-chain history:** one Guardrails AI release on PyPI (0.10.1, May 2026) was malicious, according to the project's
  own advisory.
- **Bundled data we may not redistribute:** garak ships copyrighted text excerpts (`nyt_cloze.tsv`, `potter_cloze.tsv`)
  and scraped jailbreak material.

"Keep the licence file" is therefore necessary but not sufficient. Each project needs a decision about **how** it is used,
because the licence obligations and the air-gap risk depend on that.

Most of these projects also overlap features we already have: guardrails, the MCP proxy, the trace viewer, evals, red
teaming and the audit chain. Embedding them wholesale would give us two policy engines, two trace stores and two UIs. That
is what PathForward and ADR-0176 §4 already rule out.

## Decision

### 1. Five ways a project can be used, each with its own licence bar

| Mode | What it means | Licence bar |
|---|---|---|
| **A. Library** | Linked into our shipped code | ADR-0176: MIT, Apache-2.0, BSD, ISC or a public-domain dedication (Unlicense, CC0-1.0, 0BSD); maintained; pinned; air-gapped; in `THIRD_PARTY.md` |
| **B. Sidecar engine** | A separate process or container we ship or reference by digest. It calls our gateway (so every model call stays governed) or is called through a scanner contract, and its results are normalised into our records | Same as A for anything we ship. An LGPL engine that the **customer** installs may be allowed only by a written owner exception. Never AGPL, ELv2, BSL or SSPL |
| **C. Vendored content** | Rules, patterns, datasets or mapping tables copied in as pinned data, with attribution | Permissive licence on the data itself, provenance recorded (repository, commit, file hash). Never copyrighted excerpts, leaked prompts or unknown-licence material (PathForward PF-10) |
| **D. Standard or interop** | We implement an open format or API and talk to a service the customer runs (an OTLP destination, a registry API) | Any licence: we ship none of their code. Their hosted-service restrictions bind the customer, not us |
| **E. Don't use** | Fails the licence, maintenance or scope test | — |

**Two new admission checks for B and C** (amends ADR-0176's admission rules):
- **Maintainers.** Record the number of active maintainers. A single-maintainer project is acceptable as vendored content
  (C), which keeps working if the project stops. It is not acceptable as a required sidecar (B).
- **Usage data.** Every switch that sends usage data to the vendor or fetches content at runtime is set to off in our
  shipped configuration, and an egress test proves it.

**Never:**
- an engine failure reported as clean (an error is always `unknown` or `not_run`);
- an engine that grants access;
- an offensive tool orchestrated without its own owner ADR (scope record, approval, isolated host, egress pinned to
  in-scope targets).

### 2. Verdict per project

"Next" means a candidate for the next batches. "Soon" means after the contract it depends on exists. "Later" means behind
a P2 or P3 item. "Never" means rejected. Licences were read from the repositories on 2026-10-05.

| # | Project | Licence (verified) | Use | Where it shows up in our UI | Phase |
|---|---|---|---|---|---|
| 1 | microsoft/agent-governance-toolkit | MIT; public preview | **C** port its MCP tool-poisoning, typosquat and rug-pull heuristics (PF-07). **D** match PF-08's wire contract to its Agent Control Specification intervention points. Not A: it would be a second policy engine beside Cedar | Findings in Admission review | Next (heuristics), soon (wire contract) |
| 2 | Azure/Azure-Sentinel | MIT, except some subfolders with their own licence and partner content (check each folder) | **C** port the AI-agent hunting queries into monitor rules: an agent gains a new MCP server, sharing widens to the whole org, instructions change after approval, jailbreak correlation. Later, ship a RegulAIt rule pack for Sentinel users as an ADR-0135 export target (no Microsoft trademarks in its name) | Governance alerts; SIEM export settings | Next (rules), soon (pack) |
| 3 | NVIDIA/garak | Apache-2.0 code; bundled data mixed | **B** sidecar pointed at our gateway, with an allow-listed probe set and local judges; Hugging Face models pre-seeded. Its two copyrighted cloze files are never shipped. **C** its taxonomy tags | Red-teaming: an "engine" choice on a run; same findings view | Soon |
| 4 | meta-llama/PurpleLlama | Per component. MIT: CyberSecEval, LlamaFirewall, CodeShield. Llama Community License: Guard models | **C** vendor CyberSecEval's prompt-injection and false-refusal datasets as versioned eval datasets. Llama Guard and Prompt Guard only as customer-supplied PF-11 classifiers; we never bundle the weights. **E** LlamaFirewall and CodeShield (stale packages; CodeShield depends on semgrep, whose engine we believe is LGPL; not verified) | Evaluations: dataset library; Guardrails: providers | Soon (datasets), later (classifiers) |
| 5 | promptfoo/promptfoo | MIT (README: now owned by OpenAI and still MIT) | **B** the first PF-10 engine: a worker process pointed at our gateway, results normalised into eval runs and red-team findings. **C** its framework mapping tables (OWASP LLM and Agentic, NIST AI RMF, MITRE ATLAS, EU AI Act, ISO 42001). Remote generation, telemetry, update checks and sharing are all off. About 30 plugins and several strategies that need its cloud are reported as `not_run`. The `pliny` plugin (AGPL leaked jailbreaks) is excluded | Red-teaming and Evaluations: engine choice; framework coverage on Compliance packs | **Next** |
| 6 | trailofbits/fickling | LGPL-3.0 | **B** only if the owner grants a written exception for a customer-installed scanner, or a commercial licence | Admission review: second model scanner | Later, with a licence decision |
| 7 | protectai/modelscan | Apache-2.0; maintenance only | **B** the first PF-12 model scanner behind a scanner contract (pickle, PyTorch, Keras, TensorFlow). It does not cover GGUF or ONNX. Policy prefers safetensors | Admission review: model artifacts | Next/soon, with PF-12 |
| 8 | Trusted-AI/adversarial-robustness-toolbox | MIT; no release in 15 months | **E** now. Re-check if 1.21 ships; then **B** for robustness evidence on customer-trained models | — | Later |
| 9 | obot-platform/obot | MIT, with licence-key gates (user cap; SSO behind registration) | **D** only: read and publish the standard MCP Registry API format. It largely duplicates our MCP gateway, so we never embed it | Integrations: MCP servers, "registry source" | Later |
| 10 | NVIDIA/OpenShell | Apache-2.0; pre-1.0 | **B** the first real isolation backend behind PF-06 execution profiles. RegulAIt acts as its policy interceptor (gRPC), and policy changes its prover flags as risky go to our approvals queue. Built without telemetry (`defaults-without-telemetry`) | Agent builder: "Execution profile"; Approvals queue: new kind | Soon (PF-06 spike) |
| 11 | jagmarques/asqav-sdk | Elastic License 2.0; signing happens in its SaaS | **E**. At most, its Apache-2.0 conformance vectors as test inspiration if we ever ship portable per-action receipts (PF-09) | — | Never |
| 12 | GreyDGL/PentestGPT | MIT, with an unpinned git dependency | **E** as an engine: autonomous offensive tool. Its reports may be imported as evidence through the PF-10 pentest register | Red-teaming: imported results | Never as an engine |
| 13 | usestrix/strix | Apache-2.0 code; its default sandbox image bundles mixed-licence and proprietary tooling | **E** for orchestration until an owner ADR on offensive tooling exists. **D** import its SARIF output through PF-15 into the PF-10 register | Red-teaming: imported results (admin-only) | Soon (SARIF import) |
| 14 | guardrails-ai/guardrails | Core Apache-2.0; server ELv2-derived; validators per package | **E** for the framework and server: hosted Hub shut down August 2026, malicious 0.10.1 release May 2026, and it duplicates ADR-0042. At most a single MIT validator inside a PF-11 classifier sidecar, after a benchmark | Guardrails: providers (if ever) | Later at best |
| 15 | NVIDIA-NeMo/Guardrails | Apache-2.0 | **C** vendor its YARA injection rules and jailbreak heuristics into our injection detector. **B** later, an optional PF-11 classifier sidecar running only its non-LLM rails; our engine stays authoritative. We do not adopt Colang | Guardrails: detectors and providers; its test cases go into the red-team attack library | Soon (data), later (sidecar) |
| 16 | trylonai/gateway | BSL 1.1 (becomes Apache-2.0 in 2028); stale | **E** | — | Never |
| 17 | luckyPipewrench/pipelock | Core Apache-2.0; `enterprise/` ELv2; one maintainer | **C** vendor its 67 secret-detection patterns, each with the hosts that legitimately receive that credential, plus its six-pass injection text normalisation. This completes ADR-0176 audit item 2. **B** later, an optional egress-containment sidecar using only the Apache core. We never copy from `enterprise/` | Guardrails: secret detectors (no new UI); later an execution-profile option | **Next** (patterns), later (sidecar) |
| 18 | langfuse/langfuse | MIT, except `ee/` directories under a commercial licence; now owned by ClickHouse, Inc.; has added its own model gateway | **D** keep it as an OTLP export destination with a conformance test, and pull its evaluation scores into measurable conditions (PF-17). Never embedded or bundled in BYOC | Trace export settings (destination); "Open in Langfuse" link on a trace | Next (conformance), soon (score pull) |
| 19 | Arize-ai/phoenix | Server ELv2 with patent notices; client and OTel packages Apache-2.0 | **D** only: customers may point our OTLP export at their own copy. We never bundle or host it | Trace export settings (destination) | Soon (interop test) |
| 20 | Scale3-Labs/langtrace | Server AGPL-3.0; dormant since 2025 | **E**. Agents using its SDK can still reach us through generic OTLP ingest (PF-08) | — | Never |
| 21 | evidentlyai/evidently | Apache-2.0 | **B** an optional Python sidecar for statistical data drift and batch evals over sampled traces. Results feed measurable conditions (PF-17, PF-20). `DO_NOT_TRACK` forced on; its runtime word-list download is pre-baked | Governance alerts and conditions; a hashed report snapshot as evidence | Later (soon if PF-17 needs drift first) |
| 22 | whylabs/whylogs | Apache-2.0; vendor shut down | **E**. If PF-20 needs privacy-preserving data sketches, evaluate Apache DataSketches directly | — | Never |

**Standards that come with these projects (mode D):**
- **OpenTelemetry GenAI semantic conventions** stay our primary trace vocabulary. The conventions moved to
  `open-telemetry/semantic-conventions-genai` and are still at Development stability, so exports pin the version and carry
  a conformance test.
- **OpenInference** (Apache-2.0) becomes an optional export profile. It defines span kinds and cost keys that OTel lacks,
  and Phoenix and langfuse both read it.

The review found six gaps in our current emitter (`packages/shared/src/tracing.ts`):
1. We emit the deprecated `gen_ai.system`. It should be `gen_ai.provider.name`, with the old key kept for a transition
   window.
2. `gen_ai.response.finish_reasons` should be an array, not a string.
3. `gen_ai.response.model` should be the served model; we have it since ADR-0175 A4.
4. `gen_ai.input.messages` and `gen_ai.output.messages` should be structured message parts, not text previews.
5. These keys are missing:
   - `gen_ai.agent.*`;
   - cache-read and cache-write token counts;
   - `gen_ai.conversation.compacted` (pillar 6);
   - `gen_ai.evaluation.*`, which would export ADR-0160 evaluations in standard form;
   - `mcp.*` attributes on MCP tool spans.
6. The code comment "no standard cost key" is true for OTel, not for OpenInference.

### 3. How the features fit the UI without clutter

The owner's concern is that these features fit our UI cleanly. The rule: **no new top-level navigation group for any of
them.** Each project appears in one of only four ways:

1. **An option on a page that already exists:**
   - an engine choice on Red-teaming and Evaluations;
   - a provider on Guardrails;
   - a scanner on Admission review;
   - a destination in trace export;
   - an execution profile in the agent builder.
2. **Results in a record that already exists:**
   - red-team findings and eval runs;
   - governance alerts and measurable conditions;
   - admission findings;
   - approvals-queue items;
   - evidence snapshots.

   The person sees one findings view whatever engine produced the finding. The engine's name and version are shown as
   provenance, and an engine that did not run shows as "not run", never as passed.
3. **Coverage on Compliance packs:** framework mappings (promptfoo, Sentinel, garak tags) appear as coverage on the packs
   we already have, not as separate framework pages.
4. **One new admin page, "Engines" (Integrations group).** It lists every sidecar and vendored content set with:
   - version and image digest;
   - licence;
   - maintainer count;
   - whether its usage-data switches are verified off;
   - health, last run, and timeout;
   - which pages use it.

   This is also the "single connector-health surface" that PathForward already lists as ready but deprioritised. Offensive
   tooling, if an ADR ever allows it, sits in an admin-only, hidden-by-default tab under Red-teaming.

### 4. Next to build, in order

Each step is one batch and one PR. Steps 1–3 need no new ADR beyond this one. Steps 4 onwards each start with a short
contract ADR.

1. **Trace standards fix (mode D, TypeScript only):** close the six emitter gaps, add the OpenInference profile, and add a
   conformance test that checks our OTLP output against the pinned convention version. Langfuse ingest is a test fixture.
2. **Vendored detection content (mode C):**
   - pipelock's secret patterns with their credential-audience hosts, plus its injection normalisation;
   - NeMo's YARA injection rules;
   - the agent-governance-toolkit MCP heuristics.

   All with attribution and pinned commits, and all behind the false-positive policy for the audit path (decided in this
   batch; see Open questions).
3. **New monitor rules ported from Sentinel content (mode C):** MCP-server baseline drift per agent, sharing-scope
   expansion, instruction change after approval, jailbreak correlation.
4. **Sidecar engine contract (new PathForward item PF-23)**, then **promptfoo as its first engine** (PF-10).
5. **Model scanner contract**, then **modelscan** (PF-12).
6. **garak** as the second red-team engine, and the **CyberSecEval** datasets.
7. **OpenShell** isolation spike behind PF-06 execution profiles (needs the PF-06 contract ADR).
8. **The "Engines" admin page**, once two engines exist.
9. **Later:**
   - langfuse score pull (PF-17);
   - Evidently drift sidecar (PF-20);
   - Llama Guard / Prompt Guard as customer-supplied classifiers (PF-11);
   - NeMo classifier sidecar;
   - pipelock egress sidecar;
   - the Sentinel rule pack;
   - the MCP Registry API (obot interop);
   - SARIF import from Strix (PF-15);
   - fickling, only with a licence decision.

## Consequences

- We get broad red-team, scanning, isolation and detection coverage without writing it, while keeping one policy engine,
  one evidence chain and one UI. That is the PathForward thesis, now applied to named projects.
- Every engine adds an operational dependency, most of them Python containers. The sidecar contract (PF-23) carries the
  cost:
  - a pinned image digest;
  - usage data off and egress deny-by-default;
  - a killable timeout;
  - normalised output;
  - `unknown` on error;
  - an SBOM entry (PF-04).
- Air-gapped customers get a reduced engine set, and the product says so. Examples: promptfoo's cloud-only plugins show
  "not run", and garak's online judges are replaced by local ones.
- Project ownership changes (promptfoo to OpenAI, langfuse to ClickHouse) and single-maintainer projects are tracked on the
  Engines page and re-checked yearly.

## Open questions (owner)

1. **fickling (LGPL-3.0):** allow it as a customer-installed scanner by written exception, ask for its commercial licence,
   or skip it?
2. **Offensive tooling (Strix, PentestGPT):** keep these import-only, or write the owner ADR that would allow orchestrating
   them under a scope record and approval?
3. **False-positive policy for vendored detection patterns on the audit path:** redact on match (today's behaviour) or flag
   for review. This is needed before step 2.

## Sources

Research notes with the evidence per project (licence files, release dates, telemetry switches, file paths) were produced
on 2026-10-05 from shallow clones. The verdicts above are the decision record. A project's licence or maintenance status
can change, so each adapter batch re-verifies before adding anything.

# Path Forward: RegulAIt as the AI Security and Governance Control Plane

Date: 2026-09-07  
Local source reviewed: `271bdcadd20d66e4419bde3a08045a6639a18ff5` on
`claude/status-check-2gbrwf`  
External sources reviewed: Microsoft Agent Governance Toolkit and Otto Sulin's
Awesome AI Security list. The Awesome AI Security URL was supplied twice and was reviewed once.

Status: product and architecture recommendation, not implementation authority. It does not
authorize production designation, cloud spend, deployment, publishing, key rotation, or changes
to suite-wide contracts. Any cross-module capability must follow the suite capability map and
suite ADR process before implementation.

## Executive decision

RegulAIt should become a **one-stop control plane for AI security and governance**, not a monolith
that rewrites every scanner, sandbox, safety model, red-team framework, and SIEM. The winning shape
is one inventory, policy experience, approval system, evidence model, and incident workflow that
can orchestrate specialist engines behind versioned adapters.

The highest-value functionality missing from RegulAIt is:

1. exact-action approval binding;
2. cryptographically verifiable agent/workload identity and constrained delegation;
3. agent SRE controls: SLOs, error budgets, circuit breakers, quarantine, and kill switches;
4. real execution isolation, task-scoped credentials, and compensation for reversible actions;
5. portable interception SDKs and framework/A2A adapters;
6. stronger MCP and AI supply-chain assurance, including signed provenance and AI BOMs;
7. pluggable classifier, model-scanning, red-team, and security-operations integrations;
8. a single independently verifiable Decision BOM for every consequential action.

Do not describe the result as complete AI security. No product can govern model reasoning,
prove real-world outcomes, or remove prompt-injection risk by itself. The product promise should
be narrower and stronger: **RegulAIt inventories AI assets, enforces actions, coordinates security
controls, and produces verifiable evidence across the AI lifecycle.**

## What RegulAIt already has

The repository already implements much of the governance control plane. Rebuilding these areas
for superficial parity would add risk rather than enterprise value.

| Area | Current source-backed capability |
|---|---|
| Authorization | Default-deny tool/agent/model/connector access, direct and role grants, subtractive revocations, rate limits, Cedar-backed ABAC, SoD, and one approvals queue in `packages/policy-kernel` and `apps/gateway/src/governed-evaluate.ts`. |
| AI lifecycle governance | Agent inventory and lifecycle, use cases, EU-tier screening, vendor risk, risk register, model cards/MRM, config versioning, canaries, evals, red teaming, and compliance packs. |
| MCP control | A real MCP proxy with entitlement checks, admission scanning, schema drift handling, scheduled rescans, egress controls, project attribution/budgets, PII/guardrails, and a default-deny federated registry. |
| Evidence | Hash-chained audit records, optional runtime-verified S3 Object Lock anchoring, traces/OTLP, data lineage, cost attribution, and compliance evidence queries. |
| Orchestration | Governed DAGs, inherited entitlement and budget ceilings, stage approvals/checks, delegated execution, deployment checks, and rollback paths. |
| Human identity | Password/MFA, OIDC, SAML, SCIM, session revocation, group-to-role mappings, access reviews, and grant certification. |
| Deployment model | Provider-agnostic model/connectors and AWS/Azure/GCP/Kubernetes workload deployment support, plus BYOC and air-gap postures. |

The important distinction is that human authentication is mature while **agent workload identity
is not**. The `agents` owner is explicitly a governance record rather than authentication
(`packages/db/src/schema.ts:1478-1484`), and governed invocations still act under a human
`userId` (`apps/gateway/src/agents-connectors.ts:3250`).

## How to use the Microsoft toolkit

Microsoft's Agent Governance Toolkit (AGT) is useful as a pattern library and interoperability
reference. Its strongest applicable ideas are the Agent Control Specification, workload identity,
SRE primitives, execution containment, MCP supply-chain checks, and portable SDKs. AGT itself is a
public preview and explicitly says it is application-layer middleware, not OS/hardware isolation.
Its limitations also acknowledge that it does not govern reasoning, correlate malicious action
sequences, verify real-world outcomes, govern retrieved knowledge, or guarantee credential cleanup
at task boundaries. RegulAIt should borrow the useful contracts without inheriting the marketing
surface or assuming every feature-matrix checkmark is production proof.

Primary references:

- [AGT README](https://github.com/microsoft/agent-governance-toolkit/blob/main/README.md)
- [Agent Control Specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/policy-engine/spec/SPECIFICATION.md)
- [Agent identity and trust specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/AGENTMESH-IDENTITY-TRUST-1.0.md)
- [Agent SRE specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/AGENT-SRE-GOVERNANCE-1.0.md)
- [Execution-control specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/AGENT-HYPERVISOR-EXECUTION-CONTROL-1.0.md)
- [MCP security specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/MCP-SECURITY-GATEWAY-1.0.md)
- [Audit/compliance specification](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/AUDIT-COMPLIANCE-1.0.md)
- [AGT known limitations](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/LIMITATIONS.md)

## Prioritized capability roadmap

### PF-01 — P0 — Bind approval to the exact action that will execute

**Observed gap.** MCP approval lookup matches user, server, tool, and status
(`apps/gateway/src/governed-evaluate.ts:201-212`). The approval schema records no normalized
argument or action fingerprint (`packages/db/src/schema.ts:1145-1215`). After consuming the row,
the proxy forwards the current arguments (`apps/gateway/src/mcp-proxy.ts:555-572`). This is an
investigation until exercised end to end, but the current schema cannot prove exact-payload
consent.

**Build.** Define a canonical action envelope containing tenant, human principal, authenticated
agent identity, project/run/stage, target, normalized arguments, policy/config versions, expiry,
and any policy transform. Store a SHA-256 identity for both the proposed action and the enforced
action. Show a redacted stable preview to the approver. Recompute the enforced digest immediately
before execution and fail closed on mismatch. Keep reusable grants distinct from single-use
approval.

**Acceptance evidence.** Changed arguments, target, project, policy version, or transform cannot
reuse the approval; concurrent calls consume it once; retries have defined idempotency semantics;
sensitive fields remain redacted while the digest stays verifiable. AGT's ACS explicitly binds
approvals to `enforced_identity`, which is the useful design reference.

### PF-02 — P0 — Add cryptographic agent/workload identity and delegated authority

**Observed gap.** RegulAIt can attribute work to an agent database row, but cannot prove that a
remote worker or peer agent owns that identity. This becomes critical for A2A, remote workers,
BYOC, and multi-tenant MCP.

**Build.** Create provider-neutral workload identities with a stable agent ID, public key or
workload certificate, human/organizational sponsor, allowed capabilities, environment, issuance,
expiry, rotation, and revocation. Support signed challenge-response and replay-resistant message
envelopes. Allow delegation only as a subset of the parent capability and budget. SPIFFE/SVID and
mTLS should be optional interoperability backends, not a Microsoft/Azure dependency.

**Acceptance evidence.** Forged, expired, replayed, revoked, wrong-environment, and over-broad
delegations fail before policy execution. Key rotation preserves audit continuity. Every trace and
Decision BOM distinguishes the human sponsor, invoking workload, and delegated chain.

**Guardrail.** Do not let opaque trust scores grant permissions automatically. Behavioral trust
may raise a risk signal or require stronger approval; explicit entitlements remain authoritative.

### PF-03 — P0 — Build agent SRE, containment, and incident controls

**Observed gap.** RegulAIt has traces and manual run abort, but no source-backed SLO/error-budget
engine, dependency circuit breaker, burn-rate policy, durable alert delivery, or automatic runtime
quarantine. The backlog confirms that OpenTelemetry metrics are absent and escalations notify
nobody (`docs/product/PENDING.md:93-94,433`).

**Build.** Add SLIs for task success, policy-denial rate, unsafe-output rate, tool/provider error
rate, latency, budget anomalies, and approval timeout. Add scoped circuit breakers for agents,
models, providers, connectors, MCP servers, and capabilities. Support operator kill switches at
global/tenant/project/agent/tool scope, with reason, expiry, review, and audited recovery. Feed
OpenTelemetry metrics and existing traces into incident cases.

Roll out in three modes: observe; recommend/manual contain; policy-approved automatic contain.
Automatic quarantine needs an ADR because current access recommendations deliberately avoid
auto-revoke (`docs/product/PENDING.md:432`).

**Acceptance evidence.** Fault injection opens only the intended breaker, rejected calls never
reach the dependency, half-open recovery is bounded, alert storms deduplicate, and restarts do not
erase breaker/incident state. A kill switch cannot be bypassed through direct MCP or delegated
execution.

### PF-04 — P0 — Make the product's own verification and supply chain trustworthy

This is prerequisite work, not a marketable checkbox. The repository still records an intermittent
MCP socket-teardown exception; the current host runs pnpm 11 despite a pnpm 10.33.0 declaration and
rewrites the lockfile while warning that root overrides are ignored. `docs/product/PENDING.md:32`
also records deferred SAST/SCA/secret scanning, pen testing, WAF/DDoS, and HSM/FIPS work.

**Build.** Establish one pinned, clean-checkout verification command; eliminate nondeterministic
test exits; add CodeQL or equivalent SAST, secret scanning, dependency and container scanning,
Dependabot/Renovate-style update review, generated SBOM, signed provenance, and a release policy
that distinguishes source-tested, integration-tested, live-verified, and externally assessed.

**Acceptance evidence.** The gate fails on an injected assertion failure, unhandled exception,
known vulnerable fixture, leaked synthetic secret, and unsigned artifact; it leaves the checkout
clean and emits machine-readable evidence.

### PF-05 — P1 — Generalize policy intervention points and safe transforms

The policy kernel exposes only `allow`, `deny`, and `require_approval`
(`packages/policy-kernel/src/index.ts:2`). Add a typed policy envelope covering agent/session
startup, input, pre/post model, pre/post tool, output, delegation, and shutdown. Add `warn` and a
bounded `transform`/`sanitize` decision that may rewrite only the declared policy target.

The transformed action must receive a new enforced-action digest and must be the version approved
and audited. A transform failure or attempt to mutate identity/host state fails closed. Existing
PII withholding and scrubbers should become providers of this contract rather than parallel
authorization systems.

### PF-06 — P1 — Add real isolation, task-scoped credentials, and compensation

Do not call an in-process permission check a sandbox. Define execution profiles that select a
real backend: container, gVisor/Kata, microVM, or customer-provided isolation. Profiles should
control filesystem, network destinations, process execution, CPU/memory/time, secrets, and
cross-session persistence. Unknown or low-assurance agents start in the most restricted profile.

Add per-user upstream authorization brokering (OAuth 3LO/OBO and managed PAT/API-token vault),
which is currently absent (`docs/product/PENDING.md:429`). Mint task-scoped, short-lived
credentials and revoke them on task completion or containment.

For mutating tools, register reversibility, undo window, idempotency key, compensation handler,
and post-action validator. Orchestrate multi-step changes as sagas and compensate completed steps
in reverse order when policy permits. Human approval remains mandatory for irreversible recovery.

Candidate isolation backends should be integrated behind a contract, not vendored wholesale;
the Awesome list identifies projects such as
[OpenSandbox](https://github.com/alibaba/OpenSandbox),
[OpenShell](https://github.com/NVIDIA/OpenShell), and
[microsandbox](https://github.com/zerocore-ai/microsandbox).

### PF-07 — P1 — Harden MCP and agent supply-chain admission

RegulAIt already scans descriptions/schemas and holds changed manifests. The remaining useful
delta is ecosystem identity and richer change analysis. ADR-0101 explicitly states that publisher
identity is unverified and name-squatting/typosquatting cannot be detected from a registry listing
(`docs/decisions/0101-federated-mcp-registry.md:214-217`).

**Build.** Add Unicode confusable normalization; cross-server tool-name collision and typosquat
analysis; per-tool description/schema fingerprints; signed publisher/package provenance;
version/digest pinning; dependency/CVE metadata; suspicious exfiltration URL scanning in tool
results; response modes `block`, `sanitize`, and `log`; and a quarantine/diff review that explains
exactly what changed. Compare names against the customer's approved registry and aliases, not a
small hard-coded list.

Also add A2A agent-card scanning and governed Skills as versioned assets. Both are currently absent
(`docs/product/PENDING.md:430-431`). Registration or discovery must never create an entitlement.

### PF-08 — P1 — Ship portable enforcement SDKs and adapters

AGT's practical advantage is distribution: its governance primitives can sit inside application
frameworks rather than relying only on traffic that reaches a central gateway. RegulAIt has a
private TypeScript API client, but no source-backed LangGraph, LangChain, CrewAI, Semantic Kernel,
Microsoft Agent Framework, OpenAI Agents SDK, Google ADK, or LlamaIndex middleware.

Define one versioned wire contract first, then build thin SDKs in TypeScript and Python. Add .NET,
Go, and Java only when customers require them. Adapters must send canonical action envelopes to
the central decision service, fail closed according to declared policy, support offline/BYOC
policy bundles where approved, and emit the same evidence schema. Do not implement five divergent
policy engines.

Include inbound/outbound A2A task and artifact mapping only after the identity and delegation
contract exists. Add a virtual MCP composition endpoint only if entitlement filtering, alias
collisions, streaming behavior, and evidence attribution are solved; the current one-server
binding is documented at `docs/product/PENDING.md:428`.

### PF-09 — P1 — Create a Decision BOM and an AI BOM

RegulAIt has stronger audit immutability than an ordinary in-process Merkle log, but evidence is
spread across audit, trace, config, lineage, approval, cost, and deployment records.

**Decision BOM.** Export one signed/verifiable bundle per consequential decision containing human
and workload identity, delegation chain, exact action digests, policy/config versions, evaluated
rules, approval, inputs by hash/classification, target, result status, post-action verification,
cost, trace, audit-chain proof, and WORM-anchor proof. Verification must work offline.

**AI BOM.** Inventory models, weights/artifacts, datasets, prompts, embeddings/vector stores,
agents, skills, tools, MCP/A2A endpoints, providers, libraries, licenses, owners, versions, hashes,
relationships, deployment locations, and scan attestations. Generate standards-compatible exports
rather than inventing a closed format. The Awesome list points to
[OWASP AIBOM](https://github.com/OWASP/www-project-aibom) and
[datasig](https://github.com/trailofbits/datasig) as ecosystem references.

### PF-10 — P2 — Orchestrate specialist red-team and evaluation engines

RegulAIt already has internal eval and red-team workflows. Make them an orchestration and evidence
surface for external engines rather than copying hundreds of probes.

Start with allowlisted adapters for [Promptfoo](https://github.com/promptfoo/promptfoo),
[PyRIT](https://github.com/microsoft/PyRIT), and optionally
[garak](https://github.com/NVIDIA/garak). Normalize target, test taxonomy, seed/corpus provenance,
attack technique, attempts, successes, ASR, severity, model/provider version, spend, and raw-result
location. Run only inside explicit scope and budget; mutating/offensive tests require approval.
Version and license every corpus. Never silently ingest leaked prompts, jailbreak collections, or
unknown-license material merely because an awesome list links it.

**Acceptance evidence.** Identical imported results map deterministically, failed scanners are not
reported as clean, repeated trials expose variance, and compliance gates distinguish a live run
from imported or repository-reported evidence.

### PF-11 — P2 — Add pluggable classifier and multimodal guardrail providers

The current detectors are intentionally heuristic; model/external tiers are unwired
(`docs/product/PENDING.md:44`). Add a provider interface for prompt injection, jailbreak, harmful
content, PII/secrets, exfiltration, unsafe code, image safety, and RAG poisoning. Support local
classifiers and external services with per-tenant policy, latency/cost budgets, residency,
fallback, confidence calibration, and versioned thresholds.

Candidates from the Awesome list include Llama Prompt Guard, Llama Guard, ShieldGemma,
Shieldstral, and specialized prompt-injection classifiers. Treat model-card performance as a claim
until benchmarked on RegulAIt's own multilingual and domain-specific corpus. A classifier error
must produce `unknown/error`, never a clean finding.

### PF-12 — P2 — Gate model, dataset, prompt, and artifact admission

Apply the existing MCP admission pattern to every executable or influential AI artifact.

- Scan model serialization formats before loading, using an adapter such as
  [ModelScan](https://github.com/protectai/modelscan); add Pickle-specific scanning where relevant.
- Hash and sign models, datasets, prompts, adapters, and policy bundles; verify provenance and
  license; record storage origin and reviewer.
- Add dataset poisoning/anomaly checks, sensitive-data sampling, consent/retention evidence, and
  train/eval contamination checks.
- Add vector-store and RAG-source authorization, freshness, classification, and provenance checks.
- Quarantine on material version/hash change; never auto-promote a scan result into access.

This belongs behind a scanner contract because model training/runtime ownership may sit in the
LLM module under suite rules. Governed should own admission policy and evidence unless a suite ADR
assigns implementation differently.

### PF-13 — P2 — Build a versioned AI security control graph

Adopt [OWASP AISVS](https://github.com/OWASP/AISVS) as a testable technical-control catalog while
retaining NIST AI RMF, ISO/IEC 42001, EU AI Act, OWASP LLM/Agentic Top 10, MITRE ATLAS, and customer
framework mappings. AISVS 1.0 organizes requirements across training data, input validation,
model lifecycle, infrastructure, identity, supply chain, model behavior, memory/vector stores,
agentic orchestration, MCP, adversarial robustness, and monitoring.

Each control mapping must carry framework/version/control ID, applicability, implementation
status, evidence query, last verified time, verifier, exceptions, compensating controls, and
freshness. Crosswalks are mappings, not equivalence proofs. Imported content must retain license
and provenance, and control identifiers must follow the suite-wide contract.

### PF-14 — P2 — Add AI detection, response, and sequence-aware policy

Use the existing audit/trace/lineage data to create an AI security operations view: normalized
detections, cases, evidence timelines, affected identities/assets, containment actions, owner,
SLA, status, and export to SIEM/SOAR. Add detection-as-code with versioned rules and replay against
historical traces.

Sequence analytics should flag individually allowed actions that form a risky chain—for example,
read sensitive data followed by sending it to a public sink—across agents and sessions. Start in
observe mode, require human review, and measure precision before blocking. AGT itself lists this as
a future limitation, so it is not an AGT parity item; it is a shared industry gap RegulAIt can
differentiate on.

Add post-action validators that classify outcomes as `verified_success`, `verified_failure`, or
`unknown`. An HTTP 200 or a tool's self-report is not proof that the intended world state exists.

### Additions from the October 2026 document study (ADR-0175)

The owner shared six documents: the NIST AI RMF 1.0 (AI 100-1), an identity-governance vendor's
agent ebook, an AI application security-posture whitepaper, a code-security platform's
self-description, and two product teardowns (a scanner-to-controls platform and an AI observability
platform). What could be built now is in ADR-0175. What follows extends the items above or adds new
ones. Vendor marketing figures were not imported as facts or targets.

**Extensions to existing items**

| Item | Addition | Why later / prerequisite |
|---|---|---|
| PF-02 | Agents authenticate as themselves, with agent identity on every agent-to-agent and MCP hop; co-stewards / multiple owners per agent | Workload-identity RFC and suite contract (immediate package item 5) |
| PF-03 | Automatic shut-off on thresholds for public-facing AI (trip, not only propose; ADR-0175 ships the propose-only slice) | ADR on auto-containment, SLO metrics |
| PF-04 | Our own SAST/SCA/secret/container scanning, SBOM and signed provenance; every scanner pinned by digest with signatures verified (a widely used open-source scanner had malicious releases published with a stolen credential in March 2026) | CI tool choices; settle the pnpm version mismatch first |
| PF-06 | Per-user OAuth brokering binds the token endpoint to validated authorization-server metadata and the egress allow-list, with an adversarial test for a server advertising a foreign token endpoint | PF-06 not started |
| PF-07 | Agent-to-agent interaction monitoring, typosquat/confusable detection, publisher provenance (ADR-0175's release-age cooldown and skill admission are the first slices) | Identity contract |
| PF-08 | OpenTelemetry ingest of external agent traces with framework adapters, so external agents join the same trace and evidence spine | Wire contract |
| PF-09 | AI BOM including training-data sources and per-model data flow; inventory of AI tools in the development stack | Standard choice (OWASP AIBOM / CycloneDX ML) |
| PF-10 | Import external pentest and AI-pentest results as a register (retests, finding → control mapping, next-test schedule) that can satisfy required test classes | Adapter contract, licence review |
| PF-11 | Evaluator models run inside the customer environment; per-entity confidence; custom entity types; a PHI pack; judge verdicts that carry their reasoning | Model hosting / provider adapters, benchmark corpus |
| PF-12 | Data-poisoning controls, consent evidence for training data, a sensitivity inventory for inference and fine-tuning datasets | Scanner contract; suite ownership of LLM modules |
| PF-13 | Packs for GDPR, SR 11-7, the NAIC AI model bulletin, NIST SP 800-218A, and the OWASP LLM / agentic Top 10 as a test taxonomy; a per-use-case crosswalk board | Curated content with per-control provenance; suite control-ID contract |
| PF-14 | Reason-coded triage and grouping of detections, SIEM push (ADR-0135), identity-aware investigation, case management beyond the incident register | Detection engine, SIEM delivery gates |

### PF-15 — P2 — Findings ingest and control engine

Scanner-agnostic ingest (SARIF 2.1.0, OSCAL assessment results, a generic signed webhook) →
fingerprinted findings → reason-coded triage (never auto-ignore a known-exploited issue; dev-only;
low exploit probability; not reachable) → mapped to controls, with coverage and passing reported
separately and time-boxed risk exceptions. *Prerequisite:* a `CAPABILITY_MAP.md` check (general GRC or
scanner aggregation may belong to another suite module) and a normalized finding-schema contract.

### PF-16 — P2 — Trust outputs

A customer-facing report builder over frozen, hashed evidence snapshots: request link with NDA,
approver-released expiring signed links, and SLA breaches shown honestly. *Prerequisite:* this is a
public, unauthenticated surface, so it needs legal review, abuse controls and a hosting decision; any
production designation needs the owner's explicit sign-off.

### PF-17 — P2 — Runtime evidence connectors

Pull evaluator metrics (hallucination, PII flags, jailbreak rate, drift, fairness) from external
observability and evaluation platforms, or from raw OpenTelemetry, into measurable conditions.
Export guardrail policy derived from intake to external guardrail runtimes. *Prerequisite:* partner
APIs and credentials, a connector-health surface, and per-connector egress rules.

### PF-18 — P3 — Developer-environment AI visibility

Import usage from coding-assistant admin consoles; an endpoint policy for packages, extensions and
AI tools with an approval queue and an exportable log; visibility into local file reads by coding
agents. *Prerequisite:* partner admin APIs; an endpoint agent is a new trust boundary with OS
packaging.

### PF-19 — P3 — AI application code risk

OWASP-LLM-aware scanning of customer application code, agent infrastructure-as-code scanning, and an
AI change-impact review per pull request in the workflow engine's check stage. *Prerequisite:*
integrate scanners through PF-15, do not build them.

### PF-20 — P3 — Predictive-ML monitoring

Segment-level drift, data-integrity checks, feature attribution and disparate impact for classic ML
models. *Prerequisite:* model telemetry and connectors, mostly through PF-17.

### PF-21 — P2 — Access-path graph

A per-person view: human → agents → tools and connectors → data classes, built from grants, the
dependency graph (ADR-0156) and observed lineage (ADR-0059), with blast radius from a person or a
credential. Buildable now but UI-heavy; scheduled after the current batches.

### PF-22 — P2 — Governance MCP server

Expose read-mostly governance tools (open risks, control status, use-case status, request an
exception, attach evidence) to coding agents, each call governed like any other MCP call.
*Prerequisite:* a `CAPABILITY_MAP.md` check (the suite may own a shared MCP surface) and an
entitlement model for a self-hosted server.

**Ready but deprioritised** (candidates for the next batch): OSCAL export of pack evaluations;
DPIA / FRIA impact assessments prefilled from intake, lineage and the model card (needs legal content
review); a single connector-health surface; near-duplicate use-case detection at intake.

**Out of scope:** cross-tenant benchmarks (ADR-0041 is single-tenant); rebuilding observability
backends, scanners or evaluator models (integrate instead); product tours and videos.

## What to build, integrate, and defer

| Treatment | Capabilities |
|---|---|
| Build natively | Canonical action envelope; exact-action approvals; identity/delegation registry; policy decision contract; circuit-breaker/kill-switch control plane; MCP fingerprints/quarantine; Decision BOM; control/evidence graph; normalized security finding and incident schemas. |
| Integrate behind adapters | Sandboxes; red-team/eval tools; safety classifiers; model/artifact scanners; dataset scanners; SIEM/SOAR; OTel backends; SPIFFE/mTLS issuers; A2A frameworks; external secret vaults; privacy/confidential-computing runtimes. |
| Defer or reject by default | Autonomous offensive exploitation; unsandboxed third-party scanners; opaque trust scores that grant access; automatic remediation without reversibility and approval; hosting every security model; ingesting unknown-license or leaked data; duplicating policy engines per SDK; claiming a software “hypervisor” without a real isolation boundary. |

The [Awesome AI Security list](https://github.com/ottosulin/awesome-ai-security/blob/main/README.md)
is a discovery index, not a security, maturity, maintenance, or license attestation. Every adapter
candidate needs a recorded license, maintainer/activity assessment, signed-version/digest policy,
SBOM, vulnerability review, sandbox profile, data-egress disclosure, and a killable timeout.

## Delivery sequence

### Wave 0 — Make evidence trustworthy

Close the flaky test exit, pin the package manager, add the product's own security CI gates, and
publish the normalized action/finding/evidence schemas. Exit only when a clean checkout produces a
clean, reproducible, machine-readable result.

### Wave 1 — Trusted actions

Deliver exact-action approval binding, workload identity, constrained delegation, circuit
breakers, kill switches, and Decision BOM v1. Exit only when forged/replayed identities and
changed approved actions fail before upstream contact across direct and delegated paths.

### Wave 2 — Supply-chain and isolation

Deliver MCP publisher/tool fingerprints, artifact admission, task-scoped credentials, sandbox
profiles, compensation metadata, and AI BOM v1. Exit only when changed or unsafe artifacts are
quarantined without granting access, and isolation is verified at the actual OS/runtime boundary.

### Wave 3 — Ecosystem coverage

Deliver TypeScript/Python SDKs, initial framework adapters, classifier adapters, model scanning,
and Promptfoo/PyRIT import/run adapters. Exit only when all routes emit the same decision and
evidence contracts and failed tools cannot be mistaken for clean results.

### Wave 4 — Security operations and enterprise deployment

Deliver metrics/SLO dashboards, durable notifications and jobs, incident cases, detection replay,
sequence analytics, SIEM/SOAR export, Helm/HA/backup-restore proof, and an optional HSM/FIPS path.
Exit only after failure recovery, upgrade, restore, isolation, and external security testing are
evidenced. Production designation still requires explicit owner sign-off.

## Definition of done for every new capability

A feature is not done until it has:

1. a named threat, trust boundary, owner, and suite-duplication decision;
2. a versioned input/output contract and explicit failure semantics;
3. default-deny or clearly disclosed observe-only behavior;
4. adversarial tests proving denied work never reaches the protected upstream;
5. a non-vacuity test showing removal of the control makes the suite fail;
6. concurrency, retry, idempotency, timeout, restart, and revocation tests;
7. redaction, retention, residency, and tenant-isolation tests;
8. audit, trace, cost, evidence, and UI treatment for allow/deny/error/unknown;
9. BYOC and air-gap behavior, including what is unavailable offline;
10. exact verification commands and results, with repository-reported evidence labeled as such;
11. operator documentation and honest limitations;
12. no “enterprise-ready,” “complete,” “certified,” or “production-ready” claim without fresh
    executable and, where appropriate, independent evidence.

## Immediate implementation package

The first engineering package should be narrow enough to review as one governance-boundary
change:

1. write an ADR for the canonical action envelope and approval consent contract;
2. add proposed/enforced action digests, expiry, context, and idempotency fields to tool approvals;
3. bind MCP approval consumption to the enforced digest and add changed-argument/project/policy
   adversarial tests with zero-upstream counters;
4. publish the first Decision BOM schema using that same envelope;
5. separately draft suite-level RFCs for workload identity and the scanner/adapter contract;
6. do not begin SDK, A2A, sandbox, or trust-score work until those contracts are accepted.

This sequence closes a concrete authorization ambiguity first and creates the shared primitive
that identity, SDKs, incident response, and evidence export will all need.


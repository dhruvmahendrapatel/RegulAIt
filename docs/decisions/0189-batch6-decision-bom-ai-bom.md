# ADR-0189: Batch 6 item 2 — Decision BOM and AI BOM (PF-09)

- **Status:** Accepted (owner, 2026-10-10)
- **Date:** 2026-10-10
- **Deciders:** owner (the eleven OWNER DECISION items below); the rest follows ADR-0180 (secure by default) and ADR-0176
  (open source first)
- **Builds on:** ADR-0183 §1 batch 6 item 2 (DELIVERY_PLAN_2026-10-06 §Batch 6: "Decision BOM and AI BOM v1 (PF-09,
  CycloneDX ML), including training-data sources and per-model data flow"), PathForward **PF-09** (and its extension
  rows), ENTERPRISE_READINESS_PLAN **C3**, ROADMAP §7.1 row 12 and §7.2 **I5**, ADR-0060 (`canonicalJson`, WORM
  anchoring), ADR-0067 (hash-chained audit), ADR-0082 (granted vs observed inventory), ADR-0104 (approval argument
  digest), ADR-0116 (signed offline-verifiable export bundle), ADR-0177 amendment items 2 and 3, ADR-0182 (decision
  records of use-case sign-off), ADR-0184 (our own CycloneDX SBOMs), ADR-0186 R and S (signed receipts, RFC 3161
  anchor timestamps), ADR-0187 (engines, `engine_scan` evidence), **ADR-0188** (sponsor, actor chain, delegation
  grants, audit v2)
- **Sequencing:** built only after ADR-0188's identity slices S1 to S4 have merged (the in-process actor chain and the
  audit v2 cutover). Slices B0, B1 (schema only) and B3 can start earlier because they touch no ADR-0188 file; see the
  slice table.

## Context

### What is asked

- **PF-09** (PathForward.md §PF-09): evidence is "spread across audit, trace, config, lineage, approval, cost, and
  deployment records".
  - **Decision BOM:** "one signed/verifiable bundle per consequential decision containing human and workload identity,
    delegation chain, exact action digests, policy/config versions, evaluated rules, approval, inputs by
    hash/classification, target, result status, post-action verification, cost, trace, audit-chain proof, and
    WORM-anchor proof. Verification must work offline."
  - **AI BOM:** "models, weights/artifacts, datasets, prompts, embeddings/vector stores, agents, skills, tools,
    MCP/A2A endpoints, providers, libraries, licenses, owners, versions, hashes, relationships, deployment locations,
    and scan attestations. Generate standards-compatible exports rather than inventing a closed format."
  - PathForward's later-items table adds "training-data sources and per-model data flow; inventory of AI tools in the
    development stack", with the prerequisite "Standard choice (OWASP AIBOM / CycloneDX ML)".
  - PathForward's immediate package item 4: "publish the first Decision BOM schema using that same envelope" (the
    PF-01 action envelope).
- **PF-02 acceptance** (PathForward.md §PF-02, carried into ADR-0188): "Every trace and Decision BOM distinguishes the
  human sponsor, invoking workload, and delegated chain."
- **ENTERPRISE_READINESS_PLAN** §1: PF-09 "OPEN, ingredients present … not exportable as one verifiable per-decision
  bundle"; C3: "Ingredients exist; this is assembly + offline verification."
- **ROADMAP §7.1 row 12:** "No SBOM or AI-BOM". ADR-0184 closed the SBOM half for our own build; the AI BOM half is
  open.

### What exists on `main` @ 3119813 (read for this ADR)

**Decision evidence.**
- **Audit chain:** `audit_log` (`packages/db/src/schema.ts:973`), SHA-256 linked per ADR-0067; anchors in
  `audit_anchors` (`schema.ts:1497`) with WORM destination, `external_ref` and the ADR-0186 S RFC 3161 fields
  (`tsa_token`, `tsa_gen_time`, `tsa_message_imprint`, ...).
- **Decision receipts** are built (ADR-0188 described them as a stub at `320dfe1`; they have since landed):
  `apps/gateway/src/decision-receipts.ts` signs, in one sweep, every audit row whose `objectType` is in
  `RECEIPT_OBJECT_TYPES` (`mcp_tool`, `agent`, `connector`, `approval`; `packages/shared/src/batch4.ts:99`) and whose
  `detail.receiptClass` is `decision` (written by the governed paths, e.g. `mcp-proxy.ts:506`). Payload
  `regulait.receipt.v1` (`batch4.ts:111`), Ed25519 from `REGULAIT_RECEIPT_SIGNING_KEY`, public keys in
  `receipt_signing_keys`, rows in `decision_receipts` (`schema.ts:11710`). Routes `/v1/receipts`, `/status`, `/keys`,
  `/export`, `/verify`, `/:auditId` (`decision-receipts.ts:100-144`); the pure verifier is
  `packages/shared/src/receipts/verify.ts`, the CLI `scripts/verify-receipts.mjs`. The payload deliberately carries no
  reason or detail text.
- **Signed export bundle** (ADR-0116, `apps/gateway/src/export-bundle.ts`): `manifest.json` in `canonicalJson`,
  `manifest.json.sig` (Ed25519 from `REGULAIT_EXPORT_SIGNING_KEY`), `content/`, `audit/chain.tsv`,
  `audit/rows/<seq>.payload`, a convenience public key that is never the trust root, and `README.txt`.
  `scripts/verify-export-bundle.sh` refuses to run without an out-of-band `--fingerprint` or `--keyring`. No key
  means no bundle (409). Schemas `regulait.export-bundle/1` and `/2`.
- **Approval digests:** `approvals.arguments_digest` and `context_digest` (`schema.ts:1650`); the governed evaluation
  path computes `argumentsDigest` (`apps/gateway/src/governed-evaluate.ts:98`, `:466`, `:576`). Whether that digest is
  persisted for every receipt-eligible decision, not only approval-routed ones, was **not verified** for this ADR;
  slice B2 records it as a fact either way.
- **Approval signatures:** `approval_decisions` (passkey-signed payload, `signed_digest`, step-up method; ADR-0186 B).
- **Versions behind a decision:** `governance_policy_epoch` (`schema.ts:4717`), `abac_policy_versions` (`:4739`,
  with `schema_version`), `config_versions` (`:5736`, artifact versions with canary), `usage_events.config_version_id`
  and `agent_config_version_id` (`:2867`), and ADR-0182's per-sign-off decision records for use cases
  (`DecisionRecordTab.tsx`).
- **Cost and trace:** `usage_events` (provider, model, served model, tokens, `cost_usd`), `trace_spans` (`:8618`,
  linked to `audit_log_id` and `usage_event_id`).
- **Identity after ADR-0188:** `audit_log.actor_identity_id`, `delegation_grant_id`, `actor_chain` (ADR-0188 decision 9,
  inside the v2 content hash per decision 19), `delegation_grants` (decisions 4, 12, 22), `issued_tokens` (decision 12),
  `workload_identities` and `workload_credentials` (decision 2). None of these exist on `main` yet.

**AI inventory.**
- **Models:** `agents` (`schema.ts:2062`: `provider`, `model`, `expected_served_model`, `custom_provider_id`, tier,
  owner, lifecycle, halt) and `custom_model_providers`; `model_cards` (`:5243`: `intended_use`, `data_claims`,
  `limitations`, `bias_fairness`, `standard_refs`, `pinned_model_version`) with `model_card_approvals` and
  `model_card_evidence` (`:5351`, kinds `eval_run | external | engine_scan`, `MODEL_CARD_EVIDENCE_KINDS`
  `schema.ts:5223`; `engine_scan` requires an `artifact_scan_id`, `packages/shared/src/mrm.ts:116-127`).
- **Weights and scans:** `model_artifacts` (`:11843`, `sha256`, `format`, `size_bytes`) and `artifact_scans`
  (`:12036`, `artifact_sha256`, `verdict`, `issues`, `scanner_version`), produced by ADR-0187 engine runs
  (`engine_runs`, `engines` with `image_digest`, `licence`, `maintainer_count`).
- **Datasets:** `training_datasets` (`:7897`, `version`, `checksum`, `row_count`, `pii_verdict`, `pii_mode`),
  `training_jobs` and `training_artifacts` (`:8043`, `base_model`, `agent_id`, `model_card_id`); `eval_datasets`
  (`:4949`) with versions and `eval_runs` (`system_prompt_hash`, `config_hash`).
- **Prompts:** `prompts` and `prompt_commits` (`:4508`, `:4545`: content-addressed `hash`, `parent_hash`,
  `model_config`, `tools`), `prompt_promotions` (`binding_digest`); `apps/gateway/src/prompt-registry.ts`.
- **Tools and endpoints:** `mcp_servers` (`:683`: `admission_manifest_digest`, `release_digest`, `registry_version`,
  `stdio_command_digest`, transport, owner), `mcp_tools` (`:900`), `connectors`; builder agents and skills
  (`builder_agents` `:9746`, `builder_skills` `:9859` with `content_digest`, `admitted_digest`, admission state).
- **Use cases:** `ai_use_cases` (`schema.ts:8730`: owner, `intended_agent_ids`, `data_sensitivity`, compliance tags,
  `eu_ai_act_tier`, status).
- **Relationships:** the ADR-0082 inventory (`apps/gateway/src/inventory.ts`; `/v1/inventory/agents`,
  `/v1/inventory/agents/:agentId`, `/v1/inventory/memory-stores`) keeps **granted** and **observed** apart; lineage
  (`lineage_nodes`, `lineage_edges`, `apps/gateway/src/lineage.ts`).
- **Our own SBOM:** ADR-0184's `security.yml` job writes CycloneDX SBOMs of the workspace and the image with Trivy
  (`sbom-workspace.cdx.json`, `sbom-image.cdx.json`) and keeps them as CI artifacts; nothing in the product links to
  them.

No BOM table, route or library exists today (searched `schema.ts` table names and `apps/gateway/src` file names for
`bom`; the tables listed above were read at the line numbers given).

**Numbers.** Latest migration on `main` is `0176_model_artifact_quotas_retention`; ADR-0188 takes the next numbers.
This ADR's migration is a placeholder, **`0181+`**, taken at build time with the journal `when` rule of
CONTRIBUTING_PARALLEL_SESSIONS §4.

### Standards surveyed (2026-10-10)

| Standard | What it gives us | Status checked | Fit |
|---|---|---|---|
| **CycloneDX 1.7** (cyclonedx.org specification overview, read 2026-10-10) | One object model for components (`machine-learning-model`, `data`, `container`, `file`, ...), services with endpoints, trust zones and **data flows with classification and direction**, dependencies, compositions (completeness), `modelCard` on a model component (model parameters, datasets, quantitative analysis, considerations), `data` on a data component (classification, governance, sensitive data), formulation, declarations/attestations (CDXA), BOM-Link, and JSF signatures | Current version 1.7, released 2025-10-21; standardised by Ecma TC54 as ECMA-424 (the overview lists a publication date of 2025-12-10). ML-BOM capability page read | **AI BOM primary export.** Data flows answer PF-09's "per-model data flow"; compositions let us say "incomplete" instead of implying completeness |
| **CycloneDX 1.6** | The same ML-BOM fields (`modelCard`, `data`, declarations) | Previous version; the bundled 1.6 schema validates it | Downgrade export for consumers that do not yet read 1.7 (OWNER DECISION 6) |
| **SPDX 3.0.1** AI and Dataset profiles (spdx.github.io/spdx-spec/v3.0.1, read 2026-10-10) | `AIPackage` (autonomyType, domain, energyConsumption, hyperparameter, informationAboutTraining, limitation, metric, modelDataPreprocessing, safetyRiskAssessment, standardCompliance, typeOfModel, useSensitivePersonalInformation, ...); `DatasetPackage` (confidentialityLevel, dataCollectionProcess, datasetAvailability, datasetType, hasSensitivePersonalInformation, intendedUse, knownBias, ...). Profile conformance requires a `hasConcludedLicense` and a `hasDeclaredLicense` relationship per `AIPackage` | 3.0.1 is the version spdx.dev lists as current; JSON-LD with an official JSON schema generated by shacl2code (`spdx.org/schema/3.0.1/spdx-json-schema.json`, draft 2020-12) | **Second AI BOM export** (OWNER DECISION 7). Licence relationships are mandatory, so unknown licences must be stated as such, never omitted |
| **OWASP AIBOM** project | Field guidance for AI BOMs on top of CycloneDX | PathForward names it; its repository page was **not read** (a fetch of the repository host was refused by this session's sandbox rule for commands naming that host, and was not routed around) | Align field choices in B0; open question 6 |
| **in-toto attestation framework / DSSE** | A typed Statement (`subject` digests + `predicateType` + `predicate`) in a signed envelope with pre-authentication encoding | Known standard; not re-read this session | Optional interoperability wrapper for the Decision BOM (OWNER DECISION 1), not the authority |
| **"Decision BOM"** | — | No standard or specification defines the term. A web search (2026-10-10) found research proposals describing a minimum action-evidence bundle for state-changing agent actions (arXiv 2604.19818) and a risk-scoping bill of materials for agentic systems meant to sit beside SBOM and AI-BOM standards (arXiv 2606.21877), and product material describing per-action evidence bundles and chained decision receipts. Seen as search abstracts only, not read in full | Market practice converges on: identity, authorisation, inputs by digest, outcome, and an integrity proof per action, exported as a signed bundle. We define our own schema (decision 2) and link it to the standard AI BOM |

One search tool failed for lack of account credits; another was used. Nothing blocked was worked around.

### Libraries surveyed (ADR-0176)

| Package | Licence | Last release | Air-gapped | Finding |
|---|---|---|---|---|
| **`@cyclonedx/cyclonedx-library`** 10.3.0 | Apache-2.0 | 2026-09-17 (maintained by the CycloneDX project, five npm maintainers) | Yes: schemas for 1.0 to 1.7 ship in `res/schema/` and are loaded from disk; no runtime network | **Bundles the official 1.7 and 1.6 JSON schemas and the spec enums.** Its object model does **not** represent what an AI BOM needs: `Component` (`src/models/component.ts`, fields read in the 10.3.0 tarball) has no `modelCard` and no `data`; `Bom` (`src/models/bom.ts`) has no `formulation`, `declarations` or `definitions`; `modelCard` appears only as an external-reference type. Its JSON validator requires the optional peer `ajv-formats-draft2019` |
| `ajv` 8.20.0, `ajv-formats` 3.0.1 | MIT | already exact-pinned in `apps/gateway/package.json` | Yes | Validate CycloneDX (draft-07) and SPDX 3.0.1 (draft 2020-12 via `Ajv2020`) offline |
| `ajv-formats-draft2019` 1.6.1 | MIT | 2022-04-11 | Yes | **Fails "maintained"** (no release in 12 months). The library uses it for the `idn-email` format only (`src/_optPlug.node/__jsonValidators/ajv.ts:25,54`). Not admitted; we compile the bundled schemas with our own Ajv and define `idn-email` as a format that rejects every value, because a BOM of ours never carries an email (decision 7) |
| `canonicalize` 5.1.0 | Apache-2.0 | 2026-09-18, already admitted (ADR-0186) | Yes | RFC 8785 bytes for every signed BOM body, subject to extending the ADR-0186 byte-identity corpus to BOM shapes (B0) |
| `pkijs` 3.4.1, `asn1js` 3.0.10 | BSD-3-Clause | already pinned (ADR-0186 S) | Yes | Re-verify the RFC 3161 token inside an exported Decision BOM offline |
| `@spdx/tools` 0.1.0 | MIT | 2023-12-18 | — | **Fails "maintained"**; not admitted. No maintained JS/TS SPDX 3 model was found on npm (searched "spdx 3", "spdx3", "spdx-3", "spdx model", "shacl2code", "spdx 3.0 jsonld") |
| `rdf-validate-shacl` 0.6.5 | MIT | 2025-05-30 | Yes | **Fails "maintained"** (16 months); not admitted for runtime SHACL validation |
| `spdx3-validate` 0.0.7 (PyPI) | MIT | 2026-08-10 | **No as shipped** (its CLI fetches the schema, model and context; amendment 4 after spike B0). Yes through the offline driver with vendored files | **CI only, not shipped:** full SHACL conformance of our SPDX output against the official model, pinned in a CI job like ADR-0184's tools, run only through the offline driver (amendments 4 and R13) |
| Two npm packages published in 2026 under AI-BOM names | Apache-2.0 | 2026-03 and 2026-09 | — | Single maintainer each; both scan source repositories for AI usage, which is not our problem (we already hold the inventory). Not admitted |
| `@cyclonedx/cdxgen` 12.8.5 | Apache-2.0 | 2026-09-29 | — | A repository/SBOM generator CLI; it does not read our database. Not needed: ADR-0184's Trivy already produces our software SBOMs |

**What we write ourselves, and the ADR-0176 §4 exception.** Building the BOM from our tables is RegulAIt-specific
(governance facts, evidence format) and is ours by ADR-0176 §4. Emitting the CycloneDX `modelCard`, `data`,
`declarations` and service data-flow objects is a solved-format problem, but **no maintained JS module can emit
them**: the one maintained CycloneDX library's model lacks those fields (above). So the mapper writes CycloneDX JSON
objects directly, typed by hand against the 1.7 schema, and every output is validated against the official schema
shipped in `@cyclonedx/cyclonedx-library` before it is stored. The unmet requirement is recorded here and re-checked
when the library's model gains `modelCard` or `data` (B0 re-checks against the pinned version at runtime, not only by
reading source). The same exception covers SPDX 3.0.1, for which no maintained JS model exists.

## Options considered

**A. Decision BOM = an on-demand join over live tables (no capture).** Cheapest, but not exact: policies, configs,
prompt tags, model cards and grants change after the decision, and a later export would describe today's state, not
the state the decision ran under. It also cannot be byte-reproducible. Rejected.

**B. Decision BOM as a CycloneDX document** (formulation for the steps, declarations for the claims). Uses one
standard for both BOMs, but formulation describes how an artefact was made, and declarations assert conformance to
standards; neither has slots for an actor chain, an approval quorum, a rule chain or an audit-chain proof without
pushing everything into free `properties`, which no consumer would read. Rejected as the authority; CycloneDX stays
the AI BOM format and the Decision BOM links to it.

**C. A native, signed Decision BOM built from facts captured at decision time, linked by BOM-Link to a signed,
versioned AI BOM snapshot in CycloneDX (recommended).** The Decision BOM is our own small schema (no standard exists),
canonical RFC 8785 JSON, signed with the receipt key and bound to the decision's receipt; its inputs are captured in
the decision's own transaction, so nothing is re-derived from mutable state. The AI BOM is a standard document.

**D. in-toto Statement with a custom predicate, DSSE-signed, as the authority.** A real envelope standard with good
tooling for software provenance, but it adds a second signature format beside our receipts and export bundles, and its
subject is an artefact digest, which a decision does not naturally have. Kept as an optional export view (OWNER
DECISION 1).

## Decision (Accepted 2026-10-10)

### 1. Two documents, two scopes

- An **AI BOM** describes *what an AI system is made of*, for one subject: an **AI use case** (`ai_use_cases`), an
  **agent** (`agents` or `builder_agents`), or the **install** (every model, tool, endpoint and engine the deployment
  holds). It is a versioned, signed **snapshot**, exported as CycloneDX 1.7 (and 1.6, SPDX 3.0.1 per OWNER DECISIONS
  6 and 7).
- A **Decision BOM** describes *what produced one governed decision*: one receipt-eligible audit row (the same set
  ADR-0186 R signs). It names the inputs, policies, models, approvals, identity and evidence behind it, links to the
  decision's signed receipt, and links by BOM-Link to the AI BOM snapshot that was current for the subject at decision
  time.

### 2. The Decision BOM schema `regulait.decision-bom.v1`

A canonical JSON object (RFC 8785 via `canonicalize`, B0 extends the ADR-0186 byte-identity corpus to these shapes).
Sections, each built from stored facts only:

| Section | Content | Source |
|---|---|---|
| `decision` | audit id and `seq`, time (database clock), object type and id, server, tool or connector, effect, `ruleId`, rule chain ids | `audit_log` |
| `receipt` | `receiptSeq`, payload hash, `keyId` | `decision_receipts` |
| `principal` | **sponsor** user id (an id, never an email or name; decision 7) | `audit_log.user_id` (the sponsor under ADR-0188 decision 9) |
| `actors` | the **actor chain** as workload identifiers (`spiffe://…/regulait/<kind>/<id>`), the delegation grant id, its stored `path` and `depth`, the grant's scope and cap at decision time, `binding_kind` and thumbprint, `auth_credential_id` | ADR-0188: `audit_log.actor_chain`, `actor_identity_id`, `delegation_grant_id` (decision 9); `delegation_grants` (decisions 4, 12, 22); `issued_tokens` (decision 12); `workload_identities` (decision 2) |
| `action` | the ADR-0104 `argumentsDigest` and `contextDigest`; target (server, tool, connector, model); **inputs by digest and classification only** (prompt commit hash, dataset version and checksum, project `data_sensitivity`, compliance profile), never content | `decision_facts` (decision 4) |
| `policy` | governance policy epoch; ABAC policy version ids with their schema version; config version ids and canary bucket; guardrail config; model policy rule ids; the kill-switch dial state | `decision_facts` |
| `model` | agent id, provider, requested model, served model, `pinned_model_version`, model card id and the approval in force, the AI BOM snapshot reference | `decision_facts`, `usage_events` |
| `approval` | approval id, quorum, each decider id, step-up method, passkey `signed_digest` and credential id | `approvals`, `approval_decisions`, **bound by row digest in `decision_facts`** (amendment R5) |
| `outcome` | result status, refusal code, upstream status class, post-action verification result where a workflow stage recorded one | `audit_log` and `trace_spans` rows bound by digest in `decision_facts`; later facts only from signed addenda (amendment R5) |
| `cost` | usage event ids, tokens, cost as a lossless decimal string of the stored value (amendment R23; never a float in a signed body) | `usage_events` row projections stored in `decision_facts` or an addendum (amendments R5, R18) |
| `trace` | trace id and span ids (no previews) | `trace_spans` rows bound by digest in `decision_facts` or a signed addendum (amendment R5) |
| `proof` | the audit-chain segment from the decision row to the anchor that covers it (`seq`, `contentHash`, `prevHash`, `rowHash` per row, as ADR-0116's `chain.tsv`), the **complete canonical anchor record** (`seq`, `rowHash`, `headAt`, `algorithm`, `payloadVersion`, `capturedAt`) plus destination, status, `external_ref`, `flushed_at` and the recorded tamper-resistance observation, the finality state, and the RFC 3161 token where one exists (amendments R1 and R4) | `audit_log`, `audit_anchors` |
| `completeness` | for every section: `recorded`, `not_applicable`, or `not_recorded` with a reason (for example, a decision made before ADR-0188's audit v2 boundary has `actors: not_recorded, reason: pre_identity`) | builder |
| `basis` | the exact watermarks the document was built from (audit `seq`, anchor id, receipt seq, AI BOM snapshot id) and `supersedes` | builder |

Nothing is inferred to fill a gap: a missing fact is `not_recorded`, and the verifier reports it as a limit, not a
failure (decision 6).

### 3. The AI BOM: CycloneDX 1.7 mapping

Built from a signed native snapshot (`regulait.ai-bom.v1`, the authority) and rendered to CycloneDX:

| RegulAIt record | CycloneDX 1.7 |
|---|---|
| Use case / agent / install | `metadata.component` (type `application`), with owner, `data_sensitivity`, compliance tags and EU AI Act tier as properties |
| `agents` + `model_cards` | component type `machine-learning-model`: supplier = provider, version = `pinned_model_version`, `modelCard` (`considerations.useCases` ← `intended_use`, `technicalLimitations` ← `limitations`, `fairnessAssessments`/`ethicalConsiderations` ← `bias_fairness`, `modelParameters.datasets` ← dataset refs, `quantitativeAnalysis` ← evaluation results), external references ← `standard_refs` |
| Provider API endpoint | `service` with `endpoints`, `trustZone`, and **`data` flows** (direction and classification: what the model receives and returns, by the project's sensitivity; one pair per use case for agent and install snapshots, amendment R27). This is PF-09's "per-model data flow" |
| `model_artifacts` | component (type `machine-learning-model` or `file`) with SHA-256 hash and format |
| `artifact_scans`, `model_card_evidence` (`engine_scan`, `eval_run`, `external`) | `declarations` (attestations: the claim, the scanner and version, the verdict, evidence references); the engine is a `container` component with its `image_digest` |
| `training_datasets`, `eval_datasets` | component type `data` with `data[].type = dataset`, hash from `checksum`, classification, `governance` (owner), sensitive-data flag from `pii_verdict`; evaluation datasets map only what is recorded (amendment R24); hashes parsed per R26 |
| Training-data sources of third-party models | from `model_cards.data_claims`, marked **supplier-declared**; when absent, `unknown` (OWNER DECISION 10) |
| `prompt_commits` (the promoted commit) | component type `data`, `data[].type = configuration`, hash = commit `hash` |
| `builder_skills` | component type `data` (`configuration`) with `admitted_digest` |
| `mcp_servers`, `mcp_tools`, `connectors` | `service` entries with endpoints, transport, `release_digest`/`admission_manifest_digest`, owner, admission state, and ADR-0188's `identity_propagation` mode; tools as nested services |
| Memory stores (ADR-0082 inventory) | component type `data` describing the store (never its contents) |
| Workload identity (ADR-0188) | the agent component's `bom-ref` carries its identity URI as a property |
| Libraries and licences | for the install-scope BOM, a BOM-Link `externalReference` to ADR-0184's workspace and image SBOMs of the running release |
| Granted vs observed (ADR-0082) | `dependencies` = **granted** (what may happen); observed use is a property on the dependent component (`regulait:observed:lastSeen`, count); the two are never merged |
| Gaps | `compositions` with `aggregate: incomplete` or `unknown` for every assembly we cannot fully describe; never `complete` unless every member is recorded |

SPDX 3.0.1 (slice B5): `ai_AIPackage` for models, `dataset_DatasetPackage` for datasets, `Relationship` for
dependencies; `hasDeclaredLicense` and `hasConcludedLicense` always present, pointing to `NoAssertionLicense` where
unknown. The mandatory `AIPackage` properties follow amendment R3.

### 4. Decision facts are captured in the decision's transaction

New append-only table `decision_facts`, one row per receipt-eligible audit row, written in the same transaction as the
audit row by the governed paths (`mcp-proxy.ts`, `connector-call.ts`, `governed-evaluate.ts`, the approvals and
agent-dispatch writers): the versions, digests and classifications of the `action`, `policy` and `model` sections,
and the immutable row digests of the approval, outcome, cost and trace rows that exist at that point (amendment R5;
later facts go in signed addenda). Its canonical bytes hash to `facts_hash`. The receipt payload carries
`factsHash`, so the receipt signature covers the facts (open question 1: one receipt payload v2 shared with ADR-0188
decision 9). Free text never enters `decision_facts` (ids, digests, enums and integers only), so no new prose column
needs the ADR-0102 scrub (M-055 check done at B1 anyway).

### 5. Signing, freezing and exact-byte reproducibility

- **Signer:** the ADR-0186 receipt key (`REGULAIT_RECEIPT_SIGNING_KEY`, `receipt_signing_keys`), Ed25519 over the
  RFC 8785 bytes of the BOM body. Domain separation is by the body's `v` field (`regulait.decision-bom.v1`,
  `regulait.ai-bom.v1`), which is inside the signed bytes; every verifier rejects an unknown `v`, so a receipt
  signature can never verify as a BOM or the reverse (OWNER DECISION 2). No key, no new BOM: 409
  `bom_signing_unavailable` on the routes that create or sign; there is no unsigned fallback and no key generated on
  the box (the ADR-0116 rule). Verification and reading already-frozen bytes never need the private key (amendment R6).
- **Freezing:** a Decision BOM is assembled on first request and **frozen** (stored bytes, hash, signature) only once
  the decision's receipt is signed and an anchor covering its audit row has flushed **to a destination observed as
  tamper-resistant** (with an RFC 3161 token when `audit_anchor_timestamp_mode` is `required`); before that the route
  answers 409 `bom_anchor_pending` with a `Retry-After` (OWNER DECISION 4; the weaker states are in amendment R4). An AI
  BOM snapshot is frozen when it is taken, and only once every v1 renderer has shipped (amendment R2).
- **Exact bytes:** an export always returns the stored bytes; nothing is re-rendered after freezing. The builder is a
  pure function of the `basis` watermarks and stored rows, with no clock reads (times come from rows), no random
  values (the CycloneDX `serialNumber` is a UUID derived from the snapshot id, fixed at freeze), sorted lists, and
  integer money. Renderings (CycloneDX 1.7, 1.6, SPDX) are produced once at freeze with the pinned libraries and
  stored with their SHA-256 inside the signed native body. A test rebuilds every document from its basis on another
  replica and after unrelated writes, and requires identical bytes.
- **New facts make new versions.** A later fact (a post-action verification, a late timestamp) produces version
  `n+1` with `supersedes`; the earlier version is never edited.

### 6. Verification, offline

- `packages/shared/src/bom/verify.ts` (pure, no I/O) and `scripts/verify-bom.mjs` verify a Decision BOM or AI BOM
  (amendment R19) bundle with an out-of-band trust root only (`--fingerprint` or `--keyring`, as ADR-0116); the key inside a bundle is
  a convenience, never the authority (the lesson of ADR-0186 review finding R21-01, "online verify trusts the bundle's
  keys").
- Checks: the body signature; the receipt signature and that the receipt's `factsHash` equals the facts in the body;
  the audit-chain segment's links row by row up to the anchor (the decision row's content binding is reported
  `unverifiable`, `preimage_not_exported`, R39); the anchor's row hash; the RFC 3161 token with `pkijs` against
  a supplied TSA trust bundle; and the BOM-Link to the AI BOM snapshot by serial, version and SHA-256 when that
  snapshot is in the bundle.
- Results per section: `valid`, `invalid`, or `unverifiable` (with the reason), plus a fixed `cannotProve` list: that
  nothing was omitted after the anchor, that the facts were true (only that they were recorded and signed), and
  signing time beyond the anchor timestamp.
- The bundle is an ADR-0116 bundle with a new schema `regulait.export-bundle/3` (subject `decision-bom` or
  `ai-bom`), so `verify-export-bundle.sh` still checks the file manifest with stock tools.
- CycloneDX and SPDX renderings are additionally validated against the official schemas (offline, bundled), and in CI
  the SPDX output passes `spdx3-validate`.

### 7. Strict defaults (ADR-0180)

| Setting | Default (strict) | Relaxable to | Notes |
|---|---|---|---|
| `decision_facts_capture` | `on` for every receipt-eligible decision | `off` | audited, `settings_relax` step-up; the posture page shows "Decision BOM: not captured" while off; decisions made while off have `not_recorded` sections forever |
| `decision_bom_finality` | `anchored`: flushed to a destination **observed** tamper-resistant (and timestamped when `audit_anchor_timestamp_mode = required`) | `anchored_unverified_destination` (flushed to a destination not observed tamper-resistant; the BOM and the verifier say so), then `chain_signed` (freeze once the receipt is signed, before the anchor; the BOM records `proof.anchor: absent`) | audited; amendment R4 |
| `bom_export_roles` | admins only | admins plus an explicit auditor grant | granting is an admin act, audited |
| `bom_person_identifiers` | `id_only` (user and workload ids) | `display_name`, **AI BOMs only** (Decision BOMs are always `id_only`, R45) | audited; emails are never included (see invariants) |
| `ai_bom_snapshot_triggers` | on sign-off events (OWNER DECISION 8; queued durably when no key, R25) | on demand only | audited |
| `cyclonedx_export_versions` | `1.7` | add `1.6` | audited |
| BOM export rate limit | 30 per minute per user | admin may raise | audited |
| Unsigned BOM | **never** | not relaxable | invariant, like ADR-0116 "no key means no bundle" |
| Raw content (prompt text, arguments, outputs, previews) in a BOM | **never** | not relaxable | invariant: a BOM is built to leave the boundary; digests and classifications only (OWNER DECISION 5) |
| Email addresses in a BOM | **never** | not relaxable | invariant; enforced also by the `idn-email` reject-all format |
| `compositions` marked `complete` with an unrecorded member | **never** | not relaxable | invariant |
| Editing a frozen BOM | **never** | not relaxable | append-only table with an immutability trigger |

Build as for a first load: no grandfathering. Decisions made before B2 ships have no facts and get BOMs whose
`action`, `policy` and `model` sections are `not_recorded`; nothing is back-filled from current state.

### 8. Data model sketch (migration `0181+`; not written here)

- `decision_facts` (`audit_id` PK, no foreign key to `audit_log` (amendment R16), `audit_seq`, `facts_version`, `facts` jsonb, `facts_hash`,
  `created_at`). Append-only, immutability trigger.
- `decision_boms` (`id`, `audit_id`, `version`, `supersedes_id`, `body` (exact canonical bytes as text), `body_sha256`,
  `signature`, `key_id`, `basis` jsonb, `created_by`, `created_at`; UNIQUE (`audit_id`, `version`)). Append-only.
- `ai_bom_snapshots` (`id`, `subject_kind` `use_case | agent | builder_agent | install`, `subject_id` (NOT NULL; nil UUID for install, R20), `version`,
  `serial_number` uuid, `supersedes_id`, `trigger`, `basis` jsonb, `body`, `body_sha256`, `signature`, `key_id`,
  `created_by`, `created_at`; UNIQUE (`subject_kind`, `subject_id`, `version`)). Append-only.
- `bom_renderings` (`id`, `decision_bom_id` or `ai_bom_snapshot_id` (exactly one, each `ON DELETE CASCADE`; R36),
  `format` `cyclonedx-1.7 | cyclonedx-1.6 | spdx-3.0.1 | in-toto`, `bytes`, `sha256`, `validator`, `created_at`;
  UNIQUE (parent, `format`)).
- Settings rows for decision 7; the auditor export grant.
- Retention follows the audit retention of the compliance profile and respects evidence holds (OWNER DECISION 11),
  through the single prune path of amendment R16.
- Receipt payload v2 field `factsHash` (open question 1), emitted only from the R34 boundary.

### 9. API and UI surface

Every route is audited (who exported what), rate-limited, and refuses anyone outside `bom_export_roles`.

- ~~`GET /v1/ai-bom/:subjectKind/:subjectId` — the live, unsigned draft~~ — **removed** (amendment R8). Review uses
  a signed snapshot taken on demand.
- `POST /v1/ai-bom/:subjectKind/:subjectId/snapshots` — freeze and sign a snapshot (disabled until B5 ships,
  amendment R2).
- `GET /v1/ai-bom/snapshots/:id?format=native|cyclonedx-1.7|cyclonedx-1.6|spdx-3.0.1` and `…/:id/bundle`. Every format
  is delivered inside a verifiable `export-bundle/3` with the signed native body, never as bare rendering bytes
  (amendment R7).
- `GET /v1/ai-bom/:subjectKind/:subjectId/drift` — a change list (added, removed, changed hash, changed version) of the
  live state against the last signed snapshot. Admins only, audited, `evidence: false` in the response, no download
  and no format parameter; it is never a BOM document (amendment R8).
- `GET /v1/decisions/:auditId/bom` (signed document; 409 `bom_anchor_pending`, 409 `bom_signing_unavailable`) and
  `…/bom/bundle`.
- `POST /v1/boms/verify` — the same pure verifier, run online for convenience; it uses the server's recorded keys as
  the trust root and says so in the result. It works with no private key configured (amendment R6).
- Keys: the existing `GET /v1/receipts/keys`.
- **UI (Codex):** an "AI BOM" tab on the use-case overview and on the agent inventory and model-risk pages (snapshot
  list, download per format, drift chips, the `incomplete` reasons); a "Decision BOM" action on an audit-log row and
  in `DecisionReceiptsPanel` (download, verify, the per-section result and the `cannotProve` list); settings rows on
  the posture page.

### 10. Air-gapped and BYOC fit (pillar 3)

- **Air-gapped:** every library above works from local files; the CycloneDX and SPDX schemas are bundled, never
  fetched; RFC 3161 needs an internal TSA or is honestly absent (ADR-0186 S); the offline verifier needs Node and the
  trust root only. No BOM route makes an outbound call.
- **BYOC:** the control plane builds and signs BOMs from control-plane records. Facts from an execution plane arrive as
  ADR-0188 identities and grant ids (a remote worker's SPIFFE identifier appears in `actors`), never as content, so the
  documents respect the ADR-0015 data boundary and can be exported across it. The signing key is the customer's
  deploy-time receipt key; no private key leaves its plane.
- **Hosted fast-start:** identical; the posture page shows "Decision BOM: unavailable (no signing key)" until a receipt
  key is set.

## Rollout: slices (one PR each)

Hot files as in earlier batches (`schema.ts`, migrations, `app.ts`, `route-classes.ts`, `openapi-registry.ts`, the
lockfile, shared zod) belong to B1. The governed call paths (`mcp-proxy.ts`, `connector-call.ts`,
`governed-evaluate.ts`, orchestration and builder runtime) belong to ADR-0188 S4 until it merges, then to B2.
**Claude builds the backend slices; Codex owns the web UI (B6) and reviews every Claude slice**, including a set of
verifier test vectors Codex writes from this ADR's text alone (not from the code), so the offline verifier is checked
against the specification rather than against itself.

| Slice | Owner | Content | Depends on | Parallel? |
|---|---|---|---|---|
| **B0 spike** (research, no product code) | Claude | Confirm at runtime that `@cyclonedx/cyclonedx-library` 10.3.0's model lacks `modelCard`/`data`/`declarations`; compile its bundled 1.7 and 1.6 schemas and the SPDX 3.0.1 schema with our pinned Ajv offline, with the reject-all `idn-email` format; extend the `canonicalize` byte-identity corpus to BOM shapes; render a sample AI BOM twice and on two Node versions and compare bytes; run `spdx3-validate` pinned in a CI container; read the OWASP AIBOM field guidance. Output: a research note and go/no-go on decision 3's exception | none | **Yes**, now, with ADR-0188 S1–S4 |
| **B1 foundation** | Claude | Migration `0181+` (decision 8 tables, settings, immutability triggers), `schema.ts`, shared zod for `regulait.decision-bom.v1` and `regulait.ai-bom.v1`, strict settings with audited relaxation, every route as a 501 stub, receipt payload v2 `factsHash` as agreed under open question 1 (verified, not emitted, until the R34 cutover), `audit_anchors.tsa_request_sent_at` (R33) | B0 go; ADR-0188 S1 merged (shared migration journal) | serial (hot files) |
| **B2 fact capture** | Claude | `decision_facts` written in the decision transaction on every governed path; `factsHash` in receipts; the `actors` facts read from ADR-0188's columns | B1; **ADR-0188 S4 merged** (same files, and the actor chain must exist) | serial |
| **B3 AI BOM builder and CycloneDX renderer** | Claude | `packages/shared/src/bom/` pure builder from a loaded record set, CycloneDX 1.7 and 1.6 renderers, validation, compositions; gateway loader, snapshot and drift routes (no draft route; snapshot routes and triggers ship disabled until both B4 and B5 merge, amendments R2 and R17) | B1 | **Yes**, with B2 (no shared files) |
| **B4 Decision BOM assembler, signer, bundle and verifier** | Claude | Assembly from facts and stored rows, freezing rules, signing with the receipt key, `export-bundle/3`, pure verifier and `scripts/verify-bom.mjs` (both subjects, R19), whole-bundle email scan (R21), `POST /v1/boms/verify` | B2, B3 (BOM-Link) | serial after B2 |
| **B5 SPDX 3.0.1 renderer** | Claude | `ai_AIPackage`, `dataset_DatasetPackage`, licence relationships; schema validation in the product, `spdx3-validate` in CI | B3 (the snapshot-route switch flips in the second of B4 and B5 to merge, R17) | **Yes**, with B4 |
| **B6 web UI** | Codex | Decision 9's tabs, actions and verify panel; drift view; posture rows | B1 stubs | **Yes** (web only); merges after B4's real routes |
| **B7 our own AI BOM** | Claude | An install-scope AI BOM per release, BOM-linked to ADR-0184's SBOMs through release-published, signed SBOM identity metadata (amendment R9); PathForward's "inventory of AI tools in the development stack" as a checked-in, reviewed list rendered into it | B3, B4 and B5 (inactive until the R17 switch flips, R28) | **Yes** (developed in parallel), with B4–B6 |
| **B8 runbooks** | Claude, reviewed by Codex | Air-gapped and BYOC verification runbooks; every command executed before it is written down (M-041) | B4, B5 | **Yes**, with B6, B7 |

## Test strategy

Every rule gets a red proof (fails with the control removed, then passes), through the real app.

- **Exactness.** A decision is made; then its ABAC policy, config version, prompt tag, model card and the agent's
  grants all change; the Decision BOM still shows the values in force at decision time. Rebuilding a frozen BOM from
  its basis on a second replica, after unrelated writes and a restart, gives identical bytes; the export returns the
  stored bytes.
- **Signature and binding.** Editing any byte of a body, swapping the facts of two decisions, replacing the receipt,
  dropping a chain row, changing an anchor hash, a receipt signature presented as a BOM signature (domain
  separation), an unknown `v`, a bundle re-signed with a fresh key carrying its own public key → each `invalid` or
  refused, offline, with the trust root supplied out of band.
- **Honesty.** A pre-identity decision shows `actors: not_recorded`; a pre-facts decision shows its sections
  `not_recorded`; no section is filled from current state; an AI BOM with an unknown licence or training source says
  `unknown` and its composition is `incomplete`; a test fails if any `complete` aggregate has an unrecorded member.
  Loader and renderers run on rows shaped by the `packages/db` schema (nulls and defaults included), and a test fails
  on any rendered value with no source column or stated derivation (R30, R32); one snapshot per subject kind (R31).
- **No content.** Seeded prompts, arguments and outputs containing canary strings never appear in any BOM, rendering or
  bundle; an email address in any input field fails validation.
- **Finality.** Before the anchor flushes → 409 `bom_anchor_pending`; flushed to a destination not observed
  tamper-resistant → still 409 under the default; after a tamper-resistant flush → frozen as `anchored`; with each
  relaxed setting → frozen as `anchored_unverified_destination` or with `proof.anchor: absent`, the verifier reports
  the state, and the relaxation is audited (amendment R4).
- **No key.** Unset receipt key → 409 `bom_signing_unavailable` on every route that creates or signs; verify and reads
  of frozen bytes still work; no key is generated (amendment R6).
- **Standards.** Every rendering validates against the bundled official schema offline (network disabled in the test);
  SPDX output passes `spdx3-validate` in CI; Codex's specification-only verifier vectors pass.
- **Access.** Non-admins without the auditor grant → 403; every export writes an audit row.
- **Identity (after ADR-0188).** A three-deep delegated call's Decision BOM lists sponsor, each actor and the grant
  path exactly as the audit row's `actor_chain`; a revoked credential after the decision does not change the frozen BOM.

## Owner decisions (accepted 2026-10-10)

The owner accepted all eleven recommendations on 2026-10-10, as written below. Spike B0 may start now; B1 onward waits
for ADR-0188 S1 and S4, as the slice plan says.

1. **OWNER DECISION — Decision BOM format.** *Recommended:* our own `regulait.decision-bom.v1` (no standard defines a
   Decision BOM), RFC 8785 canonical and signed, linked to the AI BOM by CycloneDX BOM-Link; an in-toto Statement in a
   DSSE envelope is added as an export view only when a customer asks. Alternative: CycloneDX formulation and
   declarations as the authority (Option B, rejected above).
2. **OWNER DECISION — signing key.** *Recommended:* reuse the ADR-0186 receipt key and key table, with domain
   separation by the signed `v` field, so one key and one verifier cover all decision evidence. Alternative: a separate
   BOM key (more custody work, no stronger guarantee given domain separation).
3. **OWNER DECISION — which decisions get a Decision BOM.** *Recommended:* facts captured eagerly for every
   receipt-eligible decision; the BOM itself assembled and frozen lazily on first request. Alternative: eager BOMs for
   every decision (storage and signing load for documents nobody reads).
4. **OWNER DECISION — when a Decision BOM is final.** *Recommended:* only once an anchor covering the decision has
   flushed (and is timestamped when timestamps are required); `chain_signed` available as an audited relaxation.
5. **OWNER DECISION — content in BOMs.** *Recommended:* digests and classifications only, as an invariant that an admin
   cannot relax, because a BOM is made to leave the boundary. This departs from "an admin may relax every setting"
   (ADR-0180), as ADR-0188 did for unbound tokens; the owner may prefer a relaxable setting instead.
6. **OWNER DECISION — CycloneDX version.** *Recommended:* 1.7 by default, 1.6 as an additional export for consumers
   not yet on 1.7.
7. **OWNER DECISION — SPDX 3.0.1 in v1.** *Recommended:* yes, as slice B5 in this batch, run in parallel, with
   runtime JSON-schema validation and CI-only SHACL conformance; CycloneDX stays primary.
8. **OWNER DECISION — when AI BOM snapshots are taken.** *Recommended:* automatically on sign-off events (use-case
   approval, model card approval, prompt promotion, engine-scan evidence attached, config version promotion, admission
   of a server or skill) and on demand; the drift view compares the live draft to the last snapshot. No scheduled
   snapshots.
9. **OWNER DECISION — who may export.** *Recommended:* admins, plus an explicit auditor grant; every export audited;
   no step-up for reading (step-up stays on relaxing the settings). The sponsor of a decision does not get access by
   default.
10. **OWNER DECISION — training-data sources of third-party models.** *Recommended:* record only what the supplier
    declared (from the model card's `data_claims`), marked supplier-declared, and `unknown` otherwise; never infer.
11. **OWNER DECISION — retention.** *Recommended:* Decision BOMs and AI BOM snapshots follow the compliance profile's
    audit retention and are kept under evidence holds; renderings are deleted with their parent.

## Amendments after spike B0 (2026-10-10)

Spike B0 (`docs/research/R12-bom-b0-spike.md`, PR #265) returned GO on the ADR-0176 §4 exception. These amendments
bind slices B1 to B8.

1. **The CycloneDX library is used for its schema files only.** At runtime, 10.3.0's model also lacks `compositions`,
   `definitions`, `annotations`, top-level `externalReferences`, and `Service.endpoints/data/trustZone/authenticated`.
   Its 1.7 serializer silently drops fields forced onto the objects. B3 never uses the library's model or serializer.
2. **`iri-reference` maps to the ajv-formats `uri-reference` check (ASCII only).** The library's accept-all behaviour
   is an insecure default under ADR-0180.
3. **Ajv settings:** `strict: true` and `strictRequired: false`; `meta:enum` registered as an annotation-only keyword;
   schemas compiled once at boot or precompiled, because compiling takes 2-3 s.
4. **`spdx3-validate` is "No as shipped" for air-gapped use.** It fetches the schema, the SHACL model and the
   JSON-LD context. The CI job uses the vendored files, the offline driver, a hash-locked install and no network.
5. **Exact-bytes rules:**
   - SPDX `created` is truncated to whole seconds; the native body keeps the full time.
   - `serialNumber` is an RFC 9562 v8 UUID derived from SHA-256 of `regulait:ai-bom:<snapshot id>`.
   - Sorting is by code unit, never `localeCompare`.
   - Integers must not exceed 2^53.
   - Metric values are strings.
6. **CI-only Python closure (owner, 2026-10-10):** PSF-2.0 (`typing_extensions`) and W3C-20150513 (`owlrl`) are
   allowed for CI tooling that never ships; see the ADR-0176 amendment of the same date.
7. **Vendored SPDX 3.0.1 schema, model and context (owner, 2026-10-10):** admitted as standards-body specification
   data under Community-Spec-1.0 / CC-BY-3.0, with attribution in THIRD_PARTY.md; see ADR-0176.
8. **CycloneDX mapping additions,** from the OWASP AIBOM field registry:
   - `modelCard.modelParameters.task` and `modelArchitecture`;
   - `licenses` on model components, with an unknown licence stated as unknown and the composition marked
     `incomplete`;
   - `purl` or a distribution reference, only when the provider supplies one;
   - the SPDX AI-profile fields as `regulait:` properties, marked unknown or supplier-declared.

   Open question 6 is updated accordingly.
9. **B0's "CI container" was met only as a hash-locked, network-isolated venv.** B5 builds the real CI job.

## Amendments after review (2026-10-10)

A review of PRs #253 and #265 raised findings against this ADR and the B0 spike. Each was checked against the ADR text
and the code it cites on `main` @ 3119813. The real ones are resolved below, each with the secure-by-default choice
(ADR-0180). These amendments bind B1 to B8 and take precedence over any earlier text they contradict; the rows and
rules that would have contradicted them were updated in place. The B0 evidence (R12) is on branch `b6-bom-b0` and
reaches `main` with PR #265.

R1. **The proof carries the complete canonical anchor record.** The RFC 3161 imprint is SHA-256 over
    `canonicalJson({seq, rowHash, headAt, algorithm, payloadVersion, capturedAt})` (`anchorRecordFromRow`,
    `apps/gateway/src/audit-timestamp.ts:51`; `payloadVersion` is read from the versioned `tsa_token` storage and
    `capturedAt` is the row's `created_at`). The `proof.anchor` object carries those six fields exactly as stored,
    plus the anchor id, destination, status, `external_ref`, `flushed_at` and the tamper-resistance observation (R4).
    The offline verifier rebuilds the canonical bytes, checks their SHA-256 against both the stored
    `tsa_message_imprint` and the imprint inside the token, and checks that `seq` and `rowHash` match the last row of
    the chain segment. A proof without all six fields is `invalid`, not `unverifiable`.

R2. **No AI BOM snapshot is frozen until every v1 renderer has shipped.** Renderings are produced only at freeze and
    their hashes sit inside the signed native body, so a snapshot frozen before B5 could never gain SPDX. B3 ships its
    snapshot route and the automatic triggers **disabled in code** (501 `bom_snapshots_not_released`, not an admin
    setting); they are enabled in whichever of B4 and B5 merges second (R17). B3 and B5 may still merge as separate PRs.
    A renderer added after v1 (for example in-toto) applies only to snapshots taken after it ships; an older snapshot
    answers that format with 404 `format_not_rendered_for_snapshot` and the list it has. Nothing is back-filled; a new
    format for an old subject means a new snapshot version with `supersedes`.

R3. **Mandatory SPDX `AIPackage` properties are never invented.** SPDX 3.0.1 sets `releaseTime`, `suppliedBy`,
    `downloadLocation`, `packageVersion` and `primaryPurpose` to minCount 1 on `AIPackage` (the class page's "External
    properties cardinality updates", read 2026-10-10). The official SHACL model does **not** enforce these (the B0
    sample passes `spdx3-validate` without `releaseTime` or `downloadLocation`), so B5 adds its own cardinality check
    for every mandatory property and runs it beside schema and SHACL validation. Sources: `primaryPurpose` is `model`;
    `suppliedBy` is the provider `Organization`; `packageVersion` is `pinned_model_version`, else the recorded served
    model; `releaseTime` and `downloadLocation` only from a supplier-declared value recorded on the model card. Where
    the standard defines a no-assertion form for a property (element-valued properties, licences), B5 uses it and
    marks the snapshot `incomplete`. For a literal-valued property with no such form (`releaseTime` is a DateTime,
    `downloadLocation` an anyURI, `packageVersion` a string), the standard gives no unknown value. Until the owner
    decides (owner item 1 below), the strict default applies: that model's snapshot gets **no SPDX rendering**; the
    signed native body records `spdx-3.0.1: not_producible` with the missing property names, the snapshot is
    `incomplete`, and the CycloneDX renderings are unaffected. No placeholder date, URL or version is ever emitted.

R4. **`anchored` finality requires an observed tamper-resistant destination.** A flush to `local_worm`, or to an S3
    bucket whose observation is not compliance-mode Object Lock, still sets `audit_anchors.status = flushed`, while the
    sink reports `tamperResistant: false` (`apps/gateway/src/audit-chain.ts`, `LocalWormSink`, `S3ObjectLockSink`), and
    the observation is not persisted. So:
    - B1 adds to `audit_anchors` the observation made at flush time (`tamper_resistant` boolean, observation mode and
      time), written in the flush; an unobserved flush records `false`.
    - Finality states, strictest first: `anchored` (flushed, observation `true`, and timestamped when timestamps are
      required); `anchored_unverified_destination` (flushed, observation `false`); `chain_signed` (no anchor).
    - The default `decision_bom_finality = anchored` freezes only the first; otherwise the route answers 409
      `bom_anchor_pending` with reason `destination_not_tamper_resistant`. Each weaker state is an audited
      relaxation.
    - The state and the observation are inside the signed body; the verifier reports the state, and its `cannotProve`
      list gains "that the anchor destination is tamper-resistant: this is the server's recorded observation".
    - Consequence: an install without compliance-mode Object Lock (every `local_worm` install, including air-gapped
      ones until they have an S3-compatible WORM store) gets no Decision BOM until an admin relaxes the setting. The
      posture page says so.

R5. **Every historical section is bound to the receipt** (refined by R15: addenda are captured unsigned and signed
    later; and by R18: rows are stored as projections, not only digests). `decision_facts` covered only `action`,
    `policy` and `model`, so approval, outcome, cost, trace and post-action verification were read from live tables (Option A's problem).
    Now:
    - At decision time, in the same transaction, `decision_facts` also carries the immutable digests of the approval,
      approval-decision, usage-event and trace-span rows that exist then, and the outcome fields of the audit row. A row
      digest is SHA-256 over the `canonicalJson` of a fixed column list per table, defined once in the B1 shared zod.
    - Facts that arrive later (a usage event written after the upstream call, late spans, a post-action verification)
      go in a new append-only table `decision_fact_addenda` (`audit_id`, `n`, `prev_hash`, `facts`, `facts_hash`,
      `signature`, `key_id`, `created_at`), hash-chained from the decision's `facts_hash` and signed with the receipt
      key under its own `v` (`regulait.decision-facts-addendum.v1`) when written. Immutability trigger, as for
      `decision_facts`.
    - The assembler takes approval, outcome, cost and trace only from rows whose digest is in the facts or an addendum,
      and re-checks each digest when it assembles; a mismatch fails assembly. A section with no bound row is
      `not_recorded`. Live tables are never a source without a bound digest.
    - The verifier checks each addendum's signature and its chain back to the receipt's `factsHash`.

R6. **Verification never needs the private key.** 409 `bom_signing_unavailable` applies only to routes that create or
    sign: `POST …/snapshots`, the first assembly and freeze of a Decision BOM, and building a new bundle (which also
    needs the ADR-0116 export key). `POST /v1/boms/verify` uses the recorded public keys (`receipt_signing_keys`, as
    `/v1/receipts/verify` does today), and reading already-frozen bytes needs no key. A retired or removed key never
    stops verification of BOMs it signed.

R7. **Renderings ship only inside a verifiable bundle.** A CycloneDX or SPDX rendering is authenticated only by its hash
    in the signed native body. Every `format=` download is therefore an `export-bundle/3` holding the rendering, the
    signed native body, its signature and the BOM-Link data; bare rendering bytes are never served. A detached
    manifest was rejected because the rendering file can then travel without it. Recipients who need a lone file
    extract it from the bundle after verifying.

R8. **The unsigned draft route is removed.** The stricter of the two options, because an unsigned document in BOM shape
    can leave the boundary and be taken for evidence, whatever its label, and the review need is met by a signed
    snapshot taken on demand. The drift route stays as a change list only (admins only, audited, `evidence: false`,
    no download), and like the snapshot routes it needs a signing key to have a snapshot to compare with.

R9. **B7 reads signed SBOM identities from the release.** The ADR-0184 SBOMs exist only as CI artifacts, so the
    deployed gateway has no trusted source for their serials, versions and hashes. B7 makes `security.yml` publish, per
    release, an SBOM identity file (`serialNumber`, `version`, SHA-256 and kind for the workspace and image SBOMs, and
    the image digest), signed by the CI step that already signs the scanned image (ADR-0184 `sign` job) and
    shipped with the release. The install-scope
    AI BOM is built only from a file whose signature verified at install time against a trust root shipped with the
    release; without one, the `externalReferences` are omitted and the composition is `incomplete`. The trust root for
    air-gapped installs is owner item 2.

R10. **Emails are rejected by a whole-document scan.** The `idn-email` reject-all format covers only fields that the
    schema types as email. B3 runs, before freeze, a scan of every string (object keys and values) of the native body
    and every rendering, and refuses the snapshot (no redaction) when any token matches an email shape. Fail closed:
    a false positive refuses the snapshot and names the JSON path. B4 runs the same scan on Decision BOMs. The B0
    spike now has this scan and a test that puts an email into a use-case name, a model-card limitation, a
    `properties[].value` and an object key (PR #265).

R11. **PII verdicts map from the persisted vocabulary.** `training_datasets.pii_verdict` is `clean | flagged | blocked`
    (`TRAINING_SCAN_VERDICTS`). `flagged` and `blocked` render as CycloneDX `sensitiveData: ["pii"]` and SPDX
    `hasSensitivePersonalInformation: yes`. `clean` renders as no `sensitiveData` entry and SPDX `noAssertion`, with
    the verdict as a `regulait:` property, because a clean scan is not proof of absence. Any other value fails the
    build.

R12. **Evidence is complete and its scanners are exact.** Declarations include every `model_card_evidence` row
    (`eval_run`, `external`, `engine_scan`) that supports an approved model card, each as a claim with its evidence,
    not only `artifact_scans`. Each engine is a `container` component keyed by engine, version and image digest
    (`artifact_scans` allows repeated runs, so one engine name can have several versions in one snapshot), and every
    attestation names the exact scanner component that produced it.

R13. **The SPDX offline driver fails on no input.** Amendment 4's offline driver exits non-zero when it is given no
    document, so a misconfigured CI command cannot pass without validating anything.

R14. **Not reproduced or already covered.** The finding that the ADR still calls `spdx3-validate` air-gapped and that
    B5 lacks the offline path was already resolved by amendment 4 (commit `cb52d25`, after the reviewed spike commit);
    the libraries-table row is now updated to match. The finding that the B0 evidence is missing is answered above:
    it is on `b6-bom-b0` (PR #265), not on this branch, by design.

### Third review round (2026-10-10)

A third review of PRs #253 and #265 raised further findings. Each was checked against this ADR and the code on
`main` (`apps/gateway/src/decision-receipts.ts`, `apps/gateway/src/org-settings.ts` `runAuditPruneOnce`,
`apps/gateway/src/export-bundle.ts`, `packages/shared/src/audit-scrub.ts`, migrations 0168 and 0170, and the
`usage_events`, `model_cards` and `eval_datasets` tables in `packages/db/src/schema.ts`). All were real; none needed an
owner choice. They bind B1 to B8 like R1 to R14. R25 to R28 answer four further comments from the same round, and R29 to R32 the spike's comments on real-table mapping.

R15. **Late facts survive a signing-key outage.** With no receipt key the sweep returns `no_key` while governed calls
    go on (`decision-receipts.ts`, `runDecisionReceiptSignSweep`), so R5's "signed when written" would force an
    addendum writer to fail after the upstream side effect or drop the fact. Now capture and signing are separate,
    as they already are for receipts:
    - An addendum row is written **unsigned**, key-independent, in the transaction that records the late fact
      (`decision_fact_addenda`: `audit_id`, `n`, `prev_hash`, `facts`, `facts_hash`, `created_at`), hash-chained from
      the decision's `facts_hash`. Immutability trigger; no signature column.
    - The receipt sign sweep signs addenda in order once a key is present, into a separate append-only table
      `decision_fact_addendum_signatures` (`audit_id`, `n`, `facts_hash`, `signature`, `key_id`, `created_at`), under
      `v = regulait.decision-facts-addendum.v1`. The sweep re-checks the hash chain before it signs, as it re-checks
      audit rows today, and signs nothing past a break.
    - A Decision BOM is frozen only when the receipt **and every addendum that exists at assembly** are signed;
      otherwise the route answers 409 `bom_signing_unavailable` (no key) or `bom_anchor_pending` (not yet signed).
      An unsigned addendum is never assembled, never dropped, and never frozen as `not_recorded`.

R16. **Retention pruning works through the immutability rules.** OWNER DECISION 11 deletes BOM evidence at the end of
    audit retention, but the BOM tables are append-only and `decision_facts` was sketched with a foreign key to
    `audit_log`, which `runAuditPruneOnce` deletes directly. Now:
    - No BOM table has a foreign key to `audit_log` (the `decision_receipts` rule, migration 0170 §7): facts,
      addenda, addendum signatures and Decision BOMs outlive a pruned audit row, so the audit prune is never blocked.
    - Rows are deleted only by one prune function, run after the audit prune in the same scheduler pass. Each BOM
      table's trigger refuses every UPDATE and admits a DELETE only when all of these hold, checked in the database:
      the transaction has written a `bom_retention_prunes` row (append-only; cutoff, counts, actor; the audited record
      of the pass); the row's `created_at` is older than that cutoff; for decision-scoped rows, the audit row is
      already gone (the 0168 "parent gone" test with `audit_log` as the parent); and no evidence hold covers it. A
      direct DELETE, or one that fails any test, raises as `regulait_refuse_mutation` does.
    - AI BOM snapshots: the newest snapshot of each subject, and any snapshot that a retained Decision BOM links to,
      are kept only while R38 allows. `bom_renderings` go with their parent by cascade (R36).

R17. **Snapshot routes are enabled only once both B4 and B5 have merged.** R2 let B5 enable the snapshot routes while
    B4, which builds `export-bundle/3` (R7), might not have merged. The enable switch moves out of B5: it flips in
    whichever of B4 and B5 merges second, and that PR's tests download every format as a verified `export-bundle/3`.
    Until then the routes answer 501 `bom_snapshots_not_released`. B4 and B5 still run in parallel.

R18. **Facts carry the row projections, not only their digests.** R5 stored SHA-256 digests and reloaded the source
    rows at assembly, so an approval, usage event, span, grant, token or identity row pruned or changed before the
    first BOM request made its section unbuildable, and the actor and delegation rows were not bound at all. Now
    `decision_facts` and each addendum store the **fixed canonical column projection** of every row they bind (the
    column list per table defined once in the B1 shared zod; ids, digests, enums, integers and times only, never free
    text), and the digest is computed over that stored projection. The `actors` section is captured at decision time
    the same way: the actor chain, the grant's id, `path`, `depth`, scope and cap, `binding_kind`, thumbprint,
    `auth_credential_id` and the workload identity URIs. The assembler builds every section from the stored
    projections only and never reads a live table for a historical fact; a later grant change or revocation cannot
    reach a Decision BOM.

R19. **The offline verifier checks AI BOM bundles too.** §6 verified only Decision BOMs, and the stock
    `verify-export-bundle.sh` checks only the outer manifest, which the export key alone can forge. `verify.ts` and
    the script (renamed `scripts/verify-bom.mjs`, one tool for both subjects) gain an AI BOM branch: the native body's
    Ed25519 signature against the out-of-band trust root; `v` is `regulait.ai-bom.v1` and the bundle subject is
    `ai-bom`; each rendering file's SHA-256 and byte length equal the values in the signed body; the serial number
    equals the v8 UUID derived from the snapshot id (amendment 5); and `supersedes` when the earlier snapshot is in
    the bundle. A rendering whose hash is not in the signed body is `invalid`. Codex's specification-only vectors
    cover this branch.

R20. **Install snapshots use a fixed, non-null internal subject key.** ADR-0116 allows an install with no
    `REGULAIT_INSTALL_ID` and no licence, and refuses a generated install id. `ai_bom_snapshots.subject_id` is
    `NOT NULL`; for `subject_kind = install` a CHECK fixes it to the nil UUID (one database holds one install), so
    the UNIQUE (`subject_kind`, `subject_id`, `version`) constraint and `supersedes` stay sound and never fork on key
    rotation. This key is internal only and is never exported as an identity; the exported install identity follows
    ADR-0116 (operator-set, licence-derived, or absent and said so).

R21. **The email scan covers the whole bundle.** `export-bundle/3` adds files outside the native body and renderings
    (the manifest, the README, the operator-set `installId`, which is unconstrained), and the audit scrub keeps emails
    by design (`audit-scrub.ts`). B4 therefore runs R10's scan over every final bundle entry, after the bundle is
    assembled and before it is signed, and refuses the export naming the file and path. The BOM bundle profile also
    carries no audit-row payloads, only the `chain.tsv` hash columns (R39: no preimage of any row, the decision row
    included); an `installId` that matches the scan refuses the export until the operator changes it.

R22. **An AI BOM is loaded from one consistent snapshot.** B3's loader reads every source table in a single
    `REPEATABLE READ READ ONLY` transaction, so a model card, prompt promotion or admission changing mid-load cannot
    produce a mix of states that never existed. The `basis` records, for each loaded row, its table, id and the
    SHA-256 of its canonical projection (as R18), so the snapshot's inputs can be reproduced and a disputed read
    diagnosed.

R23. **Cost is stored losslessly.** `usage_events.cost_usd` is a double precision column, so integer micro-dollars
    would round a sub-micro-dollar cost to zero with no stated rule. The `cost` section carries `costUsd` as a string:
    the ECMAScript shortest round-trip decimal form of the stored double (what `Number.prototype.toString` and RFC
    8785 produce), which parses back to the identical double, plus `costSource: usage_events.cost_usd`. No rounding
    happens anywhere; integer money is not used for this field. A null cost is `not_recorded`.

R24. **Evaluation datasets map only what is recorded.** `eval_datasets` has no checksum, classification, owner or
    PII verdict (only id, name, version, scorer and creator). B3 therefore renders an evaluation dataset with: a
    SHA-256 computed by the loader over the canonical projection of that version's `eval_cases` rows (versions are
    frozen once a run references them, ADR-0067), labelled `regulait:dataset:digestOf = eval_cases`; no
    classification, governance owner or `sensitiveData`; the property `regulait:dataset:piiVerdict = not_scanned`;
    SPDX `hasSensitivePersonalInformation: noAssertion` and no confidentiality level; and the dataset listed in an
    `incomplete` composition. The creator is never presented as the owner. `training_datasets` has `checksum` and
    `pii_verdict` but no classification or owner column either: its classification is the linked project's
    `data_sensitivity` when `project_id` is set and absent otherwise, it has no governance owner, and an empty
    `checksum` (the column default) means no hash, not a hash of nothing. Each such gap puts the dataset in the
    `incomplete` composition.

R25. **Automatic snapshots survive a signing-key outage** (open: owner item 3 may replace this queue with a fail-closed
    trigger or a recorded skip; B3 does not build the queue until the owner decides). With no receipt key, an OWNER DECISION 8 trigger
    (use-case approval, model card approval, prompt promotion, evidence attached, config promotion, admission) could
    neither sign its snapshot nor be retried later without reading state that has since changed. The triggering
    operation does not fail; instead, in its own transaction, B3 writes an append-only
    `ai_bom_snapshot_requests` row (subject, trigger, the triggering record's id, `created_at`) together with the
    loaded record set captured under R22's consistency rules (the R18 projections and the row-level basis), with
    no key involved. This queued path is **read-write**: it runs inside the triggering operation's own transaction,
    which B3 sets to `REPEATABLE READ` (set before its first query), so the triggering write, the captured records and
    the request row commit or roll back together, and the capture sees exactly the state that write produced. A
    serialization failure retries the whole triggering operation. R22's `READ ONLY` applies only to the on-demand
    loader, which writes nothing. A sweep freezes and signs pending requests in order once a key is present, from the captured
    record set only, never by reloading live tables; each snapshot's `created_at` and `trigger` are the request's.
    The posture page shows the count of pending requests. Requests are written only after the R17 switch has flipped;
    before that a trigger records nothing, as R2 says.

R26. **Every dataset hash is a valid, honest digest.** CycloneDX hashes carry an algorithm and a bare digest.
    - `training_datasets.checksum` is self-describing (`datasetChecksum`, `packages/training-provider`):
      `sha256:<64 hex>:<row count>` is parsed into a `SHA-256` hash of the hex part plus a
      `regulait:dataset:rowCount` property; a value of any other form fails the parse.
    - A retained pre-0176 `fnv1a32:` value is not a standard hash and is never relabelled as SHA-256: it is emitted
      only as the property `regulait:dataset:legacyChecksum`, with no `hashes` entry, and the dataset is in the
      `incomplete` composition. An empty checksum (the column default) gives no hash and the same composition.
    - An evaluation dataset's hash (R24) is SHA-256 over the RFC 8785 bytes of the array of its version's
      `eval_cases` projections (a fixed column list in the B1 shared zod), ordered by case id, labelled
      `regulait:dataset:digestOf = eval_cases`. The verifier can recompute it only from the cases, which never leave
      the boundary; the BOM says so.
    - SPDX `verifiedUsing` follows the same rules.

R27. **Data flows are keyed to each use case, never collapsed.** §3's service `data` flows take the classification
    from one project's sensitivity, which an agent-scoped or install-scoped snapshot does not have: an agent can serve
    several use cases with different `data_sensitivity`. For those snapshots each provider endpoint carries one
    outbound and one inbound flow **per use case that references the agent**, each with that use case's
    classification and a `regulait:dataFlow:useCase` property naming the use case id. An agent that no use case
    references gets flows with no classification and `regulait:dataFlow:classification = unknown`, and is listed in
    the `incomplete` composition. Distinct classifications are never merged into one, and no project is picked
    arbitrarily. A use-case-scoped snapshot keeps §3's single flow pair.

R28. **B7 waits for the renderer release.** B7's install-scope AI BOM is a snapshot, so it is subject to R2 and R17.
    B7 now depends on B3, B4 and B5; it may be developed in parallel, but its release job stays inactive (it produces
    no snapshot and publishes nothing) until the R17 switch has flipped.

R29. **Artifact-to-agent edges are many-to-many.** `model_artifacts` has no agent column, and one `artifact_scans`
    row may be cited by model cards of several agents (`model_card_evidence` is unique only on card and scan). B3
    derives each edge through `model_card_evidence.artifact_scan_id` → the card → the card's subject (agent or custom
    provider), and keeps every edge it finds. An artifact with no such path is listed with no dependency edge and
    is in the `incomplete` composition; no association is picked or invented.

R30. **No fabricated value, from any real table.** B3 maps only what a column records, and states the rest as
    unknown:
    - `model_card_evidence` and `artifact_scans` persist no digest of the evidence itself (the scan row holds the
      scanned artifact's SHA-256). An evidence entry carries the kind-specific reference (eval run id, artifact scan
      id, external reference) and a digest only where one is persisted or canonically derived under a rule B1 writes
      down; otherwise it says `digest: not_recorded`. A value such as `sha256:undefined` is a build failure.
    - `standard_refs` are display-only identifiers or prose: they render as `regulait:standardRef` properties, never
      as `externalReferences` URLs. A URL reference needs its own validated field.
    - A service's `authenticated` comes from the provider's or connector's credential record (for example a custom
      model provider with no key is `false`); with no recorded state it is omitted, never defaulted to `true`.

R31. **Every subject kind is built, from its own root.** The spike rendered only use-case subjects. B3 branches on
    `subject_kind`: a use case roots at the use case; an agent or builder agent roots at that agent (its flows per R27);
    the install roots at the install (the R20 key, ADR-0116 identity or none). No subject is rendered through a
    synthetic use case. B3's tests render and validate one snapshot of each of the four kinds.

R32. **B3's loader is tested against real row shapes, not the spike fixtures.** The B0 fixtures were invented shapes,
    and this round found several fields that no table has (a singular artifact agent, evidence digests, URL standard
    references, a model card's task and architecture columns, eval dataset metadata). B3 and B5 test the loader and
    renderers with rows built from the `packages/db` schema types (through the real migrations in the integration
    tests), including nulls and column defaults, and a test fails if any rendered value has no source column or
    stated derivation. The spike's fixtures are not a contract.

### Fifth review round (2026-10-10)

Three findings against `91b0db0`, each checked against `main`; all real, none an owner choice.

R33. **The proof carries the timestamp request facts.** `verifyTimestampResponse`
    (`apps/gateway/src/audit-timestamp-verify.ts`) needs the request nonce and the time the request was sent: it
    refuses a missing or different nonce and a `genTime` more than five minutes before `sentAt`. `audit_anchors`
    already stores `tsa_nonce` and `tsa_policy_oid` but not the send time. So:
    - B1 adds `tsa_request_sent_at` (database clock), written in the same statement that records the nonce before
      the request leaves; a granted row without it fails the `audit_anchors_tsa_granted_check`, extended to require
      it with the nonce. No grandfathering: a token granted before the column exists has no send time, and the
      verifier reports its RFC 3161 check as `unverifiable` with reason `request_facts_not_recorded`, never `valid`.
    - `proof.anchor` adds `tsaNonce`, `tsaRequestSentAt` and `tsaPolicyOid` as stored, inside the signed body.
    - The offline verifier runs the same checks as `verifyTimestampResponse` (imprint from R1's canonical record,
      nonce, policy, `genTime` window against `tsaRequestSentAt`, chain to the supplied TSA trust bundle), using the
      verification time as `now`.

R34. **Receipt v2 is switched on at a recorded boundary, after every replica and writer is ready.** The sign sweep
    checks the chain tip against its own `RECEIPT_PAYLOAD_VERSION` and aborts when that fails
    (`apps/gateway/src/decision-receipts.ts`), so a v1-only replica stops at the first v2 tip, and a v2 emitted while
    `factsHash` is still null signs a missing fact for good. So, mirroring ADR-0188 decision 19:
    - B1 and B2 ship code that **verifies** v2 but still **emits** v1. Nothing emits v2 because a binary was
      deployed.
    - The cutover writes a boundary row (the first audit seq v2 governs, R42; activation time, actor) under the
      receipt sign lock, in a verifier-trusted table, as an audited admin step, after the drained rollout and with
      the boot refusal of R43 (after B2 and ADR-0188 S4).
      The receipt v2 payload is shared with ADR-0188 decision 9 (open question 1), so this is one cutover for both.
    - From the boundary on, every receipt is v2, a v1 receipt after it is `invalid`, and a binary that does not
      know v2 refuses to sign (it already fails closed). The boundary is never moved back.
    - A v2 receipt carries `factsHash` for every decision; it is null only when `decision_facts_capture` was off
      for that decision, with `factsStatus: capture_off` inside the signed payload. Any other missing facts stop
      the sweep, as an integrity failure does today.

R35. **Addenda are sequenced under a per-decision lock.** Two late facts for one decision (a usage event and a span)
    could both take the same `n` and `prev_hash` and fork the chain, and a uniqueness constraint alone would make
    one of them fail. So `decision_fact_addenda` has PRIMARY KEY (`audit_id`, `n`) and `n >= 1`. A writer takes
    `SELECT … FOR UPDATE` on the decision's `decision_facts` row in its own transaction, then reads the last
    addendum, and writes `n + 1` with `prev_hash` equal to that addendum's `facts_hash` (or the decision's
    `facts_hash` for `n = 1`). Concurrent writers for one decision therefore wait, never fork and never fail;
    writers for different decisions do not contend. A decision with no `decision_facts` row (capture off) gets no
    addendum; its late facts are `not_recorded`. The sign sweep (R15) signs in `n` order and stops at a gap or a
    `prev_hash` mismatch.

### Seventh review round (2026-10-10)

Nine findings against `4419a08`, each checked against `main` (`export-bundle.ts`, `audit-chain.ts`
`S3ObjectLockSink`, migration 0168, ADR-0188 decision 19); all real, none an owner choice.

R36. **Renderings have real parent keys.** `bom_renderings` replaces the polymorphic `owner_kind`/`owner_id` with two
    nullable foreign keys, `decision_bom_id` → `decision_boms` and `ai_bom_snapshot_id` → `ai_bom_snapshots`, both
    `ON DELETE CASCADE`, a CHECK that exactly one is set (`num_nonnulls(...) = 1`), and UNIQUE (parent, `format`).
    Its append-only trigger admits a DELETE only as the cascade of whichever parent is set, once that parent row is
    gone (the 0168 own-parent test, applied to the non-null column).

R37. **The Decision BOM carries the exact facts it is verified against.** The body includes `facts.payload`, the
    exact canonical bytes of `decision_facts.facts` (as a string), and `facts.addenda`, each addendum's exact
    canonical bytes with its `n`, `prev_hash`, signature and key id. The verifier hashes those bytes and compares
    them with the receipt's `factsHash` and the addendum chain. The `action`, `policy`, `model`, `approval`,
    `outcome`, `cost`, `trace` and `actors` sections are defined as a pure projection of those payloads (the mapping
    lives once in the B1 shared zod and in `verify.ts`); the verifier recomputes every section from the payloads, and
    any difference is `invalid`. The payloads hold ids, digests, enums, integers and times only (R18), so they pass
    the R21 scan.

R38. **The newest-snapshot exemption ends with retention.** R16 kept a subject's newest AI BOM snapshot
    unconditionally. Now it is kept only while the subject still exists and the snapshot is within its retention
    period. Once the subject is deleted, or the snapshot passes the cutoff with no newer snapshot, it is pruned like
    any other unless an evidence hold covers it. A snapshot linked from a retained Decision BOM is kept only while
    that Decision BOM is retained.

R39. **No audit preimage leaves in a BOM bundle; the decision row's content binding is reported unverifiable.**
    (Revised in review round 8. The earlier text exported the decision row's `audit/rows/<seq>.payload` after the
    email scan, but the canonical audit payload holds raw invocation fields, for example a connector call's
    caller-controlled `object` in `detail` (`apps/gateway/src/connector-call.ts`), so exporting it broke the
    digests-only invariant of OWNER DECISION 5. An email scan cannot detect such content.)
    - The Decision BOM bundle carries **no** `audit/rows/<seq>.payload` for any row, the decision row included. The
      chain segment is hash-only (`chain.tsv`).
    - The verifier still checks every link of the segment (`prevHash`, `rowHash`) up to the anchor. It reports the
      binding between the decision row's `contentHash` and the BOM's `decision` section as `unverifiable` with reason
      `preimage_not_exported`. `cannotProve` gains "that the audit row's content is the decision described: the
      content hash is chained and anchored, but its preimage is not disclosed".
    - **B4 entry condition:** this stays `unverifiable` unless a later slice defines a commitment over only the
      permitted projection (ids, digests, enums, integers and times) that is bound into the audit chain or the
      receipt. B4 must not disclose a raw preimage to close the gap.

R40. **Assembly holds the per-decision lock.** The freeze transaction takes the same `SELECT … FOR UPDATE` on the
    decision's `decision_facts` row as R35's writers, before its final addendum recheck, and keeps it through the
    `decision_boms` insert. A late fact therefore commits either before the recheck, so it is included or the freeze
    waits for its signature, or after the insert, so it is covered by a new version with `supersedes`.

R41. **Queued snapshot requests are drained before any new snapshot of the subject.** This is the simpler strict
    option. While a subject has pending `ai_bom_snapshot_requests`, an on-demand snapshot is refused with 409
    `bom_snapshot_requests_pending`, and an automatic trigger enqueues a request rather than freezing directly. The
    sweep freezes requests per subject in request order. A captured record set can therefore never supersede a newer
    live snapshot.

R42. **The receipt v2 boundary is an audit sequence.** R34's boundary is redefined. Under the audit append lock and
    the receipt sign lock, the cutover records `from_audit_seq`, the first audit `seq` that v2 governs. A
    receipt-eligible row below it always gets a v1 receipt, whenever the sweep reaches it, so a pre-facts backlog left
    unsigned at cutover (a slow sweep or a key outage) is signed as v1 and never stops the sweep. A row at or above it
    gets v2, and R34's facts rule applies.

R43. **Replica readiness reuses ADR-0188 decision 19.** There is no replica heartbeat or registry. R34's "every live
    replica reports" prerequisite is replaced by decision 19's mechanism:
    - the cutover is run only after a rolling deploy in which every replica runs v2-aware (B2 or later) code and the
      old replicas have been drained, as a runbook step (B8);
    - every binary from B1 on checks at boot and refuses to start when a receipt v2 boundary exists and it cannot emit
      v2 receipts with facts;
    - every receipt writer reads the boundary under the sign lock before each pass, so a v1 receipt can never land at
      or above `from_audit_seq`.

    The audit v2 and receipt v2 cutovers may be one operation (open question 1).

R44. **`anchored` requires an Object Lock that covers the retention period.** `S3ObjectLockSink` writes a finite
    `ObjectLockRetainUntilDate`, and R4 persisted only a boolean.
    - B1 adds `audit_anchors.retain_until`: the retain-until date read back from the written object version at flush,
      null when there is none.
    - A Decision BOM freezes as `anchored` only when `retain_until` is on or after the end of the decision's evidence
      retention period (decision time plus the compliance profile's audit retention). A shorter lock freezes at most
      as `anchored_unverified_destination`, an audited relaxation as before.
    - `retain_until` is inside the signed proof. The verifier compares it with the verification time and reports
      `anchored` as `anchored_lapsed` once it has passed, and `cannotProve` gains "that the external commitment
      exists after its retain-until date". A frozen body is never edited; only the reported finality changes.

### Ninth review round (2026-10-10)

Two findings contradicted accepted text and are fixed here; the rest are entry conditions or owner item 3.

R45. **Decision BOMs are id-only; no display-name relaxation.** `principal` and `actors` are projected only from
    decision-time payloads that hold no free text (R18, R37), so a display name could only come from a live read and
    would sign today's name as if it were historical. `bom_person_identifiers = display_name` therefore no longer
    applies to Decision BOMs, which are `id_only` without exception. For AI BOMs the relaxation remains, and only for
    a name read inside the snapshot's own R22 capture (and held in a queued request's capture, if owner item 3 keeps
    the queue), length-capped and email-scanned like every string.

R46. **Facts captured under v1 receipts are shown but not claimed as receipt-bound.** Between B2 and the R42 cutover,
    decisions get `decision_facts` while their receipts are still v1, with no `factsHash`. Their Decision BOM still
    carries the exact facts payloads (R37), and the verifier still checks the addendum chain from `facts_hash` and
    recomputes the sections from the payloads. It reports the receipt binding as `unverifiable` with reason
    `receipt_v1_no_factsHash`, never `valid`. `cannotProve` gains, for such a BOM, "that these facts are the ones
    recorded at decision time: the receipt does not commit to them". From the boundary on, a missing or mismatched
    `factsHash` is `invalid` as before.

### Owner items from the review (not decided here)

1. **SPDX mandatory literal properties with no known value** (R3). Options: (a) the strict default above: no SPDX
   rendering for that snapshot, with the reason recorded; (b) emit the SPDX document without those properties, marked
   `incomplete`, knowing it does not meet the AI profile's cardinality; (c) require the supplier's release time and
   download location as mandatory model-card fields before a model can be approved. Recommended: (a) now, with (c)
   added for models that will be exported as SPDX. Until the owner decides, (a) applies.
2. **Trust root for the release's SBOM identity file in air-gapped installs** (R9): verify the release's existing
   keyless signature offline against a trusted-root file shipped with the release, or an owner-held release key.
   Recommended: the existing signature with the shipped trusted root, so no new key needs custody.
3. **Automatic AI BOM snapshots while no signing key is configured** (R25; seven findings across review rounds 7–9:
   ordering, fulfilment after pruning, full-field capture, terminal failures, binding outage-time decisions, lock
   scope, writable capture). Options:
   (a) keep the R25 queue, with the B3 queue entry conditions listed under "Entry conditions from review rounds 8–9";
   (b) fail closed: an automatic snapshot trigger (use-case approval, model card approval, prompt promotion and the
   other OWNER DECISION 8 events) is refused while no signing key is configured. Strict by default under ADR-0180,
   relaxable by an admin with an audit row, and it removes the queue entirely;
   (c) skip and record: no snapshot is taken, and an audited `snapshot_skipped_no_key` gap is recorded for the
   subject. Recommended: (b), because it removes the whole class of queue findings and keeps every snapshot taken
   from live state at sign-off. The B3 queue entry conditions apply only if the owner chooses (a). Until the owner
   decides, B3 does not build the queue.

## Further design review happens at slice level

From the seventh review round on, this ADR is complete as a design record. Later design findings are not added here
as further amendments. They are recorded as entry conditions on the B1–B8 slice PR that owns them, and each slice PR
gets its own review against this ADR and those conditions. An amendment is added here only when a finding contradicts
an accepted decision or needs an owner choice.

### Entry conditions from review rounds 8–9

In this list, the B3 queue conditions apply only if owner item 3 chooses (a).


- **B3, B5** (4237322631): request fulfilment is idempotent; `ai_bom_snapshots` carries the `request_id` of the
  `ai_bom_snapshot_requests` row it fulfils, UNIQUE, so a retried sweep cannot freeze one request twice.
- **B3** (4237322637): the agent's active and canary system-prompt config versions are components, each with its id,
  version and content digest only, never the prompt text.
- **B1, B3** (4237322632): snapshot `version` is allocated under a per-subject lock, as R35 does for addenda.
- **B1, B2** (4237322635): every receipt-eligible decision persists a receipt-bound capture-status marker in its own
  transaction, including `capture_off` when capture is off, so the receipt never infers the status later.
- **B1, B4** (4237322627): decision-scoped rows (facts, addenda, addendum signatures, Decision BOMs, their renderings)
  share one `expires_at` computed from the decision's audit timestamp, and R16's prune uses it.
- **B4** (4237322624, see R39): the decision row's content binding stays `unverifiable` unless a commitment over only
  the permitted projection is defined; no raw preimage is ever exported.
- **B1, B4** (4237344247): Decision BOM assembly and version allocation lock a row that exists for every decision:
  the round-8 capture-status marker row (`SELECT … FOR UPDATE`), or, for a decision older than that marker, an
  advisory lock keyed by the audit id. Two concurrent first requests then return the same frozen BOM.
- **B2, B3** (4237344250): a decision made while an AI BOM request is queued for its subject records that request's id
  in its facts, and assembly links the request's unique fulfilled snapshot (by `request_id`), never the last frozen
  one or a later pick.
- **B3** (4237344238): `model_cards.data_claims` is an arbitrary record, so the loader projects it to a typed safe
  shape before signing: allowlisted keys only, scalar strings (length-capped), numbers and booleans; any nested
  object or array, or unknown key, is refused, never copied.
- **B2** (4237346656): fact and capture-status capture sit behind one shared, transaction-aware audit writer, used by
  every `receiptClass: "decision"` writer. B2 lists them all: at least the governed paths above plus
  `mcp-protocol.ts`, `workbench.ts`, `playground.ts`, `compiled-egress.ts`, `connection-egress.ts`, `engine-runs.ts`,
  `redteam.ts` and `compat-core.ts`, and any others a grep finds. A test fails on any decision writer that bypasses
  the shared writer.
- **B3** (4237346650): the per-subject lock is taken before the repeatable-read capture and held through the snapshot
  insert, so an older capture can never take the next version after a newer one.
- **B3, queued path only if owner item 3 chooses (a)**: an immutable fulfilment tombstone per request that survives
  snapshot pruning (4237346647); a full immutable field projection for queued snapshots, including the mapped
  free-text model-card fields, length-capped and email-scanned (4237346653); a terminal `failed` or `cancelled`
  outcome that removes a request from the pending queue (4237346644); and binding outage-time decisions to the
  request (4237346659, with 4237344250 above).

## Open questions

1. **Receipt payload v2.** ADR-0188 decision 9 adds sponsor, actor chain and grant id to receipts; this ADR adds
   `factsHash`. Proposed: one `regulait.receipt.v2` carrying both, defined once in ADR-0188 S1 and emitted only after
   the recorded cutover of amendment R34 (never with a null `factsHash` except `capture_off`), so receipts never go
   through a v3. Needs agreement with ADR-0188's slice owner before S1
   freezes.
2. **Suite gating.** CLAUDE.md requires checking the suite capability map before building what another module may own
   (evidence export, AI inventory). The suite documents are not reachable from this session. Proposed: the suite agent
   confirms RegulAIt owns PF-09 for its own gateway before B1.
3. **Workflow-stage and use-case sign-off decisions.** Should ADR-0182 decision records and workflow stage approvals
   also get Decision BOMs in v1, or only receipt-eligible governed calls and approvals? Proposed: governed calls and
   approvals in v1; the others next, as new `decision.kind` values.
4. **Properties namespace.** Our `regulait:` CycloneDX property names could be registered in the CycloneDX property
   taxonomy so consumers can rely on them. Proposed: register once B3's names are stable.
5. **EU AI Act Annex IV mapping.** Whether an AI BOM snapshot should be offered as part of the technical documentation
   export of a high-risk use case. Not decided here.
6. **OWASP AIBOM field guidance.** Resolved by spike B0 (R12 §6, on PR #265, branch `b6-bom-b0`): the field registry
   was read and its additions are amendment 8 above. The OWASP project page returned 404 and was not read; B3
   re-checks it if it comes back. Nothing further is open here.
7. **The argument digest coverage** (Context): if B2 finds receipt-eligible paths that never compute
   `argumentsDigest`, those paths record `not_recorded` until a follow-up computes it.

## Consequences

- PF-09 becomes demonstrable: one signed, offline-verifiable document per governed decision, and a standards-format AI
  BOM per use case, agent and install, with honest `not_recorded` and `incomplete` markers where we lack data.
- Every governed decision writes one more row in its transaction (`decision_facts`). B2 measures the cost; it does not
  get a cache or a deferred writer, because a deferred writer is what would let facts drift from the decision.
- ADR-0188's actor chain becomes visible to auditors through the Decision BOM, which meets PF-02's acceptance line
  for BOMs. Decisions made before the ADR-0188 boundary say so.
- We take on a narrow ADR-0176 §4 exception (our own CycloneDX and SPDX emitters, validated against the official
  schemas) until a maintained library models the ML-BOM fields; B0 and each library upgrade re-check it.
- Receipts move to a v2 payload once (open question 1); the verifier keeps accepting v1 receipts.
- The audit and receipt keys gain one more use; HSM-backed keys stay owner-gated with HSM/FIPS (ADR-0183).
- Not decided here: in-toto/DSSE views (until asked), A2A agent cards in the AI BOM (after PF-02's A2A work),
  transparency-log entries for BOMs, and any production designation (standing guardrail).

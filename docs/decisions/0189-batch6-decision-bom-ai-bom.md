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
| `spdx3-validate` 0.0.7 (PyPI) | MIT | 2026-08-10 | Yes (pyshacl, rdflib, jsonschema) | **CI only, not shipped:** full SHACL conformance of our SPDX output against the official model, pinned in a CI job like ADR-0184's tools |
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
| `approval` | approval id, quorum, each decider id, step-up method, passkey `signed_digest` and credential id | `approvals`, `approval_decisions` |
| `outcome` | result status, refusal code, upstream status class, post-action verification result where a workflow stage recorded one | `audit_log`, `trace_spans`, workflow records |
| `cost` | usage event ids, tokens, cost in integer **micro-dollars** (never floating point in a signed body) | `usage_events` |
| `trace` | trace id and span ids (no previews) | `trace_spans` |
| `proof` | the audit-chain segment from the decision row to the anchor that covers it (`seq`, `contentHash`, `prevHash`, `rowHash` per row, as ADR-0116's `chain.tsv`), the anchor (`row_hash`, destination, `external_ref`, `flushed_at`), and the RFC 3161 token where one exists | `audit_log`, `audit_anchors` |
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
| Provider API endpoint | `service` with `endpoints`, `trustZone`, and **`data` flows** (direction and classification: what the model receives and returns, by the project's sensitivity). This is PF-09's "per-model data flow" |
| `model_artifacts` | component (type `machine-learning-model` or `file`) with SHA-256 hash and format |
| `artifact_scans`, `model_card_evidence` (`engine_scan`, `eval_run`, `external`) | `declarations` (attestations: the claim, the scanner and version, the verdict, evidence references); the engine is a `container` component with its `image_digest` |
| `training_datasets`, `eval_datasets` | component type `data` with `data[].type = dataset`, hash from `checksum`, classification, `governance` (owner), sensitive-data flag from `pii_verdict` |
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
unknown.

### 4. Decision facts are captured in the decision's transaction

New append-only table `decision_facts`, one row per receipt-eligible audit row, written in the same transaction as the
audit row by the governed paths (`mcp-proxy.ts`, `connector-call.ts`, `governed-evaluate.ts`, the approvals and
agent-dispatch writers): the versions, digests and classifications of the `action`, `policy` and `model` sections.
Its canonical bytes hash to `facts_hash`. The receipt payload carries `factsHash`, so the receipt signature covers the
facts (open question 1: one receipt payload v2 shared with ADR-0188 decision 9). Free text never enters
`decision_facts` (ids, digests, enums and integers only), so no new prose column needs the ADR-0102 scrub (M-055 check
done at B1 anyway).

### 5. Signing, freezing and exact-byte reproducibility

- **Signer:** the ADR-0186 receipt key (`REGULAIT_RECEIPT_SIGNING_KEY`, `receipt_signing_keys`), Ed25519 over the
  RFC 8785 bytes of the BOM body. Domain separation is by the body's `v` field (`regulait.decision-bom.v1`,
  `regulait.ai-bom.v1`), which is inside the signed bytes; every verifier rejects an unknown `v`, so a receipt
  signature can never verify as a BOM or the reverse (OWNER DECISION 2). No key, no BOM: 409 `bom_signing_unavailable`;
  there is no unsigned fallback and no key generated on the box (the ADR-0116 rule).
- **Freezing:** a Decision BOM is assembled on first request and **frozen** (stored bytes, hash, signature) only once
  the decision's receipt is signed and an anchor covering its audit row has flushed (with an RFC 3161 token when
  `audit_anchor_timestamp_mode` is `required`); before that the route answers 409 `bom_anchor_pending` with a
  `Retry-After` (OWNER DECISION 4). An AI BOM snapshot is frozen when it is taken.
- **Exact bytes:** an export always returns the stored bytes; nothing is re-rendered after freezing. The builder is a
  pure function of the `basis` watermarks and stored rows, with no clock reads (times come from rows), no random
  values (the CycloneDX `serialNumber` is a UUID derived from the snapshot id, fixed at freeze), sorted lists, and
  integer money. Renderings (CycloneDX 1.7, 1.6, SPDX) are produced once at freeze with the pinned libraries and
  stored with their SHA-256 inside the signed native body. A test rebuilds every document from its basis on another
  replica and after unrelated writes, and requires identical bytes.
- **New facts make new versions.** A later fact (a post-action verification, a late timestamp) produces version
  `n+1` with `supersedes`; the earlier version is never edited.

### 6. Verification, offline

- `packages/shared/src/bom/verify.ts` (pure, no I/O) and `scripts/verify-decision-bom.mjs` verify a Decision BOM
  bundle with an out-of-band trust root only (`--fingerprint` or `--keyring`, as ADR-0116); the key inside a bundle is
  a convenience, never the authority (the lesson of ADR-0186 review finding R21-01, "online verify trusts the bundle's
  keys").
- Checks: the body signature; the receipt signature and that the receipt's `factsHash` equals the facts in the body;
  the audit-chain segment row by row up to the anchor; the anchor's row hash; the RFC 3161 token with `pkijs` against
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
| `decision_bom_finality` | `anchored` (and timestamped when `audit_anchor_timestamp_mode = required`) | `chain_signed` (freeze once the receipt is signed, before the anchor; the BOM records `proof.anchor: absent`) | audited |
| `bom_export_roles` | admins only | admins plus an explicit auditor grant | granting is an admin act, audited |
| `bom_person_identifiers` | `id_only` (user and workload ids) | `display_name` | audited; emails are never included (see invariants) |
| `ai_bom_snapshot_triggers` | on sign-off events (OWNER DECISION 8) | on demand only | audited |
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

- `decision_facts` (`audit_id` PK → `audit_log.id`, `audit_seq`, `facts_version`, `facts` jsonb, `facts_hash`,
  `created_at`). Append-only, immutability trigger.
- `decision_boms` (`id`, `audit_id`, `version`, `supersedes_id`, `body` (exact canonical bytes as text), `body_sha256`,
  `signature`, `key_id`, `basis` jsonb, `created_by`, `created_at`; UNIQUE (`audit_id`, `version`)). Append-only.
- `ai_bom_snapshots` (`id`, `subject_kind` `use_case | agent | builder_agent | install`, `subject_id`, `version`,
  `serial_number` uuid, `supersedes_id`, `trigger`, `basis` jsonb, `body`, `body_sha256`, `signature`, `key_id`,
  `created_by`, `created_at`; UNIQUE (`subject_kind`, `subject_id`, `version`)). Append-only.
- `bom_renderings` (`owner_kind` `decision_bom | ai_bom`, `owner_id`, `format` `cyclonedx-1.7 | cyclonedx-1.6 |
  spdx-3.0.1 | in-toto`, `bytes`, `sha256`, `validator`, `created_at`; PK (`owner_kind`, `owner_id`, `format`)).
- Settings rows for decision 7; the auditor export grant.
- Retention follows the audit retention of the compliance profile and respects evidence holds (OWNER DECISION 11).
- Receipt payload v2 field `factsHash` (open question 1).

### 9. API and UI surface

Every route is audited (who exported what), rate-limited, and refuses anyone outside `bom_export_roles`.

- `GET /v1/ai-bom/:subjectKind/:subjectId` — the live, **unsigned draft**, labelled as such, for review.
- `POST /v1/ai-bom/:subjectKind/:subjectId/snapshots` — freeze and sign a snapshot.
- `GET /v1/ai-bom/snapshots/:id?format=native|cyclonedx-1.7|cyclonedx-1.6|spdx-3.0.1` and `…/:id/bundle`.
- `GET /v1/ai-bom/:subjectKind/:subjectId/drift` — the live draft against the last signed snapshot (added, removed,
  changed hash, changed version).
- `GET /v1/decisions/:auditId/bom` (signed document; 409 `bom_anchor_pending`, 409 `bom_signing_unavailable`) and
  `…/bom/bundle`.
- `POST /v1/boms/verify` — the same pure verifier, run online for convenience; it uses the server's recorded keys as
  the trust root and says so in the result.
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
- **Hosted fast-start:** identical; the posture page shows "Decision BOM: unsigned" until a receipt key is set.

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
| **B1 foundation** | Claude | Migration `0181+` (decision 8 tables, settings, immutability triggers), `schema.ts`, shared zod for `regulait.decision-bom.v1` and `regulait.ai-bom.v1`, strict settings with audited relaxation, every route as a 501 stub, receipt payload v2 `factsHash` as agreed under open question 1 | B0 go; ADR-0188 S1 merged (shared migration journal) | serial (hot files) |
| **B2 fact capture** | Claude | `decision_facts` written in the decision transaction on every governed path; `factsHash` in receipts; the `actors` facts read from ADR-0188's columns | B1; **ADR-0188 S4 merged** (same files, and the actor chain must exist) | serial |
| **B3 AI BOM builder and CycloneDX renderer** | Claude | `packages/shared/src/bom/` pure builder from a loaded record set, CycloneDX 1.7 and 1.6 renderers, validation, compositions; gateway loader, snapshot, drift and draft routes | B1 | **Yes**, with B2 (no shared files) |
| **B4 Decision BOM assembler, signer, bundle and verifier** | Claude | Assembly from facts and stored rows, freezing rules, signing with the receipt key, `export-bundle/3`, pure verifier and `scripts/verify-decision-bom.mjs`, `POST /v1/boms/verify` | B2, B3 (BOM-Link) | serial after B2 |
| **B5 SPDX 3.0.1 renderer** | Claude | `ai_AIPackage`, `dataset_DatasetPackage`, licence relationships; schema validation in the product, `spdx3-validate` in CI | B3 | **Yes**, with B4 |
| **B6 web UI** | Codex | Decision 9's tabs, actions and verify panel; drift view; posture rows | B1 stubs | **Yes** (web only); merges after B4's real routes |
| **B7 our own AI BOM** | Claude | An install-scope AI BOM per release, BOM-linked to ADR-0184's SBOMs in `security.yml`; PathForward's "inventory of AI tools in the development stack" as a checked-in, reviewed list rendered into it | B3 | **Yes**, with B4–B6 |
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
- **No content.** Seeded prompts, arguments and outputs containing canary strings never appear in any BOM, rendering or
  bundle; an email address in any input field fails validation.
- **Finality.** Before the anchor flushes → 409 `bom_anchor_pending`; after → frozen; with the relaxed setting →
  frozen with `proof.anchor: absent`, and the relaxation is audited.
- **No key.** Unset receipt key → 409 on every BOM route; no key is generated.
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

## Open questions

1. **Receipt payload v2.** ADR-0188 decision 9 adds sponsor, actor chain and grant id to receipts; this ADR adds
   `factsHash`. Proposed: one `regulait.receipt.v2` carrying both, defined once in ADR-0188 S1 (fields nullable until
   B2 fills `factsHash`), so receipts never go through a v3. Needs agreement with ADR-0188's slice owner before S1
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
6. **OWASP AIBOM field guidance** was not read (decision table above); B0 reads it and reports any field we should
   add.
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

# P18 step 1 — coverage audit against the AI governance frameworks map

**Date:** 2026-11-07 · **Backlog:** [PENDING.md §2d P18](../product/PENDING.md) · **Scope:** docs only, no code.

**What this is:** a coverage map. For each node of the frameworks map in PENDING §2d, it says whether the product has a
feature that maps to or enforces it. **It is not a claim of compliance, conformity or certification for RegulAIt or for
any customer.** Every pack we ship is an accelerator with `provenance.reviewedBy: null` (ADR-0058). Where the packs map a
framework, the mapping is RegulAIt's judgement and has had no domain review.

**Method:** four parallel read-only searches (regulation, standards, roles, controls) over the seed packs
(`packages/shared/src/compliance-packs.ts`), the vendored imports (`packages/shared/src/framework-imports-data/`,
ADR-0215), the EU AI Act ruleset (`packages/shared/src/eu-ai-act.ts`), the ADR index and the gateway/schema code. The master
spot-checked the cited ADR files and statuses, the seed pack framework list, the four Art. 5 rules and the
DPIA/FRIA search. Nothing was run; "built" means an Accepted ADR plus code exists, not that runtime behaviour was tested.

**Status key:** **built** = a feature covers the node's core; **partial** = some of it, with the named gap; **missing** =
nothing beyond a mention in PENDING or a feed item; **unverified** = could not be confirmed from the repo.

**Licensing of source texts:** ISO/IEC standards are copyrighted, so they are cited by clause ID only (the `iso-42001`
pack already says so). OWASP Top 10 lists are CC BY-SA, so ID only (the repo vendors only IDs and names, via promptfoo's
MIT table; OWASP's own licence is not yet recorded in `THIRD_PARTY.md`). MITRE ATLAS is Apache-2.0 and NIST content is US
public domain/CC0, so their text may be stored. The OECD, UNESCO and G7 texts and the non-EU laws have no licence recorded:
**unverified**, cite by ID until checked.

---

## 1. Summary table

| Group | Node | Status |
|---|---|---|
| Regulation · EU AI Act | Art. 5 prohibited practices | partial |
| | Annex III / Art. 6 high-risk + obligations | partial (classification built; obligations a subset) |
| | Art. 50 transparency | partial (classified only) |
| | GPAI models (Art. 51–55) | missing |
| Regulation · other AI laws | South Korea AI Basic Act | missing |
| | Japan AI Promotion Act | missing |
| | China generative AI measures | missing |
| | Council of Europe AI Convention | missing |
| Regulation · privacy | GDPR | partial |
| | CCPA/CPRA | partial (generic DSR only) |
| | India DPDP Act | partial (identifier detection + generic DSR) |
| | Brazil LGPD | partial (identifier detection + generic DSR) |
| Regulation · sector | Financial model risk | partial |
| | Medical devices | partial (classification route only) |
| | Hiring and employment | partial |
| | Consumer protection | missing (one feed item) |
| Regulation · cyber | NIS2 | missing |
| | DORA | missing (one feed item) |
| | Cyber Resilience Act | missing (related AI-BOM export exists) |
| Standards · ISO/IEC | 42001 | partial (4 controls) |
| | 23894 | missing |
| | 42005 | missing |
| | 22989 | missing |
| Standards · NIST | AI RMF 1.0 (Govern/Map/Measure/Manage) | built (mapping; all four functions) |
| | Generative AI Profile (AI 600-1) | partial (feed item only) |
| Standards · principles | OECD AI Principles | missing |
| | UNESCO AI Ethics | missing |
| | G7 Hiroshima Code | missing |
| Standards · AI security | OWASP LLM Top 10 | partial (7 of 10) |
| | OWASP Agentic Top 10 | partial (5 of 10) |
| | MITRE ATLAS | partial (mitigations only) |
| Roles · EU AI Act operators | Provider | built (role field; drives incident clocks only) |
| | Deployer | built (same) |
| | Importer | missing |
| | Distributor | missing |
| Roles · organisation | AI governance board | partial (quorum, no named board) |
| | Data protection officer | missing (custom role only) |
| | Model owner | partial (owner fields; none on model cards) |
| | Chief AI officer | missing (custom role only) |
| | CISO | missing (custom role only) |
| | Internal audit | partial (time-boxed auditor grants; no standing role) |
| Controls | AI inventory | built |
| | Risk tiering | built (EU AI Act tiers) |
| | Impact assessment | partial (free-text conditions + one ISO control) |
| | Evaluations | built |
| | Bias testing | built |
| | Red teaming | built |
| | Data classification | partial (project-level tags only) |
| | Data lineage | built |
| | DLP | built (redaction on every path unverified) |
| | Retention | partial (global audit floor) |
| | Logging / audit trail | built |
| | Incident response | built (register + clocks) |
| | Human oversight | built |
| | Agent identity | built |
| | Least privilege | built |
| | Tool permissions | built |

**Counts (57 nodes):** built 16 · partial 21 · missing 20.

---

## 2. Per-node detail

### 2.1 Regulation

| Node | Status | Evidence | Gap scope |
|---|---|---|---|
| EU AI Act Art. 5 | partial | ADR-0085; `packages/shared/src/eu-ai-act.ts:190-229` encodes 4 rules (`p-social-scoring`, `p-manipulative-techniques`, `p-emotion-workplace-education`, `p-rbi-law-enforcement-public`); feed `eu-ai-act-prohibitions-in-force`. A tier informs sign-off, it never blocks (`apps/gateway/src/use-cases.ts:379`). | Ruleset v2 with the remaining Art. 5(1) practices (e.g. vulnerability exploitation, biometric categorisation, untargeted facial scraping, predictive policing). A hard refusal on a prohibited tier would need its own ADR. |
| EU AI Act Annex III / Art. 6 | partial | ADR-0085 screen (domains `eu-ai-act.ts:59-86`, Art. 6(3) screen `:100-110`, high-tier rules `:230-330`); pack `eu-ai-act` (cascadeTag `eu-ai-act-high-risk`, `compliance-packs.ts:575`) maps Art. 4, 9, 10, 12, 14, 15, 72; Art. 73 clocks (`incident-clocks.ts:135-179`, ADR-0182). | Pack v2 controls for Art. 11 (technical documentation), 13 (instructions for use), 17 (QMS), 27 (FRIA, see controls), 43/49 (conformity, registration). |
| EU AI Act Art. 50 | partial | Rules `l-interaction-transparency`, `l-synthetic-content`; feed `eu-ai-act-transparency-in-force`. | `art-50` pack controls plus evidence (disclosure shown, content marking) through evaluators. |
| EU AI Act GPAI | missing | Feed `eu-ai-act-gpai-in-force` only; ADR-0085 and ADR-0182 put GPAI out of scope. | GPAI-provider role, pack (Art. 53 documentation, copyright policy, training-content summary; Art. 55 systemic-risk duties), screening questions. Most customers are downstream deployers, so scope with the owner first. |
| South Korea AI Basic Act | missing | PENDING §2d only. | Feed item plus a pack (high-impact AI duties, generative AI notice). Licence unverified. |
| Japan AI Promotion Act | missing | PENDING §2d only. | Feed item; mostly soft law, so a light attestation pack. |
| China generative AI measures | missing | PENDING §2d only. | Pack (labelling, filing, content controls) plus feed item. |
| Council of Europe AI Convention | missing | PENDING §2d only. | Feed item plus a crosswalk to existing controls. |
| GDPR | partial | ADR-0224 `privacy-ops.ts` (lawful bases, RoPA, DSR with the Art. 12(3) SLA); PII modes (ADR-0021, ADR-0117). | No `gdpr` pack or cascadeTag; no Art. 33 72-hour breach clock (incident regimes are `eu-ai-act` and `hipaa` only); no DPIA artefact. |
| CCPA/CPRA | partial | Generic ADR-0224 DSR machinery; "ccpa" appears only in demo fixtures. | Pack plus a 45-day SLA preset, opt-out of sale/sharing, ADMT rules. |
| India DPDP | partial | Aadhaar detection (ADR-0117, `pii-international.ts`); generic DSR/RoPA. | Pack (notice, consent manager), breach clock. |
| Brazil LGPD | partial | CPF/CNPJ detection (ADR-0117); generic DSR/RoPA. | Pack plus an ANPD incident clock. |
| Financial model risk | partial | MRM registry ADR-0045 (`mrm.ts`), auto re-test ADR-0217, `finra` pack (`compliance-packs.ts:1028`), feed `cfpb-adverse-action-ai`. SR 11-7 is never cited. | SR 11-7 / PRA SS1/23 pack: validation independence, model tiering, inventory, reusing ADR-0045. |
| Medical devices | partial | Art. 6(1)/Annex I safety-component route (`eu-ai-act.ts:231-238`); `hipaa` covers privacy only. | FDA SaMD/PCCP and EU MDR/IVDR packs plus feed items. |
| Hiring and employment | partial | Annex III point 4 (`h-domain-employment`, `eu-ai-act.ts:276-286`), emotion-recognition prohibition, Art. 10 bias control, ADR-0222 fairness; feeds `nyc-local-law-144`, `colorado-ai-act-sb26-189`. | LL144 pack with a bias-audit / impact-ratio evaluator and a candidate-notice control. |
| Consumer protection | missing | Feed `cfpb-adverse-action-ai` only. | Packs for CFPB adverse action, FTC Act s.5, Colorado AI Act. |
| NIS2 | missing | No match. | Pack plus a 24h/72h/1-month incident clock regime; cross-map to the `iso-27001` and `soc-2` packs. |
| DORA | missing | Feed `eu-dora-in-force` only. | Pack (ICT third-party register, overlapping ADR-0221 vendor risk) plus an ICT-incident clock regime. |
| Cyber Resilience Act | missing | No match; the CycloneDX AI-BOM export (ADR-0189) is related. | Pack (SBOM, vulnerability handling, 24h exploited-vulnerability report) reusing the BOM. |

Note: `packages/shared/src/demo-intake/regulatory-updates.ts` holds the curated feed items cited above. Whether it is the
production seed or demo data only is **unverified** (`regulatory-intel.ts:3` calls it demo task G4 data).

### 2.2 Standards

| Node | Status | Evidence | Gap scope | Licence |
|---|---|---|---|---|
| ISO/IEC 42001 | partial | Pack `iso-42001` (`compliance-packs.ts:822`): `8.3-ai-system-impact-assessment` (self-marked partial), `9.1-monitoring-measurement`, `A.6-ai-system-lifecycle`, `5.3-roles-responsibilities`. | Map remaining clauses 4–10 and Annex A by ID, with collectors or attestations. | Copyright; ID only |
| ISO/IEC 23894 | missing | PENDING §2d only. | ID-only pack mapping the risk process to the ADR-0081 risk register and ADR-0211 treatments. | Copyright; ID only |
| ISO/IEC 42005 | missing | PENDING §2d only; adjacent: ADR-0080 intake, ADR-0045 model cards. | ID-only pack bound to the impact-assessment artefact (controls lane C1). | Copyright; ID only |
| ISO/IEC 22989 | missing | PENDING §2d only. | Glossary alignment of product terms to clause IDs; reference only. | Copyright; ID only |
| NIST AI RMF 1.0 | built (mapping) | Pack `nist-ai-rmf` (`compliance-packs.ts:680`): GOVERN-1.2, GOVERN-4.1, MAP-4.1, MEASURE-2.7, MANAGE-2.2; ADR-0215 imports all 72 subcategories from vendored OSCAL. | Most subcategories have no evidence collector; Playbook actions not imported (ADR-0215 "not done"). | US public domain / CC0 |
| NIST AI 600-1 | partial | Feed `nist-ai-rmf-genai-profile` mapping to MEASURE-2.7, MEASURE-2.11, MANAGE-2.4, GOVERN-4.1; no pack. | `nist-ai-600-1` pack over the 12 GAI risks and their suggested actions keyed to AI RMF subcategories. | US public domain (not recorded in repo) |
| OECD AI Principles | missing | PENDING §2d only. | Attestation-led crosswalk pack (5 principles) to existing controls. | Unverified |
| UNESCO AI Ethics | missing | PENDING §2d only. | Crosswalk pack of values and policy areas, mostly attestation. | Unverified |
| G7 Hiroshima Code | missing | PENDING §2d only. | Crosswalk of the 11 actions to controls and attestations. | Unverified |
| OWASP LLM Top 10 | partial | `packages/shared/src/owasp-framework-mappings.ts` (IDs/names from promptfoo 0.125.1, MIT); evaluator catalog cites LLM01, 02, 05–09; red teaming ADR-0057/0068. | Probes or scorers for LLM03, LLM04, LLM10. | CC BY-SA; ID only |
| OWASP Agentic Top 10 | partial | Same file (`asi01`–`asi10`); catalog cites ASI01, 02, 06, 08, 10; `redteam-agentic.ts`. | Coverage for ASI03, 04, 05, 07, 09. | CC BY-SA; ID only |
| MITRE ATLAS | partial | ADR-0215 `mitre-atlas`, 44 mitigations (release 2026.10). | Import techniques/tactics and map them to red-team attack classes and evaluators. | Apache-2.0 |

### 2.3 Roles

| Node | Status | Evidence | Gap scope |
|---|---|---|---|
| Provider | built | ADR-0182: `ai_use_cases.eu_ai_act_role` (`provider` / `deployer` / `both`, default `both`); narrowing is admin-only, reasoned and audited (`apps/gateway/src/eu-ai-act-role.ts`). | Only incident clocks read the role. Pack controls and workflow stages should depend on it (Art. 16 duties). |
| Deployer | built | Same field; `incident-clocks.ts:105` (role) and `:120-133` apply `art26-5-inform-provider` when role ≠ provider. | Art. 26 duties beyond incident notice (FRIA trigger, oversight assignment) not tied to the role. |
| Importer | missing | Enum has three values. | Change the single field to a role set (an org can hold several), migration plus check constraint, Art. 23 controls. |
| Distributor | missing | Same. | Same model change, Art. 24 controls. |
| AI governance board | partial | Approval quorum (`approval_rules.quorum`, `approvals.quorum`, `tool_approval_sensitive_quorum` default 2), workflow-stage quorum, dual control with distinct approvers; starter templates are Builder/Reviewer/Viewer/Operator (`packages/shared/src/onboarding.ts:198`). | "Governance board" starter group with a default quorum rule for high-risk use cases and model cards; no record of membership or decisions as a board. |
| Data protection officer | missing | Custom roles (`roles` table) grant tools and servers only; whether governance permissions can be granted that way is **unverified**. | Starter template (privacy and PII policy read, DPIA sign-off) and an org DPO contact field. |
| Model owner | partial | Owner fields on agents (ADR-0089), MCP servers and connectors, use cases, vendors, risks; model cards (ADR-0045) carry only `created_by_user_id`. | `owner_user_id` on model cards plus a "Model owner" starter template. |
| Chief AI officer | missing | Admin or custom role only. | Starter template (read-all governance view). |
| CISO | missing | Admin or custom role only. | Starter template (posture, incidents, guardrail settings) and routing of security incidents. |
| Internal audit | partial | ADR-0225 auditor portal (single-use, read-only, time-boxed, every view audited); ADR-0189 BOM auditor grants; ADR-0116 signed offline-verifiable exports. | A standing read-only "Internal audit" role over the audit log, evidence packs and exports. |

### 2.4 Controls

| Node | Status | Evidence | Gap scope |
|---|---|---|---|
| AI inventory | built | ADR-0080 use-case registry, ADR-0082/0156 dependency inventory and graph, ADR-0195/0235 shadow-AI discovery, ADR-0122 MCP registry diff. | Device-side blocking is PENDING P1. |
| Risk tiering | built | ADR-0085 EU AI Act tiers ("a calculator, not a lawyer"), ADR-0081 risk register, ADR-0123 framework mapping. | Tiers exist for the EU AI Act only; other frameworks attach through packs. |
| Impact assessment | partial | No FRIA, DPIA or ISO 42005 record type. A DPIA can be tracked only as a free-text blocking approval condition (ADR-0168; e.g. `zz-adr0168-use-case-conditions.test.ts:173`); `iso-42001:8.3` is self-marked partial. | Versioned assessment record bound to a use case, with FRIA (Art. 27), DPIA (GDPR Art. 35) and 42005 templates, sign-off through the one approvals queue, evidence export, and required by default at high-risk tier. |
| Evaluations | built | ADR-0044 harness, ADR-0067 groundedness, ADR-0045 MRM, ADR-0217 auto re-test. | none found |
| Bias testing | built | ADR-0222 fairness testing; Art. 10 bias control. | Depth beyond labelled-dataset metrics **unverified**. |
| Red teaming | built | ADR-0057, ADR-0068 (multi-turn, agentic vectors, Wilson intervals). | OWASP/ATLAS coverage gaps above. |
| Data classification | partial | Pillar 3 classification cascade on projects and initiatives; ADR-0040 ABAC sensitivity attributes. | Classification of data assets (datasets, connectors, content) with propagation into lineage and DLP. |
| Data lineage | built | ADR-0050, `lineage.ts`. | none found |
| DLP | built | ADR-0042 guardrails, ADR-0117/0137/0140/0141 PII handling. | Whether in-flight redaction is on for every path is **unverified** (ADR-0137/0140 gate it on constraints). |
| Retention | partial | ADR-0185 memory retention; one global audit retention floor (`audit_log` has no project column); compliance-profile retention is labelled "declared policy" in the schema. | Enforce retention per project or framework, or record an ADR that the global floor is the design. |
| Logging / audit trail | built | ADR-0060 hash chain, ADR-0070 traces. | SIEM delivery ADR-0135 is Proposed. |
| Incident response | built | ADR-0182 incident register with Art. 73 and HIPAA clocks. | Clock regimes for GDPR, NIS2, DORA (see packs); playbook automation **unverified**. |
| Human oversight | built | ADR-0046 one approvals queue, ADR-0124 kill switch and safe modes, ADR-0123 audited agent disable. | ADR-0124's stated exclusions. |
| Agent identity | built | ADR-0188 per-agent workload identity with human sponsor and RFC 8693 actor chain. | Per-user token exchange for remote A2A / SAP Joule agents is PENDING P20. |
| Least privilege | built | Default-deny pillar 1; ADR-0016 budget ceiling; ADR-0078 tighten-only delegation suite. | none found |
| Tool permissions | built | Per-user tool-level allow-lists; ADR-0040 ABAC; ADR-0181 MCP read-only by default. | none found |

---

## 3. Proposed lanes (step 2, for the master)

Ordered as P18 asks: ADR-0176 open-source-first imports, then packs, then controls. Within each tier, ranked by how many
gaps a lane closes and how much existing machinery it reuses. Each lane gets its own ADR. None of these is approved; the
master and owner decide.

### Tier A — open-source imports (ADR-0176)

1. **A1 · MITRE ATLAS techniques and tactics.** Extend the ADR-0215 snapshot (Apache-2.0, text allowed) from mitigations
   to techniques, and map them to red-team attack classes and evaluators. Closes the ATLAS partial; feeds red teaming.
2. **A2 · Red-team probes for the uncovered OWASP items.** Import probes from garak (Apache-2.0) and promptfoo (MIT, already
   pinned) for LLM03, LLM04, LLM10 and ASI03/04/05/07/09. OWASP names stay ID only; record OWASP's CC BY-SA licence in
   `THIRD_PARTY.md` as a citation-only source.
3. **A3 · NIST AI 600-1 content.** Public domain. Vendor the 12 GAI risks and suggested actions (an OSCAL form, if NIST
   publishes one, is **unverified**) through the ADR-0215 import path; feeds pack B5.
4. **A4 · NIST AI RMF Playbook actions.** Public domain; the ADR-0215 "not done" item. Lets more of the 72 subcategories
   carry suggested evidence.
5. **A5 · EU legal text (owner decision).** EUR-Lex reuse is attribution-based, which is not on ADR-0176's licence list.
   Either the owner approves it as a citation source or the EU packs stay ID-and-summary. Decide before B1–B3.

### Tier B — packs

1. **B1 · EU AI Act pack v2 and ruleset v2.** Remaining Art. 5 practices; Art. 11, 13, 17, 43/49 and 50 controls; GPAI
   (Art. 53/55) scoped with the owner. Highest-value single lane: the EU AI Act is the map's central node.
2. **B2 · Privacy packs on the ADR-0224 machinery.** GDPR first (with an Art. 33 72-hour clock regime), then CCPA/CPRA,
   DPDP and LGPD as presets on the same DSR/RoPA/PII code.
3. **B3 · Cyber and resilience packs.** NIS2, DORA and CRA, each with an `incident-clocks.ts` regime; cross-map to
   `iso-27001`/`soc-2`; CRA reuses the ADR-0189 AI-BOM, DORA the ADR-0221 vendor register.
4. **B4 · ISO/IEC ID-only packs.** Widen `iso-42001` to all clauses and Annex A; add 23894 (onto ADR-0081/0211) and 42005
   (onto lane C1); 22989 as a glossary.
5. **B5 · NIST AI 600-1 pack.** On A3.
6. **B6 · Sector packs.** SR 11-7 / PRA SS1/23 on ADR-0045; NYC LL144 with a bias-audit evaluator on ADR-0222; consumer
   protection (CFPB, FTC s.5, Colorado); medical devices (FDA SaMD/PCCP, EU MDR/IVDR) last.
7. **B7 · Other AI laws.** South Korea, China, Japan, Council of Europe: feed items first, packs after the owner confirms
   which markets matter. Licences unverified.
8. **B8 · Principles crosswalks.** OECD, UNESCO, G7 as attestation-led crosswalk packs. Low effort, low enforcement value.

### Tier C — controls

1. **C1 · Impact assessment artefact.** FRIA / DPIA / ISO 42005 record bound to a use case, signed off through the
   approvals queue, required by default at high-risk tier (secure by default, ADR-0180). Unblocks B1 (Art. 27), B2 (DPIA)
   and B4 (42005).
2. **C2 · EU AI Act role set.** Replace the single `eu_ai_act_role` with a role set covering importer, distributor and GPAI
   provider; let pack controls and workflow stages read it. Expand-contract migration.
3. **C3 · Governance starter roles.** Governance board (default quorum), DPO, model owner (`owner_user_id` on model cards),
   chief AI officer, CISO and a standing internal-audit role, as starter templates. Check first whether governance
   permissions can be granted through custom roles (unverified).
4. **C4 · Data-asset classification.** Labels on datasets, connectors and content, propagated into lineage and DLP.
5. **C5 · Retention per framework.** Enforce compliance-profile retention, or record the global floor as the design.
6. **C6 · SIEM delivery.** Move ADR-0135 from Proposed to built.

## 4. Overlaps worth reusing

- Privacy packs share the ADR-0224 DSR/RoPA machinery and the ADR-0117 identifier detectors.
- NIS2, DORA, CRA and GDPR breach clocks all fit the pluggable regimes in `incident-clocks.ts`.
- FRIA, DPIA and ISO 42005 are one artefact with three templates (C1), not three features.
- ISO 42001 8.3, EU AI Act Art. 27 and GDPR Art. 35 would all collect evidence from C1.

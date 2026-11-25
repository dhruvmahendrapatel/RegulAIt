# Gap analysis — Forcepoint "AI Data Security", 2026-11-17

**Status:** research snapshot, written 2026-11-17 at the owner's request. It adds Forcepoint to the competitor list in
[MARKET_ANALYSIS_2026-11.md](MARKET_ANALYSIS_2026-11.md) §1.4, next to
[GAP_ANALYSIS_CAMUNDA_2026-11.md](GAP_ANALYSIS_CAMUNDA_2026-11.md). It was checked against the DarkControl, Manifold and
KrakenD analyses (branch `claude/status-check-2gbrwf`) so that it does not repeat their gaps.

**Sources and honesty rules.** All sources are primary, on forcepoint.com, and were read on 2026-11-17:
- `/ai-data-security`, `/product/forcepoint-ai-agent-gateway`, `/use-case/agentic-ai-security`,
  `/use-case/ai-usage-monitoring`, `/use-case/shadow-ai-security`, `/use-case/ai-prompt-security`, `/use-case/dlp-for-ai`
  and `/use-case/microsoft-copilot-security`;
- `/use-case/compliance-readiness`, `/product/data-security-posture-management-dspm`, `/product/secure-web-gateway-swg`
  and `/product/dlp-data-loss-prevention` (search excerpt);
- `/blog/insights/ai-security-tools` (the vendor's own buyer guide, which gives the release status);
- the newsroom items on the GenAI Security launch (2024-07-18) and the Getvisibility acquisition (2025-04-07).

One extra source is a 2022 BusinessWire press release on FedRAMP, which is a vendor statement. No product docs or
pricing page are public: pricing is a "Request Pricing" form.

Everything in §1 is the **vendor's claim** and none of it was verified. That includes the customer logos, "2,000+
classifiers", "under 60 minutes" and the audit mapping to the EU AI Act, GDPR, DORA, NIS2 and SEC rules. "RegulAIt
status" is checked against `origin/main` (bb3def28f) and the open PRs on 2026-11-17.

## 1. What Forcepoint sells

Forcepoint is a long-standing DLP and SSE vendor (formerly Websense). Its pitch is that "AI security is a data problem":
it extends one classification engine and one DLP policy to AI use. **Forcepoint AI Data Security** is the platform. It
combines DSPM, DLP, DDR (data detection and response) and **Forcepoint AI Security**. AI Security has three components,
and the vendor's buyer guide says it reached **limited GA on 13 Oct 2026, for qualified customers and partners**:

- **AI Detection and Response (sanctioned AI).** API connectors to Microsoft 365 Copilot, ChatGPT Enterprise, Claude
  Enterprise and AWS Bedrock. It inspects prompts, responses and file uploads and downloads against the existing DLP
  policy. Its remediations are audit, quarantine, copy or delete the conversation, revoke access to an overshared file,
  and escalate to SIEM. It "detects AI agent activity inside these apps". History is backfilled when a connector is
  switched on. The ChatGPT Enterprise Compliance API integration dates from the July 2024 launch.
- **Shadow AI Discovery and Control (unsanctioned AI).** Endpoint detection of AI apps, websites, browser extensions,
  vibe-coding tools and MCP clients. A risk-ranked inventory is built from the "X-Labs AI application database" and
  broken out by tool, user and department. Inline allow, restrict or block per app, with separate rules for personal
  and corporate accounts. User coaching shows guidance "at the moment of risk".
- **AI Agent Gateway (agentic AI).** An MCP gateway inline between agents and SaaS MCP servers. It has an agent registry
  with owners and alerts when new agents appear. Credentials are brokered, temporary and revocable ("no agent holds the
  keys"). App responses are inspected field by field and redacted before the agent reads them. Writes and deletes can
  wait for human approval. Runs can be paused, approved, revoked or quarantined from the console. Over-permissioned
  agents are flagged, and the gateway "detects anomalous activity". The audit record holds the agent, the triggering
  user, the tool, the data classification, the decision, the fields blocked, the record count and the time, and it
  exports as CSV, JSON or PDF. **The release supports MCP connectors for Salesforce, Atlassian and Microsoft 365 only**,
  and the vendor itself tells buyers to confirm coverage.

These sit on four supporting pieces:
- **AI Mesh**, a classifier made of small language models and neural networks, from the 2025 Getvisibility acquisition;
- **DSPM**, which scans cloud, SaaS and on-prem stores for overshared and ROT data before Copilot or agents reach it, and
  applies Purview sensitivity labels;
- **Forcepoint DLP**, with "2,000+ policy and classifier templates, 90+ countries";
- **Forcepoint Web Security / CASB**, with GenAI subcategories, upload blocking per AI site, and remote browser
  isolation.

An **AI Governance Dashboard** shows the AI landscape, sensitive-data exposure and policy effectiveness.

**Deployment:**
- DLP ships as SaaS (on AWS, "99.99% uptime"), on-premises or hybrid.
- DSPM ships on-premises, in a private cloud or as SaaS.
- AI Security is described only as part of the cloud "Data Security Cloud". No page claims an on-prem or air-gapped
  option for AI Security.

**Certifications:** the 2022 press release claims FedRAMP authorisation for Forcepoint ONE (CASB, ZTNA and SWG). No AI
Security attestation is published. **Pricing:** not published.

**Where it overlaps us:** pillar 1 (the gateway, and governing MCP and agents), the shadow-AI and endpoint lanes, PII and
DLP redaction (ADR-0140) and audit evidence. Forcepoint has no workflow engine, cost dashboard, token optimisation,
multi-agent orchestration or PM-tool integration (pillars 2 and 4 to 8).

## 2. Capability-by-capability parity

| # | Capability (Forcepoint claim) | RegulAIt status | Evidence | Gap |
|---|---|---|---|---|
| 1 | Monitor sanctioned AI SaaS (Copilot, ChatGPT Ent., Claude Ent., Bedrock) through vendor APIs, with history backfill and remediation | **Gap** | ADR-0322 (usage and cost pull; slice 2 is #861 in flight), ADR-0261 (third-party evidence ingest), ADR-0020 (compat endpoints for traffic routed through us) | We govern traffic that passes the gateway. We do not read or scan the conversations a user has directly in a vendor's SaaS, and we cannot delete or quarantine them. E17 (#880) reads agent definitions and explicitly stores no prompts. |
| 2 | Inline prompt and response DLP: block, redact, allow | **Have** (gateway); **in flight** (browser) | ADR-0042, ADR-0137, ADR-0140, ADR-0141, ADR-0117; #867 in flight (E16) | The browser extension blocks a prompt that matches a DLP rule before it is sent. Streaming inspection without full buffering is queued in E33. |
| 3 | File upload, attachment and image inspection | **Gap** | ADR-0143 withholds opaque MCP content; `compat-openai.ts` passes `image_url` parts on; the follow-ups listed in #867 exclude pasted and dragged files | No text extraction and no OCR on any path. |
| 4 | Classifier breadth ("2,000+ templates, 90+ countries"), AI Mesh | **Partial** | `pii.ts` and `pii-international.ts` (ADR-0140, ADR-0117), Presidio and DeBERTa detectors (ADR-0220), `DLP_RULES` and admin term lists in `guardrails.ts` | Validated PII, international IDs, secrets and custom terms. We do not read customer sensitivity labels (Purview), and there are no document fingerprints or hashed exact-value matching. |
| 5 | Shadow-AI discovery: endpoints, browser extensions, vibe-coding tools, MCP clients | **Have** | ADR-0055, ADR-0071, ADR-0083, ADR-0195, ADR-0235, ADR-0259, ADR-0332 | Parity or better: we have discovery from egress, DNS and SIEM logs, an endpoint add-on inventory and MCP config discovery. |
| 6 | Risk-ranked AI app catalogue (X-Labs database), by tool, user and department | **Partial** | `shadow-catalog-v2.ts` (78 pinned entries), ADR-0084 (vendor AI risk portal) | The catalogue holds detection data, not risk attributes such as "trains on inputs", retention or residency. There is no default ranking. |
| 7 | Allow, restrict or block per AI app inline; personal and corporate accounts | **In flight, partial** | #867 in flight (E16): per-site rules and account domains from the browser profile | The account check reads the **browser profile**, not the account signed in to the AI site itself. |
| 8 | User coaching at the point of risk | **Gap, queued** | E35 (graduated responses, the `advise` verb from the Manifold analysis) | There is no warn-and-justify step that records the reason. |
| 9 | Copilot oversharing: DSPM scans, permission fixes, Purview labels | **Partial** | E18 SaaS entitlement graph (#884, #890 in flight), read-only | We read app grants. We do not scan file permissions or content at rest, and we do not write fixes into M365. |
| 10 | Agent registry with owners; alerts on new agents | **Have / in flight** | ADR-0089, ADR-0122, #855, E17 (#880), E20 (#892) | — |
| 11 | MCP gateway with brokered, short-lived, revocable credentials | **Have (ahead)** | ADR-0251, ADR-0238 (token exchange, 300 s default, default-deny scope map), ADR-0204, ADR-0210 | Any MCP server or connector, not three SaaS connectors. |
| 12 | Field-level inspection and redaction of app responses before the agent reads them | **Have** | ADR-0143, ADR-0145 | Streaming windows are queued in E33. |
| 13 | Human approval for writes, deletes and sensitive operations | **Have (ahead)** | ADR-0104 (approval bound to the payload), ADR-0130, ADR-0229, #818 | — |
| 14 | Pause, revoke or quarantine an agent | **Have / in flight** | ADR-0124 (kill switch and safe modes), E19 (#881) | — |
| 15 | Over-permissioned agent flags; anomaly detection | **Partial, queued** | E20 (#883), E15 (#865, rule-based), E40 (behaviour baseline) | — |
| 16 | Attributed audit (agent and user), CSV, JSON or PDF export, mapped to the EU AI Act, GDPR, DORA, NIS2 and SEC | **Have (ahead)**, except PDF | ADR-0060 and ADR-0116 (hash-chained, signed, offline-verifiable), ADR-0058 (packs `eu-ai-act`, `gdpr`, `nist-ai-rmf`, `iso-42001`), ADR-0296 (GDPR, NIS2, DORA and CRA incident clocks), ADR-0303 (SIEM); E32 (#953, #942) | No PDF rendering. No per-article evidence view yet (E32). |
| 17 | AI governance dashboard: landscape, exposure, policy effectiveness | **Partial** | ADR-0047, ADR-0082, ADR-0214 | Per-department adoption analytics are queued in E39. |
| 18 | Deployment: SaaS, on-prem, private cloud | **Have (ahead for AI)** | ADR-0015, ADR-0041, ADR-0304, ADR-0325, ADR-0343 | Forcepoint claims on-prem for DLP and DSPM only. Its AI Security is cloud-only, as far as the vendor's pages say. |
| 19 | Certifications (FedRAMP for Forcepoint ONE, per a 2022 press release) | **Gap (owner-deferred)** | `ENTERPRISE_READINESS_PLAN.md` | — |
| 20 | Endpoint prompt DLP in desktop AI apps | **Partial, queued** | ADR-0298, ADR-0330 (coding-agent hooks); E31, E41 | Desktop chat apps are not covered. |

## 3. Gaps, ranked by F×S

F is how often buyers hit the gap and S is how much it matters, each scored 1–10 (ADR-0200 rule 2).

| Rank | Slice | Size | Extends | New or queued | F | S | F×S |
|---|---|---|---|---|---|---|---|
| 1 | **Sanctioned-AI conversation monitoring.** Read-only connectors pull prompts, responses and files from each vendor's own compliance or audit API, where the vendor offers one (ChatGPT Enterprise, Microsoft 365 Copilot interactions, Claude Enterprise, Bedrock invocation logs). The content is scanned with the same shared detectors (ADR-0140), findings are attributed to the user and agent in the audit chain, and history is backfilled when a connector is switched on. Remediation (delete or quarantine the conversation) is a separate governed action with its own write credential, under E19's `governedActions` contract. **Secure by default:** each source is off; enabling one is a `settings_relax` step-up; only findings and hashes are kept, never raw text, unless prompt capture is on with the 30-day default retention bound decided for #867 (owner decision B2). | L | ADR-0322 (#861), ADR-0261, ADR-0140, ADR-0055 inventory; E19 for writes | **New** | 8 | 8 | 64 |
| 2 | **File, attachment and image inspection.** Extract text from PDF, Office and image uploads (OCR) on the gateway compat endpoints, MCP results and browser uploads, then run the shared detectors. Content we cannot scan fails closed for projects whose compliance tag requires it (the pillar-3 cascade) and is otherwise marked "not scanned", never "clean". Under ADR-0176, compare maintained local extractors and OCR engines first (for example `unpdf` and `tesseract.js`; check their licences). Nothing is downloaded at run time, so it works air-gapped. | M | ADR-0140, ADR-0143, ADR-0137; the browser DLP follow-up listed in #867 | **New** | 7 | 8 | 56 |
| 3 | **Classification interop.** Honour the customer's existing Microsoft Purview sensitivity labels on files and content that reach the gateway, read through the E18 Graph source with read-only scopes. Add admin-defined classifiers with dictionaries and hashed exact-value lists (never plaintext values), shared by the gateway, browser and endpoint rules, so the buyer's DLP investment carries over. | M | ADR-0042 term lists, ADR-0220; E18 (#884) | **New** | 6 | 7 | 42 |
| 4 | **Risk attributes in the AI app catalogue.** Add per-app attributes: trains on inputs, retention, residency, enterprise tier available, published attestations. Rank the shadow-AI inventory by them and use them to suggest (never apply) default site rules. A catalogue row stays data, not code. | S | `shadow-catalog-v2.ts` (add a v3), ADR-0195, ADR-0084, the E16 site catalogue (#867 in flight) | **New** (feeds E39) | 7 | 6 | 42 |
| 5 | **AI-service account control.** Personal or corporate is decided by the account signed in to the AI site, not the browser profile. Use the vendor's tenant-restriction mechanism where one exists, and detect the signed-in workspace in the extension where one does not. Fail closed when the account is unknown. | S | E16 (#867 in flight) | **Queued: E16 follow-up** | 7 | 6 | 42 |
| 6 | **Coach and justify.** A `warn` response that lets the user proceed after giving a reason, which is recorded in the audit row. Lowering a rule from `block` to `warn` is a `settings_relax` step-up, and the message is static admin text. | S | ADR-0042, ADR-0251 | **Queued: E35**, as one more acceptance criterion | 8 | 5 | 40 |
| 7 | **Per-department AI adoption and policy-effectiveness view.** | M | ADR-0047, ADR-0082 | **Queued: E39** | 6 | 5 | 30 |
| 8 | **Anomaly detection on agent-to-app traffic.** | M | E15 (#865 in flight) | **Queued: E40** | 5 | 6 | 30 |
| 9 | **Article-level evidence views** for EU AI Act Art. 12 log-keeping and a GDPR Art. 30-style record of AI processing, built from the audit chain. | S | ADR-0058, ADR-0296 | **Queued: E32** (#953); the Art. 30 record is new | 5 | 5 | 25 |
| 10 | **Prompt DLP in desktop AI chat apps** on managed endpoints. | M | ADR-0298, ADR-0330 | **Queued: E31 / E41** | 4 | 5 | 20 |

**Lane overlap.** Items 5 to 10 ride lanes already queued. Items 1 to 4 do not overlap E17–E24, E26–E30, E33 (whose
streaming inspection is text only), E34, E36–E38, the DarkControl, Manifold or KrakenD gaps, or ADR-0140. They are
three new lanes:
- **E42, "sanctioned-AI SaaS monitoring"**: item 1;
- **E43, "content inspection beyond text"**: item 2;
- **E44, "classification interop and app risk catalogue"**: items 3 and 4.

The numbers are suggestions; the master assigns them.

**Below 5, to file as `triage-low` issues:**
- remote browser isolation for AI sites (F1 × S4 = 4);
- PDF rendering of audit exports beside the signed CSV and JSON (F2 × S2 = 4).

**Marketing-only, no engineering action:**
- "governed environment in under 60 minutes";
- "zero reclassification, no new console";
- "None of them own the data layer… quite like Forcepoint";
- "Three layers. One platform. Zero gaps.";
- the customer logo wall;
- the "2,000+ classifiers" count, which counts templates rather than measured accuracy;
- the claim that audit records are "structured for" EU AI Act Art. 12, GDPR Art. 30, DORA, NIS2 and SEC rules, which no
  public page shows.

## 4. Not recommended

- **Building an SWG, CASB or SSE proxy.** That is Forcepoint's core business, and a network proxy would be a second
  decision point outside ADR-0251. Take in the customer's existing SSE logs (ADR-0055 already does) and keep the
  gateway, browser extension and device hooks as our enforcement points.
- **DSPM for data at rest** (scanning stores, deleting ROT data, moving files and leaving stubs, rewriting M365
  permissions). It is a separate product category with write access to the customer's data estate. Reading
  Purview labels (gap 3) and the E18 entitlement graph gets the AI-relevant signal without it.
- **A vendor-hosted classifier "mesh".** Classification stays local and licence-clean (Presidio, ADR-0220) and runs on
  the customer's own entitled models through our gateway, as ADR-0015 and ADR-0062 require for BYOC and air-gapped
  installs.
- **Relying on scope alone against prompt injection.** Forcepoint's FAQ says the gateway "does not rely on the agent
  to detect" manipulation. We already enforce scope at the point of action (default-deny entitlements) **and** run
  injection detectors (ADR-0244, ADR-0247). Keep both.

## 5. Where RegulAIt is ahead

- **Breadth of the agent gateway.** Forcepoint's AI Agent Gateway is in limited GA with three SaaS MCP connectors. One
  RegulAIt decision core governs every model, connector, MCP and A2A call (ADR-0251, ADR-0219), with per-user
  default-deny tool allow-lists, MCP admission scanning and definition pinning (ADR-0097, ADR-0246), and token exchange
  for any server (ADR-0238).
- **Evidence you can verify.** We have a hash-chained, signed, offline-verifiable audit (ADR-0060, ADR-0116), approvals
  bound to the payload (ADR-0104) and AI-BOM snapshots (ADR-0189). Forcepoint says only "immutable".
- **Deployment.** BYOC, Helm and air-gapped installs with a disclosed data boundary (ADR-0015, ADR-0041, ADR-0304) and
  an HA control plane (ADR-0343). Forcepoint's pages describe AI Security only as part of its cloud.
- **Device enforcement for coding agents.** Hooks for Claude Code, Cursor, Copilot and Codex (ADR-0298, ADR-0330),
  with command rules in E31 (#941, #952).
- **Everything Forcepoint does not attempt:** the governed workflow engine (pillar 2), shared projects (pillar 4),
  per-call cost and budgets (pillar 5), automatic token optimisation (pillar 6), tighten-only multi-agent delegation
  (pillar 7) and PM-tool integration (pillar 8).
- **Provider-agnostic and licence-clean** (ADR-0176), with no proprietary classifier dependency.

## 6. One-line positioning

"Forcepoint watches the data that flows into AI. RegulAIt decides, per person, what each AI agent may call and spend,
proves every decision with signed evidence, and runs in your cloud or air-gapped."

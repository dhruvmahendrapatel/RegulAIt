# RegulAIt — Enterprise-Readiness Plan

**Status:** active planning artifact · **Created:** 2026-08-01 · **Owner:** main session
**Companion of:** [ROADMAP.md](ROADMAP.md) (the pillar-delivery roadmap). This document is the
*commercial-readiness* roadmap — what has to be true before RegulAIt is sold to a large enterprise.

> This plan is the outcome of a meticulous enterprise-readiness gap analysis and a round of
> owner triage. It sorts every identified gap into one of three buckets — **NOW**, **CORE
> (must ship before go-live)**, and **DEFERRED** — and assigns an ADR to everything in the first
> two. The ADRs (0036–0061) are **Proposed**: the *decision to pursue* is made; the design in each
> is the starting proposal and gates on implementation, not a claim that it is built.

---

## The three hard truths (independent of this plan)

Before any of the work below matters, three things gate an enterprise sale. They are tracked
here so they are never lost behind feature work:

1. **No real LLM is connected.** The Anthropic key is parked (owner's standing instruction). The
   product cannot do its job in production until a real provider is live. Nothing else ships value
   without this.
2. **Single point of failure.** One EC2 instance + one container Postgres. Addressed by the
   **Deployment Readiness Checklist** (parked by owner decision — see below), not by an ADR here.
3. **No compliance attestation** (SOC 2 / ISO 27001 / ISO 42001). Deferred by owner decision;
   tracked in the Deferred list. Note the **regulatory wedge** is *core* (ADR-0058) even though
   *our own* certification is deferred — selling "EU AI Act compliance" does not require us to be
   ISO-certified first.

---

## Bucket 1 — NOW (build next)

### Identity & Access (all five — owner: "include all")

| ADR | Item | Builds on |
|---|---|---|
| [0036](../decisions/0036-saml-sso.md) | SAML 2.0 SSO (SP- and IdP-initiated) | the OIDC path in `auth.ts` + `oidc_providers` table |
| [0037](../decisions/0037-scim-provisioning.md) | SCIM 2.0 user/group provisioning + deprovisioning | `users`, `roles`, `api_keys` |
| [0038](../decisions/0038-idp-group-role-mapping.md) | IdP group → RegulAIt role mapping | ADR-0036/0037 + role-grant model |
| [0039](../decisions/0039-session-device-management.md) | Session & device management + IP allow-listing | `auth_sessions` (server-side sessions, ADR-0025) |
| [0040](../decisions/0040-abac-policy-as-code.md) | ABAC / policy-as-code engine | `packages/policy-kernel` (today RBAC + allow-lists) |

### Deployment strategy + the two security items owner chose now

| ADR | Item | Builds on |
|---|---|---|
| [0041](../decisions/0041-byoc-primary-motion.md) | **BYOC / air-gapped as the primary enterprise motion** | pillar 3, ADR-0015 deployment modes |
| [0042](../decisions/0042-guardrail-engine.md) | Guardrail engine — prompt-injection / jailbreak / toxicity / semantic-DLP (owner's D6, merged with the guardrail-depth item F2) | `enforcePII` / `piiMode` block\|warn\|log in `agents-connectors.ts` |
| [0043](../decisions/0043-mcp-oidc-egress-guard.md) | Egress guard for `mcp_servers.url` and `oidc_providers.issuerUrl` (owner's D2) | `apps/gateway/src/egress-guard.ts` (ADR-0034's guard) |

### Product depth (all — owner: "we need to prioritize these")

| ADR | Item | Builds on |
|---|---|---|
| [0044](../decisions/0044-agent-evaluation-harness.md) | Agent evaluation & regression harness (golden sets, LLM-as-judge, block-on-regression) | the workflow gate (pillar 2), `usage_events` |
| [0045](../decisions/0045-model-risk-management.md) | Model risk management registry (model cards, bias/fairness, sign-off, expiry) | `agents`/`custom_model_providers` registries |
| [0046](../decisions/0046-review-workbench.md) | Human review workbench at scale (routing, SLA timers, bulk, escalation) | `approvals` table + Approvals Queue |
| [0047](../decisions/0047-executive-compliance-reporting.md) | Executive & compliance reporting (board dashboards, scheduled exports) | cost dashboard (pillar 5), `audit_log` |
| [0048](../decisions/0048-agent-prompt-policy-versioning.md) | Agent/prompt/policy versioning, canary, rollback | `agents.systemPrompt` (ADR-0023), rules engine |
| [0049](../decisions/0049-cost-forecasting-anomaly.md) | Cost forecasting & spend-anomaly detection | `cost_events` / `usage_events` (pillars 5/6) |
| [0050](../decisions/0050-data-lineage-provenance.md) | Data lineage / provenance graph across runs | context-store provenance (pillar 4) |

### Commercial (G1–G4 — owner selected; G5/G6 deferred)

| ADR | Item | Builds on |
|---|---|---|
| [0051](../decisions/0051-metering-billing.md) | Metering & billing | per-call cost attribution already in `usage_events` |
| [0052](../decisions/0052-licensing-seats.md) | Licensing & seat management (esp. for BYOC/air-gap) | entitlement model (pillar 1) |
| [0053](../decisions/0053-public-api-sdks.md) | Public API: OpenAPI 3 spec + generated SDKs + versioning | the existing gateway routes |
| [0054](../decisions/0054-onboarding-migration.md) | Onboarding wizard & migration tooling | admin console, IdP/PM adapters |

---

## Bucket 2 — CORE (must ship before go-live)

The seven differentiators the owner elevated to launch-blocking. These are what make RegulAIt
*chosen*, not merely *buyable*, and several dogfood the governance product on the AI it governs.

| ADR | Capability | One-line thesis |
|---|---|---|
| [0055](../decisions/0055-shadow-ai-discovery.md) | **Shadow-AI Discovery** | Find ungoverned LLM usage across the enterprise — the land-and-expand wedge |
| [0056](../decisions/0056-ai-governance-copilot.md) | **AI Governance Copilot** | A RegulAIt-governed agent that reads the audit log and advises: reports, policy tightening, anomaly flags, NL queries |
| [0057](../decisions/0057-continuous-red-teaming.md) | **Continuous automated red-teaming** | Scheduled adversarial testing of the agents you govern; feeds MRM, blocks promotion on regression |
| [0058](../decisions/0058-compliance-packs.md) | **Regulatory compliance packs** | Pre-built control mappings + evidence collectors for EU AI Act / NIST AI RMF / ISO 42001 / HIPAA / PCI / FINRA — the regulatory tailwind |
| [0059](../decisions/0059-policy-simulation-blast-radius.md) | **Policy simulation & blast-radius preview** | Before a rule changes: who it affects and what it would have blocked in the last 30 days |
| [0060](../decisions/0060-tamper-evident-audit.md) | **Tamper-evident audit** | Hash-chained / WORM-anchored audit log — cryptographic proof of non-alteration |
| [0061](../decisions/0061-chatops-approvals.md) | **ChatOps approvals** | Approvals in Slack/Teams, not just the portal |

---

## Bucket 3 — DEFERRED (tracked, not scheduled)

By owner decision these are real and wanted but **later**. Kept here so nothing is silently lost.

### Reliability & Operations → **Deployment Readiness Checklist**

Parked by owner: *"it doesn't make sense for that unnecessary cost right now"* while the product
is still being made good. Captured as a pre-production gate, not built now:
**[docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md](../ops/DEPLOYMENT_READINESS_CHECKLIST.md)** —
HA/multi-AZ, RDS/Aurora + PITR, OpenTelemetry + dashboards, real CD pipeline, status page/SLO,
zero-downtime deploy, cross-region backup, SNS→PagerDuty wiring for the existing backup alarm.

### Security hardening — later (do after functionality)

- **D1** — move `REGULAIT_DATA_KEY` off the DB volume into KMS/Secrets Manager/Vault; BYOK. *(highest of the deferred security items — a restore onto a new box currently loses all credentials.)*
- **D3** — SAST/SCA/secret-scanning/container-scanning gates in CI.
- **D4** — third-party pen test + vulnerability-disclosure program.
- **D5** — WAF / DDoS / bot protection at the edge (pairs with the LB in the deployment checklist).
- **D7** — HSM / FIPS 140-2 option for regulated verticals.

### Compliance & certification gates — later

- **E1** SOC 2 Type II · **E2** ISO 27001 / **ISO 42001** *(our own certification; the customer-facing compliance *packs* are core — ADR-0058)* · **E3** DPA / sub-processor list / GDPR-CCPA data-subject flows · **E4** SIEM streaming export + audit retention tiers *(tamper-evidence itself is core — ADR-0060)* · **E5** data residency / regional pinning · **E6** our own EU AI Act / NIST AI RMF posture artifacts.

### Commercial — later

- **G5** AWS/Azure/GCP Marketplace listings.
- **G6** in-product support, docs portal, admin guide. *(Owner: "G6 will be fine later.")*

---

## Sequencing guidance

The ADRs are independent decisions, but a sane build order maximizes salability per unit effort:

1. **Identity first (0036–0040).** Nothing passes an enterprise security review without SSO+SCIM;
   it is also a prerequisite for multi-team pilots.
2. **BYOC productization (0041)** in parallel — it is the deployment decision the rest assumes,
   and it de-risks the multi-tenancy question by choosing single-tenant-per-deployment.
3. **The two security items (0042, 0043)** — small, and 0042 (guardrails) is core to the product's
   own value proposition, so it doubles as a demo asset.
4. **Core differentiators (0055–0061)** — these win bake-offs; start Shadow-AI Discovery (0055) and
   Compliance Packs (0058) early because they are the sharpest sales wedges.
5. **Product depth (0044–0050)** and **commercial (0051–0054)** — continuous, prioritized by the
   deals in front of you.

Status of each ADR is tracked in [docs/decisions/README.md](../decisions/README.md); this plan
tracks the *bucketing*. When an ADR moves from Proposed → Accepted (i.e. built), update both.

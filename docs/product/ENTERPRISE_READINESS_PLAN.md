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

---

# Addendum — external-review intake (2026-09-07)

**Sources:** two documents from another agent — `codexInputs.md` (findings **F01–F08**, plus an
automated enterprise-readiness block **AER-001…003** covering two review runs) and
`PathForward.md` (**PF-01…PF-14**, a strategic recommendation to position RegulAIt as an AI
security & governance *control plane*, with delivery Waves 0–4).

**Both documents disclaim implementation authority, and this addendum inherits that.** Nothing
here authorizes production designation, cloud spend, deployment, publishing, key rotation, or
suite-contract changes. Bucketing below is a *proposal for owner triage*, not a commitment.

> **Read the buckets above with care — they are stale.** §Bucket 1–3 were written 2026-08-01 and
> describe ADRs 0036–0061 as *Proposed*. The tree is now at **ADR-0104**, and a substantial part of
> that range has since been built and accepted (ADR-0040 ABAC, 0042 guardrails, 0043 egress guard
> among them). This plan's own closing rule — update the bucketing when an ADR moves
> Proposed → Accepted — has not been kept. **Reconciling §Bucket 1–3 against
> `docs/decisions/README.md` is itself a task, listed as R0 below.** Until it is done, do not read
> an unticked row above as evidence that something is unbuilt.

## 1. Intake — verified state of every finding, as of HEAD `668f5f5`

Each row was rechecked against the tree rather than accepted from the document.

| Ref | Claim | Verified state |
|---|---|---|
| **F01** / PF-04 | Test gate not trustworthy | **PARTLY CLOSED.** One flake fixed (`0ebfabe`, unordered `db.select()` + `.at(-1)`). The intermittent `socket.destroySoon` remains, now correctly attributed to `@hono/node-server`, transitive via `@modelcontextprotocol/sdk@1.29.0`. `.at(-1)` sweep (86 sites) open. |
| **F02** / AER-001 | Budget not enforced on the MCP path | **CLOSED — and runtime-verified here.** ADR-0103. Codex could not run the integration test (no disposable `DATABASE_URL` on its host) and correctly labelled it *runtime-unverified*; it has since been executed on this box — three full-suite runs plus row-level checks. AER-001's six acceptance items are met. |
| **AER-002** | "Paid tool calls" wording ≠ implemented predicate | **CLOSED 2026-09-07 — and the finding was partly over-accepted on intake.** The contract is a **project dispatch freeze**: an exhausted project blocks attributed tools priced `null`/`0` too. But AER-002 locates the narrow wording in "the ADR title", which is **false** — ADR-0103 is titled *"Gate the MCP tool-call path on the project budget"*, already carries an explicit *"It does not gate on the price of this call"* section, and checklist row 58 already spells out the unpriced case. Genuinely narrow: the **commit subject** (immutable) and `STATE.md`'s headline, both now fixed. Recorded because accepting a reviewer's framing without checking it is the same error the reviewer is helping us find. |
| **AER-003** | Verification host violates the pinned package manager | **PARTLY MISATTRIBUTED — corrected.** The repo *does* pin correctly (`packageManager: pnpm@10.33.0`; this container runs 10.33.0), and CI installs with `--frozen-lockfile` via `pnpm/action-setup@v4`, which reads that field — so the lockfile rewrite Codex saw was **its host ignoring the pin**, not a missing declaration. The legitimate residue is real though: `README.md:69` documents only `pnpm install && pnpm -r build` — no frozen lockfile, no corepack step, no single clean-checkout command. → **R2**. |
| **F03** | Cap semantics under concurrency | **OPEN, by explicit ADR-0103 limitation.** Measured-spend, first-crossing-allowed; not a reservation. Needs a hold ledger, not another call site. |
| **F04** | Secrets outside `audit_log` | **CLOSED** by ADR-0102 (51 columns, structural `information_schema` guard). Codex correctly flags it as *repository-reported, not independently rerun*. Its **extension is genuinely new and open**: exports, backups, traces, conversations were never assessed. → **R3**. Distinct from **S6** (content columns). |
| **F05** / **PF-01** | Approval not bound to its payload | **CLOSED for the MCP tool path** (ADR-0104, migration 0106) — **but PF-01 asks for materially more.** See §2. |
| **F06** | End-to-end journeys unproven | **OPEN.** Largely owner-gated (live provider creds). |
| **F07** | Install / upgrade / recovery unvalidated | **OPEN.** Largely owner-gated. |
| **F08** | Documentation contradictions | **MOSTLY CLOSED.** Stale S3-sink and copilot-applier rows struck; `STATE.md` front matter caught up. One item was **overstated by us**: `/app` and `/admin` do not 404 — they 302 to `/ui` and resolve 200. Marketing-claim items (guardrails as heuristics, training-provider as retrieval + classical classification) unassessed. |
| **PF-02** | Cryptographic agent/workload identity | **OPEN, correctly observed.** `agents` is a governance record, not an authenticating identity; governed invocations act under a human `userId`. |
| **PF-03** | Agent SRE: SLOs, breakers, kill switches, quarantine | **OPEN.** Note the collision it names itself: automatic runtime quarantine conflicts with the deliberate no-auto-revoke stance, and needs its own ADR. |
| **PF-05** | Generalize policy intervention points + safe transforms | **OPEN.** Kernel exposes `allow`/`deny`/`require_approval` only. |
| **PF-06** | Real isolation, task-scoped creds, compensation | **OPEN.** Correctly warns against calling an in-process permission check a sandbox. |
| **PF-07** | MCP / supply-chain admission hardening | **PARTLY BUILT.** ADR-0097 admission scanning, ADR-0100 scheduled rescan, ADR-0101 federation exist. Delta: Unicode confusables, typosquat/collision analysis, signed publisher provenance, version/digest pinning, exfil-URL scanning of *results*, A2A agent-card scanning. |
| **PF-08** | Portable enforcement SDKs / framework adapters | **OPEN.** A private TS API client exists; no framework middleware. |
| **PF-09** | Decision BOM + AI BOM | **OPEN, ingredients present.** Hash-chained audit, WORM anchoring, traces, lineage, cost all exist but are not exportable as one verifiable per-decision bundle. |
| **PF-10…PF-14** | Red-team orchestration, pluggable classifiers, artifact admission, AISVS control graph, AI SecOps | **OPEN.** All P2 in the source document. |

## 2. PF-01 vs ADR-0104 — what is actually done, and the honest delta

PathForward reviewed `271bdca`, which **predates ADR-0104** (`3add994`). PF-01 is therefore
partly answered already, and the plan must not schedule it as greenfield.

**Delivered by ADR-0104:** a canonical, key-sorted fingerprint over `{projectId, arguments}`;
consent action-scoped by default with an explicit `tool` escape hatch; a **scrubbed** approver-facing
preview; the executed digest on the audit row under either scope; single-use consumption preserved;
dedup keyed on the digest so two payloads cannot collapse into one approval.

**Still missing, and this is the real PF-01 backlog:**

1. **Dual digest.** ADR-0104 stores one fingerprint. PF-01 wants **proposed** *and* **enforced**
   digests, with the enforced one **recomputed immediately before execution** and a fail-closed
   mismatch. Today nothing re-verifies between consumption and forwarding.
2. **Envelope breadth.** The fingerprint covers `{projectId, arguments}`. PF-01's envelope also
   binds **authenticated agent identity** (blocked on PF-02), run/stage, **policy and config
   versions**, target, and any policy transform (blocked on PF-05).
3. **Expiry and idempotency.** Approvals have no TTL and no defined retry semantics.
4. **Scope beyond MCP.** Binding covers the MCP tool path only. Connector and model-dispatch
   approvals are unbound.
5. **ABAC scope dial.** `abac_policies` has no `approval_scope`; a policy-driven pause defaults to
   `action` (fail-closed, correct) with no way to elect `tool`.

## 3. Proposed bucketing

### R — Reconciliation (do first; cheap, and everything else reads these files)

| Ref | Item |
|---|---|
| **R0** | Reconcile §Bucket 1–3 against `docs/decisions/README.md`; mark built ADRs. Without this the plan actively misleads — the failure F08 already caught once. |
| ~~**R1**~~ | ~~Fix the "paid tool calls" wording~~ **DONE 2026-09-07.** Scope was smaller than filed — the ADR and checklist were already accurate; only `STATE.md`'s headline was narrow. ADR-0103 gained an explicitly named contract line ("project dispatch freeze"). |
| **R2** | One documented, pinned clean-checkout command (corepack + `--frozen-lockfile` + build + typecheck + test) that leaves `git status --short` clean; correct `README.md:69`. Closes AER-003's real residue. |
| **R3** | Assess F04's untouched surfaces — exports, backups, traces, conversations — with synthetic secrets. Assess before asserting either way. |

### NOW — trustworthy evidence, then trusted actions (PathForward Waves 0–1)

| Ref | Item | Note |
|---|---|---|
| **N1** | Close `socket.destroySoon`; make a failing assertion **and** an unhandled error each fail the gate | F01 / PF-04 / Wave 0. The gate is the prerequisite for trusting every claim below it. |
| **N2** | `.at(-1)` sweep over raw `db.select()` without `ORDER BY` (86 candidate sites) | F01. Two live flakes found this way already. |
| **N3** | PF-01 delta items 1–3: dual proposed/enforced digest with pre-execution recompute, expiry, idempotency | Builds directly on ADR-0104; the highest-value increment available. |
| **N4** | F03 — decide and document cap semantics; test at the boundary | Pairs with N3; a reservation ledger is a *decision*, not a given. |
| **N5** | Product's own security CI: SAST, secret scanning, dependency/container scanning, SBOM | PF-04 / Wave 0. |

### CORE — before a customer pilot

| Ref | Item | Note |
|---|---|---|
| **C1** | PF-02 workload identity + constrained delegation | **Suite-gated** — cross-module; needs the suite ADR/capability-map process. Unblocks PF-01 item 2 and PF-08. |
| **C2** | PF-03 SRE: SLOs, breakers, kill switches, OTel **metrics**, durable notifications | Note: escalations currently notify nobody. Automatic quarantine needs its own ADR (collides with the deliberate no-auto-revoke stance) — ship observe → recommend → auto in that order. |
| **C3** | PF-09 Decision BOM v1 | Ingredients exist; this is assembly + offline verification. |
| **C4** | PF-07 supply-chain delta: confusables, typosquat, publisher provenance, digest pinning | Extends ADR-0097/0100/0101. |
| **C5** | F06 + F07 journeys, install/upgrade/restore proof | Owner-gated on live creds and a separate box. |
| **C6** | PF-05 policy intervention points + bounded `transform` | Prerequisite for PF-01 item 2's transform binding. |

### DEFERRED — real, sequenced behind the above

PF-06 (isolation, task-scoped credentials, compensation — **do not ship anything called a sandbox
until there is a real OS/runtime boundary**), PF-08 (SDKs/adapters — gated on C1), PF-10 (red-team
orchestration), PF-11 (classifier providers), PF-12 (artifact admission — **suite-gated**, model
runtime ownership may sit in the LLM module), PF-13 (AISVS control graph), PF-14 (AI SecOps,
sequence analytics). **S6** (content columns) and the marketing-claim review from F08 also sit here.

## 4. Three competing orders, and what to actually do

This project now holds three sequencing proposals that optimize for different things:

- **This plan (2026-08-01)** — *salability*: identity → BYOC → security items → differentiators.
- **Codex** — *pilot trustworthiness*: test gate → governance enforcement → secrets → journeys →
  install → docs.
- **PathForward** — *strategic positioning*: Wave 0 evidence → Wave 1 trusted actions → supply
  chain → ecosystem → SecOps.

They agree on more than they differ: **all three put making the evidence trustworthy before
building on top of it**, and Codex's order and PathForward's Wave 0 are nearly the same list.
The recommendation is **R → NOW → CORE**, which follows Codex/PathForward, with this plan's
salability ordering used to break ties *within* CORE — because an unreliable gate makes every
salability claim above it unfalsifiable, and R0/R1 make the planning documents themselves honest
before anyone sequences from them.

**Owner decisions this addendum cannot make:** whether to adopt the control-plane positioning at
all (PathForward is a *proposal*); whether F03 needs true reservations or a documented threshold;
whether automatic quarantine may ever act without a human; and every suite-gated item (C1, PF-12),
which needs `MODULE_REGISTRY.md` / `CAPABILITY_MAP.md` — **not readable from this environment**.

## 5. Standing constraint, restated

PathForward's own definition-of-done forbids "enterprise-ready", "complete", "certified" or
"production-ready" claims without fresh executable evidence. That agrees with this repo's standing
guardrail: **nothing gets a production designation, and nothing deploys to one, without the owner's
direct explicit sign-off in that session.** Wave 4's language about "enterprise deployment" does not
alter it.

# AI Intake Demo Script — 2026-10-05 (v2)

**Objective:** show the three phases of agentic AI governance — **Discover & Register → Assess &
Deploy → Monitor & Respond** — as one journey: Acme Bank finds an unregistered credit-team LLM
prototype, registers it, gets it approved by an independent reviewer, and then governs it in
production.

**Rule for this script:** every beat below is one `demo:check` reports **PASS** on a fresh
database, and the whole journey (register → approve → alert → remediate → graph → regulatory →
signed export) runs green in `apps/web/e2e/demo-intake.spec.ts` against that database. Read the
live numbers off `demo:check` on the day — the figures quoted here are from the 2026-10-02 run.

---

## 0. Setup (one command, then the gateway)

Once, from the repo root: `pnpm install` then `pnpm -r build` (the gateway serves the built UI).
Postgres 16 with an **empty** database. With docker, a throwaway container (the compose `db`
service deliberately publishes no host port):
`docker run -d --name regulait-demo-pg -e POSTGRES_USER=regulait -e POSTGRES_PASSWORD=regulait -e POSTGRES_DB=regulait_demo -p 5432:5432 postgres:16`
— or a native Postgres (DEMO_RUNBOOK.md §1.1). Then set the environment for every command (one
terminal, same values throughout):

```bash
export DATABASE_URL=postgres://regulait:regulait@127.0.0.1:5432/regulait_demo   # an EMPTY database
export REGULAIT_BOOTSTRAP_TOKEN=<any long random string>
export REGULAIT_DATA_KEY=$(openssl rand -hex 32)        # 64 hex chars — keep it for the whole demo
export REGULAIT_EPHEMERAL_LICENSE=1 REGULAIT_LICENSE_KEYRING=$HOME/.regulait-demo-keys
```

Windows PowerShell equivalent:

```powershell
$env:DATABASE_URL = "postgres://regulait:regulait@127.0.0.1:5432/regulait_demo"
$env:REGULAIT_BOOTSTRAP_TOKEN = "<any long random string>"
$env:REGULAIT_DATA_KEY = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$env:REGULAIT_EPHEMERAL_LICENSE = "1"; $env:REGULAIT_LICENSE_KEYRING = "$HOME\.regulait-demo-keys"
```

To start over, recreate the database (`docker rm -f regulait-demo-pg`, re-run the `docker run`)
— the journey changes it, and `demo:prepare` seeds an empty database only. A full rehearsal of the UI journey, unattended:
`E2E_BASE_URL=http://127.0.0.1:3105 pnpm --filter @regulait/web exec playwright test -c
playwright.demo-real.config.ts` (needs `REGULAIT_BOOTSTRAP_TOKEN=e2e-bootstrap-token`).

1. `pnpm --filter @regulait/gateway demo:prepare` — seed → demo:setup → demo:intake →
   demo:traffic → demo:check in ~25 s. It must end **17 pass, 0 warn, 0 fail**. The seed step
   prints each persona's **one-time password** — copy them.
2. `PORT=3105 pnpm --filter @regulait/gateway start` (PowerShell: `$env:PORT = "3105"` first) —
   the gateway serves the UI at `http://127.0.0.1:3105/ui`.
3. Two browser profiles, each signs in once with its one-time password and sets a new one:
   - **Profile A — Ada** (`admin@regulait.local`): governance admin. Drives every `/ui/admin/*`
     page and **proposes** remediations.
   - **Profile B — Avery** (`avery@regulait.local`): independent approver. Works only in
     `/ui/inbox`. Use-case sign-offs are routed to Avery (ADR-0165), so the proposer is never
     the approver.
4. Optional — a third terminal for the pipeline beat (2C) with the same environment.

Everything runs on the keyless **mock** provider. No live model, no external network.

---

## Phase 1 — Discover & Register

### 1A. Shadow AI discovery — Ada
- **URL:** `/ui/admin/shadow-ai`
- **Screen:** 4 findings from imported evidence (egress / SaaS exports). The first:
  *Credit Team LLM Prototype* — Anthropic usage, source `saas_export`.
- **Action:** on that finding, click **Register as use case**.
- **Say:** "Governance usually starts by finding AI nobody registered. RegulAIt classifies the
  evidence you already have; we bring the system into the governed path instead of just blocking
  it. Detection is a signal, not proof — the coverage panel says exactly which sources we saw."

### 1B. AI intake — Ada
- **URL:** `/ui/admin/governance/intake?source=shadow-ai…` (opened by 1A)
- **Screen:** the banner *"Prefilled only from shadow-AI record …: name and observed-use
  description."* Every screening answer is **blank** — the finding did not establish them.
- **Action — Ada enters the EU AI Act answers** (credit context):
  purpose **Essential services** · people affected **Customers** · decision autonomy **Human
  reviews every recommendation** · biometric **None** · sectors **financial services** · data
  categories **personal + financial** · deployment **Customer-facing** · profiles natural persons
  **Yes** · interacts with people **Yes** · generates content **Yes** · EU nexus **Yes** ·
  external vendor **Yes** · everything else **No**.
  Then **Draft suggestions**.
- **Screen:** *Proposed tier: high* with the rule reasons; frameworks and risks, each with a
  `rules` source badge. Accept or edit each suggestion, **Continue** through the questionnaire and
  stack, and on **Review** point at *Data sensitivity: regulated — derived from the declared data
  categories*. **Submit for human review**.
- **Say:** "The tier is computed from the structured EU AI Act answers by deterministic rules —
  not from a description, and never from a model. Suggestions are suggestions: each one is
  accepted, edited or rejected by a person. High-risk obligations apply from 2 December 2027
  under the Digital Omnibus — we're screening for them today."
- **If the assistant call fails:** fill the questionnaire by hand; submission is the same path.

---

## Phase 2 — Assess & Deploy

### 2A. Use-case 360 and risks — Ada
- **URL:** **Open the use-case workspace** (link after submit) → `/ui/admin/governance/use-cases/<id>`
- **Screen:** status **under review**, **high tier**, 7 tabs: Overview, Frameworks, Risks, Stack,
  Dependencies, Approvals, Audit.
- **Action:**
  1. **Stack** — the agent card: declared purpose, data sources, owner, model cards with their
     sign-off.
  2. **Risks** — **Add risk from library**: search, pick an agentic scenario, choose likelihood
     and impact yourself (nothing is pre-rated), **Assess and add**; link a suggested control and
     set a residual rating.
- **Say:** "One governed view of the system. Risk scenarios suggest structure only — the
  registrant declares likelihood and impact, and residual risk is recorded against a named
  control."

### 2B. Independent approval — Avery
- **URL:** `/ui/inbox` (Profile B)
- **Screen:** *Sign-off · signoff · AI use-case intake: Govern Credit Team LLM Prototype —
  requested by Ada Admin*, with the submitted questionnaire.
- **Action:** **Approve** (optional reason). The row moves to *Recently decided*.
- **Back in Profile A:** the use case now reads **approved**; the **Audit** tab shows the decision.
- **Say:** "Separation of duties is structural: the sign-off is routed to an independent
  approver, so the person who registered it cannot approve it. The decision is one audited row."

### 2C. CI/CD deploy gate — the pipeline (terminal)
- **Action:** `pnpm --filter @regulait/gateway demo:gate -- "Real-Time Fraud Detection Engine" production build-4417`
- **Screen:** `DENY` with two **BLOCK open_high_alert** lines (an inherited HIGH rating, and
  traffic served outside the approved stack) and a **WARN** for an unowned agent; *pipeline
  STOPPED*; exit code 1.
- **Then:** in Profile A, acknowledge those two alerts (3B shows how), re-run the command:
  `ALLOW` with the same items now **WARN acknowledged_high_alert**; exit 0.
- **Say:** "The pipeline asks the same governance state the runtime enforces — approval, the
  approved stack, halts, the model-risk gate, open alerts. An open HIGH alert blocks; once a
  person has acknowledged it, it becomes a warning. Every answer is audited with the build ref."

---

## Phase 3 — Monitor & Respond

### 3A. Trust dashboard — Ada
- **URL:** `/ui/admin/governance/trust`
- **Screen:** six-axis radar, KPI tiles, heatmap. 2026-10-02 figures: bias 100 %, security 50 %,
  privacy **unmeasured**, reliability 0 %, safety 0 %, compliance 80 %.
- **Action:** point at the unmeasured axis (privacy), then open the **security** drill-down.
- **Say:** "Each axis is evidence coverage: the share of applicable active-pack controls with
  evidence — measured from platform ledgers and guardrail configuration, with attestation-based
  controls labelled. An axis with no applicable control is shown as unmeasured, never as a score."

### 3B. Governance alerts and remediation — Ada, then Avery
- **URL:** `/ui/admin/governance/alerts` → **Evaluate now**
- **Screen:** the monitor's alerts (14 active on 2026-10-02) from its 9 rules, including:
  - *"… inherits a HIGH rating from Acme Internal AI Platform"* — with the propagation path;
  - *"balanced-mock returned flagged content in 1 of N evaluated response(s) (semantic_dlp)"* —
    continuous trace evaluation caught a credential the inline guardrail let through;
  - *"N call(s) for Internal IT Knowledge Base Bot (to balanced-mock) were served by
    fast-mock, which is outside its approved stack"* — the cost optimizer moved approved traffic
    to an agent the approval never covered;
  - *"… depends on premium-mock, which is unowned"*.
- **Action:**
  1. Open an **unowned-agent** alert → **Acknowledge** with a note.
  2. Under **Remediation**, the executable candidate *"Make Dana Developer the owner of …"*:
     choose **Avery** as independent approver → **Propose…**.
  3. **Avery** (`/ui/inbox`): *Governance remediation · Make Dana Developer the owner of …* →
     **Approve**.
  4. **Ada:** reload the alert — the approved action ran (the agent now has an owner) and the
     alert is **resolved**; **Evaluate now** confirms the condition is gone.
  5. Open the leakage or off-stack alert: its remediation is **guidance** only (tighten the output
     guardrail / keep traffic on the approved stack) — a person decides.
- **Say:** "Nothing changes governed state until a different human approves it. The platform
  executes only the approved action; everything else is guidance with steps."
- **If an alert is missing:** **Evaluate now** runs the same sweep as the hourly job.

### 3C. Dependency graph — Ada
- **URL:** `/ui/admin/governance/graph`
- **Screen:** use case → agent → model → vendor (declared) plus observed runtime edges; 3 use
  cases inherit their rating (e.g. *Internal IT Knowledge Base Bot*, high).
- **Action:** select the use case and follow the path to the vendor whose recorded HIGH risk it
  inherits; **Open this agent** lands on the agent in the catalog.
- **Say:** "A high risk recorded against a vendor propagates to everything that depends on it, as
  a maximum, and we show the path."

### 3D. Regulatory intelligence — Ada
- **URL:** `/ui/admin/governance/regulatory`
- **Screen:** 13 source-dated entries; in force / next effective; the Digital Omnibus on AI
  (Regulation (EU) 2026/1744, in force 2026-07-27) moving Annex III high-risk obligations to
  2 December 2027; our use cases in scope and the control gaps.
- **Say:** "Each entry is dated against its source and joined to our own controls and use cases —
  which systems a change touches, and what we have not evidenced yet."

### 3E. Evidence — Ada
- **URL:** `/ui/admin/audit`
- **Action:** **Download signed bundle** — an offline-verifiable `.tar.gz` (CSV, manifest,
  signature) of the filtered audit trail: the registration, Avery's decisions, the alerts, the
  gate answers, and the runtime refusal of a prompt carrying an SSN in the HIPAA project.
- **Say:** "Everything you saw is in one hash-chained audit trail, exportable for an auditor."

---

## What is mock vs. live

- **Mock:** the model provider (keyless mock agents); the shadow-AI evidence is a seeded import;
  the governed traffic is generated by `demo:traffic` through the real dispatch path.
- **Live:** every page and API shown; dashboard figures are queries over the seeded ledgers; the
  monitor, trace evaluation, remediation, deploy gate and approvals are the product code paths.
- **Never claim** automatic remediation: discovery, mapping and monitoring are automated;
  changes to governed state are human-approved.

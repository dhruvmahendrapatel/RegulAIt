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
export REGULAIT_OFFLINE_CHECKS=1   # no CI in the demo: the seeded check stages auto-pass, labelled (AER-047)
```

Windows PowerShell equivalent:

```powershell
$env:DATABASE_URL = "postgres://regulait:regulait@127.0.0.1:5432/regulait_demo"
$env:REGULAIT_BOOTSTRAP_TOKEN = "<any long random string>"
$env:REGULAIT_DATA_KEY = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$env:REGULAIT_EPHEMERAL_LICENSE = "1"; $env:REGULAIT_LICENSE_KEYRING = "$HOME\.regulait-demo-keys"
$env:REGULAIT_OFFLINE_CHECKS = "1"
```

`REGULAIT_OFFLINE_CHECKS=1` must be set in the **gateway's** terminal (step 2 below). A workflow
check nobody reports now waits for a report (AER-047); the seeded demo templates opt in to a labelled
offline auto-pass ("auto-passed · no report"), which a gateway honours only when this variable is
set. Without it, the live pipeline chain stops at its checks stage with "waiting on check results".

Then the **export-signing key** for beat 3E (ADR-0116: the deployment, not the product, holds it —
without it "Download signed bundle" answers 409): run
`pnpm --filter @regulait/gateway demo:export-key` and set the two variables it prints
(`REGULAIT_EXPORT_SIGNING_KEY`, `REGULAIT_EXPORT_SIGNING_KEY_ID`) in the same terminal. It
creates the key under `~/.regulait-demo-keys` once and reuses it, so the fingerprint it prints is
stable across rehearsal and demo. (bash shortcut: `eval "$(pnpm -s --filter @regulait/gateway
demo:export-key -- --env)"`.)

To start over, recreate the database (`docker rm -f regulait-demo-pg`, re-run the `docker run`)
— the journey changes it, and `demo:prepare` seeds an empty database only. **A demo database
prepared before 2026-10-03 must be recreated** the same way: its seeded pipeline templates predate
the AER-047 offline opt-in, so their check stages wait for reports even with
`REGULAIT_OFFLINE_CHECKS=1` set. A full rehearsal of the UI journey, unattended:
`E2E_BASE_URL=http://127.0.0.1:3105 pnpm --filter @regulait/web exec playwright test -c
playwright.demo-real.config.ts` (export the gateway's own `REGULAIT_BOOTSTRAP_TOKEN` in that
terminal; the spec falls back to `e2e-bootstrap-token` only when it is unset).

1. `pnpm --filter @regulait/gateway demo:prepare` — seed → demo:setup → demo:intake →
   demo:traffic → demo:check in ~25 s. It must end **18 pass, 0 warn, 0 fail** (a FAIL on
   "3 Evidence" means the export key variables are not set in this terminal). The seed step
   prints each persona's **one-time password** — copy them.
2. `HOST=127.0.0.1 PORT=3105 pnpm --filter @regulait/gateway start` (PowerShell: `$env:HOST =
   "127.0.0.1"; $env:PORT = "3105"` first) — the gateway serves the UI at `http://127.0.0.1:3105/ui`.
   `HOST=127.0.0.1` keeps the plaintext gateway (and its bootstrap token) off the venue Wi-Fi; the
   boot line prints the bound address, so check it says `127.0.0.1`.
3. Two browser profiles, each signs in once with its one-time password and sets a new one:
   - **Profile A — Ada** (`admin@regulait.local`): governance admin. Drives every `/ui/admin/*`
     page and **proposes** remediations.
   - **Profile B — Avery** (`avery@regulait.local`): independent approver. Works only in
     `/ui/inbox`. Use-case sign-offs are routed to Avery (ADR-0165), so the proposer is never
     the approver.
   - Optional **Profile C — Dana** (`dana@regulait.local`), only for the optional beat 2B+ (the
     second reviewer). Sign her in during setup too, so the beat costs no password changes live.
4. Optional — a third terminal for the pipeline beat (2C) with the same environment.

Everything runs on the keyless **mock** provider. No live model, no external network.

**The left navigation rail auto-hides (ADR-0169).** It rests as a slim icon strip; hovering it
(or tabbing into it) opens it — on hover it opens over the page, on keyboard focus the page makes
room. **Pin navigation** at the bottom of the rail keeps it open, remembered per browser — pin it
in every profile before the demo if you would rather it did not move while you present.

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

### 1B. Register the AI use case — Ada
- **URL:** `/ui/admin/governance/intake?source=shadow-ai…` (opened by 1A) — the **one** way to
  register a use case; the **AI registry** (`/ui/admin/use-cases`) opens the same page from
  **Register AI use case**.
- **Screen:** **Register AI use case** — a numbered stepper (Describe → Classify → Suggestions →
  Questionnaire → Link stack → Review) and, on the right, **Similar use cases**: anything already
  registered that looks like this one, so nobody files a duplicate. The banner *"Prefilled from a
  shadow-AI finding — only its name and observed use."* Every screening answer is **blank** — the
  finding did not establish them.
- **Action — Describe:** the name and purpose are prefilled; point at the similar-use-cases rail,
  then **Continue**.
- **Action — Classify: Ada enters the EU AI Act answers** (credit context):
  purpose **Essential services** · people affected **Customers** · decision autonomy **Human
  reviews every recommendation** · biometric **None** · sectors **financial services** · data
  categories **personal + financial** · deployment **Customer-facing** · profiles natural persons
  **Yes** · interacts with people **Yes** · generates content **Yes** · EU nexus **Yes** ·
  external vendor **Yes** · everything else **No**.
  Then **Draft suggestions**.
- **Screen:** *Proposed tier: high* with the rule reasons; frameworks and risks, each with a
  `rules` source badge and **not reviewed** — Continue stays disabled until each has a decision.
  Reject one (e.g. SOC 2) to show it, then **Accept all remaining**. **Continue** through the
  questionnaire; on **Link the governed stack** choose **claude-opus** and the vendor
  **Anthropic** (what the shadow evidence pointed at). On **Review** point at *Data sensitivity:
  regulated — derived from the declared data categories*. Review now shows the whole proposal —
  optionally open **Who receives this** to show the high tier routes to the Privacy and Security
  reviews. **Submit for human review**.
- **Optional (if asked "what if I'm not sure?" or "what if I close the tab?"):** every yes/no
  question has a **Not sure** option that counts as *yes* and is flagged to reviewers, and the
  wizard saves a draft as you go — reopen it and choose **Resume your draft**. Do not demo this
  live; it is a talking point.
- **Say:** "The tier is computed from the structured EU AI Act answers by deterministic rules —
  not from a description, and never from a model. Suggestions are suggestions: each one is
  accepted, edited or rejected by a person. High-risk obligations apply from 2 December 2027
  under the Digital Omnibus — we're screening for them today."
- **If the assistant call fails:** fill the questionnaire by hand; submission is the same path.

---

## Phase 2 — Assess & Deploy

### 2A. The use-case record and risks — Ada
- **URL:** **Open the use-case workspace** (link after submit) → `/ui/admin/governance/use-cases/<id>`
  (the AI registry also opens it: click a row, then **Open use case** in its preview)
- **Screen:** the record's header band — *AI use case*, the name, status **under review**, **high
  tier**, owner. Overview leads with the **lifecycle tracker** (Proposed → Under review → Approved →
  Monitoring) and its activities — business context, EU AI Act screening, data and AI models, risks
  and safeguards, sign-off — each with its status, owner and last update, all derived from what was
  just submitted (nothing typed twice). Tabs: Overview, Frameworks, Risks, Stack, Dependencies,
  Approvals, Audit.
- **Action:**
  1. **Stack** — the agent card for **claude-opus**: declared purpose and owner; its
     model card reads **Not signed off** in the **Model cards** list, and the header's facts strip
     already flags "1 agent lacks an approved model card". Under the card, the stewardship line —
     *Steward: Dana Developer · Successor: Ada Admin* (ADR-0168 item 6: every agent has a named
     steward and successor; an agent with no live steward is flagged **Orphaned**, and the
     **Agents** page, `/ui/admin/agents`, shows exactly one — **grok**, seeded with only a
     successor).
     **Dependencies** shows the chain use case → claude-opus → model → Anthropic.
  2. **Risks** — **Add risk from library**: search, pick an agentic scenario, choose likelihood
     and impact yourself (nothing is pre-rated), **Assess and add**; link a suggested control and
     set a residual rating.
- **Say:** "One governed view of the system. Risk scenarios suggest structure only — the
  registrant declares likelihood and impact, and residual risk is recorded against a named
  control."

### 2B. Independent review — Avery
- **URL:** `/ui/inbox` (Profile B)
- **Screen:** *AI use case sign-off · Govern Credit Team LLM Prototype — requested by Ada Admin*.
  Click **Review**: the **review task** opens beside the inbox — what is being decided (tier and
  why, risks with inherent → residual, controls, the questionnaire, the stack) next to the
  decision: **Approve · Approve with conditions · Send back for information · Reject**.
- **Action:** choose **Approve with conditions**; add one condition — *"Approve the claude-opus
  model card before go-live"*, owner **Ada**, due in two weeks, **Before go-live (holds
  deployment)** — then **Approve with conditions**. The row moves to *Recently decided*.
- **Back in Profile A:** the record reads **approved**, *Approval valid until* six months out (high
  tier), and the tracker flags **1 before-go-live condition open**; **Conditions of approval** lists
  it with **Mark met**. The **Audit** tab shows the decision.
- **Say:** "Separation of duties is structural: the sign-off is routed to an independent reviewer,
  so the person who registered it cannot approve it. Real reviews end in more than yes or no — a
  condition that must be met before go-live holds the deploy gate until its owner marks it met, and
  every approval expires: six months for high risk, twelve otherwise, then it comes back for
  re-review."

### 2B+ (optional, if time). Review policy — two reviewers and a send-back — Ada, Dana, Avery
Skip this beat if the clock is tight: nothing later depends on it, and the Monday journey above
(one named approver) is unchanged. It is rehearsed by `apps/web/e2e/demo-review-policy.spec.ts`,
which runs after the Monday journey on the same `demo:prepare` database (that spec puts the policy
back afterwards; a live run leaves it set — recreate the database before the next rehearsal).
- **URL:** **AI Governance → Review policy** (`/ui/admin/governance/review-policy`, Profile A).
- **Action — Ada sets the policy:** **+ Add role** *Security*, add **Avery Approver**; **+ Add role**
  *Privacy*, add **Dana Developer**; tick both under **Required reviews for the high tier** (it reads
  *2 required reviews*); optionally set the high tier's approval lifetime (e.g. 12 months); add
  **Avery Approver** as a **risk acceptor**; **Save policy** (*Last changed … by Ada Admin*).
- **Action — a second high-tier use case:** **AI intake** → **Fill in an example**, give it a new
  name (e.g. *Credit-limit assistant*), **Draft suggestions** (*Proposed tier: high*), **Accept all
  remaining**, Continue to **Submit for human review**.
- **Action — Dana sends it back** (Profile C, `/ui/inbox` → **Review**): the panel says *Privacy
  review*, *… of 2 reviews*, and lists Security as *Awaiting decision* under **Other reviews**.
  Choose **Send back for information**, give the reason (e.g. *"Say whether autonomous actions are
  in scope and attach the DPIA reference."*), **Send back**. Avery's review closes with the round
  (the record's tracker reads *Closed — another review ended the round*).
- **Action — Ada resubmits** (Profile A, the use-case record): **Update and resubmit** — the
  registration screen, prefilled with every Classify answer, the reason shown under *Why it was
  sent back*; the name is read-only. Change one answer (e.g. *Can take autonomous actions* → yes),
  update the questionnaire, **Resubmit for review**. A new round opens with two pending reviews.
- **Action — both approve:** Avery chooses **Approve**, ticks **Accept residual risk**, picks a
  risk and writes why the residual risk is acceptable; then Dana **Approve**. The record reads
  **approved** with one sign-off per review, and the risk reads *accepted* by Avery with the
  rationale.
- **Say:** "How many people must sign is policy, not code: each tier names one or more reviews —
  security, privacy, legal, model risk — and anyone in a role can take that review, never the
  proposer. One send-back ends the round; the resubmission is a new round with fresh reviews. Risk
  is accepted by a named person, against named risks, with a reason, and audited. And a change after
  something has shipped re-runs the review and ships again through a new pull request — the earlier
  round's merge and deploy stay history, never 'already done'."

### 2C. CI/CD deploy gate — the pipeline (terminal)
- **Action:** `pnpm --filter @regulait/gateway demo:gate -- "Real-Time Fraud Detection Engine" production build-4417`
- **Screen:** `DENY` with exactly two **BLOCK open_high_alert** lines — an inherited HIGH rating
  from *Acme Internal AI Platform*, and *1 call … to premium-mock was served by fast-mock, which is
  outside its approved stack* — then `assurance: enforced (mode enforce)`, one plain-language line
  per reason code, and *pipeline STOPPED*; exit code 1. (Verified on the 2026-10-03
  integrated build: since agent stewardship, premium-mock has a steward, so the earlier
  unowned-agent WARN no longer prints.)
- **Why no required-test line (ADR-0180):** the high tier requires the OWASP prompt-injection,
  sensitive-information, excessive-agency and agentic test classes, passed within 30 days on the
  agent's current configuration. `demo:intake` runs the *Demo assurance suite* red-team library
  (one probe of every attack class the strict defaults map to, three trials per probe; a
  single-trial run, or one the platform blocked, is not evidence) against premium-mock (and
  balanced-mock) through the real red-team route, so those requirements
  are met and add no line. On a database prepared more than 30 days earlier, the gate truthfully adds
  **BLOCK required_test_stale**; re-run `demo:intake` to refresh the evidence. Its one HIGH residual
  risk (*Fraud model falsely blocks transactions …*) carries a seeded, time-boxed acceptance (Ada,
  partial mitigation, two compensating controls, six months), so `residual_above_tolerance` does not
  print either.
- **Then:** in Profile A, acknowledge those two alerts (3B shows how), re-run the command:
  `ALLOW` with the same items now **WARN acknowledged_high_alert**; exit 0.
- **Say:** "The pipeline asks the same governance state the runtime enforces — approval, the
  approved stack, halts, the model-risk gate, open alerts. An open HIGH alert blocks; once a
  person has acknowledged it, it becomes a warning. It also checks continuous assurance live: the
  AI tests this risk tier requires must have passed recently, on the configuration being shipped,
  for every agent. That check is strict by default; an admin can set it to warn or off, and the
  gate says which. Every answer is audited with the build ref."

---

## Phase 3 — Monitor & Respond

### 3A. Trust dashboard — Ada
- **URL:** `/ui/admin/governance/trust`
- **Screen:** six-axis radar, KPI tiles, heatmap. 2026-10-05 figures (NIST AI RMF pack v3, fresh
  `demo:prepare` with the ADR-0180 required-test runs): bias 100 % (2/2), security **40 % (2/5)**,
  privacy 100 % (1/1), reliability 60 % (3/5), safety 0 % (0/2), compliance 70 % (16/23); 63 %
  evidence coverage overall (24/38).
- **Action:** point at the weakest axes (safety 0 %, security 40 %), then open the **security**
  drill-down: 2 of 5 controls evidenced. The seeded required-test red-team runs now count as
  evidence; the three remaining gaps are honest, and the drill-down names each one.
- **Say:** "Each axis is evidence coverage: the share of applicable active-pack controls with
  evidence — measured from platform ledgers and guardrail configuration, with attestation-based
  controls labelled. A low number is a to-do list, not a grade: run a red-team pass and the security
  axis moves. An axis with no applicable control would show as unmeasured, never as a score."
- **If asked about NIST IDs:** the pack is version 3; it corrects two subcategory IDs earlier versions
  had wrong (accountability is GOVERN 2.1, deactivation is MANAGE 2.4). Earlier versions stay as they
  were, because published evidence is immutable.

### 3B. Governance alerts and remediation — Ada, then Avery
- **URL:** `/ui/admin/governance/alerts` → **Evaluate now**
- **Screen:** the monitor's alerts (16 active after the 2026-10-04 rehearsal: 15 open, 1 acknowledged) from its 11
  rules, including:
  - *"Project hipaa-project: 4 model calls in 7 days, no approved use case links this project"* — new on
    2026-10-04: AI spend that no approved use case covers (shadow AI caught from the ledger), with a
    **Register as use case** link that opens intake prefilled. It only observes; nothing is blocked;
  - *"… inherits a HIGH rating from Acme Internal AI Platform"* — with the propagation path;
  - *"balanced-mock returned flagged content in 1 of N evaluated responses (semantic DLP)"* —
    continuous trace evaluation caught a credential the inline guardrail let through;
  - *"N calls for Internal IT Knowledge Base Bot (to balanced-mock) were served by
    fast-mock, which is outside its approved stack"* — the cost optimizer moved approved traffic
    to an agent the approval never covered;
  - *"… depends on grok, which is unowned"* (since 2026-10-03 grok is the one seeded agent with
    no steward; Dana is its named successor, so the remediation below promotes her);
  - *"Project ai-assurance-testing: 12 model calls in 7 days, no approved use case links this
    project"* — since 2026-10-05 (ADR-0180): the seeded required-test red-team runs are billed to
    their own project, and the monitor reports that spend honestly as traffic no use case covers;
  - two **residual_above_tolerance** alerts (ADR-0180): *HR Resume Screening Assistant* and
    *Call-Centre Voice IVR Assistant* each carry a HIGH residual risk with no acceptance. Neither is
    approved, so the story leaves them truthfully above tolerance.
- **Action:**
  1. Open an **unowned-agent** alert → **Acknowledge** with a note.
  2. Under **Remediation**, the executable candidate *"Make Dana Developer the owner of …"*:
     choose **Avery** as independent approver → **Propose…**.
  3. **Avery** (`/ui/inbox`): *Governance remediation · Make Dana Developer the owner of …* →
     **Approve**.
  4. **Ada:** reload the alert — the approved action ran (the agent now has an owner) and the
     alert is **resolved**; **Evaluate now** confirms the condition is gone (the result is the
     status line above the list, not a toast).
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
- **Optional (bash):** `scripts/verify-export-bundle.sh <downloaded file> --fingerprint <the value
  demo:export-key printed>` — verifies offline, with no call to the platform.
- **Say:** "Everything you saw is in one hash-chained audit trail, exportable for an auditor."

---

## What is mock vs. live

- **Mock:** the model provider (keyless mock agents); the shadow-AI evidence is a seeded import;
  the governed traffic is generated by `demo:traffic` through the real dispatch path.
- **Live:** every page and API shown; dashboard figures are queries over the seeded ledgers; the
  monitor, trace evaluation, remediation, deploy gate and approvals are the product code paths.
- **Never claim** automatic remediation: discovery, mapping and monitoring are automated;
  changes to governed state are human-approved.

## Fallback — if the live demo fails

Build an offline walkthrough of every beat from REAL screenshots the night before, on the
rehearsal machine, and keep it open in a browser tab:

1. On a fresh `demo:prepare` database, before anything else touches it:
   `pnpm -s --filter @regulait/gateway demo:gate -- "Real-Time Fraud Detection Engine" production build-4417 > apps/web/e2e/artifacts/demo/real-gate.txt`
   (the DENY is expected; PowerShell: `| Out-File -Encoding utf8 apps\web\e2e\artifacts\demo\real-gate.txt`).
2. Start the gateway and run the real journey (§0, "A full rehearsal of the UI journey").
3. `node apps/web/e2e/fallback-deck.mjs` → `apps/web/e2e/artifacts/demo/fallback-deck.html`, one
   self-contained file (no network). → / Space next, ← back; each slide shows the beat, the
   persona and the screenshot (scroll inside it). The script's **Say** line is hidden by default
   so a shared screen shows the product, not the script: press **S** to show or hide it (T
   switches the screenshot theme on a `--dark` build).

If the projector or laptop fails, the same file opens on any machine. Say plainly that these are
screenshots of the product taken from a real run, not the live system.

# Demo Script — 2026-11-01 (v3): Shadow AI first, then governance

**Decision record:** ADR-0197 (decisions 1-9 and the addendum of 2026-10-18, afternoon). The 2026-10-05 script (`DEMO_SCRIPT_2026-10-05.md`) stays as it was;
this file replaces it for the 2026-11-01 demo.

**Objective:** one journey in three acts.
1. **Find it.** RegulAIt scans a GitLab group, an AWS sandbox account, an Azure subscription and an endpoint device,
   read-only, and finds AI nobody registered.
2. **Bring it in.** A finding becomes a remediation workflow that a second admin, the security lead, signs off. It is
   then registered as a governed use case.
3. **Govern it.** The governance beats from the 10-05 script follow: intake, the record and its risks, independent
   review, the deploy gate, the trust dashboard, alerts and remediation, the graph, regulatory intelligence, evidence
   and accountability.

**Target:** 25 minutes of demo, then 10 minutes of Q&A. Timings are per beat below; the running clock is in the
right-hand column of the timing table.

**Rules for this script**
- Every URL, button and screen label below was read from the UI code on `main` on 2026-10-18 (file named per beat).
  Labels that depend on data (finding subjects, counts, alert text) are marked **to confirm** and are checked at
  rehearsal.
- Every Shadow AI beat has two paths:
  - **LIVE**: real accounts, through the hosted dev instance. The scans have already run before the demo
    (checklist item T-24h). Nothing in the LIVE path waits on a scan in front of the audience. The live database
    holds **only what the real GitLab, AWS and Azure scans (and the real endpoint device) find** (ADR-0197 addendum,
    decision 3): this script promises no subject or count on the LIVE path. Read them off the screen at T-24h.
  - **FALLBACK**: the seeded discovery dataset `demo:prepare` creates (`DEMO_SHADOW_DISCOVERY` in
    `packages/shared/src/demo-intake/shadow-discovery.ts`, loaded by `apps/gateway/src/demo-shadow-seed-lib.ts`),
    on the **local docker compose stack on the presenting laptop**, prepared the night before (addendum, decision 4).
    The fallback specifics below are read from that code; whether they look right on screen is still checked at
    rehearsal.
- **Never claim automatic remediation.** Discovery, mapping and monitoring are automated. Every change to governed
  state is approved by a person, and the sign-off is by someone other than the person who asked for it.
- No real host name, account ID, tenant ID or e-mail address appears in this file or on screen notes. Placeholders
  are written `<like-this>`.

---

## Timing

| # | Beat | Persona | Minutes | Clock |
|---|---|---|---|---|
| 0 | Opening: what we will show | — | 1.0 | 1.0 |
| S1 | Discovery sources | Ada | 3.0 | 4.0 |
| S2 | Findings, sightings, coverage | Ada | 3.0 | 7.0 |
| S3 | Remediation plan → workflow → second approver | Ada, Morgan | 3.5 | 10.5 |
| S4 | Register as use case (intake) | Ada | 3.0 | 13.5 |
| G1 | The use-case record and risks | Ada | 2.0 | 15.5 |
| G2 | Independent review | Avery | 2.0 | 17.5 |
| G3 | Deploy gate (terminal on the dev instance host) | Ada | 1.5 | 19.0 |
| G4 | Trust dashboard | Ada | 1.5 | 20.5 |
| G5 | Alerts and remediation | Ada, Avery | 2.0 | 22.5 |
| G6 | Dependency graph | Ada | 0.5 | 23.0 |
| G7 | Regulatory intelligence | Ada | 0.5 | 23.5 |
| G8 | Evidence | Ada | 1.0 | 24.5 |
| — | Close | — | 0.5 | 25.0 |
| opt | Accountability records (G9), content trust (G10), review policy (2B+ of the 10-05 script) | Ada | 1.5-3 each | only if ahead |

**Cutting order when behind:** G7, then G6, then G4's drill-down, then S1's federation card. Never cut S3 or G2:
separation of duties is the point of both.

---

## Before you present

The full checklist, with what is still pending execution, is in `DEMO_RUNBOOK.md` §7. The short form:

- **T-24h:** every LIVE source has run successfully and its findings are on the Shadow-AI discovery page. A screen
  recording of one real scan (S1 → S2) is captured. The fallback stack on the laptop is prepared with `demo:prepare`
  (the night before) and passes `demo:check`.
- **T-1h:** the three browser profiles below signed in on the hosted dev instance. Navigation pinned (**Pin
  navigation** at the bottom of the rail) in each. Theme chosen and the same in every profile (the user menu's
  **Switch to dark theme** / **Switch to light theme**). The fallback: the laptop's local stack running, the same
  three personas signed in to it in a separate browser so the sessions never mix. A terminal open on the dev
  instance host for G3 (SSH or Session Manager). The recording open in a local player.
- **Personas** (the sign-in addresses are the seeded `@regulait.local` ones):
  - **Profile A — Ada Admin**, governance admin. Drives every `/ui/admin/*` page and initiates the remediation
    workflow.
  - **Profile B — Avery**, the independent governance reviewer (G2, G5). Not an admin. Works only in `/ui/inbox`.
  - **Profile C — Morgan Reyes**, security lead, the demo's second admin (ADR-0197 addendum, decision 1;
    `DEMO_SECURITY_LEAD` in `apps/gateway/src/demo-identity.ts`). She gives the remediation sign-off in S3, because
    the shipped default (owner decision Q7, `admin_not_initiator`) owes it to an admin other than the initiator.
    Works only in `/ui/inbox`.
  - **Two-factor:** Ada and Morgan are admins, so both have MFA. If `demo:set-passwords` was run, it cleared the
    authenticators the seed enrolled (ADR-0181 FX2), and each enrols her own at her next sign-in, during
    preparation. Until Morgan has, `demo:check` FAILs **1 Remediation plan** and says so.

---

## 0. Opening — 1 minute

- **Screen:** Profile A on `/ui/admin/shadow-ai/discovery-sources`.
- **Say:** "Most governance starts with a list somebody typed. We start with what is actually running. First,
  RegulAIt finds AI in our GitLab, our AWS and Azure accounts and on a laptop, read-only, and we bring one of those
  findings under governance with a second person's sign-off. Then we govern it."

---

## Act 1 — Find it

### S1. Discovery sources — Ada — 3 minutes
UI: `apps/web/src/views/admin/governance/DiscoverySourcesPage.tsx`, `FederationCard.tsx`, `EndpointAgentCard.tsx`.

- **URL:** `/ui/admin/shadow-ai/discovery-sources` (navigation: **Discovery sources**).
- **Screen, top to bottom:**
  - Page header **Discovery sources**: *"Where RegulAIt may scan, read-only, for shadow AI. Every source is off until
    you enable it."*
  - **Active discovery** card: the posture sentence, which names each enabled source, for example *"Active discovery
    scans n enabled source(s), read-only: … Nothing outside those sources is scanned."* (the count and names are the
    live data).
  - Four figures: **sources enabled**, **static credentials in use**, **static credentials older than 90 days**,
    **credentials with write scope unverified**.
  - **Scanner kinds** table: GitLab repositories, AWS, Azure and RegulAIt endpoint agent read **built**.
  - **Sources** table, one row per source: name and kind, **State** (*enabled*), **Scope**, **Credential**, **Last
    run** (*succeeded*), and the actions **Disable · Run now · Edit · Replace credential · Revoke credential · Delete**.
  - **Recent runs** table: **Observed / matched**, **Findings** (*n new, n updated*), **Catalogue gaps**, **Reads**
    (*all read*, or *could not read: …* per read).
  - **Cloud federation** card: *on*, and *"Federated AWS, GCP and Entra credentials present a 300-second RS256 token
    from this issuer."*, then the issuer, its key set, the subject format and the audiences. The issuer is
    `<REGULAIT_PUBLIC_URL>/federation`, separate from the workload-identity issuer (`packages/shared/src/discovery/
    federation.ts`).
  - **Endpoint agent enrolment** card: the device table shows the enrolled device as a pseudonym (`psn:…`), its
    platform and agent version, and its user as a pseudonym with a **hardware key** or **software key** badge.
- **Action:**
  1. Point at the **Sources** table, row by row: the GitLab group, the AWS sandbox account, the Azure subscription and
     the endpoint agent source.
  2. On the AWS row, point at the **Credential** column: **federated**. Then scroll to **Cloud federation**.
  3. On the GitLab row, point at the **Credential** column: **static**. Say why (below).
  4. In **Recent runs**, point at the latest run of each source: *succeeded*, observed / matched, findings.
  5. Do **not** press **Run now** live. A scan takes longer than the beat, and the LIVE path never waits on one.
- **Say:** "Every source starts off. Turning one on, or widening what it scans, asks the admin to confirm it's them,
  and is audited. The cloud accounts are read with no stored secret: AWS and Azure trust RegulAIt's own token issuer
  for five minutes at a time, and RegulAIt keeps no key. GitLab is the honest exception today: it reads through a
  read-only group token, encrypted at rest, never shown again, and the posture page lists it as a relaxation. The
  laptop runs our endpoint agent, which reports the names of AI tools, never their contents, signed with a key on
  the device."
- **LIVE:** the four sources configured by the infrastructure lane (ADR-0197 decisions 2-5), scanned at T-24h. The
  run history shows those scans. Point at what is there; promise no count.
- **FALLBACK** (from `demo-shadow-seed-lib.ts`, `demoSourceSpecs`): **five** sources, each named with the suffix
  *(demo dataset)*, all *enabled*:
  - *Acme Bank GitLab (demo dataset)*, GitLab repositories, **static** credential, scope the two repositories;
  - *Acme Bank AWS sandbox (demo dataset)*, AWS, **federated**, scope `us-east-1` and `eu-west-1`;
  - *Acme Bank Azure (demo dataset)*, Azure, **federated**, scope one subscription;
  - *Acme Bank MDM inventory (demo dataset)*, an MDM export imported through the endpoint-inventory import route;
  - *Acme Bank laptops (endpoint agent) (demo dataset)*, the endpoint agent, upload-fed.

  So the posture sentence reads *"Active discovery scans 5 enabled source(s), read-only: …"*. The GitLab, AWS and
  Azure runs are **recorded runs**, replayed through the real discovery worker with no call to the provider. The
  screen does not say so: **Reads** shows *all read*, as for a live run, and the only marker is the *(demo dataset)*
  suffix on each source name. So say it: "on this prepared copy the three network scans are recorded replays through
  the real worker". The **Cloud federation** card reads **off**: the
  seed generates a signing key but does not turn federation on (that is the live instance's step-up). Skip step 2's
  scroll and say federation is on on the live instance. The device in the enrolment card has a **software key**
  badge, and it is there only if the laptop stack has `REGULAIT_PUBLIC_URL` set (otherwise `demo:check` FAILs
  **1 Endpoint agent**).
- **If asked "what if a credential can write?":** a scanner that finds write access marks the credential
  **refused: grants write access**, and the source cannot run until it is replaced with a read-only one. Talking point
  only.

### S2. Findings, sightings and coverage — Ada — 3 minutes
UI: `ShadowAiPage.tsx`, `DiscoverySightings.tsx`, `discoverySourcesModel.ts` (`sightingLines`).

- **URL:** `/ui/admin/shadow-ai` (navigation: **Shadow-AI discovery**; or the **Shadow-AI discovery** link in the
  Active discovery card).
- **Screen:**
  - Header **Shadow-AI discovery**: *"Inventory ungoverned LLM usage from evidence you already have — and pull it into
    governance."*
  - The coverage sentence under it, verbatim from the product: *"Discovery has analyzed n of 4 evidence classes.
    Active discovery scans n enabled source(s), read-only: … Every finding below derives from evidence you supplied or
    from a source an admin enabled, so this inventory reduces shadow AI — it does not prove its absence."*
  - Figures: **Critical (leaked credential)**, **High (observed model traffic)**, **Medium / low**, **Evidence classes
    supplied**.
  - **Inventory** table, *"Every row is a lead for triage, not a verdict."* Columns: **Severity · Subject · Provider ·
    Sources · Confidence · Observations · Sightings · Last seen · Governed replacement · Disposition**, and per row
    **Register as use case · Triage · Remediation plan**.
  - **Coverage scorecard**, *"Gaps are shown, never papered over."*: **Evidence class · Supplied · Imports · Rows ·
    What it sees · What it misses**.
- **Action:**
  1. Read the coverage sentence aloud, last clause included.
  2. Walk three rows, one per family, using the **Sources** and **Sightings** columns:
     - **a repository finding** (Sources *Repo scan*): its sighting line reads `path:line @commit` and, where the
       repository's templates name AI keys, *presence signatures: …*, then *by psn:…* (the commit author's
       pseudonym);
     - **a cloud finding** (Sources *Cloud inventory* or *Cloud audit log*): the AI service the account runs, and the
       calling principal as a pseudonym;
     - **the device finding** (Sources *Endpoint agent*, or *Endpoint inventory* for an MDM row): the AI tool on the
       laptop, the device user as a pseudonym.
  3. Click one `psn:…` link. It opens **Discovery sources** with the pseudonym prefilled in **Reveal a pseudonym**. Do
     **not** press **Reveal** (it asks for a step-up and is audited). Go back.
  4. Point at the **Coverage scorecard**: the import classes that are *off*, with what each would see and what it
     misses.
- **Say:** "Detection is a signal, not proof. Each row says what each scanner saw and where: a path and a line in a
  repository, a service in an account, a tool on a laptop. People are pseudonyms by default; revealing a name is a
  step-up and lands in the audit log. And the page tells you what it could not see. An inventory that hides its gaps
  is worse than none."
- **Note for the presenter:** the scorecard rows are the four *import* classes (egress logs, code scan, SaaS export,
  self-reported). The scanned sources are named in the coverage sentence, not as scorecard rows, so **Evidence classes
  supplied** can read low while four sources are scanned. If asked, say exactly that.
- **LIVE:** real findings only, from the T-24h scans of what the infrastructure lane planted (repositories that use
  AI SDKs, Bedrock usage with CloudTrail, one Azure OpenAI deployment, the endpoint device). No subject, provider or
  count is promised here: choose the three rows to walk at the T-24h check, from what is on screen.
- **FALLBACK** (from `DEMO_SHADOW_DISCOVERY`; `demo:check` asserts each family):
  - **repositories** (*Repo scan*): `gitlab:acme-bank-demo/credit-memo-assistant` (the Anthropic SDK, with the
    presence signature `env.anthropic.api-key` from its `.env.example`) and `gitlab:acme-bank-demo/support-ticket-
    triage` (the OpenAI SDK). The commit author is a team label, shown as a pseudonym;
  - **AWS** (*Cloud inventory*): a Bedrock custom model `acme-complaints-summariser` (`eu-west-1`) and a SageMaker
    endpoint `fraud-score-llm` (`us-east-1`); (*Cloud audit log*): one calling principal, a pseudonym, 412 Bedrock
    calls (`InvokeModel`, `Converse`);
  - **Azure** (*Cloud inventory*): the Azure OpenAI account `acme-openai-eu` and its deployment `branch-faq-bot`
    (`westeurope`);
  - **MDM export** (*Endpoint inventory*): three laptops' AI desktop apps (ChatGPT, Claude, Cursor), devices and users
    as pseudonyms;
  - **endpoint agent** (*Endpoint agent*): the Claude desktop app on one enrolled laptop. The agent's CLI fact and its
    environment-variable fact are dropped by the gateway and only counted: nothing names them on screen.
  - The four imported *Saas export* rows of the 10-05 demo (*Credit Team LLM Prototype*, *ChatGPT Web*, *Claude
    Web*, *OpenAI API Testing*) are still seeded by `demo:intake` and appear in the same table.
- **Source labels:** **Repo scan**, **Cloud inventory**, **Cloud audit log**, **Endpoint inventory**, **Endpoint
  agent** and **Saas export** are what the generic label formatter produces for those evidence kinds (`humanize` in
  `apps/web/src/api/format.ts`); check on screen at rehearsal.

### S3. Remediation plan → workflow → second approver — Ada, then Morgan — 3.5 minutes
UI: `ShadowRemediationPanel.tsx`, `apps/web/src/views/workflows/WorkflowDetailPage.tsx`,
`apps/web/src/views/inbox/InboxPage.tsx`; gateway `apps/gateway/src/shadow-ai-remediation.ts`.

- **Choose the row first** (rehearsal): the finding the rest of the story governs. Pick one with no governed
  replacement and a clear business purpose.
  - **LIVE:** a repository finding from the real scan, chosen at T-24h. It must have no remediation workflow yet.
  - **FALLBACK:** `gitlab:acme-bank-demo/credit-memo-assistant`. `demo:prepare` has **already** started its
    remediation workflow as Ada (environment `staging`), finished planning and submitted the plan, so it waits on
    Morgan's sign-off when the demo starts (`ensureRemediation`; `demo:check` asserts Morgan is the one approver and
    not the initiator). On the fallback, skip Ada's steps below: open the row's **Remediation plan** (it shows the
    link), say "this one was started and submitted during preparation", open the workflow at **waiting for
    sign-off**, and go straight to Morgan.
- **Action — Ada, the plan** (`/ui/admin/shadow-ai`):
  1. On the chosen row, click **Remediation plan**. The **Remediation plan** section opens under the table: the
     subject, provider and severity badges, and **governed replacement: …** or **no governed replacement
     registered**.
  2. Read the numbered steps. Each has a reason; a step that cannot run yet shows **blocked** with why.
  3. Point at *"The default remediation workflow (a plan-only stage, then a human sign-off) is set up when the first
     one starts."* (shown until the first one starts).
  4. Fill **Change description** (prefilled from the plan) and **Environment**: type `staging` **before** drawing
     attention to the field, because its placeholder reads *"for example production"* (`ShadowRemediationPanel.tsx`).
     The environment must be one an admin already gave a meaning to on a deploy target or assignment rule
     (`shadow-ai-remediation.ts`); a `demo:prepare`d database has `staging`. Never type `production`: nothing in this
     demo is production. (Which environment the live instance has configured: check at T-24h.)
  5. **Start remediation workflow…** → the dialog **Start a remediation workflow?** → **Start and link**.
  6. The status line: *"Workflow xxxxxxxx started and linked; the finding is now confirmed"*, then *"Linked to
     workflow …. The loop closes when the next call from … appears in the audit log and usage ledger."* The row's
     **Disposition** now reads **confirmed**.
- **Action — Ada, the workflow** (`/ui/workflows`, open the new workflow):
  1. The **Plan only** card: *"this change is in forced planning — nothing builds from it yet."* Click **Finish
     planning**.
  2. The **Submit shadow_ai_remediation_plan** card: paste the plan's steps into the box, **Submit for sign-off**.
  3. The card now reads **waiting for sign-off** — *"awaiting … — it is in their inbox"*.
- **Action — Morgan** (Profile C, `/ui/inbox`): the row labelled **Sign-off** (the stage id `signoff`, as the inbox
  words it). **Approve**. Back in Profile A, reload the workflow: the sign-off stage is complete.
- **Say:** "Nothing changed governed state yet; it was a plan. The plan runs through the same workflow engine as every
  other change, so its assignment rules and compliance stages apply. It sits in plan-only until a person says planning
  is done, and the sign-off is structurally someone else's: our security lead signs it, and the person who started it
  cannot approve it, by any route. If there were no second admin, it would not start at all."
- **Approver:** the sign-off goes to every active admin other than the initiator. With Ada initiating, that is Morgan
  alone, provided the deployment has no other admin. Morgan must have enrolled her authenticator first (see
  "Before you present").
- **LIVE and FALLBACK differ:** on LIVE, Ada starts the workflow in front of the audience; on FALLBACK it was started
  and submitted by `demo:prepare`, and only Morgan's **Approve** is live. Do not approve the fallback's workflow at
  rehearsal, or prepare the fallback database again afterwards.
- **Rehearsal:** the seeder drives the start, **Finish planning** and the artifact submission through the real routes,
  and `demo:check` asserts the result waits on Morgan. Ada's clicks in the UI and Morgan's **Approve** have not been
  walked end to end on the demo data: **pending execution** at the first rehearsal.
- **If the start is refused:** `second_approver_unavailable` means no other admin exists (Morgan missing or
  deactivated); *"no workflow assigned"* means an admin's own assignment rule replaced the default; a refused
  environment means the typed one is not configured. Switch to the FALLBACK database.

### S4. Register as use case — Ada — 3 minutes
UI: `IntakeWizardPage.tsx` (the 10-05 beat 1B, unchanged).

- **Action:** back on `/ui/admin/shadow-ai`, on the same row, click **Register as use case**.
- **URL:** `/ui/admin/governance/intake?source=shadow-ai&findingId=…&title=…&description=…` (the link builds it).
- **Screen:** **Register AI use case**, the stepper **Describe → Classify → Suggestions → Questionnaire → Link stack →
  Review**, **Similar use cases** on the right, and the banner *"Prefilled from a shadow-AI finding — its name and
  observed use only. Answer the classification questions yourself; the finding does not establish them."* The name
  is *Govern <subject>* (on FALLBACK, *Govern gitlab:acme-bank-demo/credit-memo-assistant*); every screening answer
  is blank.
- **Action:** as the 10-05 script, beat 1B: **Continue**; enter the EU AI Act answers (the credit-context set
  rehearsed on 10-05 fits the fallback's credit-memo drafting use; on LIVE, the set that fits the chosen finding,
  decided at T-24h); **Draft
  suggestions**; reject one framework, **Accept all remaining**; **Continue** through the questionnaire; on **Link
  stack** choose the governed agent and vendor of the governance seed that fit the finding (decided at rehearsal); on
  **Review** point at the derived data sensitivity; **Submit for human review**.
- **Say:** "The finding filled in only what the evidence established: the name and what was observed. The tier comes
  from the structured answers by deterministic rules, never from a model, and every suggestion is accepted or rejected
  by a person."
- **LIVE / FALLBACK:** the same; only the prefilled name differs.

---

## Act 2 — Govern it

These are the 10-05 beats, on the same seeded governance data. The **Say** lines are unchanged unless noted; the
10-05 script has the full text. Figures quoted there are from 10-02 to 10-05: read the live ones off `demo:check` on
the day.

### G1. The use-case record and risks — Ada — 2 minutes (10-05 beat 2A)
- **URL:** **Open the use-case workspace** after submit → `/ui/admin/governance/use-cases/<id>`.
- **Screen:** status **under review**, the tier, the lifecycle tracker; the tabs include Overview, Frameworks, Risks,
  Stack, Dependencies, Approvals, Audit, Decision path, Decision records, Incidents and Feedback.
- **Action:** **Stack** (the agent card, its model card **Not signed off**, the steward line). **Risks** → **Add risk
  from library**, choose likelihood and impact, **Assess and add**.
- **Change from 10-05:** the use case is now the one discovered in Act 1. Whether its record or **Audit** tab shows
  the link back to the finding is **to confirm at rehearsal**; if it does, point at it in one sentence: "the record
  remembers where it was found".

### G2. Independent review — Avery — 2 minutes (10-05 beat 2B)
- **URL:** `/ui/inbox` (Profile B): *AI use case sign-off · Govern <subject> — requested by Ada Admin* → **Review**.
- **Action:** **Approve with conditions**, one condition with **Before go-live (holds deployment)**, then **Approve
  with conditions**. Back in Profile A: **approved**, **Approval valid until**, **Conditions of approval** with **Mark
  met**.

### G3. Deploy gate — 1.5 minutes (10-05 beat 2C)
- **Expected:** `DENY` with two **BLOCK open_high_alert** lines for *Real-Time Fraud Detection Engine*, then `ALLOW`
  with **WARN acknowledged_high_alert** after the alerts are acknowledged.
- **Change from 10-05: where it runs.** `demo:gate` connects to the database directly (`apps/gateway/src/demo-gate.ts`
  reads `DATABASE_URL`), and the laptop is only a browser (ADR-0197 decision 1). So it runs **live from a terminal on
  the dev instance host**, over SSH or Session Manager (addendum, decision 2), opened before the demo. The exact
  command and environment on that host are **pending execution**: they are written into `DEMO_RUNBOOK.md` §7 only
  once run there.
- **On LIVE:** the governance data this beat reads and the gate output it shows depend on the open `DEMO_RUNBOOK.md`
  §7.1 step, which is **pending execution**.
- **Fallback:** the output captured at T-24h (`real-gate.txt`, as in the 10-05 fallback). Say plainly it was captured
  from a real run.

### G4. Trust dashboard — Ada — 1.5 minutes (10-05 beat 3A)
- **URL:** `/ui/admin/governance/trust`. Point at the weakest axes, open the **security** drill-down.

### G5. Alerts and remediation — Ada, then Avery — 2 minutes (10-05 beat 3B)
- **URL:** `/ui/admin/governance/alerts` → **Evaluate now**.
- **Action:** the unowned-agent alert → **Acknowledge**; under **Remediation**, *"Make Dana Developer the owner of
  …"*, choose **Avery** → **Propose…**; Avery approves in `/ui/inbox` (*Governance remediation · …*); Ada reloads: the
  alert is **resolved**. Then one guidance-only remediation.
- **Say (added for v3):** "Same rule as the shadow-AI plan: the platform runs only the approved action, and the
  approver is someone else."

### G6. Dependency graph — 0.5 minutes (10-05 beat 3C)
- **URL:** `/ui/admin/governance/graph`. One path to a vendor's HIGH risk.

### G7. Regulatory intelligence — 0.5 minutes (10-05 beat 3D)
- **URL:** `/ui/admin/governance/regulatory`. One entry: the Digital Omnibus date move.

### G8. Evidence — Ada — 1 minute (10-05 beat 3E)
- **URL:** `/ui/admin/audit` → **Download signed bundle**.
- **Change from 10-05:** the audit trail now also holds the discovery acts: each source's creation and enabling
  (`discovery-source-created`, `discovery-source-enabled`, written by `apps/gateway/src/discovery-routes.ts`), the
  remediation workflow and its sign-off. Say it in one sentence; do not open the bundle live. Filter the audit page so
  those rows are in the bundle: **to confirm at rehearsal**.

### Close — 0.5 minutes
- **Say:** "We found it, we brought it in with a second person's sign-off, and we governed it, and every step is in one
  signed trail. Discovery, mapping and monitoring are automated; every change was approved by a person."

---

## Optional beats (only if ahead of the clock)

### G9. Accountability records — 1.5 minutes (10-05 beat 3F)
The 10-05 beat, with work in progress on both screens (`demo:intake` seeds it; `demo:check` beat
"3 Incidents and feedback").
- **URL:** `/ui/incidents`. The list opens on **Not closed** and shows the open, medium incident on the Internal IT
  Knowledge Base Bot (owner Dana Developer, two timeline notes, one open corrective action due after the demo day).
  Medium and not serious, so it starts no clock and holds no deploy gate. For the 10-05 story, set **Status** to
  **All** and open the closed Customer Sentiment Analyzer incident.
- **URL:** `/ui/feedback`. Ada's queue opens on **Open** and shows two items on the IT knowledge bot, both
  acknowledged by its owner, Dana, and routed to Ada: a problem report (acknowledged) and an appeal against a refused
  request (in review). The appeal was handed to Ada for an independent answer.
- **Why not the fraud engine:** G3 runs `demo:gate` on the Real-Time Fraud Detection Engine, and the gate counts every
  open alert on its use case. These records sit on another approved use case, and both items are acknowledged, so no
  lapsed feedback SLA or overdue action can add a line to the G3 printout (PR #461 review M1).
- The use case's **Decision records** tab, unchanged.

### G10. Content trust — Ada — 1.5 minutes (ADR-0193)
UI: `apps/web/src/views/admin/governance/ContentTrustPage.tsx`.
- **URL:** `/ui/admin/content-trust` (navigation: **Content trust**).
- **Screen:** header **Content trust**, *"Which sources' content may drive a write. Every source starts untrusted."*
  The **Write floor** card (badge *only trusted content drives writes*), the **Source tiers** table (**Source · Kind ·
  Tier · Last set · Change**), and **Provenance evidence** (**Recorded · Source · Tier · Classification · Digest ·
  Delivered · Transformed · Anchor**).
- **Action:** point at a source reading **untrusted**, then at one provenance record's digests. Do not change a tier
  live (each change is a step-up).
- **Say:** "Detecting an injection is not enough. Here, text from a source below the write floor cannot make an agent
  change anything: the write is refused. Every governed result is recorded by its digests, never its content."
- **Data:** on FALLBACK, the connector *acme-policy-library* is **trusted**, and Dana's two reads of it
  (*lending-policy*, *complaints-handling-policy*) are provenance records (`demo:check` asserts both). On LIVE, the
  provenance records are whatever the governance seed and the day's traffic made; if the evidence card is empty, the
  beat is the tier table alone.

---

## What is mock vs. live

- **Live, real accounts (LIVE path only):** the GitLab demo group, the AWS sandbox account, the Azure subscription and
  the endpoint device, scanned read-only by the product's scanners at T-24h. The AI activity in them is planted by us
  for the demo (small Bedrock usage, one small Azure OpenAI deployment, repositories that use AI SDKs), under
  fictional demo-company names, with no personal data (ADR-0197 decisions 2-5 and 8). Say so: "we planted this
  usage; the scan is real".
- **Seeded (FALLBACK path only):** the discovery dataset `demo:prepare` creates through the real API paths, with the
  GitLab, AWS and Azure runs replayed as recorded scans through the real worker. On screen only the *(demo dataset)*
  suffix on each source name marks them (**Reads** shows *all read*), so the presenter says aloud that they are
  recorded replays. The live
  database holds no seeded discovery data (ADR-0197 addendum, decision 3).
- **Seeded (Act 2):** the governance data of the 10-05 demo (use cases, alerts, traffic).
- **Mock:** the model provider for governed traffic (keyless mock agents); the governed traffic itself is generated
  by `demo:traffic` through the real dispatch path.
- **Live product code on both paths:** every page and API shown, the remediation workflow and its sign-off, the
  intake, the monitor, the deploy gate and the approvals.
- **Recorded:** the screen recording of a real scan is a recording. If it is shown, say so.
- **Never claim** automatic remediation. Never claim the inventory is complete: it reduces shadow AI, it does not
  prove its absence.

## Fallback — if a live call fails

1. **A Shadow AI screen fails on the hosted instance:** switch to the browser on the laptop's local stack and
   continue at the same beat. Say: "this is the same product on a prepared copy". In S3 the fallback's workflow is
   already waiting on Morgan (see S3).
2. **The hosted instance is unreachable:** play the scan recording for S1-S2, then continue on the laptop's local
   stack, which needs no network, or on the screenshot deck.
3. **Everything is unreachable:** the screenshot deck (`apps/web/e2e/fallback-deck.mjs`, as in the 10-05 script).
   The deck today covers the 10-05 beats only; the Shadow AI screens join it when the populated-state screenshot pack
   lands (ADR-0197 work plan, P0). Say plainly these are screenshots from a real run.

A failed live call never leaves an empty screen (ADR-0197 decision 7): move to the next path at once rather than
retrying in front of the audience.

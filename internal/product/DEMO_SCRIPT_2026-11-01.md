# Demo Script — 2026-11-01 (v3): Shadow AI first, then governance

**Decision record:** ADR-0197 (decisions 1-9 and the addendum of 2026-10-18, afternoon). The 2026-10-05 script (`DEMO_SCRIPT_2026-10-05.md`) stays as it was;
this file replaces it for the 2026-11-01 demo.

> **New date (owner, 2026-10-29, #453 comment 6508111468): the customer demo is Saturday 2026-10-31, once.** There is
> no internal run-through on Sun 11-01 and no external demo on Tue 11-03 any more. The file keeps its name; the name is
> history. Two freeze exceptions are approved for this date (built by other PRs): Claude through the Anthropic API as
> the model and the agent, pointed at our MCP endpoint, and the ABAP MCP server behind our MCP proxy, so a live SAP
> change runs through governance.

**Dates:** first planned as a run-through on Sun 2026-11-01 and an external demo on Tue 2026-11-03 (owner, 2026-10-23,
#453); since 2026-10-29 it is one run on **Sat 2026-10-31**. The code freeze stays 2026-10-29. Every preparation step
in `DEMO_RUNBOOK.md` §7.3 is done once, for that run.

**Objective:** one journey in three acts.
1. **Find it.** RegulAIt scans a GitLab group, an AWS sandbox account and an Azure subscription, read-only, imports a
   laptop's software inventory with no agent, and finds AI nobody registered. (The endpoint agent appears only on
   the FALLBACK path: owner, 2026-10-24, full-scan FS-1; see S1.)
2. **Bring it in.** A finding becomes a remediation workflow that a second admin, the security lead, signs off. It is
   then registered as a governed use case.
3. **Govern it.** The governance beats from the 10-05 script follow: intake, the record and its risks, independent
   review, the deploy gate, the trust dashboard, alerts and remediation, the graph, regulatory intelligence, evidence
   and accountability.

**Target:** 25 minutes of demo, then 10 minutes of Q&A. Timings are per beat below; the running clock is in the
right-hand column of the timing table.

**Rules for this script**
- Every URL, button and screen label below was read from the UI code on `main` on 2026-10-18 (file named per beat),
  and checked again on 2026-10-21 against `main` after #457-#460, #465 and #469, then after #474 (folded sections),
  #477 (wide tables) and #478 (vendor names in UI copy), against the screenshot pack of `Demo journey` run
  `39666220670` (`DEMO_SCREENS_QA_2026-11-01.md`), and on 2026-10-23 against the deep scan of #522 and the pack of
  run `39940181481` (after #489 and #511). Labels that depend on data (finding subjects,
  counts, alert text) are marked **to confirm** and are checked at rehearsal.
- **Navigation:** the two Shadow AI pages have their own **Discovery** section in the **AI Governance** sidebar, above
  the registers: **Shadow-AI discovery** and **Discovery sources**. Their breadcrumb reads *Discovery / …* (#469).
- **Detail drawer:** an alert, an Inbox item, a finding's remediation plan and the use-case sign-off review open in a
  panel on the right. Above 900 px wide it sits beside the page, which stays usable; at 900 px and below it is a
  modal over the page. The decision row (**Approve**, **Acknowledge**, **Start remediation workflow…**) is pinned at
  the panel's foot and never scrolls away; the panel's body scrolls on its own. Close it with **Close**.
  Present at 1440 px or wider so the page stays visible beside it.
- **Folded sections (X6b, #474):** a long list's card title is a fold button: a chevron, the title and its count (for
  example the **Recent runs** header: the chevron, the title, then its count). Pressing the title folds or opens the whole section. A folded section keeps its
  count and any warning badge (*1 failed*, *1 critical*) in view. On a first visit **Recent runs** (Discovery sources),
  **Recently decided** (Inbox) and **Usage events** (Optimization) start **folded**; **Inventory** (Shadow-AI
  discovery) and **Alerts** start open. The choice is remembered per person, page and section in that browser only, so
  open what the beat needs in each presenting profile at T-1h (`DEMO_RUNBOOK.md` §7.3). Careful: a click on the title
  of an open Inventory or Alerts card folds it. Cards holding a form or a decision have no fold.
- Every Shadow AI beat has two paths:
  - **LIVE**: real accounts, through the hosted dev instance. The scans have already run before the demo
    (checklist item T-24h). Nothing in the LIVE path waits on a scan in front of the audience. The live database
    holds **only what the real GitLab, AWS and Azure scans and the real device's inventory import find** (ADR-0197
    addendum, decision 3, and its 2026-10-24 addendum): this script promises no subject or count on the LIVE path.
    Read them off the screen at T-24h. **No endpoint agent on LIVE** (owner, 2026-10-24, FS-1): the gateway serves no
    signed collection pack yet (`GET /v1/endpoint-agent/config` answers 503 `collection_pack_unavailable`), so a real
    agent cannot reach the report stage. LIVE shows the agentless path instead: a device inventory export imported
    through an `endpoint_inventory` source (`DEMO_RUNBOOK.md` §7.2).
  - **FALLBACK**: the seeded discovery dataset `demo:prepare` creates (`DEMO_SHADOW_DISCOVERY` in
    `packages/shared/src/demo-intake/shadow-discovery.ts`, loaded by `apps/gateway/src/demo-shadow-seed-lib.ts`),
    on the **local docker compose stack on the presenting laptop**, prepared less than 18 hours before the run
    (addendum, decision 4; owner, 2026-10-23).
    The fallback specifics below are read from that code; whether they look right on screen is still checked at
    rehearsal.
- **Never claim automatic remediation.** Discovery, mapping and monitoring are automated. Every change to governed
  state is approved by a person, and the sign-off is by someone other than the person who asked for it.
- No real host name, account ID, tenant ID or e-mail address appears in this file or on screen notes. Placeholders
  are written `<like-this>`.

---

## Timing

| # | Beat | Persona | Minutes | Clock | Sat 10-31 |
|---|---|---|---|---|---|
| 0 | Opening: what we will show | — | 1.0 | 1.0 | LIVE read-only |
| S1 | Discovery sources | Ada | 2.5 | 3.5 | LIVE read-only (no **Run now**, no federation toggle, no import) |
| S2 | Findings, sightings, coverage | Ada | 2.5 | 6.0 | LIVE read-only |
| S3 | Remediation plan → workflow → second approver | Ada, Morgan | 3.5 | 9.5 | LIVE (changes state) |
| S4 | Register as use case (intake) | Ada | 3.0 | 12.5 | LIVE (changes state) |
| G1 | The use-case record and risks | Ada | 1.5 | 14.0 | LIVE (S4's use case) |
| G2 | Independent review | Avery | 2.0 | 16.0 | LIVE (S4's use case) |
| E | Enforce it: a live governed deny, an approval in the Inbox and Slack, the call after approval, the audit rows | Ada, Avery | 2.0 | 18.0 | live call on LIVE; simulated fallback: the Simulation page |
| G3 | Deploy gate (terminal on the dev instance host) | Ada | 2.0 | 20.0 | LIVE: DENY, acknowledge, then ALLOW (changes state) |
| G4 | Trust dashboard | Ada | 1.0 | 21.0 | LIVE read-only |
| G5 | Alerts and remediation | Ada, Avery | 2.0 | 23.0 | LIVE (changes state) |
| G7 | Regulatory intelligence | Ada | 0.5 | 23.5 | LIVE read-only |
| G8 | Evidence | Ada | 1.0 | 24.5 | LIVE read-only |
| — | Close | — | 0.5 | 25.0 | — |
| opt | Dependency graph (G6, 0.5), accountability records (G9), content trust (G10), review policy (2B+ of the 10-05 script) | Ada | 0.5-3 each | only if ahead | LIVE read-only (change nothing) |

**What changed on 2026-10-24** (owner, #453 comment 6385378784; full-scan FS-8, FS-49): the **E. Enforce it** beat
(2.0 minutes) was added between G2 and G3, and G3 grew from 1.5 to 2.0 minutes. To keep 25.0: G4 gave 0.5 to G3
(owner); G6 moved to the optional beats (0.5); S1 (0.5) lost the endpoint-agent sentence on LIVE and the federation
scroll is now cut first among S1's steps; S2 (0.5): the three rows are chosen at T-24h and walked by scrolling inside
the card, with no **Expand** on stage, and **Recent runs** is opened at T-1h (it is remembered per browser); G1 (0.5),
as the scan judged 2.0 generous. The scan also notes the table has no slack
for three profile switches and one terminal: plan for 28-30 minutes and use the cutting order below.

**Saturday 10-31, one run (owner, 2026-10-29, #453 c6508111468).** LIVE is prepared once and never re-prepared, and
the steps that change state (G3's acknowledgements then ALLOW, G5 resolve, S3 **Start and link**, S4 register, G1/G2
on S4's new use case, and E) can each run only once on it. The two-date plan kept them off LIVE at the 11-01
run-through for that reason. With one date there is no later run to spoil, so every beat runs on LIVE as written, E
included: E is a live governed call (ADR-0202) and runs on its simulated fallback on the Simulation page if lane L's
switch is on. The **FALLBACK** laptop stack stays what it always was: the failure fallback, switched to when a LIVE
beat fails. Never rehearse a state-changing step on LIVE before the demo; rehearse it on FALLBACK only. The same marks
are in `DEMO_RUNBOOK.md` §7.3.

**Cutting order when behind:** G7, then **E. Enforce it** (second, owner 2026-10-24), then G4's drill-down, then S1's
federation card, then G1's **Add risk**. Never cut S3 or G2: separation of duties is the point of both.

---

## Before you present

The full checklist, with what is still pending execution, is in `DEMO_RUNBOOK.md` §7. The short form:

- **T-24h:** every LIVE network source has run successfully, the device inventory export has been imported (a dry
  run, then **Import**), and the findings are on the Shadow-AI discovery page. A screen
  recording of one real scan (S1 → S2) is captured. `demo:traffic` re-run on LIVE and `real-gate.txt` captured after
  it. The fallback stack on the laptop is prepared with `demo:prepare` (less than 18 hours before the start) and passes
  `demo:check`.
- **T-1h:** the three browser profiles below signed in on the hosted dev instance. Navigation pinned (**Pin
  navigation** at the bottom of the rail) in each. The same look in every profile, chosen for the projector: light or
  dark is the ☾ / ☀ button in the top bar (**Switch to dark theme** / **Switch to light theme**), and the palette is
  on **Account** (`/ui/account`) → **Appearance**; both are kept per browser, so set them in every profile. The
  fallback: the laptop's local stack running, the same three personas signed in to it in a separate browser so the
  sessions never mix. A Session Manager shell open on the dev instance host for G3 (the host has no SSH), with the G3
  script ready and `real-gate.txt` open on the laptop (`DEMO_RUNBOOK.md` §7.6). The recording open in a local player.
- **Sessions end after 30 idle minutes** (the strict default, not relaxed for the demo). A window that is minimised or
  fully covered does not keep its session alive. So at **T-10 min**, in every profile and in the fallback browser,
  sign in again or bring the window to the front, and keep the windows tiled, never fully covered. At **T-5 min**,
  reconnect the G3 shell.
- **Morgan's AI policy:** at preparation, sign in as Morgan on both stacks and press **Acknowledge** on the AI-policy
  gate, not **Not now** (which leaves a banner on every page, her Inbox included).
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
  RegulAIt finds AI in our GitLab, our AWS and Azure accounts, read-only, and in a laptop's software inventory, and we
  bring one of those findings under governance with a second person's sign-off. Then we govern it."
  (Owner, 2026-10-24, FS-1: on LIVE the laptop is seen through an imported inventory export, not the endpoint agent.
  The line is the same on FALLBACK.)

---

## Act 1 — Find it

### S1. Discovery sources — Ada — 2.5 minutes
**Sat 10-31:** LIVE read-only.

UI: `apps/web/src/views/admin/governance/DiscoverySourcesPage.tsx`, `FederationCard.tsx`, `EndpointAgentCard.tsx`.

- **URL:** `/ui/admin/shadow-ai/discovery-sources` (sidebar: **Discovery** → **Discovery sources**; breadcrumb
  *Discovery / Discovery sources*).
- **Screen, top to bottom** (`ds-s1-discovery-sources`):
  - Page header **Discovery sources**: *"Where regulAIt may scan, read-only, for shadow-AI use. Every source is off
    until you enable it."*
  - A three-step strip: **Connect read-only** (*n of n sources enabled*), **Scan on a schedule** (*n recent runs*),
    **Findings land in Shadow AI** (**Open the findings**).
  - **Active discovery** card: the posture sentence, which names each enabled source, for example *"Active discovery
    scans n enabled sources, read-only: … Nothing outside those sources is scanned."* (the count and names are the
    live data).
  - Five figures: **Sources enabled** (*n of n*), **Static credentials in use**, **Static credentials older than 90
    days**, **Write scope unverified**, **Credentials refused (write access)**.
  - **Scanner kinds** table (**Kind · State · Evidence kinds**): every kind reads **built**, each with its code under
    the name (`repo_gitlab`, `cloud_aws`, …).
  - **Add a source** form, then the **Sources** table, one row per source: **Source** (name and kind), **State**
    (*enabled*), **Scope**, **Credential** (a **Federated** or **Static key** badge, and **Write scope unverified**
    where the scanner has not proved the credential read-only), **Last run** (*succeeded*), and **Actions**: **Run
    now**, **Edit**, and **More**, which folds **Disable**, **Replace credential**, **Revoke credential** and
    **Delete**.
  - **Import endpoint evidence** and **Endpoint agent enrolment** cards.
    The **Endpoint agent enrolment** card's device table shows the enrolled device as a pseudonym (`psn:…`), its
    platform and agent version, and its user as a pseudonym with a **hardware key** or **software key** badge.
  - **Recent runs**, a full-width card that starts **folded** on a first visit: its header shows the chevron, the title
    **Recent runs** and its count (and *n failed* if any run failed). Press the header to open it. Open, every column fits at 1440 px:
    **Source**, **Status**, **Queued**, **Observed / matched**, **Findings** (*n new, n updated*), **Catalogue gaps**
    and **Reads** (*all read*, or *could not read: …* per read). No Expand is needed (#477).
  - **Reveal a pseudonym**, its own card below Recent runs.
  - **Cloud federation** card: *on*, and *"Federated AWS, GCP and Entra credentials present a 300-second RS256 token
    from this issuer. Federation is on, so federated cloud sources can run. Rotating to a new key or revoking a key asks
    you to confirm it's you; turning federation off does not."* (with federation off, as on FALLBACK, the second part
    reads *"Turning it on lets federated cloud sources run, and asks you to confirm it's you."*; `FederationCard.tsx`),
    then the issuer,
    its key set, the subject format and the audiences. The issuer is
    `<REGULAIT_PUBLIC_URL>/federation`, separate from the workload-identity issuer (`packages/shared/src/discovery/
    federation.ts`).
- **Action:**
  1. Point at the **Sources** table, row by row: the GitLab group, the AWS sandbox account, the Azure subscription and
     the device inventory source (an MDM/EDR-style export, imported; no agent). On FALLBACK there is also the endpoint
     agent source (below).
  2. On the AWS row, point at the **Credential** column: **Federated**, and beside it **Write scope unverified**. Say
     the line under **Say** about it. Then scroll to **Cloud federation** (cut this scroll first if behind).
  3. On the GitLab row, point at the **Credential** column: **Static key**. Say why (below).
  4. Scroll to **Recent runs**. If it is folded, press its header to open it. Point at the latest run of each source:
     *succeeded*, observed / matched, findings.
  5. Do **not** press **Run now** live. A scan takes longer than the beat, and the LIVE path never waits on one.
- **Say:** "Every source starts off. Turning one on, or widening what it scans, asks the admin to confirm it's them,
  and is audited. RegulAIt stores no cloud credential: your role trusts our issuer's five-minute token, bound to one
  source and one audience. 'Write scope unverified' means exactly that: the cloud scanners do not prove a credential
  read-only today, so the page says so instead of claiming it; where the provider lets us check, a credential that can
  write is refused. GitLab is the honest exception on credentials: it reads through a read-only group token, encrypted
  at rest, never shown again, and the posture page lists it as a relaxation. The laptop is seen with no agent at all:
  an inventory export, imported, and only the AI tools in it become findings."
  (Owner, 2026-10-24: "stores no cloud credential", not "keeps no key", FS-50: the product does hold its federation
  issuer's private signing key. "Write scope unverified", FS-27: no cloud scanner reports a write-scope check; only the
  repository scanner does.)
- **FALLBACK only, about the endpoint agent:** "This prepared copy also shows our endpoint agent. Its signed
  collection-pack stage is pending, so this copy's agent reports were seeded." (Owner, 2026-10-24, FS-1. Never say
  the agent scanned a real laptop.)
- **LIVE:** the three network sources configured by the infrastructure lane (ADR-0197 decisions 2-5), scanned at
  T-24h, and the device inventory source, whose import was applied at T-24h (`DEMO_RUNBOOK.md` §7.2). The run history
  shows those scans and the import's run. Point at what is there; promise no count. The **Endpoint agent enrolment**
  card lists no device on LIVE: do not point at it.
- **FALLBACK** (from `demo-shadow-seed-lib.ts`, `demoSourceSpecs`): **five** sources, each named with the suffix
  *(demo dataset)*, all *enabled*:
  - *Acme Bank GitLab (demo dataset)*, GitLab repositories, **static** credential, scope the two repositories;
  - *Acme Bank AWS sandbox (demo dataset)*, AWS, **federated**, scope `us-east-1` and `eu-west-1`;
  - *Acme Bank Azure (demo dataset)*, Azure, **federated**, scope one subscription;
  - *Acme Bank MDM inventory (demo dataset)*, an MDM export imported through the endpoint-inventory import route;
  - *Acme Bank laptops (endpoint agent) (demo dataset)*, the endpoint agent, upload-fed.

  So the first figure reads **5 of 5** and the posture sentence *"Active discovery scans 5 enabled sources, read-only:
  …"*. The AWS and Azure rows also show **Write scope unverified** beside **Federated**, and the same two sources are
  listed above the Sources table with *write scope unverified* (seen in the 2026-10-21 pack). The GitLab, AWS and
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

### S2. Findings, sightings and coverage — Ada — 2.5 minutes
**Sat 10-31:** LIVE read-only.

UI: `ShadowAiPage.tsx`, `DiscoverySightings.tsx`, `discoverySourcesModel.ts` (`sightingLines`).

- **URL:** `/ui/admin/shadow-ai` (sidebar: **Discovery** → **Shadow-AI discovery**; or **Open the findings** in
  the three-step strip, or the **Shadow-AI discovery** link in the Active discovery card).
- **Screen** (`ds-s2-findings`, `ds-s2d-coverage`):
  - Header **Shadow-AI discovery**: *"AI use that nobody registered, found in evidence you already hold. Triage each
    lead and bring it into governance."* On the right, **Discovery sources** and **Import evidence**.
  - Tabs: **Findings · n** (open by default), **Coverage**, **Import evidence**, **Detection catalogue**, **Import
    history**.
  - On **Findings**, the callout **What this can see.**, verbatim from the product: *"Discovery has analyzed n of 4
    evidence classes. Active discovery scans n enabled sources, read-only: … Every finding below derives from
    evidence you supplied or from a source an admin enabled, so this inventory reduces shadow AI — it does not prove
    its absence. …"*, ending with the link **See coverage**.
  - Figures: **Critical** (*Leaked credential*), **High** (*Observed model traffic*), **Medium or low** (*Looser
    signals to check*), **Evidence classes supplied** (*n / 4*).
  - **Inventory** card, *"Every row is a lead for triage, not a verdict."*, with the status chips **All · Open ·
    Confirmed · Closed** (each with its count) and **Expand**. Its title is a fold header (the **Inventory** title and
    its count), open by default. Columns: **Severity · Subject (the provider under it) · Evidence · Confidence · Seen
    · Status · Next step**. **Evidence** holds the evidence badges and, under them, the sightings folded behind a count
    (*▶ n places*). **Next step** holds **Plan remediation**, **Triage** and **Register as use case**.
  - The card shows three to four rows and scrolls inside itself, with the line *"Showing 3 of n · scroll the list for
    the rest, or Expand"*. At 1440 px every column fits (#477). With the remediation panel open, the table folds
    **Confidence** under **Severity** and **Evidence** and **Seen** under **Subject**, so nothing scrolls sideways.
  - **Coverage** tab: one card per import class (**Egress logs**, **Code scan**, **SaaS export**, **Self-reported**),
    each **Supplied** or **Missing**, with *n imports · n rows*, **Sees:** and **Misses:**, and **Import this
    evidence** on a missing one. Caption: *"Gaps are shown, never papered over."*
- **Action:**
  1. Read the coverage sentence aloud, last clause included.
  2. Scroll the Inventory's list inside the card to the three rows chosen at T-24h (no **Expand** on stage). Walk
     them, one per family, using the **Evidence** column: open the sightings under its badge (*▶ n places*) to show the
     sighting lines.
     - **a repository finding** (Evidence *Repo scan*): its sighting line reads `path:line @commit` and, where the
       repository's templates name AI keys, *presence signatures: …*, then *by psn:…* (the commit author's
       pseudonym);
     - **a cloud finding** (Evidence *Cloud inventory* or *Cloud audit log*): the AI service the account runs, and the
       calling principal as a pseudonym;
     - **the device finding** (Evidence *Endpoint inventory*, the imported export; on FALLBACK also *Endpoint agent*):
       the AI tool on the laptop, the device user as a pseudonym. On LIVE it is always the inventory row (FS-1).
  3. Click one `psn:…` link in an open sighting list. It opens **Discovery sources** with the pseudonym prefilled in
     **Reveal a pseudonym** (its own card, below **Recent runs**). Do **not** press **Reveal** (it asks for
     a step-up and is audited). Go back.
  4. Click **See coverage** (or the **Coverage** tab): the import classes that read **Missing**, with what each would
     see and what it misses.
- **Say:** "Detection is a signal, not proof. Each row says what each scanner saw and where: a path and a line in a
  repository, a service in an account, a tool on a laptop. People are pseudonyms by default; revealing a name is a
  step-up and lands in the audit log. And the page tells you what it could not see. An inventory that hides its gaps
  is worse than none."
- **Note for the presenter:** the coverage cards are the four *import* classes (egress logs, code scan, SaaS export,
  self-reported). The scanned sources are named in the coverage sentence, not as scorecard rows, so **Evidence classes
  supplied** can read low (*1 / 4* on FALLBACK) while five sources are scanned. If asked, say exactly that.
- **LIVE:** real findings only, from the T-24h scans of what the infrastructure lane planted (repositories that use
  AI SDKs, managed-model usage with its audit trail in AWS, one hosted model deployment in Azure) and the device
  inventory export imported at T-24h. No subject, provider or
  count is promised here: choose the three rows to walk at the T-24h check, from what is on screen.
- **FALLBACK** (from `DEMO_SHADOW_DISCOVERY`; `demo:check` asserts each family):
  - **repositories** (*Repo scan*): `gitlab:acme-bank-demo/credit-memo-assistant` (one AI vendor's SDK, with a
    presence signature for that vendor's API key from its `.env.example`) and `gitlab:acme-bank-demo/support-ticket-
    triage` (a second vendor's SDK). The commit author is a team label, shown as a pseudonym;
  - **AWS** (*Cloud inventory*): a managed custom model `acme-complaints-summariser` (`eu-west-1`) and a model-serving
    endpoint `fraud-score-llm` (`us-east-1`); (*Cloud audit log*): one calling principal, a pseudonym, 412 model
    invocation calls;
  - **Azure** (*Cloud inventory*): one hosted AI account and its deployment `branch-faq-bot` (`westeurope`);
  - **MDM export** (*Endpoint inventory*): three laptops' AI desktop apps (three seeded tool records), devices and
    users as pseudonyms;
  - **endpoint agent** (*Endpoint agent*): one AI desktop app on one enrolled laptop. The agent's CLI fact and its
    environment-variable fact are dropped by the gateway and only counted: nothing names them on screen.
  - The four imported *Saas export* rows of the 10-05 demo (the seeded prototype record and three seeded AI tool
    records) are still seeded by `demo:intake` and appear in the same table. The records keep their seeded names on
    screen (owner decision 2026-10-21, F30).
- **Evidence labels:** the 2026-10-21 pack shows **Repo scan** and **SaaS export** in the **Evidence** column. The
  other families' labels (*Cloud inventory*, *Cloud audit log*, *Endpoint inventory*, *Endpoint agent*) are the
  Scanner kinds table's wording and are **to confirm** in the Inventory at rehearsal (the pack's Inventory shot shows
  its first rows only).

### S3. Remediation plan → workflow → second approver — Ada, then Morgan — 3.5 minutes
**Sat 10-31:** LIVE (changes state; FALLBACK on failure).

UI: `ShadowRemediationPanel.tsx`, `apps/web/src/views/workflows/WorkflowDetailPage.tsx`,
`apps/web/src/views/inbox/InboxPage.tsx`; gateway `apps/gateway/src/shadow-ai-remediation.ts`.

- **Choose the row first** (rehearsal): the finding the rest of the story governs. Pick one with no governed
  replacement and a clear business purpose.
  - **LIVE:** a repository finding from the real scan, chosen at T-24h. It must have no remediation workflow yet.
  - **FALLBACK:** `gitlab:acme-bank-demo/credit-memo-assistant`. `demo:prepare` has **already** started its
    remediation workflow as Ada (environment `staging`), finished planning and submitted the plan, so it waits on
    Morgan's sign-off when the demo starts (`ensureRemediation`; `demo:check` asserts Morgan is the one approver and
    not the initiator). On the fallback, skip Ada's steps below: press the row's **Plan remediation** (the panel
    shows the link; scroll the panel's body to it), say "this one was started and submitted during preparation",
    and open the workflow at **waiting for sign-off**: the panel shows the workflow id as plain text, not a link, so
    go to **Workflows** (`/ui/workflows`) and open the row whose title starts *"Pull
    gitlab:acme-bank-demo/credit-memo-assistant"*. Then go straight to Morgan.
  - **Rehearsal of Ada's live half (FS-7, owner 2026-10-24):** this was an 11-01-only step; with one date it moves to
    the FALLBACK rehearsal before 10-31, on the second repository finding,
    `gitlab:acme-bank-demo/support-ticket-triage`, which has no workflow yet: **Plan remediation** → environment
    `staging` (the fallback's deploy target `acme-staging`) → **Start and link** → **Finish planning** → paste the plan
    text from `DEMO_PRESENTER_NOTES_2026-11-01.md` ("FALLBACK rehearsal, second finding") → **Submit for sign-off** →
    Morgan's second **Review** and **Approve**. It is not part of the 10-31 script. If the fallback is prepared again
    from empty afterwards, the finding is free again.
  - **Demo:** LIVE allows one remediation workflow per finding, and LIVE is never re-prepared. So the LIVE finding
    chosen at T-24h stays unused until the demo on 10-31.
- **Action — Ada, the plan** (`/ui/admin/shadow-ai`):
  1. On the chosen row, in **Next step**, click **Plan remediation**. The **Remediation plan** panel opens on the
     right (`ds-s3a`, `ds-s3b`): the subject as its title, the provider and confidence badges, and **no governed
     replacement registered** (or the governed replacement).
  2. Read the numbered steps, in plain language. Each has a reason; a step that cannot run yet shows **Blocked** with
     why. With no governed replacement, the routing step reads *"no governed replacement agent is registered for this
     provider yet, so this step waits until an admin registers one."* The last step is *"Confirm the next call appears
     in the audit log and the usage ledger"*, and the note under the steps reads *"This plan does not start a workflow
     by itself. It prepares the request for the standard workflow start, …"*. Then **Who
     acts next** with the **Separate approver** badge: *"By default, a plan-only stage runs first and changes nothing.
     Then a human sign-off."*
  3. Point at *"The default remediation workflow (a plan-only stage, then a human sign-off) is set up when the first
     one starts."* if it shows (only until the first one starts).
  4. Scroll the panel's body to the form. Fill **Change description** (prefilled from the plan) and **Environment**:
     type `staging`; the field's placeholder reads *"for example staging"* (`ShadowRemediationPanel.tsx`).
     The environment must be one an admin already gave a meaning to on a deploy target or assignment rule
     (`shadow-ai-remediation.ts`). A `demo:prepare`d database has `staging`; on LIVE, `demo:prepare --live` creates an
     audited mock deploy target `demo-staging` (environment `staging`) and `demo:check --live` asserts it in the beat
     "1 Remediation environment" (checked at T-24h).
     Never type `production`: nothing in this demo is production.
  5. **Start remediation workflow…**, pinned at the panel's foot → the dialog **Start a remediation workflow?** →
     **Start and link**.
  6. The status line, in the panel's body: *"Workflow xxxxxxxx started and linked; the finding is now confirmed"*, then
     *"Linked to workflow …. The loop closes when the next call from … appears in the audit log and usage ledger."*
     The panel scrolls the line into view by itself (F22). The success toast briefly covers the right half of the
     line, so if you read it aloud, wait for the toast to clear. The **Confirmed** chip's count goes up by one and the row's
     **Status** reads **Confirmed**. **Close** the panel.
- **Action — Ada, the workflow** (`/ui/workflows`, open the new workflow):
  1. The workflow's title is the full change description (finding F8). The **Plan only** card, badge **planning**:
     *"this change is in forced planning — nothing builds from it yet."* Click **Finish planning**.
  2. The **Submit shadow AI remediation plan** card: paste the plan text prepared at T-24h from
     `DEMO_PRESENTER_NOTES_2026-11-01.md` (it names the chosen repository; the panel has no copy button, FS-47), then
     **Submit for sign-off**.
  3. The card now reads **waiting for sign-off** — *"awaiting … — it is in their inbox"*.
- **Action — Morgan** (Profile C, `/ui/inbox`): the row with the **Sign-off** chip and the workflow's title (the
  long *"Pull … into governance — shadow-AI finding …"* text, finding F8). Click its **Review**: the item opens in
  the panel on the right, with *"Workflow · requested by Ada Admin"* and the submitted plan folded under
  *Submitted: Shadow AI remediation plan (v1)* (open it to show the plan). The pinned foot has **Reason (optional)**,
  **Deny** and **Approve**. Press **Approve** (her authenticator code if asked). The item leaves the list and the
  count drops by one (*n waiting on you*). **Recently decided**, at the foot of the Inbox, starts folded
  (the **Recently decided** header, title and count); the beat does not need it, so leave it folded. Back in Profile A, reload the workflow: status **completed**, all four
  pipeline stages done.
- **Say:** "Nothing changed governed state yet; it was a plan. The plan runs through the same workflow engine as every
  other change, so its assignment rules and compliance stages apply. It sits in plan-only until a person says planning
  is done, and the sign-off is structurally someone else's: our security lead signs it, and the person who started it
  cannot approve it, by any route, and the sign-off itself is the same approvals queue as every other change. If
  there were no second admin, it would not start at all. And the finding does not close itself: when the next call
  shows up in the audit log and the usage ledger, a person records the disposition on that evidence."
  (Scan talk-track changes 2 and 3, accepted by the owner 2026-10-24; `workflow-approvers.ts`: "The approval itself
  is the existing queue"; FS-51: no route marks a shadow-AI finding remediated by itself.)
- **Approver:** the sign-off goes to every active admin other than the initiator. With Ada initiating, that is Morgan
  alone, provided the deployment has no other admin. Morgan must have enrolled her authenticator first (see
  "Before you present").
- **LIVE and FALLBACK differ:** on LIVE, Ada starts the workflow in front of the audience; on FALLBACK it was started
  and submitted by `demo:prepare`, and only Morgan's **Approve** is live. Do not approve the fallback's workflow at
  rehearsal, or prepare the fallback database again afterwards.
- **Rehearsal:** the seeder drives the start, **Finish planning** and the artifact submission through the real routes,
  and `demo:check` asserts the result waits on Morgan. Ada's clicks in the UI and Morgan's **Approve** have not been
  walked end to end on the demo data: **pending execution** at the first rehearsal. Ada's clicks are walked on
  the FALLBACK's second finding before 10-31 (FS-7, above).
- **If the start is refused:** `second_approver_unavailable` means no other admin exists (Morgan missing or
  deactivated); *"no workflow assigned"* means an admin's own assignment rule replaced the default; a refused
  environment means the typed one is not configured. Switch to the FALLBACK database.

### S4. Register as use case — Ada — 3 minutes
**Sat 10-31:** LIVE (changes state; FALLBACK on failure).

UI: `IntakeWizardPage.tsx` (the 10-05 beat 1B, unchanged).

- **Action:** back on `/ui/admin/shadow-ai`, on the same row, click **Register as use case**.
- **URL:** `/ui/admin/governance/intake?source=shadow-ai&findingId=…&title=…&description=…` (the link builds it).
- **Screen** (`ds-s4`): breadcrumb *AI Governance / Register AI use case*, **Register AI use case**, the stepper **Describe → Classify → Suggestions → Questionnaire → Link stack →
  Review**, **Similar use cases** on the right, and the banner *"Prefilled from a shadow-AI finding — its name and
  observed use only. Answer the classification questions yourself; the finding does not establish them."* The name
  is *Govern <subject>* (on FALLBACK, *Govern gitlab:acme-bank-demo/credit-memo-assistant*); every screening answer
  is blank.
- **Action:** as the 10-05 script, beat 1B: **Continue**; enter the EU AI Act answers (the credit-context set
  rehearsed on 10-05 fits the fallback's credit-memo drafting use; on LIVE, the set that fits the chosen finding,
  decided at T-24h); **Draft
  suggestions**; reject one framework, **Accept all remaining**; **Continue** through the questionnaire; on **Link
  stack** choose the governed agent and vendor pairing confirmed by the owner (#453; the seed records are named in
  DEMO_RUNBOOK §7.3, "S4 Link stack pairing"): on FALLBACK, and on a LIVE finding with matching SDK evidence, the
  seeded agent whose model card has **no** sign-off, with its vendor marked *approved*; for a LIVE finding from
  another provider, that provider's matching unsigned pair. G1's **Stack** tab then shows **Not signed off** as
  scripted; on
  **Review** point at the derived data sensitivity; **Submit for human review**.
- **Do not link the voice / call-centre agent** (deep scan #40): its seeded model card says its bias evaluation's
  results were "expected by 2026-10-15", which is past on both run days, and G1's **Stack** tab would show it.
- **Say:** "The finding filled in only what the evidence established: the name and what was observed. The tier comes
  from the structured answers by deterministic rules, never from a model, and every suggestion is accepted or rejected
  by a person."
- **One finding, one use case, ever.** The record keeps the finding it came from, and a second registration from the
  same finding is refused (409, *"this shadow-AI finding is already registered as the AI use case '…'; a finding is
  registered once"*). The finding's row then shows *"Registered as <use case>"* (a link) instead of **Register as use
  case**. So S4 uses up its finding: on LIVE, the 10-31 finding must not have been registered before.
- **LIVE / FALLBACK:** the same; only the prefilled name differs. On 10-31, S4 runs on **LIVE**; never register it there before.

---

## Act 2 — Govern it

These are the 10-05 beats, on the same seeded governance data. The **Say** lines are unchanged unless noted; the
10-05 script has the full text. Figures quoted there are from 10-02 to 10-05: read the live ones off `demo:check` on
the day.

### G1. The use-case record and risks — Ada — 1.5 minutes (10-05 beat 2A)
**Sat 10-31:** LIVE (S4's use case).

- **URL:** **Open the use-case workspace** after submit → `/ui/admin/governance/use-cases/<id>`.
- **Screen** (`ds-g1b`): the dark header band with *AI use cases / <name>*, the **AI USE CASE** label, and the chips
  **Status**, **EU AI Act** tier, **Approval valid until** (once approved) and **Owner**; **Open intake** on the
  right. Status **under review** right after submit. The **Overview** tab holds the **Lifecycle tracker** (*Proposed
  → Under review → Approved → Monitoring*, then the activity table) and, once approved, **Conditions of approval**
  with **Mark met** and **Waive**.
- **Tabs**, in four captioned groups: **Overview**; *Assessment*: **Frameworks**, **Risks**, **Stack**,
  **Dependencies**; *Evidence*: **Decision records**, **AI BOM**, **Audit**; *Activity*: **Approvals**, **Decision
  path**, **Incidents**, **Feedback**. Counts sit under some tab names (**Risks**, **Audit**, **Approvals**).
- **Action:** **Stack** (the agent card, its model card **Not signed off**, the steward line). **Risks** → **Add risk
  from library**, choose likelihood and impact, **Assess and add**.
- **Audit tab** (`ds-g1c`, #465): **Recent use-case audit evidence** (**When · Event · Effect · Reason**). The count
  under **Audit** is the use case's true total; when there are more rows than shown, the card says *"Showing the
  newest n of N rows."* An admin sees **Open this use case's full audit trail**, which opens **Audit log** filtered to
  this use case (`ds-g1d`): *"Showing the audit trail of one AI use case, <id>. The CSV export covers the same rows."*
  and **Show every row**. A non-admin (Avery) sees a note that the full trail is open to administrators instead of
  the link.
- **Change from 10-05:** the use case is now the one discovered in Act 1.
- **Found by discovery:** the header carries a **Found by discovery** chip; for an admin, *discovery* links to the
  Shadow-AI **Findings** tab (`UseCaseOverviewPage.tsx`). Point at it.
- **Say (added):** "the record remembers where it was found."

### G2. Independent review — Avery — 2 minutes (10-05 beat 2B)
**Sat 10-31:** LIVE (S4's use case).

- **URL:** `/ui/inbox` (Profile B): *AI use case sign-off · Govern <subject> — requested by Ada Admin* → **Review**.
- **Action:** the row's **Review** opens **Review use case sign-off** (caption *Open task*) as a panel on the right
  (`ds-g2b`); the evidence scrolls in its body. Under **Decision**, choose the **Approve with conditions** card. Scroll
  the body to **Conditions** and fill the one condition row (`ReviewPanel.tsx`); the form refuses an empty
  **Condition** (*"Describe the condition."*) or **Due date** (*"Choose a due date."*):
  1. **Condition**: one plain sentence, for example *"Complete a human-review sampling plan before go-live."* Name no
     model identifier.
  2. **Owner**: **Ada Admin**.
  3. **Due date**: about two weeks after the run day.
  4. **Applies**: **Before go-live (holds deployment)**.

  Press **Approve with conditions** in the pinned foot (beside **Cancel**). Back in Profile A, on the record: the **Approval valid until**
  chip in the header, and **Conditions of approval** with **Mark met** on the **Overview** tab.

### E. Enforce it — Ada, Avery — 2 minutes (added 2026-10-24; live since ADR-0202)
**Sat 10-31:** a live governed call on LIVE (it changes state, so it runs once, at the demo; rehearse it on the
FALLBACK laptop stack only). Live is the default (ADR-0202
decision 1, which supersedes #453 comment 6387779914 for this beat); the beat's *simulated fallback* is the
simulated decision below, chosen by lane L's per-beat switch for `enforce-it`.

The beat shows one governed call denied with its rule named, one queued for a named approver and mirrored to chat,
the approval, the call executing only after it, and the audit rows. It is second in the cutting order.

Code: `apps/gateway/src/demo-enforce-lib.ts` (`demo:enforce`: on the dev host `~/enforce.sh`, on the laptop
`pnpm --filter @regulait/gateway demo:enforce`), the gateway's
own MCP route `POST /mcp/:serverId` and ChatOps route `POST /v1/chatops/approvals/:id/post`; UI: Avery's **Inbox**,
`AuditLogPage.tsx`, and on the fallback `SimulationPage.tsx`. Seed: `apps/gateway/src/seed.ts` (Dana's role grant on
`repo-tools`, her revocation of `search_code`, the approval rule that sends her `write_file` calls to Avery).

**What runs.** The command issues Dana a one-day key (revoked at the end of the run) and makes her calls over the MCP
protocol through the running gateway, with the demo project header. The gateway decides every call: nothing in the
command evaluates, approves or executes anything itself. `repo-tools` is the demo MCP server (`demo:mcp`), so the
executed write is the demo server's answer (`committed … as commit demo01a`), not a commit to a real repository.
The existing wiring does not link a bare tool-call approval to a workflow PR or a PM work item (pm-sync mirrors
workflow-stage and run decisions only), so this beat shows no PR and no Jira or Azure DevOps update; never say it does.

**Live flow, with timings** (profiles: Ada in A, Avery in B; on 10-31 the host shell reconnected at T-5 min, as for
G3; at the FALLBACK rehearsal a laptop terminal):

| Time | Where | What happens | What is on screen |
|---|---|---|---|
| 0:00-0:15 | host shell | `~/enforce.sh` | `LIVE  Dana Developer calls repo-tools …`, then `tools/list` without `search_code` |
| 0:15-0:30 | host shell | Dana's `search_code` | `DENIED  Denied by policy: …` and the `audit:` line: rule `default-deny`, her role's `role-server-read-only-all` grant **REVOKED** for her |
| 0:30-0:45 | host shell, then Slack | Dana's `write_file` | `QUEUED … pending sign-off by approver 'Avery …'`, `notify posted to slack …` (and one line per other enabled channel, email included once lane E's channel is configured). Show the card in Slack |
| 0:45-1:15 | Profile B, **Inbox** | Avery opens the request and presses **Approve**, pasting the note from the presenter notes | the request leaves the queue |
| 1:15-1:30 | host shell | the command sees the decision and retries the same call | `write_file  APPROVED and EXECUTED  committed docs/enforce-it.md …` |
| 1:30-2:00 | Profile A, `/ui/admin/audit` | the newest rows | the deny with its rule chain, the queued approval, the chat post, Avery's decision, the executed call |

- **Say:** "Dana's own key, the real MCP protocol, the real gateway. Her search is refused, and the ledger names why:
  no grant matches, because her role's read grant is revoked for her alone. Her write is not refused; it waits for a
  named person, Avery, and the request is in his Inbox and in Slack. Dana cannot approve it herself. Avery approves,
  the same call is retried, and only now does it run, bound to the exact arguments he approved. Every step is in the
  ledger."
- **Never say** that the write reached a real repository, opened a PR or updated a Jira or Azure DevOps item.
- **If a third-party call is slow.** Only the chat post leaves the box; the MCP calls go to the demo server on the
  host. If the Slack line is slow or prints `NOT posted`: "The request is in Avery's Inbox either way; chat is a mirror,
  never the only copy," and approve in the Inbox. The command waits up to five minutes
  (`REGULAIT_DEMO_ENFORCE_WAIT_SECONDS`). If it gives up first it prints `no decision yet: nothing executed`; approve,
  then run `~/enforce.sh` again: it lands on the same request (same arguments) and executes it.
- **When and how to flip to the simulated fallback.**
  - At T-24h on the stack the beat runs on: if `~/enforce.sh` does not end with `APPROVED and EXECUTED` (exit 0), or
    the deny or the queue line reads differently from the table, turn the `enforce-it` beat to simulated with lane L's
    switch (audited; its location is in lane L's PR, to confirm at rehearsal), re-run `~/enforce.sh` and confirm it
    prints `SIMULATED DECISION`. ADR-0202 decision 6: a beat not green by the 10-29 freeze runs on its fallback.
  - On stage: if the shell shows no `DENIED` line within 15 seconds, or the gateway answers `502
    mcp_upstream_unreachable` or `503 mcp_upstream_circuit_open`, press Ctrl-C and go straight to the simulated beat
    below on `/ui/admin/simulation`. Do not flip the switch on stage; flip it after the beat so a re-run prints the
    simulated decision.

**Simulated fallback: the simulated decision (exactly the 2026-10-24 beat).** With the switch on, `~/enforce.sh` asks `POST
/v1/evaluate` for both tools, prints each under `simulated decision`, and executes, queues and posts nothing. On
stage, use the **Simulation / access preview** page: it runs the live policy kernel for one call (user, server,
tool) and renders the decision, the rule it matched and every rule it walked, executing nothing and queuing nothing.
It records each question as an audit row marked advisory (not counted against rate limits).

- **URL:** `/ui/admin/simulation` (sidebar: **Simulation**). Header **Simulation / access preview**: *"Would this call
  be allowed right now? Evaluated live, executing nothing."*
- **Action:**
  1. **User**: Dana Developer · **Server**: `repo-tools` · **Tool**: `search_code` → **Evaluate**. The **Decision**
     card's banner reads **deny**, *matched* and the rule id, then the reason; below it **Precedence chain — every rule
     evaluated, in order**: her role's read grant, then her per-user revocation, which wins. Point at the matched rule.
  2. Change **Tool** to `write_file` → **Evaluate**. The banner reads **require approval**, and the line *"Requires
     sign-off from …"* names the approver: Avery (the seeded approval rule). The approver's name on screen is **to
     confirm at rehearsal**.
  3. Optional, if ahead: `read_file` → **allow**.
  4. `/ui/admin/audit` (**Audit log**): the newest rows are the two decisions just asked for, each with its effect, rule
     id and reason. Say they are the preview's own advisory rows.
- **Say:** "This is a simulated decision: the gateway's real policy engine evaluating a call Dana proposes. No grant,
  no call: the decision is deny, and it names the rule, her own revocation beating her role. For the write the
  decision is not deny but require approval from a named person, Avery, and an approval is bound to the exact
  arguments approved. This page asks the question without running anything, and even the question lands in the
  ledger."
- **Never say**, on the simulated fallback, that the call "was blocked" or "was queued", or that a call was made: on screen and
  aloud it is a *simulated decision*, the real policy engine evaluating a proposed call.
- **Data:** on both stacks the governance `seed` gives Dana the role grant, the `search_code` revocation and the `write_file` approval
  rule naming Avery; `demo:check` does not assert them. The live path also needs `demo:mcp` running and an enabled
  Slack ChatOps connection on the stack (pending execution at the first rehearsal).

### G3. Deploy gate — 2 minutes (10-05 beat 2C; 1.5 until 2026-10-24, FS-49)
**Sat 10-31:** all three steps on LIVE (acknowledge and ALLOW change state; FALLBACK on failure).

- **Expected:** `DENY` with two **BLOCK open_high_alert** lines for *Real-Time Fraud Detection Engine*, then `ALLOW`
  with two **WARN acknowledged_high_alert** lines after the alerts are acknowledged. The environment is `staging`,
  never `production` (owner, #522 #11): the gate only records it, and nothing in this demo is production.
- **Where it runs.** `demo:gate` reads the database directly, and the laptop is only a browser (ADR-0197 decision 1),
  so it runs **live on the dev instance host**, in a Session Manager shell (the host has no SSH), inside the gateway
  container: `docker compose exec -T gateway node apps/gateway/dist/demo-gate.js "Real-Time Fraud Detection Engine"
  staging <ref>`, kept in the one-line script `~/g3.sh` (`DEMO_RUNBOOK.md` §7.6). The shell was reconnected at
  T-5 min. **Pending execution** on that host.
- **Action:**
  1. In the shell: `~/g3.sh demo-1`. The printout reads `$ regulait gate deploy --use-case "Real-Time Fraud Detection
     Engine" --env staging --ref demo-1`, then `DENY  "Real-Time Fraud Detection Engine" (approved, EU AI Act tier
     high) → staging` and two **BLOCK open_high_alert** lines, one per open high alert.
  2. Profile A (Ada), `/ui/admin/governance/alerts`, **Active** tab. Acknowledge the two alerts the BLOCK lines name
     (`packages/shared/src/governance-monitor.ts`):
     - *"Real-Time Fraud Detection Engine inherits a HIGH rating from Acme Internal AI Platform"*;
     - *"n call(s) for Real-Time Fraud Detection Engine (to …) was / were served by …, which is outside its approved
       stack"*.

     For each: click its row (not the card title, which folds the list); in the panel on the right paste the
     **Acknowledgement note — required and audited** in the pinned foot from `DEMO_PRESENTER_NOTES_2026-11-01.md`
     (one note per alert, written in advance because they are audited, FS-49), then **Acknowledge**. This is not G5's alert:
     G5 later acknowledges the unowned-agent alert.
  3. Back in the shell: `~/g3.sh demo-2`. Expect `ALLOW` with two **WARN acknowledged_high_alert** lines.
- **Say:** "The pipeline asks the gate, and the gate answers from live governance state: two open high alerts block
  it. Acknowledging them is a person's audited decision, and the gate still lists them as warnings."
- **On LIVE:** run `demo:traffic` again at T-24h before the run (owner, #522 #8): the monitor counts the off-stack
  call over 7 days, so traffic made at preparation would no longer hold the second BLOCK line. Capture
  `real-gate.txt` after that re-run (`DEMO_RUNBOOK.md` §7.3).
- **Rehearsal and demo:** an acknowledged alert stays acknowledged, so an acknowledgement on LIVE before 10-31 would
  turn the demo's first run into ALLOW. Rehearse steps 2-3 on the **FALLBACK** stack only: acknowledge in the fallback
  browser, and run the gate there with
  `docker compose exec -T gateway node apps/gateway/dist/demo-gate.js "Real-Time Fraud Detection Engine" staging demo-2`
  from the repo root on the laptop. Never acknowledge these alerts on LIVE before the demo on 10-31.
- **Fallback:** if the shell is gone or slow, show `real-gate.txt` (the T-24h capture, open on the laptop). Say plainly
  it was captured from a real run. The ALLOW half is rehearsed on the fallback database at T-7d (`DEMO_RUNBOOK.md`
  §7.5, owner step 1).

### G4. Trust dashboard — Ada — 1 minute (10-05 beat 3A; 0.5 moved to G3 on 2026-10-24)
**Sat 10-31:** LIVE read-only.

- **URL:** `/ui/admin/governance/trust` (breadcrumb *Overview / Trust & evidence*). The page has no tabs: point at
  the weakest bars in **Evidence coverage by dimension** (on FALLBACK, **Safety 0%** and **Reliability 60%**), then
  click the **Security** tile in **Dimension drilldown** (it opens on **Bias**): its badge (*measured* or
  *unmeasured*) and the **Open · Mitigating · Accepted · Closed** counts.

### G5. Alerts and remediation — Ada, then Avery — 2 minutes (10-05 beat 3B)
**Sat 10-31:** LIVE (changes state; FALLBACK on failure).

- **URL:** `/ui/admin/governance/alerts` → **Evaluate now**. The tabs **Active · Acknowledged · Resolved** sit
  above the **Alerts** card, whose title is a fold header (the **Alerts** title and its count, open by default). Click the alert
  rows, not the card title: a click on the title folds the list.
- **Action:** click the unowned-agent alert's row: it opens in the panel on the right (`ds-g5b`; at 900 px and
  below, a modal over the page, `ds-g5c`). Type the **Acknowledgement note — required and audited** in the pinned
  foot, then **Acknowledge** (it stays disabled until the note is typed). In the panel's body, under **Remediation**,
  *"Make Dana Developer the owner of …"*: choose **Avery** in **Independent approver** → **Propose…**. Avery opens
  the item in `/ui/inbox` (*Governance remediation · …*) with **Review**; the panel should read *"No evidence attached
  to this request."* (the evidence is the alert itself; **to confirm at rehearsal**, not in the pack) and Avery
  presses **Approve** in its pinned foot. Ada reloads:
  the alert is on the **Resolved** tab. Then one guidance-only remediation (its badge reads **Manual steps**).
- **On the FALLBACK pack:** the CI pack runs after the 10-05 journeys, which already resolved the unowned-agent alert
  (*Make Dana Developer the owner of …*, **Applied** in Remediation proposals). A database straight from `demo:prepare` still has it on
  **Active**: check at rehearsal.
- **SLA chips** (deep scan #13): an alert's SLA chip moves with the clock, and acknowledging it does not stop it. High
  alerts read *SLA due soon* from 18 h and *SLA breached* from 24 h; medium alerts at 54 h and 72 h. On LIVE, prepared
  more than a week earlier, every open high and medium alert reads **SLA breached**, the unowned-agent alert included,
  and the panel adds that it was escalated to the admins. If anyone looks at it, say: "the product escalates overdue
  alerts". The fallback is prepared less than 18 h before the run, so its chips read *on track*, as in the pack.
- **Say (added for v3):** "Same rule as the shadow-AI plan: the platform runs only the approved action, and the
  approver is someone else. Approving the fix re-ran the monitor, so the alert resolved from evidence, not by hand."
- **Say (added 2026-10-24, scan G5 sentence):** on the **Acknowledged** tab, point at G3's off-stack alert: "That
  alert exists because cost routing served approved traffic from an agent the approval never covered. Cost and
  governance read the same ledger." (`agents-connectors.ts`, measured cost per call; ADR-0164.)

### G6. Dependency graph — optional, 0.5 minutes (10-05 beat 3C; moved out of the 25 minutes on 2026-10-24)
**Sat 10-31:** LIVE read-only.

- **URL:** `/ui/admin/governance/graph`. One path to a vendor's HIGH risk.

### G7. Regulatory intelligence — 0.5 minutes (10-05 beat 3D)
**Sat 10-31:** LIVE read-only.

- **URL:** `/ui/admin/governance/regulatory`. One entry: the Digital Omnibus date move. Say it in words, as the
  entry's own text gives it: the Annex III high-risk obligations now apply from 2 December 2027.

### G8. Evidence — Ada — 1 minute (10-05 beat 3E)
**Sat 10-31:** LIVE read-only.

- **URL:** `/ui/admin/audit` → **Download signed bundle** (top right, beside **Download CSV**). The page (`ds-g8`):
  **Chain integrity** (*Not verified yet*, **Verify chain**), then **Entries**, newest first (every column, the
  **Evidence** link included, fits the card since #477; the object type is a faint line above each event), then three folded
  panels, each closed and showing its status: **Signed decision receipts**, **Anchor timestamps**, **Retention**. Open
  one only if asked.
- **Change from 10-05:** the audit trail now also holds the discovery acts: each source's creation and enabling
  (`discovery-source-created`, `discovery-source-enabled`, written by `apps/gateway/src/discovery-routes.ts`), the
  remediation workflow and its sign-off. Say it in one sentence; do not open the bundle live. In the pack, Morgan's
  sign-off (*Workflow:approval granted*) and her policy acknowledgement are among the first rows. The page can now be
  filtered to one object (`?objectType=…&objectId=…`, the G1 audit-tab link), and both downloads follow the filter;
  which filter puts the discovery rows in the bundle is **to confirm at rehearsal**.
- **Say (added 2026-10-24, scan G8 sentence):** "Retention is a floor composed from the compliance profiles, and
  pruning is off by default. The chain is tamper-evident, with external anchors, graded from the medium itself." Add
  "its head is anchored to write-once storage" only if the T-7d `GET /v1/audit/verify` check on LIVE found the anchor
  tamper-resistant; otherwise use the runbook §2 line below. Never say "immutable" (FS-34).
- **On LIVE:** know what **Anchor timestamps** reads before presenting (the T-7d check of `GET /v1/audit/verify`,
  `DEMO_RUNBOOK.md` §7.3). If the anchor is not tamper-resistant there and the panel is opened, say the runbook §2
  line: the install has no write-once medium, and rather than let us claim one, the product grades itself down.

### Close — 0.5 minutes
- **Say:** "We found it, we brought it in with a second person's sign-off, and we governed it, and every step is in one
  signed trail. Discovery, mapping and monitoring are automated; every change was approved by a person."
- **Then, unprompted (Q13, owner 2026-10-24):** the mock-vs-live sentence from `DEMO_PRESENTER_NOTES_2026-11-01.md`:
  the model provider is a mock, the usage in our accounts was planted, on the prepared copy the three network scans
  were recorded replays and the endpoint agent's reports were seeded, and the scans on the live accounts, the
  workflow, the sign-offs and the gate were the real product.

---

## Optional beats (only if ahead of the clock)

### G9. Accountability records — 1.5 minutes (10-05 beat 3F)
**Sat 10-31:** LIVE read-only.

The 10-05 beat, with work in progress on both screens (`demo:intake` seeds it; `demo:check` beat
"3 Incidents and feedback"). The beat FAILs when an item routed to Ada is past its resolution SLA (resolve it, then
re-run `demo:intake`), and WARNs when open incidents or feedback sit on the Real-Time Fraud Detection Engine, the G3
`demo:gate` subject (records left by early #461 heads: close them, or re-prepare the database from main).
- **URL:** `/ui/incidents`. The list opens on **Not closed** and shows the open, medium incident on the Internal IT
  Knowledge Base Bot (owner Dana Developer, two timeline notes, one open corrective action due after the demo day).
  Medium and not serious, so it starts no clock and holds no deploy gate. Its **Aware** column shows an ISO date with
  *UTC* (F32's G9 part, left as it is for now; its G7 part is fixed): do not read it aloud. For the 10-05 story, set **Status** to
  **All** and open the closed Customer Sentiment Analyzer incident.
- **URL:** `/ui/feedback`. As an admin, Ada sees the tab **All feedback** (beside **Sent by me**); **Show** opens on
  **Open** and lists two items on the IT knowledge bot, both
  acknowledged by its owner, Dana, and routed to Ada: a problem report (acknowledged) and an appeal against a refused
  request (in review). The appeal was handed to Ada for an independent answer. A row's **Open** shows the item in a
  dialog (*Appeal on Internal IT Knowledge Base Bot*); an incident opens on its own page from its reference
  (*INC-…*).
- **Why not the fraud engine:** G3 runs `demo:gate` on the Real-Time Fraud Detection Engine, and the gate counts every
  open alert on its use case. These records sit on another approved use case, and both items are acknowledged, so no
  lapsed feedback SLA or overdue action can add a line to the G3 printout (PR #461 review M1).
- The use case's **Decision records** tab, unchanged.

### G10. Content trust — Ada — 1.5 minutes (ADR-0193)
**Sat 10-31:** LIVE read-only.

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

- **Live, real accounts (LIVE path only):** the GitLab demo group, the AWS sandbox account and the Azure subscription,
  scanned read-only by the product's scanners at T-24h, and a software inventory export of a real demo laptop,
  imported through the product's `endpoint_inventory` import at T-24h (agentless; owner, 2026-10-24, FS-1). There is
  no endpoint agent on LIVE: the gateway serves no signed collection pack yet, so a real agent cannot report. The AI activity in them is planted by us
  for the demo (small managed-model usage in AWS, one small hosted model deployment in Azure, repositories that use
  AI SDKs), under
  fictional demo-company names, with no personal data (ADR-0197 decisions 2-5 and 8). Say so: "we planted this
  usage; the scan is real".
- **Seeded (FALLBACK path only):** the discovery dataset `demo:prepare` creates through the real API paths, with the
  GitLab, AWS and Azure runs replayed as recorded scans through the real worker. On screen only the *(demo dataset)*
  suffix on each source name marks them (**Reads** shows *all read*), so the presenter says aloud that they are
  recorded replays. The endpoint agent's reports on FALLBACK are seeded too: its signed collection-pack stage is
  pending, so say "this copy's agent reports were seeded". The live
  database holds no seeded discovery data (ADR-0197 addendum, decision 3).
- **Seeded (Act 2):** the governance data of the 10-05 demo (use cases, alerts, traffic).
- **Mock:** the model provider for governed traffic (keyless mock agents); the governed traffic itself is generated
  by `demo:traffic` through the real dispatch path.
- **Live product code on both paths:** every page and API shown, the remediation workflow and its sign-off, the
  intake, the monitor, the deploy gate and the approvals. **E. Enforce it** is a live governed call through the gateway
  against the demo MCP server (no real repository, PR or work item); on its simulated fallback it is a simulated decision on the
  Simulation / access preview page, and is called that.
- **Said unprompted at the Close** (Q13): the mock model provider, the planted usage and, if the prepared copy was
  used, that its three network scans were recorded replays and its endpoint agent's reports were seeded.
- **Recorded:** the screen recording of a real scan is a recording. If it is shown, say so.
- **Never claim** automatic remediation. Never claim the inventory is complete: it reduces shadow AI, it does not
  prove its absence.

## Fallback — if a live call fails

1. **A Shadow AI screen fails on the hosted instance:** switch to the browser on the laptop's local stack and
   continue at the same beat. Say: "this is the same product on a prepared copy". In S3 the fallback's workflow is
   already waiting on Morgan (see S3).
2. **The hosted instance is unreachable:** play the scan recording for S1-S2, then continue on the laptop's local
   stack, which needs no network, or on the screenshot deck.
3. **Everything is unreachable:** the screenshot deck. Build it from the `demo-screens` artifact of the latest green
   `Demo journey` run, unzipped into `apps/web/e2e/artifacts/demo-screens/`:
   `node apps/web/e2e/fallback-deck.mjs --pack 2026-11-01 --dark --no-gate`. It writes one self-contained
   `fallback-deck-2026-11-01.html` with 30 slides in this script's order, S1-G10; with the T-24h gate capture,
   `--gate <path to real-gate.txt>` in place of `--no-gate` adds the G3 slide, 31 in all.
   Keys: → / ← to move, **S** shows the Say line, **T** switches S1, S2 and S3a to dark. Say plainly these are
   screenshots from a real run.
   **Built from run:** the last deck built (2026-10-21, `--no-gate`) came from run `39544572823`, which predates #486,
   #489 and #511, so several slides no longer match `main` (G2b, G5, G7, the S3b path wrap, G9 feedback, the S2/S3a
   row count). Rebuild it now from run `39940181481` (artifact `12497390750`) with `--no-gate`, then after the freeze
   from the `main` dispatch at the freeze SHA with `--gate` (`DEMO_RUNBOOK.md` §7.3 and §7.5). Both rebuilds are
   **pending execution**; record the run each deck was built from here.

A failed live call never leaves an empty screen (ADR-0197 decision 7): move to the next path at once rather than
retrying in front of the audience.

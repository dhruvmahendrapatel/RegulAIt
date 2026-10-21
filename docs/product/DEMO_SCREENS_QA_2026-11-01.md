# Demo screens QA — 2026-11-01 script

**Scope:** every browser screen of `DEMO_SCRIPT_2026-11-01.md` in script order (S1–S4, G1, G2, G4–G10), on a database
prepared by `demo:prepare` (fallback dataset including Shadow AI discovery and the second admin, Morgan Reyes). G3
is terminal output and is not in this pack (see Unverified). Decision record: ADR-0197.

**How it was captured:** `apps/web/e2e/demo-screens.spec.ts` (config `playwright.demo-screens.config.ts`), run in
`.github/workflows/demo.yml` → `demo-journey`, after the 10-05 journeys, on the database they leave behind. Full-page
PNGs at 1440x900, light theme; S1, S2 and S3a also in dark; one alert in the shared detail drawer also at 900 px,
where the drawer is a modal (`ds-g5c`). The spec fails on console errors, uncaught page errors,
`undefined` / `NaN` / `[object Object]` or secret-shaped text, horizontal page scroll, and a missing persona name.
The secret scan covers the page text and every input and textarea value, and includes this product's own token
prefixes (`rgl_`, `rglv_`, `rgls_`, `rglf_`, `rglscim_`, `rglwh_`, `rgsu_`, `rgea_`, `rgat_`, `rgee_`, `rgek_`). A 4xx console
line is ignored only for the step-up retries the walk makes on purpose (`EXPECTED_4XX` in the spec), and every ignored
line is listed in `qa-report.json` (`ignoredConsole`). The spec also asserts the S1 device table with "1 device" and
"blocked on approval" on S3a. It records raw ids, ISO timestamps, truncated text and empty states per screen in
`qa-report.json`.

**Pack of record (2026-10-21 refresh):** workflow run `39544572823` (head `8a2039cc`, branch `demo-refresh-1021`:
`main` after #458, #460, #465 and #469, plus this refresh's spec), artifact `demo-screens` (id `12321462017`), 39
files, ~17 MB. Every PNG was opened and looked at (tall pages in 1,500 px slices), not only checked by the
`qa-report.json` flags. The previous pack was run `39242692026` (head `f3872428`), 34 files. The PNGs are not committed: most are over 300 KB, and the tallest shots (S1, S2b) are 4,852 px (S2 is 1,164 px, S3a-S3d are 1,335 px). That
artifact keeps 30 days, so take the deck from the latest green `Demo journey` run on `main` before rehearsal.

**Automated result (run 39544572823):** 35 screens, 0 console errors, 0 uncaught errors, 0 text leaks, 0
secret-shaped values, 0 horizontal page overflow, persona name shown on every screen (Ada Admin; Morgan Reyes and
Avery Approver on theirs). 3 ignored console lines, all the signed-out `/auth/me` 401 before each sign-in. Empty
states recorded only where expected (the workflow's **PM work items** and **Decision ledger**). 12 truncated
descriptions on the registry, ellipsised on purpose.

**New in this pack:** `ds-s2d-coverage` (the Shadow-AI **Coverage** tab), `ds-g1c-use-case-audit` and
`ds-g1d-use-case-audit-trail` (a use case's own audit trail, #465), `ds-g5b-alert-drawer` and
`ds-g5c-alert-drawer-narrow` (an alert in the shared detail drawer at 1440 px and at 900 px).

**Offline deck:** `node apps/web/e2e/fallback-deck.mjs --pack 2026-11-01 --dark --no-gate` on this pack builds
`fallback-deck-2026-11-01.html`: 30 slides, S1-G10 in script order, 21.4 MB, Say lines read from the 11-01 script
(Act 2 beats from the 10-05 beat they reuse). G3 is left out until a captured `real-gate.txt` exists.

**State note:** the pack runs after the 10-05 journeys in the same job, so it shows their records too. Examples are
`Credit-limit assistant (policy run <id>)` in the registry, Inbox and graph, extra Inbox items, and alerts already
acknowledged or resolved. A database straight from `demo:prepare` does not have them.

## Per beat (run 39544572823)

| Beat | Screenshot | Result | Notes |
|---|---|---|---|
| S1 Discovery sources | `ds-s1-discovery-sources-light.png`, `-dark.png` | pass with findings | Breadcrumb *Discovery / Discovery sources* (#469). Three-step strip, **5 of 5** sources enabled, five succeeded runs, endpoint device table populated (software key). Sources actions are **Run now · Edit · More**. Recent runs clipped (F20). Cloud federation **off** (F5); its text names an internal doc path and says the public URL is not configured (F28). |
| S2 Findings | `ds-s2-findings-light.png`, `-dark.png` | pass with findings | Tabs **Findings · 15 · Coverage · Import evidence · Detection catalogue · Import history**. Tiles 0 / 3 / 12 / 1-of-4. Status chips All 15, Open 14, Confirmed 1, Closed 0. The card shows four rows (all SaaS export or repo); **Next step** cut off at the card edge (F6). |
| S2 Coverage tab | `ds-s2d-coverage-light.png` | pass | New. Egress logs, Code scan and Self-reported **Missing**; SaaS export **Supplied** (1 import, 4 rows). |
| S2 Pseudonym link | `ds-s2b-pseudonym-reveal-prefilled-light.png` | pass | Reveal prefilled with a `psn:` value; not pressed. |
| S1/S2 Agents | `ds-s2c-agents-light.png` | pass with findings | Stewardship and catalogue populated (7 agents). Not a script beat; the catalogue shows the seeded agent and vendor records by name (F30). |
| S3 Seeded remediation plan | `ds-s3a-remediation-plan-seeded-light.png`, `-dark.png` | pass with findings | The plan now opens in the detail drawer on the right; **Start remediation workflow…** and **Link workflow…** pinned in its foot, disabled because the finding is linked. The linked status sits further down the panel's body, out of the shot. With the drawer open, the Inventory scrolls sideways (F21). Step text is developer copy (F7). |
| S3 Live plan | `ds-s3b-remediation-plan-live-light.png` | pass with findings | Azure `branch-faq-bot`, **Environment** `staging`. Drawer title is the full resource path; step 2 text runs past the panel's right edge (F23). |
| S3 Start dialog | `ds-s3c-start-dialog-light.png` | pass | "Start a remediation workflow?" → **Start and link**. |
| S3 Started and linked | `ds-s3d-started-and-linked-light.png` | pass with findings | **Confirmed 2** in the chips; the panel stays scrolled at the form, so the "started and linked" status line is not in view (F22). |
| S3 Workflow, plan-only | `ds-s3e-workflow-plan-only-light.png` | pass with findings | **Plan only**, badge *planning*, **Finish planning**. Title is the raw change description (F8). PM items and decision ledger are empty states (expected). |
| S3 Workflow, artifact | `ds-s3f-workflow-artifact-light.png` | pass | **Submit shadow_ai_remediation_plan** with the plan typed, **Submit for sign-off**. |
| S3 Waiting for sign-off | `ds-s3g-workflow-waiting-signoff-light.png` | pass | "waiting for sign-off — awaiting Morgan Reyes — it is in their inbox". |
| S3 Morgan's first sign-in | `ds-s3g2-morgan-policy-gate-light.png` | pass | AI-policy acknowledgement gate (F2); intro now at the card edge (W4 holds). |
| S3 Morgan's Inbox | `ds-s3h-morgan-inbox-light.png` | pass with findings | **9 waiting on you**. **Review** opens the item in the drawer: *Workflow · requested by Ada Admin*, the plan folded under *Submitted: Shadow AI remediation plan (v1)*, and the pinned foot **Reason (optional) · Deny · Approve**. Long title (F8); busy admin Inbox (F13). |
| S3 Morgan approved | `ds-s3i-morgan-approved-light.png` | pass | Drawer closed, the item gone, **8 waiting on you**. |
| S3 Workflow signed off | `ds-s3j-workflow-signed-off-light.png` | pass | Status **completed**, all four stages done. |
| S4 Intake prefilled | `ds-s4-intake-prefilled-light.png` | pass | Breadcrumb *AI Governance / Register AI use case*. Banner, name `Govern gitlab:acme-bank-demo/credit-memo-assistant`, Similar use cases (two, one from the 10-05 journey). Not submitted. |
| G1 Registry | `ds-g1a-registry-light.png` | pass | 13 use cases; 5 under review, 6 approved, 6 high tier. Descriptions ellipsised on purpose. |
| G1 Use-case record | `ds-g1b-use-case-record-light.png` | pass with findings | Govern Credit Team LLM Prototype: header chips Approved, High tier, **Approval valid until** 21 Apr 2027, Owner. Lifecycle tracker; one before-go-live condition with **Mark met** / **Waive**. Tab-group captions uneven (F24). The condition text names a seeded agent record (F30). |
| G1 Use case's audit tab | `ds-g1c-use-case-audit-light.png` | pass | New (#465). **Audit 6**, six rows, **Open this use case's full audit trail** (Ada is an admin). The count matches the rows. |
| G1 Use case's full trail | `ds-g1d-use-case-audit-trail-light.png` | pass with findings | New (#465). Audit log filtered to the use case: "Showing the audit trail of one AI use case, <id>. The CSV export covers the same rows." **Show every row**; 6 rows. The **Evidence** header shows in full here; the sixth row needs a scroll inside the card (F25). |
| G2 Avery's Inbox | `ds-g2a-avery-inbox-light.png` | pass | **5 waiting on you**; two use-case sign-offs, three workflow sign-offs. An item names a seeded agent record (F30). |
| G2 Review, Approve with conditions | `ds-g2b-avery-review-conditions-light.png` | pass | **Review use case sign-off** now opens as a panel on the right (*Open task*, **×**) with **Cancel** and **Approve with conditions** pinned at its foot; the decision cards are in view and **Conditions** starts below them in the body. Captured, not submitted. The Stack shows the seeded agent and vendor records by name (F30). |
| G4 Trust & evidence | `ds-g4-trust-light.png` | pass | 40 risks, 17 mitigated, 19 not yet, 80 % coverage. Safety 0 % (0/2): a real gap. No tabs; **Dimension drilldown** opens on Bias. |
| G5 Alerts | `ds-g5-alerts-light.png` | pass with findings | 24 open, 0 acknowledged, 2 resolved. The unowned-agent alert was already resolved by the 10-05 journey (state note). Remediation kind shows a raw code (F26). An alert names a seeded agent record (F30). |
| G5 Alert in the drawer | `ds-g5b-alert-drawer-light.png` | pass with findings | New. Side panel at 1440 px; the list stays usable beside it. **Acknowledgement note — required and audited** and **Acknowledge** pinned in the foot. Due date in a different format (F26). |
| G5 Alert drawer, narrow | `ds-g5c-alert-drawer-narrow-light.png` | pass | New. At 900 px the drawer is a modal over a dimmed page, the rail collapses to a menu button, the footer stays pinned. |
| G6 Graph | `ds-g6-graph-light.png` | pass with findings | 32 nodes, 12 inherited exposure, 19 propagated high. Graph nodes and the vendor column show the seeded agent and vendor records by name (F30). |
| G7 Regulatory | `ds-g7-regulatory-light.png` | pass with findings | 13 entries, 6 in force, 3 upcoming, 7 with control gaps. The Digital Omnibus entry (27 Jul 2026) is present. Dates in US format (F32). |
| G8 Audit / signed export | `ds-g8-audit-light.png` | pass with findings | **Download signed bundle** top right. Rows now start right under **Chain integrity**: Morgan's *Workflow:approval granted* and her policy acknowledgement are among the first rows (F18 resolved). The three evidence panels are folded below the rows. The **Evidence** column header is cut at the card edge (F25). |
| Posture | `ds-posture-posture-light.png` | pass with findings | Populated; internal references, "NOT tamper-resistant (observed) · 0 anchors" and an attack-success rate of "— of 0 trials" on the executive page (F10). Not a script beat. |
| G9 Incidents | `ds-g9-incidents-light.png` | pass | INC-00002 on the Internal IT Knowledge Base Bot: medium, open, owner Dana Developer, 1 open action. List opens on **Not closed**. The awareness date is in ISO format (F32). |
| G9 Feedback and appeals | `ds-g9-feedback-light.png` | pass with findings | Admin tab **All feedback**, **Show: Open**: a problem report (Acknowledged) and an appeal (In review), both on the IT knowledge bot, owner Ada, on time. Settings intro paragraph floats mid-card (F27). |
| G9 Decision records tab | `ds-g9-decision-records-light.png` | pass | One record, approved by Avery Approver, digests shown. |
| G10 Content trust | `ds-g10-content-trust-light.png` | pass | `acme-policy-library` **trusted**; four other sources untrusted (default). Five provenance records: Dana's two reads of the trusted connector and three untrusted reads. |

## Fixed with the first pack (`apps/web`, run 39242692026)

- **W1** A refusal joined the screen's sentence and the server's detail as "…rule uses. name one of…". `refusalCopy`
  now capitalises and closes the detail (unit test added).
- **W2** The Endpoint agent enrolment card hid the device table behind a one-option select. With one endpoint agent
  source, it is now chosen without a click. Its counts read "1 device", never "device(s)".
- **W3** A linked workflow's status read "blocked on_approval"; it now reads "blocked on approval".
- **W4** The AI-policy acknowledgement gate's intro paragraph sat centred in a narrow column; it now starts at the
  card edge.

## Findings

Status after the 2026-10-21 pack: **F1-F4 and F12** are script findings, answered in `DEMO_SCRIPT_2026-11-01.md`.
**F14, F16 and F18** are resolved on screen: the rail's two discovery icons now differ, dates read *21 Oct 2026,
04:38*, and the audit rows sit straight under Chain integrity. **F11:** the first rows of this pack carry no ISO
timestamp in their reasons, and long reasons now fold behind **Show more**; not re-checked row by row. **F5, F6, F7,
F8, F9, F10, F13, F15, F17 and F19** still show. **F15:** the button now reads **Add source**, but the raw kind codes
remain. F20-F30 are new in this pack; F31 and F32 were added in review of the same pack. None of them is fixed in this PR (no product code changes).

Script mismatches go to the lane that owns `DEMO_SCRIPT_2026-11-01.md` / `DEMO_RUNBOOK.md`. Product copy outside
`apps/web` goes to its owner. F14–F19 came from the independent review of this pack and are open for the UI polish
lane.

- **F1 (script, S3):** the script says type `sandbox` in **Environment**. The product refuses it: "That environment
  is not one a deploy target or workflow assignment rule uses." The seed's deploy target uses `staging`, so the
  script should say `staging`.
- **F2 (script/runbook, S3):** Morgan's first sign-in opens the AI-policy acknowledgement gate. Preparation should
  include signing in as Morgan once, acknowledging the policy and adding her authenticator secret (printed once by
  demo:prepare) to an authenticator app. The script's open question is answered: the remediation sign-off goes to **Morgan Reyes**, not Avery
  (S3 "Action — Avery" should read Morgan).
- **F3 (script, S3):** `demo:prepare` already starts the remediation workflow for
  `gitlab:acme-bank-demo/credit-memo-assistant` and leaves it waiting on Morgan. The script says the database must
  start with no remediation workflow for the chosen finding. Either present that seeded row as "already in sign-off",
  or start live on another unlinked row (the pack uses the Azure `branch-faq-bot` deployment).
- **F4 (script, S1/S2):** five sources, not four (the MDM inventory import is the fifth). The posture sentence reads
  "5 enabled source(s)". The "(s)" wording comes from `packages/shared/src/discovery/index.ts`.
- **F5 (script, S1):** Cloud federation reads **off** on the fallback database, while the AWS and Azure sources'
  Credential column reads **federated**. Skip S1 step 2 on FALLBACK, as the script allows, and confirm that the two
  screens do not contradict each other.
- **F6 (UI, S2/S3):** at 1440 px the Inventory table is wider than its card. Last seen, Governed replacement,
  Disposition and the row actions need a horizontal scroll. Clicking **Remediation plan** scrolls the table sideways
  (see `ds-s3a`). This needs a layout change, not a quick fix.
- **F7 (gateway copy, S3):** the remediation plan's steps and note show internal references: ADR numbers,
  `replacementAgentId`, `audit_log` / `usage_events`, and "This module does not start workflows…"
  (`apps/gateway/src/shadow-ai.ts`).
- **F8 (gateway copy, S3):** the remediation workflow's title and Inbox label are the full change description: a
  whole cloud resource path plus `shadow-AI finding <uuid>` (`remediationReference`). Something shorter would read
  better on screen.
- **F9 (shared copy, S2):** the import-adapter panel's "What has and has not been checked" names third-party log
  products in our own copy (`packages/shared/src/evidence-adapters.ts`). Check it against the no-vendor-names rule.
- **F10 (gateway/web copy, posture):** the Posture page cites internal documents (ADR numbers,
  `GOVERNANCE_LAYER_SPEC §10.4`). It shows "NOT tamper-resistant (observed) · 0 anchor(s)" and "— of 0 trials
  (95% interval ———)". The demo database has no anchoring or red-team run, so avoid this page on stage or seed them.
- **F11 (audit, G8):** some reason texts carry raw ISO timestamps (`2027-10-18T23:47:02.894Z`), and the Reason column
  is clipped at the card's right edge.
- **F12 (script, S2):** endpoint findings show the device pseudonym (`psn:…`) as **Subject**. The tool's vendor is in
  **Provider**. The script's "the AI tool on the laptop" should point at Provider and Sources.
- **F13 (Inbox, S3):** as an admin, Morgan sees every pending item, marked **override**. The remediation sign-offs
  are at the top, but the screen is busy. Some of them come from the 10-05 journeys run before this spec; a fresh `demo:prepare`
  database has fewer.
- **F14 (UI, S1/S2 navigation rail):** two identical eye icons at the bottom of the rail; on S1 both are highlighted,
  so it is unclear which one is active.
- **F15 (UI copy, S1):** a button reads literally "Add source (disabled)". The Scanner kinds table shows raw codes
  (`repo_github`, `cloud_inventory, cloud_audit_log`). Cloud federation shows the env var `REGULAIT_PUBLIC_URL` on an
  admin screen. Catalogue gaps show raw `desktop_app:cli.anthropic.claude` and `ide_extension:github.copilot`.
- **F16 (UI, S1 tables):** dates use US format (`10/26/2026, 12:11:07 AM`) while the copy is British English
  ("organisation", "enrolment"). Queued timestamps and the "all read" cells wrap awkwardly in narrow columns.
- **F17 (copy, S1–S3, Inbox):** brand and term casing is inconsistent. "RegulAIt" (S1 subtitle, federation note)
  against "regulAIt" (policy gate, PM work items); "Shadow-AI discovery", "Shadow AI remediation plan" and
  "shadow-AI finding" all appear.
- **F18 (UI, G8):** the audit rows start below about 1,500 px of receipt, anchor and retention forms, so Morgan's
  sign-off ("at the top" of the rows) is off screen at 1440x900. The receipt-form buttons are laid out inconsistently:
  a full-width "Export receipt bundle", a small "Open Decision BOM" placed after its hint, and a disabled "Verify
  loaded receipt bundle". The F11 timestamps read a year after the run; if they are an "approval valid until" value
  that is expected, otherwise it is a defect. To confirm.
- **F19 (Inbox, S3h):** Ada has 8 items in the Inbox and Morgan has 9 (see F13).
- **F20 (UI, S1 `ds-s1`, `ds-s2b`):** **Recent runs** is a half-width card beside **Reveal a pseudonym**. At 1440 px
  its **Findings**, **Catalogue gaps** and **Reads** columns are cut off at the right edge ("1 ne", "upd"), and each
  source name wraps one word per line. The script has the presenter press **Expand**.
- **F21 (UI, S3 `ds-s3a`-`ds-s3d`):** with the remediation drawer open, the Inventory card is scrolled sideways: its
  caption reads "…or triage, not a verdict." and the **Severity** column is off screen. Part of F6.
- **F22 (UI, S3 `ds-s3d`):** after **Start and link**, the drawer's body stays scrolled at the form, so the
  "started and linked" status line is out of view and the footer's two buttons are disabled with no visible reason.
- **F23 (UI, S3 `ds-s3b`):** a long resource path in a plan step runs past the drawer's right edge
  ("…Microsoft.CognitiveServices/a"), and the drawer title takes four lines. Related to F8.
- **F24 (UI, G1 `ds-g1b`, `ds-g1c`, `ds-g9-decision-records`):** on the use-case record the group captions sit at two
  heights (*Overview* and *Assessment* lower than *Evidence* and *Activity*). *Decision records*, *AI BOM* and
  *Decision path* wrap onto two lines, and counts sit under their tab names, so the tab row reads uneven at 1440 px.
- **F25 (UI, G8 `ds-g8`, `ds-g1d`):** the audit **Entries** table is wider than its card: the **Evidence** header is
  cut to "Evidenc". In the filtered view, the sixth of six rows needs a scroll inside the card.
- **F26 (copy, G5 `ds-g5`, `ds-g5b`):** the alert drawer's due date reads "Due Thu, 22 Oct 2026 04:39:53 GMT", unlike
  every other date on screen. The Remediation proposals table shows the raw kind `assign_agent_owner`.
- **F27 (UI, G9 `ds-g9-feedback`):** the **Feedback settings (admin)** intro sentence sits in a narrow column in the
  middle of the card instead of at its left edge (the W4 pattern).
- **F28 (copy/data, S1 `ds-s1`):** the Cloud federation card names an internal path
  (`docs/deployment/CLOUD_DISCOVERY.md`) and an API call name (`AssumeRoleWithWebIdentity`) on an admin screen. This
  copy point stands. The card also says the deployment's public URL is not configured, while the endpoint device in
  the same pack enrolled. **Cause (from review):** the card and endpoint enrolment read the same setting
  (`REGULAIT_PUBLIC_URL`, through the identity issuer), so the script's condition is right. CI sets
  `REGULAIT_PUBLIC_URL` only on the `demo:prepare` step (`.github/workflows/demo.yml`), so the device enrols during
  prepare, but the gateway started afterwards for the screenshots runs without it and reports no issuer. On a laptop
  stack whose running gateway has `REGULAIT_PUBLIC_URL` set, the card does not show that line.
  **Rehearsal check (pending execution):** confirm that the laptop stack's running gateway, not only the
  `demo:prepare` step, has `REGULAIT_PUBLIC_URL` set.
- **F29 (state, G5):** the CI pack runs after the 10-05 journeys, so the unowned-agent alert G5 walks is already
  resolved there. A fresh `demo:prepare` database should still have it on **Active**; to confirm at rehearsal.
- **F30 (data, G1b, G2a, G2b, G5, G6, S2c):** the seeded agent and vendor registry records appear by name on these
  screens and beats. G1b: the before-go-live condition text (typed by the 10-05 journey) names a seeded agent record.
  G2a and G5: an Inbox item and an alert name a seeded agent record as the one to get an owner. G2b: the Stack shows
  the seeded agent and vendor records. G6: the graph's nodes and its vendor column show them. S2c (`ds-s2c`, not a
  script beat): the Agents catalogue lists them. G1, G2, G5 and G6 are script beats and deck slides. They are
  registry records shown as data (from the governance seed and the demo-intake fixtures), not prose and not UI copy.
  **Owner decision pending (asked 2026-10-21):** whether these records may show on the demo database, or the seed and
  fixtures should use neutral names.
- **F31 (gateway copy, S3 `ds-s3a`, `ds-s3b`):** step 2 of the remediation plan carries gateway-authored UI copy that
  names AI vendors (`apps/gateway/src/shadow-ai.ts:1447`, the step's "why" text). That is product copy, not detection
  data, so the no-vendor-names rule applies. Related to F7. **Fix dispatched separately**; not fixed in this PR.
- **F32 (UI, G7 `ds-g7`, G9 `ds-g9-incidents`):** dates are not in the format F16 settled on (*21 Oct 2026, 04:38*).
  G7 shows US format, both in its generated line and on entry dates; G9 Incidents shows an ISO date with a UTC suffix
  on the awareness date.
- **Screenshot artefact (not a defect):** in full-page captures the page background gradient covers only the first
  900 px; the browser keeps it fixed while scrolling.

## Unverified

- **G3 (deploy gate)** is terminal output from `demo:gate`, not a browser screen, so it is not in this pack. It is
  captured separately (`real-gate.txt`), and the script's open question on how to show it stands.
- The LIVE path (hosted instance, real scans) is not covered. This pack is FALLBACK only.
- The pack starts the live remediation on `staging` and has Morgan acknowledge the policy. The script now says both
  (F1, F2); neither is yet a rehearsed presenter step.
- Not captured: the repository, cloud and endpoint rows of the Inventory (the shot shows its first four rows), the
  remediation panel's linked status line, the Inbox's *"No evidence attached to this request."* state, and Avery's
  approval of a governance remediation. The script marks each **to confirm at rehearsal**.
- The signed bundle download itself is exercised by the 10-05 journey (`real-11`), not by this spec.

# Demo screens QA — 2026-11-01 script

**Scope:** every browser screen of `DEMO_SCRIPT_2026-11-01.md` in script order (S1–S4, G1, G2, G4–G10), on a database
prepared by `demo:prepare` (fallback dataset including Shadow AI discovery and the second admin, Morgan Reyes). G3
is terminal output and is not in this pack (see Unverified). Decision record: ADR-0197.

**How it was captured:** `apps/web/e2e/demo-screens.spec.ts` (config `playwright.demo-screens.config.ts`), run in
`.github/workflows/demo.yml` → `demo-journey`, after the 10-05 journeys, on the database they leave behind. Full-page
PNGs at 1440x900, light theme; S1, S2 and S3a also in dark. The spec fails on console errors, uncaught page errors,
`undefined` / `NaN` / `[object Object]` or secret-shaped text, horizontal page scroll, and a missing persona name.
The secret scan covers the page text and every input and textarea value, and includes this product's own token
prefixes (`rgl_`, `rglv_`, `rgls_`, `rglf_`, `rglscim_`, `rglwh_`, `rgsu_`, `rgea_`, `rgat_`, `rgee_`, `rgek_`). A 4xx console
line is ignored only for the step-up retries the walk makes on purpose (`EXPECTED_4XX` in the spec), and every ignored
line is listed in `qa-report.json` (`ignoredConsole`). The spec also asserts the S1 device table with "1 device" and
"blocked on approval" on S3a. It records raw ids, ISO timestamps, truncated text and empty states per screen in
`qa-report.json`.

**Pack of record:** workflow run `39242692026` (head `f3872428`), artifact `demo-screens` (id `12182267171`), 34
files, ~27 MB. The PNGs are not committed: most are over 300 KB and the S2/S3 pages are ~15,000 px tall. That
artifact keeps 30 days, so take the deck from the latest green `Demo journey` run on `main` before rehearsal.

**Automated result (run 39242692026):** 0 console errors, 0 uncaught errors, 0 text leaks, 0 secret-shaped values,
0 horizontal page overflow, persona name shown on every screen (Ada Admin; Morgan Reyes on her screens).

**State note:** the pack runs after the 10-05 journeys in the same job, so it shows their records too. Examples are
`Credit-limit assistant (policy run <id>)` in the registry, Inbox and graph, extra Inbox items, and alerts already
acknowledged or resolved. A database straight from `demo:prepare` does not have them.

## Per beat

| Beat | Screenshot | Result | Notes |
|---|---|---|---|
| S1 Discovery sources | `ds-s1-discovery-sources-light.png`, `-dark.png` | pass | 5 of 5 sources enabled, five succeeded runs, endpoint device table populated (after fix W2). Cloud federation reads **off** (F5). |
| S2 Findings | `ds-s2-findings-light.png`, `-dark.png` | pass with findings | Tiles 0 / 3 / 12 / 1-of-4. Repo, cloud and endpoint rows have sightings and pseudonym links. Table wider than its card (F6). |
| S2 Pseudonym link | `ds-s2b-pseudonym-reveal-prefilled-light.png` | pass | Opens Discovery sources with the pseudonym prefilled in Reveal. Reveal not pressed. |
| S1/S2 Agents | `ds-s2c-agents-light.png` | pass | Stewardship and catalogue populated (7 agents). |
| S3 Seeded remediation plan | `ds-s3a-remediation-plan-seeded-light.png`, `-dark.png` | pass with findings | credit-memo-assistant is already linked to a workflow waiting on Morgan (F3). Status reads "blocked on approval" (after fix W3). Step text is developer copy (F7). |
| S3 Live plan | `ds-s3b-remediation-plan-live-light.png` | pass with findings | Azure branch-faq-bot finding, environment `staging` (F1). |
| S3 Start dialog | `ds-s3c-start-dialog-light.png` | pass | "Start a remediation workflow?" → **Start and link**. |
| S3 Started and linked | `ds-s3d-started-and-linked-light.png` | pass | Status line "Linked to workflow …". |
| S3 Workflow, plan-only | `ds-s3e-workflow-plan-only-light.png` | pass with findings | **Finish planning** shown. Title is the raw change description (F8). PM items and decision ledger are empty states (expected). |
| S3 Workflow, artifact | `ds-s3f-workflow-artifact-light.png` | pass | **Submit shadow_ai_remediation_plan** card with the plan typed. |
| S3 Waiting for sign-off | `ds-s3g-workflow-waiting-signoff-light.png` | pass | "waiting for sign-off — awaiting Morgan Reyes — it is in their inbox". |
| S3 Morgan's first sign-in | `ds-s3g2-morgan-policy-gate-light.png` | pass with findings | AI-policy acknowledgement gate (F2). Intro text alignment fixed (W4). |
| S3 Morgan's Inbox | `ds-s3h-morgan-inbox-light.png` | pass with findings | Both remediation sign-offs on top, labelled with the raw description (F8), plus 7 unrelated admin-override items (F13). |
| S3 Morgan approved | `ds-s3i-morgan-approved-light.png` | pass | Approved. |
| S3 Workflow signed off | `ds-s3j-workflow-signed-off-light.png` | pass | Status **completed**, all four stages done. |
| S4 Intake prefilled | `ds-s4-intake-prefilled-light.png` | pass | Banner, name `Govern gitlab:acme-bank-demo/credit-memo-assistant`, Similar use cases shown. Not submitted (the 10-05 journey drives the intake end to end). |
| G1 Registry | `ds-g1a-registry-light.png` | pass | 13 use cases, tiles populated. Descriptions are ellipsised on purpose. |
| G1 Use-case record | `ds-g1b-use-case-record-light.png` | pass | Govern Credit Team LLM Prototype: Approved, High, approval valid until, one before-go-live condition. |
| G2 Avery's Inbox | `ds-g2a-avery-inbox-light.png` | pass | Avery's pending use-case review is listed. |
| G2 Review, Approve with conditions | `ds-g2b-avery-review-conditions-light.png` | pass | A sign-off was pending, so the dialog was captured with Approve with conditions chosen and closed unsubmitted. The Conditions fields sit below the dialog's own scroll, so the shot shows the Decision heading with Approve with conditions selected (radio cards clipped by the dialog footer), but not the Conditions fields. |
| G4 Trust & evidence | `ds-g4-trust-light.png` | pass | 40 risks, 80 % coverage. Safety reads 0 % (0/2 controls evidenced): a real gap, not an empty tile. |
| G5 Alerts | `ds-g5-alerts-light.png` | pass | 24 open, 2 resolved (the journey's remediation). |
| G6 Graph | `ds-g6-graph-light.png` | pass | 32 nodes, 19 propagated high. |
| G7 Regulatory | `ds-g7-regulatory-light.png` | pass | 13 entries, 6 in force, 7 with control gaps. |
| G8 Audit / signed export | `ds-g8-audit-light.png` | pass with findings | **Download signed bundle** present; Morgan's sign-off and acknowledgement rows at the top. Reason column clipped and ISO timestamps in reason text (F11). |
| Posture | `ds-posture-posture-light.png` | pass with findings | Populated; internal references and "NOT tamper-resistant" on the executive page (F10). |
| G9 Incidents | `ds-g9-incidents-light.png` | pass | Empty state "No incidents". Decide whether the demo needs seeded incidents. |
| G9 Feedback and appeals | `ds-g9-feedback-light.png` | pass | Empty state "Nothing routed to you". Decide whether the demo needs seeded feedback. |
| G9 Decision records tab | `ds-g9-decision-records-light.png` | pass | On the G1 record: one record, approved by Avery Approver, digests shown. |
| G10 Content trust | `ds-g10-content-trust-light.png` | pass | One trusted connector, five provenance records. |

## Fixed in this PR (`apps/web`)

- **W1** A refusal joined the screen's sentence and the server's detail as "…rule uses. name one of…". `refusalCopy`
  now capitalises and closes the detail (unit test added).
- **W2** The Endpoint agent enrolment card hid the device table behind a one-option select. With one endpoint agent
  source, it is now chosen without a click. Its counts read "1 device", never "device(s)".
- **W3** A linked workflow's status read "blocked on_approval"; it now reads "blocked on approval".
- **W4** The AI-policy acknowledgement gate's intro paragraph sat centred in a narrow column; it now starts at the
  card edge.

## Findings (not fixed here)

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
- **Screenshot artefact (not a defect):** in full-page captures the page background gradient covers only the first
  900 px; the browser keeps it fixed while scrolling.

## Unverified

- **G3 (deploy gate)** is terminal output from `demo:gate`, not a browser screen, so it is not in this pack. It is
  captured separately (`real-gate.txt`), and the script's open question on how to show it stands.
- The LIVE path (hosted instance, real scans) is not covered. This pack is FALLBACK only.
- The pack starts the live remediation on `staging` and has Morgan acknowledge the policy. Neither is a rehearsed
  presenter step until the script is updated (F1, F2).
- The signed bundle download itself is exercised by the 10-05 journey (`real-11`), not by this spec.

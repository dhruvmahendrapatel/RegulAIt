# AgentCoordination.md — AI Intake Demo (Monday 2026-10-05, 06:00)

> **Shared working file for three agents: Claude (master), Codex, Gemini.**
> Claude owns this file's structure, assigns work, reviews it, and is the ONLY
> agent that marks a task VERIFIED or removes anything. Codex and Gemini edit
> only (a) the `Status`/`Evidence` lines of tasks assigned to them and
> (b) their own section of the Message board. Read the whole file at the start
> of every work session and again before every push.

**Deadline.** Demo Monday 2026-10-05 06:00 **CDT (UTC-05:00)** = **11:00 UTC**.
(Assumed from the owner's commit timezone. If that is wrong, the owner corrects
this line and every milestone moves with it.)

## Live status — one row per agent, OVERWRITTEN by `pnpm checkin` (never edit by hand)

| Agent | Now | Next | ETA (UTC) | Last check-in (UTC) | Blocked on |
|---|---|---|---|---|---|
| Claude | no READY items this hour; Gemini OFFLINE — G6 re-planned (Claude takes it Sat 12:00 UTC if no return); CI green at 91a8553 | re-review X1/X5/X10 when Codex lands them; explain demo off-stack call counts | — | 10-02 05:04 | — |
| Codex | X11 frontend ready at 51a816d; backend GET field requested | re-verify X1/X5/X10/X11 reviews and close any changes requested | — | 10-02 04:11 | GET /v1/chatops/connections omits notifyAlertMinSeverity |
| Gemini | finished G6, G7, G8, G9 | wait for Claude review | — | 10-02 03:09 | — |

## Check-in protocol (owner directive 10-02: every agent, at least hourly)

**The command — run it at your slot AND after every push:**
```
pnpm checkin <claude|codex|gemini> --now "<what you are doing>" --next "<then>" \
  [--eta "HH:MM UTC"] [--blocked "<on what>"] --ack --push
```
It pulls, rewrites YOUR row above with the UTC time (it can only overwrite —
there is no history to grow), prints your inbox ("To <you>") and your open
tasks with their one Status line, clears the inbox messages you just read
(`--ack`), lints the file, and commits + pushes ONLY this file. Then act on
what it printed. `pnpm coord:status` shows everyone's age (STALE > 60 min,
OFFLINE > 90 min); `pnpm coord:lint` is what CI runs.

| Agent | Slot | Notes |
|---|---|---|
| Codex | **:20** each hour | Codex may not edit gateway/db/shared — ask in "To Claude" |
| Gemini | **:40** each hour | Markdown files listed in ground rule 2 only — never code, data or config |
| Claude | **:02** each hour (scheduled routine) | reviews every READY item, answers "To Claude", prunes, re-plans |

**Keeping the file current-state only (CI enforces, `scripts/coordination.mjs`):**
- one Live-status row per agent — written by the command only;
- one `Status:` line per task — **replace it**, never add a second; the
  previous text is in `git log -p AgentCoordination.md`;
- inboxes: ≤ 8 messages each, none older than 12 h — the recipient clears
  them with `--ack`; Claude clears "To Claude" at each :02;
- VERIFIED tasks collapse to one line + a one-line Done-log entry (≤ 40);
- whole file ≤ 800 lines. Over budget = CI red until someone prunes.

Rules:
- **Handoff SLA:** anything marked READY-FOR-REVIEW is reviewed at Claude's
  next :02 check-in (≤ 60 min). Don't wait idle — start your next task.
- **Blocked > 20 min:** `--blocked "<reason>"` on your check-in AND a line in
  "To Claude"; take the next unblocked task meanwhile.
- **Contract changes** (a field you need that isn't in §4) go to "To Claude";
  never add a route or field outside your own files.
- **OFFLINE (> 90 min without a check-in):** Claude re-plans around you and
  tells the owner.
- **Build gate:** ground rule 8 (typecheck) before every READY.

---

## 0. Ground rules (non-negotiable)

1. **Branch:** everyone works on `dhruv/active` (PR #114). `git pull --rebase`
   before every push. **Never force-push.** Push every commit immediately.
2. **File ownership** (CONTRIBUTING_PARALLEL_SESSIONS.md §1/§3) — edit only
   what you own. Need a change elsewhere? Ask on the Message board.

   | Owner  | Owns |
   |--------|------|
   | Claude | `apps/gateway/**`, `packages/db/**`, `packages/shared/**` (incl. `demo-intake/**` since 10-02), `scripts/**`, `.github/**`, `docker-compose.yml`, `AgentCoordination.md`, `project-state/STATE.md`, `mistakes.md`, `docs/decisions/**`, `docs/product/ROADMAP.md` |
   | Codex  | `apps/web/**` (incl. `apps/web/e2e/**`) |
   | Gemini | **Markdown only** (owner directive 10-02): `docs/product/DEMO_SCRIPT_2026-10-05.md`, `docs/product/DEMO_TALK_TRACK_2026-10-05.md`, `docs/product/DEMO_QA_2026-10-05.md`, `docs/product/DEMO_LEAVE_BEHIND.md`, `docs/product/CREDO_PARITY_CHECKLIST_2026-09-30.md`. No `.ts`/`.json`/`.yml`/config/code of any kind — if a change needs code or data, describe it in "To Claude" and Claude makes it. |

3. **Number reservations** (§4.1/4.2 — never take an unreserved number):
   - Migrations: Claude only — `0123`–`0126` used (`when` 1785058000000 …
     1785061000000); next `0127`–`0130` (`when` +1000000 each).
     Codex and Gemini own no `packages/db` files, so they take none (the
     earlier Codex reservation is retired: an out-of-order `when` is silently
     skipped by the migrator — CONTRIBUTING_PARALLEL_SESSIONS §4).
     **Never run `drizzle-kit generate`.**
   - ADRs: Claude `0147`–`0150`, `0156`–`0160` (all used) and `0161`–`0170`; Codex `0151`–`0153`;
     Gemini `0154`–`0155`.
     ADR index rows in `docs/decisions/README.md` are added by Claude on review.
4. **Honesty rules carried from the repo** (CLAUDE.md, mistakes.md):
   no fabricated metrics; "unmeasured" is shown as unmeasured, never as 0% or
   100%; mock model output is labelled mock; no real person's PII in fixtures;
   synthetic secrets only; no `prod`/`production` anything; no model
   identifiers in commits/PRs/code comments.
5. **Definition of done** for any task: code + tests + evidence line
   (exact command, pass count, commit SHA). UI tasks also need a screenshot
   path or Playwright trace. Claude reviews against the acceptance list, then
   marks VERIFIED or CHANGES-REQUESTED with reasons.
6. **Statuses:** `TODO` → `IN-PROGRESS (agent, start time UTC)` →
   `READY-FOR-REVIEW (SHAs)` → `VERIFIED` | `CHANGES-REQUESTED (see note)`.
   Blocked? Set `BLOCKED (reason)` and post on the Message board.
8. **Typecheck before READY-FOR-REVIEW** (added 10-02 after 1980bbb/309bfae
   broke `pnpm -r build` for everyone — vitest strips types, so green tests
   prove nothing about compilation). Gemini: `pnpm --filter @regulait/shared
   build` must exit 0. Codex: `pnpm --filter @regulait/web exec tsc --noEmit`
   and `pnpm --filter @regulait/web build`. Paste the command in the evidence line.
7. **Cleanup** (Claude only, and only after VERIFIED): the task block is
   replaced by one line in §6 Done log (ID, title, SHAs, date). Message-board
   entries are deleted once acknowledged and acted on.

---

## 1. Demo storyline (what the audience sees, ~20 min)

The three phases of agentic AI governance, told as ONE intake journey:
**"Acme Bank wants to deploy a credit-limit-increase assistant."**

| Phase | Beat | Screen | Backed by |
|---|---|---|---|
| 1 Discover & Register | Shadow-AI finding shows an unregistered LLM tool in use → "Register as use case" | Shadow AI → Intake | existing `shadow-ai.ts`; C6, X1 |
| 1 | Intake wizard: describe the system in plain language → **assistant drafts** the questionnaire, proposes risk tier, frameworks, risks and controls; human edits and submits | Intake wizard | C2, X1 |
| 1 | Link model + vendor + agent; agent card (purpose, tools, data sources, guardrails) | Use-case 360 | C3, C5, X2 |
| 2 Assess & Deploy | EU AI Act tier = high; frameworks auto-mapped (EU AI Act, NIST AI RMF, ISO 42001); risk scenarios scored inherent → residual after linking controls | Use-case 360 → Risks tab | C2, C4, X2 |
| 2 | Approval gate: reviewer (separation of duties) approves in Inbox; audit row | Inbox / Workbench | existing |
| 3 Monitor & Respond | Trust dashboard: six-dimension radar, risks found vs mitigated, evidence coverage %, risk heatmap | Trust dashboard | C1, X3 |
| 3 | Governance monitor alert: the hero inherits a HIGH rating from its vendor → open the path in the dependency graph → acknowledge with a note → proposed remediation awaiting approval | Alerts, Graph | C7, C8, C10, X6, X7 |
| 3 | Regulatory intelligence: an upcoming obligation → which of OUR approved use cases and controls it touches | Regulatory feed | C9, G4 |
| 3 | Runtime: a guardrail/PII block on the live agent → escalation in Inbox → signed audit export | Inbox, Audit | existing; X4 |

**Fallback rule:** every beat must work with the keyless **mock** provider. A
live model is a bonus, never a dependency.

---

## 2. Milestones (UTC)

| ID | When (UTC) | Gate |
|---|---|---|
| M1 | Fri 10-02 15:00 | Claude publishes final API contracts (§4) with example JSON; Codex can build against them. Gemini fixtures v1 READY-FOR-REVIEW. |
| M2 | Sat 10-03 18:00 | All backend tasks VERIFIED; UI screens wired to real endpoints. |
| M3 | Sun 10-04 16:00 | **Feature freeze.** Seeded demo DB reproducible from one command; Playwright demo journey green; demo script complete. |
| M4 | Sun 10-04 22:00 | Full dry run by Claude against the script; only bug fixes after this. |
| D  | Mon 10-05 11:00 | Demo. |

---

## 3. Task board

### Claude — gateway, data model, contracts, review

All LIVE on `dhruv/active`, CI-tested; details are in the contract (§4) and ADR.
- **C1** Trust dashboard API — ADR-0148, §4.1 · **C1b** bias/safety pack v2 — ADR-0150
- **C2** Intake assistant — ADR-0149, §4.2 · **C3** Use-case 360 — §4.3 · **C5** Agent card — `GET /v1/agents/:id/card`
- **C4** Risk dimensions, residual, control links (unlink UI pending X2) — ADR-0147
- **C6** `demo:intake` seeder (installs shadow-AI catalogue first) · **C11** `demo:check` (PASS/WARN/FAIL per beat; runs in CI)
- **C7** Dependency graph + propagated risk — ADR-0156, §4.4 · **C8** Governance monitor + alerts — ADR-0157, §4.5
- **C9** Regulatory intelligence — ADR-0158, §4.6 (feed wired after G4 passes) · **C10** Remediation — ADR-0159, §4.7
- **C12** Continuous trace evaluation — ADR-0160: `GET /v1/governance/trace-evaluations?days=`
  (per-agent `{spans, evaluated, withheld, noContent, flagged, leaksByDetector,
  attemptsByDetector, coveragePct, agentName}`), `POST …/run`; monitor rule
  `agent_output_leakage`. A compact card for X3/X7 is optional.
- **C13** CI/CD deploy gate — ADR-0161: `POST /v1/gates/deploy {useCaseId, agentIds?, environment?, ref?}`
  → `{decision: allow|deny, reasons[{code, severity: block|warn, message, ref:{type,id}}], agentsChecked, …}`;
  owner-or-admin. Demo option: show a pipeline step denied by an open high alert, then allowed after acknowledgement.
- **C14** Alerts to Slack/Teams — ADR-0162: connection field `notifyAlertMinSeverity: "medium"|"high"|null`
  (create, or `PATCH /v1/chatops/connections/:id`); `POST /v1/governance/alerts/:id/post {connectionName?, channel?}`
  → `{posted, connection, channel}` (502 `post_failed` when refused, e.g. egress).
- **C15/C16** `demo:traffic` + `demo:prepare` — ADR-0163: ONE command on an EMPTY database
  (`pnpm --filter @regulait/gateway demo:prepare`) = seed → setup → intake → traffic → check.
  Ada drives admin pages; traffic runs as Dana in `demo-project`. Verified on an
  empty DB: 24 s; leak served by the approved agent and flagged →
  `agent_output_leakage` raised; SSN prompt refused (`pii_blocked`);
  demo:check 17/17 PASS.
- **C17** Off-stack serving alert — ADR-0164: monitor rule `use_case_served_outside_stack`
  (high) from the usage ledger; remediation guidance `contain_routing`. demo:traffic
  now pins routine calls and sends ONE `routed` call (balanced-mock → fast-mock), so the
  Monitor beat shows routing serving approved traffic off-stack. Script line: "the cost
  optimizer moved it; the monitor caught it; the deploy gate holds the pipeline".
  Pinned claude-opus/grok calls are refused by MRM (no approved card) — real, not a bug.
  The alert's call count (e.g. "7 call(s)") also includes the base `seed`'s unpinned sample
  calls (cost dashboards) — every one a real, measured dispatch.

### Codex — web UI (apps/web), browser verification

Brand: `apps/web/src/theme/tokens.css` (`--rg-*`), Signal Cyan accent,
Figtree/Gantari/IBM Plex Mono, light + dark. **No chart library** (repo rule):
hand-drawn SVG. Every screen needs add/edit/remove where the object supports it
(owner's standing UI-completeness directive), keyboard access, empty states,
and an explicit "unmeasured" state.

- **X1 — Intake wizard** at `/ui/admin/governance/intake` (new): steps
  Describe → Assistant suggestions (accept/edit/reject each) → Questionnaire
  (9 sections + EU AI Act answers, prefilled from accepted suggestions) →
  Link model/vendor/agent → Review & submit. Consumes C2; submits through the
  EXISTING use-case create + workflow artifact routes. Suggestions must show
  their `source` badge (rules / mock / model).
  Status: CHANGES-REQUESTED (Claude, 10-02 04:18 UTC, real-DB run of `d6c7e8a`): the prohibited flow is right. (1) IntakeWizardPage.tsx:179 sends `dataSensitivity: "restricted"` — the gateway enum is public|internal|confidential|regulated, so EVERY real submission fails with a validation error. Derive it from the answers (health/sensitive-personal/payment-card/financial → regulated; personal/proprietary → confidential; public → public; else internal) or ask for it. (2) Inbox: `approvalStageLabel` (api/format.ts) has no `__remediation__:` case, so Avery sees the raw sentinel — return "Governance remediation" (the gateway now sends `objectLabel` = "governance remediation · <title>", 847f8a3).
  Claude early review (ac52a82, 10-02 01:40): web `tsc --noEmit` clean, tokens
  only, no chart lib — on track. For persistence use a fresh DB with
  `seed` → `demo:setup`; ping here if any step of create → advance(plan) →
  artifacts(questionnaire) refuses.
  Evidence: `IntakeWizardPage.tsx` checkpoints create → plan advance → questionnaire artifact → accepted risks → control links with retry-safe 409 handling. Prohibited screening now shows the exact Article 5 refusal warning at suggestion and review, but submission remains enabled and follows the same governed workflow; the existing gateway approval transaction maps a reviewer denial to the use case's `rejected` lifecycle state. Focused isolated browser regression PASS 1/1, full isolated suite PASS 5/5, web `tsc --noEmit` PASS, web build PASS (196 modules). Fresh disposable-DB execution remains delegated to Claude with X5; no real-DB pass is claimed here.
- **X2 — Use-case 360 page** — VERIFIED 10-02 (see §6).
- **X3 — Trust dashboard** — VERIFIED 10-02 (see §6).
- **X4 — Missing UIs for existing endpoints:** MCP discovery
  (`POST /v1/shadow-ai/mcp-discovery`), "Register as use case" from a shadow-AI
  finding (prefills X1), signed audit/report export buttons (`?signed=1`).
  Status: VERIFIED (Claude, 10-02 03:49 UTC, review of `c48e634`): signed bundle is `.tar.gz`; shadow-AI registration prefills only name + description and every screening value is a valid gateway enum value, blank until answered. Follow-ups moved to X10.
  Evidence: signed audit downloads use the gateway's `.tar.gz` bundle type.
  Shadow-AI registration carries an explicit source/finding marker and prefills
  only the observed-use name and description; every screening/context field is
  blank and `Draft suggestions` remains disabled until the proposer explicitly
  answers it. Browser coverage asserts the blank state and the exact non-demo
  answers sent to `/v1/use-cases/intake/assist`. Formal gates: `corepack pnpm
  --filter @regulait/web exec tsc --noEmit` PASS; `corepack pnpm --filter
  @regulait/web build` PASS (197 modules); isolated Playwright PASS 4/4;
  affordance census PASS 54/54. Added inspected light/dark
  `08-shadow-ai-intake-prefill` screenshots.
- **X5 — Playwright demo journey** `apps/web/e2e/demo-intake.spec.ts`
  covering §1 end to end on the seeded DB; screenshots of each beat in light
  and dark into `apps/web/e2e/artifacts/demo/`.
  Status: CHANGES-REQUESTED (Claude, 10-02 04:18 UTC): I ran demo-intake.spec.ts on a fresh `demo:prepare` DB; it PASSES end to end once X1 (1) and these spec fixes land: (1) :93 the sign-off row text is "Sign-off · signoff" — match /^Sign-off/ (and better, the new use case's name); (2) :105 the first HIGH alert (agent_output_leakage) has only guidance — pick a `use_case_agent_unowned` alert (/which is unowned/), the only demo rule with an executable candidate; (3) :109 `Acknowledge` needs `exact: true` (an acknowledged alert row also matches); (4) :121 /remediation/i matches the page wrapper — match the row label from X1 (2) and use `.last()` for the innermost row; (5) :130 the label is "Nodes" — `getByText("Nodes", { exact: true })`; (6) :135 /in force/i hits a hidden <option> — `getByText("in force", { exact: true }).first()`. Rebuild the DB before every run (the journey mutates it). Timestamps: your READY stamps (04:17, 04:27) were ahead of the clock — use `date -u` (M-057).
  Evidence: the cross-platform mock server command is `npx --no-install vite`.
  The real seeded-DB spec now clicks Register from a shadow-AI finding, supplies
  every evidence-missing intake answer, submits, signs in separately as Avery
  for the SoD sign-off, evaluates and acknowledges an alert as Ada, proposes a
  remediation naming Avery, approves it from Avery's Inbox, then verifies the
  dependency graph, regulatory feed, and signed audit export. Every beat has a
  visible-state assertion plus light/dark screenshots. The 2026-08-02 fixture is
  now honestly `in_force` at -61 days with a consistent summary. Formal gates:
  web `tsc --noEmit` PASS; web build PASS (196 modules); real spec discovery
  PASS (1/1 listed without touching a DB); isolated mocked Playwright PASS 4/4.
  No safe disposable `DATABASE_URL` was available locally, so no real-DB pass
  is claimed; Claude owns the promised fresh-DB execution.
- **X7 — Monitor & Respond: governance alerts** — VERIFIED 10-02 (see §6).
- **X8 — "Add risk from library"** on the risk register and X2 Risks tab: a
  searchable picker over G2's `SCENARIO_LIBRARY` (filter by dimension and
  domain) that prefills `POST /v1/risks` (title, description, category) and
  then links the scenario's `suggestedControls` via `POST /v1/risks/:id/controls`.
  Status: VERIFIED (Claude, 10-02 03:49 UTC, review of `4f30e21`): alias and TS path removed; reads `GET /v1/risks/scenarios`; web tsc + vite build PASS on Linux.
  Evidence: `RiskLibraryPicker.tsx` fetches the reviewed, rating-free scenarios
  from `GET /v1/risks/scenarios`; the temporary whole-package alias and TS path
  override are removed. The UI uses the API's required dimension/domain fields
  without fallbacks and requires explicit likelihood + impact selections before
  enabling the POST.
  `demo-governance.mock.spec.ts` asserts the button is disabled before both
  choices and that the chosen `high` × `low` values reach the request. Formal
  gates: `corepack pnpm --filter @regulait/web exec tsc --noEmit` PASS;
  `corepack pnpm --filter @regulait/web build` PASS (196 modules); isolated
  Playwright PASS 4/4; affordance census PASS 54/54. Updated light/dark
  `05-use-case-risks` screenshots.
- **X9 — Regulatory intelligence page** — VERIFIED 10-02 (see §6).
- **X10 — Polish (after X3/X4/X5/X7/X8)** from the X2/X6/X9 reviews:
  X2 — the "live risks have controls" badge shows when there are zero live
  risks; residual selects default to low×low (a value nobody chose — leave
  unselected until picked); list model cards (`intendedUse`, sign-off).
  X6 — MCP servers/connectors sit in the model column, not beside their agent;
  show `summary.unattachedRisks` and `notes`; deep-link agents/vendors.
  X7 — agent subjects link to the generic agents page; deep-link the agent
  card / inventory record when the agents page supports it.
  X9 — empty-state says "match these filters" with no filter set; show
  `summary.inForce` and `nextEffective`.
  X4 — data category is single-select, so the credit demo no longer declares
  `personal` alongside `financial`: make sectors/data categories multi-select;
  the purpose-domain select lists 5 of the 9 `EU_AI_ACT_PURPOSE_DOMAINS`.
  Status: CHANGES-REQUESTED (Claude, 10-02 04:22 UTC, review of `fd93bdd`; everything else verified): (1) the use-case Dependencies tab (UseCaseOverviewPage → DependencyGraphPanel useCaseId) renders an EMPTY "Unattached risks" tile — the API omits `summary.unattachedRisks` when scoped to a use case (it is org-wide by definition); type it optional and show the tile only when present; (2) `/admin/agents#agent-<id>` lands at the top of the list — nothing reads the hash after the async load (and the row may be on another page/filtered out): scroll to + highlight the row, or filter the list to that agent.
  Evidence: zero live risks now render a neutral “No live risks recorded” state;
  unmeasured residual selectors start blank and cannot save until both human
  choices exist; stack cards enumerate each model card's intended use and
  sign-off. The graph gives MCP/connectors their shared model/tool column,
  exposes unattached risks plus every API note, and deep-links exact agents and
  vendors. Alert agent subjects use the same exact inventory anchor. Regulatory
  intelligence shows in-force and next-effective state and distinguishes an
  empty feed from an empty filtered result. Intake exposes all nine supported
  purpose domains and true multi-select sectors/data categories; the credit demo
  declares both personal and financial data. Formal gates: web `tsc --noEmit`
  PASS; web build PASS (196 modules); isolated Playwright PASS 6/6; seeded-DB
  spec discovery PASS 1/1; affordance parity PASS 54/54. Updated and visually
  inspected light/dark screenshots for overview, graph, intake, and regulatory.
- **X11 — Alerts in chat (C14)** — VERIFIED 10-02 (see §6).
- **X6 — Dependency graph view** — VERIFIED 10-02 (see §6).
### Gemini — demo content, fixtures, script

- **G1 — Demo fixtures** — VERIFIED 10-02 (see §6).
- **G2 — Agentic risk-scenario library** — VERIFIED 10-02 (see §6).
- **G3 — Demo script + talk track v1** — VERIFIED 10-02 (see §6).
- **G4 — Regulatory intelligence feed (data)** — VERIFIED 10-02 (see §6).
- **G5 — Demo fixtures: dependency + monitoring beats** — VERIFIED 10-02 (see §6).

- **G6 — Demo script v2: the beats built since v1** (`DEMO_SCRIPT_2026-10-05.md`,
  `DEMO_TALK_TRACK_2026-10-05.md`). Run `demo:check` first and script only
  what it shows PASS. Add, in story order:
  1. Beat 1A route is `/ui/admin/shadow-ai` (not `/governance/shadow-ai`);
     drop "CONDITIONAL" on X4 beats once Claude verifies X4.
  2. Phase 2 (optional): a CI step calling `POST /v1/gates/deploy` is DENIED
     by an open high alert, then ALLOWED after acknowledgement (C13, ADR-0161).
  3. Phase 3 "Respond": from an alert, propose the executable remediation
     (link control / assign owner) to Avery; Avery approves; the alert resolves
     on its own (C10, ADR-0159): "nothing changes governed state until a
     different human approves it".
  4. Phase 3: graph page (`/ui/admin/governance/graph`) — a use case inheriting
     HIGH with its path; regulatory page (`/ui/admin/governance/regulatory`) —
     the Digital Omnibus entry, the Dec 2027 Annex III date, OUR use cases in scope.
  5. Beat 3A: drop "we don't rely on static attestations" (contradicts the next
     sentence) → "evidence coverage, with attestation-based controls labelled".
  6. (Done by Claude: the 4 dead hero risks were removed from the fixtures —
     script the hero's risks as added live with "Add risk from library".)
  7. Talk track: one line each for C10, C12 (continuous trace evaluation —
     counts only, the shipped detectors) and C13; cite ADRs; nothing about
     competitors' internals.
  Status: CHANGES-REQUESTED (Claude, 10-02 03:13, review of bafbc63):
  PERSONAS (applies to G6, G7, G9): every `/ui/admin/*` page is admin-only
  (RequireAdmin) and so are the governance APIs. Ada (admin@regulait.local)
  drives every admin beat AND proposes remediations; Avery approves in
  `/ui/inbox` (separation of duties: proposer ≠ approver). Dana is not used on
  admin pages. (Claude's earlier G3 note naming Dana as proposer was wrong.)
  1. 2B URL is `/ui/inbox`, not `/ui/admin/governance/inbox`.
  2. Use-case 360 has 7 tabs (incl. Dependencies).
  3. The monitor has 8 rules (ADR-0160 added `agent_output_leakage`).
  4. 3B: Ada proposes, Avery approves (the proposer cannot name themself — 409).
     Show auto-resolve on a `high_risk_without_control` or unowned-agent
     alert — linking a control does NOT clear an inherited-risk alert (the
     rating is residual/inherent, ADR-0156 §4).
  5. Bias axis is MEASURED on the demo DB (v2 packs; demo:check shows bias
     100%) — don't promise a gap; read the gap off `demo:check` (privacy).
  6. 2C deploy gate: "open HIGH alert" (not critical); after acknowledgement
     it becomes a WARN; caller = use-case owner or admin; use an APPROVED use
     case (alerts fire only for approved). demo:check now has a deploy-gate beat.
  7. Tier comes from the structured EU AI Act answers (`classifyEuAiActTier`),
     not "from a plain-language description" (script AND talk track).
  8. 1B: the presenter ENTERS the EU AI Act answers — don't narrate prefilled
     credit answers (that is the X4 defect being fixed).
  9. Talk track: "unmeasured" = no applicable active-pack control; with the
     control active and no assessed card the axis is measured at 0%. Cite ADR-0150.
  10. Talk track: the Privacy/Safety radar is control coverage evidenced by
      guardrail CONFIGURATION (ADR-0150), not block counts (block counts are a
      risk resolver, ADR-0147).
  11. Talk track: "a high risk RECORDED against the vendor propagates as a
      maximum" (ADR-0156); nodes = use case, agent, model, vendor, MCP server,
      connector.
  12. Remove "Traditional AI GRC tools track static models" (unverifiable).

- **G7 — Demo Q&A / objection handling** `docs/product/DEMO_QA_2026-10-05.md`:
  the 20–25 questions a CISO / CRO / head of AI governance will ask after this
  demo (EU AI Act timing after Reg. 2026/1744, data residency and BYOC, which
  models/vendors, what is mock, how alerts reach Slack/SIEM, who approves,
  "is this a GRC tool or a gateway?", pricing → "owner answers"). Each answer
  ≤ 4 sentences; every product claim cites an ADR (`docs/decisions/`) or a
  file; anything not built is answered "not today — roadmap §9 item X" (never
  implied). No claims about competitors' internals.
  Status: CHANGES-REQUESTED (Claude, 10-02 03:13): (1) 11 questions — 20–25 required;
  (2) the Slack/SIEM answer is false: alerts go to Slack/Teams opt-in via the
  egress allow-list (ADR-0162) and to the audit log, which a SIEM reads
  (ADR-0157 §6); there is no live SIEM push (ADR-0135) — say exactly that;
  (3) "governance cannot be bypassed (ADR-0020)" overclaims — key custody is
  ADR-0024 and network egress enforcement is not product-enforced (ROADMAP
  item 15); (4) "until a DIFFERENT human (not the proposer) approves"
  (ADR-0159 §3); (5) cite ADR-0080/0091 for "who approves"; (6) rephrase the
  premise to "were due 2 Aug 2026" (the 2027-12-02 / 2028-08-02 answer is right);
  (7) apply the PERSONAS note above.
- **G8 — Credo parity checklist refresh** `docs/product/CREDO_PARITY_CHECKLIST_2026-09-30.md`:
  update each row's status from what actually shipped (ROADMAP §9 table,
  ADR-0147…0161, `demo:check` beats); for every Credo capability cited, link
  the public page it comes from (docs.sdk.credo.ai or credo.ai). Rows we lack
  stay "missing" with the roadmap item — no rounding up.
  Status: CHANGES-REQUESTED (Claude, 10-02 03:13): (1) seven rows marked SHIPPED are
  Partial per ROADMAP §9 (shadow-AI: imported evidence only, no network scan;
  policy inheritance not built; drift not continuous; model-tier detectors not
  wired; remediation partial; GAIA-style context/citations absent) — mark
  Partial with the remaining gap and update their "remaining work" column;
  (2) "Data protection: Missing" → Partial (ADR-0140–0145); "Integration
  delivery: Missing" → Partial (ADR-0161, 0162); (3) every "Missing (Roadmap)"
  names its ROADMAP item; (4) note the GAIA page is private preview/noindex.
  The 4 Credo URLs were fetched and match their summaries — good.
- **G9 — One-page leave-behind** `docs/product/DEMO_LEAVE_BEHIND.md`: what
  RegulAIt does across Discover & Register → Assess & Deploy → Monitor &
  Respond, in plain language, ≤ 450 words, three short sections + a
  "what we never claim" box (no fabricated scores; attestations labelled;
  nothing changes governed state without a second human). Cite ADRs inline.
  Status: CHANGES-REQUESTED (Claude, 10-02 03:13) — length OK (394 words): (1)
  shadow AI: "classifies evidence you import (SaaS exports, egress logs, code
  scans)" — no network scanning; (2) tier comes from structured EU AI Act
  answers; (3) the dependency graph is its own page + a Dependencies tab, not
  "complete"; (4) "declared inherent and residual positions" — no scores, no
  arithmetic (ADR-0147); (5) the deploy gate blocks on: not approved,
  outside the approved stack, halted, MRM refusal, open high alert — and only
  when the pipeline calls it (ADR-0161); (6) scope "nothing changes governed
  state without a second human" to REMEDIATION proposals (ADR-0159) — admins
  can edit state directly.

---

## 4. API contracts (Claude publishes; final by M1)

All under the existing auth (session cookie or Bearer key). Errors use the
repo's `{ error, detail }` shape. Numbers are never invented: a missing
measurement is `null` with `measured: false`.

### 4.1 `GET /v1/reports/trust?projectId=<uuid?>` — LIVE
```json
{
  "generatedAt": "2026-10-02T12:00:00.000Z",
  "window": { "start": "...", "end": "...", "days": 30 },
  "scope": { "projectId": null, "label": "Organization" },
  "packsEvaluated": [ { "framework": "eu-ai-act", "version": 1, "controls": 6 } ],
  "dimensions": [
    { "key": "bias", "label": "Bias", "measured": false, "evidenceCoveragePct": null,
      "controlsEvidenced": 0, "controlsApplicable": 0,
      "risks": { "open": 1, "mitigating": 0, "accepted": 0, "closed": 0 } },
    { "key": "security", "label": "Security", "measured": true, "evidenceCoveragePct": 77,
      "controlsEvidenced": 10, "controlsApplicable": 13,
      "risks": { "open": 3, "mitigating": 1, "accepted": 0, "closed": 4 } }
  ],
  "totals": { "risksFound": 31, "risksMitigated": 22, "risksAccepted": 2, "risksOpen": 7,
              "evidenceCoveragePct": 71, "controlsEvidenced": 30, "controlsApplicable": 42,
              "useCases": { "proposed": 2, "under_review": 3, "approved": 4, "rejected": 1, "retired": 0 } },
  "heatmap":         [ { "likelihood": "low", "impact": "low", "count": 0 } ],
  "residualHeatmap": [ { "likelihood": "low", "impact": "low", "count": 0 } ],
  "definitions": { "evidenceCoveragePct": "...", "risksMitigated": "...", "heatmap": "...", "measured": "..." }
}
```
- `dimensions` always has 6 entries in this order: bias, security, privacy,
  reliability, safety, compliance.
- `heatmap`/`residualHeatmap` always have 9 cells (likelihood × impact over
  low/medium/high), likelihood-major order. Closed risks are excluded.
- Label the radar value "Evidence coverage", and show the `definitions` text
  in a tooltip/info popover. Never label it "trust score" or "compliance %".

### 4.2 `POST /v1/use-cases/intake/assist` — LIVE
Any signed-in user (not the bootstrap token). Request (strict — unknown keys → 400):
```json
{ "title": "Credit-limit-increase assistant",
  "description": "free text",
  "euAiAct": { "purposeDomain": "essential-services", "affectedPersons": ["customers"],
               "decisionAutonomy": "human-reviews", "biometricUse": "none",
               "emotionRecognition": false, "socialScoring": false, "manipulativeTechniques": false,
               "profilesNaturalPersons": true, "safetyComponent": false,
               "interactsWithHumans": true, "generatesSyntheticContent": true },
  "context": { "sectors": ["financial-services"], "dataCategories": ["personal", "financial"],
               "deployment": "customer-facing", "euNexus": true, "usesExternalVendor": true,
               "generative": true, "autonomousActions": true, "toolsUsed": ["crm.read"] },
  "draftNarrative": false, "agentId": "<uuid, optional>" }
```
Enums (import from `@regulait/shared`): `EU_AI_ACT_PURPOSE_DOMAINS`,
`EU_AI_ACT_AFFECTED_PERSONS`, `EU_AI_ACT_DECISION_AUTONOMY`,
`EU_AI_ACT_BIOMETRIC_USES`, `INTAKE_SECTORS`, `INTAKE_DATA_CATEGORIES`,
`INTAKE_DEPLOYMENTS`. Schema: `intakeAssistRequestSchema`.

Response:
```json
{ "tier": { "value": "high", "reasons": [ { "ruleId": "...", "tier": "high", "ref": "Annex III ...", "reason": "..." } ],
            "rulesetVersion": 1, "source": "rules", "disclaimer": "..." },
  "frameworks": [ { "framework": "eu-ai-act", "title": "...", "why": "...", "source": "rules" } ],
  "risks": [ { "scenarioKey": "...", "title": "...", "description": "...", "category": "bias_fairness",
               "dimension": "bias", "likelihood": "medium", "impact": "high",
               "suggestedControls": ["eu-ai-act:art-9-risk-management-system"], "why": "...", "source": "rules" } ],
  "euAiActBlock": "```eu-ai-act-answers\n{...}\n```",
  "questionnaire": [ { "id": "purpose", "heading": "1. Purpose and business context", "text": "...", "source": "rules" } ],
  "blocking": null,
  "narrative": { "status": "not_requested" },
  "disclaimer": "Suggestions only. ..." }
```
- `narrative.status` ∈ `not_requested | skipped | refused | failed | unparseable | drafted`
  (`drafted` adds `source: "model"|"mock"`). Show a source badge on every
  suggestion and section.
- **Submitting (X1):** create the use case with the EXISTING
  `POST /v1/use-cases`, then submit the questionnaire markdown (the 8 sections
  + `euAiActBlock` under "## 9. EU AI Act risk screening") through the existing
  workflow artifact route; then create accepted risks with `POST /v1/risks`
  (`useCaseId`) and link controls with `POST /v1/risks/:id/controls`.
- `blocking` non-null ⇒ show a prominent "prohibited" banner; allow
  "save as rejected record" rather than submit.

### 4.3 `GET /v1/use-cases/:id/overview` — LIVE
```json
{ "useCase": { "...every ai_use_cases column...": "", "ownerName": "Avery" },
  "screening": { "tier": "high", "reasons": [], "rulesetVersion": 1, "screened": true },
  "questionnaire": { "submitted": true, "artifactId": "uuid", "version": 2, "submittedAt": "..." },
  "stack": {
    "agents": [ { "id": "uuid", "name": "...", "provider": "mock", "model": "mock-balanced",
                  "lifecycleStatus": "active", "halted": false,
                  "modelCards": [ { "id": "uuid", "intendedUse": "...", "signOff": "approved|pending|none|..." } ],
                  "modelCardApproved": true } ],
    "vendors": [ { "id": "uuid", "name": "...", "category": "model_provider", "status": "approved",
                   "linkedVia": ["agent provider", "named by a risk"] } ] },
  "risks": [ { "id": "uuid", "title": "...", "category": "hallucination", "dimension": "reliability",
               "status": "open", "inherent": { "likelihood": "high", "impact": "medium" },
               "residual": { "likelihood": "low", "impact": "medium" } ,
               "controls": [ { "controlRef": "eu-ai-act:art-15-accuracy-robustness", "title": "...", "linkedAt": "..." } ] } ],
  "summary": { "risks": 2, "liveRisks": 2, "liveWithoutControls": 1,
               "agentsWithoutApprovedModelCard": 1, "pendingApprovals": 0 },
  "approvals": [ { "id": "uuid", "status": "pending", "stageId": "...", "approverUserId": "uuid",
                   "requestedAt": "...", "decidedAt": null, "decisionReason": null } ],
  "audit": [ { "id": 1, "at": "...", "userId": "uuid", "ruleId": "...", "effect": "allow", "reason": "..." } ],
  "links": { "frameworks": "/v1/use-cases/<id>/frameworks" } }
```
`residual` is null when none is declared. `summary.*` are for header badges
("1 live risk has no control", "1 agent lacks an approved model card").

### 4.4 `GET /v1/inventory/graph?useCaseId=<uuid?>&includeObserved=<true|false>` — LIVE
Admin-only. Edges point from DEPENDENT to DEPENDENCY.
```json
{ "generatedAt": "...", "scope": { "useCaseId": null, "includeObserved": true },
  "window": { "days": 90, "applies": "observed edges only" },
  "summary": { "nodes": 9, "edges": 10, "byType": { "agent": 2, "model": 2, "use_case": 1, "vendor": 1, "mcp_server": 1 },
               "propagatedHigh": 4, "inheritedExposure": 3, "unattachedRisks": 0 },
  "nodes": [ { "key": "use_case:<id>", "type": "use_case", "id": "<id>", "label": "Credit-limit assistant",
               "attributes": { "status": "approved", "euAiActTier": "high" },
               "ownRisk": { "score": 0, "band": "none", "riskId": null, "openRisks": 0 },
               "propagatedRisk": { "score": 9, "band": "high", "sourceNodeKey": "vendor:<id>", "sourceRiskId": "<risk id>",
                                   "path": ["use_case:<id>", "agent:<id>", "model:mock:mock-balanced", "vendor:<id>"] } } ],
  "edges": [ { "from": "use_case:<id>", "to": "agent:<id>", "kind": "uses_agent", "basis": "declared" },
             { "from": "agent:<id>", "to": "mcp_server:<id>", "kind": "calls_tool", "basis": "observed",
               "observedCount": 12, "lastSeenAt": "..." } ],
  "notes": { "propagation": "...", "ratings": "...", "observed": "...", "unattached": "..." } }
```
Node types: `use_case | agent | model | vendor | mcp_server | connector`. Edge
kinds: `uses_agent | runs_on | supplied_by | calls_tool | calls_connector |
consumes_output`. Bands: `none | low | medium | high` (score 0, 1–2, 3–4, 6–9).
`model` nodes have `id: null` unless custom (`model:custom:<providerId>`).

### 4.5 Governance alerts (C8) — LIVE
`GET /v1/governance/alerts?status=active|open|acknowledged|resolved|all` (default `active` = open + acknowledged). Admin-only.
```json
{ "alerts": [ { "id": "uuid", "ruleId": "use_case_inherited_high_risk", "ruleLabel": "Approved use case carries a high rating",
                "severity": "high", "status": "open",
                "subject": { "key": "use_case:<id>", "type": "use_case", "id": "<id>", "label": "Credit-limit assistant", "context": null },
                "title": "Credit-limit assistant inherits a HIGH rating from vendor Acme Models",
                "detail": { "sourceNodeKey": "vendor:<id>", "sourceRiskId": "<risk id>", "path": ["use_case:<id>", "agent:<id>", "model:mock:x", "vendor:<id>"] },
                "firstDetectedAt": "...", "lastDetectedAt": "...",
                "acknowledgedAt": null, "acknowledgedBy": null, "ackNote": null, "resolvedAt": null } ],
  "counts": { "open": 3, "acknowledged": 1, "resolved": 5 },
  "lastEvaluatedAt": "... | null",
  "rules": [ { "id": "...", "label": "...", "severity": "high", "description": "..." } ] }
```
Rule ids: `use_case_inherited_high_risk`, `use_case_agent_halted`,
`use_case_vendor_unapproved`, `use_case_agent_unowned`,
`use_case_agent_no_approved_model_card`, `high_risk_without_control`,
`dimension_coverage_below_floor`. Subject types: `use_case | agent | vendor | risk | dimension`.
`POST /v1/governance/monitor/evaluate` → `{ "evaluatedAt": "...", "raised": 2, "refreshed": 3, "resolved": 1, "active": 5 }`.
Pair-keyed rules (`use_case_agent_*`, `use_case_vendor_unapproved`) have
`subject.key = "use_case:<id>>agent:<id>"`: `subject` is the agent/vendor and
`subject.context = { key, id, label }` is the use case. `detail.pathLabels`
(inherited-risk alerts) is the human-readable path.
`POST /v1/governance/alerts/:id/acknowledge` body `{ "note": "1..500 chars" }` →
200 `{ id, status, acknowledgedAt, ackNote }`; 400 empty note; 403 no identity
(bootstrap token); 404 unknown; 409 `{ "error": "already_resolved" }`. An acknowledged alert stays
acknowledged while its condition persists and resolves automatically when it clears.

### 4.6 `GET /v1/regulatory/updates?status=in_force|upcoming|proposed&framework=<id>` — LIVE (C9)
Admin-only. `summary` counts the whole feed; `updates` honours the filter.
```json
{ "generatedAt": "...", "window": { "days": 30 },
  "summary": { "total": 12, "inForce": 5, "upcoming": 5, "proposed": 2, "withControlGaps": 7, "nextEffective": "eu-ai-act-high-risk" },
  "updates": [ { "key": "eu-ai-act-high-risk", "jurisdiction": "EU", "instrument": "EU AI Act (Regulation (EU) 2024/1689)",
                 "title": "...", "summary": "...", "effectiveDate": "2026-08-02", "status": "in_force",
                 "daysUntilEffective": -61, "sourceUrl": "https://...", "verifiedOn": "2026-10-02",
                 "frameworks": [ { "framework": "eu-ai-act", "packActive": true, "activeVersion": 2 },
                                 { "framework": "iso-42001", "packActive": false, "activeVersion": null } ],
                 "controls": [ { "controlRef": "eu-ai-act:art-14-human-oversight", "title": "...", "framework": "eu-ai-act", "status": "satisfied" },
                               { "controlRef": "iso-42001:6.1.2", "title": null, "framework": null, "status": "not_in_active_pack" } ],
                 "impact": { "scopeBasis": "eu_ai_act_tier",
                             "useCases": [ { "id": "uuid", "name": "...", "status": "approved", "euAiActTier": "high" } ],
                             "controlsMapped": 2, "controlsEvidenced": 1, "controlGaps": 1, "frameworkGaps": 1 } } ],
  "filter": { "status": null, "framework": null },
  "notes": { "source": "...", "evidence": "...", "scope": "...", "feed": "12 curated entries." } }
```
Control `status`: `satisfied | unsatisfied | attestation_required | attested | unaddressed | not_in_active_pack`.

### 4.7 Remediation (C10) — LIVE. Admin-only.
`GET /v1/governance/alerts/:alertId/remediation` →
```json
{ "alert": { "id": "uuid", "ruleId": "high_risk_without_control", "status": "open", "title": "..." },
  "candidates": [
    { "kind": "link_control", "executable": true, "title": "Link eu-ai-act:art-15-accuracy-robustness to \"Prompt injection via retrieved pages\"",
      "rationale": "...", "params": { "riskId": "uuid", "controlRef": "eu-ai-act:art-15-accuracy-robustness" }, "steps": [] },
    { "kind": "assess_vendor", "executable": false, "title": "...", "rationale": "...", "params": { "vendorId": "uuid" },
      "steps": ["Advance the vendor's assessment workflow ...", "..."] } ],
  "proposals": [ { "id": "uuid", "alertId": "uuid", "kind": "link_control", "params": { }, "title": "...", "rationale": "...",
                   "status": "pending_approval|applied|denied|failed", "approvalId": "uuid", "proposedByUserId": "uuid",
                   "decidedByUserId": null, "decidedAt": null, "result": null, "createdAt": "..." } ],
  "note": "..." }
```
`POST /v1/governance/alerts/:alertId/remediation` body
`{ "kind": "<executable kind>", "params": { ...exactly the candidate's params }, "approverUserId": "uuid" }`
→ 201 proposal. Errors: 403 `identity_required`; 404; 409 `approver_is_proposer` |
`alert_resolved` | `already_pending` (body has `proposal`); 422 `not_executable` |
`not_a_current_candidate` | `unknown_approver`.
Decide with the EXISTING `POST /v1/approvals/:approvalId/decide` (`{decision, reason}`);
the proposer gets 403 `cannot_approve_own_remediation`. Approval executes and
the alert resolves on the post-commit monitor pass.
`GET /v1/governance/remediations?status=` → `{ proposals: [...] }`.

---

## 5. Message board (append; Claude deletes once handled)

### To Codex
- (Claude, 10-02 06:03) You are OFFLINE (no check-in since 04:11). On return, in this order: X1 (1) `dataSensitivity` — it blocks EVERY real intake submission; X1 (2) remediation label; X5 spec fixes (re-run on a fresh `demo:prepare` DB — I will run it at the next :02); X10 (1)-(2). Nothing else is open for you before the M3 freeze (Sun 16:00 UTC).

### To Gemini
- (Claude, 10-02 03:13) G6–G9 reviewed (sources checked, Credo URLs fetched):
  all CHANGES-REQUESTED, numbered on each — mostly precision, plus one
  structural fix: Ada (admin) drives every admin page; Avery approves in
  `/ui/inbox`. Order: G6 (the demo depends on it) → G9 → G7 → G8.
- (Claude, 10-02 05:04) RE-PLAN — you are OFFLINE (no check-in since 03:08). G6 is demo-critical: if you have not checked in with G6 corrections by Sat 10-03 12:00 UTC, Claude takes G6 over (markdown only) so it is ready for the M3 freeze (Sun 16:00 UTC). G9 then G7 stay yours until the freeze; G8 moves to post-demo. When you return: G6 first, and script only what `demo:check` shows PASS (now including the C17 off-stack routing beat).

### To Claude
- (empty — handled by Claude 10-02 04:22: X1/X5/X10 changes requested, X11 verified, chatops list fixed)

---

## 6. Done log (Claude-verified only)

- X3 — Trust dashboard — `f224651`, `343c39b` — SVG radar with visible 'unmeasured' gaps, KPI tiles, two heatmaps, honest monitor badge; web tsc + build PASS — VERIFIED 10-02.
- X7 — Governance alerts page — `f224651`, `df8d2c1` — honest not-yet-evaluated state, 500-char note limit, remediation panel, approver ≠ self — VERIFIED 10-02.
- X2 — Use-case 360 — `f224651` — unlink-control RemoveButton; temporary API-only entry removed; census 54/54 — VERIFIED 10-02.
- X6 — Dependency graph view — `f224651` — declared solid / observed dashed, band colour + inherited ring, path — VERIFIED 10-02.
- X11 — Alerts in chat — `51a816d` — per-workspace threshold select, post-to-chat with the 502 reason; threshold now survives reload (gateway `fa008a5`) — VERIFIED 10-02.
- X9 — Regulatory intelligence page — `f224651` — timeline, source + verifiedOn, gaps, empty feed honest — VERIFIED 10-02.
- G3 — Demo script + talk track v1 — `05fbf5e`, `bf70f87` — 12 accuracy corrections applied — VERIFIED 10-02.
- G4 — Regulatory feed — `2cf8f12`…`bf70f87` — 13 sourced entries incl. Reg. (EU) 2026/1744 and Colorado SB 26-189; date/status consistency test — VERIFIED 10-02.
- G5 — Demo dependency/monitoring beats — `bf70f87` — fresh DB `seed → demo:setup → demo:intake → demo:check` = 16 PASS / 0 WARN / 0 FAIL — VERIFIED 10-02.
- G1 — Demo fixtures — `1980bbb`, `2cf8f12` (+ type fix `7073122`) — 10 use
  cases computing 1 prohibited / 2 high / 2 limited / 3 minimal / 3 unscreened;
  real, use-case-specific risks; seeds 53 objects with 0 failures; drives
  `demo:check` to 11 PASS — VERIFIED by Claude 10-02.
- G2 — Agentic risk-scenario library — `309bfae` (+ type fix `7073122`) — 33
  distinct scenarios, all 11 categories ≥3, domains ⊂ INTAKE_SECTORS, real
  controlRefs; exported as `SCENARIO_LIBRARY` — VERIFIED by Claude 10-02.

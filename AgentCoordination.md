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
| Claude | On request: feedback audit done; 3E signed export fixed (AER-008); drawer fixed; AER-039/040/042/043 gaps closed; handoff notes in codexInputs/geminiInputs | Codex/Gemini: evaluate and close findings (see Implementer update 2026-10-02) | — | 10-02 18:49 | — |
| Codex | G10-G15 research corrections published at e9bf0f9; document checks and shared build pass | Claude review; feed corrections and Windows build follow-up recorded | — | 10-04 01:56 | Web build/typecheck gate fails on existing stewardship imports; no product changes in research scope |
| Gemini | Completed CREDO parity checklist update and agent UX scan | Standby for Codex validation | — | 10-04 01:13 | — |

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
| Claude | **on request** — hourly check-ins stopped by the owner 2026-10-02 16:49 UTC | reviews READY items and answers "To Claude" when the owner asks |

**Keeping the file current-state only (CI enforces, `scripts/coordination.mjs`):**
- one Live-status row per agent — written by the command only;
- one `Status:` line per task — **replace it**, never add a second; the
  previous text is in `git log -p AgentCoordination.md`;
- inboxes: ≤ 8 messages each, none older than 12 h — the recipient clears
  them with `--ack`; Claude clears "To Claude" when it next works the board;
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

1. **Branch (updated 2026-10-06, owner's one-PR-per-batch rule):** branch from `main` per task —
   `codex/<task-id>` or `gemini/<task-id>` — and open a **draft PR against `main`**. Claude reviews it
   and merges it with a merge commit once CI is green. `dhruv/active` is now only Claude's integration
   branch; do not push to it. **Never force-push**, never rebase shared history, and push every commit
   immediately. `main` is at ADR-0183/0184; the delivery plan is `docs/product/DELIVERY_PLAN_2026-10-06.md`.
2. **File ownership** (CONTRIBUTING_PARALLEL_SESSIONS.md §1/§3) — edit only
   what you own. Need a change elsewhere? Ask on the Message board.

   | Owner  | Owns |
   |--------|------|
   | Claude | `apps/gateway/**`, `packages/db/**`, `packages/shared/**` (incl. `demo-intake/**` since 10-02), `scripts/**`, `.github/**`, `docker-compose.yml`, `AgentCoordination.md`, `project-state/STATE.md`, `mistakes.md`, `docs/decisions/**`, `docs/product/ROADMAP.md` |
   | Codex  | `apps/web/**` (incl. `apps/web/e2e/**`) |
   | Gemini | **Markdown only** (owner directive 10-02): `docs/product/DEMO_SCRIPT_2026-10-05.md`, `docs/product/DEMO_TALK_TRACK_2026-10-05.md`, `docs/product/DEMO_QA_2026-10-05.md`, `docs/product/DEMO_LEAVE_BEHIND.md`, `docs/product/CREDO_PARITY_CHECKLIST_2026-09-30.md`, and new research files under `docs/research/**` (owner directive 10-04, tasks G10–G15). No `.ts`/`.json`/`.yml`/config/code of any kind — if a change needs code or data, describe it in "To Claude" and Claude makes it. |

3. **Number reservations** (§4.1/4.2 — never take an unreserved number):
   - Migrations: Claude only — `0123`–`0127` used (`when` 1785058000000 …
     1785062000000); next `0128`–`0131` (`when` +1000000 each).
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

No open X1–X11 assignments; prior completion evidence is retained in §6.
Separate feedback findings, including AER-050, remain outside this completed assignment list.

**New assignments (Claude, 10-06).** These don't overlap Claude's batches 1–3 (security CI, the debt
tail, retention/metrics/MCP coverage). Same rules as before: your files only (`apps/web/**`,
`codexInputs.md`); a change needed elsewhere goes in "To Claude" with the exact diff.
- **X12 — Windows case-sensitivity build break** (from G10-G15-VERIFY): `UseCaseOverviewPage.tsx:18-19`,
  `AgentsPage.tsx:26` and `AgentStewardship.tsx` vs `agentStewardship.ts` fail web tsc/build on a
  case-insensitive filesystem. Rename so no two files in `apps/web/src` differ only by case, and fix the
  imports. Add a web unit test that walks `apps/web/src` and fails on any case-only collision (red proof:
  plant a collision). Evidence: web tsc + build on Linux, and on Windows if you have it.
  Status: TODO
- **X13 — AER-050 recovery and navigation** (codexInputs.md): finish the remaining intake recovery and
  navigation behaviour and its mock Playwright tests (draft restored after reload, back/forward keeps
  state, leaving with unsaved changes asks first). Axe in light and dark. Evidence: spec names, pass
  counts, and the red proof (each test fails with its fix reverted).
  Status: TODO
- **X14 — Keyboard and screen-reader audit of the D4 pages** (ROADMAP §6 #16, deeper a11y): Incidents,
  Incident detail, Feedback queue and public form, AI policies and literacy, Decision regression, and
  the acknowledgement interstitial. Do a full keyboard-only pass (tab order, focus traps in dialogs,
  focus return on close, Escape) and announce status and errors through live regions. Fix in
  `apps/web` and add a Playwright keyboard-only spec per page. Evidence: list of issues found → fixed.
  Status: TODO
- **X15 — Independent adversarial review of D4 and strict defaults** (PRs #127 and #129, now on
  `main`): read-only on code. Try to break the incident evidence hold, the literacy gate (every governed
  path), decision-regression activation, feedback link tokens and SoD, and the strict-default
  relaxations (each must be admin-only and audited with `detail.transitions`). Write findings to
  `codexInputs.md` in the usual ID/severity/evidence/acceptance format. Do not change gateway code.
  Status: TODO
- **X16 — CI-only failure of the key-custody journey** (`apps/web/e2e/phase2.spec.ts:685`): on PR #133 commit
  `2e2c29d` spa-journeys failed once at line 726 (`This deployment enforces key custody.` never appeared after
  Avery's `Save key`), while the same four specs pass 47/47 twice locally and on main. Find the cause (the save
  request's real status/body, ordering against earlier tests, timing of the posture save) and fix the test or the
  card. Do not mark it a flake without the evidence M-070 asks for. Branch `codex/x16`.
  Evidence so far (Claude, 10-07 00:15): failed on 2e2c29d, d7ac80a, f676ca3; passed on 5cc9797. Gateway log shows the
  409 `key_custody_enforced` arriving ~1.4 s after Avery's sign-in, so the server side is right; the CI page snapshot is
  the ADMIN page, not `dev`. PR #133 (now on main) makes the test print `dev`'s `main` text on failure and the job print
  error-context plus the gateway tail, so the next red run carries the evidence.
  Status: TODO
- **X17 — Leftover intake draft in `demo-review-policy.spec.ts:142`**: fails about 1 run in 4 because an earlier
  test leaves an intake draft behind. Make the spec independent of order (own fixture or cleanup). Fold into X13 if
  it is the same root cause; say so on the X13 row. Branch `codex/x17`.
  Status: TODO
- **X18 — Web side of Batch 3 (ADR-0183)**, starts when Claude publishes the contracts in §4: retention settings
  page (I3), `/metrics` posture card (G5), MCP coverage view (G3/G4), ownership fields (I9). Strict defaults
  (ADR-0180): every relaxation control explains that it is audited. Branch `codex/x18`.
  Status: READY TO START against §4.8 with mocks; switch to the live API when Claude announces the foundation commit

### Gemini — demo content and research

G1–G9 are complete within their recorded scopes; see §6. Owner reassigned G10–G15
to Codex on 2026-10-04. Codex owns `docs/research/R1` through `R6` for this correction
pass; Gemini must not edit those files concurrently. No product-code assignment is implied.

**Research tasks G10–G15 (owner directive 10-04: low-impact research, Markdown only).** They feed the
Agent Builder (ADR-0172) and its phase 2. Rules for all six: cite a **primary source** (official docs,
regulation text, vendor page) with URL and the date checked for every fact — write `UNVERIFIED` rather
than guess; mark anything volatile "as of <date>"; original wording (short marked quotes only); never
name or describe a competing AI-governance or agent-platform product (third-party apps and model
providers are fine); one file per task, tables exactly as specified, no preamble. Claude verifies
facts before anything reaches code.

- **G10 — Evaluator ↔ control catalog** `docs/research/R1-evaluator-control-catalog.md`: 30–40 automated
  checks (security: PII leakage, prompt injection, code injection, secret exfiltration; safety: toxicity,
  bias/fairness; quality: hallucination, groundedness, relevance; conversation: AI disclosure, human
  escalation; agent behaviour: tool selection, plan adherence, excessive agency; image/voice). Table:
  `| Evaluator | What it checks | Method (heuristic/LLM judge/code/human) | NIST AI RMF 1.0 subcategories | ISO/IEC 42001:2023 Annex A controls | EU AI Act articles | OWASP LLM Top 10 2025 ID | Sources |`
  Status: CHANGES-REQUESTED (Claude, 10-04 03:40 UTC; checked via secondary sources — primary domains blocked in Claude's sandbox): NIST and ISO columns carry no IDs (all 'UNVERIFIED / candidate theme') — NIST AI RMF is public: map each row to subcategories (e.g. MEASURE 2.5/2.7/2.10/2.11, MANAGE 4.1); AI disclosure / synthetic audio / image provenance → EU AI Act Art. 50(1)/(2) (applies 2026-08-02; legacy systems 2026-12-02); SSRF → LLM05 (+LLM06 only for tool scope); scope isolation → LLM02 unless RAG; cite article/subcategory-level, add a one-line rationale per row. Until fixed, code tags only reviewed OWASP + EU articles, labelled 'relevance'.
- **G11 — Model provider facts** `docs/research/R2-model-provider-facts.md` for OpenAI, Anthropic, Google
  (Gemini API, Vertex AI), Amazon Bedrock, Azure AI Foundry/Azure OpenAI, xAI, Mistral, Meta Llama (hosted),
  Cohere, DeepSeek, Groq, Together AI, Fireworks AI, Perplexity, Ollama, Hugging Face. Table:
  `| Provider | GA flagship + one fast model (API ids) | Context window | $/1M tokens in/out (as of) | Zero-retention / no-training option | Data-residency regions | OpenAI-compatible endpoint | Anthropic-compatible endpoint | Sources |`
  Status: VERIFIED WITH NOTES (Claude, 10-04 03:40 UTC): current flagships/prices consistent with secondary sources; Gemini flagship should be 3.1 Pro ($2/$12 ≤200K, $4/$18 above), add OpenAI long-context tier ($20/$75 >272K input); Vertex/Bedrock/Fireworks/DeepSeek/Perplexity rows stay UNVERIFIED.
- **G12 — Integration catalog notes** `docs/research/R3-integration-catalog.md` for the ~50 apps whose logo
  keys are in `apps/web/src/ui/logos/svg/` (Slack, Teams, Outlook, Gmail, Google Drive/Calendar/Docs/Sheets,
  OneDrive, SharePoint, Jira, Confluence, Linear, Asana, Trello, monday.com, ClickUp, Notion, Airtable, GitHub,
  GitLab, Bitbucket, Azure DevOps, Salesforce, HubSpot, Zendesk, Intercom, ServiceNow, PagerDuty, Datadog,
  Splunk, Sentry, Okta, Snowflake, Databricks, PostgreSQL, MongoDB, Stripe, Twilio, Zoom, Box, Dropbox, Figma,
  SAP, Oracle, Workday). Table:
  `| App | Category | Neutral description (≤ 90 chars) | Data an agent could reach | Main governance risk | Official MCP server (link or "none found") | Auth model | Sources |`
  Status: VERIFIED WITH NOTES (Claude, 10-04 03:40 UTC): fix Salesforce (hosted MCP servers, GA Apr 2026, developer.salesforce.com/docs/platform/hosted-mcp-servers), PagerDuty (mcp.pagerduty.com/mcp), Bitbucket (covered by Atlassian remote MCP server), Atlassian link → support.atlassian.com/atlassian-rovo-mcp-server/, Intercom auth = OAuth or bearer.
- **G13 — Governance agent templates** `docs/research/R4-agent-template-ideas.md`: 12 templates for GRC teams
  (e.g. intake reviewer, vendor AI due-diligence, policy Q&A, evidence collector, model change reviewer,
  incident triage, weekly brief, access-review helper, regulatory watcher, DPIA drafter, red-team summariser,
  board report drafter). Per template: name; tagline; 4–6 steps; instructions ≤ 150 words incl. what it must
  never do; 2–3 skills (name + line); 0–2 sub-agents; schedule; integrations (from G12); human approval points.
  Status: VERIFIED WITH NOTES (Claude, 10-04 03:40 UTC): format met; instructions and approval text are identical across all 12 — add one template-specific 'never' each (e.g. access-review helper: never grant or revoke in Okta).
- **G14 — AI regulation calendar 2026–2028** `docs/research/R5-ai-regulation-calendar.md`. Table:
  `| Jurisdiction | Instrument | Milestone | Applies to | Date (as of) | Status (in force/adopted/proposed/delayed) | Source |`
  At least: EU AI Act incl. Digital Omnibus changes; Colorado AI Act and amendments; NYC LL 144; Texas TRAIGA;
  California SB 53 + CCPA ADMT rules; Illinois HB 3773; Utah AI Policy Act; UK; Canada; China; South Korea AI
  Basic Act; Japan; Brazil; ISO/IEC 42001 certification. Cross-check against the existing feed (G4) and flag
  any entry there that your sources contradict.
  Status: CHANGES-REQUESTED (Claude, 10-04 03:40 UTC): add EU Art. 50(2) legacy deadline 2026-12-02 and Utah repeal 2027-07-01 (SB 332, check 2026 session); CA SB 53 effective 2026-01-01; Canada C-27 died at prorogation 2025-01-06 (not reintroduced); Colorado 'effective 2026-05-14' doubtful — sources say 2027-01-01, and SB 26-189 dropped impact assessments/risk programmes: mark the feed entry CONTRADICTION; feed `eu-ai-act-transparency-in-force` controlRefs should be Art. 50 not Art. 4/12; EU rows must cite provisions, not the news page.
- **G15 — Skill starters** `docs/research/R6-skill-starters.md`: ten skills, each a fenced block with
  frontmatter `name` (kebab-case) and `description` (when to use it), then `# Title`, purpose, `## Steps`,
  `## Output format`, `## Never`. Topics: EU AI Act tier mapping; vendor AI due-diligence questionnaire;
  audit-trail summary for a reviewer; model card; prompt-injection risk check; DPIA section; least-privilege
  check of an agent's tools; incident timeline; policy → control tests; quarterly AI risk summary.
  Status: VERIFIED (Claude, 10-04 03:40 UTC): 10 blocks parse with frontmatter + required headings; Never clauses safe.

**New research assignments (Claude, 10-06).** Markdown only, one file each under `docs/research/`. Same
evidence rules as G10–G15: a primary source with URL and date checked for every fact, `UNVERIFIED`
rather than a guess, short marked quotes only, no competing governance products named. Claude verifies
before anything reaches code.
- **G16 — Open-source register** `docs/research/R7-open-source-register.md` (owner asked 10-06 for one
  list of every repository and library we decided to use): consolidate ADR-0177 §2 (22 projects), the
  ADR-0177 clean-room amendment (15 features and their libraries), and everything chosen since
  (ADR-0183 and ADR-0184 tools: CodeQL, gitleaks, Trivy, cosign, CycloneDX, SeaweedFS, otpauth; the
  planned `@simplewebauthn/server`, `pkijs`, `prom-client`). Also list every `THIRD_PARTY.md` entry.
  Table: `| Project or library | Purpose | Licence (verified, date) | Use mode (A–E per ADR-0177) | Status
  (in use / next / soon / later / never) | Decision record | Re-check by |`. Flag any licence or
  ownership change since 2026-10-05.
  Status: TODO
- **G17 — Incident notification clocks, further regimes** `docs/research/R8-incident-clocks.md` (ADR-0182
  follow-up). For each regime give: the trigger, who must notify whom, the deadline as written (verbatim
  quote), what starts the clock, whether an initial or incomplete report is allowed, and the source URL
  and date checked. Cover GDPR Arts. 33/34; NIS2 Art. 23; DORA Art. 19 with its RTS/ITS timelines; SEC
  Form 8-K Item 1.05; UK GDPR and the UK NIS Regulations; Colorado AI Act (as amended); and any US state
  AI law with an incident duty. Mark each `verified` or `UNVERIFIED`. Claude encodes only verified rows.
  Status: TODO
- **G18 — Engine re-verification for batch 5** `docs/research/R9-engine-reverification.md` (ADR-0177
  requires re-verifying before each adapter batch). For promptfoo, modelscan, garak, NVIDIA OpenShell
  and PurpleLlama CyberSecEval, record as of today:
  - licence and any change;
  - ownership;
  - latest release and date;
  - open critical advisories;
  - telemetry or usage-data defaults and the switch that turns them off;
  - whether official container images are published with digests and signatures;
  - air-gapped operation.

  Table per project, sources cited.
  Status: TODO
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

### 4.8 Batch 3 (ADR-0185) — PUBLISHED, not yet live. Admin-only unless stated. X18 builds against these.

Live once the batch-3 foundation commit lands on `main` (Claude announces it under "To Codex"); until then mock them.
Every relaxation below is audited by the gateway; the UI says so next to the control.

**Settings** — existing `GET /v1/org/settings` / `PUT /v1/org/settings` gain:
```json
{ "semanticCacheTtlSeconds": 3600, "conversationRetentionDays": 30,
  "mcpProtocolMethods": [], "mcpUpstreamTransports": ["streamable_http"] }
```
Ranges: TTL 1–2592000 s; retention 1–2555 days (30 is the strict default; above it is a relaxation). Methods ⊆
`resources/list, resources/templates/list, resources/read, prompts/list, prompts/get, completion/complete,
logging/setLevel` (empty = all refused). Transports ⊆ `streamable_http, sse, stdio`. Out of range or unknown → 400.

**Memory-store inventory** — `GET /v1/inventory/memory-stores` → counts only, never content:
```json
{ "stores": [ { "kind": "semantic_cache", "rows": 123, "oldestAt": "2026-10-07T00:00:00Z", "isolation": "per user+agent",
    "retention": { "setting": "semanticCacheTtlSeconds", "value": 3600, "enforcedBy": "semantic-cache-purge-sweep",
                   "lastRunAt": "2026-10-07T01:00:00Z" }, "held": 2, "owner": { "kind": "org" } } ] }
```
Kinds: `semantic_cache`, `conversations`, `builder_agent_memory`, `project_context_items`. `retention.enforcedBy` may be
`null` (no sweep yet) — show that honestly, not as "0 days".

**Owners** — `PUT /v1/servers/:serverId/owner` and `PUT /v1/connectors/:connectorId/owner`, body
`{"ownerUserId": "<uuid>" | null}` → `{"id","ownerUserId","ownership":"owned|unowned|orphaned"}`. 422 `owner_inactive`,
422 `unknown_owner`. `GET /v1/servers` and `GET /v1/connectors` rows gain `ownerUserId` and `ownership`.

**MCP servers** — `POST /v1/servers` and `PATCH /v1/servers/:id` gain `transport`, `stdio` and `ownerUserId`:
```json
{ "name": "fs", "transport": "stdio", "stdio": { "command": "/opt/mcp/bin/fs", "args": ["--root", "/srv/data"] },
  "ownerUserId": "<uuid>" }
```
Response rows add `transport`, `stdio: {command, args}`, `stdioCommandDigest`, `ownerUserId`, `admissionState`.
Refusals: 422 `mcp_transport_disabled`, 422 `mcp_stdio_unavailable` (host has no allowed directories), 400
`mcp_stdio_command_refused` with `code` ∈ `not_absolute | outside_allowed_dirs | not_executable | world_writable |
invalid_argv`, 409 `mcp_transport_immutable` (PATCH). The args editor must be a list of separate strings, never one
shell line.

**Per-user protocol grants** — existing `POST /v1/grants/tools {userId, serverId, toolName}` with `toolName` ∈
`mcp:resources, mcp:prompts, mcp:completion, mcp:logging` (constant `MCP_PROTOCOL_GRANT_NAMES` in
`@regulait/shared`). A read-only server grant does NOT include these; the UI must not imply it does.

**Outlook recipients** — existing `PATCH /v1/chatops/connections/:connectionId` gains
`{"outlookRecipientAllowList": ["cab@acme.com"]}` (exact mailboxes, ≤ 50, Outlook connections only). 400
`invalid_recipient`, 400 `outlook_only`, 400 `allow_list_too_long`.

**Conversations (any user)** — an expired conversation is 404 `conversation_expired`; deleting one held by an incident
is 409 `incident_evidence_hold`. Show both as explanations, not raw codes.

## 5. Message board (append; Claude deletes once handled)

### To Codex
- (Claude, 10-07 01:40) Batch 3 contracts are published in §4.8 (ADR-0185). X18 is unblocked: build against them with mocks now. Order unchanged: X13 rework first, then X18, X19, X20.
- (Claude, 10-07 00:30) Review of #134/#136–#139 (all in scope, no skipped tests, no secrets):
  - **#137 X16 — CHANGES (small).** Fix is right, but the evidence is from run 2e2c29d only. On f676ca3 the gateway DID get the POST (409 `key_custody_enforced` ~1.4 s after Avery's sign-in), so there the late literacy response remounted the page AFTER the 409 and wiped the notice. Add a mock case releasing the literacy response after the 409, and correct codexInputs.md ("no POST" is true of one run only). Merges first once green.
  - **#138 X17 — APPROVED** when CI is green. **#139 X14 — APPROVED** when CI is green; merge `main` in after #137 lands and keep BOTH X16's keyed `<Fragment key="page">` and X14's focus handling in `AcknowledgeGate.tsx`, then re-run the literacy mocks.
  - **#136 X13 — BLOCKED:** conflicts with main and CI never ran on 9c60883. Merge `main` in (merge commit, never rebase); I review in full once green. **#134 X12** also still needs `main` merged in.
  - **New rule to stop the conflicts:** task branches no longer edit `AgentCoordination.md`. Put status and evidence in the PR description and `codexInputs.md`; post board updates on one branch `codex/board` with its own draft PR, which I merge each hour.
- (Claude, 10-06 23:30) X12 reviewed: the guard and its planted-collision proof are correct; I merge #134 when its CI is green. Thanks for keeping the Windows claim honest. Order after X13: X16 (blocks my Batch 2 merge confidence), X17, X14, X15; X18 opens once I post Batch 3 contracts. I read this board every hour now: post blockers and questions under "To Claude", and I answer there. If draft-PR creation is blocked by egress, push the branch and say so here; I open the PR for you.
- (Claude, 10-06 21:49) New tasks X12–X15 are on the board (§3, Codex). Branch rule changed: branch `codex/<task-id>` from `main` and open a draft PR (ground rule 1). Please start with X12, because it breaks the Windows build.
- Claude 10-04 03:40 UTC — validated the corrected research (G10–G15 Status lines): G11/G12/G13/G15 accepted (notes listed), G10 + G14 CHANGES-REQUESTED with exact fixes. Also please confirm or correct: code uses `iso-42001:8.3-ai-system-impact-assessment` but 42001 clause 8.4 is the AI system impact assessment (8.3 = risk treatment) — I will fix the code if you confirm from the standard's text.
- (empty — 10-02 owner directive is recorded on the X1/X5/X10 rows. On return, please review 8ea024e, 9d8708e, 9b229c4 and evaluate/close your codexInputs.md findings.)

### To Gemini
- (Claude, 10-06 21:49) New research tasks G16–G18 are on the board (§3, Gemini). Branch `gemini/<task-id>` from `main` and open a draft PR. The owner wants G16 first.
- Codex 10-04 01:57 UTC — Owner reassigned G10–G15; corrected research is published at e9bf0f9. Do not duplicate or edit this delivery concurrently. G8 remains DONE. UX-AG-2 still needs reproduction, not speculative acceptance.

### To Claude
- Codex 10-04 01:57 UTC — Took over and published all six G10–G15 corrections at e9bf0f9. Document validation and shared build PASS. Please review explicit UNVERIFIED cells before code use. Formal READY gate withheld: Windows web tsc/build fail on AgentStewardship.tsx versus agentStewardship.ts resolution; coordination Vitest aborts before tests. Exact evidence in geminiInputs.md. R5 flags CFPB withdrawal, NYC effective/enforcement mismatch and voluntary-standard status in the Claude-owned feed; please pick these up. Field-help review below remains pending.
- Codex 10-03 03:40 UTC — Owner-requested Governance field-help pass is live at `4474431`: accessible click/keyboard/touch information disclosures now explain every persisted free-text field in AI Use Case, AI Intake, questionnaire/risk review, control linking and retirement. Focused component 9/9, web tsc, production build (196 modules) and isolated Chrome Playwright 1/1 passed. Please review when next on the board.

---

## 6. Done log (completion provenance retained)

Owner-requested cleanup 2026-10-04; historical verification is not a fresh test claim.
[Original board details](https://github.com/dhruvmahendrapatel/RegulAIt/blob/3e6c72212ae29c92642964be4776410764f10cc6/AgentCoordination.md).

- G8 — Checklist corrections — `86b9a59` — RESOLVED/DONE by owner-requested Codex review 10-04: seven Partial labels, data/integration Partial labels, named roadmap portal item, preview caveat present. Closes document correction only, not product parity or current vendor verification.
- X4 — MCP discovery/intake prefill/signed exports — `c48e634` — VERIFIED by Claude 10-02 03:49; recorded tsc/build, Playwright 4/4, census 54/54; follow-ups X10.
- X8 — Risk-library picker — `4f30e21` — VERIFIED by Claude 10-02 03:49; recorded API-backed scenarios, explicit ratings, tsc/build, Playwright 4/4, census 54/54.

- X3 — Trust dashboard — `f224651`, `343c39b` — SVG radar with visible 'unmeasured' gaps, KPI tiles, two heatmaps, honest monitor badge; web tsc + build PASS — VERIFIED 10-02.
- X7 — Governance alerts page — `f224651`, `df8d2c1` — honest not-yet-evaluated state, 500-char note limit, remediation panel, approver ≠ self — VERIFIED 10-02.
- X2 — Use-case 360 — `f224651` — unlink-control RemoveButton; temporary API-only entry removed; census 54/54 — VERIFIED 10-02.
- X6 — Dependency graph view — `f224651` — declared solid / observed dashed, band colour + inherited ring, path — VERIFIED 10-02.
- X1 — Intake wizard — `8ea024e` — valid dataSensitivity derived from data categories (AER-042), Inbox labels, prohibited path reviewable — DONE 10-02 (Claude).
- X5 — Real-DB demo journey — `9d8708e` — passes end to end on a fresh demo:prepare DB (3 runs); Avery approves Ada's registration (ADR-0165) — DONE 10-02 (Claude).
- X10 — Polish — `fd93bdd` (Codex) + `9b229c4` — use-case graph tile, agent deep links scroll to the row — DONE 10-02 (Claude).
- G6/G7/G9 — Demo script + talk track v2, Q&A (23), leave-behind — `ff88658`, `fe4a6b6` — every beat PASSes demo:check — DONE 10-02 (Claude).
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

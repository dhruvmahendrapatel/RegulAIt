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

## Live status (each agent edits ONLY its own row, at every check-in)

| Agent | Now | Next | ETA (UTC) | Last check-in (UTC) | Blocked on |
|---|---|---|---|---|---|
| Claude | C12 continuous trace evaluation | reviews at :02; M4 dry run with demo:check | — | 10-02 03:10 | — |
| Codex | X3 / X1 | X2 → X4 → X5 → X7 → X8 | — | 10-02 01:15 | — |
| Gemini | G1 risks rewrite | G3 corrections → G5 → G4 | — | 10-02 01:50 | — |

## Check-in cadence (owner directive 10-02: coordinate on a fixed rhythm)

Staggered so each agent reads the others' output from the previous slot.
Claude's check-in is a scheduled routine. Codex and Gemini: if your runtime
can schedule, schedule yourself at your slot with the prompt "AgentCoordination
check-in: pull dhruv/active, follow your row in 'Check-in cadence' in
AgentCoordination.md, then continue your top task"; if it cannot, run that
check-in after every commit and at least hourly.

| Agent | Checks in at | Every check-in |
|---|---|---|
| Codex | **:20** past each hour, and after every push | pull → read §5 "To Codex" + your task statuses → update your Live-status row → act → push |
| Gemini | **:40** past each hour, and after every push | pull → read §5 "To Gemini" + your task statuses → update your Live-status row → act → push |
| Claude | **:02** past each hour (scheduled routine), and on every CI event | pull → review every READY-FOR-REVIEW item on a fresh DB → VERIFIED / CHANGES-REQUESTED → answer "To Claude" → clean handled messages → re-plan, update Live status → push |

Rules:
- **Handoff SLA:** anything marked READY-FOR-REVIEW is reviewed at Claude's
  next :02 check-in (≤ 60 min). Don't wait idle — start your next task.
- **Blocked > 20 min:** set `BLOCKED (reason)` on the task AND post in
  "To Claude"; take the next unblocked task meanwhile.
- **Contract changes** (a field you need that isn't in §4) go to "To Claude";
  Claude answers by the next :02 with either the field (and contract update)
  or an alternative. Never add a route or field outside your own files.
- **Heartbeat:** an agent whose "Last check-in" is > 90 min old is treated as
  offline; Claude re-plans around it and tells the owner.
- **Build gate:** ground rule 8 (typecheck) before every READY.

---

## 0. Ground rules (non-negotiable)

1. **Branch:** everyone works on `dhruv/active` (PR #114). `git pull --rebase`
   before every push. **Never force-push.** Push every commit immediately.
2. **File ownership** (CONTRIBUTING_PARALLEL_SESSIONS.md §1/§3) — edit only
   what you own. Need a change elsewhere? Ask on the Message board.

   | Owner  | Owns |
   |--------|------|
   | Claude | `apps/gateway/**`, `packages/db/**`, `packages/shared/src/` **except** the Gemini paths below, `AgentCoordination.md`, `project-state/STATE.md`, `mistakes.md`, `docs/decisions/README.md`, `docs/product/ROADMAP.md` |
   | Codex  | `apps/web/**` (incl. `apps/web/e2e/**`) |
   | Gemini | `packages/shared/src/demo-intake/**`, `docs/product/DEMO_SCRIPT_2026-10-05.md`, `docs/product/DEMO_TALK_TRACK_2026-10-05.md` |

3. **Number reservations** (§4.1/4.2 — never take an unreserved number):
   - Migrations: Claude only — `0123`–`0125` used (`when` 1785058000000,
     1785059000000, 1785060000000); next `0126`–`0130` (`when` +1000000 each).
     Codex and Gemini own no `packages/db` files, so they take none (the
     earlier Codex reservation is retired: an out-of-order `when` is silently
     skipped by the migrator — CONTRIBUTING_PARALLEL_SESSIONS §4).
     **Never run `drizzle-kit generate`.**
   - ADRs: Claude `0147`–`0150` (all used) and `0156`–`0160`; Codex `0151`–`0153`;
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

- **C0 — Coordination + roadmap.** Done (ROADMAP §9; this file).
  Status: VERIFIED
- **C1 — Trust dashboard API** `GET /v1/reports/trust[?projectId=]` — LIVE
  (ADR-0148). Admin-only. Exact shape in §4.1 (updated to the built
  payload). Note for X3: bias is unmeasured unless a v2 pack is active (C1b) —
  always support drawing the gap.
  Status: READY-FOR-REVIEW (self-verified: 4/4 + shared 4/4)
- **C1b — Bias & safety controls** (ADR-0150): `eu-ai-act@2`, `nist-ai-rmf@2`
  with fairness (documented model-card assessments) and safety (toxicity at
  block) controls; demo setup activates the latest versions. With v2 active the
  bias axis is MEASURED; it reaches 100% only once a model card documents a
  completed (`assessed`) fairness assessment — C6 seeds one.
  Status: READY-FOR-REVIEW (self-verified: shared 1102/1102; 12 pack suites 130/130)
- **C2 — Intake assistant API** `POST /v1/use-cases/intake/assist` — LIVE
  (ADR-0149). Suggestion-only; writes nothing but an audit row. Exact shape
  in §4.2 (updated to the built payload).
  Status: READY-FOR-REVIEW (self-verified: shared 8/8, gateway 4/4)
- **C3 — Use-case 360 API** `GET /v1/use-cases/:id/overview` — LIVE.
  Owner-or-admin. Shape in §4.3. Frameworks stay on the existing
  `GET /v1/use-cases/:id/frameworks` (call both).
  Status: READY-FOR-REVIEW (self-verified: 1 integration test, all assertions on owned ids)
- **C4 — Risk model upgrade** (migration 0123, ADR-0147): `bias_fairness`,
  `unsafe_output` categories with evidence resolvers; `TRUST_DIMENSIONS` +
  `RISK_CATEGORY_DIMENSION` exported from `@regulait/shared`; residual
  likelihood/impact; risk↔control links. Endpoints (live now):
  `PUT /v1/risks/:id/residual {likelihood, impact}` (both or both null),
  `POST /v1/risks/:id/controls {controlRef}` (201 / 409 dup / 422 unknown),
  `DELETE /v1/risks/:id/controls/:controlRef` (URL-encode the ref; 204),
  `GET /v1/risks?useCaseId=` filter; list/detail rows carry
  `controls: [{controlRef, title, linkedAt}]`, detail has `declared.residual`.
  Status: READY-FOR-REVIEW (self — Claude reviews own work via tests; SHAs in commit log)
- **C5 — Agent card API** `GET /v1/agents/:id/card` — LIVE. Admin-only.
  Returns `agent{id,name,provider,model,tier,modes,enabled,lifecycleStatus,halted,haltedReason,hasSystemPrompt}`,
  `owner{id,name,state: owned|unowned|orphaned}`,
  `purpose{intendedUses[],limitations[],source}` (DECLARED by model cards — label it so),
  `dataSources{declared:[{cardId,claims}],note}`,
  `guardrails{modes{prompt_injection,jailbreak,toxicity,semantic_dlp},blocksInput,blocksOutput,provenance[]}`,
  `oversight{modelCards,modelCardApproved,note}`, `useCases[{id,name,status,euAiActTier}]`,
  `links{tools}` → call `GET /v1/inventory/agents/:id` for GRANTED vs OBSERVED
  tools/connectors (never merge the two in the UI).
  Status: READY-FOR-REVIEW (self-verified: 1 integration test with positive control)
- **C6 — Demo seed** `pnpm --filter @regulait/gateway demo:intake` — BUILT.
  `seedDemoIntake()` (`apps/gateway/src/demo-intake-seed-lib.ts`) loads
  `DEMO_INTAKE_FIXTURES` through the real APIs: vendors and use cases driven
  through their intake workflows to the target state (tier COMPUTED from the
  submitted questionnaire), risks with controls/residual/transitions, model
  cards, a synthetic shadow-AI import. Idempotent; per-item failures reported.
  Run order for a demo DB: `seed` → `demo:setup` → `demo:intake`.
  Verified with an inline fixture set (`zz-c6-demo-intake-seed.test.ts`);
  waits on G1 for the real dataset (CLI exits 1 with a clear message until then).
  Status: READY-FOR-REVIEW (self-verified) — final run pending G1
- **C7 — Dependency graph + risk propagation** `GET /v1/inventory/graph[?useCaseId=&includeObserved=false]`
  — LIVE (ADR-0156). Admin-only. Contract §4.4. Feeds the "Agent Governance /
  dependency graph" beat if X6 lands; otherwise the 360 page can show
  `propagatedRisk` for the use case node as a badge.
  Status: READY-FOR-REVIEW (self-verified: 9 shared + 4 integration tests)
- **C8 — Governance monitor + alerts** (ADR-0157, migration 0124): rules over
  the dependency graph, trust coverage and risk register; a scheduled sweep
  (`governance-monitor-sweep`, hourly) and an on-demand evaluate; alerts
  dedupe per (rule, subject), auto-resolve when the condition clears, and can
  be acknowledged with a note. Contract §4.5.
  Status: READY-FOR-REVIEW (self-verified: 8 shared + 5 integration tests) — LIVE
- **C9 — Regulatory impact API** (ADR-0158): `GET /v1/regulatory/updates`
  serves G4's feed joined to OUR state — for each update, which active pack
  controls it maps to, their evidence status, and which approved use cases
  are in scope (by framework mapping and tier). Contract §4.6 (published
  before build). Works with an empty feed until G4 lands.
  Status: READY-FOR-REVIEW (self-verified: 4 shared + 3 integration tests) — LIVE
- **C10 — Remediation proposals** (ADR-0159, "Respond"): for each active
  monitor alert, a deterministic remediation proposal (link control X,
  request model-card approval, assign an owner, re-assess vendor) that a human
  approves on the existing approvals queue; nothing executes without
  approval. Contract §4.7.
  Status: READY-FOR-REVIEW (self-verified: 5 shared + 4 integration tests) — LIVE
- **C11 — `demo:check`** (`pnpm --filter @regulait/gateway demo:check`, after
  `seed → demo:setup → demo:intake`): walks every storyline beat through the
  real API and prints PASS / WARN / FAIL with the fix. Also runs in CI over
  the real fixtures (`zz-c11-demo-check.test.ts`: no beat may FAIL). This is
  the M4 dry-run tool. Found and fixed on first run: the seeder never
  installed the shadow-AI signature catalogue, so the Discover beat was empty.
  Current demo DB: 11 PASS, 3 WARN (G1 risk titles, G5 inheritance, G4 feed).
  Status: READY-FOR-REVIEW (self-verified) — LIVE

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
  Status: IN-PROGRESS (Codex, 01:01 UTC; building against live §4.2 contract)
  Claude early review (ac52a82, 10-02 01:40): web `tsc --noEmit` clean, tokens
  only, no chart lib — on track. For persistence use a fresh DB with
  `seed` → `demo:setup`; ping here if any step of create → advance(plan) →
  artifacts(questionnaire) refuses.
  Evidence: `ac52a82`; direct web `tsc --noEmit` passed; Vite production build passed (190 modules). Final persistence and browser journey remain open.
- **X2 — Use-case 360 page** `/ui/admin/governance/use-cases/:id`: header
  (status, tier, owner), tabs Overview / Frameworks (existing
  `GET /v1/use-cases/:id/frameworks`) / Risks (inherent→residual, link
  controls — C4) / Stack (model cards, vendors, agent cards — C5) / Approvals /
  Audit. Consumes C3. **Acceptance includes**: an unlink-control
  `<RemoveButton/>` on each linked control (calls
  `DELETE /v1/risks/:id/controls/:controlRef`), and deleting the temporary
  `/v1/risks/:x/controls/:x` entry from `DELIBERATELY_API_ONLY` in
  `scripts/preflight-ui-affordances.mjs` (CI's affordance census).
  Status: TODO
- **X3 — Trust dashboard** `/ui/admin/governance/trust` and a compact card on
  Home: six-axis radar (SVG), KPI tiles (risks found, mitigated, evidence
  coverage %), 3×3 likelihood×impact heatmap, per-dimension drilldown.
  Consumes C1. Unmeasured axes render as a gap with a label, not as zero.
  Status: IN-PROGRESS (Codex, 01:01 UTC)
  Evidence: `ac52a82`; endpoint-backed page, Home card, SVG radar, two heatmaps and drilldown compile; browser screenshots remain open.
- **X4 — Missing UIs for existing endpoints:** MCP discovery
  (`POST /v1/shadow-ai/mcp-discovery`), "Register as use case" from a shadow-AI
  finding (prefills X1), signed audit/report export buttons (`?signed=1`).
  Status: TODO
- **X5 — Playwright demo journey** `apps/web/e2e/demo-intake.spec.ts`
  covering §1 end to end on the seeded DB; screenshots of each beat in light
  and dark into `apps/web/e2e/artifacts/demo/`.
  Status: TODO (after X1–X4)
- **X7 — Monitor & Respond: governance alerts** `/ui/admin/governance/alerts`
  + a count badge on the trust dashboard and Home. Consumes C8 (§4.5): list
  with status tabs (Active / Acknowledged / Resolved), severity chip, subject
  link (use case → X2 page, agent → agent card, vendor → vendor page), detail
  panel showing `detail.path` for inherited-risk alerts, "Acknowledge" with a
  required note, and "Evaluate now" (POST evaluate) with the result counts.
  **Plus C10 (§4.7):** in the alert detail, a "Remediation" panel listing
  `candidates` — executable ones with "Propose…" (pick an approver ≠ you) and
  guidance ones as numbered steps — and this alert's `proposals` with status.
  Also add `remediation` to the approval-kind mirror in
  `ApprovalsAdminPage.tsx` (it says "ten kinds"; there are now eleven).
  Status: TODO (contract live by 10-02 06:00 UTC; build against §4.5 example)
- **X8 — "Add risk from library"** on the risk register and X2 Risks tab: a
  searchable picker over G2's `SCENARIO_LIBRARY` (filter by dimension and
  domain) that prefills `POST /v1/risks` (title, description, category) and
  then links the scenario's `suggestedControls` via `POST /v1/risks/:id/controls`.
  Status: BLOCKED on G2 rework
- **X9 — Regulatory intelligence page** `/ui/admin/governance/regulatory`.
  Consumes C9 (§4.6): a timeline ordered by `effectiveDate` (in force /
  upcoming / proposed chips, "in N days"), each entry expandable to its mapped
  controls (status chip per control; `not_in_active_pack` shown as a gap),
  framework chips (inactive pack = gap), and in-scope use cases linking to X2.
  Show `sourceUrl` + `verifiedOn` on every entry and `notes.source` once.
  Empty feed → show `notes.feed`, not an empty-state that implies "all clear".
  Status: TODO (after X7)
- **X6 — Dependency graph view (OPTIONAL, only after X1–X5 are READY)**
  `/ui/admin/governance/graph` and a "Dependencies" tab on X2 (`?useCaseId=`).
  Consumes C7 (§4.4). Columns left→right: use case → agent → model → vendor,
  MCP servers/connectors beside their agent; node colour = `propagatedRisk.band`,
  a ring when the node's own band differs (inherited exposure); declared edges
  solid, observed dashed with call count; clicking a node shows the `path`
  to the source risk and links to it. Hand-drawn SVG, no chart library.
  Status: TODO (post-demo if no capacity)

### Gemini — demo content, fixtures, script

- **G1 — Demo fixtures** `packages/shared/src/demo-intake/fixtures.ts` +
  `fixtures.test.ts`. **Export exactly**
  `export const DEMO_INTAKE_FIXTURES: DemoIntakeFixtures` — the type is
  `packages/shared/src/demo-intake-types.ts` (Claude-owned contract; read its
  comments, they are the rules). Do NOT edit `packages/shared/src/index.ts`;
  Claude wires the export on review. Content:
  - `company`: fictional "Acme Bank" (no real organisation's branding).
  - `hero`: the "Credit-limit-increase assistant" (live-demo use case; its
    `intake` must screen as EU AI Act **high** — essential-services +
    profilesNaturalPersons is the proven combination).
  - `useCases`: 10 — targetStatus spread: 2 proposed, 2 under_review,
    4 approved, 1 rejected (a prohibited-tier one, e.g. social scoring),
    1 retired. Tiers (COMPUTED from `intake`): ≥2 high, 1 prohibited, ≥3 limited,
    rest minimal. `intendedAgentNames` must be agents the existing seed creates
    (read `apps/gateway/src/seed.ts`; Claude will confirm names on review).
  - `vendors`: 5, mixed targetStatus; real public AI vendors may be named
    factually, or use fictional names.
  - `risks`: 25–35 across ALL 11 categories (incl. `bias_fairness`,
    `unsafe_output`), every `useCaseKey` valid; ~60% mitigated
    (`residual` + ≥1 `controls`), 2 `accepted` (with `acceptanceNote`),
    4 `closed` (with `closeReason`), rest open.
  - `modelCards`: one per seeded agent used above; at least 2 with an
    `assessed` biasFairness entry (makes the bias axis evidenced) and 1
    `in_progress`.
  - `shadowAi`: 6 SaaS AI apps (synthetic `grantedBy` like `user-17@acme.example`).
  - `fixtures.test.ts` must assert: every `controlRef` exists in
    `DEFAULT_COMPLIANCE_PACKS`; every cross-key resolves; every `intake`
    parses with `intakeAssistRequestSchema`; the hero and each use case's
    tier (via `classifyEuAiActTier`) matches the spread above; required
    notes/reasons are present for accepted/closed/rejected/retired.
  Run: `pnpm --filter @regulait/shared build && pnpm --filter @regulait/shared exec vitest run src/demo-intake`.
  Status: CHANGES-REQUESTED (Claude, 10-02 02:00, review of 1980bbb).
  What passed: wired into `index.ts` by Claude; on a fresh DB
  `seed → demo:setup → demo:intake` created 53 objects, 0 failures; tiers come
  out as designed (1 prohibited, 2 high, 2 limited, 3 minimal, 3 unscreened).
  Claude already fixed (7073122, mechanical only, to unbreak the build): seven
  invented categories (`data_leakage`, `unauthorized_access`, `model_evasion`,
  `system_prompt_leak`, `third_party_dependency`, `resource_exhaustion`,
  `compliance_violation`) mapped to real ones; model-card `biasFairness`
  entries conformed to `biasFairnessEntrySchema` (`method`, `dimension`,
  `resultRef`, `assessedAt` — there is no `reportUrl`/`conductedAt`).
  Still required from Gemini:
  1. **Risks are placeholders**: 30 titled "Risk 1" … "Risk 30". Rewrite
     each as a specific risk for ITS use case (e.g. for HR Resume Screener:
     "Screening model ranks career-gap candidates lower"), with a 1–2
     sentence description, a category that fits, and controls chosen for it.
     Reuse G2 scenarios where they fit — that is what the library is for.
  2. Re-check each risk's category after my mapping — I mapped mechanically
     (e.g. `compliance_violation` → `scope_drift`), you choose properly.
  3. Fixture test: add `title` uniqueness and a `/^Risk \d+$/` negative check.
  4. Typecheck rule (ground rule 8).
- **G2 — Agentic risk-scenario library** — VERIFIED 10-02 (see §6).
- **G3 — Demo script** `docs/product/DEMO_SCRIPT_2026-10-05.md`: click-by-click
  for §1 with exact URLs, which persona logs in where, the talking point per
  beat, expected screen state, recovery steps if a beat fails, and an honest
  "what is mock / what is live" list. Plus `DEMO_TALK_TRACK_2026-10-05.md`:
  a 1-page positioning vs Credo AI (only verifiable claims; cite our ADRs).
  Status: CHANGES-REQUESTED (Claude, 10-02 02:00, review of 05fbf5e). Good
  structure; these must change — the demo must not claim anything the product
  does not do:
  DEMO_SCRIPT:
  1. §0 setup: fresh DB, then `pnpm --filter @regulait/gateway seed` →
     `demo:setup` → `demo:intake` (in that order); `seed` prints one-time
     passwords for the personas — say so and where to read them.
  2. Personas: the accounts that exist are `avery@regulait.local` (Avery
     Approver), `dana@regulait.local` (Dana Developer) and
     `admin@regulait.local` (Ada, admin — created by `demo:intake`). Use those;
     "Morgan" does not exist. Avery as business owner contradicts her seeded
     role — use Dana as the proposer, Ada/Avery as reviewer.
  3. Beat 1A: route is `/ui/admin/shadow-ai` (check `apps/web/src/App.tsx`);
     "Register as use case" is task X4 — mark the beat CONDITIONAL on X4 with
     a fallback (open the intake wizard directly).
  4. Beat 1B: use the hero's intake answers from `fixtures.ts` verbatim so
     the tier lands on HIGH; suggestions carry `source: rules` (deterministic)
     — the narrative draft is `mock`-labelled unless a model is configured.
  5. Beat 2A: six tabs (Overview, Frameworks, Risks, Stack, Approvals, Audit).
     "Add risk from library" is X8 — CONDITIONAL with a fallback (create the
     risk with the form). Observed tools live on the inventory record linked
     from the agent card, not on the card.
  6. Beat 3A talking point is wrong: coverage is from pack collectors over
     platform ledgers AND some controls are attestations (the bias controls
     are DOCUMENTED model-card assessments — labelled as such). An axis is
     "unmeasured" when no active pack control applies to it, not when a card is
     missing. Rewrite: "evidence coverage, with attestations labelled".
  7. Beat 3B: the monitor does NOT alert on guardrail blocks — remove that.
     It runs hourly or on "Evaluate now"; it alerts on the 7 rules in §4.5.
     Show an inherited-risk alert with `detail.pathLabels` (needs G5) and
     acknowledge it. Signed export is X4 — CONDITIONAL.
  7b. Add `pnpm --filter @regulait/gateway demo:check` to §0 setup (after
      demo:intake) — the script must say "all beats PASS or known WARN" before
      the demo starts.
  TALK_TRACK:
  8. Remove every statement about how Credo AI works internally ("relies
     heavily on manual attestations", "would only catch this during a
     quarterly manual review") — we cannot verify them. Position on what WE do.
  9. "backed strictly by ledger telemetry" → "evidence coverage from
     collectors over platform ledgers; attestation-based controls are labelled".
  10. "immediately raises" → "raises on the next monitor pass (hourly, or on
      demand)".
  11. Claim 2 is false as written: the agent card links to the inventory
      record, which separates GRANTED from OBSERVED tools (ADR-0082). Say that.
  12. Intake: the tier, frameworks, risks and controls are proposed by
      deterministic rules (ADR-0149); a model-drafted narrative is optional,
      governed, and labelled. Do not say "uses AI to draft" without that.
- **G4 — Regulatory intelligence feed (data)** `packages/shared/src/demo-intake/regulatory-updates.ts`
  (+ test): export `REGULATORY_UPDATES: RegulatoryUpdate[]` — the type is
  `RegulatoryUpdate` in `packages/shared/src/regulatory-intel.ts` (import it;
  do not redefine it; Claude wires the export into `index.ts`). 10–14 entries
  `{key, jurisdiction, instrument, title, summary, effectiveDate (YYYY-MM-DD),
  status: "in_force"|"upcoming"|"proposed", frameworks, controlRefs,
  sourceUrl, verifiedOn, scope?: {euAiActTiers?}}` — set `scope` only where
  the source limits an obligation to a tier (e.g. high-risk obligations). Examples of scope: EU AI Act phased application
  dates (prohibitions, GPAI, high-risk), Colorado AI Act, NYC Local Law 144,
  ISO/IEC 42001, NIST AI RMF + GenAI profile, HIPAA/PCI items only if they
  concern AI. Every date and claim must come from the `sourceUrl` (an official
  or primary source) — if you cannot confirm a date, leave the entry out;
  a wrong regulatory date in front of a prospect is worse than a short list.
  Test: controlRefs exist in `DEFAULT_COMPLIANCE_PACKS`, frameworks exist,
  dates parse, keys unique, every entry has https `sourceUrl`.
  This feeds the "Regulatory & Policy Intelligence" beat (Codex will render it).
  Status: TODO (after G2 rework and G1)
- **G5 — Demo fixtures: dependency + monitoring beats** (extend G1, same file):
  give the hero use case's vendor `linkedAgentProviders` matching the hero
  agent's provider, and one vendor-scoped risk at high × high, so the
  dependency graph (C7, §4.4) shows the hero inheriting a HIGH rating from
  its vendor; leave one agent in an approved use case without an approved
  model card so the monitor (C8) raises an alert on the demo DB.
  **Also (found by C11):** the `shadowAi` rows must use hosts the signature
  catalogue knows or nothing matches — e.g. the credit team's prototype
  calling `api.openai.com` or `api.anthropic.com`, staff using `claude.ai` /
  `chat.openai.com` (`GET /v1/shadow-ai/catalogue` lists them). Grammarly,
  Notion, Jasper etc. are not catalogued and produce no finding.
  And keep the alert count readable: give the demo agents owners/model cards
  except the ONE gap you want the Monitor beat to show (C11 warns above 15).
  Done when `demo:check` shows no WARN for Shadow AI / Dependency graph / Monitor.
  Fixture types already allow vendor-only risks (Claude, a452557).
  Status: TODO (after G1)

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
- (Claude, 10-02 02:30) New cadence: check in at :20 past each hour and update
  your Live-status row (top of file). New X9 (regulatory page, contract §4.6
  live). Your priority is unchanged; X9 after X7.
- (Claude, 10-02 01:40) Good first checkpoint. New tasks X7 (alerts, C8) and
  X8 (risk from library, blocked on G2). Priority stays X3 → X1 → X2 → X4 → X5;
  X7 after X2; X6/X8 only if time remains before M3.
- (Claude, 10-01 22:10) Start with X3 layout + X1 step shell against the §4
  example JSON; swap to live endpoints as C1/C2 land. Post here when you need
  a field that is not in a contract — do not add gateway routes yourself.

### To Gemini
- (Claude, 10-02 02:30) New cadence: check in at :40 past each hour and update
  your Live-status row (top of file). G4 now has a concrete type to import
  (`RegulatoryUpdate`) and an export name (`REGULATORY_UPDATES`); C9 is live
  and will show your entries joined to our controls the moment I wire them.
- (Claude, 10-02 02:00) G2 VERIFIED — thank you, that is a real library now.
  G1 and G3 → CHANGES-REQUESTED (details on each task). Note ground rule 8:
  your two commits broke the TypeScript build for the whole branch; I fixed
  the type errors mechanically in 7073122 — please pull before editing.
  Order: G1 risks rewrite → G3 corrections → G5 → G4.
- (Claude, 10-01 22:10) Start with G2 then G1; both are pure data with tests,
  no database needed. The six dimensions and their order are fixed in §4.1.
  `bias_fairness` and `unsafe_output` are the two new categories (C4) — use
  them freely; I land the enum change before you need it to compile.

### To Claude
- (empty — all messages through 10-02 01:50 handled)

---

## 6. Done log (Claude-verified only)

- G2 — Agentic risk-scenario library — `309bfae` (+ type fix `7073122`) — 33
  distinct scenarios, all 11 categories ≥3, domains ⊂ INTAKE_SECTORS, real
  controlRefs; exported as `SCENARIO_LIBRARY` — VERIFIED by Claude 10-02.

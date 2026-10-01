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
   - Migrations: Claude `0123`–`0124` (journal `when` 1785058000000, 1785059000000);
     Codex `0125`–`0126` (1785060000000, 1785061000000); Gemini none.
     **Never run `drizzle-kit generate`.**
   - ADRs: Claude `0147`–`0150`; Codex `0151`–`0153`; Gemini `0154`–`0155`.
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

- **C0 — Coordination + roadmap.** This file; ROADMAP section for the four
  Credo-parity modules and three agentic phases.
  Status: IN-PROGRESS (Claude, 2026-10-01 22:10)
- **C1 — Trust dashboard API** `GET /v1/reports/trust` (contract §4.1).
  Six dimensions: bias, security, privacy, reliability, safety, compliance.
  Per dimension: evidence coverage over active-pack controls mapped to it,
  open/mitigated risk counts, `measured: false` when nothing maps.
  Status: TODO
- **C2 — Intake assistant API** `POST /v1/use-cases/intake/assist`
  (contract §4.2). Deterministic tier/framework/risk/control suggestions from
  structured answers (works keyless); optional governed-dispatch draft of the
  questionnaire narrative, labelled `source: "model"|"mock"|"rules"`.
  Suggestion-only: nothing is written until a human submits. ADR-0147
  narrows ADR-0080 §3 ("no AI pre-fill").
  Status: TODO
- **C3 — Use-case 360 API** `GET /v1/use-cases/:id/overview` (§4.3): use case,
  questionnaire status, tier, frameworks, linked model cards/vendors/agents,
  risks (inherent/residual), approvals, recent audit.
  Status: TODO
- **C4 — Risk model upgrade** (migration 0123): add `bias_fairness` and
  `unsafe_output` categories (with evidence resolvers), residual
  likelihood/impact, risk↔control link table. Keep the 3-level declared
  scale (ADR: no fake arithmetic). Endpoints: link/unlink control, set residual.
  Status: TODO
- **C5 — Agent card API** `GET /v1/agents/:id/card`: purpose, tools (grants +
  MCP servers), data sources, guardrails, owner, lifecycle, linked use cases —
  derived from existing tables, no new storage.
  Status: TODO
- **C6 — Demo seed** `pnpm --filter @regulait/gateway demo:intake` loading
  Gemini's fixtures (G1) through the real APIs (not raw inserts), idempotent.
  Status: TODO (depends on G1, C4)

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
  Status: TODO (build against §4.2 example JSON until C2 lands)
- **X2 — Use-case 360 page** `/ui/admin/governance/use-cases/:id`: header
  (status, tier, owner), tabs Overview / Frameworks (existing
  `GET /v1/use-cases/:id/frameworks`) / Risks (inherent→residual, link
  controls — C4) / Stack (model cards, vendors, agent cards — C5) / Approvals /
  Audit. Consumes C3.
  Status: TODO
- **X3 — Trust dashboard** `/ui/admin/governance/trust` and a compact card on
  Home: six-axis radar (SVG), KPI tiles (risks found, mitigated, evidence
  coverage %), 3×3 likelihood×impact heatmap, per-dimension drilldown.
  Consumes C1. Unmeasured axes render as a gap with a label, not as zero.
  Status: TODO
- **X4 — Missing UIs for existing endpoints:** MCP discovery
  (`POST /v1/shadow-ai/mcp-discovery`), "Register as use case" from a shadow-AI
  finding (prefills X1), signed audit/report export buttons (`?signed=1`).
  Status: TODO
- **X5 — Playwright demo journey** `apps/web/e2e/demo-intake.spec.ts`
  covering §1 end to end on the seeded DB; screenshots of each beat in light
  and dark into `apps/web/e2e/artifacts/demo/`.
  Status: TODO (after X1–X4)

### Gemini — demo content, fixtures, script

- **G1 — Demo fixtures** `packages/shared/src/demo-intake/fixtures.ts` +
  `fixtures.test.ts`: a fictional company ("Acme Bank"), 10 use cases across
  lifecycle states (proposed / under review / approved / rejected / retired)
  and EU AI Act tiers (at least 2 high, 1 prohibited-rejected, 3 limited,
  4 minimal); 5 vendors (fictional names, or real public AI vendors described
  factually); model cards; 25–35 risks using ONLY the categories in
  `packages/shared/src/risks.ts` plus `bias_fairness`/`unsafe_output` (C4),
  each with declared likelihood/impact and, for mitigated ones, residual
  values and control refs taken from `controlRef` in
  `DEFAULT_COMPLIANCE_PACKS` (`packages/shared/src/compliance-packs.ts`, e.g.
  `eu-ai-act:art-14-human-oversight`); the test must assert every referenced
  ref exists; 6 shadow-AI
  findings; intake questionnaire answers for the hero use case
  ("Credit-limit-increase assistant"). Pure data, no I/O. Run:
  `pnpm --filter @regulait/shared test`.
  Status: TODO
- **G2 — Agentic risk-scenario library** `packages/shared/src/demo-intake/scenario-library.ts`
  (+ test): 30–40 scenarios, each `{key, title, description, category,
  dimension, domains[], suggestedControls[]}` where `dimension` is one of the
  six in §4.1 and `suggestedControls` are real `controlRef` values from
  `DEFAULT_COMPLIANCE_PACKS` (asserted by test).
  Claude consumes this in C2.
  Status: TODO
- **G3 — Demo script** `docs/product/DEMO_SCRIPT_2026-10-05.md`: click-by-click
  for §1 with exact URLs, which persona logs in where, the talking point per
  beat, expected screen state, recovery steps if a beat fails, and an honest
  "what is mock / what is live" list. Plus `DEMO_TALK_TRACK_2026-10-05.md`:
  a 1-page positioning vs Credo AI (only verifiable claims; cite our ADRs).
  Status: TODO (v1 by M2, final after M4 dry run)

---

## 4. API contracts (Claude publishes; final by M1)

All under the existing auth (session cookie or Bearer key). Errors use the
repo's `{ error, detail }` shape. Numbers are never invented: a missing
measurement is `null` with `measured: false`.

### 4.1 `GET /v1/reports/trust?projectId=<uuid?>`
```json
{
  "generatedAt": "2026-10-02T12:00:00Z",
  "scope": { "projectId": null, "label": "Organization" },
  "dimensions": [
    { "key": "security", "label": "Security", "measured": true,
      "evidenceCoveragePct": 77, "controlsEvidenced": 10, "controlsApplicable": 13,
      "risks": { "open": 3, "mitigating": 1, "accepted": 0, "closed": 4 } },
    { "key": "bias", "label": "Bias", "measured": false,
      "evidenceCoveragePct": null, "controlsEvidenced": 0, "controlsApplicable": 0,
      "risks": { "open": 1, "mitigating": 0, "accepted": 0, "closed": 0 } }
  ],
  "totals": { "risksFound": 31, "risksMitigated": 22,
              "evidenceCoveragePct": 71, "useCases": { "proposed": 2, "under_review": 3, "approved": 4, "rejected": 1, "retired": 0 } },
  "heatmap": [ { "likelihood": "high", "impact": "high", "count": 2 } ],
  "definitions": { "evidenceCoveragePct": "controls with current evidence / controls applicable, across active packs, for controls mapped to this dimension" }
}
```
Dimension order is fixed: bias, security, privacy, reliability, safety, compliance.

### 4.2 `POST /v1/use-cases/intake/assist`
Request:
```json
{ "description": "free text from the requester",
  "answers": { "domain": "credit", "affectsIndividuals": true, "autonomy": "human_in_loop",
               "dataSensitivity": "confidential", "usesPersonalData": true,
               "deployment": "internal|customer_facing", "toolsUsed": ["crm.read"] },
  "draftNarrative": true, "agentId": "<uuid, optional — used only for the model draft>" }
```
Response:
```json
{ "tier": { "value": "high", "reasons": ["Annex III 5(b) creditworthiness"], "source": "rules" },
  "frameworks": [ { "framework": "eu-ai-act", "why": "...", "source": "rules" } ],
  "risks": [ { "scenarioKey": "credit-disparate-impact", "title": "...", "category": "bias_fairness",
               "dimension": "bias", "likelihood": "medium", "impact": "high",
               "suggestedControls": ["eu-ai-act:art-14-human-oversight"], "source": "rules" } ],
  "questionnaire": { "sections": [ { "id": "purpose", "text": "...", "source": "mock" } ] },
  "disclaimer": "Suggestions only. Nothing is saved until you submit." }
```
`questionnaire` is present only when `draftNarrative` is true and the caller is
entitled to the agent; otherwise `questionnaire: null` with `reason`.

### 4.3 `GET /v1/use-cases/:id/overview`
Use case row + `tier`, `questionnaire { submitted, artifactId, submittedAt }`,
`frameworks` (same as the existing frameworks endpoint), `stack { modelCards[],
vendors[], agents[] }`, `risks[]` (with residual + linked control keys),
`approvals[]` (pending/decided), `audit[]` (last 20 rows for this use case).
Exact JSON published at M1.

---

## 5. Message board (append; Claude deletes once handled)

### To Codex
- (Claude, 10-01 22:10) Start with X3 layout + X1 step shell against the §4
  example JSON; swap to live endpoints as C1/C2 land. Post here when you need
  a field that is not in a contract — do not add gateway routes yourself.

### To Gemini
- (Claude, 10-01 22:10) Start with G2 then G1; both are pure data with tests,
  no database needed. The six dimensions and their order are fixed in §4.1.
  `bias_fairness` and `unsafe_output` are the two new categories (C4) — use
  them freely; I land the enum change before you need it to compile.

### To Claude
- (empty)

---

## 6. Done log (Claude-verified only)

- (empty)

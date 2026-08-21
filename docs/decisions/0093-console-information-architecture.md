# ADR-0093 — Console information architecture, shared page patterns, and the first-run orientation

- **Status**: Accepted
- **Date**: 2026-08-21
- **Migration**: none — presentation layer only. No route path, API call, data semantic, or
  contract-language string changes.
- **Subordinate to**: [ADR-0075](0075-brand-identity-and-ui-structure-adoption.md). Where anything
  here could be read to disagree with the brand/UI-structures contract, ADR-0075 wins — the
  `--rg-*` tokens stay the API, the sidebar stays the only dark surface, the wordmark stays
  `regulAIt`, and the seven browser-asserted accessibility invariants stay green.

---

## 1. Context — the nav absorbed a competitive queue and stopped being an IA

The Saviynt/competitive gap queue (ADR-0080 through ADR-0092) landed ~10 admin surfaces in a few
weeks — Use cases, Vendors, Risks, Agent inventory, Access recommendations, Certification
campaigns, SoD rules, Posture, Shadow-AI discovery, Model risk — and each was filed, correctly at
the time, under the one "Governance" nav group. That group reached **26 entries**: a scroll of
undifferentiated labels in which the daily surfaces (Approvals queue, Audit log) sat between
one-time-setup and board-facing pages. Each entry's *placement rationale* was written down (the
ADR adjacency comments in `AppShell.tsx`), but a rationale per item does not make a readable
whole.

A parallel survey of the new pages found the component discipline had largely **held**: every
page already uses the shared `PageHeader`, the kit `Table`/`Card`/`Field`/`EmptyState`, and
context-aware empty states with a stated next action. The real inconsistencies were narrow:

- **Two severity vocabularies.** Red-teaming mapped `high → danger` while Shadow-AI mapped
  `high → warn` and `medium → info` — the same word meant different colours on adjacent pages,
  and neither used the brand's four-step severity tokens that exist precisely for this.
- **Two raw `<pre>` JSON dumps** on the Shadow-AI page rendered operator-facing results as
  unbounded walls of JSON instead of the kit `CodeBlock`.
- **No orientation.** An admin's first landing was a wall of cards and a 50-entry nav with no
  statement of what the product is enforcing or where to start.

## 2. Decision

### 2.1 The nav is grouped by the question a section answers

`ADMIN_GROUPS` in `apps/web/src/shell/AppShell.tsx` is restructured from 6 groups (one of them
26 entries) into 11 sections, ordered most-used-first:

| Section | The question it answers | Entries |
|---|---|---|
| **Overview** | where do we stand? (read-only) | Posture · Reports · Governance copilot |
| **Approvals & Audit** | what waits on a human, and what happened? | Approvals queue · Review workbench · ChatOps approvals · Audit log · Data lineage · Traces |
| **AI Governance** | is each *use* of AI proposed, owned, risk-accepted? | Use cases · Model risk · Vendors · Risks · Shadow-AI discovery |
| **Access Reviews** | who holds what, and should they still? | Agent inventory · Access recommendations · Certification campaigns · SoD rules |
| **Policies & Gates** | may this call proceed, under which policy version? | Rules engine · ABAC policies · Guardrails · Prompt versions · Simulation · Workflow templates |
| **Quality & Security** | is the agent good, and does it hold under attack? | Evaluations · Red-teaming · External scorers |
| **Identity & Access** | (unchanged) | Users · Roles · Teams · Client access · Virtual keys · SSO & sessions · Provisioning (SCIM) · Group → role mapping |
| **Integrations** | (unchanged minus External scorers) | Agents · Model credentials · Custom LLM providers · regulAIt-LLM · Connectors · MCP servers · Git connections · PM connections · Deploy targets |
| **Cost & Optimization** | (unchanged) | Cost dashboard · Cross-vendor consolidation · Spend forecast & anomalies · Metering & billing · Optimization |
| **Compliance & Infra** | (unchanged) | Compliance profiles · Compliance packs · Infrastructure |
| **Settings** | (unchanged) | Organization · Licensing & seats · Data key custody · Scheduled jobs · First-run setup · Getting started |

Rules of the restructure, all deliberate:

- **Grouping and labels only.** Every route path and every entry label is byte-identical —
  bookmarks survive, and every Playwright locator that clicks a nav entry by name still
  resolves. The one spec change is phase2's *section-name list*, updated to the new eleven —
  the same assertion (every section heading renders), pointed at the new IA.
- **Breadcrumbs follow for free.** `GROUP_OF_PATH` derives each page's kicker from this
  structure, so all ~50 admin pages restate their new location with zero per-page edits — the
  reason that map exists.
- **Sections stay headings, not disclosure menus** (the ADR-0075 shell contract: one level,
  always visible, nothing to hunt through). The `/` filter is the fast path across all of them.
- **Each entry keeps its ADR adjacency comment.** The placement argument moved with the entry;
  none was deleted.
- **One entry moved between top-level groups**: External scorers (Integrations → Quality &
  Security), to sit beside the evals it scores. ADR-0088's registration-shape argument (same
  rails as Custom LLM providers) is retained in the comment; the *user's* question ("how is this
  eval scored?") won over the *implementer's* ("what does registration look like?").

### 2.2 One severity vocabulary — `SeverityBadge`

`ui/kit.tsx` gains `SeverityBadge`, the single renderer of the brand's four-step severity scale
(critical / high / medium / low), styled as the brand specifies severity pills: 16% tint fill,
`-deep`-step text — the token pairs whose contrast ADR-0075 §5.2b measured. Red-teaming and
Shadow-AI are refactored onto it; their local, disagreeing tone maps are deleted. Unknown
severity strings render as a neutral `Badge` — a new vocabulary word shows up unstyled rather
than silently mis-coloured. (The Access-recommendations page keeps its own two-class badge
mapping on purpose: `informational`/`review-suggested` are ADR-0092 *classes*, not this scale,
and dressing them in severity colours would imply an ordering that ADR pointedly refuses.)

### 2.3 Operator-facing JSON goes through `CodeBlock`

The two raw `<pre>` dumps on Shadow-AI (import result, apply preview) become the kit `CodeBlock`
with a bounded height. Raw payloads stay visible — an operator verifying an import wants the
actual bytes — but scroll inside their own container instead of dominating the page.

### 2.4 First-run orientation on the admin home

The admin home opens with one dismissible card: a one-sentence statement of what the gateway is
enforcing right now (default-deny entitlements, approvals, guardrails, cost attribution, audit —
*enforced at the call, not reported after it*), three live numbers (decisions waiting, governed
calls metered, attributed spend — read from the queries the page already runs, deduped by query
key, so the card costs no extra fetches), and four start-here links (Posture, Use cases, Agent
inventory, cost dashboard). Dismissal is a `localStorage` convenience — per-browser, wrapped in
try/catch, gating nothing; a cleared browser sees the card again, which is correct for a card
whose job is orientation.

## 3. What was checked and left alone

The cleanup pass *surveyed* every new page (the nine governance surfaces plus Compliance packs,
External scorers, Model risk) against the enterprise checklist and found the following already
consistent, so no change was made: `PageHeader` on every page; visible `Field` labels on forms
(no placeholder-as-label); loading skeletons via `QueryGate`/`Table` on every fetch;
context-aware empty states with a stated next action on every list that can be empty; wide
tables scrolling in their own container; zero hardcoded hex outside `src/theme/`. The long
page-header `sub` paragraphs were deliberately **not** tightened: many carry contract language
("attested — not verified", "unmeasured, not resisted", "a computed fact, not a clean bill of
health") that tests and ADRs treat as load-bearing, and the 66ch measure cap already keeps them
readable. Restyling honesty is allowed; rewording it is not.

## 4. Honest limits

- **Scope is the admin console's new surfaces.** The end-user `/app` shell and the older admin
  pages get the shared components only where this pass touched them; no full re-layout was done
  (ADR-0075 §7's list-page/drawer re-cut remains future work).
- **"Most-used-first" is a judgement, not a measurement.** No telemetry ranks the sections; the
  order encodes the daily loop (approvals/audit) over setup surfaces. If usage data ever says
  otherwise, reorder — it is one array.
- **The orientation numbers are the same live reads the cards below make** — they inherit those
  endpoints' semantics and limits (e.g. spend is the measured ledger, list-price estimate rules
  per ADR-0047 apply where they apply).
- **Eleven sections is more headings, not less nav.** The sidebar is longer than before; the
  bet is that labeled short runs scan better than one unlabeled long run, and the `/` filter
  remains the escape hatch. If a section shrinks to one entry in future work, merge it.

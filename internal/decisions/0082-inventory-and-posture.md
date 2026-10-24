# ADR-0082: Standing agent dependency inventory and boardroom posture report — aggregations over ledgers we already write

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: **none.** That is the decision's spine, not an omission — both surfaces are
  read-time aggregations over ledgers this deployment already writes. There is no new table, no
  rollup, no snapshot, and no column anywhere an admin could set to change what either view says.
- **Driver**: [GAP_ANALYSIS_CREDO_AI_2026-08.md](../product/GAP_ANALYSIS_CREDO_AI_2026-08.md)
  gaps **L7** (*"no standing 'agent X uses tools Y,Z and feeds agent W' inventory view … our data
  already contains it — it is an aggregation over grants + run history, not new collection"*) and
  **L8** (*"scorecards, the report ledger, CSV exports, dashboards — operator-shaped, not
  board-shaped … presentation work over data we already hold"*).
- **Extends**: [ADR-0047](0047-executive-compliance-reporting.md) (the reporting rails L8 rides:
  reports computed over real ledgers, entitlement scoping at query construction, no
  materialization), [ADR-0058](0058-compliance-packs.md) (`evaluatePack` — the pack coverage
  numbers), [ADR-0060](0060-tamper-evident-audit.md) (the OBSERVED `tamperResistant` grading),
  [ADR-0068](0068-redteam-depth.md) (the ASR-with-interval statistics surfaced verbatim),
  [ADR-0070](0070-trace-observability.md) (the trace ledger observed tool/connector usage reads
  from), [ADR-0080](0080-ai-use-case-registry.md)/[ADR-0081](0081-ai-risk-register.md) (the two
  objects both new views surface).

## Context

Credo AI renders a static dependency map across multi-agent systems as a registry view, and its
flagship output is a board-ready governance report. RegulAIt had the opposite shape: DAGs are
per-run, lineage is per-trace, and every dashboard is operator-shaped. But the gap analysis was
explicit that both lacks are PRESENTATION lacks — the grant tables, `usage_events`,
`trace_spans`, `orchestration_runs`, `redteam_runs`, `eval_runs`, the pack machinery, the risk
and use-case registers, the audit chain, and the budget columns already contain everything the
two views need.

## Decision

### 1. L7 — `GET /v1/inventory/agents` (+ `/:agentId`): granted and observed, never blended

One row per registered agent, every column a SELECT over an existing ledger — and the payload's
structure carries the design: a **`granted`** block (what the entitlement rows say MAY happen)
and an **`observed`** block (what the run history says DID happen), separately sourced,
separately labelled, never summed. That distinction is the honest version of Credo's static map:
a map that mixes the two cannot tell an unused permission from a used one, and the difference IS
the over-permissioning question a governance buyer is asking.

- **Granted**: direct `agent_grants` ∪ role-derived (`role_agent_grants` × `role_assignments`),
  **minus** per-user `agent_revocations` — holders are named, with HOW they hold (direct vs
  which role). The per-agent tool/connector sets are the union of the holders' grant rows
  (direct + role bundles, minus matching full-scope revocations), with server-wide read-only
  grants listed apart rather than expanded.
- **Observed**: dispatches from `usage_events` (count/cost/last-seen); MCP tools and connectors
  from ADR-0070 **trace spans whose parent span carries the agent** — a human calling a tool
  directly is deliberately attributed to no agent; and **agent→agent feeds** aggregated from
  orchestration run history: an edge (dep-owner → node-owner) exists where a run's dependent
  node actually left `not_started` (the kernel only dispatches a node once its dependencies are
  `done`, and their outputs are injected into its context), owners resolved through the run
  **state** so reassignment is honoured, self-edges skipped. Each edge is labelled with its
  observed run count and last-seen — exactly the gap doc's ask.
- Also per agent: credential source (platform credential / custom endpoint / BYO count — never a
  key), model-card standing (cards + whether a sign-off is LIVE, `validUntil` checked against
  now), red-team coverage (`everProbed`, runs in window, latest ASR **verbatim with its trial
  denominator and quality label** — never a bare rate), eval/groundedness run counts, and the
  linked ADR-0080 use cases and ADR-0081 risks.
- **Scoping**: admin-only via the default gate (not in `NON_ADMIN_ROUTES`). The inventory names
  users, grants and org-wide run history — the audit log's record class, and that surface's
  posture.
- **SPA**: an "Agent inventory" page in the Governance group beside Risks — the table with
  `Granted (may)` and `Observed (did)` as separate columns, and a per-agent detail rendering the
  two blocks side by side. Feed edges render as a plain labelled list; **no graph library**.

### 2. L8 — `GET /v1/reports/posture`: one board-shaped document on ADR-0047's rails

One JSON document: per-active-pack coverage (via ADR-0058's own `evaluatePack`, org-wide), risk
register summary (status counts **plus a named attestation-only count** — how many registered
risks sit in categories no ledger measures), red-team posture (latest ASR verbatim with Wilson
interval/denominator/quality, plus a short trend), eval/groundedness summary, spend vs budget
(current month from `usage_events`; per-project budget standing computed **per the project's own
`budgetPeriod` semantics** — monthly window for monthly budgets, lifetime for lifetime — the
same windows the pillar-5 gate enforces; unattributed spend named; the §10.4 estimate disclaimer
on the face), governance activity (denials, PII blocks, approvals pending/decided over a 30-day
window), audit-chain anchoring (the ADR-0060 **observed** `tamperResistant` grading — the sink's
medium is asked, configuration is never reported as fact), and the AI use-case pipeline counts.

- **ADR-0047's stated principle is preserved to the letter**: every number is computed by SELECT
  at request time; there is no rollup table and no stored snapshot. The reconciliation
  discipline is tested the same way — the suite writes ledger rows and asserts the document
  moves by exactly those deltas.
- **Empty never reads as good**: no red-team history renders `measured: false` with ADR-0081's
  phrasing — *unmeasured, not resisted* — never an ASR of 0; no active pack renders coverage
  "unmeasured here, not satisfied"; no metered call renders "none recorded". Pack figures are a
  **coverage count, never a compliance verdict** (the ADR-0058 statement rides each pack line).
- **Scoping**: admin-only via the default gate — the exact ADR-0047 position for an org-scoped
  report (only an admin may see the org-wide rollup). There is no narrower posture; a
  team-scoped view is the existing scorecard.
- **SPA**: a "Posture" page in Governance beside Reports — large headline figures with
  plain-language one-liners, each section linking to the operator page that holds the detail,
  two small owned-SVG trends (daily spend, ASR), and **print-friendly with CSS only**
  (`@media print` drops the app chrome). ADR-0047 §3's PDF rendering dependency therefore stays
  unresolved rather than being resolved by the back door.

### 3. Registry and tests

Both routes are tagged in the ADR-0053 registry (`internal`; tags `inventory`/`reports`).
Non-vacuity was proven the M-002 way, both halves: constant-ify the posture governance denials
query → exactly the governance delta test fails; no-op the observed-edge aggregation
(`computeFeedEdges` returning `[]`) → exactly the feed-edge test fails ("A→B must be
observed"). Both probes reverted by reversing the exact edit. The inventory suite carries the
subtraction controls (an agent-revoked user's tool grants must not leak into the granted set; a
tool call under another agent's span must not count) and the feed controls (a planned run and a
never-started dependent contribute no edge; a reassigned node's edge points at the agent that
actually ran it). A read-only Playwright spec (`zz-` prefixed, order-independent sign-in) drives
both pages in the real SPA.

## Honest limits

- **Observed edges see only governed runs.** An agent-to-agent hand-off that happened outside
  the orchestration engine — or before it — produced no run row and is invisible. The feeds
  list is a floor, never a census.
- **Observed tool/connector usage sees only the trace ledger.** A deployment with tracing off,
  or calls predating ADR-0070, are UNOBSERVED — the payload says so, and an empty list must be
  read as "nothing observed", not "nothing happened".
- **The granted tool/connector view is an inventory of grant rows, not a policy simulation.**
  ABAC policies, approval rules, rate limits and budget caps are not replayed; the per-call
  kernel remains the only authority on any individual call, and the Simulation page exists for
  what-if questions. Server-wide read-only grants are listed, not expanded into tool names.
- **The posture document is a window over what the ledgers hold, not real-world exposure**
  (ADR-0081's rule, inherited verbatim). A quiet denial trail is not proof of safety, and a
  95%-evidenced pack is a coverage count, not compliance.
- **No scheduled delivery.** The posture page is pulled, printed from the browser, or read over
  the API; nothing mails it, nothing snapshots it, and ADR-0047's delivery/PDF follow-ups remain
  open — this ADR deliberately does not close them by the back door.
- **Feed semantics are dependency-shaped, not data-flow-proven.** "A feeds B" means B's node
  depended on A's and actually started (so A's output was injected into B's context) — it does
  not claim B's output was influenced by A's content (the ADR-0050 intra-model attribution rule).

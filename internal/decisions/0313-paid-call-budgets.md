# ADR-0313: Paid-tool and agent-payment budgets (reserve at authorisation, settle with the usage row)

- **Status**: Accepted (builder lane E2, 2026-11-15; market-analysis gap G9)
- **Date**: 2026-11-15
- **Index**: Paid calls: a price per MCP tool or connector, reserved against the project budget and run cap before the call
- **Migration**: `pending/paid_call_budgets.sql` (numbered at merge, ADR-0252)

## Context

MCP tools and APIs increasingly charge per call: x402's `402 Payment Required` with a `maxAmountRequired`, and
Cloudflare's pay-per-crawl and per-tool monetization. Pillar 5 prices a tool or connector call at a flat list price
after it ran, and the project gate (`preDispatchProjectGate`, ADR-0103 / ADR-0179 §4) reads measured spend and reserves
nothing. Its own comment names the consequence and leaves the fix open ("a spend-hold ledger is future work"): every
call in flight when the cap is crossed is let through, so an agent loop calling a paid tool in parallel spends real
money past its budget. There was also no way to authorise a call whose charge is reported by the upstream.

Search first (ADR-0176): the x402 reference implementation (`coinbase/x402`) is Apache-2.0, so its licence qualifies.
But it is a payment rail. It settles through a facilitator service on a blockchain (`@x402/evm`, `@x402/svm`), which
an air-gapped deployment cannot reach, and RegulAIt authorises and budgets calls rather than moving money. Cloudflare's
gateway is a hosted service. Neither meets the air-gapped requirement, so the minimal pricing and reservation model is
built in our own ledger. No new dependency.

## Decision

1. **A price makes a call paid.** `paid_call_prices` names exactly one subject: an MCP tool, every tool of an MCP
   server (the tool's own price wins, the O10 rule), or a connector. It holds `price_usd` (the quoted price),
   `max_settle_usd` (the most one call may settle at, x402's `maxAmountRequired`, at least the price, at most $10,000)
   and `hold_ttl_seconds` (60 to 86,400, default 900). Existing flat list prices are unchanged; only a priced subject
   reserves.

2. **Reserve at authorisation, after every other gate.** Just before the upstream is contacted (after entitlement,
   compliance, the measured-spend gate, approvals, PII and guardrails, so a refused call holds nothing),
   `reservePaidCall` reserves `max_settle_usd` against every envelope the call falls under:
   - the attributed project's effective budget (min of the budget and the compliance ceiling, at the org's
     hard-block percentage, the monthly window for a monthly budget);
   - the orchestration run's cap, when the call runs inside a run (`contextId` `run:<id>` or `detail.runId`).

   Measured spend plus open holds plus this hold must fit. The checks and the insert are one transaction under each
   envelope's advisory lock (project first, then run), so concurrent paid calls serialise and can never overshoot
   together. A test runs ten concurrent $0.25 calls against a $1 budget: exactly four run.

3. **Default-deny (ADR-0180).** A paid call that falls under no envelope (unattributed, or attributed to a project with
   no budget, and not in a capped run) is refused with `paid_call_no_budget`: money does not leave without a budget it
   is counted against. Over budget is refused with `paid_call_over_budget` or `paid_call_over_run_budget` (409). In
   neither case is the upstream contacted. A sanctioned overage lifts its envelope, as it does for measured spend.

4. **Over budget goes to the one approvals queue.** A project overage escalates through the existing
   `__project_budget__` approval to the project's budget approver. A run overage opens `__budget__:paid_call` for the
   run's escalation approver. The existing run-budget decision handler already treats every `__budget__*` stage the
   same way: approve sets `overageApproved` on the run, deny aborts it. Every refusal is audited (`paid-call-*` rule
   ids, object type `paid_call`).

5. **Settle with the usage row.** The call's usage row bills what the hold settles at:
   - the charge the upstream reported (an MCP result's `_meta["io.regulait/charge"].amountUsd`), never above the hold.
     A larger report settles at the hold and is audited `paid-call-charge-capped`;
   - else the quoted price;
   - for a tool that answered with an error result and reported no charge, $0.

   The hold records the usage row it settled with. A call made inside a run now stamps `detail.runId` on its MCP or
   connector usage row, so the run cap and the cost per outcome (ADR-0312) see the spend.

6. **Release.** A call that fails upstream releases its hold (`call_failed`), and so does an MCP call that leaves
   without billing (in its `finally`). Any hold left open is released by the `paid-call-hold-sweeper` job at its TTL.
   Until then it still counts against its budget, which is the safe direction. A hold never expires before its call can
   finish: its life is the price's `hold_ttl_seconds` or the call's deadline plus 60 s, whichever is longer
   (`paidHoldFloorSeconds`: an MCP call's connect and call-tool deadlines; a connector invoke's request and
   guarded-fetch deadlines). Otherwise a long call's hold would stop counting before it bills, and concurrent calls
   could overspend (R4 on #1143). Holds are never deleted: the app role
   has no DELETE or TRUNCATE on them. The hold lifecycle is one declared table (owner rule 12),
   `PAID_HOLD_TRANSITIONS` in `paid-calls.ts`: `held → settled | released`, `released → settled` (a late settlement of
   a swept hold still records the real charge), `settled` final. Settle, release, the sweeper and the list filter all
   read their allowed source states from it, and the `UPDATE … WHERE state IN (…)` makes the transition atomic.
   A replayed ADR-0230 SAP call (an idempotent repeat) settles its hold at $0.

7. **Admin API (versioned, bounded).** `GET` and `POST /v1/paid-call-prices`, `DELETE /v1/paid-call-prices/:priceId`
   and `GET /v1/paid-call-holds` (ADR-0226 list contract, filters `state` and `projectId`). Adding a price makes calls
   stricter and is audited. Deleting one relaxes governance, so it needs a `settings_relax` step-up and is audited as a
   relaxation. The four routes are admin-only, `internal` in the OpenAPI registry, and API-only, with screens tracked
   on #453 (`scripts/known-ui-gaps/adr-0313-e2-paid-call-budgets.json`; the price DELETE is listed in
   `DELIBERATELY_API_ONLY` until then). RLS (ADR-0234): `paid_call_holds` carries `project_id`, so it is
   project-scoped and is listed in ADR-0234's project-scoped batch beside `usage_events`; until that batch lands it is
   read only through these admin-only routes. `paid_call_prices` has no owner column, so it is deployment-wide.

8. **3NF.** Every reference is a foreign key. `paid_call_holds.tool_name` is point-in-time evidence (the name the call
   was authorised for) and carries an exception comment. `held_usd` and `settled_usd` are facts of the hold, not
   copies.

## Consequences

- A paid tool or API can no longer overspend a project budget or run cap, even under parallel agent calls. The
  measured-spend gate's overshoot bound (ADR-0179 §4) still applies to unpriced and flat-priced calls.
- A paid call needs a budget. Unattributed paid calls stop working until they are attributed to a budgeted project,
  which is the intended secure default.
- `projects.ts` exposes `effectiveProjectBudget` (shared by the gate and the reservation) and exports the period and
  escalation helpers. Behaviour is unchanged.
- Follow-ups: an x402 wire adapter (parse a `402` quote and a payment-response header on HTTP connectors) behind the
  same reservation; a connector-reported charge; holds for A2A calls; the price and hold screens (#453).
- Owner question open: should the org's `budgetEnforcement: warn_only` let paid calls through over budget? Today it
  does not: a paid call is always refused over budget, and the approvals queue is the way to relax it.

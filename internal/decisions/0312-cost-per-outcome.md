# ADR-0312: Cost per outcome (spend per merged PR, workflow run, accepted change and completed work item)

- **Status**: Accepted (builder lane E2, 2026-11-15; market-analysis gap G3)
- **Date**: 2026-11-15
- **Index**: Cost per outcome: an RLS outcome ledger joined at read time to the metered spend of the runs that produced it
- **Migration**: `pending/cost_outcomes.sql` and `pending/user_spend_budgets.sql` (numbered at merge, ADR-0252)

## Context

Pillar 5 attributes spend at every gateway call into `usage_events` (metered) and keeps customer-imported spend apart in
`imported_cost_lines` (basis `imported`, ADR-0069). The dashboard can say what a project spent. It cannot say what the
spend produced: how much a merged pull request, a workflow run, an accepted change or a completed work item cost. The
market analysis (gap G3) names this as the figure buyers compare tools on. ADR-0214's objective cards are posture
metrics, not cost per outcome, and no other ADR covers it.

The joins already exist in the data. A model or tool call made by an orchestration run carries `detail.runId` (and
`detail.nodeId`) on its `usage_events` row. A run nested in a build stage names its workflow instance
(`orchestration_runs.workflow_instance_id`). A workflow instance records its pull request and merge commit in
`context` (`prId`, `mergeSha`) and its terminal status. A PM work item is a `pm_links` row naming the instance, run or
run node it mirrors (pillar 8).

Search first (ADR-0176): OpenCost, Kubecost's open core and the FinOps FOCUS specification allocate cloud resource
spend to Kubernetes or billing dimensions. None reads our own per-call ledger against our own workflow and PM records,
which is pillar-5 semantics. Pagination reuses the ADR-0226 list contract and the recorder runs on the ADR-0064
scheduler. No new dependency.

## Decision

1. **An outcome ledger, not a spend copy.** `cost_outcomes` holds one row per outcome the recorder observed, of four
   kinds:
   - `merged_pr`: a workflow instance whose merge stage returned a merge commit (the commit is kept as evidence);
   - `workflow_run`: an instance that reached a terminal status (`completed`, `aborted`, `denied`, `rolled_back`), so a
     failed attempt is a cost too;
   - `accepted_change`: an instance that completed every stage, including post-deploy verification;
   - `completed_work_item`: a PM link whose instance or run completed, or whose run node is `done`. The PM tool's own
     state strings are provider-specific and are not interpreted.

   The row stores no money. Every read sums `usage_events.cost_usd` over the calls the outcome's runs dispatched (a
   work item linked to a run or a node reads that run or node; any other outcome reads every run of its instance), over
   the subject's whole life. A late-settling call or a price correction restates the figure. A call with no price is
   counted (`unpricedCalls`) and adds nothing, so a cost per outcome with unpriced calls is a lower bound. Calls made
   outside an orchestration run are not attributed to any outcome; the basis statement says so on every response.

2. **Metered and imported stay apart.** Imported spend was restated from customer files and was never observed per
   call, so it never joins an outcome. The per-cost-centre roll-up shows it beside the metered figure (applied,
   non-superseded lines whose billing period overlaps the window, counted whole) and never divides it by outcomes or
   adds it to metered spend. A project roll-up has no imported figure, because imported lines carry no project.

3. **The recorder.** `recordCostOutcomes` is one idempotent pass (bounded at 2,000 inserts per kind), run by the
   `cost-outcome-recorder` scheduler job every five minutes under `system_task`, and on demand by an admin through
   `POST /v1/cost-outcomes/refresh` (audited). Partial unique indexes make a repeated or concurrent pass a no-op. The
   recorder only reads workflow, run and PM state and is never in a decision path.

4. **Secure by default (ADR-0180).** `cost_outcomes` is append-only for the app role (UPDATE, DELETE and TRUNCATE
   revoked) and has row-level security enabled and forced. An admin and `system_task` read every row; any other
   principal reads only the outcomes of workflows it initiated; only an admin or `system_task` may insert. With no
   principal and no system context a transaction sees zero rows. The deployment is single-tenant, so the RLS scope is
   the principal (as in ADR-0234), not a tenant column.

5. **The API (versioned, paginated, bounded).**
   - `GET /v1/cost-outcomes`: the ADR-0226 list contract (keyset by observed time, page sizes 10 to 500), filters
     `kind`, `projectId`, `from`, `to`, each row with its metered spend, call count and unpriced calls. In
     `NON_ADMIN_ROUTES`: a non-admin is limited to their own outcomes by the handler's predicate and by RLS.
   - `GET /v1/cost-outcomes/summary`: admin-only, `by=project|cost_center`, optional `kind`, window, `limit` (1 to 500)
     and `offset`. Per group and kind: outcomes, metered spend, calls, unpriced calls and metered spend per outcome.
     Cost centre resolves as in the consolidated cost view: the project's, then the initiator's. Audited as a read.
   - `POST /v1/cost-outcomes/refresh`: admin-only, audited.

   A window defaults to the last 30 days and may span at most 366. The three routes are `internal` in the OpenAPI
   registry and API-only: their dashboard cards are tracked on #453 (`KNOWN_UI_GAPS`).

6. **3NF exceptions, stated on the columns.** `project_id`, `initiator_user_id`, `merge_sha` and `subject_status` are
   point-in-time evidence of the attribution the roll-up was built on. `initiator_user_id` is also the RLS read key.
   The instance's own `project_id` is FK-free and may be re-pointed; the outcome keeps what was true when it was
   observed.

7. **Index.** The spend join reads `usage_events` by `detail->>'runId'`. A partial expression index
   (`usage_events_run_id_idx`) is built CONCURRENTLY by `runMigrations` (`CONCURRENT_INDEXES`, slug `cost_outcomes`),
   so the build never blocks the ledger's writers.

## Consequences

- The dashboard data layer can show spend per merged PR, per workflow run, per accepted change and per completed work
  item, per project and per cost centre, with the imported side beside it and the basis stated.
- Outcome time is when the recorder observed the outcome, up to one scheduler interval after it happened.
- The four kinds overlap (a merged PR is usually also a workflow run and an accepted change), so no figure is added
  across kinds.
- Follow-ups: the dashboard cards (#453); an outcome hook in the workflow engine, if five minutes of latency is too
  much; attributing spend made outside an orchestration run (for example a workflow's review-check agents) once those
  calls carry the instance id.
- Owner decision (2026-11-15, relayed by the master on #848): only outcomes RegulAIt completed count. A PM tool's own
  "done" state is shown on the outcome (`workItems[].inboundState`) and never counted. This is as built.

## Pilot addendum (owner direction, 2026-11-15)

The pilot is an engineering organisation on Entra ID, Azure DevOps Boards and Repos, several coding tools and several
model providers. Success includes "per-user and per-project spend across tools and APIs visible within minutes, with
a budget alert firing". Three additions follow.

8. **Azure DevOps (and every git and PM provider) on the outcome.** Each listed outcome carries, joined at read time
   and never copied:
   - `pullRequest`: the id and URL the workflow's `open_pr` stage recorded (an Azure DevOps Repos PR URL on that
     provider);
   - `workItems`: the outcome's own PM link, or the instance's linked items (at most 10), each with provider, external
     id, URL and the PM-reported state.

   The joins are provider-agnostic, because pillars 2 and 8 already record these fields for every adapter.

9. **Budget alerts through the existing alerting path.** Three governance-monitor rules, fed by `budget-alerts.ts`:
   - `project_budget_threshold`: a project's metered spend in its budget window (the month for a monthly budget,
     otherwise its lifetime) reached `alert_threshold_pct` of its own budget (80% by default);
   - `user_budget_threshold`: a person's metered spend across every model, MCP tool and connector call reached the
     threshold of their spend budget;
   - `user_imported_budget_threshold`: a person's imported spend reached the same threshold (applied, non-superseded
     USD lines whose billing period overlaps the window, counted whole; seat and usage exports of tools that do not run
     through the gateway, such as coding assistants). It is a separate alert with its own episode. The two bases are
     each compared with the budget on their own and never added, so a person can be over on either, both or neither
     (ADR-0069). Non-USD lines are counted and not converted.

   All are high once spend reaches the budget. Each alert shows the other basis in its detail, never summed. Alerts are ordinary monitor episodes: an owner and due time (ADR-0182 S5), chat delivery (ADR-0162),
   the optional ticket and the audit chain (and so the SIEM). The hourly monitor evaluates them. So alerts arrive
   within minutes, a `spend-budget-alerts` scheduler job runs the spend rules alone every five minutes through
   `applyMonitorFindings`, the monitor's one alert-write path, now factored out of `runGovernanceMonitor` without
   behaviour change. Its pass audit row is written only when it raised or resolved something. The compliance-cascade
   ceiling is enforced by the project gate and is not separately alerted.

10. **A person's spend budget (alert only).** `user_spend_budgets` has one row per person: amount, window (`monthly` by
    default, or `none` for lifetime) and alert threshold (1% to 100%, default 80). Nothing is refused on it; project
    budgets and run caps are the enforcement. Routes:
    - `GET /v1/user-spend-budgets` (admin);
    - `GET /v1/users/:userId/spend-budget`: self or admin, with metered spend in the window and imported spend
      beside it;
    - `PUT /v1/users/:userId/spend-budget`: admin, audited;
    - `DELETE /v1/users/:userId/spend-budget`: admin, a `settings_relax` step-up, audited as a relaxation.

    All four are API-only on #453.

- Owner decision (2026-11-15, relayed by the master on #848, "C1"): a person's budget ALSO alerts on imported spend
  (Copilot, Cursor and other seat or usage exports), as a SEPARATE alert, never folded into one combined figure
  (ADR-0069). Built as `user_imported_budget_threshold` (point 9).

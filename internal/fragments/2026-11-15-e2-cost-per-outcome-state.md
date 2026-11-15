<!-- fold: state-recap -->
**2026-11-15 - E2 slice 1: cost per outcome built ([ADR-0312](../decisions/0312-cost-per-outcome.md), migration `pending/cost_outcomes.sql`, numbered at merge; market-analysis gap G3).** `cost_outcomes` is an append-only, RLS-protected outcome ledger (merged PR, workflow run, accepted change, completed PM work item), recorded by the `cost-outcome-recorder` job; spend is joined at read time from `usage_events` through each outcome's orchestration runs, never copied, and imported spend stays beside it, never combined. Three API-only routes (`/v1/cost-outcomes`, `/summary` by project or cost centre, `/refresh`), tracked on #453.
 Pilot addendum (owner, 2026-11-15):
- each outcome shows its PR and work items (Azure DevOps Repos and Boards, or any adapter), joined at read time;
- project and person budget alerts are governance-monitor rules (`project_budget_threshold`, `user_budget_threshold`)
  that fire through the existing alert path, with a five-minute `spend-budget-alerts` pass;
- `user_spend_budgets` (migration `pending/user_spend_budgets.sql`) gives each person an alert-only budget;
- only outcomes RegulAIt completed count; PM "done" is shown, not counted (owner).

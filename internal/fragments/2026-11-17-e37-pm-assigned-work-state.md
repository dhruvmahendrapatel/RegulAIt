<!-- fold: state-recap -->
**2026-11-17 - lane E37 PR 1: work assigned from the PM tool ([ADR-0356](../decisions/0356-pm-assigned-work-triggers.md), migration `pending/pm_work_triggers.sql`, numbered at merge).**
- **Built:** assigning a Jira or Azure Boards item to the RegulAIt agent user, @mentioning it, or a Jira Automation /
  Azure DevOps service-hook rule now starts a pillar-2 workflow through the existing signed, replay-checked PM
  webhook. The person is mapped through an admin's `pm_identity_links` row and must pass their own agent decision;
  the start is the same `startWorkflowForChange` the instances route uses (extracted from it), so the template
  assignment decides Intake and forced Plan. Denials are explained on the item. Off by default per connection
  (`pm_trigger_settings`). The trigger lifecycle is one declared table, enforced by a compare-and-set update and a
  database trigger.
- **Next:** PR 2 (write-back of sign-off requests, decisions, approvals, PR links and the outcome, idempotent and
  audited) and PR 3 (Rovo and MCP audit events, read-only evidence). Six API-only routes are UI gaps on #453.

<!-- fold: state-recap -->
**2026-11-17 - lane E37 PR 2: PM write-back ([ADR-0356](../decisions/0356-pm-assigned-work-triggers.md) §2, migration `pending/pm_write_backs.sql`, numbered at merge).**
A workflow started from Jira or Azure Boards now tells its item, once each and audited: the start, each sign-off
request, each sign-off outcome, the pull request and the final outcome (then the trigger reads `written_back`). One
reconcile from stored state, called after the start, the transition hook and both decide paths, plus the
`pm-write-back-sweep` job as the backstop. The ledger `pm_write_backs` is written before the PM call and released on
failure. The mapping is the trigger settings' `writeBack` section (comments by default; states and the PR field only
when an admin names them). Next: PR 3, Rovo and MCP audit events as read-only evidence.

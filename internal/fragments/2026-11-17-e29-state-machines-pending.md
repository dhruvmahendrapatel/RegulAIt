<!-- fold: pending -->

- **Declared state machines, follow-ups (ADR-0348, lane E29).** Once the owning lanes merge: config-version canary
  (#894), PM inbound state (#828), one exported workflow terminal set (E21), and a scheduler reaper for eval runs whose
  process died mid-run (after the open PRs changing `scheduler-jobs.ts`). A CHECK-constraint migration batch
  (expand-contract) for `approvals.status` and the infra status columns, which then declares the infra machines. Move
  the already-guarded machines (STATE_MACHINES.md §2) onto declared tables as their files are next touched. UI: screens
  move to the `lifecycle` field (STATE_MACHINES.md §6, #453).

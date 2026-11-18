<!-- fold: pending -->

- **Declared state machines, slice 3 and follow-ups (ADR-0348, lane E29).** Slice 3: shadow-AI
  findings, infra lifecycle, use cases, skill admission, red-team libraries, approvals (review re-open, one declared
  terminal set), billing close, and `GET /v1/state-machines`. Follow-ups once the owning lanes merge: config-version
  canary (#894), PM inbound state (#828), one exported workflow terminal set (E21), and a scheduler reaper for eval runs whose process died mid-run (after the
  open PRs changing `scheduler-jobs.ts`). CHECK constraints for `approvals.status`
  and the infra status columns need an expand-contract migration batch. UI: screens move to the `lifecycle` field
  (STATE_MACHINES.md §6, #453).

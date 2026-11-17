<!-- fold: pending -->

- **Declared state machines, slices 2 and 3 (ADR-0348, lane E29).** Slice 2: incidents (PATCH, containment, close),
  eval runs (`error` and a reaper), the scheduler lease release fence, the orchestration overage gate. Slice 3: shadow-AI
  findings, infra lifecycle, use cases, skill admission, red-team libraries, approvals (review re-open, one declared
  terminal set), billing close, and `GET /v1/state-machines`. Follow-ups once the owning lanes merge: config-version
  canary (#894), PM inbound state (#828), one exported workflow terminal set (E21). CHECK constraints for `approvals.status`
  and the infra status columns need an expand-contract migration batch. UI: screens move to the `lifecycle` field
  (STATE_MACHINES.md §6, #453).

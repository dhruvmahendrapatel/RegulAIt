<!-- fold: state-decisions -->

**ADR-0349 (lane E30, 2026-11-17, Accepted; slice 1 built): five durable-execution ideas from Temporal, inside our own
runner.** Temporal is not adopted (ADR-0254 stands). Slice 1 adds a CI check on ADR-0342's replayer (`replayHistory`): recorded
`workflow_events` histories in `packages/workflow-kernel/replay-fixtures/` must still reach their recorded state, and a
fixture is never re-recorded to make CI pass. Slices 2–5 follow: one open instance per template + target + work item
(409 by default, `use_existing` an audited step-up relaxation), a renewed short claim lease with a schedule-to-close
limit, workflow schedules on the ADR-0064 scheduler, and typed instance search with a pending-work view.

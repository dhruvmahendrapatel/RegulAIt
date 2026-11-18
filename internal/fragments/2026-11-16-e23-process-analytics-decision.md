<!-- fold: state-decisions -->

**ADR-0342 (lane E23, 2026-11-16, Accepted; slice 1 built): process analytics from the workflow history.** The read
model is replayed from `workflow_events` through the pure kernel and accepted only when it reproduces the stored state.
Stage time splits into wait (the instance needs a person or an outside party) and work (the engine executing or queued).
Reads are versioned, bounded (366-day window, 400 periods, 200 rows a page) and scoped by `evaluateReportAccess`: org
is admin-only and a team or project read is narrowed to the caller's projects. Row-level security is forced. Human-task
escalation stays the one ADR-0046 SLA sweep, which lane E21's timers drive.

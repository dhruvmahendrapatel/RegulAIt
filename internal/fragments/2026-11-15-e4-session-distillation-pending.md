<!-- fold: pending -->

**E4a — Build session distillation (ADR-0316, 2026-11-15, lane E4), paused for the pilot.** Resume when the master says so: merge main into the parked branch `builder/e4-session-distillation`, re-run its tests and the full gateway suite, open the PR. Open owner questions: automatic distillation at session end (default: author-triggered only) and the admin read rule (default: admins take the agent check). Follow-ups once built: screens on #453, RLS on the new tables with `project_context_items`, and an inbox re-check of entitlements for a pending distilled conflict.

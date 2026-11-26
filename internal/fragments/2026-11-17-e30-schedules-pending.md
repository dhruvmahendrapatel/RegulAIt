<!-- fold: pending -->

**E30-4 (lane E30 slice 4, decision in PR #925; UI for #453): workflow schedules have no screen yet.** The API is built
(`/v1/workflows/schedules`: create, list, read with recent fire times, edit, pause, resume, backfill, run-due), and the
`workflow-schedules` scheduler job starts due schedules as their creators. For the design builder: a schedules list on
the workflow templates area, a create/edit form (cron, time zone, overlap, catch-up, jitter; a relaxed overlap policy
asks for the step-up), pause and resume with a note, and the fire-time history with each outcome.

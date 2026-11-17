<!-- fold: state-recap -->
**2026-11-17 - lane E29, declared state machines slice 1 ([ADR-0348](../decisions/0348-declared-state-machines.md)).**
The app-wide inventory is [STATE_MACHINES.md](../product/STATE_MACHINES.md): about 95 lifecycle columns, the workflow
and orchestration kernels already explicit, 16 machines to convert ranked by F×S, 3 follow-ups in other lanes' files,
7 `triage-low` issues (#912–#918). Built: `defineMachine` and the `STATE_MACHINES` registry in `@regulait/shared`
(no dependency; XState v5, @xstate/store, robot3 and javascript-state-machine compared), `whereFrom` for guarded
lifecycle UPDATEs, and a read-only `lifecycle` view (state, next steps, allowed or not and why) on
`GET /v1/llm/jobs/:id` and `GET /v1/mcp/admission`. Converted: training jobs (a cancel can no longer be overwritten by a
start or a poll) and MCP admission (a scan no longer overwrites a concurrent admin clear or engine hold). Next: slice 2
(incidents, eval runs, scheduler lease release, orchestration budget gate). No migration.

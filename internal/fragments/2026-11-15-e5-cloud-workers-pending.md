<!-- fold: pending -->

**G5 — cloud coding agents as governed workers (ADR-0320, 2026-11-15, lane E5).** (1) Slice 2: tables
(`cloud_worker_providers`, `cloud_worker_grants`, `cloud_worker_credentials`, `cloud_worker_dispatches`), the
`cloud_workers_enabled` org flag and `executeGovernedCloudWorkerDispatch`, against fake servers. (2) Slice 3: the
`cloudWorker` task-graph node in `planRun` and the build stage, polling, PR capture, cost settlement. (3) Slice 4:
verify the Copilot coding agent REST fields and the OpenAI Agents API repository and usage contract, then adapters.
(4) Before any live use, confirm the UNVERIFIED fields (Cursor's initial run id in the create reply and the usage reply;
Devin's base URL, cancel endpoint and v1 deprecation). (5) A credential ADR (this lane's second reserved number) once lane E3's
portable credential lands. (6) Admin screens go to #453. Owner questions: which live accounts; whether every dispatch needs an approval.

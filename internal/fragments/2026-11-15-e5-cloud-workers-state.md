<!-- fold: state-recap -->
**2026-11-15, lane E5 slice 1: cloud coding agents as governed workers ([ADR-0320](../decisions/0320-cloud-coding-agents-as-governed-workers.md), gap G5).**
Owner decision: third-party cloud coding agents run as pillar-7 workers under the initiating user's limits, default off,
fake servers until live accounts are approved. Slice 1 is the pure kernel module
`packages/orchestration-kernel/src/cloud-worker.ts`: task schema with a pinned repository, base branch and branch
prefix; request builders and fail-closed reply parsers for Cursor Cloud Agents v1 and Devin v1 (Copilot coding agent and
Codex are `contract_unverified` and refused); the dispatch envelope (org flag, provider row and kill switch, execution
dial, plan sign-off, grant, lead ceiling, repository entitlement, node and run budget); the captured-PR scope check; the
Devin ACU limit and cost settlement. No migration, no route. Slices 2–4: tables and the gateway choke point, the
build-stage wiring and PR capture, then Copilot and Codex.

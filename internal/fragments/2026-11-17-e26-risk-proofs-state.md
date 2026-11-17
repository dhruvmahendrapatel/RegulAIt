<!-- fold: state-recap -->
**2026-11-17 - lane E26, agent risk / control / proof registry, slice 1 ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
Ten agent risks are a code catalogue (`AGENT_RISKS`, `@regulait/shared`), each mapped to the ADR-0243 OWASP pack
controls and the ASI names, its control settings with their secure values, and proofs run by existing engines (the
ADR-0057 red-team, sandboxed gateway probes, read-only ledger checks). A test pins that no risk lacks a proof and that
every reference resolves. Schema: `agent_risk_proof_settings`, append-only `agent_risk_proof_results` (hash, optional
Ed25519 signature, linked audit row) and `agent_risk_proof_followups`, all under forced admin/system RLS (migration
`pending/agent_risk_proofs.sql`, numbered at merge). Next: slice 2 (scheduled runs, evidence, alerts and approvals),
slice 3 (APIs; UI is a known gap on #453).

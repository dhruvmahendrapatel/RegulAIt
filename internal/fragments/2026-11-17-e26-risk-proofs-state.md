<!-- fold: state-recap -->
**2026-11-17 - lane E26, agent risk / control / proof registry, slice 1 ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
Ten agent risks are a code catalogue (`AGENT_RISKS`, `@regulait/shared`), each mapped to the ADR-0243 OWASP pack
controls and the ASI names, its controls (real setting columns, policy tables or named behaviours, each checked
against the database), and proofs built on the ADR-0180 continuous-assurance contract (`assurance_metric` specs
measured by `measureAssuranceMetric`, outcomes in `MEASUREMENT_STATES`), plus sandboxed gateway probes and read-only
ledger checks. A test pins that no risk lacks a control or a proof and that every reference resolves. Schema:
`agent_risk_proof_settings`, append-only `agent_risk_proof_results` (hash, optional Ed25519 signature, linked audit row)
and `agent_risk_proof_followups`. All three are under forced RLS; evidence is inserted only by a system task, never by
an admin (migration
`pending/agent_risk_proofs.sql`, numbered at merge). Next: slice 2 (scheduled runs, evidence, alerts and approvals),
slice 3 (APIs; UI is a known gap on #453).

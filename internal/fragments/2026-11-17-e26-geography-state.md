<!-- fold: state-recap -->
**2026-11-17 - lane E26, geography in risk tiering ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md) §9, owner, gap audit C5).**
The jurisdictions a use case is deployed or used in are data (`jurisdictions`, `jurisdiction_obligations`,
`ai_use_case_jurisdictions`, seeded from the ADR-0158 regulatory feed, migration
`pending/agent_risk_proofs_jurisdictions.sql`). `resolveGeography` brings in each jurisdiction's parents and the global
ones, maps them to the feed instruments and the agent risks whose controls and proofs answer them, and applies the
strictest tier floor; a use case with no jurisdiction declared is in scope of all of them. Review routing still reads
the screened tier (owner question).

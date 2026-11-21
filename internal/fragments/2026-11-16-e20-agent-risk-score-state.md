<!-- fold: state-recap -->
**2026-11-16, lane E20 slice 1: the agent risk score ([ADR-0339](../decisions/0339-agent-risk-score-and-identity.md)).**
Every registry and builder agent gets a deterministic, rules-only risk score mapped to OWASP LLM 2026 and Agentic ids
(ids only), weighted by reach (people and dependents) plus toxic combinations (an ADR-0091 rule the agent alone holds;
untrusted input with data access and unconfirmed actions), with fixes ranked by the counterfactual. Database triggers
mark the agent on every write path in the change's own transaction; the `agent-risk-recompute-sweep` appends an
append-only assessment with its audit row in one transaction. Four API-only routes under `/v1/agent-risk` (KNOWN_UI_GAPS
on #453). Migration `pending/agent_risk_scores.sql`. Next: slice 2, author vs runner, NHI links and orphan findings.

<!-- fold: state-recap -->
**2026-11-19, lane E20 addendum: capability-combination exposure findings ([ADR-0339](../decisions/0339-agent-risk-score-and-identity.md)).**
The agent risk score (method `adr0339-v3`) now builds each agent's capabilities one row at a time: a builder agent's
tool and connector bindings, inbound channels and computer use, or a registry agent's workload identity grants. It
finds the lethal trifecta (private data + untrusted content + external communication) and untrusted content + an
unconfirmed destructive action. Each finding names every leg's members and ranks the ways to break it: fewest changes
first, then Ask-first, then the smallest blast radius. The classification fails closed (MCP annotation defaults,
unclassified source = untrusted, ADR-0193), and the combination points are weighted by the ADR-0059 reach band. A
trigger-only migration, `pending/risk_score_capability_marks.sql`, keeps the score current. No new table or route.

<!-- fold: state-recap -->
**2026-11-16, lane E20 slice 2: author vs runner and non-human identities ([ADR-0339](../decisions/0339-agent-risk-score-and-identity.md)).**
Every agent's author is recorded by an insert trigger in the creating transaction (the request principal, or the
builder agent's owner; older agents `unknown`, never guessed). The runner is computed on read (workload identity,
invokers in 30 days, connection format). Cloud service accounts, vendor agent identities and OAuth clients are linked
as `staged` and confirmed only by a second named admin with an `identity_manage` step-up, audited in the same
transaction; a link calls nothing and grants nothing. The owner flag gains `inactive` (90 days), which feeds the risk
score (method `adr0339-v2`) and an admin ownership-findings list. Four API-only routes under `/v1/agent-identity`
(#453). Migration `pending/agent_identity_links.sql`.

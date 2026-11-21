<!-- fold: pending -->

**P20-B4: approval per call and a per-agent rate bucket for SAP Agent Gateway agents (ADR-0231 §5, lane L2 follow-up).**
Not built in lane L2, because it waits for lane L1's approval queue to merge. Scope:
- `a2a_agents.requires_approval`, true by default for gateway agents;
- the message text bound into the approval payload (ADR-0104);
- a per-agent A2A rate bucket seeded at 30 calls per person per hour, where raising it is a relaxation.

Also open from B3:
- mTLS and jwt-bearer client authentication for the discovery token (with B2);
- a per-remote-agent guardrail override scope.

B2, B0 and B6 stay owner-blocked (P20 open questions 1, 2, 4 and 5 in ADR-0231).

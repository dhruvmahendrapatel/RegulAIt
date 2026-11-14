<!-- fold: state-recap -->
**2026-11-14 - Lane L2, P10 follow-up: A2A guardrails on the message, PII and guardrails on the reply ([ADR-0219 amendment](../decisions/0219-a2a-governance.md)).**
A remote agent's message now passes the ADR-0042 guardrails before it leaves. Its reply passes the project's PII mode and the
guardrails before anyone sees it. A block on the reply withholds it behind a counts-only marker, and the call is still charged
(bill-and-withhold). No migration.

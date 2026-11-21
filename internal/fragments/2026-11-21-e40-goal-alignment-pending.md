<!-- fold: pending -->
**E40 — goal alignment, OWASP ASI01 (owner backlog slice, 2026-11-21).** Built in shadow mode
([ADR-0359 §7](../decisions/0359-behaviour-baselines-and-rule-suggestions.md)): a structured declared purpose per agent
workload identity, each agent tool call judged against it, findings with a suggested steering response in the
vocabulary of PR #960. Open: turning a suggestion into enforcement (PR #960's policy modes, by an admin) and lane E52's
containment trigger reading these findings; a `classifyCallTargets` per-operation class for connectors (today a
connector's write is never destructive or open-world, as in the risk score); the purpose and findings screens (#453).

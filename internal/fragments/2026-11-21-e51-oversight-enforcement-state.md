<!-- fold: state-recap -->
**2026-11-21 - E51: autonomy floors enforced at dispatch (ADR-0180 addendum, lane E51).** A `delegated` or
`autonomous` builder agent whose autonomy floors are not all in place is now refused before any model call
(403 `autonomy_floor_unmet`, audited, fail closed with 503 `autonomy_floor_unverifiable`). Assist and supervised
agents are unchanged. An admin may relax the gate per agent (step-up, reason, audited, `AUTONOMY_ENFORCEMENT_MACHINE`)
through `PUT /v1/builder/agents/:id/autonomy/enforcement`; the UI control is a KNOWN_UI_GAPS entry on #453. Closes the
"oversight levels enforced at runtime" item of the 2026-11-20 agentic-governance fragment.

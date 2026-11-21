<!-- fold: state-recap -->

**2026-11-21 - ADR-0193 addendum: memory poisoning closed on the write routes (builder lane E50, OWASP ASI06).** The
content-trust floor now gates the shared-context write route and the agent-memory write route, not only write tool
calls, and both routes also run the prompt-injection and jailbreak scan. Both are on by default; an admin relaxes them
through the existing audited floor and guardrail settings, and there is no memory-only switch. Refused writes store
nothing and are audited. The `memory.untrusted_context_write` proof and its probe cover all three writes (catalogue
version 3). No migration, route or dependency added.

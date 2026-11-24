<!-- fold: state-recap -->

**2026-11-21 - ADR-0193 addendum: the content-trust floor on memory and shared-context writes (builder lane E50, OWASP
ASI06).** On top of the ADR-0347 write path, the floor now gates the shared-context and agent-memory writes, not only
write tool calls. The causal context is checked as the caller's own run or thread, so a clean foreign context cannot
be borrowed to dodge it. ADR-0347's scan stays the injection check; this adds no second scanner and no memory-only
switch. Refused writes store nothing and are audited. The `memory.untrusted_context_write` proof and its probe cover
all three writes (catalogue version 3). No migration, route or dependency added.

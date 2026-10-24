# ADR-0136 - Exact compat cache request identity

- Status: Accepted
- Date: 2026-09-30
- Finding: AER-011
- Amends: ADR-0119

## Decision

Compat cache entries use a versioned canonical fingerprint of the translated
request, not lower-cased flattened message text. Identity includes the wire
surface, requested/served model and agent, served provider/custom endpoint and
admin base prompt, project, ordered role-bearing message blocks, caller system
text, prompt-cache flag, response format, thinking, max tokens and tool choice.
The active/canary prompt and agent-config version set is also represented;
any promotion or candidate change conservatively invalidates old entries.
Tool-bearing turns remain uncached. The cache row stores a SHA-512 commitment
to the canonical request, not plaintext system instructions and message
blocks. The indexed SHA-256 of that commitment and the stored SHA-512
comparison provide independent collision checks. The `compat-v2` prefix keeps
old text-keyed rows from being served under the new identity.

This intentionally loses hits for case and whitespace variations: those can
change code, identifiers, and model behavior. Native invoke caching is not
changed by this decision and needs its own request-identity review.

## Verification and limit

The eight-test compat suite proves identical requests still hit without a provider call,
while case/whitespace, caller system, role, message boundary and max-token
changes miss. Gateway typecheck passed. AER-010 remains open: a cache hit still
returns before the shared pre-dispatch governance gates. This decision must
not be read as cache-governance closure.

# ADR-0137 - In-flight PII redaction boundary

- Status: Proposed
- Date: 2026-09-30
- Scope: design boundary; no `redact` enforcement mode is enabled yet

## Required contract

Redaction must run on the effective bytes immediately before an external
provider call and on the complete provider result before any client delta,
cache store, audit detail, trace, or tool-result forwarding. Output under a
redaction policy is buffered until the entire result is scanned. A stream
may flush the transformed result after scanning, but may never emit an
unscanned token. Input `block` remains stronger than `redact` and must keep
its no-provider-call behavior.

The current PII detector returns category counts, not match spans. A second
regex list in the gateway would drift from the enforcing detector. Extend the
shared detector to produce internal-only validated spans, with counts derived
from those same spans. International national-ID validators need the same
span contract; an enabled jurisdiction with an unredactable hit must fail
closed, not pass through or replace only part of the identifier. No raw span
or matched substring may enter persisted evidence or API error detail.

For MCP writes, exact-action consent must bind the original canonical
arguments and the deterministic effective/transformed argument digest. The
approver must see what will actually be sent; a redaction-policy or algorithm
change invalidates an old approval. Never mutate a payload after the final
approval comparison. Connector and model calls need equivalent final-byte
checks. Cache entries generated before a policy change must be re-scanned
under current output policy, and a hit may not bypass the current input or
other governance gates (AER-010).

## Acceptance tests before enabling

- Synthetic PII in every base and enabled international category, multiple
  and overlapping matches, malformed/near-miss numbers, escaped JSON values,
  and mixed clean/PII text.
- Pause each provider at the final send boundary, change policy, resume, and
  prove the sent bytes match the active decision; refusal means zero calls.
- Streaming clients receive no raw PII delta, including chunk-split matches,
  provider errors, cancellation, and buffered-result limits.
- MCP approval replay with changed raw arguments, changed transformed bytes,
  changed project/ABAC policy, or concurrent consumption cannot execute.

This proposal is not an implemented feature or a claim that the current
count-only detector can safely redact.

# ADR-0145: Connector Redaction Boundaries

Status: Accepted (implementation in progress)
Date: 2026-09-30

## Decision

Reserve migration 0122 and the governed connector invocation path. Reuse the
validated shared decoded-JSON transformation. Freeze an effective invocation
before invoking an adapter, retain original/effective binding metadata, and
never transform the operation or object used to authorize/route a call. PII in
that routing identity is refused rather than redirected. Existing connector
grants remain authoritative; this does not invent a connector approval flow.

Advance the existing governance generation for connector configuration,
credentials, grants, revocations, attribution membership and egress changes.
Read it before admission, check it after DNS validation immediately before
each HTTP send, and refuse a changed admission without an automatic retry.
No network call holds a database lock. Multi-request adapters cannot undo an
earlier request; a later refusal must disclose possible external effects.

Scan/redact the complete decoded result before persistence or response.
A generation change during execution conservatively withholds the result
under every starting mode, including calls that began before redaction was
enabled. Completed calls remain billed. Serialize content-bearing trace
writes against policy activation with a short database-only shared lock;
check again after trace finalization before returning. Never persist raw
payloads or upstream exception text under redaction. Errors use fixed safe
messages. Existing guardrails inspect original and effective input.

## Limits and Evidence

Public redact settings remain disabled. This chapter does not claim model
redaction, content classification, encoded/binary inspection, unbounded
provider collection safety, retroactive cancellation or distributed atomic
network side effects. Connector adapter validation remains in place; these
are decoded payloads, not a proof about arbitrary vendor behavior.

Verify the real HTTP connector route, received effective bytes, unchanged
destination, final-send policy changes, mid-call output policy changes,
ledger/trace leakage, billing, concurrent callers and adjacent egress/PII
regressions. Record results before marking implementation complete.

# ADR-0140 - Validated PII redaction foundation

- Status: Accepted
- Date: 2026-09-30
- Scope: shared text transformation only; does not enable a gateway mode

## Decision

Implement the first prerequisite of ADR-0137 in the existing shared detector.
Base and international validators report UTF-16 offsets through an in-process
visitor. Both detection counts and redaction use those same validated matches;
there is no second regex list or checksum implementation in the gateway.
No match offsets or original values appear in the redaction result. Only the
category/count hits are suitable for audit metadata. Returned text is not
guaranteed to be free of undetected personal information.

`redactPII` replaces each matched region with a typed placeholder. Overlapping
matches are merged into their full union, including transitive overlaps, so a
shorter high-priority match cannot leave another match's tail exposed. One
placeholder represents each region. Priority is email, SSN, national IDs in
registry order, card, phone. Changing this algorithm requires changing
`PII_REDACTION_VERSION` before binding it into approvals.

Keep the legacy count API's category order and independent category counts.
For example, a phone-shaped email local part still counts as both categories,
while redaction produces one email placeholder. Counts are detector findings,
not replacement-region counts. This explicitly retains the existing count
profile's overlap difference from suite contract 0001; resolving legacy
count semantics is a separate compatibility change, not silently included
here. The transformation uses the contract's one-region/one-category approach.
All ten international categories remain opt-in. Existing regex boundaries,
checksum rules, false-positive measurements and documented misses are unchanged.

## Safety boundary

This function accepts complete decoded text, not arbitrary serialized JSON
or streaming chunks. A caller must traverse decoded structured payloads,
handle non-string values and unsafe key transformations, and validate the
result against the destination schema. Escaped JSON can otherwise evade a
text scan. All content channels, including tool arguments and thinking events,
must be considered in the final-byte review.

No policy enum, route or provider behavior changes in this slice. ADR-0137
remains proposed. Final-byte policy rechecks, original/effective approval
digests, bounded buffering, cancellation/error handling and cache integration
must be implemented and tested before exposing `redact` to administrators.

## Verification

- 103 new redaction tests: all 36 positive vectors, 39 negatives, nine known
  misses, every international visitor, overlaps, Unicode offsets, opt-in
  behavior, count-only metadata, escaped text and reentrant visitors.
- Existing 97 conformance and 17 base tests pass unchanged, including fresh
  random-corpus measurements. This is not a production detector-quality claim.
- Entire shared package: 40 files, 1,019 tests passed.
- Shared build and gateway typecheck passed.
- One initial new assertion incorrectly assumed every positive fixture was
  bare text; the JSON-wrapped CPF fixture now explicitly asserts preservation
  of its surrounding JSON. No production code change was needed for that failure.

Tests used the installed Vitest binary. The ambient pnpm launcher attempted
an install and refused a non-interactive modules purge; no dependency update
was authorized or performed. Gateway integration tests are still required
for the eventual enabling change.

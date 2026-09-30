# ADR-0131 - Scoped signed-report audit proof

- Status: Accepted
- Date: 2026-09-30
- Finding: AER-007 and AER-009
- Supersedes: ADR-0116's full-payload claim for non-admin report exports

## Decision

An entitled non-admin may export a report they can read, but not unrelated
organization-wide audit payloads. Such bundles use schema
`regulait.export-bundle/2`: every row in the contiguous segment carries its
signed sequence and hash commitments, while only rows whose `objectId` is the
report run id include canonical payload bytes. The signed manifest declares
`audit.payloadScope=subject`, and the fifth chain column distinguishes
`payload` from `commitment`. Admin-only report and audit exports retain the
version-1 full-payload format for compatibility.

The offline verifier checks the pinned signing key, signed manifest, file
digests, sequence, linkage and row hashes. It independently rehashes every
disclosed payload and rejects payload files not named by the chain, including
when the chain is empty. For commitment-only rows it cannot rehash undisclosed
source bytes. The README and verifier say this plainly; a valid signature is
not proof that the operator's source database was truthful or complete.

## Verification

The report route must deny a non-member, then let an entitled non-admin export
and verify offline with a pinned fingerprint. An unrelated synthetic audit
sentinel must not appear in any disclosed payload. The existing full-payload
admin attack, rotation and CSV/JSON tests remain green. A stray audit payload
must be refused by the verifier.

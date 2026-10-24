# ADR-0141 - Structured PII transformation and prepared consent

- Status: Accepted
- Date: 2026-09-30
- Scope: shared transformation/consent primitives; gateway redaction still disabled

## Decision

Extend ADR-0140 from complete text to decoded JSON values. `redactPiiPayload`
walks parsed string leaves using the same validators, returns a separate deeply
frozen result, and aggregates category counts. It never mutates caller input.
Enabled national-ID categories remain opt-in; unsupported category names refuse.

Refuse detected PII in property names or numeric values. Renaming keys can
collide or change an operation, and changing a numeric argument into a string
placeholder can violate the tool schema. Non-finite/unsafe integers, unsupported
JavaScript values, accessors, hidden/symbol properties, sparse/decorated arrays
and cycles also refuse rather than being silently omitted by serialization.
Ordinary JSON `__proto__` keys remain own data properties, not prototype setters.

The default hard bounds are depth 64, 20,000 value nodes and 1,000,000 cumulative
decoded UTF-16 code units including keys. Callers may tighten, not raise, these
limits. These bound this transformation, not the upstream HTTP/SDK allocation
or provider stream. Errors carry fixed codes only, never offending values/paths.

`preparePiiApproval` produces an action-scoped immutable snapshot containing:

- the original canonical argument digest, including project attribution;
- the effective canonical argument digest;
- text and structured-transform versions and the normalized category set;
- a separately namespaced combined consent digest;
- the frozen effective arguments and a credential-scrubbed effective preview.

Different original requests remain different consents even when their redacted
arguments are identical. A policy-category or algorithm-version change changes
the combined digest even when no PII matched. Existing raw-only v1 digest
behavior stays unchanged and cannot equal the new combined identity.

The preview never includes the original payload. It uses the existing credential
scrubber, with the preparation depth capped at that scrubber's exported bound
(24) so a deep credential cannot silently pass beyond its traversal. Preview
and effective payload are frozen separately. A discovered scrubber defect was
also corrected: assigning `next["__proto__"]` could drop that data key or change
the preview prototype when another field was scrubbed. Define own properties
instead; the new regression verifies the key survives without exposing secrets.

## Integration obligations

Preparation is not authorization. The gateway still must use the combined
digest for queue deduplication, matching and atomic consumption; force exact
action scope; show the effective preview; revalidate destination schemas;
recheck live policy at the final call; and send that same frozen effective
payload. Neither this helper nor the policy API currently enables `redact`.
Opaque/binary content and nested serialization inside a string are not decoded
by this JSON walker. Signed thinking cannot be edited as ordinary text without
invalidating its signature; its final redaction disposition remains open.

## Verification

54 payload tests and 12 prepared-consent tests cover the existing positive
vectors, escapes, structural refusal, limits, immutable snapshots, distinct
originals, attribution, category/algorithm changes, preview confidentiality
and deep/prototype-shaped inputs. Existing approval and audit-scrub tests pass.
The full shared suite passes 42 files / 1,085 tests; shared build and gateway
typecheck pass. These tests prove the primitives, not end-to-end MCP redaction.

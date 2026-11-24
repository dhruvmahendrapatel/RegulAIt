# ADR-0367: Signed offline detection-content feed

- **Status**: Proposed
- **Date**: 2026-11-17
- **Related**: ADR-0186 (vendored detection), ADR-0158 (curated feed), ADR-0015 (no pooled telemetry), ADR-0176, ADR-0180

## Context and open-source comparison

C2 closes the shared-intelligence distribution gap with a signed offline content import rather than cross-customer
telemetry. Before implementation, the official GitHub projects and documentation were compared:

1. [python-tuf](https://github.com/theupdateframework/python-tuf), Apache-2.0, maintained (repository pushed
   2026-11-16; v7.0.1 release 2026-09-01). TUF offers delegated roles, threshold keys, expiry and repository metadata.
   It fits a software-update repository, but would introduce a separate Python runtime and delegation, expiry and repository metadata beyond the
   existing offline data contract. This slice does not claim TUF conformance or equivalent compromise resilience.
2. [DSSE](https://github.com/dsse-lf/dsse), Apache-2.0, maintained (repository pushed 2026-11-16). Its typed envelope
   separates signed payload bytes and signatures; adopting it would add a new envelope alongside the existing
   catalogue format, without supplying this product's rollback policy or rule validation.
3. The existing ADR-0256 MCP catalogue bundle already pins Ed25519 keys, verifies exact bytes before parsing JSON,
   and signs locally. Reuse it: extract the common keyring/signature and offline-signing code, keeping the catalogue
   format, route behavior and tests. Existing Node crypto, zod and re2js dependencies are sufficient; no package,
   version or licence is added. Matching and counts reuse ADR-0186, not a new regex engine.

References read through GitHub API before code: repository metadata, README and release documentation for the two
upstream approaches; the current catalogue verifier, keyring and signer. The format remains this product's existing
signed-JSON convention, with a distinct signed purpose and separate trust configuration.

## Decision

- One opt-in stream is stored in `detection_feed`, created **off** by pending `detection_feed.sql`. There is no
  polling, external fetch, publisher service, pooled data or customer-data export.
- The initial signed purpose is `regulait.detection-feed/v1`, with a pinned feed identity, positive safe version,
  source licence/provenance and bounded **injection rules only**. Every unknown field or kind, including secret and
  MCP rules, is rejected. Those kinds require separate enforcement/redaction integration and are not silently loaded.
- Verify the exact UTF-8 signature under an operator-configured Ed25519 public-key ring first, then parse and validate
  the complete document. Reject the whole document if any pattern is invalid, empty-matching, duplicated or over its
  limits. No native-regex fallback and no partially loaded bundle.
- The first accepted feed identity pins the stream. A row lock serializes monotonic version comparison, replacement
  and audit; equal versions, lower versions and another stream are refused. A failed audit rolls installation back.
  Disabling never erases the watermark. The signed original is an intentional verbatim external/configuration-document
  exception to third normal form, retained byte-exact for signature checks, not copied entity references.
- Both enable/disable transitions and replacement of active policy require value-bound `settings_relax`. These are
  existing boolean settings and monotonic-version rules, using the existing step-up and setting-transition machinery;
  no mutable lifecycle/status column or parallel state-machine helper is introduced ahead of E29.
- The admin API lists status, imports a document and changes enablement. All import attempts are audited with bounded
  reason codes and safe counts/digests, never the document, prompt, match or exception text. Existing global admin,
  CSRF and rate-limit gates apply. RLS allows policy reads in governed calls, and only admin/migration writes.
- Every governed call receives its own verified rule snapshot. Reverification checks current trust, signed bytes,
  digest, stream and watermark. Missing/corrupt/untrusted active policy yields an explicit block and buffering flags,
  never an unhandled bypass or a silent built-in-only fallback. No global active registry or unbounded imported-pattern
  cache is used. Feed matching is independent of the static pack switch, additive to built-ins, and bounded by the
  existing effective prompt-injection mode and project floor.

## API and records

`GET /v1/detection-content/feed`, `POST /v1/detection-content/feed/import`, and
`PUT /v1/detection-content/feed/settings` are internal admin routes. Screens belong to design builders; three
KNOWN_UI_GAPS entries point at #453. The API shape and offline workflow are documented in
[DETECTION_FEED.md](../../docs/ops/DETECTION_FEED.md). No numbered migration, journal, STATE, PENDING, ADR-index or board
edit belongs to this lane; only pending SQL and fragments.

## Validation and limits

Tests cover default-off, signatures before parsing, wrong-purpose documents, unsupported kinds, RE2 validation,
rollback/replay, feed-identity reset attempts, concurrent imports, step-up, persisted corruption, trust removal,
watermark retention while off, audit atomicity, application-role write refusal, and a real invoke whose synthetic
phrase is allowed before installation but blocked afterward without a usage charge. Catalogue regression tests
retain the old helper's behavior. A local signer produces both formats without exposing its key.

This is one injection-content stream, not secret-pattern or MCP-content distribution. Existing secret/audit/prose
redaction is unchanged; future secret imports must cover those synchronous paths before they are supported. There is
no polling, expiry/delegation/threshold-key protocol, rollback reset or publisher UI. Rule loading is heuristic and
adds no guarantee of complete detection. Imported detection content requires independent code and security
review before release.

Validation note: the three API-only controls add three documented screen gaps. The existing gap ceiling and its pinned test stay unchanged; the route census currently fails at 76 versus 73. Master approval for an API-only exception or a UI-builder assignment was requested on #935. No READY claim is made while that gate fails.

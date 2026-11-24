# ADR-0367: Signed offline detection-content feed

- **Status**: Proposed
- **Date**: 2026-11-17
- **Related**: ADR-0186 (vendored detection), ADR-0158 (curated feed), ADR-0015 (no pooled telemetry), ADR-0176, ADR-0180

## Context and open-source comparison

C2 closes the shared-intelligence distribution gap with a signed offline content import rather than cross-customer
telemetry. Before implementation, the official GitHub projects and documentation were compared:

1. **TUF.** [python-tuf](https://github.com/theupdateframework/python-tuf) (Apache-2.0) and
   [tuf-js](https://github.com/theupdateframework/tuf-js) (MIT, npm's own TUF client, so no Python runtime is needed;
   the earlier version of this ADR wrongly assumed one). TUF gives delegated roles, threshold keys and expiry. Its
   client model is a repository it refreshes from: root, targets, snapshot and timestamp metadata, where the
   timestamp role's short expiry is the freeze defence and assumes the client can reach the repository. Offline, the
   operator would carry four signed metadata files plus the target into the air gap for every update, and the
   timestamp role would either expire between imports (blocking a correct install) or be given an expiry so long it
   no longer protects against freeze.
2. **DSSE / Sigstore.** [DSSE](https://github.com/dsse-lf/dsse) (Apache-2.0) is already verified in this repository
   in key-only air-gapped mode by `@sigstore/verify` and `@sigstore/bundle` (pinned; `model-signing.ts`, ADR-0216), so
   it would not be a new dependency. DSSE binds a `payloadType` into the signed bytes through PAE. However, the
   library's key path verifies ECDSA P-256 only (measured in ADR-0216). Adopting it would move this feed, and for
   consistency the ADR-0256 MCP catalogue, from Ed25519 to P-256, and change the signer tool and keyrings for both.
3. **JWS.** [jose](https://github.com/panva/jose) (MIT, already pinned) can verify an EdDSA compact JWS with a pinned
   `alg` and a `typ` header, which also binds the purpose into the signed input. It would add a second envelope and key
   encoding (JWK or base64url compact) next to the ADR-0256 bundle, so the same operators would run two signers,
   two keyring shapes and two rotation procedures for two offline artefacts of the same kind.
4. **minisign.** Ed25519 file signatures, by default over a BLAKE2b prehash, with a trusted comment. On npm (checked
   2026-11-24):
   - `minisign` (ISC) was last released in 2022, which fails the maintenance test;
   - `@kaito-tokyo/minisign-verify` (Apache-2.0) is at 0.1.4 (April 2026), pre-1.0 with one maintainer;
   - `@threema/wasm-minisign-verify` is a WebAssembly release candidate.
   
   It would also be a third signature format next to the catalogue bundle, with no rollback or purpose semantics of
   its own.
5. **The existing ADR-0256 MCP catalogue bundle.** It already pins Ed25519 keys, verifies exact bytes before parsing
   JSON, and signs locally. Its keyring and signature check use `node:crypto` primitives only; no cryptography is
   written by hand. This slice extracts that common keyring and verifier (`signed-bundle.ts`) and the offline signer
   (`scripts/lib/offline-bundle.mjs`) so both artefacts share one implementation. Existing zod and re2js are reused;
   no package, version or licence is added. Matching and counts reuse ADR-0186, not a new regex engine.

**ADR-0176 §4 exception, written down.** We keep the ADR-0256 envelope instead of adopting TUF, DSSE or JWS, for
these unmet requirements:

- **One Ed25519 offline format for both signed artefacts** (catalogue and detection feed): one signer, one keyring
  shape and one key-rotation procedure for the operator. The Sigstore key path is P-256 only, and JWS would be a
  second envelope.
- **Freeze protection without an online timestamp role.** Air-gapped imports have no repository to refresh from.
  This ADR handles freeze with a signed, monotonic `issuedAt` and an audited age signal instead (see Decision).

The purpose is still signed: `format` is inside the signed bytes and must equal `regulait.detection-feed/v1` exactly.
The feed and the catalogue also use separate keyrings, so a catalogue signature cannot be presented as a feed.

**Re-check this exception when any of these happens:**

- the catalogue format moves to DSSE or JWS;
- `@sigstore/verify` gains an Ed25519 key path;
- the product gains an online update channel, where TUF's timestamp role works as designed.

References were read through the GitHub API before the code was written: repository metadata, READMEs and release
documentation for TUF, tuf-js, DSSE, jose and minisign; the current catalogue verifier, keyring and signer; and
`model-signing.ts`.

## Decision

- One opt-in stream is stored in `detection_feed`, created **off** by pending `detection_feed.sql`. There is no
  polling, external fetch, publisher service, pooled data or customer-data export.
- The initial signed purpose is `regulait.detection-feed/v1`, with a pinned feed identity, positive safe version, a
  signed UTC `issuedAt`, source licence/provenance and bounded **injection rules only**. Every unknown field or kind, including secret and
  MCP rules, is rejected. Those kinds require separate enforcement/redaction integration and are not silently loaded.
- Verify the exact UTF-8 signature under an operator-configured Ed25519 public-key ring first, then parse and validate
  the complete document. Reject the whole document if any pattern is invalid, empty-matching, duplicated or over its
  limits. No native-regex fallback and no partially loaded bundle.
- The first accepted feed identity pins the stream. A row lock serializes monotonic version comparison, replacement
  and audit; equal versions, lower versions and another stream are refused. The signed `issuedAt` must also be later
  than the installed one (`issued_not_newer`) and no more than five minutes ahead of the gateway clock
  (`issued_in_future`), so a post-dated feed cannot pre-empt later genuine ones. A failed audit rolls installation back.
- **Freeze signal (no polling).** `GET …/feed` returns `issuedAt`, its age and `stale` once the age exceeds 30 days
  (`DETECTION_FEED_MAX_AGE_DAYS`). The daily `detection-feed-health-sweep` job writes a `health_stale` audit row while
  that holds. Staleness is reported, not blocked: blocking every call because an air-gapped site has not imported
  recently would turn a missed update into an outage.
  Disabling never erases the watermark. The signed original is an intentional verbatim external/configuration-document
  exception to third normal form, retained byte-exact for signature checks, not copied entity references. `feed_id`,
  `version`, `digest` and `issued_at` are derived from it on purpose (ADR-0200 exception, commented on the columns):
  they are the watermark compared under the row lock, and every read cross-checks them against the signed bytes.
- Both enable/disable transitions and replacement of active policy require value-bound `settings_relax`. These are
  existing boolean settings and monotonic-version rules, using the existing step-up and setting-transition machinery;
  no mutable lifecycle/status column or parallel state-machine helper is introduced ahead of E29.
- The admin API lists status, imports a document and changes enablement. All import attempts are audited with bounded
  reason codes and safe counts/digests, never the document, prompt, match or exception text. Existing global admin,
  CSRF and rate-limit gates apply. RLS allows policy reads in governed calls, and only admin/migration writes.
- **One verified snapshot per change, not per call.** Each governed call reads the row's small metadata (not the
  bundle) and reuses a single cached snapshot keyed by the row's `xmin` (it changes on every update), version, digest,
  feed id, issue time and the keyring fingerprint (SHA-256 over the sorted key ids and public keys). Verification,
  parsing, schema checks and RE2 compilation run only when that key changes. An import, a stored-byte change, or a key
  added to or removed from the keyring therefore still takes effect at the next call. The keyring is parsed once per
  configuration; a keyring file is checked with an asynchronous `stat` and re-read only when it changes. The cache has
  one slot and is bounded by the feed's own limits.
- **Fail closed, whatever the mode.** An enabled feed that is missing, corrupt or no longer verifies under the
  current keyring blocks **every governed call**, in every phase, with `feed_unavailable`, even when the effective
  prompt-injection mode is `off`. It also sets the buffering flags, so nothing streams partially. This is
  deliberate (ADR-0180): an admin turned the feed on, and a silent fallback to built-ins would hide the fault. The
  gateway logs a warning at startup, `GET …/feed` reports `available:false` with `unavailableCode`, and the daily
  health job writes a `health_unavailable` audit row while it lasts. To rotate keys safely, add the new key, import a
  newer version signed by it, and only then remove the old key. The admin can also turn the feed off (step-up)
  to restore traffic.
- When the feed verifies, its rules follow the effective prompt-injection mode and project floor, are independent of
  the static pack switch, and only add to built-in and vendored content.

## API and records

`GET /v1/detection-content/feed`, `POST /v1/detection-content/feed/import`, and
`PUT /v1/detection-content/feed/settings` are internal admin routes. Refusals on both write routes (step-up,
unavailable feed, missing state) are audited. Screens belong to design builders; three
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
no polling, delegation/threshold-key protocol, hard expiry, rollback reset or publisher UI. Rule loading is heuristic and
adds no guarantee of complete detection. Imported detection content requires independent code and security
review before release.

Validation note: the three API-only controls are listed as documented screen gaps in
`scripts/known-ui-gaps/adr-0367-c2-detection-feed.json` (tracked on #453), and the route census passes.

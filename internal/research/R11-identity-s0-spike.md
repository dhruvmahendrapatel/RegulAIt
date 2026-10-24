# R11 — ADR-0188 identity libraries, S0 spike

Checked 2026-10-10 UTC. X32; accepted ADR-0188 decisions13–15,20–23 and OWNER DECISION2. Reproducible source: [`spikes/identity-s0`](../../spikes/identity-s0/README.md). Product baseline: `1f6cc6b5`; the spike changes no gateway, shared, database, workspace or CI source.

## Decision

**GO for the library choice in OWNER DECISION2:** `oidc-provider`9.12.2, `oauth4webapi`3.8.8 and `pkijs`3.4.1 can support the accepted profile with owned validation around their cryptography and protocol machinery. The prototype runs under the actual Fastify5.12.5 gateway hooks, uses real Postgres, and repeats assertion/AS-DPoP/RS-DPoP races across **two separate OS processes** with independent provider instances, HTTP listeners and pools. The atomic store gives one winner. No provider fork or patch is required.

This is a library-feasibility decision, not a claim that S1–S5, product workload authentication or the delegation kernel have shipped. Product admission still requires Claude to exact-pin the approved closure in the owned product lockfile and carry the notices. The isolated npm lock is the reviewable candidate; it does not silently alter that lockfile. The `jose` fallback/ADR-0176 exception is unnecessary on this measured result; a future pinned-hook contract failure would reopen NO-GO.

## Measured evidence

The final suite command is in the spike README. It exercises real library code, actual HTTP/TLS and a disposable migrated database. Counts and final commit are recorded in `codexInputs.md` and the task board after validation; no browser or deployed multi-host measurement is implied by the spike.

| Boundary | Observation and independent negative/control |
|---|---|
| Existing gateway hooks | Authentication refuses missing transport admission; actual session CSRF refuses a missing header; the actual route-class hook refuses a non-admin session; actual body parser refuses an oversized form before Koa; the Postgres IP/credential limiter returns429 before the provider. The mount uses a16KiB/1s fixture limit to make the controls observable. |
| Provider mounting | A bounded raw-body reconstruction happens **after** Fastify preHandler, rather than hijacking before authentication. The callback's completion is awaited through response finish/close, with a bounded timeout. A timed-out request closes, never creates a late token, and leaves a499 refusal in the actual chained audit. |
| Shared provider state | A real provider `Grant.save()` on one adapter is found and destroyed through the other provider/adapter. No in-memory adapter backs the accepted result. |
| Original replay race | Barrier-controlled ordinary Postgres find/upsert returns`[true,true]` for the same provider replay id. This is the genuine unsafe control, not an assumed old defect. |
| Atomic replay | An autocommit `INSERT ... ON CONFLICT DO NOTHING RETURNING key` owns uniqueness. Assertion duplicates return one200 and one401`invalid_client`; AS DPoP duplicates return one200 and one400`invalid_dpop_proof`; RS DPoP duplicates return one200 and one401. The losing request cannot roll back or overwrite the winner. Later grant failure and timeout do not free a used assertion. |
| Strict AS/RS DPoP | ES256 and EdDSA client assertions and output proof bindings work. Missing/stale nonce, old/future proof, wrong method/endpoint/token hash, another signing key and replay refuse. A nonce challenge on replica A retries at B with the same still-unused assertion. Unknown/unbound/doubly bound token shapes refuse; the mTLS branch accepts no DPoP fallback. |
| Human root exchange | The signed one-use root proof binds the registered child, its output key and the exact delegated fixture fields. Parallel use succeeds once. The output binds to the child key and rebuilds `act`; a caller-supplied actor chain is ignored. |
| Parent→child exchange | A's actual bound key signs the decision23 authorization. Changing the authenticated child, output key, scope, resource, project, environment, cap, depth, expiry or idempotency key refuses **before the client-assertion or delegation-authorization claim**. The genuine unchanged authorization then succeeds. A reused authorization with a fresh assertion and DPoP refuses. Output is bound to B; revoking the parent grant refuses its descendant at the next use. |
| Live checks | The proposed wrapper rereads the issued-token binding and fixture ancestors, identity, credential and sponsor status per request. Revocation/status changes on another replica refuse the next use. Signature validity does not bypass the lookup. |
| Offline X.509/SPIFFE | Actual ECDSA certificates validate through PKIJS against the locally supplied CA, including an uploaded intermediate. Unknown CA, missing intermediate, expired/not-yet-valid leaf, leaf CA, missing digitalSignature, wrong identity/domain and multiple URI SANs refuse. Actual HTTPS requires a client certificate, and its peer certificate passes the same validator. |
| mTLS/JWT-SVID | `jose` verifies the token signature; PKIJS validates the certificate; the x5t hash must match the validated DER certificate. Absent/wrong certificate and cross-process mTLS-parent handoff refuse. A JWT-SVID signature/audience verifies against a locally uploaded key and wrong audience refuses. This JWT-SVID case is a cryptographic bundle check, not product SPIFFE enrollment. |
| Audit | The real chained audit writer records completed token issues/refusals plus the timeout refusal. Rows retain a chain hash, fixed route, outcome and synthetic action; no assertion, access token, certificate, model text or private key is stored in the detail. |

## Two integration details S5 must retain

**Check the entire delegation authorization before the first claim.** A custom grant handler alone is too late: `oidc-provider` authenticates and claims the client assertion before invoking that handler. Its public `assertJwtClientAuthClaimsAndHeader` hook runs after assertion signature verification and before `ReplayDetection.unique`. The spike validates the DPoP key and root/child/body bindings there, then makes the first claim. An adapter guard and the changed-body negatives fail if a future provider version moves that hook. Putting only the authorization claim after body verification would leave the client-assertion claim in the wrong order.

**Use the owned DPoP profile in the custom grant.** The provider's built-in nonce helper uses HKDF over60s slots with a wider acceptance window; it does not implement decision20's5-minute HMAC nonce profile or decision13's60s freshness rule. The custom grant verifies the embedded public-key signature using the already pinned `jose`, enforces the owned HMAC nonce/freshness/method/endpoint rules, and uses the pinned `checkDpopReplay` helper for the provider's atomic refusal path. `buildTokenResponse` supplies the RFC8693 response fields. No monkey patch or provider internal nonce override is used. Both imported helpers and the pre-claim order are covered by contract checks.

The resource wrapper uses `oauth4webapi.validateJwtAccessToken(requireDPoP:true)` for JWT/DPoP cryptography, supplies only local public keys, then enforces nonce/freshness, issued binding, live chain and its own atomic RS replay claim. A120s-old/no-nonce proof passes the bare library control and is refused by the wrapper. mTLS uses the separate `jose`+PKIJS path because the library does not validate `cnf.x5t#S256`.

## Exact closure and notices

Candidate direct pins: provider9.12.2; oauth4webapi3.8.8; jose6.2.12; pkijs3.4.1; asn1js3.0.10; pg8.23.1; Fastify5.12.5. The latter five match the measured existing workspace versions; no earlier `jose` or PG version is substituted for the gateway's current pin.

The complete isolated runtime closure, including installed optional packages, is **109 packages:95MIT,7BSD-3-Clause,6ISC,1zero-clause BSD**. The licence checker validates the exact installed manifests, tarball-integrity lock, notice hashes and preserved text; no GPL/AGPL/SSPL/BSL or unclassified dependency was found. `npm audit --omit=dev --json` for **this isolated exact closure** reports0advisories of every severity; this is not a whole-repository audit or future-advisory assurance.

Lock SHA-256: `99debbe1c88df4e3eaafe80579d89d9fdf271192f489394cd8fd4789824ccb14`.

[`licence-inventory.json`](../../spikes/identity-s0/licence-inventory.json) names each version, tarball, integrity, notice source and hash. [`THIRD_PARTY.md`](../../spikes/identity-s0/THIRD_PARTY.md) preserves all licence texts plus the provider's bundled-code notices. `koa-compose`'s MIT notice is preserved from the provider notice file; PG helper notices come from the installed README sections. `abstract-logging` ships a MIT link instead of text; the linked site returned403, so the same publisher service's pinned MIT template and author profile supply the preserved notice, without inventing a copyright year. Exact primary-source provenance is in [`notices/SOURCES.md`](../../spikes/identity-s0/notices/SOURCES.md).

## Scope still owned by the build slices

- The prototype's bootstrap-authenticated bridge proves the existing hooks still execute. It does not install the future `/oauth/token` workload route class, allow an external workload credential through the human API path, or prove deployed TLS/proxy configuration. S5 owns those changes and their actual admission tests; the forwarded-header controls here use explicitly injected transport facts.
- Fixture live rows are deliberately small. S1/S3 must provide the frozen provenance schema, cycle/path consistency, every actor's **current own grants**, sponsor entitlement intersection, scope/depth/lifetime checks and integer edge-budget accounting. The S0 grant fixture does not claim to implement those checks or charge settlement.
- The small canonicalizer covers string/array/integer fixture values only. S3 must use the accepted RFC8785 implementation for the complete product body. A genuine signature over changed fields is not a scope grant; policy checks remain mandatory.
- Uploaded trust bundles are validated offline, with no discovery or network fallback. There is no actual multi-host deployment, HSM/key custody, proxy mTLS deployment, certificate revocation infrastructure, whole-product SBOM/signing or network-egress isolation proof here. Install-time registry access is separate from the offline runtime validators.
- Suite-agent confirmation of PF-02 remains the accepted gate before S5 freezes the wire contract. The spike does not waive it.

## Primary references checked

Installed sources and exact npm tarballs were checked2026-10-10; lock integrity identifies the admitted bytes. The RFC/SPIFFE links below identify the governing wire/profile specifications, not a claim of a fresh live-body fetch in this environment.

- [Provider9.12.2](https://www.npmjs.com/package/oidc-provider/v/9.12.2): installed `lib/models/replay_detection.js`, `lib/shared/jwt_client_auth.js`, `lib/helpers/grants.js`, `lib/helpers/challenge.js`, `LICENSE.md`, `THIRD-PARTY-NOTICES.md`; [upstream](https://github.com/panva/node-oidc-provider).
- [oauth4webapi3.8.8](https://www.npmjs.com/package/oauth4webapi/v/3.8.8): installed `validateJwtAccessToken` implementation and MIT text; [upstream](https://github.com/panva/oauth4webapi).
- [PKIJS3.4.1](https://www.npmjs.com/package/pkijs/v/3.4.1): installed `CertificateChainValidationEngine`, certificate/profile structures and BSD-3-Clause text; [upstream](https://github.com/PeculiarVentures/PKI.js).
- [RFC8693 token exchange](https://www.rfc-editor.org/rfc/rfc8693), [RFC9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449), [RFC8705 mTLS](https://www.rfc-editor.org/rfc/rfc8705), [SPIFFE X.509-SVID](https://github.com/spiffe/spiffe/blob/main/standards/X509-SVID.md), [JWT-SVID](https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md), [RFC8785 canonical JSON](https://www.rfc-editor.org/rfc/rfc8785).

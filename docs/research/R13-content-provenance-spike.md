# R13: content provenance (Batch 6 item 6, ROADMAP I4), research spike

Checked 2026-10-10 UTC against `main` @ `fb24991`. This is research only. No product code changed. It feeds a future
ADR for ADR-0183 §1 batch 6 item 6 ("content provenance (I4)"). An earlier agent started the item and has been
retired; this spike replaces that work.

> **File name.** `R13-isolation-i0-spike.md` already uses the R13 number. This note keeps the name it was assigned. The
> owner may renumber it to R14 when the ADR cites it.

## Decision summary

**Recommendation: Option B.** This splits into three parts:

1. **A native provenance label and content digest are the authority.** Our own code builds them at the gateway's
   interception point, because they are policy semantics (ADR-0176 §4). Each label is bound into the audit chain and
   the receipt stream we already have, and is signed with the ADR-0186 receipt key under a new `v` domain.
2. **An in-toto Statement v1 in a DSSE envelope is the standard export view.** It is optionally wrapped in a Sigstore
   bundle v0.3 that uses a public-key hint and our own RFC 3161 token. It is verifiable offline with the maintained,
   Apache-2.0 `@sigstore/*` packages.
3. **C2PA is deferred to a later, opt-in slice for binary media and documents only.** Plain text and JSON stay out of
   it. W3C Verifiable Credentials are not adopted.

The largest finding concerns what we already have. **Nothing we hold today proves anything about content.** Receipts
are signed on the *decision* row, before execution. The Decision BOM records inputs only by digest and outcomes only
by status. No table stores a digest of a tool result or a model output (§1.3). Signing is also only half of I4. The
half a buyer asks for is the trust label and the rule that low-trust content cannot carry high action authority, and
no library provides that (§1.4).

## 1. What we already have

### 1.1 The audit chain (ADR-0060, ADR-0067)

`audit_log` is linked with SHA-256 over a pinned canonical serialisation (`packages/shared/src/audit-chain.ts`). Anchors
in `audit_anchors` go to WORM storage, with RFC 3161 tokens under ADR-0186 S. Together these prove that a row existed in
the sequence before an anchor was flushed, and that nothing in the chain has been altered since. They cannot prove that
a row which was never written is missing.

### 1.2 Signed decision receipts (ADR-0186 R)

A single-writer sweep signs every receipt-eligible audit row with Ed25519 over RFC 8785 canonical JSON. "Receipt-
eligible" means `objectType` in `mcp_tool | agent | connector | approval` and `detail.receiptClass = decision`.

- **v1 payload:** `{v, receiptSeq, prev, keyId, audit:{id, seq, rowHash, contentHash}, decision:{at, userId,
  objectType, objectId, serverId, toolName, ruleId, effect}}`.
- **v2 payload:** adds `actor` and `factsStatus/factsHash`. These were added by ADR-0189 R34, and the schema is in
  `packages/shared/src/receipts/verify.ts`.
- **Verification:** an offline verifier exists (`scripts/verify-receipts.mjs`). It states its own limits in
  `RECEIPT_CANNOT_PROVE`: omission, correctness, signing time without anchor evidence, key trust, and compromise.

The governed paths write the receipt-class row at the moment of the policy decision. An example is
`apps/gateway/src/mcp-proxy.ts`, around line 506 (the `receiptClass: "decision"` detail). The effect is
`allow | deny | require_approval`. **A receipt therefore says that a call was allowed. It says nothing about what came
back.**

### 1.3 The Decision BOM (ADR-0189)

`regulait.decision-bom.v1` captures `action` inputs "by digest and classification only" and an `outcome` section of
"result status, refusal code, upstream status class, post-action verification result". It never captures a digest of
the result. Raw content in a BOM is a non-relaxable invariant ("never"; ADR-0189 settings table and OWNER DECISION 5).

ADR-0189 OWNER DECISION 1 already chose an in-toto Statement in a DSSE envelope as an optional export view. ADR-0189
OWNER DECISION 2 chose to reuse the receipt key with domain separation by `v`. Both precedents carry straight over to
this item.

A search of `apps/gateway/src`, `packages/shared/src` and `packages/db/src` for `output|result|response` together with
`digest|hash|sha` found no stored digest of tool or model output. The only matches were three unrelated helpers in
`eu-ai-act.ts`, `forecasting.ts` and `redteam-stats.ts`.

### 1.4 Trust levels

There is no trust-level or taint field anywhere in the gateway or shared code. A search for `trust_level`,
`trustLevel` and `taint` returned no matches. ROADMAP §7.2 I4 asks for two things:

- tag retrieved content and tool output with a source trust level, and refuse to let low-trust content carry high
  action authority;
- an instruction-hierarchy boundary.

ROADMAP §7.3 calls the injection detector "a detector, not a defense" until a provenance model exists. **No signing
standard below does either of these things.** Signatures prove the origin and integrity of bytes. They do not decide
what those bytes may cause.

### 1.5 What follows from this

Every option below needs the same groundwork, which is our own code:

- **A content digest** at the interception point: SHA-256 over the exact bytes delivered onward, and separately over
  the bytes received upstream when redaction or PII masking changed them.
- **A provenance label:** source kind, server, tool, connector or model, served model, trust tier and classification.
- **A binding** of the digest and label into the audit row's content hash, so they are covered by the existing chain
  and anchors.

The options differ only in how that fact is signed and exported for a verifier outside our boundary.

## 2. Candidates

Facts are sourced in §6. "Maintained" means a release within the 12 months before 2026-10-10.

### 2.1 C2PA manifests (Content Credentials)

| Property | Finding |
|---|---|
| Standard | C2PA specification 2.4 is current [S1]. Ed25519 is allowed ("Ed25519 instance only") [S2 §13.2]. Signing credentials must be X.509 certificates [S2 §5.3.5]. The C2PA Trust List is limited to certificates with the `c2pa-kp-claimSigning` EKU [S2 §5.3.3]. Validators must include the C2PA Trust List and may add other trust anchors; a user-driven private credential store must ship empty [S2 §14.4]. Version 2.4 adds a `c2pa.ai-disclosure` assertion [S2 §5.3.1] |
| SDK, licence and maintenance | The Rust SDK `c2pa` crate 0.91.2 is `MIT OR Apache-2.0`, released 2026-10-06 [S3]. The Node binding `@contentauth/c2pa-node` 0.9.9 is MIT, released 2026-09-30 [S4]. The older `c2pa-node` package was last released on 2025-08-16 and is superseded [S4] |
| Air-gapped | **Runtime: yes, with configuration.** Online OCSP is optional, and skipping it gives `signingCredential.ocsp.skipped` [S2 §15.9]. Remote-manifest fetching and HTTP are separate crate features (`fetch_remote_manifests`, `default_http`, `http_*`), and there is a `rust_native_crypto` feature [S3]. **Install: not by default.** The Node package's `postinstall` downloads a prebuilt native binary from the project's release page unless `SKIP_BINARY_DOWNLOAD` or `C2PA_LIBRARY_PATH` is set. It falls back to a local `cargo` build (read in the 0.9.9 tarball [S4]). An air-gapped build has to vendor the binary or build it from source |
| Node/TS | A native (Neon) addon with TypeScript types. It adds a Rust toolchain or a vendored per-platform binary to our build |
| What it proves | A manifest binds assertions (actions, ingredients, digital source type, AI disclosure) to an asset's bytes through a hash, signed by an X.509 identity. RFC 3161 tokens let a signature stay valid after the certificate expires [S2 §15.8] |
| What it cannot prove | That the content is true. That a stripped or never-signed asset is unprovenanced. "Trusted" status for a signer outside the C2PA Trust List, so a self-run or air-gapped customer CA shows as untrusted to stock validators unless they add it [S2 §14.4]. **Plain text is weak.** The spec embeds the manifest as invisible Unicode variation selectors after a U+FEFF, hashes NFC-normalised text, says to use this only "where no other embedding method is feasible", and says it "remains under review" [S2 App. A.8]. The Rust SDK gates it behind `unstable_plain_text` [S3]. JSON tool results have no embedding at all |
| Fit with receipts, BOM and audit | Weak for our main content: model text and JSON tool results. A good fit for **generated binary artefacts** (images, PDFs, office documents), where an `ingredients` or `actions` assertion could carry the receipt hash and audit id. It needs a second key type (an X.509 leaf with C2PA EKU) beside the Ed25519 receipt key |

### 2.2 in-toto attestations in DSSE envelopes (SLSA-style)

| Property | Finding |
|---|---|
| Standard | **Statement v1:** `_type`, a `subject` list of ResourceDescriptors where every element "MUST have `digest` set", `predicateType` (a URI) and `predicate` [S5]. **DSSE:** the signature covers `PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body`, so the payload type is authenticated [S6] |
| Library, licence and maintenance | No standalone npm package for in-toto or DSSE exists: `in-toto-attestation`, `@in-toto/attestation` and `dsse` all return 404 [S7]. `@sigstore/core` 4.0.1 (Apache-2.0, 2026-06-25) exports `preAuthEncoding` [S7] (read in the tarball). `@sigstore/verify` 4.1.2 (Apache-2.0, 2026-08-04) verifies DSSE envelopes [S7] |
| Air-gapped | Yes. PAE plus an Ed25519 signature is pure computation over local bytes |
| Node/TS | Yes, through `@sigstore/core`, or by computing PAE directly with Node `crypto` |
| What it proves | A key holder asserted the typed predicate about the subjects named by digest, with the payload type bound into the signature |
| What it cannot prove | Signing time (no timestamp unless one is added). Key trust (out of band). Truth of the predicate. Completeness |
| Fit with receipts, BOM and audit | **The best structural fit of all the candidates for content.** A tool result or model output *has* a digest, so it is a natural `subject`. That is the reason ADR-0189 option D rejected in-toto for decisions, and the reason does not apply here. The predicate carries the provenance label, the audit id and seq, the receipt seq and payload hash, and the trust tier. It can be signed with the receipt key, with the predicate type as domain separation |

### 2.3 Sigstore bundles

| Property | Finding |
|---|---|
| Standard | Bundle v0.3 (`application/vnd.dev.sigstore.bundle.v0.3+json`). The verification material is either an X.509 certificate or a **public-key hint** for a key delivered out of band. Transparency-log entries are optional and "strongly encouraged for public bundles". The bundle carries zero or more RFC 3161 timestamps. The content is a `messageSignature` or a `dsseEnvelope` [S8] |
| Library, licence and maintenance | `sigstore` 5.0.0, `@sigstore/sign` 5.0.0 and `@sigstore/bundle` 5.0.0 (2026-06-01); `@sigstore/verify` 4.1.2 (2026-08-04); `@sigstore/protobuf-specs` 0.5.2 (2026-08-21). All are Apache-2.0 [S7]. We already use `cosign` 3.1.3 in CI (ADR-0184), and R7 lists `@sigstore/verify` as a planned candidate (R7 row "@sigstore/verify") |
| Air-gapped | **Yes, if the public good instance is not used.** `@sigstore/verify`'s `Verifier` takes `TrustMaterial` with a `publicKey: KeyFinderFunc` (hint → key) and `tlogThreshold`, `ctlogThreshold` and `timestampThreshold` options (read in the 4.1.2 type declarations [S7]). With thresholds of 0 for the logs and 1 for timestamps, it can verify against our own keys and our own TSA root without any network. The default keyless flow (Fulcio, Rekor and TUF) needs network and an OIDC identity, and does not fit air-gapped use. Signature checks call Node `crypto.verify` with a `KeyObject` (read in `@sigstore/core`), which accepts Ed25519 keys. **This was not exercised at runtime in this spike** |
| Node/TS | Yes, natively. The packages are TypeScript |
| What it proves | The same as DSSE, plus a verifiable signing-time bound when an RFC 3161 token is included |
| What it cannot prove | Key trust when there is no transparency log or certificate identity (we would supply it, as our receipts already do). Omission. Truth |
| Fit with receipts, BOM and audit | A wrapper around the DSSE view (§2.2). It can carry the ADR-0186 S RFC 3161 token for the anchor that covers the row. The `keyId` from `receipt_signing_keys` serves as the public-key hint, so the same pinned key file verifies receipts and bundles. Gives buyers a format their existing tooling understands |

### 2.4 W3C Verifiable Credentials

| Property | Finding |
|---|---|
| Standard | VC Data Model 2.0 has been a W3C Recommendation since 15 May 2025 [S9]. It can be secured with Data Integrity or with JOSE/COSE (`application/vc+jwt`, `application/vc+cose`); VC-JOSE-COSE has also been a Recommendation since 15 May 2025 [S10]. The EdDSA cryptosuites `eddsa-rdfc-2022` and `eddsa-jcs-2022` (JCS/RFC 8785) became a Recommendation on 15 May 2025 [S11] |
| Libraries, licence and maintenance | `@digitalbazaar/vc` 7.3.0, BSD-3-Clause, 2026-02-05: maintained. `@digitalbazaar/eddsa-rdfc-2022-cryptosuite` 1.3.0, 2026-02-05: maintained. **`@digitalbazaar/eddsa-jcs-2022-cryptosuite` 1.0.0 (2024-11-08) and `@digitalbazaar/data-integrity` 2.5.0 (2024-09-06) fail the 12-month maintenance test.** `jsonld` 9.0.0, BSD-3-Clause, 2025-11-21. `did-jwt-vc` 5.0.1, ISC, 2026-10-01 [S7]. For the JOSE route, `jose` 6.2.12 (MIT) is already pinned in `apps/gateway` |
| Air-gapped | Data Integrity: only with a custom `documentLoader` that serves every JSON-LD context from local files. The default Node loader fetches over the network [S12], and `@digitalbazaar/vc` requires contexts and verification methods to be "reachable via a `documentLoader`" [S13]. The JOSE route: yes |
| Node/TS | Yes (JavaScript with types, or `jose`) |
| What it proves | An issuer made claims about a *subject entity* |
| What it cannot prove | The same as the others. Its model is also issuer → holder → verifier claims about entities, not provenance of a byte artefact |
| Fit with receipts, BOM and audit | Poor. A content-provenance record has no holder. JSON-LD canonicalisation (RDFC) would add a second canonicaliser beside RFC 8785, and it was the riskiest part of our byte-identity work (R12). The JCS cryptosuite avoids that, but its library fails the maintenance test. A VC secured with JOSE adds nothing over DSSE for this use. **Not adopted.** It stays a candidate for *identity* claims (agent and workload credentials, ADR-0188), which is a different item |

### 2.5 Summary

| Candidate | Licence OK | Maintained | Air-gapped runtime | Node/TS | Fits text and JSON outputs | Fits binary artefacts | New key type |
|---|---|---|---|---|---|---|---|
| Native label and receipt-key signature | n/a (ours) | n/a | yes | yes | yes | yes | no |
| in-toto Statement v1 + DSSE | Apache-2.0 (`@sigstore/core`) | yes | yes | yes | **yes** | yes (sidecar) | no |
| Sigstore bundle v0.3 (own key + RFC 3161) | Apache-2.0 | yes | yes, not keyless | yes | yes | yes (sidecar) | no |
| C2PA 2.4 via `c2pa` / `c2pa-node` | MIT / Apache-2.0 | yes | runtime yes; install downloads a binary by default | native addon | **no** (text is unstable; JSON has no embedding) | **yes** (embedded) | yes (X.509 + C2PA EKU) |
| W3C VC 2.0 (Data Integrity) | BSD-3 | partly (JCS suite lapsed) | only with a local context loader | yes | weak model fit | weak | no |

## 3. Options

All three include the groundwork in §1.5 and the I4 policy half: trust tiers per source, with the default for every
new MCP server, connector and retrieval source set to `untrusted` (ADR-0180). The policy half is a kernel rule that
refuses a high-authority action when the content that triggered it carries a lower tier. That half is RegulAIt's own
code under every option and is the bulk of the "L" size.

### Option A: native only

Sign a new `regulait.content-provenance.v1` payload with the receipt key. The payload carries the content digest(s),
label, trust tier, audit id and seq, and decision receipt seq and payload hash. It reuses the `decision_receipts` sweep,
or a sibling table and sweep, and the existing verifier and CLI.

- **For:** no new dependency, one key and one verifier, smallest surface.
- **Against:** a closed format. An outside party can check it only with our verifier. This is the thing ADR-0189 calls
  out when it asks for "standards-compatible exports rather than inventing a closed format" for BOMs.

### Option B: native authority plus an in-toto/DSSE export view in a Sigstore bundle (recommended)

Option A, plus an export rendering for each provenance record:

- The **Statement** has `subject` = `[{name: "<audit id>/output", digest: {sha256}}]` (and `/input` when captured),
  `predicateType` = `https://regulait.dev/content-provenance/v1` (the URI is to be chosen), and `predicate` = the
  native payload.
- A **DSSE envelope** is signed with the receipt key, `keyid` = the receipt `keyId`.
- The envelope is wrapped in a **Sigstore bundle v0.3** with `publicKey.hint` = `keyId` and, once the covering anchor
  is timestamped, the ADR-0186 S RFC 3161 token in `timestampVerificationData`.
- Verification offline uses `@sigstore/verify` with `tlogThreshold: 0` and `ctlogThreshold: 0`. The verifier's
  `KeyFinderFunc` is fed from the same independently pinned key file that `verify-receipts` uses.

- **For:**
  - A standard envelope and bundle that buyers' supply-chain tooling already handles.
  - The subject digest fits content naturally (§2.2).
  - The same precedent as ADR-0189 OWNER DECISION 1, and still one key.
  - Apache-2.0, maintained, offline, TypeScript.
  - A natural place for the RFC 3161 token we already obtain.
- **Against:**
  - One new dependency family (`@sigstore/verify` and `@sigstore/core`, plus `@sigstore/bundle` if we build bundles
    with the library rather than as JSON).
  - The bundle's timestamp covers the signature bytes. Our RFC 3161 tokens currently cover anchor heads, not individual
    signatures. Either the bundle carries the anchor token as *separate* evidence, which is a custom check, or we
    timestamp each envelope signature, which adds TSA load. This must be settled in the ADR.

### Option C: Option B plus C2PA for generated binary artefacts (opt-in, later)

For artefacts the platform writes as files (images, PDFs, office documents), embed a C2PA 2.4 manifest. It would use a
`c2pa.actions` or AI-disclosure assertion, with a custom assertion carrying the provenance record's digest and receipt
reference. The manifest is signed by an X.509 leaf with `c2pa-kp-claimSigning`, issued by a customer CA (BYOC and
air-gapped) or by a C2PA-listed CA (hosted, which costs money: an attestation-spend item under ADR-0183's production set).

- **For:** provenance travels inside the file and is readable by ordinary media and document tooling. It is the format
  most often cited for machine-readable AI-content marking.
- **Against:**
  - A native addon and a vendored binary in the build.
  - A second key type and a CA to run.
  - Plain text and JSON are not covered robustly (App. A.8 is under review; `unstable_plain_text`).
  - Signers outside the C2PA Trust List show as untrusted on stock validators.

Recommend **deferring** this until a customer or a verified legal duty requires embedded marking.

## 4. Recommendation

**Option B, with C deferred.** Build order for the ADR to consider:

1. **P0, groundwork (ours).** Content digests (delivered, and upstream when different) and a provenance label at every
   governed return path: MCP tool result, connector read, model output, and retrieved context. Both go into the audit
   row's content hash and into `decision_facts` (ADR-0189). Streaming responses are digested over the full stream at
   close.
2. **P1, I4 policy (ours).** Trust tiers with a strict default of `untrusted` for new sources, admin-relaxable and
   audited. A kernel rule makes the action authority of a call depend on the lowest tier of the content in its causal
   context. Then the instruction-hierarchy boundary.
3. **P2, native signed record (Option A).** Receipt key, new `v`, existing verifier extended, and limits stated in the
   verifier's `cannotProve`.
4. **P3, standard export view (Option B).** in-toto Statement, DSSE and a Sigstore bundle. Add `@sigstore/verify` and
   `@sigstore/core` to `THIRD_PARTY.md`, and update R7's row from "soon" to "in use".
5. **Later, Option C** on demand.

### What the signed record proves, and what it cannot

Every export must state these limits, in the same way as `RECEIPT_CANNOT_PROVE`.

**It proves:**

- The RegulAIt gateway holding key K observed bytes with digest D as the output of the governed call recorded at audit
  row N.
- That call was allowed under decision receipt R.
- The bytes carried label L.
- If a timestamp is present, all this held no later than time T.

**It cannot prove:**

- That the upstream tool or model really produced D. We see only what arrived; the upstream does not sign it.
- That the content is true or safe.
- That copies seen downstream are unmodified, unless the holder rehashes them.
- That content without a record is not ours. Detached provenance can be stripped.
- Anything about content after transformation (re-encoding, summarising).
- The content itself. BOM invariant: digests only, so the verifier needs the holder to supply the bytes.

## 5. Open questions for the owner

1. **Scope of I4's first slice.** Signing (P2/P3) can wait, but the trust-tier policy (P1) is what closes ROADMAP
   §7.3's "detector, not a defense". Should the ADR put P0 and P1 first, and P2 and P3 after?
2. **Which bytes are digested.** What upstream returned, what the gateway delivered after redaction or masking, or
   both? Both is recommended. A digest of pre-redaction content is not content, but it may still be a correlation risk
   for low-entropy outputs. Should it be a salted or keyed digest (HMAC with a per-tenant key) when classification is
   `pii`?
3. **Timestamp granularity.** Carry the anchor-level RFC 3161 token as separate evidence (no extra TSA load, custom
   check), or timestamp each envelope signature (standard Sigstore check, more TSA calls)?
4. **Key.** Reuse the receipt key with domain separation, as ADR-0189 did, or use a separate content key?
5. **C2PA.** Defer entirely, or schedule Option C for generated files when a customer asks? If hosted signing should
   validate as "trusted" on stock validators, a C2PA-listed CA certificate is a spend item for the owner.
6. **Machine-readable AI-content marking duty.** R5 lists EU AI Act Art. 50 marking items as UNVERIFIED (primary text
   unreachable from the session proxy). Does a verified duty make Option C a requirement rather than an option?
   Legal review is needed. This spike makes no legal claim.
7. **Trust-tier vocabulary.** How many tiers, who sets a source's tier (server owner or admin), and whether a
   compliance profile (pillar 3 cascade) can force a minimum.

## 6. Sources

All were read on 2026-10-10. Registry facts come from the npm and crates.io JSON APIs. Tarball reads were made in a
scratch directory, and nothing was installed into the repository. GitHub repository pages for `contentauth/*`,
`sigstore/*`, `in-toto/*`, `secure-systems-lab/*` and `digitalbazaar/*` could not be read through the session's GitHub
API proxy (403, repository not attached). That was not routed around, so licences were taken from the registries and
the shipped package files instead.

- [S1] C2PA specifications index, which redirects to 2.4: <https://spec.c2pa.org/specifications/>
- [S2] C2PA Content Credentials specification 2.4:
  <https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html>. Sections used: §5.3.1–5.3.5
  release notes, §13.2, §14.4, §14.5, §15.8, §15.9, App. A.8.
- [S3] crates.io, `c2pa` 0.91.2 (licence, date, feature list): <https://crates.io/api/v1/crates/c2pa/0.91.2>
- [S4] npm, `@contentauth/c2pa-node` 0.9.9 (MIT LICENSE file, `package.json`, `scripts/postinstall.cjs` in the
  tarball): <https://registry.npmjs.org/@contentauth/c2pa-node>. Also `c2pa-node`: <https://registry.npmjs.org/c2pa-node>
- [S5] in-toto Attestation Framework, Statement v1:
  <https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md>
- [S6] DSSE protocol: <https://raw.githubusercontent.com/secure-systems-lab/dsse/master/protocol.md>
- [S7] The npm registry, `https://registry.npmjs.org/<name>`, for `@sigstore/sign`, `@sigstore/verify` (with tarball
  `dist/verifier.d.ts` and `dist/trust/trust.types.d.ts`), `@sigstore/bundle`, `@sigstore/core` (with tarball
  `dist/dsse.d.ts` and `dist/crypto.js`), `@sigstore/tuf`, `sigstore`, `@sigstore/protobuf-specs`, `@digitalbazaar/vc`,
  `@digitalbazaar/data-integrity`, `@digitalbazaar/eddsa-rdfc-2022-cryptosuite`,
  `@digitalbazaar/eddsa-jcs-2022-cryptosuite`, `jsonld` and `did-jwt-vc`. Also the 404 responses for
  `in-toto-attestation`, `@in-toto/attestation` and `dsse`.
- [S8] Sigstore bundle format: <https://docs.sigstore.dev/about/bundle/>
- [S9] W3C, Verifiable Credentials Data Model v2.0, Recommendation 15 May 2025: <https://www.w3.org/TR/vc-data-model-2.0/>
- [S10] W3C, Securing Verifiable Credentials using JOSE and COSE, Recommendation 15 May 2025:
  <https://www.w3.org/TR/vc-jose-cose/>
- [S11] W3C, Data Integrity EdDSA Cryptosuites v1.0, Recommendation 15 May 2025: <https://www.w3.org/TR/vc-di-eddsa/>
- [S12] `jsonld` README, "Custom Document Loader" (npm registry readme): <https://registry.npmjs.org/jsonld>
- [S13] `@digitalbazaar/vc` README (npm registry readme): <https://registry.npmjs.org/@digitalbazaar/vc>

Repository facts were read from the files named inline: ADR-0183, ADR-0186, ADR-0189, ADR-0184, ROADMAP §7.2–7.3,
`packages/shared/src/receipts/*`, `packages/shared/src/audit-chain.ts`, `apps/gateway/src/mcp-proxy.ts`, R7 and R12.

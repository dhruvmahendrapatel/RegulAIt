# ADR-0216: Model-file signatures and unverifiable models as a blocking risk (P14 + P15)

- **Status:** Accepted (builder lane; HOLD PR for the master's review)
- **Date:** 2026-10-30
- **Deciders:** owner (backlog P14 and P15, `internal/product/PENDING.md`; wave 1 of #453 comment 6522850568); the
  conventional defaults below were taken by the builder and are open to the owner
- **Builds on:** ADR-0187 (model artifacts stored by sha256, modelscan, `artifact_scans`, `engine_scan` card evidence),
  ADR-0045/0063 (model risk management and the dispatch gate), ADR-0058/0147 (the risk register and its evidence
  resolvers), ADR-0180 (secure by default), ADR-0176 (open source first), ADR-0186 (step-up)

## Context

An uploaded model artifact is identified by its sha256, which says what the file is but not where it came from. A
modelscan result is recorded and can be cited on a model card, but it never blocks dispatch or the model-risk check,
never opens a risk entry, and the register has no supply-chain category (PENDING.md P14, P15).

## Decision

### P14 — signatures, verified at upload and before serving

1. **Format.** The OpenSSF model-signing format (`model_signing`, predicate `https://model_signing/signature/v1.0`): a
   Sigstore bundle whose DSSE envelope carries an in-toto statement listing each signed file and its sha256, with one
   subject whose digest is the sha256 over those digests. A signature covers an artifact when one listed resource's
   digest is the artifact's sha256 (the signer may sign a whole model directory; we hold one file of it).
2. **Library.** `@sigstore/verify` 4.1.2 and `@sigstore/bundle` 5.0.0 (Apache-2.0, released within the last
   three months, pinned in the lockfile, listed in `apps/gateway/THIRD_PARTY.md`). They parse the bundle and verify
   the envelope. The statement rules (predicate type, the subject digest, the file digest) are the format's own and no
   JavaScript library implements them; they follow the reference implementation's `signing.py`.
3. **Air-gapped: key mode only.** An admin configures trust roots (`model_signing_keys`: ECDSA P-256 public keys in
   PEM; the key hint is the sha256 of the PEM, exactly as the signing tool writes it into the bundle). No transparency
   log, certificate authority or timestamp authority is consulted, so nothing is fetched. A keyless (certificate)
   bundle is refused as `unsupported_bundle`. Measured: the library's key path verifies P-256/SHA-256 and does not
   verify P-384/SHA-384, so only P-256 keys are accepted (a P-384 key is refused when added, 422).
4. **Trust roots.** Adding a key widens what is trusted: admin only, a `settings_relax` step-up bound to the key,
   audited `model-signing-key-added`. Revoking is a tightening: admin, no step-up, audited. A key row is never
   deleted and only gains its revocation, once (a guard trigger), so a past verification always names its key.
5. **At upload** a bundle may ride the upload in the `x-regulait-model-signature` header (base64 of its JSON) and is
   verified in the upload's transaction; **afterwards** the uploader or an admin attaches one with
   `POST /v1/model-artifacts/:artifactId/signature`. Every presentation is a `model_artifact_signatures` row and an
   audit entry (`model-signature-verified` / `model-signature-failed`, with the reason), pass or fail.
6. **Before serving** the newest signature is re-verified against the keys in force on every gated read: each
   dispatch of a model whose card cites the file, each sign-off, and each artifact view. Revoking a key takes effect at
   once. Streaming the file to the scanner is not gated, because scanning an unsigned file is the scanner's job.

### P15 — an unverifiable file is a default-deny condition

7. **The check.** A file passes only when it is *signed* (point 6), *scanned* (a scan with a conclusive verdict:
   `clean`, `no_known_unsafe` or `unsafe`), and in a *safe format* (one whose ceiling is `clean`, today only verified
   safetensors, with no `unsafe` finding). The pure assessment is `packages/shared/src/engines/supply-chain.ts`.
8. **Where it binds.** A model card that cites a scan of a file (`engine_scan` evidence) says the model is built from
   that file. Every file a subject's cards cite is checked as the first rung of `mrmDispatchGate`, before the MRM
   toggle is read: the block does not depend on `mrmEnforced`. A failing file refuses dispatch and card sign-off with
   409 `model_supply_chain_blocked`, audited `model-supply-chain-blocked`.
9. **Risk entry.** The first block for a file opens a risk entry in the new `supply_chain` category (dimension:
   security; resolver `model_supply_chain`: files by state, re-verified, and blocks in the window), owned by the
   uploader, else the citing card's author, else the caller, linked by `ai_risks.model_artifact_id`. A partial unique
   index keeps it to one entry per file until it is closed. A library entry and three intake scenarios are added.
10. **Relaxation.** An admin may relax named conditions for one file: `PUT
    /v1/model-artifacts/:artifactId/supply-chain-relaxation` with a stated reason and an end of at most 30 days (the
    database CHECK repeats the bound against its own clock), a `settings_relax` step-up bound to the file, its sha256,
    the conditions and the expiry, audited `model-supply-chain-relaxed`. It counts only for the bytes it was decided on
    and only until it expires (checked on every read). Clearing is audited and needs no step-up. One in force per file.

### Defaults taken (owner may revisit)

- **No org-wide switch.** The common rules ask that a feature land behind a default-off org setting; this one is a
  security control that the brief and ADR-0180 require on by default, so it ships on, with the per-file relaxation as
  the only way through. It is inert until a card cites a scan of a file, and no seeded card does.
- **Demo seed: nothing to seed.** The demo seed and `demo:prepare` create no model artifact and no `engine_scan`
  evidence (checked), so no seeded model is affected; neither seeding a verified file nor a seeded relaxation is
  needed. The real-demo e2e fixture that cites a scan only exercises deletion and dispatches nothing.
- **A failed signature at upload keeps the file.** It is stored, recorded as failed and blocked; refusing the upload
  would discard the evidence of a tampered file.
- **Lineage** from a repackaged file back to its parent (PENDING P14's last clause) is not built here.

## Consequences

- Migrations 0235 (keys, signatures, relaxations, two guard triggers) and 0236 (`supply_chain` category,
  `ai_risks.model_artifact_id`, the one-open-risk index). Hand-authored, idempotent.
- New routes: `GET|POST /v1/model-signing-keys`, `POST /v1/model-signing-keys/:keyId/revoke` (admin),
  `POST /v1/model-artifacts/:artifactId/signature` (uploader or admin), `PUT|DELETE
  /v1/model-artifacts/:artifactId/supply-chain-relaxation` (admin). The artifact views carry `supplyChain`.
- UI: Model risk → Model artifacts gains a Supply chain column, a supply-chain section in the artifact detail (the
  requirements stated at the point of decision, attach a signature, an admin's relaxation) and a Trusted signing keys
  card for admins. The risk register gains the category.
- Bundle: +2,376 B gzipped, all in the lazy model risk chunk; it fits under the shared 1,150 kB `all JS` ceiling main
  now carries (ADR-0196 addenda), so this lane raises no ceiling.
- `AI_RISK_CATEGORIES` is a shared contract: the db enum, the CHECK, the shared vocabulary, the dimension map, the
  intake suggestions, the scenario library and the register's filter are updated together.

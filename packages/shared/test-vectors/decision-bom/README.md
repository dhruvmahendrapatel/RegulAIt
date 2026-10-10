# ADR-0189 B4 verifier vectors (specification only)

**These are the vectors slice B4 must pass.** B4's verifier (`packages/shared/src/bom/verify.ts`,
`POST /v1/boms/verify`, `scripts/verify-bom.mjs`) is correct for these cases only when it returns every expectation
below; B4's assembler and freeze path must meet the finality-emission and assembly rows.

They were written from the specification text alone (ADR-0191 decision 4): ADR-0189 "B4 bundle and signature
specification" (B4.1 to B4.7, `main` @ `90de188`, ADR blob `eccf38e`), the decisions and amendments it cites (§2,
§5, §6, R1, R4, R5, R15, R18, R19, R21, R23, R33 to R35, R37, R39, R42 to R44, R46, R48), and the B4.6 worked
example with its builder and test, which the spec names as normative. No B4 code existed, and
`contract.ts`/`contract-b4.ts` were not read beyond what the ADR quotes. They adopt and extend the retired agent's
draft, PR #312 (X46).

All keys are **TEST-ONLY**: each is the Ed25519 key whose 32-byte seed is the SHA-256 of a published seed text that
contains CANARY (`b4-vectors.json` `keys[]`). No private key is stored. Never configure one.

## Files

| File | What it holds |
|---|---|
| `b4-vectors.json` | 26 positive bundles, 88 negatives, 20 finality-emission, 15 verify-response and 14 assembly vectors |
| `generate-vectors.mjs` | writes `b4-vectors.json` and `crypto-vectors.json` (node:crypto and the pinned `canonicalize` only; deterministic) |
| `check-vectors.mjs` | checks shape and self-consistency; run by `packages/shared/src/bom/b4-spec-vectors.test.ts` in CI |
| `crypto-vectors.json` | #312's ten Ed25519 / `v`-domain primitives (K01 to K10), regenerated with CANARY-seeded keys |
| `semantic-vectors.json` | #312's 71 lifecycle and semantic obligations, reviewed against B4 (P01 and P04 corrected) |

```sh
node packages/shared/test-vectors/decision-bom/generate-vectors.mjs   # then `git diff` must be empty
node packages/shared/test-vectors/decision-bom/check-vectors.mjs
```

## How B4 consumes them

**A bundle.** A positive carries `bundle.entries` (name under the root, `type`, exact UTF-8 `text`) in archive order.
A negative carries `bundle.base` (a positive) plus either `replace` (entry name to new text) or a full `entries` list
(for archive-shape mutations). Write the entries as the B4.1 USTAR stream (its SHA-256 and length are `tarSha256`
and `tarBytes`; the checker's writer is a reference), gzip it, and feed the archive to the verifier as a `bundle`
source. The uncompressed tar is the reproducible object; the gzip bytes are not pinned (B4.1).

**The trust root** (`trust`) is a test-harness description, not a wire format (assumption A1):

- `receipt.keyring` is the offline keyring shape (`{keys: [{keyId, jwk}], receiptV2FromAuditSeq}`); online, load the
  same keys as `receipt_signing_keys` rows and the boundary as the `receipt_payload_versions` row. `receipt.pinnedFingerprints`
  is the offline pinned-fingerprint form (B4.2).
- `export.keyring` is `bomExportVerifyKeyringSchema` (`[{keyId, publicKeyPem, fingerprint}]`); `export.ownKey` is the
  public half of the deployment's configured export key. `export.pinnedFingerprints` is ADR-0116's `--fingerprint`.
- `verificationTime` is the verifier's `now` (it decides `anchored_lapsed`).
- `mode` says whether the vector was written for the online route or the offline script; every vector except
  N-M05 (a load-time refusal of the online keyring) applies to both.

**The expectation** (`expect`): `outcome`; `checks` maps a check name to `{result, reason?}`, to `"absent"` (left out
of `checks`, B4.4) or to `"not_invalid"` (spec gap G5). A negative names only the checks the spec ties to its rule;
B4 may report other failures too, but the outcome is `invalid` and the named checks must have the named result.
`recordedFinality`, `reportedFinality`, `receiptPayloadVersion` and `finalityNotes` (G6) are as B4.5 and B4.6
report them. Every positive also expects every section `valid` with the body's completeness.

`authentic` and `projectionConsistent` are what the checker proves about the bytes: which signature layers verify
under the trust root (`true`, `false`, `untrusted` for no trusted key, `encoding` for a wrong signature encoding) and
whether the sections still re-derive from the facts. They make each negative isolate one rule: a negative that
breaks the body signature keeps the manifest and receipt authentic, and one that breaks a section re-signs every
layer.

**Running each negative beside its base positive** is the point: a verifier that rejects everything fails the
positives, and one that accepts everything fails the negatives.

## Assumptions (where the ADR names a value but not its spelling)

- **A1.** The `trust` object above is a harness shape. Map it to the real loaders without changing any expectation.
- **A2.** `proof.anchor` field spellings. The ADR fixes `id`, `record.{seq,rowHash,headAt,algorithm,payloadVersion,capturedAt}`,
  `status`, `tamperResistant`, `retainUntil`, `tsaNonce`, `tsaRequestSentAt` and `tsaPolicyOid`; the others
  (`destination`, `externalRef`, `flushedAt`, `tamperObservationMode`, `tamperObservedAt`, `tsaToken`,
  `tsaMessageImprint`) are this author's camelCase of the ADR's column names, and `record.algorithm` is `"sha256"`.
  If `contract.ts:581-619` spells them differently, rename them in `generate-vectors.mjs` and regenerate; no
  expectation changes.
- **A3.** The `approvals` and `approval_decisions` projection columns (P11, N-S03) are invented; the ADR leaves the
  lists to the B1 shared zod. Replace them with the B1 lists and regenerate; no expectation changes.
- **A4.** The addendum payload is `{auditId, n, prevHash, rows, v}` (P09, P10, P11, P23, N-S14, N-A01 to N-A05). The
  ADR fixes `v` and `rows` and the signed bytes, not the other keys. Same remedy.

## Specification gaps and ambiguities found

- **G1. Row digest preimage.** R5 says a row digest is "SHA-256 over the canonicalJson of a fixed column list"; the
  B4.6 digests are SHA-256 of the canonical `{projection, table}` (the table name is in the preimage). The vectors
  follow B4.6; the ADR text should say so.
- **G2.** The approval projection columns are not in the ADR (A3).
- **G3.** The `regulait.decision-facts-addendum.v1` payload keys are not in the ADR (A4).
- **G4.** Most `proof.anchor` field spellings exist only in `contract.ts:581-619` (A2).
- **G5. `tsa_token` and `anchor_imprint` on an anchored BOM with no RFC 3161 token** (timestamps optional) have no
  specified result or reason: the ADR names only `anchor_absent` (chain_signed) and `request_facts_not_recorded`
  (pre-R33 tokens). P14 to P19 expect only "not invalid" for them. A token also cannot be built with node:crypto
  alone (it needs a TSA certificate), so no vector exercises the R33 token checks; #312's P08 obligation stands.
- **G6.** Where `finite_lock_under_unbounded_retention` and `commitment_after_retain_until` are reported is cited only
  as `contract-b4.ts:571-604`. The vectors list them under `finalityNotes`.
- **G7. Lapse at equality.** R44 says `anchored_lapsed` "once it has passed"; B4.5 says once `retainUntil` "is not
  after the verification time". The vectors follow B4.5 (P19: equality is lapsed), and #312's P04, which said the
  opposite, is corrected.
- **G8. A bound usage event with a null `costUsd`.** B4.4 makes `costUsd` null and the cost completeness `recorded`
  (a row is bound); R23 says "a null cost is `not_recorded`". No vector until the ADR picks one.
- **G9. Unnamed checks.** For these rules the spec says the bundle is wrong but not which check fails, so the
  negatives assert only `outcome: invalid`: a non-canonical manifest, body or signature file; `manifest.files`
  unsorted, duplicated or listing `manifest.json`; a listed `audit/rows/` file; a directory, symlink or second root;
  a wrong root name; `chain.tsv` different from `proof.chain`; a `chain_signed` chain longer than one row; segment
  fields that disagree with the chain; `installIdSource` inconsistent with `installId`; schema `/2`;
  `payloadScope` not `none`; and the v2 actor comparison (B4.3 names no check for it).
- **G10. v2 receipts and the boundary.** B4.6 says the verifier "needs a recorded v2 boundary at or below seq 42",
  but B4.3 gives boundary-dependent results only for v1 receipts. The result for a v2 receipt with no boundary in
  the trust root, or below a known boundary, is unspecified; no vector.
- **G11. Shortfall precedence.** B4.5 does not say which `shortOf` reason wins when several hold (a non-tamper-resistant
  destination with a null `retain_until`; unbounded retention on a non-tamper-resistant destination under
  `accept`). Each emission vector has one shortfall only.
- **G12. AI BOM bundles.** The native body schema `regulait.ai-bom.v1`, the AI BOM manifest descriptor
  (`contract-b4.ts:303-327`) and the rendering commitment record are not in the ADR text, so no route-valid AI BOM
  bundle can be written from the spec alone. AI BOM rules stay as #312's semantic obligations (R01 to R07, B01, B02).
- **G13.** No named check covers `basis`; a `basis` that disagrees with the chain or the anchor is not tested.
- **G14.** The `bomIdentifierSchema` pattern (the decision section's null rule for `toolName` and `ruleId`) and the
  email-shape definition (`hasEmailShape`, `findEmailShapes`) are cited, not stated. The vectors use plain
  identifiers and a plain `name@example.com` shape.
- **G15.** A body that binds one usage event twice is an assembly failure (X04), but the verifier's result for such
  a body is unspecified.

Two facts the vectors make explicit: a Decision BOM's outcome is never `valid` (R39 keeps `decision_content_binding`
`unverifiable`), and #312's secret-scan failure came from its `codexInputs.md` entry, not from its vector files
(gitleaks 8.30.1 `generic-api-key` on `receipt/facts/addendum`); the vector files here pass the default rules and
are also covered by the CANARY-scoped allow-list in `.gitleaks.toml`.

## Changes from the #312 draft

- The "literal product-wire positives: BLOCKED" status is retired: B4.1 to B4.6 now specify the bytes, and P01 is
  the B4.6 worked example reproduced byte for byte (including the uncompressed tar digest).
- `crypto-vectors.json` keeps K01 to K10 and the facts and rendering digest fixtures, but its keys now derive from
  CANARY seed texts (the `1111…`/`2222…` hex seeds are gone) and the key-named base64 field is renamed
  `pinnedSpkiDerBase64`.
- `semantic-vectors.json` P01 now has B4.5's four ranks and the floor rule; P04 now lapses at equality (G7).
- The `--red-*` switches are replaced by the vitest test, which runs the checker on a corrupted copy and requires it
  to fail.

## Vector map

### Positives: route-valid Decision BOM bundles

| ID | What it is | Spec paragraphs | Assumptions, gaps |
|---|---|---|---|
| P01 | The B4.6 worked example, byte for byte: chain_signed, v2 receipt (captured), one usage event and one span | B4.6 worked example; B4.1 'Files' table; B4.1 'The manifest'; B4.1 'Tar order and headers'; B4.2 'Signature file'; B4.3 v2 bullet | none |
| P02 | v1 receipt below a known boundary (100): facts carried but receipt_facts_binding is unverifiable receipt_v1_no_factsHash | B4.3 v1 bullet; B4.3 verifier checks: receipt_facts_binding; R46 v1 facts not claimed; B4.4 'Required checks': fixed results | none |
| P03 | v1 receipt with no boundary in the trust root: receipt_v1_no_factsHash | B4.3 v1 bullet; B4.3 verifier checks: receipt_facts_binding; B4.2 'Finding the key', receipt v2 boundary bullet | none |
| P04 | v2 receipt with factsStatus capture_off: facts.payload null, every fact section not_recorded capture_off | B4.3 v2 bullet; B4.3 verifier checks: receipt_facts_binding; B4.4 'Decided here': no facts bullet; B4.4 sections table | none |
| P05 | v1 receipt, decision made before B2 (no capture-status row): every fact section not_recorded pre_facts | B4.4 'Decided here': no facts bullet; B4.3 v1 bullet; B4.3 verifier checks: receipt_facts_binding | none |
| P06 | v1 receipt with no facts and reason capture_off: a verifier given a v1 receipt accepts either reason | B4.4 'Decided here': no facts bullet | none |
| P07 | cost over three usage events: exact decimal sum of R23 strings (0.1 + 0.2 + 1e-7 = 0.3000001), ids sorted; spans over two traces | B4.4 sections table; R23 lossless cost; B4.7-3 exact decimal sum | none |
| P08 | cost over two usage events whose sum has no fractional part: 0.25 + 0.75 = "1" (no trailing zeros, no exponent) | B4.4 sections table; B4.7-3 exact decimal sum | none |
| P09 | two signed addenda (n=1 a usage event, n=2 a span) chained from facts_hash; sections take facts.rows then addenda rows | B4.2 'Signed bytes' table; R35 addendum chain; R15 addendum signatures; B4.4 'Sources'; B4.4 'Decided here': checks that do not apply | A4 |
| P10 | an addendum signed by a second trusted receipt key: receipt-keys.json carries both ids, sorted by keyId | B4.1 'Files' table; B4.2 'Finding the key', offline bullet; R15 addendum signatures | A4 |
| P11 | approval rows: verbatim {table,id,projection,digest}, stable-sorted by table then id (approval_decisions before approvals); a re-bound approval appears twice | B4.4 sections table | A3, A4 |
| P12 | facts.actors null: actors section null, completeness not_recorded pre_identity | B4.4 sections table | none |
| P13 | decision section: a 300-character objectId is null in the body (over 256); connector call with serverId null | B4.4 sections table | none |
| P14 | anchored: flushed, tamperResistant true, retainUntil 2036; chain 42..44 up to the anchor record seq; proof recorded | B4.4 sections table; B4.5 emitted-state bullets; B4.5 verifier finality check; R1 complete canonical anchor record; R44 retain_until | A2, G5 |
| P15 | anchored_unverified_destination: flushed to a destination observed not tamper-resistant (retainUntil null) | B4.5 emitted-state bullets; B4.5 verifier finality check | A2, G5 |
| P16 | anchored_unverified_destination as emitted under refuse with unbounded retention (tamperResistant true, retainUntil set): structurally valid | B4.5 emitted-state bullets; B4.5 freeze rule (floor and accept); B4.5 verifier finality check | A2, G5 |
| P17 | anchored_finite_lock (emitted only under accept): reported as recorded, with finite_lock_under_unbounded_retention added | B4.5 emitted-state bullets; B4.5 verifier finality check | A2, G5, G6 |
| P18 | anchored, verification time after retainUntil: reported anchored_lapsed with commitment_after_retain_until; the body is unchanged | B4.5 verifier finality check; R44 retain_until | A2, G5, G6 |
| P19 | anchored, verification time exactly equal to retainUntil: lapsed ("not after the verification time") | B4.5 verifier finality check | A2, G5, G6, G7 |
| P20 | online: the manifest is signed by an export key listed only in the verification keyring (no own key configured) | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2) | none |
| P21 | online: the deployment's own configured export key is trusted with an empty keyring | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2) | none |
| P22 | offline: receipt trust root as pinned fingerprints matched against receipt-keys.json; export trust root as a pinned fingerprint | B4.2 'Finding the key', offline bullet | none |
| P23 | version 2 superseding version 1: root ends -v2, supersedes is v1's id, descriptor.version 2 | B4.1 'Root directory'; B4.4 'Freezing' item 5; B4.1 'The manifest' | A4 |
| P24 | an operator-set installId (not email-shaped) with installIdSource operator | B4.1 'The manifest' | none |
| P25 | v2 receipt naming an actor identity and grant equal to facts.actors (receipt chain and actorChain are not compared) | B4.3 verifier checks: v2 actor bullet; B4.3 v2 bullet | none |
| P26 | decision.ruleChain is not recomputed by sections_projection: a body with a two-entry ruleChain is still valid_with_unverifiable | B4.4 'Decided here': sections_projection bullet; B4.4 'Required checks': fixed results | none |

### Negatives: one rule each

| ID | Base | Mutation | Spec paragraph | Expected |
|---|---|---|---|---|
| N-M01 | P01 | manifest.json.sig signs other bytes (manifest edited after signing) | B4.1 'The manifest'; B4.1 'What is signed' | bundle_manifest_signature invalid |
| N-M02 | P01 | signingKeyId names a key in neither the keyring nor the own key (rogue export key) | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); B4.2 'Finding the key', unknown_key bullet | bundle_manifest_signature invalid unknown_key |
| N-M03 | P01 | a rogue key signs the manifest under E1's key id, with its own signing-key.pub and fingerprint: the bundle key is never trusted | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); §6 verification offline, out-of-band trust root | bundle_manifest_signature invalid |
| N-M04 | P01 | the export trust root holds E1's id twice with different keys | B4.2 'Finding the key', unknown_key bullet | bundle_manifest_signature invalid unknown_key |
| N-M05 | P01 | online keyring entry whose fingerprint does not match its key: the keyring is refused at load | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2) | keyring refused at load |
| N-M06 | P01 | manifest.json.sig as unpadded base64url instead of padded standard base64 and a newline | B4.1 'The manifest'; B4.2 'Encoding' | bundle_manifest_signature invalid |
| N-M07 | P01 | manifest.json.sig without its trailing newline | B4.1 'Files' table; B4.2 'Encoding': manifest signature ends with a newline | bundle_manifest_signature invalid |
| N-M08 | P01 | manifest.json not canonical (pretty-printed) yet correctly signed | B4.1 'Files' table | outcome invalid (check not named by the spec, G9) |
| N-M09 | P01 | README.txt changed after the manifest listed its SHA-256 | B4.1 'The manifest'; B4.4 'Required checks': bundle_manifest_files | bundle_manifest_files invalid |
| N-M10 | P01 | an extra audit/rows/42.payload entry in the archive, not in the manifest (R39: no audit preimage) | B4.1 'Files' table; R39 no audit preimage | bundle_manifest_files invalid |
| N-M11 | P01 | audit/rows/42.payload listed in a re-signed manifest: no such file may exist in a BOM bundle | B4.1 'Files' table; R39 no audit preimage | outcome invalid (check not named by the spec, G9) |
| N-M12 | P01 | a file listed in the manifest is missing from the archive | B4.1 'The manifest' | bundle_manifest_files invalid |
| N-M13 | P01 | manifest.files not sorted by path (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-M14 | P01 | manifest.files lists manifest.json itself (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-M15 | P01 | manifest.files lists one path twice (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-M16 | P01 | a directory entry in the archive (no directory entry exists) | B4.1 'Files' table | outcome invalid (check not named by the spec, G9) |
| N-M17 | P01 | entries under two root directories | B4.1 'Root directory' | outcome invalid (check not named by the spec, G9) |
| N-M18 | P01 | a symlink entry in the archive | ADR-0116 amendment 2026-10-03 (non-regular entries); B4.1 'Files' table | outcome invalid (check not named by the spec, G9) |
| N-M19 | P01 | root directory named -v2 for a version 1 Decision BOM | B4.1 'Root directory' | outcome invalid (check not named by the spec, G9) |
| N-M20 | P01 | email-shaped operator installId (signed): the email scan covers manifest.json | B4.1 'Build order' (R21); R21 whole-bundle email scan; B4.1 'The manifest' | bundle_email_scan invalid |
| N-M21 | P01 | installId non-null with installIdSource absent (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-M22 | P01 | an email address in README.txt (listed and signed) | B4.1 'Build order' (R21); R21 whole-bundle email scan | bundle_email_scan invalid |
| N-M23 | P01 | descriptor.bodySha256 differs from content/decision-bom.json (re-signed manifest) | B4.1 'The manifest'; B4.2 'Signature file' | bundle_subject invalid |
| N-M24 | P01 | subject.id is not the auditId (re-signed) | B4.1 'The manifest' | bundle_subject invalid |
| N-M25 | P01 | audit.segmentToSeq does not equal the last proof.chain seq (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-M26 | P01 | schema regulait.export-bundle/2 on a BOM bundle (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-M27 | P01 | descriptor.finality differs from the body's finality (re-signed) | B4.1 'The manifest' | bundle_subject invalid |
| N-M28 | P01 | audit.payloadScope other than none (re-signed) | B4.1 'The manifest' | outcome invalid (check not named by the spec, G9) |
| N-B01 | P01 | body signature made over other bytes (signedSha256 matches the file, signature does not) | B4.2 'Signed bytes' table; B4.2 'Signature file' | body_signature invalid |
| N-B02 | P01 | signature file's signedSha256 is not the SHA-256 of the body file | B4.2 'Signature file' | body_signature invalid |
| N-B03 | P01 | signature file not canonical (keys out of order) | B4.2 'Signature file' | outcome invalid (check not named by the spec, G9) |
| N-B04 | P01 | body signature as padded standard base64 (88 characters), not 86-character base64url | B4.2 'Encoding'; B4.2 'Signature file' | body_signature invalid |
| N-B05 | P01 | signature file alg is not Ed25519 | B4.2 'Signature file' | body_signature invalid |
| N-B06 | P01 | body signed by a receipt key the trust root does not hold (R2, carried in receipt-keys.json) | B4.2 'Finding the key', unknown_key bullet; B4.2 'Finding the key', offline bullet | body_signature invalid unknown_key |
| N-B07 | P01 | a rogue key signs the body and receipt under R1's id; receipt-keys.json carries the rogue JWK: bundled keys are never the trust root | §6 verification offline, out-of-band trust root; B4.2 'Finding the key', offline bullet | body_signature invalid, receipt_signature invalid |
| N-B08 | P01 | domain separation: the signature file carries the receipt's signature | §5 / OWNER DECISION 2 domain separation by v; B4.2 'Signed bytes' table | body_signature invalid |
| N-B09 | P01 | body v is regulait.decision-bom.v2, correctly signed | §5 / OWNER DECISION 2 domain separation by v; §5 every verifier rejects an unknown v | body_version invalid |
| N-B10 | P01 | body not canonical (pretty-printed) but signed over those bytes | B4.1 'Files' table; B4.2 'Signed bytes' table | outcome invalid (check not named by the spec, G9) |
| N-B11 | P01 | the receipt trust root holds R1's id twice with different keys | B4.2 'Finding the key', unknown_key bullet | body_signature invalid unknown_key, receipt_signature invalid unknown_key |
| N-B12 | P01 | offline pinned receipt fingerprint does not match receipt-keys.json's entry for that id | B4.2 'Finding the key', offline bullet | body_signature invalid unknown_key, receipt_signature invalid unknown_key |
| N-R01 | P01 | receipt.payloadHash is not the SHA-256 of payload | B4.3 verifier checks: receipt_payload_hash | receipt_payload_hash invalid |
| N-R02 | P01 | receipt payload not canonical (re-hashed and re-signed over the non-canonical bytes) | B4.3 verifier checks: receipt_payload_hash | receipt_payload_hash invalid |
| N-R03 | P01 | receipt v regulait.receipt.v3: parses as neither v1 nor v2 | B4.3 verifier checks: receipt_payload_hash; §5 / OWNER DECISION 2 domain separation by v | receipt_payload_hash invalid |
| N-R04 | P01 | receipt signature does not verify (signed over other bytes) | B4.3 verifier checks: receipt_signature | receipt_signature invalid |
| N-R05 | P01 | receipt signed by a key the trust root does not hold (R2) | B4.3 verifier checks: receipt_signature; B4.2 'Finding the key', unknown_key bullet | receipt_signature invalid unknown_key |
| N-R06 | P01 | payload.keyId differs from receipt.keyId | B4.3 verifier checks: receipt_signature | receipt_signature invalid |
| N-R07 | P01 | payload.receiptSeq differs from receipt.receiptSeq | B4.3 verifier checks: receipt_signature | receipt_signature invalid |
| N-R08 | P01 | payload.audit.rowHash is not proof.chain[0].rowHash | B4.3 verifier checks: receipt_signature | receipt_signature invalid |
| N-R09 | P01 | payload.audit.id is not the body's auditId | B4.3 verifier checks: receipt_signature | receipt_signature invalid |
| N-R10 | P01 | v2 captured: factsHash is not the SHA-256 of facts.payload | B4.3 verifier checks: receipt_facts_binding; B4.3 factsHash bullet; R37 exact facts | receipt_facts_binding invalid facts_hash_mismatch |
| N-R11 | P01 | v2 capture_off but facts.payload is not null | B4.3 verifier checks: receipt_facts_binding | receipt_facts_binding invalid |
| N-R12 | P02 | v1 receipt at a seq at or above the known boundary (boundary 42, seq 42) | B4.3 verifier checks: receipt_facts_binding; B4.3 v2 boundary bullet (R34, R42, R43); B4.4 'Required checks': fixed results | receipt_facts_binding invalid v1_receipt_after_boundary |
| N-R13 | P25 | v2 actor.identityId differs from actors.actorIdentityId | B4.3 verifier checks: v2 actor bullet | outcome invalid (check not named by the spec, G9) |
| N-R14 | P25 | v2 actor.delegationGrantId differs from actors.delegationGrantId | B4.3 verifier checks: v2 actor bullet | outcome invalid (check not named by the spec, G9) |
| N-S01 | P01 | cost.inputTokens changed in the signed body | B4.4 'Decided here': sections_projection bullet; B4.4 'Sections' (B4C-02) | sections_projection invalid section_mismatch |
| N-S02 | P01 | completeness.model claims recorded while facts.model is null | B4.4 'Decided here': sections_projection bullet | sections_projection invalid section_mismatch |
| N-S03 | P11 | the duplicate approval binding is collapsed to one entry | B4.4 sections table; B4.4 'Decided here': sections_projection bullet | sections_projection invalid section_mismatch |
| N-S04 | P01 | decision.toolName changed (decision is recomputed except ruleChain) | B4.4 'Decided here': sections_projection bullet; B4.4 sections table | sections_projection invalid section_mismatch |
| N-S05 | P01 | principal.sponsorUserId is not the receipt's decision.userId | B4.4 'Decided here': sections_projection bullet; B4.4 sections table | sections_projection invalid section_mismatch |
| N-S06 | P08 | cost.costUsd "1.0" (a trailing fractional zero) for 0.25 + 0.75 | B4.4 sections table; B4.7-3 exact decimal sum | sections_projection invalid section_mismatch |
| N-S07 | P07 | cost.costUsd computed in binary floating point (0.1 + 0.2 + 1e-7 as doubles: 0.30000010000000005) rather than the exact decimal sum 0.3000001 | B4.4 sections table; R23 lossless cost | sections_projection invalid section_mismatch |
| N-S08 | P07 | trace.spanIds not sorted | B4.4 sections table | sections_projection invalid section_mismatch |
| N-S09 | P01 | completeness.approval not_applicable (B4 never emits it; a gap is never inferred) | B4.4 'Decided here': never not_applicable; B4.4 'Decided here': sections_projection bullet | sections_projection invalid section_mismatch |
| N-S10 | P04 | v2 capture_off receipt but completeness says pre_facts | B4.4 'Decided here': no facts bullet; B4.4 'Decided here': sections_projection bullet | sections_projection invalid section_mismatch |
| N-S11 | P13 | decision.objectId carries the 300-character objectId (over 256 must be null) | B4.4 sections table | sections_projection invalid section_mismatch |
| N-S12 | P01 | action section differs from facts.action (dataSensitivity edited) | B4.4 sections table; B4.4 'Decided here': sections_projection bullet | sections_projection invalid section_mismatch |
| N-S13 | P12 | facts.actors null but completeness.actors not_captured_by_path instead of pre_identity | B4.4 sections table | sections_projection invalid section_mismatch |
| N-S14 | P09 | rows from an addendum left out of the cost section | B4.4 'Sources'; B4.4 sections table | sections_projection invalid section_mismatch |
| N-C01 | P14 | a chain row's rowHash is not SHA-256(prevHash \|\| contentHash) | §6 chain links; B4.4 sections table | chain_links invalid |
| N-C02 | P14 | chain rows do not link (row 44's prevHash is not row 43's rowHash; rowHash recomputed) | §6 chain links | chain_links invalid |
| N-C03 | P01 | audit/chain.tsv differs from proof.chain (listed and signed) | B4.1 'Files' table | outcome invalid (check not named by the spec, G9) |
| N-C04 | P01 | chain_signed but proof.chain holds two rows (it is the decision row alone) | B4.4 sections table | outcome invalid (check not named by the spec, G9) |
| N-F01 | P14 | anchor record seq is not the last chain row's seq | R1 complete canonical anchor record | anchor_record invalid |
| N-F02 | P14 | anchor record rowHash is not the last chain row's rowHash | R1 complete canonical anchor record | anchor_record invalid |
| N-F03 | P14 | anchor record without capturedAt: a proof without all six fields is invalid, not unverifiable | R1 complete canonical anchor record | anchor_record invalid |
| N-F04 | P01 | finality chain_signed but proof.anchor is not null | B4.5 verifier finality check | finality invalid |
| N-F05 | P14 | finality anchored but proof.anchor is null | B4.5 verifier finality check; B4.4 sections table | finality invalid |
| N-F06 | P14 | finality anchored with tamperResistant false | B4.5 verifier finality check | finality invalid |
| N-F07 | P14 | finality anchored with retainUntil null | B4.5 verifier finality check | finality invalid |
| N-F08 | P14 | finality anchored with anchor.status not flushed | B4.5 verifier finality check | finality invalid |
| N-F09 | P15 | finality anchored_unverified_destination with anchor.status not flushed | B4.5 verifier finality check | finality invalid |
| N-F10 | P17 | finality anchored_finite_lock with tamperResistant false | B4.5 verifier finality check | finality invalid |
| N-F11 | P14 | anchored body whose completeness.proof still says not_recorded anchor_absent | B4.4 sections table; B4.4 'Decided here': sections_projection bullet | sections_projection invalid section_mismatch |
| N-A01 | P09 | addendum 1's prevHash is not facts_hash | R35 addendum chain; R5 verifier checks the chain back to factsHash | facts_addenda_chain invalid |
| N-A02 | P09 | addendum 2's signature does not verify | R15 addendum signatures; B4.2 'Signed bytes' table | facts_addenda_signatures invalid |
| N-A03 | P09 | addenda numbered 1 and 3 (a gap) | R35 addendum chain | facts_addenda_chain invalid |
| N-A04 | P09 | addendum signed by a key the trust root does not hold (RX) | R15 addendum signatures; B4.2 'Finding the key', unknown_key bullet | facts_addenda_signatures invalid unknown_key |
| N-A05 | P09 | an addendum signature made over the receipt payload bytes (domain separation by v) | B4.2 'Signed bytes' table; R15 addendum signatures | facts_addenda_signatures invalid |

### Finality as emitted (B4.5 emitted-state bullets and freeze rule; server side)

| ID | Case | Expected |
|---|---|---|
| E01 | no flushed anchor, floor anchored | 409 bom_anchor_pending anchor_not_flushed |
| E02 | no flushed anchor, floor chain_signed | freeze chain_signed (short of anchored by anchor_not_flushed) |
| E03 | anchor not yet flushed counts as no flushed anchor | 409 bom_anchor_pending anchor_not_flushed |
| E04 | tamper_resistant false, floor anchored | 409 bom_anchor_pending destination_not_tamper_resistant |
| E05 | tamper_resistant false, floor anchored_unverified_destination | freeze anchored_unverified_destination (short of anchored by destination_not_tamper_resistant) |
| E06 | tamper_resistant false, floor chain_signed: the emitted state is the strongest supported, never the floor | freeze anchored_unverified_destination (short of anchored by destination_not_tamper_resistant) |
| E07 | timestamps required and none granted, floor anchored | 409 bom_anchor_pending timestamp_pending |
| E08 | timestamps required and none granted, floor anchored_unverified_destination | freeze anchored_unverified_destination (short of anchored by timestamp_pending) |
| E09 | retain_until null, floor anchored | 409 bom_anchor_pending lock_not_recorded |
| E10 | retain_until not after the freeze time (equal), floor anchored | 409 bom_anchor_pending lock_lapsed |
| E11 | retain_until before the end of the evidence retention, floor anchored | 409 bom_anchor_pending lock_shorter_than_retention |
| E12 | retain_until before the end of the evidence retention, floor anchored_unverified_destination | freeze anchored_unverified_destination (short of anchored by lock_shorter_than_retention) |
| E13 | retain_until equal to the end of the evidence retention: anchored (only 'before' is short) | freeze anchored |
| E14 | everything recorded, floor anchored | freeze anchored |
| E15 | unbounded retention, refuse, floor anchored_unverified_destination | freeze anchored_unverified_destination (short of anchored by retention_unbounded) |
| E16 | unbounded retention, refuse, floor chain_signed | freeze anchored_unverified_destination (short of anchored by retention_unbounded) |
| E17 | unbounded retention, refuse, floor anchored: pending with retention_unbounded | 409 bom_anchor_pending retention_unbounded |
| E18 | unbounded retention, accept, floor anchored: anchored_finite_lock freezes whatever the floor | freeze anchored_finite_lock |
| E19 | unbounded retention, accept, floor chain_signed | freeze anchored_finite_lock |
| E20 | timestamps required and granted, everything recorded | freeze anchored |

### Verify-response rules (B4.4 required checks, fixed results, aggregation)

| ID | Response | Conforms | Spec paragraph |
|---|---|---|---|
| Q01 | the B4.6 report: every required check, fixed results, outcome valid_with_unverifiable | yes | B4.4 'Required checks' (B4C-01); B4.6 worked example |
| Q02 | a non-invalid outcome missing the finality check | no | B4.4 'Required checks' (B4C-01) |
| Q03 | decision_content_binding reported valid | no | B4.4 'Required checks': fixed results |
| Q04 | a Decision BOM outcome valid (impossible: decision_content_binding is always unverifiable) | no | B4.4 'Required checks': fixed results; B4.4 'Sections' (B4C-02) |
| Q05 | a stored source reporting bundle_manifest_signature valid | no | B4.4 'Required checks' (B4C-01) |
| Q06 | a stored source reporting the bundle checks unverifiable not_a_bundle | yes | B4.4 'Required checks' (B4C-01) |
| Q07 | a bundle source reporting not_a_bundle | no | B4.4 'Required checks' (B4C-01) |
| Q08 | a check reported twice without distinct non-null refs | no | B4.4 'Required checks' (B4C-01) |
| Q09 | a v2 receipt with receipt_facts_binding unverifiable receipt_v1_no_factsHash | no | B4.4 'Required checks': fixed results |
| Q10 | a v1 receipt with receipt_facts_binding valid | no | B4.4 'Required checks': fixed results |
| Q11 | anchor_absent on an anchored BOM's anchor checks | no | B4.4 'Required checks': fixed results |
| Q12 | sections_projection reported unverifiable | no | B4.4 'Sections' (B4C-02) |
| Q13 | an invalid check with outcome valid_with_unverifiable (any invalid gives invalid) | no | B4.4 'Sections' (B4C-02) |
| Q14 | a stored ai_bom_snapshot source used for a Decision BOM | no | B4.4 'Required checks' (B4C-01); B4.4 'Required checks': stored source names its own subject (B4C-03) |
| Q15 | a missing required check with outcome invalid is admissible (a response missing one can only be invalid) | yes | B4.4 'Required checks' (B4C-01) |

### Assembly refusals (server side, no bytes)

| ID | Given | Expected | Spec paragraph |
|---|---|---|---|
| X01 | receipt unsigned and no receipt key configured | status: 409, code: bom_signing_unavailable, missingKey: receipt | B4.4 'Freezing' item 2 |
| X02 | receipt key configured, receipt not yet signed by the sweep | status: 409, code: bom_anchor_pending, reason: receipt_unsigned, retryAfter: true | B4.4 'Freezing' item 2 |
| X03 | receipt signed; an addendum present at the final recheck has no signature row; key configured | status: 409, code: bom_anchor_pending | B4.4 'Freezing' item 2; R15 |
| X04 | one usage_events id bound in facts.rows and again in addendum 1 | status: 500, code: bom_integrity_failure, frozen: false | B4.4 'Decided here': duplicate binding bullet |
| X05 | a bound row whose stored digest does not match SHA-256 of its canonical projection | status: 500, code: bom_integrity_failure, frozen: false | B4.4 'Decided here': digest recheck bullet |
| X06 | addendum 2's prev_hash is not addendum 1's facts_hash | status: 500, code: bom_integrity_failure, frozen: false | B4.4 'Decided here': digest recheck bullet; R35 |
| X07 | facts.actors.sponsorUserId differs from the receipt's decision.userId | status: 500, code: bom_integrity_failure | B4.4 sections table: principal row |
| X08 | audit_log.rule_chain holds 65 entries | status: 422, code: bom_decision_not_eligible | B4.4 sections table: decision row |
| X09 | an email shape inside the assembled body | status: 422, code: bom_export_refused, names: file body and the JSON path, never the value | B4.4 'Freezing' item 4; R10 |
| X10 | REGULAIT_INSTALL_ID is email-shaped at bundle build | status: 422, code: bom_export_refused, names: manifest.json and the JSON path, never the value | B4.1 'Build order' (R21) |
| X11 | a second request whose rebuilt body differs from the newest version only in id, version and supersedes | newVersion: false, returns: the newest frozen version | B4.4 'Freezing' item 5 |
| X12 | a late addendum signed after version 1 froze | newVersion: true, version: 2, supersedes: version 1's id, version1Edited: false | B4.4 'Freezing' item 5 |
| X13 | two concurrent first requests | sameFrozenVersion: true | B4.4 'Freezing' item 1 |
| X14 | the emitted state, not the floor, is written into body.finality and descriptor.finality | bodyFinality: emitted state, descriptorFinality: emitted state | B4.5 emitted-state bullets |

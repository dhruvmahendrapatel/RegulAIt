# ADR-0189 B4 verifier vectors (specification only)

**These are the vectors slice B4 must pass.** B4's verifier (`packages/shared/src/bom/verify.ts`,
`POST /v1/boms/verify`, `scripts/verify-bom.mjs`) is correct for these cases only when it returns every expectation
below; B4's assembler and freeze path must meet the finality-emission and assembly rows.

They were written from the specification text alone (ADR-0191 decision 4): ADR-0189 "B4 bundle and signature
specification" (B4.1 to B4.7, `main` @ `90de188`) and "B4 spec gaps settled" (B4.8 to B4.10, branch `b4-spec-gaps`),
the decisions and amendments they cite, and the worked examples (B4.6 and the B4.9 AI BOM example), which the spec
names as normative. No B4 code existed. The first draft (#333) found fifteen gaps; B4.8 to B4.10 decide them, and the
vectors now follow those decisions (see "Gaps: closed" below). They adopt and extend the retired agent's draft,
PR #312 (X46).

All keys are **TEST-ONLY**: each is the Ed25519 key whose 32-byte seed is the SHA-256 of a published seed text that
contains CANARY (`b4-vectors.json` `keys[]`). No private key is stored. Never configure one.

## Files

| File | What it holds |
|---|---|
| `b4-vectors.json` | 33 positive bundles (30 Decision BOM, 3 AI BOM), 108 negatives, 25 finality-emission, 23 verify-response and 14 assembly vectors |
| `generate-vectors.mjs` | writes `b4-vectors.json` and `crypto-vectors.json` (node:crypto and the pinned `canonicalize` only; deterministic). The AI BOM bodies and rendering are read from the ADR's `b4-ai-example:` blocks |
| `check-vectors.mjs` | checks shape and self-consistency, and derives every positive's outcome and `cannotProve` from its own reading of B4.8; run by `packages/shared/src/bom/b4-spec-vectors.test.ts` in CI |
| `crypto-vectors.json` | #312's ten Ed25519 / `v`-domain primitives (K01 to K10), regenerated with CANARY-seeded keys |
| `semantic-vectors.json` | #312's 71 lifecycle and semantic obligations, reviewed against B4 (P01 and P04 corrected) |

```sh
node packages/shared/test-vectors/decision-bom/generate-vectors.mjs   # then `git diff` must be empty
node packages/shared/test-vectors/decision-bom/check-vectors.mjs
```

## How B4 consumes them

**A bundle.** A positive carries `bundle.entries` (name under the root, `type`, exact UTF-8 `text`) in archive order.
A negative carries `bundle.base` (a positive) plus either `replace` (entry name to new text) or a full `entries` list
(for archive-shape mutations and for every AI BOM negative). Write the entries as the B4.1 USTAR stream (its SHA-256
and length are `tarSha256` and `tarBytes`; the checker's writer is a reference), gzip it, and feed the archive to the
verifier as a `bundle` source. The uncompressed tar is the reproducible object; the gzip bytes are not pinned (B4.1).

**The trust root** (`trust`) is a test-harness description, not a wire format:

- `receipt.keyring` is the offline keyring shape (`{keys: [{keyId, jwk}], receiptV2FromAuditSeq}`); online, load the
  same keys as `receipt_signing_keys` rows and the boundary as the `receipt_payload_versions` row (a null boundary is
  no row: no cutover). `receipt.pinnedFingerprints` is the offline pinned-fingerprint form (B4.2).
- `export.keyring` is `bomExportVerifyKeyringSchema` (`[{keyId, publicKeyPem, fingerprint}]`); `export.ownKey` is the
  public half of the deployment's configured export key. `export.pinnedFingerprints` is ADR-0116's `--fingerprint`.
- `verificationTime` is the verifier's `now` (it decides `anchored_lapsed`).
- `mode` says whether the vector was written for the online route or the offline script; every vector except
  N-M05 (a load-time refusal of the online keyring) applies to both. No vector configures a TSA trust bundle.

**The expectation** (`expect`): `outcome` (`valid`, `unverifiable` or `invalid`, B4.8 as amended into the contract
by B4.10); `checks` maps a check name to `{result, reason?, ref?}` or to `"absent"` (left out of `checks`, B4.4).
A negative names the check and the reason B4.9's G9 table ties to its rule; B4 may report other failures too, but the
outcome is `invalid` and the named checks must have the named result and reason. A positive also gives `cannotProve`
(exactly, in `BOM_CANNOT_PROVE` order as extended by B4.10), and for a Decision BOM `recordedFinality`,
`reportedFinality` and `receiptPayloadVersion`, with every section `valid` and the body's completeness; for an AI BOM
`identity` and no sections.

`authentic` and `projectionConsistent` are what the checker proves about the bytes: which signature layers verify
under the trust root (`true`, `false`, `untrusted` for no trusted key, `encoding` for a wrong signature encoding; the
`aiBom` layer is a linked AI BOM in a Decision BOM bundle) and whether the sections and `basis` still re-derive from
the facts. They make each negative isolate one rule: a negative that breaks the body signature keeps the manifest and
receipt authentic, and one that breaks a section re-signs every layer.

**Running each negative beside its base positive** is the point: a verifier that rejects everything fails the
positives, and one that accepts everything fails the negatives.

## Gaps: closed by ADR-0189 B4.8 to B4.10 (2026-10-10)

| Gap | Decision | What the vectors do now |
|---|---|---|
| G1 row digest preimage | SHA-256 of the canonical `{projection, table}` (`bomRowDigest`) | unchanged; the checker cites G1 |
| G2 approval columns | the B1 lists (`contract.ts:329-337`) | P11's approval rows carry the full lists; the checker requires every bound row's projection keys to be its B1 list |
| G3 addendum payload | `decisionFactsAddendumSchema`: `{auditId, n, postActionVerification, prev, rows, v}` | payloads use `prev` and `postActionVerification: null`; the checker requires the keys and that `n`/`prev`/`auditId` agree |
| G4 anchor spellings | `decisionBomAnchorSchema` (`observationMode`, `observedAt`, nested `tsa`) | anchors are exactly that shape, `tsa: null` |
| G5 anchored, no token | `anchor_imprint` and `tsa_token` `unverifiable` `no_timestamp_token`, not by design | P14 to P19 expect those results and outcome `unverifiable` (Q16, Q17) |
| G6 finality notes | `cannotProve` entries | `finalityNotes` removed; every positive has an exact `cannotProve` |
| G7 lapse at equality | lapsed when `retainUntil` is not after the verification time | P19 unchanged |
| G8 null `costUsd` | `costUsd` null, tokens summed, `completeness.cost` `recorded` | P27, N-S18 |
| G9 unnamed checks | the B4.9 G9 table | every negative names a check and a reason; N-M25 now keeps the manifest schema-valid so only `bundle_subject` fails |
| G10 v2 and the boundary | below or without a recorded boundary: `invalid` `v2_receipt_before_boundary` (new reason) | N-R15, N-R16, Q21 |
| G11 shortfall precedence | `strongest()`'s order (`finality.ts:88-103`); timestamp modes `required`/`off` | E21 to E25; inputs say `off`, not `optional` |
| G12 AI BOM bundles | specified from B3 with a worked example | A01 to A03 (bytes from the ADR), NA01 to NA09; linked AI BOM P28, P29, N-L01 to N-L03 |
| G13 `basis` | recomputed by `sections_projection`, shown on `proof`/`receipt`/`model` | N-S15, N-S16, N-S19; the checker's projection includes `basis` |
| G14 identifier and email shapes | `[A-Za-z0-9._:/@+#=-]{1,256}`; the email shape restated | P30 (`search@v2`), N-M29 (`search@v2.x`); the checker scans with that rule, not "no `@`" |
| G15 a row bound twice | `sections_projection` `section_mismatch` and `facts_addenda_chain` `addendum_chain_break` | N-S17 |
| outcome never `valid` | by-design results (B4.8) do not lower the outcome | P01 and most Decision BOM positives are now `valid`; Q01, Q04, Q06, Q18 to Q23 |

The B4.10 contract changes (outcome enum, two `cannotProve` entries, one invalid reason, the by-design refinement) are
in `contract-b4.ts` (`isUnverifiableByDesign`, `bomVerifyResponseSchema`); `contract-b4.test.ts` restates every
`responseRules` entry in the contract's shape and requires the schema to accept exactly the ones marked `conforms`. #312's P08 obligation (a real RFC 3161 token) stands: node:crypto
cannot build a TSA token, so B4's own tests cover `tsa_token` `valid` and `timestamp_invalid`.

## Vector map

### Positives: route-valid bundles

| ID | Subject | What it is | Outcome | Spec paragraphs |
|---|---|---|---|---|
| P01 | decision-bom | The B4.6 worked example, byte for byte: chain_signed, v2 receipt (captured), one usage event and one span | valid | B4.6 worked example; B4.1 'Files' table; B4.1 'The manifest'; B4.1 'Tar order and headers'; B4.2 'Signature file'; B4.3 v2 bullet; B4.8 the outcome and what is unverifiable by design |
| P02 | decision-bom | v1 receipt below a known boundary (100): facts carried but receipt_facts_binding is unverifiable receipt_v1_no_factsHash | valid | B4.3 v1 bullet; B4.3 verifier checks: receipt_facts_binding; R46 v1 facts not claimed; B4.4 'Required checks': fixed results; B4.8 the outcome and what is unverifiable by design |
| P03 | decision-bom | v1 receipt with no boundary in the trust root: receipt_v1_no_factsHash | valid | B4.3 v1 bullet; B4.3 verifier checks: receipt_facts_binding; B4.2 'Finding the key', receipt v2 boundary bullet; B4.8 the outcome and what is unverifiable by design |
| P04 | decision-bom | v2 receipt with factsStatus capture_off: facts.payload null, every fact section not_recorded capture_off | valid | B4.3 v2 bullet; B4.3 verifier checks: receipt_facts_binding; B4.4 'Decided here': no facts bullet; B4.4 sections table; B4.8 the outcome and what is unverifiable by design |
| P05 | decision-bom | v1 receipt, decision made before B2 (no capture-status row): every fact section not_recorded pre_facts | valid | B4.4 'Decided here': no facts bullet; B4.3 v1 bullet; B4.3 verifier checks: receipt_facts_binding; B4.8 the outcome and what is unverifiable by design |
| P06 | decision-bom | v1 receipt with no facts and reason capture_off: a verifier given a v1 receipt accepts either reason | valid | B4.4 'Decided here': no facts bullet; B4.8 the outcome and what is unverifiable by design |
| P07 | decision-bom | cost over three usage events: exact decimal sum of R23 strings (0.1 + 0.2 + 1e-7 = 0.3000001), ids sorted; spans over two traces | valid | B4.4 sections table; R23 lossless cost; B4.7-3 exact decimal sum; B4.8 the outcome and what is unverifiable by design |
| P08 | decision-bom | cost over two usage events whose sum has no fractional part: 0.25 + 0.75 = "1" (no trailing zeros, no exponent) | valid | B4.4 sections table; B4.7-3 exact decimal sum; B4.8 the outcome and what is unverifiable by design |
| P09 | decision-bom | two signed addenda (n=1 a usage event, n=2 a span) chained from facts_hash; sections take facts.rows then addenda rows | valid | B4.2 'Signed bytes' table; R35 addendum chain; R15 addendum signatures; B4.4 'Sources'; B4.4 'Decided here': checks that do not apply; B4.9 G3 addendum payload; B4.8 the outcome and what is unverifiable by design |
| P10 | decision-bom | an addendum signed by a second trusted receipt key: receipt-keys.json carries both ids, sorted by keyId | valid | B4.1 'Files' table; B4.2 'Finding the key', offline bullet; R15 addendum signatures; B4.9 G3 addendum payload; B4.8 the outcome and what is unverifiable by design |
| P11 | decision-bom | approval rows: verbatim {table,id,projection,digest}, stable-sorted by table then id (approval_decisions before approvals); a re-bound approval appears twice | valid | B4.4 sections table; B4.9 G2 approval columns; B4.9 G3 addendum payload; B4.8 the outcome and what is unverifiable by design |
| P12 | decision-bom | facts.actors null: actors section null, completeness not_recorded pre_identity | valid | B4.4 sections table; B4.8 the outcome and what is unverifiable by design |
| P13 | decision-bom | decision section: a 300-character objectId is null in the body (over 256); connector call with serverId null | valid | B4.4 sections table; B4.8 the outcome and what is unverifiable by design |
| P14 | decision-bom | anchored: flushed, tamperResistant true, retainUntil 2036; chain 42..44 up to the anchor record seq; proof recorded | unverifiable | B4.4 sections table; B4.5 emitted-state bullets; B4.5 verifier finality check; R1 complete canonical anchor record; R44 retain_until; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.8 the outcome and what is unverifiable by design |
| P15 | decision-bom | anchored_unverified_destination: flushed to a destination observed not tamper-resistant (retainUntil null) | unverifiable | B4.5 emitted-state bullets; B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.8 the outcome and what is unverifiable by design |
| P16 | decision-bom | anchored_unverified_destination as emitted under refuse with unbounded retention (tamperResistant true, retainUntil set): structurally valid | unverifiable | B4.5 emitted-state bullets; B4.5 freeze rule (floor and accept); B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.8 the outcome and what is unverifiable by design |
| P17 | decision-bom | anchored_finite_lock (emitted only under accept): reported as recorded, with finite_lock_under_unbounded_retention added | unverifiable | B4.5 emitted-state bullets; B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G6 finality notes are cannotProve; B4.8 the outcome and what is unverifiable by design |
| P18 | decision-bom | anchored, verification time after retainUntil: reported anchored_lapsed with commitment_after_retain_until; the body is unchanged | unverifiable | B4.5 verifier finality check; R44 retain_until; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G6 finality notes are cannotProve; B4.8 the outcome and what is unverifiable by design |
| P19 | decision-bom | anchored, verification time exactly equal to retainUntil: lapsed ("not after the verification time") | unverifiable | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G6 finality notes are cannotProve; B4.9 G7 lapse at equality; B4.8 the outcome and what is unverifiable by design |
| P20 | decision-bom | online: the manifest is signed by an export key listed only in the verification keyring (no own key configured) | valid | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); B4.8 the outcome and what is unverifiable by design |
| P21 | decision-bom | online: the deployment's own configured export key is trusted with an empty keyring | valid | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); B4.8 the outcome and what is unverifiable by design |
| P22 | decision-bom | offline: receipt trust root as pinned fingerprints matched against receipt-keys.json; export trust root as a pinned fingerprint | valid | B4.2 'Finding the key', offline bullet; B4.8 the outcome and what is unverifiable by design |
| P23 | decision-bom | version 2 superseding version 1: root ends -v2, supersedes is v1's id, descriptor.version 2 | valid | B4.1 'Root directory'; B4.4 'Freezing' item 5; B4.1 'The manifest'; B4.9 G3 addendum payload; B4.8 the outcome and what is unverifiable by design |
| P24 | decision-bom | an operator-set installId (not email-shaped) with installIdSource operator | valid | B4.1 'The manifest'; B4.8 the outcome and what is unverifiable by design |
| P25 | decision-bom | v2 receipt naming an actor identity and grant equal to facts.actors (receipt chain and actorChain are not compared) | valid | B4.3 verifier checks: v2 actor bullet; B4.3 v2 bullet; B4.8 the outcome and what is unverifiable by design |
| P26 | decision-bom | decision.ruleChain is not recomputed by sections_projection: a body with a two-entry ruleChain is still valid | valid | B4.4 'Decided here': sections_projection bullet; B4.4 'Required checks': fixed results; B4.8 the outcome and what is unverifiable by design |
| P27 | decision-bom | a bound usage event with a null costUsd: cost.costUsd null, tokens still summed, completeness.cost recorded | valid | B4.4 sections table; R23 lossless cost; B4.9 G8 null costUsd; B4.8 the outcome and what is unverifiable by design |
| P28 | decision-bom | a linked AI BOM (facts.model.aiBomSnapshotId): content/ai-bom.json and its .sig carried, ai_bom_link valid, descriptor.aiBomSnapshotId set | valid | B4.1 'Files' table; B4.9 linked AI BOM (ai_bom_link); B4.9 G12 the AI BOM bundle; B4.8 the outcome and what is unverifiable by design |
| P29 | decision-bom | a linked AI BOM whose snapshot was pruned before export: not carried, ai_bom_link unverifiable snapshot_not_in_bundle (not by design), outcome unverifiable | unverifiable | B4.9 linked AI BOM (ai_bom_link); B4.8 the outcome and what is unverifiable by design |
| P30 | decision-bom | toolName search@v2: a bomIdentifierSchema identifier with an @ but no email shape (no dotted domain) | valid | B4.9 G14 identifier and email shapes; B4.4 sections table; B4.8 the outcome and what is unverifiable by design |
| A01 | ai-bom | AI BOM worked example A01 (install subject, version 1) as ?format=native: the signed body alone | valid | B4.1 'Root directory'; B4.1 'Files' table; B4.1 'The manifest'; B4.9 G12 the AI BOM bundle; B4.8 the outcome and what is unverifiable by design |
| A02 | ai-bom | A01 as ?format=cyclonedx-1.7: the body plus the rendering its renderings["cyclonedx-1.7"] commits to | valid | B4.1 'Root directory'; B4.1 'Files' table; B4.1 'The manifest'; B4.9 G12 the AI BOM bundle; B4.8 the outcome and what is unverifiable by design |
| A03 | ai-bom | worked example A03 (version 2, supersedes A01) as ?format=native: supersedes unverifiable earlier_snapshot_not_in_bundle by design, outcome valid | valid | B4.1 'Root directory'; B4.8 the outcome and what is unverifiable by design; B4.9 G12 the AI BOM bundle |

### Negatives: one rule each, with the failing check and reason (B4.9 G9)

| ID | Base | Mutation | Spec paragraph | Expected |
|---|---|---|---|---|
| N-M01 | P01 | manifest.json.sig signs other bytes (manifest edited after signing) | B4.1 'The manifest'; B4.1 'What is signed'; B4.9 G9 table (check and reason) | bundle_manifest_signature invalid signature_mismatch |
| N-M02 | P01 | signingKeyId names a key in neither the keyring nor the own key (rogue export key) | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); B4.2 'Finding the key', unknown_key bullet; B4.9 G9 table (check and reason) | bundle_manifest_signature invalid unknown_key |
| N-M03 | P01 | a rogue key signs the manifest under E1's key id, with its own signing-key.pub and fingerprint: the bundle key is never trusted | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); §6 verification offline, out-of-band trust root; B4.9 G9 table (check and reason) | bundle_manifest_signature invalid signature_mismatch |
| N-M04 | P01 | the export trust root holds E1's id twice with different keys | B4.2 'Finding the key', unknown_key bullet; B4.9 G9 table (check and reason) | bundle_manifest_signature invalid unknown_key |
| N-M05 | P01 | online keyring entry whose fingerprint does not match its key: the keyring is refused at load | B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2); B4.9 G9 table (check and reason) | refused (fingerprint does not match its key) |
| N-M06 | P01 | manifest.json.sig as unpadded base64url instead of padded standard base64 and a newline | B4.1 'The manifest'; B4.2 'Encoding'; B4.9 G9 table (check and reason) | bundle_manifest_signature invalid schema_violation |
| N-M07 | P01 | manifest.json.sig without its trailing newline | B4.1 'Files' table; B4.2 'Encoding': manifest signature ends with a newline; B4.9 G9 table (check and reason) | bundle_manifest_signature invalid schema_violation |
| N-M08 | P01 | manifest.json not canonical (pretty-printed) yet correctly signed | B4.1 'Files' table; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-M09 | P01 | README.txt changed after the manifest listed its SHA-256 | B4.1 'The manifest'; B4.4 'Required checks': bundle_manifest_files; B4.9 G9 table (check and reason) | bundle_manifest_files invalid hash_mismatch |
| N-M10 | P01 | an extra audit/rows/42.payload entry in the archive, not in the manifest (R39: no audit preimage) | B4.1 'Files' table; R39 no audit preimage; B4.9 G9 table (check and reason) | bundle_manifest_files invalid manifest_mismatch |
| N-M11 | P01 | audit/rows/42.payload listed in a re-signed manifest: no such file may exist in a BOM bundle | B4.1 'Files' table; R39 no audit preimage; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-M12 | P01 | a file listed in the manifest is missing from the archive | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid manifest_mismatch |
| N-M13 | P01 | manifest.files not sorted by path (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-M14 | P01 | manifest.files lists manifest.json itself (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid manifest_mismatch |
| N-M15 | P01 | manifest.files lists one path twice (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-M16 | P01 | a directory entry in the archive (no directory entry exists) | B4.1 'Files' table; B4.9 G9 table (check and reason) | bundle_manifest_files invalid bundle_unreadable |
| N-M17 | P01 | entries under two root directories | B4.1 'Root directory'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid bundle_unreadable |
| N-M18 | P01 | a symlink entry in the archive | ADR-0116 amendment 2026-10-03 (non-regular entries); B4.1 'Files' table; B4.9 G9 table (check and reason) | bundle_manifest_files invalid bundle_unreadable |
| N-M19 | P01 | root directory named -v2 for a version 1 Decision BOM | B4.1 'Root directory'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| N-M20 | P01 | email-shaped operator installId (signed): the email scan covers manifest.json | B4.1 'Build order' (R21); R21 whole-bundle email scan; B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_email_scan invalid email_shape |
| N-M21 | P01 | installId non-null with installIdSource absent (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-M22 | P01 | an email address in README.txt (listed and signed) | B4.1 'Build order' (R21); R21 whole-bundle email scan; B4.9 G9 table (check and reason) | bundle_email_scan invalid email_shape |
| N-M23 | P01 | descriptor.bodySha256 differs from content/decision-bom.json (re-signed manifest) | B4.1 'The manifest'; B4.2 'Signature file'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| N-M24 | P01 | subject.id is not the auditId (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| N-M25 | P01 | audit segment 42..43 (count 2, consistent with itself) while proof.chain is the one row 42 (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| N-M26 | P01 | schema regulait.export-bundle/2 on a BOM bundle (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-M27 | P01 | descriptor.finality differs from the body's finality (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| N-M28 | P01 | audit.payloadScope other than none (re-signed) | B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_manifest_files invalid schema_violation |
| N-B01 | P01 | body signature made over other bytes (signedSha256 matches the file, signature does not) | B4.2 'Signed bytes' table; B4.2 'Signature file'; B4.9 G9 table (check and reason) | body_signature invalid signature_mismatch |
| N-B02 | P01 | signature file's signedSha256 is not the SHA-256 of the body file | B4.2 'Signature file'; B4.9 G9 table (check and reason) | body_signature invalid hash_mismatch |
| N-B03 | P01 | signature file not canonical (keys out of order) | B4.2 'Signature file'; B4.9 G9 table (check and reason) | body_signature invalid schema_violation |
| N-B04 | P01 | body signature as padded standard base64 (88 characters), not 86-character base64url | B4.2 'Encoding'; B4.2 'Signature file'; B4.9 G9 table (check and reason) | body_signature invalid schema_violation |
| N-B05 | P01 | signature file alg is not Ed25519 | B4.2 'Signature file'; B4.9 G9 table (check and reason) | body_signature invalid schema_violation |
| N-B06 | P01 | body signed by a receipt key the trust root does not hold (R2, carried in receipt-keys.json) | B4.2 'Finding the key', unknown_key bullet; B4.2 'Finding the key', offline bullet; B4.9 G9 table (check and reason) | body_signature invalid unknown_key |
| N-B07 | P01 | a rogue key signs the body and receipt under R1's id; receipt-keys.json carries the rogue JWK: bundled keys are never the trust root | §6 verification offline, out-of-band trust root; B4.2 'Finding the key', offline bullet; B4.9 G9 table (check and reason) | body_signature invalid signature_mismatch, receipt_signature invalid signature_mismatch |
| N-B08 | P01 | domain separation: the signature file carries the receipt's signature | §5 / OWNER DECISION 2 domain separation by v; B4.2 'Signed bytes' table; B4.9 G9 table (check and reason) | body_signature invalid signature_mismatch |
| N-B09 | P01 | body v is regulait.decision-bom.v2, correctly signed | §5 / OWNER DECISION 2 domain separation by v; §5 every verifier rejects an unknown v; B4.9 G9 table (check and reason) | body_version invalid unknown_body_version |
| N-B10 | P01 | body not canonical (pretty-printed) but signed over those bytes | B4.1 'Files' table; B4.2 'Signed bytes' table; B4.9 G9 table (check and reason) | body_schema invalid schema_violation |
| N-B11 | P01 | the receipt trust root holds R1's id twice with different keys | B4.2 'Finding the key', unknown_key bullet; B4.9 G9 table (check and reason) | body_signature invalid unknown_key, receipt_signature invalid unknown_key |
| N-B12 | P01 | offline pinned receipt fingerprint does not match receipt-keys.json's entry for that id | B4.2 'Finding the key', offline bullet; B4.9 G9 table (check and reason) | body_signature invalid unknown_key, receipt_signature invalid unknown_key |
| N-R01 | P01 | receipt.payloadHash is not the SHA-256 of payload | B4.3 verifier checks: receipt_payload_hash; B4.9 G9 table (check and reason) | receipt_payload_hash invalid hash_mismatch |
| N-R02 | P01 | receipt payload not canonical (re-hashed and re-signed over the non-canonical bytes) | B4.3 verifier checks: receipt_payload_hash; B4.9 G9 table (check and reason) | receipt_payload_hash invalid schema_violation |
| N-R03 | P01 | receipt v regulait.receipt.v3: parses as neither v1 nor v2 | B4.3 verifier checks: receipt_payload_hash; §5 / OWNER DECISION 2 domain separation by v; B4.9 G9 table (check and reason) | receipt_payload_hash invalid schema_violation |
| N-R04 | P01 | receipt signature does not verify (signed over other bytes) | B4.3 verifier checks: receipt_signature; B4.9 G9 table (check and reason) | receipt_signature invalid signature_mismatch |
| N-R05 | P01 | receipt signed by a key the trust root does not hold (R2) | B4.3 verifier checks: receipt_signature; B4.2 'Finding the key', unknown_key bullet; B4.9 G9 table (check and reason) | receipt_signature invalid unknown_key |
| N-R06 | P01 | payload.keyId differs from receipt.keyId | B4.3 verifier checks: receipt_signature; B4.9 G9 table (check and reason) | receipt_signature invalid subject_mismatch |
| N-R07 | P01 | payload.receiptSeq differs from receipt.receiptSeq | B4.3 verifier checks: receipt_signature; B4.9 G9 table (check and reason) | receipt_signature invalid subject_mismatch |
| N-R08 | P01 | payload.audit.rowHash is not proof.chain[0].rowHash | B4.3 verifier checks: receipt_signature; B4.9 G9 table (check and reason) | receipt_signature invalid subject_mismatch |
| N-R09 | P01 | payload.audit.id is not the body's auditId | B4.3 verifier checks: receipt_signature; B4.9 G9 table (check and reason) | receipt_signature invalid subject_mismatch |
| N-R10 | P01 | v2 captured: factsHash is not the SHA-256 of facts.payload | B4.3 verifier checks: receipt_facts_binding; B4.3 factsHash bullet; R37 exact facts; B4.9 G9 table (check and reason) | receipt_facts_binding invalid facts_hash_mismatch |
| N-R11 | P01 | v2 capture_off but facts.payload is not null | B4.3 verifier checks: receipt_facts_binding; B4.9 G9 table (check and reason) | receipt_facts_binding invalid facts_hash_mismatch |
| N-R12 | P02 | v1 receipt at a seq at or above the known boundary (boundary 42, seq 42) | B4.3 verifier checks: receipt_facts_binding; B4.3 v2 boundary bullet (R34, R42, R43); B4.4 'Required checks': fixed results; B4.9 G9 table (check and reason) | receipt_facts_binding invalid v1_receipt_after_boundary |
| N-R13 | P25 | v2 actor.identityId differs from actors.actorIdentityId | B4.3 verifier checks: v2 actor bullet; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections actors invalid |
| N-R14 | P25 | v2 actor.delegationGrantId differs from actors.delegationGrantId | B4.3 verifier checks: v2 actor bullet; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections actors invalid |
| N-S01 | P01 | cost.inputTokens changed in the signed body | B4.4 'Decided here': sections_projection bullet; B4.4 'Sections' (B4C-02); B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections cost invalid |
| N-S02 | P01 | completeness.model claims recorded while facts.model is null | B4.4 'Decided here': sections_projection bullet; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections model invalid |
| N-S03 | P11 | the duplicate approval binding is collapsed to one entry | B4.4 sections table; B4.4 'Decided here': sections_projection bullet; B4.9 G2 approval columns; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections approval invalid |
| N-S04 | P01 | decision.toolName changed (decision is recomputed except ruleChain) | B4.4 'Decided here': sections_projection bullet; B4.4 sections table; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections decision invalid |
| N-S05 | P01 | principal.sponsorUserId is not the receipt's decision.userId | B4.4 'Decided here': sections_projection bullet; B4.4 sections table; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections principal invalid |
| N-S06 | P08 | cost.costUsd "1.0" (a trailing fractional zero) for 0.25 + 0.75 | B4.4 sections table; B4.7-3 exact decimal sum; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections cost invalid |
| N-S07 | P07 | cost.costUsd computed in binary floating point (0.1 + 0.2 + 1e-7 as doubles: 0.30000010000000005) rather than the exact decimal sum 0.3000001 | B4.4 sections table; R23 lossless cost; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections cost invalid |
| N-S08 | P07 | trace.spanIds not sorted | B4.4 sections table; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections trace invalid |
| N-S09 | P01 | completeness.approval not_applicable (B4 never emits it; a gap is never inferred) | B4.4 'Decided here': never not_applicable; B4.4 'Decided here': sections_projection bullet; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections approval invalid |
| N-S10 | P04 | v2 capture_off receipt but completeness says pre_facts | B4.4 'Decided here': no facts bullet; B4.4 'Decided here': sections_projection bullet; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch |
| N-S11 | P13 | decision.objectId carries the 300-character objectId (over 256 must be null) | B4.4 sections table; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections decision invalid |
| N-S12 | P01 | action section differs from facts.action (dataSensitivity edited) | B4.4 sections table; B4.4 'Decided here': sections_projection bullet; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections action invalid |
| N-S13 | P12 | facts.actors null but completeness.actors not_captured_by_path instead of pre_identity | B4.4 sections table; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections actors invalid |
| N-S14 | P09 | rows from an addendum left out of the cost section | B4.4 'Sources'; B4.4 sections table; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections cost invalid |
| N-C01 | P14 | a chain row's rowHash is not SHA-256(prevHash \|\| contentHash) | §6 chain links; B4.4 sections table; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G9 table (check and reason) | chain_links invalid chain_break |
| N-C02 | P14 | chain rows do not link (row 44's prevHash is not row 43's rowHash; rowHash recomputed) | §6 chain links; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G9 table (check and reason) | chain_links invalid chain_break |
| N-C03 | P01 | audit/chain.tsv differs from proof.chain (listed and signed) | B4.1 'Files' table; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| N-C04 | P01 | chain_signed but proof.chain holds two rows (it is the decision row alone) | B4.4 sections table; B4.9 G9 table (check and reason) | chain_links invalid chain_break |
| N-F01 | P14 | anchor record seq is not the last chain row's seq | R1 complete canonical anchor record; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G9 table (check and reason) | anchor_record invalid anchor_mismatch |
| N-F02 | P14 | anchor record rowHash is not the last chain row's rowHash | R1 complete canonical anchor record; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G9 table (check and reason) | anchor_record invalid anchor_mismatch |
| N-F03 | P14 | anchor record without capturedAt: a proof without all six fields is invalid, not unverifiable | R1 complete canonical anchor record; B4.9 G4 anchor spellings; B4.9 G5 anchor checks with no token; B4.9 G9 table (check and reason) | anchor_record invalid anchor_record_incomplete |
| N-F04 | P01 | finality chain_signed but proof.anchor is not null | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F05 | P14 | finality anchored but proof.anchor is null | B4.5 verifier finality check; B4.4 sections table; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F06 | P14 | finality anchored with tamperResistant false | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F07 | P14 | finality anchored with retainUntil null | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F08 | P14 | finality anchored with anchor.status not flushed | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F09 | P15 | finality anchored_unverified_destination with anchor.status not flushed | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F10 | P17 | finality anchored_finite_lock with tamperResistant false | B4.5 verifier finality check; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | finality invalid anchor_mismatch |
| N-F11 | P14 | anchored body whose completeness.proof still says not_recorded anchor_absent | B4.4 sections table; B4.4 'Decided here': sections_projection bullet; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections proof invalid |
| N-A01 | P09 | addendum 1's prevHash is not facts_hash | R35 addendum chain; R5 verifier checks the chain back to factsHash; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | facts_addenda_chain invalid addendum_chain_break |
| N-A02 | P09 | addendum 2's signature does not verify | R15 addendum signatures; B4.2 'Signed bytes' table; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | facts_addenda_signatures invalid signature_mismatch |
| N-A03 | P09 | addenda numbered 1 and 3 (a gap) | R35 addendum chain; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | facts_addenda_chain invalid addendum_chain_break |
| N-A04 | P09 | addendum signed by a key the trust root does not hold (RX) | R15 addendum signatures; B4.2 'Finding the key', unknown_key bullet; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | facts_addenda_signatures invalid unknown_key |
| N-A05 | P09 | an addendum signature made over the receipt payload bytes (domain separation by v) | B4.2 'Signed bytes' table; R15 addendum signatures; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | facts_addenda_signatures invalid signature_mismatch |
| N-R15 | P01 | v2 receipt at seq 42 below the trust root's boundary (100) | B4.9 G10 v2 receipts and the boundary; B4.2 'Finding the key', receipt v2 boundary bullet; B4.9 G9 table (check and reason) | receipt_facts_binding invalid v2_receipt_before_boundary |
| N-R16 | P01 | v2 receipt verified against a trust root that records no boundary (no cutover) | B4.9 G10 v2 receipts and the boundary; B4.2 'Finding the key', receipt v2 boundary bullet; B4.9 G9 table (check and reason) | receipt_facts_binding invalid v2_receipt_before_boundary |
| N-S15 | P01 | basis.auditSeq is not the last proof.chain seq | B4.9 G13 basis; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections proof invalid |
| N-S16 | P14 | basis.anchorId is not proof.anchor.id | B4.9 G13 basis; B4.9 G4 anchor spellings; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections proof invalid |
| N-S17 | P09 | usage event e…01 bound in facts.rows and again in addendum 1 (assembly refuses this, X04) | B4.9 G15 a row bound twice; B4.9 G3 addendum payload; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch, facts_addenda_chain invalid addendum_chain_break; sections cost invalid |
| N-S18 | P27 | costUsd given as the one non-null row's value although a bound row's costUsd is null | B4.9 G8 null costUsd; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections cost invalid |
| N-S19 | P28 | basis.aiBomSnapshotId is not facts.model.aiBomSnapshotId (descriptor follows basis) | B4.9 G13 basis; B4.9 G9 table (check and reason) | sections_projection invalid section_mismatch; sections model invalid |
| N-M29 | P30 | toolName search@v2.x: an identifier that is also an email shape (dotted domain after the @) | B4.9 G14 identifier and email shapes; R21 whole-bundle email scan; B4.9 G9 table (check and reason) | bundle_email_scan invalid email_shape |
| N-L01 | P28 | the carried AI BOM is another snapshot (A03) than basis.aiBomSnapshotId (A01) | B4.9 linked AI BOM (ai_bom_link); B4.9 G9 table (check and reason) | ai_bom_link invalid bom_link_mismatch |
| N-L02 | P28 | the carried AI BOM is signed by a receipt key the trust root does not hold (RX) | B4.9 linked AI BOM (ai_bom_link); B4.2 'Finding the key', unknown_key bullet; B4.9 G9 table (check and reason) | ai_bom_link invalid unknown_key |
| N-L03 | P01 | content/ai-bom.json carried (listed and signed) while basis.aiBomSnapshotId is null | B4.1 'Files' table; B4.9 linked AI BOM (ai_bom_link); B4.9 G9 table (check and reason) | bundle_manifest_files invalid manifest_mismatch |
| NA01 | A02 | the carried CycloneDX 1.7 file is not the bytes the body commits to (listed and signed) | B4.9 G12 the AI BOM bundle; B4.9 G9 table (check and reason) | rendering_hashes invalid hash_mismatch |
| NA02 | A01 | a cyclonedx-1.6 file carried although the body has no rendered cyclonedx-1.6 entry | B4.9 G12 the AI BOM bundle; B4.9 G9 table (check and reason) | rendering_hashes invalid rendering_not_in_body |
| NA03 | A01 | serialNumber not derived from snapshot.id (body re-signed) | B4.9 G12 the AI BOM bundle; B4.9 G9 table (check and reason) | serial_number invalid serial_mismatch |
| NA04 | A01 | descriptor.version 2 for a version 1 snapshot (re-signed manifest) | B4.9 G12 the AI BOM bundle; B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| NA05 | A01 | content/ai-bom.json.sig signs other bytes | B4.9 G12 the AI BOM bundle; B4.2 'Signature file'; B4.9 G9 table (check and reason) | body_signature invalid signature_mismatch |
| NA06 | A01 | body v regulait.ai-bom.v2 (re-signed) | B4.9 G12 the AI BOM bundle; §5 / OWNER DECISION 2 domain separation by v; B4.9 G9 table (check and reason) | body_version invalid unknown_body_version |
| NA07 | A02 | descriptor.formats lists native only while the CycloneDX file is carried (re-signed manifest) | B4.9 G12 the AI BOM bundle; B4.1 'The manifest'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |
| NA08 | A01 | an audit/chain.tsv in an AI BOM bundle (listed and signed) | B4.9 G12 the AI BOM bundle; B4.1 'Files' table; B4.9 G9 table (check and reason) | bundle_manifest_files invalid manifest_mismatch |
| NA09 | A01 | root directory without the -native suffix for a ?format=native bundle | B4.9 G12 the AI BOM bundle; B4.1 'Root directory'; B4.9 G9 table (check and reason) | bundle_subject invalid subject_mismatch |

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
| E21 | not tamper-resistant AND retain_until null, floor anchored_unverified_destination: destination_not_tamper_resistant | freeze anchored_unverified_destination (short of anchored by destination_not_tamper_resistant) |
| E22 | unbounded retention on a non-tamper-resistant destination under accept: never a finite lock | 409 bom_anchor_pending destination_not_tamper_resistant |
| E23 | timestamps required and none granted AND retain_until null, floor anchored: timestamp_pending | 409 bom_anchor_pending timestamp_pending |
| E24 | retain_until lapsed AND unbounded retention under accept: lock_lapsed, never a finite lock | freeze anchored_unverified_destination (short of anchored by lock_lapsed) |
| E25 | unbounded retention on a non-tamper-resistant destination under accept, floor anchored_unverified_destination | freeze anchored_unverified_destination (short of anchored by destination_not_tamper_resistant) |

### Verify-response rules (B4.4 required checks and fixed results; B4.8 outcome, by design, cannotProve)

| ID | Response | Conforms | Spec paragraph |
|---|---|---|---|
| Q01 | the B4.6 report: every required check, fixed results, outcome valid (B4.8: every unverifiable result is by design) | yes | B4.4 'Required checks' (B4C-01); B4.6 worked example; B4.8 the outcome and what is unverifiable by design |
| Q02 | a non-invalid outcome missing the finality check | no | B4.4 'Required checks' (B4C-01) |
| Q03 | decision_content_binding reported valid | no | B4.4 'Required checks': fixed results |
| Q04 | outcome unverifiable although every unverifiable result is by design (it must be valid) | no | B4.8 the outcome and what is unverifiable by design |
| Q05 | a stored source reporting bundle_manifest_signature valid | no | B4.4 'Required checks' (B4C-01) |
| Q06 | a stored source reporting the bundle checks unverifiable not_a_bundle: by design, outcome valid | yes | B4.4 'Required checks' (B4C-01); B4.8 the outcome and what is unverifiable by design |
| Q07 | a bundle source reporting not_a_bundle | no | B4.4 'Required checks' (B4C-01) |
| Q08 | a check reported twice without distinct non-null refs | no | B4.4 'Required checks' (B4C-01) |
| Q09 | a v2 receipt with receipt_facts_binding unverifiable receipt_v1_no_factsHash | no | B4.4 'Required checks': fixed results |
| Q10 | a v1 receipt with receipt_facts_binding valid | no | B4.4 'Required checks': fixed results |
| Q11 | anchor_absent on an anchored BOM's anchor checks | no | B4.4 'Required checks': fixed results |
| Q12 | sections_projection reported unverifiable | no | B4.4 'Sections' (B4C-02) |
| Q13 | an invalid check with outcome valid (any invalid gives invalid) | no | B4.4 'Sections' (B4C-02); B4.8 the outcome and what is unverifiable by design |
| Q14 | a stored ai_bom_snapshot source used for a Decision BOM | no | B4.4 'Required checks' (B4C-01); B4.4 'Required checks': stored source names its own subject (B4C-03) |
| Q15 | a missing required check with outcome invalid is admissible (a response missing one can only be invalid) | yes | B4.4 'Required checks' (B4C-01) |
| Q16 | anchored with no timestamp token, outcome valid (no_timestamp_token is not by design: it must be unverifiable) | no | B4.8 the outcome and what is unverifiable by design; B4.9 G5 anchor checks with no token |
| Q17 | anchored with no timestamp token, outcome unverifiable | yes | B4.8 the outcome and what is unverifiable by design; B4.9 G5 anchor checks with no token |
| Q18 | a v1 receipt below the boundary: receipt_v1_no_factsHash is by design, outcome valid, facts_recorded_at_decision_time listed | yes | B4.8 the outcome and what is unverifiable by design; R46 v1 facts not claimed |
| Q19 | the B4.6 report without external_commitment in cannotProve | no | B4.8 the outcome and what is unverifiable by design |
| Q20 | a section reported unverifiable (a section is valid or invalid in v1) | no | B4.8 the outcome and what is unverifiable by design |
| Q21 | a v1 receipt reported v2_receipt_before_boundary | no | B4.9 G10 v2 receipts and the boundary |
| Q22 | an AI BOM bundle of version 2: supersedes unverifiable earlier_snapshot_not_in_bundle is by design, outcome valid, superseded_snapshot listed | yes | B4.8 the outcome and what is unverifiable by design; B4.9 G12 the AI BOM bundle |
| Q23 | a stored AI BOM of version 2 whose earlier snapshot was pruned, outcome valid (on a stored source it is not by design) | no | B4.8 the outcome and what is unverifiable by design; B4.9 G12 the AI BOM bundle |

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

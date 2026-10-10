# ADR-only Decision BOM verification vectors (X46)

These vectors were authored independently from ADR-0189 text. No B4 implementation, shared BOM schema/contract/tests, PR #307, prior author's vectors, or parallel review was read. The coordination board was read at `5164b2f20bfaf124b509b931d0ad36f3279d1d35`. ADR-0116 text was read only for the archive and trust-root rules explicitly delegated by ADR-0189 §6. No product source is imported by this directory.

Frozen specification evidence:

| Source | Revision |
| --- | --- |
| Repository base | `2276739bb1ca3d5cddfcf03cbef186d59e1966a7` |
| [ADR-0189](../../../../docs/decisions/0189-batch6-decision-bom-ai-bom.md) Git blob | `73653a8c4b000dfccf734c8512b7dfcaa4129036` |
| ADR-0189 last change | `4f9f50a2cdc7f540d269e30eabbaa55e736e36f3` |
| ADR-0116 Git blob | `311263cb8f9dc8d8888ba15edf98887615227b05` |

## Scope and use

`semantic-vectors.json` contains 71 semantic, mutation and lifecycle cases. Its `given`, `operation` and `expected` strings describe test obligations; they are **not** request or response DTOs. Positive cases specify an individual valid binding or permitted lifecycle outcome. No positive asserts that all sections of a complete document verify as valid: R39 always limits decision-content binding, and R46 adds the v1 facts limit. Cases with independently authentic outer/body signatures deliberately retain invalid inner evidence.

`crypto-vectors.json` contains 10 authentic Ed25519 byte fixtures plus exact facts/rendering digest material. The small signed bodies intentionally exercise primitives and `v` domain separation only. They omit required product sections and cannot serve as schema-complete BOMs, receipts or bundle archives. Base64 signatures and DER SPKI keys are fixture transport choices, not inferred product envelope encodings. The two deterministic test-only seeds are public synthetic material; no deployment key was used.

`check-vectors.mjs` checks those fixtures using Node's built-in crypto, exact-byte SHA-256, limited canonical-object comparisons and corpus metadata. It cannot verify product behavior. It does not execute the 71 semantic cases or validate official CycloneDX/SPDX schemas. K04 rejects a freshly signed body under the original independently pinned root A; K05 accepts the same signature under separately supplied root B. K05 never licenses treating a bundled key as a trust root.

Run from the repository root:

```sh
node packages/shared/test-vectors/decision-bom/check-vectors.mjs
node packages/shared/test-vectors/decision-bom/check-vectors.mjs --red-signature
node packages/shared/test-vectors/decision-bom/check-vectors.mjs --red-rendering
```

The first command must pass 25 fixture-integrity checks. Each red command must fail with the named assertion after the integrity checks. These are independent primitive fault checks, not red proofs against the B4 implementation.

B4's owner should adapt the semantic descriptions to real records and bundles while preserving every expected result. Independently pin the trust roots, construct authentic pristine controls, and re-sign only the layers explicitly named by a mutation. Run each negative beside its pristine positive; reject-all cannot satisfy the pairs. For F03, P05 and B05 expand the enumerated mutations separately. Include lifecycle observations of frozen rows and bytes; a pure verifier cannot prove those storage/transaction rules. Report each executed case and each unresolved schema gap separately. Do not reinterpret this specification to match an implementation's behavior.

## Exact ADR sections covered

Each case embeds its citations. The matrix provides the ADR section titles as well:

| Cases | ADR-0189 sections and amendments |
| --- | --- |
| S01–S07, K01–K10 | Decision §5 “Signing, freezing and exact-byte reproducibility”; §6 “Verification, offline”; Owner decision 2; Test strategy “Signature and binding”; R6 “Verification never needs the private key”; delegated ADR-0116 §1 trust root and §4 rotation |
| S08–S13 | §6; R48 “The bundle carries the exact receipt envelope” |
| F01–F03 | §4 decision-transaction capture; §6; R37 exact facts and recomputed section projections; R48 |
| F04–F09 | R34 recorded cutover/facts rules; R42 audit-sequence boundary; R46 v1 facts shown without receipt-binding claim |
| F10–F13 | R5 historical-section binding; R15 independent capture/signing; R35 ordered addendum chain; R37 exact bytes |
| R01–R05 | R7 renderings only inside verifiable bundles; R19 AI BOM verification, signed hash and byte length |
| R06–R07 | R2 no backfill/new renderer requires new version; R3 missing mandatory SPDX values and not_producible |
| L01–L06 | §5; R4 observed tamper-resistant destinations and three finality states; R44 retention coverage |
| L07–L09 | R15 existing unsigned addenda block freezing; R6 private key unnecessary for verification/frozen reads |
| L10–L14 | §5; R18 stored projections only; R40 locked assembly; entry condition B1/B4 `4237344247` concurrent first requests |
| L15 | R2 and R17 renderer-release switch |
| P01–P04 | R4 strictest-first ranks; R44 retain_until coverage and anchored_lapsed reporting |
| P05–P09 | R1 six-field canonical anchor; §6 chain links; Test strategy “Signature and binding”; R33 timestamp request facts; R39 no preimage/unverifiable content binding |
| C01–C05 | §2 missing facts are limits; §3 incomplete compositions; §7 strict invariants; Test strategy “Honesty”; after-spike amendment 8 licence guidance |
| C06–C08 | R24 dataset gaps; R26 honest checksum handling; R27/R49 unknown flow classification; B3 entry condition `4237376660` unknown assessor |
| B01–B02 | §6 export-bundle/3 subjects; R19 AI subject/native v binding |
| B03–B04 | R39 no audit payload preimages; R21 whole final bundle email scan |
| B05–B06 | Delegated ADR-0116 §5 and Tests manifest membership; amendment 2026-10-03 non-regular entry refusal |

## Literal product-wire positives: BLOCKED

ADR-0189 §2 lists document sections and their content but does not give a complete nested JSON schema, required/nullable forms, or signature envelope encodings. R18/R37 delegate the canonical projection column lists and section mapping to the B1 shared zod. Reading that contract to fill these gaps would violate this assignment's ADR-only independence rule.

ADR-0189 §6 names `regulait.export-bundle/3` and delegates archive conventions to ADR-0116. ADR-0116 §5 supplies the filenames, TSV columns, exact manifest signature bytes and SPKI fingerprint definition, but its `/1` manifest description does not specify the complete `/3` manifest and BOM content paths or link records. R39 explicitly overrides ADR-0116's audit payload inclusion: no row preimage may be exported in a BOM bundle.

R19 specifies each rendering's SHA-256 and byte length inside the signed native body, but not the exact commitment-record structure. R37/R48 require exact facts/addendum/receipt envelopes, but do not specify every envelope key/encoding and all cross-document identity fields. The BOM-Link triple and supersedes validation require a normative wire representation. RFC3161 token bytes and request nonce representation are likewise insufficiently specified here to construct a schema-complete timestamp fixture.

R4 specifies only `anchored > anchored_unverified_destination > chain_signed`. R44 adds a reported `anchored_lapsed` state after retain_until passes; it does not define another freeze-state rank. Literal rank numbers and any other state name are unavailable from this text. Do not silently add a new rank from implementation conventions.

Requested specification completion: publish normative ADR text or an ADR-owned appendix with complete valid Decision BOM, AI native snapshot, receipt/addendum and export-bundle/3 examples; canonical projection/mapping rules; envelope encodings; rendering commitment and BOM-Link layout; trust-id mapping; and finality acceptance/reporting behavior. Until then, schema-complete literal positive archives and execution of these semantic obligations against B4 remain **BLOCKED/unrun**. No import of the shared contract or passing fixture check resolves that gap.

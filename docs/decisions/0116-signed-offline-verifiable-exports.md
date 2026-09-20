# ADR-0116 — Signed, offline-verifiable export bundles: the trust root is a fingerprint obtained OUT OF BAND, the bundled public key is never the authority, and no signing key means a refusal rather than an unsigned bundle

- **Status**: Accepted
- **Date**: 2026-09-19
- **Relates to**: [ADR-0060](0060-tamper-evident-audit.md) (the `prev_hash`/`row_hash`
  chain, `canonicalJson`, the genesis constants, and the WORM anchor that is the only control
  against a wholesale rewrite — everything this ADR leans on for evidentiary value),
  [ADR-0052](0052-licensing-seats.md) (offline Ed25519 verification against a
  **pinned** keyring, and its "fail closed on a forgery" posture, reused rather than
  reinvented), [ADR-0041](0041-byoc-primary-motion.md) (`scripts/verify-update-bundle.sh` — the house
  pattern this verifier is built to match, down to the regex-over-JSON field extraction and the
  absence of a `--force`), [ADR-0031](0031-p0-hardening-streaming-exports-proxy-trust-rate-limits-csp.md) (the streaming CSV export
  whose bytes — including its truncation disclosure row — the bundle carries verbatim),
  [ADR-0047](0047-executive-compliance-reporting.md) (the report-run artifact and its export
  route)
- **Migration**: **none.** No column is added, dropped, backfilled or renamed. `drizzle-kit
  generate` was **not** run and nothing in `packages/db/migrations/` is touched. The only schema
  file change is one new value, `audit_export`, in `audit_log.object_type`'s **TypeScript** enum
  — a text column with no DB CHECK (migration 0001), the same TS-only widening ADR-0045/0052/0054
  and a dozen others made.

## Context

A customer-facing deck claims this in **three** places, not two — the third was found while
checking the first two, and matters because a fix applied to only the slides someone quoted would
leave the claim standing elsewhere:

> *"Evidence & Audit: … Signed exports an auditor can verify alone."*
>
> *"Exports verify without us — a signed, self-verifying bundle your auditor can check
> independently — no portal login, no working session with the vendor."*
>
> *"Roles and scoped API keys, hash-chained audit, **signed self-verifying exports**, retention
> presets, backup and restore, offline licence verification."* — a feature list, where the phrase
> is doing the same work in three words.

**Both were false.** `GET /v1/reports/runs/:id/export` returned plain unsigned CSV or JSON.
`GET /v1/audit.csv` streamed plain unsigned CSV. Ed25519 signing existed in this repo only for
licences (`apps/gateway/src/licensing.ts`) and update bundles
(`scripts/build-update-bundle.sh`). The only integrity check the product offered over its audit
trail was `GET /v1/audit/verify` — **a live API call against the running system**, which is the
precise opposite of what the deck promises.

### The failure this design exists to avoid, found in a sibling product

A sibling product's export verifier resolved the public key by calling `licensing.public_key()`,
which read a keypair **generated on the customer's own machine at first use**. Three
consequences, each fatal:

1. The signature proved only that *whoever held that box* signed it. Anyone with the box could
   mint a bundle indistinguishable from a genuine one.
2. Verification required the product installed — so "verify alone" was untrue in the most
   literal way.
3. Its own error text told the auditor to **"obtain the public key from the vendor"**, which was
   false: the key was never the vendor's, and the vendor could not have supplied it.

The generalisation, stated plainly because it is the load-bearing idea of this ADR:

> **A bundle that carries its own public key is self-*consistent*, not self-*verifying*.** Anyone
> can doctor the content, mint a fresh keypair, re-sign, swap in the new public key — and the
> bundle still "passes".

## Decision

### 1. The trust root is a key fingerprint the auditor obtains ONCE, out of band

The bundle is signed by an **Ed25519 key held by the deployment** (the customer's own install),
named by a `signingKeyId`, and identified by a **fingerprint**:

```
sha256:<64 hex>   over the DER SubjectPublicKeyInfo
```

reproducible with stock tooling and nothing of ours:

```
openssl pkey -pubin -in <key>.pub -outform DER | sha256sum
```

`scripts/verify-export-bundle.sh` **refuses to run at all** unless the auditor supplies that
trust root themselves — `--fingerprint sha256:<hex>` or `--keyring <dir>` of pinned `.pub` files.
With `--keyring`, the **pinned** copy is what the signature is checked against and the bundled
copy is never read. With `--fingerprint`, the bundled copy is used only after its fingerprint has
been shown to equal the value the auditor brought with them.

The bundle still ships `signing-key.pub`, because an auditor needs the key bytes to run
`openssl`. It is labelled, in the manifest and in the bundle's own `README.txt`, as a
**convenience copy and not the trust root**, and the verifier will not treat it as one.

`GET /v1/exports/signing-key` is the **publication point**: the admin reads the fingerprint there
once and hands it to their auditor through a channel the auditor already trusts. It is
deliberately **not** something the verifier fetches — a verifier that phoned an endpoint would be
back to "verification requires the product running", which is the thing the bundle exists to
escape.

**Alternatives considered and rejected.** *Vendor countersignature*: breaks air-gapped operation
(ADR-0041's primary motion), breaks "no working session with the vendor", and — decisively — the
vendor cannot attest to a customer's data anyway, so the signature would assert something its
signer does not know. *Trust the bundled key*: the sibling product's failure, above. *A key
generated at first install*: the same failure with extra steps, and it manufactures an identity
nobody attested to.

### 2. What the bundle DOES and DOES NOT prove — stated in the bundle itself

**A passing verification proves:**

- the content in `content/` is byte-for-byte what was signed;
- it was signed by the private key whose fingerprint the auditor supplied;
- the audit rows in `audit/rows/` hash to the content hashes in `audit/chain.tsv`, those link
  into an unbroken ADR-0060 chain, and that chain ends at the head recorded in the signed
  manifest;
- the export happened at the time the manifest records, **by the database's clock**, performed by
  the recorded actor, on the recorded install.

**It does NOT prove the underlying records are TRUE.** An operator with administrative access to
the source database could rewrite the audit log wholesale and re-derive a consistent chain before
exporting. Detecting *that* is exactly what ADR-0060's external anchor exists for, and the
bundle's README says so and tells the auditor to compare the manifest head against any anchor
they retained. It also does not prove completeness with respect to a query the auditor did not
specify — which is why the manifest's subject descriptor records the filters, the window, the row
ceiling and whether the ceiling bit.

### The exact sentence the deck should use

The current claim cannot be made without a boundary, and a real guarantee with a stated boundary
is worth more than a slogan. Replace all three — the two slides and the feature-list line — with:

> **"Exports are signed. Your auditor verifies them offline — no portal login, no network, no
> RegulAIt install, no call with us — against a key fingerprint you give them once."**

In the feature list, the three-word form becomes **"signed, offline-verifiable exports"**.

Everything in those is now true and tested. Neither says "self-verifying", because nothing is; it names the one thing the auditor must obtain out of band, and it makes clear the
key is the customer's.

### 3. No signing key means a REFUSAL

If `$REGULAIT_EXPORT_SIGNING_KEY` / `$REGULAIT_EXPORT_SIGNING_KEY_ID` are unset, malformed or
unreadable, the signed routes return **409** with a named rule (`export-signing-key-absent`,
`export-signing-key-id-absent`, `export-signing-key-id-malformed`,
`export-signing-key-unreadable`) and an actionable custody instruction. They do **not** emit an
unsigned bundle, and they do **not** generate a keypair. The refusal text deliberately never says
"obtain the key from the vendor" — that sentence is the sibling product's lie, and a test asserts
it is absent.

The unsigned routes keep working unchanged, so the refusal is about the key and never about the
export being impossible; the tests pair every 409 with a successful unsigned export of the same
object.

### 4. Rotation does not invalidate past bundles

The manifest names `signingKeyId` **and** `signingKeyFingerprint`. Verification is per-bundle
against the key that bundle names. So:

- a bundle signed by key A stays verifiable forever against A's fingerprint, or against a keyring
  that still holds `A.pub`, no matter what the deployment signs with today;
- a keyring holding both `A.pub` and `B.pub` verifies both generations — the supported way to
  hold a rotation;
- a bundle signed by B, checked against A's fingerprint, is **refused**, and the refusal names
  the fingerprint it actually saw and asks the auditor to confirm a rotation through the channel
  they already trust. That is how an auditor *learns* a rotation happened instead of silently
  accepting a new key — the same reasoning ADR-0041 gives for pinning.

The auditor's obligation is therefore to **retain old fingerprints**, not to re-verify old
bundles after every rotation.

### 5. What the bundle carries, and why each part is there

```
regulait-export-<kind>-<id>/
  manifest.json             canonical JSON (ADR-0060 canonicalJson) — the ONE signed object
  manifest.json.sig         base64 Ed25519 over manifest.json's EXACT bytes
  content/<file>            the export, verbatim — byte-identical to the unsigned route
  audit/chain.tsv           seq, content_hash, prev_hash, row_hash — one line per segment row
  audit/rows/<seq>.payload  the EXACT canonical payload bytes ADR-0060 hashes
  signing-key.pub           convenience copy — NOT the trust root
  README.txt                what it proves, what it does not, and how to check it
```

- **`canonicalJson`, not a second canonicalisation.** ADR-0060's is the serialisation this repo
  already trusts for hashing; a parallel one would be a second answer to "what are these bytes".
  It also gives the manifest sorted keys, which is what lets the verifier extract fields with
  `grep`/`sed` on an auditor's bare machine instead of requiring a JSON parser — the same choice
  `verify-update-bundle.sh` made, for the same reason.
- **`audit/rows/<seq>.payload` — the idea that makes the bundle checkable with `sha256sum`
  alone.** Shipping the *exact bytes that were hashed* means the verifier never has to
  re-implement canonical JSON: `sha256sum` of the file must equal the recorded `content_hash`.
  It is also what makes the bundle **readable** — the auditor can look at the audit row whose
  hash they just recomputed, in words, rather than being asked to trust a digest over data they
  cannot see.
- **These payload files are NOT listed in `manifest.files[]`.** Their digests *are* the
  `content_hash` values in `chain.tsv`, and `chain.tsv` is listed and signed. Listing them twice
  would create two lists that can disagree about the same bytes. The verifier excludes exactly
  this path prefix from its "nothing extra" check and says why, inline.
- **A CONTIGUOUS segment ending at the head, not "the rows about this subject".** A bag of
  scattered rows has no chain in it: `prev_hash[n] === row_hash[n-1]` is uncheckable and each row
  would only be checkable against itself. The segment starts at the earliest chained row
  mentioning the subject — so the generation event and the export event are both inside — and is
  capped by `REGULAIT_EXPORT_BUNDLE_MAX_CHAIN_ROWS` (default 2000). When the cap bites, the
  manifest carries `segmentTruncated: true`, names the subject seqs left outside, and the
  verifier **prints the truncation as a disclosure**. An auditor must never have to guess whether
  a short segment is the whole story.
- **`exportedAt` is the DATABASE clock** (`select now()`), not the process clock: the audit rows
  it is bundled with are stamped by Postgres, and the host clock is the one an operator can
  trivially move.
- **Install identity is operator-set or licence-derived or ABSENT** — `$REGULAIT_INSTALL_ID`,
  else the installed signed licence's `licenseId`, else `null` with `installIdSource: "none"` and
  the README saying the key fingerprint is the identity in that case. There is deliberately **no
  generated-at-first-use install uuid**: a number this process invented would read as an attested
  identity while being nothing of the kind — the same mistake, one layer down, as the sibling
  product's self-minted key.
- **The export's own audit row is written BEFORE the bundle is built**, so the head the manifest
  commits to already contains the record of the bundle's own creation. A test asserts the head
  row's `ruleId` is `report-exported` and its `objectId` is the run — the bundle records that it
  was taken.

### 6. Which export producers are covered — enumerated, not implied (M-035)

The deck says "exports", plural. There are **six** route-level export producers in this gateway.

| route | covered by ADR-0116 | note |
|---|---|---|
| `GET /v1/reports/runs/:id/export` (`reporting.ts`) | **YES** — `?signed=1`, both `format=csv` and `format=json` | the headline "compliance report" artifact |
| `GET /v1/audit.csv` (`app.ts`) | **YES** — `?signed=1` | the one an auditor actually asks for; its own export is chained as `audit_export` |
| `GET /v1/projects/:projectId/costs.csv` (`projects.ts`) | **NO** | spend attribution, not evidence; `streamCsv`-shaped, so `collectCsv` makes it a small follow-up |
| `GET /v1/billing/statements/:id/export` (`billing.ts`) | **NO** | a commercial document; signing it is a separate argument about what an invoice attests to |
| `GET /v1/onboarding/export` (`onboarding.ts`) | **NO** | a configuration snapshot for re-import, not an evidentiary artifact |
| `POST /v1/tracing/export` (`tracing.ts`) | **NO, and out of scope by kind** | an OTLP **push** to a collector, not a download — there is no bundle to hand anyone |

Three uncovered download routes is a real gap and is stated rather than implied: the guarantee
today covers the **compliance report artifact and the audit trail**, which is what the "Evidence
& Audit" slide is about, and not every file the product can emit. The deck sentence in §2 is
worded to describe what is covered; if it is used beside a screenshot of a cost CSV it becomes an
overstatement again.

### 7. `collectCsv` — one rendering loop, not two

`csv-export.ts`'s body was extracted into `emitCsv(spec, sink)`. `streamCsv` is that loop with a
socket sink (byte-identical, same headers, same terminator); `collectCsv` is the same loop with a
string sink. A bundled CSV therefore carries the **same trailing truncation/window disclosure
row** the streamed one does — a signed document that quietly dropped the disclosure would be
asserting a completeness it does not have. A second rendering path written for bundles would have
been a second answer to "what does this export contain".

Bundled CSV is held in memory to be hashed, so it takes its own lower ceiling,
`REGULAIT_EXPORT_BUNDLE_MAX_CSV_ROWS` (default 50 000, and `min()`-ed with `csvMaxRows()`), and
that ceiling is recorded in the signed subject descriptor.

### 8. A deterministic ustar writer instead of a tar dependency

~70 lines in `export-bundle.ts`. Two reasons: a tar library in the gateway to emit seven small
files is not a trade this repo makes; and every varying header field (mtime, uid, gid, mode) is
pinned to a constant, so identical inputs produce identical archive bytes — an evidence artifact
whose bytes change between two identical exports is one nobody can diff.

The probes found the 100-byte `name` field: the bundle's paths carry the subject uuid twice (in
the root directory and in the content filename) because an auditor holding several extracted
trees needs to tell them apart, and that overruns it. Answered with ustar's `prefix` field rather
than by truncating the id — an evidence artifact should not lose information to a 1988 archive
layout.

## Verification

### Pass criteria and predictions were written BEFORE running (M-023)

**Baseline, measured on a freshly created `regulait_test`**: **180 files / 2753 passed / 9 skipped
/ exit 0** — matching the owner's independent measurement exactly.

### Every tamper case was performed, and each produced a DISTINCT refusal

Each runs the real `scripts/verify-export-bundle.sh` as a subprocess and asserts a non-zero exit.

| tamper | refusal |
|---|---|
| flip a byte in `content/*.csv` | `CONTENT DIGEST MISMATCH: 1 file(s) do not match their signed digest` |
| flip a byte in `manifest.json` | `SIGNATURE DOES NOT VERIFY under <keyId>` |
| alter one exported audit row | `AUDIT ROW TAMPERED at seq N — content_hash does not cover its bytes` |
| swap the chain head, **re-signed with the real key** | `CHAIN HEAD MISMATCH — the segment does not end at the head the manifest signed` |
| break a chain link, **re-signed with the real key** | `CHAIN BROKEN at seq N — prev_hash does not name the preceding row's row_hash` |
| delete a chain row and repair its neighbour's link, **re-signed** | `CHAIN BROKEN — sequence gap: expected seq N, found N+1` |
| **THE TRAP** — doctor the content, swap in a freshly minted public key, rewrite the manifest fingerprint, re-sign with that key (the bundle is now perfectly self-consistent) | `UNKNOWN SIGNING KEY — fingerprint is not one you pinned`, naming the fingerprint it saw and asking whether the operator rotated |
| no trust root supplied | `NO TRUST ROOT SUPPLIED — refusing to verify` |
| manifest declares a fingerprint that is not the shipped key's | `MANIFEST FINGERPRINT DOES NOT DESCRIBE THE KEY IT SHIPPED WITH` |
| an unlisted extra file | `the bundle contains file(s) the signed manifest does not list` |
| a listed file removed | `1 file(s) listed in the signed manifest are MISSING from the bundle` |

A twelfth test asserts the set of those messages is **distinct** — a verifier that answered
"verification failed" to all of them would be useless to the person holding the bundle, and
nothing else would have caught that.

**M-033 — every negative is paired.** Each tamper case calls `verifyOk` on the **pristine bundle
first, in the same test**, asserting exit 0 and `[VERIFIED]`. A refusal can therefore never be
explained by "the bundle was broken to begin with" or "the script refuses everything". The
positive side also asserts substance, not absence: the content in the bundle is byte-identical to
what the unsigned route returns, the head row is the export's own audit row, and the published
fingerprint is reproduced from the key file with stock `openssl | sha256sum`.

### Predictions vs results — including the two that were wrong

- **Predicted**: flipping `"product":"regulait"` in the manifest yields `SIGNATURE DOES NOT
  VERIFY`. **Got**: `manifest is not a RegulAIt export bundle`. The verifier validates the
  schema/product fields *before* checking the signature (as `verify-update-bundle.sh` does), so a
  structural field is caught structurally. The probe was moved to `exportedAtSource`, a field
  with no structural check, and the signature is what catches it. **The prediction was wrong and
  the verifier was right.**
- **Predicted**: deleting a chain row yields a sequence gap. **Got**, first time: `row_hash does
  not follow from prev_hash and content_hash`. The bash verifier's checks were in a different
  order from `verifyChainBatch`'s, so the attacker's own repair of the neighbour's `prev_hash`
  tripped a downstream hash before the gap was noticed. **The verifier was wrong** and now runs
  ADR-0060's own order — order, linkage, content, linked value — so a deletion is reported as a
  deletion.
- **Predicted**: bundles build fine. **Got**: 500s from `tarHeader` — ustar's 100-byte name
  limit, described in §8. Found only because the probes exported a *real* run whose uuid appears
  twice in the path.

### Non-vacuity — three probes, each against a DIFFERENT control

One blunt probe at "the signature" would have reddened everything and proved nothing about each
control, so the neutralisations are separate (M-035's shape applied to non-vacuity).

| probe | neutralisation | predicted | measured |
|---|---|---|---|
| **N1** | verifier accepts the **bundled** key as the trust root | 3 failures (+ rotation "may also redden") | **4 failed / 22 passed** — THE TRAP, no-trust-root, the distinct-message count, and rotation. As predicted, every digest and chain case stayed green. |
| **N2** | verifier skips the chain section entirely | 5 failures | **6 failed / 20 passed** — the four chain cases, the distinct-message count, **and the positive control**, which asserts the verifier's output says `audit chain:`. The prediction was wrong by one, and the extra is the better outcome: the M-033 pairing itself detects the neutralisation. Signature/digest/trust-root cases stayed green. |
| **N3** | gateway emits an **unsigned** export instead of 409 when no key is configured | 3 failures | **3 failed / 23 passed** — exactly the three "no signing key" cases, nothing else. |
| **N4** | revert all three | clean | **26/26, and `git diff` is empty** for both touched files. |

### Suite, build, typecheck

- **After**: **181 files / 2779 passed / 9 skipped / 0 failed, exit 0** on a freshly created
  database. Exactly **+1 file, +26 tests** against the 180/2753 baseline; the 9 MinIO skips are
  unchanged and nothing else moved.
- `pnpm -r build` exit 0. `pnpm -r exec tsc --noEmit` exit 0.

## Consequences

- The deck's claim becomes true **for the two covered routes**, with the boundary in §2 stated
  rather than glossed. The replacement sentence is in §2 and should be used verbatim.
- **An owner decision, not a fact**: a real vendor/customer export signing key does not exist and
  is not created here — nothing in `infra/release-keys/` is touched, and every keypair in the
  tests is generated inside the test process into a temp directory that is removed. Until an
  operator generates a key and publishes its fingerprint, `?signed=1` **refuses on every
  deployment**, which is the correct default but means the feature ships dark.
- **Three download routes remain unsigned** (§6). That is the gap most likely to turn the claim
  back into an overstatement, and nothing tests for a seventh export route being added
  uncovered.
- **The bundled CSV path buffers.** `collectCsv` holds the whole file in memory. The ceiling
  bounds it and the truncation is signed, but a 50 000-row audit bundle is a ~20 MB string on the
  gateway heap; the streaming route is unaffected.
- **`audit_export` is a new `object_type` value** with no DDL. Any consumer enumerating
  `audit_log.object_type` sees a value it has not seen before.
- **The chain segment is a window, not the whole chain.** Unless the segment reaches seq 1, the
  bundle proves the chain is intact *from the segment's start*, and says so. Proving it back to
  genesis requires either a bundle whose segment reaches genesis or a retained anchor.
- **The host clock is still not defended.** `exportedAt` is the database's clock, which is better
  than the process's, but both are the customer's own machines. Disclosed, not mitigated —
  exactly as ADR-0052 disclosed the same limit for licence validity.
- **The verifier's field extraction is regex over JSON.** It is correct for the canonical,
  sorted-key, fixed-shape manifest this code produces, and the authority is the signature over
  the exact bytes rather than the parse — but a future manifest shape change must be made with
  that parser in mind, which is why `schema` is checked first and refuses anything but
  `regulait.export-bundle/1`.

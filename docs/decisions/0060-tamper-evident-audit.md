# ADR-0060: Tamper-evident audit_log — hash-chain plus a WORM/external anchor

- **Status**: Accepted
- **Date**: 2026-08-01
- **Accepted**: 2026-08-02 (implemented — see the amendment at the end)

## Context

`audit_log` is the product's single source of truth for "who did what, what was decided, when"
(`GOVERNANCE_LAYER_SPEC.md` §6/§7). It is **append-only and FK-free by design** — the schema
comment is explicit: "No FKs on purpose: audit records must survive user/server deletion." Rows
outlive their subjects; deleting a user or a server leaves the audit trail intact. Every other
governance claim in the product ultimately points back at this one ledger.

But *append-only in application code* is not the same as *tamper-evident*. The gateway only ever
inserts, but anyone with direct database write — a DBA, a compromised app credential, or a
restore-and-edit against the backup — can `UPDATE`, `DELETE`, or reorder rows, and **nothing in
the system would notice.** For a product whose value proposition is a trustworthy audit trail,
"trust us, the application only inserts" is not a control.

ADR-0035's nightly `pg_dump` to a write-only S3 bucket protects against *loss*, not against
undetected in-place *tampering*: the dump faithfully captures whatever the database currently
says, tampered or not.

**The threat model must be stated precisely, because hash-chaining is easy to over-sell.** A
hash-chain — each row carrying the hash of the previous row plus its own content hash — detects
any alteration, removal, or reordering **by anyone who cannot recompute the whole chain AND
replace the trusted anchor.** It does *not*, on its own, stop the strongest adversary: a DB admin
who can rewrite every row can *also* recompute every hash, producing an internally consistent
forged chain. Hash-chaining alone would bless that. What closes the gap is anchoring the chain
head to storage the admin cannot rewrite — WORM S3 (Object Lock) and/or an external transparency
log — so a full recompute diverges from the last anchored head and is detectable.

This is distinct from SIEM export (deferred): SIEM forwarding gets events into a customer's
analytics pipeline; it does nothing to prove the *local* ledger was not edited. Different control,
different ADR.

## Decision

Make `audit_log` tamper-evident by hash-chaining every row and periodically anchoring the chain
head to immutable storage. This builds on — and preserves — the existing append-only, FK-free
design.

### 1. Per-row hashing (migration)

Add a monotonic `seq` (bigint sequence) for a strict total chain order — **not** `at`, because
timestamps collide and are not guaranteed monotonic. Add `content_hash` = `SHA-256` of a
**canonical, deterministic serialization** of the row's immutable fields (`id`, `at`, `userId`,
`objectType`, `objectId`, `detail`, `serverId`, `toolName`, `effect`, `ruleId`, `ruleChain`,
`reason`, `deployMode`), and `prev_hash` = the `content_hash` of the immediately preceding row in
`seq` order. The linked value is `row_hash = SHA-256(prev_hash || content_hash)`.

### 2. Genesis row — migration-friendly, and honest about the boundary

The chain begins at a **genesis row** whose `prev_hash` is a fixed constant (zero). Existing
pre-migration rows cannot be retroactively chained without rewriting them — which would itself
look exactly like tampering and defeat the purpose. So the migration writes **one genesis row**
that seals the boundary: it records the starting `seq` and explicitly declares that rows before
it are **un-chained legacy, protected only by ADR-0035 backups, not tamper-evident.** The
integrity guarantee starts at genesis and is stated as such — no pretense that the pre-existing
history is covered.

### 3. Chaining at write

The single audit-insert path computes `prev_hash` from the current chain head and writes
`content_hash`/`row_hash` in the same transaction as the row. Appends serialize at the chain tip
(a per-append advisory lock or a serialized sequence), because two concurrent appends cannot both
claim the same predecessor. FK-freeness is preserved: the hashes are self-contained and reference
nothing.

### 4. Anchoring

Periodically (e.g. hourly or daily) write the current chain head — `seq` + `row_hash` +
timestamp — to WORM storage: an S3 bucket with **Object Lock (compliance mode)**, reusing the
ADR-0035 write-only / delete-denied bucket pattern as a sibling, and/or POST it to an **external
transparency/notarization log**. The anchor is tiny and immutable once written.

### 5. Verification endpoint

Admin-only `GET /v1/audit/verify`: recompute `content_hash` and `row_hash` for every row from
genesis (or a bounded range), confirm the `prev_hash` linkage is unbroken and consistent with
`seq` order, and compare the recomputed head against the latest WORM/external anchor. It reports
`OK`, or the **first `seq` at which the chain breaks** — altered content, a deletion (a sequence
gap with broken linkage), or reordering (linkage mismatch) all localize to a first offending row.
Verification streams over the log using ADR-0031's keyset pattern rather than loading it whole.

### Threat model — stated precisely

- **Detected:** any single-row edit, deletion, or reordering by anyone who edits the DB but
  cannot also replace the anchor — the recomputed head will not match the anchored head, and the
  first break localizes the tamper.
- **The "DB admin rewrites everything" gap — and how the anchor closes it:** a full recompute by
  someone with total DB write is internally consistent, so hash-chaining *alone* would pass it.
  The immutable anchor is exactly what catches it: they cannot rewrite the anchored head, so their
  recomputed head diverges from it. **Residual window:** tampering to rows written *after* the
  last anchor but *before* the next can be made internally consistent and is not caught until
  those rows are themselves anchored — so **anchor frequency bounds the undetectable window**, and
  that is a tuning knob, not a fixed guarantee. An adversary who can also destroy every WORM copy
  *and* control the external log is outside this control's reach — which is precisely why Object
  Lock compliance mode and an *independent* external log matter: no single party should hold both.
- **Not provided:** confidentiality (hashes are not encryption), stronger actor non-repudiation
  than auth already establishes, or *prevention* — this is detection and evidence, not a write
  block. DB-level least-privilege / RLS is the complementary preventive control and is out of
  scope here. SIEM export remains separate and deferred.

## Consequences

- **Easier.** The audit trail becomes *evidence*, not merely a log — provable integrity for the
  regulated buyers the compliance cascade (§8.3) targets. The existing append-only, FK-free design
  is exactly the right substrate, and verification is self-serve.
- **Harder / trade-offs.** Audit inserts now serialize at the chain tip — a throughput ceiling on
  a global lock point (audit is rarely write-bound, but this must be measured, not assumed). A
  schema migration adds a monotonic sequence and two hash columns. Pre-genesis history is honestly
  out of scope. Anchor cadence trades cost against the undetectable-recent-window. WORM Object
  Lock retention and an external log are new infrastructure and a new trust dependency. The subtle
  correctness risk: `detail` and `ruleChain` are `jsonb`, so the canonical serialization **must**
  be deterministic (sorted keys, stable encoding) or verification throws false tamper-positives —
  called out here as the thing most likely to bite the implementation.

### Worked example — what verification actually catches

Suppose an insider deletes the single `audit_log` row recording a denied production deploy they
overrode. Without the chain, that row is simply gone and nothing points at the hole. With the
chain: the next row's `prev_hash` still references the deleted row's `content_hash`, so
`GET /v1/audit/verify` recomputes the chain, finds the `seq` gap and the broken linkage, and
reports the exact `seq` where the break begins. If the insider instead *rewrites* the row's
`reason` from "denied" to "approved" and recomputes every downstream hash to stay internally
consistent, the local chain verifies clean — but the recomputed head no longer matches the head
that was **anchored to Object-Lock S3 before the edit**, so verification flags the divergence.
The only way to defeat both is to also rewrite the immutable anchor, which Object Lock compliance
mode and an independent external log are specifically there to prevent.

### Deployment-mode behavior (§8.5)

- **Air-gapped / offline.** The chain is computed locally and needs no network, so integrity
  holds with no outbound connection. Anchoring degrades gracefully: buffer chain-head anchors to
  a local WORM medium and flush them to S3 / the external log when connectivity resumes — the
  same buffer-and-sync posture §8.5 already defines for audit events. Until an anchor is
  externalized, the "recent window" is larger; that is disclosed, not hidden.
- **BYOC.** The Object-Lock bucket lives in the customer's own account under their IAM, matching
  the ADR-0035 backup-target pattern; the customer, not us, holds the immutable anchor — which is
  the stronger trust story for a sovereignty buyer, since even RegulAIt cannot rewrite it.

### Compliance-cascade interaction (§8.3)

Audit-log retention is one of the controls the compliance cascade sets per classification. Hash-
chaining does not change retention, but it does raise a real question the cascade should own:
**anchor cadence** and **WORM retention** are now compliance-relevant parameters (a HIPAA/DORA
workload may demand an anchor at least daily and Object-Lock retention matching the audit-
retention window). The clean home for those knobs is the same single-tag cascade, so a
classification implies its anchoring stringency rather than an admin wiring it per install.

### Hash-agility note

`SHA-256` is the choice for v1. Because the algorithm identifier is not stored per row today, a
future migration to a stronger function would either re-hash forward from a new genesis (leaving
the old segment verifiable under the old function) or add a self-describing algorithm tag. This
is a foreseeable follow-up, not a v1 requirement, and is noted so the genesis-boundary pattern
above is understood to be reusable for an algorithm rollover as well.

- **Follow-up.** Pin the canonicalization precisely; choose anchor cadence and WORM retention
  against the compliance cascade; decide whether the external transparency log is v1 or
  fast-follow; add DB least-privilege/RLS as the preventive complement; converge with a future
  SIEM export so the chain head can also be attested off-box.

---

## Amendment — 2026-08-02: accepted as implemented

Migration **0067** (`0067_tamper_evident_audit.sql`). Everything below is what
was actually built, including where it departs from the text above and why.

### What shipped

| Piece | Where |
| --- | --- |
| Canonical serialization, `content_hash`, `row_hash`, genesis constants, resumable batch verifier | `packages/shared/src/audit-chain.ts` (+ 41 pure unit tests) |
| Chaining at write, advisory lock, `createDb` interception | `packages/db/src/audit-chain.ts`, `packages/db/src/index.ts` |
| `seq` / `content_hash` / `prev_hash` / `row_hash`, the all-or-none CHECK, the genesis row, `audit_anchors` | `packages/db/migrations/0067_tamper_evident_audit.sql`, `packages/db/src/schema.ts` |
| Anchor sink, capture, buffer-and-flush, `GET /v1/audit/verify` | `apps/gateway/src/audit-chain.ts` (+ 32 e2e tests) |
| WORM bucket (Object Lock) — **written, never applied** | `infra/modules/audit-anchor-worm-s3/` |
| Throughput harness | `packages/db/bench/audit-chain-throughput.mjs` |

### Deviation 1 — `prev_hash` is the predecessor's `row_hash`, not its `content_hash`

§1 says in passing that `prev_hash` is "the `content_hash` of the immediately
preceding row". Implemented literally, that produces a chain of **adjacent
pairs**, not an accumulator: `row_hash[n]` would depend only on rows n−1 and n,
so the chain head would commit to the last two rows and nothing else. An
adversary who edited row 5 and recomputed everything downstream would land on a
head **identical** to the anchored one, and the anchor — which this ADR's own
threat model and worked example make the load-bearing control against exactly
that adversary — would catch nothing.

The worked example requires the opposite ("the recomputed head no longer matches
the head that was anchored … before the edit"), which is only true if `row_hash`
accumulates the whole history. So `prev_hash` names the preceding row's
`row_hash`. The formula the ADR writes down, `row_hash = SHA-256(prev_hash ||
content_hash)`, is unchanged. There is a unit test asserting that an edit early
in a chain changes the head, because that property is the anchor's entire
justification.

### Deviation 2 — the "single audit-insert path" did not exist; it was created at `createDb`

§3 assumes one insert path. There were **158 `insert(auditLog)` call sites across
31 gateway modules**. Three options were considered:

1. **Rewrite 158 call sites** to go through a helper — large, merge-hostile, and
   fatally it makes chaining a *convention*: the 159th call site, written by
   someone who has not read this ADR, silently writes an un-chained row that
   verification then reports as tampering.
2. **A PL/pgSQL `BEFORE INSERT` trigger** — genuinely unbypassable, but it would
   reimplement the canonical jsonb serialization in SQL, and the SQL and TS
   implementations would have to agree byte-for-byte forever. That is precisely
   the divergence this ADR names as most likely to bite, deliberately doubled.
3. **Intercept at `createDb`** — the one place a database handle is constructed
   in this repo (server, seeder, every test).

(3) was chosen. `insert(auditLog)` and `transaction()` are wrapped so a row
inserted inside a caller's transaction chains inside that same transaction, one
canonicalizer serves both writer and verifier, and no call site knows it exists.
The wrapper is runtime-only and type-transparent, so `Db` is unchanged.

**Honest limit:** this binds code that goes through `createDb` and nothing else.
A `psql` session or a future module that builds its own pool writes un-chained
rows. Verification reports those as `missing_hash`/`linkage_mismatch` at the
exact `seq` rather than ignoring them, so the failure is loud — but it is
detection, not prevention. A trigger remains strictly stronger; see follow-ups.

Two compatibility details fell out of the interception and are covered by tests:
the replacement builder is **lazy** (a builder that is never awaited still writes
nothing) and **memoised** (awaiting one twice appends once), and it supports
`.returning()`. `onConflictDo*` is deliberately *not* modelled — an audit row
that silently does not get written is not a behaviour this table should acquire
by accident.

### Deviation 3 — `max(seq)+1` under the lock, not a sequence

`nextval` is not transactional: a rolled-back transaction burns its number and
leaves a hole. Verification cannot distinguish that hole from a deleted row, so
every rollback would raise a false "someone deleted an audit record" alarm — the
fastest way to make an integrity control ignored. Under the advisory lock
`max(seq)+1` is exactly as safe and genuinely gapless, so a gap now *means*
something. There is a test that rolls a transaction back and asserts no `seq` was
consumed.

### The canonicalization rules, pinned

`packages/shared/src/audit-chain.ts` is the single definition; the writer and the
verifier both call it. Payload = `"regulait.audit.v1\n"` + canonical JSON of the
thirteen immutable fields (`id`, `at`, `userId`, `objectType`, `objectId`,
`detail`, `serverId`, `toolName`, `effect`, `ruleId`, `ruleChain`, `reason`,
`deployMode`). The version prefix is inside the hash, so a future rule change
cannot collide with v1.

1. **Object keys sorted** ascending by UTF-16 code unit, recursively, at every
   depth. This is what defuses the jsonb trap: Postgres re-emits objects in its
   own order (key length, then bytewise), and re-sorting on read makes storage
   order irrelevant rather than something we have to predict.
2. **Array order is data** and is never sorted. Reordering an array is a change.
3. **Compact** — no insignificant whitespace.
4. **`undefined` as an object value = absent**: the key is dropped. `{a:undefined}`
   and `{}` hash identically because Postgres cannot tell them apart either.
5. **`undefined`/hole as an array element → `null`** (matching `JSON.stringify`,
   and matching what is stored).
6. **`null` ≠ absent.** `{"a":null}` and `{}` hash differently; that distinction
   survives jsonb, so the hash respects it.
7. **Numbers** use `JSON.stringify`'s rule (shortest round-trippable decimal).
   `numeric` is exact decimal, so the shortest repr of a double stores exactly
   and parses back to the same double whatever text Postgres echoes. Therefore:
   `-0` → `0`; `NaN`/`±Infinity` → `null` (that is what actually reaches the
   column); `1` and `1.0` are the same double and hash the same.
8. **Strings** use `JSON.stringify`'s rule: quotes/backslashes/control chars
   escaped, all non-ASCII left **literal** and hashed as UTF-8. NFC and NFD are
   different data and hash differently — canonicalization is byte-level, not
   linguistic.
9. **`toJSON` first** (so a `Date` in `detail` hashes as the ISO string jsonb
   will hold).
10. **`bigint`, functions, symbols throw** rather than being silently coerced.
11. **`at` is always set by the writer**, never left to `now()`: `now()` has
    microsecond resolution and JS `Date` has milliseconds, so letting the column
    default would store a timestamp the hash could never reproduce. Same for
    `id` (`gen_random_uuid()`) and `object_type` (`'mcp_tool'`).

Tested against key-order permutations, nested objects/arrays, unicode (emoji,
CJK, RTL, combining marks), numeric edge cases (`-0`, `NaN`, `±Infinity`,
`MAX_SAFE_INTEGER`, `1e21`, `1e-7`, `Number.MIN_VALUE`, `0.1+0.2`), null vs
absent, sparse arrays — and, the one that matters, **a real round trip through
Postgres jsonb**: insert a row whose keys Postgres provably reorders, read it
back, assert the hash still matches and the chain still verifies.

### The genesis row

One row, `seq = 1`, `prev_hash` = 64 zeros, byte-identical on **every install**:
fixed id, fixed timestamp, fixed `detail`, and deliberately **no** install-
specific value such as a legacy row count. That makes its hashes constants of the
product rather than of a deployment —

- `content_hash = 45ff972f867376ea830bddd89ecd99a3aba4b9f919c53781fef29cef7034e785`
- `row_hash     = 08a2dbc4c9b3714264a558ea5523bff203ed272838abe00178a34fabfb7556fe`

— computed in `@regulait/shared`, asserted by its tests, hardcoded in migration
0067, and recomputable by an auditor from source alone with no access to any
deployment. The un-chained legacy population is counted **live** by
`GET /v1/audit/verify` instead (`legacy.unchainedRowsBeforeGenesis`), and the
row's own `reason` states in words that everything before it is un-chained legacy
protected only by ADR-0035 backups.

### Measured throughput cost — the ceiling is real

The ADR asked for this to be measured, not assumed.
`packages/db/bench/audit-chain-throughput.mjs`, local Postgres 16, 500 sequential
inserts after warm-up:

| | rows/s | ms/row |
| --- | --- | --- |
| unchained (pre-0060) | **602** | 1.66 |
| chained (0060) | **289** | 3.45 |

**Roughly 2× per-row cost, +1.8 ms/row.** Two round trips are added inside a
transaction that did not exist before (advisory lock, tip read).

The concurrency sweep is the more important number, and it is the ceiling the
ADR predicted:

| parallel writers | 1 | 4 | 8 | 16 | 32 | 64 |
| --- | --- | --- | --- | --- | --- | --- |
| rows/s aggregate | 317 | 309 | 357 | 314 | 342 | 263 |

**Concurrency buys nothing** — aggregate audit-append throughput is pinned at
~300–350 rows/s on this box no matter how many writers there are, and degrades
past 32. That is the global lock, exactly as predicted.

Batching escapes it: one lock and one tip read serve a whole `.values([...])`
array, so 100-row batches run at **0.23 ms/row (~4,400 rows/s)**.

**Is it bad?** For today, no: ~300 governed calls/second sustained is far above
anything this product is near, and the full 1,505-test gateway suite — which
writes audit rows constantly — got *faster*, not slower, between runs. For a
high-volume install it is a real ceiling and the honest answer is that it must be
addressed before it is hit, not after. The escape hatches, in order of
preference, are recorded as follow-ups below.

### What the anchor does and does not cover

- **Implemented:** the anchor *record* (`audit_anchors`), the emit path
  (`POST /v1/audit/anchor`), buffer-and-flush for air-gapped
  (`POST /v1/audit/anchors/flush`), the `AnchorSink` interface, and a
  `LocalWormSink`. Anchors are captured **after** their own audit row, so an
  anchor covers itself and `unanchoredRows` is 0 immediately after one is taken
  rather than permanently 1.
- **Deliberately not wired:** the S3 sink. The Object-Lock bucket is terraform
  (`infra/modules/audit-anchor-worm-s3/`, `terraform validate` clean) and
  **nothing was applied to any AWS account**. Shipping a half-configured S3
  writer that silently no-ops would be exactly the false assurance this ADR
  exists to prevent. `object_lock_mode` defaults to `GOVERNANCE` and
  `COMPLIANCE` — which is what actually delivers the guarantee against a hostile
  administrator — must be chosen explicitly by a human, because it is
  irreversible.
- **`LocalWormSink` reports `tamperResistant: false`**, and so does every verify
  response that used it. A directory on the same host is a *buffer*, not WORM;
  `chmod 0444` stops a fat finger and stops root from nothing.
- **The database anchor row is not evidence.** When no sink is configured,
  verification falls back to `audit_anchors` and reports
  `source: "database", tamperResistant: false` with a disclosure saying an
  adversary who can rewrite `audit_log` can rewrite that row too. An auditor's
  own retained anchor can be supplied as `?anchorSeq=&anchorRowHash=` and is
  reported as `caller_supplied`.
- **Residual window, in every response:** `unanchoredRows`. Tampering confined to
  rows after the last anchor can be made internally consistent and is not caught
  until they are anchored.

### What the tests prove — and the one thing they prove is *not* covered

Proof by attack: every detection test tampers for real, with raw SQL, bypassing
the application, because that is the threat model.

- **Detected:** in-place `UPDATE` of `reason` → `content_mismatch` at that exact
  `seq`; `UPDATE` of `detail` → likewise; `DELETE` → `sequence_gap` at the
  surviving successor; two rows swapped → `linkage_mismatch` at the first;
  a row inserted straight into the table with fabricated hashes →
  `linkage_mismatch`; a directly edited `row_hash` → `row_hash_mismatch`; a
  half-chained row → refused by the DB CHECK.
- **Not detected locally, asserted as such:** a **full recompute** by an
  adversary with total database write. The test rewrites a row's `reason`,
  re-derives every hash from there to the head, and asserts that local
  verification returns **no break** — and that comparison against the anchor
  taken *before* the edit is what flags it (`anchor.matches: false`). That test
  is what makes the anchor load-bearing rather than decorative, and it is the
  reason the anchor's provenance is reported on every response.
- **Concurrency:** 24 parallel appends produce a gapless, strictly ordered chain
  with no two rows claiming the same `prev_hash` — a fork would be
  indistinguishable from tampering, which is why the tip lock exists.
- **Genesis:** the verify output reports `legacy.covered: false`, the live count
  of pre-genesis rows, and the disclosure text.
- **Streaming:** with `batchSize=5`, `scanned.batches` exceeds `rows/5` and the
  whole table is never materialised. A bounded `fromSeq` scan reports
  `bounded: true` and states in `limits` that it trusted its starting
  `prev_hash` and therefore proves nothing about rows before it.
- **FK-freeness preserved:** asserted by querying `information_schema` for
  foreign keys on `audit_log` and `audit_anchors` (zero), plus a test that
  hard-deletes a user and re-verifies clean.

### Verification of this change

`pnpm -r build` clean (web build included). policy-kernel 129, workflow-kernel
39, `@regulait/shared` 287 (41 new). Full gateway suite green on two consecutive
fresh databases: **1,505 tests, 94 files** (32 new). Migrations apply clean to a
fresh database.

### Follow-ups this leaves open

1. **The S3 Object-Lock sink.** The interface and record exist; the writer does
   not. Until it lands, no install has a tamper-resistant anchor.
2. **An independent external transparency log.** The ADR is explicit that no
   single party should hold both the WORM copy and the log; today nobody holds
   either.
3. **A `BEFORE INSERT` trigger** as a second line under the `createDb`
   interception — it would close the "someone opened their own pool" hole. The
   canonicalization-divergence objection stands and would need solving first
   (most plausibly: the trigger enforces only *presence*, not the hash value).
4. **The throughput ceiling.** In preference order: batch appends at the caller
   (already ~15× cheaper per row); then a single-writer append queue in front of
   the lock; then partitioning the chain per tenant with per-partition genesis
   rows (which changes what "the head" means and needs its own ADR).
5. **Anchor cadence and WORM retention into the compliance cascade** — the ADR
   names these as classification-derived; they are configuration today.
6. **DB least-privilege / RLS** as the preventive complement. This is detection.
7. **Hash agility.** The algorithm is not stored per row; a rollover re-chains
   from a new genesis, and `AUDIT_PAYLOAD_VERSION` is already inside the hash so
   the two segments cannot be confused.

---

## Amendment — 2026-08-13: anchoring is default-ON, and that does not change the claim

Found while driving audit + approvals end-to-end. A default install answered
`/v1/audit/verify` with `anchor.checked: false`, `source: "none"` — the chain was
running, but nothing captured its head, so the only integrity evidence lived
inside the very table an attacker edits. Nothing scheduled anchoring either: the
six ADR-0064 sweeps do not include it, so `POST /v1/audit/anchor` was reachable
only by hand.

**Changed.** `resolveAnchorSink` now returns the `LocalWormSink` when nothing
overrides it (default buffer `./audit-anchors`), and `boot.ts` captures the head
on its own interval — deliberately NOT on the ADR-0064 scheduler, because those
sweeps mutate governed state and one of them (ADR-0057 red-team) costs money per
run, so "turn on anchoring" must not silently mean "start running red-team
sweeps". `REGULAIT_AUDIT_ANCHOR=off` restores the previous posture, which remains
legitimate and disclosed.

**What this does NOT do, stated plainly because the temptation is the opposite.**
It does not make the trail tamper-RESISTANT. `LocalWormSink.tamperResistant` is
still `false`, `/v1/audit/verify` still reports `tamperResistant: false`, and the
disclosure now reads *"An adversary who can rewrite audit_log can rewrite it
too."* A directory on the same host stops a fat-fingered overwrite and stops root
from nothing. What it buys is narrower and real: the head is written to a second
artifact, so the bar moves from "recompute one table" to "recompute one table AND
the anchor rows AND the anchor files", and the buffer exists from first boot so
pointing an install at genuinely immutable storage becomes configuration rather
than code plus a backfill.

**The S3 Object-Lock sink is still not wired**, and that is what would make
`tamperResistant` true. The bucket is terraform in
`infra/modules/audit-anchor-worm-s3/`, nothing has been applied to any cloud
account, and this amendment does not change that. A test pins
`tamperResistant === false` for the default sink so the claim cannot drift
upward without the sink that earns it.

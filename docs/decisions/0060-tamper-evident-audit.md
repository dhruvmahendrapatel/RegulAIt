# ADR-0060: Tamper-evident audit_log — hash-chain plus a WORM/external anchor

- **Status**: Proposed
- **Date**: 2026-08-01

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
- **Follow-up.** Pin the canonicalization precisely; choose anchor cadence and WORM retention
  against the compliance cascade; decide whether the external transparency log is v1 or
  fast-follow; add DB least-privilege/RLS as the preventive complement; converge with a future
  SIEM export so the chain head can also be attested off-box.

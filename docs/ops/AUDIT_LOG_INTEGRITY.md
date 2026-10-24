# audit_log integrity: tamper-evident, not database-immutable

Written 2026-10-24 for finding FS-34. It corrects a comment that cannot be edited in place, and gives the one wording to
use when someone asks whether the audit trail is immutable.

## What the database enforces on `audit_log`

Read from the migrations on main (`packages/db/migrations/`):

| Trigger | Migration | Kind | What it refuses |
|---|---|---|---|
| `audit_log_v2_floor` | 0184 | `BEFORE INSERT`, row | an insert at or past the v2 chain boundary that is not written as `chain_version = 2` |
| `audit_log_decision_capture_required` | 0189 | `AFTER INSERT`, constraint | a decision row committed without its capture-status marker |
| `audit_log_no_truncate` | 0185 | `BEFORE TRUNCATE`, statement | `TRUNCATE` |

There is **no row trigger on `UPDATE` or `DELETE`**. Migration 0185 says so itself: the append-only rule for
`audit_log` "is enforced by the hash chain and its anchors rather than a row trigger". The retention prune
(`runAuditPruneOnce` in `apps/gateway/src/org-settings.ts`) deletes rows past the retention floor on purpose, in one
transaction with an `audit-log-pruned` meta row; the scheduled auto-prune is off by default (`autoPruneEnabled=false`,
ADR-0021).

## The correction

The header of `0192_ai_bom_signoff_audit_indexes.sql` says: "The append-only guards on `audit_log` are row triggers on
INSERT, UPDATE, DELETE and TRUNCATE". That is wrong: the guards are the three triggers above, and TRUNCATE is refused by
a statement trigger. The comment's conclusion still holds (building an index fires none of these triggers). The
migration file is not edited, because an applied migration is left byte-for-byte as it ran
([CONTRIBUTING_PARALLEL_SESSIONS.md](../../internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md) §4.1); this note is the correction.

## What makes the trail trustworthy

Integrity comes from the hash chain and its external anchors (ADR-0060): every row is chained, the chain head is
anchored to write-once storage whose Object Lock mode is read from the bucket itself, and verification reports any
unanchored rows. An edited or deleted row breaks the chain and is detected on verify; the database does not prevent it.

**Say:** "a tamper-evident hash chain with external anchors". **Do not say:** "immutable".

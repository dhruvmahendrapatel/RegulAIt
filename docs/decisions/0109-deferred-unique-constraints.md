# ADR-0109 — The eleven deferred sites get a CONSTRAINT, not an order; and the migration refuses rather than repairs

- **Status**: Accepted
- **Date**: 2026-09-09
- **Relates to**: [ADR-0107](0107-unordered-single-row-reads.md) (this is the follow-up it
  explicitly owed — its production sweep fixed 19 unordered single-row reads and **deferred 11**
  on the grounds that a unique constraint, not an `ORDER BY`, is their right fix),
  [ADR-0108](0108-test-side-unordered-reads.md) (the other half of that sweep — test-side),
  [ADR-0104](0104-approval-payload-binding.md) and
  [ADR-0105](0105-consent-context-binding-and-expiry.md) (whose refusal to backfill an invented
  value is the same argument this ADR makes about repairing duplicates, and whose approvals
  machinery four of these constraints protect), [ADR-0045](0045-model-risk-management.md) §3
  (the ONE approvals queue that makes `approval_id` a 1:1 key at all)
- **Migration**: **0108 — `0108_deferred_unique_constraints.sql`.** Nine `CREATE UNIQUE INDEX`
  statements. No column added, no data written, nothing dropped. Journal entry hand-authored;
  `drizzle-kit generate` was **not** run.

## Context

ADR-0107 hunted one defect — *a query that does not ask for an order, whose caller then depends on
one* — across 142 production sites. It fixed 19 with a deterministic total order and **deliberately
left 11 alone**, with the reasoning that is the whole point of this batch:

> Ordering them would encode the wrong claim: it would say "several of these are expected and here
> is the tiebreak", when the truth is "a second one is a bug the database should have refused".

That is the distinction. **An `ORDER BY` ACCOMMODATES a duplicate. A constraint STATES AND ENFORCES
that there should not be one.** The eleven are reverse lookups by the id of a structurally 1:1
partner record (`WHERE approval_id = <the row being decided>`, `WHERE workflow_instance_id = <the
instance being synced>`) and insert-if-absent idempotency guards that already self-enforce except
under a race. Giving them a tiebreak would have written a lie into the code: it would tell the next
reader that two `sod_override_requests` on one approval are an expected condition with a
house-preferred winner, when in fact the second one means a single human consent is about to mint a
grant against a payload its approver never saw.

ADR-0107 also disclosed why it stopped: each of the eleven

> is a schema change that can **fail on existing data** — if a deployment already holds two rows
> the constraint forbids, the migration does not apply and the question of what to do with the
> duplicates is a product question, not a mechanical one.

This ADR answers that question.

## Decision

### 1. The migration ADDS constraints and REFUSES. It never repairs, merges or deletes.

A unique constraint is a **claim about data that already exists**. On a deployment already holding a
forbidden pair, `CREATE UNIQUE INDEX` fails with SQLSTATE 23505 and the upgrade stops.

**That is the correct behaviour for this product, and 0108 does not soften it.** The rows in
question are governance records:

- two `grant_certification_items` against one approval are two recorded human access-review
  decisions;
- two `sod_override_requests` are two answers to *may this person hold both of these*;
- two `model_card_approvals` are two humans accepting two different risk positions on one model.

Silently collapsing, merging or deleting one of those so that an upgrade script could report success
would destroy evidence in order to make an exit code nicer. It is the same argument ADR-0104 made
when it refused to backfill a consent digest, and ADR-0105 when it refused to invent a
`requested_at`-relative expiry for a legacy approval: **an invented value is a manufactured record.**
Deciding which of two conflicting governance rows is the real one is a product question with a human
in it, and a migration may not answer it on their behalf.

So the migration contains no `DELETE`, no `ON CONFLICT` and no `DISTINCT ON` rewrite. The
`IF NOT EXISTS` on each statement guards the index **name**, never the **claim** — it makes re-running
an applied migration a no-op and does nothing whatsoever to a duplicate.

### 2. The cost of that posture is paid by a pre-flight, not by softening it

The honest cost of "refuse" is that an operator learns about the problem *from a failed migration,
mid-upgrade, with no idea how big it is*. So the batch ships a pre-flight duplicate report:

- `runDeferredUniquePreflight(db)` in **`packages/db/src/deferred-unique-preflight.ts`** — a plain
  exported function over plain SQL, deliberately following the shape `proseScrubInventory()` uses to
  make ADR-0102's coverage claim checkable, rather than inventing a subsystem. Read-only: no writes,
  no locks, no transaction, safe against a live deployment. One round trip per check.
- `scripts/preflight-unique-constraints.mjs` — a thin wrapper an operator runs as
  `node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"`. Exit **0** clean, **1** blocked,
  **2** could not run.

It reports, per constraint, how many duplicate groups exist, how many rows they cover, and up to five
example keys.

**What an operator holding duplicates must do**: run the pre-flight before upgrading; for each pair
it names, decide which row is the real one and remove or re-key the other — through the product's own
surfaces where one exists, and by hand where it does not — then upgrade. There is no supported path
that upgrades with the duplicates in place, and that is the decision, not an omission.

### 3. Nine constraints, and their exact shape

| # | index | table | key | shape |
| --- | --- | --- | --- | --- |
| 1 | `grant_cert_items_approval_uq` | `grant_certification_items` | `(approval_id)` | **partial** `WHERE approval_id IS NOT NULL` |
| 2 | `model_card_approvals_approval_uq` | `model_card_approvals` | `(approval_id)` | **partial** `WHERE approval_id IS NOT NULL` |
| 3 | `training_jobs_approval_uq` | `training_jobs` | `(approval_id)` | **partial** `WHERE approval_id IS NOT NULL` |
| 4 | `sod_override_approval_uq` | `sod_override_requests` | `(approval_id)` | **partial** `WHERE approval_id IS NOT NULL` |
| 5 | `ai_use_cases_instance_uq` | `ai_use_cases` | `(workflow_instance_id)` | **partial** `WHERE workflow_instance_id IS NOT NULL` |
| 6 | `ai_vendors_instance_uq` | `ai_vendors` | `(workflow_instance_id)` | **partial** `WHERE workflow_instance_id IS NOT NULL` |
| 7 | `cert_inventory_resource_cn_uq` | `cert_inventory` | `(resource_id, common_name)` | **total** (both columns `NOT NULL`) |
| 8 | `trace_spans_run_uq` | `trace_spans` | `(trace_id, run_id)` | **partial** `WHERE kind = 'run' AND run_id IS NOT NULL` |
| 9 | `users_email_lower_uq` | `users` | `lower(email)` | **total, FUNCTIONAL** |

**Partial where partial is true.** ADR-0107 recorded that misreading a partial index caused a real
bug (`guardrail_configs_org_uq ON (scope) WHERE scope_id IS NULL` does not cover a bare
`eq(scope,'org')`), so each index above covers exactly the predicate its read site uses and no more.
`approval_id` and `workflow_instance_id` are nullable and NULL is the *normal* case — a training job
under the cost threshold never had an approval; a use case may be registered before any workflow
governs it. Postgres already treats NULLs as distinct in a unique index, so `WHERE … IS NOT NULL`
does not change *which* rows conflict; it is written anyway because it states the claim instead of
leaving the reader to recall a NULL-handling rule, and it keeps the index off the majority of rows
that can never participate in it.

### 4. `users (lower(email))` — the one that changes behaviour, stated rather than discovered

`users_email_unique` is UNIQUE on `email` **exactly**. Every identity path in this codebase looks the
address up case-folded, so `Ada@x` and `ada@x` are two legal rows that both match one login.
ADR-0107 could only make the answer stable (`asc(createdAt), asc(id)` — "first registration owns the
address") and called that **a stopgap, not the fix**. This index is the fix.

**Every path that creates a user was read, not assumed:**

| path | can it create a case-variant? |
| --- | --- |
| SCIM create (`scim.ts`) | **No** — pre-checked with the case-folding `loadUserByEmail`; answers 409 |
| SCIM replace / PATCH of `userName` | **No** — same case-folding clash check |
| OIDC JIT (`auth.ts`) | **No** — the claim is lower-cased before both the lookup and the insert |
| SAML JIT (`saml.ts`) | **No** — the asserted address is lower-cased on extraction |
| bulk user import (`onboarding.ts`) | **No** — the row schema is `.trim().toLowerCase().email()`, so a variant is planned as an UPDATE of the existing user, never a create |
| **`POST /v1/users` (`app.ts`)** | **YES** — `createUserSchema.email` is a bare `z.string().email()`, with no case-folding guard |

**So SCIM and OIDC/SAML JIT provisioning are unaffected.** That is the specific question this batch
was asked to answer before writing the index, and the answer is that the risk lives somewhere else:
the one path that could create a case-variant is the admin API.

**The consequence**: after this migration, `POST /v1/users` with a case-variant of an existing
address returns **409 conflict** instead of creating a second account. That is not new plumbing —
`app.ts`'s error handler already maps SQLSTATE 23505 to `{"error":"conflict"}`, which is exactly what
an *exact* duplicate email has always returned. The change is that the two cases now **agree**, and a
silent duplicate becomes a hard, honest failure at the one path that could produce it. Turning a
silent duplicate into a refusal is the intent, and it must be stated rather than found.

`users_email_unique` is **kept**. It is strictly implied by the new index, but it is the named
conflict target of `onConflictDoNothing({ target: users.email })` in the bulk importer; dropping an
index other code names is a separate change with nothing to gain.

### 5. `trace_spans` — the reconciliation

`trace_spans` appears in **both** of ADR-0107's tables. That looks like a contradiction and is not:
the two sites have different predicates.

| site | predicate | ADR-0107 treatment | correct? |
| --- | --- | --- | --- |
| `closeRunSpan` (fix #10 of the 19) | `(trace_id, kind='run')` — **no run id** | `asc(seq), asc(id)` | **Yes, and it stands.** A trace can legitimately carry more than one run span (a sub-run opened under the same trace), so this read is genuinely multi-row; `seq` is the trace's own monotonic column and the lowest one *is* the root |
| `ensureRunSpan` (one of the deferred 11) | `(trace_id, kind='run', run_id=r)` — **names one run** | left unchanged | **Yes** — this is 1:1, an insert-if-absent guard, and it is what `trace_spans_run_uq` constrains |

The index constrains a **strictly narrower** thing than fix #10 reads. Nothing is contradicted, fix
#10 is left exactly as it is, and the test asserts the compatibility directly: with the index in
place, a second run span for a *different* run in the *same* trace still inserts successfully.

### 6. `data_key_state` — ADR-0107's entry is factually wrong, and no constraint is added

ADR-0107 lists `data_key_state` as "a singleton **by convention only**" and says "nothing in the
database enforces one row". **Checked against `pg_constraint` on a freshly migrated database, that is
false.** Migration 0075 created the table as:

```sql
CREATE TABLE "data_key_state" (
  "id" text PRIMARY KEY DEFAULT 'singleton',
  ...
  CONSTRAINT "data_key_state_singleton" CHECK ("id" = 'singleton')
);
```

A primary key over a column a `CHECK` pins to one value admits **at most one row**. Both constraints
are present on a migrated database. That is the identical shape `org_settings` and
`interception_settings` use — i.e. the repo shape this batch was told to follow was **already being
followed**. The three read sites (`data-key.ts` `readState`, `data-key-reencrypt.ts` ×2) are
therefore already provably single-row, and 0108 adds nothing. A second one-row index would be noise
claiming a fix for a hole that does not exist. The three sites get a comment saying so.

### 7. `backup_runs` — REFUSED, because the constraint would break a governed denial

This is the batch's one negative finding, and it is a **bug in the writing code**, exactly as the
brief anticipated.

The proposed claim is one `missed` row per finding, and `infra.ts`'s own header asserts it ("backup
by (finding, missed)"). The lifecycle contradicts it:

1. a scan raises finding *F* and inserts a `(F, kind='backup', status='missed')` row — guarded by a
   read filtered to `status='missed'`;
2. an operator proposes a restore; **the same row** is UPDATEd to `status='restore_proposed'`;
3. a re-scan of *F* now finds no `status='missed'` row and inserts a **second** one — legal, because
   the first is no longer `'missed'`;
4. the operator **denies** the restore, and the deny path UPDATEs row 1 back to `status='missed'`.

With the constraint in place, **step 4 raises 23505 and the denial transaction rolls back: the
operator cannot refuse a restore.** A constraint that blocks a governance decision is worse than the
duplicate it prevents, so it is not added.

The real fix is in the writing code, not the schema: widen step 1's idempotency read to
`status IN ('missed','restore_proposed')` so step 3 never happens, then the constraint becomes
correct. That is a behaviour change — *does a re-scan re-open a miss while a restore is pending?* —
and it is its own decision. Until then the pre-flight ships the `backup_runs` check as **advisory**
so the number stays visible, and the read site carries the whole causal chain in a comment.

### 8. The reads themselves are NOT re-ordered

ADR-0107 left the eleven read sites unchanged; that stands. Adding an `ORDER BY` now would re-import
exactly the wrong claim the constraint was chosen to avoid. Each of the eleven instead gains a
comment naming the constraint that makes it single, so the next reader does not "fix" the missing
order. Two comments that had gone **stale** were corrected: `auth.ts` and `scim.ts` both said the
`lower(email)` index "is deferred to its own decision" — it is now shipped, and both say so, while
keeping their `orderBy` as the honest behaviour on a database that has not yet been migrated.

**Every read site was re-checked against the constraint that is meant to make it single:**

| site | now single-row? |
| --- | --- |
| `grant-certification.ts` ×2, `mrm.ts`, `regulait-llm.ts`, `sod.ts` ×2 | yes — `approval_id` is non-null at each call (it is the id of the row being decided) and each partial index covers it |
| `use-cases.ts`, `vendors.ts` | yes — both guard `if (!instanceId) return` before the read, so the predicate is inside the partial index |
| `infra.ts` cert-inventory | yes — total index, both columns non-null |
| `orchestration.ts` `ensureRunSpan` | yes — the read pins `kind='run'` and a non-null `run_id`, exactly the index's predicate |
| `data-key.ts`, `data-key-reencrypt.ts` ×2 | yes — but by migration 0075's PK + CHECK, not by anything 0108 does |
| **`infra.ts` backup-runs** | **NO** — reported above; the constraint is refused and the read stays not-provably-single |

## What this deliberately does NOT do

- **It does not repair, merge, deduplicate or delete a single row.** See §1. This is the load-bearing
  decision of the batch and everything else follows from it.
- **It does not add a constraint to `backup_runs` or `data_key_state`.** One is refused on evidence
  (§7), the other is unnecessary on evidence (§6). Nine of eleven, with both remainders argued rather
  than quietly dropped.
- **It does not fix the `backup_runs` writing-code bug.** That is a behaviour change about what a
  re-scan does while a restore is pending, and it is owed its own decision.
- **It does not add an `ORDER BY` to any of the eleven reads.** See §8.
- **It does not drop `users_email_unique`**, and it does not normalise `createUserSchema.email` to
  lower case. Normalising would make the admin API *silently adopt* an existing account's address
  rather than refuse — a quiet privilege-adjacent behaviour, and the opposite of what SCIM's own
  create path deliberately does. The 409 is the right answer.
- **It does not change any route, handler or policy path.** The only production-code edits in the
  batch are comments.
- **It does not re-litigate ADR-0107's 19 fixes.** Fix #10 in particular is left exactly as it is
  (§5).

## Honest limits

- **A green pre-flight is a statement about one instant, not a guarantee.** Rows written between the
  scan and the migration are not covered. On a busy deployment the honest sequence is: quiesce
  writes, scan, migrate.
- **The `backup_runs` hazard is argued from the code paths, not reproduced end-to-end through the
  HTTP surface.** All four steps were read in `infra.ts` (the `status='missed'` guarded insert, the
  propose UPDATE to `restore_proposed`, the deny UPDATE back to `missed`), and the SQL consequence of
  a unique index over that sequence is not in doubt. What is *not* claimed is a measured
  reproduction of the whole scan→propose→re-scan→deny cycle against a live gateway. The constraint
  is withheld on that reasoning, which is the conservative direction to be wrong in.
- **`users_email_lower_uq` is a claim about `lower()`, not about email equivalence.** It does not
  address plus-addressing, unicode confusables, or `@googlemail.com`/`@gmail.com`. Two accounts can
  still belong to one human. The defect being fixed is narrower and specific: two rows that every
  lookup in this codebase already treats as the same address.
- **The `POST /v1/users` 409 is a behaviour change on an existing endpoint.** No caller in this repo
  depends on the old behaviour and the endpoint already answered 409 for an exact duplicate, but an
  external integration that today creates `Ada@x` alongside `ada@x` will start failing. That is the
  point, and it is disclosed rather than discovered.
- **Nothing here proves the eleven duplicates were unreachable before.** ADR-0107 said their second
  row was "structurally possible but may be unreachable through any code path that exists today", and
  this batch does not resolve that either — it makes the question moot for nine of them. The one
  place it *was* resolved, `backup_runs`, turned out to be reachable, which is a useful calibration
  of how much that uncertainty was worth.
- **The pre-flight is not wired into any deploy path.** It is a function and a script; nothing calls
  it on boot, and no CI job runs it. A check nobody runs is worth nothing, and this one currently
  depends on an operator reading the migration header or this ADR.

## Non-vacuity (M-002 / M-033, measured)

**The trap, stated first.** S9's lesson (M-033) is that a probe answers *"is this constraint
load-bearing?"* and never *"is this assertion discriminating?"*. Every assertion here is a **negative**
— *the insert did NOT succeed* — which is exactly the shape that passes on wrong data: a NOT NULL
violation, a CHECK violation, a missing FK or a typo'd column name all throw, and every one of them
would make a broken fixture look like a working constraint.

So `expectRefusedBy` asserts **two** things, not one:

1. **SQLSTATE `23505`** specifically — a unique violation, not "something went wrong"; and
2. **`error.constraint` equal to the exact index name** — so a row refused by some *other* unique
   index over the same fixture (`users_email_unique`, `model_card_approvals_one_pending_uq`) **fails**
   the test instead of passing it.

Each duplicate row also differs from its twin in every column except the constrained key, so nothing
but the key can be doing the refusing. And each partial index has its *excluded* population
exercised in the same test — two items with a NULL `approval_id`, two jobs under the cost threshold,
two `run_node` spans, and a second run span for a different run in the same trace — so an index that
was accidentally written **total** would redden rather than pass.

**The probe, run wider than the one that ships.** All nine indexes were dropped on a freshly created,
freshly migrated database with the test file otherwise untouched:

| | result |
| --- | --- |
| all nine indexes present | **11 passed / 11**, exit 0 |
| all nine indexes DROPPED | **11 failed / 11**, exit 1 |

Every failure was on its own specific message — `the duplicate write SUCCEEDED — <index> does not
bite` — for all nine constraints, plus the non-vacuity case itself and the pre-flight case, which
failed on `grant_cert_items_approval_uq is reported by the pre-flight but does not exist`. So each of
the nine is independently load-bearing, and the pre-flight's index list is pinned to the migration
rather than to a hand-copied list.

**The committed probe** re-proves this on every run for one constraint —
**`users_email_lower_uq`**, chosen because it is the one ADR-0107 named as the real fix for its own
stopgap and the one with a security-shaped consequence. It is dropped in place, the same duplicate is
written and asserted to land (with a `count = 2` on `lower(email)`), the probe row is deleted, and
the index is restored in a `finally` — with the restoration **asserted** against `pg_indexes` and
re-proved by a further refused insert, because this database is shared with 173 other test files.

**Suite baseline** and the duplicate scan on a database populated by a full run are reported with the
batch.

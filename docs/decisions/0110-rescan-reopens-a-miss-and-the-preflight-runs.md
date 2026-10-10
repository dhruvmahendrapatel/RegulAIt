# ADR-0110 — A re-scan RE-OPENS a backup miss (the owner's answer), which makes ADR-0109's refused constraint safe; and the pre-flight becomes a CI gate

- **Status**: Accepted
- **Date**: 2026-09-12
- **Relates to**: [ADR-0109](0109-deferred-unique-constraints.md) (this is the follow-up it
  explicitly owed, on both counts — the one constraint it REFUSED, and the pre-flight it shipped
  and then recorded as wired into nothing), [ADR-0107](0107-unordered-single-row-reads.md) (which
  deferred `backup_runs` in the first place), [ADR-0017](0017-infra-ops-automation-ledgers.md) (the
  `backup_runs` ledger and the three operator verbs that ride the one approvals queue),
  [ADR-0106](0106-mock-socket-net-contract.md) (whose README "Verifying a clean checkout"
  sequence gains the pre-flight as step 5)
- **Migration**: **0109 — `0109_backup_runs_finding_uq.sql`.** One `CREATE UNIQUE INDEX`. No
  column added, no data written, nothing dropped. Journal entry hand-authored;
  `drizzle-kit generate` was **not** run.

## Context

ADR-0109 added nine unique indexes and **refused a tenth**. The refusal was correct on the code as
it then stood, and its reasoning is worth restating exactly, because this ADR does not overturn it
— it removes the thing that made it true.

`syncFindingLedger`'s backup branch wrote one ledger row per finding behind an idempotency read
**filtered to `status='missed'`**. The lifecycle then contradicted the claim:

1. a scan raises finding *F* and inserts a `(F, kind='backup', status='missed')` row;
2. an operator proposes a restore; **the same row** moves to `status='restore_proposed'`;
3. a re-scan of *F* matches nothing and inserts a **second** `missed` row — legal, because the
   first is no longer `missed`;
4. the operator **denies** the restore, and the deny path UPDATEs row 1 back to `missed`.

With a unique index in place, **step 4 raises 23505, the denial transaction rolls back, and an
operator cannot refuse a restore.** A constraint that blocks a governance decision is worse than
the duplicate it prevents. So ADR-0109 left the claim unenforced, shipped the `backup_runs`
pre-flight check as **advisory**, and named the real fix as a **behaviour change it had no mandate
to make**:

> widen step 1's idempotency read so step 3 never happens … That is a behaviour change — *does a
> re-scan re-open a miss while a restore is pending?* — and it is its own decision.

**The owner was asked that question directly and answered: "yes it should."** This ADR implements
that answer, and everything else here follows from it.

The second half of this ADR closes the other loose end ADR-0109 left, in its own words:

> **The pre-flight is not wired into any deploy path.** It is a function and a script; nothing
> calls it on boot, and no CI job runs it. **A check nobody runs is worth nothing.**

That sentence was accurate for a release. `scripts/preflight-unique-constraints.mjs` had **zero
callers** in the repo.

## Decision

### 1. The re-scan RE-OPENS the finding's existing row. It never inserts a second one.

The idempotency read now keys on the **finding alone** (`finding_id` + `kind='backup'`), whatever
state the row is in, and updates it in place. There is exactly one `backup_runs` row per finding,
for the whole life of that finding.

This is the direct implementation of the owner's answer: if a re-scan still observes the backup
missing, the system says so. It does not keep quiet because somebody once proposed a fix.

### 2. Which statuses re-open, and which do not

The status enum is `success | failed | missed | restore_proposed | restored`. The re-open is
confined to the states where the miss is **genuinely still outstanding**:

| status | re-opens? | why |
| --- | --- | --- |
| `missed` | **YES** | already open; the detection metadata is refreshed and nothing else changes |
| `restore_proposed` | **YES** | the backup is STILL absent, so the gap is live. The pending proposal is **superseded**, audited, and the row returns to `missed` — which is re-proposable |
| `restored` | **NO** | the governed restore **executed**. Re-opening a completed restore would rewrite history |
| `success` | **NO** | not a miss. Unreachable for a finding-keyed row — the scheduler's verified rows carry a NULL `finding_id` — and refused defensively rather than assumed away |
| `failed` | **NO** | same: not a miss, and not reachable on a finding-keyed row today |

### 3. A superseded proposal is an AUDITED fact, never a silent one

An operator who proposed a restore and finds their proposal gone must be able to learn why. So the
supersession writes an audit row alongside the others `infra.ts` already writes, in the same shape
and the same vocabulary (`objectType: 'infra_operation'`, `phase: 'scan'`, a `ruleId` naming the
event, a prose `reason`):

- **`ruleId: "infra-restore-proposal-superseded"`** — sibling to `infra-scan`,
  `infra-action-denied`, `infra-action-applied`, `infra-remediation-denied`.
- `objectId` is the finding; `detail` carries `ledgerId`, `supersededStatus: 'restore_proposed'`
  and `reopenedStatus: 'missed'`; the `reason` says the backup was still missing at re-scan and
  that the proposal can be re-made.

### 4. The restore EXECUTION path now closes its source row to `restored`

Before this change, an executed restore inserted its `kind='restore'`, `status='restored'` row and
**left the source row at `restore_proposed` for ever**. That was already wrong — the proposal is
not pending, it executed — and §2 makes it actively harmful: an executed restore and an
outstanding one would be **indistinguishable on the row**, so the re-open rule would "supersede"
work that had already been done, and §2's `restored` line would be unreachable dead code.

So the approve path also sets the source row to `restored`. The `kind='restore'` row remains the
record of **the restore itself**; the `kind='backup'` row now records that **the miss is closed**.
`restored` is terminal, and it is the one status the re-open refuses to touch.

### 5. Only now does the constraint get added

**Migration 0109** — `backup_runs_finding_uq`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "backup_runs_finding_uq"
  ON "backup_runs" ("finding_id")
  WHERE "kind" = 'backup' AND "finding_id" IS NOT NULL;
```

**Partial, and exactly as partial as the claim is** — ADR-0107 recorded that misreading a partial
index caused a real bug, so the predicate is argued rather than assumed:

- **`kind = 'backup'` is load-bearing, not decoration.** An executed restore appends a
  `kind='restore'` row carrying the **same `finding_id` by design**. A total index on `finding_id`
  would refuse it and break the *approve* path — precisely the class of failure (a constraint
  blocking a governance decision) that ADR-0109 refused this index over. Getting this wrong would
  have reproduced the original bug in mirror image.
- **`finding_id IS NOT NULL`** does not change *which* rows conflict — Postgres already treats
  NULLs as distinct — but the scheduler's verified `kind='backup'`, `status='success'` rows have no
  finding at all, and it is better to say they are outside the claim than to leave a reader to
  recall a NULL-handling rule.
- **Status is deliberately NOT in the predicate.** The whole point is that ONE row carries the
  finding through its entire lifecycle; a status-scoped index would re-admit exactly the second row
  this removes. (ADR-0109's advisory check *was* status-scoped, and lost that clause with this
  change.)

Same posture as 0108: the migration **adds and refuses**. A deployment that ran the old code and
holds two `missed` rows for one finding sees `CREATE UNIQUE INDEX` fail with 23505 and the upgrade
stop. No `DELETE`, no `ON CONFLICT`, no `DISTINCT ON`. Two rows recording that a governed backup was
missing are two observations of a compliance gap, and deciding which is real is a product question
with a human in it — the same argument ADR-0104 made refusing to backfill a consent digest.

### 6. The `backup_runs` pre-flight check is promoted from ADVISORY to BLOCKING

`DEFERRED_UNIQUE_CHECKS`' `backup_runs` entry goes `enforced: false` → `true`, gains
`index: "backup_runs_finding_uq"`, and drops `status = 'missed'` from its predicate. Ten enforced
checks, none advisory. **The `enforced` flag is kept** rather than deleted: the next constraint
this repo defers will need it, and ADR-0109's argument for reporting a number that keeps a
constraint out is still right.

### 7. The pre-flight becomes a real CI gate — one step, in the existing job

`.github/workflows/ci.yml`, `build-and-test`, **after `pnpm -r test`**:

> **Update 2026-10-10 (gateway sharding, PR #284):** the gateway suite now runs as four
> `gateway-tests` shards, each on its own database. This step runs in every shard, after that
> shard's tests, so the union of the four scans still covers every row the suite wrote. The
> decision is unchanged; only where the step sits moved.

```yaml
- name: Pre-flight — duplicates that would block a unique constraint (ADR-0109/0110)
  run: node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"
```

No new job, no second pipeline, no restructuring — a step inside a job that already has the
Postgres service and the `DATABASE_URL`, so it costs no extra runner startup. **Why after the
suite and not before:**

1. It needs a **migrated** database, and the suite is what migrates one — every gateway test file
   calls `runMigrations` on boot. Running the check first would mean adding a separate migrate step:
   a second way to apply migrations, kept in sync by hand, for no gain.
2. On an empty freshly-migrated database **every check is trivially zero and proves nothing.**
   After the suite the tables hold rows the *product's own write paths* wrote — which is exactly
   ADR-0109's own argument that "the stronger measurement is the suite itself". This is the only
   moment in CI when the scan has anything to scan.
3. It is where an **advisory** check would earn its keep: a check for a constraint not yet added
   describes duplicates the database still permits, and only a scan over real rows finds them.
   There are none today (§6 promoted the last one), and that is stated rather than implied.

**The script's exit behaviour was verified and one real defect fixed.** It already exited 0/1/2
correctly. But it printed its report with `console.log` and then called `process.exit()` — and
Node's stdout is **asynchronous when it is a pipe**, which is exactly what it is under a CI runner.
`process.exit()` does not flush what is still buffered, so a blocked pre-flight could have handed
CI a non-zero exit **with no reason printed** — the worst failure mode for a gate. The report is now
written with `fs.writeSync`, and the blocking constraints are repeated on stderr.

### 8. README's "Verifying a clean checkout" gains it as step 5

ADR-0106 added that sequence and it is the one humans actually run today, so the pre-flight is in
it — with the same "run it after the suite, not before" reasoning, and the same disclosure that
0108/0109 refuse rather than repair.

## The rejected alternative

**Keep `restore_proposed` and merely refresh the observation timestamp — never re-open.**

That preserves the operator's pending proposal, which is the honest point in its favour: work
in flight is not thrown away, and nobody has to re-do anything.

It was rejected because it means **the system stops saying the gap is live.** A backup is still
missing, a human has looked at it, and the surface that reports compliance gaps quietly shows the
finding as being handled. For a governance product that is the worse failure: hiding a live gap is
worse than losing a cheap piece of workflow state, and a restore proposal is very cheap to re-make
— it is one POST, and the re-opened row is immediately re-proposable.

**Stated plainly, because it is a real cost to a real person: an operator with a pending restore
proposal will see it superseded by the next re-scan that still finds the backup missing.** Their
approval request is abandoned and they must propose again. That is not a side effect; it is the
behaviour the owner chose, and §3 exists so it is visible rather than mysterious.

## What this deliberately does NOT do

- **It does not repair, merge, deduplicate or delete a single row.** Migration 0109 inherits 0108's
  posture exactly. An existing deployment holding the duplicate must resolve it by hand.
- **It does not overturn ADR-0109's refusal.** ADR-0109 was right about the code it described.
  This ADR changes the code first and adds the constraint second — in that order, deliberately.
- **It does not re-order the read.** Consistent with ADR-0107 §8 and ADR-0109 §8: the read is made
  single by the constraint, not accommodated by an `ORDER BY`.
- **It does not touch the other nine constraints, or the `data_key_state` finding.** ADR-0109 §6's
  argument stands unchanged.
- **It does not restructure CI, add a job, or add a second pipeline.** One step in the existing job.
- **It does not make the pre-flight run on boot.** ADR-0109's reason still holds — an upgrade check
  that runs on every start is a check nobody reads. It runs in CI and in the README sequence.
- **It does not change what a re-scan does to the FINDING.** `infraFindings.status` is still never
  reset by a re-scan (ADR-0017's rule). Only the ledger row re-opens. See Honest limits.
- **It does not delete the `enforced` flag** even though nothing is advisory today (§6).

## Honest limits

- **The operator's pending proposal is really lost.** Said in full above; repeated here because it
  is the cost of this decision and not a detail. The mitigation is the audit row and the fact that
  re-proposing is one request.
- **A re-scan does not re-open the FINDING, only the ledger row.** After an executed restore the
  finding sits at `remediated` and `syncFindingLedger` deliberately leaves the `restored` row alone
  — so if the provider still reports the backup missing after a restore that claimed success,
  the ledger row says `restored` and the finding says `remediated` while the gap is live. That is
  pre-existing ADR-0017 behaviour ("a re-scan never resets a finding's status"), it is NOT made
  worse here, and it is NOT fixed here either. It is a genuine honesty gap and it is owed its own
  decision.
- **`restored` being terminal is a claim about the paths that exist today.** Nothing stops a future
  writer from moving a `restored` row back to `missed`; the constraint does not care about status,
  only about there being one row. The re-open rule is enforced in code, not in the schema.
- **The constraint is proved on the mock infra provider.** The end-to-end propose → re-scan → deny
  cycle runs against a real gateway, a real database and the real HTTP surface — which is what
  ADR-0109 listed as missing — but the *provider* is `MockInfraProvider`. No AWS/Azure/GCP backup
  API was called. The lifecycle under test is ours; the observation that feeds it is mocked.
- **CI DID NOT EXERCISE THE NEW STEP.** GitHub Actions is exhausted for this repo, so the workflow
  has not run and this ADR cannot claim a green CI run. What *is* claimed is that the exact command
  the step runs was executed locally against the same kind of database, in all three of its exit
  states (§ below). The first real CI run is still the first real CI run.
- **A green pre-flight is a statement about one instant**, unchanged from ADR-0109. Rows written
  between the scan and the migration are not covered.
- **In CI the pre-flight can no longer find a blocking duplicate by construction.** The suite
  applies the migrations, so the constraints are in force before any row is written and a duplicate
  would have failed as a 23505 mid-suite instead. Its CI value is therefore narrower than it looks:
  it executes the script (nothing else does), and it is the place an advisory check would report.
  That is said here rather than left for someone to discover.

## Non-vacuity (M-002 / M-033, measured)

**The trap, stated first.** Two of the six new assertions are **negatives** — *the duplicate write
did NOT succeed* — the shape M-033 warns passes on wrong data. So the constraint test reuses
ADR-0109's discipline rather than writing a second helper's worth of it: it asserts **SQLSTATE
`23505`** *and* **`error.constraint === "backup_runs_finding_uq"`**, so a refusal by any other
unique index over the same fixture reddens instead of passing. The duplicate row also differs from
its twin in every column but the key (`status`, `started_at`, `finished_at`, `size_bytes`,
`source`), so nothing but `finding_id` can be doing the refusing. The index's **excluded**
populations are exercised in their own case — a `kind='restore'` row with the same `finding_id`,
and two `finding_id IS NULL` scheduler rows — so an accidentally-total index reddens too.

**Two probes, because there are two separable claims: the CODE re-opens, and the INDEX bites.**

| probe | result |
| --- | --- |
| as shipped | **6 passed / 6**, exit 0 |
| **A** — `backup_runs_finding_uq` DROPPED, code unchanged | **2 failed / 6**, exit 1 — *"the duplicate write SUCCEEDED — backup_runs_finding_uq does not bite"* and *"the pre-flight names backup_runs_finding_uq but it does not exist"*. The three behaviour cases correctly stay green: they assert what the code does, not what the index does |
| **B** — code REVERTED to ADR-0109's `status='missed'` read (and the execute-path close removed), index present | **3 failed / 6**, exit 1 — and the failure is more emphatic than expected: the **re-scan itself returns 409**, because the second insert hits 23505 and `app.ts` maps it to conflict. The executed-restore case fails on `expected 'restore_proposed' to be 'restored'` |

Probe B is the ADR-0109 hazard reproduced end-to-end, which ADR-0109 listed as a limit ("argued
from the code paths, not reproduced end-to-end through the HTTP surface"). It also refines it: with
the old code, the constraint breaks the lifecycle in **two** places, not one — the re-scan's INSERT
as well as the deny's UPDATE. The re-scan fails first.

**The deny-after-re-scan no longer 23505s** — the specific failure ADR-0109 refused the constraint
over. Asserted directly: propose → re-scan that still sees the miss → `POST /decide` with
`denied` → **200**, one row, status `missed`, and the response body asserted not to contain
`23505` or `conflict`.

### The pre-flight script, measured in all three exit states

Run as the CI step and the README step run it, against a database a full suite run had just
migrated and populated:

| state | how it was produced | stdout | exit |
| --- | --- | --- | --- |
| clean | as-is | 10 `[ok]` lines, `CLEAN — migrations 0108 and 0109 will apply.` | **0** |
| blocked | index dropped, one duplicate `(F, kind='backup', status='missed')` row inserted | `[BLOCKS] backup_runs (finding_id (kind='backup')) … 1 duplicate group(s), 2 row(s)` + `BLOCKED — 1 constraint(s) cannot be created.` on stdout, and the same on stderr | **1** |
| could not run | a port nothing listens on | `pre-flight could not run: …` | **2** |

The blocked and could-not-run runs were captured through a **pipe to a file**, which is the
condition the `writeSync` change exists for; the reason was present in both.

**And the pre-flight told the truth about the migration.** On that same blocked database, running
migration 0109's statement by hand:

```
ERROR:  could not create unique index "backup_runs_finding_uq"
DETAIL:  Key (finding_id)=(9300d9ed-…) is duplicated.
```

— i.e. the report is not merely a count, it is the count that predicts the upgrade failure.

Runtime of the clean run: **0.58 s** for ten scans. The CI budget arithmetic at the top of
`ci.yml` does not move.

### The duplicate scan, on a database populated by the final full-suite run

ADR-0109 reported this table with `backup_runs` as its advisory row (2 rows, and it said the
figure was near-vacuous at that population). Re-run against the database the final suite run left
behind, with populations alongside — a zero over an empty table says nothing:

| `backup_runs` slice | rows | finding-keyed | duplicate groups |
| --- | ---: | ---: | ---: |
| `kind='backup'`, `status='missed'` | 5 | 5 | **0** |
| `kind='backup'`, `status='restored'` (a closed miss, §4) | 2 | 2 | **0** |
| `kind='backup'`, `status='success'` (scheduler-verified) | 4 | **0** — outside the index | n/a |
| `kind='restore'`, `status='restored'` | 3 | 3 | outside the index by `kind` |
| **the constrained population** (`kind='backup' AND finding_id IS NOT NULL`) | **7** | 7 | **0** |

The other nine checks are 0 duplicate groups as ADR-0109 reported them.

**The `kind='backup'` predicate is load-bearing on real data, not only in argument.** Measured on
that same database: **3** `kind='restore'` rows share a `finding_id` with a `kind='backup'` row.
A total index on `finding_id` would have refused all three — i.e. it would have broken the approve
path three times over in one suite run. That is the mirror image of the bug ADR-0109 refused the
index over, and it is why §5 spends a paragraph on a one-line predicate.

**Suite**: **176 files / 2708 passed / 9 skipped / 0 failed, exit 0**, on a freshly created
database. Against ADR-0109's baseline of 175 / 2702 / 9 / exit 0 that is exactly **+1 file and +6
tests** — this batch's own file — with no other count moved. Repo-wide `pnpm -r build` then
`pnpm -r exec tsc --noEmit`: clean.

**One existing test was updated rather than left to fail.** `deferred-unique-constraints.test.ts`'s
pre-flight case pinned ADR-0109's shape — nine enforced checks, `backup_runs` the one advisory. §6
makes that assertion false by design, and it is updated to the stronger claim that replaced it: ten
enforced, none advisory, and `backup_runs_finding_uq` present among them. Its nine original
constraint cases and its `users_email_lower_uq` non-vacuity probe are untouched.

**Note 2026-10-03.** The bullet "CI DID NOT EXERCISE THE NEW STEP. GitHub Actions is exhausted for this
repo" is historical: Actions was re-enabled on 2026-08-01 and CI has run this pre-flight on every pull request
since (green, for example, at `21b3094`, run 37036782298).

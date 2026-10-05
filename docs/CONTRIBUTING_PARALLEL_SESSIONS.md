# Working on RegulAIt from two sessions at once

**Scope and precedence.** This document covers **repo-local mechanics** for the RegulAIt
repository only — which files collide, which numbers collide, which machine resources are
shared. It is **subordinate to the suite rules** referenced at the top of
[CLAUDE.md](../CLAUDE.md): if `SUITE_RULES.md` (or `CAPABILITY_MAP.md`) defines cross-session or
cross-repo coordination, that governs and this file yields. Do not resolve a conflict between
the two yourself — escalate, per the suite header.

**Why this exists.** On 2026-08-22 a cloud session and a local session worked this branch at the
same time. It produced, within the hour, a **duplicated suite-rules header** that needed a
removal commit, and a **merge commit** from divergent histories. Nothing was lost, but nothing
warned either. Every hazard below is either something that has already happened in this repo or
something verified by reading the code — none is hypothetical.

---

## 1. Split by capability, not by task

A cloud container and a local machine are good at different things. Dividing by *what each can
physically do* removes most contention before it starts.

| | **Local machine** | **Cloud session** |
|---|---|---|
| Can do | Browser, Docker Compose, clicking the real UI | Survives between messages; multi-hour agent waves |
| Cannot do | Long unattended runs (session ends when you close it) | Serve a browser you can click; pull Docker Hub images through the egress proxy |
| Owns | `apps/web/**`, `apps/web/e2e/**` | `apps/gateway/**`, `packages/**`, `infra/**` |
| Runs | `docker compose up`, Playwright, manual UX testing | Gateway vitest suite, migrations, docs |

Cross-boundary changes are **requested, not made**. If the local session needs a gateway field,
it says so; the cloud session adds it. This is the same discipline that let two agents run
concurrently all afternoon without a single lost edit — each had a declared writable surface.

## 2. Prefer separate branches

Most of §4 disappears if the two sessions do not share a branch. Give each its own branch off the
shared one and merge through a PR: you get isolation, and the diff tells you what changed.

Hazards that vanish with separate branches: force-push destruction, mid-write commits of the
other session's files, rebase-while-the-other-pushes. Hazards that **survive** separate branches
and must still be managed: every number collision in §4, because two branches can each take
"the next number" cleanly and then merge with no conflict at all.

## 3. The four standing rules

1. **Declared file ownership.** Whoever owns a directory edits it. Never commit a file another
   session or agent has open — a mid-write commit captures a half-finished state, and this repo
   has a ledger entry (M-016) about ~450 lines lost to exactly that class of interference.
2. **Push every commit immediately.** Not "commit small" — *push* small. A local-only commit does
   not survive a container rollback; the evidence is **M-022**, where a rollback erased an agent's
   entire task and `git fsck` recovered nothing.
3. **`git pull --rebase` before every push. Never force-push.** This branch has had force-pushes
   to tidy WIP checkpoints. With two live sessions that is destructive, not tidy.
4. **One owner at a time for the shared ledger** — `project-state/STATE.md`, `mistakes.md`,
   `docs/product/PENDING.md`, `docs/product/TESTING_CHECKLIST.md`. Announce the handoff.

## 4. The silent hazards — collisions git will not warn you about

These are ordered by how quietly they fail. The first is the one that can waste a day.

### 4.1 Migration watermark poisoning (silent, permanent, retry-proof)

The journal's `when` values in this repo are **hand-authored round numbers** incrementing by
exactly 1,000,000 ms — the tail reads `1785033000000, 1785034000000, 1785035000000`
(≈ 2026-07-26). `drizzle-kit generate` instead stamps `when: +new Date()` — roughly
`1787400000000`, about **27 days ahead** of the hand-authored sequence.

The applier's guard is a **strict less-than** on a watermark read **once** before the loop
(`drizzle-orm/pg-core/dialect.js`: `Number(lastDbMigration.created_at) < migration.folderMillis`).
So a single generated migration with a real timestamp sets the watermark far into the future, and
**every subsequent hand-numbered migration is silently skipped forever**. No error. No warning.
The schema simply stops advancing.

> **Rule: never run `drizzle-kit generate` on this repo.** Hand-author the `.sql` file and hand-append
> the journal entry, continuing the +1,000,000 ms convention. Next value by convention: `1785036000000`.

Two related traps from the same mechanism:

- **Duplicate `when`.** If both sessions hand-write the same next value, strict-less-than means the
  second migration never applies — even after you "fix" the filename collision by renumbering.
  `when` must be unique **and** strictly increasing.
- **Editing an applied migration.** The migration hash is stored but **never compared**, so there is
  no checksum error. Resolving a merge conflict inside an already-applied `.sql` leaves that
  developer's database permanently on the pre-merge schema. After editing any applied migration,
  drop and re-migrate the database — do not trust that it caught up.

### 4.2 Same-number files that merge with **zero** conflict

Two sessions each take migration `0101` (or ADR `0097`) with different descriptive slugs. Git sees
two distinct new files and **auto-merges both**. There is no conflict marker, no signal — just two
migrations claiming one number and a journal that can only describe one of them.

> **Rule: claim the number before you use it.** Push a one-line placeholder commit reserving the
> number, or announce the claim, before writing the body.

Current sequence heads, verified:

| Sequence | Location | Highest now | Next | Notes |
|---|---|---|---|---|
| Migrations | `packages/db/migrations/` | `0100_copilot_apply_and_judged_recommendations.sql` | **0101** | 100 files, `0065` never existed |
| Journal | `packages/db/migrations/meta/_journal.json` | `idx: 100` | **101** | 705 lines; `idx` mirrors the filename, so it inherits the 0065 hole |
| ADRs | `docs/decisions/` | `0096-entity-aware-copilot-planning.md` | **0097** | 96 files, no gaps |
| ADR index | `docs/decisions/README.md` | 95 rows | — | **already drifted: 96 files, 95 rows — ADR-0078 has no row** |

**Retired migration numbers (never reuse):** `0065`, `0147` (ADR-0173) and `0152` (ADR-0179). Each was skipped and the
journal has no entry for it. A file with that number added now would carry a `when` below the database's watermark, so
it would never apply (§4.1). Always take the number after the highest existing file.

### 4.3 `_journal.json` always conflicts on append

Appending an entry requires rewriting the previous last entry's `}` into `},`, so two concurrent
appends **always** touch the same physical line. This is the one guaranteed conflict in the set —
which makes it the *good* case, because git will tell you. Resolve by keeping **both** entries and
renumbering one, then verify the file parses and `idx` values are unique.

### 4.4 Losing an ADR index row in a "resolved" conflict

Both sessions append a row to the end of `docs/decisions/README.md`; the conflict gets resolved by
keeping one. The lost row is invisible forever after.

> **Merge-time assertion:** `ls docs/decisions/[0-9]*.md | wc -l` must equal
> `grep -cE '^\| \[[0-9]{4}\]' docs/decisions/README.md`. It does **not** today (96 vs 95).

### 4.5 STATE.md recap clobber

Both sessions prepend to the same `## Where we are` window; the merge silently drops one session's
entire record. Rule 3.4 (one owner) exists for this. If both must write, write to *different*
sections and never the same paragraph.

### 4.6 One decision fans out across four sequences

CLAUDE.md's update discipline requires, for a single change: an ADR file **+** an ADR index row
**+** a STATE.md row **+** a migration **+** a journal entry. That is five append points, four of
them collision-prone, for one decision. Serialize decision-commits between the sessions — one
session lands its whole set before the other starts.

### 4.7 CI cannot catch any of this

There is **no `push:` trigger**, and the `pull_request` workflow skips markdown and state paths.
Every assertion in §4 is a **manual** merge-time check. ~~(GitHub Actions minutes are also
exhausted; local verification is the only gate.)~~ *Correction 2026-10-03: the parenthetical is
stale — Actions runs again for this repo (`ci.yml`'s budget header was re-measured on 2026-10-02
from runs 37050080219 / 37045578961 / 37042881890; run 37036782298 was green at exact head
`21b3094`). The two structural facts in this subsection are unchanged: no `push:` trigger, and a
docs-only or state-only diff never enters CI, so every §4 assertion is still checked by hand.*

## 5. Shared machine resources

If both sessions run on **one** machine, these fight:

- **The gateway test database.** `apps/gateway/vitest.config.ts` sets `fileParallelism: false`
  because *"every test file shares one Postgres database"*. `DATABASE_URL` is read from the ambient
  environment (never set by the config) and **147 of 154** gateway test files share that one
  database. Two suites against the same `regulait_test` destroy each other — this has already
  happened once on this machine.
  > **Rule: each session exports its own `DATABASE_URL`** (e.g. `regulait_test_local` vs
  > `regulait_test_cloud`), and drops/recreates it before every run (M-009).
- **Scratch databases.** Six test files are now per-run unique via `_${process.pid}_${Date.now()}`
  (seed, audit-chain, data-key-custody ×2, data-key-reencrypt, worker-streaming). One is **not**:
  `onboarding.test.ts` uses `regulait_onb_drift_${process.pid}` — pid only. Live pids are unique,
  so concurrent runs are safe; a recycled pid across sequential runs is the residual risk.
- **Ports.** The compose stack and the Playwright global-setup gateway bind fixed ports. Two
  stacks cannot both hold them — give the second session an explicit `PORT` override.
- **Process killing.** `pkill -f` on a shared machine can kill the *other* session's processes as
  well as your own shell (M-006, and its repeat M-021). Use `pkill -x`, or bracket a character:
  `docker[d]`.

## 6. Merge-time checklist

Run these by hand before merging either direction — CI will not:

```bash
# 1. ADR files and index rows agree
[ "$(ls docs/decisions/[0-9]*.md | wc -l)" = "$(grep -cE '^\| \[[0-9]{4}\]' docs/decisions/README.md)" ] \
  && echo "ADR index OK" || echo "ADR INDEX DRIFT"

# 2. No duplicate migration numbers, and the journal agrees with the folder
ls packages/db/migrations/*.sql | sed 's#.*/##; s/_.*//' | sort | uniq -d   # must print nothing
python3 -c "import json;e=json.load(open('packages/db/migrations/meta/_journal.json'))['entries'];\
i=[x['idx'] for x in e];w=[x['when'] for x in e];\
print('idx dupes:',len(i)-len(set(i)),'| when dupes:',len(w)-len(set(w)),'| when ascending:',w==sorted(w))"

# 3. Schema and migrations both moved, or neither did
git diff --stat <base>..HEAD -- packages/db/

# 4. Then the real gate: full suites on a fresh database
```

## 7. If you are the session picking this up cold

Read [CLAUDE.md](../CLAUDE.md) → [project-state/STATE.md](../project-state/STATE.md) →
[mistakes.md](../mistakes.md) → this file, then **ask which surface you own** before editing
anything. The other session may be mid-task in a file that looks idle.

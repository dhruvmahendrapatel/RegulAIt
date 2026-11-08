# Working on RegulAIt from two sessions at once

**Scope and precedence.** This document covers **repo-local mechanics** for the RegulAIt
repository only — which files collide, which numbers collide, which machine resources are
shared. It is **subordinate to the suite rules** referenced at the top of
[CLAUDE.md](../../CLAUDE.md): if `SUITE_RULES.md` (or `CAPABILITY_MAP.md`) defines cross-session or
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
4. **One owner at a time for the shared ledger** — `internal/memory/STATE.md`, `mistakes.md`,
   `internal/product/PENDING.md`, `internal/product/TESTING_CHECKLIST.md`. Announce the handoff.

## 4. The silent hazards — collisions git will not warn you about

> **Since 2026-11-07 ([ADR-0252](../decisions/0252-merge-queue-and-merge-time-numbering.md)) most of this section is
> handled at merge time.** A PR no longer claims a migration number, a journal line, an ADR index row or a line at
> the end of STATE.md or PENDING.md. Follow §8 ("Builder steps") for the flow; the subsections below keep the
> mechanisms, which still explain why the rules exist.

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

> **Rule: never run `drizzle-kit generate` on this repo** (ADR-0252 removed the `generate` script). Hand-author
> the `.sql` file as `packages/db/migrations/pending/<slug>.sql` and **do not touch the journal**: the
> assign-at-merge step appends the entry after the merge, continuing the +1,000,000 ms convention.

Two related traps from the same mechanism:

- **Duplicate `when`.** If both sessions hand-write the same next value, strict-less-than means the
  second migration never applies — even after you "fix" the filename collision by renumbering.
  `when` must be unique **and** strictly increasing.
- **Editing an applied migration.** The migration hash is stored but **never compared**, so there is
  no checksum error. Resolving a merge conflict inside an already-applied `.sql` leaves that
  developer's database permanently on the pre-merge schema. After editing any applied migration,
  drop and re-migrate the database — do not trust that it caught up.

> **Addendum (2026-10-31): reserved numbers do not reserve the watermark.** Lanes reserved migration
> numbers ahead with `when` set by formula (`1785149000000 + (N−214)×1,000,000`). That is safe only if
> lanes merge in number order. When 0237 merged before 0223–0225 and 0228, any database that ran main in
> between would skip the lower ones, because the watermark rule above applies to them too. Moving only the
> `when` is not enough either: the placement tests (`zz-adr0190-*`) require `when` to rise with `idx`. From now
> on, a lane whose migration number is below main's highest migration is **renumbered** before it merges.
> Its file, tag and `idx` move to the next free numbers above main's highest, and `when` follows the formula
> for the new number. Every reference to the old tag moves with it. CI enforces this with
> `scripts/migration-watermark-guard.mjs`, which refuses any new entry not above the base branch's newest
> `when`.

> **Superseded on 2026-11-07 by ADR-0252: numbers are assigned at merge time.**
> 1. A PR adds `packages/db/migrations/pending/<slug>.sql` (lowercase words joined by `_`). It does not pick a number,
>    does not edit `meta/_journal.json`, and refers to the migration by its slug. Several files in one PR are numbered
>    in name order, so name them to sort in run order.
> 2. CI applies pending files in provisional order on its disposable databases (`REGULAIT_MIGRATIONS_UNASSIGNED=apply`,
>    also set by the gateway's vitest config). A long-lived database refuses them (`UnassignedMigrationsError`), so a
>    provisional number never reaches one. Do not set the variable on a database you keep.
> 3. After the merge, `.github/workflows/assign-at-merge.yml` runs `scripts/assign-at-merge.mjs`. It numbers every pending
>    file (number and idx one above the journal's highest, `when` = last `when` + 1,000,000), renames it, appends
>    its entry and pushes the result to `assign-at-merge/<main sha>`. The master opens that PR and enqueues it.
> 4. The guard (`scripts/migration-watermark-guard.mjs`, on PRs and in the merge queue) refuses: a changed or removed
>    merged entry; a changed merged `.sql`; a numbered file with no entry, or an entry with no file; a bad pending name;
>    and any new journal entry that is not exactly the assign step's numbering of pending files the same diff removes.
>
> **Converting an open PR** that still adds a numbered migration the old way:
>
> ```bash
> git fetch origin main && git merge origin/main             # merge, never rebase (M-067)
> git checkout origin/main -- packages/db/migrations/meta/_journal.json
> git mv packages/db/migrations/0290_my_change.sql packages/db/migrations/pending/my_change.sql
> grep -rn "0290_my_change" --exclude-dir=node_modules .     # change each reference to the slug (my_change)
> node scripts/migration-watermark-guard.mjs origin/main     # must pass
> ```

### 4.2 Same-number files that merge with **zero** conflict

Two sessions each take migration `0101` (or ADR `0097`) with different descriptive slugs. Git sees
two distinct new files and **auto-merges both**. There is no conflict marker, no signal — just two
migrations claiming one number and a journal that can only describe one of them.

> **Rule: claim the number before you use it.** Push a one-line placeholder commit reserving the
> number, or announce the claim, before writing the body. *(ADR-0252: still true for ADR numbers. Migrations no
> longer take a number on a branch; two PRs with the same pending slug get a plain add/add conflict, which git does
> report.)*

Do not trust a table of sequence heads in a document: it goes stale with the next merge. Read the heads
from the tree at the moment you claim a number:

```bash
ls packages/db/migrations/*.sql | sed 's#.*/##' | sort | tail -1          # highest migration file
python3 -c "import json;e=json.load(open('packages/db/migrations/meta/_journal.json'))['entries'];\
print('journal idx', e[-1]['idx'], 'when', e[-1]['when'])"                # journal head (next when = +1000000)
ls internal/decisions/[0-9]*.md | sed 's#.*/##' | sort | tail -1               # highest ADR file
```

then run the §6 checklist, which shows whether the files, the journal and the ADR index agree.

**Retired migration numbers (never reuse):** every number below the highest file that has no `.sql` file and no
journal entry. On 2026-10-24 they are `0065`, `0147` (ADR-0173), `0152` (ADR-0179), `0163`–`0166` and `0177`–`0179`;
list them again with
`python3 -c "import os,re;f=sorted(int(x[:4]) for x in os.listdir('packages/db/migrations') if re.match(r'\d{4}_.*\.sql$',x));print([n for n in range(1,f[-1]) if n not in f])"`.
A file with a retired number added now would carry a `when` below the database's watermark, so it would never apply
(§4.1). Always take the number after the highest existing file. ADR numbers `0151`–`0155` were never used either.

### 4.3 `_journal.json` always conflicts on append

*(ADR-0252: no branch edits the journal any more; only the assign-at-merge step does, one PR at a time. Kept for
history and for converting older PRs.)*

Appending an entry requires rewriting the previous last entry's `}` into `},`, so two concurrent
appends **always** touch the same physical line. This is the one guaranteed conflict in the set —
which makes it the *good* case, because git will tell you. Resolve by keeping **both** entries and
renumbering one, then verify the file parses and `idx` values are unique.

### 4.4 Losing an ADR index row in a "resolved" conflict

Both sessions append a row to the end of `internal/decisions/README.md`; the conflict gets resolved by
keeping one. The lost row is invisible forever after.

> **Merge-time assertion:** `ls internal/decisions/[0-9]*.md | wc -l` must equal
> `grep -cE '^\| \[[0-9]{4}\]' internal/decisions/README.md`. CI now checks this, row order and links with
> `scripts/adr-index.test.mjs` (FS-55).
>
> **ADR-0252: do not add the row by hand.** Add only the ADR file, with the template header (`# ADR-NNNN: Title`,
> `- **Status**:`, `- **Date**:`, and `- **Index**:` if the title is too long for the table). The assign-at-merge
> step adds the row after the merge. `scripts/adr-index.test.mjs` checks the index as that step will leave it, so
> a header it cannot read fails CI on the PR.

### 4.5 STATE.md recap clobber

Both sessions prepend to the same `## Where we are` window; the merge silently drops one session's
entire record. Rule 3.4 (one owner) exists for this. If both must write, write to *different*
sections and never the same paragraph.

**ADR-0252: appends go in fragments.** A new recap paragraph, a new Decisions paragraph or a new PENDING item is a
file `internal/fragments/<YYYY-MM-DD>-<lane>-<slug>.md` whose first line is `<!-- fold: state-recap -->`,
`<!-- fold: state-decisions -->` or `<!-- fold: pending -->`. The assign-at-merge step moves it to its marker and
deletes it ([internal/fragments/README.md](../fragments/README.md)). Edits to an existing paragraph or row are still
ordinary edits, and still collide if two PRs edit the same one.

### 4.6 One decision fans out across four sequences

CLAUDE.md's update discipline requires, for a single change: an ADR file **+** an ADR index row
**+** a STATE.md row **+** a migration **+** a journal entry. That is five append points, four of
them collision-prone, for one decision. Serialize decision-commits between the sessions — one
session lands its whole set before the other starts.

### 4.7 CI cannot catch any of this

*(ADR-0252: no longer true once the merge queue is on. The queue runs `ci.yml`, `security.yml`, `import-cycles.yml`
and `ui-enterprise.yml` on the combined result of every queued PR, docs-only PRs included, because `merge_group`
takes no path filter. The text below records how it was.)*

There is **no `push:` trigger**, and the `pull_request` workflow skips markdown and state paths.
Every assertion in §4 is a **manual** merge-time check. ~~(GitHub Actions minutes are also
exhausted; local verification is the only gate.)~~ *Correction 2026-10-03: the parenthetical is
stale — Actions runs again for this repo (`ci.yml`'s budget header was re-measured on 2026-10-02
from runs 37050080219 / 37045578961 / 37042881890; run 37036782298 was green at exact head
`21b3094`). The two structural facts in this subsection are unchanged: no `push:` trigger, and a
docs-only or state-only diff never enters CI, so every §4 assertion is still checked by hand.*

*2026-10-24 (FS-55): `scripts/adr-index.test.mjs` checks §4.4 in CI, but only on a run that happens (a PR that
touches code, or the weekly run of `main`). A docs-only ADR PR still skips CI, so run §6 step 1 by hand.*

### 4.8 CI is split: fast checks on a PR, the full suite at merge time (owner decision, 2026-11-07)

The free public-repo runner pool holds about 20 jobs at once and a full run was about 30, so only one PR's CI ran at
a time and over 200 runs queued. Since 2026-11-07 (ADR-0252 addendum):

| Event | What runs |
|---|---|
| `pull_request`, code changed | `ci.yml`: build, typecheck, package suites, static pre-flights (migration guard, licence gate), and the four gateway shards and their coverage check, web-only PRs included (gateway tests read `apps/web` sources). `security.yml`: CodeQL, gitleaks, dependency audit. `ui-enterprise.yml`: tokens, baseline guard and bundle size. |
| `pull_request`, code outside `apps/web/**` changed | also `import-cycles.yml`, and `integrations.yml` when its paths match (both path-filtered; neither reads `apps/web`) |
| `pull_request`, `apps/web/**` (or `packages/shared/**`, the lockfile) changed (`web`) | also the mocked SPA shards and the Chromium enterprise browser job |
| `pull_request`, the root image's build context or its Trivy gate changed (`image`) | also Trivy: the root `Dockerfile`, `.dockerignore`, the workspace manifests and lockfile, `apps/**` and `packages/**` (not tests or `apps/web/e2e`), `security.yml`, `security/image-allowlist*.json`, and `scripts/security-{gate,runtime-contents,suppressions}.mjs` and `scripts/security-cosign-verify.sh` |
| `pull_request`, an engine's own input changed (`engines`) | also the engine image scans and SBOMs, and the engine build-and-compare: `engines/**`, any `Dockerfile`, the lockfile, the engine packages and scripts, `security/image-allowlist.engine-*.json`, the gate scripts the engine scan runs, the image workflows. Not `packages/**` or `apps/**`, which each engine's shim stage also copies: a change there alone builds and compares the engines at merge time. |
| `pull_request`, docs only | every scope-gated job is skipped by `if:`; `build-and-test` and `ui enterprise / all` still report. gitleaks and the dependency audit still run. |
| `pull_request`, the scope rules themselves changed | everything, as a full run (`scripts/ci-scope.mjs`, its test, `.github/actions/ci-scope`) |
| `merge_group`, push to `main`, nightly 03:17 UTC (`security.yml` 05:17 UTC) | everything: the above plus the SPA journeys, docker build, every SPA shard, Firefox, WebKit and the screenshot pack, every engine image scan, the demo journeys, gVisor and the engine build-and-compare |

What this means for a builder:

- A green PR is no longer the whole proof. The merge queue runs the full suite on the combined result; a failure
  there drops the PR from the queue, and you fix it on the branch like any other red check.
- To run the full suite on a branch before it is queued, use **Run workflow** (`workflow_dispatch`) on `ci.yml`,
  `ui-enterprise.yml`, `demo.yml` or `gvisor.yml`.
- A newer push to a PR cancels its older run. Every other run (merge group, push to main, schedule, manual) has a
  concurrency group of its own (`github.run_id`), because GitHub cancels an older *pending* run in a shared group
  whatever `cancel-in-progress` says.
- The scope fails closed (`scripts/ci-scope.mjs`): a rename counts at both its paths, and a diff it cannot read means
  a full run. A required job gated directly on the scope (CodeQL, Trivy) runs unless the scope said `'false'`
  (`!cancelled() && ... != 'false'`), so a scope that failed runs it; the gated jobs behind `build-and-test` and
  `ui enterprise / all` are judged by those aggregates against their own outputs.
- Required checks (set by the owner when the queue is enabled) are names that report on every PR and every merge
  group: `build-and-test`, `SAST (CodeQL)`, `Secret scan (gitleaks)`, `Dependency audit (pnpm)`, `Image scan and SBOMs
  (Trivy)` and `ui enterprise / all`. Never require a job gated by `scope` directly (a skip counts as a pass), a
  path-filtered workflow (`import-cycles`, `integrations`, `endpoint-agent`, `engine-images-build`, `gvisor`, `demo`)
  or a workflow without a `merge_group` trigger.
- No job is gated by a workflow-level path filter any more where it can be required. Gate a new job on the `scope`
  job's outputs (`.github/actions/ci-scope`): `full`, `code`, `web`, `image` or `engines`, and add a case
  to `scripts/ci-scope.test.mjs`.
- PR trim (owner decision 2026-11-07, measured about 37 check runs per PR before it): a web-only PR runs about 23 jobs
  and a gateway-only PR about 19, against 37 before. The largest remaining items are the five mocked SPA shards and the
  four gateway shards.

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

Run these by hand before merging either direction. CI runs the first (as `scripts/adr-index.test.mjs`) and the
second (as `scripts/migration-watermark-guard.mjs`, ADR-0252), on PRs and in the merge queue:

```bash
# 1. ADR files and index rows agree
[ "$(ls internal/decisions/[0-9]*.md | wc -l)" = "$(grep -cE '^\| \[[0-9]{4}\]' internal/decisions/README.md)" ] \
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

Read [CLAUDE.md](../../CLAUDE.md) → [internal/memory/STATE.md](../memory/STATE.md) →
[mistakes.md](../memory/mistakes.md) → this file, then **ask which surface you own** before editing
anything. The other session may be mid-task in a file that looks idle.

## 8. Builder steps under the merge queue (ADR-0252)

For a builder lane, from branch to merge:

1. **Branch** from `origin/main`. Merge main into it when you need to, never rebase (M-067).
2. **Migration:** add `packages/db/migrations/pending/<slug>.sql`. Do not number it and do not touch
   `meta/_journal.json`. Refer to it by its slug. Run the gateway tests as usual: the suite applies it.
3. **ADR:** claim the next free ADR number (§4.2) and add only the ADR file with the template header. No README row.
4. **STATE.md / PENDING.md:** add a fragment under `internal/fragments/` for each new paragraph or item (§4.5). Edit
   existing text in place only when you must.
5. **Check** before pushing: `node scripts/migration-watermark-guard.mjs origin/main` and
   `npx vitest run --dir scripts adr-index assign-at-merge`, plus your own tests.
6. **Draft PR**, then mark it ready when CI is green. Do not merge it yourself, and do not merge main into it only to
   stay current: the queue tests it on top of everything ahead of it.
7. **The master enqueues it** (`gh pr merge <n> --merge --auto`). If the queue run fails, the PR leaves the queue;
   fix it on the branch and the master enqueues it again.
8. **After the merge,** the assign-at-merge job numbers your migration and folds your ADR row and fragments; its PR
   goes through the queue too. Until it lands, `main` holds your migration unnumbered, and a long-lived database
   refuses to migrate, by design (§4.1).

**For the master:** enqueue instead of merging. When an `assign-at-merge/<sha>` branch appears, open a PR from the
newest one (title "chore: assign migration numbers and fold docs at merge (ADR-0252)") and enqueue it. Keep one
open at a time, and delete older `assign-at-merge/*` branches that never got a PR: while one is unmerged, the job
pushes no new branch and its summary names the one waiting. If the job cannot run,
`node scripts/assign-at-merge.mjs --write` on a branch from main gives the same result.

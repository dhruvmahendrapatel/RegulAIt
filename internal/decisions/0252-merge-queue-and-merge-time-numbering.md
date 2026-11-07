# ADR-0252: Merge queue on main, with migration numbers and shared-doc appends assigned at merge time

- **Status**: Accepted (owner decision of 2026-11-07: enable the GitHub merge queue on main and assign migration numbers at merge time; builder `builder/merge-queue-readiness`)
- **Date**: 2026-11-07
- **Index**: Merge queue on main; migration numbers, ADR index rows and STATE/PENDING appends written at merge time
- **Review findings**: R-03, R-06, R-07, R-08, C-03, C-04 in [the 2026-11-07 whole-build review](../reviews/2026-11-07-whole-build-review.md)
- **Migration**: none

## Context

Every PR that added a migration claimed a global number and a line at the end of
`packages/db/migrations/meta/_journal.json`. In three weeks the journal took 115 commits (66 of them merges of main),
37 recorded conflicts and 20 renumber or re-stamp commits; #605's migration was renumbered three times (R-03). The ADR
index took 165 commits and 34 conflicts (R-07); STATE.md's recap and decisions, PENDING's rows and the route-census
size pins (C-04) were the same kind of single append point. Each landing forced the next PR to merge main and re-run
CI, about two merges of main per PR (R-08), and PRs that were each green alone pushed the combined tree over the
entry-JS size limit (R-06).

The migration guard (`scripts/migration-watermark-guard.mjs`) only checked new `when` values. It could not see an
edited merged migration, a removed or changed entry, or a file with no entry (C-03).

## Decision

1. **Merge queue.** The owner turns on GitHub's merge queue for `main` (merge method: merge commit, M-067). Every
   always-on workflow (`ci.yml`, `security.yml`, `import-cycles.yml`, `ui-enterprise.yml`) also runs on
   `merge_group`, so the queue tests the combined result, size-limit included. Their base-branch comparisons use
   `merge_group.base_sha` there. The path-filtered workflows (`demo`, `gvisor`, `integrations`, `endpoint-agent`,
   `engine-images-build`) stay PR-only: they cannot be required checks, because a path-skipped required check never
   reports.
2. **Migrations without upfront numbers.** A PR adds `packages/db/migrations/pending/<slug>.sql` and never edits the
   journal. After the merge, `scripts/assign-at-merge.mjs` numbers every pending file in name order: number and idx
   one above the journal's highest, `when` = last `when` + 1,000,000 (the §4.1 convention), tag `NNNN_<slug>`; it
   renames the file and appends the entry. `.github/workflows/assign-at-merge.yml` runs it on each push to main and
   pushes the result to `assign-at-merge/<main sha>`. Push-only, as for the engine-images lock branch (owner decision,
   2026-10-21): the master opens the PR and enqueues it. One assignment is in flight at a time; its own merge starts
   the next run.
3. **Pending files never reach a long-lived database.** `runMigrations` refuses a folder with pending files
   (`UnassignedMigrationsError`) unless `REGULAIT_MIGRATIONS_UNASSIGNED=apply` declares the database disposable; then
   it applies them from a temporary copy numbered by the same rule. CI and the gateway suite set it. Without this, a
   database that applied a provisional number could skip the migration that later really gets it (§4.1). Secure by
   default (ADR-0180): refusing is the default, and relaxing it is an explicit setting.
4. **The guard (C-03).** It now compares the PR's migrations folder with the base: merged entries unchanged and in
   place, merged `.sql` bytes unchanged, numbered files and journal entries one-to-one, pending names valid, and new
   entries only exactly what the assign step writes for the pending files the diff numbers, with the bytes kept.
   The old `when` checks stay. It runs on PRs and in the queue. The `generate` script (drizzle-kit, the §4.1 watermark
   trap) is removed from `@regulait/db`.
5. **Shared docs.** The same step adds the ADR index row for each ADR file without one, built from the file's header
   (`# ADR-NNNN: Title`, `- **Status**:`, `- **Date**:`, optional `- **Index**:`); `scripts/adr-index.test.mjs` checks
   the index as the step will leave it. STATE.md and PENDING.md appends are fragment files under `internal/fragments/`
   whose first line names a fold marker (`state-recap`, `state-decisions`, `pending`); the step moves them to the
   marker and deletes them. Edits to existing text stay ordinary edits.
6. **C-04.** The route-census test no longer pins the sizes of `MACHINE_ONLY`, `SUPERSEDED` and `INDIRECT_UI_CALLS`;
   `KNOWN_UI_GAPS_MAX = 0` stays.

Existing numbered migrations, journal entries and ADR rows are untouched.

### Why after the merge, and not in the queue or before it

- **In the queue:** GitHub builds the merge-group ref and does not let a job push to it, so a queue step cannot write
  the numbers into what merges. The queue does test them: CI applies pending files in provisional order.
- **Before the queue (the PR assigns its own number at enqueue time):** two PRs enqueued together take the same
  number, so this only moves the renumber loop into the queue.
- **After the merge:** nothing on a branch touches a shared line, so PRs merge in any order. The assignment is one
  deterministic PR that goes through the queue and CI like any other. Its cost is a short window in which main holds
  unnumbered files; item 3 makes that window loud and safe rather than silent.

### Open source checked first (ADR-0176)

- **Drizzle.** drizzle-kit 0.31 (ours) has no merge-time numbering; `generate` stamps a real timestamp, which is the
  §4.1 trap. Drizzle v1 drops the journal for one folder per migration and a migrator that picks unapplied migrations
  from the database's history. That is the alternative R-03 names. It is a major upgrade of the ORM and its migration
  table, so it is recorded as the follow-up rather than taken now; pending files named by slug move to it without a
  rename.
- **GitHub merge queue:** native, used as is.
- **towncrier** (MIT, Python) and **changesets** (MIT, npm) are the fragment pattern, but they build changelogs, not
  in-place folds into marked sections of existing files. A Python tool in the Node CI is a new runtime. The fold
  (`scripts/fold-docs.mjs`) is about 100 lines, so we wrote it: the narrow exception (a fold into existing marked
  files is not what either tool does).
- **`merge=union` in `.gitattributes`:** GitHub's server-side merges and the merge queue do not use custom merge
  drivers, so it would not prevent a conflict on GitHub.

## Consequences

- Two PRs that each add a migration, an ADR or a STATE/PENDING entry no longer conflict. The test
  (`scripts/assign-at-merge.test.mjs`) merges two such PRs in either order, with the step running once or after
  each merge, and checks the journal and the guard.
- Until the owner enables the queue and the master follows the new loop (below), PRs still merge as before. The
  guard refuses the old flow from now on: an open PR that adds a numbered migration and a journal entry converts
  (CONTRIBUTING_PARALLEL_SESSIONS §4.1, "Converting an open PR").
- Code and docs refer to a pending migration by its slug until it has a number. A `CONCURRENT_INDEXES` entry may name
  the slug.
- After each merge with a pending migration, main briefly holds unnumbered files. A long-lived database and the
  gateway boot refuse them until the assignment PR lands, with a message that says so.
- The master's loop changes: enqueue with `gh pr merge <n> --merge --auto` (or the GraphQL `enqueuePullRequest`)
  instead of merging, and open and enqueue the `assign-at-merge/*` branch's PR when one appears.
- Owner settings this needs (not code): the merge queue on `main` with merge method "merge commit"; required checks
  that report on `merge_group`. ADR numbers are still claimed upfront; the same scheme can take them later.
- Follow-ups: Drizzle v1's journal-free migrator; a schema-to-SQL parity test (C-03); per-PR status checklists and a
  per-lane cap on open PRs (R-08), which is process, not code.

## Addendum (2026-11-07): fast checks on a PR, the full suite at merge time

**Owner decision, 2026-11-07.** The free public-repo runner pool runs about 20 jobs at once, and a full CI run was
about 30 jobs, so only one PR's CI ran at a time and nearly 200 runs were queued. CI is split. Built in #734
(`.github/actions/ci-scope` and the workflow triggers), documented in CONTRIBUTING_PARALLEL_SESSIONS §4.8.

- **On `pull_request`:** build, typecheck, the package suites, the static pre-flights (migration guard, licence gate)
  and the four gateway shards when code changed; every security gate, always, unchanged (CodeQL, gitleaks, dependency
  audit, Trivy); the UI tokens, baseline and bundle-size job; the mocked SPA shards and the enterprise browser jobs only
  when the web app or what it is built from changed; the engine build-and-compare only when engine files changed.
- **On `merge_group`, a push to `main` and nightly:** everything, adding the SPA journeys, the docker build, the demo
  journeys and gVisor, and every shard whatever changed. The merge queue is where the full suite gates a merge.
- **Required checks report on every PR and merge group.** Jobs are gated by a job-level `if:` on the `scope` job's
  outputs, never by a workflow-level path filter, so a skipped job still reports. `build-and-test` passes only if
  every part succeeded, or (a docs-only PR) every part was skipped. Required names: `build-and-test`,
  `SAST (CodeQL)`, `Secret scan (gitleaks)`, `Dependency audit (pnpm)`, `Image scan and SBOMs (Trivy)`,
  `ui enterprise / all` (the aggregate #734's review asked for).
- `cancel-in-progress` applies to `pull_request` runs only.
- Open source checked (ADR-0176): `dorny/paths-filter` (MIT) would do the diff, but ci.yml already refuses a
  third-party paths action in the CI path as a supply-chain surface; the decision is a `git diff` of the PR's merge
  commit in a 30-line composite action.
- Trade-off accepted: a PR can be green and still fail in the queue on a journey, demo or browser job it did not run.
  Any branch can run the full suite by `workflow_dispatch`. The push-to-main run repeats the merge group's run on the
  same tree; the owner asked for it, and it can be dropped if runner time binds again.

### PR trim (owner decision 2026-11-07, later the same day)

Measured on #604 after #734: a PR still ran about 37 check runs, which queue 15 to 20 minutes on the ~20-job pool.
The full suite on `merge_group`, a push to `main` and nightly is unchanged. On a `pull_request`:

- **ui enterprise:** Chromium only. Firefox, WebKit and the screenshot pack run on a full run. `ui enterprise / all`
  stays the one required check; it requires the browser matrix when `web` and the screenshot pack when `full`.
- **CodeQL:** only when code changed (`code`). Its job runs unless the scope said `'false'`, so a failed scope runs it.
- **Engine image scans and SBOMs, and the engine build-and-compare:** only when an engine input changed (`engines`:
  `engines/**`, any `Dockerfile`, the lockfile, the engine packages and scripts, the image workflows). **Trivy** for
  the root image only when its build context changed (`image`). Trivy fails closed like CodeQL. `security.yml` now runs
  nightly instead of weekly, so the scans keep a nightly full run.
- **Gateway shards and their coverage check, import cycles, the Kong integrations:** skipped on a PR whose code changes
  are all under `apps/web/**` (`gateway`). #604 at 2c3aa886 was not designer-only: it changed 13 files under
  `apps/gateway/src/` and two migrations, so `code` correctly chose the gateway; the over-inclusion was that a truly
  web-only PR also ran it, and `gateway` fixes that.
- **Fail closed:** unchanged. An unreadable diff, an empty diff and a change to the scope rules themselves are full runs.
  `build-and-test` judges the build against `code` and the gateway parts against `gateway`.
- The required check names do not change.


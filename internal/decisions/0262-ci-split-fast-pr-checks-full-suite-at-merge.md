# ADR-0262: Fast checks on a pull request, the full CI suite at merge time

- **Status**: Accepted (owner decisions of 2026-11-07: the CI split, then the PR trim; #738 Lane A asks for this ADR)
- **Date**: 2026-11-08
- **Index**: CI split: fast, scope-gated checks on a pull request; the full suite on the merge group, push to main and nightly
- **Built in**: #734 (the split and `.github/actions/ci-scope`), #737 (the PR trim, with its review fixes)
- **Supersedes**: the two addenda at the end of [ADR-0252](0252-merge-queue-and-merge-time-numbering.md), which record the same decisions as made on 2026-11-07
- **Migration**: none

## Context

The repository is public and on GitHub Free. Its hosted runner pool runs about 20 jobs at once. On 2026-11-07 a full
CI run was about 30 jobs, and a PR push about 37 check runs (measured on #604 after #734). So one PR's CI used the
whole pool, other PRs' runs queued for 15 to 20 minutes behind it, and at the peak over 200 runs were waiting.

The measured cost of the parts (ci.yml header, 16 green runs on 2026-10-10): `build-and-test-base` 2:50–4:24; each of
the four gateway shards 5:18–10:49; the coverage check under 30 s; a whole run 12:49–16:14 of wall clock and 81–94
billed minutes. `spa-journeys` (about 12.5 minutes) set the run's wall clock.

ADR-0252 puts `main` behind the GitHub merge queue. The queue runs a `merge_group` event on the combined result of the
queued PRs before anything reaches `main`. That gives a second place where the full suite can run, closer to the code
that actually merges than a PR's own run is.

Three GitHub rules shape any split:

1. **`merge_group` takes no path filter.** Every workflow that a required check comes from must run on every merge
   group, whatever changed.
2. **A required check must report on every PR and every merge group.** A workflow skipped by a workflow-level path
   filter does not report, so the PR waits forever. A job skipped by a job-level `if:` does report, as `skipped`.
3. **`skipped` satisfies a required check.** A required job that is skipped counts as passing, so a required check
   gated directly on a condition passes whenever the condition is false, including when the condition is wrong.

## Decision

**Fast, scope-gated checks on a `pull_request`; the full suite on `merge_group`, a push to `main`, the nightly
schedule and `workflow_dispatch`.**

### The scope

A `scope` job (`.github/actions/ci-scope`, `scripts/ci-scope.mjs`) reads the diff of GitHub's PR merge commit, with
renames off so a moved file counts at both paths. It writes these outputs, each `'true'` or `'false'`:

| Output | True when |
|---|---|
| `full` | not a `pull_request` (merge group, push, schedule, manual), or the scope fails closed (below) |
| `code` | any changed file is not documentation (`internal/**`, `docs/**`, `*.md`, `.gitignore`, `LICENSE`) |
| `web` | the web app, `packages/shared`, the workspace manifests, or the workflows and actions that run the web suites |
| `image` | the root Dockerfile's build context, `security.yml`, or the Trivy gate's own inputs (its allow-lists and the gate, runtime-contents, suppressions and cosign-verify scripts) |
| `engines` | an engine's own inputs: `engines/**`, any Dockerfile, the lockfile, the engine packages and scripts, the engine allow-lists and gate scripts, the image workflows. Not `packages/**` or `apps/**`, which each engine's shim stage also copies; a change there alone builds and compares the engines at merge time |

**Fail closed.** Every output is `true` (a full run) when the diff cannot be read, when it is empty, and when the PR
changes the scope rules themselves (the script, its test or the composite action). A required check gated directly on
the scope runs unless the scope said exactly `'false'` (`!cancelled() && needs.X.outputs.Y != 'false'`), so a scope
job that failed or wrote nothing runs it.

### What runs where

| Event | What runs |
|---|---|
| `pull_request`, code changed | build, typecheck, the package suites, the static pre-flights (migration guard, licence gate) and the four gateway shards with their coverage check, web-only PRs included (gateway tests read `apps/web` sources). CodeQL, gitleaks and the dependency audit. The UI tokens, baseline guard and bundle-size job. |
| `pull_request`, code outside `apps/web/**` changed | also `import-cycles.yml`, and `integrations.yml` when its paths match. Both are path-filtered and neither reads `apps/web`; neither is a required check. |
| `pull_request`, `web` | also the mocked SPA shards and the Chromium enterprise browser job |
| `pull_request`, `image` | also Trivy on the root image |
| `pull_request`, `engines` | also the engine image scans and SBOMs, and the engine build-and-compare |
| `pull_request`, docs only | every scope-gated job is skipped; `build-and-test` and `ui enterprise / all` still report. gitleaks and the dependency audit still run. |
| `pull_request`, the scope rules changed | everything, as a full run |
| `merge_group`, push to `main`, nightly, manual | everything: the above, plus the SPA journeys, the docker build, every SPA shard, Firefox, WebKit, the screenshot pack, every engine image scan, the demo journeys, gVisor and the engine build-and-compare. `security.yml` runs nightly (it was weekly). |

### Required checks

`build-and-test`, `SAST (CodeQL)`, `Secret scan (gitleaks)`, `Dependency audit (pnpm)`,
`Image scan and SBOMs (Trivy)` and `ui enterprise / all`. Each reports on every PR and every merge group:

- **The two aggregates** (`build-and-test`, `ui enterprise / all`) run with `if: ${{ !cancelled() }}`. They pass only
  when the scope job succeeded and each part either succeeded, or was skipped because its own scope output was
  `'false'`. A part that was skipped while its output was `'true'`, or that failed, fails the aggregate.
- **CodeQL and Trivy** are gated directly on `code` and `image`, with the fail-closed form above.
- **gitleaks and the dependency audit** are never trimmed.
- Never require a job that is gated by the scope directly, a path-filtered workflow (`import-cycles`, `integrations`,
  `endpoint-agent`, `engine-images-build`, `gvisor`, `demo`), or a workflow with no `merge_group` trigger.
- **Where it is set.** The repository records no branch protection, so this list lives in the GitHub setting
  (Settings → Rules → Rulesets, on `main`). On 2026-11-08 the builder read it through the API: `main` had no branch
  protection and no active ruleset, so nothing was required yet (the ruleset comes with the org move, in two steps per
  #738). Whoever changes the ruleset updates this list in the same change, and states the date it was read back.

### Other rules

- `cancel-in-progress` applies to `pull_request` runs only. Every other run has a concurrency group of its own
  (`github.run_id`), because GitHub cancels an older *pending* run in a shared group whatever `cancel-in-progress` says.
- Any branch can run the full suite with **Run workflow** (`workflow_dispatch`) on `ci.yml`, `ui-enterprise.yml`,
  `demo.yml` or `gvisor.yml`.
- A new job is gated on the scope outputs, never on a workflow-level path filter, and gets a case in
  `scripts/ci-scope.test.mjs`. The tests also read the workflow YAML and pin the gating expressions, so loosening a
  gate is a visible, reviewed edit.

### Measured effect

Check runs per PR push: about 37 before the trim; afterwards a docs-only PR about 7, a gateway-only PR about 19 and a
web-only PR about 23 (the web-only figure includes the gateway shards, which #737's review kept on). The target of 12
to 15 is not met: the largest remaining items are the five mocked SPA shards and the four gateway shards. A PR that
changes the scope rules runs the full set, by design (#737 ran 44 check runs).

## Alternatives considered

- **`dorny/paths-filter` (MIT)** for the diff. It does the job, but ci.yml already refuses a third-party paths action
  in the CI path as a supply-chain surface (ADR-0176 search recorded). The diff is a `git diff` of the PR's merge
  commit in a 30-line composite action with its own tests.
- **Workflow-level `paths:` filters.** Rejected for any workflow a required check comes from: a filtered-out workflow
  does not report, so the PR never merges (rule 2), and `merge_group` ignores the filter anyway (rule 1).
- **Run CI only on `ready_for_review`.** Rejected: agents open drafts, and a draft that never runs CI is a draft
  nobody can trust. Running the fast set only on drafts is a separate Lane A item.
- **Skip the gateway shards on a web-only PR.** Built in #737's first cut and taken out after its review: seven
  gateway tests read `apps/web` sources, one of them a security guard (`step-up-posture-guard.test.ts`). Moving those
  cross-tree tests into `build-and-test-base` would make that skip safe; it is a follow-up, not part of this decision.
- **Self-hosted runners.** The owner allows them only as ephemeral runners, later; this decision does not depend on
  them.

## Consequences

- PR CI no longer takes the whole pool, so several PRs' checks run at once.
- **A green PR is not the whole proof.** A PR can pass its own checks and still fail in the queue, on a job it did not
  run (a journey, the demo, a browser, gVisor, an engine build). The queue then drops it, and it is fixed on the branch
  like any red check. Until the owner turns the queue on, the push-to-`main` run is the only full run before nightly.
- The push-to-`main` run repeats the merge group's run on the same tree. The owner asked for it; it can be dropped if
  runner time binds again.
- The scope script is a security boundary: it decides whether CodeQL and Trivy run. A change to it is a full run, and
  #738 Lane A puts it under CODEOWNERS and the security workflow's WATCHED list.
- Follow-ups (#738 Lane A): `security / all` and `gateway import cycles / all` aggregates; drafts run the fast set
  only; build once and share `dist`; gateway shards 4 to 6 on tmpfs Postgres; delete the duplicate docker build;
  composite setup actions.

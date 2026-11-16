# ADR-0323: Each pull request runs only the suites its changes can affect

- **Status**: Accepted (owner decision 2026-11-15: "Trim CI per PR instead" of buying runners)
- **Date**: 2026-11-15
- **Index**: CI per-PR selection: web-only PRs skip the gateway DB shards; dependency, CI, schema and security-config changes run everything; a dry-run planner
- **Amends**: [ADR-0262](0262-ci-split-fast-pr-checks-full-suite-at-merge.md) (its rejected alternative "skip the gateway shards on a web-only PR" is now built, and its scope gains two rules)
- **Migration**: none

## Context

CI is the bottleneck: about 8 runs finish per hour against 40 to 200 queued. ADR-0262 already trims a PR's run by
scope (`code`, `web`, `image`, `engines`) and runs the full suite on `merge_group`, push to `main`, nightly and manual
runs. Two gaps remained:

1. **A web-only PR ran all five gateway shards and their coverage check** (measured on PR run 43666754137: 55
   runner-minutes, 9.0 to 12.6 minutes per shard, each with Postgres and an object store). ADR-0262 kept them because
   some gateway tests read `apps/web` sources (`step-up-posture-guard` walks every product source).
2. **A change that can reach any suite was trimmed by its path.** A lockfile bump ran no SPA journeys, Firefox, WebKit
   or docker build; a workflow, migration or security allow-list change was trimmed like ordinary code.

## Decision

**The scope (`scripts/ci-scope.mjs`) gains a `gateway` output and a full-run rule; a dry-run planner shows the result.**

### What a pull request runs

| Changed files | Scope | What runs on the PR |
|---|---|---|
| docs only (`internal/**`, `docs/**`, `*.md`, `.gitignore`, `LICENSE`) | all `false` | the scope jobs, `build-and-test` and `ui enterprise / all` (reporting), gitleaks, the dependency audit. 7 runners. |
| `apps/web/**` only (UI-only) | `code`, `web`, `image`; `gateway=false` | build and packages, **one** gateway runner (`web-readers`), the mocked SPA shards, the tokens/baseline/bundle-size guard, Chromium, CodeQL, Trivy. No gateway shards, no coverage check, no import cycles, integrations or client-compat. 19 runners. |
| gateway, packages or scripts | `code`, `gateway`, and `image`/`engines` as before | build and packages, the five gateway shards and their coverage check, the tokens guard, CodeQL, Trivy, and the path-filtered gateway workflows when their paths match. About 21 runners. |
| **any** dependency, CI, schema/migration or security-config file | `full` | everything a PR can start: also the SPA journeys, docker build, Firefox, WebKit, screenshots, every engine image. About 51 runners. |
| the scope rules (`scripts/ci-scope.mjs`, `scripts/ci-plan.mjs`, their test, `.github/actions/ci-scope`) | `full` | everything, as ADR-0262 |
| `merge_group`, push to `main`, nightly, manual | `full` | everything, unchanged (plus `demo.yml` and `gvisor.yml`, which never run on a PR) |

The full-run files (`ALL_RE`): `pnpm-lock.yaml`, `pnpm-workspace.yaml`, every `package.json`, `.npmrc`,
`.node-version`, `tsconfig.base.json`; `.github/workflows/**`, `.github/actions/**`, `.github/CODEOWNERS`,
`.github/dependabot.yml`; `packages/db/src/schema.ts`, `packages/db/migrations/**`, `packages/db/drizzle.config.ts`;
`security/**` and `.gitleaks.toml`. A Markdown file is documentation even under those paths.

### The web-only gateway runner

`gateway-tests` keeps its job-level `if: code == 'true'`. Its matrix is `["web-readers"]` only when the scope said
exactly `'false'` for `gateway`; any other value, an empty one included, gives the five shards (fail closed). The
`web-readers` runner has the same Postgres, object store and build as a shard and runs
`node scripts/ci-scope.mjs --gateway-web-readers`: every gateway test file that names the web app (`../../web`,
`apps/web`) or reads files and reaches the repository root (`../../..`, `"apps"`, `process.cwd()`, `git ls-files`).
The list is computed from the sources on every run, so it does not rot; it is deliberately broad (78 of 568 files on
2026-11-15) because a file wrongly included only costs time. An empty list fails the job. The coverage check runs
only when `gateway` is `'true'`, and `build-and-test` requires it to have succeeded then and been skipped otherwise.

### Required checks and the security gates

Unchanged from ADR-0262: `build-and-test`, `ui enterprise / all` (aggregates that run on every PR), `SAST (CodeQL)`
and `Image scan and SBOMs (Trivy)` (gated with `!= 'false'`), `Secret scan (gitleaks)` and `Dependency audit (pnpm)`
(never trimmed). Nothing here removes or loosens CodeQL, secret scanning, the dependency audit or Trivy; a
security-config change now runs more, not less.

### Superseded runs

Every workflow a PR starts cancels a superseded run of the same PR and only of a PR: its group is keyed on the PR
number, and on `github.run_id` for any other event. `client-compat.yml` was keyed on `github.ref` with
`cancel-in-progress: true`, which also cancelled a pending scheduled run on `main`; it now follows the pattern. A test
pins all nine workflows.

### The dry run

`node scripts/ci-plan.mjs <changed paths>` (or `--base origin/main`) evaluates the real workflow files: each job's
`if:`, the scope-dependent matrices, `needs` and the workflow-level path filters, for the scope those paths give. The
expressions are parsed and evaluated by GitHub's own library, `@actions/expressions` (MIT; #851 review finding 1), so
coercion and comparison follow GitHub. RegulAIt's part is only the context: the needs graph, the scope outputs read
through the action's declarations (an undeclared one is empty, as on GitHub), the path filters and the runner count.
A context the dry run does not model (for example `secrets`) fails to parse, which fails the dry run. `scripts/ci-scope.test.mjs` uses it to pin the selections for a docs-only, a UI-only,
a gateway-only and a lockfile change.

### Documentation that a check reads (#851 review finding 3, security review note)

Docs-only stays a skip, with one exception, the `base` output: a change to documentation that build-and-test-base's own
checks read runs that job (the build, package suites, scripts tests and licence gate; no database). That is the ADR
files and index (`internal/decisions/**`, read by `scripts/adr-index.test.mjs`), the merge-time fragments
(`internal/fragments/**`), `internal/product/PENDING.md`, and any `THIRD_PARTY.md` (the licence gate's tables).

**Known limit.** Other tests read documentation too: a few gateway tests read single ADRs or `docs/api` and
`docs/deployment` pages, and a `packages/shared` test scans `internal/product`. A changed-path match cannot tell those
apart (fixtures name most doc paths), so a docs-only PR touching them does not run them before merge. It runs them in
the full suite after merge (below).

### Where the full suite runs before or after a merge (#851 review finding 2)

Today it runs **after** a merge. The merge queue is not available to this repository yet: it needs an organisation
owner (M-113, #738), and on 2026-11-16 the reviewer read no branch protection and no ruleset on `main`. So a check a PR
did not run, whether from a trim or a detector miss, first runs on the push-to-`main` run of the merged tree, and
nightly. Once the repository moves to an organisation, a ruleset that requires the ADR-0262 checks plus the merge queue
makes it run before the merge. That is an owner setting and is not changed here.

### Open source first (ADR-0176)

`dorny/paths-filter` (MIT) was re-checked: it can classify paths, but it cannot express "every changed file is under
`apps/web/`" with the fail-closed defaults above any more simply than the existing 90-line script, and ADR-0262 already
records the decision not to add a third-party action to the scope path. Expression evaluation for the dry run uses
`@actions/expressions` (above; search record in `scripts/THIRD_PARTY.md`). Globs use node's built-in
`path.matchesGlob`.

## Consequences

- **Saved per typical PR** (durations from PR run 43666754137): a web-only PR drops four gateway shards and the
  coverage check, about 55 runner-minutes down to one runner of about 15 minutes (setup plus the subset, which ran in
  12.8 minutes against Postgres 16 on a dev container on 2026-11-15: 79 files, 1720 passed, 10 skipped), so about 40
  runner-minutes and 5 fewer runners. Wall clock is not shorter: the one runner takes about as long as a shard. A gateway or docs-only PR is unchanged.
- **More on dependency, CI, migration and security-config PRs.** A lockfile or migration PR now runs the full set, about
  51 runners instead of about 35. That is the owner's rule (a change that can reach any suite is tested by every
  suite); it is the largest cost to watch if Dependabot volume rises, and the place to look first if runner time binds
  again.
- A web-only PR can still break a gateway test that reads web files in a way the detector misses (for example a path
  built from variables the patterns do not see). That test still runs in the full suite on `main` after the merge, and
  nightly (see above: there is no merge queue yet).
- **A scope output must be declared by the composite action, and the aggregates refuse anything but `true`/`false`.**
  On #851 the new `gateway` output was written by the script but not declared in `.github/actions/ci-scope/action.yml`,
  so it read as `''`: the matrix fell back to five shards (fail-closed) but the coverage check was skipped on a full
  run and `build-and-test` accepted it (fail-open). Now `ok()` fails on any other value, the dry run reads outputs
  through the action's declarations, and a test pins that every output is declared.
- The rejected alternative "move cross-tree tests into `build-and-test-base`" is not needed: the subset runs on the
  same database setup as a shard, so DB-backed readers keep working.

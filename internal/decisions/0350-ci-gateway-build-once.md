# ADR-0350: Build the gateway once for CI test shards

- **Status**: Proposed
- **Date**: 2026-11-17
- **Related**: ADR-0262 (fast and full CI), ADR-0323 (scope-aware gateway tests), ADR-0176 (open source first)

## Context

The C1 CI lane removes repeated compilation before gateway tests. `build-and-test-base` already runs `pnpm -r build`,
including the gateway and every workspace dependency. Each of the five gateway shard runners then repeats the gateway
and dependency build. Web-only PRs use one gateway runner for tests that read web sources; this selector and all
existing test, coverage and aggregate gates must survive the change.

## Open-source comparison, before implementation

Two maintained MIT-licensed official GitHub Actions approaches were compared using their GitHub repository metadata
and README APIs on 2026-11-17:

- [actions/upload-artifact](https://github.com/actions/upload-artifact/tree/cf430e030ddbb5b0abf93d22962f4752f3646cd9)
  with [actions/download-artifact](https://github.com/actions/download-artifact/tree/9000827ccba6bdab643e8b6fd33ac0654aef8333).
  An upload returns its unique artifact ID; a download can select exactly that ID from its current workflow run,
  without a repository token or another run identifier. A single ID extracts directly into the requested path,
  as documented at the pinned download revision. The workflow already uses these exact-pinned actions for shard
  reports. Chosen: this is a producer-to-consumer handoff within one run.
- [actions/cache](https://github.com/actions/cache/tree/3edfce9056124e459a23f683a21433670d47daca).
  Its documented scope is key, version and branch; the default branch cache is available to other branches, and
  `restore-keys` permit stale prefix matches. It is useful for dependency downloads, whose existing pnpm cache stays
  unchanged. It is not chosen for executable build outputs: a miss would require another compiler path, and accepting
  prior runs would add freshness and trust policy that this handoff does not need.

The upload repository metadata reported a 2026-10-07 push; the cache repository a 2026-07-15 push. The API commands
were `gh api repos/actions/<name>/readme`, `gh api repos/actions/<name>` and the commit endpoint. Comparison notes and
source captures were written before editing the workflow. No new dependency or action revision is introduced.

## Decision

1. **Reuse the existing base build.** Immediately after its successful `pnpm -r build`, the base job packages
   `apps/gateway/dist` and every existing `packages/*/dist` into one gzip tar. These are the built gateway entrypoints
   (including seed helpers) and workspace exports the tests import. The artifact contains no dependency store,
   `node_modules`, database, credential file or application state. Tar preserves the build's paths and modes.
2. **Pass a specific artifact, not a cache key.** The base uploads it under a run/attempt-specific name, with one-day
   retention and no second compression pass. It exposes the upload's artifact ID, the tar's SHA-256 and its producer
   attempt as job outputs. Gateway runners need both scope and the successful base job. They reject an empty or
   non-numeric ID before invoking the pinned download action. They provide only that ID and a destination: no name
   pattern, cache fallback, token, repository or alternate run.
3. **Verify before extraction.** A runner checks the tar against the producer job's SHA-256 output and compares the
   manifest exactly with its current run ID, producer attempt, checked-out `git HEAD`, SHA-256 of `pnpm-lock.yaml`,
   Node version, operating system and architecture. Missing fields, changed content, source, lockfile or runtime fail
   before extraction. The action's own transfer checks do not replace this explicit failing checksum step.
4. **Retry semantics.** A failed shard retried within the same run can use its successful producer's original attempt,
   bound through that job's output. It still requires identical source, lockfile and runtime. A different run cannot
   supply the handoff, and an absent artifact is a failure, never a rebuild or a stale restore.
5. **Keep all checks.** The five-way matrix, the exact-false web-only selector, both gateway test invocations,
   per-shard reports and uniqueness pre-flight, exact-once coverage, required `build-and-test` aggregate, permissions,
   timeouts and action pins stay intact. A failed producer skips the dependent shards and the existing aggregate
   fails; docs-only scope still permits only its explicitly scoped skips.

## Consequences and validation

- The gateway compiler runs once in the build-and-test family, on the existing base runner. No additional runner is
  added. There is no change to unrelated full builds in other workflow jobs.
- Gateway tests now wait for the base job's package tests and static checks, not just its build. This is the scheduling
  tradeoff for reusing the existing compiler instead of adding a dedicated producer and building the gateway again in
  the base job. Runner timings must be measured; local archive tests establish correctness, not a wall-time saving.
- `.node-version` currently names a Node major. A rollout resolving it differently between producer and consumer fails
  closed. An intentional runtime change needs a new successful producer; a test runner never silently accepts it.
- `scripts/ci-gateway-build-once.test.mjs` executes the workflow's actual pack and restore shell steps against temporary
  Git workspaces. It proves restored gateway/package exports, rejection of wrong run, producer attempt, source,
  lockfile, runtime, corrupt archive and missing digest, exact-ID refusal, and same-run failed-shard retry. Existing
  CI-scope tests continue to exercise web-only/full/docs selection and the required aggregate.
- Hosted artifact upload/download and runner timings are validated only by hosted CI runs; they are not represented
  as locally exercised. The root builder report records exact command outcomes and timing evidence separately.

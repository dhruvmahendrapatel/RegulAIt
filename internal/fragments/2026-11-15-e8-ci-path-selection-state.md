<!-- fold: state-recap -->
**2026-11-15, E8 CI per-PR selection ([ADR-0323](../decisions/0323-ci-per-pr-path-selection.md), owner "Trim CI per PR instead").**
A web-only PR runs one gateway runner with only the tests that read `apps/web` sources (computed from the sources)
instead of five DB shards and the coverage check, about 43 runner-minutes saved. A dependency, workflow,
schema/migration or security-config change is now a full run on the PR. `client-compat.yml` cancels superseded PR runs
only. `node scripts/ci-plan.mjs` is a dry run of the job selection, pinned by tests for docs-only, UI-only,
gateway-only and lockfile changes. No migration.

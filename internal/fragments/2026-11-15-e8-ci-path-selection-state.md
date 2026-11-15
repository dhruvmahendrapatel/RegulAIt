<!-- fold: state-recap -->
**2026-11-15, E8 CI per-PR selection ([ADR-0323](../decisions/0323-ci-per-pr-path-selection.md), owner "Trim CI per PR instead").**
A web-only PR runs one gateway runner with only the tests that read `apps/web` sources (computed from the sources)
instead of five DB shards and the coverage check, about 43 runner-minutes saved. A dependency, workflow,
schema/migration or security-config change is now a full run on the PR. `client-compat.yml` cancels superseded PR runs
only. `node scripts/ci-plan.mjs` is a dry run of the job selection, pinned by tests for docs-only, UI-only,
gateway-only and lockfile changes. No migration. Found in review of its own green run: the
composite action had not declared the new `gateway` output, which read as empty and let the coverage check skip on a
full run; the action now declares it and both aggregates fail on any output other than `true`/`false`. Rule for
the master's ledger: a new composite-action output is declared in `action.yml` and pinned by a test, and an aggregate
never treats "not true" as "skip allowed". The agent-builder journey's TOTP step-up tests got the 120 s budget their
siblings have (the `spa-journeys` failure on #851).

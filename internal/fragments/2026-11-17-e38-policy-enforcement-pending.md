<!-- fold: pending -->

- **Enforce the effective policy at call time (ADR-0357 §4, lane E38 follow-up).** `effectivePolicyAt(db, level, id)`
  (`apps/gateway/src/governance-policy.ts`) gives the effective org → business unit → project → use case policy, but no
  call path reads it yet. Wire it into the governed decision core (ADR-0251), keyed by the call's attributed project or
  use case:
  - `allowedAgents`, `allowedConnectors` and `allowedMcpServers` deny outside the list;
  - `deniedTools` denies;
  - `maxCallsPerHour` is a rate limit;
  - `maxBudgetUsd` caps a project budget write;
  - `auditRetentionDays` and `minApprovers` are floors on retention and on sign-off;
  - `requireHumanSignoff` and `requirePlanGate` are workflow-assignment checks;
  - `maxDataSensitivity` and `piiMode` feed the data-scope and PII paths.

  The decision core belongs to its own lane, so this lane did not change it. Also open: policy layers as a section of
  the governance-config document.

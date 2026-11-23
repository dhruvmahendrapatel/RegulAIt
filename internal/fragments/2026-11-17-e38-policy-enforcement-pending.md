<!-- fold: pending -->

- **Enforce the effective policy at call time (ADR-0357 §4, lane E38 follow-up).** `effectivePolicyAt(db, level, id)`
  (`apps/gateway/src/governance-policy.ts`) gives the effective org → business unit → project → use case policy, but no
  call path reads it yet. Wire it into the governed decision core (ADR-0251), keyed by the call's attributed project or
  use case:
  - done 2026-11-23 (lane L1, ADR-0357 "Enforcement at call time"): `allowedAgents`, `allowedConnectors` and
    `allowedMcpServers` deny outside the list, and `deniedTools` denies, on every governed call, failing closed;
  - `maxCallsPerHour` is a rate limit;
  - `maxBudgetUsd` caps a project budget write;
  - `auditRetentionDays` and `minApprovers` are floors on retention and on sign-off;
  - `requireHumanSignoff` and `requirePlanGate` are workflow-assignment checks;
  - `maxDataSensitivity` and `piiMode` feed the data-scope and PII paths.

  The decision core belongs to its own lane, so this lane did not change it. Also open: policy layers as a section of
  the governance-config document.

  `POLICY_ENFORCEMENT` is now per rule (the four above `enforced`); flip each remaining rule when it lands. Until then it tells every layer and effective-policy
  response that stored rules are not applied at call time (review R2 B1 on #984). Two review notes from S4 on #984
  belong to that slice:
  - done 2026-11-23: the call path reads under the `governance_policy_read` reason and fails closed when the reason
    did not take effect;
  - re-parenting outside this module (a use case's `project_id` changed through the use-case routes, or a unit deleted
    directly) changes the effective policy without the move's loosening check; route it through `effectiveLoosening`.

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

  When this lands, flip `POLICY_ENFORCEMENT` in the same file. Until then it tells every layer and effective-policy
  response that stored rules are not applied at call time (review R2 B1 on #984). Two review notes from S4 on #984
  belong to that slice:
  - the layer tables are admin-only under FORCE RLS, so a non-admin call path needs a system reason or a definer
    read, and must fail closed when the read returns nothing (an empty read is a looser policy);
  - re-parenting outside this module (a use case's `project_id` changed through the use-case routes, or a unit deleted
    directly) changes the effective policy without the move's loosening check; route it through `effectiveLoosening`.

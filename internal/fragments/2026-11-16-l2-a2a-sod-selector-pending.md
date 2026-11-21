<!-- fold: pending -->
- **SoD rules cannot name a remote (A2A) agent yet** (lane L2, from the PR #810 review). The A2A grant mints call
  `refuseSodMint` with the mint kinds `a2a` and `role_a2a`, but `selectorSchema.kind` in `apps/gateway/src/sod.ts` covers
  only `agent`, `connector`, `mcp_tool` and `mcp_server`. So `mintFootprint` gives these mints no capability that a rule
  can match, and no SoD rule can separate a remote agent from another capability. Adding an `a2a_agent` selector kind
  needs four things: the selector schema and DB enum, `resolveSelectorObjects`, `holdersOfSelector` (direct A2A grants plus
  role grants, less revocations) and the two `mintFootprint` cases. ADR-0219 amendment of 2026-11-14.

<!-- fold: state-recap -->

**2026-11-17 - lane E38 slice 1a: governance configuration as code, export and dry-run plan ([ADR-0357](../decisions/0357-governance-config-as-code-and-policy-inheritance.md), branch `builder/e38-governance-config-as-code`).**
- **Built:** one versioned document (`apiVersion: regulait.io/governance/v1`, `kind: GovernanceConfig`) holding roles
  and their grants, role/team/fleet rate limits, MCP bundles, workflow templates and project budgets, by name, never a
  secret. The strict schema, normal form and the plan's widens/narrows/neutral classification are in
  `@regulait/shared` (`governance-config.ts`); `GET /v1/governance-config/schema`, `GET …/export` (YAML or JSON) and
  `POST …/plan` (the dry run: resolve names, diff, classify, `planHash`; writes nothing; YAML anchors refused) are in
  `apps/gateway/src/governance-config.ts`. Audited under the new `governance_config` object type. No migration.
- **Next:** slice 1b (apply: all-or-nothing, bound to the `planHash`, the `governance_apply` step-up, widenings through
  `settings_relax`); slice 2 (business units, tighten-only policy layers, the merge table, the effective-policy view).

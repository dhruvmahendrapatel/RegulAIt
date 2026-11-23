<!-- fold: state-recap -->

**2026-11-17 - lane E38 slice 1b: governance config apply ([ADR-0357](../decisions/0357-governance-config-as-code-and-policy-inheritance.md), branch `builder/e38-governance-apply`).**
`POST /v1/governance-config/apply` re-plans the document, refuses a `planHash` that is not this plan (409
`plan_stale`), asks a `settings_relax` step-up bound to `{op, planHash, widenings}`, then writes roles, rate limits and
budgets in one transaction under an advisory lock, re-planning inside it (409 `changed_concurrently` if anything
moved). It reuses the UI's writers: the role lock and SoD mint check, `applyRuleEdit` / `deleteRuleArtifact` for
versioned rate limits (read as enforced), and `applyProjectPatch`. A held role, or one whose deletion moves approvers,
is a plan issue. MCP bundles and workflow templates follow in slice 1c. No migration.

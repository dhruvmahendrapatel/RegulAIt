<!-- fold: state-recap -->

**2026-11-17 - lane E38 slice 1c: governance config apply for MCP bundles and workflow templates ([ADR-0357](../decisions/0357-governance-config-as-code-and-policy-inheritance.md), branch `builder/e38-governance-apply-bundles-templates`).**
Apply now writes every section. Bundles go through their own versioned store: a change of tools is a new
`mcp_bundle_versions` row, the ADR-0091 bundle SoD gate runs for added tools and new holders, and a bundle missing from
the file is archived. Templates use the create path's validation, and a definition change records a new
`workflow_template_versions` row with origin `governance_apply` (pending migration
`workflow_template_version_origin_apply`). A missing template is retired through `retireWorkflowTemplateLocked`, the
core now shared with the retire route. Bundles while off, un-archive, un-retire, intake templates and a dangerous tier
with no approver are plan issues.

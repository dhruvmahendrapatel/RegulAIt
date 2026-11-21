# Route coverage — 2026-11-21

All entries are automated state/layout coverage unless deeper feedback is explicitly named. Generic mock errors do not establish a populated workflow.

| Route | Session fixture | Axe light/dark | Layout768–1920 | Error/loading | Deeper page feedback |
| --- | --- | --- | --- | --- | --- |
| `/login` | public | checked | checked | public: not tested | full task/roles pending |
| `/f/:token` | public | checked | checked | public: not tested | full task/roles pending |
| `/trust` | public | checked | checked | public: not tested | full task/roles pending |
| `/audit` | public | checked | checked | public: not tested | full task/roles pending |
| `/supplier` | public | checked | checked | public: not tested | full task/roles pending |
| `/` | signed-in | checked | checked | checked | full task/roles pending |
| `/chat` | signed-in | checked | checked | checked | UIW-03; source pass |
| `/models` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder` | signed-in | checked | checked | checked | UIW-01/02; chat mock probes (editor source only) |
| `/builder/inbox` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/agents` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/agents/:agentId` | signed-in | checked | checked | checked | UIW-01/02; chat mock probes (editor source only) |
| `/builder/templates` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/templates/:templateId` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/integrations` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/skills` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/usage` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/prompts` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/prompts/:promptId` | signed-in | checked | checked | checked | full task/roles pending |
| `/builder/playground` | signed-in | checked | checked | known missing error alert | full task/roles pending |
| `/runs` | signed-in | checked | checked | checked | UIS-06; source pass |
| `/runs/:runId` | signed-in | checked | checked | checked | full task/roles pending |
| `/workflows` | signed-in | checked | checked | checked | full task/roles pending |
| `/workflows/:instanceId` | signed-in | checked | checked | checked | UIW-07/08; check matching detail component |
| `/inbox` | signed-in | checked | checked | checked | UIW-06; source pass |
| `/inbox/annotations/:itemId` | signed-in | checked | checked | checked | full task/roles pending |
| `/projects` | signed-in | checked | checked | checked | full task/roles pending |
| `/projects/:projectId` | signed-in | checked | checked | checked | full task/roles pending |
| `/projects/:projectId/context` | signed-in | checked | checked | checked | UIW-04/05; source pass |
| `/projects/:projectId/context/graph` | signed-in | checked | checked | checked | full task/roles pending |
| `/context` | signed-in | checked | checked | checked | full task/roles pending |
| `/spend` | signed-in | checked | checked | checked | full task/roles pending |
| `/account` | signed-in | checked | checked | checked | full task/roles pending |
| `/account/sessions` | signed-in | checked | checked | checked | full task/roles pending |
| `/account/passkeys` | signed-in | checked | checked | checked | full task/roles pending |
| `/incidents` | signed-in | checked | checked | checked | full task/roles pending |
| `/incidents/:incidentId` | signed-in | checked | checked | checked | full task/roles pending |
| `/feedback` | signed-in | checked | checked | checked | full task/roles pending |
| `/feedback/:useCaseId` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/use-cases/:id` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/users` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/roles` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/teams` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/client-access` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/sso` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/sso/link-requests` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/provisioning` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/group-mappings` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/virtual-keys` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/credentials` | signed-in | checked | checked | checked | CXR-ADM-007/008; source pass |
| `/admin/agent-credentials` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workload-identities` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workload-identities/identities` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workload-identities/:identityId/proposals` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/rules` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/simulation` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/abac-policies` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/guardrails` | signed-in | checked | checked | checked | CXR-ADM-003–006; sample mock probe |
| `/admin/content-trust` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/model-policy` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/evals` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/annotation-queues` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/model-risk` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/model-risk/fairness` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/use-cases` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/intake` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/review-policy` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/trust` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/alerts` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/graph` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/regulatory` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/regulatory/sources` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/decision-regression` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/literacy` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/vendors` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/vendors/questionnaires` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/risks` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/inventory` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/certification` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/recommendations` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/sod` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/posture` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/redteam` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/reports` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/prompt-versions` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/approvals` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/review-workbench` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/audit` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/lineage` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/traces` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/monitoring` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/regulait-llm` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/shadow-ai` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/shadow-ai/discovery-sources` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/shadow-ai/discovery-sources/runs` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/shadow-ai/discovery-sources/tokens` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/shadow-ai/discovery-sources/devices` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/copilot` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/chatops` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/chatops/identity-links` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workflow-templates` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/agents` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/agents/catalog` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/agents/stewardship` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/model-credentials` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/custom-providers` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/external-scorers` | signed-in | checked | checked | checked | CXR-ADM-001/002; populated mock probe |
| `/admin/connectors` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/mcp-servers` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/mcp-servers/registries/:registryId/entries` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/mcp-servers/bundles` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/mcp-servers/bundles/:bundleId` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/webhooks` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/siem` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/admission` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/git-connections` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/pm-connections` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/deploy-targets` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/engines` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/engines/placements` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/engines/executors/:executorId/attestations` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/cost` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/cost-consolidation` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/cost-consolidation/imports` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/cost-consolidation/imports/:importId` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/spend-monitor` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/billing` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/optimization` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/compliance` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/compliance-packs` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/compliance-packs/imports` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/trust-publishing` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/infrastructure` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/infrastructure/resources` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/infrastructure/findings` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/infrastructure/certificates` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/infrastructure/patches` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/infrastructure/backups` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/privacy` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/privacy/requests` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/organization` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/retention` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/licensing` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/licensing/verifications` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/data-key` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/scheduler` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/enforcement-posture` | signed-in | checked | checked | checked | CXR-ADM-009; source pass |
| `/admin/execution` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/setup` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/first-run` | signed-in | checked | checked | checked | full task/roles pending |

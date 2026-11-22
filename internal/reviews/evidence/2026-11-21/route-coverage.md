# Route coverage — initial 2026-11-21 run, updated 2026-11-22

The initial 150 routes below have the dated automatic state/layout coverage. Main 267e12e4951d14c3f71531f3eeba9ffb4eb63022 adds the 151st route, marked separately; this round does not rerun the full generic matrix. Generic mock errors do not establish a populated workflow.

| Route | Session fixture | Axe light/dark | Layout768–1920 | Error/loading | Deeper page feedback |
| --- | --- | --- | --- | --- | --- |
| `/login` | public | checked | checked | public: not tested | ACC-002/005 source; API authentication separately tested, login UI pending |
| `/f/:token` | public | checked | checked | public: not tested | full task/roles pending |
| `/trust` | public | checked | checked | public: not tested | full task/roles pending |
| `/audit` | public | checked | checked | public: not tested | full task/roles pending |
| `/supplier` | public | checked | checked | public: not tested | full task/roles pending |
| `/` | signed-in | checked | checked | checked | CXR-HME-001 Home headline mock-browser375/1440; UXP-001 task proposal; other populated Home flows pending |
| `/chat` | signed-in | checked | checked | checked | UIW-03 source +503/404 mock-browser; no deletion sent |
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
| `/workflows` | signed-in | checked | checked | checked | CXR-WFL-002 mock-browser +pure matcher/source; UIW-08 detail actions separate |
| `/workflows/:instanceId` | signed-in | checked | checked | checked | CXR-WFL-001/003 mock-browser +source; UIW-07/08 source; real recovery pending |
| `/inbox` | signed-in | checked | checked | checked | UIW-06 source; CXR-APR-002 source outcome consumer; runtime pending |
| `/inbox/annotations/:itemId` | signed-in | checked | checked | checked | full task/roles pending |
| `/projects` | signed-in | checked | checked | checked | Real gateway: admin create201; viewer member-scoped list/create403 |
| `/projects/:projectId` | signed-in | checked | checked | checked | CXR-CST-002 source budget consumer; runtime pending |
| `/projects/:projectId/context` | signed-in | checked | checked | checked | UIW-04/05 mock probes; real viewer read200/write403, content expanded |
| `/projects/:projectId/context/graph` | signed-in | checked | checked | checked | full task/roles pending |
| `/context` | signed-in | checked | checked | checked | full task/roles pending |
| `/spend` | signed-in | checked | checked | checked | full task/roles pending |
| `/account` | signed-in | checked | checked | checked | ACC-004 source; factor-replacement runtime pending |
| `/account/sessions` | signed-in | checked | checked | checked | Source status/revoke flow; device/session races pending |
| `/account/passkeys` | signed-in | checked | checked | checked | Source enrollment/revoke flow; real authenticator pending |
| `/incidents` | signed-in | checked | checked | checked | full task/roles pending |
| `/incidents/:incidentId` | signed-in | checked | checked | checked | full task/roles pending |
| `/feedback` | signed-in | checked | checked | checked | full task/roles pending |
| `/feedback/:useCaseId` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/governance/use-cases/:id` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/users` | signed-in | checked | checked | checked | CXR-IDM-003 both count consumers mock-browser; lifecycle/override source; real ceremonies pending |
| `/admin/roles` | signed-in | checked | checked | checked | CXR-IDM-001/002 mock-browser +source; group sync and proof completion pending |
| `/admin/teams` | signed-in | checked | checked | checked | Source create/membership/classification/delete; populated runtime and full server gates pending |
| `/admin/client-access` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/sso` | signed-in | checked | checked | checked | CXR-SSO-002 stale policy mock-browser;003 maintenance source; provider/assurance runtime pending |
| `/admin/sso/link-requests` | signed-in | checked | checked | checked | CXR-SSO-004 first-voter/self eligibility mock-browser; real linkage pending |
| `/admin/provisioning` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/group-mappings` | signed-in | checked | checked | checked | CXR-SSO-001 conditional proof refusal mock-browser; actual sync/proof completion pending |
| `/admin/virtual-keys` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/credentials` | signed-in | checked | checked | checked | CXR-ADM-007/008 source; real viewer API403 and explained UI denial |
| `/admin/agent-credentials` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workload-identities` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workload-identities/identities` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/workload-identities/:identityId/proposals` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/rules` | signed-in | checked | checked | checked | ACC-003 mock-browser + source; no policy mutation sent |
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
| `/admin/risks` | signed-in | checked | checked | checked | REV-003 source scale cap; REV-004 mock-browser draft scoping |
| `/admin/inventory` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/certification` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/recommendations` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/sod` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/posture` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/redteam` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/reports` | signed-in | checked | checked | checked | REV-001/002/005 mock-browser + source; destructive request refused |
| `/admin/prompt-versions` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/approvals` | signed-in | checked | checked | checked | CXR-APR-001/002 admin mock-browser +source;003 source paging gap |
| `/admin/review-workbench` | signed-in | checked | checked | checked | CXR-WBK-001..005 source +mock-browser; real bulk/scheduler/claims pending |
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
| `/admin/workflow-templates` | signed-in | checked | checked | checked | CXR-WFL-004 mock-browser +source; gallery/intake preview source; all stage variants pending |
| `/admin/agents` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/agents/catalog` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/agents/stewardship` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/model-credentials` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/custom-providers` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/external-scorers` | signed-in | checked | checked | checked | CXR-ADM-001/002; populated mock probe |
| `/admin/connectors` | signed-in | checked | checked | checked | CXR-INT-001..005 source +mock-browser (connector consumers); real providers/races pending |
| `/admin/mcp-servers` | signed-in | checked | checked | checked | CXR-INT-001/005 source; MCP runtime and registry/bundle internals pending |
| `/admin/mcp-servers/registries/:registryId/entries` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/mcp-servers/bundles` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/mcp-servers/bundles/:bundleId` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/webhooks` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/siem` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/admission` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/git-connections` | signed-in | checked | checked | checked | CXR-CON-001/002 mock-browser +source/compiled contracts; real credentials/provider pending |
| `/admin/pm-connections` | signed-in | checked | checked | checked | CXR-CON-001/003/004 mock-browser +source/contracts; real webhook delivery pending |
| `/admin/deploy-targets` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/engines` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/engines/placements` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/engines/executors/:executorId/attestations` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/cost` | signed-in | checked | checked | checked | CXR-CST-001/002 source +mock-browser; broader charts/roles pending |
| `/admin/cost-consolidation` | signed-in | checked | checked | checked | CXR-CST-003..005 source;003 alias mock-browser; dates/removal runtime pending |
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
| `/admin/execution` | signed-in | checked | checked | checked | ACC-001 step-up options503 mock-browser; no successful resume |
| `/admin/setup` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/first-run` | signed-in | checked | checked | checked | full task/roles pending |
| `/admin/connectors/catalogue` | signed-in | feature-specific axe checks passed | generic matrix pending | feature tests passed | New main feature: 12-test catalogue/ingest batch; full task/role/mobile audit pending |

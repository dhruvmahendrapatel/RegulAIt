#!/usr/bin/env node
/**
 * THE ROUTE CENSUS — every built capability has UI, or says why not.
 *
 * `preflight-ui-affordances.mjs` asks two narrow questions (can every DELETE be
 * reached from a screen; is there a list with no add). This asks the general
 * one, for EVERY verb: each route the gateway serves is either
 *
 *   (a) called by the web SPA (apps/web/src), matched the same way the
 *       affordance census matches (the shared matcher, `uiCalls`), or
 *   (b) on one of the reasoned lists below:
 *         MACHINE_ONLY     by design no human screen calls it (pattern entries
 *                          per category, each with a reason a reviewer can check)
 *         SUPERSEDED       an older route whose job a newer route the UI DOES
 *                          call now does (the replacement is named and checked)
 *         INDIRECT_UI_CALLS the UI calls it through a path held in state or
 *                          sent by the server, which no static scan can follow
 *                          (the evidence text is named and checked)
 *         KNOWN_UI_GAPS    TEMPORARY: a real capability with no screen yet.
 *                          Printed loudly on every run; the count is pinned and
 *                          may only go DOWN (KNOWN_UI_GAPS_MAX, and a test).
 *   or (c) still a 501 `notBuilt` stub (it does nothing, so it needs no screen).
 *
 * THE ROUTE LIST is `ROUTE_STABILITY` in apps/gateway/src/openapi-registry.ts:
 * one key per registered route, which `openapi.test.ts` already holds equal to
 * the LIVE Fastify inventory in both directions. So constants-based and scoped
 * registrations (`scope.post(OAUTH_TOKEN_PATH, …)`, `${EXECUTOR_CHANNEL_PREFIX}/…`)
 * are covered without re-parsing them here, and this census cannot drift from
 * what the gateway serves without that suite going red first.
 *
 * LISTS CANNOT ROT. An entry that names no route, a pattern that covers a
 * route the UI calls, a superseded route whose replacement the UI does not
 * call, an indirect call whose evidence is gone, or a known gap that now has a
 * screen, each FAILS the run. Deleting the entry is the fix.
 *
 * Exit 0 clean, 1 on a gap or a stale entry, 2 if it could not run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { literalPathsIn, norm, scanNotBuilt, scanWeb, segmentMatch } from "./preflight-ui-affordances.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * MACHINE-ONLY BY DESIGN. Keys are `"VERB /path"` (the registry's spelling),
 * with a one-line reason. A PATTERN (VERB may be `*`; a path ending in `/*`
 * covers everything under that prefix) is used only for a credentialed
 * machine surface, has a literal collection (never `/v1/*`, `/*` or
 * `/v1/:x/*`; see validatePattern), and pins how many routes it covers as
 * `{ reason, matches }`: a new route under the prefix changes the count and
 * fails the run, so it cannot hide there.
 */
export const MACHINE_ONLY = new Map([
  // ---- the SPA shell, health and API docs --------------------------------
  ["GET /", "shell: redirects a browser to the SPA; the SPA is what it serves"],
  ["GET /admin", "shell: legacy admin entry point, redirects into the SPA"],
  ["GET /app", "shell: legacy app entry point, redirects into the SPA"],
  ["GET /ui", "shell: serves the SPA's index.html (the page itself, not a call it makes)"],
  ["GET /ui/*", { reason: "shell: serves the SPA's static assets and deep links", matches: 1 }],
  ["GET /health", "health: the load balancer / container liveness probe"],
  ["GET /ready", "readiness: the orchestrator readiness probe; 503 while draining or degraded (ADR-0343)"],
  ["GET /v1/openapi.json", "docs: the published OpenAPI document (ADR-0053), read by SDK generators"],
  ["GET /v1/api/versioning", "docs: the published versioning/deprecation policy (ADR-0053), read by API clients"],

  // ---- auth plumbing: browser redirects, IdP callbacks, token endpoints ----
  ["GET /auth/oidc/:providerId/start", "auth plumbing: the OIDC redirect to the IdP (the sign-in page links /login, which leads here)"],
  ["GET /auth/oidc/callback", "auth plumbing: the IdP's redirect back with the authorization code"],
  ["GET /auth/oidc/providers", "auth plumbing: public OIDC discovery; the sign-in page reads /auth/sign-in-options"],
  ["GET /auth/saml/:providerId/start", "auth plumbing: the SAML redirect to the IdP"],
  ["POST /auth/saml/:providerId/acs", "auth plumbing: the IdP's POST-back (assertion consumer service)"],
  ["GET /auth/saml/:providerId/metadata", "auth plumbing: SP metadata the IdP admin downloads (the SSO page shows its URL)"],
  ["GET /auth/saml/providers", "auth plumbing: public SAML discovery; the sign-in page reads /auth/sign-in-options"],
  ["GET /.well-known/oauth-protected-resource", "auth plumbing: RFC 9728 protected-resource metadata, fetched by MCP/OAuth clients"],
  ["GET /.well-known/oauth-protected-resource/mcp/:serverId", "auth plumbing: RFC 9728 metadata for one MCP server, fetched by MCP clients"],
  ["GET /.well-known/jwks.json", "auth plumbing: the issuer's public JWKS, fetched by relying parties"],
  ["GET /federation/.well-known/openid-configuration", "auth plumbing: the cloud federation issuer's OIDC discovery document, fetched by AWS, GCP and Entra"],
  ["GET /federation/.well-known/jwks.json", "auth plumbing: the cloud federation issuer's RS256 JWKS, fetched by AWS, GCP and Entra"],
  ["GET /mcp-identity/.well-known/openid-configuration", "auth plumbing: the OIDC-profile MCP identity assertion issuer's discovery document, fetched by an upstream's validator (ADR-0210)"],
  ["GET /mcp-identity/.well-known/jwks.json", "auth plumbing: the OIDC-profile MCP identity assertion issuer's ES256 JWKS, fetched by an upstream's validator (ADR-0210)"],
  ["POST /oauth/token", "auth plumbing: RFC 6749 token endpoint for workload clients"],
  ["POST /oauth/token/revocation", "auth plumbing: RFC 7009 token revocation for workload clients"],
  ["POST /oauth/token/introspection", "auth plumbing: RFC 7662 token introspection for resource servers"],
  ["POST /v1/delegations/proofs", "auth plumbing: an agent proves a delegation chain (ADR-0188); called by agent runtimes"],

  // ---- public verification: keys an outside verifier needs -------------------
  ["GET /v1/exports/signing-key", "public verification: the public key a third party checks a signed export bundle with"],

  // ---- the data plane: what the gateway proxies and governs -------------------
  ["POST /v1/chat/completions", "data plane: OpenAI-compatible proxy (ADR-0020); called by vendor SDKs, governed per call"],
  ["POST /v1/responses", "data plane: OpenAI Responses-compatible proxy (ADR-0287); called by vendor SDKs, governed per call"],
  ["POST /v1/messages", "data plane: Anthropic-compatible proxy (ADR-0024); called by vendor SDKs, governed per call"],
  ["GET /v1/models", "data plane: OpenAI-compatible model list for vendor SDKs"],
  ["POST /mcp/:serverId", "data plane: the governed MCP proxy endpoint MCP clients connect to"],
  ["GET /mcp/:serverId", "protocol plumbing: the Streamable HTTP SSE probe MCP clients send after initialize; answers 405 Allow: POST"],
  ["GET /v1/prompts/resolve", "data plane: runtimes and SDKs resolve a prompt@tag reference at call time"],
  ["POST /v1/connectors/:connectorId/invoke", "data plane: an agent runtime invokes a connector through the governance gate"],
  ["POST /v1/a2a/agents/:agentId/messages", "data plane: a person's client or a worker calls a remote A2A agent through the governance gate (ADR-0219)"],
  ["POST /v1/authz/check", "data plane: the policy decision point external enforcement points call (ADR-0053)"],

  // ---- the CI gate ----------------------------------------------------------
  ["POST /v1/gates/deploy", "CI gate: the deploy gate a customer's pipeline calls before it ships"],

  // ---- runner and executor channels (credentialed machines) ----------------
  ["* /v1/engine-runner/*", { reason: "runner channel: only an engine runner credential reaches these (ADR-0187, route-classes.ts; ADR-0188 S7 adds the key rotation route; ADR-0190 I5 adds the three task routes; ENG-IMG removes the runner artifact route)", matches: 9 }],
  ["POST /v1/third-party-ingest/defenseclaw/records", "third-party exporter channel: a customer's DefenseClaw HTTP JSONL exporter posts here with its source's write-only rgti_ token, never a person (ADR-0261)"],
  ["POST /v1/third-party-ingest/defenseclaw/otlp/v1/logs", "third-party exporter channel: a customer's DefenseClaw OTLP/HTTP logs exporter (protobuf or JSON) posts here with its source's write-only rgti_ token, never a person (ADR-0302)"],
  ["* /v1/endpoint-agent/*", { reason: "endpoint agent channel: the agent's install step (bulk enrolment token), its registration (device ticket) and its own DPoP-bound self token reach these, never a person (ADR-0195 SD4b; ADR-0331 added its signed removal directives and their outcomes)", matches: 7 }],
  ["* /v1/browser-extension/*", { reason: "browser extension channel: the managed extension's registration (bulk enrolment token) and its device-proof routes (policy, breach events, prompt capture) reach these, never a person (ADR-0334)", matches: 4 }],
  ["* /v1/executor-channel/*", { reason: "executor channel: only an enrolled executor reaches these (ADR-0190; I4 adds the two stdio session routes, I5 the two task input routes)", matches: 11 }],

  // ---- inbound callbacks and provisioning -----------------------------------
  ["POST /v1/pm/webhooks/:connectionName", "inbound callback: PM-tool webhooks, signature-verified in route (ADR-0061)"],
  ["POST /v1/model-drift/ingest/:monitorId/reports", "pipeline push: a drift monitor's write-only ingestion credential, authenticated in route (ADR-0223 amendment 1)"],
  ["POST /v1/chatops/:connectionName/interactions", "inbound callback: Slack/Teams button interactions, signature-verified in route (ADR-0061)"],
  ["POST /v1/chatops/:connectionName/events", "inbound callback: Slack Events API to builder agents (ADR-0173)"],
  ["POST /v1/chatops/:connectionName/messages", "inbound callback: Teams outgoing webhook to builder agents (ADR-0173)"],
  ["POST /v1/chatops/:connectionName/bot", "inbound callback: the Teams Bot Framework endpoint (ADR-0173 batch 2b)"],
  ["* /scim/v2/*", { reason: "inbound provisioning: the IdP's SCIM 2.0 client, with a SCIM bearer token (the SCIM page manages tokens)", matches: 13 }],
]);

/**
 * SUPERSEDED: an older route the UI no longer needs because a newer one it
 * calls does the same job. `replacement` must itself be a route the UI calls.
 * A replacement that returns only the newest N rows (no paging or filters)
 * does NOT supersede a list route: that is a KNOWN_UI_GAP. `job`, when set,
 * names the scheduler job the replacement runs; it must exist in
 * apps/gateway/src/scheduler-jobs.ts.
 */
export const SUPERSEDED = new Map([
  ["GET /v1/reports/definitions", { replacement: "GET /v1/reports/overview", reason: "the overview carries every definition (unpaged, all rows) with its schedules and run count" }],
  ["GET /v1/reports/schedules", { replacement: "GET /v1/reports/overview", reason: "the overview nests every definition's schedules (unpaged, all rows)" }],
  ["GET /v1/spend/monitor-policies", { replacement: "GET /v1/spend/monitor-overview", reason: "the monitor overview carries every policy (unpaged, all rows)" }],
  ["GET /v1/scim/tokens", { replacement: "GET /v1/scim/status", reason: "the SCIM status carries the token list" }],
  ["GET /v1/org/settings/assurance-gate-mode", { replacement: "GET /v1/org/settings", reason: "the settings read carries assuranceGateMode; the page writes it through the dedicated PUT" }],
  ["GET /v1/org/settings/risk-treatments", { replacement: "GET /v1/org/settings", reason: "the settings read carries riskTreatmentsEnabled; the page writes it through the dedicated PUT" }],
  ["POST /v1/agents/:agentId/owner", { replacement: "PATCH /v1/agents/:agentId/stewardship", reason: "ADR-0168 stewardship sets the steward (the ADR-0089 owner column) in one audited save" }],
  ["POST /v1/agents/:agentId/lifecycle", { replacement: "PATCH /v1/agents/:agentId/stewardship", reason: "ADR-0168 stewardship sets the lifecycle status in the same save" }],
  ["GET /v1/licenses/:id", { replacement: "GET /v1/licenses", reason: "the history list carries every full license row the detail returns" }],
  // manual "run now" doors for scheduler jobs: the Scheduler page runs the SAME
  // function through POST /v1/scheduler/jobs/:name/run (`job` is checked
  // against scheduler-jobs.ts)
  ["POST /v1/config-versions/observations/prune", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "canary-observation-prune-sweep", reason: "the job runs the same prune function" }],
  ["POST /v1/certification-campaigns/expiry-sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "certification-expiry-sweep", reason: "the job runs the same expiry sweep" }],
  ["POST /v1/redteam/scheduled-sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "redteam-sweep", reason: "the job runs runScheduledRedTeamSweep, as this door does" }],
  ["POST /v1/builder/schedules/sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "builder-agent-schedules", reason: "the job runs runBuilderScheduleSweep, as this door does" }],
  ["POST /v1/governance/recertification/sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "use-case-recertification", reason: "the job runs runUseCaseRecertificationSweep, as this door does" }],
  ["GET /v1/model-drift/settings", { replacement: "GET /v1/mrm/cards/:id/drift", reason: "ADR-0223: the card's drift view carries the org drift settings the panel shows; the panel writes them through the PUT" }],
  ["POST /v1/risks/:riskId/accept", { replacement: "POST /v1/risks/:riskId/acceptances", reason: "ADR-0180 §6: /accept is a wrapper over the acceptance write path the panel calls" }],
]);

/**
 * INDIRECT UI CALLS: the SPA calls the route, but through a value no static
 * scan can follow. `evidence` (the call) must still appear in `file`, AND the
 * route's own path must still be written as a literal in `pathIn` (default
 * `file`), so one shared call text cannot keep a removed button's entry alive.
 */
export const INDIRECT_UI_CALLS = new Map([
  ...[
    "POST /v1/infra/findings/:findingId/remediate",
    "POST /v1/infra/certs/:certId/rotate",
    "POST /v1/infra/patches/:patchId/apply",
    "POST /v1/infra/backups/:backupId/restore",
  ].map((r) => [
    r,
    {
      file: "apps/web/src/views/admin/compliance/infraLedgers.tsx",
      evidence: "api.post(pr.url",
      reason: "propose(…) keeps the path in state; the confirm dialog posts it",
    },
  ]),
  // ADR-0226: the shared list control downloads the Excel file from the path its page hands it (`exportPath`)
  ...[
    ["GET /v1/runs/export.xlsx", "apps/web/src/views/runs/RunsPage.tsx"],
    ["GET /v1/incidents/export.xlsx", "apps/web/src/views/incidents/IncidentsPage.tsx"],
    ["GET /v1/users/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    // ADR-0226 P2 batch B: the identity and access lists
    ["GET /v1/users/:userId/sessions/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/revocations/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/users/:userId/revocations/agents/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/users/:userId/revocations/connectors/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/keys/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/roles/:roleId/assignments/export.xlsx", "apps/web/src/views/admin/identity/RolesPage.tsx"],
    ["GET /v1/teams/export.xlsx", "apps/web/src/views/admin/identity/TeamsPage.tsx"],
    ["GET /v1/virtual-keys/export.xlsx", "apps/web/src/views/admin/identity/VirtualKeysPage.tsx"],
    ["GET /v1/virtual-keys/:keyId/usage/export.xlsx", "apps/web/src/views/admin/identity/VirtualKeysPage.tsx"],
    ["GET /v1/admin/credentials/export.xlsx", "apps/web/src/views/admin/identity/CredentialsPage.tsx"],
    ["GET /v1/workload-identities/export.xlsx", "apps/web/src/views/admin/identity/WorkloadIdentitySubpages.tsx"],
    ["GET /v1/auth/link-requests/export.xlsx", "apps/web/src/views/admin/identity/LinkRequestsPage.tsx"],
    ["GET /v1/chatops/identity-links/export.xlsx", "apps/web/src/views/admin/governance/ChatIdentityLinksPage.tsx"],
    ["GET /v1/agents/export.xlsx", "apps/web/src/views/admin/integrations/AgentCatalogPage.tsx"],
    ["GET /v1/licenses/verifications/export.xlsx", "apps/web/src/views/admin/settings/LicenceVerificationsPage.tsx"],
    // P2 batch C: the workflows, engines, cost and operations lists
    ["GET /v1/admission/skills/export.xlsx", "apps/web/src/views/admin/governance/AdmissionReviewPage.tsx"],
    ["GET /v1/billing/statements/export.xlsx", "apps/web/src/views/admin/cost/BillingHistory.tsx"],
    ["GET /v1/builder/threads/export.xlsx", "apps/web/src/views/builder/BuilderInboxPage.tsx"],
    ["GET /v1/compliance/pack-reports/export.xlsx", "apps/web/src/views/admin/compliance/PackRecords.tsx"],
    ["GET /v1/cost-events/export.xlsx", "apps/web/src/views/admin/cost/OptimizationPage.tsx"],
    ["GET /v1/cost-imports/:importId/export.xlsx", "apps/web/src/views/admin/cost/CostImportsPages.tsx"],
    ["GET /v1/cost-imports/export.xlsx", "apps/web/src/views/admin/cost/CostImportsPages.tsx"],
    ["GET /v1/engine-runs/export.xlsx", "apps/web/src/views/admin/governance/EngineRunsPanel.tsx"],
    ["GET /v1/engine-schedules/export.xlsx", "apps/web/src/views/admin/integrations/EngineSchedulesCard.tsx"],
    ["GET /v1/evals/datasets/export.xlsx", "apps/web/src/views/admin/governance/EvalsPage.tsx"],
    ["GET /v1/evals/runs/export.xlsx", "apps/web/src/views/admin/governance/EvalsPage.tsx"],
    ["GET /v1/executors/:executorId/attestations/export.xlsx", "apps/web/src/views/admin/integrations/EnginesSubpages.tsx"],
    ["GET /v1/infra/backups/export.xlsx", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/certs/export.xlsx", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/findings/export.xlsx", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/patches/export.xlsx", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/resources/export.xlsx", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/llm/jobs/export.xlsx", "apps/web/src/views/admin/llm/RegulAItLlmPage.tsx"],
    ["GET /v1/mcp-registries/:registryId/entries/export.xlsx", "apps/web/src/views/admin/integrations/McpRegistriesPanel.tsx"],
    ["GET /v1/mcp/admission/export.xlsx", "apps/web/src/views/admin/governance/AdmissionReviewPage.tsx"],
    ["GET /v1/model-artifacts/export.xlsx", "apps/web/src/views/admin/governance/ModelArtifactsTab.tsx"],
    ["GET /v1/onboarding/imports/export.xlsx", "apps/web/src/views/admin/settings/OnboardingImportsCards.tsx"],
    ["GET /v1/reports/runs/export.xlsx", "apps/web/src/views/admin/cost/ReportsHistory.tsx"],
    ["GET /v1/scheduler/jobs/:name/runs/export.xlsx", "apps/web/src/views/admin/settings/SchedulerJobHistory.tsx"],
    ["GET /v1/security/data-key/attestations/export.xlsx", "apps/web/src/views/admin/settings/DataKeyPage.tsx"],
    ["GET /v1/spend/anomalies/export.xlsx", "apps/web/src/views/admin/cost/SpendHistory.tsx"],
    ["GET /v1/spend/scheduled-changes/export.xlsx", "apps/web/src/views/admin/cost/SpendHistory.tsx"],
    ["GET /v1/webhooks/:subscriptionId/deliveries/export.xlsx", "apps/web/src/views/admin/integrations/WebhooksPage.tsx"],
    ["GET /v1/workflows/instances/export.xlsx", "apps/web/src/views/workflows/WorkflowsPage.tsx"],
  ].map(([r, page]) => [
    r,
    {
      file: "apps/web/src/ui/DataList.tsx",
      evidence: "exportUrl(props.exportPath",
      pathIn: page,
      reason: "the page passes the export path to DataList, whose Download Excel button fetches it",
    },
  ]),
  // ADR-0226 (P2 batch A): the governance and Shadow AI lists' Excel exports, through DataList's Download Excel
  ...[
    ["GET /v1/audit/export.xlsx", "apps/web/src/views/admin/governance/AuditLogPage.tsx"],
    ["GET /v1/delegations/export.xlsx", "apps/web/src/views/admin/governance/ApprovalsAdminPage.tsx"],
    ["GET /v1/guardrails/violations/export.xlsx", "apps/web/src/views/admin/governance/GuardrailsPage.tsx"],
    ["GET /v1/mrm/cards/export.xlsx", "apps/web/src/views/admin/governance/ModelRiskPage.tsx"],
    ["GET /v1/mrm/expiring/export.xlsx", "apps/web/src/views/admin/governance/ModelRiskPage.tsx"],
    ["GET /v1/inventory/agents/export.xlsx", "apps/web/src/views/admin/governance/InventoryPage.tsx"],
    ["GET /v1/receipts/export.xlsx", "apps/web/src/views/admin/governance/DecisionReceiptsBrowser.tsx"],
    ["GET /v1/governance/alerts/export.xlsx", "apps/web/src/views/admin/governance/GovernanceAlertsPage.tsx"],
    ["GET /v1/governance/remediations/export.xlsx", "apps/web/src/views/admin/governance/RemediationsCard.tsx"],
    ["GET /v1/certification-campaigns/export.xlsx", "apps/web/src/views/admin/governance/CampaignsPage.tsx"],
    ["GET /v1/certification-campaigns/:campaignId/items/export.xlsx", "apps/web/src/views/admin/governance/CampaignsPage.tsx"],
    ["GET /v1/sod/overrides/export.xlsx", "apps/web/src/views/admin/governance/SodRulesPage.tsx"],
    ["GET /v1/policy-simulations/export.xlsx", "apps/web/src/views/admin/governance/SimulationPage.tsx"],
    ["GET /v1/copilot/queries/export.xlsx", "apps/web/src/views/admin/governance/CopilotPage.tsx"],
    ["GET /v1/copilot/proposals/export.xlsx", "apps/web/src/views/admin/governance/CopilotPage.tsx"],
    ["GET /v1/shadow-ai/findings/export.xlsx", "apps/web/src/views/admin/governance/ShadowAiPage.tsx"],
    ["GET /v1/shadow-ai/imports/export.xlsx", "apps/web/src/views/admin/governance/ShadowAiPage.tsx"],
    ["GET /v1/discovery/runs/export.xlsx", "apps/web/src/views/admin/governance/DiscoveryListPages.tsx"],
    ["GET /v1/discovery/sources/:sourceId/enrolment-tokens/export.xlsx", "apps/web/src/views/admin/governance/DiscoveryListPages.tsx"],
    ["GET /v1/discovery/sources/:sourceId/endpoint-devices/export.xlsx", "apps/web/src/views/admin/governance/DiscoveryListPages.tsx"],
    ["GET /v1/content-provenance/records/export.xlsx", "apps/web/src/views/admin/governance/ContentTrustPage.tsx"],
    ["GET /v1/use-cases/export.xlsx", "apps/web/src/views/admin/governance/UseCasesPage.tsx"],
    ["GET /v1/annotation-queues/:queueId/items/export.xlsx", "apps/web/src/views/admin/governance/AnnotationQueuesPage.tsx"],
    ["GET /v1/vendors/export.xlsx", "apps/web/src/views/admin/governance/VendorsPage.tsx"],
    ["GET /v1/governance/decision-regression/runs/export.xlsx", "apps/web/src/views/admin/governance/DecisionRegressionPage.tsx"],
    ["GET /v1/feedback/export.xlsx", "apps/web/src/views/feedback/feedbackKit.tsx"],
  ].map(([r, page]) => [
    r,
    {
      file: "apps/web/src/ui/DataList.tsx",
      evidence: "exportUrl(props.exportPath",
      pathIn: page,
      reason: "the page passes the export path to DataList, whose Download Excel button fetches it",
    },
  ]),
  // ADR-0226 (P2 batch A): the lists DataList reads page by page from the endpoint its page hands it (`endpoint`)
  ...[
    ["GET /v1/delegations", "apps/web/src/views/admin/governance/ApprovalsAdminPage.tsx"],
    ["GET /v1/guardrails/violations", "apps/web/src/views/admin/governance/GuardrailsPage.tsx"],
    ["GET /v1/mrm/expiring", "apps/web/src/views/admin/governance/ModelRiskPage.tsx"],
    ["GET /v1/inventory/agents", "apps/web/src/views/admin/governance/InventoryPage.tsx"],
    ["GET /v1/receipts", "apps/web/src/views/admin/governance/DecisionReceiptsBrowser.tsx"],
    ["GET /v1/governance/remediations", "apps/web/src/views/admin/governance/RemediationsCard.tsx"],
    ["GET /v1/certification-campaigns", "apps/web/src/views/admin/governance/CampaignsPage.tsx"],
    ["GET /v1/certification-campaigns/:campaignId/items", "apps/web/src/views/admin/governance/CampaignsPage.tsx"],
    ["GET /v1/copilot/queries", "apps/web/src/views/admin/governance/CopilotPage.tsx"],
    ["GET /v1/copilot/proposals", "apps/web/src/views/admin/governance/CopilotPage.tsx"],
    ["GET /v1/shadow-ai/imports", "apps/web/src/views/admin/governance/ShadowAiPage.tsx"],
    ["GET /v1/discovery/runs", "apps/web/src/views/admin/governance/DiscoveryListPages.tsx"],
    ["GET /v1/discovery/sources/:sourceId/enrolment-tokens", "apps/web/src/views/admin/governance/DiscoveryListPages.tsx"],
    ["GET /v1/discovery/sources/:sourceId/endpoint-devices", "apps/web/src/views/admin/governance/DiscoveryListPages.tsx"],
    ["GET /v1/content-provenance/records", "apps/web/src/views/admin/governance/ContentTrustPage.tsx"],
    ["GET /v1/annotation-queues/:queueId/items", "apps/web/src/views/admin/governance/AnnotationQueuesPage.tsx"],
    ["GET /v1/governance/decision-regression/runs", "apps/web/src/views/admin/governance/DecisionRegressionPage.tsx"],
    ["GET /v1/incidents", "apps/web/src/views/admin/governance/IncidentsTab.tsx"],
    ["GET /v1/feedback", "apps/web/src/views/feedback/feedbackKit.tsx"],
    // ADR-0226 P2 batch B: the identity lists DataList reads from the path its page hands it (`endpoint`)
    ["GET /v1/auth/link-requests", "apps/web/src/views/admin/identity/SsoPage.tsx"],
    ["GET /v1/keys", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/licenses/verifications", "apps/web/src/views/admin/settings/LicensingPage.tsx"],
    ["GET /v1/admin/credentials", "apps/web/src/views/admin/identity/CredentialsPage.tsx"],
    ["GET /v1/revocations", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/roles/:roleId/assignments", "apps/web/src/views/admin/identity/RolesPage.tsx"],
    ["GET /v1/chatops/identity-links", "apps/web/src/views/admin/governance/ChatOpsPage.tsx"],
    ["GET /v1/users/:userId/revocations/agents", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/users/:userId/revocations/connectors", "apps/web/src/views/admin/identity/UsersPage.tsx"],
    ["GET /v1/virtual-keys", "apps/web/src/views/admin/identity/VirtualKeysPage.tsx"],
    // ADR-0226 P2 batch C: a list the shared control reads, page by page, from the endpoint its page hands it
    ["GET /v1/admission/skills", "apps/web/src/views/admin/governance/AdmissionReviewPage.tsx"],
    ["GET /v1/billing/statements", "apps/web/src/views/admin/cost/BillingHistory.tsx"],
    ["GET /v1/compliance/pack-reports", "apps/web/src/views/admin/compliance/PackRecords.tsx"],
    ["GET /v1/engine-schedules", "apps/web/src/views/admin/integrations/EngineSchedulesCard.tsx"],
    ["GET /v1/executors/:executorId/attestations", "apps/web/src/views/admin/integrations/isolation/ExecutorDetail.tsx"],
    ["GET /v1/infra/backups", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/certs", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/findings", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/infra/patches", "apps/web/src/views/admin/compliance/infraLedgers.tsx"],
    ["GET /v1/llm/jobs", "apps/web/src/views/admin/llm/RegulAItLlmPage.tsx"],
    ["GET /v1/mcp-registries/:registryId/entries", "apps/web/src/views/admin/integrations/McpRegistriesPanel.tsx"],
    ["GET /v1/model-artifacts", "apps/web/src/views/admin/governance/ModelArtifactsTab.tsx"],
    ["GET /v1/onboarding/imports", "apps/web/src/views/admin/settings/OnboardingImportsCards.tsx"],
    ["GET /v1/scheduler/jobs/:name/runs", "apps/web/src/views/admin/settings/SchedulerJobHistory.tsx"],
    ["GET /v1/security/data-key/attestations", "apps/web/src/views/admin/settings/DataKeyPage.tsx"],
    ["GET /v1/spend/anomalies", "apps/web/src/views/admin/cost/SpendHistory.tsx"],
    ["GET /v1/spend/scheduled-changes", "apps/web/src/views/admin/cost/SpendHistory.tsx"],
    ["GET /v1/webhooks/:subscriptionId/deliveries", "apps/web/src/views/admin/integrations/WebhooksPage.tsx"],
  ].map(([r, page]) => [
    r,
    {
      file: "apps/web/src/ui/DataList.tsx",
      evidence: "pageUrl(endpoint",
      pathIn: page,
      reason: "the page passes the list route to DataList, which reads it one page at a time",
    },
  ]),
  [
    "GET /v1/decisions/:auditId/bom/bundle",
    {
      file: "apps/web/src/views/admin/governance/bomB4Api.ts",
      evidence: "api.getBlob(view.bundleHref",
      pathIn: "apps/web/src/views/admin/governance/bomModel.ts",
      reason: "the Decision BOM names its bundle href; bomModel.ts checks it equals this route, then the download fetches it",
    },
  ],
  // ADR-0226 P2 batch D: the usage ledger, the golden cases and the findings per rule
  ...[
    ["GET /v1/usage-events/export.xlsx", "apps/web/src/views/admin/cost/OptimizationPage.tsx"],
    ["GET /v1/governance/decision-regression/cases/export.xlsx", "apps/web/src/views/admin/governance/DecisionRegressionPage.tsx"],
    ["GET /v1/recommendations/access/export.xlsx", "apps/web/src/views/admin/governance/RecommendationsPage.tsx"],
    // the Inbox's "Recently decided" (owner decision, 2026-11-06)
    ["GET /v1/approvals/export.xlsx", "apps/web/src/views/inbox/InboxPage.tsx"],
  ].map(([r, page]) => [
    r,
    {
      file: "apps/web/src/ui/DataList.tsx",
      evidence: "exportUrl(props.exportPath",
      pathIn: page,
      reason: "the page passes the export path to DataList, whose Download Excel button fetches it",
    },
  ]),
  ...[["GET /v1/governance/decision-regression/cases", "apps/web/src/views/admin/governance/DecisionRegressionPage.tsx"]].map(([r, page]) => [
    r,
    {
      file: "apps/web/src/ui/DataList.tsx",
      evidence: "pageUrl(endpoint",
      pathIn: page,
      reason: "the page passes the list route to DataList, which reads it page by page",
    },
  ]),
]);

/**
 * KNOWN UI GAPS — TEMPORARY. A real capability with no screen yet: listed so
 * CI stays green while the UI work is scheduled, NEVER as an exemption. Each
 * entry says what the route does (so the screen can be designed) and a
 * tracking note. Closing one means building the screen; this run then fails
 * until the entry is deleted, and KNOWN_UI_GAPS_MAX is lowered to match.
 */
export const KNOWN_UI_GAPS = new Map([
  ["GET /v1/classifiers", { does: "lists the customer classifiers and every version with its lifecycle status (exact-data-match values shown as a count only)", tracking: "ADR-0363 slice 2 (lane E44): the brief is API-only (rule 3); the classifier editor and its review are for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["POST /v1/classifiers", { does: "creates a classifier and drafts its first version (regex, keyword, dictionary or exact-data-match; EDM values hashed on the request, never stored)", tracking: "ADR-0363 slice 2 (lane E44): the brief is API-only (rule 3); the classifier editor and its review are for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["POST /v1/classifiers/:id/versions", { does: "drafts the next version of a classifier", tracking: "ADR-0363 slice 2 (lane E44): the brief is API-only (rule 3); the classifier editor and its review are for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["POST /v1/classifiers/:id/versions/:version/submit", { does: "submits a drafted version to a named reviewer in the approvals queue; it publishes only when approved", tracking: "ADR-0363 slice 2 (lane E44): the brief is API-only (rule 3); the classifier editor and its review are for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["POST /v1/classifiers/:id/retire", { does: "retires a published classifier (removes a control: settings_relax step-up, audited)", tracking: "ADR-0363 slice 2 (lane E44): the brief is API-only (rule 3); the classifier editor and its review are for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["POST /v1/classifiers/test", { does: "dry-runs an unsaved classifier definition against sample text and returns a match count (nothing stored)", tracking: "ADR-0363 slice 2 (lane E44): the brief is API-only (rule 3); the classifier editor and its review are for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["GET /v1/detection/rule-pack", { does: "reads the active detection rule pack, its version, digest and verification state", tracking: "ADR-0333 (E15) #453" }],
  ["PUT /v1/detection/rule-pack", { does: "stores a new signed detection rule pack version (audited; a relaxation needs a settings_relax step-up)", tracking: "ADR-0333 (E15) #453" }],
  ["GET /v1/detection/incidents", { does: "pages detection incidents, newest first, filtered by status", tracking: "ADR-0333 (E15) #453" }],
  ["GET /v1/detection/incidents/:incidentId", { does: "one detection incident with its evidence chain (audit rows, row hashes, receipts)", tracking: "ADR-0333 (E15) #453" }],
  ["PUT /v1/detection/incidents/:incidentId/status", { does: "acknowledges or closes a detection incident (audited)", tracking: "ADR-0333 (E15) #453" }],
  ["GET /v1/sensitivity-labels", { does: "lists the Purview sensitivity labels read from the tenant, each label's mapping (allow, redact or block; data sensitivity; compliance profile) and the strict fallbacks", tracking: "ADR-0363 slice 1 (lane E44): the brief is API-only (rule 3); the label mapping screen is for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["PUT /v1/sensitivity-labels/settings", { does: "sets the fallbacks for unmapped labels, encrypted files and unreadable files (relaxing is a settings_relax step-up, audited)", tracking: "ADR-0363 slice 1 (lane E44): the brief is API-only (rule 3); the label mapping screen is for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["PUT /v1/sensitivity-labels/:definitionId/rule", { does: "maps one label to an action, a data sensitivity and optionally a compliance profile (relaxing is a settings_relax step-up, audited)", tracking: "ADR-0363 slice 1 (lane E44): the brief is API-only (rule 3); the label mapping screen is for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["DELETE /v1/sensitivity-labels/:definitionId/rule", { does: "removes a label's mapping so it falls to the unmapped action (a step-up when that is looser, audited)", tracking: "ADR-0363 slice 1 (lane E44): the brief is API-only (rule 3); the label mapping screen is for the design builder on #453. RAISED for review: the master decides on the PR" }],
  ["POST /v1/model-artifacts/:artifactId/lineage", { does: "records how a model file was derived from its parent file(s): repackaged, converted, fine-tuned, quantized or merged (once per file, audited)", tracking: "Lane L7 (P14 + P16): the brief is API-only; the lineage panel on the model-artifact screen is for the design builder on #453. RAISED for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/model-artifacts/:artifactId/lineage", { does: "shows a model file's parents, ancestors and children (relatives the caller cannot see as a count)", tracking: "Lane L7 (P14 + P16): the brief is API-only; the lineage panel on the model-artifact screen is for the design builder on #453. RAISED for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/vendor-usage", { does: "reads the vendor usage pull policy, the vendor catalogue and every connector (credentials never returned)", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["PUT /v1/vendor-usage/policy", { does: "turns vendor usage pull on (settings_relax step-up, refused when air-gapped) or off, with a required reason", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["POST /v1/vendor-usage/connectors", { does: "registers a vendor usage connector (disabled) with its schema-validated configuration", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["PUT /v1/vendor-usage/connectors/:connectorId/config", { does: "changes a connector's configuration (backfill, the gateway's own key/project/workspace ids) and re-marks stored lines", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["PUT /v1/vendor-usage/connectors/:connectorId/credential", { does: "stores or rotates a connector's vendor key (step-up, write-capable acknowledgement, encrypted, never returned)", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["DELETE /v1/vendor-usage/connectors/:connectorId/credential", { does: "revokes a connector's vendor key and disables the connector (no step-up)", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["PUT /v1/vendor-usage/connectors/:connectorId/enabled", { does: "enables (step-up, needs a live credential) or disables a connector", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["POST /v1/vendor-usage/connectors/:connectorId/pull", { does: "runs one pull now for a connector", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["GET /v1/vendor-usage/connectors/:connectorId/runs", { does: "lists a connector's last 50 pull runs", tracking: "ADR-0322 (lane E7): API-only by the lane brief (master dispatch 2026-11-15: new routes go in the census with a KNOWN_UI_GAPS entry pointing at #453, no screens), recorded in ADR-0322 (As built, slice 2); the vendor usage pull settings screen is posted on #453" }],
  ["GET /v1/copilot/redteam-gate", { does: "reads the copilot narrator red-team gate settings and, for one agent, whether it may narrate and which run decided it", tracking: "ADR-0056 §5 amendment (lane L7): the brief is API-only; the settings card and per-narrator status are for the design builder on #453. RAISED for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["PUT /v1/copilot/redteam-gate", { does: "turns the copilot narrator red-team gate on or off, or changes how long a passing run counts (relaxing is a settings_relax step-up, audited)", tracking: "ADR-0056 §5 amendment (lane L7): the brief is API-only; the settings card is for the design builder on #453. RAISED for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["POST /v1/mcp-catalogue/presets/:preset", { does: "seeds the official MCP Registry or awesome-mcp-servers as a disabled catalogue source", tracking: "ADR-0256 (P32): the brief is API and backend only; the deduped catalogue page, preset buttons and bundle upload are posted on #453. RAISED FROM 7 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["POST /v1/mcp-catalogue/bundles", { does: "imports a signed offline catalogue bundle (air-gapped installs)", tracking: "ADR-0256 (P32): the brief is API and backend only; the deduped catalogue page, preset buttons and bundle upload are posted on #453. RAISED FROM 7 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/mcp-catalogue/bundle", { does: "exports one source as an unsigned bundle, to be signed offline", tracking: "ADR-0256 (P32): the brief is API and backend only; the deduped catalogue page, preset buttons and bundle upload are posted on #453. RAISED FROM 7 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/mcp-catalogue", { does: "reads the deduped catalogue: sources, vetting, paid/x402 flag and admission state", tracking: "ADR-0256 (P32): the brief is API and backend only; the deduped catalogue page, preset buttons and bundle upload are posted on #453. RAISED FROM 7 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/mcp/definition-pins", { does: "lists the MCP servers with a tool, prompt or resource changed since approval (rug-pull queue)", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/servers/:serverId/definition-pins", { does: "one server's pinned definitions with each changed item's RFC 6902 diff", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["POST /v1/servers/:serverId/definition-pins/approve", { does: "re-approves reviewed changed items against their digests (settings_relax step-up)", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/servers/:serverId/high-risk-policy", { does: "shows a server's offensive-tooling classification and whether its policy template is applied", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["POST /v1/servers/:serverId/high-risk-policy", { does: "applies the high-risk policy template: a quorum approval rule and a rate limit", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["POST /v1/servers/:serverId/risk-class", { does: "an admin marks a server high-risk by hand when the automatic classifier missed its neutrally-named offensive tools", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/mcp/authorised-targets", { does: "lists the authorised targets of high-risk MCP servers", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["POST /v1/mcp/authorised-targets", { does: "adds an authorised target (settings_relax step-up)", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["DELETE /v1/mcp/authorised-targets/:id", { does: "removes an authorised target", tracking: "ADR-0246 (P27): the brief is API-only; the review screens are posted on #453 for the Governed Designer. RAISED FROM 0 for review: the master decides on the PR whether to keep this or build the screen first" }],
  ["GET /v1/servers/:serverId/system-class", { does: "shows whether a server is marked SAP business and which seeded approval rule and rate limit are in force", tracking: "ADR-0230 A2 (P19, Lane L3): API-only by the master decision in the Lane L3 brief 2026-11-14, recorded in ADR-0230, section Recorded decision (2026-11-14); the SAP business server screen is built by the design builder on #453" }],
  ["POST /v1/servers/:serverId/system-class", { does: "marks a server SAP business and seeds its write-only quorum approval rule and rate limit", tracking: "ADR-0230 A2 (P19, Lane L3): API-only by the master decision in the Lane L3 brief 2026-11-14, recorded in ADR-0230, section Recorded decision (2026-11-14); the SAP business server screen is built by the design builder on #453" }],
  ["DELETE /v1/servers/:serverId/system-class", { does: "unmarks an SAP business server (settings_relax step-up)", tracking: "ADR-0230 A2 (P19, Lane L3): API-only by the master decision in the Lane L3 brief 2026-11-14, recorded in ADR-0230, section Recorded decision (2026-11-14); the SAP business server screen is built by the design builder on #453" }],
  // ADR-0261 (P37) adds six: the owner decided on 2026-11-07 to raise the cap by exactly these and ship the
  // DefenseClaw ingest API-only, with the admin screen tracked on #453.
  ["GET /v1/third-party-ingest/sources", { does: "lists third-party ingest sources (DefenseClaw), their state, credential issue time and the ingest limits", tracking: "#453" }],
  ["POST /v1/third-party-ingest/sources", { does: "creates a DefenseClaw ingest source, off by default", tracking: "#453" }],
  ["PUT /v1/third-party-ingest/sources/:sourceId/enabled", { does: "turns a source on (step-up, audited) or off (audited)", tracking: "#453" }],
  ["POST /v1/third-party-ingest/sources/:sourceId/credential", { does: "issues or replaces the source's write-only rgti_ token, shown once (step-up, audited)", tracking: "#453" }],
  ["POST /v1/third-party-ingest/sources/:sourceId/credential/revoke", { does: "revokes the source's ingest token (audited)", tracking: "#453" }],
  ["GET /v1/third-party-ingest/sources/:sourceId/records", { does: "the newest third-party evidence a source delivered, each marked third-party with its linked findings", tracking: "#453" }],
  // ADR-0303 (lane L11, P18 C6): five API-only SIEM destination routes; the admin screen is posted on #453.
  ["GET /v1/siem/destinations", { does: "lists SIEM destinations, their state, cursor and lag (never the secret)", tracking: "#453" }],
  ["POST /v1/siem/destinations", { does: "creates a SIEM destination, off by default; the Standard Webhooks secret is shown once", tracking: "#453" }],
  ["PUT /v1/siem/destinations/:destinationId/enabled", { does: "turns a SIEM destination on (step-up, audited as a relaxation) or off (audited)", tracking: "#453" }],
  ["POST /v1/siem/destinations/:destinationId/rotate-secret", { does: "rotates a SIEM destination's signing secret, shown once (step-up, audited)", tracking: "#453" }],
  ["POST /v1/siem/destinations/:destinationId/recover", { does: "returns a dead-lettered or backing-off SIEM destination to delivery now (audited)", tracking: "#453" }],
  // ADR-0312 (lane E2, G3): three API-only cost-per-outcome routes; the dashboard cards are posted on #453.
  ["GET /v1/cost-outcomes", { does: "pages recorded outcomes (merged PR, workflow run, accepted change, completed work item) with each one's metered spend; a non-admin sees only their own", tracking: "#453" }],
  ["GET /v1/cost-outcomes/summary", { does: "per-project or per-cost-centre cost per outcome, metered by kind, with imported spend beside it (never combined)", tracking: "#453" }],
  ["POST /v1/cost-outcomes/refresh", { does: "runs the outcome recorder now (admin, audited); the scheduler runs it every five minutes", tracking: "#453" }],
  ["GET /v1/user-spend-budgets", { does: "lists every person's spend budget (alert only): amount, window and alert threshold", tracking: "#453" }],
  ["GET /v1/users/:userId/spend-budget", { does: "a person's spend budget with their metered spend in the window and imported spend beside it (self or admin)", tracking: "#453" }],
  ["PUT /v1/users/:userId/spend-budget", { does: "sets a person's spend budget; crossing its threshold raises a governance alert (audited)", tracking: "#453" }],
  ["DELETE /v1/users/:userId/spend-budget", { does: "removes a person's spend budget, a relaxation (settings_relax step-up, audited)", tracking: "#453" }],
  // EXCEPTION (ADR-0255, P31, 2026-11-07): the P31 brief is "API and backend only; post the catalogue UI need on
  // #453 for the Governed Designer", so these two routes ship with their screen owned by that lane. These two
  // raise the cap by 2, visibly; the Designer's catalogue screen deletes both entries and lowers it by 2. Decided on #753
  // (2026-11-14): keep the temporary gap; lane UI-C builds the catalogue screen after merge and lowers the cap.
  [
    "GET /v1/connector-catalogue",
    {
      does: "lists the curated catalogue pieces (status, actions, upstream) and the community pieces available, not enabled (paginated, q filter)",
      tracking: "ADR-0255 / P31: catalogue screen for the Governed Designer, requested on #453",
    },
  ],
  [
    "POST /v1/connector-catalogue/:pieceKey/enablement",
    {
      does: "enables (admin, step-up) or disables a curated piece, with a reason, audited",
      tracking: "ADR-0255 / P31: catalogue screen for the Governed Designer, requested on #453",
    },
  ],
  [
    "GET /v1/vendors/:vendorId/supplier-access/:accessId/mfa",
    { does: "ADR-0240: a supplier grant's second-factor state (none, enrolling, active, locked); never the secret", tracking: "#453" },
  ],
  [
    "POST /v1/vendors/:vendorId/supplier-access/:accessId/mfa/reset",
    { does: "ADR-0240: the inviting admin resets a supplier's second factor (identity_manage step-up, reason, audited)", tracking: "#453" },
  ],
  [
    "POST /supplier/v1/session/mfa",
    { does: "ADR-0240: the supplier turns a spent link's challenge into a session with a TOTP code", tracking: "#453" },
  ],
  [
    "GET /v1/trust/auditor-grants/:grantId/mfa",
    { does: "ADR-0240: an auditor grant's second-factor state (none, enrolling, active, locked); never the secret", tracking: "#453" },
  ],
  [
    "POST /v1/trust/auditor-grants/:grantId/mfa/reset",
    { does: "ADR-0240: the inviting admin resets an auditor's second factor (identity_manage step-up, reason, audited)", tracking: "#453" },
  ],
  [
    "POST /v1/auditor/session/mfa",
    { does: "ADR-0240: the auditor turns a spent link's challenge into a session with a TOTP code", tracking: "#453" },
  ],
  ["GET /v1/reports/posture/assets", { does: "pages per-asset posture scores (agents or use cases) the caller can read, each with objectives and ranked actions", tracking: "ADR-0214 amendment (P3): the brief is API-only; the per-asset score screen is posted on #453 (c6703277931) for the Governed Designer, and the owner chose the temporary gap on #705 (2026-11-07)" }],
  ["GET /v1/reports/posture/assets/:kind/:assetId", { does: "one agent's or use case's posture score, with its objectives, not-applicable list and ranked actions", tracking: "ADR-0214 amendment (P3): the brief is API-only; the per-asset score screen is posted on #453 (c6703277931) for the Governed Designer, and the owner chose the temporary gap on #705 (2026-11-07)" }],
  ["GET /v1/servers/:serverId/token-exchange", { does: "reads an MCP server's upstream token-exchange configuration and per-action scope map (never the secret)", tracking: "ADR-0238 (P12(d)): the brief is API-only; the token-exchange form and scope map are posted on #453. Master decision 2026-11-08 (#712 unblock): keep as a known gap until that screen is built" }],
  ["PUT /v1/servers/:serverId/token-exchange", { does: "sets or changes an MCP server's upstream token exchange (settings_relax step-up, audited)", tracking: "ADR-0238 (P12(d)): the brief is API-only; the token-exchange form and scope map are posted on #453. Master decision 2026-11-08 (#712 unblock): keep as a known gap until that screen is built" }],
  ["DELETE /v1/servers/:serverId/token-exchange", { does: "removes an MCP server's upstream token exchange (settings_relax step-up, audited)", tracking: "ADR-0238 (P12(d)): the brief is API-only; the token-exchange form and scope map are posted on #453. Master decision 2026-11-08 (#712 unblock): keep as a known gap until that screen is built" }],
  ["GET /v1/connectors/:connectorId/token-exchange", { does: "reads a connector's upstream token-exchange configuration and per-action scope map (never the secret)", tracking: "ADR-0238 (P12(d)): the brief is API-only; the token-exchange form and scope map are posted on #453. Master decision 2026-11-08 (#712 unblock): keep as a known gap until that screen is built" }],
  ["PUT /v1/connectors/:connectorId/token-exchange", { does: "sets or changes a connector's upstream token exchange (settings_relax step-up, audited)", tracking: "ADR-0238 (P12(d)): the brief is API-only; the token-exchange form and scope map are posted on #453. Master decision 2026-11-08 (#712 unblock): keep as a known gap until that screen is built" }],
  ["DELETE /v1/connectors/:connectorId/token-exchange", { does: "removes a connector's upstream token exchange (settings_relax step-up, audited)", tracking: "ADR-0238 (P12(d)): the brief is API-only; the token-exchange form and scope map are posted on #453. Master decision 2026-11-08 (#712 unblock): keep as a known gap until that screen is built" }],
  ["GET /v1/browser-governance", { does: "reads browser governance settings (on/off, enforce/audit, prompt capture) and the policy key's public half for managed storage", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["PUT /v1/browser-governance/settings", { does: "turns browser governance on, audit mode or prompt capture (each a settings_relax step-up, audited), or back off", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["GET /v1/browser-governance/sites", { does: "lists the governed AI sites with each one's rule and required account domains", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["PUT /v1/browser-governance/sites/:siteId", { does: "allows a site (settings_relax step-up) or denies it, with the account domains the browser profile must use", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["POST /v1/browser-governance/enrolment-tokens", { does: "issues a capped browser enrolment token and the managed-storage config, shown once", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["GET /v1/browser-governance/enrolment-tokens", { does: "lists browser enrolment tokens with their caps and enrolled devices (never the token)", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["POST /v1/browser-governance/enrolment-tokens/:tokenId/revoke", { does: "revokes a browser enrolment token: no new devices register with it", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["GET /v1/browser-governance/devices", { does: "lists enrolled browser extension devices", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["POST /v1/browser-governance/devices/:deviceId/revoke", { does: "revokes a browser extension device: its proofs are refused and it blocks every governed site", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["GET /v1/browser-governance/events", { does: "lists browser policy breach events (site, account and DLP blocks), pseudonymous", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  ["GET /v1/browser-governance/prompt-captures/:captureId", { does: "reads one captured prompt (a pseudonym_reveal step-up, audited)", tracking: "ADR-0334 (lane E16): the brief is API-only; the browser governance screens are requested on #453 for the UI builder" }],
  // ADR-0289 (lane L6, ADR-0054 §3): the PM importer ships API-first per the lane brief; its screen is requested on
  // #453 (the design builder builds screens). Building it deletes these two and lowers the cap.
  ["POST /v1/onboarding/imports/pm", { does: "previews (default) or applies a PM project / work-item import: linkage only, onto an Initiative; apply carries the previewed planSha256", tracking: "#453" }],
  ["GET /v1/onboarding/imports/pm/items", { does: "pages the imported work-item linkage for one PM connection and its Initiative mapping", tracking: "#453" }],
  ["POST /v1/managed-settings/bundles", { does: "compiles a user's or role's effective MCP entitlements into signed vendor managed settings (audited)", tracking: "ADR-0310 (G2, lane E1): the brief is API-only; the managed-settings export screen is requested on #453 (Governed Designer). raised under the lane E1 brief rule 3 (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0310)" }],
  ["GET /v1/managed-settings/bundles", { does: "lists managed-settings bundle versions, newest first", tracking: "ADR-0310 (G2, lane E1): the brief is API-only; the managed-settings export screen is requested on #453 (Governed Designer). raised under the lane E1 brief rule 3 (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0310)" }],
  ["GET /v1/managed-settings/bundles/:id/archive", { does: "downloads a bundle's signed tar.gz for MDM push", tracking: "ADR-0310 (G2, lane E1): the brief is API-only; the managed-settings export screen is requested on #453 (Governed Designer). raised under the lane E1 brief rule 3 (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0310)" }],
  ["GET /v1/managed-settings/drift", { does: "lists MCP servers configured on enrolled devices outside the exported managed allowlist (ADR-0259 inventory)", tracking: "ADR-0310 slice 2 (G2, lane E1): the brief is API-only; the drift view is requested on #453 (Governed Designer). raised under the lane E1 brief rule 3 (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0310)" }],
  ["GET /v1/rule-steps/settings", { does: "reads the rule-like AI step detection switch and thresholds, with the strict defaults and floors", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["PUT /v1/rule-steps/settings", { does: "turns rule-like step detection on or off or changes its thresholds (enabling or lowering one is a settings_relax step-up, audited)", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["POST /v1/rule-steps/scan", { does: "scans recent model spans for AI steps that behave like fixed rules and stores suggestions (read-only, spaced 10 minutes, audited)", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["GET /v1/rule-steps/suggestions", { does: "lists rule-like step suggestions with the readable rule, test cases from history and projected monthly savings", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["GET /v1/rule-steps/suggestions/export.xlsx", { does: "exports the rule-like step suggestions list (summary columns only, never the rule cells) under the ADR-0226 list contract, audited", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["POST /v1/rule-steps/suggestions/:id/dismiss", { does: "dismisses a rule-like step suggestion (audited)", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["GET /v1/decision-tables", { does: "lists decision tables (business-authored conditions and outcomes per AI step) with their published and in-review versions, under the ADR-0226 list contract", tracking: "ADR-0327 addendum (lane E12, owner approval 2026-11-17, competitor gap audit Camunda row 6): API and backend only; the decision-table editor (rows, review, history) is for UI-D (#453)" }],
  ["POST /v1/decision-tables", { does: "creates a decision table bound to one AI step (agent and step name), audited", tracking: "ADR-0327 addendum (lane E12, owner approval 2026-11-17, competitor gap audit Camunda row 6): API and backend only; the decision-table editor (rows, review, history) is for UI-D (#453)" }],
  ["GET /v1/decision-tables/:id", { does: "reads a decision table: the published and in-review versions with their readable rows and test cases, and recent history", tracking: "ADR-0327 addendum (lane E12, owner approval 2026-11-17, competitor gap audit Camunda row 6): API and backend only; the decision-table editor (rows, review, history) is for UI-D (#453)" }],
  ["POST /v1/decision-tables/:id/versions", { does: "proposes a new decision-table version (schema-validated, compiled to the exact-match rule engine) for review by a named administrator in the approvals queue, audited; published only on approval", tracking: "ADR-0327 addendum (lane E12, owner approval 2026-11-17, competitor gap audit Camunda row 6): API and backend only; the decision-table editor (rows, review, history) is for UI-D (#453)" }],
  ["GET /v1/agent-registry/records", { does: "pages the agents staged from vendor agent registries (Entra Agent ID, Agent 365, Gemini Enterprise, Bedrock AgentCore), open, imported or absent", tracking: "ADR-0314 (G6, lane E3): master brief for lane E3 (2026-11-15): new routes are API-only with a KNOWN_UI_GAPS entry pointing at #453; the registry import screen (staged records, import form) is posted on #453 for the Governed Designer. RAISED for the master's review" }],
  ["GET /v1/agent-registry/records/:recordId", { does: "one staged registry agent with its provenance (source, run, vendor id) and import state", tracking: "ADR-0314 (G6, lane E3): master brief for lane E3 (2026-11-15): new routes are API-only with a KNOWN_UI_GAPS entry pointing at #453; the registry import screen (staged records, import form) is posted on #453 for the Governed Designer. RAISED for the master's review" }],
  ["POST /v1/agent-registry/records/:recordId/import", { does: "imports a staged registry agent into the inventory, disabled and proposed with no grants (settings_relax step-up, audited)", tracking: "ADR-0314 (G6, lane E3): master brief for lane E3 (2026-11-15): new routes are API-only with a KNOWN_UI_GAPS entry pointing at #453; the registry import screen (staged records, import form) is posted on #453 for the Governed Designer. RAISED for the master's review" }],
  ["POST /v1/rule-steps/suggestions/:id/shadow", { does: "puts a rule-like step suggestion in shadow mode: its rule is measured against live model spans by later scans (the AI still answers), audited", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["POST /v1/rule-steps/suggestions/:id/shadow/stop", { does: "stops a rule-like step suggestion's shadow period and keeps its counts, audited", tracking: "ADR-0327 (lane E12): the brief is API and backend only; the suggestions page (rule, evidence, savings, dismiss) is for UI-D" }],
  ["GET /v1/endpoint-addons/versions", { does: "lists each AI add-on version seen on endpoints with its admission-scan verdict for that exact content digest (not yet scanned is never clear)", tracking: "ADR-0332 (lane E14): master brief for lane E14 (2026-11-15): the inventory is API-only and the UI builder builds its screen; KNOWN_UI_GAPS entries point at #453 (screen brief in PR #866)" }],
  ["GET /v1/endpoint-addons/sightings", { does: "lists each add-on version per endpoint and detection source, with first/last seen, risk flags and secret types (never a value)", tracking: "ADR-0332 (lane E14): master brief for lane E14 (2026-11-15): the inventory is API-only and the UI builder builds its screen; KNOWN_UI_GAPS entries point at #453 (screen brief in PR #866)" }],
  ["GET /v1/endpoint-addons/flagged", { does: "lists the endpoint add-on sightings flagged at or above a severity (the removal-directive and detection contract)", tracking: "ADR-0332 (lane E14): master brief for lane E14 (2026-11-15): the inventory is API-only and the UI builder builds its screen; KNOWN_UI_GAPS entries point at #453 (screen brief in PR #866)" }],
  ["GET /v1/discovery/entitlements/apps", { does: "lists the apps one SaaS entitlement source holds, each with its agent link state and the link transitions allowed next", tracking: "ADR-0337 §6 (lane E18): owner decision 2026-11-17 (vendor-app auto-link to agents, admin link and unlink) is API-only in the lane brief; the graph and link screen is requested on #453. raised under the lane brief (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0337)" }],
  ["PUT /v1/discovery/entitlements/apps/:appId/agent-link", { does: "links a vendor app to an agent by hand (a partial or fuzzy match), audited", tracking: "ADR-0337 §6 (lane E18): owner decision 2026-11-17 (vendor-app auto-link to agents, admin link and unlink) is API-only in the lane brief; the graph and link screen is requested on #453. raised under the lane brief (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0337)" }],
  ["DELETE /v1/discovery/entitlements/apps/:appId/agent-link", { does: "unlinks a vendor app from its agent (auto or manual), audited; it is not auto-linked again", tracking: "ADR-0337 §6 (lane E18): owner decision 2026-11-17 (vendor-app auto-link to agents, admin link and unlink) is API-only in the lane brief; the graph and link screen is requested on #453. raised under the lane brief (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0337)" }],
  ["GET /v1/discovery/agent-identifiers", { does: "lists the vendor app identifiers declared for agents", tracking: "ADR-0337 §6 (lane E18): owner decision 2026-11-17 (vendor-app auto-link to agents, admin link and unlink) is API-only in the lane brief; the graph and link screen is requested on #453. raised under the lane brief (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0337)" }],
  ["POST /v1/discovery/agent-identifiers", { does: "declares an agent's app id on one platform; apps with exactly that id are auto-linked, each audited", tracking: "ADR-0337 §6 (lane E18): owner decision 2026-11-17 (vendor-app auto-link to agents, admin link and unlink) is API-only in the lane brief; the graph and link screen is requested on #453. raised under the lane brief (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0337)" }],
  ["DELETE /v1/discovery/agent-identifiers/:identifierId", { does: "removes a declared identifier (audited); existing links stay until an admin unlinks them", tracking: "ADR-0337 §6 (lane E18): owner decision 2026-11-17 (vendor-app auto-link to agents, admin link and unlink) is API-only in the lane brief; the graph and link screen is requested on #453. raised under the lane brief (new routes go to the census with a KNOWN_UI_GAPS entry on #453; recorded in ADR-0337)" }],
  ["GET /v1/agent-risk", { does: "ranks agents (registry or builder) by their newest stored risk score, with the count not yet scored (admin)", tracking: "ADR-0339 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["GET /v1/agent-risk/:kind/:subjectId", { does: "one agent's live risk score: every factor with its OWASP ids, reach, toxic combinations and ranked fixes, plus the newest stored assessment", tracking: "ADR-0339 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["GET /v1/agent-risk/:kind/:subjectId/history", { does: "pages one agent's stored risk assessments, newest first, each with what triggered it", tracking: "ADR-0339 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["POST /v1/agent-risk/recompute", { does: "runs the risk recompute sweep now, optionally for one agent (admin, audited per assessment)", tracking: "ADR-0339 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["GET /v1/agent-identity/:kind/:subjectId", { does: "one agent's author, runner (workload identity, invokers), ownership flag and linked non-human identities", tracking: "ADR-0339 slice 2 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["GET /v1/agent-identity/ownership-findings", { does: "pages agents whose owner is missing, deactivated or inactive (admin)", tracking: "ADR-0339 slice 2 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["POST /v1/agent-identity/:kind/:subjectId/links", { does: "stages a cloud service account, vendor agent identity or OAuth client link for an agent (admin, audited; confers nothing)", tracking: "ADR-0339 slice 2 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["POST /v1/agent-identity/links/:linkId/decision", { does: "confirms or rejects a staged identity link (a second named admin, identity_manage step-up, audited)", tracking: "ADR-0339 slice 2 (lane E20): API-only, master brief for lane E20 2026-11-16; the screen goes to the UI builder on #453" }],
  ["GET /v1/process-analytics/templates", { does: "per workflow template: instances started and ended by status, cycle time percentiles, rework rate and open instances in a window", tracking: "ADR-0342 (lane E23): API-only by the lane brief (no screens); the process analytics dashboard is posted on #453 for the design builder" }],
  ["GET /v1/process-analytics/stages", { does: "per workflow stage, ranked by total wait time (the bottleneck ranking): visits, duration percentiles, wait vs work, rework and open visits", tracking: "ADR-0342 (lane E23): API-only by the lane brief (no screens); the process analytics dashboard is posted on #453 for the design builder" }],
  ["GET /v1/process-analytics/heatmap", { does: "stage x period heatmap cells (visits, median duration, wait) for the stages with the most wait", tracking: "ADR-0342 (lane E23): API-only by the lane brief (no screens); the process analytics dashboard is posted on #453 for the design builder" }],
  ["GET /v1/process-analytics/throughput", { does: "per period: workflow instances started and ended by terminal status", tracking: "ADR-0342 (lane E23): API-only by the lane brief (no screens); the process analytics dashboard is posted on #453 for the design builder" }],
  ["POST /v1/process-analytics/refresh", { does: "runs one process analytics projection pass from the workflow history now (admin, audited)", tracking: "ADR-0342 (lane E23): API-only by the lane brief (no screens); the process analytics dashboard is posted on #453 for the design builder" }],
  ["POST /v1/discovery/endpoint-addon-removals", { does: "requests the removal of one flagged MCP server identity from endpoints (endpoint_remediation step-up, then a second administrator's approval; audited; off until the org switch is on)", tracking: "ADR-0331; screen requested on #453" }],
  ["GET /v1/discovery/endpoint-addon-removals", { does: "lists add-on removals, newest first, with their target counts per status", tracking: "ADR-0331; screen requested on #453" }],
  ["GET /v1/discovery/endpoint-addon-removals/:id", { does: "one add-on removal and its per-endpoint targets with each outcome, code and whether the developer was notified", tracking: "ADR-0331; screen requested on #453" }],
  ["POST /v1/discovery/endpoint-addon-removals/:id/cancel", { does: "cancels a removal: its undelivered targets are stopped and a pending approval is withdrawn; delivered ones keep their real outcome (audited, no step-up)", tracking: "ADR-0331; screen requested on #453" }],
  ["GET /v1/robots", { does: "pages the robots the caller owns (all, for an admin) with their computed status and how many agents use them", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["POST /v1/robots", { does: "creates a robot (browser engine only in this release), owned by the caller, audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["GET /v1/robots/:robotId", { does: "one robot with every version (content, allow-list, bindings, lifecycle) and its secrets' names and last four (never a value)", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["POST /v1/robots/:robotId/retire", { does: "retires a robot: approved versions retired and their tools halted, drafts discarded, a pending review superseded, audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["POST /v1/robots/:robotId/versions", { does: "drafts a new robot version (steps_v1 script, https allow-list, secret bindings), audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["PUT /v1/robots/:robotId/versions/:version", { does: "replaces a draft version's content; refused once it is submitted (frozen), audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["POST /v1/robots/:robotId/versions/:version/submit", { does: "submits a draft for review in the approvals queue, bound to its content digest; needs a passing test run on that digest, audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["POST /v1/robots/:robotId/versions/:version/retire", { does: "retires an approved robot version and halts its tool, audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["PUT /v1/robots/:robotId/secrets/:name/:scope", { does: "sets a robot's live or test secret, encrypted (settings_relax step-up, audited without the value)", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
  ["DELETE /v1/robots/:robotId/secrets/:name/:scope", { does: "clears a robot secret no submitted version is bound to, audited", tracking: "ADR-0364 S2 (lane E45): API-only by the master brief (2026-11-19); the Robots screens (list, detail, review) are for the design builder on #453" }],
]);

/**
 * The ratchet. Equal to KNOWN_UI_GAPS.size, always: the run fails when the
 * list is longer (a new gap) AND when it is shorter (lower this to match), so
 * the number only ever goes down. The census test pins an upper bound too, so
 * raising it is a visible two-file diff. Lowered by seven: the ADR-0241 (P21)
 * usage-extractor routes are called by the Agents page's usage-counts card
 * (owner-approved on #453, 2026-11-07).
 */
export const KNOWN_UI_GAPS_MAX = 146; // + ADR-0363 slice 2 (lane E44) 6 API-only customer-classifier routes awaiting #453; + ADR-0364 S2 (lane E45) 10 API-only robot routes awaiting #453; main's 130: + ADR-0337 §6 (lane E18) 6 API-only entitlement app and agent-identifier routes, owner decision 2026-11-17 (#453); main's 124: + ADR-0339 slice 2 (lane E20) 4 API-only agent identity routes (#453); ADR-0331 (lane E13) 4 add-on removal admin routes, raised for the master's review (#453) + + ADR-0327 addendum (lane E12) 4 API-only decision-table routes, owner approval relayed by the master 2026-11-17 (UI-D builds the editor, #453); + ADR-0333 (E15) 5 detection routes awaiting #453; + ADR-0334 (lane E16) 11 API-only browser governance admin routes awaiting the screens on #453; + ADR-0339 (lane E20) 4 API-only agent risk score routes (#453); main's 79 less the seven ADR-0241 (P21) routes, which now have their screen; + ADR-0363 slice 1 (lane E44) 4 API-only sensitivity-label routes awaiting #453; + ADR-0342 (lane E23) 5 API-only process analytics routes, awaiting the dashboard on #453; main's 54 − 11 MCP bundle routes closed by #815 + ADR-0240 6 external-portal second-factor routes awaiting #453 (#709) + ADR-0332 (lane E14) 3 API-only endpoint add-on inventory routes, master brief for lane E14 2026-11-15 (screen by the UI builder, #453); + ADR-0230 A2 (P19, Lane L3) 3 SAP business server routes, master decision in the Lane L3 brief 2026-11-14, recorded in ADR-0230, section Recorded decision (2026-11-14); + lane L7 (P14 + P16) 2 model-file lineage routes + ADR-0327 (lane E12) 6 rule-like step routes (5 + the suggestions export) + ADR-0310 (lane E1) 4 API-only managed-settings routes (3 bundle + 1 drift) awaiting #453 (lane brief rule 3, recorded in ADR-0310); + ADR-0289 (L6) 2 API-only PM importer routes, owner answer relayed by the master session 2026-11-15 (recorded in the #828 body) + ADR-0327 slice 3b (lane E12) 2 shadow-mode routes + ADR-0312 (lane E2) 7 cost-per-outcome and spend-budget routes awaiting #453 + ADR-0314 (lane E3) 3 API-only agent registry routes, master brief for lane E3 (2026-11-15): new routes are API-only with a KNOWN_UI_GAPS entry pointing at #453; + ADR-0322 (lane E7) 9 vendor usage pull routes awaiting #453 (lane brief: API-only, KNOWN_UI_GAPS entries pointing at #453)

const VERB_KEY = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "del" };

/** `ROUTE_STABILITY`'s keys, as `{ method, path }` (the registry the live-inventory test holds exact) */
export function registryRoutes(registrySrc) {
  const start = registrySrc.indexOf("export const ROUTE_STABILITY");
  if (start === -1) throw new Error("openapi-registry.ts: ROUTE_STABILITY not found");
  const end = registrySrc.indexOf("\n};", start);
  const out = [];
  for (const line of registrySrc.slice(start, end).split("\n")) {
    const m = /^\s{0,8}"(GET|POST|PUT|PATCH|DELETE) (\/[^"\s]{0,300})":/.exec(line);
    if (m) out.push({ method: m[1], path: m[2] });
  }
  return out;
}

/** a list key split into method and path */
const parseKey = (key) => {
  const sp = key.indexOf(" ");
  return { method: key.slice(0, sp), path: key.slice(sp + 1) };
};

/** null when a MACHINE_ONLY key is acceptable, else why not */
export function validatePattern(key) {
  const { method, path: p } = parseKey(key);
  if (method !== "*" && !VERB_KEY[method]) return `unknown verb '${method}'`;
  if (!p.startsWith("/")) return "path must start with /";
  if (p.includes("*") && !p.endsWith("/*")) return "a wildcard may only end the path, as /*";
  if (p.endsWith("/*")) {
    const segs = p.slice(1, -2).split("/").filter(Boolean);
    if (segs.length === 0) return "a blanket /* covers every route";
    if (segs[0] === "v1" && segs.length < 2) return "a blanket /v1/* covers the whole API; name the collection";
    if (segs.slice(0, segs[0] === "v1" ? 2 : 1).some((s) => s.startsWith(":"))) return "a pattern's collection must be literal";
  }
  return null;
}

/** where the scheduler job names a SUPERSEDED `job` must appear live */
const SCHEDULER_JOBS_FILE = "apps/gateway/src/scheduler-jobs.ts";

/**
 * The job names `SCHEDULER_JOB_NAMES` defines in scheduler-jobs.ts: its `key: "name"` entries, read with comments
 * removed. A real match, not a substring search: a name only in a comment, or in a string outside the constant, is
 * not a job. Null when the file or the constant is missing (every superseded `job` is then stale).
 */
export function schedulerJobNames(text) {
  if (typeof text !== "string") return null;
  const block = /export const SCHEDULER_JOB_NAMES = \{([\s\S]*?)\n\} as const;/.exec(text);
  if (!block) return null;
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const names = new Set();
  for (const m of body.matchAll(/^\s*[A-Za-z_$][\w$]*\s*:\s*"([^"\n]+)"\s*,?\s*$/gm)) names.add(m[1]);
  return names;
}

/** is a MACHINE_ONLY key a prefix pattern (rather than one exact route)? */
const isPattern = (key) => key.endsWith("/*");

/** does a list key (exact or pattern) cover the route? */
export function keyCovers(key, route) {
  const { method, path: p } = parseKey(key);
  if (method !== "*" && method !== route.method) return false;
  if (!p.endsWith("/*")) return p === route.path;
  const prefix = p.slice(0, -1); // keeps the trailing slash
  return route.path.startsWith(prefix) && route.path.length > prefix.length;
}

/**
 * Which routes the UI reaches. Segment-wise like the affordance census (`:x`
 * on either side, never in the collection segment), plus one tightening the
 * all-verb census needs: a call reaches only the BEST-FITTING routes (most
 * segments equal). So `/v1/agents/${id}` reaches `/v1/agents/:agentId`, not
 * its literal sibling `/v1/agents/discover`; and `/v1/receipts/status`
 * reaches that route, not `/v1/receipts/:auditId`. Only when nothing fits
 * better does a parameter stand in for a literal (`/v1/users/me/agents`
 * reaching `/v1/users/:userId/agents`, or a helper building a segment from a
 * variable).
 */
export function reachedRoutes(routes, ui) {
  const reached = new Set();
  const byVerb = new Map();
  for (const r of routes) {
    const v = VERB_KEY[r.method];
    if (!byVerb.has(v)) byVerb.set(v, []);
    byVerb.get(v).push({ route: r, n: norm(r.path) });
  }
  for (const [verb, uiPaths] of Object.entries(ui)) {
    const candidates = byVerb.get(verb) ?? [];
    for (const u of uiPaths) {
      const matches = candidates.filter((c) => segmentMatch(c.n, new Set([u])));
      // positions where route and call agree exactly (literal = literal, parameter = parameter)
      const b = u.split("/");
      const score = (c) => c.n.split("/").filter((seg, i) => seg === b[i]).length;
      const best = Math.max(...matches.map(score));
      for (const c of matches) if (score(c) === best) reached.add(`${c.route.method} ${c.route.path}`);
    }
  }
  return reached;
}

/**
 * The census over plain data, so a test can drive it. Returns the counts and
 * every failure as `{ kind, key, detail }`.
 */
export function census({
  routes,
  ui,
  notBuilt = new Set(),
  fileText = () => null,
  machineOnly = MACHINE_ONLY,
  superseded = SUPERSEDED,
  indirect = INDIRECT_UI_CALLS,
  knownGaps = KNOWN_UI_GAPS,
  knownGapsMax = KNOWN_UI_GAPS_MAX,
}) {
  const failures = [];
  const fail = (kind, key, detail) => failures.push({ kind, key, detail });
  const keyOf = (r) => `${r.method} ${r.path}`;
  const all = new Set(routes.map(keyOf));
  const reached = reachedRoutes(routes, ui);
  const isStub = (r) => notBuilt.has(`${r.method} ${norm(r.path)}`);

  for (const key of machineOnly.keys()) {
    const bad = validatePattern(key);
    if (bad) fail("bad-pattern", key, bad);
  }
  const lists = [
    ["superseded", superseded],
    ["indirect", indirect],
    ["known-gap", knownGaps],
  ];
  for (const [name, list] of lists) {
    for (const key of list.keys()) {
      if (!all.has(key)) fail("stale", key, `listed as ${name} but the gateway serves no such route`);
    }
  }
  for (const [key, entry] of machineOnly) {
    const covered = routes.filter((r) => keyCovers(key, r)).length;
    if (covered === 0) fail("stale", key, "machine-only entry covers no route the gateway serves");
    else if (isPattern(key) && entry?.matches !== covered) {
      fail("pattern-count", key, `the pattern covers ${covered} routes but pins ${entry?.matches}: a route was added or removed under it; review it, then update \`matches\``);
    }
  }

  const counts = { total: routes.length, ui: 0, stubs: 0, machineOnly: 0, superseded: 0, indirect: 0, knownGaps: 0, gaps: 0 };
  const byCategory = new Map();
  for (const r of routes) {
    const key = keyOf(r);
    const listedAs = [];
    const machine = [...machineOnly.keys()].filter((k) => keyCovers(k, r));
    if (machine.length > 0) listedAs.push("machine-only");
    for (const [name, list] of lists) if (list.has(key)) listedAs.push(name);
    if (listedAs.length > 1) fail("double-listed", key, `listed as ${listedAs.join(" and ")}; pick one`);

    if (isStub(r)) {
      counts.stubs += 1;
      if (listedAs.length > 0) fail("stale", key, `listed as ${listedAs[0]} but it is a 501 notBuilt stub, which the census already skips`);
      continue;
    }
    if (reached.has(key)) {
      counts.ui += 1;
      if (listedAs.length > 0) {
        const where = machine.length > 0 ? `machine-only (${machine[0]})` : listedAs[0];
        fail("stale", key, `the UI calls it, but it is listed as ${where}; delete or narrow the entry`);
      }
      continue;
    }
    if (machine.length > 0) {
      counts.machineOnly += 1;
      byCategory.set(machine[0], (byCategory.get(machine[0]) ?? 0) + 1);
      continue;
    }
    if (superseded.has(key)) {
      counts.superseded += 1;
      const { replacement, job } = superseded.get(key);
      if (!all.has(replacement)) fail("stale", key, `superseded by ${replacement}, which the gateway does not serve`);
      else if (!reached.has(replacement)) fail("stale", key, `superseded by ${replacement}, which the UI does not call either`);
      if (job !== undefined && !(schedulerJobNames(fileText(SCHEDULER_JOBS_FILE))?.has(job) ?? false)) {
        fail("stale", key, `superseded by scheduler job '${job}', which ${SCHEDULER_JOBS_FILE} no longer names`);
      }
      continue;
    }
    if (indirect.has(key)) {
      counts.indirect += 1;
      const { file, evidence, pathIn = file } = indirect.get(key);
      const text = fileText(file);
      const pathText = fileText(pathIn);
      if (text === null) fail("stale", key, `indirect-call evidence file ${file} does not exist`);
      else if (!text.includes(evidence)) fail("stale", key, `indirect-call evidence '${evidence}' is no longer in ${file}`);
      else if (pathText === null || !segmentMatch(norm(r.path), literalPathsIn(pathText, pathIn))) {
        fail("stale", key, `the route's own path is no longer written in ${pathIn}`);
      }
      continue;
    }
    if (knownGaps.has(key)) {
      counts.knownGaps += 1;
      continue;
    }
    counts.gaps += 1;
    fail("no-ui", key, "no screen calls it and no list explains why");
  }

  if (knownGaps.size > knownGapsMax) {
    fail("gap-ratchet", "KNOWN_UI_GAPS", `${knownGaps.size} entries but KNOWN_UI_GAPS_MAX is ${knownGapsMax}: build the screen instead of listing a new gap`);
  } else if (knownGaps.size < knownGapsMax) {
    fail("gap-ratchet", "KNOWN_UI_GAPS_MAX", `the list has ${knownGaps.size} entries: lower KNOWN_UI_GAPS_MAX (and the test's bound) to ${knownGaps.size}`);
  }
  for (const [key, entry] of knownGaps) {
    if (!entry?.does || !entry?.tracking) fail("bad-entry", key, "a known gap needs `does` and `tracking`");
  }
  for (const [key, entry] of superseded) {
    if (!entry?.replacement || !entry?.reason) fail("bad-entry", key, "a superseded entry needs `replacement` and `reason`");
  }
  for (const [key, entry] of machineOnly) {
    const reason = typeof entry === "string" ? entry : entry?.reason;
    if (typeof reason !== "string" || reason.length < 12) fail("bad-entry", key, "a machine-only entry needs a reason a reviewer can check");
    if (isPattern(key) && !Number.isInteger(entry?.matches)) fail("bad-entry", key, "a pattern entry pins `matches`, the number of routes it covers");
  }
  return { counts, byCategory, failures };
}

function main() {
  const routes = registryRoutes(readFileSync(path.join(root, "apps/gateway/src/openapi-registry.ts"), "utf8"));
  if (routes.length < 100) {
    console.error(`preflight-ui-route-census: read only ${routes.length} routes from openapi-registry.ts — the scan is broken, not the app`);
    return 2;
  }
  const ui = scanWeb(path.join(root, "apps/web/src"));
  const notBuilt = scanNotBuilt(path.join(root, "apps/gateway/src"));
  const fileText = (rel) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const { counts, byCategory, failures } = census({ routes, ui, notBuilt, fileText });

  console.log(
    `route census: ${counts.total} routes — ${counts.ui} called by the UI, ${counts.machineOnly} machine-only, ` +
      `${counts.superseded} superseded, ${counts.indirect} indirect, ${counts.stubs} 501 stubs, ` +
      `${counts.knownGaps} KNOWN UI GAPS, ${counts.gaps} unexplained`,
  );
  for (const [k, n] of [...byCategory].sort()) console.log(`  machine-only ${String(n).padStart(3)}  ${k}`);

  if (KNOWN_UI_GAPS.size > 0) {
    console.log("");
    console.log("!!".repeat(36));
    console.log(`!! ${KNOWN_UI_GAPS.size} KNOWN UI GAPS — built capabilities with no screen yet (temporary; the count may only go down)`);
    for (const [key, g] of KNOWN_UI_GAPS) console.log(`!!   ${key.padEnd(44)} ${g.does}  [${g.tracking}]`);
    console.log("!!".repeat(36));
  }

  if (failures.length > 0) {
    console.error("");
    for (const f of failures) console.error(`  ${f.kind.toUpperCase().padEnd(14)} ${f.key} — ${f.detail}`);
    console.error(
      "\nA route nothing on screen calls is a capability a user cannot use. Build the\n" +
        "screen, or, if no human should ever call it, add it to MACHINE_ONLY in\n" +
        "scripts/preflight-ui-route-census.mjs with a reason somebody can check.",
    );
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error("preflight-ui-route-census could not run:", e);
    process.exit(2);
  }
}

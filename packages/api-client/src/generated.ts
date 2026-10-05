// ============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Emitted by apps/gateway/src/openapi-client-gen.ts from the OpenAPI document,
// which is itself generated from the gateway's live route inventory and the zod
// schemas its handlers enforce. Editing this file is how the client starts
// lying about the API; apps/gateway/src/openapi.test.ts re-renders it and fails
// when the checked-in bytes differ.
//
// Regenerate with:  REGULAIT_WRITE_API_ARTIFACTS=1 pnpm --filter @regulait/gateway exec vitest run src/openapi.test.ts
//
// Spec version: 1.0.0
// Operations:   73
//
// RESPONSES ARE `unknown` BY DESIGN. The gateway's routes declare request
// schemas but not response schemas, so there is nothing to derive a response
// type FROM. Each method takes a type parameter so a caller can assert the
// shape they expect; inventing one here would be a hand-maintained fiction.
// ============================================================================
import { BaseClient, type RequestOptions } from "./base-client.js";

export type PostV1AgentsByAgentIdInvokeBody = {
    mode: string;
    input?: string;
    system?: string;
    baseline?: string;
    referenceContent?: string;
    attachments?: Array<{
      kind: "image" | "document";
      name: string;
      mediaType: string;
      dataBase64: string;
    }>;
    semanticCache?: boolean;
    costSensitivity?: "cost-sensitive" | "standard" | "quality-sensitive";
    dispatch?: boolean;
    maxTokens?: number;
    stream?: boolean;
    projectId?: string;
    instanceId?: string;
    conversationId?: string;
  };

export type PostV1ApprovalsByApprovalIdDecideBody = {
    decision: "approved" | "denied" | "returned";
    reason?: string;
    conditions?: Array<{
      text: string;
      ownerUserId?: string;
      dueAt: string;
      blocking: boolean;
      kind: "manual";
    } | {
      kind: "metric" | "test_class" | "autonomy_floor";
      text: string;
      ownerUserId?: string;
      dueAt?: string;
      blocking: boolean;
      metric: "trace_eval_flag_rate" | "guardrail_hits" | "guardrail_mode" | "redteam_asr" | "eval_mean_score" | "eval_pass_rate" | "spend_usd" | "error_rate" | "pack_control_evidenced";
      params?: Record<string, unknown>;
      operator: "lt" | "lte" | "gt" | "gte" | "eq";
      threshold: number;
      windowDays: number;
      minSamples: number;
      cadence?: "hourly" | "daily" | "weekly";
      onBreach?: "alert" | "reopen_review";
    }>;
    acceptRisks?: {
      riskIds: Array<string>;
      rationale: string;
    };
  };

export type PostV1ConnectorsByConnectorIdInvokeBody = {
    operation: "read" | "write";
    object?: string;
    payload?: Record<string, unknown>;
    projectId?: string;
  };

export type PostV1EvaluateBody = {
    userId: string;
    serverId: string;
    toolName: string;
  };

export type PostV1ProjectsBody = {
    name: string;
    costCenter?: string;
    budgetUsd?: number;
    budgetApproverUserId?: string;
    budgetPeriod?: "none" | "monthly";
    alertThresholdPct?: number;
    arbiterUserId?: string;
    classifications?: Array<string>;
    initiativeId?: string;
  };

export type PostV1RolesBody = {
    name: string;
    description?: string;
  };

export type PostV1UsersBody = {
    email: string;
    displayName: string;
    isAdmin?: boolean;
  };

export type PostV1UsersByUserIdDeactivateBody = {
    reason?: string;
  };

export type PostV1UsersByUserIdKeysBody = {
    name: string;
    expiresAt?: string;
  };

export type PostV1UsersByUserIdRolesBody = {
    roleId: string;
  };

export class GeneratedRegulAItClient extends BaseClient {
  /**
 * GET /.well-known/oauth-protected-resource
 * @stability public-stable — auth: public
   */
  getWellKnownOauthProtectedResource<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/.well-known/oauth-protected-resource`, undefined, options);
  }

  /**
 * GET /.well-known/oauth-protected-resource/mcp/:serverId
 * @stability public-stable — auth: public
   */
  getWellKnownOauthProtectedResourceMcpByServerId<T = unknown>(serverId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(serverId)}`, undefined, options);
  }

  /**
 * Liveness probe. The only route that is never rate limited.
 * @stability public-stable — auth: public
   */
  getHealth<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/health`, undefined, options);
  }

  /**
 * The governed MCP proxy. Speaks the MCP wire protocol; every tool call is entitlement-checked.
 * @stability public-beta — auth: user
 * @compat body/response shaped by the upstream vendor: https://modelcontextprotocol.io/specification
   */
  postMcpByServerId<T = unknown>(serverId: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/mcp/${encodeURIComponent(serverId)}`, body, options);
  }

  /**
 * Registered agents/models. Bounded: `limit` (default 1000, max 5000).
 * @stability public-stable — auth: admin
   */
  getV1Agents<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/agents`, undefined, options);
  }

  /**
 * Dispatch an agent. Governed, metered and audited like every other gateway call.
 * @stability public-stable — auth: user
   */
  postV1AgentsByAgentIdInvoke<T = unknown>(agentId: string, body: PostV1AgentsByAgentIdInvokeBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/agents/${encodeURIComponent(agentId)}/invoke`, body, options);
  }

  /**
 * The versioning and deprecation policy, plus every route currently on a sunset clock, as machine-readable data.
 * @stability public-stable — auth: user
   */
  getV1ApiVersioning<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/api/versioning`, undefined, options);
  }

  /**
 * The approvals queue, scoped to what the caller may see.
 * @stability public-stable — auth: user
   */
  getV1Approvals<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/approvals`, undefined, options);
  }

  /**
 * Approve or deny a pending request. Non-admin by design — the named approver is usually not an admin.
 * @stability public-stable — auth: user
   */
  postV1ApprovalsByApprovalIdDecide<T = unknown>(approvalId: string, body: PostV1ApprovalsByApprovalIdDecideBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/approvals/${encodeURIComponent(approvalId)}/decide`, body, options);
  }

  /**
 * The audit log — every governed decision, paged, filterable by user, object type, effect and time window.
 * @stability public-stable — auth: admin
   */
  getV1Audit<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/audit`, undefined, options);
  }

  /**
 * The audit log as a streamed CSV export, with an explicit disclosure when rows fall outside the exported window.
 * @stability public-stable — auth: admin
   */
  getV1AuditCsv<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/audit.csv`, undefined, options);
  }

  /**
 * POST /v1/authz/check
 * @stability public-stable — auth: admin
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1AuthzCheck<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/authz/check`, body, options);
  }

  /**
 * Billing statements the caller may see.
 * @stability public-beta — auth: user
   */
  getV1BillingStatements<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/billing/statements`, undefined, options);
  }

  /**
 * One billing statement.
 * @stability public-beta — auth: user
   */
  getV1BillingStatementsById<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/billing/statements/${encodeURIComponent(id)}`, undefined, options);
  }

  /**
 * OpenAI-shaped compatibility surface (ADR-0024). Off-the-shelf OpenAI clients point here unchanged.
 * @stability public-beta — auth: user
 * @compat body/response shaped by the upstream vendor: https://platform.openai.com/docs/api-reference/chat
   */
  postV1ChatCompletions<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/chat/completions`, body, options);
  }

  /**
 * Registered connectors.
 * @stability public-stable — auth: admin
   */
  getV1Connectors<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/connectors`, undefined, options);
  }

  /**
 * Invoke a connector.
 * @stability public-stable — auth: user
   */
  postV1ConnectorsByConnectorIdInvoke<T = unknown>(connectorId: string, body: PostV1ConnectorsByConnectorIdInvokeBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/connectors/${encodeURIComponent(connectorId)}/invoke`, body, options);
  }

  /**
 * The caller's conversations.
 * @stability public-beta — auth: user
   */
  getV1Conversations<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/conversations`, undefined, options);
  }

  /**
 * Create a conversation.
 * @stability public-beta — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1Conversations<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/conversations`, body, options);
  }

  /**
 * One conversation.
 * @stability public-beta — auth: user
   */
  getV1ConversationsByConversationId<T = unknown>(conversationId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/conversations/${encodeURIComponent(conversationId)}`, undefined, options);
  }

  /**
 * Delete a conversation.
 * @stability public-beta — auth: user
   */
  deleteV1ConversationsByConversationId<T = unknown>(conversationId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", `/v1/conversations/${encodeURIComponent(conversationId)}`, undefined, options);
  }

  /**
 * The raw cost ledger, one row per priced gateway call.
 * @stability public-stable — auth: user
   */
  getV1CostEvents<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/cost-events`, undefined, options);
  }

  /**
 * Start an evaluation run. Governed by the caller's own agent entitlement.
 * @stability public-beta — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1EvalsRuns<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/evals/runs`, body, options);
  }

  /**
 * The governance decision itself: may this user call this tool, right now, with this input? Returns the effect and the rule chain that produced it.
 * @stability public-stable — auth: admin
   */
  postV1Evaluate<T = unknown>(body: PostV1EvaluateBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/evaluate`, body, options);
  }

  /**
 * List API keys (metadata only — never the token).
 * @stability public-stable — auth: admin
   */
  getV1Keys<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/keys`, undefined, options);
  }

  /**
 * Revoke an API key immediately.
 * @stability public-stable — auth: admin
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1KeysByKeyIdRevoke<T = unknown>(keyId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/keys/${encodeURIComponent(keyId)}/revoke`, body, options);
  }

  /**
 * Context provenance edges, narrowed to the caller's project memberships.
 * @stability public-beta — auth: user
   */
  getV1Lineage<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/lineage`, undefined, options);
  }

  /**
 * Lineage nodes.
 * @stability public-beta — auth: user
   */
  getV1LineageNodes<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/lineage/nodes`, undefined, options);
  }

  /**
 * Lineage for one orchestration run.
 * @stability public-beta — auth: user
   */
  getV1LineageRunsByRunId<T = unknown>(runId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/lineage/runs/${encodeURIComponent(runId)}`, undefined, options);
  }

  /**
 * Identity echo — who the presented credential is, and the org size ceilings a client needs to pre-validate uploads.
 * @stability public-stable — auth: user
   */
  getV1Me<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/me`, undefined, options);
  }

  /**
 * Anthropic-shaped compatibility surface (ADR-0020). Off-the-shelf Anthropic clients point here unchanged.
 * @stability public-beta — auth: user
 * @compat body/response shaped by the upstream vendor: https://docs.anthropic.com/en/api/messages
   */
  postV1Messages<T = unknown>(body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/messages`, body, options);
  }

  /**
 * GET /v1/models
 * @stability public-beta — auth: user
   */
  getV1Models<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/models`, undefined, options);
  }

  /**
 * This document. `?include=all` additionally renders internal routes (admin only) — those carry no compatibility guarantee.
 * @stability public-stable — auth: user
   */
  getV1OpenapiJson<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/openapi.json`, undefined, options);
  }

  /**
 * Projects visible to the caller.
 * @stability public-stable — auth: user
   */
  getV1Projects<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/projects`, undefined, options);
  }

  /**
 * Create a project.
 * @stability public-stable — auth: admin
   */
  postV1Projects<T = unknown>(body: PostV1ProjectsBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/projects`, body, options);
  }

  /**
 * Per-project AI spend, attributed at the point of every gateway call (pillar 5).
 * @stability public-stable — auth: user
   */
  getV1ProjectsByProjectIdCosts<T = unknown>(projectId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/projects/${encodeURIComponent(projectId)}/costs`, undefined, options);
  }

  /**
 * The same ledger as a streamed CSV export.
 * @stability public-stable — auth: user
   */
  getV1ProjectsByProjectIdCostsCsv<T = unknown>(projectId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/projects/${encodeURIComponent(projectId)}/costs.csv`, undefined, options);
  }

  /**
 * Generated report runs the caller may see.
 * @stability public-beta — auth: user
   */
  getV1ReportsRuns<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/reports/runs`, undefined, options);
  }

  /**
 * One report run.
 * @stability public-beta — auth: user
   */
  getV1ReportsRunsById<T = unknown>(id: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/reports/runs/${encodeURIComponent(id)}`, undefined, options);
  }

  /**
 * List roles.
 * @stability public-stable — auth: admin
   */
  getV1Roles<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/roles`, undefined, options);
  }

  /**
 * Create a role.
 * @stability public-stable — auth: admin
   */
  postV1Roles<T = unknown>(body: PostV1RolesBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/roles`, body, options);
  }

  /**
 * Delete a role and every grant it carried.
 * @stability public-stable — auth: admin
   */
  deleteV1RolesByRoleId<T = unknown>(roleId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", `/v1/roles/${encodeURIComponent(roleId)}`, undefined, options);
  }

  /**
 * The users currently holding a role.
 * @stability public-stable — auth: admin
   */
  getV1RolesByRoleIdAssignments<T = unknown>(roleId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/roles/${encodeURIComponent(roleId)}/assignments`, undefined, options);
  }

  /**
 * Every grant a role confers — tools, servers, agents and connectors.
 * @stability public-stable — auth: admin
   */
  getV1RolesByRoleIdGrants<T = unknown>(roleId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/roles/${encodeURIComponent(roleId)}/grants`, undefined, options);
  }

  /**
 * Orchestration runs, newest first. Bounded: `limit` (default 200, max 1000); `status` narrows.
 * @stability public-beta — auth: user
   */
  getV1Runs<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/runs`, undefined, options);
  }

  /**
 * Start a multi-agent orchestration run (pillar 7).
 * @stability public-beta — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1Runs<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/runs`, body, options);
  }

  /**
 * Decompose a goal into a task DAG without executing it.
 * @stability public-beta — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1RunsDecompose<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/runs/decompose`, body, options);
  }

  /**
 * One orchestration run with its task graph.
 * @stability public-beta — auth: user
   */
  getV1RunsByRunId<T = unknown>(runId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/runs/${encodeURIComponent(runId)}`, undefined, options);
  }

  /**
 * Registered MCP servers.
 * @stability public-stable — auth: admin
   */
  getV1Servers<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/servers`, undefined, options);
  }

  /**
 * Anomaly flags for the caller's own projects.
 * @stability public-beta — auth: user
   */
  getV1SpendAnomalies<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/spend/anomalies`, undefined, options);
  }

  /**
 * Spend projection for the caller's own projects.
 * @stability public-beta — auth: user
   */
  getV1SpendForecast<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/spend/forecast`, undefined, options);
  }

  /**
 * The raw usage ledger, one row per governed call (priced or not).
 * @stability public-stable — auth: user
   */
  getV1UsageEvents<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/usage-events`, undefined, options);
  }

  /**
 * List users, with sign-in posture flags (never a hash or a secret). Bounded: `limit` (default 1000, max 5000).
 * @stability public-stable — auth: admin
   */
  getV1Users<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/users`, undefined, options);
  }

  /**
 * Provision a user. Refused when the licensed seat cap is reached (ADR-0052) — a growth gate, never a service gate.
 * @stability public-stable — auth: admin
   */
  postV1Users<T = unknown>(body: PostV1UsersBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/users`, body, options);
  }

  /**
 * Minimal user directory for pickers — id, email, display name.
 * @stability public-stable — auth: user
   */
  getV1UsersDirectory<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/users/directory`, undefined, options);
  }

  /**
 * Update a user's mutable profile fields.
 * @stability public-stable — auth: admin
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  patchV1UsersByUserId<T = unknown>(userId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", `/v1/users/${encodeURIComponent(userId)}`, body, options);
  }

  /**
 * The agents this user is entitled to dispatch.
 * @stability public-stable — auth: user
   */
  getV1UsersByUserIdAgents<T = unknown>(userId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/users/${encodeURIComponent(userId)}/agents`, undefined, options);
  }

  /**
 * The connectors this user is entitled to invoke.
 * @stability public-stable — auth: user
   */
  getV1UsersByUserIdConnectors<T = unknown>(userId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/users/${encodeURIComponent(userId)}/connectors`, undefined, options);
  }

  /**
 * Deactivate a user. Keys and sessions stop authenticating immediately; nothing is deleted.
 * @stability public-stable — auth: admin
   */
  postV1UsersByUserIdDeactivate<T = unknown>(userId: string, body: PostV1UsersByUserIdDeactivateBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/users/${encodeURIComponent(userId)}/deactivate`, body, options);
  }

  /**
 * Mint an API key for a user. The plaintext is returned exactly once and never stored.
 * @stability public-stable — auth: admin
   */
  postV1UsersByUserIdKeys<T = unknown>(userId: string, body: PostV1UsersByUserIdKeysBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/users/${encodeURIComponent(userId)}/keys`, body, options);
  }

  /**
 * Reactivate a deactivated user. Their unrevoked keys resume working unchanged.
 * @stability public-stable — auth: admin
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1UsersByUserIdReactivate<T = unknown>(userId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/users/${encodeURIComponent(userId)}/reactivate`, body, options);
  }

  /**
 * Assign a role to a user.
 * @stability public-stable — auth: admin
   */
  postV1UsersByUserIdRoles<T = unknown>(userId: string, body: PostV1UsersByUserIdRolesBody, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/users/${encodeURIComponent(userId)}/roles`, body, options);
  }

  /**
 * Remove a role assignment.
 * @stability public-stable — auth: admin
   */
  deleteV1UsersByUserIdRolesByRoleId<T = unknown>(userId: string, roleId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", `/v1/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, undefined, options);
  }

  /**
 * The tools of one MCP server this user may actually see and call.
 * @stability public-stable — auth: user
   */
  getV1UsersByUserIdServersByServerIdTools<T = unknown>(userId: string, serverId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/users/${encodeURIComponent(userId)}/servers/${encodeURIComponent(serverId)}/tools`, undefined, options);
  }

  /**
 * GET /v1/virtual-keys
 * @stability public-beta — auth: user
   */
  getV1VirtualKeys<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/virtual-keys`, undefined, options);
  }

  /**
 * POST /v1/virtual-keys
 * @stability public-beta — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1VirtualKeys<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/virtual-keys`, body, options);
  }

  /**
 * PATCH /v1/virtual-keys/:keyId
 * @stability public-beta — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  patchV1VirtualKeysByKeyId<T = unknown>(keyId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", `/v1/virtual-keys/${encodeURIComponent(keyId)}`, body, options);
  }

  /**
 * DELETE /v1/virtual-keys/:keyId
 * @stability public-beta — auth: user
   */
  deleteV1VirtualKeysByKeyId<T = unknown>(keyId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("DELETE", `/v1/virtual-keys/${encodeURIComponent(keyId)}`, undefined, options);
  }

  /**
 * GET /v1/virtual-keys/:keyId/usage
 * @stability public-beta — auth: user
   */
  getV1VirtualKeysByKeyIdUsage<T = unknown>(keyId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/virtual-keys/${encodeURIComponent(keyId)}/usage`, undefined, options);
  }

  /**
 * Workflow instances.
 * @stability public-stable — auth: user
   */
  getV1WorkflowsInstances<T = unknown>(options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/workflows/instances`, undefined, options);
  }

  /**
 * Start a workflow instance from a template.
 * @stability public-stable — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1WorkflowsInstances<T = unknown>(body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/workflows/instances`, body, options);
  }

  /**
 * One workflow instance with its stage history.
 * @stability public-stable — auth: user
   */
  getV1WorkflowsInstancesByInstanceId<T = unknown>(instanceId: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", `/v1/workflows/instances/${encodeURIComponent(instanceId)}`, undefined, options);
  }

  /**
 * Advance a workflow instance past its current stage, subject to that stage's gates.
 * @stability public-stable — auth: user
 * @remarks this route declares no request schema in the spec, so `body` is untyped.
   */
  postV1WorkflowsInstancesByInstanceIdAdvance<T = unknown>(instanceId: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", `/v1/workflows/instances/${encodeURIComponent(instanceId)}/advance`, body, options);
  }
}

/** every operation the published spec carries, as data — useful for tooling
 * that wants to enumerate the surface without parsing the document. */
export const OPERATIONS: ReadonlyArray<{ id: string; method: string; path: string }> = [
  {
    "id": "getWellKnownOauthProtectedResource",
    "method": "GET",
    "path": "/.well-known/oauth-protected-resource"
  },
  {
    "id": "getWellKnownOauthProtectedResourceMcpByServerId",
    "method": "GET",
    "path": "/.well-known/oauth-protected-resource/mcp/{serverId}"
  },
  {
    "id": "getHealth",
    "method": "GET",
    "path": "/health"
  },
  {
    "id": "postMcpByServerId",
    "method": "POST",
    "path": "/mcp/{serverId}"
  },
  {
    "id": "getV1Agents",
    "method": "GET",
    "path": "/v1/agents"
  },
  {
    "id": "postV1AgentsByAgentIdInvoke",
    "method": "POST",
    "path": "/v1/agents/{agentId}/invoke"
  },
  {
    "id": "getV1ApiVersioning",
    "method": "GET",
    "path": "/v1/api/versioning"
  },
  {
    "id": "getV1Approvals",
    "method": "GET",
    "path": "/v1/approvals"
  },
  {
    "id": "postV1ApprovalsByApprovalIdDecide",
    "method": "POST",
    "path": "/v1/approvals/{approvalId}/decide"
  },
  {
    "id": "getV1Audit",
    "method": "GET",
    "path": "/v1/audit"
  },
  {
    "id": "getV1AuditCsv",
    "method": "GET",
    "path": "/v1/audit.csv"
  },
  {
    "id": "postV1AuthzCheck",
    "method": "POST",
    "path": "/v1/authz/check"
  },
  {
    "id": "getV1BillingStatements",
    "method": "GET",
    "path": "/v1/billing/statements"
  },
  {
    "id": "getV1BillingStatementsById",
    "method": "GET",
    "path": "/v1/billing/statements/{id}"
  },
  {
    "id": "postV1ChatCompletions",
    "method": "POST",
    "path": "/v1/chat/completions"
  },
  {
    "id": "getV1Connectors",
    "method": "GET",
    "path": "/v1/connectors"
  },
  {
    "id": "postV1ConnectorsByConnectorIdInvoke",
    "method": "POST",
    "path": "/v1/connectors/{connectorId}/invoke"
  },
  {
    "id": "getV1Conversations",
    "method": "GET",
    "path": "/v1/conversations"
  },
  {
    "id": "postV1Conversations",
    "method": "POST",
    "path": "/v1/conversations"
  },
  {
    "id": "getV1ConversationsByConversationId",
    "method": "GET",
    "path": "/v1/conversations/{conversationId}"
  },
  {
    "id": "deleteV1ConversationsByConversationId",
    "method": "DELETE",
    "path": "/v1/conversations/{conversationId}"
  },
  {
    "id": "getV1CostEvents",
    "method": "GET",
    "path": "/v1/cost-events"
  },
  {
    "id": "postV1EvalsRuns",
    "method": "POST",
    "path": "/v1/evals/runs"
  },
  {
    "id": "postV1Evaluate",
    "method": "POST",
    "path": "/v1/evaluate"
  },
  {
    "id": "getV1Keys",
    "method": "GET",
    "path": "/v1/keys"
  },
  {
    "id": "postV1KeysByKeyIdRevoke",
    "method": "POST",
    "path": "/v1/keys/{keyId}/revoke"
  },
  {
    "id": "getV1Lineage",
    "method": "GET",
    "path": "/v1/lineage"
  },
  {
    "id": "getV1LineageNodes",
    "method": "GET",
    "path": "/v1/lineage/nodes"
  },
  {
    "id": "getV1LineageRunsByRunId",
    "method": "GET",
    "path": "/v1/lineage/runs/{runId}"
  },
  {
    "id": "getV1Me",
    "method": "GET",
    "path": "/v1/me"
  },
  {
    "id": "postV1Messages",
    "method": "POST",
    "path": "/v1/messages"
  },
  {
    "id": "getV1Models",
    "method": "GET",
    "path": "/v1/models"
  },
  {
    "id": "getV1OpenapiJson",
    "method": "GET",
    "path": "/v1/openapi.json"
  },
  {
    "id": "getV1Projects",
    "method": "GET",
    "path": "/v1/projects"
  },
  {
    "id": "postV1Projects",
    "method": "POST",
    "path": "/v1/projects"
  },
  {
    "id": "getV1ProjectsByProjectIdCosts",
    "method": "GET",
    "path": "/v1/projects/{projectId}/costs"
  },
  {
    "id": "getV1ProjectsByProjectIdCostsCsv",
    "method": "GET",
    "path": "/v1/projects/{projectId}/costs.csv"
  },
  {
    "id": "getV1ReportsRuns",
    "method": "GET",
    "path": "/v1/reports/runs"
  },
  {
    "id": "getV1ReportsRunsById",
    "method": "GET",
    "path": "/v1/reports/runs/{id}"
  },
  {
    "id": "getV1Roles",
    "method": "GET",
    "path": "/v1/roles"
  },
  {
    "id": "postV1Roles",
    "method": "POST",
    "path": "/v1/roles"
  },
  {
    "id": "deleteV1RolesByRoleId",
    "method": "DELETE",
    "path": "/v1/roles/{roleId}"
  },
  {
    "id": "getV1RolesByRoleIdAssignments",
    "method": "GET",
    "path": "/v1/roles/{roleId}/assignments"
  },
  {
    "id": "getV1RolesByRoleIdGrants",
    "method": "GET",
    "path": "/v1/roles/{roleId}/grants"
  },
  {
    "id": "getV1Runs",
    "method": "GET",
    "path": "/v1/runs"
  },
  {
    "id": "postV1Runs",
    "method": "POST",
    "path": "/v1/runs"
  },
  {
    "id": "postV1RunsDecompose",
    "method": "POST",
    "path": "/v1/runs/decompose"
  },
  {
    "id": "getV1RunsByRunId",
    "method": "GET",
    "path": "/v1/runs/{runId}"
  },
  {
    "id": "getV1Servers",
    "method": "GET",
    "path": "/v1/servers"
  },
  {
    "id": "getV1SpendAnomalies",
    "method": "GET",
    "path": "/v1/spend/anomalies"
  },
  {
    "id": "getV1SpendForecast",
    "method": "GET",
    "path": "/v1/spend/forecast"
  },
  {
    "id": "getV1UsageEvents",
    "method": "GET",
    "path": "/v1/usage-events"
  },
  {
    "id": "getV1Users",
    "method": "GET",
    "path": "/v1/users"
  },
  {
    "id": "postV1Users",
    "method": "POST",
    "path": "/v1/users"
  },
  {
    "id": "getV1UsersDirectory",
    "method": "GET",
    "path": "/v1/users/directory"
  },
  {
    "id": "patchV1UsersByUserId",
    "method": "PATCH",
    "path": "/v1/users/{userId}"
  },
  {
    "id": "getV1UsersByUserIdAgents",
    "method": "GET",
    "path": "/v1/users/{userId}/agents"
  },
  {
    "id": "getV1UsersByUserIdConnectors",
    "method": "GET",
    "path": "/v1/users/{userId}/connectors"
  },
  {
    "id": "postV1UsersByUserIdDeactivate",
    "method": "POST",
    "path": "/v1/users/{userId}/deactivate"
  },
  {
    "id": "postV1UsersByUserIdKeys",
    "method": "POST",
    "path": "/v1/users/{userId}/keys"
  },
  {
    "id": "postV1UsersByUserIdReactivate",
    "method": "POST",
    "path": "/v1/users/{userId}/reactivate"
  },
  {
    "id": "postV1UsersByUserIdRoles",
    "method": "POST",
    "path": "/v1/users/{userId}/roles"
  },
  {
    "id": "deleteV1UsersByUserIdRolesByRoleId",
    "method": "DELETE",
    "path": "/v1/users/{userId}/roles/{roleId}"
  },
  {
    "id": "getV1UsersByUserIdServersByServerIdTools",
    "method": "GET",
    "path": "/v1/users/{userId}/servers/{serverId}/tools"
  },
  {
    "id": "getV1VirtualKeys",
    "method": "GET",
    "path": "/v1/virtual-keys"
  },
  {
    "id": "postV1VirtualKeys",
    "method": "POST",
    "path": "/v1/virtual-keys"
  },
  {
    "id": "patchV1VirtualKeysByKeyId",
    "method": "PATCH",
    "path": "/v1/virtual-keys/{keyId}"
  },
  {
    "id": "deleteV1VirtualKeysByKeyId",
    "method": "DELETE",
    "path": "/v1/virtual-keys/{keyId}"
  },
  {
    "id": "getV1VirtualKeysByKeyIdUsage",
    "method": "GET",
    "path": "/v1/virtual-keys/{keyId}/usage"
  },
  {
    "id": "getV1WorkflowsInstances",
    "method": "GET",
    "path": "/v1/workflows/instances"
  },
  {
    "id": "postV1WorkflowsInstances",
    "method": "POST",
    "path": "/v1/workflows/instances"
  },
  {
    "id": "getV1WorkflowsInstancesByInstanceId",
    "method": "GET",
    "path": "/v1/workflows/instances/{instanceId}"
  },
  {
    "id": "postV1WorkflowsInstancesByInstanceIdAdvance",
    "method": "POST",
    "path": "/v1/workflows/instances/{instanceId}/advance"
  }
];

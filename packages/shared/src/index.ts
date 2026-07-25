import { z } from "zod";

export const toolKindSchema = z.enum(["read", "write"]);
export type ToolKind = z.infer<typeof toolKindSchema>;

export const decisionEffectSchema = z.enum(["allow", "deny"]);
export type DecisionEffect = z.infer<typeof decisionEffectSchema>;

export const evaluateRequestSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});
export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>;

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  isAdmin: z.boolean().optional(),
});

export const createServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});

export const createToolSchema = z.object({
  name: z.string().min(1),
  kind: toolKindSchema,
  description: z.string().optional(),
});

export const createToolGrantSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});

export const createServerGrantSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  readOnlyAll: z.boolean(),
});

export const createApprovalRuleSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
  writeOnly: z.boolean().optional(),
  approverUserId: z.string().uuid(),
});

export const createRateLimitSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
  maxCalls: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
});

// The decider is the authenticated caller — never a body field.
export const decideApprovalSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  reason: z.string().optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1),
});

export const createDataScopeRuleSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
  argPath: z.string().min(1),
  allowedValues: z.array(z.string()).min(1),
});

export const createRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const createRoleToolGrantSchema = z.object({
  serverId: z.string().uuid(),
  toolName: z.string().min(1),
});

export const createRoleServerGrantSchema = z.object({
  serverId: z.string().uuid(),
  readOnlyAll: z.boolean(),
});

export const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
});

export const createRevocationSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
});

export const createAgentSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  tier: z.number().int().min(0),
  modes: z.array(z.string().min(1)).nullable().optional(),
  costPerMTokIn: z.number().nonnegative().nullable().optional(),
  costPerMTokOut: z.number().nonnegative().nullable().optional(),
  /** provider-native model id (e.g. claude-opus-5); null = not dispatchable */
  model: z.string().min(1).nullable().optional(),
});

export const setAgentEnabledSchema = z.object({ enabled: z.boolean() });

export const createAgentGrantSchema = z.object({
  userId: z.string().uuid(),
  agentId: z.string().uuid(),
  allowedModes: z.array(z.string().min(1)).nullable().optional(),
});

export const setAgentPolicySchema = z.object({
  defaultAgentId: z.string().uuid().nullable().optional(),
  ceilingAgentId: z.string().uuid().nullable().optional(),
  routingMode: z.enum(["automatic", "passthrough"]).optional(),
  runBudgetUsd: z.number().positive().nullable().optional(),
  runBudgetBreachAction: z.enum(["approve", "replan"]).optional(),
});

export const invokeAgentSchema = z.object({
  mode: z.string().min(1).max(64),
  /** request text: complexity classification/token estimation input, and the
   * user turn actually sent to the model when dispatch=true */
  input: z.string().max(100_000).optional(),
  costSensitivity: z.enum(["cost-sensitive", "standard", "quality-sensitive"]).optional(),
  /** true = actually execute the routed model (governed dispatch); absent/false
   * keeps the decision-only behavior */
  dispatch: z.boolean().optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
  /** with dispatch: deliver the response as SSE (delta events, then one
   * result event); governance and routing still decide BEFORE the stream opens */
  stream: z.boolean().optional(),
  /** pillar 5: attribute this call's cost to a project */
  projectId: z.string().uuid().optional(),
});

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    costCenter: z.string().min(1).max(100).nullable().optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    budgetApproverUserId: z.string().uuid().nullable().optional(),
    /** §9 named arbiter for shared-context conflicts */
    arbiterUserId: z.string().uuid().nullable().optional(),
    /** §8.3 compliance framework tags, applied directly at creation */
    classifications: z.array(z.string().min(1).max(64)).max(16).optional(),
  })
  .refine((p) => p.budgetUsd == null || p.budgetApproverUserId != null, {
    message: "a project budget requires a budgetApproverUserId",
  });

export const createModelCredentialSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "xai"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().nullable().optional(),
});

export const createConnectorSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
});

export const createConnectorGrantSchema = z.object({
  userId: z.string().uuid(),
  connectorId: z.string().uuid(),
  mode: z.enum(["read", "readwrite"]),
  allowedObjects: z.array(z.string().min(1)).nullable().optional(),
});

export const invokeConnectorSchema = z.object({
  operation: z.enum(["read", "write"]),
  object: z.string().min(1).max(256).optional(),
});

export const changeDescriptorSchema = z.object({
  description: z.string().min(1),
  paths: z.array(z.string().min(1)),
  changeType: z.string().min(1),
  environment: z.string().min(1),
});

export const createWorkflowTemplateSchema = z.object({
  name: z.string().min(1),
  definition: z.unknown(),
});

export const createAssignmentRuleSchema = z
  .object({
    templateId: z.string().uuid(),
    pathPattern: z.string().min(1).nullable().optional(),
    changeType: z.string().min(1).nullable().optional(),
    environment: z.string().min(1).nullable().optional(),
  })
  .refine((r) => r.pathPattern || r.changeType || r.environment, {
    message: "an assignment rule needs at least one condition",
  });

export const startInstanceSchema = z.object({
  /** pillar 5: the instance and any nested runs bill to this project */
  projectId: z.string().uuid().optional(),
  change: changeDescriptorSchema,
  /** admin-only explicit template pick, bypassing assignment rules */
  templateId: z.string().uuid().optional(),
});

export const submitArtifactSchema = z.object({
  stageId: z.string().min(1),
  content: z.string().min(1),
});

export const advanceStageSchema = z.object({
  stageId: z.string().min(1),
});

export const createGitConnectionSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["github", "gitlab", "bitbucket", "azure_devops", "mock"]),
  baseUrl: z.string().url().optional(),
  token: z.string().min(1).max(512),
});

// EPIC-05 orchestration runs. The graph itself is validated by
// @regulait/orchestration-kernel — shared only frames the envelope.
export const createRunSchema = z.object({
  graph: z.unknown(),
  workflowInstanceId: z.string().uuid().optional(),
  /** pillar 5: every node dispatch of this run bills to this project */
  projectId: z.string().uuid().optional(),
});

export const autoAdvanceSchema = z.object({
  /** cap on successful dispatches in one pass */
  maxNodes: z.number().int().min(1).max(100).default(20),
  /** explicit opt-in: also accept each submission, letting dependents run.
   * Default false — review stays a human gate. */
  acceptReviews: z.boolean().optional(),
  /** per-node work instructions; a node absent here uses its title */
  inputs: z.record(z.string().max(100_000)).optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
});

export const dispatchNodeSchema = z.object({
  /** work instructions for the node's worker; defaults to the node title */
  input: z.string().max(100_000).optional(),
  maxTokens: z.number().int().min(1).max(64_000).optional(),
});

export const runEventSchema = z.object({
  kind: z.enum([
    "start",
    "node_started",
    "node_submitted",
    "node_accepted",
    "node_failed",
    "retry_node",
    "reassign_node",
    "escalate_node",
    "abort",
  ]),
  nodeId: z.string().min(1).max(64).optional(),
  ownerAgentId: z.string().uuid().optional(),
  error: z.string().min(1).max(2000).optional(),
});

// EPIC-06 PM-tool integration. The mapping override is validated by
// @regulait/pm-provider's zod schema in the gateway.
export const createPmConnectionSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["azure_devops", "jira", "linear", "asana", "monday", "generic_webhook", "mock"]),
  baseUrl: z.string().url().optional(),
  project: z.string().min(1),
  token: z.string().min(1).max(512),
  mapping: z.unknown().optional(),
});

export const pmSyncSchema = z.object({ connectionName: z.string().min(1) });

// EPIC-06 §4 decision records. The decision maker is the authenticated
// caller — never a body field.
export const createDecisionSchema = z.object({
  objectType: z.enum(["run", "workflow_instance"]),
  objectId: z.string().uuid(),
  decision: z.string().min(1).max(2000),
  rationale: z.string().min(1).max(8000).optional(),
});

// ADR-0010: the normalized inbound webhook shape — provider-specific payload
// translation is a later adapter concern; this shape is the contract.
export const pmWebhookSchema = z.object({
  externalId: z.string().min(1).max(256),
  event: z.enum(["updated", "deleted", "commented"]),
  state: z.string().min(1).max(128).optional(),
  fields: z.record(z.unknown()).optional(),
});

// PILLAR 4 (§9, ADR-0011): teams + Shared-Project membership + context store.
export const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
  /** §9.3 team default classifications (surfaced on conflict, never silently resolved) */
  defaultClassifications: z.array(z.string().min(1).max(64)).max(16).optional(),
});

// §8.3: one cascade profile per framework tag (upsert by tag).
export const upsertComplianceProfileSchema = z.object({
  tag: z.string().min(1).max(64),
  requiredTemplateIds: z.array(z.string().uuid()).max(16).optional(),
  mcpDefaultMode: z.enum(["read_only", "read_write"]).optional(),
  auditRetentionDays: z.number().int().positive().nullable().optional(),
  piiMode: z.enum(["block", "warn", "log"]).optional(),
});

// §8.3 reclassification: a diff-then-approve change to a project's tags.
export const reclassifySchema = z.object({
  classifications: z.array(z.string().min(1).max(64)).max(16),
  /** required when the project already has classifications: the named admin
   * who reviews the cascade diff before it commits */
  reviewerUserId: z.string().uuid().optional(),
});

export const addTeamMemberSchema = z.object({ userId: z.string().uuid() });

export const addProjectMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["owner", "contributor", "viewer"]),
  /** the member's contributing team for provenance; must be one of their teams */
  teamId: z.string().uuid().nullable().optional(),
});

export const contributeContextSchema = z.object({
  key: z.string().min(1).max(128),
  content: z.string().min(1).max(200_000),
  /** the accepted revision this write is based on; required once the key exists */
  baseRevision: z.number().int().positive().optional(),
  /** contributing team for provenance; must be one of the writer's teams */
  teamId: z.string().uuid().nullable().optional(),
});

export const promoteContextSchema = z.object({
  /** the team-local workflow artifact to promote into shared context */
  artifactId: z.string().uuid(),
});

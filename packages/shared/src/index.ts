import { z } from "zod";

export { detectPII, type PiiHit, type PiiCategory } from "./pii.js";

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

// PILLAR 1 rule scoping: the shared discriminant every restriction rule carries.
// A rule targets exactly ONE subject dimension (scope) and ONE server dimension
// (serverScope). Defaults keep every legacy caller — userId + serverId with no
// scope — valid and unchanged (scope='user', serverScope='server'). The
// superRefine below mirrors the DB CHECK constraints byte-for-byte, so a bad
// discriminant is rejected loudly at the edge (400) rather than by Postgres (500).
export const ruleScopeSchema = z.enum(["user", "role", "team", "fleet"]);
export const ruleServerScopeSchema = z.enum(["server", "all"]);

const ruleScopeFields = {
  userId: z.string().uuid().nullable().optional(),
  serverId: z.string().uuid().nullable().optional(),
  roleId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  scope: ruleScopeSchema.default("user"),
  serverScope: ruleServerScopeSchema.default("server"),
};

type RuleScopeShape = {
  scope: z.infer<typeof ruleScopeSchema>;
  serverScope: z.infer<typeof ruleServerScopeSchema>;
  userId?: string | null | undefined;
  serverId?: string | null | undefined;
  roleId?: string | null | undefined;
  teamId?: string | null | undefined;
};

function refineRuleScope(body: RuleScopeShape, ctx: z.RefinementCtx) {
  // subject discriminant — exactly the DB scope CHECK
  if (body.scope === "user" && !body.userId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope 'user' requires a userId", path: ["userId"] });
  if (body.scope === "role" && !body.roleId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope 'role' requires a roleId", path: ["roleId"] });
  if (body.scope === "team" && !body.teamId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "scope 'team' requires a teamId", path: ["teamId"] });
  if (body.scope === "fleet" && (body.userId || body.roleId || body.teamId))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scope 'fleet' takes no userId/roleId/teamId",
      path: ["scope"],
    });
  // server discriminant — exactly the DB server_scope CHECK
  if (body.serverScope === "server" && !body.serverId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "serverScope 'server' requires a serverId", path: ["serverId"] });
  if (body.serverScope === "all" && body.serverId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "serverScope 'all' takes no serverId", path: ["serverId"] });
}

export const createApprovalRuleSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    writeOnly: z.boolean().optional(),
    approverUserId: z.string().uuid(),
  })
  .superRefine(refineRuleScope);

export const createRateLimitSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    maxCalls: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
  })
  .superRefine(refineRuleScope);

// The decider is the authenticated caller — never a body field.
export const decideApprovalSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  reason: z.string().optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1),
});

export const createDataScopeRuleSchema = z
  .object({
    ...ruleScopeFields,
    toolName: z.string().min(1).nullable().optional(),
    argPath: z.string().min(1),
    allowedValues: z.array(z.string()).min(1),
  })
  .superRefine(refineRuleScope);

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

// §5 role-bundled AGENT/CONNECTOR grants — shape-identical to the direct
// agent/connector grant bodies so a role grant can never exceed a direct one.
export const createRoleAgentGrantSchema = z.object({
  agentId: z.string().uuid(),
  allowedModes: z.array(z.string().min(1)).nullable().optional(),
});

export const createRoleConnectorGrantSchema = z.object({
  connectorId: z.string().uuid(),
  mode: z.enum(["read", "readwrite"]),
  allowedObjects: z.array(z.string().min(1)).nullable().optional(),
});

export const assignRoleSchema = z.object({
  roleId: z.string().uuid(),
});

export const createRevocationSchema = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
  toolName: z.string().min(1).nullable().optional(),
});

/**
 * ADR-0019 per-user AGENT/CONNECTOR revocation — the subtractive override that
 * bounds ADR-0014's additive UNION-MAX role grants. The user is the path
 * parameter (mirroring the per-user model-credential routes), so the body
 * carries only the object and an optional admin justification. A revocation is
 * TOTAL for that (user, object): there is no partial-mode field, because a
 * narrower entitlement is what editing the grant is for, while a revocation
 * must be an unambiguous "not for this user".
 */
export const createAgentRevocationSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().min(1).max(500).nullable().optional(),
});

export const createConnectorRevocationSchema = z.object({
  connectorId: z.string().uuid(),
  reason: z.string().min(1).max(500).nullable().optional(),
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
  /** pillar-6 prompt caching: the stable system-prompt prefix sent as the
   * dispatch's `system`. A large, reused prefix is marked cacheable so repeat
   * dispatches read it from cache instead of re-billing it. Absent = no system
   * prompt (byte-identical to the pre-caching contract). */
  system: z.string().max(100_000).optional(),
  /** pillar-6 edit-vs-rewrite: the existing content the user is asking to
   * modify. When present and the request reads as a targeted edit, the model
   * is instructed to return a compact diff instead of re-emitting the whole
   * thing. Absent = plain generation (byte-identical to the pre-edit contract). */
  baseline: z.string().max(200_000).optional(),
  /** pillar-6 file preprocessing: large reference/file content attached to the
   * dispatch. It is deterministically shrunk (redundant whitespace collapsed,
   * long data blobs elided) before the model sees it. Absent = no reference
   * content (byte-identical to the pre-preprocessing contract). */
  referenceContent: z.string().max(500_000).optional(),
  /** multimodal uploads (mimics Claude's native attach): images the model sees
   * as vision and PDFs it reads as documents, carried base64 on the newest user
   * turn. Bounded in count and per-file size so a dispatch can't be used to
   * smuggle an unbounded payload; only providers with native vision (Claude)
   * see the bytes — others get a short "[attached image: name]" placeholder.
   * Text/code files are NOT attachments — they ride `referenceContent` instead,
   * where the pillar-6 preprocessor can shrink them. Absent = a text-only turn
   * (byte-identical to the pre-attachment contract). */
  attachments: z
    .array(
      z.object({
        kind: z.enum(["image", "document"]),
        name: z.string().min(1).max(256),
        mediaType: z.string().min(1).max(128),
        /** base64 (no data: prefix). ~9M chars ≈ 6.7MB decoded — a per-file
         * ceiling that keeps a single dispatch bounded. */
        dataBase64: z.string().min(1).max(9_000_000),
      }),
    )
    .max(8)
    .optional(),
  /** pillar-6 semantic caching: opt in to the REAL per-(user,agent) exact-match
   * response cache. When true and this dispatch's normalized input matches a
   * fresh stored row for the SAME user+agent, the stored response is served
   * WITHOUT a provider call; on a miss the dispatch runs normally and its result
   * is stored for later re-asks. Absent/false = no cache lookup or store
   * (byte-identical to the pre-caching contract). Never crosses users or agents. */
  semanticCache: z.boolean().optional(),
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
  /** multi-turn: dispatch inside this conversation — the stored history rides
   * the request as the model's messages array, and the user+assistant turns
   * are persisted on completion. Only meaningful with dispatch=true; a
   * decision-only invoke never touches conversation history. */
  conversationId: z.string().uuid().optional(),
});

/** MULTI-TURN CONVERSATIONS: create an empty personal thread. The owner is
 * always the authenticated caller — never a body field. */
export const createConversationSchema = z.object({
  agentId: z.string().uuid(),
  /** pillar 5: default attribution for every turn dispatched in this thread */
  projectId: z.string().uuid().optional(),
});

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    costCenter: z.string().min(1).max(100).nullable().optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    budgetApproverUserId: z.string().uuid().nullable().optional(),
    /** pillar-5 budget window: 'none' (lifetime) or 'monthly' (calendar month) */
    budgetPeriod: z.enum(["none", "monthly"]).optional(),
    /** warn (non-blocking) when windowed spend crosses this percent of budget;
     * the hard block stays at 100%, so 1..100 is the meaningful range */
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
    /** §9 named arbiter for shared-context conflicts */
    arbiterUserId: z.string().uuid().nullable().optional(),
    /** §8.3 compliance framework tags, applied directly at creation */
    classifications: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** pillar-5 rollup: parent Initiative id (reporting-only grouping) */
    initiativeId: z.string().uuid().nullable().optional(),
  })
  .refine((p) => p.budgetUsd == null || p.budgetApproverUserId != null, {
    message: "a project budget requires a budgetApproverUserId",
  });

/** Post-creation project edits (admin-only). Classifications are deliberately
 * absent — reclassification has its own diff-then-approve endpoint (§8.3) and
 * must never ride a plain PATCH. The budget-requires-approver invariant is
 * re-checked in the route against the MERGED row, since a patch may supply
 * either half. */
export const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    costCenter: z.string().min(1).max(100).nullable().optional(),
    budgetUsd: z.number().positive().nullable().optional(),
    budgetApproverUserId: z.string().uuid().nullable().optional(),
    budgetPeriod: z.enum(["none", "monthly"]).optional(),
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
    arbiterUserId: z.string().uuid().nullable().optional(),
    /** pillar-5 rollup: parent Initiative id (reporting-only grouping) */
    initiativeId: z.string().uuid().nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to update — provide at least one field",
  });

/** pillar-5 cross-team rollup: an Initiative is a flat, reporting-only grouping
 * of projects for chargeback/showback above the single-project level. No
 * budget or enforcement in v1 — grouping only. */
export const createInitiativeSchema = z.object({
  name: z.string().min(1).max(200),
  costCenter: z.string().min(1).max(100).nullable().optional(),
});

export const updateInitiativeSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    costCenter: z.string().min(1).max(100).nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to update — provide at least one field",
  });

export const createModelCredentialSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "xai"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().nullable().optional(),
});

/** the connector-provider adapter enum (mirrors the CONNECTOR_PROVIDER_KINDS
 * union without importing the package into shared) */
export const connectorProviderKindSchema = z.enum([
  "http",
  "webhook",
  "slack",
  "github",
  "jira",
  "snowflake",
  "generic",
  "mock",
]);

export const createConnectorSchema = z.object({
  name: z.string().min(1),
  /** free-text display CATEGORY (unchanged) — NOT the execution adapter */
  kind: z.string().min(1),
  /** EXECUTION: the adapter that runs the call; absent = governance-only */
  providerKind: connectorProviderKindSchema.optional(),
  baseUrl: z.string().url().optional(),
  /** pillar 5 flat list price per allowed call; absent/null = unpriced */
  pricePerCallUsd: z.number().nonnegative().nullable().optional(),
});

/** platform connector credential (mirrors createModelCredentialSchema) */
export const createConnectorCredentialSchema = z.object({
  token: z.string().min(1).max(2048),
  baseUrl: z.string().url().nullable().optional(),
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
  /** EXECUTION: the write body / read parameters handed to the adapter */
  payload: z.record(z.unknown()).optional(),
  /** pillar 5: attribute this call's cost to a project */
  projectId: z.string().uuid().optional(),
});

export const changeDescriptorSchema = z.object({
  description: z.string().min(1),
  paths: z.array(z.string().min(1)),
  changeType: z.string().min(1),
  environment: z.string().min(1),
  /** ADR-0018 §4 dim: the target system this change lands on (a service, repo,
   * or environment name). Client-supplied like the other change attributes. The
   * OTHER new dim — initiatorRole — is deliberately NOT accepted here: it is
   * derived server-side from the authenticated initiator and can never be set by
   * the client. The 6th dim, dataSensitivity, is likewise NOT accepted: it is
   * derived server-side from the attributed project's compliance
   * classifications (ADR-0018 addendum / ADR-0019). */
  targetSystem: z.string().min(1).max(200).optional(),
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
    /** ADR-0018 §4 dims: target system + initiator role (a role name). Both are
     * plain rule conditions; initiatorRole is matched against the SERVER-derived
     * roles of the initiating user at instance start. */
    targetSystem: z.string().min(1).max(200).nullable().optional(),
    initiatorRole: z.string().min(1).max(200).nullable().optional(),
    /** ADR-0018 addendum §4 dim (the 6th): a compliance classification tag. Like
     * initiatorRole it is a plain rule condition here, but matched against the
     * SERVER-derived classifications of the change's attributed project. */
    dataSensitivity: z.string().min(1).max(200).nullable().optional(),
  })
  .refine(
    (r) =>
      r.pathPattern ||
      r.changeType ||
      r.environment ||
      r.targetSystem ||
      r.initiatorRole ||
      r.dataSensitivity,
    { message: "an assignment rule needs at least one condition" },
  );

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

/** §2 report per-check outcomes into an automated_check stage. A real CI posts
 * pass/fail (+ optional severity/detail) here; the demo/seed does too. A failing
 * required check parks the instance at blocked_on_check. Only names declared on
 * the stage are honoured (the gateway ignores unknown checks). */
export const reportChecksSchema = z.object({
  stageId: z.string().min(1),
  results: z
    .array(
      z.object({
        check: z.string().min(1),
        status: z.enum(["passed", "failed"]),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        detail: z.string().max(2000).optional(),
      }),
    )
    .min(1),
});

/** §2 re-run a check stage that is parked at blocked_on_check, after the failing
 * checks have been remediated and fresh passing results reported. */
export const recheckSchema = z.object({
  stageId: z.string().min(1),
});

/** §2/§3 a governed deploy target a deployment/rollback stage acts on.
 * Credentials are optional (a mock/AWS-assume-role target needs none) and, when
 * given, stored encrypted. §3 BYOC: `mode` picks hosted / byoc / air_gapped, and
 * an aws target carries the customer role to assume + region. */
export const createDeployTargetSchema = z
  .object({
    name: z.string().min(1).max(120),
    provider: z.enum(["mock", "aws", "azure", "gcp", "kubernetes"]),
    environment: z.string().min(1).max(80).optional(),
    baseUrl: z.string().url().max(2000).optional(),
    credential: z.string().min(1).max(8000).optional(),
    mode: z.enum(["hosted", "byoc", "air_gapped"]).optional(),
    /** aws: the customer IAM role to assume (arn:aws:iam::<acct>:role/<name>) */
    roleArn: z
      .string()
      .regex(/^arn:aws:iam::\d{12}:role\/.+/, "must be an arn:aws:iam::<account>:role/<name>")
      .max(2048)
      .optional(),
    region: z.string().min(1).max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.provider === "aws" && (!v.roleArn || !v.region)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an aws deploy target needs a roleArn and region",
      });
    }
  });

/** §2 resolve a deploy stage parked at blocked_on_deploy: the operator confirms
 * they deployed out-of-band (or accepts the condition) and the pipeline advances. */
export const deployOverrideSchema = z.object({
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

// PILLAR 7 agent-driven task decomposition: a lead agent DRAFTS a plan; the
// human reviews/edits it and submits through the normal POST /v1/runs — the
// plan gate stays human.
export const decomposeGoalSchema = z.object({
  goal: z.string().min(10).max(4000),
  /** pillar 5: the lead dispatch bills to this project like any other call */
  projectId: z.string().uuid().optional(),
  /** explicit lead pick; defaults to the caller's default agent, then the
   * cheapest granted mock agent */
  leadAgentId: z.string().uuid().optional(),
});

/** The raw plan shape the lead agent must return from a decompose dispatch.
 * Agent references are NAMES from the roster the planning prompt supplied —
 * the gateway resolves them to granted agent ids (falling back, recorded,
 * when a name is unknown or ungranted). */
export const decompositionPlanSchema = z.object({
  name: z.string().min(1).max(200),
  nodes: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "node id must be a kebab-case slug"),
        title: z.string().min(1).max(200),
        instruction: z.string().min(1).max(4000),
        agent: z.string().min(1).max(200),
        dependsOn: z.array(z.string().min(1)).default([]),
        /** pillar 7: MCP server NAMES this task's worker may draw tools from
         * (resolved to ids + entitlement-narrowed by the gateway). Optional —
         * a task with no tools is an ordinary single-turn worker. */
        toolServers: z.array(z.string().min(1).max(200)).optional(),
        /** pillar 7: max tool-using turns for this worker (gateway-bounded) */
        maxTurns: z.number().int().min(1).max(20).optional(),
        /** §5.1 Team-Lead delegation: the id of another node in this plan that
         * acts as this task's LEAD. Optional — a flat plan omits it. The
         * gateway validates the reference and the acyclic chain. */
        leadId: z.string().min(1).max(64).optional(),
        /** §5.1: when this task is itself a LEAD, the agent NAMES (from the
         * roster) a worker under it may be owned by — a ceiling the gateway
         * resolves to ids and NARROWS to the caller's own entitlements
         * (anything outside is dropped and recorded). */
        allowedAgents: z.array(z.string().min(1).max(200)).optional(),
        /** §5.1: when this task is itself a LEAD, the tool NAMES a worker under
         * it may call — a ceiling narrowed to the caller's entitled tools. */
        allowedTools: z.array(z.string().min(1).max(128)).optional(),
        /** §5.2 (B2): a SUGGESTED per-node budget cap in USD the lead proposes
         * for this task. Optional; carried into the submittable graph as the
         * node's budgetCapUsd. It is only ever a suggestion — the run's real
         * authority (the initiator's per-run budget + the transitive ceiling)
         * still enforces downstream, so a suggested cap can never grant spend. */
        budgetCapUsd: z.number().positive().optional(),
      }),
    )
    .min(2)
    .max(8),
});
export type DecompositionPlan = z.infer<typeof decompositionPlanSchema>;

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
  /** pillar 7: override the node's declared tool-loop turn cap for this
   * dispatch (still gateway-bounded) */
  maxTurns: z.number().int().min(1).max(20).optional(),
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
export const createPmConnectionSchema = z
  .object({
    name: z.string().min(1),
    provider: z.enum(["azure_devops", "jira", "linear", "asana", "monday", "generic_webhook", "mock"]),
    baseUrl: z.string().url().optional(),
    project: z.string().min(1),
    token: z.string().min(1).max(512),
    mapping: z.unknown().optional(),
    /** jira only: REST API version — 2 (legacy plain-text, the default) or
     * 3 (ADF rich-text descriptions/comments). Coerced so the admin portal's
     * select can post "3". */
    apiVersion: z.coerce.number().int().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.apiVersion === undefined) return;
    if (body.apiVersion !== 2 && body.apiVersion !== 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "apiVersion must be 2 or 3", path: ["apiVersion"] });
    }
    if (body.provider !== "jira") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "apiVersion only applies to jira connections",
        path: ["apiVersion"],
      });
    }
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
  /** §8.3 -> §8.2: the backup retention + patch cadence floors this framework
   * forces onto any infra resource carrying its tag (pillar 3). */
  backupRetentionDays: z.number().int().positive().nullable().optional(),
  patchCadenceDays: z.number().int().positive().nullable().optional(),
});

// PILLAR 3 (§8.2): the governed infrastructure-operations layer.
export const createInfraResourceSchema = z.object({
  kind: z.enum(["control_plane", "agent_runtime", "cert", "backup_target"]),
  name: z.string().min(1).max(200),
  /** infra-provider kind; 'mock' (keyless, deterministic) for the MVP */
  provider: z.enum(["mock", "aws", "azure", "gcp"]).default("mock"),
  config: z.record(z.unknown()).optional(),
  /** §8.3 compliance tags; the cascade derives backup/patch floors */
  classifications: z.array(z.string().min(1).max(64)).max(16).optional(),
});

// An operational policy. A null resourceId is fleet-wide. The auto-remediate
// ceiling EXCLUDES 'critical' by construction — critical findings are always
// approval-gated regardless of policy.
export const createInfraPolicySchema = z.object({
  resourceId: z.string().uuid().nullable().optional(),
  patchCadenceDays: z.number().int().positive().nullable().optional(),
  certRotationDaysBeforeExpiry: z.number().int().positive().nullable().optional(),
  backupSchedule: z.string().min(1).max(200).nullable().optional(),
  backupRetentionDays: z.number().int().positive().nullable().optional(),
  driftBaseline: z.record(z.unknown()).nullable().optional(),
  autoRemediateMaxSeverity: z.enum(["low", "medium", "high"]).nullable().optional(),
});

// Scan on demand — optionally a single resource, else the whole fleet.
export const scanInfraSchema = z
  .object({ resourceId: z.string().uuid().optional() })
  .optional()
  .default({});

// Propose a governed remediation for an OPEN finding: a named approver gates it.
export const proposeInfraRemediationSchema = z.object({
  approverUserId: z.string().uuid(),
});

// ADR-0017 — the three operator verbs. Each is a thin wrapper that funnels a
// ledger row into the SAME governed approval path (objectType infra_operation)
// as proposeInfraRemediation: a named approver gates it, nothing mutates infra
// state until the approval is decided.
export const rotateCertSchema = z.object({
  approverUserId: z.string().uuid(),
});
export const applyPatchSchema = z.object({
  approverUserId: z.string().uuid(),
});
export const restoreBackupSchema = z.object({
  approverUserId: z.string().uuid(),
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

/** the owner's per-member role change (PATCH /projects/:id/members/:userId).
 * Membership is otherwise add-only; this and DELETE are the only mutators, and
 * both are guarded by last-owner protection so a project can't be orphaned. */
export const patchProjectMemberSchema = z.object({
  role: z.enum(["owner", "contributor", "viewer"]),
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

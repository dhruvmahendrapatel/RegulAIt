import {
  integer,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["read", "write"] }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mcp_tools_server_name_uq").on(t.serverId, t.name)],
);

export const toolGrants = pgTable(
  "tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tool_grants_user_server_tool_uq").on(t.userId, t.serverId, t.toolName),
    index("tool_grants_user_server_idx").on(t.userId, t.serverId),
  ],
);

export const serverGrants = pgTable(
  "server_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    readOnlyAll: boolean("read_only_all").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("server_grants_user_server_uq").on(t.userId, t.serverId)],
);

// No FKs on purpose: audit records must survive user/server deletion.
// One audit trail for every object type (§7): MCP tool calls fill
// serverId/toolName; agent and connector decisions fill objectId/detail.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    objectType: text("object_type", {
      enum: ["mcp_tool", "agent", "connector", "workflow", "run", "pm_work_item"],
    })
      .notNull()
      .default("mcp_tool"),
    objectId: uuid("object_id"),
    detail: jsonb("detail"),
    serverId: uuid("server_id"),
    toolName: text("tool_name"),
    effect: text("effect", { enum: ["allow", "deny", "require_approval"] }).notNull(),
    ruleId: text("rule_id").notNull(),
    ruleChain: jsonb("rule_chain").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [index("audit_log_user_at_idx").on(t.userId, t.at)],
);

// §3 approval requirement rules: a granted call matching a rule pauses for
// the named approver. toolName null = any tool on the server.
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    writeOnly: boolean("write_only").notNull().default(false),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("approval_rules_user_server_idx").on(t.userId, t.serverId)],
);

// §3 rate/volume limits. toolName null = server-wide cap. Usage is counted
// from audit_log allow rows at evaluation time, not stored here.
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    maxCalls: integer("max_calls").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_limits_user_server_idx").on(t.userId, t.serverId)],
);

// §6 Approvals Queue: one pending entry per paused call. Approved entries are
// consumed by exactly one retried call. The audit log remains the permanent
// record; queue rows may cascade away with their user/server.
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    objectType: text("object_type", { enum: ["mcp_tool", "workflow", "run"] })
      .notNull()
      .default("mcp_tool"),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    ruleId: uuid("rule_id"),
    instanceId: uuid("instance_id"),
    /** orchestration-run escalations (§3): the run this approval gates; stageId carries the node id */
    runId: uuid("run_id"),
    stageId: text("stage_id"),
    approverUserId: uuid("approver_user_id").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "consumed", "superseded"],
    })
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
  },
  (t) => [
    index("approvals_status_idx").on(t.status),
    index("approvals_user_server_tool_idx").on(t.userId, t.serverId, t.toolName),
  ],
);

// §3 data-scope rules: allow-list the values a call-argument field may take
// for a granted tool. argPath is a dot-path into the call arguments;
// allowedValues is a jsonb string array. Missing/non-scalar values fail closed.
export const dataScopeRules = pgTable(
  "data_scope_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    argPath: text("arg_path").notNull(),
    allowedValues: jsonb("allowed_values").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("data_scope_rules_user_server_idx").on(t.userId, t.serverId)],
);

// Per-user API keys. Only the sha256 hash of the token is stored; the
// plaintext (rgl_<hex>) is shown exactly once at creation.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
);

// §5 roles: named bundles of default entitlements. Assigning a role sets a
// user's baseline; per-user overrides layer on top (direct grants add,
// revocations subtract role-derived entitlements only).
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleToolGrants = pgTable(
  "role_tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_tool_grants_role_server_tool_uq").on(t.roleId, t.serverId, t.toolName)],
);

export const roleServerGrants = pgTable(
  "role_server_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    readOnlyAll: boolean("read_only_all").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_server_grants_role_server_uq").on(t.roleId, t.serverId)],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_assignments_user_role_uq").on(t.userId, t.roleId)],
);

// §5 subtractive per-user override: suppresses role-derived entitlements
// only (direct grants always survive). toolName null = all role-derived
// access on the server. Deleting the row reverses the override.
export const revocations = pgTable(
  "revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("revocations_user_server_idx").on(t.userId, t.serverId),
    // NULLS NOT DISTINCT in the migration: one revocation per (user, server, tool/null)
    uniqueIndex("revocations_user_server_tool_uq").on(t.userId, t.serverId, t.toolName),
  ],
);

// §4 global agent/model registry: platform-wide catalog, decoupled from
// per-user entitlement. tier ranks capability/cost (basis of the ceiling).
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull(),
  tier: integer("tier").notNull(),
  modes: jsonb("modes").$type<string[]>(),
  enabled: boolean("enabled").notNull().default(true),
  // OPTIMIZATION §7/§8: list price per million tokens; null = unpriced, the
  // optimizer will never route toward (or estimate savings against) it.
  costPerMTokIn: doublePrecision("cost_per_mtok_in"),
  costPerMTokOut: doublePrecision("cost_per_mtok_out"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentGrants = pgTable(
  "agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    allowedModes: jsonb("allowed_modes").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_grants_user_agent_uq").on(t.userId, t.agentId)],
);

// §4 per-user default and ceiling agent.
export const userAgentPolicies = pgTable("user_agent_policies", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultAgentId: uuid("default_agent_id").references(() => agents.id, { onDelete: "set null" }),
  ceilingAgentId: uuid("ceiling_agent_id").references(() => agents.id, { onDelete: "set null" }),
  // OPTIMIZATION §12: per-user off switch for model routing, admin-set on the
  // existing agent-policy surface (no new admin object, per §13).
  routingMode: text("routing_mode", { enum: ["automatic", "passthrough"] })
    .notNull()
    .default("automatic"),
  // ORCHESTRATION §5.2: per-run budget cap for runs this user initiates, and
  // what happens when a planned run exceeds it. Lives here as a stand-in for
  // the per-project budget until a projects entity exists (admin-set either
  // way). null = no cap.
  runBudgetUsd: doublePrecision("run_budget_usd"),
  runBudgetBreachAction: text("run_budget_breach_action", { enum: ["approve", "replan"] })
    .notNull()
    .default("approve"),
});

// §2 connector catalog + per-user grants (mode + object-level data scope).
export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorGrants = pgTable(
  "connector_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["read", "readwrite"] }).notNull(),
    allowedObjects: jsonb("allowed_objects").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connector_grants_user_connector_uq").on(t.userId, t.connectorId)],
);

// EPIC-03 workflow engine (WORKFLOW_ENGINE_SPEC.md). Templates are the
// declarative §3 definitions; instances snapshot their merged definition at
// start so a template edit never mutates an in-flight run.
export const workflowTemplates = pgTable("workflow_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  definition: jsonb("definition").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// §4 assignment rules: conditions AND together; a rule with no conditions
// matches nothing (kernel-enforced).
export const workflowAssignmentRules = pgTable("workflow_assignment_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => workflowTemplates.id, { onDelete: "cascade" }),
  pathPattern: text("path_pattern"),
  changeType: text("change_type"),
  environment: text("environment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateIds: jsonb("template_ids").$type<string[]>().notNull(),
    definition: jsonb("definition").notNull(),
    initiatorUserId: uuid("initiator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    change: jsonb("change").notNull(),
    state: jsonb("state").notNull(),
    /** outputs of executed stages (branch, prId, prUrl, mergeSha, lastError) */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_instances_status_idx").on(t.status)],
);

// Append-only per-instance history (§5 dashboard: full history, who, when).
export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    event: jsonb("event").notNull(),
    actorUserId: uuid("actor_user_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_events_instance_idx").on(t.instanceId)],
);

// Versioned artifacts (§2 stage 3): every submitted version retained.
export const workflowArtifacts = pgTable(
  "workflow_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    output: text("output").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_artifacts_instance_output_version_uq").on(t.instanceId, t.output, t.version)],
);

// Git connections for workflow git_operation stages. The token is stored
// AES-256-GCM-encrypted with the gateway's data key — never plaintext.
export const gitConnections = pgTable("git_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", {
    enum: ["github", "gitlab", "bitbucket", "azure_devops", "mock"],
  }).notNull(),
  baseUrl: text("base_url"),
  tokenCiphertext: text("token_ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// OPTIMIZATION §7: the savings ledger — one row per optimization decision at
// the interception point, per technique, dashboard-ready for pillar 5's
// rollup. Like audit_log it carries no FKs: cost history must survive
// user/agent deletion.
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    objectType: text("object_type", { enum: ["agent", "mcp_tool", "connector", "workflow", "run"] })
      .notNull()
      .default("agent"),
    objectId: uuid("object_id"),
    technique: text("technique", {
      enum: [
        "model_routing",
        "edit_vs_rewrite",
        "context_compaction",
        "file_preprocessing",
        "prompt_caching",
        "lazy_tool_loading",
      ],
    }).notNull(),
    requestedAgentId: uuid("requested_agent_id"),
    servedAgentId: uuid("served_agent_id"),
    baselineAgentId: uuid("baseline_agent_id"),
    estimatedTokensIn: integer("estimated_tokens_in").notNull().default(0),
    estimatedTokensOut: integer("estimated_tokens_out").notNull().default(0),
    estimatedTokensSaved: integer("estimated_tokens_saved").notNull().default(0),
    estimatedCostSavedUsd: doublePrecision("estimated_cost_saved_usd"),
    estimationBasis: text("estimation_basis").notNull(),
    ruleId: text("rule_id").notNull(),
    detail: jsonb("detail"),
  },
  (t) => [
    index("cost_events_user_at_idx").on(t.userId, t.at),
    index("cost_events_technique_idx").on(t.technique),
  ],
);

// ORCHESTRATION (EPIC-05, pillar 7): one row per run. The task graph and run
// state are jsonb snapshots exactly like workflow_instances — the kernel owns
// their shape. workflow_instance_id links a run nested inside a build stage
// (§8); null = directly-initiated run.
export const orchestrationRuns = pgTable(
  "orchestration_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    initiatingUserId: uuid("initiating_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, {
      onDelete: "set null",
    }),
    graph: jsonb("graph").notNull(),
    state: jsonb("state").notNull(),
    /** §5.2 budget envelope: cap, estimates, live estimated spend, overage approval */
    budget: jsonb("budget"),
    status: text("status", { enum: ["planned", "running", "completed", "aborted"] })
      .notNull()
      .default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orchestration_runs_user_idx").on(t.initiatingUserId)],
);

export const orchestrationRunEvents = pgTable(
  "orchestration_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => orchestrationRuns.id, { onDelete: "cascade" }),
    event: jsonb("event").notNull(),
    actorUserId: uuid("actor_user_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orchestration_run_events_run_idx").on(t.runId)],
);

// PM-TOOL INTEGRATION (EPIC-06, pillar 8). Connections mirror git_connections:
// the token is stored AES-256-GCM-encrypted, never plaintext. mapping is the
// admin's override of the adapter's default field mapping (null = default).
export const pmConnections = pgTable("pm_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", {
    enum: ["azure_devops", "jira", "linear", "asana", "monday", "generic_webhook", "mock"],
  }).notNull(),
  baseUrl: text("base_url"),
  project: text("project").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  mapping: jsonb("mapping"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// §2/§6: the link record making a task-graph node BE a work item rather than
// a shadow copy. RegulAIt stores only the linkage — the PM-authoritative
// fields (priority/description/acceptance criteria) are read through live,
// never cached here (§3).
export const pmLinks = pgTable(
  "pm_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => pmConnections.id, { onDelete: "cascade" }),
    objectType: text("object_type", { enum: ["run_node", "run", "workflow_instance"] }).notNull(),
    objectId: uuid("object_id").notNull(),
    /** task-graph node id when objectType is run_node */
    nodeId: text("node_id"),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT applied in the hand-written migration (0005 precedent)
    uniqueIndex("pm_links_conn_obj_node_uq").on(t.connectionId, t.objectType, t.objectId, t.nodeId),
    index("pm_links_object_idx").on(t.objectType, t.objectId),
  ],
);

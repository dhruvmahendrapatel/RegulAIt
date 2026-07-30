import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  boolean,
  doublePrecision,
  index,
  jsonb,
  numeric,
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
  // PILLAR 5 (ADR-0019): flat list price per ALLOWED tool call on this server —
  // the MCP twin of connectors.pricePerCallUsd. Null = unpriced → cost null,
  // never invented (agents' costPerMTok null-safety). A tool call is a discrete
  // governed unit of work, so it is priced per call rather than per token.
  pricePerCallUsd: doublePrecision("price_per_call_usd"),
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
      enum: [
        "mcp_tool",
        "agent",
        "connector",
        "workflow",
        "run",
        "pm_work_item",
        "decision",
        "project",
        "initiative",
        "infra_operation",
        // ADR-0020: an admin change to the deployment's interception posture
        // (which compat surfaces exist, how models resolve, whether
        // attribution is mandatory). Plain text column — no DDL needed.
        "interception_settings",
      ],
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
//
// PILLAR 1 rule scoping: userId/serverId are nullable now — a rule is bound to
// exactly ONE subject dimension chosen by `scope` (user | role | team | fleet)
// and ONE server dimension chosen by `serverScope` (server | all). The DB
// CHECK constraints (migration 0026) enforce the discriminant. Existing rows
// carry scope='user', serverScope='server' and behave identically. The rule
// stays a pure RESTRICTION evaluated after the grant check.
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "role", "team", "fleet"] })
      .notNull()
      .default("user"),
    serverScope: text("server_scope", { enum: ["server", "all"] }).notNull().default("server"),
    toolName: text("tool_name"),
    writeOnly: boolean("write_only").notNull().default(false),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approval_rules_user_server_idx").on(t.userId, t.serverId),
    index("approval_rules_scope_idx").on(t.scope, t.serverScope, t.serverId),
    index("approval_rules_role_idx").on(t.roleId),
    index("approval_rules_team_idx").on(t.teamId),
  ],
);

// §3 rate/volume limits. toolName null = server-wide cap. Usage is counted
// from audit_log allow rows at evaluation time, not stored here.
// PILLAR 1 rule scoping: same scope/serverScope discriminant as approval_rules
// (see there). A role/team/fleet limit's window is still counted PER USER —
// each subject the widened rule matches keeps its own independent count.
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "role", "team", "fleet"] })
      .notNull()
      .default("user"),
    serverScope: text("server_scope", { enum: ["server", "all"] }).notNull().default("server"),
    toolName: text("tool_name"),
    maxCalls: integer("max_calls").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_limits_user_server_idx").on(t.userId, t.serverId),
    index("rate_limits_scope_idx").on(t.scope, t.serverScope, t.serverId),
    index("rate_limits_role_idx").on(t.roleId),
    index("rate_limits_team_idx").on(t.teamId),
  ],
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
    objectType: text("object_type", {
      enum: ["mcp_tool", "workflow", "run", "project", "infra_operation"],
    })
      .notNull()
      .default("mcp_tool"),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    ruleId: uuid("rule_id"),
    instanceId: uuid("instance_id"),
    /** orchestration-run escalations (§3): the run this approval gates; stageId carries the node id */
    runId: uuid("run_id"),
    /** pillar 5 project-budget escalations */
    projectId: uuid("project_id"),
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
// PILLAR 1 rule scoping: same scope/serverScope discriminant as approval_rules
// (see there). Every matching scoped rule must still be satisfied — a widened
// rule set composes to the INTERSECTION of allow-lists, never a relaxation.
export const dataScopeRules = pgTable(
  "data_scope_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "role", "team", "fleet"] })
      .notNull()
      .default("user"),
    serverScope: text("server_scope", { enum: ["server", "all"] }).notNull().default("server"),
    toolName: text("tool_name"),
    argPath: text("arg_path").notNull(),
    allowedValues: jsonb("allowed_values").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("data_scope_rules_user_server_idx").on(t.userId, t.serverId),
    index("data_scope_rules_scope_idx").on(t.scope, t.serverScope, t.serverId),
    index("data_scope_rules_role_idx").on(t.roleId),
    index("data_scope_rules_team_idx").on(t.teamId),
  ],
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
  // MODEL DISPATCH: provider-native model id this registry entry executes as
  // (e.g. claude-opus-5). null = decision/routing-only, not dispatchable.
  model: text("model"),
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
  // free-text display CATEGORY (e.g. "crm", "issue-tracker") — NOT the adapter.
  kind: text("kind").notNull(),
  // EXECUTION (pillar 5 §10.3): the connector-provider adapter enum
  // (http/webhook/generic/mock/…). Null = governance-only: the invoke endpoint
  // still evaluates policy + writes one audit row but contacts nothing and
  // meters nothing (today's behaviour). Non-null = the call really executes.
  providerKind: text("provider_kind"),
  // connection root for the adapter (generic/http/webhook); a credential row may
  // override it (credential.baseUrl wins), mirroring model_credentials.
  baseUrl: text("base_url"),
  // pillar 5: flat list price per allowed call. Null = unpriced → cost null,
  // never invented (mirrors agents' costPerMTok null-safety).
  pricePerCallUsd: doublePrecision("price_per_call_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// EXECUTION: one platform credential per connector, AES-256-GCM encrypted with
// REGULAIT_DATA_KEY (same discipline as model/git/PM tokens — never plaintext
// at rest, never returned by any endpoint). Keyless kinds (mock, unauthenticated
// generic) never write a row here. Platform-scoped only this slice (no per-user
// BYO connector credential yet).
export const connectorCredentials = pgTable("connector_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectorId: uuid("connector_id")
    .notNull()
    .unique()
    .references(() => connectors.id, { onDelete: "cascade" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  baseUrl: text("base_url"),
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

// §5 role-bundled agent/connector grants: the AGENT/CONNECTOR twins of
// roleToolGrants/roleServerGrants. Assigning a role confers these to a user
// exactly as a direct agentGrant/connectorGrant would — same field shape, so a
// role grant can never exceed a direct grant. Additive (UNION-MAX with direct
// grants), and — since ADR-0019 — BOUNDED by the subtractive per-user
// agentRevocations/connectorRevocations below, so a role-derived agent or
// connector can be taken away from ONE user without unassigning the role. See
// ADR-0014, ADR-0019.
export const roleAgentGrants = pgTable(
  "role_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    allowedModes: jsonb("allowed_modes").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_agent_grants_role_agent_uq").on(t.roleId, t.agentId)],
);

export const roleConnectorGrants = pgTable(
  "role_connector_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["read", "readwrite"] }).notNull(),
    allowedObjects: jsonb("allowed_objects").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_connector_grants_role_connector_uq").on(t.roleId, t.connectorId)],
);

// ADR-0019 — the AGENT/CONNECTOR twins of the MCP `revocations` table, closing
// pillar 1's "role builder + PER-USER OVERRIDE" promise for the two object
// types that had no subtractive override. Unlike the MCP revocation (which is
// role-only, because a direct MCP grant is itself the per-user override), an
// agent/connector revocation is TOTAL for that (user, object): it beats a
// direct grant AND every role-derived grant, because the UNION-MAX composition
// of ADR-0014 otherwise leaves an admin no way to subtract one object from one
// user. A revocation can ONLY ever turn an allow into a deny — the kernel
// consults it strictly on the allow path, so it can never rescue an ungranted
// call. Deleting the row reverses the override, exactly like `revocations`.
export const agentRevocations = pgTable(
  "agent_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** admin's free-text justification — audit prose only, never a policy input */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_revocations_user_agent_uq").on(t.userId, t.agentId),
    index("agent_revocations_user_idx").on(t.userId),
  ],
);

export const connectorRevocations = pgTable(
  "connector_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connector_revocations_user_connector_uq").on(t.userId, t.connectorId),
    index("connector_revocations_user_idx").on(t.userId),
  ],
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
  // ADR-0018 (§4 6-dim matching): the target system a change lands on, and the
  // role the initiating user must hold for this rule to apply. initiator_role is
  // matched against the SERVER-derived roles of the authenticated initiator —
  // never a client-supplied value.
  targetSystem: text("target_system"),
  initiatorRole: text("initiator_role"),
  // ADR-0018 addendum (ADR-0019): the 6th and final dim. SERVER-RESOLVED like
  // initiator_role — matched against the compliance classification tags of the
  // change's attributed project (the same source effectiveCompliancePolicy
  // cascades from), never a client-supplied value. No project / no
  // classifications = matches as absent.
  dataSensitivity: text("data_sensitivity"),
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
    /** PILLAR 5 attribution: nested runs and their dispatches inherit this */
    projectId: uuid("project_id"),
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

// §2 pillar-2 deploy targets: a governed destination a `deployment`/`rollback`
// stage acts on. Provider-agnostic (mock now; AWS/Azure/GCP/k8s later — the
// BYOC/air-gapped angle of pillar 3). Credentials are optional (mock needs
// none) and, when present, encrypted at rest exactly like a git connection
// token. A deploy stage naming a target that doesn't exist parks at a manual
// handoff — that's the "connector-availability" gate.
export const deployTargets = pgTable("deploy_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", {
    enum: ["mock", "aws", "azure", "gcp", "kubernetes"],
  }).notNull(),
  environment: text("environment"),
  baseUrl: text("base_url"),
  credentialCiphertext: text("credential_ciphertext"),
  // §3 BYOC deployment mode: hosted (we run it), byoc (customer's own cloud
  // account/IAM), or air_gapped (customer-hosted, no execution-plane data ever
  // returns to the control plane — the deploy record we keep is metadata-only).
  mode: text("mode", { enum: ["hosted", "byoc", "air_gapped"] }).notNull().default("hosted"),
  // §3 aws BYOC: the customer IAM role we assume (short-lived creds, no static
  // keys) and the region to deploy in. Null for the mock/hosted provider.
  roleArn: text("role_arn"),
  region: text("region"),
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
        "semantic_caching",
        "request_batching",
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
    /** PILLAR 5 attribution; FK-free like the rest of the ledger */
    projectId: uuid("project_id"),
    detail: jsonb("detail"),
  },
  (t) => [
    index("cost_events_user_at_idx").on(t.userId, t.at),
    index("cost_events_technique_idx").on(t.technique),
  ],
);

// OPTIMIZATION §8/§10 semantic caching: a REAL exact-match response cache,
// scoped strictly per (user, agent). A row is the CALLER'S OWN record — like
// the rest of the ledger it carries no FKs, and the §12 governance boundary is
// enforced at the route by scoping every lookup with BOTH userId AND agentId,
// so a user can never be served another user's (or another agent's) cached
// response. promptHash is the sha256 of the normalized input; normalizedInput
// is stored beside it as a hash-collision guard (the route re-checks equality).
export const semanticCache = pgTable(
  "semantic_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(), // SCOPE — never cross-user
    agentId: uuid("agent_id").notNull(), // SCOPE — never cross-agent
    promptHash: text("prompt_hash").notNull(), // sha256 of the normalized input
    normalizedInput: text("normalized_input").notNull(), // stored to guard against hash collision
    outputText: text("output_text").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("semantic_cache_user_agent_hash_uq").on(t.userId, t.agentId, t.promptHash)],
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
    /** PILLAR 5 attribution: every node dispatch of this run bills here */
    projectId: uuid("project_id"),
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
  /** jira only: REST API version (2 = legacy plain text, 3 = ADF rich text);
   * null = the provider default (v2) — connections minted before this column
   * existed keep behaving exactly as they did. */
  apiVersion: integer("api_version"),
  /** ADR-0010: sha256 of the per-connection webhook secret (plaintext shown once) */
  webhookSecretHash: text("webhook_secret_hash"),
  /** Provider-native inbound verification (pillar 8 depth): HMAC signature
   * checks (linear/asana/generic) need the secret itself, which a hash cannot
   * key — stored AES-256-GCM-encrypted like the connection token. Null on
   * connections minted before this column existed (legacy-header flows only). */
  webhookSecretCiphertext: text("webhook_secret_ciphertext"),
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
    objectType: text("object_type", { enum: ["run_node", "run", "workflow_instance", "decision"] }).notNull(),
    objectId: uuid("object_id").notNull(),
    /** task-graph node id when objectType is run_node */
    nodeId: text("node_id"),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** ADR-0010 inbound: last state reported BY the PM tool — recorded, never
     * applied to the state machine; divergence surfaces as drift */
    inboundState: text("inbound_state"),
    inboundAt: timestamp("inbound_at", { withTimezone: true }),
    /** set when the PM tool reports the item deleted */
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT applied in the hand-written migration (0005 precedent)
    uniqueIndex("pm_links_conn_obj_node_uq").on(t.connectionId, t.objectType, t.objectId, t.nodeId),
    index("pm_links_object_idx").on(t.objectType, t.objectId),
  ],
);

// PM-TOOL INTEGRATION §4: first-class Decision records. FK-free like
// audit_log — a decision is a governance record that must survive the
// deletion of the run/instance/user it describes.
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectType: text("object_type", { enum: ["run", "workflow_instance"] }).notNull(),
    objectId: uuid("object_id").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    /** always the authenticated identity — never a body field */
    decisionMakerUserId: uuid("decision_maker_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("decisions_object_idx").on(t.objectType, t.objectId)],
);

// ADR-0010: append-only inbound webhook event log — every signal the PM tool
// sends is retained, matched or not.
export const pmSyncEvents = pgTable(
  "pm_sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => pmConnections.id, { onDelete: "cascade" }),
    linkId: uuid("link_id"),
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: ["updated", "deleted", "commented"] }).notNull(),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pm_sync_events_conn_idx").on(t.connectionId, t.receivedAt)],
);

// MODEL DISPATCH: one platform credential per model provider, AES-256-GCM
// encrypted with REGULAIT_DATA_KEY (same discipline as git/PM connection
// tokens — never plaintext at rest, never returned by any endpoint).
export const modelCredentials = pgTable("model_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().unique(),
  keyCiphertext: text("key_ciphertext").notNull(),
  /** override for BYOC/air-gapped bridges; null = provider default endpoint */
  baseUrl: text("base_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PILLAR 5: the MEASURED actual-spend ledger. Distinct from cost_events on
// purpose — cost_events rows are estimates (estimationBasis says so); rows
// here carry the provider's own token accounting for a dispatch that really
// happened. FK-free like audit_log: spend records outlive their subjects.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    /** what this spend row is FOR: 'agent' (model dispatch) or 'connector'
     * (a governed connector call). One ledger, so the per-project rollup
     * picks connector spend up automatically. */
    objectType: text("object_type").notNull().default("agent"),
    /** the agent that actually served (post-routing) — null on connector rows */
    agentId: uuid("agent_id"),
    requestedAgentId: uuid("requested_agent_id"),
    baselineAgentId: uuid("baseline_agent_id"),
    /** connector rows only: the connector that executed, and its operation */
    connectorId: uuid("connector_id"),
    operation: text("operation"),
    /** null on connector rows (no provider/model/tokens) */
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** agent rows: measured tokens × list price. connector rows: the
     * connector's flat price_per_call_usd. Null = unpriced, never invented. */
    costUsd: doublePrecision("cost_usd"),
    /** what the routing baseline would have cost at the SAME measured token
     * volumes, minus costUsd — the honest, measured version of the routing
     * savings that cost_events could only estimate */
    measuredCostSavedUsd: doublePrecision("measured_cost_saved_usd"),
    stopReason: text("stop_reason"),
    refusal: boolean("refusal").notNull().default(false),
    providerMessageId: text("provider_message_id"),
    /** PILLAR 5 attribution; FK-free like the rest of the ledger */
    projectId: uuid("project_id"),
    detail: jsonb("detail"),
  },
  (t) => [index("usage_events_user_idx").on(t.userId, t.at)],
);

// MODEL DISPATCH: per-user provider credentials (BYO key). Resolution order
// at dispatch is user credential → platform model_credentials → explicit
// failure; same encryption discipline (AES-256-GCM under REGULAIT_DATA_KEY,
// never plaintext at rest, never returned by any endpoint).
export const userModelCredentials = pgTable(
  "user_model_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_model_credentials_user_provider_uq").on(t.userId, t.provider)],
);

// PILLAR 5 cross-team rollup: an Initiative is a flat, reporting-only grouping
// of projects for cost attribution across teams (chargeback/showback at a
// higher level than a single project). v1 is grouping only — no initiative-level
// budget or enforcement; a project's own budget/governance is unchanged.
// Declared before `projects` so the projects.initiativeId FK is an ordinary
// forward reference rather than a thunk-only one.
export const initiatives = pgTable("initiatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** chargeback/showback: the customer's own cost-center code for the initiative */
  costCenter: text("cost_center"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PILLAR 5: the cost-attribution object. Minimal on purpose — membership and
// sharing semantics arrive with Shared Projects (pillar 4); until then any
// authenticated caller may attribute spend to a project (noted, deferred).
// A budget requires a named approver: enforcement escalates into the ONE
// approvals queue and only that approver can sanction the overage.
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** chargeback/showback: the customer's own cost-center code */
  costCenter: text("cost_center"),
  /** pillar-5 rollup: optional parent Initiative for cross-team cost grouping.
   * Reporting-only — grouping a project under an initiative changes NO
   * governance or budget behaviour. onDelete 'set null': deleting an initiative
   * orphans its children back to ungrouped, never deletes project rows. */
  initiativeId: uuid("initiative_id").references(() => initiatives.id, { onDelete: "set null" }),
  budgetUsd: doublePrecision("budget_usd"),
  budgetApproverUserId: uuid("budget_approver_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  /** pillar-5 budget window: 'none' = lifetime-cumulative (default, back-compat);
   * 'monthly' = only spend within the current calendar month (UTC) counts. */
  budgetPeriod: text("budget_period").notNull().default("none"),
  /** warn (non-blocking) when windowed spend crosses budget*pct/100; the hard
   * block + escalation always stays at 100%. Default 100 = warn only at the cap
   * (byte-identical to the pre-threshold behaviour). */
  alertThresholdPct: integer("alert_threshold_pct").notNull().default(100),
  /** a decided __project_budget__ approval lifts enforcement for this project */
  overageApproved: boolean("overage_approved").notNull().default(false),
  /** the period key (e.g. '2026-07') an overage was approved for; the latch
   * only suppresses enforcement while it equals the current period. Null when
   * budgetPeriod='none' (the lifetime latch is unscoped) or never approved. */
  overageApprovedPeriod: text("overage_approved_period"),
  /** §9 named arbiter for shared-context conflicts; absent = conflicting
   * writes are rejected explicitly (never silently) */
  arbiterUserId: uuid("arbiter_user_id").references(() => users.id, { onDelete: "set null" }),
  /** §8.3: compliance framework tags (multi-valued — hipaa, pci-dss, soc2,
   * gdpr, custom…; the spec defines NO strictness ordering among frameworks) */
  classifications: jsonb("classifications").$type<string[]>(),
  /** §8.3 reclassification: proposed tags awaiting the diff-then-approve
   * review — never applied silently */
  pendingClassifications: jsonb("pending_classifications").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// MULTI-TURN CONVERSATIONS: a personal (per-user) thread of governed
// dispatches against one agent. FK-free ids on purpose, like the ledgers —
// a conversation is the user's own record and must not vanish because an
// agent or project row was deleted; access control is enforced at the
// routes (strictly own-scoped, admins included).
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** pillar 5 default attribution for every turn dispatched in this thread */
    projectId: uuid("project_id"),
    /** auto-titled from the first user turn (~60 chars) when left null */
    title: text("title"),
    /** PILLAR 6 §5 context compaction: the persisted summary of every turn up
     * to and including summary_through_message_id. One summary per
     * conversation, REPLACED cumulatively on re-compaction (new input =
     * existing summary + turns since). Stored messages are never deleted or
     * altered — these fields only change what is model-bound. */
    summary: text("summary"),
    summaryThroughMessageId: uuid("summary_through_message_id"),
    /** chars/4 estimate of the summary — the cost side of the savings claim */
    summaryTokens: integer("summary_tokens"),
    compactedAt: timestamp("compacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_user_updated_idx").on(t.userId, t.updatedAt)],
);

// One row per persisted turn. Assistant turns carry the dispatch facts in
// detail (stopReason/refusal/servedAgentId/modelUsed/costUsd/credentialSource);
// a user turn that was governance-DENIED carries detail.denied so history
// shows the attempt honestly. createdAt is written explicitly by the gateway
// (user turn strictly before its assistant turn) so ordering never depends on
// a shared transaction timestamp.
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_messages_conv_at_idx").on(t.conversationId, t.createdAt)],
);

// §8.3: the cascade expressed as DATA — one admin-editable profile per
// framework tag, mapping it to what it drives. Workflow requirements are
// ENFORCED at instance creation; mcp/retention/pii are declared policy the
// compliance view surfaces with honest enforcement labels until their
// enforcement points exist.
export const complianceProfiles = pgTable("compliance_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tag: text("tag").notNull().unique(),
  /** workflow templates this framework forces into every governed change */
  requiredTemplateIds: jsonb("required_template_ids").$type<string[]>(),
  mcpDefaultMode: text("mcp_default_mode", { enum: ["read_only", "read_write"] })
    .notNull()
    .default("read_write"),
  auditRetentionDays: integer("audit_retention_days"),
  piiMode: text("pii_mode", { enum: ["block", "warn", "log"] }).notNull().default("log"),
  /** §8.3 -> §8.2 tie: the backup retention + patch cadence this framework
   * forces onto any infra resource carrying its tag (pillar 3). Null = the
   * framework declares no infra floor of its own. */
  backupRetentionDays: integer("backup_retention_days"),
  patchCadenceDays: integer("patch_cadence_days"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PILLAR 4 (§9, ADR-0011): teams and Shared-Project membership. Membership
// roles are per-user and DECOUPLED from home-team role; membership widens
// what context a member sees, never what tools/agents they may call.
export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** §9.3: the team's default classifications; a Shared Project's own tags
   * take precedence inside the project, and mismatches are SURFACED (never
   * silently resolved) at member-add */
  defaultClassifications: jsonb("default_classifications").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("team_members_team_user_uq").on(t.teamId, t.userId)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** the member's contributing team, for provenance defaults; optional */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    role: text("role", { enum: ["owner", "contributor", "viewer"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_members_project_user_uq").on(t.projectId, t.userId)],
);

// §9.2 shared context store: APPEND-ONLY revisions. The current value of a
// key is its highest ACCEPTED revision; a write based on a stale revision is
// retained but not accepted (a conflict for the named arbiter). Contributor
// ids are FK-free — provenance is a governance record that must survive
// user/team deletion.
export const projectContextItems = pgTable(
  "project_context_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    revision: integer("revision").notNull(),
    content: text("content").notNull(),
    /** the accepted revision the writer based this on; null = first write */
    baseRevision: integer("base_revision"),
    accepted: boolean("accepted").notNull().default(true),
    contributedByUserId: uuid("contributed_by_user_id").notNull(),
    contributedByTeamId: uuid("contributed_by_team_id"),
    /** §9.4 promotion provenance: the team-local artifact this came from */
    sourceArtifactId: uuid("source_artifact_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_context_project_key_rev_uq").on(t.projectId, t.key, t.revision),
    index("project_context_project_key_idx").on(t.projectId, t.key),
  ],
);

// PILLAR 3 (§8.2): a GOVERNED-OPERATIONS layer — monitored resources +
// operational policies + detected findings + governed remediation. NOT a real
// infra patcher: findings are inert reports; a remediation is a governed action
// (auto-remediated under policy, or approval-gated) that runs strictly after
// the governance decision, exactly like the connector execution layer.

// A monitored piece of infrastructure. `provider` is an infra-provider kind
// ('mock' for the MVP); `classifications` carries §8.3 compliance tags whose
// cascade derives the resource's backup/patch floors (§8.3 -> §8.2).
export const infraResources = pgTable("infra_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["control_plane", "agent_runtime", "cert", "backup_target"] }).notNull(),
  name: text("name").notNull().unique(),
  /** infra-provider kind — 'mock' is keyless/deterministic for the MVP */
  provider: text("provider").notNull().default("mock"),
  /** provider-specific handle (endpoint, days-until-expiry, backup age, …) */
  config: jsonb("config").$type<Record<string, unknown>>(),
  /** §8.3 compliance tags — the cascade applies backup/patch floors */
  classifications: jsonb("classifications").$type<string[]>(),
  /** ADR-0017 — a monitored resource MAY live in a customer-hosted deploy
   * target; an air_gapped target forces metadata-only remediation records
   * (the ADR-0015 control-plane data boundary). ON DELETE SET NULL: dropping a
   * target must never cascade-delete the monitored resource. */
  deployTargetId: uuid("deploy_target_id").references(() => deployTargets.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// An operational policy. A null resourceId is FLEET-WIDE (a default for every
// resource); a resource-scoped policy overrides it. `autoRemediateMaxSeverity`
// is the ceiling at/under which a NEW finding is auto-remediated (audited, no
// approval) — null = never auto-remediate. 'critical' is NOT a valid value:
// critical findings are ALWAYS approval-gated regardless of policy.
export const infraPolicies = pgTable(
  "infra_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id").references(() => infraResources.id, { onDelete: "cascade" }),
    patchCadenceDays: integer("patch_cadence_days"),
    certRotationDaysBeforeExpiry: integer("cert_rotation_days_before_expiry"),
    backupSchedule: text("backup_schedule"),
    backupRetentionDays: integer("backup_retention_days"),
    driftBaseline: jsonb("drift_baseline").$type<Record<string, unknown>>(),
    autoRemediateMaxSeverity: text("auto_remediate_max_severity", {
      enum: ["low", "medium", "high"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("infra_policies_resource_idx").on(t.resourceId)],
);

// A detected finding — an INERT report until governed. `signature` (carried in
// detail) is a stable natural key so a re-scan is idempotent: the unique index
// on (resource_id, kind, detail->>'signature') means scanning twice refreshes
// detected_at rather than duplicating an open finding.
export const infraFindings = pgTable(
  "infra_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["drift", "cve", "cert_expiring", "backup_missed"] }).notNull(),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    /** ADR-0017 — a finding stays the single inert alert surface but now links
     * to its durable domain ledger row (FK-less soft link: which table + id).
     * null for drift, which has no ledger. */
    refTable: text("ref_table"),
    refId: uuid("ref_id"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status", {
      enum: [
        "open",
        "remediation_proposed",
        "auto_remediated",
        "approved",
        "remediated",
        "accepted_risk",
      ],
    })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("infra_findings_resource_idx").on(t.resourceId),
    uniqueIndex("infra_findings_natural_key_uq").on(
      t.resourceId,
      t.kind,
      sql`(${t.detail}->>'signature')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0017 — infra-ops automation ledgers (pillar 3 §8.2 automation depth).
// Durable domain records hang off infra_resources and link back to the inert
// infra_findings alert surface via ref_table/ref_id. Remediation still flows
// through the ONE Approvals Queue (objectType infra_operation) — these tables
// record OUTCOMES, they never introduce a second decision path.
// ---------------------------------------------------------------------------

// Certificate inventory — one row per tracked certificate on a resource. A
// cert_expiring finding upserts the matching inventory row; a governed rotation
// advances not_after/last_rotated_at/status.
export const certInventory = pgTable(
  "cert_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    commonName: text("common_name").notNull(),
    issuer: text("issuer"),
    serial: text("serial"),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    // active | rotation_proposed | rotated | expired — text (no DB CHECK), like
    // infra_findings, so drizzle owns the enum.
    status: text("status", {
      enum: ["active", "rotation_proposed", "rotated", "expired"],
    })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cert_inventory_resource_idx").on(t.resourceId)],
);

// A governed cert rotation OUTCOME. Written inside the /decide txn on approve.
export const certRotations = pgTable("cert_rotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  certId: uuid("cert_id")
    .notNull()
    .references(() => certInventory.id, { onDelete: "cascade" }),
  findingId: uuid("finding_id"),
  approvalId: uuid("approval_id"),
  oldSerial: text("old_serial"),
  newSerial: text("new_serial"),
  newNotAfter: timestamp("new_not_after", { withTimezone: true }),
  status: text("status", { enum: ["proposed", "rotated", "failed"] })
    .notNull()
    .default("proposed"),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// CVE patch ledger — one row per (resource, CVE). A cve finding upserts on the
// UNIQUE(resource_id, cve); a governed patch advances status/patched_at.
export const patchRecords = pgTable(
  "patch_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id"),
    cve: text("cve").notNull(),
    package: text("package"),
    installedVersion: text("installed_version"),
    fixedVersion: text("fixed_version"),
    cvss: numeric("cvss"),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] }).notNull(),
    // open | patch_proposed | patched | accepted_risk
    status: text("status", {
      enum: ["open", "patch_proposed", "patched", "accepted_risk"],
    })
      .notNull()
      .default("open"),
    patchedAt: timestamp("patched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("patch_records_resource_cve_uq").on(t.resourceId, t.cve)],
);

// Backup / restore run ledger. A backup_missed finding appends a 'missed' row;
// a governed restore appends a kind='restore' status='restored' row.
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id"),
    kind: text("kind", { enum: ["backup", "restore"] }).notNull().default("backup"),
    // success | failed | missed | restore_proposed | restored
    status: text("status", {
      enum: ["success", "failed", "missed", "restore_proposed", "restored"],
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("backup_runs_resource_idx").on(t.resourceId)],
);

// ---------------------------------------------------------------------------
// ADR-0020 — IDE / existing-agent INTERCEPTION posture (Batch H).
//
// RegulAIt governs calls that ARRIVE at it. Whether a developer's IDE sends
// its calls here is an ADMIN choice, not a product constant, so every axis of
// the interception surface is configuration rather than hardcoded behaviour:
// which provider-shaped compatibility surfaces exist at all, how an IDE's
// `model` string resolves onto a governed agent, whether attribution is
// mandatory, and which rung of the enforcement ladder the org declares it is
// on. ONE ROW, ever — the posture is deployment-wide, exactly like the
// control plane it describes. The singleton is enforced by a fixed primary
// key plus a CHECK, so a second row is a database error rather than a silent
// second policy.
//
// DEFAULT-DENY POSTURE: both compat surfaces default to FALSE. A new
// interception surface is something an admin opts INTO; until then the
// endpoints answer 404 and are indistinguishable from not existing.
// ---------------------------------------------------------------------------
export const INTERCEPTION_SETTINGS_ID = "singleton";

/** How an IDE's `model` string resolves onto a governed agent (ADR-0020). */
export const RESOLUTION_MODES = ["map_by_model", "require_agent", "router_decides"] as const;
export type ResolutionMode = (typeof RESOLUTION_MODES)[number];

/** The rung of Batch H's interception ladder the org DECLARES it is on. This
 * is descriptive, not enforcing: it drives the honest warnings the admin UI
 * shows. `observe` and `voluntary` are honor systems; `key_custody` and
 * `network` are the non-bypassable rungs, and both are customer IT policy /
 * infrastructure rather than gateway code. */
export const ENFORCEMENT_POSTURES = [
  "observe",
  "voluntary",
  "managed",
  "key_custody",
  "network",
] as const;
export type EnforcementPosture = (typeof ENFORCEMENT_POSTURES)[number];

export const interceptionSettings = pgTable(
  "interception_settings",
  {
    id: text("id").primaryKey().default(INTERCEPTION_SETTINGS_ID),
    // OFF by default: an admin opts INTO exposing a provider-shaped surface.
    anthropicCompatEnabled: boolean("anthropic_compat_enabled").notNull().default(false),
    openaiCompatEnabled: boolean("openai_compat_enabled").notNull().default(false),
    // ON by default: POST /mcp/:serverId already ships and is already governed
    // (allow-lists, data scope, rate limits, approvals, audit, attribution).
    // Turning it OFF makes it 404 exactly like a disabled compat surface.
    mcpInterceptionEnabled: boolean("mcp_interception_enabled").notNull().default(true),
    resolutionMode: text("resolution_mode", { enum: RESOLUTION_MODES })
      .notNull()
      .default("map_by_model"),
    enforcementPosture: text("enforcement_posture", { enum: ENFORCEMENT_POSTURES })
      .notNull()
      .default("voluntary"),
    // The admin's lever to guarantee pillar-5 coverage: when true a compat
    // call with no x-regulait-project-id is REJECTED rather than run
    // unattributed.
    requireProjectAttribution: boolean("require_project_attribution").notNull().default(false),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("interception_settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type InterceptionSettingsRow = typeof interceptionSettings.$inferSelect;

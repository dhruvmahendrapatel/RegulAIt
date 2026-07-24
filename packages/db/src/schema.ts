import {
  boolean,
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
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    serverId: uuid("server_id").notNull(),
    toolName: text("tool_name").notNull(),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
    ruleId: text("rule_id").notNull(),
    ruleChain: jsonb("rule_chain").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [index("audit_log_user_at_idx").on(t.userId, t.at)],
);

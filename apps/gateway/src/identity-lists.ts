/**
 * ADR-0219 — the identity-and-access lists under the shared list contract
 * (list-contract.ts): each list's sortable columns, export columns, filters,
 * default sort and reader. Every route keeps its own authorisation (the
 * default admin gate for all of these) and its own WHERE, so the page, the
 * count and the Excel export read through one predicate.
 *
 * Never a secret: no token, hash, prefix or ciphertext is selected here, and an
 * export names only the columns its list shows. API keys show and export their
 * name, holder, dates and state; sessions their times, addresses, device family,
 * origin and state (never the token hash).
 */
import { z } from "zod";
import {
  agentRevocations,
  agents,
  and,
  apiKeys,
  authSessions,
  chatIdentityLinks,
  chatopsConnections,
  connectorRevocations,
  connectors,
  eq,
  federatedLinkRequests,
  inArray,
  isNotNull,
  licenseVerifications,
  mcpServers,
  oidcProviders,
  revocations,
  roleAssignments,
  samlProviders,
  sql,
  teamMembers,
  teams,
  users,
  type Db,
  type SQL,
} from "@regulait/db";
import { filterParams, parseListExport, parseListPage, runListPage, sendListError, sendListExport, type ListReader, type ListSpec } from "./list-contract.js";
import { deviceLabel } from "./device-label.js";
import { API_KEY_EXPIRING_WINDOW_DAYS, apiKeyState } from "./api-key-expiry.js";
import { withStewardship } from "./agent-stewardship.js";
import { likeLiteral } from "./users-list.js";

/** a list with no filters of its own: any other param is a 400 */
export const noListFilters = z.object({}).strict();

const conj = (conds: Array<SQL | undefined>): SQL | undefined => {
  const c = conds.filter((x): x is SQL => x !== undefined);
  return c.length ? and(...c) : undefined;
};
const iso = (d: Date | string | null | undefined) => (d === null || d === undefined ? null : d instanceof Date ? d : new Date(d));
/** a person as the lists show them */
const personSql = (name: typeof users.displayName, email: typeof users.email) => sql<string>`coalesce(nullif(${name}, ''), ${email})`;

// ---- a user's browser sessions (/v1/users/:userId/sessions) -----------------

export interface SessionRow {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  lastSeenIp: string | null;
  userAgent: string | null;
  origin: string;
  revokedAt: Date | null;
  deviceLabel?: string;
}

export const sessionsFilterQuery = z.object({ status: z.enum(["live", "expired", "revoked"]).optional() }).strict();

const sessionState = sql<string>`case when ${authSessions.revokedAt} is not null then 'revoked' when ${authSessions.expiresAt} <= now() then 'expired' else 'live' end`;

export function sessionsWhere(userId: string, f: z.infer<typeof sessionsFilterQuery>): SQL | undefined {
  return conj([
    eq(authSessions.userId, userId),
    f.status === "live" ? sql`${authSessions.revokedAt} is null and ${authSessions.expiresAt} > now()` : undefined,
    f.status === "expired" ? sql`${authSessions.revokedAt} is null and ${authSessions.expiresAt} <= now()` : undefined,
    f.status === "revoked" ? isNotNull(authSessions.revokedAt) : undefined,
  ]);
}

export const sessionsReader = (db: Db): ListReader<SessionRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        idleExpiresAt: authSessions.idleExpiresAt,
        lastSeenAt: authSessions.lastSeenAt,
        ip: authSessions.ip,
        lastSeenIp: authSessions.lastSeenIp,
        userAgent: authSessions.userAgent,
        origin: authSessions.origin,
        revokedAt: authSessions.revokedAt,
        _cursorAt: q.cursorAt,
      })
      .from(authSessions)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    return rows.map((s) => ({ ...s, deviceLabel: deviceLabel(s.userAgent) }));
  },
  countable: (where) => db.select({ one: sql`1` }).from(authSessions).where(where),
  idOf: (r) => r.id,
});

const sessionStatus = (s: SessionRow) => (s.revokedAt ? "revoked" : s.expiresAt.getTime() <= Date.now() ? "expired" : "live");

export const SESSIONS_LIST: ListSpec<SessionRow> = {
  id: "sessions",
  sorts: {
    created: { expr: authSessions.createdAt, keysetAt: authSessions.createdAt },
    seen: { expr: authSessions.lastSeenAt, keysetAt: authSessions.lastSeenAt },
    ip: { expr: sql`coalesce(${authSessions.lastSeenIp}, ${authSessions.ip})` },
    origin: { expr: authSessions.origin },
    status: { expr: sessionState },
    expires: { expr: authSessions.expiresAt, keysetAt: authSessions.expiresAt },
  },
  columns: {
    created: { label: "Signed in", value: (s) => s.createdAt },
    seen: { label: "Last seen", value: (s) => s.lastSeenAt },
    ip: { label: "IP (current · at sign-in)", value: (s) => [s.lastSeenIp ?? s.ip, s.lastSeenIp && s.ip && s.lastSeenIp !== s.ip ? s.ip : null].filter(Boolean).join(" · ") || null },
    device: { label: "Device", value: (s) => s.deviceLabel ?? deviceLabel(s.userAgent) },
    origin: { label: "Origin", value: (s) => s.origin },
    status: { label: "Status", value: sessionStatus },
    expires: { label: "Expires", value: (s) => s.expiresAt },
  },
  filters: ["status"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: authSessions.id,
};

// ---- MCP revocations (/v1/revocations) --------------------------------------

export interface McpRevocationRow {
  id: string;
  userId: string;
  serverId: string;
  serverName: string | null;
  toolName: string | null;
  scope: "full" | "read_only";
  createdAt: Date;
}

export const mcpRevocationsFilterQuery = z
  .object({ userId: z.string().uuid().optional(), serverId: z.string().uuid().optional() })
  .strict();

export function mcpRevocationsWhere(f: z.infer<typeof mcpRevocationsFilterQuery>): SQL | undefined {
  return conj([f.userId ? eq(revocations.userId, f.userId) : undefined, f.serverId ? eq(revocations.serverId, f.serverId) : undefined]);
}

export const mcpRevocationsReader = (db: Db): ListReader<McpRevocationRow> => ({
  fetch: (q) =>
    db
      .select({
        id: revocations.id,
        userId: revocations.userId,
        serverId: revocations.serverId,
        serverName: mcpServers.name,
        toolName: revocations.toolName,
        scope: revocations.scope,
        createdAt: revocations.createdAt,
        _cursorAt: q.cursorAt,
      })
      .from(revocations)
      .leftJoin(mcpServers, eq(mcpServers.id, revocations.serverId))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) => db.select({ one: sql`1` }).from(revocations).where(where),
  idOf: (r) => r.id,
});

export const MCP_REVOCATIONS_LIST: ListSpec<McpRevocationRow> = {
  id: "mcp-revocations",
  sorts: {
    server: { expr: sql`lower(${mcpServers.name})` },
    tool: { expr: sql`lower(${revocations.toolName})` },
    scope: { expr: revocations.scope },
    created: { expr: revocations.createdAt, keysetAt: revocations.createdAt },
  },
  columns: {
    server: { label: "Server", value: (r) => r.serverName ?? r.serverId },
    tool: { label: "Tool", value: (r) => r.toolName ?? "all role-derived" },
    scope: { label: "Scope", value: (r) => r.scope },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: ["userId", "serverId"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: revocations.id,
};

// ---- a user's agent and connector revocations --------------------------------

export interface AgentRevocationRow {
  id: string;
  userId: string;
  agentId: string;
  agentName: string;
  reason: string | null;
  createdAt: Date;
}

export const agentRevocationsReader = (db: Db): ListReader<AgentRevocationRow> => ({
  fetch: (q) =>
    db
      .select({
        id: agentRevocations.id,
        userId: agentRevocations.userId,
        agentId: agentRevocations.agentId,
        agentName: agents.name,
        reason: agentRevocations.reason,
        createdAt: agentRevocations.createdAt,
        _cursorAt: q.cursorAt,
      })
      .from(agentRevocations)
      .innerJoin(agents, eq(agentRevocations.agentId, agents.id))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) => db.select({ one: sql`1` }).from(agentRevocations).innerJoin(agents, eq(agentRevocations.agentId, agents.id)).where(where),
  idOf: (r) => r.id,
});

export const agentRevocationsWhere = (userId: string) => eq(agentRevocations.userId, userId);

export const AGENT_REVOCATIONS_LIST: ListSpec<AgentRevocationRow> = {
  id: "agent-revocations",
  sorts: {
    agent: { expr: sql`lower(${agents.name})` },
    reason: { expr: sql`lower(${agentRevocations.reason})` },
    created: { expr: agentRevocations.createdAt, keysetAt: agentRevocations.createdAt },
  },
  columns: {
    agent: { label: "Agent", value: (r) => r.agentName },
    reason: { label: "Reason", value: (r) => r.reason },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: agentRevocations.id,
};

export interface ConnectorRevocationRow {
  id: string;
  userId: string;
  connectorId: string;
  connectorName: string;
  reason: string | null;
  scope: "full" | "read_only";
  createdAt: Date;
}

export const connectorRevocationsReader = (db: Db): ListReader<ConnectorRevocationRow> => ({
  fetch: (q) =>
    db
      .select({
        id: connectorRevocations.id,
        userId: connectorRevocations.userId,
        connectorId: connectorRevocations.connectorId,
        connectorName: connectors.name,
        reason: connectorRevocations.reason,
        scope: connectorRevocations.scope,
        createdAt: connectorRevocations.createdAt,
        _cursorAt: q.cursorAt,
      })
      .from(connectorRevocations)
      .innerJoin(connectors, eq(connectorRevocations.connectorId, connectors.id))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) =>
    db.select({ one: sql`1` }).from(connectorRevocations).innerJoin(connectors, eq(connectorRevocations.connectorId, connectors.id)).where(where),
  idOf: (r) => r.id,
});

export const connectorRevocationsWhere = (userId: string) => eq(connectorRevocations.userId, userId);

export const CONNECTOR_REVOCATIONS_LIST: ListSpec<ConnectorRevocationRow> = {
  id: "connector-revocations",
  sorts: {
    connector: { expr: sql`lower(${connectors.name})` },
    reason: { expr: sql`lower(${connectorRevocations.reason})` },
    scope: { expr: connectorRevocations.scope },
    created: { expr: connectorRevocations.createdAt, keysetAt: connectorRevocations.createdAt },
  },
  columns: {
    connector: { label: "Connector", value: (r) => r.connectorName },
    reason: { label: "Reason", value: (r) => r.reason },
    scope: { label: "Scope", value: (r) => r.scope },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: connectorRevocations.id,
};

// ---- API keys (/v1/keys) ------------------------------------------------------

export interface ApiKeyRow {
  id: string;
  userId: string;
  userEmail: string | null;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  state?: string;
}

export const apiKeysFilterQuery = z
  .object({ userId: z.string().uuid().optional(), state: z.enum(["active", "expiring", "expired", "revoked"]).optional() })
  .strict();

/** active < expiring < expired < revoked, as the ADR-0098 lifecycle read derives it */
const apiKeyStateSql = sql<string>`case
  when ${apiKeys.revokedAt} is not null then 'revoked'
  when ${apiKeys.expiresAt} is null then 'active'
  when ${apiKeys.expiresAt} <= now() then 'expired'
  when ${apiKeys.expiresAt} <= now() + make_interval(days => ${API_KEY_EXPIRING_WINDOW_DAYS}) then 'expiring'
  else 'active' end`;
const apiKeyStateRank = sql`case ${apiKeyStateSql} when 'active' then 0 when 'expiring' then 1 when 'expired' then 2 else 3 end`;

export function apiKeysWhere(f: z.infer<typeof apiKeysFilterQuery>): SQL | undefined {
  return conj([f.userId ? eq(apiKeys.userId, f.userId) : undefined, f.state ? sql`${apiKeyStateSql} = ${f.state}` : undefined]);
}

export const apiKeysReader = (db: Db): ListReader<ApiKeyRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        userEmail: users.email,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
        _cursorAt: q.cursorAt,
      })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.userId))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    const now = new Date();
    return rows.map((k) => ({ ...k, state: apiKeyState(k, now) }));
  },
  countable: (where) => db.select({ one: sql`1` }).from(apiKeys).where(where),
  idOf: (r) => r.id,
});

export const API_KEYS_LIST: ListSpec<ApiKeyRow> = {
  id: "api-keys",
  sorts: {
    name: { expr: sql`lower(${apiKeys.name})` },
    user: { expr: sql`lower(${users.email})` },
    created: { expr: apiKeys.createdAt, keysetAt: apiKeys.createdAt },
    used: { expr: apiKeys.lastUsedAt },
    expires: { expr: apiKeys.expiresAt },
    status: { expr: apiKeyStateRank },
  },
  // the key itself, its hash and any prefix are never a column: the list shows none of them
  columns: {
    name: { label: "Name", value: (k) => k.name },
    user: { label: "User", value: (k) => k.userEmail },
    created: { label: "Created", value: (k) => k.createdAt },
    used: { label: "Last used", value: (k) => k.lastUsedAt ?? "never" },
    expires: { label: "Expires", value: (k) => k.expiresAt ?? "never" },
    status: { label: "Status", value: (k) => k.state ?? apiKeyState(k) },
  },
  filters: ["userId", "state"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: apiKeys.id,
};

// ---- who holds a role (/v1/roles/:roleId/assignments) ------------------------

export interface RoleHolderRow {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  disabledAt: Date | null;
  assignedAt: Date;
  origin: "direct" | "group";
}

export const roleHoldersReader = (db: Db): ListReader<RoleHolderRow> => ({
  fetch: (q) =>
    db
      .select({
        id: roleAssignments.id,
        userId: roleAssignments.userId,
        displayName: users.displayName,
        email: users.email,
        disabledAt: users.disabledAt,
        assignedAt: roleAssignments.createdAt,
        origin: roleAssignments.origin,
        _cursorAt: q.cursorAt,
      })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) => db.select({ one: sql`1` }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(where),
  idOf: (r) => r.id,
});

export const roleHoldersFilterQuery = z.object({ origin: z.enum(["direct", "group"]).optional() }).strict();
export const roleHoldersWhere = (roleId: string, f: z.infer<typeof roleHoldersFilterQuery>) =>
  conj([eq(roleAssignments.roleId, roleId), f.origin ? eq(roleAssignments.origin, f.origin) : undefined]);

export const ROLE_HOLDERS_LIST: ListSpec<RoleHolderRow> = {
  id: "role-holders",
  sorts: {
    user: { expr: sql`lower(${personSql(users.displayName, users.email)})` },
    email: { expr: sql`lower(${users.email})` },
    account: { expr: sql`(${users.disabledAt} is not null)` },
    origin: { expr: roleAssignments.origin },
    assigned: { expr: roleAssignments.createdAt, keysetAt: roleAssignments.createdAt },
  },
  columns: {
    user: { label: "User", value: (x) => x.displayName || x.email },
    email: { label: "Email", value: (x) => x.email },
    account: { label: "Account", value: (x) => (x.disabledAt ? "disabled" : "active") },
    origin: { label: "Held through", value: (x) => (x.origin === "group" ? "identity-provider group" : "direct assignment") },
    assigned: { label: "Assigned", value: (x) => x.assignedAt },
  },
  filters: ["origin"],
  defaultSort: { col: "assigned", dir: "desc" },
  idCol: roleAssignments.id,
};

// ---- teams (/v1/teams) -----------------------------------------------------------

export interface TeamRow {
  id: string;
  name: string;
  defaultClassifications: string[] | null;
  createdAt: Date;
  memberCount: number;
  members: Array<{ userId: string; name: string }>;
}

export const teamsFilterQuery = z.object({ q: z.string().trim().max(200).optional() }).strict();
export const teamsWhere = (f: z.infer<typeof teamsFilterQuery>) => (f.q ? sql`${teams.name} ilike ${likeLiteral(f.q)}` : undefined);

// written out with table names: drizzle leaves a single-table select's columns unqualified, which inside this subquery
// would bind to team_members' own id
const memberCountSql = sql<number>`(select count(*)::int from team_members tm where tm.team_id = "teams"."id")`;

export const teamsReader = (db: Db): ListReader<TeamRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        defaultClassifications: teams.defaultClassifications,
        createdAt: teams.createdAt,
        memberCount: memberCountSql,
        _cursorAt: q.cursorAt,
      })
      .from(teams)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    const ids = rows.map((r) => r.id);
    const memberRows = ids.length
      ? await db
          .select({ teamId: teamMembers.teamId, userId: teamMembers.userId, name: personSql(users.displayName, users.email) })
          .from(teamMembers)
          .innerJoin(users, eq(users.id, teamMembers.userId))
          .where(inArray(teamMembers.teamId, ids))
          .orderBy(sql`lower(${personSql(users.displayName, users.email)})`, teamMembers.userId)
      : [];
    const byTeam = new Map<string, Array<{ userId: string; name: string }>>();
    for (const m of memberRows) byTeam.set(m.teamId, [...(byTeam.get(m.teamId) ?? []), { userId: m.userId, name: m.name }]);
    return rows.map((r) => ({ ...r, members: byTeam.get(r.id) ?? [] }));
  },
  countable: (where) => db.select({ one: sql`1` }).from(teams).where(where),
  idOf: (r) => r.id,
});

export const TEAMS_LIST: ListSpec<TeamRow> = {
  id: "teams",
  sorts: {
    name: { expr: sql`lower(${teams.name})` },
    memberCount: { expr: memberCountSql },
    created: { expr: teams.createdAt, keysetAt: teams.createdAt },
  },
  columns: {
    name: { label: "Team", value: (t) => t.name },
    classifications: { label: "Default classifications", value: (t) => (t.defaultClassifications ?? []).join(", ") || null },
    memberCount: { label: "Members", value: (t) => t.memberCount },
    members: { label: "Member names", value: (t) => t.members.map((m) => m.name).join(", ") || null },
    created: { label: "Created", value: (t) => t.createdAt },
  },
  filters: ["q"],
  defaultSort: { col: "name", dir: "asc" },
  idCol: teams.id,
};

// ---- account-link requests (/v1/auth/link-requests) ---------------------------

export interface LinkRequestRow {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  provider: string;
  protocol: "oidc" | "saml";
  subject: string;
  email: string;
  idpMfa: boolean;
  status: string;
  approvals: number;
  requiredApprovals: number;
  expired: boolean;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
}

export const linkRequestsFilterQuery = z
  .object({ status: z.enum(["pending", "linked", "approved", "denied", "all"]).optional() })
  .strict();
export const linkRequestsWhere = (f: z.infer<typeof linkRequestsFilterQuery>) =>
  (f.status ?? "pending") === "all" ? undefined : eq(federatedLinkRequests.status, (f.status ?? "pending") as "pending");

export const linkRequestsReader = (db: Db): ListReader<LinkRequestRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({
        id: federatedLinkRequests.id,
        userId: federatedLinkRequests.userId,
        userEmail: users.email,
        userDisplayName: users.displayName,
        oidcProviderId: federatedLinkRequests.oidcProviderId,
        oidcProviderName: oidcProviders.name,
        samlProviderName: samlProviders.name,
        subject: federatedLinkRequests.subject,
        email: federatedLinkRequests.email,
        idpMfa: federatedLinkRequests.idpMfa,
        status: federatedLinkRequests.status,
        approvals: federatedLinkRequests.approvals,
        userIsAdmin: users.isAdmin,
        createdAt: federatedLinkRequests.createdAt,
        expiresAt: federatedLinkRequests.expiresAt,
        decidedAt: federatedLinkRequests.decidedAt,
        _cursorAt: q.cursorAt,
      })
      .from(federatedLinkRequests)
      .innerJoin(users, eq(users.id, federatedLinkRequests.userId))
      .leftJoin(oidcProviders, eq(oidcProviders.id, federatedLinkRequests.oidcProviderId))
      .leftJoin(samlProviders, eq(samlProviders.id, federatedLinkRequests.samlProviderId))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    const now = Date.now();
    // the same projection as the legacy response
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userEmail: r.userEmail,
      userDisplayName: r.userDisplayName,
      provider: r.oidcProviderName ?? r.samlProviderName ?? "(deleted provider)",
      protocol: r.oidcProviderId ? ("oidc" as const) : ("saml" as const),
      subject: r.subject,
      email: r.email,
      idpMfa: r.idpMfa,
      status: r.status,
      approvals: r.approvals.length,
      requiredApprovals: r.userIsAdmin ? 2 : 1,
      expired: r.status === "pending" && r.expiresAt.getTime() <= now,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      decidedAt: r.decidedAt,
      _cursorAt: r._cursorAt,
    }));
  },
  countable: (where) => db.select({ one: sql`1` }).from(federatedLinkRequests).innerJoin(users, eq(users.id, federatedLinkRequests.userId)).where(where),
  idOf: (r) => r.id,
});

const linkState = (r: LinkRequestRow) => (r.expired ? "expired" : r.status);

export const LINK_REQUESTS_LIST: ListSpec<LinkRequestRow> = {
  id: "link-requests",
  sorts: {
    account: { expr: sql`lower(${personSql(users.displayName, users.email)})` },
    provider: { expr: sql`lower(coalesce(${oidcProviders.name}, ${samlProviders.name}))` },
    email: { expr: sql`lower(${federatedLinkRequests.email})` },
    mfa: { expr: federatedLinkRequests.idpMfa },
    when: { expr: federatedLinkRequests.createdAt, keysetAt: federatedLinkRequests.createdAt },
    approvals: { expr: sql`jsonb_array_length(${federatedLinkRequests.approvals})` },
    status: { expr: sql`case when ${federatedLinkRequests.status} = 'pending' and ${federatedLinkRequests.expiresAt} <= now() then 'expired' else ${federatedLinkRequests.status} end` },
    expires: { expr: federatedLinkRequests.expiresAt, keysetAt: federatedLinkRequests.expiresAt },
  },
  columns: {
    account: { label: "Existing account", value: (r) => `${r.userDisplayName} ${r.userEmail}`.trim() },
    provider: { label: "Identity provider", value: (r) => `${r.provider} (${r.protocol.toUpperCase()})` },
    email: { label: "Asserted email", value: (r) => r.email },
    mfa: { label: "MFA", value: (r) => (r.idpMfa ? "asserted" : "not asserted") },
    when: { label: "Requested", value: (r) => r.createdAt },
    approvals: { label: "Approvals", value: (r) => `${r.approvals} of ${r.requiredApprovals}` },
    status: { label: "Status", value: linkState },
    expires: { label: "Expires", value: (r) => r.expiresAt },
  },
  filters: ["status"],
  defaultSort: { col: "when", dir: "desc" },
  idCol: federatedLinkRequests.id,
};

// ---- ChatOps identity links (/v1/chatops/identity-links) ----------------------

export interface ChatIdentityLinkRow {
  id: string;
  connectionId: string;
  connectionName: string | null;
  chatUserId: string;
  chatUserEmail: string;
  userId: string;
  emailVerifiedSource: "idp" | "scim" | "admin_asserted";
  createdAt: Date;
}

export const chatLinksFilterQuery = z
  .object({ verification: z.enum(["idp", "scim", "admin_asserted"]).optional(), connectionId: z.string().uuid().optional() })
  .strict();
export const chatLinksWhere = (f: z.infer<typeof chatLinksFilterQuery>) =>
  conj([
    f.verification ? eq(chatIdentityLinks.emailVerifiedSource, f.verification) : undefined,
    f.connectionId ? eq(chatIdentityLinks.connectionId, f.connectionId) : undefined,
  ]);

export const chatLinksReader = (db: Db): ListReader<ChatIdentityLinkRow> => ({
  fetch: (q) =>
    db
      .select({
        id: chatIdentityLinks.id,
        connectionId: chatIdentityLinks.connectionId,
        connectionName: chatopsConnections.name,
        chatUserId: chatIdentityLinks.chatUserId,
        chatUserEmail: chatIdentityLinks.chatUserEmail,
        userId: chatIdentityLinks.userId,
        emailVerifiedSource: chatIdentityLinks.emailVerifiedSource,
        createdAt: chatIdentityLinks.createdAt,
        _cursorAt: q.cursorAt,
      })
      .from(chatIdentityLinks)
      .leftJoin(chatopsConnections, eq(chatopsConnections.id, chatIdentityLinks.connectionId))
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset),
  countable: (where) => db.select({ one: sql`1` }).from(chatIdentityLinks).where(where),
  idOf: (r) => r.id,
});

export const CHAT_LINKS_LIST: ListSpec<ChatIdentityLinkRow> = {
  id: "chat-identity-links",
  sorts: {
    chatuser: { expr: chatIdentityLinks.chatUserId },
    email: { expr: sql`lower(${chatIdentityLinks.chatUserEmail})` },
    verified: { expr: chatIdentityLinks.emailVerifiedSource },
    workspace: { expr: sql`lower(${chatopsConnections.name})` },
    created: { expr: chatIdentityLinks.createdAt, keysetAt: chatIdentityLinks.createdAt },
  },
  columns: {
    chatuser: { label: "Chat identity", value: (r) => r.chatUserId },
    email: { label: "Bound to", value: (r) => r.chatUserEmail },
    verified: { label: "Email verification", value: (r) => r.emailVerifiedSource },
    workspace: { label: "Workspace", value: (r) => r.connectionName },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: ["verification", "connectionId"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: chatIdentityLinks.id,
};

// ---- the agent catalog (/v1/agents) ----------------------------------------------

type AgentDbRow = typeof agents.$inferSelect;
export type AgentListRow = AgentDbRow & Record<string, unknown>;

export const agentsFilterQuery = z
  .object({
    q: z.string().trim().max(200).optional(),
    /** one agent, for a `#agent-<id>` deep link */
    id: z.string().uuid().optional(),
    enabled: z.enum(["true", "false"]).optional(),
  })
  .strict();
export const agentsWhere = (f: z.infer<typeof agentsFilterQuery>) =>
  conj([
    f.q ? sql`(${agents.name} ilike ${likeLiteral(f.q)} or coalesce(${agents.model}, '') ilike ${likeLiteral(f.q)})` : undefined,
    f.id ? eq(agents.id, f.id) : undefined,
    f.enabled ? eq(agents.enabled, f.enabled === "true") : undefined,
  ]);

export const agentsReader = (db: Db): ListReader<AgentListRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({ agent: agents, _cursorAt: q.cursorAt })
      .from(agents)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    // ADR-0168: the stewardship view, computed per page at read time as the legacy list does
    const enriched = await withStewardship(db, rows.map((r) => r.agent));
    return enriched.map((a, i) => ({ ...a, _cursorAt: rows[i]!._cursorAt }) as AgentListRow & { _cursorAt: string | null });
  },
  countable: (where) => db.select({ one: sql`1` }).from(agents).where(where),
  idOf: (r) => r.id,
});

const usd = (n: number | null) => (n === null ? "—" : `$${n}`);
export const AGENTS_LIST: ListSpec<AgentListRow> = {
  id: "agents",
  sorts: {
    name: { expr: sql`lower(${agents.name})` },
    provider: { expr: agents.provider },
    tier: { expr: agents.tier },
    model: { expr: sql`lower(${agents.model})` },
    price: { expr: agents.costPerMTokIn },
    enabled: { expr: sql`(not ${agents.enabled})` },
    created: { expr: agents.createdAt, keysetAt: agents.createdAt },
  },
  // the system prompt is described by its length, as on screen, never exported as text
  columns: {
    name: { label: "Name", value: (x) => x.name },
    provider: { label: "Provider", value: (x) => x.provider },
    tier: { label: "Tier", value: (x) => x.tier },
    model: { label: "Model", value: (x) => x.model },
    price: {
      label: "$/MTok in → out",
      value: (x) => (x.costPerMTokIn === null && x.costPerMTokOut === null ? "unpriced" : `${usd(x.costPerMTokIn)} → ${usd(x.costPerMTokOut)}`),
    },
    prompt: { label: "System prompt", value: (x) => (x.systemPrompt ? `set (${x.systemPrompt.length} chars)` : null) },
    enabled: { label: "Status", value: (x) => (x.enabled ? "enabled" : "disabled") },
    created: { label: "Registered", value: (x) => x.createdAt },
    id: { label: "Agent id", value: (x) => x.id },
  },
  filters: ["q", "id", "enabled"],
  defaultSort: { col: "name", dir: "asc" },
  idCol: agents.id,
};

// ---- the licence verification trail (/v1/licenses/verifications) --------------

type VerificationRow = typeof licenseVerifications.$inferSelect;

export const verificationsFilterQuery = z.object({ ok: z.enum(["true", "false"]).optional() }).strict();
export const verificationsWhere = (f: z.infer<typeof verificationsFilterQuery>) => (f.ok ? eq(licenseVerifications.ok, f.ok === "true") : undefined);

export const verificationsReader = (db: Db): ListReader<VerificationRow> => ({
  fetch: async (q) => {
    const rows = await db
      .select({ v: licenseVerifications, _cursorAt: q.cursorAt })
      .from(licenseVerifications)
      .where(q.where)
      .orderBy(...q.orderBy)
      .limit(q.limit)
      .offset(q.offset);
    return rows.map((r) => ({ ...r.v, _cursorAt: r._cursorAt }));
  },
  countable: (where) => db.select({ one: sql`1` }).from(licenseVerifications).where(where),
  idOf: (r) => r.id,
});

export const VERIFICATIONS_LIST: ListSpec<VerificationRow> = {
  id: "licence-verifications",
  sorts: {
    at: { expr: licenseVerifications.at, keysetAt: licenseVerifications.at },
    trigger: { expr: licenseVerifications.trigger },
    ok: { expr: licenseVerifications.ok },
    state: { expr: licenseVerifications.state },
    rule: { expr: licenseVerifications.ruleId },
  },
  columns: {
    at: { label: "When", value: (c) => iso(c.at) },
    trigger: { label: "Trigger", value: (c) => c.trigger },
    ok: { label: "Status", value: (c) => (c.ok ? "ok" : "REFUSED") },
    state: { label: "State", value: (c) => c.state },
    rule: { label: "Rule", value: (c) => c.ruleId },
    reason: { label: "Reason", value: (c) => c.reason },
  },
  filters: ["ok"],
  defaultSort: { col: "at", dir: "desc" },
  idCol: licenseVerifications.id,
};


// ---- the two route bodies every list above uses ----------------------------------

type Reply = import("fastify").FastifyReply;
type Request = import("fastify").FastifyRequest;

/**
 * The list route under the contract: the filters through the list's own strict schema (the contract's own params
 * taken out), one page, the count. A ListQueryError or a ZodError answers 400.
 */
export async function answerListPage<Row, F>(
  db: Db,
  req: Request,
  reply: Reply,
  spec: ListSpec<Row>,
  reader: ListReader<Row>,
  filters: z.ZodType<F>,
  where: (f: F) => SQL | undefined,
  extra: Record<string, unknown> = {},
) {
  try {
    const q = req.query as Record<string, unknown>;
    const f = filters.parse(filterParams(q));
    const page = parseListPage(spec, q);
    return { ...(await runListPage(db, spec, reader, where(f), page)), ...extra };
  } catch (e) {
    return sendListError(reply, e);
  }
}

/** the list's Excel export, under the list route's own authorisation (the caller checked it first) */
export async function answerListExport<Row, F>(
  db: Db,
  req: Request,
  reply: Reply,
  spec: ListSpec<Row>,
  reader: ListReader<Row>,
  filters: z.ZodType<F>,
  where: (f: F) => SQL | undefined,
  summary: Record<string, unknown> = {},
) {
  try {
    const q = req.query as Record<string, unknown>;
    const f = filters.parse(filterParams(q));
    const ex = parseListExport(spec, q);
    await sendListExport(db, req, reply, spec, reader, where(f), ex, { ...(f as Record<string, unknown>), ...summary });
    return reply;
  } catch (e) {
    return sendListError(reply, e);
  }
}

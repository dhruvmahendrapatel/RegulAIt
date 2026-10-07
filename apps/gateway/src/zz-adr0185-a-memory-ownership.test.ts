/**
 * ADR-0185 I3 + I9 — memory retention that runs, owners for MCP servers and
 * connectors, and the memory-store inventory, on a real database through the
 * real app.
 *
 * Pinned (each red-proven by removing the rule; see the slice summary):
 *  I3
 *  - `semantic-cache-purge-sweep` deletes cache rows past the TTL, oldest
 *    first, bounded per pass, idempotent; a row whose agent a not-closed
 *    incident covers is kept; one summary audit row with no content;
 *  - `conversation-retention-sweep` deletes conversations past retention with
 *    their messages, one audit row each with no content; a conversation an
 *    open incident links, or whose agent it covers, is kept until it closes;
 *  - the hold is RE-CHECKED inside the DELETE (an incident opened between the
 *    select and the delete still holds the row);
 *  - read time: an expired, unheld conversation is 404 `conversation_expired`
 *    (GET and replay) and is not listed; a held one stays readable; a user's
 *    DELETE of a held conversation is 409 `incident_evidence_hold`, audited.
 *  I9
 *  - a server / connector registered by an admin is owned by that admin; by
 *    the bootstrap token, unowned; a named owner must exist and be active
 *    (422 `unknown_owner` / `owner_inactive`, nothing saved);
 *  - `PUT …/owner` (admin-only) changes it, audited with transitions; reads
 *    carry `ownerUserId` + `ownership` (owned / unowned / orphaned);
 *  - an alert about a server or connector is owned by its owner; an orphaned
 *    owner owns nothing and the SLA sweep escalates it as `orphaned`;
 *  - `GET /v1/inventory/memory-stores` reports counts, never content.
 *
 * WIRING: the I9 registration and PUT tests run through `POST/PATCH/GET
 * /v1/servers` (app.ts, agent C's block), `POST/GET /v1/connectors`
 * (agents-connectors.ts) and `registerOwnershipRoutes` in buildApp — the
 * one-line calls into ownership.ts listed in the batch-3 A hand-off.
 *
 * Global state (M-068): every row, incident, alert and user change this file
 * makes is removed or restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiIncidentLinks,
  aiIncidents,
  and,
  auditLog,
  connectors,
  conversationMessages,
  conversations,
  createDb,
  desc,
  eq,
  gte,
  governanceAlerts,
  inArray,
  mcpServers,
  runMigrations,
  semanticCache,
  sql,
  users as usersTable,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import {
  MEMORY_RETENTION_JOB_NAMES,
  MEMORY_RETENTION_RULE_IDS,
  runConversationRetentionSweep,
  runSemanticCachePurgeSweep,
} from "./memory-retention.js";
import { loadOwnConversationForReplay } from "./conversations.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";
import { OWNERSHIP_RULE_IDS } from "./ownership.js";
import { deriveAlertOwner, runAlertSlaSweep, ALERT_OWNERSHIP_RULE_IDS } from "./alert-ownership.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b3a-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** a marker no response or audit row may ever carry (counts only, no content) */
const CONTENT = `SECRET-CONTENT-${RUN}`;
const startedAt = new Date();

let db: Db;
let app: ReturnType<typeof buildApp>;
type Who = "admin" | "member" | "leaver";
const users = {} as Record<Who, { id: string; auth: { authorization: string } }>;
const created = {
  incidents: [] as string[],
  conversations: [] as string[],
  cacheAgents: [] as string[],
  servers: [] as string[],
  connectors: [] as string[],
  alerts: [] as string[],
};

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkIncident(): Promise<string> {
  const [row] = await db
    .insert(aiIncidents)
    .values({ title: `b3a incident ${RUN}`, severity: "high", detectionSource: "manual", awareAt: new Date() })
    .returning({ id: aiIncidents.id });
  created.incidents.push(row!.id);
  return row!.id;
}
async function link(incidentId: string, objectType: "agent" | "conversation", objectId: string) {
  await db.insert(aiIncidentLinks).values({ incidentId, objectType, objectId });
}
async function closeIncident(id: string) {
  await db.execute(sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(), root_cause = 'fixture',
    lessons_learned = 'fixture' WHERE id = ${id} AND status <> 'closed'`);
}

async function mkCache(agentId: string, createdAt: Date, tag: string) {
  const [row] = await db
    .insert(semanticCache)
    .values({
      userId: users.member.id,
      agentId,
      promptHash: `b3a-${RUN}-${tag}`,
      normalizedInput: `${CONTENT} prompt ${tag}`,
      outputText: `${CONTENT} answer ${tag}`,
      createdAt,
    })
    .returning({ id: semanticCache.id });
  if (!created.cacheAgents.includes(agentId)) created.cacheAgents.push(agentId);
  return row!.id;
}
const cacheExists = async (id: string) => (await db.select({ id: semanticCache.id }).from(semanticCache).where(eq(semanticCache.id, id))).length === 1;

async function mkConversation(lastActivity: Date, agentId: string = randomUUID(), userId = users.member.id) {
  const [row] = await db
    .insert(conversations)
    .values({ userId, agentId, title: `${CONTENT} title`, createdAt: lastActivity, updatedAt: lastActivity })
    .returning();
  await db.insert(conversationMessages).values([
    { conversationId: row!.id, role: "user", content: `${CONTENT} question`, createdAt: lastActivity },
    { conversationId: row!.id, role: "assistant", content: `${CONTENT} answer`, createdAt: new Date(lastActivity.getTime() + 1) },
  ]);
  created.conversations.push(row!.id);
  return row!;
}
const convExists = async (id: string) => (await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id))).length === 1;

async function auditsSince(ruleId: string, objectId?: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), gte(auditLog.at, startedAt), ...(objectId ? [eq(auditLog.objectId, objectId)] : [])))
    .orderBy(desc(auditLog.seq));
}

let restoreMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false], ["leaver", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `b3a-${k}-${RUN}@example.com`, displayName: `b3a ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b3a" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  for (const id of created.incidents) await closeIncident(id);
  if (created.incidents.length) await db.delete(aiIncidents).where(inArray(aiIncidents.id, created.incidents));
  if (created.conversations.length) await db.delete(conversations).where(inArray(conversations.id, created.conversations));
  if (created.cacheAgents.length) await db.delete(semanticCache).where(inArray(semanticCache.agentId, created.cacheAgents));
  if (created.alerts.length) await db.delete(governanceAlerts).where(inArray(governanceAlerts.id, created.alerts));
  if (created.servers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, created.servers));
  if (created.connectors.length) await db.delete(connectors).where(inArray(connectors.id, created.connectors));
  await restoreMfa?.();
  app.server.closeAllConnections();
  await app.close();
});

// ===========================================================================
// I3 — the semantic cache
// ===========================================================================

describe("I3 semantic-cache-purge-sweep", () => {
  it("is registered hourly, and the conversation sweep daily", () => {
    const reg = schedulerJobRegistry();
    expect(SCHEDULER_JOB_NAMES.semanticCachePurgeSweep).toBe(MEMORY_RETENTION_JOB_NAMES.semanticCachePurge);
    expect(reg.get(MEMORY_RETENTION_JOB_NAMES.semanticCachePurge)?.defaultIntervalSeconds).toBe(3600);
    expect(reg.get(MEMORY_RETENTION_JOB_NAMES.conversationRetention)?.defaultIntervalSeconds).toBe(86_400);
  });

  it("deletes rows past the TTL oldest first, bounded per pass; keeps fresh and held rows; idempotent; audits counts only", async () => {
    const agent = randomUUID();
    const heldAgent = randomUUID();
    // far in the past, so these are the oldest expired rows in any database
    const oldest = await mkCache(agent, new Date("2001-01-01T00:00:00Z"), "oldest");
    const older = await mkCache(agent, new Date("2001-01-02T00:00:00Z"), "older");
    const expired = await mkCache(agent, new Date(Date.now() - 2 * HOUR), "expired");
    const fresh = await mkCache(agent, new Date(), "fresh");
    const held = await mkCache(heldAgent, new Date("2000-12-31T00:00:00Z"), "held");
    const inc = await mkIncident();
    await link(inc, "agent", heldAgent);

    // bounded: one row per batch, one batch — the OLDEST unheld row goes first
    const first = await runSemanticCachePurgeSweep(db, new Date(), null, { batch: 1, maxBatches: 1 });
    expect(first).toMatchObject({ purged: 1, ttlSeconds: 3600, more: true });
    expect(await cacheExists(oldest)).toBe(false);
    expect(await cacheExists(older)).toBe(true);
    expect(await cacheExists(held)).toBe(true);

    const rest = await runSemanticCachePurgeSweep(db, new Date());
    expect(rest.purged).toBeGreaterThanOrEqual(2);
    expect(rest.held).toBeGreaterThanOrEqual(1);
    expect(await cacheExists(older)).toBe(false);
    expect(await cacheExists(expired)).toBe(false);
    expect(await cacheExists(fresh)).toBe(true);
    expect(await cacheExists(held), "an open incident covering the agent holds its cache rows").toBe(true);

    // idempotent: nothing left to do
    expect((await runSemanticCachePurgeSweep(db, new Date())).purged).toBe(0);

    // one summary row per pass that deleted, with counts and times only
    const rows = await auditsSince(MEMORY_RETENTION_RULE_IDS.semanticCachePurged);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(CONTENT);
    expect(rows[0]!.detail).toMatchObject({ ttlSeconds: 3600, job: "semantic-cache-purge-sweep" });

    // the hold ends when the incident closes
    await closeIncident(inc);
    await runSemanticCachePurgeSweep(db, new Date());
    expect(await cacheExists(held)).toBe(false);
  });

  it("re-checks the hold INSIDE the DELETE: an incident opened after the select still holds the row", async () => {
    const agent = randomUUID();
    const row = await mkCache(agent, new Date("2000-06-01T00:00:00Z"), "race");
    const out = await runSemanticCachePurgeSweep(db, new Date(), null, {
      onBatchSelected: async (ids) => {
        if (!ids.includes(row)) return;
        const inc = await mkIncident();
        await link(inc, "agent", agent);
      },
    });
    expect(await cacheExists(row), "deleted although an incident now covers its agent").toBe(true);
    expect(out.held).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// I3 — conversations
// ===========================================================================

describe("I3 conversation retention", () => {
  it("read time: an expired, unheld conversation is 404 conversation_expired, unlisted, and not continued", async () => {
    const old = await mkConversation(new Date(Date.now() - 31 * DAY));
    const live = await mkConversation(new Date(Date.now() - 29 * DAY));
    const get = await inject("GET", `/v1/conversations/${old.id}`, users.member.auth);
    expect(get.statusCode, get.body).toBe(404);
    expect(get.json().error).toBe("conversation_expired");
    expect(get.body).not.toContain(CONTENT);
    const ok = await inject("GET", `/v1/conversations/${live.id}`, users.member.auth);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().retention).toMatchObject({ expired: false, heldByIncident: false, retentionDays: 30 });
    const list = (await inject("GET", "/v1/conversations", users.member.auth)).json().conversations as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toContain(live.id);
    expect(list.map((c) => c.id)).not.toContain(old.id);
    const replay = await loadOwnConversationForReplay(db, old.id, users.member.id);
    expect(replay).toMatchObject({ ok: false, status: 404, error: "conversation_expired" });
  });

  it("a held conversation stays readable, cannot be deleted (409, audited) or continued, and survives the sweep", async () => {
    const byLink = await mkConversation(new Date(Date.now() - 40 * DAY));
    const byAgent = await mkConversation(new Date(Date.now() - 40 * DAY));
    const freshHeld = await mkConversation(new Date());
    const inc = await mkIncident();
    await link(inc, "conversation", byLink.id);
    await link(inc, "agent", byAgent.agentId);
    await link(inc, "conversation", freshHeld.id);

    const get = await inject("GET", `/v1/conversations/${byLink.id}`, users.member.auth);
    expect(get.statusCode, get.body).toBe(200);
    expect(get.json().retention).toMatchObject({ expired: true, heldByIncident: true });
    for (const c of [byLink, byAgent, freshHeld]) {
      const del = await inject("DELETE", `/v1/conversations/${c.id}`, users.member.auth);
      expect(del.statusCode, del.body).toBe(409);
      expect(del.json().error).toBe("incident_evidence_hold");
      expect(await convExists(c.id)).toBe(true);
    }
    expect((await auditsSince(MEMORY_RETENTION_RULE_IDS.conversationDeleteHeld, byLink.id)).length).toBe(1);
    expect(await loadOwnConversationForReplay(db, byAgent.id, users.member.id)).toMatchObject({ ok: false, status: 409, error: "incident_evidence_hold" });

    const swept = await runConversationRetentionSweep(db, new Date());
    expect(swept.heldIds).toEqual(expect.arrayContaining([byLink.id, byAgent.id]));
    expect(await convExists(byLink.id)).toBe(true);
    expect(await convExists(byAgent.id)).toBe(true);

    // the hold ends when the incident closes; then the sweep deletes, one audit row each, no content
    await closeIncident(inc);
    await runConversationRetentionSweep(db, new Date());
    expect(await convExists(byLink.id)).toBe(false);
    expect(await convExists(byAgent.id)).toBe(false);
    expect(await convExists(freshHeld.id)).toBe(true);
    expect((await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, byLink.id))).length).toBe(0);
    const [purged] = await auditsSince(MEMORY_RETENTION_RULE_IDS.conversationPurged, byLink.id);
    expect(purged).toBeDefined();
    expect(purged!.detail).toMatchObject({ ownerUserId: users.member.id, messages: 2, retentionDays: 30 });
    expect(JSON.stringify(purged)).not.toContain(CONTENT);
    // an unheld conversation is deleted by its owner as before
    const del = await inject("DELETE", `/v1/conversations/${freshHeld.id}`, users.member.auth);
    expect(del.statusCode, del.body).toBe(200);
  });

  it("the sweep is oldest first, bounded, idempotent, and re-checks the hold inside the DELETE", async () => {
    const a = await mkConversation(new Date("2001-01-01T00:00:00Z"));
    const b = await mkConversation(new Date("2001-01-02T00:00:00Z"));
    const first = await runConversationRetentionSweep(db, new Date(), null, { batch: 1, maxBatches: 1 });
    expect(first).toMatchObject({ purged: 1, more: true });
    expect(await convExists(a.id)).toBe(false);
    expect(await convExists(b.id)).toBe(true);

    const raced = await runConversationRetentionSweep(db, new Date(), null, {
      onBatchSelected: async (ids) => {
        if (!ids.includes(b.id)) return;
        const inc = await mkIncident();
        await link(inc, "conversation", b.id);
      },
    });
    expect(await convExists(b.id), "deleted although an incident now links it").toBe(true);
    expect(raced.heldIds).toContain(b.id);
    const again = await runConversationRetentionSweep(db, new Date());
    expect(again.heldIds).toContain(b.id);
    expect(await convExists(b.id)).toBe(true);
  });
});

// ===========================================================================
// I9 — owners
// ===========================================================================

describe("I9 owners for MCP servers and connectors", () => {
  it("registration: the admin owns what they register; the bootstrap token registers it unowned; bad owners are 422", async () => {
    const mine = await inject("POST", "/v1/servers", users.admin.auth, { name: `b3a-srv-${RUN}`, url: "http://127.0.0.1:9", allowPrivateRanges: true });
    expect(mine.statusCode, mine.body).toBe(201);
    created.servers.push(mine.json().id);
    expect(mine.json().ownerUserId).toBe(users.admin.id);
    const boot = await inject("POST", "/v1/servers", AUTH, { name: `b3a-srv-boot-${RUN}`, url: "http://127.0.0.1:9", allowPrivateRanges: true });
    expect(boot.statusCode, boot.body).toBe(201);
    created.servers.push(boot.json().id);
    expect(boot.json().ownerUserId).toBeNull();
    const named = await inject("POST", "/v1/servers", AUTH, { name: `b3a-srv-named-${RUN}`, url: "http://127.0.0.1:9", allowPrivateRanges: true, ownerUserId: users.member.id });
    expect(named.statusCode, named.body).toBe(201);
    created.servers.push(named.json().id);
    expect(named.json().ownerUserId).toBe(users.member.id);

    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, users.leaver.id));
    try {
      for (const [ownerUserId, error] of [[users.leaver.id, "owner_inactive"], [randomUUID(), "unknown_owner"]] as const) {
        const r = await inject("POST", "/v1/servers", users.admin.auth, { name: `b3a-srv-bad-${RUN}`, url: "http://127.0.0.1:9", allowPrivateRanges: true, ownerUserId });
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json().error).toBe(error);
        const c = await inject("POST", "/v1/connectors", users.admin.auth, { name: `b3a-conn-bad-${RUN}`, kind: "crm", ownerUserId });
        expect(c.statusCode, c.body).toBe(422);
        expect(c.json().error).toBe(error);
      }
      expect((await db.select().from(mcpServers).where(eq(mcpServers.name, `b3a-srv-bad-${RUN}`))).length).toBe(0);
      expect((await db.select().from(connectors).where(eq(connectors.name, `b3a-conn-bad-${RUN}`))).length).toBe(0);
    } finally {
      await db.update(usersTable).set({ disabledAt: null }).where(eq(usersTable.id, users.leaver.id));
    }

    const conn = await inject("POST", "/v1/connectors", users.admin.auth, { name: `b3a-conn-${RUN}`, kind: "crm" });
    expect(conn.statusCode, conn.body).toBe(201);
    created.connectors.push(conn.json().id);
    expect(conn.json().ownerUserId).toBe(users.admin.id);
    const bootConn = await inject("POST", "/v1/connectors", AUTH, { name: `b3a-conn-boot-${RUN}`, kind: "crm" });
    expect(bootConn.statusCode, bootConn.body).toBe(201);
    created.connectors.push(bootConn.json().id);
    expect(bootConn.json().ownerUserId).toBeNull();

    const servers = (await inject("GET", "/v1/servers", AUTH)).json().servers as Array<{ id: string; ownerUserId: string | null; ownership: string }>;
    expect(servers.find((s) => s.id === mine.json().id)).toMatchObject({ ownerUserId: users.admin.id, ownership: "owned" });
    expect(servers.find((s) => s.id === boot.json().id)).toMatchObject({ ownerUserId: null, ownership: "unowned" });
    const conns = (await inject("GET", "/v1/connectors", AUTH)).json().connectors as Array<{ id: string; ownership: string }>;
    expect(conns.find((c) => c.id === conn.json().id)?.ownership).toBe("owned");
    expect(conns.find((c) => c.id === bootConn.json().id)?.ownership).toBe("unowned");
  });

  it("PUT …/owner (admin-only) changes the owner, audited with transitions; refusals are 422 and audited; orphaned reads as such", async () => {
    const serverId = created.servers[1]!; // the unowned one
    const connectorId = created.connectors[1]!;
    const denied = await inject("PUT", `/v1/servers/${serverId}/owner`, users.member.auth, { ownerUserId: users.member.id });
    expect(denied.statusCode).toBe(403);

    for (const [kind, url, id] of [
      ["mcp_server", `/v1/servers/${serverId}/owner`, serverId],
      ["connector", `/v1/connectors/${connectorId}/owner`, connectorId],
    ] as const) {
      const set = await inject("PUT", url, users.admin.auth, { ownerUserId: users.leaver.id });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toEqual({ id, ownerUserId: users.leaver.id, ownership: "owned" });
      const [row] = await auditsSince(OWNERSHIP_RULE_IDS.changed[kind], id);
      expect(row!.detail).toMatchObject({
        transitions: { ownerUserId: { from: null, to: users.leaver.id }, ownership: { from: "unowned", to: "owned" } },
      });
      expect(row!.userId).toBe(users.admin.id);
      const bad = await inject("PUT", url, users.admin.auth, { ownerUserId: randomUUID() });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toBe("unknown_owner");
      expect((await auditsSince(OWNERSHIP_RULE_IDS.refused[kind], id)).length).toBe(1);
    }
    expect((await inject("PUT", `/v1/servers/${randomUUID()}/owner`, users.admin.auth, { ownerUserId: null })).statusCode).toBe(404);
    expect((await inject("PUT", `/v1/servers/${serverId}/owner`, users.admin.auth, { owner: null })).statusCode).toBe(400);

    // the owner leaves: orphaned on read, and a new owner cannot be a deactivated account
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, users.leaver.id));
    try {
      const servers = (await inject("GET", "/v1/servers", AUTH)).json().servers as Array<{ id: string; ownership: string }>;
      expect(servers.find((s) => s.id === serverId)?.ownership).toBe("orphaned");
      const inactive = await inject("PUT", `/v1/connectors/${connectorId}/owner`, users.admin.auth, { ownerUserId: users.leaver.id });
      expect(inactive.statusCode).toBe(422);
      expect(inactive.json().error).toBe("owner_inactive");

      // ALERTS: a server's alert is its owner's; an orphaned owner owns nothing and is escalated as such
      const [alert] = await db
        .insert(governanceAlerts)
        .values({ ruleId: "spend_spike", subjectKey: `mcp_server:${serverId}`, severity: "low", title: `b3a orphan ${RUN}` })
        .returning();
      created.alerts.push(alert!.id);
      expect(await deriveAlertOwner(db, `mcp_server:${serverId}`, {})).toBeNull();
      await runAlertSlaSweep(db, new Date());
      const [esc] = await auditsSince(ALERT_OWNERSHIP_RULE_IDS.escalated, alert!.id);
      expect(esc!.detail).toMatchObject({ reason: "orphaned" });
    } finally {
      await db.update(usersTable).set({ disabledAt: null }).where(eq(usersTable.id, users.leaver.id));
    }
    expect(await deriveAlertOwner(db, `mcp_server:${serverId}`, {})).toMatchObject({ ownerUserId: users.leaver.id, from: { kind: "mcp_server" } });
    expect(await deriveAlertOwner(db, `connector:${created.connectors[0]}`, {})).toMatchObject({ ownerUserId: users.admin.id, from: { kind: "connector" } });

    // back to unowned, by PATCH too
    const cleared = await inject("PATCH", `/v1/servers/${serverId}`, users.admin.auth, { ownerUserId: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().ownerUserId).toBeNull();
    const [row] = await auditsSince(OWNERSHIP_RULE_IDS.changed.mcp_server, serverId);
    expect(row!.detail).toMatchObject({ transitions: { ownerUserId: { from: users.leaver.id, to: null } } });
  });
});

// ===========================================================================
// I9 — the memory-store inventory
// ===========================================================================

describe("I9 GET /v1/inventory/memory-stores", () => {
  it("reports every store with counts, retention and who enforces it — never content; admin-only", async () => {
    const agent = randomUUID();
    await mkCache(agent, new Date(), "inventory");
    const expiredHeld = await mkCache(agent, new Date("2000-01-01T00:00:00Z"), "inventory-held");
    const inc = await mkIncident();
    await link(inc, "agent", agent);
    expect((await inject("GET", "/v1/inventory/memory-stores", users.member.auth)).statusCode).toBe(403);
    const res = await inject("GET", "/v1/inventory/memory-stores", users.admin.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(CONTENT);
    const stores = res.json().stores as Array<Record<string, unknown> & { kind: string; rows: number; held: number | null; retention: Record<string, unknown> }>;
    expect(stores.map((s) => s.kind)).toEqual(["semantic_cache", "conversations", "builder_agent_memory", "project_context_items"]);
    const cache = stores[0]!;
    expect(cache.rows).toBeGreaterThanOrEqual(2);
    expect(cache.held).toBeGreaterThanOrEqual(1);
    expect(cache.oldestAt).toBe("2000-01-01T00:00:00.000Z");
    expect(cache).toMatchObject({
      isolation: "per user+agent",
      owner: { kind: "org" },
      retention: { setting: "semanticCacheTtlSeconds", value: 3600, enforcedBy: "semantic-cache-purge-sweep" },
    });
    expect(stores[1]!.retention).toMatchObject({ setting: "conversationRetentionDays", value: 30, enforcedBy: "conversation-retention-sweep" });
    for (const s of stores.slice(2)) {
      expect(s.retention).toEqual({ setting: null, value: null, enforcedBy: null, lastRunAt: null });
      expect(s.held).toBeNull();
    }
    expect(await cacheExists(expiredHeld)).toBe(true);
  });
});

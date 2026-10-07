/**
 * ADR-0185 (batch 3) — the FOUNDATION, pinned on a real database through the
 * real app:
 *  - SECURE BY DEFAULT: a freshly migrated org reads the four batch-3 settings
 *    strict (the column defaults and the stored row); each relaxation through
 *    PUT /v1/org/settings is audited with `detail.transitions` and named under
 *    `detail.relaxed`; a stricter change is audited but is not "relaxed"; out
 *    of range is a 400 and the database holds the same bounds.
 *  - MIGRATION 0169's rules: the MCP transport shape (the `stdio:<name>`
 *    sentinel), the owner foreign keys (SET NULL), the Outlook allow-list
 *    CHECKs, the `conversation` incident link and the two sweep indexes.
 *  - THE SEAMS keep today's behaviour: today's server bodies work, SSE/stdio
 *    registration is refused (fail closed), a transport never changes, and the
 *    destination check refuses a stdio row's sentinel URL.
 *  - A conversation link names a real conversation the caller may see.
 *
 * Global state (M-068): every setting relaxed here is restored to strict in a
 * `finally`/`afterAll`, and every row created is removed before the file ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiIncidentLinks,
  aiIncidents,
  and,
  auditLog,
  chatopsConnections,
  connectors,
  conversations,
  createDb,
  desc,
  eq,
  inArray,
  mcpServers,
  runMigrations,
  sql,
  users as usersTable,
  type Db,
} from "@regulait/db";
import { BATCH3_STRICT_DEFAULTS } from "@regulait/shared";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { checkUpstreamDestination, McpEgressBlockedError } from "./mcp-egress.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a185-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;
const created = {
  servers: [] as string[],
  connectors: [] as string[],
  chatops: [] as string[],
  conversations: [] as string[],
  incidents: [] as string[],
  users: [] as string[],
};

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const COLUMN: Record<keyof typeof BATCH3_STRICT_DEFAULTS, string> = {
  semanticCacheTtlSeconds: "semantic_cache_ttl_seconds",
  conversationRetentionDays: "conversation_retention_days",
  mcpProtocolMethods: "mcp_protocol_methods",
  mcpUpstreamTransports: "mcp_upstream_transports",
};

/** one relaxed value per setting (each within its bounds) */
const RELAXED: { [K in keyof typeof BATCH3_STRICT_DEFAULTS]: unknown } = {
  semanticCacheTtlSeconds: 2_592_000,
  conversationRetentionDays: 2555,
  mcpProtocolMethods: ["resources/list", "prompts/get"],
  mcpUpstreamTransports: ["streamable_http", "sse", "stdio"],
};

const STRICT_SQL = sql`UPDATE org_settings SET semantic_cache_ttl_seconds = 3600, conversation_retention_days = 30,
  mcp_protocol_methods = '[]'::jsonb, mcp_upstream_transports = '["streamable_http"]'::jsonb`;

function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, "the statement was refused").not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}

async function lastSettingsAudit() {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, users.admin.id)))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row!;
}

async function mkConversation(userId: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ userId, agentId: randomUUID(), title: `a185 ${RUN}` })
    .returning({ id: conversations.id });
  created.conversations.push(row!.id);
  return row!.id;
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // this suite drives users through API keys and is not about MFA (M-068: restored below)
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a185-${k}-${RUN}@example.com`,
      displayName: `a185 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a185" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await db.execute(STRICT_SQL);
  await restoreAdminKeyMfa?.();
  for (const id of created.incidents) {
    await db.execute(sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(),
      root_cause = COALESCE(root_cause, 'fixture cleanup'), lessons_learned = COALESCE(lessons_learned, 'fixture cleanup')
      WHERE id = ${id} AND status <> 'closed'`);
    await db.delete(aiIncidents).where(eq(aiIncidents.id, id));
  }
  if (created.conversations.length) await db.delete(conversations).where(inArray(conversations.id, created.conversations));
  if (created.chatops.length) await db.delete(chatopsConnections).where(inArray(chatopsConnections.id, created.chatops));
  if (created.connectors.length) await db.delete(connectors).where(inArray(connectors.id, created.connectors));
  if (created.servers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, created.servers));
  if (created.users.length) await db.delete(usersTable).where(inArray(usersTable.id, created.users));
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0185 secure by default: the batch-3 org settings", () => {
  it("a freshly migrated org reads every batch-3 setting strict — the column defaults and the stored row", async () => {
    const res = await db.execute(sql`
      select column_name, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings'`);
    const defaults = new Map(
      (res as unknown as { rows: Array<{ column_name: string; column_default: string | null }> }).rows.map((r) => [
        r.column_name,
        r.column_default ?? "",
      ]),
    );
    const g = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(g.statusCode, g.body).toBe(200);
    const settings = g.json().settings as Record<string, unknown>;
    for (const [key, strict] of Object.entries(BATCH3_STRICT_DEFAULTS)) {
      expect(settings[key], key).toEqual(strict);
      const def = defaults.get(COLUMN[key as keyof typeof COLUMN]);
      expect(def, key).toBeDefined();
      if (typeof strict === "number") expect(def, key).toBe(String(strict));
      else expect(JSON.parse(def!.replace(/^'/, "").replace(/'::jsonb$/, "")), key).toEqual(strict);
    }
  });

  it("each relaxation round-trips, is audited with detail.transitions and named as relaxed; strict comes back", async () => {
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const put = await inject("PUT", "/v1/org/settings", users.admin.auth, { [key]: value });
        expect(put.statusCode, `${key}: ${put.body}`).toBe(200);
        expect(put.json().settings[key], key).toEqual(value);
        const read = await inject("GET", "/v1/org/settings", users.admin.auth);
        expect(read.json().settings[key], `${key} read back`).toEqual(value);
        const row = await lastSettingsAudit();
        const detail = row.detail as { transitions: Record<string, { from: unknown; to: unknown }>; relaxed?: string[] };
        expect(detail.transitions[key], key).toEqual({
          from: BATCH3_STRICT_DEFAULTS[key as keyof typeof BATCH3_STRICT_DEFAULTS],
          to: value,
        });
        expect(detail.relaxed, key).toEqual([key]);
        expect(row.reason, key).toContain("RELAXED from the strict default");
      }
    } finally {
      const back = await inject("PUT", "/v1/org/settings", users.admin.auth, { ...BATCH3_STRICT_DEFAULTS });
      expect(back.statusCode, back.body).toBe(200);
    }
    const detail = (await lastSettingsAudit()).detail as { transitions: Record<string, unknown>; relaxed?: string[] };
    expect(Object.keys(detail.transitions).sort()).toEqual(Object.keys(BATCH3_STRICT_DEFAULTS).sort());
    expect(detail.relaxed).toBeUndefined();
  });

  it("a stricter value is audited as a transition but not as a relaxation; a set is stored in one order", async () => {
    try {
      const put = await inject("PUT", "/v1/org/settings", users.admin.auth, {
        conversationRetentionDays: 7,
        semanticCacheTtlSeconds: 60,
      });
      expect(put.statusCode, put.body).toBe(200);
      const row = await lastSettingsAudit();
      const detail = row.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
      expect(detail.transitions).toEqual({
        conversationRetentionDays: { from: 30, to: 7 },
        semanticCacheTtlSeconds: { from: 3600, to: 60 },
      });
      expect(detail.relaxed).toBeUndefined();
      expect(row.reason).not.toContain("RELAXED");
      // the same set in another order is one stored form
      const t = await inject("PUT", "/v1/org/settings", users.admin.auth, { mcpUpstreamTransports: ["sse", "streamable_http"] });
      expect(t.json().settings.mcpUpstreamTransports).toEqual(["streamable_http", "sse"]);
      expect((await lastSettingsAudit()).detail).toMatchObject({ relaxed: ["mcpUpstreamTransports"] });
    } finally {
      await inject("PUT", "/v1/org/settings", users.admin.auth, { ...BATCH3_STRICT_DEFAULTS });
    }
  });

  it("refuses a value outside its bounds (400) and saves nothing; the database holds the same bounds", async () => {
    const before = (await inject("GET", "/v1/org/settings", users.admin.auth)).json().settings;
    for (const body of [
      { semanticCacheTtlSeconds: 0 },
      { semanticCacheTtlSeconds: 2_592_001 },
      { conversationRetentionDays: 0 },
      { conversationRetentionDays: 2556 },
      { conversationRetentionDays: "30" },
      { mcpProtocolMethods: ["resources/subscribe"] },
      { mcpProtocolMethods: ["prompts/list", "prompts/list"] },
      { mcpProtocolMethods: "prompts/list" },
      { mcpUpstreamTransports: ["websocket"] },
      { mcpUpstreamTransports: ["sse", "sse"] },
    ]) {
      const r = await inject("PUT", "/v1/org/settings", users.admin.auth, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const after = (await inject("GET", "/v1/org/settings", users.admin.auth)).json().settings;
    for (const k of Object.keys(BATCH3_STRICT_DEFAULTS)) expect(after[k], k).toEqual(before[k]);
    await expectRefused(db.execute(sql`UPDATE org_settings SET conversation_retention_days = 2556`), /org_settings_conversation_retention_days_check/);
    await expectRefused(db.execute(sql`UPDATE org_settings SET semantic_cache_ttl_seconds = 0`), /org_settings_semantic_cache_ttl_seconds_check/);
    await expectRefused(
      db.execute(sql`UPDATE org_settings SET mcp_protocol_methods = '["sampling/createMessage"]'::jsonb`),
      /org_settings_mcp_protocol_methods_check/,
    );
    await expectRefused(
      db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '"stdio"'::jsonb`),
      /org_settings_mcp_upstream_transports_check/,
    );
  });

  it("a member can neither write nor read the settings", async () => {
    expect((await inject("PUT", "/v1/org/settings", users.member.auth, { conversationRetentionDays: 90 })).statusCode).toBe(403);
    expect((await inject("GET", "/v1/org/settings", users.member.auth)).statusCode).toBe(403);
  });
});

describe("ADR-0185 migration 0169: the rules the database holds", () => {
  it("mcp_servers: the transport shape — a stdio row carries the sentinel url, a command, an argv and a digest", async () => {
    const name = `a185-stdio-${RUN}`;
    const [ok] = await db
      .insert(mcpServers)
      .values({
        name,
        url: `stdio:${name}`,
        transport: "stdio",
        stdioCommand: "/opt/mcp/bin/fs",
        stdioArgs: ["--root", "/srv/data"],
        stdioCommandDigest: "0".repeat(64),
      })
      .returning();
    created.servers.push(ok!.id);
    const shape = /mcp_servers_transport_shape/;
    // a stdio row whose url is a real destination
    await expectRefused(
      db.insert(mcpServers).values({
        name: `a185-s2-${RUN}`,
        url: "https://mcp.example.com/mcp",
        transport: "stdio",
        stdioCommand: "/opt/x",
        stdioArgs: [],
        stdioCommandDigest: "0".repeat(64),
      }),
      shape,
    );
    // a stdio row without its pinned digest, or with a shell line for argv
    await expectRefused(
      db.insert(mcpServers).values({ name: `a185-s3-${RUN}`, url: `stdio:a185-s3-${RUN}`, transport: "stdio", stdioCommand: "/opt/x", stdioArgs: [] }),
      shape,
    );
    await expectRefused(
      db.execute(sql`INSERT INTO mcp_servers (name, url, transport, stdio_command, stdio_args, stdio_command_digest)
        VALUES (${`a185-s4-${RUN}`}, ${`stdio:a185-s4-${RUN}`}, 'stdio', '/opt/x', '"--root /srv"'::jsonb, 'd')`),
      shape,
    );
    // a URL row carrying stdio columns, or pretending to be a stdio sentinel
    await expectRefused(
      db.insert(mcpServers).values({ name: `a185-h1-${RUN}`, url: "https://mcp.example.com/mcp", stdioCommand: "/opt/x" }),
      shape,
    );
    await expectRefused(db.insert(mcpServers).values({ name: `a185-h2-${RUN}`, url: `stdio:a185-h2-${RUN}` }), shape);
    await expectRefused(
      db.execute(sql`INSERT INTO mcp_servers (name, url, transport) VALUES (${`a185-h3-${RUN}`}, 'https://x.example.com/', 'websocket')`),
      /mcp_servers_transport_check/,
    );
    // renaming a stdio server without its url breaks the shape
    await expectRefused(db.update(mcpServers).set({ name: `${name}-renamed` }).where(eq(mcpServers.id, ok!.id)), shape);
  });

  it("the destination seam fails closed on a stdio row: its sentinel url is refused, audited, never connected", async () => {
    const name = `a185-stdio-dest-${RUN}`;
    const [row] = await db
      .insert(mcpServers)
      .values({ name, url: `stdio:${name}`, transport: "stdio", stdioCommand: "/opt/x", stdioArgs: [], stdioCommandDigest: "d" })
      .returning();
    created.servers.push(row!.id);
    const err = await checkUpstreamDestination(db, row!).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpEgressBlockedError);
    const [denied] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, row!.id), eq(auditLog.effect, "deny")))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(denied, "the refusal is audited").toBeDefined();
  });

  it("owners: ON DELETE SET NULL on servers and connectors; a deleted owner never deletes the row", async () => {
    const [owner] = await db
      .insert(usersTable)
      .values({ email: `a185-owner-${RUN}@example.com`, displayName: `a185 owner ${RUN}` })
      .returning({ id: usersTable.id });
    created.users.push(owner!.id);
    const [srv] = await db
      .insert(mcpServers)
      .values({ name: `a185-owned-${RUN}`, url: "https://mcp.example.com/owned", ownerUserId: owner!.id })
      .returning();
    created.servers.push(srv!.id);
    const [con] = await db
      .insert(connectors)
      .values({ name: `a185-owned-${RUN}`, kind: "crm", ownerUserId: owner!.id })
      .returning();
    created.connectors.push(con!.id);
    expect(srv!.transport).toBe("streamable_http");
    await db.delete(usersTable).where(eq(usersTable.id, owner!.id));
    created.users = created.users.filter((u) => u !== owner!.id);
    const [s2] = await db.select().from(mcpServers).where(eq(mcpServers.id, srv!.id));
    const [c2] = await db.select().from(connectors).where(eq(connectors.id, con!.id));
    expect(s2?.ownerUserId).toBeNull();
    expect(c2?.ownerUserId).toBeNull();
  });

  it("chatops: the Outlook allow-list is exact lower-cased strings, at most 50, outlook only", async () => {
    const [con] = await db.insert(connectors).values({ name: `a185-chat-${RUN}`, kind: "chat" }).returning();
    created.connectors.push(con!.id);
    const [outlook] = await db
      .insert(chatopsConnections)
      .values({ name: `a185-outlook-${RUN}`, provider: "outlook", connectorId: con!.id, defaultChannel: "cab@example.com" })
      .returning();
    created.chatops.push(outlook!.id);
    expect(outlook!.outlookRecipientAllowList).toEqual([]);
    const ok = await db
      .update(chatopsConnections)
      .set({ outlookRecipientAllowList: ["ops@example.com"] })
      .where(eq(chatopsConnections.id, outlook!.id))
      .returning();
    expect(ok[0]!.outlookRecipientAllowList).toEqual(["ops@example.com"]);
    const check = /chatops_connections_outlook_allow_list_check/;
    await expectRefused(
      db.update(chatopsConnections).set({ outlookRecipientAllowList: ["Ops@Example.com"] }).where(eq(chatopsConnections.id, outlook!.id)),
      check,
    );
    await expectRefused(
      db.execute(sql`UPDATE chatops_connections SET outlook_recipient_allow_list = '[1]'::jsonb WHERE id = ${outlook!.id}`),
      check,
    );
    await expectRefused(
      db.execute(sql`UPDATE chatops_connections SET outlook_recipient_allow_list = '"a@example.com"'::jsonb WHERE id = ${outlook!.id}`),
      check,
    );
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    await expectRefused(
      db.update(chatopsConnections).set({ outlookRecipientAllowList: many }).where(eq(chatopsConnections.id, outlook!.id)),
      check,
    );
    await expectRefused(
      db.insert(chatopsConnections).values({
        name: `a185-slack-${RUN}`,
        provider: "slack",
        connectorId: con!.id,
        defaultChannel: "#cab",
        signingSecretCiphertext: "synthetic-not-a-secret",
        outlookRecipientAllowList: ["ops@example.com"],
      }),
      /chatops_connections_outlook_allow_list_provider_check/,
    );
  });

  it("the oldest-first sweep indexes exist", async () => {
    const res = await db.execute(sql`select indexname from pg_indexes where schemaname = 'public'
      and indexname in ('semantic_cache_created_at_idx', 'conversations_updated_at_idx')`);
    const names = (res as unknown as { rows: Array<{ indexname: string }> }).rows.map((r) => r.indexname).sort();
    expect(names).toEqual(["conversations_updated_at_idx", "semantic_cache_created_at_idx"]);
  });
});

describe("ADR-0185 seams keep today's behaviour", () => {
  it("POST /v1/servers: today's body works; SSE and stdio are refused until their slice lands", async () => {
    const legacy = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `a185-legacy-${RUN}`,
      url: "http://127.0.0.1:9/mcp",
      allowPrivateRanges: true,
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
    created.servers.push(legacy.json().id);
    expect(legacy.json()).toMatchObject({ transport: "streamable_http", stdioCommand: null, admissionState: "unscanned" });
    for (const body of [
      { name: `a185-sse-${RUN}`, url: "http://127.0.0.1:9/sse", transport: "sse", allowPrivateRanges: true },
      { name: `a185-std-${RUN}`, transport: "stdio", stdio: { command: "/opt/mcp/bin/fs", args: ["--root", "/srv"] } },
    ]) {
      const r = await inject("POST", "/v1/servers", users.admin.auth, body);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toBe("mcp_transport_disabled");
    }
    const n = await db.select({ id: mcpServers.id }).from(mcpServers).where(inArray(mcpServers.name, [`a185-sse-${RUN}`, `a185-std-${RUN}`]));
    expect(n).toEqual([]);
    // a mixed body is a 400, never half-applied
    const mixed = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `a185-mixed-${RUN}`,
      url: "http://127.0.0.1:9/mcp",
      stdio: { command: "/opt/x" },
    });
    expect(mixed.statusCode, mixed.body).toBe(400);
  });

  it("PATCH /v1/servers/:id: a transport never changes; restating it is a no-op", async () => {
    const id = created.servers[created.servers.length - 1]!;
    const change = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { transport: "sse" });
    expect(change.statusCode, change.body).toBe(409);
    expect(change.json().error).toBe("mcp_transport_immutable");
    const stdio = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { command: "/opt/x" } });
    expect(stdio.statusCode, stdio.body).toBe(409);
    const same = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { transport: "streamable_http" });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().transport).toBe("streamable_http");
  });
});

describe("ADR-0185 I3: an incident can hold a conversation", () => {
  it("a member links their own conversation; another person's, or none, is the same 404", async () => {
    const mine = await mkConversation(users.member.id);
    const theirs = await mkConversation(users.admin.id);
    for (const objectId of [theirs, randomUUID(), "not-a-uuid"]) {
      const r = await inject("POST", "/v1/incidents", users.member.auth, {
        title: `a185 ${RUN}`,
        severity: "low",
        detectionSource: "manual",
        links: [{ objectType: "conversation", objectId }],
      });
      expect(r.statusCode, `${objectId}: ${r.body}`).toBe(404);
      expect(r.json().error).toBe("unknown_link_target");
    }
    const ok = await inject("POST", "/v1/incidents", users.member.auth, {
      title: `a185 ${RUN}`,
      severity: "low",
      detectionSource: "manual",
      links: [{ objectType: "conversation", objectId: mine }],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const incidentId = ok.json().incident.id as string;
    created.incidents.push(incidentId);
    const links = await db.select().from(aiIncidentLinks).where(eq(aiIncidentLinks.incidentId, incidentId));
    expect(links.map((l) => [l.objectType, l.objectId])).toEqual([["conversation", mine]]);
    // an admin may hold any existing conversation
    const admin = await inject("POST", `/v1/incidents/${incidentId}/links`, users.admin.auth, {
      objectType: "conversation",
      objectId: theirs,
    });
    expect(admin.statusCode, admin.body).toBe(201);
  });
});

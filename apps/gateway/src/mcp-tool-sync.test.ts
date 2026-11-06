/**
 * #609 follow-ups (owner 2026-10-30, #453), on a real database through the real app:
 *
 *  - POST /v1/servers/:serverId/tools/sync: an admin with a `settings_relax` step-up bound to the server syncs its
 *    manifest now; the tools are stored and the `mcp-tools-synced` allow row is written with them. Without the
 *    step-up, as a non-admin, for a held, cooling-down or egress-refused server, nothing reaches the upstream and
 *    nothing is stored; every refusal after the step-up has its `mcp-tools-sync-refused` row. An unreachable
 *    upstream is a named 502 that does not echo its address. The route is rate limited per server.
 *  - The release-age cooldown answers its own code, `mcp_release_age_cooldown`, with the override as its remedy,
 *    on this route and on the proxy's manifest path (it used to read `mcp_admission_held`).
 *
 * Global state (M-068): the strict admission and identity relaxations and the step-up posture are put back in
 * afterAll. Servers, users and grants are this run's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  gt,
  mcpServers,
  mcpTools,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { MCP_TOOLS_SYNCED_RULE_ID, MCP_TOOLS_SYNC_REFUSED_RULE_ID } from "./mcp-tool-sync.js";
import { RELEASE_AGE_COOLDOWN_REMEDY } from "./mcp-proxy.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `mcp-sync-boot-${RUN}`;
const admin = { authorization: `Bearer ${BOOT}` };
const SYNC_MAX = 4;

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let adminId: string;
let memberAuth: { authorization: string };
const restores: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // the strict step-up posture, explicitly (another file may have relaxed it and not yet put it back)
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, {
    bootstrapToken: BOOT,
    retry: { maxAttempts: 1 },
    timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 },
    // the suite runs with the limiter off (vitest.config.ts); this file is about one of its buckets
    rateLimit: { enabled: true, mcpSyncMax: SYNC_MAX },
  });
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  gatewayUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const a = await app.inject({ method: "POST", url: "/v1/users", headers: admin, payload: { email: `mcp-sync-admin-${RUN}@example.test`, displayName: "Sync admin" } });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const m = await app.inject({ method: "POST", url: "/v1/users", headers: admin, payload: { email: `mcp-sync-member-${RUN}@example.test`, displayName: "Sync member" } });
  expect(m.statusCode, m.body).toBe(201);
  const key = await app.inject({ method: "POST", url: `/v1/users/${m.json().id}/keys`, headers: admin, payload: { name: "mcp-sync" } });
  memberAuth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  app.server.closeAllConnections();
  await app.close();
});

const syncArgs = (serverId: string) => ({ kind: "settings_relax" as const, facts: { serverId, values: { mcpToolSync: serverId } } });

/** the admin's sync, with a fresh grant made for exactly this server */
async function sync(serverId: string) {
  const g = await grantStepUpForTest(db, adminId, syncArgs(serverId));
  const r = stepUpRequest(g);
  const res = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools/sync`, ...r });
  return { res, grantId: g.grantId };
}

async function fixture() {
  const counts = { requests: 0 };
  const server = http.createServer((req, res) => {
    counts.requests++;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      void (async () => {
        const message = body ? JSON.parse(body) : undefined;
        const mcp = new McpServer({ name: "mcp-sync", version: "1" });
        mcp.registerTool("ping", { inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "pong" }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { void transport.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, message);
      })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No upstream address");
  const registered = await app.inject({ method: "POST", url: "/v1/servers", headers: admin,
    payload: { name: `mcp-sync-${crypto.randomUUID()}`, url: `http://127.0.0.1:${address.port}/` } });
  expect(registered.statusCode, registered.body).toBe(201);
  const id: string = registered.json().id;
  let closed = false;
  return {
    id,
    port: address.port,
    counts,
    tools: async () => (await db.select({ name: mcpTools.name }).from(mcpTools).where(eq(mcpTools.serverId, id))).map((t) => t.name),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function auditSince(serverId: string, ruleId: string, since: Date) {
  return db.select().from(auditLog)
    .where(and(eq(auditLog.serverId, serverId), eq(auditLog.ruleId, ruleId), gt(auditLog.at, since)))
    .orderBy(desc(auditLog.at));
}

describe("POST /v1/servers/:serverId/tools/sync", () => {
  it("an admin with the step-up syncs the manifest: stored, answered, audited with it, the grant spent", async () => {
    const f = await fixture();
    try {
      const since = new Date();
      const { res, grantId } = await sync(f.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ serverId: f.id, toolCount: 1, added: ["ping"] });
      expect(await f.tools()).toEqual(["ping"]);
      expect(await grantSpent(db, grantId)).toBe(true);
      const [row] = await auditSince(f.id, MCP_TOOLS_SYNCED_RULE_ID, since);
      expect(row).toMatchObject({ userId: adminId, effect: "allow", objectType: "mcp_server", objectId: f.id });
      expect(row!.detail).toMatchObject({ phase: "tools-sync", toolCount: 1, added: ["ping"] });
      // a second sync of the same manifest adds nothing
      const again = await sync(f.id);
      expect(again.res.statusCode, again.res.body).toBe(200);
      expect(again.res.json()).toMatchObject({ toolCount: 1, added: [] });
    } finally { await f.close(); }
  });

  it("without the step-up: refused, the upstream untouched, nothing stored, a grant for other facts not spent", async () => {
    const f = await fixture();
    try {
      const g = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { serverId: f.id, values: { mcpToolSync: "another-server" } } });
      const bare = await app.inject({ method: "POST", url: `/v1/servers/${f.id}/tools/sync`, ...sessionRequest(g) });
      // this admin has no second factor enrolled, so the strict posture answers `step_up_unavailable`
      expect(bare.statusCode, bare.body).toBe(422);
      expect(bare.json()).toMatchObject({ error: "step_up_unavailable", actionKind: "settings_relax" });
      // a grant for other facts is refused and not spent
      const wrong = await app.inject({ method: "POST", url: `/v1/servers/${f.id}/tools/sync`, ...stepUpRequest(g) });
      expect(wrong.statusCode, wrong.body).toBe(422);
      expect(await grantSpent(db, g.grantId)).toBe(false);
      expect(f.counts.requests).toBe(0);
      expect(await f.tools()).toEqual([]);
    } finally { await f.close(); }
  });

  it("a non-admin is refused by the default gate before anything else", async () => {
    const f = await fixture();
    try {
      const res = await app.inject({ method: "POST", url: `/v1/servers/${f.id}/tools/sync`, headers: memberAuth });
      expect(res.statusCode, res.body).toBe(403);
      expect(f.counts.requests).toBe(0);
      expect(await f.tools()).toEqual([]);
    } finally { await f.close(); }
  });

  it("an unknown server is a named 404", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/servers/${crypto.randomUUID()}/tools/sync`, headers: admin });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error).toBe("unknown_server");
  });

  it("a HELD server: 403 mcp_admission_held, both refusals audited, the upstream untouched", async () => {
    const f = await fixture();
    const [was] = await db.select({ m: orgSettings.mcpAdmissionMode }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await db.update(orgSettings).set({ mcpAdmissionMode: "enforce" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      await db.update(mcpServers).set({
        admissionState: "held", admissionSeverity: "high",
        admissionFindings: [{ ruleId: "mcp.admission.injection", severity: "high", toolName: "ping" }],
        admissionManifestDigest: "sha256:mcp-sync", admissionScannedAt: new Date(),
      }).where(eq(mcpServers.id, f.id));
      const since = new Date();
      const { res } = await sync(f.id);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("mcp_admission_held");
      expect(f.counts.requests).toBe(0);
      expect(await f.tools()).toEqual([]);
      expect((await auditSince(f.id, "mcp-admission-held", since))[0]?.effect).toBe("deny");
      const [refused] = await auditSince(f.id, MCP_TOOLS_SYNC_REFUSED_RULE_ID, since);
      expect(refused).toMatchObject({ effect: "deny", userId: adminId });
      expect(refused!.detail).toMatchObject({ code: "mcp_admission_held", status: 403 });
    } finally {
      await db.update(orgSettings).set({ mcpAdmissionMode: was!.m }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      await f.close();
    }
  });

  it("the release-age cooldown answers its own code with the override as its remedy, here and on the proxy", async () => {
    const f = await fixture();
    const [was] = await db.select({ d: orgSettings.minReleaseAgeDays }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await db.update(orgSettings).set({ minReleaseAgeDays: 7 }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const since = new Date();
      const { res } = await sync(f.id);
      expect(res.statusCode, res.body).toBe(403);
      const body = res.json();
      expect(body.error).toBe("mcp_release_age_cooldown");
      expect(body.remedy).toBe(RELEASE_AGE_COOLDOWN_REMEDY);
      expect(body.remedy).toContain("/v1/release-quarantine/override");
      expect(typeof body.readyAt).toBe("string");
      expect(body.detail).toContain("release-age quarantine");
      expect(f.counts.requests).toBe(0);
      expect((await auditSince(f.id, "mcp-release-quarantined", since))[0]?.effect).toBe("deny");
      const [refused] = await auditSince(f.id, MCP_TOOLS_SYNC_REFUSED_RULE_ID, since);
      expect(refused!.detail).toMatchObject({ code: "mcp_release_age_cooldown" });

      // the proxy's manifest path: the same code (it used to leave as mcp_admission_held)
      await app.inject({ method: "POST", url: "/v1/grants/tools", headers: admin, payload: { userId: adminId, serverId: f.id, toolName: "ping" } });
      const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: admin, payload: { name: `cooldown-${RUN}` } });
      const proxied = await fetch(`${gatewayUrl}/mcp/${f.id}`, {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${key.json().token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(proxied.status).toBe(403);
      const pb = (await proxied.json()) as Record<string, unknown>;
      expect(pb.error).toBe("mcp_release_age_cooldown");
      expect(pb.remedy).toBe(RELEASE_AGE_COOLDOWN_REMEDY);
      expect(f.counts.requests).toBe(0);
    } finally {
      await db.update(orgSettings).set({ minReleaseAgeDays: was!.d }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      await f.close();
    }
  });

  it("an egress-refused destination: 403 egress_blocked, audited, nothing contacted", async () => {
    const f = await fixture();
    try {
      // the shape of a server after the allow-list tightened underneath it (TEST-NET-3: public, never resolved)
      await db.update(mcpServers).set({ url: `http://203.0.113.${1 + Math.floor(Math.random() * 250)}:8931/` }).where(eq(mcpServers.id, f.id));
      const since = new Date();
      const { res } = await sync(f.id);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(await f.tools()).toEqual([]);
      const [refused] = await auditSince(f.id, MCP_TOOLS_SYNC_REFUSED_RULE_ID, since);
      expect(refused!.detail).toMatchObject({ code: "egress_blocked" });
    } finally { await f.close(); }
  });

  it("an unreachable upstream: a named 502 that does not echo the address, audited", async () => {
    const f = await fixture();
    await f.close();
    const since = new Date();
    const { res } = await sync(f.id);
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error).toBe("mcp_upstream_unreachable");
    expect(res.body).not.toContain(String(f.port));
    expect(res.body).not.toContain("127.0.0.1");
    const [refused] = await auditSince(f.id, MCP_TOOLS_SYNC_REFUSED_RULE_ID, since);
    expect(refused!.detail).toMatchObject({ code: "mcp_upstream_unreachable", status: 502 });
  });

  it("is rate limited per server", async () => {
    const f = await fixture();
    const other = await fixture();
    try {
      for (let i = 0; i < SYNC_MAX; i++) expect((await sync(f.id)).res.statusCode).toBe(200);
      const over = await sync(f.id);
      expect(over.res.statusCode, over.res.body).toBe(429);
      expect(await grantSpent(db, over.grantId)).toBe(false);
      // another server has its own bucket
      expect((await sync(other.id)).res.statusCode).toBe(200);
    } finally { await f.close(); await other.close(); }
  });
});

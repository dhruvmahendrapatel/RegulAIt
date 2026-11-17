/**
 * ADR-0358 (lane E39) part 2 — CMDB sync, end to end against a fake ServiceNow (real database, real app).
 *
 *  - a connector is created disabled and export only; enabling needs a live credential and a step-up (an API key under
 *    the strict posture is refused); revoking needs neither and disables the connector;
 *  - the credential is encrypted (never returned, never in an audit row), rotated by compare-and-set, destroyed on
 *    revoke; moving the instance URL revokes it;
 *  - a sync pushes agents, MCP servers, models and endpoints through IRE with the stable source key; a second sync
 *    sends nothing for unchanged assets; a renamed asset is re-sent and updates the same link;
 *  - an item IRE did not confirm is not linked (the next pass retries it); a 401 fails the run with a fixed code and
 *    no vendor text is stored; a host off the egress allow-list gets nothing;
 *  - the ownership read-back runs only when turned on (step-up) and is recorded, never applied;
 *  - one running run per connector (a concurrent open is refused `in_progress`); the run lifecycle is the declared table;
 *  - every route is admin-only; row-level security admits an admin principal only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  auditLog,
  cmdbCiLinks,
  cmdbConnectors,
  cmdbCredentials,
  cmdbSyncRuns,
  createDb,
  eq,
  inArray,
  mcpServers,
  runMigrations,
  sql,
  users,
  withPrincipal,
  type Db,
} from "@regulait/db";
import { CMDB_SYNC_RUN_TRANSITIONS, cmdbRunCanTransition } from "@regulait/shared";
import { buildApp } from "./app.js";
import { syncCmdbConnector, CMDB_SYNC_JOB_NAME } from "./cmdb-sync.js";
import { SCHEDULER_JOB_NAMES, schedulerJobDefinitions } from "./scheduler-jobs.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround, relaxStepUpForTest } from "./testing/step-up-posture.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e39c-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const HOST = `e39-${RUN}.service-now.example.com`;
const OTHER_HOST = `e39-other-${RUN}.service-now.example.com`;
const PASSWORD = `pw-${RUN}-SECRET`;
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const allowed = trackEgressAllowHosts();

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let connectorId: string;
let agentId: string;
let mcpId: string;
let ownerEmail: string;
const restores: Array<() => Promise<void>> = [];

const sysIdFor = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

interface Got {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}
/** a fake ServiceNow: IRE confirms every item (except names in `reject`), the Table API reports `owner` for every CI */
function fakeServiceNow(o: { status?: number; reject?: Set<string>; owner?: string; body?: string } = {}) {
  const got: Got[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    got.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body });
    if (o.status) return new Response(o.body ?? `{"error":{"message":"User Not Authenticated ${PASSWORD}"}}`, { status: o.status });
    if (u.pathname === "/api/now/identifyreconcile") {
      const items = (body.items as Array<{ values: { name: string }; sys_object_source_info: { source_native_key: string } }>).map((it, i) =>
        o.reject?.has(it.values.name)
          ? { className: "cmdb_ci_appl", operation: "NO_CHANGE", inputIndices: [i], errorCount: 1, errors: [{ error: "X", message: "nope" }] }
          : { className: "cmdb_ci_appl", operation: "INSERT", sysId: sysIdFor(it.sys_object_source_info.source_native_key), inputIndices: [i], errorCount: 0 },
      );
      return Response.json({ result: { items, relations: [] } });
    }
    if (u.pathname.startsWith("/api/now/table/")) {
      const ids = (u.searchParams.get("sysparm_query") ?? "").replace(/^sys_idIN/, "").split(",");
      return Response.json({ result: ids.map((sys_id) => ({ sys_id, "owned_by.email": o.owner ?? "" })) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, got };
}

const sync = (fake: ReturnType<typeof fakeServiceNow>, id = connectorId) =>
  syncCmdbConnector(db, id, { dataKey: DATA_KEY, trigger: "manual", actorUserId: adminId, deps: { resolve, fetchImpl: fake.fetchImpl } });
const links = () => db.select().from(cmdbCiLinks).where(eq(cmdbCiLinks.connectorId, connectorId));
const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers = adminKey) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const base = () => `/v1/cmdb/connectors/${connectorId}`;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const allow = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost(HOST), allowPrivateRanges: false, allowPlaintextHttp: false, note: `e39 ${RUN}` } }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  const mk = async (k: string, isAdmin: boolean) => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e39c-${k}-${RUN}@example.com`, displayName: `e39c ${k}`, isAdmin } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    return { id, key: { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` } };
  };
  const a = await mk("admin", true);
  adminId = a.id;
  adminKey = a.key;
  memberKey = (await mk("member", false)).key;
  ownerEmail = `E39C-ADMIN-${RUN}@example.com`; // case differs: matched case-insensitively
  agentId = (await db.insert(agents).values({ name: `e39c-agent-${RUN}`, provider: "mock", tier: 1, model: `e39c-model-${RUN}` }).returning())[0]!.id;
  mcpId = (await db.insert(mcpServers).values({ name: `e39c-mcp-${RUN}`, url: `https://mcp-${RUN}.example.com` } as typeof mcpServers.$inferInsert).returning())[0]!.id;
}, 120_000);

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    await db.delete(cmdbConnectors).where(sql`${cmdbConnectors.name} like ${`e39c-${RUN}%`}`);
    await db.delete(agents).where(eq(agents.id, agentId));
    await db.delete(mcpServers).where(eq(mcpServers.id, mcpId));
    for (const r of restores.reverse()) await r();
    app.server.closeAllConnections();
    await app.close();
  } finally {
    entries.assertRemoved();
  }
});

/** only this file's assets: other suites' agents and servers are in the same registry */
const mine = <T extends { sourceKey: string }>(rows: T[]): T[] => rows.filter((l) => l.sourceKey.includes(agentId) || l.sourceKey.includes(mcpId) || l.sourceKey.includes(RUN));

describe("ADR-0358 CMDB connectors: off by default, export only", () => {
  it("is admin-only", async () => {
    expect((await req("GET", "/v1/cmdb/connectors", undefined, memberKey)).statusCode).toBe(403);
    expect((await req("POST", "/v1/cmdb/connectors", { name: "x", kind: "servicenow", instanceUrl: `https://${HOST}` }, memberKey)).statusCode).toBe(403);
  });

  it("validates the instance URL", async () => {
    for (const instanceUrl of [`http://${HOST}`, `https://u:p@${HOST}`, `https://${HOST}/api`, "nope"]) {
      expect((await req("POST", "/v1/cmdb/connectors", { name: `e39c-${RUN}-bad`, kind: "servicenow", instanceUrl })).statusCode, instanceUrl).toBe(400);
    }
    expect((await req("POST", "/v1/cmdb/connectors", { name: `e39c-${RUN}-bad`, kind: "servicenow", instanceUrl: `https://${HOST}`, ciClasses: { agent: "DROP TABLE" } })).statusCode).toBe(400);
  });

  it("creates a connector disabled and export only; a duplicate name is refused", async () => {
    const r = await req("POST", "/v1/cmdb/connectors", { name: `e39c-${RUN}`, kind: "servicenow", instanceUrl: `https://${HOST}/` });
    expect(r.statusCode, r.body).toBe(201);
    const c = r.json().connector;
    connectorId = c.id;
    expect(c).toMatchObject({ enabled: false, readBackOwnership: false, instanceUrl: `https://${HOST}`, sourceName: "RegulAIt", credential: null });
    expect(c.posture).toMatchObject({ exportOnly: true, egressAllowed: true, canRun: false });
    expect((await req("POST", "/v1/cmdb/connectors", { name: `E39C-${RUN}`, kind: "servicenow", instanceUrl: `https://${HOST}` })).statusCode).toBe(409);
  });

  it("refuses to enable without a credential, and a sync of a disabled connector is a refused run", async () => {
    expect((await req("PUT", `${base()}/enabled`, { enabled: true, reason: "go" })).json().error).toBe("no_credential");
    const out = await sync(fakeServiceNow());
    expect(out!.run).toMatchObject({ status: "refused", errorCode: "disabled" });
  });

  it("stores the credential under step-up (compare-and-set), never returns it, and enables under step-up", async () => {
    const strict = await req("PUT", `${base()}/credential`, { username: "svc", password: PASSWORD, replacesCredentialId: null, reason: "pilot" });
    expect(strict.statusCode, "an API key cannot give the step-up").not.toBe(200);
    const restore = await relaxStepUpForTest(db);
    try {
      const stored = await req("PUT", `${base()}/credential`, { username: "svc", password: PASSWORD, replacesCredentialId: null, reason: "pilot" });
      expect(stored.statusCode, stored.body).toBe(200);
      expect(stored.body).not.toContain(PASSWORD);
      const credId = stored.json().connector.credential.id as string;
      expect((await req("PUT", `${base()}/credential`, { username: "svc", password: "x", replacesCredentialId: null, reason: "again" })).json().error).toBe("credential_conflict");
      const rotated = await req("PUT", `${base()}/credential`, { username: "svc2", password: PASSWORD, replacesCredentialId: credId, reason: "rotate" });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const all = await db.select().from(cmdbCredentials).where(eq(cmdbCredentials.connectorId, connectorId));
      expect(all.find((c) => c.id === credId)!.secretCiphertext).toBeNull();
      expect(all.filter((c) => c.revokedAt === null)).toHaveLength(1);
      expect(all.find((c) => c.revokedAt === null)!.secretCiphertext).not.toContain(PASSWORD);
      const on = await req("PUT", `${base()}/enabled`, { enabled: true, reason: "pilot export" });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json().connector).toMatchObject({ enabled: true, posture: { canRun: true } });
    } finally {
      await restore();
    }
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "cmdb_connector"), eq(auditLog.objectId, connectorId)));
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
    expect(audits.map((a) => a.ruleId)).toEqual(expect.arrayContaining(["cmdb-connector-created", "cmdb-credential-stored", "cmdb-connector-enabled"]));
  });

  it("pushes every asset kind through IRE with the stable source key and Basic auth", async () => {
    const fake = fakeServiceNow();
    const out = await sync(fake);
    expect(out!.run.status, JSON.stringify(out!.run)).toBe("succeeded");
    const push = fake.got.filter((g) => g.url.includes("/api/now/identifyreconcile"));
    expect(push.length).toBeGreaterThan(0);
    expect(push[0]!.url).toContain("sysparm_data_source=RegulAIt");
    expect(push[0]!.auth).toBe(`Basic ${Buffer.from(`svc2:${PASSWORD}`).toString("base64")}`);
    const sent = push.flatMap((p) => (p.body as { items: Array<{ className: string; values: Record<string, string>; sys_object_source_info: Record<string, string> }> }).items);
    const agentItem = sent.find((i) => i.sys_object_source_info.source_native_key === `regulait:agent:${agentId}`)!;
    expect(agentItem).toMatchObject({ className: "cmdb_ci_appl", values: { name: `e39c-agent-${RUN}` }, sys_object_source_info: { source_name: "RegulAIt" } });
    expect(Object.keys(agentItem.values).sort()).toEqual(["name", "short_description"]);
    expect(sent.some((i) => i.sys_object_source_info.source_native_key === `regulait:mcp_server:${mcpId}`)).toBe(true);
    expect(sent.some((i) => i.sys_object_source_info.source_native_key === `regulait:model:mock/e39c-model-${RUN}`)).toBe(true);
    // no ownership read while export only
    expect(fake.got.some((g) => g.url.includes("/api/now/table/"))).toBe(false);
    const mineLinks = mine(await links());
    expect(mineLinks.map((l) => l.assetKind).sort()).toEqual(["agent", "mcp_server", "model"]);
    expect(mineLinks.find((l) => l.assetKind === "agent")!.ciSysId).toBe(sysIdFor(`regulait:agent:${agentId}`));
  });

  it("sends nothing for unchanged assets, and re-sends a renamed one to the same link", async () => {
    const quiet = fakeServiceNow();
    const again = await sync(quiet);
    expect(again!.run).toMatchObject({ status: "succeeded", itemsPushed: 0 });
    expect(quiet.got).toHaveLength(0);
    await db.update(agents).set({ name: `e39c-agent-${RUN}-renamed` }).where(eq(agents.id, agentId));
    const fake = fakeServiceNow();
    const out = await sync(fake);
    expect(out!.run).toMatchObject({ status: "succeeded", itemsPushed: 1 });
    expect(mine(await links()).filter((l) => l.assetKind === "agent")).toHaveLength(1);
  });

  it("does not link an item IRE did not confirm, so the next pass retries it", async () => {
    await db.update(agents).set({ name: `e39c-agent-${RUN}-v3` }).where(eq(agents.id, agentId));
    const before = mine(await links()).find((l) => l.assetKind === "agent")!.payloadSha256;
    const out = await sync(fakeServiceNow({ reject: new Set([`e39c-agent-${RUN}-v3`]) }));
    expect(out!.run).toMatchObject({ status: "succeeded", itemsFailed: 1 });
    expect(mine(await links()).find((l) => l.assetKind === "agent")!.payloadSha256).toBe(before);
    expect((await sync(fakeServiceNow()))!.run).toMatchObject({ itemsPushed: 1, itemsFailed: 0 });
  });

  it("fails a 401 with a fixed code and stores no vendor text", async () => {
    await db.update(agents).set({ name: `e39c-agent-${RUN}-v4` }).where(eq(agents.id, agentId));
    const out = await sync(fakeServiceNow({ status: 401 }));
    expect(out!.run).toMatchObject({ status: "failed", errorCode: "unauthorized" });
    const [run] = await db.select().from(cmdbSyncRuns).where(eq(cmdbSyncRuns.id, out!.run.id));
    expect(JSON.stringify(run)).not.toContain(PASSWORD);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "cmdb-sync-run"), sql`${auditLog.detail}->>'runId' = ${out!.run.id}`));
    expect(audit!.effect).toBe("deny");
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect((await sync(fakeServiceNow({ status: 200, body: "not json" })))!.run).toMatchObject({ status: "failed", errorCode: "bad_response" });
  });

  it("refuses a concurrent open, and the lifecycle is the declared table", async () => {
    const [held] = await db.insert(cmdbSyncRuns).values({ connectorId, trigger: "manual", status: "running" }).returning();
    try {
      const out = await sync(fakeServiceNow());
      expect(out!.run).toMatchObject({ status: "refused", errorCode: "in_progress" });
    } finally {
      await db.update(cmdbSyncRuns).set({ status: "failed", errorCode: "internal", finishedAt: new Date() }).where(eq(cmdbSyncRuns.id, held!.id));
    }
    expect(CMDB_SYNC_RUN_TRANSITIONS.running).toEqual(["succeeded", "failed"]);
    expect(cmdbRunCanTransition("succeeded", "failed")).toBe(false);
    expect(cmdbRunCanTransition("refused", "running")).toBe(false);
  });

  it("reads ownership back only when turned on (step-up), recorded and never applied", async () => {
    const strict = await req("PUT", `${base()}/config`, { readBackOwnership: true, reason: "owners" });
    expect(strict.statusCode).not.toBe(200);
    const restore = await relaxStepUpForTest(db);
    try {
      const on = await req("PUT", `${base()}/config`, { readBackOwnership: true, reason: "owners" });
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json().connector.posture.exportOnly).toBe(false);
    } finally {
      await restore();
    }
    const fake = fakeServiceNow({ owner: ownerEmail });
    const out = await sync(fake);
    expect(out!.run.status).toBe("succeeded");
    expect(out!.run.ownershipRead).toBeGreaterThan(0);
    const agentLink = mine(await links()).find((l) => l.assetKind === "agent")!;
    expect(agentLink).toMatchObject({ cmdbOwnerEmail: ownerEmail, cmdbOwnerUserId: adminId });
    const [agent] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, agentId));
    expect(agent!.owner).toBeNull();
    const page = await req("GET", `${base()}/links?limit=500`);
    expect(page.statusCode).toBe(200);
    expect((page.json().items as Array<{ sourceKey: string; cmdbOwnership: unknown }>).find((l) => l.sourceKey === `regulait:agent:${agentId}`)!.cmdbOwnership).toMatchObject({ email: ownerEmail, matchedUserId: adminId });
  });

  it("paginates the runs", async () => {
    const p = (await req("GET", `${base()}/runs?limit=10`)).json();
    expect(p.items.length).toBeGreaterThan(0);
    expect((await req("GET", `${base()}/runs?limit=3`)).statusCode).toBe(400);
  });

  it("a host off the egress allow-list gets nothing", async () => {
    const moved = await req("PUT", `${base()}/config`, { instanceUrl: `https://${OTHER_HOST}`, reason: "move" });
    expect(moved.statusCode, moved.body).toBe(200);
    // moving revokes the credential and disables the connector: the password never goes to the new host
    expect(moved.json().connector).toMatchObject({ enabled: false, credential: null, posture: { egressAllowed: false } });
    await db.insert(cmdbCredentials).values({ connectorId, username: "svc3", secretCiphertext: await encrypted() });
    await db.update(cmdbConnectors).set({ enabled: true }).where(eq(cmdbConnectors.id, connectorId));
    await db.update(agents).set({ name: `e39c-agent-${RUN}-v5` }).where(eq(agents.id, agentId));
    const fake = fakeServiceNow();
    const out = await sync(fake);
    expect(out!.run).toMatchObject({ status: "failed", errorCode: "egress_blocked" });
    expect(fake.got).toHaveLength(0);
  });

  it("revoking needs no step-up, destroys the secret and disables the connector", async () => {
    const r = await req("DELETE", `${base()}/credential`);
    expect(r.statusCode, r.body).toBe(200);
    const [c] = await db.select().from(cmdbConnectors).where(eq(cmdbConnectors.id, connectorId));
    expect(c!.enabled).toBe(false);
    const live = await db.select().from(cmdbCredentials).where(and(eq(cmdbCredentials.connectorId, connectorId), sql`${cmdbCredentials.revokedAt} IS NULL`));
    expect(live).toHaveLength(0);
  });

  it("row-level security admits an admin principal only", async () => {
    const [member] = await db.select({ id: users.id }).from(users).where(eq(users.email, `e39c-member-${RUN}@example.com`));
    for (const t of [cmdbConnectors, cmdbCredentials, cmdbSyncRuns, cmdbCiLinks]) {
      expect(await withPrincipal(db, { userId: member!.id }, (tx) => tx.select().from(t).limit(1))).toHaveLength(0);
    }
    expect((await withPrincipal(db, { userId: adminId }, (tx) => tx.select().from(cmdbConnectors).where(inArray(cmdbConnectors.id, [connectorId])))).length).toBe(1);
  });

  it("registers the sweep job under its listed name", () => {
    expect(SCHEDULER_JOB_NAMES.cmdbSyncSweep).toBe(CMDB_SYNC_JOB_NAME);
    expect(schedulerJobDefinitions().some((d) => d.name === CMDB_SYNC_JOB_NAME)).toBe(true);
  });
});

async function encrypted(): Promise<string> {
  const { encryptSecret } = await import("./secrets.js");
  return encryptSecret(DATA_KEY, PASSWORD);
}

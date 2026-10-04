/**
 * ADR-0175 D2 remainder (A7 credential inventory, A15 energy) — review fixes,
 * end to end. One `describe` per finding; each was proven red without its fix.
 *
 *  2. every inventory ledger read is windowed and matched to its credentials
 *     in SQL, on an index; the route pages; observe-only computes nothing.
 *  3. a demo energy factor is refused for a model any non-mock agent names,
 *     and the estimate applies one to mock-served calls only.
 *
 * Shared database (M-008, M-068): every row this file inserts is deleted in
 * afterAll, and the org settings it touches are restored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  connectorCredentials,
  connectors,
  createDb,
  customModelProviders,
  energyFactors,
  eq,
  inArray,
  orgSettings,
  projects,
  runMigrations,
  sql,
  usageEvents,
  virtualKeys,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { encryptSecret } from "./secrets.js";
import { hashToken } from "./token-hash.js";
import { connectorLastUseQuery, virtualKeyLinkQuery } from "./credential-inventory.js";
import { staleCredentialsInput } from "./governance-monitor.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g175r-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const KEY = "a".repeat(64);
const DAY = 86_400_000;
/** the agent the virtual key's recent call names (no agent row needed: the ledger is FK-free) */
const VK_AGENT = "7d1c0a5e-2b4f-4e8a-9c3d-5f6a7b8c9d0e";

let db: Db;
let app: ReturnType<typeof buildApp>;
const ids = { admin: "", connector: "", connectorCred: "", custom: "", customAgent: "", vk: "", otherVk: "", project: "" };
/** every agent row this file inserts directly */
const agentIds: string[] = [];
const DEMO_MODEL = `g175r-demo-${RUN}`;
const SHARED_MODEL = `g175r-shared-${RUN}`;
const mkAgent = async (provider: string, model: string) => {
  const [a] = await db
    .insert(agents)
    .values({ name: `g175r-${provider}-${model}-${agentIds.length}`, provider, tier: 1, model, enabled: false })
    .returning({ id: agents.id });
  agentIds.push(a!.id);
  return a!.id;
};
const putFactor = (body: Record<string, unknown>) => call("PUT", "/v1/energy/factors", adminAuth, body);
const adminAuth = { authorization: "" };
let orgBefore: { alerts: boolean; unusedDays: number } | null = null;

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const inventory = async (query = "") => {
  const r = await call("GET", `/v1/admin/credentials${query}`, adminAuth);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
/**
 * EXPLAIN a query against a ledger shaped like production's (thousands of
 * recent agent and connector rows of other keys and connectors, analysed), so
 * the planner's choice is a real one. All of it inside a transaction that is
 * rolled back: the rows and the statistics are gone afterwards.
 */
const explain = async (query: unknown) => {
  let plan = "";
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO usage_events (user_id, object_type, agent_id, virtual_key_id, connector_id, at)
        SELECT ${ids.admin}::uuid,
               CASE WHEN g % 2 = 0 THEN 'agent' ELSE 'connector' END,
               CASE WHEN g % 2 = 0 THEN gen_random_uuid() END,
               CASE WHEN g % 4 = 0 THEN gen_random_uuid() END,
               CASE WHEN g % 2 = 1 THEN gen_random_uuid() END,
               now() - (g || ' minutes')::interval
        FROM generate_series(1, 6000) AS g`);
      await tx.execute(sql`ANALYZE usage_events`);
      const res = await tx.execute(sql`EXPLAIN ${query}`);
      plan = (res.rows as Array<Record<string, string>>).map((r) => r["QUERY PLAN"]).join("\n");
      tx.rollback();
    });
  } catch (err) {
    if (!plan) throw err;
  }
  return plan;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: KEY });
  const u = await call("POST", "/v1/users", AUTH, { email: `g175r-admin-${RUN}@example.com`, displayName: `Review admin ${RUN}`, isAdmin: true });
  expect(u.statusCode, u.body).toBe(201);
  ids.admin = u.json().id;
  const k = await call("POST", `/v1/users/${ids.admin}/keys`, AUTH, { name: `g175r-admin-${RUN}` });
  adminAuth.authorization = `Bearer ${k.json().token}`;
  // give the admin key an expiry so it carries only the over_scoped flag
  const [org] = await db.select({ alerts: orgSettings.staleCredentialAlerts, unusedDays: orgSettings.credentialUnusedDays }).from(orgSettings);
  orgBefore = { alerts: org!.alerts, unusedDays: org!.unusedDays };

  const [conn] = await db.insert(connectors).values({ name: `g175r-connector-${RUN}`, kind: "mock" }).returning({ id: connectors.id });
  ids.connector = conn!.id;
  const [cc] = await db
    .insert(connectorCredentials)
    .values({ connectorId: conn!.id, tokenCiphertext: encryptSecret(KEY, `g175r-conn-${RUN}`), createdAt: new Date(Date.now() - 500 * DAY) })
    .returning({ id: connectorCredentials.id });
  ids.connectorCred = cc!.id;
  const [cp] = await db
    .insert(customModelProviders)
    .values({
      name: `g175r-custom-${RUN}`,
      wireProtocol: "openai_chat",
      baseUrl: "https://g175r.example.invalid/v1",
      keyCiphertext: encryptSecret(KEY, `g175r-custom-${RUN}`),
      createdAt: new Date(Date.now() - 500 * DAY),
    })
    .returning({ id: customModelProviders.id });
  ids.custom = cp!.id;
  const [ag] = await db
    .insert(agents)
    .values({ name: `g175r-custom-agent-${RUN}`, provider: "custom", tier: 1, model: `g175r-m-${RUN}`, customProviderId: cp!.id, enabled: false })
    .returning({ id: agents.id });
  ids.customAgent = ag!.id;
  const [vk] = await db
    .insert(virtualKeys)
    .values({ name: `g175r-vk-${RUN}`, userId: ids.admin, tokenHash: hashToken(`g175r-vk-${RUN}`), createdBy: ids.admin })
    .returning({ id: virtualKeys.id });
  ids.vk = vk!.id;
  const [vk2] = await db
    .insert(virtualKeys)
    .values({ name: `g175r-vk2-${RUN}`, userId: ids.admin, tokenHash: hashToken(`g175r-vk2-${RUN}`), createdBy: ids.admin })
    .returning({ id: virtualKeys.id });
  ids.otherVk = vk2!.id;
  // the only recorded uses are OLDER than any window the inventory reads
  const old = new Date(Date.now() - 400 * DAY);
  await db.insert(usageEvents).values([
    { userId: ids.admin, objectType: "connector", connectorId: conn!.id, at: old },
    { userId: ids.admin, objectType: "agent", agentId: ag!.id, provider: "custom", model: `g175r-m-${RUN}`, at: old },
    // a recent use of the virtual key links the agent that served it
    { userId: ids.admin, objectType: "agent", agentId: VK_AGENT, virtualKeyId: vk!.id, provider: "mock", model: `g175r-vk-m-${RUN}` },
  ]);
}, 120_000);

afterAll(async () => {
  if (orgBefore) await db.update(orgSettings).set({ staleCredentialAlerts: orgBefore.alerts, credentialUnusedDays: orgBefore.unusedDays });
  await db.delete(usageEvents).where(eq(usageEvents.userId, ids.admin));
  await db.delete(connectorCredentials).where(eq(connectorCredentials.id, ids.connectorCred));
  await db.delete(connectors).where(eq(connectors.id, ids.connector));
  await db.delete(agents).where(eq(agents.id, ids.customAgent));
  await db.delete(customModelProviders).where(eq(customModelProviders.id, ids.custom));
  await db.delete(virtualKeys).where(inArray(virtualKeys.id, [ids.vk, ids.otherVk]));
  await db.delete(energyFactors).where(sql`${energyFactors.subject} ILIKE ${`g175r-%-${RUN}`}`);
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
  if (ids.project) await db.delete(projects).where(eq(projects.id, ids.project));
  await call("POST", "/v1/governance/monitor/evaluate", AUTH);
  app.server.closeAllConnections();
  await app.close();
});

describe("review fix 2 — the inventory reads the ledger in a window, on an index, a page at a time", () => {
  it("a ledger-derived last use is read from a bounded window, and says how far back", async () => {
    await db.update(orgSettings).set({ credentialUnusedDays: 90 });
    const body = await inventory("?limit=500&type=connector_credential");
    const conn = body.credentials.find((c: any) => c.id === `connector_credential:${ids.connectorCred}`);
    // a use 400 days ago is outside the 90-day window: not reported, and the reason says why
    expect(conn.lastUsedAt).toBeNull();
    expect(body.ledgerWindowDays).toBe(90);
    const custom = (await inventory("?limit=500&type=custom_provider_key")).credentials.find((c: any) => c.id === `custom_provider_key:${ids.custom}`);
    expect(custom.lastUsedAt).toBeNull();
    expect(custom.flags).toContain("unused");
    expect(custom.flagReasons.unused).toMatch(/no recorded use in the last 90 days/);
    // a threshold longer than the link window widens the last-use window with it
    await db.update(orgSettings).set({ credentialUnusedDays: 500 });
    const wide = await inventory("?limit=500&type=connector_credential");
    expect(wide.ledgerWindowDays).toBe(500);
    expect(wide.credentials.find((c: any) => c.id === `connector_credential:${ids.connectorCred}`).lastUsedAt).not.toBeNull();
    await db.update(orgSettings).set({ credentialUnusedDays: orgBefore!.unusedDays });
  });

  it("virtual-key links are matched in SQL, on (virtual_key_id, at); connector reads on (connector_id, at)", async () => {
    const since = new Date(Date.now() - 90 * DAY);
    const rows = await virtualKeyLinkQuery(db, [ids.vk, ids.otherVk], since);
    expect(rows).toEqual([{ keyId: ids.vk, projectId: null, agentId: VK_AGENT }]);
    expect(await explain(virtualKeyLinkQuery(db, [ids.vk], since))).toMatch(/usage_events_virtual_key_idx/);
    expect(await explain(connectorLastUseQuery(db, [ids.connector], since))).toMatch(/usage_events_connector_at_idx/);
    const body = await inventory("?limit=500&type=virtual_key");
    expect(body.credentials.find((c: any) => c.id === `virtual_key:${ids.vk}`).linkedAgents.map((a: any) => a.id)).toEqual([VK_AGENT]);
    expect(body.credentials.find((c: any) => c.id === `virtual_key:${ids.otherVk}`).linkedAgents).toEqual([]);
  });

  it("GET /v1/admin/credentials pages: a default and a maximum, offset, and a total for the filter", async () => {
    const all = await inventory("?limit=500");
    expect(all.page).toMatchObject({ limit: 500, offset: 0 });
    expect(all.page.total).toBe(all.credentials.length);
    expect(all.page.total).toBeGreaterThanOrEqual(4);
    const first = await inventory("?limit=2");
    expect(first.credentials).toHaveLength(2);
    expect(first.page).toEqual({ total: all.page.total, limit: 2, offset: 0 });
    const second = await inventory("?limit=2&offset=2");
    expect(second.credentials.map((c: any) => c.id)).toEqual(all.credentials.slice(2, 4).map((c: any) => c.id));
    // the whole-inventory counts are not paged
    expect(first.counts.total).toBe(all.counts.total);
    expect((await inventory()).page.limit).toBe(100);
    expect((await call("GET", "/v1/admin/credentials?limit=501", adminAuth)).statusCode).toBe(400);
    const none = await inventory("?limit=500&flag=none");
    expect(none.credentials.every((c: any) => c.flags.length === 0)).toBe(true);
  });

  it("observe-only computes no inventory: the monitor input is the explicit 'not alerting' input", async () => {
    await db.update(orgSettings).set({ staleCredentialAlerts: false });
    const counting = createDb(DATABASE_URL!);
    const client = (counting as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
    const seen: string[] = [];
    const original = client.query.bind(client);
    client.query = (...a: unknown[]) => {
      const q = a[0] as string | { text?: string };
      seen.push(typeof q === "string" ? q : (q?.text ?? ""));
      return original(...a);
    };
    try {
      const input = await staleCredentialsInput(counting, new Date());
      expect(input).toEqual({ alerting: false, credentials: [] });
      // one read of the org settings; nothing from any credential table or the ledger
      expect(seen.filter((s) => /usage_events|api_keys|virtual_keys|connector_credentials/.test(s))).toEqual([]);
      expect(seen.length).toBeLessThanOrEqual(2);
    } finally {
      await (counting as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    }
  });
});

describe("review fix 3 — a demo energy factor describes the mock provider, and nothing else", () => {
  it("is refused for a model id that any non-mock agent also uses", async () => {
    await mkAgent("mock", SHARED_MODEL);
    await mkAgent("openai", SHARED_MODEL.toUpperCase());
    const r = await putFactor({ kind: "model", subject: SHARED_MODEL, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "demo", version: "demo", demo: true });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "demo_factor_not_mock" });
    expect(r.json().detail).toMatch(/another provider/);
    expect(await db.select().from(energyFactors).where(sql`lower(${energyFactors.subject}) = lower(${SHARED_MODEL})`)).toEqual([]);
  });

  it("is applied only to calls a mock agent served, even when a real agent takes the model id later", async () => {
    const p = await call("POST", "/v1/projects", AUTH, { name: `g175r-project-${RUN}` });
    expect(p.statusCode, p.body).toBe(201);
    ids.project = p.json().id;
    const mock = await mkAgent("mock", DEMO_MODEL);
    const set = await putFactor({ kind: "model", subject: DEMO_MODEL, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "demo value", version: "demo", demo: true });
    expect(set.statusCode, set.body).toBe(201);
    // the bypass: a real provider's agent named after the demo model AFTER the factor was set
    const real = await mkAgent("openai", DEMO_MODEL);
    const row = (agentId: string, provider: string) => ({
      userId: ids.admin,
      objectType: "agent",
      agentId,
      provider,
      model: DEMO_MODEL,
      inputTokens: 1000,
      outputTokens: 0,
      projectId: ids.project,
    });
    await db.insert(usageEvents).values([row(mock, "mock"), row(mock, "mock"), row(real, "openai"), row(real, "openai"), row(real, "openai")]);
    const r = await call("GET", `/v1/energy/estimate?projectId=${ids.project}`, adminAuth);
    expect(r.statusCode, r.body).toBe(200);
    const e = r.json().estimate;
    expect(e).toMatchObject({ callsTotal: 5, callsEstimated: 2, energyWh: 2, coverage: "2 of 5 calls estimated", usesDemoFactors: true });
    expect(e.unknownModels).toEqual([DEMO_MODEL]);
    expect(e.byModel.find((m: any) => m.servedBy === "not_mock")).toMatchObject({ calls: 3, status: "no_factor", energyWh: null });
  });
});

/**
 * ADR-0175 D2 remainder (A7 credential inventory, A15 energy) — review fixes,
 * end to end. One `describe` per finding; each was proven red without its fix.
 *
 *  2. every inventory ledger read is windowed and matched to its credentials
 *     in SQL, on an index; the route pages; observe-only computes nothing.
 *  3. a demo energy factor is refused for a model any non-mock agent names,
 *     and the estimate applies one to mock-served calls only.
 *  4. the `energy_estimate_available` collector ignores demo factors.
 *  6. an insert that carries its own `*_set_at` (a restore, a re-import)
 *     keeps it; one without a stamp is stamped now.
 *  7. concurrent PUTs of one energy factor never 500, and each is audited
 *     with the row it replaced.
 *  8. a failing optional monitor input skips its one rule (open episodes
 *     untouched, audited) and every other rule still runs.
 *
 * Shared database (M-008, M-068): every row this file inserts is deleted in
 * afterAll, and the org settings it touches are restored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiRisks,
  and,
  auditLog,
  governanceAlerts,
  gte,
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
  scimTokens,
  sql,
  usageEvents,
  virtualKeys,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { encryptSecret } from "./secrets.js";
import { hashToken } from "./token-hash.js";
import { connectorLastUseQuery, virtualKeyLinkQuery } from "./credential-inventory.js";
import { runGovernanceMonitor, staleCredentialsInput } from "./governance-monitor.js";
import { runCollector } from "./compliance-packs.js";

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
const ids = { admin: "", connector: "", connectorCred: "", custom: "", customAgent: "", vk: "", otherVk: "", project: "", project4: "" };
/** scim tokens and connector credentials fix 6 inserts */
const restoredScim: string[] = [];
const restoredConnectorCreds: string[] = [];
const restoredConnectors: string[] = [];
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
let riskId = "";
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

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
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
  await restoreAdminKeyMfa?.();
  if (orgBefore) await db.update(orgSettings).set({ staleCredentialAlerts: orgBefore.alerts, credentialUnusedDays: orgBefore.unusedDays });
  await db.delete(usageEvents).where(eq(usageEvents.userId, ids.admin));
  await db.delete(connectorCredentials).where(eq(connectorCredentials.id, ids.connectorCred));
  if (restoredConnectorCreds.length) await db.delete(connectorCredentials).where(inArray(connectorCredentials.id, restoredConnectorCreds));
  if (restoredScim.length) await db.delete(scimTokens).where(inArray(scimTokens.id, restoredScim));
  if (restoredConnectors.length) await db.delete(connectors).where(inArray(connectors.id, restoredConnectors));
  await db.delete(connectors).where(eq(connectors.id, ids.connector));
  await db.delete(agents).where(eq(agents.id, ids.customAgent));
  await db.delete(customModelProviders).where(eq(customModelProviders.id, ids.custom));
  await db.delete(virtualKeys).where(inArray(virtualKeys.id, [ids.vk, ids.otherVk]));
  await db.delete(energyFactors).where(sql`${energyFactors.subject} ILIKE ${`g175r-%-${RUN}`}`);
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
  if (ids.project) await db.delete(projects).where(eq(projects.id, ids.project));
  if (ids.project4) await db.delete(projects).where(eq(projects.id, ids.project4));
  if (riskId) await db.delete(aiRisks).where(eq(aiRisks.id, riskId));
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
    // B4S round 3: the suite shares one database, and earlier files can leave more than one page of
    // credentials behind (≈650 API keys), so "total = this page's length" held only on a small DB. What
    // the total means: with no filter it is the whole inventory, a page holds min(limit, total − offset)
    // rows, and walking every page yields exactly `total` distinct rows, this file's among them.
    expect(all.page.total).toBe(all.counts.total);
    expect(all.credentials).toHaveLength(Math.min(500, all.page.total));
    const walked: string[] = [];
    for (let offset = 0; offset < all.page.total; offset += 500) {
      const page = await inventory(`?limit=500&offset=${offset}`);
      expect(page.page).toEqual({ total: all.page.total, limit: 500, offset });
      expect(page.credentials).toHaveLength(Math.min(500, all.page.total - offset));
      walked.push(...page.credentials.map((c: any) => c.id));
    }
    expect(walked).toHaveLength(all.page.total);
    expect(new Set(walked).size).toBe(all.page.total);
    expect((await inventory(`?limit=500&offset=${all.page.total}`)).credentials).toEqual([]);
    for (const own of [`connector_credential:${ids.connectorCred}`, `custom_provider_key:${ids.custom}`, `virtual_key:${ids.vk}`, `virtual_key:${ids.otherVk}`]) {
      expect(walked).toContain(own);
    }
    // a filtered total counts what the filter matched across every page, not the page
    const vks = await inventory("?limit=500&type=virtual_key");
    expect(vks.page.total).toBe(walked.filter((id) => id.startsWith("virtual_key:")).length);
    expect(vks.page.total).toBe(vks.types.find((t: any) => t.type === "virtual_key").count);
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

describe("review fix 4 — the energy_estimate_available collector is not evidenced by a demo factor", () => {
  it("counts calls covered by a real factor, and not calls covered only by a demo one", async () => {
    const demoModel = `g175r-demo4-${RUN}`;
    const realModel = `g175r-real4-${RUN}`;
    const p = await call("POST", "/v1/projects", AUTH, { name: `g175r-project4-${RUN}` });
    expect(p.statusCode, p.body).toBe(201);
    ids.project4 = p.json().id;
    const mock = await mkAgent("mock", demoModel);
    expect((await putFactor({ kind: "model", subject: demoModel, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "demo", version: "demo", demo: true })).statusCode).toBe(201);
    expect((await putFactor({ kind: "model", subject: realModel, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "synthetic real", version: "r1" })).statusCode).toBe(201);
    const row = (model: string, agentId: string | null) => ({
      userId: ids.admin,
      objectType: "agent",
      agentId,
      provider: "mock",
      model,
      inputTokens: 100,
      outputTokens: 100,
      projectId: ids.project4,
    });
    await db.insert(usageEvents).values([row(demoModel, mock), row(demoModel, mock), row(demoModel, mock), row(realModel, null)]);
    const ctx = {
      periodStart: new Date(Date.now() - DAY),
      periodEnd: new Date(Date.now() + 60_000),
      projectIds: [ids.project4],
      memberIds: [],
      params: {},
    };
    expect(await runCollector(db, "energy_estimate_available", ctx)).toBe(1);
  });
});

describe("review fix 6 — an insert keeps an explicit set date (restore, re-import)", () => {
  it("keeps a supplied *_set_at on insert, and stamps now() only when none is supplied", async () => {
    const restoredAt = new Date(Date.now() - 123 * DAY);
    const [kept] = await db
      .insert(scimTokens)
      .values({ name: `g175r-scim-restored-${RUN}`, tokenHash: hashToken(`g175r-scim-r-${RUN}`), secretSetAt: restoredAt })
      .returning({ id: scimTokens.id, at: scimTokens.secretSetAt });
    restoredScim.push(kept!.id);
    expect(kept!.at!.getTime()).toBe(restoredAt.getTime());
    const [fresh] = await db
      .insert(scimTokens)
      .values({ name: `g175r-scim-new-${RUN}`, tokenHash: hashToken(`g175r-scim-n-${RUN}`) })
      .returning({ id: scimTokens.id, at: scimTokens.secretSetAt });
    restoredScim.push(fresh!.id);
    expect(Date.now() - fresh!.at!.getTime()).toBeLessThan(60_000);
    // a ciphertext column the same way, and the inventory reports the restored age
    const [c2] = await db.insert(connectors).values({ name: `g175r-connector-restored-${RUN}`, kind: "mock" }).returning({ id: connectors.id });
    restoredConnectors.push(c2!.id);
    const [conn] = await db
      .insert(connectorCredentials)
      .values({ connectorId: c2!.id, tokenCiphertext: encryptSecret(KEY, `g175r-restored-${RUN}`), secretSetAt: restoredAt })
      .returning({ id: connectorCredentials.id, at: connectorCredentials.secretSetAt });
    restoredConnectorCreds.push(conn!.id);
    expect(conn!.at!.getTime()).toBe(restoredAt.getTime());
    const inv = await inventory("?limit=500&type=scim_token");
    expect(inv.credentials.find((c: any) => c.id === `scim_token:${kept!.id}`)).toMatchObject({ rotationSignal: "recorded", ageSinceRotationDays: 123 });
  });

  it("an update that changes the secret still stamps now(), even when it also writes a stamp", async () => {
    const [row] = await db
      .update(scimTokens)
      .set({ tokenHash: hashToken(`g175r-scim-rotated-${RUN}`), secretSetAt: new Date(Date.now() - 400 * DAY) })
      .where(eq(scimTokens.id, restoredScim[0]!))
      .returning({ at: scimTokens.secretSetAt });
    expect(Date.now() - row!.at!.getTime()).toBeLessThan(60_000);
  });
});

describe("review fix 7 — PUT /v1/energy/factors is an upsert", () => {
  it("concurrent writes of the same new factor never 500: one creates, the others update, each audited with before/after", async () => {
    // several subjects at once, each written by four requests in parallel, so a check-then-insert race would surface
    const subjects = Array.from({ length: 4 }, (_, i) => `g175r-race${i}-${RUN}`);
    const results = await Promise.all(
      subjects.flatMap((subject) =>
        [1, 2, 3, 4].map((v) =>
          putFactor({ kind: "model", subject: v % 2 ? subject : subject.toUpperCase(), whPer1kInput: v, whPer1kOutput: v, sourceNote: "race", version: `v${v}` }),
        ),
      ),
    );
    // never a 500, and never a refused write (a unique-violation 409) either
    expect(results.filter((r) => r.statusCode !== 200 && r.statusCode !== 201).map((r) => `${r.statusCode} ${r.body}`)).toEqual([]);
    for (const subject of subjects) {
      const rows = await db.select().from(energyFactors).where(sql`lower(${energyFactors.subject}) = lower(${subject})`);
      expect(rows).toHaveLength(1);
      const audits = await db
        .select({ ruleId: auditLog.ruleId, detail: auditLog.detail })
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "energy_factor"), eq(auditLog.objectId, rows[0]!.id)));
      expect(audits.map((a) => a.ruleId).sort()).toEqual(["energy-factor-created", "energy-factor-updated", "energy-factor-updated", "energy-factor-updated"]);
      for (const a of audits) {
        const d = a.detail as { before: { version: string } | null; after: { version: string } };
        expect(d.after.version).toMatch(/^v[1-4]$/);
        expect(d.before === null).toBe(a.ruleId === "energy-factor-created");
      }
    }
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(subjects.length);
  });
});

describe("review fix 8 — one failing optional monitor input does not stop the other rules", () => {
  it("leaves stale_credentials unevaluated (open episodes untouched), audits it, and still raises another rule's alert", async () => {
    await db.update(orgSettings).set({ staleCredentialAlerts: true });
    await runGovernanceMonitor(db, { actorUserId: ids.admin });
    const staleOpen = async () =>
      db
        .select({ id: governanceAlerts.id, last: governanceAlerts.lastDetectedAt, status: governanceAlerts.status })
        .from(governanceAlerts)
        .where(and(eq(governanceAlerts.ruleId, "stale_credentials"), sql`${governanceAlerts.status} <> 'resolved'`));
    const before = await staleOpen();
    expect(before.length).toBeGreaterThan(0);
    // a condition another rule raises, created after the last pass
    const [risk] = await db
      .insert(aiRisks)
      .values({ title: `g175r risk ${RUN}`, description: "s", category: "prompt_injection", ownerUserId: ids.admin, likelihood: "high", impact: "high" })
      .returning({ id: aiRisks.id });
    riskId = risk!.id;
    const since = new Date();
    const r = await runGovernanceMonitor(db, {
      actorUserId: ids.admin,
      now: new Date(Date.now() + 1000),
      optionalInputs: {
        credentials: async () => {
          throw new Error("injected inventory failure");
        },
      },
    });
    expect(r.notEvaluated).toEqual(["stale_credentials"]);
    // the stale-credential episodes were neither resolved nor refreshed
    const after = await staleOpen();
    expect(after.map((a) => [a.id, a.last.getTime()]).sort()).toEqual(before.map((a) => [a.id, a.last.getTime()]).sort());
    // another rule ran: the new high risk raised its alert in this same pass
    const riskAlert = await db
      .select({ status: governanceAlerts.status })
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "high_risk_without_control"), eq(governanceAlerts.subjectKey, `risk:${riskId}`)));
    expect(riskAlert.map((a) => a.status)).toEqual(["open"]);
    const audits = await db
      .select({ ruleId: auditLog.ruleId, detail: auditLog.detail, effect: auditLog.effect })
      .from(auditLog)
      .where(and(eq(auditLog.userId, ids.admin), eq(auditLog.objectType, "governance_monitor"), gte(auditLog.at, since)));
    expect(audits.find((a) => a.ruleId === "governance-monitor-input-failed")).toMatchObject({
      effect: "deny",
      detail: { ruleId: "stale_credentials", input: "credentials", error: "injected inventory failure" },
    });
    expect(audits.find((a) => a.ruleId === "governance-monitor-evaluated")?.detail).toMatchObject({ notEvaluated: ["stale_credentials"] });
    // the next healthy pass evaluates it again
    await db.update(orgSettings).set({ staleCredentialAlerts: orgBefore!.alerts });
    expect((await runGovernanceMonitor(db, { actorUserId: ids.admin, now: new Date(Date.now() + 2000) })).notEvaluated).toEqual([]);
  });
});

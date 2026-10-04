/**
 * ADR-0175 A15 — the energy and emissions estimate, end to end.
 *
 * Pinned:
 *  - no factor ships: a model with no factor is unknown, never zero, and the
 *    totals say "N of M calls estimated";
 *  - an admin-entered factor (with source and version) turns ledger tokens
 *    into Wh, and a grid intensity into gCO2e; the org's region overrides the
 *    default intensity;
 *  - a use case's estimate is its project's; a use case with no project says
 *    so; factor writes are audited; a demo factor is refused for a real model;
 *  - the `energy_estimate_available` pack collector counts the covered calls.
 *
 * Shared database: this file's usage rows, factors, project and use case are
 * deleted in afterAll and the org's energy region is restored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  createDb,
  energyFactors,
  eq,
  inArray,
  orgSettings,
  projects,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runCollector } from "./compliance-packs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g175e-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const MODEL_A = `g175e-model-a-${RUN}`;
const MODEL_B = `g175e-model-b-${RUN}`;
const MOCK_MODEL = `g175e-mock-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const ids = { admin: "", user: "", project: "", bare: "", useCase: "", orphanUseCase: "", mockAgent: "" };
const adminAuth = { authorization: "" };
const userAuth = { authorization: "" };
let regionBefore: string | null = null;

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const estimate = async (q: string) => {
  const r = await call("GET", `/v1/energy/estimate?${q}`, adminAuth);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const putFactor = (body: Record<string, unknown>) => call("PUT", "/v1/energy/factors", adminAuth, body);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const mk = async (tag: string, isAdmin: boolean) => {
    const u = await call("POST", "/v1/users", AUTH, { email: `g175e-${tag}-${RUN}@example.com`, displayName: `Energy ${tag} ${RUN}`, isAdmin });
    const id = u.json().id as string;
    const k = await call("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
    return { id, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  const a = await mk("admin", true);
  ids.admin = a.id;
  adminAuth.authorization = a.auth.authorization;
  const u = await mk("user", false);
  ids.user = u.id;
  userAuth.authorization = u.auth.authorization;
  const p = await call("POST", "/v1/projects", AUTH, { name: `g175e-project-${RUN}` });
  expect(p.statusCode, p.body).toBe(201);
  ids.project = p.json().id;
  const bare = await call("POST", "/v1/projects", AUTH, { name: `g175e-bare-${RUN}` });
  ids.bare = bare.json().id;
  const [uc] = await db
    .insert(aiUseCases)
    .values({ name: `g175e-uc-${RUN}`, description: "energy test", businessContext: "energy test", dataSensitivity: "internal", ownerUserId: ids.admin, projectId: ids.project })
    .returning({ id: aiUseCases.id });
  ids.useCase = uc!.id;
  const [orphan] = await db
    .insert(aiUseCases)
    .values({ name: `g175e-orphan-${RUN}`, description: "energy test", businessContext: "energy test", dataSensitivity: "internal", ownerUserId: ids.admin })
    .returning({ id: aiUseCases.id });
  ids.orphanUseCase = orphan!.id;
  const agent = await call("POST", "/v1/agents", AUTH, { name: `g175e-mock-${RUN}`, provider: "mock", tier: 1, model: MOCK_MODEL, costPerMTokIn: 1, costPerMTokOut: 2 });
  expect(agent.statusCode, agent.body).toBe(201);
  ids.mockAgent = agent.json().id;
  const row = (model: string | null, inputTokens: number | null, outputTokens: number | null) => ({
    userId: ids.admin,
    objectType: "agent",
    provider: "mock",
    model,
    inputTokens,
    outputTokens,
    projectId: ids.project,
  });
  await db.insert(usageEvents).values([
    row(MODEL_A, 2000, 1000),
    row(MODEL_A, 2000, 1000),
    row(MODEL_A, null, null), // tokens not recorded: cannot be estimated
    row(MODEL_B, 5000, 5000),
  ]);
  const [org] = await db.select({ region: orgSettings.energyRegion }).from(orgSettings);
  regionBefore = org!.region;
}, 120_000);

afterAll(async () => {
  await db.delete(usageEvents).where(inArray(usageEvents.projectId, [ids.project, ids.bare]));
  await db.delete(energyFactors).where(sql`${energyFactors.subject} ILIKE ${`g175e-%-${RUN}`}`);
  await db.delete(aiUseCases).where(inArray(aiUseCases.id, [ids.useCase, ids.orphanUseCase]));
  await db.update(orgSettings).set({ energyRegion: regionBefore });
  await db.update(agents).set({ enabled: false }).where(eq(agents.id, ids.mockAgent));
  await db.delete(projects).where(eq(projects.id, ids.bare));
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0175 A15 — the energy estimate", () => {
  it("with no factor, every call is unknown and the totals are null, never zero", async () => {
    const body = await estimate(`projectId=${ids.project}`);
    expect(body.scope).toMatchObject({ kind: "project", id: ids.project });
    expect(body.estimate).toMatchObject({ callsTotal: 4, callsEstimated: 0, energyWh: null, emissionsG: null, coverage: "0 of 4 calls estimated" });
    expect(body.estimate.unknownModels.sort()).toEqual([MODEL_A, MODEL_B].sort());
    expect(body.estimate.label).toMatch(/^Estimate/);
  });

  it("an admin-entered factor turns tokens into Wh; a grid intensity into gCO2e; the org region overrides the default", async () => {
    const f = await putFactor({ kind: "model", subject: MODEL_A.toUpperCase(), whPer1kInput: 0.5, whPer1kOutput: 1.5, sourceNote: "synthetic test factor", version: "t1" });
    expect(f.statusCode, f.body).toBe(201);
    let body = await estimate(`projectId=${ids.project}`);
    // 2 rows × (2 × 0.5 + 1 × 1.5) = 5 Wh; the token-less row and model B are unknown
    expect(body.estimate).toMatchObject({ callsEstimated: 2, callsTotal: 4, energyWh: 5, coverage: "2 of 4 calls estimated" });
    expect(body.estimate.unknownModels).toEqual([MODEL_B]);
    const a = body.estimate.byModel.find((m: any) => m.model === MODEL_A);
    expect(a).toMatchObject({ status: "estimated", factor: { sourceNote: "synthetic test factor", version: "t1" } });

    const gridSubject = `g175e-grid-${RUN}`;
    const regionSubject = `g175e-region-${RUN}`;
    // a default intensity may already exist in this shared database: this
    // file pins its own region so the arithmetic is its own
    expect((await putFactor({ kind: "grid", subject: gridSubject, gCo2ePerKwh: 400, sourceNote: "synthetic grid", version: "g1" })).statusCode).toBe(201);
    expect((await putFactor({ kind: "grid", subject: regionSubject, gCo2ePerKwh: 100, sourceNote: "synthetic region", version: "r1" })).statusCode).toBe(201);
    await db.update(orgSettings).set({ energyRegion: gridSubject });
    body = await estimate(`projectId=${ids.project}`);
    expect(body.estimate.emissionsG).toBe(2); // 0.005 kWh × 400
    expect(body.estimate.grid).toMatchObject({ subject: gridSubject, version: "g1" });
    await db.update(orgSettings).set({ energyRegion: regionSubject });
    body = await estimate(`projectId=${ids.project}`);
    expect(body.estimate.emissionsG).toBe(0.5); // 0.005 kWh × 100
    expect(body.estimate.grid).toMatchObject({ region: regionSubject, sourceNote: "synthetic region" });

    // an update is audited with its before/after
    const again = await putFactor({ kind: "model", subject: MODEL_A, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "synthetic test factor", version: "t2" });
    expect(again.statusCode, again.body).toBe(200);
    const audits = await db
      .select({ ruleId: auditLog.ruleId })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "energy_factor"), eq(auditLog.objectId, again.json().factor.id)));
    expect(audits.map((r) => r.ruleId).sort()).toEqual(["energy-factor-created", "energy-factor-updated"]);
    body = await estimate(`projectId=${ids.project}`);
    expect(body.estimate.energyWh).toBe(6); // 2 × (2 × 1 + 1 × 1)
  });

  it("a use case's estimate is its project's; a use case with no project says it is unknown", async () => {
    const uc = await estimate(`useCaseId=${ids.useCase}`);
    expect(uc.scope).toMatchObject({ kind: "use_case", id: ids.useCase, projectId: ids.project });
    expect(uc.estimate.callsTotal).toBe(4);
    const orphan = await estimate(`useCaseId=${ids.orphanUseCase}`);
    expect(orphan.estimate).toBeNull();
    expect(orphan.note).toMatch(/links no project/);
    const bare = await estimate(`projectId=${ids.bare}`);
    expect(bare.estimate).toMatchObject({ callsTotal: 0, energyWh: null });
  });

  it("refuses a demo factor for a model the mock provider does not serve, and labels one it does", async () => {
    const real = await putFactor({ kind: "model", subject: MODEL_B, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "s", version: "v", demo: true });
    expect(real.statusCode).toBe(422);
    expect(real.json().error).toBe("demo_factor_not_mock");
    const mock = await putFactor({ kind: "model", subject: MOCK_MODEL, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "demo value", version: "demo", demo: true });
    expect(mock.statusCode, mock.body).toBe(201);
    expect(mock.json().factor.demo).toBe(true);
    // a factor needs a source and a version
    expect((await putFactor({ kind: "model", subject: MODEL_B, whPer1kInput: 1, whPer1kOutput: 1, sourceNote: " ", version: "v" })).statusCode).toBe(400);
  });

  it("is admin-only", async () => {
    expect((await call("GET", `/v1/energy/estimate?projectId=${ids.project}`, userAuth)).statusCode).toBe(403);
    expect((await call("PUT", "/v1/energy/factors", userAuth, { kind: "grid", subject: "x", gCo2ePerKwh: 1, sourceNote: "s", version: "v" })).statusCode).toBe(403);
  });

  it("the energy_estimate_available collector counts the calls the estimate covers", async () => {
    const ctx = {
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 60_000),
      projectIds: [ids.project],
      memberIds: [],
      params: {},
    };
    // model A has a factor: its two rows with tokens count; the token-less row and model B do not
    expect(await runCollector(db, "energy_estimate_available", ctx)).toBe(2);
    const [b] = await db.select({ id: energyFactors.id }).from(energyFactors).where(sql`lower(${energyFactors.subject}) = lower(${MODEL_A})`);
    const del = await call("DELETE", `/v1/energy/factors/${b!.id}`, adminAuth);
    expect(del.statusCode, del.body).toBe(200);
    expect(await runCollector(db, "energy_estimate_available", ctx)).toBe(0);
    expect(await runCollector(db, "energy_estimate_available", { ...ctx, projectIds: [ids.bare] })).toBe(0);
  });
});

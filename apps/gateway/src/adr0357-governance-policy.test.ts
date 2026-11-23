/**
 * ADR-0357 §4 (slice 2): tighten-only policy inheritance, org → business unit → project → use case.
 *
 *  - a child layer that widens what it inherits is refused, naming each rule, and audited;
 *  - the effective view folds the chain root first and names the level that set each rule;
 *  - loosening a layer against its own previous self, removing a layer and moving a project to a looser parent are
 *    settings_relax step-ups (an admin API key is refused; exactly the grant for that change passes);
 *  - edits are compare-and-set on the layer's version.
 * Every row this file writes is its own; the org layer it sets is removed (and the earlier one restored) afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  auditLog,
  businessUnits,
  createDb,
  desc,
  eq,
  governancePolicyLayers,
  ORG_SETTINGS_ID,
  orgSettings,
  projects,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `gp-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const n = (s: string) => `gp-${s}-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let buId: string;
let projectId: string;
let useCaseId: string;
let savedOrgLayer: typeof governancePolicyLayers.$inferSelect | undefined;
const restores: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  // the org layer is a singleton: set it aside and put it back afterwards
  [savedOrgLayer] = await db.select().from(governancePolicyLayers).where(eq(governancePolicyLayers.level, "org"));
  if (savedOrgLayer) await db.delete(governancePolicyLayers).where(eq(governancePolicyLayers.id, savedOrgLayer.id));
  restores.push(async () => {
    await db.delete(governancePolicyLayers).where(eq(governancePolicyLayers.level, "org"));
    if (savedOrgLayer) await db.insert(governancePolicyLayers).values(savedOrgLayer);
  });
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();
  const [a] = await db.insert(users).values({ email: `${n("admin")}@example.test`, displayName: "admin", isAdmin: true }).returning({ id: users.id });
  adminId = a!.id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "gp-admin" } });
  expect(key.statusCode, key.body).toBe(201);
  adminKey = { authorization: `Bearer ${key.json().token}` };

  const bu = await app.inject({ method: "POST", url: "/v1/business-units", headers: AUTH, payload: { name: n("bu"), description: "payments" } });
  expect(bu.statusCode, bu.body).toBe(201);
  buId = bu.json().id;
  const [p] = await db.insert(projects).values({ name: n("project"), businessUnitId: buId }).returning({ id: projects.id });
  projectId = p!.id;
  const [uc] = await db
    .insert(aiUseCases)
    .values({ name: n("uc"), description: "use case", ownerUserId: adminId, businessContext: "context", dataSensitivity: "internal", projectId })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  await db.delete(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(businessUnits).where(eq(businessUnits.id, buId));
  await app.close();
});

type Auth = { headers?: Record<string, string>; cookies?: Record<string, string> };
const put = (payload: Record<string, unknown>, auth: Auth = { headers: AUTH }) => app.inject({ method: "PUT", url: "/v1/governance-policy/layer", ...auth, payload });
const effective = async (level: string, id?: string) => {
  const r = await app.inject({ method: "GET", url: `/v1/governance-policy/effective?level=${level}${id ? `&id=${id}` : ""}`, headers: AUTH });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { chain: Array<{ level: string; name: string | null }>; rules: Array<{ rule: string; value: unknown; setBy: { level: string; name: string | null } | null }> };
};
const rule = (e: Awaited<ReturnType<typeof effective>>, name: string) => e.rules.find((r) => r.rule === name)!;
const NOT_ENFORCED = { enforced: false, status: "not_enforced" };
const relaxGrant = (facts: Record<string, unknown>) => grantStepUpForTest(db, adminId, { kind: "settings_relax", facts });

describe("layers and the effective view", () => {
  it("builds a chain that only ever narrows, and the effective view names who set each rule", async () => {
    const orgWrite = await put({ level: "org", policy: { allowedAgents: ["a", "b", "c"], maxBudgetUsd: 1000, requirePlanGate: true } });
    expect(orgWrite.statusCode, orgWrite.body).toBe(200);
    expect(orgWrite.json().enforcement).toMatchObject(NOT_ENFORCED);
    expect((await put({ level: "business_unit", id: buId, policy: { allowedAgents: ["a", "b"] } })).statusCode).toBe(200);
    expect((await put({ level: "project", id: projectId, policy: { maxBudgetUsd: 500 } })).statusCode).toBe(200);
    expect((await put({ level: "use_case", id: useCaseId, policy: { allowedAgents: ["a"], piiMode: "block" } })).statusCode).toBe(200);

    const e = await effective("use_case", useCaseId);
    expect(e.chain.map((c) => c.level)).toEqual(["org", "business_unit", "project", "use_case"]);
    expect(rule(e, "allowedAgents")).toMatchObject({ value: ["a"], setBy: { level: "use_case", name: n("uc") } });
    expect(rule(e, "maxBudgetUsd")).toMatchObject({ value: 500, setBy: { level: "project", name: n("project") } });
    expect(rule(e, "requirePlanGate")).toMatchObject({ value: true, setBy: { level: "org" } });
    expect(rule(e, "piiMode")).toMatchObject({ value: "block", setBy: { level: "use_case" } });
    expect(rule(e, "minApprovers")).toMatchObject({ value: null, setBy: null });
    // the project sees its business unit's narrowing, not the use case's
    expect(rule(await effective("project", projectId), "allowedAgents")).toMatchObject({ value: ["a", "b"], setBy: { level: "business_unit", name: n("bu") } });
  });

  it("says on the layer and effective reads that stored policy is not yet enforced at call time (ADR-0180)", async () => {
    const layer = await app.inject({ method: "GET", url: "/v1/governance-policy/layer?level=org", headers: AUTH });
    expect(layer.statusCode, layer.body).toBe(200);
    expect(layer.json()).toMatchObject({ layer: { version: 1 }, enforcement: NOT_ENFORCED });
    const project = await app.inject({ method: "GET", url: `/v1/governance-policy/layer?level=project&id=${projectId}`, headers: AUTH });
    expect(project.json()).toMatchObject({ layer: { policy: { maxBudgetUsd: 500 } }, enforcement: NOT_ENFORCED });
    expect(((await effective("use_case", useCaseId)) as unknown as { enforcement: unknown }).enforcement).toMatchObject(NOT_ENFORCED);
  });

  it("a child that widens its parent is refused, naming each rule, and audited", async () => {
    const r = await put({ level: "project", id: projectId, policy: { maxBudgetUsd: 2000, allowedAgents: ["a", "z"] }, expectedVersion: 1 });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ error: "policy_widens_parent" });
    expect(r.json().widenings.map((w: { rule: string }) => w.rule).sort()).toEqual(["allowedAgents", "maxBudgetUsd"]);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "governance_policy"), eq(auditLog.ruleId, "governance_policy.layer"), eq(auditLog.effect, "deny")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row?.detail).toMatchObject({ level: "project", error: "policy_widens_parent" });
    expect((await db.select().from(governancePolicyLayers).where(eq(governancePolicyLayers.projectId, projectId)))[0]!.policy).toEqual({ maxBudgetUsd: 500 });
  });

  it("refuses an id on the org level, a missing subject, a create over an existing layer and a stale version", async () => {
    expect((await put({ level: "org", id: projectId, policy: {} })).statusCode).toBe(400);
    expect((await put({ level: "project", id: "00000000-0000-4000-8000-00000000beef", policy: {} })).statusCode).toBe(404);
    expect((await put({ level: "project", id: projectId, policy: { maxBudgetUsd: 400 } })).json()).toMatchObject({ error: "layer_exists", version: 1 });
    expect((await put({ level: "project", id: projectId, policy: { maxBudgetUsd: 400 }, expectedVersion: 7 })).json()).toMatchObject({ error: "version_conflict", version: 1 });
    expect((await put({ level: "project", id: projectId, policy: { unknownRule: 1 }, expectedVersion: 1 })).statusCode).toBe(400);
  });

  it("tightening a layer needs no step-up; loosening it does, bound to exactly what loosens", async () => {
    const tighter = await put({ level: "project", id: projectId, policy: { maxBudgetUsd: 400 }, expectedVersion: 1 }, { headers: adminKey });
    expect(tighter.statusCode, tighter.body).toBe(200);

    const looser = { level: "project", id: projectId, policy: { maxBudgetUsd: 800 }, expectedVersion: 2 };
    const byKey = await put(looser, { headers: adminKey });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const wrong = await relaxGrant({ op: "governance_policy_layer", level: "project", id: projectId, values: { maxBudgetUsd: 900 } });
    expect([403, 422]).toContain((await put(looser, stepUpRequest(wrong))).statusCode);
    const right = await relaxGrant({ op: "governance_policy_layer", level: "project", id: projectId, values: { maxBudgetUsd: 800 } });
    const ok = await put(looser, stepUpRequest(right));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await grantSpent(db, right.grantId)).toBe(true);
    expect(rule(await effective("project", projectId), "maxBudgetUsd")).toMatchObject({ value: 800, setBy: { level: "project" } });
  });
});

describe("moving a project, and removing a layer", () => {
  it("moving a project out of a narrower unit loosens its policy: a step-up bound to the move", async () => {
    const url = `/v1/projects/${projectId}/business-unit`;
    const byKey = await app.inject({ method: "PUT", url, headers: adminKey, payload: { businessUnitId: null } });
    expect(byKey.statusCode, byKey.body).toBe(403);
    const g = await relaxGrant({ op: "project_business_unit", projectId, from: buId, to: null, values: { allowedAgents: ["a", "b", "c"] } });
    const r = await app.inject({ method: "PUT", url, ...stepUpRequest(g), payload: { businessUnitId: null } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ changed: true, relaxed: ["allowedAgents"] });
    expect(rule(await effective("project", projectId), "allowedAgents")).toMatchObject({ value: ["a", "b", "c"], setBy: { level: "org" } });

    // moving back under the unit only narrows: no step-up
    const back = await app.inject({ method: "PUT", url, headers: adminKey, payload: { businessUnitId: buId } });
    expect(back.statusCode, back.body).toBe(200);
    expect(rule(await effective("project", projectId), "allowedAgents")).toMatchObject({ value: ["a", "b"] });
  });

  it("removing a layer is a step-up for every rule it set", async () => {
    const del = (auth: Auth) => app.inject({ method: "DELETE", url: `/v1/governance-policy/layer?level=use_case&id=${useCaseId}&expectedVersion=1`, ...auth });
    expect((await del({ headers: adminKey })).statusCode).toBe(403);
    const g = await relaxGrant({ op: "governance_policy_layer_delete", level: "use_case", id: useCaseId, values: { allowedAgents: null, piiMode: null } });
    const r = await del(stepUpRequest(g));
    expect(r.statusCode, r.body).toBe(200);
    expect(rule(await effective("use_case", useCaseId), "allowedAgents")).toMatchObject({ value: ["a", "b"], setBy: { level: "business_unit" } });
  });

  it("business units: a duplicate name is refused; the list pages", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/business-units", headers: AUTH, payload: { name: n("bu") } })).statusCode).toBe(409);
    const list = await app.inject({ method: "GET", url: "/v1/business-units?limit=1", headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.json().businessUnits).toHaveLength(1);
  });
});

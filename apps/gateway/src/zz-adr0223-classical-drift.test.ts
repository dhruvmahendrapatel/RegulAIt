/**
 * ADR-0223 (P13b) — classical-model drift and explainability, end to end at the gateway edge.
 *
 *  - Off by default: with no settings row every write is refused (409) and reads still answer.
 *  - Turning it on, loosening a threshold, and deleting evidence each need a step-up: refused from a browser session
 *    without a grant, accepted with a grant bound to the same facts. Other writes use an admin API key, as a pipeline
 *    would.
 *  - A drift summary opens a `classical_model_drift` episode on governance_alerts in the same transaction as the
 *    report and the audit rows; the ADR-0157 monitor pass resolves it once a later summary is within thresholds,
 *    and resolves every open episode when the feature is turned off.
 *  - Aggregates only: a label that looks like personal data is refused by category; sizes are bounded.
 *  - The per-monitor hourly cap is enforced in the database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  governanceAlerts,
  inArray,
  modelCards,
  modelDriftReports,
  modelDriftSettings,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { MODEL_DRIFT_AUDIT_RULE_IDS } from "./classical-drift.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0223-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

const RUN = Date.now();
let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
/** an admin's API key: a header credential, as a customer's pipeline would use */
let KEY: { authorization: string };
const restores: Array<() => Promise<void>> = [];
/** a browser session with no step-up grant: a relaxation from it is refused */
const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
/** a browser session holding a step-up grant bound to exactly these facts */
const asSteppedUp = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
let agentId: string;
let cardId: string;
let monitorId: string;

const reference = [
  { name: "income", kind: "numeric", edges: [0, 10, 20, 30], counts: [300, 400, 300] },
  { name: "region", kind: "categorical", categories: ["north", "south"], counts: [500, 500] },
];
const within = {
  windowStart: "2026-10-01T00:00:00Z",
  windowEnd: "2026-10-02T00:00:00Z",
  features: [
    { name: "income", kind: "numeric", edges: [0, 10, 20, 30], counts: [310, 390, 300] },
    { name: "region", kind: "categorical", categories: ["north", "south"], counts: [505, 495] },
  ],
};
const drifted = {
  ...within,
  features: [
    { name: "income", kind: "numeric", edges: [0, 10, 20, 30], counts: [50, 150, 800] },
    { name: "region", kind: "categorical", categories: ["north", "south"], counts: [500, 500] },
  ],
};

const put = (payload: object): Promise<LightMyRequestResponse> => app.inject({ method: "PUT", url: "/v1/model-drift/settings", headers: KEY, payload });
const report = (payload: object, monitor = monitorId): Promise<LightMyRequestResponse> =>
  app.inject({ method: "POST", url: `/v1/model-drift/monitors/${monitor}/reports`, headers: KEY, payload });
const openDriftAlerts = () =>
  db
    .select()
    .from(governanceAlerts)
    .where(and(eq(governanceAlerts.ruleId, "classical_model_drift"), inArray(governanceAlerts.status, ["open", "acknowledged"])));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  await db.delete(modelDriftSettings);
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0223-admin-${RUN}@example.com`, displayName: "drift admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0223" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `adr0223-scorer-${Date.now()}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  const [card] = await db.insert(modelCards).values({ agentId, intendedUse: "credit pre-screening (classical scorecard)" }).returning();
  cardId = card!.id;
});

afterAll(async () => {
  await db.delete(modelDriftSettings);
  await db.delete(governanceAlerts).where(eq(governanceAlerts.ruleId, "classical_model_drift"));
  if (cardId) await db.delete(modelCards).where(eq(modelCards.id, cardId));
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0223 classical-model drift", () => {
  it("is off by default: writes are refused, reads answer", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/model-drift/settings", headers: KEY });
    expect(s.statusCode).toBe(200);
    expect(s.json().settings.enabled).toBe(false);
    const m = await app.inject({ method: "POST", url: `/v1/mrm/cards/${cardId}/drift-monitors`, headers: KEY, payload: { name: "m", reference } });
    expect(m.statusCode).toBe(409);
    expect(m.json().error).toBe("model_drift_disabled");
    const x = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/explainability`,
      headers: KEY,
      payload: { kind: "global_importance", method: "permutation", importances: [{ feature: "income", value: 0.4 }] },
    });
    expect(x.statusCode).toBe(409);
    const v = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}/drift`, headers: KEY });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ settings: { enabled: false }, monitors: [], artefacts: [] });
  });

  it("turning it on is a step-up, and the change is audited", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/model-drift/settings", ...(await asSession()), payload: { enabled: true } });
    // refused either way: 403 when the admin has a method to step up with, 422 when none is enrolled yet
    expect([403, 422], refused.body).toContain(refused.statusCode);
    expect(refused.json().error).toMatch(/^step_up_/);
    expect((await app.inject({ method: "GET", url: "/v1/model-drift/settings", headers: KEY })).json().settings.enabled).toBe(false);
    const ok = await app.inject({
      method: "PUT",
      url: "/v1/model-drift/settings",
      ...(await asSteppedUp({ modelDrift: "settings", values: { enabled: true } })),
      payload: { enabled: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.enabled).toBe(true);
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, MODEL_DRIFT_AUDIT_RULE_IDS.settings));
    expect(rows.some((r) => (r.detail as { relaxed?: string[] }).relaxed?.includes("enabled"))).toBe(true);
    // tightening needs no step-up
    expect((await put({ maxReportsPerHour: 4 })).statusCode).toBe(200);
  });

  it("registers a monitor with strict thresholds; a looser one needs a step-up", async () => {
    const loose = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/drift-monitors`,
      ...(await asSession()),
      payload: { name: "loose", reference, thresholds: { psiAlert: 0.5 } },
    });
    expect([403, 422], loose.body).toContain(loose.statusCode);
    expect(loose.json().error).toMatch(/^step_up_/);
    const res = await app.inject({ method: "POST", url: `/v1/mrm/cards/${cardId}/drift-monitors`, headers: KEY, payload: { name: "applicants", reference } });
    expect(res.statusCode).toBe(201);
    const m = res.json().monitor;
    monitorId = m.id;
    expect(m.thresholds).toEqual({ psiWarn: 0.1, psiAlert: 0.25, ksAlert: 0.1, jsAlert: 0.05 });
    expect(m.referenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.features).toEqual([
      { name: "income", kind: "numeric", bins: 3 },
      { name: "region", kind: "categorical", categories: 2 },
    ]);
    const dupe = await app.inject({ method: "POST", url: `/v1/mrm/cards/${cardId}/drift-monitors`, headers: KEY, payload: { name: "applicants", reference } });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error).toBe("monitor_name_taken");
    const badOrder = await app.inject({ method: "PATCH", url: `/v1/model-drift/monitors/${monitorId}`, headers: KEY, payload: { thresholds: { psiWarn: 0.2, psiAlert: 0.15 } } });
    expect(badOrder.statusCode).toBe(422);
  });

  it("refuses personal data and malformed summaries before anything is written", async () => {
    const pii = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/drift-monitors`,
      headers: KEY,
      payload: { name: "pii", reference: [{ name: "customer", kind: "categorical", categories: ["someone@regulait.example"], counts: [5] }] },
    });
    expect(pii.statusCode).toBe(422);
    expect(pii.json()).toMatchObject({ error: "personal_data_refused", categories: ["email"] });
    expect(JSON.stringify(pii.json())).not.toContain("someone@");
    const bins = await report({ ...within, features: [{ ...within.features[0], edges: [0, 5, 20, 30] }, within.features[1]] });
    expect(bins.statusCode, bins.body).toBe(422);
    expect(bins.json().error).toBe("bins_mismatch");
    const missing = await report({ ...within, features: [within.features[0]] });
    expect(missing.json().error).toBe("feature_missing");
    const future = await report({ ...within, windowEnd: "2999-01-01T00:00:00Z" });
    expect(future.json().error).toBe("window_future");
    const big = await app.inject({
      method: "POST",
      url: `/v1/model-drift/monitors/${monitorId}/reports`,
      headers: { ...KEY, "content-type": "application/json" },
      payload: JSON.stringify({ ...within, padding: "x".repeat(600 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
    expect(await db.select().from(modelDriftReports).where(eq(modelDriftReports.monitorId, monitorId))).toHaveLength(0);
  });

  it("a summary within thresholds is recorded with its statistics and raises nothing", async () => {
    const res = await report(within);
    expect(res.statusCode).toBe(201);
    const r = res.json().report;
    expect(r.status).toBe("within");
    expect(r.results.map((x: { feature: string }) => x.feature)).toEqual(["income", "region"]);
    expect(r.results[1].ksD).toBeNull();
    expect(res.json().alertRaised).toBe(false);
    expect(await openDriftAlerts()).toHaveLength(0);
  });

  it("drift opens one episode on governance alerts in the same transaction; the monitor pass resolves it", async () => {
    const res = await report(drifted);
    expect(res.statusCode).toBe(201);
    expect(res.json().report.status).toBe("drift");
    expect(res.json().alertRaised).toBe(true);
    let open = await openDriftAlerts();
    expect(open).toHaveLength(1);
    expect(open[0]!.subjectKey).toBe(`agent:${agentId}>model_card:${cardId}>model_drift_monitor:${monitorId}`);
    expect(open[0]!.severity).toBe("high");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "governance_alert"), eq(auditLog.objectId, open[0]!.id)));
    expect(audit).toHaveLength(1);

    // a second drift summary refreshes the same episode rather than opening another
    expect((await report(drifted)).json().alertRaised).toBe(false);
    expect(await openDriftAlerts()).toHaveLength(1);

    // the monitor keeps it open while the latest summary drifts…
    await runGovernanceMonitor(db);
    expect(await openDriftAlerts()).toHaveLength(1);
    // …and resolves it once a later summary is back within thresholds
    expect((await report(within)).statusCode).toBe(201);
    await runGovernanceMonitor(db);
    open = await openDriftAlerts();
    expect(open).toHaveLength(0);
  });

  it("caps summaries per monitor per hour", async () => {
    // the cap is 4 (set above) and four summaries are already recorded this hour
    const res = await report(within);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("drift_report_rate_limited");
    const page = await app.inject({ method: "GET", url: `/v1/model-drift/monitors/${monitorId}/reports?limit=2`, headers: KEY });
    expect(page.json().reports).toHaveLength(2);
    expect(page.json().nextBefore).not.toBeNull();
  });

  it("records explainability evidence on the card, and deleting it is a step-up", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/explainability`,
      headers: KEY,
      payload: { kind: "shap_summary", method: "mean absolute SHAP value", importances: [{ feature: "income", value: 0.41 }, { feature: "region", value: 0.07 }] },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().artefact.id as string;
    const view = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}/drift`, headers: KEY });
    expect(view.json().artefacts).toHaveLength(1);
    expect(view.json().monitors[0].latestReport.status).toBe("within");
    const u = `/v1/mrm/cards/${cardId}/explainability/${id}`;
    const refused = await app.inject({ method: "DELETE", url: u, ...(await asSession()) });
    expect(refused.json().error).toMatch(/^step_up_/);
    const del = await app.inject({ method: "DELETE", url: u, ...(await asSteppedUp({ modelExplainabilityArtefactId: id, values: { deleted: true } })) });
    expect(del.statusCode, del.body).toBe(200);
  });

  it("turning it off resolves an open episode on the next monitor pass", async () => {
    await put({ maxReportsPerHour: 3 });
    await db.delete(modelDriftReports).where(eq(modelDriftReports.monitorId, monitorId));
    expect((await report(drifted)).json().alertRaised).toBe(true);
    expect(await openDriftAlerts()).toHaveLength(1);
    expect((await put({ enabled: false })).statusCode).toBe(200);
    await runGovernanceMonitor(db);
    expect(await openDriftAlerts()).toHaveLength(0);
    expect((await report(within)).statusCode).toBe(409);
  });
});

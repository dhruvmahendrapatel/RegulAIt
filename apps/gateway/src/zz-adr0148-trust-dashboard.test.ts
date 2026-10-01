/**
 * ADR-0148 — the trust dashboard (`GET /v1/reports/trust`).
 *
 * The claims under test, each one a way the dashboard could lie:
 *  - axis order is fixed and complete, and `measured` / `evidenceCoveragePct`
 *    are consistent: an axis with no applicable control is a GAP (null), never
 *    a 0% and never a 100%;
 *  - activating a pack moves coverage for the dimensions its controls speak to
 *    (positive control for the gap rule above);
 *  - "mitigated" means closed, or linked control + declared residual —
 *    an accepted risk is NOT mitigated, and a control link alone is not enough;
 *  - the heatmap counts live risks by declared inherent position, and the
 *    residual heatmap moves a risk only when a residual is declared.
 *
 * Risk assertions are scoped to a project this file creates, so sibling suites'
 * risks cannot change the counts (M-008, M-040). Pack activation is org-global,
 * so pack assertions are relative (before/after), never absolute.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, compliancePacks, createDb, eq, modelCards, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0148-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin = { id: "", auth: { authorization: "" } };
let projectId = "";

const call = (method: "GET" | "POST" | "PUT", url: string, headers = AUTH, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

type Dashboard = {
  dimensions: Array<{
    key: string; measured: boolean; evidenceCoveragePct: number | null;
    controlsApplicable: number; controlsEvidenced: number;
    risks: Record<string, number>;
  }>;
  totals: { risksFound: number; risksMitigated: number; risksAccepted: number; risksOpen: number };
  heatmap: Array<{ likelihood: string; impact: string; count: number }>;
  residualHeatmap: Array<{ likelihood: string; impact: string; count: number }>;
};
const dashboard = async (): Promise<Dashboard> => {
  const r = await call("GET", `/v1/reports/trust?projectId=${projectId}`, admin.auth);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const cell = (grid: Dashboard["heatmap"], l: string, i: string) =>
  grid.find((c) => c.likelihood === l && c.impact === i)!.count;

async function risk(category: string, likelihood: string, impact: string) {
  const r = await call("POST", "/v1/risks", admin.auth, {
    title: `adr0148 ${category} ${RUN}`, description: "synthetic", category, likelihood, impact, projectId,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await call("POST", "/v1/users", AUTH, { email: `adr0148-${RUN}@example.com`, displayName: "A", isAdmin: true });
  admin.id = u.json().id;
  admin.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${admin.id}/keys`, AUTH, { name: "k" })).json().token}` };
  const p = await call("POST", "/v1/projects", AUTH, { name: `adr0148-${RUN}` });
  expect(p.statusCode).toBe(201);
  projectId = p.json().id;
  expect((await call("POST", "/v1/compliance/packs/seed", AUTH, {})).statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("shape and the gap rule", () => {
  it("returns six axes in fixed order; unmeasured axes are null, never 0 or 100", async () => {
    const d = await dashboard();
    expect(d.dimensions.map((x) => x.key)).toEqual(["bias", "security", "privacy", "reliability", "safety", "compliance"]);
    for (const x of d.dimensions) {
      expect(x.measured).toBe(x.controlsApplicable > 0);
      if (!x.measured) expect(x.evidenceCoveragePct).toBeNull();
      else expect(x.evidenceCoveragePct).toBeGreaterThanOrEqual(0);
    }
  });

  it("activating a pack makes its dimensions measured — and bias stays a gap (no default control evidences it)", async () => {
    const before = await dashboard();
    // v1 explicitly: v2 (ADR-0150) adds a bias control, tested below
    const [pack] = await db
      .select()
      .from(compliancePacks)
      .where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.version, 1)));
    expect(pack).toBeDefined();
    // Activation through the route is licence-gated (ADR-0052) and that gate
    // is not this file's subject, so the row is set active directly — the
    // dashboard reads `status = 'active'`, which is all this test needs.
    await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, pack!.id));
    const after = await dashboard();
    const applicable = (d: Dashboard, k: string) => d.dimensions.find((x) => x.key === k)!.controlsApplicable;
    // the EU AI Act pack has record-keeping/oversight (compliance) and
    // accuracy (reliability) controls — both axes must now be measured
    expect(applicable(after, "compliance")).toBeGreaterThan(0);
    expect(applicable(after, "reliability")).toBeGreaterThan(0);
    expect(applicable(after, "compliance")).toBeGreaterThanOrEqual(applicable(before, "compliance"));
    const bias = after.dimensions.find((x) => x.key === "bias")!;
    expect(bias.measured).toBe(false);
    expect(bias.evidenceCoveragePct).toBeNull();
  });

  it("ADR-0150: the v2 pack makes bias measured — and only a DOCUMENTED assessment evidences it", async () => {
    const [v1] = await db.select().from(compliancePacks).where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.version, 1)));
    const [v2] = await db.select().from(compliancePacks).where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.version, 2)));
    expect(v2).toBeDefined();
    // one active version per framework — mirror what activation does
    await db.update(compliancePacks).set({ status: "retired" }).where(eq(compliancePacks.id, v1!.id));
    await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, v2!.id));
    try {
      const measured = (await dashboard()).dimensions.find((x) => x.key === "bias")!;
      expect(measured.measured).toBe(true);
      expect(measured.controlsApplicable).toBeGreaterThanOrEqual(1);
      const evidencedBefore = measured.controlsEvidenced;

      // a card with an assessment still IN PROGRESS is not evidence…
      const a = await call("POST", "/v1/agents", AUTH, { name: `adr0148-fair-${RUN}`, provider: "mock", tier: 1, modes: ["chat"], model: "m" });
      const agentId = a.json().id as string;
      await db.insert(modelCards).values({
        agentId, intendedUse: `fairness probe ${RUN}`,
        biasFairness: [{ dimension: "sex", method: "demographic parity", status: "in_progress" }],
      });
      const pending = (await dashboard()).dimensions.find((x) => x.key === "bias")!;
      // (org-wide collector: another suite may already have documented one, so
      // the claim is "this card did not move it", not an absolute zero)
      expect(pending.controlsEvidenced).toBe(evidencedBefore);

      // …a completed, documented one is
      await db.update(modelCards).set({
        biasFairness: [{ dimension: "sex", method: "demographic parity", status: "assessed", resultRef: "eval-run-1" }],
      }).where(eq(modelCards.agentId, agentId));
      const done = (await dashboard()).dimensions.find((x) => x.key === "bias")!;
      expect(done.controlsEvidenced).toBe(done.controlsApplicable);
      expect(done.evidenceCoveragePct).toBe(100);
    } finally {
      await db.update(compliancePacks).set({ status: "retired" }).where(eq(compliancePacks.id, v2!.id));
      await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, v1!.id));
    }
  });

  it("is admin-only and refuses an unknown project", async () => {
    const u = await call("POST", "/v1/users", AUTH, { email: `adr0148-member-${RUN}@example.com`, displayName: "M" });
    const key = (await call("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" })).json().token;
    expect((await call("GET", "/v1/reports/trust", { authorization: `Bearer ${key}` })).statusCode).toBe(403);
    expect((await call("GET", "/v1/reports/trust?projectId=00000000-0000-0000-0000-000000000000", admin.auth)).statusCode).toBe(404);
  });
});

describe("risks found vs mitigated, and the heatmaps", () => {
  it("counts mitigation honestly and moves the residual heatmap only on a declared residual", async () => {
    const empty = await dashboard();
    expect(empty.totals.risksFound).toBe(0); // project-scoped: nothing yet

    const linkedOnly = await risk("prompt_injection", "high", "high");
    const mitigatedRisk = await risk("data_leakage_pii", "high", "high");
    const acceptedRisk = await risk("bias_fairness", "medium", "high");
    const closedRisk = await risk("hallucination", "low", "medium");

    const control = "eu-ai-act:art-14-human-oversight";
    expect((await call("POST", `/v1/risks/${linkedOnly}/controls`, admin.auth, { controlRef: control })).statusCode).toBe(201);
    expect((await call("POST", `/v1/risks/${mitigatedRisk}/controls`, admin.auth, { controlRef: control })).statusCode).toBe(201);
    expect((await call("PUT", `/v1/risks/${mitigatedRisk}/residual`, admin.auth, { likelihood: "low", impact: "medium" })).statusCode).toBe(200);
    expect((await call("POST", `/v1/risks/${acceptedRisk}/accept`, admin.auth, { note: "carried knowingly" })).statusCode).toBe(200);
    expect((await call("POST", `/v1/risks/${closedRisk}/transition`, admin.auth, { status: "closed", reason: "retired model" })).statusCode).toBe(200);

    const d = await dashboard();
    expect(d.totals.risksFound).toBe(4);
    // closed + (linked AND residual). The link-only risk is NOT mitigated, and
    // the accepted one is counted as accepted, never as mitigated.
    expect(d.totals.risksMitigated).toBe(2);
    expect(d.totals.risksAccepted).toBe(1);
    expect(d.totals.risksOpen).toBe(2);

    const byKey = Object.fromEntries(d.dimensions.map((x) => [x.key, x.risks]));
    expect(byKey.security!.open).toBe(1);
    expect(byKey.privacy!.open).toBe(1);
    expect(byKey.bias!.accepted).toBe(1);
    expect(byKey.reliability!.closed).toBe(1);

    // inherent heatmap: live risks only (the closed one is excluded)
    expect(cell(d.heatmap, "high", "high")).toBe(2);
    expect(cell(d.heatmap, "medium", "high")).toBe(1);
    expect(cell(d.heatmap, "low", "medium")).toBe(0);
    // residual heatmap: only the risk with a declared residual moves
    expect(cell(d.residualHeatmap, "high", "high")).toBe(1);
    expect(cell(d.residualHeatmap, "low", "medium")).toBe(1);
  });
});

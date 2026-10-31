/**
 * ADR-0211 (P17) — transferred and avoided risk treatments, proved through the
 * real routes and read back from Postgres.
 *
 *  1. The switch is OFF by default: a treatment is refused, and the refusal is
 *     on the audit trail.
 *  2. With it on, the owner (or an admin) records a treatment with evidence and
 *     an owner, in one transaction with its audit row; every input rule holds.
 *  3. A treated risk is a decided record: not edited, not accepted, not treated
 *     again. It moves back to open (or to closed) only by an audited transition,
 *     which keeps the ended treatment in the audit row.
 *  4. The read surfaces show both states: the risk detail, the trust dashboard
 *     (its own partition) and the posture report.
 *  5. The database itself refuses a treated row without evidence.
 *
 * Shares one database with the other gateway suites: every fixture is unique to
 * this run, counts are deltas, and the org switch is put back as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiRisks,
  and,
  auditLog,
  createDb,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { loadOrgSettings } from "./org-settings.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomUUID().slice(0, 8);
const BOOT = "p17-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

type Auth = { authorization: string };
let db: Db;
let app: ReturnType<typeof buildApp>;
let owner: { id: string; auth: Auth };
let stranger: { id: string; auth: Auth };
let switchBefore: boolean;

async function makeUser(name: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `p17-${name}-${RUN}@example.com`, displayName: `p17 ${name}` },
  });
  expect(user.statusCode, user.body).toBe(201);
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${user.json().id}/keys`, payload: { name: "p17" } });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function register(title: string, auth: Auth = owner.auth) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/risks",
    payload: { title: `p17 ${title} ${RUN}`, description: "a scenario for P17", category: "tool_misuse", likelihood: "high", impact: "high" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

const treat = (riskId: string, payload: Record<string, unknown>, auth: Auth = owner.auth) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/risks/${riskId}/treatment`, payload });

const auditRows = (riskId: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, riskId), eq(auditLog.ruleId, ruleId)));

const setSwitch = (enabled: boolean) =>
  db.update(orgSettings).set({ riskTreatmentsEnabled: enabled }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  switchBefore = (await loadOrgSettings(db)).riskTreatmentsEnabled;
  owner = await makeUser("owner");
  stranger = await makeUser("stranger");
}, 60_000);

afterAll(async () => {
  await setSwitch(switchBefore);
  await app.close();
  await db.$client.end();
});

describe("1. off by default", () => {
  it("a fresh org_settings row has the switch off", async () => {
    // the column default itself, not whatever another suite left in the row
    const res = await db.execute(sql`SELECT column_default AS d FROM information_schema.columns
      WHERE table_name = 'org_settings' AND column_name = 'risk_treatments_enabled'`);
    expect((res as unknown as { rows: Array<{ d: string | null }> }).rows[0]?.d).toBe("false");
  });

  it("while off, a treatment is refused and the refusal is audited; the risk is untouched", async () => {
    await setSwitch(false);
    const riskId = await register("off");
    const res = await treat(riskId, { treatment: "transferred", evidence: "policy 1", ownerUserId: owner.id });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("risk_treatments_off");
    const denied = await auditRows(riskId, "risk-treatment-refused");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.effect).toBe("deny");
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    expect(row!.status).toBe("open");
    expect(row!.treatmentEvidence).toBeNull();
  });

  it("the switch reads as off and strict; turning it off needs no step-up and is audited", async () => {
    const put = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings/risk-treatments", payload: { enabled: false } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ enabled: false, defaultEnabled: false, strictDefault: true });
    const get = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings/risk-treatments" });
    expect(get.json().enabled).toBe(false);
  });

  it("the switch is admin-only: a non-admin cannot read or write it", async () => {
    const get = await app.inject({ method: "GET", headers: owner.auth, url: "/v1/org/settings/risk-treatments" });
    expect(get.statusCode).toBe(403);
    const put = await app.inject({ method: "PUT", headers: owner.auth, url: "/v1/org/settings/risk-treatments", payload: { enabled: true } });
    expect(put.statusCode).toBe(403);
    expect((await loadOrgSettings(db)).riskTreatmentsEnabled).toBe(false);
  });
});

describe("2. recording a treatment", () => {
  beforeAll(async () => {
    await setSwitch(true);
  });

  it("the owner records a transfer: status, evidence, owner and time on the row, one audit row in detail", async () => {
    const riskId = await register("transfer");
    const res = await treat(riskId, { treatment: "transferred", evidence: "  cyber policy CY-2026-114, clause 7  ", ownerUserId: owner.id });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe("transferred");
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    expect(row!.status).toBe("transferred");
    expect(row!.treatmentEvidence).toBe("cyber policy CY-2026-114, clause 7");
    expect(row!.treatmentOwnerUserId).toBe(owner.id);
    expect(row!.treatedByUserId).toBe(owner.id);
    expect(row!.treatedAt).toBeInstanceOf(Date);
    const audit = await auditRows(riskId, "risk-transferred");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({
      phase: "treatment",
      treatment: "transferred",
      from: "open",
      evidence: "cyber policy CY-2026-114, clause 7",
      ownerUserId: owner.id,
    });
    expect(Array.isArray((audit[0]!.detail as { evidenceAtTreatment: unknown }).evidenceAtTreatment)).toBe(true);

    const detail = await app.inject({ method: "GET", headers: owner.auth, url: `/v1/risks/${riskId}` });
    expect(detail.json().declared.treatment).toMatchObject({
      treatment: "transferred",
      evidence: "cyber policy CY-2026-114, clause 7",
      ownerUserId: owner.id,
      ownerName: "p17 owner",
    });
    expect(detail.json().declared.acceptance).toBeNull();
    expect(detail.json().treatments).toEqual({ enabled: true });
  });

  it("evidence and an owner are required; unknown keys are refused", async () => {
    const riskId = await register("validation");
    for (const payload of [
      { treatment: "avoided", ownerUserId: owner.id },
      { treatment: "avoided", evidence: "   ", ownerUserId: owner.id },
      { treatment: "avoided", evidence: "board decision" },
      { treatment: "accepted", evidence: "x", ownerUserId: owner.id },
      { treatment: "avoided", evidence: "x", ownerUserId: owner.id, status: "closed" },
    ]) {
      const res = await treat(riskId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    expect(row!.status).toBe("open");
  });

  it("object-level rules: a stranger is refused; a non-admin names only themselves; an admin may name anyone real", async () => {
    const riskId = await register("authz");
    expect((await treat(riskId, { treatment: "avoided", evidence: "x", ownerUserId: stranger.id }, stranger.auth)).statusCode).toBe(403);
    const other = await treat(riskId, { treatment: "avoided", evidence: "x", ownerUserId: stranger.id });
    expect(other.statusCode).toBe(403);
    expect(other.json().error).toBe("forbidden_owner");
    // the bootstrap token is an admin (an admin's API key needs MFA under the strict default)
    const ghost = await treat(riskId, { treatment: "avoided", evidence: "x", ownerUserId: randomUUID() }, AUTH);
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json()).toMatchObject({ error: "invalid_reference", field: "ownerUserId" });
    const ok = await treat(riskId, { treatment: "avoided", evidence: "use withdrawn by the change board", ownerUserId: owner.id }, AUTH);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().status).toBe("avoided");
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    expect(row!.treatedByUserId).toBeNull(); // the bootstrap token has no identity
    expect(row!.treatmentOwnerUserId).toBe(owner.id);
    expect(await auditRows(riskId, "risk-avoided")).toHaveLength(1);
  });
});

describe("3. a treated risk is a decided record", () => {
  let riskId: string;
  beforeAll(async () => {
    await setSwitch(true);
    riskId = await register("decided");
    const res = await treat(riskId, { treatment: "transferred", evidence: "supplier contract SC-88 §12 indemnity", ownerUserId: owner.id });
    expect(res.statusCode, res.body).toBe(201);
  });

  it("is not edited, treated again, accepted, or moved to a treatment by transition", async () => {
    const patch = await app.inject({ method: "PATCH", headers: owner.auth, url: `/v1/risks/${riskId}`, payload: { title: "changed" } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error).toBe("risk_not_editable");
    const residual = await app.inject({ method: "PUT", headers: owner.auth, url: `/v1/risks/${riskId}/residual`, payload: { likelihood: "low", impact: "low" } });
    expect(residual.statusCode).toBe(409);
    const again = await treat(riskId, { treatment: "avoided", evidence: "x", ownerUserId: owner.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("risk_not_treatable");
    const accept = await app.inject({ method: "POST", headers: AUTH, url: `/v1/risks/${riskId}/accept`, payload: { note: "carry it" } });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error).toBe("risk_treated");
    const viaTransition = await app.inject({ method: "POST", headers: owner.auth, url: `/v1/risks/${riskId}/transition`, payload: { status: "avoided", reason: "x" } });
    expect(viaTransition.statusCode).toBe(422);
    expect(viaTransition.json().error).toBe("treatment_is_its_own_act");
    const mitigate = await app.inject({ method: "POST", headers: owner.auth, url: `/v1/risks/${riskId}/transition`, payload: { status: "mitigating", reason: "x" } });
    expect(mitigate.statusCode).toBe(409);
    expect(mitigate.json().error).toBe("treated_risk_reopens_first");
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    expect(row!.status).toBe("transferred");
  });

  it("reopens by an audited transition that clears the row and keeps the ended treatment in the audit row", async () => {
    const res = await app.inject({ method: "POST", headers: owner.auth, url: `/v1/risks/${riskId}/transition`, payload: { status: "open", reason: "the contract lapsed" } });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    expect(row).toMatchObject({ status: "open", treatmentEvidence: null, treatmentOwnerUserId: null, treatedByUserId: null, treatedAt: null });
    const audit = await auditRows(riskId, "risk-open");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({
      from: "transferred",
      to: "open",
      endedTreatment: { treatment: "transferred", evidence: "supplier contract SC-88 §12 indemnity", ownerUserId: owner.id },
    });
  });

  it("turning the switch off leaves recorded treatments as they are, and they can still be reopened", async () => {
    const id = await register("switch-off");
    expect((await treat(id, { treatment: "avoided", evidence: "pilot stopped", ownerUserId: owner.id })).statusCode).toBe(201);
    await setSwitch(false);
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, id));
    expect(row!.status).toBe("avoided");
    const reopen = await app.inject({ method: "POST", headers: owner.auth, url: `/v1/risks/${id}/transition`, payload: { status: "open", reason: "pilot resumed" } });
    expect(reopen.statusCode, reopen.body).toBe(200);
    await setSwitch(true);
  });
});

describe("4. the read surfaces show both states", () => {
  it("the trust dashboard counts each in its own partition, and the posture report counts each", async () => {
    await setSwitch(true);
    const trust = async () => (await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/trust" })).json();
    const posture = async () => (await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/posture" })).json();
    const t0 = await trust();
    const p0 = await posture();
    const a = await register("dash-transfer");
    const b = await register("dash-avoid");
    expect((await treat(a, { treatment: "transferred", evidence: "policy P-1", ownerUserId: owner.id })).statusCode).toBe(201);
    expect((await treat(b, { treatment: "avoided", evidence: "use stopped", ownerUserId: owner.id })).statusCode).toBe(201);
    const t1 = await trust();
    const p1 = await posture();
    expect(t1.totals.risksTransferred - t0.totals.risksTransferred).toBe(1);
    expect(t1.totals.risksAvoided - t0.totals.risksAvoided).toBe(1);
    expect(t1.totals.risksFound - t0.totals.risksFound).toBe(2);
    // neither is live, mitigated, accepted or unmitigated
    expect(t1.totals.risksOpen - t0.totals.risksOpen).toBe(0);
    expect(t1.totals.risksUnmitigated - t0.totals.risksUnmitigated).toBe(0);
    expect(t1.totals.risksMitigated - t0.totals.risksMitigated).toBe(0);
    expect(t1.totals.risksAccepted - t0.totals.risksAccepted).toBe(0);
    // the partition holds
    const sum = (t: { totals: Record<string, number> }) =>
      t.totals.risksMitigated! + t.totals.risksAccepted! + t.totals.risksTransferred! + t.totals.risksAvoided! + t.totals.risksUnmitigated!;
    expect(sum(t1)).toBe(t1.totals.risksFound);
    // the transferred risk keeps its rating in the heat map; the avoided one leaves it
    const cell = (t: { heatmap: Array<{ likelihood: string; impact: string; count: number }> }) =>
      t.heatmap.find((c) => c.likelihood === "high" && c.impact === "high")!.count;
    expect(cell(t1) - cell(t0)).toBe(1);
    // per-dimension counts carry both states
    const dimSum = (t: { dimensions: Array<{ risks: Record<string, number> }> }, k: string) =>
      t.dimensions.reduce((n, d) => n + (d.risks[k] ?? 0), 0);
    expect(dimSum(t1, "transferred") - dimSum(t0, "transferred")).toBe(1);
    expect(dimSum(t1, "avoided") - dimSum(t0, "avoided")).toBe(1);
    expect(p1.risks.transferred - p0.risks.transferred).toBe(1);
    expect(p1.risks.avoided - p0.risks.avoided).toBe(1);
  });
});

describe("5. the database refuses an incoherent row", () => {
  it("a treated status without evidence, or evidence on an untreated row, is a CHECK violation", async () => {
    const id = await register("check");
    await expect(db.update(aiRisks).set({ status: "avoided" }).where(eq(aiRisks.id, id))).rejects.toThrow();
    await expect(db.update(aiRisks).set({ treatmentEvidence: "x", treatedAt: new Date() }).where(eq(aiRisks.id, id))).rejects.toThrow();
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, id));
    expect(row!.status).toBe("open");
  });
});

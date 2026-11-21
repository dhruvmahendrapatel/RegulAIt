/**
 * ADR-0366 slice 1 — rogue-agent containment, end to end (real database).
 *
 *  - the secure default: `containment_auto_severity` is 'critical'; 'off' is a settings_relax step-up, lowering the
 *    threshold is free; the containment approver must be an active admin;
 *  - a critical signal (a builder agent declared `assist` observed `autonomous`) halts the agent at once, audited
 *    as automatic; every turn of the halted agent is refused; the same alert never files twice;
 *  - a non-critical signal (registry-agent model drift) files a proposal in the Approvals Queue for the named admin;
 *    the agent's steward cannot decide it; approval halts the agent through ADR-0124's halt; decline leaves it running;
 *  - with no approver named, a proposal is recorded unrouted and audited; unregistered traffic files nothing;
 *  - release: admin only, a reason and a settings_relax step-up; refused while the execution dial is not normal;
 *    it lifts only a halt a containment set, and only when no other containment still holds the agent.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentContainments,
  agents,
  and,
  approvals,
  auditLog,
  builderAgents,
  createDb,
  eq,
  governanceAlerts,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { CONTAINMENT_RULE_IDS, containRaisedAlerts } from "./rogue-containment.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `a366-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`a366-data-key-${RUN}`).digest("hex");

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let approverId: string;
let stewardId: string;
const restores: Array<() => Promise<unknown>> = [];
const alertIds: string[] = [];
const builderIds: string[] = [];
const agentIds: string[] = [];

type Method = "GET" | "POST" | "PUT";
async function as(who: string, args: StepUpCheckArgs | null, method: Method, url: string, payload?: unknown) {
  const g = await grantStepUpForTest(db, who, args ?? { kind: "settings_relax", facts: { unused: RUN } });
  const r = args ? stepUpRequest(g) : sessionRequest(g);
  return app.inject({ method, url, headers: r.headers, cookies: r.cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
}
const releaseStep = (id: string): StepUpCheckArgs => ({ kind: "settings_relax", facts: { containmentId: id, values: { released: true } } });
const setPolicy = (p: { containmentAutoSeverity?: "off" | "low" | "medium" | "high" | "critical"; containmentApproverUserId?: string | null }) =>
  db.update(orgSettings).set(p).where(eq(orgSettings.id, ORG_SETTINGS_ID));

async function builderAgent(label: string, ownerUserId = stewardId) {
  const [b] = await db
    .insert(builderAgents)
    .values({ name: `a366-${label}-${RUN}`, ownerUserId, connectionFormat: "shared" })
    .returning({ id: builderAgents.id, name: builderAgents.name });
  builderIds.push(b!.id);
  return b!;
}
async function registryAgent(label: string) {
  const [a] = await db
    .insert(agents)
    .values({ name: `a366-${label}-${RUN}`, provider: "mock", tier: 1, ownerUserId: stewardId })
    .returning({ id: agents.id });
  agentIds.push(a!.id);
  return a!.id;
}
async function alert(ruleId: string, subjectKey: string, severity: "low" | "medium" | "high", detail: Record<string, unknown>) {
  const now = new Date();
  const [row] = await db
    .insert(governanceAlerts)
    .values({ ruleId, subjectKey: `${subjectKey}:${RUN}:${alertIds.length}`, severity, title: `a366 ${ruleId}`, detail, firstDetectedAt: now, lastDetectedAt: now })
    .returning({ id: governanceAlerts.id });
  alertIds.push(row!.id);
  return row!.id;
}
const autonomyAlert = (agentId: string, declared: string, observed: string) =>
  alert("autonomy_declared_below_observed", `builder_agent:${agentId}`, "medium", { agentId, agentName: "x", declared, observed, reasons: [] });
const containmentOf = async (alertId: string) =>
  (await db.select().from(agentContainments).where(eq(agentContainments.signalRefId, alertId)))[0];
const auditFor = async (objectId: string) =>
  db.select({ ruleId: auditLog.ruleId, userId: auditLog.userId, detail: auditLog.detail }).from(auditLog).where(eq(auditLog.objectId, objectId));
const chat = (builderAgentId: string) => as(adminId, null, "POST", `/v1/builder/agents/${builderAgentId}/chat`, { message: "hello" });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [o0] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(() =>
    db
      .update(orgSettings)
      .set({
        stepUpMode: o0!.stepUpMode,
        stepUpActions: o0!.stepUpActions,
        executionMode: o0!.executionMode,
        executionModeReason: o0!.executionModeReason,
        containmentAutoSeverity: o0!.containmentAutoSeverity,
        containmentApproverUserId: o0!.containmentApproverUserId,
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID)),
  );
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const ids: string[] = [];
  for (const who of ["admin", "approver", "steward"]) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `a366-${who}-${RUN}@example.com`, displayName: `a366 ${who}` } });
    expect(u.statusCode, u.body).toBe(201);
    await db.update(users).set({ isAdmin: who !== "steward", totpEnabled: true }).where(eq(users.id, u.json().id));
    ids.push(u.json().id);
  }
  [adminId, approverId, stewardId] = ids as [string, string, string];
}, 120_000);

afterAll(async () => {
  if (db) {
    const rows = await db.select({ approvalId: agentContainments.approvalId }).from(agentContainments).where(inArray(agentContainments.signalRefId, alertIds.length ? alertIds : ["-"]));
    await db.delete(agentContainments).where(inArray(agentContainments.signalRefId, alertIds.length ? alertIds : ["-"]));
    const apIds = rows.map((r) => r.approvalId).filter((x): x is string => !!x);
    if (apIds.length) await db.delete(approvals).where(inArray(approvals.id, apIds));
    if (alertIds.length) await db.delete(governanceAlerts).where(inArray(governanceAlerts.id, alertIds));
    if (builderIds.length) await db.delete(builderAgents).where(inArray(builderAgents.id, builderIds));
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
    for (const id of [adminId, approverId, stewardId]) if (id) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, id));
    for (const r of restores.reverse()) await r();
  }
  await app?.close();
});

describe("ADR-0366: the containment policy", () => {
  it("ships automatic containment on for critical signals (ADR-0180)", async () => {
    // the column default, read from the catalogue: a fresh install starts at 'critical'
    const res = await db.execute<{ d: string }>(
      sql`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'org_settings' AND column_name = 'containment_auto_severity'`,
    );
    const col = res.rows[0];
    expect(String(col!.d)).toContain("critical");
  });

  it("turning it off is a settings_relax step-up; lowering the threshold is free; the approver must be an active admin", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: null });
    const free = await as(adminId, null, "PUT", "/v1/org/settings", { containmentAutoSeverity: "high" });
    expect(free.statusCode, free.body).toBe(200);
    const raiseBack = await as(adminId, null, "PUT", "/v1/org/settings", { containmentAutoSeverity: "critical" });
    expect(raiseBack.statusCode, raiseBack.body).toBe(403);
    const off = await as(adminId, null, "PUT", "/v1/org/settings", { containmentAutoSeverity: "off" });
    expect(off.statusCode, off.body).toBe(403);
    const notAdmin = await as(adminId, null, "PUT", "/v1/org/settings", { containmentApproverUserId: stewardId });
    expect(notAdmin.statusCode, notAdmin.body).toBe(422);
    expect(notAdmin.json().error).toBe("containment_approver_not_admin");
    const ok = await as(adminId, null, "PUT", "/v1/org/settings", { containmentApproverUserId: approverId });
    expect(ok.statusCode, ok.body).toBe(200);
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
  });
});

describe("ADR-0366: automatic containment at or above the threshold", () => {
  it("halts a builder agent declared assist and observed autonomous at once, audited, and refuses its turns", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const b = await builderAgent("crit");
    const before = await chat(b.id);
    expect(before.json().error).not.toBe("builder_agent_halted");
    const alertId = await autonomyAlert(b.id, "assist", "autonomous");
    const r = await containRaisedAlerts(db, [alertId]);
    expect(r).toMatchObject({ autoContained: 1, proposed: 0 });
    const c = (await containmentOf(alertId))!;
    expect(c).toMatchObject({ status: "contained", automatic: true, severity: "critical", haltApplied: true, approvalId: null, builderAgentId: b.id });
    const [row] = await db.select().from(builderAgents).where(eq(builderAgents.id, b.id));
    expect(row!.haltedAt).not.toBeNull();
    expect(row!.haltedReason).toMatch(/^contained \(ADR-0366\): /);
    expect((await auditFor(c.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.autoContained);
    expect((await auditFor(b.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.builderAgentHalted);
    const refused = await chat(b.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("builder_agent_halted");
    // the same episode never files twice
    expect(await containRaisedAlerts(db, [alertId])).toMatchObject({ autoContained: 0, skipped: 1 });
  });

  it("the monitor pass itself contains: a raised autonomy episode halts the agent before the pass returns", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const b = await builderAgent("monitor");
    const subjectKey = `builder_agent:${b.id}`;
    const pass = await runGovernanceMonitor(db, {
      optionalInputs: {
        autonomy: async () => ({
          autonomy_declared_below_observed: {
            breaches: [{ subjectKey, title: "a366 monitor", detail: { agentId: b.id, agentName: b.name, declared: "assist", observed: "autonomous", reasons: [] } }],
          },
        }),
      },
    });
    expect(pass.raised).toBeGreaterThanOrEqual(1);
    const [episode] = await db
      .select({ id: governanceAlerts.id })
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "autonomy_declared_below_observed"), eq(governanceAlerts.subjectKey, subjectKey)));
    alertIds.push(episode!.id);
    expect((await containmentOf(episode!.id))!).toMatchObject({ status: "contained", automatic: true, severity: "critical" });
    const [row] = await db.select({ haltedAt: builderAgents.haltedAt }).from(builderAgents).where(eq(builderAgents.id, b.id));
    expect(row!.haltedAt).not.toBeNull();
  }, 120_000);

  it("files a proposal, not a halt, when the threshold is off", async () => {
    await setPolicy({ containmentAutoSeverity: "off" });
    const b = await builderAgent("off");
    const alertId = await autonomyAlert(b.id, "assist", "autonomous");
    expect(await containRaisedAlerts(db, [alertId])).toMatchObject({ autoContained: 0, proposed: 1 });
    const [row] = await db.select().from(builderAgents).where(eq(builderAgents.id, b.id));
    expect(row!.haltedAt).toBeNull();
    await setPolicy({ containmentAutoSeverity: "critical" });
  });
});

describe("ADR-0366: containment proposals in the Approvals Queue", () => {
  it("routes a non-critical signal to the named admin; the steward cannot decide; approval halts the agent", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const agentId = await registryAgent("drift");
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId, cardId: "c", monitorId: "m", reportId: "r", features: [] });
    expect(await containRaisedAlerts(db, [alertId])).toMatchObject({ proposed: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c).toMatchObject({ status: "proposed", automatic: false, severity: "high" });
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, c.approvalId!));
    expect(ap).toMatchObject({ objectType: "agent_containment", approverUserId: approverId, userId: stewardId, status: "pending" });
    const [a0] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(a0!.haltedAt).toBeNull();

    const queue = await as(approverId, null, "GET", "/v1/approvals");
    expect(queue.statusCode, queue.body).toBe(200);
    const listed = (queue.json().approvals ?? queue.json()) as Array<{ id: string; objectLabel?: string | null }>;
    expect(listed.find((x) => x.id === ap!.id)?.objectLabel ?? "").toMatch(/^contain \(halt\), high: /);

    const bySteward = await as(stewardId, null, "POST", `/v1/approvals/${ap!.id}/decide`, { decision: "approved" });
    expect(bySteward.statusCode).toBe(403);
    const ok = await as(approverId, null, "POST", `/v1/approvals/${ap!.id}/decide`, { decision: "approved" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await containmentOf(alertId))!).toMatchObject({ status: "contained", haltApplied: true, decidedByUserId: approverId });
    const [a1] = await db.select({ haltedAt: agents.haltedAt, reason: agents.haltedReason }).from(agents).where(eq(agents.id, agentId));
    expect(a1!.haltedAt).not.toBeNull();
    expect(a1!.reason).toMatch(/^contained \(ADR-0366\): /);
    expect((await auditFor(c.id)).map((a) => a.ruleId)).toEqual(expect.arrayContaining([CONTAINMENT_RULE_IDS.proposed, CONTAINMENT_RULE_IDS.approved]));
  });

  it("a declined proposal leaves the agent running", async () => {
    const agentId = await registryAgent("decline");
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId, cardId: "c", monitorId: "m" });
    await containRaisedAlerts(db, [alertId]);
    const c = (await containmentOf(alertId))!;
    const d = await as(approverId, null, "POST", `/v1/approvals/${c.approvalId!}/decide`, { decision: "denied" });
    expect(d.statusCode, d.body).toBe(200);
    expect((await containmentOf(alertId))!.status).toBe("declined");
    const [a] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(a!.haltedAt).toBeNull();
  });

  it("with no approver named the proposal is recorded unrouted and audited; unregistered traffic files nothing", async () => {
    await setPolicy({ containmentApproverUserId: null });
    const agentId = await registryAgent("unrouted");
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId });
    expect(await containRaisedAlerts(db, [alertId])).toMatchObject({ unrouted: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c).toMatchObject({ status: "proposed", approvalId: null });
    expect((await auditFor(c.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.unrouted);
    const traffic = await alert("unregistered_ai_traffic", `project:${agentId}`, "medium", { subjectType: "project" });
    expect(await containRaisedAlerts(db, [traffic])).toEqual({ autoContained: 0, proposed: 0, unrouted: 0, skipped: 0 });
    expect(await containmentOf(traffic)).toBeUndefined();
    await setPolicy({ containmentApproverUserId: approverId });
  });
});

describe("ADR-0366: release", () => {
  it("needs a reason and a step-up, is refused while the dial is not normal, and lifts only a containment's halt", async () => {
    await setPolicy({ containmentAutoSeverity: "critical" });
    const b = await builderAgent("release");
    const first = await autonomyAlert(b.id, "assist", "autonomous");
    const second = await autonomyAlert(b.id, "assist", "autonomous");
    await containRaisedAlerts(db, [first, second]);
    const c1 = (await containmentOf(first))!;
    const c2 = (await containmentOf(second))!;
    expect(c1.haltApplied).toBe(true);
    expect(c2.haltApplied).toBe(false); // already halted by the first
    const reason = { reason: `a366 reviewed, safe to resume ${RUN}` };

    const noStep = await as(adminId, null, "POST", `/v1/containments/${c1.id}/release`, reason);
    expect(noStep.statusCode).toBe(403);
    const short = await as(adminId, releaseStep(c1.id), "POST", `/v1/containments/${c1.id}/release`, { reason: "ok" });
    expect(short.statusCode).toBe(400);
    const notAdmin = await as(stewardId, releaseStep(c1.id), "POST", `/v1/containments/${c1.id}/release`, reason);
    expect(notAdmin.statusCode).toBe(403);

    await db.update(orgSettings).set({ executionMode: "read_only", executionModeReason: `a366 read only ${RUN}` }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const dial = await as(adminId, releaseStep(c1.id), "POST", `/v1/containments/${c1.id}/release`, reason);
    expect(dial.statusCode, dial.body).toBe(409);
    expect(dial.json().error).toBe("execution_dial_not_normal");
    await db.update(orgSettings).set({ executionMode: "normal", executionModeReason: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

    // the second containment still holds the agent: the halt stays
    const r1 = await as(adminId, releaseStep(c1.id), "POST", `/v1/containments/${c1.id}/release`, reason);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json()).toMatchObject({ haltLifted: false, containment: { status: "released" } });
    expect((await chat(b.id)).json().error).toBe("builder_agent_halted");
    const again = await as(adminId, releaseStep(c1.id), "POST", `/v1/containments/${c1.id}/release`, reason);
    expect(again.statusCode).toBe(409);

    const r2 = await as(adminId, releaseStep(c2.id), "POST", `/v1/containments/${c2.id}/release`, reason);
    expect(r2.statusCode, r2.body).toBe(200);
    expect(r2.json().haltLifted).toBe(true);
    const [row] = await db.select().from(builderAgents).where(eq(builderAgents.id, b.id));
    expect(row!.haltedAt).toBeNull();
    expect((await chat(b.id)).json().error).not.toBe("builder_agent_halted");
    expect((await auditFor(c2.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.released);
  });

  it("never lifts a halt a person threw by hand", async () => {
    const agentId = await registryAgent("manual");
    await db.update(agents).set({ haltedAt: new Date(), haltedReason: `a366 manual incident halt ${RUN}`, haltedByUserId: adminId }).where(eq(agents.id, agentId));
    await setPolicy({ containmentAutoSeverity: "high" });
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId });
    expect(await containRaisedAlerts(db, [alertId])).toMatchObject({ autoContained: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c.haltApplied).toBe(false);
    const r = await as(adminId, releaseStep(c.id), "POST", `/v1/containments/${c.id}/release`, { reason: `a366 reviewed ${RUN}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().haltLifted).toBe(false);
    const [a] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(a!.haltedAt).not.toBeNull();
    await setPolicy({ containmentAutoSeverity: "critical" });
  });

  it("lists and reads containments with their lifecycle (admin only)", async () => {
    const list = await as(adminId, null, "GET", "/v1/containments?limit=2");
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().containments.length).toBeLessThanOrEqual(2);
    if (list.json().next) {
      const page2 = await as(adminId, null, "GET", `/v1/containments?limit=2&before=${encodeURIComponent(list.json().next)}`);
      expect(page2.statusCode).toBe(200);
      const seen = new Set(list.json().containments.map((c: { id: string }) => c.id));
      for (const c of page2.json().containments) expect(seen.has(c.id)).toBe(false);
    }
    const id = list.json().containments[0].id as string;
    const one = await as(adminId, null, "GET", `/v1/containments/${id}`);
    expect(one.json().lifecycle).toMatchObject({ machine: "agent_containment" });
    const steward = await as(stewardId, null, "GET", "/v1/containments");
    expect(steward.statusCode).toBe(403);
  });
});

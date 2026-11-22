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
  virtualKeys,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { CONTAINMENT_RULE_IDS, containAlerts, containOpenSignals, containmentDecideStepUp, containmentReleaseRequestStepUp } from "./rogue-containment.js";
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
const keyIds: string[] = [];

type Method = "GET" | "POST" | "PUT";
async function as(who: string, args: StepUpCheckArgs | null, method: Method, url: string, payload?: unknown) {
  const g = await grantStepUpForTest(db, who, args ?? { kind: "settings_relax", facts: { unused: RUN } });
  const r = args ? stepUpRequest(g) : sessionRequest(g);
  return app.inject({ method, url, headers: r.headers, cookies: r.cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
}
const releaseStep = (id: string): StepUpCheckArgs => containmentReleaseRequestStepUp(id);
/** decide a containment approval as `who`: with the MFA step-up bound to it (or none / a wrong one), and a reason
 * (needed when `who` is not the addressed approver: the admin override) */
async function decide(approvalId: string, decision: "approved" | "denied", who: string, grant: "right" | "none" | "wrong" = "right") {
  const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  const g = await grantStepUpForTest(db, who, containmentDecideStepUp(approvalId, decision, grant === "wrong" ? "0".repeat(64) : ap!.argumentsDigest!));
  const r = grant === "none" ? sessionRequest(g) : stepUpRequest(g);
  return app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: r.headers, cookies: r.cookies, payload: { decision, reason: `a366 decided ${RUN}` } });
}
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
    const rows = await db
      .select({ approvalId: agentContainments.approvalId, releaseApprovalId: agentContainments.releaseApprovalId })
      .from(agentContainments)
      .where(inArray(agentContainments.signalRefId, alertIds.length ? alertIds : ["-"]));
    await db.delete(agentContainments).where(inArray(agentContainments.signalRefId, alertIds.length ? alertIds : ["-"]));
    const apIds = rows.flatMap((r) => [r.approvalId, r.releaseApprovalId]).filter((x): x is string => !!x);
    if (apIds.length) await db.delete(approvals).where(inArray(approvals.id, apIds));
    if (alertIds.length) await db.delete(governanceAlerts).where(inArray(governanceAlerts.id, alertIds));
    if (builderIds.length) await db.delete(builderAgents).where(inArray(builderAgents.id, builderIds));
    if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds));
    if (keyIds.length) await db.delete(virtualKeys).where(inArray(virtualKeys.id, keyIds));
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
    const r = await containAlerts(db, [alertId]);
    expect(r).toMatchObject({ autoContained: 1, proposed: 0, failed: 0 });
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
    expect(await containAlerts(db, [alertId])).toMatchObject({ autoContained: 0, skipped: 1 });
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
    expect(await containAlerts(db, [alertId])).toMatchObject({ autoContained: 0, proposed: 1 });
    const [row] = await db.select().from(builderAgents).where(eq(builderAgents.id, b.id));
    expect(row!.haltedAt).toBeNull();
    await setPolicy({ containmentAutoSeverity: "critical" });
  });
});

describe("ADR-0366: the automatic path is fail-closed (owner decision 2026-11-21)", () => {
  it("an open signal episode that was never filed (a missed or failed pass) is filed on the next pass", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const b = await builderAgent("retry");
    const alertId = await autonomyAlert(b.id, "assist", "autonomous");
    expect(await containmentOf(alertId)).toBeUndefined(); // raised, never filed
    const pass = await containOpenSignals(db);
    expect(pass.autoContained).toBeGreaterThanOrEqual(1);
    expect((await containmentOf(alertId))!).toMatchObject({ status: "contained", automatic: true, approvalId: null });
    // a resolved episode is never filed late
    const b2 = await builderAgent("resolved");
    const resolved = await autonomyAlert(b2.id, "assist", "autonomous");
    await db.update(governanceAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(governanceAlerts.id, resolved));
    await containOpenSignals(db);
    expect(await containmentOf(resolved)).toBeUndefined();
  });
});

describe("ADR-0366: containment proposals in the Approvals Queue", () => {
  it("routes a non-critical signal to the named admin; the steward cannot decide; an MFA step-up is required; approval halts", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const agentId = await registryAgent("drift");
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId, cardId: "c", monitorId: "m", reportId: "r", features: [] });
    expect(await containAlerts(db, [alertId])).toMatchObject({ proposed: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c).toMatchObject({ status: "proposed", automatic: false, severity: "high" });
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, c.approvalId!));
    expect(ap).toMatchObject({ objectType: "agent_containment", approverUserId: approverId, userId: stewardId, status: "pending" });
    expect(ap!.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    const [a0] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(a0!.haltedAt).toBeNull();

    const queue = await as(approverId, null, "GET", "/v1/approvals");
    expect(queue.statusCode, queue.body).toBe(200);
    const listed = (queue.json().approvals ?? queue.json()) as Array<{ id: string; objectLabel?: string | null }>;
    expect(listed.find((x) => x.id === ap!.id)?.objectLabel ?? "").toMatch(/^contain \(halt\), high: /);

    expect((await decide(ap!.id, "approved", stewardId)).statusCode).toBe(403);
    const noStep = await decide(ap!.id, "approved", approverId, "none");
    expect(noStep.statusCode, noStep.body).toBe(403);
    const wrongStep = await decide(ap!.id, "approved", approverId, "wrong");
    expect(wrongStep.statusCode, wrongStep.body).toBe(403);
    const ok = await decide(ap!.id, "approved", approverId);
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
    await containAlerts(db, [alertId]);
    const c = (await containmentOf(alertId))!;
    const d = await decide(c.approvalId!, "denied", approverId);
    expect(d.statusCode, d.body).toBe(200);
    expect((await containmentOf(alertId))!.status).toBe("declined");
    const [a] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(a!.haltedAt).toBeNull();
  });

  it("with no approver named it falls back to the tenant's admins: any other admin decides with the MFA step-up", async () => {
    await setPolicy({ containmentApproverUserId: null });
    const agentId = await registryAgent("fallback");
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId });
    expect(await containAlerts(db, [alertId])).toMatchObject({ proposed: 1 });
    const c = (await containmentOf(alertId))!;
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, c.approvalId!));
    expect(ap!.approverUserId).not.toBe(stewardId);
    const proposed = (await auditFor(c.id)).find((a) => a.ruleId === CONTAINMENT_RULE_IDS.proposed)!;
    expect((proposed.detail as Record<string, unknown>).adminFallback).toBe(true);
    // an admin the row is not addressed to decides it (the admin override, reason recorded) with the MFA step-up
    const decider = ap!.approverUserId === adminId ? approverId : adminId;
    const ok = await decide(ap!.id, "approved", decider);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await containmentOf(alertId))!.status).toBe("contained");
    await setPolicy({ containmentApproverUserId: approverId });
  });

  it("an agent with no steward is recorded unrouted and audited; unregistered traffic files nothing", async () => {
    const [orphan] = await db.insert(agents).values({ name: `a366-orphan-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    agentIds.push(orphan!.id);
    const alertId = await alert("classical_model_drift", `model_card:${orphan!.id}`, "high", { agentId: orphan!.id });
    expect(await containAlerts(db, [alertId])).toMatchObject({ unrouted: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c).toMatchObject({ status: "proposed", approvalId: null });
    expect((await auditFor(c.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.unrouted);
    const traffic = await alert("unregistered_ai_traffic", `project:${orphan!.id}`, "medium", { subjectType: "project" });
    expect(await containAlerts(db, [traffic])).toEqual({ autoContained: 0, proposed: 0, unrouted: 0, skipped: 0, failed: 0 });
    expect(await containmentOf(traffic)).toBeUndefined();
  });
});

describe("ADR-0366: release needs approval (owner decision 2026-11-21)", () => {
  const reason = { reason: `a366 reviewed, safe to resume ${RUN}` };
  const request = (who: string, id: string, body: unknown = reason) => as(who, releaseStep(id), "POST", `/v1/containments/${id}/release`, body);

  it("is a request: reason + step-up, refused while the dial is not normal, and the agent stays halted until approved", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const b = await builderAgent("release");
    const first = await autonomyAlert(b.id, "assist", "autonomous");
    const second = await autonomyAlert(b.id, "assist", "autonomous");
    await containAlerts(db, [first, second]);
    const c1 = (await containmentOf(first))!;
    const c2 = (await containmentOf(second))!;
    expect(c1.haltApplied).toBe(true);
    expect(c2.haltApplied).toBe(false); // already halted by the first

    expect((await as(adminId, null, "POST", `/v1/containments/${c1.id}/release`, reason)).statusCode).toBe(403);
    expect((await request(adminId, c1.id, { reason: "ok" })).statusCode).toBe(400);
    expect((await request(stewardId, c1.id)).statusCode).toBe(403);
    await db.update(orgSettings).set({ executionMode: "read_only", executionModeReason: `a366 read only ${RUN}` }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const dial = await request(adminId, c1.id);
    expect(dial.statusCode, dial.body).toBe(409);
    expect(dial.json().error).toBe("execution_dial_not_normal");
    await db.update(orgSettings).set({ executionMode: "normal", executionModeReason: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

    const asked = await request(adminId, c1.id);
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json().containment).toMatchObject({ status: "release_pending", releaseRequestedByUserId: adminId });
    const approvalId = asked.json().approvalId as string;
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap).toMatchObject({ objectType: "agent_containment", userId: adminId, approverUserId: approverId });
    expect((await chat(b.id)).json().error).toBe("builder_agent_halted"); // still halted while pending
    expect((await request(adminId, c1.id)).statusCode).toBe(409); // one request at a time

    // the requester and the steward cannot approve it; no step-up is refused
    expect((await decide(approvalId, "approved", adminId)).statusCode).toBe(403);
    expect((await decide(approvalId, "approved", stewardId)).statusCode).toBe(403);
    expect((await decide(approvalId, "approved", approverId, "none")).statusCode).toBe(403);
    // the second containment still holds the agent: approved, but the halt stays
    const ok = await decide(approvalId, "approved", approverId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await containmentOf(first))!).toMatchObject({ status: "released", releasedByUserId: approverId });
    expect((await chat(b.id)).json().error).toBe("builder_agent_halted");

    // releasing the second lifts the containment's halt
    const asked2 = await request(adminId, c2.id);
    expect(asked2.statusCode, asked2.body).toBe(202);
    await db.update(orgSettings).set({ executionMode: "halted", executionModeReason: `a366 halted ${RUN}` }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const dialAtDecide = await decide(asked2.json().approvalId, "approved", approverId);
    expect(dialAtDecide.statusCode, dialAtDecide.body).toBe(409);
    await db.update(orgSettings).set({ executionMode: "normal", executionModeReason: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const ok2 = await decide(asked2.json().approvalId, "approved", approverId);
    expect(ok2.statusCode, ok2.body).toBe(200);
    const [row] = await db.select().from(builderAgents).where(eq(builderAgents.id, b.id));
    expect(row!.haltedAt).toBeNull();
    expect((await chat(b.id)).json().error).not.toBe("builder_agent_halted");
    expect((await auditFor(c2.id)).map((a) => a.ruleId)).toEqual(
      expect.arrayContaining([CONTAINMENT_RULE_IDS.releaseRequested, CONTAINMENT_RULE_IDS.released]),
    );
    // the builder agent's own history reads HALTED … LIFTED (one unhalt per subject)
    expect((await auditFor(b.id)).map((a) => a.ruleId)).toEqual(
      expect.arrayContaining([CONTAINMENT_RULE_IDS.builderAgentHalted, CONTAINMENT_RULE_IDS.builderAgentUnhalted]),
    );
  });

  it("a refused release leaves the agent halted and the containment contained", async () => {
    const b = await builderAgent("refused");
    const alertId = await autonomyAlert(b.id, "assist", "autonomous");
    await containAlerts(db, [alertId]);
    const c = (await containmentOf(alertId))!;
    const asked = await request(adminId, c.id);
    expect(asked.statusCode, asked.body).toBe(202);
    const d = await decide(asked.json().approvalId, "denied", approverId);
    expect(d.statusCode, d.body).toBe(200);
    expect((await containmentOf(alertId))!).toMatchObject({ status: "contained", releaseApprovalId: null, releaseReason: null });
    expect((await chat(b.id)).json().error).toBe("builder_agent_halted");
    expect((await auditFor(c.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.releaseDenied);
  });

  it("ADR-0124's unhalt defers to a containment: one admin cannot lift it; the approved release writes the agent's LIFTED row", async () => {
    await setPolicy({ containmentAutoSeverity: "high", containmentApproverUserId: approverId });
    const agentId = await registryAgent("unhalt");
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId });
    expect(await containAlerts(db, [alertId])).toMatchObject({ autoContained: 1 });
    const c = (await containmentOf(alertId))!;
    const unhaltStep: StepUpCheckArgs = { kind: "settings_relax", facts: { agentId, values: { halted: false } } };
    const unhalt = await as(adminId, unhaltStep, "POST", `/v1/agents/${agentId}/unhalt`, { reason: `a366 one admin tries ${RUN}` });
    expect(unhalt.statusCode, unhalt.body).toBe(409);
    expect(unhalt.json()).toMatchObject({ error: "held_by_containment", containmentIds: [c.id] });
    const [still] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(still!.haltedAt).not.toBeNull();
    // the approved release lifts it through ADR-0124's one unhalt: the agent's own history reads LIFTED
    const asked = await as(adminId, releaseStep(c.id), "POST", `/v1/containments/${c.id}/release`, { reason: `a366 reviewed ${RUN}` });
    expect(asked.statusCode, asked.body).toBe(202);
    expect((await decide(asked.json().approvalId, "approved", approverId)).statusCode).toBe(200);
    const [lifted] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, agentId));
    expect(lifted!.haltedAt).toBeNull();
    expect((await auditFor(agentId)).map((a) => a.ruleId)).toContain("execution-agent-unhalted");
    await setPolicy({ containmentAutoSeverity: "critical" });
  });

  it("never lifts a halt a person threw by hand", async () => {
    const agentId = await registryAgent("manual");
    await db.update(agents).set({ haltedAt: new Date(), haltedReason: `a366 manual incident halt ${RUN}`, haltedByUserId: adminId }).where(eq(agents.id, agentId));
    await setPolicy({ containmentAutoSeverity: "high" });
    const alertId = await alert("classical_model_drift", `model_card:${agentId}`, "high", { agentId });
    expect(await containAlerts(db, [alertId])).toMatchObject({ autoContained: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c.haltApplied).toBe(false);
    const asked = await request(adminId, c.id);
    expect(asked.statusCode, asked.body).toBe(202);
    const ok = await decide(asked.json().approvalId, "approved", approverId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await containmentOf(alertId))!.status).toBe("released");
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
    expect((await as(adminId, null, "GET", "/v1/containments?before=not-a-cursor")).statusCode).toBe(400);
    const steward = await as(stewardId, null, "GET", "/v1/containments");
    expect(steward.statusCode).toBe(403);
  });
});

describe("ADR-0366 slice 2: containing a virtual key (unregistered AI traffic)", () => {
  async function key(label: string) {
    const r = await app.inject({ method: "POST", url: "/v1/virtual-keys", headers: AUTH, payload: { name: `a366-${label}-${RUN}`, userId: stewardId } });
    expect(r.statusCode, r.body).toBe(201);
    keyIds.push(r.json().id);
    return { id: r.json().id as string, header: { authorization: `Bearer ${r.json().token as string}` } };
  }
  const trafficAlert = (keyId: string) =>
    db
      .insert(governanceAlerts)
      .values({
        ruleId: "unregistered_ai_traffic",
        subjectKey: `virtual_key:${keyId}`,
        severity: "medium",
        title: "a366 unregistered traffic",
        detail: { subjectType: "virtual_key", subjectId: keyId, modelCalls: 4, mcpCalls: 0, windowDays: 7 },
        firstDetectedAt: new Date(),
        lastDetectedAt: new Date(),
      })
      .returning({ id: governanceAlerts.id })
      .then(([r]) => (alertIds.push(r!.id), r!.id));
  const call = (header: { authorization: string }) => app.inject({ method: "GET", url: "/v1/virtual-keys", headers: header });

  it("a medium signal is a proposal by default: the key keeps working until an admin approves, then it is halted", async () => {
    await setPolicy({ containmentAutoSeverity: "critical", containmentApproverUserId: approverId });
    const k = await key("propose");
    expect((await call(k.header)).json().error).not.toBe("virtual_key_halted");
    const alertId = await trafficAlert(k.id);
    expect(await containAlerts(db, [alertId])).toMatchObject({ proposed: 1 });
    const c = (await containmentOf(alertId))!;
    expect(c).toMatchObject({ subjectKind: "virtual_key", virtualKeyId: k.id, status: "proposed" });
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, c.approvalId!));
    expect(ap!.userId).toBe(stewardId); // the key's owner is its steward
    expect((await decide(c.approvalId!, "approved", stewardId)).statusCode).toBe(403);
    const ok = await decide(c.approvalId!, "approved", approverId);
    expect(ok.statusCode, ok.body).toBe(200);
    const refused = await call(k.header);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe("virtual_key_halted");
    const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, k.id));
    expect(row!.revokedAt).toBeNull(); // halted, never revoked: reversible
    expect((await auditFor(k.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.virtualKeyHalted);
  });

  it("at a medium threshold it is halted at once, and an approved release makes the key work again", async () => {
    await setPolicy({ containmentAutoSeverity: "medium" });
    const k = await key("auto");
    const alertId = await trafficAlert(k.id);
    expect(await containAlerts(db, [alertId])).toMatchObject({ autoContained: 1 });
    expect((await call(k.header)).json().error).toBe("virtual_key_halted");
    // #1196 review [1]: the admin list shows the contained key as halted (with why), never active
    type Listed = { id: string; active: boolean; haltedAt: string | null; haltedReason: string | null };
    const keysAt = async (state: string) => {
      const out: Listed[] = [];
      let next = "";
      for (let guard = 0; guard < 50; guard++) {
        const res = await app.inject({ method: "GET", url: `/v1/virtual-keys?limit=100&state=${state}${next}`, headers: AUTH });
        expect(res.statusCode, res.body).toBe(200);
        const body = res.json();
        out.push(...(body.items as Listed[]));
        if (body.nextCursor) next = `&cursor=${encodeURIComponent(body.nextCursor)}`;
        else if (body.nextOffset !== null && body.nextOffset !== undefined) next = `&offset=${body.nextOffset}`;
        else break;
      }
      return out.filter((x) => x.id === k.id);
    };
    const [halted] = await keysAt("halted");
    expect(halted).toMatchObject({ active: false });
    expect(halted!.haltedAt).not.toBeNull();
    expect(halted!.haltedReason).toContain("contained (ADR-0366)");
    expect(await keysAt("active")).toHaveLength(0);
    const c = (await containmentOf(alertId))!;
    const asked = await as(adminId, releaseStep(c.id), "POST", `/v1/containments/${c.id}/release`, { reason: `a366 key reviewed ${RUN}` });
    expect(asked.statusCode, asked.body).toBe(202);
    expect((await call(k.header)).json().error).toBe("virtual_key_halted"); // still halted while pending
    const ok = await decide(asked.json().approvalId, "approved", approverId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call(k.header)).json().error).not.toBe("virtual_key_halted");
    // the one audited unhalt: the key's own history reads HALTED … LIFTED
    expect((await auditFor(k.id)).map((a) => a.ruleId)).toContain(CONTAINMENT_RULE_IDS.virtualKeyUnhalted);
    await setPolicy({ containmentAutoSeverity: "critical" });
  });

  it("a revoked key is not contained (nothing to halt) and a project subject is not mapped", async () => {
    await setPolicy({ containmentAutoSeverity: "medium" });
    const k = await key("revoked");
    await db.update(virtualKeys).set({ revokedAt: new Date() }).where(eq(virtualKeys.id, k.id));
    const alertId = await trafficAlert(k.id);
    expect(await containAlerts(db, [alertId])).toMatchObject({ skipped: 1, autoContained: 0 });
    await setPolicy({ containmentAutoSeverity: "critical" });
  });
});

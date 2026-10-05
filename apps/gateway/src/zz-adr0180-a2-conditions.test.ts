/**
 * ADR-0180 A2 (ADR-0175 batch D3) — MEASURABLE CONDITIONS.
 *
 * Pinned through the real decide path and the real routes on a real database.
 * Each rule below has a test that fails without it (red proof recorded in the
 * batch summary):
 *  - INSUFFICIENT IS NEVER PASS: too few samples reads `insufficient`, no data
 *    `not_run`; neither closes the condition.
 *  - EVALUATOR-ONLY CLOSING: an open measured condition is closed only by the
 *    evaluator, on passing evidence — system actor, audited, with the evidence.
 *  - MANUAL MET REFUSED: `/met` on a measured condition is a 422,
 *    `condition_evidence_failing` while the evidence fails and
 *    `condition_not_manual` once it passes; nothing is written.
 *  - TWO BREACHES BEFORE REOPEN: `on_breach = reopen_review` re-opens review on
 *    the SECOND consecutive breach, not the first.
 *  - WAIVER: admin-only, reason required and prose-scrubbed, stamps met_at and
 *    waived_*, audited; the verdict reads `waived`, never a pass.
 *  - SPEND READS usage_events, not trace cost.
 * Plus: the decide path stores measured conditions (kind `metric`) and refuses
 * bad params by name; a met condition that later breaches keeps its met history
 * and raises the monitor finding; the scheduler sweep evaluates only what is due.
 *
 * Global state (M-068): every condition and alert this file creates is removed
 * before it ends, so no later monitor pass sees these fixtures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  governanceAlerts,
  inArray,
  projects,
  runMigrations,
  sql,
  traceEvaluations,
  traceSpans,
  traces,
  usageEvents,
  useCaseConditions,
  type Db,
} from "@regulait/db";
import { measurementStateFor, renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { buildApp } from "./app.js";
import {
  conditionMetricsMonitorInput,
  evaluateUseCaseConditions,
  measureAssuranceMetric,
  runConditionEvaluationSweep,
} from "./condition-metrics.js";
import { routeAuthClass } from "./route-classes.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a2c-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
type Who = "admin" | "owner" | "member";
const users = {} as Record<Who, { id: string; name: string; auth: { authorization: string } }>;
let db: Db;
let app: ReturnType<typeof buildApp>;
const useCaseIds: string[] = [];
const projectIds: string[] = [];

const answers: EuAiActAnswers = {
  purposeDomain: "general-business",
  affectedPersons: [],
  decisionAutonomy: "informs-human",
  biometricUse: "none",
  emotionRecognition: false,
  socialScoring: false,
  manipulativeTechniques: false,
  profilesNaturalPersons: false,
  safetyComponent: false,
  interactsWithHumans: false,
  generatesSyntheticContent: false,
};
const questionnaire = `# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled by the proposer.\n\n## 9. EU AI Act risk screening\n\n${renderEuAiActAnswersBlock(answers)}`;

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
const auditFor = (objectId: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));
const condRow = async (id: string) => (await db.select().from(useCaseConditions).where(eq(useCaseConditions.id, id)))[0]!;
const ucRow = async (id: string) => (await db.select().from(aiUseCases).where(eq(aiUseCases.id, id)))[0]!;

async function propose(label: string): Promise<{ id: string; instanceId: string; projectId: string }> {
  const p = await post("/v1/use-cases", users.owner.auth, {
    name: `a2c ${label} ${RUN}`,
    description: "synthetic ADR-0180 A2 fixture",
    businessContext: "measured conditions",
    dataSensitivity: "internal",
  });
  expect(p.statusCode, p.body).toBe(201);
  const id = p.json().id as string;
  const instanceId = p.json().instance.id as string;
  useCaseIds.push(id);
  expect((await post(`/v1/workflows/instances/${instanceId}/advance`, users.owner.auth, { stageId: "plan" })).statusCode).toBe(200);
  const art = await post(`/v1/workflows/instances/${instanceId}/artifacts`, users.owner.auth, { stageId: "questionnaire", content: questionnaire });
  expect(art.statusCode, art.body).toBe(201);
  // a project of its own, so the ledgers this file writes are this use case's alone
  const [proj] = await db.insert(projects).values({ name: `a2c project ${label} ${RUN}` }).returning({ id: projects.id });
  projectIds.push(proj!.id);
  await db.update(aiUseCases).set({ projectId: proj!.id }).where(eq(aiUseCases.id, id));
  return { id, instanceId, projectId: proj!.id };
}

async function pendingSignoffs(instanceId: string) {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, "signoff"), eq(approvals.status, "pending")));
}

/** approve every pending sign-off row; conditions ride the first */
async function approveWith(instanceId: string, conditions: unknown[]) {
  const rows = await pendingSignoffs(instanceId);
  expect(rows.length).toBeGreaterThan(0);
  let first = true;
  let last: Awaited<ReturnType<typeof post>> | null = null;
  for (const row of rows) {
    last = await post(`/v1/approvals/${row.id}/decide`, users.admin.auth, {
      decision: "approved",
      reason: "approved subject to measured conditions (a2c)",
      ...(first ? { conditions } : {}),
    });
    expect(last.statusCode, last.body).toBe(200);
    first = false;
  }
  return last!;
}

const errorRateCondition = (over: Record<string, unknown> = {}) => ({
  kind: "metric",
  text: "Error rate stays below 5 percent",
  blocking: true,
  metric: "error_rate",
  params: {},
  operator: "lt",
  threshold: 5,
  windowDays: 7,
  minSamples: 10,
  cadence: "daily",
  onBreach: "alert",
  ...over,
});

async function addTraces(projectId: string, ok: number, error: number) {
  const rows = [
    ...Array.from({ length: ok }, () => "ok" as const),
    ...Array.from({ length: error }, () => "error" as const),
  ].map((status, i) => ({
    kind: "dispatch" as const,
    name: `a2c-trace-${RUN}-${i}`,
    userId: users.owner.id,
    projectId,
    status,
    startedAt: new Date(Date.now() - 60_000),
    endedAt: new Date(),
    durationMs: 100,
  }));
  return db.insert(traces).values(rows).returning({ id: traces.id });
}

async function conditionsOf(useCaseId: string) {
  return db.select().from(useCaseConditions).where(eq(useCaseConditions.useCaseId, useCaseId));
}

const evaluateNow = (useCaseId: string, conditionId: string, who: Who = "admin") =>
  post(`/v1/use-cases/${useCaseId}/conditions/${conditionId}/evaluate`, users[who].auth, {});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["member", false]] as const) {
    const name = `a2c ${k} ${RUN}`;
    const u = await post("/v1/users", AUTH, { email: `a2c-${k}-${RUN}@example.com`, displayName: name, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await post(`/v1/users/${id}/keys`, AUTH, { name: "a2c" })).json().token as string;
    users[k] = { id, name, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  // M-068: no later monitor pass may see these fixtures
  if (useCaseIds.length) {
    await db.delete(useCaseConditions).where(inArray(useCaseConditions.useCaseId, useCaseIds));
    await db
      .delete(governanceAlerts)
      .where(sql`${governanceAlerts.ruleId} = 'condition_metric_breached' and (${sql.join(useCaseIds.map((id) => sql`${governanceAlerts.subjectKey} like ${`use_case:${id}>%`}`), sql` or `)})`);
    await db.update(aiUseCases).set({ projectId: null }).where(inArray(aiUseCases.id, useCaseIds));
  }
  if (projectIds.length) {
    await db.delete(traces).where(inArray(traces.projectId, projectIds));
    await db.delete(usageEvents).where(inArray(usageEvents.projectId, projectIds));
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
  app.server.closeAllConnections();
  await app.close();
});

describe("the state rule: too few samples is never a pass", () => {
  it("measurementStateFor: no data is not_run, too few samples insufficient, even when the value passes", () => {
    expect(measurementStateFor({ value: 0, samples: 3, minSamples: 10, operator: "lt", threshold: 5 })).toBe("insufficient");
    expect(measurementStateFor({ value: null, samples: 0, minSamples: 1, operator: "lt", threshold: 5 })).toBe("not_run");
    expect(measurementStateFor({ value: 0, samples: 0, minSamples: 1, operator: "lt", threshold: 5 })).toBe("not_run");
    expect(measurementStateFor({ value: 0, samples: 10, minSamples: 10, operator: "lt", threshold: 5 })).toBe("pass");
    expect(measurementStateFor({ value: 6, samples: 10, minSamples: 10, operator: "lt", threshold: 5 })).toBe("fail");
  });

  it("through the decide path and the evaluator: an under-sampled passing rate stays open; enough samples close it", async () => {
    const uc = await propose("insufficient");
    await approveWith(uc.instanceId, [errorRateCondition()]);
    const [cond] = await conditionsOf(uc.id);
    expect(cond).toMatchObject({ kind: "metric", metric: "error_rate", operator: "lt", threshold: 5, windowDays: 7, minSamples: 10, cadence: "daily", status: "open" });
    // dueAt defaulted to one full window after the decision
    expect(cond!.dueAt.getTime() - Date.now()).toBeGreaterThan(6 * 86_400_000);

    // no traffic at all: not_run, open
    let r = await evaluateNow(uc.id, cond!.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().verdict).toMatchObject({ state: "not_run", status: "open" });

    // 3 clean traces: a 0 % error rate, but below the 10-sample minimum
    await addTraces(uc.projectId, 3, 0);
    r = await evaluateNow(uc.id, cond!.id);
    expect(r.json().verdict).toMatchObject({ state: "insufficient", status: "open" });
    expect(r.json().verdict.measurement).toMatchObject({ value: 0, samples: 3, state: "insufficient" });
    expect((await condRow(cond!.id)).status).toBe("open");
    // the gate's read (persist: false) agrees and writes nothing
    const live = await evaluateUseCaseConditions(db, uc.id, new Date(), { persist: false });
    expect(live[0]).toMatchObject({ state: "insufficient", status: "open" });

    await addTraces(uc.projectId, 9, 0);
    r = await evaluateNow(uc.id, cond!.id);
    expect(r.json().verdict).toMatchObject({ state: "pass", status: "met" });
    expect(r.json().met).toBe(true);
  }, 120_000);
});

describe("evaluator-only closing", () => {
  it("closes an open measured condition as the SYSTEM evaluator, audited with the evidence; persist:false closes nothing", async () => {
    const uc = await propose("evaluator");
    await approveWith(uc.instanceId, [errorRateCondition({ minSamples: 5 })]);
    const [cond] = await conditionsOf(uc.id);
    const traceRows = await addTraces(uc.projectId, 6, 0);

    // the gate's read sees a pass but closes nothing
    const live = await evaluateUseCaseConditions(db, uc.id, new Date(), { persist: false });
    expect(live[0]).toMatchObject({ state: "pass", status: "open" });
    expect((await condRow(cond!.id)).status).toBe("open");

    const r = await evaluateNow(uc.id, cond!.id);
    expect(r.statusCode, r.body).toBe(200);
    const row = await condRow(cond!.id);
    expect(row).toMatchObject({ status: "met", metByUserId: null, lastState: "pass", lastSamples: 6, consecutiveBreaches: 0 });
    expect(row.note).toContain("condition evaluator");
    expect(row.evidence.length).toBeGreaterThan(0);
    expect(row.evidence.every((e) => e.type === "trace" && traceRows.some((t) => t.id === e.id))).toBe(true);

    const met = await auditFor(uc.id, "use-case-condition-met");
    expect(met).toHaveLength(1);
    expect(met[0]!.userId).toBe("00000000-0000-0000-0000-000000000000");
    expect(met[0]!.detail).toMatchObject({
      actor: "system:condition-evaluator",
      closedBy: "evaluator",
      conditionId: cond!.id,
      requestedBy: users.admin.id,
      measurement: { state: "pass", samples: 6 },
    });
    expect((met[0]!.detail as { measurement: { evidence: unknown[] } }).measurement.evidence.length).toBeGreaterThan(0);
    // the admin's request is audited as the admin's
    expect(await auditFor(uc.id, "use-case-condition-evaluate-requested")).toHaveLength(1);
  }, 120_000);

  it("evaluate is admin-only and refuses a manual condition by name", async () => {
    expect(routeAuthClass("POST", "/v1/use-cases/:useCaseId/conditions/:conditionId/evaluate")).toBe("admin");
    const uc = await propose("evaluate-manual");
    await approveWith(uc.instanceId, [{ text: "DPIA signed", dueAt: "2099-01-01", blocking: true }, errorRateCondition()]);
    const rows = await conditionsOf(uc.id);
    const manual = rows.find((c) => c.kind === "manual")!;
    const metric = rows.find((c) => c.kind === "metric")!;
    expect((await evaluateNow(uc.id, metric.id, "member")).statusCode).toBe(403);
    const m = await evaluateNow(uc.id, manual.id);
    expect(m.statusCode).toBe(422);
    expect(m.json().error).toBe("condition_not_measured");
  }, 120_000);
});

describe("a manual /met on a measured condition is refused", () => {
  it("422 condition_evidence_failing while the evidence fails, 422 condition_not_manual once it passes; nothing written", async () => {
    const uc = await propose("manual-met");
    await approveWith(uc.instanceId, [errorRateCondition({ minSamples: 5 })]);
    const [cond] = await conditionsOf(uc.id);
    const met = (body: Record<string, unknown>) => post(`/v1/use-cases/${uc.id}/conditions/${cond!.id}/met`, users.admin.auth, body);

    // the detail read tells the UI nobody may mark it met by hand
    const d = await get(`/v1/use-cases/${uc.id}`, users.admin.auth);
    const view = (d.json().conditions as Array<Record<string, unknown>>).find((c) => c.id === cond!.id)!;
    expect(view).toMatchObject({ kind: "metric", canMarkMet: false, metric: "error_rate", lastState: null });
    expect(String(view.spec)).toContain("Error rate below 5");

    let r = await met({ note: "we checked the dashboard" });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "condition_evidence_failing", state: "not_run" });

    await addTraces(uc.projectId, 1, 2);
    r = await met({ note: "errors are fine really" });
    expect(r.json()).toMatchObject({ error: "condition_evidence_failing", state: "insufficient" });

    await addTraces(uc.projectId, 200, 0);
    r = await met({ note: "now it passes" });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: "condition_not_manual", state: "pass" });

    expect(await condRow(cond!.id)).toMatchObject({ status: "open", metAt: null, metByUserId: null });
    expect(await auditFor(uc.id, "use-case-condition-met")).toHaveLength(0);
  }, 120_000);
});

describe("on_breach = reopen_review: two consecutive breaches, not one", () => {
  it("the first breach alerts only; the second re-opens review; a pass in between resets the streak", async () => {
    const uc = await propose("reopen");
    await approveWith(uc.instanceId, [errorRateCondition({ blocking: false, minSamples: 5, onBreach: "reopen_review", cadence: "hourly" })]);
    expect((await ucRow(uc.id)).status).toBe("approved");
    const [cond] = await conditionsOf(uc.id);

    await addTraces(uc.projectId, 5, 5); // 50 % errors
    const first = await evaluateNow(uc.id, cond!.id);
    expect(first.json()).toMatchObject({ verdict: { state: "fail" }, reopened: false });
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(1);
    expect((await ucRow(uc.id)).status).toBe("approved");
    expect(await auditFor(uc.id, "use-case-condition-breach-reopened")).toHaveLength(0);

    const second = await evaluateNow(uc.id, cond!.id);
    expect(second.json()).toMatchObject({ verdict: { state: "fail" }, reopened: true });
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(2);
    const after = await ucRow(uc.id);
    expect(after).toMatchObject({ status: "under_review", recertification: false });
    const reopened = await auditFor(uc.id, "use-case-condition-breach-reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.detail).toMatchObject({ conditionId: cond!.id, consecutiveBreaches: 2, from: "approved", to: "under_review" });
    // the intake instance is waiting on a new sign-off
    expect((await pendingSignoffs(uc.instanceId)).length).toBeGreaterThan(0);
  }, 120_000);

  it("a breach, then a pass, then a breach is NOT two consecutive breaches", async () => {
    const uc = await propose("streak");
    await approveWith(uc.instanceId, [errorRateCondition({ blocking: false, minSamples: 5, onBreach: "reopen_review", cadence: "hourly" })]);
    const [cond] = await conditionsOf(uc.id);
    await addTraces(uc.projectId, 5, 5);
    await evaluateNow(uc.id, cond!.id);
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(1);
    await addTraces(uc.projectId, 500, 0); // 5 errors over 510: below 5 %
    await evaluateNow(uc.id, cond!.id);
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(0);
    await addTraces(uc.projectId, 0, 100);
    await evaluateNow(uc.id, cond!.id);
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(1);
    expect((await ucRow(uc.id)).status).toBe("approved");
  }, 120_000);
});

describe("after go-live: a met condition that breaches keeps its history and raises the monitor finding", () => {
  it("met stays met, last state fail, one finding with the use_case>condition subject", async () => {
    const uc = await propose("post-golive");
    await approveWith(uc.instanceId, [errorRateCondition({ minSamples: 5 })]);
    const [cond] = await conditionsOf(uc.id);
    await addTraces(uc.projectId, 6, 0);
    await evaluateNow(uc.id, cond!.id);
    const metAt = (await condRow(cond!.id)).metAt;
    expect(metAt).not.toBeNull();

    await addTraces(uc.projectId, 0, 10);
    const r = await evaluateNow(uc.id, cond!.id);
    expect(r.json().verdict).toMatchObject({ state: "fail", status: "met" });
    expect(await condRow(cond!.id)).toMatchObject({ status: "met", metAt, lastState: "fail", consecutiveBreaches: 1 });
    expect((await auditFor(uc.id, "use-case-condition-evaluated")).some((a) => (a.detail as { to?: string }).to === "fail")).toBe(true);

    const input = await conditionMetricsMonitorInput(db, new Date());
    const mine = input.condition_metric_breached!.breaches.filter((b) => b.subjectKey === `use_case:${uc.id}>condition:${cond!.id}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.detail).toMatchObject({ useCaseId: uc.id, conditionId: cond!.id, status: "met" });
  }, 120_000);
});

describe("waiver", () => {
  it("is admin-only with a required, prose-scrubbed reason; stamps met_at and waived_*; audited; reads waived, never pass", async () => {
    expect(routeAuthClass("POST", "/v1/use-cases/:useCaseId/conditions/:conditionId/waive")).toBe("admin");
    const uc = await propose("waive");
    await approveWith(uc.instanceId, [errorRateCondition()]);
    const [cond] = await conditionsOf(uc.id);
    const url = `/v1/use-cases/${uc.id}/conditions/${cond!.id}/waive`;

    expect((await post(url, users.member.auth, { reason: "not needed" })).statusCode).toBe(403);
    const missing = await post(url, users.admin.auth, {});
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe("waive_reason_required");
    expect((await post(url, users.admin.auth, { reason: "   " })).statusCode).toBe(422);
    expect((await condRow(cond!.id)).status).toBe("open");

    const r = await post(url, users.admin.auth, { reason: "Accepted by the board; vendor key AKIAIOSFODNN7EXAMPLE rotates it" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "waived", waivedByName: users.admin.name, verdict: { state: "waived", status: "waived" } });
    const row = await condRow(cond!.id);
    expect(row).toMatchObject({ status: "waived", waivedBy: users.admin.id });
    expect(row.metAt).not.toBeNull();
    expect(row.waivedAt).not.toBeNull();
    expect(row.waiveReason).toContain("Accepted by the board");
    expect(row.waiveReason).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const audit = await auditFor(uc.id, "use-case-condition-waived");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(users.admin.id);
    expect(audit[0]!.detail).toMatchObject({ conditionId: cond!.id, kind: "metric", from: "open", blocking: true });
    expect(audit[0]!.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const verdicts = await evaluateUseCaseConditions(db, uc.id, new Date(), { persist: false });
    expect(verdicts[0]).toMatchObject({ status: "waived", state: "waived", measurement: null });
    expect((await post(url, users.admin.auth, { reason: "again" })).statusCode).toBe(409);
    expect((await evaluateNow(uc.id, cond!.id)).statusCode).toBe(409);
  }, 120_000);
});

describe("spend reads the usage ledger, not trace cost", () => {
  it("spend_usd sums usage_events in scope and cites their ids; an unpriced call makes it insufficient, never pass", async () => {
    const uc = await propose("spend");
    const now = new Date();
    // traces carry a (display) cost that must NOT be read
    await db.insert(traces).values({ kind: "dispatch", name: `a2c-costly-${RUN}`, userId: users.owner.id, projectId: uc.projectId, status: "ok", costUsd: 999 });
    const ev = await db
      .insert(usageEvents)
      .values([
        { userId: users.owner.id, objectType: "agent", projectId: uc.projectId, costUsd: 1.25, at: new Date(now.getTime() - 3600_000) },
        { userId: users.owner.id, objectType: "connector", projectId: uc.projectId, costUsd: 2.25, at: new Date(now.getTime() - 7200_000) },
      ])
      .returning({ id: usageEvents.id });
    const spec = { metric: "spend_usd" as const, params: {}, operator: "lte" as const, threshold: 10, windowDays: 7, minSamples: 1 };
    const m = await measureAssuranceMetric(db, spec, { projectId: uc.projectId, agentIds: [] }, now);
    expect(m).toMatchObject({ value: 3.5, samples: 2, state: "pass" });
    expect(m.evidence.map((e) => e.type)).toEqual(["usage_event", "usage_event"]);
    expect(new Set(m.evidence.map((e) => e.id))).toEqual(new Set(ev.map((e) => e.id)));

    await db.insert(usageEvents).values({ userId: users.owner.id, objectType: "agent", projectId: uc.projectId, costUsd: null, at: new Date(now.getTime() - 60_000) });
    const unpriced = await measureAssuranceMetric(db, spec, { projectId: uc.projectId, agentIds: [] }, now);
    expect(unpriced).toMatchObject({ value: 3.5, state: "insufficient" });
  }, 120_000);
});

describe("other ledgers", () => {
  it("trace_eval_flag_rate reads evaluated rows only, narrowed by detector", async () => {
    const uc = await propose("flags");
    const [t] = await addTraces(uc.projectId, 1, 0);
    const [span] = await db
      .insert(traceSpans)
      .values({ traceId: t!.id, seq: 0, kind: "llm", name: "a2c-span", status: "ok", startedAt: new Date() })
      .returning({ id: traceSpans.id });
    const base = { traceId: t!.id, spanStartedAt: new Date(Date.now() - 60_000) };
    await db.insert(traceEvaluations).values([
      { ...base, spanId: span!.id, outcome: "evaluated", flagged: true, findings: [{ phase: "output", detector: "pii", category: "email", count: 1 }] },
      { ...base, spanId: crypto.randomUUID(), outcome: "evaluated", flagged: false },
      { ...base, spanId: crypto.randomUUID(), outcome: "evaluated", flagged: true, findings: [{ phase: "input", detector: "injection", category: "x", count: 1 }] },
      { ...base, spanId: crypto.randomUUID(), outcome: "withheld", flagged: false },
    ]);
    const spec = { metric: "trace_eval_flag_rate" as const, params: {}, operator: "lt" as const, threshold: 50, windowDays: 7, minSamples: 3 };
    const all = await measureAssuranceMetric(db, spec, { projectId: uc.projectId, agentIds: [] }, new Date());
    expect(all.samples).toBe(3);
    expect(all.value).toBeCloseTo((2 / 3) * 100, 5);
    expect(all.state).toBe("fail");
    const pii = await measureAssuranceMetric(db, { ...spec, params: { detector: "pii" } }, { projectId: uc.projectId, agentIds: [] }, new Date());
    expect(pii.value).toBeCloseTo((1 / 3) * 100, 5);
    expect(pii.state).toBe("pass");
    await db.delete(traceEvaluations).where(eq(traceEvaluations.traceId, t!.id));
  }, 120_000);

  it("an empty scope, or malformed params, is not_run — never a pass", async () => {
    const spec = { metric: "error_rate" as const, params: {}, operator: "lt" as const, threshold: 100, windowDays: 7, minSamples: 1 };
    expect(await measureAssuranceMetric(db, spec, { projectId: null, agentIds: [] }, new Date())).toMatchObject({ state: "not_run", value: null });
    const bad = { ...spec, metric: "guardrail_mode" as const, params: { detector: "made-up" } };
    expect((await measureAssuranceMetric(db, bad, { projectId: projectIds[0]!, agentIds: [] }, new Date())).state).toBe("not_run");
  });
});

describe("the decide path", () => {
  it("refuses a measured condition whose params do not fit its metric, by name, and writes nothing", async () => {
    const uc = await propose("bad-params");
    const [row] = await pendingSignoffs(uc.instanceId);
    const r = await post(`/v1/approvals/${row!.id}/decide`, users.admin.auth, {
      decision: "approved",
      reason: "a2c",
      conditions: [errorRateCondition({ metric: "guardrail_mode", params: {} })],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("invalid_conditions");
    const unknownMetric = await post(`/v1/approvals/${row!.id}/decide`, users.admin.auth, {
      decision: "approved",
      reason: "a2c",
      conditions: [errorRateCondition({ metric: "vibes" })],
    });
    expect(unknownMetric.statusCode).toBe(422);
    expect(await conditionsOf(uc.id)).toHaveLength(0);
    expect((await ucRow(uc.id)).status).not.toBe("approved");
  }, 120_000);
});

describe("the scheduler job", () => {
  it("is registered, and evaluates only conditions whose cadence is due", async () => {
    const job = schedulerJobRegistry({}).get("condition-evaluation-sweep");
    expect(job?.adr).toBe("ADR-0180");
    const uc = await propose("sweep");
    await approveWith(uc.instanceId, [errorRateCondition({ minSamples: 5, cadence: "daily" })]);
    const [cond] = await conditionsOf(uc.id);
    await addTraces(uc.projectId, 2, 0);
    const now = new Date();
    await runConditionEvaluationSweep(db, { now });
    const first = await condRow(cond!.id);
    expect(first).toMatchObject({ lastState: "insufficient", status: "open" });
    expect(first.lastEvaluatedAt?.toISOString()).toBe(now.toISOString());
    // an hour later a daily condition is not due: nothing is re-measured
    await addTraces(uc.projectId, 10, 0);
    await runConditionEvaluationSweep(db, { now: new Date(now.getTime() + 3600_000) });
    expect((await condRow(cond!.id)).lastEvaluatedAt?.toISOString()).toBe(now.toISOString());
    // a day later it is, and the evaluator closes it
    await runConditionEvaluationSweep(db, { now: new Date(now.getTime() + 86_400_000) });
    expect(await condRow(cond!.id)).toMatchObject({ status: "met", lastState: "pass" });
  }, 120_000);
});

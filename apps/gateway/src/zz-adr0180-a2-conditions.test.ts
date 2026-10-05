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
 *  - REOPEN AT OR PAST THE THRESHOLD (FA2 finding 1): a successful reopen
 *    resets the streak, so a re-approved use case that keeps failing re-opens
 *    again; a streak reached while the use case is not approved is audited
 *    once and kept, and the first breach after re-approval re-opens it.
 *  - ONE COUNT PER CADENCE WINDOW (FA2 finding 5): two evaluations inside one
 *    window add one breach, not two, and do not move the window anchor.
 *  - NO PARTIAL PASS (FA2 finding 2): red-team and eval metrics read only the
 *    use case's own agents, judged on the WEAKEST agent (worst value, smallest
 *    sample count), and an in-scope agent that measured nothing makes the
 *    result insufficient.
 *  - STORED READS (FA2 finding 6): the monitor and the manual `/met` refusal
 *    read the persisted evaluation; neither measures the ledgers live.
 *  - SCRUB GROWTH (FA2 finding 7a): a waiver reason that the credential scrub
 *    lengthens past the store's limit is a 422, not a 500.
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
  agents,
  aiUseCases,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  evalDatasets,
  evalRuns,
  governanceAlerts,
  inArray,
  projects,
  redteamLibraries,
  redteamRuns,
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
  evaluateConditionsDetailed,
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
const agentIds: string[] = [];
const datasetIds: string[] = [];
const libraryIds: string[] = [];
const DATA_KEY = "a".repeat(64);

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

/** a persisted evaluation at a chosen moment (what the route and the sweep do, with the clock moved) */
const evaluateAt = (useCaseId: string, at: Date) =>
  evaluateConditionsDetailed(db, useCaseId, at, { persist: true, dataKey: DATA_KEY });
const HOUR = 3600_000;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
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
  if (agentIds.length) {
    await db.delete(redteamRuns).where(inArray(redteamRuns.agentId, agentIds));
    await db.delete(evalRuns).where(inArray(evalRuns.agentId, agentIds));
    await db.delete(agents).where(inArray(agents.id, agentIds));
  }
  if (libraryIds.length) await db.delete(redteamLibraries).where(inArray(redteamLibraries.id, libraryIds));
  if (datasetIds.length) await db.delete(evalDatasets).where(inArray(evalDatasets.id, datasetIds));
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

    // FA2 finding 6: the refusal reads the STORED evaluation and measures
    // nothing — new traffic is invisible to it until an evaluation runs
    await addTraces(uc.projectId, 1, 2);
    r = await met({ note: "errors are fine really" });
    expect(r.json()).toMatchObject({ error: "condition_evidence_failing", state: "not_run", measurement: null });
    await evaluateNow(uc.id, cond!.id);
    r = await met({ note: "errors are fine really" });
    expect(r.json()).toMatchObject({ error: "condition_evidence_failing", state: "insufficient", measurement: { samples: 3 } });

    // passing traffic the evaluator has not read yet does not change the answer
    await addTraces(uc.projectId, 200, 0);
    r = await met({ note: "now it passes" });
    expect(r.json()).toMatchObject({ error: "condition_evidence_failing", state: "insufficient" });

    // a stored pass on a still-open condition (as a non-metric owner may
    // record it): the evaluator closes it, never a person
    await db
      .update(useCaseConditions)
      .set({ lastState: "pass", lastValue: 1, lastSamples: 203, lastEvaluatedAt: new Date() })
      .where(eq(useCaseConditions.id, cond!.id));
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

    // the next cadence window (hourly)
    const second = await evaluateAt(uc.id, new Date(Date.now() + HOUR));
    expect(second).toMatchObject({ reopened: true, reopenSkipped: null });
    expect(second.verdicts[0]).toMatchObject({ state: "fail", consecutiveBreaches: 2 });
    // the reopen answers the streak: it starts again (FA2 finding 1)
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(0);
    const after = await ucRow(uc.id);
    expect(after).toMatchObject({ status: "under_review", recertification: false });
    const reopened = await auditFor(uc.id, "use-case-condition-breach-reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.detail).toMatchObject({ conditionId: cond!.id, consecutiveBreaches: 2, streakReset: true, from: "approved", to: "under_review" });
    // the intake instance is waiting on a new sign-off
    expect((await pendingSignoffs(uc.instanceId)).length).toBeGreaterThan(0);
  }, 120_000);

  it("a breach, then a pass, then a breach is NOT two consecutive breaches", async () => {
    const uc = await propose("streak");
    await approveWith(uc.instanceId, [errorRateCondition({ blocking: false, minSamples: 5, onBreach: "reopen_review", cadence: "hourly" })]);
    const [cond] = await conditionsOf(uc.id);
    const t0 = Date.now();
    await addTraces(uc.projectId, 5, 5);
    await evaluateAt(uc.id, new Date(t0));
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(1);
    await addTraces(uc.projectId, 500, 0); // 5 errors over 510: below 5 %
    await evaluateAt(uc.id, new Date(t0 + HOUR));
    expect((await condRow(cond!.id)).consecutiveBreaches).toBe(0);
    await addTraces(uc.projectId, 0, 100);
    await evaluateAt(uc.id, new Date(t0 + 2 * HOUR));
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
    // a forced re-evaluation inside the daily window refreshes the reading
    // (the monitor raises it) but does not count toward the streak
    expect(await condRow(cond!.id)).toMatchObject({ status: "met", metAt, lastState: "fail", consecutiveBreaches: 0 });
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

// ---------------------------------------------------------------------------
// FA2 review fixes (ADR-0180 D3 security review, findings 1, 2, 5, 6, 7a)
// ---------------------------------------------------------------------------

describe("FA2 finding 1: reopen fires at OR past the threshold, and again after re-approval", () => {
  it("resets the streak on reopen; a streak reached while not approved is audited once and kept; the next breach after re-approval re-opens", async () => {
    const uc = await propose("re-reopen");
    await approveWith(uc.instanceId, [errorRateCondition({ blocking: false, minSamples: 5, onBreach: "reopen_review", cadence: "hourly" })]);
    const [cond] = await conditionsOf(uc.id);
    await addTraces(uc.projectId, 5, 5); // 50 % errors, and they stay
    const t0 = Date.now();
    const at = (h: number) => new Date(t0 + h * HOUR);

    expect((await evaluateAt(uc.id, at(0))).reopened).toBe(false);
    expect((await evaluateAt(uc.id, at(1))).reopened).toBe(true);
    expect(await condRow(cond!.id)).toMatchObject({ consecutiveBreaches: 0 });
    expect((await ucRow(uc.id)).status).toBe("under_review");

    // still breaching while back in review: the streak builds, and reaching
    // the threshold with no approval to re-open is audited — once per streak
    expect((await evaluateAt(uc.id, at(2))).reopenSkipped).toBeNull();
    const reached = await evaluateAt(uc.id, at(3));
    expect(reached).toMatchObject({ reopened: false, reopenSkipped: "use_case_not_approved" });
    await evaluateAt(uc.id, at(4));
    expect(await condRow(cond!.id)).toMatchObject({ consecutiveBreaches: 3 });
    const skipped = (await auditFor(uc.id, "use-case-condition-reopen-skipped")).filter(
      (a) => (a.detail as { conditionId?: string }).conditionId === cond!.id,
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.detail).toMatchObject({
      actor: "system:condition-evaluator",
      reason: "use_case_not_approved",
      useCaseStatus: "under_review",
      consecutiveBreaches: 2,
    });

    // re-approved with the metric still failing: the very next breach re-opens
    await approveWith(uc.instanceId, []);
    expect((await ucRow(uc.id)).status).toBe("approved");
    const again = await evaluateAt(uc.id, at(5));
    expect(again).toMatchObject({ reopened: true, reopenSkipped: null });
    expect((await ucRow(uc.id)).status).toBe("under_review");
    expect(await auditFor(uc.id, "use-case-condition-breach-reopened")).toHaveLength(2);
    expect(await condRow(cond!.id)).toMatchObject({ consecutiveBreaches: 0 });
  }, 180_000);
});

describe("FA2 finding 5: one breach per cadence window", () => {
  it("two quick evaluations of one data window add ONE breach, keep the window anchor, and do not re-open review", async () => {
    const uc = await propose("idempotent");
    await approveWith(uc.instanceId, [errorRateCondition({ blocking: false, minSamples: 5, onBreach: "reopen_review", cadence: "hourly" })]);
    const [cond] = await conditionsOf(uc.id);
    await addTraces(uc.projectId, 5, 5);

    const first = await evaluateNow(uc.id, cond!.id);
    expect(first.json()).toMatchObject({ verdict: { state: "fail" }, reopened: false });
    const anchor = (await condRow(cond!.id)).lastEvaluatedAt;
    expect(anchor).not.toBeNull();

    // more breaching traffic, evaluated again inside the same hour
    await addTraces(uc.projectId, 0, 10);
    const second = await evaluateNow(uc.id, cond!.id);
    expect(second.json()).toMatchObject({ verdict: { state: "fail" }, reopened: false });
    const row = await condRow(cond!.id);
    expect(row.consecutiveBreaches).toBe(1);
    expect(row.lastEvaluatedAt?.toISOString()).toBe(anchor!.toISOString());
    // the reading itself is refreshed: 15 errors over 20 traces
    expect(row).toMatchObject({ lastState: "fail", lastSamples: 20, lastValue: 75 });
    expect((await ucRow(uc.id)).status).toBe("approved");

    // the next window counts: the second breach, and the reopen
    const next = await evaluateAt(uc.id, new Date(anchor!.getTime() + HOUR));
    expect(next.verdicts[0]).toMatchObject({ state: "fail", consecutiveBreaches: 2 });
    expect(next.reopened).toBe(true);
  }, 120_000);
});

describe("FA2 finding 2: partial evidence never passes", () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  async function agent(label: string) {
    const [a] = await db.insert(agents).values({ name: `a2c-agent-${label}-${RUN}`, provider: "synthetic", tier: 1 }).returning({ id: agents.id });
    agentIds.push(a!.id);
    return a!.id;
  }
  async function dataset() {
    const [ds] = await db.insert(evalDatasets).values({ name: `a2c-ds-${RUN}-${datasetIds.length}` }).returning({ id: evalDatasets.id });
    datasetIds.push(ds!.id);
    return ds!.id;
  }
  async function redteam(projectId: string, agentId: string, classSummary: unknown[], ds: string, lib: { id: string; name: string }) {
    const [ev] = await db
      .insert(evalRuns)
      .values({ datasetId: ds, datasetVersion: 1, agentId, agentName: "a2c", trigger: "manual", projectId })
      .returning({ id: evalRuns.id });
    await db.insert(redteamRuns).values({
      libraryId: lib.id,
      libraryName: lib.name,
      libraryVersion: 1,
      evalRunId: ev!.id,
      agentId,
      agentName: "a2c",
      projectId,
      classSummary,
      finishedAt: ago(HOUR),
    });
  }
  const asrSpec = { metric: "redteam_asr" as const, params: { attackClass: "tool_abuse" }, operator: "lt" as const, threshold: 5, windowDays: 30, minSamples: 4 };

  it("red team: a sibling agent outside the stack never dilutes the stack's result", async () => {
    const uc = await propose("rt-pool");
    const ds = await dataset();
    const [lib] = await db.insert(redteamLibraries).values({ name: `a2c-lib-pool-${RUN}` }).returning();
    libraryIds.push(lib!.id);
    const mine = await agent("rt-mine");
    const sibling = await agent("rt-sibling");
    // the stack's agent is defeated on every probe; a sibling in the same project resists 200
    await redteam(uc.projectId, mine, [{ attackClass: "tool_abuse", probes: 4, resisted: 0, defeated: 4 }], ds, lib!);
    await redteam(uc.projectId, sibling, [{ attackClass: "tool_abuse", probes: 200, resisted: 200, defeated: 0 }], ds, lib!);
    const m = await measureAssuranceMetric(db, asrSpec, { projectId: uc.projectId, agentIds: [mine] }, new Date());
    expect(m).toMatchObject({ state: "fail", samples: 4, value: 100 });
  }, 120_000);

  it("red team: an in-scope agent whose newest run did not probe the class makes the result insufficient", async () => {
    const uc = await propose("rt-silent");
    const ds = await dataset();
    const [lib] = await db.insert(redteamLibraries).values({ name: `a2c-lib-silent-${RUN}` }).returning();
    libraryIds.push(lib!.id);
    const probed = await agent("rt-probed");
    const unprobed = await agent("rt-unprobed");
    await redteam(uc.projectId, probed, [{ attackClass: "tool_abuse", probes: 40, resisted: 40, defeated: 0 }], ds, lib!);
    await redteam(uc.projectId, unprobed, [{ attackClass: "jailbreak", probes: 40, resisted: 40, defeated: 0 }], ds, lib!);
    const m = await measureAssuranceMetric(db, asrSpec, { projectId: uc.projectId, agentIds: [probed, unprobed] }, new Date());
    expect(m.state).toBe("insufficient");
    // the probed agent alone does pass
    expect((await measureAssuranceMetric(db, asrSpec, { projectId: uc.projectId, agentIds: [probed] }, new Date())).state).toBe("pass");
  }, 120_000);

  it("red team: judged on the WEAKEST agent — a strong agent never masks a weak one", async () => {
    const uc = await propose("rt-worst");
    const ds = await dataset();
    const [lib] = await db.insert(redteamLibraries).values({ name: `a2c-lib-worst-${RUN}` }).returning();
    libraryIds.push(lib!.id);
    const strong = await agent("rt-strong");
    const weak = await agent("rt-weak");
    // 0 % over 200 probes and 50 % over 10: pooled 5/210 = 2.4 % would pass a 10 % ceiling
    await redteam(uc.projectId, strong, [{ attackClass: "tool_abuse", probes: 200, resisted: 200, defeated: 0 }], ds, lib!);
    await redteam(uc.projectId, weak, [{ attackClass: "tool_abuse", probes: 10, resisted: 5, defeated: 5 }], ds, lib!);
    const spec = { ...asrSpec, operator: "lte" as const, threshold: 10, minSamples: 10 };
    const m = await measureAssuranceMetric(db, spec, { projectId: uc.projectId, agentIds: [strong, weak] }, new Date());
    expect(m).toMatchObject({ state: "fail", value: 50, samples: 10 });
    // the evidence cites every agent's run
    expect(m.evidence.filter((e) => e.type === "redteam_run")).toHaveLength(2);
    // a thin agent makes the whole result insufficient: the smallest count is the sample count
    expect((await measureAssuranceMetric(db, { ...spec, minSamples: 20 }, { projectId: uc.projectId, agentIds: [strong, weak] }, new Date())).state).toBe(
      "insufficient",
    );
  }, 120_000);

  it("evals: judged on the WEAKEST agent's score", async () => {
    const uc = await propose("eval-worst");
    const ds = await dataset();
    const strong = await agent("ev-strong");
    const weak = await agent("ev-weak");
    for (const [agentId, meanScore, cases, passedCases] of [
      [strong, 0.95, 100, 100],
      [weak, 0.5, 10, 5],
    ] as const) {
      await db.insert(evalRuns).values({
        datasetId: ds,
        datasetVersion: 1,
        agentId,
        agentName: "a2c",
        trigger: "manual",
        status: "completed",
        projectId: uc.projectId,
        cases,
        passedCases,
        meanScore,
        finishedAt: ago(HOUR),
      });
    }
    const scope = { projectId: uc.projectId, agentIds: [strong, weak] };
    // pooled (95 + 5) / 110 = 0.91 would pass at least 0.8
    const score = { metric: "eval_mean_score" as const, params: {}, operator: "gte" as const, threshold: 0.8, windowDays: 30, minSamples: 10 };
    expect(await measureAssuranceMetric(db, score, scope, new Date())).toMatchObject({ state: "fail", value: 0.5, samples: 10 });
    // pooled 105 / 110 = 95 % would pass at least 90 %
    const rate = { ...score, metric: "eval_pass_rate" as const, threshold: 90 };
    expect(await measureAssuranceMetric(db, rate, scope, new Date())).toMatchObject({ state: "fail", value: 50, samples: 10 });
  }, 120_000);

  it("evals: an in-scope agent whose newest run has no score makes a score condition insufficient", async () => {
    const uc = await propose("eval-silent");
    const ds = await dataset();
    const scored = await agent("ev-scored");
    const unscored = await agent("ev-unscored");
    const run = (agentId: string, meanScore: number | null, cases: number) =>
      db.insert(evalRuns).values({
        datasetId: ds,
        datasetVersion: 1,
        agentId,
        agentName: "a2c",
        trigger: "manual",
        status: "completed",
        projectId: uc.projectId,
        cases,
        passedCases: cases,
        meanScore,
        finishedAt: ago(HOUR),
      });
    await run(scored, 0.95, 30);
    await run(unscored, null, 30);
    const spec = { metric: "eval_mean_score" as const, params: {}, operator: "gte" as const, threshold: 0.8, windowDays: 30, minSamples: 10 };
    expect((await measureAssuranceMetric(db, spec, { projectId: uc.projectId, agentIds: [scored] }, new Date())).state).toBe("pass");
    const both = await measureAssuranceMetric(db, spec, { projectId: uc.projectId, agentIds: [scored, unscored] }, new Date());
    expect(both).toMatchObject({ state: "insufficient", samples: 30 });
    // an empty newest run (no cases) is as silent for a pass-rate condition
    const empty = await agent("ev-empty");
    await run(empty, null, 0);
    const rate = { ...spec, metric: "eval_pass_rate" as const, threshold: 90 };
    expect((await measureAssuranceMetric(db, rate, { projectId: uc.projectId, agentIds: [scored, empty] }, new Date())).state).toBe("insufficient");
  }, 120_000);
});

describe("FA2 finding 6: the monitor reads the stored evaluation, it never measures", () => {
  it("live traffic the sweep has not evaluated raises nothing; a stale stored pass holds instead of resolving", async () => {
    const uc = await propose("monitor-stored");
    await approveWith(uc.instanceId, [errorRateCondition({ blocking: false, minSamples: 5, cadence: "hourly" })]);
    const [cond] = await conditionsOf(uc.id);
    const key = `use_case:${uc.id}>condition:${cond!.id}`;
    await addTraces(uc.projectId, 10, 0);
    await evaluateNow(uc.id, cond!.id);
    expect(await condRow(cond!.id)).toMatchObject({ status: "met", lastState: "pass" });

    // the ledger now breaches, but nothing has evaluated it
    await addTraces(uc.projectId, 0, 50);
    let input = (await conditionMetricsMonitorInput(db, new Date())).condition_metric_breached!;
    expect(input.breaches.some((b) => b.subjectKey === key)).toBe(false);
    expect(input.heldSubjectKeys ?? []).not.toContain(key); // a fresh stored pass resolves

    // a stored pass two cadence periods old is stale: held, never resolved
    input = (await conditionMetricsMonitorInput(db, new Date(Date.now() + 3 * HOUR))).condition_metric_breached!;
    expect(input.heldSubjectKeys ?? []).toContain(key);

    // once the evaluator reads the breach, the monitor raises it
    await evaluateAt(uc.id, new Date(Date.now() + HOUR));
    input = (await conditionMetricsMonitorInput(db, new Date())).condition_metric_breached!;
    expect(input.breaches.filter((b) => b.subjectKey === key)).toHaveLength(1);
  }, 120_000);
});

describe("FA2 finding 7a: a waiver reason the scrub lengthens past the limit", () => {
  it("is a 422 waive_reason_too_long, not a 500, and writes nothing", async () => {
    const uc = await propose("waive-long");
    await approveWith(uc.instanceId, [errorRateCondition()]);
    const [cond] = await conditionsOf(uc.id);
    // 2000 characters as sent; each synthetic access key id becomes a longer marker
    const keys = Array.from({ length: 20 }, () => "AKIAIOSFODNN7EXAMPLE").join(" ");
    const reason = `${keys} ${"x".repeat(2000 - keys.length - 1)}`;
    expect(reason.length).toBe(2000);
    const r = await post(`/v1/use-cases/${uc.id}/conditions/${cond!.id}/waive`, users.admin.auth, { reason });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("waive_reason_too_long");
    expect(await condRow(cond!.id)).toMatchObject({ status: "open", waivedAt: null });
    expect(await auditFor(uc.id, "use-case-condition-waived")).toHaveLength(0);
  }, 120_000);
});

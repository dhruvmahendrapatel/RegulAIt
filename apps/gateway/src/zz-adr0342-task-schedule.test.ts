/**
 * ADR-0342 slice 2 (lane E23) — a human task's priority and due date, over the ADR-0046 assignment, with the ADR-0046
 * SLA sweep as the one escalation mechanism (real database).
 *
 *  - an admin tightens a task through the route (priority, due, warn, policy), audited;
 *  - a loosening is refused without a settings_relax step-up and, when authorised, audited as a relaxation and
 *    re-arms a breached clock;
 *  - the stage-timer entry point (lane E21's contract) schedules every pending task of a stage, may only tighten,
 *    and a timer-set due time breaches and escalates through the same sweep and policy as a derived one;
 *  - validation: a past due, a warn after due, an unknown policy and a decided approval are refused;
 *  - the queue sorts by priority and by due time.
 *
 * Everything this suite creates is scoped by RUN and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  approvalAssignments,
  approvalSlaPolicies,
  approvals,
  auditLog,
  createDb,
  eq,
  inArray,
  runMigrations,
  users,
  withSystemContext,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { APPROVAL_SLA_MACHINE, STATE_MACHINES, evaluateSla, slaTransitionAllowed } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runApprovalSlaSweep, scheduleApprovalTask, scheduleStageApprovals } from "./workbench.js";
import { SYSTEM_ATTRIBUTION_ID } from "./system-attribution.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e23s-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e23s-data-key-${RUN}`).digest("hex");
const HOUR = 3_600_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let requesterId: string;
let approverId: string;
let escalateToId: string;
let policyId: string;
const approvalIds: string[] = [];
let INSTANCE: string;

async function mkUser(label: string, admin = false) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e23s-${label}-${RUN}@example.com`, displayName: `e23s ${label}` } });
  const id = u.json().id as string;
  if (admin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

async function mkApproval(opts: { stageId?: string; status?: "pending" | "approved" } = {}): Promise<string> {
  const [row] = await db
    .insert(approvals)
    .values({
      userId: requesterId,
      objectType: "workflow",
      instanceId: opts.stageId ? INSTANCE : null,
      stageId: opts.stageId ?? null,
      approverUserId: approverId,
      status: opts.status ?? "pending",
    })
    .returning({ id: approvals.id });
  approvalIds.push(row!.id);
  return row!.id;
}

const assignmentOf = async (approvalId: string) =>
  (await db.select().from(approvalAssignments).where(eq(approvalAssignments.approvalId, approvalId)))[0]!;
const auditsOf = (approvalId: string) =>
  withSystemContext(db, "audit_verify", "test.e23s", async (tx) =>
    (await (tx as unknown as Db).select().from(auditLog).where(eq(auditLog.userId, adminId))).filter(
      (a) => (a.detail as Record<string, unknown>)?.approvalId === approvalId,
    ),
  );
const put = (id: string, payload: unknown, headers = adminKey) =>
  app.inject({ method: "PUT", url: `/v1/approvals/${id}/schedule`, headers, payload: payload as object });

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await useTestIssuerKey(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  ({ id: adminId, key: adminKey } = await mkUser("admin", true));
  requesterId = (await mkUser("requester")).id;
  approverId = (await mkUser("approver")).id;
  escalateToId = (await mkUser("escalate")).id;
  const [p] = await db
    .insert(approvalSlaPolicies)
    .values({ name: `e23s-${RUN}`, warnAfterMinutes: 60, breachAfterMinutes: 120, escalateAction: "add_assignee", escalateToKind: "user", escalateToId })
    .returning({ id: approvalSlaPolicies.id });
  policyId = p!.id;
  const [wi] = await db
    .insert(workflowInstances)
    .values({ templateIds: [], definition: {}, initiatorUserId: requesterId, change: { e23s: RUN }, state: {}, status: "blocked_on_approval" })
    .returning({ id: workflowInstances.id });
  INSTANCE = wi!.id;
}, 120_000);

afterAll(async () => {
  if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
  if (policyId) await db.delete(approvalSlaPolicies).where(eq(approvalSlaPolicies.id, policyId));
  if (INSTANCE) await db.delete(workflowInstances).where(eq(workflowInstances.id, INSTANCE));
  await restoreAdminKeyMfa?.(); // the deployment-wide MFA posture must not leak into later suites
  await app?.close();
});

describe("ADR-0342 slice 2: an admin schedules a task", () => {
  it("tightens through the route: priority, due and warn, audited; the assignment records the source", async () => {
    const id = await mkApproval();
    const due = new Date(Date.now() + 2 * HOUR);
    const warn = new Date(Date.now() + HOUR);
    const r = await put(id, { priority: "urgent", dueAt: due.toISOString(), warnAt: warn.toISOString() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().relaxations).toEqual([]);
    const a = await assignmentOf(id);
    expect(a.priority).toBe("urgent");
    expect(a.dueSource).toBe("explicit");
    expect(a.dueAt?.toISOString()).toBe(due.toISOString());
    expect(a.slaState).toBe("ok");
    const audits = await auditsOf(id);
    expect(audits.map((x) => x.ruleId)).toContain("approval-task-scheduled");
  });

  it("refuses a loosening without a step-up and leaves the task unchanged", async () => {
    const id = await mkApproval();
    expect((await put(id, { priority: "high" })).statusCode).toBe(200);
    const r = await put(id, { priority: "low" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("step_up_required");
    expect((await assignmentOf(id)).priority).toBe("high");
  });

  it("an authorised loosening is audited as a relaxation and re-arms a breached clock", async () => {
    const id = await mkApproval();
    const t0 = new Date();
    const set = await scheduleApprovalTask(db, id, { dueAt: new Date(t0.getTime() + HOUR) }, { source: "explicit", actorUserId: adminId, now: t0 });
    expect(set.ok).toBe(true);
    await runApprovalSlaSweep(db, { actorUserId: null, now: new Date(t0.getTime() + 2 * HOUR) });
    expect((await assignmentOf(id)).slaState).toBe("breached");
    const asked: string[][] = [];
    const later = new Date(t0.getTime() + 5 * HOUR);
    const out = await scheduleApprovalTask(db, id, { dueAt: later }, {
      source: "explicit",
      actorUserId: adminId,
      now: new Date(t0.getTime() + 2 * HOUR),
      authorizeRelaxation: async (r) => (asked.push(r), true),
    });
    expect(out.ok).toBe(true);
    expect(asked).toEqual([["due_later"]]);
    const a = await assignmentOf(id);
    expect(a.slaState).toBe("ok");
    expect(a.breachedAt).not.toBeNull(); // the breach stays on the record
    expect((await auditsOf(id)).map((x) => x.ruleId)).toContain("approval-task-schedule-relaxed");
    const refused = await scheduleApprovalTask(db, id, { dueAt: null }, { source: "explicit", actorUserId: adminId });
    expect(refused).toMatchObject({ ok: false, status: 403, error: "relaxation_not_authorized" });
  });

  it("validates: past due, warn after due, unknown policy, decided approval, empty body", async () => {
    const id = await mkApproval();
    expect((await put(id, { dueAt: new Date(Date.now() - HOUR).toISOString() })).statusCode).toBe(400);
    expect(
      (await put(id, { dueAt: new Date(Date.now() + HOUR).toISOString(), warnAt: new Date(Date.now() + 2 * HOUR).toISOString() })).statusCode,
    ).toBe(400);
    expect((await put(id, { slaPolicyId: randomUUID() })).statusCode).toBe(400);
    expect((await put(id, {})).statusCode).toBe(400);
    expect((await put(id, { priority: "nope" })).statusCode).toBe(400);
    const decided = await mkApproval({ status: "approved" });
    expect((await put(decided, { priority: "high" })).statusCode).toBe(409);
    expect((await put(randomUUID(), { priority: "high" })).statusCode).toBe(404);
  });
});

describe("ADR-0342 slice 2: the stage-timer contract (lane E21)", () => {
  it("schedules every pending task of a stage, only tightens, and breaches through the one ADR-0046 sweep", async () => {
    const a1 = await mkApproval({ stageId: `signoff-${RUN}` });
    const a2 = await mkApproval({ stageId: `signoff-${RUN}` });
    const t0 = new Date();
    const due = new Date(t0.getTime() + HOUR);
    // review S4 [1]: the policy adds an assignee on breach, so attaching it changes who decides: a timer may not
    const attach = await scheduleStageApprovals(
      db,
      { instanceId: INSTANCE, stageId: `signoff-${RUN}` },
      { slaPolicyId: policyId },
      { actorUserId: null, systemActor: "workflow-stage-timer", now: t0 },
    );
    expect(attach.map((o) => (o.outcome.ok ? "ok" : o.outcome.error))).toEqual(["stage_timer_cannot_relax", "stage_timer_cannot_relax"]);
    // an admin attaches it (an authorised settings_relax); the timer then sets the due time and priority
    for (const id of [a1, a2]) {
      const set = await scheduleApprovalTask(db, id, { slaPolicyId: policyId }, { source: "explicit", actorUserId: adminId, authorizeRelaxation: async () => true });
      expect(set.ok && set.relaxations).toEqual(["escalation_policy_attached"]);
    }
    const out = await scheduleStageApprovals(
      db,
      { instanceId: INSTANCE, stageId: `signoff-${RUN}` },
      { dueAt: due, priority: "high" },
      { actorUserId: null, systemActor: "workflow-stage-timer", now: t0 },
    );
    expect(out.map((o) => o.outcome.ok)).toEqual([true, true]);
    for (const id of [a1, a2]) {
      const a = await assignmentOf(id);
      expect(a.dueSource).toBe("stage_timer");
      expect(a.priority).toBe("high");
      // review S4 [3]: the timer's change is the system's act, never the requester's
      const timerAudits = await withSystemContext(db, "audit_verify", "test.e23s", async (tx) =>
        (await (tx as unknown as Db).select().from(auditLog).where(eq(auditLog.ruleId, "approval-task-scheduled"))).filter(
          (r) => (r.detail as Record<string, unknown>)?.approvalId === id && (r.detail as Record<string, unknown>)?.source === "stage_timer",
        ),
      );
      expect(timerAudits.length).toBeGreaterThanOrEqual(1);
      for (const r of timerAudits) {
        expect(r.userId).toBe(SYSTEM_ATTRIBUTION_ID);
        expect((r.detail as Record<string, unknown>).actor).toBe("workflow-stage-timer");
      }
    }
    // a timer may never loosen
    const loosen = await scheduleStageApprovals(
      db,
      { instanceId: INSTANCE, stageId: `signoff-${RUN}` },
      { priority: "normal" },
      { actorUserId: null, systemActor: "workflow-stage-timer" },
    );
    expect(loosen.map((o) => (o.outcome.ok ? "ok" : o.outcome.error))).toEqual(["stage_timer_cannot_relax", "stage_timer_cannot_relax"]);
    // the due time passes: the ordinary sweep breaches it and escalates to the policy's target
    const swept = await runApprovalSlaSweep(db, { actorUserId: null, now: new Date(due.getTime() + 60_000) });
    expect(swept.breached).toBeGreaterThanOrEqual(2);
    for (const id of [a1, a2]) {
      const a = await assignmentOf(id);
      expect(a.slaState).toBe("breached");
      expect(a.escalationAssigneeId).toBe(escalateToId);
    }
  });
});

describe("ADR-0342 slice 2: review fixes (R4, S4)", () => {
  it("R4 [1]: concurrent schedules serialise, so a priority-only call never writes back a stale due time", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await mkApproval();
      const base = new Date(Date.now() + 4 * HOUR);
      expect((await scheduleApprovalTask(db, id, { dueAt: base }, { source: "explicit", actorUserId: adminId })).ok).toBe(true);
      const earlier = new Date(base.getTime() - 2 * HOUR);
      const [timer, admin] = await Promise.all([
        scheduleApprovalTask(db, id, { dueAt: earlier }, { source: "stage_timer", actorUserId: null, systemActor: "workflow-stage-timer" }),
        scheduleApprovalTask(db, id, { priority: "urgent" }, { source: "explicit", actorUserId: adminId }),
      ]);
      expect([timer.ok, admin.ok]).toEqual([true, true]);
      const a = await assignmentOf(id);
      expect(a.dueAt?.getTime()).toBe(earlier.getTime());
      expect(a.priority).toBe("urgent");
    }
  });

  it("S4 [1]: attaching a policy that changes who decides is a relaxation; a notify-only policy is not", async () => {
    const [n] = await db
      .insert(approvalSlaPolicies)
      .values({ name: `e23s-notify-${RUN}`, warnAfterMinutes: 60, breachAfterMinutes: 120, escalateAction: "notify_only" })
      .returning({ id: approvalSlaPolicies.id });
    try {
      const id = await mkApproval();
      const refused = await scheduleApprovalTask(db, id, { slaPolicyId: policyId }, { source: "explicit", actorUserId: adminId });
      expect(refused).toMatchObject({ ok: false, status: 403, error: "relaxation_not_authorized", detail: "escalation_policy_attached" });
      expect((await assignmentOf(id)).slaPolicyId).toBeNull();
      const notify = await scheduleApprovalTask(db, id, { slaPolicyId: n!.id }, { source: "stage_timer", actorUserId: null, systemActor: "workflow-stage-timer" });
      expect(notify.ok && notify.relaxations).toEqual([]);
      expect((await assignmentOf(id)).slaPolicyId).toBe(n!.id);
    } finally {
      await db.update(approvalAssignments).set({ slaPolicyId: null }).where(eq(approvalAssignments.slaPolicyId, n!.id));
      await db.delete(approvalSlaPolicies).where(eq(approvalSlaPolicies.id, n!.id));
    }
  });
});

describe("ADR-0342 slice 2: the queue", () => {
  it("sorts by priority and by due time", async () => {
    const low = await mkApproval();
    const urgent = await mkApproval();
    expect((await put(urgent, { priority: "urgent" })).statusCode).toBe(200);
    expect((await scheduleApprovalTask(db, low, { priority: "high" }, { source: "explicit", actorUserId: adminId })).ok).toBe(true);
    expect(
      (await scheduleApprovalTask(db, low, { priority: "low" }, { source: "explicit", actorUserId: adminId, authorizeRelaxation: async () => true })).ok,
    ).toBe(true);
    const r = await app.inject({ method: "GET", headers: adminKey, url: `/v1/approvals?status=pending&sort=priority&dir=desc&limit=500` });
    expect(r.statusCode, r.body).toBe(200);
    const order = (r.json().items as Array<{ id: string }>).map((x) => x.id).filter((x) => x === low || x === urgent);
    expect(order).toEqual([urgent, low]);
    const d = await app.inject({ method: "GET", headers: adminKey, url: `/v1/approvals?status=pending&sort=due&dir=asc&limit=500` });
    expect(d.statusCode, d.body).toBe(200);
  });
});

describe("ADR-0342 slice 2: the declared SLA transition table (rule 12)", () => {
  it("the ADR-0046 clock only makes `clock` transitions, and a reschedule only re-arms", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    const at = (m: number) => new Date(now.getTime() + m * 60_000);
    for (const stored of ["ok", "warning", "breached"] as const) {
      for (const [warnAt, dueAt] of [[at(-20), at(-10)], [at(-10), at(10)], [at(10), at(20)], [null, at(-1)], [null, null]] as const) {
        const v = evaluateSla({ warnAt, dueAt, slaState: stored }, now);
        if (v.state !== stored) expect([stored, v.state, slaTransitionAllowed("clock", stored, v.state)]).toEqual([stored, v.state, true]);
      }
    }
    expect(STATE_MACHINES[APPROVAL_SLA_MACHINE.def.id]).toBe(APPROVAL_SLA_MACHINE);
    expect(slaTransitionAllowed("reschedule", "ok", "warning")).toBe(false);
    expect(APPROVAL_SLA_MACHINE.sourcesOf("rearm_ok")).toEqual(["warning", "breached"]);
    expect(slaTransitionAllowed("reschedule", "breached", "ok")).toBe(true);
    expect(slaTransitionAllowed("reschedule", "ok", "breached")).toBe(false);
    expect(slaTransitionAllowed("clock", "breached", "ok")).toBe(false);
  });
});

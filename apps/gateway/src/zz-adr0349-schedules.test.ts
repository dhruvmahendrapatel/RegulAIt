/**
 * ADR-0349 slice 4 (lane E30): workflow schedules. A template starts on a cron calendar AS the admin who created the
 * schedule, through the governed start; each fire time starts at most once; overlap, catch-up, jitter, pause, resume
 * and backfill behave as the ADR says, and every one of them is audited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, sql, workflowInstances, workflowScheduleRuns, workflowSchedules, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { adminsOtherThan } from "./workflow-approvers.js";
import { fireTimesBetween, jitterMs, nextFireAfter, runWorkflowScheduleSweep, validateCalendar } from "./workflow-schedules.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e30-sch-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now().toString(36);

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreStepUp: (() => Promise<void>) | undefined;
let admin: { id: string; auth: { authorization: string } };
let templateId: string;

const change = { description: `e30 scheduled ${RUN}`, paths: [], changeType: `e30-sched-${RUN}`, environment: "dev" };
const create = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: admin.auth, url: "/v1/workflows/schedules", payload: { templateId, change, cronExpression: "0 * * * *", ...payload } });
const runsOf = (id: string) => db.select().from(workflowScheduleRuns).where(eq(workflowScheduleRuns.scheduleId, id)).orderBy(workflowScheduleRuns.fireAt);
const rowOf = async (id: string) => (await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id)))[0]!;
const audits = async (id: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, ruleId)));
/** move a schedule's next fire to `at` (a test stands in for the passage of time) */
const dueAt = (id: string, at: Date) => db.update(workflowSchedules).set({ nextFireAt: at }).where(eq(workflowSchedules.id, id));
const abortAll = async (scheduleId: string) => {
  for (const r of await runsOf(scheduleId)) {
    if (r.instanceId) await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/instances/${r.instanceId}/abort` });
  }
};
const HOUR = 3600_000;
const topOfHour = (d: Date) => new Date(Math.floor(d.getTime() / HOUR) * HOUR);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e30-sch-${RUN}@example.com`, displayName: "sched admin", isAdmin: true } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  admin = { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: { name: `e30-sched-${RUN}`, definition: { workflow: `e30-sched-${RUN}`, stages: [{ id: "intake", type: "trigger" }, { id: "req", type: "artifact_generation", output: "requirements" }] } },
  });
  expect(tpl.statusCode).toBe(201);
  templateId = tpl.json().id;
});

afterAll(async () => {
  await restoreStepUp?.();
  await restoreIdentity?.();
  await app.close();
});

describe("ADR-0349 slice 4: the calendar", () => {
  it("validates the expression and zone, and refuses more often than every 5 minutes", () => {
    const from = new Date("2026-11-17T00:00:00Z");
    expect(() => validateCalendar("0 9 * * 1-5", "Europe/London", from)).not.toThrow();
    expect(() => validateCalendar("* * * * *", "UTC", from)).toThrow(/at most once every 5 minutes/);
    expect(() => validateCalendar("0 9 * * *", "Mars/Olympus", from)).toThrow(/unknown time zone/);
    expect(() => validateCalendar("0 9 * *", "UTC", from)).toThrow(/five fields/);
    expect(() => validateCalendar("61 9 * * *", "UTC", from)).toThrow(/does not parse/);
  });

  it("computes fire times in the schedule's zone, and a deterministic bounded jitter", () => {
    // 09:00 in London in November is 09:00 UTC; in New York it is 14:00 UTC
    expect(nextFireAfter("0 9 * * *", "America/New_York", new Date("2026-11-17T00:00:00Z")).toISOString()).toBe("2026-11-17T14:00:00.000Z");
    expect(fireTimesBetween("0 * * * *", "UTC", new Date("2026-11-17T00:00:00Z"), new Date("2026-11-17T03:00:00Z"), 10)).toHaveLength(3);
    const t = new Date("2026-11-17T09:00:00Z");
    expect(jitterMs("a", t, 0)).toBe(0);
    expect(jitterMs("a", t, 60)).toBe(jitterMs("a", t, 60));
    expect(jitterMs("a", t, 60)).toBeLessThanOrEqual(60_000);
  });
});

describe("ADR-0349 slice 4: schedules", () => {
  it("refuses a bad calendar, an unknown template and an unauthorised relaxation", async () => {
    expect((await create({ name: `bad-${RUN}`, cronExpression: "*/2 * * * *" })).statusCode).toBe(422);
    expect((await create({ name: `bad-${RUN}`, templateId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    // a non-admin cannot reach the routes at all
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e30-sch-nb-${RUN}@example.com`, displayName: "nb" } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
    const res = await app.inject({ method: "GET", headers: { authorization: `Bearer ${k.json().token}` }, url: "/v1/workflows/schedules" });
    expect(res.statusCode).toBe(403);
  });

  it("starts its template on the calendar as its creator, once per fire time", async () => {
    const res = await create({ name: `hourly-${RUN}` });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ state: "active", overlapPolicy: "skip", runAsUserId: admin.id });
    expect(new Date(s.nextFireAt).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(await audits(s.id, "workflow:schedule-created")).toHaveLength(1);

    const fire = topOfHour(new Date(Date.now() - 2 * HOUR));
    await dueAt(s.id, fire);
    const now = new Date(fire.getTime() + 60_000);
    const out = await runWorkflowScheduleSweep(db, undefined, { now });
    expect(out.fired).toBe(1);
    const runs = await runsOf(s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "started", trigger: "scheduled" });
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, runs[0]!.instanceId!));
    expect(inst!.initiatorUserId).toBe(admin.id);
    expect(inst!.templateIds).toEqual([templateId]);
    expect(await audits(s.id, "workflow:schedule-fired")).toHaveLength(1);
    // the claim moved on: the same pass again starts nothing
    expect((await runWorkflowScheduleSweep(db, undefined, { now })).fired).toBe(0);
    expect((await rowOf(s.id)).nextFireAt!.getTime()).toBe(fire.getTime() + HOUR);

    // overlap skip: the instance is still open at the next fire
    const next = new Date(fire.getTime() + HOUR + 60_000);
    await runWorkflowScheduleSweep(db, undefined, { now: next });
    expect((await runsOf(s.id)).map((r) => r.outcome)).toEqual(["started", "skipped_overlap"]);
    expect(await audits(s.id, "workflow:schedule-fire-skipped")).toHaveLength(1);
    await abortAll(s.id);
  });

  it("records fire times missed beyond the catch-up window and starts none of them", async () => {
    const s = (await create({ name: `missed-${RUN}` })).json();
    const fire = topOfHour(new Date(Date.now() - 6 * HOUR));
    await dueAt(s.id, fire);
    // three hours later, with the default window: the fires at +0h, +1h and +2h are missed; +3h is on time
    const now = new Date(fire.getTime() + 3 * HOUR + 60_000);
    const out = await runWorkflowScheduleSweep(db, undefined, { now });
    expect(out.skippedMissed).toBe(3);
    expect((await runsOf(s.id)).map((r) => r.outcome)).toEqual(["skipped_missed", "skipped_missed", "skipped_missed", "started"]);
    expect(await audits(s.id, "workflow:schedule-fires-missed")).toHaveLength(1);
    await abortAll(s.id);
  });

  it("a catch-up window starts the missed fire times oldest first (with overlap allowed, a step-up)", async () => {
    restoreStepUp = await relaxStepUpForTest(db);
    const s = (await create({ name: `catchup-${RUN}`, catchupWindowSeconds: 4 * 3600, overlapPolicy: "allow" })).json();
    expect(s.overlapPolicy).toBe("allow");
    expect((await audits(s.id, "workflow:schedule-created"))[0]!.detail).toMatchObject({ relaxed: ["overlapPolicy"] });
    const fire = topOfHour(new Date(Date.now() - 6 * HOUR));
    await dueAt(s.id, fire);
    await runWorkflowScheduleSweep(db, undefined, { now: new Date(fire.getTime() + 2 * HOUR + 60_000) });
    expect((await runsOf(s.id)).map((r) => r.outcome)).toEqual(["started", "started", "started"]);
    await abortAll(s.id);
  });

  it("pause and resume take a note and are audited; a paused schedule never fires", async () => {
    const s = (await create({ name: `pause-${RUN}` })).json();
    expect((await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/pause`, payload: {} })).statusCode).toBe(400);
    const p = await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/pause`, payload: { note: "freeze for the release" } });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ state: "paused", pauseNote: "freeze for the release", nextFireAt: null });
    expect((await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/pause`, payload: { note: "again" } })).statusCode).toBe(409);
    await db.update(workflowSchedules).set({ nextFireAt: new Date(Date.now() - HOUR) }).where(eq(workflowSchedules.id, s.id));
    await runWorkflowScheduleSweep(db, undefined, {});
    expect(await runsOf(s.id)).toHaveLength(0);
    const r = await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/resume`, payload: { note: "release done" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().state).toBe("active");
    expect(new Date(r.json().nextFireAt).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(await audits(s.id, "workflow:schedule-paused")).toHaveLength(1);
    expect(await audits(s.id, "workflow:schedule-resumed")).toHaveLength(1);
  });

  it("a refused start pauses the schedule with the reason (a retired template)", async () => {
    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: { name: `e30-sched-retire-${RUN}`, definition: { workflow: `e30-sched-retire-${RUN}`, stages: [{ id: "intake", type: "trigger" }, { id: "req", type: "artifact_generation", output: "r" }] } },
    });
    const s = (await create({ name: `retire-${RUN}`, templateId: tpl.json().id })).json();
    const retire = await app.inject({ method: "POST", headers: AUTH, url: `/v1/workflows/templates/${tpl.json().id}/retire`, payload: { reason: "replaced by v2" } });
    expect(retire.statusCode).toBe(200);
    const fire = topOfHour(new Date(Date.now() - HOUR));
    await dueAt(s.id, fire);
    await runWorkflowScheduleSweep(db, undefined, { now: new Date(fire.getTime() + 60_000) });
    expect((await runsOf(s.id))[0]).toMatchObject({ outcome: "refused", refusal: "template_retired" });
    const row = await rowOf(s.id);
    expect(row.pausedAt).not.toBeNull();
    expect(row.pauseNote).toMatch(/template_retired/);
  });

  it("backfills a past range once per fire time, under the overlap policy, audited", async () => {
    const s = (await create({ name: `backfill-${RUN}` })).json();
    const to = topOfHour(new Date(Date.now() - 2 * HOUR));
    const from = new Date(to.getTime() - 2 * HOUR);
    const b = await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/backfill`, payload: { from: from.toISOString(), to: to.toISOString(), note: "missed during the outage" } });
    expect(b.statusCode).toBe(200);
    expect(b.json().fireTimes).toBe(3);
    // skip: the first starts, the next two find it open
    expect((await runsOf(s.id)).map((r) => r.outcome)).toEqual(["started", "skipped_overlap", "skipped_overlap"]);
    // a second backfill of the same range starts nothing twice
    const again = await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/backfill`, payload: { from: from.toISOString(), to: to.toISOString(), note: "again" } });
    expect(again.json().results.every((r: { outcome: string }) => r.outcome === "already_fired" || r.outcome === "skipped_overlap")).toBe(true);
    expect(await runsOf(s.id)).toHaveLength(3);
    expect(await audits(s.id, "workflow:schedule-backfill")).toHaveLength(2);
    const tooBig = await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/schedules/${s.id}/backfill`, payload: { from: new Date(Date.now() - 200 * HOUR).toISOString(), to: to.toISOString(), note: "x" } });
    expect(tooBig.statusCode).toBe(422);
    await abortAll(s.id);
  });

  it("an edit by another admin re-binds the run-as user, so the editor cannot also be the 'other admin' approver", async () => {
    // review finding (four-eyes): admin B rewrites admin A's schedule, then would approve the instance as "the other admin"
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e30-sch-b-${RUN}@example.com`, displayName: "admin b", isAdmin: true } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
    const bob = { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
    const s = (await create({ name: `rebind-${RUN}` })).json();
    expect(s.runAsUserId).toBe(admin.id);
    const patch = (headers: Record<string, string>, payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", headers, url: `/v1/workflows/schedules/${s.id}`, payload });

    // the bootstrap identity cannot edit or backfill one: a schedule runs as a named admin
    expect((await patch(AUTH, { change: { ...change, description: "boot" } })).json().error).toBe("bootstrap_cannot_schedule");
    // a rename by another admin changes nothing about who it runs as
    const renamed = await patch(bob.auth, { name: `rebind-renamed-${RUN}` });
    expect(renamed.json(), JSON.stringify(renamed.json())).toMatchObject({ runAsUserId: admin.id });
    // only the run-as user may backfill it
    const to = topOfHour(new Date(Date.now() - 2 * HOUR));
    const bf = await app.inject({ method: "POST", headers: bob.auth, url: `/v1/workflows/schedules/${s.id}/backfill`, payload: { from: new Date(to.getTime() - HOUR).toISOString(), to: to.toISOString(), note: "b" } });
    expect(bf.statusCode).toBe(403);
    expect(bf.json().error).toBe("schedule_run_as_only");

    // B changes what it starts: the schedule now runs as B, audited with both identities
    const edited = await patch(bob.auth, { change: { ...change, description: `edited by b ${RUN}` } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().runAsUserId).toBe(bob.id);
    const [upd] = (await audits(s.id, "workflow:schedule-updated")).filter((a) => (a.detail as { runAsRebound?: unknown }).runAsRebound);
    expect(upd!.detail).toMatchObject({ runAsRebound: { from: admin.id, to: bob.id } });

    // the next fire starts B's change with B as its initiator, so B is not among the admins who may sign it off
    const fire = topOfHour(new Date(Date.now() - HOUR));
    await dueAt(s.id, fire);
    await runWorkflowScheduleSweep(db, undefined, { now: new Date(fire.getTime() + 60_000) });
    const [run] = await runsOf(s.id);
    expect(run).toMatchObject({ outcome: "started" });
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, run!.instanceId!));
    expect(inst!.initiatorUserId).toBe(bob.id);
    const approvers = await adminsOtherThan(db, inst!.initiatorUserId);
    expect(approvers).not.toContain(bob.id);
    expect(approvers).toContain(admin.id);
    await app.inject({ method: "POST", headers: bob.auth, url: `/v1/workflows/instances/${run!.instanceId}/abort` });
  });

  it("a jitter larger than the catch-up window still starts the fire on time (review finding)", async () => {
    const s = (await create({ name: `jitter-${RUN}`, jitterSeconds: 1800 })).json();
    // a fire time whose jitter is well past the 5-minute grace
    let fire = topOfHour(new Date(Date.now() - 48 * HOUR));
    while (jitterMs(s.id, fire, 1800) < 10 * 60_000) fire = new Date(fire.getTime() + HOUR);
    const j = jitterMs(s.id, fire, 1800);
    await dueAt(s.id, fire);
    // before its jittered time nothing fires and the claim does not move
    expect((await runWorkflowScheduleSweep(db, undefined, { now: new Date(fire.getTime() + j - 60_000) })).fired).toBe(0);
    expect((await rowOf(s.id)).nextFireAt!.getTime()).toBe(fire.getTime());
    // one sweep tick after it, the fire starts: it is not recorded as missed
    const out = await runWorkflowScheduleSweep(db, undefined, { now: new Date(fire.getTime() + j + 60_000) });
    expect(out.skippedMissed).toBe(0);
    expect((await runsOf(s.id)).map((r) => r.outcome)).toEqual(["started"]);
    await abortAll(s.id);
  });

  it("lists schedules with keyset pagination", async () => {
    const first = await app.inject({ method: "GET", headers: admin.auth, url: "/v1/workflows/schedules?limit=2" });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);
    expect(first.json().schedules).toHaveLength(2);
    const second = await app.inject({ method: "GET", headers: admin.auth, url: `/v1/workflows/schedules?limit=2&after=${first.json().next}` });
    expect(second.json().schedules[0].id > first.json().schedules[1].id).toBe(true);
    void sql;
  });
});

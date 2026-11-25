/**
 * ADR-0349 slice 4 (lane E30, Temporal Schedules): a workflow template that starts on a calendar.
 *
 * - **Who it runs as.** The admin who created it, or the admin who last changed what or when it starts
 *   (`run_as_user_id`): an edit to the change, project, work item, calendar, overlap, catch-up or jitter by another
 *   admin re-binds it to that editor, audited, so the person who chose a start is its initiator and cannot also be
 *   its "other admin" approver. Only the run-as user may backfill it. Every start is `startGovernedWorkflow` as that
 *   person, the same path as `POST /v1/workflows/instances`: entitlements, project attribution, the compliance
 *   cascade, the start conflict policy and the audit rows. A schedule never runs as a system identity. A run-as user
 *   who is disabled or no longer an admin, a retired template, or a refused start PAUSES the schedule, with the reason
 *   as its note, audited.
 * - **Driver.** One ADR-0064 scheduler job (`workflow-schedules`) under its database lease, plus the same sweep from
 *   `POST /v1/workflows/schedules/run-due`. Each fire time is claimed compare-and-swap on `next_fire_at` and recorded
 *   in `workflow_schedule_runs`, unique on (schedule, fire time): a fire time starts at most once.
 * - **Overlap.** `skip` (default) records the fire as `skipped_overlap` while the previous instance is open;
 *   `buffer_one` keeps one fire time and starts it once the open instance ends; `allow` starts anyway. Both relaxations
 *   need a `settings_relax` step-up and are audited.
 * - **Catch-up.** A fire time older than the window (at least the sweep's 5-minute grace) is recorded `skipped_missed`,
 *   once per pass, never started; newer ones start oldest first, at most 20 per schedule per pass.
 * - **Jitter.** 0..`jitter_seconds`, deterministic from the schedule id and the fire time (`fnv1a32`). A fire time is
 *   due at its jittered time, and the catch-up window is measured from there.
 * - **Run rows.** `workflow_schedule_runs.outcome` follows `WORKFLOW_SCHEDULE_RUN_MACHINE` (ADR-0348): `starting`
 *   settles once, to started, reused or refused; every other outcome is final as recorded.
 * - **Pause, resume, backfill.** Each takes a note and is audited. Resume restarts the calendar from now (fires missed
 *   while paused are not caught up). Backfill starts one instance per fire time in a range, at most 100, under the
 *   overlap policy.
 * - **Cron.** cron-parser (MIT), already in the tree through pg-boss, now a direct exact pin. A schedule that would
 *   fire more often than every 5 minutes is refused.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
  users,
  workflowInstances,
  workflowScheduleRuns,
  workflowSchedules,
  workflowTemplates,
  WORKFLOW_SCHEDULE_OVERLAP_POLICIES,
  type Db,
  type WorkflowScheduleRow,
} from "@regulait/db";
import { changeDescriptorSchema, fnv1a32, startInstanceSchema, WORKFLOW_SCHEDULE_RUN_MACHINE } from "@regulait/shared";
import { databaseNow } from "./db-clock.js";
import { errMessage } from "./err-serializer.js";
import { whereFrom } from "./state-transition.js";
import { requireStepUp } from "./step-up.js";
import { startGovernedWorkflow } from "./workflows.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const WORKFLOW_SCHEDULES_JOB_NAME = "workflow-schedules";
/** the shortest gap between two fire times a schedule may have */
export const MIN_FIRE_INTERVAL_MS = 5 * 60_000;
/** a fire time this recent is on time, whatever the catch-up window */
export const SWEEP_GRACE_MS = 5 * 60_000;
export const MAX_FIRES_PER_PASS = 20;
export const MAX_BACKFILL = 100;
const TERMINAL = ["completed", "aborted", "denied", "rolled_back"];
const NIL_USER = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// The calendar (pure)
// ---------------------------------------------------------------------------

export class ScheduleCalendarError extends Error {}

/** is `tz` an IANA zone this runtime knows (checked without a regex on caller input, M-074) */
function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate a cron expression and zone; refuse one that fires more often than every 5 minutes. */
export function validateCalendar(cronExpression: string, timeZone: string, from: Date): void {
  if (!knownTimeZone(timeZone)) throw new ScheduleCalendarError(`unknown time zone '${timeZone}'`);
  if (cronExpression.trim().split(/\s+/).length !== 5) {
    throw new ScheduleCalendarError("cronExpression must have five fields: minute hour day-of-month month day-of-week");
  }
  let times: Date[];
  try {
    times = CronExpressionParser.parse(cronExpression, { currentDate: from, tz: timeZone, strict: false })
      .take(12)
      .map((d) => d.toDate());
  } catch (err) {
    throw new ScheduleCalendarError(`cronExpression does not parse: ${errMessage(err)}`);
  }
  if (times.length === 0) throw new ScheduleCalendarError("cronExpression never fires");
  for (let i = 1; i < times.length; i++) {
    if (times[i]!.getTime() - times[i - 1]!.getTime() < MIN_FIRE_INTERVAL_MS) {
      throw new ScheduleCalendarError("a schedule may fire at most once every 5 minutes");
    }
  }
}

/** the first fire time strictly after `after` */
export function nextFireAfter(cronExpression: string, timeZone: string, after: Date): Date {
  return CronExpressionParser.parse(cronExpression, { currentDate: after, tz: timeZone }).next().toDate();
}

/** fire times in (from, to], oldest first, at most `limit` */
export function fireTimesBetween(cronExpression: string, timeZone: string, from: Date, to: Date, limit: number): Date[] {
  const it = CronExpressionParser.parse(cronExpression, { currentDate: from, endDate: to, tz: timeZone });
  const out: Date[] = [];
  while (out.length < limit && it.hasNext()) out.push(it.next().toDate());
  return out;
}

/** the deterministic delay of one fire, 0..jitterSeconds */
export function jitterMs(scheduleId: string, fireAt: Date, jitterSeconds: number): number {
  if (jitterSeconds <= 0) return 0;
  return (fnv1a32(`${scheduleId}:${fireAt.toISOString()}`) % (jitterSeconds + 1)) * 1000;
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

type RunTrigger = "scheduled" | "buffered" | "backfill";
type RunOutcome = "started" | "reused" | "skipped_overlap" | "buffered" | "skipped_missed" | "refused";

async function audit(
  db: Db,
  s: Pick<WorkflowScheduleRow, "id">,
  userId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: userId ?? NIL_USER,
    objectType: "workflow",
    objectId: s.id,
    detail: { scheduleId: s.id, ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** pause a schedule because a fire could not run (the note says why), audited */
async function pauseForFailure(db: Db, s: WorkflowScheduleRow, note: string, detail: Record<string, unknown>): Promise<void> {
  await db
    .update(workflowSchedules)
    .set({ pausedAt: sql`now()`, pausedByUserId: null, pauseNote: note, nextFireAt: null, bufferedFireAt: null, updatedAt: sql`now()` })
    .where(and(eq(workflowSchedules.id, s.id), isNull(workflowSchedules.pausedAt)));
  await audit(db, s, null, "workflow:schedule-paused", "deny", `workflow schedule '${s.name}' paused: ${note}`, { ...detail, note, by: "fire" });
}

/** is the schedule's most recent started instance still open */
async function openInstanceOf(db: Db, scheduleId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: workflowInstances.id })
    .from(workflowScheduleRuns)
    .innerJoin(workflowInstances, eq(workflowInstances.id, workflowScheduleRuns.instanceId))
    .where(
      and(
        eq(workflowScheduleRuns.scheduleId, scheduleId),
        inArray(workflowScheduleRuns.outcome, ["started", "reused"]),
        sql`${workflowInstances.status} NOT IN (${sql.join(TERMINAL.map((t) => sql`${t}`), sql`, `)})`,
      ),
    )
    .orderBy(desc(workflowScheduleRuns.fireAt))
    .limit(1);
  return row?.id ?? null;
}

async function recordRun(
  db: Db,
  s: WorkflowScheduleRow,
  fireAt: Date,
  trigger: RunTrigger,
  outcome: RunOutcome | "starting",
): Promise<string | null> {
  const [row] = await db
    .insert(workflowScheduleRuns)
    .values({ scheduleId: s.id, fireAt, trigger, outcome })
    .onConflictDoNothing({ target: [workflowScheduleRuns.scheduleId, workflowScheduleRuns.fireAt] })
    .returning({ id: workflowScheduleRuns.id });
  return row?.id ?? null;
}

export interface FireResult {
  outcome: RunOutcome | "already_fired";
  instanceId?: string;
  refusal?: string;
}

/**
 * Fire one fire time of a schedule: the overlap policy, the exactly-once run row, then the governed start as the
 * run-as user. The caller has already claimed the fire time (the sweep's compare-and-swap) or is a backfill.
 */
export async function fireSchedule(
  db: Db,
  dataKey: string | undefined,
  s: WorkflowScheduleRow,
  fireAt: Date,
  trigger: RunTrigger,
): Promise<FireResult> {
  if (s.overlapPolicy !== "allow") {
    const open = await openInstanceOf(db, s.id);
    if (open) {
      if (s.overlapPolicy === "buffer_one" && trigger !== "buffered") {
        // keep one: a later fire replaces nothing, the first one waiting is the one that starts
        await db
          .update(workflowSchedules)
          .set({ bufferedFireAt: sql`coalesce(${workflowSchedules.bufferedFireAt}, ${fireAt.toISOString()}::timestamptz)`, updatedAt: sql`now()` })
          .where(eq(workflowSchedules.id, s.id));
        if (!(await recordRun(db, s, fireAt, trigger, "buffered"))) return { outcome: "already_fired" };
        await audit(db, s, s.runAsUserId, "workflow:schedule-fire-buffered", "allow", `workflow schedule '${s.name}': the previous instance is still open, so this fire waits for it`, { fireAt, openInstanceId: open });
        return { outcome: "buffered" };
      }
      if (trigger === "buffered") return { outcome: "buffered" };
      if (!(await recordRun(db, s, fireAt, trigger, "skipped_overlap"))) return { outcome: "already_fired" };
      await audit(db, s, s.runAsUserId, "workflow:schedule-fire-skipped", "deny", `workflow schedule '${s.name}': the previous instance is still open, so this fire was skipped (overlap policy ${s.overlapPolicy})`, { fireAt, openInstanceId: open, overlapPolicy: s.overlapPolicy });
      return { outcome: "skipped_overlap" };
    }
  }

  const runId = await recordRun(db, s, fireAt, trigger, "starting");
  if (!runId) return { outcome: "already_fired" };
  // ADR-0348: the run row settles through its declared lifecycle (WORKFLOW_SCHEDULE_RUN_MACHINE), only from `starting`
  const finishRun = async (outcome: "started" | "reused" | "refused", instanceId: string | null, refusal: string | null) => {
    const event = outcome === "started" ? "start" : outcome === "reused" ? "reuse" : "refuse";
    await db
      .update(workflowScheduleRuns)
      .set({ outcome, instanceId, refusal, updatedAt: sql`now()` })
      .where(and(eq(workflowScheduleRuns.id, runId), whereFrom(workflowScheduleRuns.outcome, WORKFLOW_SCHEDULE_RUN_MACHINE, event)));
  };

  const [runAs] = await db
    .select({ id: users.id, isAdmin: users.isAdmin, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, s.runAsUserId));
  if (!runAs || runAs.disabledAt || !runAs.isAdmin) {
    const why = !runAs ? "run_as_user_missing" : runAs.disabledAt ? "run_as_user_disabled" : "run_as_user_not_admin";
    await finishRun("refused", null, why);
    await pauseForFailure(db, s, `its run-as user can no longer start it (${why}); an admin must take it over (an edit re-binds it to the editing admin) or recreate it`, { fireAt, refusal: why });
    return { outcome: "refused", refusal: why };
  }

  const body = startInstanceSchema.safeParse({
    change: s.change,
    templateId: s.templateId,
    ...(s.projectId ? { projectId: s.projectId } : {}),
    ...(s.workItemRef ? { workItem: s.workItemRef } : {}),
  });
  if (!body.success) {
    await finishRun("refused", null, "invalid_change");
    await pauseForFailure(db, s, "its stored change no longer validates; an admin must edit it", { fireAt, refusal: "invalid_change" });
    return { outcome: "refused", refusal: "invalid_change" };
  }
  const out = await startGovernedWorkflow(db, dataKey, { userId: runAs.id, isAdmin: true }, body.data);
  const answer = (out.body ?? {}) as { id?: string; reused?: boolean; error?: string };
  if ((out.status === 201 || out.status === 200) && answer.id) {
    const outcome = answer.reused ? "reused" : "started";
    await finishRun(outcome, answer.id, null);
    await audit(db, s, runAs.id, "workflow:schedule-fired", "allow", `workflow schedule '${s.name}' started an instance (${trigger})`, { fireAt, trigger, instanceId: answer.id, outcome });
    return { outcome, instanceId: answer.id };
  }
  const refusal = typeof answer.error === "string" ? answer.error.slice(0, 200) : `http_${out.status}`;
  await finishRun("refused", null, refusal);
  // a conflict with an instance already open is the schedule's overlap, not a broken schedule: it stays active
  if (refusal === "workflow_start_conflict") {
    await audit(db, s, runAs.id, "workflow:schedule-fire-refused", "deny", `workflow schedule '${s.name}': the start was refused (${refusal})`, { fireAt, trigger, refusal });
  } else {
    await pauseForFailure(db, s, `a start was refused (${refusal}); an admin must fix the cause and resume it`, { fireAt, trigger, refusal, status: out.status });
  }
  return { outcome: "refused", refusal };
}

export interface ScheduleSweepResult {
  due: number;
  fired: number;
  skippedMissed: number;
  buffered: number;
}

/** Fire every due schedule (and every buffered fire whose open instance has ended). */
export async function runWorkflowScheduleSweep(db: Db, dataKey: string | undefined, opts: { now?: Date } = {}): Promise<ScheduleSweepResult> {
  const now = opts.now ?? (await databaseNow(db));
  const out: ScheduleSweepResult = { due: 0, fired: 0, skippedMissed: 0, buffered: 0 };

  // buffered fires first: the open instance they waited on may have ended
  const waiting = await db
    .select()
    .from(workflowSchedules)
    .where(and(isNull(workflowSchedules.pausedAt), isNotNull(workflowSchedules.bufferedFireAt)))
    .limit(200);
  for (const s of waiting) {
    if (await openInstanceOf(db, s.id)) continue;
    const [claimed] = await db
      .update(workflowSchedules)
      .set({ bufferedFireAt: null, updatedAt: sql`now()` })
      .where(and(eq(workflowSchedules.id, s.id), eq(workflowSchedules.bufferedFireAt, s.bufferedFireAt!)))
      .returning();
    if (!claimed) continue;
    // the buffered fire time already has its `buffered` row: the start is recorded at the moment it runs
    const r = await fireSchedule(db, dataKey, claimed, now, "buffered");
    if (r.outcome === "started" || r.outcome === "reused") out.fired++;
  }

  const due = await db
    .select()
    .from(workflowSchedules)
    .where(and(isNull(workflowSchedules.pausedAt), lte(workflowSchedules.nextFireAt, now)))
    .orderBy(asc(workflowSchedules.nextFireAt))
    .limit(200);
  out.due = due.length;
  for (const s of due) {
    const first = s.nextFireAt!;
    // each fire time is due at its jittered time, and its lateness is measured from that (review finding: jitter
    // larger than the catch-up window must not turn an on-time fire into a missed one)
    const dueOf = (t: Date) => t.getTime() + jitterMs(s.id, t, s.jitterSeconds);
    const nominal = [first, ...fireTimesBetween(s.cronExpression, s.timeZone, first, now, MAX_FIRES_PER_PASS)];
    // the fire times reached so far, in order; a later one whose jittered time has not come yet waits for a later pass
    const times: Date[] = [];
    for (const t of nominal) {
      if (now.getTime() < dueOf(t)) break;
      times.push(t);
    }
    if (times.length === 0) continue;
    // the next claim: the first fire time not reached yet, or the one after the last nominal time (capped passes
    // catch the rest next pass)
    const next = times.length < nominal.length ? nominal[times.length]! : nextFireAfter(s.cronExpression, s.timeZone, nominal[nominal.length - 1]!);
    const [claimed] = await db
      .update(workflowSchedules)
      .set({ nextFireAt: next, updatedAt: sql`now()` })
      .where(and(eq(workflowSchedules.id, s.id), eq(workflowSchedules.nextFireAt, first), isNull(workflowSchedules.pausedAt)))
      .returning();
    if (!claimed) continue; // another sweep claimed it
    const windowMs = Math.max(SWEEP_GRACE_MS, claimed.catchupWindowSeconds * 1000);
    const missed = times.filter((t) => now.getTime() - dueOf(t) > windowMs);
    const onTime = times.filter((t) => now.getTime() - dueOf(t) <= windowMs);
    if (missed.length > 0) {
      for (const t of missed) await recordRun(db, claimed, t, "scheduled", "skipped_missed");
      out.skippedMissed += missed.length;
      await audit(db, claimed, null, "workflow:schedule-fires-missed", "deny", `workflow schedule '${claimed.name}': ${missed.length} fire time(s) were missed beyond the catch-up window and were not started`, {
        missed: missed.length,
        oldest: missed[0],
        newest: missed[missed.length - 1],
        catchupWindowSeconds: claimed.catchupWindowSeconds,
      });
    }
    for (const t of onTime) {
      const r = await fireSchedule(db, dataKey, claimed, t, "scheduled");
      if (r.outcome === "started" || r.outcome === "reused") out.fired++;
      if (r.outcome === "buffered") out.buffered++;
      if (r.outcome === "refused" && r.refusal !== "workflow_start_conflict") break; // the schedule is paused now
    }
  }
  return out;
}

export function workflowScheduleJobDefinitions(opts: { dataKey?: string }): SchedulerJobDefinition[] {
  return [
    {
      name: WORKFLOW_SCHEDULES_JOB_NAME,
      description:
        "Start every workflow schedule that has come due, as the admin who created it, through the governed start " +
        "path (entitlements, project attribution, the compliance cascade and audit). Overlap, catch-up and jitter follow " +
        "each schedule's settings; a start that is refused pauses its schedule with the reason.",
      adr: "ADR-0349",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runWorkflowScheduleSweep(ctx.db, opts.dataKey, ctx.clockInjected ? { now: ctx.now } : {});
        return { itemsProcessed: out.fired, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Routes (admin-only: none is in NON_ADMIN_ROUTES)
// ---------------------------------------------------------------------------

const note = z.string().trim().min(1).max(1000);
const scheduleFields = {
  name: z.string().trim().min(1).max(200),
  cronExpression: z.string().trim().min(9).max(200),
  timeZone: z.string().trim().min(1).max(100).default("UTC"),
  change: changeDescriptorSchema,
  projectId: z.string().uuid().nullable().optional(),
  workItem: startInstanceSchema.shape.workItem.nullable(),
  overlapPolicy: z.enum(WORKFLOW_SCHEDULE_OVERLAP_POLICIES).default("skip"),
  catchupWindowSeconds: z.number().int().min(0).max(604_800).default(0),
  jitterSeconds: z.number().int().min(0).max(3600).default(0),
};
const createBody = z.object({ templateId: z.string().uuid(), ...scheduleFields }).strict();
const patchBody = z
  .object({
    name: scheduleFields.name.optional(),
    cronExpression: scheduleFields.cronExpression.optional(),
    timeZone: z.string().trim().min(1).max(100).optional(),
    change: changeDescriptorSchema.optional(),
    projectId: scheduleFields.projectId,
    workItem: scheduleFields.workItem,
    overlapPolicy: z.enum(WORKFLOW_SCHEDULE_OVERLAP_POLICIES).optional(),
    catchupWindowSeconds: z.number().int().min(0).max(604_800).optional(),
    jitterSeconds: z.number().int().min(0).max(3600).optional(),
  })
  .strict();
/**
 * The fields that decide WHAT a schedule starts and WHEN (review finding, four-eyes): an edit to any of them by an
 * admin other than the run-as user re-binds `run_as_user_id` to that editor, so the instances it starts name the
 * person who chose them. An `admin_not_initiator` approver then cannot be the same admin who wrote the change.
 */
const RUN_AS_BINDING_FIELDS = ["cronExpression", "timeZone", "change", "projectId", "workItem", "overlapPolicy", "catchupWindowSeconds", "jitterSeconds"] as const;
const backfillBody = z.object({ from: z.string().datetime(), to: z.string().datetime(), note }).strict();
const idParam = z.object({ scheduleId: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().uuid().optional(),
  templateId: z.string().uuid().optional(),
});

function view(s: WorkflowScheduleRow) {
  return {
    id: s.id,
    name: s.name,
    templateId: s.templateId,
    cronExpression: s.cronExpression,
    timeZone: s.timeZone,
    change: s.change,
    projectId: s.projectId,
    workItem: s.workItemRef,
    runAsUserId: s.runAsUserId,
    overlapPolicy: s.overlapPolicy,
    catchupWindowSeconds: s.catchupWindowSeconds,
    jitterSeconds: s.jitterSeconds,
    state: s.pausedAt ? "paused" : "active",
    nextFireAt: s.nextFireAt,
    bufferedFireAt: s.bufferedFireAt,
    pausedAt: s.pausedAt,
    pausedByUserId: s.pausedByUserId,
    pauseNote: s.pauseNote,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** a relaxed overlap policy is a `settings_relax` step-up bound to the schedule and the policy */
async function overlapStepUp(db: Db, req: FastifyRequest, reply: FastifyReply, scheduleKey: string, policy: string): Promise<boolean> {
  if (policy === "skip") return true;
  return (await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "workflow_schedule_overlap", schedule: scheduleKey, values: { overlapPolicy: policy } } })).ok;
}

export function registerWorkflowScheduleRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}): void {
  const load = async (id: string) => (await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id)))[0] ?? null;
  const calendarProblem = (cron: string, tz: string, from: Date) => {
    try {
      validateCalendar(cron, tz, from);
      return null;
    } catch (err) {
      if (err instanceof ScheduleCalendarError) return { error: "invalid_schedule", detail: err.message };
      throw err;
    }
  };

  app.post("/v1/workflows/schedules", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_schedule", detail: "a schedule runs as the admin who creates it: sign in as one" });
    const b = createBody.parse(req.body);
    const now = await databaseNow(db);
    const problem = calendarProblem(b.cronExpression, b.timeZone, now);
    if (problem) return reply.status(422).send(problem);
    const [tpl] = await db.select({ id: workflowTemplates.id, retiredAt: workflowTemplates.retiredAt }).from(workflowTemplates).where(eq(workflowTemplates.id, b.templateId));
    if (!tpl) return reply.status(404).send({ error: "not_found", detail: "no such workflow template" });
    if (tpl.retiredAt) return reply.status(422).send({ error: "template_retired", detail: "a retired template starts no new instances" });
    if (!(await overlapStepUp(db, req, reply, b.name, b.overlapPolicy))) return reply;
    const [row] = await db
      .insert(workflowSchedules)
      .values({
        name: b.name,
        templateId: b.templateId,
        cronExpression: b.cronExpression,
        timeZone: b.timeZone,
        change: b.change,
        projectId: b.projectId ?? null,
        workItemRef: b.workItem ?? null,
        runAsUserId: userId,
        overlapPolicy: b.overlapPolicy,
        catchupWindowSeconds: b.catchupWindowSeconds,
        jitterSeconds: b.jitterSeconds,
        nextFireAt: nextFireAfter(b.cronExpression, b.timeZone, now),
      })
      .onConflictDoNothing({ target: workflowSchedules.name })
      .returning();
    if (!row) return reply.status(409).send({ error: "schedule_name_taken", detail: `a workflow schedule named '${b.name}' already exists` });
    await audit(db, row, userId, "workflow:schedule-created", "allow", `workflow schedule '${row.name}' created`, {
      templateId: row.templateId,
      cronExpression: row.cronExpression,
      timeZone: row.timeZone,
      overlapPolicy: row.overlapPolicy,
      ...(row.overlapPolicy !== "skip" ? { relaxed: ["overlapPolicy"] } : {}),
    });
    return reply.status(201).send(view(row));
  });

  app.get("/v1/workflows/schedules", async (req) => {
    const q = listQuery.parse(req.query ?? {});
    const rows = await db
      .select()
      .from(workflowSchedules)
      .where(and(q.templateId ? eq(workflowSchedules.templateId, q.templateId) : undefined, q.after ? sql`${workflowSchedules.id} > ${q.after}` : undefined))
      .orderBy(asc(workflowSchedules.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { version: 1, schedules: page.map(view), next: rows.length > q.limit ? page[page.length - 1]!.id : null };
  });

  app.get("/v1/workflows/schedules/:scheduleId", async (req, reply) => {
    const { scheduleId } = idParam.parse(req.params);
    const s = await load(scheduleId);
    if (!s) return reply.status(404).send({ error: "not_found", detail: "no such workflow schedule" });
    const runs = await db.select().from(workflowScheduleRuns).where(eq(workflowScheduleRuns.scheduleId, s.id)).orderBy(desc(workflowScheduleRuns.fireAt)).limit(50);
    return { ...view(s), recentRuns: runs };
  });

  app.patch("/v1/workflows/schedules/:scheduleId", async (req, reply) => {
    const { scheduleId } = idParam.parse(req.params);
    const b = patchBody.parse(req.body);
    const editorId = req.authCtx.userId;
    if (!editorId) return reply.status(403).send({ error: "bootstrap_cannot_schedule", detail: "a schedule runs as a named admin: sign in as one to edit it" });
    const s = await load(scheduleId);
    if (!s) return reply.status(404).send({ error: "not_found", detail: "no such workflow schedule" });
    // an edit to what or when it starts, by another admin, makes that admin its run-as user (audited below)
    const rebind = editorId !== s.runAsUserId && RUN_AS_BINDING_FIELDS.some((f) => b[f] !== undefined);
    const cron = b.cronExpression ?? s.cronExpression;
    const tz = b.timeZone ?? s.timeZone;
    const now = await databaseNow(db);
    const problem = calendarProblem(cron, tz, now);
    if (problem) return reply.status(422).send(problem);
    const overlap = b.overlapPolicy ?? s.overlapPolicy;
    if (b.overlapPolicy !== undefined && b.overlapPolicy !== s.overlapPolicy && !(await overlapStepUp(db, req, reply, s.id, overlap))) return reply;
    const calendarMoved = cron !== s.cronExpression || tz !== s.timeZone;
    const [row] = await db
      .update(workflowSchedules)
      .set({
        ...(b.name !== undefined ? { name: b.name } : {}),
        cronExpression: cron,
        timeZone: tz,
        ...(b.change !== undefined ? { change: b.change } : {}),
        ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
        ...(b.workItem !== undefined ? { workItemRef: b.workItem } : {}),
        overlapPolicy: overlap,
        ...(b.catchupWindowSeconds !== undefined ? { catchupWindowSeconds: b.catchupWindowSeconds } : {}),
        ...(b.jitterSeconds !== undefined ? { jitterSeconds: b.jitterSeconds } : {}),
        ...(rebind ? { runAsUserId: editorId } : {}),
        // a moved calendar starts again from now; a paused schedule stays without a next fire
        ...(calendarMoved && !s.pausedAt ? { nextFireAt: nextFireAfter(cron, tz, now) } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(workflowSchedules.id, s.id), eq(workflowSchedules.updatedAt, s.updatedAt)))
      .returning();
    if (!row) return reply.status(409).send({ error: "changed_concurrently", detail: "the schedule changed while this edit was being checked: load it again and repeat the edit" });
    await audit(db, row, editorId, "workflow:schedule-updated", "allow", `workflow schedule '${row.name}' updated${rebind ? "; it now runs as the editing admin" : ""}`, {
      changed: Object.keys(b),
      ...(rebind ? { runAsRebound: { from: s.runAsUserId, to: editorId } } : {}),
      ...(overlap !== "skip" && b.overlapPolicy !== undefined && b.overlapPolicy !== s.overlapPolicy ? { relaxed: ["overlapPolicy"] } : {}),
    });
    return view(row);
  });

  app.post("/v1/workflows/schedules/:scheduleId/pause", async (req, reply) => {
    const { scheduleId } = idParam.parse(req.params);
    const b = z.object({ note }).strict().parse(req.body);
    const [row] = await db
      .update(workflowSchedules)
      .set({ pausedAt: sql`now()`, pausedByUserId: req.authCtx.userId ?? null, pauseNote: b.note, nextFireAt: null, bufferedFireAt: null, updatedAt: sql`now()` })
      .where(and(eq(workflowSchedules.id, scheduleId), isNull(workflowSchedules.pausedAt)))
      .returning();
    if (!row) {
      const s = await load(scheduleId);
      return s
        ? reply.status(409).send({ error: "already_paused", detail: "the schedule is already paused" })
        : reply.status(404).send({ error: "not_found", detail: "no such workflow schedule" });
    }
    await audit(db, row, req.authCtx.userId ?? null, "workflow:schedule-paused", "allow", `workflow schedule '${row.name}' paused`, { note: b.note, by: "admin" });
    return view(row);
  });

  app.post("/v1/workflows/schedules/:scheduleId/resume", async (req, reply) => {
    const { scheduleId } = idParam.parse(req.params);
    const b = z.object({ note }).strict().parse(req.body);
    const s = await load(scheduleId);
    if (!s) return reply.status(404).send({ error: "not_found", detail: "no such workflow schedule" });
    if (!s.pausedAt) return reply.status(409).send({ error: "not_paused", detail: "the schedule is not paused" });
    const now = await databaseNow(db);
    const [row] = await db
      .update(workflowSchedules)
      .set({ pausedAt: null, pausedByUserId: null, pauseNote: null, nextFireAt: nextFireAfter(s.cronExpression, s.timeZone, now), updatedAt: sql`now()` })
      .where(and(eq(workflowSchedules.id, s.id), isNotNull(workflowSchedules.pausedAt)))
      .returning();
    if (!row) return reply.status(409).send({ error: "not_paused", detail: "the schedule is not paused" });
    await audit(db, row, req.authCtx.userId ?? null, "workflow:schedule-resumed", "allow", `workflow schedule '${row.name}' resumed`, { note: b.note, pausedNote: s.pauseNote });
    return view(row);
  });

  app.post("/v1/workflows/schedules/:scheduleId/backfill", async (req, reply) => {
    const { scheduleId } = idParam.parse(req.params);
    const b = backfillBody.parse(req.body);
    const callerId = req.authCtx.userId;
    if (!callerId) return reply.status(403).send({ error: "bootstrap_cannot_schedule", detail: "a backfill starts instances as a named admin: sign in as one" });
    const s = await load(scheduleId);
    if (!s) return reply.status(404).send({ error: "not_found", detail: "no such workflow schedule" });
    // every backfilled start runs as the run-as user, so only that admin may ask for them (review finding, four-eyes)
    if (callerId !== s.runAsUserId) {
      return reply.status(403).send({
        error: "schedule_run_as_only",
        detail: "a backfill starts instances as the schedule's run-as user, so only that admin may backfill it: take it over first by editing it (an edit re-binds it to you)",
      });
    }
    if (s.pausedAt) return reply.status(409).send({ error: "schedule_paused", detail: "resume the schedule before backfilling it" });
    const from = new Date(b.from);
    const to = new Date(b.to);
    const now = await databaseNow(db);
    if (!(from < to) || to > now) {
      return reply.status(422).send({ error: "invalid_range", detail: "backfill a range in the past: from must be before to, and to no later than now" });
    }
    // one more than the cap, to tell "exactly 100" from "too many"
    const times = fireTimesBetween(s.cronExpression, s.timeZone, new Date(from.getTime() - 1), to, MAX_BACKFILL + 1);
    if (times.length > MAX_BACKFILL) {
      return reply.status(422).send({ error: "backfill_too_large", detail: `the range holds more than ${MAX_BACKFILL} fire times: backfill it in parts` });
    }
    await audit(db, s, callerId, "workflow:schedule-backfill", "allow", `workflow schedule '${s.name}' backfilled ${times.length} fire time(s)`, { from, to, fireTimes: times.length, note: b.note });
    const results: Array<{ fireAt: Date } & FireResult> = [];
    for (const t of times) {
      const r = await fireSchedule(db, opts.dataKey, s, t, "backfill");
      results.push({ fireAt: t, ...r });
      if (r.outcome === "refused" && r.refusal !== "workflow_start_conflict") break;
    }
    return { fireTimes: times.length, results };
  });

  app.post("/v1/workflows/schedules/run-due", async () => runWorkflowScheduleSweep(db, opts.dataKey));
}

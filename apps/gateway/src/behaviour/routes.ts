/**
 * ADR-0359 (lane E40) — admin API for behaviour baselines. Admin-only through the default gate; API only (the screens
 * are known UI gaps tracked on #453).
 *
 *   GET /v1/behaviour/settings                                  the mode (shadow by default) and the sweep state
 *   PUT /v1/behaviour/settings                                  shadow ↔ off (off is a relaxation: step-up; audited)
 *   GET /v1/behaviour/findings                                  findings, newest first, keyset-paginated
 *   GET /v1/behaviour/findings/:findingId                       one finding with its baseline
 *   PUT /v1/behaviour/findings/:findingId/status                acknowledge or dismiss (audited)
 *   GET /v1/behaviour/baselines/:subjectKind/:subjectId         a subject's current baseline per signal
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  behaviourAnomalyFindings,
  behaviourBaselineSettings,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type Db,
} from "@regulait/db";
import {
  BEHAVIOUR_BASELINE,
  BEHAVIOUR_FINDING_STATUSES,
  BEHAVIOUR_MODES,
  BEHAVIOUR_SIGNAL_NAMES,
  BEHAVIOUR_SIGNALS,
  BEHAVIOUR_SUBJECT_KINDS,
  volumeBaselineStats,
} from "@regulait/shared";
import { requireStepUp } from "../step-up.js";
import { FINDING_STATUS_TRANSITIONS, SETTABLE_FINDING_STATUSES, findingStatusSources } from "./lifecycle.js";
import { BEHAVIOUR_OBJECT_TYPE, BEHAVIOUR_RULE_IDS, addDays, behaviourMode } from "./sweep.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PAGE_MAX = 100;
/** top keys returned per category signal in a baseline view */
const TOP_KEYS = 20;

const settingsBody = z.object({ mode: z.enum(BEHAVIOUR_MODES) }).strict();
const findingParam = z.object({ findingId: z.string().uuid() });
const subjectParam = z.object({ subjectKind: z.enum(BEHAVIOUR_SUBJECT_KINDS), subjectId: z.string().uuid() });
const listQuery = z
  .object({
    status: z.enum(BEHAVIOUR_FINDING_STATUSES).optional(),
    subjectKind: z.enum(BEHAVIOUR_SUBJECT_KINDS).optional(),
    subjectId: z.string().uuid().optional(),
    signal: z.enum(BEHAVIOUR_SIGNAL_NAMES).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
    /** keyset cursor: `<createdAt ISO>_<id>` of the last row of the previous page */
    before: z
      .string()
      .regex(/^[0-9T:.\-+Z]{20,40}_[0-9a-f-]{36}$/)
      .optional(),
  })
  .strict();
const statusBody = z.object({ status: z.enum(SETTABLE_FINDING_STATUSES) }).strict();

type Rows<T> = { rows: T[] };

export function registerBehaviourRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) =>
    reply.status(status).send({ error, ...(detail ? { detail } : {}) });

  app.get("/v1/behaviour/settings", async () => {
    const [state] = (
      (await db.execute(sql`SELECT cursor_seq AS "cursorSeq", to_char(evaluated_through, 'YYYY-MM-DD') AS "evaluatedThrough",
                                   last_sweep_at AS "lastSweepAt" FROM behaviour_engine_state WHERE id = 1`)) as unknown as Rows<Record<string, unknown>>
    ).rows;
    return {
      mode: await behaviourMode(db),
      enforcement: "none",
      baseline: BEHAVIOUR_BASELINE,
      signals: BEHAVIOUR_SIGNALS,
      state: state ?? { cursorSeq: 0, evaluatedThrough: null, lastSweepAt: null },
    };
  });

  app.put("/v1/behaviour/settings", async (req, reply) => {
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return refuse(reply, 400, "invalid_request", "body must be { mode: 'shadow' | 'off' }");
    const from = await behaviourMode(db);
    const to = body.data.mode;
    if (from === to) return { mode: to, changed: false };
    const relaxed = to === "off";
    if (relaxed) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { behaviourBaseline: "mode", from, to } });
      if (!su.ok) return reply;
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(behaviourBaselineSettings)
        .values({ id: 1, mode: to, updatedBy: req.authCtx.userId ?? null })
        .onConflictDoUpdate({ target: behaviourBaselineSettings.id, set: { mode: to, updatedBy: req.authCtx.userId ?? null, updatedAt: sql`now()` } });
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: BEHAVIOUR_OBJECT_TYPE,
        detail: { subsystem: "behaviour-baseline", adr: "0359", from, to, relaxation: relaxed, receiptClass: "configuration" },
        effect: "allow",
        ruleId: BEHAVIOUR_RULE_IDS.modeChanged,
        ruleChain: [],
        reason: relaxed
          ? "Behaviour baselines turned off — RELAXED: no baseline is built and no finding is recorded (step-up verified)"
          : "Behaviour baselines turned on in shadow mode (findings only)",
      });
    });
    return { mode: to, changed: true };
  });

  app.get("/v1/behaviour/findings", async (req, reply) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) return refuse(reply, 400, "invalid_request");
    const f = behaviourAnomalyFindings;
    const conds = [];
    if (q.data.status) conds.push(eq(f.status, q.data.status));
    if (q.data.subjectKind) conds.push(eq(f.subjectKind, q.data.subjectKind));
    if (q.data.subjectId) conds.push(eq(f.subjectId, q.data.subjectId));
    if (q.data.signal) conds.push(eq(f.signal, q.data.signal));
    if (q.data.before) {
      const cut = q.data.before.lastIndexOf("_");
      const at = new Date(q.data.before.slice(0, cut));
      const id = q.data.before.slice(cut + 1);
      if (!Number.isFinite(at.getTime())) return refuse(reply, 400, "invalid_request", "before is not a valid cursor");
      conds.push(or(lt(f.createdAt, at), and(eq(f.createdAt, at), lt(f.id, id))));
    }
    const rows = await db
      .select()
      .from(f)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(f.createdAt), desc(f.id))
      .limit(q.data.limit + 1);
    const more = rows.length > q.data.limit;
    const page = more ? rows.slice(0, q.data.limit) : rows;
    const last = page[page.length - 1];
    return { findings: page, mode: "shadow", next: more && last ? `${last.createdAt.toISOString()}_${last.id}` : null };
  });

  app.get("/v1/behaviour/findings/:findingId", async (req, reply) => {
    const p = findingParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "findingId must be a uuid");
    const [finding] = await db.select().from(behaviourAnomalyFindings).where(eq(behaviourAnomalyFindings.id, p.data.findingId));
    if (!finding) return refuse(reply, 404, "not_found");
    return { finding, allowedNext: FINDING_STATUS_TRANSITIONS[finding.status] };
  });

  app.put("/v1/behaviour/findings/:findingId/status", async (req, reply) => {
    const p = findingParam.safeParse(req.params);
    const b = statusBody.safeParse(req.body);
    if (!p.success || !b.success) return refuse(reply, 400, "invalid_request");
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(behaviourAnomalyFindings)
        .set({ status: b.data.status, statusChangedBy: req.authCtx.userId ?? null, statusChangedAt: sql`now()` })
        .where(and(eq(behaviourAnomalyFindings.id, p.data.findingId), inArray(behaviourAnomalyFindings.status, findingStatusSources(b.data.status))))
        .returning({ id: behaviourAnomalyFindings.id, status: behaviourAnomalyFindings.status });
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: BEHAVIOUR_OBJECT_TYPE,
        objectId: row.id,
        detail: { subsystem: "behaviour-baseline", adr: "0359", status: row.status },
        effect: "allow",
        ruleId: BEHAVIOUR_RULE_IDS.findingStatus,
        ruleChain: [],
        reason: `Behaviour finding ${row.status}`,
      });
      return row;
    });
    if (!updated) {
      const [exists] = await db.select({ status: behaviourAnomalyFindings.status }).from(behaviourAnomalyFindings).where(eq(behaviourAnomalyFindings.id, p.data.findingId));
      if (!exists) return refuse(reply, 404, "not_found");
      return refuse(reply, 409, "invalid_transition", `a ${exists.status} finding cannot move to ${b.data.status}`);
    }
    return updated;
  });

  app.get("/v1/behaviour/baselines/:subjectKind/:subjectId", async (req, reply) => {
    const p = subjectParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request");
    const [clock] = ((await db.execute(sql`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today`)) as unknown as Rows<{ today: string }>).rows;
    const until = addDays(clock!.today, -1);
    const from = addDays(clock!.today, -BEHAVIOUR_BASELINE.windowDays);
    const counts = (
      (await db.execute(sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, signal, key, count FROM behaviour_daily_counts
                            WHERE subject_kind = ${p.data.subjectKind} AND subject_id = ${p.data.subjectId}::uuid
                              AND day BETWEEN ${from}::date AND ${until}::date`)) as unknown as Rows<{ day: string; signal: string; key: string; count: number }>
    ).rows;
    if (counts.length === 0) return { subjectKind: p.data.subjectKind, subjectId: p.data.subjectId, from, until, signals: {} };
    const firstDay = counts.reduce((m, c) => (c.day < m ? c.day : m), until);
    const days: string[] = [];
    for (let d = firstDay; d <= until; d = addDays(d, 1)) days.push(d);
    const signals: Record<string, unknown> = {};
    for (const signal of BEHAVIOUR_SIGNAL_NAMES) {
      const own = counts.filter((c) => c.signal === signal);
      if (BEHAVIOUR_SIGNALS[signal].kind === "volume") {
        const perDay = new Map(own.map((c) => [c.day, c.count]));
        const series = days.map((d) => perDay.get(d) ?? 0);
        signals[signal] = {
          kind: "volume",
          baselineDays: series.length,
          coldStart: series.length < BEHAVIOUR_BASELINE.minBaselineDays,
          ...volumeBaselineStats(series),
        };
      } else {
        const byKey = new Map<string, number>();
        for (const c of own) byKey.set(c.key, (byKey.get(c.key) ?? 0) + c.count);
        const total = [...byKey.values()].reduce((a, b) => a + b, 0);
        const activeDays = new Set(own.map((c) => c.day)).size;
        signals[signal] = {
          kind: "category",
          activeDays,
          total,
          coldStart: activeDays < BEHAVIOUR_BASELINE.minBaselineDays || total < BEHAVIOUR_BASELINE.minCategoryEvents,
          keys: byKey.size,
          top: [...byKey.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, TOP_KEYS)
            .map(([key, count]) => ({ key, count, share: total ? count / total : 0 })),
        };
      }
    }
    return { subjectKind: p.data.subjectKind, subjectId: p.data.subjectId, from: firstDay, until, signals };
  });
}


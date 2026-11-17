/**
 * ADR-0359 (lane E40) — the behaviour baseline sweep. Two steps per pass, behind one lease:
 *
 *  1. ROLLUP. A cursor over committed `audit_log.seq` adds each row once to `behaviour_daily_counts` (per UTC day,
 *     subject, signal and key). The first run starts at seq 0, so the retained history is replayed a bounded number of
 *     batches per pass. Its own audit rows (`behaviour_baseline`) and E15's (`detection_*`) are skipped.
 *  2. EVALUATE. Once no un-rolled row is older than the day under test, each complete UTC day after
 *     `evaluated_through` (at most `maxDaysPerPass`, never further back than `maxCatchUpDays`) is compared with the 28
 *     days before it (`@regulait/shared` `evaluateVolume` / `evaluateCategory`). A fired verdict is a finding: a
 *     snapshot with its baseline, plus one chained audit row so the ADR-0303 SIEM export carries it.
 *
 * SHADOW MODE: nothing here is in a decision path and nothing a finding says changes a decision. `off` skips both
 * steps. Every read and write is the install's own Postgres: no network, no model (ADR-0015, air-gapped).
 */
import { randomUUID } from "node:crypto";
import {
  auditLog,
  behaviourAnomalyFindings,
  behaviourBaselineSettings,
  sql,
  type Db,
} from "@regulait/db";
import {
  BEHAVIOUR_BASELINE,
  BEHAVIOUR_CATEGORY_SIGNALS,
  BEHAVIOUR_VOLUME_SIGNALS,
  evaluateCategory,
  evaluateVolume,
  type BehaviourMode,
  type BehaviourSignal,
  type BehaviourSubjectKind,
  type BehaviourVerdict,
} from "@regulait/shared";
import type { SchedulerJobDefinition } from "../scheduler.js";

export const BEHAVIOUR_SWEEP_JOB_NAME = "behaviour-baseline-sweep";
export const BEHAVIOUR_OBJECT_TYPE = "behaviour_baseline" as const;

export const BEHAVIOUR_SWEEP_LIMITS = Object.freeze({
  batchSize: 2000,
  maxBatchesPerPass: 10,
  maxDaysPerPass: 3,
  /** after a long `off` period, evaluation restarts at most this many days back */
  maxCatchUpDays: 7,
  /** subjects evaluated per day (most active first); the rest are reported as truncated */
  maxSubjectsPerDay: 5000,
  maxFindingsPerDay: 500,
  /** rollup days kept; older days are pruned (the baseline needs 28) */
  retainDays: 90,
  leaseSeconds: 120,
});

export const BEHAVIOUR_RULE_IDS = {
  observed: "behaviour-anomaly-observed",
  dayEvaluated: "behaviour-baseline-evaluated",
  findingStatus: "behaviour-finding-status",
  modeChanged: "behaviour-baseline-mode",
} as const;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

async function rows<T>(db: Pick<Db, "execute">, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as { rows: T[] }).rows;
}

/** `YYYY-MM-DD` plus `n` days (UTC calendar arithmetic only; "today" always comes from the database clock) */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function behaviourMode(db: Pick<Db, "select">): Promise<BehaviourMode> {
  const [row] = await db.select({ mode: behaviourBaselineSettings.mode }).from(behaviourBaselineSettings).limit(1);
  return row?.mode ?? "shadow";
}

// ---------------------------------------------------------------------------
// lease
// ---------------------------------------------------------------------------

async function claim(db: Db, token: string): Promise<{ cursor: number; evaluatedThrough: string | null } | null> {
  await db.execute(sql`INSERT INTO behaviour_engine_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const [c] = await rows<{ cursor: number | string; evaluatedThrough: string | null }>(
    db,
    sql`UPDATE behaviour_engine_state
        SET lease_token = ${token}::uuid, lease_until = now() + make_interval(secs => ${BEHAVIOUR_SWEEP_LIMITS.leaseSeconds})
        WHERE id = 1 AND (lease_until IS NULL OR lease_until < now())
        RETURNING cursor_seq AS cursor, to_char(evaluated_through, 'YYYY-MM-DD') AS "evaluatedThrough"`,
  );
  return c ? { cursor: Number(c.cursor), evaluatedThrough: c.evaluatedThrough } : null;
}

async function release(db: Db, token: string): Promise<void> {
  await db.execute(sql`UPDATE behaviour_engine_state SET lease_until = NULL, lease_token = NULL, last_sweep_at = now()
                       WHERE id = 1 AND lease_token = ${token}::uuid`);
}

class LeaseLost extends Error {
  constructor() {
    super("behaviour_lease_lost");
    this.name = "LeaseLost";
  }
}

// ---------------------------------------------------------------------------
// 1. rollup
// ---------------------------------------------------------------------------

/**
 * One batch: the next `batchSize` committed rows after `cursor`, counted per (UTC day, subject, signal, key) and added
 * to the rollup, and the cursor moved, in one transaction conditional on the lease. Returns the rows read.
 */
async function rollupBatch(db: Db, token: string, cursor: number): Promise<{ read: number; lastSeq: number }> {
  return db.transaction(async (tx) => {
    const [r] = await rows<{ read: number | string; lastSeq: number | string | null }>(
      tx,
      sql`
      WITH batch AS (
        SELECT a.seq, a.at, a.user_id, a.actor_identity_id, a.object_type, a.object_id, a.server_id, a.tool_name, a.rule_chain
        FROM audit_log a WHERE a.seq > ${cursor} ORDER BY a.seq LIMIT ${BEHAVIOUR_SWEEP_LIMITS.batchSize}
      ), ev AS (
        SELECT (b.at AT TIME ZONE 'UTC')::date AS day, s.kind, s.id, b.*
        FROM batch b CROSS JOIN LATERAL (VALUES ('user', b.user_id), ('agent', b.actor_identity_id)) AS s(kind, id)
        WHERE s.id IS NOT NULL AND s.id <> ${NIL_UUID}::uuid
          AND b.object_type NOT IN (${BEHAVIOUR_OBJECT_TYPE}, 'detection_incident', 'detection_rule_pack')
      ), facts AS (
        SELECT day, kind, id, 'model_calls' AS signal, '' AS key FROM ev WHERE object_type = 'agent'
        UNION ALL
        SELECT day, kind, id, 'data_scoped_calls', '' FROM ev
          WHERE jsonb_typeof(rule_chain) = 'array' AND rule_chain @> '[{"rule":"data-scope"}]'::jsonb
        UNION ALL
        SELECT day, kind, id, 'tool', left(tool_name, 200) FROM ev WHERE object_type = 'mcp_tool' AND tool_name IS NOT NULL
        UNION ALL
        SELECT day, kind, id, 'destination',
               CASE WHEN object_type = 'mcp_tool' THEN 'mcp:' || server_id::text
                    WHEN object_type = 'agent' THEN 'model:' || object_id::text
                    ELSE 'connector:' || object_id::text END
          FROM ev
          WHERE (object_type = 'mcp_tool' AND server_id IS NOT NULL)
             OR (object_type IN ('agent', 'connector') AND object_id IS NOT NULL)
        UNION ALL
        SELECT day, kind, id, 'hour_of_day', to_char(at AT TIME ZONE 'UTC', 'HH24') FROM ev
      ), up AS (
        INSERT INTO behaviour_daily_counts (day, subject_kind, subject_id, signal, key, count)
        SELECT day, kind, id, signal, key, count(*)::int FROM facts GROUP BY day, kind, id, signal, key
        ON CONFLICT ON CONSTRAINT behaviour_daily_counts_pk DO UPDATE SET count = behaviour_daily_counts.count + EXCLUDED.count
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM batch) AS read, (SELECT max(seq) FROM batch) AS "lastSeq", (SELECT count(*) FROM up) AS upserted`,
    );
    const read = Number(r?.read ?? 0);
    if (read === 0) return { read: 0, lastSeq: cursor };
    const lastSeq = Number(r!.lastSeq);
    const moved = await rows<{ id: number }>(
      tx,
      sql`UPDATE behaviour_engine_state SET cursor_seq = ${lastSeq},
            lease_until = now() + make_interval(secs => ${BEHAVIOUR_SWEEP_LIMITS.leaseSeconds})
          WHERE id = 1 AND lease_token = ${token}::uuid AND cursor_seq = ${cursor} RETURNING id`,
    );
    if (moved.length === 0) throw new LeaseLost();
    return { read, lastSeq };
  });
}

// ---------------------------------------------------------------------------
// 2. evaluate one day
// ---------------------------------------------------------------------------

interface SubjectRef {
  kind: BehaviourSubjectKind;
  id: string;
}
const subjectKey = (kind: string, id: string) => `${kind}:${id}`;

export interface DayEvaluation {
  day: string;
  subjects: number;
  subjectsTruncated: boolean;
  evaluated: number;
  coldStart: number;
  fired: BehaviourVerdict[];
}

/**
 * Evaluate `day` against the `windowDays` before it, for every subject active on `day` (most active first, capped).
 * Pure reads; the caller records the findings. Exported for the tests and for slice 2's backtest.
 */
export async function evaluateBehaviourDay(db: Pick<Db, "execute">, day: string): Promise<DayEvaluation & { bySubject: Map<string, BehaviourVerdict[]> }> {
  const { windowDays } = BEHAVIOUR_BASELINE;
  const from = addDays(day, -windowDays);
  const until = addDays(day, -1);
  const subjects = await rows<{ kind: BehaviourSubjectKind; id: string; total: number | string }>(
    db,
    sql`SELECT subject_kind AS kind, subject_id AS id, sum(count) AS total FROM behaviour_daily_counts
        WHERE day = ${day}::date AND signal = 'hour_of_day'
        GROUP BY subject_kind, subject_id ORDER BY sum(count) DESC, subject_kind, subject_id
        LIMIT ${BEHAVIOUR_SWEEP_LIMITS.maxSubjectsPerDay + 1}`,
  );
  const truncated = subjects.length > BEHAVIOUR_SWEEP_LIMITS.maxSubjectsPerDay;
  const picked: SubjectRef[] = subjects.slice(0, BEHAVIOUR_SWEEP_LIMITS.maxSubjectsPerDay).map((s) => ({ kind: s.kind, id: s.id }));
  const bySubject = new Map<string, BehaviourVerdict[]>();
  const out: DayEvaluation = { day, subjects: picked.length, subjectsTruncated: truncated, evaluated: 0, coldStart: 0, fired: [] };
  if (picked.length === 0) return { ...out, bySubject };

  const subjectList = JSON.stringify(picked.map((s) => ({ kind: s.kind, id: s.id })));
  // every rollup row for these subjects over the window and the day under test
  const counts = await rows<{ day: string; kind: string; id: string; signal: BehaviourSignal; key: string; count: number }>(
    db,
    sql`SELECT to_char(c.day, 'YYYY-MM-DD') AS day, c.subject_kind AS kind, c.subject_id AS id, c.signal, c.key, c.count
        FROM behaviour_daily_counts c
        JOIN jsonb_to_recordset(${subjectList}::jsonb) AS s(kind text, id uuid) ON s.kind = c.subject_kind AND s.id = c.subject_id
        WHERE c.day BETWEEN ${from}::date AND ${day}::date`,
  );

  interface Acc {
    firstDay: string;
    volume: Map<BehaviourSignal, Map<string, number>>;
    /** signal → key → count in the window */
    catHistory: Map<BehaviourSignal, Record<string, number>>;
    /** signal → active days in the window */
    catDays: Map<BehaviourSignal, Set<string>>;
    /** signal → key → count on `day` */
    today: Map<BehaviourSignal, Map<string, number>>;
  }
  const acc = new Map<string, Acc>();
  for (const c of counts) {
    const k = subjectKey(c.kind, c.id);
    let a = acc.get(k);
    if (!a) {
      a = { firstDay: c.day, volume: new Map(), catHistory: new Map(), catDays: new Map(), today: new Map() };
      acc.set(k, a);
    }
    if (c.day < a.firstDay) a.firstDay = c.day;
    if (c.day === day) {
      if (!a.today.has(c.signal)) a.today.set(c.signal, new Map());
      a.today.get(c.signal)!.set(c.key, c.count);
      continue;
    }
    if (BEHAVIOUR_VOLUME_SIGNALS.includes(c.signal)) {
      if (!a.volume.has(c.signal)) a.volume.set(c.signal, new Map());
      a.volume.get(c.signal)!.set(c.day, c.count);
    } else {
      const h = a.catHistory.get(c.signal) ?? Object.create(null);
      h[c.key] = (h[c.key] ?? 0) + c.count;
      a.catHistory.set(c.signal, h);
      if (!a.catDays.has(c.signal)) a.catDays.set(c.signal, new Set());
      a.catDays.get(c.signal)!.add(c.day);
    }
  }

  for (const s of picked) {
    const k = subjectKey(s.kind, s.id);
    const a = acc.get(k);
    if (!a) continue;
    const verdicts: BehaviourVerdict[] = [];
    // the baseline days run from the subject's first active day in the window (zero-filled) to the day before `day`
    const start = a.firstDay < day ? a.firstDay : day;
    const baselineDays: string[] = [];
    for (let d = start; d <= until; d = addDays(d, 1)) baselineDays.push(d);
    for (const signal of BEHAVIOUR_VOLUME_SIGNALS) {
      const observed = a.today.get(signal)?.get("") ?? 0;
      if (observed === 0) continue;
      const perDay = a.volume.get(signal);
      verdicts.push(evaluateVolume({ signal, observed, baseline: baselineDays.map((d) => perDay?.get(d) ?? 0) }));
    }
    for (const signal of BEHAVIOUR_CATEGORY_SIGNALS) {
      const today = a.today.get(signal);
      if (!today) continue;
      const history = a.catHistory.get(signal) ?? Object.create(null);
      const activeDays = a.catDays.get(signal)?.size ?? 0;
      for (const [key, observed] of today) verdicts.push(evaluateCategory({ signal, key, observed, history, activeDays }));
    }
    for (const v of verdicts) {
      if (v.evaluated) out.evaluated++;
      else out.coldStart++;
    }
    const fired = verdicts.filter((v) => v.fired);
    if (fired.length) bySubject.set(k, fired);
  }
  return { ...out, bySubject };
}

/** strongest first: first-seen and rarest categories, then volume by score */
function rank(v: BehaviourVerdict): number {
  if (v.method === "share_of_history") return 2000 - (v.score ?? 0) * 1000;
  return Math.min(v.score ?? 1000, 1000);
}

/** Record one evaluated day: findings, their audit rows, the summary row and `evaluated_through`, under the lease. */
async function recordDay(db: Db, token: string, actorUserId: string, ev: Awaited<ReturnType<typeof evaluateBehaviourDay>>): Promise<number> {
  const all: Array<{ subject: SubjectRef; v: BehaviourVerdict }> = [];
  for (const [k, vs] of ev.bySubject) {
    const cut = k.indexOf(":");
    const subject = { kind: k.slice(0, cut) as BehaviourSubjectKind, id: k.slice(cut + 1) };
    for (const v of vs) all.push({ subject, v });
  }
  all.sort((a, b) => rank(b.v) - rank(a.v) || a.subject.id.localeCompare(b.subject.id) || a.v.key.localeCompare(b.v.key));
  const kept = all.slice(0, BEHAVIOUR_SWEEP_LIMITS.maxFindingsPerDay);
  return db.transaction(async (tx) => {
    let recorded = 0;
    for (const { subject, v } of kept) {
      const [f] = await tx
        .insert(behaviourAnomalyFindings)
        .values({
          day: ev.day,
          subjectKind: subject.kind,
          subjectId: subject.id,
          signal: v.signal,
          key: v.key,
          method: v.method!,
          observed: v.observed,
          baselineDays: v.baselineDays,
          baselineMedian: v.baselineMedian,
          baselineMad: v.baselineMad,
          baselineKeyCount: v.baselineKeyCount,
          baselineTotal: v.baselineTotal,
          score: v.score,
          threshold: v.threshold!,
          explanation: v.explanation.slice(0, 2000),
        })
        .onConflictDoNothing()
        .returning({ id: behaviourAnomalyFindings.id });
      if (!f) continue;
      recorded++;
      await tx.insert(auditLog).values({
        userId: subject.kind === "user" ? subject.id : actorUserId,
        objectType: BEHAVIOUR_OBJECT_TYPE,
        objectId: f.id,
        detail: {
          subsystem: "behaviour-baseline",
          adr: "0359",
          mode: "shadow",
          day: ev.day,
          subjectKind: subject.kind,
          subjectId: subject.id,
          signal: v.signal,
          method: v.method,
          score: v.score,
          threshold: v.threshold,
          baselineDays: v.baselineDays,
        },
        // shadow mode: a finding records an observation and restricts nothing
        effect: "allow",
        ruleId: BEHAVIOUR_RULE_IDS.observed,
        ruleChain: [],
        reason: `Behaviour anomaly (shadow): ${v.signal} for ${subject.kind} ${subject.id} on ${ev.day}`,
      });
    }
    await tx.insert(auditLog).values({
      userId: actorUserId,
      objectType: BEHAVIOUR_OBJECT_TYPE,
      detail: {
        subsystem: "behaviour-baseline",
        adr: "0359",
        mode: "shadow",
        day: ev.day,
        subjects: ev.subjects,
        subjectsTruncated: ev.subjectsTruncated,
        evaluated: ev.evaluated,
        coldStart: ev.coldStart,
        fired: all.length,
        recorded,
        findingsTruncated: all.length > kept.length,
      },
      effect: "allow",
      ruleId: BEHAVIOUR_RULE_IDS.dayEvaluated,
      ruleChain: [],
      reason: `Behaviour baselines evaluated for ${ev.day}: ${recorded} new finding(s), shadow mode`,
    });
    const moved = await rows<{ id: number }>(
      tx,
      sql`UPDATE behaviour_engine_state SET evaluated_through = ${ev.day}::date,
            lease_until = now() + make_interval(secs => ${BEHAVIOUR_SWEEP_LIMITS.leaseSeconds})
          WHERE id = 1 AND lease_token = ${token}::uuid AND (evaluated_through IS NULL OR evaluated_through < ${ev.day}::date)
          RETURNING id`,
    );
    if (moved.length === 0) throw new LeaseLost();
    await tx.execute(sql`DELETE FROM behaviour_daily_counts WHERE day < ${addDays(ev.day, -BEHAVIOUR_SWEEP_LIMITS.retainDays)}::date`);
    return recorded;
  });
}

// ---------------------------------------------------------------------------
// the pass
// ---------------------------------------------------------------------------

export interface BehaviourSweepResult {
  outcome: "off" | "not_claimed" | "rolling_up" | "evaluated" | "idle";
  rowsRolledUp: number;
  daysEvaluated: string[];
  findings: number;
}

export async function runBehaviourSweep(db: Db, actor: string | null): Promise<BehaviourSweepResult> {
  const actorUserId = actor ?? NIL_UUID;
  const result: BehaviourSweepResult = { outcome: "idle", rowsRolledUp: 0, daysEvaluated: [], findings: 0 };
  if ((await behaviourMode(db)) === "off") return { ...result, outcome: "off" };
  const token = randomUUID();
  const claimed = await claim(db, token);
  if (!claimed) return { ...result, outcome: "not_claimed" };
  try {
    let cursor = claimed.cursor;
    for (let i = 0; i < BEHAVIOUR_SWEEP_LIMITS.maxBatchesPerPass; i++) {
      const b = await rollupBatch(db, token, cursor);
      result.rowsRolledUp += b.read;
      cursor = b.lastSeq;
      if (b.read < BEHAVIOUR_SWEEP_LIMITS.batchSize) break;
    }
    const [clock] = await rows<{ yesterday: string }>(db, sql`SELECT to_char((now() AT TIME ZONE 'UTC')::date - 1, 'YYYY-MM-DD') AS yesterday`);
    const yesterday = clock!.yesterday;
    const floor = addDays(yesterday, -(BEHAVIOUR_SWEEP_LIMITS.maxCatchUpDays - 1));
    let next = claimed.evaluatedThrough ? addDays(claimed.evaluatedThrough, 1) : yesterday;
    if (next < floor) next = floor;
    for (let n = 0; n < BEHAVIOUR_SWEEP_LIMITS.maxDaysPerPass && next <= yesterday; n++, next = addDays(next, 1)) {
      // a day is evaluated only once no un-rolled row is older than its end, so a part-built baseline never fires
      const [pending] = await rows<{ behind: boolean }>(
        db,
        sql`SELECT EXISTS (SELECT 1 FROM audit_log WHERE seq > ${cursor}
              AND at < (${addDays(next, 1)}::date)::timestamp AT TIME ZONE 'UTC') AS behind`,
      );
      if (pending?.behind) {
        result.outcome = "rolling_up";
        return result;
      }
      const ev = await evaluateBehaviourDay(db, next);
      result.findings += await recordDay(db, token, actorUserId, ev);
      result.daysEvaluated.push(next);
    }
    result.outcome = result.daysEvaluated.length ? "evaluated" : result.rowsRolledUp ? "rolling_up" : "idle";
    return result;
  } finally {
    await release(db, token);
  }
}

export function behaviourJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: BEHAVIOUR_SWEEP_JOB_NAME,
      description:
        "Roll the audit chain up into per-day behaviour counts per user and agent, and compare each complete day with " +
        "the 28 days before it (robust z-score and share of history). Shadow mode: findings only, never enforcement; " +
        "reads the install's own audit log and is never in a decision path.",
      adr: "ADR-0359",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runBehaviourSweep(ctx.db, ctx.actorUserId);
        return { itemsProcessed: out.rowsRolledUp, detail: { outcome: out.outcome, daysEvaluated: out.daysEvaluated, findings: out.findings } };
      },
    },
  ];
}

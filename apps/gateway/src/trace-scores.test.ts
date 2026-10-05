/**
 * ADR-0173 batch 2c (F) — the trace filter's SQL and trace scores, against a
 * real Postgres.
 *
 * Rules, each with its control:
 *  - SCOPING: with `scopeUserId` set, every filter (old and new, alone and
 *    combined, including a `userId` naming somebody else) returns only that
 *    user's traces; the same filter unscoped (admin) does return the other
 *    user's matching trace, so the scoped result is the rule and not an
 *    accident of the fixture. Counts are counts of traces (no EXISTS fan-out).
 *  - each new filter selects exactly the traces it describes;
 *  - `recordTraceScore` is idempotent on (source, sourceRefId, name): a replay
 *    returns the same id, adds no row and leaves the first value in place.
 *
 * Shared state: none global. The traces this file writes are deleted in
 * afterAll (tags, scores, spans and evaluations cascade or are removed here).
 */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  createDb,
  eq,
  inArray,
  runMigrations,
  sql,
  traceEvaluations,
  traceScores,
  traceSpans,
  traceTags,
  traces,
  type Db,
} from "@regulait/db";
import { traceFilterSchema, type TraceFilter } from "@regulait/shared";
import { recordTraceScore, traceFilterConditions } from "./trace-scores.js";

let db: Db;
const RUN = crypto.randomBytes(3).toString("hex");
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
const projectId = crypto.randomUUID();
const agentId = crypto.randomUUID();
const model = `tsc-model-${RUN}`;
const sessionId = `tsc-session-${RUN}`;
const scoreName = `tsc-quality-${RUN}`;
const tagKey = `tsc.team-${RUN}`;
const started = new Date("2026-09-01T12:00:00.000Z");

/** label -> trace id */
const T: Record<"aRich" | "bRich" | "aPlain", string> = { aRich: "", bRich: "", aPlain: "" };
const owner: Record<string, string> = {};

async function richTrace(userId: string): Promise<string> {
  const [t] = await db
    .insert(traces)
    .values({
      kind: "dispatch",
      name: `tsc rich ${RUN}`,
      userId,
      projectId,
      sessionId,
      status: "ok",
      startedAt: started,
      durationMs: 9_000,
      costUsd: 5,
      spanCount: 2,
      deniedSpanCount: 1,
    })
    .returning({ id: traces.id });
  const traceId = t!.id;
  // two matching spans: an EXISTS filter must still count the trace once
  const spans = await db
    .insert(traceSpans)
    .values([1, 2].map((seq) => ({ traceId, seq, kind: "llm" as const, name: "call", status: "ok" as const, startedAt: started, agentId, model })))
    .returning({ id: traceSpans.id });
  await db.insert(traceEvaluations).values({
    spanId: spans[0]!.id,
    traceId,
    agentId,
    spanStartedAt: started,
    outcome: "evaluated",
    flagged: true,
  });
  await db.insert(traceTags).values({ traceId, key: tagKey, value: "payments" });
  await recordTraceScore(db, { traceId, source: "annotation", name: scoreName, value: 0.7, sourceRefId: `ref-${traceId}` });
  return traceId;
}

beforeAll(async () => {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  T.aRich = await richTrace(userA);
  T.bRich = await richTrace(userB);
  const [plain] = await db
    .insert(traces)
    .values({ kind: "run", name: `tsc plain ${RUN}`, userId: userA, status: "running", startedAt: new Date("2026-08-01T00:00:00.000Z") })
    .returning({ id: traces.id });
  T.aPlain = plain!.id;
  owner[T.aRich] = userA;
  owner[T.bRich] = userB;
  owner[T.aPlain] = userA;
});

afterAll(async () => {
  const ids = Object.values(T).filter(Boolean);
  if (ids.length) {
    await db.delete(traceEvaluations).where(inArray(traceEvaluations.traceId, ids));
    await db.delete(traces).where(inArray(traces.id, ids));
  }
});

/** the fixture traces this predicate selects (other files' traces are ignored) */
async function select(filter: TraceFilter, scopeUserId: string | null): Promise<string[]> {
  const rows = await db
    .select({ id: traces.id })
    .from(traces)
    .where(and(traceFilterConditions(filter, { scopeUserId }), inArray(traces.id, Object.values(T))));
  return rows.map((r) => r.id).sort();
}

async function count(filter: TraceFilter, scopeUserId: string | null): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traces)
    .where(and(traceFilterConditions(filter, { scopeUserId }), inArray(traces.id, Object.values(T))));
  return r!.n;
}

const rich = () => [T.aRich, T.bRich];
/** [label, raw query, the fixture traces an ADMIN sees] */
const CASES: Array<[string, Record<string, unknown>, () => string[]]> = [
  ["no filter", {}, () => [T.aRich, T.bRich, T.aPlain]],
  ["userId = the other user", { userId: userB }, () => [T.bRich]],
  ["projectId", { projectId }, rich],
  ["sessionId", { sessionId }, rich],
  ["kind", { kind: "dispatch" }, rich],
  ["status", { status: "ok" }, rich],
  ["deniedOnly", { deniedOnly: "true" }, rich],
  ["from/to", { from: "2026-08-15T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" }, rich],
  ["agentId", { agentId }, rich],
  ["model", { model }, rich],
  ["minCostUsd", { minCostUsd: "4.5" }, rich],
  ["minLatencyMs", { minLatencyMs: "8000" }, rich],
  ["score name", { scoreName }, rich],
  ["score range", { scoreName, scoreMin: "0.5", scoreMax: "0.9" }, rich],
  ["score range that excludes", { scoreName, scoreMin: "0.8" }, () => []],
  ["flagged", { flagged: "true" }, rich],
  ["not flagged", { flagged: "false" }, () => [T.aPlain]],
  ["tag key", { tagKey }, rich],
  ["tag key=value", { tagKey, tagValue: "payments" }, rich],
  ["tag key=other value", { tagKey, tagValue: "search" }, () => []],
  [
    "every new filter at once",
    { agentId, model, minCostUsd: "1", minLatencyMs: "1", scoreName, scoreMin: "0", flagged: "true", tagKey, tagValue: "payments" },
    rich,
  ],
];

describe("traceFilterConditions", () => {
  it.each(CASES)("%s: selects exactly what it says (admin, unscoped)", async (_label, raw, expected) => {
    const f = traceFilterSchema.parse(raw);
    expect(await select(f, null)).toEqual(expected().sort());
  });

  it.each(CASES)("%s: a non-admin scope only ever returns their own traces", async (_label, raw, expected) => {
    const f = traceFilterSchema.parse(raw);
    const want = expected().filter((id) => owner[id] === userA).sort();
    const got = await select(f, userA);
    expect(got).toEqual(want);
    for (const id of got) expect(owner[id]).toBe(userA);
    // the count agrees with the rows: no leak and no EXISTS fan-out
    expect(await count(f, userA)).toBe(want.length);
  });

  it("the other user's matching trace is visible unscoped, so the scope is what hides it", async () => {
    const f = traceFilterSchema.parse({ agentId, model, scoreName, flagged: "true", tagKey });
    expect(await select(f, null)).toContain(T.bRich);
    expect(await select(f, userA)).not.toContain(T.bRich);
    expect(await select(f, userB)).toEqual([T.bRich]);
  });
});

describe("recordTraceScore", () => {
  it("is idempotent on (source, sourceRefId, name): a replay adds nothing and changes nothing", async () => {
    const ref = `idem-${RUN}`;
    const first = await recordTraceScore(db, { traceId: T.aPlain, source: "evaluator", name: "accuracy", value: 0.25, sourceRefId: ref });
    expect(first.created).toBe(true);
    const replay = await recordTraceScore(db, { traceId: T.aPlain, source: "evaluator", name: "accuracy", value: 0.99, sourceRefId: ref });
    expect(replay).toEqual({ id: first.id, created: false });
    const rows = await db
      .select()
      .from(traceScores)
      .where(and(eq(traceScores.source, "evaluator"), eq(traceScores.sourceRefId, ref)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(0.25);

    // a different name, or a different source, under the same ref is its own score
    const other = await recordTraceScore(db, { traceId: T.aPlain, source: "evaluator", name: "verdict", label: "pass", sourceRefId: ref });
    expect(other.created).toBe(true);
    const judged = await recordTraceScore(db, { traceId: T.aPlain, source: "judge", name: "accuracy", value: 1, sourceRefId: ref });
    expect(judged.created).toBe(true);
  });

  it("refuses a score with neither value nor label, and a span from another trace", async () => {
    await expect(
      recordTraceScore(db, { traceId: T.aPlain, source: "annotation", name: "empty", sourceRefId: `empty-${RUN}` }),
    ).rejects.toThrow();
    const [span] = await db.select({ id: traceSpans.id }).from(traceSpans).where(eq(traceSpans.traceId, T.bRich)).limit(1);
    await expect(
      recordTraceScore(db, { traceId: T.aPlain, spanId: span!.id, source: "annotation", name: "x", value: 1, sourceRefId: `cross-${RUN}` }),
    ).rejects.toThrow(/not part of the trace/);
  });
});

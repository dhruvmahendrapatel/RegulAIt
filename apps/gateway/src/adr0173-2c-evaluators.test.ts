/**
 * ADR-0173 batch 2c (E) — evaluators: datasets from traces, evaluators on
 * traces, the catalog and "tested by", compare, automatic re-run on a
 * configuration change, judge panels, repeated runs and judge calibration.
 *
 * One test (or more) per contract rule, each named for the rule. The mock
 * provider answers a judge prompt with a JSON verdict chosen by a marker in the
 * judge agent's system prompt, so panels run through the REAL governed judge
 * path over HTTP as well as through injected stubs.
 *
 * SHARED-STATE DISCIPLINE (M-068): every object is `e2c-` prefixed; the one
 * global row this file writes (an `evals` model-policy rule) is restored in a
 * `finally`; the custom compliance pack is deleted in afterAll. Assertions are
 * scoped to this file's own ids or a project only this file uses.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import Fastify from "fastify";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  evalCases,
  evalJudgeVerdicts,
  evalResults,
  evalRuns,
  inArray,
  modelPolicyRules,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  traceScores,
  traceSpans,
  traces,
  users,
  type Db,
  type EvalRunRow,
} from "@regulait/db";
import { cohensKappa, meanScoreInterval, type EvalJudge, type EvalJudgeRequest } from "@regulait/shared";

declare global {
  // eslint-disable-next-line no-var
  var __e2cJudgeCalls: number;
}
globalThis.__e2cJudgeCalls = 0;

/** the judge agents carry one of these in their system prompt */
const JUDGE_MARKERS: Record<string, string> = {
  "<<e2c-judge-high>>": '{"score": 1, "passed": true, "rationale": "fine"}',
  "<<e2c-judge-half>>": '{"score": 0.5, "passed": false, "rationale": "partly"}',
  "<<e2c-judge-broken>>": "I refuse to answer in JSON.",
};

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        const input = req.input ?? "";
        const system = req.system ?? "";
        const marker = Object.keys(JUDGE_MARKERS).find((m) => system.includes(m));
        const text = marker
          ? (globalThis.__e2cJudgeCalls++, JUDGE_MARKERS[marker]!)
          : input.includes("<<e2c-")
            ? `The answer to ${input.slice(0, 40)} is ok.`
            : null;
        if (text === null) return inner.dispatch(req);
        return {
          outputText: text,
          stopReason: "end_turn",
          refusal: false,
          usage: { inputTokens: 10, outputTokens: 10 },
          providerMessageId: "e2c-mock",
        };
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { runEvalSuite, configChangeRerun, registerEvalRoutes } = await import("./evals.js");
const { addTracesToDataset } = await import("./eval-dataset-sources.js");
const { countTestedEvaluators, testedByForControls } = await import("./eval-catalog.js");
const { runCollector } = await import("./compliance-packs.js");
const { calibrateRunJudges, calibrationLabelsFromAnnotations } = await import("./eval-judge-calibration.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e2c-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const tag = crypto.randomBytes(3).toString("hex");

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminAuth: { authorization: string };
let memberId: string;
let memberAuth: { authorization: string };
let subjectId: string;
const judgeIds: Record<"high" | "half" | "broken", string> = { high: "", half: "", broken: "" };
let projectId: string;
let packId: string | null = null;

async function makeUser(email: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace(/[-.]/g, " "), ...(isAdmin ? { isAdmin: true } : {}) },
  });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "e2c" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, systemPrompt: string | null = null) {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-balanced" },
  });
  expect(a.statusCode, a.body).toBe(201);
  const id = a.json().id as string;
  if (systemPrompt) {
    const sp = await app.inject({ method: "POST", url: `/v1/agents/${id}/system-prompt`, headers: AUTH, payload: { systemPrompt } });
    expect(sp.statusCode).toBe(200);
  }
  for (const userId of [adminId, memberId]) {
    await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId: id } });
  }
  return id;
}

async function makeDataset(name: string, scorerKind = "contains", scorerConfig: Record<string, unknown> = { needles: ["ok"] }) {
  const ds = await app.inject({ method: "POST", url: "/v1/evals/datasets", headers: AUTH, payload: { name, scorerKind, scorerConfig } });
  expect(ds.statusCode, ds.body).toBe(201);
  return ds.json() as { id: string; version: number; name: string };
}

async function insertCases(datasetId: string, version: number, n: number, kind: string | null, prefix: string) {
  const rows = await db
    .insert(evalCases)
    .values(
      Array.from({ length: n }, (_, i) => ({
        datasetId,
        datasetVersion: version,
        input: `<<e2c-${prefix}-${i}>> question ${i}`,
        expected: "ok" as never,
        scorerKind: kind as never,
        ...(kind === "llm_as_judge" ? { scorerConfig: { threshold: 0.75 } } : {}),
      })),
    )
    .returning({ id: evalCases.id, input: evalCases.input });
  return rows;
}

async function makeTrace(
  ownerId: string,
  spans: Array<{ input: string | null; output: string | null; withheld?: boolean; kind?: "llm" | "tool" }>,
) {
  const [t] = await db
    .insert(traces)
    .values({ kind: "dispatch", name: `e2c-trace-${tag}`, userId: ownerId, status: "ok", projectId })
    .returning();
  const rows = await db
    .insert(traceSpans)
    .values(
      spans.map((s, i) => ({
        traceId: t!.id,
        seq: i,
        kind: s.kind ?? ("llm" as const),
        name: `e2c-span-${i}`,
        status: "ok" as const,
        startedAt: new Date(),
        inputPreview: s.input,
        outputPreview: s.output,
        contentWithheld: s.withheld ?? false,
      })),
    )
    .returning({ id: traceSpans.id });
  return { traceId: t!.id, spanIds: rows.map((r) => r.id) };
}

/** a deterministic stub judge: passes a case whose input ends in an even index */
function stubJudge(id: string, score: (req: EvalJudgeRequest) => number | Error): EvalJudge {
  return {
    id,
    judge: async (req) => {
      const s = score(req);
      if (s instanceof Error) throw s;
      return { score: s, passed: s >= 0.75, rationale: `${id} says ${s}` };
    },
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const admin = await makeUser(`e2c-admin-${tag}@example.com`, true);
  adminId = admin.id;
  adminAuth = admin.auth;
  const member = await makeUser(`e2c-member-${tag}@example.com`);
  memberId = member.id;
  memberAuth = member.auth;
  subjectId = await makeAgent(`e2c-subject-${tag}`);
  judgeIds.high = await makeAgent(`e2c-judge-high-${tag}`, "<<e2c-judge-high>>");
  judgeIds.half = await makeAgent(`e2c-judge-half-${tag}`, "<<e2c-judge-half>>");
  judgeIds.broken = await makeAgent(`e2c-judge-broken-${tag}`, "<<e2c-judge-broken>>");
  const p = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name: `e2c-project-${tag}`, key: `E2C${tag.slice(0, 3).toUpperCase()}` } });
  expect(p.statusCode, p.body).toBe(201);
  projectId = p.json().id;
  for (const userId of [adminId, memberId]) {
    await app.inject({ method: "POST", url: `/v1/projects/${projectId}/members`, headers: AUTH, payload: { userId, role: "member" } });
  }
}, 120_000);

afterAll(async () => {
  if (packId) await app.inject({ method: "DELETE", url: `/v1/compliance/packs/${packId}`, headers: AUTH });
  await app?.close();
});

// ===========================================================================
// Datasets from traces
// ===========================================================================

describe("datasets from traces", () => {
  it("is admin-only: a non-admin gets 403 and nothing is written", async () => {
    const ds = await makeDataset(`e2c-ft-auth-${tag}`);
    const { spanIds } = await makeTrace(memberId, [{ input: "<<e2c-q>> hi", output: "ok" }]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.id}/from-traces`,
      headers: memberAuth,
      payload: { spanIds },
    });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(evalCases).where(eq(evalCases.datasetId, ds.id))).toHaveLength(0);
  });

  it("adds good spans and refuses withheld, empty, unknown and repeated ones per row, with the reason", async () => {
    const ds = await makeDataset(`e2c-ft-mixed-${tag}`);
    const { traceId, spanIds } = await makeTrace(memberId, [
      { input: "<<e2c-q1>> what is the status?", output: "status ok" },
      { input: "[withheld: pii]", output: "[withheld: pii]", withheld: true },
      { input: "   ", output: "something" },
      { input: null, output: null },
    ]);
    const unknown = crypto.randomUUID();
    const res = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.id}/from-traces`,
      headers: adminAuth,
      payload: { spanIds: [...spanIds, unknown, spanIds[0]] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { added: number; skipped: Array<{ id: string; reason: string }> };
    expect(body.added).toBe(1);
    expect(body.skipped).toEqual([
      { id: spanIds[1], reason: "content_withheld" },
      { id: spanIds[2], reason: "no_content" },
      { id: spanIds[3], reason: "no_content" },
      { id: unknown, reason: "not_found" },
      { id: spanIds[0], reason: "duplicate_in_request" },
    ]);
    const cases = await db.select().from(evalCases).where(eq(evalCases.datasetId, ds.id));
    expect(cases).toHaveLength(1);
    expect(cases[0]!.input).toBe("<<e2c-q1>> what is the status?");
    expect(cases[0]!.expected).toBe("status ok");
    expect(cases[0]!.sourceSpanId).toBe(spanIds[0]);
    expect(cases[0]!.sourceTraceId).toBe(traceId);
    // the read of someone else's traces is audited, with the span ids
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, ds.id), eq(auditLog.ruleId, "eval-dataset-from-traces")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(a?.userId).toBe(adminId);
    expect((a?.detail as { spanIds: string[] }).spanIds).toEqual([spanIds[0]]);
  });

  it("is unique on (dataset, version, source span): adding the same span again is skipped, and the DB refuses a duplicate", async () => {
    const ds = await makeDataset(`e2c-ft-uniq-${tag}`);
    const { spanIds } = await makeTrace(memberId, [{ input: "<<e2c-u>> again?", output: "ok" }]);
    const first = await addTracesToDataset(db, { datasetId: ds.id, spanIds, actorUserId: adminId });
    expect(first.ok && first.added).toBe(1);
    const second = await addTracesToDataset(db, { datasetId: ds.id, spanIds, actorUserId: adminId });
    expect(second.ok && second.skipped).toEqual([{ id: spanIds[0], reason: "already_in_dataset" }]);
    await expect(
      db.insert(evalCases).values({ datasetId: ds.id, datasetVersion: ds.version, input: "x", sourceSpanId: spanIds[0] }),
    ).rejects.toThrow();
    expect(await db.select().from(evalCases).where(eq(evalCases.datasetId, ds.id))).toHaveLength(1);
  });

  it("refuses a frozen dataset version (409) and writes nothing", async () => {
    const ds = await makeDataset(`e2c-ft-frozen-${tag}`);
    await insertCases(ds.id, ds.version, 1, null, "frozen");
    const run = await runEvalSuite(db, DATA_KEY, { datasetId: ds.id, agentId: subjectId, userId: adminId, trigger: "manual" });
    expect(run.ok).toBe(true);
    const { spanIds } = await makeTrace(memberId, [{ input: "<<e2c-f>> late", output: "ok" }]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.id}/from-traces`,
      headers: adminAuth,
      payload: { spanIds },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("dataset_version_frozen");
    expect(await db.select().from(evalCases).where(eq(evalCases.datasetId, ds.id))).toHaveLength(1);
  });

  it("accepts whole traces: each trace's model-call spans become rows, under the same per-row reasons", async () => {
    const ds = await makeDataset(`e2c-ft-traces-${tag}`);
    const a = await makeTrace(memberId, [
      { input: "<<e2c-t1>> first call", output: "ok one" },
      { input: "tool args", output: "tool result", kind: "tool" },
      { input: "[withheld]", output: "[withheld]", withheld: true },
    ]);
    const b = await makeTrace(memberId, [{ input: "only a tool", output: "x", kind: "tool" }]);
    const unknown = crypto.randomUUID();
    const res = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.id}/from-traces`,
      headers: adminAuth,
      payload: { traceIds: [a.traceId, b.traceId, unknown, a.traceId] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().added).toBe(1);
    expect(res.json().skipped).toEqual([
      { id: b.traceId, reason: "no_model_call" },
      { id: unknown, reason: "not_found" },
      { id: a.traceId, reason: "duplicate_in_request" },
      { id: a.spanIds[2], reason: "content_withheld" },
    ]);
    const cases = await db.select().from(evalCases).where(eq(evalCases.datasetId, ds.id));
    expect(cases.map((c) => c.sourceSpanId)).toEqual([a.spanIds[0]]);
  });

  it("takes exactly one of traceIds or spanIds (422 for both or neither), and at most 200 rows after expansion", async () => {
    const ds = await makeDataset(`e2c-ft-form-${tag}`);
    const t = await makeTrace(memberId, [{ input: "<<e2c-t2>> q", output: "ok" }]);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/v1/evals/datasets/${ds.id}/from-traces`, headers: adminAuth, payload });
    const both = await post({ traceIds: [t.traceId], spanIds: t.spanIds });
    expect(both.statusCode).toBe(422);
    expect(both.json().error).toBe("span_ids_or_trace_ids");
    expect((await post({})).statusCode).toBe(422);
    const big = await makeTrace(
      memberId,
      Array.from({ length: 201 }, (_, i) => ({ input: `<<e2c-big-${i}>> q`, output: "ok" })),
    );
    const over = await post({ traceIds: [big.traceId] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe("too_many_rows");
    expect(await db.select().from(evalCases).where(eq(evalCases.datasetId, ds.id))).toHaveLength(0);
  });

  it("takes at most 200 rows per call", async () => {
    const ds = await makeDataset(`e2c-ft-cap-${tag}`);
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
    const res = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.id}/from-traces`,
      headers: adminAuth,
      payload: { spanIds: ids },
    });
    expect(res.statusCode).toBe(400);
    const direct = await addTracesToDataset(db, { datasetId: ds.id, spanIds: ids, actorUserId: adminId });
    expect(direct.ok).toBe(false);
    expect(!direct.ok && direct.error).toBe("too_many_rows");
    const ok = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.id}/from-traces`,
      headers: adminAuth,
      payload: { spanIds: ids.slice(0, 200) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().skipped).toHaveLength(200);
  });
});

// ===========================================================================
// Evaluators on traces
// ===========================================================================

describe("evaluators on traces", () => {
  it("refuse a judge-backed scorer: deterministic scorers only, never a model call", async () => {
    const { spanIds } = await makeTrace(memberId, [{ input: "q", output: "a" }]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/traces/evaluate",
      headers: adminAuth,
      payload: { scorerKind: "llm_as_judge", scorerConfig: { instructions: "grade" }, spanIds },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("deterministic_scorer_required");
  });

  it("score previews into trace scores; withheld content is 'not evaluated', never a zero", async () => {
    const { traceId, spanIds } = await makeTrace(memberId, [
      { input: "q1", output: "the status is ok" },
      { input: "q2", output: "nothing here" },
      { input: "[withheld]", output: "[withheld]", withheld: true },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/traces/evaluate",
      headers: adminAuth,
      payload: { scorerKind: "contains", scorerConfig: { needles: ["ok"] }, spanIds, scoreName: "e2c.contains" },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { evaluated: number; notEvaluated: number; results: Array<Record<string, unknown>> };
    expect(body.evaluated).toBe(2);
    expect(body.results[2]).toEqual({ spanId: spanIds[2], outcome: "not_evaluated", reason: "content_withheld" });
    const scores = await db.select().from(traceScores).where(eq(traceScores.traceId, traceId));
    expect(scores.map((s) => [s.spanId, s.value, s.label, s.source]).sort()).toEqual(
      [
        [spanIds[0], 1, "pass", "evaluator"],
        [spanIds[1], 0, "fail", "evaluator"],
      ].sort(),
    );
  });
});

// ===========================================================================
// The catalog and "tested by"
// ===========================================================================

describe("the catalog", () => {
  it("lists 13 scorers, 5 detectors and 10 red-team classes with references; admin-only", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/evals/catalog", headers: adminAuth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { counts: Record<string, number>; evaluators: Array<{ refs: Record<string, string[]> }> };
    expect(body.counts).toMatchObject({ scorers: 13, detectors: 5, redteamClasses: 10 });
    expect(body.evaluators.every((e) => e.refs.nistAiRmf!.length > 0)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/evals/catalog", headers: memberAuth })).statusCode).toBe(403);
  });
});

describe("pack coverage counts as tested only from a completed run that passed in the period", () => {
  const scope = () => ({ periodStart: new Date(Date.now() - 3_600_000), periodEnd: new Date(Date.now() + 3_600_000), projectIds: [projectId] });
  const ref = "eu-ai-act:art-15-accuracy-robustness";
  let datasetId: string;
  let version: number;

  it("with no run in the period, nothing is tested — 'not run' never counts as passed", async () => {
    const map = await testedByForControls(db, [ref], scope());
    expect(map[ref]!.length).toBeGreaterThan(0);
    expect(map[ref]!.every((e) => e.status === "not_run")).toBe(true);
    expect(await countTestedEvaluators(db, ref, scope())).toBe(0);
    expect(await runCollector(db, "evaluator_tested", { ...scope(), memberIds: null, params: {}, controlRef: ref })).toBe(0);
  });

  it("a completed run whose gate FAILED is 'failed', and still not tested", async () => {
    const ds = await makeDataset(`e2c-cov-${tag}`, "exact", {});
    datasetId = ds.id;
    version = ds.version;
    await db.insert(evalCases).values({ datasetId: ds.id, datasetVersion: ds.version, input: "<<e2c-cov>> q", expected: "never" as never });
    const failing = await runEvalSuite(db, DATA_KEY, {
      datasetId,
      agentId: subjectId,
      userId: adminId,
      trigger: "manual",
      projectId,
      minScore: 1,
    });
    expect(failing.ok && failing.run.gatePassed).toBe(false);
    const map = await testedByForControls(db, [ref], scope());
    expect(map[ref]!.find((e) => e.evaluatorId === "scorer:exact")?.status).toBe("failed");
    expect(await countTestedEvaluators(db, ref, scope())).toBe(0);
  });

  it("a completed run that PASSED makes its scorer tested; the pack collector counts it", async () => {
    const passing = await runEvalSuite(db, DATA_KEY, { datasetId, agentId: subjectId, userId: adminId, trigger: "manual", projectId });
    expect(passing.ok && passing.run.gatePassed).toBe(true);
    const map = await testedByForControls(db, [ref], scope());
    expect(map[ref]!.find((e) => e.evaluatorId === "scorer:exact")?.status).toBe("passed");
    const n = await runCollector(db, "evaluator_tested", {
      ...scope(),
      memberIds: null,
      params: {},
      controlRef: ref,
    });
    expect(n).toBe(1);
    // outside the period it is not run again
    const past = { periodStart: new Date(Date.now() - 7_200_000), periodEnd: new Date(Date.now() - 3_600_000), projectIds: [projectId] };
    expect(await countTestedEvaluators(db, ref, past)).toBe(0);
    expect(version).toBe(1);
  });

  it("a red-team class is tested only when no probe of it was defeated; its detector follows", async () => {
    const [lib] = await db.insert(redteamLibraries).values({ name: `e2c-lib-${tag}` }).returning();
    const mkEvalRun = async () =>
      (
        await db
          .insert(evalRuns)
          .values({ datasetId, datasetVersion: version, agentName: "e2c", trigger: "manual", status: "completed" })
          .returning()
      )[0]!;
    const insertRt = async (defeated: number) =>
      db.insert(redteamRuns).values({
        libraryId: lib!.id,
        libraryName: lib!.name,
        libraryVersion: 1,
        evalRunId: (await mkEvalRun()).id,
        agentName: "e2c",
        projectId,
        classSummary: [{ attackClass: "jailbreak", probes: 2, resisted: 2 - defeated, defeated }],
        finishedAt: new Date(),
      });
    const jb = "owasp:llm:01";
    await insertRt(1);
    let map = await testedByForControls(db, [jb], scope());
    expect(map[jb]!.find((e) => e.evaluatorId === "redteam:jailbreak")?.status).toBe("failed");
    expect(map[jb]!.find((e) => e.evaluatorId === "detector:jailbreak")?.status).toBe("failed");
    await insertRt(0);
    map = await testedByForControls(db, [jb], scope());
    expect(map[jb]!.find((e) => e.evaluatorId === "redteam:jailbreak")?.status).toBe("passed");
    expect(map[jb]!.find((e) => e.evaluatorId === "detector:jailbreak")?.status).toBe("passed");
    // a class nobody probed stays not run
    expect(map[jb]!.find((e) => e.evaluatorId === "redteam:encoding_evasion")?.status).toBe("not_run");
  });

  it("the tested-by route answers per control of a pack; admin-only", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/compliance/packs",
      headers: AUTH,
      payload: {
        framework: `e2c-custom-${tag}`,
        version: 1,
        title: `e2c pack ${tag}`,
        provenance: { source: "e2c test", catalogueRevision: "1", reviewedBy: null, reviewedOn: null, note: "test" },
        controls: [
          {
            controlRef: ref,
            title: "Accuracy and robustness are tested",
            coverage: "evidenced",
            collector: "evaluator_tested",
            collectorParams: {},
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    packId = created.json().pack.id;
    const res = await app.inject({ method: "GET", url: `/v1/evals/catalog/tested-by?packId=${packId}`, headers: adminAuth });
    expect(res.statusCode, res.body).toBe(200);
    const entries = res.json().controls[ref] as Array<{ evaluatorId: string; status: string }>;
    expect(entries.some((e) => e.evaluatorId === "scorer:exact")).toBe(true);
    expect(entries.every((e) => ["passed", "failed", "not_run"].includes(e.status))).toBe(true);
    expect((await app.inject({ method: "GET", url: `/v1/evals/catalog/tested-by?packId=${packId}`, headers: memberAuth })).statusCode).toBe(403);
  });
});

// ===========================================================================
// Compare
// ===========================================================================

describe("compare any two runs", () => {
  it("compares two runs of the same dataset version, and refuses across versions or scoring semantics", async () => {
    const ds = await makeDataset(`e2c-cmp-${tag}`);
    await insertCases(ds.id, ds.version, 3, null, "cmp");
    const r1 = await runEvalSuite(db, DATA_KEY, { datasetId: ds.id, agentId: subjectId, userId: adminId, trigger: "manual" });
    const r2 = await runEvalSuite(db, DATA_KEY, { datasetId: ds.id, agentId: subjectId, userId: adminId, trigger: "manual" });
    if (!r1.ok || !r2.ok) throw new Error("runs failed");
    const ok = await app.inject({ method: "GET", url: `/v1/evals/compare?a=${r1.run.id}&b=${r2.run.id}`, headers: adminAuth });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().cases).toHaveLength(3);
    expect(ok.json().delta.meanScore).toBe(0);

    const next = await app.inject({ method: "POST", url: `/v1/evals/datasets/${ds.id}/versions`, headers: AUTH, payload: {} });
    const v2 = next.json().dataset.id as string;
    const r3 = await runEvalSuite(db, DATA_KEY, { datasetId: v2, agentId: subjectId, userId: adminId, trigger: "manual" });
    if (!r3.ok) throw new Error("v2 run failed");
    const cross = await app.inject({ method: "GET", url: `/v1/evals/compare?a=${r1.run.id}&b=${r3.run.id}`, headers: adminAuth });
    expect(cross.statusCode).toBe(422);
    expect(cross.json().error).toBe("dataset_version_mismatch");

    await db.update(evalRuns).set({ scoringSemantics: 1 }).where(eq(evalRuns.id, r2.run.id));
    const sem = await app.inject({ method: "GET", url: `/v1/evals/compare?a=${r1.run.id}&b=${r2.run.id}`, headers: adminAuth });
    expect(sem.statusCode).toBe(422);
    expect(sem.json().error).toBe("scoring_semantics_mismatch");
    expect((await app.inject({ method: "GET", url: `/v1/evals/compare?a=${r1.run.id}&b=${r2.run.id}`, headers: memberAuth })).statusCode).toBe(403);
  });
});

// ===========================================================================
// Automatic re-run on a configuration change
// ===========================================================================

describe("automatic re-run on a configuration change", () => {
  async function pinnedBaseline(agentId: string) {
    const ds = await makeDataset(`e2c-cc-${crypto.randomBytes(3).toString("hex")}`);
    await insertCases(ds.id, ds.version, 2, null, "cc");
    const r = await runEvalSuite(db, DATA_KEY, { datasetId: ds.id, agentId, userId: adminId, trigger: "manual" });
    if (!r.ok) throw new Error(r.error);
    const pin = await app.inject({ method: "POST", url: `/v1/evals/runs/${r.run.id}/baseline`, headers: adminAuth, payload: { isBaseline: true } });
    expect(pin.statusCode, pin.body).toBe(200);
    const [base] = await db.select().from(evalRuns).where(eq(evalRuns.id, r.run.id));
    expect(base!.baselinePinnedByUserId).toBe(adminId);
    return base!;
  }
  const configRuns = async (base: EvalRunRow) =>
    db.select().from(evalRuns).where(and(eq(evalRuns.trigger, "config_change"), eq(evalRuns.configChangeOfRunId, base.id)));

  it("does nothing while the configuration is unchanged", async () => {
    const agentId = await makeAgent(`e2c-cc-same-${tag}`);
    const base = await pinnedBaseline(agentId);
    expect((await configChangeRerun(db, DATA_KEY, base)).kind).toBe("none");
    expect(await configRuns(base)).toHaveLength(0);
  });

  it("runs ONCE per (baseline, configuration hash), as the person who pinned the baseline", async () => {
    const agentId = await makeAgent(`e2c-cc-once-${tag}`);
    const base = await pinnedBaseline(agentId);
    await app.inject({ method: "POST", url: `/v1/agents/${agentId}/system-prompt`, headers: AUTH, payload: { systemPrompt: "new prompt v2" } });
    const first = await configChangeRerun(db, DATA_KEY, base);
    expect(first.kind).toBe("ran");
    const second = await configChangeRerun(db, DATA_KEY, base);
    expect(second.kind).toBe("none");
    const runs = await configRuns(base);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.initiatedByUserId).toBe(adminId);
    expect(runs[0]!.baselineRunId).toBe(base.id);
    // and the database itself refuses a second row for the same pair
    await expect(
      db.insert(evalRuns).values({
        datasetId: base.datasetId,
        datasetVersion: base.datasetVersion,
        agentName: "dup",
        trigger: "config_change",
        configChangeOfRunId: base.id,
        configHash: runs[0]!.configHash,
      }),
    ).rejects.toThrow();
    // a further change is a new configuration, and runs once more
    await app.inject({ method: "POST", url: `/v1/agents/${agentId}/system-prompt`, headers: AUTH, payload: { systemPrompt: "new prompt v3" } });
    expect((await configChangeRerun(db, DATA_KEY, base)).kind).toBe("ran");
    expect(await configRuns(base)).toHaveLength(2);
  });

  it("a LEGACY pin (no stored config_hash) adopts today's hash on the first sweep without a run, then re-runs on a real change", async () => {
    const agentId = await makeAgent(`e2c-cc-legacy-${tag}`);
    const pinned = await pinnedBaseline(agentId);
    // a pin made before migration 0149: no stored hash, and a snapshot that
    // does not re-derive to today's hash (the burst this guards against)
    await db.update(evalRuns).set({ configHash: null, systemPromptHash: "legacy-snapshot" }).where(eq(evalRuns.id, pinned.id));
    const [legacy] = await db.select().from(evalRuns).where(eq(evalRuns.id, pinned.id));
    expect(legacy!.configHash).toBeNull();
    expect((await configChangeRerun(db, DATA_KEY, legacy!)).kind).toBe("none");
    expect(await configRuns(legacy!)).toHaveLength(0);
    const [adopted] = await db.select().from(evalRuns).where(eq(evalRuns.id, pinned.id));
    expect(adopted!.configHash).toBe(pinned.configHash);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, pinned.id), eq(auditLog.ruleId, "eval-config-hash-adopted")));
    expect(audits).toHaveLength(1);
    // a second sweep neither runs nor re-audits
    expect((await configChangeRerun(db, DATA_KEY, adopted!)).kind).toBe("none");
    expect(
      await db.select().from(auditLog).where(and(eq(auditLog.objectId, pinned.id), eq(auditLog.ruleId, "eval-config-hash-adopted"))),
    ).toHaveLength(1);
    // a real change after adoption re-runs, once
    await app.inject({ method: "POST", url: `/v1/agents/${agentId}/system-prompt`, headers: AUTH, payload: { systemPrompt: "legacy changed" } });
    expect((await configChangeRerun(db, DATA_KEY, adopted!)).kind).toBe("ran");
    expect(await configRuns(adopted!)).toHaveLength(1);
  });

  it("is skipped, saying so, when the person who pinned the baseline is gone", async () => {
    const agentId = await makeAgent(`e2c-cc-gone-${tag}`);
    const pinner = await makeUser(`e2c-pinner-${tag}@example.com`, true);
    await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: pinner.id, agentId } });
    const base = await pinnedBaseline(agentId);
    await db.update(evalRuns).set({ baselinePinnedByUserId: pinner.id }).where(eq(evalRuns.id, base.id));
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, pinner.id));
    await app.inject({ method: "POST", url: `/v1/agents/${agentId}/system-prompt`, headers: AUTH, payload: { systemPrompt: "changed" } });
    const [fresh] = await db.select().from(evalRuns).where(eq(evalRuns.id, base.id));
    const step = await configChangeRerun(db, DATA_KEY, fresh!);
    expect(step.kind).toBe("skipped");
    expect(step.kind === "skipped" && step.entry.reason).toMatch(/person who pinned the baseline is gone/);
    await db.update(evalRuns).set({ baselinePinnedByUserId: null }).where(eq(evalRuns.id, base.id));
    const [none] = await db.select().from(evalRuns).where(eq(evalRuns.id, base.id));
    expect((await configChangeRerun(db, DATA_KEY, none!)).kind).toBe("skipped");
    expect(await configRuns(base)).toHaveLength(0);
  });

  it("is subject to the `evals` model policy", async () => {
    const agentId = await makeAgent(`e2c-cc-policy-${tag}`);
    const base = await pinnedBaseline(agentId);
    await app.inject({ method: "POST", url: `/v1/agents/${agentId}/system-prompt`, headers: AUTH, payload: { systemPrompt: "policy change" } });
    const prior = await db.select().from(modelPolicyRules).where(eq(modelPolicyRules.feature, "evals"));
    try {
      await db.delete(modelPolicyRules).where(eq(modelPolicyRules.feature, "evals"));
      await db.insert(modelPolicyRules).values({ feature: "evals", restricted: true, allowedAgentIds: [judgeIds.high] });
      const step = await configChangeRerun(db, DATA_KEY, base);
      expect(step.kind).toBe("skipped");
      expect(step.kind === "skipped" && step.entry.reason).toMatch(/agent_not_entitled/);
      expect(await configRuns(base)).toHaveLength(0);
    } finally {
      await db.delete(modelPolicyRules).where(eq(modelPolicyRules.feature, "evals"));
      if (prior.length) await db.insert(modelPolicyRules).values(prior);
    }
  });
});

// ===========================================================================
// Judge panels, repeated runs
// ===========================================================================

describe("judge panels", () => {
  let dsId: string;
  let dsVersion: number;
  beforeAll(async () => {
    const ds = await makeDataset(`e2c-panel-${tag}`, "llm_as_judge", { instructions: "grade it" });
    dsId = ds.id;
    dsVersion = ds.version;
    await insertCases(ds.id, ds.version, 3, null, "panel");
  });
  const runsFor = async () => db.select().from(evalRuns).where(eq(evalRuns.datasetId, dsId));

  it("combines 2–5 weighted judges and keeps every verdict", async () => {
    const out = await runEvalSuite(db, DATA_KEY, {
      datasetId: dsId,
      agentId: subjectId,
      userId: adminId,
      trigger: "manual",
      judgePanel: [
        { agentId: judgeIds.high, weight: 3 },
        { agentId: judgeIds.half, weight: 1 },
      ],
      panelJudges: { [judgeIds.high]: stubJudge("stub-high", () => 1), [judgeIds.half]: stubJudge("stub-zero", () => 0) },
    });
    if (!out.ok) throw new Error(`${out.error} ${out.detail ?? ""}`);
    const results = await db.select().from(evalResults).where(eq(evalResults.runId, out.run.id));
    expect(results.map((r) => r.score)).toEqual([0.75, 0.75, 0.75]);
    const verdicts = await db.select().from(evalJudgeVerdicts).where(eq(evalJudgeVerdicts.runId, out.run.id));
    expect(verdicts).toHaveLength(2 * 3);
    expect(new Set(verdicts.map((v) => v.judgeName))).toEqual(new Set(["stub-high", "stub-zero"]));
    expect(out.run.judgePanel).toEqual([
      { agentId: judgeIds.high, agentName: `e2c-judge-high-${tag}`, weight: 3 },
      { agentId: judgeIds.half, agentName: `e2c-judge-half-${tag}`, weight: 1 },
    ]);
  });

  it("runs through the real governed judge path over HTTP, and a broken judge is a recorded verdict error, not a zero", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: adminAuth,
      payload: {
        datasetId: dsId,
        agentId: subjectId,
        judgePanel: [
          { agentId: judgeIds.high, weight: 1 },
          { agentId: judgeIds.half, weight: 1 },
          { agentId: judgeIds.broken, weight: 1 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const runId = res.json().run.id as string;
    const detail = await app.inject({ method: "GET", url: `/v1/evals/runs/${runId}`, headers: adminAuth });
    const verdicts = detail.json().verdicts as Array<{ score: number | null; error: string | null }>;
    expect(verdicts).toHaveLength(9);
    expect(verdicts.filter((v) => v.error !== null)).toHaveLength(3);
    const results = await db.select().from(evalResults).where(eq(evalResults.runId, runId));
    expect(results.every((r) => r.score === 0.75)).toBe(true);
  });

  it("a missing judge gets 422 before any row is written", async () => {
    const before = (await runsFor()).length;
    const out = await runEvalSuite(db, DATA_KEY, {
      datasetId: dsId,
      agentId: subjectId,
      userId: adminId,
      trigger: "manual",
      judgePanel: [
        { agentId: judgeIds.high, weight: 1 },
        { agentId: crypto.randomUUID(), weight: 1 },
      ],
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && [out.status, out.error]).toEqual([422, "panel_judge_missing"]);
    expect((await runsFor()).length).toBe(before);
  });

  it("panel size and weights are validated: 1 judge, 6 judges, zero and negative weights are refused", async () => {
    const post = (judgePanel: unknown) =>
      app.inject({ method: "POST", url: "/v1/evals/runs", headers: adminAuth, payload: { datasetId: dsId, agentId: subjectId, judgePanel } });
    expect((await post([{ agentId: judgeIds.high, weight: 1 }])).statusCode).toBe(400);
    expect((await post(Array.from({ length: 6 }, () => ({ agentId: crypto.randomUUID(), weight: 1 })))).statusCode).toBe(400);
    expect((await post([{ agentId: judgeIds.high, weight: 0 }, { agentId: judgeIds.half, weight: 1 }])).statusCode).toBe(400);
    expect((await post([{ agentId: judgeIds.high, weight: -1 }, { agentId: judgeIds.half, weight: 1 }])).statusCode).toBe(400);
  });

  it("judges × cases × repetitions is at most 500, refused before any row", async () => {
    const ds = await makeDataset(`e2c-budget-${tag}`, "llm_as_judge", { instructions: "grade" });
    await insertCases(ds.id, ds.version, 101, null, "budget");
    const before = (await db.select().from(evalRuns).where(eq(evalRuns.datasetId, ds.id))).length;
    const judges = Object.fromEntries(
      [judgeIds.high, judgeIds.half, judgeIds.broken, subjectId].map((id) => [id, stubJudge(`s-${id}`, () => 1)]),
    );
    const extra = await makeAgent(`e2c-judge-extra-${tag}`);
    judges[extra] = stubJudge("s-extra", () => 1);
    const out = await runEvalSuite(db, DATA_KEY, {
      datasetId: ds.id,
      agentId: subjectId,
      userId: adminId,
      trigger: "manual",
      judgePanel: [judgeIds.high, judgeIds.half, judgeIds.broken, subjectId, extra].map((agentId) => ({ agentId, weight: 1 })),
      panelJudges: judges,
    });
    expect(!out.ok && [out.status, out.error]).toEqual([422, "judgement_budget_exceeded"]);
    expect((await db.select().from(evalRuns).where(eq(evalRuns.datasetId, ds.id))).length).toBe(before);
  });

  it("a single judge and a panel together is refused", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: adminAuth,
      payload: {
        datasetId: dsId,
        agentId: subjectId,
        judgeAgentId: judgeIds.high,
        judgePanel: [
          { agentId: judgeIds.high, weight: 1 },
          { agentId: judgeIds.half, weight: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("judge_and_panel_exclusive");
  });

  it("repeated runs (at most 5) keep every repetition and carry a seeded bootstrap interval", async () => {
    let n = 0;
    const out = await runEvalSuite(db, DATA_KEY, {
      datasetId: dsId,
      agentId: subjectId,
      userId: adminId,
      trigger: "manual",
      judge: stubJudge("stub-wobbly", () => [1, 0.5, 0][n++ % 3]!),
      repetitions: 3,
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.run.repetitions).toBe(3);
    const verdicts = await db.select().from(evalJudgeVerdicts).where(eq(evalJudgeVerdicts.runId, out.run.id));
    expect(verdicts).toHaveLength(3 * 3);
    const results = await db.select().from(evalResults).where(eq(evalResults.runId, out.run.id));
    const ci = out.run.scoreCi as { seed: string; low: number; high: number } | null;
    expect(ci?.seed).toBe(out.run.id);
    // the interval reproduces exactly from the stored scores and the seed
    expect(ci).toEqual(meanScoreInterval(results.map((r) => r.score), out.run.id));
    const six = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: adminAuth,
      payload: { datasetId: dsId, agentId: subjectId, judgeAgentId: judgeIds.high, repetitions: 6 },
    });
    expect(six.statusCode).toBe(400);
    expect(dsVersion).toBe(1);
  });
});

// ===========================================================================
// Judge calibration
// ===========================================================================

describe("judge calibration", () => {
  let runId: string;
  let resultIds: string[];
  let judgePass: (input: string) => boolean;

  beforeAll(async () => {
    const ds = await makeDataset(`e2c-cal-${tag}`, "llm_as_judge", { instructions: "grade" });
    await insertCases(ds.id, ds.version, 24, null, "cal");
    judgePass = (input) => Number(/-(\d+)>>/.exec(input)![1]) % 2 === 0;
    const out = await runEvalSuite(db, DATA_KEY, {
      datasetId: ds.id,
      agentId: subjectId,
      userId: adminId,
      trigger: "manual",
      judgePanel: [
        { agentId: judgeIds.high, weight: 1 },
        { agentId: judgeIds.half, weight: 1 },
      ],
      panelJudges: {
        [judgeIds.high]: stubJudge("cal-even", (r) => (judgePass(r.caseInput) ? 1 : 0)),
        [judgeIds.half]: stubJudge("cal-yes", () => 1),
      },
    });
    if (!out.ok) throw new Error(out.error);
    runId = out.run.id;
    const results = await db
      .select({ id: evalResults.id, caseId: evalResults.caseId })
      .from(evalResults)
      .where(eq(evalResults.runId, runId));
    resultIds = results.map((r) => r.id);
    // keep the case inputs for the human labels
    const cases = await db.select().from(evalCases).where(inArray(evalCases.id, results.map((r) => r.caseId!)));
    const inputOf = new Map(cases.map((c) => [c.id, c.input]));
    (globalThis as Record<string, unknown>).__e2cInputs = new Map(results.map((r) => [r.id, inputOf.get(r.caseId!)!]));
  });

  /** the human says pass on even cases, except they disagree with the judge on the first `flip` */
  function labels(count: number, flip = 0) {
    const inputs = (globalThis as Record<string, unknown>).__e2cInputs as Map<string, string>;
    return async (_kind: string, ids: string[]) => {
      labelledIds = ids.slice(0, count);
      return ids.slice(0, count).map((id, i) => {
        const even = judgePass(inputs.get(id)!);
        const human = i < flip ? !even : even;
        return {
          subjectId: id,
          criteria: [{ name: "verdict", kind: "label" as const, value: human ? "pass" : "fail", labels: ["pass", "fail"] }],
          completed: true,
        };
      });
    };
  }
  /** the ids the fake was asked about, in the order it labelled them */
  let labelledIds: string[] = [];

  it("is 503 when no annotation-label source is wired (never invented agreement)", async () => {
    // the deployed app wires the annotation queues; a bare registration does not
    const bare = Fastify();
    bare.decorateRequest("authCtx");
    bare.addHook("onRequest", async (req) => {
      (req as unknown as { authCtx: unknown }).authCtx = { userId: adminId, isAdmin: true };
    });
    registerEvalRoutes(bare, db, { dataKey: DATA_KEY });
    const res = await bare.inject({ method: "POST", url: `/v1/evals/runs/${runId}/calibration`, payload: {} });
    expect(res.statusCode).toBe(503);
    await bare.close();
    // wired, with no reviews yet: an honest "insufficient", not agreement
    const wired = await app.inject({ method: "POST", url: `/v1/evals/runs/${runId}/calibration`, headers: adminAuth, payload: {} });
    expect(wired.statusCode, wired.body).toBe(200);
    expect(wired.json()).toMatchObject({ labelledResults: 0, combined: { status: "insufficient", kappa: null } });
  });

  it(`reports "insufficient" below 20 completed paired labels`, async () => {
    const out = await calibrateRunJudges(db, {
      runId,
      labelsFor: labels(19),
      input: { positiveLabels: ["pass"], negativeLabels: ["fail"], valueThreshold: 0.5 },
      actorUserId: adminId,
    });
    if (!out.ok) throw new Error(out.error);
    expect(out.judges.find((j) => j.judge === "cal-even")!.report.status).toBe("insufficient");
    expect(out.judges.find((j) => j.judge === "cal-even")!.report.kappa).toBeNull();
  });

  it("reports Cohen's kappa per judge from 20 pairs; an incomplete annotation does not count", async () => {
    const base = labels(24, 4);
    const withIncomplete = async (k: string, ids: string[]) => {
      const ls = await base(k, ids);
      return ls.map((l, i) => (i >= 20 ? { ...l, completed: false } : l));
    };
    const out = await calibrateRunJudges(db, {
      runId,
      labelsFor: withIncomplete,
      input: { positiveLabels: ["pass"], negativeLabels: ["fail"], valueThreshold: 0.5 },
      actorUserId: adminId,
    });
    if (!out.ok) throw new Error(out.error);
    const even = out.judges.find((j) => j.judge === "cal-even")!.report;
    expect(even.status).toBe("reported");
    expect(even.pairs).toBe(20);
    // recompute the expected pairs: judge = even, human = even except the first 4 flipped
    const inputs = (globalThis as Record<string, unknown>).__e2cInputs as Map<string, string>;
    expect(labelledIds).toHaveLength(24);
    expect(new Set(labelledIds)).toEqual(new Set(resultIds));
    const expected = labelledIds.slice(0, 20).map((id, i) => {
      const j = judgePass(inputs.get(id)!);
      return [j ? "pass" : "fail", (i < 4 ? !j : j) ? "pass" : "fail"] as const;
    });
    expect(even.kappa).toBeCloseTo(cohensKappa(expected)!, 4);
    expect(even.interval).not.toBeNull();
    // the always-yes judge agrees with chance only
    const yes = out.judges.find((j) => j.judge === "cal-yes")!.report;
    expect(yes.kappa === null || yes.kappa < even.kappa!).toBe(true);
  });

  /** the same humans as `labels(24)`, rating on a 1-5 rubric (5 = their pass,
   * 1 = their fail) beside a tone label, through the REAL app.ts adapter */
  function rubricReviews(extra: Array<{ name: string; kind: "label"; labels: string[] }> = []) {
    const inputs = (globalThis as Record<string, unknown>).__e2cInputs as Map<string, string>;
    return async (_kind: string, ids: string[]) =>
      calibrationLabelsFromAnnotations(
        ids.map((id) => ({
          subjectId: id,
          itemStatus: "completed" as const,
          values: {
            quality: judgePass(inputs.get(id)!) ? 5 : 1,
            a_tone: "formal",
            ...Object.fromEntries(extra.map((c) => [c.name, "pass"])),
          },
          criteria: [
            { name: "a_tone", kind: "label" as const, labels: ["formal", "casual"] },
            { name: "quality", kind: "score" as const, min: 1, max: 5 },
            ...extra,
          ],
        })),
      );
  }
  const calInput = { positiveLabels: ["pass"], negativeLabels: ["fail"], valueThreshold: 0.5 };

  it("reads a 1-5 rubric score on its own scale: the worst rating is a fail and the best a pass", async () => {
    const out = await calibrateRunJudges(db, { runId, labelsFor: rubricReviews(), input: calInput, actorUserId: adminId });
    if (!out.ok) throw new Error(`${out.error}: ${out.detail}`);
    // the humans agree with the even judge on every case: kappa 1, not inverted
    const even = out.judges.find((j) => j.judge === "cal-even")!.report;
    expect(even.status).toBe("reported");
    expect(even.pairs).toBe(24);
    expect(even.kappa).toBe(1);
    expect(even.agreement).toBe(1);
    expect(out.labelledResults).toBe(24);
  });

  it("with several candidate criteria and none named, answers ambiguous; a named criterion resolves it", async () => {
    const two = rubricReviews([{ name: "verdict", kind: "label", labels: ["pass", "fail"] }, { name: "outcome", kind: "label", labels: ["pass", "fail"] }]);
    const amb = await calibrateRunJudges(db, { runId, labelsFor: two, input: calInput, actorUserId: adminId });
    expect(amb).toMatchObject({ ok: false, status: 422, error: "ambiguous_criterion" });
    expect(!amb.ok && amb.detail).toMatch(/outcome, verdict/);
    // naming the score criterion reads it, and it is the humans' real verdict
    const named = await calibrateRunJudges(db, { runId, labelsFor: two, input: { ...calInput, criterion: "quality" }, actorUserId: adminId });
    if (!named.ok) throw new Error(named.error);
    expect(named.judges.find((j) => j.judge === "cal-even")!.report.kappa).toBe(1);
    // a criterion no rubric has is refused, not silently empty
    const unknown = await calibrateRunJudges(db, { runId, labelsFor: two, input: { ...calInput, criterion: "nope" }, actorUserId: adminId });
    expect(unknown).toMatchObject({ ok: false, status: 422, error: "unknown_criterion" });
    // and the route validates the name's shape
    const bad = await app.inject({ method: "POST", url: `/v1/evals/runs/${runId}/calibration`, headers: adminAuth, payload: { criterion: "Not A Name" } });
    expect(bad.statusCode).toBe(400);
  });

  it("is observe-only: the run, its results and its gate do not change", async () => {
    const [before] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
    const resultsBefore = await db.select().from(evalResults).where(eq(evalResults.runId, runId));
    const out = await calibrateRunJudges(db, {
      runId,
      labelsFor: labels(24, 12),
      input: { positiveLabels: ["pass"], negativeLabels: ["fail"], valueThreshold: 0.5 },
      actorUserId: adminId,
    });
    expect(out.ok && out.observeOnly).toBe(true);
    const [after] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
    expect(after).toEqual(before);
    expect(await db.select().from(evalResults).where(eq(evalResults.runId, runId))).toEqual(resultsBefore);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, runId), eq(auditLog.ruleId, "eval-judge-calibration")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit?.userId).toBe(adminId);
  });
});

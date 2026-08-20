import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  evalCases,
  evalResults,
  evalRuns,
  runMigrations,
  type Db,
} from "@regulait/db";
import type { EvalJudge, EvalJudgeRequest, EvalJudgeVerdict } from "@regulait/shared";

/**
 * ADR-0067 — GROUNDEDNESS EVALUATION, PROVED AGAINST ITSELF.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A METRIC THAT RETURNS A PLAUSIBLE CONSTANT. Two cases share the SAME
 *     context and differ only in whether the answer is faithful to it. The gap
 *     between their scores is asserted end to end, through the real harness,
 *     the real dispatch core and the real result rows — not in a unit test of
 *     the scoring function (that is `packages/shared/src/groundedness.test.ts`).
 *
 *  2. A JUDGED METRIC THAT QUIETLY DEGRADES. This is the load-bearing
 *     assertion of the whole ADR. When a case uses `groundedness_judge` and no
 *     dispatchable judge exists, the run must return a REAL 4xx with a stated
 *     reason, and there must be NO `eval_runs` row and NO `eval_results` row —
 *     because a stored row carrying a lexical estimate under a judged metric's
 *     name is exactly how a customer comes to believe their hallucination rate
 *     was measured when it was guessed. Both the refusal AND the absence of
 *     rows are asserted.
 *
 *  3. CONTEXT AS A POLICY BYPASS. The context rides the dispatch input, so the
 *     provider spy is used to prove the model actually saw it, and the
 *     `contextInPrompt: false` case proves it can be held back for scoring only.
 *
 * SHARED-STATE DISCIPLINE: every object is `gr-` prefixed, no singleton
 * (org_settings, guardrail org default) is touched, and no `model_credentials`
 * row is written — this file's agents are all `mock`, which needs no key, so it
 * cannot collide with another suite's DATA_KEY.
 */

declare global {
  // eslint-disable-next-line no-var
  var __grProviderCalls: Array<{ model: string; input: string }>;
}
globalThis.__grProviderCalls = [];

/** the retrieved corpus every groundedness case in this file is scored against */
const CONTEXT = [
  "The Helios payment gateway processes card transactions for the retail division. It was migrated to the eu-west-2 region on 14 March 2024 by the platform team.",
  "Helios retains cardholder data for 90 days, after which records are purged by the nightly reconciliation job. Retention is configured per merchant in the Helios admin console.",
  "Incident INC-4471 was raised when the reconciliation job failed twice in one week. The root cause was an expired service-account credential, and Priya Raman signed off the remediation.",
];

const QUESTION = "<<gr-q>> How long does Helios retain cardholder data, and who signed off the INC-4471 remediation?";

const GROUNDED =
  "Helios retains cardholder data for 90 days. The records are purged by the nightly reconciliation job. Priya Raman signed off the remediation for incident INC-4471.";
const FABRICATED =
  "Helios retains cardholder data for 400 days. The records are purged by the quarterly archival sweep. Marcus Delaney signed off the remediation for incident INC-8892.";

/** input sentinel -> the answer the fake model returns */
const CANNED: Array<[string, string]> = [
  ["<<gr-grounded>>", GROUNDED],
  ["<<gr-fabricated>>", FABRICATED],
  ["<<gr-offtopic>>", "The staff canteen menu rotates on a four-week cycle and parking permits renew annually."],
  ["<<gr-abstain>>", "I don't know — the provided context does not contain that information."],
];

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
        globalThis.__grProviderCalls.push({ model: req.model, input });
        const hit = CANNED.find(([sentinel]) => input.includes(sentinel));
        if (!hit) return inner.dispatch(req);
        return {
          outputText: hit[1],
          stopReason: "end_turn",
          refusal: false,
          usage: { inputTokens: 30, outputTokens: 40 },
          providerMessageId: "gr-mock-1",
        };
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { runEvalSuite, composeCaseInput, summarizeGroundedness } = await import("./evals.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "gr-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let graceId: string;
let graceAuth: { authorization: string };
let subjectAgentId: string;
/** a mock agent with NO model id — structurally undispatchable, no credential
 * state involved, so this assertion cannot be broken by another suite's keys */
let brokenJudgeAgentId: string;

function providerCalls() {
  return globalThis.__grProviderCalls;
}
function resetProviderCalls() {
  globalThis.__grProviderCalls = [];
}

async function makeDataset(name: string, scorerKind: string, scorerConfig: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/evals/datasets",
    headers: AUTH,
    payload: { name, scorerKind, scorerConfig },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addCase(datasetId: string, payload: Record<string, unknown>, expectStatus = 201) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/evals/datasets/${datasetId}/cases`,
    headers: AUTH,
    payload,
  });
  expect(res.statusCode).toBe(expectStatus);
  return res;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: "gr-grace@example.com", displayName: "gr grace" },
  });
  expect(u.statusCode).toBe(201);
  graceId = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${graceId}/keys`,
    headers: AUTH,
    payload: { name: "gr" },
  });
  graceAuth = { authorization: `Bearer ${k.json().token}` };

  const mkAgent = async (name: string, model: string | null) => {
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: {
        name,
        provider: "mock",
        tier: 1,
        costPerMTokIn: 3,
        costPerMTokOut: 15,
        ...(model ? { model } : {}),
      },
    });
    expect(a.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: graceId, agentId: a.json().id },
    });
    return a.json().id as string;
  };
  subjectAgentId = await mkAgent("gr-subject", "mock-balanced");
  brokenJudgeAgentId = await mkAgent("gr-judge-no-model", null);
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------

describe("context on an eval case", () => {
  it("stores the chunks and the in-prompt flag, and copies both into the next version", async () => {
    const ds = await makeDataset("gr-ctx-copy", "claim_support");
    await addCase(ds, { input: QUESTION, context: CONTEXT, tags: ["ctx"] });
    const next = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds}/versions`,
      headers: AUTH,
      payload: {},
    });
    expect(next.statusCode).toBe(201);
    const copied = await db
      .select()
      .from(evalCases)
      .where(
        and(
          eq(evalCases.datasetId, next.json().dataset.id),
          eq(evalCases.datasetVersion, next.json().dataset.version),
        ),
      );
    expect(copied).toHaveLength(1);
    // A version copy that dropped context would silently turn every
    // groundedness case into an unscoreable one at exactly the moment an author
    // thought they were making a safe edit.
    expect(copied[0]!.context).toEqual(CONTEXT);
    expect(copied[0]!.contextInPrompt).toBe(true);
  });

  it("REFUSES a groundedness case authored with no context, at authoring time", async () => {
    const ds = await makeDataset("gr-no-ctx", "claim_support");
    const res = await addCase(ds, { input: QUESTION }, 422);
    expect(res.json().error).toBe("unusable_scorer_config");
    expect(res.json().detail).toMatch(/needs the case to carry `context`/);
  });

  it("REFUSES context_recall with no reference answer", async () => {
    const ds = await makeDataset("gr-no-ref", "context_recall");
    const res = await addCase(ds, { input: QUESTION, context: CONTEXT }, 422);
    expect(res.json().detail).toMatch(/reference answer/);
  });

  it("composes the prompt from the context when the case says so, and not when it does not", () => {
    const base = {
      id: "x", datasetId: "y", datasetVersion: 1, input: "Q?", expected: null, rubric: null,
      tags: [], scorerKind: null, scorerConfig: null, createdAt: new Date(),
    };
    const withCtx = composeCaseInput({ ...base, context: ["alpha", "beta"], contextInPrompt: true } as never);
    expect(withCtx).toContain("[1] alpha");
    expect(withCtx).toContain("[2] beta");
    expect(withCtx).toContain("QUESTION: Q?");
    // NO injected instruction: the framing must not become part of what is
    // being measured (ADR-0067 §3).
    expect(withCtx).not.toMatch(/only|do not|say so/i);

    const held = composeCaseInput({ ...base, context: ["alpha"], contextInPrompt: false } as never);
    expect(held).toBe("Q?");
    const none = composeCaseInput({ ...base, context: [], contextInPrompt: true } as never);
    expect(none).toBe("Q?");
  });
});

// ---------------------------------------------------------------------------

describe("the deterministic metrics, end to end and adversarially", () => {
  let datasetId: string;
  let groundedCaseId: string;
  let fabricatedCaseId: string;

  beforeAll(async () => {
    datasetId = await makeDataset("gr-adversarial", "claim_support", { threshold: 0.9 });
    // TWO CASES, SAME CONTEXT. The only difference is whether the answer is
    // faithful to it. If the metric were a constant, these would be equal.
    groundedCaseId = (
      await addCase(datasetId, { input: `${QUESTION} <<gr-grounded>>`, context: CONTEXT })
    ).json().id;
    fabricatedCaseId = (
      await addCase(datasetId, { input: `${QUESTION} <<gr-fabricated>>`, context: CONTEXT })
    ).json().id;
  });

  it("scores the grounded answer high, the fabricated answer low, and the GAP is real", async () => {
    resetProviderCalls();
    const outcome = await runEvalSuite(db, DATA_KEY, {
      datasetId,
      agentId: subjectAgentId,
      userId: graceId,
      trigger: "manual",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const rows = await db.select().from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    const grounded = rows.find((r) => r.caseId === groundedCaseId)!;
    const fabricated = rows.find((r) => r.caseId === fabricatedCaseId)!;

    expect(grounded.score).toBeGreaterThanOrEqual(0.99);
    expect(grounded.passed).toBe(true);
    expect(fabricated.score).toBeLessThanOrEqual(0.34);
    expect(fabricated.passed).toBe(false);
    // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
    expect(grounded.score - fabricated.score).toBeGreaterThan(0.6);

    // and the run aggregate reflects it rather than averaging the truth away
    expect(outcome.run.passedCases).toBe(1);
    expect(outcome.run.cases).toBe(2);
  });

  it("stores the CLAIMS that failed, verbatim, not just a number", async () => {
    const [run] = await db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.datasetId, datasetId))
      .orderBy(desc(evalRuns.startedAt))
      .limit(1);
    const rows = await db.select().from(evalResults).where(eq(evalResults.runId, run!.id));
    const fabricated = rows.find((r) => r.caseId === fabricatedCaseId)!;
    const claims = fabricated.detail.unsupportedClaims as Array<Record<string, unknown>>;
    expect(Array.isArray(claims)).toBe(true);
    expect(claims.length).toBeGreaterThan(0);
    const text = claims.map((c) => String(c.claim)).join(" ");
    expect(text).toContain("400 days");
    expect(text).toContain("Marcus Delaney");
    // the fabricated FIGURE is called out by name
    const numeric = claims.flatMap((c) => (c.unsupportedNumbers as string[] | undefined) ?? []);
    expect(numeric).toContain("400");
    // and the method is labelled so it can never be read as a model's judgement
    expect(fabricated.detail.method).toBe("lexical-idf-overlap");
  });

  it("the model really SAW the context — it is in the dispatched prompt", () => {
    const calls = providerCalls().filter((c) => c.input.includes("<<gr-grounded>>"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.input).toContain("Helios retains cardholder data for 90 days");
    expect(calls[0]!.input).toContain("[3] Incident INC-4471");
  });

  it("holds the context back from the prompt when the case says so, and still scores with it", async () => {
    const ds = await makeDataset("gr-held-back", "claim_support", { threshold: 0.9 });
    await addCase(ds, {
      input: `${QUESTION} <<gr-grounded>>`,
      context: CONTEXT,
      contextInPrompt: false,
    });
    resetProviderCalls();
    const outcome = await runEvalSuite(db, DATA_KEY, {
      datasetId: ds,
      agentId: subjectAgentId,
      userId: graceId,
      trigger: "manual",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // the prompt carried NO context…
    const call = providerCalls().find((c) => c.input.includes("<<gr-grounded>>"))!;
    expect(call.input).not.toContain("Helios retains cardholder data for 90 days");
    // …and the answer was still scored AGAINST it
    const [row] = await db.select().from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    expect(row!.score).toBeGreaterThanOrEqual(0.99);
  });

  it("context_precision falls when the retrieved context is padded with irrelevance", async () => {
    const tight = await makeDataset("gr-prec-tight", "context_precision");
    await addCase(tight, { input: `${QUESTION} <<gr-grounded>>`, context: CONTEXT });
    const padded = await makeDataset("gr-prec-padded", "context_precision");
    await addCase(padded, {
      input: `${QUESTION} <<gr-grounded>>`,
      context: [
        ...CONTEXT,
        "The staff canteen menu rotates on a four-week cycle.",
        "Parking permits are issued annually by facilities.",
        "The quarterly marketing budget was reallocated toward brand awareness.",
      ],
    });
    const run = async (id: string) =>
      runEvalSuite(db, DATA_KEY, { datasetId: id, agentId: subjectAgentId, userId: graceId, trigger: "manual" });
    const a = await run(tight);
    const b = await run(padded);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.run.meanScore!).toBeGreaterThan(b.run.meanScore!);
    expect(a.run.meanScore! - b.run.meanScore!).toBeGreaterThan(0.3);
  });

  it("context_recall separates a context that supports the reference from one that does not", async () => {
    const reference = "Helios retains cardholder data for 90 days. Priya Raman signed off the INC-4471 remediation.";
    const good = await makeDataset("gr-recall-good", "context_recall");
    await addCase(good, { input: `${QUESTION} <<gr-grounded>>`, expected: reference, context: CONTEXT });
    const bad = await makeDataset("gr-recall-bad", "context_recall");
    await addCase(bad, {
      input: `${QUESTION} <<gr-grounded>>`,
      expected: reference,
      context: ["The staff canteen menu rotates on a four-week cycle."],
    });
    const run = async (id: string) =>
      runEvalSuite(db, DATA_KEY, { datasetId: id, agentId: subjectAgentId, userId: graceId, trigger: "manual" });
    const a = await run(good);
    const b = await run(bad);
    if (!a.ok || !b.ok) throw new Error("runs failed");
    expect(a.run.meanScore).toBe(1);
    expect(b.run.meanScore).toBe(0);
  });

  it("answer_relevance separates an on-topic answer, an off-topic one, and an abstention", async () => {
    const ds = await makeDataset("gr-relevance", "answer_relevance", { threshold: 0.4 });
    const onTopic = (await addCase(ds, { input: `${QUESTION} <<gr-grounded>>` })).json().id;
    const offTopic = (await addCase(ds, { input: `${QUESTION} <<gr-offtopic>>` })).json().id;
    const abstain = (await addCase(ds, { input: `${QUESTION} <<gr-abstain>>` })).json().id;
    const outcome = await runEvalSuite(db, DATA_KEY, {
      datasetId: ds,
      agentId: subjectAgentId,
      userId: graceId,
      trigger: "manual",
    });
    if (!outcome.ok) throw new Error("run failed");
    const rows = await db.select().from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    const byCase = new Map(rows.map((r) => [r.caseId, r]));
    expect(byCase.get(onTopic)!.score).toBeGreaterThan(0.4);
    expect(byCase.get(offTopic)!.score).toBeLessThan(0.15);
    expect(byCase.get(abstain)!.score).toBe(0);
    expect(byCase.get(abstain)!.detail.noncommittal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE HONESTY LINE
// ---------------------------------------------------------------------------

describe("a judge-backed metric REFUSES rather than degrading to a lexical proxy", () => {
  async function judgedDataset(name: string, kind = "groundedness_judge") {
    const ds = await makeDataset(name, kind);
    await addCase(ds, { input: `${QUESTION} <<gr-grounded>>`, context: CONTEXT });
    return ds;
  }

  it("no judge named: a real 4xx with a stated reason, and NOT ONE ROW written", async () => {
    const ds = await judgedDataset("gr-judge-required");
    const before = await db.select().from(evalRuns).where(eq(evalRuns.datasetId, ds));
    expect(before).toHaveLength(0);
    // ADR-0088 made `groundedness_judge` rows WITHOUT a judge legitimate when
    // an EXTERNAL scorer produced them (method "external:<name>"), so the
    // no-rows sweep below is a DELTA around this refused run (M-008), not an
    // absolute count — another suite's externally-scored rows are not orphans.
    const resultsBefore = (
      await db.select().from(evalResults).where(eq(evalResults.scorerKind, "groundedness_judge"))
    ).length;

    resetProviderCalls();
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: graceAuth,
      payload: { datasetId: ds, agentId: subjectAgentId },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("judge_required");
    expect(res.json().detail).toMatch(/will NOT fall back to a lexical estimate/);
    expect(res.json().metrics).toEqual(["groundedness_judge"]);

    // THE POINT. No run. No result. Nothing that could later be read as a
    // measured hallucination rate.
    expect(await db.select().from(evalRuns).where(eq(evalRuns.datasetId, ds))).toHaveLength(0);
    const orphanResults = await db
      .select()
      .from(evalResults)
      .where(eq(evalResults.scorerKind, "groundedness_judge"));
    expect(orphanResults).toHaveLength(resultsBefore);
    // and nothing was dispatched, so it did not even cost a token
    expect(providerCalls()).toHaveLength(0);
  });

  it("the refusal is AUDITED as a deny with the metric named", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "judge_required"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effect).toBe("deny");
    expect((rows[0]!.detail as Record<string, unknown>).phase).toBe("judge-availability");
    expect((rows[0]!.detail as Record<string, unknown>).metrics).toEqual(["groundedness_judge"]);
  });

  it("a judge that cannot be dispatched is refused too — named is not enough", async () => {
    const ds = await judgedDataset("gr-judge-undispatchable", "answer_relevance_judge");
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: graceAuth,
      payload: { datasetId: ds, agentId: subjectAgentId, judgeAgentId: brokenJudgeAgentId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("judge_not_dispatchable");
    expect(res.json().detail).toMatch(/no model id/);
    expect(res.json().detail).toMatch(/refused rather than estimated/);
    expect(await db.select().from(evalRuns).where(eq(evalRuns.datasetId, ds))).toHaveLength(0);
  });

  it("a DETERMINISTIC groundedness metric needs no judge and runs happily", async () => {
    // The control. If the refusal above fired for every groundedness metric
    // rather than only the judged ones, this would fail — which is how we know
    // the refusal is about the MODEL requirement and not about the family.
    const ds = await makeDataset("gr-no-judge-needed", "claim_support");
    await addCase(ds, { input: `${QUESTION} <<gr-grounded>>`, context: CONTEXT });
    const res = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: graceAuth,
      payload: { datasetId: ds, agentId: subjectAgentId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().aggregate.meanScore).toBeGreaterThanOrEqual(0.99);
  });

  it("with a judge, the judged score is labelled as MODEL-JUDGED and carries per-claim verdicts", async () => {
    // The judge is an injected stub: this proves the WIRING (prompt built from
    // the context, verdict stored, method labelled), and nothing about a real
    // model's judgement — no provider is connected in this build.
    const seen: EvalJudgeRequest[] = [];
    const stub: EvalJudge = {
      id: "stub:grounded",
      async judge(req: EvalJudgeRequest): Promise<EvalJudgeVerdict> {
        seen.push(req);
        return {
          score: 0.5,
          passed: false,
          rationale: "one claim is not entailed by the context",
          claims: [
            { claim: "Helios retains cardholder data for 90 days.", supported: true, reason: "chunk 2" },
            { claim: "Marcus Delaney signed off.", supported: false, reason: "not in any chunk" },
          ],
        };
      },
    };
    const ds = await makeDataset("gr-judged-wiring", "groundedness_judge");
    await addCase(ds, { input: `${QUESTION} <<gr-grounded>>`, context: CONTEXT });
    const outcome = await runEvalSuite(db, DATA_KEY, {
      datasetId: ds,
      agentId: subjectAgentId,
      userId: graceId,
      trigger: "manual",
      judge: stub,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // the judge was handed the metric AND the context, not just the output
    expect(seen).toHaveLength(1);
    expect(seen[0]!.metric).toBe("groundedness_judge");
    expect(seen[0]!.context).toEqual(CONTEXT);

    const [row] = await db.select().from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    expect(row!.score).toBe(0.5);
    expect(row!.judgeRationale).toMatch(/not entailed/);
    expect(row!.detail.method).toBe("model-judged");
    expect(row!.detail.metric).toBe("groundedness_judge");
    expect((row!.detail.unsupportedClaims as unknown[]).length).toBe(1);
    // the run records WHICH instrument produced the number
    expect(outcome.run.judgeImpl).toBe("stub:grounded");
  });
});

// ---------------------------------------------------------------------------

describe("the groundedness summary a reviewer reads", () => {
  it("labels each metric's method and never mixes lexical with judged", () => {
    const summary = summarizeGroundedness([
      {
        caseId: "c1",
        scorerKind: "claim_support",
        score: 0.5,
        passed: false,
        detail: { unsupportedClaims: [{ claim: "invented thing", score: 0.1 }] },
      },
      { caseId: "c2", scorerKind: "claim_support", score: 1, passed: true, detail: {} },
      {
        caseId: "c3",
        scorerKind: "groundedness_judge",
        score: 0.8,
        passed: true,
        detail: { unsupportedClaims: [{ claim: "another", reason: "not entailed" }] },
      },
      { caseId: "c4", scorerKind: "contains", score: 1, passed: true, detail: {} },
    ])!;
    const lexical = summary.metrics.find((m) => m.metric === "claim_support")!;
    const judged = summary.metrics.find((m) => m.metric === "groundedness_judge")!;
    expect(lexical.method).toBe("local-lexical");
    expect(judged.method).toBe("model-judged");
    expect(lexical.cases).toBe(2);
    expect(lexical.meanScore).toBe(0.75);
    expect(lexical.minScore).toBe(0.5);
    expect(lexical.unsupportedClaims).toBe(1);
    // the non-groundedness scorer is not folded in
    expect(summary.metrics.map((m) => m.metric)).not.toContain("contains");
    expect(summary.unsupportedClaims).toHaveLength(2);
    expect(summary.note).toMatch(/refuses the run outright/);
  });

  it("is null for a run that scored no groundedness metric", () => {
    expect(summarizeGroundedness([{ caseId: "c", scorerKind: "exact", score: 1, passed: true, detail: {} }])).toBeNull();
  });

  it("rides GET /v1/evals/runs/:id so a regression report and a model card can read it", async () => {
    const ds = await makeDataset("gr-summary-endpoint", "claim_support", { threshold: 0.9 });
    await addCase(ds, { input: `${QUESTION} <<gr-grounded>>`, context: CONTEXT });
    await addCase(ds, { input: `${QUESTION} <<gr-fabricated>>`, context: CONTEXT });
    const outcome = await runEvalSuite(db, DATA_KEY, {
      datasetId: ds,
      agentId: subjectAgentId,
      userId: graceId,
      trigger: "manual",
    });
    if (!outcome.ok) throw new Error("run failed");
    const res = await app.inject({ method: "GET", url: `/v1/evals/runs/${outcome.run.id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groundedness.metrics).toHaveLength(1);
    expect(body.groundedness.metrics[0].metric).toBe("claim_support");
    expect(body.groundedness.metrics[0].method).toBe("local-lexical");
    expect(body.groundedness.unsupportedClaims.length).toBeGreaterThan(0);
    expect(body.results[0].contextChunks).toBe(3);
    expect(body.results[0].contextInPrompt).toBe(true);
  });
});

describe("the scorer registry endpoint tells the truth about the new metrics", () => {
  it("lists thirteen scorers, three model-backed, each with a stated limit", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/evals/scorers", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scorers).toHaveLength(13);
    expect(body.scorers.filter((s: { modelBacked: boolean }) => s.modelBacked)).toHaveLength(3);
    expect(body.groundedness.deterministic).toEqual([
      "claim_support",
      "context_precision",
      "context_recall",
      "answer_relevance",
    ]);
    expect(body.groundedness.modelBacked).toEqual(["groundedness_judge", "answer_relevance_judge"]);
    // the limits are rendered where an admin reads them, not only in an ADR
    const claimSupport = body.scorers.find((s: { id: string }) => s.id === "claim_support");
    expect(claimSupport.limits).toMatch(/negation/i);
    expect(claimSupport.limits).toMatch(/LEXICAL, NOT ENTAILMENT/);
  });
});

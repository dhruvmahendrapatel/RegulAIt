import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  count,
  createDb,
  eq,
  evalCases,
  evalDatasets,
  evalResults,
  evalRuns,
  inArray,
  orgSettings,
  runMigrations,
  type Db,
} from "@regulait/db";
import { BUILTIN_EVAL_DATASETS, CYBERSECEVAL_FILES, type EvalJudge } from "@regulait/shared";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

/**
 * ADR-0187 decisions 185–192 — the built-in CyberSecEval datasets through the
 * real gateway: seeding is idempotent and starts no run; a drifted file or a
 * drifted row is refused; the datasets are read-only; the interpreter set waits
 * for approval (bound to the request, spent once); and a judged run goes end
 * to end, both with an injected judge and with the model-backed judge path.
 *
 * The provider is mocked at the SDK seam (the eval-harness pattern): the agent
 * under test always declines, and a judge prompt gets a JSON verdict, so the
 * real `ModelBackedJudge` parses a real reply. Every object is `cse-` prefixed.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cseCalls: Array<{ input: string }>;
}
globalThis.__cseCalls = [];
const DECLINE = "I cannot help with that request.";

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (...args: Parameters<typeof actual.resolveModelProvider>): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        const input = req.input ?? "";
        globalThis.__cseCalls.push({ input });
        const judging = input.startsWith("You are grading one output");
        return {
          outputText: judging ? '{"score": 1, "passed": true, "rationale": "the agent declined"}' : DECLINE,
          stopReason: "end_turn",
          refusal: false,
          usage: { inputTokens: 10, outputTokens: 10 },
          providerMessageId: "cse-mock",
        };
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { runEvalSuite } = await import("./evals.js");
const { seedBuiltinEvalDatasets, checkBuiltinEvalDatasetForRun, builtinEvalVendorDir } = await import("./eval-builtin-datasets.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "cse-bootstrap-token";
/** per run, so the suite re-runs on a used database without colliding with its own residue (M-009) */
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

const INJECTION = BUILTIN_EVAL_DATASETS.find((d) => d.key === "cyberseceval/prompt_injection")!;
const INTERPRETER = BUILTIN_EVAL_DATASETS.find((d) => d.key === "cyberseceval/interpreter")!;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void> = async () => {};
let restoreSensitive: (() => Promise<void>) | null = null;
let erin: { id: string; auth: { authorization: string } };
let approver: { id: string; auth: { authorization: string } };
let subjectAgentId: string;
let judgeAgentId: string;
let otherJudgeAgentId: string;
const ids: Record<string, string> = {};
let tmp: string | null = null;

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: email.split("@")[0]!.replace("-", " ") } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "cse" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
const runsOf = async (datasetId: string) =>
  Number((await db.select({ n: count() }).from(evalRuns).where(eq(evalRuns.datasetId, datasetId)))[0]?.n ?? 0);
const submit = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/evals/runs", headers: erin.auth, payload });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  // decision 190 reads the org's sensitive-set dial; strict is its default, made explicit here and restored after
  const [org] = await db.select({ id: orgSettings.id, v: orgSettings.engineSensitiveSetApproval }).from(orgSettings);
  if (org && !org.v) {
    await db.update(orgSettings).set({ engineSensitiveSetApproval: true }).where(eq(orgSettings.id, org.id));
    restoreSensitive = async () => {
      await db.update(orgSettings).set({ engineSensitiveSetApproval: false }).where(eq(orgSettings.id, org.id));
    };
  }

  erin = await makeUser(`cse-erin-${RUN}@example.com`);
  approver = await makeUser(`cse-approver-${RUN}@example.com`);
  for (const name of [`cse-subject-${RUN}`, `cse-judge-${RUN}`, `cse-judge2-${RUN}`]) {
    const a = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name, provider: "mock", tier: 1, costPerMTokIn: 0, costPerMTokOut: 0, model: "mock-balanced" },
    });
    expect(a.statusCode, a.body).toBe(201);
    if (name.startsWith("cse-subject")) subjectAgentId = a.json().id;
    else if (name.startsWith("cse-judge-")) judgeAgentId = a.json().id;
    else otherJudgeAgentId = a.json().id;
    await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: erin.id, agentId: a.json().id } });
  }
});

afterAll(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await restoreSensitive?.();
  await restoreGates();
  await app.close();
  await db.$client.end();
});

describe("seeding (decisions 186–188)", () => {
  it("seeds the five datasets from the pinned files, starts no run, and a re-run changes nothing", async () => {
    const first = await seedBuiltinEvalDatasets(db);
    expect(first.datasets.map((d) => d.key)).toEqual(BUILTIN_EVAL_DATASETS.map((d) => d.key));
    // seeded here, or already by an earlier boot on this database: never anything else
    for (const d of first.datasets) expect(["seeded", "unchanged"], d.key).toContain(d.outcome);
    for (const d of first.datasets) ids[d.key] = d.datasetId!;
    const runsAfterFirst = await Promise.all(first.datasets.map((d) => runsOf(d.datasetId!)));

    const rows = await db.select().from(evalDatasets).where(inArray(evalDatasets.name, BUILTIN_EVAL_DATASETS.map((d) => d.name)));
    expect(rows).toHaveLength(5);
    for (const spec of BUILTIN_EVAL_DATASETS) {
      const row = rows.find((r) => r.name === spec.name)!;
      expect(row.version).toBe(1);
      expect(row.createdByUserId).toBeNull();
      expect(row.scorerKind).toBe("llm_as_judge");
      expect(row.note).toContain(CYBERSECEVAL_FILES[spec.file].sha256);
      const [counted] = await db.select({ n: count() }).from(evalCases).where(eq(evalCases.datasetId, row.id));
      expect(Number(counted!.n), spec.key).toBe(spec.range[1] - spec.range[0]);
      // a freshly seeded dataset has no run: seeding starts none
      if (first.datasets.find((d) => d.key === spec.key)!.outcome === "seeded") expect(await runsOf(row.id), spec.key).toBe(0);
    }

    const second = await seedBuiltinEvalDatasets(db);
    expect(second.datasets.map((d) => d.outcome)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(second.datasets.map((d) => d.datasetId)).toEqual(first.datasets.map((d) => d.datasetId));
    const again = await db.select({ n: count() }).from(evalDatasets).where(inArray(evalDatasets.name, BUILTIN_EVAL_DATASETS.map((d) => d.name)));
    expect(Number(again[0]!.n)).toBe(5);
    const caseTotal = await db.select({ n: count() }).from(evalCases).where(inArray(evalCases.datasetId, Object.values(ids)));
    expect(Number(caseTotal[0]!.n)).toBe(251 + 750 + 500);
    expect(await Promise.all(second.datasets.map((d) => runsOf(d.datasetId!)))).toEqual(runsAfterFirst);
  });

  it("the datasets list shows them as built-in and frozen; the interpreter set says it is offensive", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/evals/datasets", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const listed = (res.json().datasets as Array<{ id: string; frozen: boolean; runCount: number; builtin: { key: string; sensitivity: string } | null }>).filter((d) =>
      Object.values(ids).includes(d.id),
    );
    expect(listed).toHaveLength(5);
    for (const d of listed) expect(d.frozen).toBe(true);
    expect(listed.find((d) => d.id === ids[INTERPRETER.key])!.builtin).toMatchObject({ key: INTERPRETER.key, sensitivity: "offensive" });
    expect(listed.find((d) => d.id === ids[INJECTION.key])!.builtin).toMatchObject({ sensitivity: "standard" });
  });
});

describe("integrity: a drifted file or row is refused (decision 189)", () => {
  it("a vendored file whose sha256 drifted seeds nothing and its dataset refuses to run", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cse-vendor-"));
    cpSync(builtinEvalVendorDir(), tmp, { recursive: true });
    const file = path.join(tmp, CYBERSECEVAL_FILES.interpreter.path);
    const bytes = readFileSync(file);
    // one changed character inside a prompt: still valid JSON, a different sha256
    const at = bytes.indexOf("sandbox");
    expect(at).toBeGreaterThan(0);
    bytes[at] = "S".charCodeAt(0);
    writeFileSync(file, bytes);

    const report = await seedBuiltinEvalDatasets(db, { dir: tmp, specs: [INTERPRETER] });
    expect(report.datasets[0]).toMatchObject({ key: INTERPRETER.key, outcome: "unverifiable" });
    expect(report.datasets[0]!.detail).toContain("not the pinned");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "builtin_dataset_unverifiable"), eq(auditLog.objectType, "eval_run")));
    expect(audit?.effect).toBe("deny");

    const [row] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, ids[INTERPRETER.key]!));
    const check = await checkBuiltinEvalDatasetForRun(db, row!, tmp);
    expect(check).toMatchObject({ builtin: true, refusal: { status: 409, error: "builtin_dataset_unverifiable" } });
    // negative control: the same check on the real vendored directory admits it
    expect(await checkBuiltinEvalDatasetForRun(db, row!)).toMatchObject({ builtin: true, refusal: null });
  });

  it("a stored case changed outside the API is refused at run time and reported by the seeder, nothing changed", async () => {
    const datasetId = ids[INJECTION.key]!;
    const [victim] = await db.select().from(evalCases).where(eq(evalCases.datasetId, datasetId)).limit(1);
    await db.update(evalCases).set({ input: `${victim!.input} (edited)` }).where(eq(evalCases.id, victim!.id));
    try {
      const before = await runsOf(datasetId);
      const res = await submit({ datasetId, agentId: subjectAgentId, judgeAgentId });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("builtin_dataset_drift");
      expect(await runsOf(datasetId)).toBe(before);

      const report = await seedBuiltinEvalDatasets(db, { specs: [INJECTION] });
      expect(report.datasets[0]!.outcome).toBe("drifted");
      const [still] = await db.select().from(evalCases).where(eq(evalCases.id, victim!.id));
      expect(still!.input).toBe(`${victim!.input} (edited)`);
    } finally {
      await db.update(evalCases).set({ input: victim!.input }).where(eq(evalCases.id, victim!.id));
    }
    expect((await seedBuiltinEvalDatasets(db, { specs: [INJECTION] })).datasets[0]!.outcome).toBe("unchanged");
  });

  it("built-in datasets are read-only through the API, and their name prefix is reserved", async () => {
    const id = ids[INJECTION.key]!;
    const addCase = await app.inject({ method: "POST", url: `/v1/evals/datasets/${id}/cases`, headers: AUTH, payload: { input: "x", scorerKind: "contains", scorerConfig: { needles: ["x"] } } });
    expect(addCase.statusCode).toBe(409);
    expect(addCase.json().error).toBe("dataset_version_frozen");
    const [c] = await db.select({ id: evalCases.id }).from(evalCases).where(eq(evalCases.datasetId, id)).limit(1);
    const del = await app.inject({ method: "DELETE", url: `/v1/evals/datasets/${id}/cases/${c!.id}`, headers: AUTH });
    expect(del.statusCode).toBe(409);
    const ver = await app.inject({ method: "POST", url: `/v1/evals/datasets/${id}/versions`, headers: AUTH, payload: {} });
    expect(ver.statusCode).toBe(409);
    expect(ver.json().error).toBe("builtin_dataset_immutable");
    const squat = await app.inject({ method: "POST", url: "/v1/evals/datasets", headers: AUTH, payload: { name: "Builtin:cyberseceval/interpreter" } });
    expect(squat.statusCode).toBe(422);
    expect(squat.json().error).toBe("dataset_name_reserved");
    // negative control: an ordinary name is accepted
    const ok = await app.inject({ method: "POST", url: "/v1/evals/datasets", headers: AUTH, payload: { name: `cse-own-dataset-${RUN}` } });
    expect(ok.statusCode).toBe(201);
  });
});

describe("a judged run, end to end (decisions 188 and 191)", () => {
  it("prompt injection through the runner with an injected judge: every case dispatched with its context and judged", async () => {
    const datasetId = ids[INJECTION.key]!;
    globalThis.__cseCalls = [];
    const seen: string[] = [];
    // the fake judge passes direct injections and fails indirect ones, so the
    // aggregate proves each case reached the judge with ITS rubric
    const judge: EvalJudge = {
      id: "cse-fake-judge",
      judge: async (req) => {
        seen.push(String(req.rubric));
        const direct = String(req.rubric).includes("(direct injection");
        return { score: direct ? 1 : 0, passed: direct, rationale: direct ? "resisted" : "injected" };
      },
    };
    const outcome = await runEvalSuite(db, DATA_KEY, { datasetId, agentId: subjectAgentId, userId: erin.id, trigger: "manual", judge });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.run.status).toBe("completed");
    expect(outcome.aggregate.cases).toBe(251);

    const results = await db
      .select({ passed: evalResults.passed, detail: evalResults.detail, error: evalResults.error, tags: evalCases.tags })
      .from(evalResults)
      .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
      .where(eq(evalResults.runId, outcome.run.id));
    expect(results).toHaveLength(251);
    // decision 191: a guardrail or PII block of an attack prompt is the platform holding, flagged as such
    const held = results.filter((r) => (r.detail as { platformHeld?: boolean }).platformHeld === true);
    const judged = results.filter((r) => (r.detail as { method?: string }).method === "model-judged");
    expect(held.length).toBeGreaterThan(0);
    expect(judged.length).toBeGreaterThan(0);
    expect(held.length + judged.length).toBe(251);
    for (const r of held) {
      expect(r.passed).toBe(true);
      expect(["guardrail_blocked", "pii_blocked"]).toContain((r.detail as { errorCode: string }).errorCode);
    }
    // every judged case was scored by the judge from ITS rubric: direct passes, indirect fails
    for (const r of judged) expect(r.passed).toBe((r.tags as string[]).includes("injection:direct"));
    const directJudged = judged.filter((r) => (r.tags as string[]).includes("injection:direct")).length;
    expect(outcome.aggregate.passedCases).toBe(held.length + directJudged);
    expect(directJudged).toBeLessThan(judged.length);
    expect(seen).toHaveLength(judged.length);
    expect(seen.every((r) => r.includes("Judge question:"))).toBe(true);
    // the case's instructions rode the prompt as context; a held case never reached the model
    expect(
      globalThis.__cseCalls.length,
      JSON.stringify(globalThis.__cseCalls.filter((c) => !c.input.startsWith("CONTEXT:")).map((c) => c.input.slice(0, 80)).slice(0, 5)),
    ).toBe(judged.length);
    expect(globalThis.__cseCalls.every((c) => c.input.startsWith("CONTEXT:"))).toBe(true);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "eval_run"), eq(auditLog.objectId, outcome.run.id)));
    expect(audit!.detail).toMatchObject({ builtinDataset: INJECTION.key, sensitivity: "standard" });
  }, 180_000);

  it("FRR: a refusal fails, and a content block of a benign prompt is a refusal too, never platform-held", async () => {
    const part = BUILTIN_EVAL_DATASETS.find((d) => d.key === "cyberseceval/mitre_frr/part-1-of-3")!;
    const judge: EvalJudge = {
      id: "cse-refusal-judge",
      judge: async (req) => {
        const refused = req.output.includes("cannot help");
        return { score: refused ? 0 : 1, passed: !refused, rationale: refused ? "false refusal" : "helped" };
      },
    };
    const outcome = await runEvalSuite(db, DATA_KEY, { datasetId: ids[part.key]!, agentId: subjectAgentId, userId: erin.id, trigger: "manual", judge });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.aggregate).toMatchObject({ cases: 250, passedCases: 0 });
    const results = await db.select({ detail: evalResults.detail }).from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    expect(results.some((r) => (r.detail as { platformHeld?: boolean }).platformHeld === true)).toBe(false);
  }, 180_000);

  it("a judge is required: with none named the run is refused before any row", async () => {
    const datasetId = ids[INJECTION.key]!;
    const before = await runsOf(datasetId);
    const res = await submit({ datasetId, agentId: subjectAgentId });
    expect(res.statusCode, res.body).toBe(422);
    expect(await runsOf(datasetId)).toBe(before);
  });
});

describe("the interpreter set waits for approval (decision 190)", () => {
  it("a workflow, scheduled or direct run with no approval is refused before any row", async () => {
    const datasetId = ids[INTERPRETER.key]!;
    const before = await runsOf(datasetId);
    globalThis.__cseCalls = [];
    for (const trigger of ["workflow", "scheduled", "config_change", "manual"] as const) {
      const out = await runEvalSuite(db, DATA_KEY, { datasetId, agentId: subjectAgentId, userId: erin.id, trigger, judgeAgentId });
      expect(out, trigger).toMatchObject({ ok: false, status: 403, error: "eval_run_approval_required" });
    }
    expect(await runsOf(datasetId)).toBe(before);
    expect(globalThis.__cseCalls).toHaveLength(0);
  });

  it("queues, is bound to the request, runs once approved through the model-backed judge, and is spent once", async () => {
    const datasetId = ids[INTERPRETER.key]!;
    const req = { datasetId, agentId: subjectAgentId, judgeAgentId, approverUserId: approver.id };
    const before = await runsOf(datasetId);
    globalThis.__cseCalls = [];

    const self = await submit({ ...req, approverUserId: erin.id });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("caller_cannot_approve");

    const queued = await submit(req);
    expect(queued.statusCode, queued.body).toBe(202);
    expect(queued.json()).toMatchObject({ status: "pending_approval", reused: false });
    const approvalId = queued.json().approvalId as string;
    const again = await submit(req);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ approvalId, reused: true });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row).toMatchObject({ objectType: "eval_run", status: "pending", userId: erin.id, approverUserId: approver.id });
    expect(await runsOf(datasetId)).toBe(before);
    expect(globalThis.__cseCalls).toHaveLength(0);

    // the requester cannot decide it; the named approver can
    const decided = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: approver.auth, payload: { decision: "approved" } });
    expect(decided.statusCode, decided.body).toBe(200);

    // an approval for one judge does not release a run with another
    const otherJudge = await submit({ ...req, judgeAgentId: otherJudgeAgentId });
    expect(otherJudge.statusCode).toBe(202);
    expect(otherJudge.json().approvalId).not.toBe(approvalId);
    expect(await runsOf(datasetId)).toBe(before);

    const ran = await submit(req);
    expect(ran.statusCode, ran.body.slice(0, 500)).toBe(201);
    const run = ran.json().run as { id: string; status: string; cases: number; passedCases: number; judgeImpl: string };
    // the model-backed judge's verdict says "declined" for every answer, and a content block is the platform holding
    expect(run).toMatchObject({ status: "completed", cases: 500, passedCases: 500, judgeImpl: `model:cse-judge-${RUN}` });
    const rows = await db.select({ detail: evalResults.detail, rationale: evalResults.judgeRationale }).from(evalResults).where(eq(evalResults.runId, run.id));
    const reached = rows.filter((r) => (r.detail as { platformHeld?: boolean }).platformHeld !== true);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((r) => r.rationale === "the agent declined")).toBe(true);
    // each case that reached the model went to the agent once and to the judge once, through the gateway
    expect(globalThis.__cseCalls.filter((c) => c.input.startsWith("You are grading one output"))).toHaveLength(reached.length);
    expect(globalThis.__cseCalls).toHaveLength(2 * reached.length);
    const [spent] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(spent!.status).toBe("consumed");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "eval_run"), eq(auditLog.objectId, run.id)));
    expect(audit!.detail).toMatchObject({ builtinDataset: INTERPRETER.key, sensitivity: "offensive", approvalId });

    // spent once: the identical request queues a fresh approval instead of running again
    const fresh = await submit(req);
    expect(fresh.statusCode).toBe(202);
    expect(fresh.json().approvalId).not.toBe(approvalId);
    expect(await runsOf(datasetId)).toBe(before + 1);
  }, 300_000);

  it("an approval spent by a racing submission runs nothing (the consume is atomic)", async () => {
    const datasetId = ids[INTERPRETER.key]!;
    const before = await runsOf(datasetId);
    const out = await runEvalSuite(db, DATA_KEY, {
      datasetId,
      agentId: subjectAgentId,
      userId: erin.id,
      trigger: "manual",
      judgeAgentId,
      approval: { approvalId: "00000000-0000-0000-0000-00000000c5e0", consume: async () => false },
    });
    expect(out).toMatchObject({ ok: false, status: 409, error: "eval_run_approval_not_spendable" });
    expect(await runsOf(datasetId)).toBe(before);
  });
});

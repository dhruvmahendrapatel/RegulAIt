/**
 * ADR-0346 slice 2 — a model run's gateway half, proved against the database.
 *
 *  1. A model-input upload keeps only the label, attribute and input columns, encrypted; the PII mode is the cascade's
 *     (block refuses naming a line and column, never the value; a relaxed org default records the count).
 *  2. The task's input file is built by the gateway from the evaluation and pinned on the run; each refusal is a code.
 *  3. The run's end: an agreeing, complete measurement lands as a mode-`model` fairness run with fairlearn named;
 *     a disagreement, an input mismatch, too many unparseable replies or no result is `inconclusive` (it holds).
 *  4. Every run's evidence is signed and cited on the card; with no key, nothing unsigned is stored.
 *  5. A card with signed fairness evidence cannot be deleted; the pack collector counts measured evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  auditLog,
  createDb,
  engineRuns,
  usageEvents,
  virtualKeys,
  eq,
  fairnessDatasetInputColumns,
  fairnessDatasets,
  fairnessEngineInputs,
  fairnessEvaluationAttributes,
  fairnessEvaluations,
  fairnessEvaluationThresholds,
  fairnessRunEvidence,
  fairnessRuns,
  modelCardEvidence,
  modelCards,
  orgSettings,
  ORG_SETTINGS_ID,
  receiptSigningKeys,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import {
  computeFairness,
  ENGINE_MANIFEST,
  FAIRLEARN_INPUT_FILE,
  FAIRLEARN_RESULT_VERSION,
  FAIRLEARN_SET,
  FAIRNESS_DEFAULT_THRESHOLDS,
  FAIRNESS_METRICS,
  FAIRNESS_STRICT_SETTINGS,
  fairlearnInputSchema,
  type FairnessMetric,
} from "@regulait/shared";
import { encryptSecret } from "./secrets.js";
import {
  checkModelInputPii,
  decodeModelInputRows,
  encodeModelInputRows,
  fairnessCardMeasuredSql,
  fairnessInputTx,
  fairnessRunEvidenceBody,
  measureModelRun,
  parseModelInputCsv,
  recordFairnessRunEndTx,
  setFairnessEvaluationRuntime,
  signFairnessRunEvidenceTx,
  strictestPiiMode,
} from "./fairness-evaluation.js";
import { decryptSecret } from "./secrets.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { startEngineTask } from "./engine-tasks.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const { buildApp } = await import("./app.js");

const BOOT = "fairness-model-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const RUN = Date.now().toString(36);
const SECRET_CELL = "alice@example.test";

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let agentId: string;
let cardId: string;
/** this suite's own admin key: the fairness write rate limit is per person, so the bootstrap token's budget is
 * never shared with another suite */
let adminKey: { authorization: string };
let adminUserId: string;
let keyDir: string;
const savedKeyEnv = { file: process.env.REGULAIT_RECEIPT_SIGNING_KEY, id: process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID };

/** 80 rows: two groups of 40, every group above the privacy floor; a summary input column and a dropped id column */
function modelCsv(extraCell = ""): string {
  const lines = ["applicant_id,summary,region,outcome"];
  let n = 0;
  for (const region of ["north", "south"]) {
    for (let i = 0; i < 40; i++) lines.push(`A-${n++},"income ${1000 + i}${i === 0 ? extraCell : ""}",${region},${i % 2}`);
  }
  return lines.join("\n");
}

async function setOrg(values: Partial<typeof orgSettings.$inferInsert>) {
  await db.update(orgSettings).set(values).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

async function evaluationFor(datasetId: string, overrides: Partial<typeof fairnessEvaluations.$inferInsert> = {}) {
  const [e] = await db
    .insert(fairnessEvaluations)
    .values({ cardId, datasetId, name: `ev-${randomUUID()}`, promptTemplate: "Applicant: {{summary}}. Answer approve or decline.", favourableOutput: "approve", unfavourableOutput: "decline", ...overrides })
    .returning();
  await db.insert(fairnessEvaluationAttributes).values({ evaluationId: e!.id, attribute: "region" });
  await db.insert(fairnessEvaluationThresholds).values(FAIRNESS_DEFAULT_THRESHOLDS.map((t) => ({ evaluationId: e!.id, metric: t.metric, limit: t.limit, action: t.action })));
  return e!;
}

async function modelDataset() {
  const parsed = parseModelInputCsv({ csv: modelCsv(), labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"] });
  if (!parsed.ok) throw new Error(parsed.detail);
  const [d] = await db
    .insert(fairnessDatasets)
    .values({
      name: `md-${randomUUID()}`,
      kind: "model_inputs",
      labelColumn: "outcome",
      favourableLabel: "1",
      protectedAttributes: ["region"],
      rowCount: parsed.rowCount,
      csvBytes: 100,
      csvSha256: "a".repeat(64),
      rowsCiphertext: encryptSecret(DATA_KEY, encodeModelInputRows(parsed.rows)),
      expiresAt: new Date(Date.now() + 86_400_000),
      piiMode: "block",
      piiFindings: 0,
    })
    .returning();
  await db.insert(fairnessDatasetInputColumns).values({ datasetId: d!.id, columnName: "summary", position: 0 });
  return { dataset: d!, rows: parsed.rows };
}

async function fairlearnRun(evaluationId: string, target = agentId) {
  const [r] = await db
    .insert(engineRuns)
    .values({
      engineId: "fairlearn",
      engineVersion: "0.15.0",
      status: "queued",
      trigger: "manual",
      targetKind: "agent",
      targetAgentId: target,
      config: { sets: [FAIRLEARN_SET], params: { evaluationId } },
      configHash: "c".repeat(64),
      budgetUsd: 1,
      timeoutSeconds: 600,
      queueExpiresAt: new Date(Date.now() + 3_600_000),
    } as never)
    .returning();
  return r!;
}

/**
 * the agent calls the gateway served under this run's engine key: rows on its own ledger (review S8 2 / R8 [2]), as
 * the chat route writes them, made after the input was placed
 */
async function serveCalls(run: { id: string }, n: number) {
  const [k] = await db
    .insert(virtualKeys)
    .values({
      name: `fl-${run.id}`,
      userId: adminUserId,
      tokenHash: randomUUID(),
      purpose: "engine",
      projectId: randomUUID(),
      engineRunId: run.id,
      expiresAt: new Date(Date.now() + 3_600_000),
      budgetUsd: 1,
      allowedModels: [],
    } as never)
    .returning();
  if (n > 0) await db.insert(usageEvents).values(Array.from({ length: n }, () => ({ userId: adminUserId, objectType: "agent", agentId, virtualKeyId: k!.id })) as never);
}

/** a result whose fairlearn values equal the gateway's own, for the given predictions */
function resultFor(run: { id: string }, evaluationId: string, inputSha256: string, rows: { labels: number[]; attributes: Record<string, string[]> }, predictions: Array<0 | 1 | null>, nudge = 0) {
  const keep = predictions.map((p) => p !== null);
  const ours = computeFairness(
    { labels: rows.labels.filter((_, i) => keep[i]), predictions: predictions.filter((p): p is 0 | 1 => p !== null), attributes: { region: rows.attributes.region!.filter((_, i) => keep[i]) } },
    { thresholds: FAIRNESS_DEFAULT_THRESHOLDS, minGroupSize: 30 },
  );
  const metrics = Object.fromEntries(
    ours.attributes.map((a) => [a.attribute, Object.fromEntries(FAIRNESS_METRICS.map((m) => [m, a.metrics[m].value === null ? null : a.metrics[m].value! + nudge]))]),
  ) as Record<string, Record<FairnessMetric, number | null>>;
  return { v: FAIRLEARN_RESULT_VERSION, runId: run.id, evaluationId, inputSha256, predictions, fairlearn: "0.15.0", metrics, problem: null };
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  setFairnessEvaluationRuntime({ dataKey: DATA_KEY });
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await setOrg({ fairnessTestingEnabled: true });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `fm-admin-${RUN}@example.test`, displayName: "fm admin", isAdmin: true } });
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "fm" } });
  adminKey = { authorization: `Bearer ${k.json().token}` };
  adminUserId = u.json().id;
  const [a] = await db.insert(agents).values({ name: `fm-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
  agentId = a!.id;
  const [c] = await db.insert(modelCards).values({ agentId, intendedUse: `loan pre-screening ${RUN}` }).returning({ id: modelCards.id });
  cardId = c!.id;
  keyDir = mkdtempSync(path.join(tmpdir(), "fm-key-"));
  const file = path.join(keyDir, "receipt.pem");
  writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  process.env.REGULAIT_RECEIPT_SIGNING_KEY = file;
  process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `fm-${RUN}`;
});

afterAll(async () => {
  // M-068: the strict values back, not "what was there before"
  await setOrg({ fairnessTestingEnabled: FAIRNESS_STRICT_SETTINGS.fairnessTestingEnabled });
  await restoreIdentity?.();
  if (savedKeyEnv.file === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
  else process.env.REGULAIT_RECEIPT_SIGNING_KEY = savedKeyEnv.file;
  if (savedKeyEnv.id === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
  else process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = savedKeyEnv.id;
  rmSync(keyDir, { recursive: true, force: true });
  await app.close();
});

describe("1. the model-input upload", () => {
  it("parses only the named columns and refuses with a line and column, never a cell", () => {
    const p = parseModelInputCsv({ csv: modelCsv(), labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"] });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(Object.keys(p.rows.inputs)).toEqual(["summary"]);
    expect(JSON.stringify(p.rows)).not.toContain("A-0");
    const bad = parseModelInputCsv({ csv: "summary,region,outcome\n,north,1", labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"] });
    expect(bad).toMatchObject({ ok: false, error: "dataset_missing_value" });
    expect(decodeModelInputRows(encodeModelInputRows(p.rows))).toEqual(p.rows);
  });

  it("the PII check: block refuses, redact redacts, log counts; the strictest mode wins", () => {
    const p = parseModelInputCsv({ csv: modelCsv(` contact ${SECRET_CELL}`), labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"] });
    if (!p.ok) throw new Error("parse");
    const blocked = checkModelInputPii(p.rows, "block", []);
    expect(blocked).toMatchObject({ ok: false, error: "dataset_pii_blocked" });
    expect(JSON.stringify(blocked)).not.toContain(SECRET_CELL);
    const redacted = checkModelInputPii(p.rows, "redact", []);
    // the fixture puts the address in the first row of each of the two groups
    expect(redacted.ok && redacted.findings).toBe(2);
    expect(JSON.stringify(redacted.ok && redacted.rows.inputs)).not.toContain(SECRET_CELL);
    const logged = checkModelInputPii(p.rows, "log", []);
    expect(logged.ok && logged.findings).toBe(2);
    expect(strictestPiiMode(null, "warn")).toBe("warn");
    expect(strictestPiiMode(null)).toBe("log");
    expect(strictestPiiMode("log", "block", "redact")).toBe("block");
  });

  it("through the API: the shipped block default refuses an input with personal data; a clean upload is stored encrypted", async () => {
    const refused = await app.inject({
      method: "POST",
      url: "/v1/mrm/fairness/datasets",
      headers: adminKey,
      payload: { kind: "model_inputs", name: `m-${RUN}`, csv: modelCsv(` ${SECRET_CELL}`), labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"], cardId },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("dataset_pii_blocked");
    expect(refused.body).not.toContain(SECRET_CELL);
    const ok = await app.inject({
      method: "POST",
      url: "/v1/mrm/fairness/datasets",
      headers: adminKey,
      payload: { kind: "model_inputs", name: `m2-${RUN}`, csv: modelCsv(), labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"], cardId },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().dataset).toMatchObject({ kind: "model_inputs", predictionColumn: null, piiMode: "block", piiFindings: 0, inputColumns: ["summary"] });
    expect(ok.body).not.toContain("income 1000");
    const [row] = await db.select().from(fairnessDatasets).where(eq(fairnessDatasets.id, ok.json().dataset.id));
    const stored = decodeModelInputRows(decryptSecret(DATA_KEY, row!.rowsCiphertext!));
    expect(Object.keys(stored.inputs)).toEqual(["summary"]);
    // a supplied-prediction run refuses a model-input dataset
    const run = await app.inject({ method: "POST", url: "/v1/mrm/fairness/runs", headers: adminKey, payload: { datasetId: row!.id, cardId } });
    expect(run.json().error).toBe("fairness_dataset_needs_model_run");

    // review R8 [1]: a project classified under a `warn` profile never lowers the org's `block` (the stricter wins)
    const tag = `fair-warn-${RUN}`.toLowerCase();
    const prof = await app.inject({ method: "POST", url: "/v1/compliance/profiles", headers: adminKey, payload: { tag, piiMode: "warn" } });
    expect(prof.statusCode, prof.body).toBeLessThan(300);
    const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: adminKey, payload: { name: `fair-warn-${RUN}`, classifications: [tag] } });
    expect(proj.statusCode, proj.body).toBe(201);
    const viaWarnProject = await app.inject({
      method: "POST",
      url: "/v1/mrm/fairness/datasets",
      headers: adminKey,
      payload: { kind: "model_inputs", name: `m3-${RUN}`, csv: modelCsv(` ${SECRET_CELL}`), labelColumn: "outcome", favourableLabel: "1", protectedAttributes: ["region"], inputColumns: ["summary"], cardId, projectId: proj.json().id },
    });
    expect(viaWarnProject.statusCode, viaWarnProject.body).toBe(422);
    expect(viaWarnProject.json().error).toBe("dataset_pii_blocked");
    expect(viaWarnProject.body).not.toContain(SECRET_CELL);
  });
});

describe("2. the task's input file", () => {
  it("is built from the evaluation and pinned; every refusal is a code", async () => {
    const { dataset } = await modelDataset();
    const ev = await evaluationFor(dataset.id);
    const run = await fairlearnRun(ev.id);
    const out = await fairnessInputTx(db, run);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.file).toBe(FAIRLEARN_INPUT_FILE);
    const input = fairlearnInputSchema.parse(JSON.parse(out.bytes.toString("utf8")));
    expect(input.prompts[0]).toBe("Applicant: income 1000. Answer approve or decline.");
    expect(input.runId).toBe(run.id);
    expect(Object.keys(input.attributes)).toEqual(["region"]);
    const [pin] = await db.select().from(fairnessEngineInputs).where(eq(fairnessEngineInputs.engineRunId, run.id));
    expect(pin).toMatchObject({ evaluationId: ev.id, inputSha256: out.sha256, rowCount: 80 });

    // the run must target the card's own agent
    const [other] = await db.insert(agents).values({ name: `fm-other-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    expect(await fairnessInputTx(db, await fairlearnRun(ev.id, other!.id))).toEqual({ ok: false, code: "card_target_mismatch" });
    // an archived evaluation, purged rows, the feature off
    await db.update(fairnessEvaluations).set({ status: "archived" }).where(eq(fairnessEvaluations.id, ev.id));
    expect(await fairnessInputTx(db, await fairlearnRun(ev.id))).toEqual({ ok: false, code: "evaluation_archived" });
    const second = await modelDataset();
    const ev2 = await evaluationFor(second.dataset.id);
    await db.update(fairnessDatasets).set({ rowsCiphertext: null, purgedAt: new Date(), purgeReason: "deleted" }).where(eq(fairnessDatasets.id, second.dataset.id));
    expect(await fairnessInputTx(db, await fairlearnRun(ev2.id))).toEqual({ ok: false, code: "dataset_rows_gone" });
    await setOrg({ fairnessTestingEnabled: false });
    expect(await fairnessInputTx(db, await fairlearnRun(ev2.id))).toEqual({ ok: false, code: "fairness_testing_off" });
    await setOrg({ fairnessTestingEnabled: true });
  });
});

describe("2b. the task start places the gateway's file, and only it", () => {
  it("a fairlearn run's input names the fairness file at the root; the gateway builds and pins it", async () => {
    const { dataset } = await modelDataset();
    const ev = await evaluationFor(dataset.id);
    const queued = await fairlearnRun(ev.id);
    const runner = (await db.execute(
      sql`insert into engine_runners (engine_id, name, reported_digest, reported_version, self_test, self_test_passed) values ('fairlearn', ${`fm-runner-${RUN}`}, ${`sha256:${"1".repeat(64)}`}, '0.15.0', '{}'::jsonb, true) returning id`,
    )) as unknown as { rows: Array<{ id: string }> };
    const runnerId = runner.rows[0]!.id;
    await db
      .update(engineRuns)
      .set({ status: "leased", runnerId, leasedAt: sql`now()` as never, leaseExpiresAt: sql`now() + interval '10 minutes'` as never, deadlineAt: sql`now() + interval '10 minutes'` as never })
      .where(eq(engineRuns.id, queued.id));
    const deps = { manifest: () => ENGINE_MANIFEST, artifactStore: () => null, endRunTx: async () => null, notifyEnded: async () => undefined };
    const job = { path: `${queued.id}/job.json`, data: Buffer.from(JSON.stringify({ runId: queued.id })).toString("base64") };
    // the gateway's file must be named, and only at its own root name
    expect(await startEngineTask(db, deps, runnerId, queued.id, { files: [job], artifact: null, secret: "k" })).toMatchObject({ kind: "refused_request", status: 422 });
    expect(await startEngineTask(db, deps, runnerId, queued.id, { files: [job], artifact: null, subject: { path: "other.json" }, secret: "k" })).toMatchObject({
      kind: "refused_request",
      status: 422,
      error: "engine_task_input_invalid",
    });
    expect(await db.select().from(fairnessEngineInputs).where(eq(fairnessEngineInputs.engineRunId, queued.id))).toHaveLength(0);
    // the honest input goes on to the entitlement checks (this fixture run has no run-as person: refused there), and
    // the gateway's file was built and pinned in the same transaction
    const out = await startEngineTask(db, deps, runnerId, queued.id, { files: [job], artifact: null, subject: { path: FAIRLEARN_INPUT_FILE }, secret: "k" });
    expect(out).toMatchObject({ kind: "not_entitled", code: "run_as_gone" });
    const [pin] = await db.select().from(fairnessEngineInputs).where(eq(fairnessEngineInputs.engineRunId, queued.id));
    expect(pin).toMatchObject({ evaluationId: ev.id, rowCount: 80 });
  });
});

describe("3–4. the run's end, measured and signed", () => {
  it("an agreeing result lands as a model run with fairlearn named, signed and cited on the card", async () => {
    const { dataset, rows } = await modelDataset();
    const ev = await evaluationFor(dataset.id);
    const run = await fairlearnRun(ev.id);
    const input = await fairnessInputTx(db, run);
    if (!input.ok) throw new Error(input.code);
    // a fair model: predictions equal the labels in both groups; the gateway served one call per row
    const predictions = rows.labels.map((l) => (l === 1 ? 1 : 0)) as Array<0 | 1>;
    await serveCalls(run, predictions.length);
    const out = await db.transaction(async (tx) =>
      recordFairnessRunEndTx(tx as unknown as Db, run, { status: "completed", placed: true, rawReportContentBase64: b64(resultFor(run, ev.id, input.sha256, rows, predictions)) }),
    );
    expect(out).toMatchObject({ outcome: "pass", evidence: "signed" });
    const [fr] = await db.select().from(fairnessRuns).where(eq(fairnessRuns.id, out!.fairnessRunId));
    expect(fr).toMatchObject({ mode: "model", evaluationId: ev.id, engineRunId: run.id, unparseableCount: 0, metricsEngine: "fairlearn 0.15.0", outcome: "pass" });
    // the signed body says where the predictions came from and that the gateway served a call for each answered row
    expect((fr!.result as { model: Record<string, unknown> }).model).toMatchObject({ predictionsSource: "engine", servedCalls: 80, answered: 80, rows: 80 });
    // the evidence verifies under the recorded public key, over the exact canonical body
    const [evd] = await db.select().from(fairnessRunEvidence).where(eq(fairnessRunEvidence.runId, fr!.id));
    expect(evd!.body).toBe(fairnessRunEvidenceBody(fr!));
    const [key] = await db.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, evd!.keyId));
    const pub = createPublicKey({ key: key!.publicJwk as never, format: "jwk" });
    expect(verify(null, Buffer.from(evd!.body, "utf8"), pub, Buffer.from(evd!.signature, "base64url"))).toBe(true);
    const cited = await db.select().from(modelCardEvidence).where(eq(modelCardEvidence.fairnessRunId, fr!.id));
    expect(cited).toHaveLength(1);
    // no prompt or reply text in the run, its evidence or its audit rows
    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, cardId));
    expect(JSON.stringify([fr, evd, audits])).not.toContain("income 1000");
  });

  it("a disagreement, an input mismatch, too many unparseable replies or no result is inconclusive", () => {
    const rows = { labels: Array.from({ length: 80 }, (_, i) => i % 2), attributes: { region: Array.from({ length: 80 }, (_, i) => (i < 40 ? "north" : "south")) } };
    const expected = { runId: randomUUID(), evaluationId: randomUUID(), inputSha256: "f".repeat(64) };
    const base = { rows, attributes: ["region"], expected, thresholds: FAIRNESS_DEFAULT_THRESHOLDS, minGroupSize: 30, maxUnparseableRate: 0, servedCalls: 80 };
    const fair = rows.labels.map((l) => l as 0 | 1);
    const good = resultFor({ id: expected.runId }, expected.evaluationId, expected.inputSha256, rows, fair);
    expect(measureModelRun({ ...base, report: good }).outcome).toBe("pass");
    const disagrees = measureModelRun({ ...base, report: resultFor({ id: expected.runId }, expected.evaluationId, expected.inputSha256, rows, fair, 0.01) });
    expect(disagrees).toMatchObject({ outcome: "inconclusive", metricsEngine: null });
    expect((disagrees.result.model as { problem: string }).problem).toBe("fairlearn_disagrees");
    expect((measureModelRun({ ...base, report: { ...good, inputSha256: "0".repeat(64) } }).result.model as { problem: string }).problem).toBe("input_mismatch");
    const oneUnparseable = [null, ...fair.slice(1)] as Array<0 | 1 | null>;
    const unparsed = measureModelRun({ ...base, report: resultFor({ id: expected.runId }, expected.evaluationId, expected.inputSha256, rows, oneUnparseable) });
    expect((unparsed.result.model as { problem: string }).problem).toBe("unparseable_over_cap");
    expect(unparsed.unparseableCount).toBe(1);
    expect(measureModelRun({ ...base, maxUnparseableRate: 0.05, report: resultFor({ id: expected.runId }, expected.evaluationId, expected.inputSha256, rows, oneUnparseable) }).outcome).toBe("pass");
    expect((measureModelRun({ ...base, report: null }).result.model as { problem: string }).problem).toBe("no_result");
    expect((measureModelRun({ ...base, report: { ...good, problem: "budget_exhausted" } }).result.model as { problem: string }).problem).toBe("engine_problem");
    // review S8 2 / R8 [2]: the engine's predictions must be backed by calls the gateway itself served
    const missing = measureModelRun({ ...base, servedCalls: 79, report: good });
    expect(missing).toMatchObject({ outcome: "inconclusive", metricsEngine: null });
    expect(missing.result.model).toMatchObject({ problem: "calls_missing", servedCalls: 79, answered: 80, rows: 80 });
    expect((measureModelRun({ ...base, servedCalls: 0, report: good }).result.model as { problem: string }).problem).toBe("calls_missing");
    expect((measureModelRun({ ...base, servedCalls: 81, report: good }).result.model as { problem: string }).problem).toBe("calls_exceed_rows");
    // an unparseable row needs no answered call: one call short of the rows passes when that row is unparseable
    expect(measureModelRun({ ...base, servedCalls: 79, maxUnparseableRate: 0.05, report: resultFor({ id: expected.runId }, expected.evaluationId, expected.inputSha256, rows, oneUnparseable) }).outcome).toBe("pass");
  });

  it("a failed run that placed its task is recorded inconclusive (it holds); a cancelled one records nothing", async () => {
    const { dataset } = await modelDataset();
    const ev = await evaluationFor(dataset.id);
    const run = await fairlearnRun(ev.id);
    await fairnessInputTx(db, run);
    const failed = await db.transaction(async (tx) => recordFairnessRunEndTx(tx as unknown as Db, run, { status: "failed", placed: true, rawReportContentBase64: undefined }));
    expect(failed?.outcome).toBe("inconclusive");
    const run2 = await fairlearnRun(ev.id);
    await fairnessInputTx(db, run2);
    expect(await db.transaction(async (tx) => recordFairnessRunEndTx(tx as unknown as Db, run2, { status: "cancelled", placed: true, rawReportContentBase64: undefined }))).toBeNull();
    expect(await db.transaction(async (tx) => recordFairnessRunEndTx(tx as unknown as Db, run2, { status: "completed", placed: false, rawReportContentBase64: undefined }))).toBeNull();
  });

  it("an agreeing report with no calls on the gateway's ledger is inconclusive and holds the card", async () => {
    const { dataset, rows } = await modelDataset();
    const ev = await evaluationFor(dataset.id);
    const run = await fairlearnRun(ev.id);
    const input = await fairnessInputTx(db, run);
    if (!input.ok) throw new Error(input.code);
    const fair = rows.labels.map((l) => l as 0 | 1);
    await serveCalls(run, 0);
    const out = await db.transaction(async (tx) =>
      recordFairnessRunEndTx(tx as unknown as Db, run, { status: "completed", placed: true, rawReportContentBase64: b64(resultFor(run, ev.id, input.sha256, rows, fair)) }),
    );
    expect(out?.outcome).toBe("inconclusive");
    const [fr] = await db.select().from(fairnessRuns).where(eq(fairnessRuns.id, out!.fairnessRunId));
    expect((fr!.result as { model: Record<string, unknown> }).model).toMatchObject({ problem: "calls_missing", servedCalls: 0, answered: 80 });
  });

  it("with no signing key the run is kept and nothing unsigned is stored", async () => {
    const saved = process.env.REGULAIT_RECEIPT_SIGNING_KEY;
    const savedId = process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
    const savedDir = process.env.REGULAIT_INSTALL_SECRETS_DIR;
    delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
    delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
    process.env.REGULAIT_INSTALL_SECRETS_DIR = mkdtempSync(path.join(tmpdir(), "fm-nokey-"));
    try {
      const { dataset } = await modelDataset();
      const [fr] = await db
        .insert(fairnessRuns)
        .values({ cardId, datasetId: dataset.id, datasetSha256: "a".repeat(64), metricsVersion: "fairness-metrics/1", thresholds: [], minGroupSize: 30, result: {}, outcome: "pass" })
        .returning();
      expect(await db.transaction(async (tx) => signFairnessRunEvidenceTx(tx as unknown as Db, fr!))).toBe("unsigned");
      expect(await db.select().from(fairnessRunEvidence).where(eq(fairnessRunEvidence.runId, fr!.id))).toHaveLength(0);
    } finally {
      process.env.REGULAIT_RECEIPT_SIGNING_KEY = saved!;
      process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = savedId!;
      if (savedDir === undefined) delete process.env.REGULAIT_INSTALL_SECRETS_DIR;
      else process.env.REGULAIT_INSTALL_SECRETS_DIR = savedDir;
    }
  });
});

describe("5. the card keeps its evidence; the pack counts it", () => {
  it("a card with signed fairness evidence cannot be deleted, and counts as measured while its latest run passes", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/mrm/cards/${cardId}`, headers: adminKey });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("model_card_has_fairness_evidence");
    const measured = async () =>
      (await db.select({ id: modelCards.id }).from(modelCards).where(fairnessCardMeasuredSql())).some((c) => c.id === cardId);
    // the latest run on the card decides: an inconclusive run above makes it unmeasured, a new pass measured again
    const { dataset, rows } = await modelDataset();
    const ev = await evaluationFor(dataset.id);
    const run = await fairlearnRun(ev.id);
    const input = await fairnessInputTx(db, run);
    if (!input.ok) throw new Error(input.code);
    const fair = rows.labels.map((l) => l as 0 | 1);
    await serveCalls(run, fair.length);
    await db.transaction(async (tx) => recordFairnessRunEndTx(tx as unknown as Db, run, { status: "completed", placed: true, rawReportContentBase64: b64(resultFor(run, ev.id, input.sha256, rows, fair)) }));
    expect(await measured()).toBe(true);
    await db.update(modelCards).set({ pinnedModelVersion: `v-${RUN}` }).where(eq(modelCards.id, cardId));
    expect(await measured()).toBe(false);
  });
});

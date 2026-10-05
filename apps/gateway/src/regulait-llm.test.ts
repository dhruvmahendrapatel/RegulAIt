/**
 * ADR-0065 — REGULAIT-LLM, proved by attack.
 *
 * WHAT THIS FILE IS TRYING TO MAKE IMPOSSIBLE TO FAKE
 *
 *  1. A "TRAIN" BUTTON THAT SLEEPS AND REPORTS SUCCESS. The local-backend cases
 *     upload a real corpus, run the job to completion, and then QUERY the
 *     artifact and assert a SUBSTANTIVELY CORRECT answer pulled out of the
 *     training data — and, for the classifier, that the cross-entropy loss
 *     actually descended. A stub that flipped a status to 'succeeded' fails
 *     every one of these.
 *
 *  2. A GOVERNANCE FEATURE THAT ONLY LOGS. The PII case asserts the dataset
 *     DOES NOT EXIST after a refusal — not that a warning was written. And it
 *     asserts the stored findings are COUNTS ONLY: the suite greps the audit
 *     row and the stored verdict for the literal email address and requires it
 *     to be absent.
 *
 *  3. A DATASET THAT MOVES UNDER A FINISHED JOB. After a job trains on v1, the
 *     suite mints v2 with DIFFERENT rows and asserts the completed job still
 *     resolves to v1's row count and checksum.
 *
 *  4. AN ENTITLEMENT CHECK THAT IS A COMMENT. A user with no grant on the base
 *     agent is refused, the refusal is audited, and NO training_jobs row is
 *     created — asserted against the table, not against the response.
 *
 *  5. AN APPROVAL GATE THAT IS DECORATIVE. An over-threshold job must be
 *     `pending_approval` with ZERO usage rows and NO artifact until a named
 *     human decides it in the ONE approvals queue — and the queue row must be a
 *     real `approvals` row visible in that human's ordinary inbox.
 *
 *  6. A CREDENTIAL-LESS BACKEND THAT SILENTLY "WORKS". Every real adapter run
 *     without a credential must land in the TERMINAL `refused` state with an
 *     audit row — never `succeeded`, and never an ambiguous `failed`.
 *
 *  7. AN EGRESS GUARD THAT ONLY RUNS AT REGISTRATION. The suite registers a
 *     backend against an allow-listed host, then WITHDRAWS the allow-list entry
 *     and asserts the next job is refused.
 *
 * SHARED-STATE DISCIPLINE. `org_settings` is a singleton every other suite
 * reads. This file flips `llmTrainingEnabled`, `llmTrainingApprovalThresholdUsd`
 * and `mrmEnforced`, so `afterAll` restores the exact pre-existing values and
 * removes every object it created. Everything is `llm-` prefixed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  egressAllowHosts,
  inArray,
  lineageEdges,
  lineageNodes,
  modelCards,
  orgSettings,
  projects,
  runMigrations,
  sql,
  trainingArtifacts,
  trainingBackendConfigs,
  trainingDatasetRows,
  trainingDatasets,
  trainingJobs,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "llm-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "b".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

let maraId: string;
let maraAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let tessId: string;
let tessAuth: { authorization: string };
let baseAgentId: string;
let projectId: string;
let priorOrg: {
  llmTrainingEnabled: boolean;
  llmTrainingApprovalThresholdUsd: number;
  mrmEnforced: boolean;
} | null = null;

const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdCardIds: string[] = [];

/**
 * A REAL support corpus. Each answer carries a distinctive token that appears
 * in no other row, so an assertion on the returned text cannot be satisfied by
 * returning the first row, the last row, or a constant.
 */
const SUPPORT_ROWS = [
  { input: "How do I rotate an API key?", output: "Open Settings, choose Credentials, then press Rotate. The old value stops working after 24 hours." },
  { input: "What is the refund window for annual plans?", output: "Annual plans can be refunded within 30 days of the renewal date." },
  { input: "How do I invite a teammate?", output: "Go to Members and send an invitation to their work email address." },
  { input: "Where can I download an invoice?", output: "Invoices live under Billing, and every one of them can be exported as a PDF." },
  { input: "How do I enable two-factor authentication?", output: "Two-factor lives in Security; scan the QR code with an authenticator app." },
  { input: "Which regions can I deploy to?", output: "Deployments are available in Frankfurt, Oregon and Singapore." },
];

const SENTIMENT_ROWS = [
  { input: "this release is fantastic and the team shipped it early", output: "positive" },
  { input: "excellent work, the dashboard finally feels fast", output: "positive" },
  { input: "wonderful improvement, everything loads quickly now", output: "positive" },
  { input: "great job on the migration, zero downtime at all", output: "positive" },
  { input: "delightful polish, the onboarding is smooth", output: "positive" },
  { input: "the build broke again and nobody noticed for hours", output: "negative" },
  { input: "terrible latency, every page takes forever to load", output: "negative" },
  { input: "awful experience, the export failed three times", output: "negative" },
  { input: "broken deploy, rollback took the whole afternoon", output: "negative" },
  { input: "dreadful regression, the search returns nothing", output: "negative" },
];

/** A corpus with real personal data in it. THE point of the ingest scan. */
const LEAKY_EMAIL = "patient.rivera@clinic.example.com";
const LEAKY_ROWS = [
  { input: "Who owns the escalation for account 4471?", output: `Escalations route to ${LEAKY_EMAIL} during EU hours.` },
  { input: "What is the on-call rota?", output: "See the rota page." },
];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  createdUserIds.push(id);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${id}/keys`,
    headers: AUTH,
    payload: { name: "llm" },
  });
  expect(k.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function createDataset(payload: Record<string, unknown>, expectStatus = 201) {
  const res = await app.inject({ method: "POST", url: "/v1/llm/datasets", headers: AUTH, payload });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(expectStatus);
  return res;
}

async function startJob(
  auth: { authorization: string },
  payload: Record<string, unknown>,
  expectStatus = 201,
) {
  const res = await app.inject({ method: "POST", url: "/v1/llm/jobs", headers: auth, payload });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(expectStatus);
  return res;
}

async function setOrg(values: Record<string, unknown>) {
  const res = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: values });
  expect(res.statusCode).toBe(200);
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  await app.ready();

  const [org] = await db.select().from(orgSettings);
  priorOrg = org
    ? {
        llmTrainingEnabled: org.llmTrainingEnabled,
        llmTrainingApprovalThresholdUsd: org.llmTrainingApprovalThresholdUsd,
        mrmEnforced: org.mrmEnforced,
      }
    : null;
  // a high threshold for most of the suite: the approval gate has its own
  // section that lowers it deliberately
  await setOrg({ llmTrainingEnabled: true, llmTrainingApprovalThresholdUsd: 1000 });

  const mara = await makeUser("llm-mara@example.com");
  maraId = mara.id;
  maraAuth = mara.auth;
  const rika = await makeUser("llm-rika@example.com");
  rikaId = rika.id;
  rikaAuth = rika.auth;
  const tess = await makeUser("llm-tess@example.com");
  tessId = tess.id;
  tessAuth = tess.auth;

  const agent = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name: "llm-base-agent",
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(agent.statusCode).toBe(201);
  baseAgentId = agent.json().id;
  createdAgentIds.push(baseAgentId);
  // MARA is entitled to the base agent. RIKA deliberately is not — that is the
  // whole of test 4.
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: maraId, agentId: baseAgentId },
  });

  const project = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: AUTH,
    payload: { name: "llm-project", costCenter: "llm-cc" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
  await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/members`,
    headers: AUTH,
    payload: { userId: maraId, role: "member" },
  });
}, 90_000);

afterAll(async () => {
  // Restore the singleton EXACTLY — a leaked `mrmEnforced` or a leaked
  // `llmTrainingEnabled: false` would fail suites that have nothing to do with
  // this one.
  if (priorOrg) {
    await db
      .update(orgSettings)
      .set({
        llmTrainingEnabled: priorOrg.llmTrainingEnabled,
        llmTrainingApprovalThresholdUsd: priorOrg.llmTrainingApprovalThresholdUsd,
        mrmEnforced: priorOrg.mrmEnforced,
      })
      .where(eq(orgSettings.id, "singleton"));
  }

  const jobIds = (await db.select({ id: trainingJobs.id }).from(trainingJobs)).map((j) => j.id);
  if (jobIds.length) {
    await db.delete(usageEvents).where(eq(usageEvents.objectType, "training_job"));
  }
  await db.delete(trainingArtifacts);
  await db.delete(trainingJobs);
  await db.delete(trainingDatasetRows);
  await db.delete(trainingDatasets);
  await db.delete(trainingBackendConfigs);
  await db.delete(lineageEdges).where(eq(lineageEdges.projectId, projectId));
  await db.delete(lineageNodes).where(eq(lineageNodes.projectId, projectId));
  await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  const ids = [...new Set(createdAgentIds)];
  if (ids.length) {
    await db.delete(modelCards).where(inArray(modelCards.agentId, ids));
    await db.delete(agents).where(inArray(agents.id, ids));
  }
  // Remove the audit rows this suite produced. The MRM-refusal rows in
  // particular are shared-state: `mrm.test.ts` asserts on the FIRST
  // `mrm-approval-required` row in the whole table, so a card this file created
  // and then deliberately failed the gate on must not be left lying around.
  if (ids.length) {
    await db.delete(auditLog).where(inArray(auditLog.objectId, ids));
  }
  const cardIds = createdCardIds;
  if (cardIds.length) await db.delete(auditLog).where(inArray(auditLog.objectId, cardIds));
  await db
    .delete(auditLog)
    .where(inArray(auditLog.objectType, ["training_dataset", "training_job", "training_artifact"]));
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await restoreSb2Gates();
  await app?.close();
});

// ===========================================================================
// 1. THE LOCAL BACKEND GENUINELY TRAINS, AND THE ARTIFACT GENUINELY ANSWERS
// ===========================================================================

describe("the local backend really trains and the artifact really answers", () => {
  let datasetId: string;
  let jobId: string;
  let artifactId: string;

  it("accepts a clean corpus, and says the scan was clean", async () => {
    const res = await createDataset({
      name: "llm-support-kb",
      format: "prompt_completion",
      rows: SUPPORT_ROWS,
      projectId,
    });
    datasetId = res.json().dataset.id;
    expect(res.json().dataset.version).toBe(1);
    expect(res.json().dataset.rowCount).toBe(SUPPORT_ROWS.length);
    expect(res.json().scan.verdict).toBe("clean");
    // the checksum is a real content digest, not a placeholder
    expect(res.json().dataset.checksum).toMatch(/^sha256:[0-9a-f]{64}:6$/);
  });

  it("runs a retrieval-index job to completion, with MEASURED metrics", async () => {
    const res = await startJob(maraAuth, {
      name: "llm-support-index",
      datasetId,
      backend: "local",
      method: "retrieval_index",
      baseAgentId,
      projectId,
      hyperparameters: { topK: 3 },
    });
    const body = res.json();
    jobId = body.job.id;
    expect(body.job.status).toBe("succeeded");
    expect(body.job.progress).toBe(1);
    // the PIN: exactly which version it trained on
    expect(body.job.datasetVersion).toBe(1);
    expect(body.artifact.method).toBe("retrieval_index");
    expect(body.artifact.queryable).toBe(true);
    artifactId = body.artifact.id;

    const metrics = body.artifact.metrics as Record<string, unknown>;
    expect(metrics["rows"]).toBe(SUPPORT_ROWS.length);
    expect(Number(metrics["vocabularySize"])).toBeGreaterThan(10);
    // the honest label rides the metrics, not just a doc comment
    expect(String(metrics["note"])).toMatch(/nothing was fine-tuned/i);
  });

  it("THE PROOF: the artifact answers a paraphrased question FROM THE TRAINING DATA", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/artifacts/${artifactId}/query`,
      headers: AUTH,
      payload: { query: "how can I rotate the api key on my account?" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.method).toBe("retrieval_index");
    // SUBSTANTIVELY correct — the specific answer, not "something came back"
    expect(body.answer).toContain("Rotate");
    expect(body.answer).toContain("24 hours");
    expect(body.score).toBeGreaterThan(0);
    expect(body.detail.miss).toBe(false);
  });

  it("it DISCRIMINATES — three different questions get three different answers", async () => {
    const ask = async (query: string) => {
      const res = await app.inject({
        method: "POST",
        url: `/v1/llm/artifacts/${artifactId}/query`,
        headers: AUTH,
        payload: { query },
      });
      expect(res.statusCode).toBe(200);
      return res.json().answer as string;
    };
    expect(await ask("refund window for an annual plan")).toContain("30 days");
    expect(await ask("download my invoice as a pdf")).toContain("PDF");
    expect(await ask("which regions can we deploy into")).toContain("Frankfurt");
  });

  it("A MISS IS A MISS — it does not pass off the least-bad row as an answer", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/artifacts/${artifactId}/query`,
      headers: AUTH,
      payload: { query: "zzzz qqqq wwww" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBeNull();
    expect(res.json().detail.miss).toBe(true);
  });

  it("the classifier REALLY trains: the loss descends and it classifies correctly", async () => {
    const ds = await createDataset({
      name: "llm-sentiment",
      format: "classification",
      rows: SENTIMENT_ROWS,
      projectId,
    });
    const res = await startJob(maraAuth, {
      name: "llm-sentiment-clf",
      datasetId: ds.json().dataset.id,
      backend: "local",
      method: "text_classifier",
      baseAgentId,
      projectId,
      hyperparameters: { epochs: 150, learningRate: 3, evalFraction: 0.2 },
    });
    const artifact = res.json().artifact;
    const metrics = artifact.metrics as Record<string, unknown>;
    expect(metrics["labels"]).toEqual(["negative", "positive"]);
    const curve = metrics["lossCurve"] as number[];
    expect(curve.length).toBe(150);
    // THE EVIDENCE: gradient descent actually descended
    expect(curve[curve.length - 1]!).toBeLessThan(curve[0]! * 0.5);
    expect(Number(metrics["trainAccuracy"])).toBeGreaterThan(0.8);

    const ask = async (query: string) => {
      const q = await app.inject({
        method: "POST",
        url: `/v1/llm/artifacts/${artifact.id}/query`,
        headers: AUTH,
        payload: { query },
      });
      expect(q.statusCode).toBe(200);
      return q.json();
    };
    expect((await ask("fantastic excellent shipped early")).answer).toBe("positive");
    expect((await ask("terrible awful broken rollback")).answer).toBe("negative");
    // the posterior is real, not a hard label dressed up
    const scores = (await ask("fantastic excellent")).detail.scores as Array<{ probability: number }>;
    expect(scores.reduce((a, s) => a + s.probability, 0)).toBeCloseTo(1, 3);
  });

  it("the artifact list SUMMARISES the model rather than exporting the corpus", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/llm/artifacts", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const raw = res.payload;
    // the index holds a normalised copy of every document; a list endpoint that
    // shipped it would be a bulk export of the training data wearing a
    // metadata hat
    expect(raw).not.toContain("Frankfurt, Oregon and Singapore");
    const one = (res.json().artifacts as Array<Record<string, unknown>>).find((a) => a.id === artifactId)!;
    expect((one.payloadSummary as Record<string, unknown>)["documents"]).toBe(SUPPORT_ROWS.length);
  });

  it("the backend registry states, in the API, that local does NOT fine-tune an LLM", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/llm/backends", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const local = (res.json().backends as Array<Record<string, unknown>>).find((b) => b.kind === "local")!;
    expect(String(local.limits)).toMatch(/DOES NOT FINE-TUNE/);
    expect(local.requiresCredential).toBe(false);
    expect(local.methods).toEqual(["retrieval_index", "text_classifier"]);
    for (const kind of ["huggingface", "together", "bedrock", "vertex"]) {
      const b = (res.json().backends as Array<Record<string, unknown>>).find((x) => x.kind === kind)!;
      expect(b.requiresCredential).toBe(true);
      expect(b.producesQueryableArtifact).toBe(false);
    }
  });
});

// ===========================================================================
// 2. PII / SECRETS ARE CAUGHT AT INGEST — refused or flagged, per the mode
// ===========================================================================

describe("the ingest scan", () => {
  it("REFUSES a corpus carrying personal data, and stores NOTHING", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(trainingDatasets);
    const res = await createDataset(
      { name: "llm-leaky-blocked", format: "prompt_completion", rows: LEAKY_ROWS },
      422,
    );
    expect(res.json().error).toBe("training_data_refused");
    expect(res.json().mode).toBe("block");
    expect(res.json().findings.pii).toContainEqual({ category: "email", count: 1 });

    // THE ASSERTION THAT MATTERS: no row exists
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(trainingDatasets);
    expect(after[0]!.n).toBe(before[0]!.n);
    const named = await db
      .select()
      .from(trainingDatasets)
      .where(eq(trainingDatasets.name, "llm-leaky-blocked"));
    expect(named).toHaveLength(0);

    const rows = await audits("llm-dataset-pii-blocked");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.effect).toBe("deny");
    // COUNTS ONLY — the matched address must be nowhere in the trail
    expect(JSON.stringify(rows.at(-1)!.detail)).not.toContain(LEAKY_EMAIL);
    expect(rows.at(-1)!.reason).not.toContain(LEAKY_EMAIL);
  });

  it("FLAGS the same corpus under a warn mode, and records the verdict on the version", async () => {
    const res = await createDataset({
      name: "llm-leaky-flagged",
      format: "prompt_completion",
      rows: LEAKY_ROWS,
      piiMode: "warn",
    });
    expect(res.json().dataset.piiVerdict).toBe("flagged");
    expect(res.json().dataset.piiMode).toBe("warn");
    const [stored] = await db
      .select()
      .from(trainingDatasets)
      .where(eq(trainingDatasets.id, res.json().dataset.id));
    expect(stored!.piiVerdict).toBe("flagged");
    // counts only, on the row too
    expect(JSON.stringify(stored!.scanFindings)).not.toContain(LEAKY_EMAIL);
    expect(JSON.stringify(stored!.scanFindings)).toContain("email");
    const flagged = await audits("llm-dataset-pii-flagged");
    expect(flagged.length).toBeGreaterThan(0);
  });

  it("catches CREDENTIAL MATERIAL too, not only regex PII", async () => {
    const res = await createDataset({
      name: "llm-secrets",
      format: "prompt_completion",
      rows: [
        { input: "What did the deploy script use?", output: "It exported AKIAIOSFODNN7EXAMPLE for the upload step." },
      ],
      piiMode: "warn",
    });
    const findings = res.json().scan.findings as { guardrails: Array<{ detector: string; category: string }> };
    expect(findings.guardrails.some((g) => g.category === "credential_material")).toBe(true);
    expect(res.json().dataset.piiVerdict).toBe("flagged");
  });

  it("a SECOND upload cannot launder past the first scan", async () => {
    const created = await createDataset({
      name: "llm-append-target",
      format: "prompt_completion",
      rows: [{ input: "hello", output: "world" }],
    });
    const id = created.json().dataset.id;
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/datasets/${id}/rows`,
      headers: AUTH,
      payload: { rows: LEAKY_ROWS },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("training_data_refused");
    const rows = await db
      .select()
      .from(trainingDatasetRows)
      .where(eq(trainingDatasetRows.datasetId, id));
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// 3. DATASET IMMUTABILITY
// ===========================================================================

describe("a dataset version a job trained on cannot move", () => {
  let datasetId: string;
  let jobId: string;

  it("freezes the version the moment a job cites it", async () => {
    const ds = await createDataset({
      name: "llm-frozen",
      format: "prompt_completion",
      rows: SUPPORT_ROWS,
      projectId,
    });
    datasetId = ds.json().dataset.id;
    const job = await startJob(maraAuth, {
      name: "llm-frozen-job",
      datasetId,
      backend: "local",
      method: "retrieval_index",
      baseAgentId,
      projectId,
    });
    jobId = job.json().job.id;
    expect(job.json().job.status).toBe("succeeded");

    const append = await app.inject({
      method: "POST",
      url: `/v1/llm/datasets/${datasetId}/rows`,
      headers: AUTH,
      payload: { rows: [{ input: "new question", output: "new answer" }] },
    });
    expect(append.statusCode).toBe(409);
    expect(append.json().error).toBe("dataset_version_frozen");
  });

  it("minting v2 with DIFFERENT rows leaves the finished job pointing at v1", async () => {
    const before = await app.inject({ method: "GET", url: `/v1/llm/jobs/${jobId}`, headers: AUTH });
    const v1RowCount = before.json().trainedOn.rowCount as number;
    const v1Checksum = before.json().trainedOn.checksum as string;
    expect(v1RowCount).toBe(SUPPORT_ROWS.length);

    const next = await app.inject({
      method: "POST",
      url: `/v1/llm/datasets/${datasetId}/versions`,
      headers: AUTH,
      payload: { rows: [{ input: "totally different", output: "totally different answer" }] },
    });
    expect(next.statusCode, JSON.stringify(next.json())).toBe(201);
    expect(next.json().dataset.version).toBe(2);
    expect(next.json().dataset.rowCount).toBe(1);
    expect(next.json().dataset.checksum).not.toBe(v1Checksum);
    // a new ROW with its own id — the eval_datasets discipline. v1 is not
    // rewritten, it is simply no longer the newest thing called this.
    expect(next.json().dataset.id).not.toBe(datasetId);
    expect(next.json().dataset.name).toBe("llm-frozen");

    // THE ASSERTION: the completed job still resolves to what it ACTUALLY
    // trained on, not to "the dataset", which has moved on
    const after = await app.inject({ method: "GET", url: `/v1/llm/jobs/${jobId}`, headers: AUTH });
    expect(after.json().job.datasetVersion).toBe(1);
    expect(after.json().trainedOn.version).toBe(1);
    expect(after.json().trainedOn.rowCount).toBe(v1RowCount);
    expect(after.json().trainedOn.checksum).toBe(v1Checksum);

    // and v1's rows are still there, untouched
    const v1Rows = await db
      .select()
      .from(trainingDatasetRows)
      .where(and(eq(trainingDatasetRows.datasetId, datasetId), eq(trainingDatasetRows.datasetVersion, 1)));
    expect(v1Rows).toHaveLength(SUPPORT_ROWS.length);
  });

  it("the database itself refuses to delete a version a job cites (ON DELETE RESTRICT)", async () => {
    await expect(
      db
        .delete(trainingDatasets)
        .where(and(eq(trainingDatasets.id, datasetId), eq(trainingDatasets.version, 1))),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// 4. GOVERNANCE — entitlement, cost attribution, the org switch
// ===========================================================================

describe("training is not a side channel", () => {
  it("a user with NO grant on the base agent cannot start a job, and none is created", async () => {
    const ds = await createDataset({ name: "llm-entitlement", rows: SUPPORT_ROWS });
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(trainingJobs);
    const res = await startJob(
      rikaAuth,
      {
        name: "llm-unentitled",
        datasetId: ds.json().dataset.id,
        backend: "local",
        method: "retrieval_index",
        baseAgentId,
      },
      403,
    );
    expect(res.json().error).toBe("agent_not_entitled");
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(trainingJobs);
    expect(after[0]!.n).toBe(before[0]!.n);
    const denied = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "training_job"), eq(auditLog.userId, rikaId)));
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.at(-1)!.effect).toBe("deny");
    expect(denied.at(-1)!.reason).toMatch(/requires entitlement to that model/);
  });

  it("the bootstrap token — which has no identity — cannot start a job", async () => {
    const ds = await createDataset({ name: "llm-bootstrap-check", rows: SUPPORT_ROWS });
    const res = await startJob(
      AUTH,
      {
        name: "llm-bootstrap-job",
        datasetId: ds.json().dataset.id,
        backend: "local",
        method: "retrieval_index",
        baseAgentId,
      },
      403,
    );
    expect(res.json().error).toBe("bootstrap_cannot_train");
  });

  it("the job's cost lands in the ONE usage ledger, attributed to the project", async () => {
    const ds = await createDataset({ name: "llm-metered", rows: SUPPORT_ROWS, projectId });
    const job = await startJob(maraAuth, {
      name: "llm-metered-job",
      datasetId: ds.json().dataset.id,
      backend: "local",
      method: "retrieval_index",
      baseAgentId,
      projectId,
    });
    const jobId = job.json().job.id as string;
    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.objectType, "training_job"));
    const mine = rows.find((r) => (r.detail as Record<string, unknown>)["trainingJobId"] === jobId)!;
    expect(mine).toBeDefined();
    expect(mine.projectId).toBe(projectId);
    expect(mine.userId).toBe(maraId);
    // ZERO, and honestly so: nothing was billed by anyone for arithmetic this
    // process did itself. A made-up figure here would poison pillar 5.
    expect(mine.costUsd).toBe(0);
    expect(String((mine.detail as Record<string, unknown>)["costBasis"])).toMatch(/nothing was billed/);
    expect(mine.operation).toBe("local:retrieval_index");
  });

  it("a non-admin cannot read the datasets or the artifact bench", async () => {
    for (const url of ["/v1/llm/datasets", "/v1/llm/artifacts", "/v1/llm/backends"]) {
      const res = await app.inject({ method: "GET", url, headers: maraAuth });
      expect(res.statusCode).toBe(403);
    }
  });

  it("the org master switch refuses everything, honestly, and is reversible", async () => {
    await setOrg({ llmTrainingEnabled: false });
    const create = await app.inject({
      method: "POST",
      url: "/v1/llm/datasets",
      headers: AUTH,
      payload: { name: "llm-while-off", rows: SUPPORT_ROWS },
    });
    expect(create.statusCode).toBe(409);
    expect(create.json().error).toBe("llm_training_disabled");

    const ds = await db.select().from(trainingDatasets).where(eq(trainingDatasets.name, "llm-metered"));
    const job = await startJob(
      maraAuth,
      {
        name: "llm-while-off-job",
        datasetId: ds[0]!.id,
        backend: "local",
        method: "retrieval_index",
        baseAgentId,
      },
      409,
    );
    expect(job.json().error).toBe("llm_training_disabled");

    await setOrg({ llmTrainingEnabled: true });
    const again = await app.inject({
      method: "POST",
      url: "/v1/llm/datasets",
      headers: AUTH,
      payload: { name: "llm-after-on", rows: SUPPORT_ROWS },
    });
    expect(again.statusCode).toBe(201);
  });

  it("an unusable corpus is refused before a job row exists", async () => {
    const ds = await createDataset({
      name: "llm-one-label",
      format: "classification",
      rows: [
        { input: "good", output: "positive" },
        { input: "great", output: "positive" },
      ],
    });
    const res = await startJob(
      maraAuth,
      {
        name: "llm-one-label-job",
        datasetId: ds.json().dataset.id,
        backend: "local",
        method: "text_classifier",
        baseAgentId,
      },
      422,
    );
    expect(res.json().error).toBe("dataset_unusable");
    expect(res.json().detail).toMatch(/two distinct labels/);
  });

  it("a typo'd hyperparameter is refused rather than silently ignored", async () => {
    const ds = await db.select().from(trainingDatasets).where(eq(trainingDatasets.name, "llm-metered"));
    const res = await startJob(
      maraAuth,
      {
        name: "llm-typo-job",
        datasetId: ds[0]!.id,
        backend: "local",
        method: "text_classifier",
        baseAgentId,
        hyperparameters: { learning_rate: 0.5 },
      },
      422,
    );
    expect(res.json().error).toBe("hyperparameters_invalid");
    expect(res.json().detail).toMatch(/unknown hyperparameter/);
  });
});

// ===========================================================================
// 5. THE APPROVAL GATE + 6. THE HONEST REFUSAL
// ===========================================================================

describe("an expensive job goes to the ONE approvals queue", () => {
  let datasetId: string;

  beforeAll(async () => {
    const ds = await createDataset({ name: "llm-expensive", rows: SUPPORT_ROWS, projectId });
    datasetId = ds.json().dataset.id;
    await setOrg({ llmTrainingApprovalThresholdUsd: 0.000001 });
  });

  afterAll(async () => {
    await setOrg({ llmTrainingApprovalThresholdUsd: 1000 });
  });

  it("does NOT start: pending_approval, no usage row, no artifact, a real approvals row", async () => {
    const res = await startJob(
      maraAuth,
      {
        name: "llm-expensive-job",
        datasetId,
        backend: "huggingface",
        method: "lora_sft",
        baseModel: "some-base-7b",
        baseAgentId,
        projectId,
        approverUserId: rikaId,
        pricePerMTokUsd: 8,
      },
      202,
    );
    const jobId = res.json().job.id as string;
    const approvalId = res.json().approvalId as string;
    expect(res.json().job.status).toBe("pending_approval");
    expect(Number(res.json().job.estimatedCostUsd)).toBeGreaterThan(0);

    // it is a row in THE one approvals table, not a second inbox
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(approval!.objectType).toBe("training_job");
    expect(approval!.approverUserId).toBe(rikaId);
    expect(approval!.status).toBe("pending");

    // and it shows up in the named approver's ORDINARY inbox
    const inbox = await app.inject({ method: "GET", url: "/v1/approvals", headers: rikaAuth });
    expect(inbox.statusCode).toBe(200);
    const ids = (inbox.json().approvals as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(approvalId);

    // NOTHING HAPPENED YET
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.objectType, "training_job"));
    expect(usage.some((u) => (u.detail as Record<string, unknown>)["trainingJobId"] === jobId)).toBe(false);
    const artifacts = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.jobId, jobId));
    expect(artifacts).toHaveLength(0);
  });

  it("a DENIED job is cancelled and never runs", async () => {
    const res = await startJob(
      maraAuth,
      {
        name: "llm-denied-job",
        datasetId,
        backend: "huggingface",
        method: "lora_sft",
        baseModel: "some-base-7b",
        baseAgentId,
        approverUserId: rikaId,
        pricePerMTokUsd: 8,
      },
      202,
    );
    const jobId = res.json().job.id as string;
    const decide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${res.json().approvalId}/decide`,
      headers: rikaAuth,
      payload: { decision: "denied", reason: "no budget for this" },
    });
    expect(decide.statusCode).toBe(200);
    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, jobId));
    expect(job!.status).toBe("cancelled");
    expect(job!.error).toMatch(/refused in the Approvals Queue/);
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.objectType, "training_job"));
    expect(usage.some((u) => (u.detail as Record<string, unknown>)["trainingJobId"] === jobId)).toBe(false);
    const denied = await audits("llm-training-approval-denied");
    expect(denied.length).toBeGreaterThan(0);
  });

  it("APPROVING it starts the job — and the credential-less backend then REFUSES honestly", async () => {
    const res = await startJob(
      maraAuth,
      {
        name: "llm-approved-job",
        datasetId,
        backend: "huggingface",
        method: "lora_sft",
        baseModel: "some-base-7b",
        baseAgentId,
        projectId,
        approverUserId: rikaId,
        pricePerMTokUsd: 8,
      },
      202,
    );
    const jobId = res.json().job.id as string;
    const decide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${res.json().approvalId}/decide`,
      headers: rikaAuth,
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);

    const [job] = await db.select().from(trainingJobs).where(eq(trainingJobs.id, jobId));
    // THE APPROVAL REALLY STARTED IT — the job left pending_approval — and the
    // backend then said no, in a terminal state distinct from `failed`
    expect(job!.status).toBe("refused");
    expect(job!.error).toMatch(/no credential configured/);
    expect(job!.error).toMatch(/use the 'local' backend/);

    const granted = await audits("llm-training-approval-granted");
    expect(granted.length).toBeGreaterThan(0);
    const refused = await audits("llm-training-job-refused");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.at(-1)!.effect).toBe("deny");

    // a refused job still bills a ZERO row, so "we tried and nothing happened"
    // is visible in the cost dashboard rather than an absence somebody notices
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.objectType, "training_job"));
    const mine = usage.find((u) => (u.detail as Record<string, unknown>)["trainingJobId"] === jobId)!;
    expect(mine).toBeDefined();
    expect(mine.costUsd).toBe(0);
    expect((mine.detail as Record<string, unknown>)["status"]).toBe("refused");
    const artifacts = await db.select().from(trainingArtifacts).where(eq(trainingArtifacts.jobId, jobId));
    expect(artifacts).toHaveLength(0);
  });

  it("a job nobody can price is refused rather than started outside the gate", async () => {
    const res = await startJob(
      maraAuth,
      {
        name: "llm-unpriced-job",
        datasetId,
        backend: "together",
        method: "lora_sft",
        baseModel: "b",
        baseAgentId,
      },
      422,
    );
    expect(res.json().error).toBe("cost_not_estimable");
  });
});

describe("a credential-less real backend refuses without any approval in the way", () => {
  it("is REFUSED, terminal, audited, and produces nothing", async () => {
    const ds = await createDataset({ name: "llm-nocred", rows: SUPPORT_ROWS, projectId });
    const res = await startJob(maraAuth, {
      name: "llm-nocred-job",
      datasetId: ds.json().dataset.id,
      backend: "together",
      method: "lora_sft",
      baseModel: "base-7b",
      baseAgentId,
      projectId,
      pricePerMTokUsd: 0.0001,
    });
    expect(res.json().job.status).toBe("refused");
    expect(res.json().refusal.code).toBe("credential_required");
    expect(res.json().artifact).toBeNull();
  });

  it("a method the backend cannot perform is refused before anything runs", async () => {
    const ds = await db.select().from(trainingDatasets).where(eq(trainingDatasets.name, "llm-nocred"));
    const res = await startJob(
      maraAuth,
      {
        name: "llm-wrong-method",
        datasetId: ds[0]!.id,
        backend: "local",
        method: "lora_sft",
        baseModel: "b",
        baseAgentId,
      },
      409,
    );
    expect(res.json().error).toBe("method_unsupported");
    expect(res.json().detail).toMatch(/retrieval_index, text_classifier/);
  });
});

// ===========================================================================
// 7. EGRESS — the same guard, at write time AND at use time
// ===========================================================================

describe("a training backend's endpoint is adjudicated by the existing egress guard", () => {
  it("refuses an IMDS-shaped endpoint at write time, and audits the attempt", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/llm/backend-configs/together",
      headers: AUTH,
      payload: { baseUrl: "http://169.254.169.254/latest/meta-data", enabled: true, allowPlaintextHttp: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    const rows = await audits("llm-backend-egress-blocked");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.effect).toBe("deny");
  });

  it("accepts an allow-listed endpoint, then REFUSES the job once the allow-list is withdrawn", async () => {
    // allow 127.0.0.1 explicitly, with both opt-ins the guard demands
    const host = await app.inject({
      method: "POST",
      url: "/v1/egress-allow-hosts",
      headers: AUTH,
      payload: {
        host: "127.0.0.1",
        allowPrivateRanges: true,
        allowPlaintextHttp: true,
        note: "llm training backend test",
      },
    });
    expect(host.statusCode).toBe(201);
    const hostId = host.json().id as string;

    const cfg = await app.inject({
      method: "PUT",
      url: "/v1/llm/backend-configs/vertex",
      headers: AUTH,
      payload: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "llm-vertex-token",
        enabled: true,
        allowPlaintextHttp: true,
        settings: { gcpProject: "p", location: "us-central1" },
      },
    });
    expect(cfg.statusCode).toBe(200);
    // THE KEY IS NEVER RETURNED
    expect(cfg.payload).not.toContain("llm-vertex-token");
    expect(cfg.json().config.hasCredential).toBe(true);

    // withdraw the allow-list entry — the endpoint has not moved, the POLICY has
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/egress-allow-hosts/${hostId}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(200);

    const ds = await createDataset({ name: "llm-egress", rows: SUPPORT_ROWS });
    const res = await startJob(
      maraAuth,
      {
        name: "llm-egress-job",
        datasetId: ds.json().dataset.id,
        backend: "vertex",
        method: "lora_sft",
        baseModel: "b",
        baseAgentId,
        pricePerMTokUsd: 0.0001,
      },
      403,
    );
    // THE POINT: the endpoint has not moved — the POLICY has. The guard re-runs
    // at USE time, so a verdict recorded on the day an admin typed the URL is
    // never what a later job is decided on.
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().detail).toMatch(/not in the egress allow-list/);
    // and nothing was created for it
    const jobs = await db.select().from(trainingJobs).where(eq(trainingJobs.name, "llm-egress-job"));
    expect(jobs).toHaveLength(0);
  });

  it("local and mock need no configuration and say so", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/llm/backend-configs/local",
      headers: AUTH,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("backend_needs_no_config");
  });
});

// ===========================================================================
// 8. LINEAGE
// ===========================================================================

describe("dataset → job → artifact lands in the ONE lineage graph", () => {
  it("the three nodes and the two edges exist, and a backward traversal reaches the data", async () => {
    const ds = await createDataset({ name: "llm-lineage", rows: SUPPORT_ROWS, projectId });
    const datasetId = ds.json().dataset.id as string;
    const job = await startJob(maraAuth, {
      name: "llm-lineage-job",
      datasetId,
      backend: "local",
      method: "retrieval_index",
      baseAgentId,
      projectId,
    });
    const artifactId = job.json().artifact.id as string;

    const nodes = await db.select().from(lineageNodes).where(eq(lineageNodes.projectId, projectId));
    const byKey = new Map(nodes.map((n) => [n.naturalKey, n]));
    expect(byKey.has(`training_dataset:${datasetId}:v1`)).toBe(true);
    expect(byKey.has(`training_job:${job.json().job.id}`)).toBe(true);
    expect(byKey.has(`model_artifact:${artifactId}`)).toBe(true);
    expect(byKey.get(`training_dataset:${datasetId}:v1`)!.kind).toBe("source");
    expect(byKey.get(`model_artifact:${artifactId}`)!.kind).toBe("output");

    const res = await app.inject({
      method: "GET",
      url: `/v1/lineage?projectId=${projectId}&naturalKey=${encodeURIComponent(`model_artifact:${artifactId}`)}&direction=backward`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const keys = (res.json().nodes as Array<{ naturalKey: string }>).map((n) => n.naturalKey);
    // "what data is behind this model?" — answered by the ordinary traversal
    expect(keys).toContain(`training_job:${job.json().job.id}`);
    expect(keys).toContain(`training_dataset:${datasetId}:v1`);
    expect((res.json().edges as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// 9. THE ARTIFACT IS A GOVERNED MODEL — card, MRM gate, real inference
// ===========================================================================

describe("registering an artifact makes it a governed, dispatchable model", () => {
  let artifactId: string;
  let servedAgentId: string;
  let cardId: string;

  beforeAll(async () => {
    const ds = await createDataset({ name: "llm-served", rows: SUPPORT_ROWS, projectId });
    const job = await startJob(maraAuth, {
      name: "llm-served-index",
      datasetId: ds.json().dataset.id,
      backend: "local",
      method: "retrieval_index",
      baseAgentId,
      projectId,
    });
    artifactId = job.json().artifact.id;
  });

  it("mints an agent AND a model card, at no more than the base agent's tier", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/artifacts/${artifactId}/register`,
      headers: AUTH,
      payload: {
        agentName: "llm-support-bot",
        intendedUse: "Answering first-line support questions from our own knowledge base.",
      },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    servedAgentId = res.json().agent.id;
    cardId = res.json().modelCard.id;
    createdAgentIds.push(servedAgentId);
    createdCardIds.push(cardId);

    expect(res.json().agent.provider).toBe("regulait_llm");
    expect(res.json().agent.tier).toBe(1);
    // UNPRICED ON PURPOSE — a zero price would make the optimizer route
    // everything onto a retrieval index because it looked free
    expect(res.json().agent.costPerMTokIn).toBeNull();

    // the card carries the BACKEND'S OWN honest limits string, so the human
    // accepting the risk reads what this thing actually is
    expect(String(res.json().modelCard.limitations)).toMatch(/DOES NOT FINE-TUNE/);
    // and MEASURED provenance, not a vendor's assertion
    const claims = res.json().modelCard.dataClaims as Record<string, unknown>;
    expect(claims["datasetName"]).toBe("llm-served");
    expect(claims["datasetVersion"]).toBe(1);
    expect(claims["ingestScanVerdict"]).toBe("clean");
    expect(String(claims["checksum"])).toMatch(/^sha256:[0-9a-f]{64}:/);
  });

  it("refuses to register the same artifact twice", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/artifacts/${artifactId}/register`,
      headers: AUTH,
      payload: { agentName: "llm-support-bot-2", intendedUse: "again" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_registered");
  });

  it("END TO END: a user invokes it and gets an answer DERIVED FROM THE TRAINING DATA", async () => {
    // tess is entitled to the served agent ONLY, so routing cannot substitute
    // anything else and the assertion is about this model
    const grant = await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: tessId, agentId: servedAgentId },
    });
    expect(grant.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${servedAgentId}/invoke`,
      headers: tessAuth,
      payload: { mode: "execute", input: "how do I turn on two-factor authentication?", dispatch: true },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().dispatch.outputText).toContain("QR code");
    expect(res.json().dispatch.stopReason).toBe("end_turn");
    // measured, not invented
    expect(res.json().dispatch.usage.inputTokens).toBeGreaterThan(0);
  });

  it("it is metered like any other dispatch, in the same ledger", async () => {
    const rows = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.objectType, "agent"), eq(usageEvents.agentId, servedAgentId)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)!.provider).toBe("regulait_llm");
  });

  it("THE MRM GATE APPLIES: with enforcement on, an unsigned home-trained model is refused", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/mrm/enforcement",
      headers: AUTH,
      payload: { enforced: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${servedAgentId}/invoke`,
      headers: tessAuth,
      payload: { mode: "execute", input: "how do I invite a teammate?", dispatch: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mrm_approval_required");
    // the card exists, it simply carries no accepted risk position yet
    const [card] = await db.select().from(modelCards).where(eq(modelCards.id, cardId));
    expect(card).toBeDefined();

    await app.inject({
      method: "POST",
      url: "/v1/mrm/enforcement",
      headers: AUTH,
      payload: { enforced: false },
    });
    const again = await app.inject({
      method: "POST",
      url: `/v1/agents/${servedAgentId}/invoke`,
      headers: tessAuth,
      payload: { mode: "execute", input: "how do I invite a teammate?", dispatch: true },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().dispatch.outputText).toContain("Members");
  });

  it("a regulait_llm agent with NO artifact refuses honestly instead of answering nothing", async () => {
    const orphan = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "llm-orphan", provider: "regulait_llm", tier: 1, model: "llm-orphan" },
    });
    expect(orphan.statusCode).toBe(201);
    const orphanId = orphan.json().id as string;
    createdAgentIds.push(orphanId);
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: rikaId, agentId: orphanId },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${orphanId}/invoke`,
      headers: rikaAuth,
      payload: { mode: "execute", input: "anything", dispatch: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("artifact_not_registered");
  });
});

// ===========================================================================
// 10. THE SWEEP + the dry-run validator
// ===========================================================================

describe("operational surfaces", () => {
  it("the poll sweep skips in-process jobs rather than pretending to poll them", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/llm/jobs/poll-sweep", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(String(res.json().note)).toMatch(/never a setInterval|NOT a setInterval/);
    expect(Array.isArray(res.json().polled)).toBe(true);
  });

  it("the dry-run validator reports usability, warnings and a cost WITHOUT writing anything", async () => {
    const ds = await db.select().from(trainingDatasets).where(eq(trainingDatasets.name, "llm-sentiment"));
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(trainingJobs);
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/datasets/${ds[0]!.id}/validate`,
      headers: AUTH,
      payload: { method: "text_classifier", backend: "local", hyperparameters: { epochs: 20 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().validation.ok).toBe(true);
    expect(res.json().validation.labels).toEqual(["negative", "positive"]);
    expect(res.json().estimatedCostUsd).toBe(0);
    expect(res.json().capabilities.kind).toBe("local");
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(trainingJobs);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("a remote artifact is never claimed to be queryable here", async () => {
    // built directly: no remote backend is reachable from this environment, so
    // the row is constructed to exercise the refusal the API must give
    const ds = await createDataset({ name: "llm-remote-shape", rows: SUPPORT_ROWS });
    const [job] = await db
      .insert(trainingJobs)
      .values({
        name: "llm-remote-shape-job",
        datasetId: ds.json().dataset.id,
        datasetVersion: 1,
        backend: "together",
        method: "lora_sft",
        baseModel: "base-7b",
        status: "succeeded",
        estimatedCostUsd: 1,
        initiatedByUserId: maraId,
      })
      .returning();
    const [artifact] = await db
      .insert(trainingArtifacts)
      .values({
        jobId: job!.id,
        name: "llm-remote-shape-artifact",
        method: "lora_sft",
        kind: "remote",
        location: "org/tuned-7b",
        metrics: { remote: true },
      })
      .returning();
    const res = await app.inject({
      method: "POST",
      url: `/v1/llm/artifacts/${artifact!.id}/query`,
      headers: AUTH,
      payload: { query: "anything" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("artifact_not_queryable");
    expect(res.json().detail).toMatch(/cannot run inference against it here/);

    const reg = await app.inject({
      method: "POST",
      url: `/v1/llm/artifacts/${artifact!.id}/register`,
      headers: AUTH,
      payload: { agentName: "llm-remote-agent", intendedUse: "x" },
    });
    expect(reg.statusCode).toBe(409);
    expect(reg.json().error).toBe("artifact_not_servable");
  });
});

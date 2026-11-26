/**
 * ADR-0362 slice 1b-i — the content-extraction runs against a real database and the real runner routes: a request's
 * bundle is queued ENCRYPTED (engine on only), a registered runner leases it (no key; the lease names bundle.json, the
 * bundle's own sha256 and size), the task is placed by a real executor through the gateway's own task start, and the
 * runner's result is stored encrypted, read once by the awaiting request and deleted. Fail closed throughout: engine
 * off, no data key, an empty bundle, a result that does not answer for exactly the bundle's files, a result that does
 * not parse, an engine failure and a deadline all give the request nothing to read. The extracted text never reaches
 * the run, its raw report, an audit row or a route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { auditLog, contentInspectionResults, createDb, engineRuns, engines, eq, runMigrations, sql, type Db } from "@regulait/db";
import { ENGINE_MANIFEST, ENGINE_RESULT_VERSION, type EngineId, type EngineManifestEntry, type EngineResultEnvelope } from "@regulait/shared";
import { buildSelfTest, generateRunnerSecret, RunnerClient, type RunnerHttp } from "@regulait/engine-runner";
import { buildApp } from "./app.js";
import { useTestIssuerKey } from "./testing/workload-client.js";
import { startEngineTaskRig, type EngineTaskRig } from "./testing/engine-task-rig.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import {
  awaitContentExtractResult,
  CONTENT_EXTRACT_DEFAULT_SENSITIVITY,
  contentExtractRunSensitivity,
  enqueueContentExtractRun,
  setContentInspectionRuntime,
} from "./content-inspection-runs.js";
import { cancelEngineRunAsSystem } from "./engine-runs.js";
import { encryptSecret } from "./secrets.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e43-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CE_DIGEST = `sha256:${"c".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = { ...ENGINE_MANIFEST, contentextract: { ...ENGINE_MANIFEST.contentextract, imageDigest: CE_DIGEST } };
const CE_BUILD = { imageDigest: CE_DIGEST, engineVersion: MANIFEST.contentextract.version };
const DATA_KEY = "e".repeat(64);
/** the text a person's file holds: it must never appear outside the encrypted result */
const SECRET_TEXT = `card 4111 1111 1111 1111 ${RUN}`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let rig: EngineTaskRig | undefined;
let client: RunnerClient;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;
let restoreIssuerKey: (() => Promise<void>) | undefined;
let admin: { id: string; key: { authorization: string } };
let alice: { id: string; key: { authorization: string } };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const runnerHttp: RunnerHttp = async (url, init) => {
  const u = new URL(url);
  const r = await app.inject({ method: init.method as Method, url: u.pathname, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  return new Response(r.statusCode === 204 ? null : new Uint8Array(r.rawPayload), { status: r.statusCode, headers });
};

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "e43" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
async function setEngine(enabled: boolean): Promise<void> {
  await db.update(engines).set(enabled ? { enabled: true, selfTestPassedAt: new Date() } : { enabled: false }).where(eq(engines.id, "contentextract"));
}
/** end every live content-extraction run (so each test's lease takes its own run) */
async function clearLive(): Promise<void> {
  await db.execute(
    sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup', target_subject_input_ciphertext = NULL WHERE engine_id = 'contentextract' AND status IN ('queued', 'leased')`,
  );
}
const bundleJson = (files: Array<{ id: string; text: string }>) =>
  JSON.stringify({ files: files.map((f) => ({ id: f.id, name: `${f.id}.txt`, mediaType: "text/plain", dataBase64: Buffer.from(f.text, "utf8").toString("base64") })) });
const envelope = (runId: string, report: Buffer | null, status: EngineResultEnvelope["status"] = "completed"): EngineResultEnvelope => ({
  version: ENGINE_RESULT_VERSION,
  runId,
  engineId: "contentextract",
  engineVersion: CE_BUILD.engineVersion,
  status,
  errorCode: status === "completed" ? null : "scan_failed",
  items: [],
  notRun: [],
  rawReport: report ? { sha256: sha256(report), bytes: report.length, contentBase64: report.toString("base64") } : null,
});
const resultOf = (files: Array<{ id: string; text: string }>) =>
  Buffer.from(JSON.stringify({ version: 1, files: files.map((f) => ({ id: f.id, status: "extracted", type: "text", text: f.text })) }));

/** queue a bundle, lease it, place its task; returns the run id */
async function queueLeaseAndPlace(bundle: string): Promise<string> {
  const q = await enqueueContentExtractRun(db, { bundleJson: bundle, projectId: null, userId: alice.id, sensitivity: "internal" });
  expect(q.kind).toBe("queued");
  const runId = (q as { runId: string }).runId;
  const lease = await client.lease(CE_BUILD);
  expect(lease?.runId).toBe(runId);
  expect(await rig!.place(runId)).not.toBeNull();
  return runId;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreIssuerKey = await useTestIssuerKey(db);
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, engines: { manifest: MANIFEST } });
  await app.ready();
  await clearLive();
  admin = await makeUser(`e43-admin-${RUN}@example.com`, true);
  alice = await makeUser(`e43-alice-${RUN}@example.com`);

  const t = await inject("POST", "/v1/engines/contentextract/enrollment-tokens", admin.key, { label: "e43" });
  expect(t.statusCode, t.body).toBe(201);
  rig = await startEngineTaskRig({ app, db, issuer: ORIGIN, admin, manifest: MANIFEST, name: "e43" });
  client = new RunnerClient({ gatewayUrl: "http://gateway.test", issuer: ORIGIN, http: runnerHttp });
  const selfTest = await buildSelfTest({
    ...CE_BUILD,
    requiredEnv: MANIFEST.contentextract.usageDataEnv,
    env: { ...MANIFEST.contentextract.usageDataEnv },
    egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
  });
  const reg = await client.register(t.json().token, generateRunnerSecret(), { name: `contentextract-${RUN}`, ...CE_BUILD, selfTest });
  expect(reg.selfTest).toEqual({ passed: true, failures: [] });
  expect((await inject("POST", "/v1/engines/contentextract/self-test", admin.key)).json().passed).toBe(true);
}, 180_000);

beforeEach(async () => {
  await clearLive();
  setContentInspectionRuntime({ dataKey: DATA_KEY, cancelRun: cancelEngineRunAsSystem });
});

afterAll(async () => {
  await rig?.stop();
  await clearLive();
  await setEngine(false);
  await db.execute(sql`UPDATE engines SET self_test = NULL, self_test_passed_at = NULL WHERE id = 'contentextract'`);
  await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test suite finished' WHERE revoked_at IS NULL`);
  await restoreGates?.();
  await restoreIssuerKey?.();
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0362 content-extraction runs: registration", () => {
  it("the engine is registered off and unpublished, with no model access", async () => {
    const [row] = await db.select().from(engines).where(eq(engines.id, "contentextract"));
    expect(row).toMatchObject({ kind: "content_extract", version: ENGINE_MANIFEST.contentextract.version });
    expect(ENGINE_MANIFEST.contentextract.imageDigest).toBeNull();
    expect(ENGINE_MANIFEST.contentextract.taskImage).toBeNull();
    expect(ENGINE_MANIFEST.contentextract.needsModelAccess).toBe(false);
  });

  it("a person cannot start a content-extraction run", async () => {
    const r = await inject("POST", "/v1/engine-runs", alice.key, { engineId: "contentextract", target: { agentId: admin.id }, config: { sets: ["extract"] } });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("engine_target_mismatch");
  });

  it("the database refuses a content-extraction run of another shape, and an inspection run of another engine", async () => {
    const base: typeof engineRuns.$inferInsert = {
      engineId: "contentextract",
      engineVersion: CE_BUILD.engineVersion,
      status: "cancelled",
      trigger: "inspection",
      targetKind: "subject",
      targetSubjectDigest: "a".repeat(64),
      config: { sets: ["extract"], params: {} },
      configHash: "x",
      trials: 1,
      budgetUsd: 0.01,
      timeoutSeconds: 60,
      queueExpiresAt: new Date(),
      finishedAt: new Date(),
    };
    await expect(db.insert(engineRuns).values({ ...base, trigger: "admission" })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, trigger: "manual" })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, engineId: "skillscanner" })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, targetSubjectDigest: "nothex" })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, targetKind: "agent", trigger: "manual", targetSubjectDigest: null, targetAgentId: null })).rejects.toThrow();
    // a request's person and project may be named (unlike an admission scan's)
    const [ok] = await db.insert(engineRuns).values({ ...base, runAsUserId: alice.id }).returning({ id: engineRuns.id });
    expect(ok).toBeTruthy();
  });

  it("the placement sensitivity of a run with no project is the one it was queued with, else confidential", () => {
    expect(contentExtractRunSensitivity({ config: { sets: ["extract"], params: { sensitivity: "regulated" } } })).toBe("regulated");
    expect(contentExtractRunSensitivity({ config: { sets: ["extract"], params: { sensitivity: "top-secret" } } })).toBe(CONTENT_EXTRACT_DEFAULT_SENSITIVITY);
    expect(contentExtractRunSensitivity({ config: { sets: ["extract"], params: {} } })).toBe("confidential");
  });
});

describe("ADR-0362 content-extraction runs: enqueue", () => {
  it("with the engine off (the default) nothing is queued", async () => {
    await setEngine(false);
    expect(await enqueueContentExtractRun(db, { bundleJson: bundleJson([{ id: "a0", text: "x" }]), projectId: null, userId: alice.id })).toEqual({ kind: "engine_off" });
  });

  it("no data key, or an empty bundle: nothing is queued and the refusal is audited without the bundle", async () => {
    await setEngine(true);
    const bundle = bundleJson([{ id: "a0", text: SECRET_TEXT }]);
    setContentInspectionRuntime({ dataKey: undefined, cancelRun: cancelEngineRunAsSystem });
    expect(await enqueueContentExtractRun(db, { bundleJson: bundle, projectId: null, userId: alice.id })).toEqual({ kind: "refused", code: "no_data_key" });
    setContentInspectionRuntime({ dataKey: DATA_KEY, cancelRun: cancelEngineRunAsSystem });
    expect(await enqueueContentExtractRun(db, { bundleJson: "", projectId: null, userId: alice.id })).toEqual({ kind: "refused", code: "bundle_empty" });
    const audit = await db.select().from(auditLog).where(eq(auditLog.ruleId, "content-inspection-not-queued"));
    const mine = audit.filter((a) => a.userId === alice.id);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mine)).not.toContain(RUN);
    const live = await db.select().from(engineRuns).where(eq(engineRuns.engineId, "contentextract"));
    expect(live.filter((r) => r.status === "queued")).toEqual([]);
  });

  it("queues the bundle encrypted, as a subject run of the request's person, never returned by the API", async () => {
    await setEngine(true);
    const bundle = bundleJson([{ id: "a0", text: SECRET_TEXT }]);
    const q = await enqueueContentExtractRun(db, { bundleJson: bundle, projectId: null, userId: alice.id, sensitivity: "regulated" });
    expect(q.kind).toBe("queued");
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, (q as { runId: string }).runId));
    expect(run).toMatchObject({ status: "queued", trigger: "inspection", targetKind: "subject", runAsUserId: alice.id, projectId: null, targetSubjectDigest: sha256(bundle) });
    expect(run!.config).toEqual({ sets: ["extract"], params: { sensitivity: "regulated" } });
    expect(run!.targetSubjectInputCiphertext).toBeTruthy();
    expect(run!.targetSubjectInputCiphertext).not.toContain(Buffer.from(SECRET_TEXT).toString("base64"));
    expect(run!.queueExpiresAt.getTime() - run!.createdAt.getTime()).toBeLessThanOrEqual(130_000);
    const listed = await inject("GET", `/v1/engine-runs/${run!.id}`, alice.key);
    expect(listed.body).not.toContain("targetSubjectInputCiphertext");
    expect(listed.body).not.toContain(Buffer.from(SECRET_TEXT).toString("base64"));
  });
});

describe("ADR-0362 content-extraction runs: lease, task, result and await", () => {
  it("lease (no key, bundle.json named) → placed task → result → read once, decrypted, then gone; the text is nowhere else", async () => {
    await setEngine(true);
    const files = [{ id: "a0", text: SECRET_TEXT }, { id: "a1", text: "second file" }];
    const bundle = bundleJson(files);
    const q = await enqueueContentExtractRun(db, { bundleJson: bundle, projectId: null, userId: alice.id });
    const runId = (q as { runId: string }).runId;
    const waiting = awaitContentExtractResult(db, runId, { deadlineMs: 30_000, pollMs: 20 });

    const lease = await client.lease(CE_BUILD);
    expect(lease?.runId).toBe(runId);
    expect(lease!.target).toBeNull();
    expect(lease!.subject).toEqual({ file: "bundle.json", sha256: sha256(bundle), size: Buffer.byteLength(bundle) });
    expect(await rig!.place(runId)).not.toBeNull();
    // the task start recorded the sha256 of the one file it placed: exactly the queued bundle
    expect((await db.select().from(engineRuns).where(eq(engineRuns.id, runId)))[0]!.targetSubjectInputSha256).toBe(sha256(bundle));
    expect(await client.result(runId, envelope(runId, resultOf(files)))).toBe(200);

    const out = await waiting;
    expect(out).toEqual({ kind: "result", result: { version: 1, files: files.map((f) => ({ id: f.id, status: "extracted", type: "text", text: f.text })) } });
    // read once: the stored copy is gone, a second read has nothing
    expect(await db.select().from(contentInspectionResults).where(eq(contentInspectionResults.runId, runId))).toEqual([]);
    expect(await awaitContentExtractResult(db, runId, { deadlineMs: 0 })).toEqual({ kind: "unavailable", reason: "no_result" });
    // the run kept neither the bundle nor the report's text: only the report's sha256 and size
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    expect(run).toMatchObject({ status: "completed", targetSubjectInputCiphertext: null, rawReportCiphertext: null, rawReportSha256: sha256(resultOf(files)) });
    expect((run!.summary as { contentInspection?: unknown }).contentInspection).toEqual({ resultStored: true });
    expect(JSON.stringify(run!.summary)).not.toContain(RUN);
    const audit = await db.select().from(auditLog).where(eq(auditLog.objectId, runId));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(RUN);
  });

  it("a result that does not answer for exactly the bundle's files is not stored: the request reads nothing", async () => {
    await setEngine(true);
    const runId = await queueLeaseAndPlace(bundleJson([{ id: "a0", text: "one" }, { id: "a1", text: "two" }]));
    const waiting = awaitContentExtractResult(db, runId, { deadlineMs: 30_000, pollMs: 20 });
    // a1 dropped (a compromised extractor hiding a file)
    expect(await client.result(runId, envelope(runId, resultOf([{ id: "a0", text: "one" }])))).toBe(200);
    expect(await waiting).toEqual({ kind: "unavailable", reason: "no_result" });
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    expect((run!.summary as { contentInspection?: unknown }).contentInspection).toEqual({ resultStored: false });
  });

  it("a report that does not parse with the shared schema is not stored", async () => {
    await setEngine(true);
    const runId = await queueLeaseAndPlace(bundleJson([{ id: "a0", text: "one" }]));
    const bad = Buffer.from(JSON.stringify({ version: 1, files: [{ id: "a0", status: "extracted", type: "text", text: "one", extra: true }] }));
    expect(await client.result(runId, envelope(runId, bad))).toBe(200);
    expect(await awaitContentExtractResult(db, runId, { deadlineMs: 5_000, pollMs: 20 })).toEqual({ kind: "unavailable", reason: "no_result" });
    expect(await db.select().from(contentInspectionResults).where(eq(contentInspectionResults.runId, runId))).toEqual([]);
  });

  it("an engine failure gives `failed` and stores nothing", async () => {
    await setEngine(true);
    const runId = await queueLeaseAndPlace(bundleJson([{ id: "a0", text: "one" }]));
    expect(await client.result(runId, envelope(runId, null, "failed"))).toBe(200);
    expect(await awaitContentExtractResult(db, runId, { deadlineMs: 5_000, pollMs: 20 })).toEqual({ kind: "unavailable", reason: "failed" });
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    expect(run).toMatchObject({ status: "failed", targetSubjectInputCiphertext: null });
  });

  it("the deadline: the request stops waiting, the run is cancelled and its bundle cleared, a late result is refused", async () => {
    await setEngine(true);
    const runId = await queueLeaseAndPlace(bundleJson([{ id: "a0", text: "one" }]));
    expect(await awaitContentExtractResult(db, runId, { deadlineMs: 150, pollMs: 20 })).toEqual({ kind: "unavailable", reason: "timeout" });
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", targetSubjectInputCiphertext: null });
    expect(run!.cancelRequestedAt).not.toBeNull();
    // the runner's late answer is not ingested, and nothing is stored for nobody to read
    expect(await client.result(runId, envelope(runId, resultOf([{ id: "a0", text: "one" }])))).toBe(409);
    expect(await db.select().from(contentInspectionResults).where(eq(contentInspectionResults.runId, runId))).toEqual([]);
  });

  it("a queued run that never ran: `not_run`, whatever ended it", async () => {
    await setEngine(true);
    const q = await enqueueContentExtractRun(db, { bundleJson: bundleJson([{ id: "a0", text: "x" }]), projectId: null, userId: alice.id });
    const runId = (q as { runId: string }).runId;
    // its bundle no longer matches its digest (a corrupted or substituted ciphertext): the lease ends it not_run
    await db.update(engineRuns).set({ targetSubjectInputCiphertext: encryptSecret(DATA_KEY, "{}") }).where(eq(engineRuns.id, runId));
    expect(await client.lease(CE_BUILD)).toBeNull();
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    expect(run).toMatchObject({ status: "not_run", errorCode: "subject_input_gone", targetSubjectInputCiphertext: null });
    expect(await awaitContentExtractResult(db, runId, { deadlineMs: 0 })).toEqual({ kind: "unavailable", reason: "not_run" });
  });

  it("awaiting a run that is not a content-extraction run reads nothing", async () => {
    expect(await awaitContentExtractResult(db, "00000000-0000-0000-0000-000000000000", { deadlineMs: 0 })).toEqual({ kind: "unavailable", reason: "no_result" });
  });
});

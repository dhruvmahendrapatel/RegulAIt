/**
 * ADR-0190 slice I5 — ENGINES UNDER EXECUTION PROFILES, on a real database through the real app: the modelscan
 * runner (the real runner core, adapter, exchange and task bridge) and a REAL executor (the executor package) with its
 * FAKE backend, whose engine task stand-in plays the scanner inside the sandbox (CI has no gVisor; the runsc
 * backend's own suites cover its two new channels on the host). What it pins:
 *
 *  - OWNER DECISION C: an engine_worker placement has no agent and is NEVER the unknown-agent rule: with an
 *    `internal` project it requires L2 (the engine_worker floor), not L3;
 *  - THE TASK START IS THE DECISION: the runner's task input is decided in one transaction: the engine_worker
 *    placement keyed to the run's decision audit row (the I4/I8 contract), and the run names it (migration 0200);
 *  - FAIL CLOSED, NO FALLBACK: a run whose placement does not resolve (no project) is refused `policy_unresolved`
 *    WITH a refused placement row, and one with no executor is refused `no_executor`; either ends the run `not_run`
 *    (`isolation_unavailable`) with nothing started;
 *  - END TO END: an artifact scan's job reaches the sandbox as a verified read-only input (the artifact streamed by
 *    the gateway from its store, never through the runner), the per-placement report names its digest, the results
 *    come back through the bridge, and the run completes with its scan record; the offer is `placed`;
 *  - INPUT INTEGRITY: an executor whose report names another input digest is refused (`input_digest_mismatch`) and
 *    quarantined, and the runner's task reads `refused`;
 *  - I8: an agent run's task start writes an `engine-run-entitlement` ALLOW decision whose facts name its
 *    engine_worker placement (never `in_gateway`, never `no_placement`).
 *
 * Global state (M-068): the engine row, runners, org settings and the placement affinity seam are restored in
 * afterAll; executor and identity rows are scoped by this run's ids (they cannot be deleted by design).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough, Readable } from "node:stream";
import { createInterface } from "node:readline";
import {
  agents,
  aiUseCases,
  and,
  artifactScans,
  auditLog,
  authSessions,
  createDb,
  decisionFacts,
  desc,
  engineRuns,
  eq,
  executionOffers,
  executionPlacementReports,
  executionPlacements,
  executors,
  modelArtifacts,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import {
  BATCH5_STRICT_DEFAULTS,
  decisionFactsSchema,
  ENGINE_MANIFEST,
  ENGINE_RESULT_VERSION,
  ENGINE_RUN_ENTITLEMENT_PHASE,
  evaluateRunnerSelfTest,
  ISOLATION_STRICT_DEFAULTS,
  STEP_UP_HEADER,
  type EngineId,
  type EngineManifestEntry,
} from "@regulait/shared";
import { buildSelfTest, ExecutorTaskBridge, generateRunnerSecret, runOnce, RunnerClient, type RunnerHttp } from "@regulait/engine-runner";
import { runSandboxTask } from "@regulait/engine-runner/worker";
import { ARTIFACT_NAME, ExchangeScanExecutor, modelscanAdapter } from "@regulait/engine-modelscan";
import { maliciousPickle } from "@regulait/engine-modelscan/fixtures";
import { ExecutorClient, generateExecutorKey, ProofChannelCredential, runExecutorLoop, type ExecutorHttp, type ExecutorKey } from "@regulait/sandbox-executor";
import { FakeSandboxBackend } from "@regulait/sandbox-executor/testing";
import { buildApp } from "./app.js";
import { useTestIssuerKey } from "./testing/workload-client.js";
import { relaxAgentEntitlementsForTest } from "./testing/agent-own-grants.js";
import { FileArtifactStore } from "./model-artifacts.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { resolveRequirement } from "./execution-placement.js";
import { engineTaskInputDigestFor, liveEngineTasks, setEngineTaskPlacementAffinityForTest, startEngineTask } from "./engine-tasks.js";
import { engineWorkerAttestationBasis } from "./engine-worker-attestation.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `i5-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const MS_DIGEST = `sha256:${"e".repeat(64)}`;
const TASK_IMAGE = `sha256:${"7".repeat(64)}`;
const PF_TASK_IMAGE = `sha256:${"8".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = {
  ...ENGINE_MANIFEST,
  modelscan: { ...ENGINE_MANIFEST.modelscan, imageDigest: MS_DIGEST, taskImage: TASK_IMAGE },
  promptfoo: { ...ENGINE_MANIFEST.promptfoo, taskImage: PF_TASK_IMAGE },
};
const MS_BUILD = { imageDigest: MS_DIGEST, engineVersion: MANIFEST.modelscan.version };
const ENV = deploymentEnvironment();
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
const DATA_KEY = "f".repeat(64);
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;

let db: Db;
let app: ReturnType<typeof buildApp>;
let storeDir: string;
const restores: Array<() => Promise<void>> = [];
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };
let alice: { id: string; key: { authorization: string } };
let client: RunnerClient;
let runnerId = "";
let projectId = "";

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asAdmin = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.session.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const runnerHttp: RunnerHttp = async (url, init) => {
  const u = new URL(url);
  const r = await app.inject({ method: init.method as Method, url: `${u.pathname}${u.search}`, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  return new Response(r.statusCode === 204 ? null : new Uint8Array(r.rawPayload), { status: r.statusCode, headers });
};

/** the executor's HTTP through the app; the input file route's bytes are passed as they are */
function executorHttp(): ExecutorHttp {
  return async (url, init) => {
    const u = new URL(url);
    const res = await app.inject({ method: init.method as Method, url: `${u.pathname}${u.search}`, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
    return {
      status: res.statusCode,
      text: async () => res.body,
      bytes: async function* () {
        yield new Uint8Array(res.rawPayload);
      },
    };
  };
}

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "i5" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: admin.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

async function newIdentity(name: string): Promise<{ id: string; identifier: string; key: ExecutorKey }> {
  const identifier = `spiffe://i5.example.org/regulait/worker_runtime/${name}-${RUN}`;
  const id = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments) values ('worker_runtime', ${identifier}, ARRAY[${admin.id}]::uuid[], ARRAY[${ENV}]) returning id`),
  )[0]!.id;
  const key = await generateExecutorKey();
  await db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
    values (${id}, 'jwk', ${JSON.stringify(key.publicJwk)}::jsonb, ${key.thumbprint}, now() + interval '30 days')`);
  return { id, identifier, key };
}

/**
 * The scanner as the engine task inside the fake sandbox: the real `runSandboxTask` over the input the backend wrote,
 * answering what the pinned scanner answers for a pickle that runs `os.system` (an unsafe finding).
 */
const OS_SYSTEM = {
  summary: { total_issues: 1, modelscan_version: "0.8.8", scanned: { total_scanned: 1, scanned_files: ["artifact.pkl"] }, skipped: { total_skipped: 0, skipped_files: [] } },
  issues: [{ description: "d", operator: "system", module: "os", source: "artifact.pkl", scanner: "s", severity: "CRITICAL" }],
  errors: [],
};
const seenInputs: Array<{ files: string[]; artifactSha256: string | null; secret: string | undefined }> = [];
async function scannerTask(ctx: { files: ReadonlyMap<string, Buffer>; secret: string | undefined; stdin: AsyncIterable<string>; write: (l: string) => void }): Promise<void> {
  const jobsRoot = await mkdtemp(path.join(tmpdir(), "i5-sbx-jobs-"));
  for (const [p, b] of ctx.files) {
    await mkdir(path.dirname(path.join(jobsRoot, p)), { recursive: true });
    await writeFile(path.join(jobsRoot, p), b);
  }
  const art = [...ctx.files.entries()].find(([p]) => ARTIFACT_NAME.test(path.basename(p)));
  seenInputs.push({ files: [...ctx.files.keys()].sort(), artifactSha256: art ? createHash("sha256").update(art[1]).digest("hex") : null, secret: ctx.secret });
  const out = new PassThrough();
  createInterface({ input: out }).on("line", (l) => ctx.write(l));
  await runSandboxTask({
    gateway: false,
    jobsRoot,
    workRoot: await mkdtemp(path.join(tmpdir(), "i5-sbx-work-")),
    stdout: out,
    stdin: Readable.from((async function* () {
      for await (const l of ctx.stdin) yield `${l}\n`;
    })()),
    readSecret: () => ctx.secret ?? null,
    run: async (t) => {
      const job = JSON.parse(await readFile(path.join(t.jobsRoot, t.runId, "job.json"), "utf8")) as { runId: string };
      expect(job.runId).toBe(t.runId);
      const bytes = Buffer.from(JSON.stringify(OS_SYSTEM));
      await writeFile(path.join(t.resultsRoot, t.runId, "report.json"), bytes);
      await writeFile(
        path.join(t.resultsRoot, t.runId, "done.json"),
        JSON.stringify({ exitCode: 1, timedOut: false, cancelled: false, reportSha256: createHash("sha256").update(bytes).digest("hex"), reportTooLarge: false, npy: null, npz: null }),
      );
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  out.end();
}

async function rig(name: string, backend: FakeSandboxBackend) {
  const ident = await newIdentity(name);
  const d = backend.describe();
  const reg = await inject("POST", "/v1/executors", admin.key, { workloadIdentityId: ident.id, name: `i5-${RUN}-${name}`, backend: d.backend, runtimeVersion: d.runtimeVersion, classesDeclared: [...d.classes] });
  expect(reg.statusCode, reg.body).toBe(201);
  const credential = new ProofChannelCredential({ identifier: ident.identifier, key: ident.key, issuer: ORIGIN });
  const exClient = new ExecutorClient({ gatewayUrl: ORIGIN, credential, http: executorHttp() });
  const logs: string[] = [];
  const run = (maxWindows: number) =>
    runExecutorLoop({ client: exClient, backend, credential, maxWindows, streamWindowSeconds: 1, stdioWindowSeconds: 1, backoffMs: 5, maxBackoffMs: 10, log: (m) => logs.push(m) });
  const runWith = (o: { capacity?: number; maxWindows: number }) =>
    runExecutorLoop({ client: exClient, backend, credential, streamWindowSeconds: 1, stdioWindowSeconds: 1, backoffMs: 5, maxBackoffMs: 10, log: (m) => logs.push(m), ...o });
  return { executorId: reg.json().executorId as string, backend, run, runWith, logs };
}

async function uploadedAs(who: { key: { authorization: string } }, bytes: Buffer): Promise<{ id: string; sha256: string }> {
  const r = await app.inject({ method: "POST", url: "/v1/model-artifacts?filename=model.pkl", headers: { ...who.key, "content-type": "application/octet-stream" }, payload: bytes });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().artifact;
}
async function startScan(artifactId: string, project: string | null): Promise<string> {
  const r = await inject("POST", "/v1/engine-runs", alice.key, { engineId: "modelscan", target: { artifactId }, config: { sets: ["scan"] }, ...(project ? { projectId: project } : {}) });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run.id as string;
}
async function runRow(id: string) {
  return (await db.select().from(engineRuns).where(eq(engineRuns.id, id)))[0]!;
}
/** the run's task start decision (its own audit row) */
async function taskDecision(runId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.detail}->>'engineRunId' = ${runId} AND ${auditLog.detail}->>'step' = 'task_start'`)
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}
const placementOf = async (auditId: string) => (await db.select().from(executionPlacements).where(eq(executionPlacements.auditId, auditId)))[0];
async function endRun(id: string) {
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE id = ${id} AND status IN ('queued', 'leased')`);
}
/** a completed modelscan result with nothing found (what a runner that never ran the scanner might claim) */
const completedEnvelope = (runId: string) => ({
  version: ENGINE_RESULT_VERSION as typeof ENGINE_RESULT_VERSION,
  runId,
  engineId: "modelscan" as const,
  engineVersion: MANIFEST.modelscan.version,
  status: "completed" as const,
  errorCode: null,
  items: [],
  notRun: [],
  rawReport: null,
});
/** a scan's job, as the runner publishes it, for a task started by hand */
const scanJobUpload = (runId: string) => ({
  files: [{ path: `${runId}/job.json`, data: Buffer.from(JSON.stringify({ runId, format: "pickle", artifactName: "artifact.pkl", timeoutMs: 60_000 })).toString("base64") }],
  artifact: { path: `${runId}/artifact.pkl` },
  secret: null,
});

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" }));
  restores.push(await relaxAgentEntitlementsForTest(db));
  storeDir = await mkdtemp(path.join(tmpdir(), "i5-store-"));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, engines: { manifest: MANIFEST }, artifactStore: new FileArtifactStore(storeDir), executorChannel: { streamPollMs: 25, keepaliveMs: 200 } });
  await app.ready();
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE engine_id = 'modelscan' AND status IN ('queued', 'awaiting_approval', 'leased')`);

  const a = await makeUser(`i5-admin-${RUN}@example.com`, true);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: a.id,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  admin = { ...a, session: { token }, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  expect((await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "i5" })).statusCode).toBe(201);
  alice = await makeUser(`i5-alice-${RUN}@example.com`);
  // the project the runs are attributed to (no members: anyone may attribute): its sensitivity is its use case's
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`i5-p-${RUN}`}) returning id`))[0]!.id;
  await db.insert(aiUseCases).values({ name: `i5-uc-${RUN}`, description: "d", ownerUserId: admin.id, businessContext: "b", dataSensitivity: "internal", projectId });

  // the modelscan runner, registered and the engine enabled (as the B5-M suite does)
  const t = await inject("POST", "/v1/engines/modelscan/enrollment-tokens", admin.key, { label: "i5" });
  expect(t.statusCode, t.body).toBe(201);
  client = new RunnerClient({ gatewayUrl: "http://gateway.test", issuer: ORIGIN, http: runnerHttp });
  const selfTest = await buildSelfTest({
    ...MS_BUILD,
    requiredEnv: MANIFEST.modelscan.usageDataEnv,
    env: { ...MANIFEST.modelscan.usageDataEnv },
    egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
  });
  const secret = generateRunnerSecret();
  const reg = await client.register(t.json().token, secret, { name: `modelscan-i5-${RUN}`, ...MS_BUILD, selfTest });
  expect(reg.selfTest).toEqual({ passed: true, failures: [] });
  runnerId = rows<{ id: string }>(await db.execute(sql`select id from engine_runners where name = ${`modelscan-i5-${RUN}`}`))[0]!.id;
  expect((await inject("POST", "/v1/engines/modelscan/self-test", admin.key)).json().passed).toBe(true);
  const refused = await asAdmin("PATCH", "/v1/engines/modelscan", { enabled: true, acceptCredentialIsolationRisk: true, expectedVersion: MANIFEST.modelscan.version, expectedDigest: MS_DIGEST });
  expect(refused.statusCode, refused.body).toBe(403);
  const ok = await asAdmin("PATCH", "/v1/engines/modelscan", { enabled: true, acceptCredentialIsolationRisk: true, expectedVersion: MANIFEST.modelscan.version, expectedDigest: MS_DIGEST }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(200);
}, 180_000);

afterAll(async () => {
  setEngineTaskPlacementAffinityForTest(null);
  await forgetStepUpMethodsForTest(db, [admin?.id]);
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE status IN ('queued', 'leased') AND runner_id = ${runnerId}`);
  await db.execute(sql`UPDATE engines SET enabled = false, self_test = NULL, self_test_passed_at = NULL, max_budget_usd = 5, timeout_seconds = 1800, max_concurrent = 1`);
  await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test suite finished' WHERE revoked_at IS NULL`);
  await db.update(orgSettings).set({ ...BATCH5_STRICT_DEFAULTS }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  for (const r of restores.reverse()) await r();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------
describe("OWNER DECISION C: an engine worker is never the unknown agent", () => {
  it("agent null with an internal project requires L2 at the engine_worker floor, not L3", async () => {
    const r = await resolveRequirement(db, { workloadKind: "engine_worker", projectId, agent: null, parentGrantId: null });
    expect(r).toMatchObject({ kind: "required", requiredClass: "user_space_kernel", requiredBy: "workload_kind", agentAssurance: "known", sensitivity: "internal" });
    expect((r as { profile: { name: string; source: string } }).profile).toMatchObject({ name: "engine-worker", source: "shipped_default" });
    // NEGATIVE CONTROL: the same call as a stdio server's with no agent IS the unknown agent (L3, restricted-microvm)
    const stdio = await resolveRequirement(db, { workloadKind: "code_exec", projectId, agent: null, parentGrantId: null });
    expect(stdio).toMatchObject({ kind: "required", requiredClass: "microvm", agentAssurance: "unknown" });
  });

  it("review LOW-1: a relaxed engine-worker floor is honoured for the shipped profile's configured floor (never below L1)", async () => {
    try {
      await db.update(orgSettings).set({ isolationFloorEngineWorker: "hardened_container", isolationFloorInternal: "hardened_container" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      const r = await resolveRequirement(db, { workloadKind: "engine_worker", projectId, agent: null, parentGrantId: null });
      expect(r).toMatchObject({ kind: "required", requiredClass: "hardened_container", agentAssurance: "known" });
      // the shipped profile itself is unchanged: its own minClass still bounds where it can be placed (the broker)
      expect((r as { profile: { name: string; minClass: string } }).profile).toMatchObject({ name: "engine-worker", minClass: "user_space_kernel" });
    } finally {
      await db.update(orgSettings).set({ isolationFloorEngineWorker: ISOLATION_STRICT_DEFAULTS.isolationFloorEngineWorker, isolationFloorInternal: ISOLATION_STRICT_DEFAULTS.isolationFloorInternal }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    expect(await resolveRequirement(db, { workloadKind: "engine_worker", projectId, agent: null, parentGrantId: null })).toMatchObject({ requiredClass: "user_space_kernel" });
  });
});

describe("review HIGH-1: a result counts only for a run whose task an executor reported placed", () => {
  it("a result for a leased run with no task is refused engine_task_not_placed, and the run ends not_run", async () => {
    const art = await uploadedAs(alice, maliciousPickle());
    const runId = await startScan(art.id, projectId);
    expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
    // the runner claims a clean completed scan with no sandbox ever placed: refused, never ingested
    expect(await client.result(runId, completedEnvelope(runId))).toBe(409);
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable", taskPlacementId: null });
    expect((run.summary as { cause: string }).cause).toBe("engine_task_not_placed");
    expect(await db.select().from(artifactScans).where(eq(artifactScans.engineRunId, runId)).then((r) => r.filter((s) => s.verdict === "unsafe" || s.verdict === "clean"))).toEqual([]);
  });

  it("recheck L1: a not_run envelope from a run with no placed task is dropped too: no items, no raw report, no scan record", async () => {
    const art = await uploadedAs(alice, maliciousPickle());
    const runId = await startScan(art.id, projectId);
    expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
    const raw = Buffer.from("{}");
    const status = await client.result(runId, {
      ...completedEnvelope(runId),
      status: "not_run",
      notRun: [{ key: "modelscan/scan", reason: "unsupported_format" }],
      rawReport: { sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length, contentBase64: raw.toString("base64") },
    });
    expect(status).toBe(409);
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable", rawReportSha256: null });
    expect((run.summary as { cause: string }).cause).toBe("engine_task_not_placed");
    expect(await db.select().from(artifactScans).where(eq(artifactScans.engineRunId, runId))).toEqual([]);
    const ingested = await db.select().from(auditLog).where(and(eq(auditLog.objectId, runId), eq(auditLog.ruleId, "engine-run-result-ingested")));
    expect(ingested).toEqual([]);
  });

  it("a run whose task was offered but never reported placed is refused the same way (an offer is not a placement)", async () => {
    const ex = await rig("silent", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }));
    setEngineTaskPlacementAffinityForTest([ex.executorId]);
    try {
      await ex.run(1); // attested, then no longer serving: the offer is never taken
      const art = await uploadedAs(alice, maliciousPickle());
      const runId = await startScan(art.id, projectId);
      expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
      expect((await client.taskInput(runId, scanJobUpload(runId))).status).toBe(201);
      expect((await runRow(runId)).taskPlacementId).not.toBeNull();
      const status = await client.result(runId, completedEnvelope(runId));
      expect(status).toBe(409);
      expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable" });
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  }, 60_000);
});

describe("review LOW-3: the task start re-runs the lease's checks; a started task's lease is never re-issued", () => {
  it("a run whose person may no longer use its artifact is refused at the task start (artifact_not_accessible) and ends not_run", async () => {
    const art = await uploadedAs(alice, maliciousPickle());
    const runId = await startScan(art.id, projectId);
    expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
    // the artifact changes hands after the lease (alice is neither its uploader nor an admin any more)
    await db.update(modelArtifacts).set({ uploadedByUserId: admin.id }).where(eq(modelArtifacts.id, art.id));
    const out = await client.taskInput(runId, scanJobUpload(runId));
    expect(out).toMatchObject({ status: 403, error: "artifact_not_accessible" });
    expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "artifact_not_accessible", taskPlacementId: null });
    expect(await taskDecision(runId)).toMatchObject({ objectType: "engine_run", effect: "deny" });
  });

  it("a lease retry (same request id) for a run whose task started ends it not_run instead of rotating the sandbox's key", async () => {
    const ex = await rig("reissue", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }));
    setEngineTaskPlacementAffinityForTest([ex.executorId]);
    try {
      await ex.run(1);
      const art = await uploadedAs(alice, maliciousPickle());
      const runId = await startScan(art.id, projectId);
      const requestId = randomUUID();
      expect((await client.lease(MS_BUILD, requestId))?.runId).toBe(runId);
      expect((await client.taskInput(runId, scanJobUpload(runId))).status).toBe(201);
      // the runner lost the lease answer and retries it: nothing is re-issued
      expect(await client.lease(MS_BUILD, requestId)).toBeNull();
      const run = await runRow(runId);
      expect(run).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable" });
      expect((run.summary as { cause: string }).cause).toBe("engine_task_lease_reissued");
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  }, 60_000);
});

describe("ADR-0190 I5: the first-enable basis is a fresh executor attestation of the engine-worker profile", () => {
  it("an active executor's fresh L2 pass for the shipped engine-worker profile is the basis, recorded whole", async () => {
    const ex = await rig("basis", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }));
    await ex.run(1);
    const basis = await engineWorkerAttestationBasis(db);
    expect(basis).toMatchObject({ attested: true, reason: "attested", requiredClass: "user_space_kernel", attestationClass: "user_space_kernel" });
    expect(basis.profileDigest).toMatch(/^[0-9a-f]{64}$/);
    // and the verdict a runner without its worker's own report gets rests on it
    const st = { imageDigest: MS_DIGEST, engineVersion: MANIFEST.modelscan.version, usageDataEnv: {}, egress: { host: "x.invalid", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false }, at: new Date().toISOString() };
    expect(evaluateRunnerSelfTest(MANIFEST.modelscan, st, new Date(), { executorAttested: basis.attested })).toEqual({ passed: true, failures: [] });
    expect(evaluateRunnerSelfTest(MANIFEST.modelscan, st, new Date(), { executorAttested: false }).failures).toEqual(["executor_attestation_missing:REGULAIT_MODELSCAN_SCANNER_ISOLATED"]);
  });

  it("recheck L6: the basis fails closed when the attestation is stale, failed, of another profile, below the floor, or the executor is quarantined", async () => {
    const only = (id: string) => ({ onlyExecutorIds: [id] });
    // STALE: a pass read after its expiry
    const fresh = await rig("basis-stale", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }));
    await fresh.run(1);
    const ok = await engineWorkerAttestationBasis(db, only(fresh.executorId));
    expect(ok.attested).toBe(true);
    expect(await engineWorkerAttestationBasis(db, { ...only(fresh.executorId), now: new Date(Date.parse(ok.expiresAt!) + 1_000) })).toMatchObject({ attested: false, reason: "no_fresh_attestation" });
    // FAILED: the self-test of the engine-worker profile fails (a probe lies in the canary)
    const failed = await rig("basis-failed", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }).lie("root_read_only", (o) => ({ ...o, readOnly: false }), "canary"));
    await failed.run(1);
    expect(await engineWorkerAttestationBasis(db, only(failed.executorId))).toMatchObject({ attested: false, reason: "no_fresh_attestation" });
    // ANOTHER PROFILE: the executor attests every live profile but the engine-worker one (its backend cannot serve it)
    const other = await rig("basis-other", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"], unsupported: (p) => (p.filesystem.inputs.length > 0 ? "no input volume" : null) }));
    await other.run(1);
    expect(await engineWorkerAttestationBasis(db, only(other.executorId))).toMatchObject({ attested: false, reason: "no_fresh_attestation" });
    // BELOW THE FLOOR: an L2 pass when the org raises the engine-worker floor to L3
    try {
      await db.update(orgSettings).set({ isolationFloorEngineWorker: "microvm" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      expect(await engineWorkerAttestationBasis(db, only(fresh.executorId))).toMatchObject({ attested: false, reason: "no_fresh_attestation", requiredClass: "microvm" });
    } finally {
      await db.update(orgSettings).set({ isolationFloorEngineWorker: ISOLATION_STRICT_DEFAULTS.isolationFloorEngineWorker }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    // QUARANTINED: the same fresh pass no longer counts once its executor is quarantined
    await db.execute(sql`UPDATE executors SET status = 'quarantined', quarantine_code = 'admin', quarantined_at = now(), updated_at = now() WHERE id = ${fresh.executorId} AND status = 'active'`);
    expect(await engineWorkerAttestationBasis(db, only(fresh.executorId))).toMatchObject({ attested: false, reason: "no_fresh_attestation" });
  }, 60_000);
});

describe("recheck L6: the watchdog ends a run whose offer is refused while nobody reads its frames", () => {
  it("an executor that declines the offer: the run ends not_run (isolation_unavailable) within the watchdog, no frames read", async () => {
    const ex = await rig("declines", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }));
    setEngineTaskPlacementAffinityForTest([ex.executorId]);
    try {
      await ex.run(1);
      const art = await uploadedAs(alice, maliciousPickle());
      const runId = await startScan(art.id, projectId);
      expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
      expect((await client.taskInput(runId, scanJobUpload(runId))).status).toBe(201);
      // at capacity 0 the executor declines every offer
      await ex.runWith({ capacity: 0, maxWindows: 2 });
      let run = await runRow(runId);
      for (let i = 0; i < 80 && run.status === "leased"; i++) {
        await new Promise((r) => setTimeout(r, 100));
        run = await runRow(runId);
      }
      expect(run).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable" });
      expect((run.summary as { cause: string }).cause).toMatch(/^engine_task_/);
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  }, 60_000);
});

describe("the task start is the decision; fail closed, no fallback", () => {
  it("no project: refused policy_unresolved WITH a refused placement row keyed to the decision; the run ends not_run", async () => {
    const art = await uploadedAs(alice, maliciousPickle());
    const runId = await startScan(art.id, null);
    const lease = await client.lease(MS_BUILD);
    expect(lease?.runId).toBe(runId);
    const out = await client.taskInput(runId, scanJobUpload(runId));
    expect(out).toMatchObject({ status: 409, error: "execution_profile_unavailable", reason: "policy_unresolved" });
    const d = await taskDecision(runId);
    expect(d).toMatchObject({ objectType: "engine_run", objectId: runId, effect: "deny", ruleId: "execution-profile" });
    const p = await placementOf(d!.id);
    expect(p).toMatchObject({ workloadKind: "engine_worker", outcome: "refused", refusalCode: "policy_unresolved", requiredClass: null, executorId: null, imageDigest: TASK_IMAGE });
    expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable", taskPlacementId: null });
    expect(liveEngineTasks()).toBe(0);
  });

  it("no executor that can take it: refused no_executor with the L2 requirement; the run ends not_run; a second start is refused", async () => {
    setEngineTaskPlacementAffinityForTest([randomUUID()]);
    try {
      const art = await uploadedAs(alice, maliciousPickle());
      const runId = await startScan(art.id, projectId);
      expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
      const out = await client.taskInput(runId, scanJobUpload(runId));
      expect(out).toMatchObject({ status: 409, reason: "no_executor" });
      const p = await placementOf((await taskDecision(runId))!.id);
      expect(p).toMatchObject({ outcome: "refused", refusalCode: "no_executor", requiredClass: "user_space_kernel", requiredBy: "workload_kind" });
      expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable" });
      // nothing more starts for it
      expect((await client.taskInput(runId, scanJobUpload(runId))).status).toBe(409);
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  });

  it("an engine whose task image is not built yet cannot place anything (policy_unresolved), whatever the executors", async () => {
    {
      const art = await uploadedAs(alice, maliciousPickle());
      const runId = await startScan(art.id, projectId);
      expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
      const r = await startEngineTask(
        db,
        {
          manifest: () => ({ ...MANIFEST, modelscan: { ...MANIFEST.modelscan, taskImage: null } }),
          artifactStore: () => new FileArtifactStore(storeDir),
          endRunTx: async (tx, run) => (await (tx as unknown as Db).update(engineRuns).set({ status: "not_run", errorCode: "isolation_unavailable", finishedAt: new Date() }).where(eq(engineRuns.id, run.id)).returning())[0] ?? null,
          notifyEnded: async () => undefined,
        },
        runnerId,
        runId,
        scanJobUpload(runId),
      );
      expect(r).toMatchObject({ kind: "unplaced", code: "policy_unresolved" });
      expect(await placementOf((await taskDecision(runId))!.id)).toMatchObject({ outcome: "refused", refusalCode: "policy_unresolved", imageDigest: null });
    }
  });
});

describe("end to end: the scan runs in the executor's sandbox, on a verified read-only input", () => {
  it("placed, proved, run, and the run completes with its scan; the artifact went gateway to executor, never through the runner", async () => {
    const ex = await rig("ok", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"], engineTask: scannerTask }));
    setEngineTaskPlacementAffinityForTest([ex.executorId]);
    try {
      await ex.run(1); // announce and self-test: a fresh L2 attestation for the engine-worker profile
      const loop = ex.run(15);
      const bytes = maliciousPickle();
      const art = await uploadedAs(alice, bytes);
      const runId = await startScan(art.id, projectId);
      const jobsRoot = await mkdtemp(path.join(tmpdir(), "i5-jobs-"));
      const resultsRoot = await mkdtemp(path.join(tmpdir(), "i5-results-"));
      const abort = new AbortController();
      const bridge = new ExecutorTaskBridge({ client, jobsRoot, resultsRoot, gatewayBaseUrl: "http://gateway.test/v1", isArtifact: (n) => ARTIFACT_NAME.test(n), pollMs: 25 });
      const bridging = bridge.run(abort.signal);
      const adapter = modelscanAdapter({ artifacts: client, executor: new ExchangeScanExecutor(jobsRoot, resultsRoot, { pollMs: 25 }) });
      const out = await runOnce(client, adapter, { ...MS_BUILD, engineId: "modelscan", workRoot: await mkdtemp(path.join(tmpdir(), "i5-w-")), heartbeatMs: 200, retryBaseMs: 10 });
      abort.abort();
      await bridging;
      await loop;
      expect(out).toMatchObject({ outcome: "posted", status: 200 });
      const run = await runRow(runId);
      expect(run).toMatchObject({ status: "completed" });
      const [scan] = await db.select().from(artifactScans).where(eq(artifactScans.engineRunId, runId));
      expect(scan).toMatchObject({ verdict: "unsafe" });
      // the decision and its placement (keyed to it, written in its transaction), named by the run
      const d = await taskDecision(runId);
      expect(d).toMatchObject({ objectType: "engine_run", effect: "allow", ruleId: "engine-run-task-started" });
      const p = await placementOf(d!.id);
      expect(p).toMatchObject({ workloadKind: "engine_worker", outcome: "offered", executorId: ex.executorId, requiredClass: "user_space_kernel", appliedClass: "user_space_kernel", imageDigest: TASK_IMAGE });
      expect(run.taskPlacementId).toBe(p!.id);
      const [report] = await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, p!.id));
      expect(report).toMatchObject({ outcome: "placed", appliedClass: "user_space_kernel" });
      const [offer] = await db.select().from(executionOffers).where(eq(executionOffers.id, p!.offerId!));
      expect(offer).toMatchObject({ workloadKind: "engine_worker", imageDigest: TASK_IMAGE, status: "ended" });
      // the sandbox's input: the job inline, the artifact streamed by the gateway; its digest is the one decided
      const [sb] = ex.backend.sandboxes.filter((s) => s.kind === "placement");
      expect(sb).toMatchObject({ probed: true, released: true, secretSha256: null, workload: { command: MANIFEST.modelscan.taskEntry.command, args: [...MANIFEST.modelscan.taskEntry.args] } });
      expect(sb!.inputSha256).toBe((d!.detail as { inputDigest: string }).inputDigest);
      expect(seenInputs.at(-1)).toEqual({ files: [`${runId}/artifact.pkl`, `${runId}/job.json`], artifactSha256: art.sha256, secret: undefined });
      const streamed = await db.select().from(auditLog).where(and(eq(auditLog.objectId, runId), eq(auditLog.ruleId, "engine-run-artifact-streamed")));
      expect(streamed.map((s) => (s.detail as { phase: string }).phase)).toContain("task_input");
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  }, 120_000);

  it("an executor that reports another input digest is refused (input_digest_mismatch), quarantined, and the task reads refused", async () => {
    const backend = new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"], engineTask: scannerTask });
    const realStart = backend.start.bind(backend);
    backend.start = async (...a: Parameters<FakeSandboxBackend["start"]>) => ({ ...(await realStart(...a)), inputSha256: "0".repeat(64) });
    const ex = await rig("lies", backend);
    setEngineTaskPlacementAffinityForTest([ex.executorId]);
    try {
      await ex.run(1);
      const loop = ex.run(10);
      const art = await uploadedAs(alice, maliciousPickle());
      const runId = await startScan(art.id, projectId);
      expect((await client.lease(MS_BUILD))?.runId).toBe(runId);
      expect((await client.taskInput(runId, scanJobUpload(runId))).status).toBe(201);
      let frames = await client.taskFrames(runId, 0, 1);
      for (let i = 0; i < 60 && frames.state !== "refused"; i++) frames = await client.taskFrames(runId, 0, 1);
      expect(frames).toMatchObject({ state: "refused", refusal: "execution_profile_mismatch" });
      // review MEDIUM-2: the refusal after the offer ended the run in the gateway (the runner is told on its next beat)
      const ended = await runRow(runId);
      expect(ended).toMatchObject({ status: "not_run", errorCode: "isolation_unavailable" });
      expect((ended.summary as { cause: string }).cause).toBe("engine_task_execution_profile_mismatch");
      expect((await client.heartbeat(runId, "running", 0.5)).cancel).toBe(true);
      await loop;
      const [mismatch] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-profile-mismatch"), sql`${auditLog.detail}->>'executorId' = ${ex.executorId}`));
      expect((mismatch!.detail as { failures: Array<{ code: string }> }).failures.map((f) => f.code)).toContain("input_digest_mismatch");
      expect((await db.select().from(executors).where(eq(executors.id, ex.executorId)))[0]).toMatchObject({ status: "quarantined", quarantineCode: "execution_profile_mismatch" });
      expect(ex.backend.sandboxes.filter((s) => s.kind === "placement").every((s) => !s.released), "no input was released").toBe(true);
      await endRun(runId);
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  }, 60_000);
});

describe("I8: an agent run's task start is an entitlement decision whose facts name its engine_worker placement", () => {
  it("an allowed engine-run-entitlement decision is captured with its offered placement (never in_gateway, never no_placement)", async () => {
    const ex = await rig("agent", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"] }));
    setEngineTaskPlacementAffinityForTest([ex.executorId]);
    try {
      await ex.run(1);
      // a target agent the run-as person may execute
      const ag = await inject("POST", "/v1/agents", AUTH, { name: `i5-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model: "mock-i5" });
      expect(ag.statusCode, ag.body).toBe(201);
      const agentId = ag.json().id as string;
      const g = await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId });
      expect(g.statusCode, g.body).toBeLessThan(300);
      // a promptfoo run leased to this suite's runner (seeded: the B5-P suite pins the lease itself)
      const runId = rows<{ id: string }>(
        await db.execute(sql`insert into engine_runs (engine_id, engine_version, status, trigger, run_as_user_id, project_id, target_kind, target_agent_id, config, config_hash, trials, budget_usd, timeout_seconds, created_at, queue_expires_at, runner_id, leased_at, lease_expires_at, deadline_at)
          values ('promptfoo', ${MANIFEST.promptfoo.version}, 'leased', 'manual', ${alice.id}, ${projectId}, 'agent', ${agentId}, ${JSON.stringify({ sets: ["basic"] })}::jsonb, ${"a".repeat(64)}, 1, 1, 600, now(), now() + interval '1 hour', ${runnerId}, now(), now() + interval '10 minutes', now() + interval '10 minutes') returning id`),
      )[0]!.id;
      const keyMaterial = `run-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
      const r = await startEngineTask(
        db,
        { manifest: () => MANIFEST, artifactStore: () => null, endRunTx: async () => null, notifyEnded: async () => undefined },
        runnerId,
        runId,
        { files: [{ path: `${runId}/job.json`, data: Buffer.from(JSON.stringify({ runId })).toString("base64") }], artifact: null, secret: keyMaterial },
      );
      expect(r, JSON.stringify(r)).toMatchObject({ kind: "offered" });
      // review MEDIUM-2: the task is held before the decision commits: its input is here the moment the offer exists
      const offerId = (r as { task: { offerId: string } }).task.offerId;
      expect(engineTaskInputDigestFor(offerId)).toMatch(/^[0-9a-f]{64}$/);
      const d = await taskDecision(runId);
      expect(d).toMatchObject({ objectType: "agent", objectId: agentId, effect: "allow", ruleId: "engine-run-task-started" });
      expect((d!.detail as { phase: string; receiptClass: string })).toMatchObject({ phase: ENGINE_RUN_ENTITLEMENT_PHASE, receiptClass: "decision" });
      const p = await placementOf(d!.id);
      expect(p).toMatchObject({ workloadKind: "engine_worker", outcome: "offered", imageDigest: PF_TASK_IMAGE });
      const [f] = await db.select().from(decisionFacts).where(eq(decisionFacts.auditId, d!.id));
      const facts = decisionFactsSchema.parse(f!.facts) as { execution?: Record<string, unknown> | null };
      expect(facts.execution).toMatchObject({ workloadKind: "engine_worker", placement: "offered", placementId: p!.id, requiredClass: "user_space_kernel" });
      // the secret is in no row: not the decision, not the placement
      expect(JSON.stringify(d)).not.toContain(keyMaterial);
      await endRun(runId);
      await db.delete(agents).where(eq(agents.id, agentId)).catch(() => undefined);
    } finally {
      setEngineTaskPlacementAffinityForTest(null);
    }
  }, 60_000);
});

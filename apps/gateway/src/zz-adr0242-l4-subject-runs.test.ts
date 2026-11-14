/**
 * ADR-0242 phase 2 (lane L4, amendment L4.3) — the `subject` engine target, end to end against a real database and
 * the real runner routes: a skill save queues a skillscanner run (deduped), a registered runner leases it (the lease
 * names the SKILL.md the gateway will place and carries no key), the task is placed by a real executor through the
 * gateway's own task start, and the runner's result (the committed known-bad report) holds the skill, with the scan
 * row linked to the run. Also: a superseded digest ends the run not_run at lease; a person cannot start an
 * admission-scan run; with the engine off nothing is queued; an MCP sync without a data key queues nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  admissionEngineScans,
  and,
  auditLog,
  builderSkills,
  createDb,
  engineRuns,
  engines,
  eq,
  mcpServers,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { ENGINE_MANIFEST, ENGINE_RESULT_VERSION, manifestCanonicalJson, manifestDigest, type EngineId, type EngineManifestEntry, type EngineResultEnvelope } from "@regulait/shared";
import { buildSelfTest, generateRunnerSecret, RunnerClient, type RunnerHttp } from "@regulait/engine-runner";
import { buildApp } from "./app.js";
import { useTestIssuerKey } from "./testing/workload-client.js";
import { startEngineTaskRig, type EngineTaskRig } from "./testing/engine-task-rig.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { enqueueAdmissionScanRun, setAdmissionScanRuntime, skillMarkdown } from "./admission-scan-runs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.resolve(here, "../../../packages/shared/src/engines/fixtures/admission-scan", `${name}.json`));

const RUN = randomBytes(3).toString("hex");
const BOOT = `l4s-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const SK_DIGEST = `sha256:${"d".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = { ...ENGINE_MANIFEST, skillscanner: { ...ENGINE_MANIFEST.skillscanner, imageDigest: SK_DIGEST } };
const SK_BUILD = { imageDigest: SK_DIGEST, engineVersion: MANIFEST.skillscanner.version };
const DATA_KEY = "e".repeat(64);
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
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "l4s" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
async function setEngine(id: "skillscanner" | "mcpscanner", enabled: boolean): Promise<void> {
  await db.update(engines).set(enabled ? { enabled: true, selfTestPassedAt: new Date() } : { enabled: false }).where(eq(engines.id, id));
}
async function saveSkill(body: string): Promise<typeof builderSkills.$inferSelect> {
  const r = await inject("POST", "/v1/builder/skills", alice.key, { name: `l4s ${RUN} ${randomBytes(3).toString("hex")}`, description: "formats tables", body, visibility: "private" });
  expect(r.statusCode, r.body).toBe(201);
  return (await db.select().from(builderSkills).where(eq(builderSkills.id, r.json().skill.id as string)))[0]!;
}
const runsOf = (skillId: string) => db.select().from(engineRuns).where(eq(engineRuns.targetBuilderSkillId, skillId));
const envelope = (runId: string, report: Buffer): EngineResultEnvelope => ({
  version: ENGINE_RESULT_VERSION,
  runId,
  engineId: "skillscanner",
  engineVersion: SK_BUILD.engineVersion,
  status: "completed",
  errorCode: null,
  items: [],
  notRun: [],
  rawReport: { sha256: createHash("sha256").update(report).digest("hex"), bytes: report.length, contentBase64: report.toString("base64") },
});

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreIssuerKey = await useTestIssuerKey(db);
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, engines: { manifest: MANIFEST } });
  await app.ready();
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE engine_id IN ('skillscanner', 'mcpscanner') AND status IN ('queued', 'leased')`);
  admin = await makeUser(`l4s-admin-${RUN}@example.com`, true);
  alice = await makeUser(`l4s-alice-${RUN}@example.com`);

  const t = await inject("POST", "/v1/engines/skillscanner/enrollment-tokens", admin.key, { label: "l4s" });
  expect(t.statusCode, t.body).toBe(201);
  rig = await startEngineTaskRig({ app, db, issuer: ORIGIN, admin, manifest: MANIFEST, name: "l4s" });
  client = new RunnerClient({ gatewayUrl: "http://gateway.test", issuer: ORIGIN, http: runnerHttp });
  const selfTest = await buildSelfTest({
    ...SK_BUILD,
    requiredEnv: MANIFEST.skillscanner.usageDataEnv,
    env: { ...MANIFEST.skillscanner.usageDataEnv },
    egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
  });
  const reg = await client.register(t.json().token, generateRunnerSecret(), { name: `skillscanner-${RUN}`, ...SK_BUILD, selfTest });
  expect(reg.selfTest).toEqual({ passed: true, failures: [] });
  expect((await inject("POST", "/v1/engines/skillscanner/self-test", admin.key)).json().passed).toBe(true);
}, 180_000);

afterAll(async () => {
  await rig?.stop();
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup', target_subject_input_ciphertext = NULL WHERE engine_id IN ('skillscanner', 'mcpscanner') AND status IN ('queued', 'leased')`);
  await setEngine("skillscanner", false);
  await setEngine("mcpscanner", false);
  await db.execute(sql`UPDATE engines SET self_test = NULL, self_test_passed_at = NULL WHERE id IN ('skillscanner', 'mcpscanner')`);
  await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test suite finished' WHERE revoked_at IS NULL`);
  await restoreGates?.();
  await restoreIssuerKey?.();
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0242 L4.3 the subject target", () => {
  it("with the engine off (the default) a save queues nothing", async () => {
    await setEngine("skillscanner", false);
    const s = await saveSkill("Pad each column of the table.");
    expect(await runsOf(s.id)).toEqual([]);
  });

  it("a person cannot start an admission-scan run", async () => {
    const r = await inject("POST", "/v1/engine-runs", alice.key, { engineId: "skillscanner", target: { agentId: admin.id }, config: { sets: ["scan"] } });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("engine_target_mismatch");
  });

  it("save → queued (deduped) → lease (no key, the SKILL.md named) → placed task → result → the skill is held, the scan linked", async () => {
    await setEngine("skillscanner", true);
    const s = await saveSkill("Pad the columns of the table.");
    const queued = await runsOf(s.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued", trigger: "admission", targetKind: "subject", runAsUserId: null, projectId: null, targetSubjectDigest: s.contentDigest });
    // the same digest again: one live run, not two
    expect(await enqueueAdmissionScanRun(db, { kind: "builder_skill", id: s.id, digest: s.contentDigest })).toEqual({ kind: "duplicate" });

    const lease = await client.lease(SK_BUILD);
    expect(lease?.runId).toBe(queued[0]!.id);
    const md = Buffer.from(skillMarkdown(s.name, s.body));
    expect(lease!.target).toBeNull();
    expect(lease!.subject).toEqual({ file: "SKILL.md", sha256: createHash("sha256").update(md).digest("hex"), size: md.length });

    expect(await rig!.place(lease!.runId)).not.toBeNull();
    const status = await client.result(lease!.runId, envelope(lease!.runId, fixture("skillscanner-bad")));
    expect(status).toBe(200);

    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, lease!.runId));
    expect(run).toMatchObject({ status: "completed" });
    expect((run!.summary as { admission?: { verdict: string; state: string } }).admission).toMatchObject({ verdict: "fail", state: "held" });
    const [scan] = await db.select().from(admissionEngineScans).where(eq(admissionEngineScans.engineRunId, run!.id));
    expect(scan).toMatchObject({ builderSkillId: s.id, subjectDigest: s.contentDigest, verdict: "fail" });
    expect((await db.select().from(builderSkills).where(eq(builderSkills.id, s.id)))[0]!.admissionState).toBe("held");
    // a decisive scan exists: the same digest is not queued again
    expect(await enqueueAdmissionScanRun(db, { kind: "builder_skill", id: s.id, digest: s.contentDigest })).toEqual({ kind: "already_scanned" });
  });

  it("a superseded digest ends the run not_run at lease", async () => {
    await setEngine("skillscanner", true);
    const s = await saveSkill("Line up the table's rows.");
    const [queued] = await runsOf(s.id);
    // the skill's text changes underneath the queued run (a direct write: no new run is queued for it)
    await db.update(builderSkills).set({ body: "Something else.", contentDigest: "f".repeat(64) }).where(eq(builderSkills.id, s.id));
    expect(await client.lease(SK_BUILD)).toBeNull();
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, queued!.id));
    expect(run).toMatchObject({ status: "not_run", errorCode: "subject_superseded" });
    expect(await db.select().from(admissionEngineScans).where(eq(admissionEngineScans.engineRunId, queued!.id))).toEqual([]);
  });

  it("the database refuses a subject run that names a person, a project or another engine's subject", async () => {
    const s = await saveSkill("Sort the table.");
    const base: typeof engineRuns.$inferInsert = {
      engineId: "skillscanner",
      engineVersion: SK_BUILD.engineVersion,
      status: "cancelled",
      trigger: "admission",
      targetKind: "subject",
      targetBuilderSkillId: s.id,
      targetSubjectDigest: "a".repeat(64),
      config: { sets: ["scan"], params: {} },
      configHash: "x",
      trials: 1,
      budgetUsd: 0.01,
      timeoutSeconds: 60,
      queueExpiresAt: new Date(),
      finishedAt: new Date(),
    };
    await expect(db.insert(engineRuns).values({ ...base, runAsUserId: alice.id })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, engineId: "mcpscanner" })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, trigger: "manual" })).rejects.toThrow();
    await expect(db.insert(engineRuns).values({ ...base, targetSubjectDigest: "nothex" })).rejects.toThrow();
    await db.insert(engineRuns).values(base);
  });

  it("an MCP digest is queued with its snapshot encrypted; without a data key nothing is queued and the refusal is audited", async () => {
    await setEngine("mcpscanner", true);
    const tools = [{ name: "add", description: "adds two numbers", inputSchema: { type: "object" } }];
    const digest = manifestDigest(tools);
    const [srv] = await db
      .insert(mcpServers)
      .values({ name: `l4s-${RUN}-${randomBytes(3).toString("hex")}`, url: "http://127.0.0.1:9/mcp", admissionState: "held", admissionManifestDigest: digest, admissionFindings: [] })
      .returning({ id: mcpServers.id });
    const subject = { kind: "mcp_server" as const, id: srv!.id, digest };
    expect(await enqueueAdmissionScanRun(db, subject, { toolsCanonicalJson: "[]" })).toEqual({ kind: "refused", code: "input_mismatch" });
    setAdmissionScanRuntime({ dataKey: undefined });
    try {
      expect(await enqueueAdmissionScanRun(db, subject, { toolsCanonicalJson: manifestCanonicalJson(tools) })).toEqual({ kind: "refused", code: "no_data_key" });
    } finally {
      setAdmissionScanRuntime({ dataKey: DATA_KEY });
    }
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.objectId, srv!.id), eq(auditLog.ruleId, "admission-scan-not-queued")));
    expect(audit.length).toBe(2);
    const out = await enqueueAdmissionScanRun(db, subject, { toolsCanonicalJson: manifestCanonicalJson(tools) });
    expect(out.kind).toBe("queued");
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.targetMcpServerId, srv!.id));
    expect(run!.targetSubjectInputCiphertext).toBeTruthy();
    expect(run!.targetSubjectInputCiphertext).not.toContain("adds two numbers");
    // never returned by the API
    const listed = await inject("GET", `/v1/engine-runs/${run!.id}`, admin.key);
    if (listed.statusCode === 200) expect(listed.body).not.toContain("targetSubjectInputCiphertext");
    await db.update(engineRuns).set({ status: "cancelled", finishedAt: new Date(), targetSubjectInputCiphertext: null }).where(eq(engineRuns.id, run!.id));
    await setEngine("mcpscanner", false);
  });
});

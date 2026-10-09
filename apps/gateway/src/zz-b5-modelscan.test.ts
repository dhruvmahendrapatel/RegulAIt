/**
 * ADR-0187 B5-M — the modelscan shim against the REAL gateway on a real database: the upload, the
 * runner core (`runOnce`, `RunnerClient`) with the modelscan adapter fetching the artifact through
 * the gateway's runner route, and the scan record and evidence, with only modelscan itself replaced
 * by an executor answering what the pinned 0.8.8 answered for each fixture (the real engine runs in
 * packages/engine-modelscan, modelscan-real.test.ts, opt-in).
 *
 * Required proofs (ADR-0187 "Work split", G19): renamed pickle, legacy .pt, importlib pickle,
 * truncated pickle and nested zip never clean; engine error → unknown; cancel revokes (no key to
 * revoke for this engine: the run ends, the artifact stream and the result are refused). Egress
 * denied and budget spent do not apply: this engine has no network and no model access.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  artifactScans,
  auditLog,
  authSessions,
  createDb,
  desc,
  engineRuns,
  eq,
  modelArtifacts,
  modelCardEvidence,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { ARTIFACT_SCAN_CHIP, BATCH5_STRICT_DEFAULTS, ENGINE_MANIFEST, ENGINE_RESULT_VERSION, STEP_UP_HEADER, type EngineId, type EngineManifestEntry } from "@regulait/shared";
import { buildSelfTest, generateRunnerSecret, runOnce, RunnerClient, type RunnerHttp } from "@regulait/engine-runner";
import { modelscanAdapter, type ModelscanOutcome, type ScanExecutor, type ScanJob } from "@regulait/engine-modelscan";
import { cleanPickle, legacyTorchFile, maliciousPickle, nestedZip, safetensorsFile, truncatedMaliciousPickle } from "@regulait/engine-modelscan/fixtures";
import { buildApp } from "./app.js";
import { FileArtifactStore } from "./model-artifacts.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b5m-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const MS_DIGEST = `sha256:${"e".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = { ...ENGINE_MANIFEST, modelscan: { ...ENGINE_MANIFEST.modelscan, imageDigest: MS_DIGEST } };
const MS_BUILD = { imageDigest: MS_DIGEST, engineVersion: MANIFEST.modelscan.version };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let storeDir: string;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };
let alice: { id: string; key: { authorization: string } };
let bob: { id: string; key: { authorization: string } };
let client: RunnerClient;
let runnerSecret: string;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asAdmin = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.session.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const runnerHttp: RunnerHttp = async (url, init) => {
  const u = new URL(url);
  const r = await app.inject({ method: init.method as Method, url: u.pathname, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
  return { status: r.statusCode, json: async () => (r.body ? JSON.parse(r.body) : null) };
};
/** the adapter's artifact fetch, through the app */
const viaApp = async (url: string, init: { headers: Record<string, string> }) => {
  const r = await app.inject({ method: "GET", url: new URL(url).pathname, headers: init.headers });
  return new Response(r.statusCode === 200 ? new Uint8Array(r.rawPayload) : r.body, { status: r.statusCode });
};

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b5m" });
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

async function upload(who: { key: { authorization: string } }, bytes: Buffer, filename = "model.bin", contentType = "application/octet-stream") {
  return app.inject({ method: "POST", url: `/v1/model-artifacts?filename=${encodeURIComponent(filename)}`, headers: { ...who.key, "content-type": contentType }, payload: bytes });
}
async function uploaded(bytes: Buffer, filename = "model.bin"): Promise<{ id: string; format: string; sha256: string }> {
  const r = await upload(alice, bytes, filename);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().artifact;
}
async function startScan(artifactId: string, who: { key: { authorization: string } } = alice) {
  const r = await inject("POST", "/v1/engine-runs", who.key, { engineId: "modelscan", target: { artifactId }, config: { sets: ["scan"] } });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run.id as string;
}

/** an executor answering what the pinned 0.8.8 answered for the fixture (measured; see the package tests) */
function answering(a: { exitCode: number | null; report?: unknown; timedOut?: boolean }, onScan?: (job: ScanJob) => Promise<void>): ScanExecutor & { jobs: ScanJob[] } {
  const jobs: ScanJob[] = [];
  return {
    jobs,
    stage: async () => mkdtemp(path.join(tmpdir(), "b5m-gw-")),
    async scan(job): Promise<ModelscanOutcome> {
      jobs.push(job);
      await onScan?.(job);
      const bytes = a.report === undefined ? null : Buffer.from(JSON.stringify(a.report));
      return { exitCode: a.exitCode, timedOut: a.timedOut ?? false, cancelled: false, report: bytes, reportSha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null, reportTooLarge: false };
    },
    async release() {},
  };
}
function report(p: { scanned?: string[]; issues?: Array<{ module: string; operator: string; source: string }>; errors?: Array<{ category: string; source?: string }> }) {
  return {
    summary: {
      total_issues: (p.issues ?? []).length,
      modelscan_version: "0.8.8",
      scanned: (p.scanned ?? []).length ? { total_scanned: p.scanned!.length, scanned_files: p.scanned } : { total_scanned: 0 },
      skipped: { total_skipped: 0, skipped_files: [] },
    },
    issues: (p.issues ?? []).map((i) => ({ description: "d", operator: i.operator, module: i.module, source: i.source, scanner: "s", severity: "CRITICAL" })),
    errors: (p.errors ?? []).map((e) => ({ category: e.category, description: "d", ...(e.source ? { source: e.source } : {}) })),
  };
}
const osSystem = report({ scanned: ["artifact.pkl"], issues: [{ module: "os", operator: "system", source: "artifact.pkl" }] });

async function once(executor: ScanExecutor) {
  const adapter = modelscanAdapter({ gatewayUrl: "http://gateway.test", token: async () => runnerSecret, executor, fetch: viaApp });
  return runOnce(client, adapter, { ...MS_BUILD, engineId: "modelscan", workRoot: await mkdtemp(path.join(tmpdir(), "b5m-w-")), heartbeatMs: 25, retryBaseMs: 10 });
}
async function scanOf(runId: string) {
  const [s] = await db.select().from(artifactScans).where(eq(artifactScans.engineRunId, runId));
  return s;
}
async function scanned(bytes: Buffer, executor: ScanExecutor, filename?: string) {
  const a = await uploaded(bytes, filename);
  const runId = await startScan(a.id);
  const out = await once(executor);
  expect(out.runId).toBe(runId);
  const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
  return { artifact: a, runId, out, run: run!, scan: (await scanOf(runId))! };
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  storeDir = await mkdtemp(path.join(tmpdir(), "b5m-store-"));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64), engines: { manifest: MANIFEST }, artifactStore: new FileArtifactStore(storeDir) });
  await app.ready();
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE engine_id = 'modelscan' AND status IN ('queued', 'awaiting_approval')`);

  const a = await makeUser(`b5m-admin-${RUN}@example.com`, true);
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
  expect((await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "b5m" })).statusCode).toBe(201);
  alice = await makeUser(`b5m-alice-${RUN}@example.com`);
  bob = await makeUser(`b5m-bob-${RUN}@example.com`);

  // the runner registers with its self-test: the scanner's isolation switch judged true
  const t = await inject("POST", "/v1/engines/modelscan/enrollment-tokens", admin.key, { label: "b5m" });
  expect(t.statusCode, t.body).toBe(201);
  client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
  const selfTest = await buildSelfTest({
    ...MS_BUILD,
    requiredEnv: MANIFEST.modelscan.usageDataEnv,
    env: { ...MANIFEST.modelscan.usageDataEnv },
    egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
  });
  runnerSecret = generateRunnerSecret();
  const reg = await client.register(t.json().token, runnerSecret, { name: `modelscan-${RUN}`, ...MS_BUILD, selfTest });
  expect(reg.selfTest).toEqual({ passed: true, failures: [] });
  expect((await inject("POST", "/v1/engines/modelscan/self-test", admin.key)).json().passed).toBe(true);
  const refused = await asAdmin("PATCH", "/v1/engines/modelscan", { enabled: true, acceptCredentialIsolationRisk: true });
  expect(refused.statusCode, refused.body).toBe(403);
  const ok = await asAdmin("PATCH", "/v1/engines/modelscan", { enabled: true, acceptCredentialIsolationRisk: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(200);
}, 180_000);

afterAll(async () => {
  await forgetStepUpMethodsForTest(db, [admin?.id]);
  await db.execute(sql`UPDATE engines SET enabled = false, self_test = NULL, self_test_passed_at = NULL, max_budget_usd = 5, timeout_seconds = 1800, max_concurrent = 1`);
  await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test suite finished' WHERE revoked_at IS NULL`);
  await db.update(orgSettings).set({ ...BATCH5_STRICT_DEFAULTS }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreGates?.();
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

describe("B5-M upload: bounded, content-addressed, the format from the bytes, audited", () => {
  it("a pickle named .safetensors is stored as a pickle; the same bytes are stored once", async () => {
    const bytes = maliciousPickle();
    const r = await upload(alice, bytes, "../../model.safetensors");
    expect(r.statusCode, r.body).toBe(201);
    const a = r.json().artifact;
    expect(a).toMatchObject({ format: "pickle", executable: true, filename: "model.safetensors", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect((await stat(path.join(storeDir, "sha256", a.sha256))).size).toBe(bytes.length);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.objectId, a.id));
    expect(audit).toMatchObject({ ruleId: "model-artifact-uploaded", effect: "allow" });
    expect(audit!.detail).toMatchObject({ format: "pickle", declaredExtension: "safetensors", storedNew: true });
    const again = await upload(alice, bytes, "copy.pkl");
    expect(again.statusCode).toBe(201);
    const [audit2] = await db.select().from(auditLog).where(eq(auditLog.objectId, again.json().artifact.id));
    expect(audit2!.detail).toMatchObject({ storedNew: false });
  });

  it("refuses a body that is not application/octet-stream (415) and an upload over the limit (413, nothing kept, audited)", async () => {
    expect((await upload(alice, cleanPickle(), "x.pkl", "application/json")).json().error).toBe("artifact_content_type");
    const before = await db.select({ id: modelArtifacts.id }).from(modelArtifacts);
    await db.update(orgSettings).set({ modelArtifactMaxMegabytes: 1 }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const big = Buffer.alloc(1024 * 1024 + 1, 0x41);
      const r = await upload(alice, big, "big.bin");
      expect(r.statusCode, r.body).toBe(413);
      expect(r.json().error).toBe("artifact_too_large");
      // a streamed body with no declared length is cut off while it streams
      const chunked = await app.inject({
        method: "POST",
        url: "/v1/model-artifacts?filename=streamed.bin",
        headers: { ...alice.key, "content-type": "application/octet-stream" },
        payload: Readable.from([big.subarray(0, 600_000), big.subarray(600_000)]),
      });
      expect(chunked.statusCode, chunked.body).toBe(413);
      // exactly at the limit is accepted
      expect((await upload(alice, Buffer.alloc(1024 * 1024, 0x42), "edge.bin")).statusCode).toBe(201);
    } finally {
      await db.update(orgSettings).set({ modelArtifactMaxMegabytes: BATCH5_STRICT_DEFAULTS.modelArtifactMaxMegabytes }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    const after = await db.select({ id: modelArtifacts.id }).from(modelArtifacts);
    expect(after.length - before.length).toBe(1);
    const [refusal] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "model-artifact-upload-refused")).orderBy(desc(auditLog.at)).limit(1);
    expect(refusal).toMatchObject({ effect: "deny" });
  });

  it("raising the upload limit is a relaxation: it needs a step-up", async () => {
    const r = await asAdmin("PUT", "/v1/org/settings", { modelArtifactMaxMegabytes: 2048 });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("step_up_required");
    const lower = await asAdmin("PUT", "/v1/org/settings", { modelArtifactMaxMegabytes: 256 });
    expect(lower.statusCode, lower.body).toBe(200);
    await db.update(orgSettings).set({ modelArtifactMaxMegabytes: BATCH5_STRICT_DEFAULTS.modelArtifactMaxMegabytes }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("no store configured: nothing is accepted", async () => {
    const bare = buildApp(db, { bootstrapToken: BOOT, engines: { manifest: MANIFEST }, artifactStore: null });
    await bare.ready();
    try {
      const r = await bare.inject({ method: "POST", url: "/v1/model-artifacts", headers: { ...alice.key, "content-type": "application/octet-stream" }, payload: cleanPickle() });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe("artifact_store_unavailable");
    } finally {
      await bare.close();
    }
  });

  it("only the uploader (or an admin) sees an artifact or can scan it", async () => {
    const a = await uploaded(cleanPickle(), "mine.pkl");
    expect((await inject("GET", `/v1/model-artifacts/${a.id}`, bob.key)).statusCode).toBe(404);
    expect((await inject("GET", `/v1/model-artifacts/${a.id}`, alice.key)).statusCode).toBe(200);
    const r = await inject("POST", "/v1/engine-runs", bob.key, { engineId: "modelscan", target: { artifactId: a.id }, config: { sets: ["scan"] } });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("artifact_not_accessible");
  });
});

describe("B5-M through the real gateway: the lease, the stream, the scan record", () => {
  it("the lease carries the artifact and no key; the stream reaches only the live lease's runner; a finding is unsafe", async () => {
    const exec = answering({ exitCode: 1, report: osSystem });
    const { run, scan, out, artifact } = await scanned(maliciousPickle(), exec, "renamed.safetensors");
    expect(out).toMatchObject({ outcome: "posted", status: 200 });
    // no model access: no key was ever minted
    expect(run).toMatchObject({ status: "completed", virtualKeyId: null });
    expect(exec.jobs[0]).toMatchObject({ format: "pickle", artifactName: "artifact.pkl" });
    expect(scan).toMatchObject({ verdict: "unsafe", format: "pickle", artifactSha256: artifact.sha256, scannerVersion: "0.8.8" });
    const streamed = await db.select().from(auditLog).where(eq(auditLog.objectId, run.id));
    expect(streamed.map((x) => x.ruleId)).toContain("engine-run-artifact-streamed");
    // after the run ended, the runner cannot fetch it again
    const again = await app.inject({ method: "GET", url: `/v1/engine-runner/artifacts/${artifact.id}`, headers: { authorization: `Bearer ${runnerSecret}` } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("engine_artifact_not_leased");
    // a human credential cannot reach the runner route at all
    expect((await app.inject({ method: "GET", url: `/v1/engine-runner/artifacts/${artifact.id}`, headers: alice.key })).statusCode).toBe(401);
  });

  it("RED PROOFS: legacy .pt, importlib pickle, truncated pickle and nested zip are never clean", async () => {
    const legacy = await scanned(legacyTorchFile(), answering({ exitCode: 1, report: osSystem }), "model.pt");
    expect(legacy.artifact.format).toBe("pytorch_legacy");
    expect(legacy.scan.verdict).toBe("unsafe");
    const imp = await scanned(maliciousPickle("importlib", "import_module"), answering({ exitCode: 1, report: report({ scanned: ["artifact.pkl"], issues: [{ module: "importlib", operator: "import_module", source: "artifact.pkl" }] }) }));
    expect(imp.scan.verdict).toBe("unsafe");
    const trunc = await scanned(truncatedMaliciousPickle(), answering({ exitCode: 3, report: report({ errors: [{ category: "PICKLE_GENOPS", source: "artifact.pkl" }] }) }));
    expect(trunc.scan.verdict).toBe("unknown");
    const nested = await scanned(nestedZip(), answering({ exitCode: 3, report: report({ errors: [{ category: "NESTED_ZIP", source: "artifact.zip:inner.zip" }] }) }));
    expect(nested.artifact.format).toBe("zip_opaque");
    expect(nested.scan.verdict).toBe("unknown");
  });

  it("a clean pickle is no_known_unsafe (not admissible); a verified safetensors file is clean; the card chip never says safe", async () => {
    const pk = await scanned(cleanPickle(), answering({ exitCode: 0, report: report({ scanned: ["artifact.pkl"] }) }));
    expect(pk.scan.verdict).toBe("no_known_unsafe");
    expect(pk.scan.issues).toContainEqual({ kind: "executable_format", id: "pickle", severity: "high" });
    const st = await scanned(safetensorsFile(), answering({ exitCode: 0 }));
    expect(st.scan.verdict).toBe("clean");
    const view = await inject("GET", `/v1/model-artifacts/${st.artifact.id}`, alice.key);
    expect(view.json().scans[0]).toMatchObject({ verdict: "clean", admissible: true });
    const pkView = await inject("GET", `/v1/model-artifacts/${pk.artifact.id}`, alice.key);
    expect(pkView.json().scans[0]).toMatchObject({ verdict: "no_known_unsafe", admissible: false, chip: "No known-unsafe operator found (executable format)" });
    // engine_scan evidence on a model card
    const ag = await inject("POST", "/v1/agents", AUTH, { name: `b5m-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model: "b5m-model" });
    expect(ag.statusCode, ag.body).toBe(201);
    const card = await inject("POST", "/v1/mrm/cards", admin.key, { agentId: ag.json().id, intendedUse: `b5m model-artifact evidence ${RUN}` });
    expect(card.statusCode, card.body).toBe(201);
    const cardId = (card.json().card?.id ?? card.json().id) as string;
    const ev = await inject("POST", `/v1/mrm/cards/${cardId}/evidence`, admin.key, { kind: "engine_scan", artifactScanId: pk.scan.id });
    expect(ev.statusCode, ev.body).toBe(201);
    expect((await inject("POST", `/v1/mrm/cards/${cardId}/evidence`, admin.key, { kind: "engine_scan", artifactScanId: pk.scan.id })).statusCode).toBe(409);
    const [row] = await db.select().from(modelCardEvidence).where(eq(modelCardEvidence.id, ev.json().evidence.id));
    expect(row).toMatchObject({ kind: "engine_scan", artifactScanId: pk.scan.id });
    const shown = await inject("GET", `/v1/mrm/cards/${cardId}`, admin.key);
    expect(shown.statusCode, shown.body).toBe(200);
    const cited = (shown.json().card.evidence as Array<{ kind: string; artifactScan?: { chip: string; verdict: string; admissible: boolean } }>).find((e) => e.kind === "engine_scan");
    expect(cited?.artifactScan).toMatchObject({ verdict: "no_known_unsafe", admissible: false, chip: "No known-unsafe operator found (executable format)" });
    // no chip ever says "safe"
    for (const chip of Object.values(ARTIFACT_SCAN_CHIP)) expect(chip).not.toMatch(/\bsafe\b/i);
  });

  it("a runner that claims a format the gateway did not detect gets unknown, and the database refuses clean for anything but safetensors", async () => {
    const a = await uploaded(maliciousPickle(), "forged.bin");
    const runId = await startScan(a.id);
    const lease = await client.lease(MS_BUILD);
    expect(lease?.runId).toBe(runId);
    const status = await client.result(runId, {
      version: ENGINE_RESULT_VERSION,
      runId,
      engineId: "modelscan",
      engineVersion: "0.8.8",
      status: "completed",
      errorCode: null,
      items: [{ key: "format", sourceTaxonomy: { system: "regulait-artifact-format", id: "safetensors" }, mappedClass: null, severity: "low", attempts: 1, defeated: 0, verdict: "pass", reason: null, dispatchAuditIds: [] }],
      notRun: [{ key: "modelscan/scan", reason: "unsupported_format" }],
      rawReport: null,
    });
    expect(status).toBe(200);
    expect((await scanOf(runId))!.verdict).toBe("unknown");
    const refused = await db
      .insert(artifactScans)
      .values({ artifactId: a.id, artifactSha256: a.sha256, format: "pickle", verdict: "clean", scannerVersion: "0.8.8" })
      .then(() => null, (e: { cause?: { constraint?: string } }) => e.cause?.constraint ?? "other");
    expect(refused).toBe("artifact_scans_clean_format_check");
  });

  it("RED PROOF engine error → unknown: modelscan exits 4, or writes no report", async () => {
    for (const a of [{ exitCode: 4, report: report({}) }, { exitCode: 0 }]) {
      const r = await scanned(cleanPickle(), answering(a));
      expect(r.run.status).toBe("failed");
      expect(r.scan.verdict).toBe("unknown");
    }
  });

  it("RED PROOF cancel ends the run (no key exists to revoke): the stream, the heartbeat and the result are refused", async () => {
    const a = await uploaded(cleanPickle(), "cancel.pkl");
    const runId = await startScan(a.id);
    let afterCancel: { stream: number; status: number } | null = null;
    const exec = answering({ exitCode: 0, report: report({ scanned: ["artifact.pkl"] }) }, async () => {
      const c = await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, { reason: "stop" });
      expect(c.statusCode, c.body).toBe(200);
      const s = await app.inject({ method: "GET", url: `/v1/engine-runner/artifacts/${a.id}`, headers: { authorization: `Bearer ${runnerSecret}` } });
      afterCancel = { stream: s.statusCode, status: 0 };
      // the scanner keeps going until the runner's heartbeat delivers the cancel
      await new Promise((r) => setTimeout(r, 120));
    });
    const out = await once(exec);
    expect(afterCancel).toMatchObject({ stream: 409 });
    expect(["cancelled", "posted"]).toContain(out.outcome);
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", virtualKeyId: null });
    expect((await scanOf(runId))!.verdict).toBe("unknown");
    const hb = await client.heartbeat(runId, "running", 0.5);
    expect(hb.cancel).toBe(true);
  });
});

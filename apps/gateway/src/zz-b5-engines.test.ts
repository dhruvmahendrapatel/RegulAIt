/**
 * ADR-0187 B5-F + B5-E — the sidecar engine foundation and runner core, on a
 * real database through the real app, driven the way a runner drives it
 * (enrolment token → register → lease → model calls on the run's key →
 * heartbeat → result) and the way a person does (start, cancel, approve).
 *
 * What it pins (each one shown red against the defect it guards, see the
 * ADR-0187 implementation decisions):
 *   - every engine starts off; enabling needs a fresh passing self-test AND a
 *     settings_relax step-up; a disabled engine cannot be leased;
 *   - the self-test fails when the egress probe resolved or connected;
 *   - a runner token reaches only its route allow-list, and the runner routes
 *     refuse every other credential;
 *   - the run-scoped key: compat routes only, pinned to the run's project,
 *     revoked on result, on cancel and by the timeout sweep, and at once when
 *     its budget is spent (401 mid-run);
 *   - not-clean semantics: an engine error makes every item unknown, an
 *     egress-denied item is not run, neither ever passes, and nothing that did
 *     not complete reaches the red-team / eval ledgers;
 *   - engine text is scrubbed before it reaches redteam_runs / eval_runs, and a
 *     scrub that throws fails the item closed;
 *   - approvals for sensitive sets, scheduled runs as their creator, and the
 *     workflow automated_check binding.
 *
 * Run on its own scratch database (the evidence tables are append-only); the
 * runner drops it afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  engineRunItems,
  engineRuns,
  engineSchedules,
  eq,
  evalRuns,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  orgSettings,
  ORG_SETTINGS_ID,
  redteamProbeTrials,
  redteamRuns,
  runMigrations,
  sql,
  usageEvents,
  users,
  virtualKeys,
  type Db,
} from "@regulait/db";
import {
  BATCH5_STRICT_DEFAULTS,
  ENGINE_MANIFEST,
  ENGINE_RESULT_VERSION,
  STEP_UP_HEADER,
  type EngineId,
  type EngineManifestEntry,
  type EngineTaxonomy,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";
import { engineRunTestHooks, runEngineRunSweep, runEngineScheduleSweep } from "./engine-runs.js";
import { setEngineDetectionScrub } from "./engine-scrub.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b5-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "e".repeat(64);
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

// a manifest whose promptfoo and garak images are "built" (synthetic digests)
const PF_DIGEST = `sha256:${"a".repeat(64)}`;
const GK_DIGEST = `sha256:${"b".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = {
  ...ENGINE_MANIFEST,
  promptfoo: { ...ENGINE_MANIFEST.promptfoo, imageDigest: PF_DIGEST, sets: { basic: "standard", agentic: "agentic" } },
  garak: { ...ENGINE_MANIFEST.garak, imageDigest: GK_DIGEST, sets: { basic: "standard" } },
};
const TAXONOMY: EngineTaxonomy = {
  version: 7,
  entries: [
    { system: "promptfoo", id: "prompt-injection", attackClass: "prompt_injection", scorerKind: null },
    { system: "promptfoo", id: "pii", attackClass: "pii_leak", scorerKind: null },
    { system: "promptfoo", id: "jailbreak", attackClass: "jailbreak", scorerKind: null },
  ],
};

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;
let priorInterception: { anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean } | null = null;
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };
let alice: { id: string; key: { authorization: string } };
let approver: { id: string; key: { authorization: string } };
let targetId: string;
let judgeId: string;
let otherAgentId: string;
let projectId: string;
let otherProjectId: string;
let pfRunner: Awaited<ReturnType<typeof enrol>>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asAdmin = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    headers: { ...CSRF, ...headers },
    cookies: { regulait_session: admin.session.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b5" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, model: string) {
  const r = await inject("POST", "/v1/agents", AUTH, { name, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

function selfTest(digest: string, version: string, over: Partial<{ dnsResolved: boolean; connected: boolean; addressConnected: boolean; env: Record<string, boolean> }> = {}) {
  return {
    imageDigest: digest,
    engineVersion: version,
    // every switch any engine's manifest names, each at its required value
    usageDataEnv: over.env ?? Object.fromEntries(Object.values(MANIFEST).flatMap((m) => Object.keys(m.usageDataEnv)).map((k) => [k, true])),
    egress: {
      host: "registry.example.invalid",
      dnsResolved: over.dnsResolved ?? false,
      connected: over.connected ?? false,
      // a public literal address (IANA's example.com), probed with no resolver
      address: "93.184.215.14",
      addressConnected: over.addressConnected ?? false,
    },
    at: new Date().toISOString(),
  };
}

async function enrol(engineId: EngineId, digest: string, version: string, over: Parameters<typeof selfTest>[2] = {}) {
  const t = await inject("POST", `/v1/engines/${engineId}/enrollment-tokens`, admin.key, { label: "test" });
  expect(t.statusCode, t.body).toBe(201);
  const enrolment = { authorization: `Bearer ${t.json().token}` };
  // PR #205 review [54]: the runner generates its own token and registers only its hash
  const token = runnerSecret();
  const r = await inject("POST", "/v1/engine-runner/register", enrolment, {
    name: `${engineId}-runner-${randomBytes(2).toString("hex")}`,
    imageDigest: digest,
    engineVersion: version,
    selfTest: selfTest(digest, version, over),
    tokenHash: sha256Hex(token),
  });
  expect(r.statusCode, r.body).toBe(201);
  expect(r.json().token).toBeUndefined();
  return { id: r.json().runnerId as string, token, auth: { authorization: `Bearer ${token}` }, enrolment, selfTest: r.json().selfTest };
}

/** a runner's own token, as the runner core generates it (`rge_` + 256 random bits) */
function runnerSecret(): string {
  return `rge_${randomBytes(32).toString("hex")}`;
}
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function enableEngine(engineId: EngineId) {
  const st = await inject("POST", `/v1/engines/${engineId}/self-test`, admin.key);
  expect(st.statusCode, st.body).toBe(200);
  expect(st.json().passed, st.body).toBe(true);
  const refused = await asAdmin("PATCH", `/v1/engines/${engineId}`, { enabled: true, acceptCredentialIsolationRisk: true });
  expect(refused.statusCode, refused.body).toBe(403);
  const token = await grantFor(refused.json().action);
  const ok = await asAdmin("PATCH", `/v1/engines/${engineId}`, { enabled: true, acceptCredentialIsolationRisk: true }, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(200);
  expect(ok.json().enabled).toBe(true);
}

async function startRun(body: Record<string, unknown>, who = alice.key) {
  return inject("POST", "/v1/engine-runs", who, {
    engineId: "promptfoo",
    target: { agentId: targetId, judgeAgentId: judgeId },
    config: { sets: ["basic"] },
    projectId,
    budgetUsd: 1,
    trials: 3,
    ...body,
  });
}

const PF_BUILD = () => ({ imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version });
async function lease(runner = pfRunner) {
  const r = await inject("POST", "/v1/engine-runner/lease", runner.auth, PF_BUILD());
  return r;
}

/** start a run and lease it (the only queued promptfoo run) */
async function startAndLease(body: Record<string, unknown> = {}) {
  const s = await startRun(body);
  expect(s.statusCode, s.body).toBe(202);
  const l = await lease();
  expect(l.statusCode, l.body).toBe(200);
  expect(l.json().runId).toBe(s.json().run.id);
  return l.json() as {
    runId: string;
    target: { baseUrl: string; model: string; apiKey: string; headers: Record<string, string> };
    judge: { model: string; headers: Record<string, string> } | null;
    deadlineAt: string;
  };
}

function chatOn(key: string, headers: Record<string, string>, model = "b5-target-model") {
  return inject("POST", "/v1/chat/completions", { authorization: `Bearer ${key}`, ...headers }, {
    model,
    messages: [{ role: "user", content: "hello" }],
  });
}

function envelope(runId: string, over: Record<string, unknown> = {}) {
  return {
    version: ENGINE_RESULT_VERSION,
    runId,
    engineId: "promptfoo",
    engineVersion: MANIFEST.promptfoo.version,
    status: "completed",
    items: [],
    notRun: [],
    rawReport: null,
    ...over,
  };
}

function item(key: string, sourceId: string, over: Record<string, unknown> = {}) {
  return {
    key,
    sourceTaxonomy: { system: "promptfoo", id: sourceId },
    mappedClass: null,
    severity: "high",
    attempts: 3,
    defeated: 0,
    verdict: "pass",
    reason: null,
    dispatchAuditIds: [],
    ...over,
  };
}

const postResult = (runId: string, body: unknown, runner = pfRunner) => inject("POST", `/v1/engine-runner/runs/${runId}/result`, runner.auth, body);

async function runRow(runId: string) {
  const [r] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
  return r!;
}
async function keyOf(runId: string) {
  const r = await runRow(runId);
  const [k] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, r.virtualKeyId!));
  return k!;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    dispatchAttributionRequired: false,
    useCaseGateMode: "off",
  });
  app = buildApp(db, {
    bootstrapToken: BOOT,
    dataKey: DATA_KEY,
    engines: { manifest: MANIFEST, taxonomy: TAXONOMY, gatewayBaseUrl: "http://gateway.test/v1" },
  });
  await app.ready();
  const [prior] = await db.select().from(interceptionSettings).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  priorInterception = prior ? { anthropicCompatEnabled: prior.anthropicCompatEnabled, openaiCompatEnabled: prior.openaiCompatEnabled } : null;
  const s = await inject("PUT", "/v1/interception/settings", AUTH, { anthropicCompatEnabled: true, openaiCompatEnabled: true });
  expect(s.statusCode, s.body).toBe(200);

  // the admin: a browser session and a passkey, so a relaxation can be stepped up the real way
  const a = await makeUser(`b5-admin-${RUN}@example.com`, true);
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
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "b5" });
  expect(reg.statusCode, reg.body).toBe(201);

  alice = await makeUser(`b5-alice-${RUN}@example.com`);
  approver = await makeUser(`b5-approver-${RUN}@example.com`);
  targetId = await makeAgent(`b5-target-${RUN}`, "b5-target-model");
  judgeId = await makeAgent(`b5-judge-${RUN}`, "b5-judge-model");
  otherAgentId = await makeAgent(`b5-other-${RUN}`, "b5-other-model");
  for (const agentId of [targetId, judgeId, otherAgentId]) {
    const g = await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId });
    expect(g.statusCode, g.body).toBe(201);
  }
  const p = await inject("POST", "/v1/projects", AUTH, { name: `b5-project-${RUN}` });
  expect(p.statusCode, p.body).toBe(201);
  projectId = p.json().id;
  const p2 = await inject("POST", "/v1/projects", AUTH, { name: `b5-other-project-${RUN}` });
  expect(p2.statusCode, p2.body).toBe(201);
  otherProjectId = p2.json().id;
}, 180_000);

afterAll(async () => {
  setEngineDetectionScrub((await import("@regulait/shared")).scrubAuditText);
  // M-068 / B4S-06: global state goes back before the suite ends — the compat
  // surfaces, the admin's passkey (an admin with a step-up method changes what
  // the bootstrap credential may do in every later suite), and the engines.
  if (priorInterception) {
    await db.update(interceptionSettings).set(priorInterception).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  }
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

// ===========================================================================
describe("secure by default", () => {
  it("every engine starts off, and every engine org setting reads strict", async () => {
    const r = await inject("GET", "/v1/engines", alice.key);
    expect(r.statusCode, r.body).toBe(200);
    const list = r.json().engines as Array<{ id: string; enabled: boolean; maxConcurrent: number; signature: string }>;
    expect(list.map((e) => e.id).sort()).toEqual(["garak", "modelscan", "promptfoo"]);
    expect(list.every((e) => e.enabled === false && e.maxConcurrent === 1)).toBe(true);
    // the shipped manifest has no modelscan image: nothing can enable it
    expect(list.find((e) => e.id === "modelscan")!.signature).toBe("not_built");
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect({
      engineMaxRunTimeoutMinutes: org!.engineMaxRunTimeoutMinutes,
      engineDefaultRunBudgetUsd: org!.engineDefaultRunBudgetUsd,
      engineRunApprovalThresholdUsd: org!.engineRunApprovalThresholdUsd,
      engineRawReportRetentionDays: org!.engineRawReportRetentionDays,
      engineSensitiveSetApproval: org!.engineSensitiveSetApproval,
      // B5-M (migration 0175)
      modelArtifactMaxMegabytes: org!.modelArtifactMaxMegabytes,
      // ADR-0187 decision 127 (migration 0176)
      modelArtifactUploaderQuotaMegabytes: org!.modelArtifactUploaderQuotaMegabytes,
      modelArtifactUploaderQuotaCount: org!.modelArtifactUploaderQuotaCount,
      modelArtifactOrgQuotaMegabytes: org!.modelArtifactOrgQuotaMegabytes,
      modelArtifactOrgQuotaCount: org!.modelArtifactOrgQuotaCount,
      modelArtifactRetentionDays: org!.modelArtifactRetentionDays,
    }).toEqual(BATCH5_STRICT_DEFAULTS);
  });

  it("relaxing an engine org setting needs a settings_relax step-up", async () => {
    const r = await asAdmin("PUT", "/v1/org/settings", { engineSensitiveSetApproval: false });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const longer = await asAdmin("PUT", "/v1/org/settings", { engineMaxRunTimeoutMinutes: 60 });
    expect(longer.statusCode, longer.body).toBe(403);
    // tightening needs nothing
    const tighter = await asAdmin("PUT", "/v1/org/settings", { engineMaxRunTimeoutMinutes: 20 });
    expect(tighter.statusCode, tighter.body).toBe(200);
    // back to the default is now a loosening against the stored value
    const back = await asAdmin("PUT", "/v1/org/settings", { engineMaxRunTimeoutMinutes: 30 });
    expect(back.statusCode, back.body).toBe(403);
    await db.update(orgSettings).set({ engineMaxRunTimeoutMinutes: 30 }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("enabling with no passing self-test is refused, even with a step-up", async () => {
    const r = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("engine_self_test_required");
  });

  it("the self-test fails when the egress probe resolved or connected, or a switch is missing", async () => {
    const leaky = await enrol("promptfoo", PF_DIGEST, MANIFEST.promptfoo.version, { dnsResolved: true });
    expect(leaky.selfTest).toMatchObject({ passed: false, failures: ["egress_dns_resolved"] });
    const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(st.json()).toMatchObject({ passed: false, failures: ["egress_dns_resolved"] });
    const connected = await enrol("promptfoo", PF_DIGEST, MANIFEST.promptfoo.version, { connected: true });
    expect(connected.selfTest.failures).toContain("egress_connected");
    const noSwitch = await enrol("promptfoo", PF_DIGEST, MANIFEST.promptfoo.version, { env: { PROMPTFOO_DISABLE_TELEMETRY: true } });
    expect(noSwitch.selfTest.failures).toContain("usage_env_missing:PROMPTFOO_DISABLE_UPDATE");
    // PR #205 review round 12 [91]: an image that is not the current build is not registered at all
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: "wrong-build" });
    const wrongDigest = `sha256:${"c".repeat(64)}`;
    const wrong = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${t.json().token}` }, {
      name: "wrong-build",
      imageDigest: wrongDigest,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: selfTest(wrongDigest, MANIFEST.promptfoo.version, {}),
      tokenHash: sha256Hex(runnerSecret()),
    });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json().error).toBe("engine_runner_build_obsolete");
    // a runner whose self-test failed leases nothing (the engine is off anyway; checked again below)
    for (const r of [leaky, connected, noSwitch]) {
      const d = await inject("DELETE", `/v1/engine-runners/${r.id}`, admin.key);
      expect(d.statusCode, d.body).toBe(200);
    }
  });

  it("enabling after a passing self-test still needs the step-up, bound to that change", async () => {
    pfRunner = await enrol("promptfoo", PF_DIGEST, MANIFEST.promptfoo.version);
    expect(pfRunner.selfTest).toMatchObject({ passed: true, failures: [] });
    const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(st.json().passed, st.body).toBe(true);
    // an API key can never give a step-up
    const viaKey = await inject("PATCH", "/v1/engines/promptfoo", admin.key, { enabled: true, acceptCredentialIsolationRisk: true });
    expect(viaKey.statusCode, viaKey.body).toBe(403);
    expect(viaKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action).toEqual({ kind: "settings_relax", body: { values: { "engine.promptfoo.enabled": true, "engine.promptfoo.acceptCredentialIsolationRisk": true } } });
    const [still] = await db.execute(sql`SELECT enabled FROM engines WHERE id = 'promptfoo'`).then((r) => (r as unknown as { rows: Array<{ enabled: boolean }> }).rows);
    expect(still!.enabled).toBe(false);
    const token = await grantFor(refused.json().action);
    const ok = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().enabled).toBe(true);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "engine-updated")).orderBy(desc(auditLog.seq)).limit(1);
    expect(audit!.detail).toMatchObject({ engineId: "promptfoo", transitions: { enabled: { from: false, to: true } } });
    // switching it off needs nothing (tightening)
  });
});

// ===========================================================================
describe("runner credentials", () => {
  it("a runner token reaches only its route allow-list", async () => {
    for (const [method, url] of [
      ["GET", "/v1/engines"],
      ["GET", "/v1/me"],
      ["POST", "/v1/engine-runs"],
      ["GET", "/v1/engine-runs"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/engine-runner/register"],
      ["GET", "/v1/audit"],
    ] as const) {
      const r = await inject(method, url, pfRunner.auth, method === "POST" ? {} : undefined);
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(403);
      expect(r.json().error, `${method} ${url}`).toBe("engine_runner_scope");
    }
  });

  it("the runner routes refuse every other credential, and an enrolment token works once", async () => {
    for (const cred of [alice.key, admin.key, AUTH]) {
      const r = await inject("POST", "/v1/engine-runner/lease", cred);
      expect(r.statusCode, r.body).toBe(401);
      expect(r.json().error).toBe("engine_runner_token_required");
    }
    const viaSession = await asAdmin("POST", "/v1/engine-runner/lease");
    expect(viaSession.statusCode, viaSession.body).toBe(401);
    // an enrolment token is not a runner token
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, {});
    const enrolment = { authorization: `Bearer ${t.json().token}` };
    const asLease = await inject("POST", "/v1/engine-runner/lease", enrolment);
    expect(asLease.statusCode).toBe(403);
    expect(asLease.json().error).toBe("engine_runner_scope");
    const secret = runnerSecret();
    const body = { name: "once", imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: selfTest(PF_DIGEST, MANIFEST.promptfoo.version), tokenHash: sha256Hex(secret) };
    const first = await inject("POST", "/v1/engine-runner/register", enrolment, body);
    expect(first.statusCode, first.body).toBe(201);
    // PR #205 review [54]: a second registration with the spent token mints nothing: the SAME
    // hash replays the same runner, any other hash is refused
    const replayed = await inject("POST", "/v1/engine-runner/register", enrolment, body);
    expect(replayed.statusCode, replayed.body).toBe(201);
    expect(replayed.json()).toMatchObject({ runnerId: first.json().runnerId, replayed: true });
    const second = await inject("POST", "/v1/engine-runner/register", enrolment, { ...body, tokenHash: sha256Hex(runnerSecret()) });
    expect(second.statusCode, second.body).toBe(401);
    expect(second.json().error).toBe("engine_enrollment_invalid");
    // a revoked runner token authenticates nothing
    const d = await inject("DELETE", `/v1/engine-runners/${first.json().runnerId}`, admin.key);
    expect(d.statusCode).toBe(200);
    const after = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${secret}` });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("engine_runner_revoked");
  });

  it("a runner or enrolment token cannot be exchanged for a browser session (no-user = bootstrap admin)", async () => {
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, {});
    for (const token of [pfRunner.token, t.json().token as string]) {
      const r = await app.inject({ method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: token } });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("credential_not_exchangeable");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("a disabled engine cannot be leased or started", async () => {
    const gk = await enrol("garak", GK_DIGEST, MANIFEST.garak.version);
    expect(gk.selfTest.passed).toBe(true);
    const l = await inject("POST", "/v1/engine-runner/lease", gk.auth, { imageDigest: GK_DIGEST, engineVersion: MANIFEST.garak.version });
    expect(l.statusCode, l.body).toBe(409);
    expect(l.json().error).toBe("engine_disabled");
    const s = await inject("POST", "/v1/engine-runs", alice.key, { engineId: "garak", target: { agentId: targetId }, config: { sets: ["basic"] }, projectId });
    expect(s.statusCode, s.body).toBe(409);
    expect(s.json().error).toBe("engine_disabled");
    // a run queued while promptfoo was on is not leased once it is switched off — PR #205 review
    // round 10 [84]: switching it off ends the run (cancelled `engine_disabled`, audited)
    const queued = await startRun({});
    expect(queued.statusCode, queued.body).toBe(202);
    const off = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(await runRow(queued.json().run.id)).toMatchObject({ status: "cancelled", errorCode: "engine_disabled" });
    const blocked = await lease();
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().error).toBe("engine_disabled");
    await enableEngine("promptfoo");
  });
});

// ===========================================================================
describe("a run's key and its lifecycle", () => {
  it("lease mints the run-scoped key: compat routes only, project-pinned, target and judge only", async () => {
    const l = await startAndLease();
    expect(l.target.baseUrl).toBe("http://gateway.test/v1");
    expect(l.target.headers["x-regulait-project-id"]).toBe(projectId);
    const k = await keyOf(l.runId);
    expect(k).toMatchObject({ purpose: "engine", userId: alice.id, projectId, engineRunId: l.runId, budgetUsd: 1 });
    expect(k.allowedModels).toEqual([targetId, judgeId]);
    expect(k.expiresAt!.toISOString()).toBe(l.deadlineAt);
    // the model call works through the gateway, attributed to the run
    const ok = await chatOn(l.target.apiKey, l.target.headers);
    expect(ok.statusCode, ok.body).toBe(200);
    const [usage] = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    expect(usage!.projectId).toBe(projectId);
    expect(usage!.detail).toMatchObject({ purpose: "engine:promptfoo", engineRunId: l.runId });
    // an unattributed call is attributed to the pin
    const unattributed = await chatOn(l.target.apiKey, { "x-regulait-agent-id": targetId });
    expect(unattributed.statusCode, unattributed.body).toBe(200);
    // another project is refused
    const other = await chatOn(l.target.apiKey, { ...l.target.headers, "x-regulait-project-id": otherProjectId });
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error?.code ?? other.json().error).toMatch(/virtual_key_project_mismatch/);
    // an agent outside the key's allow-list is refused
    const notAllowed = await chatOn(l.target.apiKey, { "x-regulait-agent-id": otherAgentId, "x-regulait-project-id": projectId }, "b5-other-model");
    expect(notAllowed.statusCode, notAllowed.body).toBe(403);
    // only the compat model routes
    for (const [method, url] of [
      ["GET", "/v1/me"],
      ["GET", "/v1/engines"],
      ["POST", `/v1/agents/${targetId}/invoke`],
      ["POST", "/v1/virtual-keys"],
    ] as const) {
      const r = await inject(method, url, { authorization: `Bearer ${l.target.apiKey}` }, method === "POST" ? {} : undefined);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error).toBe("virtual_key_scope");
    }
    // nobody edits it, not even an admin
    const patch = await inject("PATCH", `/v1/virtual-keys/${k.id}`, admin.key, { budgetUsd: 100 });
    expect(patch.statusCode, patch.body).toBe(409);
    // heartbeat
    const hb = await inject("POST", `/v1/engine-runner/runs/${l.runId}/heartbeat`, pfRunner.auth, { phase: "running", progress: 0.5 });
    expect(hb.statusCode, hb.body).toBe(200);
    expect(hb.json().cancel).toBe(false);
    // the result: the server decides every verdict and total
    const res = await postResult(
      l.runId,
      envelope(l.runId, {
        items: [
          item("pi-1", "prompt-injection", { mappedClass: "jailbreak" }),
          // claims pass, but a defeat happened: it fails
          item("pii-1", "pii", { defeated: 1 }),
          // unmapped: reported, counts toward nothing
          item("misc-1", "something-unmapped"),
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "completed", verdict: "fail", counts: { pass: 2, fail: 1, unknown: 0, not_run: 0 } });
    const run = await runRow(l.runId);
    expect(run.status).toBe("completed");
    expect(run.summary).toMatchObject({ mappedItems: 2, unmappedItems: 1, taxonomyVersion: 7 });
    // the key is revoked: later calls get 401
    const after = await chatOn(l.target.apiKey, l.target.headers);
    expect(after.statusCode, after.body).toBe(401);
    // the ledgers: the server's own counts, mapped items only, the taxonomy's class (not the claim)
    const [rt] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, run.redteamRunId!));
    expect(rt).toMatchObject({ probes: 2, defeated: 1, asrTrials: 6, measurementQuality: "low-power", trials: 3, agentId: targetId });
    const trials = await db.select().from(redteamProbeTrials).where(eq(redteamProbeTrials.runId, rt!.id));
    expect(trials).toHaveLength(6);
    expect(new Set(trials.map((t) => t.attackClass))).toEqual(new Set(["prompt_injection", "pii_leak"]));
    const [ev] = await db.select().from(evalRuns).where(eq(evalRuns.id, run.evalRunId!));
    expect(ev).toMatchObject({ status: "completed", configHash: run.agentConfigHash, judgeImpl: `engine:promptfoo@${MANIFEST.promptfoo.version}` });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, l.runId));
    expect(items.find((i) => i.key === "pi-1")).toMatchObject({ attackClass: "prompt_injection", claimedClass: "jailbreak", verdict: "pass" });
    expect(items.find((i) => i.key === "misc-1")).toMatchObject({ attackClass: null, verdict: "pass" });
    // a second result is late
    const again = await postResult(l.runId, envelope(l.runId));
    expect(again.statusCode).toBe(409);
  });

  it("an engine error makes every item unknown — never pass — and reaches no ledger", async () => {
    const l = await startAndLease();
    const res = await postResult(
      l.runId,
      envelope(l.runId, { status: "failed", errorCode: "engine_crashed", items: [item("pi-err", "prompt-injection"), item("pii-err", "pii")] }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", verdict: "unknown", counts: { pass: 0, unknown: 2 } });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, l.runId));
    expect(items.map((i) => i.verdict)).toEqual(["unknown", "unknown"]);
    expect(items.every((i) => i.claimedVerdict === "pass")).toBe(true);
    const run = await runRow(l.runId);
    expect(run).toMatchObject({ status: "failed", errorCode: "engine_crashed", redteamRunId: null, evalRunId: null });
    expect((await keyOf(l.runId)).revokedAt).not.toBeNull();
  });

  it("egress denied makes the item not_run — never pass", async () => {
    const l = await startAndLease();
    const res = await postResult(
      l.runId,
      envelope(l.runId, {
        items: [item("pi-ok", "prompt-injection"), item("pi-egress", "prompt-injection")],
        notRun: [{ key: "pi-egress", reason: "egress_denied" }, { key: "cloud-thing", reason: "cloud_only" }],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, l.runId));
    expect(items.find((i) => i.key === "pi-egress")).toMatchObject({ verdict: "not_run", notRunReason: "egress_denied", claimedVerdict: "pass" });
    expect(items.find((i) => i.key === "cloud-thing")).toMatchObject({ verdict: "not_run", notRunReason: "cloud_only" });
    // the not-run probe is in no denominator: one measured probe, three trials
    const run = await runRow(l.runId);
    const [rt] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, run.redteamRunId!));
    expect(rt).toMatchObject({ probes: 1, asrTrials: 3, notRunProbes: 1 });
  });

  it("an invalid envelope fails the run and nothing of it counts", async () => {
    const l = await startAndLease();
    const res = await postResult(l.runId, { ...envelope(l.runId), items: [{ key: "x" }] });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toBe("engine_result_invalid");
    const run = await runRow(l.runId);
    expect(run).toMatchObject({ status: "failed", errorCode: "result_invalid", redteamRunId: null });
    expect((run.summary as { verdict: string }).verdict).toBe("unknown");
    expect((await keyOf(l.runId)).revokedAt).not.toBeNull();
  });

  it("cancel revokes the key at once; the runner learns on its next heartbeat; a late result is refused", async () => {
    const l = await startAndLease();
    expect((await chatOn(l.target.apiKey, l.target.headers)).statusCode).toBe(200);
    const c = await inject("POST", `/v1/engine-runs/${l.runId}/cancel`, alice.key, { reason: "wrong target" });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().run.status).toBe("cancelled");
    const after = await chatOn(l.target.apiKey, l.target.headers);
    expect(after.statusCode, after.body).toBe(401);
    expect(after.json().error?.code ?? after.json().error).toMatch(/virtual_key_revoked/);
    const hb = await inject("POST", `/v1/engine-runner/runs/${l.runId}/heartbeat`, pfRunner.auth, { phase: "running", progress: 0.6 });
    expect(hb.json()).toMatchObject({ cancel: true, status: "cancelled" });
    const late = await postResult(l.runId, envelope(l.runId, { items: [item("pi", "prompt-injection")] }));
    expect(late.statusCode).toBe(409);
    expect((await runRow(l.runId)).status).toBe("cancelled");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "engine-run-key-revoked"), eq(auditLog.objectId, (await runRow(l.runId)).virtualKeyId!)));
    expect(audits).toHaveLength(1);
  });

  it("the timeout sweep ends an overdue run and revokes its key", async () => {
    const l = await startAndLease();
    expect((await chatOn(l.target.apiKey, l.target.headers)).statusCode).toBe(200);
    // the deadline passes (the key's own expiry is pushed out so only the sweep can stop it)
    await db.update(engineRuns).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(engineRuns.id, l.runId));
    await db.update(virtualKeys).set({ expiresAt: new Date(Date.now() + 3_600_000) }).where(eq(virtualKeys.id, (await runRow(l.runId)).virtualKeyId!));
    const out = await runEngineRunSweep(db);
    expect(out.timedOut).toBeGreaterThanOrEqual(1);
    const run = await runRow(l.runId);
    expect(run).toMatchObject({ status: "timeout", errorCode: "deadline_passed" });
    expect((await chatOn(l.target.apiKey, l.target.headers)).statusCode).toBe(401);
    // an expired lease (no heartbeat) ends the same way
    const l2 = await startAndLease();
    await db.update(engineRuns).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(engineRuns.id, l2.runId));
    await runEngineRunSweep(db);
    expect(await runRow(l2.runId)).toMatchObject({ status: "timeout", errorCode: "lease_expired" });
    expect((await keyOf(l2.runId)).revokedAt).not.toBeNull();
  });

  it("a spent budget revokes the key: the next call of the run is 401", async () => {
    const l = await startAndLease({ budgetUsd: 0.000001 });
    const first = await chatOn(l.target.apiKey, l.target.headers);
    expect(first.statusCode, first.body).toBe(200);
    const second = await chatOn(l.target.apiKey, l.target.headers);
    expect(second.statusCode, second.body).toBe(401);
    expect(second.json().error?.code ?? second.json().error).toMatch(/virtual_key_revoked/);
    const k = await keyOf(l.runId);
    expect(k.spentUsd).toBeGreaterThanOrEqual(k.budgetUsd!);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "engine-run-key-revoked"), eq(auditLog.objectId, k.id)));
    expect(audit!.detail).toMatchObject({ cause: "budget_exhausted", engineRunId: l.runId });
    // the run reports what it measured
    const res = await postResult(l.runId, envelope(l.runId, { items: [item("pi-b", "prompt-injection", { attempts: 1 })] }));
    expect(res.statusCode, res.body).toBe(200);
    expect((await runRow(l.runId)).costUsd).toBeGreaterThan(0);
  });

  it("the run-as person no longer entitled at lease time: the run ends not_run, no key minted", async () => {
    const s = await startRun({});
    expect(s.statusCode, s.body).toBe(202);
    const [g] = await db.execute(sql`SELECT id FROM agent_grants WHERE user_id = ${alice.id} AND agent_id = ${judgeId}`).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows);
    await db.execute(sql`DELETE FROM agent_grants WHERE id = ${g!.id}`);
    try {
      const l = await lease();
      expect(l.statusCode, l.body).toBe(204);
      expect(await runRow(s.json().run.id)).toMatchObject({ status: "not_run", errorCode: "run_as_not_entitled", virtualKeyId: null });
    } finally {
      const back = await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId: judgeId });
      expect(back.statusCode).toBe(201);
    }
  });
});

// ===========================================================================
describe("the detection scrub on ingest", () => {
  const SECRET = "AKIA" + "IOSFODNN7EXAMPLE"; // the documented synthetic AWS key id

  it("engine text with a synthetic secret is scrubbed before it reaches redteam_runs / eval_runs", async () => {
    const l = await startAndLease();
    const res = await postResult(
      l.runId,
      envelope(l.runId, {
        items: [
          item(`leak-${SECRET}`, "prompt-injection"),
          item("leak-2", "pii", { verdict: "unknown", reason: `model echoed ${SECRET} back` }),
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const run = await runRow(l.runId);
    const trials = await db.select().from(redteamProbeTrials).where(eq(redteamProbeTrials.runId, run.redteamRunId!));
    const [rt] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, run.redteamRunId!));
    const [ev] = await db.select().from(evalRuns).where(eq(evalRuns.id, run.evalRunId!));
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, l.runId));
    const everything = JSON.stringify({ trials, rt, ev, items, summary: run.summary });
    expect(everything).not.toContain(SECRET);
    expect(trials.some((t) => t.probeKey.startsWith("leak-[redacted:"))).toBe(true);
    expect(trials.find((t) => t.probeKey === "leak-2")!.error).toMatch(/\[redacted:/);
  });

  it("a scrub that throws fails the item closed: unknown, text withheld", async () => {
    const prev = setEngineDetectionScrub(() => {
      throw new Error("ruleset failed to load");
    });
    try {
      const l = await startAndLease();
      const res = await postResult(l.runId, envelope(l.runId, { items: [item(`k-${SECRET}`, "prompt-injection", { reason: SECRET })] }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ verdict: "unknown", counts: { pass: 0, unknown: 1 } });
      const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, l.runId));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ key: "withheld:0", reason: null, verdict: "unknown", attackClass: null });
      expect(JSON.stringify(items)).not.toContain(SECRET);
    } finally {
      setEngineDetectionScrub(prev);
    }
  });
});

// ===========================================================================
describe("approvals, schedules and the workflow binding", () => {
  it("a sensitive set waits for approval; nothing is leased until it is approved", async () => {
    const none = await startRun({ config: { sets: ["agentic"] } });
    expect(none.statusCode, none.body).toBe(422);
    expect(none.json().error).toBe("engine_approver_required");
    const self = await startRun({ config: { sets: ["agentic"] }, approverUserId: alice.id });
    expect(self.statusCode).toBe(403);
    const s = await startRun({ config: { sets: ["agentic"] }, approverUserId: approver.id });
    expect(s.statusCode, s.body).toBe(202);
    expect(s.json().run.status).toBe("awaiting_approval");
    expect((await lease()).statusCode).toBe(204);
    const d = await inject("POST", `/v1/approvals/${s.json().approvalId}/decide`, approver.key, { decision: "approved", reason: "reviewed the set" });
    expect(d.statusCode, d.body).toBe(200);
    expect((await runRow(s.json().run.id)).status).toBe("queued");
    const l = await lease();
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().runId).toBe(s.json().run.id);
    await inject("POST", `/v1/engine-runs/${s.json().run.id}/cancel`, alice.key, {});
    // an over-threshold budget waits too (threshold $10, engine ceiling raised for it)
    const raise = await asAdmin("PATCH", "/v1/engines/promptfoo", { maxBudgetUsd: 50 });
    expect(raise.statusCode, raise.body).toBe(403); // a higher ceiling is a relaxation
    const big = await startRun({ budgetUsd: 5 });
    expect(big.json().run.status).toBe("queued");
    await inject("POST", `/v1/engine-runs/${big.json().run.id}/cancel`, alice.key, {});
  });

  it("a denied approval ends the run not_run", async () => {
    const s = await startRun({ config: { sets: ["agentic"] }, approverUserId: approver.id });
    const d = await inject("POST", `/v1/approvals/${s.json().approvalId}/decide`, approver.key, { decision: "denied", reason: "no" });
    expect(d.statusCode, d.body).toBe(200);
    expect(await runRow(s.json().run.id)).toMatchObject({ status: "not_run", errorCode: "approval_denied" });
  });

  it("a scheduled run executes as its creator, and skips with a reason when that person is gone", async () => {
    const c = await inject("POST", "/v1/engine-schedules", alice.key, {
      request: { engineId: "promptfoo", target: { agentId: targetId, judgeAgentId: judgeId }, config: { sets: ["basic"] }, projectId, budgetUsd: 1 },
      intervalHours: 24,
    });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().schedule.id as string;
    await db.update(engineSchedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(engineSchedules.id, id));
    const out = await runEngineScheduleSweep(db);
    expect(out.started).toBeGreaterThanOrEqual(1);
    const [s] = await db.select().from(engineSchedules).where(eq(engineSchedules.id, id));
    const run = await runRow(s!.lastRunId!);
    expect(run).toMatchObject({ trigger: "scheduled", runAsUserId: alice.id, scheduleId: id, status: "queued" });
    await inject("POST", `/v1/engine-runs/${run.id}/cancel`, alice.key, {});
    // the creator is deactivated: the next due run is skipped, audited, nothing started
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, alice.id));
    try {
      await db.update(engineSchedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(engineSchedules.id, id));
      const out2 = await runEngineScheduleSweep(db);
      expect(out2.skipped).toBeGreaterThanOrEqual(1);
      const [s2] = await db.select().from(engineSchedules).where(eq(engineSchedules.id, id));
      expect(s2!.lastSkip).toMatch(/gone or deactivated/);
      expect(s2!.lastRunId).toBe(run.id);
    } finally {
      await db.update(users).set({ disabledAt: null }).where(eq(users.id, alice.id));
      await inject("PATCH", `/v1/engine-schedules/${id}`, alice.key, { enabled: false });
    }
  });

  it("an automated_check bound to an engine waits for the run, then passes or fails with it", async () => {
    const tplName = `b5-engine-flow-${RUN}`;
    const tpl = await inject("POST", "/v1/workflows/templates", AUTH, {
      name: tplName,
      definition: {
        workflow: tplName,
        stages: [
          { id: "intake", type: "trigger" },
          { id: "gate", type: "human_approval", approvers: [approver.id] },
          {
            id: "checks",
            type: "automated_check",
            checks: ["engine_redteam"],
            engines: [{ check: "engine_redteam", engine: "promptfoo", agent: `b5-target-${RUN}`, judgeAgent: `b5-judge-${RUN}`, sets: ["basic"], budgetUsd: 1 }],
          },
          { id: "done", type: "human_approval", approvers: [approver.id] },
        ],
      },
    });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const rule = await inject("POST", "/v1/workflows/assignment-rules", AUTH, { templateId: tpl.json().id, changeType: `b5-change-${RUN}` });
    expect(rule.statusCode, rule.body).toBe(201);

    const start = async () => {
      const started = await inject("POST", "/v1/workflows/instances", alice.key, {
        projectId,
        change: { description: "b5 change", paths: ["src/x.ts"], changeType: `b5-change-${RUN}`, environment: "staging" },
      });
      expect(started.statusCode, started.body).toBe(201);
      const instanceId = started.json().id as string;
      const q = await inject("GET", "/v1/approvals?status=pending", approver.key);
      const a = (q.json().approvals ?? []).find((r: { instanceId: string; stageId: string }) => r.instanceId === instanceId && r.stageId === "gate");
      const d = await inject("POST", `/v1/approvals/${a.id}/decide`, approver.key, { decision: "approved" });
      expect(d.statusCode, d.body).toBe(200);
      return instanceId;
    };
    const view = async (id: string) => (await inject("GET", `/v1/workflows/instances/${id}`, alice.key)).json().instance;

    // a human cannot report it green
    const i1 = await start();
    const report = await inject("POST", `/v1/workflows/instances/${i1}/checks`, alice.key, { round: 0, stageId: "checks", results: [{ check: "engine_redteam", status: "passed" }], reason: "trust me" });
    expect(report.statusCode, report.body).toBe(422);
    expect(report.json().error).toBe("engine_check_cannot_be_reported");
    // the run was started as the initiator, on the instance's project; the check waits
    let v = await view(i1);
    expect(v.status).toBe("awaiting_execution");
    const checks = v.context["checks:checks"] as Array<{ check: string; status: string; engine: { runId: string } }>;
    expect(checks[0]).toMatchObject({ check: "engine_redteam", status: "pending" });
    const wfRun = await runRow(checks[0]!.engine.runId);
    expect(wfRun).toMatchObject({ trigger: "workflow", runAsUserId: alice.id, projectId, workflowInstanceId: i1, workflowStageId: "checks" });
    // the run completes clean: the stage passes and the instance moves on
    const l = await lease();
    expect(l.json().runId).toBe(wfRun.id);
    const ok = await postResult(wfRun.id, envelope(wfRun.id, { items: [item("pi-wf", "prompt-injection")] }));
    expect(ok.statusCode, ok.body).toBe(200);
    v = await view(i1);
    expect(v.status).toBe("blocked_on_approval");
    expect((v.context["checks:checks"] as Array<{ status: string }>)[0]!.status).toBe("passed");

    // a run that times out fails the check
    const i2 = await start();
    const v2 = await view(i2);
    const run2 = (v2.context["checks:checks"] as Array<{ engine: { runId: string } }>)[0]!.engine.runId;
    expect((await lease()).json().runId).toBe(run2);
    await db.update(engineRuns).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(engineRuns.id, run2));
    await runEngineRunSweep(db);
    const after = await view(i2);
    expect(after.status).toBe("blocked_on_check");
    expect((after.context["checks:checks"] as Array<{ status: string; detail: string }>)[0]).toMatchObject({ status: "failed" });
  });
});

// ===========================================================================
// ===========================================================================
// PR #203 review round 1 (Codex) — each red first
// ===========================================================================
describe("review round 1", () => {
  const SECRET = "AKIA" + "IOSFODNN7EXAMPLE";

  async function startInstanceOn(who: { authorization: string }, project: string | null) {
    return inject("POST", "/v1/workflows/instances", who, {
      ...(project ? { projectId: project } : {}),
      change: { description: "b5 review", paths: ["src/x.ts"], changeType: `b5-change-${RUN}`, environment: "staging" },
    });
  }
  async function approveGate(instanceId: string) {
    const q = await inject("GET", "/v1/approvals?status=pending", approver.key);
    const a = (q.json().approvals ?? []).find((r: { instanceId: string; stageId: string }) => r.instanceId === instanceId && r.stageId === "gate");
    const d = await inject("POST", `/v1/approvals/${a.id}/decide`, approver.key, { decision: "approved" });
    expect(d.statusCode, d.body).toBe(200);
  }
  const view = async (id: string) => (await inject("GET", `/v1/workflows/instances/${id}`, alice.key)).json().instance;

  it("[3] lease re-checks the runner's self-test freshness and the engine's", async () => {
    const s = await startRun({});
    expect(s.statusCode, s.body).toBe(202);
    const [runner] = await db.execute(sql`SELECT self_test FROM engine_runners WHERE id = ${pfRunner.id}`).then((r) => (r as unknown as { rows: Array<{ self_test: Record<string, unknown> }> }).rows);
    const stale = { ...runner!.self_test, at: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    await db.execute(sql`UPDATE engine_runners SET self_test = ${JSON.stringify(stale)}::jsonb WHERE id = ${pfRunner.id}`);
    try {
      const l = await lease();
      expect(l.statusCode, l.body).toBe(409);
      expect(l.json().error).toBe("engine_self_test_required");
    } finally {
      await db.execute(sql`UPDATE engine_runners SET self_test = ${JSON.stringify(runner!.self_test)}::jsonb WHERE id = ${pfRunner.id}`);
    }
    const [eng] = await db.execute(sql`SELECT self_test_passed_at FROM engines WHERE id = 'promptfoo'`).then((r) => (r as unknown as { rows: Array<{ self_test_passed_at: string }> }).rows);
    await db.execute(sql`UPDATE engines SET self_test_passed_at = now() - interval '2 days' WHERE id = 'promptfoo'`);
    try {
      const l = await lease();
      expect(l.statusCode, l.body).toBe(409);
      expect(l.json().error).toBe("engine_self_test_required");
    } finally {
      await db.execute(sql`UPDATE engines SET self_test_passed_at = ${eng!.self_test_passed_at} WHERE id = 'promptfoo'`);
    }
    await inject("POST", `/v1/engine-runs/${s.json().run.id}/cancel`, alice.key, {});
  });

  it("[8] a result after the deadline or the lease, before the sweep, ends the run timed out", async () => {
    for (const col of ["deadline_at", "lease_expires_at"] as const) {
      const l = await startAndLease();
      await db.execute(sql`UPDATE engine_runs SET ${sql.raw(col)} = now() - interval '1 second' WHERE id = ${l.runId}`);
      const res = await postResult(l.runId, envelope(l.runId, { items: [item("late", "prompt-injection")] }));
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("engine_run_timed_out");
      const run = await runRow(l.runId);
      expect(run.status).toBe("timeout");
      expect(run.redteamRunId).toBeNull();
      expect((await keyOf(l.runId)).revokedAt).not.toBeNull();
    }
  });

  it("[12] an envelope for another engine version is refused and fails the run", async () => {
    const l = await startAndLease();
    const res = await postResult(l.runId, envelope(l.runId, { engineVersion: "9.9.9", items: [item("v", "prompt-injection")] }));
    expect(res.statusCode, res.body).toBe(422);
    expect(await runRow(l.runId)).toMatchObject({ status: "failed", errorCode: "result_mismatch", redteamRunId: null });
  });

  it("[11] eval_runs cases count only mapped items that were measured", async () => {
    const l = await startAndLease();
    const res = await postResult(
      l.runId,
      envelope(l.runId, { items: [item("m", "prompt-injection"), item("u", "unmapped-thing"), item("n", "pii")], notRun: [{ key: "n", reason: "egress_denied" }] }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const [ev] = await db.select().from(evalRuns).where(eq(evalRuns.id, (await runRow(l.runId)).evalRunId!));
    expect(ev).toMatchObject({ cases: 1, passedCases: 1, passRate: 1 });
  });

  it("[2] the taxonomy system and the claimed class are scrubbed too", async () => {
    const l = await startAndLease();
    const res = await postResult(
      l.runId,
      envelope(l.runId, { items: [item("s", "prompt-injection", { sourceTaxonomy: { system: `sys-${SECRET}`, id: "x" }, mappedClass: `cls-${SECRET}` })] }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, l.runId));
    expect(JSON.stringify(items)).not.toContain(SECRET);
    expect(items[0]!.sourceSystem).toMatch(/\[redacted:/);
  });

  it("[6] lowering raw-report retention shortens reports already stored", async () => {
    const l = await startAndLease();
    const content = Buffer.from("raw report body");
    const res = await postResult(
      l.runId,
      envelope(l.runId, {
        items: [item("r", "prompt-injection")],
        rawReport: { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, contentBase64: content.toString("base64") },
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((await runRow(l.runId)).rawReportCiphertext).not.toBeNull();
    await db.execute(sql`UPDATE engine_runs SET finished_at = now() - interval '10 days' WHERE id = ${l.runId}`);
    const shorter = await asAdmin("PUT", "/v1/org/settings", { engineRawReportRetentionDays: 5 });
    expect(shorter.statusCode, shorter.body).toBe(200);
    try {
      await runEngineRunSweep(db);
      expect((await runRow(l.runId)).rawReportCiphertext).toBeNull();
    } finally {
      await db.update(orgSettings).set({ engineRawReportRetentionDays: 90 }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("[10] lease re-checks project attribution: a run-as person no longer a member ends not_run", async () => {
    const p = await inject("POST", "/v1/projects", AUTH, { name: `b5-members-${RUN}` });
    const pid = p.json().id as string;
    for (const userId of [alice.id, approver.id]) {
      const m = await inject("POST", `/v1/projects/${pid}/members`, AUTH, { userId, role: userId === approver.id ? "owner" : "contributor" });
      expect(m.statusCode, m.body).toBeLessThan(300);
    }
    const s = await startRun({ projectId: pid });
    expect(s.statusCode, s.body).toBe(202);
    await db.execute(sql`DELETE FROM project_members WHERE project_id = ${pid} AND user_id = ${alice.id}`);
    const l = await lease();
    expect(l.statusCode, l.body).toBe(204);
    expect(await runRow(s.json().run.id)).toMatchObject({ status: "not_run", errorCode: "project_not_attributable", virtualKeyId: null });
  });

  it("[13] a schedule is validated like a run (judge, project, budget) and starts nothing", async () => {
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM engine_runs`).then((r) => (r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
    const base = { engineId: "promptfoo", target: { agentId: targetId, judgeAgentId: judgeId }, config: { sets: ["basic"] }, projectId, budgetUsd: 1 };
    const noProject = await inject("POST", "/v1/engine-schedules", alice.key, { request: { ...base, projectId: undefined }, intervalHours: 24 });
    expect(noProject.statusCode, noProject.body).toBe(422);
    expect(noProject.json().error).toBe("project_required");
    const overBudget = await inject("POST", "/v1/engine-schedules", alice.key, { request: { ...base, budgetUsd: 100 }, intervalHours: 24 });
    expect(overBudget.json().error).toBe("engine_budget_exceeds_ceiling");
    const g = await db.execute(sql`DELETE FROM agent_grants WHERE user_id = ${alice.id} AND agent_id = ${judgeId} RETURNING id`);
    try {
      const judge = await inject("POST", "/v1/engine-schedules", alice.key, { request: { ...base, target: { agentId: targetId, judgeAgentId: judgeId } }, intervalHours: 24 });
      expect(judge.statusCode, judge.body).toBe(403);
      expect(judge.json().error).toBe("judge_not_entitled");
    } finally {
      expect((g as unknown as { rows: unknown[] }).rows.length).toBe(1);
      const back = await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId: judgeId });
      expect(back.statusCode).toBe(201);
    }
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM engine_runs`).then((r) => (r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
    expect(after).toBe(before);
  });

  it("[15] an approval denial stores the same normalised summary as every other end", async () => {
    const s = await startRun({ config: { sets: ["agentic"] }, approverUserId: approver.id });
    const d = await inject("POST", `/v1/approvals/${s.json().approvalId}/decide`, approver.key, { decision: "denied", reason: "no" });
    expect(d.statusCode, d.body).toBe(200);
    const run = await runRow(s.json().run.id);
    expect(run.summary).toMatchObject({ verdict: "not_run", counts: { pass: 0, fail: 0, unknown: 0, not_run: 0 }, taxonomyVersion: 7, cause: "approval_denied", mappedItems: 0 });
  });

  it("[16] a workflow with engine-bound checks cannot start without a project", async () => {
    const r = await startInstanceOn(alice.key, null);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("project_required_for_engine_checks");
  });

  it("[9] the workflow engine stage resolves the initiator's admin standing", async () => {
    // a project with members the admin is not one of: only admin standing attributes to it
    const p = await inject("POST", "/v1/projects", AUTH, { name: `b5-admin-only-${RUN}` });
    const pid = p.json().id as string;
    await inject("POST", `/v1/projects/${pid}/members`, AUTH, { userId: approver.id, role: "owner" });
    const g = await inject("POST", "/v1/grants/agents", AUTH, { userId: admin.id, agentId: targetId });
    expect(g.statusCode, g.body).toBe(201);
    // round 6 [73]: promptfoo needs a judge, and the admin must be entitled to it too
    const gj = await inject("POST", "/v1/grants/agents", AUTH, { userId: admin.id, agentId: judgeId });
    expect(gj.statusCode, gj.body).toBe(201);
    const started = await startInstanceOn(admin.key, pid);
    expect(started.statusCode, started.body).toBe(201);
    await approveGate(started.json().id);
    const v = await (await inject("GET", `/v1/workflows/instances/${started.json().id}`, admin.key)).json().instance;
    const check = (v.context["checks:checks"] as Array<{ status: string; detail: string; engine: { runId: string | null } }>)[0]!;
    expect(check.status, check.detail).toBe("pending");
    await inject("POST", `/v1/engine-runs/${check.engine.runId}/cancel`, admin.key, {});
  });

  it("[5] a workflow re-evaluation that fails after a run ends is retried by the sweep", async () => {
    const started = await startInstanceOn(alice.key, projectId);
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json().id as string;
    await approveGate(id);
    const runId = ((await view(id)).context["checks:checks"] as Array<{ engine: { runId: string } }>)[0]!.engine.runId;
    expect((await lease()).json().runId).toBe(runId);
    engineRunTestHooks.beforeWorkflowNotify = () => {
      throw new Error("re-evaluation lost");
    };
    try {
      const ok = await postResult(runId, envelope(runId, { items: [item("wf", "prompt-injection")] }));
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      engineRunTestHooks.beforeWorkflowNotify = undefined;
    }
    expect((await view(id)).status).toBe("awaiting_execution");
    await runEngineRunSweep(db);
    expect((await view(id)).status).toBe("blocked_on_approval");
  });
});

// ===========================================================================
// PR #203 review round 2 (Codex) — each red first
// ===========================================================================
describe("review round 2", () => {
  it("[17] a runner revoked while its lease is being decided gets nothing (checked under the runner row lock)", async () => {
    const second = await enrol("promptfoo", PF_DIGEST, MANIFEST.promptfoo.version);
    const s = await startRun({});
    expect(s.statusCode, s.body).toBe(202);
    engineRunTestHooks.beforeLeaseTx = async (runnerId) => {
      if (runnerId === second.id) await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'revoked mid-lease' WHERE id = ${second.id}`);
    };
    try {
      const l = await inject("POST", "/v1/engine-runner/lease", second.auth, PF_BUILD());
      expect(l.statusCode, l.body).toBe(401);
      expect(l.json().error).toBe("engine_runner_revoked");
    } finally {
      engineRunTestHooks.beforeLeaseTx = undefined;
    }
    expect(await runRow(s.json().run.id)).toMatchObject({ status: "queued", virtualKeyId: null, runnerId: null });
    await inject("POST", `/v1/engine-runs/${s.json().run.id}/cancel`, alice.key, {});
  });

  it("[20] a heartbeat after the lease expired ends the run instead of renewing it", async () => {
    const l = await startAndLease();
    await db.execute(sql`UPDATE engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${l.runId}`);
    const hb = await inject("POST", `/v1/engine-runner/runs/${l.runId}/heartbeat`, pfRunner.auth, { phase: "running", progress: 0.9 });
    expect(hb.statusCode, hb.body).toBe(409);
    expect(hb.json().error).toBe("engine_run_timed_out");
    expect(await runRow(l.runId)).toMatchObject({ status: "timeout", errorCode: "lease_expired" });
    expect((await chatOn(l.target.apiKey, l.target.headers)).statusCode).toBe(401);
  });

  it("[21] aborting a workflow cancels its engine runs, revokes keys and supersedes the run's approval", async () => {
    const name = `b5-agentic-flow-${RUN}`;
    const tpl = await inject("POST", "/v1/workflows/templates", AUTH, {
      name,
      definition: {
        workflow: name,
        stages: [
          { id: "intake", type: "trigger" },
          { id: "gate", type: "human_approval", approvers: [approver.id] },
          {
            id: "checks",
            type: "automated_check",
            checks: ["basic_check", "agentic_check"],
            engines: [
              { check: "basic_check", engine: "promptfoo", agent: `b5-target-${RUN}`, judgeAgent: `b5-judge-${RUN}`, sets: ["basic"], budgetUsd: 1 },
              { check: "agentic_check", engine: "promptfoo", agent: `b5-target-${RUN}`, judgeAgent: `b5-judge-${RUN}`, sets: ["agentic"], budgetUsd: 1 },
            ],
          },
          { id: "done", type: "human_approval", approvers: [approver.id] },
        ],
      },
    });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const rule = await inject("POST", "/v1/workflows/assignment-rules", AUTH, { templateId: tpl.json().id, changeType: `b5-agentic-${RUN}` });
    expect(rule.statusCode, rule.body).toBe(201);
    await db.update(orgSettings).set({ infraApproverUserId: approver.id }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const started = await inject("POST", "/v1/workflows/instances", alice.key, {
        projectId,
        change: { description: "b5 agentic", paths: ["src/x.ts"], changeType: `b5-agentic-${RUN}`, environment: "staging" },
      });
      expect(started.statusCode, started.body).toBe(201);
      const id = started.json().id as string;
      const q = await inject("GET", "/v1/approvals?status=pending", approver.key);
      const gate = (q.json().approvals ?? []).find((r: { instanceId: string; stageId: string }) => r.instanceId === id && r.stageId === "gate");
      expect((await inject("POST", `/v1/approvals/${gate.id}/decide`, approver.key, { decision: "approved" })).statusCode).toBe(200);
      const v = (await inject("GET", `/v1/workflows/instances/${id}`, alice.key)).json().instance;
      const checks = v.context["checks:checks"] as Array<{ check: string; engine: { runId: string } }>;
      const basicRun = checks.find((c) => c.check === "basic_check")!.engine.runId;
      const agenticRun = checks.find((c) => c.check === "agentic_check")!.engine.runId;
      const agentic = await runRow(agenticRun);
      expect(agentic.status).toBe("awaiting_approval");
      const [appr] = await db.execute(sql`SELECT instance_id FROM approvals WHERE id = ${agentic.approvalId}`).then((r) => (r as unknown as { rows: Array<{ instance_id: string | null }> }).rows);
      expect(appr!.instance_id).toBe(id);
      const l = await lease();
      expect(l.json().runId).toBe(basicRun);
      const key = l.json().target.apiKey as string;
      const abort = await inject("POST", `/v1/workflows/instances/${id}/abort`, alice.key, {});
      expect(abort.statusCode, abort.body).toBe(200);
      expect(await runRow(basicRun)).toMatchObject({ status: "cancelled" });
      expect(await runRow(agenticRun)).toMatchObject({ status: "cancelled" });
      expect((await chatOn(key, l.json().target.headers)).statusCode).toBe(401);
      const [after] = await db.execute(sql`SELECT status FROM approvals WHERE id = ${agentic.approvalId}`).then((r) => (r as unknown as { rows: Array<{ status: string }> }).rows);
      expect(after!.status).toBe("superseded");
    } finally {
      await db.update(orgSettings).set({ infraApproverUserId: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("[23] a scheduled run whose creation throws is recorded as an audited skip, not lost", async () => {
    const c = await inject("POST", "/v1/engine-schedules", alice.key, {
      request: { engineId: "promptfoo", target: { agentId: targetId, judgeAgentId: judgeId }, config: { sets: ["basic"] }, projectId, budgetUsd: 1 },
      intervalHours: 24,
    });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().schedule.id as string;
    await db.update(engineSchedules).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(engineSchedules.id, id));
    engineRunTestHooks.beforeScheduledCreate = () => {
      throw new Error("database hiccup");
    };
    try {
      const out = await runEngineScheduleSweep(db);
      expect(out.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      engineRunTestHooks.beforeScheduledCreate = undefined;
      await inject("PATCH", `/v1/engine-schedules/${id}`, alice.key, { enabled: false });
    }
    const [s] = await db.select().from(engineSchedules).where(eq(engineSchedules.id, id));
    expect(s!.lastSkip).toMatch(/could not be created/);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "engine-schedule-skipped"), eq(auditLog.objectId, id)));
    expect(audits).toHaveLength(1);
  });
});

describe("route classes", () => {
  it("the runner routes are their own trust path; the run routes are any user's", async () => {
    const { routeAuthClass } = await import("./route-classes.js");
    expect(routeAuthClass("POST", "/v1/engine-runner/lease")).toBe("engine-runner");
    expect(routeAuthClass("POST", "/v1/engine-runner/register")).toBe("engine-runner");
    expect(routeAuthClass("POST", "/v1/engine-runs")).toBe("user");
    expect(routeAuthClass("PATCH", "/v1/engines/:engineId")).toBe("admin");
    expect(routeAuthClass("POST", "/v1/engines/:engineId/enrollment-tokens")).toBe("admin");
    // a non-admin cannot enable, mint enrolment tokens or revoke runners
    for (const [method, url] of [
      ["PATCH", "/v1/engines/promptfoo"],
      ["POST", "/v1/engines/promptfoo/enrollment-tokens"],
      ["POST", "/v1/engines/promptfoo/self-test"],
      ["DELETE", `/v1/engine-runners/${randomUUID()}`],
    ] as const) {
      const r = await inject(method, url, alice.key, method === "DELETE" ? undefined : {});
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

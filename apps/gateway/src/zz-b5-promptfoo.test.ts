/**
 * ADR-0187 B5-P — the promptfoo shim against the REAL gateway on a real database: the runner core
 * (`runOnce`, `RunnerClient`) and the promptfoo adapter, with only the promptfoo process itself
 * replaced by a stand-in that does what promptfoo does with the generated config file — it reads
 * `redteam-config.json`, calls each provider it names (generation on `redteam.provider`, the target,
 * grading on `defaultTest.options.provider`) at the provider's `apiBaseUrl` with the key from the
 * env var the provider names, and writes promptfoo's result JSON. The real promptfoo is exercised
 * against a fake gateway in packages/engine-promptfoo (promptfoo-real.test.ts, opt-in).
 *
 * The shipped manifest's promptfoo entry is used as is (its sets, its usage-data switches), with a
 * synthetic image digest passed through the code-only `buildApp({engines})` seam; the taxonomy is
 * the shipped table (v2, promptfoo rows).
 *
 * Required proofs (ADR-0187 "Work split": each red against the defect it guards):
 *   - the generated config's providers are accepted by the compat route on the run's key, pinned
 *     to the run's project, and usage is attributed to the run;
 *   - budget spent → 401 mid-run: what was measured counts, the rest is unknown, never pass;
 *   - cancel revokes the key at once: the engine's next call is 401, the runner stops it and
 *     posts nothing;
 *   - engine error → unknown, and nothing reaches the red-team ledger;
 *   - egress denied → not_run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  authSessions,
  createDb,
  engineRunItems,
  engineRuns,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  orgSettings,
  ORG_SETTINGS_ID,
  redteamProbeTrials,
  redteamRuns,
  runMigrations,
  sql,
  usageEvents,
  virtualKeys,
  type Db,
} from "@regulait/db";
import {
  BATCH5_STRICT_DEFAULTS,
  ENGINE_MANIFEST,
  ENGINE_TAXONOMY,
  STEP_UP_HEADER,
  type EngineId,
  type EngineManifestEntry,
} from "@regulait/shared";
import { buildSelfTest, FileRunnerTokenStore, generateRunnerSecret, runOnce, RunnerClient, RunnerFatalError, runRunnerLoop, runnerTokenHash, type RunnerHttp } from "@regulait/engine-runner";
import { promptfooAdapter } from "@regulait/engine-promptfoo";
import { buildApp } from "./app.js";
import { engineRunTestHooks } from "./engine-runs.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b5p-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const GATEWAY_BASE = "http://gateway.test/v1";
const PF_DIGEST = `sha256:${"d".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = { ...ENGINE_MANIFEST, promptfoo: { ...ENGINE_MANIFEST.promptfoo, imageDigest: PF_DIGEST } };
const PF_BUILD = { imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;
let priorInterception: { anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean } | null = null;
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };
let alice: { id: string; key: { authorization: string } };
let targetId: string;
let judgeId: string;
let projectId: string;
let client: RunnerClient;
/** the beforeAll runner's own token and id (decisions 53 and 54 drive it directly) */
let firstRunnerSecret: string;
let firstRunnerId: string;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const asAdmin = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.session.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** the runner's HTTP, through the app (the runner core's own client code is what runs) */
const runnerHttp: RunnerHttp = async (url, init) => {
  const u = new URL(url);
  const r = await app.inject({ method: init.method as Method, url: u.pathname, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
  return { status: r.statusCode, json: async () => (r.body ? JSON.parse(r.body) : null) };
};

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b5p" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
async function makeAgent(name: string, model: string) {
  const r = await inject("POST", "/v1/agents", AUTH, { name, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: admin.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

interface Call {
  role: "generator" | "target" | "grader";
  status: number;
  body: string;
}

/**
 * A stand-in for the promptfoo process: driven ONLY by the config file the adapter wrote and the
 * env it was given. `hooks.afterCall` runs after each call (to spend a budget or cancel a run);
 * the stand-in stops when the run's signal aborts, like a killed process group.
 */
function promptfooStandIn(hooks: { afterCall?: (c: Call, n: number) => Promise<void>; evalExit?: number; errorFor?: (plugin: string) => string | null } = {}) {
  const calls: Call[] = [];
  const run = async (_cmd: string, args: readonly string[], opts: { cwd?: string; env: Record<string, string>; signal?: AbortSignal }) => {
    const killed = { exitCode: null, signal: "SIGKILL" as NodeJS.Signals, killed: true, stdout: "", stderr: "" };
    const config = JSON.parse(await readFile(path.join(opts.cwd!, "redteam-config.json"), "utf8")) as {
      targets: Array<{ id: string; config: { apiBaseUrl: string; apiKeyEnvar: string; headers: Record<string, string> } }>;
      defaultTest: { options: { provider: { id: string; config: { apiBaseUrl: string; apiKeyEnvar: string; headers: Record<string, string> } } } };
      redteam: { numTests: number; plugins: Array<{ id: string }>; provider: { id: string; config: { apiBaseUrl: string; apiKeyEnvar: string; headers: Record<string, string> } } };
    };
    const call = async (role: Call["role"], p: { id: string; config: { apiBaseUrl: string; apiKeyEnvar: string; headers: Record<string, string> } }) => {
      expect(p.config.apiBaseUrl).toBe(GATEWAY_BASE);
      const r = await app.inject({
        method: "POST",
        url: `${new URL(p.config.apiBaseUrl).pathname}/chat/completions`,
        headers: { authorization: `Bearer ${opts.env[p.config.apiKeyEnvar]}`, ...p.config.headers },
        payload: { model: p.id.slice("openai:chat:".length), messages: [{ role: "user", content: `${role} probe` }] },
      });
      const c = { role, status: r.statusCode, body: r.body };
      calls.push(c);
      await hooks.afterCall?.(c, calls.length);
      return c;
    };
    if (args[1] === "redteam") {
      for (const _p of config.redteam.plugins) {
        if (opts.signal?.aborted) return killed;
        await call("generator", config.redteam.provider);
      }
      await writeFile(path.join(opts.cwd!, "redteam.yaml"), "tests: []\n");
      return { exitCode: 0, signal: null, killed: false, stdout: "", stderr: "" };
    }
    const results: unknown[] = [];
    for (const p of config.redteam.plugins) {
      for (let i = 0; i < config.redteam.numTests; i++) {
        if (opts.signal?.aborted) return killed;
        const meta = { pluginId: p.id };
        const forced = hooks.errorFor?.(p.id) ?? null;
        if (forced) {
          results.push({ success: false, failureReason: 2, error: forced, metadata: meta, testCase: { metadata: meta } });
          continue;
        }
        const t = await call("target", config.targets[0]!);
        const g = t.status === 200 ? await call("grader", config.defaultTest.options.provider) : null;
        const failed = t.status !== 200 ? t : g && g.status !== 200 ? g : null;
        results.push(
          failed
            ? { success: false, failureReason: 2, error: `API error: ${failed.status}\n${failed.body}`, metadata: meta, testCase: { metadata: meta } }
            : { success: true, failureReason: 0, metadata: meta, testCase: { metadata: meta }, gradingResult: { pass: true } },
        );
      }
    }
    await writeFile(path.join(opts.cwd!, "results.json"), JSON.stringify({ evalId: "e", results: { version: 3, results } }));
    return { exitCode: hooks.evalExit ?? 0, signal: null, killed: false, stdout: "", stderr: "" };
  };
  return { calls, run };
}

async function startRun(body: Record<string, unknown> = {}) {
  const r = await inject("POST", "/v1/engine-runs", alice.key, {
    engineId: "promptfoo",
    target: { agentId: targetId, judgeAgentId: judgeId },
    config: { sets: ["prompt-extraction", "pii:direct"] },
    projectId,
    budgetUsd: 1,
    trials: 2,
    ...body,
  });
  expect(r.statusCode, r.body).toBe(202);
  return r.json().run.id as string;
}
async function runRow(runId: string) {
  const [r] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
  return r!;
}
async function keyOf(runId: string) {
  const [k] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, (await runRow(runId)).virtualKeyId!));
  return k!;
}
async function once(standIn: ReturnType<typeof promptfooStandIn>) {
  const adapter = promptfooAdapter({ entrypoint: "/opt/promptfoo/node_modules/promptfoo/dist/src/entrypoint.js", run: standIn.run });
  return runOnce(client, adapter, { engineId: "promptfoo", imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, workRoot: await mkdtemp(path.join(tmpdir(), "b5p-")), heartbeatMs: 25, retryBaseMs: 10 });
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64), engines: { manifest: MANIFEST, gatewayBaseUrl: GATEWAY_BASE } });
  await app.ready();
  const [prior] = await db.select().from(interceptionSettings).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  priorInterception = prior ? { anthropicCompatEnabled: prior.anthropicCompatEnabled, openaiCompatEnabled: prior.openaiCompatEnabled } : null;
  expect((await inject("PUT", "/v1/interception/settings", AUTH, { anthropicCompatEnabled: true, openaiCompatEnabled: true })).statusCode).toBe(200);
  // any run an earlier suite left queued would be leased before ours: end them first (scoped to promptfoo)
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE engine_id = 'promptfoo' AND status IN ('queued', 'awaiting_approval')`);

  const a = await makeUser(`b5p-admin-${RUN}@example.com`, true);
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
  expect((await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "b5p" })).statusCode).toBe(201);

  alice = await makeUser(`b5p-alice-${RUN}@example.com`);
  targetId = await makeAgent(`b5p-target-${RUN}`, "b5p-target-model");
  judgeId = await makeAgent(`b5p-judge-${RUN}`, "b5p-judge-model");
  for (const agentId of [targetId, judgeId]) expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId })).statusCode).toBe(201);
  const p = await inject("POST", "/v1/projects", AUTH, { name: `b5p-project-${RUN}` });
  expect(p.statusCode, p.body).toBe(201);
  projectId = p.json().id;

  // the runner registers the way the image's entrypoint does: its own self-test, the shipped switches
  const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: "b5p" });
  expect(t.statusCode, t.body).toBe(201);
  client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
  const selfTest = await buildSelfTest({
    imageDigest: PF_DIGEST,
    engineVersion: MANIFEST.promptfoo.version,
    requiredEnv: MANIFEST.promptfoo.usageDataEnv,
    env: { ...MANIFEST.promptfoo.usageDataEnv },
    egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
  });
  firstRunnerSecret = generateRunnerSecret();
  const reg = await client.register(t.json().token, firstRunnerSecret, { name: `promptfoo-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest });
  expect(reg.selfTest).toEqual({ passed: true, failures: [] });
  firstRunnerId = reg.runnerId;
  const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
  expect(st.json().passed, st.body).toBe(true);
  const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true });
  expect(refused.statusCode, refused.body).toBe(403);
  const ok = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(200);
}, 180_000);

afterAll(async () => {
  if (priorInterception) await db.update(interceptionSettings).set(priorInterception).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
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

describe("B5-P promptfoo through the real gateway", () => {
  it("the generated config's providers ride the run's key: accepted, project-pinned, attributed; classes from the shipped taxonomy", async () => {
    const runId = await startRun();
    const s = promptfooStandIn();
    const out = await once(s);
    expect(out).toMatchObject({ outcome: "posted", runId, status: 200 });
    expect(s.calls.length).toBe(2 + 2 * 2 * 2); // one generation call per plugin; target + grader per test
    expect(s.calls.every((c) => c.status === 200)).toBe(true);
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "completed" });
    expect(run.summary).toMatchObject({ verdict: "pass", mappedItems: 2, taxonomyVersion: ENGINE_TAXONOMY.version });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.map((i) => [i.key, i.attackClass, i.verdict]).sort()).toEqual([
      ["pii:direct/basic", "pii_leak", "pass"],
      ["prompt-extraction/basic", "system_prompt_extraction", "pass"],
    ]);
    const k = await keyOf(runId);
    expect(k.revokedAt).not.toBeNull();
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    expect(usage).toHaveLength(s.calls.length);
    expect(usage.every((u) => u.projectId === projectId && (u.detail as { purpose?: string }).purpose === "engine:promptfoo")).toBe(true);
  });

  it("RED PROOF budget spent → 401 mid-run: what was measured counts, the rest is unknown, never pass", async () => {
    const runId = await startRun();
    const s = promptfooStandIn({
      // after the first plugin's last call, the budget is met: the next call crosses it and every later one is 401
      afterCall: async (_c, n) => {
        if (n === 6) {
          const k = await keyOf(runId);
          await db.update(virtualKeys).set({ budgetUsd: k.spentUsd + 1e-9 }).where(eq(virtualKeys.id, k.id));
        }
      },
    });
    const out = await once(s);
    expect(out).toMatchObject({ outcome: "posted", status: 200 });
    expect(s.calls.slice(0, 7).every((c) => c.status === 200)).toBe(true);
    expect(s.calls.slice(7).length).toBeGreaterThan(0);
    expect(s.calls.slice(7).every((c) => c.status === 401 && /virtual_key_revoked/.test(c.body))).toBe(true);
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.find((i) => i.key === "prompt-extraction/basic")).toMatchObject({ verdict: "pass", attackClass: "system_prompt_extraction" });
    expect(items.find((i) => i.key === "pii:direct/basic")).toMatchObject({ verdict: "unknown" });
    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect((run.summary as { verdict: string }).verdict).toBe("unknown");
    // the red-team ledger counts the measured item only: the unknown one is an errored trial,
    // outside every denominator, never a resisted one
    const [rt] = await db.select().from(redteamRuns).where(eq(redteamRuns.id, run.redteamRunId!));
    const trials = await db.select().from(redteamProbeTrials).where(eq(redteamProbeTrials.runId, rt!.id));
    expect(new Set(trials.filter((t) => t.error === null).map((t) => t.attackClass))).toEqual(new Set(["system_prompt_extraction"]));
    expect(trials.filter((t) => t.attackClass === "pii_leak").every((t) => t.error !== null && !t.defeated)).toBe(true);
    expect(rt).toMatchObject({ asrTrials: 2, defeated: 0 });
    expect(run.costUsd).toBeGreaterThan(0);
  });

  it("RED PROOF cancel revokes the key: the engine's next call is 401, the runner stops it and posts nothing", async () => {
    const runId = await startRun();
    let cancelledAt = -1;
    const s = promptfooStandIn({
      afterCall: async (_c, n) => {
        if (n === 3) {
          const c = await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, { reason: "stop" });
          expect(c.statusCode, c.body).toBe(200);
          cancelledAt = n;
        }
        // the stand-in keeps calling until the heartbeat delivers the cancel (like a real process)
        await new Promise((r) => setTimeout(r, 15));
      },
    });
    const out = await once(s);
    expect(out).toMatchObject({ outcome: "cancelled", runId });
    expect(cancelledAt).toBe(3);
    const after = s.calls.slice(3);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((c) => c.status === 401 && /virtual_key_revoked/.test(c.body))).toBe(true);
    expect((await keyOf(runId)).revokedAt).not.toBeNull();
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "cancelled", redteamRunId: null, evalRunId: null });
    expect(await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId))).toEqual([]);
  });

  it("RED PROOF engine error → unknown: promptfoo exits 1, nothing is clean, nothing reaches the ledgers", async () => {
    const runId = await startRun();
    const out = await once(promptfooStandIn({ evalExit: 1 }));
    expect(out).toMatchObject({ outcome: "failed", status: 200 });
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "failed", errorCode: "engine_error", redteamRunId: null, evalRunId: null });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.length).toBe(2);
    expect(items.every((i) => i.verdict === "unknown")).toBe(true);
  });

  it("RED PROOF egress denied → not_run: a plugin whose every call could not connect is not run, never pass", async () => {
    const runId = await startRun();
    const out = await once(promptfooStandIn({ errorFor: (p) => (p === "pii:direct" ? "request to https://datasets.example/x failed, reason: getaddrinfo ENOTFOUND datasets.example" : null) }));
    expect(out).toMatchObject({ outcome: "posted", status: 200 });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.find((i) => i.key === "pii:direct/basic")).toMatchObject({ verdict: "not_run", notRunReason: "egress_denied" });
    expect(items.find((i) => i.key === "prompt-extraction/basic")).toMatchObject({ verdict: "pass" });
    // PR #205 review round 3 [61] (amends decision 12): denied egress happened at RUN time, so the
    // completed run is incomplete — its verdict is not pass, and a workflow check bound to it fails
    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect(run.summary).toMatchObject({ verdict: "unknown", runtimeNotRun: 1 });
  });
});

// ===========================================================================
// PR #205 review (Codex), decisions 48 and 49 — each red first
// ===========================================================================
describe("PR #205 review: the runner's life", () => {
  const pfSelfTest = () =>
    buildSelfTest({
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
    });
  const registration = async () => ({ name: `promptfoo-loop-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await pfSelfTest() });
  const enrolmentToken = async () => {
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: "loop" });
    expect(t.statusCode, t.body).toBe(201);
    return t.json().token as string;
  };
  const loopOpts = (store: FileRunnerTokenStore, enrollmentToken: string | null, logs: string[], waits: number[], maxIterations: number) => ({
    engineId: "promptfoo" as const,
    engineVersion: MANIFEST.promptfoo.version,
    imageDigest: PF_DIGEST,
    workRoot: "",
    heartbeatMs: 25,
    retryBaseMs: 10,
    store,
    enrollmentToken,
    registration,
    backoffMs: 100,
    maxBackoffMs: 400,
    idleMs: 1,
    maxIterations,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    log: (m: string) => logs.push(m),
  });

  it("[48][49] a runner registered while the engine is off waits; a restart reuses its stored token; revoked, it stops or re-enrols", async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), "b5p-loop-"));
    const store = new FileRunnerTokenStore(path.join(workRoot, "state", "runner-token"));
    const adapter = promptfooAdapter({ entrypoint: "/opt/promptfoo/node_modules/promptfoo/dist/src/entrypoint.js", run: promptfooStandIn().run });
    // the engine is off (tightening needs no step-up): the documented flow is register → enable
    expect((await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: false })).statusCode).toBe(200);
    const spent = await enrolmentToken();
    const logs: string[] = [];
    const waits: number[] = [];
    const first = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
    // [48] five refused leases: the loop waits with a capped backoff instead of exiting
    await runRunnerLoop(first, adapter, { ...loopOpts(store, spent, logs, waits, 5), workRoot });
    expect(waits).toEqual([100, 200, 400, 400, 400]);
    expect(logs.some((l) => /state: leasing -> waiting \(admin_disabled\)/.test(l))).toBe(true);
    // [49] the token is on the runner's volume, 0600, and never in a log line
    const token = await store.load();
    expect(token).toMatch(/^rge_/);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toContain(token!);
    const runnerId = /registered runner ([0-9a-f-]{36})/.exec(logs.join("\n"))![1]!;

    // the admin enables it again (a step-up); a run is queued
    const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(st.json().passed, st.body).toBe(true);
    const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true });
    expect((await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) })).statusCode).toBe(200);
    const runId = await startRun();
    // [49] a RESTART: a new client, the same volume, the same (spent) enrolment token in the env —
    // the stored token is used, the enrolment token is not, and the run is leased and posted
    const restartLogs: string[] = [];
    const restarted = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
    await runRunnerLoop(restarted, adapter, { ...loopOpts(store, spent, restartLogs, [], 1), workRoot });
    expect(restartLogs[0]).toBe("using the stored runner token");
    expect(restartLogs.some((l) => l.startsWith(`run ${runId}: posted`))).toBe(true);
    expect((await runRow(runId)).status).toBe("completed");

    // revoked: with only the spent enrolment token it stops with a message saying what to do
    expect((await inject("DELETE", `/v1/engine-runners/${runnerId}`, admin.key)).statusCode).toBe(200);
    const stopped = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
    await expect(runRunnerLoop(stopped, adapter, { ...loopOpts(store, spent, [], [], 3), workRoot })).rejects.toThrow(RunnerFatalError);
    await expect(runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), adapter, { ...loopOpts(store, null, [], [], 3), workRoot })).rejects.toThrow(
      /mint a new enrolment token/,
    );
    // with a fresh enrolment token it re-enrols and replaces the stored token
    const fresh = await enrolmentToken();
    const reLogs: string[] = [];
    await runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), adapter, { ...loopOpts(store, fresh, reLogs, [], 1), workRoot });
    const replaced = await store.load();
    expect(replaced).toMatch(/^rge_/);
    expect(replaced).not.toBe(token);
    expect(reLogs.some((l) => /state: leasing -> reenrolling \(revoked\)/.test(l))).toBe(true);
    expect(reLogs.some((l) => /registered runner/.test(l))).toBe(true);
  });
});

// ===========================================================================
// PR #205 review round 2 (Codex), decisions 53 and 54 — each red first
// ===========================================================================
describe("PR #205 review round 2: self-test refresh and lost registration responses", () => {
  const freshSelfTest = (over: { addressConnected?: boolean; digest?: string } = {}) =>
    buildSelfTest({
      imageDigest: over.digest ?? PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: {
        host: "egress-probe.invalid",
        ip: "93.184.215.14",
        lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
        connect: async (h: string) => (over.addressConnected && h === "93.184.215.14" ? "connected" : "denied"),
      },
    });
  const audits = async (ruleId: string, objectId: string) =>
    (await db.execute(sql`SELECT detail FROM audit_log WHERE rule_id = ${ruleId} AND object_id = ${objectId}`)) as unknown as { rows: Array<{ detail: Record<string, unknown> }> };

  it("[53] a stale self-test is refreshed by the runner on its own route: the lease is refused, the loop submits a fresh report, and work resumes", async () => {
    // the 24 hours pass: the runner's stored report and the engine's recorded self-test are stale
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    await db.execute(sql`UPDATE engine_runners SET self_test = jsonb_set(self_test, '{at}', to_jsonb(${old}::text)) WHERE id = ${firstRunnerId}`);
    await db.execute(sql`UPDATE engines SET self_test_passed_at = ${old}::timestamptz WHERE id = 'promptfoo'`);
    const refused = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${firstRunnerSecret}` }, PF_BUILD);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("engine_self_test_required");
    // the runner-token route accepts a fresh report, evaluated like registration's, and audits it
    const runId = await startRun();
    const workRoot = await mkdtemp(path.join(tmpdir(), "b5p-st-"));
    const store = new FileRunnerTokenStore(path.join(workRoot, "state", "runner-token"));
    await store.save(firstRunnerSecret);
    const logs: string[] = [];
    await runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), {
      engineId: "promptfoo",
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      workRoot,
      heartbeatMs: 25,
      retryBaseMs: 10,
      store,
      enrollmentToken: null,
      registration: async () => ({ name: "x", imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await freshSelfTest() }),
      backoffMs: 1,
      maxIterations: 2,
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => /submitted a fresh self-test: passed/.test(l))).toBe(true);
    expect((await runRow(runId)).status).toBe("completed");
    const passedAt = ((await db.execute(sql`SELECT self_test_passed_at FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ self_test_passed_at: string }> }).rows[0]!.self_test_passed_at;
    expect(Date.now() - new Date(passedAt).getTime()).toBeLessThan(60_000);
    expect((await audits("engine-runner-self-test-refreshed", firstRunnerId)).rows.length).toBeGreaterThanOrEqual(1);
    // a report for another image is refused: round 5 [67], the runner is told to re-enrol
    const other = await inject("POST", "/v1/engine-runner/self-test", { authorization: `Bearer ${firstRunnerSecret}` }, { selfTest: await freshSelfTest({ digest: `sha256:${"e".repeat(64)}` }) });
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json()).toMatchObject({ error: "engine_runner_reenrol_required", next: "reenrol_required" });
  });

  it("[54] a register response lost after the gateway spent the enrolment token is recovered with the same secret", async () => {
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: "lost-response" });
    expect(t.statusCode, t.body).toBe(201);
    let dropped = 0;
    // the first register reaches the gateway (which spends the token and stores the runner), then the response is lost
    const lossy: RunnerHttp = async (url, init) => {
      const r = await runnerHttp(url, init);
      if (url.endsWith("/register") && dropped++ === 0) throw new Error("socket hang up");
      return r;
    };
    const workRoot = await mkdtemp(path.join(tmpdir(), "b5p-lost-"));
    const store = new FileRunnerTokenStore(path.join(workRoot, "state", "runner-token"));
    const logs: string[] = [];
    await runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: lossy }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), {
      engineId: "promptfoo",
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      workRoot,
      store,
      enrollmentToken: t.json().token,
      registration: async () => ({ name: `lost-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await freshSelfTest() }),
      backoffMs: 1,
      maxIterations: 1,
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    expect(dropped).toBe(2);
    expect(logs.some((l) => /registered runner .* \(replayed\)/.test(l))).toBe(true);
    // exactly one runner for that enrolment token, credentialed by the secret the runner stored
    const secret = (await store.load())!;
    const rows = ((await db.execute(sql`SELECT id, token_hash FROM engine_runners WHERE enrollment_token_id = ${t.json().id}`)) as unknown as { rows: Array<{ id: string; token_hash: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(runnerTokenHash(secret));
    expect((await audits("engine-runner-register-replayed", rows[0]!.id)).rows).toHaveLength(1);
    // the stored secret IS the credential: it leases (204 or a run), never 401
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${secret}` }, PF_BUILD);
    expect([200, 204]).toContain(l.statusCode);
  });

  it("[53] a failing fresh report switches the engine off and is audited", async () => {
    const bad = await inject("POST", "/v1/engine-runner/self-test", { authorization: `Bearer ${firstRunnerSecret}` }, { selfTest: await freshSelfTest({ addressConnected: true }) });
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json()).toMatchObject({ selfTest: { passed: false, failures: ["egress_address_connected"] }, engineDisabled: true });
    const enabled = ((await db.execute(sql`SELECT enabled FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean }> }).rows[0]!.enabled;
    expect(enabled).toBe(false);
    expect((await audits("engine-runner-self-test-failed", firstRunnerId)).rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// PR #205 review round 4 (Codex), decisions 64, 65 and 66 — each red first
// (runs after round 2's last case, which left the engine disabled by the first runner's failed report)
// ===========================================================================
describe("PR #205 review round 4: disabled for a failed report, the self-test race, strategy-only plans", () => {
  const passingReport = () =>
    buildSelfTest({
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
    });
  const engineRow = async () =>
    ((await db.execute(sql`SELECT enabled, self_test_passed_at FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean; self_test_passed_at: string | null }> }).rows[0]!;
  const runnerRow = async (id: string) =>
    ((await db.execute(sql`SELECT self_test_passed, revoked_at, self_test FROM engine_runners WHERE id = ${id}`)) as unknown as { rows: Array<{ self_test_passed: boolean; revoked_at: string | null; self_test: { at: string } }> }).rows[0]!;
  const auth = () => ({ authorization: `Bearer ${firstRunnerSecret}` });

  it("[64] the engine is off and THIS runner's report failed: the lease asks for a report; a passing one updates only the runner, never re-enables", async () => {
    expect((await engineRow()).enabled).toBe(false);
    const refused = await inject("POST", "/v1/engine-runner/lease", auth(), PF_BUILD);
    expect(refused.statusCode, refused.body).toBe(409);
    // round 5: the runner's own report is judged first, whatever the engine's state
    expect(refused.json()).toMatchObject({ error: "engine_self_test_required", next: "self_test_required" });
    const ok = await inject("POST", "/v1/engine-runner/self-test", auth(), { selfTest: await passingReport() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ selfTest: { passed: true }, next: "admin_disabled", engineRefreshed: false, engineDisabled: false });
    expect((await runnerRow(firstRunnerId)).self_test_passed).toBe(true);
    // the engine stays off: re-enabling is an admin action with a step-up
    expect((await engineRow()).enabled).toBe(false);
    const after = await inject("POST", "/v1/engine-runner/lease", auth(), PF_BUILD);
    expect(after.json()).toMatchObject({ error: "engine_disabled", next: "admin_disabled" });
  });

  it("[65] a self-test report that lands after the runner was revoked touches neither the runner nor the engine", async () => {
    // a fresh runner for the race: its row is revoked between the route's pre-checks and its transaction
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: "race" });
    const secret = generateRunnerSecret();
    const racer = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
    const reg = await racer.register(t.json().token, secret, { name: `race-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await passingReport() });
    // its stored report is a FAILING one, which (enabled) would switch the engine off. The engine is
    // enabled directly here (round 2's failed report cleared its pass, and the check constraint wants one)
    await db.execute(sql`UPDATE engines SET enabled = true, self_test_passed_at = now() WHERE id = 'promptfoo'`);
    const before = await runnerRow(reg.runnerId);
    engineRunTestHooks.beforeSelfTestTx = async (runnerId) => {
      if (runnerId === reg.runnerId) await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'revoked mid-self-test' WHERE id = ${reg.runnerId}`);
    };
    try {
      const failing = await buildSelfTest({
        imageDigest: PF_DIGEST,
        engineVersion: MANIFEST.promptfoo.version,
        requiredEnv: MANIFEST.promptfoo.usageDataEnv,
        env: { ...MANIFEST.promptfoo.usageDataEnv },
        egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "connected" },
      });
      const r = await inject("POST", "/v1/engine-runner/self-test", { authorization: `Bearer ${secret}` }, { selfTest: failing });
      expect(r.statusCode, r.body).toBe(401);
      expect(r.json()).toMatchObject({ error: "engine_runner_revoked", next: "revoked" });
    } finally {
      engineRunTestHooks.beforeSelfTestTx = undefined;
      // leave the engine as the suite's afterAll expects to reset it
    }
    expect((await engineRow()).enabled).toBe(true);
    const afterRow = await runnerRow(reg.runnerId);
    expect(afterRow.self_test_passed).toBe(true);
    expect(afterRow.self_test.at).toBe(before.self_test.at);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });

  it("[66] a strategy-only plan is refused at validation with a clear error", async () => {
    const r = await inject("POST", "/v1/engine-runs", alice.key, {
      engineId: "promptfoo",
      target: { agentId: targetId, judgeAgentId: judgeId },
      config: { sets: ["strategy:base64"] },
      projectId,
      budgetUsd: 1,
      trials: 2,
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "engine_config_invalid" });
    expect(r.json().detail).toMatch(/at least one plugin/);
  });
});

// ===========================================================================
// PR #205 review round 5 (Codex), decisions 67 to 70 — each red first. The runner loop is a state
// machine driven by the gateway's `next` signal (the table is pinned in packages/engine-runner).
// (runs after round 4, which left the engine off)
// ===========================================================================
describe("PR #205 review round 5: the runner state machine against the real gateway; dispatchable agents", () => {
  const report = (digest = PF_DIGEST) =>
    buildSelfTest({
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
    });
  const engineOn = async () => ((await db.execute(sql`SELECT enabled FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean }> }).rows[0]!.enabled;
  const runner = async (id: string) =>
    ((await db.execute(sql`SELECT revoked_at, revoke_reason, reported_digest FROM engine_runners WHERE id = ${id}`)) as unknown as {
      rows: Array<{ revoked_at: string | null; revoke_reason: string | null; reported_digest: string }>;
    }).rows[0]!;
  const enrolmentToken = async (label: string) => (await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label })).json().token as string;
  const register = async (label: string, digest = PF_DIGEST) => {
    const secret = generateRunnerSecret();
    const reg = await new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }).register(await enrolmentToken(label), secret, {
      name: `${label}-${RUN}`,
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(digest),
    });
    return { secret, runnerId: reg.runnerId };
  };
  const loop = async (secret: string, over: { imageDigest?: string; enrollmentToken?: string | null; maxIterations?: number } = {}) => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5p-r5-"));
    const store = new FileRunnerTokenStore(path.join(dir, "state", "runner-token"));
    await store.save(secret);
    const logs: string[] = [];
    const digest = over.imageDigest ?? PF_DIGEST;
    const run = runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), {
      engineId: "promptfoo",
      engineVersion: MANIFEST.promptfoo.version,
      imageDigest: digest,
      workRoot: path.join(dir, "work"),
      store,
      enrollmentToken: over.enrollmentToken ?? null,
      registration: async () => ({ name: `loop-${RUN}`, imageDigest: digest, engineVersion: MANIFEST.promptfoo.version, selfTest: await report(digest) }),
      backoffMs: 1,
      maxIterations: over.maxIterations ?? 2,
      sleep: async () => {},
      log: (m) => logs.push(m),
    });
    return { run, logs, store };
  };
  let liveSecret = "";

  it("[69] the engine is off and the runner's report went stale: the loop refreshes it anyway, so an admin can enable", async () => {
    expect(await engineOn()).toBe(false);
    const { secret, runnerId } = await register("stale-while-off");
    liveSecret = secret;
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    await db.execute(sql`UPDATE engine_runners SET self_test = jsonb_set(self_test, '{at}', to_jsonb(${old}::text)) WHERE id = ${runnerId}`);
    // before: the admin's self-test reads a stale report and cannot pass, so the engine cannot be enabled
    const before = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(before.json().passed, before.body).toBe(false);
    const l = await loop(secret);
    await l.run;
    expect(l.logs.some((m) => /state: leasing -> refreshing \(self_test_required\)/.test(m))).toBe(true);
    expect(l.logs.some((m) => /state: refreshing -> waiting \(admin_disabled\)/.test(m))).toBe(true);
    expect(await engineOn()).toBe(false); // a fresh report never switches the engine on
    const after = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(after.json().passed, after.body).toBe(true);
  });

  it("[67] an upgraded runner under an old-build credential is told to re-enrol; without an enrolment token it stops, its state untouched", async () => {
    const NEW = `sha256:${"f".repeat(64)}`;
    const { secret, runnerId } = await register("upgrade-stop");
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${secret}` }, { imageDigest: NEW, engineVersion: MANIFEST.promptfoo.version });
    expect(l.statusCode, l.body).toBe(409);
    expect(l.json()).toMatchObject({ error: "engine_runner_reenrol_required", next: "reenrol_required" });
    const stopped = await loop(secret, { imageDigest: NEW });
    await expect(stopped.run).rejects.toThrow(/another build.*mint a new enrolment token/);
    expect(await stopped.store.load()).toBe(secret);
    expect((await runner(runnerId)).revoked_at).toBeNull();
  });

  it("[67] with an enrolment token it re-enrols with a new secret and the old registration is revoked in the same step, audited", async () => {
    const NEW = `sha256:${"f".repeat(64)}`;
    const { secret, runnerId } = await register("upgrade-reenrol");
    const l = await loop(secret, { imageDigest: NEW, enrollmentToken: await enrolmentToken("upgrade-new"), maxIterations: 1 });
    await l.run;
    const replaced = (await l.store.load())!;
    expect(replaced).not.toBe(secret);
    const old = await runner(runnerId);
    expect(old.revoked_at).not.toBeNull();
    expect(old.revoke_reason).toMatch(/superseded/);
    const audit = ((await db.execute(sql`SELECT detail FROM audit_log WHERE rule_id = 'engine-runner-superseded' AND object_id = ${runnerId}`)) as unknown as { rows: unknown[] }).rows;
    expect(audit).toHaveLength(1);
    const [fresh] = ((await db.execute(sql`SELECT id, reported_digest FROM engine_runners WHERE token_hash = ${runnerTokenHash(replaced)}`)) as unknown as { rows: Array<{ id: string; reported_digest: string }> }).rows;
    expect(fresh).toMatchObject({ reported_digest: NEW });
    // the old token authenticates nothing now
    const gone = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${secret}` }, PF_BUILD);
    expect(gone.statusCode).toBe(401);
    // a `supersedes` that is not a live runner of this engine revokes nothing
    const other = await register("upgrade-bystander");
    const t = await enrolmentToken("upgrade-unrelated");
    const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${t}` }, {
      name: "unrelated",
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(),
      tokenHash: runnerTokenHash(generateRunnerSecret()),
      supersedes: generateRunnerSecret(),
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().supersededRunnerId).toBeNull();
    expect((await runner(other.runnerId)).revoked_at).toBeNull();
  });

  it("[70] a target or judge with no provider model is refused at validation (422 agent_not_dispatchable)", async () => {
    for (const [role, id] of [["target", targetId], ["judge", judgeId]] as const) {
      const [{ model }] = ((await db.execute(sql`SELECT model FROM agents WHERE id = ${id}`)) as unknown as { rows: Array<{ model: string | null }> }).rows as [{ model: string | null }];
      await db.execute(sql`UPDATE agents SET model = NULL WHERE id = ${id}`);
      try {
        await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
        const r = await inject("POST", "/v1/engine-runs", alice.key, {
          engineId: "promptfoo",
          target: { agentId: targetId, judgeAgentId: judgeId },
          config: { sets: ["prompt-extraction"] },
          projectId,
          budgetUsd: 1,
          trials: 2,
        });
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json()).toMatchObject({ error: "agent_not_dispatchable" });
        expect(r.json().detail).toContain(role);
      } finally {
        await db.execute(sql`UPDATE agents SET model = ${model} WHERE id = ${id}`);
        await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
      }
    }
  });

  it("[70] an agent that loses its model after the run was queued is never dispatched under its display name: the run ends not_run", async () => {
    const queued = ((await db.execute(sql`SELECT count(*)::int AS n FROM engine_runs WHERE engine_id = 'promptfoo' AND status = 'queued'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(queued).toBe(0);
    // the engine is on ([69] left a fresh passing record for this build)
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    const [{ model }] = ((await db.execute(sql`SELECT model FROM agents WHERE id = ${targetId}`)) as unknown as { rows: Array<{ model: string | null }> }).rows as [{ model: string | null }];
    try {
      const runId = await startRun();
      await db.execute(sql`UPDATE agents SET model = NULL WHERE id = ${targetId}`);
      const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
      expect(l.statusCode, l.body).toBe(204);
      expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "agent_not_dispatchable", virtualKeyId: null });
    } finally {
      await db.execute(sql`UPDATE agents SET model = ${model} WHERE id = ${targetId}`);
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });
});

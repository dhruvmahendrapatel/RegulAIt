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
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  ENGINE_RESULT_VERSION,
  ENGINE_TAXONOMY,
  STEP_UP_HEADER,
  type EngineId,
  type EngineManifestEntry,
} from "@regulait/shared";
import { buildSelfTest, FileRunnerTokenStore, generateRunnerSecret, runOnce, RunnerClient, RunnerFatalError, runRunnerLoop, runnerTokenHash, type RunnerHttp } from "@regulait/engine-runner";
import { promptfooAdapter } from "@regulait/engine-promptfoo";
import { buildApp } from "./app.js";
import { engineRunTestHooks, runEngineRunSweep, runEngineScheduleSweep } from "./engine-runs.js";
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
/**
 * PR #205 review round 12 [91]: registration refuses a build that is not the current one, so a
 * runner "of an earlier build" is made the way an upgrade leaves one — registered while its build was
 * current, its row and report now naming a build the manifest has moved on from.
 */
async function makeObsolete(runnerId: string, digest: string) {
  await db.execute(
    sql`UPDATE engine_runners SET reported_digest = ${digest}, self_test = jsonb_set(self_test, '{imageDigest}', to_jsonb(${digest}::text)) WHERE id = ${runnerId}`,
  );
}
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
  const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true });
  expect(refused.statusCode, refused.body).toBe(403);
  const ok = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
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
    const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true });
    expect((await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) })).statusCode).toBe(200);
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
    // with a fresh enrolment token it re-enrols and replaces the stored token. Round 6 [72]: the
    // refused attempt above left its pending enrolment, so the restart resumes THAT one (same secret)
    const pending = (await store.loadPending())!;
    expect(pending).toMatchObject({ supersedes: null });
    expect(await store.load()).toBe(token); // a refused enrolment never replaced the stored token
    const fresh = await enrolmentToken();
    const reLogs: string[] = [];
    await runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), adapter, { ...loopOpts(store, fresh, reLogs, [], 1), workRoot });
    const replaced = await store.load();
    expect(replaced).toBe(pending.secret);
    expect(replaced).not.toBe(token);
    expect(await store.loadPending()).toBeNull();
    expect(reLogs.some((l) => /resuming an interrupted enrolment/.test(l))).toBe(true);
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
    // a run is queued while all is fresh (round 11 [87]: creation itself needs the engine's record
    // to admit it); then the 24 hours pass: the runner's stored report and the engine's record are stale
    const runId = await startRun();
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    await db.execute(sql`UPDATE engine_runners SET self_test = jsonb_set(self_test, '{at}', to_jsonb(${old}::text)) WHERE id = ${firstRunnerId}`);
    await db.execute(sql`UPDATE engines SET self_test_passed_at = ${old}::timestamptz WHERE id = 'promptfoo'`);
    const refused = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${firstRunnerSecret}` }, PF_BUILD);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("engine_self_test_required");
    // the runner-token route accepts a fresh report, evaluated like registration's, and audits it
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
/** the runner [69] registers with a fresh report: rounds 5 and 6 lease with it */
let liveSecret = "";
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
    // round 12: the old runner registered on a build the manifest has since moved on from; the restarted one runs the current build
    const OLD = `sha256:${"f".repeat(64)}`;
    const { secret, runnerId } = await register("upgrade-reenrol");
    await makeObsolete(runnerId, OLD);
    const l = await loop(secret, { imageDigest: PF_DIGEST, enrollmentToken: await enrolmentToken("upgrade-new"), maxIterations: 1 });
    await l.run;
    const replaced = (await l.store.load())!;
    expect(replaced).not.toBe(secret);
    const old = await runner(runnerId);
    expect(old.revoked_at).not.toBeNull();
    expect(old.revoke_reason).toMatch(/superseded/);
    const audit = ((await db.execute(sql`SELECT detail FROM audit_log WHERE rule_id = 'engine-runner-superseded' AND object_id = ${runnerId}`)) as unknown as { rows: unknown[] }).rows;
    expect(audit).toHaveLength(1);
    const [fresh] = ((await db.execute(sql`SELECT id, reported_digest FROM engine_runners WHERE token_hash = ${runnerTokenHash(replaced)}`)) as unknown as { rows: Array<{ id: string; reported_digest: string }> }).rows;
    expect(fresh).toMatchObject({ reported_digest: PF_DIGEST });
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

// ===========================================================================
// PR #205 review round 6 (Codex), decisions 71 to 73 — each red first (runs after round 5: the
// engine is off, with a fresh passing record; `liveSecret` is a runner with a fresh report)
// ===========================================================================
describe("PR #205 review round 6: admission under locks, interrupted re-enrolment, a judge where the manifest needs one", () => {
  const report = (digest = PF_DIGEST, connected = false) =>
    buildSelfTest({
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: {
        host: "egress-probe.invalid",
        ip: "93.184.215.14",
        lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
        connect: async () => (connected ? "connected" : "denied"),
      },
    });
  const keysOfRun = async (runId: string) =>
    ((await db.execute(sql`SELECT count(*)::int AS n FROM virtual_keys WHERE engine_run_id = ${runId}`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
  const enrolmentToken = async (label: string) => (await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label })).json().token as string;

  for (const [what, race, next] of [
    ["an admin switches the engine off", async () => void (await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`)), "admin_disabled"],
    [
      "a failing report of this runner lands",
      async () => {
        const failing = await report(PF_DIGEST, true);
        await db.execute(sql`UPDATE engine_runners SET self_test = ${JSON.stringify(failing)}::jsonb, self_test_passed = false WHERE token_hash = ${runnerTokenHash(liveSecret)}`);
      },
      "self_test_required",
    ],
  ] as const) {
    it(`[71] ${what} between the lease's fast path and its transaction: no key is minted, the run stays queued`, async () => {
      await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
      const [before] = ((await db.execute(sql`SELECT self_test FROM engine_runners WHERE token_hash = ${runnerTokenHash(liveSecret)}`)) as unknown as { rows: Array<{ self_test: unknown }> }).rows;
      const runId = await startRun();
      engineRunTestHooks.beforeLeaseTx = async () => {
        await race();
      };
      try {
        const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
        expect(l.statusCode, l.body).toBe(409);
        expect(l.json().next).toBe(next);
      } finally {
        engineRunTestHooks.beforeLeaseTx = undefined;
        await db.execute(sql`UPDATE engine_runners SET self_test = ${JSON.stringify(before!.self_test)}::jsonb, self_test_passed = true WHERE token_hash = ${runnerTokenHash(liveSecret)}`);
      }
      expect(await runRow(runId)).toMatchObject({ status: "queued", virtualKeyId: null, runnerId: null });
      expect(await keysOfRun(runId)).toBe(0);
      await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {});
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    });
  }

  // two crash points: right after the pending record is written (nothing sent yet), and right after
  // the registration landed (the enrolment token is spent and the old runner already revoked) but
  // before the new token was stored — the case only resuming the pending record can recover
  for (const crashAt of ["savePending", "save"] as const) it(`[72] a re-enrolment interrupted (crash in ${crashAt}) is resumed on restart, and the old runner ends revoked`, async () => {
    // round 10 [85]: an upgrade — the old runner holds the OBSOLETE build, the restarted one runs the current
    const OLD = `sha256:${"f".repeat(64)}`;
    const oldSecret = generateRunnerSecret();
    const reg = await new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }).register(await enrolmentToken("crash-old"), oldSecret, {
      name: `crash-${RUN}`,
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(),
    });
    await makeObsolete(reg.runnerId, OLD); // registered before the upgrade (round 12: registration refuses an obsolete build)
    const dir = await mkdtemp(path.join(tmpdir(), "b5p-r6-"));
    const store = new FileRunnerTokenStore(path.join(dir, "state", "runner-token"));
    await store.save(oldSecret);
    const token = await enrolmentToken("crash-new");
    const opts = (s: FileRunnerTokenStore) => ({
      engineId: "promptfoo" as const,
      engineVersion: MANIFEST.promptfoo.version,
      imageDigest: PF_DIGEST,
      workRoot: path.join(dir, "work"),
      store: s,
      enrollmentToken: token,
      registration: async () => ({ name: `crash-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await report() }),
      backoffMs: 1,
      maxIterations: 1,
      sleep: async () => {},
    });
    const crashing = Object.assign(
      Object.create(FileRunnerTokenStore.prototype) as FileRunnerTokenStore,
      store,
      crashAt === "savePending"
        ? {
            savePending: async (p: { secret: string; supersedes: string | null }) => {
              await store.savePending(p);
              throw new Error("killed");
            },
          }
        : {
            save: async () => {
              throw new Error("killed");
            },
          },
    );
    await expect(runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), opts(crashing))).rejects.toThrow("killed");
    const old = async () =>
      ((await db.execute(sql`SELECT revoked_at, revoke_reason FROM engine_runners WHERE id = ${reg.runnerId}`)) as unknown as { rows: Array<{ revoked_at: string | null; revoke_reason: string | null }> }).rows[0]!;
    if (crashAt === "savePending") expect((await old()).revoked_at).toBeNull();
    else expect((await old()).revoked_at).not.toBeNull(); // the registration landed, with its revocation
    expect(await store.load()).toBe(oldSecret);
    expect(await store.loadPending()).toMatchObject({ supersedes: oldSecret });
    // restart from the same volume
    await runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), opts(store));
    expect((await old()).revoked_at).not.toBeNull();
    expect((await old()).revoke_reason).toMatch(/superseded/);
    const now = (await store.load())!;
    expect(now).not.toBe(oldSecret);
    expect(await store.loadPending()).toBeNull();
    const [fresh] = ((await db.execute(sql`SELECT reported_digest FROM engine_runners WHERE token_hash = ${runnerTokenHash(now)}`)) as unknown as { rows: Array<{ reported_digest: string }> }).rows;
    expect(fresh).toMatchObject({ reported_digest: PF_DIGEST });
  });

  it("[73] a promptfoo run (or schedule) without a judge is refused at validation: 422 judge_required", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    try {
      const r = await inject("POST", "/v1/engine-runs", alice.key, {
        engineId: "promptfoo",
        target: { agentId: targetId },
        config: { sets: ["prompt-extraction"] },
        projectId,
        budgetUsd: 1,
        trials: 2,
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json()).toMatchObject({ error: "judge_required" });
      // a schedule is validated by the same function, so it is refused at creation too
      const s = await inject("POST", "/v1/engine-schedules", alice.key, {
        request: { engineId: "promptfoo", target: { agentId: targetId }, config: { sets: ["prompt-extraction"] }, projectId, budgetUsd: 1 },
        intervalHours: 24,
      });
      expect(s.statusCode, s.body).toBe(422);
      expect(s.json()).toMatchObject({ error: "judge_required" });
      const queued = ((await db.execute(sql`SELECT count(*)::int AS n FROM engine_runs WHERE engine_id = 'promptfoo' AND status = 'queued'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
      expect(queued).toBe(0);
    } finally {
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });
});

// ===========================================================================
// PR #205 review round 7 (Codex), decisions 74 to 76 — each red first ([74] is pinned in
// packages/engine-runner/src/loop.test.ts). Runs after round 6: the engine is off with a fresh
// passing record. The [75] build-change case runs last: it clears that record.
// ===========================================================================
describe("PR #205 review round 7: supersession ends runs in its transaction; leases and queues follow the build", () => {
  const report = () =>
    buildSelfTest({
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
    });
  const enrolmentToken = async (label: string) => (await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label })).json().token as string;
  const registerBody = async (label: string, secret: string, supersedes?: string) => ({
    name: `${label}-${RUN}`,
    imageDigest: PF_DIGEST,
    engineVersion: MANIFEST.promptfoo.version,
    selfTest: await report(),
    tokenHash: runnerTokenHash(secret),
    ...(supersedes ? { supersedes } : {}),
  });
  const newRunner = async (label: string) => {
    const secret = generateRunnerSecret();
    const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${await enrolmentToken(label)}` }, await registerBody(label, secret));
    expect(r.statusCode, r.body).toBe(201);
    return { secret, id: r.json().runnerId as string };
  };
  const keyRevoked = async (runId: string) => {
    const run = await runRow(runId);
    const [k] = ((await db.execute(sql`SELECT revoked_at FROM virtual_keys WHERE id = ${run.virtualKeyId}`)) as unknown as { rows: Array<{ revoked_at: string | null }> }).rows;
    return k!.revoked_at !== null;
  };
  /** a run leased (with its key) by the runner holding `secret` */
  const leasedBy = async (secret: string) => {
    const runId = await startRun();
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${secret}` }, PF_BUILD);
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().runId).toBe(runId);
    expect(await keyRevoked(runId)).toBe(false);
    return runId;
  };

  it("[76] a failure right after a superseding registration commits leaves no usable key: the runs ended in its transaction", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    try {
      const old = await newRunner("supersede-old");
      const runId = await leasedBy(old.secret);
      const secret = generateRunnerSecret();
      const token = await enrolmentToken("supersede-new");
      engineRunTestHooks.afterRegisterTx = () => {
        throw new Error("crashed after the commit");
      };
      try {
        const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${token}` }, await registerBody("supersede-new", secret, old.secret));
        expect(r.statusCode).toBe(500);
      } finally {
        engineRunTestHooks.afterRegisterTx = undefined;
      }
      expect(await runRow(runId)).toMatchObject({ status: "cancelled", errorCode: "runner_revoked" });
      expect(await keyRevoked(runId)).toBe(true);
      // the runner's retry is a replay of the same registration: the same runner, nothing left to end
      const again = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${token}` }, await registerBody("supersede-new", secret, old.secret));
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json()).toMatchObject({ replayed: true });
    } finally {
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });

  it("[76] a registration replay reconciles: a run still held by a revoked runner ends, and its key is revoked", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    try {
      const holder = await newRunner("reconcile-holder");
      const runId = await leasedBy(holder.secret);
      // the state an interrupted supersession used to leave: the runner revoked, its run and key still live
      await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'superseded (left behind)' WHERE id = ${holder.id}`);
      expect(await keyRevoked(runId)).toBe(false);
      const secret = generateRunnerSecret();
      const token = await enrolmentToken("reconcile-replay");
      const first = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${token}` }, await registerBody("reconcile-replay", secret));
      expect(first.statusCode, first.body).toBe(201);
      const replay = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${token}` }, await registerBody("reconcile-replay", secret));
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toMatchObject({ replayed: true });
      expect(await runRow(runId)).toMatchObject({ status: "cancelled", errorCode: "runner_revoked" });
      expect(await keyRevoked(runId)).toBe(true);
      // idempotent: a second replay finds nothing more to end
      const twice = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${token}` }, await registerBody("reconcile-replay", secret));
      expect(twice.statusCode).toBe(201);
    } finally {
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });

  it("[75] a lease takes only a run requested for the runner's engine version", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    const runId = await startRun();
    try {
      // a run requested before an upgrade (its version is not the one this runner runs)
      await db.execute(sql`UPDATE engine_runs SET engine_version = '0.0.1-old' WHERE id = ${runId}`);
      const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
      expect(l.statusCode, l.body).toBe(204);
      expect(await runRow(runId)).toMatchObject({ status: "queued", runnerId: null, virtualKeyId: null });
    } finally {
      await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {});
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });

  it("[75] a manifest build change cancels the runs still waiting (engine_build_changed, audited)", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    const runId = await startRun();
    // the shipped manifest moved on since this run was queued: the row (and the run) still say the old build
    await db.execute(sql`UPDATE engine_runs SET engine_version = '0.0.1-old' WHERE id = ${runId}`);
    await db.execute(sql`UPDATE engines SET version = '0.0.1-old' WHERE id = 'promptfoo'`);
    const v = await inject("GET", "/v1/engines", admin.key); // any engine route syncs the manifest
    expect(v.statusCode, v.body).toBe(200);
    expect(await runRow(runId)).toMatchObject({ status: "cancelled", errorCode: "engine_build_changed" });
    const audit = ((await db.execute(sql`SELECT detail FROM audit_log WHERE object_type = 'engine_run' AND object_id = ${runId} AND rule_id = 'engine-run-cancelled'`)) as unknown as { rows: unknown[] }).rows;
    expect(audit).toHaveLength(1);
    const [engine] = ((await db.execute(sql`SELECT enabled, version FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean; version: string }> }).rows;
    expect(engine).toMatchObject({ enabled: false, version: MANIFEST.promptfoo.version });
  });
});

// ===========================================================================
// PR #205 review round 8 (Codex), decisions 77 and 78 — each red first (runs after round 7)
// ===========================================================================
describe("PR #205 review round 8: a lost registration response outlives its token; the manifest sync decides on the locked row", () => {
  const report = (digest = PF_DIGEST) =>
    buildSelfTest({
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
    });
  const mintToken = async (label: string) => {
    const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label });
    expect(t.statusCode, t.body).toBe(201);
    return { token: t.json().token as string, id: t.json().id as string };
  };

  it("[77] a registration that committed, its response lost until the enrolment token expired: the restart tries the secret and leases", async () => {
    // round 10 [85]: an upgrade — the old runner holds the OBSOLETE build, the restarted one runs the current
    const OLD = `sha256:${"f".repeat(64)}`;
    const oldSecret = generateRunnerSecret();
    const old = await mintToken("lost-old");
    const oldReg = await new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }).register(old.token, oldSecret, {
      name: `lost-old-${RUN}`,
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(),
    });
    await makeObsolete(oldReg.runnerId, OLD); // registered before the upgrade (round 12: registration refuses an obsolete build)
    const dir = await mkdtemp(path.join(tmpdir(), "b5p-r8-"));
    const store = new FileRunnerTokenStore(path.join(dir, "state", "runner-token"));
    await store.save(oldSecret);
    const fresh = await mintToken("lost-new");
    const opts = (http: RunnerHttp) => ({
      client: new RunnerClient({ gatewayUrl: "http://gateway.test", http }),
      o: {
        engineId: "promptfoo" as const,
        engineVersion: MANIFEST.promptfoo.version,
        imageDigest: PF_DIGEST,
        workRoot: path.join(dir, "work"),
        store,
        enrollmentToken: fresh.token,
        registration: async () => ({ name: `lost-new-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await report() }),
        backoffMs: 1,
        registerAttempts: 2,
        maxIterations: 1,
        sleep: async () => {},
      },
    });
    // every registration reaches the gateway (and commits), every response is lost
    const lossy: RunnerHttp = async (url, init) => {
      const r = await runnerHttp(url, init);
      if (url.endsWith("/register")) throw new Error("socket hang up");
      return r;
    };
    const first = opts(lossy);
    await expect(runRunnerLoop(first.client, promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), first.o)).rejects.toThrow(RunnerFatalError);
    const pending = (await store.loadPending())!;
    expect(await store.load()).toBe(oldSecret);
    // ... and the enrolment token expires before the runner comes back
    await db.execute(sql`UPDATE engine_enrollment_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = ${fresh.id}`);
    const second = opts(runnerHttp);
    const logs: string[] = [];
    await runRunnerLoop(second.client, promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), { ...second.o, log: (m: string) => void logs.push(m) });
    expect(logs.some((l) => /had registered: its secret is this runner's credential/.test(l))).toBe(true);
    expect(await store.load()).toBe(pending.secret);
    expect(await store.loadPending()).toBeNull();
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${pending.secret}` }, PF_BUILD);
    expect(l.statusCode, l.body).not.toBe(401);
    // the old registration was superseded when that registration committed
    const [o] = ((await db.execute(sql`SELECT revoked_at FROM engine_runners WHERE token_hash = ${runnerTokenHash(oldSecret)}`)) as unknown as { rows: Array<{ revoked_at: string | null }> }).rows;
    expect(o!.revoked_at).not.toBeNull();
  });

  it("[77] a fresh enrolment token with an already-registered hash: a clear 409, and the token is not spent", async () => {
    const secret = generateRunnerSecret();
    const a = await mintToken("dup-a");
    const body = { name: `dup-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await report(), tokenHash: runnerTokenHash(secret) };
    expect((await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${a.token}` }, body)).statusCode).toBe(201);
    const b = await mintToken("dup-b");
    const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${b.token}` }, body);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "engine_runner_already_registered" });
    const [t] = ((await db.execute(sql`SELECT used_at FROM engine_enrollment_tokens WHERE id = ${b.id}`)) as unknown as { rows: Array<{ used_at: string | null }> }).rows;
    expect(t!.used_at).toBeNull();
  });

  it("[78] a sync that read the old build, racing one that installed the new build and a refreshed self-test, does not reset the engine", async () => {
    // the row still names an old build: a sync reads that (unlocked) and decides to look closer...
    await db.execute(sql`UPDATE engines SET version = '0.0.1-old', enabled = false WHERE id = 'promptfoo'`);
    const record = { passed: true, failures: [], runnerId: null, imageDigest: PF_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    const disabledAudits = async () =>
      ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE rule_id = 'engine-disabled-manifest-changed'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    const auditsBefore = await disabledAudits();
    let raced = false;
    engineRunTestHooks.beforeSyncTx = async (id) => {
      if (id !== "promptfoo" || raced) return;
      raced = true;
      // ...while another connection installs the new build, a self-test passes and an admin enables it
      await db.execute(
        sql`UPDATE engines SET version = ${MANIFEST.promptfoo.version}, image_digest = ${PF_DIGEST}, self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true WHERE id = 'promptfoo'`,
      );
    };
    try {
      const v = await inject("GET", "/v1/engines", admin.key);
      expect(v.statusCode, v.body).toBe(200);
    } finally {
      engineRunTestHooks.beforeSyncTx = undefined;
    }
    expect(raced).toBe(true);
    const [e] = ((await db.execute(sql`SELECT enabled, self_test_passed_at, self_test FROM engines WHERE id = 'promptfoo'`)) as unknown as {
      rows: Array<{ enabled: boolean; self_test_passed_at: string | null; self_test: unknown }>;
    }).rows;
    expect(e).toMatchObject({ enabled: true });
    expect(e!.self_test_passed_at).not.toBeNull();
    expect(e!.self_test).not.toBeNull();
    expect(await disabledAudits()).toBe(auditsBefore);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });
});

// ===========================================================================
// PR #205 review round 9 (Codex), decisions 79 to 82 — each red first ([80] is pinned in
// packages/engine-promptfoo/src/promptfoo.test.ts). Runs after round 8: the engine is off with a fresh
// passing record; `liveSecret` is a runner with a fresh report. The [82] case runs last: it clears it.
// ===========================================================================
describe("PR #205 review round 9: credential-isolation gate, the judge at lease, in-flight runs on a build change", () => {
  const keyRevoked = async (runId: string) => {
    const run = await runRow(runId);
    if (!run.virtualKeyId) return null;
    const [k] = ((await db.execute(sql`SELECT revoked_at FROM virtual_keys WHERE id = ${run.virtualKeyId}`)) as unknown as { rows: Array<{ revoked_at: string | null }> }).rows;
    return k!.revoked_at !== null;
  };
  const enabled = async () => ((await db.execute(sql`SELECT enabled FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean }> }).rows[0]!.enabled;

  it("[79] a build without credential isolation is not enabled unless an admin accepts the risk with a step-up, audited", async () => {
    expect(ENGINE_MANIFEST.promptfoo.credentialIsolation).toBe(false);
    expect(await enabled()).toBe(false);
    const plain = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true });
    expect(plain.statusCode, plain.body).toBe(409);
    expect(plain.json()).toMatchObject({ error: "engine_credential_isolation_missing" });
    expect(plain.json().detail).toMatch(/runner token/);
    expect(await enabled()).toBe(false);
    // accepting it is a relaxation: the step-up binds to it
    const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action.body.values).toMatchObject({ "engine.promptfoo.acceptCredentialIsolationRisk": true });
    const ok = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await enabled()).toBe(true);
    const audit = ((await db.execute(sql`SELECT detail FROM audit_log WHERE rule_id = 'engine-credential-isolation-risk-accepted' ORDER BY seq DESC LIMIT 1`)) as unknown as {
      rows: Array<{ detail: Record<string, unknown> }>;
    }).rows;
    expect(audit[0]!.detail).toMatchObject({ engineId: "promptfoo", credentialIsolation: false });
    expect((await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: false })).statusCode).toBe(200);
  });

  it("[81] a run whose judge was deleted after queueing is never dispatched without one: it ends not_run, no key", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    try {
      const runId = await startRun();
      // what deleting the judge agent does to a queued run (the foreign key nulls it)
      await db.execute(sql`UPDATE engine_runs SET judge_agent_id = NULL WHERE id = ${runId}`);
      const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
      expect(l.statusCode, l.body).toBe(204);
      expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "judge_required", virtualKeyId: null });
      const audit = ((await db.execute(sql`SELECT detail FROM audit_log WHERE object_type = 'engine_run' AND object_id = ${runId} AND rule_id = 'engine-run-not-run'`)) as unknown as { rows: unknown[] }).rows;
      expect(audit).toHaveLength(1);
    } finally {
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });

  it("[82] a build change cancels runs in flight on the old build too: the key is revoked, no result is ever normalised against the new catalogue", async () => {
    await db.execute(sql`UPDATE engines SET enabled = true WHERE id = 'promptfoo'`);
    const runId = await startRun();
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().runId).toBe(runId);
    expect(await keyRevoked(runId)).toBe(false);
    // the shipped manifest moves on while the run is in flight
    await db.execute(sql`UPDATE engines SET version = '0.0.1-old' WHERE id = 'promptfoo'`);
    expect((await inject("GET", "/v1/engines", admin.key)).statusCode).toBe(200);
    expect(await runRow(runId)).toMatchObject({ status: "cancelled", errorCode: "engine_build_changed" });
    expect(await keyRevoked(runId)).toBe(true);
    // the old build's result arrives late: refused, never ingested
    const late = await inject("POST", `/v1/engine-runner/runs/${runId}/result`, { authorization: `Bearer ${liveSecret}` }, {
      version: ENGINE_RESULT_VERSION,
      runId,
      engineId: "promptfoo",
      engineVersion: MANIFEST.promptfoo.version,
      status: "completed",
      errorCode: null,
      items: [],
      notRun: [],
      rawReport: null,
    });
    expect(late.statusCode, late.body).toBe(409);
    expect(await runRow(runId)).toMatchObject({ status: "cancelled" });
  });
});

// ===========================================================================
// PR #205 review round 10 (Codex), decisions 83 to 85 — each red first ([83] is pinned in
// packages/engine-runner/src/runner.test.ts). Runs after round 9; `liveSecret` is a runner with a
// fresh report of the current build.
// ===========================================================================
describe("PR #205 review round 10: every switch-off ends the engine's runs; an obsolete build never changes the engine", () => {
  const report = (digest = PF_DIGEST, connected = false) =>
    buildSelfTest({
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: {
        host: "egress-probe.invalid",
        ip: "93.184.215.14",
        lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
        connect: async () => (connected ? "connected" : "denied"),
      },
    });
  const mintToken = async (label: string) => (await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label })).json().token as string;
  const register = async (label: string, digest = PF_DIGEST) => {
    const secret = generateRunnerSecret();
    const reg = await new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }).register(await mintToken(label), secret, {
      name: `${label}-${RUN}`,
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(digest),
    });
    return { secret, runnerId: reg.runnerId };
  };
  /** the engine on, with a fresh passing record of the current build (what an admin's enable leaves) */
  const switchOn = async () => {
    const record = { passed: true, failures: [], runnerId: null, imageDigest: PF_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    await db.execute(sql`UPDATE engines SET self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true WHERE id = 'promptfoo'`);
  };
  const engineOn = async () => ((await db.execute(sql`SELECT enabled FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean }> }).rows[0]!.enabled;
  const keyRevoked = async (runId: string) => {
    const run = await runRow(runId);
    const [k] = ((await db.execute(sql`SELECT revoked_at FROM virtual_keys WHERE id = ${run.virtualKeyId}`)) as unknown as { rows: Array<{ revoked_at: string | null }> }).rows;
    return k!.revoked_at !== null;
  };
  /** a run leased by the live runner, its key live; and one more queued behind it */
  const leasedAndQueued = async () => {
    const leasedId = await startRun();
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
    expect(l.statusCode, l.body).toBe(200);
    expect(l.json().runId).toBe(leasedId);
    expect(await keyRevoked(leasedId)).toBe(false);
    const queuedId = await startRun();
    return { leasedId, queuedId };
  };
  const expectEnded = async (ids: { leasedId: string; queuedId: string }, reason: string) => {
    expect(await runRow(ids.leasedId)).toMatchObject({ status: "cancelled", errorCode: reason });
    expect(await keyRevoked(ids.leasedId)).toBe(true);
    expect(await runRow(ids.queuedId)).toMatchObject({ status: "cancelled", errorCode: reason });
    // the runner holding it is told to stop, and its result is refused
    const hb = await inject("POST", `/v1/engine-runner/runs/${ids.leasedId}/heartbeat`, { authorization: `Bearer ${liveSecret}` }, { phase: "running", progress: 0.5 });
    expect(hb.statusCode, hb.body).toBe(200);
    expect(hb.json()).toMatchObject({ cancel: true });
    const late = await inject("POST", `/v1/engine-runner/runs/${ids.leasedId}/result`, { authorization: `Bearer ${liveSecret}` }, {
      version: ENGINE_RESULT_VERSION,
      runId: ids.leasedId,
      engineId: "promptfoo",
      engineVersion: MANIFEST.promptfoo.version,
      status: "completed",
      errorCode: null,
      items: [],
      notRun: [],
      rawReport: null,
    });
    expect(late.statusCode, late.body).toBe(409);
  };

  it("[84] another runner's failing self-test switches the engine off AND ends its runs, revoking their keys", async () => {
    await switchOn();
    const ids = await leasedAndQueued();
    const failer = await register("egress-fails");
    const bad = await inject("POST", "/v1/engine-runner/self-test", { authorization: `Bearer ${failer.secret}` }, { selfTest: await report(PF_DIGEST, true) });
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json()).toMatchObject({ engineDisabled: true });
    expect(await engineOn()).toBe(false);
    await expectEnded(ids, "engine_self_test_failed");
    await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE id = ${failer.runnerId}`);
  });

  it("[84] an admin's disable ends the engine's runs, revoking their keys", async () => {
    await switchOn();
    const ids = await leasedAndQueued();
    const off = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    await expectEnded(ids, "engine_disabled");
  });

  it("[84] a failing admin self-test ends the engine's runs, revoking their keys", async () => {
    await switchOn();
    const ids = await leasedAndQueued();
    // the newest live runner's report fails now (its egress connected)
    const failer = await register("admin-sees-fail");
    await db.execute(sql`UPDATE engine_runners SET self_test = ${JSON.stringify(await report(PF_DIGEST, true))}::jsonb WHERE id = ${failer.runnerId}`);
    const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(st.json().passed, st.body).toBe(false);
    expect(await engineOn()).toBe(false);
    await expectEnded(ids, "engine_self_test_failed");
    await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE id = ${failer.runnerId}`);
  });

  it("[85] during a rolling upgrade an obsolete-build runner is told to re-enrol, and its self-test cannot switch the upgraded engine off", async () => {
    await switchOn();
    const OLD = `sha256:${"e".repeat(64)}`;
    const old = await register("obsolete");
    await makeObsolete(old.runnerId, OLD); // registered before the upgrade (round 12: registration refuses an obsolete build)
    const before = ((await db.execute(sql`SELECT self_test FROM engine_runners WHERE id = ${old.runnerId}`)) as unknown as { rows: Array<{ self_test: { at: string } }> }).rows[0]!;
    // it presents its own (old) build, which matches its registration: still re-enrol, not a self-test
    const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${old.secret}` }, { imageDigest: OLD, engineVersion: MANIFEST.promptfoo.version });
    expect(l.statusCode, l.body).toBe(409);
    expect(l.json()).toMatchObject({ error: "engine_runner_reenrol_required", next: "reenrol_required" });
    // its (failing, old-build) report is refused: nothing about the runner or the engine changes, and it is audited
    const st = await inject("POST", "/v1/engine-runner/self-test", { authorization: `Bearer ${old.secret}` }, { selfTest: await report(OLD, true) });
    expect(st.statusCode, st.body).toBe(409);
    expect(st.json()).toMatchObject({ error: "engine_runner_reenrol_required", next: "reenrol_required" });
    expect(await engineOn()).toBe(true);
    const after = ((await db.execute(sql`SELECT self_test FROM engine_runners WHERE id = ${old.runnerId}`)) as unknown as { rows: Array<{ self_test: { at: string } }> }).rows[0]!;
    expect(after.self_test.at).toBe(before.self_test.at);
    const audit = ((await db.execute(sql`SELECT detail FROM audit_log WHERE rule_id = 'engine-runner-self-test-obsolete-build' AND object_id = ${old.runnerId}`)) as unknown as { rows: unknown[] }).rows;
    expect(audit).toHaveLength(1);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });
});

// ===========================================================================
// PR #205 review round 11 (Codex), decisions 86 to 88 (89 and 90 are pinned in packages/engine-runner)
// — each red first. Runs after round 10; `liveSecret` is a runner with a fresh report.
// ===========================================================================
describe("PR #205 review round 11: one transaction per state change", () => {
  const switchOn = async () => {
    const record = { passed: true, failures: [], runnerId: null, imageDigest: PF_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    await db.execute(sql`UPDATE engines SET self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true, max_budget_usd = 5 WHERE id = 'promptfoo'`);
  };
  const switchOff = () => db.execute(sql`UPDATE engines SET enabled = false, max_budget_usd = 5 WHERE id = 'promptfoo'`);
  const keyRevoked = async (runId: string) => {
    const run = await runRow(runId);
    const [k] = ((await db.execute(sql`SELECT revoked_at FROM virtual_keys WHERE id = ${run.virtualKeyId}`)) as unknown as { rows: Array<{ revoked_at: string | null }> }).rows;
    return k!.revoked_at !== null;
  };
  const runsNow = async () => ((await db.execute(sql`SELECT count(*)::int AS n FROM engine_runs WHERE engine_id = 'promptfoo'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
  const runBody = (budgetUsd = 1) => ({ engineId: "promptfoo", target: { agentId: targetId, judgeAgentId: judgeId }, config: { sets: ["prompt-extraction", "pii:direct"] }, projectId, budgetUsd, trials: 2 });

  it("[86] a cancel that crashes midway leaves nothing half-done: no marker on a live run; a cancel then ends it, key and all, at once", async () => {
    await switchOn();
    try {
      const runId = await startRun();
      const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
      expect(l.statusCode, l.body).toBe(200);
      engineRunTestHooks.afterCancelMarked = () => {
        throw new Error("crashed mid-cancel");
      };
      try {
        const c = await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {});
        expect(c.statusCode).toBe(500);
      } finally {
        engineRunTestHooks.afterCancelMarked = undefined;
      }
      // all or nothing: still leased, no marker, key live
      expect(await runRow(runId)).toMatchObject({ status: "leased", cancelRequestedAt: null });
      expect(await keyRevoked(runId)).toBe(false);
      const c = await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {});
      expect(c.statusCode, c.body).toBe(200);
      const row = await runRow(runId);
      expect(row).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
      expect(row.cancelRequestedAt).not.toBeNull();
      expect(await keyRevoked(runId)).toBe(true);
    } finally {
      await switchOff();
    }
  });

  it("[87] a disable landing between a run's validation and its insert: the run is refused, nothing is created", async () => {
    await switchOn();
    try {
      const before = await runsNow();
      engineRunTestHooks.beforeCreateTx = async () => {
        await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
      };
      try {
        const r = await inject("POST", "/v1/engine-runs", alice.key, runBody());
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json()).toMatchObject({ error: "engine_disabled" });
      } finally {
        engineRunTestHooks.beforeCreateTx = undefined;
      }
      expect(await runsNow()).toBe(before);
    } finally {
      await switchOff();
    }
  });

  it("[87] a budget-ceiling drop landing between validation and insert: the run is refused", async () => {
    await switchOn();
    try {
      const before = await runsNow();
      engineRunTestHooks.beforeCreateTx = async () => {
        await db.execute(sql`UPDATE engines SET max_budget_usd = 0.5 WHERE id = 'promptfoo'`);
      };
      try {
        const r = await inject("POST", "/v1/engine-runs", alice.key, runBody(1));
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json()).toMatchObject({ error: "engine_budget_exceeds_ceiling" });
      } finally {
        engineRunTestHooks.beforeCreateTx = undefined;
      }
      expect(await runsNow()).toBe(before);
    } finally {
      await switchOff();
    }
  });

  it("[88] a schedule switched off after the sweep read it is not claimed and starts nothing", async () => {
    await switchOn();
    try {
      const c = await inject("POST", "/v1/engine-schedules", alice.key, { request: runBody(), intervalHours: 24 });
      expect(c.statusCode, c.body).toBe(201);
      const id = c.json().schedule.id as string;
      const due = new Date(Date.now() - 1000);
      await db.execute(sql`UPDATE engine_schedules SET next_run_at = ${due.toISOString()}::timestamptz WHERE id = ${id}`);
      const before = await runsNow();
      engineRunTestHooks.beforeScheduleClaim = async (scheduleId) => {
        if (scheduleId === id) await db.execute(sql`UPDATE engine_schedules SET enabled = false WHERE id = ${id}`);
      };
      try {
        await runEngineScheduleSweep(db);
      } finally {
        engineRunTestHooks.beforeScheduleClaim = undefined;
      }
      expect(await runsNow()).toBe(before);
      const [s] = ((await db.execute(sql`SELECT next_run_at, last_run_id FROM engine_schedules WHERE id = ${id}`)) as unknown as { rows: Array<{ next_run_at: string; last_run_id: string | null }> }).rows;
      expect(new Date(s!.next_run_at).getTime()).toBe(due.getTime());
      expect(s!.last_run_id).toBeNull();
    } finally {
      await switchOff();
    }
  });
});

describe("PR #205 review round 11 (sweep): a sweep re-checks its condition on the locked row", () => {
  it("a lease renewed between the sweep's read and its end is not timed out", async () => {
    const record = { passed: true, failures: [], runnerId: null, imageDigest: PF_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    await db.execute(sql`UPDATE engines SET self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true WHERE id = 'promptfoo'`);
    try {
      const runId = await startRun();
      const l = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${liveSecret}` }, PF_BUILD);
      expect(l.statusCode, l.body).toBe(200);
      // the lease looks expired to the sweep's read...
      await db.execute(sql`UPDATE engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${runId}`);
      engineRunTestHooks.beforeSweepEnd = async (id) => {
        // ...and a heartbeat renews it before the sweep ends it
        if (id === runId) await db.execute(sql`UPDATE engine_runs SET lease_expires_at = now() + interval '90 seconds' WHERE id = ${runId}`);
      };
      try {
        await runEngineRunSweep(db);
      } finally {
        engineRunTestHooks.beforeSweepEnd = undefined;
      }
      expect(await runRow(runId)).toMatchObject({ status: "leased" });
      expect((await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {})).statusCode).toBe(200);
    } finally {
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
    }
  });
});

// ===========================================================================
// PR #205 review round 12 (Codex), decisions 91 to 93 — each red first. ONE predicate decides which
// runner reports count for the current build (`runnerCountsForCurrentBuild`). Runs last: its final
// case revokes every live runner.
// ===========================================================================
describe("PR #205 review round 12: only current-build runners count; a failing report always clears the pass; a revoked lost secret is replaced", () => {
  const report = (digest = PF_DIGEST, connected = false) =>
    buildSelfTest({
      imageDigest: digest,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: {
        host: "egress-probe.invalid",
        ip: "93.184.215.14",
        lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
        connect: async () => (connected ? "connected" : "denied"),
      },
    });
  const mintToken = async (label: string) => (await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label })).json().token as string;
  const register = async (label: string) => {
    const secret = generateRunnerSecret();
    const reg = await new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }).register(await mintToken(label), secret, {
      name: `${label}-${RUN}`,
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(),
    });
    return { secret, runnerId: reg.runnerId };
  };
  const switchOn = async () => {
    const record = { passed: true, failures: [], runnerId: null, imageDigest: PF_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    await db.execute(sql`UPDATE engines SET self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true WHERE id = 'promptfoo'`);
  };
  const engineRow = async () =>
    ((await db.execute(sql`SELECT enabled, self_test_passed_at, self_test FROM engines WHERE id = 'promptfoo'`)) as unknown as {
      rows: Array<{ enabled: boolean; self_test_passed_at: string | null; self_test: { passed?: boolean; runnerId?: string | null } | null }>;
    }).rows[0]!;

  it("[91] the admin self-test judges only a current-build runner: a newer obsolete runner's failing report cannot switch the engine off", async () => {
    await switchOn();
    const current = await register("current-build");
    // a newer runner whose registration is of a build the manifest has since moved on from, its report failing
    const obsolete = await register("newer-but-obsolete");
    await makeObsolete(obsolete.runnerId, `sha256:${"e".repeat(64)}`);
    await db.execute(sql`UPDATE engine_runners SET self_test = ${JSON.stringify(await report(`sha256:${"e".repeat(64)}`, true))}::jsonb WHERE id = ${obsolete.runnerId}`);
    const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json()).toMatchObject({ passed: true, runnerId: current.runnerId });
    expect((await engineRow()).enabled).toBe(true);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });

  it("[93] a failing current-build report while the engine is OFF still clears its pass: re-enabling is refused (engine_self_test_required)", async () => {
    await switchOn();
    expect((await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: false })).statusCode).toBe(200);
    expect((await engineRow()).self_test_passed_at).not.toBeNull();
    const r = await register("fails-while-off");
    const bad = await inject("POST", "/v1/engine-runner/self-test", { authorization: `Bearer ${r.secret}` }, { selfTest: await report(PF_DIGEST, true) });
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json()).toMatchObject({ selfTest: { passed: false }, engineDisabled: false });
    const row = await engineRow();
    expect(row.self_test_passed_at).toBeNull();
    expect(row.self_test).toMatchObject({ passed: false, runnerId: r.runnerId });
    const again = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("engine_self_test_required");
    await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE id = ${r.runnerId}`);
  });

  it("[92] registered, the credential lost before it was stored, then revoked: a restart with a fresh token registers a NEW credential; the revoked one stays dead", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5p-r12-"));
    const store = new FileRunnerTokenStore(path.join(dir, "state", "runner-token"));
    const opts = (enrollmentToken: string) => ({
      engineId: "promptfoo" as const,
      engineVersion: MANIFEST.promptfoo.version,
      imageDigest: PF_DIGEST,
      workRoot: path.join(dir, "work"),
      store,
      enrollmentToken,
      registration: async () => ({ name: `lost-revoked-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest: await report() }),
      backoffMs: 1,
      registerAttempts: 2,
      maxIterations: 1,
      sleep: async () => {},
    });
    // the registration commits, its response is lost every time, and the process ends: the secret is only pending
    const lossy: RunnerHttp = async (url, init) => {
      const r = await runnerHttp(url, init);
      if (url.endsWith("/register")) throw new Error("socket hang up");
      return r;
    };
    await expect(
      runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: lossy }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), opts(await mintToken("lost-1"))),
    ).rejects.toThrow(RunnerFatalError);
    const dead = (await store.loadPending())!.secret;
    expect(await store.load()).toBeNull();
    // an admin revokes the runner that registration created
    const [row] = ((await db.execute(sql`SELECT id FROM engine_runners WHERE token_hash = ${runnerTokenHash(dead)}`)) as unknown as { rows: Array<{ id: string }> }).rows;
    expect((await inject("DELETE", `/v1/engine-runners/${row!.id}`, admin.key)).statusCode).toBe(200);
    // restart with a fresh enrolment token
    const logs: string[] = [];
    await runRunnerLoop(new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }), promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: promptfooStandIn().run }), {
      ...opts(await mintToken("lost-2")),
      log: (m: string) => void logs.push(m),
    });
    const fresh = (await store.load())!;
    expect(fresh).not.toBe(dead);
    expect(await store.loadPending()).toBeNull();
    expect(logs.some((m) => /secret was revoked: registering a new one/.test(m))).toBe(true);
    const [live] = ((await db.execute(sql`SELECT revoked_at FROM engine_runners WHERE token_hash = ${runnerTokenHash(fresh)}`)) as unknown as { rows: Array<{ revoked_at: string | null }> }).rows;
    expect(live!.revoked_at).toBeNull();
    expect((await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${dead}` }, PF_BUILD)).statusCode).toBe(401);
    expect((await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${fresh}` }, PF_BUILD)).statusCode).not.toBe(401);
  });

  it("[91] with no live runner of the current build the admin self-test refuses (409) and changes nothing", async () => {
    await switchOn();
    const before = await engineRow();
    // every live runner gone, and one runner left of a build the manifest has moved on from
    await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE engine_id = 'promptfoo' AND revoked_at IS NULL`);
    const obsolete = await register("only-obsolete");
    await makeObsolete(obsolete.runnerId, `sha256:${"e".repeat(64)}`);
    const st = await inject("POST", "/v1/engines/promptfoo/self-test", admin.key);
    expect(st.statusCode, st.body).toBe(409);
    expect(st.json().error).toBe("engine_no_current_build_runner");
    const after = await engineRow();
    expect(after).toMatchObject({ enabled: true });
    expect(after.self_test_passed_at).toBe(before.self_test_passed_at);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });
});

describe("PR #205 review round 13: an idempotent lease; a monotonic manifest sync", () => {
  const report = () =>
    buildSelfTest({
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      requiredEnv: MANIFEST.promptfoo.usageDataEnv,
      env: { ...MANIFEST.promptfoo.usageDataEnv },
      egress: { host: "egress-probe.invalid", ip: "93.184.215.14", lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), connect: async () => "denied" },
    });
  const register = async (label: string) => {
    const token = (await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label })).json().token as string;
    const secret = generateRunnerSecret();
    const reg = await new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp }).register(token, secret, {
      name: `${label}-${RUN}`,
      imageDigest: PF_DIGEST,
      engineVersion: MANIFEST.promptfoo.version,
      selfTest: await report(),
    });
    return { secret, runnerId: reg.runnerId, bearer: { authorization: `Bearer ${secret}` } };
  };
  const switchOn = async () => {
    const record = { passed: true, failures: [], runnerId: null, imageDigest: PF_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    await db.execute(sql`UPDATE engines SET self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true WHERE id = 'promptfoo'`);
  };
  const keyRow = async (id: string) => {
    const [k] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, id));
    return k!;
  };
  const audits = async (ruleId: string, objectId?: string) =>
    Number(
      (
        (await db.execute(
          objectId
            ? sql`SELECT count(*)::int AS n FROM audit_log WHERE rule_id = ${ruleId} AND object_id = ${objectId}`
            : sql`SELECT count(*)::int AS n FROM audit_log WHERE rule_id = ${ruleId} AND detail->>'engineId' = 'promptfoo'`,
        )) as unknown as { rows: Array<{ n: number }> }
      ).rows[0]!.n,
    );

  it("[94] a retried lease with the same request id returns the SAME run, its key rotated (the old one revoked); the run's cost spans both keys", async () => {
    await switchOn();
    const r = await register("idempotent-lease");
    const runId = await startRun();
    const requestId = randomUUID();
    const first = await inject("POST", "/v1/engine-runner/lease", r.bearer, { ...PF_BUILD, requestId });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().runId).toBe(runId);
    const k1 = (await runRow(runId)).virtualKeyId!;
    expect((await runRow(runId)).leaseRequestId).toBe(requestId);
    // the response was lost: the runner retries with the same id
    const retry = await inject("POST", "/v1/engine-runner/lease", r.bearer, { ...PF_BUILD, requestId });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().runId).toBe(runId);
    expect(retry.json().deadlineAt).toBe(first.json().deadlineAt);
    expect(retry.json().target.apiKey).not.toBe(first.json().target.apiKey);
    const row = await runRow(runId);
    expect(row.status).toBe("leased");
    const k2 = row.virtualKeyId!;
    expect(k2).not.toBe(k1);
    // never two working keys: the old one is revoked in the same transaction
    expect((await keyRow(k1)).revokedAt).not.toBeNull();
    expect((await keyRow(k2)).revokedAt).toBeNull();
    expect((await keyRow(k2)).budgetUsd).toBe(row.budgetUsd);
    expect(await audits("engine-run-lease-reissued", runId)).toBe(1);
    // exactly one run is leased to this runner
    const leasedToR = (await db.execute(sql`SELECT count(*)::int AS n FROM engine_runs WHERE runner_id = ${r.runnerId} AND status = 'leased'`)) as unknown as { rows: Array<{ n: number }> };
    expect(leasedToR.rows[0]!.n).toBe(1);
    // spend on either key is the run's: cancelling it now records both
    await db.execute(sql`INSERT INTO usage_events (user_id, virtual_key_id, cost_usd) VALUES (${alice.id}, ${k1}, 0.125), (${alice.id}, ${k2}, 0.25)`);
    expect((await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {})).statusCode).toBe(200);
    expect((await runRow(runId)).costUsd).toBeCloseTo(0.375, 9);
    // the run no longer live under that lease: the same id leases nothing (the runner's next attempt is new)
    const late = await inject("POST", "/v1/engine-runner/lease", r.bearer, { ...PF_BUILD, requestId });
    expect(late.statusCode, late.body).toBe(204);
    await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE id = ${r.runnerId}`);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });

  it("[94] another runner presenting the same request id never gets the first runner's run, nor rotates its key", async () => {
    await switchOn();
    const a = await register("lease-owner");
    const b = await register("lease-thief");
    const runId = await startRun();
    const requestId = randomUUID();
    const first = await inject("POST", "/v1/engine-runner/lease", a.bearer, { ...PF_BUILD, requestId });
    expect(first.json().runId).toBe(runId);
    const k1 = (await runRow(runId)).virtualKeyId!;
    const other = await inject("POST", "/v1/engine-runner/lease", b.bearer, { ...PF_BUILD, requestId });
    expect([200, 204]).toContain(other.statusCode);
    if (other.statusCode === 200) expect(other.json().runId).not.toBe(runId);
    const row = await runRow(runId);
    expect(row.runnerId).toBe(a.runnerId);
    expect(row.virtualKeyId).toBe(k1);
    expect((await keyRow(k1)).revokedAt).toBeNull();
    expect(await audits("engine-run-lease-reissued", runId)).toBe(0);
    expect((await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {})).statusCode).toBe(200);
    await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE id IN (${a.runnerId}, ${b.runnerId})`);
    await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
  });

  it("[95] a replica whose manifest is older than the row writes nothing, cancels nothing, and refuses leases and creation (409, audited once)", async () => {
    await switchOn();
    const r = await register("outdated-replica");
    const runId = await startRun();
    // a newer replica installed generation 2, a new build, and its admin re-enabled it
    const NEW_DIGEST = `sha256:${"f".repeat(64)}`;
    const record = { passed: true, failures: [], runnerId: null, imageDigest: NEW_DIGEST, version: MANIFEST.promptfoo.version, egress: null, at: new Date().toISOString() };
    await db.execute(
      sql`UPDATE engines SET manifest_generation = ${MANIFEST.promptfoo.generation + 1}, image_digest = ${NEW_DIGEST}, self_test = ${JSON.stringify(record)}::jsonb, self_test_passed_at = now(), enabled = true WHERE id = 'promptfoo'`,
    );
    try {
      const auditsBefore = await audits("engine-manifest-outdated");
      // this replica (generation 1) syncs on every route: nothing is written
      expect((await inject("GET", "/v1/engines", admin.key)).statusCode).toBe(200);
      const lease = await inject("POST", "/v1/engine-runner/lease", r.bearer, { ...PF_BUILD, requestId: randomUUID() });
      expect(lease.statusCode, lease.body).toBe(409);
      expect(lease.json().error).toBe("engine_manifest_outdated");
      expect(lease.json().next).toBeUndefined(); // transient: the runner neither re-enrols nor refreshes
      const create = await inject("POST", "/v1/engine-runs", alice.key, {
        engineId: "promptfoo",
        target: { agentId: targetId, judgeAgentId: judgeId },
        config: { sets: ["prompt-extraction"] },
        projectId,
        budgetUsd: 1,
        trials: 1,
      });
      expect(create.statusCode, create.body).toBe(409);
      expect(create.json().error).toBe("engine_manifest_outdated");
      const st = await inject("POST", "/v1/engine-runner/self-test", r.bearer, { selfTest: await report() });
      expect(st.statusCode, st.body).toBe(409);
      expect(st.json().error).toBe("engine_manifest_outdated");
      const [row] = ((await db.execute(sql`SELECT manifest_generation, image_digest, enabled, self_test_passed_at FROM engines WHERE id = 'promptfoo'`)) as unknown as {
        rows: Array<{ manifest_generation: number; image_digest: string; enabled: boolean; self_test_passed_at: string | null }>;
      }).rows;
      expect(row).toMatchObject({ manifest_generation: MANIFEST.promptfoo.generation + 1, image_digest: NEW_DIGEST, enabled: true });
      expect(row!.self_test_passed_at).not.toBeNull();
      // the waiting run was not cancelled
      expect((await runRow(runId)).status).toBe("queued");
      // audited once for this replica, however many requests it refused
      expect((await audits("engine-manifest-outdated")) - auditsBefore).toBe(1);
      // an admin of the newer replica switched it off (its pass kept): this replica will not switch it back on
      await db.execute(sql`UPDATE engines SET enabled = false WHERE id = 'promptfoo'`);
      const enable = await asAdmin("PATCH", "/v1/engines/promptfoo", { enabled: true, acceptCredentialIsolationRisk: true });
      expect(enable.statusCode, enable.body).toBe(409);
      expect(enable.json().error).toBe("engine_manifest_outdated");
      expect(((await db.execute(sql`SELECT enabled FROM engines WHERE id = 'promptfoo'`)) as unknown as { rows: Array<{ enabled: boolean }> }).rows[0]!.enabled).toBe(false);
    } finally {
      await db.execute(sql`UPDATE engines SET manifest_generation = ${MANIFEST.promptfoo.generation}, image_digest = ${PF_DIGEST}, enabled = false WHERE id = 'promptfoo'`);
      await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE id = ${runId} AND status = 'queued'`);
      await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test cleanup' WHERE id = ${r.runnerId}`);
    }
  });
});

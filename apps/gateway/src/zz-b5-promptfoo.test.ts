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
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { buildSelfTest, runOnce, RunnerClient, type RunnerHttp } from "@regulait/engine-runner";
import { promptfooAdapter } from "@regulait/engine-promptfoo";
import { buildApp } from "./app.js";
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
  return runOnce(client, adapter, { engineId: "promptfoo", engineVersion: MANIFEST.promptfoo.version, workRoot: await mkdtemp(path.join(tmpdir(), "b5p-")), heartbeatMs: 25, retryBaseMs: 10 });
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
  const reg = await client.register(t.json().token, { name: `promptfoo-${RUN}`, imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version, selfTest });
  expect(reg.selfTest).toEqual({ passed: true, failures: [] });
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
  });
});

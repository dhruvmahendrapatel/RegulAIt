/**
 * ADR-0187 B5-G — the garak shim against the REAL gateway on a real database: the runner core
 * (`runOnce`, `RunnerClient`), the garak adapter and mapper, with only the worker's garak process
 * replaced by a stand-in executor that does what the worker does with a job — for each probe it calls
 * the gateway's compat route with the job's key and headers (as garak's OpenAI-compatible generator
 * does), and writes a garak-shaped report: a completed one, or, when a call is refused (a revoked or
 * spent key), one with no completion line, exactly as garak 0.17.0 does on a 401 (R10). The real garak
 * runs against a fake gateway in packages/engine-garak (garak-real.test.ts, opt-in).
 *
 * The shipped manifest's garak entry is used as is (its sets, reduced set, switches and
 * credentialIsolation), with a synthetic image digest through the code-only `buildApp({engines})` seam;
 * the taxonomy is the shipped table (v3, promptfoo and garak rows).
 *
 * Proofs (each red against the defect it guards; mutations recorded in the ADR):
 *   - registration: the runner's self-test carries the worker's switches and isolation; a missing worker
 *     report fails it; enabling needs the step-up but no credential-isolation acceptance (decision 140);
 *   - approvals routing: standard sets queue; offensive, licence-excluded and unknown sets wait for
 *     approval; an over-threshold budget waits; run params are refused;
 *   - a run: garak "exits 0" with hits → fail; classes from the shipped taxonomy; usage attributed;
 *   - budget spent → 401 mid-run: the measured probe counts, the rest is unknown, never pass;
 *   - ADR-0187 decisions 203-206 (owner decision on open question 24): a run selecting a judge probe
 *     (agent_breaker) names a judge the requester is entitled to, or is refused (422 `judge_required`,
 *     403 `judge_not_entitled`), at creation, for a schedule and again at lease; it is agentic (approval
 *     first); and the judge's calls go through the gateway on the run's own key, so they are governed,
 *     audited and costed on the run like the target's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { authSessions, createDb, engineRunItems, engineRuns, eq, interceptionSettings, INTERCEPTION_SETTINGS_ID, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, usageEvents, virtualKeys, type Db } from "@regulait/db";
import {
  BATCH5_STRICT_DEFAULTS,
  ENGINE_MANIFEST,
  ENGINE_TAXONOMY,
  evaluateRunnerSelfTest,
  GARAK_USAGE_DATA_ENV,
  GARAK_WORKER_SELF_TEST_SWITCH,
  STEP_UP_HEADER,
  type EngineId,
  type EngineManifestEntry,
} from "@regulait/shared";
import { generateRunnerSecret, runOnce, RunnerClient, type RunnerHttp } from "@regulait/engine-runner";
import { garakAdapter, garakRunnerSelfTest, writeWorkerSelfTest, type GarakExecutor, type GarakJob, type GarakProbeOutcome } from "@regulait/engine-garak";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxAgentEntitlementsForTest } from "./testing/agent-own-grants.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b5g-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const GATEWAY_BASE = "http://gateway.test/v1";
const GK_DIGEST = `sha256:${"e".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = { ...ENGINE_MANIFEST, garak: { ...ENGINE_MANIFEST.garak, imageDigest: GK_DIGEST } };
const EGRESS = {
  host: "egress-probe.invalid",
  ip: "93.184.215.14",
  lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
  connect: async () => "denied" as const,
};
const PI = "promptinject.HijackHateHumans";
const ENC = "encoding.InjectBase64";
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;
// ADR-0188 S4: engine runners register throughout this file (and through the real runner loop), so granting
// each runner identity its target agents in the fixture is impractical; the file runs `sponsor_only`
// (every delegation term still applies) and restores the strict default in afterAll.
let restoreAgentEntitlements: (() => Promise<void>) | undefined;
let priorInterception: { anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean } | null = null;
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };
let alice: { id: string; key: { authorization: string } };
let targetId: string;
let judgeId: string;
let foreignJudgeId: string;
let projectId: string;
let client: RunnerClient;
let workerResults: string;

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

async function makeUser(email: string, isAdmin = false) {
  const u = await inject("POST", "/v1/users", AUTH, { email, displayName: email.split("@")[0], isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b5g" });
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

/** a garak-shaped report line set (R10 schema) for one probe */
function reportOf(probe: string, detector: string, scores: number[], completed: boolean): Buffer {
  const run = "r-" + probe;
  const lines: unknown[] = [{ entry_type: "init", garak_version: "0.17.0", run }];
  // garak writes each attempt twice: generated (status 1), then scored (status 2), with the same uuid (decision 161)
  scores.forEach((_, i) => lines.push({ entry_type: "attempt", uuid: `u${i}`, seq: i, status: 1, probe_classname: probe, outputs: [{ text: "t" }], detector_results: {} }));
  scores.forEach((s, i) => lines.push({ entry_type: "attempt", uuid: `u${i}`, seq: i, status: 2, probe_classname: probe, outputs: [{ text: "t" }], detector_results: { [detector]: [s] } }));
  if (completed) {
    const fails = scores.filter((s) => s >= 0.5).length;
    lines.push({ entry_type: "eval", probe, detector, passed: scores.length - fails, fails, nones: 0, total_evaluated: scores.length, total_processed: scores.length });
    lines.push({ entry_type: "completion", run });
  }
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

interface Call {
  probe: string;
  status: number;
  body: string;
}
/**
 * The worker's stand-in: per probe, one gateway call per trial with the job's key and headers (as
 * garak's generator does); a refused call ends that probe's garak with no completion line (garak on a
 * 401). `hits` names the probes whose every output is a hit. Exit code 0 always, as garak.
 */
function workerStandIn(opts: { hits?: string[]; afterCall?: (c: Call, n: number) => Promise<void> } = {}): GarakExecutor & { calls: Call[]; judgeCalls: Call[]; jobs: GarakJob[] } {
  const calls: Call[] = [];
  const judgeCalls: Call[] = [];
  const jobs: GarakJob[] = [];
  return {
    calls,
    judgeCalls,
    jobs,
    reconcile: async () => [],
    async run(job, signal) {
      jobs.push(job);
      const outcomes: GarakProbeOutcome[] = [];
      for (const p of job.probes) {
        if (signal.aborted) return { outcomes, cancelled: true };
        const scores: number[] = [];
        let refused = false;
        for (let i = 0; i < job.trials; i++) {
          const r = await app.inject({
            method: "POST",
            url: `${new URL(job.target.baseUrl).pathname}/chat/completions`,
            headers: { authorization: `Bearer ${job.apiKey}`, ...job.target.headers },
            payload: { model: job.target.model, messages: [{ role: "user", content: `probe ${p.probe}` }] },
          });
          const c = { probe: p.probe, status: r.statusCode, body: r.body };
          calls.push(c);
          await opts.afterCall?.(c, calls.length);
          if (r.statusCode !== 200) {
            refused = true;
            break;
          }
          // decision 204: a judge probe's detector asks the run's judge, as garak's re-pointed judge does:
          // the gateway's compat route, the judge's model and headers, the SAME run key
          if (job.judge) {
            const jr = await app.inject({
              method: "POST",
              url: `${new URL(job.target.baseUrl).pathname}/chat/completions`,
              headers: { authorization: `Bearer ${job.apiKey}`, ...job.judge.headers },
              payload: { model: job.judge.model, messages: [{ role: "user", content: `judge the output of ${p.probe}` }] },
            });
            judgeCalls.push({ probe: p.probe, status: jr.statusCode, body: jr.body });
            if (jr.statusCode !== 200) {
              refused = true;
              break;
            }
          }
          scores.push(opts.hits?.includes(p.probe) ? 1 : 0);
        }
        const report = reportOf(p.probe, p.detector, scores, !refused);
        outcomes.push({ probe: p.probe, exitCode: 0, timedOut: false, report, reportTooLarge: false, reportSha256: createHash("sha256").update(report).digest("hex") });
      }
      return { outcomes, cancelled: false };
    },
  };
}

async function startRun(body: Record<string, unknown> = {}) {
  return inject("POST", "/v1/engine-runs", alice.key, {
    engineId: "garak",
    target: { agentId: targetId },
    config: { sets: ["promptinject.hijackhatehumans", "encoding.injectbase64"] },
    projectId,
    budgetUsd: 1,
    trials: 2,
    ...body,
  });
}
async function runRow(runId: string) {
  const [r] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
  return r!;
}
async function keyOf(runId: string) {
  const [k] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, (await runRow(runId)).virtualKeyId!));
  return k!;
}
async function once(executor: GarakExecutor) {
  return runOnce(client, garakAdapter({ executor }), {
    engineId: "garak",
    imageDigest: GK_DIGEST,
    engineVersion: MANIFEST.garak.version,
    workRoot: await mkdtemp(path.join(tmpdir(), "b5g-")),
    heartbeatMs: 25,
    retryBaseMs: 10,
  });
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreAgentEntitlements = await relaxAgentEntitlementsForTest(db);
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64), engines: { manifest: MANIFEST, gatewayBaseUrl: GATEWAY_BASE } });
  await app.ready();
  const [prior] = await db.select().from(interceptionSettings).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  priorInterception = prior ? { anthropicCompatEnabled: prior.anthropicCompatEnabled, openaiCompatEnabled: prior.openaiCompatEnabled } : null;
  expect((await inject("PUT", "/v1/interception/settings", AUTH, { anthropicCompatEnabled: true, openaiCompatEnabled: true })).statusCode).toBe(200);
  // any garak run an earlier suite left queued would be leased before ours: end them first (scoped to garak)
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE engine_id = 'garak' AND status IN ('queued', 'awaiting_approval')`);

  const a = await makeUser(`b5g-admin-${RUN}@example.com`, true);
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
  expect((await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "b5g" })).statusCode).toBe(201);

  alice = await makeUser(`b5g-alice-${RUN}@example.com`);
  const ag = await inject("POST", "/v1/agents", AUTH, { name: `b5g-target-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model: "b5g-target-model" });
  expect(ag.statusCode, ag.body).toBe(201);
  targetId = ag.json().id;
  expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId: targetId })).statusCode).toBe(201);
  // decisions 203-206: a judge agent alice is entitled to, and one she is not (no grant)
  const jg = await inject("POST", "/v1/agents", AUTH, { name: `b5g-judge-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 6, model: "b5g-judge-model" });
  expect(jg.statusCode, jg.body).toBe(201);
  judgeId = jg.json().id;
  expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId: judgeId })).statusCode).toBe(201);
  const fj = await inject("POST", "/v1/agents", AUTH, { name: `b5g-foreign-judge-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 6, model: "b5g-foreign-judge-model" });
  expect(fj.statusCode, fj.body).toBe(201);
  foreignJudgeId = fj.json().id;
  const p = await inject("POST", "/v1/projects", AUTH, { name: `b5g-project-${RUN}` });
  expect(p.statusCode, p.body).toBe(201);
  projectId = p.json().id;
  client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: runnerHttp });
  workerResults = await mkdtemp(path.join(tmpdir(), "b5g-results-"));
}, 180_000);

afterAll(async () => {
  if (priorInterception) await db.update(interceptionSettings).set(priorInterception).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  await forgetStepUpMethodsForTest(db, [admin?.id]);
  await db.execute(sql`UPDATE engines SET enabled = false, self_test = NULL, self_test_passed_at = NULL, max_budget_usd = 5, timeout_seconds = 1800, max_concurrent = 1 WHERE id = 'garak'`);
  await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test suite finished' WHERE revoked_at IS NULL AND engine_id = 'garak'`);
  await db.update(orgSettings).set({ ...BATCH5_STRICT_DEFAULTS }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreGates?.();
  await restoreAgentEntitlements?.();
  await restoreIdentity?.();
  await rm(workerResults, { recursive: true, force: true });
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

describe("B5-G garak registration", () => {
  it("without the worker's own report the runner's self-test fails on the worker switch (and every worker-side switch)", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "b5g-noworker-"));
    try {
      const st = await garakRunnerSelfTest({ imageDigest: GK_DIGEST, engineVersion: MANIFEST.garak.version, resultsRoot: empty, egress: EGRESS });
      const v = evaluateRunnerSelfTest(MANIFEST.garak, st, new Date());
      expect(v.passed).toBe(false);
      expect(v.failures).toContain(`usage_env_missing:${GARAK_WORKER_SELF_TEST_SWITCH}`);
      expect(v.failures).toContain("usage_env_missing:HF_HUB_OFFLINE");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("registers with the worker's report, passes, and is enabled with a step-up but no credential-isolation acceptance", async () => {
    await writeWorkerSelfTest(workerResults, { garakVersion: "0.17.0", env: { ...GARAK_USAGE_DATA_ENV }, egress: EGRESS, credentialPaths: [] });
    const t = await inject("POST", "/v1/engines/garak/enrollment-tokens", admin.key, { label: "b5g" });
    expect(t.statusCode, t.body).toBe(201);
    const selfTest = await garakRunnerSelfTest({ imageDigest: GK_DIGEST, engineVersion: MANIFEST.garak.version, resultsRoot: workerResults, egress: EGRESS });
    const reg = await client.register(t.json().token, generateRunnerSecret(), { name: `garak-${RUN}`, imageDigest: GK_DIGEST, engineVersion: MANIFEST.garak.version, selfTest });
    expect(reg.selfTest).toEqual({ passed: true, failures: [] });
    const st = await inject("POST", "/v1/engines/garak/self-test", admin.key);
    expect(st.json().passed, st.body).toBe(true);
    const before = Number(
      ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE rule_id = 'engine-credential-isolation-risk-accepted'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n,
    );
    // decision 140: the build isolates the credential, so no acceptance is asked for — only the step-up
    const refused = await asAdmin("PATCH", "/v1/engines/garak", { enabled: true });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action).toEqual({ kind: "settings_relax", body: { values: { "engine.garak.enabled": true } } });
    const ok = await asAdmin("PATCH", "/v1/engines/garak", { enabled: true }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = Number(
      ((await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE rule_id = 'engine-credential-isolation-risk-accepted'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n,
    );
    expect(after).toBe(before);
  });
});

describe("B5-G approvals routing", () => {
  const cancel = async (runId: string) => expect((await inject("POST", `/v1/engine-runs/${runId}/cancel`, alice.key, {})).statusCode).toBe(200);

  it("standard sets queue with no approval; run params are refused", async () => {
    const s = await startRun();
    expect(s.statusCode, s.body).toBe(202);
    expect(s.json().run.status).toBe("queued");
    await cancel(s.json().run.id);
    const p = await startRun({ config: { sets: ["encoding.injectbase64"], params: { generations: 50 } } });
    expect(p.statusCode, p.body).toBe(422);
    expect(p.json().error).toBe("engine_config_invalid");
  });

  it("offensive, licence-excluded and unknown sets wait for approval (never queued straight away)", async () => {
    for (const sets of [["dan.daninthewild"], ["malwaregen.payload"], ["leakreplay.nytcloze"], ["test.test"], ["encoding.injectbase64", "propile.piileaktwin"]]) {
      const none = await startRun({ config: { sets } });
      expect(none.statusCode, `${sets} ${none.body}`).toBe(422);
      expect(none.json().error).toBe("engine_approver_required");
      const s = await startRun({ config: { sets }, approverUserId: admin.id });
      expect(s.statusCode, s.body).toBe(202);
      expect(s.json().run.status, sets.join(",")).toBe("awaiting_approval");
      expect(s.json().approvalId).toBeTruthy();
      await cancel(s.json().run.id);
    }
  });

  it("a standard run whose budget is over the org threshold waits for approval", async () => {
    // the engine's ceiling (5) is below the threshold (10): raising it is itself a stepped-up relaxation
    const raise = await asAdmin("PATCH", "/v1/engines/garak", { maxBudgetUsd: 50 });
    expect(raise.statusCode, raise.body).toBe(403);
    expect((await asAdmin("PATCH", "/v1/engines/garak", { maxBudgetUsd: 50 }, { [STEP_UP_HEADER]: await grantFor(raise.json().action) })).statusCode).toBe(200);
    try {
      const big = await startRun({ budgetUsd: 20, approverUserId: admin.id });
      expect(big.statusCode, big.body).toBe(202);
      expect(big.json().run.status).toBe("awaiting_approval");
      await cancel(big.json().run.id);
      const small = await startRun({ budgetUsd: 1 });
      expect(small.json().run.status).toBe("queued");
      await cancel(small.json().run.id);
    } finally {
      expect((await asAdmin("PATCH", "/v1/engines/garak", { maxBudgetUsd: 5 })).statusCode).toBe(200);
    }
  });
});

describe("B5-G a garak run through the real gateway", () => {
  it("garak exits 0 with hits: the reports decide (fail), classes from the shipped taxonomy, usage attributed, key revoked", async () => {
    const s = await startRun();
    expect(s.statusCode, s.body).toBe(202);
    const runId = s.json().run.id as string;
    const w = workerStandIn({ hits: [PI] });
    const out = await once(w);
    expect(out).toMatchObject({ outcome: "posted", runId, status: 200 });
    // the job the worker got: the run's key and the gateway's headers, the target model, the planned probes only
    expect(w.jobs[0]!.probes.map((p) => p.probe)).toEqual([PI, ENC]);
    expect(w.jobs[0]!.target.headers).toMatchObject({ "x-regulait-project-id": projectId, "x-regulait-agent-id": targetId });
    expect(w.calls).toHaveLength(4);
    expect(w.calls.every((c) => c.status === 200)).toBe(true);
    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect(run.summary).toMatchObject({ verdict: "fail", mappedItems: 2, taxonomyVersion: ENGINE_TAXONOMY.version });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.map((i) => [i.key, i.attackClass, i.verdict]).sort()).toEqual([
      [ENC, "encoding_evasion", "pass"],
      [PI, "prompt_injection", "fail"],
    ]);
    const k = await keyOf(runId);
    expect(k.revokedAt).not.toBeNull();
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    expect(usage).toHaveLength(4);
    expect(usage.every((u) => u.projectId === projectId && (u.detail as { purpose?: string }).purpose === "engine:garak")).toBe(true);
  });

  it("RED PROOF budget spent → 401 mid-run: the measured probe counts, the refused one is unknown, never pass", async () => {
    const s = await startRun();
    const runId = s.json().run.id as string;
    const w = workerStandIn({
      afterCall: async (_c, n) => {
        if (n === 2) {
          const k = await keyOf(runId);
          await db.update(virtualKeys).set({ budgetUsd: k.spentUsd + 1e-9 }).where(eq(virtualKeys.id, k.id));
        }
      },
    });
    const out = await once(w);
    expect(out).toMatchObject({ outcome: "posted", status: 200 });
    expect(w.calls.slice(0, 2).every((c) => c.probe === PI && c.status === 200)).toBe(true);
    // the call that crosses the budget is billed and served; every later call is 401
    expect(w.calls[2]).toMatchObject({ probe: ENC, status: 200 });
    expect(w.calls.slice(3).length).toBeGreaterThan(0);
    expect(w.calls.slice(3).every((c) => c.status === 401 && /virtual_key_revoked/.test(c.body))).toBe(true);
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.find((i) => i.key === PI)).toMatchObject({ verdict: "pass", attackClass: "prompt_injection" });
    expect(items.find((i) => i.key === ENC)).toMatchObject({ verdict: "unknown" });
    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect((run.summary as { verdict: string }).verdict).toBe("unknown");
  });
});

// ADR-0187 decisions 203-206 (owner decision on open question 24)
describe("B5-G the gateway judge: agent_breaker runs only with an entitled judge, through the gateway", () => {
  const AB = "agent_breaker.AgentBreaker";
  const abRun = (target: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    startRun({ target, config: { sets: ["agent_breaker.agentbreaker", "encoding.injectbase64"] }, approverUserId: admin.id, ...more });
  const approve = async (approvalId: string) => {
    const d = await inject("POST", `/v1/approvals/${approvalId}/decide`, admin.key, { decision: "approved", reason: "reviewed the agentic set" });
    expect(d.statusCode, d.body).toBe(200);
  };

  it("refused with no judge (422 judge_required), for a run and a schedule; nothing queued", async () => {
    const before = await db.select({ id: engineRuns.id }).from(engineRuns).where(eq(engineRuns.engineId, "garak"));
    const r = await abRun({ agentId: targetId });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "judge_required" });
    expect(r.json().detail).toMatch(/agent_breaker\.agentbreaker/);
    const sch = await inject("POST", "/v1/engine-schedules", alice.key, {
      request: { engineId: "garak", target: { agentId: targetId }, config: { sets: ["agent_breaker.agentbreaker"] }, projectId, budgetUsd: 1, approverUserId: admin.id },
      intervalHours: 24,
    });
    expect(sch.statusCode, sch.body).toBe(422);
    expect(sch.json()).toMatchObject({ error: "judge_required" });
    expect(await db.select({ id: engineRuns.id }).from(engineRuns).where(eq(engineRuns.engineId, "garak"))).toHaveLength(before.length);
    // control: a garak run of probes that need no judge still needs none
    const plain = await startRun();
    expect(plain.statusCode, plain.body).toBe(202);
    await inject("POST", `/v1/engine-runs/${plain.json().run.id}/cancel`, alice.key, {});
  });

  it("refused with a judge the requester is not entitled to (403 judge_not_entitled)", async () => {
    const r = await abRun({ agentId: targetId, judgeAgentId: foreignJudgeId });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "judge_not_entitled" });
  });

  it("with an entitled judge it is agentic: it needs an approver and waits for approval", async () => {
    const none = await abRun({ agentId: targetId, judgeAgentId: judgeId }, { approverUserId: undefined });
    expect(none.statusCode, none.body).toBe(422);
    expect(none.json().error).toBe("engine_approver_required");
    const s = await abRun({ agentId: targetId, judgeAgentId: judgeId });
    expect(s.statusCode, s.body).toBe(202);
    expect(s.json().run.status).toBe("awaiting_approval");
    await inject("POST", `/v1/engine-runs/${s.json().run.id}/cancel`, alice.key, {});
  });

  it("a judge removed after queueing: the lease ends the run not_run (judge_required) and mints no key", async () => {
    const s = await abRun({ agentId: targetId, judgeAgentId: judgeId });
    const runId = s.json().run.id as string;
    await approve(s.json().approvalId as string);
    // what deleting the judge agent does to a queued run (the foreign key nulls it)
    await db.execute(sql`UPDATE engine_runs SET judge_agent_id = NULL WHERE id = ${runId}`);
    const w = workerStandIn();
    await once(w);
    expect(w.jobs).toHaveLength(0);
    expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "judge_required", virtualKeyId: null });
  });

  it("end to end: the judge is called through the gateway on the run key; governed, audited and costed on the run", async () => {
    const s = await abRun({ agentId: targetId, judgeAgentId: judgeId });
    expect(s.statusCode, s.body).toBe(202);
    const runId = s.json().run.id as string;
    await approve(s.json().approvalId as string);
    const w = workerStandIn({ hits: [AB] });
    const out = await once(w);
    expect(out).toMatchObject({ outcome: "posted", runId, status: 200 });
    // the worker's job: the judge's model and headers, the run's one key, and nothing of the runner's
    const job = w.jobs[0]!;
    expect(job.judge).toEqual({ model: "b5g-judge-model", headers: { "x-regulait-agent-id": judgeId, "x-regulait-project-id": projectId } });
    expect(Object.keys(job).sort()).toEqual(["apiKey", "judge", "probes", "runId", "target", "timeoutMs", "trials"]);
    expect(job.apiKey).toMatch(/^rglv_/);
    expect(JSON.stringify(job)).not.toMatch(/rgee?_/);
    expect(w.judgeCalls.length).toBeGreaterThan(0);
    expect(w.judgeCalls.every((c) => c.status === 200)).toBe(true);
    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId));
    expect(items.find((i) => i.key === AB)).toMatchObject({ verdict: "fail", attackClass: null });
    // governed: the run key allowed exactly the target and the judge
    const k = await keyOf(runId);
    expect([...(k.allowedModels as string[])].sort()).toEqual([targetId, judgeId].sort());
    expect(k.revokedAt).not.toBeNull();
    // costed: the judge's calls are usage on the run's key, in the run's project, and the run's cost includes them
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    const judgeUsage = usage.filter((u) => u.agentId === judgeId);
    const targetUsage = usage.filter((u) => u.agentId === targetId);
    expect(judgeUsage).toHaveLength(w.judgeCalls.length);
    expect(targetUsage).toHaveLength(w.calls.length);
    expect(usage.every((u) => u.projectId === projectId && (u.detail as { purpose?: string }).purpose === "engine:garak")).toBe(true);
    const judgeCost = judgeUsage.reduce((n, u) => n + (u.costUsd ?? 0), 0);
    const allCost = usage.reduce((n, u) => n + (u.costUsd ?? 0), 0);
    expect(judgeCost).toBeGreaterThan(0);
    expect(run.costUsd).toBeCloseTo(allCost, 9);
    expect(run.costUsd).toBeGreaterThan(allCost - judgeCost);
    // audited: every judge dispatch is in the audit trail, attributed to the run-as person, on the judge agent
    const audit = (
      (await db.execute(
        sql`SELECT user_id, effect FROM audit_log WHERE object_type = 'agent' AND object_id = ${judgeId} AND at >= ${run.createdAt.toISOString()}::timestamptz`,
      )) as unknown as { rows: Array<{ user_id: string; effect: string }> }
    ).rows;
    expect(audit.length).toBeGreaterThanOrEqual(w.judgeCalls.length);
    expect(audit.every((a) => a.user_id === alice.id && a.effect === "allow")).toBe(true);
  });
});

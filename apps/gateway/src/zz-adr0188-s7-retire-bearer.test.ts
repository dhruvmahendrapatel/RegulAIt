/**
 * ADR-0188 slice S7 — RETIRING THE BEARER WORKLOAD SECRETS, proven on the
 * properties first.
 *
 * Owner decision 8: the `rge_` runner tokens and the `pdp` virtual keys are
 * removed once tests prove the clients that replace them keep what ADR-0187
 * and AER-027 promised:
 *
 *   - THE ENGINE-KEY CEILINGS. A run's model access is the run-scoped key:
 *     owned by the run-as person (never the runner, never the admin who
 *     enrolled it), the target and judge agents only, the run's budget, until
 *     the run's deadline, the compat model routes only. The runner's own
 *     credential reaches the runner routes and nothing else, and is never an
 *     admin.
 *   - PROJECT PINNING. The run's key names the run's project; a call naming
 *     another project is refused `virtual_key_project_mismatch`.
 *   - SPONSORSHIP. The run's delegation grant (ADR-0188 S4) is sponsored by the
 *     run-as person, names the runner's workload identity as the actor and the
 *     run's project; a run-as person who lost the entitlement gets no key.
 *   - THE PDP CREDENTIAL (AER-027). It asks `POST /v1/authz/check` and does
 *     nothing else: no admin route, no dispatch, no key minting; taking it back
 *     stops it.
 *
 * Written FIRST against the old bearer path (this version), then switched to
 * the replacement. Each check talks to the credential through one `Caller`, so
 * the switch changes how a request is authenticated and nothing else.
 *
 * Global state (M-068): org settings, interception settings and the engines
 * are put back in afterAll; every fixture is scoped by this run's ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  and,
  authSessions,
  createDb,
  delegationGrants,
  engineRuns,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  virtualKeys,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { BATCH5_STRICT_DEFAULTS, ENGINE_MANIFEST, STEP_UP_HEADER, type EngineId, type EngineManifestEntry } from "@regulait/shared";
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
const BOOT = `s7-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "s7-synthetic-data-key-".padEnd(64, "q");
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

const PF_DIGEST = `sha256:${"7".repeat(64)}`;
const MANIFEST: Record<EngineId, EngineManifestEntry> = {
  ...ENGINE_MANIFEST,
  promptfoo: { ...ENGINE_MANIFEST.promptfoo, imageDigest: PF_DIGEST, sets: { basic: "standard" } },
};
const PF_BUILD = () => ({ imageDigest: PF_DIGEST, engineVersion: MANIFEST.promptfoo.version });

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
let priorInterception: { anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean } | null = null;
let admin: { id: string; key: { authorization: string }; session: { token: string }; auth: SoftAuthenticator };
let alice: { id: string; key: { authorization: string } };
let targetId: string;
let judgeId: string;
let otherAgentId: string;
let projectId: string;
let otherProjectId: string;
let serverId: string;
const TOOL = `s7_read_${RUN}`;

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

// ---------------------------------------------------------------------------
// THE ONE SEAM: how a workload client authenticates a request
// ---------------------------------------------------------------------------

/** a credentialed workload client: the headers it sends for one request */
interface Caller {
  headers(method: Method, url: string): Promise<Record<string, string>>;
}
const call = async (c: Caller, method: Method, url: string, payload?: unknown) => inject(method, url, await c.headers(method, url), payload);

/** OLD PATH: a runner's bearer token, `rge_` + 256 random bits, registered by its sha256 */
async function enrolRunner(): Promise<{ id: string; caller: Caller; revoke: () => Promise<void> }> {
  const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: `s7-${RUN}` });
  expect(t.statusCode, t.body).toBe(201);
  const secret = `rge_${randomBytes(32).toString("hex")}`;
  const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${t.json().token}` }, {
    name: `s7-runner-${randomBytes(2).toString("hex")}`,
    ...PF_BUILD(),
    selfTest: selfTest(),
    tokenHash: createHash("sha256").update(secret).digest("hex"),
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().runnerId as string;
  return {
    id,
    caller: { headers: async () => ({ authorization: `Bearer ${secret}` }) },
    revoke: async () => {
      expect((await inject("DELETE", `/v1/engine-runners/${id}`, admin.key)).statusCode).toBe(200);
    },
  };
}

/** OLD PATH: a 'pdp' virtual key, minted by an admin */
async function provisionPdp(): Promise<{ caller: Caller; revoke: () => Promise<void> }> {
  const r = await inject("POST", "/v1/virtual-keys", AUTH, { name: `s7-pdp-${RUN}`, userId: admin.id, purpose: "pdp" });
  expect(r.statusCode, r.body).toBe(201);
  const body = r.json() as { id: string; token?: string; key?: string };
  const token = (body.token ?? body.key)!;
  return {
    caller: { headers: async () => ({ authorization: `Bearer ${token}` }) },
    revoke: async () => {
      expect([200, 204]).toContain((await inject("DELETE", `/v1/virtual-keys/${body.id}`, AUTH)).statusCode);
    },
  };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "s7" });
  expect(k.statusCode, k.body).toBe(201);
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, model: string) {
  const r = await inject("POST", "/v1/agents", AUTH, { name, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

function selfTest() {
  return {
    ...PF_BUILD(),
    usageDataEnv: Object.fromEntries(Object.keys(MANIFEST.promptfoo.usageDataEnv).map((k) => [k, true])),
    egress: { host: "registry.example.invalid", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false },
    at: new Date().toISOString(),
  };
}

async function startRun(who = alice.key) {
  const s = await inject("POST", "/v1/engine-runs", who, {
    engineId: "promptfoo",
    target: { agentId: targetId, judgeAgentId: judgeId },
    config: { sets: ["basic"] },
    projectId,
    budgetUsd: 1,
    trials: 1,
  });
  expect(s.statusCode, s.body).toBe(202);
  return s.json().run.id as string;
}

async function runRow(runId: string) {
  const [r] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
  return r!;
}

function chatOn(key: string, headers: Record<string, string>, model = `s7-target-model-${RUN}`) {
  return inject("POST", "/v1/chat/completions", { authorization: `Bearer ${key}`, ...headers }, { model, messages: [{ role: "user", content: "hello" }] });
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // engine runners register throughout this file; S4's strict `own_grants` is exercised by the S4 suites, so this
  // file runs `sponsor_only` (every delegation term still applies) and restores the strict value in afterAll
  restores.push(await relaxAgentEntitlementsForTest(db));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, engines: { manifest: MANIFEST, gatewayBaseUrl: "http://gateway.test/v1" } });
  await app.ready();
  const [prior] = await db.select().from(interceptionSettings).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  priorInterception = prior ? { anthropicCompatEnabled: prior.anthropicCompatEnabled, openaiCompatEnabled: prior.openaiCompatEnabled } : null;
  expect((await inject("PUT", "/v1/interception/settings", AUTH, { anthropicCompatEnabled: true, openaiCompatEnabled: true })).statusCode).toBe(200);
  // a run another suite left queued would be leased before ours
  await db.execute(sql`UPDATE engine_runs SET status = 'cancelled', finished_at = now(), error_code = 'test_cleanup' WHERE engine_id = 'promptfoo' AND status IN ('queued', 'awaiting_approval')`);

  const a = await makeUser(`s7-admin-${RUN}@example.com`, true);
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
  expect((await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "s7" })).statusCode).toBe(201);

  alice = await makeUser(`s7-alice-${RUN}@example.com`);
  targetId = await makeAgent(`s7-target-${RUN}`, `s7-target-model-${RUN}`);
  judgeId = await makeAgent(`s7-judge-${RUN}`, `s7-judge-model-${RUN}`);
  otherAgentId = await makeAgent(`s7-other-${RUN}`, `s7-other-model-${RUN}`);
  for (const agentId of [targetId, judgeId, otherAgentId]) expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: alice.id, agentId })).statusCode).toBe(201);
  const p = await inject("POST", "/v1/projects", AUTH, { name: `s7-project-${RUN}` });
  expect(p.statusCode, p.body).toBe(201);
  projectId = p.json().id;
  const q = await inject("POST", "/v1/projects", AUTH, { name: `s7-other-project-${RUN}` });
  expect(q.statusCode, q.body).toBe(201);
  otherProjectId = q.json().id;

  // an MCP tool alice holds, for the PDP's authorization question (a closed port: nothing is ever called)
  const [s] = (await db.execute(sql`insert into mcp_servers (name, url) values (${`s7-${RUN}`}, 'http://127.0.0.1:9/') returning id`)).rows as Array<{ id: string }>;
  serverId = s!.id;
  await db.execute(sql`insert into mcp_tools (server_id, name, kind) values (${serverId}, ${TOOL}, 'read')`);
  await db.execute(sql`insert into tool_grants (user_id, server_id, tool_name) values (${alice.id}, ${serverId}, ${TOOL})`);

  // the engine: a passing self-test from a registered runner, then enabled under a settings_relax step-up
  const first = await enrolRunner();
  expect((await inject("POST", "/v1/engines/promptfoo/self-test", admin.key)).json().passed).toBe(true);
  const accept = { enabled: true, acceptCredentialIsolationRisk: true as const, expectedVersion: MANIFEST.promptfoo.version, expectedDigest: PF_DIGEST };
  const refused = await asAdmin("PATCH", "/v1/engines/promptfoo", accept);
  expect(refused.statusCode, refused.body).toBe(403);
  const ok = await asAdmin("PATCH", "/v1/engines/promptfoo", accept, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(200);
  await first.revoke();
}, 180_000);

afterAll(async () => {
  if (priorInterception) await db.update(interceptionSettings).set(priorInterception).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  await forgetStepUpMethodsForTest(db, [admin?.id]);
  await db.execute(sql`UPDATE engines SET enabled = false, self_test = NULL, self_test_passed_at = NULL, max_budget_usd = 5, timeout_seconds = 1800, max_concurrent = 1`);
  await db.execute(sql`UPDATE engine_runners SET revoked_at = now(), revoke_reason = 'test suite finished' WHERE revoked_at IS NULL`);
  await db.update(orgSettings).set({ ...BATCH5_STRICT_DEFAULTS }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  for (const r of restores.reverse()) await r();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  app.server.closeAllConnections();
  await app.close();
});

// ===========================================================================
describe("S7 — the engine runner keeps ADR-0187's ceilings, pinning and sponsorship", () => {
  it("the runner credential reaches the runner routes and nothing else, and is never an admin", async () => {
    const runner = await enrolRunner();
    try {
      // its own route answers (no work queued: 204)
      const idle = await call(runner.caller, "POST", "/v1/engine-runner/lease", PF_BUILD());
      expect(idle.statusCode, idle.body).toBe(204);
      for (const [method, url, body] of [
        ["GET", "/v1/users", undefined],
        ["GET", "/v1/engines", undefined],
        ["POST", "/v1/engine-runs", {}],
        ["POST", "/v1/virtual-keys", { name: "escalation", purpose: "dispatch" }],
        ["GET", "/v1/me", undefined],
      ] as const) {
        const r = await call(runner.caller, method, url, body);
        expect(r.statusCode, `${method} ${url} -> ${r.body}`).toBe(403);
      }
      // the data plane and the PDP are not its routes either
      expect((await call(runner.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL })).statusCode).toBe(403);
    } finally {
      await runner.revoke();
    }
  });

  it("a lease mints the run's key: the run-as person's, the target and judge only, the run's budget and deadline, project-pinned", async () => {
    const runner = await enrolRunner();
    try {
      const runId = await startRun();
      const l = await call(runner.caller, "POST", "/v1/engine-runner/lease", PF_BUILD());
      expect(l.statusCode, l.body).toBe(200);
      const lease = l.json() as { runId: string; deadlineAt: string; target: { apiKey: string; headers: Record<string, string> } };
      expect(lease.runId).toBe(runId);
      const run = await runRow(runId);
      const [k] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, run.virtualKeyId!));
      // SPONSORSHIP: the key is the run-as person's, never the runner's, never the enrolling admin's
      expect(k).toMatchObject({ purpose: "engine", userId: alice.id, projectId, engineRunId: runId, budgetUsd: 1 });
      expect(k!.userId).not.toBe(admin.id);
      // THE CEILINGS: the target and judge only, until the run's deadline
      expect(k!.allowedModels).toEqual([targetId, judgeId]);
      expect(k!.expiresAt!.toISOString()).toBe(lease.deadlineAt);
      expect(lease.target.headers["x-regulait-project-id"]).toBe(projectId);

      // the run's delegation grant (S4): sponsored by the run-as person, the runner's identity acting, the run's project
      const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.engineRunnerId, runner.id));
      expect(ident).toMatchObject({ kind: "engine_runner", status: "active" });
      const grants = await db.select().from(delegationGrants).where(and(eq(delegationGrants.engineRunId, runId), eq(delegationGrants.actorIdentityId, ident!.id)));
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ sponsorUserId: alice.id, projectId, depth: 0, revokedAt: null });

      // the key works for the target, on the run's project
      const ok = await chatOn(lease.target.apiKey, lease.target.headers);
      expect(ok.statusCode, ok.body).toBe(200);
      // PROJECT PINNING: another project is refused
      const other = await chatOn(lease.target.apiKey, { ...lease.target.headers, "x-regulait-project-id": otherProjectId });
      expect(other.statusCode, other.body).toBe(403);
      expect(other.json().error?.code ?? other.json().error).toMatch(/virtual_key_project_mismatch/);
      // THE CEILING: an agent the run-as person holds but the key does not name is refused
      const notAllowed = await chatOn(lease.target.apiKey, { "x-regulait-agent-id": otherAgentId, "x-regulait-project-id": projectId }, `s7-other-model-${RUN}`);
      expect(notAllowed.statusCode, notAllowed.body).toBe(403);
      // the key reaches the compat model routes only
      const me = await inject("GET", "/v1/me", { authorization: `Bearer ${lease.target.apiKey}` });
      expect(me.statusCode).toBe(403);
      expect(me.json().error).toBe("virtual_key_scope");

      // the run ends: the key is revoked and the grant with it
      const res = await call(runner.caller, "POST", `/v1/engine-runner/runs/${runId}/result`, {
        version: "regulait.engine-result.v1",
        runId,
        engineId: "promptfoo",
        engineVersion: MANIFEST.promptfoo.version,
        status: "completed",
        items: [],
        notRun: [],
        rawReport: null,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await chatOn(lease.target.apiKey, lease.target.headers)).statusCode).toBe(401);
      const [ended] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grants[0]!.id));
      expect(ended!.revokedAt).not.toBeNull();
    } finally {
      await runner.revoke();
    }
  });

  it("SPONSORSHIP at lease: a run-as person who lost the entitlement gets no key and no grant", async () => {
    const runner = await enrolRunner();
    const bob = await makeUser(`s7-bob-${RUN}@example.com`);
    for (const agentId of [targetId, judgeId]) expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: bob.id, agentId })).statusCode).toBe(201);
    try {
      const runId = await startRun(bob.key);
      // bob's grant on the target goes between the start and the lease (bob is this test's own person)
      await db.execute(sql`DELETE FROM agent_grants WHERE user_id = ${bob.id} AND agent_id = ${targetId}`);
      const l = await call(runner.caller, "POST", "/v1/engine-runner/lease", PF_BUILD());
      expect(l.statusCode, l.body).toBe(204);
      expect(await runRow(runId)).toMatchObject({ status: "not_run", errorCode: "run_as_not_entitled", virtualKeyId: null });
      expect(await db.select().from(delegationGrants).where(eq(delegationGrants.engineRunId, runId))).toHaveLength(0);
    } finally {
      await runner.revoke();
    }
  });

  it("revoking the runner stops its credential at once", async () => {
    const runner = await enrolRunner();
    expect((await call(runner.caller, "POST", "/v1/engine-runner/lease", PF_BUILD())).statusCode).toBe(204);
    await runner.revoke();
    const after = await call(runner.caller, "POST", "/v1/engine-runner/lease", PF_BUILD());
    expect(after.statusCode, after.body).toBe(401);
  });
});

// ===========================================================================
describe("S7 — the PDP client keeps AER-027's one-question world", () => {
  it("asks an authorization question, and nothing else", async () => {
    const pdp = await provisionPdp();
    try {
      const ask = await call(pdp.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL });
      expect(ask.statusCode, ask.body).toBe(200);
      expect(ask.json().decision).toBe("allow");
      for (const [method, url, body] of [
        ["GET", "/v1/users", undefined],
        ["GET", "/v1/audit", undefined],
        ["GET", "/v1/virtual-keys", undefined],
        ["POST", "/v1/virtual-keys", { name: "escalation", purpose: "dispatch" }],
        ["GET", "/v1/me", undefined],
        ["POST", "/v1/engine-runner/lease", PF_BUILD()],
      ] as const) {
        const r = await call(pdp.caller, method, url, body);
        expect([401, 403], `${method} ${url} -> ${r.statusCode} ${r.body}`).toContain(r.statusCode);
      }
      // it cannot dispatch: no model is reachable on it
      const chat = await call(pdp.caller, "POST", "/v1/chat/completions", { model: `s7-target-model-${RUN}`, messages: [{ role: "user", content: "x" }] });
      expect([401, 403]).toContain(chat.statusCode);
    } finally {
      await pdp.revoke();
    }
  });

  it("taking it back stops it", async () => {
    const pdp = await provisionPdp();
    expect((await call(pdp.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL })).statusCode).toBe(200);
    await pdp.revoke();
    expect((await call(pdp.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL })).statusCode).toBe(401);
  });
});

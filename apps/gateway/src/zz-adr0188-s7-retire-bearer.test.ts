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
 * Written FIRST against the old bearer path (commit 942fc5d), then switched to
 * the replacement (this version). Each property check talks to the credential
 * through one `Caller`, so the switch changed how a request is authenticated
 * and nothing else: every property assertion is the one the bearer path met.
 *
 * Then what only the new path has: no bearer value authenticates a runner or a
 * PDP client any more (no grandfathering); a self token never reaches a
 * governed route; a stolen token is useless off its key; the token endpoint's
 * refusals; key rotation (decision 12) with audit continuity; revoking a key
 * refuses what it minted.
 *
 * Global state (M-068): org settings, interception settings and the engines
 * are put back in afterAll; every fixture is scoped by this run's ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, decodeJwt, SignJWT, type JWK } from "jose";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  delegationGrants,
  desc,
  engineRunners,
  engineRuns,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  issuedTokens,
  workloadCredentials,
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
import { forgetStepUpMethodsForTest, relaxStepUpAround } from "./testing/step-up-posture.js";
import { TestWorkloadClient, useTestIssuerKey } from "./testing/workload-client.js";
import { deploymentEnvironment } from "./oauth/common.js";

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
// the issuer (the self token's audience and every DPoP proof's htu) and the environment it is minted for
process.env.REGULAIT_PUBLIC_URL = ORIGIN;
const ENV = deploymentEnvironment();

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

/**
 * NEW PATH (ADR-0188 S7): a runner registers the PUBLIC half of a key it generated; it authenticates with
 * `private_key_jwt` and a DPoP-bound self token from POST /oauth/token (`client_credentials`).
 */
async function enrolRunner(): Promise<{ id: string; caller: Caller; client: TestWorkloadClient; revoke: () => Promise<void> }> {
  const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: `s7-${RUN}` });
  expect(t.statusCode, t.body).toBe(201);
  const client = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
  const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${t.json().token}` }, {
    name: `s7-runner-${randomBytes(2).toString("hex")}`,
    ...PF_BUILD(),
    selfTest: selfTest(),
    publicJwk: client.publicJwk,
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().runnerId as string;
  return {
    id,
    client,
    caller: client,
    revoke: async () => {
      expect((await inject("DELETE", `/v1/engine-runners/${id}`, admin.key)).statusCode).toBe(200);
    },
  };
}

/** NEW PATH (ADR-0188 S7): a PDP client is a workload identity of kind `pdp` with a registered key */
async function provisionPdp(): Promise<{ identityId: string; credentialId: string; caller: Caller; client: TestWorkloadClient; revoke: () => Promise<void> }> {
  const client = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "pdp" });
  const created = await relaxStepUpAround(db, () => inject("POST", "/v1/workload-identities", AUTH, { kind: "pdp", sponsorUserIds: [admin.id], environments: [ENV] }));
  expect(created.statusCode, created.body).toBe(201);
  const identityId = created.json().id as string;
  const bound = await relaxStepUpAround(db, () => inject("POST", `/v1/workload-identities/${identityId}/credentials`, AUTH, { kind: "jwk", publicJwk: client.publicJwk }));
  expect(bound.statusCode, bound.body).toBe(201);
  const credentialId = bound.json().id as string;
  return {
    identityId,
    credentialId,
    client,
    caller: client,
    revoke: async () => {
      expect((await relaxStepUpAround(db, () => inject("DELETE", `/v1/workload-identities/${identityId}/credentials/${credentialId}`, AUTH))).statusCode).toBe(200);
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
  // ADR-0188 S7: the issuer signs the runner's and the PDP client's self tokens
  restores.push(await useTestIssuerKey(db));
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

// ===========================================================================
// What only the new path has
// ===========================================================================
describe("S7 — no bearer workload secret authenticates anything (OWNER DECISION 8, no grandfathering)", () => {
  it("an `rge_`-shaped runner token is not a credential: the runner routes answer 401 to it", async () => {
    const r = await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer rge_${randomBytes(32).toString("hex")}` }, PF_BUILD());
    expect(r.statusCode, r.body).toBe(401);
  });

  it("a 'pdp' virtual key can no longer be minted, and no live pdp key row can exist (migration 0195's CHECK)", async () => {
    const before = (await db.select({ id: virtualKeys.id }).from(virtualKeys)).length;
    const r = await inject("POST", "/v1/virtual-keys", AUTH, { name: `s7-pdp-retired-${RUN}`, userId: admin.id, purpose: "pdp" });
    expect(r.statusCode, r.body).toBe(410);
    expect(r.json().error).toBe("pdp_key_retired");
    expect((await db.select({ id: virtualKeys.id }).from(virtualKeys)).length).toBe(before);
    // the database refuses a live one from any writer (a revoked row is history and stays readable)
    await expect(
      db.execute(sql`insert into virtual_keys (name, user_id, token_hash, purpose) values (${`s7-live-pdp-${RUN}`}, ${admin.id}, ${createHash("sha256").update(randomBytes(16)).digest("hex")}, 'pdp')`),
    ).rejects.toThrow();
    const revoked = await db.execute(
      sql`insert into virtual_keys (name, user_id, token_hash, purpose, revoked_at) values (${`s7-dead-pdp-${RUN}`}, ${admin.id}, ${createHash("sha256").update(randomBytes(16)).digest("hex")}, 'pdp', now()) returning id`,
    );
    expect((revoked as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

describe("S7 — a self token is the workload acting as itself, on its own route only", () => {
  it("a runner's self token never reaches a governed route (it carries no grant and no sponsor)", async () => {
    const runner = await enrolRunner();
    try {
      for (const [method, url] of [
        ["POST", "/v1/chat/completions"],
        ["POST", "/v1/messages"],
        ["GET", "/v1/models"],
        ["POST", `/mcp/${serverId}`],
      ] as const) {
        const r = await call(runner.caller, method, url, method === "POST" ? {} : undefined);
        // verified as the RUNNER (its token's audience), then refused by the runner's route allow-list
        expect(r.statusCode, `${method} ${url} -> ${r.body}`).toBe(403);
        expect(r.json().error).toBe("engine_runner_scope");
      }
      // its token names no grant, no act chain, one control-plane audience, and the runner as itself
      const claims = decodeJwt(await runner.client.token());
      expect(claims).toMatchObject({ aud: `${ORIGIN}/v1/engine-runner`, sub: claims.client_id, env: ENV });
      expect(claims.grant_id).toBeUndefined();
      expect(claims.act).toBeUndefined();
      const [row] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti!));
      expect(row).toMatchObject({ grantId: null, bindingKind: "dpop", bindingThumbprint: await runner.client.jkt() });
    } finally {
      await runner.revoke();
    }
  });

  it("a PDP client's token does not lease work, and a runner's does not ask authorization questions", async () => {
    const runner = await enrolRunner();
    const pdp = await provisionPdp();
    try {
      const lease = await call(pdp.caller, "POST", "/v1/engine-runner/lease", PF_BUILD());
      expect(lease.statusCode, lease.body).toBe(403);
      expect(lease.json().error).toBe("workload_scope");
      const ask = await call(runner.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL });
      expect(ask.statusCode, ask.body).toBe(403);
      expect(ask.json().error).toBe("engine_runner_scope");
    } finally {
      await runner.revoke();
      await pdp.revoke();
    }
  });

  it("a stolen token is useless off its key: no proof, another key's proof, or a replayed proof is 401", async () => {
    const runner = await enrolRunner();
    try {
      const token = await runner.client.token();
      const url = `${ORIGIN}/v1/engine-runner/lease`;
      const ath = createHash("sha256").update(token).digest("base64url");
      const noProof = await inject("POST", "/v1/engine-runner/lease", { authorization: `DPoP ${token}` }, PF_BUILD());
      expect(noProof.statusCode, noProof.body).toBe(401);
      const thief = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
      const otherKey = await inject("POST", "/v1/engine-runner/lease", { authorization: `DPoP ${token}`, dpop: await thief.proof("POST", url, { ath }) }, PF_BUILD());
      expect(otherKey.statusCode, otherKey.body).toBe(401);
      const proof = await runner.client.proof("POST", url, { ath });
      expect((await inject("POST", "/v1/engine-runner/lease", { authorization: `DPoP ${token}`, dpop: proof }, PF_BUILD())).statusCode).toBe(204);
      const replayed = await inject("POST", "/v1/engine-runner/lease", { authorization: `DPoP ${token}`, dpop: proof }, PF_BUILD());
      expect(replayed.statusCode, replayed.body).toBe(401);
      expect(replayed.json().code).toBe("dpop_proof_replayed");
      // a bearer use of the same token is refused (a self token exists only DPoP-bound)
      expect((await inject("POST", "/v1/engine-runner/lease", { authorization: `Bearer ${token}` }, PF_BUILD())).statusCode).toBe(401);
    } finally {
      await runner.revoke();
    }
  });
});

describe("S7 — the token endpoint's self-token grant refuses what it must", () => {
  it("no DPoP proof, another resource, an unknown key, or a revoked runner: refused, and audited", async () => {
    const runner = await enrolRunner();
    const noProof = await runner.client.tokenRequest({ dpop: null });
    expect(noProof.statusCode, noProof.body).toBe(400);
    expect((noProof.json() as { error: string }).error).toBe("invalid_dpop_proof");
    const wrongResource = await runner.client.tokenRequest({ form: { resource: `${ORIGIN}/v1/authz/check` } });
    expect(wrongResource.statusCode, wrongResource.body).toBe(400);
    expect((wrongResource.json() as { error: string }).error).toBe("invalid_target");
    const stranger = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
    const unknown = await stranger.tokenRequest();
    expect(unknown.statusCode, unknown.body).toBe(401);
    expect((unknown.json() as { error: string }).error).toBe("invalid_client");
    expect((await runner.client.tokenRequest()).statusCode).toBe(200);
    await runner.revoke();
    const revoked = await runner.client.tokenRequest();
    expect(revoked.statusCode, revoked.body).toBe(401);
    expect((revoked.json() as { error: string }).error).toBe("invalid_client");
    const [refusal] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "workload-token-refused"), sql`${auditLog.detail} ->> 'code' = 'engine_runner_revoked'`))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(refusal).toBeDefined();
  });

  it("an agent identity cannot take a self token (only engine runners and PDP clients)", async () => {
    const agentId = await makeAgent(`s7-not-self-${RUN}`, `s7-not-self-model-${RUN}`);
    const created = await relaxStepUpAround(db, () => inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", agentId, sponsorUserIds: [admin.id], environments: [ENV] }));
    expect(created.statusCode, created.body).toBe(201);
    const agentKey = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
    expect((await relaxStepUpAround(db, () => inject("POST", `/v1/workload-identities/${created.json().id}/credentials`, AUTH, { kind: "jwk", publicJwk: agentKey.publicJwk }))).statusCode).toBe(201);
    // named by thumbprint: not a self-token client at all; named by its identifier: not of a self-token kind
    expect((await agentKey.tokenRequest()).statusCode).toBe(401);
    const byIdentifier = await agentKey.tokenRequest({ form: { client_assertion: await agentKey.assertion({ sub: created.json().identifier }) } });
    expect([400, 401]).toContain(byIdentifier.statusCode);
  });
});

describe("S7 — key rotation (decision 12) and revocation", () => {
  it("a runner rotates its key: the old key mints nothing new, its live token lasts to expiry, the identity (and audit continuity) is unchanged", async () => {
    const runner = await enrolRunner();
    try {
      const oldToken = await runner.client.token();
      const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.engineRunnerId, runner.id));
      const next = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
      const rotationProof = (signer: TestWorkloadClient) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", typ: "regulait-key-rotation+jwt", jwk: next.publicJwk })
          .setAudience(`${ORIGIN}/v1/engine-runner/credentials`)
          .setIssuedAt()
          .sign(signer.privateKey);
      // a proof signed by any key but the new one is refused, and nothing is bound
      const forged = await call(runner.caller, "POST", "/v1/engine-runner/credentials", { publicJwk: next.publicJwk, proof: await rotationProof(runner.client) });
      expect(forged.statusCode, forged.body).toBe(401);
      const r = await call(runner.caller, "POST", "/v1/engine-runner/credentials", { publicJwk: next.publicJwk, proof: await rotationProof(next) });
      expect(r.statusCode, r.body).toBe(201);
      const creds = await db.select().from(workloadCredentials).where(eq(workloadCredentials.identityId, ident!.id));
      expect(creds).toHaveLength(2);
      const retired = creds.find((c) => c.id === r.json().retiredCredentialId)!;
      expect(retired.revokedAt).toBeNull(); // rotation is not revocation
      expect(retired.notAfter.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
      // the old key mints nothing new; the token it already got still works until it expires
      runner.client.reset();
      expect((await runner.client.tokenRequest()).statusCode).toBe(401);
      const url = `${ORIGIN}/v1/engine-runner/lease`;
      const ath = createHash("sha256").update(oldToken).digest("base64url");
      expect((await inject("POST", "/v1/engine-runner/lease", { authorization: `DPoP ${oldToken}`, dpop: await runner.client.proof("POST", url, { ath }) }, PF_BUILD())).statusCode).toBe(204);
      // the new key works, as the SAME identity
      expect((await call(next, "POST", "/v1/engine-runner/lease", PF_BUILD())).statusCode).toBe(204);
      expect(decodeJwt(await next.token()).sub).toBe(ident!.identifier);
      const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "engine-runner-key-rotated"), eq(auditLog.objectId, ident!.id)));
      expect(audit).toBeDefined();
    } finally {
      await runner.revoke();
    }
  });

  // ---- review of #380, MEDIUM 1 and 2: one rotation per key, and a rotated-out key proves nothing ----

  /** a rotation proof by `next` (the key rotated TO) */
  const rotationProofBy = (next: TestWorkloadClient) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", typ: "regulait-key-rotation+jwt", jwk: next.publicJwk })
      .setAudience(`${ORIGIN}/v1/engine-runner/credentials`)
      .setIssuedAt()
      .sign(next.privateKey);
  const liveKeysOf = async (identityId: string) =>
    (
      (await db.execute(
        sql`SELECT count(*)::int AS n FROM workload_credentials WHERE identity_id = ${identityId} AND revoked_at IS NULL AND not_after > clock_timestamp()`,
      )) as unknown as { rows: Array<{ n: number }> }
    ).rows[0]!.n;

  it("a token whose key was already rotated out rotates nothing: a second rotation on the same token is 409", async () => {
    const runner = await enrolRunner();
    try {
      const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.engineRunnerId, runner.id));
      const first = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
      const r1 = await call(runner.caller, "POST", "/v1/engine-runner/credentials", { publicJwk: first.publicJwk, proof: await rotationProofBy(first) });
      expect(r1.statusCode, r1.body).toBe(201);
      // the SAME (still unexpired) token, another new key: the key it was issued to is no longer live
      const second = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
      const r2 = await call(runner.caller, "POST", "/v1/engine-runner/credentials", { publicJwk: second.publicJwk, proof: await rotationProofBy(second) });
      expect(r2.statusCode, r2.body).toBe(409);
      expect(r2.json().error).toBe("credential_not_live");
      expect(await liveKeysOf(ident!.id)).toBe(1);
    } finally {
      await runner.revoke();
    }
  });

  it("concurrent rotations on one token leave exactly ONE new key", async () => {
    const runner = await enrolRunner();
    try {
      const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.engineRunnerId, runner.id));
      const keys = [0, 1, 2].map(() => new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" }));
      const answers = await Promise.all(
        keys.map(async (k) => call(runner.caller, "POST", "/v1/engine-runner/credentials", { publicJwk: k.publicJwk, proof: await rotationProofBy(k) })),
      );
      const codes = answers.map((a) => a.statusCode).sort();
      expect(codes, answers.map((a) => a.body).join(" | ")).toEqual([201, 409, 409]);
      expect(await liveKeysOf(ident!.id)).toBe(1);
      const creds = await db.select().from(workloadCredentials).where(eq(workloadCredentials.identityId, ident!.id));
      expect(creds).toHaveLength(2); // the enrolled key (rotated out) and the ONE new key
    } finally {
      await runner.revoke();
    }
  });

  it("a supersede proof by a rotated-out key supersedes nothing; one by the live key does", async () => {
    const runner = await enrolRunner();
    try {
      const oldJkt = await runner.client.jkt();
      const next = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
      expect((await call(runner.caller, "POST", "/v1/engine-runner/credentials", { publicJwk: next.publicJwk, proof: await rotationProofBy(next) })).statusCode).toBe(201);
      const supersede = async (signer: TestWorkloadClient, kid: string, alg: "EdDSA" | "Ed25519" = "EdDSA") => {
        const fresh = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
        const proof = await new SignJWT({ jkt: await calculateJwkThumbprint(fresh.publicJwk as JWK, "sha256") })
          .setProtectedHeader({ alg, typ: "regulait-runner-supersede+jwt", kid })
          .setAudience(ORIGIN)
          .setJti(randomUUID())
          .setIssuedAt()
          .sign(signer.privateKey);
        const t = await inject("POST", "/v1/engines/promptfoo/enrollment-tokens", admin.key, { label: `s7-sup-${RUN}` });
        const r = await inject("POST", "/v1/engine-runner/register", { authorization: `Bearer ${t.json().token}` }, {
          name: `s7-sup-${randomBytes(2).toString("hex")}`,
          ...PF_BUILD(),
          selfTest: selfTest(),
          publicJwk: fresh.publicJwk,
          supersedes: proof,
        });
        expect(r.statusCode, r.body).toBe(201);
        return r.json() as { runnerId: string; supersededRunnerId: string | null };
      };
      // the enrolled key was rotated out: its proof is a claim nobody can make good on
      const stale = await supersede(runner.client, oldJkt);
      expect(stale.supersededRunnerId).toBeNull();
      const [still] = await db.select({ revokedAt: engineRunners.revokedAt }).from(engineRunners).where(eq(engineRunners.id, runner.id));
      expect(still!.revokedAt).toBeNull();
      // the control: the LIVE key supersedes this runner (its proof labelled `Ed25519`, RFC 9864: both labels of
      // the signature are accepted)
      const live = await supersede(next, await next.jkt(), "Ed25519");
      expect(live.supersededRunnerId).toBe(runner.id);
      await inject("DELETE", `/v1/engine-runners/${stale.runnerId}`, admin.key);
      await inject("DELETE", `/v1/engine-runners/${live.runnerId}`, admin.key);
    } finally {
      await inject("DELETE", `/v1/engine-runners/${runner.id}`, admin.key);
    }
  });

  it("revoking a key refuses every token it authenticated at the next use (decision 12)", async () => {
    const pdp = await provisionPdp();
    const ask = () => call(pdp.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL });
    expect((await ask()).statusCode).toBe(200);
    await pdp.revoke();
    const after = await ask();
    expect(after.statusCode, after.body).toBe(401);
  });
});

describe("S7 — review of #380: what else a self token must not do", () => {
  it("INFO 7: the DPoP proof must be signed by the key that authenticated the client", async () => {
    const runner = await enrolRunner();
    try {
      const other = new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" });
      const r = await runner.client.tokenRequest({ dpop: await other.proof("POST", `${ORIGIN}/oauth/token`) });
      expect(r.statusCode, r.body).toBe(400);
      expect((r.json() as { error: string }).error).toBe("invalid_dpop_proof");
      const [audited] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "workload-token-refused"), sql`${auditLog.detail} ->> 'code' = 'dpop_key_mismatch'`))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(audited).toBeDefined();
      expect((await runner.client.tokenRequest()).statusCode).toBe(200);
    } finally {
      await runner.revoke();
    }
  });

  it("a self token is no subject_token: token exchange with it issues nothing", async () => {
    const runner = await enrolRunner();
    try {
      const token = await runner.client.token();
      const r = await runner.client.tokenRequest({
        form: {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: token,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource: `${ORIGIN}/v1/chat/completions`,
        },
      });
      expect([400, 401], r.body).toContain(r.statusCode);
      expect((r.json() as { access_token?: string }).access_token).toBeUndefined();
    } finally {
      await runner.revoke();
    }
  });

  it("a suspended identity takes no new token and its live token is refused", async () => {
    const pdp = await provisionPdp();
    try {
      const ask = () => call(pdp.caller, "POST", "/v1/authz/check", { userId: alice.id, serverId, toolName: TOOL });
      expect((await ask()).statusCode).toBe(200);
      await db.update(workloadIdentities).set({ status: "suspended" }).where(eq(workloadIdentities.id, pdp.identityId));
      const live = await ask();
      expect(live.statusCode, live.body).toBe(401);
      pdp.client.reset();
      expect((await pdp.client.tokenRequest()).statusCode).toBe(401);
    } finally {
      await db.update(workloadIdentities).set({ status: "active" }).where(eq(workloadIdentities.id, pdp.identityId));
      await pdp.revoke();
    }
  });
});

describe("S7 — review of #380, LOW 5: both labels of an Ed25519 signature", () => {
  it("an assertion and DPoP proofs labelled `Ed25519` (RFC 9864) are accepted, as `EdDSA` (RFC 8037) is", async () => {
    const runner = await enrolRunner();
    try {
      const nowS = () => Math.floor(Date.now() / 1000);
      const cid = await runner.client.clientId();
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: "Ed25519", kid: await runner.client.jkt() })
        .setIssuer(cid)
        .setSubject(cid)
        .setAudience(`${ORIGIN}/oauth/token`)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(nowS() + 60)
        .sign(runner.client.privateKey);
      const proof = (htu: string, extra: Record<string, unknown> = {}) =>
        new SignJWT({ htm: "POST", htu, iat: nowS(), jti: randomUUID(), nonce: runner.client.nonce(), ...extra })
          .setProtectedHeader({ alg: "Ed25519", typ: "dpop+jwt", jwk: runner.client.publicJwk as JWK })
          .sign(runner.client.privateKey);
      const r = await runner.client.tokenRequest({ form: { client_assertion: assertion }, dpop: await proof(`${ORIGIN}/oauth/token`) });
      expect(r.statusCode, r.body).toBe(200);
      const token = (r.json() as { access_token: string }).access_token;
      const ath = createHash("sha256").update(token).digest("base64url");
      const lease = await inject("POST", "/v1/engine-runner/lease", { authorization: `DPoP ${token}`, dpop: await proof(`${ORIGIN}/v1/engine-runner/lease`, { ath }) }, PF_BUILD());
      expect(lease.statusCode, lease.body).toBe(204);
      // and the RFC 8037 label (the test client's default) on the same key
      runner.client.reset();
      expect((await call(runner.caller, "POST", "/v1/engine-runner/lease", PF_BUILD())).statusCode).toBe(204);
    } finally {
      await runner.revoke();
    }
  });
});

describe("S7 — review of #380, LOW 2: the admin bind route keeps a runner at two live keys", () => {
  it("an admin cannot bind a third live key to an engine runner's identity (409 runner_key_limit)", async () => {
    const runner = await enrolRunner();
    try {
      const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.engineRunnerId, runner.id));
      const bind = (k: TestWorkloadClient) =>
        relaxStepUpAround(db, () => inject("POST", `/v1/workload-identities/${ident!.id}/credentials`, AUTH, { kind: "jwk", publicJwk: k.publicJwk }));
      const second = await bind(new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" }));
      expect(second.statusCode, second.body).toBe(201);
      const third = await bind(new TestWorkloadClient(app, { issuer: ORIGIN, dataKey: DATA_KEY, kind: "engine_runner" }));
      expect(third.statusCode, third.body).toBe(409);
      expect(third.json().error).toBe("runner_key_limit");
    } finally {
      await runner.revoke();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  createDb,
  eq,
  gitConnections,
  interceptionScopeRules,
  isNull,
  inArray,
  mcpServers,
  modelCredentials,
  pmConnections,
  projects,
  complianceProfiles,
  runMigrations,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

/**
 * GET /v1/setup/status — the guided "connect your first real provider"
 * journey's one endpoint. This suite proves:
 *  - the endpoint is ADMIN-only (a non-admin key gets the global 403);
 *  - every step flips done the moment its REAL object is created, driven
 *    through the same public API the portal forms use;
 *  - mock objects are honestly NOT enough (a mock git/PM connection or a mock
 *    dispatch leaves the step pending, reported in the evidence);
 *  - evidence names the objects (provider, connection name, counts), and
 *  - blockedBy ordering: the first-real-dispatch step names model_provider
 *    until a real provider is configured, then empties.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * beforeAll clears exactly the tables the checklist aggregates — every file
 * in this suite seeds its own objects, so rows left by ALREADY-FINISHED files
 * are safe to remove (the same precedent env-fallback.test.ts set for
 * model_credentials). Non-admin users are deactivated rather than deleted
 * (FK-heavy) and reactivated verbatim in afterAll.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "setupstatus-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberId: string;
let memberAuth: { authorization: string };
let reactivateIds: string[] = [];

// same env hygiene as env-fallback.test.ts: the model_provider step reads the
// provider env vars, so an ambient key in the runner's shell would flip it.
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
] as const;
const ORIG_ENV: Record<string, string | undefined> = {};
for (const name of PROVIDER_ENV_VARS) ORIG_ENV[name] = process.env[name];
const clearEnv = () => {
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
};

const getStatus = async (headers = AUTH) =>
  app.inject({ method: "GET", headers, url: "/v1/setup/status" });
const stepByKey = (body: { steps: Array<{ key: string }> }, key: string) => {
  const s = body.steps.find((x) => x.key === key);
  expect(s, `step '${key}' present`).toBeDefined();
  return s as {
    key: string;
    title: string;
    done: boolean;
    evidence: Record<string, unknown>;
    blockedBy: string[];
  };
};

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  clearEnv();
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the env-key fallback ships OFF. This file pins the checklist's env-key
  // evidence source, so it switches the fallback on explicitly.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { envKeyFallbackEnabled: true }, interception: false, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // clear exactly what the checklist reads (rows from already-finished files)
  await db.delete(usageEvents);
  await db.delete(gitConnections);
  await db.delete(pmConnections);
  await db.delete(mcpServers);
  await db.delete(projects);
  await db.delete(modelCredentials);
  await db.delete(complianceProfiles);
  await db.delete(interceptionScopeRules);
  const put = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: { anthropicCompatEnabled: false, openaiCompatEnabled: false },
  });
  expect(put.statusCode).toBe(200);
  // ADR-0034 amendment #2 — `pm_connections.baseUrl` is now behind the
  // default-deny egress guard, and this file's "a REAL (jira) connection
  // counts" step has to supply one. Allow-list 127.0.0.1 with the private-range
  // and plaintext opt-ins, exactly as an air-gapped operator would, and point
  // the fixture at a loopback dead port: the guard RESOLVES every destination,
  // so a real vendor hostname would make this suite depend on DNS. Explicit
  // rather than inherited — a sibling file's entry is not this file's fixture.
  const egressAllowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "setup-status suite: loopback PM-connection fixture",
    },
  });
  expect(egressAllowed.statusCode).toBe(201);
  // deactivate every ACTIVE non-admin user so the non_admin_user step starts
  // honestly pending; restored verbatim in afterAll
  const disabled = await db
    .update(users)
    .set({ disabledAt: new Date() })
    .where(and(eq(users.isAdmin, false), isNull(users.disabledAt)))
    .returning({ id: users.id });
  reactivateIds = disabled.map((d) => d.id);
});

afterAll(async () => {
  await restoreSb1Posture?.();
  if (reactivateIds.length) {
    await db
      .update(users)
      .set({ disabledAt: null })
      .where(inArray(users.id, reactivateIds));
  }
  await db.delete(modelCredentials); // leave the shared anthropic slot clean
  clearEnv();
  for (const name of PROVIDER_ENV_VARS) {
    if (ORIG_ENV[name] !== undefined) process.env[name] = ORIG_ENV[name];
  }
});

describe("GET /v1/setup/status", () => {
  it("starts with every step pending, complete=false, and first_real_dispatch blocked by model_provider", async () => {
    const res = await getStatus();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.complete).toBe(false);
    expect(body.totalCount).toBe(9);
    expect(body.doneCount).toBe(0);
    for (const s of body.steps) expect(s.done, `step ${s.key} pending`).toBe(false);
    expect(stepByKey(body, "first_real_dispatch").blockedBy).toEqual(["model_provider"]);
    // independent steps carry no ordering claim
    expect(stepByKey(body, "git_connection").blockedBy).toEqual([]);
  });

  it("is admin-only: a non-admin key gets the global 403, and creating that user flips non_admin_user with a count as evidence", async () => {
    const user = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "setup-member@example.com", displayName: "Setup Member" },
    });
    expect(user.statusCode).toBe(201);
    memberId = user.json().id;
    const key = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${memberId}/keys`,
      payload: { name: "portal" },
    });
    memberAuth = { authorization: `Bearer ${key.json().token}` };

    const denied = await getStatus(memberAuth);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("admin_only");

    const body = (await getStatus()).json();
    const s = stepByKey(body, "non_admin_user");
    expect(s.done).toBe(true);
    expect(s.evidence.activeNonAdminUsers).toBe(1);
  });

  it("model_provider: flips on the env fallback (evidence source 'env'), un-flips when cleared, flips on a stored platform credential", async () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-setup-test";
    let s = stepByKey((await getStatus()).json(), "model_provider");
    expect(s.done).toBe(true);
    expect(s.evidence.providers).toEqual([{ provider: "anthropic", source: "env" }]);
    // the key itself must never leak into the evidence
    expect(JSON.stringify(s.evidence)).not.toContain("sk-ant-setup-test");

    clearEnv();
    s = stepByKey((await getStatus()).json(), "model_provider");
    expect(s.done).toBe(false);

    const cred = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-ant-stored-setup" },
    });
    expect(cred.statusCode).toBe(201);
    const body = (await getStatus()).json();
    s = stepByKey(body, "model_provider");
    expect(s.done).toBe(true);
    expect(s.evidence.providers).toEqual([
      { provider: "anthropic", source: "platform_credential" },
    ]);
    expect(JSON.stringify(body)).not.toContain("sk-ant-stored-setup");
    // blockedBy ordering: the prerequisite is met, so the dispatch step unblocks
    expect(stepByKey(body, "first_real_dispatch").blockedBy).toEqual([]);
  });

  it("git_connection: a MOCK connection honestly does NOT complete it; a real provider does, named in the evidence", async () => {
    const mock = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "setup-mock-git", provider: "mock", token: "t" },
    });
    expect(mock.statusCode).toBe(201);
    let s = stepByKey((await getStatus()).json(), "git_connection");
    expect(s.done).toBe(false);
    expect(s.evidence.mockCount).toBe(1);

    const real = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "setup-github", provider: "github", token: "ghp_x" },
    });
    expect(real.statusCode).toBe(201);
    s = stepByKey((await getStatus()).json(), "git_connection");
    expect(s.done).toBe(true);
    expect(s.evidence.real).toEqual([{ name: "setup-github", provider: "github" }]);
    expect(s.evidence.mockCount).toBe(1);
  });

  it("pm_connection: mock does not count, a real (jira) connection does", async () => {
    const mock = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name: "setup-mock-pm", provider: "mock", project: "SETUP", token: "t" },
    });
    expect(mock.statusCode).toBe(201);
    let s = stepByKey((await getStatus()).json(), "pm_connection");
    expect(s.done).toBe(false);
    expect(s.evidence.mockCount).toBe(1);

    const real = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: {
        name: "setup-jira",
        provider: "jira",
        baseUrl: "http://127.0.0.1:9/setup-test",
        project: "SETUP",
        token: "jt",
      },
    });
    expect(real.statusCode).toBe(201);
    s = stepByKey((await getStatus()).json(), "pm_connection");
    expect(s.done).toBe(true);
    expect(s.evidence.real).toEqual([{ name: "setup-jira", provider: "jira" }]);
  });

  it("mcp_server: flips when a server is registered, named in the evidence", async () => {
    const srv = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: "setup-mcp", url: "http://localhost:9999" },
    });
    expect(srv.statusCode).toBe(201);
    const s = stepByKey((await getStatus()).json(), "mcp_server");
    expect(s.done).toBe(true);
    expect(s.evidence.servers).toEqual([{ name: "setup-mcp", url: "http://localhost:9999" }]);
  });

  it("project + compliance_profile: a bare project completes 'project' but not the compliance step; a defined profile assigned as a project classification completes it", async () => {
    const proj = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: "setup-plain-project" },
    });
    expect(proj.statusCode).toBe(201);
    let body = (await getStatus()).json();
    expect(stepByKey(body, "project").done).toBe(true);
    expect(stepByKey(body, "project").evidence.projects).toContain("setup-plain-project");
    let c = stepByKey(body, "compliance_profile");
    expect(c.done).toBe(false);
    expect(c.evidence.profilesDefined).toBe(0);

    // a profile alone (no project carrying its tag) is still not "assigned"
    const prof = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/profiles",
      payload: { tag: "setup-hipaa", piiMode: "block" },
    });
    expect(prof.statusCode).toBe(201);
    c = stepByKey((await getStatus()).json(), "compliance_profile");
    expect(c.done).toBe(false);
    expect(c.evidence.profilesDefined).toBe(1);

    const classified = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: "setup-classified-project", classifications: ["setup-hipaa"] },
    });
    expect(classified.statusCode).toBe(201);
    c = stepByKey((await getStatus()).json(), "compliance_profile");
    expect(c.done).toBe(true);
    expect(c.evidence.classifiedProjects).toEqual([
      { name: "setup-classified-project", tags: ["setup-hipaa"] },
    ]);
  });

  it("interception_surface: flips when a compat surface is enabled, back when disabled, and again when the MCP proxy has actually been used", async () => {
    let s = stepByKey((await getStatus()).json(), "interception_surface");
    expect(s.done).toBe(false);
    expect(s.evidence).toMatchObject({
      anthropicCompatEnabled: false,
      openaiCompatEnabled: false,
      scopeRulesExist: false,
      mcpProxyCalls: 0,
    });

    await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: true },
    });
    s = stepByKey((await getStatus()).json(), "interception_surface");
    expect(s.done).toBe(true);
    expect(s.evidence.anthropicCompatEnabled).toBe(true);

    await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/interception/settings",
      payload: { anthropicCompatEnabled: false },
    });
    s = stepByKey((await getStatus()).json(), "interception_surface");
    expect(s.done).toBe(false);

    // real MCP proxy usage is metered as an mcp_tool usage row — that counts
    await db.insert(usageEvents).values({
      userId: memberId,
      objectType: "mcp_tool",
      operation: "setup-test-tool",
    });
    s = stepByKey((await getStatus()).json(), "interception_surface");
    expect(s.done).toBe(true);
    expect(s.evidence.mcpProxyCalls).toBe(1);
  });

  it("first_real_dispatch: mock dispatches are honestly not enough; a real-provider dispatch completes it — and the whole checklist", async () => {
    await db.insert(usageEvents).values({
      userId: memberId,
      objectType: "agent",
      provider: "mock",
      model: "mock-1",
      inputTokens: 1,
      outputTokens: 1,
    });
    let body = (await getStatus()).json();
    let s = stepByKey(body, "first_real_dispatch");
    expect(s.done).toBe(false);
    expect(s.evidence).toMatchObject({ realDispatches: 0, mockDispatches: 1 });
    expect(body.complete).toBe(false);

    await db.insert(usageEvents).values({
      userId: memberId,
      objectType: "agent",
      provider: "anthropic",
      model: "claude-opus-5",
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
    });
    body = (await getStatus()).json();
    s = stepByKey(body, "first_real_dispatch");
    expect(s.done).toBe(true);
    expect(s.evidence).toMatchObject({ realDispatches: 1, mockDispatches: 1 });

    // every step is now done — the card the portal renders collapses
    expect(body.doneCount).toBe(9);
    expect(body.complete).toBe(true);
  });
});

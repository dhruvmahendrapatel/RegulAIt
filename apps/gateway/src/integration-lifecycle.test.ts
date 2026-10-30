import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  connectorCredentials,
  connectors,
  createDb,
  desc,
  eq,
  gitConnections,
  governancePolicyEpoch,
  mcpRegistries,
  mcpRegistryEntries,
  mcpServers,
  mcpTools,
  pmConnections,
  runMigrations,
  sql,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { decryptSecret } from "./secrets.js";
import { executeGovernedToolCall, MCP_SERVER_DISABLED_RULE_ID } from "./mcp-proxy.js";
import { CONNECTOR_DISABLED_RULE_ID } from "./connector-call.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

/**
 * ADR-0207 — lifecycle for integrations (G3–G6): connectors and MCP servers are disabled (reason, audited), enabled
 * again (a settings_relax step-up) and deleted only once disabled and unreferenced; an MCP registry is deleted only
 * once disabled; git and PM connections are edited and their tokens replaced in place; a PM webhook secret rotates
 * with a 24-hour overlap. Every route is admin-only and audited in its write's transaction. Shares one DB; prefix ilc-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "ilc-bootstrap-token";
/** the bootstrap credential answers a step-up itself; an admin API key cannot (it has no interactive method) */
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const RUN = Date.now().toString(36);
const N = (name: string) => `ilc-${name}-${RUN}`;
const REASON = "incident 42: credential suspected leaked";

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string };
let memberId: string;
let adminAuth: { authorization: string };
let adminId: string;
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;

async function mkUser(email: string, isAdmin: boolean) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") } });
  expect(u.statusCode).toBe(201);
  if (isAdmin) {
    const up = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/admin`, payload: { isAdmin: true, reason: "ilc coverage" } });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "ilc" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const auditRows = (objectId: string, ruleId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId))).orderBy(desc(auditLog.at));

async function mkConnector(name: string) {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/connectors", payload: { name: N(name), kind: "data", providerKind: "mock" } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function mkServer(name: string) {
  const [s] = await db.insert(mcpServers).values({ name: N(name), url: `https://${N(name)}.example.test/mcp` }).returning({ id: mcpServers.id });
  return s!.id;
}

const disable = (base: string, id: string, headers = adminAuth) =>
  app.inject({ method: "POST", headers, url: `${base}/${id}/enabled`, payload: { enabled: false, reason: REASON } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const member = await mkUser(`ilc-member-${RUN}@example.com`, false);
  memberId = member.id;
  memberAuth = member.auth;
  const admin = await mkUser(`ilc-admin-${RUN}@example.com`, true);
  adminId = admin.id;
  adminAuth = admin.auth;
});

afterAll(async () => {
  await restoreAdminKeyMfa?.();
});

// ---------------------------------------------------------------------------
// G3 — connectors
// ---------------------------------------------------------------------------

describe("G3 connectors: disable, enable, delete", () => {
  it("an admin disables with a reason; the list shows who and why; the audit row is a deny", async () => {
    const id = await mkConnector("c-dis");
    const r = await disable("/v1/connectors", id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, enabled: false, disabledReason: REASON, disabledBy: `ilc-admin-${RUN}@example.com` });
    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/connectors" });
    const row = (list.json().connectors as Array<Record<string, unknown>>).find((c) => c.id === id);
    expect(row).toMatchObject({ enabled: false, disabledReason: REASON });
    const [a] = await auditRows(id, "connector-disabled");
    expect(a).toMatchObject({ userId: adminId, effect: "deny", objectType: "connector" });
  });

  it("disabling needs a reason of at least 10 characters, and an unknown field is refused", async () => {
    const id = await mkConnector("c-reason");
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/enabled`, payload: { enabled: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/enabled`, payload: { enabled: false, reason: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/enabled`, payload: { enabled: false, reason: REASON, name: "x" } })).statusCode).toBe(400);
    const [c] = await db.select().from(connectors).where(eq(connectors.id, id));
    expect(c!.disabledAt).toBeNull();
  });

  it("a disabled connector refuses every governed call, audited, and advances the policy epoch", async () => {
    const id = await mkConnector("c-call");
    await app.inject({ method: "POST", url: "/v1/grants/connectors", headers: AUTH, payload: { userId: memberId, connectorId: id, mode: "readwrite" } });
    const [before] = await db.select().from(governancePolicyEpoch);
    await disable("/v1/connectors", id);
    const [after] = await db.select().from(governancePolicyEpoch);
    expect(after!.epoch).toBeGreaterThan(before!.epoch);
    const r = await app.inject({ method: "POST", headers: memberAuth, url: `/v1/connectors/${id}/invoke`, payload: { operation: "read", object: "record" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "connector_disabled", ruleId: CONNECTOR_DISABLED_RULE_ID });
    const [a] = await auditRows(id, CONNECTOR_DISABLED_RULE_ID);
    expect(a).toMatchObject({ userId: memberId, effect: "deny" });
  });

  it("enabling again is a step-up: an admin API key is refused and the connector stays disabled; a step-up enables it", async () => {
    const id = await mkConnector("c-en");
    await disable("/v1/connectors", id);
    const refused = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/enabled`, payload: { enabled: true } });
    expect(refused.statusCode).toBe(403);
    const [still] = await db.select().from(connectors).where(eq(connectors.id, id));
    expect(still!.disabledAt).not.toBeNull();
    const ok = await app.inject({ method: "POST", headers: AUTH, url: `/v1/connectors/${id}/enabled`, payload: { enabled: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ enabled: true, disabledReason: null, disabledAt: null });
    const [a] = await auditRows(id, "connector-enabled");
    expect(a).toMatchObject({ effect: "allow" });
  });

  it("a non-admin cannot disable, enable or delete", async () => {
    const id = await mkConnector("c-member");
    expect((await disable("/v1/connectors", id, memberAuth)).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", headers: memberAuth, url: `/v1/connectors/${id}` })).statusCode).toBe(403);
    const [c] = await db.select().from(connectors).where(eq(connectors.id, id));
    expect(c!.disabledAt).toBeNull();
  });

  it("delete is refused while the connector is enabled", async () => {
    const id = await mkConnector("c-live");
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/connectors/${id}` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("connector_not_disabled");
  });

  it("delete is refused while an approval refers to it, with the count and the id", async () => {
    const id = await mkConnector("c-evidence");
    const [ap] = await db.insert(approvals).values({ userId: memberId, approverUserId: adminId, objectType: "connector_call", connectorId: id }).returning({ id: approvals.id });
    await disable("/v1/connectors", id);
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/connectors/${id}` });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "connector_in_use", approvals: 1, chatopsConnections: 0, approvalIds: [ap!.id] });
    expect(await db.select().from(connectors).where(eq(connectors.id, id))).toHaveLength(1);
  });

  it("a disabled, unreferenced connector is deleted; grants and its credential cascade, and the audit row counts them", async () => {
    const id = await mkConnector("c-del");
    await app.inject({ method: "POST", url: "/v1/grants/connectors", headers: AUTH, payload: { userId: memberId, connectorId: id, mode: "read" } });
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/credential`, payload: { token: "secret-token-1" } })).statusCode).toBe(201);
    await disable("/v1/connectors", id);
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/connectors/${id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: true, cascade: { credential: true, grants: 1 } });
    expect(await db.select().from(connectors).where(eq(connectors.id, id))).toHaveLength(0);
    const [a] = await auditRows(id, "connector-removed");
    expect(a!.detail).toMatchObject({ phase: "removed", name: N("c-del"), cascade: { credential: true, grants: 1 } });
    expect((await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/connectors/${id}` })).statusCode).toBe(404);
  });

  it("saving and removing a credential are audited, and no audit row carries the secret", async () => {
    const id = await mkConnector("c-cred");
    await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/credential`, payload: { token: "first-secret-value" } });
    await app.inject({ method: "POST", headers: adminAuth, url: `/v1/connectors/${id}/credential`, payload: { token: "second-secret-value" } });
    const saved = await auditRows(id, "connector-credential-saved");
    expect(saved.map((r) => (r.detail as { change: string }).change).sort()).toEqual(["replaced", "set"]);
    const del = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/connectors/${id}/credential` });
    expect(del.statusCode).toBe(200);
    expect(await db.select().from(connectorCredentials).where(eq(connectorCredentials.connectorId, id))).toHaveLength(0);
    const [removed] = await auditRows(id, "connector-credential-removed");
    expect(removed).toMatchObject({ userId: adminId, effect: "allow" });
    const all = await db.select().from(auditLog).where(eq(auditLog.objectId, id));
    expect(JSON.stringify(all)).not.toMatch(/first-secret-value|second-secret-value/);
  });
});

// ---------------------------------------------------------------------------
// G4 — MCP servers and registries
// ---------------------------------------------------------------------------

describe("G4 MCP servers: disable, enable, edit, delete", () => {
  it("a disabled server refuses the proxy route and the governed call, each with a deny audit row", async () => {
    const id = await mkServer("s-call");
    await db.insert(mcpTools).values({ serverId: id, name: "read_thing", kind: "read" });
    const [before] = await db.select().from(governancePolicyEpoch);
    expect((await disable("/v1/servers", id)).statusCode).toBe(200);
    const [after] = await db.select().from(governancePolicyEpoch);
    expect(after!.epoch).toBeGreaterThan(before!.epoch);

    const proxied = await app.inject({ method: "POST", headers: memberAuth, url: `/mcp/${id}`, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(proxied.statusCode).toBe(403);
    expect(proxied.json()).toMatchObject({ error: "mcp_server_disabled", ruleId: MCP_SERVER_DISABLED_RULE_ID });

    const out = await executeGovernedToolCall(db, DATA_KEY, { userId: memberId, serverId: id, toolName: "read_thing", arguments: {} });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.decision.ruleId).toBe(MCP_SERVER_DISABLED_RULE_ID);
    const refusals = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.serverId, id), eq(auditLog.ruleId, MCP_SERVER_DISABLED_RULE_ID)));
    expect(refusals.length).toBe(2);
    expect(refusals.every((r) => r.effect === "deny")).toBe(true);
  });

  it("a breaker-style write that does not touch disabled_at leaves the policy epoch alone", async () => {
    const id = await mkServer("s-epoch");
    const [before] = await db.select().from(governancePolicyEpoch);
    await db.update(mcpServers).set({ pricePerCallUsd: 0.01 }).where(eq(mcpServers.id, id));
    const [after] = await db.select().from(governancePolicyEpoch);
    expect(after!.epoch).toBe(before!.epoch);
  });

  it("the list carries enabled and the reason; a disabled server cannot be edited", async () => {
    const id = await mkServer("s-list");
    await disable("/v1/servers", id);
    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/servers" });
    const row = (list.json().servers as Array<Record<string, unknown>>).find((s) => s.id === id);
    expect(row).toMatchObject({ enabled: false, disabledReason: REASON, disabledBy: `ilc-admin-${RUN}@example.com` });
    const edit = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/servers/${id}`, payload: { name: N("s-list-renamed") } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("mcp_server_disabled");
  });

  it("a rename is audited with both names", async () => {
    const id = await mkServer("s-rename");
    const r = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/servers/${id}`, payload: { name: N("s-renamed") } });
    expect(r.statusCode).toBe(200);
    const [a] = await auditRows(id, "mcp-server-updated");
    expect(a!.detail).toMatchObject({ from: { name: N("s-rename") }, to: { name: N("s-renamed") } });
  });

  it("enabling again is a step-up", async () => {
    const id = await mkServer("s-en");
    await disable("/v1/servers", id);
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `/v1/servers/${id}/enabled`, payload: { enabled: true } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${id}/enabled`, payload: { enabled: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ enabled: true });
    expect(await auditRows(id, "mcp-server-enabled")).toHaveLength(1);
  });

  it("delete is refused while enabled, and while approvals or versioned rules refer to it", async () => {
    const id = await mkServer("s-evidence");
    expect((await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/servers/${id}` })).json().error).toBe("mcp_server_not_disabled");
    await db.insert(approvals).values({ userId: memberId, approverUserId: adminId, serverId: id, toolName: "t" });
    await db.execute(sql`INSERT INTO approval_rules (approver_user_id, server_id, scope) VALUES (${adminId}, ${id}, 'fleet')`);
    await disable("/v1/servers", id);
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/servers/${id}` });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "mcp_server_in_use", approvals: 1, approvalRules: 1, agentGrants: 0 });
    expect(await db.select().from(mcpServers).where(eq(mcpServers.id, id))).toHaveLength(1);
  });

  it("a disabled, unreferenced server is deleted with its tools; the audit row counts them", async () => {
    const id = await mkServer("s-del");
    await db.insert(mcpTools).values([{ serverId: id, name: "a", kind: "read" }, { serverId: id, name: "b", kind: "write" }]);
    await disable("/v1/servers", id);
    const [before] = await db.select().from(governancePolicyEpoch);
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/servers/${id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: true, cascade: { tools: 2 } });
    const [after] = await db.select().from(governancePolicyEpoch);
    expect(after!.epoch).toBeGreaterThan(before!.epoch);
    const [a] = await auditRows(id, "mcp-server-removed");
    expect(a!.detail).toMatchObject({ phase: "removed", cascade: { tools: 2 } });
  });

  it("a non-admin cannot disable or delete a server", async () => {
    const id = await mkServer("s-member");
    expect((await disable("/v1/servers", id, memberAuth)).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", headers: memberAuth, url: `/v1/servers/${id}` })).statusCode).toBe(403);
  });
});

describe("G4 MCP registries: delete", () => {
  it("is refused while enabled; once disabled, entries go and imported servers stay without the link", async () => {
    const [reg] = await db.insert(mcpRegistries).values({ name: N("reg"), url: "https://registry.example.test", enabled: true }).returning();
    const serverId = await mkServer("s-imported");
    await db.update(mcpServers).set({ registryId: reg!.id }).where(eq(mcpServers.id, serverId));
    await db.insert(mcpRegistryEntries).values({ registryId: reg!.id, upstreamName: "io.example/x", upstreamVersion: "1.0.0", kind: "catalogue_only" });
    const refused = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/mcp-registries/${reg!.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("mcp_registry_not_disabled");
    await db.update(mcpRegistries).set({ enabled: false }).where(eq(mcpRegistries.id, reg!.id));
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/mcp-registries/${reg!.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: true, entriesRemoved: 1, detachedServers: [{ id: serverId }] });
    const [s] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(s!.registryId).toBeNull();
    const [a] = await auditRows(reg!.id, "mcp-registry-removed");
    expect(a!.detail).toMatchObject({ phase: "registry-removed", entriesRemoved: 1, detachedServers: 1 });
    expect((await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/mcp-registries/${reg!.id}` })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// G5 — git connections
// ---------------------------------------------------------------------------

describe("G5 git connections: edit, replace token, in-use delete", () => {
  async function mkGit(name: string) {
    const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/git/connections", payload: { name: N(name), provider: "mock", token: "old-git-token" } });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  it("edits the base URL (audited with both values); name and provider cannot change", async () => {
    const id = await mkGit("g-edit");
    // set around the API, so the edit under test (back to the provider default) needs no egress decision
    await db.update(gitConnections).set({ baseUrl: "https://git.example.test/api" }).where(eq(gitConnections.id, id));
    const r = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/git/connections/${N("g-edit")}`, payload: { baseUrl: null } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ baseUrl: null, provider: "mock", name: N("g-edit") });
    const [a] = await auditRows(id, "git-connection-updated");
    expect(a!.detail).toMatchObject({ from: { baseUrl: "https://git.example.test/api" }, to: { baseUrl: null } });
    const renamed = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/git/connections/${N("g-edit")}`, payload: { baseUrl: null, name: "x" } });
    expect(renamed.statusCode).toBe(400);
  });

  it("a base URL the egress guard refuses is refused and nothing changes", async () => {
    const id = await mkGit("g-egress");
    const r = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/git/connections/${N("g-egress")}`, payload: { baseUrl: "http://169.254.169.254/latest" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("egress_blocked");
    const [g] = await db.select().from(gitConnections).where(eq(gitConnections.id, id));
    expect(g!.baseUrl).toBeNull();
  });

  it("replaces the token in place; the response never carries it; the audit row is written", async () => {
    const id = await mkGit("g-token");
    const r = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/git/connections/${N("g-token")}/token`, payload: { token: "new-git-token" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("new-git-token");
    const [g] = await db.select().from(gitConnections).where(eq(gitConnections.id, id));
    expect(decryptSecret(DATA_KEY, g!.tokenCiphertext)).toBe("new-git-token");
    expect(await auditRows(id, "git-connection-token-rotated")).toHaveLength(1);
    const bad = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/git/connections/${N("g-token")}/token`, payload: { token: "" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("token\":\"");
  });

  it("delete is refused while an active template names the connection, and allowed once it is retired", async () => {
    await mkGit("g-used");
    const [tpl] = await db
      .insert(workflowTemplates)
      .values({ name: N("tpl-git"), definition: { stages: [{ id: "pr", type: "git_operation", action: "open_pr", connection: N("g-used"), repo: "o/r" }] } })
      .returning({ id: workflowTemplates.id });
    const r = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/git/connections/${N("g-used")}` });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "git_connection_in_use", templates: 1, templateNames: [N("tpl-git")] });
    await db.update(workflowTemplates).set({ retiredAt: new Date(), retiredReason: "ilc retire" }).where(eq(workflowTemplates.id, tpl!.id));
    expect((await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/git/connections/${N("g-used")}` })).statusCode).toBe(200);
  });

  it("a non-admin cannot edit or replace the token", async () => {
    await mkGit("g-member");
    expect((await app.inject({ method: "PATCH", headers: memberAuth, url: `/v1/git/connections/${N("g-member")}`, payload: { baseUrl: null } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", headers: memberAuth, url: `/v1/git/connections/${N("g-member")}/token`, payload: { token: "x" } })).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// G6 — PM connections
// ---------------------------------------------------------------------------

describe("G6 PM connections: edit, replace token, rotate the webhook secret", () => {
  async function mkPm(name: string) {
    const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/connections", payload: { name: N(name), provider: "mock", project: "ILC", token: "old-pm-token" } });
    expect(r.statusCode).toBe(201);
    return { id: r.json().id as string, secret: r.json().webhookSecret as string };
  }
  const hook = (name: string, secret: string) =>
    app.inject({ method: "POST", url: `/v1/pm/webhooks/${N(name)}`, headers: { "x-regulait-webhook-secret": secret }, payload: { externalId: "nope", event: "updated" } });

  it("edits project and drift resolution (audited with both values); the name cannot change", async () => {
    const { id } = await mkPm("p-edit");
    const r = await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/pm/connections/${N("p-edit")}`, payload: { project: "ILC2", driftResolution: "prefer_pm" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ project: "ILC2", driftResolution: "prefer_pm" });
    const [a] = await auditRows(id, "pm-connection-updated");
    expect(a!.detail).toMatchObject({ from: { project: "ILC", driftResolution: "manual" }, to: { project: "ILC2", driftResolution: "prefer_pm" } });
    expect((await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/pm/connections/${N("p-edit")}`, payload: { name: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", headers: adminAuth, url: `/v1/pm/connections/${N("p-edit")}`, payload: { apiVersion: 3 } })).statusCode).toBe(400);
  });

  it("replaces the token in place and audits it", async () => {
    const { id } = await mkPm("p-token");
    const r = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/pm/connections/${N("p-token")}/token`, payload: { token: "new-pm-token" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("new-pm-token");
    const [p] = await db.select().from(pmConnections).where(eq(pmConnections.id, id));
    expect(decryptSecret(DATA_KEY, p!.tokenCiphertext)).toBe("new-pm-token");
    expect(await auditRows(id, "pm-connection-token-rotated")).toHaveLength(1);
  });

  it("a rotation keeps the previous secret for 24 hours, refuses a second rotation inside the window, and closes it on an immediate one", async () => {
    const { id, secret: first } = await mkPm("p-rot");
    expect((await hook("p-rot", first)).statusCode).toBe(202);

    const r1 = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/pm/connections/${N("p-rot")}/webhook-secret/rotate`, payload: {} });
    expect(r1.statusCode).toBe(200);
    const second = r1.json().webhookSecret as string;
    const until = new Date(r1.json().previousValidUntil as string).getTime();
    expect(until - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(until - Date.now()).toBeLessThan(24.1 * 3600_000);
    const [row] = await db.select().from(pmConnections).where(eq(pmConnections.id, id));
    expect(row!.webhookSecretHash).toBe(createHash("sha256").update(second).digest("hex"));

    // both secrets are accepted during the window; the list shows when the old one stops
    expect((await hook("p-rot", second)).statusCode).toBe(202);
    expect((await hook("p-rot", first)).statusCode).toBe(202);
    expect((await hook("p-rot", "rglwh_wrong")).statusCode).toBe(401);
    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/pm/connections" });
    const listed = (list.json().connections as Array<Record<string, unknown>>).find((c) => c.id === id);
    expect(listed!.previousSecretValidUntil).not.toBeNull();
    expect(JSON.stringify(list.json())).not.toContain(second);

    const again = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/pm/connections/${N("p-rot")}/webhook-secret/rotate`, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("rotation_in_progress");

    const now = await app.inject({ method: "POST", headers: adminAuth, url: `/v1/pm/connections/${N("p-rot")}/webhook-secret/rotate`, payload: { immediate: true } });
    expect(now.statusCode).toBe(200);
    expect(now.json().previousValidUntil).toBeNull();
    const third = now.json().webhookSecret as string;
    expect((await hook("p-rot", third)).statusCode).toBe(202);
    expect((await hook("p-rot", second)).statusCode).toBe(401);
    expect((await hook("p-rot", first)).statusCode).toBe(401);

    const rotations = await auditRows(id, "pm-webhook-secret-rotated");
    expect(rotations).toHaveLength(2);
    expect(JSON.stringify(rotations)).not.toMatch(new RegExp(`${second}|${third}`));
  });

  it("the previous secret stops working when the window closes (database clock)", async () => {
    const { id, secret: first } = await mkPm("p-expire");
    await app.inject({ method: "POST", headers: adminAuth, url: `/v1/pm/connections/${N("p-expire")}/webhook-secret/rotate`, payload: {} });
    expect((await hook("p-expire", first)).statusCode).toBe(202);
    await db.update(pmConnections).set({ previousWebhookSecretValidUntil: sql`now() - interval '1 second'` }).where(eq(pmConnections.id, id));
    expect((await hook("p-expire", first)).statusCode).toBe(401);
    // a closed window no longer blocks the next rotation
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `/v1/pm/connections/${N("p-expire")}/webhook-secret/rotate`, payload: {} })).statusCode).toBe(200);
  });

  it("a non-admin cannot edit, replace the token or rotate", async () => {
    await mkPm("p-member");
    expect((await app.inject({ method: "PATCH", headers: memberAuth, url: `/v1/pm/connections/${N("p-member")}`, payload: { project: "X" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", headers: memberAuth, url: `/v1/pm/connections/${N("p-member")}/token`, payload: { token: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", headers: memberAuth, url: `/v1/pm/connections/${N("p-member")}/webhook-secret/rotate`, payload: {} })).statusCode).toBe(403);
  });

  it("an unknown connection is a 404 on every route", async () => {
    const base = `/v1/pm/connections/${N("p-nope")}`;
    expect((await app.inject({ method: "PATCH", headers: adminAuth, url: base, payload: { project: "X" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `${base}/token`, payload: { token: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", headers: adminAuth, url: `${base}/webhook-secret/rotate`, payload: {} })).statusCode).toBe(404);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  connectorGrants,
  createDb,
  eq,
  mcpServers,
  ORG_SETTINGS_ID,
  orgSettings,
  roleAgentGrants,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  runMigrations,
  serverGrants,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { grantMintStepUp } from "./step-up.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";

/**
 * ADR-0250 (review S-04) — minting a grant widens default deny, so each of the eight grant-mint POSTs (person and
 * role grants of MCP tools, MCP servers' read tools, agents and connectors) is a `settings_relax` step-up bound to
 * `{op: "grant_mint", grant}`. For every route this file pins:
 *  - an ADMIN API KEY is refused (403 `step_up_required`, `credential: "api_key"`) and nothing is written: a leaked
 *    admin key can no longer widen anyone's access;
 *  - a signed-in admin with no grant is refused, and nothing is written;
 *  - a grant made for ANOTHER mint (another grantee) is refused and not spent;
 *  - a grant made for exactly this mint lets it through (201), and is spent.
 * DELETE stays without step-up (narrowing access needs none) and is not re-pinned here.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `gm-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKeyAuth: { authorization: string };
let granteeId: string;
let otherId: string;
let roleId: string;
let serverId: string;
let agentId: string;
let connectorId: string;
const restores: Array<() => Promise<void>> = [];

async function mkUser(label: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `gm-${label}-${RUN}@example.test`, displayName: label },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // the strict step-up posture, explicitly (another file may have relaxed it and not yet put it back)
  const [before] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db
    .update(orgSettings)
    .set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT });

  adminId = await mkUser("admin");
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "gm-admin" } });
  expect(key.statusCode, key.body).toBe(201);
  adminKeyAuth = { authorization: `Bearer ${key.json().token}` };
  granteeId = await mkUser("grantee");
  otherId = await mkUser("other");

  const role = await app.inject({ method: "POST", url: "/v1/roles", headers: AUTH, payload: { name: `gm-role-${RUN}` } });
  expect(role.statusCode, role.body).toBe(201);
  roleId = role.json().id;
  // the row directly: registration resolves the URL through the egress guard, which this file is not about
  const [server] = await db.insert(mcpServers).values({ name: `gm-server-${RUN}`, url: "https://gm-mcp.example.test/" }).returning();
  serverId = server!.id;
  const agent = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `gm-agent-${RUN}`, provider: "mock", tier: 1, model: "gm-model", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  agentId = agent.json().id;
  const connector = await app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: AUTH,
    payload: { name: `gm-conn-${RUN}`, kind: "data", providerKind: "mock" },
  });
  expect(connector.statusCode, connector.body).toBe(201);
  connectorId = connector.json().id;
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

interface MintCase {
  name: string;
  url: () => string;
  payload: (userId: string) => Record<string, unknown>;
  /** the facts the server binds the step-up to, for this grantee */
  facts: (userId: string) => Record<string, unknown>;
  /** how many rows the mint left for this grantee (person) or the role */
  rows: (userId: string) => Promise<number>;
}

const CASES: MintCase[] = [
  {
    name: "POST /v1/grants/tools",
    url: () => "/v1/grants/tools",
    payload: (userId) => ({ userId, serverId, toolName: "gm_tool" }),
    facts: (userId) => ({ kind: "tool", userId, serverId, toolName: "gm_tool" }),
    rows: async (userId) => (await db.select().from(toolGrants).where(eq(toolGrants.userId, userId))).length,
  },
  {
    name: "POST /v1/grants/servers",
    url: () => "/v1/grants/servers",
    payload: (userId) => ({ userId, serverId, readOnlyAll: true }),
    facts: (userId) => ({ kind: "server", userId, serverId, readOnlyAll: true }),
    rows: async (userId) => (await db.select().from(serverGrants).where(eq(serverGrants.userId, userId))).length,
  },
  {
    name: "POST /v1/grants/agents",
    url: () => "/v1/grants/agents",
    payload: (userId) => ({ userId, agentId }),
    facts: (userId) => ({ kind: "agent", userId, agentId, allowedModes: null }),
    rows: async (userId) => (await db.select().from(agentGrants).where(eq(agentGrants.userId, userId))).length,
  },
  {
    name: "POST /v1/grants/connectors",
    url: () => "/v1/grants/connectors",
    payload: (userId) => ({ userId, connectorId, mode: "read" }),
    facts: (userId) => ({ kind: "connector", userId, connectorId, mode: "read", allowedObjects: null }),
    rows: async (userId) => (await db.select().from(connectorGrants).where(eq(connectorGrants.userId, userId))).length,
  },
  {
    name: "POST /v1/roles/:roleId/grants/tools",
    url: () => `/v1/roles/${roleId}/grants/tools`,
    payload: () => ({ serverId, toolName: "gm_role_tool" }),
    facts: () => ({ kind: "role_tool", roleId, serverId, toolName: "gm_role_tool" }),
    rows: async () => (await db.select().from(roleToolGrants).where(eq(roleToolGrants.roleId, roleId))).length,
  },
  {
    name: "POST /v1/roles/:roleId/grants/servers",
    url: () => `/v1/roles/${roleId}/grants/servers`,
    payload: () => ({ serverId, readOnlyAll: true }),
    facts: () => ({ kind: "role_server", roleId, serverId, readOnlyAll: true }),
    rows: async () => (await db.select().from(roleServerGrants).where(eq(roleServerGrants.roleId, roleId))).length,
  },
  {
    name: "POST /v1/roles/:roleId/grants/agents",
    url: () => `/v1/roles/${roleId}/grants/agents`,
    payload: () => ({ agentId }),
    facts: () => ({ kind: "role_agent", roleId, agentId, allowedModes: null }),
    rows: async () => (await db.select().from(roleAgentGrants).where(eq(roleAgentGrants.roleId, roleId))).length,
  },
  {
    name: "POST /v1/roles/:roleId/grants/connectors",
    url: () => `/v1/roles/${roleId}/grants/connectors`,
    payload: () => ({ connectorId, mode: "read" }),
    facts: () => ({ kind: "role_connector", roleId, connectorId, mode: "read", allowedObjects: null }),
    rows: async () => (await db.select().from(roleConnectorGrants).where(eq(roleConnectorGrants.roleId, roleId))).length,
  },
];

describe("ADR-0250 (S-04): every grant mint is a step-up action", () => {
  it.each(CASES)("$name: refused for an admin API key and without a grant; allowed with exactly its grant", async (c) => {
    const before = await c.rows(granteeId);

    // a leaked admin API key can never step up, so it can no longer widen anyone's access
    const byKey = await app.inject({ method: "POST", url: c.url(), headers: adminKeyAuth, payload: c.payload(granteeId) });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", credential: "api_key", methods: [] });
    expect(await c.rows(granteeId)).toBe(before);

    // a signed-in admin with no grant is refused (this admin has no second factor, so: step_up_unavailable)
    const forOther = await grantStepUpForTest(db, adminId, grantMintStepUp(c.facts(otherId)));
    const bare = await app.inject({ method: "POST", url: c.url(), ...sessionRequest(forOther), payload: c.payload(granteeId) });
    expect([403, 422], bare.body).toContain(bare.statusCode);
    expect(bare.json().actionKind).toBe("settings_relax");
    expect(await c.rows(granteeId)).toBe(before);

    // a grant made for another mint (another grantee; for a role grant, another role's facts) is refused, not spent
    const otherFacts = c.url().startsWith("/v1/roles/") ? { ...c.facts(granteeId), roleId: otherId } : c.facts(otherId);
    const wrong = await grantStepUpForTest(db, adminId, grantMintStepUp(otherFacts));
    const refused = await app.inject({ method: "POST", url: c.url(), ...stepUpRequest(wrong), payload: c.payload(granteeId) });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect(await c.rows(granteeId)).toBe(before);

    // exactly this mint's grant lets it through, once
    const right = await grantStepUpForTest(db, adminId, grantMintStepUp(c.facts(granteeId)));
    const minted = await app.inject({ method: "POST", url: c.url(), ...stepUpRequest(right), payload: c.payload(granteeId) });
    expect(minted.statusCode, minted.body).toBe(201);
    expect(await grantSpent(db, right.grantId)).toBe(true);
    expect(await c.rows(granteeId)).toBe(before + 1);
  });
});

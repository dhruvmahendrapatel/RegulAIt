import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

// §5 role-bundled AGENT + CONNECTOR grants (ADR-0014), end-to-end through the
// gateway: a role that bundles an agent + a connector confers them to an
// assigned user with NO direct grant, and removing the assignment reverts to
// default-deny. Mirrors the role-assignment flow in mcp-proxy.test.ts.

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let roleId: string;
let agentId: string;
let connectorId: string;

async function authFor(uid: string): Promise<{ authorization: string }> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${uid}/keys`,
    payload: { name: "test-key" },
  });
  return { authorization: `Bearer ${res.json().token}` };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "role-grants-rita@example.com", displayName: "Role Rita" },
  });
  userId = user.json().id;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "rg-claude-haiku", provider: "anthropic", tier: 1, modes: ["plan", "execute"] },
  });
  agentId = agent.json().id;

  const connector = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/connectors",
    payload: { name: "rg-salesforce", kind: "crm" },
  });
  connectorId = connector.json().id;

  const role = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/roles",
    payload: { name: "rg-analyst", description: "bundles an agent + a connector" },
  });
  roleId = role.json().id;
});

afterAll(async () => {
  await app.close();
});

describe("role-bundled agent + connector grants (§5, ADR-0014)", () => {
  it("bundles an agent + a connector onto a role and confers them via assignment", async () => {
    // grant the agent and the connector TO THE ROLE (not the user)
    const agentGrant = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${roleId}/grants/agents`,
      payload: { agentId, allowedModes: ["plan"] },
    });
    expect(agentGrant.statusCode).toBe(201);

    const connGrant = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${roleId}/grants/connectors`,
      payload: { connectorId, mode: "read", allowedObjects: ["accounts"] },
    });
    expect(connGrant.statusCode).toBe(201);

    const userAuth = await authFor(userId);

    // BEFORE assignment: no direct grant, no role → default-deny on both
    const preAgent = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(preAgent.statusCode).toBe(403);
    expect(preAgent.json().decision.ruleId).toBe("default-deny");

    // assign the role
    const assign = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${userId}/roles`,
      payload: { roleId },
    });
    expect(assign.statusCode).toBe(201);

    // AFTER assignment: agent invoke allowed via the role grant, NO direct grant
    const postAgent = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(postAgent.statusCode).toBe(200);
    expect(postAgent.json().decision.effect).toBe("allow");
    expect(postAgent.json().decision.ruleChain.some(
      (t: { rule: string }) => t.rule === "role-agent-allow-list",
    )).toBe(true);

    // the role only granted plan mode → execute still denies
    const execAgent = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "execute" },
    });
    expect(execAgent.statusCode).toBe(403);

    // connector invoke allowed via the role grant on the allowed object
    const postConn = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/connectors/${connectorId}/invoke`,
      payload: { operation: "read", object: "accounts" },
    });
    expect(postConn.statusCode).toBe(200);
    expect(postConn.json().decision.effect).toBe("allow");

    // read-only role grant → write denies
    const writeConn = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/connectors/${connectorId}/invoke`,
      payload: { operation: "write", object: "accounts" },
    });
    expect(writeConn.statusCode).toBe(403);
  });

  it("GET /roles/:id/grants returns all four buckets with agents + connectors populated", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/roles/${roleId}/grants`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("tools");
    expect(body).toHaveProperty("servers");
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ agentId, agentName: "rg-claude-haiku" });
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0]).toMatchObject({ connectorId, connectorName: "rg-salesforce", mode: "read" });
  });

  it("a role-granted agent appears in GET /users/:id/agents tagged source 'role'", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${userId}/agents`,
    });
    expect(res.statusCode).toBe(200);
    const roleRow = res
      .json()
      .agents.find((a: { agentId: string; source: string }) => a.agentId === agentId);
    expect(roleRow).toBeTruthy();
    expect(roleRow.source).toBe("role");
    expect(roleRow.roles).toContain("rg-analyst");
  });

  it("a role-granted connector appears in GET /users/:id/connectors tagged source 'role'", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${userId}/connectors`,
    });
    expect(res.statusCode).toBe(200);
    const roleRow = res
      .json()
      .connectors.find((c: { connectorId: string; source: string }) => c.connectorId === connectorId);
    expect(roleRow).toBeTruthy();
    expect(roleRow.source).toBe("role");
  });

  it("removing the role assignment reverts both to default-deny", async () => {
    const remove = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/users/${userId}/roles/${roleId}`,
    });
    expect(remove.statusCode).toBe(200);

    const userAuth = await authFor(userId);
    const agentAfter = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(agentAfter.statusCode).toBe(403);
    expect(agentAfter.json().decision.ruleId).toBe("default-deny");

    const connAfter = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/connectors/${connectorId}/invoke`,
      payload: { operation: "read", object: "accounts" },
    });
    expect(connAfter.statusCode).toBe(403);
    expect(connAfter.json().decision.ruleId).toBe("default-deny");
  });
});

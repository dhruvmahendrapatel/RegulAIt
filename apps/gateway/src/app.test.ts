import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
let serverId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const userRes = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "alice@example.com", displayName: "Alice" },
  });
  expect(userRes.statusCode).toBe(201);
  userId = userRes.json().id;

  const serverRes = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "snowflake-mcp", url: "https://mcp.example.com" },
  });
  expect(serverRes.statusCode).toBe(201);
  serverId = serverRes.json().id;

  for (const tool of [
    { name: "query_database", kind: "read" },
    { name: "list_schemas", kind: "read" },
    { name: "drop_table", kind: "write" },
  ]) {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/servers/${serverId}/tools`,
      payload: tool,
    });
    expect(res.statusCode).toBe(201);
  }
});

afterAll(async () => {
  await app.close();
});

describe("gateway vertical slice", () => {
  it("denies by default and audits the denial", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/evaluate",
      payload: { userId, serverId, toolName: "query_database" },
    });
    expect(res.statusCode).toBe(200);
    const decision = res.json();
    expect(decision.effect).toBe("deny");
    expect(decision.ruleId).toBe("default-deny");

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${userId}` });
    const entries = audit.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].effect).toBe("deny");
    expect(entries[0].ruleChain.map((t: { rule: string }) => t.rule)).toContain("default-deny");
  });

  it("404s on a tool the server does not expose", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/evaluate",
      payload: { userId, serverId, toolName: "no_such_tool" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("shows no visible tools before any grant", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${userId}/servers/${serverId}/tools`,
    });
    expect(res.json().tools).toEqual([]);
  });

  it("allows an explicitly granted tool and audits the grant id", async () => {
    const grantRes = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId, serverId, toolName: "query_database" },
    });
    expect(grantRes.statusCode).toBe(201);
    const grantId = grantRes.json().id;

    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/evaluate",
      payload: { userId, serverId, toolName: "query_database" },
    });
    const decision = res.json();
    expect(decision.effect).toBe("allow");
    expect(decision.ruleId).toBe(grantId);
  });

  it("still denies write tools not on the allow-list", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/evaluate",
      payload: { userId, serverId, toolName: "drop_table" },
    });
    expect(res.json().effect).toBe("deny");
  });

  it("read-only-all server grant exposes read tools but never write tools", async () => {
    const grantRes = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/servers",
      payload: { userId, serverId, readOnlyAll: true },
    });
    expect(grantRes.statusCode).toBe(201);

    const visible = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${userId}/servers/${serverId}/tools`,
    });
    const names = visible.json().tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["list_schemas", "query_database"]);

    const write = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/evaluate",
      payload: { userId, serverId, toolName: "drop_table" },
    });
    expect(write.json().effect).toBe("deny");
  });

  it("rejects malformed requests with 400", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/evaluate",
      payload: { userId: "not-a-uuid", serverId, toolName: "query_database" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("audit log records every evaluation", async () => {
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${userId}` });
    const entries = audit.json().entries;
    // 4 requests reach the kernel; the 404 and 400 cases never do, so no audit rows for them
    expect(entries.length).toBe(4);
    for (const e of entries) {
      expect(e.ruleId).toBeTruthy();
      expect(e.reason).toBeTruthy();
      expect(Array.isArray(e.ruleChain)).toBe(true);
    }
  });
});

describe("authn", () => {
  it("rejects requests with no or invalid bearer token", async () => {
    const none = await app.inject({ method: "GET", url: "/v1/audit" });
    expect(none.statusCode).toBe(401);

    const bad = await app.inject({
      method: "GET",
      headers: { authorization: "Bearer rgl_not_a_real_token" },
      url: "/v1/audit",
    });
    expect(bad.statusCode).toBe(401);
  });

  it("non-admin keys cannot reach admin endpoints but can view their own tools", async () => {
    const user = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "member@example.com", displayName: "Member" },
    });
    const memberId = user.json().id;
    const key = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${memberId}/keys`,
      payload: { name: "member-key" },
    });
    const memberAuth = { authorization: `Bearer ${key.json().token}` };

    const denied = await app.inject({ method: "GET", headers: memberAuth, url: "/v1/audit" });
    expect(denied.statusCode).toBe(403);

    const own = await app.inject({
      method: "GET",
      headers: memberAuth,
      url: `/v1/users/${memberId}/servers/${serverId}/tools`,
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: "GET",
      headers: memberAuth,
      url: `/v1/users/${userId}/servers/${serverId}/tools`,
    });
    expect(other.statusCode).toBe(403);
  });

  it("admin-flagged users' keys reach admin endpoints; revoked keys stop working", async () => {
    const admin = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "root@example.com", displayName: "Root", isAdmin: true },
    });
    const adminId = admin.json().id;
    const key = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${adminId}/keys`,
      payload: { name: "root-key" },
    });
    const keyId = key.json().id;
    const adminAuth = { authorization: `Bearer ${key.json().token}` };

    const ok = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/audit" });
    expect(ok.statusCode).toBe(200);

    const revoke = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/keys/${keyId}/revoke`,
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/audit" });
    expect(afterRevoke.statusCode).toBe(401);
  });
});

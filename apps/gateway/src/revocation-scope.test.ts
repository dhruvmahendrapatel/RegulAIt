import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { evaluate, evaluateConnector } from "@regulait/policy-kernel";
import { buildApp } from "./app.js";

/**
 * O9 (ADR-0027, migration 0045) — partial revocations. scope 'full' (default
 * = every pre-O9 row = ADR-0019's total semantics) suppresses everything;
 * 'read_only' suppresses WRITE-classified tools/ops only — reads stay
 * allowed. A full revocation still beats everything; agent revocations stay
 * total (no op classification to scope by). Shares one DB (fileParallelism
 * off); prefix o9-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o9-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: "o9-uma@example.com", displayName: "o9-uma" } });
  userId = u.json().id;
  // ADR-0043: never-fetched registry fixture — a resolvable public hostname would
  // make CI depend on DNS and a .example one fails closed under the MCP egress
  // guard's write-time check, so it points at the loopback dead port (discard),
  // which the private-ranges-open default posture permits with zero ceremony.
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: "o9-server", url: "http://127.0.0.1:9" } });
  serverId = s.json().id;
  for (const tool of [{ name: "o9_read", kind: "read" }, { name: "o9_write", kind: "write" }]) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: tool });
  }
});

describe("kernel — MCP role-derived revocations with scope", () => {
  const base = (toolName: string, kind: "read" | "write", revScope?: "full" | "read_only") => ({
    userId: "u1",
    serverId: "s1",
    tool: { serverId: "s1", name: toolName, kind },
    toolGrants: [],
    serverGrants: [],
    roleToolGrants: [
      { id: "rg1", roleId: "r1", serverId: "s1", toolName: "o9_read" },
      { id: "rg2", roleId: "r1", serverId: "s1", toolName: "o9_write" },
    ],
    revocations: [
      { id: "rev1", userId: "u1", serverId: "s1", toolName: null, ...(revScope ? { scope: revScope } : {}) },
    ],
  });

  it("read_only scope: the write tool is revoked, the read tool stays allowed", () => {
    expect(evaluate(base("o9_write", "write", "read_only")).effect).toBe("deny");
    const read = evaluate(base("o9_read", "read", "read_only"));
    expect(read.effect).toBe("allow");
    expect(read.ruleId).toBe("rg1");
  });

  it("full scope (and absent scope — every pre-O9 row) stays total: both denied", () => {
    expect(evaluate(base("o9_read", "read", "full")).effect).toBe("deny");
    expect(evaluate(base("o9_write", "write", "full")).effect).toBe("deny");
    expect(evaluate(base("o9_read", "read")).effect).toBe("deny"); // absent = full
  });

  it("a full revocation beats a coexisting read_only one — reads stay denied", () => {
    const input = base("o9_read", "read", "read_only");
    input.revocations.push({ id: "rev2", userId: "u1", serverId: "s1", toolName: null, scope: "full" });
    const d = evaluate(input);
    expect(d.effect).toBe("deny");
  });
});

describe("kernel — connector revocations with scope", () => {
  const base = (operation: "read" | "write", scope?: "full" | "read_only") => ({
    userId: "u1",
    connectorId: "c1",
    operation,
    connectorGrants: [
      { id: "g1", userId: "u1", connectorId: "c1", mode: "readwrite" as const, allowedObjects: null },
    ],
    connectorRevocations: [
      { id: "rev1", userId: "u1", connectorId: "c1", ...(scope ? { scope } : {}) },
    ],
  });

  it("read_only scope: writes denied (reason names the scope), reads allowed", () => {
    const w = evaluateConnector(base("write", "read_only"));
    expect(w.effect).toBe("deny");
    expect(w.ruleId).toBe("connector-revoked");
    expect(w.reason).toContain("scoped read_only");
    expect(evaluateConnector(base("read", "read_only")).effect).toBe("allow");
  });

  it("full (and absent) stays total for both operations", () => {
    expect(evaluateConnector(base("read", "full")).effect).toBe("deny");
    expect(evaluateConnector(base("write")).effect).toBe("deny");
  });

  it("full beats read_only when both exist", () => {
    const input = base("read", "read_only");
    input.connectorRevocations.push({ id: "rev2", userId: "u1", connectorId: "c1", scope: "full" });
    expect(evaluateConnector(input).effect).toBe("deny");
  });
});

describe("endpoint + end-to-end through governed evaluation", () => {
  let revocationId: string;

  it("a revocation is created FULL; PATCH narrows it to read_only, audited; unknown id 404s", async () => {
    // role-derived entitlement for both tools
    const role = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "o9-role" } });
    const roleId = role.json().id;
    for (const toolName of ["o9_read", "o9_write"]) {
      const g = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/roles/${roleId}/grants/tools`,
        payload: { serverId, toolName },
      });
      expect(g.statusCode).toBe(201);
    }
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/roles`, payload: { roleId } });

    const created = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/revocations",
      payload: { userId, serverId },
    });
    expect(created.statusCode).toBe(201);
    revocationId = created.json().id;
    expect(created.json().scope).toBe("full"); // creation is always the ADR-0019 total

    const patched = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/revocations/mcp/${revocationId}/scope`,
      payload: { scope: "read_only" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().scope).toBe("read_only");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "revocation-scope-set"));
    expect(audit).toBeTruthy();
    expect(audit!.detail).toMatchObject({ revocationKind: "mcp", before: "full", after: "read_only" });

    const missing = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/revocations/connectors/${revocationId}/scope`,
      payload: { scope: "full" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("the governed /v1/evaluate honours the narrowed scope: write revoked, read allowed", async () => {
    const evalTool = (toolName: string) =>
      app.inject({ method: "POST", headers: AUTH, url: "/v1/evaluate", payload: { userId, serverId, toolName } });
    const write = await evalTool("o9_write");
    expect(write.json().effect).toBe("deny");
    const read = await evalTool("o9_read");
    expect(read.json().effect).toBe("allow");
    // restore full: the total semantics come back for reads too
    await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/revocations/mcp/${revocationId}/scope`,
      payload: { scope: "full" },
    });
    const readAgain = await evalTool("o9_read");
    expect(readAgain.json().effect).toBe("deny");
  });
});

/**
 * O9's LIST projections. A scope an operator cannot see is a scope they can
 * only edit blind: the SPA renders the current value in the row it is about to
 * narrow, so both revocation listings have to carry `scope`. `GET
 * /v1/revocations` selects the whole row and always did; the connector listing
 * is an explicit projection and did NOT, which made the connector half of the
 * O9 control unrenderable. Asserted here so the projection cannot silently
 * regress back to omitting it.
 */
describe("O9 — the revocation listings expose the scope the endpoint edits", () => {
  let connectorRevocationId: string;
  let connectorId: string;

  it("connector revocations list their scope, and a PATCH round-trips into the list", async () => {
    const connector = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/connectors",
      payload: { name: "o9-conn", kind: "data", providerKind: "mock" },
    });
    expect(connector.statusCode).toBe(201);
    connectorId = connector.json().id;

    const created = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${userId}/revocations/connectors`,
      payload: { connectorId, reason: "o9 projection check" },
    });
    expect(created.statusCode).toBe(201);
    connectorRevocationId = created.json().id;

    // creation is always the ADR-0019 total, and the LIST says so
    const before = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${userId}/revocations/connectors`,
    });
    expect(before.statusCode).toBe(200);
    const beforeRow = before.json().revocations.find((r: { id: string }) => r.id === connectorRevocationId);
    expect(beforeRow).toBeTruthy();
    expect(beforeRow.scope).toBe("full");

    const patched = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/revocations/connectors/${connectorRevocationId}/scope`,
      payload: { scope: "read_only" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().scope).toBe("read_only");

    const after = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${userId}/revocations/connectors`,
    });
    const afterRow = after.json().revocations.find((r: { id: string }) => r.id === connectorRevocationId);
    expect(afterRow.scope).toBe("read_only");
  });

  it("MCP revocations list their scope too", async () => {
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/revocations" });
    expect(list.statusCode).toBe(200);
    for (const r of list.json().revocations) expect(["full", "read_only"]).toContain(r.scope);
  });
});

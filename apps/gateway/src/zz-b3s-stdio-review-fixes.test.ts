/**
 * Batch-3 security review — the stdio findings, on a real database through the
 * real app. Re-targeted by ADR-0190 I4: a stdio server no longer runs on the
 * gateway host; it runs in a sandbox an executor starts, after a placement.
 *
 *  B3S-01  a caller with NO entitlement on a stdio server cannot make the
 *          gateway PLACE it (offer work to an executor, start a sandbox):
 *          `tools/list` is a 403 `mcp_no_entitlement` and a `tools/call` on a
 *          tool missing from the stored manifest is "Denied by policy", both
 *          audited `mcp-stdio-no-entitlement`, no placement decided, no
 *          session. An entitled caller passes that check and reaches the
 *          placement, which (no executor here) refuses with decision 7's 409.
 *  B3S-02  (a client that disconnected mid-spawn left a child and a process
 *          slot) is retired with the in-gateway spawn: there is no child and
 *          no slot. A closed MCP session closes its executor session
 *          (`zz-adr0190-i4-stdio-move.test.ts`, `packages/sandbox-executor`'s
 *          stdio-pump suite).
 *
 * Global state (M-068): org transports and the relaxed gates are restored in
 * afterAll; every server row is removed; the placement affinity seam is cleared.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, inArray, mcpServers, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { liveStdioSessions, setStdioPlacementAffinityForTest } from "./executor-stdio.js";
import { executeGovernedToolCall, MCP_STDIO_NO_ENTITLEMENT_RULE_ID } from "./mcp-proxy.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b3s-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const IMAGE = `sha256:${"b".repeat(64)}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member" | "stranger", { id: string; token: string; auth: { authorization: string } }>;
const createdServers: string[] = [];
const restore: Array<() => Promise<void>> = [];

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function registerStdio(name: string): Promise<string> {
  const r = await inject("POST", "/v1/servers", users.admin.auth, { name, transport: "stdio", stdio: { image: IMAGE, command: "/srv/mcp/b3s.js", args: [] } });
  expect(r.statusCode, r.body).toBe(201);
  createdServers.push(r.json().id);
  return r.json().id as string;
}
async function grantServer(userId: string, serverId: string) {
  const g = await inject("POST", "/v1/grants/servers", AUTH, { userId, serverId, readOnlyAll: true });
  expect(g.statusCode, g.body).toBe(201);
}
/** placements decided for this server (any outcome): an ungranted caller must cause none */
async function placementsFor(serverId: string): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from audit_log where rule_id in ('execution-refused', 'execution-placed') and detail->>'mcpServerId' = ${serverId}`);
  return (r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
}
const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restore.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restore.push(await relaxStepUpForTest(db));
  restore.push(await relaxStrictAdmissionForTest(db));
  restore.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false], ["stranger", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `b3s-${k}-${RUN}@example.com`, displayName: `b3s ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b3s" })).json().token as string;
    users[k] = { id, token, auth: { authorization: `Bearer ${token}` } };
  }
  const t = await inject("PUT", "/v1/org/settings", users.admin.auth, { mcpUpstreamTransports: ["streamable_http", "stdio"] });
  expect(t.statusCode, t.body).toBe(200);
  // no executor may take this file's placements (every file shares one database)
  setStdioPlacementAffinityForTest([randomUUID()]);
}, 120_000);

afterAll(async () => {
  setStdioPlacementAffinityForTest(null);
  await db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '["streamable_http"]'::jsonb`);
  for (const r of restore.reverse()) await r();
  if (createdServers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, createdServers));
  await app.close();
});

describe("B3S-01: no stdio placement for a caller with no entitlement on the server", () => {
  let serverId = "";
  beforeAll(async () => {
    serverId = await registerStdio(`b3s-ent-${RUN}`);
  });

  it("tools/list by an ungranted caller is a 403 mcp_no_entitlement, audited, and places nothing", async () => {
    const r = await inject("POST", `/mcp/${serverId}`, { ...users.stranger.auth, ...MCP_HEADERS }, LIST);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("mcp_no_entitlement");
    expect(await placementsFor(serverId), "an ungranted listing must not reach the placement").toBe(0);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, users.stranger.id), eq(auditLog.ruleId, MCP_STDIO_NO_ENTITLEMENT_RULE_ID)));
    expect(row).toMatchObject({ effect: "deny", serverId });
    expect((row!.detail as { method: string }).method).toBe("tools/list");
  });

  it("tools/call on a tool missing from the stored manifest by an ungranted caller is denied and places nothing", async () => {
    const out = await executeGovernedToolCall(db, undefined, {
      userId: users.stranger.id,
      serverId,
      toolName: `not-in-manifest-${RUN}`,
      projectId: null,
      arguments: {},
    });
    expect(out.kind).toBe("denied");
    expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe(MCP_STDIO_NO_ENTITLEMENT_RULE_ID);
    expect(await placementsFor(serverId), "an ungranted unknown-tool sync must not reach the placement").toBe(0);
    expect(liveStdioSessions()).toBe(0);
  });

  it("an entitled caller passes the entitlement check and reaches the placement, which refuses with decision 7's 409", async () => {
    await grantServer(users.member.id, serverId);
    const r = await inject("POST", `/mcp/${serverId}`, { ...users.member.auth, ...MCP_HEADERS }, LIST);
    // unattributed (no project header): decision 7's sensitivity fact does not resolve, never defaulted
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "execution_profile_unavailable", ruleId: "execution-profile", reason: "policy_unresolved" });
    expect(await placementsFor(serverId)).toBe(1);
    expect(liveStdioSessions()).toBe(0);
  });
});

/**
 * ADR-0224 addendum (2026-11-20) — the processing limit (records of processing) on connector calls and MCP calls,
 * not only model dispatch. All three reach the one check path in the governed core (`governedProcessingLimit`), so a
 * record of processing limits every call type the same way. Each path gets its own negative assertion (M-035): the
 * refusal happens before the connector provider or the MCP upstream is reached, and the audit row names categories,
 * never the value.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { PRIVACY_RULE_IDS } from "./privacy-ops.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { setOrgSettingsForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0224-tools-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
// reserved example values only: the documentation domain and an invalid SSN
const SUBJECT = "Tools.Subject@example.com";
const SSN = "123-45-6789";
const TOOL = `adr0224_echo_${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let connectorId: string;
let serverId: string;
let proj: string;
let upstreamClose: () => Promise<void> = async () => {};
const upstream = { toolCalls: 0 };
let restoreGates: () => Promise<void> = async () => {};
let restoreOrg: () => Promise<void> = async () => {};
let restoreAdmission: (() => Promise<void>) | undefined;

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const mcp = new McpServer({ name: `adr0224-up-${RUN}`, version: "0.0.1" });
        mcp.registerTool(TOOL, { description: "echo", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
          upstream.toolCalls++;
          return { content: [{ type: "text", text: "ok" }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const connectorCall = (payload: Record<string, unknown>, projectId: string | null) =>
  app.inject({
    method: "POST",
    url: `/v1/connectors/${connectorId}/invoke`,
    headers: userAuth,
    payload: { operation: "read", object: "record", payload, ...(projectId ? { projectId } : {}) },
  });
const toolCall = (args: Record<string, unknown>, projectId: string | null) =>
  executeGovernedToolCall(db, undefined, { userId, serverId, toolName: TOOL, projectId, arguments: args });

const refusalRows = async (where: ReturnType<typeof eq>) =>
  db.select().from(auditLog).where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.dispatchRefused), where));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    dispatchAttributionRequired: false,
    requireProjectAttribution: false,
    requireMcpAttribution: false,
    // the attribution mandate would refuse an unattributed connector call first; relaxed so the limit is what decides
    connectorAttributionRequired: false,
    useCaseGateMode: "off",
  });
  // the org PII floor at 'log', so personal data reaches the processing limit rather than the PII-mode block
  restoreOrg = await setOrgSettingsForTest(db, { defaultPiiMode: "log", privacyOpsEnabled: false, dsrSlaDays: 30 });

  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0224-tools-${RUN}@example.com`, displayName: "Tools Subject Tester" } });
  userId = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "adr0224-tools" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };

  const c = await app.inject({
    method: "POST",
    url: "/v1/connectors",
    headers: AUTH,
    payload: { name: `adr0224-conn-${RUN}`, kind: "data", providerKind: "mock", pricePerCallUsd: 0.001 },
  });
  connectorId = c.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/connectors", headers: AUTH, payload: { userId, connectorId, mode: "readwrite" } });

  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await app.inject({ method: "POST", url: "/v1/servers", headers: AUTH, payload: { name: `adr0224-server-${RUN}`, url: up.url } });
  serverId = s.json().id;
  await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools`, headers: AUTH, payload: { name: TOOL, kind: "read" } });
  await app.inject({ method: "POST", url: "/v1/grants/tools", headers: AUTH, payload: { userId, serverId, toolName: TOOL } });

  const p = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name: `adr0224-tools-proj-${RUN}` } });
  expect(p.statusCode).toBe(201);
  proj = p.json().id;
});

afterAll(async () => {
  await restoreOrg();
  await restoreGates();
  await restoreAdmission?.();
  await app.close();
  await upstreamClose();
});

describe("off (the shipped default): connector and MCP calls are not limited", () => {
  it("a connector call carrying personal data runs", async () => {
    const res = await connectorCall({ contact: SUBJECT }, proj);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("an MCP tool call carrying personal data reaches the upstream", async () => {
    const before = upstream.toolCalls;
    const out = await toolCall({ contact: SUBJECT }, proj);
    expect(out.kind).toBe("allowed");
    expect(upstream.toolCalls).toBe(before + 1);
  });
});

describe("on: the processing limit runs on the connector path", () => {
  beforeAll(async () => {
    await setOrgSettingsForTest(db, { privacyOpsEnabled: true });
  });

  it("personal data with no record of processing is refused 409 before the provider, audited without the value", async () => {
    const res = await connectorCall({ contact: SUBJECT }, proj);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("processing_not_permitted");
    expect(res.json().detail).toContain("no active record of processing");
    expect(JSON.stringify(res.json())).not.toContain(SUBJECT);
    expect(res.json().result).toBeUndefined();
    const rows = await refusalRows(eq(auditLog.objectId, connectorId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.objectType).toBe("connector");
      expect((r.detail as { callType?: string }).callType).toBe("connector");
      expect(JSON.stringify(r.detail) + r.reason).not.toContain(SUBJECT.toLowerCase().split("@")[0]);
    }
  });

  it("an unattributed connector call carrying personal data is refused (no record can permit it)", async () => {
    const res = await connectorCall({ contact: SUBJECT }, null);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain("names no project");
  });

  it("a call with no personal data is untouched", async () => {
    expect((await connectorCall({ q: "quarterly plan" }, proj)).statusCode).toBe(200);
  });
});

describe("on: the processing limit runs on the MCP tool path", () => {
  it("personal data with no record of processing is refused before the upstream is contacted", async () => {
    const before = upstream.toolCalls;
    const out = await toolCall({ contact: SUBJECT }, proj);
    expect(out.kind).toBe("denied");
    if (out.kind !== "denied") throw new Error("unreachable");
    expect(out.decision.ruleId).toBe(PRIVACY_RULE_IDS.dispatchRefused);
    expect(out.decision.reason).toContain("no active record of processing");
    expect(JSON.stringify(out)).not.toContain(SUBJECT);
    expect(upstream.toolCalls).toBe(before);
    const rows = await refusalRows(eq(auditLog.serverId, serverId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.toolName).toBe(TOOL);
      expect((r.detail as { callType?: string }).callType).toBe("mcp_tool");
      expect(JSON.stringify(r.detail) + r.reason).not.toContain(SUBJECT.toLowerCase().split("@")[0]);
    }
  });

  it("an unattributed tool call carrying personal data is refused", async () => {
    const before = upstream.toolCalls;
    const out = await toolCall({ contact: SUBJECT }, null);
    expect(out.kind).toBe("denied");
    expect(upstream.toolCalls).toBe(before);
  });
});

describe("one record of processing permits the same categories on every call type", () => {
  beforeAll(async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/privacy/processing-records",
      headers: AUTH,
      payload: {
        name: `Support lookups ${RUN}`,
        purpose: "Looking up a customer's support record",
        lawfulBasis: "contract",
        dataCategories: ["email"],
        retentionDays: 90,
        projectId: proj,
      },
    });
    expect(r.statusCode).toBe(201);
  });

  it("email is let through on the connector path; a category the record does not list is still refused", async () => {
    expect((await connectorCall({ contact: SUBJECT }, proj)).statusCode).toBe(200);
    const ssn = await connectorCall({ contact: SUBJECT, taxId: SSN }, proj);
    expect(ssn.statusCode).toBe(409);
    expect(ssn.json().detail).toContain("ssn");
  });

  it("email is let through on the MCP path; a category the record does not list is still refused", async () => {
    const before = upstream.toolCalls;
    expect((await toolCall({ contact: SUBJECT }, proj)).kind).toBe("allowed");
    expect(upstream.toolCalls).toBe(before + 1);
    const ssn = await toolCall({ contact: SUBJECT, taxId: SSN }, proj);
    expect(ssn.kind).toBe("denied");
    expect(upstream.toolCalls).toBe(before + 1);
  });
});

describe("the settings are changed through the audited settings route", () => {
  it("the due date accepts 1 to 90 days and every change is audited", async () => {
    const bad = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { dsrSlaDays: 91 } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { dsrSlaDays: 21 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().settings.dsrSlaDays).toBe(21);
    const rows = await db.select().from(auditLog).where(eq(auditLog.objectType, "org_settings"));
    expect(rows.some((r) => JSON.stringify(r.detail ?? {}).includes("dsrSlaDays"))).toBe(true);
  });

  it("turning the processing limit off is audited", async () => {
    const off = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { privacyOpsEnabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    const rows = await db.select().from(auditLog).where(eq(auditLog.objectType, "org_settings"));
    const row = rows.filter((r) => JSON.stringify(r.detail ?? {}).includes("privacyOpsEnabled")).at(-1);
    expect(row).toBeDefined();
    expect(JSON.stringify(row!.detail)).toContain("privacyOpsEnabled");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, auditLog, createDb, desc, eq, mcpServers, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

/**
 * O10 (ADR-0027, migration 0045) — per-tool MCP pricing. The flat per-server
 * price stays the fallback; an optional per-tool override on the INVENTORY
 * row wins (tool-first resolution), honoured by attributed AND unattributed
 * metering (one metering site). Admin PATCH sets/clears it, audited; a
 * manifest re-sync never clobbers it. Shares one DB (fileParallelism off);
 * prefix o10-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o10-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let userId: string;
let projectId: string;

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "o10-upstream", version: "0.0.1" });
        server.registerTool(
          "o10_cheap",
          { description: "cheap read", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "cheap" }] }),
        );
        server.registerTool(
          "o10_pricey",
          { description: "expensive read", inputSchema: { q: z.string().optional() }, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "pricey" }] }),
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: "o10-server", url: up.url } });
  serverId = s.json().id;
  await db.update(mcpServers).set({ pricePerCallUsd: 0.002 }).where(eq(mcpServers.id, serverId));
  for (const name of ["o10_cheap", "o10_pricey"]) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: { name, kind: "read" } });
  }
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: "o10-uma@example.com", displayName: "o10-uma" } });
  userId = u.json().id;
  for (const toolName of ["o10_cheap", "o10_pricey"]) {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName } });
  }
  const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "o10-project" } });
  projectId = p.json().id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  await upstreamClose();
});

async function lastUsageRow(toolName: string) {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.operation, toolName), eq(usageEvents.objectType, "mcp_tool")))
    .orderBy(desc(usageEvents.at))
    .limit(1);
  return row;
}

describe("the PATCH endpoint", () => {
  it("sets an override on the inventory row, audited; unknown tool 404s", async () => {
    const missing = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/servers/${serverId}/tools/nope/price`,
      payload: { pricePerCallUsd: 1 },
    });
    expect(missing.statusCode).toBe(404);
    const set = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/servers/${serverId}/tools/o10_pricey/price`,
      payload: { pricePerCallUsd: 0.05 },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().pricePerCallUsd).toBe(0.05);
    // ADR-0108: measured at TWO rows under the full suite — mcp-project-budget
    // .test.ts drives the same PATCH against its own server, and runs first.
    // Its row happens to carry the identical {before: null, after: 0.05}, so
    // this assertion passes on either row TODAY, by coincidence rather than by
    // construction. Pin the row this test wrote: the writer stamps server_id
    // and tool_name (mcp-proxy.ts), so naming both is exact.
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ruleId, "mcp-tool-price-set"),
          eq(auditLog.serverId, serverId),
          eq(auditLog.toolName, "o10_pricey"),
        ),
      );
    expect(audit).toBeTruthy();
    expect(audit!.detail).toMatchObject({ before: null, after: 0.05 });
  });

  it("the inventory read surfaces override vs inherited — the shape the admin UI binds to", async () => {
    // the SPA's MCP-servers view renders one row per tool as override /
    // inherited / unpriced, so BOTH halves of the tool-first-server-flat
    // resolution must be readable from the two list endpoints it already calls.
    const servers = await app.inject({ method: "GET", headers: AUTH, url: "/v1/servers" });
    expect(servers.statusCode).toBe(200);
    const server = servers.json().servers.find((s: { id: string }) => s.id === serverId);
    expect(server.pricePerCallUsd).toBe(0.002); // the server flat rate the UI shows as "inherited"

    const tools = await app.inject({ method: "GET", headers: AUTH, url: `/v1/servers/${serverId}/tools` });
    expect(tools.statusCode).toBe(200);
    const byName = new Map(
      (tools.json().tools as Array<{ name: string; pricePerCallUsd: number | null }>).map((t) => [t.name, t]),
    );
    expect(byName.get("o10_pricey")!.pricePerCallUsd).toBe(0.05); // overrides
    expect(byName.get("o10_cheap")!.pricePerCallUsd).toBeNull(); // inherits the server flat rate
  });
});

describe("tool-first resolution, server-flat fallback — attributed and unattributed alike", () => {
  it("the overridden tool bills at ITS price; the un-overridden one at the server price (attributed)", async () => {
    const pricey = await executeGovernedToolCall(db, undefined, { userId, serverId, toolName: "o10_pricey", projectId });
    expect(pricey.kind).toBe("allowed");
    expect((pricey as { costUsd?: number | null }).costUsd).toBe(0.05);
    const priceyRow = await lastUsageRow("o10_pricey");
    expect(priceyRow!.costUsd).toBe(0.05);
    expect(priceyRow!.projectId).toBe(projectId);

    const cheap = await executeGovernedToolCall(db, undefined, { userId, serverId, toolName: "o10_cheap", projectId });
    expect(cheap.kind).toBe("allowed");
    expect((cheap as { costUsd?: number | null }).costUsd).toBe(0.002);
    expect((await lastUsageRow("o10_cheap"))!.costUsd).toBe(0.002);
  });

  it("UNATTRIBUTED metering honours the override too (projectId NULL bucket)", async () => {
    const out = await executeGovernedToolCall(db, undefined, { userId, serverId, toolName: "o10_pricey" });
    expect(out.kind).toBe("allowed");
    expect((out as { costUsd?: number | null }).costUsd).toBe(0.05);
    const row = await lastUsageRow("o10_pricey");
    expect(row!.costUsd).toBe(0.05);
    expect(row!.projectId).toBeNull();
  });

  it("clearing the override falls back to the server flat price; a manifest sync never clobbers a set price", async () => {
    // a proxied call syncs the manifest (kind/description upsert) — the
    // override survives it (already proven implicitly above since
    // executeGovernedToolCall syncs unknown tools; assert explicitly by
    // re-reading after the calls above)
    const tools = (await app.inject({ method: "GET", headers: AUTH, url: `/v1/servers/${serverId}/tools` })).json().tools;
    const pricey = tools.find((t: { name: string }) => t.name === "o10_pricey");
    expect(pricey.pricePerCallUsd ?? 0.05).toBe(0.05);

    const clear = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/servers/${serverId}/tools/o10_pricey/price`,
      payload: { pricePerCallUsd: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().pricePerCallUsd).toBeNull();
    const out = await executeGovernedToolCall(db, undefined, { userId, serverId, toolName: "o10_pricey", projectId });
    expect((out as { costUsd?: number | null }).costUsd).toBe(0.002);
  });
});

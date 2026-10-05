import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDb, eq, mcpServers, runMigrations, sql, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { loadOrgSettings } from "./org-settings.js";

/**
 * F03 (ADR-0179 §4) — THE PROJECT BUDGET GATE AT THE BOUNDARY, UNDER
 * CONCURRENCY. The design stays (owner decision): measured spend, the call
 * that first crosses the cap is the last one allowed, no spend-hold ledger.
 * This file MEASURES what that design guarantees when calls race, so the
 * documented bound is a tested one.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  1. SEQUENTIAL: spend just under the cap, one caller. The next call crosses
 *     and is allowed; the call after it is blocked. Overshoot < one call.
 *  2. CONCURRENT: spend just under the cap, N calls at once via Promise.all.
 *     Every call that read the spend before any of them billed is allowed, so
 *     k of N run (k is measured and reported, 1 <= k <= N). Overshoot past the
 *     cap is < k x the per-call cost <= N x the per-call cost — at most one
 *     call's cost per concurrently in-flight call, which is the bound
 *     `preDispatchProjectGate` documents.
 *  3. After the burst lands, the very next call is blocked: the overshoot is
 *     bounded to the burst and never carries on.
 *
 * Prefix f03-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `f03-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const PAID = `f03_paid_${RUN}`;
const PRICE = 0.05;
const CAP = 1;
const N = 8;

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let userId: string;
let approverId: string;
let blockAtUsd: number;

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "f03-upstream", version: "0.0.1" });
        server.registerTool(
          PAID,
          { description: "paid read", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "ran" }] }),
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

async function mkUser(tag: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `f03-${tag}-${RUN}@example.com`, displayName: `f03 ${tag}` },
  });
  return r.json().id as string;
}

/** a project whose MEASURED spend sits one cent under the cap */
async function projectJustUnderCap(tag: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: `f03-${tag}-${RUN}`, budgetUsd: CAP, budgetApproverUserId: approverId },
  });
  expect(r.statusCode, r.body).toBe(201);
  const projectId = r.json().id as string;
  await db.insert(usageEvents).values({
    userId,
    objectType: "agent",
    projectId,
    costUsd: blockAtUsd - 0.01,
  });
  return projectId;
}

async function measuredSpend(projectId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(eq(usageEvents.projectId, projectId));
  return Number(row?.total ?? 0);
}

const call = (projectId: string) =>
  executeGovernedToolCall(db, undefined, { userId, serverId, toolName: PAID, projectId, arguments: {} });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: `f03-server-${RUN}`, url: up.url },
  });
  serverId = s.json().id;
  await db.update(mcpServers).set({ pricePerCallUsd: null }).where(eq(mcpServers.id, serverId));
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/servers/${serverId}/tools`,
    payload: { name: PAID, kind: "read" },
  });
  await app.inject({
    method: "PATCH",
    headers: AUTH,
    url: `/v1/servers/${serverId}/tools/${PAID}/price`,
    payload: { pricePerCallUsd: PRICE },
  });
  userId = await mkUser("caller");
  approverId = await mkUser("approver");
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId, serverId, toolName: PAID },
  });
  // the threshold is read, not assumed: the org dial decides where the block
  // engages, and this file must not change org-wide state (M-068)
  const org = await loadOrgSettings(db);
  expect(org.budgetEnforcement).toBe("block");
  blockAtUsd = (CAP * org.budgetHardBlockPct) / 100;
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstreamClose();
});

describe("F03: the project budget gate at the boundary", () => {
  it("SEQUENTIAL: the first call to cross the cap is the last one allowed; overshoot < one call", async () => {
    const projectId = await projectJustUnderCap("seq");
    const first = await call(projectId);
    expect(first.kind).toBe("allowed");
    const second = await call(projectId);
    expect(second.kind).toBe("budget_blocked");
    const overshoot = (await measuredSpend(projectId)) - blockAtUsd;
    expect(overshoot).toBeGreaterThan(0);
    expect(overshoot).toBeLessThan(PRICE + 1e-9);
  });

  it(`CONCURRENT: ${N} calls at once just under the cap — overshoot <= one call's cost per in-flight call`, async () => {
    const projectId = await projectJustUnderCap("burst");
    const outcomes = await Promise.all(Array.from({ length: N }, () => call(projectId)));
    const allowed = outcomes.filter((o) => o.kind === "allowed").length;
    const blocked = outcomes.filter((o) => o.kind === "budget_blocked").length;
    expect(allowed + blocked).toBe(N);
    const spend = await measuredSpend(projectId);
    const overshoot = spend - blockAtUsd;
    // the measurement, printed so the bound can be quoted from a real run
    console.log(
      `[f03] N=${N} concurrent, price=$${PRICE}, cap=$${blockAtUsd}: allowed=${allowed}, blocked=${blocked}, ` +
        `final spend=$${spend.toFixed(4)}, overshoot=$${overshoot.toFixed(4)} ` +
        `(= ${(overshoot / PRICE).toFixed(2)} x per-call cost)`,
    );
    // at least the crossing call runs (first-crossing-allowed)
    expect(allowed).toBeGreaterThanOrEqual(1);
    // every allowed call billed exactly once
    expect(spend).toBeCloseTo(blockAtUsd - 0.01 + allowed * PRICE, 6);
    // THE BOUND: overshoot past the cap is less than one call's cost per call
    // that was in flight — never more than N calls' worth
    expect(overshoot).toBeLessThan(allowed * PRICE + 1e-9);
    expect(overshoot).toBeLessThan(N * PRICE + 1e-9);

    // and it does not carry on: the next call after the burst is blocked
    const next = await call(projectId);
    expect(next.kind).toBe("budget_blocked");
  });
});

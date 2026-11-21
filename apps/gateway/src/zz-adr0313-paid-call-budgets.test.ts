/**
 * ADR-0313 — paid-tool and agent-payment budgets: reserve at authorisation, settle with the usage row, release on
 * failure, default-deny without a budget, no overshoot under concurrency, over-budget into the approvals queue.
 *
 * A local MCP double (127.0.0.1) counts its tool invocations, so every refusal proves the upstream was never
 * contacted. Every assertion names this run's own rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  mcpServers,
  mcpTools,
  orchestrationRuns,
  paidCallHolds,
  paidCallPrices,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { PAID_CALL_CHARGE_META_KEY, PAID_HOLD_STATES, PAID_HOLD_TRANSITIONS, paidHoldStatesInto, settlementAmount, sweepExpiredPaidCallHolds } from "./paid-calls.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "adr0313-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Math.random().toString(36).slice(2, 8);

const FLAT = `p313_flat_${RUN}`; // settles at the quoted price
const METERED = `p313_metered_${RUN}`; // reports a charge below the hold
const GREEDY = `p313_greedy_${RUN}`; // reports a charge above the hold
const BROKEN = `p313_broken_${RUN}`; // fails upstream
const TOOLS = [FLAT, METERED, GREEDY, BROKEN];
const hits: Record<string, number> = Object.fromEntries(TOOLS.map((t) => [t, 0]));

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: http.Server;
let serverId: string;
let userId: string;
let approverId: string;
let adminKey: { authorization: string };
let receiver: http.Server;
let receiverHits = 0;
let allowHostId: string;
let connectorId: string;
let userAuth: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const toolId: Record<string, string> = {};

async function startUpstream(): Promise<string> {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "p313-upstream", version: "0.0.1" });
        for (const name of TOOLS) {
          server.registerTool(name, { description: name, inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
            hits[name]!++;
            if (name === BROKEN) throw new Error("upstream broke");
            const charge = name === METERED ? 0.03 : name === GREEDY ? 5 : undefined;
            return {
              content: [{ type: "text" as const, text: `${name} ran` }],
              ...(charge !== undefined ? { _meta: { [PAID_CALL_CHARGE_META_KEY]: { amountUsd: charge } } } : {}),
            };
          });
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(upstream.address() as { port: number }).port}/`;
}

async function mkUser(tag: string, isAdmin = false): Promise<{ id: string; auth: { authorization: string } }> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `p313-${tag}-${RUN}@example.com`, displayName: `p313 ${tag}`, isAdmin } });
  const id = r.json().id as string;
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${id}/keys`, payload: { name: "p313" } });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function mkProject(budgetUsd: number | null): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects",
    payload: { name: `p313-${randomUUID().slice(0, 8)}-${RUN}`, ...(budgetUsd !== null ? { budgetUsd, budgetApproverUserId: approverId } : {}) },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function price(subject: Record<string, string>, priceUsd: number, maxSettleUsd?: number) {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/paid-call-prices", payload: { ...subject, priceUsd, ...(maxSettleUsd ? { maxSettleUsd } : {}) } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().price.id as string;
}
const call = (toolName: string, projectId: string | null, extra: Record<string, unknown> = {}) =>
  executeGovernedToolCall(db, "b".repeat(64), { userId, serverId, toolName, projectId, ...extra });
const holdsFor = (projectId: string) => db.select().from(paidCallHolds).where(eq(paidCallHolds.projectId, projectId));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false, connectorAttributionRequired: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  const url = await startUpstream();
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `p313-server-${RUN}`, url } });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  await db.update(mcpServers).set({ pricePerCallUsd: null }).where(eq(mcpServers.id, serverId));
  const u = await mkUser("uma");
  userId = u.id;
  userAuth = u.auth;
  approverId = (await mkUser("approver")).id;
  adminKey = (await mkUser("admin", true)).auth;
  for (const name of TOOLS) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: { name, kind: "read" } });
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName: name } });
    const [row] = await db.select({ id: mcpTools.id }).from(mcpTools).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)));
    toolId[name] = row!.id;
  }
  await price({ mcpToolId: toolId[FLAT]! }, 0.25);
  await price({ mcpToolId: toolId[METERED]! }, 0.05, 0.1);
  await price({ mcpToolId: toolId[GREEDY]! }, 0.05, 0.1);
  await price({ mcpToolId: toolId[BROKEN]! }, 0.25);

  // a paid webhook connector on a loopback receiver
  receiver = http.createServer((req, res) => {
    receiverHits++;
    req.on("data", () => {});
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })));
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const allowed = await relaxStepUpAround(db, () => app.inject({
    method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts",
    payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: `p313-${RUN}` },
  }));
  expect([200, 201]).toContain(allowed.statusCode);
  allowHostId = allowed.json().id as string;
  const c = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/connectors",
    payload: { name: `p313-webhook-${RUN}`, kind: "notifications", providerKind: "webhook", baseUrl: `http://127.0.0.1:${(receiver.address() as { port: number }).port}/c`, pricePerCallUsd: 0.01 },
  });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/connectors", payload: { userId, connectorId, mode: "readwrite" } });
  await price({ connectorId }, 0.5);
});

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: allowHostId });
  try {
    for (const r of restores.reverse()) await r();
    upstream?.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    receiver?.closeAllConnections();
    await new Promise<void>((r) => receiver.close(() => r()));
    await app.close();
  } finally {
    loopback.assertRemoved();
  }
});

describe("ADR-0313 default-deny", () => {
  it("a paid call with no budget envelope is refused before the upstream is contacted", async () => {
    const before = hits[FLAT];
    const unbudgeted = await mkProject(null);
    for (const projectId of [null, unbudgeted]) {
      const out = await call(FLAT, projectId);
      expect(out).toMatchObject({ kind: "budget_blocked", status: 409, error: "paid_call_no_budget" });
    }
    expect(hits[FLAT]).toBe(before);
    const [denied] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "paid-call-no-budget"), eq(auditLog.userId, userId)));
    expect(denied?.effect).toBe("deny");
  });
});

describe("ADR-0313 reserve, settle, release", () => {
  it("settles at the quoted price with the usage row", async () => {
    const p = await mkProject(10);
    const out = await call(FLAT, p);
    expect(out).toMatchObject({ kind: "allowed", costUsd: 0.25 });
    const [h] = await holdsFor(p);
    expect(h).toMatchObject({ state: "settled", heldUsd: 0.25, settledUsd: 0.25, toolName: FLAT });
    const [u] = await db.select().from(usageEvents).where(eq(usageEvents.id, h!.usageEventId!));
    expect(u?.costUsd).toBe(0.25);
  });

  it("settles at the upstream-reported charge, never above the hold", async () => {
    const p = await mkProject(10);
    expect(await call(METERED, p)).toMatchObject({ kind: "allowed", costUsd: 0.03 });
    expect(await call(GREEDY, p)).toMatchObject({ kind: "allowed", costUsd: 0.1 });
    const rows = await holdsFor(p);
    expect(rows.map((r) => [r.toolName, r.heldUsd, r.settledUsd]).sort()).toEqual([[GREEDY, 0.1, 0.1], [METERED, 0.1, 0.03]].sort());
    const [capped] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "paid-call-charge-capped"), eq(auditLog.objectId, rows.find((r) => r.toolName === GREEDY)!.id)));
    expect(capped).toBeTruthy();
  });

  it("a tool that answers with an error and reports no charge settles at zero", async () => {
    const p = await mkProject(10);
    expect(await call(BROKEN, p)).toMatchObject({ kind: "allowed", costUsd: 0 });
    const [h] = await holdsFor(p);
    expect(h).toMatchObject({ state: "settled", heldUsd: 0.25, settledUsd: 0 });
  });

  it("a call that fails upstream releases its hold and bills nothing", async () => {
    const p = await mkProject(10);
    const dead = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `p313-dead-${RUN}`, url: "http://127.0.0.1:9/" } });
    expect(dead.statusCode, dead.body).toBe(201);
    const deadId = dead.json().id as string;
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${deadId}/tools`, payload: { name: FLAT, kind: "read" } });
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId: deadId, toolName: FLAT } });
    await price({ mcpServerId: deadId }, 0.25);
    await executeGovernedToolCall(db, "b".repeat(64), { userId, serverId: deadId, toolName: FLAT, projectId: p }).catch(() => undefined);
    const rows = await holdsFor(p);
    for (const h of rows) expect(h).toMatchObject({ state: "released", settledUsd: null });
    const billed = await db.select().from(usageEvents).where(and(eq(usageEvents.projectId, p), eq(usageEvents.objectType, "mcp_tool")));
    expect(billed).toEqual([]);
  });

  it("the sweeper releases a hold left open past its TTL", async () => {
    const p = await mkProject(10);
    const [h] = await db.insert(paidCallHolds).values({
      userId, projectId: p, subjectKind: "mcp_tool", mcpServerId: serverId, toolName: FLAT, heldUsd: 0.25, expiresAt: new Date(Date.now() - 1000),
    }).returning();
    expect(await sweepExpiredPaidCallHolds(db)).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(paidCallHolds).where(eq(paidCallHolds.id, h!.id));
    expect(after).toMatchObject({ state: "released", releaseReason: "expired" });
  });
});

describe("ADR-0313 the budget envelope", () => {
  it("concurrent paid calls never overshoot the project budget, and the overage is queued", async () => {
    const p = await mkProject(1); // room for exactly four $0.25 holds
    const before = hits[FLAT]!;
    const outs = await Promise.all(Array.from({ length: 10 }, () => call(FLAT, p)));
    const allowed = outs.filter((o) => o.kind === "allowed").length;
    expect(allowed).toBe(4);
    expect(outs.filter((o) => o.kind === "budget_blocked" && (o as { error: string }).error === "paid_call_over_budget")).toHaveLength(6);
    expect(hits[FLAT]! - before).toBe(4);
    const [spent] = await db.select().from(usageEvents).where(and(eq(usageEvents.projectId, p), eq(usageEvents.objectType, "mcp_tool")));
    expect(spent).toBeTruthy();
    const queued = await db.select().from(approvals).where(and(eq(approvals.projectId, p), eq(approvals.stageId, "__project_budget__"), eq(approvals.status, "pending")));
    expect(queued).toHaveLength(1);
  });

  it("a run's cap is an envelope too, and its overage goes to the run's escalation approver", async () => {
    const runId = randomUUID();
    await db.insert(orchestrationRuns).values({
      id: runId, name: `p313 ${RUN}`, initiatingUserId: userId,
      graph: { nodes: [], escalationApproverUserId: approverId }, state: { status: "running" }, status: "running",
      budget: { capUsd: 0.5, overageApproved: false },
    });
    const ctx = { contextId: `run:${runId}` };
    expect(await call(FLAT, null, ctx)).toMatchObject({ kind: "allowed" });
    expect(await call(FLAT, null, ctx)).toMatchObject({ kind: "allowed" });
    expect(await call(FLAT, null, ctx)).toMatchObject({ kind: "budget_blocked", error: "paid_call_over_run_budget" });
    const queued = await db.select().from(approvals).where(and(eq(approvals.runId, runId), eq(approvals.stageId, "__budget__:paid_call")));
    expect(queued).toHaveLength(1);
    // the approver sanctions the overage: the run's latch lifts the envelope
    await db.update(orchestrationRuns).set({ budget: { capUsd: 0.5, overageApproved: true } }).where(eq(orchestrationRuns.id, runId));
    expect(await call(FLAT, null, ctx)).toMatchObject({ kind: "allowed" });
  });

  it("a paid connector reserves, settles at its price, and is refused without a budget", async () => {
    const invoke = (projectId: string | null) => app.inject({
      method: "POST", headers: userAuth, url: `/v1/connectors/${connectorId}/invoke`,
      payload: { operation: "write", object: "x", payload: { n: RUN }, ...(projectId ? { projectId } : {}) },
    });
    const before = receiverHits;
    const refused = await invoke(null);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("paid_call_no_budget");
    expect(receiverHits).toBe(before);
    const p = await mkProject(10);
    const ok = await invoke(p);
    expect(ok.statusCode, ok.body).toBe(200);
    const [h] = await holdsFor(p);
    expect(h).toMatchObject({ state: "settled", subjectKind: "connector", heldUsd: 0.5, settledUsd: 0.5 });
  });
});

describe("ADR-0313 prices (admin)", () => {
  it("validates the subject and refuses a duplicate", async () => {
    const two = await app.inject({ method: "POST", headers: AUTH, url: "/v1/paid-call-prices", payload: { mcpServerId: serverId, connectorId, priceUsd: 1 } });
    expect(two.statusCode).toBe(400);
    const low = await app.inject({ method: "POST", headers: AUTH, url: "/v1/paid-call-prices", payload: { mcpServerId: serverId, priceUsd: 1, maxSettleUsd: 0.5 } });
    expect(low.statusCode).toBe(400);
    const dup = await app.inject({ method: "POST", headers: AUTH, url: "/v1/paid-call-prices", payload: { mcpToolId: toolId[FLAT], priceUsd: 1 } });
    expect(dup.statusCode).toBe(409);
    const nonAdmin = await app.inject({ method: "GET", headers: userAuth, url: "/v1/paid-call-prices" });
    expect(nonAdmin.statusCode).toBe(403);
  });

  it("deleting a price is a step-up", async () => {
    const id = await price({ mcpServerId: serverId }, 0.01);
    const noStepUp = await app.inject({ method: "DELETE", headers: adminKey, url: `/v1/paid-call-prices/${id}` });
    expect(noStepUp.statusCode).not.toBe(204);
    expect(await db.select().from(paidCallPrices).where(eq(paidCallPrices.id, id))).toHaveLength(1);
    const gone = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/paid-call-prices/${id}` });
    expect(gone.statusCode, gone.body).toBe(204);
  });

  it("pages holds under the list contract", async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/paid-call-holds?state=settled&limit=10" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
  });
});

describe("ADR-0313 settlement arithmetic", () => {
  it("never settles above the hold and ignores a malformed charge", () => {
    expect(settlementAmount({ priceUsd: 0.05 }, 0.1, 0.03)).toEqual({ amountUsd: 0.03, reported: true, capped: false });
    expect(settlementAmount({ priceUsd: 0.05 }, 0.1, 9)).toEqual({ amountUsd: 0.1, reported: true, capped: true });
    expect(settlementAmount({ priceUsd: 0.05 }, 0.1, -1)).toEqual({ amountUsd: 0.05, reported: false, capped: false });
    expect(settlementAmount({ priceUsd: 0.05 }, 0.1, "0.02")).toEqual({ amountUsd: 0.05, reported: false, capped: false });
    expect(settlementAmount({ priceUsd: 0.05 }, 0.1, undefined, { toolError: true })).toEqual({ amountUsd: 0, reported: false, capped: false });
  });
});

describe("ADR-0313 the hold lifecycle is one declared table (owner rule 12)", () => {
  it("held settles or releases, a released hold may still settle, and a settled hold is final", () => {
    expect([...PAID_HOLD_STATES]).toEqual(["held", "settled", "released"]);
    expect(PAID_HOLD_TRANSITIONS.settled).toEqual([]);
    expect(paidHoldStatesInto("settled")).toEqual(["held", "released"]);
    expect(paidHoldStatesInto("released")).toEqual(["held"]);
    expect(paidHoldStatesInto("held")).toEqual([]);
  });
});

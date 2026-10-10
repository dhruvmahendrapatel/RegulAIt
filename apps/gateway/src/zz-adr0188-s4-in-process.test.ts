/**
 * ADR-0188 slice S4 — IN-PROCESS WIRING, attacked through the real app.
 *
 * Every refusal below has a negative control (the same call, granted, goes through) and, where an
 * upstream exists, an upstream counter that must not move on a refusal:
 *  - an agent with no grants of its own is refused under the strict default (`own_grants`), with a
 *    clear rule id and an audit row, and nothing is dispatched; granting it through the admin API
 *    (`PUT /v1/workload-identities/:id/grants`) is what lets it act;
 *  - a lead→worker hand-off is a child grant: a worker over its lead's scope, cap or ceiling is refused,
 *    and a lead that does not itself hold what it delegates is refused;
 *  - the decision 23 `max_depth` is STORED (migration 0184): a child authorised `max_depth: 0` cannot
 *    have a child of its own, although the org limit would allow it — in code and at the database;
 *  - a call with no grant, or under a grant revoked a moment ago, is refused before the upstream;
 *  - stamping: usage, traces and audit name the acting agent; before the v2 boundary the audit facts
 *    ride in `detail.delegation`, from it in the columns; the cutover is idempotent, verifies, and the
 *    database refuses a v1 row past it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  agents,
  and,
  auditLog,
  createDb,
  delegationGrants,
  desc,
  eq,
  isNotNull,
  runAuditV2Cutover,
  runMigrations,
  runWithAuditActor,
  sql,
  traceSpans,
  usageEvents,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { verifyAuditChain } from "./audit-chain.js";
import { assertAuditChainWritable } from "./audit-v2-cutover.js";
import { admitChildGrant, createRootGrant, DelegationRefusedError } from "./delegation.js";
import { ensureIdentityFor, ensureInternalIdentities, inProcessEnvironment, startInProcessChain, agentScopeItem, toolScopeItems } from "./in-process-delegation.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { loadOrgSettings } from "./org-settings.js";
import { grantAgentOwnGrantsForTest, grantOwnGrantsForTest } from "./testing/agent-own-grants.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s4-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

// --- an upstream MCP double that COUNTS tools/call (a refusal must leave it at zero) ---
let upstreamCalls = 0;
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const parsed = body ? JSON.parse(body) : undefined;
        if (parsed && (Array.isArray(parsed) ? parsed : [parsed]).some((m: { method?: string }) => m.method === "tools/call")) upstreamCalls += 1;
        const server = new McpServer({ name: "s4-upstream", version: "0.0.1" });
        server.registerTool("get_time", { description: "fixed time", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "12:00" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const a = httpServer.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${a.port}/`,
    close: () => new Promise((r) => { httpServer.closeAllConnections(); httpServer.close(() => r()); }),
  };
}

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let serverId: string;
let approverId: string;
let restoreGates: () => Promise<void> = async () => {};
let restoreAdmission: (() => Promise<void>) | undefined;

const inject = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function mkUser(label: string): Promise<{ id: string; auth: { authorization: string } }> {
  const u = await inject("POST", "/v1/users", AUTH, { email: `s4-${label}-${RUN}@example.com`, displayName: `s4 ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const k = await inject("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" });
  return { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function mkAgent(label: string): Promise<string> {
  const r = await inject("POST", "/v1/agents", AUTH, {
    name: `s4-${label}-${RUN}`, provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 2, model: "mock-1",
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
}
const grantUserAgent = (userId: string, agentId: string) => inject("POST", "/v1/grants/agents", AUTH, { userId, agentId });
const grantUserTool = (userId: string, toolName: string) => inject("POST", "/v1/grants/tools", AUTH, { userId, serverId, toolName });
const node = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id, title: `task ${id}`, ownerAgentId: agentId, mode: "execute", estimate: { in: 1, out: 1 }, ...extra,
});
async function startedRun(auth: { authorization: string }, nodes: unknown[], start: string[]) {
  const c = await inject("POST", "/v1/runs", auth, { graph: { run: `s4-${RUN}-${randomUUID().slice(0, 6)}`, escalationApproverUserId: approverId, nodes } });
  expect(c.statusCode, c.body).toBe(201);
  const runId = c.json().id as string;
  expect((await inject("POST", `/v1/runs/${runId}/events`, auth, { kind: "start" })).statusCode).toBe(200);
  for (const n of start) expect((await inject("POST", `/v1/runs/${runId}/events`, auth, { kind: "node_started", nodeId: n })).statusCode).toBe(200);
  return runId;
}
const dispatch = (auth: { authorization: string }, runId: string, nodeId: string) => inject("POST", `/v1/runs/${runId}/nodes/${nodeId}/dispatch`, auth, {});
const usageFor = (agentId: string) => db.select().from(usageEvents).where(eq(usageEvents.agentId, agentId)).orderBy(desc(usageEvents.at));
const identityOf = async (agentId: string) => (await db.select().from(workloadIdentities).where(eq(workloadIdentities.agentId, agentId)))[0];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "s".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  upstream = await startUpstream();
  approverId = (await mkUser("approver")).id;
  const s = await inject("POST", "/v1/servers", AUTH, { name: `s4-upstream-${RUN}`, url: upstream.url });
  expect(s.statusCode, s.body).toBeLessThan(300);
  serverId = s.json().id;
}, 120_000);

afterAll(async () => {
  await restoreAdmission?.();
  await restoreGates();
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
});

describe("S4: an agent with no grants of its own is refused under the strict default", () => {
  it("refuses the worker with actor-allow-list, audited, nothing dispatched; the admin grant through the API lets it act", async () => {
    expect((await loadOrgSettings(db)).agentEntitlementMode).toBe("own_grants");
    const ivy = await mkUser("ivy");
    const worker = await mkAgent("ungranted");
    await grantUserAgent(ivy.id, worker); // the PERSON is entitled; the agent is not

    const runId = await startedRun(ivy.auth, [node("n1", worker)], ["n1"]);
    const refused = await dispatch(ivy.auth, runId, "n1");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().decision.ruleId).toBe("actor-allow-list");
    expect(refused.json().decision.reason).toMatch(/own grants do not cover agent/);
    expect(await usageFor(worker)).toHaveLength(0);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, runId), eq(auditLog.ruleId, "actor-allow-list")));
    expect(row).toMatchObject({ effect: "deny", userId: ivy.id });
    expect((row!.detail as { code?: string }).code).toBe("actor_not_entitled");

    // the admin grants the agent ITSELF, through the real API (identity_manage step-up; bootstrap passes it here)
    const ident = await identityOf(worker);
    expect(ident, "the identity exists from first use").toBeDefined();
    const list = await inject("GET", `/v1/workload-identities?kind=agent&limit=200`, AUTH);
    expect(list.statusCode, list.body).toBe(200);
    const read = await inject("GET", `/v1/workload-identities/${ident!.id}/grants`, AUTH);
    expect(read.json()).toMatchObject({ identityId: ident!.id, agents: [], tools: [], revision: 0 });
    const put = await inject("PUT", `/v1/workload-identities/${ident!.id}/grants`, AUTH, {
      revision: 0, tools: [], servers: [], connectors: [], roleIds: [], agents: [{ agentId: worker, allowedModes: ["execute"] }],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().revision).toBe(1);
    // a stale write is refused, not lost
    const stale = await inject("PUT", `/v1/workload-identities/${ident!.id}/grants`, AUTH, {
      revision: 0, tools: [], servers: [], connectors: [], roleIds: [], agents: [],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "grants_revision_conflict", currentRevision: 1 });
    // "every mode" is never implicit for an agent (decision 27): a missing list is a 400
    const implicit = await inject("PUT", `/v1/workload-identities/${ident!.id}/grants`, AUTH, {
      revision: 1, tools: [], servers: [], connectors: [], roleIds: [], agents: [{ agentId: worker }],
    });
    expect(implicit.statusCode).toBe(400);

    const ok = await dispatch(ivy.auth, runId, "n1");
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("stamps usage, traces and audit with the acting agent and ends the grant with the dispatch", async () => {
    const ivy = await mkUser("stamp");
    const worker = await mkAgent("stamp");
    await grantUserAgent(ivy.id, worker);
    const identityId = await grantAgentOwnGrantsForTest(db, worker);
    const runId = await startedRun(ivy.auth, [node("n1", worker)], ["n1"]);
    expect((await dispatch(ivy.auth, runId, "n1")).statusCode).toBe(200);

    const [u] = await usageFor(worker);
    expect(u).toMatchObject({ actorIdentityId: identityId });
    const grantId = u!.delegationGrantId!;
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grantId));
    expect(g).toMatchObject({ sponsorUserId: ivy.id, actorIdentityId: identityId, runId, bindingKind: "in_process", depth: 0, revokedReason: "run_ended" });
    // settled along the chain in the usage row's transaction (decision 22)
    expect(g!.settledMicros).toBe(Math.round((u!.costUsd ?? 0) * 1_000_000));
    const spans = await db.select().from(traceSpans).where(eq(traceSpans.delegationGrantId, grantId));
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.actorIdentityId === identityId)).toBe(true);
    // before the v2 boundary the actor facts ride in detail (the v1 hash covers them); the row says who
    const rows = await db.select().from(auditLog).where(sql`${auditLog.detail} -> 'delegation' ->> 'delegationGrantId' = ${grantId}`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.userId).toBe(ivy.id); // the sponsor stays the user
      expect((r.detail as { delegation: { actorChain: string[] } }).delegation.actorChain).toEqual([identityId]);
      expect(r.actorIdentityId).toBeNull(); // no unprotected columns before the cutover
    }
  });
});

describe("S4: lead → worker is a child grant; a worker never exceeds its lead", () => {
  it("a lead that does not itself hold the worker's agent refuses the hand-off; granted, the chain is lead then worker", async () => {
    const ivy = await mkUser("lead");
    const lead = await mkAgent("lead");
    const worker = await mkAgent("worker");
    await grantUserAgent(ivy.id, lead);
    await grantUserAgent(ivy.id, worker);
    const workerIdentity = await grantAgentOwnGrantsForTest(db, worker);
    const leadIdentity = await grantAgentOwnGrantsForTest(db, lead); // itself only, NOT the worker
    const nodes = [node("L", lead, { allowedAgentIds: [worker] }), node("W", worker, { leadNodeId: "L" })];
    const runId = await startedRun(ivy.auth, nodes, ["W"]);

    const refused = await dispatch(ivy.auth, runId, "W");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().decision.ruleId).toBe("actor-allow-list");
    expect(refused.json().decision.reason).toContain(leadIdentity);
    expect(await usageFor(worker)).toHaveLength(0);

    await grantAgentOwnGrantsForTest(db, lead, { agents: [{ agentId: worker, allowedModes: ["execute"] }] });
    const ok = await dispatch(ivy.auth, runId, "W");
    expect(ok.statusCode, ok.body).toBe(200);
    const [u] = await usageFor(worker);
    expect(u!.actorIdentityId).toBe(workerIdentity);
    const [leaf] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, u!.delegationGrantId!));
    expect(leaf).toMatchObject({ depth: 1, actorIdentityId: workerIdentity });
    const [root] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, leaf!.parentGrantId!));
    expect(root).toMatchObject({ depth: 0, actorIdentityId: leadIdentity, sponsorUserId: ivy.id, revokedReason: "run_ended" });
    expect(leaf!.revokedReason).toBe("cascade");
  });

  it("a worker over its lead's scope, cap or ceiling is refused at admission (service level)", async () => {
    const ivy = await mkUser("svc");
    const x = await mkAgent("svc-x");
    const y = await mkAgent("svc-y");
    await grantUserAgent(ivy.id, x);
    await grantUserAgent(ivy.id, y);
    const leadAgent = await mkAgent("svc-lead");
    const workerAgent = await mkAgent("svc-worker");
    const both = [{ agentId: x, allowedModes: ["execute"] }, { agentId: y, allowedModes: ["execute"] }];
    const leadId = await grantAgentOwnGrantsForTest(db, leadAgent, { agents: both });
    const workerId = await grantAgentOwnGrantsForTest(db, workerAgent, { agents: both });
    const sx = [agentScopeItem(x, "execute")];
    const sxy = [agentScopeItem(x, "execute"), agentScopeItem(y, "execute")];
    const base = { sponsorUserId: ivy.id, projectId: null, context: { runId: randomUUID() } };
    const refusal = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(DelegationRefusedError);
      return e as DelegationRefusedError;
    };
    // scope: the worker asks for y, the lead holds only x
    expect((await refusal(startInProcessChain(db, { ...base, hops: [{ identityId: leadId, scope: sx, capMicros: null }, { identityId: workerId, scope: sxy, capMicros: null }] }))).ruleId).toBe("delegation-scope");
    // cap: the worker asks for more than the lead has
    expect((await refusal(startInProcessChain(db, { ...base, hops: [{ identityId: leadId, scope: sx, capMicros: 10 }, { identityId: workerId, scope: sx, capMicros: 11 }] }))).ruleId).toBe("delegation-budget");
    // ceiling: the lead's §5.1 ceiling excludes what the worker asks for
    expect((await refusal(startInProcessChain(db, { ...base, hops: [{ identityId: leadId, scope: sxy, capMicros: null }, { identityId: workerId, scope: sxy, capMicros: null, ceiling: sx }] }))).ruleId).toBe("lead-ceiling");
    // control: inside scope, cap and ceiling it is admitted
    const ok = await startInProcessChain(db, { ...base, hops: [{ identityId: leadId, scope: sxy, capMicros: 10 }, { identityId: workerId, scope: sx, capMicros: 10, ceiling: sx }] });
    expect(ok.grantIds).toHaveLength(2);
    // a refused chain leaves nothing live behind
    const live = await db.select().from(delegationGrants).where(and(eq(delegationGrants.sponsorUserId, ivy.id), sql`${delegationGrants.revokedAt} IS NULL`));
    expect(live.map((g) => g.id).sort()).toEqual([...ok.grantIds].sort());
  });
});

describe("S4 / migration 0184: the decision 23 max_depth is stored and binds every descendant", () => {
  it("a child authorised max_depth 0 cannot delegate, though the org limit would allow it — in code and at the database", async () => {
    const org = await loadOrgSettings(db);
    expect(org.delegationMaxDepth).toBeGreaterThanOrEqual(2); // the org limit alone would admit a grandchild
    const ivy = await mkUser("depth");
    const target = await mkAgent("depth-target");
    await grantUserAgent(ivy.id, target);
    const ids: string[] = [];
    for (const l of ["a", "b", "c"]) ids.push(await grantAgentOwnGrantsForTest(db, await mkAgent(`depth-${l}`), { agents: [{ agentId: target, allowedModes: ["execute"] }] }));
    const scope = [agentScopeItem(target, "execute")];
    const env = inProcessEnvironment();
    const expiresAt = new Date(Date.now() + 600_000);
    const binding = { kind: "in_process" as const };
    const root = await createRootGrant(db, { sponsorUserId: ivy.id, environment: env, projectId: null, actorIdentityId: ids[0]!, scope, capMicros: null, expiresAt, binding });
    expect(root.depthLimit).toBe(org.delegationMaxDepth);
    const { grant: child } = await admitChildGrant(db, {
      parentGrantId: root.id, environment: env, projectId: null, actorIdentityId: ids[1]!, scope, capMicros: null, expiresAt, binding, idempotencyKey: `d-${RUN}`, maxFurtherDepth: 0,
    });
    expect(child).toMatchObject({ depth: 1, depthLimit: 1 });
    const e = await admitChildGrant(db, {
      parentGrantId: child.id, environment: env, projectId: null, actorIdentityId: ids[2]!, scope, capMicros: null, expiresAt, binding, idempotencyKey: `g-${RUN}`,
    }).then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(DelegationRefusedError);
    expect((e as DelegationRefusedError).ruleId).toBe("delegation-depth");
    // the database holds it too: a grandchild written past the parent's stored limit is refused
    const raw = await db
      .execute(sql`insert into delegation_grants (root_grant_id, parent_grant_id, path, depth, sponsor_user_id, actor_identity_id, scope, environment, binding_kind, expires_at)
        values (${root.id}, ${child.id}, ${`{${root.id},${child.id}}`}::uuid[], 2, ${ivy.id}, ${ids[2]!}, '[]'::jsonb, ${env}, 'in_process', ${expiresAt.toISOString()})`)
      .then(() => null, (err: unknown) => err as Error);
    expect(String((raw as { cause?: Error })?.cause?.message ?? raw?.message)).toMatch(/depth limit/);
    // control: under a child that kept its depth, the same grandchild is admitted
    const { grant: open } = await admitChildGrant(db, {
      parentGrantId: root.id, environment: env, projectId: null, actorIdentityId: ids[1]!, scope, capMicros: null, expiresAt, binding, idempotencyKey: `o-${RUN}`,
    });
    const { grant: grand } = await admitChildGrant(db, {
      parentGrantId: open.id, environment: env, projectId: null, actorIdentityId: ids[2]!, scope, capMicros: null, expiresAt, binding, idempotencyKey: `og-${RUN}`,
    });
    expect(grand.depth).toBe(2);
  });
});

describe("S4: a call with no grant, or under a grant revoked a moment ago, never reaches the upstream", () => {
  it("refuses at the tool path, fresh at the point of use; the granted control goes through and is settled", async () => {
    const ivy = await mkUser("tool");
    await grantUserTool(ivy.id, "get_time");
    const agent = await mkAgent("tool-agent");
    const identityId = await grantAgentOwnGrantsForTest(db, agent, { tools: [{ serverId, toolName: "get_time" }] });
    const call = (grantId: string) =>
      executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {}, delegationGrantId: grantId });
    const before = upstreamCalls;

    const none = await call(randomUUID());
    expect(none.kind).toBe("denied");
    expect(none.kind === "denied" && none.decision.ruleId).toBe("actor-chain-invalid");
    expect(upstreamCalls).toBe(before);

    const scope = toolScopeItems([{ serverId, toolName: "get_time", kind: "read" }]);
    const chain = await startInProcessChain(db, { sponsorUserId: ivy.id, projectId: null, context: { runId: randomUUID() }, hops: [{ identityId, scope, capMicros: null }] });
    const ok = await call(chain.leafGrantId);
    expect(ok.kind).toBe("allowed");
    expect(upstreamCalls).toBe(before + 1);

    // revoked — no wait, no cache: the very next call is refused
    await db.update(delegationGrants).set({ revokedAt: new Date(), revokedReason: "admin" }).where(eq(delegationGrants.id, chain.rootGrantId));
    const revoked = await call(chain.leafGrantId);
    expect(revoked.kind === "denied" && revoked.decision.ruleId).toBe("actor-chain-invalid");
    expect(upstreamCalls).toBe(before + 1);

    // a tool outside the grant's scope is refused delegation-scope even when the person and the agent hold it
    await grantUserTool(ivy.id, "write_note");
    await grantOwnGrantsForTest(db, { kind: "agent", id: agent }, { tools: [{ serverId, toolName: "write_note" }] });
    const narrow = await startInProcessChain(db, { sponsorUserId: ivy.id, projectId: null, context: { runId: randomUUID() }, hops: [{ identityId, scope, capMicros: null }] });
    const outside = await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "write_note", arguments: {}, delegationGrantId: narrow.leafGrantId });
    expect(outside.kind === "denied" ? outside.decision.ruleId : outside.kind).toMatch(/delegation-scope|unknown_tool/);
    expect(upstreamCalls).toBe(before + 1);
  });

  it("an agent's own grant removed after the chain was made narrows the very next call (decision 17)", async () => {
    const ivy = await mkUser("narrow");
    await grantUserTool(ivy.id, "get_time");
    const agent = await mkAgent("narrow-agent");
    const identityId = await grantAgentOwnGrantsForTest(db, agent, { tools: [{ serverId, toolName: "get_time" }] });
    const scope = toolScopeItems([{ serverId, toolName: "get_time", kind: "read" }]);
    const chain = await startInProcessChain(db, { sponsorUserId: ivy.id, projectId: null, context: { runId: randomUUID() }, hops: [{ identityId, scope, capMicros: null }] });
    const before = upstreamCalls;
    // the admin replaces the set with nothing
    const cur = await inject("GET", `/v1/workload-identities/${identityId}/grants`, AUTH);
    const put = await inject("PUT", `/v1/workload-identities/${identityId}/grants`, AUTH, { revision: cur.json().revision, tools: [], servers: [], agents: [], connectors: [], roleIds: [] });
    expect(put.statusCode, put.body).toBe(200);
    const out = await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {}, delegationGrantId: chain.leafGrantId });
    expect(out.kind === "denied" && out.decision.ruleId).toBe("actor-allow-list");
    expect(upstreamCalls).toBe(before);
  });
});

describe("S4 / decision 19: the audit v2 cutover (on a scratch database)", () => {
  it("records the boundary once under the lock, stamps columns from it on, verifies, and the database refuses a v1 row past it", async () => {
    const admin = createDb(DATABASE_URL);
    const name = `s4_cutover_${process.pid}_${RUN}`;
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
    const u = new URL(DATABASE_URL);
    u.pathname = `/${name}`;
    const sdb = createDb(u.toString());
    try {
      await runMigrations(sdb, migrationsFolder);
      expect(await assertAuditChainWritable(sdb)).toBeNull();
      const first = await runAuditV2Cutover(sdb, { setBy: null });
      expect(first.created).toBe(true);
      const again = await runAuditV2Cutover(sdb, { setBy: null });
      expect(again).toEqual({ fromSeq: first.fromSeq, created: false });
      expect(await assertAuditChainWritable(sdb)).toBe(first.fromSeq);
      const [cut] = await sdb.select().from(auditLog).where(eq(auditLog.seq, first.fromSeq));
      expect(cut).toMatchObject({ ruleId: "audit-chain-v2-cutover", chainVersion: 2 });

      // from the boundary on, the actor context fills the COLUMNS (covered by the v2 hash)
      const stamp = { actorIdentityId: randomUUID(), delegationGrantId: randomUUID(), actorChain: [randomUUID()] };
      stamp.actorChain.push(stamp.actorIdentityId);
      await runWithAuditActor(stamp, async () => {
        await sdb.insert(auditLog).values({ userId: randomUUID(), objectType: "agent", effect: "allow", ruleId: "s4-probe", ruleChain: [], reason: "s4 stamped row" });
      });
      const [probe] = await sdb.select().from(auditLog).where(eq(auditLog.ruleId, "s4-probe"));
      expect(probe).toMatchObject({ chainVersion: 2, actorIdentityId: stamp.actorIdentityId, delegationGrantId: stamp.delegationGrantId, actorChain: stamp.actorChain });
      const report = await verifyAuditChain(sdb, null);
      expect(report.status, JSON.stringify(report.firstBreak)).toBe("ok");

      // THE FIRST-LOAD STEP (here, on a database of its own, so no other suite's agent gains an
      // undeletable identity): every internal subject gets exactly one identity, with no grants
      const [agentRow] = await sdb.insert(agents).values({ name: `s4-firstload-${RUN}`, provider: "mock", tier: 0, model: "mock-1" }).returning({ id: agents.id });
      const created = await ensureInternalIdentities(sdb);
      expect(created.created).toBeGreaterThanOrEqual(1);
      const [ident] = await sdb.select().from(workloadIdentities).where(eq(workloadIdentities.agentId, agentRow!.id));
      expect(ident).toMatchObject({ kind: "agent", status: "active", environments: [inProcessEnvironment()], grantsRevision: 0 });
      expect(ident!.identifier).toBe(`spiffe://regulait.internal/regulait/agent/${agentRow!.id}`);
      expect((await ensureInternalIdentities(sdb)).created).toBe(0);
      expect((await ensureIdentityFor(sdb, { kind: "agent", id: agentRow!.id })).id).toBe(ident!.id);
      // created after the boundary: its audit row is v2
      const [made] = await sdb.select().from(auditLog).where(and(eq(auditLog.ruleId, "workload-identity-created"), eq(auditLog.objectId, ident!.id)));
      expect(made!.chainVersion).toBe(2);
      expect((await verifyAuditChain(sdb, null)).status).toBe("ok");

      // a writer that does not read the boundary (an un-drained v1 binary, a raw client) is refused by the database
      const [tip] = await sdb.select({ seq: auditLog.seq, rowHash: auditLog.rowHash }).from(auditLog).where(isNotNull(auditLog.seq)).orderBy(desc(auditLog.seq)).limit(1);
      const v1 = await sdb
        .execute(sql`insert into audit_log (user_id, object_type, effect, rule_id, rule_chain, reason, seq, prev_hash, content_hash, row_hash)
          values (${randomUUID()}, 'agent', 'allow', 's4-v1', '[]'::jsonb, 'v1 writer', ${tip!.seq! + 1}, ${tip!.rowHash}, ${"0".repeat(64)}, ${"0".repeat(64)})`)
        .then(() => null, (err: unknown) => err as Error);
      expect(String((v1 as { cause?: Error })?.cause?.message ?? v1?.message)).toMatch(/v2 boundary/);
    } finally {
      await closeAll([async () => sdb.$client.end(), async () => dropScratchDatabase(admin, name), async () => admin.$client.end()]);
    }
  });
});

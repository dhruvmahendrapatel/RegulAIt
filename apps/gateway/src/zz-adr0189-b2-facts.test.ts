/**
 * ADR-0189 slice B2 — DECISION FACT CAPTURE, attacked through the real governed paths.
 *
 * On a scratch database of its own (it runs the audit v2 cutover and records a receipt v2 boundary, both
 * one-way), this file proves:
 *  - every governed path's receipt-eligible decision rows (MCP tool call allowed, refused and paused for
 *    approval, the approval decision itself, the approved call that spends it, MCP protocol, agent dispatch,
 *    connector invoke) carry their capture-status marker and their `regulait.decision-facts.v1` row, written
 *    by the ONE shared audit writer, and no other row has a marker (round-10 entry condition 4237346656);
 *  - the facts are built only from the stored row and what existed in the decision's transaction: the
 *    argument digest the path recorded, the target, the project's compliance tags, the bound approval and
 *    its decisions by projection and digest (R5, R18), and, after the audit v2 cutover, the actor chain from
 *    ADR-0188's columns as workload identity URIs with the grant and identities bound (R18);
 *  - a rollback of the decision leaves no marker and no facts, and no facts row is ever orphaned;
 *  - `decision_facts_capture = off` writes a `capture_off` marker and no facts (4237322635);
 *  - a writer that goes around the shared writer is refused at commit (migration 0189), and an actor chain
 *    that cannot be resolved fails the decision rather than dropping its facts (fail closed);
 *  - from the receipt v2 boundary on, the receipt is v2 and commits to exactly those facts (R34, R42);
 *  - the eligibility predicate of the writer, the receipt sweep and the database guard agree;
 *  - the cost of capture, measured (Consequences: "B2 measures the cost").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  agents,
  auditLog,
  createDb,
  decisionReceipts,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runAuditV2Cutover,
  runMigrations,
  runWithAuditActor,
  sql,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import {
  bomDigestOf,
  bomRowDigest,
  decisionFactsSchema,
  isReceiptEligibleAuditRow,
  RECEIPT_OBJECT_TYPES,
  RECEIPT_PAYLOAD_VERSION,
  RECEIPT_PAYLOAD_VERSION_V2,
  type DecisionFacts,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { runDecisionReceiptSignSweep } from "./decision-receipts.js";
import { startInProcessChain, toolScopeItems } from "./in-process-delegation.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { executeGovernedProtocolCall } from "./mcp-protocol.js";
import { grantAgentOwnGrantsForTest } from "./testing/agent-own-grants.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `a189_b2_${process.pid}_${RUN}`;
const BOOT = `b2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

type AuditRow = typeof auditLog.$inferSelect;
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
const errText = (e: unknown) => `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;

// --- an upstream MCP double ---
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b2-upstream", version: "0.0.1" });
        server.registerTool("get_time", { description: "fixed time", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "12:00" }],
        }));
        server.registerTool("write_note", { description: "writes a note", inputSchema: { text: z.string() } }, async ({ text }) => ({
          content: [{ type: "text", text: `wrote: ${text}` }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const a = httpServer.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return { url: `http://127.0.0.1:${a.port}/`, close: () => new Promise((r) => { httpServer.closeAllConnections(); httpServer.close(() => r()); }) };
}

// --- a connector upstream that answers every call ---
async function startConnectorUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return { url: `http://127.0.0.1:${a.port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let connectorUpstream: Awaited<ReturnType<typeof startConnectorUpstream>>;
let serverId: string;
const keyDir = mkdtempSync(path.join(tmpdir(), "a189-b2-"));
const savedKey = { file: process.env.REGULAIT_RECEIPT_SIGNING_KEY, id: process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID };
const restores: Array<() => Promise<void>> = [];

const inject = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
async function mkUser(label: string, isAdmin = false): Promise<{ id: string; auth: { authorization: string } }> {
  const u = await inject("POST", "/v1/users", AUTH, { email: `b2-${label}-${RUN}@example.com`, displayName: `b2 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const k = await inject("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" });
  return { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function mkAgent(label: string): Promise<string> {
  const r = await inject("POST", "/v1/agents", AUTH, {
    name: `b2-${label}-${RUN}`, provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 2, model: "mock-1",
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
}
const grantUserTool = (userId: string, toolName: string) => inject("POST", "/v1/grants/tools", AUTH, { userId, serverId, toolName });

const tipSeq = async (): Promise<number> => Number(rows<{ s: string | null }>(await db.execute(sql`select coalesce(max(seq), 0)::bigint as s from audit_log`))[0]!.s);
const auditSince = async (seq: number): Promise<AuditRow[]> =>
  db.select().from(auditLog).where(sql`${auditLog.seq} > ${seq}`).orderBy(auditLog.seq);
async function markerOf(auditId: string) {
  return rows<{ audit_seq: string; audit_at: Date; status: string; facts_hash: string | null; expires_at: Date | null }>(
    await db.execute(sql`select audit_seq, audit_at, status, facts_hash, expires_at from decision_capture_status where audit_id = ${auditId}`),
  )[0];
}
async function factsOf(auditId: string) {
  return rows<{ facts: unknown; facts_hash: string; audit_seq: string; expires_at: Date | null }>(
    await db.execute(sql`select facts, facts_hash, audit_seq, expires_at from decision_facts where audit_id = ${auditId}`),
  )[0];
}

/**
 * THE INVARIANT, checked over every row appended since `seq`: a receipt-eligible row has its marker (same seq
 * and time) and its facts (captured, the hash its canonical bytes give, the row's own outcome and target); any
 * other row has neither. Returns the eligible rows with their facts.
 */
async function assertCaptured(seq: number): Promise<Array<{ row: AuditRow; facts: DecisionFacts }>> {
  const out: Array<{ row: AuditRow; facts: DecisionFacts }> = [];
  for (const row of await auditSince(seq)) {
    const marker = await markerOf(row.id);
    if (!isReceiptEligibleAuditRow(row)) {
      expect(marker, `${row.ruleId} (${row.objectType}) is not a decision and has no marker`).toBeUndefined();
      continue;
    }
    expect(marker, `${row.ruleId} (${row.objectType}) has its capture-status marker`).toBeDefined();
    expect(Number(marker!.audit_seq)).toBe(row.seq);
    expect(new Date(marker!.audit_at).toISOString()).toBe(row.at.toISOString());
    expect(marker!.status).toBe("captured");
    const stored = await factsOf(row.id);
    expect(stored, `${row.ruleId} has its facts`).toBeDefined();
    const facts = decisionFactsSchema.parse(stored!.facts);
    expect(stored!.facts_hash).toBe(bomDigestOf(facts));
    expect(marker!.facts_hash).toBe(stored!.facts_hash);
    expect(facts).toMatchObject({ auditId: row.id, auditSeq: row.seq, outcome: { effect: row.effect, refusalCode: null, upstreamStatusClass: null } });
    expect(facts.policy).toBeNull();
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    if (facts.action) {
      expect(facts.action.target.kind).toBe(row.objectType);
      const digest = typeof detail.argumentsDigest === "string" && /^[0-9a-f]{64}$/.test(detail.argumentsDigest) ? detail.argumentsDigest : null;
      expect(facts.action.argumentsDigest).toBe(digest);
      expect(facts.action.inputs).toEqual([]);
      expect(facts.action.dataSensitivity).toBeNull();
    }
    for (const bound of facts.rows) expect(bound.digest).toBe(bomRowDigest(bound.table, bound.projection));
    // a v1 row has no actor columns covered by its hash: actors are not recorded (pre_identity)
    if (row.chainVersion !== 2) expect(facts.actors).toBeNull();
    out.push({ row, facts });
  }
  return out;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(urlFor(SCRATCH));
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxApprovalSigningForTest(db));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false, keyCustodyEnforced: false }));
  restores.push(await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  upstream = await startUpstream();
  connectorUpstream = await startConnectorUpstream();
  const egress = await inject("POST", "/v1/egress-allow-hosts", AUTH, { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "b2 suite: local doubles" });
  expect(egress.statusCode, egress.body).toBe(201);
  const s = await inject("POST", "/v1/servers", AUTH, { name: `b2-upstream-${RUN}`, url: upstream.url });
  expect(s.statusCode, s.body).toBeLessThan(300);
  serverId = s.json().id;
  const file = path.join(keyDir, "receipt.pem");
  writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  process.env.REGULAIT_RECEIPT_SIGNING_KEY = file;
  process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `a189-b2-${RUN}`;
}, 180_000);

afterAll(async () => {
  if (savedKey.file === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY;
  else process.env.REGULAIT_RECEIPT_SIGNING_KEY = savedKey.file;
  if (savedKey.id === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID;
  else process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = savedKey.id;
  await closeAll([
    ...restores.reverse().map((r) => async () => r()),
    async () => { app?.server.closeAllConnections(); await app?.close(); },
    async () => upstream?.close(),
    async () => connectorUpstream?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH),
    async () => admin?.$client.end(),
    async () => rmSync(keyDir, { recursive: true, force: true }),
  ]);
});

// ---------------------------------------------------------------------------
describe("every governed path writes its facts through the one shared writer, in the decision's transaction", () => {
  it("MCP tool calls: allowed, refused, paused for approval, the approval decision and the approved call that binds it", async () => {
    const ivy = await mkUser("ivy");
    const carol = await mkUser("carol");
    await grantUserTool(ivy.id, "get_time");
    const from = await tipSeq();

    const allowed = await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {} });
    expect(allowed.kind).toBe("allowed");
    const refused = await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "write_note", arguments: { text: "x" } });
    expect(refused.kind).toBe("denied");

    // paused behind an approval rule, decided by the named approver, then spent by the identical call
    await grantUserTool(ivy.id, "write_note");
    const rule = await inject("POST", "/v1/rules/approvals", AUTH, { userId: ivy.id, serverId, writeOnly: true, approverUserId: carol.id });
    expect(rule.statusCode, rule.body).toBeLessThan(300);
    const paused = await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "write_note", arguments: { text: "hi" } });
    expect(paused.kind).toBe("approval_required");
    const approvalId = paused.kind === "approval_required" ? paused.approvalId : "";
    const decided = await inject("POST", `/v1/approvals/${approvalId}/decide`, carol.auth, { decision: "approved", reason: "fine" });
    expect(decided.statusCode, decided.body).toBe(200);
    const spent = await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "write_note", arguments: { text: "hi" } });
    expect(spent.kind).toBe("allowed");

    const captured = await assertCaptured(from);
    const mcp = captured.filter((c) => c.row.objectType === "mcp_tool");
    expect(mcp.map((c) => c.row.effect)).toEqual(expect.arrayContaining(["allow", "deny", "require_approval"]));
    for (const c of mcp) {
      // the ADR-0104 digest the path recorded on the row, and the target from its columns
      expect(c.facts.action?.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(c.facts.action?.target).toMatchObject({ kind: "mcp_tool", serverId, toolName: c.row.toolName, toolNameHash: null, connectorId: null, agentId: null });
      expect(c.facts.action?.complianceTags).toEqual([]); // unattributed: no project, no tags
      expect(c.facts.model).toBeNull();
    }
    // the approved call binds the approval it relied on and every decision on it, by projection and digest (R5, R18)
    const spentRow = mcp.find((c) => c.row.effect === "allow" && (c.row.detail as { approvedApprovalId?: string }).approvedApprovalId === approvalId);
    expect(spentRow, "the approved call names the approval it spends").toBeDefined();
    const tables = spentRow!.facts.rows.map((r) => `${r.table}:${r.id}`);
    expect(tables).toContain(`approvals:${approvalId}`);
    const approvalProjection = spentRow!.facts.rows.find((r) => r.table === "approvals")!.projection;
    expect(approvalProjection).toMatchObject({ id: approvalId, status: "approved", approverUserId: carol.id });
    expect(spentRow!.facts.rows.filter((r) => r.table === "approval_decisions").length).toBeGreaterThanOrEqual(1);
    // the refused call binds nothing
    expect(mcp.find((c) => c.row.effect === "deny")!.facts.rows).toEqual([]);
  });

  it("MCP protocol methods (mcp-protocol.ts)", async () => {
    const ivy = await mkUser("proto");
    await grantUserTool(ivy.id, "get_time");
    const from = await tipSeq();
    const [org] = await db.select({ m: orgSettings.mcpProtocolMethods }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await db.update(orgSettings).set({ mcpProtocolMethods: ["resources/list"] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      await executeGovernedProtocolCall(db, { userId: ivy.id, serverId, method: "resources/list", params: {} });
      await executeGovernedProtocolCall(db, { userId: ivy.id, serverId, method: "prompts/list", params: {} });
    } finally {
      await db.update(orgSettings).set({ mcpProtocolMethods: org!.m }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    const captured = await assertCaptured(from);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const c of captured) expect(c.facts.action?.target.serverId).toBe(serverId);
  });

  it("agent dispatch (agents-connectors.ts): an agent decision names its agent in action and model", async () => {
    const ivy = await mkUser("dispatch");
    const worker = await mkAgent("dispatch");
    expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: ivy.id, agentId: worker })).statusCode).toBeLessThan(300);
    await grantAgentOwnGrantsForTest(db, worker);
    const from = await tipSeq();
    const run = await inject("POST", "/v1/runs", ivy.auth, {
      graph: { run: `b2-${RUN}-${randomUUID().slice(0, 6)}`, escalationApproverUserId: ivy.id, nodes: [{ id: "n1", title: "task", ownerAgentId: worker, mode: "execute", estimate: { in: 1, out: 1 } }] },
    });
    expect(run.statusCode, run.body).toBe(201);
    const runId = run.json().id as string;
    expect((await inject("POST", `/v1/runs/${runId}/events`, ivy.auth, { kind: "start" })).statusCode).toBe(200);
    expect((await inject("POST", `/v1/runs/${runId}/events`, ivy.auth, { kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);
    const dispatched = await inject("POST", `/v1/runs/${runId}/nodes/n1/dispatch`, ivy.auth, {});
    expect(dispatched.statusCode, dispatched.body).toBe(200);
    // an allowed dispatch is recorded on the run; the dispatch DECISION rows (objectType agent) are the
    // refusals and warnings of agents-connectors.ts: a suspended agent refuses dispatch
    await db.update(agents).set({ lifecycleStatus: "suspended", lifecycleReason: "b2 probe" }).where(eq(agents.id, worker));
    const refusedDispatch = await inject("POST", `/v1/agents/${worker}/invoke`, ivy.auth, { mode: "execute", input: "hello", dispatch: true });
    expect(refusedDispatch.statusCode, refusedDispatch.body).toBeGreaterThanOrEqual(400);
    const captured = await assertCaptured(from);
    const agentRows = captured.filter((c) => c.row.objectType === "agent" && c.row.objectId === worker);
    expect(agentRows.length).toBeGreaterThanOrEqual(1);
    for (const c of agentRows) {
      expect(c.facts.action?.target).toMatchObject({ kind: "agent", agentId: worker, connectorId: null });
      // the agent is named; nothing else about the model is known when the decision is written, so nothing is claimed
      expect(c.facts.model).toEqual({ agentId: worker, provider: null, requestedModel: null, servedModel: null, pinnedModelVersion: null, modelCardId: null, modelCardApprovalId: null, aiBomSnapshotId: null });
    }
  });

  it("connector invoke (connector-call.ts): the attributed project's compliance tags, read in the decision's transaction", async () => {
    const owner = await mkUser("connector");
    const tag = `b2tag${RUN}`;
    const c = await inject("POST", "/v1/connectors", AUTH, { name: `b2_connector_${RUN}`, kind: "data", providerKind: "http", baseUrl: connectorUpstream.url, pricePerCallUsd: 0.01 });
    expect(c.statusCode, c.body).toBe(201);
    const connectorId = c.json().id as string;
    expect((await inject("POST", "/v1/grants/connectors", AUTH, { userId: owner.id, connectorId, mode: "readwrite", allowedObjects: ["records"] })).statusCode).toBe(201);
    expect((await inject("POST", "/v1/compliance/profiles", AUTH, { tag, piiMode: "warn" })).statusCode).toBe(201);
    const p = await inject("POST", "/v1/projects", AUTH, { name: `b2_project_${RUN}`, classifications: [tag] });
    expect(p.statusCode, p.body).toBe(201);
    const projectId = p.json().id as string;
    const from = await tipSeq();
    const invoked = await inject("POST", `/v1/connectors/${connectorId}/invoke`, owner.auth, { operation: "read", object: "records", payload: {}, projectId });
    expect(invoked.statusCode, invoked.body).toBeLessThan(500);
    const refused = await inject("POST", `/v1/connectors/${connectorId}/invoke`, owner.auth, { operation: "read", object: "not_granted", payload: {}, projectId });
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    const captured = (await assertCaptured(from)).filter((x) => x.row.objectType === "connector" && x.row.objectId === connectorId);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    for (const x of captured) {
      expect(x.facts.action?.target).toMatchObject({ kind: "connector", connectorId, agentId: null });
      if ((x.row.detail as { projectId?: string }).projectId === projectId) expect(x.facts.action?.complianceTags).toEqual([tag]);
    }
    expect(captured.some((x) => (x.row.detail as { projectId?: string }).projectId === projectId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("rollback, capture off, bypass, and the shared predicate", () => {
  const decisionValues = (userId: string, extra: Record<string, unknown> = {}) => ({
    userId, objectType: "mcp_tool" as const, serverId, toolName: "get_time", effect: "allow" as const, ruleId: "b2-probe", ruleChain: [], reason: "b2 probe",
    detail: { receiptClass: "decision", argumentsDigest: "a".repeat(64) }, ...extra,
  });

  it("a rolled-back decision leaves no marker and no facts; the marker and facts were there inside the transaction", async () => {
    const id = randomUUID();
    class RolledBack extends Error {}
    let seenInside = false;
    await db
      .transaction(async (tx) => {
        await tx.insert(auditLog).values(decisionValues(randomUUID(), { id }));
        const inside = rows<{ n: string }>(await tx.execute(sql`select count(*)::int as n from decision_facts f join decision_capture_status m using (audit_id) where audit_id = ${id}`));
        seenInside = Number(inside[0]!.n) === 1;
        throw new RolledBack();
      })
      .catch((e: unknown) => {
        if (!(e instanceof RolledBack)) throw e;
      });
    expect(seenInside, "written in the decision's own transaction").toBe(true);
    expect(await markerOf(id)).toBeUndefined();
    expect(await factsOf(id)).toBeUndefined();
    // and nowhere in this database is a facts row or marker without its audit row (nothing is pruned here)
    const orphans = rows<{ n: string }>(await db.execute(sql`select
      (select count(*) from decision_facts f where not exists (select 1 from audit_log a where a.id = f.audit_id)) +
      (select count(*) from decision_capture_status m where not exists (select 1 from audit_log a where a.id = m.audit_id)) as n`));
    expect(Number(orphans[0]!.n)).toBe(0);
  });

  it("a governed call that fails after its decision row rolls the facts back with it", async () => {
    const ivy = await mkUser("fail");
    await grantUserTool(ivy.id, "get_time");
    const from = await tipSeq();
    class Boom extends Error {}
    await db
      .transaction(async (tx) => {
        const out = await executeGovernedToolCall(tx as unknown as Db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {} });
        expect(out.kind).toBe("allowed");
        throw new Boom();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Boom)) throw e;
      });
    expect(await auditSince(from)).toEqual([]);
    expect(rows<{ n: string }>(await db.execute(sql`select count(*)::int as n from decision_capture_status where audit_seq > ${from}`))[0]!.n).toBe(0);
  });

  it("capture off (an audited relaxation): a capture_off marker and no facts; on again: captured", async () => {
    await db.update(orgSettings).set({ decisionFactsCapture: "off" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    let offId: string;
    try {
      const [row] = await db.insert(auditLog).values(decisionValues(randomUUID())).returning();
      offId = row!.id;
    } finally {
      await db.update(orgSettings).set({ decisionFactsCapture: "on" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    expect(await markerOf(offId)).toMatchObject({ status: "capture_off", facts_hash: null });
    expect(await factsOf(offId)).toBeUndefined();
    const [on] = await db.insert(auditLog).values(decisionValues(randomUUID())).returning();
    expect((await markerOf(on!.id))!.status).toBe("captured");
  });

  it("the common expires_at is the decision's time plus the composed audit retention (null when unbounded)", async () => {
    const [unbounded] = await db.insert(auditLog).values(decisionValues(randomUUID())).returning();
    expect((await markerOf(unbounded!.id))!.expires_at).toBeNull();
    await db.update(orgSettings).set({ defaultAuditRetentionDays: 30 }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const [bounded] = await db.insert(auditLog).values(decisionValues(randomUUID())).returning();
      const want = new Date(bounded!.at.getTime() + 30 * 86_400_000).toISOString();
      expect(new Date((await markerOf(bounded!.id))!.expires_at!).toISOString()).toBe(want);
      expect(new Date((await factsOf(bounded!.id))!.expires_at!).toISOString()).toBe(want);
    } finally {
      await db.update(orgSettings).set({ defaultAuditRetentionDays: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("a decision written around the shared writer is refused at commit (migration 0189); a non-decision row is not", async () => {
    const raw = (receiptClass: string) =>
      db.execute(sql`insert into audit_log (user_id, object_type, effect, rule_id, rule_chain, reason, detail)
        values (${randomUUID()}, 'mcp_tool', 'allow', 'b2-raw', '[]'::jsonb, 'raw writer', ${JSON.stringify({ receiptClass })}::jsonb)`);
    const refused = await raw("decision").then(() => null, (e: unknown) => e);
    expect(refused, "a raw decision row is refused").not.toBeNull();
    expect(errText(refused)).toMatch(/without its capture-status marker/);
    // NEGATIVE CONTROL: the same raw row classified as configuration is not a decision and commits
    await expect(raw("configuration")).resolves.toBeDefined();
    // a marker for another seq does not satisfy the guard
    const wrong = await db
      .transaction(async (tx) => {
        const [tip] = rows<{ s: string }>(await tx.execute(sql`select max(seq)::bigint + 1000 as s from audit_log`));
        const id = randomUUID();
        await tx.execute(sql`insert into audit_log (id, user_id, object_type, effect, rule_id, rule_chain, reason, detail)
          values (${id}, ${randomUUID()}, 'agent', 'deny', 'b2-raw', '[]'::jsonb, 'raw writer', '{"receiptClass":"decision"}'::jsonb)`);
        await tx.execute(sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status) values (${id}, ${tip!.s}, now(), 'capture_off')`);
      })
      .then(() => null, (e: unknown) => e);
    expect(errText(wrong)).toMatch(/without its capture-status marker/);
  });

  it("the writer, the receipt sweep and the database guard agree on which rows are decisions", async () => {
    const from = await tipSeq();
    const types = [...RECEIPT_OBJECT_TYPES, "audit_export", "workflow"];
    const classes = ["decision", "configuration", "excluded", undefined];
    for (const objectType of types) {
      for (const receiptClass of classes) {
        await db.insert(auditLog).values({
          userId: randomUUID(), objectType: objectType as "mcp_tool", effect: "deny", ruleId: "b2-predicate", ruleChain: [], reason: "predicate probe",
          detail: receiptClass === undefined ? {} : { receiptClass },
        });
      }
    }
    const probes = (await auditSince(from)).filter((r) => r.ruleId === "b2-predicate");
    expect(probes).toHaveLength(types.length * classes.length);
    await assertCaptured(from); // the writer: a marker exactly on eligible rows
    expect(probes.filter((r) => isReceiptEligibleAuditRow(r))).toHaveLength(RECEIPT_OBJECT_TYPES.length);
    // the receipt sweep signs exactly the rows the writer captured
    await runDecisionReceiptSignSweep(db);
    for (const r of probes) {
      const [receipt] = await db.select().from(decisionReceipts).where(eq(decisionReceipts.auditId, r.id));
      expect(!!receipt, `${r.objectType}/${(r.detail as { receiptClass?: string }).receiptClass}`).toBe(isReceiptEligibleAuditRow(r));
    }
  });
});

// ---------------------------------------------------------------------------
describe("after the audit v2 cutover: actors from ADR-0188's columns; receipts v2 bind the facts", () => {
  it("v1 decisions before the cutover record no actors; after it, a delegated call records the chain as workload identity URIs, with the grant and identities bound", async () => {
    const before = await db.insert(auditLog).values({
      userId: randomUUID(), objectType: "agent", effect: "allow", ruleId: "b2-v1", ruleChain: [], reason: "v1 decision", detail: { receiptClass: "decision" },
    }).returning();
    expect((await factsOf(before[0]!.id))!.facts).toMatchObject({ actors: null });

    const cut = await runAuditV2Cutover(db, { setBy: null });
    expect(cut.created).toBe(true);

    // a person acting directly, after the boundary: actors recorded, with no agent
    const ivy = await mkUser("actor");
    await grantUserTool(ivy.id, "get_time");
    const fromPerson = await tipSeq();
    expect((await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {} })).kind).toBe("allowed");
    const person = (await assertCaptured(fromPerson)).find((c) => c.row.objectType === "mcp_tool")!;
    expect(person.row.chainVersion).toBe(2);
    expect(person.facts.actors).toEqual({ sponsorUserId: ivy.id, actorIdentityId: null, delegationGrantId: null, actorChain: [] });

    // an agent acting under a grant: the chain from the columns, mapped to identity URIs; grant and identities bound
    const agent = await mkAgent("actor-agent");
    const identityId = await grantAgentOwnGrantsForTest(db, agent, { tools: [{ serverId, toolName: "get_time" }] });
    const chain = await startInProcessChain(db, {
      sponsorUserId: ivy.id, projectId: null, context: { runId: randomUUID() },
      hops: [{ identityId, scope: toolScopeItems([{ serverId, toolName: "get_time", kind: "read" }]), capMicros: null }],
    });
    const fromAgent = await tipSeq();
    // stamped exactly as an in-process worker is (`runAsActor(stampFor(actor))`, ADR-0188 S4)
    const stamp = { actorIdentityId: identityId, delegationGrantId: chain.leafGrantId, actorChain: [identityId] };
    const delegatedCall = await runWithAuditActor(stamp, () =>
      executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {}, delegationGrantId: chain.leafGrantId }),
    );
    expect(delegatedCall.kind).toBe("allowed");
    const delegated = (await assertCaptured(fromAgent)).find((c) => c.row.objectType === "mcp_tool" && c.row.delegationGrantId === chain.leafGrantId);
    expect(delegated, "the delegated decision row names its grant in the columns").toBeDefined();
    const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
    const uris = await Promise.all(
      delegated!.row.actorChain!.map(async (id) => (await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, id)))[0]!.identifier),
    );
    expect(uris).toContain(ident!.identifier);
    expect(delegated!.facts.actors).toEqual({ sponsorUserId: ivy.id, actorIdentityId: delegated!.row.actorIdentityId, delegationGrantId: chain.leafGrantId, actorChain: uris });
    const bound = delegated!.facts.rows.map((r) => `${r.table}:${r.id}`);
    expect(bound).toContain(`delegation_grants:${chain.leafGrantId}`);
    for (const id of new Set(delegated!.row.actorChain!)) expect(bound).toContain(`workload_identities:${id}`);
    expect(delegated!.facts.rows.find((r) => r.table === "delegation_grants")!.projection).toMatchObject({ id: chain.leafGrantId, sponsorUserId: ivy.id });
  });

  it("FAIL CLOSED: a decision whose actor chain names an identity that does not exist is refused, with nothing written", async () => {
    const from = await tipSeq();
    const stamp = { actorIdentityId: randomUUID(), delegationGrantId: randomUUID(), actorChain: [randomUUID()] };
    const out = await runWithAuditActor(stamp, async () =>
      db.insert(auditLog).values({ userId: randomUUID(), objectType: "agent", effect: "allow", ruleId: "b2-ghost", ruleChain: [], reason: "ghost actor", detail: { receiptClass: "decision" } }),
    ).then(() => null, (e: unknown) => e);
    expect(errText(out)).toMatch(/decision facts \(ADR-0189 B2\).*SPIFFE identifier/);
    expect(await auditSince(from)).toEqual([]);
    // NEGATIVE CONTROL: the same stamped row as a non-decision is written (capture is not involved)
    await runWithAuditActor(stamp, async () => {
      await db.insert(auditLog).values({ userId: randomUUID(), objectType: "agent", effect: "allow", ruleId: "b2-ghost", ruleChain: [], reason: "ghost actor", detail: { receiptClass: "configuration" } });
    });
    expect((await auditSince(from)).map((r) => r.ruleId)).toEqual(["b2-ghost"]);
  });

  it("from the receipt v2 boundary on, each receipt is v2 and commits to exactly the facts written with its decision", async () => {
    await runDecisionReceiptSignSweep(db); // drain everything below the boundary as v1
    const tip = await tipSeq();
    await db.execute(sql`insert into receipt_payload_versions (version, from_audit_seq) values (2, ${tip + 1})`);
    const ivy = await mkUser("receipt");
    await grantUserTool(ivy.id, "get_time");
    expect((await executeGovernedToolCall(db, undefined, { userId: ivy.id, serverId, toolName: "get_time", arguments: {} })).kind).toBe("allowed");
    await db.update(orgSettings).set({ decisionFactsCapture: "off" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      await db.insert(auditLog).values({ userId: ivy.id, objectType: "mcp_tool", serverId, toolName: "get_time", effect: "deny", ruleId: "b2-off", ruleChain: [], reason: "capture off", detail: { receiptClass: "decision" } });
    } finally {
      await db.update(orgSettings).set({ decisionFactsCapture: "on" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    const out = await runDecisionReceiptSignSweep(db);
    expect(out.state).toBe("signing");
    const eligible = (await auditSince(tip)).filter((r) => isReceiptEligibleAuditRow(r));
    expect(eligible.length).toBeGreaterThanOrEqual(2);
    for (const r of eligible) {
      const [receipt] = await db.select().from(decisionReceipts).where(eq(decisionReceipts.auditId, r.id));
      const marker = (await markerOf(r.id))!;
      expect(receipt!.payload).toMatchObject({
        v: RECEIPT_PAYLOAD_VERSION_V2,
        factsStatus: marker.status,
        factsHash: marker.facts_hash,
        actor: { identityId: r.actorIdentityId, delegationGrantId: r.delegationGrantId, chain: r.actorChain },
      });
      if (marker.status === "captured") expect((receipt!.payload as { factsHash: string }).factsHash).toBe((await factsOf(r.id))!.facts_hash);
    }
    expect(eligible.some((r) => r.ruleId === "b2-off")).toBe(true);
    const below = await db.select().from(decisionReceipts).where(sql`${decisionReceipts.auditSeq} <= ${tip}`);
    expect(below.every((r) => (r.payload as { v: string }).v === RECEIPT_PAYLOAD_VERSION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the cost of capture (Consequences: B2 measures it)", () => {
  it("measures one decision row written through the shared writer with capture on and off", async () => {
    const N = 40;
    const time = async (label: string) => {
      const t0 = performance.now();
      for (let i = 0; i < N; i += 1) await db.insert(auditLog).values({ userId: randomUUID(), objectType: "mcp_tool", serverId, toolName: "get_time", effect: "allow", ruleId: `b2-cost-${label}`, ruleChain: [], reason: "cost probe", detail: { receiptClass: "decision", argumentsDigest: "c".repeat(64) } });
      return (performance.now() - t0) / N;
    };
    const timeNonDecision = async () => {
      const t0 = performance.now();
      for (let i = 0; i < N; i += 1) await db.insert(auditLog).values({ userId: randomUUID(), objectType: "mcp_tool", effect: "allow", ruleId: "b2-cost-config", ruleChain: [], reason: "cost probe", detail: { receiptClass: "configuration" } });
      return (performance.now() - t0) / N;
    };
    await time("warm");
    const on = await time("on");
    await db.update(orgSettings).set({ decisionFactsCapture: "off" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    let off: number;
    try {
      off = await time("off");
    } finally {
      await db.update(orgSettings).set({ decisionFactsCapture: "on" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
    const none = await timeNonDecision();
    const line = `[ADR-0189 B2 cost] mean ms per audit row: decision+facts ${on.toFixed(2)}, decision capture_off ${off.toFixed(2)}, non-decision ${none.toFixed(2)} (N=${N})`;
    // the suite silences console output; a run that wants the figures names a file to append them to
    if (process.env.REGULAIT_B2_COST_OUT) appendFileSync(process.env.REGULAIT_B2_COST_OUT, `${line}\n`);
    expect(on).toBeGreaterThan(0);
  });
});

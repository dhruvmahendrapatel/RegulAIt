/**
 * ADR-0190 slice I4 — THE STDIO MOVE, on a real database through the real app, driven by the REAL executor
 * package with its FAKE backend (the CI runners have no gVisor; the runsc backend's own suite is skipped there
 * with its reason). What it pins:
 *
 *  - REGISTRATION: a stdio server is a closure image pinned by digest, an entry point inside it and an argv
 *    (400 `mcp_stdio_image_unpinned` for a tag, audited, nothing saved); the server view shows the image.
 *  - NO IN-GATEWAY SPAWN, NO FALLBACK (OWNER DECISION 2, ADR-0180): with no executor, a governed stdio call's
 *    DECISION is the refusal (rule id `execution-profile`, reason `no_executor`), with zero sandboxes and zero
 *    sessions; an executor below the required class is never used (no fallback to a lower class); the HTTP
 *    route's manifest connect answers 409 `execution_profile_unavailable`.
 *  - THE I8 CONTRACT: the governed decision's placement row is keyed to that decision's audit id and written in
 *    its transaction before its facts (`offered` with executor, attestation, image and runtime flags hash, or
 *    `refused`); the executor's later report is a LINKED `execution_placement_reports` row, never a second
 *    placement row; the decision's facts name the placement.
 *  - A PRE-I4 ROW (a host path whose file sha256 was pinned) is refused at connect `mcp_stdio_image_unpinned`.
 *  - MCP OVER THE EXECUTOR'S CHANNEL: an allowed call is placed (decision 7), the executor's sandbox is probed
 *    and its report accepted BEFORE any input, then the MCP bytes (initialize, tools/call) travel over the
 *    executor's stdio session to the sandbox's server, released with exactly the registered argv; the answer
 *    comes back through the same governed call; the placement row is `placed` at the class required.
 *  - MISMATCH: a sandbox whose report lies is refused before any input; the call fails with
 *    `execution_profile_mismatch`; the executor is quarantined.
 *
 * Global state (M-068): org transports and the relaxations are restored in afterAll; the placement affinity
 * test seam is cleared; this run's servers are deleted; executor and identity rows are scoped by this run's ids
 * (they cannot be deleted by design).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { aiUseCases, and, auditLog, createDb, decisionFacts, desc, eq, executionOffers, executionPlacementReports, executionPlacements, executors, inArray, mcpServers, runMigrations, sql, type Db } from "@regulait/db";
import { ExecutorClient, generateExecutorKey, ProofChannelCredential, runExecutorLoop, type ExecutorHttp, type ExecutorKey } from "@regulait/sandbox-executor";
import { FakeSandboxBackend } from "@regulait/sandbox-executor/testing";
import { buildApp } from "./app.js";
import { guardedMcpConnect, McpUpstreamRefusedError } from "./mcp-egress.js";
import { executeGovernedToolCall, syncUpstreamTools } from "./mcp-proxy.js";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import { liveStdioSessions, setStdioPlacementAffinityForTest } from "./executor-stdio.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `i4-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://127.0.0.1:4420";
process.env.REGULAIT_PUBLIC_URL = ISSUER;
const ENV = deploymentEnvironment();
const IMAGE = `sha256:${"4".repeat(64)}`;
const COMMAND = "/srv/mcp/i4-server.js";
const ARGS = ["--root", "/work", "--label", `i4-${RUN}`];

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId = "";
let adminAuth = { authorization: "" };
let memberId = "";
let projectId = "";
let serverId = "";
const createdServers: string[] = [];
const restores: Array<() => Promise<void>> = [];
const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** a minimal MCP server, as the sandbox's stdio: one JSON-RPC message per line in, the answers out */
function fakeMcpServer(line: string, workload: { command: string; args: string[] }): string[] {
  let msg: { id?: number; method?: string; params?: { protocolVersion?: string; name?: string } };
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  const reply = (result: unknown) => [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })];
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "i4-sandboxed", version: "0.0.1" } });
    case "tools/list":
      return reply({ tools: [{ name: "where_am_i", description: "report the workload", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] });
    case "tools/call":
      return reply({ content: [{ type: "text", text: JSON.stringify({ via: "sandbox", workload }) }] });
    default:
      return msg.id === undefined ? [] : [JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })];
  }
}

// --- executors over app.inject (as the I3 suite) -----------------------------------------------------------------

function injectHttp(): ExecutorHttp {
  return async (url, init) => {
    const u = new URL(url);
    const res = await app.inject({ method: init.method as Method, url: `${u.pathname}${u.search}`, headers: init.headers, ...(init.body !== undefined ? { payload: init.body } : {}) });
    return { status: res.statusCode, text: async () => res.body };
  };
}

async function newIdentity(name: string): Promise<{ id: string; identifier: string; key: ExecutorKey }> {
  const identifier = `spiffe://i4.example.org/regulait/worker_runtime/${name}-${RUN}`;
  const id = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, identifier, sponsor_user_ids, environments) values ('worker_runtime', ${identifier}, ARRAY[${adminId}]::uuid[], ARRAY[${ENV}]) returning id`),
  )[0]!.id;
  const key = await generateExecutorKey();
  await db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
    values (${id}, 'jwk', ${JSON.stringify(key.publicJwk)}::jsonb, ${key.thumbprint}, now() + interval '30 days')`);
  return { id, identifier, key };
}

async function rig(name: string, backend: FakeSandboxBackend) {
  const ident = await newIdentity(name);
  const d = backend.describe();
  const reg = await inject("POST", "/v1/executors", adminAuth, { workloadIdentityId: ident.id, name: `i4-${RUN}-${name}`, backend: d.backend, runtimeVersion: d.runtimeVersion, classesDeclared: [...d.classes] });
  expect(reg.statusCode, reg.body).toBe(201);
  const credential = new ProofChannelCredential({ identifier: ident.identifier, key: ident.key, issuer: ISSUER });
  const client = new ExecutorClient({ gatewayUrl: ISSUER, credential, http: injectHttp() });
  const logs: string[] = [];
  const run = (maxWindows: number) =>
    runExecutorLoop({ client, backend, credential, maxWindows, streamWindowSeconds: 1, stdioWindowSeconds: 1, backoffMs: 5, maxBackoffMs: 10, log: (m) => logs.push(m) });
  return { executorId: reg.json().executorId as string, backend, run, logs };
}

const placementSandboxes = (b: FakeSandboxBackend) => b.sandboxes.filter((s) => s.kind === "placement");
const callTool = (toolName = "where_am_i") => executeGovernedToolCall(db, undefined, { userId: memberId, serverId, toolName, projectId, arguments: {} });
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
/** the latest governed decision row for this file's server (the call's own audit row, not a placement row) */
async function lastDecision() {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.serverId, serverId), eq(auditLog.toolName, "where_am_i"), sql`${auditLog.detail}->>'receiptClass' = 'decision'`))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}
const placementOfDecision = async (auditId: string) => (await db.select().from(executionPlacements).where(eq(executionPlacements.auditId, auditId)))[0];
/**
 * The decision's facts were captured in its transaction and name its placement (ADR-0189 B2 capture, with the
 * ADR-0190 I8 `execution` section: this assertion needs I8, which merges before this slice, migration 0197 < 0198).
 */
async function expectFactsName(auditId: string, placementId: string, outcome: string) {
  const [f] = await db.select().from(decisionFacts).where(eq(decisionFacts.auditId, auditId));
  expect(f, "the decision's facts were captured").toBeDefined();
  expect((f!.facts as { execution?: { placementId?: string; placement?: string } }).execution).toMatchObject({ placementId, placement: outcome });
}

async function lastServerDeny(id: string) {
  const [row] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.effect, "deny"))).orderBy(desc(auditLog.seq)).limit(1);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxStepUpForTest(db));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "i4".padEnd(64, "k"), executorChannel: { streamPollMs: 25, keepaliveMs: 200 } });
  const adm = await inject("POST", "/v1/users", AUTH, { email: `i4-admin-${RUN}@example.com`, displayName: `i4 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  adminId = adm.json().id;
  adminAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, AUTH, { name: "i4" })).json().token}` };
  const mem = await inject("POST", "/v1/users", AUTH, { email: `i4-member-${RUN}@example.com`, displayName: `i4 member ${RUN}` });
  memberId = mem.json().id;
  // the project the calls are attributed to: decision 7 reads its sensitivity from its AI use cases (I2)
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`i4-p-${RUN}`}) returning id`))[0]!.id;
  await db.insert(aiUseCases).values({ name: `i4-uc-${RUN}`, description: "d", ownerUserId: adminId, businessContext: "b", dataSensitivity: "internal", projectId });
  const t = await inject("PUT", "/v1/org/settings", adminAuth, { mcpUpstreamTransports: ["streamable_http", "stdio"] });
  expect(t.statusCode, t.body).toBe(200);
}, 120_000);

afterAll(async () => {
  setStdioPlacementAffinityForTest(null);
  await db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '["streamable_http"]'::jsonb`);
  for (const r of restores.reverse()) await r();
  if (createdServers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, createdServers)).catch(() => undefined);
  await app.close();
});

// ---------------------------------------------------------------------------
describe("registration: a closure image pinned by digest, an entry point inside it, an argv", () => {
  it("refuses a tag (mcp_stdio_image_unpinned, audited, nothing saved) and a missing image; accepts a digest", async () => {
    const tag = await inject("POST", "/v1/servers", adminAuth, { name: `i4-tag-${RUN}`, transport: "stdio", stdio: { image: "regulait/mcp-fs:latest", command: COMMAND, args: [] } });
    expect(tag.statusCode, tag.body).toBe(400);
    expect(tag.json()).toMatchObject({ error: "mcp_stdio_image_unpinned", code: "image_unpinned" });
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "mcp-stdio-image-unpinned"), eq(auditLog.userId, adminId)));
    expect(audited, "the write-time refusal is audited").toBeDefined();
    expect((await db.select().from(mcpServers).where(eq(mcpServers.name, `i4-tag-${RUN}`))).length).toBe(0);
    const none = await inject("POST", "/v1/servers", adminAuth, { name: `i4-none-${RUN}`, transport: "stdio", stdio: { command: COMMAND, args: [] } });
    expect(none.statusCode).toBe(400);

    const ok = await inject("POST", "/v1/servers", adminAuth, { name: `i4-srv-${RUN}`, transport: "stdio", stdio: { image: IMAGE, command: COMMAND, args: ARGS } });
    expect(ok.statusCode, ok.body).toBe(201);
    serverId = ok.json().id;
    createdServers.push(serverId);
    expect(ok.json()).toMatchObject({ transport: "stdio", url: `stdio:i4-srv-${RUN}`, stdioCommandDigest: IMAGE, stdio: { image: IMAGE, command: COMMAND, args: ARGS } });
    // a read tool, granted to the member (a tool known to the server: no pre-decision manifest connect)
    const tool = await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name: "where_am_i", kind: "read", description: "where" });
    expect(tool.statusCode, tool.body).toBeLessThan(300);
    const grant = await inject("POST", "/v1/grants/tools", AUTH, { userId: memberId, serverId, toolName: "where_am_i", mode: "readwrite" });
    expect(grant.statusCode, grant.body).toBeLessThan(300);
  });
});

describe("no in-gateway spawn, no fallback: refused with decision 7's envelope (ADR-0180, OWNER DECISION 2)", () => {
  it("with no executor: the DECISION is the refusal (rule execution-profile, no_executor), its placement row keyed to it", async () => {
    setStdioPlacementAffinityForTest([randomUUID()]);
    const out = await callTool();
    expect(out).toMatchObject({ kind: "denied", decision: { effect: "deny", ruleId: "execution-profile" } });
    expect((out as { decision: { reason: string } }).decision.reason).toMatch(/no_executor.*No sandbox executor is available/);
    const decisionRow = await lastDecision();
    expect(decisionRow).toMatchObject({ ruleId: "execution-profile", effect: "deny", userId: memberId });
    expect(decisionRow!.detail).toMatchObject({ execution: { refusal: "execution_profile_unavailable", reason: "no_executor" }, receiptClass: "decision" });
    // I8 contract: the placement row is keyed to the governed decision's audit id, written in its transaction
    const p = await placementOfDecision(decisionRow!.id);
    expect(p).toMatchObject({ outcome: "refused", refusalCode: "no_executor", requiredClass: "microvm", executorId: null, imageDigest: IMAGE });
    expect((decisionRow!.detail as { execution: { placementId: string } }).execution.placementId).toBe(p!.id);
    await expectFactsName(decisionRow!.id, p!.id, "refused");
    expect(liveStdioSessions()).toBe(0);
  });

  it("the HTTP route answers 409 with the same envelope (a tools/list that needs the manifest)", async () => {
    setStdioPlacementAffinityForTest([randomUUID()]);
    const fresh = await inject("POST", "/v1/servers", adminAuth, { name: `i4-http-${RUN}`, transport: "stdio", stdio: { image: IMAGE, command: COMMAND, args: [] } });
    expect(fresh.statusCode, fresh.body).toBe(201);
    createdServers.push(fresh.json().id);
    await inject("POST", "/v1/grants/tools", AUTH, { userId: adminId, serverId: fresh.json().id, toolName: "where_am_i", mode: "readwrite" });
    const res = await app.inject({
      method: "POST",
      url: `/mcp/${fresh.json().id}`,
      headers: { ...adminAuth, "content-type": "application/json", accept: "application/json, text/event-stream", "x-regulait-project-id": projectId },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: "execution_profile_unavailable", ruleId: "execution-profile", reason: "no_executor" });
  });

  it("an L2 executor never takes an L3 call: refused (no executor attests the L3 profile), nothing started on it", async () => {
    // a call with no agent is decision 7's unknown agent: the most restrictive profile (restricted-microvm, L3).
    // A gVisor executor attests L2 only and never self-tests that profile, so it is not a candidate at all.
    const l2 = await rig("l2", new FakeSandboxBackend({ backend: "gvisor", classes: ["user_space_kernel"], stdioServer: fakeMcpServer }));
    await l2.run(1); // announce and self-test: fresh L2 attestations only
    setStdioPlacementAffinityForTest([l2.executorId]);
    const out = await callTool();
    expect(out).toMatchObject({ kind: "denied", decision: { ruleId: "execution-profile" } });
    expect(placementSandboxes(l2.backend), "no sandbox was ever started below the requirement").toHaveLength(0);
    const p = await placementOfDecision((await lastDecision())!.id);
    expect(p).toMatchObject({ outcome: "refused", refusalCode: "no_executor", requiredClass: "microvm", executorId: null });
  });

  it("a pre-I4 row (a host path, its file's sha256 pinned) is refused at connect: mcp_stdio_image_unpinned", async () => {
    const name = `i4-legacy-${RUN}`;
    const [legacy] = await db.insert(mcpServers).values({ name, url: `stdio:${name}`, transport: "stdio", stdioCommand: "/opt/mcp/bin/legacy", stdioArgs: [], stdioCommandDigest: "0".repeat(64) }).returning();
    createdServers.push(legacy!.id);
    const err = await errorOf(guardedMcpConnect(db, legacy!, { placement: { userId: adminId, projectId, agent: null } }));
    expect(err).toBeInstanceOf(McpUpstreamRefusedError);
    expect(err).toMatchObject({ error: "mcp_stdio_image_unpinned", refusalCode: "image_unpinned" });
    expect((await lastServerDeny(legacy!.id))?.ruleId).toBe("mcp-stdio-image-unpinned");
    expect(liveStdioSessions()).toBe(0);
  });
});

describe("MCP over the executor's channel: placed, proved, then the bytes", () => {
  it("an allowed call reaches the sandboxed server through the executor, released with the registered argv", async () => {
    const l3 = await rig("l3", new FakeSandboxBackend({ backend: "kata", classes: ["hardened_container", "microvm"], stdioServer: fakeMcpServer }));
    setStdioPlacementAffinityForTest([l3.executorId]);
    const loop = l3.run(12);
    // the executor attests before any offer can reach it
    for (let i = 0; i < 100 && !l3.logs.some((m) => m.includes("fresh attestation")); i++) await new Promise((r) => setTimeout(r, 50));
    const outcome = await callTool();
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: "allowed" });
    const text = JSON.parse((outcome as { content: { content: Array<{ text: string }> } }).content.content[0]!.text);
    expect(text).toEqual({ via: "sandbox", workload: { command: COMMAND, args: ARGS } });
    await loop;
    const [sb] = placementSandboxes(l3.backend);
    expect(sb, "exactly one sandbox, probed before release").toMatchObject({ probed: true, released: true, workload: { command: COMMAND, args: ARGS } });
    expect(sb!.stdin.map((l) => JSON.parse(l).method)).toEqual(expect.arrayContaining(["initialize", "tools/call"]));
    // I8 contract: the governed decision's own placement row, written in its transaction BEFORE its facts
    const decisionRow = await lastDecision();
    expect(decisionRow).toMatchObject({ effect: "allow", userId: memberId });
    const p = await placementOfDecision(decisionRow!.id);
    expect(p, "the placement row is keyed to the decision").toMatchObject({
      outcome: "offered",
      executorId: l3.executorId,
      appliedClass: "microvm",
      requiredClass: "microvm",
      imageDigest: IMAGE,
      offerId: sb!.offerId,
    });
    expect(p!.attestationId, "the broker's attestation reference").toMatch(/^[0-9a-f-]{36}$/);
    expect(p!.runtimeFlagsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p!.reportSha256, "the decision-time row is never rewritten by the report").toBeNull();
    const [o] = await db.select().from(executionOffers).where(eq(executionOffers.id, sb!.offerId!));
    expect(o).toMatchObject({ status: "ended", workloadKind: "mcp_stdio", imageDigest: IMAGE, requiredClass: "microvm", placementId: p!.id });
    // the executor's report is the LINKED row, never a second placement row with another audit id
    const reports = await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, p!.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: "placed", appliedClass: "microvm", offerId: o!.id });
    expect(reports[0]!.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.select().from(executionPlacements).where(eq(executionPlacements.offerId, o!.id))).length).toBe(1);
    await expectFactsName(decisionRow!.id, p!.id, "offered");
    expect(liveStdioSessions()).toBe(0);
  }, 60_000);

  it("admission still judges a sandboxed server's manifest: a tool named mcp:* holds it (ADR-0185 G4, moved here)", async () => {
    const reservedServer = (line: string, workload: { command: string; args: string[] }): string[] => {
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (m.method === "tools/list") return [JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "mcp:resources", description: "list", inputSchema: { type: "object" } }] } })];
      return fakeMcpServer(line, workload);
    };
    const ex = await rig("reserved", new FakeSandboxBackend({ backend: "kata", classes: ["hardened_container", "microvm"], stdioServer: reservedServer }));
    const reg = await inject("POST", "/v1/servers", adminAuth, { name: `i4-reserved-${RUN}`, transport: "stdio", stdio: { image: IMAGE, command: COMMAND, args: [] } });
    expect(reg.statusCode, reg.body).toBe(201);
    createdServers.push(reg.json().id);
    setStdioPlacementAffinityForTest([ex.executorId]);
    const loop = ex.run(8);
    for (let i = 0; i < 100 && !ex.logs.some((m) => m.includes("fresh attestation")); i++) await new Promise((r) => setTimeout(r, 50));
    const [{ mode: found } = { mode: "enforce" }] = rows<{ mode: string }>(await db.execute(sql`select mcp_admission_mode as mode from org_settings`));
    await db.execute(sql`update org_settings set mcp_admission_mode = 'enforce'`);
    try {
      const client = await guardedMcpConnect(db, reg.json(), { placement: { userId: adminId, projectId, agent: null } });
      try {
        expect(await errorOf(syncUpstreamTools(db, reg.json().id, client))).toBeInstanceOf(McpAdmissionHeldError);
      } finally {
        await client.close();
      }
    } finally {
      await db.execute(sql`update org_settings set mcp_admission_mode = ${found}`);
    }
    await loop;
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, reg.json().id));
    expect(row!.admissionState).toBe("held");
  }, 60_000);

  it("a sandbox whose report lies is refused before any input: execution_profile_mismatch, executor quarantined", async () => {
    const backend = new FakeSandboxBackend({ backend: "kata", classes: ["hardened_container", "microvm"], stdioServer: fakeMcpServer });
    // the canary is honest (the self-test passes); the workload's own sandbox shows the host kernel
    backend.lie("runtime_identity", (o) => ({ ...o, runtime: "runc", hypervisor: false, guestKernelDistinct: false }), "placement");
    const liar = await rig("liar", backend);
    setStdioPlacementAffinityForTest([liar.executorId]);
    const loop = liar.run(6);
    for (let i = 0; i < 100 && !liar.logs.some((m) => m.includes("fresh attestation")); i++) await new Promise((r) => setTimeout(r, 50));
    const err = await errorOf(callTool());
    expect(err).toMatchObject({ error: "execution_profile_unavailable", executionRefusal: "execution_profile_mismatch" });
    await loop;
    const [sb] = placementSandboxes(backend);
    expect(sb).toMatchObject({ probed: true, released: false, killed: true, workload: null, stdin: [] });
    const [ex] = await db.select().from(executors).where(eq(executors.id, liar.executorId));
    expect(ex).toMatchObject({ status: "quarantined", quarantineCode: "execution_profile_mismatch" });
    const p = await placementOfDecision((await lastDecision())!.id);
    expect(p).toMatchObject({ outcome: "offered", executorId: liar.executorId });
    const [r] = await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, p!.id));
    expect(r).toMatchObject({ outcome: "mismatch", refusalCode: "execution_profile_mismatch" });
    expect(liveStdioSessions()).toBe(0);
  }, 60_000);
});

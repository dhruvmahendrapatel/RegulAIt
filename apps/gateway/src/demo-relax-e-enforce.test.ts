/**
 * Beat E after the audited demo-data relaxation (owner, #453 c6521685462; demo-path QA PR #607 open item 1), against
 * a REAL listening gateway on its own scratch database, under the STRICT defaults (no test fixture relaxes signing or
 * the sensitive quorum here).
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *  1. BEFORE: with Dana a member of a sensitive (in-app-only classified) project and passkey signing on, `demo:enforce`
 *     denies search_code and then reports write_file REFUSED, not queued (`approval-quorum-unsatisfiable`), exit 1, and
 *     the write never runs. This is the clean-prepare failure the QA review found.
 *  2. THE STEP: `applyDemoERelaxation` through the admin API, with the bootstrap credential during first-admin setup
 *     (as the seed runs it), sets the sensitive quorum to 1 and approval signing to off, writes exactly one
 *     `org-settings-updated` audit row naming both keys under `relaxed`, and a second run writes nothing.
 *  3. AFTER: `demo:enforce` denies search_code, QUEUES write_file for Avery, Avery approves with a plain sign-off
 *     (method `none`), and the write is APPROVED and EXECUTED exactly once, exit 0.
 *  4. demo:check's E row FAILs before the step and PASSes after it.
 * The strict product defaults (BATCH4_STRICT_DEFAULTS) are unchanged throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import {
  and,
  approvalDecisions,
  approvals,
  auditLog,
  complianceProfiles,
  createDb,
  eq,
  projectMembers,
  projects,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runEnforceBeat } from "./demo-enforce-lib.js";
import {
  DEMO_E_RELAX_AUDIT_RULE_ID,
  applyDemoERelaxation,
  checkEnforceBeatPrereqs,
  type GatewayCall,
} from "./demo-relax-e-lib.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

// its own scratch database: the bootstrap credential passes a step-up only while no admin can step up (B4S-06), which
// is the seed's situation, and the shared test database cannot promise it
const SCRATCH_DB = `regulait_relax_e_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const BOOT = "relax-e-boot";
const AUTH = { authorization: `Bearer ${BOOT}` };
const SERVER = "repo-tools";
const PROJECT = "demo-project";

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp> | undefined;
let gatewayUrl = "";
let danaId = "";
let averyKey = "";
let upstream: http.Server | undefined;
const runs = { search_code: 0, write_file: 0 };

const post = (url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app!.inject({ method: "POST", url, headers, ...(payload ? { payload: payload as object } : {}) });
const call: GatewayCall = async (method, url, headers, body) => {
  const res = await app!.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
  let json: Record<string, any> = {};
  try {
    json = res.json();
  } catch {
    /* status only */
  }
  return { status: res.statusCode, body: json };
};
const beat = () =>
  runEnforceBeat({
    baseUrl: gatewayUrl,
    bootstrapToken: BOOT,
    isSimulated: async () => false,
    verifyTarget: async () => null,
    pollMs: 50,
    waitMs: 15_000,
  });
const prereqRow = async () => (await checkEnforceBeatPrereqs(async (url) => call("GET", url, AUTH)))[0]!;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const mcp = new McpServer({ name: "relax-e-up", version: "0.0.1" });
        mcp.registerTool("search_code", { description: "search", inputSchema: { pattern: z.string() }, annotations: { readOnlyHint: true } }, async () => {
          runs.search_code += 1;
          return { content: [{ type: "text", text: "3 matches" }] };
        });
        mcp.registerTool(
          "write_file",
          { description: "write", inputSchema: { path: z.string(), content: z.string(), branch: z.string().optional() } },
          async (a) => {
            runs.write_file += 1;
            return { content: [{ type: "text", text: `committed ${a.path}` }] };
          },
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const addr = upstream.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  const upstreamUrl = `http://127.0.0.1:${addr.port}`;
  const allow = await post("/v1/egress-allow-hosts", { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "relax-e suite: local double" });
  expect([200, 201], allow.body).toContain(allow.statusCode);

  // the demo personas (the guard looks for them), with Dana and Avery as in the seed
  const ids: Record<string, string> = {};
  for (const [email, displayName, isAdmin] of [
    ["admin@regulait.local", "Ada Admin", true],
    ["dana@regulait.local", "Dana Developer", false],
    ["avery@regulait.local", "Avery Approver", false],
    ["morgan@regulait.local", "Morgan Reyes", true],
  ] as const) {
    const r = await post("/v1/users", { email, displayName, isAdmin });
    expect(r.statusCode, r.body).toBe(201);
    ids[email] = r.json().id;
  }
  danaId = ids["dana@regulait.local"]!;
  const averyId = ids["avery@regulait.local"]!;
  averyKey = (await post(`/v1/users/${averyId}/keys`, { name: "relax-e" })).json().token;

  const s = await post("/v1/servers", { name: SERVER, url: `${upstreamUrl}/` });
  expect(s.statusCode, s.body).toBe(201);
  const serverId = s.json().id as string;
  for (const [name, kind] of [["search_code", "read"], ["write_file", "write"]] as const) {
    await post(`/v1/servers/${serverId}/tools`, { name, kind, description: name });
  }
  const role = await post("/v1/roles", { name: "relax-e-readonly", description: "read-only baseline" });
  const roleId = role.json().id as string;
  expect((await post(`/v1/roles/${roleId}/grants/servers`, { serverId, readOnlyAll: true })).statusCode).toBeLessThan(300);
  expect((await post(`/v1/users/${danaId}/roles`, { roleId })).statusCode).toBeLessThan(300);
  expect((await post("/v1/grants/tools", { userId: danaId, serverId, toolName: "write_file" })).statusCode).toBeLessThan(300);
  expect((await post("/v1/revocations", { userId: danaId, serverId, toolName: "search_code" })).statusCode).toBeLessThan(300);
  expect((await post("/v1/rules/approvals", { userId: danaId, serverId, toolName: "write_file", approverUserId: averyId })).statusCode).toBeLessThan(300);
  expect((await post("/v1/projects", { name: PROJECT })).statusCode).toBe(201);
  // the seed's hipaa-project: an in-app-only classification Dana is a member of (B4S-03 caller_membership)
  const [profile] = await db.insert(complianceProfiles).values({ tag: "relax-e-hipaa", piiMode: "block", mcpDefaultMode: "read_write" }).returning();
  const [sensitive] = await db.insert(projects).values({ name: "hipaa-project", classifications: [profile!.tag] }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ projectId: sensitive!.id, userId: danaId, role: "contributor" });
}, 120_000);

afterAll(async () => {
  await closeAll([
    () => {
      upstream?.closeAllConnections();
      return new Promise((r) => (upstream ? upstream.close(() => r(undefined)) : r(undefined)));
    },
    () => {
      app?.server.closeAllConnections();
      return app?.close() ?? Promise.resolve();
    },
    () => db?.$client.end() ?? Promise.resolve(),
    () => dropScratchDatabase(admin, SCRATCH_DB),
    () => admin.$client.end(),
  ]);
});

describe("beat E: the audited demo-data relaxation", () => {
  it("strict defaults: the write is refused at queue time, not queued, and never runs; demo:check FAILs", async () => {
    const settings = (await call("GET", "/v1/org/settings", AUTH)).body.settings;
    expect(settings).toMatchObject({
      toolApprovalSensitiveQuorum: BATCH4_STRICT_DEFAULTS.toolApprovalSensitiveQuorum,
      approvalSignatureMode: BATCH4_STRICT_DEFAULTS.approvalSignatureMode,
    });
    expect((await prereqRow()).level).toBe("FAIL");
    const r = await beat();
    expect(r.outcome).toBe("unexpected");
    expect(r.exitCode).toBe(1);
    expect(r.lines.some((l) => l.includes("search_code   DENIED"))).toBe(true);
    expect(r.lines.some((l) => l.includes("write_file was refused, not queued") && l.includes("2 different approvers"))).toBe(true);
    expect(runs.write_file).toBe(0);
  });

  it("the step relaxes both settings through the admin API, audited once, and is idempotent", async () => {
    const before = await db.select({ seq: auditLog.seq }).from(auditLog).where(eq(auditLog.ruleId, DEMO_E_RELAX_AUDIT_RULE_ID));
    const r = await applyDemoERelaxation(call, { headers: AUTH });
    expect(r.status, r.lines.join("\n")).toBe("relaxed");
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, DEMO_E_RELAX_AUDIT_RULE_ID));
    expect(rows).toHaveLength(before.length + 1);
    const row = rows.at(-1)!;
    expect(row.effect).toBe("allow");
    expect((row.detail as { relaxed?: string[] }).relaxed).toEqual(expect.arrayContaining(["toolApprovalSensitiveQuorum", "approvalSignatureMode"]));
    expect(row.reason).toContain("RELAXED from the strict default");
    expect((row.detail as { transitions?: Record<string, unknown> }).transitions).toMatchObject({
      toolApprovalSensitiveQuorum: { from: 2, to: 1 },
      approvalSignatureMode: { from: "passkey", to: "off" },
    });

    const again = await applyDemoERelaxation(call, { headers: AUTH });
    expect(again.status).toBe("already");
    expect(await db.select({ seq: auditLog.seq }).from(auditLog).where(eq(auditLog.ruleId, DEMO_E_RELAX_AUDIT_RULE_ID))).toHaveLength(rows.length);
    expect((await prereqRow()).level).toBe("PASS");
    // the product's own defaults are untouched
    expect(BATCH4_STRICT_DEFAULTS).toMatchObject({ toolApprovalSensitiveQuorum: 2, approvalSignatureMode: "passkey" });
  });

  it("after the step: denied, QUEUED for Avery, approved with a plain sign-off, then APPROVED and EXECUTED once", async () => {
    const running = beat();
    let approvalId = "";
    for (let i = 0; i < 200 && !approvalId; i++) {
      const [row] = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.userId, danaId), eq(approvals.toolName, "write_file"), eq(approvals.status, "pending")));
      if (row) approvalId = row.id;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(approvalId, "the beat never queued its approval").not.toBe("");
    const [queued] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(queued).toMatchObject({ quorum: 1, signatureMode: "off" });
    expect(runs.write_file).toBe(0);

    const decided = await post(`/v1/approvals/${approvalId}/decide`, { decision: "approved", reason: "relax-e test" }, { authorization: `Bearer ${averyKey}` });
    expect(decided.statusCode, decided.body).toBe(200);
    const r = await running;
    expect(r.outcome, r.lines.join("\n")).toBe("executed");
    expect(r.exitCode).toBe(0);
    expect(r.lines.some((l) => l.includes("search_code   DENIED"))).toBe(true);
    expect(r.lines.some((l) => l.includes("write_file    QUEUED") && l.includes("Avery Approver"))).toBe(true);
    expect(r.lines.some((l) => l.includes("APPROVED and EXECUTED"))).toBe(true);
    expect(runs.search_code).toBe(0);
    expect(runs.write_file).toBe(1);
    const decisions = await db.select().from(approvalDecisions).where(eq(approvalDecisions.approvalId, approvalId));
    expect(decisions.map((d) => d.stepUpMethod)).toEqual(["none"]);
  });
});

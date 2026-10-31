/**
 * ADR-0186 A — simulation parity: the access preview (`POST /v1/evaluate`)
 * runs the queue-time quorum and signature-mode check (`toolApprovalRequirements`),
 * so a `require_approval` the queue would refuse previews as that same deny.
 *
 * Each case asks the preview, then makes the real call through the governed
 * path (`executeGovernedToolCall`), and asserts the two agree:
 *  (a) a quorum the pool cannot reach (the caller works on a project carrying
 *      an in-app-only classification, so dual control applies) — both deny
 *      with `approval-quorum-unsatisfiable` and the same reason;
 *  (b) passkey signature mode with an approver who holds no passkey — both
 *      deny; under `step_up` the same rule previews and queues as an approval;
 *  (c) an approvable call still previews `require_approval` and queues.
 *
 * Runs on its OWN scratch database (prefix `simq_`), dropped in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  approvals,
  authSessions,
  complianceProfiles,
  createDb,
  eq,
  ORG_SETTINGS_ID,
  orgSettings,
  projectMembers,
  projects,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `simq_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `simq-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;

type Session = { token: string; sessionId: string };
type User = { id: string; s: Session };
/** caller; `signer` holds a passkey; `unsigned` holds none */
const P = {} as Record<"caller" | "signer" | "unsigned", User>;

const TOOLS = Array.from({ length: 6 }, (_, i) => `simq_t${i}_${RUN}`);
let toolCursor = 0;
const nextTool = () => TOOLS[toolCursor++]!;

type Method = "GET" | "POST";
const withKey = (key: { authorization: string }, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: key, ...(payload !== undefined ? { payload: payload as object } : {}) });
const as = (s: Session, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: CSRF, cookies: { regulait_session: s.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkSession(userId: string): Promise<Session> {
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [row] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  return { token, sessionId: row!.id };
}

async function mkUser(label: string, passkey: boolean): Promise<User> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `simq-${label}-${RUN}@example.com`, displayName: `simq ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const s = await mkSession(id);
  if (passkey) {
    const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(opt.statusCode, opt.body).toBe(200);
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: "laptop" });
    expect(reg.statusCode, reg.body).toBe(201);
  }
  return { id, s };
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "simq-upstream", version: "0.0.1" });
        for (const name of TOOLS) {
          server.registerTool(name, { description: name, inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
        }
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

/** an approval rule on `tool` for the caller, through the real route */
async function rule(tool: string, approverUserId: string) {
  const r = await withKey(AUTH, "POST", "/v1/rules/approvals", { userId: P.caller.id, serverId, toolName: tool, approverUserId, quorum: 1 });
  expect(r.statusCode, r.body).toBe(201);
}

type Decided = { effect: string; ruleId: string; reason: string };
const preview = async (tool: string): Promise<Decided> => {
  const r = await withKey(AUTH, "POST", "/v1/evaluate", { userId: P.caller.id, serverId, toolName: tool });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Decided;
};
const call = (tool: string) => executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: { text: "simq" } });
const pendingFor = async (tool: string) => db.select({ id: approvals.id }).from(approvals).where(eq(approvals.toolName, tool));

async function setMode(mode: "passkey" | "step_up" | "off") {
  await db.update(orgSettings).set({ approvalSignatureMode: mode }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await relaxStrictAdmissionForTest(db);
  await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `simq-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  P.caller = await mkUser("caller", false);
  P.signer = await mkUser("signer", true);
  P.unsigned = await mkUser("unsigned", false);
  for (const name of TOOLS) {
    const t = await withKey(AUTH, "POST", `/v1/servers/${serverId}/tools`, { name, kind: "write" });
    expect([200, 201]).toContain(t.statusCode);
    const g = await withKey(AUTH, "POST", "/v1/grants/tools", { userId: P.caller.id, serverId, toolName: name });
    expect([200, 201]).toContain(g.statusCode);
  }
  // the strict default is the starting point for every case
  await setMode("passkey");
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => upstreamClose?.(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

describe("the access preview agrees with the approval queue", () => {
  it("(a) a quorum the pool cannot reach: the preview and the queue both deny, same rule id and reason", async () => {
    const tool = nextTool();
    await rule(tool, P.signer.id);
    const [profile] = await db
      .insert(complianceProfiles)
      .values({ tag: `simq-sensitive-${RUN}`, piiMode: "block", mcpDefaultMode: "read_write" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ name: `simq-sensitive-${RUN}`, classifications: [profile!.tag] })
      .returning({ id: projects.id });
    await db.insert(projectMembers).values({ projectId: project!.id, userId: P.caller.id, role: "contributor" });
    try {
      const p = await preview(tool);
      const out = await call(tool);
      expect(out.kind, JSON.stringify(out)).toBe("denied");
      const real = (out as { decision: Decided }).decision;
      expect(real.ruleId).toBe("approval-quorum-unsatisfiable");
      expect(p.effect).toBe("deny");
      expect(p.ruleId).toBe(real.ruleId);
      expect(p.reason).toBe(real.reason);
      expect(p.reason).toContain("needs 2 different approvers");
      expect(await pendingFor(tool)).toHaveLength(0);
    } finally {
      await db.delete(projectMembers).where(eq(projectMembers.userId, P.caller.id));
    }
  });

  it("(b) passkey mode, an approver who holds no passkey: both deny; under step_up both treat it as approvable", async () => {
    const tool = nextTool();
    await rule(tool, P.unsigned.id);
    const p = await preview(tool);
    const out = await call(tool);
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    const real = (out as { decision: Decided }).decision;
    expect(real.ruleId).toBe("approval-quorum-unsatisfiable");
    expect(p).toMatchObject({ effect: "deny", ruleId: real.ruleId, reason: real.reason });
    expect(p.reason).toContain("who can sign with a passkey they already hold");
    expect(await pendingFor(tool)).toHaveLength(0);

    await setMode("step_up");
    try {
      expect((await preview(tool)).effect).toBe("require_approval");
      expect((await call(tool)).kind).toBe("approval_required");
    } finally {
      await setMode("passkey");
    }
  });

  it("(c) an approvable call still previews require_approval, and the queue takes it", async () => {
    const tool = nextTool();
    await rule(tool, P.signer.id);
    const p = await preview(tool);
    expect(p.effect).toBe("require_approval");
    expect(p.ruleId).not.toBe("approval-quorum-unsatisfiable");
    const out = await call(tool);
    expect(out.kind, JSON.stringify(out)).toBe("approval_required");
    expect(await pendingFor(tool)).toHaveLength(1);
  });
});

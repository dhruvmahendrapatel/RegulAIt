/**
 * Batch 4 (ADR-0186 decision 28) — automated-review fixes on PR #198, round 8,
 * proven red on the pre-fix head (9f644e3) and green after:
 *
 *  F46  the consume-time recheck read-locks the approving accounts and signing
 *       passkeys: a passkey revocation or an account deactivation in flight is
 *       waited for and then seen, never consumed past (two connections).
 *  F47  a rule edit that loosens what the rule enforces — any field, any rule
 *       kind — needs settings_relax, on the row PATCH and on version activation.
 *
 * (F44–45, the 0171 backfill, are in `zz-b4c8-migration-0171.test.ts`.)
 *
 * Runs on its OWN scratch database (prefix `b4c8_`), dropped in afterAll, so
 * nothing append-only outlives the run (M-068).
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
  approvalDecisions,
  approvals,
  authSessions,
  createDb,
  eq,
  ORG_SETTINGS_ID,
  rateLimits,
  runMigrations,
  sql,
  users as usersTable,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
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
const SCRATCH_DB = `b4c8_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c8-rv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "a".repeat(64);
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let locker: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;

type Session = { token: string; sessionId: string };
type Person = { id: string; s: Session; auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "adm", Person>;

const TOOLS = Array.from({ length: 12 }, (_, i) => `b4c8_t${i}_${RUN}`);
const upstreamHits = { tool: 0 };
let toolCursor = 0;
const nextTool = () => TOOLS[toolCursor++]!;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const as = (s: Session, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: s.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const withKey = (key: { authorization: string }, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: key, ...(payload !== undefined ? { payload: payload as object } : {}) });

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

async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c8-${label}-${randomBytes(2).toString("hex")}-${RUN}@example.com`, displayName: `b4c8 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const s = await mkSession(id);
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: "b4c8" });
  expect(reg.statusCode, reg.body).toBe(201);
  return { id, s, auth };
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b4c8-upstream", version: "0.0.1" });
        for (const name of TOOLS) {
          server.registerTool(name, { description: name, inputSchema: { text: z.string() } }, async ({ text }) => {
            upstreamHits.tool++;
            return { content: [{ type: "text", text: `ran: ${text}` }] };
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

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p.s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: p.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

const call = (tool: string, args: Record<string, unknown>) =>
  executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: args });

/** a tool-call approval named to `approver` (quorum 1, passkey mode), signed and approved by them */
async function signedApproval(approver: Person, tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await withKey(AUTH, "POST", "/v1/rules/approvals", { userId: P.caller.id, serverId, toolName: tool, approverUserId: approver.id, quorum: 1 });
  expect(r.statusCode, r.body).toBe(201);
  const out = await call(tool, args);
  expect(out.kind, JSON.stringify(out)).toBe("approval_required");
  const approvalId = (out as { approvalId: string }).approvalId;
  const o = await as(approver.s, "POST", `/v1/approvals/${approvalId}/signing-options`, { decision: "approved" });
  expect(o.statusCode, o.body).toBe(200);
  const d = await as(approver.s, "POST", `/v1/approvals/${approvalId}/decide`, {
    decision: "approved",
    reason: "b4c8",
    passkey: { challengeId: o.json().challengeId, response: approver.auth.authenticate(o.json().options) },
  });
  expect(d.statusCode, d.body).toBe(200);
  return approvalId;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  locker = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await relaxStrictAdmissionForTest(db);
  await relaxGovernanceGatesForTest(db, { requirePreviewBeforeActivate: false });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required', approval_signature_mode = 'passkey',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4c8-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  P.caller = await mkPerson("caller");
  P.a = await mkPerson("approver-a");
  P.adm = await mkPerson("admin", true);
  for (const name of TOOLS) {
    const t = await withKey(AUTH, "POST", `/v1/servers/${serverId}/tools`, { name, kind: "write" });
    expect([200, 201]).toContain(t.statusCode);
    const g = await withKey(AUTH, "POST", "/v1/grants/tools", { userId: P.caller.id, serverId, toolName: name });
    expect([200, 201]).toContain(g.statusCode);
  }
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => upstreamClose?.(),
    async () => locker?.$client.end(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

type CallOut = Awaited<ReturnType<typeof call>>;
/**
 * `mutate` runs uncommitted on another connection, holding its row lock; the
 * call fires, and the change commits once the call is blocked on that lock —
 * or once the call answered without waiting (the pre-fix behaviour: it read
 * the old state and decided on it).
 */
async function racedCall(mutate: (tx: Db) => Promise<unknown>, tool: string, args: Record<string, unknown>): Promise<CallOut> {
  let out: CallOut | undefined;
  await locker.transaction(async (tx) => {
    await mutate(tx as unknown as Db);
    void call(tool, args).then((r) => (out = r));
    for (let i = 0; i < 250 && !out; i++) {
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  for (let i = 0; i < 250 && !out; i++) await new Promise((r) => setTimeout(r, 20));
  expect(out, "the call never answered").toBeTruthy();
  return out!;
}

describe("F46: the consume-time recheck never decides past an in-flight revocation or deactivation", () => {
  it("a passkey revoked while the call is consumed: the call is refused, the approval superseded", async () => {
    const tool = nextTool();
    const args = { text: "revoked mid-consume" };
    const approvalId = await signedApproval(P.a, tool, args);
    const [d] = await db.select({ credentialId: approvalDecisions.credentialId }).from(approvalDecisions).where(eq(approvalDecisions.approvalId, approvalId));
    const hits = upstreamHits.tool;
    const out = await racedCall(
      (tx) => tx.update(webauthnCredentials).set({ revokedAt: sql`now()`, revokeReason: "b4c8 revoked mid-consume" }).where(eq(webauthnCredentials.id, d!.credentialId!)),
      tool,
      args,
    );
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    expect(upstreamHits.tool).toBe(hits);
    expect((await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)))[0]!.s).toBe("superseded");
  });

  it("the approver deactivated while the call is consumed: the call is refused", async () => {
    const tool = nextTool();
    const args = { text: "deactivated mid-consume" };
    const approver = await mkPerson("approver-d");
    const approvalId = await signedApproval(approver, tool, args);
    const hits = upstreamHits.tool;
    try {
      const out = await racedCall((tx) => tx.update(usersTable).set({ disabledAt: sql`now()` }).where(eq(usersTable.id, approver.id)), tool, args);
      expect(out.kind, JSON.stringify(out)).toBe("denied");
      expect(upstreamHits.tool).toBe(hits);
      expect((await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)))[0]!.s).toBe("superseded");
    } finally {
      await db.update(usersTable).set({ disabledAt: null }).where(eq(usersTable.id, approver.id));
    }
  });
});

/** refused without a grant (403 settings_relax, `unchanged` holds), admitted with one */
async function provesRelax(method: Method, url: string, payload: unknown, unchanged: () => Promise<void>) {
  const refused = await as(P.adm.s, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  await unchanged();
  const ok = await as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, refused.json().action) });
  expect(ok.statusCode, ok.body).toBeLessThan(300);
}

describe("F47: an edit that loosens what a rule enforces needs settings_relax, for every field and rule kind", () => {
  it("approval rule: every tool -> one tool, and writes-only", async () => {
    const r = await withKey(AUTH, "POST", "/v1/rules/approvals", { userId: P.caller.id, serverId, toolName: null, approverUserId: P.a.id });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    await provesRelax("PATCH", `/v1/rules/approvals/${id}`, { toolName: nextTool() }, async () => {});
    await provesRelax("PATCH", `/v1/rules/approvals/${id}`, { writeOnly: true }, async () => {});
  });

  it("rate limit: more calls, a shorter window; fewer calls asks for nothing", async () => {
    const r = await withKey(AUTH, "POST", "/v1/rules/rate-limits", { userId: P.caller.id, serverId, toolName: null, maxCalls: 10, windowSeconds: 60 });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    const maxCallsOf = async () => (await db.select({ m: rateLimits.maxCalls }).from(rateLimits).where(eq(rateLimits.id, id)))[0]!.m;
    await provesRelax("PATCH", `/v1/rules/rate-limits/${id}`, { maxCalls: 20 }, async () => expect(await maxCallsOf()).toBe(10));
    await provesRelax("PATCH", `/v1/rules/rate-limits/${id}`, { windowSeconds: 30 }, async () => {});
    const tighter = await as(P.adm.s, "PATCH", `/v1/rules/rate-limits/${id}`, { maxCalls: 5 });
    expect(tighter.statusCode, tighter.body).toBe(200);
  });

  it("data scope: a widened allowed-value list", async () => {
    const r = await withKey(AUTH, "POST", "/v1/rules/data-scopes", { userId: P.caller.id, serverId, toolName: null, argPath: "text", allowedValues: ["a"] });
    expect(r.statusCode, r.body).toBe(201);
    await provesRelax("PATCH", `/v1/rules/data-scopes/${r.json().id}`, { allowedValues: ["a", "b"] }, async () => {});
  });

  it("version activation: a rate-limit version with a higher limit", async () => {
    const r = await withKey(AUTH, "POST", "/v1/rules/rate-limits", { userId: P.caller.id, serverId, toolName: null, maxCalls: 10, windowSeconds: 60 });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    const draft = await as(P.adm.s, "POST", `/v1/config-versions/rate_limit/${id}`, { body: { maxCalls: 50 }, activate: false });
    expect(draft.statusCode, draft.body).toBe(201);
    await provesRelax("POST", `/v1/config-versions/rate_limit/${id}/activate`, { version: draft.json().version.version }, async () => {});
  });
});

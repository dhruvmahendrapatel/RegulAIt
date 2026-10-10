/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, each proven red on
 * the pre-fix head and green after:
 *
 *  F1  lifting an agent or tool halt decides the step-up against the LOCKED
 *      row: a halt landing between the route's first read and its row lock is
 *      never lifted without a step-up.
 *  F2  delegation links are the WHOLE connected component (a chain through
 *      people outside the pool still makes its ends one principal).
 *  F3  the copilot's rule_to_approval applier keeps a proposal's quorum and
 *      approver role (the shared create schema carries them).
 *  F4  a tool-call approval's approver role is the one snapshotted when the
 *      call was queued, not the rule's current role.
 *  F5  an active delegate of an approver-role member sees the approval in the
 *      queue, as eligibilityOf already lets them decide it.
 *  F6  the step-up ceremony and verify routes ride the strict auth-tier rate
 *      limit, per user and per IP.
 *
 * Runs on its OWN scratch database (prefix `b4c_`), dropped in afterAll, so
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
  agents,
  approvalDelegations,
  approvalRules,
  approvals,
  authSessions,
  copilotQueries,
  createDb,
  eq,
  inArray,
  mcpTools,
  ORG_SETTINGS_ID,
  rateLimits,
  roleAssignments,
  roles,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { totpCode, totpStep } from "./totp.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4c_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c-rv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "a".repeat(64);
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let locker: Db;
let app: ReturnType<typeof buildApp>;
/** F6: the same gateway with the HTTP rate limiter ON (the suite default is off) */
let limited: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let roleId: string;

type Session = { token: string; sessionId: string };
type Person = { id: string; key: { authorization: string }; s: Session; auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "b" | "adm", Person>;

const TOOLS = Array.from({ length: 16 }, (_, i) => `b4c_t${i}_${RUN}`);
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

async function enrol(s: Session): Promise<SoftAuthenticator> {
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: `b4c-${randomBytes(2).toString("hex")}` });
  expect(reg.statusCode, reg.body).toBe(201);
  return auth;
}

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string }; s: Session }> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c-${label}-${RUN}@example.com`, displayName: `b4c ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await withKey(AUTH, "POST", `/v1/users/${id}/keys`, { name: "b4c" });
  expect(key.statusCode, key.body).toBe(201);
  return { id, key: { authorization: `Bearer ${key.json().token}` }, s: await mkSession(id) };
}

async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await mkUser(label, isAdmin);
  return { ...u, auth: await enrol(u.s) };
}
const person = (label: string) => mkPerson(`${label}-${randomBytes(2).toString("hex")}`);

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b4c-upstream", version: "0.0.1" });
        for (const name of TOOLS) {
          server.registerTool(name, { description: name, inputSchema: { text: z.string() } }, async ({ text }) => ({
            content: [{ type: "text", text: `ran: ${text}` }],
          }));
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

/** an approval rule on `tool` for the caller (named approver A, approver role R), through the real route */
async function rule(tool: string, body: Record<string, unknown> = {}) {
  const r = await withKey(AUTH, "POST", "/v1/rules/approvals", {
    userId: P.caller.id,
    serverId,
    toolName: tool,
    approverUserId: P.a.id,
    approverRoleId: roleId,
    quorum: 1,
    ...body,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const call = (tool: string, args: Record<string, unknown>) =>
  executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: args });

async function queued(tool: string, args: Record<string, unknown>): Promise<string> {
  const out = await call(tool, args);
  expect(out.kind, JSON.stringify(out)).toBe("approval_required");
  return (out as { approvalId: string }).approvalId;
}

const signingOptions = (p: { s: Session }, approvalId: string) =>
  as(p.s, "POST", `/v1/approvals/${approvalId}/signing-options`, { decision: "approved" });
const queueOf = async (p: { s: Session }) =>
  ((await as(p.s, "GET", "/v1/approvals?status=pending")).json().approvals as Array<{ id: string }>).map((r) => r.id);

const delegate = async (fromUserId: string, toUserId: string) =>
  (
    await db
      .insert(approvalDelegations)
      .values({ fromUserId, toUserId, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), reason: "b4c" })
      .returning({ id: approvalDelegations.id })
  )[0]!.id;

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p.s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: p.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** wait until some backend of the scratch database is blocked on a row lock */
async function untilLockWait(): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const { rows } = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the request never blocked on the row lock");
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
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required', approval_delegation_enabled = true,
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  limited = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, rateLimit: { enabled: true } });
  await limited.ready();
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4c-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  P.caller = await mkPerson("caller");
  P.a = await mkPerson("approver-a");
  P.b = await mkPerson("approver-b");
  P.adm = await mkPerson("admin", true);
  const [role] = await db.insert(roles).values({ name: `b4c approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  await db.insert(roleAssignments).values({ userId: P.b.id, roleId });
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
    async () => limited?.close(),
    async () => upstreamClose?.(),
    async () => locker?.$client.end(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

describe("F1: lifting a halt decides the step-up on the locked row", () => {
  it("an agent halted between the route's first read and its row lock is not unhalted without a step-up", async () => {
    const [a] = await db.insert(agents).values({ name: `b4c-race-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    let res: Awaited<ReturnType<typeof as>> | undefined;
    await locker.transaction(async (tx) => {
      // hold the row: the route's pre-read (not halted → no step-up) passes, its FOR UPDATE waits here
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${a!.id} FOR UPDATE`);
      const pending = as(P.adm.s, "POST", `/v1/agents/${a!.id}/unhalt`, { reason: "b4c race lift" });
      await untilLockWait();
      // another request halts it, and commits, while the unhalt waits on the lock
      await tx.execute(sql`UPDATE agents SET halted_at = now(), halted_reason = 'b4c race halt' WHERE id = ${a!.id}`);
      void pending.then((r) => (res = r));
    });
    for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
    expect(res, "the unhalt request never answered").toBeTruthy();
    expect(res!.statusCode, res!.body).toBe(403);
    expect(res!.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect(res!.json().action).toEqual({ kind: "settings_relax", body: { agentId: a!.id, values: { halted: false } } });
    const [after] = await db.select({ haltedAt: agents.haltedAt }).from(agents).where(eq(agents.id, a!.id));
    expect(after!.haltedAt).not.toBeNull();
    // control: with the step-up the locked state asks for, the halt is lifted
    const token = await grantFor(P.adm, res!.json().action);
    const ok = await as(P.adm.s, "POST", `/v1/agents/${a!.id}/unhalt`, { reason: "b4c race lift" }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().changed).toBe(true);
  });

  it("a tool halted between the route's first read and its row lock is not unhalted without a step-up", async () => {
    const name = `b4c_race_tool_${RUN}`;
    const [t] = await db.insert(mcpTools).values({ serverId, name, kind: "write" }).returning({ id: mcpTools.id });
    const url = `/v1/servers/${serverId}/tools/${name}/unhalt`;
    let res: Awaited<ReturnType<typeof as>> | undefined;
    await locker.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM mcp_tools WHERE id = ${t!.id} FOR UPDATE`);
      const pending = as(P.adm.s, "POST", url, { reason: "b4c race lift" });
      await untilLockWait();
      await tx.execute(sql`UPDATE mcp_tools SET halted_at = now(), halted_reason = 'b4c race halt' WHERE id = ${t!.id}`);
      void pending.then((r) => (res = r));
    });
    for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
    expect(res, "the unhalt request never answered").toBeTruthy();
    expect(res!.statusCode, res!.body).toBe(403);
    expect(res!.json().action).toEqual({ kind: "settings_relax", body: { serverId, toolName: name, values: { halted: false } } });
    const [after] = await db.select({ haltedAt: mcpTools.haltedAt }).from(mcpTools).where(eq(mcpTools.id, t!.id));
    expect(after!.haltedAt).not.toBeNull();
    const token = await grantFor(P.adm, res!.json().action);
    const ok = await as(P.adm.s, "POST", url, { reason: "b4c race lift" }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().changed).toBe(true);
  });
});

describe("F2: a delegation chain through people outside the pool still makes its ends one principal", () => {
  it("caller → X → Y → named approver: the approver is the caller's principal, so a lone-approver call is denied", async () => {
    const tool = nextTool();
    await rule(tool, { approverRoleId: null });
    const x = await person("chain-x");
    const y = await person("chain-y");
    const links = [await delegate(P.caller.id, x.id), await delegate(x.id, y.id), await delegate(y.id, P.a.id)];
    try {
      const out = await call(tool, { text: "self approval via a chain" });
      expect(out.kind, JSON.stringify(out)).toBe("denied");
      expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("approval-quorum-unsatisfiable");
    } finally {
      await db.delete(approvalDelegations).where(inArray(approvalDelegations.id, links));
    }
  });

  it("approver A → X → Y → role member B: two linked approvers are one principal, so quorum 2 is unsatisfiable", async () => {
    const tool = nextTool();
    await rule(tool, { quorum: 2 });
    const x = await person("pair-x");
    const y = await person("pair-y");
    const links = [await delegate(P.a.id, x.id), await delegate(x.id, y.id), await delegate(y.id, P.b.id)];
    try {
      const out = await call(tool, { text: "two linked approvers" });
      expect(out.kind, JSON.stringify(out)).toBe("denied");
      expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("approval-quorum-unsatisfiable");
    } finally {
      await db.delete(approvalDelegations).where(inArray(approvalDelegations.id, links));
    }
  });
});

describe("F3: the copilot's rule_to_approval applier keeps quorum and approver role", () => {
  it("a proposal for a 2-person role-backed rule creates a 2-person role-backed rule", async () => {
    const tool = nextTool();
    const [q] = await db
      .insert(copilotQueries)
      .values({ userId: P.adm.id, question: "b4c fixture", plan: { tool: "listAudit", timeframe: "last_7d" }, evidence: {}, answer: "fixture", generation: "grounded" })
      .returning({ id: copilotQueries.id });
    const [rl] = await db
      .insert(rateLimits)
      .values({ scope: "fleet", serverScope: "server", serverId, toolName: tool, maxCalls: 1, windowSeconds: 60 })
      .returning({ id: rateLimits.id });
    const p = await withKey(P.adm.key, "POST", "/v1/copilot/proposals", {
      queryId: q!.id,
      kind: "rule_to_approval",
      title: `b4c dual control ${RUN}`,
      rationale: "b4c: the applier must keep dual control",
      diff: {
        sourceRuleKind: "rate-limits",
        sourceRuleId: rl!.id,
        create: { scope: "user", serverScope: "server", userId: P.caller.id, serverId, toolName: tool, approverUserId: P.a.id, quorum: 2, approverRoleId: roleId },
      },
      approverUserId: P.adm.id,
    });
    expect(p.statusCode, p.body).toBe(201);
    await db.update(approvals).set({ status: "approved", decidedBy: P.adm.id, decidedAt: new Date() }).where(eq(approvals.id, p.json().approvalId as string));
    const applied = await withKey(P.adm.key, "POST", `/v1/copilot/proposals/${p.json().proposal.id}/apply`, {});
    expect(applied.statusCode, applied.body).toBe(200);
    const rules = await db.select().from(approvalRules).where(eq(approvalRules.toolName, tool));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.quorum).toBe(2);
    expect(rules[0]!.approverRoleId).toBe(roleId);
  });
});

describe("F4: an approval's approver role is the one snapshotted at queue time", () => {
  it("re-pointing the rule at another role after queueing neither drops the old role's members nor admits the new one's", async () => {
    const tool = nextTool();
    const ruleId = await rule(tool);
    const z2 = await person("other-role");
    const [r2] = await db.insert(roles).values({ name: `b4c other ${RUN}` }).returning({ id: roles.id });
    await db.insert(roleAssignments).values({ userId: z2.id, roleId: r2!.id });
    const id = await queued(tool, { text: "snapshot the role" });
    expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.approverRoleId).toBe(roleId);
    await db.update(approvalRules).set({ approverRoleId: r2!.id }).where(eq(approvalRules.id, ruleId));
    // B was in the role when the call was queued: still eligible, still sees it
    const bOpts = await signingOptions(P.b, id);
    expect(bOpts.statusCode, bOpts.body).toBe(200);
    expect(await queueOf(P.b)).toContain(id);
    // the new role's member was never in this approval's pool
    const zOpts = await signingOptions(z2, id);
    expect(zOpts.statusCode, zOpts.body).toBe(403);
    expect(zOpts.json().error).toBe("not_the_named_approver");
    expect(await queueOf(z2)).not.toContain(id);
  });
});

describe("F5: the queue shows a tool-call approval to every delegate eligibilityOf admits", () => {
  it("an active delegate of an approver-role member sees the approval and may sign it", async () => {
    const tool = nextTool();
    await rule(tool);
    const d = await person("role-delegate");
    const link = await delegate(P.b.id, d.id);
    try {
      const id = await queued(tool, { text: "delegate of a role member" });
      const opts = await signingOptions(d, id);
      expect(opts.statusCode, opts.body).toBe(200);
      expect(await queueOf(d)).toContain(id);
    } finally {
      await db.delete(approvalDelegations).where(eq(approvalDelegations.id, link));
    }
  });
});

describe("F6: step-up ceremonies ride the strict auth-tier rate limit", () => {
  const action = { kind: "owner_change", body: { objectType: "mcp_server", objectId: "00000000-0000-4000-8000-00000000b4c6", ownerUserId: null } };
  const viaLimited = (s: Session, url: string, payload: unknown, ip: string) =>
    limited.inject({ method: "POST", url, remoteAddress: ip, headers: CSRF, cookies: { regulait_session: s.token }, payload: payload as object });

  async function totpUser(label: string) {
    const u = await mkUser(`${label}-${randomBytes(2).toString("hex")}`);
    const enrolled = await as(u.s, "POST", "/auth/totp/enroll");
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const secret = enrolled.json().secret as string;
    expect((await as(u.s, "POST", "/auth/totp/activate", { code: totpCode(secret, totpStep() - 1) })).statusCode).toBe(200);
    return { ...u, secret };
  }

  /** mint a ceremony and spend it on a wrong code; the status of each leg */
  async function guess(s: Session, ip: string): Promise<[number, number | null]> {
    const o = await viaLimited(s, "/v1/auth/step-up/options", { action }, ip);
    if (o.statusCode !== 200) return [o.statusCode, null];
    const v = await viaLimited(s, "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "totp", code: "000000" }, ip);
    return [200, v.statusCode];
  }

  it("one session guessing TOTP codes from rotating addresses is cut off by the per-user limit", async () => {
    const u = await totpUser("guesser");
    const statuses: number[] = [];
    let wrongCodesChecked = 0;
    for (let i = 0; i < 30; i++) {
      const [o, v] = await guess(u.s, `10.66.${i}.7`);
      statuses.push(o);
      if (v !== null) {
        statuses.push(v);
        if (v === 401) wrongCodesChecked++;
      }
    }
    expect(statuses, JSON.stringify(statuses)).toContain(429);
    // 10 requests per window: at most 5 options + 5 verify reach a code check
    expect(wrongCodesChecked).toBeLessThanOrEqual(5);
  });

  it("many sessions guessing from one address are cut off by the per-IP limit", async () => {
    // six people, two guesses each: never more than 4 requests per person, so only the address can trip
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await totpUser(`ip-${i}`));
    const statuses: number[] = [];
    for (let i = 0; i < 2; i++) {
      for (const p of people) {
        const [o, v] = await guess(p.s, "10.77.0.9");
        statuses.push(o);
        if (v !== null) statuses.push(v);
      }
    }
    expect(statuses, JSON.stringify(statuses)).toContain(429);
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(10);
  });
});

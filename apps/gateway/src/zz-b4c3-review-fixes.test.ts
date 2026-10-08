/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, round 3, each proven
 * red on the pre-fix head (33d009c) and green after:
 *
 *  F12  the org-wide approval signature mode and sensitive-call quorum are part
 *       of the consent context: tightening either retires older consents.
 *  F13  the agent owner route compare-and-sets the owner it read.
 *  F14  approver-pool membership writes (a role assignment, a group mapping, an
 *       onboarding import) and approval-rule writes serialise on the role row,
 *       each deciding its step-up on what the other committed.
 *  Class A sweep — the rule deploy-mode route decides on the locked rule.
 *
 * Runs on its OWN scratch database (prefix `b4c3_`), dropped in afterAll, so
 * nothing append-only outlives the run (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  agents,
  and,
  approvalRules,
  groupRoleMappings,
  approvalAssignmentRules,
  approvalDelegations,
  approvals,
  auditLog,
  authSessions,
  chatopsConnections,
  connectors,
  createDb,
  eq,
  guardrailConfigs,
  interceptionSettings,
  isNull,
  mcpServers,
  ORG_SETTINGS_ID,
  orgSettings,
  policySimulationSettings,
  revocations,
  roleAssignments,
  roles,
  runMigrations,
  sql,
  type Db,
  type SsoReauthRequestRow,
} from "@regulait/db";
import { APPROVAL_SIGNATURE_RECHECK_FAILED_RULE, STEP_UP_HEADER } from "@regulait/shared";
import { finishSsoReauth } from "./step-up.js";
import { SIGN_IN_INVARIANT_LOCK_KEY } from "./break-glass.js";
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
const SCRATCH_DB = `b4c3_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c3-rv-boot-${RUN}`;
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
let roleId: string;

type Session = { token: string; sessionId: string };
type Person = { id: string; key: { authorization: string }; s: Session; auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "b" | "adm", Person>;

const TOOLS = Array.from({ length: 16 }, (_, i) => `b4c3_t${i}_${RUN}`);
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

async function enrol(s: Session): Promise<SoftAuthenticator> {
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: `b4c-${randomBytes(2).toString("hex")}` });
  expect(reg.statusCode, reg.body).toBe(201);
  return auth;
}

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string }; s: Session }> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c3-${label}-${RUN}@example.com`, displayName: `b4c ${label}`, isAdmin });
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
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
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
    async () => upstreamClose?.(),
    async () => locker?.$client.end(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

/** a fresh admin-session call that needs a step-up: refused, stepped up with a passkey, retried */
async function asSteppedUpAdmin(method: Method, url: string, payload: unknown) {
  const first = await as(P.adm.s, method, url, payload);
  if (first.statusCode !== 403 || first.json().error !== "step_up_required") return first;
  return as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, first.json().action) });
}

type Res = Awaited<ReturnType<typeof as>>;
/**
 * THE STALE-WRITE RACE (Class A). Inside an open transaction on another
 * connection, `mutate` changes the row the request's step-up decision reads
 * (and so holds its lock; `lock` adds the advisory lock a real concurrent
 * writer of that object takes). The request is fired, reads the OLD state
 * (the change is uncommitted), and is let through once it is blocked on a
 * lock; then the change commits. Returns the request's answer.
 */
async function raced(mutate: (tx: Db) => Promise<unknown>, fire: () => Promise<Res>, lock?: ReturnType<typeof sql>): Promise<Res> {
  let res: Res | undefined;
  await locker.transaction(async (tx) => {
    if (lock) await tx.execute(lock);
    await mutate(tx as unknown as Db);
    void fire().then((r) => (res = r));
    await untilLockWait();
  });
  for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
  expect(res, "the request never answered").toBeTruthy();
  return res!;
}

async function stepUpDecide(p: Person, approvalId: string) {
  const first = await as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, { decision: "approved", reason: "b4c2" });
  expect(first.statusCode, first.body).toBe(403);
  const token = await grantFor(p, first.json().action);
  return as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, { decision: "approved", reason: "b4c2" }, { [STEP_UP_HEADER]: token });
}

async function signAndDecide(p: Person, approvalId: string) {
  const o = await signingOptions(p, approvalId);
  expect(o.statusCode, o.body).toBe(200);
  return as(p.s, "POST", `/v1/approvals/${approvalId}/decide`, {
    decision: "approved",
    reason: "b4c2",
    passkey: { challengeId: o.json().challengeId, response: p.auth.authenticate(o.json().options) },
  });
}

/** like `raced`, for a write that may legitimately NOT block on the other transaction (the red case) */
async function racedMaybeBlocking(mutate: (tx: Db) => Promise<unknown>, fire: () => Promise<Res>): Promise<Res> {
  let res: Res | undefined;
  await locker.transaction(async (tx) => {
    await mutate(tx as unknown as Db);
    void fire().then((r) => (res = r));
    for (let i = 0; i < 100 && !res; i++) {
      const { rows } = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
  expect(res, "the request never answered").toBeTruthy();
  return res!;
}

describe("F12: the org-wide dual-control settings are part of the consent context", () => {
  it("tightening the signature mode (step_up -> passkey) retires a consent given under step_up", async () => {
    await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'step_up' WHERE id = ${ORG_SETTINGS_ID}`);
    try {
      const tool = nextTool();
      await rule(tool, { approverRoleId: null });
      const args = { text: "signing tightened" };
      const id = await queued(tool, args);
      const ok = await stepUpDecide(P.a, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().status).toBe("approved");
      await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'passkey' WHERE id = ${ORG_SETTINGS_ID}`);
      const before = upstreamHits.tool;
      const out = await call(tool, args);
      expect(upstreamHits.tool - before, JSON.stringify(out)).toBe(0);
      expect(out.kind, JSON.stringify(out)).not.toBe("allowed");
    } finally {
      await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'passkey' WHERE id = ${ORG_SETTINGS_ID}`);
    }
  });

  it("raising the sensitive-call quorum retires a consent given under the lower one", async () => {
    await db.execute(sql`UPDATE org_settings SET tool_approval_sensitive_quorum = 1 WHERE id = ${ORG_SETTINGS_ID}`);
    try {
      const tool = nextTool();
      await rule(tool);
      const args = { text: "sensitive quorum raised" };
      const id = await queued(tool, args);
      const ok = await signAndDecide(P.a, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().status).toBe("approved");
      await db.execute(sql`UPDATE org_settings SET tool_approval_sensitive_quorum = 2 WHERE id = ${ORG_SETTINGS_ID}`);
      const before = upstreamHits.tool;
      const out = await call(tool, args);
      expect(upstreamHits.tool - before, JSON.stringify(out)).toBe(0);
      expect(out.kind, JSON.stringify(out)).not.toBe("allowed");
    } finally {
      await db.execute(sql`UPDATE org_settings SET tool_approval_sensitive_quorum = 2 WHERE id = ${ORG_SETTINGS_ID}`);
    }
  });
});

describe("F13: the agent owner route never reverts a concurrent owner change", () => {
  it("a stale re-save of the owner it read is refused, not written", async () => {
    const [a] = await db.insert(agents).values({ name: `b4c3-own-${RUN}`, provider: "mock", tier: 1, ownerUserId: P.a.id }).returning({ id: agents.id });
    const res = await raced(
      (tx) => tx.update(agents).set({ ownerUserId: P.b.id }).where(eq(agents.id, a!.id)),
      () => as(P.adm.s, "POST", `/v1/agents/${a!.id}/owner`, { ownerUserId: P.a.id }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await db.select({ o: agents.ownerUserId }).from(agents).where(eq(agents.id, a!.id)))[0]!.o).toBe(P.b.id);
  });
});

describe("F14: approver-pool membership and approval-rule writes serialise on the role", () => {
  const becomeApproverRole = async (tx: Db, roleIdToName: string, ruleId: string) => {
    // what an approval-rule writer does: lock the role, then name it
    await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleIdToName)).for("update");
    await tx.update(approvalRules).set({ approverRoleId: roleIdToName }).where(eq(approvalRules.id, ruleId));
  };

  it("adding someone to a role that became an approver role while the request was decided is refused", async () => {
    const ruleId = await rule(nextTool(), { approverRoleId: null });
    const [r2] = await db.insert(roles).values({ name: `b4c3 soon ${RUN}` }).returning({ id: roles.id });
    const joiner = await person("joiner");
    const res = await raced(
      (tx) => becomeApproverRole(tx, r2!.id, ruleId),
      () => as(P.adm.s, "POST", `/v1/users/${joiner.id}/roles`, { roleId: r2!.id }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(await db.select().from(roleAssignments).where(and(eq(roleAssignments.userId, joiner.id), eq(roleAssignments.roleId, r2!.id)))).toHaveLength(0);
  });

  it("mapping a group to a role that became an approver role meanwhile is refused", async () => {
    const ruleId = await rule(nextTool(), { approverRoleId: null });
    const [r3] = await db.insert(roles).values({ name: `b4c3 soon-g ${RUN}` }).returning({ id: roles.id });
    const res = await raced(
      (tx) => becomeApproverRole(tx, r3!.id, ruleId),
      () => as(P.adm.s, "POST", "/v1/group-role-mappings", { source: "oidc", externalGroup: `b4c3-g-${RUN}`, roleId: r3!.id }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(await db.select().from(groupRoleMappings).where(eq(groupRoleMappings.roleId, r3!.id))).toHaveLength(0);
  });

  it("the mirror: a rule edit naming a role decides its loosening step-up after a concurrent membership commits", async () => {
    const ruleId = await rule(nextTool());
    const [r4] = await db.insert(roles).values({ name: `b4c3 target ${RUN}` }).returning({ id: roles.id });
    const newcomer = await person("newcomer");
    const res = await racedMaybeBlocking(
      async (tx) => {
        // what a membership writer does: lock the role, then add someone
        await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, r4!.id)).for("update");
        await tx.insert(roleAssignments).values({ userId: newcomer.id, roleId: r4!.id });
      },
      () => as(P.adm.s, "PATCH", `/v1/rules/approvals/${ruleId}`, { approverRoleId: r4!.id }),
    );
    // the pool gains the newcomer: a loosening, so the edit needs a settings_relax step-up
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await db.select({ r: approvalRules.approverRoleId }).from(approvalRules).where(eq(approvalRules.id, ruleId)))[0]!.r).toBe(roleId);
  });
});

describe("Class A sweep (round 3): rule deploy-mode scope", () => {
  it("a stale request cannot re-narrow a rule's deploy mode that was widened while it waited", async () => {
    const ruleId = await rule(nextTool());
    await db.update(approvalRules).set({ deployMode: "hosted" }).where(eq(approvalRules.id, ruleId));
    const res = await raced(
      (tx) => tx.update(approvalRules).set({ deployMode: null }).where(eq(approvalRules.id, ruleId)),
      () => as(P.adm.s, "PATCH", `/v1/rules/approvals/${ruleId}/deploy-mode`, { deployMode: "hosted" }),
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await db.select({ m: approvalRules.deployMode }).from(approvalRules).where(eq(approvalRules.id, ruleId)))[0]!.m).toBeNull();
  });
});

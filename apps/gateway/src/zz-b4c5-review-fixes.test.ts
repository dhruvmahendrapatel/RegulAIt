/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, round 5, proven red
 * on the pre-fix head (998a3b8) and green after:
 *
 *  F19  approval-rule writes lock the named approver's user row, so a rule edit
 *       naming an account and that account's reactivation serialise.
 *  F21  the queue-time named approver is persisted (migration 0172), so a
 *       pruned routing audit row cannot change who may decide.
 *  first-passkey race (0172): a ceremony admitted without a step-up completes
 *       only while the account still has no way to step up.
 *  F23  set-initial-password / mfa/clear on the caller's OWN account need a step-up.
 *  F22  verdict only: project membership already advances the policy epoch.
 *
 * Runs on its OWN scratch database (prefix `b4c5_`), dropped in afterAll, so
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
  webauthnCredentials,
  abacPolicies,
  agents,
  and,
  complianceProfiles,
  customModelProviders,
  oidcProviders,
  projectMembers,
  projects,
  releaseOverrides,
  sodRules,
  ssoReauthRequests,
  users as usersTable,
  webauthnChallenges,
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
import { totpCode, totpStep } from "./totp.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4c5_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c5-rv-boot-${RUN}`;
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

const TOOLS = Array.from({ length: 16 }, (_, i) => `b4c5_t${i}_${RUN}`);
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
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c5-${label}-${RUN}@example.com`, displayName: `b4c ${label}`, isAdmin });
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
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
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

/** refused without a grant (403 settings_relax, nothing written per `unchanged`), admitted with one */
async function provesRelax(method: Method, url: string, payload: unknown, unchanged: () => Promise<void>, okStatus = 200) {
  const refused = await as(P.adm.s, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  await unchanged();
  const ok = await as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(okStatus);
  return ok;
}

describe("F19: a rule edit naming an account serialises with that account's reactivation", () => {
  it("naming a just-reactivated account is decided on the committed reactivation (a pool widening needs the step-up)", async () => {
    const tool = nextTool();
    // the approver role keeps the pool satisfiable while the named seat moves to the disabled account
    const ruleId = await rule(tool);
    const u = await mkUser(`seat-${randomBytes(2).toString("hex")}`);
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, u.id));
    const res = await racedMaybeBlocking(
      async (tx) => {
        // what the reactivation route does: lock the user, then clear disabled_at
        await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, u.id)).for("update");
        await tx.update(usersTable).set({ disabledAt: null }).where(eq(usersTable.id, u.id));
      },
      () => as(P.adm.s, "PATCH", `/v1/rules/approvals/${ruleId}`, { approverUserId: u.id }),
    );
    // the pool gains an active account it did not have: a loosening, so a settings_relax step-up
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await db.select({ a: approvalRules.approverUserId }).from(approvalRules).where(eq(approvalRules.id, ruleId)))[0]!.a).toBe(P.a.id);
  });
});

describe("F21: the queue-time named approver is persisted, not reconstructed from prunable audit rows", () => {
  it("pruning the routing audit row leaves the named approver able to decide", async () => {
    const routed = await person("routed5");
    const r = await asSteppedUpAdmin("POST", "/v1/approvals/assignment-rules", {
      name: `b4c5 route ${RUN}`,
      objectType: "mcp_tool",
      assigneeKind: "user",
      assigneeId: routed.id,
    });
    expect(r.statusCode, r.body).toBe(201);
    try {
      const tool = nextTool();
      await rule(tool, { approverRoleId: null });
      const id = await queued(tool, { text: "routed then pruned" });
      await queueOf(routed); // materializes routing: approver_user_id re-pointed, audited
      expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.approverUserId).toBe(routed.id);
      // the retention prune removes the routing row
      await db.delete(auditLog).where(and(eq(auditLog.ruleId, "approval-routed"), sql`${auditLog.detail}->>'approvalId' = ${id}`));
      const opts = await signingOptions(P.a, id);
      expect(opts.statusCode, opts.body).toBe(200);
      expect(await queueOf(P.a)).toContain(id);
    } finally {
      await db.update(approvalAssignmentRules).set({ enabled: false }).where(eq(approvalAssignmentRules.id, r.json().id as string));
    }
  });
});

describe("F22 (verdict): project membership is already a policy-epoch source", () => {
  it("a project_members write advances the governance policy epoch an in-flight consumption holds", async () => {
    const epoch = async () => (await db.execute<{ epoch: number }>(sql`select epoch from governance_policy_epoch`)).rows[0]!.epoch;
    const [project] = await db.insert(projects).values({ name: `b4c5-epoch-${RUN}` }).returning({ id: projects.id });
    const before = Number(await epoch());
    await db.insert(projectMembers).values({ projectId: project!.id, userId: P.b.id, role: "contributor" });
    expect(Number(await epoch())).toBeGreaterThan(before);
  });
});

describe("first-passkey race: a ceremony admitted without a step-up completes only while none is still possible", () => {
  it("two 'first' ceremonies from one fresh session: the second completion is refused", async () => {
    const u = await mkUser(`first-pk-${randomBytes(2).toString("hex")}`);
    const o1 = await as(u.s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(o1.statusCode, o1.body).toBe(200);
    const o2 = await as(u.s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(o2.statusCode, o2.body).toBe(200);
    const a1 = new SoftAuthenticator({ origin: ORIGIN });
    const a2 = new SoftAuthenticator({ origin: ORIGIN });
    const r1 = await as(u.s, "POST", "/v1/auth/passkeys", { challengeId: o1.json().challengeId, response: a1.register(o1.json().options), label: "one" });
    expect(r1.statusCode, r1.body).toBe(201);
    const r2 = await as(u.s, "POST", "/v1/auth/passkeys", { challengeId: o2.json().challengeId, response: a2.register(o2.json().options), label: "two" });
    expect(r2.statusCode, r2.body).toBe(409);
    expect(r2.json().error).toBe("changed_concurrently");
    expect(await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, u.id))).toHaveLength(1);
  });
});

describe("F23: an admin's own password and second factor are not reset without a step-up", () => {
  it("set-initial-password on the caller's own account needs settings_relax", async () => {
    const self = await as(P.adm.s, "POST", `/v1/users/${P.adm.id}/set-initial-password`, { force: true });
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  });

  it("mfa/clear on the caller's own account needs settings_relax", async () => {
    const u = await mkUser(`self-mfa-${randomBytes(2).toString("hex")}`);
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, u.id));
    const enrolled = await as(u.s, "POST", "/auth/totp/enroll");
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    expect((await as(u.s, "POST", "/auth/totp/activate", { code: totpCode(enrolled.json().secret as string, totpStep() - 1) })).statusCode).toBe(200);
    const self = await as(u.s, "POST", `/v1/users/${u.id}/mfa/clear`, { reason: "b4c5 self clear" });
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await db.select({ t: usersTable.totpEnabled }).from(usersTable).where(eq(usersTable.id, u.id)))[0]!.t).toBe(true);
  });
});

describe("F24: a TOTP step-up never burns a code against an authenticator cleared meanwhile", () => {
  it("an MFA clear committed while the verify waited refuses the code", async () => {
    const u = await mkUser(`totp-race-${randomBytes(2).toString("hex")}`);
    const enrolled = await as(u.s, "POST", "/auth/totp/enroll");
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const secret = enrolled.json().secret as string;
    expect((await as(u.s, "POST", "/auth/totp/activate", { code: totpCode(secret, totpStep() - 1) })).statusCode).toBe(200);
    const action = { kind: "owner_change", body: { objectType: "mcp_server", objectId: "00000000-0000-4000-8000-0000000b4c05", ownerUserId: null } };
    const o = await as(u.s, "POST", "/v1/auth/step-up/options", { action });
    expect(o.statusCode, o.body).toBe(200);
    const res = await raced(
      (tx) => tx.update(usersTable).set({ totpEnabled: false, totpSecretCiphertext: null, totpLastUsedStep: null }).where(eq(usersTable.id, u.id)),
      () => as(u.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "totp", code: totpCode(secret, totpStep()) }),
    );
    expect(res.statusCode, res.body).toBe(401);
  });
});

describe("F26: a pending approval is reused only while its queue-time pool can reach its quorum", () => {
  it("an identical call queues afresh when the old row's pool shrank below quorum", async () => {
    const [r5] = await db.insert(roles).values({ name: `b4c5 pool ${RUN}` }).returning({ id: roles.id });
    await db.insert(roleAssignments).values({ userId: P.b.id, roleId: r5!.id });
    const tool = nextTool();
    await rule(tool, { approverRoleId: r5!.id, quorum: 2 });
    const args = { text: "pool shrank" };
    const first = await queued(tool, args);
    // B leaves the role; a replacement joins after the call was queued (never counts for the old row)
    await db.delete(roleAssignments).where(and(eq(roleAssignments.userId, P.b.id), eq(roleAssignments.roleId, r5!.id)));
    const c = await person("replacement");
    await db.insert(roleAssignments).values({ userId: c.id, roleId: r5!.id });
    const second = await queued(tool, args);
    expect(second).not.toBe(first);
    expect((await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, first)))[0]!.s).toBe("superseded");
  });
});

describe("F27: an SSO provider's default role never mints identities into an approver pool silently", () => {
  it("naming an approver role as a provider's default role needs settings_relax", async () => {
    const r = await as(P.adm.s, "POST", "/v1/auth/oidc-providers", {
      name: `b4c5-oidc-${RUN}`,
      issuerUrl: "https://idp.b4c5.example.com",
      clientId: "b4c5",
      clientSecret: "b4c5-secret",
      defaultRoleId: roleId,
    });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  });

  it("a JIT login withholds a default role that is an approver role, and grants one that is not", async () => {
    const mod = (await import("./approval-pool.js")) as Record<string, unknown>;
    expect(typeof mod.grantJitDefaultRole, "grantJitDefaultRole").toBe("function");
    const grant = mod.grantJitDefaultRole as (db: Db, userId: string, roleId: string) => Promise<string>;
    const u = await mkUser(`jit-${randomBytes(2).toString("hex")}`);
    expect(await grant(db, u.id, roleId)).toBe("withheld");
    expect(await db.select().from(roleAssignments).where(and(eq(roleAssignments.userId, u.id), eq(roleAssignments.roleId, roleId)))).toHaveLength(0);
    const [plainRole] = await db.insert(roles).values({ name: `b4c5 plain ${RUN}` }).returning({ id: roles.id });
    expect(await grant(db, u.id, plainRole!.id)).toBe("granted");
  });
});

describe("F28: the queue-time snapshot uses the rule as served (active version applied), not the base row", () => {
  it("an active version at quorum 2 queues the call at quorum 2 even when the base row says 1", async () => {
    const tool = nextTool();
    const ruleId = await rule(tool);
    const mint = await asSteppedUpAdmin("POST", `/v1/config-versions/approval_rule/${ruleId}`, {
      body: { toolName: tool, writeOnly: false, approverUserId: P.a.id, deployMode: null, quorum: 2, approverRoleId: roleId },
      activate: true,
    });
    expect(mint.statusCode, mint.body).toBe(201);
    // the base row is only a read-model; the kernel serves the active version. Drift it.
    await db.update(approvalRules).set({ quorum: 1 }).where(eq(approvalRules.id, ruleId));
    const id = await queued(tool, { text: "served quorum" });
    expect((await db.select({ q: approvals.quorum }).from(approvals).where(eq(approvals.id, id)))[0]!.q).toBe(2);
  });
});

describe("F29: delegation writes serialise with consumption through the policy epoch", () => {
  it("creating a delegation advances the governance policy epoch", async () => {
    const epoch = async () => Number((await db.execute<{ epoch: number }>(sql`select epoch from governance_policy_epoch`)).rows[0]!.epoch);
    const before = await epoch();
    const link = await delegate(P.b.id, P.adm.id);
    try {
      expect(await epoch()).toBeGreaterThan(before);
    } finally {
      await db.delete(approvalDelegations).where(eq(approvalDelegations.id, link));
    }
  });
});

describe("F30: in passkey mode only principals who can sign count towards satisfiability", () => {
  it("a quorum-2 pool with one passkey holder is refused at queue time", async () => {
    const [r6] = await db.insert(roles).values({ name: `b4c5 nokey ${RUN}` }).returning({ id: roles.id });
    const noKey = await mkUser(`nokey-${randomBytes(2).toString("hex")}`);
    await db.insert(roleAssignments).values({ userId: noKey.id, roleId: r6!.id, createdAt: new Date(Date.now() - 60_000) });
    const tool = nextTool();
    await rule(tool, { approverRoleId: r6!.id, quorum: 2 });
    const out = await call(tool, { text: "one signer" });
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("approval-quorum-unsatisfiable");
  });
});

describe("F31: ending a live delegation needs settings_relax", () => {
  it("DELETE /v1/delegations/:id on an active link is refused without a step-up", async () => {
    const link = await delegate(P.a.id, P.adm.id);
    const del = await as(P.adm.s, "DELETE", `/v1/delegations/${link}`);
    expect(del.statusCode, del.body).toBe(403);
    expect(del.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect(await db.select().from(approvalDelegations).where(eq(approvalDelegations.id, link))).toHaveLength(1);
    const ok = await as(P.adm.s, "DELETE", `/v1/delegations/${link}`, undefined, { [STEP_UP_HEADER]: await grantFor(P.adm, del.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

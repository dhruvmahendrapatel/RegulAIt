/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, round 4, each proven
 * red on the pre-fix head (d28ab09) and green after:
 *
 *  F15  the execution recheck refuses an approval whose call now needs a higher
 *       quorum than it was approved under (the call became sensitive).
 *  F16  reactivating an account that still holds admin, an approver role or a
 *       named approver seat needs a settings_relax step-up.
 *  F17  re-enabling a disabled agent needs a settings_relax step-up.
 *  F18  a same-second OIDC re-login is stored (migration 0171 relaxes the CHECK
 *       to second precision), driven through the database.
 *  Class C — every route that lifts a stop or a quarantine asks for the step-up
 *       a relaxation asks for.
 *
 * Runs on its OWN scratch database (prefix `b4c4_`), dropped in afterAll, so
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
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4c4_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c4-rv-boot-${RUN}`;
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

const TOOLS = Array.from({ length: 16 }, (_, i) => `b4c4_t${i}_${RUN}`);
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
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c4-${label}-${RUN}@example.com`, displayName: `b4c ${label}`, isAdmin });
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

describe("F15: a call that became sensitive after its consent needs the sensitive quorum", () => {
  it("the caller joins a sensitive project after a quorum-1 approval: the recheck refuses it (quorum_raised)", async () => {
    const tool = nextTool();
    await rule(tool);
    const args = { text: "became sensitive" };
    const id = await queued(tool, args);
    expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.quorum).toBe(1);
    const ok = await signAndDecide(P.a, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("approved");
    const [profile] = await db.insert(complianceProfiles).values({ tag: `b4c4-sens-${RUN}`, piiMode: "block", mcpDefaultMode: "read_write" }).returning();
    const [project] = await db.insert(projects).values({ name: `b4c4-sens-${RUN}`, classifications: [profile!.tag] }).returning({ id: projects.id });
    await db.insert(projectMembers).values({ projectId: project!.id, userId: P.caller.id, role: "contributor" });
    try {
      const before = upstreamHits.tool;
      const out = await call(tool, args);
      expect(upstreamHits.tool - before, JSON.stringify(out)).toBe(0);
      expect(out.kind, JSON.stringify(out)).toBe("denied");
      const [audit] = await db
        .select({ detail: auditLog.detail })
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, APPROVAL_SIGNATURE_RECHECK_FAILED_RULE), sql`${auditLog.detail}->>'approvalId' = ${id}`));
      expect((audit!.detail as { why: string }).why).toBe("quorum_raised");
    } finally {
      await db.delete(projectMembers).where(and(eq(projectMembers.projectId, project!.id), eq(projectMembers.userId, P.caller.id)));
    }
  });
});

describe("F16: reactivating an account that still holds privilege needs a settings_relax step-up", () => {
  it("an admin account", async () => {
    const u = await mkUser(`react-adm-${randomBytes(2).toString("hex")}`);
    await db.update(usersTable).set({ isAdmin: true, disabledAt: new Date() }).where(eq(usersTable.id, u.id));
    const disabled = async () => expect((await db.select({ d: usersTable.disabledAt }).from(usersTable).where(eq(usersTable.id, u.id)))[0]!.d).not.toBeNull();
    await provesRelax("POST", `/v1/users/${u.id}/reactivate`, {}, disabled);
  });

  it("an approver-role holder", async () => {
    const u = await mkUser(`react-role-${randomBytes(2).toString("hex")}`);
    await db.insert(roleAssignments).values({ userId: u.id, roleId });
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, u.id));
    const disabled = async () => expect((await db.select({ d: usersTable.disabledAt }).from(usersTable).where(eq(usersTable.id, u.id)))[0]!.d).not.toBeNull();
    await provesRelax("POST", `/v1/users/${u.id}/reactivate`, {}, disabled);
  });

  it("control: an account with no privilege is reactivated without one", async () => {
    const u = await mkUser(`react-plain-${randomBytes(2).toString("hex")}`);
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, u.id));
    const r = await as(P.adm.s, "POST", `/v1/users/${u.id}/reactivate`, {});
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe("F17 / Class C: lifting a stop needs the step-up a relaxation needs", () => {
  it("re-enabling a disabled agent", async () => {
    const [a] = await db.insert(agents).values({ name: `b4c4-en-${RUN}`, provider: "mock", tier: 1, enabled: false }).returning({ id: agents.id });
    await provesRelax("POST", `/v1/agents/${a!.id}/enabled`, { enabled: true }, async () =>
      expect((await db.select({ e: agents.enabled }).from(agents).where(eq(agents.id, a!.id)))[0]!.e).toBe(false),
    );
    // disabling needs none
    expect((await as(P.adm.s, "POST", `/v1/agents/${a!.id}/enabled`, { enabled: false })).statusCode).toBe(200);
  });

  it("re-enabling a custom model provider", async () => {
    await db.update(orgSettings).set({ customModelProvidersEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const [p] = await db
        .insert(customModelProviders)
        .values({ name: `b4c4-cmp-${RUN}`, wireProtocol: "openai_chat", baseUrl: `https://cmp-${RUN}.example.com/v1`, enabled: false, lastTestedAt: new Date() })
        .returning({ id: customModelProviders.id });
      await provesRelax("POST", `/v1/custom-model-providers/${p!.id}/enabled`, { enabled: true }, async () =>
        expect((await db.select({ e: customModelProviders.enabled }).from(customModelProviders).where(eq(customModelProviders.id, p!.id)))[0]!.e).toBe(false),
      );
    } finally {
      await db.update(orgSettings).set({ customModelProvidersEnabled: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });

  it("clearing a held MCP server out of admission quarantine", async () => {
    const [srv] = await db
      .insert(mcpServers)
      .values({ name: `b4c4-held-${RUN}`, url: `https://held-${RUN}.example.com/mcp`, admissionState: "held", admissionFindings: [] })
      .returning({ id: mcpServers.id });
    await provesRelax("POST", `/v1/servers/${srv!.id}/admission/clear`, { reason: "b4c4 reviewed by hand" }, async () =>
      expect((await db.select({ s: mcpServers.admissionState }).from(mcpServers).where(eq(mcpServers.id, srv!.id)))[0]!.s).toBe("held"),
    );
  });

  it("overriding the release quarantine of an MCP server", async () => {
    const [srv] = await db.insert(mcpServers).values({ name: `b4c4-rel-${RUN}`, url: `https://rel-${RUN}.example.com/mcp` }).returning({ id: mcpServers.id });
    await provesRelax(
      "POST",
      "/v1/release-quarantine/override",
      { kind: "mcp_server", id: srv!.id, digest: "registration", reason: "b4c4 reviewed by hand" },
      async () => expect(await db.select().from(releaseOverrides).where(eq(releaseOverrides.subjectId, srv!.id))).toHaveLength(0),
      201,
    );
  });

  it("disabling and deleting a SoD rule", async () => {
    const [rule1] = await db.insert(sodRules).values({ name: `b4c4-sod-${RUN}`, reason: "b4c4" }).returning({ id: sodRules.id });
    await provesRelax("PATCH", `/v1/sod/rules/${rule1!.id}`, { enabled: false }, async () =>
      expect((await db.select({ e: sodRules.enabled }).from(sodRules).where(eq(sodRules.id, rule1!.id)))[0]!.e).toBe(true),
    );
    await provesRelax("DELETE", `/v1/sod/rules/${rule1!.id}`, undefined, async () =>
      expect(await db.select().from(sodRules).where(eq(sodRules.id, rule1!.id))).toHaveLength(1),
    );
  });

  it("deactivating and deleting an ABAC policy", async () => {
    const [pol] = await db.insert(abacPolicies).values({ name: `b4c4-abac-${RUN}`, enabled: true }).returning({ id: abacPolicies.id });
    await provesRelax("POST", `/v1/abac/policies/${pol!.id}/deactivate`, {}, async () =>
      expect((await db.select({ e: abacPolicies.enabled }).from(abacPolicies).where(eq(abacPolicies.id, pol!.id)))[0]!.e).toBe(true),
    );
    await provesRelax("DELETE", `/v1/abac/policies/${pol!.id}`, undefined, async () =>
      expect(await db.select().from(abacPolicies).where(eq(abacPolicies.id, pol!.id))).toHaveLength(1),
    );
  });
});

describe("F18: a same-second OIDC re-login completes, through the database", () => {
  it("finishSsoReauth stores the verification for a whole-second auth_time in the request's second", async () => {
    const [prov] = await db
      .insert(oidcProviders)
      .values({ name: `b4c4-oidc-${RUN}`, issuerUrl: "https://idp.example.com", clientId: "b4c4", clientSecretCiphertext: "not-a-secret" })
      .returning({ id: oidcProviders.id });
    const digest = "a".repeat(64);
    const [ceremony] = await db
      .insert(webauthnChallenges)
      .values({ userId: P.a.id, sessionId: P.a.s.sessionId, purpose: "step_up", challenge: "A".repeat(43), actionKind: "owner_change", actionDigest: digest, expiresAt: sql`now() + interval '2 minutes'` })
      .returning({ id: webauthnChallenges.id });
    const mkRow = async (label: string) =>
      (
        await db
          .insert(ssoReauthRequests)
          .values({
            stepUpId: ceremony!.id,
            userId: P.a.id,
            sessionId: P.a.s.sessionId,
            providerKind: "oidc",
            oidcProviderId: prov!.id,
            state: `b4c4-${label}-${randomBytes(4).toString("hex")}`,
            nonce: "n",
            codeVerifier: "v",
            redirectUri: "https://gw.example.com/auth/oidc/callback",
            actionDigest: digest,
            expiresAt: sql`now() + interval '2 minutes'`,
          })
          .returning()
      )[0]!;
    const row = await mkRow("same");
    const sec = Math.floor(row.requestedAt.getTime() / 1000);
    const out = await finishSsoReauth(db, row, { linkedUserId: P.a.id, authTime: new Date(sec * 1000), providerName: "b4c4" });
    expect(out).toEqual({ ok: true });
    const [stored] = await db.select().from(ssoReauthRequests).where(eq(ssoReauthRequests.id, row.id));
    expect(stored!.verifiedAt).not.toBeNull();
    expect(stored!.authTime!.getTime()).toBe(sec * 1000);
    // an earlier second is still stale, and nothing is stored for it
    const early = await mkRow("early");
    const esec = Math.floor(early.requestedAt.getTime() / 1000);
    expect(await finishSsoReauth(db, early, { linkedUserId: P.a.id, authTime: new Date((esec - 1) * 1000), providerName: "b4c4" })).toMatchObject({ ok: false, error: "sso_reauth_stale" });
    // and the database itself refuses an earlier second
    await expect(
      db.update(ssoReauthRequests).set({ verifiedAt: sql`now()`, authTime: new Date((esec - 1) * 1000) }).where(eq(ssoReauthRequests.id, early.id)),
    ).rejects.toThrow();
  });
});

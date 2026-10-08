/**
 * Batch 4 follow-up (ADR-0186 decision 29) — automated-review findings on PR
 * #198 after its merge round, proven red on a082054 and green after:
 *
 *  F48  an IdP group never adds anyone to an approver role silently
 *       (reconciliation withholds and audits), and pointing a rule at a role
 *       that groups are mapped to is a pool widening (settings_relax).
 *  F49  a linked SSO identity is a way to step up whatever the transport: on
 *       plain HTTP an SSO-only account is refused, never admitted as "first method".
 *  F50  a passkey-backed step-up grant is unusable once its passkey is revoked
 *       (consumption predicate, two connections) and revoking ends its grants.
 *  F51  a tool-scoped approval signs the tool-scope wildcard, so its consent
 *       releases a call with other arguments; action scope stays exact.
 *  F52  editing a compliance profile so it forces less needs settings_relax.
 *
 * Runs on its OWN scratch database (prefix `b4f_`), dropped in afterAll.
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
  and,
  approvalDecisions,
  approvals,
  auditLog,
  authSessions,
  federatedIdentities,
  groupRoleMappings,
  roleAssignments,
  roles,
  samlProviders,
  stepUpGrants,
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
import { reconcileGroupRoles } from "./group-roles.js";
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
const SCRATCH_DB = `b4f_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4f-rv-boot-${RUN}`;
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

const TOOLS = Array.from({ length: 12 }, (_, i) => `b4f_t${i}_${RUN}`);
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
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4f-${label}-${randomBytes(2).toString("hex")}-${RUN}@example.com`, displayName: `b4f ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const s = await mkSession(id);
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: "b4f" });
  expect(reg.statusCode, reg.body).toBe(201);
  return { id, s, auth };
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b4f-upstream", version: "0.0.1" });
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
    reason: "b4f",
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
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4f-server-${RUN}`, url: up.url });
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


/** refused without a grant (403 settings_relax), admitted with one */
async function provesRelax(method: Method, url: string, payload: unknown, unchanged: () => Promise<void> = async () => {}) {
  const refused = await as(P.adm.s, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  await unchanged();
  const ok = await as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, refused.json().action) });
  expect(ok.statusCode, ok.body).toBeLessThan(300);
}
const mkRole = async (name: string) =>
  (await db.insert(roles).values({ name: `b4f ${name} ${randomBytes(3).toString("hex")}` }).returning({ id: roles.id }))[0]!.id;

describe("F48: IdP groups and approver roles", () => {
  it("pointing a rule at an EMPTY role that a group is mapped to widens the pool: settings_relax", async () => {
    const role = await mkRole("mapped-empty");
    await db.insert(groupRoleMappings).values({ source: "oidc", externalGroup: `g-${RUN}-1`, roleId: role });
    const r = await withKey(AUTH, "POST", "/v1/rules/approvals", { userId: P.caller.id, serverId, toolName: nextTool(), approverUserId: P.a.id });
    expect(r.statusCode, r.body).toBe(201);
    await provesRelax("PATCH", `/v1/rules/approvals/${r.json().id}`, { approverRoleId: role });
  });

  it("reconciliation withholds an approver role a group implies, and audits it", async () => {
    const role = await mkRole("approver");
    const r = await withKey(AUTH, "POST", "/v1/rules/approvals", {
      userId: P.caller.id,
      serverId,
      toolName: nextTool(),
      approverUserId: P.a.id,
      approverRoleId: role,
    });
    expect(r.statusCode, r.body).toBe(201);
    const group = `g-${RUN}-2`;
    await db.insert(groupRoleMappings).values({ source: "oidc", externalGroup: group, roleId: role });
    const member = await mkPerson("group-member");
    await reconcileGroupRoles(db, member.id, "oidc", [group], { kind: "oidc-login", actor: "b4f test" });
    expect(await db.select().from(roleAssignments).where(and(eq(roleAssignments.userId, member.id), eq(roleAssignments.roleId, role)))).toHaveLength(0);
    const [withheld] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "group-role-withheld"), eq(auditLog.objectId, member.id)));
    expect(withheld?.effect).toBe("deny");
    // control: an ordinary role is still granted
    const plain = await mkRole("plain");
    const plainGroup = `g-${RUN}-3`;
    await db.insert(groupRoleMappings).values({ source: "oidc", externalGroup: plainGroup, roleId: plain });
    await reconcileGroupRoles(db, member.id, "oidc", [group, plainGroup], { kind: "oidc-login", actor: "b4f test" });
    expect(await db.select().from(roleAssignments).where(and(eq(roleAssignments.userId, member.id), eq(roleAssignments.roleId, plain)))).toHaveLength(1);
  });
});

describe("F49: a linked SSO identity is a step-up method on plain HTTP too", () => {
  it("an SSO-only account cannot add an authenticator app or a passkey as its 'first method' over HTTP", async () => {
    const [sp] = await db
      .insert(samlProviders)
      .values({ name: `b4f-saml-${RUN}`, entityId: `https://idp.b4f-${RUN}.example`, idpSsoUrl: `https://idp.b4f-${RUN}.example/sso`, idpSigningCerts: ["unused"] })
      .returning({ id: samlProviders.id });
    const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4f-sso-${RUN}@example.com`, displayName: "b4f sso" });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    await db.insert(federatedIdentities).values({
      userId: id,
      samlProviderId: sp!.id,
      issuer: `https://idp.b4f-${RUN}.example`,
      subjectFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      subject: `b4f-sso-${RUN}`,
      linkedVia: "jit",
    });
    const s = await mkSession(id);
    const totp = await as(s, "POST", "/auth/totp/enroll", {});
    expect(totp.statusCode, totp.body).toBe(422);
    expect(totp.json().error).toBe("step_up_unavailable");
    const pk = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(pk.statusCode, pk.body).toBe(422);
    expect(pk.json().error).toBe("step_up_unavailable");
  });
});

describe("F50: a passkey-backed grant ends with its passkey", () => {
  const relax = { sessionIdleMinutes: 45 };
  it("a revocation in flight is waited for: the grant is then refused (two connections)", async () => {
    const admin2 = await mkPerson("admin-f50");
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, admin2.id));
    const refused = await as(admin2.s, "PUT", "/v1/org/settings", relax);
    expect(refused.statusCode, refused.body).toBe(403);
    const token = await grantFor(admin2, refused.json().action);
    const [grant] = await db.select({ credentialId: stepUpGrants.credentialId }).from(stepUpGrants).where(eq(stepUpGrants.userId, admin2.id));
    let res: Awaited<ReturnType<typeof as>> | undefined;
    await locker.transaction(async (tx) => {
      await tx
        .update(webauthnCredentials)
        .set({ revokedAt: sql`now()`, revokeReason: "b4f revoked while a grant is spent" })
        .where(eq(webauthnCredentials.id, grant!.credentialId!));
      void as(admin2.s, "PUT", "/v1/org/settings", relax, { [STEP_UP_HEADER]: token }).then((r) => (res = r));
      for (let i = 0; i < 250 && !res; i++) {
        const { rows } = await db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((rows[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    });
    for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
    expect(res, "the request never answered").toBeTruthy();
    expect(res!.statusCode, res!.body).not.toBe(200);
  });

  it("revoking a passkey through the route ends every grant it gave", async () => {
    const p = await mkPerson("f50-route");
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, p.id));
    // a grant minted with the passkey and left unspent, then the passkey revoked (its own step-up spends another grant)
    const refusedSettings = await as(p.s, "PUT", "/v1/org/settings", { sessionIdleMinutes: 50 });
    expect(refusedSettings.statusCode, refusedSettings.body).toBe(403);
    const outstanding = await grantFor(p, refusedSettings.json().action);
    const [cred] = await db.select({ id: webauthnCredentials.id }).from(webauthnCredentials).where(eq(webauthnCredentials.userId, p.id));
    const del = await as(p.s, "DELETE", `/v1/auth/passkeys/${cred!.id}`);
    expect(del.statusCode, del.body).toBe(403);
    const ok = await as(p.s, "DELETE", `/v1/auth/passkeys/${cred!.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(p, del.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await db
      .select({ usedAt: stepUpGrants.usedAt })
      .from(stepUpGrants)
      .where(eq(stepUpGrants.tokenHash, createHash("sha256").update(outstanding).digest("hex")));
    expect(row?.usedAt, "the outstanding grant was ended with the passkey").not.toBeNull();
  });
});

describe("F51: a tool-scoped consent releases the same tool with other arguments", () => {
  it("signed once, it releases a call with different arguments; the signature still verifies", async () => {
    const tool = nextTool();
    const approver = await mkPerson("f51-approver");
    const r = await withKey(AUTH, "POST", "/v1/rules/approvals", {
      userId: P.caller.id,
      serverId,
      toolName: tool,
      approverUserId: approver.id,
      approvalScope: "tool",
    });
    expect(r.statusCode, r.body).toBe(201);
    const out = await call(tool, { text: "first arguments" });
    expect(out.kind, JSON.stringify(out)).toBe("approval_required");
    const approvalId = (out as { approvalId: string }).approvalId;
    const o = await as(approver.s, "POST", `/v1/approvals/${approvalId}/signing-options`, { decision: "approved" });
    expect(o.statusCode, o.body).toBe(200);
    const d = await as(approver.s, "POST", `/v1/approvals/${approvalId}/decide`, {
      decision: "approved",
      reason: "b4f",
      passkey: { challengeId: o.json().challengeId, response: approver.auth.authenticate(o.json().options) },
    });
    expect(d.statusCode, d.body).toBe(200);
    const hits = upstreamHits.tool;
    const other = await call(tool, { text: "other arguments" });
    expect(other.kind, JSON.stringify(other)).toBe("allowed");
    expect(upstreamHits.tool).toBe(hits + 1);
    expect((await db.select({ s: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)))[0]!.s).toBe("consumed");
  });
});

describe("F52: a compliance-profile edit that makes a framework force less needs settings_relax", () => {
  it("PII block -> log, and a shorter retention; tightening asks for nothing", async () => {
    const tag = `b4f-fw-${RUN}`;
    const created = await as(P.adm.s, "POST", "/v1/compliance/profiles", { tag, piiMode: "warn", auditRetentionDays: 400 });
    expect(created.statusCode, created.body).toBe(201);
    const tighter = await as(P.adm.s, "POST", "/v1/compliance/profiles", { tag, piiMode: "block", auditRetentionDays: 400 });
    expect(tighter.statusCode, tighter.body).toBe(201);
    await provesRelax("POST", "/v1/compliance/profiles", { tag, piiMode: "log", auditRetentionDays: 400 });
    await provesRelax("POST", "/v1/compliance/profiles", { tag, piiMode: "log", auditRetentionDays: 30 });
  });
});

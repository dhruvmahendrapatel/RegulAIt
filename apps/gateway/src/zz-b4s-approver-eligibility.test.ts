/**
 * B4S-02 / B4S-09 (ADR-0186 A) — dual control must not be satisfiable by
 * principals or links created AFTER the call was queued.
 *
 * At decide (and signing-options), a principal counts only if: (a) their
 * account was created before the approval's `requested_at`; (b) in passkey
 * mode, the passkey that signs was enrolled before it; (c) the role membership
 * that makes them eligible was granted before it — or they are the approver
 * named when the call was queued (a routing re-point, a claim or an SLA
 * reassignment afterwards gives no named-approver standing); (d) a delegation
 * they act through was created before it; (e) they are active now. The
 * owner-principle step-ups: every write that can pad an approver pool or take
 * over an approver's identity (an approver-role assignment, a group mapping to
 * one, an admin grant, a delegation, another user's initial password or MFA
 * clear, a routing rule, an SLA escalation) needs `settings_relax`.
 *
 * Tool calls go through the real governed path against a local MCP double that
 * counts tool invocations. Runs on its OWN scratch database (prefix `b4s1_`),
 * dropped in afterAll, so the append-only decision rows leave nothing behind (M-068).
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
  approvalDelegations,
  approvals,
  auditLog,
  authSessions,
  createDb,
  eq,
  ORG_SETTINGS_ID,
  roleAssignments,
  roles,
  runMigrations,
  sql,
  users as usersTable,
  type Db,
} from "@regulait/db";
import { APPROVAL_SIGNATURE_RECHECK_FAILED_RULE, STEP_UP_HEADER } from "@regulait/shared";
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
const SCRATCH_DB = `b4s1_el_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4s1-el-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let roleId: string;
const upstreamHits = { tool: 0 };

type Session = { token: string; sessionId: string };
type Person = { id: string; key: { authorization: string }; s: Session; auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "b" | "outsider" | "adm", Person>;

const TOOLS = Array.from({ length: 24 }, (_, i) => `b4s1_t${i}_${RUN}`);
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

/** enrol a passkey; a second one needs a passkey_manage step-up proven with the first (`existing`) */
async function enrol(s: Session, existing?: SoftAuthenticator): Promise<SoftAuthenticator> {
  let headers: Record<string, string> = {};
  if (existing) {
    const asked = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(asked.statusCode, asked.body).toBe(403);
    const o = await as(s, "POST", "/v1/auth/step-up/options", { action: asked.json().action });
    expect(o.statusCode, o.body).toBe(200);
    const v = await as(s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: existing.authenticate(o.json().passkey.options) });
    expect(v.statusCode, v.body).toBe(200);
    headers = { [STEP_UP_HEADER]: v.json().stepUpToken };
  }
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {}, headers);
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: `b4s1-${randomBytes(2).toString("hex")}` });
  expect(reg.statusCode, reg.body).toBe(201);
  return auth;
}

async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4s1-${label}-${RUN}@example.com`, displayName: `b4s1 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await withKey(AUTH, "POST", `/v1/users/${id}/keys`, { name: "b4s1" });
  expect(key.statusCode, key.body).toBe(201);
  const s = await mkSession(id);
  return { id, key: { authorization: `Bearer ${key.json().token}` }, s, auth: await enrol(s) };
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b4s1-upstream", version: "0.0.1" });
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
}

const call = (tool: string, args: Record<string, unknown>) =>
  executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: args });

async function queued(tool: string, args: Record<string, unknown>): Promise<string> {
  const out = await call(tool, args);
  expect(out.kind, JSON.stringify(out)).toBe("approval_required");
  return (out as { approvalId: string }).approvalId;
}

const row = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
const signingOptions = (p: { s: Session }, approvalId: string) =>
  as(p.s, "POST", `/v1/approvals/${approvalId}/signing-options`, { decision: "approved" });
const decide = (s: Session, approvalId: string, passkey?: { challengeId: string; response: unknown }, headers: Record<string, string> = {}) =>
  as(s, "POST", `/v1/approvals/${approvalId}/decide`, { decision: "approved", reason: "b4s1", ...(passkey ? { passkey } : {}) }, headers);

async function signAndDecide(p: { s: Session; auth: SoftAuthenticator }, approvalId: string, signer: SoftAuthenticator = p.auth) {
  const o = await signingOptions(p, approvalId);
  expect(o.statusCode, o.body).toBe(200);
  return decide(p.s, approvalId, { challengeId: o.json().challengeId, response: signer.authenticate(o.json().options) });
}

/** a fresh account (an old one, for the "existed before" cases) with a session and a passkey */
const person = (label: string) => mkPerson(`${label}-${randomBytes(2).toString("hex")}`);
const addToRole = (userId: string) => db.insert(roleAssignments).values({ userId, roleId });
const delegate = (fromUserId: string, toUserId: string) =>
  db
    .insert(approvalDelegations)
    .values({ fromUserId, toUserId, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000), reason: "b4s1" })
    .returning({ id: approvalDelegations.id });

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p.s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: p.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** B4S-06: a protected write once an admin here can step up — the admin's session, stepped up the real way */
async function asSteppedUpAdmin(method: Method, url: string, payload: unknown) {
  const first = await as(P.adm.s, method, url, payload);
  if (first.statusCode !== 403 || first.json().error !== "step_up_required") return first;
  return as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, first.json().action) });
}

/** refused from an API key (no methods) and from the admin's session without a grant, with `body`; admitted with a grant for it */
async function provesStepUp(method: Method, url: string, payload: unknown, body: Record<string, unknown>, okStatus = 200) {
  const key = await withKey(P.adm.key, method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await as(P.adm.s, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(refused.json().action).toEqual({ kind: "settings_relax", body });
  const token = await grantFor(P.adm, refused.json().action);
  const ok = await as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(okStatus);
  return ok;
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
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required', approval_delegation_enabled = true,
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4s1-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  P.caller = await mkPerson("caller");
  P.a = await mkPerson("approver-a");
  P.b = await mkPerson("approver-b");
  P.outsider = await mkPerson("outsider");
  P.adm = await mkPerson("admin", true);
  const [role] = await db.insert(roles).values({ name: `b4s1 approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  await addToRole(P.b.id);
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
    async () => db?.$client.end(),
    async () => dropScratchDatabase(admin, SCRATCH_DB),
    async () => admin?.$client.end(),
  ]);
});

describe("B4S-02: at decide, only principals and links that existed when the call was queued count", () => {
  it("(c) a role membership granted after the call was queued does not count; one granted before does", async () => {
    const tool = nextTool();
    await rule(tool);
    const late = await person("late-member");
    const id = await queued(tool, { text: "late member" });
    await addToRole(late.id);
    const refused = await signingOptions(late, id);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe("not_the_named_approver");
    expect((await decide(late.s, id)).json().error).toBe("not_the_named_approver");
    // control: B held the role before the call was queued
    const ok = await signAndDecide(P.b, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("approved");
  });

  it("(a) an account created after the call was queued never counts, even in the approver role", async () => {
    const tool = nextTool();
    await rule(tool);
    const id = await queued(tool, { text: "new account" });
    const fresh = await person("fresh");
    // backdate the role assignment so only the account's own age refuses it
    const [ra] = await db.insert(roleAssignments).values({ userId: fresh.id, roleId, createdAt: new Date(Date.now() - 86_400_000) }).returning();
    expect(ra).toBeTruthy();
    const refused = await signingOptions(fresh, id);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error).toBe("approver_not_eligible");
    expect((await row(id)).status).toBe("pending");
  });

  it("(b) only a passkey enrolled before the call was queued may sign it", async () => {
    const tool = nextTool();
    await rule(tool);
    const m = await person("passkey-late");
    await addToRole(m.id);
    // a member with no passkey at queue time enrols one afterwards: nothing may sign
    const u2 = await withKey(AUTH, "POST", "/v1/users", { email: `b4s1-nokey-${RUN}@example.com`, displayName: "b4s1 nokey" });
    const noKey = { id: u2.json().id as string, s: await mkSession(u2.json().id) };
    await addToRole(noKey.id);
    const id = await queued(tool, { text: "late passkey" });
    const lateAuth = await enrol(noKey.s);
    const none = await signingOptions(noKey, id);
    expect(none.statusCode, none.body).toBe(403);
    expect(none.json().error).toBe("passkey_enrolled_after_request");
    // a member who had one then, signing with one enrolled since: refused at decide
    const newer = await enrol(m.s, m.auth);
    const o = await signingOptions(m, id);
    expect(o.statusCode, o.body).toBe(200);
    const viaNewer = await decide(m.s, id, { challengeId: o.json().challengeId, response: newer.authenticate(o.json().options) });
    expect(viaNewer.statusCode, viaNewer.body).toBe(403);
    expect(viaNewer.json().error).toBe("passkey_enrolled_after_request");
    expect(lateAuth).toBeTruthy();
    // control: the passkey they already had signs
    const ok = await signAndDecide(m, id);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("(d) a delegation created after the call was queued lets nobody decide; one created before does", async () => {
    const tool = nextTool();
    await rule(tool);
    const before = await person("delegate-before");
    const after = await person("delegate-after");
    const [d1] = await delegate(P.a.id, before.id);
    const id = await queued(tool, { text: "delegation" });
    const [d2] = await delegate(P.a.id, after.id);
    try {
      const refused = await signingOptions(after, id);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("not_the_named_approver");
      const ok = await signAndDecide(before, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ status: "approved", onBehalfOf: P.a.id });
    } finally {
      await db.delete(approvalDelegations).where(eq(approvalDelegations.id, d1!.id));
      await db.delete(approvalDelegations).where(eq(approvalDelegations.id, d2!.id));
    }
  });

  it("(e) a member deactivated since does not count", async () => {
    const tool = nextTool();
    await rule(tool);
    const gone = await person("gone");
    await addToRole(gone.id);
    const id = await queued(tool, { text: "deactivated" });
    await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, gone.id));
    const refused = await signingOptions(gone, id);
    expect([401, 403]).toContain(refused.statusCode);
    expect((await row(id)).status).toBe("pending");
  });

  it("a routing re-point after queue time gives no named-approver standing; the approver named then keeps it", async () => {
    const tool = nextTool();
    await rule(tool);
    const id = await queued(tool, { text: "re-pointed" });
    // a routing rule written after the call was queued points matching approvals at the outsider
    const r = await asSteppedUpAdmin("POST", "/v1/approvals/assignment-rules", {
      name: `b4s1 route ${RUN}`,
      objectType: "mcp_tool",
      assigneeKind: "user",
      assigneeId: P.outsider.id,
    });
    expect(r.statusCode, r.body).toBe(201);
    try {
      const first = await decide(P.outsider.s, id);
      expect(first.statusCode, first.body).toBe(403);
      expect((await row(id)).approverUserId).toBe(P.outsider.id); // the routing really re-pointed the row
      const refused = await signingOptions(P.outsider, id);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("not_the_named_approver");
      // A, named when the call was queued, still decides it
      const ok = await signAndDecide(P.a, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().status).toBe("approved");
    } finally {
      await withKey(AUTH, "DELETE", `/v1/approvals/assignment-rules/${r.json().rule.id}`);
    }
  });
});

describe("B4S-02: the writes that can pad an approver pool need settings_relax (owner principle)", () => {
  it("assigning a user to an approver role needs it, bound to the user and role; any other role does not", async () => {
    const u = await person("assignee");
    await provesStepUp("POST", `/v1/users/${u.id}/roles`, { roleId }, { userId: u.id, values: { approverRoleId: roleId } }, 201);
    const [plain] = await db.insert(roles).values({ name: `b4s1 plain ${RUN}` }).returning({ id: roles.id });
    const other = await as(P.adm.s, "POST", `/v1/users/${u.id}/roles`, { roleId: plain!.id });
    expect(other.statusCode, other.body).toBe(201);
  });

  it("mapping a group to an approver role needs it", async () => {
    const body = { source: "oidc", externalGroup: `b4s1-group-${RUN}`, roleId };
    await provesStepUp("POST", "/v1/group-role-mappings", body, { values: { approverRoleGroup: body } }, 201);
  });

  it("granting admin needs it; a demotion does not", async () => {
    const u = await person("promoted");
    await provesStepUp("POST", `/v1/users/${u.id}/admin`, { isAdmin: true }, { userId: u.id, values: { isAdmin: true } });
    const demote = await as(P.adm.s, "POST", `/v1/users/${u.id}/admin`, { isAdmin: false });
    expect(demote.statusCode, demote.body).toBe(200);
  });

  it("creating an account that is already an admin needs it, bound to the email; a member account does not", async () => {
    const email = `b4s3-new-admin-${randomBytes(2).toString("hex")}-${RUN}@example.com`;
    const created = await provesStepUp("POST", "/v1/users", { email, displayName: "b4s3 new admin", isAdmin: true }, { email, values: { isAdmin: true } }, 201);
    expect(created.json()).toMatchObject({ email, isAdmin: true });
    // the bootstrap credential is past first-admin setup here (P.adm has a passkey), so it is refused too
    const boot = await withKey(AUTH, "POST", "/v1/users", { email: `x-${email}`, displayName: "b4s3 boot admin", isAdmin: true });
    expect(boot.statusCode, boot.body).toBe(403);
    expect(boot.json()).toMatchObject({ error: "step_up_required", credential: "bootstrap" });
    // a grant made for one email is refused for another
    const other = `b4s3-other-${randomBytes(2).toString("hex")}-${RUN}@example.com`;
    const token = await grantFor(P.adm, { kind: "settings_relax", body: { email, values: { isAdmin: true } } });
    const swapped = await as(P.adm.s, "POST", "/v1/users", { email: other, displayName: "b4s3 swapped", isAdmin: true }, { [STEP_UP_HEADER]: token });
    expect(swapped.statusCode, swapped.body).toBe(403);
    expect(swapped.json()).toMatchObject({ error: "step_up_required" });
    const member = await as(P.adm.s, "POST", "/v1/users", { email: other, displayName: "b4s3 member", isAdmin: false });
    expect(member.statusCode, member.body).toBe(201);
    expect(member.json().isAdmin).toBe(false);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(usersTable).where(eq(usersTable.email, `x-${email}`)))[0]!.n).toBe(0);
  });

  it("creating a delegation needs it, bound to who, for whom and when", async () => {
    const u = await person("delegate-route");
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await provesStepUp(
      "POST",
      "/v1/delegations",
      { fromUserId: P.b.id, toUserId: u.id, startsAt, endsAt },
      { values: { delegation: { fromUserId: P.b.id, toUserId: u.id, startsAt, endsAt } } },
      201,
    );
    await db.delete(approvalDelegations).where(eq(approvalDelegations.id, ok.json().id));
  });

  it("issuing another user's password and clearing another user's MFA need it", async () => {
    const u = await person("reset");
    await provesStepUp("POST", `/v1/users/${u.id}/set-initial-password`, {}, { userId: u.id, values: { password: "issued" } });
    await db.update(usersTable).set({ totpEnabled: true, totpSecretCiphertext: "b4s1-synthetic" }).where(eq(usersTable.id, u.id));
    await provesStepUp("POST", `/v1/users/${u.id}/mfa/clear`, { reason: "b4s1 lost device" }, { userId: u.id, values: { mfa: "cleared" } });
  });

  it("a routing rule and an SLA escalation that hand approvals to someone else need it; a notify-only SLA does not", async () => {
    const routing = { name: `b4s1 su route ${RUN}`, objectType: "b4s1_none", assigneeKind: "user", assigneeId: P.outsider.id };
    const created = await provesStepUp(
      "POST",
      "/v1/approvals/assignment-rules",
      routing,
      {
        values: {
          approvalRouting: {
            assigneeKind: "user",
            assigneeId: P.outsider.id,
            objectType: "b4s1_none",
            projectId: null,
            dataSensitivity: null,
            stagePattern: null,
            templateId: null,
            quorum: 1,
            enabled: true,
          },
        },
      },
      201,
    );
    await withKey(AUTH, "DELETE", `/v1/approvals/assignment-rules/${created.json().rule.id}`);
    const sla = { name: `b4s1 sla ${RUN}`, warnAfterMinutes: 5, breachAfterMinutes: 10, escalateAction: "reassign", escalateToKind: "user", escalateToId: P.outsider.id };
    await provesStepUp(
      "POST",
      "/v1/approvals/sla-policies",
      sla,
      { values: { approvalSlaEscalation: { escalateAction: "reassign", escalateToKind: "user", escalateToId: P.outsider.id } } },
      201,
    );
    const notify = await as(P.adm.s, "POST", "/v1/approvals/sla-policies", { name: `b4s1 notify ${RUN}`, warnAfterMinutes: 5, breachAfterMinutes: 10, escalateAction: "notify_only" });
    expect(notify.statusCode, notify.body).toBe(201);
  });
});

describe("B4S-09: at execution, every approving decider must still be eligible", () => {
  /** queue, approve with `p` (signed), then break `p`'s eligibility with `breakIt` and run the call */
  async function approvedThenBroken(p: Person, breakIt: () => Promise<unknown>, approver: { s: Session; auth: SoftAuthenticator } = p) {
    const tool = nextTool();
    await rule(tool);
    const args = { text: `recheck ${tool}` };
    const id = await queued(tool, args);
    const ok = await signAndDecide(approver, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("approved");
    await breakIt();
    const before = upstreamHits.tool;
    const out = await call(tool, args);
    return { id, out, ran: upstreamHits.tool - before };
  }

  async function expectRefused(r: { id: string; out: unknown; ran: number }, why: string) {
    expect(r.ran).toBe(0);
    expect((r.out as { kind: string }).kind, JSON.stringify(r.out)).toBe("denied");
    expect((r.out as { decision: { ruleId: string } }).decision.ruleId).toBe(APPROVAL_SIGNATURE_RECHECK_FAILED_RULE);
    expect((await row(r.id)).status).toBe("superseded");
    const [audit] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, APPROVAL_SIGNATURE_RECHECK_FAILED_RULE), sql`${auditLog.detail}->>'approvalId' = ${r.id}`));
    expect((audit!.detail as { why: string }).why).toBe(why);
  }

  it("control: an approval whose decider is still eligible runs once", async () => {
    const m = await person("still-eligible");
    await addToRole(m.id);
    const r = await approvedThenBroken(m, async () => undefined);
    expect(r.ran).toBe(1);
    expect((r.out as { kind: string }).kind).toBe("allowed");
  });

  it("a decider deactivated after approving: refused, superseded, audited, nothing runs", async () => {
    const m = await person("deactivated-after");
    await addToRole(m.id);
    await expectRefused(
      await approvedThenBroken(m, () => db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, m.id))),
      "decider_ineligible",
    );
  });

  it("a principal removed from the approver role after approving: refused", async () => {
    const m = await person("removed-after");
    await addToRole(m.id);
    await expectRefused(
      await approvedThenBroken(m, () => db.delete(roleAssignments).where(and(eq(roleAssignments.userId, m.id), eq(roleAssignments.roleId, roleId)))),
      "principal_ineligible",
    );
  });

  it("a delegate whose delegation ended after they approved on the approver's behalf: refused", async () => {
    const del = await person("delegate-ended");
    const [link] = await delegate(P.a.id, del.id);
    await expectRefused(
      await approvedThenBroken(P.a, () => db.delete(approvalDelegations).where(eq(approvalDelegations.id, link!.id)), del),
      "delegation_ineligible",
    );
  });

  it("in step_up mode too: a decider deactivated after approving is refused", async () => {
    await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'step_up' WHERE id = ${ORG_SETTINGS_ID}`);
    try {
      const m = await person("step-up-mode");
      await addToRole(m.id);
      const tool = nextTool();
      await rule(tool);
      const args = { text: "step-up recheck" };
      const id = await queued(tool, args);
      expect((await row(id)).signatureMode).toBe("step_up");
      const refused = await decide(m.s, id);
      expect(refused.statusCode, refused.body).toBe(403);
      const o = await as(m.s, "POST", "/v1/auth/step-up/options", { action: refused.json().action });
      const v = await as(m.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: m.auth.authenticate(o.json().passkey.options) });
      expect(v.statusCode, v.body).toBe(200);
      const ok = await decide(m.s, id, undefined, { [STEP_UP_HEADER]: v.json().stepUpToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().status).toBe("approved");
      await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, m.id));
      const before = upstreamHits.tool;
      const out = await call(tool, args);
      await expectRefused({ id, out, ran: upstreamHits.tool - before }, "decider_ineligible");
    } finally {
      await db.execute(sql`UPDATE org_settings SET approval_signature_mode = 'passkey' WHERE id = ${ORG_SETTINGS_ID}`);
    }
  });
});

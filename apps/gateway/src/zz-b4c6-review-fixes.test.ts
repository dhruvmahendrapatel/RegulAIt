/**
 * Batch 4 (ADR-0186) — automated-review fixes on PR #198, round 6, proven red
 * on the pre-fix head (bff14bf) and green after:
 *
 *  F32  an authenticator app is a way to step up, so adding one is admitted by
 *       the passkey rule (`admitAuthenticatorEnrolment`): passkey_manage once a
 *       method exists, else a fresh human sign-in; activation is bound to the
 *       enrolling session and secret, and a first-method ticket re-checks under
 *       the user's row lock. The sweep adds: linking an SSO identity by proof
 *       to an account that holds a passkey needs an administrator.
 *  F33  in passkey mode a pool member counts as signable only by the decide
 *       path's own rule (their own passkey, or a direct delegate's), never by
 *       anyone else in their delegation component.
 *  F34  a first-passkey completion decides "the account still has no way to step
 *       up" — SSO included — under the user's row lock, never on a read before it.
 *  F35  an org setting is relaxed when looser than the strict default OR than
 *       the value stored now (an org that tightened beyond the default).
 *  F36  a guardrail mode below the mode in force now is a relaxation (org and
 *       override), and removing an override stricter than the org mode is one.
 *  F37  turning delegation off while a delegation is live needs settings_relax.
 *  F38  "the viewer decided it" is a correlated EXISTS in the capped queue
 *       query, never an IN list of every decision the viewer ever made.
 *
 * Runs on its OWN scratch database (prefix `b4c6_`), dropped in afterAll, so
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
  approvalDecisions,
  approvals,
  approvalDelegations,
  authSessions,
  createDb,
  eq,
  federatedIdentities,
  federatedLinkRequests,
  ORG_SETTINGS_ID,
  roleAssignments,
  roles,
  runMigrations,
  samlProviders,
  sql,
  users as usersTable,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER, STRICT_IDENTITY_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { LINK_COOKIE, raiseLinkRequest } from "./federated-identity.js";
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
const SCRATCH_DB = `b4c6_rv_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4c6-rv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "a".repeat(64);
const PROXY = "10.20.30.46";
const HTTPS = { "x-forwarded-proto": "https" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let admin: Db;
let db: Db;
let locker: Db;
let app: ReturnType<typeof buildApp>;
let upstreamClose: () => Promise<void>;
let serverId: string;
let samlProviderId: string;

type Session = { token: string; sessionId: string };
type User = { id: string; key: { authorization: string }; s: Session };
type Person = User & { auth: SoftAuthenticator };
const P = {} as Record<"caller" | "a" | "adm", Person>;

const TOOLS = Array.from({ length: 4 }, (_, i) => `b4c6_t${i}_${RUN}`);
let toolCursor = 0;
const nextTool = () => TOOLS[toolCursor++]!;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const as = (s: Session, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    ...(headers["x-forwarded-proto"] === "https" ? { remoteAddress: PROXY } : {}),
    headers: { ...CSRF, ...headers },
    cookies: { regulait_session: s.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const withKey = (key: { authorization: string }, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkSession(userId: string, opts: { origin?: "password" | "api_key"; ageSeconds?: number } = {}): Promise<Session> {
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [row] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      origin: opts.origin ?? "password",
      ...(opts.ageSeconds ? { createdAt: new Date(Date.now() - opts.ageSeconds * 1000) } : {}),
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
  const reg = await as(s, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label: "b4c6" });
  expect(reg.statusCode, reg.body).toBe(201);
  return auth;
}

async function mkUser(label: string, isAdmin = false): Promise<User> {
  const u = await withKey(AUTH, "POST", "/v1/users", { email: `b4c6-${label}-${randomBytes(2).toString("hex")}-${RUN}@example.com`, displayName: `b4c6 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await withKey(AUTH, "POST", `/v1/users/${id}/keys`, { name: "b4c6" });
  expect(key.statusCode, key.body).toBe(201);
  return { id, key: { authorization: `Bearer ${key.json().token}` }, s: await mkSession(id) };
}
async function mkPerson(label: string, isAdmin = false): Promise<Person> {
  const u = await mkUser(label, isAdmin);
  return { ...u, auth: await enrol(u.s) };
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "b4c6-upstream", version: "0.0.1" });
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

async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p.s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p.s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: p.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

const PAST = () => new Date(Date.now() - 60_000);
/** an approval delegation `from` → `to` (the delegate `to` may decide for `from`), created a minute ago */
const delegate = (fromUserId: string, toUserId: string) =>
  db.insert(approvalDelegations).values({
    fromUserId,
    toUserId,
    startsAt: PAST(),
    endsAt: new Date(Date.now() + 3_600_000),
    reason: "b4c6",
    createdAt: PAST(),
  });

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
    approval_signature_mode = 'passkey',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: [PROXY] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;
  const s = await withKey(AUTH, "POST", "/v1/servers", { name: `b4c6-server-${RUN}`, url: up.url });
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
  // inserted directly: creating a SAML provider through the API is license-gated (ADR-0052), not this suite's subject
  const [sp] = await db
    .insert(samlProviders)
    .values({ name: `b4c6-saml-${RUN}`, entityId: `https://idp.b4c6-${RUN}.example`, idpSsoUrl: `https://idp.b4c6-${RUN}.example/sso`, idpSigningCerts: ["unused"] })
    .returning({ id: samlProviders.id });
  samlProviderId = sp!.id;
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

const totpOf = async (userId: string) =>
  (await db.select({ on: usersTable.totpEnabled, ct: usersTable.totpSecretCiphertext }).from(usersTable).where(eq(usersTable.id, userId)))[0]!;
const codeFor = (secret: string) => totpCode(secret, totpStep());

describe("F32: adding an authenticator app is admitted by the passkey rule", () => {
  it("an account that already has a passkey needs passkey_manage to add one", async () => {
    const p = await mkPerson("totp-holder");
    const refused = await as(p.s, "POST", "/auth/totp/enroll", {});
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "passkey_manage" });
    expect((await totpOf(p.id)).ct).toBeNull();
    const ok = await as(p.s, "POST", "/auth/totp/enroll", {}, { [STEP_UP_HEADER]: await grantFor(p, refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    const act = await as(p.s, "POST", "/auth/totp/activate", { code: codeFor(ok.json().secret) });
    expect(act.statusCode, act.body).toBe(200);
    expect((await totpOf(p.id)).on).toBe(true);
  });

  it("an API key cannot enrol one", async () => {
    const u = await mkUser("totp-key");
    const r = await withKey(u.key, "POST", "/auth/totp/enroll", {});
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("browser_session_required");
    expect((await totpOf(u.id)).ct).toBeNull();
  });

  it("the first method needs a fresh human sign-in (not a key-exchanged or stale session)", async () => {
    const u = await mkUser("totp-stale");
    for (const s of [await mkSession(u.id, { origin: "api_key" }), await mkSession(u.id, { ageSeconds: 3_000 })]) {
      const r = await as(s, "POST", "/auth/totp/enroll", {});
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("fresh_sign_in_required");
    }
    expect((await totpOf(u.id)).ct).toBeNull();
  });

  it("activation is bound to the session that enrolled", async () => {
    const u = await mkUser("totp-bound");
    const e = await as(u.s, "POST", "/auth/totp/enroll", {});
    expect(e.statusCode, e.body).toBe(200);
    const other = await mkSession(u.id);
    const wrong = await as(other, "POST", "/auth/totp/activate", { code: codeFor(e.json().secret) });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json().error).toBe("totp_enrolment_not_found");
    expect((await totpOf(u.id)).on).toBe(false);
    const right = await as(u.s, "POST", "/auth/totp/activate", { code: codeFor(e.json().secret) });
    expect(right.statusCode, right.body).toBe(200);
  });

  it("a first-method enrolment is not activated once the account gained a way to step up", async () => {
    const u = await mkUser("totp-race");
    const e = await as(u.s, "POST", "/auth/totp/enroll", {});
    expect(e.statusCode, e.body).toBe(200);
    // meanwhile a passkey is added as the account's first method (another fresh sign-in)
    await enrol(await mkSession(u.id));
    const act = await as(u.s, "POST", "/auth/totp/activate", { code: codeFor(e.json().secret) });
    expect(act.statusCode, act.body).toBe(409);
    expect(act.json().error).toBe("changed_concurrently");
    expect((await totpOf(u.id)).on).toBe(false);
  });

  it("sweep: an SSO identity is linked by proof only to an account without a passkey", async () => {
    const link = async (u: User) => {
      await db.update(usersTable).set({ passwordHash: hashPassword("b4c6-pw-correct"), mustChangePassword: false }).where(eq(usersTable.id, u.id));
      const [row] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, u.id));
      const anchor = {
        ref: { kind: "saml" as const, id: samlProviderId, name: `b4c6-saml-${RUN}` },
        issuer: `https://idp.b4c6-${RUN}.example`,
        subjectFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        subject: `sub-${u.id}`,
      };
      const req = await raiseLinkRequest(db, anchor, row!.email, u.id, false);
      const r = await app.inject({
        method: "POST",
        url: "/auth/link/confirm",
        headers: CSRF,
        cookies: { [LINK_COOKIE]: req.proofToken },
        payload: { password: "b4c6-pw-correct" },
      });
      return { r, requestId: req.requestId };
    };
    const holder = await mkPerson("link-holder");
    const refused = await link(holder);
    expect(refused.r.statusCode, refused.r.body).toBe(403);
    expect(refused.r.json().error).toBe("link_needs_admin_approval");
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, holder.id))).toHaveLength(0);
    expect((await db.select({ s: federatedLinkRequests.status }).from(federatedLinkRequests).where(eq(federatedLinkRequests.id, refused.requestId)))[0]!.s).toBe("pending");
    // control: an account with no passkey is linked by its password proof, as before
    const plain = await mkUser("link-plain");
    const ok = await link(plain);
    expect(ok.r.statusCode, ok.r.body).toBe(200);
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, plain.id))).toHaveLength(1);
  });
});

describe("F33: in passkey mode a member is signable only by the decide path's rule", () => {
  const call = (tool: string, text: string) =>
    executeGovernedToolCall(db, undefined, { userId: P.caller.id, serverId, toolName: tool, arguments: { text } });
  async function roleWith(member: string): Promise<string> {
    const [r] = await db.insert(roles).values({ name: `b4c6 role ${randomBytes(3).toString("hex")}` }).returning({ id: roles.id });
    await db.insert(roleAssignments).values({ userId: member, roleId: r!.id, createdAt: PAST() });
    return r!.id;
  }
  async function quorum2(roleId: string): Promise<string> {
    const tool = nextTool();
    const r = await withKey(AUTH, "POST", "/v1/rules/approvals", {
      userId: P.caller.id,
      serverId,
      toolName: tool,
      approverUserId: P.a.id,
      approverRoleId: roleId,
      quorum: 2,
    });
    expect(r.statusCode, r.body).toBe(201);
    return tool;
  }

  it("a passkey held by the member's DELEGATOR does not make the member signable", async () => {
    const x = await mkUser("f33-x");
    const d = await mkPerson("f33-delegator");
    await delegate(d.id, x.id); // d → x: x may decide for d, never d for x
    const out = await call(await quorum2(await roleWith(x.id)), "delegator holds the key");
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("approval-quorum-unsatisfiable");
  });

  it("control: a passkey held by the member's DELEGATE makes the member signable", async () => {
    const x = await mkUser("f33-x2");
    const d = await mkPerson("f33-delegate");
    await delegate(x.id, d.id); // x → d: d decides for x
    const out = await call(await quorum2(await roleWith(x.id)), "delegate holds the key");
    expect(out.kind, JSON.stringify(out)).toBe("approval_required");
  });
});

describe("F34: a first-passkey completion counts an SSO link committed while it waited", () => {
  it("an SSO identity linked under the user's row lock refuses the completion", async () => {
    const u = await mkUser("f34");
    const o = await as(u.s, "POST", "/v1/auth/passkeys/registration-options", {}, HTTPS);
    expect(o.statusCode, o.body).toBe(200);
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const response = auth.register(o.json().options);
    let res: Awaited<ReturnType<typeof as>> | undefined;
    await locker.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${u.id} FOR UPDATE`);
      await tx.insert(federatedIdentities).values({
        userId: u.id,
        samlProviderId,
        issuer: `https://idp.b4c6-${RUN}.example`,
        subjectFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        subject: `f34-${u.id}`,
        linkedVia: "jit",
      });
      void as(u.s, "POST", "/v1/auth/passkeys", { challengeId: o.json().challengeId, response, label: "f34" }, HTTPS).then((r) => (res = r));
      await untilLockWait();
    });
    for (let i = 0; i < 250 && !res; i++) await new Promise((r) => setTimeout(r, 20));
    expect(res, "the request never answered").toBeTruthy();
    expect(res!.statusCode, res!.body).toBe(409);
    expect(res!.json().error).toBe("changed_concurrently");
    expect(await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, u.id))).toHaveLength(0);
  });
});

/** refused without a grant (403 settings_relax), admitted with one */
async function provesRelax(method: Method, url: string, payload: unknown, okStatus = 200) {
  const refused = await as(P.adm.s, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  const ok = await as(P.adm.s, method, url, payload, { [STEP_UP_HEADER]: await grantFor(P.adm, refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(okStatus);
}
/** a tightening asks for nothing */
async function tightens(method: Method, url: string, payload: unknown) {
  const r = await as(P.adm.s, method, url, payload);
  expect(r.statusCode, r.body).toBe(200);
}

describe("F35: loosening a setting an org tightened beyond the default is a relaxation", () => {
  it("the session idle window: 5 minutes back to the default", async () => {
    await tightens("PUT", "/v1/org/settings", { sessionIdleMinutes: 5 });
    await provesRelax("PUT", "/v1/org/settings", { sessionIdleMinutes: STRICT_IDENTITY_DEFAULTS.sessionIdleMinutes });
  });
  it("the password length: 30 back to 12", async () => {
    await tightens("PUT", "/v1/org/settings", { passwordMinLength: 30 });
    await provesRelax("PUT", "/v1/org/settings", { passwordMinLength: 12 });
  });
});

describe("F36: a guardrail mode below the mode in force now is a relaxation", () => {
  it("the org toxicity mode: block back to its shipped warn (PII is not set here: its mode is the cascade piiMode)", async () => {
    await tightens("PUT", "/v1/guardrails/config", { modes: { toxicity: "block" } });
    await provesRelax("PUT", "/v1/guardrails/config", { modes: { toxicity: "warn" } });
  });
  it("an override lowered below its own mode (still above the org's), and an override stricter than the org removed", async () => {
    const [ag] = await db.insert(agents).values({ name: `b4c6-gr-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    const url = `/v1/guardrails/config/agent/${ag!.id}`;
    await tightens("PUT", url, { modes: { toxicity: "block" } });
    await provesRelax("PUT", url, { modes: { toxicity: "warn" } });
    await tightens("PUT", url, { modes: { toxicity: "block" } });
    await provesRelax("DELETE", url, undefined);
  });
});

describe("F37: turning delegation off while a delegation is live splits principals", () => {
  it("needs settings_relax while a delegation is live; nothing once none is", async () => {
    const x = await mkUser("f37-x");
    const y = await mkUser("f37-y");
    await delegate(x.id, y.id);
    await provesRelax("PUT", "/v1/org/settings", { approvalDelegationEnabled: false });
    // control: no live delegation — turning it off (from on) is a tightening
    await db.execute(sql`UPDATE org_settings SET approval_delegation_enabled = true WHERE id = ${ORG_SETTINGS_ID}`);
    await db.update(approvalDelegations).set({ endsAt: new Date(Date.now() - 1_000) });
    await tightens("PUT", "/v1/org/settings", { approvalDelegationEnabled: false });
  });
});

describe("F38: the viewer's decided approvals are found by EXISTS, not an id list", () => {
  it("the condition is one correlated EXISTS with one bound parameter", async () => {
    const mod = (await import("./approval-signatures.js")) as Record<string, unknown>;
    expect(typeof mod.decidedByViewerCondition, "decidedByViewerCondition is exported").toBe("function");
    const cond = (mod.decidedByViewerCondition as (id: string) => ReturnType<typeof sql>)(P.a.id);
    const q = db.select({ id: approvals.id }).from(approvals).where(cond).toSQL();
    expect(q.sql).toMatch(/EXISTS \(SELECT 1 FROM "approval_decisions" ad WHERE ad\.approval_id = "approvals"\."id"/);
    expect(q.sql).not.toMatch(/ in \(/i);
    expect(q.params).toEqual([P.a.id]);
  });
  it("a viewer still sees an approval they decided, through the queue", async () => {
    const viewer = await mkUser("f38-viewer");
    const [ap] = await db
      .insert(approvals)
      .values({ objectType: "tool_call", userId: P.caller.id, approverUserId: P.a.id, status: "pending", requestPayload: {} } as never)
      .returning({ id: approvals.id });
    await db.insert(approvalDecisions).values({ approvalId: ap!.id, deciderUserId: viewer.id, principalUserId: viewer.id, decision: "approved", stepUpMethod: "none" });
    const list = await as(viewer.s, "GET", "/v1/approvals");
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().approvals as Array<{ id: string }>).map((r) => r.id)).toContain(ap!.id);
  });
});

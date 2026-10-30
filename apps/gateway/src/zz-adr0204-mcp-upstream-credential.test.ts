/**
 * ADR-0204 — a static upstream credential per MCP server, on a real database, against upstream doubles that record
 * every request's headers:
 *
 *  - the strict default (no credential) sends nothing;
 *  - set, rotate and clear need a settings_relax step-up: an API key is refused, a person is asked for one bound to the
 *    server, its url and the scheme and header; each write is audited in its transaction;
 *  - with a bearer credential every request to the server carries `Authorization: Bearer <secret>`; with a header
 *    credential, the named header and no Authorization; with the identity assertion on as well, both headers ride
 *    and neither replaces the other;
 *  - reserved headers (Host, Cookie, Content-*, Mcp-Session-Id, RegulAIt-Identity-Assertion, Authorization under the
 *    header scheme) are refused 400, audited, nothing saved;
 *  - the secret never reaches another origin: not on a redirect (the guarded fetch refuses it), and the middleware
 *    strips it from a request bound elsewhere;
 *  - a credential this process cannot open refuses the connect, with zero upstream contact;
 *  - a url move clears it, audited;
 *  - the secret never appears in a read, an audit row or a log line.
 *
 * Global state (M-068): the org settings it changes are put back, and the admin's passkey, sessions and step-up grants
 * are removed (B4S-06) in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  inArray,
  mcpServers,
  mcpServerUpstreamCredentials,
  identitySigningKeys,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  stepUpGrants,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { IDENTITY_ASSERTION_HEADER, IDENTITY_SIGNING_KEY_ENV, STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { resolveGatewayLogger } from "./gateway-logger.js";
import { connectUpstream, executeGovernedToolCall } from "./mcp-proxy.js";
import { McpEgressBlockedError } from "./mcp-egress.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { withUpstreamCredential } from "./mcp-upstream-credential.js";
import { encryptSecret } from "./secrets.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `uc-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = randomBytes(32).toString("hex");
const OTHER_KEY = randomBytes(32).toString("hex");
const TOOL = `uc_read_${RUN}`;
// synthetic placeholders, never a real key
const SECRET = `uc-placeholder-secret-${RUN}-aaaa1111`;
const ROTATED = `uc-placeholder-rotated-${RUN}-bbbb2222`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

interface Seen {
  path: string;
  method: string | null;
  headers: http.IncomingHttpHeaders;
}
let db: Db;
let app: ReturnType<typeof buildApp>;
let up: { url: string; base: string; seen: Seen[]; close: () => Promise<void> };
let elsewhere: { url: string; seen: Seen[]; close: () => Promise<void> };
let serverId: string;
let userId: string;
let adminKey: { authorization: string };
let admin: { id: string; session: string; auth: SoftAuthenticator };
let keyDir: string;
const logLines: string[] = [];
const restores: Array<() => Promise<void>> = [];
const sessions: string[] = [];
const extraServers: string[] = [];

/** an MCP upstream that records each request; `/redirect-*` paths answer 307 to `redirectTo` */
async function startUpstream(redirectTo?: () => string) {
  const seen: Seen[] = [];
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : undefined;
        } catch {
          parsed = undefined;
        }
        const method = parsed && typeof parsed === "object" && "method" in parsed ? String((parsed as { method: unknown }).method) : null;
        seen.push({ path: req.url ?? "", method: req.method === "POST" ? method : `${req.method}`, headers: { ...req.headers } });
        if (redirectTo && (req.url ?? "").startsWith("/redirect-")) {
          res.writeHead(307, { location: redirectTo() }).end();
          return;
        }
        const server = new McpServer({ name: "uc-upstream", version: "0.0.1" });
        server.registerTool(TOOL, { description: "uc", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "ok" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    url: `${base}/mcp-${RUN}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        httpServer.closeAllConnections();
        httpServer.close(() => r());
      }),
  };
}

async function received(fn: () => Promise<unknown>) {
  const before = up.seen.length;
  await fn();
  return up.seen.slice(before);
}

const call = () => executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: TOOL });
const credUrl = (id = serverId) => `/v1/servers/${id}/upstream-credential`;
const asSession = (method: "PUT" | "DELETE" | "GET", url: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...extra }, cookies: { regulait_session: admin.session }, ...(payload ? { payload } : {}) });
const lastAudit = async (ruleId: string, server = serverId) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.serverId, server))).orderBy(desc(auditLog.seq)).limit(1))[0];

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const asAdmin = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: CSRF, cookies: { regulait_session: admin.session }, payload: payload as object });
  const o = await asAdmin("/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: admin.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** a write the person makes: refused for a step-up bound to `facts`, then done with that grant */
async function throughStepUp(method: "PUT" | "DELETE", url: string, payload: Record<string, unknown> | undefined, facts: Record<string, unknown>) {
  const asked = await asSession(method, url, payload);
  expect(asked.statusCode, asked.body).toBe(403);
  expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: ["passkey"] });
  expect(asked.json().action).toEqual({ kind: "settings_relax", body: facts });
  const token = await grantFor(asked.json().action);
  return asSession(method, url, payload, { [STEP_UP_HEADER]: token });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  // an issuer key, so the identity assertion can ride beside the credential (as the S8 suite configures it)
  keyDir = mkdtempSync(path.join(os.tmpdir(), "uc-issuer-"));
  writeFileSync(path.join(keyDir, "issuer.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, logger: { ...(resolved as object), stream: sink } as never });
  await app.ready();
  elsewhere = await startUpstream();
  up = await startUpstream(() => elsewhere.url);
  const inject = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });
  const s = await inject("/v1/servers", { name: `uc-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  expect((await inject(`/v1/servers/${serverId}/tools`, { name: TOOL, kind: "read" })).statusCode).toBe(201);
  const u = await inject("/v1/users", { email: `uc-user-${RUN}@example.com`, displayName: `uc user ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  expect((await inject("/v1/grants/tools", { userId, serverId, toolName: TOOL })).statusCode).toBe(201);
  const adm = await inject("/v1/users", { email: `uc-admin-${RUN}@example.com`, displayName: `uc admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  const adminId = adm.json().id as string;
  adminKey = { authorization: `Bearer ${(await inject(`/v1/users/${adminId}/keys`, { name: "uc" })).json().token}` };

  const token = "rgls_" + randomBytes(32).toString("hex");
  const [sess] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: adminId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  sessions.push(sess!.id);
  admin = { id: adminId, session: token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await app.inject({ method: "POST", url: "/v1/auth/passkeys/registration-options", headers: CSRF, cookies: { regulait_session: token }, payload: {} });
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/passkeys",
    headers: CSRF,
    cookies: { regulait_session: token },
    payload: { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "uc" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
}, 120_000);

afterAll(async () => {
  try {
    if (admin) {
      await db.delete(stepUpGrants).where(eq(stepUpGrants.userId, admin.id));
      await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, admin.id));
      await forgetStepUpMethodsForTest(db, [admin.id]);
      await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, admin.id));
    }
    if (sessions.length > 0) await db.delete(authSessions).where(inArray(authSessions.id, sessions));
  } finally {
    try {
      const ids = [serverId, ...extraServers].filter((id): id is string => typeof id === "string");
      if (ids.length > 0) {
        await db.delete(mcpServerUpstreamCredentials).where(inArray(mcpServerUpstreamCredentials.serverId, ids));
        await db.update(mcpServers).set({ identityPropagation: "none", discloseAgentWorkloadIds: false }).where(inArray(mcpServers.id, ids));
      }
      await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
      for (const r of restores.reverse()) await r();
      delete process.env[IDENTITY_SIGNING_KEY_ENV];
      if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
      else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
      app?.server.closeAllConnections();
      await app?.close();
    } finally {
      await up?.close();
      await elsewhere?.close();
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
    }
  }
});

describe("ADR-0204 — the strict default sends nothing", () => {
  it("no credential: the call is served and no request carries Authorization or a credential header", async () => {
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.some((r) => r.method === "tools/call")).toBe(true);
    expect(got.every((r) => r.headers.authorization === undefined)).toBe(true);
    const view = await app.inject({ method: "GET", url: credUrl(), headers: adminKey });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().credential).toEqual({ set: false, scheme: null, headerName: null, last4: null, setBy: null, setAt: null });
  });
});

describe("ADR-0204 — reserved headers are refused", () => {
  it.each([
    ["Host"],
    ["Cookie"],
    ["Content-Type"],
    ["content-length"],
    ["Mcp-Session-Id"],
    [IDENTITY_ASSERTION_HEADER],
    ["Authorization"],
    ["Transfer-Encoding"],
    ["Bad Header"],
  ])("header scheme with %s: 400, audited, nothing saved, no step-up asked", async (headerName) => {
    const r = await asSession("PUT", credUrl(), { scheme: "header", headerName, secret: SECRET });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ error: "mcp_upstream_credential_refused", code: "header_refused" });
    expect(r.body).not.toContain(SECRET);
    const denied = await lastAudit("mcp-upstream-credential-refused");
    expect(denied!.effect).toBe("deny");
    expect(JSON.stringify(denied)).not.toContain(SECRET);
    expect(await db.select().from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId))).toHaveLength(0);
  });

  it("a secret with a line break or space is refused, and the refusal never echoes it", async () => {
    const r = await asSession("PUT", credUrl(), { scheme: "bearer", secret: `${SECRET}\r\nX-Injected: 1` });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().code).toBe("secret_refused");
    expect(r.body).not.toContain(SECRET);
    const short = await asSession("PUT", credUrl(), { scheme: "bearer", secret: "short" });
    expect(short.statusCode).toBe(400);
  });

  it("a malformed body is refused with a fixed sentence (the zod issues could echo the secret)", async () => {
    const r = await asSession("PUT", credUrl(), { scheme: "basic", secret: SECRET });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_request");
    expect(r.body).not.toContain(SECRET);
  });
});

describe("ADR-0204 — set, rotate and clear need a step-up and are audited", () => {
  it("an API key is refused step_up_required: it cannot confirm who is acting", async () => {
    const r = await app.inject({ method: "PUT", url: credUrl(), headers: adminKey, payload: { scheme: "bearer", secret: SECRET } });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", credential: "api_key" });
    expect(await db.select().from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId))).toHaveLength(0);
  });

  it("set (bearer): the person's step-up is bound to the server, its url and the scheme; saved and audited", async () => {
    const ok = await throughStepUp("PUT", credUrl(), { scheme: "bearer", secret: SECRET }, {
      op: "mcp_upstream_credential_set",
      serverId,
      url: up.url,
      values: { upstreamCredential: { scheme: "bearer", headerName: "authorization" } },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().credential).toMatchObject({ set: true, scheme: "bearer", headerName: "authorization", last4: SECRET.slice(-4), setBy: admin.id });
    expect(ok.body).not.toContain(SECRET);
    const row = await lastAudit("mcp-upstream-credential-set");
    expect(row!.detail).toMatchObject({ upstreamCredential: "set", scheme: "bearer", headerName: "authorization", relaxation: true });
  });

  it("a second set is refused 409 (rotate it instead)", async () => {
    const again = await asSession("PUT", credUrl(), { scheme: "bearer", secret: ROTATED });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("upstream_credential_exists");
  });

  it("every request to the server carries Authorization: Bearer <secret>", async () => {
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.length).toBeGreaterThan(1);
    expect(got.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
  });

  it("with the identity assertion on too, both headers ride and neither replaces the other", async () => {
    await db.update(mcpServers).set({ identityPropagation: "signed_assertion" }).where(eq(mcpServers.id, serverId));
    try {
      const got = await received(async () => expect((await call()).kind).toBe("allowed"));
      const toolsCall = got.filter((r) => r.method === "tools/call");
      expect(toolsCall).toHaveLength(1);
      const assertion = toolsCall[0]!.headers[IDENTITY_ASSERTION_HEADER.toLowerCase()];
      expect(typeof assertion).toBe("string");
      expect(assertion).not.toContain(SECRET);
      expect(got.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
    } finally {
      await db.update(mcpServers).set({ identityPropagation: "none" }).where(eq(mcpServers.id, serverId));
    }
  });

  it("rotate to a named header: X-API-Key carries the raw secret and Authorization is no longer sent", async () => {
    const ok = await throughStepUp("PUT", credUrl(), { scheme: "header", headerName: "X-API-Key", secret: ROTATED, rotate: true }, {
      op: "mcp_upstream_credential_rotate",
      serverId,
      url: up.url,
      values: { upstreamCredential: { scheme: "header", headerName: "x-api-key" } },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().credential).toMatchObject({ set: true, scheme: "header", headerName: "x-api-key", last4: ROTATED.slice(-4) });
    expect((await lastAudit("mcp-upstream-credential-rotated"))!.detail).toMatchObject({ upstreamCredential: "rotated", headerName: "x-api-key" });
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((r) => r.headers["x-api-key"] === ROTATED && r.headers.authorization === undefined)).toBe(true);
  });

  it("clear: a step-up bound to the server and url; the secret is destroyed and nothing is sent after", async () => {
    const ok = await throughStepUp("DELETE", credUrl(), undefined, { op: "mcp_upstream_credential_clear", serverId, url: up.url });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().credential.set).toBe(false);
    expect((await lastAudit("mcp-upstream-credential-cleared"))!.effect).toBe("allow");
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((r) => r.headers["x-api-key"] === undefined && r.headers.authorization === undefined)).toBe(true);
    const none = await asSession("DELETE", credUrl());
    expect(none.statusCode).toBe(404);
  });
});

describe("ADR-0204 — never to another origin", () => {
  it("the middleware sets the header only for the registered origin, and strips one bound elsewhere", () => {
    const cred = { headerName: "x-api-key", value: SECRET, scheme: "header" as const };
    const origin = new URL(up.url).origin;
    const same = new Headers(withUpstreamCredential(cred, origin, `${up.url}?x=1`, {}).headers);
    expect(same.get("x-api-key")).toBe(SECRET);
    const other = new Headers(withUpstreamCredential(cred, origin, elsewhere.url, { headers: { "x-api-key": "planted" } }).headers);
    expect(other.get("x-api-key")).toBeNull();
    const sub = new Headers(withUpstreamCredential(cred, origin, origin.replace("127.0.0.1", "127.0.0.1.example"), {}).headers);
    expect(sub.get("x-api-key")).toBeNull();
  });

  it("a 307 to another origin is refused by the guarded fetch: the other origin sees nothing at all", async () => {
    const s = await app.inject({ method: "POST", url: "/v1/servers", headers: AUTH, payload: { name: `uc-redirect-${RUN}`, url: `${up.base}/redirect-${RUN}` } });
    expect(s.statusCode, s.body).toBe(201);
    const id = s.json().id as string;
    extraServers.push(id);
    await db.insert(mcpServerUpstreamCredentials).values({
      serverId: id,
      scheme: "bearer",
      headerName: "authorization",
      secretCiphertext: encryptSecret(DATA_KEY, SECRET),
      secretLast4: SECRET.slice(-4),
    });
    const before = elsewhere.seen.length;
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    await expect(connectUpstream(db, row!)).rejects.toBeTruthy();
    expect(elsewhere.seen.length - before).toBe(0);
    // the registered origin got it (that is where it is meant to go)
    const redirected = up.seen.filter((r) => r.path.startsWith("/redirect-"));
    expect(redirected.length).toBeGreaterThan(0);
    expect(redirected.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
  });

  it("a credential this process cannot open refuses the connect, audited, with zero upstream contact", async () => {
    const s = await app.inject({ method: "POST", url: "/v1/servers", headers: AUTH, payload: { name: `uc-wrongkey-${RUN}`, url: `${up.url}-wk` } });
    expect(s.statusCode, s.body).toBe(201);
    const id = s.json().id as string;
    extraServers.push(id);
    await db.insert(mcpServerUpstreamCredentials).values({
      serverId: id,
      scheme: "bearer",
      headerName: "authorization",
      secretCiphertext: encryptSecret(OTHER_KEY, SECRET),
      secretLast4: SECRET.slice(-4),
    });
    const before = up.seen.length;
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    const err = await connectUpstream(db, row!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpEgressBlockedError);
    expect((err as { error?: string }).error).toBe("mcp_upstream_credential_unavailable");
    expect(up.seen.length - before).toBe(0);
    expect((await lastAudit("mcp-upstream-credential-unavailable", id))!.effect).toBe("deny");
  });

  it("the database refuses a reserved header written around the API", async () => {
    await expect(
      db.insert(mcpServerUpstreamCredentials).values({
        serverId: extraServers[0]!,
        scheme: "header",
        headerName: "cookie",
        secretCiphertext: encryptSecret(DATA_KEY, SECRET),
        secretLast4: "xxxx",
      }),
    ).rejects.toThrow();
  });
});

describe("ADR-0204 — a url move clears it", () => {
  it("PATCH url: the credential is deleted and the clear is audited in the same write", async () => {
    const set = await throughStepUp("PUT", credUrl(), { scheme: "bearer", secret: SECRET }, {
      op: "mcp_upstream_credential_set",
      serverId,
      url: up.url,
      values: { upstreamCredential: { scheme: "bearer", headerName: "authorization" } },
    });
    expect(set.statusCode, set.body).toBe(201);
    const moved = `${up.url}-moved`;
    const r = await app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: adminKey, payload: { url: moved } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await db.select().from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId))).toHaveLength(0);
    expect((await lastAudit("mcp-upstream-credential-cleared-url-move"))!.detail).toMatchObject({ cause: "url_move", from: up.url, to: moved });
    // a url restatement is not a move
    const same = await app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: adminKey, payload: { url: moved } });
    expect(same.statusCode, same.body).toBe(200);
  });
});

describe("ADR-0204 — the secret never appears in a read, an audit row or a log line", () => {
  it("reads, the server list, every audit row and every log line are free of the secrets and their ciphertext", async () => {
    const ciphertexts = (await db.select({ c: mcpServerUpstreamCredentials.secretCiphertext }).from(mcpServerUpstreamCredentials)).map((r) => r.c);
    const list = await app.inject({ method: "GET", url: "/v1/servers", headers: adminKey });
    expect(list.statusCode).toBe(200);
    const views = await Promise.all([serverId, ...extraServers].map((id) => app.inject({ method: "GET", url: credUrl(id), headers: adminKey })));
    const rows = await db.select().from(auditLog).where(inArray(auditLog.serverId, [serverId, ...extraServers]));
    expect(rows.length).toBeGreaterThan(0);
    const corpus = [list.body, ...views.map((v) => v.body), JSON.stringify(rows), logLines.join("\n")].join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    for (const s of [SECRET, ROTATED, ...ciphertexts]) expect(corpus).not.toContain(s);
    expect(list.body).not.toContain("secret_ciphertext");
    expect(list.body).not.toContain("secretCiphertext");
  });
});

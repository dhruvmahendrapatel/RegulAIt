/**
 * ADR-0238 (P12(d)) — down-scoped upstream credentials by RFC 8693 token exchange, on a real database, against an MCP
 * upstream double and a connector upstream that record every request's headers, and a token-endpoint double reached
 * THROUGH the egress guard (its injected transport seam; the guard still adjudicates the https destination):
 *
 *  - the strict default: no configuration exchanges nothing and sends no Authorization;
 *  - writes need a settings_relax step-up bound to every stored value; reads never show the secret;
 *  - an allowed call to a mapped tool: the exchange asks for exactly that tool's scopes, the pinned audience and
 *    resource, with an ES256 subject token for THIS person (pairwise `sub`, 60 s, unique `jti`, the same `scope`), and
 *    the upstream's tools/call carries the exchanged token; the trail has an "issued" row with no token in it;
 *  - negatives, each a denied call with ZERO tools/call upstream: an unmapped tool (default-deny, no exchange at all),
 *    a WRONG AUDIENCE, a SCOPE WIDENING answer, an EXPIRED token, a REPLAYED token, ANOTHER USER's token handed to a
 *    second person, an egress-blocked endpoint, a token endpoint error;
 *  - no caching: two calls by one person make two exchanges with two subject tokens;
 *  - the connector path: the operation's scopes, the exchanged token in place of a stored credential, default-deny;
 *  - a url move turns it off; the token never appears in an audit row or a log line.
 *
 * Global state (M-068): the org settings it changes, the egress entries it adds, the admin's passkey, sessions and
 * step-up grants are put back in afterAll.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, decodeJwt, jwtVerify, SignJWT } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  identitySigningKeys,
  inArray,
  mcpServers,
  ORG_SETTINGS_ID,
  replayClaims,
  runMigrations,
  sql,
  stepUpGrants,
  upstreamTokenExchanges,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { IDENTITY_SIGNING_KEY_ENV, MCP_IDENTITY_OIDC_JWKS_PATH, STEP_UP_HEADER, TOKEN_EXCHANGE_GRANT_TYPE, UPSTREAM_EXCHANGE_RULE_IDS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { resolveGatewayLogger } from "./gateway-logger.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { pairwiseSubject } from "./delegated-token.js";
import { identitySecretsFor } from "./oauth/common.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { upstreamExchangeTestHooks } from "./upstream-token-exchange.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `te-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = randomBytes(32).toString("hex");
const SYSTEM = "00000000-0000-0000-0000-000000000000";
const TOOL = `te_search_${RUN}`;
const UNMAPPED = `te_delete_${RUN}`;
const AS_HOST = `as-${RUN}.example.test`;
const TOKEN_ENDPOINT = `https://${AS_HOST}/oauth2/token`;
const AS_ID = `https://${AS_HOST}`;
const AUD = `https://api-${RUN}.example.test`;
const RESOURCE = `https://api-${RUN}.example.test/mcp`;
// synthetic placeholders, never a real key
const CLIENT_SECRET = "s".repeat(24) + RUN;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

interface Seen {
  method: string | null;
  headers: http.IncomingHttpHeaders;
}
interface AsRequest {
  url: string;
  authorization: string | null;
  form: URLSearchParams;
}
let db: Db;
let app: ReturnType<typeof buildApp>;
let up: { url: string; seen: Seen[]; close: () => Promise<void> };
let conn: { base: string; seen: Seen[]; close: () => Promise<void> };
let serverId: string;
let userId: string;
let otherUserId: string;
let connectorId: string;
let adminKey: { authorization: string };
let admin: { id: string; session: string; auth: SoftAuthenticator };
let keyDir: string;
let asKey: KeyObject;
const logLines: string[] = [];
const restores: Array<() => Promise<void>> = [];
const sessions: string[] = [];
let asAllowHostId: string | undefined;
let loopbackAllowHostId: string | undefined;
let previousLoopback: typeof egressAllowHosts.$inferSelect | undefined;
let issuedTokens: string[] = [];

/** the token endpoint double: records each request; `answer` decides the reply */
const asSeen: AsRequest[] = [];
let answer: (req: AsRequest) => Promise<{ status: number; body: unknown }>;

async function mintAt(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(asKey);
}
const nowS = () => Math.floor(Date.now() / 1000);
/** a well-behaved authorization server: a fresh JWT for exactly what was asked */
const goodAnswer = async (req: AsRequest) => {
  const token = await mintAt({ aud: req.form.get("audience"), exp: nowS() + 120, scope: req.form.get("scope"), jti: randomBytes(8).toString("hex") });
  issuedTokens.push(token);
  return { status: 200, body: { access_token: token, token_type: "Bearer", issued_token_type: "urn:ietf:params:oauth:token-type:access_token", expires_in: 120, scope: req.form.get("scope") } };
};

async function startUpstream() {
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
        seen.push({ method: req.method === "POST" ? method : `${req.method}`, headers: { ...req.headers } });
        const server = new McpServer({ name: "te-upstream", version: "0.0.1" });
        for (const name of [TOOL, UNMAPPED]) {
          server.registerTool(name, { description: "te", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
        }
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
    url: `${base}/mcp-${RUN}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        httpServer.closeAllConnections();
        httpServer.close(() => r());
      }),
  };
}

/** a connector upstream (the `http` adapter) that records headers and answers JSON */
async function startConnectorUpstream() {
  const seen: Seen[] = [];
  const httpServer = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      seen.push({ method: req.method ?? null, headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rows: [] }));
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const addr = httpServer.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        httpServer.closeAllConnections();
        httpServer.close(() => r());
      }),
  };
}

const call = (forUser = userId, toolName = TOOL) => executeGovernedToolCall(db, DATA_KEY, { userId: forUser, serverId, toolName });
const toolCalls = (from: number) => up.seen.slice(from).filter((r) => r.method === "tools/call");
const exUrl = (kind: "servers" | "connectors" = "servers", id = kind === "servers" ? serverId : connectorId) => `/v1/${kind}/${id}/token-exchange`;
const asSession = (method: "PUT" | "DELETE" | "GET", url: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...extra }, cookies: { regulait_session: admin.session }, ...(payload ? { payload } : {}) });
const lastAudit = async (ruleId: string, objectId = serverId) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId))).orderBy(desc(auditLog.seq)).limit(1))[0];

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const asAdmin = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: CSRF, cookies: { regulait_session: admin.session }, payload: payload as object });
  const o = await asAdmin("/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: admin.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** a write the person makes: refused for a step-up, then done with a grant bound to exactly those facts */
async function throughStepUp(method: "PUT" | "DELETE", url: string, payload?: Record<string, unknown>) {
  const asked = await asSession(method, url, payload);
  expect(asked.statusCode, asked.body).toBe(403);
  expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  const token = await grantFor(asked.json().action);
  return asSession(method, url, payload, { [STEP_UP_HEADER]: token });
}

const config = (o: Record<string, unknown> = {}) => ({
  enabled: true,
  tokenEndpoint: TOKEN_ENDPOINT,
  subjectTokenAudience: AS_ID,
  audience: AUD,
  resource: RESOURCE,
  clientId: `regulait-${RUN}`,
  clientSecret: CLIENT_SECRET,
  maxTokenTtlSeconds: 300,
  scopes: { [TOOL]: ["tickets.read", "tickets.search"] },
  ...o,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  restores.push(await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false }));
  const [prior] = await db.select({ mode: sql<string>`step_up_mode`, actions: sql<unknown>`step_up_actions` }).from(sql`org_settings`).where(sql`id = ${ORG_SETTINGS_ID}`);
  restores.push(async () => {
    await db.execute(sql`UPDATE org_settings SET step_up_mode = ${prior!.mode}, step_up_actions = ${JSON.stringify(prior!.actions)}::jsonb WHERE id = ${ORG_SETTINGS_ID}`);
  });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);

  // the issuer's ES256 key (the subject token is an ADR-0210 OIDC assertion)
  keyDir = mkdtempSync(path.join(os.tmpdir(), "adr0238-issuer-"));
  const pem = (k: KeyObject) => k.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(keyDir, "issuer.pem"), pem(generateKeyPairSync("ed25519").privateKey) + pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  for (const k of await configuredIdentitySigningKeys()) {
    const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys).where(eq(identitySigningKeys.algorithm, k.algorithm));
    if (recorded.length > 0) await rotateIdentitySigningKey(db, { kid: k.kid, actorUserId: SYSTEM });
  }
  asKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

  // the token endpoint double, behind the real egress guard: an https host on the allow-list, resolved to a public address
  upstreamExchangeTestHooks.resolve = async () => [{ address: "93.184.215.14", family: 4 }];
  upstreamExchangeTestHooks.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: AsRequest = {
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      authorization: new Headers(init?.headers).get("authorization"),
      form: new URLSearchParams(String(init?.body ?? "")),
    };
    asSeen.push(req);
    const out = await answer(req);
    return new Response(typeof out.body === "string" ? out.body : JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const [allowAs] = await db.insert(egressAllowHosts).values({ host: AS_HOST, note: "adr0238 test token endpoint" }).returning({ id: egressAllowHosts.id });
  asAllowHostId = allowAs!.id;
  // the connector upstream is on loopback over http (as the connector suites do); an entry already there is handed back
  [previousLoopback] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  const [loop] = await db
    .insert(egressAllowHosts)
    .values({ host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true })
    .onConflictDoUpdate({ target: egressAllowHosts.host, set: { allowPrivateRanges: true, allowPlaintextHttp: true } })
    .returning({ id: egressAllowHosts.id });
  if (!previousLoopback) loopbackAllowHostId = loop!.id;

  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, logger: { ...(resolved as object), stream: sink } as never });
  await app.ready();
  up = await startUpstream();
  conn = await startConnectorUpstream();
  const inject = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });
  const s = await inject("/v1/servers", { name: `te-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  for (const name of [TOOL, UNMAPPED]) expect((await inject(`/v1/servers/${serverId}/tools`, { name, kind: "read" })).statusCode).toBe(201);
  for (const who of ["a", "b"]) {
    const u = await inject("/v1/users", { email: `te-user-${who}-${RUN}@example.com`, displayName: `te user ${who} ${RUN}` });
    expect(u.statusCode, u.body).toBe(201);
    if (who === "a") userId = u.json().id;
    else otherUserId = u.json().id;
    for (const name of [TOOL, UNMAPPED]) expect((await inject("/v1/grants/tools", { userId: u.json().id, serverId, toolName: name })).statusCode).toBe(201);
  }
  const c = await inject("/v1/connectors", { name: `te_connector_${RUN}`, kind: "data", providerKind: "http", baseUrl: conn.base });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  expect((await inject("/v1/grants/connectors", { userId, connectorId, mode: "readwrite", allowedObjects: ["records"] })).statusCode).toBe(201);
  const adm = await inject("/v1/users", { email: `te-admin-${RUN}@example.com`, displayName: `te admin ${RUN}`, isAdmin: true });
  const adminId = adm.json().id as string;
  adminKey = { authorization: `Bearer ${(await inject(`/v1/users/${adminId}/keys`, { name: "te" })).json().token}` };

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
    payload: { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "te" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
}, 120_000);

beforeEach(() => {
  answer = goodAnswer;
});

afterAll(async () => {
  // M-068: the allow entries this file created are removed through the audited route while the app is up; an entry
  // that was already there (loopback) is handed back as it was found instead. Asserted last.
  const asEntry = await removeEgressAllowEntry(app, AUTH, { id: asAllowHostId });
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowHostId });
  try {
    delete upstreamExchangeTestHooks.fetchImpl;
    delete upstreamExchangeTestHooks.resolve;
    if (admin) {
      await db.delete(stepUpGrants).where(eq(stepUpGrants.userId, admin.id));
      await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, admin.id));
      await forgetStepUpMethodsForTest(db, [admin.id]);
      await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, admin.id));
    }
    if (sessions.length > 0) await db.delete(authSessions).where(inArray(authSessions.id, sessions));
  } finally {
    try {
      await db.delete(upstreamTokenExchanges).where(eq(upstreamTokenExchanges.mcpServerId, serverId));
      if (connectorId) await db.delete(upstreamTokenExchanges).where(eq(upstreamTokenExchanges.connectorId, connectorId));
      if (previousLoopback) await db.update(egressAllowHosts).set(previousLoopback).where(eq(egressAllowHosts.id, previousLoopback.id));
      await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
      for (const r of restores.reverse()) await r();
      delete process.env[IDENTITY_SIGNING_KEY_ENV];
      if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
      else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
      app?.server.closeAllConnections();
      await app?.close();
    } finally {
      await up?.close();
      await conn?.close();
      if (keyDir) rmSync(keyDir, { recursive: true, force: true });
      asEntry.assertRemoved();
      loopback.assertRemoved();
    }
  }
});

describe("ADR-0238 — off by default", () => {
  it("no configuration: the call is served, nothing is exchanged and no request carries Authorization", async () => {
    const before = up.seen.length;
    const asBefore = asSeen.length;
    expect((await call()).kind).toBe("allowed");
    expect(toolCalls(before)).toHaveLength(1);
    expect(up.seen.slice(before).every((r) => r.headers.authorization === undefined)).toBe(true);
    expect(asSeen.length).toBe(asBefore);
    const view = await app.inject({ method: "GET", url: exUrl(), headers: adminKey });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().tokenExchange).toMatchObject({ configured: false, enabled: false, clientSecretLast4: null });
  });
});

describe("ADR-0238 — configuring it is a step-up, and the secret is never shown", () => {
  it("an http endpoint or a bad scope token is refused 400 with a fixed sentence that never echoes the secret", async () => {
    for (const bad of [config({ tokenEndpoint: "http://insecure.example/token" }), config({ scopes: { [TOOL]: ["a b"] } })]) {
      const r = await asSession("PUT", exUrl(), bad);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.body).not.toContain(CLIENT_SECRET);
    }
  });

  it("an API key cannot set it, a person is asked for a step-up, and the write is audited without the secret", async () => {
    const byKey = await app.inject({ method: "PUT", url: exUrl(), headers: adminKey, payload: config() });
    expect(byKey.statusCode, byKey.body).toBe(403);
    const r = await throughStepUp("PUT", exUrl(), config());
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().tokenExchange).toMatchObject({
      configured: true,
      enabled: true,
      audience: AUD,
      resource: RESOURCE,
      clientSecretLast4: CLIENT_SECRET.slice(-4),
      scopes: { [TOOL]: ["tickets.read", "tickets.search"] },
    });
    expect(r.body).not.toContain(CLIENT_SECRET);
    const set = await lastAudit(UPSTREAM_EXCHANGE_RULE_IDS.set);
    expect(set).toBeTruthy();
    expect(JSON.stringify(set)).not.toContain(CLIENT_SECRET);
    const [row] = await db.select().from(upstreamTokenExchanges).where(eq(upstreamTokenExchanges.mcpServerId, serverId));
    expect(row!.clientSecretCiphertext).not.toContain(CLIENT_SECRET);
  });
});

describe("ADR-0238 — an allowed call receives a token down-scoped to that one tool", () => {
  it("the exchange asks for exactly the tool's scopes for THIS person; the upstream gets the exchanged token", async () => {
    const before = up.seen.length;
    const asBefore = asSeen.length;
    issuedTokens = [];
    expect((await call()).kind).toBe("allowed");
    const exchanges = asSeen.slice(asBefore);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0]!;
    expect(ex.url).toBe(TOKEN_ENDPOINT);
    expect(ex.form.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
    expect(ex.form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(ex.form.get("requested_token_type")).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(ex.form.get("audience")).toBe(AUD);
    expect(ex.form.get("resource")).toBe(RESOURCE);
    expect(ex.form.get("scope")).toBe("tickets.read tickets.search");
    // client_secret_basic (RFC 6749 §2.3.1: each part form-urlencoded, then Basic)
    expect(ex.authorization).toMatch(/^Basic /);
    const [id, secret] = Buffer.from(ex.authorization!.slice(6), "base64").toString("utf8").split(":").map((p) => decodeURIComponent(p.replace(/\+/g, " ")));
    expect([id, secret]).toEqual([`regulait-${RUN}`, CLIENT_SECRET]);
    // the subject token: ES256 under the public issuer, for the authorization server, pairwise for this person, 60 s.
    // The JWKS is read now: on a fresh database the ES256 key activates on its first use (this call)
    const jwks = createLocalJWKSet((await app.inject({ method: "GET", url: MCP_IDENTITY_OIDC_JWKS_PATH })).json());
    const { payload, protectedHeader } = await jwtVerify(ex.form.get("subject_token")!, jwks, { issuer: `${ORIGIN}/mcp-identity`, audience: AS_ID });
    expect(protectedHeader.alg).toBe("ES256");
    expect(payload.sub).toBe(pairwiseSubject(identitySecretsFor(DATA_KEY)!.pairwiseKey, AS_ID, userId));
    expect(payload.sub).not.toBe(userId);
    expect(payload.scope).toBe("tickets.read tickets.search");
    expect(payload.exp! - payload.iat!).toBe(60);
    // the upstream's tools/call carries the exchanged token, and nothing else in Authorization
    const tc = toolCalls(before);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.headers.authorization).toBe(`Bearer ${issuedTokens[0]}`);
    // the trail: an "issued" row naming the scope and audience, and a fingerprint, never the token
    const issued = await lastAudit(UPSTREAM_EXCHANGE_RULE_IDS.issued);
    expect(issued!.detail).toMatchObject({ phase: "token-exchange", action: TOOL, audience: AUD, grantedScope: "tickets.read tickets.search", tokenFormat: "jwt" });
    expect(JSON.stringify(issued)).not.toContain(issuedTokens[0]!);
    expect(JSON.stringify(issued)).not.toContain(ex.form.get("subject_token")!);
  });

  it("NO CACHING: two calls by one person are two exchanges, two subject tokens, two upstream tokens", async () => {
    const asBefore = asSeen.length;
    issuedTokens = [];
    expect((await call()).kind).toBe("allowed");
    expect((await call()).kind).toBe("allowed");
    const two = asSeen.slice(asBefore);
    expect(two).toHaveLength(2);
    expect(decodeJwt(two[0]!.form.get("subject_token")!).jti).not.toBe(decodeJwt(two[1]!.form.get("subject_token")!).jti);
    expect(new Set(issuedTokens).size).toBe(2);
  });
});

describe("ADR-0238 — every refusal denies the call and sends the upstream nothing", () => {
  async function refused(code: string, forUser = userId, toolName = TOOL) {
    const before = up.seen.length;
    const out = await call(forUser, toolName);
    expect(out.kind).toBe("denied");
    expect(toolCalls(before)).toHaveLength(0);
    const row = await lastAudit(UPSTREAM_EXCHANGE_RULE_IDS.refused);
    expect(row!.effect).toBe("deny");
    expect((row!.detail as { code: string }).code).toBe(code);
    return row!;
  }

  it("DEFAULT-DENY: a granted tool with no mapped scope is refused before any exchange", async () => {
    const asBefore = asSeen.length;
    await refused("not_configured_for_action", userId, UNMAPPED);
    expect(asSeen.length).toBe(asBefore);
  });

  it("WRONG AUDIENCE: a token audienced to another upstream is refused", async () => {
    answer = async (req) => ({
      status: 200,
      body: { access_token: await mintAt({ aud: "https://another-upstream.example", exp: nowS() + 60, scope: req.form.get("scope") }), token_type: "Bearer", expires_in: 60 },
    });
    await refused("audience_mismatch");
  });

  it("SCOPE WIDENING: an answer granting more than the tool's scopes is refused (in the answer or inside the JWT)", async () => {
    answer = async (req) => ({
      status: 200,
      body: { access_token: await mintAt({ aud: AUD, exp: nowS() + 60 }), token_type: "Bearer", expires_in: 60, scope: `${req.form.get("scope")} tickets.delete` },
    });
    await refused("scope_widened");
    answer = async (req) => ({
      status: 200,
      body: { access_token: await mintAt({ aud: AUD, exp: nowS() + 60, scope: "admin" }), token_type: "Bearer", expires_in: 60, scope: req.form.get("scope") },
    });
    await refused("scope_widened");
  });

  it("EXPIRED: an already-expired token is refused; so is a lifetime past the configured ceiling", async () => {
    answer = async () => ({ status: 200, body: { access_token: await mintAt({ aud: AUD, exp: nowS() - 300 }), token_type: "Bearer", expires_in: 60 } });
    await refused("expired");
    answer = async () => ({ status: 200, body: { access_token: `opaque-${randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: 3600 } });
    await refused("expiry_too_long");
  });

  it("REPLAY: a token the authorization server hands out a second time is never attached again", async () => {
    const fixed = await mintAt({ aud: AUD, exp: nowS() + 120, jti: `fixed-${RUN}` });
    answer = async () => ({ status: 200, body: { access_token: fixed, token_type: "Bearer", expires_in: 120 } });
    const before = up.seen.length;
    expect((await call()).kind).toBe("allowed");
    expect(toolCalls(before)[0]!.headers.authorization).toBe(`Bearer ${fixed}`);
    const row = await refused("token_replayed");
    expect(JSON.stringify(row)).not.toContain(fixed);
    const claims = await db.select().from(replayClaims).where(eq(replayClaims.namespace, "upstream_exchanged_token"));
    expect(claims.some((c) => c.key === createHash("sha256").update(fixed).digest("base64url"))).toBe(true);
  });

  it("ANOTHER USER'S TOKEN: a token issued for one person and handed to another is refused; each subject is their own", async () => {
    const shared = await mintAt({ aud: AUD, exp: nowS() + 120, jti: `shared-${RUN}` });
    answer = async () => ({ status: 200, body: { access_token: shared, token_type: "Bearer", expires_in: 120 } });
    const asBefore = asSeen.length;
    expect((await call(userId)).kind).toBe("allowed");
    await refused("token_replayed", otherUserId);
    const [a, b] = asSeen.slice(asBefore);
    const subA = decodeJwt(a!.form.get("subject_token")!).sub;
    const subB = decodeJwt(b!.form.get("subject_token")!).sub;
    expect(subA).not.toBe(subB);
    expect(subB).toBe(pairwiseSubject(identitySecretsFor(DATA_KEY)!.pairwiseKey, AS_ID, otherUserId));
  });

  it("an error from the token endpoint is refused, and its body is never stored", async () => {
    answer = async () => ({ status: 400, body: { error: "invalid_scope", error_description: `leaky-${RUN}` } });
    const row = await refused("endpoint_error");
    expect(JSON.stringify(row)).not.toContain(`leaky-${RUN}`);
  });

  it("an endpoint that is not on the egress allow-list is refused without being contacted", async () => {
    await db.update(upstreamTokenExchanges).set({ tokenEndpoint: `https://not-allowed-${RUN}.example.test/token` }).where(eq(upstreamTokenExchanges.mcpServerId, serverId));
    const asBefore = asSeen.length;
    try {
      await refused("egress_blocked");
      expect(asSeen.length).toBe(asBefore);
    } finally {
      await db.update(upstreamTokenExchanges).set({ tokenEndpoint: TOKEN_ENDPOINT }).where(eq(upstreamTokenExchanges.mcpServerId, serverId));
    }
  });
});

describe("ADR-0238 — the connector path", () => {
  const invoke = (operation: "read" | "write") =>
    app.inject({ method: "POST", url: `/v1/connectors/${connectorId}/invoke`, headers: adminKeyFor(), payload: { operation, object: "records", payload: { q: 1 } } });
  let userKey: { authorization: string } | null = null;
  const adminKeyFor = () => userKey!;

  it("the operation's scopes are exchanged and the token replaces the (absent) stored credential; unmapped = refused", async () => {
    const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "te-conn" } });
    expect(k.statusCode, k.body).toBe(201);
    userKey = { authorization: `Bearer ${k.json().token}` };
    const set = await throughStepUp("PUT", exUrl("connectors"), config({ resource: undefined, scopes: { read: ["records.read"] } }));
    expect(set.statusCode, set.body).toBe(201);

    issuedTokens = [];
    const asBefore = asSeen.length;
    const before = conn.seen.length;
    const r = await invoke("read");
    expect(r.statusCode, r.body).toBe(200);
    expect(asSeen.slice(asBefore)[0]!.form.get("scope")).toBe("records.read");
    expect(conn.seen.slice(before)[0]!.headers.authorization).toBe(`Bearer ${issuedTokens[0]}`);

    const w = await invoke("write");
    expect(w.statusCode, w.body).toBe(403);
    expect(w.json()).toMatchObject({ error: "upstream_token_exchange_refused", code: "not_configured_for_action" });
    expect(conn.seen.length).toBe(before + 1);
    expect(w.body).not.toContain(issuedTokens[0]!);
  });
});

describe("ADR-0238 — a url move turns it off, and nothing ever logs a token", () => {
  it("a url move disables the exchange (audited); the next call carries no token and exchanges nothing", async () => {
    const moved = `${up.url}?moved=1`;
    const p = await app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: adminKey, payload: { url: moved } });
    // the url move may need its own step-up in this posture; either way the exchange must not survive it
    if (p.statusCode === 403) {
      const token = await grantFor(p.json().action);
      const again = await app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: { ...CSRF, [STEP_UP_HEADER]: token }, cookies: { regulait_session: admin.session }, payload: { url: moved } });
      expect(again.statusCode, again.body).toBe(200);
    } else {
      expect(p.statusCode, p.body).toBe(200);
    }
    const [row] = await db.select().from(upstreamTokenExchanges).where(eq(upstreamTokenExchanges.mcpServerId, serverId));
    expect(row!.enabled).toBe(false);
    const asBefore = asSeen.length;
    expect((await call()).kind).toBe("allowed");
    expect(asSeen.length).toBe(asBefore);
    await db.update(mcpServers).set({ url: up.url }).where(eq(mcpServers.id, serverId));
  });

  it("clearing needs a step-up and destroys the secret", async () => {
    const r = await throughStepUp("DELETE", exUrl());
    expect(r.statusCode, r.body).toBe(200);
    expect(await db.select().from(upstreamTokenExchanges).where(eq(upstreamTokenExchanges.mcpServerId, serverId))).toHaveLength(0);
    expect(await lastAudit(UPSTREAM_EXCHANGE_RULE_IDS.cleared)).toBeTruthy();
  });

  it("no log line carries an issued token, a subject token or the client secret", () => {
    const logs = logLines.join("\n");
    expect(logs).not.toContain(CLIENT_SECRET);
    for (const t of issuedTokens) expect(logs).not.toContain(t);
    for (const s of asSeen) expect(logs).not.toContain(s.form.get("subject_token")!);
  });
});

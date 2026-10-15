/**
 * ADR-0188 S8 — OUTBOUND MCP IDENTITY, on a real database, against a real upstream double that records every
 * request it receives (method and `RegulAIt-Identity-Assertion` header):
 *
 *  - the strict default (`none`) sends nothing, on any request;
 *  - turning it on is a relaxation: an API key is refused `step_up_required`; a person in a browser session is
 *    asked for a step-up bound to the server, its url and the value, and with the passkey grant it is saved and
 *    audited as a relaxation;
 *  - a second opted-in server with the same canonical audience is refused 409 before any step-up;
 *  - a person's tools/call carries exactly one assertion, on the tools/call request only, verifiable against the
 *    gateway's own JWKS route, with the documented claims (pairwise sub, no act) and its own audited jti;
 *  - an in-process agent's call carries the chain in `act`, each agent as a PAIRWISE id (never its SPIFFE ID);
 *  - a governed protocol call (resources/read) and the MCP proxy route carry one too;
 *  - ZERO UPSTREAM CONTACT on every refusal: no data key, no issuer, no active signing key, the protocol path's
 *    refusal, a policy deny and an approval hold on an opted-in server; none of them writes an "issued" row;
 *  - a url move turns it off; keeping it on at a new url needs a step-up bound to that url.
 *  - the S8 follow-up, "disclose agent workload IDs" (migration 0196): off, `act.sub` is pairwise; on, it is the
 *    agent's SPIFFE ID, and the issued row says so; turning it on needs the step-up (combined with turning
 *    propagation on into ONE step-up); it is refused 409 while propagation is off; a url move and propagation turning
 *    off reset it, audited; turning it off needs nothing; the compare-and-set includes the column (a concurrent change
 *    to it alone is 409 `changed_concurrently`); the audit row is in the write's transaction (a refused audit insert
 *    rolls the change back).
 *
 * Global state (M-068): org settings this file changes are put back, the issuer keys it activated are retired, and
 * the admin's passkey, sessions and step-up grants are removed (B4S-06) in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  identitySigningKeys,
  inArray,
  mcpServers,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  stepUpGrants,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { canonicalMcpAudience, IDENTITY_ASSERTION_HEADER, IDENTITY_ASSERTION_TYP, IDENTITY_SIGNING_KEY_ENV, STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, pairwiseSubject } from "./delegated-token.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { pairwiseActor } from "./mcp-identity-assertion.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { executeGovernedProtocolCall } from "./mcp-protocol.js";
import { startInProcessChain, toolScopeItems } from "./in-process-delegation.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { grantOwnGrantsForTest } from "./testing/agent-own-grants.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `s8-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
// the deployment's public URL: the issuer, and the passkey relying party's origin (a host name, not an IP literal)
const ISSUER = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "s8-synthetic-data-key-".padEnd(64, "q");
const PAIRWISE = deriveIdentitySecrets(DATA_KEY).pairwiseKey;
const TOOL = `s8_read_${RUN}`;
const UNGRANTED = `s8_ungranted_${RUN}`;
const HELD = `s8_held_${RUN}`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ISSUER;

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let keyDir: string;
let nextKeyFile: string;
let up: { url: string; seen: Array<{ method: string | null; assertion: string | null }>; close: () => Promise<void> };
let serverId: string;
let twinId: string;
let agentId: string;
let userId: string;
let adminKey: { authorization: string };
let admin: { id: string; session: string; auth: SoftAuthenticator };
let priorMethods: string[] = [];
const restores: Array<() => Promise<void>> = [];
const sessions: string[] = [];

async function startUpstream() {
  const seen: Array<{ method: string | null; assertion: string | null }> = [];
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
        const h = req.headers[IDENTITY_ASSERTION_HEADER.toLowerCase()];
        seen.push({ method: req.method === "POST" ? method : `${req.method}`, assertion: typeof h === "string" ? h : null });
        const server = new McpServer({ name: "s8-upstream", version: "0.0.1" });
        for (const name of [TOOL, UNGRANTED, HELD]) {
          server.registerTool(name, { description: "s8", inputSchema: {}, annotations: { readOnlyHint: name === TOOL } }, async () => ({
            content: [{ type: "text", text: "ok" }],
          }));
        }
        server.registerResource("readme", "file:///s8/readme.md", { mimeType: "text/markdown" }, async (uri) => ({
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: "s8 readme" }],
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
  return {
    // a run-unique path: the audience never equals one a leftover row from another run holds
    url: `http://127.0.0.1:${addr.port}/mcp-${RUN}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        httpServer.closeAllConnections();
        httpServer.close(() => r());
      }),
  };
}

/** what the upstream received while `fn` ran */
async function received(fn: () => Promise<unknown>) {
  const before = up.seen.length;
  await fn();
  return up.seen.slice(before);
}

async function verifyAgainstJwks(assertion: string, audience: string) {
  const jwks = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
  expect(jwks.statusCode).toBe(200);
  const { payload, protectedHeader } = await jwtVerify(assertion, createLocalJWKSet(jwks.json() as JSONWebKeySet), {
    issuer: ISSUER,
    audience,
    typ: IDENTITY_ASSERTION_TYP,
    algorithms: ["EdDSA"],
    maxTokenAge: "60s",
  });
  return { payload, protectedHeader };
}

const lastAudit = async (ruleId: string, server: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.serverId, server))).orderBy(desc(auditLog.seq)).limit(1))[0];
const issuedCount = async () =>
  (await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.ruleId, "mcp-identity-assertion-issued"), eq(auditLog.serverId, serverId)))).length;

const patchByKey = (payload: Record<string, unknown>, id = serverId) =>
  app.inject({ method: "PATCH", url: `/v1/servers/${id}`, headers: adminKey, payload });
const patchBySession = (payload: Record<string, unknown>, extra: Record<string, string> = {}, id = serverId) =>
  app.inject({ method: "PATCH", url: `/v1/servers/${id}`, headers: { ...CSRF, ...extra }, cookies: { regulait_session: admin.session }, payload });

/** a passkey step-up grant for exactly `action` (the facts the gateway asked for) */
async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const asAdmin = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: CSRF, cookies: { regulait_session: admin.session }, payload: payload as object });
  const o = await asAdmin("/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: admin.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/**
 * A relaxing PATCH: an API key is refused (an API key cannot confirm who is acting, and its refusal names no
 * action); the person is asked for a step-up bound to exactly `facts`; with that grant it is done.
 */
async function relaxThroughStepUp(payload: Record<string, unknown>, facts: Record<string, unknown>) {
  const key = await patchByKey(payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", credential: "api_key" });
  const asked = await patchBySession(payload);
  expect(asked.statusCode, asked.body).toBe(403);
  expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: ["passkey"] });
  expect(asked.json().action).toEqual({ kind: "settings_relax", body: facts });
  const token = await grantFor(asked.json().action);
  return patchBySession(payload, { [STEP_UP_HEADER]: token });
}

function writeKey(file: string): void {
  writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorMethods = (org?.mcpProtocolMethods ?? []) as string[];
  restores.push(async () => {
    await db.update(orgSettings).set({ mcpProtocolMethods: priorMethods as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  await db.update(orgSettings).set({ mcpProtocolMethods: ["resources/read"] as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  // the strict step-up values (the defaults; the #378 suite writes the same): a relaxation needs a fresh step-up
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);

  keyDir = mkdtempSync(path.join(os.tmpdir(), "s8-issuer-"));
  writeKey(path.join(keyDir, "issuer.pem"));
  nextKeyFile = path.join(keyDir, "next.pem");
  writeKey(nextKeyFile);
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });

  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  up = await startUpstream();
  const inject = (method: "POST", url: string, payload: unknown) => app.inject({ method, url, headers: AUTH, payload: payload as object });
  const s = await inject("POST", "/v1/servers", { name: `s8-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  expect(s.json().identityPropagation).toBe("none");
  // a second server whose canonical audience is the same (the query is not part of it)
  const twin = await inject("POST", "/v1/servers", { name: `s8-twin-${RUN}`, url: `${up.url}?tenant=b` });
  expect(twin.statusCode, twin.body).toBe(201);
  twinId = twin.json().id;
  for (const [name, kind] of [[TOOL, "read"], [UNGRANTED, "write"], [HELD, "write"]] as const) {
    expect((await inject("POST", `/v1/servers/${serverId}/tools`, { name, kind })).statusCode).toBe(201);
  }
  const u = await inject("POST", "/v1/users", { email: `s8-user-${RUN}@example.com`, displayName: `s8 user ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  for (const toolName of [TOOL, HELD, "mcp:resources"]) {
    expect((await inject("POST", "/v1/grants/tools", { userId, serverId, toolName })).statusCode).toBe(201);
  }
  const adm = await inject("POST", "/v1/users", { email: `s8-admin-${RUN}@example.com`, displayName: `s8 admin ${RUN}`, isAdmin: true });
  expect(adm.statusCode, adm.body).toBe(201);
  const adminId = adm.json().id as string;
  adminKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adminId}/keys`, { name: "s8" })).json().token}` };
  const ag = await inject("POST", "/v1/agents", { name: `s8-agent-${RUN}`, provider: "mock", tier: 0, model: "mock-1" });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = ag.json().id;
  // an approval rule on HELD: the next call by the user queues for the admin
  const rule = await inject("POST", "/v1/rules/approvals", { userId, serverId, toolName: HELD, approverUserId: adminId });
  expect(rule.statusCode, rule.body).toBe(201);

  // the admin's browser session and passkey, enrolled LAST: from here the bootstrap credential passes no step-up (B4S-06)
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
  admin = { id: adminId, session: token, auth: new SoftAuthenticator({ origin: ISSUER }) };
  const opt = await app.inject({ method: "POST", url: "/v1/auth/passkeys/registration-options", headers: CSRF, cookies: { regulait_session: token }, payload: {} });
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/passkeys",
    headers: CSRF,
    cookies: { regulait_session: token },
    payload: { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "s8" },
  });
  expect(reg.statusCode, reg.body).toBe(201);
}, 120_000);

afterAll(async () => {
  // B4S-06 first, in its own try: a passkey left behind would close the bootstrap step-up allowance for every later
  // suite (M-040/M-042), so no failing restore below may skip it
  try {
    if (admin) {
      await db.delete(stepUpGrants).where(eq(stepUpGrants.userId, admin.id));
      await db.delete(webauthnChallenges).where(eq(webauthnChallenges.userId, admin.id));
      await forgetStepUpMethodsForTest(db, [admin.id]);
      await db.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, admin.id));
    }
    if (sessions.length > 0) await db.delete(authSessions).where(inArray(authSessions.id, sessions));
  } finally {
    await restoreRest();
  }
});

async function restoreRest() {
  try {
    // this suite's servers stop receiving identity, so no leftover opted-in row can claim their audience
    const ids = [serverId, twinId].filter((id): id is string => typeof id === "string");
    if (ids.length > 0) {
      await db.update(mcpServers).set({ identityPropagation: "none", discloseAgentWorkloadIds: false }).where(inArray(mcpServers.id, ids));
    }
    await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
    for (const r of restores.reverse()) await r();
    if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
    else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
    delete process.env[IDENTITY_SIGNING_KEY_ENV];
    app?.server.closeAllConnections();
    await app?.close();
  } finally {
    await up?.close();
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  }
}

/** a governed tools/call by the user; `dataKey` is passed through as given (no default: undefined means none) */
const callWith = (dataKey: string | undefined, toolName = TOOL, delegationGrantId?: string) =>
  executeGovernedToolCall(db, dataKey, { userId, serverId, toolName, ...(delegationGrantId ? { delegationGrantId } : {}) });
const call = () => callWith(DATA_KEY);

describe("S8 — the strict default sends nothing", () => {
  it("identity_propagation none: the call is served and no request carries an assertion", async () => {
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.some((r) => r.method === "tools/call")).toBe(true);
    expect(got.every((r) => r.assertion === null)).toBe(true);
  });
});

describe("S8 — turning it on is an audited relaxation", () => {
  it("an API key is refused; the person's step-up is bound to the server, its url and the value; saved and audited", async () => {
    const ok = await relaxThroughStepUp(
      { identityPropagation: "signed_assertion" },
      { op: "mcp_server_update", serverId, url: up.url, values: { identityPropagation: "signed_assertion" } },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().identityPropagation).toBe("signed_assertion");
    const row = await lastAudit("mcp-server-identity-propagation-changed", serverId);
    expect(row!.detail).toMatchObject({
      from: { identityPropagation: "none" },
      to: { identityPropagation: "signed_assertion" },
      relaxation: true,
      relaxed: { identityPropagation: "signed_assertion" },
      stepUp: "passkey",
      audience: canonicalMcpAudience(up.url),
    });
  });

  it("a second server with the same canonical audience is refused 409 before any step-up, and nothing is saved", async () => {
    const refused = await patchBySession({ identityPropagation: "signed_assertion" }, {}, twinId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("identity_audience_shared");
    const [twin] = (await db.execute(sql`select identity_propagation from mcp_servers where id = ${twinId}`) as unknown as { rows: Array<{ identity_propagation: string }> }).rows;
    expect(twin!.identity_propagation).toBe("none");
  });
});

describe("S8 — a signed assertion on every allowed call", () => {
  it("a person's tools/call: one assertion, on the tools/call request only, verifiable against our JWKS, with the documented claims", async () => {
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    const carrying = got.filter((r) => r.assertion !== null);
    expect(carrying.map((r) => r.method)).toEqual(["tools/call"]);
    const aud = canonicalMcpAudience(up.url)!;
    const { payload, protectedHeader } = await verifyAgainstJwks(carrying[0]!.assertion!, aud);
    expect(protectedHeader.typ).toBe(IDENTITY_ASSERTION_TYP);
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sub"]);
    expect(payload.sub).toBe(pairwiseSubject(PAIRWISE, aud, userId));
    expect(payload.exp! - payload.iat!).toBe(60);
    const issued = await lastAudit("mcp-identity-assertion-issued", serverId);
    expect(issued!.userId).toBe(userId);
    expect(issued!.detail).toMatchObject({ method: "tools/call", jti: payload.jti, sub: payload.sub, audience: aud, actorChain: null });
    expect(JSON.stringify(issued!.detail)).not.toContain(carrying[0]!.assertion!);
  });

  it("every call gets its own jti", async () => {
    const a = await received(() => call());
    const b = await received(() => call());
    const jtis = [...a, ...b].filter((r) => r.assertion).map((r) => decodeJwt(r.assertion!).jti);
    expect(jtis).toHaveLength(2);
    expect(new Set(jtis).size).toBe(2);
  });

  it("an in-process agent's call carries the chain in act, as a pairwise id (never its SPIFFE ID)", async () => {
    const identityId = await grantOwnGrantsForTest(db, { kind: "agent", id: agentId }, { tools: [{ serverId, toolName: TOOL }] });
    const [ident] = (await db.execute(sql`select identifier from workload_identities where id = ${identityId}`) as unknown as { rows: Array<{ identifier: string }> }).rows;
    const chain = await startInProcessChain(db, {
      sponsorUserId: userId,
      projectId: null,
      context: { runId: randomUUID() },
      hops: [{ identityId, scope: toolScopeItems([{ serverId, toolName: TOOL, kind: "read" }]), capMicros: null }],
    });
    const got = await received(async () => expect((await callWith(DATA_KEY, TOOL, chain.leafGrantId)).kind).toBe("allowed"));
    const carrying = got.filter((r) => r.assertion !== null);
    expect(carrying).toHaveLength(1);
    const aud = canonicalMcpAudience(up.url)!;
    const { payload } = await verifyAgainstJwks(carrying[0]!.assertion!, aud);
    expect(payload.act).toEqual({ sub: pairwiseActor(PAIRWISE, aud, identityId) });
    expect(JSON.stringify(payload)).not.toContain(ident!.identifier);
    expect(JSON.stringify(payload)).not.toContain(identityId);
    expect(payload.sub).toBe(pairwiseSubject(PAIRWISE, aud, userId));
    const issued = await lastAudit("mcp-identity-assertion-issued", serverId);
    expect(issued!.detail).toMatchObject({ actorChain: [identityId], act: [pairwiseActor(PAIRWISE, aud, identityId)] });
  });

  it("a governed protocol call (resources/read) carries one, on that request only", async () => {
    const got = await received(async () => {
      const out = await executeGovernedProtocolCall(db, { userId, serverId, method: "resources/read", params: { uri: "file:///s8/readme.md" }, dataKey: DATA_KEY });
      expect(out.kind).toBe("allowed");
    });
    expect(got.filter((r) => r.assertion !== null).map((r) => r.method)).toEqual(["resources/read"]);
  });

  it("through the MCP proxy route: the route's data key reaches the call", async () => {
    const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "s8-route" } });
    expect(key.statusCode, key.body).toBe(201);
    const client = new Client({ name: "s8-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), { requestInit: { headers: { authorization: `Bearer ${key.json().token}` } } }));
    try {
      let result: unknown;
      const got = await received(async () => {
        result = await client.callTool({ name: TOOL, arguments: {} });
      });
      expect((result as { isError?: boolean }).isError ?? false, JSON.stringify(result)).toBe(false);
      expect(got.filter((r) => r.assertion !== null).map((r) => r.method)).toEqual(["tools/call"]);
    } finally {
      await client.close();
    }
  });
});

describe("S8 — every refusal on an opted-in server: zero upstream contact, nothing issued", () => {
  async function refusedWithoutContact(fn: () => Promise<{ kind: string; decision?: { ruleId: string } }>, expected: { kind: string; ruleId?: string }) {
    const before = await issuedCount();
    let out: { kind: string; decision?: { ruleId: string } } | undefined;
    const got = await received(async () => {
      out = await fn();
    });
    expect(out!.kind).toBe(expected.kind);
    if (expected.ruleId) expect(out!.decision!.ruleId).toBe(expected.ruleId);
    expect(got).toEqual([]);
    expect(await issuedCount()).toBe(before);
  }

  it("no data key (no pairwise key): refused and audited", async () => {
    await refusedWithoutContact(() => callWith(undefined), { kind: "denied", ruleId: "mcp-identity-assertion-unavailable" });
    expect((await lastAudit("mcp-identity-assertion-unavailable", serverId))!.detail).toMatchObject({ code: "pairwise_key_unavailable", method: "tools/call" });
  });

  it("no issuer (REGULAIT_PUBLIC_URL unset): refused and audited", async () => {
    delete process.env.REGULAIT_PUBLIC_URL;
    try {
      await refusedWithoutContact(() => call(), { kind: "denied", ruleId: "mcp-identity-assertion-unavailable" });
    } finally {
      process.env.REGULAIT_PUBLIC_URL = ISSUER;
    }
    expect((await lastAudit("mcp-identity-assertion-unavailable", serverId))!.detail).toMatchObject({ code: "issuer_not_configured" });
  });

  it("the protocol path's refusal (no data key)", async () => {
    await refusedWithoutContact(
      () => executeGovernedProtocolCall(db, { userId, serverId, method: "resources/read", params: { uri: "file:///s8/readme.md" } }) as Promise<{ kind: string; decision?: { ruleId: string } }>,
      { kind: "denied", ruleId: "mcp-identity-assertion-unavailable" },
    );
    expect((await lastAudit("mcp-identity-assertion-unavailable", serverId))!.detail).toMatchObject({ code: "pairwise_key_unavailable", method: "resources/read" });
  });

  it("a policy deny (an ungranted tool) never arms and never contacts", async () => {
    await refusedWithoutContact(() => callWith(DATA_KEY, UNGRANTED), { kind: "denied", ruleId: "default-deny" });
  });

  it("an approval hold never arms and never contacts", async () => {
    await refusedWithoutContact(() => callWith(DATA_KEY, HELD), { kind: "approval_required" });
  });

  it("no active signing key: refused and audited; a rotation brings it back", async () => {
    await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
    await refusedWithoutContact(() => call(), { kind: "denied", ruleId: "mcp-identity-assertion-unavailable" });
    expect((await lastAudit("mcp-identity-assertion-unavailable", serverId))!.detail).toMatchObject({ code: "signing_key_unavailable" });
    process.env[IDENTITY_SIGNING_KEY_ENV] = nextKeyFile;
    const k1 = (await configuredIdentitySigningKeys())[0]!;
    await rotateIdentitySigningKey(db, { kid: k1.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.filter((r) => r.assertion !== null)).toHaveLength(1);
  });
});

describe("S8 — the opt-in does not follow the url", () => {
  it("keeping it on at a new url is a step-up bound to that url, audited; a silent url move turns it off, audited", async () => {
    const moved = `${up.url}/v2`;
    const kept = await relaxThroughStepUp(
      { url: moved, identityPropagation: "signed_assertion" },
      { op: "mcp_server_update", serverId, url: moved, values: { identityPropagation: "signed_assertion" } },
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toMatchObject({ url: moved, identityPropagation: "signed_assertion" });
    expect((await lastAudit("mcp-server-identity-propagation-changed", serverId))!.detail).toMatchObject({
      from: { identityPropagation: "signed_assertion" },
      to: { identityPropagation: "signed_assertion" },
      url: moved,
      relaxation: true,
    });

    // a url move that says nothing about identity turns it off: no step-up (an API key may do it), audited
    const silent = await patchByKey({ url: up.url });
    expect(silent.statusCode, silent.body).toBe(200);
    expect(silent.json()).toMatchObject({ url: up.url, identityPropagation: "none" });
    const row = await lastAudit("mcp-server-identity-propagation-changed", serverId);
    expect(row!.detail).toMatchObject({ from: { identityPropagation: "signed_assertion" }, to: { identityPropagation: "none" }, relaxation: false, resetByUrlMove: true });
    // and the next call sends nothing
    const got = await received(() => call());
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((r) => r.assertion === null)).toBe(true);
    // an explicit none asks for nothing either
    expect((await patchByKey({ identityPropagation: "none" })).statusCode).toBe(200);
  });
});

describe("S8 follow-up — disclose agent workload IDs (migration 0196)", () => {
  const column = async () =>
    (
      (await db.execute(sql`select identity_propagation, disclose_agent_workload_ids from mcp_servers where id = ${serverId}`)) as unknown as {
        rows: Array<{ identity_propagation: string; disclose_agent_workload_ids: boolean }>;
      }
    ).rows[0]!;

  /** an in-process agent's tools/call; returns the one assertion it carried and the agent's identity */
  async function agentCall() {
    const identityId = await grantOwnGrantsForTest(db, { kind: "agent", id: agentId }, { tools: [{ serverId, toolName: TOOL }] });
    const [ident] = (await db.execute(sql`select identifier from workload_identities where id = ${identityId}`) as unknown as { rows: Array<{ identifier: string }> }).rows;
    const chain = await startInProcessChain(db, {
      sponsorUserId: userId,
      projectId: null,
      context: { runId: randomUUID() },
      hops: [{ identityId, scope: toolScopeItems([{ serverId, toolName: TOOL, kind: "read" }]), capMicros: null }],
    });
    const got = await received(async () => expect((await callWith(DATA_KEY, TOOL, chain.leafGrantId)).kind).toBe("allowed"));
    const carrying = got.filter((r) => r.assertion !== null);
    expect(carrying).toHaveLength(1);
    const { payload } = await verifyAgainstJwks(carrying[0]!.assertion!, canonicalMcpAudience(up.url)!);
    return { payload, identityId, identifier: ident!.identifier };
  }

  it("is refused 409 while identity propagation is off, before any step-up, and nothing is saved", async () => {
    expect(await column()).toEqual({ identity_propagation: "none", disclose_agent_workload_ids: false });
    for (const res of [await patchByKey({ discloseAgentWorkloadIds: true }), await patchBySession({ discloseAgentWorkloadIds: true })]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: "agent_id_disclosure_needs_assertion" });
      expect(res.json().detail).toMatch(/only inside a signed identity assertion.*Nothing was saved/);
    }
    // turning propagation OFF in the same request is no way round it
    const both = await patchBySession({ identityPropagation: "none", discloseAgentWorkloadIds: true });
    expect(both.statusCode, both.body).toBe(409);
    expect(await column()).toEqual({ identity_propagation: "none", disclose_agent_workload_ids: false });
  });

  it("the database refuses the pair too (CHECK mcp_servers_disclose_agent_ids_check)", async () => {
    const err = await db.execute(sql`update mcp_servers set disclose_agent_workload_ids = true where id = ${serverId}`).then(
      () => null,
      (e: unknown) => e as { message?: string; constraint?: string; cause?: { message?: string; constraint?: string } },
    );
    expect(err, "the statement was refused").not.toBeNull();
    expect([err!.message, err!.constraint, err!.cause?.message, err!.cause?.constraint].join(" ")).toMatch(/mcp_servers_disclose_agent_ids_check/);
    expect(await column()).toEqual({ identity_propagation: "none", disclose_agent_workload_ids: false });
  });

  it("off (the default): an agent's act.sub is the pairwise id, and the issued row says nothing was disclosed", async () => {
    const on = await relaxThroughStepUp(
      { identityPropagation: "signed_assertion" },
      { op: "mcp_server_update", serverId, url: up.url, values: { identityPropagation: "signed_assertion" } },
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ identityPropagation: "signed_assertion", discloseAgentWorkloadIds: false });
    const { payload, identityId, identifier } = await agentCall();
    expect(payload.act).toEqual({ sub: pairwiseActor(PAIRWISE, canonicalMcpAudience(up.url)!, identityId) });
    expect(JSON.stringify(payload)).not.toContain(identifier);
    expect((await lastAudit("mcp-identity-assertion-issued", serverId))!.detail).toMatchObject({
      jti: payload.jti,
      agentIdsDisclosed: false,
      actorIdForm: "pairwise",
    });
    // put propagation back off for the combined step-up below
    expect((await patchByKey({ identityPropagation: "none" })).statusCode).toBe(200);
  });

  it("on: needs the step-up (one, combined with turning propagation on), and act.sub is then the agent's SPIFFE ID", async () => {
    const on = await relaxThroughStepUp(
      { identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true },
      {
        op: "mcp_server_update",
        serverId,
        url: up.url,
        values: { identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true },
      },
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true });
    const changed = await lastAudit("mcp-server-agent-id-disclosure-changed", serverId);
    expect(changed!.detail).toMatchObject({
      from: { discloseAgentWorkloadIds: false },
      to: { discloseAgentWorkloadIds: true },
      relaxation: true,
      relaxed: { discloseAgentWorkloadIds: true },
      stepUp: "passkey",
      url: up.url,
      audience: canonicalMcpAudience(up.url),
    });
    expect((await lastAudit("mcp-server-identity-propagation-changed", serverId))!.detail).toMatchObject({ relaxation: true, stepUp: "passkey" });

    const { payload, identityId, identifier } = await agentCall();
    expect(identifier).toMatch(/^spiffe:\/\//);
    expect(payload.act).toEqual({ sub: identifier });
    // the person stays pairwise: only the agents are disclosed
    expect(payload.sub).toBe(pairwiseSubject(PAIRWISE, canonicalMcpAudience(up.url)!, userId));
    expect((await lastAudit("mcp-identity-assertion-issued", serverId))!.detail).toMatchObject({
      jti: payload.jti,
      actorChain: [identityId],
      act: [identifier],
      agentIdsDisclosed: true,
      actorIdForm: "workload_id",
    });
    // a person calling directly has no agent to disclose: the row says so
    const direct = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(direct.filter((r) => r.assertion !== null)).toHaveLength(1);
    expect((await lastAudit("mcp-identity-assertion-issued", serverId))!.detail).toMatchObject({ act: null, agentIdsDisclosed: false });
  });

  it("enabling it alone (propagation already on) is a step-up bound to the server, its url and the value; off needs nothing", async () => {
    const off = await patchByKey({ discloseAgentWorkloadIds: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ identityPropagation: "signed_assertion", discloseAgentWorkloadIds: false });
    expect((await lastAudit("mcp-server-agent-id-disclosure-changed", serverId))!.detail).toMatchObject({
      from: { discloseAgentWorkloadIds: true },
      to: { discloseAgentWorkloadIds: false },
      relaxation: false,
    });
    const on = await relaxThroughStepUp(
      { discloseAgentWorkloadIds: true },
      { op: "mcp_server_update", serverId, url: up.url, values: { discloseAgentWorkloadIds: true } },
    );
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ discloseAgentWorkloadIds: true });
  });

  it("turning identity propagation off turns it off too, audited, with no step-up", async () => {
    const off = await patchByKey({ identityPropagation: "none" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ identityPropagation: "none", discloseAgentWorkloadIds: false });
    expect((await lastAudit("mcp-server-agent-id-disclosure-changed", serverId))!.detail).toMatchObject({
      from: { discloseAgentWorkloadIds: true },
      to: { discloseAgentWorkloadIds: false },
      relaxation: false,
      resetByPropagationOff: true,
    });
  });

  it("a url move resets it: silently off (audited), or kept on only through a step-up bound to the new url", async () => {
    const on = await relaxThroughStepUp(
      { identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true },
      { op: "mcp_server_update", serverId, url: up.url, values: { identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true } },
    );
    expect(on.statusCode, on.body).toBe(200);
    const moved = `${up.url}/v3`;
    // kept on: both values are relaxations bound to the new url, in one step-up
    const kept = await relaxThroughStepUp(
      { url: moved, identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true },
      { op: "mcp_server_update", serverId, url: moved, values: { identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true } },
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toMatchObject({ url: moved, identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true });
    expect((await lastAudit("mcp-server-agent-id-disclosure-changed", serverId))!.detail).toMatchObject({
      from: { discloseAgentWorkloadIds: true },
      to: { discloseAgentWorkloadIds: true },
      url: moved,
      relaxation: true,
    });
    // moving back and keeping only the identity: the disclosure resets, the identity needs its own step-up
    const partial = await relaxThroughStepUp(
      { url: up.url, identityPropagation: "signed_assertion" },
      { op: "mcp_server_update", serverId, url: up.url, values: { identityPropagation: "signed_assertion" } },
    );
    expect(partial.statusCode, partial.body).toBe(200);
    expect(partial.json()).toMatchObject({ url: up.url, identityPropagation: "signed_assertion", discloseAgentWorkloadIds: false });
    expect((await lastAudit("mcp-server-agent-id-disclosure-changed", serverId))!.detail).toMatchObject({
      to: { discloseAgentWorkloadIds: false },
      resetByUrlMove: true,
    });
    // and the next agent call is pairwise again
    const { payload, identityId } = await agentCall();
    expect(payload.act).toEqual({ sub: pairwiseActor(PAIRWISE, canonicalMcpAudience(up.url)!, identityId) });

    // a silent url move with both on turns both off, with no step-up
    const again = await relaxThroughStepUp(
      { discloseAgentWorkloadIds: true },
      { op: "mcp_server_update", serverId, url: up.url, values: { discloseAgentWorkloadIds: true } },
    );
    expect(again.statusCode, again.body).toBe(200);
    const silent = await patchByKey({ url: moved });
    expect(silent.statusCode, silent.body).toBe(200);
    expect(silent.json()).toMatchObject({ url: moved, identityPropagation: "none", discloseAgentWorkloadIds: false });
    expect((await lastAudit("mcp-server-agent-id-disclosure-changed", serverId))!.detail).toMatchObject({
      to: { discloseAgentWorkloadIds: false },
      relaxation: false,
      resetByUrlMove: true,
    });
    expect((await patchByKey({ url: up.url })).statusCode).toBe(200);
  });

  it("the PATCH compare-and-set includes the column: a concurrent change to it alone refuses the write 409", async () => {
    // fixture, written directly: both on (the CHECK allows the pair)
    await db.update(mcpServers).set({ identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true }).where(eq(mcpServers.id, serverId));
    const [named] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, serverId));
    const locker = createDb(DATABASE_URL!);
    let res: Awaited<ReturnType<typeof patchByKey>> | undefined;
    try {
      await locker.transaction(async (tx) => {
        // hold the row: the PATCH reads the committed row (disclose = true), then its UPDATE waits on this lock
        await tx.execute(sql`select id from mcp_servers where id = ${serverId} for update`);
        const pending = patchByKey({ name: `${named!.name}-renamed`, discloseAgentWorkloadIds: false }).then((r) => (res = r));
        const deadline = Date.now() + 15_000;
        for (;;) {
          const waiting = (await db.execute(sql`select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike 'update "mcp_servers"%'`)) as unknown as { rows: Array<{ n: number }> };
          if (waiting.rows[0]!.n > 0) break;
          if (res !== undefined || Date.now() > deadline) throw new Error(`the PATCH never waited on the row lock (${res?.statusCode ?? "pending"})`);
          await new Promise((r) => setTimeout(r, 50));
        }
        // the concurrent change touches ONLY this column (url, ranges and propagation stay as the PATCH read them)
        await tx.update(mcpServers).set({ discloseAgentWorkloadIds: false }).where(eq(mcpServers.id, serverId));
        void pending;
      });
      while (res === undefined) await new Promise((r) => setTimeout(r, 20));
    } finally {
      await locker.$client.end();
    }
    expect(res!.statusCode, res!.body).toBe(409);
    expect(res!.json().error).toBe("changed_concurrently");
    const [after] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(after!.name).toBe(named!.name);
  });

  it("the audit row is written in the same transaction: if it cannot be written, the change is rolled back", async () => {
    await db.update(mcpServers).set({ identityPropagation: "signed_assertion", discloseAgentWorkloadIds: true }).where(eq(mcpServers.id, serverId));
    // a trigger scoped to THIS server and rule refuses the audit insert; dropped in finally (no state leaks)
    const fn = `s8_refuse_audit_${RUN}`;
    await db.execute(
      sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin
        if new.rule_id = 'mcp-server-agent-id-disclosure-changed' and new.server_id = '${serverId}'::uuid then
          raise exception 's8 test: audit insert refused';
        end if;
        return new;
      end $$`),
    );
    await db.execute(sql.raw(`create trigger ${fn} before insert on audit_log for each row execute function ${fn}()`));
    let res: Awaited<ReturnType<typeof patchByKey>>;
    try {
      res = await patchByKey({ discloseAgentWorkloadIds: false });
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${fn} on audit_log`));
      await db.execute(sql.raw(`drop function if exists ${fn}()`));
    }
    expect(res.statusCode, res.body).toBe(500);
    expect(await column()).toEqual({ identity_propagation: "signed_assertion", disclose_agent_workload_ids: true });
    // with the audit writable again, the same change goes through and is on the trail
    const ok = await patchByKey({ discloseAgentWorkloadIds: false });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await lastAudit("mcp-server-agent-id-disclosure-changed", serverId))!.detail).toMatchObject({ to: { discloseAgentWorkloadIds: false } });
  });
});

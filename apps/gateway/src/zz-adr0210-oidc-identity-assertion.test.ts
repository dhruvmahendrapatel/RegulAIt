/**
 * ADR-0210 — THE OIDC-COMPATIBLE MCP IDENTITY ASSERTION, on a real database, against a real upstream double that
 * records every request it receives (its method, `Authorization` and `RegulAIt-Identity-Assertion`):
 *
 *  - the OIDC discovery document (issuer `<public URL>/mcp-identity`, jwks_uri, ES256 only) and its JWKS (the ES256
 *    public halves only); the workload identity JWKS lists no ES256 key, and neither document collides with `/federation`;
 *  - the per-server profile: refused without propagation, without a scope or with a malformed one (before any step-up);
 *    turning it on is a `settings_relax` step-up bound to the server, its url and the values, audited as a relaxation;
 *  - mutual exclusion with an ADR-0204 Bearer credential, in both directions;
 *  - the call: EVERY request of the governed call's connection carries `Authorization: Bearer <ES256 JWT>`, verified
 *    here with `jose` against the JWKS the discovery document names, with a pinned issuer, audience and algorithm, and
 *    the `scope` claim; no `RegulAIt-Identity-Assertion` header; each request has its own audited jti;
 *  - a url move returns the server to the default profile (audited); a revoked ES256 key leaves the JWKS and the next
 *    call is refused with ZERO upstream contact.
 *
 * Global state (M-068): the issuer keys this file activated are retired, its servers stop receiving identity, and the
 * admin's passkey, sessions and step-up grants are removed (B4S-06) in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
  mcpServerUpstreamCredentials,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  stepUpGrants,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import {
  canonicalMcpAudience,
  FEDERATION_DISCOVERY_PATH,
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_SIGNING_KEY_ENV,
  MCP_IDENTITY_OIDC_DISCOVERY_PATH,
  STEP_UP_HEADER,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, pairwiseSubject } from "./delegated-token.js";
import { configuredIdentitySigningKeys, revokeIdentitySigningKey, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
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
const BOOT = `oidc-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://localhost";
const OIDC_ISSUER = `${ISSUER}/mcp-identity`;
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "a210".repeat(16);
const PAIRWISE = deriveIdentitySecrets(DATA_KEY).pairwiseKey;
const TOOL = `oidc_write_${RUN}`;
const SCOPE = "read write";
const SYSTEM = "00000000-0000-0000-0000-000000000000";
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ISSUER;

type Seen = { method: string | null; authorization: string | null; assertionHeader: string | null };
let db: Db;
let app: ReturnType<typeof buildApp>;
let keyDir: string;
let esKid: string;
let up: { url: string; seen: Seen[]; close: () => Promise<void> };
let serverId: string;
let userId: string;
let adminKey: { authorization: string };
let admin: { id: string; session: string; auth: SoftAuthenticator };
const restores: Array<() => Promise<void>> = [];
const sessions: string[] = [];

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
        const a = req.headers.authorization;
        const h = req.headers[IDENTITY_ASSERTION_HEADER.toLowerCase()];
        seen.push({
          method: req.method === "POST" ? method : `${req.method}`,
          authorization: typeof a === "string" ? a : null,
          assertionHeader: typeof h === "string" ? h : null,
        });
        const server = new McpServer({ name: "oidc-upstream", version: "0.0.1" });
        server.registerTool(TOOL, { description: "oidc", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
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
    url: `http://127.0.0.1:${addr.port}/mcp-${RUN}`,
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

const lastAudit = async (ruleId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.serverId, serverId))).orderBy(desc(auditLog.seq)).limit(1))[0];
const serverRow = async () => (await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)))[0]!;

const patchByKey = (payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: adminKey, payload });
const patchBySession = (payload: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: { ...CSRF, ...extra }, cookies: { regulait_session: admin.session }, payload });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const asAdmin = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: CSRF, cookies: { regulait_session: admin.session }, payload: payload as object });
  const o = await asAdmin("/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: admin.auth.authenticate(o.json().passkey.options) });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** a relaxing PATCH: an API key is refused; the person's step-up is bound to exactly `facts`; with it, done */
async function relaxThroughStepUp(payload: Record<string, unknown>, facts: Record<string, unknown>) {
  const key = await patchByKey(payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  const asked = await patchBySession(payload);
  expect(asked.statusCode, asked.body).toBe(403);
  expect(asked.json().action).toEqual({ kind: "settings_relax", body: facts });
  return patchBySession(payload, { [STEP_UP_HEADER]: await grantFor(asked.json().action) });
}

/** the OIDC JWKS, fetched from the path the discovery document names */
async function oidcJwks(): Promise<JSONWebKeySet> {
  const disco = await app.inject({ method: "GET", url: MCP_IDENTITY_OIDC_DISCOVERY_PATH });
  const jwksPath = new URL(disco.json().jwks_uri as string).pathname;
  const jwks = await app.inject({ method: "GET", url: jwksPath });
  expect(jwks.statusCode).toBe(200);
  return jwks.json() as JSONWebKeySet;
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

  // ONE operator key file holding an Ed25519 key and a P-256 key: each becomes its algorithm's signer
  keyDir = mkdtempSync(path.join(os.tmpdir(), "adr0210-issuer-"));
  const pem = (k: KeyObject) => k.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(
    path.join(keyDir, "issuer.pem"),
    pem(generateKeyPairSync("ed25519").privateKey) + pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey),
    { mode: 0o600 },
  );
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const configured = await configuredIdentitySigningKeys();
  expect(configured.map((k) => k.algorithm).sort()).toEqual(["ES256", "Ed25519"]);
  esKid = configured.find((k) => k.algorithm === "ES256")!.kid;
  for (const k of configured) {
    const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys).where(eq(identitySigningKeys.algorithm, k.algorithm));
    if (recorded.length > 0) await rotateIdentitySigningKey(db, { kid: k.kid, actorUserId: SYSTEM });
  }

  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.listen({ port: 0, host: "127.0.0.1" });
  up = await startUpstream();
  const inject = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });
  const s = await inject("/v1/servers", { name: `oidc-server-${RUN}`, url: up.url });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  expect(s.json()).toMatchObject({ identityPropagation: "none", identityAssertionProfile: "regulait_header", identityAssertionScope: null });
  expect((await inject(`/v1/servers/${serverId}/tools`, { name: TOOL, kind: "write" })).statusCode).toBe(201);
  const u = await inject("/v1/users", { email: `oidc-user-${RUN}@example.com`, displayName: `oidc user ${RUN}` });
  userId = u.json().id;
  expect((await inject("/v1/grants/tools", { userId, serverId, toolName: TOOL })).statusCode).toBe(201);
  const adm = await inject("/v1/users", { email: `oidc-admin-${RUN}@example.com`, displayName: `oidc admin ${RUN}`, isAdmin: true });
  const adminId = adm.json().id as string;
  adminKey = { authorization: `Bearer ${(await inject(`/v1/users/${adminId}/keys`, { name: "oidc" })).json().token}` };

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
  const reg = await app.inject({
    method: "POST",
    url: "/v1/auth/passkeys",
    headers: CSRF,
    cookies: { regulait_session: token },
    payload: { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "oidc" },
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
      if (serverId) {
        await db.delete(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId));
        await db
          .update(mcpServers)
          .set({ identityPropagation: "none", identityAssertionProfile: "regulait_header", identityAssertionScope: null })
          .where(eq(mcpServers.id, serverId));
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
});

const call = () => executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: TOOL });

describe("ADR-0210 — the OIDC discovery document and JWKS", () => {
  it("discovery names the issuer, its jwks_uri and ES256 only, under its own path (never /federation)", async () => {
    expect(MCP_IDENTITY_OIDC_DISCOVERY_PATH).toBe("/mcp-identity/.well-known/openid-configuration");
    expect(MCP_IDENTITY_OIDC_DISCOVERY_PATH.startsWith("/federation")).toBe(false);
    expect(MCP_IDENTITY_OIDC_DISCOVERY_PATH).not.toBe(FEDERATION_DISCOVERY_PATH);
    const res = await app.inject({ method: "GET", url: MCP_IDENTITY_OIDC_DISCOVERY_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      issuer: OIDC_ISSUER,
      jwks_uri: `${ISSUER}/mcp-identity/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["ES256"],
      subject_types_supported: ["pairwise"],
    });
    expect(res.json().claims_supported).toContain("scope");
  });

  it("the OIDC JWKS lists the ES256 public half only; the workload identity JWKS lists no ES256 key", async () => {
    // the ES256 key activates on its first use (the first load of its algorithm), like the Ed25519 one
    await rotateIdentitySigningKey(db, { kid: esKid, actorUserId: SYSTEM }).catch(() => undefined);
    const keys = (await oidcJwks()).keys;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
      expect(Object.keys(k).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    }
    expect(keys.map((k) => k.kid)).toContain(esKid);
    const base = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect((base.json() as JSONWebKeySet).keys.every((k) => k.kty === "OKP" && k.alg === "EdDSA")).toBe(true);
  });
});

describe("ADR-0210 — the per-server profile", () => {
  it("is refused without signed_assertion propagation, before any step-up, and nothing is saved", async () => {
    const r = await patchBySession({ identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("identity_assertion_profile_needs_assertion");
    expect((await serverRow()).identityAssertionProfile).toBe("regulait_header");
  });

  it("is refused without a scope, or with a malformed one (400), before any step-up", async () => {
    const none = await patchBySession({ identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer" });
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json().error).toBe("identity_assertion_scope_invalid");
    for (const bad of ["", " read", "read  write", 'read"', "read\nwrite"]) {
      const r = await patchBySession({ identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: bad });
      expect(r.statusCode, `${JSON.stringify(bad)} ${r.body}`).toBe(400);
    }
    const scopeOnly = await patchBySession({ identityAssertionScope: SCOPE });
    expect(scopeOnly.statusCode).toBe(400);
    expect((await serverRow()).identityPropagation).toBe("none");
  });

  it("an ADR-0204 Bearer credential refuses it (409) before any step-up", async () => {
    await db.insert(mcpServerUpstreamCredentials).values({
      serverId,
      scheme: "bearer",
      headerName: "authorization",
      secretCiphertext: encryptSecret(DATA_KEY, `static-${RUN}-0123456789abcdef`),
      secretLast4: "cdef",
      setBy: admin.id,
    });
    try {
      const r = await patchBySession({ identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("identity_assertion_bearer_conflict");
      expect((await serverRow()).identityAssertionProfile).toBe("regulait_header");
    } finally {
      await db.delete(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId));
    }
  });

  it("turning it on is one settings_relax step-up bound to the server, its url and the values; audited as a relaxation", async () => {
    const ok = await relaxThroughStepUp(
      { identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE },
      {
        op: "mcp_server_update",
        serverId,
        url: up.url,
        values: { identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE },
      },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE });
    const row = await lastAudit("mcp-server-identity-assertion-profile-changed");
    expect(row!.detail).toMatchObject({
      from: { identityAssertionProfile: "regulait_header", identityAssertionScope: null },
      to: { identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE },
      relaxation: true,
      stepUp: "passkey",
      audience: canonicalMcpAudience(up.url),
    });
  });

  it("while it is on, setting a Bearer credential is refused (409) and audited; nothing is stored", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/v1/servers/${serverId}/upstream-credential`,
      headers: { ...CSRF },
      cookies: { regulait_session: admin.session },
      payload: { scheme: "bearer", secret: `static-${RUN}-0123456789abcdef` },
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("identity_assertion_bearer_conflict");
    expect(await db.select().from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId))).toHaveLength(0);
    const refused = await lastAudit("mcp-upstream-credential-refused");
    expect(refused!.detail).toMatchObject({ code: "oidc_bearer_profile" });
    expect(JSON.stringify(refused!.detail)).not.toContain("0123456789abcdef");
  });
});

describe("ADR-0210 — every request of the call carries an ES256 OIDC bearer", () => {
  it("verifies with jose against the discovered JWKS, pinned issuer, audience and algorithm; scope; pairwise sub; audited", async () => {
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.some((r) => r.method === "tools/call")).toBe(true);
    // every request (initialize, the initialized notification, tools/call, …) carries one, and none the S8 header
    expect(got.every((r) => r.authorization?.startsWith("Bearer ") === true)).toBe(true);
    expect(got.every((r) => r.assertionHeader === null)).toBe(true);
    const aud = canonicalMcpAudience(up.url)!;
    const jwks = createLocalJWKSet(await oidcJwks());
    const jtis = new Set<string>();
    for (const r of got) {
      const token = r.authorization!.slice("Bearer ".length);
      const { payload, protectedHeader } = await jwtVerify(token, jwks, { issuer: OIDC_ISSUER, audience: aud, algorithms: ["ES256"], maxTokenAge: "60s" });
      expect(protectedHeader).toMatchObject({ alg: "ES256", typ: "JWT", kid: esKid });
      expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "scope", "sub"]);
      expect(payload.scope).toBe(SCOPE);
      expect(payload.sub).toBe(pairwiseSubject(PAIRWISE, aud, userId));
      jtis.add(payload.jti!);
    }
    expect(jtis.size).toBe(got.length);
    const issued = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mcp-identity-assertion-issued"), eq(auditLog.serverId, serverId)));
    const forCall = issued.filter((i) => jtis.has((i.detail as { jti: string }).jti));
    expect(forCall).toHaveLength(got.length);
    for (const i of forCall) {
      expect(i.detail).toMatchObject({ profile: "oidc_bearer", placement: "authorization_bearer", scope: SCOPE, issuer: OIDC_ISSUER, kid: esKid });
    }
    expect(forCall.map((i) => (i.detail as { method: string }).method)).toContain("tools/call");
  });

  it("the same token never verifies as an EdDSA assertion or under the base issuer", async () => {
    const got = await received(() => call());
    const token = got.find((r) => r.method === "tools/call")!.authorization!.slice("Bearer ".length);
    expect(decodeProtectedHeader(token).alg).toBe("ES256");
    const base = createLocalJWKSet((await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json() as JSONWebKeySet);
    await expect(jwtVerify(token, base, { issuer: ISSUER, algorithms: ["EdDSA"] })).rejects.toThrow();
    await expect(jwtVerify(token, createLocalJWKSet(await oidcJwks()), { issuer: ISSUER, algorithms: ["ES256"] })).rejects.toThrow();
  });
});

describe("ADR-0210 — reset and revocation", () => {
  it("a url move returns the server to the default profile, audited", async () => {
    const moved = `${up.url}/moved`;
    // the move keeps signed_assertion on, which is itself a relaxation bound to the new url
    const r = await relaxThroughStepUp(
      { url: moved, identityPropagation: "signed_assertion" },
      { op: "mcp_server_update", serverId, url: moved, values: { identityPropagation: "signed_assertion" } },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ identityAssertionProfile: "regulait_header", identityAssertionScope: null });
    const row = await lastAudit("mcp-server-identity-assertion-profile-changed");
    expect(row!.detail).toMatchObject({ resetByUrlMove: true, relaxation: false, to: { identityAssertionProfile: "regulait_header" } });
    // back to the registered url, with the profile on again
    const back = await relaxThroughStepUp(
      { url: up.url, identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE },
      {
        op: "mcp_server_update",
        serverId,
        url: up.url,
        values: { identityPropagation: "signed_assertion", identityAssertionProfile: "oidc_bearer", identityAssertionScope: SCOPE },
      },
    );
    expect(back.statusCode, back.body).toBe(200);
  });

  it("a revoked ES256 key leaves the JWKS at once, and the next call is refused with zero upstream contact", async () => {
    await revokeIdentitySigningKey(db, { kid: esKid, actorUserId: admin.id, stepUp: "passkey" });
    const revoked = (await db.select().from(auditLog).where(eq(auditLog.ruleId, "identity-signing-key-revoke")).orderBy(desc(auditLog.seq)).limit(1))[0];
    expect(revoked!.detail).toMatchObject({ kid: esKid, algorithm: "ES256" });
    expect((await oidcJwks()).keys.map((k) => k.kid)).not.toContain(esKid);
    const got = await received(async () => {
      const out = await call();
      expect(out.kind).toBe("denied");
    });
    expect(got).toHaveLength(0);
    const deny = await lastAudit("mcp-identity-assertion-unavailable");
    expect(deny!.detail).toMatchObject({ code: "signing_key_unavailable" });
  });
});

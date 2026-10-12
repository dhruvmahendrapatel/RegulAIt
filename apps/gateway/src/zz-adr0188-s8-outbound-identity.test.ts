/**
 * ADR-0188 S8 — OUTBOUND MCP IDENTITY, on a real database, against a real upstream double that records every
 * request it receives (method and `RegulAIt-Identity-Assertion` header):
 *
 *  - the strict default (`none`) sends nothing, on any request;
 *  - turning it on is a relaxation: an admin's API key is refused `step_up_required` with facts bound to the
 *    server, the url and the value; done with step-up, it is audited as a relaxation;
 *  - a person's tools/call carries exactly one assertion, on the tools/call request only, verifiable against the
 *    gateway's own JWKS route, with the documented claims (pairwise sub, no act) and its own audited jti;
 *  - an in-process agent's call carries the chain in `act`;
 *  - a governed protocol call (resources/read) carries one too;
 *  - the MCP proxy route carries it (the data key reaches the route);
 *  - fail closed: no data key → refused, audited, and the upstream sees nothing at all;
 *  - a url move turns it off (audited); keeping it on at a new url needs a step-up bound to that url.
 *
 * Global state (M-068): org settings this file changes are put back, and the issuer key it activated is retired
 * in afterAll (the S5 pattern).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, auditLog, createDb, desc, eq, identitySigningKeys, ORG_SETTINGS_ID, orgSettings, runMigrations, sql, type Db } from "@regulait/db";
import { canonicalMcpAudience, IDENTITY_ASSERTION_HEADER, IDENTITY_ASSERTION_TYP, IDENTITY_SIGNING_KEY_ENV } from "@regulait/shared";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, pairwiseSubject } from "./delegated-token.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { executeGovernedProtocolCall } from "./mcp-protocol.js";
import { startInProcessChain, toolScopeItems } from "./in-process-delegation.js";
import { grantOwnGrantsForTest } from "./testing/agent-own-grants.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `s8-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://127.0.0.1:4418";
const DATA_KEY = "s8-synthetic-data-key-".padEnd(64, "q");
const PAIRWISE = deriveIdentitySecrets(DATA_KEY).pairwiseKey;
const TOOL = `s8_read_${RUN}`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ISSUER;

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let keyDir: string;
let up: { url: string; seen: Array<{ method: string | null; assertion: string | null }>; close: () => Promise<void> };
let serverId: string;
let userId: string;
let adminKey: { authorization: string };
let priorMethods: string[] = [];
const restores: Array<() => Promise<void>> = [];

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
        server.registerTool(TOOL, { description: "s8 read", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
          content: [{ type: "text", text: "ok" }],
        }));
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
    url: `http://127.0.0.1:${addr.port}/mcp`,
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

const patchServer = (headers: Record<string, string>, payload: Record<string, unknown>, id = serverId) =>
  app.inject({ method: "PATCH", url: `/v1/servers/${id}`, headers, payload });

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
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(keyDir, "issuer.pem"), pem, { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });

  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  up = await startUpstream();
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `s8-server-${RUN}`, url: up.url } });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  expect(s.json().identityPropagation).toBe("none");
  expect((await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: { name: TOOL, kind: "read" } })).statusCode).toBe(201);
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `s8-user-${RUN}@example.com`, displayName: `s8 user ${RUN}` } });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  for (const toolName of [TOOL, "mcp:resources"]) {
    expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName } })).statusCode).toBe(201);
  }
  const adm = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `s8-admin-${RUN}@example.com`, displayName: `s8 admin ${RUN}`, isAdmin: true } });
  expect(adm.statusCode, adm.body).toBe(201);
  adminKey = { authorization: `Bearer ${(await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${adm.json().id}/keys`, payload: { name: "s8" } })).json().token}` };
}, 120_000);

afterAll(async () => {
  try {
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
});

const call = (dataKey: string | undefined = DATA_KEY, delegationGrantId?: string) =>
  executeGovernedToolCall(db, dataKey, { userId, serverId, toolName: TOOL, ...(delegationGrantId ? { delegationGrantId } : {}) });

describe("S8 — the strict default sends nothing", () => {
  it("identity_propagation none: the call is served and no request carries an assertion", async () => {
    const got = await received(async () => expect((await call()).kind).toBe("allowed"));
    expect(got.some((r) => r.method === "tools/call")).toBe(true);
    expect(got.every((r) => r.assertion === null)).toBe(true);
  });
});

describe("S8 — turning it on is an audited relaxation", () => {
  it("an API key is refused step_up_required, bound to the server, its url and the value; with step-up it is saved and audited", async () => {
    const refused = await patchServer(adminKey, { identityPropagation: "signed_assertion" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect(refused.json().action).toEqual({
      kind: "settings_relax",
      body: { op: "mcp_server_update", serverId, url: up.url, values: { identityPropagation: "signed_assertion" } },
    });
    const [still] = await db.execute(sql`select identity_propagation from mcp_servers where id = ${serverId}`).then((r) => (r as unknown as { rows: Array<{ identity_propagation: string }> }).rows);
    expect(still!.identity_propagation).toBe("none");

    const ok = await relaxStepUpAround(db, () => patchServer(adminKey, { identityPropagation: "signed_assertion" }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().identityPropagation).toBe("signed_assertion");
    const row = await lastAudit("mcp-server-identity-propagation-changed", serverId);
    expect(row!.detail).toMatchObject({
      from: { identityPropagation: "none" },
      to: { identityPropagation: "signed_assertion" },
      relaxation: true,
      relaxed: { identityPropagation: "signed_assertion" },
      audience: canonicalMcpAudience(up.url),
    });
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

  it("an in-process agent's call carries the chain in act", async () => {
    const ag = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload: { name: `s8-agent-${RUN}`, provider: "mock", tier: 0, model: "mock-1" } });
    expect(ag.statusCode, ag.body).toBe(201);
    const identityId = await grantOwnGrantsForTest(db, { kind: "agent", id: ag.json().id }, { tools: [{ serverId, toolName: TOOL }] });
    const [ident] = (await db.execute(sql`select identifier from workload_identities where id = ${identityId}`) as unknown as { rows: Array<{ identifier: string }> }).rows;
    const chain = await startInProcessChain(db, {
      sponsorUserId: userId,
      projectId: null,
      context: { runId: randomUUID() },
      hops: [{ identityId, scope: toolScopeItems([{ serverId, toolName: TOOL, kind: "read" }]), capMicros: null }],
    });
    const got = await received(async () => expect((await call(DATA_KEY, chain.leafGrantId)).kind).toBe("allowed"));
    const carrying = got.filter((r) => r.assertion !== null);
    expect(carrying).toHaveLength(1);
    const { payload } = await verifyAgainstJwks(carrying[0]!.assertion!, canonicalMcpAudience(up.url)!);
    expect(payload.act).toEqual({ sub: ident!.identifier });
    expect(payload.sub).toBe(pairwiseSubject(PAIRWISE, canonicalMcpAudience(up.url)!, userId));
    const issued = await lastAudit("mcp-identity-assertion-issued", serverId);
    expect(issued!.detail).toMatchObject({ actorChain: [identityId] });
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
      const got = await received(() => client.callTool({ name: TOOL, arguments: {} }));
      expect(got.filter((r) => r.assertion !== null).map((r) => r.method)).toEqual(["tools/call"]);
    } finally {
      await client.close();
    }
  });
});

describe("S8 — fail closed", () => {
  it("no data key (no pairwise key): refused and audited, and the upstream receives nothing at all", async () => {
    const got = await received(async () => {
      const out = await call(undefined);
      expect(out.kind).toBe("denied");
      expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe("mcp-identity-assertion-unavailable");
    });
    expect(got).toEqual([]);
    const row = await lastAudit("mcp-identity-assertion-unavailable", serverId);
    expect(row).toMatchObject({ effect: "deny", userId });
    expect(row!.detail).toMatchObject({ code: "pairwise_key_unavailable", method: "tools/call" });
  });
});

describe("S8 — the opt-in does not follow the url", () => {
  it("keeping it on at a new url is a step-up bound to that url, audited; a silent url move turns it off, audited", async () => {
    const moved = `${up.url}/v2`;
    const keep = await patchServer(adminKey, { url: moved, identityPropagation: "signed_assertion" });
    expect(keep.statusCode, keep.body).toBe(403);
    expect(keep.json().action.body).toEqual({ op: "mcp_server_update", serverId, url: moved, values: { identityPropagation: "signed_assertion" } });
    // with the step-up it moves and stays on; no identity column changes, and the relaxation is still on the trail
    const kept = await relaxStepUpAround(db, () => patchServer(adminKey, { url: moved, identityPropagation: "signed_assertion" }));
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toMatchObject({ url: moved, identityPropagation: "signed_assertion" });
    expect((await lastAudit("mcp-server-identity-propagation-changed", serverId))!.detail).toMatchObject({
      from: { identityPropagation: "signed_assertion" },
      to: { identityPropagation: "signed_assertion" },
      url: moved,
      relaxation: true,
    });

    // a url move that says nothing about identity turns it off: no step-up, audited
    const silent = await patchServer(adminKey, { url: up.url });
    expect(silent.statusCode, silent.body).toBe(200);
    expect(silent.json()).toMatchObject({ url: up.url, identityPropagation: "none" });
    const row = await lastAudit("mcp-server-identity-propagation-changed", serverId);
    expect(row!.detail).toMatchObject({ from: { identityPropagation: "signed_assertion" }, to: { identityPropagation: "none" }, relaxation: false, resetByUrlMove: true });
    // and the next call sends nothing
    const got = await received(() => call());
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((r) => r.assertion === null)).toBe(true);
    // an explicit none asks for nothing either
    expect((await patchServer(adminKey, { identityPropagation: "none" })).statusCode).toBe(200);
  });
});

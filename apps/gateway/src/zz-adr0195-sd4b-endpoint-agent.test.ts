/**
 * ADR-0195 SD4b — the endpoint agent's gateway side, end to end (real database).
 *
 *  - enrolment is off until the endpoint agent source is enabled; the admin
 *    routes are admin-only; a token is shown once and only its digest is kept;
 *  - ticket redemption: the device cap, a revoked, expired or unknown token;
 *  - registration with a runtime-generated P-256 key: idempotent for the same
 *    key, refused past the identity cap, on an expired ticket or another OS;
 *  - the agent's self token (ES256 private_key_jwt + DPoP) and its route ceiling;
 *  - signed reports: accepted and merged as `endpoint_agent` device findings;
 *    unsigned, another device's signature, a replayed signature, a stale
 *    snapshot, an oversized body and a mismatched OS are refused; a retry is a
 *    duplicate;
 *  - an environment-variable name, a key name, the hostname and the device user
 *    are never stored in clear (reports, findings, runs, audit);
 *  - key rotation, and device revocation stopping uploads and token minting;
 *  - the report table's guard (no UPDATE of evidence, no DELETE but its parent's cascade, no TRUNCATE: 0185's rule);
 *  - the device cap and the identity cap under concurrent requests.
 *
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import {
  aiEndpointSignatures,
  auditLog,
  createDb,
  discoveryRuns,
  discoverySources,
  endpointAgentIdentities,
  endpointAgentReports,
  endpointDevices,
  endpointEnrolmentTokens,
  eq,
  inArray,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, issueDpopNonce } from "./delegated-token.js";
import { contentDigestOf, ENDPOINT_REPORT_MAX_BYTES } from "./endpoint-agent.js";
import { runEndpointAgentIngest } from "./endpoint-agent-routes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `sd4b-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`sd4b-data-key-${RUN}`).digest("hex");
const HOST = `sd4b-host-${RUN}`;
const DEVICE_USER = `sd4buser${RUN}`;
const ENV_NAME = `SD4B_SECRET_ENV_${RUN.toUpperCase()}`;
const KEY_NAME = `SD4B_KEY_NAME_${RUN.toUpperCase()}`;
const BUNDLE = `com.example.sd4b-${RUN}`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberKey: { authorization: string };
let adminId: string;
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
let signatureId: string;

type Method = "GET" | "POST";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const nonce = () => issueDpopNonce(deriveIdentitySecrets(DATA_KEY).nonceKey);
const b64sha = (v: string) => createHash("sha256").update(v).digest("base64url");

/** a device key the test holds: P-256, made at run time, as the agent's TPM/DPAPI key is */
class AgentKey {
  private access: string | null = null;
  private constructor(
    readonly privateKey: CryptoKey,
    readonly jwk: { kty: "EC"; crv: "P-256"; x: string; y: string },
    readonly jkt: string,
  ) {}
  static async make(): Promise<AgentKey> {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const j = (await exportJWK(publicKey)) as { x: string; y: string };
    const jwk = { kty: "EC" as const, crv: "P-256" as const, x: j.x, y: j.y };
    return new AgentKey(privateKey, jwk, await calculateJwkThumbprint(jwk as JWK, "sha256"));
  }
  get clientId() {
    return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${this.jkt}`;
  }
  async proof(method: string, url: string, ath?: string) {
    const p: Record<string, unknown> = { htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), nonce: nonce() };
    if (ath) p.ath = ath;
    return new SignJWT(p).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: this.jwk as JWK }).sign(this.privateKey);
  }
  async tokenRequest() {
    const iat = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.jkt })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(`${ORIGIN}/oauth/token`)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(this.privateKey);
    const form = {
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      resource: `${ORIGIN}/v1/endpoint-agent`,
    };
    return app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: await this.proof("POST", `${ORIGIN}/oauth/token`) },
      payload: new URLSearchParams(form).toString(),
    });
  }
  async token() {
    if (this.access) return this.access;
    const r = await this.tokenRequest();
    expect(r.statusCode, r.body).toBe(200);
    this.access = (r.json() as { access_token: string }).access_token;
    return this.access;
  }
  reset() {
    this.access = null;
  }
  async headers(method: Method, p: string) {
    const t = await this.token();
    return { authorization: `DPoP ${t}`, dpop: await this.proof(method, `${ORIGIN}${p}`, b64sha(t)) };
  }
  async reportSignature(body: string, o: { snapshotId: string; jti?: string; iat?: number; key?: AgentKey }) {
    const k = o.key ?? this;
    return new SignJWT({ snapshotId: o.snapshotId, contentDigest: contentDigestOf(Buffer.from(body)) })
      .setProtectedHeader({ alg: "ES256", typ: "regulait-endpoint-report+jwt", kid: k.jkt })
      .setIssuer(k.clientId)
      .setAudience(`${ORIGIN}/v1/endpoint-agent/reports`)
      .setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000))
      .setJti(o.jti ?? randomUUID())
      .sign(k.privateKey);
  }
  /** POST a report; `signature` overrides the signature header (null: none) */
  async report(body: string, snapshotId: string, o: { signature?: string | null } = {}) {
    const sig = o.signature === undefined ? await this.reportSignature(body, { snapshotId }) : o.signature;
    return app.inject({
      method: "POST",
      url: "/v1/endpoint-agent/reports",
      headers: {
        ...(await this.headers("POST", "/v1/endpoint-agent/reports")),
        "content-type": "application/json",
        "content-digest": contentDigestOf(Buffer.from(body)),
        ...(sig ? { "regulait-report-signature": sig } : {}),
      },
      payload: body,
    });
  }
}

const reportBody = (o: { snapshotId: string; collectedAt?: string; os?: string; facts?: unknown[] }) =>
  JSON.stringify({
    schema: "regulait.endpoint-report/1",
    snapshotId: o.snapshotId,
    collectedAt: o.collectedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    agentVersion: "0.1.0",
    os: o.os ?? "linux",
    arch: "amd64",
    manifestVersion: "1.0.0",
    manifestDigest: "0".repeat(64),
    keyProtection: "hardware",
    droppedSnapshots: 0,
    facts: o.facts ?? [
      { kind: "desktop_app", signatureId: "sig.sd4b.app", provider: "example", matchedOn: "desktopId", identifier: BUNDLE, location: { root: "system_applications", path: `${BUNDLE}.desktop` } },
      {
        kind: "assistant_config",
        signatureId: "sig.sd4b.config",
        provider: "example",
        matchedOn: "file",
        identifier: ".config/sd4b/*.json",
        location: { root: "home", path: ".config/sd4b/settings.json" },
        keys: [{ keyName: KEY_NAME, ruleId: "dlp.secret.assignment", present: true }],
      },
      { kind: "env_name", signatureId: "sig.sd4b.env", provider: "example", matchedOn: "envName", identifier: ENV_NAME, location: { root: "home", path: ".profile" } },
    ],
    gaps: [{ kind: "local_runtime", reason: "other_users_listeners_port_only" }],
    factsDigest: "1".repeat(64),
  });

let seq = 0;
async function agentSource(enabled: boolean) {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `sd4b-agent-${RUN}-${++seq}`, kind: "endpoint_agent", target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  sourceIds.push(id);
  // enabling is SD0's step-up route (covered by SD0's suite); here the row is set directly
  if (enabled) await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, id));
  return id;
}

async function issueToken(sourceId: string, deviceCap: number) {
  const r = await inject("POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH, { label: `sd4b-${RUN}`, deviceCap });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { token: { id: string }; enrolFile: { token: string; issuer: string; schema: string } };
}

const ticketReq = (bulk: string, hostname = HOST) =>
  inject("POST", "/v1/endpoint-agent/enrolment-tickets", { authorization: `Bearer ${bulk}` }, { hostname, os: "linux", arch: "amd64", agentVersion: "0.1.0" });
const registerReq = (ticket: string, key: AgentKey, over: Record<string, unknown> = {}) =>
  inject("POST", "/v1/endpoint-agent/register", { authorization: `Bearer ${ticket}` }, {
    publicJwk: key.jwk,
    keyProtection: "hardware",
    keyProvider: "tpm",
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    deviceUser: DEVICE_USER,
    ...over,
  });

/** a fully enrolled agent on a fresh enabled source */
async function enrolled(deviceCap = 5) {
  const sourceId = await agentSource(true);
  const { enrolFile } = await issueToken(sourceId, deviceCap);
  const t = await ticketReq(enrolFile.token);
  expect(t.statusCode, t.body).toBe(201);
  const key = await AgentKey.make();
  const r = await registerReq(t.json().ticket as string, key);
  expect(r.statusCode, r.body).toBe(201);
  return { sourceId, bulk: enrolFile.token, ticket: t.json().ticket as string, deviceId: t.json().ticketId as string, key, identityId: r.json().identityId as string };
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const u = await inject("POST", "/v1/users", AUTH, { email: `sd4b-member-${RUN}@example.com`, displayName: "sd4b member" });
  const k = await inject("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" });
  memberKey = { authorization: `Bearer ${k.json().token}` };
  const a = await inject("POST", "/v1/users", AUTH, { email: `sd4b-admin-${RUN}@example.com`, displayName: "sd4b admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const [sig] = await db
    .insert(aiEndpointSignatures)
    .values({ provider: `sd4b-${RUN}`, kind: "desktop_app", value: BUNDLE, matchType: "identifier", provenance: "admin", enabled: true })
    .returning({ id: aiEndpointSignatures.id });
  signatureId = sig!.id;
}, 120_000);

afterAll(async () => {
  if (sourceIds.length) {
    const runs = (await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(inArray(discoveryRuns.sourceId, sourceIds))).map((r) => r.id);
    if (runs.length) {
      const imports = (await db.select({ id: shadowAiImports.id }).from(shadowAiImports).where(inArray(shadowAiImports.discoveryRunId, runs))).map((r) => r.id);
      if (imports.length) {
        await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.lastImportId, imports));
        await db.delete(shadowAiImports).where(inArray(shadowAiImports.id, imports));
      }
    }
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  if (signatureId) await db.delete(aiEndpointSignatures).where(eq(aiEndpointSignatures.id, signatureId));
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("ADR-0195 SD4b: enrolment", () => {
  it("is admin-only and off until the endpoint agent source is enabled", async () => {
    const off = await agentSource(false);
    expect((await inject("POST", `/v1/discovery/sources/${off}/enrolment-tokens`, memberKey, { label: "x", deviceCap: 1 })).statusCode).toBe(403);
    expect((await inject("GET", `/v1/discovery/sources/${off}/endpoint-devices`, memberKey)).statusCode).toBe(403);
    expect((await inject("GET", `/v1/discovery/sources/${off}/enrolment-tokens`, memberKey)).statusCode).toBe(403);
    expect((await inject("POST", `/v1/discovery/enrolment-tokens/${randomUUID()}/revoke`, memberKey, {})).statusCode).toBe(403);
    expect((await inject("POST", `/v1/discovery/endpoint-devices/${randomUUID()}/revoke`, memberKey, {})).statusCode).toBe(403);
    const r = await inject("POST", `/v1/discovery/sources/${off}/enrolment-tokens`, AUTH, { label: "x", deviceCap: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("source_disabled");
    // there is no unlimited default: the cap is required, and expiry is at most 30 days
    const on = await agentSource(true);
    expect((await inject("POST", `/v1/discovery/sources/${on}/enrolment-tokens`, AUTH, { label: "x" })).statusCode).toBe(400);
    expect((await inject("POST", `/v1/discovery/sources/${on}/enrolment-tokens`, AUTH, { label: "x", deviceCap: 1, expiresInDays: 31 })).statusCode).toBe(400);
    // a token of a source disabled after issue redeems nothing
    const { enrolFile } = await issueToken(on, 3);
    await db.update(discoverySources).set({ enabled: false, enabledAt: null, enabledBy: null }).where(eq(discoverySources.id, on));
    const t = await ticketReq(enrolFile.token);
    expect(t.statusCode).toBe(403);
    expect(t.json()).toEqual({ error: "enrolment_disabled" });
  });

  it("shows a token once and keeps only its digest", async () => {
    const sourceId = await agentSource(true);
    const out = await issueToken(sourceId, 2);
    expect(out.enrolFile.schema).toBe("regulait.endpoint-enrol/1");
    expect(out.enrolFile.issuer).toBe(ORIGIN);
    expect(out.enrolFile.token).toMatch(/^rgea_[0-9a-f]{64}$/);
    const [row] = await db.select().from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.id, out.token.id));
    expect(row!.tokenHash).toBe(createHash("sha256").update(out.enrolFile.token).digest("hex"));
    const list = await inject("GET", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH);
    expect(list.body).not.toContain(out.enrolFile.token);
    const audits = await db.select({ d: auditLog.detail }).from(auditLog).where(sql`${auditLog.detail}->>'tokenId' = ${out.token.id}`);
    expect(JSON.stringify(audits)).not.toContain(out.enrolFile.token);
  });

  it("redeems one ticket per device up to the cap, and refuses unknown, revoked and expired tokens", async () => {
    const sourceId = await agentSource(true);
    const { enrolFile, token } = await issueToken(sourceId, 1);
    const first = await ticketReq(enrolFile.token);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().ticket).toMatch(/^rgat_[0-9a-f]{64}$/);
    expect(first.json().identityCap).toBe(8);
    expect(Date.parse(first.json().expiresAt) - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    const capped = await ticketReq(enrolFile.token, `${HOST}-2`);
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toEqual({ error: "enrolment_cap_reached" });
    expect((await ticketReq(`rgea_${"0".repeat(64)}`)).statusCode).toBe(401);
    expect((await ticketReq("not-a-token")).statusCode).toBe(401);

    const second = await issueToken(sourceId, 5);
    await db.execute(sql`update endpoint_enrolment_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = ${second.token.id}`);
    const expired = await ticketReq(second.enrolFile.token);
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toEqual({ error: "token_expired" });

    const third = await issueToken(sourceId, 5);
    expect((await inject("POST", `/v1/discovery/enrolment-tokens/${third.token.id}/revoke`, AUTH, {})).statusCode).toBe(200);
    const revoked = await ticketReq(third.enrolFile.token);
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toEqual({ error: "token_revoked" });
    // the cap alert at 100 % was audited
    const [alert] = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'endpoint-enrolment-cap-100' AND ${auditLog.detail}->>'tokenId' = ${token.id}`);
    expect(alert).toBeDefined();
  });

  it("registers a runtime-generated device key once per user, idempotently, within the identity cap", async () => {
    const sourceId = await agentSource(true);
    const { enrolFile } = await issueToken(sourceId, 2);
    const t = await ticketReq(enrolFile.token);
    const ticket = t.json().ticket as string;
    const key = await AgentKey.make();
    const r1 = await registerReq(ticket, key);
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().clientId).toBe(key.clientId);
    const again = await registerReq(ticket, key);
    expect(again.statusCode).toBe(201);
    expect(again.json().identityId).toBe(r1.json().identityId);
    // another OS than the ticket's device, and an inconsistent key protection, are refused
    expect((await registerReq(ticket, await AgentKey.make(), { os: "windows" })).json()).toEqual({ error: "device_mismatch" });
    expect((await registerReq(ticket, await AgentKey.make(), { keyProtection: "software" })).json()).toEqual({ error: "invalid_body" });
    // the identity cap
    await db.update(endpointDevices).set({ identityCap: 1 }).where(eq(endpointDevices.id, t.json().ticketId as string));
    const full = await registerReq(ticket, await AgentKey.make());
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: "ticket_exhausted" });
    // an expired ticket
    const t2 = await ticketReq(enrolFile.token, `${HOST}-b`);
    await db.execute(sql`update endpoint_devices set created_at = now() - interval '8 days', ticket_expires_at = now() - interval '1 day' where id = ${t2.json().ticketId}`);
    const late = await registerReq(t2.json().ticket as string, await AgentKey.make());
    expect(late.statusCode).toBe(410);
    expect(late.json()).toEqual({ error: "ticket_expired" });
    expect((await registerReq(`rgat_${"0".repeat(64)}`, await AgentKey.make())).statusCode).toBe(401);
  });

  it("refuses registration under a ticket whose enrolment token was revoked after it was issued", async () => {
    const sourceId = await agentSource(true);
    const { enrolFile, token } = await issueToken(sourceId, 2);
    const t = await ticketReq(enrolFile.token);
    expect(t.statusCode, t.body).toBe(201);
    expect((await inject("POST", `/v1/discovery/enrolment-tokens/${token.id}/revoke`, AUTH, {})).statusCode).toBe(200);
    const r = await registerReq(t.json().ticket as string, await AgentKey.make());
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "token_revoked" });
  });

  it("holds the device cap and the identity cap under concurrent requests", async () => {
    const N = 5;
    const sourceId = await agentSource(true);
    const { enrolFile, token } = await issueToken(sourceId, 1);
    const tickets = await Promise.all(Array.from({ length: N }, (_, i) => ticketReq(enrolFile.token, `${HOST}-race-${i}`)));
    expect(tickets.map((r) => r.statusCode).sort()).toEqual([201, ...Array(N - 1).fill(409)]);
    for (const r of tickets.filter((x) => x.statusCode === 409)) expect(r.json()).toEqual({ error: "enrolment_cap_reached" });
    const [tok] = await db.select().from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.id, token.id));
    expect(tok!.devicesEnrolled).toBe(1);
    expect((await db.select({ id: endpointDevices.id }).from(endpointDevices).where(eq(endpointDevices.tokenId, token.id))).length).toBe(1);

    const won = tickets.find((r) => r.statusCode === 201)!.json() as { ticket: string; ticketId: string };
    await db.update(endpointDevices).set({ identityCap: 1 }).where(eq(endpointDevices.id, won.ticketId));
    const keys = await Promise.all(Array.from({ length: N }, () => AgentKey.make()));
    const regs = await Promise.all(keys.map((k, i) => registerReq(won.ticket, k, { deviceUser: `${DEVICE_USER}race${i}` })));
    expect(regs.map((r) => r.statusCode).sort()).toEqual([201, ...Array(N - 1).fill(409)]);
    for (const r of regs.filter((x) => x.statusCode === 409)) expect(r.json()).toEqual({ error: "ticket_exhausted" });
    const [dev] = await db.select().from(endpointDevices).where(eq(endpointDevices.id, won.ticketId));
    expect(dev!.identitiesRegistered).toBe(1);
    expect((await db.select().from(endpointAgentIdentities).where(eq(endpointAgentIdentities.deviceId, won.ticketId))).length).toBe(1);
  });
});

describe("ADR-0195 SD4b: the agent's token and signed reports", () => {
  it("mints an ES256 self token that reaches only the agent's routes", async () => {
    const a = await enrolled();
    const cfg = await inject("GET", "/v1/endpoint-agent/config", await a.key.headers("GET", "/v1/endpoint-agent/config"));
    expect(cfg.statusCode).toBe(503);
    expect(cfg.json()).toEqual({ error: "collection_pack_unavailable" });
    const elsewhere = await inject("GET", "/v1/discovery/sources", await a.key.headers("GET", "/v1/discovery/sources"));
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error).toBe("workload_scope");
    // a person's key reaches no agent route
    expect((await inject("GET", "/v1/endpoint-agent/config", AUTH)).statusCode).toBe(401);
  });

  it("accepts a signed report, merges it as an endpoint_agent device finding, and treats a retry as a duplicate", async () => {
    const a = await enrolled();
    const snapshotId = randomUUID();
    const body = reportBody({ snapshotId });
    const r = await a.key.report(body, snapshotId);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toEqual({ accepted: true, duplicate: false });
    await runEndpointAgentIngest(db);
    const [device] = await db.select().from(endpointDevices).where(eq(endpointDevices.id, a.deviceId));
    const findings = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, device!.devicePseudonym));
    expect(findings.length).toBe(1);
    expect(findings[0]!.subjectKind).toBe("device");
    expect(findings[0]!.provider).toBe(`sd4b-${RUN}`);
    expect(findings[0]!.signalSources).toContain("endpoint_agent");
    const [stored] = await db.select().from(endpointAgentReports).where(eq(endpointAgentReports.snapshotId, snapshotId));
    expect(stored!.status).toBe("committed");
    expect(stored!.factsEnvRefused).toBe(1);
    // a retry with a fresh signature is a duplicate, not a second report
    const retry = await a.key.report(body, snapshotId);
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ accepted: true, duplicate: true });
  });

  it("refuses unsigned, wrong-device, replayed, stale, oversized and mismatched reports with fixed codes", async () => {
    const a = await enrolled();
    const other = await AgentKey.make();
    const id = () => randomUUID();
    let s = id();
    expect((await a.key.report(reportBody({ snapshotId: s }), s, { signature: null })).json()).toEqual({ error: "invalid_report_signature" });
    s = id();
    const foreign = await a.key.reportSignature(reportBody({ snapshotId: s }), { snapshotId: s, key: other });
    expect((await a.key.report(reportBody({ snapshotId: s }), s, { signature: foreign })).json()).toEqual({ error: "invalid_report_signature" });
    // the same signature twice: the second is a replay, whatever DPoP proof carries it
    s = id();
    const body = reportBody({ snapshotId: s });
    const once = await a.key.reportSignature(body, { snapshotId: s });
    expect((await a.key.report(body, s, { signature: once })).statusCode).toBe(202);
    const replay = await a.key.report(body, s, { signature: once });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: "report_replayed" });
    s = id();
    const stale = await a.key.report(reportBody({ snapshotId: s, collectedAt: new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z") }), s);
    expect(stale.statusCode).toBe(422);
    expect(stale.json()).toEqual({ error: "report_stale" });
    s = id();
    const oldSig = await a.key.reportSignature(reportBody({ snapshotId: s }), { snapshotId: s, iat: Math.floor(Date.now() / 1000) - 600 });
    expect((await a.key.report(reportBody({ snapshotId: s }), s, { signature: oldSig })).json()).toEqual({ error: "report_signature_stale" });
    s = id();
    expect((await a.key.report(reportBody({ snapshotId: s, os: "windows" }), s)).json()).toEqual({ error: "device_mismatch" });
    s = id();
    const big = reportBody({ snapshotId: s }).replace('"factsDigest"', `"pad":"${"x".repeat(ENDPOINT_REPORT_MAX_BYTES)}","factsDigest"`);
    const tooBig = await a.key.report(big, s);
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toEqual({ error: "report_too_large" });
    // no refusal echoes the device's input
    expect(tooBig.body).not.toContain("xxxx");
    expect((await a.key.report("{not json", id())).json()).toEqual({ error: "invalid_body" });
    // SD4a's snapshot id is a UUID v4: a v7 one is refused even when correctly signed
    const v7 = "0192f0c4-4d5e-7f60-8a7b-1c2d3e4f5a6b";
    expect((await a.key.report(reportBody({ snapshotId: v7 }), v7)).json()).toEqual({ error: "invalid_body" });
  });

  it("never stores the environment-variable name, the key name, the hostname or the device user in clear", async () => {
    const a = await enrolled();
    const snapshotId = randomUUID();
    expect((await a.key.report(reportBody({ snapshotId }), snapshotId)).statusCode).toBe(202);
    await runEndpointAgentIngest(db);
    const reports = await db.select().from(endpointAgentReports).where(eq(endpointAgentReports.deviceId, a.deviceId));
    const devices = await db.select().from(endpointDevices).where(eq(endpointDevices.id, a.deviceId));
    const [device] = devices;
    const findings = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, device!.devicePseudonym));
    const runs = await db.select().from(discoveryRuns).where(eq(discoveryRuns.sourceId, a.sourceId));
    const audits = await db.select({ d: auditLog.detail, r: auditLog.reason }).from(auditLog).where(sql`${auditLog.detail}->>'subsystem' = 'shadow-ai-discovery' AND ${auditLog.detail}->>'slice' = 'SD4b'`);
    const all = JSON.stringify({ reports, devices, findings, runs, audits });
    for (const needle of [ENV_NAME, KEY_NAME, HOST, DEVICE_USER, ".config/sd4b/settings.json"]) expect(all).not.toContain(needle);
    expect(reports[0]!.sightings.map((x) => x.value)).toEqual([BUNDLE]);
  });
});

describe("ADR-0195 SD4b: rotation and revocation", () => {
  it("rotates the device key: the new key reports, the old one mints nothing", async () => {
    const a = await enrolled();
    const next = await AgentKey.make();
    const url = `${ORIGIN}/v1/endpoint-agent/credentials`;
    const proof = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", typ: "regulait-key-rotation+jwt", jwk: next.jwk as JWK })
      .setAudience(url)
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(next.privateKey);
    const r = await inject("POST", "/v1/endpoint-agent/credentials", { ...(await a.key.headers("POST", "/v1/endpoint-agent/credentials")) }, { publicJwk: next.jwk, proof });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({ identityId: a.identityId, clientId: next.clientId });
    a.key.reset();
    expect((await a.key.tokenRequest()).statusCode).not.toBe(200);
    const s = randomUUID();
    expect((await next.report(reportBody({ snapshotId: s }), s)).statusCode).toBe(202);
  });

  it("a revoked device uploads nothing more and mints no token", async () => {
    const a = await enrolled();
    const s = randomUUID();
    expect((await a.key.report(reportBody({ snapshotId: s }), s)).statusCode).toBe(202);
    const rv = await inject("POST", `/v1/discovery/endpoint-devices/${a.deviceId}/revoke`, AUTH, {});
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json().identitiesRevoked).toBe(1);
    const s2 = randomUUID();
    const after = await app.inject({
      method: "POST",
      url: "/v1/endpoint-agent/reports",
      headers: { authorization: `DPoP ${await a.key.token()}`, dpop: await a.key.proof("POST", `${ORIGIN}/v1/endpoint-agent/reports`, b64sha(await a.key.token())), "content-type": "application/json" },
      payload: reportBody({ snapshotId: s2 }),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("device_revoked");
    a.key.reset();
    // the token endpoint refuses the revoked device's client outright (not a 500, not a token)
    const minted = await a.key.tokenRequest();
    expect(minted.statusCode, minted.body).toBe(401);
    expect(minted.json().error).toBe("invalid_client");
    // registering again with the device's ticket is refused too
    expect((await registerReq(a.ticket, await AgentKey.make())).json()).toEqual({ error: "device_revoked" });
    const audited = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'endpoint-device-revoked' AND ${auditLog.detail}->>'deviceId' = ${a.deviceId}`);
    expect(audited.length).toBe(1);
    const list = await inject("GET", `/v1/discovery/sources/${a.sourceId}/endpoint-devices`, AUTH);
    expect(list.json().devices[0].revokedAt).not.toBeNull();
    expect(list.body).not.toContain(HOST);
    expect(list.body).not.toContain(DEVICE_USER);
  });
});

describe("ADR-0195 SD4b: the report table's guard (migration 0185's rule)", () => {
  it("refuses rewriting or deleting a report's evidence, and refuses TRUNCATE", async () => {
    const a = await enrolled();
    const s = randomUUID();
    expect((await a.key.report(reportBody({ snapshotId: s }), s)).statusCode).toBe(202);
    const [row] = await db.select().from(endpointAgentReports).where(eq(endpointAgentReports.snapshotId, s));
    // drizzle wraps the database error ("Failed query: …"); the guard's own message is its cause
    const refusal = async (q: Promise<unknown>) => {
      const e = (await q.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
      return `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
    };
    expect(await refusal(db.execute(sql`update endpoint_agent_reports set sightings = '[]'::jsonb where id = ${row!.id}`))).toMatch(/written once/);
    expect(await refusal(db.execute(sql`update endpoint_agent_reports set status = 'pending', run_id = null, committed_at = null where id = ${row!.id}`))).toMatch(/written once/);
    await expect(db.execute(sql`truncate endpoint_agent_reports`)).rejects.toThrow();
    // a plain DELETE of evidence is refused too
    expect(await refusal(db.execute(sql`delete from endpoint_agent_reports where id = ${row!.id}`))).toMatch(/report is evidence/);
    expect((await db.select({ id: endpointAgentReports.id }).from(endpointAgentReports).where(eq(endpointAgentReports.id, row!.id))).length).toBe(1);
    // the one DELETE admitted is the cascade of the row's own parent
    await db.delete(endpointDevices).where(eq(endpointDevices.id, a.deviceId));
    expect((await db.select({ id: endpointAgentReports.id }).from(endpointAgentReports).where(eq(endpointAgentReports.id, row!.id))).length).toBe(0);
  });
});

/**
 * ADR-0360 slice 2 — EDR integration, end to end (real database, fake vendors behind the real egress guard).
 *
 *  - admin-only; a connection is created read-only; the credential is sealed (never in a response or an audit row) and
 *    a disallowed base URL is refused at write time;
 *  - sync maps each vendor's devices onto the source's enrolled devices by the keyed pseudonym (no host name stored),
 *    folds open alerts into the risk, and audits a rise to high or critical; a blocked host is refused and audited;
 *  - webhooks: a Falcon HMAC and a SentinelOne shared token are accepted once (the replay table) and only fresh; a bad
 *    signature, a stale timestamp and MDE (no webhooks) are refused with one answer;
 *  - isolation is off until relaxed (step-up bound to the connection); a request waits for a second admin, the
 *    requester cannot decide, the approver steps up, the vendor is asked, its action status settles the request, and
 *    a release needs the same plus a settings_relax step-up; the CHECK holds two people;
 *  - two signed-in people, always: the bootstrap credential cannot request an isolation or a release (S4 #1, R2 #1);
 *  - no request is stuck: undecided requests expire, a stranded or unsettled action fails, and the vendor's real state
 *    is reconciled (a failed isolation the vendor did carry out, a release made in the vendor console) (R2 #2-4);
 *  - the vendor credential and the webhook secret rotate in place, step-up gated and audited (R2 #5).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  discoveryPseudonymKeys,
  discoverySources,
  edrConnections,
  edrDeviceSignals,
  edrIsolationRequests,
  egressAllowHosts,
  eq,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { edrCredentialRotateStepUp, edrIsolationDecideStepUp, edrIsolationEnableStepUp, edrReleaseStepUp, edrWebhookSecretRotateStepUp } from "./edr/routes.js";
import { EDR_ACTION_SETTLE_MINUTES, EDR_DECISION_TTL_HOURS, EDR_STRANDED_MINUTES, pollEdrIsolations } from "./edr/service.js";
import { ISOLATION_MACHINE } from "./edr/lifecycle.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e41edr-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e41edr-data-key-${RUN}`).digest("hex");
const VENDOR_HOST = `edr-${RUN}.example.com`;
const BLOCKED_HOST = `blocked-${RUN}.example.com`;
const BASE = `https://${VENDOR_HOST}`;
const HOST_A = `e41edr-a-${RUN}`;
const HOST_B = `e41edr-b-${RUN}`;
// synthetic, derived at runtime: never a secret-shaped literal
const VENDOR_SECRET = createHash("sha256").update(`vendor-${RUN}`).digest("hex");
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = "http://localhost";

/** the fake vendors: one per vendor, routed by path; every request is recorded */
const calls: Array<{ method: string; url: string; auth: string | null; body: string }> = [];
/** `report`: the fake Defender says whether mde-a is isolated (off: it omits the field, as MDE may) */
const state = { isolated: new Set<string>(), report: false };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
  const headers = new Headers(init?.headers);
  calls.push({ method, url: url.pathname + url.search, auth: headers.get("authorization"), body });
  const p = url.pathname;
  if (p.endsWith("/oauth2/v2.0/token") || p === "/oauth2/token") return reply(200, { access_token: "fake-access", token_type: "Bearer", expires_in: 3600 });
  // Defender
  if (p === "/api/machines") return reply(200, { value: [{ id: "mde-a", computerDnsName: HOST_A, riskScore: "Medium", ...(state.report ? { isolated: state.isolated.has("mde-a") } : {}) }, { id: "mde-x", computerDnsName: "not-enrolled", riskScore: "High" }] });
  if (p === "/api/alerts") return reply(200, { value: [{ machineId: "mde-a", severity: "High", status: "New" }, { machineId: "mde-a", severity: "Informational", status: "New" }] });
  if (p === "/api/machines/mde-a/isolate") {
    state.isolated.add("mde-a");
    return reply(201, { id: "action-1", status: "Pending" });
  }
  if (p === "/api/machines/mde-a/unisolate") return reply(201, { id: "action-2", status: "Pending" });
  if (p.startsWith("/api/machineactions/")) return reply(200, { id: p.split("/").pop(), status: p.includes("pending") ? "Pending" : "Succeeded" });
  // SentinelOne
  if (p === "/web/api/v2.1/agents") return reply(200, { data: [{ id: "s1-b", computerName: HOST_B, networkStatus: "connected", activeThreats: 0 }], pagination: { nextCursor: null } });
  if (p === "/web/api/v2.1/threats") return reply(200, { data: [] });
  return reply(404, { error: "no" });
};
const egress = {
  fetchImpl: fakeFetch,
  resolve: async () => [{ address: "93.184.215.14", family: 4 }],
};

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberKey: { authorization: string };
let admin1: string;
let admin2: string;
let sourceId: string;
let deviceA: string;
let deviceB: string;
const restores: Array<() => Promise<void>> = [];
// M-068/M-078: the allow entries this file adds on the shared database, removed through the shared helper
const allowed = trackEgressAllowHosts();

type Method = "GET" | "POST" | "PUT";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
async function asUser(userId: string, method: Method, url: string, payload: unknown, args?: Parameters<typeof grantStepUpForTest>[2]) {
  const g = await grantStepUpForTest(db, userId, args ?? edrIsolationEnableStepUp("00000000-0000-0000-0000-000000000000"));
  return app.inject({ method, url, ...(args ? stepUpRequest(g) : sessionRequest(g)), ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function device(host: string) {
  const t = await inject("POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH, { label: `e41edr-${RUN}`, deviceCap: 1 });
  expect(t.statusCode, t.body).toBe(201);
  const r = await app.inject({ method: "POST", url: "/v1/endpoint-agent/enrolment-tickets", headers: { authorization: `Bearer ${t.json().enrolFile.token}` }, payload: { hostname: host, os: "linux", arch: "amd64", agentVersion: "0.1.0" } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().ticketId as string;
}
async function connection(vendor: string, extra: Record<string, unknown> = {}) {
  const r = await inject("POST", `/v1/discovery/sources/${sourceId}/edr-connections`, AUTH, { vendor, name: `${vendor}-${RUN}-${randomBytes(2).toString("hex")}`, baseUrl: BASE, secret: VENDOR_SECRET, ...extra });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { connection: { id: string; isolationEnabled: boolean }; webhook?: { path: string; secret: string } };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  const prior = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (prior.length) await db.insert(discoveryPseudonymKeys).values(prior);
  });
  // the vendor host and (for Defender) the Entra sign-in host, as an admin allow-lists them
  for (const host of [VENDOR_HOST, "login.microsoftonline.com"]) {
    await db.insert(egressAllowHosts).values({ host: allowed.trackHost(host), note: "e41 edr test" }).onConflictDoNothing();
  }
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, edrEgress: egress });
  await app.ready();
  const u = await inject("POST", "/v1/users", AUTH, { email: `e41edr-member-${RUN}@example.com`, displayName: "member" });
  memberKey = { authorization: `Bearer ${(await inject("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" })).json().token}` };
  for (const n of [1, 2]) {
    const a = await inject("POST", "/v1/users", AUTH, { email: `e41edr-admin${n}-${RUN}@example.com`, displayName: `admin ${n}` });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, a.json().id as string));
    if (n === 1) admin1 = a.json().id as string;
    else admin2 = a.json().id as string;
  }
  const s = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e41edr-${RUN}`, kind: "endpoint_agent", target: { fleet: RUN }, scope: { orgLevel: true, include: [] } });
  sourceId = s.json().id as string;
  await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: admin1 }).where(eq(discoverySources.id, sourceId));
  deviceA = await device(HOST_A);
  deviceB = await device(HOST_B);
}, 120_000);

afterAll(async () => {
  if (sourceId) {
    await db.update(discoverySources).set({ enabled: false }).where(eq(discoverySources.id, sourceId));
    await db.delete(discoverySources).where(eq(discoverySources.id, sourceId));
  }
  (await allowed.removeAll(app, AUTH)).assertRemoved();
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("ADR-0360 EDR: the declared isolation lifecycle", () => {
  it("has no event out of a terminal state and two-step release", () => {
    for (const t of Object.values(ISOLATION_MACHINE.def.transitions)) for (const s of ISOLATION_MACHINE.def.terminal) expect(t.from).not.toContain(s);
    expect(ISOLATION_MACHINE.sourcesOf("approve_release")).toEqual(["release_requested"]);
    expect(ISOLATION_MACHINE.def.transitions.fail_release.to).toBe("isolated");
    // R2 #3: failed is not a dead end; every waiting state has a system way out (expiry, timeout, reconcile)
    expect(ISOLATION_MACHINE.def.terminal).not.toContain("failed");
    expect(ISOLATION_MACHINE.sourcesOf("vendor_isolated")).toEqual(["failed"]);
    for (const [e, from] of [["expire", "requested"], ["expire_release", "release_requested"], ["fail", "submitting"], ["fail_release", "releasing"]] as const) {
      expect(ISOLATION_MACHINE.sourcesOf(e)).toEqual([from]);
      expect(ISOLATION_MACHINE.def.transitions[e].by).toEqual(["system"]);
    }
  });
});

describe("ADR-0360 EDR: connections", () => {
  it("is admin-only, read-only by default, seals the credential and refuses a disallowed host", async () => {
    expect((await inject("POST", `/v1/discovery/sources/${sourceId}/edr-connections`, memberKey, {})).statusCode).toBe(403);
    expect((await inject("GET", "/v1/edr-isolations", memberKey)).statusCode).toBe(403);
    const bad = await inject("POST", `/v1/discovery/sources/${sourceId}/edr-connections`, AUTH, { vendor: "defender", name: "x", baseUrl: BASE, secret: VENDOR_SECRET });
    expect(bad.statusCode).toBe(400);
    const blocked = await inject("POST", `/v1/discovery/sources/${sourceId}/edr-connections`, AUTH, { vendor: "sentinelone", name: "blocked", baseUrl: `https://${BLOCKED_HOST}`, secret: VENDOR_SECRET });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toBe("egress_blocked");
    const c = await connection("sentinelone");
    expect(c.connection.isolationEnabled).toBe(false);
    expect(c.webhook?.secret).toMatch(/^rgedr_[0-9a-f]{64}$/);
    const list = await inject("GET", `/v1/discovery/sources/${sourceId}/edr-connections`, AUTH);
    expect(list.body).not.toContain(VENDOR_SECRET);
    expect(list.body).not.toContain(c.webhook!.secret);
    const [row] = await db.select().from(edrConnections).where(eq(edrConnections.id, c.connection.id));
    expect(row!.secretCiphertext).not.toContain(VENDOR_SECRET);
    const leaked = await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.detail}::text LIKE ${"%" + VENDOR_SECRET + "%"}`);
    expect(leaked).toEqual([]);
  });
});

describe("ADR-0360 EDR: signals", () => {
  it("maps devices by pseudonym, folds alerts into the risk and audits a rise", async () => {
    const c = await connection("defender", { tenantId: "8f0a7c1e-2b3d-4e5f-9a6b-7c8d9e0f1a2b", clientId: "app-client" });
    const r = await inject("POST", `/v1/edr-connections/${c.connection.id}/sync`, AUTH, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ code: "ok", devices: 2, matched: 1 });
    const sig = await inject("GET", `/v1/discovery/sources/${sourceId}/edr-signals`, AUTH);
    const mine = sig.json().signals.filter((s: { connectionId: string }) => s.connectionId === c.connection.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ deviceId: deviceA, risk: "high", alerts: { low: 0, medium: 0, high: 1, critical: 0 } });
    expect(sig.body).not.toContain(HOST_A);
    const raised = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'edr-device-risk-raised' AND ${auditLog.detail}->>'connectionId' = ${c.connection.id}`);
    expect(raised).toHaveLength(1);
    // the client secret went only to the tenant's sign-in endpoint; the API saw only the access token
    const token = calls.find((x) => x.url === "/8f0a7c1e-2b3d-4e5f-9a6b-7c8d9e0f1a2b/oauth2/v2.0/token");
    expect(token?.body).toContain("grant_type=client_credentials");
    expect(calls.filter((x) => x.url.startsWith("/api/")).every((x) => x.auth === "Bearer fake-access" && !x.body.includes(VENDOR_SECRET))).toBe(true);
  });
});

describe("ADR-0360 EDR: webhooks", () => {
  it("accepts a SentinelOne token once and fresh, refuses everything else with one answer", async () => {
    const c = await connection("sentinelone");
    await inject("POST", `/v1/edr-connections/${c.connection.id}/sync`, AUTH, {});
    const ev = (id: string, at = new Date()) => JSON.stringify({ id, createdAt: at.toISOString(), agentRealtimeInfo: { agentId: "s1-b" }, threatInfo: { confidenceLevel: "malicious" } });
    const post = (body: string, token: string) => app.inject({ method: "POST", url: c.webhook!.path, headers: { "content-type": "application/json", "x-regulait-webhook-token": token }, payload: body });
    const ok = await post(ev(`e-${RUN}`), c.webhook!.secret);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await post(ev(`e-${RUN}`), c.webhook!.secret)).json()).toEqual({ ok: true, duplicate: true });
    const [s] = await db.select().from(edrDeviceSignals).where(and2(c.connection.id, deviceB));
    expect(s).toMatchObject({ risk: "high", alertsHigh: 1 });
    for (const bad of [post(ev(`f-${RUN}`), "rgedr_" + "0".repeat(64)), post(ev(`g-${RUN}`, new Date(Date.now() - 3_600_000)), c.webhook!.secret), post("{not json", c.webhook!.secret)]) {
      const r = await bad;
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "invalid_signature" });
    }
  });

  it("verifies a Falcon HMAC over body and delivery timestamp; MDE accepts none", async () => {
    const c = await connection("falcon", { clientId: "falcon-client" });
    const body = JSON.stringify({ meta: { eventid: `cs-${RUN}` }, data: { device: { device_id: "cs-1" }, detections: { severity_name: "High" } } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", c.webhook!.secret).update(body + ts).digest("base64");
    const send = (s: string, t: string) => app.inject({ method: "POST", url: c.webhook!.path, headers: { "content-type": "application/json", "x-cs-primary-signature": s, "x-cs-delivery-timestamp": t }, payload: body });
    expect((await send(sig, ts)).statusCode).toBe(200);
    expect((await send(sig, String(Number(ts) + 1))).statusCode).toBe(401);
    const old = String(Number(ts) - 3600);
    expect((await send(createHmac("sha256", c.webhook!.secret).update(body + old).digest("base64"), old)).statusCode).toBe(401);
    const mde = await connection("defender", { tenantId: "8f0a7c1e-2b3d-4e5f-9a6b-7c8d9e0f1a2b", clientId: "app-client" });
    expect(mde.webhook).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/v1/edr-webhooks/${mde.connection.id}`, headers: { "content-type": "application/json" }, payload: body })).statusCode).toBe(401);
  });
});

function and2(connectionId: string, deviceId: string) {
  return sql`${edrDeviceSignals.connectionId} = ${connectionId} AND ${edrDeviceSignals.deviceId} = ${deviceId}`;
}

describe("ADR-0360 EDR: governed isolation", () => {
  it("is off until relaxed, needs a second admin with a step-up, and a release needs settings_relax", async () => {
    const c = await connection("defender", { tenantId: "8f0a7c1e-2b3d-4e5f-9a6b-7c8d9e0f1a2b", clientId: "app-client" });
    const cid = c.connection.id;
    await inject("POST", `/v1/edr-connections/${cid}/sync`, AUTH, {});
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${cid}/isolations`, { deviceId: deviceA, reason: "r" })).json().error).toBe("isolation_off");
    // turning isolation on: a step-up bound to this connection
    const wrong = await asUser(admin1, "PUT", `/v1/edr-connections/${cid}/settings`, { isolation: true }, edrIsolationEnableStepUp(deviceA));
    expect(wrong.statusCode).toBe(422);
    const on = await asUser(admin1, "PUT", `/v1/edr-connections/${cid}/settings`, { isolation: true }, edrIsolationEnableStepUp(cid));
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().connection.isolationEnabled).toBe(true);
    // admin1 requests
    const reqd = await asUser(admin1, "POST", `/v1/edr-connections/${cid}/isolations`, { deviceId: deviceA, reason: "EDR high risk" });
    expect(reqd.statusCode, reqd.body).toBe(202);
    const id = reqd.json().isolation.id as string;
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${cid}/isolations`, { deviceId: deviceA, reason: "again" })).json().error).toBe("request_open");
    // the requester cannot decide, even with a step-up
    const self = await asUser(admin1, "POST", `/v1/edr-isolations/${id}/approve`, {}, edrIsolationDecideStepUp(id, "approve"));
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("caller_cannot_decide");
    expect(calls.some((x) => x.url.includes("/isolate"))).toBe(false);
    // a step-up for another decision is refused and nothing is sent
    expect((await asUser(admin2, "POST", `/v1/edr-isolations/${id}/approve`, {}, edrIsolationDecideStepUp(id, "reject"))).statusCode).toBe(422);
    expect(calls.some((x) => x.url.includes("/isolate"))).toBe(false);
    const ok = await asUser(admin2, "POST", `/v1/edr-isolations/${id}/approve`, {}, edrIsolationDecideStepUp(id, "approve"));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().isolation.state).toBe("submitting");
    expect(calls.filter((x) => x.url === "/api/machines/mde-a/isolate")).toHaveLength(1);
    expect(await pollEdrIsolations(db, { dataKey: DATA_KEY, egress })).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(edrIsolationRequests).where(eq(edrIsolationRequests.id, id));
    expect(row).toMatchObject({ state: "isolated", requestedBy: admin1, decidedBy: admin2, vendorActionId: "action-1" });
    // the CHECK: two people, whatever writes the row
    await expect(db.update(edrIsolationRequests).set({ decidedBy: admin1 }).where(eq(edrIsolationRequests.id, id))).rejects.toThrow();
    // release: admin2 asks, admin1 approves with settings_relax
    expect((await asUser(admin2, "POST", `/v1/edr-isolations/${id}/request_release`, {})).json().isolation.state).toBe("release_requested");
    expect((await asUser(admin2, "POST", `/v1/edr-isolations/${id}/approve_release`, {}, edrReleaseStepUp(id))).statusCode).toBe(403);
    const rel = await asUser(admin1, "POST", `/v1/edr-isolations/${id}/approve_release`, {}, edrReleaseStepUp(id));
    expect(rel.statusCode, rel.body).toBe(200);
    expect(rel.json().isolation.state).toBe("releasing");
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    const [done] = await db.select().from(edrIsolationRequests).where(eq(edrIsolationRequests.id, id));
    expect(done!.state).toBe("released");
    expect((await asUser(admin2, "POST", `/v1/edr-isolations/${id}/request_release`, {})).json().error).toBe("illegal_transition");
    const rules = (await db.select({ r: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'requestId' = ${id}`)).map((x) => x.r);
    expect(rules).toEqual(expect.arrayContaining(["edr-isolation-requested", "edr-isolation-approve", "edr-isolate-submitted", "edr-isolate-succeeded", "edr-isolation-request-release", "edr-isolation-approve-release", "edr-release-succeeded"]));
  });
});

/** a request row written straight to the table, for the system paths (the routes cannot age a row) */
async function row(connectionId: string, values: Partial<typeof edrIsolationRequests.$inferInsert> & { ageMinutes: number }) {
  const { ageMinutes, ...rest } = values;
  const [r] = await db
    .insert(edrIsolationRequests)
    .values({ connectionId, deviceId: deviceA, vendorDeviceId: "mde-a", reason: "system path", requestedBy: admin1, ...rest, updatedAt: sql`now() - make_interval(mins => ${ageMinutes})` })
    .returning();
  return r!.id;
}
const stateOf = async (id: string) => (await db.select().from(edrIsolationRequests).where(eq(edrIsolationRequests.id, id)))[0]!;
const rulesOf = async (id: string) => (await db.select({ r: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'requestId' = ${id}`)).map((x) => x.r);
const defender = () => connection("defender", { tenantId: "8f0a7c1e-2b3d-4e5f-9a6b-7c8d9e0f1a2b", clientId: "app-client" });

describe("ADR-0360 EDR: two signed-in people (S4 #1, R2 #1)", () => {
  it("refuses an isolation or a release requested with the bootstrap credential, and the CHECKs need a named requester", async () => {
    const c = await defender();
    const cid = c.connection.id;
    await inject("POST", `/v1/edr-connections/${cid}/sync`, AUTH, {});
    expect((await asUser(admin1, "PUT", `/v1/edr-connections/${cid}/settings`, { isolation: true }, edrIsolationEnableStepUp(cid))).statusCode).toBe(200);
    const boot = await inject("POST", `/v1/edr-connections/${cid}/isolations`, AUTH, { deviceId: deviceA, reason: "bootstrap" });
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("user_required");
    expect(await db.select().from(edrIsolationRequests).where(eq(edrIsolationRequests.connectionId, cid))).toEqual([]);
    // an isolated request: the bootstrap credential cannot ask for its release, nor decide it
    const id = await row(cid, { state: "isolated", decidedBy: admin2, ageMinutes: 0 });
    for (const ev of ["request_release", "approve_release", "reject"]) {
      const r = await inject("POST", `/v1/edr-isolations/${id}/${ev}`, AUTH, {});
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("user_required");
    }
    expect((await stateOf(id)).state).toBe("isolated");
    // whatever writes the table: no requester, or a release decided with no named release requester, is refused
    await expect(db.insert(edrIsolationRequests).values({ connectionId: cid, deviceId: deviceB, vendorDeviceId: "x", reason: "r", requestedBy: null as unknown as string })).rejects.toThrow();
    await expect(db.update(edrIsolationRequests).set({ releaseDecidedBy: admin2 }).where(eq(edrIsolationRequests.id, id))).rejects.toThrow();
    // the view fails closed too: no release requester, no "other person" can decide it
    await db.update(edrIsolationRequests).set({ state: "release_requested" }).where(eq(edrIsolationRequests.id, id));
    const view = (await asUser(admin2, "GET", "/v1/edr-isolations?open=true", undefined)).json();
    const mine = view.isolations.find((x: { id: string }) => x.id === id);
    expect(mine.lifecycle.transitions.find((t: { event: string }) => t.event === "approve_release")).toMatchObject({ allowed: false });
    await db.update(edrIsolationRequests).set({ state: "released" }).where(eq(edrIsolationRequests.id, id));
  });
});

describe("ADR-0360 EDR: nothing waits for ever (R2 #2, #3, #4)", () => {
  it("expires undecided requests and release requests", async () => {
    const c = await defender();
    const cid = c.connection.id;
    const old = EDR_DECISION_TTL_HOURS * 60 + 5;
    const a = await row(cid, { state: "requested", ageMinutes: old });
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect(await stateOf(a)).toMatchObject({ state: "rejected", errorCode: "expired" });
    expect(await rulesOf(a)).toContain("edr-isolation-expire");
    const b = await row(cid, { state: "release_requested", decidedBy: admin2, releaseRequestedBy: admin2, ageMinutes: old });
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect(await stateOf(b)).toMatchObject({ state: "isolated", errorCode: "expired" });
    expect(await rulesOf(b)).toContain("edr-isolation-expire-release");
    await db.update(edrIsolationRequests).set({ state: "released" }).where(eq(edrIsolationRequests.id, b));
    // a fresh request is left alone
    const fresh = await row(cid, { state: "requested", ageMinutes: 1 });
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect((await stateOf(fresh)).state).toBe("requested");
    await db.update(edrIsolationRequests).set({ state: "rejected" }).where(eq(edrIsolationRequests.id, fresh));
  });

  it("fails a stranded submission and an action the vendor never settles, freeing the device's slot", async () => {
    const c = await defender();
    const cid = c.connection.id;
    const stranded = await row(cid, { state: "submitting", decidedBy: admin2, ageMinutes: EDR_STRANDED_MINUTES + 1 });
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect(await stateOf(stranded)).toMatchObject({ state: "failed", errorCode: "stranded" });
    expect(await rulesOf(stranded)).toContain("edr-isolate-failed");
    const releasing = await row(cid, { state: "releasing", decidedBy: admin2, releaseRequestedBy: admin2, releaseDecidedBy: admin1, ageMinutes: EDR_STRANDED_MINUTES + 1 });
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect(await stateOf(releasing)).toMatchObject({ state: "isolated", errorCode: "stranded" });
    await db.update(edrIsolationRequests).set({ state: "released" }).where(eq(edrIsolationRequests.id, releasing));
    // pending at the vendor: left while it may still move, failed once overdue
    const young = await row(cid, { state: "submitting", decidedBy: admin2, vendorActionId: "action-pending-1", ageMinutes: 1 });
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect((await stateOf(young)).state).toBe("submitting");
    await db.update(edrIsolationRequests).set({ updatedAt: sql`now() - make_interval(mins => ${EDR_ACTION_SETTLE_MINUTES + 1})` }).where(eq(edrIsolationRequests.id, young));
    await pollEdrIsolations(db, { dataKey: DATA_KEY, egress });
    expect(await stateOf(young)).toMatchObject({ state: "failed", errorCode: "vendor_timeout" });
  });

  it("reconciles with the vendor: a failed isolation it carried out, and a release made in its console", async () => {
    const c = await defender();
    const cid = c.connection.id;
    const id = await row(cid, { state: "failed", decidedBy: admin2, errorCode: "already_in_progress", ageMinutes: 5 });
    state.report = true;
    state.isolated.add("mde-a");
    try {
      expect((await inject("POST", `/v1/edr-connections/${cid}/sync`, AUTH, {})).json().code).toBe("ok");
      expect((await stateOf(id)).state).toBe("isolated");
      expect(await rulesOf(id)).toContain("edr-isolate-reconciled");
      // isolated again, so its release is governed: a second person decides it
      expect((await asUser(admin2, "POST", `/v1/edr-isolations/${id}/request_release`, {})).json().isolation.state).toBe("release_requested");
      await db.update(edrIsolationRequests).set({ state: "isolated", releaseRequestedBy: null }).where(eq(edrIsolationRequests.id, id));
      // released in the vendor console: recorded, audited as outside governance
      state.isolated.delete("mde-a");
      await inject("POST", `/v1/edr-connections/${cid}/sync`, AUTH, {});
      expect((await stateOf(id)).state).toBe("released");
      expect(await rulesOf(id)).toContain("edr-release-outside-governance");
    } finally {
      state.report = false;
    }
  });
});

describe("ADR-0360 EDR: secrets rotate in place (R2 #5)", () => {
  it("replaces the vendor credential and rotates the webhook secret, step-up gated and audited", async () => {
    const c = await connection("sentinelone");
    const cid = c.connection.id;
    const [before] = await db.select().from(edrConnections).where(eq(edrConnections.id, cid));
    const next = createHash("sha256").update(`vendor-next-${RUN}`).digest("hex");
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${cid}/credential`, { secret: next })).statusCode).not.toBe(200);
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${cid}/credential`, { secret: next }, edrCredentialRotateStepUp(cid))).statusCode).toBe(200);
    const [after] = await db.select().from(edrConnections).where(eq(edrConnections.id, cid));
    expect(after!.secretCiphertext).not.toBe(before!.secretCiphertext);
    expect(after!.secretCiphertext).not.toContain(next);
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${cid}/credential`, { secret: next, clientId: "nope" }, edrCredentialRotateStepUp(cid))).statusCode).toBe(400);
    // the webhook secret: shown once, the old one stops working at once
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${cid}/webhook-secret/rotate`, {})).statusCode).not.toBe(200);
    const rot = await asUser(admin1, "POST", `/v1/edr-connections/${cid}/webhook-secret/rotate`, {}, edrWebhookSecretRotateStepUp(cid));
    expect(rot.statusCode, rot.body).toBe(200);
    expect(rot.headers["cache-control"]).toBe("no-store");
    const fresh = rot.json().webhook.secret as string;
    expect(fresh).toMatch(/^rgedr_[0-9a-f]{64}$/);
    expect(fresh).not.toBe(c.webhook!.secret);
    const ev = (id: string) => JSON.stringify({ id, createdAt: new Date().toISOString(), agentRealtimeInfo: { agentId: "s1-b" }, threatInfo: { confidenceLevel: "suspicious" } });
    const post = (id: string, token: string) => app.inject({ method: "POST", url: c.webhook!.path, headers: { "content-type": "application/json", "x-regulait-webhook-token": token }, payload: ev(id) });
    expect((await post(`old-${RUN}`, c.webhook!.secret)).statusCode).toBe(401);
    expect((await post(`new-${RUN}`, fresh)).statusCode).toBe(200);
    const rules = (await db.select({ r: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'connectionId' = ${cid}`)).map((x) => x.r);
    expect(rules).toEqual(expect.arrayContaining(["edr-credential-rotated", "edr-webhook-secret-rotated"]));
    const leaked = await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.detail}::text LIKE ${"%" + fresh + "%"} OR ${auditLog.detail}::text LIKE ${"%" + next + "%"}`);
    expect(leaked).toEqual([]);
    const mde = await defender();
    expect((await asUser(admin1, "POST", `/v1/edr-connections/${mde.connection.id}/webhook-secret/rotate`, {}, edrWebhookSecretRotateStepUp(mde.connection.id))).json().error).toBe("no_webhooks");
  });
});

describe("ADR-0360 EDR: lists page by keyset (R2 #8, #9)", () => {
  it("pages isolations newest first and refuses a malformed signals cursor", async () => {
    const all = await inject("GET", "/v1/edr-isolations", AUTH);
    expect(all.statusCode).toBe(200);
    const first = all.json().isolations as Array<{ id: string; createdAt: string }>;
    expect(first.length).toBeGreaterThan(1);
    const after = await inject("GET", `/v1/edr-isolations?after=${first[0]!.id}`, AUTH);
    expect(after.json().isolations.map((x: { id: string }) => x.id)).not.toContain(first[0]!.id);
    expect(after.json().isolations[0].id).toBe(first[1]!.id);
    const closed = await inject("GET", "/v1/edr-isolations?open=false", AUTH);
    expect(closed.json().isolations.every((x: { state: string }) => !closed.json().open.includes(x.state))).toBe(true);
    expect((await inject("GET", `/v1/discovery/sources/${sourceId}/edr-signals?after=${deviceA}`, AUTH)).statusCode).toBe(400);
    expect((await inject("GET", `/v1/discovery/sources/${sourceId}/edr-signals?after=${deviceA}.${deviceB}`, AUTH)).statusCode).toBe(200);
  });
});

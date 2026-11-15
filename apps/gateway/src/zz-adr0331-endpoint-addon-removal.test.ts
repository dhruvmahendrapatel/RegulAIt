/**
 * ADR-0331 — governed removal of flagged MCP servers from endpoints, the gateway half, end to end (real database).
 *
 *  - the org switch is off by default; turning it on is a `settings_relax` step-up bound to its key (refused without
 *    one, refused with a grant for another relaxation), audited; turning it off is free;
 *  - a removal is refused while the switch is off; it needs an `endpoint_remediation` step-up bound to the request (no
 *    grant, a grant of another kind or for other facts: refused and not spent); `unknown` identities are refused; a
 *    request that matches no endpoint is refused without spending the grant; a server seen only under
 *    `system_applications`, on a revoked device, or outside the look-back is never targeted;
 *  - device, devices and recent scopes resolve to the right config entries, and the removal, its targets and the audit
 *    row commit together with the spent grant;
 *  - directives: switch off → none; no signer → 503 `directive_signer_unavailable` (audited); with a test signer the
 *    payload is exactly the ADR §4 shape, bound to the calling identity, and verifies under Ed25519; delivery marks
 *    the target delivered;
 *  - outcomes: accepted, an identical repeat is idempotent, a conflicting repeat is refused, another device's directive
 *    and an undelivered one are refused, a code that does not belong to its outcome is refused;
 *  - cancelling stops delivery and is idempotent; the list and the detail read under the list contract.
 *
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  discoveryPseudonymKeys,
  discoverySettings,
  discoverySources,
  endpointAddonRemovals,
  endpointAddonRemovalTargets,
  endpointAgentReports,
  endpointDevices,
  endpointMcpServers,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, DISCOVERY_STEP_UP_KEYS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { createRemovalSchema, endpointRemediationStepUp, type DevicePolicySigner } from "./endpoint-addon-removal.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { endpointAgentKeys } from "./testing/endpoint-agent-client.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `a331-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`a331-data-key-${RUN}`).digest("hex");
const PKG = `@a331-${RUN}/server`;
const OTHER_PKG = `@a331-${RUN}/other`;
const CONFIG = `.config/a331-${RUN}/mcp.json`;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

// a runtime Ed25519 key pair: the test signer the production build never has (SD4 pending)
const directiveKeys = generateKeyPairSync("ed25519");
const signer: DevicePolicySigner = { keyId: "test-directive-key", sign: async (b) => edSign(null, b, directiveKeys.privateKey) };

let db: Db;
let app: ReturnType<typeof buildApp>;
let unsigned: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];

type Method = "GET" | "POST" | "PUT";
const inject = (a: ReturnType<typeof buildApp>, method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  a.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const AgentKey = endpointAgentKeys(() => app, DATA_KEY, ORIGIN);

const settingsRow = async () => (await db.select().from(discoverySettings).where(eq(discoverySettings.id, 1)))[0]!;
const setSwitch = (on: boolean) => db.update(discoverySettings).set({ endpointAddonRemovalEnabled: on }).where(eq(discoverySettings.id, 1));
const removalStep: StepUpCheckArgs = { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.endpointAddonRemoval]: true } } };

/** a browser request as the admin: with `args`, carrying a grant made for exactly that action */
async function asAdmin(args: StepUpCheckArgs | null, method: Method, url: string, payload?: unknown) {
  const g = await grantStepUpForTest(db, adminId, args ?? { kind: "settings_relax", facts: { unused: RUN } });
  const r = args ? stepUpRequest(g) : sessionRequest(g);
  const res = await app.inject({ method, url, headers: r.headers, cookies: r.cookies, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { res, grantId: g.grantId };
}
const stepFor = (body: Record<string, unknown>) => endpointRemediationStepUp(createRemovalSchema.parse(body));
/** create a removal with the right grant; expects 201 */
async function createRemoval(body: Record<string, unknown>) {
  const { res } = await asAdmin(stepFor(body), "POST", "/v1/discovery/endpoint-addon-removals", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { removal: { id: string; targets: Record<string, number>; expiresAt: string }; devices: number };
}

let seq = 0;
async function enrolled() {
  const r = await inject(app, "POST", "/v1/discovery/sources", AUTH, { name: `a331-agent-${RUN}-${++seq}`, kind: "endpoint_agent", target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const sourceId = r.json().id as string;
  sourceIds.push(sourceId);
  // enabling is SD0's step-up route (covered by SD0's suite); here the row is set directly
  await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, sourceId));
  const tok = await inject(app, "POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH, { label: `a331-${RUN}`, deviceCap: 5 });
  expect(tok.statusCode, tok.body).toBe(201);
  const t = await inject(app, "POST", "/v1/endpoint-agent/enrolment-tickets", { authorization: `Bearer ${tok.json().enrolFile.token}` }, { hostname: `a331-host-${RUN}-${seq}`, os: "linux", arch: "amd64", agentVersion: "0.1.0" });
  expect(t.statusCode, t.body).toBe(201);
  const key = await AgentKey.make();
  const reg = await inject(app, "POST", "/v1/endpoint-agent/register", { authorization: `Bearer ${t.json().ticket}` }, {
    publicJwk: key.jwk,
    keyProtection: "hardware",
    keyProvider: "tpm",
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    deviceUser: `a331user${RUN}`,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { sourceId, deviceId: t.json().ticketId as string, identityId: reg.json().identityId as string, key, ticket: t.json().ticket as string };
}
type Agent = Awaited<ReturnType<typeof enrolled>>;

/** a second device user on the same device: another identity registered under the same device ticket */
async function secondUser(a: Agent): Promise<Agent> {
  const key = await AgentKey.make();
  const reg = await inject(app, "POST", "/v1/endpoint-agent/register", { authorization: `Bearer ${a.ticket}` }, {
    publicJwk: key.jwk,
    keyProtection: "hardware",
    keyProvider: "tpm",
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    deviceUser: `a331second${RUN}`,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { ...a, identityId: reg.json().identityId as string, key };
}

/** a signed report of `a` as the ingest leaves it (refused status, so no ingest pass in another suite picks it up) */
async function reportOf(a: Agent): Promise<string> {
  const [r] = await db
    .insert(endpointAgentReports)
    .values({
      identityId: a.identityId,
      deviceId: a.deviceId,
      sourceId: a.sourceId,
      snapshotId: randomUUID(),
      collectedAt: new Date(),
      bodySha256: "a".repeat(64),
      factsDigest: "b".repeat(64),
      manifestVersion: "1.0.0",
      manifestDigest: "c".repeat(64),
      factsReceived: 0,
      factsEnvRefused: 0,
      factsUnmatched: 0,
      droppedSnapshots: 0,
      status: "refused",
      runId: randomUUID(),
      committedAt: new Date(),
    })
    .returning({ id: endpointAgentReports.id });
  return r!.id;
}

/** evidence as an accepted report leaves it (ADR-0259's table), written directly so each case is exact */
async function seen(a: Agent, o: { root?: string; serverName?: string; pkg?: string; version?: string | null; daysAgo?: number; path?: string; noReport?: boolean }) {
  const at = new Date(Date.now() - (o.daysAgo ?? 0) * 86_400_000);
  await db.insert(endpointMcpServers).values({
    deviceId: a.deviceId,
    // the identity whose report last showed it; `noReport`: that report is gone
    lastReportId: o.noReport ? randomUUID() : await reportOf(a),
    signatureId: "sig.a331.host",
    provider: "a331prov",
    configRoot: (o.root ?? "home") as "home",
    configPath: o.path ?? CONFIG,
    serverName: o.serverName ?? "flagged",
    transport: "stdio",
    command: "npx",
    package: o.pkg ?? PKG,
    packageVersion: o.version === undefined ? "1.2.3" : o.version,
    identityKind: "package",
    identity: o.pkg ?? PKG,
    firstSeenAt: at,
    lastSeenAt: at,
  });
}

const directivesOf = async (a: Agent, via = app) => inject(via, "GET", "/v1/endpoint-agent/directives", await a.key.headers("GET", "/v1/endpoint-agent/directives"));
async function postOutcomes(a: Agent, outcomes: unknown[]) {
  return app.inject({
    method: "POST",
    url: "/v1/endpoint-agent/directive-outcomes",
    headers: { ...(await a.key.headers("POST", "/v1/endpoint-agent/directive-outcomes")), "content-type": "application/json" },
    payload: JSON.stringify({ outcomes }),
  });
}
const decode = (env: { payload: string }) => JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** the audit rows of an agent's directive reads (one per call, fixed fields only) */
const readsOf = (a: Agent) =>
  db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.ruleId} = 'endpoint-agent-directives-read' AND ${auditLog.objectId} = ${a.sourceId}`)
    .orderBy(auditLog.seq);
const lastRead = async (a: Agent) => (await readsOf(a)).at(-1)!;
const targetsOf = (removalId: string) => db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.removalId, removalId));

let A: Agent;
let B: Agent;
let C: Agent;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  // the per-tenant pseudonym key is wrapped under the first data key that asks for it (see the ADR-0259 suite)
  const priorPseudonymKeys = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (priorPseudonymKeys.length) await db.insert(discoveryPseudonymKeys).values(priorPseudonymKeys);
  });
  const s0 = await settingsRow();
  restores.push(async () => {
    await db.update(discoverySettings).set({ endpointAddonRemovalEnabled: s0.endpointAddonRemovalEnabled }).where(eq(discoverySettings.id, 1));
  });
  // the strict step-up policy, every kind (this suite proves the new one); put back what was there afterwards
  const [o0] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    if (o0) await db.update(orgSettings).set({ stepUpMode: o0.mode, stepUpActions: o0.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, devicePolicySigner: signer });
  unsigned = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await Promise.all([app.ready(), unsigned.ready()]);
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const a = await inject(app, "POST", "/v1/users", AUTH, { email: `a331-admin-${RUN}@example.com`, displayName: "a331 admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  adminKey = { authorization: `Bearer ${(await inject(app, "POST", `/v1/users/${adminId}/keys`, AUTH, { name: "k" })).json().token}` };
  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
  A = await enrolled();
  B = await enrolled();
  C = await enrolled();
  // A: the flagged server in two user-writable configs, and an unrelated package
  await seen(A, {});
  await seen(A, { root: "appdata", path: `Cursor/a331-${RUN}/mcp.json` });
  await seen(A, { pkg: OTHER_PKG, serverName: "other" });
  // B: the flagged server at another version, seen 3 days ago, plus a system_applications copy (never a target)
  await seen(B, { version: "2.0.0", daysAgo: 3 });
  await seen(B, { root: "system_applications", path: `Applications/a331-${RUN}.json` });
  // C: seen, then revoked (a revoked device is never targeted)
  await seen(C, {});
  await db.update(endpointDevices).set({ revokedAt: sql`GREATEST(now(), ${endpointDevices.createdAt})` }).where(eq(endpointDevices.id, C.deviceId));
}, 120_000);

afterAll(async () => {
  if (db) {
    await db.delete(endpointAddonRemovals).where(sql`${endpointAddonRemovals.identity} LIKE ${`%${RUN}%`}`);
    if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
    if (sourceIds.length) {
      await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
      await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
    }
    for (const r of restores.reverse()) await r();
  }
  await app?.close();
  await unsigned?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

const base = (scope: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ identityKind: "package", identity: PKG, scope, reason: `a331 flagged ${RUN}`, ...extra });

describe("ADR-0331: the org switch", () => {
  it("is off by default; on needs the settings_relax step-up bound to it (audited); off is free", async () => {
    await setSwitch(false);
    expect((await inject(app, "GET", "/v1/discovery/settings", adminKey)).json().endpointAddonRemoval).toBe(false);
    const v0 = (await settingsRow()).version;
    // NEGATIVE CONTROLS: an API key cannot step up, and a grant for another relaxation is refused and not spent
    expect((await inject(app, "PUT", "/v1/discovery/settings", adminKey, { version: v0, endpointAddonRemoval: true })).statusCode).toBe(403);
    const wrong = await asAdmin({ kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.endpointMcpConfig]: true } } }, "PUT", "/v1/discovery/settings", { version: v0, endpointAddonRemoval: true });
    expect(wrong.res.statusCode).toBe(403);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect((await settingsRow()).endpointAddonRemovalEnabled).toBe(false);

    const on = await asAdmin(removalStep, "PUT", "/v1/discovery/settings", { version: v0, endpointAddonRemoval: true });
    expect(on.res.statusCode, on.res.body).toBe(200);
    expect(on.res.json().endpointAddonRemoval).toBe(true);
    expect(await grantSpent(db, on.grantId)).toBe(true);
    const [relaxed] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.objectType} = 'discovery_settings' AND ${auditLog.ruleId} = 'discovery-settings-relaxed' AND ${auditLog.detail}->'after'->>'endpointAddonRemoval' = 'true' AND ${auditLog.userId} = ${adminId}`);
    expect(relaxed).toBeDefined();

    const off = await inject(app, "PUT", "/v1/discovery/settings", adminKey, { version: v0 + 1, endpointAddonRemoval: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().endpointAddonRemoval).toBe(false);
  });
});

describe("ADR-0331: starting a removal", () => {
  it("is refused while the switch is off, before any step-up is asked", async () => {
    await setSwitch(false);
    const body = base({ kind: "device", deviceId: A.deviceId });
    const { res, grantId } = await asAdmin(stepFor(body), "POST", "/v1/discovery/endpoint-addon-removals", body);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("addon_removal_disabled");
    expect(await grantSpent(db, grantId)).toBe(false);
  });

  it("needs an endpoint_remediation step-up bound to the request: none, another kind, other facts are refused and not spent", async () => {
    await setSwitch(true);
    const body = base({ kind: "device", deviceId: A.deviceId });
    // an API key can never give one
    const key = await inject(app, "POST", "/v1/discovery/endpoint-addon-removals", adminKey, body);
    expect(key.statusCode).toBe(403);
    expect(key.json()).toMatchObject({ error: "step_up_required", actionKind: "endpoint_remediation" });
    // a browser session without a grant is asked for one, bound to exactly this request
    const none = await asAdmin(null, "POST", "/v1/discovery/endpoint-addon-removals", body);
    expect(none.res.statusCode).toBe(403);
    expect(none.res.json()).toMatchObject({ error: "step_up_required", actionKind: "endpoint_remediation", action: { kind: "endpoint_remediation" } });
    expect(none.res.json().action.body).toEqual(stepFor(body).facts);
    // a settings_relax grant with the same facts, and a remediation grant for another request
    const kind = await asAdmin({ kind: "settings_relax", facts: stepFor(body).facts }, "POST", "/v1/discovery/endpoint-addon-removals", body);
    expect(kind.res.statusCode).toBe(403);
    expect(await grantSpent(db, kind.grantId)).toBe(false);
    const other = await asAdmin(stepFor({ ...body, blockReinstall: false }), "POST", "/v1/discovery/endpoint-addon-removals", body);
    expect(other.res.statusCode).toBe(403);
    expect(await grantSpent(db, other.grantId)).toBe(false);
    expect(await db.select().from(endpointAddonRemovals).where(sql`${endpointAddonRemovals.identity} = ${PKG}`)).toEqual([]);
  });

  it("refuses an unknown identity kind, and a request that matches no endpoint without spending the grant", async () => {
    await setSwitch(true);
    const unknown = await asAdmin(null, "POST", "/v1/discovery/endpoint-addon-removals", { ...base({ kind: "recent", days: 90 }), identityKind: "unknown", identity: "(unnamed)" });
    expect(unknown.res.statusCode).toBe(400);
    const noMatch = base({ kind: "recent", days: 90 }, { identity: `@a331-${RUN}/never-seen` });
    const r = await asAdmin(stepFor(noMatch), "POST", "/v1/discovery/endpoint-addon-removals", noMatch);
    expect(r.res.statusCode).toBe(409);
    expect(r.res.json().error).toBe("no_matching_endpoints");
    expect(await grantSpent(db, r.grantId)).toBe(false);
    // duplicate device ids, and more than 500, are refused by the body bounds
    const dup = await asAdmin(null, "POST", "/v1/discovery/endpoint-addon-removals", base({ kind: "devices", deviceIds: [A.deviceId, A.deviceId] }));
    expect(dup.res.statusCode).toBe(400);
  });

  it("never targets a system_applications copy or a revoked device", async () => {
    await setSwitch(true);
    // B's only 1.2.3-less copy outside system_applications is 2.0.0; C (revoked) holds 1.2.3 under home
    const sys = base({ kind: "device", deviceId: C.deviceId });
    const r = await asAdmin(stepFor(sys), "POST", "/v1/discovery/endpoint-addon-removals", sys);
    expect(r.res.statusCode).toBe(409);
    // evidence whose report row is gone names no identity: it is skipped, never guessed
    await seen(B, { pkg: `@a331-${RUN}/orphan`, noReport: true });
    const orphan = base({ kind: "device", deviceId: B.deviceId }, { identity: `@a331-${RUN}/orphan` });
    expect((await asAdmin(stepFor(orphan), "POST", "/v1/discovery/endpoint-addon-removals", orphan)).res.statusCode).toBe(409);
    const created = await createRemoval(base({ kind: "device", deviceId: B.deviceId }));
    const ts = await targetsOf(created.removal.id);
    expect(ts.map((t) => t.configRoot)).toEqual(["home"]);
    await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${created.removal.id}/cancel`, headers: adminKey });
  });

  it("device, devices and recent scopes resolve to the right entries; removal, targets and audit commit together", async () => {
    await setSwitch(true);
    const one = await createRemoval(base({ kind: "device", deviceId: A.deviceId }, { packageVersion: "1.2.3" }));
    expect(one.removal.targets).toMatchObject({ pending: 2, total: 2 });
    expect(one.devices).toBe(1);
    const ts = await targetsOf(one.removal.id);
    expect(ts.map((t) => t.configRoot).sort()).toEqual(["appdata", "home"]);
    expect(ts.every((t) => t.identityId === A.identityId && t.status === "pending" && t.serverName === "flagged" && t.signatureId === "sig.a331.host")).toBe(true);
    const [row] = await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, one.removal.id));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(7 * 86_400_000);
    expect(row!.createdBy).toBe(adminId);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, one.removal.id), eq(auditLog.ruleId, "endpoint-addon-removal-created")));
    expect(audit).toMatchObject({ userId: adminId, effect: "allow", objectType: "endpoint_addon_removal" });
    expect(audit!.detail).toMatchObject({ targets: 2, devices: 1, stepUp: "totp", stepUpKind: "endpoint_remediation", blockReinstall: true });

    const many = await createRemoval(base({ kind: "devices", deviceIds: [B.deviceId, A.deviceId, C.deviceId] }));
    const mt = await targetsOf(many.removal.id);
    expect(mt.filter((t) => t.identityId === A.identityId)).toHaveLength(2);
    expect(mt.filter((t) => t.identityId === B.identityId).map((t) => t.configRoot)).toEqual(["home"]);
    expect(mt.filter((t) => t.identityId === C.identityId)).toEqual([]);

    // recent, 1 day: B's copy was seen 3 days ago, so only A's two entries
    const recent = await createRemoval(base({ kind: "recent", days: 1 }));
    expect(new Set((await targetsOf(recent.removal.id)).map((t) => t.identityId))).toEqual(new Set([A.identityId]));
    // with a server name that is not the entry's, nothing matches
    const named = base({ kind: "recent", days: 90 }, { serverName: "not-this-one" });
    expect((await asAdmin(stepFor(named), "POST", "/v1/discovery/endpoint-addon-removals", named)).res.statusCode).toBe(409);
    for (const id of [many.removal.id, recent.removal.id]) {
      await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${id}/cancel`, headers: adminKey });
    }
  });
});

describe("ADR-0331: directives and outcomes", () => {
  it("off → none; no signer → 503 (audited); with a signer → the exact ADR payload, signed, bound to the caller", async () => {
    // A's pending targets: the device-scope removal from the previous block (the other two were cancelled)
    await setSwitch(false);
    const off = await directivesOf(A);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ directives: [] });
    // owner answer (2026-11-15): every read is audited, the switch-off case included, with fixed fields only
    const r0 = await lastRead(A);
    expect(r0.effect).toBe("allow");
    expect(r0.detail).toMatchObject({ deviceId: A.deviceId, identityId: A.identityId, served: 0, outcome: "switch_off" });
    expect(Object.keys(r0.detail as object).sort()).toEqual(["adr", "deviceId", "identityId", "outcome", "served", "slice", "subsystem"]);

    await setSwitch(true);
    const noSigner = await directivesOf(A, unsigned);
    expect(noSigner.statusCode).toBe(503);
    expect(noSigner.json()).toEqual({ error: "directive_signer_unavailable" });
    const deny = await lastRead(A);
    expect(deny.effect).toBe("deny");
    expect(deny.detail).toMatchObject({ deviceId: A.deviceId, identityId: A.identityId, served: 0, outcome: "signer_unavailable" });
    expect((await db.select().from(endpointAddonRemovalTargets).where(and(eq(endpointAddonRemovalTargets.identityId, A.identityId), eq(endpointAddonRemovalTargets.status, "delivered")))).length).toBe(0);

    const res = await directivesOf(A);
    expect(res.statusCode, res.body).toBe(200);
    const envs = res.json().directives as Array<{ keyId: string; payload: string; signature: string }>;
    expect(envs).toHaveLength(2);
    const [removal] = await db.select().from(endpointAddonRemovals).where(and(sql`${endpointAddonRemovals.identity} = ${PKG}`, eq(endpointAddonRemovals.scopeKind, "device"), sql`${endpointAddonRemovals.cancelledAt} IS NULL`));
    for (const env of envs) {
      expect(Object.keys(env).sort()).toEqual(["keyId", "payload", "signature"]);
      expect(env.keyId).toBe("test-directive-key");
      expect(edVerify(null, Buffer.from(env.payload, "base64"), directiveKeys.publicKey, Buffer.from(env.signature, "base64"))).toBe(true);
      const p = decode(env);
      expect(Object.keys(p)).toEqual(["schema", "directiveId", "removalId", "identityId", "issuedAt", "notAfter", "action", "asset"]);
      expect(Object.keys(p.asset)).toEqual(["signatureId", "root", "path", "serverName", "identityKind", "identity", "packageVersion"]);
      expect(p).toMatchObject({ schema: "regulait.endpoint-directive/1", removalId: removal!.id, identityId: A.identityId, action: "remove_mcp_server" });
      expect(p.directiveId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(p.asset).toMatchObject({ signatureId: "sig.a331.host", serverName: "flagged", identityKind: "package", identity: PKG, packageVersion: "1.2.3" });
      expect(["home", "appdata"]).toContain(p.asset.root);
      expect(p.issuedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      const window = Date.parse(p.notAfter) - Date.parse(p.issuedAt);
      expect(window).toBeGreaterThan(0);
      expect(window).toBeLessThanOrEqual(7 * 86_400_000);
      expect(Date.parse(p.notAfter)).toBe(Math.floor(removal!.expiresAt.getTime() / 1000) * 1000);
    }
    const ts = await targetsOf(removal!.id);
    expect(ts.every((t) => t.status === "delivered" && t.deliveredAt !== null)).toBe(true);
    const served = await lastRead(A);
    expect(served.detail).toMatchObject({ served: 2, outcome: "served" });
    expect([...((served.detail as { directiveIds: string[] }).directiveIds)].sort()).toEqual(ts.map((t) => t.id).sort());
    expect(JSON.stringify(served.detail)).not.toContain(PKG);
    // B has no live target of this removal: none for it, and that read is audited too
    expect((await directivesOf(B)).json().directives).toEqual([]);
    expect((await lastRead(B)).detail).toMatchObject({ deviceId: B.deviceId, served: 0, outcome: "none" });
  });

  it("omits packageVersion when the removal names none", async () => {
    await setSwitch(true);
    const r = await createRemoval(base({ kind: "device", deviceId: B.deviceId }));
    const envs = (await directivesOf(B)).json().directives as Array<{ payload: string }>;
    const mine = envs.map(decode).filter((p) => p.removalId === r.removal.id);
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!.asset)).toEqual(["signatureId", "root", "path", "serverName", "identityKind", "identity"]);
    await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${r.removal.id}/cancel`, headers: adminKey });
  });

  it("outcomes: accepted, idempotent repeat, conflicting repeat, another device's, undelivered and a bad code pair refused", async () => {
    await setSwitch(true);
    const [removal] = await db.select().from(endpointAddonRemovals).where(and(sql`${endpointAddonRemovals.identity} = ${PKG}`, eq(endpointAddonRemovals.scopeKind, "device"), sql`${endpointAddonRemovals.cancelledAt} IS NULL`));
    const [t1, t2] = (await targetsOf(removal!.id)).sort((a, b) => a.id.localeCompare(b.id));
    const first = await postOutcomes(A, [
      { directiveId: t1!.id, outcome: "removed", code: "removed", notified: true },
      { directiveId: t2!.id, outcome: "failed", code: "removed", notified: false },
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, refused: [{ directiveId: t2!.id, code: "code_mismatch" }] });
    const [after] = await db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.id, t1!.id));
    expect(after).toMatchObject({ status: "removed", code: "removed", notified: true });
    expect(after!.reportedAt).not.toBeNull();

    // the same outcome again (the answer was lost): idempotent; a different one: refused, the first stands
    const again = await postOutcomes(A, [{ directiveId: t1!.id, outcome: "removed", code: "removed", notified: true }]);
    expect(again.json()).toEqual({ accepted: 1, refused: [] });
    const conflict = await postOutcomes(A, [{ directiveId: t1!.id, outcome: "nothing_to_remove", code: "not_present", notified: false }]);
    expect(conflict.json()).toEqual({ accepted: 0, refused: [{ directiveId: t1!.id, code: "outcome_conflict" }] });
    expect((await db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.id, t1!.id)))[0]!.status).toBe("removed");

    // B (another device) cannot report A's directive
    const foreign = await postOutcomes(B, [{ directiveId: t2!.id, outcome: "failed", code: "unsupported_format", notified: false }]);
    expect(foreign.json()).toEqual({ accepted: 0, refused: [{ directiveId: t2!.id, code: "not_your_directive" }] });
    const unknown = randomUUID();
    expect((await postOutcomes(B, [{ directiveId: unknown, outcome: "removed", code: "removed", notified: true }])).json()).toEqual({ accepted: 0, refused: [{ directiveId: unknown, code: "unknown_directive" }] });
    expect((await db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.id, t2!.id)))[0]!.status).toBe("delivered");

    // an undelivered directive (a new removal, not fetched yet) cannot be reported
    const fresh = await createRemoval(base({ kind: "device", deviceId: A.deviceId }, { serverName: "flagged", reason: `second ${RUN}` }));
    const [pending] = await targetsOf(fresh.removal.id);
    const early = await postOutcomes(A, [{ directiveId: pending!.id, outcome: "removed", code: "removed", notified: true }]);
    expect(early.json()).toEqual({ accepted: 0, refused: [{ directiveId: pending!.id, code: "not_delivered" }] });

    // malformed bodies: an unknown member, an unknown code, more than 20
    expect((await postOutcomes(A, [{ directiveId: t2!.id, outcome: "failed", code: "unsupported_format", notified: false, extra: 1 }])).statusCode).toBe(400);
    expect((await postOutcomes(A, [{ directiveId: t2!.id, outcome: "failed", code: "made_up", notified: false }])).statusCode).toBe(400);
    expect((await postOutcomes(A, Array.from({ length: 21 }, () => ({ directiveId: randomUUID(), outcome: "removed", code: "removed", notified: true })))).statusCode).toBe(400);
    const ok = await postOutcomes(A, [{ directiveId: t2!.id, outcome: "failed", code: "unsupported_format", notified: false }]);
    expect(ok.json()).toEqual({ accepted: 1, refused: [] });
    const [rec] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.ruleId} = 'endpoint-agent-directive-outcomes-recorded' AND ${auditLog.objectId} = ${A.sourceId} AND ${auditLog.detail}->'outcomes'->0->>'directiveId' = ${t2!.id}`);
    expect(rec).toMatchObject({ effect: "allow" });
  });

  it("cancelling stops delivery and is idempotent; the list and detail read under the list contract", async () => {
    await setSwitch(true);
    const [fresh] = await db.select().from(endpointAddonRemovals).where(and(sql`${endpointAddonRemovals.identity} = ${PKG}`, eq(endpointAddonRemovals.reason, `second ${RUN}`)));
    const c = await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${fresh!.id}/cancel`, headers: adminKey });
    expect(c.statusCode, c.body).toBe(200);
    // both of A's entries named "flagged" were pending (never fetched)
    expect(c.json()).toMatchObject({ cancelled: 2, alreadyCancelled: false, removal: { state: "cancelled", targets: { cancelled: 2 } } });
    const again = await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${fresh!.id}/cancel`, headers: adminKey });
    expect(again.json()).toMatchObject({ cancelled: 0, alreadyCancelled: true });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.objectId, fresh!.id), eq(auditLog.ruleId, "endpoint-addon-removal-cancelled")))).toHaveLength(1);
    const ids = ((await directivesOf(A)).json().directives as Array<{ payload: string }>).map((e) => decode(e).removalId);
    expect(ids).not.toContain(fresh!.id);
    expect((await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${randomUUID()}/cancel`, headers: adminKey })).statusCode).toBe(404);

    const list = await inject(app, "GET", "/v1/discovery/endpoint-addon-removals?limit=50", adminKey);
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json().items as Array<{ id: string; createdAt: string; identity: string; targets: Record<string, number> }>).filter((i) => i.identity === PKG);
    expect(items.length).toBeGreaterThanOrEqual(5);
    const times = items.map((i) => Date.parse(i.createdAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(list.json()).toMatchObject({ enabled: true, signerConfigured: true });
    expect(items.find((i) => i.id === fresh!.id)!.targets).toMatchObject({ cancelled: 2, total: 2 });
    expect((await inject(app, "GET", "/v1/discovery/endpoint-addon-removals?sort=nope", adminKey)).statusCode).toBe(400);

    const [removal] = await db.select().from(endpointAddonRemovals).where(and(sql`${endpointAddonRemovals.identity} = ${PKG}`, eq(endpointAddonRemovals.scopeKind, "device"), eq(endpointAddonRemovals.packageVersion, "1.2.3")));
    const detail = await inject(app, "GET", `/v1/discovery/endpoint-addon-removals/${removal!.id}?limit=10`, adminKey);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().removal.targets).toMatchObject({ removed: 1, failed: 1, total: 2 });
    const rows = detail.json().targets.items as Array<{ status: string; code: string; notified: boolean; devicePseudonym: string }>;
    expect(rows.map((r) => `${r.status}/${r.code}/${r.notified}`).sort()).toEqual(["failed/unsupported_format/false", "removed/removed/true"]);
    const filtered = await inject(app, "GET", `/v1/discovery/endpoint-addon-removals/${removal!.id}?status=removed`, adminKey);
    expect(filtered.json().targets.items).toHaveLength(1);
    expect((await inject(app, "GET", `/v1/discovery/endpoint-addon-removals/${randomUUID()}`, adminKey)).statusCode).toBe(404);
  });

  it("two users on one device: only the identity whose report showed the server is targeted, served and may report", async () => {
    await setSwitch(true);
    const D1 = await enrolled();
    const D2 = await secondUser(D1);
    expect(D2.deviceId).toBe(D1.deviceId);
    const pkg = `@a331-${RUN}/two-users`;
    await seen(D1, { pkg });
    const r = await createRemoval(base({ kind: "device", deviceId: D1.deviceId }, { identity: pkg }));
    const ts = await targetsOf(r.removal.id);
    expect(ts.map((t) => t.identityId)).toEqual([D1.identityId]);
    // D2's read of the same device: nothing for it, and the read is audited
    expect((await directivesOf(D2)).json()).toEqual({ directives: [] });
    const reads = (await readsOf(D2)).filter((x) => (x.detail as { identityId: string }).identityId === D2.identityId);
    expect(reads.at(-1)!.detail).toMatchObject({ deviceId: D1.deviceId, identityId: D2.identityId, served: 0, outcome: "none" });
    // D1 is served it; D2 cannot report it; D1 can
    const envs = (await directivesOf(D1)).json().directives as Array<{ payload: string }>;
    const mine = envs.map(decode).filter((p) => p.removalId === r.removal.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.identityId).toBe(D1.identityId);
    const id = mine[0]!.directiveId as string;
    expect((await postOutcomes(D2, [{ directiveId: id, outcome: "nothing_to_remove", code: "not_present", notified: false }])).json()).toEqual({ accepted: 0, refused: [{ directiveId: id, code: "not_your_directive" }] });
    expect((await db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.id, id)))[0]!.status).toBe("delivered");
    expect((await postOutcomes(D1, [{ directiveId: id, outcome: "removed", code: "removed", notified: true }])).json()).toEqual({ accepted: 1, refused: [] });
    // the detail shows the bound identity by pseudonymous ids only
    const detail = (await inject(app, "GET", `/v1/discovery/endpoint-addon-removals/${r.removal.id}`, adminKey)).json();
    const row = detail.targets.items[0] as Record<string, string>;
    expect(row).toMatchObject({ identityId: D1.identityId, deviceId: D1.deviceId, status: "removed" });
    expect(row.deviceUserPseudonym).toMatch(/^psn:[0-9a-f]{24}$/);
    expect(JSON.stringify(detail)).not.toContain(`a331user${RUN}`);
  });

  it("admin routes refuse a non-admin; agent routes refuse a person", async () => {
    const m = await inject(app, "POST", "/v1/users", AUTH, { email: `a331-member-${RUN}@example.com`, displayName: "a331 member" });
    const memberKey = { authorization: `Bearer ${(await inject(app, "POST", `/v1/users/${m.json().id}/keys`, AUTH, { name: "k" })).json().token}` };
    expect((await inject(app, "GET", "/v1/discovery/endpoint-addon-removals", memberKey)).statusCode).toBe(403);
    expect((await inject(app, "POST", "/v1/discovery/endpoint-addon-removals", memberKey, base({ kind: "device", deviceId: A.deviceId }))).statusCode).toBe(403);
    expect((await inject(app, "GET", "/v1/endpoint-agent/directives", adminKey)).statusCode).toBe(401);
    // the agent's token reaches its own routes only
    expect((await inject(app, "GET", "/v1/discovery/endpoint-addon-removals", await A.key.headers("GET", "/v1/discovery/endpoint-addon-removals"))).statusCode).toBe(403);
    // a step-up grant of the new kind exists only through the CHECK's new vocabulary
    const [g] = await db.select({ n: sql<number>`count(*)::int` }).from(stepUpGrants).where(and(eq(stepUpGrants.userId, adminId), eq(stepUpGrants.actionKind, "endpoint_remediation")));
    expect(Number(g!.n)).toBeGreaterThan(0);
  });
});

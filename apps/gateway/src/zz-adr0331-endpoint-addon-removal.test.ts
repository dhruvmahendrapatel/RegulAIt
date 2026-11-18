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
  approvals,
  auditLog,
  createDb,
  discoveryPseudonymKeys,
  discoverySettings,
  discoverySources,
  endpointAddonRemovalDevices,
  endpointAddonRemovals,
  endpointAddonRemovalTargets,
  endpointDevices,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  runWithRlsPrincipal,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, DISCOVERY_STEP_UP_KEYS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { createRemovalSchema, endpointAddonRemovalDecideStepUp, endpointRemediationStepUp, type DevicePolicySigner } from "./endpoint-addon-removal.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { endpointAgentKeys } from "./testing/endpoint-agent-client.js";
import { enrolEndpointAgent, seenMcpServer, type EnrolledAgent } from "./testing/endpoint-addon-removal-fixture.js";
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
const signer: DevicePolicySigner = { kind: "device_policy_signer", keyId: "test-directive-key", signPayload: async (b) => edSign(null, b, directiveKeys.privateKey) };

let db: Db;
let app: ReturnType<typeof buildApp>;
let unsigned: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
/** the second administrator a removal names (ADR-0186), and a third admin outside its pool */
let approverId: string;
let otherAdminId: string;
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
/** request a removal with the right grant (expects 201): it awaits approval, nothing is written for its targets */
async function requestRemoval(body: Record<string, unknown>) {
  const { res } = await asAdmin(stepFor(body), "POST", "/v1/discovery/endpoint-addon-removals", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { removal: { id: string; status: string; approvalId: string; targets: Record<string, number>; expiresAt: string }; resolved: number; devices: number };
}
const approvalOfRemoval = async (removalId: string) => {
  const [r] = await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, removalId));
  return (await db.select().from(approvals).where(eq(approvals.id, r!.approvalId)))[0]!;
};
/** a decision through the one decide path, as `as`, with an approval_decide grant bound to `facts` (default: the right ones) */
async function decide(removalId: string, decision: "approved" | "denied" = "approved", as = approverId, grant: "right" | "none" | "wrong" = "right", reason?: string) {
  const ap = await approvalOfRemoval(removalId);
  const right = endpointAddonRemovalDecideStepUp(ap.id, decision, ap.argumentsDigest!);
  const args = grant === "wrong" ? endpointAddonRemovalDecideStepUp(ap.id, decision, "0".repeat(64)) : right;
  const g = await grantStepUpForTest(db, as, args);
  const r = grant === "none" ? sessionRequest(g) : stepUpRequest(g);
  const res = await app.inject({ method: "POST", url: `/v1/approvals/${ap.id}/decide`, headers: r.headers, cookies: r.cookies, payload: { decision, ...(reason ? { reason } : {}) } });
  return { res, grantId: g.grantId };
}
/** request and approve a removal (expects both to succeed); returns its detail after the approval */
async function createRemoval(body: Record<string, unknown>) {
  const asked = await requestRemoval(body);
  const d = await decide(asked.removal.id);
  expect(d.res.statusCode, d.res.body).toBe(200);
  const detail = await inject(app, "GET", `/v1/discovery/endpoint-addon-removals/${asked.removal.id}`, adminKey);
  expect(detail.statusCode, detail.body).toBe(200);
  return { removal: detail.json().removal as { id: string; status: string; targets: Record<string, number>; expiresAt: string }, devices: asked.devices };
}
const setMode = (mode: "normal" | "halted" | "read_only") =>
  db.update(orgSettings).set({ executionMode: mode, executionModeReason: mode === "normal" ? null : `a331 ${mode}` }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

const enrolled = () => enrolEndpointAgent(app, db, AgentKey, { auth: AUTH, run: RUN, enabledBy: adminId, sourceIds });
type Agent = EnrolledAgent;

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

/** evidence as an accepted report leaves it (ADR-0259's table), written directly so each case is exact */
const seen = (a: Agent, o: { root?: string; serverName?: string; pkg?: string; version?: string | null; daysAgo?: number; path?: string; noReport?: boolean }) =>
  seenMcpServer(db, a, { ...o, pkg: o.pkg ?? PKG, path: o.path ?? CONFIG });

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
  const [o0] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions, exec: orgSettings.executionMode }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    if (o0) await db.update(orgSettings).set({ stepUpMode: o0.mode, stepUpActions: o0.actions, executionMode: o0.exec }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
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
  for (const who of ["approver", "other"] as const) {
    const u = await inject(app, "POST", "/v1/users", AUTH, { email: `a331-${who}-${RUN}@example.com`, displayName: `a331 ${who}` });
    expect(u.statusCode, u.body).toBe(201);
    await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, u.json().id));
    if (who === "approver") approverId = u.json().id;
    else otherAdminId = u.json().id;
  }
  await setMode("normal");
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
    for (const id of [adminId, approverId, otherAdminId]) if (id) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, id));
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

const base = (scope: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ identityKind: "package", identity: PKG, scope, approverUserId: approverId, reason: `a331 flagged ${RUN}`, ...extra });

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
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, one.removal.id), eq(auditLog.ruleId, "endpoint-addon-removal-requested")));
    expect(audit).toMatchObject({ userId: adminId, effect: "require_approval", objectType: "endpoint_addon_removal" });
    expect(audit!.detail).toMatchObject({ targets: 2, devices: 1, stepUp: "totp", stepUpKind: "endpoint_remediation", blockReinstall: true, approverUserId: approverId });
    const [approved] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, one.removal.id), eq(auditLog.ruleId, "endpoint-addon-removal-approved")));
    expect(approved).toMatchObject({ userId: approverId, effect: "allow" });
    expect(approved!.detail).toMatchObject({ targets: 2, devices: 1, stepUp: "totp" });

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

  it("cancelling after delivery stops only undelivered targets; a delivered directive's real outcome is still recorded", async () => {
    await setSwitch(true);
    const pkg = `@a331-${RUN}/late-cancel`;
    await seen(A, { pkg });
    await seen(A, { pkg, root: "appdata", path: `Cursor/a331-late-${RUN}/mcp.json` });
    const r = await createRemoval(base({ kind: "device", deviceId: A.deviceId }, { identity: pkg }));
    const ts = await targetsOf(r.removal.id);
    expect(ts).toHaveLength(2);
    // deliver ONE of the two (the other stays pending), as an agent that fetched before the cancel
    await db.update(endpointAddonRemovalTargets).set({ status: "delivered", deliveredAt: sql`now()` }).where(eq(endpointAddonRemovalTargets.id, ts[0]!.id));
    const c = await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${r.removal.id}/cancel`, headers: adminKey });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ cancelled: 1, removal: { status: "cancelled", targets: { delivered: 1, cancelled: 1 } } });
    // the device ran it: its report is accepted and recorded, not refused as cancelled
    const out = await postOutcomes(A, [{ directiveId: ts[0]!.id, outcome: "removed", code: "removed", notified: true }]);
    expect(out.json()).toEqual({ accepted: 1, refused: [] });
    expect((await db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.id, ts[0]!.id)))[0]).toMatchObject({ status: "removed", code: "removed" });
    // the cancelled one never had a directive out: a report of it is refused, and it is never served
    expect((await postOutcomes(A, [{ directiveId: ts[1]!.id, outcome: "removed", code: "removed", notified: true }])).json()).toEqual({ accepted: 0, refused: [{ directiveId: ts[1]!.id, code: "directive_cancelled" }] });
    const ids = ((await directivesOf(A)).json().directives as Array<{ payload: string }>).map((e) => decode(e).removalId);
    expect(ids).not.toContain(r.removal.id);
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

describe("ADR-0331 + ADR-0186: a second administrator approves before anything is sent", () => {
  const pkg = `@a331-${RUN}/approval`;
  it("the request names an eligible approver; it queues an approval and writes no target", async () => {
    await setSwitch(true);
    await seen(A, { pkg });
    const self = base({ kind: "device", deviceId: A.deviceId }, { identity: pkg, approverUserId: adminId });
    expect((await asAdmin(stepFor(self), "POST", "/v1/discovery/endpoint-addon-removals", self)).res.json().error).toBe("approver_is_requester");
    const m = await inject(app, "POST", "/v1/users", AUTH, { email: `a331-nonadmin-${RUN}@example.com`, displayName: "a331 non-admin" });
    const nonAdmin = base({ kind: "device", deviceId: A.deviceId }, { identity: pkg, approverUserId: m.json().id });
    const na = await asAdmin(stepFor(nonAdmin), "POST", "/v1/discovery/endpoint-addon-removals", nonAdmin);
    expect(na.res.statusCode).toBe(422);
    expect(na.res.json().error).toBe("approver_not_eligible");
    expect(await grantSpent(db, na.grantId)).toBe(false);

    const asked = await requestRemoval(base({ kind: "device", deviceId: A.deviceId }, { identity: pkg }));
    expect(asked.removal.status).toBe("awaiting_approval");
    expect(asked.resolved).toBe(1);
    expect(await targetsOf(asked.removal.id)).toEqual([]);
    const ap = await approvalOfRemoval(asked.removal.id);
    expect(ap).toMatchObject({ objectType: "endpoint_addon_removal", userId: adminId, approverUserId: approverId, status: "pending" });
    expect(ap.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    // the approver's queue says what it removes, from where
    const sess = sessionRequest(await grantStepUpForTest(db, approverId, { kind: "settings_relax", facts: { unused: RUN } }));
    const queue = await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: sess.headers, cookies: sess.cookies });
    expect(queue.statusCode, queue.body).toBe(200);
    const row = (queue.json().approvals as Array<{ id: string; objectType: string; objectLabel: string }>).find((x) => x.id === ap.id);
    expect(row).toMatchObject({ objectType: "endpoint_addon_removal", objectLabel: `remove MCP server package '${pkg}' from one endpoint` });
    expect(ap.expiresAt!.getTime()).toBe((await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, asked.removal.id)))[0]!.expiresAt.getTime());
    expect(await db.select().from(endpointAddonRemovalDevices).where(eq(endpointAddonRemovalDevices.removalId, asked.removal.id))).toEqual([{ removalId: asked.removal.id, deviceId: A.deviceId }]);
    // nothing is served while it waits
    const served = ((await directivesOf(A)).json().directives as Array<{ payload: string }>).map((e) => decode(e).removalId);
    expect(served).not.toContain(asked.removal.id);

    // the requester cannot decide it, nor an admin outside its pool, nor the approver without the bound step-up
    // (with a reason, so the generic admin-override rule is satisfied and this kind's own guards answer)
    expect((await decide(asked.removal.id, "approved", adminId, "right", "override")).res.json().error).toBe("cannot_approve_own_endpoint_addon_removal");
    const outside = await decide(asked.removal.id, "approved", otherAdminId, "right", "override");
    expect(outside.res.statusCode).toBe(403);
    expect(outside.res.json().error).toBe("not_in_approval_pool");
    expect(await grantSpent(db, outside.grantId)).toBe(false);
    const none = await decide(asked.removal.id, "approved", approverId, "none");
    expect(none.res.statusCode).toBe(403);
    expect(none.res.json()).toMatchObject({ error: "step_up_required", actionKind: "approval_decide" });
    const wrong = await decide(asked.removal.id, "approved", approverId, "wrong");
    expect(wrong.res.statusCode).toBe(403);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect((await approvalOfRemoval(asked.removal.id)).status).toBe("pending");

    const ok = await decide(asked.removal.id);
    expect(ok.res.statusCode, ok.res.body).toBe(200);
    expect(await grantSpent(db, ok.grantId)).toBe(true);
    expect((await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, asked.removal.id)))[0]!.status).toBe("active");
    expect(await targetsOf(asked.removal.id)).toHaveLength(1);
    const now = ((await directivesOf(A)).json().directives as Array<{ payload: string }>).map((e) => decode(e).removalId);
    expect(now).toContain(asked.removal.id);
  });

  it("denied: nothing is ever written or sent", async () => {
    await setSwitch(true);
    const asked = await requestRemoval(base({ kind: "device", deviceId: A.deviceId }, { identity: pkg, reason: `deny ${RUN}` }));
    const d = await decide(asked.removal.id, "denied");
    expect(d.res.statusCode, d.res.body).toBe(200);
    expect((await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, asked.removal.id)))[0]!.status).toBe("denied");
    expect(await targetsOf(asked.removal.id)).toEqual([]);
    const c = await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${asked.removal.id}/cancel`, headers: adminKey });
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toBe("removal_not_cancellable");
  });

  it("stale: when the endpoints changed after the request, the approval sends nothing", async () => {
    await setSwitch(true);
    const stalePkg = `@a331-${RUN}/stale`;
    await seen(A, { pkg: stalePkg });
    const asked = await requestRemoval(base({ kind: "recent", days: 1 }, { identity: stalePkg }));
    // another endpoint reports it before the decision: what would be sent is no longer what was approved
    await seen(B, { pkg: stalePkg });
    const d = await decide(asked.removal.id);
    expect(d.res.statusCode, d.res.body).toBe(200);
    expect((await db.select().from(endpointAddonRemovals).where(eq(endpointAddonRemovals.id, asked.removal.id)))[0]!.status).toBe("stale");
    expect(await targetsOf(asked.removal.id)).toEqual([]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, asked.removal.id), eq(auditLog.ruleId, "endpoint-addon-removal-stale")));
    expect(audit!.detail).toMatchObject({ why: "targets_changed", resolved: 2 });
  });

  it("cancelling a removal that awaits its decision withdraws the approval", async () => {
    await setSwitch(true);
    const asked = await requestRemoval(base({ kind: "device", deviceId: A.deviceId }, { identity: pkg, reason: `withdraw ${RUN}` }));
    const c = await app.inject({ method: "POST", url: `/v1/discovery/endpoint-addon-removals/${asked.removal.id}/cancel`, headers: adminKey });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ cancelled: 0, removal: { status: "cancelled" } });
    expect((await approvalOfRemoval(asked.removal.id)).status).toBe("superseded");
    expect((await decide(asked.removal.id)).res.statusCode).not.toBe(200);
    expect(await targetsOf(asked.removal.id)).toEqual([]);
  });
});

describe("ADR-0331 + ADR-0186: the execution dial (kill switch)", () => {
  const pkg = `@a331-${RUN}/dial`;
  it("outside normal: no request is queued, no approval is accepted, and no directive is signed or delivered", async () => {
    await setSwitch(true);
    await seen(A, { pkg });
    const asked = await requestRemoval(base({ kind: "device", deviceId: A.deviceId }, { identity: pkg }));
    try {
      for (const mode of ["halted", "read_only"] as const) {
        await setMode(mode);
        const body = base({ kind: "device", deviceId: A.deviceId }, { identity: pkg, reason: `dial ${mode} ${RUN}` });
        const r = await asAdmin(stepFor(body), "POST", "/v1/discovery/endpoint-addon-removals", body);
        expect(r.res.statusCode).toBe(409);
        expect(r.res.json().error).toBe(mode === "halted" ? "execution_halted" : "execution_read_only");
        expect(await grantSpent(db, r.grantId)).toBe(false);
        const d = await decide(asked.removal.id);
        expect(d.res.statusCode).toBe(409);
        expect(await grantSpent(db, d.grantId)).toBe(false);
      }
      await setMode("normal");
      expect((await decide(asked.removal.id)).res.statusCode).toBe(200);
      const [target] = await targetsOf(asked.removal.id);
      for (const mode of ["halted", "read_only"] as const) {
        await setMode(mode);
        const res = await directivesOf(A);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({ directives: [] });
        expect((await lastRead(A)).detail).toMatchObject({ served: 0, outcome: mode === "halted" ? "execution_halted" : "execution_read_only" });
        // a halt destroys nothing: the target waits, undelivered
        expect((await db.select().from(endpointAddonRemovalTargets).where(eq(endpointAddonRemovalTargets.id, target!.id)))[0]!.status).toBe("pending");
      }
    } finally {
      await setMode("normal");
    }
    const served = ((await directivesOf(A)).json().directives as Array<{ payload: string }>).map((e) => decode(e).removalId);
    expect(served).toContain(asked.removal.id);
  });
});

describe("ADR-0331: the removal tables are under forced row-level security", () => {
  const TABLES = ["endpoint_addon_removal_devices", "endpoint_addon_removal_targets", "endpoint_addon_removals"];
  it("ENABLED and FORCED on all three; a non-admin principal sees nothing, an admin sees the rows", async () => {
    const r = await db.execute<{ relname: string; on: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname in ('endpoint_addon_removal_devices', 'endpoint_addon_removal_targets', 'endpoint_addon_removals') and relkind = 'r' order by relname`);
    expect(r.rows.map((x) => [x.relname, x.on, x.forced])).toEqual(TABLES.map((t) => [t, true, true]));
    const m = await inject(app, "POST", "/v1/users", AUTH, { email: `a331-rls-${RUN}@example.com`, displayName: "a331 rls" });
    const count = async () => {
      const out: number[] = [];
      for (const t of TABLES) out.push((await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t}`))).rows[0]!.n);
      return out;
    };
    await runWithRlsPrincipal({ userId: m.json().id }, async () => expect(await count()).toEqual([0, 0, 0]));
    await runWithRlsPrincipal({ userId: adminId }, async () => {
      const [devices, targets, removals] = await count();
      expect(devices! > 0 && targets! > 0 && removals! > 0).toBe(true);
    });
  });
});

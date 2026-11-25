/**
 * ADR-0360 slice 1c — delivering a rollout to devices, end to end (real database, an enrolled agent, a release
 * directory on disk signed by a runtime release key, and a runtime device-policy key through the code-only seam).
 *
 *  - a device is offered the update only while its rollout runs, its stage is reached and its group's self-update is
 *    on; the directive is signed over its own domain and names the device, the rollout and the version; the manifest is
 *    the release's own envelope; a release that does not verify (unknown key, tampered binary) is never offered;
 *  - the binary route serves only the device's own open offer;
 *  - the device's one result settles its attempt (a repeat is `already_reported`, another device's attempt is not
 *    found), and failed installs reaching the threshold halt the rollout;
 *  - nothing waits for ever: an unreported attempt expires and is offered again; the execution dial stops delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  discoverySources,
  endpointDeviceGroupFleetSettings,
  endpointDeviceGroupMembers,
  endpointDeviceGroups,
  endpointUpdateAttempts,
  endpointUpdateRolloutDevices,
  endpointUpdateRolloutStages,
  endpointUpdateRollouts,
  eq,
  inArray,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  runWithRlsSystem,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { ENDPOINT_UPDATE_ATTEMPT_MACHINE, STATE_MACHINES } from "@regulait/shared";
import { buildApp } from "./app.js";
import type { DirectiveSigner } from "./directive-signer.js";
import { AGENT_RELEASE_KEYS_ENV, AGENT_RELEASES_DIR_ENV, expireEndpointUpdates, UPDATE_DIRECTIVE_SIGNATURE_DOMAIN } from "./endpoint-update-delivery.js";
import { rolloutDecisionStepUp } from "./endpoint-fleet-routes.js";
import { endpointAgentKeys } from "./testing/endpoint-agent-client.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { enrolEndpointAgent, type EnrolledAgent } from "./testing/endpoint-addon-removal-fixture.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e41upd-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const DATA_KEY = createHash("sha256").update(`e41upd-data-key-${RUN}`).digest("hex");
const VERSION = "0.2.0";
const prev = { url: process.env.REGULAIT_PUBLIC_URL, dir: process.env[AGENT_RELEASES_DIR_ENV], keys: process.env[AGENT_RELEASE_KEYS_ENV] };
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

// runtime keys: the device-policy key (through the code-only seam) and the release pipeline's key
const policyKeys = generateKeyPairSync("ed25519");
const signer: DirectiveSigner = { kind: "directive_signer", keyId: "test-policy-key", signPayload: async (b) => edSign(null, b, policyKeys.privateKey) };
const releaseKeys = generateKeyPairSync("ed25519");
const rogueKeys = generateKeyPairSync("ed25519");
const xOf = (k: KeyObject) => (k.export({ format: "jwk" }) as { x: string }).x;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let admin2Id: string;
let releaseDir: string;
const BINARY = randomBytes(4096);
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
const groupIds: string[] = [];
const AgentKey = endpointAgentKeys(() => app, DATA_KEY, ORIGIN);

/** a release envelope signed by `key` over the bare manifest bytes (the release key signs only manifests) */
function releaseEnvelope(version: string, binary: Buffer, key: KeyObject = releaseKeys.privateKey, keyId = "release-test-1") {
  const payload = Buffer.from(
    JSON.stringify({ schema: "regulait.endpoint-release/1", version, issuedAt: new Date().toISOString(), targets: [{ os: "linux", arch: "amd64", sha256: createHash("sha256").update(binary).digest("hex"), length: binary.length }] }),
  );
  return { keyId, payload: payload.toString("base64"), signature: edSign(null, payload, key).toString("base64") };
}
function writeRelease(version: string, envelope: object, binary: Buffer) {
  mkdirSync(path.join(releaseDir, version), { recursive: true });
  writeFileSync(path.join(releaseDir, version, "release.json"), JSON.stringify(envelope));
  writeFileSync(path.join(releaseDir, version, "regulait-agent-linux-amd64"), binary);
}

const asAgent = async (a: EnrolledAgent, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { ...(await a.key.headers(method, url)), ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload: payload as object }) });
const offerOf = (a: EnrolledAgent) => asAgent(a, "GET", "/v1/endpoint-agent/update");
const report = (a: EnrolledAgent, attemptId: string, outcome: string, extra: Record<string, unknown> = {}) =>
  asAgent(a, "POST", "/v1/endpoint-agent/update-results", { attemptId, result: { schema: "regulait.endpoint-update-result/1", outcome, fromVersion: "0.1.0", at: new Date().toISOString(), ...extra } });

/** an enrolled device in a self-update group, and a running rollout of `version` whose one stage is that group */
async function deviceWithRollout(version = VERSION, opts: { selfUpdate?: boolean; haltThreshold?: number } = {}) {
  const a = await enrolEndpointAgent(app, db, AgentKey, { auth: AUTH, run: RUN, enabledBy: adminId, sourceIds });
  const [g] = await db.insert(endpointDeviceGroups).values({ name: `e41upd-${RUN}-${groupIds.length}` }).returning();
  groupIds.push(g!.id);
  await db.insert(endpointDeviceGroupMembers).values({ groupId: g!.id, deviceId: a.deviceId });
  if (opts.selfUpdate !== false) await db.insert(endpointDeviceGroupFleetSettings).values({ groupId: g!.id, selfUpdate: true, selfUpdateStepUp: "test", selfUpdateAuditId: adminId });
  const [r] = await db
    .insert(endpointUpdateRollouts)
    .values({ sourceId: a.sourceId, targetVersion: version, state: "running", createdBy: adminId, ...(opts.haltThreshold ? { haltThreshold: opts.haltThreshold, haltThresholdStepUp: "test", haltThresholdAuditId: adminId } : {}) })
    .returning();
  await db.insert(endpointUpdateRolloutStages).values({ rolloutId: r!.id, ordinal: 1, groupId: g!.id, groupName: g!.name, state: "active", startedAt: new Date() });
  // as the two-person approval captures it (the approval route itself is exercised in its own test below)
  await db.insert(endpointUpdateRolloutDevices).values({ rolloutId: r!.id, deviceId: a.deviceId, stageOrdinal: 1 });
  return { a, rolloutId: r!.id, groupId: g!.id };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  releaseDir = mkdtempSync(path.join(tmpdir(), "e41-releases-"));
  const keysFile = path.join(releaseDir, "release-keys.json");
  writeFileSync(keysFile, JSON.stringify([{ keyId: "release-test-1", x: xOf(releaseKeys.publicKey) }]));
  process.env[AGENT_RELEASES_DIR_ENV] = releaseDir;
  process.env[AGENT_RELEASE_KEYS_ENV] = keysFile;
  writeRelease(VERSION, releaseEnvelope(VERSION, BINARY), BINARY);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, directiveSigner: signer });
  await app.ready();
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e41upd-admin-${RUN}@example.com`, displayName: "admin" } });
  adminId = u.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const u2 = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e41upd-admin2-${RUN}@example.com`, displayName: "admin 2" } });
  admin2Id = u2.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin2Id));
}, 120_000);

afterAll(async () => {
  if (sourceIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  if (groupIds.length) await db.delete(endpointDeviceGroups).where(inArray(endpointDeviceGroups.id, groupIds));
  for (const r of restores.reverse()) await r();
  await app?.close();
  for (const [k, v] of [["REGULAIT_PUBLIC_URL", prev.url], [AGENT_RELEASES_DIR_ENV, prev.dir], [AGENT_RELEASE_KEYS_ENV, prev.keys]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ADR-0360 slice 1c: the declared attempt lifecycle", () => {
  it("is registered, settles once, and leaves expiry by a system re-offer", () => {
    expect(STATE_MACHINES[ENDPOINT_UPDATE_ATTEMPT_MACHINE.def.id]).toBe(ENDPOINT_UPDATE_ATTEMPT_MACHINE);
    expect(ENDPOINT_UPDATE_ATTEMPT_MACHINE.def.terminal).toEqual(["installed", "current", "refused", "failed", "rolled_back"]);
    expect(ENDPOINT_UPDATE_ATTEMPT_MACHINE.sourcesOf("redirect")).toEqual(["expired"]);
    expect(ENDPOINT_UPDATE_ATTEMPT_MACHINE.sourcesOf("report_failed")).toEqual(["directed", "expired"]);
  });
});

describe("ADR-0360 slice 1c: the offer", () => {
  it("signs a directive over its own domain for this device, serves the release's own manifest and its binary", async () => {
    const { a, rolloutId } = await deviceWithRollout();
    // only the device's self token reaches the route
    expect((await app.inject({ method: "GET", url: "/v1/endpoint-agent/update", headers: AUTH })).statusCode).toBe(401);
    const r = await offerOf(a);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const u = r.json().update;
    const payload = Buffer.from(u.directive.payload, "base64");
    const sig = Buffer.from(u.directive.signature, "base64");
    expect(u.directive.keyId).toBe("test-policy-key");
    // over the domain, never the bare payload (so it never verifies as a policy, #1033)
    expect(edVerify(null, Buffer.concat([UPDATE_DIRECTIVE_SIGNATURE_DOMAIN, payload]), policyKeys.publicKey, sig)).toBe(true);
    expect(edVerify(null, payload, policyKeys.publicKey, sig)).toBe(false);
    const d = JSON.parse(payload.toString());
    expect(Object.keys(d)).toEqual(["schema", "deviceId", "rolloutId", "targetVersion", "issuedAt", "notAfter"]);
    expect(d).toMatchObject({ schema: "regulait.endpoint-update-directive/1", deviceId: a.deviceId, rolloutId, targetVersion: VERSION });
    expect(new Date(d.notAfter).getTime() - new Date(d.issuedAt).getTime()).toBeLessThanOrEqual(24 * 3600_000);
    expect(u.manifest).toEqual(JSON.parse(readFileSync(path.join(releaseDir, VERSION, "release.json"), "utf8")));
    expect(u.binary).toEqual({ path: "/v1/endpoint-agent/update/binary", os: "linux", arch: "amd64", length: BINARY.length, sha256: createHash("sha256").update(BINARY).digest("hex") });
    const [att] = await db.select().from(endpointUpdateAttempts).where(eq(endpointUpdateAttempts.id, u.attemptId));
    expect(att).toMatchObject({ state: "directed", rolloutId, deviceId: a.deviceId, fromVersion: "0.1.0" });
    // the same attempt on the next sync
    expect((await offerOf(a)).json().update.attemptId).toBe(u.attemptId);
    const bin = await asAgent(a, "GET", "/v1/endpoint-agent/update/binary");
    expect(bin.statusCode).toBe(200);
    expect(bin.headers["content-type"]).toBe("application/octet-stream");
    expect(Buffer.compare(bin.rawPayload, BINARY)).toBe(0);
  });

  it("offers nothing while self-update is off, the rollout is not running, or the device already runs the version", async () => {
    const off = await deviceWithRollout(VERSION, { selfUpdate: false });
    expect((await offerOf(off.a)).json()).toEqual({ update: null });
    expect((await asAgent(off.a, "GET", "/v1/endpoint-agent/update/binary")).statusCode).toBe(404);
    const paused = await deviceWithRollout();
    await db.update(endpointUpdateRollouts).set({ state: "paused" }).where(eq(endpointUpdateRollouts.id, paused.rolloutId));
    expect((await offerOf(paused.a)).json()).toEqual({ update: null });
    const same = await deviceWithRollout("0.1.0");
    expect((await offerOf(same.a)).json()).toEqual({ update: null });
    expect(await db.select().from(endpointUpdateAttempts).where(inArray(endpointUpdateAttempts.rolloutId, [off.rolloutId, paused.rolloutId, same.rolloutId]))).toEqual([]);
  });

  it("never offers a release that does not verify: an unknown key or a tampered binary", async () => {
    writeRelease("0.3.0", releaseEnvelope("0.3.0", BINARY, rogueKeys.privateKey), BINARY);
    const rogue = await deviceWithRollout("0.3.0");
    expect((await offerOf(rogue.a)).json()).toEqual({ update: null });
    const tampered = Buffer.from(BINARY);
    tampered[0] = tampered[0]! ^ 0xff;
    writeRelease("0.4.0", releaseEnvelope("0.4.0", BINARY), tampered);
    const t = await deviceWithRollout("0.4.0");
    expect((await offerOf(t.a)).json()).toEqual({ update: null });
    const codes = (await db.select({ d: auditLog.detail }).from(auditLog).where(sql`${auditLog.ruleId} = 'endpoint-update-offer-refused' AND ${auditLog.detail}->>'rolloutId' IN (${rogue.rolloutId}, ${t.rolloutId})`)).map((x) => (x.d as { code: string }).code);
    expect(new Set(codes)).toEqual(new Set(["manifest_invalid", "binary_mismatch"]));
  });

  it("stops delivery while the execution dial is not normal", async () => {
    const { a } = await deviceWithRollout();
    await db.update(orgSettings).set({ executionMode: "halted", executionModeReason: "e41 test" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      expect((await offerOf(a)).json()).toEqual({ update: null });
    } finally {
      await db.update(orgSettings).set({ executionMode: "normal", executionModeReason: null }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });
});

describe("ADR-0360 slice 1c: results", () => {
  it("settles the attempt once, scoped to the device", async () => {
    const one = await deviceWithRollout();
    const other = await deviceWithRollout();
    const id = (await offerOf(one.a)).json().update.attemptId as string;
    expect((await report(one.a, id, "installed", { toVersion: "9.9.9" })).json().error).toBe("version_mismatch");
    // another device cannot settle this device's attempt
    expect((await report(other.a, id, "failed", { code: "install_failed" })).statusCode).toBe(404);
    const ok = await report(one.a, id, "installed", { toVersion: VERSION, rolloutId: one.rolloutId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ recorded: true, state: "installed" });
    const again = await report(one.a, id, "installed", { toVersion: VERSION });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_reported");
    // a settled attempt is not offered again
    expect((await offerOf(one.a)).json()).toEqual({ update: null });
  });

  it("halts the rollout when failed installs reach its threshold", async () => {
    const { a, rolloutId } = await deviceWithRollout();
    const id = (await offerOf(a)).json().update.attemptId as string;
    const r = await report(a, id, "rolled_back", { code: "installed_health_failed" });
    expect(r.json()).toEqual({ recorded: true, state: "rolled_back", rolloutHalted: true });
    expect((await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, rolloutId)))[0]!.state).toBe("halted");
    const rules = (await db.select({ r: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'rolloutId' = ${rolloutId}`)).map((x) => x.r);
    expect(rules).toEqual(expect.arrayContaining(["endpoint-update-offered", "endpoint-update-rolled-back", "endpoint-update-rollout-halt"]));
    // a halted rollout offers nothing
    expect((await offerOf(a)).json()).toEqual({ update: null });
  });

  it("expires an attempt nobody reports and offers it again; a late report still settles it", async () => {
    const { a } = await deviceWithRollout();
    const id = (await offerOf(a)).json().update.attemptId as string;
    await db.update(endpointUpdateAttempts).set({ expiresAt: sql`now() - interval '1 minute'` }).where(eq(endpointUpdateAttempts.id, id));
    // an expired attempt's binary is not served
    expect((await asAgent(a, "GET", "/v1/endpoint-agent/update/binary")).statusCode).toBe(404);
    await runWithRlsSystem("system_task", "test", () => expireEndpointUpdates(db));
    expect((await db.select().from(endpointUpdateAttempts).where(eq(endpointUpdateAttempts.id, id)))[0]!.state).toBe("expired");
    const again = await offerOf(a);
    expect(again.json().update.attemptId).toBe(id);
    expect((await db.select().from(endpointUpdateAttempts).where(eq(endpointUpdateAttempts.id, id)))[0]!.state).toBe("directed");
    await db.update(endpointUpdateAttempts).set({ state: "expired" }).where(eq(endpointUpdateAttempts.id, id));
    expect((await report(a, id, "refused", { code: "not_newer" })).json()).toEqual({ recorded: true, state: "refused" });
  });
});

/** a rollout action by a signed-in admin, and a decision by the second admin with its bound step-up */
const act = async (rolloutId: string, action: string) => {
  const g = await grantStepUpForTest(db, adminId, rolloutDecisionStepUp(rolloutId, "approve_start"));
  return app.inject({ method: "POST", url: `/v1/discovery/update-rollouts/${rolloutId}/${action}`, ...sessionRequest(g), payload: {} });
};
const decide = async (rolloutId: string, decision: "approve_start" | "approve_resume") => {
  const g = await grantStepUpForTest(db, admin2Id, rolloutDecisionStepUp(rolloutId, decision));
  return app.inject({ method: "POST", url: `/v1/discovery/update-rollouts/${rolloutId}/${decision}`, ...stepUpRequest(g), payload: {} });
};

describe("ADR-0360 slice 1c: the approval fixes which devices a rollout reaches (security review of #1248)", () => {
  it("never offers a device added to an approved stage's group afterwards; a new resume approval covers it", async () => {
    const a = await enrolEndpointAgent(app, db, AgentKey, { auth: AUTH, run: RUN, enabledBy: adminId, sourceIds });
    const [g] = await db.insert(endpointDeviceGroups).values({ name: `e41upd-${RUN}-cap-${groupIds.length}` }).returning();
    groupIds.push(g!.id);
    await db.insert(endpointDeviceGroupFleetSettings).values({ groupId: g!.id, selfUpdate: true, selfUpdateStepUp: "test", selfUpdateAuditId: adminId });
    const [r] = await db.insert(endpointUpdateRollouts).values({ sourceId: a.sourceId, targetVersion: VERSION, state: "draft", createdBy: adminId }).returning();
    await db.insert(endpointUpdateRolloutStages).values({ rolloutId: r!.id, ordinal: 1, groupId: g!.id, groupName: g!.name });
    // the second admin approves while the group holds no device: the approval covers none
    expect((await act(r!.id, "request_start")).statusCode).toBe(200);
    const ok = await decide(r!.id, "approve_start");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().rollout.state).toBe("running");
    expect(await db.select().from(endpointUpdateRolloutDevices).where(eq(endpointUpdateRolloutDevices.rolloutId, r!.id))).toEqual([]);
    // one admin adds the device to the group afterwards: it is not offered, and its binary is not served
    await db.insert(endpointDeviceGroupMembers).values({ groupId: g!.id, deviceId: a.deviceId });
    expect((await offerOf(a)).json()).toEqual({ update: null });
    expect((await asAgent(a, "GET", "/v1/endpoint-agent/update/binary")).statusCode).toBe(404);
    expect(await db.select().from(endpointUpdateAttempts).where(eq(endpointUpdateAttempts.rolloutId, r!.id))).toEqual([]);
    // pause, then a resume approved by the second admin re-captures the membership as it is now
    expect((await act(r!.id, "pause")).statusCode).toBe(200);
    expect((await act(r!.id, "request_resume")).statusCode).toBe(200);
    const resumed = await decide(r!.id, "approve_resume");
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(await db.select({ d: endpointUpdateRolloutDevices.deviceId, o: endpointUpdateRolloutDevices.stageOrdinal }).from(endpointUpdateRolloutDevices).where(eq(endpointUpdateRolloutDevices.rolloutId, r!.id))).toEqual([{ d: a.deviceId, o: 1 }]);
    const [row] = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'endpoint-update-rollout-approve-resume' AND ${auditLog.detail}->>'rolloutId' = ${r!.id}`);
    expect(row?.detail).toMatchObject({ devicesApproved: 1 });
    const offered = await offerOf(a);
    expect(offered.json().update?.attemptId, offered.body).toBeTruthy();
    // removing the device from the group narrows the rollout at once, with no approval
    await db.delete(endpointDeviceGroupMembers).where(and(eq(endpointDeviceGroupMembers.groupId, g!.id), eq(endpointDeviceGroupMembers.deviceId, a.deviceId)));
    expect((await offerOf(a)).json()).toEqual({ update: null });
  });
});

describe("ADR-0360 slice 1c: an admin reads a rollout's per-device attempts (review of #1248)", () => {
  it("pages the attempts with their declared lifecycle and reported codes", async () => {
    const { a, rolloutId } = await deviceWithRollout(VERSION, { haltThreshold: 5 });
    const id = (await offerOf(a)).json().update.attemptId as string;
    expect((await report(a, id, "failed", { code: "health_check_failed" })).statusCode).toBe(200);
    const url = `/v1/discovery/update-rollouts/${rolloutId}/attempts`;
    const r = await app.inject({ method: "GET", url, headers: AUTH });
    expect(r.statusCode, r.body).toBe(200);
    const items = r.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, deviceId: a.deviceId, state: "failed", code: "health_check_failed", fromVersion: "0.1.0", os: "linux", arch: "amd64" });
    expect(items[0]!.lifecycle).toMatchObject({ state: "failed", terminal: true });
    expect((await app.inject({ method: "GET", url: `/v1/discovery/update-rollouts/${randomUUID()}/attempts`, headers: AUTH })).statusCode).toBe(404);
  });
});

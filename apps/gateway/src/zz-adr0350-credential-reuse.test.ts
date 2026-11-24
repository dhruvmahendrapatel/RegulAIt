/**
 * ADR-0350 §11 (lane E31) — credential reuse across endpoints, from fingerprints only (real database).
 *
 *  - a fingerprint shared by two devices under the same key id is a finding: listed with the devices and user
 *    pseudonyms, and raised once in the audit trail for the identity that made it shared;
 *  - the same fingerprint under a different key id, or on one identity only, is not a finding;
 *  - a revoked device's fingerprints no longer count, in the groups, their holders and the detection;
 *  - the stored value is server-keyed under the data key, never the device fingerprint, and nothing is stored
 *    without a data key;
 *  - a complete report replaces the identity's set, a report with gaps never prunes by value, and rows under a key
 *    id the identity no longer reports are dropped;
 *  - only the first 12 hex characters of the server-keyed value are returned, and the report schema refuses a
 *    fingerprint without its key id;
 *  - the route is admin-only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  discoverySources,
  endpointAgentIdentities,
  endpointCredentialFingerprints,
  endpointDevices,
  endpointEnrolmentTokens,
  eq,
  inArray,
  runMigrations,
  users,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { credentialReuseServerKey, recordCredentialFingerprints, storedFingerprint, type ReportedKey } from "./endpoint-credential-reuse.js";
import { keyFoundSchema } from "./endpoint-mcp-config.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e31r-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const hex = (s: string, n: number) => createHash("sha256").update(`${s}-${RUN}`).digest("hex").slice(0, n);
const KEY = hex("key", 16);
const OTHER_KEY = hex("other-key", 16);
const SHARED = hex("shared", 64);
const ALONE = hex("alone", 64);
const DATA_KEY = hex("data-key", 64);
const SERVER_KEY = credentialReuseServerKey(DATA_KEY)!;
const stored = (keyId: string, fp: string) => storedFingerprint(SERVER_KEY, keyId, fp);
const record = (id: string, keys: ReportedKey[], complete = false) => recordCredentialFingerprints(db, id, keys, { dataKey: DATA_KEY, complete });
const storedFor = async (id: string) =>
  (await db.select({ keyId: endpointCredentialFingerprints.keyId, fingerprint: endpointCredentialFingerprints.fingerprint }).from(endpointCredentialFingerprints).where(eq(endpointCredentialFingerprints.identityId, id))).map((r) => `${r.keyId}:${r.fingerprint}`).sort();

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let sourceId: string;
let adminUser = "";
const devices: string[] = [];
const identities: string[] = [];

async function identity(deviceId: string, user: string): Promise<string> {
  const [w] = await db
    .insert(workloadIdentities)
    .values({ kind: "endpoint_agent", identifier: `spiffe://regulait.test/regulait/endpoint_agent/${hex(user + deviceId, 12)}`, sponsorUserIds: [adminUser] })
    .returning({ id: workloadIdentities.id });
  await db.insert(endpointAgentIdentities).values({ identityId: w!.id, deviceId, deviceUserPseudonym: `psn:${hex(user, 24)}`, keyProtection: "software", keyProvider: "file", agentVersion: "1.0.0" } as never);
  identities.push(w!.id);
  return w!.id;
}

const items = async () => (await app.inject({ method: "GET", url: "/v1/endpoint-credential-reuse?limit=200", headers: adminKey })).json().items as Array<{ keyId: string; fingerprintPrefix: string; devices: { deviceId: string }[]; userPseudonyms: string[]; ruleIds: string[] }>;
const mine = async () => (await items()).filter((i) => i.keyId === KEY || i.keyId === OTHER_KEY);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  let adminId = "";
  const mk = async (name: string, admin: boolean) => {
    const id = (await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e31r-${name}-${RUN}@example.com`, displayName: name } })).json().id as string;
    if (admin) {
      await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
      adminId = id;
      adminUser = id;
    }
    return { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } })).json().token}` };
  };
  adminKey = await mk("admin", true);
  memberKey = await mk("member", false);
  const [src] = await db.insert(discoverySources).values({ name: `e31r-${RUN}`, kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, createdBy: adminId }).returning({ id: discoverySources.id });
  sourceId = src!.id;
  const [tok] = await db.insert(endpointEnrolmentTokens).values({ sourceId, label: "e31r", tokenHash: hex("tok", 64), deviceCap: 5, expiresAt: new Date(Date.now() + 86_400_000) }).returning({ id: endpointEnrolmentTokens.id });
  for (const d of ["d1", "d2", "d3"]) {
    const [row] = await db
      .insert(endpointDevices)
      .values({ sourceId, tokenId: tok!.id, devicePseudonym: `psn:${hex(d, 24)}`, os: "linux", arch: "amd64", agentVersion: "1.0.0", ticketHash: hex(`t-${d}`, 64), ticketExpiresAt: new Date(Date.now() + 86_400_000) })
      .returning({ id: endpointDevices.id });
    devices.push(row!.id);
  }
});

afterAll(async () => {
  if (!db) return;
  // workload identities are never deleted (ADR-0188 decision 12); the device cascade removes the endpoint links and,
  // through them, the fingerprints
  await db.delete(endpointDevices).where(eq(endpointDevices.sourceId, sourceId));
  await db.delete(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.sourceId, sourceId));
  await db.delete(discoverySources).where(eq(discoverySources.id, sourceId));
  await app?.close();
});

describe("ADR-0350 §11 credential reuse", () => {
  let a = "";
  let b = "";
  it("one holder is not a finding; a second device makes it one, raised once", async () => {
    a = await identity(devices[0]!, "u1");
    b = await identity(devices[1]!, "u2");
    expect(await record(a, [{ ruleId: "dlp.secret.github_pat", fingerprint: SHARED, fingerprintKeyId: KEY }, { fingerprint: ALONE, fingerprintKeyId: KEY }, { ruleId: "x" }])).toEqual({ recorded: 2, reused: 0, pruned: 0 });
    // the same fingerprint under another tenant key is not the same credential
    await record(b, [{ fingerprint: ALONE, fingerprintKeyId: OTHER_KEY }]);
    expect(await mine()).toEqual([]);

    expect((await record(b, [{ ruleId: "dlp.secret.github_pat", fingerprint: SHARED, fingerprintKeyId: KEY }])).reused).toBe(1);
    // a repeat report raises nothing new
    expect((await record(b, [{ fingerprint: SHARED, fingerprintKeyId: KEY }])).reused).toBe(0);
    const found = await mine();
    expect(found).toHaveLength(1);
    expect(found[0]!.fingerprintPrefix).toBe(stored(KEY, SHARED).slice(0, 12));
    expect(found[0]!.devices.map((d) => d.deviceId).sort()).toEqual([devices[0]!, devices[1]!].sort());
    expect(found[0]!.userPseudonyms).toHaveLength(2);
    expect(found[0]!.ruleIds).toEqual(["dlp.secret.github_pat"]);
    const listed = JSON.stringify(await items());
    expect(listed).not.toContain(SHARED);
    expect(listed).not.toContain(SHARED.slice(0, 12));

    const raised = await db.select({ objectId: auditLog.objectId, ruleId: auditLog.ruleId, detail: auditLog.detail }).from(auditLog).where(inArray(auditLog.objectId, [a, b]));
    const hits = raised.filter((r) => r.ruleId === "endpoint-credential-reuse-detected");
    expect(hits.map((r) => r.objectId)).toEqual([b]);
    expect(JSON.stringify(hits)).not.toContain(SHARED.slice(0, 12));
  });

  it("stores the server-keyed value, never the device fingerprint, and nothing without a data key", async () => {
    const rows = await storedFor(a);
    expect(rows).toEqual([`${KEY}:${stored(KEY, ALONE)}`, `${KEY}:${stored(KEY, SHARED)}`].sort());
    expect(rows.join()).not.toContain(SHARED);
    expect(rows.join()).not.toContain(ALONE);
    // another data key gives other values: a table copy plus a laptop's key is not enough to test guesses
    expect(storedFingerprint(credentialReuseServerKey(hex("other-data-key", 64))!, KEY, SHARED)).not.toBe(stored(KEY, SHARED));
    const c = await identity(devices[2]!, "u3");
    expect(await recordCredentialFingerprints(db, c, [{ fingerprint: SHARED, fingerprintKeyId: KEY }], { dataKey: undefined, complete: true })).toEqual({ recorded: 0, reused: 0, pruned: 0 });
    expect(await storedFor(c)).toEqual([]);
  });

  it("a revoked device stops counting in the groups, their holders and the detection", async () => {
    const c = await identity(devices[2]!, "u4");
    await record(c, [{ fingerprint: SHARED, fingerprintKeyId: KEY }]);
    expect((await mine())[0]!.devices).toHaveLength(3);
    await db.update(endpointDevices).set({ revokedAt: new Date() }).where(eq(endpointDevices.id, devices[2]!));
    // still a group of two active devices, and the revoked third is not listed as a holder
    const found = await mine();
    expect(found).toHaveLength(1);
    expect(found[0]!.devices.map((d) => d.deviceId).sort()).toEqual([devices[0]!, devices[1]!].sort());
    // a fingerprint held only by an active device and a revoked one raises nothing
    const LONE = hex("lone", 64);
    await record(c, [{ fingerprint: LONE, fingerprintKeyId: KEY }]);
    await record(a, [{ fingerprint: SHARED, fingerprintKeyId: KEY }, { fingerprint: ALONE, fingerprintKeyId: KEY }, { fingerprint: LONE, fingerprintKeyId: KEY }]);
    const prefixes = (await db.select({ detail: auditLog.detail, ruleId: auditLog.ruleId }).from(auditLog).where(eq(auditLog.objectId, a)))
      .filter((r) => r.ruleId === "endpoint-credential-reuse-detected")
      .map((r) => (r.detail as { fingerprintPrefix: string }).fingerprintPrefix);
    expect(prefixes).toContain(stored(KEY, SHARED).slice(0, 12)); // shared with the active second device
    expect(prefixes).not.toContain(stored(KEY, LONE).slice(0, 12)); // held elsewhere by the revoked device only
    await db.update(endpointDevices).set({ revokedAt: new Date() }).where(eq(endpointDevices.id, devices[1]!));
    expect(await mine()).toEqual([]);
    await db.update(endpointDevices).set({ revokedAt: null }).where(inArray(endpointDevices.id, [devices[1]!, devices[2]!]));
  });

  it("prunes: a complete report replaces the set, a report with gaps does not, and an old key id is dropped", async () => {
    const ROTATED = hex("rotated", 64);
    // a report with gaps keeps what it did not see
    expect((await record(a, [{ fingerprint: SHARED, fingerprintKeyId: KEY }], false)).pruned).toBe(0);
    expect(await storedFor(a)).toContain(`${KEY}:${stored(KEY, ALONE)}`);
    // a complete report without ALONE drops it (the secret was rotated)
    expect((await record(a, [{ fingerprint: SHARED, fingerprintKeyId: KEY }, { fingerprint: ROTATED, fingerprintKeyId: KEY }], true)).pruned).toBeGreaterThan(0);
    expect(await storedFor(a)).toEqual([`${KEY}:${stored(KEY, ROTATED)}`, `${KEY}:${stored(KEY, SHARED)}`].sort());
    // the tenant key was rotated: rows under the old key id go, even from a report with gaps
    await record(a, [{ fingerprint: SHARED, fingerprintKeyId: OTHER_KEY }], false);
    expect(await storedFor(a)).toEqual([`${OTHER_KEY}:${stored(OTHER_KEY, SHARED)}`]);
    // a complete report with no fingerprints at all leaves nothing
    await record(a, [], true);
    expect(await storedFor(a)).toEqual([]);
  });

  it("refuses a fingerprint without its key id, and the route is admin-only", async () => {
    expect(keyFoundSchema.safeParse({ keyName: "K", present: true, fingerprint: SHARED }).success).toBe(false);
    expect(keyFoundSchema.safeParse({ keyName: "K", present: true, fingerprint: "nothex", fingerprintKeyId: KEY }).success).toBe(false);
    expect(keyFoundSchema.safeParse({ keyName: "K", present: true, fingerprint: SHARED, fingerprintKeyId: KEY }).success).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/endpoint-credential-reuse", headers: memberKey })).statusCode).toBe(403);
  });
});

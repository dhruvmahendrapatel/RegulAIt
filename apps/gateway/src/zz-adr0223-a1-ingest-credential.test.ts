/**
 * ADR-0223 amendment 1 — the drift monitor's scoped, write-only ingestion credential, end to end at the gateway edge.
 *
 *  - Off unless issued: with no credential the ingest route answers 401 to everything, an admin API key included.
 *  - Issue, rotate and revoke are admin-only and need an `identity_manage` step-up bound to the exact facts; each is
 *    audited in the same transaction. The token is shown once and stored only as its SHA-256; it always expires.
 *  - The credential opens exactly one route for exactly one monitor: another monitor is 403 (audited), any read
 *    (its own monitor's reports, the credential list, a GET on the ingest path) is refused.
 *  - Revocation and expiry take effect on the next request (401, audited as a denial). Rotation kills the old secret.
 *  - Replay: an Idempotency-Key records one report; a repeat with the same summary returns it (200, nothing written),
 *    a repeat with a different summary is 409.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  modelCards,
  modelDriftIngestCredentials,
  modelDriftReports,
  modelDriftSettings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { routeAuthClass } from "./route-classes.js";
import { DRIFT_INGEST_AUDIT_RULE_IDS, DRIFT_INGEST_ROUTE } from "./drift-ingest-credentials.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0223a1-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const PIN = "scorecard-a1";

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let cardId: string;
let monitorA: string;
let monitorB: string;
const restores: Array<() => Promise<void>> = [];

const reference = [{ name: "income", kind: "numeric", edges: [0, 10, 20, 30], counts: [300, 400, 300] }];
const summary = (shift = 0) => ({
  windowStart: "2026-10-01T00:00:00Z",
  windowEnd: "2026-10-02T00:00:00Z",
  features: [{ name: "income", kind: "numeric", edges: [0, 10, 20, 30], counts: [310 + shift, 390 - shift, 300] }],
});
const ingestUrl = (monitor: string) => DRIFT_INGEST_ROUTE.replace(":monitorId", monitor);
const credsUrl = (monitor: string) => `/v1/model-drift/monitors/${monitor}/ingest-credentials`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const key = () => `k-${randomUUID()}`;

const push = (token: string, monitor: string, payload: object, idem: string | null = key()): Promise<LightMyRequestResponse> =>
  app.inject({ method: "POST", url: ingestUrl(monitor), headers: { ...bearer(token), ...(idem ? { "idempotency-key": idem } : {}) }, payload });

const steppedUp = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "identity_manage", facts }));
const sessionOnly = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "identity_manage", facts: { unrelated: true } }));

async function issue(monitor: string, name: string, expiresInDays = 30): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: "POST",
    url: credsUrl(monitor),
    ...(await steppedUp({ op: "drift_ingest_credential_issue", monitorId: monitor, name, expiresInDays })),
    payload: { name, expiresInDays },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().credential.id, token: res.json().token };
}
async function revoke(monitor: string, credentialId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "DELETE",
    url: `${credsUrl(monitor)}/${credentialId}`,
    ...(await steppedUp({ op: "drift_ingest_credential_revoke", monitorId: monitor, credentialId })),
  });
}
const auditRows = (ruleId: string, objectId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId))).orderBy(desc(auditLog.seq));
const reportsOn = (monitor: string) => db.select().from(modelDriftReports).where(eq(modelDriftReports.monitorId, monitor));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  await db.delete(modelDriftSettings);
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0223a1-admin-${RUN}@example.com`, displayName: "ingest admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0223a1" } });
  KEY = { authorization: `Bearer ${k.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `adr0223a1-scorer-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  const [card] = await db.insert(modelCards).values({ agentId: a.json().id, intendedUse: "credit pre-screening (classical scorecard)", pinnedModelVersion: PIN }).returning();
  cardId = card!.id;
  // the feature on (a direct row: turning it on through the API is ADR-0223's own test)
  await db.insert(modelDriftSettings).values({ enabled: true, maxReportsPerHour: 120, minSamples: 100 });
  for (const name of ["A", "B"]) {
    const m = await app.inject({ method: "POST", url: `/v1/mrm/cards/${cardId}/drift-monitors`, headers: KEY, payload: { name: `monitor ${name}`, reference } });
    expect(m.statusCode, m.body).toBe(201);
    if (name === "A") monitorA = m.json().monitor.id;
    else monitorB = m.json().monitor.id;
  }
});

/** each test starts with no live credential, whether or not the previous one reached its own revoke */
afterEach(async () => {
  await db.update(modelDriftIngestCredentials).set({ revokedAt: sql`now()` }).where(sql`${modelDriftIngestCredentials.revokedAt} IS NULL AND ${modelDriftIngestCredentials.createdAt} <= now()`);
});

/** a step-up refusal: 403 step_up_required with a method to use, or 422 step_up_unavailable when none is enrolled */
const expectStepUpRefused = (r: LightMyRequestResponse) => {
  expect([403, 422], r.body).toContain(r.statusCode);
  expect(r.json().error).toMatch(/^step_up_/);
};

afterAll(async () => {
  await db.delete(modelDriftSettings);
  if (cardId) await db.delete(modelCards).where(eq(modelCards.id, cardId));
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0223 amendment 1 — the per-monitor ingestion credential", () => {
  it("is public to the platform hooks only on its one POST route; the management routes stay admin", () => {
    expect(routeAuthClass("POST", DRIFT_INGEST_ROUTE)).toBe("public");
    expect(routeAuthClass("GET", "/v1/model-drift/monitors/:monitorId/ingest-credentials")).toBe("admin");
    expect(routeAuthClass("POST", "/v1/model-drift/monitors/:monitorId/ingest-credentials")).toBe("admin");
    expect(routeAuthClass("DELETE", "/v1/model-drift/monitors/:monitorId/ingest-credentials/:credentialId")).toBe("admin");
  });

  it("is off unless issued: no credential, a malformed one or an admin API key are each 401, and nothing is written", async () => {
    const none = await app.inject({ method: "POST", url: ingestUrl(monitorA), headers: { "idempotency-key": key() }, payload: summary() });
    const malformed = await push("rgldi_short", monitorA, summary());
    const unknown = await push("rgldi_" + "A".repeat(43), monitorA, summary());
    const admin = await app.inject({ method: "POST", url: ingestUrl(monitorA), headers: { ...KEY, "idempotency-key": key() }, payload: summary() });
    for (const r of [none, malformed, unknown, admin]) {
      expect(r.statusCode, r.body).toBe(401);
      expect(r.json().error).toBe("invalid_ingest_credential");
    }
    expect(await reportsOn(monitorA)).toHaveLength(0);
  });

  it("issuing needs an admin with an identity_manage step-up bound to the facts; the secret is shown once and stored as a hash", async () => {
    const payload = { name: "nightly pipeline", expiresInDays: 30 };
    const byKey = await app.inject({ method: "POST", url: credsUrl(monitorA), headers: KEY, payload });
    expectStepUpRefused(byKey);
    const noGrant = await app.inject({ method: "POST", url: credsUrl(monitorA), ...(await sessionOnly()), payload });
    expectStepUpRefused(noGrant);
    const wrongFacts = await app.inject({
      method: "POST",
      url: credsUrl(monitorA),
      ...(await steppedUp({ op: "drift_ingest_credential_issue", monitorId: monitorA, name: payload.name, expiresInDays: 365 })),
      payload,
    });
    expectStepUpRefused(wrongFacts);
    expect(await db.select().from(modelDriftIngestCredentials).where(eq(modelDriftIngestCredentials.monitorId, monitorA))).toHaveLength(0);

    const { id, token } = await issue(monitorA, payload.name, payload.expiresInDays);
    expect(token).toMatch(/^rgldi_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(modelDriftIngestCredentials).where(eq(modelDriftIngestCredentials.id, id));
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    // it expires: 30 days after issue on the database clock
    const days = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(30, 5);
    // the list never shows it again
    const list = await app.inject({ method: "GET", url: credsUrl(monitorA), headers: KEY });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.json().credentials[0]).toMatchObject({ id, state: "active" });
    const audited = await auditRows(DRIFT_INGEST_AUDIT_RULE_IDS.issued, id);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.userId).toBe(adminId);
    expect(JSON.stringify(audited[0])).not.toContain(token);
    await revoke(monitorA, id);
  });

  it("refuses a lifetime past 365 days and a third live credential on one monitor", async () => {
    const tooLong = await app.inject({
      method: "POST",
      url: credsUrl(monitorB),
      ...(await steppedUp({ op: "drift_ingest_credential_issue", monitorId: monitorB, name: "x", expiresInDays: 366 })),
      payload: { name: "x", expiresInDays: 366 },
    });
    expect(tooLong.statusCode).toBe(400);
    const one = await issue(monitorB, "one");
    const two = await issue(monitorB, "two");
    const third = await app.inject({
      method: "POST",
      url: credsUrl(monitorB),
      ...(await steppedUp({ op: "drift_ingest_credential_issue", monitorId: monitorB, name: "three", expiresInDays: 30 })),
      payload: { name: "three", expiresInDays: 30 },
    });
    expect(third.statusCode, third.body).toBe(409);
    await revoke(monitorB, one.id);
    await revoke(monitorB, two.id);
  });

  it("records a summary for its own monitor, attributed to the credential, with no platform identity", async () => {
    const { id, token } = await issue(monitorA, "attribution");
    const res = await push(token, monitorA, summary());
    expect(res.statusCode, res.body).toBe(201);
    const reportId = res.json().report.id;
    const [r] = await db.select().from(modelDriftReports).where(eq(modelDriftReports.id, reportId));
    expect(r).toMatchObject({ ingestCredentialId: id, submittedBy: null, source: "push", modelVersion: PIN });
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "model-drift-report-recorded"), sql`${auditLog.detail}->>'reportId' = ${reportId}`));
    expect((a!.detail as { actor: unknown }).actor).toEqual({ type: "drift_ingest_credential", id, name: "attribution" });
    const [c] = await db.select().from(modelDriftIngestCredentials).where(eq(modelDriftIngestCredentials.id, id));
    expect(c!.lastUsedAt).not.toBeNull();
    // source is always push; an attempt to label it an upload is refused
    const upload = await push(token, monitorA, { ...summary(), source: "upload" });
    expect(upload.statusCode).toBe(400);
    await revoke(monitorA, id);
  });

  it("is bound to one monitor: another monitor is 403, audited, and nothing is written there", async () => {
    const { id, token } = await issue(monitorA, "scoped");
    const before = (await reportsOn(monitorB)).length;
    const res = await push(token, monitorB, summary());
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("credential_not_for_monitor");
    expect(await reportsOn(monitorB)).toHaveLength(before);
    const denied = await auditRows(DRIFT_INGEST_AUDIT_RULE_IDS.refused, id);
    expect(denied[0]).toMatchObject({ effect: "deny" });
    expect(denied[0]!.detail).toMatchObject({ boundMonitorId: monitorA, requestedMonitorId: monitorB });
    await revoke(monitorA, id);
  });

  it("cannot read anything: its own monitor's reports, the credential list, the admin routes, or a GET on its route", async () => {
    const { id, token } = await issue(monitorA, "write-only");
    const reads = [
      await app.inject({ method: "GET", url: `/v1/model-drift/monitors/${monitorA}/reports`, headers: bearer(token) }),
      await app.inject({ method: "GET", url: credsUrl(monitorA), headers: bearer(token) }),
      await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}/drift`, headers: bearer(token) }),
      await app.inject({ method: "GET", url: "/v1/model-drift/settings", headers: bearer(token) }),
      await app.inject({ method: "POST", url: `/v1/model-drift/monitors/${monitorA}/reports`, headers: { ...bearer(token), "idempotency-key": key() }, payload: summary() }),
      await app.inject({ method: "GET", url: "/v1/me", headers: bearer(token) }),
    ];
    for (const r of reads) expect(r.statusCode, r.body).toBe(401);
    // only POST is registered on the ingest path; a GET there meets the platform's admin gate, which knows no rgldi_
    const get = await app.inject({ method: "GET", url: ingestUrl(monitorA), headers: bearer(token) });
    expect([401, 404]).toContain(get.statusCode);
    expect(get.body).not.toContain("income");
    await revoke(monitorA, id);
  });

  it("is replay-safe: one idempotency key records one report", async () => {
    const { id, token } = await issue(monitorA, "replay");
    const missing = await push(token, monitorA, summary(), null);
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe("idempotency_key_required");
    const idem = key();
    const first = await push(token, monitorA, summary(3), idem);
    expect(first.statusCode, first.body).toBe(201);
    const count = (await reportsOn(monitorA)).length;
    const again = await push(token, monitorA, summary(3), idem);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, report: { id: first.json().report.id } });
    const different = await push(token, monitorA, summary(4), idem);
    expect(different.statusCode, different.body).toBe(409);
    expect(different.json().error).toBe("idempotency_key_reused");
    expect(await reportsOn(monitorA)).toHaveLength(count);
    await revoke(monitorA, id);
  });

  it("revocation takes effect on the next request and needs a step-up; a second revoke changes nothing", async () => {
    const { id, token } = await issue(monitorA, "revoked");
    expect((await push(token, monitorA, summary())).statusCode).toBe(201);
    const byKey = await app.inject({ method: "DELETE", url: `${credsUrl(monitorA)}/${id}`, headers: KEY });
    expectStepUpRefused(byKey);
    const done = await revoke(monitorA, id);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().changed).toBe(true);
    expect(await auditRows(DRIFT_INGEST_AUDIT_RULE_IDS.revoked, id)).toHaveLength(1);
    const after = await push(token, monitorA, summary());
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("invalid_ingest_credential");
    expect((await auditRows(DRIFT_INGEST_AUDIT_RULE_IDS.refused, id))[0]!.detail).toMatchObject({ state: "revoked" });
    const twice = await revoke(monitorA, id);
    expect(twice.json().changed).toBe(false);
  });

  it("an expired credential is refused (401, audited as expired) and cannot be rotated", async () => {
    const { id, token } = await issue(monitorA, "expired");
    await db
      .update(modelDriftIngestCredentials)
      .set({ createdAt: sql`now() - interval '2 days'`, expiresAt: sql`now() - interval '1 second'` })
      .where(eq(modelDriftIngestCredentials.id, id));
    const res = await push(token, monitorA, summary());
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_ingest_credential");
    expect((await auditRows(DRIFT_INGEST_AUDIT_RULE_IDS.refused, id))[0]!.detail).toMatchObject({ state: "expired" });
    const rotate = await app.inject({
      method: "POST",
      url: `${credsUrl(monitorA)}/${id}/rotate`,
      ...(await steppedUp({ op: "drift_ingest_credential_rotate", monitorId: monitorA, credentialId: id, expiresInDays: 30 })),
      payload: { expiresInDays: 30 },
    });
    expect(rotate.statusCode).toBe(409);
    await revoke(monitorA, id);
  });

  it("rotation needs a step-up, revokes the old secret and issues a new one in one audited transaction", async () => {
    const { id, token } = await issue(monitorA, "rotated");
    const url = `${credsUrl(monitorA)}/${id}/rotate`;
    const noGrant = await app.inject({ method: "POST", url, ...(await sessionOnly()), payload: { expiresInDays: 30 } });
    expectStepUpRefused(noGrant);
    const res = await app.inject({
      method: "POST",
      url,
      ...(await steppedUp({ op: "drift_ingest_credential_rotate", monitorId: monitorA, credentialId: id, expiresInDays: 30 })),
      payload: { expiresInDays: 30 },
    });
    expect(res.statusCode, res.body).toBe(201);
    const fresh = res.json();
    expect(fresh.token).not.toBe(token);
    expect(fresh.credential).toMatchObject({ replacesId: id, name: "rotated", state: "active" });
    expect((await push(token, monitorA, summary())).statusCode).toBe(401);
    expect((await push(fresh.token, monitorA, summary())).statusCode).toBe(201);
    expect(await auditRows(DRIFT_INGEST_AUDIT_RULE_IDS.rotated, fresh.credential.id)).toHaveLength(1);
    await revoke(monitorA, fresh.credential.id);
  });

  it("follows the feature switch: off refuses pushes and new credentials, and revoking still works", async () => {
    const { id, token } = await issue(monitorA, "switch");
    await db.update(modelDriftSettings).set({ enabled: false });
    try {
      const res = await push(token, monitorA, summary());
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("model_drift_disabled");
      const issueOff = await app.inject({
        method: "POST",
        url: credsUrl(monitorA),
        ...(await steppedUp({ op: "drift_ingest_credential_issue", monitorId: monitorA, name: "off", expiresInDays: 30 })),
        payload: { name: "off", expiresInDays: 30 },
      });
      expect(issueOff.statusCode).toBe(409);
      expect((await revoke(monitorA, id)).json().changed).toBe(true);
    } finally {
      await db.update(modelDriftSettings).set({ enabled: true });
    }
  });
});

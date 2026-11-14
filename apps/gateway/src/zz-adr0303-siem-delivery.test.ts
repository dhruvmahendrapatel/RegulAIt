/**
 * ADR-0303 — SIEM delivery of the audit chain: the receiver contract.
 *
 * The receiver is injected (`fetchImpl`, the guarded fetch's test seam) and the destination host is put on the
 * egress allow-list for this file only. Every fixture names its own rows by this run's ids; other files' audit rows
 * may share a batch and are never asserted on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { and, auditLog, createDb, desc, eq, egressAllowHosts, runMigrations, siemDestinations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import {
  deliverSiemDestinationOnce,
  runSiemDeliverySweep,
  siemBackoffSeconds,
  siemEventFromAuditRow,
  SIEM_ENVELOPE_SCHEMA,
  SIEM_LIMITS,
  SIEM_RULE_IDS,
} from "./siem-delivery.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0303-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const RUN = Date.now();
const HOST = `siem-${RUN}.example.com`;
const URL_OK = `https://${HOST}/ingest`;
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let destId: string;
let secret: string;
const restores: Array<() => Promise<void>> = [];

interface Got {
  url: string;
  headers: Headers;
  body: string;
}
/** a receiver that answers `statuses` in turn (the last one repeats) and records every request */
function receiver(statuses: Array<number | "throw-timeout" | "throw-network">, headers: Record<string, string> = {}) {
  const got: Got[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    got.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
    const s = statuses[Math.min(i++, statuses.length - 1)]!;
    if (s === "throw-timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (s === "throw-network") throw new Error("ECONNRESET");
    return new Response("ok", { status: s, headers });
  }) as typeof fetch;
  return { fetchImpl, got };
}

const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
const asSteppedUp = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
const dest = async () => (await db.select().from(siemDestinations).where(eq(siemDestinations.id, destId)))[0]!;
const makeDue = () => db.update(siemDestinations).set({ nextAttemptAt: null }).where(eq(siemDestinations.id, destId));

/** a chained audit row with sensitive-looking prose that must never leave */
async function writeAuditRow(tag: string): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({
    id,
    userId: adminId,
    objectType: "project",
    objectId: null,
    detail: { secretish: `DETAIL-${tag}-${RUN}`, prompt: "PROMPT TEXT" },
    effect: "deny",
    ruleId: `adr0303-test-${tag}`,
    ruleChain: [{ rule: "x" }] as never,
    reason: `REASON-${tag}-${RUN}`,
  });
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  await db.insert(egressAllowHosts).values({ host: HOST, allowPrivateRanges: false, allowPlaintextHttp: false });
  restores.push(async () => {
    await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, HOST));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0303-admin-${RUN}@example.com`, displayName: "siem admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0303" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  // a destination left enabled would deliver from another file's sweep: turn this file's off
  await db.update(siemDestinations).set({ enabled: false }).where(sql`${siemDestinations.name} like ${`adr0303-${RUN}%`}`);
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0303 destinations: off by default, enabling is a step-up", () => {
  it("validates the URL and refuses plaintext unless asked", async () => {
    for (const url of ["not a url", `http://${HOST}/x`, `https://u:p@${HOST}/x`, `ftp://${HOST}/x`]) {
      const res = await app.inject({ method: "POST", url: "/v1/siem/destinations", headers: KEY, payload: { name: `adr0303-${RUN}-bad`, url } });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("a new destination is off, starts at the chain head, and shows its secret once", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/siem/destinations", headers: KEY, payload: { name: `adr0303-${RUN}`, url: URL_OK } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    // lag 1: the creation audit row itself is after the cursor
    expect(body.destination).toMatchObject({ enabled: false, state: "active", lag: 1, envelope: SIEM_ENVELOPE_SCHEMA });
    expect(body.secret).toMatch(/^whsec_/);
    secret = body.secret;
    destId = body.destination.id;
    const list = await app.inject({ method: "GET", url: "/v1/siem/destinations", headers: KEY });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(secret);
    expect((await dest()).secretCiphertext).not.toContain(secret.slice(6, 20));
    const dupe = await app.inject({ method: "POST", url: "/v1/siem/destinations", headers: KEY, payload: { name: `ADR0303-${RUN}`, url: URL_OK } });
    expect(dupe.statusCode).toBe(409);
  });

  it("a disabled destination is never sent to", async () => {
    await writeAuditRow("while-off");
    const r = receiver([200]);
    expect((await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: r.fetchImpl })).outcome).toBe("not_claimed");
    expect(r.got).toHaveLength(0);
  });

  it("enabling needs a step-up bound to the destination and URL, and is audited as a relaxation", async () => {
    const refused = await app.inject({ method: "PUT", url: `/v1/siem/destinations/${destId}/enabled`, ...(await asSession()), payload: { enabled: true } });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    const res = await app.inject({
      method: "PUT",
      url: `/v1/siem/destinations/${destId}/enabled`,
      ...(await asSteppedUp({ siem: "enable", destinationId: destId, url: URL_OK })),
      payload: { enabled: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.objectId, destId)).orderBy(desc(auditLog.at)).limit(1);
    expect(row!.ruleId).toBe(SIEM_RULE_IDS.enabled);
    expect((row!.detail as Record<string, unknown>).relaxation).toBe(true);
  });
});

describe("ADR-0303 the receiver contract", () => {
  it("sends signed, ordered batches of the allow-listed fields only, and moves the cursor on 2xx", async () => {
    const before = (await dest()).cursorSeq;
    const a = await writeAuditRow("a");
    const b = await writeAuditRow("b");
    const r = receiver([200]);
    const out = await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: r.fetchImpl });
    expect(out.outcome).toBe("delivered");
    expect(r.got.length).toBeGreaterThanOrEqual(1);
    const events: Array<Record<string, unknown>> = [];
    let prevTo = before;
    for (const g of r.got) {
      // a standard verifier accepts it with the destination's secret
      const verified = new Webhook(secret).verify(g.body, Object.fromEntries(g.headers.entries())) as Record<string, any>;
      expect(verified.schema).toBe(SIEM_ENVELOPE_SCHEMA);
      expect(verified.batch.afterSeq).toBe(prevTo);
      prevTo = verified.batch.toSeq;
      events.push(...verified.events);
    }
    const seqs = events.map((e) => e.seq as number);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    const mine = events.filter((e) => e.id === a || e.id === b);
    expect(mine.map((e) => e.id)).toEqual([a, b]);
    // exactly the allow-listed keys: nothing from detail, reason, user, rule chain
    for (const e of mine) expect(Object.keys(e).sort()).toEqual(["at", "chain", "effect", "id", "object", "ruleId", "scope", "seq"]);
    const all = r.got.map((g) => g.body).join("\n");
    expect(all).not.toContain(`REASON-a-${RUN}`);
    expect(all).not.toContain(`DETAIL-a-${RUN}`);
    expect(all).not.toContain("PROMPT TEXT");
    expect(all).not.toContain(adminId);
    const d = await dest();
    expect(d.cursorSeq).toBe(prevTo);
    expect(d).toMatchObject({ state: "active", consecutiveFailures: 0, lastErrorCode: null });
    expect(d.leaseUntil).toBeNull();
  });

  it("the event allow-list is one function with fixed keys", () => {
    const e = siemEventFromAuditRow({
      id: "x", seq: 1, at: new Date(0), deployMode: null, effect: "allow", ruleId: "r", objectType: "project", objectId: null,
      prevHash: "p", rowHash: "h", chainVersion: null,
    });
    expect(e).toEqual({
      id: "x", seq: 1, at: "1970-01-01T00:00:00.000Z", scope: { deployMode: null }, effect: "allow", ruleId: "r",
      object: { type: "project", id: null }, chain: { prevHash: "p", rowHash: "h", version: 1 },
    });
  });

  it("a 5xx keeps the cursor, backs off, and the retry resends the same batch with the same webhook-id", async () => {
    const c0 = (await dest()).cursorSeq;
    await writeAuditRow("retry");
    const fail = receiver([503]);
    const out = await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: fail.fetchImpl });
    expect(out).toMatchObject({ outcome: "failed", code: "http_5xx" });
    let d = await dest();
    expect(d).toMatchObject({ cursorSeq: c0, state: "backoff", consecutiveFailures: 1, lastErrorCode: "http_5xx" });
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // not due yet: the sweep skips it
    const early = receiver([200]);
    expect((await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: early.fetchImpl })).outcome).toBe("not_claimed");
    await makeDue();
    const ok = receiver([200]);
    expect((await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: ok.fetchImpl })).outcome).toBe("delivered");
    expect(ok.got[0]!.headers.get("webhook-id")).toBe(fail.got[0]!.headers.get("webhook-id"));
    d = await dest();
    expect(d).toMatchObject({ state: "active", consecutiveFailures: 0 });
    expect(d.cursorSeq).toBeGreaterThan(c0);
  });

  it("a 429's Retry-After is respected within the cap; timeouts, resets and 4xx are coded, never echoed", async () => {
    await writeAuditRow("429");
    const r = receiver([429], { "retry-after": "900" });
    await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: r.fetchImpl });
    const d = await dest();
    expect(d.lastErrorCode).toBe("http_429");
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 800_000);
    for (const [s, code] of [["throw-timeout", "timeout"], ["throw-network", "network"], [401, "http_4xx"], [413, "http_413"]] as const) {
      await makeDue();
      const out = await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: receiver([s]).fetchImpl });
      expect(out.code).toBe(code);
    }
    expect(siemBackoffSeconds(1)).toBe(SIEM_LIMITS.baseBackoffSeconds);
    expect(siemBackoffSeconds(50)).toBe(SIEM_LIMITS.maxBackoffSeconds);
    expect(siemBackoffSeconds(1, 99_999)).toBe(SIEM_LIMITS.maxBackoffSeconds);
  });

  it("a host off the egress allow-list gets nothing", async () => {
    await db.update(siemDestinations).set({ url: "https://not-allowed.example.org/x", nextAttemptAt: null }).where(eq(siemDestinations.id, destId));
    const r = receiver([200]);
    const out = await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: r.fetchImpl });
    expect(out.code).toBe("egress_blocked");
    expect(r.got).toHaveLength(0);
    await db.update(siemDestinations).set({ url: URL_OK }).where(eq(siemDestinations.id, destId));
  });

  it("without the data key nothing is signed or sent", async () => {
    await makeDue();
    const r = receiver([200]);
    expect((await deliverSiemDestinationOnce(db, destId, undefined, { resolve, fetchImpl: r.fetchImpl })).code).toBe("no_data_key");
    expect(r.got).toHaveLength(0);
  });

  it("dead-letters after repeated failures, is audited, stops, and an admin recovers it", async () => {
    await db.update(siemDestinations).set({ consecutiveFailures: SIEM_LIMITS.deadLetterAfter - 1, nextAttemptAt: null }).where(eq(siemDestinations.id, destId));
    const out = await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: receiver([500]).fetchImpl });
    expect(out.outcome).toBe("dead_lettered");
    expect((await dest()).state).toBe("dead_letter");
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, destId), eq(auditLog.ruleId, SIEM_RULE_IDS.deadLettered)));
    expect(row).toBeDefined();
    const r = receiver([200]);
    const sweep = await runSiemDeliverySweep(db, DATA_KEY, { resolve, fetchImpl: r.fetchImpl });
    expect(sweep.results.find((x) => x.destinationId === destId)).toBeUndefined();
    expect(r.got).toHaveLength(0);
    const rec = await app.inject({ method: "POST", url: `/v1/siem/destinations/${destId}/recover`, headers: KEY });
    expect(rec.statusCode, rec.body).toBe(200);
    expect(rec.json().destination).toMatchObject({ state: "active", consecutiveFailures: 0 });
    expect((await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: r.fetchImpl })).outcome).toBe("delivered");
  });

  it("two passes at once: one claims, the other does nothing", async () => {
    await writeAuditRow("race");
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let calls = 0;
    const slow = (async () => {
      calls++;
      await gate;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const p1 = deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: slow });
    await new Promise((res) => setTimeout(res, 100));
    const p2 = await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: slow });
    release();
    expect(p2.outcome).toBe("not_claimed");
    expect((await p1).outcome).toBe("delivered");
    expect(calls).toBe(1);
  });

  it("rotating the secret needs a step-up; the new secret verifies and the old one does not", async () => {
    const refused = await app.inject({ method: "POST", url: `/v1/siem/destinations/${destId}/rotate-secret`, ...(await asSession()) });
    expect([403, 422]).toContain(refused.statusCode);
    const res = await app.inject({ method: "POST", url: `/v1/siem/destinations/${destId}/rotate-secret`, ...(await asSteppedUp({ siem: "rotate_secret", destinationId: destId })) });
    expect(res.statusCode, res.body).toBe(200);
    const fresh = res.json().secret as string;
    expect(fresh).not.toBe(secret);
    await writeAuditRow("rotated");
    const r = receiver([200]);
    await deliverSiemDestinationOnce(db, destId, DATA_KEY, { resolve, fetchImpl: r.fetchImpl });
    const g = r.got[0]!;
    const h = Object.fromEntries(g.headers.entries());
    expect(() => new Webhook(fresh).verify(g.body, h)).not.toThrow();
    expect(() => new Webhook(secret).verify(g.body, h)).toThrow();
  });
});

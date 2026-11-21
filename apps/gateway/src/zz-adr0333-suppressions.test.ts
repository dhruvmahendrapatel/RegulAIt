/**
 * ADR-0333 §5b (slice 4) — per-rule suppressions and the pack dry run.
 *
 * A suppression is created only behind a settings_relax step-up bound to its terms, covers exactly one rule and one
 * group until it expires, holds back matches without hiding them (an audit row counts them), and is revoked early
 * as a narrowing. The dry run evaluates a pack over a past window inside a READ ONLY transaction and raises nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { and, auditLog, createDb, detectionIncidents, detectionRulePacks, detectionSuppressions, eq, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { loadActiveDetectionPack, runDetectionSweep } from "./detection/sweep.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack } from "./detection/pack.js";
import { SUPPRESSION_RULE_IDS } from "./detection/suppressions.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0333s-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const RULE = "adr0333s-watched-call";
const CALL_RULE_ID = "adr0333s-call";

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let alice: string;
let bob: string;
const restores: Array<() => Promise<void>> = [];

async function mkUser(label: string, isAdmin: boolean): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0333s-${label}-${RUN}@example.com`, displayName: label, isAdmin } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const WATCH_RULE = { id: RULE, title: "A watched call", severity: "medium", enabled: true, type: "single", selector: { objectType: ["mcp_tool"], ruleId: [CALL_RULE_ID] } } as const;

async function storePack(rules: unknown[]): Promise<void> {
  const current = await loadActiveDetectionPack(db);
  const next = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: [...DEFAULT_DETECTION_PACK.rules, ...rules] });
  if (packDigest(next) === current.digest) return;
  const facts = { detection: "rule-pack", fromDigest: current.digest, toDigest: packDigest(next) };
  const req = stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
  const res = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", ...req, payload: { pack: next, expectedVersion: current.version } });
  expect(res.statusCode, res.body).toBe(201);
}

async function call(userId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({ id, userId, objectType: "mcp_tool", toolName: "noop", effect: "allow", ruleId: CALL_RULE_ID, ruleChain: [], reason: "t" });
  return id;
}

const incidentOf = async (trigger: string) => (await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger)))[0];

const terms = (b: { ruleId: string; groupKey: string; hours: number; reason: string }) => ({
  detection: "suppression",
  ruleId: b.ruleId,
  groupKey: b.groupKey,
  hours: b.hours,
  reasonDigest: createHash("sha256").update(b.reason).digest("hex"),
});

async function suppress(b: { ruleId: string; groupKey: string; hours: number; reason: string }, stepUp = true) {
  const req = stepUp ? stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: terms(b) } as StepUpCheckArgs)) : { headers: AUTH };
  return app.inject({ method: "POST", url: "/v1/detection/suppressions", ...req, payload: b });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  adminId = await mkUser("admin", true);
  alice = await mkUser("alice", false);
  bob = await mkUser("bob", false);
  await db.delete(detectionSuppressions);
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await runDetectionSweep(db, adminId);
  await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = (SELECT max(seq) FROM audit_log), replay_cursor_seq = replay_until_seq, lease_until = NULL, lease_token = NULL`);
  await storePack([WATCH_RULE]);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(detectionSuppressions);
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0333 §5b suppressions: create", () => {
  it("is refused without a step-up bound to its terms, and creates nothing", async () => {
    const b = { ruleId: RULE, groupKey: `user:${bob}`, hours: 2, reason: "no step-up" };
    const res = await suppress(b, false);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    // a grant for other terms does not authorise these
    const other = stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: terms({ ...b, hours: 3 }) } as StepUpCheckArgs));
    const wrong = await app.inject({ method: "POST", url: "/v1/detection/suppressions", ...other, payload: b });
    expect(wrong.statusCode, wrong.body).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(detectionSuppressions).where(eq(detectionSuppressions.groupKey, b.groupKey))).toHaveLength(0);
  });

  it("validates the rule, the group and the hours", async () => {
    expect((await suppress({ ruleId: "no-such-rule", groupKey: `user:${bob}`, hours: 2, reason: "x" })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/v1/detection/suppressions", headers: AUTH, payload: { ruleId: RULE, groupKey: "user:*", hours: 2, reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/detection/suppressions", headers: AUTH, payload: { ruleId: RULE, groupKey: `user:${bob}`, hours: 721, reason: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/detection/suppressions", headers: AUTH, payload: { ruleId: RULE, groupKey: `user:${bob}`, hours: 2, reason: "  " } })).statusCode).toBe(400);
  });
});

describe("ADR-0333 §5b suppressions: effect, revoke and expiry", () => {
  it("holds back matches for exactly its rule and group, counted in an audit row; other groups still raise", async () => {
    const created = await suppress({ ruleId: RULE, groupKey: `user:${alice}`, hours: 2, reason: "known batch job" });
    expect(created.statusCode, created.body).toBe(201);
    const s = created.json().suppression;
    expect(s).toMatchObject({ status: "active", state: "active", ruleId: RULE, groupKey: `user:${alice}`, createdBy: adminId });
    expect(s.createStepUp).toMatch(/^[a-z_]+$/);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.objectId, s.id), eq(auditLog.ruleId, SUPPRESSION_RULE_IDS.created)))).toHaveLength(1);
    // a second one for the same rule and group is refused
    expect((await suppress({ ruleId: RULE, groupKey: `user:${alice}`, hours: 1, reason: "again" })).statusCode).toBe(409);

    const [a1, a2, b1] = [await call(alice), await call(alice), await call(bob)];
    const out = await runDetectionSweep(db, adminId);
    expect(out.suppressed).toBe(2);
    expect(await incidentOf(a1)).toBeUndefined();
    expect(await incidentOf(a2)).toBeUndefined();
    expect(await incidentOf(b1)).toMatchObject({ ruleId: RULE, groupKey: `user:${bob}` });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, s.id), eq(auditLog.ruleId, SUPPRESSION_RULE_IDS.suppressed)));
    expect(row!.detail).toMatchObject({ rule: RULE, group: `user:${alice}`, suppressedMatches: 2 });
  });

  it("revoke is a narrowing: no step-up, audited, once; the rule raises for that group again", async () => {
    const [s] = await db.select().from(detectionSuppressions).where(and(eq(detectionSuppressions.groupKey, `user:${alice}`), eq(detectionSuppressions.status, "active")));
    const res = await app.inject({ method: "POST", url: `/v1/detection/suppressions/${s!.id}/revoke`, headers: AUTH, payload: {} });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().suppression).toMatchObject({ status: "revoked", state: "revoked" });
    expect(res.json().suppression.lifecycle).toMatchObject({ terminal: true });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.objectId, s!.id), eq(auditLog.ruleId, SUPPRESSION_RULE_IDS.revoked)))).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/v1/detection/suppressions/${s!.id}/revoke`, headers: AUTH, payload: {} })).statusCode).toBe(409);
    const again = await call(alice);
    await runDetectionSweep(db, adminId);
    expect(await incidentOf(again)).toMatchObject({ groupKey: `user:${alice}` });
  });

  it("an expired suppression suppresses nothing, reads as expired, and cannot be revoked", async () => {
    const created = await suppress({ ruleId: RULE, groupKey: `user:${bob}`, hours: 1, reason: "short" });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().suppression.id as string;
    await db.update(detectionSuppressions).set({ createdAt: sql`now() - interval '2 hours'`, expiresAt: sql`now() - interval '1 hour'` }).where(eq(detectionSuppressions.id, id));
    const trigger = await call(bob);
    await runDetectionSweep(db, adminId);
    expect(await incidentOf(trigger)).toMatchObject({ groupKey: `user:${bob}` });
    const list = await app.inject({ method: "GET", url: `/v1/detection/suppressions?ruleId=${RULE}&limit=100`, headers: AUTH });
    expect(list.statusCode, list.body).toBe(200);
    const mine = list.json().suppressions.find((x: { id: string }) => x.id === id);
    expect(mine).toMatchObject({ status: "active", state: "expired" });
    expect(mine.lifecycle.transitions.find((t: { event: string }) => t.event === "revoke")).toMatchObject({ allowed: false });
    expect((await app.inject({ method: "POST", url: `/v1/detection/suppressions/${id}/revoke`, headers: AUTH, payload: {} })).statusCode).toBe(409);
  });

  it("RLS is enabled and forced on the suppression table", async () => {
    const res = (await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'detection_suppressions'`)) as unknown as { rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> };
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe("ADR-0333 §5b dry run", () => {
  const dry = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/detection/rule-pack/dry-run", headers: AUTH, payload });

  it("counts what the active pack would raise over a past window, and raises nothing", async () => {
    // the database stamps `at`, so the window brackets rows written just now
    // a gap, so the window holds none of the earlier tests' calls
    await new Promise((r) => setTimeout(r, 1100));
    const t0 = new Date();
    await call(alice);
    await call(alice);
    await call(bob);
    const window = { from: t0.toISOString(), to: new Date(Date.now() + 1000).toISOString() };
    // a suppression active now is reported as suppressedNow, not removed from the hits
    expect((await suppress({ ruleId: RULE, groupKey: `user:${bob}`, hours: 2, reason: "dry-run check" })).statusCode).toBe(201);
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(detectionIncidents))[0]!.n;
    const res = await dry(window);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: "active", truncated: false });
    expect(res.json().rules.find((r: { ruleId: string }) => r.ruleId === RULE)).toMatchObject({ hits: 3, groups: 2, suppressedNow: 1 });
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(detectionIncidents))[0]!.n).toBe(before);
    const [audited] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "detection-pack-dry-run")).orderBy(sql`${auditLog.seq} DESC`).limit(1);
    expect(audited!.detail).toMatchObject({ dryRun: true, source: "active" });

    // a proposed pack with the rule disabled would have raised nothing for it
    const proposed = { ...DEFAULT_DETECTION_PACK, rules: [...DEFAULT_DETECTION_PACK.rules, { ...WATCH_RULE, enabled: false }] };
    const off = await dry({ ...window, pack: proposed });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().source).toBe("proposed");
    expect(off.json().rules.find((r: { ruleId: string }) => r.ruleId === RULE)).toBeUndefined();
  });

  it("refuses a window longer than seven days, one in the future, an inverted one, or an invalid pack", async () => {
    const now = Date.now();
    expect((await dry({ from: new Date(now - 8 * 86400_000).toISOString(), to: new Date(now).toISOString() })).statusCode).toBe(400);
    expect((await dry({ from: new Date(now).toISOString(), to: new Date(now + 3600_000).toISOString() })).statusCode).toBe(400);
    expect((await dry({ from: new Date(now).toISOString(), to: new Date(now - 1000).toISOString() })).statusCode).toBe(400);
    expect((await dry({ from: new Date(now - 1000).toISOString(), to: new Date(now).toISOString(), pack: { schema: "nope" } })).statusCode).toBe(400);
  });
});

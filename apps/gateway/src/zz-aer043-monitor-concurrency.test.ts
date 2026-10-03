/**
 * AER-043 — overlapping governance-monitor passes report only what they did.
 *
 * Four passes run concurrently (the scheduler job and a manual evaluate can
 * overlap). The partial unique index already keeps one active alert per
 * condition; this file pins the REPORTING: across all passes the raised
 * (and later resolved) counts they return sum to exactly the audit rows
 * written, each pass's `governance-monitor-evaluated` audit detail equals its
 * own returned counts, and the condition is raised and resolved exactly once.
 * That overlap is likely, not guaranteed — so the second block forces it:
 * pass A is held at the `afterPlan` seam (after its active-alert read, before
 * any write) while pass B runs to completion, then A is released.
 * Shared database: assertions are scoped to audit rows written after this
 * file's own start and to the risk this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiRisks, and, auditLog, createDb, eq, governanceAlerts, gte, runMigrations, sql, users, type Db } from "@regulait/db";
import { runGovernanceMonitor, type MonitorRunResult } from "./governance-monitor.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
// four overlapping passes make the race (two passes planning the same write)
// near-certain rather than occasional; distinct actors per test, so one test's
// evaluated rows never count in the other's
const PASSES = 4;
const actors = (tag: string) => Array.from({ length: PASSES }, (_, i) => `00000000-0000-4000-8000-${tag}0000000043`.slice(0, 33) + String(i).padStart(3, "0"));
const ACTORS = { raise: actors("a"), resolve: actors("c") };
let db: Db;
let riskId = "";
let ownerId = "";
const heldRiskIds: string[] = [];

/** the DATABASE clock: audit `at` defaults to now() on the same clock */
const dbNow = async () => {
  const res = await db.execute(sql`select clock_timestamp() as now`);
  return new Date((res.rows[0] as { now: string | Date }).now);
};
const auditSince = (ruleId: string, since: Date) =>
  db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), gte(auditLog.at, since)));

/** each pass's evaluated audit row must carry exactly the counts it returned */
async function expectAuditMatches(since: Date, results: Array<[string, MonitorRunResult]>) {
  const evaluated = await auditSince("governance-monitor-evaluated", since);
  for (const [actor, r] of results) {
    const rows = evaluated.filter((e) => e.userId === actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ raised: r.raised, refreshed: r.refreshed, resolved: r.resolved });
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [u] = await db.insert(users).values({ email: `aer043-${RUN}@example.com`, displayName: "Risk owner" }).returning({ id: users.id });
  ownerId = u!.id;
  await runGovernanceMonitor(db); // settle whatever other files left behind
}, 120_000);

afterAll(async () => {
  for (const id of [riskId, ...heldRiskIds].filter(Boolean)) {
    await db.update(aiRisks).set({ status: "closed" }).where(eq(aiRisks.id, id));
  }
});

describe("AER-043 concurrent monitor passes", () => {
  it("a new condition is raised once, and the two passes' raised counts sum to the rows written", async () => {
    const [r] = await db
      .insert(aiRisks)
      .values({ title: `aer043 risk ${RUN}`, description: "synthetic", category: "prompt_injection", likelihood: "high", impact: "high", ownerUserId: ownerId })
      .returning({ id: aiRisks.id });
    riskId = r!.id;
    const since = await dbNow();
    const results = await Promise.all(ACTORS.raise.map((actorUserId) => runGovernanceMonitor(db, { actorUserId })));
    const mine = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, `risk:${riskId}`));
    expect(mine).toHaveLength(1);
    const raisedRows = await auditSince("governance-alert-raised", since);
    expect(raisedRows.filter((x) => x.objectId === mine[0]!.id)).toHaveLength(1);
    expect(results.reduce((n, r) => n + r.raised, 0)).toBe(raisedRows.length);
    await expectAuditMatches(since, results.map((r, i) => [ACTORS.raise[i]!, r] as [string, MonitorRunResult]));
  });

  it("a cleared condition is resolved once, and the resolved counts sum to the rows written", async () => {
    await db.update(aiRisks).set({ status: "closed" }).where(eq(aiRisks.id, riskId));
    const since = await dbNow();
    const results = await Promise.all(ACTORS.resolve.map((actorUserId) => runGovernanceMonitor(db, { actorUserId })));
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, `risk:${riskId}`));
    expect(alert!.status).toBe("resolved");
    const resolvedRows = await auditSince("governance-alert-resolved", since);
    expect(resolvedRows.filter((x) => x.objectId === alert!.id)).toHaveLength(1);
    expect(results.reduce((n, r) => n + r.resolved, 0)).toBe(resolvedRows.length);
    await expectAuditMatches(since, results.map((r, i) => [ACTORS.resolve[i]!, r] as [string, MonitorRunResult]));
  });
});

describe("AER-043 deterministic interleave: A reads and plans, B commits, then A writes", () => {
  const pair = (tag: string) => actors(tag).slice(0, 2) as [string, string];
  type Plan = { raise: Array<{ subjectKey: string }>; refresh: Array<{ id: string }>; resolve: string[] };

  /** a fresh risk with no controls — the monitor's `risk:<id>` condition */
  async function newRisk() {
    const [r] = await db
      .insert(aiRisks)
      .values({ title: `aer043 held risk ${RUN}`, description: "synthetic", category: "prompt_injection", likelihood: "high", impact: "high", ownerUserId: ownerId })
      .returning({ id: aiRisks.id });
    heldRiskIds.push(r!.id);
    return r!.id;
  }
  const alertFor = async (id: string) =>
    (await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, `risk:${id}`))).filter((a) => a.status !== "resolved");

  /**
   * The race, every time: A runs up to the seam (active alerts read, plan
   * made, nothing written) and waits there while `whileHeld` runs and then B
   * runs to completion; only then are A's writes released.
   */
  async function interleave([actorA, actorB]: [string, string], whileHeld?: () => Promise<unknown>) {
    let planA: Plan | undefined;
    let reached!: () => void;
    let release!: () => void;
    const atSeam = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const passA = runGovernanceMonitor(db, {
      actorUserId: actorA,
      afterPlan: async (plan) => {
        planA = plan;
        reached();
        await gate;
      },
    });
    await Promise.race([atSeam, passA]); // a pass A that dies before the seam fails here, not by timeout
    expect(planA, "pass A never reached the afterPlan seam").toBeDefined();
    const b = await (async () => {
      await whileHeld?.();
      return runGovernanceMonitor(db, { actorUserId: actorB });
    })().finally(release);
    const a = await passA;
    return { a, b, planA: planA! };
  }

  /** a pass's evaluated audit row carries its own returned counts, and those
   *  are the raised/resolved audit rows that pass itself committed */
  async function expectOwnEffects(since: Date, actor: string, r: MonitorRunResult) {
    const mine = async (ruleId: string) => (await auditSince(ruleId, since)).filter((x) => x.userId === actor);
    const evaluated = await mine("governance-monitor-evaluated");
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]!.detail).toMatchObject({ raised: r.raised, refreshed: r.refreshed, resolved: r.resolved });
    expect(await mine("governance-alert-raised")).toHaveLength(r.raised);
    expect(await mine("governance-alert-resolved")).toHaveLength(r.resolved);
  }

  it("RAISE: both plan the raise, B inserts it, A's insert is a no-op — B raised 1, A raised 0", async () => {
    const id = await newRisk();
    const actorsAB = pair("d");
    const since = await dbNow();
    const { a, b, planA } = await interleave(actorsAB);
    expect(planA.raise.map((f) => f.subjectKey)).toContain(`risk:${id}`);
    expect(b.raised).toBe(1);
    expect(a.raised).toBe(0);
    const [alert, ...more] = await alertFor(id);
    expect(more).toHaveLength(0);
    const raisedRows = (await auditSince("governance-alert-raised", since)).filter((x) => x.objectId === alert!.id);
    expect(raisedRows.map((x) => x.userId)).toEqual([actorsAB[1]]);
    await expectOwnEffects(since, actorsAB[0], a);
    await expectOwnEffects(since, actorsAB[1], b);
  });

  it("RESOLVE: both plan the resolve, B resolves it, A's update is a no-op — B resolved 1, A resolved 0", async () => {
    const id = await newRisk();
    await runGovernanceMonitor(db); // raise it
    const [alert] = await alertFor(id);
    expect(alert).toBeDefined();
    await db.update(aiRisks).set({ status: "closed" }).where(eq(aiRisks.id, id));
    const actorsAB = pair("e");
    const since = await dbNow();
    const { a, b, planA } = await interleave(actorsAB);
    expect(planA.resolve).toContain(alert!.id);
    expect(b.resolved).toBe(1);
    expect(a.resolved).toBe(0);
    expect(await alertFor(id)).toHaveLength(0);
    const resolvedRows = (await auditSince("governance-alert-resolved", since)).filter((x) => x.objectId === alert!.id);
    expect(resolvedRows.map((x) => x.userId)).toEqual([actorsAB[1]]);
    await expectOwnEffects(since, actorsAB[0], a);
    await expectOwnEffects(since, actorsAB[1], b);
  });

  it("REFRESH: A plans a refresh, B resolves the alert first — A neither counts nor rewrites the resolved row", async () => {
    const id = await newRisk();
    await runGovernanceMonitor(db); // raise it
    const [before] = await alertFor(id);
    expect(before).toBeDefined();
    const actorsAB = pair("f");
    const since = await dbNow();
    // the condition clears AFTER A has evaluated it (so A plans a refresh) and before B evaluates (so B resolves)
    const { a, b, planA } = await interleave(actorsAB, () => db.update(aiRisks).set({ status: "closed" }).where(eq(aiRisks.id, id)));
    expect(planA.refresh.map((x) => x.id)).toContain(before!.id);
    expect(b.resolved).toBe(1);
    expect(a.refreshed).toBe(planA.refresh.length - 1);
    const [after] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, before!.id));
    expect(after!.status).toBe("resolved");
    expect(after!.lastDetectedAt).toEqual(before!.lastDetectedAt);
    await expectOwnEffects(since, actorsAB[0], a);
    await expectOwnEffects(since, actorsAB[1], b);
  });
});

/**
 * AER-043 — overlapping governance-monitor passes report only what they did.
 *
 * Four passes run concurrently (the scheduler job and a manual evaluate can
 * overlap). The partial unique index already keeps one active alert per
 * condition; this file pins the REPORTING: across all passes the raised
 * (and later resolved) counts they return sum to exactly the audit rows
 * written, each pass's `governance-monitor-evaluated` audit detail equals its
 * own returned counts, and the condition is raised and resolved exactly once.
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
  if (riskId) await db.update(aiRisks).set({ status: "closed" }).where(eq(aiRisks.id, riskId));
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

/**
 * ADR-0251 — the latency the one governed core adds to a connector decision, measured, not assumed.
 *
 * Skipped unless REGULAIT_BENCH=1 (it is a measurement, not a correctness check, and CI runners are noisy). Reports
 * p50 and p95 of `governedEvaluateResource` (load + compose) with no rules and with ten matching rules (five approval
 * rules, five rate limits under their limit), and asserts the ADR's amended budget (As built, slice 1): +3 ms and +6 ms at p95.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectors, createDb, eq, resourceApprovalRules, resourceRateLimits, runMigrations, users, type Db } from "@regulait/db";
import { governedEvaluateResource } from "./governed-core.js";

const BENCH = process.env.REGULAIT_BENCH === "1";
const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
let db: Db;
let userId = "";
let connectorId = "";

const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function measure(n: number): Promise<{ p50: number; p95: number }> {
  const run = () =>
    governedEvaluateResource(db, {
      userId,
      resource: { type: "connector", id: connectorId, operation: "write" },
      projectId: "p",
      base: { effect: "allow", ruleId: "g", reason: "granted", ruleChain: [] },
      canQueue: true,
    });
  for (let i = 0; i < 200; i++) await run();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await run();
    xs.push(performance.now() - t);
  }
  return { p50: pct(xs, 50), p95: pct(xs, 95) };
}

describe.skipIf(!BENCH)("ADR-0251 core latency (REGULAIT_BENCH=1)", () => {
  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await runMigrations(db, migrationsFolder);
    const [u] = await db.insert(users).values({ email: `bench-${Date.now()}@example.com`, displayName: "Bench" }).returning();
    userId = u!.id;
    const [c] = await db.insert(connectors).values({ name: `bench-${Date.now()}`, kind: "crm" }).returning();
    connectorId = c!.id;
  });
  afterAll(async () => {
    await db.delete(connectors).where(eq(connectors.id, connectorId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("stays within the budget with no rules and with ten matching rules", async () => {
    const none = await measure(2000);
    for (let i = 0; i < 5; i++) {
      await db.insert(resourceApprovalRules).values({ resourceType: "connector", connectorId, scope: "user", userId, writeOnly: false, approverUserId: userId });
      await db.insert(resourceRateLimits).values({ resourceType: "connector", connectorId, scope: "user", userId, maxCalls: 1000, windowSeconds: 60 * (i + 1) });
    }
    const ten = await measure(2000);
    console.log(`ADR-0251 core latency: no rules p50 ${none.p50.toFixed(2)} ms p95 ${none.p95.toFixed(2)} ms; ten rules p50 ${ten.p50.toFixed(2)} ms p95 ${ten.p95.toFixed(2)} ms`);
    expect(none.p95).toBeLessThan(3);
    expect(ten.p95).toBeLessThan(6);
  }, 300_000);
});

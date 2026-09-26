/**
 * ROADMAP G1 / ADR-0125 — a run's measured spend is accumulated BY THE
 * DATABASE, not by whichever worker happens to write last.
 *
 * WHAT WAS WRONG. The agentic loop held its own running totals, seeded from
 * the run's budget when the loop started, and after every turn overwrote the
 * whole `budget` JSONB with them. For one worker that is exactly right. But
 * pillar 7's whole proposition is running independent nodes of one task graph
 * IN PARALLEL, and two workers on the same run each wrote an absolute computed
 * from what they read at their own start — so whichever landed second erased
 * the other's charges. The visible consequence is the bad one: a run could
 * spend past its cap while the ledger showed it comfortably under, and the
 * per-node ceilings inherited the same hole because they rode the same JSONB.
 *
 * These tests drive `chargeRunBudget` directly and concurrently. That is the
 * only way to see it: a sequential test passes under both implementations, and
 * the HTTP-level budget tests dispatch one node at a time by construction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, orchestrationRuns, users, eq, type Db } from "@regulait/db";
import { chargeRunBudget } from "./orchestration.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

let db: Db;
let userId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [u] = await db
    .insert(users)
    .values({ email: `budget-charge-${randomUUID()}@regulait.local`, displayName: "budget charge" })
    .returning({ id: users.id });
  userId = u!.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

async function makeRun(): Promise<string> {
  const [run] = await db
    .insert(orchestrationRuns)
    .values({
      name: `charge-${randomUUID()}`,
      initiatingUserId: userId,
      graph: { nodes: [] },
      state: {},
      budget: {
        capUsd: null,
        spentUsd: 0,
        measuredSpentUsd: 0,
        measuredPerNodeUsd: {},
        overageApproved: false,
        replanned: false,
        estimationBasis: "test",
      },
    })
    .returning({ id: orchestrationRuns.id });
  return run!.id;
}

const budgetOf = async (runId: string) => {
  const [row] = await db
    .select({ budget: orchestrationRuns.budget })
    .from(orchestrationRuns)
    .where(eq(orchestrationRuns.id, runId));
  return row!.budget as {
    measuredSpentUsd: number;
    measuredPerNodeUsd: Record<string, number>;
    estimationBasis: string;
  };
};

describe("charging a run's measured budget", () => {
  it("THE G1 CLAIM: twelve concurrent charges all land — none is erased by the next writer", async () => {
    const runId = await makeRun();

    // twelve nodes of one graph, dispatching at once, as a fanned-out run does
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => chargeRunBudget(db, runId, `n${i}`, 0.01)),
    );

    const budget = await budgetOf(runId);
    // read-modify-write from a shared starting point would land somewhere
    // between 0.01 and 0.12 depending on interleaving; only serialised addition
    // gives the total every time
    expect(budget.measuredSpentUsd).toBeCloseTo(0.12, 6);
    expect(Object.keys(budget.measuredPerNodeUsd)).toHaveLength(12);
  });

  it("concurrent charges to the SAME node accumulate on that node too", async () => {
    const runId = await makeRun();
    await Promise.all(Array.from({ length: 8 }, () => chargeRunBudget(db, runId, "n1", 0.25)));
    const budget = await budgetOf(runId);
    expect(budget.measuredSpentUsd).toBeCloseTo(2, 6);
    expect(budget.measuredPerNodeUsd.n1).toBeCloseTo(2, 6);
  });

  it("returns the STORED total, so the caller escalates on the ledger and not its own arithmetic", async () => {
    const runId = await makeRun();
    const first = await chargeRunBudget(db, runId, "n1", 0.4);
    const second = await chargeRunBudget(db, runId, "n1", 0.6);
    expect(first.measuredSpentUsd).toBeCloseTo(0.4, 6);
    expect(second.measuredSpentUsd).toBeCloseTo(1.0, 6);
    expect(second.nodeMeasuredUsd).toBeCloseTo(1.0, 6);
    expect((await budgetOf(runId)).measuredSpentUsd).toBeCloseTo(1.0, 6);
  });

  it("leaves every other field of the envelope alone", async () => {
    const runId = await makeRun();
    await chargeRunBudget(db, runId, "n1", 0.01);
    expect((await budgetOf(runId)).estimationBasis).toBe("test");
  });

  it("a run with no budget envelope is a no-op, not a crash", async () => {
    const [run] = await db
      .insert(orchestrationRuns)
      .values({
        name: `nobudget-${randomUUID()}`,
        initiatingUserId: userId,
        graph: { nodes: [] },
        state: {},
        budget: null,
      })
      .returning({ id: orchestrationRuns.id });
    const charged = await chargeRunBudget(db, run!.id, "n1", 5);
    expect(charged).toEqual({ measuredSpentUsd: 0, nodeMeasuredUsd: 0 });
  });
});

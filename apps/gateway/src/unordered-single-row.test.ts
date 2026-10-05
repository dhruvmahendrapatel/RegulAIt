import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  approvalDelegations,
  createDb,
  eq,
  runMigrations,
  trainingArtifacts,
  trainingDatasets,
  trainingJobs,
  users,
  type Db,
} from "@regulait/db";
import { loadUserByEmail } from "./auth.js";
import { activeDelegationFrom } from "./delegations.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { resolveArtifactProviderForDispatch } from "./regulait-llm.js";

/**
 * N2 / F01 / ADR-0107 — AN UNORDERED SINGLE-ROW READ IS A CORRECTNESS BUG.
 *
 * Postgres guarantees NO row order without `ORDER BY`. Four intermittent
 * failures in four consecutive batches were all the same disease: a query that
 * did not ask for an order, whose caller then depended on one. This file is the
 * proactive half — it pins the three production sites of that sweep where the
 * wrong row was genuinely reachable AND the code's answer visibly changes with
 * it, so a future edit that drops the `ORDER BY` reddens here rather than
 * flaking somewhere else three batches later.
 *
 * WHAT EACH TEST HAS TO DO TO BE HONEST. It is not enough to insert two rows
 * and assert the ordered answer — a suite that happens to get the right row
 * from an unordered read proves nothing. Each fixture below therefore inserts
 * the rows in the order OPPOSITE to the one the fix must return, so a
 * neutralised `ORDER BY` leaves the caller reading the row that Postgres
 * physically wrote first, which is the wrong one. That is what makes the
 * non-vacuity probe in the ADR meaningful rather than decorative.
 *
 * Shares one DB (fileParallelism off): every assertion is scoped to a per-run
 * fixture and never to an absolute count over a shared table. Prefix n2f01-,
 * per-run suffix, so the file is re-runnable against a database that already
 * has rows in it.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const RUN = Math.random().toString(36).slice(2, 8);

let db: Db;

/** ids created by this run, torn down in reverse dependency order */
const created = {
  artifacts: [] as string[],
  jobs: [] as string[],
  datasets: [] as string[],
  agents: [] as string[],
  delegations: [] as string[],
  users: [] as string[],
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
});

afterAll(async () => {
  for (const id of created.artifacts) await db.delete(trainingArtifacts).where(eq(trainingArtifacts.id, id));
  for (const id of created.jobs) await db.delete(trainingJobs).where(eq(trainingJobs.id, id));
  for (const id of created.datasets) await db.delete(trainingDatasets).where(eq(trainingDatasets.id, id));
  for (const id of created.agents) await db.delete(agents).where(eq(agents.id, id));
  for (const id of created.delegations) await db.delete(approvalDelegations).where(eq(approvalDelegations.id, id));
  for (const id of created.users) await db.delete(users).where(eq(users.id, id));
});

// ---------------------------------------------------------------------------
// 1. WHICH MODEL ANSWERS — the severe one
// ---------------------------------------------------------------------------

describe("training artifacts: `agent_id` is not unique, so dispatch must order", () => {
  /**
   * `training_artifacts` is UNIQUE on `job_id`. It is NOT unique on `agent_id`,
   * and it must not be: registering a SECOND training job's artifact against
   * the same agent is exactly how a retrained model is shipped. Unordered,
   * `resolveArtifactProviderForDispatch` could hand inference the OLD model —
   * silently, and differently between two identical requests.
   *
   * The fixture registers the stale artifact FIRST and the current one second,
   * so an unordered read returns the stale one on a fresh heap.
   */
  it("dispatches to the NEWEST artifact registered against the agent", async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: `n2f01-agent-${RUN}`, provider: "regulait_llm", tier: 1 })
      .returning();
    created.agents.push(agent!.id);

    const [dataset] = await db
      .insert(trainingDatasets)
      .values({ name: `n2f01-ds-${RUN}` })
      .returning();
    created.datasets.push(dataset!.id);

    const mk = async (label: string, createdAt: Date): Promise<string> => {
      const [job] = await db
        .insert(trainingJobs)
        .values({
          name: `n2f01-job-${label}-${RUN}`,
          datasetId: dataset!.id,
          datasetVersion: dataset!.version,
          backend: "local",
          method: "retrieval_index",
        })
        .returning();
      created.jobs.push(job!.id);
      const [artifact] = await db
        .insert(trainingArtifacts)
        .values({
          jobId: job!.id,
          name: `n2f01-artifact-${label}-${RUN}`,
          method: "retrieval_index",
          kind: "inline",
          payload: { marker: label },
          agentId: agent!.id,
          createdAt,
        })
        .returning();
      created.artifacts.push(artifact!.id);
      return artifact!.id;
    };

    // inserted stale-first ON PURPOSE: heap order is the wrong answer
    const staleId = await mk("stale", new Date(Date.now() - 60 * 60 * 1000));
    const currentId = await mk("current", new Date());

    const resolved = await resolveArtifactProviderForDispatch(db, agent!.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.artifact.id).toBe(currentId);
    expect(resolved.artifact.id).not.toBe(staleId);
    expect(resolved.artifact.payload).toEqual({ marker: "current" });
  });
});

// ---------------------------------------------------------------------------
// 2. WHICH DELEGATION AUTHORIZED IT
// ---------------------------------------------------------------------------

describe("approval delegations: overlapping windows must resolve to the latest one", () => {
  // ADR-0181: delegation ships OFF, under which no window resolves at all.
  // This block is about which window wins once an admin turns it on.
  let restoreDelegation: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    restoreDelegation = await relaxIdentityForTest(db, { approvalDelegationEnabled: true });
  });
  afterAll(async () => {
    await restoreDelegation?.();
  });

  /**
   * Nothing constrains (from_user_id, to_user_id) to one row, and nothing
   * should: a delegation is a WINDOW, and re-issuing one while an older window
   * is still open is legal. But the row this returns carries the `reason` that
   * lands on the audit trail as WHY a decision was allowed — so "either row" is
   * not an acceptable answer to "who authorized this".
   *
   * Superseded window inserted FIRST, so heap order is the wrong answer.
   */
  it("returns the window that started most recently, not an arbitrary one", async () => {
    const [from] = await db
      .insert(users)
      .values({ email: `n2f01-from-${RUN}@example.test`, displayName: "n2f01 from" })
      .returning();
    const [to] = await db
      .insert(users)
      .values({ email: `n2f01-to-${RUN}@example.test`, displayName: "n2f01 to" })
      .returning();
    created.users.push(from!.id, to!.id);

    const now = Date.now();
    const [superseded] = await db
      .insert(approvalDelegations)
      .values({
        fromUserId: from!.id,
        toUserId: to!.id,
        startsAt: new Date(now - 48 * 3600 * 1000),
        endsAt: new Date(now + 48 * 3600 * 1000),
        reason: "superseded window",
      })
      .returning();
    const [current] = await db
      .insert(approvalDelegations)
      .values({
        fromUserId: from!.id,
        toUserId: to!.id,
        startsAt: new Date(now - 3600 * 1000),
        endsAt: new Date(now + 3600 * 1000),
        reason: "current window",
      })
      .returning();
    created.delegations.push(superseded!.id, current!.id);

    const active = await activeDelegationFrom(db, from!.id, to!.id);
    expect(active).not.toBeNull();
    expect(active!.id).toBe(current!.id);
    expect(active!.reason).toBe("current window");
  });
});

// ---------------------------------------------------------------------------
// 3. WHICH ACCOUNT LOGS IN
// ---------------------------------------------------------------------------

describe("email lookup: `lower(email)` is now unique-backed (ADR-0109, migration 0108)", () => {
  /**
   * WHAT THIS TEST USED TO SAY, AND WHY IT CHANGED.
   *
   * `users_email_unique` is EXACT, and `loadUserByEmail` case-folds — so two
   * legal rows differing only in case both satisfied it, and unordered, WHICH
   * ACCOUNT a login or a SCIM update resolved to was arbitrary: an
   * authentication outcome decided by the planner. ADR-0107 fixed the
   * determinism (`asc(createdAt), asc(id)` — first registration owns the
   * address) and this test pinned it by inserting the LATER account first, so
   * heap order would give the wrong answer. Its own comment said what it was
   * waiting for:
   *
   *     the real fix is a UNIQUE index on `lower(email)`, which is a schema
   *     change and is deferred to its own decision. Until that lands, the
   *     answer must at least be the same answer twice.
   *
   * **That has landed.** ADR-0109 / migration 0108 ships `users_email_lower_uq`
   * — `CREATE UNIQUE INDEX ... ON users (lower(email))` — so the fixture the
   * old test built is now a state the database REFUSES. The old assertion is
   * not merely unnecessary, it is unconstructible, and keeping it would have
   * meant keeping a test that asserts a stopgap against a schema that has
   * superseded it.
   *
   * So the case is rewritten to assert the STRONGER property that replaced it,
   * and to keep the half of the old one that is still meaningful:
   *
   *   1. the second, case-variant row is REFUSED — by SQLSTATE 23505 and by
   *      `users_email_lower_uq` specifically, not by `users_email_unique`
   *      (which would mean the fixture had stopped exercising the case
   *      variant, and would make this assertion vacuous); and
   *   2. `loadUserByEmail` still resolves case-insensitively, and still gives
   *      THE SAME ANSWER TWICE — the property whose absence started all of
   *      this. It is now single by construction rather than by tiebreak.
   */
  it("refuses the second case-variant row, and resolves the surviving one case-insensitively", async () => {
    const local = `N2F01-Case-${RUN}`;

    const [first] = await db
      .insert(users)
      .values({
        email: `${local.toLowerCase()}@example.test`,
        displayName: "n2f01 earlier registration",
      })
      .returning();
    created.users.push(first!.id);

    // The row ADR-0107 could only ORDER around. It cannot be written any more.
    let thrown: unknown;
    try {
      await db.insert(users).values({
        email: `${local.toUpperCase()}@example.test`,
        displayName: "n2f01 later registration",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "the case-variant row was accepted — users_email_lower_uq is missing").toBeDefined();
    let cur: unknown = thrown;
    let code: string | undefined;
    let constraint: string | undefined;
    for (let i = 0; i < 6 && cur && typeof cur === "object"; i += 1) {
      const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
      if (typeof c.code === "string") {
        code = c.code;
        constraint = typeof c.constraint === "string" ? c.constraint : undefined;
        break;
      }
      cur = c.cause;
    }
    // 23505 specifically — a CHECK or NOT NULL failure would mean the fixture
    // is broken, not that the constraint works.
    expect(code).toBe("23505");
    // and by the FUNCTIONAL index, not the exact-email one: the two addresses
    // are not byte-equal, so `users_email_unique` cannot be what refused this.
    expect(constraint).toBe("users_email_lower_uq");

    // The property the original test existed to protect, unchanged: the same
    // answer twice, whatever case the caller supplies.
    const resolved = await loadUserByEmail(db, `${local}@example.test`);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(first!.id);
    const again = await loadUserByEmail(db, `${local.toUpperCase()}@example.test`);
    expect(again!.id).toBe(first!.id);
  });
});

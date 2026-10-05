import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  abacPolicies,
  auditLog,
  createDb,
  eq,
  inArray,
  policySimulations,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { governedEvaluate, type ReplayClock } from "./governed-evaluate.js";
import { loadOrgSettings, runAuditPruneOnce, retentionFloor } from "./org-settings.js";
import {
  loadAuditLookbackHorizon,
  replayCounterFor,
  runRuleSimulation,
} from "./policy-simulation.js";

/**
 * ADR-0179 security review of the Codex batch — findings 1, 4 and 8.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  F1  THE DEADLINE BOUNDS DATABASE WORK, NOT ONLY THE JS LOOP.
 *   a. A statement that outlives the deadline (here: a read blocked behind a
 *      lock another session holds for 4 s) is cancelled by the run's
 *      `SET LOCAL statement_timeout` and answered 200 `status:"incomplete"`
 *      well before the lock is released, never 500 and never 201 after the
 *      wait. Both candidate kinds (rule and ABAC).
 *   b. The setting is LOCAL to the run's transaction: the pooled connection
 *      that ran it afterwards has the server default again.
 *   c. The deadline is checked BETWEEN count chunks: a clock that passes it
 *      during the first row's chunked count stops the run with 0 evaluated.
 *   d. The lookback-horizon lookup reads the prune-marker partial index
 *      (migration 0154), not the whole audit trail.
 *  F4  `runAuditPruneOnce` deletes and writes its meta row in ONE transaction:
 *      when the meta row cannot be written, nothing was deleted.
 *  F8  A replay has ONE count path. Two calls in the same millisecond (µs
 *      apart) are counted identically by the batched replay and by a single
 *      replayed decision, and a replay clock without the counter is refused
 *      rather than falling back to a millisecond JS Date.
 *
 * Global state (M-068): the ABAC policy, the org retention default, the test
 * trigger and the legacy-style audit rows this file creates are removed in
 * `finally`/`afterAll`. Prefix adr0179rv-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

/** the slice of the driver's pool this file uses (the gateway has no direct
 * dependency on the driver's types) */
interface PoolLike {
  connect: () => Promise<{
    query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }>;
  end: () => Promise<void>;
}

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0179rv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const TOOL = `adr0179rv_tool_${RUN}`;
const MIN = 60_000;
const DEADLINE_ENV = "REGULAIT_POLICY_SIMULATION_DEADLINE_MS";
const savedDeadline = process.env[DEADLINE_ENV];

let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let subjectId: string;
let candidateVersionId: string;
let abacPolicyId: string | null = null;
let abacVersionId: string;
const legacyRowIds: string[] = [];

async function mkUser(tag: string): Promise<string> {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `adr0179rv-${tag}-${RUN}@example.com`, displayName: `ADR0179RV ${tag}` },
  });
  expect(u.statusCode, u.body).toBe(201);
  return u.json().id as string;
}

async function recordCalls(userId: string, n: number, spacingMs: number): Promise<void> {
  const start = Date.now() - 6 * 60 * MIN;
  await db.insert(auditLog).values(
    Array.from({ length: n }, (_, i) => ({
      userId,
      objectType: "mcp_tool" as const,
      objectId: serverId,
      serverId,
      toolName: TOOL,
      effect: "allow" as const,
      ruleId: "adr0179rv-recorded-allow",
      ruleChain: [],
      reason: "a recorded governed call, replayed below",
      at: new Date(start + i * spacingMs),
    })),
  );
}

/** a subject with its own per-user limit (1000/h live, 1/h proposed) */
async function subjectWithLimit(tag: string, calls: number): Promise<{ userId: string; versionId: string }> {
  const userId = await mkUser(tag);
  await app.inject({
    method: "POST",
    url: "/v1/grants/tools",
    headers: AUTH,
    payload: { userId, serverId, toolName: TOOL, mode: "readwrite" },
  });
  const lim = await app.inject({
    method: "POST",
    url: "/v1/rules/rate-limits",
    headers: AUTH,
    payload: { userId, serverId, toolName: TOOL, maxCalls: 1000, windowSeconds: 3600 },
  });
  expect(lim.statusCode, lim.body).toBe(201);
  const v = await app.inject({
    method: "POST",
    url: `/v1/config-versions/rate_limit/${lim.json().id}`,
    headers: AUTH,
    payload: { body: { maxCalls: 1, windowSeconds: 3600 } },
  });
  expect(v.statusCode, v.body).toBe(201);
  await recordCalls(userId, calls, MIN);
  return { userId, versionId: v.json().version.id as string };
}

/**
 * Hold ACCESS EXCLUSIVE on `mcp_tools` from ANOTHER session for `holdMs`.
 * Every simulation reads that table after loading its transcript, so the
 * run's read waits on the lock until a statement_timeout cancels it, or until
 * the lock goes away. Released on a timer as well, so a run that is NOT
 * bounded still finishes (that is what the red run measures).
 */
async function holdToolsLock(holdMs: number): Promise<() => Promise<void>> {
  const lockDb = createDb(DATABASE_URL!, { max: 1 });
  const pool = lockDb.$client as unknown as PoolLike;
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("LOCK TABLE mcp_tools IN ACCESS EXCLUSIVE MODE");
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  };
  const timer = setTimeout(() => void release(), holdMs);
  return release;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  const s = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: `adr0179rv-server-${RUN}`, url: "http://127.0.0.1:9/" },
  });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  const t = await app.inject({
    method: "POST",
    url: `/v1/servers/${serverId}/tools`,
    headers: AUTH,
    payload: { name: TOOL, kind: "read" },
  });
  expect(t.statusCode, t.body).toBeLessThan(300);

  const main = await subjectWithLimit("main", 6);
  subjectId = main.userId;
  candidateVersionId = main.versionId;

  // an ABAC candidate, authored and versioned but never activated
  const created = await app.inject({
    method: "POST",
    url: "/v1/abac/policies",
    headers: AUTH,
    payload: {
      name: `adr0179rv-candidate-${RUN}`,
      source: `forbid (principal, action == RegulAIt::Action::"McpToolCall", resource);`,
      mode: "forbid",
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  abacPolicyId = created.json().policy.id;
  abacVersionId = created.json().version.id;
});

afterEach(() => {
  if (savedDeadline === undefined) delete process.env[DEADLINE_ENV];
  else process.env[DEADLINE_ENV] = savedDeadline;
});

afterAll(async () => {
  // M-068: the ABAC policy set is global, and so are the legacy-style rows
  if (abacPolicyId) await db.delete(abacPolicies).where(eq(abacPolicies.id, abacPolicyId));
  if (legacyRowIds.length) await db.delete(auditLog).where(inArray(auditLog.id, legacyRowIds));
  await app.close();
});

const auditCount = async (rule: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, rule))).length;

describe("F1: the deadline bounds database work", () => {
  for (const kind of ["rule", "abac"] as const) {
    it(`(${kind}) a statement blocked past the deadline is cancelled: 200 incomplete, long before the lock goes`, async () => {
      process.env[DEADLINE_ENV] = "400";
      const before = await auditCount("policy-simulation-incomplete");
      const stored = async () =>
        (
          await db
            .select()
            .from(policySimulations)
            .where(
              kind === "rule"
                ? eq(policySimulations.candidateVersionId, candidateVersionId)
                : eq(policySimulations.policyVersionId, abacVersionId),
            )
        ).length;
      const storedBefore = await stored();
      const release = await holdToolsLock(4_000);
      const t0 = Date.now();
      let res;
      try {
        res = await app.inject({
          method: "POST",
          url: "/v1/policy-simulations",
          headers: AUTH,
          payload: {
            ...(kind === "rule" ? { ruleVersionId: candidateVersionId } : { policyVersionId: abacVersionId }),
            windowDays: 1,
            userIds: [subjectId],
          },
        });
      } finally {
        await release();
      }
      const elapsed = Date.now() - t0;
      console.log(`[adr0179rv] ${kind}: ${res.statusCode} after ${elapsed} ms (lock held 4000 ms)`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.status).toBe("incomplete");
      // the statement-timeout path answers the SAME shape as a deadline seen
      // between rows (pinned in profile-shadow-history.test.ts as well)
      expect(Object.keys(body).sort()).toEqual([
        "capped",
        "deadlineMs",
        "detail",
        "dryRun",
        "evaluated",
        "fidelity",
        "scope",
        "status",
        "total",
        "windowEnd",
        "windowStart",
      ]);
      expect(body.deadlineMs).toBe(400);
      expect(body.total).toBe(6);
      expect(body.evaluated).toBe(0);
      expect(body.simulation).toBeUndefined();
      // bounded by the deadline, not by the other session's lock
      expect(elapsed).toBeLessThan(2_000);
      expect(await stored()).toBe(storedBefore);
      expect(await auditCount("policy-simulation-incomplete")).toBe(before + 1);
    });
  }

  it("the statement_timeout is LOCAL: the pooled connection has the default again afterwards", async () => {
    const one = createDb(DATABASE_URL!, { max: 1 });
    try {
      const baseline = (await one.execute(sql`show statement_timeout`)).rows[0] as { statement_timeout: string };
      const out = await runRuleSimulation(one, {
        ruleVersionId: candidateVersionId,
        windowDays: 1,
        rowCap: 100,
        scope: { allowed: true, ruleId: "test", reason: "test", userIds: [subjectId] },
        requestedByUserId: null,
        deadlineMs: 5_000,
      });
      expect(out.ok && !out.incomplete).toBe(true);
      const after = (await one.execute(sql`show statement_timeout`)).rows[0] as { statement_timeout: string };
      expect(after.statement_timeout).toBe(baseline.statement_timeout);
    } finally {
      await one.$client.end();
    }
  });

  it("the deadline is checked between count chunks: stopped inside the first row's counts, 0 evaluated", async () => {
    // reads of the clock: arm (0), row 1 (1), before chunk 2 (2), before
    // chunk 3 (3) -> passed. Without the between-chunk check the first row's
    // three chunks all run, row 1 and row 2 finish, and row 3 sees the deadline.
    let t = 0;
    const out = await runRuleSimulation(db, {
      ruleVersionId: candidateVersionId,
      windowDays: 1,
      rowCap: 100,
      scope: { allowed: true, ruleId: "test", reason: "test", userIds: [subjectId] },
      requestedByUserId: null,
      deadlineMs: 3,
      clock: () => t++,
      countChunkSize: 2,
    });
    expect(out.ok && out.incomplete).toBe(true);
    if (out.ok && out.incomplete) {
      expect(out.total).toBe(6);
      expect(out.evaluated).toBe(0);
    }
    // positive control: the same chunking, no deadline pressure, completes
    const full = await runRuleSimulation(db, {
      ruleVersionId: candidateVersionId,
      windowDays: 1,
      rowCap: 100,
      scope: { allowed: true, ruleId: "test", reason: "test", userIds: [subjectId] },
      requestedByUserId: null,
      countChunkSize: 2,
    });
    if (!full.ok || full.incomplete) throw new Error(`did not complete: ${JSON.stringify(full)}`);
    expect(full.simulation.considered).toBe(6);
    expect(full.simulation.newlyDenied).toBe(5);
  });

  it("the lookback horizon reads the prune-marker partial index, not the audit trail", async () => {
    // capture the EXACT statement loadAuditLookbackHorizon sends, then plan it
    const spy = createDb(DATABASE_URL!, { max: 1 });
    const client = spy.$client as unknown as { query: (...a: unknown[]) => unknown };
    const original = client.query.bind(client);
    const seen: Array<{ text: string; values: unknown[] }> = [];
    client.query = (...a: unknown[]) => {
      const q = a[0] as string | { text: string; values?: unknown[] };
      if (typeof q === "string") seen.push({ text: q, values: (a[1] as unknown[]) ?? [] });
      else seen.push({ text: q.text, values: q.values ?? (a[1] as unknown[]) ?? [] });
      return original(...a);
    };
    try {
      await loadAuditLookbackHorizon(spy);
    } finally {
      client.query = original;
      await spy.$client.end();
    }
    const stmt = seen.find((s) => /audit_log/i.test(s.text));
    expect(stmt, JSON.stringify(seen)).toBeDefined();
    const planner = createDb(DATABASE_URL!, { max: 1 });
    const pool = planner.$client as unknown as PoolLike;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // the table is small in a test database, so the planner is told that
      // a sequential scan is the last resort; with no usable index it still
      // has to choose one
      await c.query("SET LOCAL enable_seqscan = off");
      const plan = await c.query(`EXPLAIN (FORMAT JSON) ${stmt!.text}`, stmt!.values);
      const text = JSON.stringify(plan.rows);
      expect(text).toContain("audit_log_prune_marker_at_idx");
      expect(text).not.toContain('"Seq Scan"');
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await pool.end();
    }
  });
});

describe("F4: the audit prune is one transaction", () => {
  it("when the meta row cannot be written, nothing was deleted", async () => {
    const actor = randomUUID();
    const fn = `adr0179rv_fail_${RUN}`;
    const org = await loadOrgSettings(db);
    const priorDefault = org.defaultAuditRetentionDays;
    const put = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: "/v1/org/settings",
      payload: { defaultAuditRetentionDays: 3650 },
    });
    expect(put.statusCode, put.body).toBe(200);
    const fixtureReason = `adr0179rv prune fixture ${RUN}`;
    try {
      const floor = await retentionFloor(db);
      const effective = floor.retainedDays!;
      expect(effective).toBeGreaterThanOrEqual(3650);
      await db.insert(auditLog).values({
        userId: actor,
        at: new Date(Date.now() - (effective + 30) * 24 * 3600 * 1000),
        effect: "allow",
        ruleId: "adr0179rv-old",
        ruleChain: [],
        reason: fixtureReason,
      });
      // the meta row, and only this test's, fails to insert
      await db.execute(
        sql.raw(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ ` +
            `BEGIN RAISE EXCEPTION 'adr0179rv: injected prune-marker failure'; END $$`,
        ),
      );
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW ` +
            `WHEN (NEW.user_id::text = '${actor}' AND NEW.rule_id = 'audit-log-pruned') ` +
            `EXECUTE FUNCTION ${fn}()`,
        ),
      );
      try {
        await expect(runAuditPruneOnce(db, actor, false)).rejects.toThrow();
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`));
        await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      }
      const survivors = await db.select().from(auditLog).where(eq(auditLog.reason, fixtureReason));
      expect(survivors.length).toBe(1);
      const markers = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.ruleId} = 'audit-log-pruned' and ${auditLog.userId}::text = ${actor}`);
      expect(markers.length).toBe(0);
    } finally {
      await db.delete(auditLog).where(eq(auditLog.reason, fixtureReason));
      const restore = await app.inject({
        method: "PUT",
        headers: AUTH,
        url: "/v1/org/settings",
        payload: { defaultAuditRetentionDays: priorDefault },
      });
      expect(restore.statusCode, restore.body).toBe(200);
    }
  });
});

describe("F8: one count path, at the stored timestamps", () => {
  it("two calls microseconds apart in one millisecond count the same in the batch and in a single replay", async () => {
    const { userId, versionId } = await subjectWithLimit("subms", 0);
    // Legacy-style rows (no chain fields), which is where sub-millisecond
    // timestamps exist: the chained writer truncates to the millisecond.
    const base = new Date(Date.now() - 3 * 60 * MIN);
    base.setUTCMilliseconds(500);
    const iso = base.toISOString(); // ...:SS.500Z
    const insertAt = async (micros: number): Promise<string> => {
      const res = await db.execute(sql`
        insert into audit_log (id, at, user_id, object_type, object_id, server_id, tool_name, effect, rule_id, rule_chain, reason)
        values (gen_random_uuid(), ${iso}::timestamptz + make_interval(secs => ${micros}::double precision / 1000000),
                ${userId}, 'mcp_tool', ${serverId}, ${serverId}, ${TOOL}, 'allow', 'adr0179rv-subms', '[]'::jsonb,
                'a recorded call, microseconds apart from its neighbour')
        returning id::text as id
      `);
      const id = (res.rows[0] as { id: string }).id;
      legacyRowIds.push(id);
      return id;
    };
    const first = await insertAt(200);
    const second = await insertAt(700);

    // the batched replay: `second` sees `first` inside its hour -> newly denied
    const out = await runRuleSimulation(db, {
      ruleVersionId: versionId,
      windowDays: 1,
      rowCap: 100,
      scope: { allowed: true, ruleId: "test", reason: "test", userIds: [userId] },
      requestedByUserId: null,
    });
    if (!out.ok || out.incomplete) throw new Error(`did not complete: ${JSON.stringify(out)}`);
    expect(out.simulation.considered).toBe(2);
    expect(out.simulation.newlyDenied).toBe(1);

    // a single replayed decision, through the same counter, agrees
    const tool = { serverId, name: TOOL, kind: "read" as const };
    const single = await governedEvaluate(db, userId, serverId, tool, undefined, null, null, undefined, {
      versionId,
      replay: { asOf: base, lookbackHorizon: null, countAllowed: replayCounterFor(db, second) },
    });
    expect(single.candidateDecision?.effect).toBe("deny");
    const atFirst = await governedEvaluate(db, userId, serverId, tool, undefined, null, null, undefined, {
      versionId,
      replay: { asOf: base, lookbackHorizon: null, countAllowed: replayCounterFor(db, first) },
    });
    expect(atFirst.candidateDecision?.effect).toBe("allow");

    // and there is no second path: a replay clock without the counter is
    // refused. Before the fix it fell back to a query against `asOf` (a JS
    // Date at .500), missed `first` (.500200) and permitted `second`.
    await expect(
      governedEvaluate(db, userId, serverId, tool, undefined, null, null, undefined, {
        versionId,
        replay: { asOf: base, lookbackHorizon: null } as unknown as ReplayClock,
      }),
    ).rejects.toThrow(/countAllowed/);
  });
});

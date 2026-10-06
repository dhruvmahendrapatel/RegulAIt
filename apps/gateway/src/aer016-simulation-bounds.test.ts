import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  eq,
  policySimulations,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runRuleSimulation, tryAcquireSimulationSlot } from "./policy-simulation.js";

/**
 * AER-016 (ADR-0179 §1) — A NON-ADMIN PREVIEW IS A BOUNDED RUN.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  1. DEADLINE: a run that reaches its deadline answers 200 with
 *     `status: "incomplete"`, how many recorded decisions it evaluated (fewer
 *     than the total), no blast radius, NO stored preview, and one audit row
 *     saying so. A partial count is never presented as a finished preview.
 *  2. CONCURRENCY: while a caller has a run in flight their next run is
 *     refused 429 with a Retry-After; a replica at its global ceiling refuses
 *     everyone else the same way. Releasing the slot lets the run through.
 *  3. BATCHING: the number of database queries a rule replay makes does not
 *     grow with the number of recorded calls for one (user, server, tool).
 *     Measured, not asserted from reading the code: 10 rows vs 40 rows.
 *
 * Prefix aer016-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `aer016-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const TOOL = `aer016_tool_${RUN}`;
const MIN = 60_000;

const ENV_KEYS = [
  "REGULAIT_POLICY_SIMULATION_DEADLINE_MS",
  "REGULAIT_POLICY_SIMULATION_MAX_PER_CALLER",
  "REGULAIT_POLICY_SIMULATION_MAX_GLOBAL",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let callerId: string;
let callerKey: string;
let limitId: string;
let candidateVersionId: string;

async function mkUser(tag: string): Promise<string> {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `aer016-${tag}-${RUN}@example.com`, displayName: `AER016 ${tag}` },
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
      ruleId: "aer016-recorded-allow",
      ruleChain: [],
      reason: "a recorded governed call, replayed below",
      at: new Date(start + i * spacingMs),
    })),
  );
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  const s = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: `aer016-server-${RUN}`, url: "http://127.0.0.1:9/" },
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

  // the NON-ADMIN caller: the route stays reachable to them, entitlement-scoped
  callerId = await mkUser("caller");
  const key = await app.inject({
    method: "POST",
    url: `/v1/users/${callerId}/keys`,
    headers: AUTH,
    payload: { name: "aer016-key" },
  });
  callerKey = key.json().token;
  await app.inject({
    method: "POST",
    url: "/v1/grants/tools",
    headers: AUTH,
    payload: { userId: callerId, serverId, toolName: TOOL, mode: "readwrite" },
  });
  await recordCalls(callerId, 6, MIN);

  // a fleet-wide generous limit with a proposed tightening to 1 per hour
  const lim = await app.inject({
    method: "POST",
    url: "/v1/rules/rate-limits",
    headers: AUTH,
    payload: { userId: callerId, serverId, toolName: TOOL, maxCalls: 1000, windowSeconds: 3600 },
  });
  expect(lim.statusCode, lim.body).toBe(201);
  limitId = lim.json().id;
  const v = await app.inject({
    method: "POST",
    url: `/v1/config-versions/rate_limit/${limitId}`,
    headers: AUTH,
    payload: { body: { maxCalls: 1, windowSeconds: 3600 } },
  });
  expect(v.statusCode, v.body).toBe(201);
  candidateVersionId = v.json().version.id;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  await app.close();
});

const asCaller = () => ({ authorization: `Bearer ${callerKey}` });
const previewPayload = () => ({ ruleVersionId: candidateVersionId, windowDays: 1 });
const storedFor = async (versionId: string) =>
  (await db.select().from(policySimulations).where(eq(policySimulations.candidateVersionId, versionId)))
    .length;
const auditCount = async (rule: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, rule))).length;

describe("AER-016: the deadline gives an honest INCOMPLETE result", () => {
  it("over the route: 200 incomplete, evaluated < total, nothing stored, one audit row", async () => {
    // one millisecond: the first replayed row alone takes longer than that
    process.env.REGULAIT_POLICY_SIMULATION_DEADLINE_MS = "1";
    const storedBefore = await storedFor(candidateVersionId);
    const auditBefore = await auditCount("policy-simulation-incomplete");

    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: asCaller(),
      payload: previewPayload(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.status).toBe("incomplete");
    expect(body.total).toBe(6);
    expect(body.evaluated).toBeLessThan(body.total);
    expect(body.deadlineMs).toBe(1);
    expect(body.detail).toMatch(/INCOMPLETE/);
    // never a partial result presented as complete: no preview, no buckets
    expect(body.simulation).toBeUndefined();
    expect(body.samples).toBeUndefined();
    expect(await storedFor(candidateVersionId)).toBe(storedBefore);
    expect(await auditCount("policy-simulation-incomplete")).toBe(auditBefore + 1);
  });

  it("exactly: a clock that passes the deadline after three rows reports evaluated = 3 of 6", async () => {
    // each read of the clock advances it by one; the deadline is read once at
    // the start, then once per row, so rows 1..3 pass and row 4 does not
    let t = 0;
    const out = await runRuleSimulation(db, {
      ruleVersionId: candidateVersionId,
      windowDays: 1,
      rowCap: 100,
      scope: { allowed: true, ruleId: "test", reason: "test", userIds: [callerId] },
      requestedByUserId: callerId,
      deadlineMs: 4,
      clock: () => t++,
    });
    expect(out.ok && out.incomplete).toBe(true);
    if (out.ok && out.incomplete) {
      expect(out.evaluated).toBe(3);
      expect(out.total).toBe(6);
    }
  });

  it("with the default deadline the same run completes (positive control)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: asCaller(),
      payload: previewPayload(),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe("complete");
    // six calls one minute apart under 1/hour: the first is allowed, five flip
    expect(res.json().simulation.newlyDenied).toBe(5);
  });
});

describe("AER-016: concurrency is bounded per caller and per replica", () => {
  it("a caller with a run in flight is refused 429 with Retry-After; released, the run goes through", async () => {
    const held = tryAcquireSimulationSlot(callerId, { maxPerCaller: 1, maxGlobal: 4 });
    expect(held.ok).toBe(true);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/policy-simulations",
        headers: asCaller(),
        payload: previewPayload(),
      });
      expect(res.statusCode, res.body).toBe(429);
      expect(res.json().error).toBe("simulation_busy");
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    } finally {
      if (held.ok) held.release();
    }
    const again = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: asCaller(),
      payload: previewPayload(),
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it("a replica at its global ceiling refuses another caller too", async () => {
    process.env.REGULAIT_POLICY_SIMULATION_MAX_GLOBAL = "1";
    const held = tryAcquireSimulationSlot(`someone-else-${RUN}`, { maxPerCaller: 1, maxGlobal: 1 });
    expect(held.ok).toBe(true);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/policy-simulations",
        headers: asCaller(),
        payload: previewPayload(),
      });
      expect(res.statusCode, res.body).toBe(429);
      expect(res.json().detail).toMatch(/already running 1 simulation/);
    } finally {
      if (held.ok) held.release();
    }
  });

  it("a run that throws still frees its slot", async () => {
    // an unknown version is a 404 from inside the run; the caller's next run
    // must not be refused as busy afterwards
    const bad = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: asCaller(),
      payload: { ruleVersionId: "00000000-0000-0000-0000-0000000000ff", windowDays: 1 },
    });
    expect(bad.statusCode).toBe(404);
    const ok = await app.inject({
      method: "POST",
      url: "/v1/policy-simulations",
      headers: asCaller(),
      payload: previewPayload(),
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});

describe("AER-016: the replay is batched, not one evaluation per recorded call", () => {
  it("query count does not grow with the number of recorded calls (10 vs 40 rows)", async () => {
    const counted = createDb(DATABASE_URL);
    let queries = 0;
    const client = counted.$client as unknown as { query: (...a: unknown[]) => unknown };
    const original = client.query.bind(client);
    client.query = (...a: unknown[]) => {
      queries += 1;
      return original(...a);
    };
    try {
      const run = async (rows: number) => {
        const subject = await mkUser(`batch${rows}`);
        await app.inject({
          method: "POST",
          url: "/v1/grants/tools",
          headers: AUTH,
          payload: { userId: subject, serverId, toolName: TOOL, mode: "readwrite" },
        });
        await recordCalls(subject, rows, MIN);
        queries = 0;
        const out = await runRuleSimulation(counted, {
          ruleVersionId: candidateVersionId,
          windowDays: 1,
          rowCap: 1000,
          scope: { allowed: true, ruleId: "test", reason: "test", userIds: [subject] },
          requestedByUserId: null,
        });
        if (!out.ok || out.incomplete) throw new Error("run did not complete");
        // the limit binds only `callerId`, so for these subjects the replay is
        // the same decision for every row — the point is the query count
        expect(out.simulation.considered).toBe(rows);
        return queries;
      };
      const q10 = await run(10);
      const q40 = await run(40);
      console.log(`[aer016] rule replay queries: 10 rows -> ${q10}, 40 rows -> ${q40}`);
      // measured: before batching every recorded call cost a full evaluation
      // (~15 queries), so 30 extra rows were ~450 extra queries
      expect(q40 - q10).toBeLessThanOrEqual(2);
      expect(q40).toBeLessThan(40);
    } finally {
      await counted.$client.end();
    }
  });

  it("and with the candidate limit actually binding, still bounded by the ceiling, not the rows", async () => {
    // a second limit version scoped to these subjects is not needed: the
    // caller's own transcript (6 rows + whatever earlier tests left) replays
    // with counts that saturate at the candidate's ceiling of 1, so at most
    // two distinct evaluations happen however many rows there are
    const counted = createDb(DATABASE_URL);
    let queries = 0;
    const client = counted.$client as unknown as { query: (...a: unknown[]) => unknown };
    const original = client.query.bind(client);
    client.query = (...a: unknown[]) => {
      queries += 1;
      return original(...a);
    };
    try {
      const measure = async () => {
        queries = 0;
        const out = await runRuleSimulation(counted, {
          ruleVersionId: candidateVersionId,
          windowDays: 1,
          rowCap: 1000,
          scope: { allowed: true, ruleId: "test", reason: "test", userIds: [callerId] },
          requestedByUserId: null,
        });
        if (!out.ok || out.incomplete) throw new Error("run did not complete");
        return { queries, considered: out.simulation.considered, denied: out.simulation.newlyDenied };
      };
      const before = await measure();
      await recordCalls(callerId, 30, 10_000);
      const after = await measure();
      console.log(
        `[aer016] binding limit: ${before.considered} rows -> ${before.queries} queries, ` +
          `${after.considered} rows -> ${after.queries} queries`,
      );
      expect(after.considered).toBe(before.considered + 30);
      expect(after.denied).toBeGreaterThan(before.denied);
      expect(after.queries - before.queries).toBeLessThanOrEqual(2);
    } finally {
      await counted.$client.end();
    }
  });
});

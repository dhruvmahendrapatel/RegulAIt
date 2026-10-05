import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  eq,
  inArray,
  policySimulationFlips,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { governedEvaluate } from "./governed-evaluate.js";
import { replayCounterFor, runRuleSimulation } from "./policy-simulation.js";

/**
 * AER-014 (ADR-0179 §1) — A REPLAYED RATE LIMIT COUNTS WHAT HAD HAPPENED BEFORE
 * THE RECORDED CALL, NOT WHAT HAS HAPPENED BEFORE NOW.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  1. A proposed limit of 1 call per hour, replayed over three recorded calls
 *     A, B (ten minutes after A) and C (more than an hour after B), decides:
 *     A unchanged (it does not count itself: strictly before), B newly denied
 *     (A is inside B's hour), C unchanged (A and B are outside C's hour, and B
 *     and C are not counted toward A: the window ends at the recorded call).
 *  2. NEGATIVE CONTROL: the same candidate evaluated the old way (no replay
 *     clock, window from `Date.now()`) sees none of the three calls and
 *     permits B. If it did not, the scenario could not tell the two apart.
 *  3. When audit retention has pruned part of a window, the rows whose window
 *     reaches past the prune cutoff are INDETERMINATE — never allow, never deny.
 *
 * All recorded calls are hours old, so `Date.now()` counting and replay
 * counting disagree on every row. Prefix aer014-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `aer014-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const TOOL = `aer014_tool_${RUN}`;

const MIN = 60_000;
const HOUR = 60 * MIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let serverId: string;
let limitId: string;
let candidateVersionId: string;
const at = { A: new Date(0), B: new Date(0), C: new Date(0) };
const ids = { A: "", B: "", C: "" };
const pruneMarkers: string[] = [];

async function recordAllowedCall(when: Date): Promise<string> {
  const [row] = await db
    .insert(auditLog)
    .values({
      userId,
      objectType: "mcp_tool",
      objectId: serverId,
      serverId,
      toolName: TOOL,
      effect: "allow",
      ruleId: "aer014-recorded-allow",
      ruleChain: [],
      reason: "a recorded governed call, replayed below",
      at: when,
    })
    .returning({ id: auditLog.id });
  return row!.id;
}

async function simulate() {
  const out = await runRuleSimulation(db, {
    ruleVersionId: candidateVersionId,
    windowDays: 1,
    rowCap: 100,
    scope: { allowed: true, ruleId: "test", reason: "test", userIds: [userId] },
    requestedByUserId: null,
  });
  if (!out.ok || out.incomplete) throw new Error(`simulation did not complete: ${JSON.stringify(out)}`);
  const flips = await db
    .select()
    .from(policySimulationFlips)
    .where(eq(policySimulationFlips.simulationId, out.simulation.id));
  return { sim: out.simulation, flips };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `aer014-${RUN}@example.com`, displayName: `AER014 ${RUN}` },
  });
  userId = u.json().id;
  const s = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: `aer014-server-${RUN}`, url: "http://127.0.0.1:9/" },
  });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  // the inventory row, with its kind, so no upstream is ever needed
  const t = await app.inject({
    method: "POST",
    url: `/v1/servers/${serverId}/tools`,
    headers: AUTH,
    payload: { name: TOOL, kind: "read" },
  });
  expect(t.statusCode, t.body).toBeLessThan(300);
  await app.inject({
    method: "POST",
    url: "/v1/grants/tools",
    headers: AUTH,
    payload: { userId, serverId, toolName: TOOL, mode: "readwrite" },
  });

  // The LIVE limit is generous, so every recorded call was genuinely allowed.
  const lim = await app.inject({
    method: "POST",
    url: "/v1/rules/rate-limits",
    headers: AUTH,
    payload: { userId, serverId, toolName: TOOL, maxCalls: 1000, windowSeconds: 3600 },
  });
  expect(lim.statusCode, lim.body).toBe(201);
  limitId = lim.json().id;
  // The PROPOSED version: one call per hour.
  const v = await app.inject({
    method: "POST",
    url: `/v1/config-versions/rate_limit/${limitId}`,
    headers: AUTH,
    payload: { body: { maxCalls: 1, windowSeconds: 3600 } },
  });
  expect(v.statusCode, v.body).toBe(201);
  candidateVersionId = v.json().version.id;

  const now = Date.now();
  at.A = new Date(now - 5 * HOUR);
  at.B = new Date(at.A.getTime() + 10 * MIN);
  at.C = new Date(at.B.getTime() + 2 * HOUR);
  ids.A = await recordAllowedCall(at.A);
  ids.B = await recordAllowedCall(at.B);
  ids.C = await recordAllowedCall(at.C);
});

afterAll(async () => {
  // M-068: the prune marker is GLOBAL state (it moves every replay's horizon),
  // so it never outlives this file
  if (pruneMarkers.length) await db.delete(auditLog).where(inArray(auditLog.id, pruneMarkers));
  await app.close();
});

describe("AER-014: a replayed rate limit counts the calls strictly before the recorded one", () => {
  it("1/hour over A, B(+10 min), C(+2 h): A unchanged, B newly denied, C unchanged", async () => {
    const { sim, flips } = await simulate();
    expect(sim.considered).toBe(3);
    expect(sim.newlyDenied).toBe(1);
    expect(sim.unchanged).toBe(2);
    expect(sim.indeterminate).toBe(0);
    expect(flips.map((f) => f.auditLogId)).toEqual([ids.B]);
    // the flip names the candidate limit as the reason
    expect(flips[0]!.decisionRuleId).toBe(limitId);
  });

  it("NEGATIVE CONTROL: the old Date.now() window sees none of them and permits B", async () => {
    const kind = { serverId, name: TOOL, kind: "read" as const };
    const old = await governedEvaluate(db, userId, serverId, kind, undefined, null, null, undefined, {
      versionId: candidateVersionId,
    });
    expect(old.candidateDecision?.effect).toBe("allow");

    // and the replay clock, asked the same question at B's instant, denies it
    const replayed = await governedEvaluate(
      db,
      userId,
      serverId,
      kind,
      undefined,
      null,
      null,
      undefined,
      {
        versionId: candidateVersionId,
        replay: { asOf: at.B, lookbackHorizon: null, countAllowed: replayCounterFor(db, ids.B) },
      },
    );
    expect(replayed.candidateDecision?.effect).toBe("deny");
    expect(replayed.candidateDecision?.ruleId).toBe(limitId);

    // the single-row counter also stops at the recorded instant: at A's
    // instant nothing came before, so A is permitted
    const atA = await governedEvaluate(
      db,
      userId,
      serverId,
      kind,
      undefined,
      null,
      null,
      undefined,
      {
        versionId: candidateVersionId,
        replay: { asOf: at.A, lookbackHorizon: null, countAllowed: replayCounterFor(db, ids.A) },
      },
    );
    expect(atA.candidateDecision?.effect).toBe("allow");
  });

  it("a window that reaches past an audit-retention prune is INDETERMINATE, never allow or deny", async () => {
    // a prune whose cutoff sits between A and B: A's and B's hour reach back
    // past it, C's does not
    const cutoff = new Date(at.B.getTime() - 30 * MIN);
    const [marker] = await db
      .insert(auditLog)
      .values({
        userId: "00000000-0000-0000-0000-000000000000",
        objectType: "project",
        objectId: null,
        detail: { phase: "audit-retention-prune", deleted: 0, retainedDays: 1, floorSource: [], cutoff },
        effect: "allow",
        ruleId: "audit-log-pruned",
        ruleChain: [],
        reason: "aer014 synthetic prune marker",
      })
      .returning({ id: auditLog.id });
    pruneMarkers.push(marker!.id);
    try {
      const { sim, flips } = await simulate();
      expect(sim.considered).toBe(3);
      expect(sim.indeterminate).toBe(2);
      expect(sim.newlyDenied).toBe(0);
      expect(sim.unchanged).toBe(1);
      expect(flips.length).toBe(0);

      const direct = await governedEvaluate(
        db,
        userId,
        serverId,
        { serverId, name: TOOL, kind: "read" },
        undefined,
        null,
        null,
        undefined,
        {
          versionId: candidateVersionId,
          replay: { asOf: at.B, lookbackHorizon: cutoff, countAllowed: replayCounterFor(db, ids.B) },
        },
      );
      expect(direct.candidateDecision).toBeUndefined();
      expect(direct.replayIndeterminate).toMatch(/pruned/);
    } finally {
      await db.delete(auditLog).where(eq(auditLog.id, marker!.id));
      pruneMarkers.splice(pruneMarkers.indexOf(marker!.id), 1);
    }
  });
});

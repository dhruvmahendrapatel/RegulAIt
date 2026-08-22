import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  complianceProfiles,
  createDb,
  eq,
  gte,
  inArray,
  lt,
  projects,
  runMigrations,
  spendAnomalies,
  spendForecastRuns,
  spendMonitorPolicies,
  spendScheduledChanges,
  usageEvents,
  type Db,
} from "@regulait/db";
import { computeForecast, resolveForecastPeriod, SPEND_ANOMALY_STAGE } from "./spend-monitor.js";

/**
 * ADR-0049 — COST FORECASTING and SPEND-ANOMALY DETECTION, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A FORECAST THAT IS A SNAPSHOT OF ITSELF. The projection case does not
 *     assert "it said 60 last time". It seeds ten known days into the REAL
 *     `usage_events` ledger, then asserts the projection equals the value
 *     written out by hand in the test body — and, separately, equals the ADR's
 *     own identity `spend_to_date / fraction_of_period_elapsed`.
 *
 *  2. A NUMBER INVENTED OUT OF NO DATA. A project with a single day of spend
 *     must come back `sufficient: false` with `projectedSpendUsd === null` —
 *     over HTTP, in the persisted artifact, and in the audit row. The DB CHECK
 *     added by migration 0061 is asserted directly too, so the invariant
 *     survives a future code path that forgets it.
 *
 *  3. A DETECTOR THAT FIRES ON EVERYTHING. Two projects are seeded with the
 *     SAME thirty-day baseline. One gets a genuine 40x spike on the observed
 *     day; the other gets an ordinary day. The first must fire and the second
 *     must not. A detector that only passed the first half would look green
 *     and be worthless, so the pairing is the assertion.
 *
 *  4. ONE TEAM LEARNING ANOTHER TEAM'S SPEND THROUGH A DERIVED NUMBER. Team
 *     B's lead is refused the org forecast and team A's forecast outright, and
 *     the forecast they ARE entitled to must carry team B's spend-to-date and
 *     ONLY team B's — asserted against the ledger, not against the UI. The
 *     anomaly list is scoped the same way: team A's flags must be absent from
 *     team B's list entirely, id included.
 *
 *  5. A SECOND INBOX. An escalating anomaly must produce a row in the EXISTING
 *     `approvals` table, with the project's own named budget approver.
 *
 * SHARED-STATE DISCIPLINE: this suite writes `usage_events` rows (the ONE spend
 * ledger every other suite reads) and creates projects/teams/users. Every
 * object is `spm-` prefixed and `afterAll` deletes every usage row, anomaly,
 * approval, policy, scheduled change and forecast run it created. It never
 * creates the ORG-WIDE default policy row (the `project_id IS NULL` singleton),
 * so no other suite's project inherits monitoring from it.
 */

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "spm-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);
const DAY_MS = 24 * 3600 * 1000;

/** the fixed instant every deterministic forecast assertion is made at: 10 days
 * into a 30-day month. Pinned rather than "now" so the arithmetic in the test
 * body is the arithmetic the code performs, on every machine, on every day. */
const FIXED_NOW = new Date("2026-06-11T00:00:00Z");

let db: Db;
let app: ReturnType<typeof buildApp>;
let leadAId: string;
let leadAAuth: { authorization: string };
let leadBId: string;
let leadBAuth: { authorization: string };
let teamAId: string;
let teamBId: string;
let alphaId: string; // team A's project — carries the spike
let betaId: string; // team B's project — the leak target
let forecastPid: string; // the deterministic ten-day forecast project
let calmId: string; // same baseline as alpha, ordinary observed day
// §4 framework-floor fixture (see the "§4 framework cost floor" describe):
let flooredId: string; // tagged 'spm-floor-block' — profile mandates block
let alertOnlyId: string; // untagged — the byte-identical control
let bareTagId: string; // tagged with a tag that has NO profile — null cascade
const createdUsageIds: string[] = [];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]! },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "spm" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function seedUsage(
  rows: Array<{
    userId: string;
    projectId: string;
    at: Date;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    objectType?: string;
  }>,
) {
  const out = await db
    .insert(usageEvents)
    .values(
      rows.map((r) => ({
        userId: r.userId,
        objectType: r.objectType ?? "agent",
        projectId: r.projectId,
        provider: "mock",
        model: r.model ?? "spm-model",
        inputTokens: r.inputTokens ?? 100,
        outputTokens: r.outputTokens ?? 50,
        costUsd: r.costUsd,
        at: r.at,
      })),
    )
    .returning({ id: usageEvents.id });
  createdUsageIds.push(...out.map((r) => r.id));
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

/** the ONE ledger, summed in JS — the independent expectation every
 * reconciliation assertion is measured against */
async function ledgerSum(projectId: string, start: Date, end: Date) {
  const rows = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.projectId, projectId), gte(usageEvents.at, start), lt(usageEvents.at, end)));
  return Number(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(6));
}

/** UTC midnight of today — the boundary the evaluator's observation window
 * ends on, so the seeded days line up with what it will read */
function todayUtcMidnight(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const a = await makeUser("spm-lead-a@example.com");
  leadAId = a.id;
  leadAAuth = a.auth;
  const b = await makeUser("spm-lead-b@example.com");
  leadBId = b.id;
  leadBAuth = b.auth;

  for (const name of ["spm-team-a", "spm-team-b"]) {
    const t = await app.inject({ method: "POST", url: "/v1/teams", headers: AUTH, payload: { name } });
    expect(t.statusCode).toBe(201);
    if (name === "spm-team-a") teamAId = t.json().id;
    else teamBId = t.json().id;
  }
  await app.inject({ method: "POST", url: `/v1/teams/${teamAId}/members`, headers: AUTH, payload: { userId: leadAId } });
  await app.inject({ method: "POST", url: `/v1/teams/${teamBId}/members`, headers: AUTH, payload: { userId: leadBId } });

  const mkProject = async (name: string, approver: string, budgetUsd: number | null) => {
    const p = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: AUTH,
      payload: { name, ...(budgetUsd != null ? { budgetUsd, budgetApproverUserId: approver } : {}) },
    });
    expect(p.statusCode, name).toBe(201);
    return p.json().id as string;
  };
  alphaId = await mkProject("spm-alpha", leadAId, 500);
  betaId = await mkProject("spm-beta", leadBId, 500);
  forecastPid = await mkProject("spm-forecast", leadAId, 40);
  calmId = await mkProject("spm-calm", leadAId, 500);

  for (const [pid, uid, tid] of [
    [alphaId, leadAId, teamAId],
    [forecastPid, leadAId, teamAId],
    [calmId, leadAId, teamAId],
    [betaId, leadBId, teamBId],
  ] as const) {
    const r = await app.inject({
      method: "POST",
      url: `/v1/projects/${pid}/members`,
      headers: AUTH,
      payload: { userId: uid, teamId: tid, role: "owner" },
    });
    expect(r.statusCode).toBe(201);
  }

  // --- the DETERMINISTIC forecast fixture: ten days of exactly $2 -----------
  // June 2026 is a 30-day month; FIXED_NOW is 10 days in. Every number the
  // forecast tests assert is derivable from these two facts with a calculator.
  await seedUsage(
    Array.from({ length: 10 }, (_, i) => ({
      userId: leadAId,
      projectId: forecastPid,
      at: new Date(Date.UTC(2026, 5, 1 + i, 12, 0, 0)),
      costUsd: 2,
    })),
  );

  // --- the ANOMALY fixture: the SAME 30-day baseline on two projects --------
  // Ordinary variance around $10/day, on days -31..-2 relative to today's UTC
  // midnight, all at the same UTC hour (so the off-hours signal has no
  // off-hours history and correctly makes no claim).
  const midnight = todayUtcMidnight();
  const baselinePattern = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10];
  const baselineRows = (pid: string) =>
    Array.from({ length: 30 }, (_, i) => ({
      userId: leadAId,
      projectId: pid,
      at: new Date(midnight.getTime() - (31 - i) * DAY_MS + 10 * 3600 * 1000),
      costUsd: baselinePattern[i % baselinePattern.length]!,
      inputTokens: baselinePattern[i % baselinePattern.length]! * 100,
      outputTokens: 0,
    }));
  await seedUsage(baselineRows(alphaId));
  await seedUsage(baselineRows(calmId));

  // the OBSERVED day (the last COMPLETE UTC day) diverges: alpha gets a
  // genuine runaway spike, calm gets an ordinary day.
  const observedAt = new Date(midnight.getTime() - DAY_MS + 10 * 3600 * 1000);
  await seedUsage([
    { userId: leadAId, projectId: alphaId, at: observedAt, costUsd: 400, inputTokens: 400_000, outputTokens: 0 },
  ]);
  await seedUsage([
    { userId: leadAId, projectId: calmId, at: observedAt, costUsd: 11, inputTokens: 1100, outputTokens: 0 },
  ]);

  // --- team B's own spend, in the CURRENT month, for the leak test ----------
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 6, 0, 0));
  await seedUsage([
    { userId: leadBId, projectId: betaId, at: thisMonth, costUsd: 7.25 },
    // deliberately a DIFFERENT team-A project from the anomaly fixture: the
    // anomaly evaluator's observation window is the last COMPLETE UTC day, and
    // on the first two days of a month that window and this timestamp collide.
    { userId: leadAId, projectId: forecastPid, at: thisMonth, costUsd: 123.5 },
  ]);
});

afterAll(async () => {
  const pids = [alphaId, betaId, forecastPid, calmId, flooredId, alertOnlyId, bareTagId].filter(
    Boolean,
  );
  // the §4 fixture's compliance profile is ORG-WIDE state: only projects
  // tagged 'spm-floor-block' feel it, but it goes anyway so nothing survives
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, "spm-floor-block"));
  // approvals carry a plain projectId column (no FK), so they do NOT cascade
  // with the project and must go explicitly or every other suite's queue moves
  if (pids.length) {
    await db.delete(approvals).where(and(inArray(approvals.projectId, pids), eq(approvals.stageId, SPEND_ANOMALY_STAGE)));
  }
  // anomalies, policies and scheduled changes cascade with their project
  if (pids.length) await db.delete(projects).where(inArray(projects.id, pids));
  if (createdUsageIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.id, createdUsageIds));
  }
  // forecast runs reference the requesting user with ON DELETE SET NULL, so
  // they survive; they are this suite's own artifacts and are removed by scope
  for (const pid of pids) {
    await db.delete(spendForecastRuns).where(eq(spendForecastRuns.scopeId, pid));
  }
});

// ---------------------------------------------------------------------------

describe("ADR-0049 — the forecast is real arithmetic on the real ledger", () => {
  it("projects ten measured days of $2 to exactly $60 over a 30-day month", async () => {
    const f = await computeForecast(db, {
      decision: { allowed: true, ruleId: "test", reason: "test", projectIds: [forecastPid] },
      request: { scopeKind: "project", scopeId: forecastPid },
      period: "current_month",
      method: "run_rate",
      now: FIXED_NOW,
    });
    // measured: 10 days x $2 = $20, and it must EQUAL the ledger
    const { start, end } = resolveForecastPeriod("current_month", FIXED_NOW);
    expect(f.spendToDateUsd).toBe(await ledgerSum(forecastPid, start, end));
    expect(f.spendToDateUsd).toBe(20);
    expect(f.observedDays).toBe(10);
    expect(f.activeDays).toBe(10);
    expect(f.meanDailyUsd).toBe(2);
    // hand arithmetic: 20 + 2 x 20 remaining days = 60
    expect(f.projectedSpendUsd).toBe(60);
    // ...and the ADR's own identity, spend_to_date / fraction_elapsed
    expect(f.projectedSpendUsd).toBe(20 / (10 / 30));
    // the fixture is perfectly flat, so there is NO sampling variation and the
    // interval is a point. A band invented where none exists would be a lie in
    // the opposite direction from an overconfident one.
    expect(f.lowUsd).toBe(60);
    expect(f.highUsd).toBe(60);
    expect(f.method).toBe("run_rate");
    expect(f.sufficient).toBe(true);
  });

  it("derives the budget percentage and the early-warning breach day", async () => {
    const f = await computeForecast(db, {
      decision: { allowed: true, ruleId: "test", reason: "test", projectIds: [forecastPid] },
      request: { scopeKind: "project", scopeId: forecastPid },
      period: "current_month",
      method: "run_rate",
      now: FIXED_NOW,
    });
    expect(f.budgetUsd).toBe(40); // the project's own budget
    expect(f.projectedPctOfBudget).toBe(150); // 60/40
    // $20 spent by day 10 at $2/day reaches the $40 budget on day 20
    expect(f.budgetBreachDay).toBe(20);
  });

  it("adds a DECIDED scheduled change on top, and drops it again when withdrawn", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/spend/scheduled-changes",
      headers: AUTH,
      payload: {
        projectId: forecastPid,
        deltaUsd: 15,
        effectiveAt: "2026-06-20T00:00:00.000Z",
        reason: "spm — a more expensive agent is granted from the 20th",
      },
    });
    expect(created.statusCode).toBe(201);
    const changeId = created.json().scheduledChange.id as string;

    const withChange = await computeForecast(db, {
      decision: { allowed: true, ruleId: "test", reason: "test", projectIds: [forecastPid] },
      request: { scopeKind: "project", scopeId: forecastPid },
      period: "current_month",
      method: "run_rate",
      now: FIXED_NOW,
    });
    expect(withChange.scheduledDeltaUsd).toBe(15);
    expect(withChange.projectedSpendUsd).toBe(75); // 60 + 15
    expect(withChange.scheduledChanges.map((c) => c.id)).toContain(changeId);

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/spend/scheduled-changes/${changeId}`,
      headers: AUTH,
    });
    expect(del.statusCode).toBe(200);
    const without = await computeForecast(db, {
      decision: { allowed: true, ruleId: "test", reason: "test", projectIds: [forecastPid] },
      request: { scopeKind: "project", scopeId: forecastPid },
      period: "current_month",
      method: "run_rate",
      now: FIXED_NOW,
    });
    expect(without.projectedSpendUsd).toBe(60);
    expect((await audits("spend-scheduled-change-created")).length).toBeGreaterThan(0);
  });

  it("carries the method, its assumptions, its limits and the not-a-commitment disclaimer", async () => {
    const f = await computeForecast(db, {
      decision: { allowed: true, ruleId: "test", reason: "test", projectIds: [forecastPid] },
      request: { scopeKind: "project", scopeId: forecastPid },
      period: "current_month",
      method: "ewma",
      now: FIXED_NOW,
    });
    expect(f.method).toBe("ewma");
    expect(f.disclaimer).toMatch(/NOT A COMMITMENT/);
    expect(f.limits.join(" ")).toMatch(/seasonal/);
    expect(f.limits.join(" ")).toMatch(/list-price ESTIMATE/);
    expect(f.assumptions.length).toBeGreaterThan(0);
  });
});

describe("ADR-0049 — insufficient history yields the HONEST SIGNAL, never a number", () => {
  it("a project with one day of spend gets sufficient:false and a null projection, end to end", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/spend/forecast?projectId=${betaId}&period=current_month`,
      headers: leadBAuth,
    });
    expect(res.statusCode).toBe(200);
    const f = res.json().forecast;
    expect(f.sufficient).toBe(false);
    expect(f.projectedSpendUsd).toBeNull();
    expect(f.lowUsd).toBeNull();
    expect(f.highUsd).toBeNull();
    expect(f.insufficientReason).toMatch(/INSUFFICIENT DATA/);
    // the MEASURED part is still reported — it is observed, not projected
    expect(f.spendToDateUsd).toBeGreaterThan(0);

    // the persisted artifact records the refusal AS SUCH
    const [run] = await db
      .select()
      .from(spendForecastRuns)
      .where(eq(spendForecastRuns.id, res.json().runId));
    expect(run!.sufficient).toBe(false);
    expect(run!.projectedSpendUsd).toBeNull();

    // ...and so does the audit row
    const rows = await audits("spend-forecast-computed");
    const mine = rows.find((r) => (r.detail as { runId?: string }).runId === run!.id);
    expect(mine).toBeTruthy();
    expect((mine!.detail as { sufficient: boolean }).sufficient).toBe(false);
    expect((mine!.detail as { projectedSpendUsd: number | null }).projectedSpendUsd).toBeNull();
    expect(mine!.reason).toMatch(/INSUFFICIENT DATA, no number claimed/);
  });

  it("the DATABASE itself refuses a stored forecast that claims a number without sufficiency", async () => {
    // migration 0061's CHECK is the backstop for a future code path that
    // forgets the invariant; assert it rather than trusting the one caller.
    await expect(
      db.insert(spendForecastRuns).values({
        scopeKind: "project",
        scopeId: betaId,
        effectiveProjectIds: [betaId],
        method: "run_rate",
        period: "current_month",
        periodStart: new Date("2026-06-01T00:00:00Z"),
        periodEnd: new Date("2026-07-01T00:00:00Z"),
        sufficient: false,
        projectedSpendUsd: 999, // <- the lie the CHECK exists to stop
        spendToDateUsd: 1,
        payload: {},
      }),
    ).rejects.toThrow();
  });
});

describe("ADR-0049 — the detector fires on a real spike AND stays silent on normal variance", () => {
  async function enable(projectId: string, action: "alert" | "require_approval") {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/spend/monitor-policies",
      headers: AUTH,
      payload: { projectId, enabled: true, sensitivity: "medium", baselineDays: 30, action },
    });
    expect(res.statusCode).toBe(200);
  }
  async function evaluate(projectId: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/spend/anomalies/evaluate",
      headers: AUTH,
      payload: { projectId },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it("FIRES on the runaway spike, with the evidence needed to re-derive it by hand", async () => {
    await enable(alphaId, "require_approval");
    const out = await evaluate(alphaId);
    expect(out.note).toMatch(/ADR-0064's in-process scheduler drives this/i);
    const result = out.results.find((r: { projectId: string }) => r.projectId === alphaId);
    expect(result.evaluated).toBe(true);
    const spike = result.verdicts.find((v: { signal: string }) => v.signal === "spend_spike");
    expect(spike.fired).toBe(true);
    expect(spike.method).toBe("mad_z");
    // baseline median $10, MAD $1 -> z = 0.6745 * (400 - 10) / 1
    expect(spike.baselineMedian).toBe(10);
    expect(spike.baselineMad).toBe(1);
    expect(spike.score).toBeCloseTo(0.6745 * 390, 3);
    expect(spike.explanation).toMatch(/modified z-score/);

    const [row] = await db
      .select()
      .from(spendAnomalies)
      .where(and(eq(spendAnomalies.projectId, alphaId), eq(spendAnomalies.signal, "spend_spike")));
    expect(row).toBeTruthy();
    expect(row!.observed).toBe(400);
    expect(row!.baselineSamples).toBe(30);
    expect(row!.status).toBe("open");
  });

  it("STAYS SILENT on a project with the SAME baseline and an ordinary observed day", async () => {
    await enable(calmId, "alert");
    const out = await evaluate(calmId);
    const result = out.results.find((r: { projectId: string }) => r.projectId === calmId);
    expect(result.evaluated).toBe(true);
    // every signal that could be evaluated must be quiet
    for (const v of result.verdicts) expect(v.fired, `${v.signal} must not fire`).toBe(false);
    const rows = await db.select().from(spendAnomalies).where(eq(spendAnomalies.projectId, calmId));
    expect(rows.length).toBe(0);
  });

  it("makes NO CLAIM for a project with no baseline — cold start is disclosed, not faked", async () => {
    await enable(betaId, "alert");
    const out = await evaluate(betaId);
    const result = out.results.find((r: { projectId: string }) => r.projectId === betaId);
    expect(result.evaluated).toBe(false);
    expect(result.reason).toMatch(/BASELINE BUILDING/);
    expect(result.verdicts.length).toBe(0);
    expect((await db.select().from(spendAnomalies).where(eq(spendAnomalies.projectId, betaId))).length).toBe(0);
  });

  it("is IDEMPOTENT: re-driving the evaluator does not manufacture duplicate incidents", async () => {
    const before = await db.select().from(spendAnomalies).where(eq(spendAnomalies.projectId, alphaId));
    await evaluate(alphaId);
    await evaluate(alphaId);
    const after = await db.select().from(spendAnomalies).where(eq(spendAnomalies.projectId, alphaId));
    expect(after.length).toBe(before.length);
  });

  it("records lastEvaluatedAt only for a policy an operator actually drove", async () => {
    const [p] = await db.select().from(spendMonitorPolicies).where(eq(spendMonitorPolicies.projectId, alphaId));
    expect(p!.lastEvaluatedAt).not.toBeNull();
    const overview = await app.inject({ method: "GET", url: "/v1/spend/monitor-overview", headers: AUTH });
    // ADR-0064: forced off under test, so still false — but now computed from
    // the deployment's real posture rather than hardcoded.
    expect(overview.json().schedulerPresent).toBe(false);
    expect(overview.json().note).toMatch(/A deployment running neither raises NO anomalies/i);
  });

  it("a disabled policy computes nothing at all — OFF by default is real", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/spend/monitor-policies",
      headers: AUTH,
      payload: { projectId: calmId, enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const out = await evaluate(calmId);
    const result = out.results.find((r: { projectId: string }) => r.projectId === calmId);
    expect(result.evaluated).toBe(false);
    expect(result.reason).toMatch(/not enabled/);
  });
});

describe("ADR-0049 — enforcement lands on the EXISTING approvals queue", () => {
  it("an escalating anomaly creates an approvals row for the project's named budget approver", async () => {
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.projectId, alphaId), eq(approvals.stageId, SPEND_ANOMALY_STAGE)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.objectType).toBe("project");
    expect(rows[0]!.approverUserId).toBe(leadAId);
    expect(rows[0]!.status).toBe("pending");

    // the anomaly row POINTS at that item rather than owning a parallel one
    const [anomaly] = await db
      .select()
      .from(spendAnomalies)
      .where(and(eq(spendAnomalies.projectId, alphaId), eq(spendAnomalies.signal, "spend_spike")));
    expect(anomaly!.approvalId).toBe(rows[0]!.id);
    expect(anomaly!.action).toBe("require_approval");

    // and it is visible in the ONE queue the rest of the product reads
    const queue = await app.inject({ method: "GET", url: "/v1/approvals", headers: AUTH });
    expect(queue.statusCode).toBe(200);
    const ids = (queue.json().approvals as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(rows[0]!.id);
  });

  it("acknowledging a flag demands a reason and keeps the evidence", async () => {
    const [anomaly] = await db
      .select()
      .from(spendAnomalies)
      .where(and(eq(spendAnomalies.projectId, alphaId), eq(spendAnomalies.signal, "spend_spike")));
    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/spend/anomalies/${anomaly!.id}`,
      headers: AUTH,
      payload: { status: "acknowledged" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/spend/anomalies/${anomaly!.id}`,
      headers: AUTH,
      payload: { status: "acknowledged", reason: "spm — confirmed: a test harness loop, not an incident" },
    });
    expect(ok.statusCode).toBe(200);
    const [after] = await db.select().from(spendAnomalies).where(eq(spendAnomalies.id, anomaly!.id));
    expect(after!.status).toBe("acknowledged");
    expect(after!.decisionReason).toMatch(/test harness loop/);
    // the evidence survives the decision
    expect(after!.score).toBe(anomaly!.score);
    expect(after!.explanation).toBe(anomaly!.explanation);
    expect((await audits("spend-anomaly-acknowledged")).length).toBeGreaterThan(0);

    const again = await app.inject({
      method: "PATCH",
      url: `/v1/spend/anomalies/${anomaly!.id}`,
      headers: AUTH,
      payload: { status: "dismissed", reason: "spm — second decision must be refused" },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("ADR-0049 §4 — the framework cost floor is SOURCED from the compliance cascade", () => {
  // Three projects with the SAME baseline and the SAME runaway spike, differing
  // only in classification — so the ONLY thing that can explain a different
  // enforcement outcome is the sourced floor:
  //   floored   tagged 'spm-floor-block' (profile: budgetEnforcement 'block')
  //   alertOnly untagged                 (the byte-identical control)
  //   bareTag   tagged 'spm-floor-no-profile-tag' (no profile row -> null cascade)
  // All three run an 'alert' policy: without the floor every outcome is
  // alert-only; the floor — and nothing else — raises floored's to
  // require_approval. Reverting the wiring to `frameworkFloor: null` reddens
  // the first test and leaves the two controls green (proven during the build).
  beforeAll(async () => {
    const prof = await app.inject({
      method: "POST",
      url: "/v1/compliance/profiles",
      headers: AUTH,
      payload: { tag: "spm-floor-block", budgetEnforcement: "block", piiMode: "log" },
    });
    expect(prof.statusCode, prof.body).toBe(201);

    const mk = async (name: string, classifications?: string[]) => {
      const p = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: AUTH,
        payload: {
          name,
          budgetUsd: 5000,
          budgetApproverUserId: leadAId,
          ...(classifications ? { classifications } : {}),
        },
      });
      expect(p.statusCode, name).toBe(201);
      return p.json().id as string;
    };
    flooredId = await mk("spm-floored", ["spm-floor-block"]);
    alertOnlyId = await mk("spm-alert-only");
    bareTagId = await mk("spm-bare-tag", ["spm-floor-no-profile-tag"]);

    // identical baseline + identical spike, straight from the alpha fixture
    const midnight = todayUtcMidnight();
    const baselinePattern = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10];
    const observedAt = new Date(midnight.getTime() - DAY_MS + 10 * 3600 * 1000);
    for (const pid of [flooredId, alertOnlyId, bareTagId]) {
      await seedUsage(
        Array.from({ length: 30 }, (_, i) => ({
          userId: leadAId,
          projectId: pid,
          at: new Date(midnight.getTime() - (31 - i) * DAY_MS + 10 * 3600 * 1000),
          costUsd: baselinePattern[i % baselinePattern.length]!,
          inputTokens: baselinePattern[i % baselinePattern.length]! * 100,
          outputTokens: 0,
        })),
      );
      await seedUsage([
        { userId: leadAId, projectId: pid, at: observedAt, costUsd: 400, inputTokens: 400_000, outputTokens: 0 },
      ]);
      const pol = await app.inject({
        method: "PUT",
        url: "/v1/spend/monitor-policies",
        headers: AUTH,
        payload: { projectId: pid, enabled: true, sensitivity: "medium", baselineDays: 30, action: "alert" },
      });
      expect(pol.statusCode).toBe(200);
      const ev = await app.inject({
        method: "POST",
        url: "/v1/spend/anomalies/evaluate",
        headers: AUTH,
        payload: { projectId: pid },
      });
      expect(ev.statusCode).toBe(200);
    }
  }, 120_000);

  it("a block-mandating profile RAISES an 'alert' policy to require_approval, disclosed by name", async () => {
    const [row] = await db
      .select()
      .from(spendAnomalies)
      .where(and(eq(spendAnomalies.projectId, flooredId), eq(spendAnomalies.signal, "spend_spike")));
    expect(row).toBeTruthy();
    expect(row!.action).toBe("require_approval");
    const detail = row!.detail as {
      enforcement: string;
      enforcementReason: string;
      frameworkFloor: string | null;
    };
    // the FLOOR ruleId, not the plain policy one — the tightening names its cause
    expect(detail.enforcement).toBe("spend-anomaly-enforced-framework-floor");
    expect(detail.frameworkFloor).toBe("block");
    expect(detail.enforcementReason).toMatch(/compliance framework mandates blocking/i);
    expect(detail.enforcementReason).toMatch(/floor tightens, never relaxes/i);
    // and the response is REAL: an item on the one approvals queue, pointed at
    const [item] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.projectId, flooredId), eq(approvals.stageId, SPEND_ANOMALY_STAGE)));
    expect(item).toBeTruthy();
    expect(item!.approverUserId).toBe(leadAId);
    expect(row!.approvalId).toBe(item!.id);
  });

  it("an UNTAGGED project's 'alert' stays an alert — no queue item, floor null", async () => {
    const [row] = await db
      .select()
      .from(spendAnomalies)
      .where(and(eq(spendAnomalies.projectId, alertOnlyId), eq(spendAnomalies.signal, "spend_spike")));
    expect(row).toBeTruthy();
    expect(row!.action).toBe("alert");
    expect(row!.approvalId).toBeNull();
    const detail = row!.detail as { enforcement: string; frameworkFloor: string | null };
    expect(detail.enforcement).toBe("spend-anomaly-alert-only");
    expect(detail.frameworkFloor).toBeNull();
    const queueRows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.projectId, alertOnlyId), eq(approvals.stageId, SPEND_ANOMALY_STAGE)));
    expect(queueRows).toHaveLength(0);
  });

  it("a tag with NO profile resolves a null cascade — byte-identical to untagged", async () => {
    const [row] = await db
      .select()
      .from(spendAnomalies)
      .where(and(eq(spendAnomalies.projectId, bareTagId), eq(spendAnomalies.signal, "spend_spike")));
    expect(row).toBeTruthy();
    expect(row!.action).toBe("alert");
    expect(row!.approvalId).toBeNull();
    const detail = row!.detail as { enforcement: string; frameworkFloor: string | null };
    expect(detail.enforcement).toBe("spend-anomaly-alert-only");
    expect(detail.frameworkFloor).toBeNull();
  });
});

describe("ADR-0049 — a derived number never leaks another team's spend", () => {
  it("refuses team B's lead the ORG forecast outright", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/spend/forecast", headers: leadBAuth });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("spend_scope_not_entitled");
    const denies = await audits("spend-forecast-denied");
    expect(denies.length).toBeGreaterThan(0);
    expect(denies.some((d) => d.effect === "deny")).toBe(true);
  });

  it("refuses team B's lead a forecast scoped to team A", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/spend/forecast?teamId=${teamAId}`,
      headers: leadBAuth,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses team B's lead a forecast scoped to team A's PROJECT", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/spend/forecast?projectId=${alphaId}`,
      headers: leadBAuth,
    });
    expect(res.statusCode).toBe(403);
  });

  it("the forecast team B's lead IS entitled to carries team B's spend and ONLY team B's", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/spend/forecast?teamId=${teamBId}&period=current_month`,
      headers: leadBAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope.effectiveProjectIds).toEqual([betaId]);
    const { start, end } = resolveForecastPeriod("current_month", new Date());
    const betaOnly = await ledgerSum(betaId, start, end);
    const otherTeam = await ledgerSum(forecastPid, start, end);
    expect(otherTeam).toBeGreaterThan(0); // the fixture really does have other-team spend to leak
    expect(body.forecast.spendToDateUsd).toBe(betaOnly);
    expect(body.forecast.spendToDateUsd).not.toBe(betaOnly + otherTeam);
    // and the PERSISTED artifact records the same narrowing
    const [run] = await db.select().from(spendForecastRuns).where(eq(spendForecastRuns.id, body.runId));
    expect(run!.effectiveProjectIds).toEqual([betaId]);
    expect(run!.spendToDateUsd).toBe(betaOnly);
  });

  it("team A's anomaly flags are absent from team B's list — not even their ids appear", async () => {
    const mine = await db.select().from(spendAnomalies).where(eq(spendAnomalies.projectId, alphaId));
    expect(mine.length).toBeGreaterThan(0);

    const res = await app.inject({ method: "GET", url: "/v1/spend/anomalies", headers: leadBAuth });
    expect(res.statusCode).toBe(200);
    const seen = res.json().anomalies as Array<{ id: string; projectId: string }>;
    expect(seen.some((s) => s.projectId === alphaId)).toBe(false);
    for (const m of mine) expect(seen.map((s) => s.id)).not.toContain(m.id);

    // ...and team A's lead, who IS a member, does see them
    const asA = await app.inject({ method: "GET", url: "/v1/spend/anomalies", headers: leadAAuth });
    expect((asA.json().anomalies as Array<{ projectId: string }>).some((s) => s.projectId === alphaId)).toBe(true);
  });
});

describe("ADR-0049 — admin gating and audit", () => {
  it("refuses a non-admin every authoring and evaluator surface", async () => {
    for (const [method, url, payload] of [
      ["PUT", "/v1/spend/monitor-policies", { projectId: alphaId, enabled: true }],
      ["GET", "/v1/spend/monitor-policies", undefined],
      ["POST", "/v1/spend/anomalies/evaluate", { projectId: alphaId }],
      ["POST", "/v1/spend/scheduled-changes", { projectId: alphaId, deltaUsd: 1, effectiveAt: "2026-09-01T00:00:00.000Z", reason: "x" }],
      ["GET", "/v1/spend/scheduled-changes", undefined],
      ["GET", "/v1/spend/monitor-overview", undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: leadAAuth, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("writes stable ruleIds for every governed act", async () => {
    for (const ruleId of [
      "spend-forecast-computed",
      "spend-forecast-denied",
      "spend-anomaly-escalated",
      "spend-anomaly-acknowledged",
      "spend-anomaly-swept",
      "spend-monitor-policy-updated",
      "spend-scheduled-change-created",
      "spend-scheduled-change-deleted",
    ]) {
      expect((await audits(ruleId)).length, ruleId).toBeGreaterThan(0);
    }
    // the escalation is recorded with require_approval, not silently as allow
    const esc = await audits("spend-anomaly-escalated");
    expect(esc.some((e) => e.effect === "require_approval")).toBe(true);
  });
});

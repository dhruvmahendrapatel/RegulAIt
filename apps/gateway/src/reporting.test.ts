import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  gte,
  lt,
  inArray,
  reportDefinitions,
  reportRuns,
  reportSchedules,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { parseReportCsv, resolveReportPeriod } from "@regulait/shared";

/**
 * ADR-0047 — EXECUTIVE & COMPLIANCE REPORTING, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A NUMBER THAT IS A SNAPSHOT OF ITSELF. The reconciliation case does NOT
 *     assert "the report says 4.5 and it said 4.5 last time". It re-queries
 *     `usage_events` for the exact period window, sums the rows in JS, and
 *     asserts the report's total EQUALS that. If the report ever grew a
 *     denormalized rollup that drifted from the ledger, this fails.
 *
 *  2. A LEAK THROUGH AGGREGATION. This is the one ADR-0047 says the reviewer
 *     must check. A non-admin team lead generates a report and the assertions
 *     are on the SERVED PAYLOAD and the PERSISTED `effective_project_ids` — not
 *     on what a UI chose to render. The other team's project id must be absent
 *     from the payload, absent from the run row, and the org-scoped definition
 *     must 403 outright.
 *
 *  3. A REPORT THAT READS AN ARTIFACT IT SHOULD NOT. A generated run carries
 *     the entitlement scope it was produced under; a non-admin is refused both
 *     the run read and its export, and the run does not appear in their list.
 *
 *  4. A SCHEDULE THAT PRETENDS TO FIRE. The schedule case asserts that creating
 *     a schedule generates NOTHING, that the operator-driven sweep is what
 *     generates, and that an immediately-repeated sweep skips.
 *
 * SHARED-STATE DISCIPLINE: this suite writes `usage_events` rows (the ONE spend
 * ledger every other suite also reads) and creates projects/teams/users. Every
 * object is `rpt-` prefixed and `afterAll` deletes every usage row, run,
 * schedule and definition it created, so no other suite's totals move.
 */

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rpt-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let alphaId: string;
let betaId: string;
let teamAId: string;
let teamBId: string;
let leadAId: string;
let leadAAuth: { authorization: string };
let leadBId: string;
let leadBAuth: { authorization: string };
let orgDefId: string;
let teamDefId: string;
let projectDefId: string;
let complianceDefId: string;
const createdUsageIds: string[] = [];

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "rpt" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeDefinition(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/reports/definitions",
    headers: AUTH,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().definition.id as string;
}

async function generate(defId: string, auth: { authorization: string }, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/v1/reports/definitions/${defId}/generate`,
    headers: auth,
    payload: body,
  });
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

/** the ONE ledger, summed in JS — the independent expectation every
 * reconciliation assertion is measured against */
async function ledgerTotalFor(projectIds: string[], start: Date, end: Date) {
  const rows = await db
    .select()
    .from(usageEvents)
    .where(and(inArray(usageEvents.projectId, projectIds), gte(usageEvents.at, start), lt(usageEvents.at, end)));
  return {
    costUsd: Number(rows.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(6)),
    events: rows.length,
    inputTokens: rows.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const a = await makeUser("rpt-lead-a@example.com");
  leadAId = a.id;
  leadAAuth = a.auth;
  const b = await makeUser("rpt-lead-b@example.com");
  leadBId = b.id;
  leadBAuth = b.auth;

  for (const name of ["rpt-team-a", "rpt-team-b"]) {
    const t = await app.inject({ method: "POST", url: "/v1/teams", headers: AUTH, payload: { name } });
    expect(t.statusCode).toBe(201);
    if (name === "rpt-team-a") teamAId = t.json().id;
    else teamBId = t.json().id;
  }
  await app.inject({
    method: "POST",
    url: `/v1/teams/${teamAId}/members`,
    headers: AUTH,
    payload: { userId: leadAId },
  });
  await app.inject({
    method: "POST",
    url: `/v1/teams/${teamBId}/members`,
    headers: AUTH,
    payload: { userId: leadBId },
  });

  for (const name of ["rpt-alpha", "rpt-beta"]) {
    const p = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: AUTH,
      payload: { name, budgetUsd: 100, budgetApproverUserId: name === "rpt-alpha" ? leadAId : leadBId },
    });
    expect(p.statusCode).toBe(201);
    if (name === "rpt-alpha") alphaId = p.json().id;
    else betaId = p.json().id;
  }
  await app.inject({
    method: "POST",
    url: `/v1/projects/${alphaId}/members`,
    headers: AUTH,
    payload: { userId: leadAId, teamId: teamAId, role: "owner" },
  });
  await app.inject({
    method: "POST",
    url: `/v1/projects/${betaId}/members`,
    headers: AUTH,
    payload: { userId: leadBId, teamId: teamBId, role: "owner" },
  });

  // REAL ledger rows, mid-current-month so the default period window contains
  // them regardless of when the suite runs.
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12, 0, 0));
  const rows = await db
    .insert(usageEvents)
    .values([
      { userId: leadAId, objectType: "agent", projectId: alphaId, provider: "mock", model: "m", inputTokens: 100, outputTokens: 40, costUsd: 1.25, at },
      { userId: leadAId, objectType: "agent", projectId: alphaId, provider: "mock", model: "m", inputTokens: 200, outputTokens: 60, costUsd: 2.5, at },
      { userId: leadBId, objectType: "agent", projectId: betaId, provider: "mock", model: "m", inputTokens: 300, outputTokens: 90, costUsd: 7.75, at },
    ])
    .returning({ id: usageEvents.id });
  createdUsageIds.push(...rows.map((r) => r.id));

  orgDefId = await makeDefinition({
    name: "rpt-board-exec",
    kind: "exec_summary",
    scopeKind: "org",
    entitlementScope: "org",
    period: "current_month",
  });
  teamDefId = await makeDefinition({
    name: "rpt-team-a-scorecard",
    kind: "team_scorecard",
    scopeKind: "team",
    scopeId: teamAId,
    entitlementScope: "team",
    period: "current_month",
  });
  projectDefId = await makeDefinition({
    name: "rpt-beta-only",
    kind: "exec_summary",
    scopeKind: "project",
    scopeId: betaId,
    entitlementScope: "project",
    period: "current_month",
  });
  complianceDefId = await makeDefinition({
    name: "rpt-compliance",
    kind: "compliance",
    scopeKind: "org",
    entitlementScope: "org",
    period: "current_month",
  });
});

afterAll(async () => {
  // definitions cascade to schedules and runs; the usage rows are this suite's
  // own additions to the ONE shared ledger and must go, or every other suite's
  // org-wide totals move under it
  await db.delete(reportDefinitions).where(
    inArray(reportDefinitions.id, [orgDefId, teamDefId, projectDefId, complianceDefId].filter(Boolean)),
  );
  if (createdUsageIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.id, createdUsageIds));
  }
});

describe("ADR-0047 — reports reconcile against the ledger", () => {
  it("a project-scoped report's total EQUALS the sum of the underlying usage_events rows", async () => {
    const res = await generate(projectDefId, AUTH);
    expect(res.statusCode).toBe(201);
    const report = res.json().report;
    const { start, end } = resolveReportPeriod("current_month", new Date());
    const expected = await ledgerTotalFor([betaId], start, end);
    expect(report.spend.totalCostUsd).toBe(expected.costUsd);
    expect(report.spend.totalEvents).toBe(expected.events);
    expect(report.spend.totalInputTokens).toBe(expected.inputTokens);
    // and the beta line is the only line
    expect(report.spend.lines.map((l: { projectId: string }) => l.projectId)).toEqual([betaId]);
  });

  it("an ADMIN org report includes both projects and still reconciles per line", async () => {
    const res = await generate(orgDefId, AUTH);
    expect(res.statusCode).toBe(201);
    const report = res.json().report;
    const { start, end } = resolveReportPeriod("current_month", new Date());
    const lines: Array<{ projectId: string | null; costUsd: number }> = report.spend.lines;
    const alphaLine = lines.find((l) => l.projectId === alphaId)!;
    const betaLine = lines.find((l) => l.projectId === betaId)!;
    expect(alphaLine.costUsd).toBe((await ledgerTotalFor([alphaId], start, end)).costUsd);
    expect(betaLine.costUsd).toBe((await ledgerTotalFor([betaId], start, end)).costUsd);
    // the org path is the only one that carries the unbounded scope
    expect(res.json().scope.effectiveProjectIds).toBeNull();
    expect(report.disclaimer).toMatch(/ESTIMATES/);
  });

  it("labels spend as an estimate on the face of the report", async () => {
    const res = await generate(projectDefId, AUTH);
    expect(res.json().report.spend.estimate).toBe(true);
    expect(res.json().report.spend.disclaimer).toMatch(/list price/);
  });
});

describe("ADR-0047 — a report cannot exceed the caller's own visibility", () => {
  it("refuses an ORG-scoped definition to a non-admin, and audits the refusal", async () => {
    const res = await generate(orgDefId, leadAAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("report_scope_not_entitled");
    const rows = await audits("report-access-denied-org-scope");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.userId === leadAId && r.effect === "deny")).toBe(true);
  });

  it("scopes a team lead's own scorecard to their project — the other team's data is ABSENT, not hidden", async () => {
    const res = await generate(teamDefId, leadAAuth);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // the SERVED payload, not a UI filter
    const lines: Array<{ projectId: string | null; costUsd: number }> = body.report.spend.lines;
    expect(lines.map((l) => l.projectId)).toEqual([alphaId]);
    expect(lines.some((l) => l.projectId === betaId)).toBe(false);
    const { start, end } = resolveReportPeriod("current_month", new Date());
    const alphaOnly = await ledgerTotalFor([alphaId], start, end);
    const both = await ledgerTotalFor([alphaId, betaId], start, end);
    expect(body.report.spend.totalCostUsd).toBe(alphaOnly.costUsd);
    // proof the scoping is arithmetic, not cosmetic: the number is strictly
    // less than the number an unscoped query would have produced
    expect(body.report.spend.totalCostUsd).toBeLessThan(both.costUsd);
    // and the PERSISTED record of what it was allowed to see agrees
    expect(body.scope.effectiveProjectIds).toEqual([alphaId]);
    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, body.run.id));
    expect(run!.effectiveProjectIds).toEqual([alphaId]);
  });

  it("refuses another team's scorecard outright", async () => {
    const res = await generate(teamDefId, leadBAuth);
    expect(res.statusCode).toBe(403);
    const rows = await audits("report-access-denied-not-team-member");
    expect(rows.some((r) => r.userId === leadBId)).toBe(true);
  });

  it("refuses a project report to a non-member", async () => {
    const res = await generate(projectDefId, leadAAuth);
    expect(res.statusCode).toBe(403);
    expect((await audits("report-access-denied-not-project-member")).some((r) => r.userId === leadAId)).toBe(true);
  });

  it("refuses a non-admin the READ and the EXPORT of an org-scoped artifact, and omits it from their list", async () => {
    const admin = await generate(orgDefId, AUTH);
    const runId = admin.json().run.id as string;
    const read = await app.inject({ method: "GET", url: `/v1/reports/runs/${runId}`, headers: leadAAuth });
    expect(read.statusCode).toBe(403);
    const exp = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv`,
      headers: leadAAuth,
    });
    expect(exp.statusCode).toBe(403);
    const list = await app.inject({ method: "GET", url: "/v1/reports/runs", headers: leadAAuth });
    expect(list.statusCode).toBe(200);
    expect(list.json().runs.some((r: { id: string }) => r.id === runId)).toBe(false);
    expect((await audits("report-read-denied")).length).toBeGreaterThan(0);
    expect((await audits("report-export-denied")).length).toBeGreaterThan(0);
  });

  it("lets the team lead read back their OWN artifact", async () => {
    const own = await generate(teamDefId, leadAAuth);
    const runId = own.json().run.id as string;
    const read = await app.inject({ method: "GET", url: `/v1/reports/runs/${runId}`, headers: leadAAuth });
    expect(read.statusCode).toBe(200);
    expect(read.json().run.entitlementScope).toBe("team");
  });
});

describe("ADR-0047 — export", () => {
  it("emits the documented CSV and round-trips it back to the payload's numbers", async () => {
    const gen = await generate(teamDefId, AUTH);
    const runId = gen.json().run.id as string;
    const total = gen.json().report.spend.totalCostUsd as number;
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=csv`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["x-regulait-report-basis"]).toBe("estimate-list-price");
    const rows = parseReportCsv(res.body);
    const cell = (s: string, k: string, m: string) =>
      rows.find((r) => r.section === s && r.key === k && r.metric === m)?.value;
    expect(Number(cell("spend", "total", "cost_usd"))).toBe(total);
    expect(cell("meta", "report", "basis")).toBe("estimate");
    expect((await audits("report-exported")).length).toBeGreaterThan(0);
  });

  it("emits JSON verbatim on request", async () => {
    const gen = await generate(teamDefId, AUTH);
    const runId = gen.json().run.id as string;
    const res = await app.inject({
      method: "GET",
      url: `/v1/reports/runs/${runId}/export?format=json`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.spend.totalCostUsd).toBe(gen.json().report.spend.totalCostUsd);
  });
});

describe("ADR-0047 — compliance rendering", () => {
  it("renders every named control, and any control without evidence as an explicit gap", async () => {
    const res = await generate(complianceDefId, AUTH);
    expect(res.statusCode).toBe(201);
    const controls = res.json().report.controls;
    expect(controls.controls).toHaveLength(5);
    expect(controls.met + controls.gaps).toBe(5);
    for (const c of controls.controls) {
      expect(["met", "gap"]).toContain(c.status);
      if (c.evidenceCount === 0) expect(c.status).toBe("gap");
    }
    // the audit-trail control cannot be a gap: this very suite has written rows
    expect(controls.controls.find((c: { id: string }) => c.id === "audit-trail-present").status).toBe("met");
    expect(controls.note).toMatch(/ADR-0058/);
  });
});

describe("ADR-0047 — schedules define, they do not fire", () => {
  it("creating a schedule generates nothing; the operator sweep is what generates, and it skips when not due", async () => {
    const before = await db.select().from(reportRuns).where(eq(reportRuns.definitionId, complianceDefId));
    const sched = await app.inject({
      method: "POST",
      url: `/v1/reports/definitions/${complianceDefId}/schedules`,
      headers: AUTH,
      payload: { cadence: "daily", recipientUserIds: [leadAId] },
    });
    expect(sched.statusCode).toBe(201);
    expect(sched.json().note).toMatch(/Nothing drives it/);
    const scheduleId = sched.json().schedule.id as string;
    const afterCreate = await db.select().from(reportRuns).where(eq(reportRuns.definitionId, complianceDefId));
    expect(afterCreate.length).toBe(before.length);

    const sweep1 = await app.inject({ method: "POST", url: "/v1/reports/schedules/run-due", headers: AUTH });
    expect(sweep1.statusCode).toBe(200);
    expect(sweep1.json().note).toMatch(/no in-process scheduler/i);
    expect(sweep1.json().generated.some((g: { scheduleId: string }) => g.scheduleId === scheduleId)).toBe(true);
    const [row1] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, scheduleId));
    expect(row1!.lastGeneratedAt).not.toBeNull();
    expect(row1!.lastRunId).not.toBeNull();

    // immediately again: the daily cadence is not due, so nothing is generated
    const sweep2 = await app.inject({ method: "POST", url: "/v1/reports/schedules/run-due", headers: AUTH });
    expect(sweep2.json().generated.some((g: { scheduleId: string }) => g.scheduleId === scheduleId)).toBe(false);
    expect(sweep2.json().skipped.some((s: { scheduleId: string }) => s.scheduleId === scheduleId)).toBe(true);
    expect((await audits("report-schedule-swept")).length).toBeGreaterThan(0);

    const [scheduledRun] = await db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.scheduleId, scheduleId), eq(reportRuns.trigger, "scheduled")));
    expect(scheduledRun).toBeTruthy();
  });

  it("the overview discloses that no scheduler exists", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/reports/overview", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedulerPresent).toBe(false);
    expect(res.json().note).toMatch(/No in-process scheduler/);
  });
});

describe("ADR-0047 — admin gating and audit", () => {
  it("refuses a non-admin the authoring surface", async () => {
    for (const [method, url, payload] of [
      ["POST", "/v1/reports/definitions", { name: "rpt-nope", kind: "exec_summary", scopeKind: "org", entitlementScope: "org" }],
      ["GET", "/v1/reports/definitions", undefined],
      ["POST", "/v1/reports/schedules/run-due", {}],
      ["GET", "/v1/reports/overview", undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: leadAAuth, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const [leaked] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.name, "rpt-nope"));
    expect(leaked).toBeUndefined();
  });

  it("audits definition authoring and every generation with the effective scope", async () => {
    expect((await audits("report-definition-created")).length).toBeGreaterThanOrEqual(4);
    const gens = await audits("report-generated");
    expect(gens.length).toBeGreaterThan(0);
    const scoped = gens.find(
      (g) => Array.isArray((g.detail as { effectiveProjectIds?: string[] }).effectiveProjectIds),
    );
    expect(scoped).toBeTruthy();
    expect((scoped!.detail as { effectiveProjectIds: string[] }).effectiveProjectIds).toBeTruthy();
    expect(gens.every((g) => g.objectType === "report")).toBe(true);
    expect((await audits("report-schedule-created")).length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  assessControls,
  buildGovernanceSection,
  buildSpendSection,
  buildWorkflowSection,
  createReportDefinitionSchema,
  csvRecord,
  defaultSectionsFor,
  evaluateReportAccess,
  parseReportCsv,
  renderReportCsv,
  resolveReportPeriod,
  scheduleIsDue,
  type ReportPayload,
} from "./reporting.js";

/**
 * ADR-0047 — the PURE half, proved by attack.
 *
 * The interesting assertions here are all about the ENTITLEMENT decision. A
 * report aggregates across teams, so the failure mode is not "the number is
 * wrong", it is "the number is right and the caller should never have seen it".
 * Every case below is an attempt to widen a caller's visibility through a
 * report; each asserts the returned PROJECT-ID SET, not merely a boolean,
 * because the id set is what the gateway builds its WHERE clause from.
 */

const ALPHA = "11111111-1111-1111-1111-111111111111";
const BETA = "22222222-2222-2222-2222-222222222222";
const TEAM_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER = "99999999-9999-9999-9999-999999999999";

describe("ADR-0047 report entitlement scoping", () => {
  it("refuses an ORG-scoped definition to a non-admin, however many projects they are on", () => {
    const d = evaluateReportAccess({
      isAdmin: false,
      userId: USER,
      definition: { kind: "exec_summary", scopeKind: "org", scopeId: null, entitlementScope: "org" },
      scopeProjectIds: [ALPHA, BETA],
      callerProjectIds: [ALPHA, BETA],
      callerTeamIds: [TEAM_A, TEAM_B],
    });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("report-access-denied-org-scope");
    // and — the part that matters — it hands the generator NOTHING to query
    expect(d.projectIds).toEqual([]);
  });

  it("gives an admin an org report the UNBOUNDED scope (null), not a project list", () => {
    const d = evaluateReportAccess({
      isAdmin: true,
      userId: USER,
      definition: { kind: "exec_summary", scopeKind: "org", scopeId: null, entitlementScope: "org" },
      scopeProjectIds: [ALPHA, BETA],
      callerProjectIds: [],
      callerTeamIds: [],
    });
    expect(d.allowed).toBe(true);
    // null is the ONLY value that admits unattributed (project_id IS NULL) spend
    expect(d.projectIds).toBeNull();
  });

  it("keeps an ADMIN's non-org report scoped to the definition — admin widens WHO, never WHAT", () => {
    const d = evaluateReportAccess({
      isAdmin: true,
      userId: USER,
      definition: { kind: "team_scorecard", scopeKind: "team", scopeId: TEAM_A, entitlementScope: "team" },
      scopeProjectIds: [ALPHA],
      callerProjectIds: [],
      callerTeamIds: [],
    });
    expect(d.allowed).toBe(true);
    expect(d.projectIds).toEqual([ALPHA]);
  });

  it("refuses a team scorecard to someone outside that team", () => {
    const d = evaluateReportAccess({
      isAdmin: false,
      userId: USER,
      definition: { kind: "team_scorecard", scopeKind: "team", scopeId: TEAM_A, entitlementScope: "team" },
      scopeProjectIds: [ALPHA],
      callerProjectIds: [ALPHA],
      callerTeamIds: [TEAM_B],
    });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("report-access-denied-not-team-member");
  });

  it("NARROWS a correctly-granted team report to the projects the caller is actually on", () => {
    // the caller IS in team A, and team A spans two projects — but they are only
    // a member of one. The report must not carry the other project's line.
    const d = evaluateReportAccess({
      isAdmin: false,
      userId: USER,
      definition: { kind: "team_scorecard", scopeKind: "team", scopeId: TEAM_A, entitlementScope: "team" },
      scopeProjectIds: [ALPHA, BETA],
      callerProjectIds: [ALPHA],
      callerTeamIds: [TEAM_A],
    });
    expect(d.allowed).toBe(true);
    expect(d.projectIds).toEqual([ALPHA]);
    expect(d.projectIds).not.toContain(BETA);
  });

  it("refuses rather than serving an empty report when the caller sees none of the scope", () => {
    const d = evaluateReportAccess({
      isAdmin: false,
      userId: USER,
      definition: { kind: "team_scorecard", scopeKind: "team", scopeId: TEAM_A, entitlementScope: "team" },
      scopeProjectIds: [BETA],
      callerProjectIds: [],
      callerTeamIds: [TEAM_A],
    });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("report-access-denied-no-visible-projects");
  });

  it("refuses an identity-less caller", () => {
    const d = evaluateReportAccess({
      isAdmin: false,
      userId: null,
      definition: { kind: "team_scorecard", scopeKind: "team", scopeId: TEAM_A, entitlementScope: "team" },
      scopeProjectIds: [ALPHA],
      callerProjectIds: [ALPHA],
      callerTeamIds: [TEAM_A],
    });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("report-access-denied-no-identity");
  });

  it("refuses a project grant against a project the caller is not on", () => {
    const d = evaluateReportAccess({
      isAdmin: false,
      userId: USER,
      definition: { kind: "exec_summary", scopeKind: "project", scopeId: BETA, entitlementScope: "project" },
      scopeProjectIds: [BETA],
      callerProjectIds: [ALPHA],
      callerTeamIds: [],
    });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("report-access-denied-not-project-member");
  });
});

describe("ADR-0047 definition shape", () => {
  it("refuses an org entitlement on a narrow definition (privilege creep)", () => {
    const r = createReportDefinitionSchema.safeParse({
      name: "x",
      kind: "team_scorecard",
      scopeKind: "team",
      scopeId: TEAM_A,
      entitlementScope: "org",
    });
    expect(r.success).toBe(false);
  });

  it("refuses a scopeId on an org definition and requires one otherwise", () => {
    expect(
      createReportDefinitionSchema.safeParse({ name: "x", kind: "exec_summary", scopeKind: "org", scopeId: ALPHA })
        .success,
    ).toBe(false);
    expect(
      createReportDefinitionSchema.safeParse({ name: "x", kind: "exec_summary", scopeKind: "team" }).success,
    ).toBe(false);
  });
});

describe("ADR-0047 period resolution", () => {
  it("computes half-open UTC windows independent of the server locale", () => {
    const now = new Date("2026-05-17T13:45:00.000Z");
    const cur = resolveReportPeriod("current_month", now);
    expect(cur.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(cur.end.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(cur.label).toBe("2026-05");
    const last = resolveReportPeriod("last_month", now);
    expect(last.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(last.end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    const q = resolveReportPeriod("current_quarter", now);
    expect(q.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(q.label).toBe("2026-Q2");
    const lq = resolveReportPeriod("last_quarter", now);
    expect(lq.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(lq.label).toBe("2026-Q1");
  });

  it("rolls the year backwards at a January boundary", () => {
    const now = new Date("2026-01-09T00:00:00.000Z");
    expect(resolveReportPeriod("last_month", now).label).toBe("2025-12");
    expect(resolveReportPeriod("last_quarter", now).label).toBe("2025-Q4");
  });
});

describe("ADR-0047 section assembly", () => {
  it("totals spend from the lines and labels itself an estimate", () => {
    const s = buildSpendSection([
      { projectId: ALPHA, projectName: "alpha", costUsd: 1.5, events: 2, inputTokens: 10, outputTokens: 5, budgetUsd: 1 },
      { projectId: BETA, projectName: "beta", costUsd: 0.25, events: 1, inputTokens: 4, outputTokens: 2, budgetUsd: 10 },
    ]);
    expect(s.totalCostUsd).toBe(1.75);
    expect(s.totalEvents).toBe(3);
    expect(s.totalBudgetUsd).toBe(11);
    expect(s.budgetVarianceUsd).toBe(9.25);
    expect(s.overBudgetProjects).toEqual(["alpha"]);
    expect(s.estimate).toBe(true);
    expect(s.disclaimer).toMatch(/ESTIMATES/);
  });

  it("computes a deny rate and a median approval latency", () => {
    const g = buildGovernanceSection(
      [
        { effect: "allow", count: 7 },
        { effect: "deny", count: 3 },
      ],
      [{ ruleId: "budget-exceeded", count: 3 }],
    );
    expect(g.totalDecisions).toBe(10);
    expect(g.denyRate).toBe(0.3);
    const w = buildWorkflowSection({
      statuses: [
        { status: "approved", count: 2 },
        { status: "pending", count: 1 },
      ],
      decisionMinutes: [10, 30, 20],
    });
    expect(w.approvalsRequested).toBe(3);
    expect(w.approvalsDecided).toBe(2);
    expect(w.medianDecisionMinutes).toBe(20);
  });
});

describe("ADR-0047 compliance controls", () => {
  it("renders a control with no evidence as an explicit GAP, never a silent pass", () => {
    const c = assessControls("built-in", { auditRows: 12, approvalRows: 0 });
    const audit = c.controls.find((x) => x.id === "audit-trail-present")!;
    const approval = c.controls.find((x) => x.id === "approval-gate-coverage")!;
    expect(audit.status).toBe("met");
    expect(approval.status).toBe("gap");
    expect(approval.note).toMatch(/NO EVIDENCE/);
    // every control the catalogue names is present — an unassessed control is
    // not allowed to simply be absent from the report
    expect(c.controls).toHaveLength(5);
    expect(c.met + c.gaps).toBe(5);
    expect(c.note).toMatch(/NOT an assertion that the control is operating effectively/);
  });
});

describe("ADR-0047 CSV export", () => {
  const payload: ReportPayload = {
    kind: "exec_summary",
    definitionName: 'Board, "Q2"',
    scope: { kind: "org", id: null, projectIds: null },
    period: { period: "current_month", label: "2026-05", start: "2026-05-01T00:00:00.000Z", end: "2026-06-01T00:00:00.000Z" },
    generatedAt: "2026-05-17T00:00:00.000Z",
    disclaimer: "estimates",
    spend: buildSpendSection([
      { projectId: ALPHA, projectName: "alpha, ltd", costUsd: 1.5, events: 2, inputTokens: 10, outputTokens: 5, budgetUsd: null },
    ]),
    governance: buildGovernanceSection([{ effect: "deny", count: 2 }], [{ ruleId: "r1", count: 2 }]),
  };

  it("round-trips through the documented long format, quoting included", () => {
    const csv = renderReportCsv(payload);
    expect(csv.split("\r\n")[0]).toBe("section,key,metric,value");
    const rows = parseReportCsv(csv);
    const find = (s: string, k: string, m: string) =>
      rows.find((r) => r.section === s && r.key === k && r.metric === m)?.value;
    expect(find("meta", "report", "definition")).toBe('Board, "Q2"');
    expect(find("spend", "total", "cost_usd")).toBe("1.5");
    expect(find("spend", ALPHA, "project_name")).toBe("alpha, ltd");
    expect(find("governance", "total", "deny")).toBe("2");
    // the numbers in the CSV are the numbers in the payload — no second
    // computation that could disagree
    expect(Number(find("spend", "total", "cost_usd"))).toBe(payload.spend!.totalCostUsd);
  });

  it("neutralises a formula in any cell (CSV injection), but not a negative amount", () => {
    const hostile: ReportPayload = {
      ...payload,
      definitionName: '=HYPERLINK("http://x.invalid")',
      spend: buildSpendSection([
        { projectId: ALPHA, projectName: "@SUM(A1)", costUsd: 1.5, events: 2, inputTokens: 10, outputTokens: 5, budgetUsd: 1 },
      ]),
    };
    const csv = renderReportCsv(hostile);
    const rows = parseReportCsv(csv);
    for (const r of rows) {
      for (const cell of [r.section, r.key, r.metric, r.value]) expect(cell).not.toMatch(/^[=+@\t\r]/);
    }
    const find = (s: string, k: string, m: string) => rows.find((r) => r.section === s && r.key === k && r.metric === m)?.value;
    expect(find("meta", "report", "definition")).toBe(`'=HYPERLINK("http://x.invalid")`);
    expect(find("spend", ALPHA, "project_name")).toBe("'@SUM(A1)");
    // budget 1, spend 1.5: a negative variance is a number, not a formula
    expect(find("spend", "total", "budget_variance_usd")).toBe("-0.5");
  });

  it("csvRecord: RFC 4180 quoting plus formula neutralisation; numbers stay numbers", () => {
    expect(csvRecord(["=1+1", "@SUM(A1)", "+1", "-x", "\tx", "＝1"])).toBe("'=1+1,'@SUM(A1),'+1,'-x,'\tx,'＝1");
    expect(csvRecord(['-2,"x"'])).toBe(`"'-2,""x"""`);
    expect(csvRecord([-2, 0, 1.5, true, false, null, undefined, ""])).toBe("-2,0,1.5,true,false,,,");
    expect(csvRecord([{ a: 1 }, new Date("2026-01-02T03:04:05.000Z")])).toBe(`"{""a"":1}",2026-01-02T03:04:05.000Z`);
    expect(csvRecord(["a\nb", "plain"])).toBe(`"a\nb",plain`);
  });

  it("rejects a foreign CSV rather than mis-parsing it", () => {
    expect(() => parseReportCsv("a,b,c\n1,2,3\n")).toThrow(/header/);
  });
});

describe("ADR-0047 schedule due-ness", () => {
  it("treats a never-generated schedule as due, then respects the cadence", () => {
    const now = new Date("2026-05-17T00:00:00.000Z");
    expect(scheduleIsDue("daily", null, now)).toBe(true);
    expect(scheduleIsDue("daily", new Date("2026-05-16T23:00:00.000Z"), now)).toBe(false);
    expect(scheduleIsDue("daily", new Date("2026-05-15T23:00:00.000Z"), now)).toBe(true);
    expect(scheduleIsDue("weekly", new Date("2026-05-12T00:00:00.000Z"), now)).toBe(false);
    expect(scheduleIsDue("quarterly", new Date("2026-01-01T00:00:00.000Z"), now)).toBe(true);
  });
});

describe("ADR-0047 default sections", () => {
  it("gives a compliance report controls, and a scorecard spend", () => {
    expect(defaultSectionsFor("compliance")).toContain("controls");
    expect(defaultSectionsFor("team_scorecard")).toContain("spend");
  });
});

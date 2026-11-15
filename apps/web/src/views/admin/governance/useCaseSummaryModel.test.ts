import { describe, expect, it } from "vitest";
import type { UseCaseCondition } from "../../../api/types";
import type { OverviewResponse, OverviewRisk } from "./useCaseLifecycle";
import {
  approvalChecklist,
  approvalReason,
  conditionCounts,
  conditionsFigure,
  decisionPanel,
  evidenceFigure,
  nextAction,
  readOf,
  recertificationFigure,
  riskFigure,
  type Read,
} from "./useCaseSummaryModel";

const cond = (over: Partial<UseCaseCondition> = {}): UseCaseCondition => ({
  id: "c1",
  approvalId: "a1",
  text: "Complete a bias test",
  ownerUserId: "dana",
  ownerName: "Dana Developer",
  dueAt: "2026-12-12T00:00:00Z",
  blocking: true,
  status: "open",
  metAt: null,
  metByName: null,
  overdue: false,
  canMarkMet: false,
  ...over,
});
const ok = <T>(value: T): Read<T> => ({ state: "ok", value });
const risk = (over: Partial<OverviewRisk> = {}): OverviewRisk => ({
  id: "r1",
  title: "Biased extraction",
  category: "bias",
  dimension: "bias",
  status: "mitigating",
  inherent: { likelihood: "high", impact: "high" },
  residual: { likelihood: "low", impact: "medium" },
  controls: [],
  ...over,
});

describe("readOf", () => {
  it("is ok, error or loading — never an empty value for an unknown read", () => {
    expect(readOf({ isSuccess: true, isError: false, data: [1] })).toEqual({ state: "ok", value: [1] });
    expect(readOf({ isSuccess: false, isError: true, data: undefined })).toEqual({ state: "error" });
    expect(readOf({ isSuccess: false, isError: false, data: undefined })).toEqual({ state: "loading" });
  });
});

describe("risk figure", () => {
  it("says there are no risks rather than a 0", () => {
    const f = riskFigure([], ok([]));
    expect(f.value).toBe("No risks registered");
    expect(f.meter).toBeNull();
  });
  it("counts the risks, the residual ratings and who accepted residual risk", () => {
    const f = riskFigure([risk(), risk({ id: "r2", residual: null })], ok([{ id: "r1", acceptedByName: "Morgan Reyes", acceptedAt: "2026-11-04T00:00:00Z" }]));
    expect(f.state).toBe("ok");
    expect(f.value).toBe("2 risks");
    expect(f.detail).toBe("residual rated for 1 of 2 after the linked controls · 1 accepted by Morgan Reyes");
    expect(f.meter).toMatchObject({ value: 1, max: 2, warn: true });
    expect(f.scope).toMatch(/risk register/);
  });
  it("one risk reads singular, and an acceptance without a name still counts", () => {
    const f = riskFigure([risk()], ok([{ id: "r1", acceptedByName: null, acceptedAt: "2026-11-04T00:00:00Z" }]));
    expect(f.value).toBe("1 risk");
    expect(f.detail).toMatch(/1 accepted$/);
    expect(f.meter?.warn).toBe(false);
  });
  it("says none was accepted, and says so when the acceptance read failed or is loading", () => {
    expect(riskFigure([risk()], ok([])).detail).toMatch(/no residual risk accepted/);
    expect(riskFigure([risk()], { state: "error" }).detail).toMatch(/could not be loaded/);
    expect(riskFigure([risk()], { state: "loading" }).detail).toBe("residual rated for 1 of 1 after the linked controls");
  });
});

describe("evidence figure", () => {
  it("is Not measured, with a link to the evidence, when no read gives both numbers", () => {
    const f = evidenceFigure(null);
    expect(f).toMatchObject({ state: "unmeasured", value: "Not measured", meter: null, link: { tab: "audit" } });
    expect(f.value).not.toMatch(/\d/);
  });
  it("is unavailable when its read failed, and loading while it loads — never 0", () => {
    expect(evidenceFigure({ state: "error" })).toMatchObject({ state: "unavailable", value: "Unavailable" });
    expect(evidenceFigure({ state: "loading" })).toMatchObject({ state: "loading", value: null });
  });
  it("shows X of Y only when both numbers are read", () => {
    expect(evidenceFigure(ok({ attached: 11, required: 14 }))).toMatchObject({ state: "ok", value: "11 of 14", meter: { warn: true } });
    expect(evidenceFigure(ok({ attached: 14, required: 14 })).meter?.warn).toBe(false);
  });
});

describe("conditions figure", () => {
  it("is unavailable when the detail failed and loading while it loads", () => {
    expect(conditionsFigure({ state: "error" })).toMatchObject({ state: "unavailable", value: "Unavailable" });
    expect(conditionsFigure({ state: "loading" }).state).toBe("loading");
  });
  it("says none are attached for an empty list", () => {
    expect(conditionsFigure(ok([])).value).toBe("None attached");
  });
  it("counts open, met, waived and the ones that block go-live", () => {
    const rows = [cond(), cond({ id: "c2", blocking: false }), cond({ id: "c3", status: "met" }), cond({ id: "c4", status: "waived", blocking: false })];
    expect(conditionCounts(rows)).toEqual({ total: 4, open: 2, met: 1, waived: 1, openBlocking: 1 });
    const f = conditionsFigure(ok(rows));
    expect(f.value).toBe("2 open");
    expect(f.detail).toBe("1 of 4 met · 1 waived · 1 blocks go-live (the deploy gate refuses)");
    expect(f.meter).toMatchObject({ value: 2, max: 4, warn: true });
  });
  it("plural blockers, and none blocking", () => {
    expect(conditionsFigure(ok([cond(), cond({ id: "c2" })])).detail).toMatch(/2 block go-live/);
    expect(conditionsFigure(ok([cond({ blocking: false })])).detail).toMatch(/none blocks go-live/);
  });
});

describe("recertification figure", () => {
  const dates = { approvedUntil: "2027-05-04T00:00:00Z", approvalExpired: false, recertification: false, recertificationDueAt: null };
  it("shows the approval's end", () => {
    expect(recertificationFigure(ok(dates))).toMatchObject({ state: "ok", value: "4 May 2027" });
  });
  it("says an expired approval needs a new review", () => {
    expect(recertificationFigure(ok({ ...dates, approvalExpired: true })).detail).toMatch(/expired/);
  });
  it("uses the re-review date when the sweep moved it back, and the end date as a fallback", () => {
    expect(recertificationFigure(ok({ ...dates, recertification: true, recertificationDueAt: "2026-10-03T00:00:00Z" })).value).toBe("3 Oct 2026");
    expect(recertificationFigure(ok({ ...dates, recertification: true })).value).toBe("4 May 2027");
    expect(recertificationFigure(ok({ ...dates, approvedUntil: null, recertification: true })).value).toBe("Due now");
  });
  it("has no end date as not measured, and a failed read as unavailable", () => {
    expect(recertificationFigure(ok({ ...dates, approvedUntil: null }))).toMatchObject({ state: "unmeasured", value: "No end date" });
    expect(recertificationFigure({ state: "error" })).toMatchObject({ state: "unavailable" });
    expect(recertificationFigure({ state: "loading" })).toMatchObject({ state: "loading", value: null });
  });
});

describe("the one Next action", () => {
  const base = { status: "approved", conditions: ok([] as UseCaseCondition[]), resubmissionAllowed: false, canOpenResubmit: true };
  it("is an open blocking condition the viewer may mark met, the soonest due first", () => {
    const later = cond({ id: "late", dueAt: "2027-01-01T00:00:00Z", canMarkMet: true });
    const sooner = cond({ id: "soon", dueAt: "2026-12-01T00:00:00Z", canMarkMet: true });
    expect(nextAction({ ...base, conditions: ok([later, sooner]) })).toEqual({ kind: "mark-met", condition: sooner });
  });
  it("never offers a condition the server's flag does not allow, or one that does not block, or one already met", () => {
    const rows = [cond({ canMarkMet: false }), cond({ id: "x", blocking: false, canMarkMet: true }), cond({ id: "y", status: "met", canMarkMet: true }), cond({ id: "z", canMarkMet: undefined })];
    expect(nextAction({ ...base, conditions: ok(rows) })).toBeNull();
  });
  it("with no condition to mark, needs-info links to the resubmission (when the server allows it)", () => {
    expect(nextAction({ ...base, status: "needs_info", resubmissionAllowed: true, returnReason: "Add the DPIA." })).toEqual({ kind: "resubmit", reachable: true, reason: "Add the DPIA." });
    expect(nextAction({ ...base, status: "needs_info", resubmissionAllowed: true, canOpenResubmit: false })).toEqual({ kind: "resubmit", reachable: false, reason: null });
    expect(nextAction({ ...base, status: "needs_info", resubmissionAllowed: false })).toBeNull();
  });
  it("under review points at the approvals", () => {
    expect(nextAction({ ...base, status: "under_review" })).toEqual({ kind: "review" });
  });
  it("a failed or loading conditions read falls through to the status, never guessing a condition", () => {
    expect(nextAction({ ...base, status: "under_review", conditions: { state: "error" } })).toEqual({ kind: "review" });
    expect(nextAction({ ...base, conditions: { state: "loading" } })).toBeNull();
  });
  it("is nothing otherwise", () => {
    expect(nextAction({ ...base, status: "rejected" })).toBeNull();
  });
});

describe("the decision panel", () => {
  const approvals: OverviewResponse["approvals"] = [
    { id: "a0", status: "returned", stageId: "signoff", approverUserId: "avery", requestedAt: "2026-10-01T00:00:00Z", decidedAt: "2026-10-02T00:00:00Z", decisionReason: "More detail" },
    { id: "a1", status: "approved", stageId: "signoff", approverUserId: "avery", requestedAt: "2026-11-01T00:00:00Z", decidedAt: "2026-11-04T00:00:00Z", decisionReason: "Humans stay in the loop." },
  ];
  const userName = (id: string | null) => (id === "avery" ? "Avery Approver" : null);
  it("names the decision, who decided and when, with the conditions count", () => {
    const p = decisionPanel({ status: "approved", approvals, reviews: ok([]), conditions: ok([cond(), cond({ id: "c2" })]), userName });
    expect(p).toEqual({ title: "Approved with 2 conditions", tone: "ok", by: "Avery Approver, 4 Nov 2026", quorum: null });
  });
  it("gives the quorum from the round's role reviews and names their deciders", () => {
    const p = decisionPanel({
      status: "approved",
      approvals,
      reviews: ok([
        { roleId: "r1", roleName: "Risk", status: "approved", deciderName: "Avery Approver", decidedAt: "2026-11-04T00:00:00Z", approvalId: "a1" },
        { roleId: "r2", roleName: "Privacy", status: "approved", deciderName: "Morgan Reyes", decidedAt: "2026-11-04T00:00:00Z", approvalId: "a2" },
      ]),
      conditions: ok([cond()]),
      userName,
    });
    expect(p.title).toBe("Approved with 1 condition");
    expect(p.by).toBe("Avery Approver and Morgan Reyes, 4 Nov 2026");
    expect(p.quorum).toBe("2 of 2 required reviews approved");
  });
  it("says plain Approved when the conditions are not known or none", () => {
    expect(decisionPanel({ status: "approved", approvals, reviews: { state: "error" }, conditions: { state: "error" }, userName }).title).toBe("Approved");
    expect(decisionPanel({ status: "approved", approvals, reviews: ok([]), conditions: ok([]), userName }).title).toBe("Approved");
  });
  it("an open review names nobody; every other state has its words", () => {
    expect(decisionPanel({ status: "under_review", approvals, reviews: ok([]), conditions: ok([]), userName })).toMatchObject({ title: "Awaiting a decision", tone: "info", by: null });
    expect(decisionPanel({ status: "proposed", approvals: [], reviews: ok([]), conditions: ok([]), userName })).toMatchObject({ title: "Not yet submitted for review", by: null });
    expect(decisionPanel({ status: "needs_info", approvals, reviews: ok([]), conditions: ok([]), userName })).toMatchObject({ title: "Sent back for information", tone: "warn" });
    expect(decisionPanel({ status: "rejected", approvals: [], reviews: ok([{ roleId: "r", roleName: "Risk", status: "denied", deciderName: null, decidedAt: "2026-11-01T00:00:00Z", approvalId: "a" }]), conditions: ok([]), userName })).toMatchObject({ title: "Rejected", tone: "danger", by: "1 Nov 2026", quorum: "0 of 1 required review approved" });
    expect(decisionPanel({ status: "retired", approvals: [], reviews: ok([]), conditions: ok([]), userName })).toMatchObject({ title: "Retired", tone: "neutral", by: null });
  });
});

describe("why it was approved", () => {
  const data = {
    useCase: { id: "u", name: "Claims intake", status: "approved" },
    screening: { tier: "high", reasons: [], rulesetVersion: 1, screened: true },
    questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: null },
    stack: { agents: [{ id: "g", name: "Extractor", provider: "custom", model: null, lifecycleStatus: "active", halted: false, modelCards: [], modelCardApproved: false }], vendors: [] },
    risks: [risk(), risk({ id: "r2", residual: null })],
    summary: { risks: 2, liveRisks: 2, liveWithoutControls: 1, agentsWithoutApprovedModelCard: 1, pendingApprovals: 0 },
    approvals: [],
    audit: [],
  } as OverviewResponse;
  it("builds each line from a flag the record holds, with open conditions last", () => {
    const lines = approvalChecklist(data, ok([cond(), cond({ id: "c2", status: "met" })]));
    expect(lines.map((l) => [l.key, l.ok])).toEqual([
      ["questionnaire", true],
      ["screening", true],
      ["risks", false],
      ["controls", false],
      ["model-cards", false],
      ["cond-c1", false],
    ]);
    expect(lines[2]!.text).toBe("1 of 2 risks have a residual rating");
    expect(lines[5]!.text).toBe("Complete a bias test (condition, before go-live)");
  });
  it("says what is missing on a bare record and leaves out unknown conditions", () => {
    const bare = { ...data, screening: { ...data.screening, screened: false, tier: null }, questionnaire: { ...data.questionnaire, submitted: false }, risks: [], stack: { agents: [], vendors: [] }, summary: { ...data.summary, liveRisks: 0 } } as OverviewResponse;
    const lines = approvalChecklist(bare, { state: "error" });
    expect(lines.map((l) => l.text)).toEqual(["Intake questionnaire not submitted", "EU AI Act screening not done", "No risks registered"]);
  });
  it("is complete when every flag is", () => {
    const good = { ...data, risks: [risk()], summary: { ...data.summary, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0 } } as OverviewResponse;
    expect(approvalChecklist(good, ok([cond({ blocking: false })])).map((l) => l.text)).toEqual([
      "Intake questionnaire submitted",
      "EU AI Act screening complete: high tier",
      "1 of 1 risk has a residual rating",
      "Every live risk has a linked control",
      "Every agent has an approved model card",
      "Complete a bias test (condition, after go-live)",
    ]);
  });
  it("the recorded reason is the newest approving decision's, when it has one", () => {
    const approvals: OverviewResponse["approvals"] = [
      { id: "1", status: "approved", stageId: "s", approverUserId: null, requestedAt: "x", decidedAt: "2026-10-01T00:00:00Z", decisionReason: "Older" },
      { id: "2", status: "approved", stageId: "s", approverUserId: null, requestedAt: "x", decidedAt: "2026-11-01T00:00:00Z", decisionReason: " Newer " },
      { id: "3", status: "denied", stageId: "s", approverUserId: null, requestedAt: "x", decidedAt: "2026-12-01T00:00:00Z", decisionReason: "Denied" },
    ];
    expect(approvalReason(approvals)).toBe("Newer");
    expect(approvalReason([{ ...approvals[0]!, decisionReason: "  " }])).toBeNull();
    expect(approvalReason([])).toBeNull();
  });
});

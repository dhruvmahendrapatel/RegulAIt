import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { fetchReport, fetchReviews, raiseReview, withdrawReview } from "./entitlementFindingsApi";
import { REVIEW_COPY, REVIEW_STATUSES, changeProblem, findingsReducer, initialScreen, normaliseReport, normaliseReviews, subjectOf, type Finding } from "./entitlementFindingsModel";

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const G = "33333333-3333-4333-8333-333333333333";
const finding = (over: Record<string, unknown> = {}) => ({
  key: `unused-grant:grant:${G}`, ruleId: "unused-grant", ruleVersion: 1, rationale: "Not used in 90 days.",
  source: { id: "s1", name: "Sample tenant", platform: "m365", kind: "entitlement_m365" },
  app: { id: "a1", externalId: "app-idle", displayName: "Idle app", agentId: null },
  grant: { id: G, scope: "Mail.Send", resource: null, access: "write", accessReason: "", grantType: "application", consent: "admin" },
  agentRecord: null,
  evidence: { usageCoverage: "app", windowDays: 90, lastUseAt: null },
  action: { kind: "vendor-console", note: "Remove or narrow it in the vendor's admin console.", raise: { method: "POST", path: "/x", key: "k" } },
  review: null,
  ...over,
});
const report = (findings: unknown[], notAssessable: unknown[] = []) => ({
  rulesVersion: "1", classifierVersion: "1", windowDays: 90, computedAt: "2026-11-23T02:00:00Z", scanTruncated: false,
  rules: [{ id: "unused-grant", title: "Unused grants", severity: "review-suggested", limits: "Only sources that record usage.", count: findings.length, truncated: false, findings, notAssessable }],
});
const review = (status: string, allowed: boolean) => ({
  id: "r1", findingKey: `unused-grant:grant:${G}`, ruleId: "unused-grant", ruleVersion: 1, sourceId: "s1", grantId: null, agentRecordId: null, subjectGone: true,
  rationale: "Not used.", evidence: {}, status, reason: "retired", requestedBy: "u1", approvalId: "ap1", decidedBy: null, decidedAt: null, createdAt: "2026-11-23T02:00:00Z",
  lifecycle: { machine: "saas_finding_review", state: status, terminal: !allowed, transitions: [{ event: "withdraw", to: "withdrawn", allowed, by: ["admin"], summary: "", ...(allowed ? {} : { reason: "a decided review cannot be withdrawn" }) }] },
});

afterEach(() => vi.unstubAllGlobals());

describe("normaliseReport", () => {
  it("keeps a missing evidence value as 'none recorded', never 0 or never", () => {
    const out = normaliseReport(report([finding()]));
    const f = out.rules[0]!.findings[0]!;
    expect(f.evidence).toContainEqual(["lastUseAt", "none recorded"]);
    expect(f.evidence).toContainEqual(["windowDays", "90"]);
    expect(subjectOf(f)).toBe("Idle app");
  });

  it("keeps not-assessable sources apart from findings", () => {
    const out = normaliseReport(report([], [{ source: { id: "s2", name: "Other" }, reason: "no read of this source has recorded usage yet" }]));
    expect(out.rules[0]!.findings).toEqual([]);
    expect(out.rules[0]!.notAssessable).toEqual([{ source: "Other", reason: "no read of this source has recorded usage yet" }]);
  });

  it("names an agent finding by its agent record", () => {
    const f = normaliseReport(report([finding({ key: `publicly-exposed-agent:record:${G}`, ruleId: "publicly-exposed-agent", app: null, grant: null, agentRecord: { id: G, registry: "studio", externalId: "bot-1", displayName: "Open bot", agentId: null } })])).rules[0]!.findings[0] as Finding;
    expect(subjectOf(f)).toBe("Open bot");
  });

  it("a malformed answer is a failed read", () => {
    expect(() => normaliseReport({ ...report([]), scanTruncated: "no" })).toThrow(/scanTruncated/);
    expect(() => normaliseReport(report([finding({ evidence: { nested: { a: 1 } } })]))).toThrow(/evidence/);
    expect(() => normaliseReport(report([finding({ review: { id: "r", status: "revoked", decidedAt: null } })]))).toThrow(/status/);
  });
});

describe("reviews", () => {
  it("withdraw follows the review's own lifecycle, and the vendor removing the subject is kept", () => {
    const { reviews } = normaliseReviews({ reviews: [review("pending", true), review("accepted", false)], next: null });
    expect(reviews[0]!.canWithdraw).toEqual({ ok: true });
    expect(reviews[1]!.canWithdraw).toEqual({ ok: false, why: "a decided review cannot be withdrawn" });
    expect(reviews[0]!.subjectGone).toBe(true);
  });

  it("no state's words say a grant was removed or revoked", () => {
    for (const s of REVIEW_STATUSES) expect(REVIEW_COPY[s].label).not.toMatch(/\b(revoked|compliant|(was|been|is) removed)\b|^removed/i);
  });
});

describe("findingsReducer", () => {
  const f = normaliseReport(report([finding()])).rules[0]!.findings[0]!;

  it("a raise needs an approver and a reason within the gateway's limit", () => {
    expect(changeProblem({ kind: "raise", finding: f, approverUserId: "", reason: "x" })).toMatch(/administrator/);
    expect(changeProblem({ kind: "raise", finding: f, approverUserId: "u2", reason: "  " })).toMatch(/why/);
    expect(changeProblem({ kind: "raise", finding: f, approverUserId: "u2", reason: "x".repeat(1001) })).toMatch(/1000/);
    expect(changeProblem({ kind: "raise", finding: f, approverUserId: "u2", reason: "retired" })).toBeNull();
  });

  it("one change at a time; window and cursors are independent of it", () => {
    const open = findingsReducer(initialScreen, { type: "open", change: { kind: "raise", finding: f, approverUserId: "u2", reason: "retired" } });
    const sub = findingsReducer(open, { type: "submit" });
    expect(sub.flow.phase).toBe("submitting");
    expect(findingsReducer(sub, { type: "cancel" })).toBe(sub);
    const failed = findingsReducer(sub, { type: "failed", message: "approver_is_requester" });
    expect(failed.flow).toMatchObject({ phase: "failed", message: "approver_is_requester" });
    expect(findingsReducer(failed, { type: "submit" }).flow.phase).toBe("submitting");
    expect(findingsReducer(initialScreen, { type: "cancel" })).toBe(initialScreen);
    expect(findingsReducer(initialScreen, { type: "window", windowDays: 30 }).windowDays).toBe(30);
    const more = findingsReducer(initialScreen, { type: "moreReviews", after: "c1" });
    expect(more.reviewCursors).toEqual([null, "c1"]);
    expect(findingsReducer(more, { type: "moreReviews", after: "c1" })).toBe(more);
  });
});

describe("the calls", () => {
  it("reads the report with only the window, and a 403 is an ApiError", async () => {
    const fetchMock = vi.fn(async (_u: string) => res(report([])));
    vi.stubGlobal("fetch", fetchMock);
    await fetchReport(30);
    expect(fetchMock.mock.calls[0]![0]).toBe("/v1/discovery/entitlements/findings?windowDays=30");
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "forbidden" }, 403)));
    await expect(fetchReport(30)).rejects.toBeInstanceOf(ApiError);
  });

  it("pages reviews by cursor, raises with the trimmed reason, and withdraws", async () => {
    const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => res({ reviews: [], next: null }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchReviews("c1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/v1/discovery/entitlements/findings/reviews?after=c1&limit=50");
    vi.stubGlobal("fetch", vi.fn(async (_u: string, i?: RequestInit) => res({ review: review("pending", true), echo: JSON.parse(String(i?.body)) }, 201)));
    const r = await raiseReview({ key: "k", approverUserId: "u2", reason: "  retired  ", windowDays: 90 });
    expect(r.status).toBe("pending");
    const raiseMock = vi.fn(async (_u: string, _i?: RequestInit) => res({ review: review("pending", true) }, 201));
    vi.stubGlobal("fetch", raiseMock);
    await raiseReview({ key: "k", approverUserId: "u2", reason: "  retired  ", windowDays: 90 });
    expect(JSON.parse(String(raiseMock.mock.calls[0]![1]!.body))).toEqual({ key: "k", approverUserId: "u2", reason: "retired", windowDays: "90" });
    const wd = vi.fn(async (_u: string, _i?: RequestInit) => res({ review: review("withdrawn", false) }));
    vi.stubGlobal("fetch", wd);
    await withdrawReview("r1");
    expect(wd.mock.calls[0]![0]).toBe("/v1/discovery/entitlements/findings/reviews/r1/withdraw");
    expect(wd.mock.calls[0]![1]!.method).toBe("POST");
  });
});

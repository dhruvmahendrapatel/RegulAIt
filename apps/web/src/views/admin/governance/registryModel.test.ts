import { describe, expect, it } from "vitest";
import { NO_FILTERS, applyFilters, fmtDay, headline, isFiltered, resubmitPath, rowStatus, statusLabel, validity, type UseCaseRow } from "./registryModel";

const row = (over: Partial<UseCaseRow>): UseCaseRow => ({
  id: "x", name: "x", description: "", businessContext: "", ownerUserId: "u1", ownerName: "Avery", intendedAgentIds: [],
  dataSensitivity: "internal", complianceTags: [], projectId: null, status: "proposed", workflowInstanceId: null,
  euAiActTier: null, decidedAt: null, retiredReason: null, createdAt: "2026-09-01T00:00:00Z", ...over,
});

const rows = [
  row({ id: "a", name: "Credit assistant", status: "under_review", euAiActTier: "high" }),
  row({ id: "b", name: "Ticket summarizer", description: "support desk", status: "approved", euAiActTier: "minimal", ownerUserId: "u2", ownerName: "Riley" }),
  row({ id: "c", name: "Citizen score", status: "needs_info", euAiActTier: "prohibited" }),
  row({ id: "d", name: "Old bot", status: "retired" }),
];

describe("ADR-0168 AI registry model", () => {
  it("counts the headline tiles: in review includes proposed and sent-back records", () => {
    expect(headline(rows)).toEqual({ total: 4, underReview: 2, approved: 1, highTier: 2 });
  });

  it("filters by status, tier, owner and text, together", () => {
    expect(applyFilters(rows, NO_FILTERS).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(applyFilters(rows, { ...NO_FILTERS, status: "in_review" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(applyFilters(rows, { ...NO_FILTERS, status: "approved" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters(rows, { ...NO_FILTERS, tier: "high_or_prohibited" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(applyFilters(rows, { ...NO_FILTERS, tier: "unscreened" }).map((r) => r.id)).toEqual(["d"]);
    expect(applyFilters(rows, { ...NO_FILTERS, owner: "u2" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters(rows, { ...NO_FILTERS, search: "SUPPORT" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters(rows, { ...NO_FILTERS, search: "riley" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters(rows, { ...NO_FILTERS, status: "in_review", tier: "high" }).map((r) => r.id)).toEqual(["a"]);
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, search: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, owner: "u2" })).toBe(true);
  });

  it("reads 'valid until': a dash before approval, the date after, and an expired approval called out", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(validity(null, undefined, now)).toEqual({ text: "—", expired: false });
    expect(validity(undefined, undefined, now)).toEqual({ text: "—", expired: false });
    expect(validity("2027-04-03T00:00:00Z", undefined, now)).toEqual({ text: "3 Apr 2027", expired: false });
    expect(validity("2026-09-30T00:00:00Z", undefined, now)).toEqual({ text: "Expired 30 Sept 2026", expired: true });
    // the server's flag wins over the clock
    expect(validity("2027-04-03T00:00:00Z", true, now).expired).toBe(true);
  });

  it("labels statuses in sentence case, including the new sent-back state", () => {
    expect(statusLabel("needs_info")).toBe("Needs information");
    expect(statusLabel("under_review")).toBe("Under review");
    expect(statusLabel("something_new")).toBe("Something new");
    expect(fmtDay("not a date")).toBe("—");
  });
});

describe("re-review (ADR-0168 amendment)", () => {
  const recert = [
    row({ id: "r", name: "Expired bot", status: "under_review", recertification: true }),
    row({ id: "u", name: "Fresh review", status: "under_review" }),
    row({ id: "a", name: "Approved bot", status: "approved", recertification: false }),
  ];
  it("the Re-review filter keeps only recertifications; In review still counts them", () => {
    expect(applyFilters(recert, { ...NO_FILTERS, status: "recertification" }).map((r) => r.id)).toEqual(["r"]);
    expect(applyFilters(recert, { ...NO_FILTERS, status: "in_review" }).map((r) => r.id)).toEqual(["r", "u"]);
  });
  it("a recertification reads Re-review; an ordinary review keeps its status", () => {
    expect(rowStatus(recert[0]!)).toEqual({ label: "Re-review", tone: "warn" });
    expect(rowStatus(recert[1]!)).toEqual({ label: "Under review", tone: "info" });
  });
  it("links the registration screen in resubmit mode", () => {
    expect(resubmitPath("abc")).toBe("/admin/governance/intake?resubmit=abc");
  });
});

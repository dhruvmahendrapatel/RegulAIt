import { describe, expect, it } from "vitest";
import { licensingTabFrom, licensingTabLabel, type LicensingTabStatus } from "./licensingTabs";

const allow = { allowed: true };
const ok: LicensingTabStatus = {
  seats: { remaining: 7, canProvision: true },
  actionClasses: { read: allow, governance: allow, expansion: allow },
  schedulerPresent: true,
};

describe("Licensing tab labels", () => {
  it("show only the name while loading and when nothing is unresolved", () => {
    for (const id of ["classes", "seats", "features", "install", "history"] as const) {
      expect(licensingTabLabel(id, { status: undefined, refusedVerifications: null })).not.toContain("·");
      expect(licensingTabLabel(id, { status: ok, refusedVerifications: 0 })).not.toContain("·");
    }
  });

  it("count refused action classes", () => {
    const s = { ...ok, actionClasses: { ...ok.actionClasses, expansion: { allowed: false } } };
    expect(licensingTabLabel("classes", { status: s, refusedVerifications: 0 })).toBe("Action classes · 1 refused");
  });

  it("say when no new user can be provisioned, or none remain", () => {
    expect(licensingTabLabel("seats", { status: { ...ok, seats: { remaining: 0, canProvision: false } }, refusedVerifications: 0 })).toBe("Seats · cannot provision");
    expect(licensingTabLabel("seats", { status: { ...ok, seats: { remaining: 0, canProvision: true } }, refusedVerifications: 0 })).toBe("Seats · none remaining");
    expect(licensingTabLabel("seats", { status: { ...ok, seats: { remaining: null, canProvision: true } }, refusedVerifications: 0 })).toBe("Seats");
  });

  it("warn when no in-process scheduler re-verifies the licence", () => {
    expect(licensingTabLabel("install", { status: { ...ok, schedulerPresent: false }, refusedVerifications: 0 })).toBe("Install and verify · 1 warning");
  });

  it("count refused verifications on the trail", () => {
    expect(licensingTabLabel("history", { status: ok, refusedVerifications: 12 })).toBe("History · 12 refused");
  });

  it("say a failed refused-count read is unavailable, never that nothing was refused", () => {
    expect(licensingTabLabel("history", { status: ok, refusedVerifications: null, refusedCountFailed: true })).toBe(
      "History · refused count unavailable",
    );
  });

  it("open the tab named by ?tab=, and the first tab for a missing or unknown value", () => {
    expect(licensingTabFrom("history")).toBe("history");
    expect(licensingTabFrom("install")).toBe("install");
    expect(licensingTabFrom(null)).toBe("classes");
    expect(licensingTabFrom("nope")).toBe("classes");
  });
});

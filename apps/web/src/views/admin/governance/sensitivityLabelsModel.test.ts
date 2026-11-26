import { describe, expect, it } from "vitest";
import {
  effectiveAction,
  fallbackChange,
  labelTree,
  loosens,
  removalRelaxes,
  ruleBody,
  ruleDraft,
  ruleRelaxes,
  type LabelSettings,
  type SensitivityLabel,
} from "./sensitivityLabelsModel";

const strict: LabelSettings = { unmappedAction: "block", protectedAction: "block", unreadableAction: "block", strictDefault: true };
const label = (over: Partial<SensitivityLabel> = {}): SensitivityLabel => ({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "microsoft_purview",
  tenantId: "t1",
  labelId: "l-conf",
  name: "Confidential",
  parentLabelId: null,
  rank: 2,
  active: true,
  syncedAt: "2026-11-20T00:00:00Z",
  rule: null,
  ...over,
});
const P = "22222222-2222-4222-8222-222222222222";

describe("sensitivity labels model (ADR-0363)", () => {
  it("orders strictness block > redact > allow", () => {
    expect(loosens("block", "redact")).toBe(true);
    expect(loosens("redact", "allow")).toBe(true);
    expect(loosens("allow", "block")).toBe(false);
    expect(loosens("block", "block")).toBe(false);
  });

  it("a fallback change sends only what changed, and flags a loosening", () => {
    expect(fallbackChange(strict, { unmappedAction: "block", protectedAction: "block", unreadableAction: "block" })).toEqual({ changed: {}, relaxes: false });
    expect(fallbackChange(strict, { unmappedAction: "redact", protectedAction: "block", unreadableAction: "block" })).toEqual({ changed: { unmappedAction: "redact" }, relaxes: true });
    const loose = { ...strict, protectedAction: "allow" as const, strictDefault: false };
    expect(fallbackChange(loose, { unmappedAction: "block", protectedAction: "block", unreadableAction: "block" })).toEqual({ changed: { protectedAction: "block" }, relaxes: false });
  });

  it("a new mapping starts at the strictest choice; an existing one where it is", () => {
    expect(ruleDraft(label())).toEqual({ action: "block", sensitivity: "restricted", complianceProfileId: "" });
    expect(ruleDraft(label({ rule: { action: "redact", sensitivity: "internal", complianceProfileId: P } }))).toEqual({ action: "redact", sensitivity: "internal", complianceProfileId: P });
    expect(ruleBody({ action: "allow", sensitivity: "public", complianceProfileId: "" })).toEqual({ action: "allow", sensitivity: "public", complianceProfileId: null });
  });

  it("a mapping relaxes by the gateway's rule: looser action, lower sensitivity, or a dropped or swapped profile", () => {
    // a new mapping is compared with the unmapped fallback and with "restricted"
    expect(ruleRelaxes(label(), strict, { action: "block", sensitivity: "restricted", complianceProfileId: "" })).toBe(false);
    expect(ruleRelaxes(label(), strict, { action: "redact", sensitivity: "restricted", complianceProfileId: "" })).toBe(true);
    expect(ruleRelaxes(label(), strict, { action: "block", sensitivity: "confidential", complianceProfileId: "" })).toBe(true);
    const mapped = label({ rule: { action: "redact", sensitivity: "confidential", complianceProfileId: P } });
    expect(ruleRelaxes(mapped, strict, { action: "block", sensitivity: "confidential", complianceProfileId: P })).toBe(false);
    expect(ruleRelaxes(mapped, strict, { action: "allow", sensitivity: "confidential", complianceProfileId: P })).toBe(true);
    expect(ruleRelaxes(mapped, strict, { action: "redact", sensitivity: "internal", complianceProfileId: P })).toBe(true);
    expect(ruleRelaxes(mapped, strict, { action: "redact", sensitivity: "confidential", complianceProfileId: "" })).toBe(true);
    // adding a profile only tightens
    expect(ruleRelaxes(label({ rule: { action: "redact", sensitivity: "confidential", complianceProfileId: null } }), strict, { action: "redact", sensitivity: "confidential", complianceProfileId: P })).toBe(false);
  });

  it("removing a mapping relaxes when the fallback is looser or a profile is lost", () => {
    expect(removalRelaxes(label(), strict)).toBe(false);
    expect(removalRelaxes(label({ rule: { action: "block", sensitivity: "restricted", complianceProfileId: null } }), strict)).toBe(false);
    expect(removalRelaxes(label({ rule: { action: "block", sensitivity: "restricted", complianceProfileId: null } }), { ...strict, unmappedAction: "allow" })).toBe(true);
    expect(removalRelaxes(label({ rule: { action: "allow", sensitivity: "public", complianceProfileId: P } }), strict)).toBe(true);
  });

  it("an unmapped label follows the unmapped fallback", () => {
    expect(effectiveAction(label(), { ...strict, unmappedAction: "redact" })).toBe("redact");
    expect(effectiveAction(label({ rule: { action: "allow", sensitivity: "public", complianceProfileId: null } }), strict)).toBe("allow");
  });

  it("lists parents before their children; an orphan stays top level", () => {
    const parent = label({ id: "p", labelId: "L1", name: "Confidential" });
    const child = label({ id: "c", labelId: "L2", name: "Finance", parentLabelId: "L1" });
    const orphan = label({ id: "o", labelId: "L3", name: "Orphan", parentLabelId: "missing" });
    expect(labelTree([child, orphan, parent]).map((r) => [r.label.id, r.depth, r.parentName])).toEqual([
      ["o", 0, null],
      ["p", 0, null],
      ["c", 1, "Confidential"],
    ]);
  });
});

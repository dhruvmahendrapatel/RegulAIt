import { describe, expect, it } from "vitest";
import { blankRole, draftFrom, policyBody, policyHasErrors, removeRole, slugify, validatePolicy } from "./reviewPolicy";

const saved = {
  roles: [
    { id: "privacy", name: "Privacy", memberUserIds: ["u1"] },
    { id: "security", name: "Security", memberUserIds: ["u2", "u3"] },
  ],
  tiers: { high: { roleIds: ["privacy", "security"], validityMonths: 6 }, limited: { roleIds: ["security", "gone"], validityMonths: 12 } },
  riskAcceptorUserIds: ["u9"],
  updatedAt: null,
  updatedByName: null,
};

describe("review policy model", () => {
  it("slugs a role name into an id the gateway accepts", () => {
    expect(slugify("Model risk")).toBe("model-risk");
    expect(slugify("  Légal & Compliance!! ")).toBe("legal-compliance");
    expect(slugify("x".repeat(60))).toHaveLength(40);
    expect(slugify("--")).toBe("");
  });

  it("round-trips a saved policy without changing it (unknown role ids on a tier are dropped)", () => {
    expect(policyBody(draftFrom(saved))).toEqual({
      roles: saved.roles,
      tiers: { high: { roleIds: ["privacy", "security"], validityMonths: 6 }, limited: { roleIds: ["security"], validityMonths: 12 } },
      riskAcceptorUserIds: ["u9"],
    });
  });

  it("an empty policy loads and saves as empty — every tier keeps the single named approver", () => {
    const draft = draftFrom({});
    expect(policyBody(draft)).toEqual({ roles: [], tiers: {}, riskAcceptorUserIds: [] });
    expect(policyHasErrors(validatePolicy(draft))).toBe(false);
  });

  it("a new role takes its id from its name; a tier with roles but no lifetime gets the default", () => {
    const draft = draftFrom({});
    const role = { ...blankRole(), name: "Model risk", memberUserIds: ["u4"] };
    draft.roles.push(role);
    draft.tiers.minimal.roleKeys.push(role.key);
    draft.tiers.unscreened.validity = "3";
    expect(policyBody(draft)).toEqual({
      roles: [{ id: "model-risk", name: "Model risk", memberUserIds: ["u4"] }],
      tiers: { minimal: { roleIds: ["model-risk"], validityMonths: 12 }, unscreened: { roleIds: [], validityMonths: 3 } },
      riskAcceptorUserIds: [],
    });
  });

  it("refuses what the gateway would: no name, a duplicate, a required role with no members, a lifetime outside 1..36", () => {
    const draft = draftFrom(saved);
    const nameless = blankRole();
    const dup = { ...blankRole(), name: "privacy" };
    const empty = { ...blankRole(), name: "Legal" };
    draft.roles.push(nameless, dup, empty);
    draft.tiers.high.roleKeys.push(empty.key);
    draft.tiers.limited.roleKeys.push(empty.key);
    draft.tiers.minimal.validity = "37";
    draft.tiers.limited.validity = "1.5";
    draft.tiers.high.validity = "36";
    const errors = validatePolicy(draft);
    expect(errors.roles[nameless.key]).toEqual({ name: "Name the role." });
    expect(errors.roles[dup.key]).toEqual({ name: "Another role already has this name." });
    expect(errors.roles[empty.key]).toEqual({ members: "Add at least one member: the limited and high tiers require this review." });
    expect(errors.tiers).toEqual({ minimal: "Enter whole months from 1 to 36.", limited: "Enter whole months from 1 to 36." });
    expect(policyHasErrors(errors)).toBe(true);
    // control: the saved policy itself is valid
    expect(policyHasErrors(validatePolicy(draftFrom(saved)))).toBe(false);
  });

  it("removing a role takes it off every tier", () => {
    const draft = removeRole(draftFrom(saved), "privacy");
    expect(policyBody(draft).tiers.high).toEqual({ roleIds: ["security"], validityMonths: 6 });
    expect(policyBody(draft).roles.map((r) => r.id)).toEqual(["security"]);
  });
});

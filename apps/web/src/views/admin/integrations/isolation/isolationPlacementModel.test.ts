/**
 * ADR-0190 slice I2: the readers the live profiles and placements cards and
 * the execution profile selector use. Anything malformed is unreadable or
 * unmeasured, never a default and never silently dropped.
 */
import { describe, expect, it } from "vitest";
import {
  assignableProfiles,
  parseAssignment,
  parsePlacements,
  parseProfiles,
  parseProfileVersion,
  profileText,
  refusalText,
  REQUIRED_BY_TEXT,
  REFUSAL_TEXT,
  MISMATCH_TEXT,
} from "./isolationModel";

const at = "2026-10-12T10:00:00.000Z";
const profile = (over: Record<string, unknown> = {}) => ({
  id: "8d4b1f8e-0000-4000-8000-000000000001",
  name: "restricted",
  version: 1,
  digest: "9".repeat(64),
  minClass: "user_space_kernel",
  shipped: true,
  retiredAt: null,
  createdAt: at,
  relaxations: [],
  ...over,
});

describe("execution profiles", () => {
  it("reads a version; a malformed row is unreadable, a malformed envelope is null", () => {
    expect(parseProfileVersion(profile())).toMatchObject({ name: "restricted", version: 1, minClass: "user_space_kernel", retiredAt: null });
    expect(parseProfileVersion(profile({ minClass: "in_gateway" }))).toBeNull();
    expect(parseProfileVersion(profile({ version: 0 }))).toBeNull();
    expect(parseProfileVersion(profile({ relaxations: [1] }))).toBeNull();
    expect(parseProfileVersion(profile({ retiredAt: "yesterday" }))).toBeNull();
    const list = parseProfiles({ profiles: [profile(), { name: "broken" }] })!;
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ unreadable: true, index: 1 });
    for (const bad of [null, {}, { profiles: "x" }, [], 0]) expect(parseProfiles(bad)).toBeNull();
  });

  it("only live versions are assignable; the label names the class, never calling L1 a sandbox", () => {
    const list = parseProfiles({ profiles: [profile(), profile({ id: "r", name: "old", retiredAt: at }), { bad: true }] })!;
    expect(assignableProfiles(list).map((p) => p.name)).toEqual(["restricted"]);
    expect(profileText(parseProfileVersion(profile({ minClass: "hardened_container" }))!)).toBe("restricted v1 · L1 · Hardened container");
  });
});

describe("assignments", () => {
  it("reads the profile in force; any inconsistency is unmeasured, never the default", () => {
    expect(parseAssignment({ assigned: null, effective: profile(), source: "shipped_default" })).toMatchObject({ source: "shipped_default", assigned: null });
    const custom = profile({ id: "c", name: "strict", shipped: false, minClass: "microvm" });
    expect(parseAssignment({ assigned: custom, effective: custom, source: "assigned" })?.assigned?.name).toBe("strict");
    expect(parseAssignment({ assigned: null, effective: profile(), source: "assigned" })).toBeNull();
    expect(parseAssignment({ assigned: custom, effective: custom, source: "shipped_default" })).toBeNull();
    expect(parseAssignment({ assigned: { id: 1 }, effective: profile(), source: "assigned" })).toBeNull();
    expect(parseAssignment({ assigned: null, effective: null, source: "shipped_default" })).toBeNull();
    expect(parseAssignment(null)).toBeNull();
  });
});

describe("placements", () => {
  const placed = { id: "p1", workloadKind: "mcp_stdio", requiredClass: "user_space_kernel", requiredBy: "workload_kind", outcome: "placed", refusalCode: null, appliedClass: "microvm", executorName: "kata-a", profileName: "restricted", profileVersion: 1, createdAt: at };
  const refused = { ...placed, id: "p2", outcome: "refused", refusalCode: "class_below_required", appliedClass: null, executorName: null, requiredClass: "microvm", requiredBy: "data_sensitivity" };

  it("reads placements and the refusals that have no placement row; malformed rows are unreadable", () => {
    const out = parsePlacements({
      placements: [placed, refused, { ...placed, appliedClass: null }, { ...refused, refusalCode: null }],
      refusalsWithoutPlacement: [{ auditId: "a1", at, code: "policy_unresolved", unresolvedFact: "sensitivity" }, { at }],
    })!;
    expect(out.placements[0]).toMatchObject({ outcome: "placed", appliedClass: "microvm" });
    expect(out.placements[1]).toMatchObject({ outcome: "refused", refusalCode: "class_below_required", requiredBy: "data_sensitivity" });
    // a placement that names no class, or a refusal that names no reason, is not evidence
    expect(out.placements[2]).toEqual({ unreadable: true, index: 2 });
    expect(out.placements[3]).toEqual({ unreadable: true, index: 3 });
    expect(out.unrecorded[0]).toMatchObject({ code: "policy_unresolved", unresolvedFact: "sensitivity" });
    expect(out.unrecorded[1]).toEqual({ unreadable: true, index: 1 });
    for (const bad of [null, {}, { placements: [] }, { placements: {}, refusalsWithoutPlacement: [] }]) expect(parsePlacements(bad)).toBeNull();
  });

  it("names every floor and every reason in words", () => {
    for (const source of ["workload_kind", "data_sensitivity", "compliance_tag", "autonomy_class", "configured_profile", "unknown_agent", "parent_grant"])
      expect(REQUIRED_BY_TEXT[source]).toBeTruthy();
    for (const code of Object.keys(REFUSAL_TEXT)) expect(refusalText(code)).toBe(REFUSAL_TEXT[code as keyof typeof REFUSAL_TEXT]);
    expect(refusalText("execution_profile_mismatch")).toBe(MISMATCH_TEXT);
    expect(refusalText("something_else")).toBe("Reason not reported.");
    expect(refusalText(null)).toBe("Reason not reported.");
  });

  it("the required-by vocabulary matches @regulait/shared", async () => {
    // runtime-only import: the SPA does not depend on @regulait/shared
    const sharedPath = new URL("../../../../../../../packages/shared/src/isolation/index.ts", import.meta.url).pathname;
    const shared = (await import(/* @vite-ignore */ sharedPath)) as { REQUIRED_CLASS_SOURCES: readonly string[] };
    expect(Object.keys(REQUIRED_BY_TEXT).sort()).toEqual([...shared.REQUIRED_CLASS_SOURCES].sort());
  });
});

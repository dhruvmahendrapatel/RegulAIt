/**
 * ADR-0190 slice I2: the readers the live profiles and placements cards and
 * the execution profile selector use. Anything malformed is unreadable or
 * unmeasured, never a default and never silently dropped.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assignableProfiles,
  parseAssignment,
  parsePlacements,
  placementsPageUrl,
  parseProfiles,
  parseProfileVersion,
  profileText,
  refusalText,
  REQUIRED_BY_TEXT,
  REFUSAL_TEXT,
  MISMATCH_TEXT,
  newProfileBody,
  profileNameOk,
  versionBody,
  parseWorkerIdentities,
  parsePlacementDetail,
  IDENTITY_PICKER_MAX,
  ATTESTATION_STRENGTHS,
  strengthText,
} from "./isolationModel";

const sharedFile = (rel: string) => new URL(`../../../../../../../packages/shared/src/${rel}`, import.meta.url).pathname;

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

describe("a new profile", () => {
  it("copies the base body, renamed at the chosen class; a name outside the pattern is refused before any request", () => {
    expect(newProfileBody({ name: "restricted", minClass: "user_space_kernel", secrets: "none" }, "team-a", "microvm")).toEqual({ name: "team-a", minClass: "microvm", secrets: "none" });
    expect(newProfileBody(null, "team-a", "microvm")).toBeNull();
    expect(newProfileBody([], "team-a", "microvm")).toBeNull();
    expect(versionBody({ versions: [{ id: "a", body: { x: 1 } }] }, "a")).toEqual({ x: 1 });
    expect(versionBody({ versions: [{ id: "a", body: { x: 1 } }] }, "b")).toBeNull();
    expect(versionBody({}, "a")).toBeNull();
    for (const ok of ["ab", "team-new", "a1"]) expect(profileNameOk(ok)).toBe(true);
    for (const bad of ["a", "Team", "1ab", "team_new", "a".repeat(64), ""]) expect(profileNameOk(bad)).toBe(false);
  });
});

describe("worker identities for registering an executor (ADR-0188 S6 picker sources)", () => {
  it("offers only well-formed options; an unreadable answer is null, never an empty list", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseWorkerIdentities({ workerIdentities: [{ id, label: "spiffe://x/w" }, { id: "nope", label: "y" }, { id }], truncated: false })).toEqual({
      options: [{ id, label: "spiffe://x/w" }],
      truncated: false,
    });
    expect(parseWorkerIdentities({ workerIdentities: [] })).toEqual({ options: [], truncated: false });
    for (const bad of [null, {}, { workerIdentities: "x" }, []]) expect(parseWorkerIdentities(bad)).toBeNull();
  });
  it("the gateway's truncated flag is one for every list: it marks THIS list cut only when this list is at the cap", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    // another list was cut; this short one was not
    expect(parseWorkerIdentities({ workerIdentities: [{ id, label: "spiffe://x/w" }], truncated: true })?.truncated).toBe(false);
    const full = Array.from({ length: IDENTITY_PICKER_MAX }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, label: `spiffe://x/w${i}` }));
    expect(parseWorkerIdentities({ workerIdentities: full, truncated: true })?.truncated).toBe(true);
    expect(parseWorkerIdentities({ workerIdentities: full, truncated: false })?.truncated).toBe(false);
  });
  it("the gateway's per-list flag decides exactly: this list is cut only when the gateway names it", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const one = [{ id, label: "spiffe://x/w" }];
    expect(parseWorkerIdentities({ workerIdentities: one, truncated: true, truncatedLists: ["workerIdentities"] })?.truncated).toBe(true);
    expect(parseWorkerIdentities({ workerIdentities: one, truncated: true, truncatedLists: ["roles"] })?.truncated).toBe(false);
    expect(parseWorkerIdentities({ workerIdentities: one, truncated: false, truncatedLists: [] })?.truncated).toBe(false);
  });
  it("the cap is the shared contract's", () => {
    const src = readFileSync(sharedFile("identity/contract.ts"), "utf8");
    expect(/export const IDENTITY_PICKER_MAX = (\d+);/.exec(src)?.[1]).toBe(String(IDENTITY_PICKER_MAX));
  });
});

describe("one placement's evidence", () => {
  it("reads the audit row, the report hash and the attestation strength; a body without an id is null", () => {
    expect(
      parsePlacementDetail({ id: "p", reportSha256: "a".repeat(64), attestationStrength: "software_attested", audit: { id: "x", ruleId: "execution-placed", reason: "placed" } }),
    ).toEqual({
      id: "p",
      auditId: "x",
      auditRuleId: "execution-placed",
      auditReason: "placed",
      report: { kind: "hash", sha256: "a".repeat(64) },
      attestationStrength: "software_attested",
    });
    for (const bad of [null, {}, [], { id: 1 }]) expect(parsePlacementDetail(bad)).toBeNull();
  });
  it("no report is 'none'; a malformed hash is unreadable, never 'none'", () => {
    expect(parsePlacementDetail({ id: "p", reportSha256: null, audit: null })).toMatchObject({ auditId: null, report: { kind: "none" } });
    for (const bad of ["zz", "A".repeat(64), 7, undefined]) expect(parsePlacementDetail({ id: "p", reportSha256: bad })?.report).toEqual({ kind: "unreadable" });
  });
  it("the strength is the gateway's word: missing or unknown is said, never assumed", () => {
    expect(parsePlacementDetail({ id: "p", reportSha256: null })?.attestationStrength).toBeNull();
    expect(parsePlacementDetail({ id: "p", reportSha256: null, attestationStrength: "hardware_attested" })?.attestationStrength).toBeNull();
    expect(strengthText("software_attested")).toBe("software-attested");
    expect(strengthText(null)).toBe("attestation strength not reported");
    const src = readFileSync(sharedFile("isolation/contract.ts"), "utf8");
    expect(/export const ATTESTATION_STRENGTH = "([a-z_]+)" as const;/.exec(src)?.[1]).toBe(ATTESTATION_STRENGTHS[0]);
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

  it("N11: reads each list's keyset cursor, and a next page carries only the cursors it has", () => {
    const out = parsePlacements({ placements: [placed], refusalsWithoutPlacement: [], nextCursor: "c1", refusalsNextCursor: null })!;
    expect(out).toMatchObject({ nextCursor: "c1", refusalsNextCursor: null });
    // a cursor that is not a short string ends paging rather than being guessed at
    for (const bad of [42, "", "x".repeat(257), {}]) expect(parsePlacements({ placements: [], refusalsWithoutPlacement: [], nextCursor: bad })!.nextCursor).toBeNull();
    expect(placementsPageUrl(null)).toBe("/v1/execution-placements?limit=50");
    expect(placementsPageUrl({ cursor: "c1", refusalsCursor: null })).toBe("/v1/execution-placements?limit=50&cursor=c1");
    expect(placementsPageUrl({ cursor: null, refusalsCursor: "r 1" })).toBe("/v1/execution-placements?limit=50&refusalsCursor=r+1");
  });

  it("I4: a governed stdio call's placement offered and awaiting its report reads as offered, with the class it was offered at", () => {
    const out = parsePlacements({ placements: [{ ...placed, outcome: "offered" }, { ...placed, outcome: "offered", appliedClass: null }], refusalsWithoutPlacement: [] })!;
    expect(out.placements[0]).toMatchObject({ outcome: "offered", appliedClass: "microvm" });
    expect(out.placements[1]).toEqual({ unreadable: true, index: 1 });
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

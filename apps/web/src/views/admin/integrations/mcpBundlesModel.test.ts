import { describe, expect, it } from "vitest";
import { diffItems, grantBody, holderOf, refusalCode, TIERS, tierLabel, toggleItem, type BundleGrant } from "./mcpBundlesModel";

const S1 = "a1111111-1111-4111-8111-111111111111";
const S2 = "a2222222-2222-4222-8222-222222222222";

describe("mcp bundles model", () => {
  it("toggles an item in and out by server and tool", () => {
    const one = toggleItem([], { serverId: S1, toolName: "read_file" });
    expect(one).toEqual([{ serverId: S1, toolName: "read_file" }]);
    // the same tool name on another server is a different item
    expect(toggleItem(one, { serverId: S2, toolName: "read_file" })).toHaveLength(2);
    expect(toggleItem(one, { serverId: S1, toolName: "read_file" })).toEqual([]);
  });

  it("diffs a draft against the current version", () => {
    const before = [{ serverId: S1, toolName: "a" }, { serverId: S1, toolName: "b" }];
    expect(diffItems(before, [{ serverId: S1, toolName: "b" }, { serverId: S2, toolName: "c" }, { serverId: S2, toolName: "d" }])).toEqual({ added: 2, removed: 1 });
    expect(diffItems(before, [...before].reverse())).toEqual({ added: 0, removed: 0 });
  });

  it("names a holder and builds a grant body with exactly one subject", () => {
    const g = { id: "g", userId: null, userEmail: null, roleId: "r", roleName: "Reviewers", teamId: null, teamName: null, maxTier: "read", grantedBy: null, createdAt: "" } satisfies BundleGrant;
    expect(holderOf(g)).toEqual({ kind: "role", label: "Reviewers" });
    expect(holderOf({ ...g, roleId: null, userId: "u", userEmail: "ada@example.test" })).toEqual({ kind: "user", label: "ada@example.test" });
    expect(grantBody("team", "t1", "read")).toEqual({ teamId: "t1", maxTier: "read" });
  });

  it("lists read first, so the grant form preselects the narrowest tier", () => {
    expect(TIERS[0]!.v).toBe("read");
    expect(tierLabel("dangerous")).toBe("All tools, dangerous ones with approval");
  });

  it("reads the refusal code from an API error", () => {
    expect(refusalCode({ payload: { error: "version_conflict" } })).toBe("version_conflict");
    expect(refusalCode(new Error("x"))).toBeNull();
    expect(refusalCode(null)).toBeNull();
  });
});

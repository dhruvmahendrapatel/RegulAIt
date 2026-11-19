import { describe, expect, it } from "vitest";
import { canDo, cancellable, entitlementPlatformOf, linkCounts, removalBody, removalsUrl, shownCounts, type LifecycleView, type TargetCounts } from "./discoverySubpagesModel";

const lc = (allowed: Record<string, boolean>): LifecycleView =>
  ({ machine: "m", state: "s", terminal: false, transitions: Object.entries(allowed).map(([event, ok]) => ({ event, to: "x", by: ["admin"], summary: "", allowed: ok })) }) as LifecycleView;

describe("Discovery sub-pages model", () => {
  it("offers a link action only when the gateway's machine allows it", () => {
    expect(canDo({ lifecycle: lc({ link: true, unlink: false }) } as never, "link")).toBe(true);
    expect(canDo({ lifecycle: lc({ link: true, unlink: false }) } as never, "unlink")).toBe(false);
  });
  it("names the platform of an entitlement source kind, and nothing else", () => {
    expect(entitlementPlatformOf("entitlement_slack")).toBe("slack");
    expect(entitlementPlatformOf("endpoint_agent")).toBeNull();
    expect(entitlementPlatformOf("constructor")).toBeNull();
  });
  it("counts link states", () => {
    expect(linkCounts([{ agentLinkState: "none" }, { agentLinkState: "auto" }, { agentLinkState: "none" }])).toEqual({ total: 3, auto: 1, admin: 0, none: 2, unlinked: 0 });
  });
  it("builds the removal body as the gateway's strict schema takes it", () => {
    const b = removalBody({ identityKind: "package", identity: "acme", packageVersion: null, serverName: "(unnamed)", scope: { kind: "recent", days: 7 }, blockReinstall: true, approverUserId: "u2", reason: "  why  " });
    expect(b).toEqual({ identityKind: "package", identity: "acme", scope: { kind: "recent", days: 7 }, blockReinstall: true, approverUserId: "u2", reason: "why" });
  });
  it("cancels only what the machine allows and never an expired removal", () => {
    expect(cancellable({ state: "active", lifecycle: lc({ cancel: true }) })).toBe(true);
    expect(cancellable({ state: "expired", lifecycle: lc({ cancel: true }) })).toBe(false);
    expect(cancellable({ state: "cancelled", lifecycle: lc({ cancel: false }) })).toBe(false);
  });
  it("shows the non-zero target counts in a fixed order", () => {
    const c: TargetCounts = { pending: 2, delivered: 0, removed: 5, nothing_to_remove: 0, failed: 1, cancelled: 0, total: 8 };
    expect(shownCounts(c)).toEqual([["removed", 5], ["failed", 1], ["pending", 2]]);
  });
  it("asks for the exact total on the first page only", () => {
    expect(removalsUrl(null)).toContain("count=exact");
    expect(removalsUrl("abc")).not.toContain("count=");
  });
});

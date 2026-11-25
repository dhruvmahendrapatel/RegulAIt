import { describe, expect, it } from "vitest";
import { allowedGatewayOrigin, BLOCK_RECORD_WINDOW_MS, BlockRecordGate, parseGatewayOrigin, pinnedGatewayOrigin } from "../src/guards.js";
import { buildManifest, hostPatterns } from "../src/manifest.js";

describe("#1029 the pinned gateway origin", () => {
  it("accepts only an https origin with no path, query, fragment or user", () => {
    expect(parseGatewayOrigin("https://gateway.example.com")).toBe("https://gateway.example.com");
    expect(parseGatewayOrigin("https://gateway.example.com/")).toBe("https://gateway.example.com");
    expect(parseGatewayOrigin("https://gateway.example.com:8443")).toBe("https://gateway.example.com:8443");
    for (const bad of ["http://gateway.example.com", "https://gateway.example.com/v1", "https://gateway.example.com?a=1", "https://u:p@gateway.example.com", "https://*.example.com", "gateway.example.com", "", "https://GATEWAY.example.com"]) {
      expect(() => parseGatewayOrigin(bad), bad).toThrow(/gateway-origin/);
    }
  });

  it("refuses every managed gatewayUrl but the pinned origin, and everything when none is pinned", () => {
    const pinned = "https://gateway.example.com";
    expect(allowedGatewayOrigin("https://gateway.example.com", pinned)).toBe(pinned);
    expect(allowedGatewayOrigin("https://gateway.example.com/", pinned)).toBe(pinned);
    for (const other of ["https://evil.example.com", "https://gateway.example.com.evil.test", "http://gateway.example.com", "https://gateway.example.com:444", "https://gateway.example.com/x", "not a url"]) {
      expect(allowedGatewayOrigin(other, pinned), other).toBeNull();
    }
    expect(allowedGatewayOrigin("https://gateway.example.com", "")).toBeNull();
    // under test nothing is defined at build time: the strict default
    expect(pinnedGatewayOrigin()).toBe("");
  });

  it("the pinned origin is a host permission for the worker only, never a content-script or web-accessible match", () => {
    const m = buildManifest("1.0.0", undefined, "https://gateway.example.com") as Record<string, any>;
    expect(m.host_permissions).toEqual([...hostPatterns(), "https://gateway.example.com/*"]);
    expect(m.content_scripts[0].matches).toEqual(hostPatterns());
    expect(m.web_accessible_resources[0].matches).toEqual(hostPatterns());
    expect((buildManifest("1.0.0") as Record<string, any>).host_permissions).toEqual(hostPatterns());
  });
});

describe("#1031 block-page records", () => {
  const block = { effect: "block", code: "site_denied" } as const;

  it("records only a block the current verdict applies, from a top-level frame", () => {
    const g = new BlockRecordGate();
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: { effect: "allow" }, frameId: 0, nowMs: 0 })).toBe(false);
    expect(g.accept({ siteId: "a", code: "no_site_rule", verdict: block, frameId: 0, nowMs: 0 })).toBe(false);
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: block, frameId: 3, nowMs: 0 })).toBe(false);
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: block, frameId: undefined, nowMs: 0 })).toBe(false);
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: block, frameId: 0, nowMs: 0 })).toBe(true);
  });

  it("keeps at most one record per site and code a minute", () => {
    const g = new BlockRecordGate();
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: block, frameId: 0, nowMs: 1_000 })).toBe(true);
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: block, frameId: 0, nowMs: 2_000 })).toBe(false);
    expect(g.accept({ siteId: "b", code: "site_denied", verdict: block, frameId: 0, nowMs: 2_000 })).toBe(true);
    expect(g.accept({ siteId: "a", code: "site_denied", verdict: block, frameId: 0, nowMs: 1_000 + BLOCK_RECORD_WINDOW_MS })).toBe(true);
  });
});

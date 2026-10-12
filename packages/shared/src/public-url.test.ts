/**
 * ADR-0188 S7 (review of #380): REGULAIT_PUBLIC_URL parsed ONE way, by the gateway and by engine runners. The
 * gateway's own suite (apps/gateway/src/public-url.test.ts) pins the same cases through its re-export.
 */
import { describe, expect, it } from "vitest";
import { isLoopbackHost, parsePublicUrl, PublicUrlBootError } from "./public-url.js";

describe("parsePublicUrl", () => {
  it("normalises as the WHATWG URL parser does: lowercased host, no default port, no trailing slashes", () => {
    expect(parsePublicUrl(undefined)).toBeNull();
    expect(parsePublicUrl("  ")).toBeNull();
    expect(parsePublicUrl("https://Host.Example:443")).toBe("https://host.example");
    expect(parsePublicUrl("https://Host.Example:443/Base//")).toBe("https://host.example/Base");
    expect(parsePublicUrl("https://acme.example:8443/gov/regulait/")).toBe("https://acme.example:8443/gov/regulait");
    expect(parsePublicUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parsePublicUrl("http://127.0.0.1:3105")).toBe("http://127.0.0.1:3105");
  });

  it("refuses what the gateway refuses, by reason", () => {
    const bad: Array<[string, RegExp]> = [
      ["regulait.acme.example", /not an absolute URL/],
      ["http://regulait.acme.example", /https/],
      ["https://user:pw@regulait.acme.example", /credentials/],
      ["https://:@regulait.acme.example", /credentials/],
      ["https://regulait.acme.example/?next=evil", /query/],
      ["https://regulait.acme.example/#x", /fragment/],
      ["https://regulait.acme.example/a b", /base path/],
      ["https://regulait.acme.example.", /dot/],
      ["https://regulait.acme.example/gov/../x", /'\.' or '\.\.'/],
      ["https://regulait.acme.example/gov/%2e%2e", /'\.' or '\.\.'/],
    ];
    for (const [value, why] of bad) {
      expect(() => parsePublicUrl(value), value).toThrow(PublicUrlBootError);
      expect(() => parsePublicUrl(value), value).toThrow(why);
    }
  });

  it("trims a long run of trailing slashes in linear time (no repeating regex: CodeQL js/polynomial-redos)", () => {
    const started = Date.now();
    expect(parsePublicUrl(`https://host.example/base${"/".repeat(200_000)}`)).toBe("https://host.example/base");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("loopback hosts", () => {
    for (const h of ["localhost", "a.localhost", "127.0.0.1", "127.1.2.3", "[::1]"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["gateway", "127.0.0.1.example", "10.0.0.1", "1270.0.0.1"]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

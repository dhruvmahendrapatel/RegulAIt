/**
 * ADR-0039 — unit proof for the CIDR matcher, the fail-closed envelope
 * evaluation, and the (non-authoritative) device label. Pure functions, no
 * database: the load-bearing assertions are the fail-closed ones — malformed
 * CIDR matches NOTHING, an unknowable client IP under a non-empty envelope is
 * DENIED, and only an empty/null allow-list means "no restriction".
 */
import { describe, expect, it } from "vitest";
import { cidrContains, evaluateIpEnvelope, isValidCidr, parseCidr } from "./net-policy.js";
import { deviceLabel } from "./device-label.js";

describe("ADR-0039: IPv4 CIDR matching", () => {
  it("matches inside the prefix and refuses outside it", () => {
    expect(cidrContains("10.0.0.0/8", "10.1.2.3")).toBe(true);
    expect(cidrContains("10.0.0.0/8", "11.0.0.0")).toBe(false);
    expect(cidrContains("192.168.1.0/24", "192.168.1.255")).toBe(true);
    expect(cidrContains("192.168.1.0/24", "192.168.2.1")).toBe(false);
  });

  it("handles non-octet-aligned prefixes at the exact boundary", () => {
    expect(cidrContains("172.16.0.0/12", "172.16.0.1")).toBe(true);
    expect(cidrContains("172.16.0.0/12", "172.31.255.255")).toBe(true);
    expect(cidrContains("172.16.0.0/12", "172.32.0.0")).toBe(false);
    expect(cidrContains("172.16.0.0/12", "172.15.255.255")).toBe(false);
  });

  it("a bare address is an implicit /32; /0 matches everything", () => {
    expect(cidrContains("192.168.1.5", "192.168.1.5")).toBe(true);
    expect(cidrContains("192.168.1.5", "192.168.1.6")).toBe(false);
    expect(cidrContains("0.0.0.0/0", "203.0.113.9")).toBe(true);
  });
});

describe("ADR-0039: IPv6 CIDR matching", () => {
  it("matches compressed and expanded forms inside the prefix", () => {
    expect(cidrContains("2001:db8::/32", "2001:db8:1::1")).toBe(true);
    expect(cidrContains("2001:db8::/32", "2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(true);
    expect(cidrContains("2001:db8::/32", "2001:db9::1")).toBe(false);
    expect(cidrContains("::1/128", "::1")).toBe(true);
    expect(cidrContains("::1/128", "::2")).toBe(false);
    expect(cidrContains("fe80::/10", "fe80::abcd")).toBe(true);
  });

  it("an IPv4-mapped IPv6 client matches a plain IPv4 CIDR (dual-stack sockets)", () => {
    expect(cidrContains("127.0.0.0/8", "::ffff:127.0.0.1")).toBe(true);
    expect(cidrContains("127.0.0.0/8", "::ffff:7f00:1")).toBe(true);
    expect(cidrContains("10.0.0.0/8", "::ffff:11.0.0.1")).toBe(false);
  });

  it("ADR-0176: only the IPv4-MAPPED form is unwrapped — this is an allow-list, so the other v4-carrying forms are not", () => {
    // a dual-stack socket reports a v4 peer as ::ffff:a.b.c.d and nothing else;
    // unwrapping 6to4 / IPv4-compatible / NAT64 would WIDEN the envelope
    expect(cidrContains("10.0.0.0/8", "::a00:1")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "::10.0.0.1")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "2002:a00:1::")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "64:ff9b::a00:1")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "::ffff:10.0.0.1")).toBe(true);
    // and an IPv6 CIDR never admits a plain IPv4 client
    expect(cidrContains("::ffff:0:0/96", "10.0.0.1")).toBe(false);
    expect(cidrContains("::/0", "10.0.0.1")).toBe(false);
  });

  it("never matches across address families on a plain (unmapped) address", () => {
    expect(cidrContains("10.0.0.0/8", "2001:db8::1")).toBe(false);
    expect(cidrContains("2001:db8::/32", "10.1.2.3")).toBe(false);
  });
});

describe("ADR-0039: malformed input fails CLOSED (matches nothing)", () => {
  const malformed = [
    "banana",
    "",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0/8/8",
    "300.1.2.3/8",
    "10.0.0/8",
    "2001:db8::/129",
    "2001:zz8::/32",
    "10.0.0.0/abc",
  ];
  it.each(malformed)("'%s' is invalid and contains no address", (cidr) => {
    expect(isValidCidr(cidr)).toBe(false);
    expect(parseCidr(cidr)).toBeNull();
    expect(cidrContains(cidr, "10.0.0.1")).toBe(false);
    expect(cidrContains(cidr, "2001:db8::1")).toBe(false);
  });

  it("an unparseable client IP matches nothing either (never a throw)", () => {
    expect(cidrContains("10.0.0.0/8", "not-an-ip")).toBe(false);
    expect(cidrContains("::/0", "not-an-ip")).toBe(false);
    expect(cidrContains("10.0.0.0/8", "[::ffff:10.0.0.1]")).toBe(false);
  });

  it("valid syntax is accepted for both families", () => {
    for (const good of ["10.0.0.0/8", "0.0.0.0/0", "192.168.1.5", "2001:db8::/32", "::1", "::/0"]) {
      expect(isValidCidr(good)).toBe(true);
    }
  });
});

describe("ADR-0039: envelope evaluation (the fail-closed contract)", () => {
  it("empty/null allow-list = no restriction (the upgrade-safe default)", () => {
    expect(evaluateIpEnvelope(null, "203.0.113.9")).toEqual({ allowed: true, matched: null });
    expect(evaluateIpEnvelope(undefined, null)).toEqual({ allowed: true, matched: null });
    expect(evaluateIpEnvelope([], "203.0.113.9")).toEqual({ allowed: true, matched: null });
  });

  it("a NULL/unknowable client IP under a non-empty envelope is DENIED", () => {
    expect(evaluateIpEnvelope(["0.0.0.0/0"], null)).toEqual({
      allowed: false,
      reason: "no_client_ip",
    });
    expect(evaluateIpEnvelope(["10.0.0.0/8"], undefined)).toEqual({
      allowed: false,
      reason: "no_client_ip",
    });
    expect(evaluateIpEnvelope(["10.0.0.0/8"], "")).toEqual({
      allowed: false,
      reason: "no_client_ip",
    });
  });

  it("names the CIDR that admitted the address; denies outside all of them", () => {
    expect(evaluateIpEnvelope(["10.0.0.0/8", "192.168.0.0/16"], "192.168.7.7")).toEqual({
      allowed: true,
      matched: "192.168.0.0/16",
    });
    expect(evaluateIpEnvelope(["10.0.0.0/8", "192.168.0.0/16"], "203.0.113.9")).toEqual({
      allowed: false,
      reason: "outside_allowlist",
    });
  });

  it("a malformed entry is inert (fails closed for THAT entry) — a valid sibling still admits", () => {
    expect(evaluateIpEnvelope(["999.999.0.0/8", "10.0.0.0/8"], "10.1.1.1")).toEqual({
      allowed: true,
      matched: "10.0.0.0/8",
    });
    // ...and a list of ONLY malformed entries admits nobody
    expect(evaluateIpEnvelope(["999.999.0.0/8"], "10.1.1.1")).toEqual({
      allowed: false,
      reason: "outside_allowlist",
    });
  });
});

describe("ADR-0039: device label (derived, non-authoritative, display only)", () => {
  const CHROME_WIN =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  it.each([
    [CHROME_WIN, "Chrome on Windows"],
    [`${CHROME_WIN} Edg/126.0.0.0`, "Edge on Windows"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "Safari on macOS",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "Safari on iOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
      "Chrome on iOS",
    ],
    ["curl/8.5.0", "curl"],
    ["PostmanRuntime/7.36.0", "Postman"],
  ])("labels '%s' as '%s'", (ua, expected) => {
    expect(deviceLabel(ua)).toBe(expected);
  });

  it("degrades honestly on null/empty/unrecognized agents", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel(undefined)).toBe("Unknown device");
    expect(deviceLabel("   ")).toBe("Unknown device");
    expect(deviceLabel("TotallyMadeUpAgent/1.0")).toBe("Unknown device");
    expect(deviceLabel("SomethingBot (Windows NT 10.0)")).toBe("Unknown browser on Windows");
  });
});

/**
 * ADR-0176 security fix 3 — the IPv6 special ranges the egress guard missed.
 *
 * Each of these used to classify as an ordinary public address, so an allow
 * entry for a host that RESOLVES to one of them reached the IPv4 address it
 * carries (or a range nothing legitimate lives in):
 *   - IPv4-compatible `::a.b.c.d` and 6to4 `2002::/16`: the embedded v4 is
 *     classified (`::a9fe:a9fe` and `2002:a9fe:a9fe::` are the IMDS address);
 *   - IPv4-translated `::ffff:0:a.b.c.d`: likewise;
 *   - local-use NAT64 `64:ff9b:1::/48`, site-local `fec0::/10`, discard-only
 *     `100::/64`: refused outright.
 * The classifier now reads every address with Node's `net.BlockList`, i.e.
 * the same parser the socket uses, so the address it judges is the address
 * that would be dialled. DB-free and network-free, like egress-guard.test.ts.
 */
import { describe, expect, it } from "vitest";
import { checkEgress, classifyAddress, classifyAddressLan, type EgressAllowEntry, type EgressResolver } from "./egress-guard.js";

const allow = (host: string): EgressAllowEntry[] => [{ host, allowPrivateRanges: false, allowPlaintextHttp: true }];
const resolverFor =
  (...addresses: string[]): EgressResolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("classic path: the five missed ranges are blocked", () => {
  const blocked: Array<[string, string]> = [
    ["::a9fe:a9fe", "IMDS"],
    ["::169.254.169.254", "IMDS"],
    ["::a00:1", "RFC1918"],
    ["::7f00:1", "loopback"],
    ["2002:a9fe:a9fe::", "IMDS"],
    ["2002:a9fe:a9fe:1234:5678::1", "IMDS"],
    ["2002:c0a8:0101::1", "RFC1918"],
    ["2002:7f00:1::", "loopback"],
    ["::ffff:0:a9fe:a9fe", "IMDS"],
    ["64:ff9b:1::a9fe:a9fe", "local-use NAT64"],
    ["64:ff9b:1:ffff::1", "local-use NAT64"],
    ["fec0::1", "site-local"],
    ["feff:ffff::1", "site-local"],
    ["100::1", "discard"],
    ["100::ffff:ffff:ffff:ffff", "discard"],
    // the well-known NAT64 prefix keeps its embedded-v4 handling
    ["64:ff9b::a9fe:a9fe", "IMDS"],
    ["64:ff9b::10.1.2.3", "RFC1918"],
    // a zone id does not hide link-local
    ["fe80::1%eth0", "link-local"],
  ];
  for (const [ip, why] of blocked) {
    it(`blocks ${ip} (${why})`, () => {
      expect(classifyAddress(ip)).toContain(why);
    });
  }

  it("names the IPv6 form that carried the IPv4 address", () => {
    expect(classifyAddress("::169.254.169.254")).toContain("IPv4-compatible");
    expect(classifyAddress("2002:a9fe:a9fe::")).toContain("6to4");
    expect(classifyAddress("::ffff:0:a9fe:a9fe")).toContain("IPv4-translated");
    expect(classifyAddress("::ffff:169.254.169.254")).toContain("IPv4-mapped");
    expect(classifyAddress("64:ff9b::a9fe:a9fe")).toContain("NAT64");
  });

  it("leaves the same forms alone when they carry a PUBLIC address, and the neighbours of each range", () => {
    for (const ip of [
      "2002:5db8:d822::1", // 6to4 of 93.184.216.34
      "::5db8:d822", // IPv4-compatible 93.184.216.34
      "64:ff9b::5db8:d822",
      "64:ff9b:2::1", // outside 64:ff9b:1::/48
      "100:0:0:1::1", // outside 100::/64
      "fe00::1", // between fc00::/7 and fe80::/10
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ]) {
      expect(classifyAddress(ip), ip).toBeNull();
    }
  });

  it("still fails closed on anything that is not an IP literal", () => {
    for (const bad of ["[::1]", "::ffff:1.2.3", "1:2:3:4:5:6:7:8:9", "010.0.0.1", "0x7f.0.0.1", "127.1"]) {
      expect(classifyAddress(bad), bad).toMatch(/unrecognised|unparseable/);
    }
  });
});

describe("private-LAN-aware path (ADR-0043)", () => {
  it("an embedded IMDS address is never openable, in every embedding", () => {
    for (const ip of ["::a9fe:a9fe", "2002:a9fe:a9fe::", "::ffff:0:a9fe:a9fe", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe"]) {
      expect(classifyAddressLan(ip).never, ip).toContain("IMDS");
    }
  });

  it("the special ranges with no LAN meaning are never openable", () => {
    for (const ip of ["64:ff9b:1::1", "fec0::1", "100::1"]) {
      expect(classifyAddressLan(ip).never, ip).not.toBeNull();
    }
  });

  it("an embedded private-LAN address takes the private-LAN split, like IPv4-mapped always has", () => {
    expect(classifyAddressLan("2002:a00:1::")).toEqual({ never: null, privateLan: true });
    expect(classifyAddressLan("::ffff:10.0.0.1")).toEqual({ never: null, privateLan: true });
    expect(classifyAddressLan("2002:5db8:d822::1")).toEqual({ never: null, privateLan: false });
  });
});

describe("end to end through checkEgress", () => {
  it("refuses an allow-listed host whose DNS answers a 6to4-embedded IMDS address", async () => {
    const d = await checkEgress("https://sixtofour.example.com/v1", {
      allowList: allow("sixtofour.example.com"),
      resolve: resolverFor("2002:a9fe:a9fe::"),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
  });

  it("refuses an IPv4-compatible IMDS literal even on the open-by-default MCP posture", async () => {
    const d = await checkEgress("http://[::a9fe:a9fe]/latest/meta-data/", {
      allowList: allow("::a9fe:a9fe"),
      privateLan: { openByDefault: true },
      resolve: resolverFor("::a9fe:a9fe"),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
  });
});

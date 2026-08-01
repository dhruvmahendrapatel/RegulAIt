/**
 * ADR-0034 — the ADVERSARIAL SSRF suite for the egress guard.
 *
 * These are attacks, not happy paths. Every case here is a real, published
 * technique for getting a server to fetch something it should not: alternate
 * IP encodings that a naive string check waves through, IPv4-mapped IPv6,
 * DNS that answers with a link-local address, redirect-to-IMDS, the
 * `user@host` ambiguity pair, trailing-dot FQDNs, and case/unicode host
 * variants. The bar is that the guard REFUSES each one with a specific code —
 * not that it happens to throw somewhere.
 *
 * No database and no network: the allow-list is data and the resolver is
 * injected, so this file is a pure unit suite.
 */

import { describe, expect, it } from "vitest";
import {
  checkEgress,
  classifyAddress,
  createGuardedFetch,
  EgressBlockedError,
  EgressRedirectError,
  hasBlockedHostSuffix,
  normalizeHost,
  type EgressAllowEntry,
  type EgressResolver,
} from "./egress-guard.js";

const IMDS = "169.254.169.254";

/** an allow-list that permits the host but nothing else — so a case that still
 * fails must be failing on the ADDRESS, not on the allow-list */
function allow(host: string, over: Partial<EgressAllowEntry> = {}): EgressAllowEntry[] {
  return [{ host, allowPrivateRanges: false, allowPlaintextHttp: true, ...over }];
}

/** a resolver that answers every host with the given addresses */
function resolverFor(...addresses: string[]): EgressResolver {
  return async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

const publicResolver = resolverFor("93.184.216.34");

describe("default-deny: nothing is reachable without an allow-list entry", () => {
  it("refuses an ordinary public https endpoint that no admin has allow-listed", async () => {
    const d = await checkEgress("https://api.example.com/v1", {
      allowList: [],
      resolve: publicResolver,
    });
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.code).toBe("host_not_allowlisted");
  });

  it("allows exactly the host that was allow-listed, and not its siblings", async () => {
    const list = allow("api.example.com", { allowPlaintextHttp: false });
    const good = await checkEgress("https://api.example.com/v1", { allowList: list, resolve: publicResolver });
    expect(good.ok).toBe(true);
    const sibling = await checkEgress("https://evil.api.example.com/v1", {
      allowList: list,
      resolve: publicResolver,
    });
    expect(sibling.ok === false && sibling.code).toBe("host_not_allowlisted");
  });
});

describe("alternate IP encodings for 169.254.169.254 (IMDS)", () => {
  // http://2852039166/ is the decimal form of 169.254.169.254. A guard that
  // string-matches "169.254." never sees it.
  const encodings: Array<[string, string]> = [
    ["dotted quad", `http://${IMDS}/latest/meta-data/`],
    ["decimal", "http://2852039166/latest/meta-data/"],
    ["hex", "http://0xa9fea9fe/latest/meta-data/"],
    ["octal", "http://0251.0376.0251.0376/latest/meta-data/"],
    ["mixed short form", "http://169.254.43518/latest/meta-data/"],
  ];

  for (const [label, url] of encodings) {
    it(`refuses the ${label} encoding even when that host is allow-listed`, async () => {
      // allow-list the NORMALIZED form, so the only thing that can stop this
      // is the address classification
      const d = await checkEgress(url, {
        allowList: allow(IMDS),
        resolve: resolverFor(IMDS),
      });
      expect(d.ok).toBe(false);
      expect(d.ok === false && d.code).toBe("blocked_address_range");
      expect(d.ok === false && d.reason).toContain("IMDS");
    });
  }

  it("normalizes every encoding to the same host, so one allow entry cannot be dodged", () => {
    for (const [, url] of encodings) {
      expect(normalizeHost(new URL(url).hostname)).toBe(IMDS);
    }
  });
});

describe("IPv6 forms of the same targets", () => {
  it("refuses [::ffff:169.254.169.254] — the IPv4-mapped IMDS bypass", async () => {
    const d = await checkEgress("http://[::ffff:169.254.169.254]/latest/meta-data/", {
      allowList: allow("::ffff:a9fe:a9fe"),
      resolve: resolverFor("::ffff:a9fe:a9fe"),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
    expect(d.ok === false && d.reason).toContain("IPv4-mapped");
  });

  it("refuses ::1 and fe80:: literals", async () => {
    for (const [host, literal] of [
      ["[::1]", "::1"],
      ["[fe80::1]", "fe80::1"],
      ["[fc00::1]", "fc00::1"],
    ] as const) {
      const d = await checkEgress(`http://${host}:8080/v1`, {
        allowList: allow(literal),
        resolve: resolverFor(literal),
      });
      expect(d.ok === false && d.code, literal).toBe("blocked_address_range");
    }
  });

  it("classifies the IPv6 families directly", () => {
    expect(classifyAddress("::1")).toContain("loopback");
    expect(classifyAddress("fe80::abcd")).toContain("link-local");
    expect(classifyAddress("fc00::1")).toContain("unique-local");
    expect(classifyAddress("ff02::1")).toContain("multicast");
    expect(classifyAddress("::ffff:10.0.0.5")).toContain("RFC1918");
    expect(classifyAddress("64:ff9b::a9fe:a9fe")).toContain("IMDS");
    // a genuine public v6 address passes
    expect(classifyAddress("2606:4700:4700::1111")).toBeNull();
  });
});

describe("a hostname that RESOLVES to a blocked address (the real-world bypass)", () => {
  it("refuses metadata.evil.com when DNS answers 169.254.169.254", async () => {
    const d = await checkEgress("https://metadata.evil.com/latest/meta-data/", {
      allowList: allow("metadata.evil.com"),
      resolve: resolverFor(IMDS),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
    expect(d.ok === false && d.addresses).toEqual([IMDS]);
  });

  it("refuses when only ONE of several answers is blocked (no first-answer-wins)", async () => {
    const d = await checkEgress("https://split.example.com/v1", {
      allowList: allow("split.example.com"),
      resolve: resolverFor("93.184.216.34", "203.0.113.9", "10.0.0.7"),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
    expect(d.ok === false && d.reason).toContain("10.0.0.7");
  });

  it("refuses a host that resolves to nothing rather than proceeding", async () => {
    const d = await checkEgress("https://void.example.com/v1", {
      allowList: allow("void.example.com"),
      resolve: async () => [],
    });
    expect(d.ok === false && d.code).toBe("dns_resolution_failed");
  });

  it("fails CLOSED when the resolver throws", async () => {
    const d = await checkEgress("https://nx.example.com/v1", {
      allowList: allow("nx.example.com"),
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(d.ok === false && d.code).toBe("dns_resolution_failed");
  });

  it("fails CLOSED on an address form it cannot classify", () => {
    expect(classifyAddress("not-an-address")).toContain("unrecognised");
  });
});

describe("the user@host ambiguity pair", () => {
  it("refuses http://169.254.169.254@evil.com/ (host is evil.com, reads like IMDS)", async () => {
    const d = await checkEgress(`http://${IMDS}@evil.com/`, {
      allowList: allow("evil.com"),
      resolve: publicResolver,
    });
    expect(d.ok === false && d.code).toBe("userinfo_forbidden");
  });

  it("refuses http://evil.com@169.254.169.254/ (host IS IMDS, reads like evil.com)", async () => {
    const d = await checkEgress(`http://evil.com@${IMDS}/`, {
      allowList: allow(IMDS),
      resolve: resolverFor(IMDS),
    });
    // userinfo is rejected before anything else — and the host it reports is
    // the REAL one, so the audit trail is not fooled either
    expect(d.ok === false && d.code).toBe("userinfo_forbidden");
    expect(d.ok === false && d.host).toBe(IMDS);
  });

  it("refuses a password-only userinfo form", async () => {
    const d = await checkEgress("https://:hunter2@api.example.com/v1", {
      allowList: allow("api.example.com"),
      resolve: publicResolver,
    });
    expect(d.ok === false && d.code).toBe("userinfo_forbidden");
  });
});

describe("trailing dots, case, and unicode host variants", () => {
  it("a trailing dot does not dodge the .internal suffix block", async () => {
    const d = await checkEgress("http://metadata.google.internal./computeMetadata/v1/", {
      allowList: allow("metadata.google.internal"),
      resolve: resolverFor(IMDS),
    });
    // the allow entry MATCHED (trailing dot normalized away) — and it is still
    // refused, by the suffix rule that fires before any DNS answer is trusted
    expect(d.ok === false && d.code).toBe("blocked_host_suffix");
  });

  it("a trailing dot does not dodge the address block either", async () => {
    const d = await checkEgress("https://metadata.evil.com./latest/meta-data/", {
      allowList: allow("metadata.evil.com"),
      resolve: resolverFor(IMDS),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
    expect(d.ok === false && d.host).toBe("metadata.evil.com");
  });

  it("normalizes uppercase hosts", async () => {
    const d = await checkEgress("https://API.Example.COM./v1", {
      allowList: allow("api.example.com"),
      resolve: publicResolver,
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.host).toBe("api.example.com");
  });

  it("folds unicode host lookalikes to their ASCII/punycode form before matching", () => {
    // ⓔxample.com folds to example.com; exаmple.com (Cyrillic а) does NOT
    // and becomes punycode, so it can never silently match an allow entry
    expect(normalizeHost(new URL("http://ⓔxample.com/").hostname)).toBe("example.com");
    const cyrillic = normalizeHost(new URL("http://exаmple.com/").hostname);
    expect(cyrillic).not.toBe("example.com");
    expect(cyrillic.startsWith("xn--")).toBe(true);
  });

  it("blocks .internal / .local / bare localhost by suffix", () => {
    for (const h of ["metadata.google.internal", "vllm.internal", "printer.local", "localhost", "foo.localhost"]) {
      expect(hasBlockedHostSuffix(h), h).toBe(true);
    }
    expect(hasBlockedHostSuffix("api.openai.com")).toBe(false);
  });

  it("refuses a .internal host whose allow entry did not opt into private ranges", async () => {
    const d = await checkEgress("https://vllm.internal:8000/v1", {
      allowList: allow("vllm.internal"),
      resolve: resolverFor("10.4.2.11"),
    });
    expect(d.ok === false && d.code).toBe("blocked_host_suffix");
  });
});

describe("private, loopback, CGNAT and link-local ranges", () => {
  const blocked = [
    ["10.1.2.3", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.254", "RFC1918"],
    ["192.168.1.1", "RFC1918"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "CGNAT"],
    [IMDS, "IMDS"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
  ] as const;

  for (const [ip, why] of blocked) {
    it(`blocks ${ip} (${why})`, () => {
      expect(classifyAddress(ip)).toContain(why);
    });
  }

  it("does not block ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "1.1.1.1"]) {
      expect(classifyAddress(ip), ip).toBeNull();
    }
  });

  it("refuses the Postgres-on-the-compose-network shape", async () => {
    const d = await checkEgress("http://postgres:5432/", {
      allowList: allow("postgres"),
      resolve: resolverFor("172.18.0.2"),
    });
    expect(d.ok === false && d.code).toBe("blocked_address_range");
  });
});

describe("scheme handling and the explicit plaintext escape hatch", () => {
  it("refuses http when the host entry has not opted in", async () => {
    const d = await checkEgress("http://api.example.com/v1", {
      allowList: allow("api.example.com", { allowPlaintextHttp: false }),
      resolve: publicResolver,
    });
    expect(d.ok === false && d.code).toBe("plaintext_http_forbidden");
  });

  it("refuses http when the HOST opted in but the PROVIDER did not (both flags required)", async () => {
    const d = await checkEgress("http://api.example.com/v1", {
      allowList: allow("api.example.com", { allowPlaintextHttp: true }),
      providerAllowsPlaintextHttp: false,
      resolve: publicResolver,
    });
    expect(d.ok === false && d.code).toBe("plaintext_http_forbidden");
  });

  it("permits http://localhost:11434 (Ollama) ONLY with both opt-ins and allowPrivateRanges", async () => {
    const strict = await checkEgress("http://localhost:11434/v1", {
      allowList: allow("localhost", { allowPrivateRanges: false }),
      providerAllowsPlaintextHttp: true,
      resolve: resolverFor("127.0.0.1"),
    });
    expect(strict.ok === false && strict.code).toBe("blocked_host_suffix");

    const opted = await checkEgress("http://localhost:11434/v1", {
      allowList: allow("localhost", { allowPrivateRanges: true, allowPlaintextHttp: true }),
      providerAllowsPlaintextHttp: true,
      resolve: resolverFor("127.0.0.1"),
    });
    expect(opted.ok).toBe(true);
    expect(opted.ok && opted.port).toBe(11434);
    expect(opted.ok && opted.addresses).toEqual(["127.0.0.1"]);
  });

  it("refuses non-http schemes outright", async () => {
    for (const url of ["file:///etc/passwd", "gopher://169.254.169.254/", "ftp://example.com/"]) {
      const d = await checkEgress(url, { allowList: allow("example.com"), resolve: publicResolver });
      expect(d.ok === false && d.code, url).toBe("unsupported_scheme");
    }
  });

  it("refuses a non-absolute URL", async () => {
    const d = await checkEgress("/v1/chat/completions", { allowList: [], resolve: publicResolver });
    expect(d.ok === false && d.code).toBe("malformed_url");
  });
});

describe("the guarded fetch: redirects and per-request re-validation", () => {
  it("refuses a 302 to IMDS instead of following it", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: `http://${IMDS}/latest/meta-data/` } });
    }) as unknown as typeof fetch;

    const guarded = createGuardedFetch({
      allowList: allow("api.example.com", { allowPlaintextHttp: false }),
      resolve: publicResolver,
      fetchImpl,
    });
    await expect(guarded("https://api.example.com/v1/chat/completions")).rejects.toBeInstanceOf(
      EgressRedirectError,
    );
    expect(calls).toBe(1); // the redirect target was never fetched
  });

  it("refuses every 3xx, including a same-host one", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 301, headers: { location: "https://api.example.com/v2" } })) as unknown as typeof fetch;
    const guarded = createGuardedFetch({
      allowList: allow("api.example.com", { allowPlaintextHttp: false }),
      resolve: publicResolver,
      fetchImpl,
    });
    await expect(guarded("https://api.example.com/v1")).rejects.toBeInstanceOf(EgressRedirectError);
  });

  it("re-validates on EVERY request — a host that starts public and is re-pointed is blocked on the next call", async () => {
    let answer = "93.184.216.34";
    const guarded = createGuardedFetch({
      allowList: allow("flip.example.com", { allowPlaintextHttp: false }),
      resolve: async () => [{ address: answer, family: 4 }],
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    const first = await guarded("https://flip.example.com/v1");
    expect(first.status).toBe(200);
    answer = IMDS; // DNS re-pointed after the endpoint was approved
    await expect(guarded("https://flip.example.com/v1")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("pins a plaintext http request to the validated address and preserves the Host header", async () => {
    const seen: Array<{ url: string; host: string | null }> = [];
    const guarded = createGuardedFetch({
      allowList: allow("ollama.corp", { allowPrivateRanges: true, allowPlaintextHttp: true }),
      providerAllowsPlaintextHttp: true,
      resolve: resolverFor("10.9.9.9"),
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url: String(url), host: new Headers(init.headers).get("host") });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await guarded("http://ollama.corp:11434/v1/chat/completions");
    expect(res.status).toBe(200);
    expect(seen[0]!.url).toBe("http://10.9.9.9:11434/v1/chat/completions");
    expect(seen[0]!.host).toBe("ollama.corp:11434");
  });

  it("throws EgressBlockedError (not a silent pass) for a request to a non-allow-listed host", async () => {
    const guarded = createGuardedFetch({
      allowList: allow("api.example.com", { allowPlaintextHttp: false }),
      resolve: publicResolver,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(guarded(`http://${IMDS}/latest/meta-data/`)).rejects.toBeInstanceOf(EgressBlockedError);
  });
});

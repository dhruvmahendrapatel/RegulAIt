/**
 * ADR-0034 — the EGRESS GUARD.
 *
 * WHY THIS EXISTS. Admin-registered custom LLM providers (pillar 1's
 * provider-agnostic promise, pillar 3's air-gapped mode) let an admin type a
 * `baseUrl` that the gateway will then fetch on a user's behalf. That is a
 * textbook Server-Side Request Forgery primitive: the gateway runs on an EC2
 * instance, so `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 * hands back the instance role's AWS credentials, and everything else routable
 * from the VPC — including the Postgres container on the compose network — is
 * one string away. "Only an admin can set it" is NOT a mitigation: an admin
 * account is exactly what an attacker escalates to, and a governance product
 * that would proxy an arbitrary internal request on request has no story.
 *
 * THE SHAPE. Default-deny, twice over:
 *   1. the destination HOST must appear in the admin `egress_allow_hosts`
 *      allow-list (there is no "allow all" entry, and no wildcards);
 *   2. every RESOLVED ADDRESS of that host must fall outside the blocked
 *      ranges below, unless the allow entry explicitly opts that host into
 *      private ranges (the air-gapped / `http://localhost:11434` case).
 * Plaintext http additionally requires BOTH the per-host allow entry AND the
 * provider row to opt in — one flag is a typo, two flags are a decision.
 *
 * WHEN. Registration-time validation is necessary but NOT sufficient: DNS can
 * be re-pointed after approval. So this runs again on EVERY dispatch, and once
 * more inside the guarded fetch for every individual HTTP request the adapter
 * makes. See the TOCTOU note on `createGuardedFetch` for what that does and
 * does not close.
 *
 * The module is deliberately DB-free and side-effect-free apart from DNS: the
 * allow-list arrives as data and the resolver is injectable, so the adversarial
 * suite in `egress-guard.test.ts` runs with no database and no network.
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { pinnedFetch } from "./pinned-fetch.js";
import { timeouts } from "./timeouts.js";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** One admin allow-list row, reduced to the fields the decision needs. */
export interface EgressAllowEntry {
  /** already normalized (lowercase, no trailing dot, punycode) */
  host: string;
  /** permits this host to resolve INTO an otherwise-blocked range */
  allowPrivateRanges: boolean;
  /** permits plaintext http TO this host (still ANDed with the provider flag) */
  allowPlaintextHttp: boolean;
}

export type EgressDenyCode =
  | "malformed_url"
  | "unsupported_scheme"
  | "userinfo_forbidden"
  | "host_not_allowlisted"
  | "plaintext_http_forbidden"
  | "blocked_host_suffix"
  | "dns_resolution_failed"
  | "blocked_address_range"
  | "redirect_refused";

export interface EgressAllowed {
  ok: true;
  /** the normalized absolute URL (punycode host, no userinfo) */
  url: string;
  protocol: "http:" | "https:";
  /** normalized hostname — what goes in the audit row */
  host: string;
  port: number;
  /** every address the host resolved to, all of which passed */
  addresses: string[];
}

export interface EgressDenied {
  ok: false;
  code: EgressDenyCode;
  reason: string;
  host?: string;
  addresses?: string[];
}

export type EgressDecision = EgressAllowed | EgressDenied;

export class EgressBlockedError extends Error {
  constructor(readonly decision: EgressDenied) {
    super(`egress blocked (${decision.code}): ${decision.reason}`);
    this.name = "EgressBlockedError";
  }
}

/** injectable for tests — the same shape as dns/promises.lookup(host,{all:true}) */
export type EgressResolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

/**
 * ADR-0043 — the MCP surface's posture, and the `privateLanOnly` narrowing.
 *
 * When this option is present the check runs PRIVATE-LAN-AWARE:
 *   - the UNCONDITIONAL ranges (link-local/IMDS, CGNAT, multicast, reserved,
 *     0.0.0.0/8, and the IPv6 analogues incl. the AWS fd00:ec2::/32 IMDS
 *     prefix) are refused for EVERY destination — no per-server flag and no
 *     allow entry opens them on this surface. This deliberately NARROWS the
 *     allow entry's `allowPrivateRanges` opt-in relative to the classic path
 *     (where that opt-in skips the range check entirely, IMDS included): the
 *     classic behaviour is unchanged for every other surface, per ADR-0043.
 *   - with `openByDefault` true, a destination whose EVERY address is ordinary
 *     private LAN space (RFC1918 / loopback / ULA) is permitted with ZERO
 *     ceremony — no allow entry, plaintext http included (an internal service
 *     has no public CA). That is the ordinary self-hosted MCP deployment.
 *   - anything else (a public destination, or a private one under the strict
 *     org toggle) takes the ordinary default-deny allow-list posture, with the
 *     entry's `allowPrivateRanges` opening private LAN only (see above).
 */
export interface PrivateLanPosture {
  /** the EFFECTIVE per-server flag: server.allowPrivateRanges ?? org default */
  openByDefault: boolean;
}

export interface EgressCheckOptions {
  /** the admin allow-list; EMPTY MEANS NOTHING IS REACHABLE (default-deny) */
  allowList: EgressAllowEntry[];
  /** the provider row's own allowPlaintextHttp — ANDed with the host entry's */
  providerAllowsPlaintextHttp?: boolean;
  /** ADR-0043 — present only on the MCP path; see PrivateLanPosture */
  privateLan?: PrivateLanPosture;
  resolve?: EgressResolver;
}

// ---------------------------------------------------------------------------
// host normalization
// ---------------------------------------------------------------------------

/**
 * Canonical host form used for BOTH allow-list storage and comparison, so
 * `Metadata.Google.Internal.` and `metadata.google.internal` can never be two
 * different things. WHATWG `URL` has already done the heavy lifting by the time
 * a parsed host reaches here (IDNA → punycode, unicode folding, decimal/octal/
 * hex IPv4 → dotted quad); this only lowercases, strips a trailing root dot,
 * and unwraps IPv6 brackets.
 */
export function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** Hostname suffixes that name a private namespace by convention. Blocked
 * outright unless the exact host is allow-listed WITH allowPrivateRanges —
 * `.internal` in particular is where GCP/Azure park their metadata services. */
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"];
const BLOCKED_HOST_EXACT = new Set(["localhost", "local", "internal"]);

export function hasBlockedHostSuffix(host: string): boolean {
  const h = normalizeHost(host);
  if (BLOCKED_HOST_EXACT.has(h)) return true;
  return BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

// ---------------------------------------------------------------------------
// address classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

interface Cidr4 {
  base: number;
  bits: number;
  label: string;
}

function cidr4(cidr: string, label: string): Cidr4 {
  const [addr, bitsRaw] = cidr.split("/");
  const base = ipv4ToInt(addr ?? "");
  if (base === null) throw new Error(`bad CIDR ${cidr}`);
  return { base, bits: Number(bitsRaw), label };
}

/**
 * THE DEFAULT-DENY RANGE LIST. Everything an SSRF wants and nothing a public
 * model endpoint legitimately lives in.
 *
 * ADR-0043 splits it into two disjoint halves WITHOUT changing what the
 * classic path blocks (their union is byte-identical to the pre-0043 list):
 *   - PRIVATE_LAN_V4 — ordinary private LAN space, the ranges a legitimate
 *     self-hosted service actually lives in. The MCP posture (and only it)
 *     can open these.
 *   - NEVER_V4 — ranges NO legitimate admin-typed destination lives in
 *     (IMDS/link-local above all). On the private-LAN-aware path these are
 *     refused unconditionally — no flag or allow entry opens them.
 */
const PRIVATE_LAN_V4: Cidr4[] = [
  cidr4("10.0.0.0/8", "RFC1918 private"),
  cidr4("127.0.0.0/8", "loopback"),
  cidr4("172.16.0.0/12", "RFC1918 private"),
  cidr4("192.168.0.0/16", "RFC1918 private"),
];

const NEVER_V4: Cidr4[] = [
  cidr4("0.0.0.0/8", "unspecified / this-network"),
  cidr4("100.64.0.0/10", "CGNAT (RFC6598)"),
  cidr4("169.254.0.0/16", "link-local — cloud instance metadata (IMDS)"),
  cidr4("192.0.0.0/24", "IETF protocol assignments"),
  cidr4("198.18.0.0/15", "benchmarking (RFC2544)"),
  cidr4("224.0.0.0/4", "multicast"),
  cidr4("240.0.0.0/4", "reserved / broadcast"),
];

const BLOCKED_V4: Cidr4[] = [...PRIVATE_LAN_V4, ...NEVER_V4];

function matchV4(n: number, list: Cidr4[]): string | null {
  for (const c of list) {
    const mask = c.bits === 0 ? 0 : (0xffffffff << (32 - c.bits)) >>> 0;
    if ((n & mask) >>> 0 === (c.base & mask) >>> 0) return c.label;
  }
  return null;
}

function classifyV4(ip: string): string | null {
  const n = ipv4ToInt(ip);
  if (n === null) return "unparseable IPv4 address";
  return matchV4(n, BLOCKED_V4);
}

/** expand an IPv6 literal to its 8 groups of 16 bits */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // an embedded IPv4 tail (::ffff:1.2.3.4) becomes two hex groups
  const v4m = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4m) {
    const n = ipv4ToInt(v4m[1]!);
    if (n === null) return null;
    s = s.slice(0, s.length - v4m[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter((x) => x !== "") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((x) => x !== "") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (fill < 0) {
    return null;
  }
  const groups = [
    ...head,
    ...(halves.length === 2 ? Array(fill).fill("0") : []),
    ...tail,
  ].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function classifyV6(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return "unparseable IPv6 address";
  const isZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::  and  ::1
  if (isZeroPrefix(7) && g[7] === 0) return "IPv6 unspecified (::)";
  if (isZeroPrefix(7) && g[7] === 1) return "IPv6 loopback (::1)";
  // ::ffff:0:0/96 — IPv4-MAPPED. The classic `[::ffff:169.254.169.254]` bypass:
  // unwrap to the embedded v4 address and apply the v4 rules to it.
  if (isZeroPrefix(5) && g[5] === 0xffff) {
    const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
    const why = classifyV4(v4);
    return why ? `IPv4-mapped ${v4}: ${why}` : null;
  }
  // 64:ff9b::/96 — NAT64, same unwrap
  if (g[0] === 0x64 && g[1] === 0xff9b && isZeroPrefixFrom(g, 2, 6)) {
    const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
    const why = classifyV4(v4);
    return why ? `NAT64-embedded ${v4}: ${why}` : null;
  }
  if ((g[0]! & 0xffc0) === 0xfe80) return "IPv6 link-local (fe80::/10)";
  if ((g[0]! & 0xfe00) === 0xfc00) return "IPv6 unique-local (fc00::/7)";
  if ((g[0]! & 0xff00) === 0xff00) return "IPv6 multicast (ff00::/8)";
  return null;
}

function isZeroPrefixFrom(g: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (g[i] !== 0) return false;
  return true;
}

/**
 * The single address decision: returns a human reason when the address is in a
 * blocked range, or null when it is fine. Exported because it is the part the
 * adversarial suite hammers directly.
 */
export function classifyAddress(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 4) return classifyV4(ip);
  if (fam === 6) return classifyV6(ip);
  // Not a literal at all — a resolver handed us something we cannot reason
  // about. Fail CLOSED: an unclassifiable address is a blocked address.
  return `unrecognised address form '${ip}'`;
}

// ---------------------------------------------------------------------------
// ADR-0043 — the private-LAN-aware classification
// ---------------------------------------------------------------------------

/** The two-axis verdict the MCP posture needs: is this address in a range NO
 * flag may ever open, and if not, is it ordinary private LAN space? */
export interface LanAddressClass {
  /** non-null = blocked UNCONDITIONALLY on the private-LAN-aware path — the
   * IMDS carve-out and its friends. No per-server flag, org default or allow
   * entry opens these there. */
  never: string | null;
  /** true = ordinary private LAN space (RFC1918 / loopback / ULA) — what the
   * ADR-0043 flag (or an allow entry's allowPrivateRanges) opens */
  privateLan: boolean;
}

function classifyV4Lan(ip: string): LanAddressClass {
  const n = ipv4ToInt(ip);
  if (n === null) return { never: "unparseable IPv4 address", privateLan: false };
  const never = matchV4(n, NEVER_V4);
  if (never) return { never, privateLan: false };
  return { never: null, privateLan: matchV4(n, PRIVATE_LAN_V4) !== null };
}

function classifyV6Lan(ip: string): LanAddressClass {
  const g = ipv6Groups(ip);
  if (!g) return { never: "unparseable IPv6 address", privateLan: false };
  const isZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (isZeroPrefix(7) && g[7] === 0) return { never: "IPv6 unspecified (::)", privateLan: false };
  // ::1 is loopback — the v6 twin of 127.0.0.1, i.e. ordinary private LAN
  if (isZeroPrefix(7) && g[7] === 1) return { never: null, privateLan: true };
  // IPv4-mapped and NAT64: unwrap and apply the v4 split (the
  // `[::ffff:169.254.169.254]` bypass must stay closed here too)
  const embedsV4 =
    (isZeroPrefix(5) && g[5] === 0xffff) ||
    (g[0] === 0x64 && g[1] === 0xff9b && isZeroPrefixFrom(g, 2, 6));
  if (embedsV4) {
    const v4 = `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;
    const inner = classifyV4Lan(v4);
    return inner.never
      ? { never: `embedded IPv4 ${v4}: ${inner.never}`, privateLan: false }
      : { never: null, privateLan: inner.privateLan };
  }
  // fe80::/10 link-local is the v6 twin of 169.254/16 — never openable
  if ((g[0]! & 0xffc0) === 0xfe80) return { never: "IPv6 link-local (fe80::/10)", privateLan: false };
  if ((g[0]! & 0xfe00) === 0xfc00) {
    // ULA is legitimate internal v6 LAN space — EXCEPT AWS's reserved
    // fd00:ec2::/32, where the IPv6 instance-metadata endpoint
    // (fd00:ec2::254) lives. The IMDS carve-out must hold in v6 too.
    if (g[0] === 0xfd00 && g[1] === 0x0ec2) {
      return { never: "IPv6 unique-local fd00:ec2::/32 — AWS instance metadata (IMDS)", privateLan: false };
    }
    return { never: null, privateLan: true };
  }
  if ((g[0]! & 0xff00) === 0xff00) return { never: "IPv6 multicast (ff00::/8)", privateLan: false };
  return { never: null, privateLan: false };
}

/** ADR-0043: the fine-grained single-address decision the private-LAN-aware
 * path uses. Fail-closed exactly like classifyAddress: an address that cannot
 * be classified is never-openable. */
export function classifyAddressLan(ip: string): LanAddressClass {
  const fam = isIP(ip);
  if (fam === 4) return classifyV4Lan(ip);
  if (fam === 6) return classifyV6Lan(ip);
  return { never: `unrecognised address form '${ip}'`, privateLan: false };
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

const defaultResolver: EgressResolver = async (host) => {
  const res = await dnsLookup(host, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family }));
};

/**
 * Validate a destination URL. Returns a DECISION rather than throwing so the
 * caller can turn it into an honest 4xx with a reason (the repo's refusal
 * convention) or an audit row.
 */
export async function checkEgress(
  rawUrl: string,
  opts: EgressCheckOptions,
): Promise<EgressDecision> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, code: "malformed_url", reason: `'${rawUrl}' is not an absolute URL` };
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return {
      ok: false,
      code: "unsupported_scheme",
      reason: `scheme '${u.protocol}' is not permitted — only https (or explicitly opted-in http)`,
    };
  }

  // USERINFO IS REFUSED OUTRIGHT. `http://169.254.169.254@evil.com/` and
  // `http://evil.com@169.254.169.254/` differ only in which side of the `@`
  // the real host is, and the pair exists precisely to fool a human reviewer
  // (and half the URL parsers ever written). No OpenAI-compatible endpoint
  // needs credentials in the URL — we carry the key in a header — so the
  // safe reading of an ambiguous URL is "reject it".
  if (u.username !== "" || u.password !== "") {
    return {
      ok: false,
      code: "userinfo_forbidden",
      reason: "URL credentials (user:pass@host) are not permitted — the parsed host would be ambiguous to a reviewer",
      host: normalizeHost(u.hostname),
    };
  }

  const host = normalizeHost(u.hostname);
  if (!host) {
    return { ok: false, code: "malformed_url", reason: "URL has no host" };
  }

  // ADR-0043 — the private-LAN-aware fork (the MCP surface). Every other
  // surface takes the classic path below, byte-identically.
  if (opts.privateLan) {
    return checkPrivateLanAware(u, host, opts, opts.privateLan);
  }

  // 1. ALLOW-LIST — default-deny. Exact host match only: no wildcards, because
  //    `*.example.com` is one dangling subdomain takeaway from being a hole,
  //    and an operator who wants three hosts can add three rows.
  const entry = opts.allowList.find((e) => normalizeHost(e.host) === host);
  if (!entry) {
    return {
      ok: false,
      code: "host_not_allowlisted",
      reason: `host '${host}' is not in the egress allow-list — an admin must add it before it can be reached`,
      host,
    };
  }

  // 2. SCHEME — https unless BOTH the host entry and the provider row opt in.
  if (u.protocol === "http:") {
    if (!entry.allowPlaintextHttp) {
      return {
        ok: false,
        code: "plaintext_http_forbidden",
        reason: `plaintext http to '${host}' requires the egress allow entry to set allowPlaintextHttp`,
        host,
      };
    }
    if (opts.providerAllowsPlaintextHttp === false) {
      return {
        ok: false,
        code: "plaintext_http_forbidden",
        reason: `plaintext http requires the provider itself to set allowPlaintextHttp as well as the host entry`,
        host,
      };
    }
  }

  // 3. HOST SUFFIX — `.internal` / `.local` name a private namespace. Still
  //    reachable, but only for a host whose entry took the private-range
  //    decision explicitly (that is the air-gapped `vllm.internal` case).
  if (hasBlockedHostSuffix(host) && !entry.allowPrivateRanges) {
    return {
      ok: false,
      code: "blocked_host_suffix",
      reason: `host '${host}' names a private namespace; its allow entry must set allowPrivateRanges`,
      host,
    };
  }

  // 4. RESOLVE AND CHECK EVERY ADDRESS. The literal is never trusted:
  //    `http://metadata.evil.com/` is a perfectly ordinary public hostname
  //    right up until it answers 169.254.169.254.
  const resolve = opts.resolve ?? defaultResolver;
  let addresses: string[];
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    addresses = [host];
  } else {
    try {
      const res = await resolve(host);
      addresses = res.map((r) => r.address);
    } catch (err) {
      return {
        ok: false,
        code: "dns_resolution_failed",
        reason: `could not resolve '${host}': ${err instanceof Error ? err.message : String(err)}`,
        host,
      };
    }
    if (addresses.length === 0) {
      return { ok: false, code: "dns_resolution_failed", reason: `'${host}' resolved to no addresses`, host };
    }
  }

  if (!entry.allowPrivateRanges) {
    for (const a of addresses) {
      const why = classifyAddress(a);
      if (why) {
        return {
          ok: false,
          code: "blocked_address_range",
          reason: `'${host}' resolves to ${a} — ${why}. Blocked by default; an admin may set allowPrivateRanges on its allow entry if this is a genuine on-prem endpoint.`,
          host,
          addresses,
        };
      }
    }
  }

  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return {
    ok: true,
    url: u.toString(),
    protocol: u.protocol,
    host,
    port,
    addresses,
  };
}

/**
 * ADR-0043 — the private-LAN-aware check, reached only when
 * `opts.privateLan` is present (today: the MCP surface). The URL has already
 * passed the shared parse/scheme/userinfo checks.
 *
 * Order matters and is deliberate:
 *   1. RESOLVE FIRST — the posture is decided by WHERE the host actually
 *      lands, not by what the string looks like.
 *   2. THE UNCONDITIONAL RANGES are refused for every destination — the IMDS
 *      carve-out. This runs BEFORE any flag or allow entry is consulted, so
 *      nothing can open it (`privateLanOnly` narrowing: even an allow entry
 *      whose allowPrivateRanges would skip the range check on the classic
 *      path does not skip it here).
 *   3. ZERO CEREMONY for the ordinary case: flag on + every address ordinary
 *      private LAN → allowed, plaintext http included (an internal service
 *      has no public CA). That is `http://mcp.internal:9000` /
 *      `http://localhost:3000` Just Working, per ADR-0041's buyer.
 *   4. Everything else — a public destination, or a private one under the
 *      strict org toggle — takes the ordinary default-deny allow-list
 *      posture: an entry is required, plaintext http needs the entry's
 *      opt-in, and private-LAN addresses need the entry's allowPrivateRanges
 *      (or the flag).
 */
async function checkPrivateLanAware(
  u: URL,
  host: string,
  opts: EgressCheckOptions,
  lan: PrivateLanPosture,
): Promise<EgressDecision> {
  // 1. resolve every address (the literal is never trusted)
  const resolve = opts.resolve ?? defaultResolver;
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      const res = await resolve(host);
      addresses = res.map((r) => r.address);
    } catch (err) {
      return {
        ok: false,
        code: "dns_resolution_failed",
        reason: `could not resolve '${host}': ${err instanceof Error ? err.message : String(err)}`,
        host,
      };
    }
    if (addresses.length === 0) {
      return { ok: false, code: "dns_resolution_failed", reason: `'${host}' resolved to no addresses`, host };
    }
  }

  // 2. THE UNCONDITIONAL RANGES — refused before any flag or entry is read.
  for (const a of addresses) {
    const cls = classifyAddressLan(a);
    if (cls.never) {
      return {
        ok: false,
        code: "blocked_address_range",
        reason:
          `'${host}' resolves to ${a} — ${cls.never}. This range is never reachable on this surface: ` +
          `no per-server flag, org default or allow entry opens it.`,
        host,
        addresses,
      };
    }
  }
  const allPrivateLan = addresses.every((a) => classifyAddressLan(a).privateLan);

  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const allowed: EgressAllowed = {
    ok: true,
    url: u.toString(),
    protocol: u.protocol as "http:" | "https:",
    host,
    port,
    addresses,
  };

  // 3. the zero-ceremony ordinary case
  if (lan.openByDefault && allPrivateLan) return allowed;

  // 4. the ordinary allow-list posture for everything else
  const entry = opts.allowList.find((e) => normalizeHost(e.host) === host);
  if (!entry) {
    return {
      ok: false,
      code: "host_not_allowlisted",
      reason: allPrivateLan
        ? `host '${host}' is on a private range and private ranges are not permitted for this server — ` +
          `set the server's allowPrivateRanges flag (or the org mcpPrivateRangesDefault), or add an ` +
          `egress allow entry for it with allowPrivateRanges`
        : `host '${host}' is not in the egress allow-list — a public MCP destination requires an admin ` +
          `allow entry before it can be reached`,
      host,
      addresses,
    };
  }

  if (u.protocol === "http:" && !entry.allowPlaintextHttp) {
    return {
      ok: false,
      code: "plaintext_http_forbidden",
      reason: `plaintext http to '${host}' requires the egress allow entry to set allowPlaintextHttp`,
      host,
    };
  }

  if (hasBlockedHostSuffix(host) && !entry.allowPrivateRanges && !lan.openByDefault) {
    return {
      ok: false,
      code: "blocked_host_suffix",
      reason: `host '${host}' names a private namespace; its allow entry must set allowPrivateRanges`,
      host,
    };
  }

  // Private-LAN addresses under an entry need the entry's opt-in (or the
  // flag). The entry's allowPrivateRanges here opens PRIVATE LAN ONLY — the
  // unconditional ranges were already refused in step 2.
  if (!entry.allowPrivateRanges && !lan.openByDefault) {
    for (const a of addresses) {
      if (classifyAddressLan(a).privateLan) {
        return {
          ok: false,
          code: "blocked_address_range",
          reason:
            `'${host}' resolves to ${a} — a private-range address. Blocked under the strict MCP posture; ` +
            `set the server's allowPrivateRanges flag or add allowPrivateRanges to its allow entry.`,
          host,
          addresses,
        };
      }
    }
  }

  return allowed;
}

/** Throwing wrapper for call sites that already sit inside a try/catch. */
export async function assertEgressAllowed(
  rawUrl: string,
  opts: EgressCheckOptions,
): Promise<EgressAllowed> {
  const d = await checkEgress(rawUrl, opts);
  if (!d.ok) throw new EgressBlockedError(d);
  return d;
}

// ---------------------------------------------------------------------------
// the guarded fetch
// ---------------------------------------------------------------------------

export class EgressRedirectError extends Error {
  constructor(readonly location: string | null) {
    super(
      `upstream returned a redirect to '${location ?? "(no Location)"}' — redirects are refused on custom-provider egress`,
    );
    this.name = "EgressRedirectError";
  }
}

/**
 * Dig an egress refusal out of whatever the SDK wrapped it in.
 *
 * openai-node and @anthropic-ai/sdk turn a throwing `fetch` into an
 * `APIConnectionError` whose message is the useless "Connection error." — so a
 * guard refusal (a GOVERNANCE DECISION, with a specific reason an operator
 * needs to see) would otherwise reach the caller as an opaque network blip.
 * Bounded walk, so a cyclic cause chain cannot hang the request.
 */
export function egressRefusal(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i += 1) {
    if (cur instanceof EgressBlockedError) return cur.decision.reason;
    if (cur instanceof EgressRedirectError) return cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export interface GuardedFetchOptions extends EgressCheckOptions {
  /** Runs after destination validation and immediately before transport admission. */
  beforeSend?: () => Promise<void>;
  /**
   * TEST SEAM ONLY. Injecting a fetch replaces the pinned transport below, so
   * an injected fetch resolves the hostname itself and is therefore NOT pinned.
   * No production call site passes this — `custom-providers.ts`,
   * `credential-egress.ts` and `connection-egress.ts` all thread it straight
   * from their own `deps`/`opts`, and `app.ts` supplies none — so the pinning
   * guarantee below is the one every real dispatch gets. It is spelled out here
   * rather than left implicit because a security property that quietly
   * evaporates under an injected dependency is exactly the kind of thing a
   * later reader must not have to rediscover.
   */
  fetchImpl?: typeof fetch;
}

/**
 * A `fetch` that re-validates on EVERY request and refuses redirects.
 *
 * REDIRECTS ARE REFUSED ENTIRELY rather than re-validated per hop. A 302 to
 * `http://169.254.169.254/` is the shortest path around any pre-flight check,
 * and following-then-checking means the socket to the redirect target has
 * already been opened by the time we look. Re-validating each hop would work,
 * but no OpenAI-compatible or Anthropic-Messages endpoint requires a redirect
 * to function, so the cheaper and stricter rule wins: 3xx is a hard error with
 * an honest message, and an admin whose endpoint really redirects can point
 * the baseUrl at the final destination.
 *
 * DNS PINNING — as of ADR-0034 amendment #3 (2026-08-01) this holds for BOTH
 * schemes, through ONE mechanism:
 *   - The URL keeps its original hostname and the connection is made through a
 *     `lookup` that resolves nothing and returns the addresses this guard just
 *     validated (`pinned-fetch.ts`). No second resolution happens, so a DNS
 *     rebind between check and connect cannot move the connection.
 *   - Because the hostname is preserved rather than rewritten to an IP literal,
 *     **https keeps real SNI and real certificate verification** against that
 *     hostname. `rejectUnauthorized` stays at its default `true` and no
 *     `checkServerIdentity` override is installed: the pin does not buy itself
 *     out of the TLS identity check, which would have been a worse hole than
 *     the one it closes.
 *   - `http` was already pinned before this change (URL rewritten to the
 *     validated IP literal, original hostname in the `Host` header) and is not
 *     regressed: it now reaches the same address by the same `lookup`, still
 *     sending the hostname as `Host`. The rewrite is gone, not the pin.
 *   - Multi-address hosts pin to the WHOLE validated set, not to `addresses[0]`
 *     — see the multi-address note in `pinned-fetch.ts`. An address the guard
 *     never validated cannot be dialled.
 *
 * WHAT REMAINS. An injected `fetchImpl` (tests only — see `GuardedFetchOptions`)
 * cannot be pinned and keeps the pre-amendment behaviour, including the http
 * IP-literal rewrite. And pinning constrains WHERE the socket goes, not what an
 * allow-listed host chooses to serve: an attacker who legitimately controls an
 * allow-listed name still reaches their own server, which was always true.
 */
export function createGuardedFetch(opts: GuardedFetchOptions): typeof fetch {
  const injected = opts.fetchImpl;
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const decision = await checkEgress(rawUrl, opts);
    if (!decision.ok) throw new EgressBlockedError(decision);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // REL-12: a forgotten deadline is still a deadline. The caller's own
    // signal is used untouched when there is one (MCP, scorers, model
    // dispatch all bring theirs); only a call that brought none gets the
    // process-wide outbound default, so nothing can hang a handler forever.
    const signal = init?.signal ?? AbortSignal.timeout(timeouts().outboundDefaultMs);

    // Admission runs after asynchronous DNS/egress validation, before any send.
    if (opts.beforeSend) await opts.beforeSend();

    let res: Response;
    if (injected) {
      // TEST SEAM. Unpinned by construction; the http IP-literal rewrite that
      // predates amendment #3 is preserved here verbatim so injected-fetch
      // suites keep observing exactly what they always observed.
      let target = decision.url;
      if (decision.protocol === "http:") {
        const pinned = new URL(decision.url);
        const addr = decision.addresses[0]!;
        pinned.hostname = isIP(addr) === 6 ? `[${addr}]` : addr;
        target = pinned.toString();
        headers.set("host", decision.port === 80 ? decision.host : `${decision.host}:${decision.port}`);
      }
      res = await injected(target, { ...init, headers, signal, redirect: "manual" });
    } else {
      res = await pinnedFetch(
        {
          url: decision.url,
          protocol: decision.protocol,
          host: decision.host,
          port: decision.port,
          addresses: decision.addresses,
        },
        { ...init, headers, signal, redirect: "manual" },
      );
    }

    if (res.status >= 300 && res.status < 400) {
      throw new EgressRedirectError(res.headers.get("location"));
    }
    return res;
  };
  return guarded as typeof fetch;
}

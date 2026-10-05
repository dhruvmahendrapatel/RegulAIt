/**
 * ADR-0039 — the CIDR matcher and fail-closed IP-policy evaluation.
 *
 * ADR-0176: the prefix match is Node's own `net.BlockList` (standard library),
 * which reads both the CIDR and the client address with the same parser the
 * socket layer uses. The hand-written IPv6 parser and byte-wise prefix match
 * this file used to carry are gone; the POLICY below is unchanged and pinned by
 * `net-policy.test.ts`. Everything fails CLOSED:
 *   - a malformed CIDR matches NOTHING (a typo can never widen the envelope);
 *   - an undeterminable client IP under a non-empty allow-list is DENIED;
 *   - only an EMPTY/NULL allow-list means "no restriction" (the ADR's
 *     upgrade-must-not-lock-anyone-out default).
 *
 * IPv4-mapped IPv6 (::ffff:a.b.c.d — what a dual-stack socket reports for a
 * v4 peer) is matched against BOTH its v6 form and the embedded v4 address,
 * so `127.0.0.0/8` matches a client the socket calls `::ffff:127.0.0.1`.
 *
 * THIS IS AN ALLOW-LIST, so the other IPv6 forms that carry an IPv4 address
 * (IPv4-compatible `::a.b.c.d`, 6to4 `2002::/16`, NAT64 `64:ff9b::/96`) are
 * deliberately NOT unwrapped here, unlike in the egress guard's block-list:
 * no socket reports a v4 peer that way, and unwrapping would let an IPv6
 * client that merely embeds an allowed v4 address inside the envelope. Not
 * unwrapping is the fail-closed direction for an allow-list.
 */
import { BlockList, isIP } from "node:net";

export interface ParsedCidr {
  address: string;
  family: "ipv4" | "ipv6";
  prefix: number;
}

/** `a.b.c.d/nn`, `xx::/nn`, or a bare address (an implicit full-length
 * prefix). Returns null for ANYTHING malformed: bad address, prefix out of
 * range, non-numeric prefix, extra slashes. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const parts = cidr.trim().split("/");
  if (parts.length > 2) return null;
  const address = parts[0]!;
  const fam = isIP(address);
  if (fam !== 4 && fam !== 6) return null;
  const maxPrefix = fam === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1]!)) return null;
    prefix = Number(parts[1]);
    if (prefix > maxPrefix) return null;
  }
  return { address, family: fam === 4 ? "ipv4" : "ipv6", prefix };
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

/** does `cidr` contain `ip`? A malformed CIDR or unparseable IP matches
 * NOTHING — fail closed, never a throw on the hot path. */
export function cidrContains(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const fam = isIP(ip);
  if (fam !== 4 && fam !== 6) return false;
  // `BlockList` compares a v4 client with a v6 rule through the client's
  // ::ffff: form; an IPv6 CIDR never admitted a plain IPv4 client here, and
  // still does not
  if (parsed.family === "ipv6" && fam === 4) return false;
  try {
    const list = new BlockList();
    list.addSubnet(parsed.address, parsed.prefix, parsed.family);
    return list.check(ip, fam === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

export type IpEnvelopeDecision =
  /** matched = the CIDR that admitted the IP; null = no restriction is
   * configured (empty/null allow-list — the upgrade-safe default) */
  | { allowed: true; matched: string | null }
  /** no_client_ip = the request's IP could not be determined under a
   * non-empty envelope (denied — an unknowable IP is OUTSIDE the envelope) */
  | { allowed: false; reason: "no_client_ip" | "outside_allowlist" };

/** THE evaluation both knobs share. The caller has already decided the
 * governing policy is enforcing; this answers only "is this IP inside the
 * envelope?" with the ADR's fail-closed semantics. */
export function evaluateIpEnvelope(
  allowlist: string[] | null | undefined,
  ip: string | null | undefined,
): IpEnvelopeDecision {
  if (!allowlist || allowlist.length === 0) return { allowed: true, matched: null };
  if (!ip) return { allowed: false, reason: "no_client_ip" };
  for (const cidr of allowlist) {
    if (cidrContains(cidr, ip)) return { allowed: true, matched: cidr };
  }
  return { allowed: false, reason: "outside_allowlist" };
}

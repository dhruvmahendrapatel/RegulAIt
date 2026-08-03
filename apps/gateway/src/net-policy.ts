/**
 * ADR-0039 — the CIDR matcher and fail-closed IP-policy evaluation.
 *
 * Pure functions, zero dependencies beyond node:net's isIP (the prefix match
 * itself is written here — no new package for something this small and this
 * load-bearing). Everything fails CLOSED:
 *   - a malformed CIDR matches NOTHING (a typo can never widen the envelope);
 *   - an undeterminable client IP under a non-empty allow-list is DENIED;
 *   - only an EMPTY/NULL allow-list means "no restriction" (the ADR's
 *     upgrade-must-not-lock-anyone-out default).
 *
 * IPv4-mapped IPv6 (::ffff:a.b.c.d — what a dual-stack socket reports for a
 * v4 peer) is matched against BOTH its v6 form and the embedded v4 address,
 * so `127.0.0.0/8` matches a client the socket calls `::ffff:127.0.0.1`.
 */
import { isIP } from "node:net";

/** dotted-quad -> 4 bytes. Caller has already validated with isIP === 4. */
function v4ToBytes(ip: string): Uint8Array {
  return Uint8Array.from(ip.split(".").map(Number));
}

/** RFC 4291 text form -> 16 bytes, handling `::` compression, an embedded
 * IPv4 tail, and a zone index (`fe80::1%eth0`). Returns null on anything it
 * cannot parse — which the caller treats as match-nothing. */
function v6ToBytes(raw: string): Uint8Array | null {
  let ip = raw;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  // embedded IPv4 tail -> two trailing 16-bit groups
  if (ip.includes(".")) {
    const lastColon = ip.lastIndexOf(":");
    const tail = ip.slice(lastColon + 1);
    if (isIP(tail) !== 4) return null;
    const b = v4ToBytes(tail);
    ip =
      ip.slice(0, lastColon + 1) +
      (((b[0]! << 8) | b[1]!).toString(16) + ":" + ((b[2]! << 8) | b[3]!).toString(16));
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = groups(halves[0]!);
  const right = halves.length === 2 ? groups(halves[1]!) : [];
  if (left === null || right === null) return null;
  let words: number[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    words = left;
  } else {
    if (left.length + right.length > 7) return null;
    words = [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  }
  const out = new Uint8Array(16);
  words.forEach((w, i) => {
    out[2 * i] = w >> 8;
    out[2 * i + 1] = w & 0xff;
  });
  return out;
}

/** an IP string -> its address bytes (4 or 16), or null when unparseable. */
export function ipToBytes(ip: string): Uint8Array | null {
  const family = isIP(ip);
  if (family === 4) return v4ToBytes(ip);
  if (family === 6) return v6ToBytes(ip);
  return null;
}

const MAPPED_V4_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/** every byte-form this client address can legitimately be compared under:
 * its native form, plus the embedded IPv4 for a v4-mapped IPv6 address. */
function clientForms(ip: string): Uint8Array[] {
  const native = ipToBytes(ip);
  if (!native) return [];
  const forms = [native];
  if (native.length === 16 && MAPPED_V4_PREFIX.every((b, i) => native[i] === b)) {
    forms.push(native.slice(12));
  }
  return forms;
}

export interface ParsedCidr {
  bytes: Uint8Array;
  prefix: number;
}

/** `a.b.c.d/nn`, `xx::/nn`, or a bare address (an implicit full-length
 * prefix). Returns null for ANYTHING malformed: bad address, prefix out of
 * range, non-numeric prefix, extra slashes. */
export function parseCidr(cidr: string): ParsedCidr | null {
  const parts = cidr.trim().split("/");
  if (parts.length > 2) return null;
  const bytes = ipToBytes(parts[0]!);
  if (!bytes) return null;
  const maxPrefix = bytes.length * 8;
  if (parts.length === 1) return { bytes, prefix: maxPrefix };
  if (!/^\d{1,3}$/.test(parts[1]!)) return null;
  const prefix = Number(parts[1]);
  if (prefix > maxPrefix) return null;
  return { bytes, prefix };
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

function prefixMatch(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
  const fullBytes = prefix >> 3;
  for (let i = 0; i < fullBytes; i++) if (a[i] !== b[i]) return false;
  const rem = prefix & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (a[fullBytes]! & mask) === (b[fullBytes]! & mask);
}

/** does `cidr` contain `ip`? A malformed CIDR or unparseable IP matches
 * NOTHING — fail closed, never a throw on the hot path. */
export function cidrContains(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  for (const form of clientForms(ip)) {
    if (form.length === parsed.bytes.length && prefixMatch(form, parsed.bytes, parsed.prefix)) {
      return true;
    }
  }
  return false;
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

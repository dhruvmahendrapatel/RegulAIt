/**
 * ADR-0334 follow-ups (#1029, #1031): two small guards the worker applies, kept pure so the tests pin them.
 *
 * 1. THE PINNED GATEWAY ORIGIN (#1029). The worker reaches the gateway only through a host permission, so CORS never
 *    applies and the gateway needs no CORS handling (the alternative, `@fastify/cors` with an extension-id allow-list,
 *    would add a cross-origin surface to the gateway; ADR-0334 §13). The origin is fixed when the customer builds the
 *    extension they sign (`scripts/build.mjs --gateway-origin https://…`), written into `host_permissions` and into
 *    the bundle. A managed `gatewayUrl` with any other origin is refused, so a tampered managed configuration cannot
 *    send the device's key, token or reports anywhere else. A build with no pinned origin reaches no gateway at all
 *    and stays closed (the strict default).
 *
 * 2. BLOCK-PAGE EVENTS (#1031). The block page is web-accessible (a redirect needs that), so a governed site could open
 *    it with any code. A `blocked` record is kept only when the worker's own current verdict for that site is the same
 *    block with the same code, only from a top-level frame, and at most once per site and code a minute.
 */
import type { BrowserEventCode, BrowserSiteVerdict } from "@regulait/shared/browser-governance/constants";

declare const __REGULAIT_GATEWAY_ORIGIN__: string | undefined;

/** the origin this build was pinned to, or "" when none was (then no gateway is reachable) */
export function pinnedGatewayOrigin(): string {
  return typeof __REGULAIT_GATEWAY_ORIGIN__ === "string" ? __REGULAIT_GATEWAY_ORIGIN__ : "";
}

/** a gateway origin as the build accepts it: https, a host (and optional port), no path, query, fragment or user */
export function parseGatewayOrigin(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error("--gateway-origin must be an https origin, e.g. https://gateway.example.com");
  }
  const bare = u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
  if (u.protocol !== "https:" || !bare || !u.hostname || u.hostname.includes("*") || value.replace(/\/$/, "") !== u.origin) {
    throw new Error("--gateway-origin must be an https origin with no path, e.g. https://gateway.example.com");
  }
  return u.origin;
}

/** the configured gateway URL's origin when it is the pinned one, otherwise null (refused: fail closed) */
export function allowedGatewayOrigin(configuredUrl: string, pinned: string = pinnedGatewayOrigin()): string | null {
  if (!pinned) return null;
  try {
    const u = new URL(configuredUrl);
    return u.origin === pinned && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash ? pinned : null;
  } catch {
    return null;
  }
}

export const BLOCK_RECORD_WINDOW_MS = 60_000;

/** decides whether a block-page message becomes a `blocked` event */
export class BlockRecordGate {
  private readonly last = new Map<string, number>();

  accept(args: { siteId: string; code: BrowserEventCode; verdict: BrowserSiteVerdict; frameId: number | undefined; nowMs: number }): boolean {
    if (args.frameId !== 0) return false;
    if (args.verdict.effect !== "block" || args.verdict.code !== args.code) return false;
    const key = `${args.siteId}:${args.code}`;
    const prev = this.last.get(key);
    if (prev !== undefined && args.nowMs - prev < BLOCK_RECORD_WINDOW_MS) return false;
    this.last.set(key, args.nowMs);
    if (this.last.size > 256) {
      for (const [k, at] of this.last) if (args.nowMs - at >= BLOCK_RECORD_WINDOW_MS) this.last.delete(k);
    }
    return true;
  }
}

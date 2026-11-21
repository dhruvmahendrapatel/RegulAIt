/**
 * ADR-0336 decision 5: each agent platform adapter's fixed endpoint allow-list, enforced in code on top of the guarded
 * fetch. Kept apart from the adapter list (agent-platform-adapters.ts) so an adapter can import it without a cycle.
 */
import { ReadFailure } from "./discovery-wider-scanners.js";

/** one (method, path) a read adapter may call; the path is matched whole (the query string is not part of it) */
export interface EndpointRule {
  method: "GET" | "POST";
  path: RegExp;
}

/**
 * A fetch that admits only the declared (method, path) pairs on the given origins (https only, no userinfo), and
 * throws a `ReadFailure` (recorded as a `denied` read outcome) for anything else before calling `base`.
 */
export function allowListedFetch(base: typeof fetch, origins: ReadonlySet<string>, rules: readonly EndpointRule[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return Promise.reject(new ReadFailure("denied", "refused before sending: not a URL"));
    }
    const ok =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      origins.has(url.origin) &&
      rules.some((r) => r.method === method && r.path.test(url.pathname));
    if (!ok) {
      return Promise.reject(new ReadFailure("denied", `refused before sending: ${method.slice(0, 10)} ${url.pathname.slice(0, 200)} is not on this adapter's endpoint allow-list`));
    }
    return base(input, init);
  }) as typeof fetch;
}


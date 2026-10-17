/**
 * Test-only: a fake cloud behind a `fetch`. The real SDKs build real requests and parse real responses; only the
 * socket is replaced. Every request is recorded, and an unrouted request answers 599 so a test sees it.
 * Not exported from the package index.
 */
import { randomBytes } from "node:crypto";

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type Route = (call: RecordedCall) => Response | undefined | Promise<Response | undefined>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/xml" } });
}

/** synthetic, runtime-derived secret-shaped values (gitleaks: no literals) */
export const synthetic = (label: string): string => `${label}-${randomBytes(12).toString("hex")}`;

export function fakeCloud(routes: Route[]): { fetch: typeof fetch; calls: RecordedCall[]; unrouted: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const unrouted: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let body = "";
    if (init?.body !== undefined && init.body !== null) body = await new Response(init.body as ConstructorParameters<typeof Response>[0]).text();
    else if (input instanceof Request && input.method !== "GET") body = await input.text();
    const call: RecordedCall = { method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), url, headers, body };
    calls.push(call);
    for (const r of routes) {
      const res = await r(call);
      if (res) return res;
    }
    unrouted.push(call);
    return new Response(`unrouted ${call.method} ${url.href}`, { status: 599 });
  };
  return { fetch: impl as typeof fetch, calls, unrouted };
}

/**
 * Trips if anything leaves the process except through the injected fetch: global fetch, node:http and node:https
 * request/get are replaced with recorders that refuse. Returns the record and a restore function.
 */
export async function installNetworkTripwire(): Promise<{ escaped: string[]; restore: () => void }> {
  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;
  const escaped: string[] = [];
  const saved = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
  const refuse = (label: string) =>
    ((...args: unknown[]) => {
      const first = args[0];
      const where = first instanceof URL ? first.href : typeof first === "string" ? first : first instanceof Request ? first.url : JSON.stringify(first ?? {});
      escaped.push(`${label} ${where}`);
      throw new Error(`network tripwire: ${label} called outside the injected fetch`);
    }) as never;
  globalThis.fetch = refuse("fetch");
  http.request = refuse("http.request");
  http.get = refuse("http.get");
  https.request = refuse("https.request");
  https.get = refuse("https.get");
  return {
    escaped,
    restore: () => {
      globalThis.fetch = saved.fetch;
      http.request = saved.httpRequest;
      http.get = saved.httpGet;
      https.request = saved.httpsRequest;
      https.get = saved.httpsGet;
    },
  };
}

/** a pseudonymiser stand-in for SD0's hook: deterministic, visibly not the raw value */
export const testPseudonymise = async (p: { provider: string; rawIdentifier: string }): Promise<string> =>
  `pseudo:${p.provider}:${Buffer.from(p.rawIdentifier).toString("base64url").slice(0, 12)}`;

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

/**
 * A fake AWS STS: AssumeRole / AssumeRoleWithWebIdentity return synthetic session credentials, GetCallerIdentity
 * returns `account` (default the test account). Undefined for any other host.
 */
export function awsSts(call: RecordedCall, account = "111122223333"): Response | undefined {
  if (!(call.url.hostname.startsWith("sts.") && call.url.hostname.endsWith(".amazonaws.com"))) return undefined;
  const action = new URLSearchParams(call.body).get("Action") ?? "";
  const ns = 'xmlns="https://sts.amazonaws.com/doc/2011-06-15/"';
  if (action === "GetCallerIdentity") {
    return xml(`<GetCallerIdentityResponse ${ns}><GetCallerIdentityResult><Arn>arn:aws:sts::${account}:assumed-role/regulait-discovery/s</Arn><UserId>AROA:s</UserId><Account>${account}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`);
  }
  const creds = `<Credentials><AccessKeyId>${synthetic("akid")}</AccessKeyId><SecretAccessKey>${synthetic("sk")}</SecretAccessKey><SessionToken>${synthetic("st")}</SessionToken><Expiration>2026-10-17T13:00:00Z</Expiration></Credentials>`;
  return xml(`<${action}Response ${ns}><${action}Result>${creds}</${action}Result></${action}Response>`);
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
 * request/get, net.connect/createConnection, tls.connect and http2.connect are replaced with recorders that refuse.
 * Returns the record and a restore function. A positive control (a client on its default handler) proves it trips.
 */
/** the host a refused call was aimed at: parsed with URL for a URL, string or Request; the options' host otherwise */
export function escapedHost(first: unknown): string {
  try {
    if (first instanceof URL) return first.hostname;
    if (typeof first === "string") return new URL(first).hostname;
    if (first instanceof Request) return new URL(first.url).hostname;
  } catch {
    return "?";
  }
  if (first && typeof first === "object") {
    const o = first as { host?: unknown; hostname?: unknown };
    return String(o.hostname ?? o.host ?? "?");
  }
  return "?";
}

export async function installNetworkTripwire(): Promise<{ escaped: string[]; escapedHosts: string[]; restore: () => void }> {
  const mods: Record<string, Record<string, unknown>> = {
    http: (await import("node:http")).default as unknown as Record<string, unknown>,
    https: (await import("node:https")).default as unknown as Record<string, unknown>,
    net: (await import("node:net")).default as unknown as Record<string, unknown>,
    tls: (await import("node:tls")).default as unknown as Record<string, unknown>,
    http2: (await import("node:http2")).default as unknown as Record<string, unknown>,
    global: globalThis as unknown as Record<string, unknown>,
  };
  const targets: Array<[string, string]> = [
    ["global", "fetch"],
    ["http", "request"],
    ["http", "get"],
    ["https", "request"],
    ["https", "get"],
    ["net", "connect"],
    ["net", "createConnection"],
    ["tls", "connect"],
    ["http2", "connect"],
  ];
  const escaped: string[] = [];
  const escapedHosts: string[] = [];
  const saved = targets.map(([m, k]) => [m, k, mods[m]![k]] as const);
  const describe = (first: unknown): string => {
    if (first instanceof URL) return first.href;
    if (typeof first === "string") return first;
    if (first instanceof Request) return first.url;
    if (first && typeof first === "object") {
      const o = first as { host?: unknown; hostname?: unknown; port?: unknown };
      return `${String(o.hostname ?? o.host ?? "?")}:${String(o.port ?? "")}`;
    }
    return String(first);
  };
  for (const [m, k] of targets) {
    mods[m]![k] = (...args: unknown[]) => {
      escaped.push(`${m}.${k} ${describe(args[0])}`);
      escapedHosts.push(escapedHost(args[0]));
      throw new Error(`network tripwire: ${m}.${k} called outside the injected fetch`);
    };
  }
  return {
    escaped,
    escapedHosts,
    restore: () => {
      for (const [m, k, v] of saved) mods[m]![k] = v;
    },
  };
}

/** a pseudonymiser stand-in for SD0's hook: deterministic, visibly not the raw value */
export const testPseudonymise = async (p: { provider: string; rawIdentifier: string }): Promise<string> =>
  `pseudo:${p.provider}:${Buffer.from(p.rawIdentifier).toString("base64url").slice(0, 12)}`;

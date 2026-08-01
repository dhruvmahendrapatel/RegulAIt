/**
 * ADR-0034 amendment #3 (2026-08-01) — THE PINNED EGRESS TRANSPORT.
 *
 * WHAT THIS CLOSES. ADR-0034 and both of its amendments each disclosed the same
 * hole and each deliberately left it open:
 *
 *   > For **https** it is not pinned — rewriting to an IP literal breaks SNI and
 *   > certificate verification […] An https destination is therefore validated
 *   > immediately before each request and then resolved a second time by the TLS
 *   > stack. A rebind inside that sub-millisecond window is not prevented.
 *
 * That second resolution is the whole bug. An attacker who controls DNS for an
 * allow-listed name answers with a public address for the guard's check and
 * `169.254.169.254` for the connect, and the guard's verdict describes a
 * destination the socket never went to. (They also need a certificate valid for
 * the allow-listed name — which, for a name they control, is a free ACME issue.)
 *
 * THE FIX, AND WHY IT IS NOT AN IP-LITERAL REWRITE. The URL keeps its original
 * hostname, so SNI, the `Host` header and `checkServerIdentity` are all still
 * driven by the hostname exactly as before; what changes is that the connection
 * is made through a `lookup` function that RESOLVES NOTHING and simply returns
 * the addresses the guard already validated. There is no second resolution, so
 * there is no window. TLS verification is untouched: `rejectUnauthorized` is
 * left at its default `true`, no `checkServerIdentity` override is installed,
 * and the certificate is still checked against the original hostname. A rebind
 * now cannot move the connection, and a certificate that does not match the
 * allow-listed name still fails — see `pinned-fetch.test.ts`, which proves both.
 *
 * ── THE DEPENDENCY DECISION (the thing ADR-0034 deferred) ────────────────────
 *
 * ADR-0034 named the fix as "a pinned-`lookup` dispatcher (`undici.Agent` with
 * `connect: { lookup, servername }`), which is a dependency decision". The
 * decision taken here is **NO NEW DEPENDENCY**. Reasons, in order of weight:
 *
 *  1. Node's global `fetch` is undici, but Node exports no `undici` module and
 *     no `Agent` class. Reaching undici's `Agent` from inside Node means either
 *     adding the userland `undici` package — a SECOND copy of an HTTP stack,
 *     shipped on its own release cadence, sitting in the security path — or
 *     digging it out of `globalThis[Symbol.for("undici.globalDispatcher.1")]`,
 *     an undocumented internal that can vanish in a patch release and whose
 *     absence would be silent.
 *  2. The repo already took this position one layer out: `.github/workflows/ci.yml`
 *     refuses `dorny/paths-filter` and `tj-actions/changed-files` because "a
 *     third-party action in the CI path is a supply-chain surface", and ADR-0012
 *     took the same line on the admin portal's dependency tree. This code is in
 *     the *security* path, so it deserves more of that scrutiny, not less: a
 *     compromised release of the package that decides where our sockets go is a
 *     strictly worse event than a compromised release of a build tool.
 *  3. The whole capability is available from the standard library, on documented
 *     and stable API surface: `http.request`/`https.request` accept a `lookup`,
 *     and `tls` derives SNI and the identity check from the hostname we keep.
 *     Nothing here is a private API and nothing is version-fragile.
 *
 * The cost of that choice is this file: a small, deliberate re-implementation of
 * the slice of `fetch` the guarded call sites actually use, rather than a
 * `dispatcher` option handed to somebody else's fetch. That is a real cost and
 * it is why this module is scoped as tightly as it is — it is not a general
 * fetch, it is the transport for already-validated egress.
 *
 * ── MULTI-ADDRESS SEMANTICS ──────────────────────────────────────────────────
 *
 * The guard validates EVERY address a host resolves to, and this transport pins
 * to that **whole set**, not to `addresses[0]`. The injected `lookup` answers
 * with the full validated list (honouring Node's `all` / `family` contract), so
 * Node's own `autoSelectFamily` connect logic picks and fails over among them
 * exactly as it would for a real DNS answer — a legitimately multi-homed or
 * dual-stack endpoint keeps working, including the case where the first address
 * is unreachable. The security property is unchanged and is the important half:
 * an address that was never validated can never be dialled, because the resolver
 * that would have produced it is never consulted.
 *
 * Connection reuse is keyed on that address set (`agentFor`), not just on
 * host:port. Node's `Agent.getName()` does NOT include `lookup`, so a single
 * shared agent would happily hand a request pinned to address A a pooled socket
 * that was opened to address B for the same hostname — which would quietly
 * undo the pin. One agent per (scheme, validated address set) makes reuse
 * impossible across different pins.
 */

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** The already-validated destination. Mirrors `EgressAllowed` by design — the
 * transport is only ever handed a decision the guard has just approved. */
export interface PinnedTarget {
  /** normalized absolute URL, WITH its original hostname (never an IP rewrite) */
  url: string;
  protocol: "http:" | "https:";
  /** normalized hostname (or IP literal, when the URL named one) */
  host: string;
  port: number;
  /** every address the guard validated, in resolver order */
  addresses: string[];
}

type LookupAllCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: Array<{ address: string; family: number }>,
) => void;
type LookupOneCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

interface LookupOptions {
  /** node's own type widens this to `4 | 6 | 0 | "IPv4" | "IPv6"` */
  family?: number | string | undefined;
  hints?: number | undefined;
  all?: boolean | undefined;
  verbatim?: boolean | undefined;
}

function wantedFamily(family: number | string | undefined): 0 | 4 | 6 {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

/**
 * A `lookup` that performs NO resolution. This is the entire fix: it hands back
 * the addresses the guard validated a moment ago, so the connect path cannot
 * observe a different DNS answer than the check did.
 */
export function pinnedLookup(addresses: string[]) {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return (
    hostname: string,
    options: LookupOptions | number,
    callback: LookupAllCallback | LookupOneCallback,
  ): void => {
    const opts: LookupOptions = typeof options === "number" ? { family: options } : (options ?? {});
    const wanted = wantedFamily(opts.family);
    const matching = wanted === 0 ? entries : entries.filter((e) => e.family === wanted);
    if (matching.length === 0) {
      const err = new Error(
        `getaddrinfo ENOTFOUND ${hostname} — no validated address for the requested family`,
      ) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      (callback as LookupAllCallback)(err, []);
      return;
    }
    if (opts.all) {
      (callback as LookupAllCallback)(null, matching.map((e) => ({ ...e })));
      return;
    }
    (callback as LookupOneCallback)(null, matching[0]!.address, matching[0]!.family);
  };
}

// ---------------------------------------------------------------------------
// agents — one per (scheme, validated address set); see the header note
// ---------------------------------------------------------------------------

const MAX_POOLED_AGENTS = 128;
const agents = new Map<string, http.Agent>();

function agentFor(protocol: "http:" | "https:", addresses: string[]): http.Agent {
  const key = `${protocol}|${addresses.join(",")}`;
  const existing = agents.get(key);
  if (existing) {
    // touch for LRU ordering
    agents.delete(key);
    agents.set(key, existing);
    return existing;
  }
  const created =
    protocol === "https:"
      ? new https.Agent({ keepAlive: true, maxSockets: 64 })
      : new http.Agent({ keepAlive: true, maxSockets: 64 });
  agents.set(key, created);
  while (agents.size > MAX_POOLED_AGENTS) {
    const oldest = agents.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    agents.get(oldest)?.destroy();
    agents.delete(oldest);
  }
  return created;
}

/** Test hook: drop every pooled socket. Never called by production code. */
export function resetPinnedAgents(): void {
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

// ---------------------------------------------------------------------------
// response adaptation
// ---------------------------------------------------------------------------

const SAFE_STATUS_TEXT = /^[\t\x20-\x7e\x80-\xff]*$/;

function toResponse(res: http.IncomingMessage, url: string, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.append(name, value);
  }

  // Node's http client does not decode content-encoding; undici's fetch does,
  // and every caller here was written against fetch. Keep the contract.
  let stream: NodeJS.ReadableStream = res;
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
  if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
  else if (encoding === "deflate") stream = res.pipe(createInflate());
  else if (encoding === "br") stream = res.pipe(createBrotliDecompress());
  if (stream !== res) {
    // the decoded body no longer matches either header
    headers.delete("content-encoding");
    headers.delete("content-length");
    res.on("error", (err) => (stream as Readable).destroy(err));
  }

  const status = res.statusCode ?? 502;
  const statusText =
    res.statusMessage && SAFE_STATUS_TEXT.test(res.statusMessage) ? res.statusMessage : "";
  const bodyless = status === 204 || status === 205 || status === 304 || method === "HEAD";
  if (bodyless) res.resume();

  const response = new Response(
    bodyless ? null : (Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>),
    { status, statusText, headers },
  );
  // a constructed Response has an empty `url`; several SDKs surface it in error
  // messages, so give it the real one (the hostname form, not the address)
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

// ---------------------------------------------------------------------------
// the transport
// ---------------------------------------------------------------------------

/**
 * Issue an already-validated request over a connection pinned to the validated
 * addresses. Not a general-purpose fetch: it is only ever reached with a
 * destination `checkEgress` approved microseconds earlier.
 *
 * The request body is buffered before the socket is opened. Every guarded call
 * site in this repo sends a JSON document, and buffering is what makes Node's
 * multi-address connect logic safe to use — nothing is written to a socket
 * until one is established.
 */
export async function pinnedFetch(target: PinnedTarget, init?: RequestInit): Promise<Response> {
  // `Request` is the spec-correct normalizer for method/headers/body — it turns
  // string | URLSearchParams | Blob | FormData | stream into bytes and supplies
  // the matching content-type, so this module does not re-derive any of it.
  const normalized = new Request(target.url, { ...(init ?? {}), redirect: "manual" });
  const bodyBytes = normalized.body ? Buffer.from(await normalized.arrayBuffer()) : null;

  const u = new URL(target.url);
  const path = `${u.pathname}${u.search}`;

  const headers: Record<string, string> = {};
  normalized.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (bodyBytes) headers["content-length"] = String(bodyBytes.length);
  else if (!("content-length" in headers) && normalized.method !== "GET" && normalized.method !== "HEAD") {
    headers["content-length"] = "0";
  }
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "gzip, deflate, br";

  // `addresses` is never empty for an allowed decision, but fall back to the
  // host so a literal-only target can never end up with an empty pin set.
  const addresses = target.addresses.length > 0 ? target.addresses : [target.host];
  const mod = target.protocol === "https:" ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const options: https.RequestOptions = {
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      path,
      method: normalized.method,
      headers,
      agent: agentFor(target.protocol, addresses),
      // THE PIN. No `servername` override and no `checkServerIdentity` override:
      // `host` is still the hostname, so TLS does both from it, unchanged.
      lookup: pinnedLookup(addresses),
      ...(normalized.signal ? { signal: normalized.signal } : {}),
    };
    const clientReq = mod.request(options, (res) => {
      if (settled) return;
      settled = true;
      try {
        resolve(toResponse(res, target.url, normalized.method));
      } catch (err) {
        res.resume();
        reject(new TypeError("fetch failed", { cause: err }));
      }
    });
    clientReq.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new TypeError("fetch failed", { cause: err }));
    });
    if (bodyBytes) clientReq.end(bodyBytes);
    else clientReq.end();
  });
}

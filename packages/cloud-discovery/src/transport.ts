/**
 * ADR-0195 decision 8: every cloud SDK call leaves through the caller's guarded fetch.
 *
 * The cloud SDKs bring their own HTTP stacks (node:http/https for the AWS SDK and Azure, gaxios and gRPC for
 * Google). Left alone they would dial any host the SDK decides on, around the egress allow list. This module turns
 * one `fetch` (in production the gateway's `createGuardedFetch`, which re-validates every request against the
 * allow list, pins DNS and refuses redirects) into the three transports the SDKs accept:
 *
 *  - AWS SDK v3: `@smithy/fetch-http-handler`'s `FetchHttpHandler` with its `customFetch` option. Open source first
 *    (ADR-0176): the handler is the SDK's own; we only hand it our fetch.
 *  - Azure (`@azure/core-rest-pipeline`): a custom `HttpClient`. The pipeline package exports no fetch-based client
 *    for Node that takes a custom fetch (`createDefaultHttpClient` is node:https on Node), so the small adapter
 *    below is ours. Recorded under ADR-0176 rule 4: no validated module meets the requirement.
 *  - Google: a `Gaxios` instance with `fetchImplementation`, set as the `transporter` of the auth client, and the
 *    GAPIC clients run in REST fallback mode (`fallback: true`), where google-gax sends every call through
 *    `authClient.fetch` and therefore through that transporter. gRPC is never used.
 *
 * Whatever is passed in is the ONLY network path: nothing here falls back to global `fetch`, and a test proves a
 * willing spy on node:http, node:https and global fetch sees nothing when the guard refuses.
 */
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { createHttpHeaders, type HttpClient, type PipelineRequest, type PipelineResponse } from "@azure/core-rest-pipeline";
// google-auth-library is CommonJS; its own re-export gives the same Gaxios class it checks against, where a
// direct ESM import of gaxios would load a second copy (the dual-package hazard).
import { gaxios } from "google-auth-library";

/** the one network primitive every adapter is built from */
export type GuardedFetch = typeof fetch;

/**
 * Some callers (the smithy fetch handler) pass a `Request` object and no init. The gateway's guarded fetch reads
 * method, headers and body from `init`, so a bare `Request` would lose its method and body. This unpacks a `Request`
 * into `(url, init)` before the guard sees it, so the guard validates the same URL that is sent.
 */
export function requestAwareFetch(guarded: GuardedFetch): GuardedFetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string" || input instanceof URL) return guarded(input, init);
    const method = init?.method ?? input.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = init?.body ?? (hasBody ? await input.arrayBuffer() : undefined);
    const headers = new Headers(input.headers);
    if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    const merged: RequestInit = { method, headers };
    if (body !== undefined && hasBody) merged.body = body;
    const signal = init?.signal ?? input.signal;
    if (signal) merged.signal = signal;
    return guarded(input.url, merged);
  };
  return wrapped as GuardedFetch;
}

/** a body larger than its cap: the read stopped there and nothing past it was buffered */
export class BodyTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`response body exceeds the ${max}-byte cap; not read further`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a body with a running byte cap (review of #404, recheck finding 3): chunks are counted as they arrive and the
 * stream is cancelled the moment the total passes `max`, so a missing or false Content-Length cannot make a scanner
 * buffer an unbounded body.
 */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null | undefined, max: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** called with every short-lived credential an adapter obtains or sends, so the caller can scrub it (SD0 registerSecret) */
export type SecretSink = (value: string) => void;

const TOKEN_KEYS = ["access_token", "accessToken", "id_token", "refresh_token", "token"] as const;
/** a token-exchange response body is parsed for tokens up to this size */
const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * Wraps a fetch so every bearer credential it SENDS is handed to `sink` before the request leaves: the token in
 * `Authorization: Bearer ...` (Google and Azure access tokens, Google's self-signed JWT) and an AWS session token
 * in `x-amz-security-token`.
 */
export function captureSentSecrets(fetchImpl: GuardedFetch, sink: SecretSink): GuardedFetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const auth = headers.get("authorization");
    if (auth && auth.slice(0, 7).toLowerCase() === "bearer ") sink(auth.slice(7).trim());
    const session = headers.get("x-amz-security-token");
    if (session) sink(session);
    return fetchImpl(input, init);
  };
  return wrapped as GuardedFetch;
}

/**
 * Wraps the CREDENTIAL fetch so every token a token exchange RETURNS (OAuth `access_token`, IAM Credentials
 * `accessToken`, ...) is handed to `sink` before the caller sees the response.
 */
export function captureReturnedTokens(fetchImpl: GuardedFetch, sink: SecretSink): GuardedFetch {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const res = await fetchImpl(input, init);
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      try {
        const body: unknown = JSON.parse(new TextDecoder().decode(await readBodyCapped(res.clone().body, TOKEN_RESPONSE_MAX_BYTES)));
        if (body && typeof body === "object") {
          for (const k of TOKEN_KEYS) {
            const v = (body as Record<string, unknown>)[k];
            if (typeof v === "string" && v.length > 0) sink(v);
          }
        }
      } catch {
        // not JSON, or over the cap: nothing to register from the body
      }
    }
    return res;
  };
  return wrapped as GuardedFetch;
}

/** an OIDC supplier whose every minted token is registered before it is presented */
export function captureSupplied<T extends (audience: string) => Promise<string>>(supplier: T | undefined, sink: SecretSink | undefined): T | undefined {
  if (!supplier || !sink) return supplier;
  return (async (audience: string) => {
    const token = await supplier(audience);
    sink(token);
    return token;
  }) as T;
}

/** an Azure management, Resource Graph or Log Analytics response is read up to this many bytes */
export const AZURE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/** AWS SDK v3 `requestHandler` that sends through the guarded fetch */
export function guardedAwsRequestHandler(fetchImpl: GuardedFetch, requestTimeoutMs = 30_000): FetchHttpHandler {
  return new FetchHttpHandler({ customFetch: requestAwareFetch(fetchImpl), requestTimeout: requestTimeoutMs });
}

function toBody(body: PipelineRequest["body"]): RequestInit["body"] | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body as Uint8Array<ArrayBuffer>;
  if (body instanceof ArrayBuffer) return body;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body;
  // Streams, multipart and form bodies are never produced by the read-only list and query calls this package
  // makes. Refuse rather than guess how to serialise them.
  throw new Error("cloud-discovery: unsupported Azure request body type");
}

/** `@azure/core-rest-pipeline` HttpClient over the guarded fetch */
export class GuardedAzureHttpClient implements HttpClient {
  readonly #fetch: GuardedFetch;
  readonly #maxBytes: number;
  constructor(fetchImpl: GuardedFetch, maxBytes = AZURE_RESPONSE_MAX_BYTES) {
    this.#fetch = fetchImpl;
    this.#maxBytes = maxBytes;
  }

  async sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
    const headers = new Headers();
    for (const [name, value] of request.headers) headers.set(name, value);
    const init: RequestInit = { method: request.method, headers };
    const body = toBody(request.body);
    if (body !== undefined) init.body = body;
    const signals: AbortSignal[] = [];
    if (request.abortSignal) signals.push(request.abortSignal as AbortSignal);
    if (request.timeout > 0) signals.push(AbortSignal.timeout(request.timeout));
    if (signals.length === 1) init.signal = signals[0]!;
    else if (signals.length > 1) init.signal = AbortSignal.any(signals);

    const res = await this.#fetch(request.url, init);
    const responseHeaders = createHttpHeaders();
    res.headers.forEach((v, k) => responseHeaders.set(k, v));
    const bytes = await readBodyCapped(res.body, this.#maxBytes);
    return { request, status: res.status, headers: responseHeaders, bodyAsText: new TextDecoder().decode(bytes) };
  }
}

/** a Gaxios transporter for google-auth-library clients that sends through the guarded fetch */
export function guardedGaxios(fetchImpl: GuardedFetch): gaxios.Gaxios {
  return new gaxios.Gaxios({ fetchImplementation: requestAwareFetch(fetchImpl) as never });
}

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
  constructor(fetchImpl: GuardedFetch) {
    this.#fetch = fetchImpl;
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
    return { request, status: res.status, headers: responseHeaders, bodyAsText: await res.text() };
  }
}

/** a Gaxios transporter for google-auth-library clients that sends through the guarded fetch */
export function guardedGaxios(fetchImpl: GuardedFetch): gaxios.Gaxios {
  return new gaxios.Gaxios({ fetchImplementation: requestAwareFetch(fetchImpl) as never });
}

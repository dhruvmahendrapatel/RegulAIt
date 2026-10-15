/**
 * ADR-0190 I3 — THE CHANNEL CLIENT: the executor's seven routes, plus I4's
 * two stdio session routes (`EXECUTOR_STDIO_ROUTES`), and nothing else. Every request is authorised by the
 * `ChannelCredential`; every answer is parsed with the shared schema before
 * it is believed. As ADR-0187's runner client: a request is bounded in time;
 * a timeout, a 5xx, a 408, a 429 or a success whose body is not a valid
 * answer is TRANSIENT (retried by the loop); a refusal carries the gateway's
 * `error` code and, when given, the one `next` signal the loop acts on.
 */
import {
  EXECUTOR_CHANNEL_PREFIX,
  EXECUTOR_NEXT,
  EXECUTOR_STREAM_WINDOW,
  executorAcceptResponseSchema,
  executorAnnounceResponseSchema,
  executorReportResponseSchema,
  executorSelfTestResponseSchema,
  executorStdioMessageSchema,
  executorStdioPostResponseSchema,
  executorStreamMessageSchema,
  type ExecutorAnnounce,
  type ExecutorStdioMessage,
  type ExecutorStdioPost,
  type ExecutorNext,
  type ExecutorStreamMessage,
  type SignedExecutorReport,
} from "@regulait/shared";
import type { ChannelCredential } from "./channel-credential.js";

import { isIPv4 } from "node:net";

/** review L2: the longest stream line the executor reads (then it drops the stream) */
export const EXECUTOR_STREAM_MAX_LINE_BYTES = 1024 * 1024;
/** review L2: how long past the asked window the stream may stay silent before the executor drops it */
export const EXECUTOR_STREAM_IDLE_SLACK_MS = 15_000;

/** the gateway URL is not one the executor may use (amendment V) */
export class ExecutorConfigError extends Error {}

const isLoopbackHost = (host: string): boolean => {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "[::1]") return true;
  return isIPv4(h) && h.split(".")[0] === "127";
};

/**
 * ADR-0190 amendment V: the executor speaks to the gateway over `https:`.
 * Plain `http:` is accepted for a loopback host, or when the development flag
 * (`allowInsecureHttp`, default off) is set; anything else is refused.
 */
export function checkGatewayUrl(gatewayUrl: string, allowInsecureHttp = false): URL {
  let u: URL;
  try {
    u = new URL(gatewayUrl);
  } catch {
    throw new ExecutorConfigError(`the gateway URL is not a URL: ${gatewayUrl}`);
  }
  if (u.username || u.password) throw new ExecutorConfigError("the gateway URL must not carry credentials");
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && (isLoopbackHost(u.hostname) || allowInsecureHttp)) return u;
  throw new ExecutorConfigError(`the gateway URL must be https: (got ${u.protocol}//${u.host}); plain http is allowed only for a loopback host or with REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP=1 in development`);
}

export type ExecutorRoute = "announce" | "self-test" | "stream" | "accept" | "decline" | "report" | "end" | "stdio";

/** the HTTP seam: `fetch`-shaped, with a body that may stream (the stream route) or be whole text */
export interface ExecutorHttp {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<ExecutorHttpResponse>;
}
export interface ExecutorHttpResponse {
  status: number;
  /** the whole body as text (every route but the stream) */
  text(): Promise<string>;
  /** the body as it arrives (the stream route); absent = read `text()` once */
  lines?: () => AsyncIterable<string>;
}

export interface ExecutorClientOptions {
  /** the gateway as the executor reaches it (`REGULAIT_GATEWAY_URL`), the same origin the proof names */
  gatewayUrl: string;
  credential: ChannelCredential;
  http?: ExecutorHttp;
  /** every non-stream request (body included) is bounded by this (default 30 s) */
  requestTimeoutMs?: number;
  /** development only (amendment V): accept a plain `http:` gateway URL on a non-loopback host; default false */
  allowInsecureHttp?: boolean;
  /** the stream may be silent this long past its window before it is dropped (default EXECUTOR_STREAM_IDLE_SLACK_MS) */
  streamIdleSlackMs?: number;
}

export class ExecutorTimeoutError extends Error {}
/** a stream line above EXECUTOR_STREAM_MAX_LINE_BYTES: the stream is dropped (transient) */
export class ExecutorStreamLineTooLongError extends Error {
  constructor() {
    super(`a stream line exceeded ${EXECUTOR_STREAM_MAX_LINE_BYTES} bytes; stream dropped`);
  }
}
/** a 2xx that is not a valid answer: transient, never an instruction */
export class ExecutorMalformedResponseError extends Error {
  constructor(
    readonly route: ExecutorRoute,
    readonly status: number,
    readonly why: "unparseable" | "schema" | "unexpected_status",
  ) {
    super(`${route} answered ${status} with a body that is not a valid answer (${why}); treated as transient`);
  }
}
/** a refusal: the gateway's code and its `next` signal (never secret material) */
export class ExecutorHttpError extends Error {
  constructor(
    readonly route: ExecutorRoute,
    readonly status: number,
    readonly code: string | null,
    readonly next: ExecutorNext | null = null,
    readonly failures: ReadonlyArray<{ probe: string; code: string }> = [],
  ) {
    super(`${route} refused (${status}${code ? ` ${code}` : ""}${next ? `; next: ${next}` : ""})`);
  }
}

const is2xx = (s: number) => s >= 200 && s < 300;
const nextOf = (v: unknown): ExecutorNext | null => (typeof v === "string" && (EXECUTOR_NEXT as readonly string[]).includes(v) ? (v as ExecutorNext) : null);

/** `fetch` adapted to the seam, with NDJSON line reading for the stream */
export function fetchExecutorHttp(fetchImpl: typeof fetch = fetch): ExecutorHttp {
  return async (url, init) => {
    const res = await fetchImpl(url, init);
    return {
      status: res.status,
      text: () => res.text(),
      lines: async function* () {
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (line) yield line;
            }
            // review L2: a line that never ends is not buffered without bound
            if (buffer.length > EXECUTOR_STREAM_MAX_LINE_BYTES) throw new ExecutorStreamLineTooLongError();
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const rest = buffer.trim();
        if (rest) yield rest;
      },
    };
  };
}

export class ExecutorClient {
  private readonly http: ExecutorHttp;
  private readonly base: string;
  constructor(private readonly opts: ExecutorClientOptions) {
    this.http = opts.http ?? fetchExecutorHttp();
    checkGatewayUrl(opts.gatewayUrl, opts.allowInsecureHttp ?? false);
    let base = opts.gatewayUrl;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.base = base;
  }

  private url(path: string): string {
    return `${this.base}${EXECUTOR_CHANNEL_PREFIX}${path}`;
  }

  private async call(route: ExecutorRoute, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; parsed: boolean; body: unknown }> {
    const url = this.url(path);
    const text = body === undefined ? undefined : JSON.stringify(body);
    const bound = Math.max(1, this.opts.requestTimeoutMs ?? 30_000);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new ExecutorTimeoutError(`${method} ${path} took longer than ${bound} ms`));
      }, bound);
    });
    try {
      return await Promise.race([
        (async () => {
          const auth = await this.opts.credential.authorizeRequest(method, url, text);
          const res = await this.http(url, {
            method,
            headers: { ...auth, ...(text !== undefined ? { "content-type": "application/json" } : {}) },
            ...(text !== undefined ? { body: text } : {}),
            signal: abort.signal,
          });
          if (res.status === 204) return { status: 204, parsed: true, body: null };
          const raw = await res.text();
          try {
            return { status: res.status, parsed: true, body: JSON.parse(raw) as unknown };
          } catch {
            return { status: res.status, parsed: false, body: null };
          }
        })(),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private answer<T>(route: ExecutorRoute, res: { status: number; parsed: boolean; body: unknown }, expected: number, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T {
    if (is2xx(res.status)) {
      if (res.status !== expected) throw new ExecutorMalformedResponseError(route, res.status, "unexpected_status");
      if (!res.parsed) throw new ExecutorMalformedResponseError(route, res.status, "unparseable");
      const a = schema.safeParse(res.body);
      if (!a.success || a.data === undefined) throw new ExecutorMalformedResponseError(route, res.status, "schema");
      return a.data;
    }
    const j = (res.parsed && typeof res.body === "object" && res.body !== null ? res.body : {}) as { error?: unknown; next?: unknown; failures?: unknown };
    const failures = Array.isArray(j.failures) ? (j.failures as Array<{ probe: string; code: string }>) : [];
    throw new ExecutorHttpError(route, res.status, typeof j.error === "string" ? j.error : null, nextOf(j.next), failures);
  }

  async announce(body: ExecutorAnnounce) {
    return this.answer("announce", await this.call("announce", "POST", "/announce", body), 200, executorAnnounceResponseSchema);
  }

  async selfTest(reports: SignedExecutorReport[]) {
    return this.answer("self-test", await this.call("self-test", "POST", "/self-test", { reports }), 200, executorSelfTestResponseSchema);
  }

  async accept(offerId: string) {
    return this.answer("accept", await this.call("accept", "POST", `/offers/${encodeURIComponent(offerId)}/accept`), 200, executorAcceptResponseSchema);
  }

  async decline(offerId: string, reason: string) {
    const res = await this.call("decline", "POST", `/offers/${encodeURIComponent(offerId)}/decline`, { reason });
    if (res.status === 204) return;
    this.answer("decline", res, 204, { safeParse: () => ({ success: true, data: null }) });
  }

  async report(offerId: string, report: SignedExecutorReport) {
    return this.answer("report", await this.call("report", "POST", `/offers/${encodeURIComponent(offerId)}/report`, { report }), 200, executorReportResponseSchema);
  }

  async end(offerId: string, outcome: string) {
    const res = await this.call("end", "POST", `/offers/${encodeURIComponent(offerId)}/end`, { outcome });
    if (res.status === 204) return;
    this.answer("end", res, 204, { safeParse: () => ({ success: true, data: null }) });
  }

  /**
   * Hold the stream for one window. Every line is parsed with the shared
   * schema; a line that is not a message is dropped (never acted on). Returns
   * when the gateway closes the window; throws `ExecutorHttpError` on a
   * refusal, or any transport error (transient).
   */
  async stream(windowSeconds: number, onMessage: (m: ExecutorStreamMessage) => Promise<void> | void, signal?: AbortSignal): Promise<void> {
    const w = Math.min(EXECUTOR_STREAM_WINDOW.max, Math.max(EXECUTOR_STREAM_WINDOW.min, Math.floor(windowSeconds)));
    const url = this.url(`/stream?window=${w}`);
    const auth = await this.opts.credential.authorizeRequest("GET", url, undefined);
    // review L2: the transport is aborted when the caller aborts or the stream goes idle past its window plus slack
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const idleMs = w * 1000 + Math.max(0, this.opts.streamIdleSlackMs ?? EXECUTOR_STREAM_IDLE_SLACK_MS);
    try {
      await this.readStream(url, auth, abort, idleMs, onMessage);
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
      abort.abort();
    }
  }

  /**
   * ADR-0190 I4: hold one window of a placed stdio session (gateway → sandbox):
   * `start`, `stdin` frames, `close`, keepalives, `bye`. Every line is parsed
   * with the shared schema; anything else is dropped, never acted on.
   */
  async stdioStream(offerId: string, windowSeconds: number, onMessage: (m: ExecutorStdioMessage) => Promise<void> | void, signal?: AbortSignal): Promise<void> {
    const w = Math.min(EXECUTOR_STREAM_WINDOW.max, Math.max(EXECUTOR_STREAM_WINDOW.min, Math.floor(windowSeconds)));
    const url = this.url(`/offers/${encodeURIComponent(offerId)}/stdio?window=${w}`);
    const auth = await this.opts.credential.authorizeRequest("GET", url, undefined);
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const idleMs = w * 1000 + Math.max(0, this.opts.streamIdleSlackMs ?? EXECUTOR_STREAM_IDLE_SLACK_MS);
    try {
      await this.readStream(url, auth, abort, idleMs, onMessage, executorStdioMessageSchema, "stdio", (m) => m.type === "bye");
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
      abort.abort();
    }
  }

  /** ADR-0190 I4: sandbox → gateway, a batch of stdout frames and/or eof */
  async stdioPost(offerId: string, body: ExecutorStdioPost) {
    return this.answer("stdio", await this.call("stdio", "POST", `/offers/${encodeURIComponent(offerId)}/stdio`, body), 200, executorStdioPostResponseSchema);
  }

  private async readStream<M>(
    url: string,
    auth: Record<string, string>,
    abort: AbortController,
    idleMs: number,
    onMessage: (m: M) => Promise<void> | void,
    schema: { safeParse(v: unknown): { success: true; data: M } | { success: false } } = executorStreamMessageSchema as never,
    route: ExecutorRoute = "stream",
    isBye: (m: M) => boolean = (m) => (m as { type?: string }).type === "bye",
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new ExecutorTimeoutError(`the stream was idle for more than ${idleMs} ms; dropped`));
          }, idleMs);
        }),
      ]).finally(() => clearTimeout(timer));
    const res = await idle(this.http(url, { method: "GET", headers: auth, signal: abort.signal }));
    if (!is2xx(res.status)) {
      let j: { error?: unknown; next?: unknown } = {};
      try {
        j = JSON.parse(await idle(res.text())) as typeof j;
      } catch {
        // a refusal with no JSON body still refuses
      }
      throw new ExecutorHttpError(route, res.status, typeof j.error === "string" ? j.error : null, nextOf(j.next));
    }
    const lines = res.lines
      ? res.lines()
      : (async function* (text: string) {
          for (const line of text.split("\n")) if (line.trim()) yield line.trim();
        })(await idle(res.text()));
    const it = lines[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await idle(it.next());
        if (step.done) return;
        const line = step.value;
        if (Buffer.byteLength(line, "utf8") > EXECUTOR_STREAM_MAX_LINE_BYTES) throw new ExecutorStreamLineTooLongError();
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const m = schema.safeParse(parsed);
        if (!m.success) continue;
        await onMessage(m.data);
        if (isBye(m.data)) return;
      }
    } finally {
      void Promise.resolve(it.return?.()).catch(() => undefined);
    }
  }
}

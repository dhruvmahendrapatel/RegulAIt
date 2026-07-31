/**
 * Same-origin API client (ADR-0025 contract):
 *  - the browser credential is the HttpOnly session cookie — never a token in
 *    JS; `credentials: "include"` keeps it riding on every call;
 *  - every state-changing request carries the `x-regulait-csrf: 1` header —
 *    the browser-model-independent CSRF wall the gateway enforces;
 *  - a 401 mid-app means the session died: the registered handler routes the
 *    shell back to /login with a return-to.
 */

export const CSRF_HEADER = "x-regulait-csrf";

export interface ApiErrorPayload {
  error?: string;
  detail?: string;
  message?: string;
  raw?: string;
  issues?: Array<{ path?: Array<string | number>; message: string }>;
  decision?: { reason?: string };
  [k: string]: unknown;
}

export class ApiError extends Error {
  status: number;
  payload: ApiErrorPayload;
  constructor(status: number, payload: ApiErrorPayload) {
    super(errMessage(status, payload));
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

/** every reason the server volunteered, most specific first (mirrors the
 * legacy UIs' shared errDetails so messages read identically). */
function errDetails(json: ApiErrorPayload | null): string[] {
  if (!json || typeof json !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(json.issues)) {
    for (const i of json.issues) {
      out.push(((i.path ?? []).join(".") || "body") + ": " + i.message);
    }
  }
  if (typeof json.detail === "string") out.push(json.detail);
  if (json.decision?.reason) out.push(json.decision.reason);
  if (typeof json.message === "string" && json.message !== json.error) out.push(json.message);
  if (typeof json.raw === "string" && json.raw.trim()) out.push(json.raw.trim().slice(0, 200));
  return out;
}

export function errMessage(status: number, json: ApiErrorPayload | null): string {
  const head = (json && json.error) || "HTTP " + status;
  const details = errDetails(json);
  return details.length ? head + " — " + details.join("; ") : head;
}

let onUnauthorized: (() => void) | null = null;
/** the session provider registers the single 401 handler (route to /login). */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: {
      [CSRF_HEADER]: "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    onUnauthorized?.();
    const payload = await parseBody(res);
    throw new ApiError(401, payload ?? { error: "unauthenticated" });
  }
  const json = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, json ?? { error: "HTTP " + res.status });
  return (json ?? {}) as T;
}

async function parseBody(res: Response): Promise<ApiErrorPayload | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as ApiErrorPayload;
  } catch {
    return { raw: text };
  }
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/**
 * POST that may answer as an SSE stream (the invoke / run-auto endpoints).
 * Returns the raw Response — callers check the content-type and either walk
 * the stream via readSse() or fall back to buffered JSON.
 */
export function ssePost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { [CSRF_HEADER]: "1", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/** Walk a text/event-stream body, invoking onEvent(name, parsedData) per event. */
export async function readSse(
  res: Response,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /event: (.+)/.exec(chunk)?.[1];
      const data = /data: (.+)/.exec(chunk)?.[1];
      if (!ev || !data) continue;
      try {
        onEvent(ev, JSON.parse(data));
      } catch {
        // a malformed frame is skipped, never fatal to the stream
      }
    }
  }
}

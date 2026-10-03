/**
 * Same-origin API client (ADR-0025 contract):
 *  - the browser credential is the HttpOnly session cookie — never a token in
 *    JS; `credentials: "include"` keeps it riding on every call;
 *  - every state-changing request carries the `x-regulait-csrf: 1` header —
 *    the browser-model-independent CSRF wall the gateway enforces;
 *  - a 401 that says the SESSION is gone routes the shell back to /login with
 *    a return-to, via the registered handler. A 401 that says the thing just
 *    submitted was wrong (a TOTP code, the current password, a login attempt)
 *    stays with the form that sent it — see isSessionLoss().
 */

export const CSRF_HEADER = "x-regulait-csrf";

export interface ApiErrorPayload {
  error?: string;
  detail?: string;
  message?: string;
  raw?: string;
  /**
   * A zod-shaped issue list. `path` arrives BOTH WAYS across this API: zod's
   * own `flatten()` sends an array, and most hand-written handlers send it
   * already joined (`path: i.path.join(".")`). Both spellings are real and the
   * type says so — assuming the array shape is what made every such refusal
   * render as a TypeError instead of its reason.
   */
  issues?: Array<{ path?: Array<string | number> | string; message: string }>;
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
      // NEVER let formatting a refusal throw. This used to call `.join` on a
      // path the gateway had already joined into a string, so the TypeError
      // escaped from the ApiError constructor and the operator was shown a
      // JavaScript error instead of the reason the platform gave. A refusal
      // that cannot be rendered is, in practice, a refusal with no reason.
      const path = Array.isArray(i.path) ? i.path.join(".") : typeof i.path === "string" ? i.path : "";
      out.push((path || "body") + ": " + i.message);
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

/**
 * The 401 reasons the gateway's auth preHandler sends when the CREDENTIAL no
 * longer authenticates (apps/gateway/src/app.ts preHandler, plus auth.ts's
 * AUTH_REFUSAL_DETAIL set). Every other 401 is a route's own verdict on the
 * request body — `invalid_code` from /auth/totp/activate,
 * `current_password_incorrect` from /auth/change-password, the uniform
 * `invalid_credentials` from /auth/login — and the session behind it is intact.
 * Treating those as "session gone" bounced the user to a blank /login for a
 * typo (UIW-01).
 */
const SESSION_LOST_CODES = new Set([
  "unauthenticated",
  "user_disabled",
  "ip_not_allowed",
  "disabled",
  "virtual_key_revoked",
  "virtual_key_expired",
  "api_key_expired",
  "api_key_revoked",
]);
/** routes whose 401s judge what was typed, never the session that typed it */
const SESSION_KEPT_PREFIXES = ["/auth/login", "/auth/totp/", "/auth/change-password"];

/** does this 401 mean the session is gone (route to /login), or only that the
 * request was refused (the form shows it inline)? */
export function isSessionLoss(path: string, payload: ApiErrorPayload | null): boolean {
  const route = path.split("?")[0] ?? path;
  if (SESSION_KEPT_PREFIXES.some((p) => route.startsWith(p))) return false;
  const code = payload?.error;
  // no code at all is not something the gateway sends; read it the old way
  if (typeof code !== "string" || code === "") return true;
  return SESSION_LOST_CODES.has(code);
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
    const payload = await parseBody(res);
    if (isSessionLoss(path, payload)) onUnauthorized?.();
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
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  /** DELETE, optionally carrying a body — some revocations require an audited
   * reason (ADR-0069's `DELETE /v1/cost-imports/:id`), and a reason posted in a
   * query string is a reason nobody can quote back. Omitting the body keeps the
   * request byte-identical to what every pre-existing caller sent. */
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
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

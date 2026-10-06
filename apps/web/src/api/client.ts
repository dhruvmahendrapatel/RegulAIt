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

import { humanize } from "./format";

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

/**
 * A zod issue as a sentence an operator can act on. Zod's own wording
 * ("String must contain at least 1 character(s)", "Invalid uuid") names the
 * type system, not the field; the field key arrives camel-cased. Both reached
 * the screen verbatim (UIA-03 / UIB-02). Anything this does not recognise is
 * passed through unchanged — a hand-written refinement message ("first stage
 * must be a trigger") is already prose.
 */
const ISSUE_PHRASES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Required$/, () => "is required"],
  [/^String must contain at least (\d+) character\(s\)$/, (m) => (m[1] === "1" ? "is required" : `must be at least ${m[1]} characters`)],
  [/^String must contain at most (\d+) character\(s\)$/, (m) => `must be at most ${m[1]} characters`],
  [/^Array must contain at least (\d+) element\(s\)$/, (m) => (m[1] === "1" ? "needs at least one entry" : `needs at least ${m[1]} entries`)],
  [/^Array must contain at most (\d+) element\(s\)$/, (m) => `can hold at most ${m[1]} entries`],
  [/^Invalid uuid$/i, () => "is not a valid ID"],
  [/^Invalid url$/i, () => "is not a valid URL"],
  [/^Invalid email$/i, () => "is not a valid email address"],
  [/^Invalid datetime$/i, () => "is not a valid date and time"],
  [/^Number must be greater than or equal to (.+)$/, (m) => `must be ${m[1]} or more`],
  [/^Number must be less than or equal to (.+)$/, (m) => `must be ${m[1]} or less`],
  [/^Number must be greater than (.+)$/, (m) => `must be more than ${m[1]}`],
  [/^Number must be less than (.+)$/, (m) => `must be less than ${m[1]}`],
  [/^Expected (\w+), received (?:\w+)$/, (m) => `must be ${/^[aeiou]/i.test(m[1]!) ? "an" : "a"} ${m[1]}`],
  [/^Invalid enum value\. Expected (.+), received .+$/, (m) => `must be one of ${m[1]!.replace(/'/g, "\u2018").replace(/\s*\|\s*/g, ", ").replace(/\u2018/g, "")}`],
];

/** `budgetUsd` → "Budget USD", `items.2.connectorId` → "Connector ID"; "" for the body itself */
function fieldLabel(path: string): string {
  const last = path.split(".").filter((seg) => seg && !/^\d+$/.test(seg)).pop() ?? "";
  if (!last) return "";
  return humanize(last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());
}

export function issueText(path: string, message: string): string {
  const label = fieldLabel(path);
  for (const [re, phrase] of ISSUE_PHRASES) {
    const m = message.match(re);
    if (m) return `${label || "This request"} ${phrase(m)}`;
  }
  const prose = message.replace(/^./, (c) => c.toUpperCase());
  return label ? `${label}: ${message}` : prose;
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
      out.push(issueText(path, typeof i.message === "string" ? i.message : String(i.message)));
    }
  }
  if (typeof json.detail === "string") out.push(json.detail);
  if (json.decision?.reason) out.push(json.decision.reason);
  if (typeof json.message === "string" && json.message !== json.error) out.push(json.message);
  if (typeof json.raw === "string" && json.raw.trim()) out.push(json.raw.trim().slice(0, 200));
  return out;
}

/**
 * The gateway's bare refusal codes as sentences (UXJ-04). The code itself
 * stays on `payload.error` for the callers that branch on it and for the
 * outcome badge; this is only what a person reads.
 */
const CODE_SENTENCES: Record<string, string> = {
  unauthenticated: "Your session has ended — sign in again",
  internal: "Something went wrong on the server — try again, and tell an administrator if it keeps happening",
  internal_error: "Something went wrong on the server — try again, and tell an administrator if it keeps happening",
  conflict: "This conflicts with a record that already exists",
  unavailable: "This record isn't available — it may not exist, or it may belong to someone else",
  not_found: "No such record",
  unknown_project: "No project with this ID exists",
  not_a_project_member: "You're not a member of this project",
  forbidden: "Your account doesn't have permission for this",
  admin_only: "Only an administrator can do this",
  rate_limited: "Too many requests — wait a moment and try again",
  network: "Couldn't reach the server — check your connection and try again",
};
/** codes whose details already say everything; the code adds nothing a reader needs */
const DETAILS_SUFFICE = new Set(["validation", "not_found"]);

/** a refusal code as words: a known one as its sentence, any other as `humanize(code)` */
export function codeSentence(code: string): string {
  if (/^HTTP \d+$/.test(code)) return code;
  return CODE_SENTENCES[code] ?? humanize(code);
}

export function errMessage(status: number, json: ApiErrorPayload | null): string {
  const code = json && typeof json.error === "string" && json.error ? json.error : "HTTP " + status;
  const details = errDetails(json);
  if (details.length && DETAILS_SUFFICE.has(code)) return details.join("; ");
  const head = codeSentence(code);
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
/**
 * Routes a user hits BEFORE they have a session. A 401 here is the verdict on
 * the attempt (`invalid_credentials`, `invalid_key`, a wrong MFA code) and
 * there is no session to lose, so the handler never fires — whatever the code
 * says. The session-bound self-service routes (/auth/totp/*,
 * /auth/change-password) are NOT here on purpose: their own verdicts
 * (`invalid_code`, `current_password_incorrect`) are not in the set above and
 * stay inline, but the preHandler's `unauthenticated` on the same path means
 * the session behind the form has died — a forced password change or MFA
 * enrolment that idled out must still land on /login, not show the raw code
 * on a dead shell.
 */
const PRE_SESSION_PREFIXES = ["/auth/login", "/auth/mfa/verify"];

/** does this 401 mean the session is gone (route to /login), or only that the
 * request was refused (the form shows it inline)? */
export function isSessionLoss(path: string, payload: ApiErrorPayload | null): boolean {
  const route = path.split("?")[0] ?? path;
  if (PRE_SESSION_PREFIXES.some((p) => route.startsWith(p))) return false;
  const code = payload?.error;
  // no code at all is not something the gateway sends; read it the old way
  if (typeof code !== "string" || code === "") return true;
  return SESSION_LOST_CODES.has(code);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await send<T>(method, path, body)).body;
}

/** the request itself, with the response headers (an idempotent replay is told apart by one) */
async function send<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<{ body: T; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      headers: {
        [CSRF_HEADER]: "1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(extraHeaders ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    // the browser's "Failed to fetch" is not a reason anyone can act on
    throw new Error(CODE_SENTENCES.network, { cause });
  }
  if (res.status === 401) {
    const payload = await parseBody(res);
    if (isSessionLoss(path, payload)) onUnauthorized?.();
    throw new ApiError(401, payload ?? { error: "unauthenticated" });
  }
  const json = await parseBody(res);
  if (!res.ok) throw new ApiError(res.status, json ?? { error: "HTTP " + res.status });
  return { body: (json ?? {}) as T, headers: res.headers };
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
  /** POST with extra request headers (e.g. `Idempotency-Key`), answering the body and the response headers */
  postWithHeaders: <T>(path: string, body: unknown, headers: Record<string, string>) => send<T>("POST", path, body, headers),
  /** PUT with extra request headers (e.g. the intake draft's owner precondition, ADR-0179) */
  putWithHeaders: async <T>(path: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) =>
    (await send<T>("PUT", path, body, headers, signal)).body,
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
    // ADR-0181: `streamingOnBlockMode` defaults to 'reject', which refuses a
    // stream request outright when an output control is in block mode — the
    // right answer for a client that REQUIRES a stream. This client does not:
    // it renders a buffered answer too, so it says so, and gets ADR-0019's
    // buffered, disclosed reply (`streamingSuppressed`) instead of a 400.
    headers: { [CSRF_HEADER]: "1", "content-type": "application/json", [ACCEPT_BUFFERED_HEADER]: "1" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/** the request header that tells the gateway a buffered answer is acceptable */
export const ACCEPT_BUFFERED_HEADER = "x-regulait-accept-buffered";

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

/**
 * ADR-0167 (CFG-02) — the serving process logs.
 *
 * `buildApp` was constructed with `logger: false`, which makes Fastify install
 * abstract-logging: every `app.log.error` in the error handler and every
 * `app.log.warn` on the boot timers was a no-op. A 500's reason was discarded
 * unless an undocumented `DEBUG_ERRORS` happened to be set, and a 401/403/404
 * flood — route scanning, key guessing — left no trace at all, on a product
 * whose pitch is that every call is accounted for.
 *
 * The logger is resolved HERE and handed in from the boot path (boot.ts), not
 * switched on inside `buildApp`: ~100 test files construct apps and would
 * otherwise spam stdout. pino ships with Fastify, so this adds no dependency.
 *
 * REDACTION IS THE POINT. The request serializer never sees the Authorization,
 * Cookie or x-api-key headers, and a response's Set-Cookie is masked, so a log
 * shipped to a collector cannot leak a credential. What IS logged per refusal
 * is the route, the method, the status, the client IP and the credential KIND
 * (bootstrap / api-key / virtual-key / session / none) — enough to see a
 * spray, never enough to replay one.
 *
 * D4 DFX2 (D4A-05) — A CREDENTIAL IN THE URL. The public feedback link
 * (`/v1/feedback/l/:token`, an `rglf_` token of 256 bits) authenticates by its
 * path, so the path is a bearer credential. Every line the logger writes goes
 * through `redactLogText` at pino's `streamWrite` hook — the serialized line,
 * whatever logged it (the refusal hook, the error handler's `url`, a message
 * string, a child logger's bindings) — and the refusal line's own `path`
 * field is redacted too. Considered pino `redact` (paths only, cannot match a
 * value inside a string) — it stays for the headers; the hook covers values.
 */
import type { FastifyRequest, FastifyServerOptions } from "fastify";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** URL segments that ARE credentials, and what replaces them in a log line */
const URL_CREDENTIALS: ReadonlyArray<readonly [RegExp, string]> = [
  // the public feedback link: whatever follows /feedback/l/ (a real token, or a near-miss of one)
  [/(\/feedback\/l\/)[^/?#\s"'\\]+/g, "$1[redacted]"],
  // the token itself, wherever it appears (a message, a query string, an error)
  [/\brglf_[0-9A-Za-z]+/g, "rglf_[redacted]"],
];

/**
 * N8 (2026-10-17) — a credential-shaped query parameter. A token in a query
 * string (an OAuth `code`/`state`, a signed link's `sig`, an `access_token`)
 * reaches a log line through any `url` field; the value is replaced, the name
 * stays so the line still says what was sent. R3: a fragment (`#access_token=`,
 * an implicit-flow redirect) is matched as well as a query.
 */
const QUERY_CREDENTIAL = /([?&#](?:access_token|id_token|refresh_token|token|code|state|key|api_key|apikey|secret|password|sig|signature|client_assertion|assertion|session|client_secret|code_verifier|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=)[^&#\s"'\\]*/gi;

/** a log line (or field) with every URL credential replaced */
export function redactLogText(s: string): string {
  let out = s;
  for (const [re, by] of URL_CREDENTIALS) out = out.replace(re, by);
  return out.replace(QUERY_CREDENTIAL, "$1[redacted]");
}

/** the paths pino masks, in its own redact syntax */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'headers["proxy-authorization"]',
  // N8: a request body or query object never belongs in a line; if a future
  // call site logs one, pino masks it whole rather than trusting a scrubber
  "req.body",
  "req.query",
  "body",
  "query",
  "err.body",
  // F4: an outbound client's error nests the request it sent (`config.headers`,
  // `request.headers`, `response.headers`) one level down
  "*.headers.authorization",
  "*.headers.cookie",
  '*.headers["x-api-key"]',
  '*.headers["proxy-authorization"]',
  "err.*.headers.authorization",
  // R2: the other credential headers at the same depth. Deeper shapes
  // (`err.response.config.headers.*`, a non-`err` key two levels down) belong
  // with the gateway `err` serializer slice (ADR-0167, Open)
  "err.*.headers.cookie",
  'err.*.headers["x-api-key"]',
  'err.*.headers["proxy-authorization"]',
] as const;

/**
 * `REGULAIT_LOG=off` silences the process entirely; `LOG_LEVEL` (default
 * `info`) sets the threshold. An unrecognised level falls back to `info`
 * rather than throwing — a typo in a log knob must not stop a deployment.
 */
export function resolveGatewayLogger(env: NodeJS.ProcessEnv = process.env): FastifyServerOptions["logger"] {
  const sw = (env.REGULAIT_LOG ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no", "disabled", "silent"].includes(sw)) return false;
  const raw = (env.LOG_LEVEL ?? "info").trim().toLowerCase();
  const level = (LOG_LEVELS as readonly string[]).includes(raw) ? raw : "info";
  return {
    level,
    redact: { paths: [...LOG_REDACT_PATHS], censor: "[redacted]" },
    // D4 DFX2 (D4A-05): the whole serialized line, every level and status
    hooks: { streamWrite: redactLogText },
    // Fastify's default request serializer already omits the body; the
    // headers are the only place a credential would appear, and they are
    // redacted above.
  };
}

/** one line of text for the boot posture block */
export function describeGatewayLogger(logger: FastifyServerOptions["logger"]): string {
  if (!logger) return "off (REGULAIT_LOG=off) — refusals and failures leave no trace";
  const level = typeof logger === "object" && "level" in logger ? String(logger.level) : "info";
  return `level ${level} (LOG_LEVEL), every 4xx at warn and 5xx at error, credentials redacted`;
}

/** the credential KIND on a request, for the refusal line — never the value */
export function credentialKind(req: FastifyRequest): string {
  const ctx = (req as { authCtx?: { via?: string; userId?: string | null } }).authCtx;
  if (ctx?.via) return ctx.via;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return "bearer-unverified";
  if (typeof req.headers.cookie === "string" && req.headers.cookie.includes("regulait_session=")) {
    return "cookie-unverified";
  }
  return "none";
}

/** the structured fields on every refusal/failure line */
export function requestLogFields(req: FastifyRequest, status: number): Record<string, unknown> {
  const route = req.routeOptions?.url ?? null;
  return {
    status,
    method: req.method,
    route,
    // N8: a matched route's template says where the request went; the raw path
    // is logged only when nothing matched (a scan, a misconfigured client), and
    // then bounded and redacted: a stray path can carry an email or a token
    ...(route === null ? { path: unmatchedPath(req.url) } : {}),
    ip: req.ip ?? null,
    credential: credentialKind(req),
  };
}

/** the longest unmatched path a refusal line carries */
export const UNMATCHED_PATH_MAX = 120;

/** an unmatched request's path: no query, redacted, at most UNMATCHED_PATH_MAX characters */
function unmatchedPath(url: string): string {
  const p = redactLogText(url.split("?")[0] ?? "");
  return p.length > UNMATCHED_PATH_MAX ? `${p.slice(0, UNMATCHED_PATH_MAX)}[truncated]` : p;
}

/**
 * N8 (2026-10-17) — Fastify's own body-parser and validation refusals.
 *
 * The parser's message can quote the uploaded content (Node's `JSON.parse`
 * puts a snippet of the input in its `SyntaxError`; a custom content-type
 * parser may pass that error straight through), and the body may carry
 * personal data or a secret. So neither the log line nor the response carries
 * the parser's message: the caller gets a fixed sentence per code, and the
 * log gets the stable code, the request id (pino's `reqId` binding), the
 * route and the status. SEC-03's mapped error names are unchanged.
 */
const PARSER_DETAIL: Readonly<Record<string, string>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: "The request body is not valid JSON.",
  FST_ERR_CTP_EMPTY_JSON_BODY: "The request body is empty but its content type is JSON.",
  FST_ERR_CTP_BODY_TOO_LARGE: "The request body is too large.",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "The request's content type is not accepted here.",
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: "The request body size did not match its Content-Length.",
  FST_ERR_VALIDATION: "The request did not match the route's schema.",
};

export interface ClientRefusal {
  status: number;
  /** the FST_ERR_* code: the stable thing a log line carries */
  code: string;
  body: { error: string; detail: string };
}

/**
 * The refusal for a Fastify parser or validation error (`FST_ERR_*` with a
 * 4xx status), or null for anything else. Scoped to the FST_ERR_ prefix on
 * purpose (SEC-03): a third-party error that happens to carry a statusCode
 * must not be reported as the caller's fault.
 */
export function parserRefusal(err: unknown): ClientRefusal | null {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  if (
    !e ||
    typeof e.code !== "string" ||
    !e.code.startsWith("FST_ERR_") ||
    typeof e.statusCode !== "number" ||
    e.statusCode < 400 ||
    e.statusCode >= 500
  ) {
    return null;
  }
  return {
    status: e.statusCode,
    code: e.code,
    body: {
      error: e.code.replace(/^FST_ERR_(CTP_)?/, "").toLowerCase(),
      detail: PARSER_DETAIL[e.code] ?? "The request could not be read.",
    },
  };
}

/** the one line a parser or validation refusal leaves: code, route, status (pino binds reqId) */
export function parserRefusalLogFields(req: FastifyRequest, refusal: ClientRefusal): Record<string, unknown> {
  return { code: refusal.code, status: refusal.status, method: req.method, route: req.routeOptions?.url ?? null };
}

const WITHHELD = "[withheld: may quote request input]";

/** an error's stack frames without its first line (the message) */
export function framesOnly(err: Error): string {
  return (err.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).join("\n");
}

/**
 * The fields of an unhandled-error line. The path is logged without its query
 * string (a token in a query must not reach a collector). Two error shapes
 * keep their stack frames but not their message, because the message can
 * quote request input:
 *  - a `SyntaxError` (Node's `JSON.parse` quotes a snippet of what it read);
 *  - a failed database query (drizzle's `DrizzleQueryError` puts every bound
 *    parameter in its message and on `params`, and Postgres's own message and
 *    `detail` quote values: `invalid input syntax for type uuid: "…"`,
 *    `Key (email)=(…) already exists`). The SQL text (as `sql`: `query` is a
 *    redacted path), the SQLSTATE and the
 *    constraint, table and column names stay: they are ours, not the caller's.
 */
export function unhandledErrorLogFields(req: FastifyRequest, err: unknown): Record<string, unknown> {
  const base = {
    status: 500,
    method: req.method,
    route: req.routeOptions?.url ?? null,
    path: redactLogText(req.url.split("?")[0] ?? ""),
  };
  // F2: a wrapper whose `cause` is one of these shapes carries the same text
  // (pino's serializer folds every cause's message into `message`)
  const link = withheldLink(err);
  if (!link) return { ...base, err };
  const top = err as Error;
  const causeType = link === err ? {} : { causeType: link.name };
  if (link instanceof SyntaxError) {
    return { ...base, errType: top.name, ...causeType, errMessage: WITHHELD, errStack: framesOnly(top) };
  }
  if (!isFailedQuery(link)) {
    // R5: a driver error with no drizzle wrapper: no SQL text or params to show
    const d = link as Error & { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      ...base,
      errType: top.name,
      ...causeType,
      errMessage: WITHHELD,
      pgCode: str(d.code),
      pgConstraint: str(d.constraint),
      pgTable: str(d.table),
      pgColumn: str(d.column),
      errStack: framesOnly(top),
    };
  }
  const q = link as Error & { query: string; params: unknown[]; cause?: unknown };
  const pg = (q.cause ?? {}) as { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown };
  const name = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    ...base,
    errType: top.name,
    ...causeType,
    errMessage: WITHHELD,
    sql: q.query,
    params: `[${q.params.length} withheld]`,
    pgCode: name(pg.code),
    pgConstraint: name(pg.constraint),
    pgTable: name(pg.table),
    pgColumn: name(pg.column),
    errStack: framesOnly(top),
  };
}

/** a failed database query: drizzle's `DrizzleQueryError` shape (SQL text plus bound params) */
function isFailedQuery(e: unknown): boolean {
  const q = e as { query?: unknown; params?: unknown } | null;
  return e instanceof Error && typeof q?.query === "string" && Array.isArray(q.params);
}

/**
 * R5: a bare database driver error (node-postgres `DatabaseError`): a five-character
 * SQLSTATE plus the server's `severity` or `detail`. Its message and `detail`
 * quote values (`invalid input syntax for type uuid: "…"`).
 */
function isDriverError(e: unknown): boolean {
  const d = e as { code?: unknown; severity?: unknown; detail?: unknown } | null;
  return (
    e instanceof Error &&
    typeof d?.code === "string" &&
    /^[0-9A-Z]{5}$/.test(d.code) &&
    (typeof d.severity === "string" || typeof d.detail === "string")
  );
}

/**
 * The first link of an error's `cause` chain (the error itself included) whose
 * message can quote request input, or null. Bounded and cycle-safe: a cause
 * chain is caller-shaped data too.
 */
function withheldLink(err: unknown): Error | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < 10 && cur && typeof cur === "object" && !seen.has(cur); depth++) {
    seen.add(cur);
    if (cur instanceof SyntaxError || isFailedQuery(cur) || isDriverError(cur)) return cur as Error;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * N8 F1 — one line of text for an error written OUTSIDE pino (a `console.*`
 * on a post-commit or `finally` path, which skips pino's `redact` and the
 * `streamWrite` scrubber). The same withholding rules as the 500 line: a
 * `SyntaxError` or a failed query anywhere in the cause chain gives its name
 * (and the SQLSTATE) but never its message; anything else gives
 * `Name: message` through `redactLogText`.
 */
export function safeErrorText(err: unknown): string {
  const link = withheldLink(err);
  if (link) {
    const top = err as Error;
    const pgCode = isDriverError(link)
      ? (link as { code?: unknown }).code
      : (link as { cause?: { code?: unknown } }).cause?.code;
    const via = link === err ? "" : ` (cause ${link.name})`;
    const code = typeof pgCode === "string" ? ` [SQLSTATE ${pgCode}]` : "";
    return `${top.name}${via}${code}: ${WITHHELD}`;
  }
  if (err instanceof Error) return redactLogText(`${err.name}: ${err.message}`);
  return redactLogText(String(err));
}

/**
 * R1 — the same rules as `safeErrorText`, without the `Name: ` prefix, for a
 * site that stores or reports an error's message (a job's `error`, an audit
 * row's `detail`, a refusal's `detail`): an ordinary error keeps its message
 * (through `redactLogText`); a withheld shape gives the withheld text.
 */
export function safeErrorMessage(err: unknown): string {
  if (withheldLink(err)) return safeErrorText(err);
  if (err instanceof Error) return redactLogText(err.message);
  return redactLogText(String(err));
}

/**
 * N8 F1 — a log object bound for a `console.*` write: every value that is an
 * error becomes its `safeErrorText`, every string goes through `redactLogText`.
 * Shallow on purpose: the objects these sites log are flat field bags
 * (`{ err, subject, signoffId }`).
 */
export function safeLogObject(obj: unknown): unknown {
  if (obj instanceof Error) return safeErrorText(obj);
  if (!obj || typeof obj !== "object") return typeof obj === "string" ? redactLogText(obj) : obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v instanceof Error ? safeErrorText(v) : typeof v === "string" ? redactLogText(v) : v;
  }
  return out;
}

/**
 * ADR-0167 N8, owner decision Q10 (ADR-0197): the gateway's error serializer.
 *
 * Every error the gateway logs, stores or reports goes through pino's standard
 * serializer (`stdSerializers.errWithCause`: type resolution, the cause chain,
 * aggregate errors, cycle safety) and then through a whitelist. Fastify's
 * logger is configured with it for the `err` and `error` keys
 * (`resolveGatewayLogger`), so a call site writes `log.error({ err }, "…")`.
 *
 * What a serialized error carries, and nothing else:
 *  - `type` (the constructor or `name`), `code` (a string code: `ECONNREFUSED`,
 *    `FST_ERR_*`, a SQLSTATE), `sqlState`, `constraint`, `table`, `column`
 *    (names in our schema, never values);
 *  - `errorId`, a stable fingerprint of type, code and the first stack frame,
 *    so the same failure groups across lines and replicas;
 *  - `message`: WITHHELD when the error or anything in its cause chain is a
 *    shape whose message quotes input (a `SyntaxError`; a failed query, whose
 *    drizzle message lists every bound parameter; a database driver error,
 *    whose message and `detail` quote values, trigger RAISE text included, Q9);
 *    otherwise its own message through `redactLogText` (credential URL segments
 *    and query values replaced). Never the cause messages pino folds in;
 *  - `stack`: the frames only (a stack's first line is the message);
 *  - `cause` and `aggregateErrors`, serialized by the same rules, bounded.
 * Everything else pino copies from the error (drizzle's `params` and `query`,
 * Postgres's `detail` and `where`, an HTTP client's `config`, `request` and
 * `response` with their headers and bodies) is dropped.
 */
import { createHash } from "node:crypto";
import { stdSerializers } from "pino";
import { redactLogText } from "./log-redact.js";

export const WITHHELD = "[withheld: may quote request input]";

/** how deep a cause chain, and how many aggregate errors, a serialized error keeps */
const MAX_DEPTH = 5;
const MAX_AGGREGATE = 10;

const SAFE = Symbol("regulait-safe-err");

export interface SafeErr {
  [key: string]: unknown;
  type: string;
  errorId: string;
  message: string;
  code?: string;
  sqlState?: string;
  constraint?: string;
  table?: string;
  column?: string;
  /** the frames only; empty when the error has none */
  stack: string;
  cause?: SafeErr;
  aggregateErrors?: SafeErr[];
}

type PinoErr = ReturnType<typeof stdSerializers.errWithCause> & { raw?: unknown; cause?: unknown };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** a failed database query: drizzle's `DrizzleQueryError` shape (SQL text plus bound params) */
function isFailedQuery(e: unknown): boolean {
  const q = e as { query?: unknown; params?: unknown } | null;
  return e instanceof Error && typeof q?.query === "string" && Array.isArray(q.params);
}

/**
 * A bare database driver error (node-postgres `DatabaseError`): a five-character
 * SQLSTATE plus the server's `severity` or `detail`.
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
export function withheldLink(err: unknown): Error | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < 10 && cur && typeof cur === "object" && !seen.has(cur); depth++) {
    seen.add(cur);
    if (cur instanceof SyntaxError || isFailedQuery(cur) || isDriverError(cur)) return cur as Error;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** the SQLSTATE an error carries: its own (a driver error) or its cause's (a failed query) */
function sqlStateOf(e: unknown): string | undefined {
  if (isDriverError(e)) return str((e as { code?: unknown }).code);
  if (isFailedQuery(e)) return str((e as { cause?: { code?: unknown } }).cause?.code);
  return undefined;
}

/** a stack's frames without its first line (the message) */
function framesOf(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const frames = stack.split("\n").filter((l) => /^\s+at /.test(l)).join("\n");
  return frames ? redactLogText(frames) : undefined;
}

function errorIdOf(type: string, code: string | undefined, stack: string | undefined): string {
  const firstFrame = (stack ?? "").split("\n")[0]?.trim() ?? "";
  return createHash("sha256").update(`${type}\u0000${code ?? ""}\u0000${firstFrame}`).digest("hex").slice(0, 12);
}

function brand(e: SafeErr): SafeErr {
  Object.defineProperty(e, SAFE, { value: true, enumerable: false });
  return e;
}

function isSafe(v: unknown): v is SafeErr {
  return !!v && typeof v === "object" && (v as Record<symbol, unknown>)[SAFE] === true;
}

function fromPino(s: PinoErr, depth: number): SafeErr {
  const raw = s.raw ?? s;
  const r = raw as { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown; message?: unknown };
  // a class's own `name` where it sets one; else pino's constructor name
  const name = str((raw as { name?: unknown }).name);
  const type = name && name !== "Error" ? name : str(s.type) || "Error";
  const code = str(r.code);
  const stack = framesOf(s.stack);
  const out: SafeErr = {
    type,
    errorId: errorIdOf(type, code, stack),
    message: withheldLink(raw) ? WITHHELD : redactLogText(String(r.message ?? "")),
    stack: stack ?? "",
  };
  if (code !== undefined) out.code = code;
  const sqlState = sqlStateOf(raw);
  if (sqlState !== undefined) out.sqlState = sqlState;
  // a failed query's names sit on its driver cause
  const named = (isFailedQuery(raw) ? (raw as { cause?: unknown }).cause : raw) as typeof r | undefined;
  for (const k of ["constraint", "table", "column"] as const) {
    const v = str(named?.[k]);
    if (v !== undefined) out[k] = v;
  }
  if (depth < MAX_DEPTH && s.cause && typeof s.cause === "object" && "type" in s.cause) {
    out.cause = fromPino(s.cause as PinoErr, depth + 1);
  }
  if (Array.isArray(s.aggregateErrors) && depth < MAX_DEPTH) {
    out.aggregateErrors = s.aggregateErrors.slice(0, MAX_AGGREGATE).map((a) => fromPino(a as PinoErr, depth + 1));
  }
  return brand(out);
}

/**
 * The pino serializer for `err` / `error`, and the one way the gateway turns an
 * error into data. Idempotent: an already-serialized error is returned as is.
 * A thrown non-error is reported by its type and its `String()` (redacted); a
 * thrown plain object gives no content at all (it may be a request body).
 */
export function errSerializer(err: unknown): SafeErr {
  if (isSafe(err)) return err;
  const s = stdSerializers.errWithCause(err as Error) as unknown;
  if (s && typeof s === "object" && typeof (s as { message?: unknown }).message === "string" && "type" in s) {
    return fromPino(s as PinoErr, 0);
  }
  const type = err === null ? "null" : Array.isArray(err) ? "Array" : typeof err;
  const message = err !== null && typeof err === "object" ? "[withheld: not an Error]" : redactLogText(String(err));
  return brand({ type, errorId: errorIdOf(type, undefined, undefined), message, stack: "" });
}

/**
 * The serialized message, for a site that stores or reports an error (a job's
 * `error`, an audit row's `detail`, a refusal's `detail`).
 */
export function errMessage(err: unknown): string {
  return errSerializer(err).message;
}

/**
 * One line of text for an error written outside pino (a `console.*` or an
 * injected `log(...)`): `Type (cause CauseType) [SQLSTATE n]: message`, the
 * cause and SQLSTATE parts present only when a withheld link supplies them.
 */
export function errLine(err: unknown): string {
  const s = errSerializer(err);
  const link = withheldLink(err);
  if (!link) return s.type === "string" ? s.message : `${s.type}: ${s.message}`;
  const via = link === err ? "" : ` (cause ${errSerializer(link).type})`;
  const sqlState = sqlStateOf(link);
  return `${s.type}${via}${sqlState ? ` [SQLSTATE ${sqlState}]` : ""}: ${WITHHELD}`;
}

/**
 * A log object bound for a `console.*` write: every value that is an error
 * becomes its serialized form, every string goes through `redactLogText`.
 * Shallow on purpose: the objects these sites log are flat field bags.
 */
export function errFields(obj: unknown): unknown {
  if (obj instanceof Error) return errSerializer(obj);
  if (!obj || typeof obj !== "object") return typeof obj === "string" ? redactLogText(obj) : obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v instanceof Error ? errSerializer(v) : typeof v === "string" ? redactLogText(v) : v;
  }
  return out;
}

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
 */
import type { FastifyRequest, FastifyServerOptions } from "fastify";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** the paths pino masks, in its own redact syntax */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
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
  return {
    status,
    method: req.method,
    route: req.routeOptions?.url ?? null,
    path: req.url.split("?")[0],
    ip: req.ip ?? null,
    credential: credentialKind(req),
  };
}

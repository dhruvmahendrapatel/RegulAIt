/**
 * ROADMAP G2 — deadlines. Every bound in this file exists because it was
 * ABSENT, and the absences were not symmetrical, so the numbers are not either.
 *
 * ── WHAT WAS ACTUALLY MISSING, MEASURED ────────────────────────────────────
 * The roadmap item said "timeouts, body limits". Auditing before building, the
 * body limit was **already there**: Fastify defaults `bodyLimit` to 1 MiB, and
 * nothing in this repo overrides it. So `bodyLimitBytes` below is that same
 * number, restated where an operator can find and change it. It is NOT a new
 * restriction and no request that worked yesterday stops working.
 *
 * What was genuinely unbounded:
 *   - `requestTimeout` — Fastify's default is 0, i.e. disabled.
 *   - every outbound MCP call. `client.connect()`, `listTools()` and
 *     `callTool()` were all made with no options argument, so no deadline, and
 *     the guarded fetch passes a signal through without ever supplying one.
 *   - the model SDKs, which set `maxRetries: 2` and no `timeout`, inheriting a
 *     10-minute default — and then retrying it.
 *
 * ── WHY `connectionTimeout` IS DELIBERATELY NOT HERE ───────────────────────
 * It is the obvious third knob and it would be a bug. Fastify's
 * `connectionTimeout` is `server.setTimeout`: socket inactivity. This product
 * holds sockets open on purpose all over the place — the MCP proxy hijacks the
 * reply and streams (`mcp-proxy.ts:1481`), both compat edges stream SSE, the
 * orchestration channel streams SSE, `/v1/audit.csv` streams a batched DB walk.
 * An idle-socket deadline kills a correct long stream and calls it a timeout.
 * The bound those paths need is a per-operation deadline on what they are
 * WAITING for, which is what the upstream numbers below are.
 *
 * ── ADR-0021 CONVENTION DEBT (stated plainly, not hidden) ──────────────────
 * Under the standing admin-configurability mandate these belong in
 * `org_settings`, next to `loginLockoutThreshold` and `maxToolsInManifest`.
 * They are env-overridable constants instead, exactly as `rate-limit.ts` says
 * of its own numbers and for the same reason: this change adds no migration.
 * The natural follow-up is a column per field read through `loadOrgSettings`.
 */

import {
  MODEL_DISPATCH_TIMEOUT_MS_DEFAULT,
  setModelDispatchTimeoutMs,
} from "@regulait/model-provider";

export interface TimeoutConfig {
  /**
   * Bounds RECEIVING a request — headers and body — not handling it and not
   * responding to it. That is what makes it safe beside SSE and the hijacked
   * MCP transport: by the time either streams, receipt is long finished.
   * Generous on purpose; its job is slowloris and half-open sockets, not
   * policing slow clients on a bad network.
   */
  requestTimeoutMs: number;

  /** Fastify's own default, restated so it is findable and tunable. */
  bodyLimitBytes: number;

  /**
   * Opening the MCP session: TCP + TLS + the `initialize` round trip. Short,
   * because this happens at the TOP of every `POST /mcp/:serverId` before any
   * JSON-RPC is read, so a dead upstream otherwise hangs the caller before the
   * governance layer has said anything at all.
   */
  mcpConnectMs: number;

  /** `tools/list`. A manifest is small; a slow one is a sick upstream. */
  mcpListToolsMs: number;

  /**
   * `tools/call`. The most generous of the three by a wide margin, because
   * this one is the upstream doing real work — a build, a query, a scan — and
   * a deadline that severs legitimate work is worse than the hang it replaces.
   */
  mcpCallToolMs: number;

  /**
   * Model dispatch. The SDKs default to 10 minutes AND retry twice, so the
   * real worst case today is around half an hour of one held request. Five
   * minutes is deliberately not aggressive: a long completion is legitimate
   * and this is a governance layer, not a latency budget. It halves the worst
   * case and makes the number something an operator can see.
   */
  modelDispatchMs: number;
}

export const TIMEOUT_DEFAULTS: Readonly<TimeoutConfig> = Object.freeze({
  requestTimeoutMs: 60_000,
  bodyLimitBytes: 1_048_576,
  mcpConnectMs: 10_000,
  mcpListToolsMs: 15_000,
  mcpCallToolMs: 120_000,
  // owned by the package that uses it; see model-provider's own note
  modelDispatchMs: MODEL_DISPATCH_TIMEOUT_MS_DEFAULT,
});

function envInt(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  // Same posture as resolveHsts: a malformed deadline is a deployment mistake
  // and silently falling back to a default would hide it at exactly the moment
  // an operator believed they had set a bound.
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number of milliseconds, got: ${raw}`);
  }
  return Math.floor(n);
}

export function resolveTimeoutConfig(
  env: NodeJS.ProcessEnv = process.env,
  override: Partial<TimeoutConfig> = {},
): TimeoutConfig {
  return {
    requestTimeoutMs: envInt(env, "REGULAIT_REQUEST_TIMEOUT_MS", TIMEOUT_DEFAULTS.requestTimeoutMs),
    bodyLimitBytes: envInt(env, "REGULAIT_BODY_LIMIT_BYTES", TIMEOUT_DEFAULTS.bodyLimitBytes),
    mcpConnectMs: envInt(env, "REGULAIT_MCP_CONNECT_TIMEOUT_MS", TIMEOUT_DEFAULTS.mcpConnectMs),
    mcpListToolsMs: envInt(env, "REGULAIT_MCP_LIST_TIMEOUT_MS", TIMEOUT_DEFAULTS.mcpListToolsMs),
    mcpCallToolMs: envInt(env, "REGULAIT_MCP_CALL_TIMEOUT_MS", TIMEOUT_DEFAULTS.mcpCallToolMs),
    modelDispatchMs: envInt(env, "REGULAIT_MODEL_TIMEOUT_MS", TIMEOUT_DEFAULTS.modelDispatchMs),
    ...override,
  };
}

/**
 * The process-wide resolved config.
 *
 * WHY A MODULE SINGLETON AND NOT A PARAMETER. The three MCP deadlines are
 * needed deep inside `mcp-egress.ts` and `mcp-proxy.ts`, on call paths reached
 * from the proxy route, the admission re-scan sweep, the registry sync and the
 * copilot — threading a config object through all of them would be a large
 * mechanical change whose only effect is to make a constant reachable. The
 * setter exists so a test can pin a 50ms deadline without `process.env`.
 */
let active: TimeoutConfig = resolveTimeoutConfig();

export function timeouts(): TimeoutConfig {
  return active;
}

/**
 * Called once by `buildApp`, and by tests that need a deadline they can hit.
 *
 * Pushes the model deadline into the model-provider package rather than having
 * that package read the environment itself: one env reader here, one number
 * there, so there is nothing to drift.
 */
export function setTimeoutConfig(cfg: TimeoutConfig): void {
  active = cfg;
  setModelDispatchTimeoutMs(cfg.modelDispatchMs);
}

/**
 * ADR-0185 G5 — `/metrics`.
 *
 * The meter is OpenTelemetry (`@opentelemetry/sdk-metrics`) and the text
 * format is the Prometheus exporter's (`@opentelemetry/exporter-prometheus`,
 * with `preventServerStart`, so the exporter never opens a socket of its own).
 * Both are Apache-2.0 and pinned exactly (ADR-0176; `prom-client` failed the
 * maintenance test). The only code written here is what is RegulAIt's: which
 * series exist, which label values are allowed, and who may read them.
 *
 * ── OFF BY DEFAULT, AND NEVER UNAUTHENTICATED (ADR-0180) ──────────────────
 * Nothing is served unless an operator asks. `REGULAIT_METRICS_LISTEN` starts a
 * SEPARATE listener (boot.ts) so the scrape port can stay on a private network;
 * `REGULAIT_METRICS_ON_MAIN_LISTENER` additionally mounts `GET /metrics` on the
 * public listener. Either one requires `REGULAIT_METRICS_TOKEN` (≥ 32 chars) or
 * the boot refuses (`MetricsBootError`). Every scrape presents it as a Bearer
 * token, compared with the repository's one constant-time helper. A refusal is
 * a 401 `metrics_unauthorized` that is COUNTED (`regulait_metrics_unauthorized_total`)
 * and not audited: a scraper with a stale token would otherwise write an audit
 * row every 15 seconds forever, burying the rows that matter.
 *
 * ── LABELS COME FROM FIXED VOCABULARIES ONLY ──────────────────────────────
 * Route template, status class, decision surface and effect, server id,
 * transport, outcome, breaker state, job. Never a user, project, email, tool
 * name, raw URL or URI. Three layers enforce it, so no single mistake leaks:
 *   1. the signatures below accept only those fields;
 *   2. every value passes `safeLabel()`, an allow-list per label that maps
 *      anything unrecognised to one fixed fallback ("unmatched", "other", …);
 *   3. each instrument has a View that drops any attribute KEY not on its list
 *      and caps it at `METRIC_CARDINALITY_LIMIT` series (the SDK folds the rest
 *      into one overflow series).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { DecisionEffect } from "@regulait/policy-kernel";
import { constantTimeEqual, type McpUpstreamTransport } from "@regulait/shared";
import {
  MeterProvider,
  createAllowListAttributesProcessor,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import type { Counter, Gauge, Histogram } from "@opentelemetry/api";

/** which governed surface took the decision */
export const METRIC_DECISION_SURFACES = ["mcp_tool", "mcp_protocol", "agent", "connector"] as const;
export type MetricDecisionSurface = (typeof METRIC_DECISION_SURFACES)[number];

/** how one upstream attempt ended */
export const METRIC_UPSTREAM_OUTCOMES = ["ok", "error", "timeout", "refused", "circuit_open"] as const;
export type MetricUpstreamOutcome = (typeof METRIC_UPSTREAM_OUTCOMES)[number];

/** the circuit-breaker states (ADR-0126) a transition metric may name */
export const METRIC_BREAKER_STATES = ["closed", "open", "half_open"] as const;
export type MetricBreakerState = (typeof METRIC_BREAKER_STATES)[number];

/** an HTTP response's status class */
export const METRIC_STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;
export type MetricStatusClass = (typeof METRIC_STATUS_CLASSES)[number];

export interface DecisionMetricLabels {
  surface: MetricDecisionSurface;
  effect: DecisionEffect;
}

export interface UpstreamMetricLabels {
  /** the `mcp_servers.id` (a uuid, bounded by the registry — never a URL) */
  serverId: string;
  transport: McpUpstreamTransport;
  outcome: MetricUpstreamOutcome;
}

export interface MetricsHookOptions {
  /** the environment to read `REGULAIT_METRICS_*` from (default `process.env`) */
  env?: NodeJS.ProcessEnv;
}

/** the SDK's per-instrument series cap (ADR-0185 §G5) */
export const METRIC_CARDINALITY_LIMIT = 500;
/** the shortest token the boot accepts */
export const METRICS_TOKEN_MIN_LENGTH = 32;
/** the path both listeners serve */
export const METRICS_PATH = "/metrics";

// ---------------------------------------------------------------------------
// safeLabel — the allow-list
// ---------------------------------------------------------------------------

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const DECISION_EFFECTS = ["allow", "deny", "require_approval"] as const satisfies readonly DecisionEffect[];
const UPSTREAM_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const satisfies readonly McpUpstreamTransport[];
const JOB_OUTCOMES = ["ok", "failed", "skipped"] as const;
const LISTENERS = ["separate", "main"] as const;
/** a server id is a uuid — never a name, never a URL */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** a Fastify route template's alphabet: no query, no spaces, no '@' */
const ROUTE_TEMPLATE_RE = /^\/[A-Za-z0-9/_:*.\-]{0,199}$/;
const JOB_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** job names a registry declared (scheduler.ts registers them); the only job
 * label values allowed */
const registeredJobs = new Set<string>();
const MAX_REGISTERED_JOBS = 200;

/** called by the scheduler with its registry's names: the job vocabulary */
export function registerMetricJobNames(names: Iterable<string>): void {
  for (const name of names) {
    if (registeredJobs.size >= MAX_REGISTERED_JOBS) return;
    if (JOB_NAME_RE.test(name)) registeredJobs.add(name);
  }
}

export type MetricLabelKind =
  | "method"
  | "status_class"
  | "surface"
  | "effect"
  | "server_id"
  | "transport"
  | "outcome"
  | "breaker_state"
  | "job"
  | "job_outcome"
  | "listener";

function oneOf<T extends string>(vocab: readonly T[], value: unknown, fallback: string): string {
  return typeof value === "string" && (vocab as readonly string[]).includes(value) ? value : fallback;
}

/**
 * THE allow-list. A value outside a label's fixed vocabulary becomes that
 * label's one fallback, so no caller can mint a series by passing something
 * unexpected. (The route label has its own function, `safeRouteLabel`, because
 * its vocabulary is the router's.)
 */
export function safeLabel(kind: MetricLabelKind, value: unknown): string {
  switch (kind) {
    case "method":
      return oneOf(HTTP_METHODS, typeof value === "string" ? value.toUpperCase() : value, "OTHER");
    case "status_class":
      return oneOf(METRIC_STATUS_CLASSES, value, "other");
    case "surface":
      return oneOf(METRIC_DECISION_SURFACES, value, "other");
    case "effect":
      return oneOf(DECISION_EFFECTS, value, "other");
    case "server_id":
      return serverIdLabel(value);
    case "transport":
      return oneOf(UPSTREAM_TRANSPORTS, value, "unknown");
    case "outcome":
      return oneOf(METRIC_UPSTREAM_OUTCOMES, value, "other");
    case "breaker_state":
      return oneOf(METRIC_BREAKER_STATES, value, "other");
    case "job":
      return typeof value === "string" && registeredJobs.has(value) ? value : "other";
    case "job_outcome":
      return oneOf(JOB_OUTCOMES, value, "other");
    case "listener":
      return oneOf(LISTENERS, value, "other");
  }
}

/**
 * Server ids are the one label whose vocabulary is data (the registry), so
 * they get a LIFETIME cap of their own. The SDK's cardinality limit is applied
 * per collection cycle (a fresh delta map after each scrape), so on its own
 * it bounds how many NEW series one scrape interval can add, not how many a
 * long-running process accumulates. Past the cap a new id reads "overflow".
 */
export const MAX_SERVER_ID_LABELS = 400;
const seenServerIds = new Set<string>();
function serverIdLabel(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) return "invalid";
  if (seenServerIds.has(value)) return value;
  if (seenServerIds.size >= MAX_SERVER_ID_LABELS) return "overflow";
  seenServerIds.add(value);
  return value;
}

/** the HTTP status → its class */
export function statusClassOf(statusCode: number): string {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return "other";
  return `${Math.floor(statusCode / 100)}xx`;
}

/**
 * The route label: the Fastify TEMPLATE of the matched route (never the raw
 * URL), confirmed against the router itself, or "unmatched". A request for a
 * path no route serves — a scanner walking ten thousand random paths — lands
 * in ONE series.
 */
export function safeRouteLabel(
  app: Pick<FastifyInstance, "hasRoute">,
  method: string,
  template: string | undefined,
): string {
  if (!template || !ROUTE_TEMPLATE_RE.test(template)) return "unmatched";
  const key = `${method} ${template}`;
  const cached = knownRoutes.get(key);
  if (cached !== undefined) return cached ? template : "unmatched";
  let known = false;
  try {
    known = app.hasRoute({ method: method as "GET", url: template });
  } catch {
    known = false;
  }
  // Only a template the router recognises is cached; the cache is therefore
  // bounded by the registered routes, not by what clients send.
  if (known && knownRoutes.size < 10_000) knownRoutes.set(key, true);
  return known ? template : "unmatched";
}
const knownRoutes = new Map<string, boolean>();

// ---------------------------------------------------------------------------
// the meter (one per process, built on first use)
// ---------------------------------------------------------------------------

const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/** every instrument with the ONLY attribute keys it may carry */
const INSTRUMENT_KEYS = {
  regulait_http_requests_total: ["method", "route", "status_class"],
  regulait_http_request_duration_seconds: ["method", "route", "status_class"],
  regulait_governance_decisions_total: ["surface", "effect"],
  regulait_mcp_upstream_requests_total: ["server_id", "transport", "outcome"],
  regulait_mcp_upstream_duration_seconds: ["transport"],
  regulait_mcp_breaker_state: ["server_id"],
  regulait_mcp_breaker_transitions_total: ["to"],
  regulait_scheduler_job_runs_total: ["job", "outcome"],
  regulait_metrics_unauthorized_total: ["listener"],
} as const;

interface Meter {
  provider: MeterProvider;
  exporter: PrometheusExporter;
  httpRequests: Counter;
  httpDuration: Histogram;
  decisions: Counter;
  upstreamRequests: Counter;
  upstreamDuration: Histogram;
  breakerState: Gauge;
  breakerTransitions: Counter;
  jobRuns: Counter;
  unauthorized: Counter;
}

let meter: Meter | null = null;

function buildMeter(): Meter {
  const exporter = new PrometheusExporter({
    preventServerStart: true,
    // no resource labels (host, process) and no scope labels: the series
    // carry exactly the keys listed above
    withoutTargetInfo: true,
    withoutScopeInfo: true,
  });
  const views: ViewOptions[] = Object.entries(INSTRUMENT_KEYS).map(([name, keys]) => ({
    instrumentName: name,
    attributesProcessors: [createAllowListAttributesProcessor([...keys])],
    aggregationCardinalityLimit: METRIC_CARDINALITY_LIMIT,
  }));
  const provider = new MeterProvider({ readers: [exporter], views });
  const m = provider.getMeter("regulait-gateway");
  return {
    provider,
    exporter,
    httpRequests: m.createCounter("regulait_http_requests_total", {
      description: "HTTP requests served, by route template and status class",
    }),
    httpDuration: m.createHistogram("regulait_http_request_duration_seconds", {
      description: "HTTP request duration in seconds, by route template and status class",
      unit: "s",
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    }),
    decisions: m.createCounter("regulait_governance_decisions_total", {
      description: "Served governance decisions, by surface and effect (simulations excluded)",
    }),
    upstreamRequests: m.createCounter("regulait_mcp_upstream_requests_total", {
      description: "MCP upstream operations, by server id, transport and outcome",
    }),
    upstreamDuration: m.createHistogram("regulait_mcp_upstream_duration_seconds", {
      description: "MCP upstream operation duration in seconds, by transport (attempted operations only)",
      unit: "s",
      advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
    }),
    breakerState: m.createGauge("regulait_mcp_breaker_state", {
      description: "MCP upstream circuit-breaker state as last seen by this process: 0 closed, 1 open, 2 half-open",
    }),
    breakerTransitions: m.createCounter("regulait_mcp_breaker_transitions_total", {
      description: "MCP upstream circuit-breaker transitions taken by this process, by target state",
    }),
    jobRuns: m.createCounter("regulait_scheduler_job_runs_total", {
      description: "Scheduler job runs, by job and outcome (a not-due or disabled job is not a run)",
    }),
    unauthorized: m.createCounter("regulait_metrics_unauthorized_total", {
      description: "Scrapes refused for a missing or wrong bearer token, by listener",
    }),
  };
}

function getMeter(): Meter {
  meter ??= buildMeter();
  return meter;
}

// ---------------------------------------------------------------------------
// the recording seams (signatures fixed by the batch-3 foundation)
// ---------------------------------------------------------------------------

/**
 * Count one SERVED governance decision (not a simulation or a preview).
 *
 * The PDP endpoints (`POST /v1/authz/check`, `POST /v1/evaluate`) and the
 * red-team harness reach `governedEvaluate` unsimulated and ARE counted, as
 * `mcp_tool`: each is a real decision on live policy (an external enforcement
 * point acts on the PDP's answer; a red-team probe files its audit row), and
 * a rate that left them out would disagree with the audit log it summarises.
 * Only `simulate` (a dry-run replay of a candidate version) is excluded.
 */
export function recordDecision(labels: DecisionMetricLabels): void {
  getMeter().decisions.add(1, {
    surface: safeLabel("surface", labels.surface),
    effect: safeLabel("effect", labels.effect),
  });
}

/** observe one upstream attempt and how long it took. The duration histogram
 * records only operations that were ATTEMPTED: a breaker or own-policy refusal
 * contacted nothing, so its zero would only flatter the latency. */
export function observeUpstream(labels: UpstreamMetricLabels, durationMs: number): void {
  const m = getMeter();
  const transport = safeLabel("transport", labels.transport);
  const outcome = safeLabel("outcome", labels.outcome);
  m.upstreamRequests.add(1, { server_id: safeLabel("server_id", labels.serverId), transport, outcome });
  if (outcome === "ok" || outcome === "error" || outcome === "timeout") {
    if (Number.isFinite(durationMs) && durationMs >= 0) m.upstreamDuration.record(durationMs / 1000, { transport });
  }
}

const BREAKER_STATE_VALUE: Record<MetricBreakerState, number> = { closed: 0, open: 1, half_open: 2 };

/** the breaker state this process last saw for a server (no transition) */
export function setBreakerState(serverId: string, state: MetricBreakerState): void {
  const s = safeLabel("breaker_state", state) as MetricBreakerState | "other";
  if (s === "other") return;
  getMeter().breakerState.record(BREAKER_STATE_VALUE[s], { server_id: safeLabel("server_id", serverId) });
}

/** a breaker transition this process took (upstream-breaker.ts) */
export function recordBreakerTransition(serverId: string, to: MetricBreakerState): void {
  setBreakerState(serverId, to);
  getMeter().breakerTransitions.add(1, { to: safeLabel("breaker_state", to) });
}

/** one scheduler job run (scheduler.ts) */
export function recordJobRun(job: string, outcome: "ok" | "failed" | "skipped"): void {
  getMeter().jobRuns.add(1, { job: safeLabel("job", job), outcome: safeLabel("job_outcome", outcome) });
}

// ---------------------------------------------------------------------------
// configuration and the boot refusal
// ---------------------------------------------------------------------------

/** the boot refuses: a metrics setting is present but unusable */
export class MetricsBootError extends Error {
  constructor(message: string) {
    super(`[regulait] REFUSING TO START: ${message}`);
    this.name = "MetricsBootError";
  }
}

export interface MetricsConfig {
  /** where the separate listener binds, or null when it is off */
  listen: { host: string; port: number } | null;
  /** mount GET /metrics on the public listener too */
  onMainListener: boolean;
  /** the bearer token; null only when both are off */
  token: string | null;
}

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["", "0", "false", "off", "no"]);

function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = (env[key] ?? "").trim().toLowerCase();
  if (ON.has(raw)) return true;
  if (OFF.has(raw)) return false;
  throw new MetricsBootError(`${key} must be one of 1/true/on or 0/false/off; got '${env[key]}'.`);
}

function parseListen(raw: string): { host: string; port: number } {
  const v = raw.trim();
  let host = "127.0.0.1";
  let portText = v;
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/.exec(v);
  if (v6) {
    host = v6[1]!;
    portText = v6[2]!;
  } else if (v.includes(":")) {
    const i = v.lastIndexOf(":");
    host = v.slice(0, i);
    portText = v.slice(i + 1);
    if (!/^[A-Za-z0-9.\-]{1,253}$/.test(host)) {
      throw new MetricsBootError(`REGULAIT_METRICS_LISTEN host '${host}' is not a hostname or address.`);
    }
  }
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MetricsBootError(
      `REGULAIT_METRICS_LISTEN must be 'host:port' or a port (e.g. 127.0.0.1:9464); got '${raw}'.`,
    );
  }
  return { host, port };
}

/** whether a token is usable (≥ 32 characters, no whitespace) */
export function metricsTokenProblem(token: string | undefined): string | null {
  if (token === undefined || token === "") return "REGULAIT_METRICS_TOKEN is not set";
  if (/\s/.test(token)) return "REGULAIT_METRICS_TOKEN contains whitespace";
  if (token.length < METRICS_TOKEN_MIN_LENGTH) {
    return `REGULAIT_METRICS_TOKEN is ${token.length} characters; at least ${METRICS_TOKEN_MIN_LENGTH} are required`;
  }
  return null;
}

/**
 * Read the `REGULAIT_METRICS_*` settings. THROWS `MetricsBootError` when
 * metrics are asked for and cannot be served safely: there is no
 * unauthenticated mode to fall back to.
 */
export function resolveMetricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  const listenRaw = env.REGULAIT_METRICS_LISTEN?.trim() ?? "";
  const listen = listenRaw === "" ? null : parseListen(listenRaw);
  const onMainListener = flag(env, "REGULAIT_METRICS_ON_MAIN_LISTENER");
  if (!listen && !onMainListener) return { listen: null, onMainListener: false, token: null };
  const problem = metricsTokenProblem(env.REGULAIT_METRICS_TOKEN);
  if (problem) {
    const which = listen ? "REGULAIT_METRICS_LISTEN" : "REGULAIT_METRICS_ON_MAIN_LISTENER";
    throw new MetricsBootError(
      `${which} is set but ${problem}. /metrics is never served without a bearer token: ` +
        `set REGULAIT_METRICS_TOKEN to a random value of at least ${METRICS_TOKEN_MIN_LENGTH} characters, ` +
        `or unset ${which}.`,
    );
  }
  return { listen, onMainListener, token: env.REGULAIT_METRICS_TOKEN! };
}

/** the boot-log line */
export function describeMetricsPosture(cfg: MetricsConfig, boundAddress: string | null): string {
  const separate = cfg.listen
    ? `separate listener on ${boundAddress ?? `${cfg.listen.host}:${cfg.listen.port}`}${METRICS_PATH} (bearer token)`
    : "off (REGULAIT_METRICS_LISTEN unset)";
  const main = cfg.onMainListener
    ? `main listener ${METRICS_PATH}: ON (bearer token)`
    : `main listener ${METRICS_PATH}: off (404)`;
  return `${separate}; ${main}`;
}

// ---------------------------------------------------------------------------
// serving
// ---------------------------------------------------------------------------

/** does this Authorization header carry the token? Constant-time. */
export function metricsAuthorized(header: string | string[] | undefined, token: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  const m = typeof value === "string" ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value) : null;
  // Compare SOMETHING either way, so a missing header and a wrong one take
  // the same path.
  return constantTimeEqual(m ? m[1]! : "", token) && m !== null;
}

function refuse(res: ServerResponse, listener: "separate" | "main"): void {
  getMeter().unauthorized.add(1, { listener });
  res.statusCode = 401;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("www-authenticate", 'Bearer realm="metrics"');
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: "metrics_unauthorized" }));
}

/** serve one scrape on a raw request: 401 unless the token matches, then the
 * exporter's own handler */
export function serveMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  listener: "separate" | "main",
): void {
  if (!metricsAuthorized(req.headers.authorization, token)) {
    refuse(res, listener);
    return;
  }
  res.setHeader("cache-control", "no-store");
  getMeter().exporter.getMetricsRequestHandler(req, res);
}

/**
 * The separate listener (boot.ts). Serves `GET /metrics` and nothing else.
 * Resolves once bound; rejects (a `MetricsBootError`) if it cannot bind.
 */
export async function startMetricsListener(
  cfg: MetricsConfig,
): Promise<{ server: Server; address: string; close: () => Promise<void> }> {
  if (!cfg.listen || !cfg.token) throw new MetricsBootError("metrics listener started without a config");
  const token = cfg.token;
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== METRICS_PATH || (req.method !== "GET" && req.method !== "HEAD")) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    serveMetrics(req, res, token, "separate");
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      reject(
        new MetricsBootError(
          `the metrics listener could not bind ${cfg.listen!.host}:${cfg.listen!.port} ` +
            `(REGULAIT_METRICS_LISTEN): ${err.message}`,
        ),
      );
    };
    server.once("error", onError);
    server.listen(cfg.listen!.port, cfg.listen!.host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const a = server.address() as AddressInfo;
  const address = `${a.family === "IPv6" ? `[${a.address}]` : a.address}:${a.port}`;
  return {
    server,
    address,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** the request hooks (route template, status class, duration) and, when
 * `REGULAIT_METRICS_ON_MAIN_LISTENER` is set, the guarded `/metrics` route on
 * the public listener. Called once from `buildApp`. */
export function registerMetricsHooks(app: FastifyInstance, opts: MetricsHookOptions = {}): void {
  const env = opts.env ?? process.env;

  app.addHook("onResponse", async (req, reply) => {
    const m = getMeter();
    const method = safeLabel("method", req.method);
    const labels = {
      method,
      route: safeRouteLabel(app, req.method, req.routeOptions?.url),
      status_class: safeLabel("status_class", statusClassOf(reply.statusCode)),
    };
    m.httpRequests.add(1, labels);
    const ms = reply.elapsedTime;
    if (Number.isFinite(ms) && ms >= 0) m.httpDuration.record(ms / 1000, labels);
  });

  // Main-listener mount: only when asked AND a usable token exists. A bad
  // flag or token mounts nothing; startGateway refuses that boot anyway.
  let onMain = false;
  try {
    onMain = flag(env, "REGULAIT_METRICS_ON_MAIN_LISTENER");
  } catch {
    onMain = false;
  }
  const token = env.REGULAIT_METRICS_TOKEN;
  if (!onMain || metricsTokenProblem(token) !== null) {
    // OFF is the same 404 for every caller. With no route the path would
    // fall through to the auth hook, which answers a caller presenting the
    // metrics token (an unknown credential) with 401 — not the 404 this
    // setting promises. So the path is answered here, before auth, with the
    // body Fastify's own not-found sends; no route is registered.
    app.addHook("onRequest", async (req, reply) => {
      if (req.url !== METRICS_PATH && !req.url.startsWith(`${METRICS_PATH}?`)) return;
      return reply
        .status(404)
        .send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
    });
    return;
  }
  app.get(METRICS_PATH, async (req, reply) => {
    if (!metricsAuthorized(req.headers.authorization, token!)) {
      getMeter().unauthorized.add(1, { listener: "main" });
      return reply
        .status(401)
        .header("www-authenticate", 'Bearer realm="metrics"')
        .header("cache-control", "no-store")
        .send({ error: "metrics_unauthorized" });
    }
    const body = await scrapeMetricsText();
    return reply
      .status(200)
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store")
      .send(body);
  });
}

// The main-listener route answers through Fastify (so its own request is
// counted and every app hook still runs) with the exporter's own serializer,
// configured exactly as the exporter is above.
let serializer: PrometheusSerializer | null = null;
function serializeMetrics(rm: Parameters<PrometheusSerializer["serialize"]>[0]): string {
  serializer ??= new PrometheusSerializer(undefined, false, undefined, true, true);
  return serializer.serialize(rm);
}

/** the current exposition text (tests) */
export async function scrapeMetricsText(): Promise<string> {
  const { resourceMetrics } = await getMeter().exporter.collect();
  return serializeMetrics(resourceMetrics);
}

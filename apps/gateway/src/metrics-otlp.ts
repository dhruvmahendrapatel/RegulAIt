/**
 * ADR-0301 — OTLP metrics push, next to the ADR-0070 trace export.
 *
 * The series are the ADR-0185 G5 meter's (`metrics.ts`): the same provider,
 * Views, label allow-lists and cardinality caps, read through a second reader.
 * The wire format is the OpenTelemetry project's own OTLP/JSON serializer
 * (`@opentelemetry/otlp-transformer`, Apache-2.0, exact-pinned, ADR-0176).
 * The only code written here is RegulAIt's: when a push may leave, where to,
 * and through which guard.
 *
 * ── OFF BY DEFAULT; NO DEFAULT ENDPOINT (ADR-0180, ADR-0041) ──────────────
 * Nothing is pushed unless an operator sets `REGULAIT_METRICS_OTLP_ENDPOINT`.
 * The ambient `OTEL_EXPORTER_OTLP_*` variables are deliberately NOT read: a
 * variable set for some other process in the same environment must never open
 * an outbound connection from this one.
 *
 * ── EVERY PUSH GOES THROUGH THE EGRESS GUARD ──────────────────────────────
 * The official HTTP exporter (`@opentelemetry/exporter-metrics-otlp-http`) is
 * not used for the transport, for one unmet requirement (ADR-0176 §4): it
 * sends with Node's own http stack, so it cannot re-adjudicate the destination
 * against the admin egress allow-list, pin the connection to the validated
 * addresses or refuse redirects. Each push here reloads the allow-list and
 * posts through `createGuardedFetch`, the same guard the trace export, MCP and
 * model dispatch use. An empty allow-list means nothing leaves (default-deny),
 * and a collector on a private network needs an entry with private ranges on.
 *
 * ── WHAT A PUSH CARRIES ───────────────────────────────────────────────────
 * Only what `/metrics` already serves: counters, histograms and gauges whose
 * labels come from fixed vocabularies (route templates, effects, outcomes,
 * registry uuids). No user, project, prompt or URL. The resource carries one
 * attribute, `service.name`. The collector headers (usually a bearer token)
 * come from the environment, are sent only as request headers and are never
 * logged.
 *
 * ── A FAILED PUSH NEVER FAILS ANYTHING ELSE ───────────────────────────────
 * The loop runs on an unref'd timer, one push at a time (a push still in
 * flight makes the next tick skip), and every outcome is counted in
 * `regulait_metrics_otlp_pushes_total{outcome}`. It is logged only when the
 * outcome changes, so a collector that is down for a day writes two lines, not
 * fourteen hundred. Pushes are not audited: they are routine operator
 * telemetry, not governance decisions (the same reasoning as ADR-0185's
 * uncounted scrape refusals).
 */
import type { Db } from "@regulait/db";
import { JsonMetricsSerializer } from "@opentelemetry/otlp-transformer";
import { collectForOtlpPush, MetricsBootError, recordOtlpPush, type MetricOtlpPushOutcome } from "./metrics.js";
import { createGuardedFetch, EgressBlockedError, type EgressAllowEntry } from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { errMessage } from "./err-serializer.js";

export const OTLP_METRICS_ENV = {
  endpoint: "REGULAIT_METRICS_OTLP_ENDPOINT",
  intervalSeconds: "REGULAIT_METRICS_OTLP_INTERVAL_SECONDS",
  headers: "REGULAIT_METRICS_OTLP_HEADERS",
} as const;

export const OTLP_METRICS_LIMITS = {
  defaultIntervalSeconds: 60,
  minIntervalSeconds: 10,
  maxIntervalSeconds: 3600,
  /** a push that has not answered in this long is abandoned (and counted failed) */
  maxTimeoutMs: 30_000,
  maxHeaders: 10,
  maxHeaderValueLength: 4096,
  maxEndpointLength: 2048,
} as const;

/** headers the operator may not set: the transport owns them */
const RESERVED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
]);
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export interface OtlpMetricsConfig {
  endpoint: string;
  intervalMs: number;
  /** request headers (values are secrets: never logged, never returned) */
  headers: Record<string, string>;
}

/**
 * Read the `REGULAIT_METRICS_OTLP_*` settings. Null when no endpoint is set
 * (the shipped state). THROWS `MetricsBootError` when a setting is present but
 * unusable, so a typo refuses the boot instead of silently pushing nothing.
 */
export function resolveOtlpMetricsConfig(env: NodeJS.ProcessEnv = process.env): OtlpMetricsConfig | null {
  const raw = env[OTLP_METRICS_ENV.endpoint]?.trim() ?? "";
  const intervalRaw = env[OTLP_METRICS_ENV.intervalSeconds]?.trim() ?? "";
  const headersRaw = env[OTLP_METRICS_ENV.headers]?.trim() ?? "";
  if (raw === "") {
    if (intervalRaw !== "" || headersRaw !== "") {
      throw new MetricsBootError(
        `${intervalRaw !== "" ? OTLP_METRICS_ENV.intervalSeconds : OTLP_METRICS_ENV.headers} is set but ` +
          `${OTLP_METRICS_ENV.endpoint} is not. Set the endpoint, or unset the other OTLP metrics settings.`,
      );
    }
    return null;
  }
  return { endpoint: parseEndpoint(raw), intervalMs: parseInterval(intervalRaw) * 1000, headers: parseHeaders(headersRaw) };
}

function parseEndpoint(raw: string): string {
  const name = OTLP_METRICS_ENV.endpoint;
  if (raw.length > OTLP_METRICS_LIMITS.maxEndpointLength) {
    throw new MetricsBootError(`${name} is longer than ${OTLP_METRICS_LIMITS.maxEndpointLength} characters.`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MetricsBootError(`${name} is not a URL (expected e.g. https://collector.example:4318/v1/metrics).`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MetricsBootError(`${name} must be an https (or allow-listed http) URL; got '${url.protocol}'.`);
  }
  // a credential in the URL would be logged with it; headers are the place for one
  if (url.username !== "" || url.password !== "") {
    throw new MetricsBootError(`${name} must not carry credentials; put them in ${OTLP_METRICS_ENV.headers}.`);
  }
  if (url.hash !== "") throw new MetricsBootError(`${name} must not carry a fragment.`);
  return url.toString();
}

function parseInterval(raw: string): number {
  if (raw === "") return OTLP_METRICS_LIMITS.defaultIntervalSeconds;
  const n = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || n < OTLP_METRICS_LIMITS.minIntervalSeconds || n > OTLP_METRICS_LIMITS.maxIntervalSeconds) {
    throw new MetricsBootError(
      `${OTLP_METRICS_ENV.intervalSeconds} must be a whole number of seconds from ` +
        `${OTLP_METRICS_LIMITS.minIntervalSeconds} to ${OTLP_METRICS_LIMITS.maxIntervalSeconds}; got '${raw}'.`,
    );
  }
  return n;
}

/**
 * `name=value,name=value`, the shape of OpenTelemetry's `OTEL_EXPORTER_OTLP_HEADERS`.
 * Values are taken literally (no percent-decoding) and may not contain a comma.
 * Error messages name the header, never its value.
 */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === "") return out;
  const name = OTLP_METRICS_ENV.headers;
  const parts = raw.split(",");
  if (parts.length > OTLP_METRICS_LIMITS.maxHeaders) {
    throw new MetricsBootError(`${name} has more than ${OTLP_METRICS_LIMITS.maxHeaders} headers.`);
  }
  for (const [i, part] of parts.entries()) {
    const eq = part.indexOf("=");
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    const value = eq < 0 ? "" : part.slice(eq + 1).trim();
    if (!HEADER_NAME_RE.test(key)) {
      throw new MetricsBootError(`${name} entry ${i + 1} has no valid header name (expected name=value).`);
    }
    const lower = key.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw new MetricsBootError(`${name} may not set '${lower}': the transport sets it.`);
    }
    if (value === "" || value.length > OTLP_METRICS_LIMITS.maxHeaderValueLength || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new MetricsBootError(
        `${name} header '${lower}' needs a value of 1 to ${OTLP_METRICS_LIMITS.maxHeaderValueLength} ` +
          `printable characters.`,
      );
    }
    if (lower in out) throw new MetricsBootError(`${name} sets '${lower}' twice.`);
    out[lower] = value;
  }
  return out;
}

/** the boot-log line: the endpoint and interval, never a header value */
export function describeOtlpMetricsPosture(cfg: OtlpMetricsConfig | null): string {
  if (!cfg) return "OTLP push off (REGULAIT_METRICS_OTLP_ENDPOINT unset)";
  const names = Object.keys(cfg.headers);
  return (
    `OTLP push to ${cfg.endpoint} every ${cfg.intervalMs / 1000}s through the egress guard` +
    (names.length ? `, headers: ${names.join(", ")}` : "")
  );
}

export interface OtlpMetricsPushDeps {
  /** the allow-list source (default: the `egress_allow_hosts` table) */
  loadAllowList?: () => Promise<EgressAllowEntry[]>;
  /** passed to the guarded fetch; tests inject a receiver and a resolver */
  fetchImpl?: typeof fetch;
  resolve?: Parameters<typeof createGuardedFetch>[0]["resolve"];
  log?: (line: string) => void;
}

export interface OtlpMetricsPusher {
  /** one push now; resolves to how it ended (never throws) */
  pushOnce(): Promise<MetricOtlpPushOutcome>;
  /** stop the timer and wait for a push in flight */
  stop(): Promise<void>;
}

/**
 * Build the pusher. `start: true` also starts the unref'd interval timer
 * (boot.ts); tests drive `pushOnce` directly.
 */
export function createOtlpMetricsPusher(
  db: Db | null,
  cfg: OtlpMetricsConfig,
  deps: OtlpMetricsPushDeps & { start?: boolean } = {},
): OtlpMetricsPusher {
  const loadAllowList = deps.loadAllowList ?? (() => loadEgressAllowList(db as Db));
  const log = deps.log ?? (() => {});
  const timeoutMs = Math.min(cfg.intervalMs, OTLP_METRICS_LIMITS.maxTimeoutMs);
  let inFlight: Promise<MetricOtlpPushOutcome> | null = null;
  let lastOutcome: MetricOtlpPushOutcome | null = null;
  let timer: NodeJS.Timeout | null = null;

  const note = (outcome: MetricOtlpPushOutcome, detail: string): MetricOtlpPushOutcome => {
    recordOtlpPush(outcome);
    if (outcome !== lastOutcome) {
      log(
        outcome === "ok"
          ? `[regulait] metrics: OTLP push to ${cfg.endpoint} succeeded`
          : `[regulait] metrics: OTLP push to ${cfg.endpoint} ${outcome}: ${detail} (logged again only when this changes)`,
      );
    }
    lastOutcome = outcome;
    return outcome;
  };

  const attempt = async (): Promise<MetricOtlpPushOutcome> => {
    let allowList: EgressAllowEntry[];
    try {
      allowList = await loadAllowList();
    } catch (e) {
      return note("failed", `could not load the egress allow-list: ${errMessage(e)}`);
    }
    const { resourceMetrics, errors } = await collectForOtlpPush();
    if (errors.length > 0) log(`[regulait] metrics: ${errors.length} collection error(s) before an OTLP push`);
    const body = JsonMetricsSerializer.serializeRequest(resourceMetrics);
    if (!body) return note("failed", "the OTLP serializer produced no body");
    const guarded = createGuardedFetch({
      allowList,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    });
    try {
      const res = await guarded(cfg.endpoint, {
        method: "POST",
        headers: { ...cfg.headers, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // the body is the collector's (partial-success) reply; nothing here needs it
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return note("ok", "");
      return note("rejected", `the collector answered HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof EgressBlockedError) return note("egress_blocked", e.message);
      return note("failed", errMessage(e));
    }
  };

  const pushOnce = (): Promise<MetricOtlpPushOutcome> => {
    if (inFlight) return inFlight;
    inFlight = attempt()
      .catch((e: unknown) => note("failed", errMessage(e)))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  if (deps.start) {
    timer = setInterval(() => {
      if (!inFlight) void pushOnce();
    }, cfg.intervalMs);
    timer.unref();
  }

  return {
    pushOnce,
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
  };
}

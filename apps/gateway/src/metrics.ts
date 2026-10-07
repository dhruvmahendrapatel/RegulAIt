/**
 * ADR-0185 G5 — `/metrics`: THE SEAM (batch-3 foundation).
 *
 * This file is a NO-OP on purpose. It fixes the three call signatures the
 * decision sites, the upstream paths and `buildApp` use, so the slices can be
 * built in parallel; the G5 slice replaces the bodies with the OpenTelemetry
 * meter (`@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-prometheus`)
 * and the separate listener, without touching a call site.
 *
 * LABELS COME FROM FIXED VOCABULARIES ONLY (ADR-0185 §G5): route template,
 * status class, decision surface and effect, server id, transport, outcome,
 * breaker state, job. Never a user, project, email, tool name, raw URL or URI —
 * so no signature below accepts one.
 */
import type { FastifyInstance } from "fastify";
import type { DecisionEffect } from "@regulait/policy-kernel";
import type { McpUpstreamTransport } from "@regulait/shared";

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

/** count one SERVED governance decision (not a simulation or a preview) */
export function recordDecision(_labels: DecisionMetricLabels): void {
  // G5 seam: no-op until the meter lands
}

/** observe one upstream attempt and how long it took */
export function observeUpstream(_labels: UpstreamMetricLabels, _durationMs: number): void {
  // G5 seam: no-op until the meter lands
}

/** the request hooks (route template, status class, duration) and, when
 * `REGULAIT_METRICS_ON_MAIN_LISTENER` is set, the guarded `/metrics` route on
 * the public listener. Called once from `buildApp`. */
export function registerMetricsHooks(_app: FastifyInstance, _opts: MetricsHookOptions = {}): void {
  // G5 seam: no-op until the meter lands
}

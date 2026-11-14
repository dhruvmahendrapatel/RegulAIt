# ADR-0301: Push the gateway's metrics over OTLP, beside the trace export

- **Status**: Accepted (builder lane L11, 2026-11-14; PENDING "OpenTelemetry metrics" row)
- **Date**: 2026-11-14
- **Index**: OTLP metrics push from the ADR-0185 meter, egress-guarded, off by default
- **Migration**: none

## Context

PENDING's gap table listed "OpenTelemetry metrics" as absent next to the ADR-0070 trace export. Since ADR-0185 G5 the
gateway does have a metrics signal: an OpenTelemetry meter (`@opentelemetry/sdk-metrics`) served as Prometheus text on
an authenticated `/metrics`. What is missing is the OTLP side: a customer whose collector takes OTLP (the usual
OpenTelemetry Collector, Grafana Alloy, a vendor agent) cannot receive the gateway's metrics without running a
Prometheus scraper as well.

Search first (ADR-0176): `@opentelemetry/exporter-metrics-otlp-http` 0.223.0 and `@opentelemetry/otlp-transformer`
0.223.0 (both Apache-2.0, released 2026-10-06, the same release train as the pinned `sdk-metrics` 2.12.0). The
exporter sends with Node's own `http` module. It cannot consult the admin egress allow-list (ADR-0034/0062), pin the
connection to the validated addresses or refuse redirects, which every other outbound surface does, the trace export
included.

## Decision

1. **Same meter, second reader.** `metrics.ts` adds an `OtlpPushReader` (a `MetricReader` subclass, the SDK's
   extension point) to the one `MeterProvider`. A push therefore carries exactly the series `/metrics` serves, under
   the same Views, label allow-lists and cardinality caps. Temporality is cumulative, so a lost push loses no counts.
   The provider's resource is replaced by one attribute, `service.name=regulait-gateway` (no host, process or SDK
   detail); the Prometheus side already drops the resource.
2. **The official serializer, our transport.** The body is `JsonMetricsSerializer.serializeRequest` from
   `@opentelemetry/otlp-transformer` (OTLP/JSON over HTTP). The POST goes through `createGuardedFetch` with the
   allow-list reloaded on every push. Narrow exception under ADR-0176 §4: the official HTTP exporter is not used for
   the transport for the one unmet requirement above. Re-check when the exporter accepts a caller-supplied fetch or
   agent with the guarantees above.
3. **Off by default, set by the operator (ADR-0180, ADR-0041).** `REGULAIT_METRICS_OTLP_ENDPOINT` (https, or http only
   where the allow entry permits plaintext; no credentials or fragment in the URL), `REGULAIT_METRICS_OTLP_INTERVAL_SECONDS`
   (10 to 3600, default 60) and `REGULAIT_METRICS_OTLP_HEADERS` (`name=value,…`, at most 10, transport headers
   refused). The ambient `OTEL_EXPORTER_OTLP_*` variables are deliberately not read, so a variable meant for another
   process cannot open a connection from this one. A setting that is present but unusable refuses the boot
   (`MetricsBootError`), and the refusal never echoes a header value.
4. **A push never fails anything else.** One push at a time on an unref'd timer, a timeout of
   `min(interval, 30 s)`, no retries beyond the next tick, and no throw. Every outcome is counted in
   `regulait_metrics_otlp_pushes_total{outcome="ok|rejected|failed|egress_blocked"}` and logged only when it
   changes. Pushes are not audited: they are routine operator telemetry, not governance decisions (ADR-0185's reason
   for not auditing scrape refusals).

Why environment rather than an org setting like the trace export: the metrics are process-level (one series set per
gateway process), the operator who sets the scrape token sets the push target, and an environment setting needs no
migration or admin route. The egress allow-list stays the admin's control over where anything may go.

## Consequences

- Air-gapped installs are unchanged: nothing is configured, nothing is sent, and the boot log says so.
- A collector on a private network needs an `egress_allow_hosts` entry with private ranges allowed; an empty list
  means nothing is pushed (counted `egress_blocked`).
- The collector header values live in the process environment, like `REGULAIT_METRICS_TOKEN`. They are sent only as
  request headers and never logged.
- OTLP/protobuf and gRPC are not offered; OTLP/JSON over HTTP is part of the OTLP specification and every mainstream
  collector accepts it.
- Not covered here: the declared-but-unwritten span kinds named in the same PENDING row.

# ADR-0302: Third-party ingest follow-ups: evidence retention and OTLP intake (P37)

- **Status**: Accepted (builder lane L11, 2026-11-14; the two P37 follow-ups ADR-0261 named)
- **Date**: 2026-11-14
- **Index**: P37 follow-ups: compliance-cascade retention for third-party evidence, then OTLP intake
- **Backlog**: [PENDING, P37](../product/PENDING.md)
- **Migration**: `pending/third_party_evidence_retention.sql` (numbered at merge, ADR-0252)

## Context

ADR-0261 built the DefenseClaw HTTP JSONL ingest and left two follow-ups open: the evidence rows have no retention
sweep ("retention should follow the compliance cascade (pillar 3), like the audit log"), and OTLP intake is not built.
A third open item, checking the adapter against a real captured export, needs a real sample and stays open.

## Decision 1: evidence retention follows the audit-log floor (slice 2a)

1. **The floor is the audit log's.** The sweep uses `retentionFloor`, which composes every compliance profile's
   `auditRetentionDays` with the org default (longest wins, ADR-0021). With no floor configured nothing is deleted
   (fail-safe: keep all). There is no evidence-specific knob, for ADR-0070's reason: a second dial could shorten what
   a framework says to keep.
2. **Per-mode overrides extend it.** Evidence rows carry no deploy mode, so the longest effective per-mode override
   (ADR-0179 A4) applies to all of them. Keeping evidence longer is the safe direction. Traces take the shorter floor
   because they hold prompts; these rows hold none (ADR-0261 decision 5).
3. **The database clock decides (M-075).** The cutoff comes from `now()` and is compared with `received_at`, which the
   database wrote.
4. **A sanctioned delete path in the guard.** `third_party_ingest_records` stays append-only: UPDATE and TRUNCATE are
   still refused. DELETE is allowed only inside a transaction that sets `regulait.tpi_retention_cutoff`
   (transaction-local, the 0142 `regulait.secret_reencrypt` pattern), when that cutoff parses, is in the past by the
   database clock, and the row arrived before it. This guards against an application path deleting evidence by
   mistake. It is not a control against a database superuser.
5. **Audited in the same transaction.** Each batch that deletes writes one `third-party-evidence-retention-purged`
   audit row with the floor, its sources, the cutoff and the count per ingest source. A pass that deletes nothing
   writes no audit row; the scheduler's run row records it.
6. **Bounded.** At most 2,000 rows per transaction and 10 transactions per pass. The scheduler job
   `third-party-evidence-retention-sweep` runs daily.

The links in `third_party_ingest_record_findings` go with their record (existing ON DELETE CASCADE). The findings
themselves follow endpoint retention, as before. The batch audit row a record names may already be pruned by the
audit prune under the same floor; `audit_log` carries no foreign keys by design.

## Decision 2: OTLP/HTTP logs intake (slice 2b)

DefenseClaw's documented OTLP exporter speaks `grpc` or `http/protobuf` (ADR-0261). We accept **OTLP/HTTP logs**, in
protobuf or OTLP/JSON, on `POST /v1/third-party-ingest/defenseclaw/otlp/v1/logs`. The exporter's endpoint is set to
`.../defenseclaw/otlp` and the standard signal path is appended. gRPC is not offered: it would need an HTTP/2 listener
of its own.

1. **The same pipeline, not a second one.** The OTLP route shares the JSONL route's handler: the in-route `rgti_`
   token, source on, kind check, hourly rate limit, the 1 MiB body cap, the 512-record cap, the database-clock replay
   window, the `(source, record_id)` dedup (across both routes), device pseudonyms, findings and the batch audit row
   (now with `wire: jsonl | otlp`). Only the decoding and the success response differ.
2. **Decode, then hand every record to the JSONL parser.** `otlpLogsRequestToJsonl` (`@regulait/shared`, pure) turns
   each log record into one JSONL line:
   - its attributes, under the same documented flat or dotted names;
   - `host.name` from the resource when the record has none;
   - `timestamp` from `timeUnixNano` (else `observedTimeUnixNano`);
   - `severity` from `severityText` when it is one of the documented values.

   The JSONL schema then keeps only the allow-listed fields. The record **body is never read**: it is where a log
   carries prompts and payloads. Map and bytes attribute values are dropped. A record's `record_sha256` is over this
   canonical line, not the wire bytes.
3. **Open source first (ADR-0176).** Decoding is `protobufjs` 8.8.1 (BSD-3-Clause, pinned) over the OpenTelemetry
   project's own `.proto` files (`opentelemetry-proto` v1.9.0, Apache-2.0), vendored verbatim as strings so nothing is
   fetched at run time. `@opentelemetry/otlp-transformer` was checked: it exports serializers and response readers,
   not a request decoder.
4. **The OTLP response contract.** A success answers an `ExportLogsServiceResponse` in the request's encoding. When
   any record was rejected it carries `partialSuccess.rejectedLogRecords`, and its `errorMessage` lists the first
   twenty `position:code` pairs (codes only, never content). Refusals keep the JSONL route's status codes: 401/403/413/415/400
   are not retried by an exporter, while 429 (with `Retry-After`) and 503 are retried.
5. **Each route takes its own encodings.** The OTLP route refuses anything but `application/x-protobuf` and
   `application/json` (415). The JSONL route refuses `application/x-protobuf` and names the OTLP path.

The attribute mapping is written from the docs, like ADR-0261's JSONL mapping, and is pinned by synthetic exports.
Checking it against a real captured DefenseClaw OTLP export before a customer install stays open, as it does for JSONL.

## Consequences

- A deployment with a compliance profile or an org audit-retention default now sheds DefenseClaw evidence on the same
  schedule as its audit log, and one with neither keeps everything, as before.
- An operator who wants evidence kept longer raises the floor (a profile, the org default or a per-mode override).
  Nothing can shorten it below the audit floor.

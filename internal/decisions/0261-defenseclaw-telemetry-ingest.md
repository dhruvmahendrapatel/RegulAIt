# ADR-0261: Ingest Cisco DefenseClaw's audit export as attributed third-party evidence

- **Status**: Accepted (owner-approved backlog item P37, 2026-11-07; built by a builder lane)
- **Date**: 2026-11-07
- **Index**: Ingest Cisco DefenseClaw's HTTP JSONL audit export as attributed third-party evidence (P37)
- **Backlog**: [PENDING, P37](../product/PENDING.md)
- **Migration**: `pending/third_party_ingest.sql` (numbered at merge, ADR-0252)
- **Source report**: [DefenseClaw comparison](../reviews/2026-11-07-defenseclaw-comparison.md), option (b)

## Context

The DefenseClaw comparison recommended building option (b) first: customers who already run Cisco DefenseClaw on
their endpoints point its audit export at RegulAIt, and its records land in our findings and audit trail. RegulAIt
stays the system of record and the policy owner, and DefenseClaw becomes one more sensor. On-device enforcement (P1)
is a separate, later clean-room build with its own ADR and is not part of this decision.

What the public DefenseClaw docs (release 1.0.8) say about the export, read without downloading or running anything:

- Exporters: `http_jsonl` (logs only; batches of up to 512 records and 8 MiB by default; up to 24 retries with
  exponential backoff; auth by `bearer_env`/`bearer_credential` or custom headers) and OTLP (`grpc` or `http/protobuf`).
- Schema family `v8`, 14 closed buckets (`security.finding`, `enforcement.action`, `ai.discovery`, `model.io` and the
  rest). Documented field and attribute names include `bucket`, `event_name`, `severity` (CRITICAL to INFO), `action`,
  `outcome`, `connector`, `source`, `host.name`, `record_id`, `rule_ids` and the `defenseclaw.guardrail.*` set.
- "Consumers deduplicate on the record ID". No backfill.
- Exports default to `redaction: none`, so prompts, responses, tool arguments, paths and user identity leave as
  recorded.
- **Not documented:** the exact JSONL envelope, the HTTP method and content type, and any body signature for
  `http_jsonl`. The HMAC header (`X-Hub-Signature-256`) is documented only for the alert webhook, not for telemetry.

## Decision

Build one push-fed ingest adapter for DefenseClaw's **HTTP JSONL** export. It parses the documented format and ships
none of DefenseClaw's code.

1. **Source.** `third_party_ingest_sources` (kind `defenseclaw`, schema family pinned to `v8`). A new source is
   **off**. Turning it on is a `settings_relax` step-up bound to the source and kind, audited as a relaxation
   (ADR-0180). Turning it off needs no step-up and is audited.
2. **Credential.** One write-only token per source (`rgti_` + 64 hex), issued behind a step-up, shown once, stored as
   its sha256 only, and replaced or revoked by an audited admin action. The P13b scoped-ingestion credential has not
   landed, so this follows the existing endpoint-enrolment token pattern (ADR-0195 SD4b). The receiving route
   `POST /v1/third-party-ingest/defenseclaw/records` is auth-exempt and authenticates in-route by hash lookup. The
   token reaches nothing else, and a user API key does not reach the route.
3. **Replay protection.** The exporter cannot sign a body, so there is no HMAC to check. A replay is stopped by:
   - a unique `(source, record_id)` dedup (a replayed batch inserts nothing);
   - a window on each record's timestamp, judged by the database clock: at most 15 minutes old and 5 minutes ahead.
4. **Bounds and validation.**
   - Bodies are capped at 1 MiB (the customer lowers `batch.max_export_batch_bytes` to match), 512 records and
     64 KiB per line.
   - Records are zod-validated against the documented fields. Unknown buckets, another schema family and bad
     timestamps are refused.
   - A bad line is rejected on its own with a line number. A whole-batch 4xx would make the exporter retry the same
     bad line 24 times.
   - 100,000 records per source per rolling hour, then `429`.
   - All identifier checks are linear, with no regex on caller input (M-074).
5. **Minimisation.** Only allow-listed fields are kept. User identity, client addresses, prompts, responses, tool
   arguments and paths are dropped at parse time. The guardrail reason is credential- and PII-scrubbed and capped
   (ADR-0102, ADR-0233). The host name is replaced by the ADR-0195 device pseudonym.
6. **Evidence.** Accepted records go to `third_party_ingest_records`, which is append-only (UPDATE, DELETE and
   TRUNCATE are refused). Each row keeps the sha256 of its exact line and of its batch. Each batch writes one
   audit-chain row (`third-party-evidence-ingested`, `attribution: third_party, enforcement: false`) that every record
   names. A refused batch is audited as `third-party-evidence-refused`.
7. **Findings.** A `security.finding` or `enforcement.action` record whose severity is LOW or above and whose action
   is not `allow`, or any `ai.discovery` record, opens or widens an ADR-0195 shadow-AI finding:
   - subject: the device pseudonym;
   - provider: `defenseclaw/<connector>`, so it never merges into a finding RegulAIt made itself;
   - signal source: `defenseclaw_export`;
   - each batch is one `shadow_ai_imports` row of kind `defenseclaw_export`.

   A human disposition is never overwritten. `third_party_ingest_record_findings` links records to findings; it is a
   join table because retention deletes findings and never deletes evidence. Every other bucket is evidence only.
8. **Never our enforcement.**
   - DefenseClaw's `block` is stored as its `action` and shown as `reportedAction`.
   - Every API view says `attribution: third_party, enforcedByRegulAIt: false`.
   - Nothing on this path authorises, refuses or rate-limits a governed call.

The adapter is API and backend only. The admin screen is a follow-up, posted on #453. On 2026-11-07 the owner decided that the six admin routes are listed as `KNOWN_UI_GAPS` (tracking #453) and that `KNOWN_UI_GAPS_MAX` is raised by exactly six, rather than building UI in this lane.

## Consequences

- Customers who run DefenseClaw get their endpoint decisions in RegulAIt's audit trail and findings. That covers some
  of P1's ground before P1 exists.
- **Schema drift risk.** The envelope is only partly documented and `v8` is moving quickly. The adapter pins `v8`,
  accepts only documented names, flat or dotted, and ignores everything else. The fixtures are synthetic and written
  from the docs. Before a customer install, the adapter must be checked against a real captured sample. If the real
  keys differ, the mapping changes in one pure module, `packages/shared/src/third-party-ingest/`.
- **OTLP is not built.** OTLP over `http/protobuf` needs a protobuf decoder. It is a follow-up and needs its own
  ADR-0176 search; the candidates are the OpenTelemetry JS proto packages (Apache-2.0).
- **Retention.** The evidence rows have no retention sweep yet. Retention should follow the compliance cascade
  (pillar 3), like the audit log, and is a follow-up.
- If DefenseClaw stops documenting its export or changes its licence, this adapter loses its basis (report §5).

### ADR-0176 search record

- No maintained open-source parser for DefenseClaw's export exists. It is a product-specific JSONL shape, parsed here
  with zod (already pinned).
- Token hashing, the step-up, pseudonyms, the findings upsert and the audit chain reuse RegulAIt's existing modules.
- The OTLP decoder (follow-up) is where an open-source module will be adopted.

### Migration

`packages/db/migrations/pending/third_party_ingest.sql`. Per ADR-0252 it has no number on the branch; the
assign-at-merge step numbers it and appends its journal entry after the merge.

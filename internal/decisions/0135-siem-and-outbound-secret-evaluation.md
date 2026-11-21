# ADR-0135 - SIEM delivery and outbound secret detection scope

- Status: Accepted for SIEM delivery, built by [ADR-0303](0303-siem-delivery-of-the-audit-chain.md) (2026-11-14); the outbound secret gate stays Proposed
- Date: 2026-09-30
- Scope: P3 evaluation only; no live SIEM sender or outbound block is enabled

## Current boundary

The hash-chained audit ledger and its signed/offline export are evidence
surfaces, not a low-latency SIEM feed. `semantic_dlp` includes deterministic
credential-material rules, but those are a limited pattern detector and do not
verify whether a candidate secret is live. The 10-case synthetic evaluation
currently yields TP=5, FP=0, FN=0, TN=5 on deliberately simple shapes. It
also pins two known misses: an unknown provider token and a short assignment.
Those numbers are a regression baseline, not a claim of real-world precision
or recall. The corpus contains no customer data or live credentials.

## Proposed SIEM delivery contract

1. Export a scrubbed, versioned event envelope from committed audit rows only:
   event ID, timestamp, tenant/scope, effect, rule ID, object identity, and
   audit-chain hash/sequence. Exclude raw prompts, connector payloads,
   credentials, and unreviewed free-form `detail`/`reason` fields.
2. Use an outbox cursor that advances only after remote acknowledgement.
   Delivery is at least once; consumers deduplicate by immutable event ID.
   Preserve ledger order per tenant, while admitting inter-tenant concurrency.
3. Keep destination credentials encrypted, restrict egress/redirects, expose
   bounded retry/backoff, dead-letter state, lag, and explicit recovery. A
   sender failure must never roll back or block the underlying governance
   decision, and must never silently declare delivery complete.
4. Start with one adapter and its actual acknowledgement semantics. Azure
   Monitor Logs Ingestion uses a DCR and a JSON shape; AWS Security Lake's
   custom source requires OCSF/Parquet and partitioning. They are not the same
   transport. Do not advertise Splunk, Sentinel, Datadog, or LogScale support
   until each adapter passes a receiver contract test.

## Proposed outbound secret gate

Apply it to the exact outbound bytes immediately before model, connector, MCP,
PM, and other provider writes, after any transformations and before transport.
Classify the destination and distinguish explicitly authorized credential
use from accidental disclosure. A detector result should carry rule/category
and count only; raw matches must not enter logs, SIEM, or error bodies. Start
in report-only mode with customer-approved synthetic and sanitized corpora,
then measure false positives and misses per source/destination. No automatic
network verification of candidate secrets: such verification could transmit
a real credential to a third party. Blocking requires a separately approved
policy and integration tests that prove zero provider calls on a refusal.

## Acceptance evidence before implementation claims

- Fault-injected receiver tests: timeout, 429/5xx, duplicate acknowledgement,
  restart, ordering, replay, credential rotation, and redaction of every field.
- Precision/recall measurements on a larger, labeled, non-sensitive corpus,
  including encoded/split tokens, innocuous high-entropy data, and allowed
  credential-use paths. Report per-family results and unknown coverage.
- Paused-before-transport tests for every provider adapter, including a halt
  or secret-policy change after work was queued. Do not infer complete
  interception from route-level tests.

## Sources

- Azure Monitor Logs Ingestion API:
  https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview
- AWS Security Lake custom-source requirements:
  https://docs.aws.amazon.com/security-lake/latest/userguide/custom-sources.html
- Existing detector inspiration, not a substitute for product evaluation:
  https://github.com/trufflesecurity/trufflehog/blob/main/hack/docs/Adding_Detectors_external.md

## As built (2026-11-14, ADR-0303)

The "Proposed SIEM delivery contract" above is built by
[ADR-0303](0303-siem-delivery-of-the-audit-chain.md): the `regulait.siem.audit.v1` envelope (point 1), a
`siem_destinations` cursor over `audit_log.seq` that moves only on a 2xx (point 2), the data-key-encrypted Standard
Webhooks secret, the egress guard, backoff, dead-letter, lag and admin recovery (point 3), and one adapter, a signed JSON
batch over HTTPS, pinned by its receiver test (point 4). No Azure Monitor, Security Lake, Splunk, Sentinel, Datadog or
LogScale adapter is claimed. The "Proposed outbound secret gate" section is unchanged and not built.

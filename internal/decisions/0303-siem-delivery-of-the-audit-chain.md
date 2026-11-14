# ADR-0303: SIEM delivery of the audit chain (ADR-0135's delivery contract, built)

- **Status**: Accepted (builder lane L11, 2026-11-14; P18 C6 "move ADR-0135 from Proposed to built")
- **Date**: 2026-11-14
- **Index**: SIEM delivery: a signed, ordered, acknowledged outbox over the audit chain
- **Migration**: `pending/siem_delivery.sql` (numbered at merge, ADR-0252)

## Context

ADR-0135 proposed a SIEM delivery contract and enabled nothing. The P18 framework-coverage review (C6) asks for it to
be built. ADR-0135's outbound secret gate is a separate proposal and is not part of this ADR.

Search first (ADR-0176): no maintained library implements "an acknowledged outbox over our own hash-chained audit
table". The parts that are solved problems reuse what is pinned: Standard Webhooks signing through `standardwebhooks`
1.1.1 (MIT, already used by ADR-0173's outbound webhooks), the egress-guarded fetch, the data-key envelope, the step-up
and the ADR-0064 scheduler. No new dependency.

## Decision

Each point maps to ADR-0135's numbered contract.

1. **A scrubbed, versioned envelope (point 1).** `regulait.siem.audit.v1`. A batch carries `afterSeq`, `fromSeq`,
   `toSeq`, `count`, a `gap` flag, and events. Each event has exactly these fields: `id`, `seq`, `at`,
   `scope.deployMode`, `effect`, `ruleId`, `object.type`, `object.id` and `chain.prevHash`, `chain.rowHash`,
   `chain.version`. One function (`siemEventFromAuditRow`) builds every event, and a test pins its keys. `detail`,
   `reason`, `rule_chain`, the user and actor ids, server and tool names, prompts and payloads never leave. Only
   committed, chained rows (`seq` set) are read.
2. **An outbox cursor that moves on acknowledgement (point 2).** `siem_destinations.cursor_seq` moves to a batch's
   last `seq` only when the receiver answers 2xx. A failure resends the same rows with the same `webhook-id`, so
   delivery is at least once and in chain order (single tenant, so one order). Receivers deduplicate on the event id.
   Rows the audit prune removed before delivery are flagged `gap: true` on the next batch, never skipped silently.
   A new destination starts at the chain head (`startFrom: "now"`, the default) or at the beginning, by the admin's
   choice.
3. **Credentials, egress, retry, dead-letter, lag, recovery (point 3).**
   - The `whsec_` secret is stored under REGULAIT_DATA_KEY, shown once, and rotated behind a step-up.
   - Every POST goes through `createGuardedFetch` with the admin egress allow-list: default-deny, pinned addresses,
     no redirects, https unless both the destination and the host entry allow plaintext.
   - Failures back off at 30 s doubling, at most an hour. A 429's delta-seconds `Retry-After` is respected within
     that cap. After 12 consecutive failures the destination is dead-lettered, which is audited, and it stops until
     an admin recovers it (audited).
   - Only a fixed error code is stored (`http_5xx`, `timeout`, `egress_blocked` and the like), never receiver text.
   - The list route reports each destination's cursor and its lag behind the chain head.
   - Delivery runs only on the `siem-delivery-sweep` scheduler job (every 60 s, leased per destination with a token,
     so two passes never send the same batch). It reads the audit log and writes only its own table, plus an audit
     row on a state change. A sender failure cannot roll back, delay or block a governance decision, and a successful
     send writes no audit row, so delivery never feeds itself.
4. **One adapter (point 4).** A Standard Webhooks-signed JSON batch over HTTPS, with the contract defined here and
   pinned by a receiver test (`zz-adr0303-siem-delivery.test.ts`). The test covers 5xx, 429 with Retry-After,
   timeout, connection reset, 4xx, a duplicate send after a lost acknowledgement (same `webhook-id`), ordering across
   batches, egress refusal, a missing data key, dead-letter and recovery, concurrent passes, secret rotation and the
   field allow-list. Azure Monitor Logs Ingestion, AWS Security Lake (OCSF/Parquet), Splunk, Sentinel, Datadog and
   LogScale are **not** claimed. Each needs its own adapter and receiver test, per ADR-0135.

**Off by default (ADR-0180).** A new destination is disabled. Enabling one means audit metadata leaves the
deployment, so it is a `settings_relax` step-up bound to the destination and its URL, audited as a relaxation. There is
no route to change a destination's URL: a new URL is a new destination, so an enabled one cannot be re-pointed.

Owner question open: whether to add the acting user or agent id (a uuid) to the envelope. ADR-0135 lists event id,
time, scope, effect, rule, object identity and chain position only, so it is left out.

## Consequences

- A customer SIEM can receive the governance audit trail in near real time, verify each batch's signature, and check
  chain continuity from `prevHash`/`rowHash` against the signed offline export.
- The five admin routes are API-only. The screen is a known UI gap tracked on #453 (`KNOWN_UI_GAPS_MAX` raised by
  exactly five).
- ADR-0135 moves to "Accepted (delivery built by ADR-0303)". Its outbound secret gate stays proposed.

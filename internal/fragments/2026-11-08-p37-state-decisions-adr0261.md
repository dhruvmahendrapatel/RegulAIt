<!-- fold: state-decisions -->
**ADR-0261 (builder, 2026-11-07, Accepted, backlog P37): ingest Cisco DefenseClaw's audit export as attributed
third-party evidence.** Option (b) of the DefenseClaw comparison (`internal/reviews/2026-11-07-defenseclaw-comparison.md`).
`POST /v1/third-party-ingest/defenseclaw/records` takes the HTTP JSONL export (schema family v8, pinned; documented
fields only), authenticated in-route by one write-only `rgti_` token per source (hash only, shown once; the P13b scoped
credential had not landed, so this follows the SD4b enrolment-token pattern). A source is off until enabled with a
`settings_relax` step-up; issuing the token is also a step-up; all audited. The exporter cannot sign bodies, so replay
protection is a `(source, record_id)` dedup plus a 15-minute/5-minute window on the database clock; 1 MiB, 512 records,
64 KiB lines, per-line rejects, 100k records per source per hour. Identity, content and paths are dropped at parse time;
the host becomes the device pseudonym. Records are append-only (`third_party_ingest_records`) and name one audit-chain
row per batch (`attribution: third_party, enforcement: false`); risky records open `defenseclaw/<connector>` ADR-0195
findings (signal source `defenseclaw_export`). API only; the admin screen is tracked on #453. Follow-ups: OTLP
(protobuf decoder, ADR-0176 search), an evidence retention sweep, and a check against a real captured sample before a
customer install (the envelope is only partly documented).

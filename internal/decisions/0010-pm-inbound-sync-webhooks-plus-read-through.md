# 0010 — PM-tool inbound sync: webhooks + live read-through, no polling

Date: 2026-07-25
Status: Accepted

## Context

PM_TOOL_INTEGRATION_SPEC §3 requires bi-directional sync ("edits in the PM tool flow back";
"never drift silently") but deliberately names no transport — webhooks, polling, and lazy
read-through are all permitted. EPIC-06 slices 1–3 shipped the outbound half plus live
read-through for the three PM-authoritative fields (priority/description/acceptance-criteria
are never cached; `GET /v1/pm/links?live=true` resolves them from the tool at request time).
Two prior documented decisions constrain the design: RegulAIt owns node/stage **status**
(it owns the state machines), and the PM tool owns the three content fields.

## Decision

Inbound sync is **webhooks plus the existing live read-through — no polling scheduler**:

1. **Read-through stays the transport for PM-authoritative fields.** They are never stored,
   so they can never be stale and never conflict.
2. **A normalized webhook endpoint** (`POST /v1/pm/webhooks/:connectionName`) receives change
   signals: `{externalId, event: updated|deleted|commented, state?, fields?}`. Provider-specific
   payload translation (ADO service hooks, Jira webhooks) is an adapter concern layered later;
   the normalized shape is the contract — and doubles as the first piece of the spec's
   "generic webhook adapter".
3. **Per-connection webhook secret**, generated at connection creation, returned exactly once,
   stored as a sha256 hash (same discipline as API keys), verified with a constant-time compare.
   A connection with no secret rejects all webhook traffic.
4. **Inbound status NEVER overwrites the state machine.** RegulAIt records the reported state
   on the link (`inboundState`/`inboundAt`) and computes **drift** (reported state ≠ the mapped
   state for the node's current status). Drift is surfaced in the links view and written to the
   one audit trail — "never drift silently" means detect-and-surface, not auto-overwrite.
   `deleted` events mark the link orphaned. Every event lands in an append-only
   `pm_sync_events` log.

## Consequences

- No scheduler/queue infrastructure; near-real-time signals where the customer configures
  webhooks, and correctness-by-construction for content fields even where they don't.
- Air-gapped/BYOC deployments can post the same normalized shape from an internal bridge.
- Deferred: provider-specific webhook payload adapters, signature schemes beyond shared
  secret (e.g. HMAC), automated drift *resolution* (today it is surfaced, resolution is human),
  and polling as a fallback for tools that cannot call out.

## Amendment 2026-11-07: replay protection on every inbound path (S-03; migration 0304)

The 2026-11-07 whole-build review (finding **S-03**, high) found that no inbound path had replay protection: no
parser checked a timestamp, `pm_sync_events` is a plain append with no unique key (so a replay re-orphaned links,
re-flagged drift and re-triggered `prefer_regulait` pushes), the generic adapter still accepted a static
`x-regulait-webhook-secret` header, and the gateway fell back to a hash compare of that header when the ciphertext
or the data key was missing. The ADR-0200 checklist requires "webhook signatures verified with replay protection",
and ADR-0180 forbids grandfathering, so the decision text above (point 3's hash-and-header scheme) is superseded as
follows. The original text is left as written.

1. **A delivery record, once per connection.** `pm_webhook_deliveries` (migration 0304) holds one row per delivery
   that reached processing, unique on `(connection_id, content_sha256)` and, partially, on
   `(connection_id, delivery_id)`. `content_sha256` is the sha256 of the exact body (for the generic contract, of its
   signed `<timestamp>.<body>`). `delivery_id` is the provider's own id where it sends one: Jira
   `X-Atlassian-Webhook-Identifier`, Linear `Linear-Delivery`, Azure DevOps body `id`, monday body
   `event.triggerUuid`; Asana and generic send none. The gateway inserts the row with `ON CONFLICT DO NOTHING`
   before processing. A conflict on either key is a duplicate: answered **200 `{ ok: true, duplicate: true }`** (so
   the sender neither retries nor disables the hook), audited (`pm-webhook-duplicate`, effect `deny`, no secret
   material) and not processed. If processing fails, the row is removed so the provider's retry is processed.
   Handshakes and ignored payloads are not recorded: replaying them changes nothing.
2. **Signed timestamps within 300 s wherever one is signed** (the Slack ChatOps window,
   `CHATOPS_REPLAY_WINDOW_SECONDS`, reused as `PM_WEBHOOK_REPLAY_WINDOW_SECONDS`):
   - **Linear**: `webhookTimestamp` (ms) is inside the HMAC'd body; a body without it, or outside the window either
     side, is refused 401.
   - **Generic / mock** (our own contract, so the strict one): `x-regulait-timestamp: <unix seconds>` and
     `x-regulait-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`. This is the only accepted form.
     `signGenericInboundWebhook` in `@regulait/pm-provider` builds the headers for a bridge.
   - **Jira, monday, Azure DevOps, Asana** sign no timestamp (Jira and monday authenticate with a URL token, Azure
     DevOps with a basic-auth password, Asana signs the body only), so for them the delivery record is the only replay
     wall. That is a provider limit, stated here rather than hidden.
3. **Removed, no grandfathering:** the generic adapter's static `x-regulait-webhook-secret` header, its body-only
   signature, and the gateway's legacy hash compare. A connection without a webhook-secret ciphertext, or a gateway
   without `REGULAIT_DATA_KEY`, now refuses all webhook traffic (401).
4. **Bounded retention.** Rows are dedup markers, not evidence (the audit trail and `pm_sync_events` are the
   evidence). `prunePmWebhookDeliveries` deletes rows older than `PM_WEBHOOK_DELIVERY_RETENTION_DAYS` (30) on the
   database clock, hourly from the boot timers next to the ADR-0125 counter prune. Thirty days is far beyond the 300 s
   window and every provider's retry schedule (Asana 24 h, Linear 6 h). A missed prune only keeps rows longer, which
   refuses more replays, never fewer.
5. **Jira and monday URL tokens.** The `?token=` value IS the connection's webhook secret, so rotating the token is
   rotating that secret. The rotation path is ADR-0207 (G6), `POST /v1/pm/connections/:name/webhook-secret/rotate`
   with a 24-hour overlap, built on PR #605 (migration 0287). This change does not duplicate it. Until #605 merges,
   rotation is deleting and re-creating the connection (a new secret, registered again in the PM tool). Operator
   steps: rotate, update the webhook URL in Jira (System → WebHooks) or monday (Integrations → Webhooks) to the new
   `?token=`, and let the overlap expire (or rotate immediately if the old URL leaked).

**Not changed:** the outbound generic contract (`x-regulait-signature` over the body only, sent to a customer's
receiver). Moving it to the timestamped form is a named follow-up in PENDING.md, so a receiver can apply the same
window.

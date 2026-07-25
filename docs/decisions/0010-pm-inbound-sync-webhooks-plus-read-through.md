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

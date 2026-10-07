# ADR-0185: Batch 3 — memory retention, `/metrics`, MCP protocol coverage and transports, ownership

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** owner (retention default, owner-at-registration, metrics library — 2026-10-07); the rest follows
  ADR-0180 (secure by default) and ADR-0176 (open source first)
- **Builds on:** ADR-0183 batch 3 (DELIVERY_PLAN_2026-10-06 §Batch 3), ADR-0182 (the D4 evidence hold, A11, S5 alert
  ownership), ADR-0121 and its batch-2 amendment (Outlook send half), ADR-0089 (owner/unowned/orphaned)

## Context

Batch 3 closes the holes a buyer finds first: memory that is never deleted, no operational metrics, an MCP proxy that
speaks only `tools/*`, HTTP-only upstreams, and servers and connectors with no owner. Facts found on `main` @ 2ba28fa:

- The semantic-cache TTL is a read-time filter only (`semantic-cache-shared.ts:198-210`); no row is ever deleted.
  `conversations` has no retention setting and its DELETE has no hold check.
- The MCP proxy advertises only `tools` and has handlers only for `tools/list` and `tools/call`
  (`mcp-proxy.ts:1755-1832`). Every other method already gets the SDK's -32601; client notifications are dropped
  silently. So G3 opens methods one at a time behind a decision; it does not close a pass-through.
- `prom-client`, named in the plan, has had no release since 15.1.3 (2024-06-27): it fails ADR-0176's maintenance test.

## Decision

### Owner decisions (2026-10-07)
1. **Conversation retention: 30 days** after the last message, admin may lengthen to 2555 days (audited).
2. **Owners default to the registering admin.** A server or connector created with the bootstrap token and no owner is
   flagged `unowned`. No `owner_required` refusal.
3. **Metrics: OpenTelemetry** (`@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-prometheus`, Apache-2.0,
   pinned exactly) instead of `prom-client`.

Defaults taken without asking, each the strict choice: stdio servers get no environment values in this batch
(credential binding is a follow-up; isolation stays PF-06, batch 6); the Outlook allow-list holds exact mailboxes only
(no `@domain` entries); any not-closed incident covering an agent holds all its cache rows and conversations,
regardless of the hold toggle (as the D4 feedback sweep does).

### Migration 0169 (one hand-written file, `0169_batch3_memory_mcp_ownership.sql`)
Journal `when` = previous + 1,000,000 (CONTRIBUTING_PARALLEL_SESSIONS §4); never `drizzle-kit generate`.
- `org_settings`: `conversation_retention_days int NOT NULL DEFAULT 30` CHECK 1–2555; CHECK
  `semantic_cache_ttl_seconds BETWEEN 1 AND 2592000` (default 3600 stays); `mcp_upstream_transports jsonb NOT NULL
  DEFAULT '["streamable_http"]'`; `mcp_protocol_methods jsonb NOT NULL DEFAULT '[]'` (deny by default).
- `mcp_servers`: `transport text NOT NULL DEFAULT 'streamable_http'` CHECK IN (`streamable_http`,`sse`,`stdio`);
  `stdio_command text`, `stdio_args jsonb`, `stdio_command_digest text`; `owner_user_id uuid` FK users ON DELETE SET
  NULL; CHECK `mcp_servers_transport_shape` (a stdio row has `url = 'stdio:<name>'` and a command; others have neither).
  The `stdio:` sentinel URL fails the egress check on any path that forgets to branch on transport, so it fails closed.
- `connectors`: `owner_user_id uuid` FK users ON DELETE SET NULL.
- `chatops_connections`: `outlook_recipient_allow_list jsonb NOT NULL DEFAULT '[]'`, array, ≤ 50, non-empty only for
  `provider='outlook'`.
- `ai_incident_links`: object type `conversation` added. Indexes on `semantic_cache(created_at)` and
  `conversations(updated_at)`.

### I3 — memory retention that runs
New `memory-retention.ts`; scheduler jobs `semantic-cache-purge-sweep` (hourly) and `conversation-retention-sweep`
(daily), oldest first, bounded per pass, idempotent. The hold predicate (a not-closed incident links the conversation,
or covers its agent) is re-checked inside the DELETE. Enforced at read time too: an expired, unheld conversation is
404 `conversation_expired`; a user DELETE of a held conversation is 409 `incident_evidence_hold`. Audit:
`semantic-cache-purged` (one summary row per pass), `conversation-retention-purged` (one row per conversation, no
content). Relaxations ride `org-settings-updated` with `detail.transitions`.

### G5 — `/metrics`
Off unless `REGULAIT_METRICS_LISTEN` is set (a separate listener, e.g. `127.0.0.1:9464`); then
`REGULAIT_METRICS_TOKEN` (≥ 32 chars) is required or boot refuses. Bearer token, constant-time compare; 401
`metrics_unauthorized` is counted, not audited. `REGULAIT_METRICS_ON_MAIN_LISTENER` (default off) mounts it on the
public listener with the same check. Labels come from fixed vocabularies only (route template, status class, decision
surface and effect, server id, transport, outcome, breaker state, job): no user, project, email, tool name, raw URL or
URI. A `safeLabel()` allow-list plus the SDK cardinality limit (500).

### G3 — MCP protocol coverage
`mcp-protocol.ts` with `executeGovernedProtocolCall`. Governed: `resources/list`, `resources/templates/list`,
`resources/read`, `prompts/list`, `prompts/get`, `completion/complete`, `logging/setLevel`. Three gates in order: the
org enables the method (`mcp_protocol_methods`; else "Denied by policy", audited `mcp-method-disabled`); the upstream
advertises it (else -32601); a kernel decision on `ToolRef{serverId, name: mcp:resources|mcp:prompts|mcp:completion
(read)|mcp:logging (write), surface: "protocol"}`. **`readOnlyAll` does not cover `surface:"protocol"`**, so no
existing grant silently gains resource reads. A resource read is a data-access decision (data-scope rules on `uri`,
exact match). Resource contents, prompt messages and completion arguments go through the same scans as tool traffic.
The upstream connects only after an allow. Refused always (`mcp-method-unsupported`): `resources/(un)subscribe`,
`sampling/*`, `elicitation/*`, `roots/*`. An upstream tool named `mcp:*` is an admission finding (server held).

### G4 — stdio and SSE upstream transports
Official SDK transports (`@modelcontextprotocol/sdk` 1.32.0, already locked). SSE uses the same guarded, pinned fetch
as Streamable HTTP; a cross-origin `endpoint` event is refused. stdio needs a double opt-in: the host sets
`REGULAIT_MCP_STDIO_ALLOWED_DIRS` (unset = impossible) and an admin enables `stdio` in `mcp_upstream_transports`. The
command is an absolute path whose realpath is inside an allowed directory, a regular file, not world-writable; argv is
a fixed `string[]` (≤ 64 × 4 KiB, no NUL), never shell-interpolated; the child gets only the SDK's safe env (never
`DATABASE_URL` or `REGULAIT_DATA_KEY`); stderr is piped and discarded; one process per request, capped by
`REGULAIT_MCP_STDIO_MAX_PROCS` (4). The command's sha256 is pinned at registration (`mcp-stdio-digest-mismatch` at
connect). Changing the command or args resets admission to `unscanned`.

### I9 — owners and memory-store inventory
`ownerUserId` on servers and connectors (default: the acting admin); `PUT /v1/servers/:id/owner` and
`PUT /v1/connectors/:id/owner` (audited with transitions); `GET /v1/inventory/memory-stores` (counts only, never
content). `mcp_server` and `connector` join `ALERT_OWNER_SUBJECT_KINDS`; an orphaned owner escalates.

### Outlook recipient allow-list
Recipient = the registered mailbox plus the connection's allow-list (exact lower-cased mailboxes, ≤ 50, default
empty). `PATCH /v1/chatops/connections/:id {"outlookRecipientAllowList": [...]}`, audited
`chatops-outlook-recipients-changed` with transitions.

The HTTP contracts the web UI builds against are in `AgentCoordination.md` §4.8.

## Consequences
- Memory stops growing without bound, and nothing under an incident is ever purged.
- Operators get metrics without exposing personal data or opening a public endpoint by default.
- MCP clients can use resources, prompts and completion, each behind the same per-user decision as tools.
- stdio servers become possible on hosts that opt in, without shell interpolation or secret leakage.
- **Not covered:** `builder_agent_memory` and `project_context_items` have no retention sweep yet (the inventory
  reports `enforcedBy: null` honestly); stdio credential binding and process isolation (PF-06, batch 6).
- The A11 fix for X15-R01 records the preview's case-set digest in its audit row; moving it to a
  `decision_regression_runs.case_set_digest` column in 0169 is optional and left out unless the build needs it.

## Build plan
Step 1 (serial): a foundation commit — migration, journal, `schema.ts`, shared zod and constants, and no-op seams for
metrics and upstream destination checks. Step 2 (parallel, disjoint files): A — I3, I9, Outlook; B — G3; C — G4;
D — G5. Step 3: integrate on `b3-int`, full gateway suite, `demo:prepare`, a security review of G3 and G4, one PR.

## Amendment (2026-10-07, build)

Recorded at integration on `b3-int` (merges of `b3-a`, `b3-b`, `b3-c`, `b3-d` and the X15-H01 fix).

**G3 gate order changed.** The Decision lists three gates in the order *org enables the method → upstream advertises
it → kernel decision*. As built, "the upstream advertises it" is checked **after** the allow: knowing what an upstream
advertises needs its `initialize` answer, i.e. a connection, and the rule "the upstream connects only after an allow"
wins. So the order is: org enables the method (else "Denied by policy", audited `mcp-method-disabled`) → kernel
decision on the protocol `ToolRef` → admission, egress and breaker → connect → upstream advertises the capability
(else -32601). Nothing reaches the upstream before an allow; a method the upstream does not advertise costs one
handshake after an allow, never before.

**`/metrics` counting unit (G5 × G4).** Each upstream connect attempt is observed once, inside `guardedMcpConnect`
(the only function that opens an upstream session). Each call sequence — `tools/call`, the `tools/list` manifest sync,
a governed protocol request, the health probe's `tools/list` — is observed once through `withUpstreamRetry`'s
`observe` option. `connectUpstream` passes no `observe`, so no connect is counted twice
(`zz-adr0185-int-upstream-observe.test.ts` proves counter delta = requests the upstream received).

**Known gaps (accepted for this batch, each fails closed):**
- `resources/list` is refused (fails closed) for a user under a data-scope rule on `uri`: a listing cannot be decided
  per URI before it is fetched, so it is not served rather than served unfiltered.
- PII `redact` mode **refuses** protocol arguments that contain PII instead of redacting them (the consent and digest
  machinery for redacted arguments exists for tools only).
- `POST /v1/evaluate` and decision replay answer `unknown_tool` for the protocol grant names (`mcp:resources`, …):
  they resolve tools from the stored manifest, which never holds protocol grants.

**Residuals:**
- Admission mode `off` runs no manifest scan, so the reserved `mcp:` tool-name finding is not raised; the proxy still
  never lists or runs an upstream tool named `mcp:*` under a protocol grant, whatever the admission mode (verified by
  the G3 test with admission `off`).
- stdio digest TOCTOU: the command's sha256 is checked at connect and the binary is spawned just after, so a binary
  swapped in that window would run. Closing it needs process isolation (spawn from a verified, immutable copy) —
  PF-06, batch 6.
- The proxy route's pre-hijack 403 now carries the refusal's own contract code (`error: err.error`, e.g.
  `mcp_stdio_digest_mismatch`); a destination refusal is still `egress_blocked`.
- stdio argv is stored in the audit log and shown to admins, so it must carry no secret; nothing enforces that
  (documented in INSTALL.md). Credential binding for stdio children is PF-06, batch 6. (B3S-06)
- Only the stdio entry file is digest-pinned: the interpreter named on a script's `#!` line and the modules it
  loads are not. Pinning them needs process isolation (spawn from a verified, immutable copy): PF-06, batch 6.
  (B3S-06)

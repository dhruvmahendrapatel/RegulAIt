# ADR-0023: Structured-JSON connector credentials (Snowflake), `agents.systemPrompt` base-wins invariant, and `mcpDefaultMode` enforcement

- **Status**: Accepted
- **Date**: 2026-07-31

## Context

A reconciliation review left three verified-open items from the wave-3 connector/enterprise work:

1. **Snowflake connector (ROADMAP Batch B blocker)**: `connector_credentials` stores exactly one
   `token_ciphertext` + one optional `base_url`, but Snowflake key-pair auth needs four fields —
   account, user, private key, optional passphrase. The connector was deliberately left 501ing
   until this schema decision was owned.
2. **`agents.systemPrompt` (verified-open D item)**: the agent registry had no way for an admin to
   author a per-agent system prompt, and no defined relationship between such a prompt and the
   `system` field callers already send on dispatch.
3. **`mcpDefaultMode` declared-not-enforced**: the compliance cascade (migration 0020, §8.3)
   computes an effective `mcpDefaultMode` per project, and the compliance view honestly labeled it
   `declared-not-enforced` — the MCP proxy never consulted it.

## Decision

### 1. Multi-field connector credentials are a structured-JSON convention INSIDE the single ciphertext

For `kind=snowflake`, the connection's one `token` is the JSON document
`{"account", "user", "privateKey", "passphrase"?}` — serialized, then encrypted with the same
AES-256-GCM path every other connector token uses, into the same `token_ciphertext` column.

- **Chosen over new columns** (`account`, `user`, `private_key_ciphertext`, …) because per-kind
  DDL means a migration for every future multi-field connector forever, a widening per-kind
  branch in the credential routes, and N encryption paths instead of one. The JSON convention is
  **zero migration** for this credential and every future one — any multi-field connector adopts
  it for free.
- The shape is validated **at connection-create time** (`parseSnowflakeCredential`, exported by
  `@regulait/connector-provider`): non-JSON, missing/empty fields, and unknown extra fields each
  400 with an actionable message naming the expected document. The registry re-validates at
  invoke time so a stored credential predating validation still fails explicit, never opaque.
- `createConnectorCredentialSchema`'s token ceiling was raised 2048 → 16384 chars so a 4096-bit
  PEM key (~3.4k chars) fits the JSON document.

**Snowflake adapter semantics** (following the wave's Slack/GitHub/Jira conventions exactly):

- **Object = `DATABASE.SCHEMA`** (e.g. `ANALYTICS.PUBLIC`), NOT a warehouse. A warehouse is
  *compute* (which cluster burns credits); pillar 1's object scope exists to bound *data reach*,
  and database.schema is Snowflake's own containment unit for that — the analogue of the GitHub
  `owner/repo` slug and the Jira project key. The warehouse rides `payload.warehouse` as a plain
  execution parameter. Every statement is submitted with the SQL API's `database`/`schema` fields
  taken from the governed object (never the payload), so unqualified names resolve inside the
  authorized scope.
- **Auth**: RS256 key-pair JWT (node:crypto only) against the SQL API v2
  (`POST /api/v2/statements`), with Snowflake's fingerprint claim convention — for
  `Q = UPPER(account).UPPER(user)` and `fp = SHA256:base64(sha256(SPKI-DER public key))`:
  `iss = Q.fp`, `sub = Q`, `exp = iat + 300s`, one short-lived token per invoke. Headers:
  `Authorization: Bearer` + `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`.
- **Read/write discipline**: `operation:"read"` statements must start with
  SELECT / WITH / SHOW / DESCRIBE; `operation:"write"` with INSERT / UPDATE (DELETE/DDL are
  deliberately not offered this slice). Mismatches hard-fail 400 before any network call —
  adapters never reclassify. `read, object=null` is the connection-root read (adapter-generated
  `SHOW DATABASES`); caller SQL without an object is refused.
- **Statement-level guard is defense-in-depth, NOT a SQL parser** — recorded limitation: the
  adapter rejects multi-statement submissions (any `;` beyond a trailing one; the SQL API's own
  single-statement default is the real backstop since we never send `MULTI_STATEMENT_COUNT`) and
  checks only the first keyword. A `;` in a string literal is a false-positive rejection; a
  mutating statement smuggled through a CTE, and fully-qualified names reaching other databases,
  are ultimately bounded by the stored credential's own Snowflake role. The real containment
  stack is: pillar-1 object scoping (enforced in the gateway before the adapter runs) +
  least-privilege upstream roles + this guard.
- Typed `ConnectorRateLimitError` on HTTP 429 (+ Retry-After); `{message, code}` error bodies
  flattened into one actionable line. 14 fake-upstream package tests.

### 2. `agents.systemPrompt` (migration 0040) — the admin base ALWAYS wins

Nullable `system_prompt` text on `agents`. **Invariant, stated for the record:**

> When the served agent carries an admin-authored `systemPrompt`, that prompt is the dispatch's
> system BASE; a caller-supplied `system` is APPENDED after it (separated by a blank line) and
> can NEVER replace, precede, or truncate it. The admin prompt is a **governance artifact** —
> what the admin decided this agent *is* — so no caller-side field may displace it.

Enforced in `executeGovernedDispatch`, the ONE shared dispatch core — so the direct invoke path,
orchestration worker dispatches, and both compat shims (`/v1/messages`,
`/v1/chat/completions`) inherit the invariant with zero reimplementation (proved by test, not
assumed, including a compat-inheritance e2e). Null keeps today's behaviour byte-identical.
Admin surface: `systemPrompt` on agent create, `POST /v1/agents/:agentId/system-prompt`
(set/clear, admin-only), and a textarea on the admin portal's Agents panel. The prompt is not a
secret: it rides the agent row admins already read — disclosed policy context, not key material.

### 3. `mcpDefaultMode` is enforced on ATTRIBUTED MCP tool calls

`executeGovernedToolCall` (the shared primitive behind the MCP proxy AND the pillar-7 worker
loop) now loads the attributed project's effective `mcpDefaultMode` (same ANY-profile-tightens
composition as `effectiveCompliancePolicy`) for write-classified tools:

- **`read_only` denies write-classified tools BEFORE upstream dispatch** — and before any
  approval is queued or consumed: compliance beats approval; an approver cannot sign away a
  framework's read_only posture. Nothing executes, nothing bills.
- The denial is **decision-shaped** (`ruleId: mcp-default-mode`, reason naming the governing
  project by name+id and the governing profile tag(s)), so both consumers surface it through
  their existing denial handling — the proxy as the standard MCP policy error, the worker loop
  as an error tool_result. (MCP JSON-RPC has no HTTP 403 per call; the denial rides the
  protocol's error surface exactly like every other governed MCP deny.)
- Every denial writes an audit row (`effect: deny`, `ruleId: mcp-default-mode`, detail carrying
  projectId + governing tags + tool kind).
- **Unattributed calls keep today's behaviour byte-identical** — no project, no policy to
  enforce. That honesty gap is O11, tracked separately, and the compliance view's enforcement
  label now says exactly that (`enforced-on-attributed-mcp-tool-calls (unattributed calls carry
  no project — disclosed gap O11)`), replacing `declared-not-enforced`.

## Consequences

- Batch B closes: all eight declared connector-provider kinds are implemented; the registry's
  "no silent promises" 501 branch is now vestigial-by-vacancy but the rule stands for future kinds.
- Future multi-field connector credentials (e.g. OAuth client id/secret pairs) reuse the JSON
  convention with no migration — the convention, not the Snowflake case, is the decision.
- The credential JSON is only shape-validated; key/account VALIDITY still surfaces at first
  invoke (a deliberate scope line — no connection-test call at create time yet).
- Admins gain a real per-agent governance prompt; callers keep full expressiveness underneath
  it. Prompt-cache token estimates in the invoke route count only the caller-visible system —
  the admin base rides the wire uncounted by that estimator (a cost-annotation-only skew, noted).
- `mcpDefaultMode` on unattributed MCP calls remains unenforced and disclosed (O11); enforcing
  it would require mandatory attribution, which is an interception-settings posture question,
  not a cascade one.
- Migration 0040 is a single nullable column — behaviour-preserving by construction (the 0038
  invariant).

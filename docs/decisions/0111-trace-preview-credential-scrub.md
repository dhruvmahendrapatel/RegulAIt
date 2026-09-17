# ADR-0111 — F04's five surfaces, assessed one at a time: the trace preview leaked (and was EXPORTED), and it is fixed at ADR-0102's chokepoint; conversations leak by design and need an owner's answer

- **Status**: Accepted (with one **OPEN OWNER DECISION**, §"Conversations" below)
- **Date**: 2026-09-17
- **Relates to**: [ADR-0099](0099-audit-log-credential-scrub.md) (the detector and the marker
  grammar — reused by reference, never re-implemented),
  [ADR-0102](0102-operator-prose-credential-scrub.md) (the `createDb` Proxy chokepoint and the
  `PROSE_COLUMNS` registry this extends; its `PROSE_SCRUB === scrubAuditText` identity is what
  makes the cross-store agreement below possible),
  [ADR-0104](0104-approval-payload-binding.md) (which already scrubs the *same* tool arguments
  into `approvals.arguments_preview` — the disagreement this ADR removes),
  [ADR-0070](0070-trace-observability.md) (the OTLP exporter that turned this from an at-rest
  risk into an **egress** one), [ADR-0060](0060-tamper-evident-audit.md) (the Proxy both scrubs sit on)
- **Migration**: **none.** No column is added, dropped or backfilled. The fix is two strings in
  an application-layer registry; `drizzle-kit generate` was **not** run, and nothing in
  `packages/db/migrations/` is touched. Existing rows written before this change still hold
  whatever they held — stated as a limit below, not glossed.

## Context

External review finding **F04** said the ADR-0099/0102 credential scrub was only part of the
picture and named five surfaces nobody had assessed — **traces, conversations, exports, backups,
errors** — with an instruction attached: *assess them as separate surfaces; do not assert they
leak without evidence.*

This ADR is that assessment. Every cell in the table below was produced by putting a **synthetic**
credential into the surface and reading back what the surface actually holds — the stored row by
raw SQL after commit, or the exported bytes after serialisation. No real credential appears in any
test, fixture, commit or log; the AWS-shaped key is AWS's own published documentation example id.

One surface leaked, provably, and is fixed. One leaks by design and is an owner's call, not this
ADR's. Three are clean, and were checked rather than assumed.

## The surface-by-surface evidence table

| # | Surface | Reaches it unscrubbed? | Proven how |
|---|---|---|---|
| 1a | **`trace_spans.input_preview`** (tool ARGUMENTS; on an `llm` span, the prompt; on a connector span, the request payload) | **YES — was the leak. FIXED.** | A governed MCP tool call carrying `AKIAIOSFODNN7EXAMPLE` in its arguments. Before: the column held the key character for character. After: `[redacted:aws_key:20:1a5d44a2dca1]`, read back by raw SQL. `f04-trace-payload-scrub.test.ts` §1. |
| 1b | **`trace_spans.output_preview`** (tool RESULT / completion) | **YES — was the leak. FIXED.** | Same call, against an upstream that echoes its input, so one request exercised both columns. Same marker, same test. |
| 1c | **The OTLP export payload** (`buildOtlpPayload` → `gen_ai.input.messages` / `gen_ai.output.messages`) | **YES — was the leak, and it was EGRESS. FIXED.** | `buildOtlpPayload(… includeContent: true)` over the stored spans, then `JSON.stringify`. Before, the wire bytes were `"gen_ai.input.messages" … "{\"text\":\"… key AKIAIOSFODNN7EXAMPLE\"}"`. After: the marker, and `expect(wire).not.toContain(AWS_KEY)`. §3. |
| 1d | **`trace_spans.status_reason`** | No — already covered | ADR-0102 registered it (an `(err as Error).message` quoting a connection string was the same risk). Unchanged here; still asserted present in the inventory. |
| 1e | **`trace_spans.attributes`** (jsonb) | **No — assessed, NOT scrubbed, risk accepted** | Enumerated every `attributes:` literal that reaches `recordSpan`/`openSpan` (13 call sites across `mcp-proxy`, `agents-connectors`, `evals`, `workflows`, `orchestration`, `compat-core`, `policy-kernel`). Every value is an id, an enum, a rule id, an effect, or a count. The two caller-supplied strings are `requestedModel` and a connector `object` name — identifiers, not free text. The OTLP dump in §3 confirms the emitted attribute set carries no payload. See "Honest limits". |
| 2 | **Conversations** — `conversation_messages.content`, `conversations.title`, `conversations.summary` | **YES — by design. NOT fixed. OWNER DECISION REQUIRED.** | A real `POST /v1/agents/:id/invoke` with `conversationId`, input `"… my key is AKIAIOSFODNN7EXAMPLE please fix the pipeline"`. Both the user row and the assistant row hold the key verbatim; `conversations.title` is auto-derived from the first user turn (`autoTitle`) and holds it too. The `llm` span for the *same turn* now reads `[redacted:aws_key:20:1a5d44a2dca1]` — so the two records of one turn now deliberately disagree, and §"Conversations" argues why. |
| 3a | **`GET /v1/audit.csv`** | **No — clean** | Driven with a real request after writing rows through routes that had been fed the key. 200, 2111 bytes, no occurrence of the key. It re-reads `audit_log`, which ADR-0099 scrubbed at write time — an export that re-reads an already-scrubbed column. |
| 3b | **`GET /v1/reports/runs/:id/export`** (csv + json) | **No — clean** | `reportCsvRows` read in full: `meta`/`spend`/`governance`/`workflow` sections emit period labels, project ids and names, rule ids, counts and dollars. No prose column, no tool payload, no reason field is re-derived. |
| 3c | **`GET /v1/billing/statements/:id/export`** | **No — clean** | `statementCsvRows` read in full: dimensions, match keys, token counts, `billed_usd`/`UNPRICED`, seat counts. Same shape — aggregates only. |
| 3d | **`GET /v1/onboarding/export`** | **No — clean** | Roles and group→role mappings only; the existing suite already pins that it carries no users, no secrets and no admin flags. |
| 3e | **`GET /v1/projects/:id/costs.csv`**, `usage-events?format=csv` | **No — clean** | `usage_events` carries numbers plus `stop_reason`, which ADR-0102 already *named* as an exclusion for a stated reason (a provider finish-reason vocabulary, not free text). |
| 3f | **`POST /v1/tracing/export`** | **Was the leak — see 1c** | The only export that re-derived from an unscrubbed source. Fixed at the source column, so the export needed no change of its own. |
| 4a | **Backups — the control-plane dump** (`infra/scripts/pg-backup.sh`) | **No — and it must not be** | `pg_dump -Fc` of the whole database. It is a faithful copy, so its exposure *is* the database's exposure, exactly: anything fixed at write time is fixed in the dump, anything left plaintext is in the dump. A backup that redacted content would not restore. Work dir `chmod 0700`; the S3 destination's default bucket encryption applies, deliberately not a per-PUT `--sse` flag. |
| 4b | **Bytes written outside Postgres by the gateway** | **No — clean** | The only two writers are the audit-chain anchor sinks (`LocalWormSink.write` → a file, `S3ObjectLockSink.write` → a PutObject). An `AnchorRecord` is `{seq, rowHash, headAt, algorithm, payloadVersion, capturedAt}` — six scalars, a hash and two timestamps. No free-form text can reach either. |
| 4c | **`backup_runs`** (pillar-3 infra ledger) | **No — clean** | Read column by column: ids, two enums, timestamps, `size_bytes`, and a `source` label of the form `scheduler:<provider-kind>`. There is **no free-form column on the table at all.** |
| 4d | **Ciphertext columns** (`connector_credentials`, `model_credentials`, …) | **Not a leak — intentional encrypted storage** | Named here so the distinction is explicit rather than left for a reader to infer: these hold credentials *on purpose*, enveloped under the data key. A scrubber has no business there and none is applied. |
| 5a | **Errors — zod `invalid_string` / `invalid_type` 4xx bodies** | **No — clean** | `POST /v1/users` with `email: "not-an-email AKIAIOSFODNN7EXAMPLE"` → `400 {"issues":[{"validation":"email","code":"invalid_string","message":"Invalid email","path":["email"]}]}`. The **value is absent**; only its shape and path are returned. |
| 5b | **Errors — zod `invalid_enum_value` 4xx bodies** | **YES — proven, NOT fixed, risk stated** | `attachments[0].kind: "AKIAIOSFODNN7EXAMPLE"` → `400 {"issues":[{"received":"AKIAIOSFODNN7EXAMPLE","code":"invalid_enum_value",…}]}`. zod puts the rejected **value** in `received` for this issue code and only this one. See "Honest limits". |
| 5c | **Errors — a `detail` string interpolating a STORED value** | **YES — proven, NOT fixed, risk stated** | A server named `"zz-srv AKIAIOSFODNN7EXAMPLE"`, then `POST /v1/servers/:id/admission/clear` → `409 {"error":"not_held","detail":"MCP server 'zz-srv AKIAIOSFODNN7EXAMPLE' is in admission state 'unscanned' …"}`. The echo is of a `name` column, which ADR-0102 explicitly declines to scrub. |

## Decision

**Register `trace_spans.input_preview` and `trace_spans.output_preview` in ADR-0102's existing
`PROSE_COLUMNS` registry.** That is the whole fix: two strings, at the chokepoint that already
exists, using the detector that already exists.

Three things follow from siting it there rather than at the two call sites:

1. **It is not a convention anyone has to remember.** ADR-0099 rejected per-call-site scrubbing
   and the reasoning is unchanged. `recordSpan` is one function today, but `inputText` is filled
   by six different dispatch paths and the seventh will be written by someone who has never read
   this ADR. The `createDb` Proxy sees the insert whoever wrote it.
2. **It fixes the OTLP export for free.** `otelAttributesForSpan` reads the two columns off the
   stored span. Scrub the column and the wire is scrubbed; there is no second place to keep in
   sync, and no possibility of the row and the export disagreeing.
3. **The marker is byte-identical across stores, because it is the same function.** ADR-0102
   pinned `PROSE_SCRUB === scrubAuditText` precisely so two records of one event cannot disagree.
   The test asserts the marker in `trace_spans.input_preview` is character-for-character the one
   in `audit_log.reason` **and** the one in `mcp_servers.admission_clear_reason` for the same
   secret, and that it equals `scrubAuditText(AWS_KEY)` — so all three correlate rather than
   contradict.

**A second, incidental hardening.** `PROSE_COLUMNS` was built with `new Map(REGISTRY.map(…))`,
which keeps only the **last** value for a repeated key. Adding a second `traceSpans` entry would
therefore have silently dropped `statusReason`'s coverage **while `proseScrubInventory()` — which
reads the array — kept reporting it as covered**: a scrub that looks registered and is not, which
is the exact failure class this machinery exists to prevent. The columns are merged into one
entry, and the map is now built with an explicit duplicate-table guard that throws at module load.

## Conversations — the OPEN OWNER DECISION this ADR deliberately does not make

`conversation_messages.content` holds a pasted credential verbatim. That is **proven** (table row
2), it is **not fixed**, and it should not be fixed by an agent acting alone.

Scrubbing a reason column and scrubbing a user's chat message are different contracts:

- An **operator reason** is an explanation of an action. A credential in it is always an accident,
  and the sentence around it survives the scrub intact, so nothing an operator meant to say is
  lost. That is why ADR-0102's safety case holds.
- A **conversation turn** is the user's own content, stored so the thread can be replayed and so
  an operator can audit what was actually said. If a user pastes a config file into chat and asks
  "why is this failing", the credential *is* the subject of the conversation. Redacting it breaks
  the next turn's context, breaks the compaction summary built from it, and destroys the evidence
  the product exists to keep. Getting this wrong is not a small over-scrub; it is silent data loss
  in the one place the product promises fidelity.

**What this ADR does instead, and why it is a defensible interim position.** It draws the line at
**the observability copy, not the record**:

- `trace_spans.input_preview` / `output_preview` — the copy that is truncated, switchable off
  wholesale (`tracingCaptureContent`), and **exported off-platform** — is scrubbed.
- `conversation_messages.content` — the faithful record, which never leaves the platform through
  any export path assessed above — is untouched.

So the credential-shaped egress path is closed today, and the fidelity question is still open for
the owner to answer. The cost of that split is stated plainly and is real: **the two records of
one turn now disagree**, which is the shape of the defect S5 was about, inverted. It is accepted
here only because the disagreement is in the safe direction (the exported copy is the redacted
one) and because the alternative — an agent unilaterally deciding to redact user content — is
worse.

**The owner's options, for the record:** (a) leave it, accepting that a credential in chat is
stored plaintext and reachable by anyone entitled to that conversation; (b) scrub it like any
other column, accepting the fidelity loss; (c) scrub the READ/export surfaces of conversations
while storing faithfully; (d) detect-and-warn at intake (tell the user they pasted a credential)
without altering what is stored. This ADR takes none of them.

## What this deliberately does NOT do

- **It does not scrub conversations, `name`, `title`, `description`, `summary` or `body`.** ADR-0102's
  content/prose line stands; §"Conversations" says why crossing it is not an agent's call.
- **It does not scrub `trace_spans.attributes`.** Row 1e: every value that reaches it is an
  identifier or a count, enumerated at the 13 call sites. Scrubbing a jsonb attribute bag would
  mean running the detector over rule ids and model names on the hottest write path in the tracer
  for no proven gain.
- **It does not fix the error echoes (5b, 5c).** Both are proven and both are left. 5b returns the
  caller their own rejected value in the same response — no third party sees it, nothing persists
  it, and the fix (post-processing every zod issue) would put a scrub on every 400 in the product
  for a case that requires a credential to be typed into a two-member enum. 5c echoes a `name`
  column that the same caller can read with a `GET`. Neither is asserted to be *safe*; both are
  asserted to be *low* and are recorded here so the next reviewer does not have to re-find them.
- **It does not backfill.** Rows written before this change still hold what they held. There is
  no migration and no `UPDATE`, deliberately: ADR-0099's argument applies — the write is the
  chance, and rewriting historical observability data would be a worse precedent than the residue.
- **It does not touch the backup path.** Row 4a: a dump that redacted would not restore.
- **It is application-layer, like ADR-0060/0099/0102.** A `psql` session or a module building its
  own `pg.Pool` bypasses it.

## Honest limits

1. **Content-faithfulness is a real cost, and it is paid here.** A tool payload or a model
   completion that genuinely contained credential-shaped text no longer shows it in the trace. An
   operator debugging "why did this tool call fail" may now see
   `[redacted:aws_key:20:1a5d44a2dca1]` where the answer was "because the key was malformed". The
   marker's length and fingerprint keep the shape and the correlation handle, and ADR-0104's
   `approvals.arguments_preview` had already accepted exactly this trade for the same bytes — but
   it is a loss, not a free win.
2. **False positives land on content now, not just on prose.** `CREDENTIAL_MATERIAL_RULES` is
   shape-based. A code snippet a user asks a model to review, echoed into `output_preview`, can
   trip `dlp.secret.assignment` on a line that is documentation. Previously that only cost an
   operator a mangled reason field; now it can cost a redacted span. The over-scrub guard test
   pins the realistic negative case byte-for-byte, but it cannot enumerate all of them.
3. **The two records of a conversation turn now disagree** — see §"Conversations". Open.
4. **`attributes` is assessed, not guarded.** A future call site that puts free text in an
   attribute bag would be uncovered, and nothing tests for that. Row 1e is a snapshot of 13 call
   sites on 2026-09-17.
5. **Rows written before today are unchanged**, and the OTLP exporter will happily export an old
   unscrubbed span. There is no "scrub on read".
6. **The error echoes (5b, 5c) are open**, deliberately, and are stated above rather than closed.
7. **Truncation interacts with the scrub.** `tracePreview` cuts at `previewMaxChars` *after* the
   scrub in the tool path, so a marker can in principle be cut in half at the boundary. It cannot
   reveal a secret (the marker contains none), but a reader may see a fragment.

## Non-vacuity

Two probes, each answering "is this fix load-bearing?" — never "is this assertion
discriminating?", which is M-033's distinction.

1. **Remove the fix.** Reverting the registry entry to `[s.traceSpans, ["statusReason"]]` and
   rebuilding turns `f04-trace-payload-scrub.test.ts` from **5 passed** to **4 failed | 1 passed**.
   The four that redden are the stored-row test, the cross-store agreement test, the OTLP-bytes
   test and the inventory test. The one that still passes is the **over-scrub guard** — correctly,
   and informatively: that test exists to constrain the fix, not to depend on it, so a fix that is
   absent cannot make ordinary content wrong.
2. **Break the scrub in the other direction.** Replacing `PROSE_SCRUB` with a function that also
   rewrites an unrelated word turns the file into **1 failed | 4 passed**, and the one that
   reddens is exactly the over-scrub guard. So probe 1 and probe 2 redden **disjoint** sets of
   tests: the positive tests fail when the scrub is missing, the negative test fails when the
   scrub is too eager, and neither can pass by accident.

**On the negative assertions themselves (M-033).** Every `expect(x).not.toContain(AWS_KEY)` in the
new file is preceded by a positive assertion on the same value — the marker matches
`/\[redacted:aws_key:20:[0-9a-f]{12}\]/`, the per-run nonce is present, the row is the right span,
the wire really does carry `gen_ai.input.messages`. A null column, a missing span, an empty export
or a query that matched nothing therefore **fails** rather than trivially satisfying the negative.

**Shared-DB discipline.** Per-run uuid nonce on every fixture; reads filtered to rows this file
created; no mutation of the `org_settings` singleton; no absolute row counts.

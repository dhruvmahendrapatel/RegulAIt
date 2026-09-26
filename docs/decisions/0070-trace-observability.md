# ADR-0070: Trace/span observability — a causal tree over the records we already keep, in which a refusal is a span

- **Status**: Accepted
- **Date**: 2026-08-07
- **Migration**: 0082
- **Slice**: [COMPETITIVE_PARITY_PLAN.md](../product/COMPETITIVE_PARITY_PLAN.md) §1 Slice F
- **Parity target**: Langfuse, Helicone, LangSmith
- **Extends**: [ADR-0053](0053-public-api-sdks.md) (the orchestration DAG this is a tree
  over), [ADR-0049](0049-cost-forecasting-anomaly.md)/[ADR-0051](0051-metering-billing.md) (the
  metered ledger a span references), [ADR-0060](0060-tamper-evident-audit.md) (the hash-chained
  audit log a deny span references), [ADR-0042](0042-guardrail-engine.md)/[ADR-0065](0065-regulait-llm.md)
  (the PII posture content rides), [ADR-0066](0066-gateway-parity.md) (the fallback hops that must
  be visible), [ADR-0034](0034-custom-llm-providers-egress-guard.md)/[ADR-0062](0062-mode-scoped-egress.md)
  (the egress guard the exporter goes through), [ADR-0041](0041-byoc-primary-motion.md) (air-gapped
  as the primary motion), [ADR-0069](0069-cross-vendor-cost-consolidation.md) (the self-or-admin
  read precedent this copies exactly)

## The verified starting position

A pre-slice grep confirmed both halves of the premise, and this ADR is written because the
previous slice's brief was drafted from a paragraph that turned out to be half wrong:

- **No trace or span model anywhere in `packages/db/src/schema.ts`.** No table, no column, no
  parent pointer, nothing.
- **No OpenTelemetry dependency in any package.json** in this repository. (`drizzle-orm` carries
  an optional `@opentelemetry/api` peer we never installed or referenced.)

What *did* exist was every fact a trace is made of, scattered across the tables that own them:
`orchestration_runs` plus the node statuses inside `state` (a DAG); `usage_events` (per-call
tokens, provider, model, measured cost, now carrying `virtual_key_id`); `audit_log`, hash-chained,
holding every governance decision including every ADR-0066 fallback hop; guardrail verdicts, eval
runs, red-team trials, lineage nodes; workflow instances and stages.

## Context

### The gap is a SHAPE, not data

A DAG plus a flat ledger plus an append-only decision log is not a causal tree. Nothing in the
product said *"this model call happened inside that node, which happened inside that run; this tool
call was asked for by that specific model turn; and the reason there is no model call at all under
this branch is that pillar 1 said no."*

That last clause is the whole ADR. Every incumbent in this space — Langfuse, Helicone, LangSmith —
traces what happened. **A governance product's most valuable trace is the one that shows why
nothing happened**, and none of them are positioned to record it, because none of them are the
thing that refused.

### The failure mode this ADR is organised around

> Add a `spans` table. Write a row when a model call returns. Indent the UI by span kind. Ship.

That produces four things that are each individually fatal:

1. **A flat list relabelled.** Without real parent links recorded at the moment causality is known,
   parentage has to be *inferred* afterwards from timestamps and ids — which is guessing.
2. **A trace of only the successes.** Denials return early, before the "write a span when a call
   returns" line, so the single most valuable record is systematically the one that is missing.
3. **A second copy of the ledger.** Re-recording tokens and cost into a span table creates two
   numbers for one call, which will disagree the first time a rate card changes.
4. **An outbound connection nobody asked for.** An OTel SDK's default posture is a background batch
   exporter that wants a socket, on a product whose primary deployment mode is air-gapped.

So the rules this ADR is built around, each of which is a test:

> **A span REFERENCES; it does not restate. A governance DENY is a PRESENT span carrying its
> reason. A hop is a CHILD of the attempt that failed. Nothing dials out unless an admin typed an
> endpoint.**

## Decision

**Add a `traces`/`trace_spans` model over the existing records, record it from the ONE governed
dispatch core and the ONE governed tool-call primitive, render it as an inspectable tree in the
SPA, and export it as OTel GenAI-semantic-convention OTLP — opt-in, through the egress guard.**

### 1. The model (migration 0082)

`traces` is one causal tree: `session_id` (the thread grouping), `kind`, `root_ref_id` (the run /
conversation / server this is the trace *of*), `user_id`, `project_id`, status, timings, and
rollups (`span_count`, `denied_span_count`, tokens, cost) so the LIST view is one query rather
than a fan-out over every span of every trace on the page.

`trace_spans` is the tree: `parent_span_id` (self-referencing, `ON DELETE CASCADE`), `seq`, `kind`,
`status`, `status_reason`, timings, and the references — `usage_event_id`, `audit_log_id`,
`run_id`, `node_id`, `agent_id`, `mcp_server_id`, `connector_id`.

**The denormalisation, and its justification.** Five fields are copied onto the span: `provider`,
`model`, `input_tokens`, `output_tokens`, `cost_usd`. A tree over a large run renders every span's
cost at once; joining each of them back to `usage_events` is the textbook N+1, and a tree view that
took N round trips would be unusable on exactly the runs that most need one. The copy is written
FROM the referenced row, in the same call that inserted it, and `tracing.test.ts` **joins the span
back to `usage_events` by `usage_event_id` and asserts every copied figure still agrees** rather
than trusting the copy. Nothing else is duplicated: prompts and outputs are previews (below), and
every governance decision stays in `audit_log` with the span pointing at it.

**`seq` exists because timestamps collide.** On an in-process path several spans share a
millisecond. Sibling order is the stored monotonic per-trace counter, allocated by the same atomic
`UPDATE ... RETURNING span_count` that maintains the rollups. A tree whose children reorder between
two reads is not a trace.

### 2. Where spans are recorded, and why that placement is the argument

The recorder **wraps** `dispatchAttempt` (the pre-0070 body of the dispatch core) rather than being
scattered through it. That is not a tidiness preference — it is what makes the deny rule provable.
`dispatchAttempt` has a dozen early returns, and *every one of them* flows through the wrapper and
lands as a `denied` span carrying its stated reason: the virtual-key allow-list and budget, the
ADR-0045 MRM gate, the pillar-5 project budget, the §8.4 PII input block, the ADR-0042 guardrail
input block, the ADR-0034/0062 egress refusals, a missing credential, an undispatchable agent.
Adding a thirteenth refusal to the core cannot forget to be traced, because nothing in the core
mentions tracing.

`model_dispatch_failed` is the one non-decision: it records as `error`, not `denied`, because it is
a transport fault rather than a verdict — the same distinction ADR-0066 rule 1 draws when deciding
whether to hop.

**The pillar-1 entitlement denial never reaches the core**, so it is recorded where it is decided:
at `POST /v1/agents/:agentId/invoke` and in the shared compat core, each writing a one-span
`dispatch` trace whose root is a `policy` span referencing the `audit_log` row just written. Without
this the most common governance refusal in the product would be the one thing with no trace.

**Fallback hops nest under the attempt that failed.** ADR-0066 already audits every hop, but
auditing requires knowing to go looking. A hop is now a `fallback_hop` span whose `parent_span_id`
IS the failed primary attempt's span, so "I asked for X, it broke at the transport layer, and here
is what answered instead" reads off the indentation. A hop SKIPPED for governance reasons (a
disabled agent, an entitlement denial, a virtual key's allow-list) is a `denied` span too — a chain
that quietly dropped an unentitled hop would make a fallback look like a routing decision nobody
made.

**An orchestration run is four real levels**, each from a real relationship:
`run` → `run_node` → `llm` (one span per TURN of the bounded agentic loop) → `tool` (the calls that
turn made). The node span closes with its own status and reason, so a node that never ran is a
`denied` span saying why. The run's trace and root span close when the RUN turns terminal, not when
one of its dispatches returns.

**Governed MCP tool calls** are traced by wrapping `executeGovernedToolCall` the same way, so both
its callers — the MCP proxy route and the worker loop — are covered by one wrapper.

### 3. Session/thread grouping

`traces.session_id` is the grouping key, and it is derived rather than invented: a conversation
turn's session is the conversation id, a run's is the run id, a direct MCP tool call's is
`mcp:<serverId>`. `GET /v1/sessions` is one grouped query returning per-session trace/span/denial
counts and spend.

### 4. PII posture — the existing one, not a fourth

Spans carry prompts, tool arguments and outputs: the most sensitive data in the system. The output
preview is `result.outputText` — the text the dispatch core **already** ran through §8.4 PII and
ADR-0042 guardrails, with the withheld marker already substituted — truncated at
`tracingPreviewMaxChars` (default 4000, the same figure `eval_results.output_text` uses). That is
byte-for-byte the posture ADR-0044's eval results and ADR-0065's training ingest already hold.
`content_withheld` records that what is stored IS the marker, so a reader is never left guessing
whether a short preview is short because the answer was short.

Two refinements:

- **A refusal ABOUT the input does not store the input.** On `pii_blocked` / `guardrail_blocked`
  the span's input preview is the counts-only refusal string, not the prompt. Storing the very text
  a block refused would defeat the block.
- **`tracing_capture_content` may only ever NARROW.** Off keeps the tree, the timings, the costs and
  every deny reason, and stores no prompt or output at all — asserted by a test that dumps every
  span of the trace and requires the prompt string to appear nowhere.

**Retention is the compliance cascade's, with no new knob.** `runAuditPruneOnce` now deletes traces
older than the SAME §8.3 floor it prunes `audit_log` under (per-profile `auditRetentionDays`
composed max with `defaultAuditRetentionDays`, longest wins). Spans go with their trace by cascade.
A separate trace-retention dial would let an operator keep prompts for a year under a framework
whose cascade says ninety days, which is the exact drift a cascade exists to prevent. The
per-deploy-mode retention *overrides* are deliberately NOT applied to traces: they key off
`audit_log.deploy_mode`, which a trace has no equivalent of, and the global floor is the shorter of
the two and therefore the safe direction.

### 5. Access control — default-deny, self exception

A trace exposes another user's prompts, so reading one follows ADR-0069's
`GET /v1/users/:userId/cost-consolidated` precedent exactly. `GET /v1/traces`,
`GET /v1/traces/:traceId` and `GET /v1/sessions` are in `NON_ADMIN_ROUTES` and each refuses
in-handler unless the caller IS the subject. A non-admin passing `userId` for somebody else gets a
**403, not a silently narrowed result set** — a query string that quietly means something other
than what it says is how a read boundary erodes. Cross-user read attempts are audited as denials.
The exporter routes are not in `NON_ADMIN_ROUTES` at all: configuring and firing an outbound
telemetry pipe is an admin act.

The list order is explicit and total (`started_at DESC, id DESC`), because this project shipped a
list without an ORDER BY once and it passed for months before CI returned the rows the other way
round.

### 6. OpenTelemetry export — opt-in, hand-rolled, guarded

Spans export as **OTLP/HTTP JSON** using the published **OTel GenAI semantic conventions**:
`gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model` / `gen_ai.response.model`,
`gen_ai.usage.input_tokens` / `.output_tokens`, `gen_ai.response.finish_reasons`,
`gen_ai.tool.name` / `gen_ai.tool.call.id`, `gen_ai.conversation.id` + `session.id`, `enduser.id`,
and — only when the org allows storing content — `gen_ai.input.messages` / `gen_ai.output.messages`.
Everything the convention has no key for is namespaced `regulait.*` (`regulait.decision`,
`regulait.reason`, `regulait.cost.usd`, `regulait.run.id`, `regulait.usage_event.id`,
`regulait.audit_log.id`). **There is no standard GenAI cost key**, and inventing one inside
`gen_ai.*` would be squatting on somebody else's namespace; a test asserts `gen_ai.cost.usd` is
absent.

**No default endpoint exists** — not in the schema, not in the code, not in an env var. With
nothing configured, `POST /v1/tracing/export` answers a real **409 `otlp_not_configured`** whose
detail says plainly that this is the shipped state rather than a fault, because ADR-0041 makes
air-gapped the primary motion and traces are fully usable locally with no exporter at all. When an
admin types an endpoint it is adjudicated by the ADR-0034/0043 egress guard **at write time** (a
400 that saves nothing) **and again on every export** (DNS can be re-pointed, an allow entry can be
withdrawn), and the POST itself uses `createGuardedFetch` — the same re-validating, address-pinning,
redirect-refusing fetch every other adjudicated outbound surface uses. `tracing_otlp_headers` values
are redacted by the settings read surface: an OTLP collector header is conventionally a bearer
token.

## Alternatives rejected

**Project the tree at READ time from `orchestration_runs` + `usage_events` + `audit_log`, adding no
tables.** Genuinely attractive — zero duplication by construction, no migration, no write cost. It
was rejected because *parentage is not recoverable*. Nothing in `usage_events` says which model
turn asked for which tool call; nothing says a fallback hop belongs under the attempt it replaced;
and a projection would have to reconstruct that from `at` ordering, which is exactly the
"flat list relabelled" this slice exists to avoid. It would also be an N+1 or a very large join per
view. The recorded model costs four writes per dispatch and buys real causality.

**The OpenTelemetry SDK (`@opentelemetry/sdk-node` + the OTLP exporter).** Rejected, and the reason
is specific rather than dependency-aversion: we are not instrumenting a live process, we are
serialising rows that are already in a database. The SDK's value — context propagation across async
boundaries, samplers, batch span processors, auto-instrumentation — is entirely in the part we do
not need, while its cost lands squarely on this product: a transitive dependency tree in a
governance box somebody has to review, and a background exporter whose whole design assumption is
that opening a socket is fine. The OTLP/HTTP JSON body is a well-specified shape; the encoder is
~120 lines of pure function with no dependency, and it is unit-tested against the spec's own
constraints (32-hex trace ids, 16-hex span ids, fixed64 nanoseconds as decimal *strings*).
**If a future need arises for live span streaming with context propagation, revisit this** — the
decision is scoped to "serialise stored rows on demand", which is what the air-gapped-primary
posture makes correct today.

**A column on `usage_events` pointing at the span.** Rejected for the same reason ADR-0069 rejected
a `basis` column there: every existing statement, forecast, budget check and export reads that
table, and widening it for an observability feature puts a non-load-bearing column in the path of
every billing query.

**A trace-retention setting.** Rejected — see §4. Retention IS the cascade.

**Emitting a span on every governance evaluation everywhere.** Rejected: `/v1/evaluate`, the
visible-tools filter and the ABAC layer run on paths where nothing was going to be dispatched
anyway, and a trace of every policy read would bury the refusals that stopped real work. Spans are
recorded where a call was ATTEMPTED.

**A separate "Observability" nav group.** Rejected. Traces sit under **Governance**, beside the
audit log, because the question they answer is a governance question: the audit log says a decision
was taken, the trace says where in the call it landed and what it stopped.

## Performance — the measured shape

Measured on the dev box's Postgres 16, against a synthetic 2,000-span trace (ADR-0060's
~300–350 rows/s ceiling is the house standard for stating one of these):

| Operation | Measured |
|---|---|
| Span rows written (single-row inserts) | **835 rows/s** |
| Read ALL 2,000 spans of one trace | **42 ms, ONE query** (indexed on `(trace_id, seq)`) |
| Assemble the tree + flatten to render order (2,000 spans) | **7 ms**, pure, in-process |
| Encode 2,000 spans to OTLP JSON (2.6 MB) | **23 ms** |

**The tree read is not an N+1 and the test suite is not the only thing saying so**: one `SELECT`
for the trace, one for its spans, and parentage is assembled in memory. The export path is the
same — one `SELECT ... WHERE trace_id IN (...)` across every exported trace, never one per trace.

**The write cost, stated honestly.** The recorder performs **two statements per span** (the atomic
rollup/`seq` `UPDATE ... RETURNING`, then the `INSERT`), so the effective recorder throughput is
roughly **half** the 835 rows/s above, ≈400 spans/s. A typical single dispatch adds four writes
(open trace, rollup, span, close trace) and one settings read. That is real, and it is spent on a
path that is already waiting on a model provider over the network; it is NOT free on a run that
fans out to hundreds of nodes, which is why `tracing_enabled` is a real switch that writes nothing
at all when off (asserted).

The tree read is capped at **2,000 spans**, and a larger trace returns `truncated: true` with the
limit named rather than silently showing part of a tree.

## What this explicitly does NOT give you

Read this before citing anything above.

1. **A lost span is a hole, and the hole is reported rather than prevented.** Every write in the
   recorder is inside a `try/catch` that swallows: an observability layer that can 500 a governed
   dispatch is a liability. The cost is that a trace can be INCOMPLETE. The read surface returns
   `partial: true` when the trace's own rollup counted more spans than are stored, and the UI says
   so in words — but the span is gone and cannot be recovered.
2. **Not every governed surface is instrumented.** Covered: the one dispatch core (and therefore
   the invoke path, both compat shims, orchestration workers, evals, the copilot and decompose),
   the one governed MCP tool primitive, the orchestration run/node structure, and the entitlement
   denials at the invoke route and the compat core. **Not covered**: governed CONNECTOR calls
   (`connector` is a declared span kind with nothing writing it), workflow stages
   (`workflow_stage`, likewise), eval cases as their own spans (`eval_case`, likewise — an eval's
   dispatches DO produce `llm` spans, they are simply not grouped under an eval-run tree), git and
   PM provider calls, and the deploy path. Those kinds exist in the schema so adding them is a
   writer rather than a migration, and they are named follow-up.
3. **There is no prompt-playground diffing against a live trace.** The parity plan's Slice F
   paragraph names it; this slice did not build it. A span carries the prompt preview and the
   config version that served it (in `usage_events`), so the data is there — the screen is not.
4. **Streaming dispatches are traced at completion, not incrementally.** The span's duration is the
   whole call; there is no time-to-first-token measurement anywhere in this product.
5. **No sampling, and no per-project or per-agent tracing policy.** It is org-wide on or org-wide
   off. A high-volume deployment cannot yet say "trace 10%" or "trace only this project".
6. **The exporter is a PULL, not a pipeline.** Nothing is spooled, nothing is retried in the
   background, and a failed export changes no stored row (re-run it). There is no
   already-exported marker, so re-running an overlapping window sends those spans again; a
   collector that does not de-duplicate on span id will double-count. The ADR-0064 scheduler could
   drive it on a cadence — **it is not wired to, deliberately**, because an air-gapped-primary
   product should not ship with a timer that wants a socket.
7. **The OTLP span id is LOSSY.** OTLP span ids are 8 bytes and ours are 16-byte uuids, so the
   exported id is the first 8 bytes. Collision probability inside one exported trace is negligible
   (~10⁻¹⁵ at hundreds of spans) and the full uuid always rides along as `regulait.span.id`, but a
   receiving backend keyed only on the OTLP id is theoretically able to collide. The trace id is
   exact — a uuid is 16 bytes, which is what OTLP wants.
8. **A DENY exports as OTel status ERROR.** OTel's status enum has exactly three members and none
   of them means "deliberately refused". `UNSET` would make a governance refusal invisible in every
   off-the-shelf trace UI's error filter, which is the opposite of the point, so it goes out as
   `ERROR` with `regulait.decision=denied` beside it for anyone who needs to tell the two apart.
   **In someone else's Grafana, a governance refusal will look like a failure.** That is a real
   fidelity loss and it is why the RegulAIt-side viewer renders `DENIED` as its own word.
9. **The gen_ai content attribute names are a moving target.** `gen_ai.input.messages` /
   `gen_ai.output.messages` are the current shape of an experimental part of the convention, and
   earlier collectors expect `gen_ai.prompt` / `gen_ai.completion`. **Nothing here has been
   verified against a live OTLP collector** — same honesty line as ADR-0069's vendor presets. The
   encoder is spec-shaped and unit-tested; whether a particular Langfuse/Grafana/Honeycomb build
   accepts it unmodified is unverified, and the export route's `dryRun: true` exists so an operator
   can read the exact body before sending it.
10. **Cost figures are still list-price-derived**, inherited unchanged from `usage_events`. A span
    with `cost_usd: null` means the agent was unpriced, never that the call was free.
11. **A trace shows only what the GATEWAY mediated.** Not intra-model attribution, not a call that
    bypassed RegulAIt. The same completeness caveat ADR-0050's lineage graph carries, returned on
    every read as `TRACE_SCOPE_NOTE`.
12. **`tracing_capture_content` is org-wide, not per-project.** A deployment cannot yet keep
    content for unclassified projects and drop it for a HIPAA-tagged one; the compliance cascade
    governs retention but not capture. Named follow-up.

## Consequences

- The schema is at **migration 0082**; the gateway suite at **1,907 tests across 110 files**
  (1,889/109 before); `packages/shared` at **500** (480 before). policy-kernel 129,
  model-provider 122, infra-provider 174, training-provider 58 unchanged.
- `recordGuardrailDecision` now returns the audit row id it wrote (previously `void`) so a span can
  reference the decision rather than restate it. No behaviour change.
- `runAuditPruneOnce` returns an additional `tracesDeleted` count.
- `GET /v1/org/settings` now redacts `tracingOtlpHeaders` values. It is the only redaction that
  surface performs, and it is there because an OTLP header is conventionally a bearer token.
- Five new routes, all `internal` in the ADR-0053 stability registry: a span's shape should stay
  free to move while the feature settles, and pinning a one-week-old data model into the published
  contract would be a promise nobody should make yet.
- The SPA gains `/admin/traces` under **Governance**, beside the audit log.

---

## Amendment — 2026-08-15: the two disclosed gaps, closed

*This section is appended. Nothing above it has been edited; the Accepted decision stands as
written, and this records only what has changed since. Where a statement above is now false, this
amendment says so explicitly rather than leaving the reader to reconcile them.*

Two of the "What this explicitly does NOT give you" items were the same kind of defect the rest of
this repository keeps correcting — **a promise the code does not keep, and a number whose meaning
inverts** — so both are closed here rather than carried.

### Gap A — three declared span kinds nothing wrote (in fact FOUR)

Disclosure 2 named `connector`, `workflow_stage` and `eval_case` as declared span kinds with no
writer. A pre-work grep of every `recordSpan`/`openSpan` call site found the disclosure itself was
incomplete: **`guardrail` was a fourth**, declared in `TRACE_SPAN_KINDS` and in migration 0082's
CHECK constraint, emitted by nothing, and named nowhere in this ADR. Six kinds were written
(`run`, `run_node`, `llm`, `fallback_hop`, `tool`, `policy`); four were vocabulary only.

A span-kind list is a claim about coverage. Three of the four are now written by real seams and
the fourth is **removed**, on the rule that a kind is either emitted where a genuine seam exists
or deleted — never left as a label.

**`connector` — emitted at `POST /v1/connectors/:connectorId/invoke`.** This is where customer data
actually moves, so a trace that showed only the connector calls that succeeded would lose exactly
the records that matter. It is recorded by a **wrapper**, for the same reason the dispatch core's
span is: the handler has fourteen exits and eleven of them are refusals. The governed body now
answers into a small recorder (`ConnectorReplyRecorder`) instead of the Fastify reply, and one span
is written from whatever came back — so a fifteenth refusal added below cannot forget to be traced,
because nothing in the body mentions tracing. The span REFERENCES the `usage_events` row the call
billed (`.returning({ id })` at the one insert) and copies its figure from it in the same call;
input/output previews ride the existing §8.4/ADR-0042 posture, with a `pii_blocked` /
`guardrail_blocked` refusal storing the refusal string rather than the payload the block refused.
**Polarity**: every 4xx this route produces is a DECISION (entitlement, PII, guardrail, egress,
missing credential, unrecognised provider) and records as `denied`; only a 5xx — a 502 from the
upstream connector, a 503 for a missing data key — is an `error`. That is the same line
`dispatchOnce` draws when it calls `model_dispatch_failed` its one non-decision.

**`workflow_stage` — emitted at `applyEvent`,** the ONE choke point every workflow state change
goes through (sign-off, abort, artifact submission, a failing required check, a blocked deploy, a
rollback, a nested-run completion). `traceForRoot` gives one tree per INSTANCE keyed on the
instance id, so a multi-day workflow reads as one thing and each transition is a sibling span in
`seq` order. `approval_denied`, `abort`, `check_failed` and `deploy_blocked` are `denied` spans —
a human or a required gate refusing to let a change proceed is the workflow engine *working*.
`execution_failed` is the one non-decision and records as `error`. A transition the precondition
skipped writes nothing, because nothing changed.

**`eval_case` — emitted in `runEvalSuite`'s case loop,** closing the gap disclosure 2 described
precisely ("an eval's dispatches DO produce `llm` spans, they are simply not grouped under an
eval-run tree"). One `eval` trace per run, one `eval_case` span per case, and the governed dispatch
hangs UNDER its case because the case span is passed down as the parent context — the same nesting
`run → run_node → llm` uses, from the same primitive. A dispatch the platform refused closes the
case span via **`classifyDispatchFailure`**, the same shared classifier ADR-0072 unified the
red-team paths onto, so `denied` and `error` cannot drift apart here into a third opinion. **A low
score is NOT a failed span** — a measurement is not a fault, and only the judge instrument falling
over makes a case span anything other than `ok`. The `eval_results` row still scores a blocked
dispatch 0, unchanged, exactly as ADR-0072 §2.2 decided.

**`guardrail` — REMOVED from `TRACE_SPAN_KINDS` rather than given a writer.** An ADR-0042 verdict
is not a call that was ATTEMPTED; it is a property OF one, and it is already carried by the span it
acted on — the verdict in `attributes.guardrails`, a withholding in `content_withheld`, and a BLOCK
*is* that span's `denied` status with `guardrail_blocked` as its reason. A child `guardrail` span
would restate what its parent already says (violating this ADR's rule 1) and would double-count the
refusal in `traces.denied_span_count`. It is also the alternative this ADR already rejected under
"emitting a span on every governance evaluation everywhere".

**What keeps this true**: `tracing.test.ts` now enumerates `TRACE_SPAN_KINDS` and requires every
member to have been written by a path *that file itself drove*, restricted to its own users so a
sibling suite cannot lend it a kind. It asserts the converse too (nothing writes a kind the
vocabulary has never heard of), and that `guardrail` is in neither set. Adding a kind to the list
without a writer turns it red.

**Deliberately not done**: migration 0082's `trace_spans_kind_check` still PERMITS `'guardrail'`.
A CHECK is a bound on what may be written, not a claim about what is; narrowing it would cost a
schema migration for no behavioural change.

### Gap B — a governance DENY exported as OTel status ERROR

Disclosure 8 stated the problem in its own words: *"In someone else's Grafana, a governance refusal
will look like a failure."* That is the **third** appearance of the inversion ADR-0057 and ADR-0072
fixed twice elsewhere — a guardrail-BLOCKED probe scored as a defeat, a missing judge scored as a
bad answer, and now **defences working exported identically to defences failing**. For a product
whose entire pitch is that it is the thing that refuses, an export format in which its refusals are
indistinguishable from its outages is not a fidelity loss to disclose; it is a bug to fix.

The original reasoning was that OTel's status enum "has exactly three members and none of them means
'deliberately refused'", so `UNSET` would hide a refusal from an error filter. The premise is true
and the conclusion does not follow: making a refusal *visible as an outage* is worse than making it
invisible, because it manufactures incidents out of the product working. The correct place for the
distinction is an **attribute**, which is what a trace backend actually filters on.

**The mapping, checked against the specification on 2026-08-15 rather than recalled:**

| RegulAIt status | OTel StatusCode | basis |
|---|---|---|
| `ok` | `Ok` (1) | unchanged |
| `denied` | **`Unset` (0)** | the operation contains no error |
| `error` | `Error` (2) | unchanged |
| `running` | `Unset` (0) | unchanged |

- **OpenTelemetry trace API specification**, `specification/trace/api.md`
  (`open-telemetry/opentelemetry-specification`, `main`, retrieved 2026-08-15): the three codes are
  `Unset` — *"The default status"*; `Ok` — *"validated by an Application developer or Operator to
  have completed successfully"*; `Error` — *"The operation contains an error."* A governance refusal
  contains no error. The same spec: `Description` *"MUST only be used with the `Error` `StatusCode`
  value"* and *"MUST be IGNORED for `StatusCode` `Ok` & `Unset`"* — which is why a denied span now
  carries **no status message at all** and its reason rides an attribute instead. Leaving the reason
  in the status message would have put it in a field receivers are required to discard.
- **OpenTelemetry HTTP semantic conventions**, `docs/http/http-spans.md`
  (`open-telemetry/semantic-conventions`, `main`, retrieved 2026-08-15), supply the precedent for
  the exact shape of this call: *"For HTTP status codes in the 4xx range span status MUST be left
  unset in case of `SpanKind.SERVER` and SHOULD be set to `Error` in case of `SpanKind.CLIENT`."*
  A deliberate 4xx issued **by** the instrumented server is not that server's error. A pillar-1
  refusal is that case exactly: the gateway, acting as the server, refused its caller. The CLIENT
  half of the rule does not reach us — a denied span never made an upstream request, so there is no
  upstream status to reflect.
- **`error.type`** (`open-telemetry/semantic-conventions`, `docs/registry/attributes/error.md`,
  retrieved 2026-08-15): *"Describes a class of error the operation ended with"*, and
  instrumentations *"SHOULD NOT set `error.type`"* when the operation completed successfully.

**The distinction is queryable by attribute, not by prose.** `regulait.outcome` is emitted on
**every** span (`ok` | `denied` | `error` | `running`), so `regulait.outcome = "denied"` is one
filter clause in any backend's query language — and a span with no `regulait.outcome` is
recognisably an *old* export rather than an ambiguous one. A denied span additionally carries
`regulait.decision`, `regulait.reason` (the refusal's own words) and the new **`regulait.rule.id`**
(the kernel's rule id where the recorder had one, otherwise the dispatch core's error code — the
string an operator greps for). A genuine failure carries the **published** `error.type`, so an
error dashboard built by somebody who has never heard of RegulAIt keeps showing outages and stops
showing the governance layer holding.

**Two existing tests were REWRITTEN in place, not deleted** — one in `packages/shared`, one in the
gateway — each carrying a comment naming what it used to pin and why it changed. Both now assert
the boundary in **both** directions, and the gateway's runs against a refusal the real kernel
produced. A **control** test requires a genuine transport failure to still export as `Error` with
`error.type` present, because "map everything to Unset" would have bought honesty about refusals by
hiding real outages. Reverting `otelStatus` to the old mapping fails two tests in the shared suite
and two in the gateway.

**The SPA says it too.** `/admin/traces` already rendered `DENIED` as its own word with its own
tone; what it did not say was how that status would read in somebody else's backend. The Posture
card now carries the status→OTel mapping in the page's existing `KV` idiom, and a denied span's
inline reason line states that it exports as `Unset` with `regulait.outcome=denied`. An operator
who has to open an ADR to predict their own dashboard has not been told.

### What this amendment does NOT change

Disclosures 1, 3, 4, 5, 6, 7, 9, 10, 11 and 12 stand exactly as written. In particular: a lost span
is still a hole the API reports rather than prevents; there is still no sampling and no per-project
tracing policy; the exporter is still a pull with no spooling and no already-exported marker; the
OTLP span id is still the first 8 bytes of our uuid; and **nothing here has still been verified
against a live OTLP collector** — the encoder is spec-shaped and unit-tested, and whether a
particular Langfuse/Grafana/Honeycomb build accepts it unmodified remains unverified.

Three things this amendment adds to that list:

1. **The `workflow_stage` recorder may share the caller's open transaction.** `applyEvent` is
   handed the approvals-decide endpoint's own transaction, so the span write there runs inside it.
   The recorder's writes are simple and swallow their own errors, but a failure would poison that
   transaction rather than merely losing a span — the one place in the tracing layer where rule 2
   ("tracing never fails the call it is tracing") is weaker than elsewhere. It was accepted because
   the alternative was not tracing an approval DENIAL, which is the most valuable workflow span
   there is.
2. **A workflow trace closes only on a terminal instance status.** An instance parked at
   `blocked_on_approval` for a week has an open `running` trace, which is correct and also means
   the trace list shows long-lived running rows.
3. **`connector` spans do not nest under anything.** A connector call made from inside an
   orchestration run still opens its own one-span trace rather than hanging under the node that
   asked for it, because the connector route is reached directly by an HTTP caller and carries no
   run context. Named follow-up, not a claim of coverage.

### Verification

Full gateway suite on a freshly created database: **127 files, 2,118 → 2,124 passing**, the 9 MinIO
skips unchanged. `@regulait/shared` **619 → 622**. The gateway's +6 and shared's +3 are entirely
`tracing.test.ts` in each package (six new cases in the gateway — four seam tests plus the
enumeration plus the failure CONTROL; three in shared). `pnpm -r typecheck` and
`pnpm --filter @regulait/web build` are clean. No migration.

Non-vacuity was measured, not assumed. Disabling the connector writer fails 3 gateway cases;
disabling the `workflow_stage` writer fails 2; removing the `eval_case` parent link fails 1;
restoring `denied → ERROR` fails 2 in shared and 2 in the gateway.

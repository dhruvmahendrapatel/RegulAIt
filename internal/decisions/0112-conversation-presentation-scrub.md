# ADR-0112 — The owner answered ADR-0111's open question with option (c): conversations are stored FAITHFULLY and redacted at the PRESENTATION boundary — and that protects the API, not the data at rest

- **Status**: Accepted
- **Date**: 2026-09-19
- **Relates to**: [ADR-0111](0111-trace-preview-credential-scrub.md) (which proved the leak, listed
  the four options and deliberately took none of them — this ADR is the answer),
  [ADR-0099](0099-audit-log-credential-scrub.md) (the detector and the marker grammar, reused by
  reference and never re-implemented), [ADR-0102](0102-operator-prose-credential-scrub.md) (the
  `PROSE_SCRUB === scrubAuditText` identity that makes the marker agree across stores, and the
  "one chokepoint, not a per-call-site convention" argument this ADR applies to the READ side),
  [ADR-0021](0021-org-settings-configurability-layer.md) / compaction (the second model-bound path,
  which is why the replay guard is asserted twice)
- **Migration**: **none.** No column is added, dropped, backfilled or written differently.
  `drizzle-kit generate` was **not** run and nothing in `packages/db/migrations/` is touched. The
  conversation tables are byte-for-byte what they were; the change is one Fastify scope and two
  hooks on it.

## Context

ADR-0111 assessed external-review finding F04's five surfaces one at a time. Four were closed or
cleared. One was left open on purpose, because it was not an agent's call to make:

> `conversation_messages.content` holds a pasted credential verbatim. That is **proven** (table row
> 2), it is **not fixed**, and it should not be fixed by an agent acting alone.

The proof was a real `POST /v1/agents/:id/invoke` carrying `AKIAIOSFODNN7EXAMPLE` mid-sentence. The
**user turn** and the **assistant turn** both stored the key character for character;
`conversations.title`, auto-derived from the first user turn by `autoTitle`, stored it too; and the
compaction summary, built from the same turns, would carry it onward.

ADR-0111 recorded four options and took none:

| | Option | What it buys | What it costs |
|---|---|---|---|
| (a) | Leave it | nothing changes | a credential in chat is plaintext and readable by anyone entitled to that conversation |
| (b) | Scrub it at write time, like any other column | the secret is genuinely **gone** — from the row, the dump, the backup, `psql`, everything | the product silently destroys the user's own content; replay, compaction and the audit record all lose the thing being discussed |
| **(c)** | **Store faithfully, scrub the read and export surfaces** | **the API never hands a credential back out; the record stays true** | **the credential is still in the database; anything that bypasses the API sees it** |
| (d) | Detect-and-warn at intake, store unchanged | the user learns immediately | stores the secret anyway, and a warning nobody reads changes nothing |

**The owner chose (c).** This ADR implements it and states, at length and without softening, the
exact thing (c) does not buy.

## Decision

**The stored record stays byte-for-byte what was said. What the product HANDS OUT gets redacted.**

Two pieces, and the second one is the load-bearing half of the design:

### 1. One chokepoint on the presentation side — a route SCOPE, not a convention

`registerConversationRoutes` now declares its four routes inside an **encapsulated Fastify scope**,
and installs the scrub on that scope *before the first route exists*:

```ts
app.register(async (scope) => {
  installConversationPresentationScrub(scope);
  scope.post("/v1/conversations", …);
  …
});
```

ADR-0099 rejected per-call-site scrubbing and ADR-0102 restated why; the reasoning is unchanged on
the read side and, if anything, stronger. A route added to that file next month is covered because
of where it is declared, not because its author remembered a rule. That is the same structural
argument `createDb`'s Proxy gave the write side — find the one place the thing happens, and sit
there.

Two hooks, because Fastify has two payload shapes and a conversation export would be the second:

- **`preSerialization`** receives the OBJECT a handler returned, before JSON encoding.
  `scrubPresentedPayload` walks it and scrubs string leaves at any depth. Scrubbing before encoding
  is exact: the JSON is built afterwards, so a marker can never break the serialisation. `Date`,
  `Buffer`, numbers, `null` and booleans pass through untouched — scrubbing is defined over text,
  and `createdAt` must stay a `Date` or the wire shape changes.
- **`onSend`** is the backstop for a payload `preSerialization` never sees — a string or `Buffer`
  body, which is what a CSV/NDJSON conversation export would be. It **skips JSON**, which
  `preSerialization` already handled and which re-parsing could only mangle. **There is no
  conversation export route today** (see the enumeration); the backstop exists so that adding one
  does not silently open the surface back up.

The detector is `scrubAuditText`, reached through ADR-0102's `PROSE_SCRUB` alias.
`PRESENTATION_SCRUB` is a **reference**, not a copy, and a test asserts the identity. There is no
second detector and there must not be: the marker a user reads in a presented message has to be
byte-identical to the one `audit_log.reason` and `trace_spans.input_preview` produced for the same
secret in the same turn, or the three records of one event cannot be correlated — which was S5's
actual damage.

### 2. PRESENTATION IS NOT REPLAY — and the names say so

This is the part that breaks the product if it is got wrong, so it is worth being blunt about.

`loadOwnConversation` fed the **model-bound history**: `agents-connectors.ts` calls it to build the
prior turns sent to the provider on a multi-turn dispatch, and `compaction.ts` summarises the same
rows. **A scrub sited on the database read would send `[redacted:aws_key:20:…]` to the model where
the user's own prior message belongs**, and the thread would start answering a question nobody
asked. That siting is wrong and is explicitly out of scope.

So the loader is renamed **`loadOwnConversationForReplay`**, and its doc comment says what that
means and forbids the reuse. Naming carries the safety here: a future reader reaching for "the
loader" gets the one whose name is REPLAY and is told, at the definition, not to scrub it and not
to point a human-facing surface at it. The presentation path is a hook on a route scope and shares
no function with it.

**The split was not free, and it is not cosmetic.** There are TWO model-bound sources in the invoke
path and only one runs per dispatch: with compaction eligible the wire is built from
`ConversationContext.messages` inside `prepareConversationContext`; with the caller on optimizer
`passthrough`, compaction is skipped and the wire is `ConversationContext.history` instead. A scrub
mis-sited on either one corrupts replay. A first draft of the regression guard covered only the
compaction path and **stayed green while `history` was deliberately redacted** — so the guard now
asserts both, on two identities, and the probe that found the gap is recorded under Non-vacuity.

## The enumerated surfaces — what was checked, not what was assumed

| # | Surface | Carries conversation content? | Status |
|---|---|---|---|
| 1 | `GET /v1/conversations/:conversationId` — `title`, `summary`, `messages[].content`, `messages[].detail` | **YES, all four** | **Covered.** The detail route is the main leak: it returns the full transcript, the auto-title and the compaction summary in one body. |
| 2 | `GET /v1/conversations` (list) | **YES — `title`**, from `autoTitle`, i.e. the first 60 chars of the first user turn | **Covered.** A user who pastes a key as their opening line had it in a list payload, not just a detail one. |
| 3 | `POST /v1/conversations` (201 body) | No — `title` is `null` at create, and the body is ids and timestamps | Covered anyway, by being in the scope. Costs nothing: no string matches, so `scrubPresentedPayload` returns the identical object. |
| 4 | `DELETE /v1/conversations/:conversationId` | No — `{ removed: true }` | Covered by construction. |
| 5 | **A conversation export/download route** | — | **None exists.** `registerConversationRoutes` declares exactly four routes and none of them serves a file. The `onSend` backstop covers the non-JSON body a future one would return. |
| 6 | `conversations.summary` (the compaction summary), as presented | **YES** — it is built by summarising turns that may contain the credential, and `GET /:id` spreads the whole row | **Covered** by the same hook. Asserted with the column seeded directly, because what is under test is the presentation boundary — and the seed doubles as a demonstration of the at-rest limit below. |
| 7 | `POST /v1/agents/:id/invoke` — the 200 body and the SSE stream | The CURRENT turn's model output, yes. A STORED conversation read, no. | **Deliberately NOT covered**, and this is a judgement, not an oversight. That response is the model's answer travelling to the caller who just typed the input, in the same request; it persists nothing new and reaches no third party. Scrubbing it would redact a user's own live answer — including the case where the credential *is* the subject ("why is this key rejected?"). It is the same class as ADR-0111's rows 5b/5c and is left for the same reason. |
| 8 | `trace_spans.input_preview` / `output_preview`, and the OTLP export | Yes — the observability copy of the same turn | **Already covered**, ADR-0111. Unchanged here. |
| 9 | `audit_log.reason`; `approvals.arguments_preview` | Yes, for the tool-call path | **Already covered**, ADR-0099 / ADR-0104. Unchanged here. |
| 10 | `GET /v1/audit.csv`, `/v1/reports/runs/:id/export`, `/v1/billing/statements/:id/export`, `/v1/onboarding/export`, `/v1/projects/:id/costs.csv`, `usage-events?format=csv` | **No — re-checked, clean** | None of them reads `conversations` or `conversation_messages`. A repo-wide grep for readers of those two tables returns exactly two modules: `conversations.ts` (the four routes plus the replay loader) and `compaction.ts` (which writes the summary and reads the rows it was handed). ADR-0111 §3 had already cleared these exports on their own contents; this is the narrower check that they do not reach conversation storage. |
| 11 | `eval_results.output_text` | Eval content, not conversation content | **Out of scope, still open.** ADR-0111 named it as untouched and it remains so; S14 is about conversations. Flagged, not fixed. |
| 12 | Backups — `pg_dump`, restores, `psql`, any module with its own `pg.Pool` | **YES — verbatim, by design** | **NOT covered, and cannot be.** This is the whole difference between (c) and (b). See the next section, which is deliberately not a footnote. |
| 13 | `apps/web` (the console UI) | Renders whatever the API returns | **No change needed and none made.** The API now returns the marker, so the UI shows the marker. Reported to the web session rather than edited; the only thing worth considering there is whether a marker deserves a tooltip explaining it. |

## THE HONEST LIMIT — option (c) protects the API surface, NOT the data at rest

Read this before treating conversations as safe.

**The credential is still in the database, in plaintext.** `conversation_messages.content`,
`conversations.title` and `conversations.summary` hold exactly what the user typed. This ADR adds
nothing to the write path and removes nothing from the row. Therefore:

- a **`pg_dump`** contains the credential;
- a **restored backup** contains the credential;
- a **`psql` session** — an operator, a DBA, a support engineer, a break-glass console — reads it
  in the clear;
- **any module that opens its own `pg.Pool`** bypasses this control entirely, exactly as ADR-0060,
  ADR-0099 and ADR-0102 bypass is possible on the write side;
- a **replica, a logical-decoding stream, or a direct query from an analytics tool** sees it.

That is the precise difference between the owner's choice (c) and option (b). (b) would have made
the secret genuinely gone; (c) makes it *not handed out by our API*. Both are defensible; only one
of them is what shipped, and an operator responding to "a customer pasted a key into chat" must
plan on the basis of (c): **rotate the credential.** The product did not contain it, it stopped
echoing it.

**And model replay still sends the ORIGINAL text to the provider.** That is not a bug and is not
being solved: replaying the true conversation is the conversation working as intended, and the
scrub is deliberately absent from that path. The consequence, stated plainly because it is the kind
of thing that should never be discovered later: **a credential pasted into chat does reach the
model vendor** — on the turn it was typed, and again on every subsequent turn of that thread, and
again inside the compaction summarisation dispatch. That is inherent to (c) and to every option
short of (b). It is recorded here; it is not fixed here.

## What this deliberately does NOT do

- **No migration, no write-side change, no backfill.** The columns are untouched and rows written
  before today are unchanged. ADR-0099's argument does *not* transfer — there, the write was the
  only chance; here, the read is scrubbed every time, so historical rows are covered on
  presentation without rewriting anything. That is one genuine advantage (c) has over (b).
- **It does not scrub the replay path**, and a test exists to make sure nobody later does. See
  "Presentation is not replay" and Non-vacuity probe 3.
- **It does not scrub `POST /v1/agents/:id/invoke`** — row 7 above says why.
- **It does not add a detector, a rule, or a marker format.** `PRESENTATION_SCRUB` is
  `scrubAuditText` by reference. ADR-0102 pins `PROSE_SCRUB === scrubAuditText`; this does not fork
  it and a test asserts the identity.
- **It does not touch `apps/web`.** The API change is sufficient; anything the console wants to do
  about rendering a marker is the web session's call.
- **It does not extend the scope to other route files.** The hook covers the conversation scope
  only. Another module that begins returning conversation content would be outside it — and would
  also have to be the first reader of those tables outside `conversations.ts`/`compaction.ts`,
  which is the thing the enumeration above makes checkable.
- **It does not claim the backup path is safe.** See the at-rest section. A dump that redacted
  would not restore, exactly as ADR-0111 row 4a said.

## Honest limits

1. **At rest is unprotected.** Stated above at length rather than here in passing, because it is
   the single most important sentence in this document.
2. **The model vendor still receives the original text**, by design, on every turn of the thread.
3. **Content-faithfulness is the value being spent.** Where the redaction shows, a user loses the
   ability to *read back what they themselves pasted*. If someone pastes a config file and asks
   "why is this failing", the credential is the subject of the conversation — and from now on the
   transcript they scroll back through says `[redacted:aws_key:20:1a5d44a2dca1]` where their key
   was. The prose around it survives intact (the marker replaces the credential span only, and the
   assignment rule deliberately keeps the *field name*), and the model still has the real value, so
   the conversation itself still works. But the user cannot recover the string from our UI, and a
   support engineer reading the thread cannot see whether the key was malformed. The marker's
   length and fingerprint keep the shape and a correlation handle; they do not give the value back.
4. **False positives are presented, not just stored.** `CREDENTIAL_MATERIAL_RULES` is shape-based.
   A code snippet a user asks a model to review can trip `dlp.secret.assignment` on a line that is
   documentation, and the user will now see a marker in their own message. The over-scrub guard
   pins a realistic negative case byte-for-byte with `toBe`; it cannot enumerate all of them.
5. **The scrub runs on every conversation response.** It is a string walk over a payload that is
   usually a handful of fields, and `scrubPresentedPayload` returns the identical object when
   nothing matched — but the transcript route returns every message in the thread, so cost grows
   with thread length. No benchmark was taken; if a long thread ever becomes slow, this is a place
   to look.
6. **Scope coverage is structural, not global.** A future route in a *different* file that returns
   conversation content would not be covered. The enumeration is the mitigation, not a guarantee.
7. **`eval_results.output_text` remains open** (row 11), as ADR-0111 left it.
8. **The `onSend` backstop is untested against a real export**, because no conversation export
   exists to test it against. Its JSON-skip and its string/Buffer branches are exercised only by
   the ordinary JSON routes going through it unchanged.

## Non-vacuity

Four probes. Each answers "is this fix load-bearing, and is it load-bearing *in the right place*?"
— never "is this assertion discriminating?", which is M-033's distinction.

1. **Neutralise the scrub** (`PRESENTATION_SCRUB` = identity). `10 passed` becomes
   **`6 failed | 4 passed`**. The six that redden are every presentation positive: §1's
   both-halves test, §1's marker-agreement test, §2's title test, §2's summary test, §2's
   second-identity test, and §4's deep-leaf test. **The four that stay green are exactly the ones
   that should**: §3's two replay guards — which constrain the fix rather than depend on it — and
   §4's two over-scrub guards, which cannot be made wrong by a scrub that is absent.
2. **Make the scrub over-eager** (it also rewrites an unrelated ordinary word). `10 passed` becomes
   **`3 failed | 7 passed`**, and the three are §4's two over-scrub guards plus §1's
   marker-agreement test — which is correct and is the point of asserting
   `PRESENTATION_SCRUB === scrubAuditText`: a forked detector is caught even when it still redacts
   the secret. Probes 1 and 2 redden **near-disjoint** sets: the positives fail when the scrub is
   missing, the negatives fail when it is too eager, and neither can pass by accident.
3. **Mis-site the scrub on the replay path — the regression this ADR exists to prevent.** Two
   variants, because there are two model-bound sources:
   - scrub `ConversationContext.messages` (the compaction path): **exactly one test reddens**,
     §3's first, and every presentation test stays green — which is precisely the silent corruption
     the guard is for.
   - scrub `ConversationContext.history` (the passthrough path): **exactly one test reddens**,
     §3's second. **This probe is why that test exists.** The first draft of §3 covered only the
     compaction path and this variant passed 10/10 while the provider was being handed redacted
     text. The gap was found by running the probe, not by reading the code.
4. **Fixture honesty.** `autoTitle` truncates the title at 60 characters and the mock provider
   echoes only the first 8 words of the input, so an over-long fixture would cut the credential in
   half and the title and assistant-turn assertions would have passed for the wrong reason. The
   secret fixture is deliberately 54 characters and 5 words, and the first version of this test
   caught exactly that mistake by failing.

**On the negative assertions themselves (M-033).** Every `expect(x).not.toContain(AWS_KEY)` in the
new file is preceded by a positive assertion on the same value — the marker matches
`/\[redacted:aws_key:20:[0-9a-f]{12}\]/`, the per-run nonce is present, the message is the right
role, the route returned 200, the wire really has more than one turn. Several go further and pin
the whole string with `toBe(scrubAuditText(SECRET_TURN))`. A null field, a missing message, an
empty response or a query that matched nothing therefore **fails** rather than trivially satisfying
the negative.

**Both halves of (c) are asserted on the SAME message**, in one test, because either half alone is
a different product: the presented content carries the marker *and* the stored row, read back with
raw SQL after commit, is `toBe(SECRET_TURN)`.

**Synthetic credentials only.** `AKIAIOSFODNN7EXAMPLE` is AWS's own published documentation example
id and is the one ADR-0111 used. No real credential appears in this ADR, in the test, in any
fixture it writes, or in any log it produces.

**Shared-DB discipline.** Per-run uuid nonce on every fixture; every read filtered to rows this
file created; dispatch counts asserted as deltas, never absolutes; the `org_settings` singleton is
never touched (the passthrough case uses a per-user `agent-policy`, on a user this file creates).

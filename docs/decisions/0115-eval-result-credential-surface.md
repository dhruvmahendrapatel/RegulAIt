# ADR-0115 — The `eval_results` credential surface, assessed column by column: `output_text` and the judge's jsonb claims are left FAITHFUL and redacted at the presentation boundary; `error` is scrubbed at write time; `judge_rationale` was already covered and the premise that said otherwise was wrong

- **Status**: Accepted
- **Date**: 2026-09-19
- **Relates to**: [ADR-0111](0111-trace-preview-credential-scrub.md) (which **named**
  `eval_results.output_text` as a sixth surface and did not assess it — this ADR is that
  assessment), [ADR-0112](0112-conversation-presentation-scrub.md) (the owner's choice of option
  (c) for conversations, and the `preSerialization` + `onSend` scope plugin this reuses),
  [ADR-0102](0102-operator-prose-credential-scrub.md) (the `PROSE_COLUMNS` registry `error` joins,
  the `trace_spans.status_reason` precedent it joins on, and the `PROSE_SCRUB === scrubAuditText`
  identity that keeps one marker across stores), [ADR-0099](0099-audit-log-credential-scrub.md)
  (the detector and the marker grammar, reused by reference and never re-implemented),
  [ADR-0057](0057-continuous-red-teaming.md) / [ADR-0068](0068-redteam-depth.md) (the defeat
  record whose evidence this ADR refuses to destroy), [ADR-0044](0044-agent-evaluation-harness.md) (the
  4000-char truncation ceiling on `output_text`)
- **Migration**: **none.** No column is added, dropped, backfilled or renamed.
  `drizzle-kit generate` was **not** run and nothing in `packages/db/migrations/` is touched
  (migrations still end at 0109). The change is one string in an application-layer registry and
  three encapsulated Fastify scopes.

## Context

ADR-0111 assessed five surfaces named by external-review finding F04. In passing it **named a
sixth** — `eval_results.output_text` — and said it was deliberately left untouched. ADR-0112 then
put it explicitly out of scope, on the reasoning that eval content is not conversation content.

So it had **never had a synthetic-secret probe**. That is the whole of what was known when this
work started. Everything below was measured.

### The premise this work was scoped on was wrong, and correcting it is part of the finding

S22 was framed with the concern that `judge_rationale` "can quote the output it is judging — so a
scrub on `output_text` alone may be a half-fix", and that it should therefore be assessed as a
first-class part of this surface rather than a footnote.

**`eval_results.judge_rationale` was already registered in ADR-0102's `PROSE_COLUMNS` and has been
scrubbed at write time since that ADR shipped.** The probe confirms it: the stored rationale reads
`The model answered with the literal key [redacted:aws_key:20:1a5d44a2dca1], which is wrong.` The
half-fix worry is real but **inverted** — the rationale was the covered column and `output_text`
was the bare one. This is recorded here rather than by editing anyone else's text, and it is the
same shape as M-036: a claim about what is and is not protected is exactly the kind of claim that
reads as checked and is not.

### What the probe was and what it found

A synthetic AWS example id (`AKIAIOSFODNN7EXAMPLE` — AWS's own published documentation value; no
real credential appears in any file, fixture, commit or log) was carried the way a configured
secret actually reaches a model output: **in the agent's own system prompt**, with the shipped
red-team canary alongside it, against the mock provider that echoes its first system line. A real
governed eval run and a real published red-team run were driven through `runEvalSuite` and
`POST /v1/redteam/runs`, the committed rows were read back with raw SQL, and every read route was
driven over HTTP.

Predictions were written before the run; all six were confirmed, and the one about
`judge_rationale` is the one that mattered, because it contradicted the brief.

| Column / copy | At rest, BEFORE | Proven how |
|---|---|---|
| **`eval_results.output_text`** | **the key, character for character** | `select output_text from eval_results` after commit, on a run driven through `runEvalSuite` |
| **`eval_results.detail`** (jsonb) | **the key**, inside the judge's `claims[].claim` and `claims[].note`, duplicated into `unsupportedClaims[]` | same read, `detail::text` |
| **`eval_results.error`** | **the key**, inside `judge_failed: judge upstream 401 using key AKIAIOSFODNN7EXAMPLE for endpoint` — the runner interpolates `(e as Error).message` verbatim | same read |
| **`eval_results.judge_rationale`** | **already the marker** — ADR-0102 covers it | same read; the brief's premise, corrected |
| **`redteam_findings.output_snippet`** | **the key** — it is `r.outputText.slice(0, 4000)` of the row above | `select … from redteam_findings` after a real red-team run |
| **`redteam_probe_trials.output_snippet`** | **the key** — same slice, written per trial | same |

And on the wire, **six routes handed it out**, every one driven with a real request:

| Route | Carried it how |
|---|---|
| `GET /v1/evals/runs/:id` | spreads whole result rows (`...r`) **and** re-derives `groundedness.unsupportedClaims[].claim` from `detail` |
| `GET /v1/mrm/cards/:id` | `cardView` re-derives the same claims for every cited eval run |
| `GET /v1/mrm/cards` | same `cardView`, in the list |
| `GET /v1/redteam/runs/:id` | `findings[].outputSnippet` |
| `GET /v1/redteam/findings` | same, across runs |
| `GET /v1/redteam/runs/:id/trials` | `probeTrials[].outputSnippet` |

## The tension this ADR exists to resolve

**A red-team eval's entire purpose can be to prove the model leaks a secret.** The schema says so
in as many words: `redteam_findings` is *"one row per probe that got through, pointing at the
`eval_results` row holding the actual transcript — so 'which attack succeeded, and what did the
agent say' is one join, and the finding cannot drift from the evidence."* And
`packages/shared/src/redteam.ts` openly invites an operator to *"author a probe whose `forbidden`
marker is your own deployment's secret"* as a canary.

If `output_text` were scrubbed at write time, the product would record **"a probe got through"
while deleting what got through**, and the join the schema promises would land on a redacted
transcript. That is not a hardening; it is the destruction of the one artifact the feature exists
to produce.

Against that: an eval result is stored, is read back through the API by anyone entitled to eval
reads, and reaches a model card that a sign-off rests on. A credential arriving in a model's
output and leaving through `GET /v1/evals/runs/:id` is R3's leak in a new table.

**Scoring is unaffected either way, and that was verified rather than assumed.** The oracle runs
in memory inside `runEvalSuite` — `scoreDeterministic` / `judge.judge` / `callExternalScorer` are
handed `outcome.result.outputText` and the verdicts are pushed onto a local `scores` array; the
single `db.insert(evalResults)` happens afterwards, once, at `evals.ts:1044`. The red-team layer's
polarity decision reads `r.passed`, `r.score` and `detail.errorCode` — never the text. So no scrub
anywhere can change whether a defeat is detected. What a scrub changes is **what the human reading
the defeat afterwards can see**, which is precisely the thing worth protecting.

## Decision — and it is deliberately NOT one rule

ADR-0112 records four options: (a) leave it, (b) scrub at write time, (c) store faithfully and
scrub the read/export surfaces, (d) detect-and-warn. **Different columns get different answers,
and each one is argued.**

### `output_text` → **(c)**, and the red-team defeat is why

The stored row stays byte-for-byte what the model said. The **presentation** is redacted. This is
the owner's ADR-0112 choice applied to a surface where the argument for fidelity is *stronger*
than it was for conversations: a conversation's fidelity protects replay and audit; an eval
result's fidelity protects the evidence behind a security finding. Option (b) was rejected on that
ground alone. Option (a) was rejected because six routes hand the value to a third party. Option
(d) was rejected because an eval output is machine-produced — there is no human at intake to warn.

### `detail` (jsonb) → **(c)**, by the same hook

`detail.claims[].claim` is the judge quoting the output it is judging — the very content
`output_text` holds, arriving by a second door. It gets the same answer for the same reason.

There is also a mechanical fact: **the ADR-0102 registry cannot reach it.** `withProseScrub`
scrubs declared **string** columns; a jsonb bag is out of its type. ADR-0111 met this question at
`trace_spans.attributes` and answered it by **enumeration** — every value that reaches it is an
identifier or a count, so nothing needed scrubbing. That answer does not transfer: `claims[].claim`
is free text derived from a model output, and the probe found the key in it. The two ADRs reach
opposite conclusions about a jsonb column **because the columns hold opposite things**, and the
enumeration is what distinguishes them in both cases.

### `error` → **(b)**, in ADR-0102's registry, and the write side is the right side for it

`error` is filled from `(e as Error).message` at two sites in the runner (`judge_failed: …`,
`external_scorer_failed: …`) plus the dispatch-failure string. ADR-0102 registered
`trace_spans.status_reason` for **exactly this**: *"an exception message is one of the classic
places a connection string or bearer token surfaces."* This is the same class of value in a
different table, and the precedent is not being extended, it is being applied.

**Why this column and not `output_text`, stated so the split is not mistaken for inconsistency**:
`error` says why the **instrument** fell over. It is never the agent's answer and it is never a
defeat's evidence — the red-team layer explicitly excludes transport failures from the ASR
denominator because *nothing was measured*. Redacting a credential out of it destroys nothing a
reader needs: the probe shows the sentence survives intact around the marker
(`judge_failed: judge upstream 401 using key [redacted:…] for endpoint`), which is ADR-0102's
safety case holding exactly as stated. And the at-rest protection is worth having, because a
credential in an error message is in the `pg_dump` and option (c) does not reach there.

**It cannot move a red-team classification**, asserted over the whole vocabulary rather than a
sample: `classifyDispatchFailure` is handed `detail.errorCode` first (jsonb, which the registry
cannot touch) and the codes it matches are bare enum-like tokens; a test runs `PROSE_SCRUB` over
every member of `RED_TEAM_GOVERNANCE_STOP_CODES` and `RED_TEAM_TRANSPORT_FAILURE_CODES` and pins
that each is returned unchanged and classifies identically.

### `judge_rationale` → **no change**, because ADR-0102 already decided it

It is already (b). This ADR does not move it, and says why in the Honest limits: moving it to (c)
would be a *defensible* position (a rationale quoting a defeat's output is secondary evidence of
that defeat) but it would mean **removing an at-rest control that has shipped** in exchange for
fidelity on a derived artifact. That is an owner's trade, not an agent's, and it is flagged rather
than taken.

## Where the presentation scrub is sited, and what is deliberately outside it

ADR-0112's `installConversationPresentationScrub` is generalised to
**`installPresentationScrub(scope)`** in the same file, with the conversation name kept as a
one-line alias. The mechanism was never conversation-specific, and a second copy of it is the
drift that ADR-0102's "one detector, not two" argument exists to prevent, applied to the installer
instead of the detector. **The file is still `conversation-presentation.ts` on purpose**: renaming
it would make an accepted ADR's path citation stale, and a stale citation in a decision record is
worse than an under-descriptive filename (M-036).

Three encapsulated scopes, each installing the hooks before its first route:

1. **`evals.ts`** — `GET /v1/evals/runs/:id` alone.
2. **`redteam.ts`** — one contiguous block holding the four routes that leaked
   (`runs/:id/trials`, `runs/:id`, `summary`, `findings`) plus the two that sit between them
   (`GET /v1/redteam/runs`, `POST /v1/redteam/runs/:id/evidence`). Those two carry no result text
   and are inside because splitting a contiguous block into three scopes to exclude them would buy
   nothing and cost a reader the ability to see the boundary at a glance.
3. **`mrm.ts`** — **all four `cardView` callers**: `GET /v1/mrm/cards`, `GET /v1/mrm/cards/:id`,
   `POST /v1/mrm/cards` and `PATCH /v1/mrm/cards/:id`. Covering only the two reads would have been
   a guard that watches some of a value's producers while the rest stay open (M-035); the two
   write routes echo a freshly built view back and would have carried it.

**What is outside, named rather than merely absent:**

- **`/v1/evals/datasets/*` and `/v1/redteam/libraries/*`** — the routes that read back what an
  operator **authored**. `redteam.ts`'s own canary convention tells operators they may use their
  deployment's secret as a probe's `forbidden` marker. Redacting an authoring read-back would
  break the one workflow the product documents, to protect a value the operator typed in
  themselves and can already see. These stay faithful, and that is a decision.
- **`GET /v1/evals/runs` (list) and `GET /v1/evals/summary`** — they read `eval_runs` only. No
  result row, no case text, nothing to scrub.
- **An app-wide hook.** It was considered and rejected: it would cover every route in the product
  including the authoring read-backs above, and it would make ADR-0112's careful conversation
  scoping moot rather than composable. The cost of three scopes is three decisions someone can
  read; the cost of one global hook is a scrub nobody can argue with.

## Non-vacuity — five probes, and one prediction I got wrong

Each probe was predicted in writing before it was run.

| Probe | Predicted | Actual |
|---|---|---|
| **N1** revert the registry to `["judgeRationale"]` | 2 fail: the `error` at-rest test and the inventory test | **2 failed / 11 passed** — exactly those two |
| **N2** drop `installPresentationScrub` from `evals.ts` | 1 fail: the eval route; redteam + mrm stay green | **1 failed / 12 passed** — exactly that |
| **N3** drop it from `redteam.ts` | 1 fail: the red-team routes; evals + mrm stay green | **1 failed / 12 passed** — exactly that |
| **N4** drop it from `mrm.ts` | 1 fail: the card routes; evals + redteam stay green | **1 failed / 12 passed** — exactly that |
| **N5** make `PRESENTATION_SCRUB` over-eager | 2 fail: both over-scrub guards | **3 failed / 10 passed** — the prediction was **wrong** |

**N2–N4 are the M-035 discipline made literal**: the value has three independent presenters, so
there are three probes rather than one probe at "the control". A single blunt probe would have
reddened everything at once and told me nothing about whether each producer is really guarded.

**On the prediction I got wrong.** N5's third failure is the `PRESENTATION_SCRUB === scrubAuditText`
identity assertion, which I had filed mentally as a registry test rather than as a probe target. It
is the better outcome: a forked detector is exactly what that assertion exists to catch, and the
probe proves it catches one. But the prediction was wrong and is recorded wrong, because a
non-vacuity probe whose result is only reported when it matches is not a probe.

**On the negative assertions (M-033).** Every `not.toContain(AWS_KEY)` in the new file is paired,
on the same value, with a positive one: the run id matches, the result count is five, the named
case is found by its sentinel, the marker matches `/\[redacted:aws_key:20:[0-9a-f]{12}\]/`, and the
prose that surrounded the secret (`assistant for records`, `judge_failed: … for endpoint`,
`, which is wrong.`) is still there. A null column, a missing row, an empty payload or a query that
matched nothing **fails** rather than trivially satisfying the negative. Section (3) is the
strongest form of this: it asserts the defeat still carries the secret at rest, so a scrub that
crept onto the write path would redden a test rather than quietly pass one.

**Shared-DB discipline.** Every object is `s22-` prefixed; the file authors its **own** red-team
library rather than calling `/v1/redteam/libraries/seed`, which `redteam.test.ts` asserts it is the
first caller of; no org singleton is written; every read is filtered to rows this file created; no
absolute row counts across the shared database.

## What this deliberately does NOT do

- **It does not scrub `output_text` or `detail` at write time.** See the tension section. The
  defeat evidence is the reason, and a test pins that the evidence survives.
- **It does not move `judge_rationale` from (b) to (c).** ADR-0102 owns it; flagged, not taken.
- **It does not backfill.** Rows written before today hold what they held. ADR-0099's argument
  applies unchanged: the write is the chance.
- **It does not touch the authoring routes**, for the canary reason above.
- **It does not add a migration**, and `drizzle-kit generate` was not run.
- **It does not touch `apps/web`.** The API now returns the marker, so the console shows the
  marker. Reported rather than edited, exactly as ADR-0112 did.

## Honest limits

1. **Option (c) protects the API, not the data at rest — and here that is a *feature and* a
   limit.** `eval_results.output_text`, `eval_results.detail`, `redteam_findings.output_snippet`
   and `redteam_probe_trials.output_snippet` all still hold the credential in plaintext. A
   `pg_dump`, a restored backup, a `psql` session or any module opening its own `pg.Pool` reads it.
   That is deliberate — it is what keeps the defeat provable — but it means a customer whose model
   emitted a real credential during an eval has that credential in their database until they
   delete the row, and nothing here deletes it.
2. **`judge_rationale` and `output_text` now disagree about the same turn**, by design and in the
   safe direction: the rationale carries the marker, the output carries the secret. It is the
   inverse of S5's defect and is accepted for the same reason ADR-0111 accepted its own split.
   A reviewer correlating the two must know this.
3. **The scope boundaries are a snapshot.** A route added to `evals.ts` *outside* the scope, or a
   new reader of `eval_results` in a fourth file, is uncovered and nothing tests for that. The
   scopes make the covered routes covered by construction; they cannot make an uncovered file
   notice.
4. **`cardView` coverage is by scope, not by function.** If a fifth caller of `cardView` is added
   outside the MRM card scope it will be uncovered. Sitting the scrub on `cardView` itself was
   rejected — that is the per-call-site convention ADR-0099 rejected — but the trade is real.
5. **Truncation interacts with the scrub the same way ADR-0111 recorded.** `output_text` is cut at
   4000 chars *before* storage and the presentation scrub runs after, so a marker cannot be split;
   but a secret straddling the 4000-char boundary is stored half-present and the detector, which
   is shape-based, may not match the fragment.
6. **False positives land on eval content now.** A code snippet an eval case asks a model to
   review, echoed into `output_text`, can trip `dlp.secret.assignment` on a documentation line and
   be presented redacted. The over-scrub guard pins the realistic negative case; it cannot
   enumerate all of them.
7. **The probe used the mock provider.** It is the right fixture — it puts a configured secret into
   an output deterministically and with no network — and it is narrow: no real model was asked to
   leak anything.
8. **This is application-layer**, exactly like ADR-0060/0099/0102/0112.

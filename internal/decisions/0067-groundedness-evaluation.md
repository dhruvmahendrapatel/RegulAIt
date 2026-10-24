# ADR-0067: Groundedness, faithfulness and hallucination measurement

- **Status**: Accepted
- **Date**: 2026-08-07
- **Migration**: 0079
- **Slice**: [COMPETITIVE_PARITY_PLAN.md](../product/COMPETITIVE_PARITY_PLAN.md) §1 Slice A
- **Parity targets**: Langfuse, Braintrust, Arize Phoenix, Ragas
- **Extends**: [ADR-0044](0044-agent-evaluation-harness.md) (eval harness),
  [ADR-0045](0045-model-risk-management.md) (model cards), [ADR-0064](0064-in-process-scheduler.md)
  (drift sweep)

## Context

### The finding

[ADR-0044](0044-agent-evaluation-harness.md) built a real eval harness: pinned dataset versions,
governed dispatch per case, six deterministic scorers, a model-backed judge, a stored baseline
comparison, and a regression gate the workflow engine blocks on. It answers *"did this agent get
worse?"*

It cannot answer the question a regulated buyer asks **by name**: *is this answer supported by the
material it was given?* A grep of the whole codebase before this slice found no groundedness, no
faithfulness, no hallucination and no claim-attribution metric anywhere. Every one of the four
parity targets ships that measurement, and for a bank or an insurer evaluating a RAG assistant it
is not one metric among many — it is *the* metric, because an unsupported claim in a customer
communication is a regulatory event and a stale one is merely an inconvenience.

There was also a structural reason it could not be added by configuration: **`eval_cases` had
nowhere to put the context**. Groundedness is a relation between an answer and the material it was
supposed to rest on. Without that material stored on the case, every one of these metrics is
undefined, so no amount of scorer configuration could have produced one.

### The thing that must not be lost while closing this gap

The reason this ADR is dangerous is that **a groundedness number is trivially fakeable and
extremely hard to falsify from the outside.** Any function returning a number in [0,1] looks like a
metric. A metric that returns 0.87 for everything looks like a *good* metric. And the specific way
this goes wrong in products is not fraud, it is convenience:

> A metric needs a model. No model is configured. Rather than fail, fall back to a lexical
> approximation and report the result under the same name.

That is the failure this ADR is organised around. A customer who reads "faithfulness: 0.91" on a
model card has been told a model adjudicated entailment. If a token-overlap heuristic produced it,
they have been told something false about their own risk posture, and they will not find out,
because the number is plausible and there is nothing to compare it against.

The two preceding slices were accepted specifically because they refused honestly instead of
half-shipping ([ADR-0065](0065-regulait-llm.md)'s training backends,
[ADR-0066](0066-gateway-parity.md)'s pinned credentials). This one applies the same rule to a
measurement rather than to a capability.

## Decision

**Add context to eval cases, ship four genuinely-working locally-computable groundedness metrics
under names that state their limits, and ship two judge-backed metrics that REFUSE — with a real
422, before a single row is written — when no model is reachable.**

Six new scorer kinds join the existing registry rather than forming a parallel one, so per-metric
thresholds, the baseline comparison, the ADR-0064 drift sweep and the ADR-0045 model card all work
on day one without new plumbing.

### 1. Context on a case (migration 0079)

`eval_cases` gains two columns.

`context jsonb NOT NULL DEFAULT '[]'` — **an ARRAY, one entry per retrieved chunk.** Chunk
boundaries are load-bearing and this is not a storage detail. A claim whose evidence has to be
stitched out of fragments of three different documents is precisely the fabrication a groundedness
metric exists to catch; a single concatenated blob scores that as fully supported. The scorer
matches each claim against the **single best chunk** for the same reason.

`context_in_prompt boolean NOT NULL DEFAULT true` — whether the context rides the dispatch input.
`true` measures the model against material it actually saw (the RAG case). `false` holds the
context back and uses it for scoring only, which asks whether a model's *parametric* answer happens
to be grounded in a reference corpus. Those are two different questions; one flag records which was
asked, rather than two columns that can drift apart.

**Storage posture — this is not a bypass, and that was checked rather than assumed.** Context is
authored content stored beside `input` and `expected` under the same authoring authority; it is not
a new data class. When it rides the prompt it passes through the **same §8.4 PII classifier and
ADR-0042 guardrails as any other dispatch input** — because it *is* the dispatch input. A blocked
context is a blocked dispatch and the case scores zero, exactly as ADR-0044 already handles a
blocked prompt. Claims extracted from model output are slices of `outputText` **after** the
guardrail/PII layer has already substituted the withheld marker, and they inherit ADR-0044's
truncation posture verbatim (300 chars per claim, 50 claims per result).

A case with no context, or one holding its context back, dispatches its `input` **verbatim** — so
every pre-ADR-0067 case is byte-identical and **no existing baseline moves**.

**The prompt framing is deliberately minimal.** When context rides the prompt, the chunks are
numbered and the question is restated. That is all. We do **not** inject "answer only from the
context" or "say so if the context is silent". Two reasons: it would make every score partly a
measurement of an instruction *we* wrote rather than of the agent under test, and an injected
abstention instruction would systematically trip `answer_relevance`'s non-committal detector,
silently coupling two metrics that must stay independent. An author who wants those instructions
writes them into the case `input`, where they are visible on the case row.

### 2. Four metrics that genuinely work, offline, with no provider

All four are IDF-weighted lexical overlap against the case's context, in
`packages/shared/src/groundedness.ts` — pure, no I/O, no clock, no key.

- **`claim_support`** — segment the answer into claims, score each by IDF-weighted term coverage
  of the single best-matching chunk, report the supported fraction. A claim scoring at or above
  `claimThreshold` (default 0.6, per-case configurable) counts as supported.
- **Unsupported-claim extraction** is not a separate metric; it is `claim_support`'s output. The
  failing claims are stored **verbatim** on `eval_results.detail`, with the missing terms and — the
  part a compliance reviewer actually reads — **the fabricated figures called out by name**. A
  claim carrying a numeric token absent from all context is **capped below the support threshold
  outright**, because a wrong number is the hallucination that matters most and IDF coverage alone
  under-penalises it (one number is one term among many).
- **`context_precision`** — retrieval utilisation: the fraction of supplied chunks that were the
  best support for at least one supported claim.
- **`context_recall`** — the fraction of the *reference* answer's claims the context could support.
  This measures the **retriever**, not the generator. High claim-support with low context-recall is
  the diagnostic signature of a model being faithful to context that never contained the answer —
  the failure a groundedness score alone hides.
- **`answer_relevance`** — the greater of the question's distinct-term coverage and the
  question/answer TF-IDF cosine, with an explicit non-committal detector ("I don't know", "the
  context does not say") scoring 0 **with the reason stated**, because an abstention is not an
  irrelevant answer and scoring it as one would push agents toward confident wrongness.

**They are proved adversarially, not one-sidedly.** Every score assertion in
`packages/shared/src/groundedness.test.ts` and `apps/gateway/src/groundedness-eval.test.ts` is
paired with its opposite over the **same** context, and the **gap** is asserted. Measured
end-to-end through the real harness: a grounded answer scores **1.00**, a fabricated answer of the
same length, topic and sentence structure over the same context scores **0.00**, with per-claim
scores of 1.0 versus 0.30–0.35. Context precision 1.00 tight versus 0.20 padded. Relevance 0.73
on-topic versus 0.00 off-topic. A metric returning a plausible constant cannot satisfy any of
those.

**Tokenizer reuse, checked as the brief asked.** `packages/training-provider` already had a
tokenizer and TF-IDF vector code and they were genuinely appropriate. Rather than import *upward*
into the leaf package (which would have dragged the vendor SDKs into `@regulait/shared`), the
primitives were **hoisted** into `packages/shared/src/text.ts` and training-provider now imports
and re-exports them. One tokenizer, correct dependency direction, training-provider's 58 tests
unchanged.

### 3. Two judge-backed metrics that refuse — the honesty line

`groundedness_judge` (claim-by-claim entailment, with per-claim verdicts and reasons stored) and
`answer_relevance_judge`. Both run through the one governed dispatch core, so they are
entitlement-checked, metered and audited like any other dispatch.

**The refusal is placed after the cases are known and BEFORE the `eval_runs` row is inserted.**
`judgeAvailabilityFor` (a pure function, exhaustively unit-tested) inspects the resolved scorer
kinds and returns a discriminated union — `judge_required` when no judge agent is named,
`judge_not_dispatchable` when one is named but has no model id, an unknown provider, or no
credential. The runner returns **422** with the reason and the offending metric names, writes an
audited `deny` row, and stops.

The consequence, asserted in the suite rather than described here: **no `eval_runs` row, no
`eval_results` row, and not one dispatched token.** There is nothing left behind that a later
reader could mistake for a measurement.

The union is a discriminated type rather than a boolean on purpose: *"we could not measure this"*
and *"we measured it and it scored zero"* must be impossible to confuse at the type level, because
confusing them is exactly how an unmeasured hallucination rate gets reported.

**The refusal deliberately does NOT extend to ADR-0044's `llm_as_judge`, and this asymmetry is a
decision, not an oversight.** Building it, the natural move was to make all three judged kinds
refuse. That broke ADR-0044's own test — the one named *"an `llm_as_judge` case with NO judge
configured FAILS loudly rather than passing"*, which asserts the existing behaviour: score 0,
`error: 'no_judge_configured'` on the result row.

That behaviour is **loud**. It is not a silent pass and it is not a lexical proxy wearing a judged
metric's name, which is the specific dishonesty this ADR exists to prevent. It is nonetheless the
**weaker** posture, and this ADR says so rather than implying otherwise: a zero meaning *"we could
not measure this"* is aggregated into `meanScore`, compared against a baseline, and read by a gate
as though it meant *"the agent answered badly"* — and the run is stored, so it can be cited as model
card evidence. Unifying the two would be the better end state.

It is not taken here because it would change an **accepted** ADR's contract from inside a slice
about a different metric, which is precisely the kind of unilateral scope creep this project's
history warns against. `JUDGE_REFUSING_SCORER_KINDS` names the two ADR-0067 kinds explicitly, a test
pins the boundary in **both** directions so it cannot drift by accident, and unification is named
follow-up for the owner to decide.

Every stored result carries a `method` field — `lexical-idf-overlap` or `model-judged` — and the
rolled-up summary carries `local-lexical` / `model-judged` per metric. A number can never be read
as a model's judgement when no model produced it.

### 4. Wiring

- **Per-metric thresholds** ride the existing `scorerConfig.threshold`, plus a new
  `claimThreshold`. They flow into the existing aggregate, the existing baseline comparison and
  therefore the **ADR-0064 drift sweep** with no new code: the sweep re-runs pinned baselines
  through the same `runEvalSuite`.
- **The ADR-0045 model card** now renders a groundedness block on every `eval_run` evidence row it
  cites — mean/min per metric, passed cases, the count of unsupported claims, and the `method`
  label. "Hallucination rate" is the figure a reviewer looks for on a model card, and before this it
  was measurable but not readable from the artifact the sign-off rests on.
- **`GET /v1/evals/runs/:id`** gains a `groundedness` block (null when the run scored none) and per
  result the context-chunk count and in-prompt flag. Computed on read from `eval_results` — there is
  deliberately **no stored copy**, because a second copy of a measurement is a second thing that can
  be wrong.
- **`GET /v1/evals/scorers`** renders each new kind's `limits` string where an admin chooses a
  scorer, not in an ADR they will never open.

### Alternatives considered

**Falling back to the lexical metric when no provider is configured — REJECTED, and this is the
decision the whole ADR turns on.** It is the natural implementation and it is the one thing that
would make the feature dishonest. A lexical estimate is a *different measurement*; it is available
under a different name that states its limits; and telling a regulated buyer their hallucination
rate is measured when it was estimated is worse than telling them it is unavailable.

**Scoring a claim against the UNION of all context chunks — rejected.** It is easier and it scores
better. It also scores a claim stitched together from fragments of three unrelated documents as
fully supported, which is the exact fabrication mode the metric exists to catch. Single-best-chunk
costs us the legitimately multi-hop answer; that is the safer direction to be wrong in, and there
is a test asserting the stitched claim is refused.

**A single `groundedness` metric instead of four — rejected.** A blended number cannot distinguish
"the model invented things" from "the retriever fetched the wrong documents", and those have
different owners and different fixes. Four metrics is more surface; one number would have been
unactionable.

**Storing context as one text blob — rejected.** See §1: chunk boundaries are the difference
between catching a stitched fabrication and blessing it.

**A separate `groundedness_results` table — rejected.** It would have meant a second definition of
"a scored case" and a second place for the baseline comparison to read from. Per-claim verdicts land
in the existing `eval_results.detail` jsonb alongside every other scorer's evidence.

**Deriving `DETERMINISTIC_SCORER_KINDS` by exclusion (`k !== "llm_as_judge"`) — rejected, and the
existing ADR-0044 line was reversed.** With one judged kind that filter was correct; with three it
becomes a hazard, because the *default* for a newly added kind is "deterministic, free, offline,
non-degrading". `JUDGE_BACKED_SCORER_KINDS` is now enumerated explicitly and the deterministic set
is derived from it, so the dangerous classification is the one you must opt into.

**Injecting "answer only from the context" into the framed prompt — rejected.** See §1.

**Word-embedding or cross-encoder semantic similarity — rejected for this slice.** It would narrow
the paraphrase blind spot, and it needs a model file, a runtime and a licence review, which puts it
squarely in the space [ADR-0065](0065-regulait-llm.md) already ruled on. Named as follow-up, not
half-built here.

## Consequences

### Easier

- *"What is this assistant's hallucination rate against our own corpus?"* is answerable, offline,
  with no vendor key, on an air-gapped box.
- A compliance reviewer opening a failed run reads **the sentences that were not supported**, with
  the invented figures named — not a score.
- A retrieval regression and a generation regression are now distinguishable
  (`context_recall` versus `claim_support`) instead of both surfacing as "the eval got worse".
- The ADR-0064 drift sweep and the ADR-0045 model card carry groundedness with no new scheduler,
  no new gate and no new table.

### What this explicitly does NOT give you

Stated here rather than discovered later. **The first four are properties of the lexical method and
they are the reason the judged metrics exist.**

- **The lexical metrics CANNOT detect negation flips.** "The system encrypts data at rest" and "The
  system does *not* encrypt data at rest" share nearly every content token and both score as
  supported. A parity mismatch is **flagged** on the claim (`negationMismatch`) so a human sees it,
  but it deliberately does not move the score — a correct answer is often the negation of something
  the context says, and a metric that punished that would be wrong more often than right. **There is
  a test asserting this limitation is still present**, so it cannot silently become untrue.
- **They cannot detect swapped attribution.** "Ana approved Ben's change" and "Ben approved Ana's
  change" are the same bag of tokens. Also tested as a known limitation.
- **They cannot detect compositional or causal error.** A conclusion validly worded but not entailed
  by its premises reads as supported.
- **They have FALSE POSITIVES, and that is the direction that hurts.** A correct claim restated
  entirely in synonyms scores as *unsupported*. Also tested.
- **`context_precision` is not Ragas's `context_precision`.** Ragas's is rank-aware relevance
  against a ground truth and needs a labelled judgement or a model. Ours is retrieval
  **utilisation**, measured from the answer. A chunk that was relevant but that the model ignored
  counts as unused, so a low score can mean a bad retriever *or* a lazy generator and this metric
  cannot tell you which. The name is the parity name; the `limits` string says what it actually is,
  everywhere an admin reads it.
- **`answer_relevance` is topical overlap, not correctness.** An answer that restates the question
  and then says something false scores HIGH — there is an explicit test asserting exactly that,
  paired with `claim_support` scoring the same answer low. Alone it proves only that the model did
  not change the subject.
- **Claim segmentation is not claim extraction.** A sentence carrying two independent assertions is
  scored as one claim, so a half-fabricated sentence scores in the middle rather than splitting into
  a supported half and an unsupported half. This is the most consequential simplification in the
  file and it is stated in the source next to the code that does it.
- **`llm_as_judge` does NOT refuse — it still scores an unjudgeable case zero.** ADR-0044's
  behaviour is unchanged, deliberately, and the reasoning is in §3. The consequence a reader should
  carry: for that one kind, an unmeasured case still contributes a zero to `meanScore` and to the
  baseline comparison. It is loud (the result row names `no_judge_configured`) but it is not a
  refusal, and unification is named follow-up rather than done.
- **THE JUDGE-BACKED METRICS' JUDGMENT IS UNVERIFIED IN THIS BUILD.** No model provider is connected
  in this environment — the caveat that has been load-bearing since
  [ADR-0016](0016-real-model-dispatch.md). What is proved end to end: the refusal (both flavours,
  with the absence of rows asserted), the prompt construction from the case's context, the strict
  verdict parser, the per-claim storage, the `model-judged` labelling, and the fact that the judge
  is handed the metric and the context rather than only the output. What is **not** proved is that a
  real model's entailment judgement is any good. The plumbing is verified; the instrument is not.
- **The judge's per-claim verdicts are the judge's own segmentation**, not ours. A judge that
  returns three claims where our splitter would find five is not reconciled against it; the two
  metrics are independent measurements that happen to share a report shape.
- **There is no retrieval integration.** RegulAIt does not fetch the context — an author supplies it
  on the case. This is an *evaluation* feature, not a RAG pipeline, and a customer whose retriever
  lives elsewhere exports its chunks into a dataset.
- **There is no semantic (embedding) similarity.** Everything is lexical. See "Alternatives".
- **The SPA surface is the existing eval page, not a groundedness dashboard.** The scorer table and
  both scorer dropdowns are rendered from `GET /v1/evals/scorers`, so the six new kinds and their
  `limits` strings appear automatically. The case form gained a context textarea (blank-line-separated
  chunks) and an in-prompt checkbox — without that, the new kinds would have appeared in the dropdown
  and every attempt to author one from the browser would have 422'd. What does NOT exist is any
  groundedness *reporting* view: `GET /v1/evals/runs/:id` returns the summary and the model card
  renders it, but there is no screen that trends claim-support over time or lists unsupported claims
  across runs.
- **Cross-lingual and heavily code-formatted answers are out of scope.** The tokenizer splits on
  non-alphanumerics with an English stop list; a non-English corpus will still produce a score, and
  that score will be worse-calibrated than an English one in a way this ADR does not quantify.
- **Migration 0079 reverses loudly, not silently.** Dropping the two columns is clean; reverting the
  CHECK constraints will FAIL if any row already uses a new scorer kind. That is correct — deleting
  a measurement to make a rollback succeed is worse than a loud failure.

### Follow-up

- Embedding-based semantic support, to narrow the paraphrase false-positive. Its own ADR: it needs a
  model artifact and therefore an ADR-0065-shaped decision about where that artifact comes from.
- A negation- and attribution-aware structural check (dependency parse or NLI), which would let some
  of the flagged-but-unscored signals become scored ones.
- **Unify `llm_as_judge` with the ADR-0067 refusal**, so that no judged metric can contribute an
  unmeasured zero to an aggregate. This changes an accepted ADR's contract and is the owner's call;
  see §3.
- A groundedness reporting surface in the SPA, once there is a deployment running enough of these to
  want one.
- Per-classification default thresholds via the §8.3 compliance cascade, so a HIPAA-tagged project
  gets a stricter `claimThreshold` without an admin setting it per case.

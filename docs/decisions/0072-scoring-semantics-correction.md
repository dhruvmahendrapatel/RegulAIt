# ADR-0072 — Correct two scoring inversions, and reset the baseline honestly

- **Status**: Accepted
- **Date**: 2026-08-07
- **Migration**: 0083 (`0083_scoring_semantics.sql`)
- **Amends**: [ADR-0044](0044-agent-evaluation-harness.md) (behaviour of `llm_as_judge` with no
  judge), [ADR-0057](0057-continuous-red-teaming.md) (polarity of a governance-blocked probe).
  Neither ADR is rewritten; both carry a dated amendment pointing here.
- **Closes the follow-up named by**: [ADR-0067 §4](0067-groundedness-evaluation.md) (the
  `llm_as_judge` asymmetry) and [ADR-0068](0068-redteam-depth.md) (the `eval-dispatch-blocked`
  inversion).

---

## 1. Context — two bugs of the same shape

Both are cases where the system **recorded an absence of measurement, or a success of the defence,
as a bad number**, and then let that number flow into an average, a drift comparison, a promotion
gate, and a compliance artifact.

### Inversion 1 — a missing judge scored as a bad answer (ADR-0044)

An `llm_as_judge` eval case with **no judge configured** scored **0**, with
`error: 'no_judge_configured'` on the result row. That was *loud* — it was never a silent pass, and
it was never a lexical proxy wearing a judged metric's name, which is why ADR-0067 explicitly left
it alone.

It was nonetheless wrong **in kind**. A **missing instrument** was being recorded as a **bad
measurement**. Nothing downstream could tell the two apart:

- the zero was averaged into `eval_runs.mean_score`;
- that mean was compared against a drift baseline and produced a `score_delta`;
- `evaluateEvalGate` read the result as "the agent answered badly" and could block a promotion;
- an [ADR-0045](0045-model-risk-management.md) model card could cite the run as measured evidence.

ADR-0067 had already established the correct posture for its own two judge-backed kinds: a real
**422** from `judgeAvailabilityFor`, a pure availability check placed **before** the `eval_runs`
INSERT, so a refusal leaves no run row, no result row and no dispatched tokens. It deliberately
scoped `JUDGE_REFUSING_SCORER_KINDS` to its own two kinds and pinned the boundary with a test in
both directions, saying in writing that unifying the third would be the better end state but would
amend an accepted ADR from inside a slice about a different metric.

### Inversion 2 — a guardrail BLOCK scored as a DEFEAT (ADR-0057)

A red-team probe whose dispatch was stopped by a governance decision (pillar 1, an ADR-0042
guardrail, §8.4 PII, an egress rule, a budget ceiling) produced an `eval_results` row with
`passed: false, score: 0`. Red-team polarity reads a failed case as **the attack succeeding**.

So **the platform holding looked identical to the platform failing** — in the per-probe outcome, in
the per-class aggregate, in the pooled attack-success rate, and in the gate. For a product whose
entire pitch is that it is the thing that refuses, that is the worst possible place for the meaning
to invert.

ADR-0068 found this, wrote it into a comment block in `redteam.ts`, named it on the per-trial row,
counted it in `platform_held` so the number was at least legible — and deliberately did not change
it, because changing it would move every stored baseline. **ADR-0068's own sequence path already
scored the same situation correctly** (`defeated: false, score: 1, stoppedBy: <reason>`), so the
two paths disagreed about the same input.

---

## 2. Decision

**Fix both, in one slice, with the baseline reset made explicit.**

### 2.1 `llm_as_judge` joins the refusing kinds

`JUDGE_REFUSING_SCORER_KINDS` is now all three judge-backed kinds. `judgeAvailabilityFor` therefore
returns `judge_required` / `judge_not_dispatchable` for an `llm_as_judge` case with no dispatchable
judge, and `runEvalSuite` returns a **real 422 before the `eval_runs` INSERT**: no run row, no
result row, not one dispatched token. The `score: 0` / `no_judge_configured` path is **deleted**.

`refusesWithoutJudge` and `isJudgeBackedScorer` now have identical membership. They remain separate
names because they answer different questions ("does a missing judge kill the run?" vs "does this
cost tokens?"), and a future scorer could legitimately answer them differently. The rewritten
boundary test asserts the membership in **both** directions.

The branch in the case loop that used to score zero is now an **unreachable throw**, not a
fallback. Reaching it would mean `judgeAvailabilityFor` and the judge construction had diverged,
which is a bug; the honest failure mode for an impossible state is a loud one, and *not* a zero —
a zero is exactly the thing this ADR removes.

### 2.2 A governance-blocked red-team dispatch is a PLATFORM HOLD

In the ADR-0057 eval path, a probe result whose dispatch failed is now classified:

| classification | outcome | in the ASR? |
| --- | --- | --- |
| `governance_stop` | `resisted`, score **1**, `platformHeld: true`, adjudication row kept | yes, as a **non**-defeat |
| `transport_failure` | `error` set on the trial | **no** — excluded from the denominator |

The classification comes from **one shared function**, `classifyDispatchFailure` in
`@regulait/shared`, which the ADR-0068 **sequence** path now also calls in place of its inline pair
of string comparisons. "The two paths agree on the same input" is therefore a structural property
rather than an intention. The score constant is shared too (`RED_TEAM_PLATFORM_HELD_SCORE`).

`platform_held` is still counted per probe, and the per-trial adjudication row is still written —
with its note rewritten from "this is disclosed as an inversion" to "this is a resist, and this row
says which layer held".

**What is deliberately NOT changed**: the underlying `eval_results` row still scores a blocked
dispatch 0 for an *ordinary* eval. That is correct there — in a quality suite, "this agent's own
configuration will not let it answer" **is** a bad result. Polarity belongs to the red-team layer,
and that is where it is now applied. `eval_results.detail.errorCode` was added so the red-team
layer classifies by **code** rather than by parsing an error string.

---

## 3. The baseline reset — the part that makes this safe

Both fixes change what stored numbers **mean** without changing their **shape**. Every old row
still parses, still averages, still renders, and is no longer comparable to a new one. A drift gate
that silently compares across that line would report a regression (or an improvement) that never
happened — **exactly the class of bug this slice exists to remove**.

### 3.1 A version on the row, not a fact about the deploy date

`SCORING_SEMANTICS_VERSION = 2`. Migration 0083 adds `scoring_semantics` to `eval_runs` and
`redteam_runs`:

```sql
ALTER TABLE eval_runs ADD COLUMN scoring_semantics integer DEFAULT 1 NOT NULL;
ALTER TABLE eval_runs ALTER COLUMN scoring_semantics SET DEFAULT 2;
```

Every pre-existing row is stamped **1** — what actually produced it — by the column default, and
everything written afterwards defaults to **2**. **History is MARKED, never rewritten and never
deleted.** No stored score, pass flag, aggregate, delta or gate verdict is touched.
**`audit_log` is not touched at all**, so [ADR-0060](0060-tamper-evident-audit-log.md)'s hash chain
is unaffected by construction rather than by care.

### 3.2 Comparison refuses, in four places

1. **Auto baseline resolution** filters on the semantics column. A stranded history yields *no*
   baseline rather than a wrong one, and the count of skipped runs is reported so
   "you have no history" and "your history predates the correction" are never the same sentence.
2. **An explicitly pinned `baselineRunId` that predates the change** is refused with a **422
   `baseline_semantics_mismatch` before the run row is inserted** — same posture as the judge
   refusal, and no tokens are spent arriving at a refusal we can predict.
3. **An admin-pinned (`is_baseline`) run that predates the change FAILS the gate**, naming the run
   to re-pin. It is not silently swapped for a different run: a human chose that comparison, and
   substituting another one is an answer to a question nobody asked.
4. **Pinning a v1 run as a baseline is refused outright** (`409 baseline_semantics_stale`) — that
   would create the same silent cross-semantics comparison one release later, with a signature on
   it.

`evaluateEvalGate` and `evaluateRedTeamGate` both gained `baselineComparable` +
`baselineIncomparableReason`, because a consumer reading `scoreDelta: null` alone cannot tell "first
run ever" from "not comparable". The disclosure rides on **every** verdict sentence, pass or fail.

### 3.3 The product reports it rather than leaving an operator to discover it

- **`GET /v1/evals/scoring-semantics`** (admin) returns the current version, the changelog for both
  versions, run counts per version, and — the part somebody must act on — **exactly which pinned
  baselines are stranded**, by run id, agent, dataset and version, each with the action to take.
- **The ADR-0044 drift sweep SKIPS a stranded pair** with the reason stated, rather than re-running
  it to arrive at a refusal. Drift detection for that pair is *paused and said so*, not silently
  passing.
- **`GET /v1/evals/runs/:id`** carries a `scoringSemantics` block naming the version, whether it is
  comparable to current, and what that version meant.
- **An ADR-0045 model card citing an eval run** now carries the same block on the evidence entry.
  A card is the artifact a sign-off rests on; it must not be the one place the change is invisible.

**Pinned baselines that predate this change must be re-pinned.** Say it out loud: re-run the
dataset version against the agent under the current semantics and pin *that* run. Until then, that
pair produces no delta and its gate refuses.

---

## 4. Alternatives rejected

- **Backfill/recompute old rows under the new semantics.** Rejected. We cannot recover whether a
  pre-0072 zero came from a missing judge or a real bad answer for rows where the case was later
  edited, and we would be *writing new numbers into history* — the opposite of an audit posture.
  Marking is honest; rewriting is not.
- **Delete pre-0072 runs.** Rejected outright. They are real measurements of what the system did at
  the time, referenced by model cards under a RESTRICT FK, and destroying evidence to make a
  dashboard tidy is not something a governance product gets to do.
- **A boolean `legacyScoring` flag instead of an integer version.** Rejected: the next semantics
  change would need a second boolean and the pair would be ambiguous. An integer with a changelog
  scales and can name itself.
- **Silently comparing across the boundary and noting it in the response.** Rejected — that is the
  bug. The delta is not computed at all, so there is nothing for a later reader to find and trust.
- **Changing `eval_results` polarity for blocked dispatches globally.** Rejected: it would make an
  ordinary quality suite report a misconfigured agent as fine. Polarity is a red-team concept and
  lives at the red-team layer.
- **Fixing one inversion now and one later.** Rejected by the owner and by arithmetic: each fix
  invalidates baselines, so doing them separately means two resets and two windows in which stored
  history means a third thing.

---

## 5. Consequences

- Any deployment upgrading past migration 0083 loses baseline continuity for every dataset/agent
  pair and every red-team library/agent pair. This is intentional and reported.
- A dataset containing `llm_as_judge` cases can no longer be run without a dispatchable judge. That
  is a **new hard failure** for anyone who was relying on the score-0 behaviour to "run anyway".
  Since no model provider is connected in this build, that means such datasets are unrunnable here
  — which is the honest state, and is exactly what ADR-0067's two kinds already did.
- A red-team run against an agent whose guardrails block the probes will now report a **higher**
  resist rate than the same run reported before. That is the correction, not an improvement in the
  agent, and the semantics version on the row is what stops the two being compared.

---

## 6. Disclosed rather than closed

1. **The `eval_results` row for a governance-blocked probe still stores `score: 0, passed: false`.**
   Red-team polarity is applied at the red-team layer, so the ASR, the gate and `platform_held` are
   all correct — but a reader looking at the raw eval result row for a red-team-origin case sees a
   zero. The adjudication row on `redteam_probe_trials` is the authority; the eval row is the
   dispatch record.
2. **The classification of "governance stop" is a DENY-LIST of transport codes, not an allow-list of
   governance codes.** `classifyDispatchFailure` treats anything that is not
   `model_dispatch_failed` / `agent_not_dispatchable` / `no_model_credential` as a governance stop.
   A future dispatch-core error code that is really a transport problem would be mis-read as a
   platform hold — i.e. it would fail *towards* claiming the defence worked. That is the wrong
   direction to fail, and it is named here rather than hidden. It was chosen because it is the
   posture ADR-0068's sequence path already shipped and unifying on it was the point of the slice;
   inverting to an allow-list is named follow-up.
3. **No SPA page.** The scoring-semantics report and the stranded-pin list are API-only. The evals
   admin page is unchanged and does not show the version.
4. **Nothing re-verifies a judged metric.** No model provider is connected, so the 422 path is
   proven and the judged measurement remains unverified — unchanged from ADR-0044/0067.
5. **`redteam_runs` has no admin-pinned baseline concept**, so its reset is the auto-resolution
   filter only. There is no red-team equivalent of `baseline_semantics_stale`.
6. **The version is global, not per-dataset.** A deployment cannot opt one dataset out of the
   correction, by design.
7. **`redteam_probe_trials` rows written before this change are not marked.** Only the run tables
   carry the version; a per-trial row's semantics is its run's. Reading a trial row in isolation
   does not disclose it.
8. **The migration cannot be reversed by a down-migration**; rolling back the code with the column
   in place leaves rows stamped 2 that were produced by v1 code. There is no down migration in this
   project by convention, and this is the first ADR where that convention has a sharp edge worth
   naming.

---

## 7. Verification

Full gateway suite on a freshly created database, plus every package suite:

| suite | before | after |
| --- | --- | --- |
| gateway | 1,926 tests / 111 files | **1,942 / 112** |
| `@regulait/shared` | 554 | **561** |
| policy-kernel | 129 | 129 |
| model-provider | 122 | 122 |
| infra-provider | 174 | 174 |
| training-provider | 58 | 58 |

The gateway's +16 is: **+15** from the new `scoring-semantics.test.ts` and **+1** from the ADR-0044
test being rewritten as two (the new contract, plus a companion asserting no `no_judge_configured`
row can exist anywhere). The shared package's +7 is the ADR-0067 boundary test rewritten in place
plus seven new gate-refusal cases. `pnpm -r build`, `pnpm --filter @regulait/web build` and
`pnpm -r typecheck` are clean.

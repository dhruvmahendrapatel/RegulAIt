# ADR-0068: Red-team probe-corpus depth — N-trial ASR, multi-turn sequences, and agentic vectors

- **Status**: Accepted
- **Date**: 2026-08-07
- **Migration**: 0080
- **Slice**: [COMPETITIVE_PARITY_PLAN.md](../product/COMPETITIVE_PARITY_PLAN.md) §1 Slice B
- **Parity targets**: garak, promptfoo red-team, PyRIT
- **Extends**: [ADR-0057](0057-continuous-red-teaming.md) (the red-team subsystem),
  [ADR-0044](0044-agent-evaluation-harness.md) (the eval harness it reuses),
  [ADR-0064](0064-in-process-scheduler.md) (`redteam-sweep`)

## Scope, stated before anything else

This is **defensive security testing of an operator's own deployment**. Probes run against agents
registered in the operator's own RegulAIt install, by an entitled operator, with results in that
operator's own audit trail. It is the same category of thing as a SAST suite or a WAF test corpus.
Nothing here is built for, or usable against, a third party's system: the agentic probes name
targets in the operator's own registry, and — see §4 — **they never execute anything**.

## Context

### What ADR-0057 built, and the three things it could not say

ADR-0057 is a real subsystem: versioned attack libraries frozen on publish, probes materialized
into `eval_cases` and run through `runEvalSuite` → `executeGovernedDispatch` (so entitlement,
guardrails, metering and audit are the ones that already existed), per-class aggregates, a
per-class regression gate, findings, model-card evidence, and a scheduled sweep once
[ADR-0064](0064-in-process-scheduler.md) gave it a driver.

A pre-slice audit found three gaps, and they are gaps of **depth**, not of plumbing:

1. **Every probe ran EXACTLY ONCE.** Model output is stochastic. A single-shot boolean is a sample
   of size one presented as a measurement. "The agent resisted" and "the agent resisted the one
   time we asked" are different claims, and only the second was ever true. There was no
   attack-success rate, no denominator, and therefore nothing a reviewer could weigh.
2. **Every probe was SINGLE-TURN.** Crescendo and many-shot attacks are the ones that work in
   practice against a model that refuses the same request stated bluntly, and they are structurally
   invisible to any amount of single-turn probing.
3. **No probe touched the tool surface.** The corpus was nine text prompts scored by text oracles.
   Meanwhile RegulAIt sits at a tool/connector gateway — which is exactly the thing garak cannot
   do, because garak reads model output and has no entitlement kernel to ask.

The class vocabulary was five values (`prompt_injection`, `jailbreak`, `data_exfiltration`,
`pii_leak`, `bias`), which meant indirect injection had to be filed under direct injection and
there was no way to gate on tool abuse at all.

### The thing that must not be lost while closing these gaps

The failure mode this ADR is organised around is **a number that looks like a measurement**.

> Run each probe N times, divide, print a percentage. Ship.

That produces "ASR 33%" with no denominator, no interval, and no distinction between three trials
and sixty. It is worse than the single-shot boolean it replaces, because the boolean at least
looked like what it was. And the agentic version of the same failure is worse still: a probe that
names a connector this install has never registered, reports "resisted", and is counted as
coverage.

So the rule this ADR is built around, and the one the tests attack:

> **An unrun probe is `not_run`, never `passed`. A rate is never separable from its denominator.
> One trial is labelled `single-trial` and is not reported as a measured rate.**

## Decision

**Extend the corpus and the runner along four axes — N trials with real interval statistics, a
versioned offline corpus v2 with ten attack classes, multi-turn sequences, and agentic vectors
adjudicated against our own entitlement kernel — and wire the gating presets into the existing
§8.3 compliance cascade rather than a parallel config.**

### 1. N trials and attack-success-rate statistics

`packages/shared/src/redteam-stats.ts` is pure — no I/O, no clock, no db, no provider.

- `wilsonInterval(successes, trials, z = 1.96)`. **Wilson, not Wald**, and the reason is not
  aesthetic: Wald produces a **zero-width** interval at 0/N and N/N, which are the two results
  red-team runs actually live at. A zero-width interval around "no probe succeeded" is a claim of
  certainty manufactured from a handful of samples. `n = 0` returns `[0,1]` — total ignorance,
  never a point estimate.
- `summarizeProbeAsr` collapses one probe's trials into `{status, trials, defeats, asr, interval,
  meanScore, scoreVariance, varianceObserved, outcomes}`. **Per-trial outcomes are stored, not only
  aggregated**, so a reviewer answers "was that 2 of 3 or 40 of 60, and did it flap?" from the
  record rather than from someone else's mean.
- **An errored trial is excluded from the denominator**, not scored. Counting a failed dispatch as
  "resisted" would let an outage manufacture a clean security result; counting it as "defeated"
  would manufacture a finding. Both are lies, so it gets its own column (`errored_trials`) and its
  own number. A probe where *every* trial errored is `not_run`.
- `measurementQuality(trialsPerProbe, measuredProbes)` → `not-run` | `single-trial` | `low-power`
  (2–9) | `measured` (≥10). Stamped on the run row and returned on every response.

**Cost is the first-order consequence and is treated as one.** `trials` **defaults to 1**, which is
byte-identical to the pre-0068 behaviour, because this number multiplies model spend and ADR-0064's
`redteam-sweep` repeats the whole run on every scheduled pass. It is capped at 25. Every trial's
dispatches go through the ordinary `usage_events` path attributed to the run's project, and every
response carries `trialCostNote` naming the multiplier (`N trials × P probes = N·P governed calls`)
so nobody discovers it on an invoice.

**The gate still sees ONE outcome per probe**, collapsed conservatively: a probe defeated in **any**
trial is DEFEATED. "How often" is the ASR's question; "did it ever" is the gate's, and a security
gate should answer the second one. `not_run` probes are excluded from the gate entirely and counted
separately in `redteam_runs.not_run_probes`.

### 2. Corpus v2 — versioned and offline

`RED_TEAM_ATTACK_CLASSES` grows from five to ten: `indirect_prompt_injection`, `tool_abuse`,
`excessive_agency`, `system_prompt_extraction`, `encoding_evasion`. No Postgres ENUM TYPE is
involved (the ADR-0024/0034 plain-text pattern), **but migration 0070 did put a CHECK constraint on
`attack_class` naming the five original values**, so this is a real DDL change: 0080 drops and
re-adds that constraint on `redteam_probes` and `redteam_findings` with the widened list. The CHECK
is kept rather than relaxed away — an unconstrained text column would let a typo'd attack class
silently become one no gate ever names. The widened list is a strict superset, so no stored row can
be invalidated.

`builtinRedTeamLibrary()` (v1, nine probes) is **frozen and byte-unchanged** — it is what every
ADR-0057 result was scored against. `builtinRedTeamLibraryV2()` adds encoding-evasion probes
(base64 / rot13 / letter-spacing), multi-turn sequences, and agentic probes, and re-files two v1
probes into the classes this ADR split out. Re-filing is legitimate here **precisely because it is a
new version**: a published library version may never be rewritten underneath the results it scored.

The corpus is **offline data compiled into the build** — [ADR-0041](0041-byoc-primary-motion.md)
makes air-gapped the primary motion, so there is no fetch. `POST /v1/redteam/libraries/seed`
accepts `corpusVersion` and **defaults to 1**, not to the latest: installing v2 by default would
move the baselines of every result already scored against v1. `redteam_libraries.corpus_version`
and `redteam_runs.corpus_version` stamp which shipped corpus is behind a result.

### 3. Multi-turn sequences

`redteam_probes.turns` is an ordered list of **further** user turns after `input`. The runner
dispatches each turn through `executeGovernedDispatch` using the provider's **native `messages`
array**, appending the model's real reply between turns — so a crescendo is a crescendo, not a
story we told the model about itself.

**The oracle scores the concatenated assistant transcript, not the final reply.** An escalation that
succeeded on turn three and was walked back on turn four still succeeded, and a corpus that only
read the last turn would report it as resisted.

The corpus carries a multi-turn **positive control** whose sentinel fires on turn TWO, so a green
result on it would prove the later turns never went out. `redteam_probe_trials.turns_dispatched`
records how many governed dispatches each trial actually made.

### 4. Agentic vectors — the part garak structurally cannot do

A probe may declare **tools the agent holds** and an **agentic vector** naming the tool or connector
it tries to induce. Targets are named **by NAME**, not by uuid, because an offline corpus cannot
contain ids from an install it has never seen; names resolve against the operator's own
`mcp_servers` / `connectors` rows at run time.

After the sequence completes, the induced call is handed to **the real entitlement kernel** —
`governedEvaluate` for an MCP tool, `evaluateConnector` for a connector — under the probing user's
own grants. Four outcomes, and the distinctions are the whole point:

| outcome | meaning |
|---|---|
| `modelComplied = false` | the agent refused to be induced. The strongest result; no platform verdict is claimed. |
| `platformHeld = true` | the agent WAS induced and pillar 1 refused the call anyway. **A first-class positive result** — the defence-in-depth claim, measured, and counted in `redteam_runs.platform_held`. |
| `platformHeld = false` | the agent was induced and the call would have gone through. A real finding. |
| target not registered | **NOT RUN**, with the reason stated. Never counted as resisted. |

A probe is DEFEATED only when the model complied **and** pillar 1 would have let the call through.
A corpus that scored "model induced, platform refused" as a breach would be reporting on an agent in
isolation rather than on the deployment under test.

**NOTHING IS EVER EXECUTED.** The adjudicator asks for a DECISION and records it; `executed: false`
is a literal stored field rather than a comment, because it is the property a reader of a stored row
most needs to be able to check. There is no code path in `redteam-agentic.ts` that invokes a tool or
calls a connector. A probe corpus that actually fired connectors to find out whether it could would
be a weapon rather than a test.

### 5. Gating presets from the compliance cascade

`compliance_profiles` gains `redteam_gating_classes`, `redteam_min_trials`,
`redteam_fail_on_severity` — on the **same row** as the framework's PII mode and guardrail floor, so
an admin configures one thing and there is no parallel red-team policy store. Composition uses the
cascade's existing rules: **union** for the class set, **MAX** for the trial floor, **strictest-wins**
(the *lower* severity floor, since it fails more) for the severity floor.

`applyRedTeamPreset` is **TIGHTEN-ONLY**: it never removes a gating class the caller asked for and
never lowers a trial count. What it changed is recorded verbatim in `redteam_runs.preset_tightened`
naming the framework tags responsible, so a caller who asked for one trial and got four can see who
said so.

## Consequences

### What is genuinely verified

- **The ASR discriminates, adversarially.** A probe that always falls and one that never falls
  produce ASR 1.00 and 0.00 with **non-overlapping intervals over the same N**, asserted end to end
  through the real HTTP surface. The interval **widens as N shrinks** (same point estimate, wider
  band at N=1 than N=6), asserted both in the pure suite and through the API. 2/3 and 40/60 are
  asserted to have the same point estimate and visibly different intervals.
- **Multi-turn really sends its later turns.** The turn-two positive control is DEFEATED and
  `turns_dispatched` is asserted per trial (2 for the control, 4 for the crescendo).
- **The agentic adjudication is real, proved three ways on the SAME probe**: target unregistered →
  `not_run` (and excluded from the gate's class list); target registered but ungranted → the model
  IS induced (`modelComplied: true`) and pillar 1 refuses (`platformHeld: true`, ASR 0, audit row
  `redteam-platform-held`); the tool then granted → the identical probe becomes a finding
  (`platformHeld: false`, ASR 1, audit row `redteam-platform-would-allow`). `executed: false` on
  both.
- **The preset tightens for real.** A `redteam_min_trials: 4` profile on a classified project turns
  a `trials: 1` request into four actual trial rows, and the caller's own gating class survives
  alongside the framework's.
- **The new path is not a bypass.** The sequence runner does not enter `runEvalSuite`, so it takes
  the **same `agentDecider`, imported rather than reimplemented** (`buildAgentDecider` is exported
  from `evals.ts` for exactly this reason), and an unentitled prober is asserted to get a 403 with
  no run row.

### What this explicitly does NOT give you

- **Probe GRADING is unverified, because no model provider is connected.** Every scored probe here
  was answered by the in-memory deterministic provider. What is proven is the MECHANISM — corpus,
  sequence, adjudication, statistics, gate, findings — and **not any real model's actual resistance
  to any real attack**.
- **Against a deterministic provider, N trials buy a DENOMINATOR and not VARIANCE.** Every trial
  produces an identical outcome, so measured ASR here is always exactly 0 or 1 and
  `varianceObserved` is always false. The spread the design exists to capture cannot be demonstrated
  in this environment; the interval arithmetic is proven independently in the pure suite.
- **ADR-0057 records a guardrail-BLOCKED dispatch as a DEFEAT, and this ADR does not fix it.**
  ADR-0044's runner scores a blocked dispatch as a failed case; ADR-0057 reads a failed case as a
  defeat. So a guardrail stopping an attack prompt currently reads as the attack succeeding.
  Changing the score would move every stored baseline, which is the unilateral scope creep this
  project's history warns against — so instead the per-trial row **names** it
  (`vector: "eval-dispatch-blocked"`) and `platform_held` counts it, making the number legible. The
  ADR-0068 sequence path scores the same situation correctly (platform held, agent resisting).
  **Unifying the two is named follow-up for the owner**, exactly as ADR-0067 left `llm_as_judge`.
- **An agentic probe measures STATED/EMITTED intent, adjudicated — not an executed call.** The model
  emits a real `tool_use` through the real provider interface and that call is really adjudicated,
  but nothing runs, so this proves what the entitlement layer would have decided and not what the
  tool would have done.
- **An unregistered tool on a registered server adjudicates to a default-deny**, which is a much
  weaker claim than a policy decision about a real tool. `targetRegistered: false` records which of
  the two it was, and the adjudication note says so in prose.
- **The indirect-injection carrier is STAGED corpus text, not a live connector fetch.** It measures
  the shape of the attack against the agent, not your live data path. The adjudication note states
  this on every result rather than leaving it to be inferred.
- **`excessive_agency` probes reuse the `tool_abuse` vector shape.** The distinction is in the probe
  text and its class, not in a separate adjudication mechanism — an agent that takes an unrequested
  irreversible action is caught by the gross case only, and the interesting middle (helpful
  initiative vs. overreach) is a policy judgement no pattern decides.
- **`encoding_evasion` tests the encodings in the corpus and no others.** A pass says the guardrail
  is not purely lexical; it does not say it is semantic.
- **The seed still installs corpus v1 by default.** v2 is opt-in. That is deliberate (§2) and it
  means a deployment that never asks for v2 gains nothing from this slice's corpus work.
- **A library with only sequence probes still creates an empty eval dataset** so the
  `redteam_runs.eval_run_id` NOT NULL / UNIQUE binding (ADR-0057's "a verdict is never detachable
  from its evidence") survives. Those trials run one zero-case eval run each. Harmless, and stated
  rather than hidden.
- **No SPA page.** Everything here is API-only: `POST /v1/redteam/runs` gained `trials` and returns
  `probeStats` + `measurement`, and `GET /v1/redteam/runs/:id/trials` is new. The existing red-team
  admin screen does not render any of it.
- **`llm_as_judge` cannot score a sequence probe.** A sequence score must be computable from the
  transcript with no second model in the loop; the authoring validator refuses it rather than
  degrading silently.
- **The sweep still re-probes at whatever `trials` the pair's last manual run used**, because
  `runScheduledRedTeamSweep` inherits the prior run's settings and does not carry a trials override.
  A scheduled sweep of a 25-trial run costs 25× on every pass.

## Alternatives rejected

- **A separate red-team runner for everything.** Rejected: ADR-0057's structural claim (a probe is
  an eval case, so there is no softer path than the eval harness) is the thing that makes the
  governance property hold by construction. The claim is **narrowed** instead — single-turn probes
  are still eval cases; sequence/agentic probes run through a second CASE SHAPE that shares the
  dispatch core, the scorer, the entitlement decider, the ledger and the audit log. There is still
  no second dispatch path, no second ledger and no second gate.
- **Fetching a corpus at runtime (the garak/promptfoo model).** Rejected outright: ADR-0041 makes
  air-gapped the primary motion, and a red-team suite that silently no-ops without egress is worse
  than one that ships less.
- **The Wald (normal-approximation) interval.** Rejected: zero width at 0/N and N/N, which is where
  red-team results live.
- **Bootstrap or Bayesian intervals.** Rejected as unnecessary weight; Wilson is closed-form, cheap,
  well-behaved at the boundaries, and reproducible from the stored `(k, n, z)`.
- **Defaulting `trials` to 3 or 5.** Rejected on cost. This multiplies spend on a scheduled job;
  raising it must be an explicit act or a compliance floor, not a default somebody inherits.
- **Actually executing the induced tool call to see what happens.** Rejected absolutely. That turns a
  test corpus into a weapon and would make a red-team run a way to perform actions nobody
  authorised. Adjudication answers the question that matters — *would our own governance have
  stopped it* — with no side effects.
- **Identifying agentic targets by uuid.** Rejected: an offline corpus cannot know an install's ids.
  Names resolve at run time, and an unresolvable name is an honest `not_run`.
- **A separate red-team policy table for gating presets.** Rejected: the §8.3 cascade already exists
  and already composes; a parallel store would be a second place to forget.
- **Rewriting corpus v1 in place to use the new classes.** Rejected: a published library version may
  never move underneath the results it scored.

## Follow-up

- **Unify the guardrail-block polarity** between the eval path and the sequence path (see
  "Consequences"). Owner's call — it changes an accepted ADR's contract.
- A `trials` override on the scheduled sweep, so continuous re-probing can run cheaper than the
  manual run that seeded it.
- A live-connector carrier for indirect injection, so the probe measures the operator's real data
  path rather than staged text. Needs a decision about reading real connector content into a probe.
- A red-team reporting surface in the SPA that trends ASR per class over corpus versions.
- Semantic (rather than marker) oracles, which would narrow the "complies in substance while
  avoiding the marker phrasing" under-report ADR-0057 already disclosed.

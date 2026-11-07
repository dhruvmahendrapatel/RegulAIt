# ADR-0244: Pinned offline evaluation baselines for the prompt-injection detectors

- **Status**: Accepted (implemented)
- **Date**: 2026-11-07
- **Related**: ADR-0042 (the heuristic guardrail engine), ADR-0220 (trained runtime detectors), ADR-0215 (vendored
  content refreshed by a script), ADR-0187 (vendored CyberSecEval datasets), ADR-0176 (open source first), ADR-0180
  (secure by default), PENDING.md row P25
- **Migrations**: none

## Context

The owner added P25 on 2026-11-07 ("AI security tools from the 2026 roadmap scan"): measure the two prompt-injection
detectors, the ADR-0042 heuristic `prompt_injection` detector and the ADR-0220 trained classifier, against public
benchmarks, for both recall and false-positive rate, with pinned snapshots, so that a detector or threshold change shows
its delta and CI fails on a regression. Until now the only numbers were small synthetic corpora in unit tests.

## Decision

1. **Vendored, versioned snapshots, refreshed by a script.** `scripts/refresh-injection-eval-snapshots.py` (standard
   library only) fetches each source at a pinned commit, or reads checkouts already on disk (`--from <dir>`, air-gapped),
   normalises them to `{id, label, stratum, text}` cases, and writes
   `packages/shared/src/eval-datasets/vendor/injection-baselines/` with each upstream licence file and a
   `MANIFEST.json` (commit, licence, sha256 and size per file, case counts, sampling method and seed). Nothing is
   downloaded at run time or in CI. The sha256 pins are also in `injection-baselines.ts`; a file whose bytes drift is
   refused before it is parsed. No upstream code is executed: AgentDojo's tasks are Python classes, read with `ast` and
   an evaluator that accepts only string constants, f-strings over names already resolved, string `+` and
   `"sep".join(list of strings)`, and fails the refresh on anything else.
2. **Licences checked by hand, data and code.** All four candidates are MIT.

   | Source | Data licence | Code licence | Access | Vendored |
   |---|---|---|---|---|
   | NotInject | MIT (HF card `license:mit`, ungated; the copy used is in the PIGuard repo) | MIT (`leolee99/PIGuard` LICENSE, © 2024 Hao Li) | public | yes, complete: 339 benign prompts |
   | InjecAgent | MIT (repo LICENCE covers `data/`) | MIT (`uiuc-kang-lab/InjecAgent` LICENCE, © 2023 Qiusi Zhan) | public | yes, a sample: 300 of 2,108 |
   | AgentDojo | MIT (task suites are code in the package) | MIT (`ethz-spylab/agentdojo` LICENSE, © 2024 Debenedetti et al.) | public | yes, complete for benchmark v1 |
   | HackAPrompt | MIT (`hackaprompt/hackaprompt-dataset`, card `license: mit`) | n/a (data only) | gated, auto-approval: the account must agree to share its HF username and email | **no** |

   **HackAPrompt is left out** (`huggingface.co/datasets/hackaprompt/hackaprompt-dataset`, revision
   `25b87fbedfb86840abaf8cd09af7a029208a971a`). Its licence allows redistribution and the gate page shows no
   redistribution term, but the files are served only to an account that has accepted the gate, and none was available
   to this build. Accepting it shares the owner's identity with a third party, so it is the owner's call. The manifest
   lists it under `excluded` with this reason, and a later refresh with `--from` can add it.
3. **Sampling keeps the repo small (300 kB in all).**
   - **NotInject** (76 kB): all 339 benign prompts with one, two or three trigger words. It is the false-positive
     baseline; it has no injections, so recall is not defined.
   - **InjecAgent** (140 kB): 25 cases from each of 12 strata (direct harm or data stealing, base or enhanced, by attack
     type), drawn with `random.Random(20261107).sample` over strata sorted by name. The scanned text is the tool
     response carrying the attacker instruction. It has no benign cases, so FPR is not defined (and precision is
     trivially 100% when anything is caught).
   - **AgentDojo** (85 kB): benchmark v1's 97 user-task prompts (benign) and its 27 injection goals wrapped in each
     task-independent attack (`direct`, `ignore_previous`, `system_message`, `injecagent`,
     `important_instructions_no_names`), 135 texts. A text detector sees the same string for every user task an
     injection is paired with, so the 629 user-by-injection pairs reduce to these 135. The attacks that depend on the
     user task or name a model (`tool_knowledge`, the named `important_instructions` variants) are not included.
4. **Wired into the eval harness as a gated baseline.** `injection-baselines.ts` (pure) holds the pins, the record
   schema, the confusion matrix and metrics, and the comparison. `injection-baselines.expected.json` pins the measured
   numbers per detector and dataset, plus a pooled row, and a tolerance per metric (2 percentage points each).
   `injection-baselines.test.ts` re-measures the heuristic detector on every CI run (the `@regulait/shared` job) and
   fails if precision or recall drops, or FPR rises, by more than the tolerance, or if a metric changes from defined to
   undefined. It prints the delta table. `node scripts/injection-eval-baseline.mjs` prints the same table locally
   (`--misses` lists the case ids missed or falsely flagged), and `--write` re-pins the numbers after a reviewed
   change. An improvement never fails; the next re-pin records it.
5. **The trained classifier is measured offline and recorded, not gated.** Its image is about 2 GB and is not built in
   CI (ADR-0220 §8). `agents/trained-detectors/eval_baselines.py` runs the service's own `server.load_models` and
   `detector_core.score_injection` (1,500-character windows, highest score) over the same snapshots at the default
   threshold of 0.5, and writes the `trained_prompt_injection` entry with `gated: false`. Re-run it after any change to
   the model pin, the windowing or the default threshold. The numbers below were measured on CPU from the hash-locked
   `requirements.txt` and the sha256-checked model files of `models.lock.json`.

## Measured baselines (2026-11-07)

Heuristic: `promptInjectionDetector` with the built-in and vendored rules, no custom terms; flagged means any hit.
Trained: `protectai/deberta-v3-base-prompt-injection-v2` at revision `90c9989b`, threshold 0.5.

| Dataset | Cases (inj / benign) | Heuristic precision | Heuristic recall | Heuristic FPR | Trained precision | Trained recall | Trained FPR |
|---|---|---|---|---|---|---|---|
| NotInject | 0 / 339 | n/a (no positives: 0 TP, 0 FP) | n/a | **0.0%** (0/339) | 0.0% (0 TP, 147 FP) | n/a | **43.4%** (147/339) |
| InjecAgent | 300 / 0 | 100% (trivial) | **61.3%** (184/300) | n/a | 100% (trivial) | **84.3%** (253/300) | n/a |
| AgentDojo | 135 / 97 | 100% (27/27) | **20.0%** (27/135) | **0.0%** (0/97) | 97.0% (98/101) | **72.6%** (98/135) | **3.1%** (3/97) |
| Pooled | 435 / 436 | 100% | 48.5% (211/435) | 0.0% (0/436) | 70.1% | 80.7% (351/435) | 34.4% (150/436) |

What the numbers say:
- The heuristic never fires on benign text in these sets, and it catches only literal override phrasing: on AgentDojo
  it catches exactly the `injecagent` template ("IMPORTANT!!! Ignore all previous instructions…") and none of the
  other four, and on InjecAgent it catches all 150 enhanced cases (which carry that prefix) but 34 of 150 base ones.
- The trained classifier catches far more but over-defends on trigger words: it flags 43% of NotInject's benign
  prompts. This is the over-defense the NotInject paper reports for existing guard models. An admin turning the classifier on at the
  default threshold should expect false blocks on prompts that merely mention "ignore", "bypass" and similar words.
- Pooled precision is driven by the dataset mix (NotInject is all benign, InjecAgent all injection), so the
  per-dataset rows are the ones to read.

## Consequences

- A detector rule change, a vendored-rule refresh or a threshold change now shows its effect on recall and FPR in the
  test log, and a regression beyond 2 points fails CI for the heuristic.
- The trained numbers can go stale without CI noticing; the ADR-0220 follow-up (a CI job that builds a smaller ONNX
  image) would let them be gated too.
- 300 kB of vendored data; the attack texts are benchmark material and carry no secrets or personal data (InjecAgent's
  and AgentDojo's names and addresses are synthetic).

## Open source first (ADR-0176)

Searched: promptfoo and garak (already vendored engines) run attacks against a model, not a detector over a labelled
set; AgentDojo's own harness runs an agent pipeline and needs a model; scikit-learn's metrics are Python only. The
confusion matrix and three ratios are a few lines, so they are written here (`injection-baselines.ts`). The data
itself is the open-source part, used as published.

## Not done

- HackAPrompt (owner decision on the gate, above).
- AgentDojo's task-dependent attacks, and the injection rendered inside each tool output (that needs the AgentDojo
  runtime environment and a model).
- Gating the trained classifier in CI; a per-stratum breakdown in the delta table.
- UI: none (backend, test and eval only). Any UI need is posted on #453.

## Tests

`packages/shared/src/eval-datasets/injection-baselines.test.ts` (7): every snapshot and licence file rehashes to its
pin and the manifest agrees with the code; the seed and the HackAPrompt exclusion are recorded; a drifted file is
refused before parsing; metrics are undefined without their denominator class; the regression rule fires only on a
change worse than the tolerance in the right direction; the heuristic does not regress on any dataset; the trained
entry is recorded, not gated, and covers every case.

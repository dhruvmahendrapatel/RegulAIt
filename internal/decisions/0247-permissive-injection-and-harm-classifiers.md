# ADR-0247: A permissively licensed injection and harm classifier, served as ONNX

- **Status**: Accepted (implemented; one owner decision open, below)
- **Date**: 2026-11-07
- **Related**: ADR-0220 (trained runtime detectors), ADR-0244 (injection-detector baselines, P25), ADR-0176 and
  ADR-0177 (open source first; the licence list), ADR-0180 (secure by default), ADR-0200, PENDING.md row P28
- **Migrations**: none

## Context

The owner added P28 on 2026-11-07. Meta's Llama Guard and Prompt Guard cannot be used: their weights carry Llama
community licences, which are not on the ADR-0176 list. The task was to pick a permissively licensed injection and harm
classifier (or fine-tune one if none was good enough), check each candidate's weights licence, training data, size, CPU
latency and air-gapped loading, refuse `trust_remote_code`, serve the choice through the ADR-0220 reference service as
ONNX with the weights baked in, and measure it on the ADR-0244 baselines.

ADR-0244 had just measured the ADR-0220 injection classifier (`protectai/deberta-v3-base-prompt-injection-v2`): good
recall, but it flagged 43% of NotInject's benign prompts that merely contain words like "ignore" or "bypass".

Clean room: no Llama weights or derivatives were downloaded or run, and no text was taken from the Llama model cards.
Their published numbers are cited below by reference only.

## The bar

Written down with the ADR-0244 numbers in hand, from the product need rather than from any candidate's score (the
over-defense ADR-0244 found is what an admin would hit first). At the ADR-0220 default threshold of 0.5, on the ADR-0244
snapshots, through the service's own windowing:

1. NotInject false-positive rate at most 15%.
2. AgentDojo benign false-positive rate at most 15%.
3. Injection recall, InjecAgent and AgentDojo pooled, at least 75%.
4. Median CPU time per window at most 100 ms with 2 threads.
5. Weights under MIT, Apache-2.0 or BSD; nothing from the model repository executed at build or run time; loads with
   no network.

Fine-tuning was to be done only if no candidate met all five.

## Survey

Licences and sizes from the Hugging Face API on 2026-11-07; numbers measured here (4 vCPU, PyTorch first, then the
ONNX path for the two finalists, which matched PyTorch to within 7e-6 on every case).

| Candidate | Weights licence | Size | NotInject FPR | InjecAgent recall | AgentDojo recall / FPR | p50 per window | Verdict |
|---|---|---|---|---|---|---|---|
| **leolee99/PIGuard** (formerly InjecGuard) | MIT | 737 MB | **11.5%** | 80.0% | 76.3% / 11.3% | 57 ms (ONNX, 2 threads) | **meets the bar; chosen** |
| protectai/deberta-v3-base-prompt-injection-v2 | Apache-2.0 | 737 MB | 42.8% | 84.3% | 72.6% / 3.1% | 59 ms (ONNX, 2 threads) | fails 1; kept as the build-time alternative |
| jackhhao/jailbreak-classifier | Apache-2.0 | 438 MB | 19.5% | 97.3% | 54.1% / 11.3% | 38 ms (PyTorch, 4 threads) | fails 1 |
| deepset/deberta-v3-base-injection | MIT | 737 MB | 70.5% | 100% | 100% / 81.4% | 81 ms (PyTorch, 4 threads) | fails 1, 2 |
| fmops/distilbert-prompt-injection | Apache-2.0 | 267 MB | 71.7% | 100% | 100% / 91.8% | 19 ms (PyTorch, 4 threads) | fails 1, 2 |
| meta-llama Prompt Guard 1 and 2 | Llama community licences | | not run | | | | excluded (licence) |
| qualifire/prompt-injection-sentinel | "other", gated | 1.6 GB | not run | | | | excluded (licence, access) |
| testsavantai/prompt-injection-defender-* | none stated | | not run | | | | excluded (no licence) |
| protectai/deberta-v3-small-prompt-injection-v2 | Apache-2.0, gated | 567 MB | not run | | | | excluded (gated download) |

Our ProtectAI number reproduces ADR-0244's (43.4%, 147/339) within two cases (145/339); the difference is the newer
Transformers in this run. Harm candidates are in the decision below; ADR-0244 has no harm baseline, so they were
compared on licence, labels, size and latency only.

## Decision

1. **Injection: PIGuard, by default.** `leolee99/PIGuard` at revision `dd78b24e330193a22d2293ac66922dd4f982f563`. It is
   the only candidate that meets the bar. The ADR-0220 model stays in the lock as the alternative, chosen at build time
   with `--build-arg INJECTION_MODEL=protectai`; it trades far more NotInject false positives for fewer on AgentDojo's
   benign tasks. One image carries one injection model.
2. **No `trust_remote_code`, anywhere.** PIGuard's repository ships its own modelling file. We read it and do not run
   it: it is a stock DeBERTa-v2 encoder whose first-token output feeds one linear layer (the repository's `pooler.*`
   tensors are unused by it). The build rebuilds exactly that from Transformers' `DebertaV2Model` and the safetensors,
   checks that every tensor is accounted for (and that the only unused ones are the two pooler tensors the lock lists),
   and refuses any model whose config names custom code unless its lock entry says how to rebuild it.
3. **Harm: keep `unitary/toxic-bert`** (Apache-2.0), now as ONNX. Considered: `ibm-granite/granite-guardian-hap-38m`
   and `-125m` (Apache-2.0, much smaller, but a single hate/abuse/profanity score with no categories) and
   `unitary/unbiased-toxic-roberta` (Apache-2.0, adds identity labels). Excluded: OpenRAIL-licensed classifiers
   (KoalaAI Text-Moderation, s-nlp, textdetox), Llama Guard (Llama licence), ShieldGemma (Gemma terms), and 7B-class
   guard models such as WildGuard (Apache-2.0 but not a CPU model). Measured: 44 ms median per window (ONNX, 2 threads).
4. **Our own harm labels.** The harm reasons are RegulAIt's labels, defined in
   `agents/trained-detectors/HARM_LABELS.md`: `toxicity`, `severe_toxicity`, `obscenity`, `violent_threat`,
   `harassment` and `hate`, each mapped from one toxic-bert output, plus eight reserved labels (self-harm, sexual
   content involving minors, violent and non-violent crime, weapons of mass harm, privacy exposure, defamation,
   regulated advice) for future scorers. Public hazard taxonomies, Llama Guard's among them, were read for coverage
   only; the definitions are our own words. The gateway is unchanged: reasons were already bare labels counted as
   `trained_<label>`.
5. **ONNX, built in the image and parity-gated** (this closes the ADR-0220 follow-up "an ONNX Runtime build to shrink
   the image"). A new `export` stage installs a separate hash-locked closure (`export-requirements.txt`: CPU PyTorch,
   Transformers, onnx, ONNX Runtime), and `export_onnx.py` writes `model.onnx`, `tokenizer.json` and `labels.json` per
   classifier, offline, from the sha256-verified files. The build fails unless, on fixed probes (short, truncated at
   512 tokens, non-ASCII), the runtime path produces the same token ids as Transformers and probabilities within 1e-4
   of PyTorch. Exported bytes are not reproducible across exporter versions, so parity, not a hash, is the gate; the
   build prints each graph's sha256. The runtime image has ONNX Runtime and `tokenizers` and no PyTorch or
   Transformers: the Python environment drops from about 1.4 GB to 410 MB, and the image from about 2 GB to about
   1.7 GB.
6. **No fine-tuning.** A candidate met the bar, so none was done, and no training data was gathered.
7. **Unchanged:** the ADR-0088 contract, the gateway, the defaults (mode `block`, threshold 0.5, fail closed), the
   windowing, and the "not part of the shipped product image" position of ADR-0220 §8.

## Measured (2026-11-07)

Through ADR-0244's own `agents/trained-detectors/eval_baselines.py`, from P25's branch
`builder/p25-injection-eval-baselines` at commit `cc4da9a6438dad95c97783338097a20938c7286c` (P25 had not merged), with
this branch's `server.py`, `detector_core.py` and `models.lock.json` copied over it, on the hash-locked runtime closure
(no PyTorch installed), the ONNX graphs from the export stage, threshold 0.5:

| Dataset | Cases (inj / benign) | PIGuard precision | PIGuard recall | PIGuard FPR | ProtectAI v2 recall | ProtectAI v2 FPR |
|---|---|---|---|---|---|---|
| NotInject | 0 / 339 | 0.0% (0 TP, 39 FP) | n/a | **11.5%** (39/339) | n/a | 42.8% (145/339) |
| InjecAgent | 300 / 0 | 100% (trivial) | **80.0%** (240/300) | n/a | 84.3% (253/300) | n/a |
| AgentDojo | 135 / 97 | 90.4% (103/114) | **76.3%** (103/135) | **11.3%** (11/97) | 72.6% (98/135) | 3.1% (3/97) |
| Pooled | 435 / 436 | 87.3% | 78.9% (343/435) | 11.5% (50/436) | 80.7% (351/435) | 33.9% (148/436) |

When P25 merges, re-run `eval_baselines.py --write` on main so its `trained_prompt_injection` entry records PIGuard; the
numbers above are what it will write.

What the numbers say, and what they do not:
- PIGuard cuts NotInject false positives by three quarters for four points of InjecAgent recall, and gains four points
  on AgentDojo. Its false positives on AgentDojo's benign tasks are the multi-step instructions ("Perform the following
  tasks in the order they are given…", "do the actions specified in the email…"), which read like injected instructions
  out of context. Raising the threshold to 0.7 brings that to 5.2% for 73% recall on both sets.
- **Contamination, disclosed.** 48 of NotInject's 339 prompts are in PIGuard's published validation set (used for model
  selection, not training). Without them its NotInject FPR is 11.7% (34/291), so the result stands. InjecAgent is one of
  its training sources (111 rows; none of our 300 sampled texts appears in its training set verbatim). AgentDojo does
  not appear in it.
- **HackAPrompt: not measured.** ADR-0244 left it out (the download is gated behind sharing the account's identity, an
  owner decision). PIGuard was trained on 5,000 HackAPrompt rows, so a HackAPrompt number for it would be inflated
  anyway.
- **Published comparisons, by reference only, not like for like.** The PIGuard (InjecGuard) paper, arXiv 2410.22770v3,
  Table 1, reports NotInject over-defense *accuracy* (benign prompts passed): Prompt Guard (v1) 0.88%, Llama Guard 3
  99.71% (with 28.28% accuracy on its malicious set), ProtectAI v2 56.64%, InjecGuard 87.32%. Our ProtectAI v2 (57.2%)
  and PIGuard (88.5%) agree with it. Meta's model card for Llama Prompt Guard 2 86M
  (huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M) reports an AUC of .998 and 97.5% recall at 1% FPR on Meta's
  own English jailbreak set, and an 81.2% attack prevention rate on AgentDojo at a 3% utility cost. Those are Meta's
  datasets and an agent-loop metric, not text-level recall on our snapshots, so they cannot be placed in the table
  above; we did not run the model.

## Open owner decision: PIGuard's training data

PIGuard's weights are MIT, which is what ADR-0176 governs. Its published training set (`datasets/train.json` in the MIT
code repository, commit `1b5751e88bf7475acbedfc8eda795ce060307c84`, 76,735 rows from 22 sources) includes two sources
under **CC BY-NC 4.0** (tatsu-lab Alpaca, 4,000 rows; HuggingFaceH4 no_robots, 1,500 rows), several with no stated
licence, and 435 LLM-generated rows. Whether a non-commercial licence on training data reaches the weights is an open
legal question; ProtectAI v2's card lists only permissive or unlicensed sources. Options for the owner:

- (a) accept PIGuard as built (MIT weights; the training-data note is recorded in `THIRD_PARTY.md`);
- (b) build with `INJECTION_MODEL=protectai` and accept its NotInject over-defense;
- (c) fine-tune `microsoft/deberta-v3-base` (MIT) with PIGuard's MIT training method on the permissively licensed part
  of its training set only, recording each source's licence (a GPU job of a few hours; not possible in this build's
  CPU sandbox).

Until the owner decides, nothing changes in what ships: the image was already outside the shipped product image and
the air-gapped bundle (ADR-0220 §8), pending the transitive-licence decision.

## Consequences

- An admin who turns the injection detector on at the default threshold sees roughly a quarter of the false blocks the
  ADR-0220 model caused on trigger-word prompts, and more on long multi-step instructions.
- The image no longer carries PyTorch; inference is a little faster (57 ms against 78 ms per window in PyTorch).
- The export stage needs network at build time for the second closure (PyPI and the PyTorch CPU index), as the
  closure stage already did. The running service is as offline as before.
- Changing the injection model or an export detail now means re-running the export (parity-gated) and the ADR-0244
  measurement.

## Open source first (ADR-0176)

Everything is reused: the models, ONNX Runtime (MIT), `tokenizers` (Apache-2.0), the exporter in PyTorch, and ADR-0244's
measurement script. Written here: the rebuild of PIGuard's head from stock classes (a dozen lines, because its own code
must not run), the parity check, the variant selection in `fetch_models.py`, a pure softmax/sigmoid and label mapping
in `detector_core.py`, and the label definitions. Optimum's ONNX exporter was considered; it would have to load
PIGuard through its custom code, and it adds a dependency for one `torch.onnx.export` call.

## Not done

- Gating the trained classifier in CI (still offline, ADR-0244); an int8-quantised export to shrink the image further.
- A harm baseline: ADR-0244 has none, so the harm model was not measured for recall or false positives.
- The fine-tune in option (c), if the owner chooses it.
- UI: none. The Guardrails page already names the harm detector "Harm classifier"; it does not name the model.

## Tests

`agents/trained-detectors/test_onnx_path.py` (12): softmax and sigmoid are stable at extremes; a classifier built from
a tokenizer and a model maps logits to labels, uses independent probabilities for multi-label models, and fails closed
when the output width and the labels disagree; every harm label is ours, bare, and defined in `HARM_LABELS.md`; every
lock entry is permissive, pinned by 40-character revision and sha256, has no Python file and no Llama repository, and
names a known export head; the default build selects PIGuard, the alternative swaps only the injection model, and an
unknown variant or a doubly claimed directory is refused. `test_detector_core.py` now expects our harm labels. The
export and its parity check ran in full against both lockfiles; the image itself was not built (no Docker daemon in
this sandbox, and CI does not build it, ADR-0220 §8).

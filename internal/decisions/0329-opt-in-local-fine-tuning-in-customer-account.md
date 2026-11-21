# ADR-0329: Opt-in local fine-tuning and distillation inside the customer's own account (post-pilot, record only)

- **Status**: Proposed (owner direction 2026-11-15 via lane E12 brief: record only, post-pilot; nothing is built)
- **Date**: 2026-11-21
- **Index**: **Opt-in local fine-tuning / distillation (post-pilot, Proposed): a training backend that runs inside the customer's own account (BYOC or air-gapped), never ours. Training-data consent and PII handling, erasure limits once trained, a base-model licence check, a model card and eval gate before use, the GPU footprint, and drift and retraining. Nothing built.**
- **Backlog item**: owner direction 2026-11-15 (lane E12, item 3); PENDING fragment `2026-11-21-e12-local-fine-tuning-pending.md`
- **Built in**: nothing (record only)
- **Migration**: none
- **Related**: ADR-0065 (RegulAIt-LLM: the `TrainingBackend` interface this would be one more backend of), ADR-0327 and
  ADR-0328 (the cheaper paths that come first: a rule, then a smaller model), ADR-0044 (eval harness), ADR-0045 (model
  risk management and model cards), ADR-0015 and ADR-0041 (BYOC modes and the control-plane data boundary), ADR-0224
  (privacy operations and consent limits), ADR-0042 (trace capture posture), ADR-0176 (open source first), ADR-0180
  (secure by default), ADR-0187 (sidecar engine images)

## Context

The lane brief (2026-11-15): "record only (status Proposed, post-pilot): opt-in local fine-tuning/distillation inside the
customer's account — training data consent and PII handling, deletion/erasure limits once trained, base-model licence
check against ADR-0176, model cards + eval gate (ADR-0045/0044), GPU footprint, drift/retraining; candidate OSS tooling
(e.g. PEFT/TRL, vLLM — verify licences)."

What exists today:

- **ADR-0065** already has the governed custom-model lifecycle: a `TrainingBackend` interface (`validateDataset`,
  `startJob`, `pollJob`, `cancelJob`, `fetchArtifact`) with declared capabilities. It has one honest in-process `local`
  backend, which does retrieval and classification, not weight training. Real weight training goes only to a
  credentialed remote backend, on someone else's compute.
- **ADR-0327 and ADR-0328** cut cost without training anything. A step that behaves like a rule becomes a rule. A
  repetitive ask moves to a smaller entitled model once evals pass. Those come first, because they are reversible in
  one action and need no new model.
- **The BYOC and air-gapped modes** (ADR-0015, ADR-0041) run the agent-execution plane in the customer's account, with
  a disclosed data boundary.

The gap: a customer whose traffic is still too specialised for a smaller stock model may want to train one on their own
data, in their own account, without the data or the weights leaving it.

## Proposed decision (not accepted; to be decided after the pilot)

1. **Where it runs.** A training backend under ADR-0065's interface, run as an engine image (ADR-0187 pattern) inside
   the customer's own BYOC or air-gapped account, on their GPUs. Neither our control plane nor any vendor sees the
   training data or the weights. The control plane holds only the job's metadata and the evaluation results. It is
   never offered in the hosted fast-start mode.
2. **Off by default and opt-in twice** (ADR-0180):
   - an organisation setting, behind step-up and audit;
   - a per-dataset consent recorded under ADR-0224, saying which data may train a model, for what purpose, and until
     when.
3. **Training data.** Only data the consent covers, taken from captured traces under the ADR-0042 posture or uploaded
   files.
   - PII is redacted or excluded before training, using the existing PII detection in its strictest mode.
   - Each dataset is fingerprinted, and the dataset version is linked to the resulting model.
   - Nothing withheld under capture posture may be used.
4. **Erasure limits are stated before training, not after.** Once a model is trained, a person's data cannot be removed
   from its weights. So:
   - the consent text must say so;
   - an erasure request against a training record marks every model trained on it;
   - the policy choice is either to retrain without the record or to retire the model.
   - Recommended default: retire, with retraining as the admin's choice. This needs the owner's and a privacy
     reviewer's sign-off.
   - Machine-unlearning techniques are not relied on.
5. **Base-model licence check** (ADR-0176 applied to weights):
   - The base model's licence must be on an allow-list before a job starts. Apache-2.0 or MIT weights pass.
   - Custom community licences (for example the Llama or Gemma terms) need the owner's explicit acceptance per model,
     because they are not on ADR-0176's list.
   - The licence and its version are recorded on the model card.
6. **Model card and eval gate before use** (ADR-0045, ADR-0044):
   - A trained model gets a model card (data, base model, licence, limits, measured results).
   - It must pass the ADR-0044 eval suite against the model it would replace before it can be registered as an agent.
   - It then enters routing only through ADR-0328's path: shadow, approval and one-action revert.
   - MRM sign-off applies as for any model.
7. **GPU footprint is disclosed up front.** The job plan shows the expected GPU type and count, memory, wall-clock time
   and storage, from the method chosen (parameter-efficient adapters such as LoRA or QLoRA by default, not full
   fine-tuning). The customer's own budget caps apply. The plan is a number the customer approves, not a surprise.
8. **Drift and retraining.**
   - The ADR-0328 cluster measurements and the existing drift monitors watch the trained model's agreement and quality
     in service.
   - A drop past a threshold reverts routing to the previous model (one action) and proposes a retrain. It never
     retrains automatically.
   - Each retrain is a new version with its own card and gate.
9. **Never an authorisation decision.** A trained model is just another agent under per-user entitlements. Nothing
   here decides access, and no permission decision uses a model.

## Candidate open-source tooling (ADR-0176; licences to be re-verified when this is built)

| Tool | Use | Licence (as published) | Notes |
|---|---|---|---|
| Hugging Face PEFT | LoRA and QLoRA adapters | Apache-2.0 | Parameter-efficient by default |
| Hugging Face TRL | supervised fine-tuning, distillation, preference tuning | Apache-2.0 | Builds on PEFT and Transformers |
| Hugging Face Transformers | model loading and training loop | Apache-2.0 | |
| vLLM | serving the trained model in the customer's account | Apache-2.0 | GPU serving; an OpenAI-compatible endpoint the gateway can route to |
| llama.cpp | CPU or small-GPU serving of quantised models | MIT | For small air-gapped footprints |
| Axolotl | training-recipe runner over the above | Apache-2.0 | Optional; config-driven |

All of these run air-gapped once their wheels and images are mirrored, with no runtime download. Model weights are
pulled once into the customer's registry. Each would be pinned and listed in the engine image's `THIRD_PARTY.md`.

## Consequences (if accepted)

- A new engine image and a GPU node pool in the BYOC reference stack. That is a real operational cost, which is why
  this is post-pilot.
- A new consent purpose in privacy operations, and an erasure path that can retire a model.
- No change to the hosted mode, the request path or any existing default.

## Open questions for the owner

1. Retire or retrain as the default response to an erasure request against a training record?
2. Which custom-licence base models, if any, may be offered at all?
3. Is distillation from a hosted vendor model's outputs allowed, given vendor terms that often forbid training
   competing models on their outputs? Proposed: not allowed unless the vendor's terms permit it, checked per vendor.

<!-- fold: pending -->

**E12 / ADR-0329: opt-in local fine-tuning and distillation in the customer's account (Proposed, post-pilot, record
only).** This needs an owner decision after the pilot. It would be an ADR-0065 training backend running as an engine
image inside the customer's own BYOC or air-gapped account, never hosted.

It is opt-in twice: an org setting with step-up, plus a per-dataset consent under ADR-0224.

Before training:
- PII is excluded before training.
- The erasure limits are stated up front. Proposed default: retire the model.
- The base model's licence must be on the allow-list.

Before and after release:
- A model card and the ADR-0044 eval gate come before the model is used, and it enters routing only through ADR-0328's
  shadow, approve and revert path.
- The GPU plan is disclosed and approved up front.
- Drift triggers a revert and a retrain proposal, never an automatic retrain.

Owner questions in the ADR:
- the erasure default;
- which custom-licence base models are allowed;
- whether distillation from vendor outputs is allowed.

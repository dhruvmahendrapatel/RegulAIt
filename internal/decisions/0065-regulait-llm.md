# ADR-0065: RegulAIt-LLM — custom-model creation as a governed lifecycle, not a fake training button

- **Status**: Accepted
- **Date**: 2026-08-05

## Context

The owner asked for "our own section that allows users to create their own LLM and train data",
on a separate page called **RegulAIt-LLM**, "as comprehensive as possible".

The honest constraint has to be stated first, because everything else in this ADR is a consequence
of it:

> **Real fine-tuning needs GPUs and a training runtime. This is a Node/Fastify process.**

There is no GPU here, no CUDA, no PyTorch, no training runtime, and no plausible route to one
inside the gateway. A "Train" button that spun for thirty seconds, slept, and reported success
would be trivially easy to write, would demo beautifully, and would be **the single most dishonest
thing this codebase has ever shipped** — in a product whose entire pitch is that it does not
overstate what it knows. It would sit directly against:

- [ADR-0042](0042-guardrail-engine.md)'s `tier: "heuristic"` labelling, where every detector states
  in its own registry entry what it cannot catch;
- [ADR-0044](0044-agent-evaluation-harness.md)'s "mechanism-proven, judgment-unverified" disclosure
  about the model-backed judge, which shipped wired-and-unverified and said so;
- [ADR-0045](0045-model-risk-management.md)'s "bias/fairness here is a RECORDED DECLARATION, not a
  measurement";
- [ADR-0050](0050-data-lineage.md)'s refusal to claim intra-model attribution;
- [ADR-0034](0034-custom-llm-providers.md)'s posture of refusing honestly when nothing is
  configured, rather than degrading to something that looks like it worked.

So the question is not "how do we fake training". It is: **what part of custom-model creation can
this product genuinely do, and what part can it genuinely GOVERN?** The answer turns out to be a
lot, because the governance half is where the actual gap in the market is. Nobody scans a training
corpus for personal data at ingest. Nobody freezes the corpus version a model was built from.
Nobody puts a home-trained model through the same model-risk gate as a bought one.

## Decision

**Ship the full custom-model lifecycle with a pluggable training backend, exactly mirroring the way
`packages/model-provider` abstracts inference providers — with one backend that genuinely works
end to end today, four real adapters that refuse honestly until credentialed, and a mock for
tests.**

### 1. `packages/training-provider` — the interface, the registry, the pure logic

A `TrainingBackend` interface (`validateDataset`, `startJob`, `pollJob`, `cancelJob`,
`fetchArtifact`) plus a declared `TrainingBackendCapabilities` carrying `requiresCredential`,
`inProcess`, the methods it offers, `producesQueryableArtifact`, and — the field that matters —
an honest `limits` string, rendered verbatim in the UI beside the choice. That is the
`guardrailRegistry()` / `evalScorerRegistry()` discipline, reused: a person picking a backend reads
what it cannot do at the moment they decide.

All the pure logic lives here and is unit-tested with no I/O: dataset validation, the deterministic
train/eval split, per-method hyperparameter validation, and cost estimation.

### 2. What the `local` backend REALLY does — read this paragraph before believing anything else

The `local` backend runs entirely in-process and produces a real, queryable artifact. It offers
exactly two methods, and both are named for what they actually are:

- **`retrieval_index`** — builds a genuine TF-IDF inverted index over the uploaded rows. Term
  frequencies are counted, IDF is the smoothed `ln((N+1)/(df+1)) + 1`, document vectors are
  L2-normalised, and a query is scored by cosine similarity. Ask the artifact a question and it
  returns the answer from the corpus row whose input is closest. **No weights are updated
  anywhere.** This is RAG-style customisation, and the method id says so.
- **`text_classifier`** — trains a multinomial logistic-regression classifier over a bag-of-words
  feature space by **actual full-batch gradient descent**: real epochs, a real cross-entropy loss
  that really descends (the loss curve is returned as evidence), real L2 regularisation, and a real
  held-out evaluation split whose accuracy is measured from real predictions. The learned weights
  are the artifact and can be inspected — the top-weighted terms per class are shown in the UI.

Both complete synchronously; there is no queue, no worker and no sleep. By the time the create call
returns, the index is built or the loss curve has descended. **Neither is a fine-tuned language
model, and no code path, API field, audit row, metric, or UI string says otherwise.** The local
backend's `limits` string, which the API returns and the page renders, begins: *"IT DOES NOT
FINE-TUNE A LANGUAGE MODEL, and never claims to."*

The classifier is a linear bag-of-words model: no word order, no semantics beyond term overlap, and
it will be beaten by any real language model on any task where phrasing matters. The retrieval index
answers only from rows you supplied and reports a **miss** — explicitly, rather than returning the
least-bad row — when nothing in the corpus shares a term with the query. Both are useful, small,
inspectable and honest. Neither is a custom LLM.

### 3. The four REAL adapters, and what they need before they work

`huggingface`, `together`, `bedrock` and `vertex` are implemented as one adapter driven by a
per-vendor table of the documented request shape, status path, cancel path, payload builder and
status mapping. Every HTTP call goes through an **injected** `fetchImpl`, which the gateway supplies
as the [ADR-0034](0034-custom-llm-providers.md)/[ADR-0062](0062-mode-scoped-egress.md)
egress-guarded fetch — so a training backend's base URL is adjudicated by exactly the guard that
adjudicates a BYO inference endpoint, on every use, not once at registration.

They are marked `requiresCredential: true` and **refuse with a typed
`TrainingBackendError('credential_required')` before a URL is built or a hostname resolved**. The
job lands in a TERMINAL `refused` state — deliberately distinct from `failed`, because "we never
tried, nothing was configured" and "we tried and it broke" are different facts about a model — with
an audit row and a zero-cost usage row, so a refusal is visible in the cost dashboard rather than
being an absence somebody has to notice.

**What each needs before it works, stated plainly:**

| Backend | Needs |
| --- | --- |
| `huggingface` | An HF token **and** a paid AutoTrain namespace with compute attached. |
| `together` | A Together API key and a funded account. |
| `bedrock` | A credential, an IAM role ARN, and S3 URIs for training input/output — Bedrock reads the corpus from S3, so the rows uploaded here are **not** what it trains on unless you also stage them there. **SigV4 signing is NOT implemented**; the adapter speaks bearer auth, which suits a customer-side proxy in front of Bedrock. |
| `vertex` | An OAuth access token, a GCP project id, a location and a GCS dataset URI — same caveat: Vertex reads the corpus from GCS. |

**What is unverified, stated here rather than only in code**: no remote training service is
reachable from this environment. The four adapters' URL/payload construction, auth header, status
mapping and error handling are unit-tested against recorded shapes and an injected fetch. **They
have never spoken to a live service.** Their plumbing is proven; their compatibility with the
vendors' current APIs is not. This is the same disclosure ADR-0044 made about the model-backed
judge, and it is here for the same reason.

### 4. The governance, which is the actual product

Six properties, each riding machinery that already exists rather than a parallel copy:

1. **PII and secrets are caught AT INGEST.** Every uploaded row — input *and* output, because a
   completion is training signal too — is scanned by ADR-0042's detectors and §8.4's PII
   classifiers **before the dataset exists**. Under a `block` posture the dataset is never created;
   there is no window in which it was stored "just for a moment". The requested posture is
   MAX-composed with the project's compliance floor, so a `warn` request can never walk back a
   framework's `block`. Findings are **counts only** — never matched text — on the row, in the API
   and in the audit trail. This is the governance win: by the time personal data is in a training
   corpus it is, for practical purposes, in the model.
2. **A dataset version a job trained on cannot move.** ADR-0044's discipline verbatim:
   `training_datasets` carries a `UNIQUE (id, version)` so `training_jobs.(dataset_id,
   dataset_version)` is a **real composite FK**, `ON DELETE RESTRICT`. Editing a version a job cites
   is refused; the next version is minted as a new row by copying, and the old one keeps standing
   behind every artifact that came from it.
3. **Training is not a side channel.** A job is anchored to a registry agent (`base_agent_id`) and
   runs only if the initiating user passes the ordinary `evaluateAgent` check against it — you
   cannot train a derivative of a model you may not use. `POST /v1/llm/jobs` is the only
   non-admin route in the feature, and that is its gate.
4. **Cost is attributed like any other spend.** One `usage_events` row per job, whatever the
   outcome, attributed to the job's project. In-process training bills **exactly zero** and says so:
   inventing a figure for arithmetic this box did itself would put fiction into the one ledger
   pillar 5 asks people to trust. A remote job records the estimate and labels it as one.
5. **There is no second approvals queue.** A job whose *estimated* cost reaches
   `org_settings.llmTrainingApprovalThresholdUsd` (default `$5`) does not start — it INSERTs into
   the one `approvals` table with `objectType: 'training_job'` and starts only via a post-commit
   hook off `POST /v1/approvals/:id/decide`, inheriting every separation-of-duties guard that path
   applies. A job nobody can price is **refused**, not started, because an unpriceable job is a job
   the threshold silently would not apply to.
6. **A home-trained model is governed like a bought one.** Registering an artifact for inference
   mints a registry agent with a new provider kind `regulait_llm` **and** an ADR-0045 model card
   carrying the backend's own `limits` string as the declared limitations and the *measured*
   provenance (dataset name, version, row count, content checksum, ingest-scan verdict) as the data
   claims — the one model card in this product whose data claims RegulAIt can actually stand behind,
   because it watched the corpus arrive. With `mrmEnforced` on, it is undispatchable until a human
   accepts the risk. Dispatch rides `executeGovernedDispatch` unchanged, so entitlement, the MRM
   gate, project budget, §8.4 PII, ADR-0042 guardrails and the one usage ledger all apply with no
   special case. The agent is left **unpriced** on purpose: nothing is billed for serving it, and a
   zero price would make the pillar-6 optimizer route everything onto a retrieval index because it
   looked free.

Provenance lands in ADR-0050's **one** lineage graph as
`training_dataset → training_job → model_artifact`, so "what data is behind this model?" is answered
by the same traversal that answers "what flowed into this dispatch?".

Long-running remote jobs are polled by a **scheduler job** (`training-job-poll-sweep`,
[ADR-0064](0064-in-process-scheduler.md)), not a `setInterval` — a module-level timer double-fires
the moment there are two gateway instances and is invisible when it stops.

## Consequences

**What this is.** Model **customisation and governance**: a versioned, PII-scanned corpus; a job
that consumed exactly one version of it under a named user's entitlement, with its cost in the one
ledger and an approval gate above a threshold; an artifact with measured metrics, a model card, a
lineage chain, and — for the local backend — real inference this deployment can actually serve.

**What this is not.** A claim to train frontier models. It is not even a claim to fine-tune a small
one locally: that needs GPUs this process does not have, and the only route to it is a credentialed
remote backend on somebody else's compute.

**Costs and residuals, stated rather than discovered later:**

- The `local` backend's two methods are genuinely useful for a support knowledge base, a routing
  classifier, or a triage labeller. They are not a substitute for a language model and a user who
  reads "RegulAIt-LLM" and expects one will be disappointed — which is why the honest `limits`
  string is rendered on the page, in the API, and on the auto-created model card, rather than living
  only in this document.
- The four remote adapters are **mechanism-proven, compatibility-unverified**. The first customer
  to credential one may find a vendor field has moved. The failure mode is an honest `upstream_error`
  with the vendor's own body, not a silent success.
- Bedrock and Vertex read their corpus from object storage, so for those two the rows uploaded here
  are metadata about a training set staged elsewhere. The ingest scan therefore covers what RegulAIt
  was given, which may not be byte-identical to what the vendor trained on. This is disclosed in the
  adapter's `limits`.
- An inline artifact's payload contains a normalised copy of every training row. Every list and
  detail projection returns a **summary** (document count, vocabulary size, top terms per class),
  never the payload, so "read the artifact list" cannot become "bulk-export the corpus".
- The admin bench (`POST /v1/llm/artifacts/:id/query`) deliberately does **not** go through the MRM
  gate: it is a bench test of a thing that may not be registered yet. The governed path — the one
  every non-admin has — is to register the artifact and invoke it as an agent.

**Verified in this build** (`apps/gateway/src/regulait-llm.test.ts`,
`packages/training-provider/src/index.test.ts`): the local backend trains and the artifact answers a
paraphrased question with the substantively correct row and reports a miss when it cannot; the
classifier's loss descends and it classifies correctly; a PII-bearing corpus is refused with nothing
stored and no matched text anywhere in the trail; a frozen version cannot be edited and a completed
job still resolves to the checksum it trained on; an unentitled user creates no job row; cost lands
in `usage_events`; an over-threshold job sits in the one approvals queue with no usage row and no
artifact until decided, and approving it really starts it; every credential-less remote adapter
refuses with zero fetches; a withdrawn allow-list entry blocks a previously-registered backend;
lineage traverses dataset → job → artifact; and the registered artifact is refused by the MRM gate
until enforcement is turned off.

## Alternatives considered

**A "Train" button that simulates progress.** Rejected — it is the exact overclaiming every other
ADR in this repo is written against, and it would poison the credibility of the honest disclosures
elsewhere.

**Ship only the remote adapters, with nothing that works today.** Rejected — a feature that refuses
100% of the time on a fresh install teaches people the product is broken, and an air-gapped
deployment (ADR-0041's primary motion) would never be able to use it at all. The local backend makes
custom-model creation work on a box with no network, which is a real capability rather than a
consolation prize.

**Bolt training onto `model-provider`.** Rejected — training and inference have genuinely different
lifecycles (a job is long-running, cancellable and pollable; a dispatch is not), and merging them
would have made the inference path carry a poll loop it never needs.

**A second approvals queue for expensive jobs.** Rejected for the reason ADR-0045 rejected it for
sign-offs: exactly one inbox, or the separation-of-duties guarantees have to be re-implemented and
will drift.

# ADR-0220: Trained runtime detectors behind the external-scorer contract

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The ADR-0042 guardrail detectors are heuristic: regular expressions and term lists, run in process at every
enforcement site. ADR-0088 let an operator register an external scoring endpoint for evaluations, and named the inline
guardrail path as the follow-up the owner had not yet decided (a network hop inside every dispatch is a latency,
availability and data-egress decision).

The competitor-gap backlog (#453, c6522850568; item P7 in `internal/product/PENDING.md`, started by owner decision
c6527158879) decides it: run permissively licensed models behind the existing external-scorer shim, a PII recogniser,
a prompt-injection classifier and a harm and groundedness model, each air-gapped with its weights baked into an image,
each opt-in per organisation, falling back in a fail-closed way, and logging no prompt content.

## Decision

1. **Three trained detectors, opt-in per organisation.** `pii` (a PII recogniser), `prompt_injection` (an injection
   classifier) and `harm` (a toxicity classifier). Each has one optional row in `guardrail_trained_detectors`
   (migration 0255). No row means off; nothing is backfilled (ADR-0180).
2. **Served through the ADR-0088 contract, by a registered external scorer.** The external-scorer registration gains
   three claimable kinds, `guardrail_pii`, `guardrail_prompt_injection` and `guardrail_harm`, beside the judge-backed
   evaluation kinds. A detector names one scorer; turning it on requires that the scorer exists, claims the kind and is
   enabled (so it has passed its connection test). Calls ride the same egress allow-list and DNS-pinned guarded fetch,
   with a per-detector time limit (200 ms to 10 s, default 2 s). A scorer an enabled detector uses cannot be deleted.
3. **At every enforcement site.** Agent dispatch (input, output and the cached-response re-scan), connector calls, the
   MCP proxy, the MCP protocol endpoint (tool input and output, relayed notifications) and the copilot's scan of
   evidence read back out of the audit log call `runGuardrailsAsync`,
   which runs the heuristic detectors and then the trained ones the organisation has turned on, in parallel. The
   injection classifier scans input only; PII and harm scan both phases. With none turned on there is no extra I/O.
   The tuning sandbox (`POST /v1/guardrails/sample`) and the training-corpus scan stay heuristic (follow-up); no other
   caller of the synchronous runner remains.
4. **They only add findings.** A trained verdict at or above its threshold adds counts under the heuristic detector it
   reports as (`pii`, `prompt_injection`, `toxicity`), at the stricter of its own mode and that detector's effective
   mode (org default, override, compliance floor). It never removes a heuristic finding. A trained detector at `block`
   also makes its phase buffer streaming, as a heuristic one does.
5. **Fail closed by default.** A failed call (no usable scorer, kind not claimed, text over 256,000 characters, timeout,
   HTTP error, non-conforming reply, egress refusal) records a `trained_unavailable` hit at the detector's effective
   mode, so a slow or absent service never lets through what the detector would have stopped. `onFailure: heuristic`
   records the same hit at `log` and lets the heuristic decide; it is a relaxation.
6. **Strict defaults; relaxations need step-up; writes are audited in their transaction.** A newly enabled detector
   starts at mode `block`, threshold 0.5, fail closed. Turning one off, lowering its mode, raising its threshold,
   moving to `heuristic` on failure, switching an enabled detector to a different scorer (any enabled scorer that
   claims the kind may be named, including one that always answers 0) and lowering the time limit while it fails open
   each need a `settings_relax` step-up bound to the values. The PUT re-reads the row
   under an advisory lock and refuses a concurrent change; the audit row is written in the same transaction. Routes
   are admin-only (`GET /v1/guardrails/trained-detectors`, `PUT /v1/guardrails/trained-detectors/:kind`).
7. **Counts only, nothing logged.** A reason from the scorer is kept only when it is a bare label
   (`^[a-z][a-z0-9_]{0,39}$`, such as an entity type); anything else is dropped unread. Scorer error text, which can
   echo a reply body, is never logged or audited.
8. **A reference service, not built in CI.** `agents/trained-detectors/` is a standard-library HTTP service with
   Presidio and a small spaCy English pipeline (MIT) for PII, a DeBERTa-v3 injection classifier (Apache-2.0) and a
   BERT multi-label toxicity classifier (Apache-2.0), on CPU PyTorch and Transformers; the exact models, revisions and
   hashes are in its `models.lock.json` and `THIRD_PARTY.md`. Model files are pinned by revision and sha256 and
   downloaded only at build time; the runtime sets the offline flags, loads with `local_files_only`, and pins
   tldextract (used by the PII recogniser) to its bundled Public Suffix List so nothing is fetched on first use. The image is
   about 2 GB, so CI tests the gateway wiring against a stand-in service and the service's pure core with fake models.
   Licences, the search record, and the transitive packages outside the ADR-0176 list (certifi and tqdm under MPL-2.0,
   regex with CNRI-Python, typing-extensions and CPython under PSF-2.0) are in its `THIRD_PARTY.md`, pending an owner
   decision; until then the image is not part of the shipped product image or the air-gapped bundle.
9. **UI.** A "Trained detectors" card on the Guardrails page (Policies & gates), and the guardrail kinds on the
   External scorers page. No new navigation entry.

## Consequences

- The ADR-0088 boundary ("does not attach to the inline guardrail path") is crossed by this decision, opt-in per
  organisation; ADR-0088's text stays as written.
- Turning a detector on adds one network round trip per enforced phase (bounded by its time limit) and sends the
  scanned text to the operator's own service. Fail-closed means an outage of that service refuses calls until an
  admin relaxes it.
- Single-tenant per deployment, like `guardrail_configs`: the new table has no tenant column, so no row-level security.

## Follow-ups

- Groundedness: the permissively licensed (Apache-2.0) candidate model loads custom modelling code that needs its own review, and runtime
  groundedness needs retrieval context the dispatch path does not carry. Until then groundedness stays an evaluation
  metric (the existing `groundedness_judge` kind, which any external scorer may serve).
- An ONNX Runtime build to shrink the image, and a CI job that builds it.
- The owner decision on the licences listed above.
- Trained detectors in the tuning sandbox and the training-corpus scan.
- Caching scorer resolution across dispatches (today one egress check per policy resolution when a detector is on).
- Fairness metrics are P13(a), a separate lane.

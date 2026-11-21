# ADR-0328: Route a repetitive ask to a smaller model (detect, suggest, eval-gate, shadow, approve, revert)

- **Status**: Accepted (owner direction 2026-11-15 via lane E12 brief; slice 1 built)
- **Date**: 2026-11-21
- **Index**: **Repetitive ask → smaller model (pillar 6): find clusters of near-duplicate prompts sent to one agent (SimHash plus TF-IDF cosine, computed locally, ids and fingerprints only), suggest a cheaper entitled agent from the existing right-sized routing, require the ADR-0044 eval harness to pass on a sample before any switch, then the ADR-0327 shadow/approve/revert pattern; savings through pillar 5. Off by default.**
- **Backlog item**: owner direction 2026-11-15 (lane E12, item 2); PENDING fragment `2026-11-21-e12-repetitive-asks-pending.md`
- **Built in**: lane E12, one PR per slice (slice 1: this ADR and the detector in `packages/optimizer-kernel/src/repetitive-asks.ts`)
- **Migration**: none in slice 1
- **Related**: ADR-0327 (the same lifecycle for rule-like steps, reused), ADR-0044 (eval harness), ADR-0042 (trace
  capture posture), ADR-0067 (the one tokenizer), ADR-0119 (semantic cache, exact match only), ADR-0176 (open source
  first), ADR-0180 (secure by default), ADR-0200 (3NF, security checklist), ADR-0251 (one governed decision core),
  ADR-0252 (merge-time numbering), [TOKEN_OPTIMIZATION_SPEC](../product/TOKEN_OPTIMIZATION_SPEC.md) (right-sized routing)

## Context

Owner direction (2026-11-15), from the lane brief: "detect clusters of near-duplicate prompts at the gateway
(privacy-safe: hashed/embedded locally, no raw prompt export), and suggest routing them to a smaller/cheaper model from
the existing right-sized routing, gated by the existing eval harness (ADR-0044) passing on a sample before any switch;
same shadow/approve/revert pattern; savings reported through pillar 5."

Facts read from the code on `main` (05aa6293 and later):

- **Right-sized routing** is `routeModel` in `@regulait/optimizer-kernel`. It is a pure rule chain (`routing-mode →
  baseline-entitled → cost-sensitivity → complexity-floor → cheapest-eligible`) over the candidates the caller has
  already filtered by entitlement. It only ever routes down or sideways, never past the user's ceiling, and never down
  for `quality-sensitive`. Its decision is a `cost_events` row with technique `model_routing`. It runs on the native
  invoke path, the compat path (`router_decides`) and orchestration. There is no per-cluster or per-agent routing-rule
  table: targets come from the agent registry's `tier` and prices.
- **The semantic cache** (ADR-0119) matches exactly: a SHA-512 commitment over the canonical request and the agent's
  configuration. It cannot group similar asks, and it should not, because a cache answer must be for this exact request.
- **Similarity primitives** already in the repo: the one tokenizer and TF-IDF vectors with cosine in
  `@regulait/shared` (`text.ts`, ADR-0067). There is no SimHash, MinHash, LSH or embedding library or dependency.
- **The eval harness** is `runEvalSuite` (`apps/gateway/src/evals.ts`). It runs a dataset against a candidate agent
  for a user who is entitled to it and returns an aggregate and a gate decision. Datasets can be built from captured
  trace spans (`addTracesToDataset`), which copies only the postured preview.
- **Captured prompts** are `trace_spans.input_preview` under the ADR-0042 posture, with the agent and model on the same
  row and `cost_usd` linked through usage. There is no hashed-input column.

## Decision

1. **Detection is local and keeps no text.** A background scan (slice 2) reads captured previews for one agent over a
   window, in the gateway process, and passes them to `findRepetitiveAsks`. That returns clusters as span ids, 64-bit
   fingerprints, counts and measured cost, never text. Only those are stored. Nothing is sent to a model or an outside
   service, and no raw prompt is exported (the brief's privacy rule).
2. **What counts as a repetitive ask** (slice 1, `packages/optimizer-kernel/src/repetitive-asks.ts`):
   - Tokens come from the shared tokenizer, with every numeric token masked to `#`. An ask that differs only in ids,
     quantities or dates is the same template.
   - SimHash fingerprints over unigrams and adjacent bigrams (64-bit FNV-1a per feature).
   - Candidates are found by banding (`maxHamming + 1` bands, so the pigeonhole principle guarantees that two
     fingerprints within the bound share a band). Each pair is then confirmed on **both** Hamming distance and TF-IDF
     cosine: a fingerprint alone is not enough.
   - Strict defaults: `maxHamming` 3, `minSimilarity` 0.9, `minClusterSize` 20. A topic is not a template.
   - Bounded: 5 000 asks per scan, 200 asks compared per band bucket (a larger bucket joins through its first member),
     8 000 characters read per ask. The representative (medoid) is found among the first 200 members.
3. **Suggestion** (slice 2): for a cluster, the candidate is the cheapest agent that `routeModel` would accept below the
   one that answered it, among the agents the cluster's users are entitled to. The projected monthly saving comes
   from the members' measured cost and the price difference, recorded the pillar-5 way.
4. **Eval gate before any switch** (slice 3): a sample of the cluster's spans becomes an eval dataset
   (`addTracesToDataset`, postured previews only), and `runEvalSuite` must pass for the candidate before a switch can
   be requested. The run is linked to the suggestion; a failed or stale run refuses the request.
5. **Shadow, approve, revert** (slices 3 and 4) reuse ADR-0327's shape:
   - a shadow period that measures the candidate's agreement on new asks in the cluster;
   - a switch requested with step-up and decided by a named administrator in the approvals queue, bound to the
     cluster fingerprint and the candidate (ADR-0104 digest);
   - one-action revert.
6. **Serving** (slice 4): a request whose ask falls in a switched cluster narrows `routeModel`'s candidates to the
   approved smaller agent, so every entitlement, virtual-key and ceiling filter still applies. The decision is recorded
   as a `model_routing` cost event with its own rule id. An ask outside the cluster, a passthrough user, a
   quality-sensitive request or a candidate the user may not use gets ordinary routing.
7. **Off by default** (ADR-0180): a settings singleton, as for rule-like steps, with step-up to turn it on or relax a
   threshold, and an audit row in the same transaction. Detection is read-only until enabled.
8. **Never an authorisation decision.** Routing changes which entitled model answers. It never grants access, and no
   permission decision uses the detector or a model.

## Open source (ADR-0176)

| Option | Licence | Maintained | Why not / why |
|---|---|---|---|
| `simhash-js`, `simhash` | MIT | Last release 2022 | Fails the maintenance rule |
| `minhash`, `@agtabesh/lsh` | MIT | Last release 2022 (`@agtabesh/lsh` also pulls a native murmurhash) | Fails the maintenance rule |
| `string-similarity` | ISC | Last release 2023 | Pairwise only (quadratic over 5 000 asks); outside the window |
| Python `datasketch` | MIT | Maintained | Needs a Python engine image for a 100-line function |
| Embeddings (a local embedding model) | varies | — | A model in the loop, a GPU or CPU footprint, and a second similarity notion beside the one tokenizer; revisit if lexical templates prove too narrow |
| SimHash with banding on `@regulait/shared`'s tokenizer and TF-IDF | ours | — | **Chosen**: about 100 lines, deterministic, air-gapped, reuses the one tokenizer. Re-check when a maintained JS SimHash/MinHash appears |

## Consequences

- A template that is reworded each time (a paraphrase) is not found. That is deliberate: a smaller model is
  suggested only for asks that really are the same ask, and the eval gate still has to pass.
- The shared tokenizer drops one-character tokens, so single-digit ids vanish rather than being masked. Tests use
  multi-digit ids. This makes a template with ids 1–9 and 10–99 look like two templates, which errs on the side of
  not clustering.
- Slice 1 adds no route, table or migration. The kernel package now depends on `@regulait/shared`, which is the leaf
  package, so no cycle is created.

## As built

- Slice 1 (built): `findRepetitiveAsks`, `askFingerprint` and `repetitiveAskOptionProblems` in
  `@regulait/optimizer-kernel`, with 7 tests, including that the result holds no prompt text and that the cosine
  check is required as well as the fingerprint.

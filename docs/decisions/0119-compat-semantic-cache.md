# ADR-0119 — The semantic cache on the IDE path, through ONE shared governance boundary; and the three techniques that structurally cannot follow it there

- **Status**: Accepted
- **Date**: 2026-09-20
- **Relates to**: [ADR-0020](0020-ide-interception-compat-endpoints.md) (the compat shims as a
  translation layer over one governed core), [ADR-0021](0021-org-settings-configurability-layer.md) (the pillar-6
  technique toggles, `semantic_cache_policy`, and `effectiveTechniqueMode`'s composition rule —
  an org toggle off means passthrough for everyone and no per-user setting can widen it), [ADR-0118](0118-hardened-posture-preset.md) (the posture
  read that reports `semanticCachePolicy`)
- **Migration**: **none.**

## Context

A customer-facing deck claims *"Seven techniques, applied automatically on every call"*, and sells
the IDE/compat surface on the neighbouring slide as *"existing assistants point at regulAIt … so the
work developers already do arrives inside the same controls."*

Read together, those two sentences promise that developer traffic through `POST /v1/messages` and
`POST /v1/chat/completions` gets the optimiser. **It got one technique of the seven** — model
routing. Every other technique lived inside `POST /v1/agents/:agentId/invoke`.

## What can and cannot move, and why the difference is structural

Before building anything, each remaining technique was checked against the **wire format** rather
than against convenience. Three of them cannot follow, and the reason in each case is that the
vendor-shaped request has nowhere to carry what the technique needs:

| technique | on the IDE path | why |
|---|---|---|
| **semantic caching** | **now applied** | needs only the prompt text, the user and the agent — all present |
| **model routing** | already applied | unchanged by this ADR |
| **edit vs rewrite** | **cannot** | it diffs against `body.baseline`. An Anthropic- or OpenAI-shaped request has **no baseline field**, and there is nothing to diff against |
| **file pre-processing** | **cannot** | it shrinks `body.attachments`. The compat surface carries **no attachments** |
| **context compaction** | **cannot, as built** | `prepareConversationContext` summarises the older turns of a **stored conversation**. The compat surface is stateless — the client re-sends the whole message array and there is no conversation row to compact. Summarising the supplied array in-flight is a *different* technique, and it would cost a model call and latency on a synchronous IDE request. Not smuggled in under this ADR's name |
| **lazy tool loading** | n/a | it narrows an MCP tool manifest; that is the MCP proxy's surface, not this one |
| **request batching** | n/a | an orchestration-level estimate over a READY set; there is no set here |

**So the honest ceiling for this surface is three of seven, and this ADR takes it from one to two.**
Saying that plainly is the point: the alternative was to make the slide true by redefining "applied"
to mean "considered", which is the kind of sentence this project exists not to write.

## Decision

### 1. The cache's governance boundary lives in ONE module

The thing that was about to be duplicated is not a lookup. It is a **governance boundary**: a row is
servable only to the **same user**, for the **same agent**, **within the TTL**, and only after the
stored `normalizedInput` is re-compared against the candidate as a hash-collision guard. Two copies
of that rule would drift, and **the copy that drifted would serve one user's answer to another**.

`semantic-cache-shared.ts` now owns key derivation, the scoped read, the collision guard and the
store, and **both paths call it**. The invoke path's existing tests pass unchanged, which is what
makes this a refactor rather than a rewrite — and the claim "both paths call it" is verified rather
than asserted.

What deliberately did **not** move: PII re-gating of a cached output. What a withheld output should
*do* differs between a JSON API that returns a decision object and a wire-compatible shim that must
answer in the vendor's own shape, so the caller keeps that. The **gate itself** is shared — the same
`enforceProjectCachedOutputPii`, not a second implementation — so a cached answer still cannot be
served onto a `block`-mode project.

### 2. `opt_in` cannot engage on this surface, and that is disclosed rather than worked around

On the invoke path `opt_in` means *the caller sets `semanticCache: true`*. A vendor-shaped request
has no such field, and inventing one would break the wire compatibility that is the whole purpose of
the surface. So this path honours **`always`**, and under `opt_in` behaves exactly as it did before.
ADR-0118's posture read already reports `semanticCachePolicy`, so an operator can see why nothing is
happening.

### 3. A tool-bearing turn is never cached

The answer to a request carrying tools is **not a pure function of the prompt** — the model may call
a tool whose result differs every time. Serving a previous answer there would be *wrong*, not merely
stale.

### 4. The wire contract is untouched

A streaming caller still gets a stream: the cached answer is emitted as a single delta. An IDE
cannot distinguish a hit from a very fast model. **No `usage_events` row on a hit** — nothing was
spent — and one `cost_events` row records the saving, so the Spend page picks intercepted traffic up
with no changes.

## Verification

**The load-bearing evidence is "no provider call", never "the answer matched."** Two identical
requests return the same text whether or not a cache exists, so asserting equality proves nothing.
Every hit assertion is paired with a `usage_events` delta of **zero** and every miss with a delta of
**one**, so "no new usage row" can never be the zero of a request that failed for an unrelated
reason (M-033).

The cross-user test is the one that matters most, and it is built to be non-vacuous: user A's entry
is first **proved to hit**, so user B's miss is about **scope** rather than about an empty cache.

**Non-vacuity, predicted before running**: forcing a permanent miss should redden **4 of 6** — the
hit case, normalisation, and the two whose positive controls assert a hit — leaving the tool-bearing
and `off` cases green. **Result: exactly 4 and 2.**

**Suite: 184 files / 2813 passed / 9 MinIO skips, exit 0** on a freshly created database; repo-wide
build and `tsc --noEmit` clean; instrument asserted (`ECONNREFUSED: 0`, `destroySoon: 0`).

## Honest limits

- **Two of seven techniques on this surface, not seven.** Three are structurally impossible in this
  wire format and two belong to other surfaces entirely. The deck sentence must change; the product
  cannot be made to match the old one without lying about what "applied" means.
- **Exact-match only.** "Semantic" is the technique's name, not a description of its matching: the
  key is normalized text (trim, lower-case, collapse whitespace). A re-worded question misses. An
  embedding-based near-match is a different feature with different failure modes.
- **A hit reports the model that produced the CACHED answer**, which may not be the model routing
  would choose today. That is the honest thing to report, and it means a client reading `model` off
  a cached response sees history rather than current routing.
- **Cache poisoning is bounded by scope, not prevented.** A user who stores a bad answer under their
  own key serves themselves that answer for the TTL. Cross-user service is what the boundary
  prevents, and it is what the tests pin.
- **The TTL slides on reuse** (the store refreshes `createdAt` on conflict), so a frequently-asked
  question can stay cached well beyond one TTL from its first ask.

## What the deck may now say

> **"Cost optimisation applies on every surface, including the IDE endpoints your developers already
> point at — right-sized model routing and the semantic cache, with the saving attributed to the
> project on the same Spend page. Some techniques need context a vendor-shaped request cannot carry
> (a file baseline to diff against, an attachment to shrink, a stored thread to compact); those apply
> on the native API, and we say which is which rather than averaging them into one number."**

# RegulAIt — Competitive Parity Plan

**Status:** drafted 2026-08-07. Supersedes nothing; complements
[PENDING.md](PENDING.md) (what our own ADRs left unbuilt) with the orthogonal question:
**what do the tools we benchmarked against do that we do not?**

This file exists because the competitive research done in session 07 lived only in a
conversation and was lost to context compaction once. It is written down now so the next
session does not have to re-run it.

---

## 0. The honest framing

Session 07's research falsified all three differentiators this project had been assuming.
That result stands and is not softened here:

| Claimed differentiator | Verdict |
|---|---|
| "Per-user tool-level governance at the gateway" | **Not unique.** LiteLLM, Portkey and Cloudflare AI Gateway all do per-key/per-user routing with allow-lists and budgets. |
| "Cost attribution built into the gateway rather than bolted on" | **Not unique.** Helicone, Langfuse, Portkey and LiteLLM all attribute spend per key/user/project at the call. |
| "Governed multi-stage workflow from intake to deploy" | **Not unique in kind.** This is what every SDLC platform does; the AI-specific version is emerging in several products. |

What research did **not** find already served, and what therefore remains the honest wedge:

1. **Cross-vendor per-user cost consolidation.** Every gateway attributes the spend *that
   flows through it*. Nobody consolidates one human's spend across Claude Code seats +
   Copilot seats + a raw OpenAI key + a Bedrock account into a single per-person figure an
   FP&A team can charge back. The blocker is that per-seat SaaS spend is invoice-side, not
   call-side — which is exactly why the incumbents skip it.
2. **One control plane spanning governance + cost + eval + red-team + lineage.** Each
   individual capability exists in a best-of-breed tool. The integration does not, and for a
   regulated buyer the integration is the product. This is a weak-to-medium wedge: it is a
   packaging advantage, not a technical moat, and it erodes the moment a big vendor bundles.
3. **Air-gapped/BYOC as a first-class mode**, not an enterprise-tier afterthought. ADR-0062
   made this code-enforced rather than a network assumption, which most SaaS competitors
   cannot match without re-architecting.

**Freeware changes the calculus.** With no revenue to defend, the packaging advantage in (2)
is a legitimate reason to build, and parity gaps become adoption blockers rather than
competitive risks. That is the basis on which the parity wave below is worth doing.

---

## 1. Parity slices, ordered by adoption impact

Each slice is scoped to be one ADR + one migration, dispatched **sequentially** — see §3.

### Slice A — Groundedness & hallucination evaluation — **SHIPPED 2026-08-07, [ADR-0067](../decisions/0067-groundedness-evaluation.md) (migration 0079)**
**Parity target:** Langfuse / Braintrust / Arize Phoenix / Ragas.
**We have:** ADR-0044 eval datasets, scored runs, drift baselines, LLM-as-judge scaffolding.
**Gap:** no groundedness/faithfulness metric — the specific measurement a regulated buyer
asks for by name. No claim-level attribution of an answer back to supplied context, no
citation-support check, no answer-relevance or context-precision/recall scores.
**Build:** a metric registry with real, locally-computable metrics (lexical/semantic overlap,
claim-support ratio against provided context, unsupported-claim extraction) plus judge-backed
metrics that activate only with a provider. Per-metric thresholds feeding the existing drift
sweep and the ADR-0045 model card.
**Honesty line:** metrics that need a model must say so and refuse rather than degrade
silently to a lexical proxy under the same name.
**Shipped:** `eval_cases.context` (array of chunks) + `context_in_prompt`; four locally-computable
metrics (`claim_support` with verbatim unsupported-claim extraction, `context_precision`,
`context_recall`, `answer_relevance`); two judge-backed metrics returning a real 422 before any row
is written. Read ADR-0067's "What this explicitly does NOT give you" before citing any of these —
the lexical metrics are blind to negation flips and swapped attribution, and the judges' judgment is
unverified because no provider is connected.

### Slice B — Red-team probe corpus depth
**Parity target:** garak, promptfoo red-team, PyRIT.
**We have:** ADR-0057 probe runner, scheduled sweeps, per-class results.
**Gap:** the corpus is thin; probes run once rather than over repeated trials; no multi-turn
(crescendo/many-shot) attacks; no agentic vectors (tool-abuse, indirect prompt injection via
retrieved content, exfiltration-via-connector); no attack-success-rate statistics.
**Build:** a versioned, offline probe corpus organised by attack class with N-trial runs and
ASR reporting; multi-turn probe sequences; agentic probes that specifically exercise *our*
tool/connector surface — which is a thing garak cannot do because it does not sit at a tool
gateway. Per-class gating presets driven by the compliance cascade.

### Slice C — Cross-vendor cost consolidation *(the wedge)*
**Parity target:** none — this is the gap research identified as genuinely unserved.
**We have:** ADR-0049/0051 per-call attribution for traffic through our gateway.
**Gap:** spend that never touches our gateway — per-seat SaaS (Claude Code, Copilot,
Cursor), raw vendor keys used outside RegulAIt, cloud-marketplace AI line items.
**Build:** an invoice/usage-export importer with per-vendor adapters (CSV/JSON export from
vendor consoles, cloud cost-and-usage reports), an identity-resolution layer mapping vendor
account emails → RegulAIt users, and a consolidated per-person/per-cost-centre view that
labels each figure `metered` (we saw the call) vs `imported` (we were told).
**Honesty line:** imported figures are a customer's own export, restated. Never presented as
if we metered them.

### Slice D — Gateway parity — **SHIPPED 2026-08-07, [ADR-0066](../decisions/0066-gateway-parity.md) (migration 0078)**
**Parity target:** LiteLLM, Portkey, Cloudflare AI Gateway.
**Gap:** virtual keys (issue a scoped key that proxies to a real vendor key the holder never
sees), per-key model allow-lists and budgets, semantic/exact response caching with a cache-hit
cost saving reported through the cost dashboard, automatic fallback chains and load balancing
across providers, streaming passthrough, and an OpenAI-compatible endpoint so existing SDKs
point at us with a base-URL change.
**Why it matters most for freeware:** the OpenAI-compatible endpoint is the single lowest-
friction adoption path. Without it, trying RegulAIt means rewriting integration code.

### Slice E — Shadow-AI discovery, honest version
**Parity target:** Witness AI, Harmonic, Zscaler/Netskope AI modules.
**We have:** ADR-0055 ingest of customer-supplied evidence.
**Gap:** those products discover via network/CASB position. We do not have that position and
will not claim it.
**Build:** importers for the artefacts a customer *can* hand us — proxy/firewall logs, CASB
exports, SSO app-access reports, browser-extension inventories — normalised into the existing
shadow-AI findings model with provenance on every row.
**Honesty line:** state plainly in the UI that this is evidence ingestion, not traffic
observation, and that coverage equals whatever the customer exported.

### Slice F — Observability / tracing parity
**Parity target:** Langfuse, Helicone, LangSmith.
**Gap:** no span-level trace view of a multi-agent run (ADR-0053's orchestration produces a
DAG but not an inspectable trace tree with per-span tokens, latency, cost and tool I/O), no
prompt-playground diffing against a live trace, no session/thread grouping.
**Build:** a trace model over the existing run records, a trace-tree UI, and OpenTelemetry
GenAI-semantic-convention export so traces can leave for a customer's own stack.

---

## 2. What we should *not* try to match

Recorded so a future session does not spend a wave on these.

- **Training/serving infrastructure.** Fine-tuning needs GPUs and a training runtime; that
  cannot happen inside a Node gateway. ADR-0065 handles this with a backend-adapter interface
  and a genuinely-working local backend, not a fake Train button.
- **Network-position shadow-AI discovery.** Requires being the proxy. See Slice E.
- **IDE surface parity with Cursor.** A different product category; ADR-0053's SDK and
  IDE_INTEGRATION.md are the right scope.
- **Being a model vendor.** Provider-agnostic is a standing principle (CLAUDE.md).

---

## 3. Dispatch discipline — read before starting a slice

Session 06 lost 1,127 lines of a shipped ADR to two parallel agents committing on the same
base. The cause is structural, not incidental: every slice touches `packages/db/src/schema.ts`
and `packages/db/migrations/meta/_journal.json`, and git's index is not partitionable.

**Therefore: one slice at a time, sequentially.** Each slice gets its own migration number,
its own ADR, and a full suite run before the next is dispatched. Parallelism is only safe for
research that writes no code.

Journal entries must be appended in **`when`-ascending order** or Drizzle silently skips them.

---

## 4. Baseline to not regress

At the time of writing: **1,723 tests / 104 files**, migration 0076 (0077 in flight for
ADR-0065). Every ADR 0001–0064 Accepted.

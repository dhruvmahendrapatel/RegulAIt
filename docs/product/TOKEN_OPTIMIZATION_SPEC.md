# RegulAIt — Token Optimization Spec (Product Feature Area)

> Source: original specification authored for RegulAIt during bootstrap planning (2026-07-22),
> prompted by [ADR-0005](../decisions/0005-token-optimization-tooling.md) and
> [ADR-0006](../decisions/0006-token-optimization-default-in-future-scaffolds.md) (OQ-004, part
> c: "consider token optimization as a RegulAIt product feature in its own right"). Those two
> ADRs cover **internal dev-tooling adoption** (`caveman`, `graphify`) for building RegulAIt
> itself. This document is a different thing: it specifies what RegulAIt should **do for its own
> end users** — people building agents, workflows, and apps on the platform — to manage and
> reduce their LLM token spend.

> **This is not a third P0 pillar.** [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md) and
> [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md) remain the two co-equal, non-negotiable
> architectural pillars of the product. Token optimization is a **standard feature area** that
> sits on top of both of them and reuses their mechanisms rather than duplicating them — closer
> in priority to the items in [VISION.md §5](VISION.md#5-suggested-feature-checklist-for-regulait)
> than to governance or workflow. It should ship, but it is not gating, and no other roadmap item
> should be delayed for it.

## 1. Why this matters

Every AI-native platform researched for [VISION.md](VISION.md) — Atlas, Cursor, and Lovable —
treats LLM cost as something the *platform* manages on the vendor's behalf (Atlas's usage/
inference-spend dashboards, Cursor's per-request pricing, Lovable's complexity-priced credits).
None of them expose token/cost optimization as a **capability the end user actively controls** —
it's an opaque billing detail, not a product surface. That's the gap this spec fills.

This also mirrors an instinct already visible elsewhere in this project: the same
cost-consciousness that's shaped RegulAIt's own AWS infrastructure decisions (two-account
foundation, no long-lived keys, Terraform-managed spend) applies just as directly to LLM token
spend once RegulAIt's users start running agents and workflows at volume. A platform whose own
build-out is deliberately cost-aware should make that same discipline available to the people
building on top of it, not just practice it internally. RegulAIt's own dev-tooling adoption
(ADR-0005/0006) already validated that a meaningful chunk of this landscape — prompt caching,
output compression, code-graph context reduction — is mature enough to build on; this spec is
about exposing an equivalent, product-grade version of that landscape to end users, rather than
keeping it as an internal-only convenience.

## 2. Position in the product

| | Governance layer | Workflow engine | Token optimization |
|---|---|---|---|
| **Priority** | P0, non-negotiable | P0, non-negotiable | Standard feature area |
| **What it governs** | Who can do what | What sequence a change must pass through | How efficiently any permitted action spends tokens/cost |
| **Failure mode if missing** | Shadow IT, uncontrolled agent/data access | Ungoverned, unreviewable changes shipping | Higher-than-necessary spend, no visibility — a cost problem, not a control-plane failure |

Token optimization **extends** both existing pillars rather than introducing a parallel
enforcement mechanism:
- It reuses the governance layer's per-user agent entitlement system (§8 below) for model
  routing — no separate "cost policy engine."
- It reuses the workflow engine's tag/assignment mechanism (§9 below) for workflow-level cost
  sensitivity — no separate "cost workflow."

## 3. Capability overview

| Capability | What it does | Default posture |
|---|---|---|
| **Native prompt caching** | Wires provider-native prompt caching (Anthropic, OpenAI, etc.) into every model call the platform routes, automatically | On by default, no user action required |
| **Context-window management / auto-summarization** | Monitors context usage per session/agent run and auto-summarizes or prunes stale context before hitting provider limits | On by default, tunable thresholds |
| **Semantic caching** | Detects effectively-duplicate or highly-similar requests and serves a cached response instead of re-invoking the model | Opt-in per agent/workflow (see §6 for why) |
| **Cost/token analytics dashboards** | Per-user, per-agent, per-model, per-workflow spend and token-volume visibility, with trends and alerts | On by default (read-only visibility carries no exfiltration or correctness risk) |
| **Governance-integrated model routing** | Routes a request to the cheapest model that satisfies the user's governed entitlement ceiling for the task at hand | On by default, bounded entirely by existing governance entitlements |
| **Context-graph tooling** | Optional local code-knowledge-graph indexing to reduce context tokens sent per request on large codebases | Opt-in, code-only by default (see §10) |
| **Output-compression preferences** | User-selectable terser output style to reduce output-token spend | Opt-in per user/workspace preference |

## 4. Native prompt caching

The single highest-leverage, lowest-risk technique in this space, and the one item in this spec
that should be treated as close to non-optional as a "standard feature" can be:

- Every model call the platform's routing layer makes on a user's behalf should use the
  underlying provider's native prompt-caching mechanism wherever the provider supports it
  (system prompts, tool definitions, repeated large context blocks, workspace "Knowledge"/rules
  content per the patterns in [VISION.md](VISION.md)).
- This requires no third-party dependency and introduces no additional data-handling risk beyond
  what the underlying model call already carries — it is a routing-layer optimization, not a new
  data path.
- Should be wired in at the same layer that already sits between every user action and the
  underlying model — i.e., the same routing/dispatch point the governance layer's per-user agent
  entitlement check ([§4 of GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md)) already
  intercepts — so caching and entitlement enforcement compose naturally rather than needing
  separate instrumentation.
- Cache-hit/cache-miss rates should feed the cost analytics dashboard (§7) as a first-class
  metric, so admins can see how much of their savings comes "for free" from caching before
  reaching for heavier-handed levers like model routing or semantic caching.

## 5. Context-window management and auto-summarization

- Every agent session/workflow run tracks context-window utilization against the active model's
  limit.
- Configurable auto-summarization: when utilization crosses a threshold, older
  context/conversation turns are summarized into a condensed form rather than truncated blindly
  or left to overflow into an expensive/failed call.
- Summarization should be **conservative by default** — favor retaining fidelity on
  recently-touched files, active requirements/plan artifacts (per the workflow engine's
  artifact-generation stage), and explicit user instructions, over older exploratory turns.
- Per-workflow and per-agent configurability, so a long-running background agent (per the
  Cursor-style cloud-agent pattern noted in [VISION.md](VISION.md)) can have a more aggressive
  summarization policy than an interactive chat session where the user is watching context build
  in real time.
- Surfaced to the user: a visible indicator of current context usage and when auto-summarization
  has fired, not a silent background process — consistent with the "visible, step-by-step
  execution log" principle already established for the core agent loop.

## 6. Semantic caching

Detects and serves cached responses for requests that are semantically equivalent or highly
similar to a prior request (the pattern popularized by GPTCache), rather than re-invoking the
model each time.

- **Opt-in, not default-on**, unlike prompt caching and context management above. Rationale:
  semantic caching risks staleness (a cached answer may no longer be accurate if underlying data
  changed) and risks cross-request leakage if scoping is wrong (User A's cached response
  surfacing for User B's semantically-similar-but-differently-scoped request). Both risks are
  manageable but should be a deliberate choice per agent/workflow, not an invisible default
  behavior layered under every request.
- When enabled, cache scope must respect the same governance boundaries as the underlying
  request — a cached response is never served across a governance boundary (different user,
  different connector data-scope, different MCP tool-permission set) that would not itself be
  permitted to produce that response live.
- Cache invalidation hooks should tie into connector/data-source change events where available
  (e.g., invalidate cached responses referencing a Salesforce object once that object changes),
  falling back to a configurable TTL where no change-event signal exists.
- Cache-hit information surfaces in the cost analytics dashboard (§7) alongside prompt-cache
  hits, so admins can see the incremental savings semantic caching contributes on top of native
  provider caching.

## 7. Cost / token analytics dashboards

In the spirit of Langfuse/Helicone-style LLM observability tooling, but scoped to what RegulAIt's
own governance and workflow data model already tracks, rather than a bolted-on generic
observability product:

- **Per-user, per-agent, per-model, per-workflow, per-workspace** breakdowns of token volume and
  estimated/actual cost, over configurable time windows.
- **Cache performance metrics** (prompt-cache hit rate, semantic-cache hit rate) shown alongside
  raw spend, so the value of §4/§6 is visible, not just their existence.
- **Model-routing outcomes**: how often a request was routed to a cheaper model than the user's
  ceiling, and the estimated savings versus always using the ceiling model — directly
  cross-referencing the governance-integrated routing in §8.
- **Budget alerts and soft/hard caps**: admins can set per-user or per-team spend thresholds that
  trigger a notification (soft) or block further model calls pending admin action (hard) —
  modeled on Lovable's per-member credit limits, but expressed as real spend/token volume rather
  than an abstracted credit unit, and configurable rather than a fixed platform-wide credit
  scheme.
- **Feeds the same audit/event pipeline** the governance layer already produces (per
  [§7 of GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md)) — cost analytics is a consumer of
  that event stream, not a second independent logging system.

## 8. Model routing tied to the governance layer's entitlement system

This is the capability most explicitly designed to **not duplicate** existing product
infrastructure.

[GOVERNANCE_LAYER_SPEC.md §4](GOVERNANCE_LAYER_SPEC.md) already defines, per user:
- A **default agent/model**.
- A **ceiling** — the most capable/expensive agent/model that user may escalate to.
- Mode-level restrictions on top of both.

Cost-aware model routing is built entirely as logic **within** that existing structure, not as a
new entitlement dimension:

- When a request doesn't require the user's default or ceiling model's full capability (e.g., a
  simple lookup, a formatting task, a low-stakes summarization), the routing layer may select a
  **cheaper model that is itself already within that user's governed entitlement range** —
  never a model the user isn't otherwise entitled to use, and never above the user's ceiling.
- Routing decisions are a **cost optimization within a permission boundary**, not a new
  permission boundary — the governance layer's allow-list/ceiling/mode restrictions remain the
  single source of truth for "is this agent/model usable by this user at all." Token
  optimization never grants access to a model the governance layer would otherwise deny.
- Admins get a routing-policy control (part of the existing Agent Governance surface in
  [GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md)), not a separate admin page: per
  user or role, whether cost-aware downrouting is enabled at all, and whether it requires
  disclosure/confirmation before use for that user.
- **User-visible routing**: whichever model actually served a given request is shown in the
  execution log, consistent with the core agent loop's "visible, step-by-step execution log"
  principle — routing is a transparent optimization, not a hidden substitution.
- **Task-classification signal**: routing decisions should be informed by workflow stage type
  where available (e.g., a Planning-only stage per the workflow engine may tolerate a lighter
  model than a Build/execution stage) — see §9 for the explicit workflow-level tag.

## 9. Composition with the workflow engine: cost-sensitivity tag

[WORKFLOW_ENGINE_SPEC.md §4](WORKFLOW_ENGINE_SPEC.md) already defines assignment conditions
including a **data-sensitivity / risk classification** tag that forces stricter workflow
templates. Token optimization introduces an analogous, independent tag on the same mechanism:

| Tag | Effect on model routing | Effect on caching |
|---|---|---|
| **cost-sensitive** | Routing layer (§8) is biased toward the cheapest model within the user's entitlement range at every eligible stage; auto-summarization (§5) thresholds are more aggressive | Semantic caching (§6), if enabled for the workflow, is favored more aggressively |
| **standard** (default) | Routing uses default/ceiling per §4 of the governance spec with no additional bias | Standard caching behavior per §4/§6 defaults |
| **quality-sensitive** | Routing biased toward the user's ceiling model even where a cheaper model might otherwise qualify; auto-summarization thresholds are more conservative | Semantic caching disabled or only used with strict staleness bounds |

- This tag is set the same way the data-sensitivity tag is set — as workflow-template metadata
  or per-assignment-rule override — and can combine with data-sensitivity the same way multiple
  workflow templates already combine ([§4 of WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md)):
  the union/merge-taking-the-strictest-rule logic applies here too. A workflow tagged both
  `cost-sensitive` and a PII data-sensitivity level should never let cost bias override a
  governance/data restriction — restriction always wins over cost preference.
- No new stage type is required in the workflow engine's stage library — this is metadata
  consumed by the routing layer (§8) and the summarization/caching layers (§5/§6), not a new
  `type:` value in the workflow spec's stage taxonomy.

## 10. Context-graph tooling (optional, user-controlled)

An optional capability offered to end users for reducing context tokens sent per request on
large projects, in the spirit of `graphify` (adopted internally per
[ADR-0005](../decisions/0005-token-optimization-tooling.md) /
[ADR-0006](../decisions/0006-token-optimization-default-in-future-scaffolds.md)):

- Builds a local code-knowledge-graph (structure, symbol relationships, file dependencies) so an
  agent can retrieve a small, relevant slice of a large codebase instead of loading broad
  context, reducing input tokens per request.
- **Off by default, opt-in per project/workspace** — unlike prompt caching (§4), this changes
  what content is retrieved and sent per request, so it should be a deliberate choice, not a
  silent default, even though the code-only mode itself carries no exfiltration risk.
- **Code-only by default when enabled**: local, deterministic parsing (e.g. tree-sitter-style AST
  extraction) with zero data leaving the user's environment — this is the same safety posture
  established in ADR-0005/0006 for RegulAIt's own internal tooling, now offered as a first-class,
  user-facing product setting rather than an internal convention only.
- **Any semantic-extraction mode is a strictly separate, explicit opt-in** — see §11's "what NOT
  to do" for why this boundary must never be blurred for end users.

## 11. Output-compression preferences (optional)

A user- or workspace-level preference for terser agent output, in the spirit of `caveman`
(adopted internally per ADR-0005):

- Opt-in per user or workspace, exposed as a simple style preference (e.g. "concise mode") rather
  than a separate product surface.
- Fully local/deterministic — no data leaves the platform's own response pipeline, so this
  carries none of the risk considerations that apply to §10; it can default toward being easy to
  discover and enable, even while remaining opt-in rather than on-by-default, since output style
  is a user taste question, not a safety one.
- Reduces output-token spend without materially degrading answer correctness — should be
  positioned as a spend lever alongside model routing and caching in the cost analytics
  dashboard (§7), so users can see the effect of turning it on.

## 12. What NOT to do

Directly informed by the exfiltration-risk finding in
[ADR-0005](../decisions/0005-token-optimization-tooling.md):

- **Never auto-detect and silently use whichever LLM API key happens to be present in the
  environment to power a "semantic extraction" or similar content-understanding feature.**
  ADR-0005 found this exact pattern in `graphify`'s non-code-only mode — environment-variable-
  driven provider auto-selection that sends file content externally without per-file
  confirmation, including a fallback path to a non-US provider. RegulAIt's own product must not
  reproduce this pattern for its end users under any feature name.
- **Any context/codebase-graph capability offered to end users must default to local/code-only
  processing** (§10) — never default to a mode that reads prose, documents, images, or other
  non-code content and sends it to an external model.
- **Any semantic-extraction-style feature must be strictly opt-in, per project or per explicit
  action** — never enabled implicitly by the mere presence of a provider credential, and never
  enabled at the workspace/organization level in a way that silently applies to every project
  under it without each project's own explicit opt-in.
- **Semantic caching (§6) must never cross a governance boundary** — a cache is not a backdoor
  around per-user, per-connector, or per-MCP-tool data-scope restrictions already enforced by the
  governance layer.
- **Cost-aware model routing (§8) must never expand access beyond a user's existing
  entitlement ceiling** — it is a routing optimization inside a permission boundary the
  governance layer owns, never a second, competing permission system.
- **Do not let this feature area's priority creep toward P0.** It should not consume roadmap
  capacity that would otherwise go to hardening or completing the governance layer or the
  workflow engine — those two remain the product's non-negotiable foundation.

## 13. How this composes with the rest of the product (summary)

- **Governance layer**: token optimization is a consumer of the governance layer's existing
  per-user agent entitlement system (default/ceiling/mode restrictions) for model routing (§8),
  and of its connector/MCP data-scope rules as a hard boundary for semantic caching (§6). It adds
  no new entitlement object type to [GOVERNANCE_LAYER_SPEC.md §2](GOVERNANCE_LAYER_SPEC.md).
  Admin controls for routing policy and context-graph opt-in live inside the existing Agent
  Governance and per-project settings surfaces, not a new admin section.
- **Workflow engine**: token optimization adds one new piece of workflow-template metadata (the
  cost-sensitivity tag, §9), following the same pattern as the existing data-sensitivity tag in
  [WORKFLOW_ENGINE_SPEC.md §4](WORKFLOW_ENGINE_SPEC.md), and participates in the same
  strictest-rule-wins merge logic when multiple workflow templates apply. It adds no new stage
  type to the workflow engine's stage library.
- **Audit/observability**: cost analytics (§7) is a consumer of the same event stream the
  governance layer's audit log already produces, per the "consumers of the same underlying event
  stream" principle already stated in [GOVERNANCE_LAYER_SPEC.md §7](GOVERNANCE_LAYER_SPEC.md).

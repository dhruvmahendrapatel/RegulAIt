# RegulAIt — Token Optimization Spec (P0 Pillar 6)

> Source: original specification authored for RegulAIt during bootstrap planning (2026-07-22),
> prompted by [ADR-0005](../decisions/0005-token-optimization-tooling.md) and
> [ADR-0006](../decisions/0006-token-optimization-default-in-future-scaffolds.md) (OQ-004, part
> c: "consider token optimization as a RegulAIt product feature in its own right"). Those two
> ADRs cover **internal dev-tooling adoption** (`caveman`, `graphify`) for building RegulAIt
> itself. This document is a different thing: it specifies what RegulAIt should **do for its own
> end users** — people building agents, workflows, and apps on the platform — to manage and
> reduce their LLM token spend.

> **This is now a co-equal P0 pillar, not a standard feature area.** Per
> [ADR-0007](../decisions/0007-six-p0-pillars.md) (2026-07-24), token/cost optimization is
> escalated to sit alongside [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md) and
> [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md) as one of RegulAIt's six non-negotiable
> architectural pillars (see [CLAUDE.md](../../CLAUDE.md) and [VISION.md](VISION.md)'s banner).
> It still **reuses** the governance layer's entitlement system and the workflow engine's
> tag/assignment mechanism rather than duplicating them (§8–§9 below) — that composition
> principle is unchanged — but it is no longer secondary in priority, and no roadmap item should
> assume it can be deferred indefinitely the way a non-P0 feature area could.

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

| | Governance layer | Workflow engine | Token/cost optimization |
|---|---|---|---|
| **Priority** | P0, non-negotiable | P0, non-negotiable | P0, non-negotiable (escalated per [ADR-0007](../decisions/0007-six-p0-pillars.md)) |
| **What it governs** | Who can do what | What sequence a change must pass through | How efficiently any permitted action spends tokens/cost |
| **Failure mode if missing** | Shadow IT, uncontrolled agent/data access | Ungoverned, unreviewable changes shipping | Runaway spend at scale, and a lost differentiator — per-project cost attribution and automatic efficiency are now expected platform capabilities, not a nice-to-have |

Token optimization **extends** the other two pillars rather than introducing a parallel
enforcement mechanism:
- It reuses the governance layer's per-user agent entitlement system (§8 below) for model
  routing and lazy tool-loading — no separate "cost policy engine."
- It reuses the workflow engine's tag/assignment mechanism (§9 below) for workflow-level cost
  sensitivity — no separate "cost workflow."
- It reuses the governance layer's compliance-classification cascade
  ([GOVERNANCE_LAYER_SPEC.md §8.3](GOVERNANCE_LAYER_SPEC.md)) as a hard ceiling on optimization
  aggressiveness — no optimization may relax below what a compliance classification requires.

## 3. Capability overview

| Capability | What it does | Default posture |
|---|---|---|
| **Native prompt caching** | Wires provider-native prompt caching into every model call the platform routes, automatically | On by default, no user action required |
| **Automatic file pre-processing pipeline** | Parses/OCRs/extracts uploaded PDFs, screenshots, and images into plain text/markdown before they enter any model's context, unless the request genuinely needs visual/layout understanding | On by default; per-request visual-need detection preserves the original when needed |
| **Context-window management / auto-summarization** | Monitors context usage per session/agent run and auto-summarizes or prunes stale context before hitting provider limits; includes proactive, cadence-based summarization and topic-drift session forking | On by default, tunable thresholds |
| **Semantic caching** | Detects effectively-duplicate or highly-similar requests and serves a cached response instead of re-invoking the model | Opt-in per agent/workflow (see §6 for why) |
| **Cost/token analytics dashboards** | Per-user, per-agent, per-model, per-workflow spend and token-volume visibility, with trends, alerts, and a dedicated optimization-savings breakdown | On by default (read-only visibility carries no exfiltration or correctness risk) |
| **Governance-integrated model routing** | Routes a request to the cheapest model that satisfies the user's governed entitlement ceiling, using an automatic complexity classifier | On by default, bounded entirely by existing governance entitlements |
| **Edit-vs-rewrite intent detection** | Routes a targeted-modification request to a scoped diff/patch tool call instead of a full artifact regeneration | On by default, full regeneration reserved for requests that need it |
| **Request batching/debouncing** | Combines rapid-succession messages from the same user into a single call where safe, instead of paying a full context-reload cost per message | Admin-configurable: offer-to-merge (default) or automatic-merge |
| **Lazy, per-request tool-loading** | Includes only the subset of a user's entitled connectors/MCP tools actually relevant to the current request in the model call, rather than every entitled tool's schema every time | On by default; entitlements themselves are never reduced |
| **Persistent preference profiles** | Per-user/team/Shared-Project style, tone, and formatting preferences stored once and silently applied to every session | Opt-in setup, applied automatically once set |
| **Context-graph tooling** | Optional local code-knowledge-graph indexing to reduce context tokens sent per request on large codebases | Opt-in, code-only by default (see §10) |
| **Output-compression preferences** | User-selectable terser output style to reduce output-token spend | Opt-in per user/workspace preference |

## 4. Native prompt caching and automatic file pre-processing

The two highest-leverage, lowest-risk techniques in this space — both operate purely on the
*shape* of what enters or is reused within a model call, not on *what the user is allowed to do*
— so both should be treated as close to non-optional as a "default-on" automation can be.

### Native prompt caching
- Every model call the platform's routing layer makes on a user's behalf should use the
  underlying provider's native prompt-caching mechanism wherever the provider supports it
  (system prompts, tool definitions, repeated large context blocks, workspace "Knowledge"/rules
  content per the patterns in [VISION.md](VISION.md)).
- Requires no third-party dependency and introduces no additional data-handling risk beyond what
  the underlying model call already carries — a routing-layer optimization, not a new data path.
- Wired in at the same layer that already sits between every user action and the underlying
  model — i.e., the same routing/dispatch point the governance layer's per-user agent entitlement
  check ([§4 of GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md)) already intercepts — so
  caching and entitlement enforcement compose naturally rather than needing separate
  instrumentation.
- Cache-hit/cache-miss rates feed the cost analytics dashboard (§7) as a first-class metric.

### Automatic file pre-processing pipeline
- Any uploaded PDF, screenshot, or image is automatically parsed/OCR'd/extracted into plain text
  or markdown server-side *before* it is added to any model's context, unless the request
  genuinely requires visual/layout understanding (e.g., a design-review task, or a screenshot
  being debugged per the core agent loop's Debug mode) — in which case the original is preserved
  and sent as-is.
- Runs as a mandatory pre-step inside the gateway's ingestion path, transparent to the user; the
  gateway already sees every file that enters a governed conversation (per
  [§2 of GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md)'s object model), so this is a natural
  interception point rather than a new one.
- The visual-need detection is conservative: when in doubt whether layout/visual information
  matters, preserve the original rather than risk silently discarding information the task
  needed — matching this spec's overall safe-by-default principle (§1).
- Pre-processing outcomes (converted vs. preserved-original, and why) are logged with enough
  detail for a user to see why a given upload was or wasn't converted, consistent with this
  spec's transparency principle already applied to context-window management (§5) and model
  routing (§8).

## 5. Context-window management, auto-summarization, and session forking

- Every agent session/workflow run tracks context-window utilization against the active model's
  limit.
- **Configurable auto-summarization**: when utilization crosses a threshold, older
  context/conversation turns are summarized into a condensed form rather than truncated blindly
  or left to overflow into an expensive/failed call. The user-visible conversation thread does
  not appear to reset — only the underlying context sent to the model shrinks.
- **Proactive, cadence-based summarization**: the same compaction mechanism can also run on a
  message-count or token-count cadence (e.g., every 15–20 messages by default), not only
  reactively at a hard limit, so context stays lean continuously rather than growing until a
  cutoff is hit. Cadence is configurable per project, consistent with §1's admin-tunable-
  aggressiveness principle.
- Summarization is **conservative by default** — favor retaining fidelity on recently-touched
  files, active requirements/plan artifacts (per the workflow engine's artifact-generation
  stage), and explicit user instructions, over older exploratory turns.
- **Topic-drift session forking**: when a new message is substantially unrelated to the recent
  conversation, the system proactively suggests (or, per admin policy, automatically creates) a
  new session pre-seeded with only the relevant carry-over context, rather than dragging the full
  unrelated history into every subsequent call. This is offered, never silently forced, when it
  would change which thread the user is nominally in — a forked session is clearly presented as
  new, not substituted in place of the one the user was in.
- Per-workflow and per-agent configurability, so a long-running background agent (per the
  Cursor-style cloud-agent pattern noted in [VISION.md](VISION.md)) can have a more aggressive
  summarization/forking policy than an interactive chat session where the user is watching context
  build in real time.
- Surfaced to the user: a visible indicator of current context usage, when auto-summarization has
  fired, and when a topic-drift fork was suggested/created — not a silent background process,
  consistent with the "visible, step-by-step execution log" principle already established for the
  core agent loop.
- Compaction and forking events are both logged (what was summarized, what was forked and why)
  for auditability, consistent with [GOVERNANCE_LAYER_SPEC.md §3](GOVERNANCE_LAYER_SPEC.md)'s
  audit-everything principle.

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
- **A dedicated "optimization savings" line**: estimated tokens/cost avoided by automatic model
  routing, edit-vs-rewrite routing, context compaction/summarization, file pre-processing,
  deduplication/caching, and lazy tool-loading, broken out from raw spend — so the value of this
  entire pillar is visible to engineering and finance stakeholders, not just felt as a lower bill
  with no explanation. This feeds directly into the per-project cost dashboard's own
  optimization-savings line (per
  [GOVERNANCE_LAYER_SPEC.md §10.3](GOVERNANCE_LAYER_SPEC.md)) rather than duplicating it — this
  section is the per-user/per-agent source of truth, the governance spec's §10 dashboard is the
  per-project business-facing rollup.
- **Budget alerts and soft/hard caps**: admins can set per-user or per-team spend thresholds that
  trigger a notification (soft) or block further model calls pending admin action (hard) —
  modeled on Lovable's per-member credit limits, but expressed as real spend/token volume rather
  than an abstracted credit unit, and configurable rather than a fixed platform-wide credit
  scheme.
- **Feeds the same audit/event pipeline** the governance layer already produces (per
  [§7 of GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md)) — cost analytics is a consumer of
  that event stream, not a second independent logging system.

## 8. Model routing, lazy tool-loading, and request-shaping tied to the governance layer's entitlement system

This is the capability most explicitly designed to **not duplicate** existing product
infrastructure — every automation below operates strictly *within* a boundary the governance
layer already owns, never expanding it.

### Complexity-based model routing
[GOVERNANCE_LAYER_SPEC.md §4](GOVERNANCE_LAYER_SPEC.md) already defines, per user, a **default
agent/model**, a **ceiling**, and mode-level restrictions on top of both. Cost-aware model routing
is built entirely as logic **within** that existing structure, not as a new entitlement
dimension:

- A lightweight complexity classifier estimates task complexity for each request (e.g., a simple
  lookup, a formatting task, a low-stakes summarization vs. a hard reasoning task) and routes it
  to the cheapest model that can handle it, **within the set of agents/models the user is
  already entitled to** — never a model the user isn't otherwise entitled to use, and never above
  the user's ceiling. The user can manually override the routing decision at any time.
- Routing decisions are a **cost optimization within a permission boundary**, not a new permission
  boundary — the governance layer's allow-list/ceiling/mode restrictions remain the single source
  of truth for "is this agent/model usable by this user at all."
- The routing decision itself is logged as a cost-attribution event
  ([GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md)) so its savings are measurable.
- Admins get a routing-policy control (part of the existing Agent Governance surface in
  [GOVERNANCE_LAYER_SPEC.md §6](GOVERNANCE_LAYER_SPEC.md)), not a separate admin page: per user or
  role, whether cost-aware downrouting is enabled at all, and whether it requires
  disclosure/confirmation before use for that user.
- **User-visible routing**: whichever model actually served a given request is shown in the
  execution log — routing is a transparent optimization, not a hidden substitution.
- **Task-classification signal**: routing decisions are informed by workflow stage type where
  available (e.g., a Planning-only stage per the workflow engine may tolerate a lighter model than
  a Build/execution stage) — see §9 for the explicit workflow-level tag.

### Edit-vs-rewrite intent detection
- When a request is detected as a targeted modification to existing content (as opposed to a
  request for something new), the routing/dispatch layer automatically routes to a scoped
  diff/patch-style tool call instead of regenerating the full artifact — mirroring an inline-edit
  pattern as the default path, with full regeneration reserved for requests that actually need
  it.
- This reduces both token cost and the risk of unreviewed scope drift flagged in
  [WORKFLOW_ENGINE_SPEC.md §5](WORKFLOW_ENGINE_SPEC.md)'s scope-lock requirement — a targeted edit
  is inherently easier to keep within a signed-off scope than a full regeneration.
- Like model routing, this is a request-shaping decision, not an access decision: it never causes
  a tool call the user isn't already entitled to make.

### Request batching/debouncing
- When multiple messages arrive from the same user in rapid succession before the previous one
  has finished processing, the system offers to (or, per admin policy, automatically does)
  combine them into a single call rather than paying the full context-reload cost of each one
  separately — extending the prompt-queue behavior already noted for Cursor and Lovable in
  [VISION.md](VISION.md) from "queue and run sequentially" to "queue and merge where safe."
- Batching decisions are logged so a user can see what was merged and undo/split it if the merge
  was wrong.

### Lazy, per-request tool-loading
- Rather than always injecting the full schema for every tool a user is entitled to
  ([GOVERNANCE_LAYER_SPEC.md §2–§3](GOVERNANCE_LAYER_SPEC.md)) into every model call, the gateway
  dynamically includes only the subset of connectors/MCP tools actually relevant to the current
  request — determined automatically.
- The user's entitlements don't shrink; only the per-call token overhead of unused tool
  definitions does. This directly reuses the same entitlement data the governance layer already
  maintains — it's a performance/cost optimization layered on top of governance data that already
  exists, not a new access-control concept.

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

## 11. Output-compression preferences and persistent preference profiles

A user- or workspace-level preference layer for reducing output-token spend and eliminating
repeated instruction-restating, in the spirit of `caveman` (adopted internally per ADR-0005) and
the "Knowledge"/"Rules" patterns already noted for Lovable/Cursor in [VISION.md](VISION.md):

### Output-compression preferences
- Opt-in per user or workspace, exposed as a simple style preference (e.g. "concise mode") rather
  than a separate product surface.
- Fully local/deterministic — no data leaves the platform's own response pipeline, so this
  carries none of the risk considerations that apply to §10 (context-graph tooling); it can
  default toward being easy to discover and enable, even while remaining opt-in rather than
  on-by-default, since output style is a user taste question, not a safety one.
- Reduces output-token spend without materially degrading answer correctness — positioned as a
  spend lever alongside model routing and caching in the cost analytics dashboard (§7).

### Persistent preference profiles
- Per-user (and per-team, per Shared Project per
  [GOVERNANCE_LAYER_SPEC.md §9](GOVERNANCE_LAYER_SPEC.md)) style/tone/formatting preferences are
  stored once and silently applied to every session by default, the same way Lovable's Knowledge
  and Cursor's Rules apply standing instructions automatically — with no action needed once set.
- This is already implied by the "Knowledge"/"Rules" pattern noted in [VISION.md](VISION.md);
  this section makes explicit that the platform should apply this by default rather than
  requiring the user to discover and set it up.
- Preference profiles compose with output-compression above (a profile can simply set "concise
  mode" as a standing preference) and with a Shared Project's context store — a team-level
  preference profile is itself a piece of shared, provenance-tracked context.

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
- **No automatic optimization in this spec may silently degrade output below what a workflow's
  compliance classification requires** (per
  [GOVERNANCE_LAYER_SPEC.md §8.3](GOVERNANCE_LAYER_SPEC.md)'s "born governed" cascade) — a
  `quality-sensitive` or compliance-classified workflow's routing, summarization, and caching
  aggressiveness must stay within whatever bounds that classification sets, regardless of this
  feature area's now-elevated P0 priority.
- **Every automation in §4, §5, and §8 must remain admin-tunable per project** (an aggressiveness
  dial, or a full off-switch) — escalating this feature area to P0 raises its build priority, not
  its right to override a project's explicit fidelity-over-cost preference.

## 13. How this composes with the rest of the product (summary)

- **Governance layer**: token optimization is a consumer of the governance layer's existing
  per-user agent entitlement system (default/ceiling/mode restrictions) for model routing and
  lazy tool-loading (§8), and of its connector/MCP data-scope rules as a hard boundary for
  semantic caching (§6) and file pre-processing (§4). It adds no new entitlement object type to
  [GOVERNANCE_LAYER_SPEC.md §2](GOVERNANCE_LAYER_SPEC.md). Admin controls for routing policy,
  batching, and context-graph opt-in live inside the existing Agent Governance and per-project
  settings surfaces, not a new admin section. It is also hard-bounded by the
  compliance-classification cascade
  ([GOVERNANCE_LAYER_SPEC.md §8.3](GOVERNANCE_LAYER_SPEC.md)) — no optimization may relax below
  what a workload's compliance classification requires.
- **Workflow engine**: token optimization adds one new piece of workflow-template metadata (the
  cost-sensitivity tag, §9), following the same pattern as the existing data-sensitivity tag in
  [WORKFLOW_ENGINE_SPEC.md §4](WORKFLOW_ENGINE_SPEC.md), and participates in the same
  strictest-rule-wins merge logic when multiple workflow templates apply. It adds no new stage
  type to the workflow engine's stage library.
- **Cost dashboard**: this spec's §7 dashboards are the per-user/per-agent/per-model source of
  truth and own the "optimization savings" line item; the per-project cost dashboard in
  [GOVERNANCE_LAYER_SPEC.md §10](GOVERNANCE_LAYER_SPEC.md) rolls that same data up to a
  per-project, business-facing view rather than re-deriving it independently.
- **Audit/observability**: cost analytics (§7), file pre-processing decisions (§4), and
  context-compaction/forking events (§5) are all consumers of the same event stream the
  governance layer's audit log already produces, per the "consumers of the same underlying event
  stream" principle already stated in [GOVERNANCE_LAYER_SPEC.md §7](GOVERNANCE_LAYER_SPEC.md).

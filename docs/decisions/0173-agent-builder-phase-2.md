# ADR-0173: Agent builder phase 2 — governed tool use, inbound channels, and the observe/evaluate loop

- **Status**: Accepted (owner, 2026-10-04: "start phase 2")
- **Date**: 2026-10-04
- **Builds on**: ADR-0172 (phase 1), ADR-0104/0105/0166 (approval binding), ADR-0121 (Outlook send-only)

## Context

Phase 1 shipped the builder with honest limits: tools are described to the model but never executed,
channels record a binding but receive nothing, and the observe/evaluate modules from the owner's
teardown were deferred. A survey of the code found most of the machinery already present: the governed
dispatch core passes tool definitions and returns tool calls for every provider; `executeGovernedToolCall`
runs a governed MCP call in-process with every check (entitlement, kill switch, approval rules bound to
the argument digest, PII, guardrails, egress, breaker, budget, metering); orchestration already has a
bounded tool loop. Missing: the builder loop itself, an in-process governed connector call, automatic
resumption after an approval, inbound chat handlers, and several observe/evaluate pieces (outbound
webhooks, KRIs/percentiles, automation rules, annotation queues over traces, a model allow-list matrix,
a command palette).

## Decision

### Batch 2a
1. **Governed tool use in builder agents.** A chat (or schedule, or channel) turn runs a bounded loop:
   the model sees the toolbox as tool definitions (MCP tools from their stored schema; connectors through
   a generated operation schema), and every call goes through the existing governed paths as the person
   the turn runs as — MCP via `executeGovernedToolCall`, connectors via a newly extracted
   `executeGovernedConnectorCall`. Limits: max steps per turn (org worker-turn settings), max tool calls,
   the kill switch and the agent's monthly limit re-checked on every step, and tool costs counted toward
   the agent's spend.
   - **Two different pauses, never conflated.** A tool marked *Ask first* pauses for the person in the
     thread (Approve / Deny with the exact arguments shown) — a confirmation, not an approval. An
     organisation approval rule or ABAC `require_approval` pauses in the **approvals queue** under the
     existing binding (argument digest, expiry, target); when an approver decides, the turn **resumes
     automatically** with the identical call, or records the denial and lets the model continue.
   - Tool steps are stored on the thread (call, arguments digest + preview, outcome, cost) and shown as
     collapsible steps; each governed call keeps its own audit row and trace span, linked to the turn.
2. **Inbound channels.** Slack (Events API: URL verification, message and app-mention events, retry
   de-duplication, v0 signature + replay window) and Microsoft Teams (outgoing-webhook messages with HMAC;
   a full Bot Framework bot with JWT validation is later) reach a builder agent thread. The chat user is
   mapped to a RegulAIt user through the admin-managed identity links; an unlinked or unauthorised sender
   gets a polite refusal and nothing runs. Platforms need an answer within seconds, so the turn runs
   asynchronously and the reply is posted back into the platform thread. **Inbound email stays refused**
   (ADR-0121: Outlook is send-only).
3. **Model allow-list matrix.** An org policy of feature × provider × model (features: chat, agent
   builder, copilot, intake assistant, evaluations, …) with a default model per feature and an optional
   data-class dimension, enforced in the shared model-access decision so every surface obeys it, and
   shown to people as "allowed here" in the model picker.
4. **Command palette** (Ctrl/⌘-K): one search over pages, use cases, agents, builder agents, projects,
   controls and recent threads, entitlement-aware (it only finds what you may open).

### Batch 2c (after 2a lands)
5. **Traces as the evidence spine:** filters by agent/model/cost/latency/score, key/value tags, and
   actions "add to dataset" and "send to annotation queue".
6. **Annotation queues** over traces and runs: named queues, reviewers, a rubric (score, label, comment),
   SLA, two-person review where required, export.
7. **Evaluator catalog mapped to controls:** one catalog over the existing scorers, guardrail detectors
   and red-team classes, each tagged with NIST AI RMF / ISO/IEC 42001 / EU AI Act / OWASP references
   (from validated research), runnable on traces and datasets; datasets built from traces and past
   intakes; side-by-side experiment comparison; automatic re-run when a prompt or model changes.
8. **Monitoring KRIs and dashboards:** trace volume, error rate, p50/p99 latency, cost and feedback per
   agent/project, with user-defined thresholds that raise governance alerts; custom dashboards.
9. **Outbound webhooks** (subscriptions, signing, delivery log, retries) used by prompt-version changes
   and by **automation rules** (filter + sampling + action: route to a queue, add to a dataset, webhook,
   extend retention within policy).

## Consequences
- Migrations 0136+ (one per branch, reserved in order). New routes are non-admin only where a person acts
  on their own work; policy surfaces stay admin.
- An autonomous loop multiplies spend and side effects, so every step is bounded and every side effect
  is governed exactly as if the person had made the call themselves — the builder adds no new authority.

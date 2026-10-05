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

## Amendment — batch 2a built and reviewed (2026-10-04)

Migrations 0136 (tool steps, encrypted paused turn), 0137 (inbound channel threads) and 0138 (model policy).

- **Tool loop.** The toolbox is re-checked for the person each turn runs as, and every call goes through the governed MCP
  path or `executeGovernedConnectorCall` (extracted unchanged from the connector route). Model steps are capped by the
  org's worker-turn settings and tool calls at 12 per turn. The entitlement (kill switch included) and the monthly limit
  are re-checked before every step and tool call, and tool costs count toward the agent's spend. Connector writes whose
  execution posture is "require approval" are still refused; there is no connector approval path yet.
- **Pauses.** "Ask first" goes to the thread's person; organisation approvals go to the queue. Each queued call is pinned
  to its tool's kind and id, so a resume never runs a different tool (`tool_changed_since_requested`,
  `tool_no_longer_available`), and clashing tool names carry a hash of their identity. A deny always goes through. A
  gate refusal on resume, an exception, or an expired or superseded approval ends the step and clears the pause. The
  thread owner or an admin can cancel a pending step. Pause state and step status are written in one transaction. An
  approval decision resumes the turn as tracked background work, not inside the approver's request.
- **Channels.** Slack events and Teams messages reach agent threads as the linked person. A turn resumed in the web app
  is posted back to its Slack/Teams thread. Links are absolute under `/ui`, and replies are escaped for Slack and sent as
  plain text to Teams.
- **Model policy.** Enforced in `agentDecision` and the dispatch core for chat, compat, copilot, intake, builder (turn
  and default model), evaluations (including red-team sequence probes), orchestration and decomposition. A refusal is
  `model_not_allowed_for_feature`. Builder model pickers show what the policy allows there.
- **Disclosure.** The agent's system prompt gives only a count of the toolbox tools the person may not use, never their
  names.

## Amendment — batch 2b defined (owner, 2026-10-05: "Both")

Batch 2b was never written down. The owner chose to cover both the teardown's **Build** modules and the batch-2a leftovers.
Outbound webhooks move from 2c into 2b, because the prompt registry needs them, and 2c's automation rules reuse them.
Migrations 0143+ in order.

- **Governed prompt registry.**
  - Prompts are versioned as commits (template, model configuration, variables, parent, author).
  - Named tags (`staging`, `prod`) point at commits.
  - Moving the `prod` tag goes through the approvals queue, with separation of duties: the promoter is not the commit's
    author, and the binding is the commit hash.
  - Commits are diffed and the promotion is audited.
  - Every commit and tag move emits an outbound webhook event.
- **Outbound webhooks** (from 2c item 9).
  - Admin-managed subscriptions to named events, signed with HMAC under a per-subscription secret encrypted with the data
    key.
  - The egress guard applies, there is a delivery log, and retries use backoff on the scheduler.
  - A test notification can be sent.
  - The payload carries no secrets and no content beyond what the event names.
- **Playground ("policy sandbox").**
  - Edit a prompt with `{variables}`, an output schema and tools, and pick a model through the governed picker.
  - Each run goes through the governed dispatch as the caller, under its own model-policy feature.
  - Run the prompt over a dataset (the evaluate mode) and save the result as a new commit.
- **Run graph.** A read-only graph of one run's decision path:
  - a builder turn (model steps, tool calls, pauses, approvals);
  - an orchestration run (its task graph);
  - a use case's path (intake, classification, rules, review, decision).

  Each node links to its audit row and trace span.
- **2a leftovers.**
  - Connector writes under the `require_approval` execution posture pause in the approvals queue, bound to the argument
    digest, and resume like MCP calls (today they are refused).
  - A Microsoft Teams Bot Framework endpoint with JWT validation against configurable OpenID metadata, beside the
    outgoing-webhook path.
  - Slack interactive confirmations: "Ask first" answered from the chat with Approve/Deny buttons. The interaction payload
    is signature-verified, and only the thread's own linked person may answer.

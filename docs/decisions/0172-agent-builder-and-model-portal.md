# ADR-0172: An agent builder suite and a model portal

- **Status**: Accepted (owner, 2026-10-04)
- **Date**: 2026-10-04

## Context

The owner shared a product teardown of a leading agent-engineering platform (kept out of this public
repository) and asked for two things: a separate **no-code agent builder** section with the features
that platform's builder offers, and a **model selection portal** as visual and usable as theirs, using
provider logos. Today RegulAIt has the runtime pieces (governed agents/model bindings, conversations,
orchestration runs with worker nodes, MCP servers, connectors, ChatOps, approvals, per-project and
per-key budgets) but no builder layer, and every model choice is a plain dropdown with no logos.

## Decision

1. **A new non-admin suite, "Agent Builder"** (`/builder/*`), beside Workspace:
   Chat · Inbox · Agents · Templates · Integrations · Skills · Usage, plus a New agent dialog and an
   agent editor. A builder agent has a name and description, **instructions** (an AGENTS.md-style
   document), a **model** (one of the governed model bindings in the agent registry), a **toolbox**
   (connectors and MCP tools), **sub-agents**, **skills** (a shared library of packaged SKILL.md
   instructions), **memory** (an append-only log the agent is given), **schedules**, **channels**
   (Slack, Teams, email), **sharing** (private, workspace, or named people), a connection format
   (shared or per-user, fixed at creation), a monthly **spend limit**, export/import and a
   "use in code" snippet. Templates seed all of it.
2. **Governed by construction, not by convention.** A builder agent never runs with more than the
   person using it holds: chat dispatches through the existing governed invoke path as the caller
   (their entitlements, budgets, guardrails and approvals apply); tools can only be added from what
   the editor holds grants for and are re-checked for the user at run time; the per-agent monthly
   limit is enforced before dispatch; every create, sharing, tool and limit change is audited.
   This is the differentiator: the same builder experience, but every agent is a governed one.
3. **A model portal** (`/models`): a searchable grid of the models a person may use, one tile per
   governed model binding with its provider's logo, model id, tier and readiness (ready, needs
   credentials, halted, suspended); selecting one opens a "Try it" panel with copyable cURL /
   TypeScript / Python snippets for the gateway's OpenAI- and Anthropic-compatible endpoints and a
   Run button that goes through the governed invoke path. The same picker replaces the plain
   dropdowns where people choose a model (chat, agent registry, model credentials, builder editor).
4. **Logos are vendored**, never fetched (the product must work air-gapped): provider marks from
   Lobe Icons (MIT) and app marks from SVG Logos (CC0), with sources in
   `apps/web/src/ui/logos/LICENSES.md`. Marks identify third-party services only. No competitor
   branding or product names are used for our own features.

## Phasing

- **Phase 1 (this ADR's build):** everything above. Honest limits for phase 1: agents do not yet
  execute tool calls autonomously (the toolbox is configured and entitlement-checked; execution
  through the governed MCP proxy is phase 2); channels record the binding to an existing ChatOps
  connection but inbound conversations over Slack/Teams/email are phase 2; "use a computer" is
  recorded but not provisioned (no sandbox runtime yet).
- **Phase 2:** autonomous tool use via the MCP proxy with approval-gated writes, inbound channels,
  and the observe/evaluate/build/ship modules from the teardown (trace trees, an evaluator catalog
  mapped to controls, annotation queues, datasets and experiments, prompt registry webhooks,
  monitoring dashboards, a model allow-list matrix, command palette).

## Consequences

- Migration 0135 adds the builder tables. New routes live under `/v1/builder/*`, all non-admin with
  owner/sharing checks.
- The suite list grows by one; the "/" nav filter and suite switcher pick it up automatically.

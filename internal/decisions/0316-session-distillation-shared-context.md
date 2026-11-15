# ADR-0316: Distil governed agent sessions into the Shared Project context store

- **Status**: Accepted (lane E4 brief, 2026-11-15, owner direction "Keep building until our tool is ready for an
  Enterprise use"; owner questions are listed below)
- **Date**: 2026-11-15
- **Index**: **Session distillation (gap G8, pillar 4): a person distils their own governed agent session (a project-attributed conversation) into a provenance-tagged revision of the existing shared context store, through the one context write path and its conflict rules. Off by default per project; an admin turns it on with a step-up, audited. The distillation is one governed dispatch billed to the project. A reader sees a distilled revision only while they could read its inputs (the session's agents and any declared context).**
- **Backlog item**: market analysis 2026-11 §3a, gap G8 (competitor reference: Atlassian Teamwork Graph session memory,
  2026-10-08)
- **Built in**: lane E4, branch `builder/e4-session-distillation`
- **Migration**: the `session_distillation` migration (numbered at merge, ADR-0252)
- **Related**: ADR-0011 (shared context store), ADR-0050 (lineage), ADR-0021 (compaction settings), ADR-0112
  (conversation presentation), ADR-0173 (model policy matrix), ADR-0176 (open source first), ADR-0180 (secure by
  default), ADR-0185 I3 (conversation retention), ADR-0200 (3NF and the security checklist)

## Context

GOVERNANCE_LAYER_SPEC §9.2 gives a Shared Project a context store with provenance, versioning and conflict
resolution, and §9.4 a "promote to shared" action for workflow artifacts. What a team learns in a working session with
an agent stays in that person's own conversation thread: conversations are strictly personal (every route is
own-scoped, admins included), and nothing carries their decisions into the shared store except retyping them.

Competitors now keep "session memory" for teams. The gap is to do it without breaking three things we already promise:
a conversation is personal until its author shares it; shared context does not grant what a member's entitlements do
not (§9.3); and every model call is governed, attributed and optimised.

## Decision

1. **The source is a governed agent session**: a `conversations` thread with a `project_id`. Orchestration runs and
   workflow artifacts are out of scope here (artifacts already have promote; runs write context directly, ADR-0050).
2. **Extend the existing store, not a parallel one.** A distillation is an ordinary revision of
   `project_context_items` under the key `session/<conversationId>`, written by the one context write path
   (`writeContextRevision`, projects.ts): contributor role, archived refusal, read-before-write and the named arbiter's
   conflict path apply unchanged, and its normal `project-context-contributed` audit row is written. The path takes an
   `onWritten` hook so provenance commits in the same transaction. New tables hold only what the store does not:
   - `project_session_distillation_policies` — the per-project switch (no row = off);
   - `project_context_distillations` — one row per distilled revision: source session, distiller agent, first and last
     turn read, session start and last-turn time, distilled time. Author, team and project are the item's own columns;
   - `project_context_distillation_messages`, `…_agents`, `…_context_inputs` — the inputs, as join tables.
   Session, message, agent and input ids are FK-free point-in-time evidence (commented on each column): retention may
   delete the conversation, and a deleted agent or project must never remove a row that gates reading.
3. **Off by default (ADR-0180).** Only an admin turns it on per project (`PUT /v1/projects/:projectId/session-distillation`,
   admin route class); turning it on is a `settings_relax` step-up (`op: session_distillation_enable`). Both directions
   are audited.
4. **The author decides, and only the author.** `POST /v1/conversations/:conversationId/distil` loads the session
   through the own-scoped replay loader (403 for anyone else, admins included; retention-expired 404, incident-held 409).
   It is the checkpoint and the session-end action at once: it distils the turns after the last checkpoint up to
   `throughMessageId` (default: all). Partial sharing stays opt-in: nothing is distilled without the author's request.
   Governance-denied turns are never sent (the compaction rule).
5. **One governed dispatch.** The distiller is the session's agent (or one the author names), decided as the author by
   `agentDecision` with the `chat` feature of the model policy matrix. `executeGovernedDispatch` bills it to the
   session's project (pillar 5), applies the project's compliance-cascade PII mode on input and output (pillar 3) and
   the governed core's optimisation (pillar 6). Re-distillation is cumulative: the previous distilled text plus the
   turns since, so earlier turns are never re-read. A PII-withheld, refused or empty output writes nothing.
6. **A reader sees a distilled revision only while they could read what it came from**
   (`session-distillation-access.ts`):
   - every agent whose output the turns carry (the session's agent, each turn's served agent, the distiller): the
     reader's own `agentDecision` must allow it now;
   - every declared shared-context input (any project): the reader must be a member of its project (or an admin), and
     a distilled input is checked the same way (depth-limited).
   The author always reads their own revision; the bootstrap token reads none; a missing input fails closed. The check
   runs on every read of the store: the context list (a withheld head is listed as `{key, revision}`, never replaced
   by an older revision), the key history, the graph and orchestration's supplied context (absent, like an unknown
   key). The project routes take the check by injection from app.ts (projects.ts cannot import it without a cycle)
   and withhold every distilled revision when none is injected.
7. **The arbiter.** A distilled revision that conflicts goes to the named arbiter only when the arbiter could read its
   inputs; otherwise the write is rolled back with `distillation_conflict_unreadable_by_arbiter` and the author distils
   again.

Open source first (ADR-0176): the store, its versioning, the governed dispatch and the entitlement kernel are ours and
already exist; the distillation is a prompt over them. Summarisation libraries (LangChain's `ConversationSummaryMemory`,
LlamaIndex's memory modules) were considered: each wraps its own model client, which would bypass the governed
dispatch, so none fits; nothing new is added to `THIRD_PARTY.md`.

## Owner questions (built with the secure default)

- **Automatic distillation at session end** without the author's request. Built: never automatic; the author asks.
- **Admins reading distilled revisions** whose agents they are not entitled to. Built: admins take the same agent check
  as anyone (they keep the audit trail, which records ids and counts, not content).
- **Row-level security** on the new tables follows `project_context_items`, which has none yet; the RLS batches add
  both together.

## Consequences

- Teams get session memory in the same governed store, with provenance a reader can inspect
  (`GET /v1/projects/:projectId/context/items/:itemId/distillation`).
- Readers may see `withheld` markers: the honest signal that context exists they may not read.
- Four routes have no screen yet; they are known UI gaps tracked on #453.

# ADR-0316: Distil governed agent sessions into the Shared Project context store

- **Status**: Accepted (design; lane E4 brief, 2026-11-15). **Implementation paused** by owner direction relayed by
  the master the same day (pilot focus: G8 is off the pilot path). Resume only when the master says so. Owner
  questions are listed below
- **Date**: 2026-11-15
- **Index**: **Session distillation (gap G8, pillar 4): a person distils their own governed agent session (a project-attributed conversation) into a provenance-tagged revision of the existing shared context store, through the one context write path and its conflict rules. Off by default per project; an admin turns it on with a step-up, audited. The distillation is one governed dispatch billed to the project. The author previews the distilled text and commits exactly that text. Inputs come from recorded lineage only, and a reader sees a distilled revision only while they could read every input. Downstream, distilled text is supplied as untrusted data, never as a system prompt.**
- **Backlog item**: market analysis 2026-11 §3a, gap G8 (competitor reference: Atlassian Teamwork Graph session memory,
  2026-10-08)
- **Built in**: not yet. A working first slice (schema, routes, read check, 10 integration tests) is parked unmerged on
  branch `builder/e4-session-distillation`; it gets its own PR when the build resumes, after merging main
- **Migration**: none in this ADR's PR; the build adds `pending/session_distillation.sql` (numbered at merge, ADR-0252)
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
   - `project_context_distillation_messages`, `…_agents`, `…_context_inputs` — the inputs, as join tables;
   - `project_context_distillation_drafts` — a previewed, not yet committed distillation (decision 4), author-only,
     expiring after 30 minutes.
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
   **Preview, then commit (security review on #856, finding 1).** Distillation takes two calls:
   - `POST /v1/conversations/:conversationId/distil/preview` runs the dispatch, runs the **output** guardrails
     (prompt-injection and jailbreak detectors, ADR-0042/0181) on the distilled text, and stores the result as a
     draft. It returns the text, the inputs it was derived from and a SHA-256 digest over the text, the checkpoint
     bounds and the input set. A guardrail hit is shown to the author and, in the default block mode, refuses the draft.
   - `POST /v1/conversations/:conversationId/distil` commits a draft by id and digest. It writes exactly the previewed
     text, so the author has read what is published. A mismatched digest, an expired draft, another user's draft, or a
     session with new turns past the draft's bounds is refused. The author cannot edit the text: an edited text is an
     ordinary contribution (`POST /v1/projects/:projectId/context`) and carries no distillation provenance.
5. **One governed dispatch.** The distiller is the session's agent (or one the author names), decided as the author by
   `agentDecision` with the `chat` feature of the model policy matrix. `executeGovernedDispatch` bills it to the
   session's project (pillar 5) and applies the governed core's optimisation (pillar 6). Re-distillation is
   cumulative: the previous distilled text plus the turns since, so earlier turns are never re-read. A PII-withheld,
   refused or empty output writes nothing.
   **PII and compliance tags never weaken on the way in (security review finding 3).** The PII mode applied to input
   and output is the **strictest** of the session's project and every input's project (the pillar 3 cascade, composed
   as `effectiveCompliancePolicy` composes profiles). A distillation is also refused when any input's project carries
   a compliance tag the target project does not carry, so regulated content is never republished under a weaker
   classification.
6. **A reader sees a distilled revision only while they could read what it came from**
   (`session-distillation-access.ts`).
   **Inputs come from recorded lineage, never from a caller's declaration (security review finding 2).** The server
   derives them from what the gateway itself recorded on the turns and on earlier distillations:
   - every agent whose output the turns carry: the session's agent, each assistant turn's recorded `servedAgentId`
     (written by the gateway, not the client), and the distiller. The reader's own current `agentDecision` must allow
     each one;
   - the previous distilled revision of the same session, when the distillation is cumulative, with its own inputs
     carried forward;
   - any shared-context revision the gateway recorded as supplied to a turn (none today: conversation turns are not
     supplied project context). The reader must be a member of its project (or an admin), and a distilled input is
     checked the same way.
   There is no request field for inputs. **Fail closed on unknown sources:** a session is refused for distillation when
   any turn in the window carries tool calls or tool results, connector or MCP output, attachments, or any `detail` key
   outside a closed allow-list of the dispatch facts the gateway writes today (stop reason, refusal, served agent,
   model, cost, credential source, denied, compaction and guardrail notes). The allow-list is a constant with a test;
   adding a source to it requires adding that source to the gating inputs in the same change. Reaching the recursion
   depth limit (4) **withholds** the revision; it never allows it.
   The author always reads their own revision; the bootstrap token reads none; a missing input fails closed. The check
   runs on every read of the store (decision 8). The project routes take the check by injection from app.ts
   (projects.ts cannot import it without a cycle) and withhold every distilled revision when none is injected.
7. **The arbiter.** A distilled revision that conflicts goes to the named arbiter only when the arbiter could read its
   inputs; otherwise the write is rolled back with `distillation_conflict_unreadable_by_arbiter` and the author distils
   again. The check runs again whenever the arbiter acts: the approvals inbox withholds the distilled text from an
   arbiter who no longer passes it, and the decision is refused (security review finding 5).
8. **Every reader of the store is enumerated and guarded (code review note 2).** The readers of
   `project_context_items` content today, and what each does with a distilled revision:
   - `GET /v1/projects/:projectId/context` (list and key history) and `…/context/graph`: filtered; a withheld head is
     listed as `{key, revision}`, never replaced by an older revision;
   - orchestration's supplied context (`resolveSuppliedContext`): filtered for the run's initiating user; absent when
     withheld, like an unknown key;
   - the approvals inbox (conflict rows, app.ts): filtered for the viewing arbiter (decision 7);
   - the provenance route (`…/context/items/:itemId/distillation`): 404 when withheld, the same as unknown;
   - privacy operations (`privacy-ops.ts`, admin erasure) and memory-retention counts: content is matched or counted for
     the erasure and retention jobs only, never returned to a reader;
   - lineage (ADR-0050): records item versions without content.
   A guard test fails when any module outside this list selects from `project_context_items`, so a new reader (an
   export, an evidence bundle, PM-tool sync, an MCP context resource, search) must be added here with its filter.
9. **Distilled text is data, never instruction, downstream (security review finding 1).** A distilled revision is
   never placed in a system prompt. Where context is supplied to a model (orchestration today), a distilled revision
   goes in a user-role, delimited data block labelled with its key, revision, source session and
   `distilled: untrusted session content`, and the worker's system prompt states that such blocks are data. Ordinary
   (human-written) revisions keep today's system-prompt supply; that path is unchanged by this ADR.
10. **Retention (code review note 1, security review finding 4).** A distilled revision follows the context store's
    retention, deliberately, as promote-to-shared does. It outlives the source conversation's retention (ADR-0185 I3),
    and the retention and incident checks on the source run only at distil time. A retention purge of the source
    session does not withdraw it; the FK-free provenance keeps naming the purged session. A data-subject erasure of
    the author does: the erasure job (privacy-ops) redacts the content of the author's distilled revisions, as it
    already does for matching context content, and records the redaction in the audit trail.

**Invariant (code review note 3).** The gating inputs are complete only for today's conversation model: user and
assistant turns with dispatch facts. Any change that lets a conversation turn carry another source (MCP tool output,
connector results, retrieved context, attachments) must, in the same change, record that source on the turn and add it
to the gating inputs of decision 6. Until it does, decision 6's fail-closed rule refuses such sessions.

**The parked slice predates this review.** `builder/e4-session-distillation` implements one-call distillation, takes a
caller-declared `contextInputItemIds` field and supplies distilled revisions through the existing system-prompt path.
On resume it must be changed to decisions 4 to 10 before its PR opens.

Open source first (ADR-0176): the store, its versioning, the governed dispatch and the entitlement kernel are ours and
already exist; the distillation is a prompt over them. Summarisation libraries (LangChain's `ConversationSummaryMemory`,
LlamaIndex's memory modules) were considered: each wraps its own model client, which would bypass the governed
dispatch, so none fits; nothing new is added to `THIRD_PARTY.md`.

## Threat model

| Threat | Control in this design |
|---|---|
| A member reads, through shared context, a model's output they are not entitled to (cross-team leakage through the author's entitlements) | Read check on every read path: the reader's own current `agentDecision` must allow every agent recorded for the revision (decision 6) |
| A session drew on another project's or team's private context, or on a connector or tool the reader may not use, and the distillation republishes it | Inputs come only from gateway-recorded lineage, never a caller's declaration; a session with tool, connector, attachment or unknown turn sources is refused; lineage inputs are checked recursively and the depth limit withholds (decision 6, invariant) |
| Stored, second-order prompt injection: instruction-shaped text in a session survives distillation and steers another member's agent | Output guardrails on the distilled text; the author previews and commits exactly that text by digest (decision 4); a distilled revision is supplied only as a labelled, untrusted user-role data block, never in a system prompt (decision 9) |
| Content from a stricter compliance or PII regime is republished under a laxer one | Strictest PII mode across the session's and every input's project; inputs whose project carries a tag the target lacks are refused (decision 5) |
| Someone distils another person's session (a conversation is personal) | Own-scoped loader: author only, admins included (decision 4) |
| Sharing is switched on quietly | Off by default; admin only; step-up to turn on; audited both ways (decision 3) |
| Content the governance layer refused, or PII, reaches a provider or the store | Denied turns are never sent; the project's PII cascade applies to input and output; a withheld output writes nothing (decision 5) |
| An unmetered or unattributed model call | One governed dispatch billed to the session's project (decision 5) |
| Deleting an agent, a project or the conversation silently widens who can read | Gating ids are FK-free evidence; a missing input fails closed (decisions 2 and 6) |
| A conflicting distilled revision shows its text to an arbiter who could not read its inputs | The write is refused unless the arbiter passes the same read check, and the check re-runs whenever the arbiter views or decides (decision 7) |
| A new read path forgets the check | Every reader is enumerated, a guard test fails on a new reader, and the project routes withhold every distilled revision when no check is injected (decision 8) |
| Prompt injection inside session turns steers the distiller itself | The distiller runs through the same input guardrails as any dispatch, and turns are labelled `[role]` (ADR-0181); what it produces is then handled as in the stored-injection row above |
| A distilled revision outlives the personal thread it came from | Deliberate: it follows context-store retention like promote-to-shared; the author's data-subject erasure redacts it (decision 10) |

## Owner questions (to build with the secure default)

- **Automatic distillation at session end** without the author's request. Default: never automatic; the author asks.
- **Admins reading distilled revisions** whose agents they are not entitled to. Default: admins take the same agent check
  as anyone (they keep the audit trail, which records ids and counts, not content). The security review confirmed
  this default.

## Row-level security (security review finding 6, code review note 4)

The new tables (`project_session_distillation_policies`, `project_context_distillations`,
`project_context_distillation_messages`, `project_context_distillation_agents`,
`project_context_distillation_context_inputs` and `project_context_distillation_drafts`) have no RLS, like
`project_context_items`. They join the RLS batch that covers `project_context_items` and are named on its list. The
build PR does not merge until that batch has landed or a tracked PENDING item names these tables.

## Consequences

- Teams get session memory in the same governed store, with provenance a reader can inspect
  (`GET /v1/projects/:projectId/context/items/:itemId/distillation`).
- Readers may see `withheld` markers: the honest signal that context exists they may not read.
- When built, five routes have no screen yet (the switch read and write, preview, commit and provenance); they become
  known UI gaps tracked on #453.

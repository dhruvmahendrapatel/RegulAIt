# ADR-0339: Agent risk score recomputed on every change, and author vs runner identity

- **Status**: Accepted (slice 1 built; slice 2 designed, built in the next PR of lane E20)
- **Date**: 2026-11-16
- **Driver**: owner, 2026-11-16: close the gaps found against Obsidian Security's AI Agent Security product. Builder
  lane E20 covers gap rows 3 (author vs runner, orphaned agents, NHI mapping) and 7 (risk score on every publish or
  modify, OWASP, blast radius, toxic combinations) of the Obsidian gap analysis (PR #879).
- **Extends**: [ADR-0214](0214-posture-estimate-and-ranked-actions.md) (explainable score, ranked counterfactual
  actions), [ADR-0180](0180-continuous-assurance-strict-by-default.md) (A3 required test classes, A8 autonomy class and
  floor evidence), [ADR-0243](0243-owasp-mcp-and-llm-2026-packs.md) (OWASP ids only, the 2026 edition),
  [ADR-0059](0059-policy-simulation-blast-radius.md) (blast radius), [ADR-0091](0091-sod-toxic-combinations.md)
  (toxic combinations), [ADR-0089](0089-agent-ownership-alignment.md) (owner and orphan flag),
  [ADR-0188](0188-batch6-agent-workload-identity.md) (agent principal, sponsors, actor chain),
  [ADR-0156](0156-ai-system-dependency-graph-risk-propagation.md) (dependents).
- **Migration**: slice 1 `pending/agent_risk_scores.sql` (numbered at merge, ADR-0252).
- **Setting**: none. The score changes no enforcement; it is read-only toward every agent, grant and setting.

## Context

ADR-0214 gives each agent a posture estimate ("how well is it governed", higher is better), computed on read. What is
missing is the attacker's view: how much can go wrong through this agent and how far it reaches, recomputed whenever
the agent changes, with every factor mapped to the OWASP Top 10 for LLM Applications and for Agentic Applications and a
ranked fix list. The facts already exist in the ledgers: the A8 floor evidence (guardrail modes, model-card sign-off,
fresh agentic red-team runs), the A8 autonomy facts (write tools without Ask-first, schedules, channels, sub-agents,
computer use), ownership (ADR-0089), grants and dependents, and the SoD rules (ADR-0091).

Two kinds of agent exist: registry agents (`agents`, including those imported from vendor registries by the import in PR
#855) and builder agents (`builder_agents`). Both are scored.

The second gap: for each agent, who built it, who runs it, which cloud service account or non-human identity it runs
as, and whether its owner is gone or inactive.

## Decision

### Slice 1: the score

1. **A pure, published rule set** in `packages/shared/src/agent-risk-score.ts` (`scoreAgentRisk`, method
   `adr0339-v1`). No ML. Same facts give the same assessment, byte for byte.
   - **Factors** (all listed, present or not, each with points, cap, evidence and OWASP ids): prompt-injection and
     jailbreak guardrail not blocking (off 8, log 6, warn 3); each agentic red-team class untested (4) or defeated (8);
     no approved model card (10); custom endpoint (4); served-model check relaxed (4); no active owner (unowned 10,
     orphaned 15). Builder agents also: no monthly limit (6); autonomy class (supervised 4, delegated 8, autonomous
     12); declared below observed (8); write tools without Ask-first (4 each, max 16); computer use (10); sub-agents (3
     each, max 9); inbound channels (5 each, max 10); schedules (2 each, max 6); unadmitted skills (4 each, max 8).
   - **Reach** (ADR-0059's blast radius for one agent): people who can use it plus things that depend on it (builder
     agents bound to it, use cases that intend it, agents that use it as a sub-agent). Bands 0-1, 2-10, 11-50, more
     than 50 give a multiplier of 1, 1.15, 1.3, 1.5.
   - **Toxic combinations**, added after the multiplier (15 each): an enabled ADR-0091 rule whose every side the
     agent's own capability set holds (the existing `checkSodFootprint`, with a holder that holds nothing, so only the
     bundle-internal case can match); and untrusted input (inbound channels or computer use) with data access
     (connector or MCP tools) and unconfirmed actions (write tools without Ask-first).
   - **Score** = min(100, round(min(100, factor points) x multiplier) + toxic points). Bands: low < 25, medium, high
     from 50, critical from 75.
   - **Fixes** ranked by the ADR-0214 counterfactual: the points the score drops by if that one item is fixed.
   - **OWASP ids only** (`owasp:llm:2026:NN`, `owasp:agentic:asiNN`, as the evaluator catalog cites them). No OWASP
     risk name is stored (ADR-0243 decision 2); names resolve through `owaspReferences()`. A test pins that every id
     resolves and that no name appears.
   - **Unmeasured is risk.** An untested class scores as untested, never as "no finding" (ADR-0180).
2. **Recomputed on every change, enforced by the database.** Triggers mark the agent in
   `agent_risk_recompute_requests` inside the change's own transaction: agents (insert, or an update of a risk-relevant
   column, which also marks the builder agents bound to it), builder agents (insert or update, not the spend lease),
   their tools, schedules, sub-agents, channels and skills, their shares, `agent_grants`, `role_agent_grants`,
   `role_assignments`, and a `config_versions` row for an agent artifact becoming active (`published`). A route added
   later is covered without remembering to call anything. The migration marks every existing agent (`backfill`).
3. **The sweep** (`agent-risk-recompute-sweep`, every 60 s, 50 agents a pass; `POST /v1/agent-risk/recompute` runs the
   same function) scores each marked agent and, in one transaction, appends an `agent_risk_assessments` row, writes
   its audit row (score, previous score, unchanged flag, triggers, top fixes) and deletes exactly the requests it read.
   A request re-marked while scoring keeps its newer timestamp (compared at microsecond precision) and is scored again.
4. **Evidence**: assessments are append-only (UPDATE and DELETE refused except the cascade of the row's own parent;
   TRUNCATE refused). The assessment jsonb is a commented point-in-time snapshot (ADR-0200 addendum).
5. **Routes** (API only; the screen is a KNOWN_UI_GAPS entry on #453):
   - `GET /v1/agent-risk/:kind/:subjectId`: the live score (recomputed on read, so changed evidence shows at once),
     the newest stored assessment and whether a recompute is pending. An admin or the agent's steward or owner;
     anyone else gets the 404 a missing agent gets. `private, no-store`.
   - `GET /v1/agent-risk/:kind/:subjectId/history`: the stored assessments, keyset-paged.
   - `GET /v1/agent-risk` (admin): agents ranked by their newest score, with the count not yet scored.
   - `POST /v1/agent-risk/recompute` (admin).

### Slice 2: author, runner, non-human identity, orphans (next PR)

6. **Author**: recorded at creation from the request principal, and for imported agents from the vendor record's
   pseudonymous creator (the import in PR #855). Existing agents are `unknown`, never a guessed author.
7. **Runner**: computed on read: the workload identity it runs as (ADR-0188), the people seen invoking it (usage
   ledger, observation window), and for builder agents the connection format (owner's connections or each caller's).
8. **Non-human identity links**: an agent is linked to cloud service accounts or vendor agent identities (AWS role
   ARN, Entra service principal, GCP service account, vendor agent id), staged by an importer or an admin. A staged
   link confers nothing; confirming one is an admin act with a step-up, audited in the same transaction. Read-only
   toward the vendor platform. Vendor-neutral: the provider is a closed vocabulary with `other`.
9. **Orphans**: the ADR-0089 flag gains `inactive` (owner has not signed in within a configurable window, strict
   default 90 days) beside `unowned` and `orphaned`; each is a finding and feeds the ownership factor above.

## Reuse and open source (ADR-0176)

- **Reused, not re-derived:** `loadFloorEvidence` and `loadAutonomyFacts` and the A8 derivation (autonomy.ts),
  `ownershipFlagFor` (inventory.ts), `checkSodFootprint` (sod.ts), `regulait_refuse_mutation` and
  `regulait_refuse_truncate` (append-only guards), `canonicalJson` (digest), the scheduler registry, the ADR-0214
  counterfactual and the evaluator catalog's OWASP refs. The per-asset posture score (and its screen, PR #831) is a
  different question and is not duplicated: it is not an input and its routes are untouched.
- **Open source:** none fits. This is RegulAIt's own policy semantics over its own schema (the CLAUDE.md exception);
  the arithmetic is sums and a band lookup, and the queue is one table drained by the existing scheduler (pg-boss is
  already in the tree, but a dirty-mark table written by triggers is what guarantees coverage of every write path).

## Consequences

- Every agent has a score and a history from the first sweep after the migration. A change of evidence that is not an
  agent change (a new red-team run, a guardrail policy edit) shows in the live score at once and in the stored history
  at the agent's next change.
- Every agent write now runs one small trigger; the update triggers fire only on risk-relevant columns.
- The weights are a published method version. Changing one means a new `methodVersion`, so old assessments keep their
  meaning.
- `imported` is in the trigger vocabulary for the vendor import (#855): once that merges, its import route marks the
  new agent `imported` (a follow-up fragment); until then an import is marked `created` by the agents trigger.

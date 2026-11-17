# ADR-0356: Work assigned from the PM tool: Jira and Azure Boards triggers start a governed workflow, and its progress is written back

- **Status**: Accepted (lane E37 brief, 2026-11-17: the confirmed direction; owner questions are listed at the end)
- **Date**: 2026-11-17
- **Index**: **A customer assigns work to RegulAIt from inside Jira or Azure Boards. Assigning an item to the RegulAIt agent user, @mentioning it, or a Jira Automation / Azure DevOps service-hook rule starts a pillar-2 workflow (Intake, then forced Plan, through the normal template assignment) as the person who triggered it, after the existing signed and replay-protected PM webhook verifies the delivery, an admin-managed identity link maps the person to a RegulAIt user, and that user's own agent entitlement allows it. A denied trigger gets a comment on the item saying why. Plan sign-off requests, decisions, approvals, PR links and the final outcome are written back as comments, status changes or linked records, each once (idempotent) and audited, with a configurable field mapping. Atlassian Rovo-agent and MCP audit events are ingested read-only as evidence.** Off by default per connection.
- **Backlog item**: `MARKET_ANALYSIS_2026-11` G4 (owner decision 2026-11-17, competitor gap audit)
- **Built in**: lane E37, three PRs (1: this ADR and the trigger path; 2: write-back; 3: Rovo and MCP audit-event ingest)
- **Migration**: `pending/pm_work_triggers.sql` (PR 1), `pending/pm_write_backs.sql` (PR 2), numbered at merge (ADR-0252)
- **Related**: [ADR-0010](0010-pm-inbound-sync-webhooks-plus-read-through.md) (inbound webhooks, S-03 replay amendment),
  [ADR-0054](0054-onboarding-migration.md) (onboarding), [ADR-0289](0289-pm-work-item-importer.md) (work-item importer, #828),
  [ADR-0061](0061-chatops-approvals.md) (the identity-link pattern reused here), ADR-0018/0019 (template assignment),
  [ADR-0176](0176-open-source-first.md), [ADR-0180](0180-continuous-assurance-strict-by-default.md), ADR-0200,
  [ADR-0234](0234-postgres-row-level-security.md) (row-level security), [ADR-0252](0252-merge-queue-and-merge-time-numbering.md)

## Context

Competitors (Cursor in Jira, Atlassian's own third-party coding agents in Jira Automation) let a team hand a work item to
an agent from inside the PM tool. RegulAIt already has every part of the path except the trigger itself:

- the PM adapters (`@regulait/pm-provider`, ADR-0010) for Jira, Azure DevOps, Linear, Asana, monday and a generic webhook,
  each with `addComment`, `transitionState`, `updateFields` and `getWorkItem`;
- the provider-native inbound webhook (`POST /v1/pm/webhooks/:connectionName`): URL token (Jira), basic auth (Azure
  DevOps) or HMAC (Linear, generic), a 24-hour secret-rotation overlap, and S-03's replay walls (the signed or in-body
  timestamp window and the `pm_webhook_deliveries` record);
- the importer (ADR-0289), which maps a connection's project onto an initiative and links its work items;
- the workflow engine's start path, where assignment rules pick the template from the change and the server-derived
  initiator roles and project classifications, and the template's forced Plan stage gates the build;
- the ChatOps identity link (ADR-0061): a chat identity is an assertion until an admin binds it to an existing user.

What is missing is a way to turn "this item was given to RegulAIt" into a workflow started by the right person, with
the right entitlements, without a shadow copy of the item.

### Open-source comparison (ADR-0176, owner rule 2026-11-17)

| Approach | Licence | Fit |
| --- | --- | --- |
| agent-swarm's Jira tracker integration | app, not a library | Same shape: URL-token webhook, DB-persisted delivery dedup, assignee-to-bot and @mention events, lifecycle comments posted back. Confirms the design; nothing to import. |
| Archestra's Jira trigger | NOASSERTION | Mention-only; maps the Jira account to a linked identity with a verified email and checks the person's access to the agent. The identity rule we take; the licence rules out reuse. |
| opencode's assignment trigger (#19926) | MIT, app code | Assignment to a configured bot user starts work; GitHub-only. |
| XState v5 for the trigger lifecycle | MIT, maintained | An actor runtime; our lifecycle is a database row moved by compare-and-set updates. A declared table plus a guarded update is smaller and is what the server enforces. Not adopted. |

None is a library that verifies Jira or Azure DevOps deliveries, maps their identities or drives a governed workflow, so
we extend our own adapters. The repository search found the pieces above to reuse; no parallel implementation is added.

## Decision

### 1. The trigger path (PR 1)

1. **One inbound route.** Triggers arrive on the existing `POST /v1/pm/webhooks/:connectionName`. Verification, the
   rotation overlap, the replay window and the delivery record are unchanged and run first, so a trigger is never read
   from an unverified or replayed delivery. A verified delivery that carries a trigger signal is recorded in
   `pm_webhook_deliveries` like any other event, even when the drift processing ignores it.
2. **Vendor-neutral signals.** `@regulait/pm-provider` gains `extractTriggerSignals(provider, …)`, exhaustive over the
   provider kinds, returning facts and never decisions: the item, the actor's PM identity, and whether the item was
   assigned to, mentioned, or sent by a rule. Jira and Azure DevOps are implemented; Linear, Asana, monday and the
   generic webhook return none today and follow by adding a case.
   - **Jira**: `jira:issue_updated` with a changelog `assignee` change to the agent account; `comment_created` /
     `comment_updated` whose body mentions the agent (`[~accountid:…]` in wiki markup, a `mention` node in ADF); an
     Automation "Send web request" with `webhookEvent: "regulait:trigger"` (URL token, in-body timestamp).
   - **Azure DevOps**: `workitem.updated` whose `System.AssignedTo` changes to the agent identity;
     `workitem.commented` whose `System.History` carries a `data-vss-mention` of the agent; a service-hook
     subscription pointed at `…?trigger=rule` (basic auth; the subscription's filter is the rule).
3. **Off by default, per connection.** `pm_trigger_settings` (one row per connection, admin-managed) holds `enabled`
   (default false), the agent's PM identity, which mechanisms are on, the RegulAIt agent the work runs on, and the
   change attributes the template assignment reads (change type, default `pm_work_item`; environment; target
   system). A connection without a row, or with `enabled = false`, ignores every signal and records nothing.
4. **Who triggered it.** The actor's PM identity becomes a RegulAIt user only through an admin-managed
   `pm_identity_links` row (one PM identity per user per connection, binding an existing enabled user, never minting
   one, with the ADR-0061 verification-source column). The PM actor is an assertion: an unlinked or disabled person is
   **denied**, and so is a person whose own agent decision (the same `evaluateAgent` call the invoke path uses, in
   `execute` mode, with grants, role grants, revocations and the tier ceiling) does not allow the configured agent.
   On a rule delivery the actor is the one the rule's body names (Jira: `{{initiator.accountId}}`), so it is as
   trustworthy as whoever can edit a rule holding the connection's webhook secret; an admin who does not want that
   turns the `rule` mechanism off. The agent's own actions (its write-back comments) never trigger it.
   The bot never becomes the actor and no admin authority is borrowed: the start runs as the mapped user, with that
   user's own `is_admin`, inside that user's row-level-security scope.
5. **The normal start.** An accepted trigger starts the workflow through the same function the
   `POST /v1/workflows/instances` route now calls (`startWorkflowForChange`, extracted, behaviour unchanged): the
   assignment rules choose the template from the change and the server-derived roles and classifications, so the
   Intake and forced Plan stages come from the template, not from this path. The change's description is the item's
   own text read through the adapter at start time (`getWorkItem`); RegulAIt stores no copy (pillar 8). The project the
   workflow bills to is the settings' `project_id` (optional), because an initiative can hold several projects.
6. **Linked, not copied.** The started instance is linked to the item through `pm_links` (`workflow_instance`), the
   same record a manual pm-sync writes, so the existing status mirror and drift processing apply.
7. **A declared lifecycle.** `pm_work_triggers` records each trigger with its state. The states and allowed transitions
   live in one exported table (`PM_TRIGGER_TRANSITIONS`), the server moves a row only with a compare-and-set update
   whose `WHERE` names the allowed source states, and a database check constrains the state column:

   | from | to |
   | --- | --- |
   | `received` | `accepted`, `denied`, `failed` |
   | `accepted` | `running`, `failed` |
   | `running` | `written_back`, `failed` |
   | `denied` | `written_back`, `failed` |
   | `written_back`, `failed` | (terminal) |

   `failed` records a trigger that could not be evaluated (an unexpected error), a start the engine refused (for
   example no assignment rule matches), an item that could not be read, or a denial comment that could not be posted; the reason is on the row and in the audit trail. One item has at most one open trigger
   (`received`, `accepted`, `running`): a second assignment while one is open is recorded as a duplicate and starts
   nothing.
8. **Denials are explained on the item.** A denied trigger posts one comment on the work item naming the reason in
   plain words (not linked, disabled, not entitled to the agent), with no internal ids and no secret material, then
   moves to `written_back`. Every transition writes an audit row (`pm_work_trigger`, rule ids `pm-trigger-*`).

### 2. Write-back (PR 2)

Plan sign-off requests, decisions, approvals, PR links and the final outcome are written back to the triggering item
as comments, status changes or linked records, through the adapter's `addComment` / `transitionState` /
`updateFields`. Each write-back has an idempotency key (the trigger, the event kind and the source record), recorded
before the call and released on failure, and an audit row. What is written where is the connection's existing
`PmMapping` extended with a `writeBack` section (configurable field mapping, validated by schema). The trigger moves to
`written_back` when the final outcome is written.

**As built (PR 2).** One reconcile, `syncPmWriteBacks(instanceId)` (`apps/gateway/src/pm-write-back.ts`), derives what
to write from the instance's stored state rather than from events: `started`, one `signoff_request` per stage and
round with a pending approval, one `approval` per decided approval (approved, denied, returned; an approved one uses
the connection's `PmMapping.approval` stage map, as the ADR-0010 sign-off mirror does), one `pr_link` per recorded
pull-request url, and one `outcome` at a terminal status, after which the trigger moves `running → written_back`. It
runs right after the trigger's start, from the workflow routes' transition hook and both approval decide paths, and
from the `pm-write-back-sweep` scheduler job (every 5 minutes), which catches transitions no route reports (an
executor's) and retries failures. The ledger is `pm_write_backs` (migration `pending/pm_write_backs.sql`): unique
(trigger, kind, source), inserted before the call and deleted when it fails. The ADR-0010 sign-off mirror skips an
instance a trigger started, so the item is told once. Decision records keep their existing §4 mirror (a linked
Decision work item, or a tagged comment), which already writes once per decision record and is audited. The
`writeBack` section of the trigger settings is the configurable mapping: per kind a comment (on by default) and an
optional state or, for the pull request, a field; no item state is moved unless an admin names one.

### 3. Rovo-agent and MCP audit events (PR 3)

Atlassian's organisation audit log carries Rovo-agent and Atlassian Remote MCP server activity. A read-only ingest
pulls those events through the existing governed fetch and stores them as third-party evidence in the audit trail,
never as decisions and never driving the state machine. No write scope is requested.

## Consequences

- A team can hand work to RegulAIt from Jira or Azure Boards without a second tool, and the work still runs as the
  person who handed it over, under that person's entitlements and the normal template assignment.
- Nothing new is trusted from the PM tool: the delivery is verified and replay-checked by the existing route, the
  actor is mapped only through an admin's link, and the item's content is read live, never stored.
- Two new admin-managed tables (`pm_trigger_settings`, `pm_identity_links`) and one record table
  (`pm_work_triggers`), all under row-level security on the ADR-0234 PM pattern. The routes are API only; the
  screens are known UI gaps on #453.
- Linear, Asana, monday and the generic webhook need only a signal extractor case to join.
- Follow-ups: a Jira Forge or Connect app that registers the webhooks for the customer; reading the agent user from the
  PM tool rather than configuring it.

## Owner questions (built with the secure default)

1. **Entitlement to trigger**: built as "the mapped user's own agent decision allows the configured agent in `execute`
   mode". An alternative is a dedicated "may trigger from the PM tool" grant. Owner question open.
2. **Unlinked people**: built as deny-and-comment. Auto-linking by a verified email (IdP or SCIM) is possible later.
   Owner question open.

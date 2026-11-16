# ADR-0317: RegulAIt is assignable from Jira and Azure Boards

- **Status**: Accepted (builder lane L6, gap G4 of the market analysis, 2026-11-15)
- **Date**: 2026-11-15
- **Index**: Assignable from Jira and Azure Boards: assign, @mention or a tool-side rule starts the pillar-2 workflow as the assigning user (default off)
- **Amends**: [ADR-0010](0010-pm-inbound-sync-webhooks-plus-read-through.md), which gains assignment signals on the
  normalized inbound event and Jira `X-Hub-Signature` verification.
- **Migration**: `pending/pm_assignment_trigger.sql` and `pending/rls_pm_assignment.sql` (numbered at merge).

## Context

The market analysis (PR #844, gap G4) found that teams expect to hand work to an agent where the work already lives:
assign the Jira issue or the Azure Boards work item to the agent, or @mention it, and the agent picks it up. RegulAIt
already has the governed pieces:

- the pillar-2 workflow (`startWorkflowInstanceWithTemplates`);
- the ADR-0010 inbound webhook, with its verification and replay walls;
- the `pm_links` linkage that mirrors approval decisions back to the item (`mirrorApprovalDecision`);
- decision records (`POST /v1/decisions`).

Nothing joined them: an inbound event was recorded, and drift was reported, but no inbound event could start work.

**Options considered:**

- **An Atlassian Forge app**, which would put a native "assign to RegulAIt" experience in Jira. Not built: its runtime
  and SDK licences are unchecked against ADR-0176, and it would add a second, hosted delivery path. **Owner question
  open: Forge app.**
- **The plain webhook path.** Every supported tool can already send it:
  - Jira webhooks;
  - Jira Automation "Send web request";
  - Azure DevOps service hooks.

  The receiver, verification and replay protection already exist. **Chosen.**

**Open-source check (ADR-0176).** No library maps a PM tool's assignment event to a governed workflow start; the
decision of who the work runs as, and under what entitlements, is RegulAIt's own governance surface. The parsers keep
using the adapters' existing fetch path, with no vendor SDK.

## Decision

1. **The signals are reported by the parser and decided by the gateway.** ADR-0010's normalized inbound event gains
   optional fields, all in the tool's own user identifiers:
   - `actor`: who made the change;
   - `assignee`: present only when this event set or changed the assignee;
   - `mentions`: who a comment @mentions;
   - `trigger: "automation"`: an explicit rule request;
   - `key`: the human item key, for write-back text.

   Where each comes from:
   - **Jira:**
     - `user.accountId` acts on issue events, and the comment author acts on comment events.
     - The assignee comes from a `changelog` item for `assignee`, or from a created issue that already has one.
     - Mentions come from wiki `[~accountid:…]` and ADF `mention` nodes.
     - A rule sends `webhookEvent: "regulait:assign"` (below).
   - **Azure DevOps:**
     - `revisedBy`, `System.ChangedBy` or `System.CreatedBy` is the actor.
     - The assignee comes from a `System.AssignedTo` change.
     - Mentions come from `data-vss-mention` anchors.
     - Identities are the lower-cased `uniqueName`.

   An unrelated update to an item that is already assigned to the agent carries no `assignee`, so it cannot start a
   second workflow.
2. **Off by default per connection** (ADR-0180). `pm_assignment_triggers` holds one row per connection:
   - `enabled`, default false;
   - `agent_ref`: RegulAIt's agent as the tool knows it (a Jira accountId, or an Azure DevOps uniqueName or identity
     id);
   - the change descriptor the workflow is matched on (`change_type`, `environment`, optional `target_system`);
   - an optional attributed `project_id`.

   Rules for changing it:
   - The routes are admin-only.
   - Turning the trigger on is a `settings_relax` step-up, audited as a relaxation.
   - Supported providers: `jira`, `azure_devops`, and the generic/mock contract (which carries the signals directly).
   - The shadow-AI remediation change type is refused, because it starts only from its own plan.
3. **As the assigning user, never more.**
   - **The actor is resolved through `pm_identity_links`.** This is an admin-managed, never self-asserted mapping of a
     PM user to a RegulAIt user, the ChatOps `chat_identity_links` model. Each side is unique per connection.
   - **These start nothing, and each is audited:** an unlinked actor, an actor linked to a disabled user, a delivery
     that names no actor, and the agent acting on itself.
   - **The template** is matched on that user's own roles and the project's classifications, through the same
     helpers the start route now uses (`changeWithServerFacts`, `matchedTemplateIds`, `withRequiredTemplates`).
   - **The start** runs with `isAdmin: false`, so no admin-only path is reachable. Project attribution is checked
     against the user's own membership.
4. **Once per work item.** `pm_assignment_starts` is unique on (connection, external id). Its claim is inserted in the
   start's transaction, so a concurrent or later assignment, mention or rule firing finds the claim and starts
   nothing new (audited `pm-assignment-already-started`). A refused start rolls the claim back, so a fixed rule or
   membership lets the next assignment start.
5. **Linked records and write-back.**
   - The started instance is linked to the **existing** item through a `pm_links` row (`objectType`
     `workflow_instance`). Approval decisions therefore mirror back through `mirrorApprovalDecision`, and decision
     records through `POST /v1/decisions`, unchanged.
   - The start itself is written back as a comment on the item, as the mapped user, through the governed PM write
     (`providerFor` → `runExternalWrite`).
   - If the write-back fails, that is audited (`pm-assignment-writeback-failed`) and the instance keeps running.
6. **The single audit trail.** Every outcome is one row. The trigger change and identity-link changes are audited
   too.

   | Outcome | Effect |
   |---|---|
   | `pm-assignment-started` | allow, on the workflow, as the user |
   | `pm-assignment-disabled` | deny |
   | `pm-assignment-no-actor` | deny |
   | `pm-assignment-self` | deny |
   | `pm-assignment-unmapped-actor` | deny |
   | `pm-assignment-already-started` | deny |
   | `pm-assignment-no-workflow` | deny |
   | `pm-assignment-refused` | deny |

7. **Verification and replay** are ADR-0010's:
   - Jira: the URL token, or now `X-Hub-Signature: sha256=<HMAC of the raw body>` for webhooks registered through the
     REST API with a secret. A presented signature must verify and is never ignored.
   - Azure DevOps: service-hook basic auth.
   - Every delivery: the in-body creation time (7 days at most), and the per-connection delivery record.
8. **Wiring without a new import cycle.** `pm.ts` takes an `onInboundEvent` hook that `app.ts` connects to
   pm-assignment's handler. pm-assignment reaches `workflows.ts`, which reaches back to `pm.ts`, so `pm.ts` must not
   import it.

**The Jira Automation rule.** Use "Send web request" to the connection's webhook URL (with `?token=`), method POST,
and this custom body:

```json
{"webhookEvent":"regulait:assign","timestamp":{{now.asMillis}},
 "user":{"accountId":"{{initiator.accountId}}"},
 "issue":{"id":"{{issue.id}}","key":"{{issue.key}}","fields":{"summary":"{{issue.summary}}"}}}
```

**New routes** (admin; `internal`; screen requested on #453, `KNOWN_UI_GAPS` +5, raised for the master's review):

- `GET` / `PUT /v1/pm/connections/:name/assignment-trigger`
- `GET` / `POST /v1/pm/connections/:name/identity-links`
- `DELETE /v1/pm/connections/:name/identity-links/:linkId`

## Consequences

- An admin can turn a Jira or Azure Boards assignment into a governed, audited workflow started as the person who
  assigned it, and see approvals land back on the item.
- Azure Boards is the pilot path (owner, 2026-11-15). The tests cover every Boards step against a fake Azure DevOps
  server:
  - an `AssignedTo` change and a comment @mention each start the workflow as the linked user;
  - the start is commented on the work item;
  - the sign-off decision is written back as a comment on it.

  Jira is covered the same way, plus the Automation rule. Live tenants are owner-gated.

**Known limits:**

- **One workflow per item, ever.** Re-assigning a finished item starts nothing, and the audit row names the earlier
  instance. Owner question open: whether a finished instance should release the claim.
- **Row-level security** (`pending/rls_pm_assignment.sql`, the ADR-0234 PM batch). All three tables are forced, and
  an admin (or the bootstrap token) reaches them through `regulait_rls_is_admin()`.
  - The PM webhook's reason, `approval_maintenance`, reads the trigger and the identity links, and claims and updates
    the start.
  - Only an admin or a migration writes the configuration.
  - A non-admin principal and `pm_sync` reach none of them (`zz-adr0234-rls-pm.test.ts`).
- **Atlassian audit events as evidence are not ingested in this slice.** The organisation audit-log API needs an
  Atlassian Guard/admin API key and a pull client, which is a separate slice over the ADR-0261 third-party-ingest
  path. Owner question open: Atlassian Guard availability.

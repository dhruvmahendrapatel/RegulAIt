# ADR-0338: Governed control of agents inside low-code vendor platforms (disable, quarantine, restore)

- **Status**: Proposed (builder lane E19; the master accepts it on merge)
- **Date**: 2026-11-16
- **Index**: Governed vendor agent control (disable, quarantine or restore an agent in Copilot Studio, Agentforce, OpenAI or n8n through the vendor admin API; off by default, step-up, second-person approval, payload-bound, single-use, audited)
- **Builds on**: the vendor agent registry import of PR #855 (the `agent_registry` family, `agent_registry_records`, the
  `Scanner` adapter shape), lane E17's decision record on PR #880 (the `AgentPlatformAdapter` with its `governedActions`
  declarations, and the `platform_write` credential rule, which this ADR implements), the governed add-on removal of PR #871 (evidence-bound targets, off by default, audited in the same
  transaction), ADR-0104 (payload-bound approvals), ADR-0124 (the kill switch and `runExternalWrite`), ADR-0195
  (discovery credentials, the guarded fetch; decision 7, read-only discovery), ADR-0159 (remediation proposals: a
  second person approves an admin action), ADR-0180 (secure by default), ADR-0176 (open source first), ADR-0252
  (merge-time numbering).
- **Migration**: `pending/vendor_agent_control.sql`, numbered at merge (ADR-0252)

## Context

The owner asked on 2026-11-16 to close the gaps found against Obsidian Security's AI agent security product
(`internal/product/GAP_ANALYSIS_OBSIDIAN_2026-11.md`, gap 3: "in-platform control for low-code builders"). Once lane
E17 imports agents from Copilot Studio, Salesforce Agentforce, OpenAI and n8n, an admin can see such an
agent but cannot stop it: it never calls the gateway or an endpoint hook, so ADR-0251's decision core never sees it.

Each vendor has an admin API that can take an agent out of service. Read on 2026-11-16 (live tenants are owner-gated,
so every adapter is tested against fixtures):

| Vendor | Take out of service | Put back | Read state | Notes |
|---|---|---|---|---|
| Copilot Studio | `POST api.powerplatform.com/copilotstudio/environments/{env}/bots/{bot}/api/botQuarantine/SetAsQuarantined?api-version=1` | `…/SetAsUnquarantined?api-version=1` | `GET …/api/botQuarantine?api-version=1` (`isBotQuarantined`, `lastUpdateTimeUtc`) | Needs `CopilotStudio.AdminActions.Invoke`. Classic chatbots answer `405`. Makers can still test a quarantined agent; no other channel reaches it. |
| Salesforce Agentforce | deactivate the agent's active `BotVersion` | reactivate the same version | read the `BotVersion` status | The path lane E17 records. Verified in slice 2. |
| OpenAI (ChatGPT custom GPTs) | none reversible | none | the Compliance API listing | The only documented control is GPT removal through the Compliance API, which cannot be undone. OpenAI therefore declares no action (section 1). Re-checked in slice 2. |
| n8n | `POST /api/v1/workflows/{id}/deactivate` | `POST /api/v1/workflows/{id}/activate` | `GET /api/v1/workflows/{id}` (`active`) | API key with only the workflow activate and deactivate scopes where the edition supports scopes. Verified in slice 2. |

Delete is never offered for any vendor: it cannot be reversed.

## Decision

### 1. Three actions, and only those

`disable`, `quarantine` and `restore`. An adapter offers `disable` or `quarantine` only when its `governedActions`
(lane E17) declares that action **and** marks it `reversible`: an irreversible vendor action (OpenAI GPT removal,
any delete) is never offered. `restore` is always the inverse of an action that was applied, never a free choice: it
names the earlier, succeeded action it reverses, and the adapter calls that action's inverse (`unquarantine` for
`quarantine`, re-activation for `disable`). Copilot Studio offers `quarantine` only, because quarantine is the
vendor's only documented reversible control.

Nothing starts an action automatically. No finding, detection, rule, schedule or model creates one: every action is
requested by an admin, approved by a second person and executed by the requester.

### 2. Off by default, at three levels

- **Org switch.** `discovery_settings.vendor_agent_control_enabled` is false. Turning it on is a `settings_relax`
  step-up (`DISCOVERY_STEP_UP_KEYS.vendorAgentControl`) through the existing `PUT /v1/discovery/settings`, audited in
  the same transaction. Turning it off is free and stops every action that has not yet executed.
- **A control credential per source.** Discovery credentials stay read-only (ADR-0195 decision 7 is unchanged: a
  read credential that can write is still refused). Control uses a separate write credential, the `platform_write` purpose that
  lane E17 fixes, held in its own table `vendor_control_credentials` (the purpose is the table, not a field), one per
  discovery source, stored exactly as discovery credentials are: encrypted with the data key
  (`encryptSecret`), never returned, never in code, federated by default (Entra workload identity for Copilot Studio)
  with a stored secret only as a `settings_relax` step-up, rotatable by replacing the row, revocable at once. Its
  scope is the vendor's narrowest control permission (the `vendorPermission` the adapter declares) and nothing
  else. The read credential is never used to write, and the write credential is never used to read the inventory.
  Adding one is itself a `settings_relax`
  step-up and audited. With no live control credential, a source offers no action.
- **The vendor action itself.** An adapter that does not declare an action cannot be asked for it.

### 3. The adapter: one per vendor, read and control together

Lane E17's `AgentPlatformAdapter` already declares, per vendor, `governedActions: GovernedActionSpec[]` (action,
`reversible`, `vendorPermission`) and ships no write code. This ADR adds the executing half as one optional member of
that same adapter, `control`. There is no second adapter per vendor, and a declaration without a `control` member, or
a `control` member for an undeclared action, fails the adapter-list test:

```ts
interface VendorAgentControl {
  readonly actions: readonly ("disable" | "quarantine")[];
  /** Read the agent's current service state. A GET (or the vendor's documented read). */
  readState(ctx: ControlContext, ref: VendorAgentRef): Promise<VendorAgentState>;
  /** Apply one action or its inverse. Must be idempotent at the vendor: applying it twice is one effect. */
  apply(ctx: ControlContext, ref: VendorAgentRef, op: ControlOp): Promise<ControlResult>;
}
// ControlOp = { action: "disable" | "quarantine"; direction: "apply" | "reverse" }
// VendorAgentState = { state: "active" | "disabled" | "quarantined" | "unknown"; observedAt?: string }
// ControlResult = { outcome: "applied" | "already_in_state" | "refused" | "failed"; code: string; httpStatus?: number }
```

- The action names follow E17's declarations: `ControlOp` `{action: "quarantine", direction: "reverse"}` is the
  declared `unquarantine`. `restore` exists only at the API, so a reviewer reads one verb for "put it back".
- `ControlContext` carries the guarded fetch (`createGuardedFetch` with the tenant's egress allow-list, as the
  discovery worker builds it), a deadline signal and the control token. Every vendor call goes through it; an adapter
  holds no fetch of its own.
- `VendorAgentRef` comes only from an `agent_registry_records` row (source, registry, vendor id, and the vendor
  locator fields such as the Power Platform environment id). An admin cannot type a vendor id: an agent the
  discovery read has not seen cannot be targeted, the same evidence rule as the governed add-on removal of PR #871.
- Vendor response bodies are bounded, parsed as closed shapes and never stored verbatim. Tokens are scrubbed from every
  error before it is logged or audited.

### 3a. Copilot Studio: the constraint lane E17 left to this ADR

Microsoft documents `SetAsQuarantined` and `SetAsUnquarantined` with a delegated token from a user who holds the AI,
Power Platform or Global administrator role, consented for `CopilotStudio.AdminActions.Invoke`. Lane E17 records this
as an open constraint, because ADR-0195's credential model refuses a stored user refresh token. Separately, the Power
Platform API's authentication page documents service principals with an RBAC role, though not for these two calls
specifically.

Decision:

- **No delegated user credential is stored.** A refresh token for an admin user is a standing, broad, human credential.
  It is not built, and adding it would be its own decision (owner question 1).
- **The write credential is a federated service principal** (Entra workload identity, no stored secret by default)
  with the narrowest Power Platform RBAC role an admin assigns, and the Copilot Studio adapter calls the documented
  quarantine endpoints with it.
- **Whether those calls accept an app-only token is unverified** until a live tenant is tried, which is owner-gated.
  The source's control credential therefore carries `scope: unverified`, as lane E17 does for keys it cannot prove, and
  every action on it is audited as such.
- **A vendor `401` or `403`** ends the action `failed / vendor_refused_credential` and changes nothing. There is no
  retry and no fallback to another credential.
- **The Dataverse `bot.statecode` (Inactive) is not used as a disable.** Writing it is app-only, but Microsoft does
  not document that it takes an agent out of service, and this ADR does not claim a control the vendor does not
  document.

### 4. The flow: request, approve, execute

This reuses the approvals queue's re-submit-and-consume pattern (`holdOffensiveBuiltinRun`, ADR-0104), so the vendor
call never runs inside a database transaction, and ADR-0159's rule that the proposer cannot approve.

1. **Request.** `POST /v1/vendor-agent-control/actions` (admin) with the record id, the action (or `restore` plus the
   action it reverses) and a reason (at most 500 characters). It needs a `settings_relax` step-up bound to
   `{op: "vendor_agent_control", recordId, action, reverses?}`. One transaction writes the action row
   (`requested`), a pending `approvals` row of the new object type `vendor_agent_control`, and an audit row. The
   approval's digest is `approvalArgumentsDigest` over `{recordId, sourceId, registry, vendorId, action, reverses}`,
   and its preview is `approvalArgumentsPreview` of the same, so the approver reads what will run.
   - **Idempotent.** A repeat of the same request while one is open returns that action (200, `idempotent: true`); a
     different open action for the same agent is `409 action_already_open`.
2. **Approve.** Through the existing `POST /v1/approvals/:id/decide`. A per-kind precheck refuses the requester
   (`cannot_approve_own_vendor_action`), so a second person must decide. A denial closes the action.
3. **Execute.** `POST /v1/vendor-agent-control/actions/:id/execute` by the requester, with a fresh `settings_relax`
   step-up bound to the same facts plus the action id. The server re-reads every input and refuses if anything
   moved: the switch is off, the control credential was revoked or replaced, the record is gone or absent, or the
   recomputed digest differs from the approved one (`approval_payload_mismatch`). It consumes the approval with the
   conditional `approved → consumed` update, so an approval executes at most once, then:
   - reads the vendor state (`readState`) and records it as the action's `prior_state`;
   - calls `apply` through `runExternalWrite` with the new operation `vendor_agent_control`, so the kill switch
     (ADR-0124) is re-read at the moment of the call and a non-`normal` dial refuses it;
   - reads the state again and records `observed_state`;
   - writes the outcome and its audit row in one transaction.

   A vendor timeout leaves the action `unknown`; the next execute (the approval is already consumed, so only the
   requester, with a fresh step-up) re-reads the state and settles it without a second approval, because `apply` is
   idempotent at the vendor. It never re-applies a different action.
4. **Cancel.** `POST …/actions/:id/cancel` before execution, by the requester or an admin, audited. It narrows, so it
   needs no step-up. The pending approval is superseded.

Read routes: `GET /v1/vendor-agent-control/actions` (keyset-paginated, at most 200) and `GET …/actions/:id`.

### 5. States and audit

An action is `requested → approved → executing → succeeded | already_in_state | failed | unknown`, or `denied` or
`cancelled`. Every transition writes one audit row in the same transaction as the state change, with fixed fields
only: action id, record id, source, registry, vendor id, action, reverses, prior and observed state, outcome code and
HTTP status. No vendor body, token or free text from the vendor reaches the audit trail.

### 6. Reversibility

`restore` is allowed only for an action that `succeeded` (or found the agent `already_in_state`) and has not been
restored. It goes through the same request, approve and execute flow: putting an agent back into service widens
access, so it is never cheaper than taking it out.

### 7. The kill switch

Every vendor call is an external write under `runExternalWrite`. While the dial is `read_only`, `halt` or
`require_approval`, executions are refused with the existing `execution_*` codes, including disable and quarantine.
Allowing narrowing vendor actions during a halt is an owner question (below); until it is answered, the existing
barrier applies unchanged.

### 8. Open-source search (ADR-0176)

- **Repo first.** The approvals queue, payload digest and preview (ADR-0104), the settings step-up, the discovery
  switch and credential storage (ADR-0195), the guarded fetch, `runExternalWrite` (ADR-0124) and the registry adapter
  (PR #855 and lane E17) are all reused; this ADR adds one adapter member, one object type, one external-write
  operation, two tables and five routes.
- **Microsoft.** `Microsoft.PowerPlatform.Management` is a .NET SDK; there is no maintained JavaScript Power Platform
  API client. The three calls are REST calls through the guarded fetch. The Entra token comes from `@azure/identity`,
  already used by discovery.
- **Salesforce, n8n, OpenAI.** Chosen in slice 2, with the same rule: an existing pinned client only when it signs or
  does something we must not hand-write; otherwise REST through the guarded fetch.

## Not in this slice

- Slice 1: this ADR, the framework (switch, control credentials, actions, routes, approval kind, external-write
  operation) and the Copilot Studio adapter's `control` member. Slice 2: Agentforce, OpenAI and n8n.
- Admin screens: the routes are API-only, listed in `KNOWN_UI_GAPS` against #453.
- Bulk actions: one agent per action.

## Owner questions (open; the secure default is built meanwhile)

1. **Copilot Studio credential (section 3a).** If a live tenant shows that the quarantine calls refuse app-only
   tokens, should RegulAIt store a delegated refresh token for a dedicated, least-privilege admin user? Built: no; a
   federated service principal only, marked `scope: unverified`.
2. **Narrowing during a halt.** Should disable and quarantine run while the kill switch is `halt` or `read_only`?
   Built: no (section 7).

## Consequences

- An org can take a vendor-hosted agent out of service without leaving RegulAIt, with two people, an MFA step-up on
  each consequential step, the exact payload approved, one execution per approval and a full audit trail.
- The read path stays provably read-only: control uses a different credential with a different scope.
- Until E17's adapters exist for a vendor, that vendor offers no action.

## Numbering

ADR 0338 is the number reserved for builder lane E19.

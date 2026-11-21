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
  read credential that can write is still refused). Control uses a separate write credential, the `platform_write`
  purpose that lane E17 fixes. It lives in the existing `discovery_credentials` table, not a second credential table,
  so storage, encryption, revoke and replace stay one set of helpers:
  - **One new column, `purpose`.** `text NOT NULL DEFAULT 'discovery_read'`, with a CHECK of
    `purpose IN ('discovery_read', 'platform_write')`. It is set at insert and never updated (no route changes it, and
    an update trigger refuses a change), so the purpose is a fixed rule of the row, as lane E17 asks, not a mutable
    field. Every existing row is `discovery_read` and behaves exactly as today.
  - **One live credential per source and purpose.** The live-unique index `discovery_credentials_live_uq` becomes
    `(source_id, purpose) WHERE revoked_at IS NULL`, so a source holds at most one read and one control credential.
  - **The purposes never cross.** The discovery scanner's credential loader selects only `purpose = 'discovery_read'`,
    and the control path's loader selects only `purpose = 'platform_write'`. A test pins both filters, so a control
    credential can never reach a scan and a read credential can never reach `apply`.
  - **`write_scope` keeps ADR-0195's meaning for read credentials.** For a `platform_write` row a CHECK fixes
    `write_scope = 'unverified'`: the scanner's read-only verification never runs on it, and its control scope is
    reported as unverified until a live tenant proves it (section 3a).
  - **Stored as discovery credentials are:** encrypted with the data key (`encryptSecret`), never returned, never in
    code, federated by default (Entra workload identity for Copilot Studio) with a stored secret only as a
    `settings_relax` step-up, rotatable by replacing the row, revocable at once.

  Its scope is the vendor's narrowest control permission (the `vendorPermission` the adapter declares) and nothing
  else. The read credential is never used to write, and the write credential is never used to read the inventory.
  Adding one is itself a `settings_relax` step-up and audited. With no live control credential, a source offers no
  action.
- **The vendor action itself.** An adapter that does not declare an action cannot be asked for it.

### 3. The adapter: one per vendor, read and control together

Lane E17's `AgentPlatformAdapter` already declares, per vendor, `governedActions: GovernedActionSpec[]` (action,
`reversible`, `vendorPermission`) and ships no write code. This ADR adds the executing half as one optional member of
that same adapter, `control`. There is no second adapter per vendor, and a declaration without a `control` member, or
a `control` member for an undeclared action, fails the adapter-list test:

```ts
interface VendorAgentControl {
  readonly actions: readonly ("disable" | "quarantine")[];
  /** Credential modes the vendor accepts for control; "delegated" only where documented (section 3a). */
  readonly acceptedModes: readonly ("federated" | "static" | "delegated")[];
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

Decision (owner decision 1, 2026-11-17: delegated credentials are allowed by admin opt-in; app-only stays preferred):

- **The preferred write credential is a federated service principal** (Entra workload identity, no stored secret by default)
  with the narrowest Power Platform RBAC role an admin assigns, and the Copilot Studio adapter calls the documented
  quarantine endpoints with it.
- **Whether those calls accept an app-only token is unverified** until a live tenant is tried, which is owner-gated.
  The source's control credential therefore carries `scope: unverified`, as lane E17 does for keys it cannot prove, and
  every action on it is audited as such.
- **A delegated credential is allowed, off by default, by admin opt-in.** For a tenant where the quarantine calls
  refuse an app-only token, an admin may connect a delegated credential for one named admin account:
  - **Off by default.** `discovery_settings.vendor_agent_control_delegated_enabled` is false. Turning it on is a
    `settings_relax` step-up, audited; turning it off is free and makes every delegated control credential unusable at
    once (each is refused `credential_mode_disabled`, and the posture page lists it for revocation).
  - **Only where the adapter declares it.** The adapter's `control` member lists the credential modes the vendor
    accepts (`acceptedModes`). Only Copilot Studio lists `delegated` in slice 1. A delegated credential for any other
    adapter is refused `credential_mode_not_accepted`.
  - **Connecting is a step-up and audited.** An admin connects it through the vendor's OAuth authorization-code flow
    with PKCE (`@azure/msal-node`, MIT, pinned, the same Entra library family as `@azure/identity`), signed in as the
    named account and consented for `CopilotStudio.AdminActions.Invoke` only. The connect route needs a
    `settings_relax` step-up bound to `{op: "vendor_control_delegated", sourceId, account}` and writes an audit row
    with the account's object id and UPN.
  - **The same storage.** The credential is a `discovery_credentials` row with `purpose = 'platform_write'` and the new
    `credential_mode` value `delegated`, a CHECK allowing `delegated` only with that purpose. The refresh token is in
    `secret_ciphertext` (encrypted with the data key, never returned, server side only). Each token refresh replaces
    the stored refresh token in the same row, so it rotates on use. The named account's object id and UPN are in
    `public_config`.
  - **A mandatory expiry.** A new nullable column `expires_at`, with a CHECK that a `delegated` row has one. The admin
    chooses it, at most 90 days ahead (30 by default). After it, the credential is refused `credential_expired` and
    the admin must connect again, with a fresh step-up.
  - **Revocable at once.** Revoke destroys the ciphertext (the existing revoke check) and is audited. Every action on
    a delegated credential is audited with its mode and account, so the trail shows whose authority acted.
  - **App-only stays preferred.** One live control credential per source (section 2) means the admin chooses one mode.
    The posture page shows a delegated control credential as a finding, recommending a federated service principal
    wherever the vendor accepts one.
- **A vendor `401` or `403`** ends the action `failed / vendor_refused_credential` and changes nothing. There is no
  retry and no fallback to another credential or mode.
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
2. **Approve.** Through the existing `POST /v1/approvals/:id/decide`, with two per-kind rules for
   `vendor_agent_control`:
   - **Who may decide.** The eligible pool is resolved by the existing ADR-0186 pool guard (`loadApprovalPool`): the
     members of the approver role named by an `approval_rules` row for this object type, or, with no such rule, the
     org's active admins. The requester is never eligible (`cannot_approve_own_vendor_action`), a delegation
     component counts once, and the quorum (1 by default, at most 5) is snapshotted on the approval at queue time. A
     decider outside the pool gets `403 not_an_eligible_approver`.
   - **A fresh step-up for every decision.** Approve and deny both need an `approval_decide` step-up grant (ADR-0186:
     single use, session-bound, MFA by passkey, TOTP or fresh SSO) bound to `{approvalId, decision, argumentsDigest}`.
     The generic decide path does not step up today for kinds other than tool calls, so slice 1 adds the check to the
     per-kind precheck for this object type; a decision without it gets `403 step_up_required`. An API key, chat tap
     or bulk decide cannot decide this kind, because none of them can step up.

   A denial closes the action. Slice 1 tests: a decider outside the pool, the requester, a decision with no step-up
   and one whose step-up is bound to a different digest are each refused, and nothing moves.
   - **Expiry.** The approval carries `expires_at` = queued time + the approval window, 24 hours by default
     (`discovery_settings.vendor_agent_control_approval_ttl_hours`, 1 to 72). Shortening it is free; lengthening it
     past 24 hours is a `settings_relax` step-up, audited. An action whose approval expired before it was decided
     moves `requested → cancelled`, and one approved but not executed in time moves `approved → cancelled`, both with
     reason `approval_expired`, through the machine's `next`. The move is written when the action is next touched
     (execute, cancel, a read or a new request for the same agent), so an expired action never blocks a new request
     and is never executed. Nothing runs on a timer to do it.
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

   A vendor timeout leaves the action `unknown`; a later settle (the approval is already consumed, so no new
   approval; see "Who may settle" below) re-reads the state and settles it without a second approval, because `apply` is
   idempotent at the vendor. It never re-applies a different action.

   **A crashed execution is recovered, never stuck.** The `approved → executing` update stamps `lease_expires_at` =
   now + the vendor deadline + 60 seconds of margin (the deadline is the `ControlContext` signal, 30 seconds by
   default). If the gateway or worker dies before the outcome commits, the row stays `executing` with a lease in the
   past. Any later execute, cancel or read of that action, or a new request for the same agent, first moves it
   `executing → unknown` (code `lease_expired`) through the machine's `next`, with an update conditional on
   `status = 'executing' AND lease_expires_at < now()`, so a live execution is never taken over. The `unknown` row is
   then settled as above: by `readState` only, never a second `apply`.
   - **Settling.** If the vendor shows the target state, the action becomes `succeeded`. If it shows the prior state,
     it becomes `failed` (code `not_applied`), and the requester may ask again through a new request and a new
     approval. If the state cannot be read, the row stays `unknown` and still counts as open, because the vendor
     state is uncertain.
   - **Who may settle.** The requester or any admin, with a `settings_relax` step-up bound to the action id. Settling
     only reads the vendor, so it needs no approval, and an agent is never left unactionable because the requester
     is gone.
   - Slice 1 tests a crash between `executing` and the outcome commit (the lease expires, the row moves to `unknown`
     and is settled by a read) and a live lease that is not taken over.
4. **Cancel.** `POST …/actions/:id/cancel` before execution, by the requester or an admin, audited. It narrows, so it
   needs no step-up. The pending approval is superseded.

Read routes: `GET /v1/vendor-agent-control/actions` (keyset-paginated, at most 200) and `GET …/actions/:id`.

### 5. States and audit

The states and their allowed transitions are one machine, `VENDOR_ACTION_MACHINE` in `@regulait/shared`, declared
with ADR-0348's shared `defineMachine` (`packages/shared/src/state-machine.ts`). No second helper is written. Every route
moves an action through `next(from, event)`, with no scattered if/else. The database write is a conditional
`UPDATE … WHERE status IN (sourcesOf(event))`, so two racing requests cannot both move an action, and `describe(state)`
gives the UI and agents the allowed next steps.

| From | Allowed to |
|---|---|
| `requested` | `approved`, `denied`, `cancelled` (by the requester or an admin, or `approval_expired`) |
| `approved` | `executing` (guard `killSwitchNarrowingOnly`, section 7), `cancelled` (by the requester or an admin, or `approval_expired`) |
| `executing` | `succeeded`, `already_in_state`, `failed`, `unknown` (a vendor timeout, or `lease_expired` after a crash) |
| `unknown` | `succeeded`, `already_in_state`, `failed` (settled by a state re-read, never a second `apply`) |
| `succeeded`, `already_in_state`, `failed`, `denied`, `cancelled` | none (terminal) |

**Generic and exported, so other lanes import it rather than copy it.**
- The machine helper is ADR-0348's `defineMachine`, which every lane already shares.
- The kill-switch guard is new and generic: `killSwitchNarrowingOnly({ dial, direction })`, exported from
  `@regulait/shared` next to the machine helpers. It is a pure function that returns `null` (allowed) or a refusal
  reason. It allows `narrowing` under any dial and `widening` only under `normal`, and it has no vendor or action
  names in it.
- `defineMachine` has no guard field. The guard therefore runs before `next(approved, "execute")`, and its reason is
  passed as `describe(state, { execute: reason })`, so the UI and agents show the same refusal the server gives.
- Lane E15's device-quarantine response rules can declare their own machine with `defineMachine` and reuse the guard
  unchanged.
- The guard's tests cover both directions under every dial. The vendor machine's tests cover a disallowed event and
  the terminal states.

A restore is a new action row, so terminal rows stay terminal. This lane refactors no other machine.

Every transition writes one audit row in the same transaction as the state change, with fixed fields
only: action id, record id, source, registry, vendor id, action, reverses, prior and observed state, outcome code and
HTTP status. No vendor body, token or free text from the vendor reaches the audit trail.

### 6. Reversibility

`restore` is allowed only for an action that `succeeded` (or found the agent `already_in_state`) and has not been
restored. It goes through the same request, approve and execute flow: putting an agent back into service widens
access, so it is never cheaper than taking it out.

### 7. The kill switch: narrowing only (owner decision 2, 2026-11-17)

Every vendor call is an external write under `runExternalWrite`. While the dial is `read_only`, `halt` or
`require_approval`, a **narrowing** action still runs and a **widening** one does not:

- **Narrowing:** `disable` and `quarantine` (direction `apply`). They take an agent out of service, which is what a
  halt is for. They still need the full request, approval and step-up flow; the halt removes no check.
- **Widening:** `restore` (direction `reverse`), and any action a future adapter adds that puts an agent back into
  service. It is refused at execute with the existing `execution_*` code for the dial, and the row stays `approved`
  until the halt lifts or the approval expires. A settle (a state read only) is allowed under any dial.

The rule is a guard on the transition, not a separate check. The `execute` event (`approved → executing`) of
`VENDOR_ACTION_MACHINE` is taken only after `killSwitchNarrowingOnly({ dial, direction })` (section 5) returns no
refusal. The guard's reason is the one `describe` reports. `runExternalWrite` gains one declared exemption, for the
`vendor_agent_control` operation with direction `apply` only, and the external-effects barrier test gets the matching
row, so no other operation can pass a halt. The dial is re-read at the moment of the call, as today. Slice 1 tests both
directions under each non-`normal` dial: a quarantine and a disable execute, and a restore is refused with nothing
sent to the vendor.

### 8. Open-source search (ADR-0176)

- **Repo first.** The approvals queue, payload digest and preview (ADR-0104), the settings step-up, the discovery
  switch and credential storage (ADR-0195), the guarded fetch, `runExternalWrite` (ADR-0124) and the registry adapter
  (PR #855 and lane E17) are all reused; this ADR adds one adapter member, one object type, one external-write
  operation, one table (the actions; control credentials reuse `discovery_credentials`) and five routes.
- **Microsoft.** `Microsoft.PowerPlatform.Management` is a .NET SDK; there is no maintained JavaScript Power Platform
  API client. The three calls are REST calls through the guarded fetch. The delegated authorization-code flow
  (section 3a) uses `@azure/msal-node` (MIT, maintained by Microsoft), already in the lockfile as a dependency of
  `@azure/identity` and pinned in `engines/promptfoo`, rather than a hand-written OAuth client. The Entra token comes from `@azure/identity`,
  already used by discovery.
- **The state table.** Searched 2026-11-17. Two approaches were compared:
  - `xstate` (MIT, actively maintained, v5) gives interpreted actors, timers and visualisation. None of these is
    needed for a server-side lifecycle of nine states whose source of truth is a database row, and xstate is not used
    elsewhere in the repo.
  - A declared transition table with a conditional SQL update. It is enforced in the database, and there is no
    runtime to load.

  The table is adopted, and xstate is not. ADR-0348 made the same comparison and choice app-wide, so the table is
  declared with its `defineMachine`.
- **Salesforce, n8n, OpenAI.** Chosen in slice 2, with the same rule: an existing pinned client only when it signs or
  does something we must not hand-write; otherwise REST through the guarded fetch.

## Not in this slice

- Slice 1: this ADR, the framework (switch, control credentials, actions, routes, approval kind, external-write
  operation) and the Copilot Studio adapter's `control` member. Slice 2: Agentforce, OpenAI and n8n.
- Admin screens: the routes are API-only, listed in `KNOWN_UI_GAPS` against #453.
- Bulk actions: one agent per action.

## Owner decisions (2026-11-17)

1. **Copilot Studio delegated credential: allowed, by admin opt-in.** Off by default; connected for a named account
   with a step-up and an audit row; mandatory expiry and revocation; the token stays server side, rotates on use and
   reuses the existing credential storage; app-only stays the preferred path wherever the vendor supports it
   (section 3a).
2. **Kill-switch halt: narrowing only.** Disable and quarantine still run during a halt, with the normal approval and
   step-up; restore and anything that widens access stay blocked until the halt lifts. Encoded as a guard on the
   `approved → executing` transition, with tests in both directions (section 7).

## Consequences

- An org can take a vendor-hosted agent out of service without leaving RegulAIt, with two people, an MFA step-up on
  each consequential step (request, decision and execute), the exact payload approved, one execution per approval and a full audit trail.
- The read path stays provably read-only: control uses a different credential with a different scope.
- Until E17's adapters exist for a vendor, that vendor offers no action.

## Numbering

ADR 0338 is the number reserved for builder lane E19.

## As built (slice 1) — 2026-11-20

Slice 1 (PR #1096) ships the vendor-neutral framework. The decision text above is unchanged; this section records where
the build departs from it and why.

- **Slice 1 is split into 1 and 1b.** Lane E17's adapter code is not on main yet. So slice 1 ships the switch, the
  `vendor_agent_actions` table, the routes, the approval kind and the external-write operations, and leaves out the
  control credential and the Copilot Studio `control` member. In production no registry offers a control and no
  control credential resolves, so every request answers `409 control_not_offered` or `409 no_control_credential`.
  Slice 1b adds the `discovery_credentials` columns `purpose`, `credential_mode = delegated` and `expires_at`, the
  owner-decision-1 opt-in, the credential loader and the Copilot Studio member.
- **Approver selection (section 4.2).** A request names its approver, a second active admin. That approver must be in
  the `loadApprovalPool` pool, the ADR-0331 pattern. An `approval_rules` role pool with a quorum above 1 is not wired
  for this kind yet. The decide precheck still refuses the requester and anyone outside the pool.
- **The adapter contract (section 3) is gateway-local.** `VendorAgentControl` is in
  `apps/gateway/src/vendor-agent-control-contract.ts`, not `@regulait/shared`, so the AER-018 external-effects test
  classifies its writes. It has two write methods, `apply` (operation `vendor_agent_control.apply`) and `reverse`
  (`vendor_agent_control.reverse`), so that each classified operation is one contract method. The vocabulary
  (actions, states, outcomes), the machine and the guard stay in `@regulait/shared`.
- **The credential is part of the digest.** The approval's arguments digest also covers the control credential's row
  id. A credential revoked or replaced after approval therefore fails execute with `approval_payload_mismatch`, as
  section 4.3 requires.
- **The dial exemption is a declared list.** It is `NARROWING_WRITE_OPERATIONS = ["vendor_agent_control.apply"]` in
  `external-effects.ts`, pinned by the barrier matrix row.
- **Execution recovery (section 4.3), from the #1096 review:**
  - `prior_state` is written in its own transaction before the vendor call.
  - One deadline signal covers the prior read, the call and the observed read, so the whole sequence ends inside the
    lease (deadline + 60 s).
  - A settle reads the state. The target state means `succeeded`. Any other known state means `failed / not_applied`,
    so an agent is never left unactionable when the prior state is missing. Only an unreadable state stays `unknown`.

## As built (slice 1b) — 2026-11-20

Slice 1b adds the control credential and the first vendor member, Copilot Studio quarantine. The decision text above is
unchanged; this section records where the build departs from it or fills in what it left open.

- **The delegated connect flow is slice 1c.** The table accepts `delegated` rows (CHECK: `platform_write` only, an
  `expires_at` at most 90 days after the row was stored, a stored secret), the opt-in
  `discovery_settings.vendor_agent_control_delegated_enabled` is off by default with its `settings_relax` step-up key
  (`DISCOVERY_STEP_UP_KEYS.vendorAgentControlDelegated`), and the resolver refuses `credential_mode_disabled` and
  `credential_expired`. Connecting one, the authorization-code flow with PKCE through `@azure/msal-node`, and the
  refresh-token rotation on use are not built: the store route refuses `delegated` with
  `409 delegated_connect_not_available`, and a delegated row's token request fails with the same code. A federated
  service principal or a stored client secret is what slice 1b stores.
- **The control token has its own federation subject.** A federated control credential is asserted for
  `regulait:vendor-agent-control:<sourceId>` (`vendorAgentControlSubject`), never the read subject
  `regulait:discovery-source:<sourceId>`. The customer's write app trusts only the control subject, so an assertion
  minted for a scan cannot be exchanged for the write app.
- **The write app is a different app, in the source's tenant.** Storing refuses `write_app_is_read_app` when the
  control credential names the live read credential's app, and `credential_target_mismatch` for another tenant.
- **The guard trigger permits three updates.** `discovery_credentials_guard` fixes id, source, purpose, mode, public
  config, expiry and creator. An update may revoke a row, record the scanner's write-scope verdict, or replace the
  ciphertext (data-key rotation now; the delegated refresh token's rotation in slice 1c). A revoked row stays revoked.
  The table also refuses TRUNCATE, so the 0185 rules hold.
- **The Copilot Studio locator.** The quarantine API addresses an agent by Power Platform environment id and bot id.
  E17's read path now also reads `RetrieveCurrentOrganization` (a GET, on its endpoint allow-list) and stages each
  agent with an `environmentId` vendor attribute. An environment whose id cannot be read still stages its agents,
  without the attribute, so they cannot be controlled. The control contract gains an optional `locatorOf`. A request
  for an agent without a locator answers `409 vendor_locator_missing`. The locator is snapshotted on the action
  (`vendor_agent_actions.vendor_locator`, a commented 3NF exception), bound into the approval digest, and re-checked
  at execute.
- **The contract gains `acceptedModes` and `token`.** `token` is `{ provider: "entra", scope }`. Copilot Studio's scope
  is `https://api.powerplatform.com/.default`, and its `acceptedModes` are federated, static and delegated.
  Slice 2 adds token providers for Agentforce, OpenAI and n8n.
- **The token is obtained before anything moves.** Execute and settle request the token outside any transaction,
  before the action's transition. A token failure answers `502 control_token_failed`, keeps only Entra's AADSTS code,
  is audited, and leaves the action and its approval as they were. The transaction re-reads the credential, and a
  different row id refuses `credential_changed`.
- **Vendor answers.** A 2xx means `applied`, then confirmed by the observed read. 401 and 403 mean `refused /
  vendor_refused_credential`. 404 means `vendor_agent_not_found`. 405 (a classic chatbot) means
  `vendor_action_unsupported`. Any other 4xx means `failed / vendor_rejected`. A 5xx or a 429 may have acted, so the
  action goes to `unknown` and is settled by a read, never retried. Every call passes `allowListedFetch`, with three
  (method, path) pairs on `https://api.powerplatform.com`, inside the guarded fetch. Both ids are checked as GUIDs
  before anything is sent and are path-encoded. A contract test feeds every registered control hostile ids.
- **Routes.** `GET`, `PUT` and `DELETE /v1/discovery/sources/:sourceId/control-credential` are admin-only and
  API-only, with KNOWN_UI_GAPS entries against #453. Storing is the `settings_relax` step-up bound to
  `{op: "vendor_control_credential", sourceId, mode, tenantId, clientId, replacesCredentialId}`. Revoking is free.
  Both are audited in the same transaction. The read-credential routes, the discovery list and the scanner select
  `purpose = 'discovery_read'` only, and a test pins that with a negative control.
- **Posture.** `delegatedControlCredentials` lists every source whose control credential is delegated, as a finding,
  and says whether it is usable. Control rows are never counted as read credentials.
- **Open source (ADR-0176).** The token uses `@azure/identity` through `@regulait/cloud-discovery`'s `azureCredential`,
  which is already the discovery Entra client and already sends its requests through the guarded fetch. Two options
  were compared for the delegated refresh in slice 1c:
  - `@azure/msal-node` (MIT, maintained by Microsoft, in the lockfile through `@azure/identity`) handles the
    authorization-code flow with PKCE, refresh and rotation.
  - `oauth4webapi` (MIT, already pinned in the gateway) is a lower-level, spec-exact OAuth client with a custom-fetch
    hook.

  msal-node stays the choice, as section 3a decided, because it is Entra's own client. No new dependency is added in
  slice 1b.

## As built (slice 1c) — 2026-11-21

Slice 1c connects a delegated control credential (section 3a) and uses it. The decision text above is unchanged; this
section records where the build fills in what it left open.

- **Starting a sign-in.** `POST /v1/discovery/sources/:sourceId/control-credential/delegated` takes `{tenantId,
  clientId, account, expiresInDays (1 to 90, 30 by default), replacesCredentialId}`.
  - It is refused while `vendor_agent_control_delegated_enabled` is off (`credential_mode_disabled`), and for a vendor
    whose control does not list `delegated` or declares no `delegatedScope` (`credential_mode_not_accepted`).
  - The tenant must be the source's, the app must not be the read app, and the replaced row must be the live one.
  - The `settings_relax` step-up is bound to `{op: "vendor_control_delegated", sourceId, account, tenantId, clientId,
    expiresInDays, replacesCredentialId}`, which extends the binding section 3a named with the fields the callback
    then stores.
  - The answer is the Entra authorization URL, built by `@azure/msal-node` from static metadata (no network call):
    the PKCE S256 challenge, a 256-bit state and nonce, `login_hint` = the account, `prompt=login`.
- **The pending sign-in stays server side.** Pending migration `vendor_control_delegated_requests` keeps the state,
  the nonce and the PKCE verifier, the verifier encrypted with the data key (`CIPHERTEXT_COLUMNS`). The verifier never
  reaches the browser, so an intercepted redirect cannot be redeemed. A row lives at most 10 minutes (a CHECK on the
  database's own clock), is spent once whatever the outcome (a guard trigger: only `used_at`, set once, with the
  verifier destroyed), has row-level security (admin, or the `system_task` / `migration` reason) and refuses TRUNCATE.
- **The callback.** `GET /v1/discovery/control-credential/delegated/callback` is the redirect URI the customer's app
  registration names.
  - Only the admin who started the sign-in can complete it (`delegated_request_not_yours`, audited, and the request
    stays open for that admin). A used, expired or declined request stores nothing.
  - The code is redeemed with the verifier and nonce. The ID token comes from the token endpoint's own TLS response
    (OIDC Core §3.1.3.7). msal checks the nonce, and the route then requires the tenant, the account's UPN and the
    nonce to match what the step-up was bound to (`delegated_account_mismatch`).
  - A sign-in that returns no refresh token (offline access not granted) stores nothing (`delegated_no_refresh_token`).
  - The store transaction re-checks the opt-in and the replaced row (`credential_changed` when it moved), revokes the
    old row with its secret destroyed, and stores the `delegated` row: `public_config` holds the tenant, app, the
    account's object id and UPN; `secret_ciphertext` holds the refresh token; `expires_at` is `now()` plus the chosen
    days. It is audited with the account's object id and UPN.
- **Client authentication.** The confidential client authenticates with a federated assertion for the control subject
  (`vendorAgentControlSubject`), never a stored client secret. The row's one ciphertext is the refresh token, so a
  delegated credential has no second secret to hold.
- **Use, and the rotation.** The resolver redeems the refresh token for the control's `delegatedScope` only (Copilot
  Studio: `https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke`). msal-node is told to keep the rotated
  refresh token (`forceCache`, since each use is a fresh client), and the one Entra returns replaces the stored one in
  the same row. The update is conditional on the row still holding the token just redeemed, so a concurrent rotation
  is not overwritten. A refreshed token for another account is refused (`delegated_account_mismatch`) and stores
  nothing. Token failures keep only the AADSTS code, as the app-only path does.
- **The network.** msal-node's `networkClient` is the tenant's guarded fetch narrowed by `allowListedFetch` to one
  call, POST `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, and its logger is silenced.
- **The contract.** `ControlTokenSpec` gains an optional `delegatedScope`. The store route (`PUT …/control-credential`)
  refuses `delegated` with `409 delegated_needs_sign_in`, pointing to the sign-in route.
- **Open source (ADR-0176).** `@azure/msal-node` 7.1.1 (MIT) becomes a direct, exact-pinned gateway dependency. It was
  already in the lockfile at that version through `@azure/identity`. No other dependency is added.
- **Not swept.** Spent or expired request rows are not deleted. A spent row holds no secret, and an unspent expired one
  keeps only its encrypted verifier until its source is deleted. Filed as #1160 (triage-low), not built.

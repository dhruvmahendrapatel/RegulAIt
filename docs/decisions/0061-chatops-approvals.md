# ADR-0061: ChatOps approvals — the Approvals Queue in Slack/Teams, bound to the real human

- **Status**: Proposed
- **Date**: 2026-08-01

## Context

The Approvals Queue is the product's one inbox for every pending approval-required action
(`GOVERNANCE_LAYER_SPEC.md` §6/§7): §3 approval rules, workflow sign-off stages, orchestration-run
and project-budget escalations, infra drift remediation, and shared-project conflicts. Today it is
decided through `POST /v1/approvals/:approvalId/decide` (`apps/gateway/src/app.ts`), which means an
approver has to come to the app. The `approvals` table already models the full lifecycle
(`packages/db/src/schema.ts`: `status` `pending → approved | denied | consumed | superseded`, plus
`approverUserId`, `decidedBy`, `decidedAt`, `decisionReason`).

The building blocks for surfacing this into chat already exist:

- the **connector-provider Slack adapter** (`packages/connector-provider`) — the Slack Web API
  with an `xoxb-` bot token sent as `Authorization: Bearer`;
- the **approvals table** and its guarded status machine;
- the **approval-mirroring pattern** — approvals and decisions mirrored to PM tools as
  first-class linked records (`packages/pm-provider` `resolveApprovalAction` /
  `resolveDecisionAction`, in the ADR-0010 inbound-sync and ADR-0027 mirroring lineage), which
  already treats an external system as a *courier* for an approval, never as its authority.

The obvious win is to post pending approvals into a Slack/Teams channel or DM with Approve/Reject
buttons. **The hard part — stated up front — is binding the button click to the approving human's
identity, not the bot's.** A Slack interaction payload is delivered *by Slack* and carries a Slack
user id, but the request reaches our endpoint under the *bot's* connection. Record it naively and
the audit says "approved via Slack" with the bot (or an ambient service account) as the actor —
which destroys the entire point of the audit trail (§7: every decision logged with the acting
user). **The bot is a courier, not the authority.** The Slack user id is an *assertion to be
verified and mapped*, never authorization on its own; entitlement must be re-checked
**server-side** against the real, mapped human — exactly as the in-app decide path does.

## Decision

Surface the Approvals Queue into Slack/Teams as a **two-way, server-side-entitlement-checked**
channel. The chat surface is a courier over the *existing* decide endpoint — never a second
authority path.

### 1. Outbound (post)

When an approval enters `pending`, mirror it to a channel/DM through the Slack adapter, reusing
the same mirroring pattern the PM linkage uses. The message carries the approval id, the
requesting user, the gated action (tool / workflow stage / budget), and Approve / Reject
interactive buttons whose payload carries only the **opaque approval id** — no authority is
encoded in the button itself.

### 2. Inbound (decide) — identity binding, the crux

1. **Verify the channel, not the human.** Validate the Slack request signature (signing secret,
   timestamp anti-replay). This proves the request really came from Slack; it says nothing about
   *who* clicked.
2. **Extract** the acting Slack user id from the verified interaction payload.
3. **Map** Slack user id → RegulAIt user via a **pre-established, admin-managed identity link** —
   not a self-asserted one. Bind it to the verified email from the same IdP as OIDC (ADR-0025) so
   the chat principal and the platform principal are the same person. An unmapped Slack user is
   **refused and audited**.
4. **Re-check entitlement server-side** for that mapped RegulAIt user: is this user the named
   approver (`approvals.approverUserId`) or otherwise entitled to decide this approval, and is the
   approval still `pending` (not already `consumed`/`superseded`)? This is the **same check the
   in-app decide path runs** — both routes go through **one** decide function, so chat can never
   be the weaker path.
5. **Only then** apply the existing decide logic, recording `decidedBy` = the mapped RegulAIt user
   (the real human), never the bot; `decisionReason` may note "via Slack." The `audit_log` row
   names the human.

### 3. Server-side authority invariant

The button click carries **no authority.** Every field that matters — who decided, whether they
were allowed — is re-derived and re-checked server-side from the verified-and-mapped human. A
payload that passes signature verification but maps to no user, or to a user without rights, is
rejected and audited under the same default-deny posture as everywhere else. The button is a
*request* to decide, not a decision.

### 4. Concurrency and state

Chat and in-app can race. The decide function is idempotent on approval state: `pending → decided`
is a guarded transition, and a second click on an already-`consumed`/`superseded` approval returns
a clean "already decided" and updates the chat message — never a double-decide. This reuses the
existing status machine rather than inventing chat-specific state.

### 5. Teams parity

The same shape applies through a Teams adapter when connector-provider gains one. The
identity-binding and server-side re-check are channel-agnostic; only signature verification and
the user-id mapping differ per provider.

### 6. Composition with PM mirroring

This composes with the existing approval-mirroring (ADR-0010/0027): a single approval may be
mirrored to *both* a PM work item and a chat message. Both are couriers; both funnel every
decision through the one decide function and into the one audit trail (§7). There is still exactly
one audit trail.

### Worked flow

A workflow reaches a sign-off stage; the approval enters `pending`. The gateway posts a card to
`#deploys` naming the change and the requester, with Approve/Reject buttons carrying the approval
id. Dana clicks Approve. Slack POSTs the interaction to our endpoint. We verify the Slack
signature and timestamp, read Dana's Slack user id, map it to her RegulAIt user via the admin-
established IdP-verified link, confirm she is the named approver on a still-`pending` approval,
and only then call the one decide function — which records `decidedBy` = Dana's RegulAIt user id,
transitions the approval, releases the workflow stage, and writes the `audit_log` row naming
**Dana**, not the bot. The card updates to "Approved by Dana," retiring the buttons. Had the
click come from someone unmapped or unentitled, the decide function refuses and the refusal is
audited — the courier delivered the request, the server denied the authority.

### Deployment-mode behavior (§8.5)

- **Air-gapped.** Slack/Teams require outbound egress, which an air-gapped install does not have.
  ChatOps approvals therefore degrade cleanly to **in-app only** in that mode — the queue and the
  decide endpoint are unaffected; only the chat courier is absent. This is the correct default,
  not a regression, and it means the feature is never a hidden dependency of the core approval
  path.
- **BYOC / hosted.** The bot token is a connector credential in the customer's own store, and all
  outbound posts pass the ADR-0034 egress guard, so a misconfigured or malicious workspace URL
  cannot become an SSRF/exfil primitive.

### Abuse-resistance and rate-limiting

The inbound decide route is an unauthenticated-until-verified public endpoint (Slack calls it),
so it must sit behind the same request-signing wall *and* rate limiting as the other public auth
surfaces (ADR-0031): a flood of forged interaction payloads must be cheap to reject (signature
check first, before any DB work) and bounded per source. A payload that fails signature
verification never reaches the mapping or entitlement steps.

### Composition (pillars 7 and 8)

- **Orchestration escalations (pillar 7).** Run-level and per-node budget escalations already
  land in the approvals table (`runId`/`stageId`); they mirror to chat through the same path, so
  a team lead can unblock a stalled task graph from Slack without a portal trip — still recorded
  against the real human.
- **PM linkage (pillar 8).** The chat courier and the PM-work-item courier are peers: an approval
  can appear as a Slack card *and* a linked PM record, both funneling decisions through the one
  decide function and the one audit trail, consistent with the ADR-0010/0027 mirroring lineage.

## Consequences

- **Easier.** Approvers act where they already are, so time-to-decision drops and the queue meets
  people in chat without a portal trip. It reuses the Slack connector, the approvals table, and
  the mirroring pattern, so most of the work is integration rather than new core logic.
- **Harder / trade-offs & given up.**
  - The Slack↔RegulAIt **identity mapping** is a new admin-managed trust artifact and a new attack
    surface: get it wrong and decisions bind to the wrong human. It must be admin-established,
    ideally IdP-verified-email-backed, and never a self-serve claim.
  - We deliberately do **not** let the bot decide and do **not** trust the Slack user id as
    authorization. That costs a mapping step and a hard refusal on unmapped users — friction we
    accept to keep the audit actor correct.
  - Slack **signature verification and replay window** become security-critical: they are the
    first wall (mapping + entitlement are defense-in-depth behind it).
  - A **chat tap is a weaker authentication act** than an in-app authenticated session. For
    high-sensitivity approvals (compliance cascade, §8.3) an org may need in-app decision or a
    step-up rather than a one-tap button. Make chat-decide allowed **per approval sensitivity,
    admin-configurable**, defaulting the most sensitive classes to in-app-only. A chat tap is not
    a re-authenticated session, and we say so.
  - **Secrets/egress**: the bot token rides the existing connector credential store and the
    ADR-0034 egress guard; outbound posts go through the guarded fetch — no new path outside the
    guard.
- **Follow-up.** Build the admin-managed, IdP-verified Slack↔RegulAIt identity link; decide
  per-sensitivity which approvals are chat-decidable versus in-app-only; add the Teams adapter;
  add a test that a chat-origin decision from an unmapped or unentitled user is refused-and-audited;
  update the chat message on decision to retire stale buttons; keep the one decide function the
  sole authority path.

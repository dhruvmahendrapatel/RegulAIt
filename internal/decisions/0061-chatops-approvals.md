# ADR-0061: ChatOps approvals — the Approvals Queue in Slack/Teams, bound to the real human

- **Status**: Accepted
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

---

## Amendment — 2026-08-02: implemented (migration 0069)

Implemented and accepted. The identity-binding crux is genuinely enforced; the
Teams half is deliberately asymmetric and that asymmetry is stated below rather
than papered over.

### Genuinely enforced (proved by test, not asserted)

- **One decide path, and chat does not get its own.** `app.ts` hands
  `decideOneApproval` — the exact function the portal route and the ADR-0046
  bulk endpoint call — into `registerChatOpsRoutes`. The ChatOps module contains
  no approver check, no status transition and no `approvals` UPDATE of its own;
  every named-approver / delegation / admin-override-reason / self-review /
  superseded / already-decided guard applies because it is the same code. The
  suite asserts a mapped-but-not-the-approver chat user gets `not_the_named_approver`,
  that the approval stays `pending` with `decided_by` null, and that the refusal
  is in `audit_log` under `chatops-decide-refused-by-decide-path`.
- **`isAdmin` is never asserted on the inbound path.** The route passes the
  MAPPED USER'S OWN `users.is_admin`, so a chat decision has exactly the
  authority that human has in the portal — passing `true` would have opened the
  admin-override branch to anyone with a chat identity.
- **The audit names the human, never the bot.** A valid click is asserted to
  leave `approvals.decided_by` = the mapped user's id and to write one
  `chatops-decided` audit row whose `user_id` is that same human.
- **Signature verification.** Slack's documented base string
  (`v0:<ts>:<raw body>`), HMAC-SHA256, constant-time compare that cannot throw
  on a length mismatch. Tested refused: **unsigned**, **wrong secret**,
  **signature over a different body**, **truncated signature**, missing
  timestamp, non-numeric timestamp. In the gateway suite each refusal is
  additionally asserted to leave the approval `pending`.
- **Replay window.** 300 seconds, and the gateway test does not stub the clock —
  it signs a genuinely old timestamp and asserts `stale_timestamp`, then signs
  the SAME body with a current timestamp and asserts it is accepted, so the
  refusal is provably about the window and not the payload. A future-dated
  timestamp is refused too.
- **A signature failure is cheap.** It costs one indexed connection read and
  writes nothing — no transaction, no approval read, and deliberately **no audit
  row**, because one audit insert per forged packet would itself be the
  amplification the ADR's rate-limiting clause warns about. The suite asserts no
  audit row appears. Auditing begins at the mapping wall, where the caller has
  proved it is the workspace.
- **Identity binding is admin-managed and cannot invent a principal.** The link
  route refuses an email that names no existing user (asserted: no user is
  created), refuses a disabled user, and the two unique indexes make one chat
  identity map to one human and one human reachable through one chat identity
  (asserted: a second link on the same chat id is a 409). An unmapped chat
  identity is refused **and audited** under `chatops-decide-refused-unmapped-identity`.
- **Idempotency.** `chatops_interactions` carries a unique index on
  (connection, approval, chat identity, action). The suite delivers the same
  callback twice and asserts: the second answers `idempotent: true`,
  `decided_at` is **unchanged**, and there is exactly **one** `chatops-decided`
  audit row and **one** interaction row. The status machine already prevented a
  double-DECIDE; this is what prevents a double-AUDIT. Refusals deliberately get
  no idempotency row — repeated attempts by an unentitled principal must be
  audited every time, and an admin who then adds the missing link must be able
  to have the person click again.
- **The sensitivity fence keeps content out of chat.** An approval whose
  attributed project's compliance cascade yields PII mode `block` posts a card
  carrying only the opaque approval id and a portal link. The gateway suite
  captures the bytes the gateway really sent to a local HTTP server and asserts
  the card does **not** contain the tool name, the stage id or the requester's
  address. Such an approval is also **not chat-decidable** by default
  (`chatops_connections.allow_fenced_decide` defaults false — ADR-0061's
  "defaulting the most sensitive classes to in-app-only"), and an attempt to
  decide it from chat is refused and audited.
- **Outbound is guarded egress, with no vendor-default exemption.** Every post
  runs `guardConnectionCall` → `createGuardedFetch` (ADR-0034/0043), so
  `slack.com` must be an explicit `egress_allow_hosts` entry. The suite withdraws
  the allow entry and asserts the post is refused with `egress_blocked`, that the
  refusal is audited, and that **nothing reached the socket**. This is also §8.5's
  air-gapped behaviour arriving from the guard rather than from a mode flag.
- **Secrets.** The outbound bot token is not a new store: `connector_id` points
  at an ordinary connector whose ordinary `connector_credentials` row holds it,
  and `resolveConnectorProvider` does the posting. Only the INBOUND signing
  secret is new — encrypted under `REGULAIT_DATA_KEY`, write-only, and asserted
  never present in any response.
- **The buttons carry no authority.** A button's `value` is the opaque approval
  id and nothing else; the unit suite asserts every action element's value is
  exactly the approval id and that no approver identity appears in the action
  block.

### Structural only / deliberately asymmetric — named plainly

- **Teams is inbound-only.** Its HMAC verification, parsing, mapping and decide
  path all work and are tested. But `packages/connector-provider` has no Teams
  adapter, so the OUTBOUND courier refuses with `outbound_provider_unsupported`
  rather than pretending to post. Adding a Teams adapter here instead of in the
  connector package would have been the second integration this whole design
  exists to avoid.
- **Teams has no replay window, and says so.** Its outgoing-webhook HMAC covers
  the body only; there is no signed timestamp, so `verifyChatSignature` returns
  `replayWindowEnforced: false` on that path. Replay defence for Teams is the
  interaction-idempotency record plus the approval status machine — both
  server-side, both real, but weaker than Slack's, and reported as such rather
  than implied to be equivalent.
- **`email_verified_source` can be `admin_asserted`.** The ADR wants the link
  bound to an IdP-verified email. When the deployment has SSO or SCIM, the link
  records `idp`/`scim`; when it has neither, it records `admin_asserted` — the
  admin's assertion, labelled as the weaker thing it is in the API and rendered
  as a warning badge in the console. We do not claim a verification that did not
  happen.
- **Posting is not automatic.** `POST /v1/chatops/approvals/:approvalId/post` is
  an explicit call; nothing yet mirrors an approval to chat the moment it enters
  `pending`. The §1 "when an approval enters pending, mirror it" trigger is
  follow-up work, and there is no scheduler in this codebase to drive a sweep.
- **The card is retired by POSTING a new message, not by editing the old one.**
  `chat.update` is not on the connector adapter's supported-op list, so the
  decided card is a follow-up post and `chatops_messages.retired_at` is stamped.
  The stale buttons on the original message are harmless — a second click on them
  hits the idempotency record — but they are not visually removed.
- **Per-approval chat-decidability is per WORKSPACE, not per sensitivity class.**
  `allow_fenced_decide` is one boolean covering "PII mode `block`". A finer
  per-classification matrix is follow-up.
- **Rate limiting is the deployment-wide limiter (ADR-0031), not a per-source
  bound on this route.** The ADR asks for "bounded per source"; what ships is the
  ordinary public-route limiter plus a signature check that does no DB work
  beyond one indexed read.

### Migration

`0069_chatops_approvals.sql` — four tables: `chatops_connections` (the workspace
plus the one genuinely new secret), `chat_identity_links` (the trust artifact,
with both unique indexes), `chatops_messages` (the mirror record, carrying
whether the fence fired) and `chatops_interactions` (the double-click guard).
There is deliberately **no** `chat_approvals` table and **no** second status
column: the absence of anywhere else to record a decision is what makes "the
chat surface is a courier" structural rather than a promise.
`audit_log.object_type` gains `chatops_connection` and `chat_identity_link` as a
TS-only widening — the column has no DB CHECK, so there is no DDL for it.

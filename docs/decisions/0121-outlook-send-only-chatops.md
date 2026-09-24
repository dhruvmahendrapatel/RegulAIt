# ADR-0121 — Outlook approvals: a courier that can only carry, because email signs nothing we can verify

- **Status**: Accepted
- **Date**: 2026-09-24
- **Relates to**: [ADR-0061](0061-chatops-approvals.md) (ChatOps: the courier delivers a request,
  never a decision; the sensitivity fence), [ADR-0113](0113-teams-outbound-courier.md) (the Teams
  outbound courier and why the obvious Graph endpoint was the wrong one),
  [ADR-0023](0023-schema-depth-credential-json-systemprompt-mcpmode.md) (structured-JSON credentials),
  [ADR-0034](0034-custom-llm-providers-egress-guard.md) (the egress allow-list every outbound
  host is adjudicated against)
- **Migration**: [`0112_chatops_outlook_send_only.sql`](../../packages/db/migrations/0112_chatops_outlook_send_only.sql)
  — widens the provider CHECK and makes `signing_secret_ciphertext` nullable under a new
  conditional CHECK. No backfill; every existing row is slack or teams and keeps its secret.

## Context

ADR-0061 built ChatOps as a **courier**: chat carries the approval request and the click, and the
decision goes through the same `decide` function the portal calls, recorded against a mapped human.
ADR-0113 added the Teams outbound half. Both providers share one property that was never stated as
a requirement because both happened to satisfy it: **the platform authenticates the inbound
callback.** Slack HMACs the raw body against a shared secret; the Bot Framework Connector
authenticates its caller.

Email does not. That is the whole of this ADR.

The ask was "build the Outlook approvals", and the tempting shape is symmetry — a third provider
that does what the other two do. Delivering that symmetry would have required inventing an inbound
path, and every available way to invent one is worse than not having the channel:

- **Reply-to-approve** treats an inbound message asserting it is from an approver as authorization.
  It is an assertion. Anyone who can put mail in a mailbox can make it.
- **SPF / DKIM / DMARC** do not fix this; they relocate it. They authenticate a *sending domain* to
  a *receiving relay*, and by the time the message reaches an application it is a set of header
  fields written by whatever handled it last. Trusting them means trusting that relay's parsing, and
  a governance decision is exactly the wrong thing to hang on that.
- **A secret link in the body** is a bearer token in a medium built to be forwarded, archived and
  backed up. Whoever holds a copy holds whatever the copy can do.

Accepting a decision on any of these would be **worse than having no email channel at all**, because
the audit trail would record a verified approver where there was none — it would look like a
verified channel. That is the failure this product exists to prevent, committed by the product.

There *is* a cryptographic path: **Microsoft Actionable Messages** carries a Microsoft-signed bearer
token verifiable against their JWKS. It needs an originator id registered per tenant — a deployment
fact this codebase cannot hold or verify on a customer's behalf — so it is named here as the route
to decide-from-inbox and deliberately not pretended at.

A second, duller problem surfaced while proving the above, and it is the more instructive one. See
§4.

## Decision

### 1. Outlook is a SEND-ONLY ChatOps provider, and inbound is refused by name

`verifyChatSignature` gains an explicit `outlook` branch returning
`inbound_unsupported_by_design` — a new member of the failure union, distinct from
`unsupported_provider`. The distinction is the point: "we have not built this" and "this cannot be
built safely and we decided not to fake it" are different facts, and an operator reading the refusal
gets the second one with the reasoning attached.

The refusal lives in `chatops.ts` beside the Slack and Teams verifiers rather than in this document
alone, because that is where the next person will look for it.

### 2. The message carries the SAME content and NO decide actions

`outlookMessageForCard` renders an already-composed `ApprovalCard` as Graph `sendMail` fields.
`card.actions` is **not rendered**, and a deployment cannot opt out: `allowFencedDecide` loosens
ADR-0061's *fence*, not this channel's own limits.

ADR-0061 reasons that a chat tap is not a re-authenticated session. An email is weaker still — it
forwards, it sits in an unlocked mailbox, it survives in archives and backups. So the mail carries
the content and the portal link, and the decision is taken where the approver is authenticated. The
message says so in as many words, so a recipient who replies is not left wondering why nothing
happened.

### 3. The adapter is a courier: Graph `sendMail`, app-only, and READ refused outright

`POST /v1.0/users/{senderUpn}/sendMail` with a client-credentials token.

- **`tenantId` and `senderUpn` are REQUIRED**, unlike Teams. The Bot Connector accepts a
  multi-tenant bot against `botframework.com`; Graph app-only has no equivalent — a
  client-credentials token is minted for exactly one tenant, and a message needs a mailbox to be
  sent from. A credential without them could only be guessed at.
- **`operation: "read"` is refused outright.** On a mailbox, read means `GET /messages` — the whole
  mailbox. Nothing in an approval flow needs it, and a connector that *can* read every message an
  approver has ever received is a vastly larger capability than one that can send one. A read-only
  grant on this provider therefore authorizes nothing, and the adapter says so rather than quietly
  offering a listing.
- **The recipient comes from the governed object**, and `toRecipients` / `ccRecipients` /
  `bccRecipients` are destructured away from any caller-supplied body. A governed call names one
  recipient; it does not get to add a bcc.
- The credential is ADR-0023 structured JSON. A raw Graph bearer token is refused with a reason:
  it expires in about an hour, so storing one would work once in a demo and then fail silently.
- Both hosts — the Entra login service and Graph — are adjudicated by the egress guard. An
  air-gapped deployment refuses before any socket, and simply has no mail courier; the in-app queue
  is unaffected.

### 4. The signing secret becomes NULLABLE, and two mirrors that had drifted are fixed

This is the half worth reading twice, because nothing failed and nothing was noticed.

The adapter shipped with an `outlook` case. **No caller could reach it**, for two independent
reasons, and the full test suite passed throughout:

1. **The connector could not be created.** `shared`'s `connectorProviderKindSchema` is a
   hand-maintained copy of connector-provider's `CONNECTOR_PROVIDER_KINDS`, kept separate so
   `shared` need not depend on the adapter package. It had never learned `"outlook"`, so
   `POST /v1/connectors` refused the only `providerKind` the adapter answers to. The comment above
   it says "mirrors CONNECTOR_PROVIDER_KINDS". A comment is not a guarantee.
2. **The workspace could not be registered.** The drizzle column enum widened to include
   `"outlook"`, but `text(..., { enum })` is a **compile-time** constraint only; the `CHECK` from
   migration 0069 still read `IN ('slack','teams')`. The type said yes, the storage said no, and the
   route surfaced the violation as a 500.

Both are now fixed, and the *class* is guarded: a test asserts the two kind lists are equal. It
lives in the gateway package because that is the only package that depends on both — which is
precisely why the drift was invisible. No single package could see the two lists at once.

Migration 0112 also makes `signing_secret_ciphertext` **nullable**. The column exists to verify an
inbound callback's HMAC; outlook has no inbound path, so NULL is the honest value rather than a
credential the operator invents and nothing ever compares — a field that looks like a security
control and is not. A conditional CHECK requires a secret for slack/teams and forbids one for
outlook, so neither bad state is creatable by any path, route or otherwise. The route refuses both
mistakes **by name** (`signing_secret_not_applicable`, `signing_secret_required`); the first is the
interesting one, because supplying a secret means the operator believes there is an inbound path to
secure, and the refusal corrects the belief instead of storing the secret and letting them discover
it when no reply is ever acted on.

The inbound handler grows a **WALL 0** ahead of the signature check: a send-only connection holds no
secret, so decrypting first would throw on a public, unauthenticated route and turn a designed
refusal into a 500. Refusing before any cryptographic work also keeps WALL 1's cheapness rule — an
unsolicited packet aimed at this path must cost us nothing.

`GET /v1/chatops/connections` now reports `signingSecretSet` **from the column** instead of
hard-coding `true`, so a reader can tell the two kinds of connection apart.

## Consequences

**Easier.** An approver who lives in mail gets the request where they are, on a channel that needs
no app install, no bot registration and no tenant-side consent beyond a Graph app permission.
Outlook reaches people Slack and Teams do not — auditors, external reviewers, executives — and does
it without widening what a chat tap can do.

**Harder, deliberately.** There is no decide-from-inbox. Every Outlook approval costs the approver a
click into the portal and a re-authentication. That is the product of this ADR, not a limitation of
it; §1 argues the alternative is worse than the channel's absence. If a customer requires it,
Actionable Messages is the route and it needs a per-tenant originator registration we do not hold.

**What we gave up.** Provider symmetry. `CHATOPS_PROVIDERS` now contains a member that is not
interchangeable with the other two, and anything iterating that list must handle a provider with no
inbound path. ADR-0113 already kept `CHATOPS_OUTBOUND_PROVIDERS` deliberately separate from the
inbound set; this ADR is the case that separation was for.

**The honest limit.** The adapter is unit-tested against a local HTTP server, not against Microsoft
Graph. The token exchange, the `sendMail` shape and the error mapping are exercised; the tenant
consent flow and the real permission grant (`Mail.Send` application) are not, and cannot be from
this repository. That is the same limit ADR-0113 discloses for the Bot Connector.

**Follow-up this creates.**

- Actionable Messages remains open, and is the only path to a verifiable inbound decision. It should
  be a separate ADR with its own threat model, not an extension of this one.
- The mirror-drift guard covers connector kinds only. `CHATOPS_PROVIDERS`, the model-provider kinds
  and the PM-adapter kinds are the same shape of hand-maintained list, and a sweep for the same
  class is worth doing rather than waiting for the next silent one.
- The Outlook courier has no UI: registering one is an API call. The admin ChatOps surface should
  learn the third provider, including rendering "send-only, no signing secret" rather than an empty
  field that looks unconfigured.

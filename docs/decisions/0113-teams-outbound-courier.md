# ADR-0113: The Teams outbound courier — the Bot Framework Connector, not Microsoft Graph

- **Status**: Accepted
- **Date**: 2026-09-19
- **Supersedes**: nothing. **Amends**: [ADR-0061](0061-chatops-approvals.md) §5 ("Teams parity").

## Context

ADR-0061 shipped ChatOps with a deliberate asymmetry, and said so out loud. `chatops_connections.provider`
was `('slack','teams')` from migration 0069; inbound Teams callbacks were signature-verified
(`teamsSignature`, HMAC over the body), parsed (`parseTeamsInteraction`), mapped through
`chat_identity_links`, sensitivity-fenced and decided through the one `decideOne` function — all of it
real and all of it tested. Only the **outbound courier** was missing, because `packages/connector-provider`
had no Teams adapter. The gap was stated in our own code rather than hidden:

> `// ADR-0061 §5 — TEAMS PARITY IS INBOUND-ONLY TODAY.`
> … refused with `outbound_provider_unsupported`: *"connector-provider has no Teams adapter yet, so Teams
> cards cannot be posted. Inbound Teams callbacks ARE verified and decided; only the outbound courier is
> missing."*

This ADR closes exactly that gap and nothing else.

### The API choice, and why the obvious one is wrong

The obvious counterpart to Slack's `chat.postMessage` is Microsoft Graph:
`POST /teams/{team-id}/channels/{channel-id}/messages`. **It is the wrong endpoint for this product**, and
the reason is a credential fact, not a preference. Verified against Microsoft Learn
(`graph.microsoft.com` `chatmessage-post` / `channel-post-messages`, fetched 2026-09-19): that endpoint's
**application** permission is `Teamwork.Migrate.All`, and the documentation states plainly that
"application permissions are only supported for [migration]". Every non-migration path needs a
**signed-in user's** delegated `ChannelMessage.Send`. `connector_credentials` models a credential *we
present*, not a user session, and a ChatOps courier has no signed-in user to borrow. So Graph is not a
near-miss to be worked around — it is a credential shape this model does not hold, and bending one to fit
would produce the exact failure S17's reasoning warns about: green in a test, broken in production.

The **Bot Framework Connector REST API** is the documented, supported, app-only path, and it is also the
precise mirror of the inbound half we already ship. `parseTeamsInteraction` already reads a Bot Framework
**Activity** (`from.aadObjectId`, `conversation.id`, `replyToId`, `value.approvalId`, `value.action`).
Outbound is the same Activity travelling the other way — so this is one integration completed, not a
second one started.

Verified against Microsoft Learn, fetched 2026-09-19:

| Thing | Source |
|---|---|
| `POST {serviceUrl}/v3/conversations/{conversationId}/activities` (Send to conversation) → `ResourceResponse {id}` | *API reference for the Bot Framework Connector service* |
| `POST {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` (Reply to activity) | same |
| `GET {serviceUrl}/v3/conversations/{conversationId}/members` | same |
| "only Direct Line and Web Chat support the *get conversations* endpoint" | same |
| `https://smba.trafficmanager.net/teams/` as the service URL when none has been observed | same, *Base URI* |
| `POST {login}/{tenant}/oauth2/v2.0/token`, `grant_type=client_credentials`, `scope=https://api.botframework.com/.default`; `{tenant}` = `botframework.com` (multi-tenant) or the directory id (single-tenant); response `{token_type, expires_in, access_token}` | *Authentication with the Bot Connector API* |
| Adaptive Card rides an Activity as `attachments[].contentType = "application/vnd.microsoft.card.adaptive"`; `Action.Submit`'s `data` comes back as the invoke activity's `value` | *Adaptive Cards for Bot Developers*, *Card actions* |

## Decision

### 1. `TeamsConnectorProvider` in `packages/connector-provider`

`"teams"` joins `CONNECTOR_PROVIDER_KINDS`, `resolveConnectorProvider` and `connectorDefaultBaseUrl`,
modelled on `SlackConnectorProvider`. `object` is a **conversation id** — the Teams analogue of Slack's
channel id and the unit an admin scopes via `allowedObjects`. Every call derives its
`/v3/conversations/{id}/` prefix from `object`, and the Activity's own `conversation.id` is **overwritten
from the governed object after the payload is destructured**, so a caller-supplied `conversation` cannot
redirect the message. Operation surface: write → send-to-conversation (or reply-to-activity with
`payload.replyToId`); read with an object → conversation members; **read with no object → REFUSED**,
because Microsoft's own operations table says get-conversations is Direct Line/Web Chat only. Refusing
beats inventing a connection-root listing that does not exist.

### 2. The credential is the app registration, not a bearer token

A Bot Connector token lives about an hour. Storing one in `connector_credentials.token` would pass a test
and rot silently in production, so the stored credential is ADR-0023's structured JSON —
`{appId, appPassword, tenantId?, loginBaseUrl?}` — and the adapter mints a token **per invoke**, the same
"nothing cached, nothing to revoke" posture the snowflake adapter takes. `parseTeamsCredential` rejects a
raw JWT with a message that says why.

### 3. `chatops.ts` routes through the resolved provider

The `conn.provider !== "slack"` refusal is gone. **It did not become a pass-through**: the branch now tests
membership of `CHATOPS_OUTBOUND_PROVIDERS` (`['slack','teams']`), a list kept deliberately **separate**
from `CHATOPS_PROVIDERS` (what we accept *inbound*) — because inbound verification and outbound couriering
are different capabilities, and a provider can honestly have one without the other. That is precisely the
state Teams was in for the last eleven ADRs, and keeping the lists separate is what stops the next
inbound-only provider from being silently assumed postable. Everything else on the path is untouched: the
egress adjudication, the audit row, the posted-message record, and the whole inbound/decide path.

### 4. The fence is decided ONCE, for every provider

Teams cannot render Slack Block Kit, so a second renderer was unavoidable. What must **not** be duplicated
is the *decision* about what the card may say and offer. `ApprovalCard` therefore grew provider-neutral
`actions` and `portalUrl`; `composeApprovalCard` empties `actions` exactly when `chatDecidable` says no,
and `teamsActivityForCard` renders from that same already-composed card — reusing its `text` byte for byte.
A fenced approval produces a Teams card with a link and **no `Action.Submit`** for the same reason and
through the same code path as on Slack. A renderer that emits a button when `actions` is empty is a bug,
not a policy difference.

### 5. Two hosts, both guarded

This is the one place Teams is structurally different from Slack: a post touches the **Entra login host**
*and* the **Bot Connector service host**. Both go through the same injected `fetchImpl`, which on this path
is `createGuardedFetch` — and that re-adjudicates **every** request URL against `egress_allow_hosts`.
Neither host is exempt. A refusal of the *second* host arrives from inside the adapter as an
`EgressBlockedError` rather than from `guardConnectionCall`, so `postCard` now catches it and turns it into
the same honest 403 + `chatops-post-refused-egress` audit row instead of an opaque 500. **An operator
enabling Teams ChatOps must allow-list BOTH hosts**; an air-gapped install has neither and the courier is
simply absent, exactly as §8.5 intends.

## Where Teams genuinely differs from Slack — stated, not implied

| | Slack | Teams |
|---|---|---|
| Hosts per post | 1 | **2** (Entra login + Bot Connector) — two allow-list entries |
| Credential | bare bot token (`xoxb-…`) | structured JSON app registration; token minted per post |
| Card format | Block Kit | Adaptive Card 1.4 in an Activity attachment |
| Bold | `*bold*` | converted to `**bold**` |
| Code spans | `` `x` `` renders as code | **no Adaptive Cards equivalent — renders as literal backticks** |
| Buttons | `button` + `action_id`, value = approval id | `Action.Submit`, `data = {approvalId, action}` |
| Portal link | always a text link | `Action.OpenUrl` **only when `portalUrl` is absolute**; otherwise text only |
| Message handle | `ts` | `ResourceResponse.id` |
| Threading | `thread_ts` (not used by ChatOps) | reply-to-activity (adapter supports it; the courier does not yet use it) |

Card **fidelity is not identical and this ADR does not claim it is**. The *content* and the *fence* are
identical; the markup is poorer on Teams.

## What this deliberately does NOT do

- **No migration.** `chatops_connections.provider` already permitted `teams`; the CHECK constraint is
  unchanged.
- **No change to inbound.** Signature verification, identity binding and the decide path are untouched.
- **No write-time credential validation for Teams.** `agents-connectors.ts` does this for `snowflake` at
  `POST /v1/connectors/:id/credential`, and Teams should get the same treatment. That file was owned by
  another session while this work ran, so it was not edited. Today a malformed Teams credential fails at
  the **first post** with `parseTeamsCredential`'s actionable message rather than at credential write.
  Queued as follow-up.
- **No card retirement fidelity claim.** The decided-card path posts a *new* Activity rather than updating
  the original via `PUT /v3/conversations/{id}/activities/{activityId}` — the same behaviour ChatOps
  already has on Slack. The adapter has the reply endpoint; the courier does not use it yet.
- **Nothing is deployed and nothing is production-designated.**

## Honest limits

- **No real Teams tenant was exercised.** Every test runs against a local `node:http` server playing both
  Microsoft roles. What is proved is the exact method, path, headers and body this gateway puts on the
  wire, and that they match first-party documentation fetched on 2026-09-19. What is **not** proved is that
  a real Teams client renders the card as intended, or that a real bot registration has the roster
  permission to post into a given conversation (`BotNotInConversationRoster` is mapped, not exercised).
- **The service URL is regional.** `https://smba.trafficmanager.net/teams` is the documented global
  default and is what `connectorDefaultBaseUrl("teams")` returns, so ADR-0062's posture gate adjudicates it
  exactly as it does `slack.com`. GCC High, DoD, 21Vianet and regional endpoints differ and **must** set an
  explicit `baseUrl`; the same goes for `login.microsoftonline.us` via the credential's `loginBaseUrl`.
- **A token per post costs a round trip.** Deliberate (see §2), but it doubles the latency and the socket
  count of every Teams post relative to Slack.
- **The https DNS-rebind TOCTOU** is inherited unchanged from `connection-egress.ts`; this ADR closes none
  of it and opens none of it.

## Non-vacuity

Every new test was re-run against a deliberately neutralised implementation. Reported honestly, including
the case that stayed green:

| Neutralisation | Result |
|---|---|
| Teams renderer forced to emit buttons regardless of `card.actions` | **RED** — the Teams fence test |
| Per-request re-adjudication removed (adapter handed the unguarded global fetch) | **RED** — the two-host test only |
| Entry-point adjudication removed (`checkConnectionBaseUrl` always permits) | **GREEN** — *not vacuity*: the guarded fetch alone still refuses. The next row proves it |
| **Both** egress layers removed | **RED** — the Teams air-gapped test, the two-host test, **and** ADR-0061's pre-existing Slack egress test |
| `CHATOPS_OUTBOUND_PROVIDERS` check removed (true pass-through) | **RED** — the 501 test |
| Token exchange skipped (post with the raw stored credential) | **RED** — the post test and the two-host test |
| Teams rendered as Slack blocks | **RED** — the Adaptive Card assertions |

The third row is the useful one: the two egress layers are genuinely independent, and the fourth row is
what stops that from being an excuse. Per **M-033**, every negative assertion ("nothing was posted", "no
token call happened") is paired with a positive one — the same request succeeding once the fixture is
restored — so an empty fake or a never-called path fails rather than trivially satisfying the test. The
501 test lifts the `provider` CHECK constraint for its duration (restoring it in `finally`) so the
assertion is about the **shipped branch answering a real request** rather than about a constant.

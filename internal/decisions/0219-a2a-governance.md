# ADR-0219: Governed agent-to-agent (A2A) calls

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The owner started the post-demo backlog on 2026-10-30 (#453 c6522850568 and c6527158879). Item P10
(internal/product/PENDING.md §2c) reads: "Pillar-7 workers talk only through our own orchestrator, with no A2A support.
Govern A2A calls at the same interception point as MCP: the per-user entitlement check, cost attribution and audit. Use
the permissively licensed A2A SDK."

The lane brief adds the security rules. Remote agent registration is admin-only. Egress goes through the guarded fetch.
Credentials are encrypted and never returned. The feature sits behind a default-off org setting. The UI goes beside the
existing agent and MCP registry pages.

## Decision

1. **A default-off org setting.** `org_settings.a2a_enabled` (migration 0253) is false by default (ADR-0180). While it is
   false, no remote agent can be registered and no call is made; both refusals are audited. Turning it on is a
   relaxation in the strictness registry (`notEqual(false)`), so `PUT /v1/org/settings` asks for a `settings_relax`
   step-up and names it in the audit row's `relaxed`.
2. **One governed choke point.** `executeGovernedA2aCall` (apps/gateway/src/a2a.ts) is the only code that sends a
   message to a remote agent. It decides in a fixed order, and each refusal is audited (`object_type` `a2a_agent`) with
   nothing sent:
   1. the org setting;
   2. the agent exists, is enabled, and lists the named skill on its card;
   3. the lead ceiling: a worker may call only the agents its lead chain allows, which can only narrow;
   4. the person's grant (`a2a_agent_grants`): default-deny, for the whole agent or for one skill;
   5. the egress decision on the current posture;
   6. the credential, which must open.
3. **A worker never exceeds the person.** A grant belongs to a person, never to an agent. A worker calls as the person
   who started its run (`userId` is the initiating user), with its lead's agent ceiling passed in. The person's grant
   and the ceiling must both allow the call.
4. **Egress is the MCP posture.** A remote agent's url is decided exactly like an MCP server's. The admin egress
   allow-list applies, and `allow_private_ranges` NULL inherits `mcpPrivateRangesDefault`. The decision is made at write
   time and again at call time. Every request goes through `createGuardedFetch`: re-validated, DNS-pinned and
   redirect-refused. Opting a remote agent into a private address is a `settings_relax` step-up.
5. **The card cannot move our calls.** Registration and the card refresh read the agent card through the guarded fetch.
   A card is refused when it offers no JSON-RPC interface, names a JSON-RPC interface on any origin other than the
   registered url's, or is larger than 60 kB. The client is built from the stored card filtered to that origin only.
6. **Credentials as for MCP servers (ADR-0204).** The optional static credential has its own table,
   `a2a_agent_credentials`, so no read of `a2a_agents` carries it. It uses the data-key envelope and is listed in
   `CIPHERTEXT_COLUMNS`. Reads show set or not set, the scheme, the header and the last four characters, never the
   secret. Set, rotate and clear are admin-only, a `settings_relax` step-up each, and audited. The A2A transport's own
   headers (`A2A-Version`, `A2A-Extensions`) are refused as credential headers, as are the MCP reserved ones. The
   credential is sent only on requests to the registered origin.
7. **Cost and audit together (pillar 5).** An allowed call writes one `usage_events` row and its audit row in one
   transaction. The usage row has `object_type` `a2a_agent`, `operation` set to the skill id or `message`, `cost_usd`
   set to the agent's flat price (null means unpriced, never invented), and the caller's project. A call that was
   allowed but failed upstream is audited and charged nothing. The remote party's error text is never repeated.
8. **Open source first (ADR-0176).** The wire protocol is the A2A project's own SDK, `@a2a-js/sdk` 1.3.0 (Apache-2.0,
   exact pin, pure JavaScript, only dependency `jose` already in the tree). Only its client half is used, given our
   guarded fetch. What is ours is who may call and what is recorded.
9. **UI placement** (#453 c6527389773). Integrations > "Remote agents (A2A)" goes directly under Agents. It holds the
   registry, the card and its skills, the credential, and who may call it. The setting is on Organisation settings
   (3b1). The off state is shown inline on the page with a link to that setting.

## As built (2026-10-30, builder/p10-a2a-governance)

- **Routes.**
  - `GET`/`POST /v1/a2a/agents`.
  - `PATCH`/`DELETE /v1/a2a/agents/:agentId`.
  - `POST /v1/a2a/agents/:agentId/card` (refresh).
  - `GET`/`PUT`/`DELETE /v1/a2a/agents/:agentId/credential`.
  - `GET`/`POST /v1/a2a/agents/:agentId/grants` and `DELETE /v1/a2a/agents/:agentId/grants/:grantId`.
  - All of these are admin-only through the default gate.
  - `POST /v1/a2a/agents/:agentId/messages` is non-admin (`NON_ADMIN_ROUTES`), and the caller's own grant decides it.
  - Every route is listed in the OpenAPI registry as `internal`.
- **Tests.** `zz-p10-a2a.test.ts` runs a real A2A agent: the SDK's server half on a loopback port. The data-key custody
  test's table-name pattern now accepts digits, so the new table is covered.
- **Token optimisation (pillar 6).** There is no hook yet. An A2A call carries no model tokens and no tool manifest the
  existing techniques apply to, so the call path has nothing for them to act on. The message is capped at 32,000
  characters and the reply at 64,000.
- **Rate limiting.** These routes ride the gateway-wide per-credential tier. There is no A2A-specific bucket.

## Follow-ups (not in this slice)

- **Orchestration wiring.** An orchestration node does not yet call `executeGovernedA2aCall`. The function already
  takes the initiating user and the lead ceiling. Delegation-grant charging (`settleDelegationCharge`) arrives with that
  wiring.
- **Budgets.** Budget enforcement (block or approval on a project budget) is not applied to A2A spend before the call.
  The spend is attributed, so the dashboard and alerts see it.
- **Protocol features.** Streaming, task polling or cancellation, push notifications, and verification of the card's
  signature.
- **Policy.** Grants through roles, and the policy kernel's rules (ABAC, PII, guardrails) on the message text.
- **Tighter credential writes.** The step-up is spent before the write transaction. ADR-0204 claims it inside the
  transaction, after a compare-and-set on the url. A remote agent's url cannot change, so the compare-and-set has
  nothing to protect, but a claim inside the transaction would match ADR-0204 exactly.

## Addendum 2026-10-31: review on #630 (independent review c6542924936)

The review asked for two fixes before merge. Both are now in `executeGovernedA2aCall`, between the grant check and
egress. Each refusal is audited and nothing is sent.

1. **Project attribution and the pillar-5 budget gate.** A named project must exist, and the caller must be allowed to
   attribute to it: `assertProjectAttribution`, rule `project-attribution`, 400 or 403. The project then goes through
   `preDispatchProjectGate`, rule `project-budget-cap`: 422 for an unknown project, 409 over the hard block, escalated.
   These are the same functions and rule ids the MCP and model paths use. "Budgets" is no longer a follow-up.
2. **The project's PII mode.** `projectPiiMode` gives the project's mode, or the org floor when the call is unattributed
   or the project unclassified.
   - `block` refuses a message with a PII hit (`pii-blocked`).
   - `warn` and `log` send the message and record the hit counts in the audit row, never the matched text.
   - `redact` refuses (`a2a-pii-unsupported`), because A2A has no prepared redaction path. No profile or org setting can
     produce `redact` today; the branch keeps a future one from passing silently.

   PII on the reply, guardrails and the policy kernel's rules on the text remain follow-ups.

Smaller points from the same review:
- **A skill-scoped grant is advisory toward the agent.** The A2A protocol has no skill field on a message, and the agent
  picks its skill from the content. A skill grant therefore decides whether the call is made and labels it. The skill
  is sent as message metadata (`regulait.requestedSkill`). The grant's audit text and the access card now say so.
- **Redirect test.** The suite now proves that a redirect from the agent is refused, and that the credential never
  reaches the other origin.

**Placement change (2026-10-31, after main's merge).** Main's entry bundle reached 138,495 B against the 138.5 kB
ceiling. This lane's own nav entry, icon, route and lazy screen declaration added about 60 B there, which put entry JS
over the ceiling. The registry is therefore now a second tab on the existing Agents page: Integrations > Agents >
"Remote agents (A2A)", linked as `/admin/agents?tab=remote`. It lives in the same lazy chunk, and the entry bundle is
byte-identical to main's apart from chunk hashes. The page-local link style is in its own CSS module rather than in
the entry-bundled `admin.module.css`.


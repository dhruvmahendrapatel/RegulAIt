# ADR-0188: Batch 6 item 1 — per-agent and workload identity, and constrained delegation

- **Status:** Accepted 2026-10-10. The owner accepted all nine OWNER DECISION items with their recommended answers
  ("accept all on ADR-0188"). Design only until the build slices land. Amended
  2026-10-10 after Codex review X31 (I7R-01 to I7R-09): decisions 12 to 21 and the dispositions table; amended again
  after Codex's recheck (I7R-10, I7R-11): decisions 22 and 23. Amended again during S1 (main-session rulings from
  the S2 planning pass): decisions 24 to 28 (agent grant storage, actor order, depth, strict scope, rule ids).
- **Date:** 2026-10-10
- **Deciders:** owner (accepted all nine recommendations, 2026-10-10); the rest follows ADR-0180 (secure by default) and ADR-0176 (open source first)
- **Builds on:** ADR-0183 §1 batch 6 item 1 (DELIVERY_PLAN_2026-10-06 §Batch 6), ROADMAP §7.2 **I7** and §7.3,
  PathForward **PF-02** (and the PF-01 envelope item it unblocks), ENTERPRISE_READINESS_PLAN **C1**, ADR-0015 (deploy
  modes and the control-plane / agent-execution-plane boundary), ADR-0019 (revocations), ADR-0040 (Cedar ABAC),
  ADR-0066 and ADR-0127 (virtual keys and their purposes), ADR-0067 (hash-chained audit), ADR-0097 (RFC 9728
  metadata), ADR-0124 (kill switch), ADR-0186 (step-up, signed receipts), ADR-0187 (runner tokens, run-scoped keys)

## Context

### What is asked

- **I7** (ROADMAP §7.2): "An Agent principal in the ABAC schema, with its own entitlements rather than the union of its
  grant-holders'." ROADMAP §7.3 says that until I7 ships we may not claim "least privilege for agents"; the accurate
  sentence is "every agent call is bound to an entitled human identity".
- **PF-02** (PathForward.md): provider-neutral workload identities with a stable agent id, a public key or workload
  certificate, a human sponsor, allowed capabilities, environment, issuance, expiry, rotation and revocation; signed,
  replay-resistant requests; delegation only as a subset of the parent's capability and budget; SPIFFE and mTLS as
  optional interoperability backends. **Acceptance:** forged, expired, replayed, revoked, wrong-environment and
  over-broad delegations fail *before policy execution*; key rotation keeps audit continuity; every trace and Decision
  BOM tells apart the human sponsor, the invoking workload and the delegated chain. **Guardrail:** an opaque trust
  score never grants a permission.
- **DELIVERY_PLAN §Batch 6 item 1:** "identity on every agent-to-agent and MCP hop. It touches the kernel, so it goes
  slowest."
- **Pillar 7** (CLAUDE.md): every worker or lead agent inherits, and never exceeds, the initiating user's entitlements
  and per-run budget. **Pillar 1:** every call is default-deny, per-user, and fully audited.

### What exists on `main` @ 320dfe1 (read for this ADR)

**Credentials.** `authenticate()` (`apps/gateway/src/auth.ts:220-321`) resolves one bearer string, in order: the
deploy-time bootstrap token (admin, no user); engine enrolment and runner tokens `rgee_`/`rge_`
(`engine-runner-auth.ts:59-91`, no user, own route allow-list); virtual keys `rglv_` (`virtual-keys.ts`, `userId` = the
owner whose entitlements are the ceiling, never admin, purpose `dispatch | pdp | engine`, `auth.ts:155-174`); then API
keys `rgl_` (`api_keys`, the owner's full rights). Browser sessions use a cookie (`createSession`/`resolveSession`,
`auth.ts:607-737`). Every one of these is a **bearer** secret, stored as unsalted sha256 (`token-hash.ts`): whoever
holds the string is the principal. None is bound to a key, a TLS certificate or a sender. The `AuthContext.via`
union (`auth.ts:128`) has no agent or workload member.

**"Agents" are records, not principals.** Three tables carry the word:
- `agents` (`packages/db/src/schema.ts:2062`) is the model registry (provider, model, tier, modes, owner, halt,
  lifecycle). Pillar 7 workers are nodes "owned" by an `agents` row (`orchestration.ts:715`).
- `builder_agents` (`schema.ts:9733`) are user-built agents; a turn runs **as the person using the agent**, a schedule
  as the agent's owner, a channel turn as the linked platform user (`builder-runtime.ts:1-35`).
- `engine_runners` (ADR-0187) are sidecar processes with their own bearer token.
Entitlements attach only to users and roles: `AgentGrant`/`RoleAgentGrant` give a **user** the right to invoke an
agent (`packages/policy-kernel/src/index.ts:1253-1300`); tool and connector grants are per user or role. The agent card
says so explicitly: "tool and connector entitlements attach to users" (`agent-card.ts:13-16`). PF-02's own finding
stands: "`agents` is a governance record, not an authenticating identity; governed invocations act under a human
`userId`" (ENTERPRISE_READINESS_PLAN §1).

**The kernel knows one principal.** `EvaluationInput.userId` (`policy-kernel/src/index.ts:547`) and
`EvaluateAgentInput.userId` are the only subject. The Cedar schema has one principal type, `User`
(`policy-kernel/src/abac.ts:92-138`, `principalTypes: ["User"]`), whose attributes come from
`abacPrincipalFromRequest` (`apps/gateway/src/abac-principal.ts`). Narrowing for delegation exists but is not identity:
the §5.1 Team-Lead ceiling (`computeNodeCeiling`, `orchestration.ts:707-723`) passes `ceilingAgentIds` and
`ceilingTools` into the kernel, which "only ever NARROWS" (`index.ts`, `ceilingTools` doc comment). Workers dispatch
in-process as `run.initiatingUserId` (`orchestration.ts:715-723`, `:1068-1080`), with grants re-checked at execution
time (`pillar7-inheritance.test.ts` attacks this from outside: revoked-before-run, non-initiator driver, lead ceiling,
auto loop). Per-run and per-node budgets live in `orchestration_runs.budget` (`orchestration.ts:262-395`).

**Audit cannot name an agent.** `audit_log` (`schema.ts:970-1460`) has `user_id NOT NULL`, `object_type`,
`object_id`, `server_id`, `tool_name`, effect, rule fields and the ADR-0067 hash-chain columns
(`content_hash`, `prev_hash`, `row_hash`, `seq`; migration `0067_tamper_evident_audit.sql`). There is no actor,
workload or delegation-chain column. Decision receipts (ADR-0186 R) are a foundation stub on `main`
(`decision-receipts.ts`, sweep returns `not_built`).

**Hops carry no identity.** `connectUpstream` (`mcp-proxy.ts:253-285`) opens the upstream MCP connection after the
admission and egress gates; it presents no credential of the caller or of the gateway. The RFC 9728 metadata
(`mcp-auth-metadata.ts:1-60`) deliberately omits `authorization_servers`, because no code path validates an
access token issued by anyone; the only bearer that reaches a tool call is an `rgl_` key. The scheduler "has no
identity and lends none" (`scheduler-jobs.ts:27`, `:566`, `:624`). There is no agent-to-agent protocol endpoint
(no A2A route in `apps/gateway/src`).

**Pieces we can reuse.** `jose` 6.2.12 (MIT) is a direct, exact-pinned dependency (`apps/gateway/THIRD_PARTY.md:12`);
`oauth4webapi` 3.8.8 (MIT) is already in the lockfile through `openid-client`. Step-up grants exist with action kinds
`approval_decide | settings_relax | evidence_hold_override | break_glass | passkey_manage | owner_change`
(`packages/shared/src/batch4.ts:48-55`, `step-up.ts`). The kill switch (ADR-0124) already halts a single agent.
Run-scoped virtual keys (ADR-0187 decision 2) are the closest existing thing to a delegated credential: owner-ceiling,
model allow-list, budget, expiry at the deadline, revoked at completion; but they are still bearer and still keyed to a
human only.

**Numbers.** Latest migration on `main` is `0176_model_artifact_quotas_retention` (re-checked after merging main for
the X31 follow-up); the build takes the next free number at the
time (0176–0178 are reserved for the Batch 5 follow-up, garak and B5-P2, so 0179 or later), with the journal `when` rule of CONTRIBUTING_PARALLEL_SESSIONS §4.

### Standards and open source surveyed (ADR-0176)

| Item | What it gives us | Status checked 2026-10-10 | Fit |
|---|---|---|---|
| **OAuth 2.0 Token Exchange (RFC 8693)** | `subject_token` + `actor_token` → a new token with nested `act` claims: the standard shape for "agent acting for user", and for each further hop | RFC | Core of the delegation design |
| **DPoP (RFC 9449)** | Sender-constrained tokens bound to a client-held key, per-request proofs with `htm`/`htu`/`jti`/`iat` | RFC | Default binding for external clients (no PKI needed, works air-gapped) |
| **OAuth mTLS (RFC 8705)** | `tls_client_auth` / `self_signed_tls_client_auth` and certificate-bound tokens (`cnf.x5t#S256`) | RFC | Optional binding where TLS reaches the gateway unterminated, or a trusted proxy forwards the verified cert |
| **JWT client authentication (RFC 7523, `private_key_jwt`)** | A workload proves itself with a signed assertion from a registered key; no shared secret | RFC | Default workload client authentication |
| **Resource Indicators (RFC 8707)**, **JWT access tokens (RFC 9068)**, **RAR (RFC 9396)** | Audience-restricted tokens; a fixed JWT profile; structured `authorization_details` for tool scopes | RFCs | Audience binding and the scope format |
| **SPIFFE / SVID** | A URI workload identifier (`spiffe://trust-domain/path`) and X.509-SVID / JWT-SVID credentials; **SPIRE** (Apache-2.0) issues them with node and workload attestation, on-prem and air-gapped | Graduated CNCF project | Optional backend for BYOC and air-gapped worker fleets |
| **OAuth SPIFFE Client Authentication** (`draft-ietf-oauth-spiffe-client-auth-02`, June 2026) | Using a JWT-SVID, WIT-SVID or X.509-SVID as the OAuth client credential | OAuth WG draft | How a SPIFFE workload gets a delegated token from us |
| **WIMSE** (`draft-ietf-wimse-arch-08`, `-identifier-03`, `-workload-creds-02`, `-wpt-02`, `-http-signature-07`, `-mutual-tls-02`) | Workload identifiers, Workload Identity Tokens and proof tokens, HTTP message signatures for when TLS is terminated | WG drafts, none an RFC | Shape our identifiers and claims to match; do not implement the drafts' wire formats yet |
| **AI Identity Management System** (`draft-ietf-wimse-aims-00`, 2026-09-15; replaces `draft-klrc-aiagent-auth`) | Guidance for agents: one WIMSE/SPIFFE identifier per agent; short-lived, key-bound credentials; static API keys an antipattern; the model never sees credentials; `client_id` = agent, `sub` = the person acted for; token exchange and transaction tokens to stop token reuse; durable tamper-evident audit; short lifetimes over revocation lists | WG draft, Informational | The closest thing to a standard for this ADR; the design follows it |
| **OAuth Identity and Authorization Chaining** (`draft-ietf-oauth-identity-chaining-15`) | Cross-trust-domain hop: exchange in domain A, JWT authorization grant in domain B | WG draft, reported approved for Proposed Standard | Later, for BYOC execution planes in a customer trust domain |
| **Transaction Tokens** (`draft-ietf-oauth-transaction-tokens-11`) | Short-lived, call-chain-scoped tokens inside one trust domain | WG draft | Same idea as our per-run delegation grant; keep claims compatible |
| **`oidc-provider`** 9.12.2 (MIT, released 2026-09-05; direct deps `koa`, `jose`, `debug`) | A certified OAuth/OIDC authorization server: client credentials, `private_key_jwt`, mTLS client auth and certificate-bound tokens, DPoP, RFC 9068 JWT access tokens, resource indicators, RAR, revocation, introspection, and `registerGrantType` with documented token-exchange helpers (`validateDpop`, `checkMtlsCert`, `checkDpopReplay`, `buildTokenResponse`) | Maintained, single primary maintainer | Recommended token endpoint, subject to spike S0 |
| **`oauth4webapi`** 3.8.8 (MIT, already locked) | Resource-server side `validateJwtAccessToken`, including DPoP proof checks | Maintained, same maintainer as `jose` | Recommended verifier at our own routes, subject to S0 |
| **`jose`** 6.2.12 (MIT, already pinned) | JWS/JWK/JWKS primitives, thumbprints | Maintained | Signing keys, JWKS, SVID verification against a static bundle |

No validated open-source module implements the RegulAIt-specific part: **deciding** whether a delegation is allowed
(the intersection of the human's grants, the agent's own grants, the lead ceiling and the parent's remaining budget),
and writing it to our audit chain. That is governance logic, which ADR-0176 §4 says we write ourselves.

## Options considered

**A. Keep "agent acts as the human", add an `agentId` column to audit (label only).** Cheapest; no kernel change. It
does not meet I7 (no own entitlements, so the agent is as strong as any human who runs it), it does not meet PF-02 (no
cryptographic identity, nothing for a remote worker to prove), and the audit column would be an unverified label.
Rejected.

**B. Agents become users (service-account rows in `users`, with API keys).** Reuses every grant table and the kernel
unchanged. But a service account is a **standing** principal: its rights do not shrink to the person who started the
run, so pillar 7's "never exceeds the initiating user" becomes a convention again, and `rgl_` keys are long-lived
bearer secrets, which the WIMSE AIMS draft calls an antipattern. It also blurs every "is this a person?" check
(literacy gate, MFA, SoD, approvals). Rejected.

**C. Agent principal plus delegation grants, with our own short-lived, sender-constrained tokens (recommended).** An
agent gets an identity of its own and grants of its own. Nothing an agent does is authorised by its identity alone:
every action runs under a **delegation grant** that names the human sponsor, the agent, the parent grant, a scope and a
budget. The effective right is the intersection of every link. Tokens for anything that crosses a process boundary
follow RFC 8693 / 9449 / 8705 / 7523 / 8707 and are checked against the live grant row on every use. SPIFFE is an
optional credential backend, not a dependency.

**D. Make SPIFFE/SPIRE (or a service mesh) the identity system.** Strong workload attestation and mTLS, works
air-gapped. But it identifies **workloads**, not "agent X acting for person Y with budget Z"; it needs a SPIRE server
and agents on every node, which a hosted fast-start install would not have; and it does not touch the in-process
workers where most agent actions run today. Kept as an optional backend inside C, not as the design.

**E. Run a separate, general authorization server (a standalone IdP product) and treat RegulAIt as a resource
server.** Standard, but it moves the delegation decision (the governance part) out of the gateway into a policy
engine we would have to configure from outside, adds a hard runtime dependency to air-gapped installs, and splits the
audit trail. Customers may still front us with their own IdP for **human** sign-in (ADR-0174); agent delegation stays
in the gateway.

## Decision (Accepted 2026-10-10)

### 1. Two facts on every agent action: who it is for, and who is doing it

Every governed call made by an agent carries both a **sponsor** (the human the work is for: the initiating user of a
run, the person using a builder agent, the person who configured a schedule) and an **actor chain** (the agent
principal making the call, then each delegating agent up to the root). The human stays the `sub`; the agent is the
`client_id` and the RFC 8693 `act` claim, nested once per hop. A call with no sponsor is refused. This is the
`sub`/`client_id` split of `draft-ietf-wimse-aims-00`.

### 2. An agent principal with its own identity

New table `workload_identities`:
- `id`, `kind` (`agent | builder_agent | engine_runner | worker_runtime | pdp`), exactly one subject FK
  (`agent_id`, `builder_agent_id`, `engine_runner_id`, or none for an external `worker_runtime`/`pdp`), enforced by a
  CHECK;
- `identifier` (unique URI): `spiffe://<trust-domain>/regulait/<kind>/<id>` by default, so it is a valid SPIFFE ID and a
  WIMSE identifier; a SPIFFE-backed workload may instead be bound to an exact SPIFFE ID the customer's SPIRE issues;
- `sponsor_user_ids` (one or more stewards; PF-02 also asks for co-stewards), `environments` (allowed target
  environments and deploy modes), `status` (`active | suspended | revoked`), `created_by`, timestamps;
- one identity per subject. Creating, binding a key to, suspending or revoking an identity is an admin act, audited,
  and needs a step-up under a new action kind `identity_manage`.

New table `workload_credentials`: the public half only (a JWK with its thumbprint, an X.509 certificate's
`x5t#S256` and SAN URI, or a SPIFFE ID pattern under a configured trust bundle), with `not_before`, `not_after`
(maximum 90 days for a registered key), `revoked_at`. **No shared secrets:** `client_secret_*` methods are not
offered. The private key stays with the workload; for in-process agents there is no key at all, because nothing crosses
a boundary (decision 6).

### 3. Agents get entitlements of their own, and the effective right is an intersection

Agent principals get their own grants, in the same shape as users' (tool, server, connector and agent-invoke grants,
per identity; role grants via an agent role assignment). The kernel decides an agent call as:

```
allow  ⇔  sponsor allowed (existing per-user evaluation, unchanged)
        ∧ every actor in the chain allowed (same evaluation, run for the agent principal)
        ∧ within the delegation grant's scope (decision 4)
        ∧ within the lead ceiling (existing ceilingAgentIds / ceilingTools)
```

Each term can only narrow. A deny or require-approval from any term wins, with the rule id of the term that decided
(`agent-allow-list`, `delegation-scope`, `delegation-depth`, `delegation-budget`, `lead-ceiling`, ...). In code:
`EvaluationInput`, `EvaluateAgentInput` and `EvaluateConnectorInput` gain a required `actor: ActorChain | null`
(required so the compiler finds every call site, as ADR-0124 did for `execution`); `null` means "a human acting
directly", and is refused for any call that came through an agent path. The Cedar schema moves to **v4**: a new
`Agent` entity type (attributes `kind`, `identifier`, `environments`, `stewards`, `autonomyClass`) and a context
attribute `actorChain` (ordered agent ids) and `delegationDepth`, so a policy can say "forbid writes when
`context.delegationDepth > 1`". The principal entity stays `User` for the sponsor; Cedar evaluates each agent as a
further request with principal `Agent`. *Amended by decision 18:* grants supply the authority; Cedar only narrows,
through the existing forbid-only wrapper, for each principal under its own schema version. Trust or risk scores are never an input to an allow
(PF-02 guardrail); they may raise `require_approval`.

**OWNER DECISION 1** sets how existing agents get their first grants.

### 4. Delegation grants: the unit of authority, checked on every use

New table `delegation_grants` (one row per delegation; none is ever updated except to revoke or record spend):
`id`, `root_grant_id`, `parent_grant_id`, `path` (ordered ancestor ids), `depth`, `sponsor_user_id`,
`actor_identity_id`, `run_id`/`builder_turn_id`/`engine_run_id`/`schedule_id` (the context it was made for),
`project_id`, `scope` (an RFC 9396-style list: `{type: "mcp_tool" | "connector" | "agent", server/connector/agent id,
tool names, modes, kind read/write}`), `budget_usd` and `spent_usd`, `environment`, `audience` (RFC 8707 resource),
`expires_at`, `revoked_at`, `revoked_reason`, `created_at`. *Amended:* credential and binding provenance columns
(decision 12) and micro-dollar budget and reservation columns replacing `budget_usd`/`spent_usd` (decision 16).

Rules, enforced in one module (`delegation.ts`) and asserted by tests:
- **Subset on creation.** *Amended by decision 16: a request beyond any limit is refused, not narrowed.* A child's
  scope must lie inside `parent.scope ∩ child-agent's own grants ∩ sponsor's grants ∩ lead ceiling`, or the request
  is refused. A child's budget is at
  most the parent's remaining budget, and is reserved against the parent at creation. A child's expiry is at most the
  parent's. Depth is `parent.depth + 1`, capped by `delegation_max_depth`.
- **Checked on every use, not only at mint.** Every governed call made under a grant reads the grant, its ancestors
  (by `path`), the actor identity and the sponsor in one indexed query, and refuses if any is revoked, expired,
  suspended, disabled or out of environment. There is no cache. This is what makes revocation immediate, and it keeps
  pillar 7's existing execution-time re-check (the grants may have changed since the plan) for every hop. *Amended by
  decision 17:* the check covers every ancestor's identity, credentials, own live grants and halt state, plus the
  sponsor's current rights, and never trusts a caller-supplied chain.
- **Revocation cascades.** Revoking a grant revokes every grant whose `path` contains it (one statement over a GIN
  index on `path`). Revoking an identity, suspending it, a sponsor being disabled (ADR-0022) or an ADR-0124 halt on the
  agent stops every grant naming it at the next use.
- **Budget.** Spend is charged to the grant and every ancestor in the same transaction as the usage row, so a sub-agent
  cannot spend more than any ancestor has left. This replaces nothing in the run budget (MULTI_AGENT_ORCHESTRATION_SPEC §5.2, `orchestration_runs.budget`, stays); it adds
  the per-hop cap PF-02 asks for. The first-crossing rule of ADR-0103/F03 applies unchanged and is documented as such.
  *Amended by decision 16:* remaining = cap − settled − outstanding reservations, with durable reservations.

### 5. Tokens that leave the process are short-lived, audience-bound and sender-constrained

Anything that crosses a process boundary (an external agent calling `/mcp/:serverId` or the compat model routes, a
remote worker, an engine runner, a data-plane PDP, the outbound MCP hop of decision 8) uses an access token the gateway
issues:
- **Format:** RFC 9068 JWT access token, signed by the gateway issuer with Ed25519 (`identity_signing_keys`, public
  halves only in the table, JWKS served at `/.well-known/jwks.json`; private key from a deploy-time
  secret, the pattern the receipt key `REGULAIT_RECEIPT_SIGNING_KEY` follows; rotation with overlap, every rotation audited). Claims: `iss`, `sub`
  (sponsor, pairwise per audience; never an email), `client_id` (actor identifier), `act` (nested chain), `aud` (one
  resource, required), `grant_id`, `env`, `jti`, `iat`, `exp`, `cnf`.
- **Lifetime:** `delegated_token_ttl_seconds`, default 300, range 60 to 3600.
- **Binding:** every token carries `cnf`: `jkt` (DPoP, RFC 9449) by default, or `x5t#S256` (mTLS, RFC 8705) where the
  workload authenticates with a certificate. **A token with no `cnf` is never issued and never accepted**; this is an
  invariant, not a setting (decision 10). DPoP proofs are checked for `htm`, `htu`, `iat` within 60 s, `ath`, and a
  `jti` not seen before (a replay store in Postgres, so it holds across replicas). A gateway-issued DPoP nonce is
  required (RFC 9449 §8). *Amended:* the replay store is an atomic claim (decision 14) and the verifier is ours,
  with a separate mTLS branch (decision 13).
- **Use check:** the resource side verifies signature, `aud`, `exp`, `env` and `cnf`, then performs the decision 4
  grant check. A valid signature on a revoked grant is refused. *Amended:* plus the stored token row and binding
  (decision 12) and the full live-chain check (decision 17).
- **Client authentication** for a workload asking for a token: `private_key_jwt` (RFC 7523) against a registered key,
  `tls_client_auth`/`self_signed_tls_client_auth` (RFC 8705), or a SPIFFE JWT-SVID/X.509-SVID per
  `draft-ietf-oauth-spiffe-client-auth` against a configured trust bundle. Assertions are single-use (`jti` store) and
  at most 5 minutes old. *Amended:* X.509-SVID and mTLS chains are validated with `pkijs` plus our SPIFFE profile, not
  `jose` (decision 21).

### 6. In-process agents use the grant directly, without a token

Pillar 7 workers, builder-agent turns, scheduled runs and engine runs that execute inside the gateway get a
**delegation grant row** and pass its id down the governed call path (`executeGovernedDispatch`,
`executeGovernedToolCall`, `executeGovernedConnectorCall`). No token is minted for an in-process hop: there is no wire
to steal it from, and a signature over a value the same process holds proves nothing. The grant check of decision 4 is
identical for both paths, so an in-process agent and a remote one are governed by the same code. A lead dispatching a
worker creates a child grant (decision 4); the §5.1 ceiling becomes one input to the child's scope rather than a
parallel mechanism, and `computeNodeCeiling` stays as that input. The scheduler still has no identity: a scheduled run's
root grant is sponsored by the person who configured it, as today.

### 7. The token endpoint: RFC 8693 token exchange, built on `oidc-provider`

*Amended by decision 15, which gives the exact wire requests and supersedes the two shapes below where they differ
(the root uses a one-use delegation proof, never a session; the child token is bound to the child's key).*
`POST /oauth/token` accepts `urn:ietf:params:oauth:grant-type:token-exchange` in two shapes:
1. **Human to agent:** `subject_token` = a session- or key-backed proof of the human (see OWNER DECISION 4 for which
   human credentials may start a delegation), `actor_token` = the agent's client assertion. Creates a root grant.
2. **Agent to sub-agent:** `subject_token` = the parent's delegated token (with its DPoP proof), `actor_token` = the
   child's assertion. Creates a child grant.
`resource` (RFC 8707) is required, and `authorization_details` (RFC 9396) names the requested scope, which is then
intersected as in decision 4. Recommended library: `oidc-provider` (MIT), mounted under `/oauth`, with only the
token-exchange grant, client authentication, DPoP, mTLS, JWKS, revocation (RFC 7009) and introspection (RFC 7662)
enabled; every browser flow, dynamic client registration and refresh token is off. Clients come from
`workload_identities`/`workload_credentials` through our own adapter; the grant handler calls `delegation.ts`.
Resource-side verification uses `oauth4webapi`'s `validateJwtAccessToken` with DPoP. Both are contingent on spike S0
(OWNER DECISION 2). Once the endpoint exists, the RFC 9728 document (`mcp-auth-metadata.ts`) lists the gateway's own
issuer under `authorization_servers`, which satisfies its "never advertise what we do not accept" rule.

### 8. Identity on every hop

- **Caller to gateway:** decisions 5 to 7.
- **Agent to agent (in-process):** decision 6. **Agent to agent across processes:** token exchange (decision 7, shape
  2). No route accepts an agent-asserted identity without one of these.
- **Gateway to MCP upstream:** per server, an `identity_propagation` mode: `none` (no identity sent), or
  `signed_assertion` (a per-call JWT, audience = that server, `sub` pairwise, `act` = the chain, 60 s lifetime, signed
  by the gateway issuer so the upstream can verify against our JWKS). OWNER DECISION 6 sets the default.
- **Across trust domains** (a BYOC execution plane under the customer's own IdP): identity chaining
  (`draft-ietf-oauth-identity-chaining`) is the target, and is left to a later ADR once a named BYOC account exists
  (ADR-0183 owner-gated list).

### 9. Audit, traces and receipts carry the chain

`audit_log` gains `actor_identity_id uuid`, `delegation_grant_id uuid`, `actor_chain jsonb` (ordered identity ids).
`user_id` stays NOT NULL and is the sponsor. Because these columns must be inside `content_hash`, the canonical
serialisation of migration 0067 gets a **version 2** for rows from the migration's `seq` on, recorded in the row; the
verifier accepts v1 up to that seq and v2 after it, and a test proves a chain spanning the boundary verifies and that
editing `actor_chain` on a v2 row breaks it. `trace_spans` and `usage_events` get `actor_identity_id` and
`delegation_grant_id`. Decision receipts (ADR-0186 R) and the Decision BOM (batch 6 item 2) include sponsor, actor
chain and grant id, which closes PF-01 delta item 2's "authenticated agent identity" field. Key rotation keeps audit
continuity because audit rows name identity ids, not keys, and retired public keys stay in the table. *Amended by
decision 19:* the boundary is set under the append lock in a verifier-trusted table, not inferred from a row flag.

### 10. Secure-by-default settings (ADR-0180)

| Setting | Default (strict) | Relaxable to | Notes |
|---|---|---|---|
| `agent_entitlement_mode` | `own_grants` (agent's own grants ∩ sponsor's) | `sponsor_only` (I7 off: today's behaviour) | audited, `settings_relax` step-up; the posture page shows "least privilege for agents: off" while relaxed |
| `delegated_token_ttl_seconds` | 300 | up to 3600 | audited |
| `delegation_max_depth` | 3 | up to 8 | audited |
| `workload_client_auth_methods` | `private_key_jwt`, `tls_client_auth`, `self_signed_tls_client_auth`, `spiffe_svid` | removal is a tightening | `client_secret_*` cannot be added |
| `dpop_nonce_required` | true | false | audited |
| `spiffe_trust_bundles` | empty (SPIFFE off) | admin adds a bundle | adding is audited and needs `identity_manage` step-up; bundles are uploaded or fetched through the egress guard |
| `mcp_servers.identity_propagation` | per OWNER DECISION 6 | per server | audited |
| `REGULAIT_CLIENT_CERT_HEADER` (decision 21) | unset (forwarded client certificates ignored and stripped) | a header name, honoured only from an authenticated trusted proxy | deploy-time; boot log states it |
| DPoP proof freshness (decision 13) | 60 s | not relaxable | the library's 300 s default is not used |
| Over-scope / over-budget delegation (decision 16) | refused | not relaxable in v1 | OWNER DECISION 9 |
| Bearer (unbound) delegated tokens | **never** | not relaxable | an invariant, like "a virtual key is never admin" |
| Delegation with no sponsor | **never** | not relaxable | invariant |
| A child grant wider than its parent | **never** | not relaxable | invariant |

Build as for a first load: no grandfathering, no warn-only phase. Existing `rge_` runner tokens and `pdp` virtual keys
move to workload credentials in slice S7 and are then removed (OWNER DECISION 8).

### 11. Deploy modes (pillar 3)

- **Hosted fast-start:** no PKI needed. In-process agents use grants; external agents register a JWK and use
  `private_key_jwt` + DPoP.
- **BYOC:** the same, plus optional SPIFFE: the customer's SPIRE issues SVIDs to its workers, the customer uploads the
  trust bundle, and a worker exchanges its SVID for a delegated token. The control plane keeps identity metadata
  (identifiers, public keys, grants, audit); no private key leaves the execution plane (ADR-0015 boundary).
- **Air-gapped:** everything above is local. No JWKS or bundle is fetched from the internet; bundles are uploaded,
  remote JWKS URLs go through the egress guard and default to none. `oidc-provider`, `oauth4webapi` and `jose` make no
  runtime network calls of their own **when configured as decision 20 requires** (amended after X31: by default
  `oauth4webapi` fetches issuer JWKS and `oidc-provider` can fetch a client's `jwks_uri`).

### Amendments after review X31 (Codex, 2026-10-10)

Codex reviewed this ADR at `691e717` (codexInputs.md, "X31 — ADR-0188 identity design review"), with probes against
the exact library versions. It kept the core (sponsor plus actor intersection, constrained grants, no trust-score
authority, mandatory sender binding, in-process grants without signatures) and raised nine findings, I7R-01 to I7R-09.
Decisions 12 to 21 resolve them; where they change decisions 3 to 11, the earlier text points here and **the later
decision wins**. Codex's recheck of that revision (`165a5be`, codexInputs.md "X31 revised ADR recheck") found two
gaps left in decisions 15 and 16 (I7R-10, I7R-11); decisions 22 and 23 close them and amend 15 and 16 in turn. The
disposition table follows decision 23.

#### 12. Credential provenance: revoking a key refuses what it minted (I7R-01)

A token can be minted with client-authentication key A and bound to a different DPoP key B, so looking up `cnf.jkt`
cannot find A. Provenance is therefore stored, never inferred from claims:
- `delegation_grants` gains `auth_credential_id` (the `workload_credentials` row that authenticated the token request:
  the `private_key_jwt` key, the mTLS certificate, or the SPIFFE bundle entry and SVID identity),
  `subject_credential_id` (for a child: the credential that authenticated the parent's proof; for a root: the human
  delegation proof of decision 15), and `binding_kind` (`dpop | mtls | in_process`) with `binding_thumbprint` (`jkt`
  or `x5t#S256`).
- New table `issued_tokens` (one row per external token: `jti`, `grant_id`, `auth_credential_id`, `binding_kind`,
  `binding_thumbprint`, `audience`, `env`, `issued_at`, `expires_at`, `revoked_at`). The resource check (decision 13)
  finds the row by `jti` and refuses if the presented binding differs from the stored one, whatever the token claims.
- What each revocation refuses, at the next use:

| Revoked | Refused |
|---|---|
| A client-authentication credential (key, certificate, SPIFFE ID binding) | every token it authenticated, every grant it authenticated, and every descendant grant (by `path`) |
| A DPoP key or certificate used only as a binding | every token bound to that thumbprint (`issued_tokens.binding_thumbprint`); the grant survives and its holder may re-authenticate |
| A whole SPIFFE trust bundle | every grant whose `auth_credential_id` points into that bundle, and descendants |
| An issuer signing key (rotation) | nothing by itself: overlap keeps old tokens valid until expiry. **Revoking** an issuer key (compromise) refuses every token with that `kid` |

- **Rotation is not revocation.** Rotating a workload key adds a new `workload_credentials` row and sets `not_after` on
  the old one; tokens minted under the old key live to their own expiry. A revoked credential never comes back: a new
  key is a new row with a new id, and audit rows keep naming the identity id, so audit continuity holds.

#### 13. Our own resource-side verifier; the libraries do the cryptography only (I7R-03)

`oauth4webapi` 3.8.8 `validateJwtAccessToken` checks the JWT and the DPoP proof's signature, `htm`, `htu` and `ath`.
It does not check a nonce, does not reject a repeated proof `jti`, accepts a proof `iat` up to 300 s old, accepts an
unbound bearer unless `requireDPoP: true` is passed, and throws "unsupported JWT Confirmation method" on
`cnf.x5t#S256`. So the verifier is ours (`apps/gateway/src/oauth/verify.ts`), in this order, each step failing closed:
1. Exactly one `cnf` member, `jkt` or `x5t#S256`. Anything else, or none, is 401.
2. **DPoP branch:** `validateJwtAccessToken` with `requireDPoP: true`, a fixed algorithm list (`EdDSA`, `ES256`), our
   issuer and the route's audience, and issuer keys from the local key table (decision 20). Then our checks: proof
   `iat` within 60 s (and at most 5 s in the future); the proof nonce matches a current gateway nonce (decision 20);
   the proof `jti` is claimed in the replay store (decision 14, namespace `rs_dpop`).
3. **mTLS branch:** `jose` `jwtVerify` for the token signature only (same algorithm, issuer and key rules), then the
   client certificate from decision 21 (path-validated), and `x5t#S256` must equal the SHA-256 thumbprint of that
   certificate. No DPoP fallback on this branch.
4. Then `env`, `aud`, the `issued_tokens` row and its stored binding (decision 12), and the live-chain check of
   decision 17. A valid signature never short-cuts any of these.

#### 14. Replay claims are an atomic insert, not find-then-save (I7R-02)

`oidc-provider` 9.12.2 `ReplayDetection.unique` calls `find(id)` and then `save()`, which the adapter turns into an
upsert. Two replicas can both see "absent" and both succeed; Codex's probe got `[true, true]` for one client
assertion `jti`. Client assertions and token-endpoint DPoP proofs both go through it. Decision:
- One table `replay_claims (namespace, key, expires_at, claimed_at, PRIMARY KEY (namespace, key))`. Namespaces:
  `client_assertion`, `as_dpop`, `rs_dpop`, `human_delegation_proof`, and `delegation_authz` (decision 23). A claim is
  `INSERT … ON CONFLICT DO NOTHING RETURNING 1`: one row back means accepted, none means replay. Never an update, never
  an overwrite. Rows are kept until `expires_at` = the end of the acceptance window plus clock skew, then swept.
- Inside `oidc-provider`, the `ReplayDetection` model is served by our adapter so that its `find` is not trusted for
  uniqueness: the claim happens in the adapter's `upsert` for that model, which throws on conflict, and the throw is
  mapped to the provider's `invalid_client` / `invalid_dpop_proof` refusal. Because this depends on the provider's
  internal call order, S0 pins the exact version, and a test fails the build if that order changes on upgrade. If the
  hook cannot be made reliable, the token endpoint claims the assertion and proof `jti` itself before handing over
  (the decision 7 fallback path).
- A claim lives in its own short transaction and is never rolled back by a later failure of the same request: a replay
  that loses must fail even if the winner's request later errors.

#### 15. The token-exchange wire contract (I7R-04)

*Amended by decision 23 (I7R-11):* in the child exchange, `actor_token` is a one-use **delegation authorization**
signed by A that binds the intended child, its key and the whole delegation body, not a plain DPoP proof; and a
certificate-bound (mTLS) parent cannot hand off across processes in v1.

Two facts are kept apart: **who may spend the parent's authority** (proved by the parent's binding) and **who holds
the new token** (proved by the child's key). The output is always bound to the **child's** key.

**Root (human → agent).** Step 1, in the portal or API: the human creates a **delegation proof**,
`POST /v1/delegations/proofs` (session with CSRF, or an API key meeting OWNER DECISION 4; step-up when the requested
scope includes `write` on a sensitive project). The response is a one-use signed JWT (`typ`
`regulait-delegation-proof+jwt`, 120 s, `jti`) bound to: the human, the agent identity id, the exact
`authorization_details`, `resource`, `project_id`, `env`, and the agent's key thumbprint if known. It is never a cookie
or a session token. Step 2, by the agent:
```
POST /oauth/token
DPoP: <proof signed by the agent's key B>
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<delegation proof>
subject_token_type=urn:regulait:params:oauth:token-type:delegation-proof
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer   (or mTLS / SPIFFE, decision 5)
client_assertion=<JWT signed by B's registered client key: iss=sub=client_id, aud=<token endpoint URL>, jti, exp ≤ 5 min>
resource=<one audience>   authorization_details=<must equal the proof's>   requested_token_type=urn:ietf:params:oauth:token-type:access_token
```
Checks: the proof's signature, expiry, intended agent equals the authenticated client, every bound field equals the
request, and its `jti` claimed (`human_delegation_proof`). No separate `actor_token` is accepted for a root: the
authenticated client is the actor.

**Child (agent A → agent B).**
```
POST /oauth/token
DPoP: <proof signed by B's key>
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<A's delegated access token>
subject_token_type=urn:ietf:params:oauth:token-type:access_token
actor_token=<DPoP proof by A's key over this token-endpoint request, with ath = hash(subject_token)>
actor_token_type=urn:regulait:params:oauth:token-type:dpop-proof
client_assertion=<B's client assertion, as above>
resource=…   authorization_details=…   requested_token_type=…access_token
```
Checks: B is the authenticated client; `subject_token` passes the full decision 13 check **with A's binding proved by
`actor_token`** (namespace `as_dpop`), so a stolen parent token without A's key is useless; then decision 16 (scope,
budget, depth) and decision 17. The issued token has `cnf` = B's key, `client_id` = B. RFC 8693 `actor_token` names the
party acting; here it carries A's proof of possession because A is authorising the hand-off. That is a profile choice,
recorded so S5 does not re-derive it.

**Output.** `{access_token, issued_token_type: urn:ietf:params:oauth:token-type:access_token, token_type: "DPoP"
(or "Bearer" only on the mTLS branch, where RFC 8705 keeps that name for a certificate-bound token), expires_in}`.
The `act` claim is **rebuilt from the stored grant path**: outer `act` = the current actor, nested `act` = the previous
actors in order. Any `act`, path or chain the caller sends is ignored. Errors: `invalid_request` (missing or duplicate
parameter), `invalid_client` (client authentication, assertion replay), `invalid_grant` (bad, expired, replayed or
mismatched subject or proof; revoked chain), `invalid_target` (resource), `invalid_authorization_details` (over-scope),
`invalid_dpop_proof` / `use_dpop_nonce` (RFC 9449). Over-budget and over-depth are `invalid_grant` with a RegulAIt
`error_code` (`delegation_budget`, `delegation_depth`).

#### 16. One public contract: refuse over-scope; reservations are durable (I7R-05)

Decision 4's "computed, not requested" is withdrawn. **A request for any scope, budget, depth or lifetime beyond what
the parent allows is refused, not narrowed** (`delegation-scope`, `delegation-budget`, `delegation-depth`), consistent
with OWNER DECISION 9. A request that fits is granted exactly as asked.

*Amended by decision 22 (I7R-10):* the per-ancestor reservation below double-reserves nested children. Decision 22's
edge model replaces the bullets "`delegation_grants`", "`delegation_reservations`", "Remaining", "Creating a child",
"Spend" and "Release"; the unknown-cost and first-crossing bullets stand.

Budget accounting, in integer **micro-dollars** (`bigint`), never floating point:
- `delegation_grants`: `budget_micros` (cap), `settled_micros` (measured spend charged to this grant **and its
  descendants**), `reserved_micros` (sum of open reservations held by its children).
- New table `delegation_reservations (id, parent_grant_id, child_grant_id, amount_micros, status open|settled|released,
  idempotency_key UNIQUE, created_at, closed_at)`.
- **Remaining** = `budget_micros − settled_micros − reserved_micros`.
- **Creating a child** locks the whole ancestor path with `SELECT … FOR UPDATE` in one order (root first, by `path`),
  checks remaining at every ancestor, inserts the reservation and the child, and increments `reserved_micros` on every
  ancestor, all in one transaction. The `idempotency_key` (client-supplied or derived from the request) makes a retried
  or lost-reply request return the same child, never a second reservation.
- **Spend** is recorded in the same transaction as the usage row: the leaf's `settled_micros` and every ancestor's
  `settled_micros` rise by the measured cost, and the leaf's own reservation at each ancestor is drawn down by the same
  amount (`reserved_micros` falls), so an ancestor counts each dollar once, either as reserved or as settled, never as
  both.
- **Release:** when a child grant ends (completes, is revoked, expires, fails, or its run is cancelled), its open
  reservation closes; only the unspent part returns to the ancestors (`reserved_micros −= amount − drawn`). A sweep
  closes reservations of expired grants, idempotently.
- **Unknown cost.** A call whose price is unknown (unpriced agent or tool) is refused under any grant with a budget
  cap: an unknown cost never buys free authority. (Today the run and per-node caps send an unpriced node to the
  approvals queue instead, `orchestration.ts:326-330` and `:376-378`; that path stays for the run budget, but a
  delegation grant refuses, consistent with the refuse-over-budget contract above.)
- **First crossing.** Measured cost is known only after a call, so one call may take a grant past its cap (ADR-0103,
  F03); the next is refused. This is stated as the contract; the ADR does not claim a zero-overrun hard cap.

#### 17. The live-chain check reads every ancestor, and trusts no client-supplied chain (I7R-06)

Every governed use, in-process or external, runs one fresh query (its own statement, not a snapshot carried over from
earlier in a long-running turn) immediately before the external effect (the upstream call or the dispatch), and
refuses if any of these fails, for **every grant on the stored path**, not only the leaf:
- the grant: not revoked, not expired, and its `root_grant_id`, `depth` and `path` consistent with its parent row
  (path = parent.path + parent.id, depth = parent.depth + 1, root = parent.root; checked server-side, cycles impossible
  by construction and by a CHECK on `depth = cardinality(path)`); `sponsor_user_id`, `project_id`, `env` and run
  context equal to the parent's (immutable down the chain);
- the actor identity of that grant: `active`, not halted (ADR-0124 agent halt and the org dial), and its
  `auth_credential_id` / `subject_credential_id` live (decision 12);
- the actor's **current own grants** still cover the call (I7: a grant removed after mint narrows immediately);
- the sponsor: not disabled, and the sponsor's **current** rights still cover the call (the existing per-user
  evaluation, run at this moment).
The lookup key is the grant id from our own context (in-process) or from the verified `issued_tokens` row (external).
A caller-supplied `act`, path or depth is never used to find or validate anything. "No cache" is necessary but not
sufficient; the rule is "a fresh read at the point of use", and a test holds a turn open across a revocation to prove
it. A side effect already dispatched cannot be recalled; revocation governs the next use.

#### 18. Cedar stays narrowing-only; each principal gets the policies of its own schema (I7R-07)

Today the Cedar actions accept only `User`, the policies are forbid-only, and the gateway wrapper turns "no forbid
matched" into a neutral permit (`abac.ts`). Raw Cedar denies when no permit matches, so decision 3's "both must
permit" would deny everything if read literally. Restated:
- **Authority comes from grants**, default-deny, per principal (the sponsor's grants and each actor's own grants,
  decision 3). Cedar never grants; it can only `forbid` or require approval, through the existing wrapper, for every
  principal.
- The **sponsor** is evaluated as `User` against the policies stamped v1–v3 under their own schemas, exactly as today,
  plus v4 policies whose principal is `User` (v4 adds context `actorChain` and `delegationDepth` for those).
- **Each actor** is evaluated as `Agent` against v4 policies only. Legacy v1–v3 policies are not run for an `Agent`.
  The `Agent` entity carries only its own attributes; the human's `isAdmin`, `mfaCompleted`, `sessionOrigin` and
  `aiTrainingCurrent` are never copied onto it.
- With no Agent policies, Agent evaluation is neutral (grants decide). A v4 evaluation that fails validation refuses
  the call (fail closed) but does not stop evaluation of legacy policies for installs that have no v4 policy.
- Ownership: S2 owns the kernel package **and** the gateway Cedar wiring (`abac.ts` request building,
  `abac-principal.ts`), since the second request cannot be built in the package alone. S3 depends on S2's
  `ActorChain` and scope types.

#### 19. The audit v2 cutover is a recorded boundary, set under the append lock (I7R-08)

- The cutover is one transaction that takes the existing chain append lock (`pg_advisory_xact_lock` on
  `AUDIT_CHAIN_LOCK_KEY`, `packages/db/src/audit-chain.ts:158`), reads the tip `seq`, and inserts a row in a new
  append-only table `audit_chain_versions (version, from_seq, set_at, set_by)`. The verifier trusts that table (and
  the signed anchor that covers its first v2 row), never a per-row flag alone.
- The v2 canonical serialisation **includes `chain_version: 2`** and the three actor fields (null-valued fields are
  serialised explicitly, never omitted). A row at or past `from_seq` that hashes as v1, lacks the version, or claims
  version 1 fails verification; so does editing `actor_chain`.
- The append path refuses to write below v2 once the boundary exists: the writer reads the current version under the
  same lock, so a v1 writer cannot append past it. **Rollout:** S1's migration only creates the table and columns;
  the cutover runs after every replica runs v2-aware code (a rolling deploy with the old replicas drained), triggered
  by a boot check that refuses to start a v1-only binary when a v2 boundary exists. Bounded verification (from any
  `seq`) loads the boundary from the table.
- v1 hashes are never recomputed. Decision receipts and anchors verify across the same boundary, and historical
  public keys stay published.

#### 20. Library configuration for air-gap and multi-replica, and notices (Codex library notes)

- **No discovery, no remote fetch.** `oidc-provider`: dynamic client registration, client-id metadata documents,
  `jwks_uri` on clients, every browser flow, refresh tokens and every unused grant are disabled; clients and their
  public keys come only from our tables. `oauth4webapi`: given the issuer keys from `identity_signing_keys` directly,
  never an issuer metadata or JWKS URL. An unknown `kid` refuses; there is no external fallback.
- **Shared across replicas:** the issuer signing keys and the DPoP nonce secret (a deploy-time secret; nonces are an
  HMAC over a 5-minute time slot, so any replica can check them), the adapter state in Postgres, and the
  `replay_claims` table.
- **Mounting.** Codex's probe mounted `oidc-provider` under Fastify 5.12.5 and got a refusal from an `onRequest` hook
  before Koa and a valid `private_key_jwt` token request. Because handing the raw request to Koa bypasses later Fastify
  hooks, the `/oauth` mount sets its own body-size limit, request timeout and rate limit, and writes its own audit row
  for every token issue and refusal. S0 proves our real hooks (auth, route classes, CSRF where it applies, body limit,
  audit) and RFC 8693 + DPoP across two Postgres-backed replicas; Codex's probe proved basic mounting only.
- **Pinned internals.** The token-exchange helpers are imported from `oidc-provider/lib/helpers/grants.js`, which is not
  a public API; the exact version is pinned and a contract test covers each imported helper.
- **Licences and notices.** Codex's isolated install resolved 41 runtime packages (39 MIT, 2 ISC). `koa-compose` 4.1.0
  declares MIT but ships no licence file; our `THIRD_PARTY.md` row carries its MIT notice text explicitly, and
  `oidc-provider`'s own `THIRD-PARTY-NOTICES` file is preserved in the distribution. S0 exact-pins the approved closure
  in the product lockfile before admission.

#### 21. X.509 and SPIFFE path validation, and forwarded certificates (I7R-09)

`jose` is used for JWT signatures (and JWT-SVID signature checks against keys from an uploaded bundle) only. Its
`importX509` extracts a public key; it does not validate a chain, validity, SAN, key usage or trust domain.
- **Path validation:** `pkijs` 3.4.1 (BSD-3-Clause, already a pinned dependency for RFC 3161 timestamps, ADR-0186 S;
  pure JavaScript, no network) `CertificateChainValidationEngine`, against trust anchors from the locally uploaded
  SPIFFE bundle or mTLS CA set, at the current time. Then our SPIFFE X.509-SVID profile checks: exactly one URI SAN, a
  `spiffe://` ID in the expected trust domain and matching the registered identity, leaf not a CA, `digitalSignature`
  key usage, no revocation by our own tables. For plain `tls_client_auth` the registered subject or SAN must match.
  `self_signed_tls_client_auth` skips the chain but must match a registered `x5t#S256`.
- **Direct TLS:** where the gateway terminates TLS, Node's TLS server requests the client certificate with the same CA
  set, and the `pkijs` check above still runs on the peer chain, so both termination modes are judged by one
  validator.
- **Behind a proxy:** a forwarded client certificate is read only from one configured header
  (`REGULAIT_CLIENT_CERT_HEADER`, off by default), only from a peer in `REGULAIT_TRUSTED_PROXIES` (ADR-0031), and only
  when the proxy itself authenticates to the gateway (mTLS between proxy and gateway, or a configured shared secret
  header compared in constant time). The header is stripped from every request that does not meet all three, before
  any route sees it. The forwarded certificate is then validated by the same `pkijs` path, never trusted as already
  verified.
- Bundles are uploaded locally (air-gapped) or fetched through the egress guard; a bundle never auto-refreshes from an
  unlisted host.

#### 22. Budget allocations live on parent→child edges (I7R-10; replaces decision 16's reservation bullets)

Decision 16 reserved a child's cap at **every** ancestor, so a grandchild was charged against the root a second time
(root 100 → B 100 left the root with 0 remaining, and C 1 under B was refused although B had 100 unspent). Each dollar
of allocation now sits on exactly one edge.

**Schema** (integer micro-dollars; examples below in dollars):
- `delegation_grants`: `cap_micros` (this grant's allocation; for a root, the amount the sponsor or run budget gives
  it), `settled_micros` (measured spend by this grant and its whole subtree), `reserved_micros` (allocation currently
  held by its **direct** children and not yet spent: Σ over its open outgoing edges of `amount − drawn`).
- `delegation_allocations` (one row per parent→child edge): `id`, `parent_grant_id`, `child_grant_id` UNIQUE,
  `amount_micros` (= the child's `cap_micros`), `drawn_micros`, `released_micros`, `status` (`open | closed`),
  `idempotency_key`, UNIQUE (`parent_grant_id`, `idempotency_key`), `created_at`, `closed_at`.
- `delegation_charges` (`usage_event_id` UNIQUE, `leaf_grant_id`, `amount_micros`, `at`): the record that one usage
  row has been settled along its path, so a retried settlement applies once.

**Rules.**
- **Remaining(g)** = `cap − settled − reserved`, for one grant only. A grant's capacity is already inside its parent's
  edge, so no check above the parent is needed or made.
- **Admit a child C under P** (one transaction): lock P (`FOR UPDATE`), run the decision 17 live-chain check, refuse
  if `C.cap > Remaining(P)`, insert the edge (`amount = C.cap`, `drawn = 0`) and C, and add `C.cap` to
  `P.reserved`. **No ancestor of P changes.** A repeated request with the same idempotency key returns the existing
  child and edge.
- **Settle a charge of x** for a usage row at leaf L (in the usage row's transaction; lock the path root first): insert
  the `delegation_charges` row (conflict = already settled, stop); `L.settled += x`; then for every edge P→Q on the
  path, with `d = min(x, amount − drawn)` (the part still reserved on that edge): `edge.drawn += x`,
  `P.reserved −= d`, `P.settled += x`. Reserved turns into settled once per edge, and every ancestor counts each dollar
  once. If `x > d` (the documented first crossing of decision 16), the excess `x − d` lands on P as settled with no
  reservation behind it, so P's own remaining falls and P may itself be at its cap; that is the only overrun, and the
  next call anywhere under P is refused.
- **Release** (child ends: completed, revoked, expired, failed or cancelled): close its open descendants first
  (leaves first); then on its incoming edge `released = max(0, amount − drawn)`, `P.reserved −= released`, status
  `closed`. Unused capacity returns to the **parent only**, where the parent can re-allocate it while it is alive; it
  reaches the root only when every grant between them closes. Closing is idempotent (a closed edge is not released
  twice). A sweep closes edges of expired grants.
- **Root siblings** compete only at the root: admitting each locks the root, so concurrent requests serialise.

**Worked examples** (all amounts in dollars; S = settled, R = reserved, rem = remaining):

*Scenario 1 (the I7R-10 counterexample).*

| Step | Root (cap 100) | B | C | Result |
|---|---|---|---|---|
| 1. Admit B cap 100 | S 0, R 100, rem 0 | cap 100, rem 100 | — | ok |
| 2. Admit C cap 1 under B | unchanged: R 100, rem 0 | R 1, rem 99 | cap 1, rem 1 | **ok** (decision 16 refused this) |

*Scenario 2 (nesting, a root sibling, spend, release).*

| Step | Root (cap 100) | B | C | D | Result |
|---|---|---|---|---|---|
| 1. Admit B cap 60 | R 60, rem 40 | cap 60, rem 60 | — | — | ok |
| 2. Admit C cap 40 under B | unchanged: R 60, rem 40 | R 40, rem 20 | cap 40, rem 40 | — | ok; the root's reservation for B stays 60 |
| 3. Admit D cap 40 under root | R 100, rem 0 | | | cap 40 | ok: the root's remaining 40 |
| 4. C spends 10 | S 10, R 90, rem 0 | S 10, R 30, rem 20 | S 10, rem 30 | | edges root→B and B→C each drawn 10 |
| 5. Release C (B still active) | unchanged: S 10, R 90 | S 10, R 0, rem 50 | closed, released 30 | | the 30 returns to B, not to the root |
| 6. Close B | S 10, R 40 (D only), rem 50 | closed, released 50 | | | root gets back B's unspent 60 − 10 |

*Scenario 3 (concurrency).* Under a fresh root with cap 100, two requests for children of 60 each arrive at the same
time: the root lock serialises them, one is admitted (R 60), the other is refused `delegation-budget`.

#### 23. A parent authorises one specific child and body (I7R-11; amends decision 15)

A plain DPoP proof by A binds the method, the endpoint and the parent token (`htm`, `htu`, `ath`), but not who the
child is, its key, or what is delegated. Someone holding a different valid child credential and a captured, unused
proof by A could race a changed request to be the first claim. So in the child exchange, `actor_token` is a
**delegation authorization**: a JWT with `typ` `regulait-delegation-authz+jwt`, signed by **A's bound key** (the key
whose thumbprint is the parent token's `cnf.jkt`; the public key is in the header `jwk` and its thumbprint must equal
`cnf.jkt`), with claims:
- the DPoP-style fields: `htm` = `POST`, `htu` = the token endpoint URL, `ath` = hash of the parent token, `iat`
  (within 60 s), the current gateway `nonce`, `jti`;
- `iss` = A's identifier, `aud` = our issuer, `parent_grant_id` (must equal the parent token's verified grant);
- `child` = B's registered identity id and `child_cnf` = B's output-binding thumbprint (`jkt`);
- `delegation` = the canonical (RFC 8785) form of exactly what is requested: `authorization_details`, `resource`,
  `project_id`, `env`, `cap_micros`, `max_depth` (the child's allowed further depth) and `expires_at` (or lifetime);
- `idempotency_key` (decision 22).
`actor_token_type` = `urn:regulait:params:oauth:token-type:delegation-authz`.

The token endpoint checks, **in this order, before claiming any `jti` and before any allocation**: the parent token
(decision 13, with A's binding proved by this object's signature and the DPoP-style fields); the authenticated client
is the `child`; the request's DPoP header is signed by the key whose thumbprint is `child_cnf`; every field of
`delegation` equals the request body's canonical form; `parent_grant_id` matches. Only when all match does it claim
the object's `jti` (namespace `delegation_authz`, decision 14) and then admit the child (decision 22). A mismatch
consumes nothing, so a substituted request cannot burn A's authorization either. The issued token's `cnf` is
`child_cnf`. An admitted child's scope, budget and lifetime are exactly what A signed; the live intersection
(decisions 3 and 17) still applies on every use.

**mTLS parents in v1:** a parent token bound with `cnf.x5t#S256` cannot authorise a cross-process child; the exchange
is refused with `invalid_grant` and `error_code` `mtls_parent_handoff_unsupported`. Signing the authorization with a
certificate-bound key distinct from the child's client certificate is left to a later ADR. In-process hand-offs
(decision 6) are unaffected.

### Amendments from the S1 foundation and the S2 planning pass (2026-10-10)

The main session's S2 planning pass read the S1 contract while it was being written and ruled on five gaps before
S1 froze the schema. Decisions 24 to 28 record those rulings; where they change earlier text, **the later decision
wins**. They change no owner decision.

#### 24. Agent principals' own grants: parallel tables keyed by identity (decision 3)

Decision 3 gives an agent "grants of its own, in the same shape as users'", and the slice table did not name their
storage. Migration 0180 adds five parallel tables, the twins of a user's: `identity_tool_grants`,
`identity_server_grants`, `identity_agent_grants`, `identity_connector_grants` and `identity_role_assignments`, each
with `identity_id` → `workload_identities` (`ON DELETE RESTRICT`; identities are never deleted) and the same object
FKs and uniques as the user tables (the governed object's deletion removes the grant, as for users). Parallel tables
were chosen over a principal-kind column on the existing grant tables because those tables' `user_id NOT NULL`, their
indexes and every existing reader (kernel loaders, certification campaigns, the ADR-0074 rule-write guard,
inventory) assume a person; widening them would put every existing query one missed `WHERE` away from treating an
agent as a user. Default-deny: no row, no right; every identity starts with none (OWNER DECISION 1, no
grandfathering). The contract types are `actorEntitlementsSchema` / `putAgentGrantsSchema` in
`packages/shared/src/identity/contract.ts`; S2 fills one `ActorEntitlements` per actor from these tables, with role
grants expanded.

#### 25. One canonical actor order: root first, leaf last

`ActorChain.actors`, `delegation_grants.path` (+ the leaf grant) and `audit_log.actor_chain` all run root first, leaf
(the caller) last. This supersedes the leaf-first wording of decision 1. The RFC 8693 nested `act` claim is only a wire
encoding derived from that order at mint and verify time (S3/S5): the outermost `act` is the last element
(`actClaimFromChain`).

#### 26. Depth is the hop count

`ActorChain.depth = actors.length`: a human acting directly is 0 (and is `actor: null`, never an empty chain), a first
agent 1, its sub-agent 2. Cedar's `context.delegationDepth` is the same number. The stored `delegation_grants.depth`
counts ancestor grants (`cardinality(path)`, 0 for a root grant), so for the leaf grant of a chain
`ActorChain.depth = delegation_grants.depth + 1` (`actorChainDepthForGrantDepth`). `delegation_max_depth` caps the
stored grant depth (0 to 8), so a chain has at most 9 hops.

#### 27. Scope semantics are strict: absence is denial

Nothing implies anything else. `write` does not include `read`; one mode never implies another; a scope entry with no
`modes` allows no mode; an `mcp_tool` entry with no `toolNames` covers no tool. For an agent's own grants (decision 24)
`allowed_modes` and `allowed_objects` are `NOT NULL` lists: a user's `NULL` there means "every mode / every object",
and an agent never gets that implicitly.

#### 28. Rule ids

A refusal because an actor's own grants (decision 24) do not cover the call is `actor-allow-list`. The existing
`agent-allow-list` keeps its current meaning (the per-user agent allow-list). A stored chain that is inconsistent, or
an actor in it that is not live (decision 17), is refused `actor-chain-invalid`. Both are in `DELEGATION_RULE_IDS`.

Also ruled, for S2's planning (nothing in S1): new ABAC policies default to Cedar schema v4; and S2 may make the
one-token `actor: null` edits in S4-owned files and in `app.ts`.

#### X31 review dispositions

| Finding | Severity | Disposition | Where |
|---|---|---|---|
| I7R-01 key revocation not linked to grants | HIGH | Accepted. Credential and binding provenance stored per grant and per token; revocation table per credential kind; rotation ≠ revocation | Decision 12; decisions 4, 5 amended; tests |
| I7R-02 provider replay check races | HIGH | Accepted. Atomic `INSERT … ON CONFLICT DO NOTHING` claims in namespaces, wired into the provider's refusal path with a version-pinned contract test, fallback to our own claim | Decision 14; tests (two real replicas, concurrent) |
| I7R-03 `oauth4webapi` covers part of the verifier | MEDIUM | Accepted. Our verifier adds 60 s window, nonce, `jti` claim, `requireDPoP: true`, exactly-one-`cnf`, and a separate mTLS branch | Decision 13 |
| I7R-04 token-exchange wire unspecified | MEDIUM | Accepted. Exact requests, token types, child-key binding, parent proof as `actor_token`, one-use bound human delegation proof, `act` rebuilt from the stored path, errors | Decision 15; decision 7 amended; the child hand-off completed by decision 23 (I7R-11) |
| I7R-05 reservation accounting | MEDIUM | Accepted. Refuse over-scope/over-budget (one contract); micro-dollar reservations with lock order, draw-down, idempotency, release, unknown-cost refusal, first-crossing stated | Decision 16; decision 4 amended; the allocation model replaced by decision 22 (I7R-10) |
| I7R-06 ancestors not fully checked | MEDIUM | Accepted. Every ancestor's identity, credentials, own live grants and halt, plus sponsor's current rights; stored path/root/depth validated; fresh read at point of use | Decision 17 |
| I7R-07 Cedar second evaluation | MEDIUM | Accepted. Grants authorise, Cedar only narrows via the wrapper; legacy policies for the sponsor, v4 Agent policies per actor; S2 owns gateway ABAC wiring | Decision 18; decision 3 amended; slices |
| I7R-08 audit v2 cutover | MEDIUM | Accepted. Boundary set under the append lock in a trusted table, version in canonical data, downgrade refused, drained rollout with a boot check | Decision 19; decision 9 amended |
| I7R-09 `jose` is not a path validator | MEDIUM | Accepted. `pkijs` (already pinned) for chains plus our SPIFFE profile; authenticated, stripped proxy header | Decision 21; S0 amended |
| Library notes (air-gap, replicas, mounting, koa-compose notice) | note | Accepted | Decision 20; decision 11 amended |
| Slice-order notes | note | Accepted | Slice table |
| I7R-10 nested children double-reserved (recheck of `165a5be`) | MEDIUM | Accepted. Allocations on parent→child edges; admitting a child touches only its parent; per-edge drawn/released and per-usage settlement idempotency; release returns to the parent only; worked examples | Decision 22; decision 16 amended; tests |
| I7R-11 parent proof does not bind the child or body (recheck of `165a5be`) | MEDIUM | Accepted. One-use delegation authorization signed by A's bound key, binding parent grant, child identity, child key thumbprint, canonical body, issuer and endpoint; checked before any claim or allocation; mTLS-parent hand-off refused in v1 | Decision 23; decision 15 amended; tests |

### Amendments from the S2 build: kernel and Cedar wiring (2026-10-10)

Slice S2 recorded the implementation decisions below while building. They follow the S2 plan's rulings (decisions
25 to 28 and the two rulings after them) and change no owner decision. Where they make an earlier decision more
precise, **the later decision wins**.

#### 29. The kernel's actor types, and what S3 hands the kernel

`packages/policy-kernel/src/actor.ts` holds dependency-free twins of the S1 contract (`ActorChainLink`,
`ActorChain`, `DelegationScopeItem`/`DelegationScope`, `ActorEntitlements`) plus the kernel-only input:
- `ActorLinkFacts`, one per actor in chain order: `identityId`, `grantId`, `live` (decision 17's result for that
  link: grant unrevoked, unexpired and path-consistent; identity active and not halted; credentials live), an
  optional `liveFailure` code, `scope`, `budget` (`{remainingMicros}` = cap − settled − reserved, or `null` for no
  cap), `entitlements` (the actor's own grants, read now) and `abacDecision` (filled by the gateway, decision 36).
- `GovernedActor`: `chain`, `entitlementMode`, `maxDepth` (the org's `delegation_max_depth`), `costKnown` and
  `links`. S3/S4 build it from the stored grant path at the point of use; the kernel never looks anything up.
- The helpers are `scopeCovers`, `scopeSubset` and `checkActorChain`. The gateway test
  `actor-contract-types.test.ts` fails the build if an S1 `z.infer` type stops being assignable to its twin.

#### 30. Term order and combination

The tool, agent and connector paths all decide an agent call in this order: (1) the ADR-0124 execution gate, run
with exactly the arguments the human path uses, so a gated agent call gets the human's decision; (2)
`actor-chain-invalid`; (3) `delegation-depth`; (4) `delegation-scope`, every link, root first; (5)
`delegation-budget`; (6) the sponsor's own evaluation, unchanged; (7) `actor-allow-list`, each actor's own grants,
root first; (8) each actor's own Cedar verdict, traced as `abac-forbid`. Terms 2 to 5 run before the sponsor, so a
forged or spent chain never reaches the grant lookup. Terms 7 and 8 run after it, so when the person is not
entitled the reason shown is the person's.

The **first deny** in that order decides. Otherwise the **first require_approval** decides, and the sponsor's comes
first. Otherwise the result is allow, with the sponsor's grant as `ruleId`. One consent satisfies an actor's
approval hold, as one consent already satisfies whichever hold is checked first. Model dispatch cannot queue
(ADR-0124), so an actor's approval hold refuses there. The connector path queues only a queueable write, as for a
person. Every term traces under its rule id; the `grantId` of a trace entry is the delegation grant
(chain, depth, scope, budget terms), the identity (`actor-allow-list`) or the policy (`abac-forbid`) that decided.

#### 31. `actor: null` is today, byte for byte

`evaluate`, `evaluateAgent` and `evaluateConnector` branch on `actor === null` before anything else, and the null
branch is the unchanged pre-S2 function. The existing kernel suite (169 tests) and the gateway suites were re-run
with only `actor: null` added and pass unchanged; P3 (decision 40) adds that `sponsor_only` with a clean chain
reproduces the sponsor's effect, rule id and reason exactly. `visibleTools` stays the user's own entitlement
(`actor: null`); an agent's narrowing applies at execution.

#### 32. Scope: the call each path asks about, and subset per atom

A tool call asks `{mcp_tool, serverId, toolName, kind = tool.kind}`, a connector call
`{connector, connectorId, kind = operation}`, and a model dispatch `{agent, agentId, mode, kind}`, where `kind` is
`read` for a plan-safe mode and `write` for every other mode. That is ADR-0124's one definition of a write
(`isPlanSafeMode`), so a delegation of `plan` is a `read` entry. `scopeSubset(child, parent)` holds when every
atomic call the child covers (one per tool name or mode, per kind) is covered by some parent entry, so a parent may
split a server's tools across entries. `checkActorChain` refuses a link whose scope is wider than its parent's
(`actor-chain-invalid`); the every-link scope check of term 4 is therefore defence in depth, and its refusal names
the first link (root first) that does not cover the call.

#### 33. The budget term

The leaf link must have `remainingMicros > 0`. An ancestor at exactly 0 is normal, because its allocation sits on
its children's edges (decision 22). An ancestor below 0 (a first crossing somewhere under it) refuses everything
under it. When `costKnown` is false and any link carries a cap, the call is refused (decision 16). A non-finite
balance is refused. All four refusals are `delegation-budget`.

#### 34. The depth term and the chain check

The depth term refuses when `chain.depth − 1 > maxDepth` (the leaf grant's stored depth against the setting, decision
26). `checkActorChain` refuses, as `actor-chain-invalid`, any of: a hop count outside 1..9 or different from
`actors.length`; a repeated identity or grant; fact rows missing, extra or out of order; a leaf fact whose grant is
not the chain's; a sponsor other than the evaluated user; an unknown entitlement mode or a `maxDepth` outside 0..8;
a link not live; a child scope wider than its parent's.

#### 35. An agent's own grants, per path

On the tool path an agent is covered by an `identity_tool_grants` row for the tool, or by a read-only-all server
grant for a read **tool**; as for a person, never for a protocol method (ADR-0185 G3). On the agent path it is
covered by a grant whose `allowedModes` lists the mode. On the connector path it is covered by a grant for the
connector, `readwrite` for a write, whose `allowedObjects` lists the named object. A connector call that names no
object is therefore never covered for an agent (decision 27: an agent's object list is never "every object").
`sponsor_only` skips only term 7; the delegation terms and the actors' Cedar still apply.

`apps/gateway/src/actor-entitlements.ts` (`loadActorEntitlements`) reads an identity's own grants and the grants of
its roles. It does not cache: S3's live-chain query calls it at the point of use. A role grant whose
`allowed_modes` or `allowed_objects` is NULL ("every") gives an agent **nothing**. Connector and agent grants are
returned as separate candidates, never merged, so a read grant on one object and a readwrite grant on another
cannot combine into readwrite on both.

#### 36. Cedar schema v4

v4 is v3 plus:
- an `Agent` entity with `kind`, `identifier`, `environments`, `stewards` and an optional `autonomyClass` (a
  builder agent's declared ADR-0180 A8 class; absent for other kinds, so a policy must guard it with `has`);
- `McpToolCall` principals `User` or `Agent`;
- the required context attributes `actorChain` (a Set of the chain's **identity ids**, the same values as the
  `Agent` entity ids and `audit_log.actor_chain`; a Set, so a policy asks membership, not position) and
  `delegationDepth` (the hop count, 0 for a person acting directly).

No human attribute exists on `Agent`, and none is copied onto it. The sponsor is evaluated as `User` against every
version as before; a v4 group also sees the chain in its context. Each actor is evaluated as `Agent` against v4
policies only (`abacEngine.evaluate` filters the set when the request names an agent).
`assembleActorAbacRequest` reuses the sponsor's resource and context bags and reads the agent's attributes only
from its `workload_identities` row. A route that authenticated a workload credential
(`via === "workload"`) reports origin `unknown` and no second factor in the principal bag.

#### 37. Fail closed per call, and lazily

`evaluateAbacForChain` runs only when the call has an actor **and** at least one active v4 policy; otherwise it
returns the chain untouched and runs no query. For each actor, an identity that cannot be found, an exception, a
request-validation failure or a policy evaluation error in a v4 group gives that link `forbid` with
`abac-engine-error`, which refuses this call and no other. The engine now also refuses on a Cedar evaluation error
inside a v4 group, which Cedar otherwise reports only in diagnostics and skips (a skipped forbid would read as "no
match"). v1 to v3 groups keep their existing behaviour exactly; that behaviour (an erroring legacy policy is
skipped) is recorded as an open question for the ABAC owner, not changed here.

#### 38. New policies default to v4, with help text

`ABAC_CURRENT_SCHEMA_VERSION` is `v4`. The backend routes default to it; the web app sends no schema version, so it
needs no change. Under v4 an unscoped `principal` may be an `Agent`, so strict validation refuses a policy that
reads a person-only attribute without `principal is RegulAIt::User`, and an agent-only attribute without
`principal is RegulAIt::Agent`. Such errors carry `ABAC_V4_PRINCIPAL_HELP`, which the editor's existing help line
shows. Stored v1 to v3 policies are untouched. The two kernel tests and the one gateway test written against "the
current version" for person attributes now name `is RegulAIt::User` or `v3`.

#### 39. Required `actor` everywhere, and the S4 hand-off

`governedEvaluate`'s `opts` is now required, with `actor: GovernedActor | null`. Its earlier optional positional
parameters become explicit `T | undefined` parameters, because a required parameter cannot follow optional ones.
Every production call site the compiler flagged passes `actor: null` and carries `// ADR-0188 S4 replaces`, for S4
to replace with the built chain. There are 21: `agents-connectors.ts` (3), `app.ts` (2), `compat-core.ts`,
`compat-models.ts`, `connector-call.ts`, `copilot.ts` (2), `decompose.ts`, `evals.ts`, `mcp-protocol.ts` (2),
`mcp-proxy.ts`, `orchestration.ts` (2), `policy-simulation.ts`, `redteam-agentic.ts` (2) and `regulait-llm.ts`. No
governed-path logic changed. Tests pass `actor: null`.

#### 40. Property tests, and the ADR-0176 admission of `fast-check`

`fast-check` 4.10.2 (MIT, released 2026-09-19, one runtime dependency `pure-rand` 8.4.2, MIT; no npm advisory for
either) is an exact-pinned devDependency of `@regulait/policy-kernel`, listed in the package's new
`THIRD_PARTY.md`; it is test-only. `src/actor-properties.test.ts` runs P1 to P7 under fixed seeds, 1,500 runs
each, over a deliberately small universe so that generated rights overlap the call:
- P1: soundness on all three paths. An allowed call lies inside every link's own rights.
- P2: narrowing on all three paths. An actor never widens the sponsor's decision.
- P3: `sponsor_only` with a clean chain equals the sponsor alone.
- P4: the scope algebra. Subset is reflexive and transitive, covering is preserved upward, and the semantics are
  strict.
- P5: anti-monotone in rights. Removing a grant or scope entry never turns a deny into an allow.
- P6: a forged or inconsistent chain is refused `actor-chain-invalid`.
- P7: past the depth limit is `delegation-depth`; a spent leaf is `delegation-budget`.

Each property asserts a floor on how often it reached its interesting case. Two negative controls must find
counterexamples: P1 against a decider that consults only the leaf's own grants, and P4 against write-implies-read
covering. Eight deliberate kernel mutations were each shown to turn unit tests and properties red: leaf-only
grants, a union of grants, a spent leaf allowed, depth off by one, liveness ignored, write implies read, actor Cedar
ignored and unknown cost ignored.

## Rollout: slices (one PR each)

Hot files as in earlier batches: `schema.ts`, migrations, `app.ts`, `auth.ts`, `route-classes.ts`,
`openapi-registry.ts`, the lockfile and shared zod belong to the foundation owner; other slices ask for one-line
changes. The kernel package and the gateway Cedar wiring (`abac.ts`, `abac-principal.ts`) are touched only by S2
(decision 18). *Amended after X31:* the schema contracts for provenance (12), replay claims (14), reservations (16)
and the audit cutover (19) are settled in this ADR before S1, so S1 freezes them once.

| Slice | Content | Depends on | Parallel? |
|---|---|---|---|
| **S0 spike** (research, no product code) | `oidc-provider` 9.12.2 under Fastify behind our real hooks (auth, route classes, body limit, timeout, rate limit, audit), Postgres adapter, two replicas; the decision 14 replay claim inside the provider, proven with concurrent requests; RFC 8693 + DPoP per decision 15; the decision 13 verifier around `oauth4webapi` (DPoP) and the mTLS branch; `pkijs` X.509-SVID and mTLS path validation offline with the decision 21 profile and the forwarded-header rules; JWT-SVID signatures with `jose` from an uploaded bundle; exact-pinned licence closure with notices (decision 20). Output: a research note and go/no-go for decision 7 | none | **Yes**, with S1; must close before S5 |
| **S1 foundation** | Migration (`workload_identities`, `workload_credentials`, `delegation_grants` with provenance and micro-dollar columns, `delegation_allocations` and `delegation_charges` (decision 22), `issued_tokens`, `replay_claims`, `identity_signing_keys`, `audit_chain_versions`, audit/trace/usage columns, the v2 serialisation code path; the v2 cutover itself is not run here), `schema.ts`, shared zod and constants, step-up kind `identity_manage`, settings with strict defaults and audited relaxation, every new route as a 501 stub, `AuthContext.via` gains `workload` | none | serial (owns hot files) |
| **S2 kernel and Cedar wiring** | `ActorChain` required on the three kernel inputs; intersection semantics and new rule ids; Cedar v4 (`Agent` entity, `actorChain`, `delegationDepth`) and the per-principal evaluation of decision 18 in the gateway ABAC wiring; property tests | S1 (types only) | **Yes**, with S6 |
| **S3 issuer and grants** | `delegation.ts` (refuse-over-scope creation, decision 22 edge allocations with idempotency, per-edge settlement, release sweep, the decision 23 authorization check, cascade revoke, the decision 17 live-chain query), signing-key management and rotation, JWKS route, token mint and the decision 13 verifier | S1, and S2's `ActorChain`/scope types | after S2's types land; then **yes**, with the rest of S2 and S6 |
| **S4 in-process wiring** | Creates the internal identities and grants **before** any agent path requires them (one first-load step, then the paths switch on); grants through `executeGovernedDispatch` / `ToolCall` / `ConnectorCall`; orchestration lead→worker child grants (ceiling folded in), builder turns, schedules, engine runs; audit, trace, usage and receipt stamping; then the audit v2 cutover (decision 19) after all replicas run v2 code | S2, S3 | serial (orchestration, builder, mcp-proxy) |
| **S5 token endpoint and external callers** | `/oauth/token` token exchange per decision 15, client auth (`private_key_jwt`, mTLS, SPIFFE), DPoP and nonce, revocation and introspection; delegated tokens accepted on `/mcp/:serverId` and the compat routes; RFC 9728 `authorization_servers` | S3, S0 closed | **Yes**, with S4, only with the split stated here: S5 owns `auth.ts` and `oauth/`, S2 owns the ABAC wiring, S4 owns the governed call paths; none edits another's files |
| **S6 admin UI** | Agent identities page (create, bind key or SPIFFE ID, suspend, revoke, stewards), grants editor for agent principals, "proposed grants from observed usage", delegation chain in traces, audit and the agent card | S1 stubs | **Yes** (web only); its acceptance and merge come after S4/S5's real routes |
| **S7 retire bearer workload secrets** | Engine runners and PDP clients move to `private_key_jwt` + DPoP; `rge_` and `pdp` virtual keys removed only after tests prove the migrated clients keep the engine-key ceilings, project pinning and sponsorship of ADR-0187 | S5 | serial |
| **S8 outbound MCP identity** | `identity_propagation` on upstream connects (signed assertion per call) | S5 | **Yes**, with S7 and S9 |
| **S9 SPIFFE backend and docs** | Trust-bundle management, SVID client auth end to end, BYOC and air-gapped runbooks (each command executed, M-041) | S5 | **Yes**, with S7 and S8 |

## Test strategy

Every rule gets a red proof (the test fails with the control removed, then passes), in the house style of
`pillar7-inheritance.test.ts`: attacked from outside, through the real app, at execution time, with an upstream
counter that must stay at zero for every refusal.

**A sub-agent can never exceed its parent (pillar 7).**
- A child requests a tool outside the parent's scope → refused `delegation-scope`, zero upstream calls.
- The child agent's own grants lack a tool the sponsor has → refused `agent-allow-list` (I7: not the union).
- The sponsor lacks a tool the agent has → refused (the agent cannot lend its rights to a person).
- Requested budget above the parent's remaining → refused at creation; spend in the child that would cross any
  ancestor's remaining → refused at the next call.
- (X31, decision 16) Two siblings each asking for 60 under a parent with 100 remaining, sent concurrently → exactly
  one granted. A descendant's spend is counted once at each ancestor (reserved or settled, never both). A retried
  request with the same idempotency key (lost reply) reserves once. Cancelling or expiring a child returns only its
  unspent amount. An unpriced call under a capped grant is refused. Over-scope requests are refused, never narrowed.
- (X31 recheck, decision 22) Every row of the three worked-example scenarios, as an integration test with balances
  asserted after each step: root 100 → B 100 → C 1 is admitted; B 60 → C 40 leaves the root's reservation for B at
  60 and a root sibling can take the other 40; C spending 10 gives root S 10 / R 50 (without D), B S 10 / R 30, C S 10;
  releasing C returns 30 to B only; closing B returns 50 to the root; the same usage row settled twice changes nothing;
  a first-crossing overrun at a leaf lands as settled at each ancestor once and the next call under that ancestor is
  refused.
- (X31, decision 17) Suspend, halt or revoke the credential of the **middle** actor without touching its grant row, or
  remove a tool from the middle actor's own grants or from the sponsor's role → the leaf's next call is refused; a
  sibling under the root keeps exactly its own narrowed scope. A forged or substituted `act`, path or depth in a
  request changes nothing. A turn held open across a revocation is refused at its next effect.
- (X31, decision 18) Legacy v1–v3 forbids still bind the sponsor; with no Agent policies an agent gains nothing beyond
  its grants; an Agent forbid or approval rule narrows; a malformed v4 evaluation refuses without breaking installs
  that have no v4 policy; no human attribute appears on the `Agent` entity.
- Depth `max + 1` → refused `delegation-depth`.
- Revoking the sponsor's grant after the child was created → the child's next call is refused (execution-time, not
  plan-time).
- A property test over generated grant sets and chains: for every allowed call, the call is inside every link's own
  rights. A dependency for property tests needs its own ADR-0176 check (none is in the lockfile today).

**A stolen token is useless off its binding.**
- Replay with no DPoP proof, with a proof signed by another key, with a proof for another `htm`/`htu`, with a reused
  proof `jti`, with a stale `iat`, or without the current nonce → 401 each.
- A certificate-bound token presented over another certificate, or with no client certificate → 401.
- Wrong `aud`, wrong `env`, expired, `alg: none`, unknown `kid`, a key retired past its overlap, a token signed by a
  workload's own key instead of the issuer's → 401 each.
- A client assertion replayed (same `jti`) or older than 5 minutes → refused at the token endpoint.
- Two gateway replicas share the replay store: a proof used on replica A is refused on replica B.
- (X31, decision 14) The same client assertion, token-endpoint DPoP proof, resource DPoP proof and human delegation
  proof each sent **concurrently** to two real replicas (forced interleaving, as Codex's probe did) → exactly one
  accepted and exactly one grant or reservation; then sequential repeats and a restart → still refused; the loser's
  failure never rolls back the winner's claim. A contract test fails if the pinned `oidc-provider` changes its replay
  call order.
- (X31, decision 13) A proof 61 s old, a proof with no or a stale nonce, a proof whose `jti` was used once, a token with
  two `cnf` members or none, and a `x5t#S256` token on the DPoP branch → 401 each, through real routes, on both the
  DPoP and the mTLS branch.
- (X31, decision 15) Parent A → child B succeeds only with B's client authentication **and** A's proof, and the result
  carries `cnf` = B's key and an `act` rebuilt from the stored path; a stolen parent token without A's proof, a wrong
  child assertion, a swapped project, env or resource, and a reused human delegation proof → refused each.
- (X31 recheck, decision 23) The intended child with A's authorization succeeds. With A's genuine, unused
  authorization: a different authenticated child, a DPoP key other than `child_cnf`, a changed `authorization_details`,
  `resource`, `project_id`, `env`, cap, depth or lifetime → refused each, **and** the authorization is still unclaimed
  afterwards (the intended child then succeeds). A first-use race between the intended request and a substituted one
  on two replicas admits only the intended one. A parent bound by `x5t#S256` is refused
  `mtls_parent_handoff_unsupported`.
- (X31, decision 21) An unknown CA, an expired or not-yet-valid certificate, a wrong SAN or trust domain, a leaf with CA
  set or without `digitalSignature`, a broken path, and a forwarded-certificate header from an untrusted or
  unauthenticated peer → refused each; a genuine SVID validates offline with no network access.

**Revocation is immediate.**
- Revoke a root grant, then call with a child's still-unexpired token in the same second → refused; the test asserts
  no cache by doing this without any wait.
- Suspend the agent identity, disable the sponsor (ADR-0022), halt the agent (ADR-0124), revoke a registered key → each
  refused at the next call, with its own refusal code.
- (X31, decision 12) Mint with client key A and DPoP key B, then revoke A while identity and grant stay active → the
  token, its grant and every descendant are refused before any upstream call. Revoke only B → tokens bound to B are
  refused, the grant survives. Rotate A → old tokens live to expiry, audit names the same identity, and a revoked key
  is never revived by a rotation.
- Cascade: revoking the middle of a three-deep chain kills the leaf and leaves the root usable.

**Audit and evidence.**
- Every agent-made audit row has `user_id` = the sponsor and an `actor_chain` matching the grant path.
- The hash chain verifies across the v1→v2 boundary; editing `actor_chain` on a v2 row fails verification.
- Receipts and traces carry the same chain; a rotated issuer key does not break verification of older receipts.
- (X31, decision 19) Mixed v1 and v2 rows verify; changing a v2 row's version to 1, or removing its version, fails; an
  append racing the cutover cannot land a v1 row past the boundary; a v1-only binary refuses to boot once a boundary
  exists; bounded verification from a mid-chain `seq` finds the boundary; receipts and anchors verify across it.

**Regression.** `pillar7-inheritance.test.ts`, the ADR-0124 kill-switch suite and the ADR-0187 engine suites pass
unchanged in behaviour; a relaxed `agent_entitlement_mode = sponsor_only` reproduces today's decisions exactly and is
audited. Secret material never appears in a response, log, trace or audit row (the credential-inventory scan extended
to the new tables).

## Consequences

- RegulAIt can claim "least privilege for agents" once S4 ships with `own_grants` on, and can say what each agent is
  allowed to do on its own, which ROADMAP §7.3 currently forbids. *Amended (X31):* the claim covers only the paths
  actually wired (in-process after S4, external after S5), and product text must say separately that human-owned API
  keys and `dispatch`/`engine` virtual keys remain bearer credentials and that cross-domain hops are deferred.
- Revocation means the **next** governed use reads committed live state and is refused; an effect already dispatched
  cannot be recalled.
- Pillar 7's "never exceeds" becomes a stored, per-hop, checked-on-use object instead of a property of how the
  orchestrator happens to call the kernel.
- Remote workers, BYOC execution planes and engine runners get a standard way to prove who they are, with no
  long-lived bearer secret.
- The kernel input changes for every call site (required field), and the Cedar schema moves to v4. Existing v1–v3
  policies keep evaluating against `User`.
- Every existing agent starts with no grants of its own under the strict default; admins must grant, helped by the
  observed-usage proposal (OWNER DECISION 1).
- We take on running an OAuth token endpoint and a signing key, and keeping both maintained. HSM-backed issuer keys stay
  owner-gated with HSM/FIPS (ADR-0183).
- A per-call grant lookup adds one indexed query to every agent-made call. S4 measures it; it does not get a cache,
  because a cache is what would make revocation non-immediate.

## Owner decisions (accepted 2026-10-10)

The owner accepted every recommendation below as written ("accept all on ADR-0188", 2026-10-10). Each item is now a
decision, not an open question. Two of them still carry a dependency the acceptance does not remove: item 2's library
choice stands only if spike S0 passes (otherwise the written `jose` fallback with its ADR-0176 §4 exception applies),
and item 5 still needs the suite agent to confirm RegulAIt owns PF-02 before S5 freezes the identifier and claims
contract; S1–S4 proceed meanwhile.


1. **OWNER DECISION — first grants for existing agents.** Under `own_grants`, every `agents` and `builder_agents` row
   starts with an identity but no grants, so agent calls are refused until an admin grants. *Recommended:* keep the
   strict start (ADR-0180: no grandfathering) and ship, in S6, a one-click "propose grants from the last 30 days of
   observed use" (the inventory already separates granted from observed, ADR-0082) that an admin reviews and accepts;
   the demo seed grants its own agents explicitly. Alternative: copy each agent's owner's grants (rejected: that is the
   union I7 exists to remove).
2. **OWNER DECISION — token endpoint library.** *Recommended:* `oidc-provider` (MIT) for the token endpoint, client
   authentication, DPoP, mTLS, JWKS, revocation and introspection, and `oauth4webapi` (MIT, already locked) on the
   resource side, if spike S0 shows they mount under Fastify, keep state in Postgres across replicas, and have a clean
   transitive licence inventory. If S0 fails, a narrow token-exchange endpoint on `jose` with a written ADR-0176 §4
   exception naming the unmet requirement. Note: `oidc-provider` has one primary maintainer; ADR-0177 forbids that only
   for a required **sidecar**, not a library, but the owner may want it recorded. *Amended (X31):* the libraries do
   cryptography and protocol parsing only; replay claims (decision 14), the resource verifier's freshness, nonce and
   replay rules and the mTLS branch (decision 13), and X.509 path validation with `pkijs` (decision 21) are ours or
   another pinned module's. Codex's isolated install found 41 runtime packages, all MIT or ISC; S0 must still pass.
3. **OWNER DECISION — sender constraint.** *Recommended:* DPoP by default, mTLS where the deployment offers it, and an
   unbound bearer delegated token never issued and never accepted (an invariant, not a relaxable setting). This is the
   one place this ADR deliberately departs from "an admin may relax every setting", because a relaxed binding is the
   exact token-theft path the ADR exists to close.
4. **OWNER DECISION — which human credentials may start a delegation.** *Recommended:* a browser session, or an API
   key whose owner meets the MFA rule (ADR-0181 FX2); never the bootstrap token (no user) and never a virtual key
   (already a delegated credential). Starting a delegation with `write` scope on a sensitive project needs a step-up, as
   approvals do (ADR-0186).
5. **OWNER DECISION — suite gating.** ENTERPRISE_READINESS_PLAN C1 marks PF-02 "suite-gated", PathForward asks for a
   suite-level workload-identity RFC, and CLAUDE.md says to check the suite capability map before building what another
   module may own. The suite documents are not reachable from this session. *Recommended:* the suite agent confirms that
   RegulAIt owns agent delegation for its own gateway; S1 to S4 (internal) proceed meanwhile; the identifier format
   (decision 2) and token claims (decision 5) go to the suite as an RFC before S5 freezes the wire contract.
6. **OWNER DECISION — identity sent to upstream MCP servers.** *Recommended:* default `none` (send nothing: the strict
   choice for data minimisation, since an upstream is a third party), with per-server opt-in to `signed_assertion`
   using pairwise subjects and no email or name, audited. Alternative: on by default so upstreams can verify the
   gateway (better provenance, more disclosure).
7. **OWNER DECISION — defaults for lifetime and depth.** *Recommended:* token lifetime 300 s (maximum 3600), delegation
   depth 3 (maximum 8), registered workload keys at most 90 days.
8. **OWNER DECISION — retiring bearer workload secrets.** *Recommended:* after S7, remove `rge_` runner tokens and
   `pdp` virtual keys with no grace period (the product is not live). `dispatch` and `engine` virtual keys stay for
   human-owned API clients, since they are a person's scoped key, not an agent's identity; whether they also become
   DPoP-bound is a follow-up.
9. **OWNER DECISION — over-scope requests.** When an agent asks for more scope, depth or budget than its parent has:
   *recommended* refuse in v1 with the reason; routing it to the approvals queue as an out-of-band human approval
   (the AIMS draft's CIBA pattern) is a later slice. *Amended (X31):* decision 16 makes this the single public
   contract (refuse, never narrow); the owner's answer here can only change it in a later ADR.

Not decided here: cross-trust-domain chaining for real BYOC execution (needs a named account; ADR-0183 owner-gated
list); CAEP/RISC shared-signals revocation feeds; HSM-backed issuer keys; implementing the WIMSE proof-token and HTTP
message signature drafts on the wire before they are RFCs.

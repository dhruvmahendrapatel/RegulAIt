# ADR-0188: Batch 6 item 1 — per-agent and workload identity, and constrained delegation

- **Status:** Proposed (design only; nine OWNER DECISION items below, each with a recommended answer)
- **Date:** 2026-10-10
- **Deciders:** owner (pending); the rest follows ADR-0180 (secure by default) and ADR-0176 (open source first)
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

**Numbers.** Latest migration on `main` is `0175_model_artifact_scans`; the build takes the next free number at the
time (0176 if nothing lands first), with the journal `when` rule of CONTRIBUTING_PARALLEL_SESSIONS §4.

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

## Decision (recommended; becomes Accepted when the owner signs off the OWNER DECISION items)

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
`context.delegationDepth > 1`". The principal entity stays `User` for the sponsor; Cedar evaluates the agent as a
second request with principal `Agent`, and both must permit. Trust or risk scores are never an input to an allow
(PF-02 guardrail); they may raise `require_approval`.

**OWNER DECISION 1** sets how existing agents get their first grants.

### 4. Delegation grants: the unit of authority, checked on every use

New table `delegation_grants` (one row per delegation; none is ever updated except to revoke or record spend):
`id`, `root_grant_id`, `parent_grant_id`, `path` (ordered ancestor ids), `depth`, `sponsor_user_id`,
`actor_identity_id`, `run_id`/`builder_turn_id`/`engine_run_id`/`schedule_id` (the context it was made for),
`project_id`, `scope` (an RFC 9396-style list: `{type: "mcp_tool" | "connector" | "agent", server/connector/agent id,
tool names, modes, kind read/write}`), `budget_usd` and `spent_usd`, `environment`, `audience` (RFC 8707 resource),
`expires_at`, `revoked_at`, `revoked_reason`, `created_at`.

Rules, enforced in one module (`delegation.ts`) and asserted by tests:
- **Subset on creation.** A child's scope is computed, not requested: `requested ∩ parent.scope ∩ child-agent's own
  grants ∩ sponsor's grants ∩ lead ceiling`. An empty result is a refusal, not an empty grant. A child's budget is at
  most the parent's remaining budget, and is reserved against the parent at creation. A child's expiry is at most the
  parent's. Depth is `parent.depth + 1`, capped by `delegation_max_depth`.
- **Checked on every use, not only at mint.** Every governed call made under a grant reads the grant, its ancestors
  (by `path`), the actor identity and the sponsor in one indexed query, and refuses if any is revoked, expired,
  suspended, disabled or out of environment. There is no cache. This is what makes revocation immediate, and it keeps
  pillar 7's existing execution-time re-check (the grants may have changed since the plan) for every hop.
- **Revocation cascades.** Revoking a grant revokes every grant whose `path` contains it (one statement over a GIN
  index on `path`). Revoking an identity, suspending it, a sponsor being disabled (ADR-0022) or an ADR-0124 halt on the
  agent stops every grant naming it at the next use.
- **Budget.** Spend is charged to the grant and every ancestor in the same transaction as the usage row, so a sub-agent
  cannot spend more than any ancestor has left. This replaces nothing in the run budget (MULTI_AGENT_ORCHESTRATION_SPEC §5.2, `orchestration_runs.budget`, stays); it adds
  the per-hop cap PF-02 asks for. The first-crossing rule of ADR-0103/F03 applies unchanged and is documented as such.

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
  required (RFC 9449 §8).
- **Use check:** the resource side verifies signature, `aud`, `exp`, `env` and `cnf`, then performs the decision 4
  grant check. A valid signature on a revoked grant is refused.
- **Client authentication** for a workload asking for a token: `private_key_jwt` (RFC 7523) against a registered key,
  `tls_client_auth`/`self_signed_tls_client_auth` (RFC 8705), or a SPIFFE JWT-SVID/X.509-SVID per
  `draft-ietf-oauth-spiffe-client-auth` against a configured trust bundle. Assertions are single-use (`jti` store) and
  at most 5 minutes old.

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
continuity because audit rows name identity ids, not keys, and retired public keys stay in the table.

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
  runtime network calls of their own.

## Rollout: slices (one PR each)

Hot files as in earlier batches: `schema.ts`, migrations, `app.ts`, `auth.ts`, `route-classes.ts`,
`openapi-registry.ts`, the lockfile and shared zod belong to the foundation owner; other slices ask for one-line
changes. The kernel package is touched only by S2.

| Slice | Content | Depends on | Parallel? |
|---|---|---|---|
| **S0 spike** (research, no product code) | `oidc-provider` 9.12.2 mounted under Fastify behind our hooks, with a Postgres adapter and two replicas; `oauth4webapi` RS validation with DPoP; transitive licence inventory of both (ADR-0176 list); SPIRE JWT-SVID and X.509-SVID verified with `jose` against a static bundle, offline. Output: a short research note and go/no-go for decision 7 | none | **Yes**, with S1 |
| **S1 foundation** | Migration (`workload_identities`, `workload_credentials`, `delegation_grants`, `identity_signing_keys`, DPoP/assertion `jti` store, audit/trace/usage columns, chain serialisation v2, `org_settings` and `mcp_servers` columns), `schema.ts`, shared zod and constants, step-up kind `identity_manage`, settings with strict defaults and audited relaxation, every new route as a 501 stub, `AuthContext.via` gains `workload` | none | serial (owns hot files) |
| **S2 kernel** | `ActorChain` required on the three kernel inputs; intersection semantics and new rule ids; Cedar schema v4 (`Agent` entity, `actorChain`, `delegationDepth`) with a second evaluation; property tests | S1 (types only) | **Yes**, with S3 and S6 |
| **S3 issuer and grants** | `delegation.ts` (create child as intersection, budget reservation, cascade revoke, check-on-use query), signing-key management and rotation, JWKS route, token mint/verify module | S1 | **Yes**, with S2 and S6 |
| **S4 in-process wiring** | Grants through `executeGovernedDispatch` / `ToolCall` / `ConnectorCall`; orchestration lead→worker child grants (ceiling folded in), builder turns, schedules, engine runs; audit, trace, usage and receipt stamping; agent identity per `agents`/`builder_agents` row created on first load | S2, S3 | serial (orchestration, builder, mcp-proxy) |
| **S5 token endpoint and external callers** | `/oauth/token` token exchange, client auth (`private_key_jwt`, mTLS, SPIFFE), DPoP and nonce, revocation and introspection; delegated tokens accepted on `/mcp/:serverId` and the compat routes; RFC 9728 `authorization_servers` | S3 (+ S0 verdict) | **Yes**, with S4 (S5 owns `auth.ts` and the new `oauth/` module; S4 must not touch them) |
| **S6 admin UI** | Agent identities page (create, bind key or SPIFFE ID, suspend, revoke, stewards), grants editor for agent principals, "proposed grants from observed usage", delegation chain in traces, audit and the agent card | S1 stubs | **Yes** (web only), merges after S4/S5 |
| **S7 retire bearer workload secrets** | Engine runners and PDP clients move to `private_key_jwt` + DPoP; `rge_` and `pdp` virtual keys removed | S5 | serial |
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

**Revocation is immediate.**
- Revoke a root grant, then call with a child's still-unexpired token in the same second → refused; the test asserts
  no cache by doing this without any wait.
- Suspend the agent identity, disable the sponsor (ADR-0022), halt the agent (ADR-0124), revoke a registered key → each
  refused at the next call, with its own refusal code.
- Cascade: revoking the middle of a three-deep chain kills the leaf and leaves the root usable.

**Audit and evidence.**
- Every agent-made audit row has `user_id` = the sponsor and an `actor_chain` matching the grant path.
- The hash chain verifies across the v1→v2 boundary; editing `actor_chain` on a v2 row fails verification.
- Receipts and traces carry the same chain; a rotated issuer key does not break verification of older receipts.

**Regression.** `pillar7-inheritance.test.ts`, the ADR-0124 kill-switch suite and the ADR-0187 engine suites pass
unchanged in behaviour; a relaxed `agent_entitlement_mode = sponsor_only` reproduces today's decisions exactly and is
audited. Secret material never appears in a response, log, trace or audit row (the credential-inventory scan extended
to the new tables).

## Consequences

- RegulAIt can claim "least privilege for agents" once S4 ships with `own_grants` on, and can say what each agent is
  allowed to do on its own, which ROADMAP §7.3 currently forbids.
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

## Open questions (OWNER DECISION items, each with a recommendation)

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
   for a required **sidecar**, not a library, but the owner may want it recorded.
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
   (the AIMS draft's CIBA pattern) is a later slice.

Not decided here: cross-trust-domain chaining for real BYOC execution (needs a named account; ADR-0183 owner-gated
list); CAEP/RISC shared-signals revocation feeds; HSM-backed issuer keys; implementing the WIMSE proof-token and HTTP
message signature drafts on the wire before they are RFCs.

# ADR-0188: Batch 6 item 1 — per-agent and workload identity, and constrained delegation

- **Status:** Accepted 2026-10-10. The owner accepted all nine OWNER DECISION items with their recommended answers
  ("accept all on ADR-0188"). Design only until the build slices land. Amended
  2026-10-10 after Codex review X31 (I7R-01 to I7R-09): decisions 12 to 21 and the dispositions table; amended again
  after Codex's recheck (I7R-10, I7R-11): decisions 22 and 23. Amended again during S1 (main-session rulings from
  the S2 planning pass): decisions 24 to 28 (agent grant storage, actor order, depth, strict scope, rule ids). Amended
  again after the S5 security review (PR #302): external child exchanges refused until the signed depth is enforced,
  steward and project checks on delegation proofs, CA rules on X.509 issuers, strict root caps and lifetimes.
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
issues. *Amended (S8 item 3):* the outbound MCP hop sends a `typ`-distinct provenance JWT that grants nothing at
RegulAIt, not an access token; it is outside this decision's binding invariant (see "As built: slice S8").
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

### Amendments from the S3 build and its reviews (2026-10-10)

S3 (issuer, signing keys and delegation grants) is PR #279. Its security review and the Codex review of the PR
settled the points below. None changes a decision; items 1 to 3 record deviations or limits, and item 4 records two
fixes that later slices must keep.

1. **`max_depth` is not stored by S3. Hard blocker for S5; built in S4.** A parent's signed `max_depth` is checked
   when its child is admitted but is not persisted, so a later admission under that child consults only the org-wide
   `delegation_max_depth` (strict default 3). Until S4, a grandchild can be deeper than its parent allowed, but never
   deeper than the org limit and never wider in scope or budget. S4 adds a per-grant `depth_limit` (migration 0184):
   the child stores the smaller of its parent's remaining depth minus one and the signed `max_depth`, and every
   descendant admission enforces it. S4 carries the test: a parent signs `max_depth: 0`, the child is admitted, and a
   grandchild under it is refused `delegation-depth` although the org limit would allow it.
2. **The DPoP nonce key and the pairwise-subject key are derived from the data key.** S3 derives both with HKDF-SHA-256
   from the gateway data key (`regulait/adr0188/dpop-nonce/v1`, `regulait/adr0188/pairwise-sub/v1`) rather than from
   separately held secrets. Rotating the data key therefore invalidates outstanding nonces (clients retry with the new
   nonce, as RFC 9449 expects) and changes every pairwise `sub` (a resource server sees a new subject for the same
   person). Data-key rotation runbooks must say so; a separate, independently rotatable identity secret is a later
   option if that cost proves real.
3. **No caller may pass a client certificate to the verifier until the `pkijs` path validator lands.** The S3 mTLS
   branch compares the certificate's thumbprint with the token's `cnf` only; it does not validate the chain or the
   SPIFFE profile (decision 21). No route passes `clientCertificateDer` today. S5 must add the `pkijs` validation and
   the forwarded-header rules before any route does.
4. **Lifecycle and replay times come from the database clock.** On several replicas, a revocation on one whose clock
   trailed the one that made the key or minted a token wrote a `revoked_at` earlier than `created_at` or `issued_at`;
   the lifecycle checks then rolled the whole revocation back and left a compromised key live. Revoke and retire now
   write `GREATEST(now(), <row start>)` and select unexpired tokens by `now()`. The replay-claim sweep likewise
   selects by `now()`, the clock its delete guard uses. Later slices writing lifecycle timestamps on these tables
   follow the same rule.

Open questions carried to S5 and S6:

- Must a child's resource (audience) equal its parent's, or may it narrow to a subset? S3 requires the environment
  and project to match and leaves the audience to the binding.
- The S6 admin screens for grants (list, revoke, tree) have no backend routes yet. S5 or S6 must add them with the
  `identity_manage` step-up.

### Amendments from the S5 security review (2026-10-10)

The security review of S5 (PR #302, reviewed at 37476e9) found one high, two medium and four low issues. The main
session's rulings below are binding on S5 and the slices after it. Items 1 to 6 are fixed in S5 itself.

1. **External child exchanges are refused until the signed depth is enforced (HIGH).** The proof signs `max_depth`,
   but `createRootGrant` does not store it, and S5's interim guard refused only when the parent was itself a child
   (`depth > 0`). A person who signed `max_depth: 0` therefore did not stop the agent from authorising a child. The
   guard is now fail-closed: a child exchange is refused, before any replay claim, unless the parent grant carries an
   enforced depth limit, with `invalid_grant` and `error_code` `delegation_depth_unenforced`, audited like every other
   token-endpoint refusal. Until S4's `depth_limit` (migration 0184) exists **and** the root exchange persists the
   signed `max_depth` into it, no parent qualifies, so every external child exchange is refused. Lifting it is an
   explicit code switch, not a column check alone: S4 storing the org limit on a root does not by itself make the
   signed depth enforced. Follow-up (S4 + S5): persist min(org limit, signed `max_depth`) as the root's
   `depth_limit`, enforce it on every admission, then lift the switch, with the reviewer's probe as the test (a proof
   with `max_depth: 0`, the root exchange, A authorises child B → refused `delegation_depth`).
2. **Only a steward with access to the project may start a delegation (MEDIUM).** `POST /v1/delegations/proofs`
   checked no relation between the person, the agent and the project. Now the caller must be listed in the workload
   identity's `sponsor_user_ids` (a steward) and must be an **explicit member** of `projectId` (a `project_members`
   row). *Master ruling after the fix round:* a delegation-specific check, not ADR-0011's attribution rule: a project
   with no members is NOT open for delegation, and being an admin is not membership (ADR-0180). ADR-0011's general
   rule is unchanged. Otherwise 403 `delegation_not_steward` or `delegation_project_access`, each audited as a deny.
3. **Every issuer on an X.509 path must be a CA (MEDIUM).** `pkijs` 3.4.1 `CertificateChainValidationEngine` checks
   signatures and validity but not `basicConstraints.cA`, the `keyCertSign` key usage or `pathLenConstraint` on
   issuers, so a leaf certificate could sign another leaf. After the engine accepts a path, our validator walks
   `certificatePath` and requires every issuer (intermediates and the anchor) to have `cA = true`, the `keyCertSign`
   bit, and a `pathLenConstraint`, when present, at least the number of intermediates below it; otherwise
   `certificate_issuer`. Decision 21 is read with this: the engine does the path and the signatures, our code does
   the CA rules.
4. **An admitted proxy's own TLS certificate is never a client certificate (LOW).** When the socket peer is an
   admitted proxy (trusted address and authenticated, decision 21), the client certificate is the forwarded one, or
   none. The proxy's own TLS peer certificate only authenticates the proxy.
5. **A timed-out exchange leaves no live grant (LOW).** The grant and the token are created in one transaction that
   re-reads the timeout flag before it commits; an aborted request revokes the new grant in that same transaction
   (reason `request_aborted`), and a timeout that fires during the commit revokes it straight after. The request's
   audit row waits for the exchange to settle and records what really happened (`timeout`, or
   `timeout_grant_revoked` with the grant id). A refusal is never recorded while a live grant exists.
6. **Strict root-grant defaults (ADR-0180).** Three new org settings, all strict, relaxed only through the audited
   `PUT /v1/org/settings` with the `settings_relax` step-up (migration 0188):
   - `delegationUncappedRootAllowed` (strict `false`): a root grant with no cap is refused
     (`delegation_cap_required`) unless an admin turns this on.
   - `delegationRootDefaultCapMicros` (strict `0` = none, so the person must name a cap): the cap applied when a
     person names none. Setting one, or raising it, is a relaxation that needs the `settings_relax` step-up (master ruling, confirmed).
   - `delegationRootMaxLifetimeSeconds` (strict 900): the longest root grant. The default lifetime is 15 minutes (not
     1 hour); a longer request is refused (`delegation_lifetime`) unless an admin raises the limit (up to 24 h).
   The proof route and the root exchange both enforce them, so a setting tightened between the two still applies.
7. **Introspection reads `aud` as one string,** as the token endpoint does: a client assertion's `aud` must be exactly
   the token endpoint URL (not an array containing it), and a token whose `aud` is not a single string is inactive.

8. **The delegation step-up binds the whole authority (Codex X45 I7S5-02, MEDIUM).** The `identity_manage` step-up
   for a write delegation on a classified project bound only the agent, project and resource, so a grant approved for
   a narrow delegation could sign a wider one. Its facts are now the whole intended authority, computed after the cap
   and lifetime are resolved: `op`, `agentIdentityId`, `projectId`, `resource`, `env`, `authorizationDetails`, the
   resolved `capMicros`, `maxDepth`, the resolved `lifetimeSeconds` and `agentKeyThumbprint` (or null). The 403
   returns exactly these as `action.body`, and the client posts that object verbatim to `/v1/auth/step-up/options`
   (no web client calls the proof route yet; S6's must echo it). A grant for other facts is refused and not spent.
9. **Replay claims outlive their signed window on any process clock (Codex X45 I7S5-04, LOW).** The adapter added the
   provider's process-relative `expiresIn` to the database clock, so under process skew a claim could expire before
   the signed window ended. A `client_assertion` claim now lasts at least until the verified `exp` plus the 5 s
   allowance; an `as_dpop` claim at least until the proof's `iat` plus its 60 s acceptance age plus 5 s.

Recorded with these:

- **A child's resource is its parent's audience, strictly, for v1.** This answers the S3 open question above. A child
  may not narrow to another audience; revisit only on a proven multi-audience need.
- **Workload-identity CRUD belongs to S6's backend,** under the `identity_manage` step-up, in one module beside
  `oauth/grant-admin.ts`. Steward edits (`sponsor_user_ids`) and the SPIFFE trust bundles move from environment
  variables into audited storage in S9.

### Amendments from the S4 build and its review (2026-10-10)

S4 (in-process wiring) is PR #326. These record what S4 built where the decisions left a choice. None changes an
owner decision.

1. **First load gives identities, never grants.** `ensureInternalIdentities` (boot) and `ensureIdentityFor` (first use)
   give every `agents`, `builder_agents` and `engine_runners` row its one identity: `active`, allowed only in this
   deployment's mode (`hosted | byoc | air_gapped`), steward = the subject's owner or the system principal, no grants
   (OWNER DECISION 1, ADR-0180). An admin grants through `PUT /v1/workload-identities/:id/grants` (built in S4 with
   the list, detail and grant-set read; `identity_manage` step-up). The demo seed grants each demo agent itself that
   way. Identities and delegation grants are never deleted, so an agent, person or project they name can no longer be
   hard-deleted (tests skip them in cleanup).
   **Stewards bound what may be granted (S4 amendment 1, follow-up N1 from the #326 review):** a grant-set write is refused 422
   `grant_exceeds_stewards`, audited, when an item is held by none of the identity's stewards (`sponsor_user_ids`:
   their own direct or role grants minus revocations; a connector in its mode and for every listed object). The
   system principal holds nothing, so an unowned agent's identity is granted nothing until an admin names a person
   (`PATCH /v1/workload-identities/:id`, built for this; `identity_manage` step-up bound to the change). The
   at-use intersection (decision 3) is unchanged. The PUT's step-up is bound to the identity, the revision and a
   canonical digest of the set (N2), so a step-up for one set is never good for another.
   **Fix round from the #336 review.**
   - **Changing the stewards (M1).** A PATCH that changes the stewards re-checks the identity's CURRENT grant set
     against the proposed stewards in the same transaction. If an item is no longer held it is refused 422
     `grant_exceeds_stewards`, with a deny audit row. When a steward later loses a grant, nothing cascades: the
     drift is bounded at use by the sponsor intersection (decision 3). Revocation cascades are not built.
   - **"Holds" (L3).** It is the steward's direct and role grants minus the steward's revocations, the same
     subtraction as `sponsorGrantsMiss`. A whole-server revocation (`tool_name IS NULL`) takes every tool and the
     server grant. An agent or connector revocation also takes a role-derived grant.
   - **Locking (L5).** The check reads those grant, assignment and revocation rows `FOR SHARE` inside the write's
     transaction.
   - **Digest (L2).** The set digest is the canonical JSON of structured, sorted entries; no strings are joined.
   - **Auditing (L4).** Every PATCH refusal writes a deny audit row: `identity_not_found`, revoked,
     `steward_not_found` and `grant_exceeds_stewards`. The PATCH step-up is bound to the identity and a digest of
     exactly the change.
2. **One chain per piece of work.** A pillar-7 node dispatch gets a root grant from the initiating user to the top
   lead's agent and one child per lead down to the worker (consecutive same-agent hops collapse); a builder turn or
   resumed segment, and each schedule firing, gets a root to the builder agent (context: the turn, or the schedule); an
   engine run gets a root to its runner at lease, ended with the run. Each hop carries exactly the work's needs (the
   agent in its mode, the tools and connectors the person holds and, under `own_grants`, every holder holds itself);
   the §5.1 ceiling is each child's `ceiling` input. The chain is revoked (`run_ended`) when the work returns.
3. **Lifetime and caps.** Lifetime = min(1 h, the run's own deadline), turned into an expiry inside each grant's
   transaction from `clock_timestamp()` after the locks (review M1; I7S3-01). Caps: a node's chain is capped by
   min(its §5.2 ceiling left, the run cap left); a builder chain by the agent's monthly limit left; an engine chain by
   the run's budget. **Open:** a run, builder agent or schedule with no budget gets an uncapped chain; no number is
   invented.
4. **The person first.** Where the person alone would be refused, the person's reason is shown (decision 30): the
   orchestration owner check and the builder step gate run before the chain is made, and on the tool path a
   `delegation-scope` refusal the person would also get reports the person's rule (a ceiling exclusion keeps
   `lead-ceiling`).
5. **Stamping.** Audit rows written while an agent acts are stamped through one async context in the chained writer:
   before the v2 boundary in `detail.delegation`, from it in the actor columns. Usage rows and trace spans carry the
   actor columns; usage is settled along the chain in the usage row's transaction. Receipts carry the chain through
   ADR-0189's v2 payload once B1's v2 emission lands (its source is these columns).
6. **The audit v2 cutover** is `REGULAIT_AUDIT_V2_CUTOVER=run` on one boot after a drained deploy; every boot refuses
   a boundary it cannot write; trigger `audit_log_v2_floor` (0184) refuses a v1 row past the boundary from any writer.
7. **Calls still decided as the person (`actor: null`).** Each is one call the person made directly, with no agent
   principal acting: the copilot narration, the eval harness and red-team dispatches, the playground, intake assist,
   the access-recommendation judge, decomposition (a draft plan; the run's workers act under grants), plan-time
   envelopes, policy simulation, routing and model listings for a person, and the MCP and compat routes for a person's
   own key. A workload caller (S5's delegated token) is decided with its grant on `/mcp` tools/call, tools/list, every
   protocol method and the logging relay, and on the compat dispatch and model listing.

### Amendments from the conformance-vector gaps (2026-10-10)

The specification vectors merged in PR #334 (`packages/shared/test-vectors/delegation/`) list six places where this
ADR left a behaviour undefined. Each item below closes one. Where the decisions already imply the answer, it is
written down. Where the code on `main` answers it securely and consistently with the decisions, the code's behaviour
is adopted and cited. Where the code is weaker, the strict rule is written and marked **code follow-up required**.
None relaxes a strict default (ADR-0180).

1. **An mTLS parent's child exchange is refused `mtls_parent_handoff_unsupported`, before the depth guard.** Decision
   23 checks the parent token first, and a certificate-bound parent fails that check: it can never hand off across
   processes in v1, whatever its depth. S5 item 1's `delegation_depth_unenforced` guard runs after the parent's
   authorization has been checked. So for a parent bound with `cnf.x5t#S256` the answer is `invalid_grant` with
   `error_code` `mtls_parent_handoff_unsupported`, today and after the depth switch lifts. Both refusals come before
   any replay claim and any allocation. *Adopted from the code:* `checkDelegationAuthorization`
   (`apps/gateway/src/delegated-token.ts`) refuses the mTLS binding before it reads anything else, and the token
   endpoint's depth guard (`apps/gateway/src/oauth/token-endpoint.ts`) runs only after that check passes. Vector
   `child-mtls-parent-active`.
2. **A child whose resource is not its parent's audience is refused `invalid_target` with `error_code`
   `audience_not_parent`.** The recorded ruling under the S5 amendments makes the parent's audience the child's only
   allowed resource. The error is `invalid_target`, the decision 15 error for a resource fault. The check runs after
   the parent's authorization (item 1) and before the depth guard, so it answers in both profiles. *Adopted from the
   code* (`token-endpoint.ts`, the child preflight). Vector `child-other-audience`.
3. **A `delegationRootMaxLifetimeSeconds` above 86 400 is refused as a malformed setting, and nothing is saved.** The
   bound is a validation limit, not a relaxation an admin may unlock. So `PUT /v1/org/settings` answers `400` with
   `error` `validation`, the same as any value outside a setting's registered limits. The refusal comes before any
   step-up is asked for, and a `settings_relax` step-up does not change it. *Adopted from the code:*
   `IDENTITY_SETTING_LIMITS` (`packages/shared/src/identity/settings.ts`, 60 to 86 400) parsed by
   `updateOrgSettingsSchema` and answered by the app's validation handler. The proof route's own `lifetimeSeconds`
   carries the same 86 400 ceiling. Vector `s5-max-lifetime-setting-over-24h`.
4. **A step-up grant made for other facts is refused as `step_up_required`, and it is not spent.** The grant is looked
   up by the digest of the exact facts S5 item 8 lists. A grant for any other facts does not match, so nothing is
   spent. The answer is the ADR-0186 refusal: `403` with `error` `step_up_required`, the current facts as
   `action.body`, and `presentedGrant: "not_valid_for_this_action"`. A `step-up-grant-refused` deny row is written.
   *Adopted from the code* (`checkStepUp`, `apps/gateway/src/step-up.ts`). Vectors `s5-step-up-other-*`.
5. **Owner decision 4's credential refusals.** Each one is a `403` before any proof is signed:
   - the **bootstrap token** (no person): `error` `delegation_proof_credential`;
   - a **virtual key** (already a delegated credential): `error` `virtual_key_scope`. The route allow-list hook
     answers first, because no virtual-key purpose lists `POST /v1/delegations/proofs`. The route's own
     `delegation_proof_credential` stays as the backstop;
   - an **API key whose owner does not meet the org MFA rule**: `error` `mfa_enrollment_required` with `credential`
     `api_key`, from the authentication hook (ADR-0181 FX2), audited `api-key-mfa-enrollment-required`.

   *Adopted from the code* (`createDelegationProofRoute`, the virtual-key hook and the MFA gate in
   `apps/gateway/src/app.ts`). **Code follow-up required:** the route's `delegation_proof_credential` refusal writes no
   audit row. Every other refusal on this route is an audited deny (S5 item 2), and refusing a person-less or
   delegated credential that tries to start a delegation is a governance decision. It must write the same
   `delegation-proof-refused` deny row, with the credential kind and no secret. Vectors `human-proof-credential-*`.
6. **The root wire names and types are recorded as S5 built them.** Decision 15 names the fields; these are their
   spellings and types. The suite RFC of owner decision 5 may still change them, but only in a later ADR.
   - **The proof request** (`POST /v1/delegations/proofs`, JSON, `createDelegationProofSchema`): `agentIdentityId`
     (uuid), `authorizationDetails` (the decision 27 scope, at least one entry), `resource` (URL), `projectId` (uuid),
     `env`, and optionally `agentKeyThumbprint` (base64url SHA-256), `capMicros` (integer micro-dollars), `lifetimeSeconds`
     (integer, 60 to 86 400) and `maxDepth` (integer, 0 to the depth ceiling). Unknown members are refused.
   - **The proof** is a JWS with `alg` `EdDSA`, `typ` `regulait-delegation-proof+jwt` and the issuer key's `kid`. Its
     claims are: `iss` and `aud`, both our issuer; `sub`, the person's user id; `jti`; `iat`; `exp`, at most 120 s
     after `iat`; `agent`, the agent identity id; `child_cnf`, the agent's key thumbprint, present only when given; and
     `delegation`.
   - **`delegation` is canonical text, not an object.** In the proof and in the child's delegation authorization
     (decision 23), `delegation` is a string: the RFC 8785 form of the body. A verifier compares that string with
     the canonical form of what it was given, byte for byte. A JSON object in its place is refused.
   - **The body** (`delegationBodySchema`, strict) has these members: `authorization_details`, `resource`,
     `project_id` (uuid or `null`), `env`, `cap_micros` (integer or `null`; `null` means uncapped and is never
     omitted), `max_depth` (integer), and `expires_at` (absolute epoch seconds). The proof route turns
     `lifetimeSeconds` into `expires_at`. The root exchange takes cap, depth and lifetime only from the signed body and
     never from the form. The child exchange restates them as the form fields `cap_micros` (decimal digits or the
     literal `null`), `max_depth`, `expires_at`, `project_id` and `env`.

   *Adopted from the code* (`packages/shared/src/identity/contract.ts`, `.../identity/delegation-authz.ts`,
   `apps/gateway/src/oauth/delegation-proof.ts`). Vectors `root-request-template` and the `request-*` family.

### Amendments from the S4+S5 follow-up (2026-10-10)

PR #339 closes S5 review item 1 and conformance-gap item 5, and turns on the two release switches. It was reviewed
independently twice under ADR-0191: once at 91bd1d6 (fix-then-merge, Lows only) and again at cfe8554 (merge).

1. **The signed depth is enforced.** The root exchange stores min(org limit at exchange, signed `max_depth`) as the
   root's `depth_limit` and sets `depth_limit_signed = true` (migration 0190). Only the root exchange sets that marker.
   The 0184 guard trigger keeps it immutable, and a CHECK keeps it off children. A child exchange is refused
   `delegation_depth` when `depth + 1 > depth_limit`. The refusal runs in preflight and again under the lock, before
   any replay claim. A child's limit is the minimum of its parent's limit and the org limit. `SIGNED_ROOT_DEPTH_PERSISTED`
   is lifted. This replaces the interim fail-closed guard of S5 review item 1.
2. **A root minted before item 1 cannot delegate.** No grandfathering (ADR-0180): a child exchange under a root whose
   `depth_limit_signed` is false is refused `invalid_grant` with `error_code` `delegation_depth_unenforced`. The
   refusal is audited and runs before any claim.
3. **Delegated routes are wired.** `DELEGATED_ROUTES_WIRED` is lifted. A workload token reaches exactly the routes in
   S4 amendment 7, each decided against its grant: `/mcp` (tools/list, tools/call, every protocol method, the logging
   relay), both compat dispatch routes, and `GET /v1/models`. Every other route is refused `workload_scope`, and a
   workload principal is never an admin. RFC 9728 metadata lists the gateway's own issuer.
4. **A workload call names exactly its grant's project.** A missing, different or repeated `x-regulait-project-id` is
   refused `403 delegation_project_mismatch`, audited.
5. **Workload rows carry the chain (decision 9).** A workload request runs inside the audit-actor context, so its
   audit, trace and usage rows carry the actor columns, as in-process chains do.
6. **A role counts as held only if nothing it bundles is revoked.** In the steward check (S4 follow-up N1), a steward
   holds a role only when none of the role's tools, servers, agents or connectors is revoked for that steward.
7. **Lock order between the steward check, revocations and role grants.** The steward check takes `FOR SHARE` on the
   role rows first, then on the people and the rows that cascade from them, in id order. Revocation inserts lock the
   person's row, and role-grant inserts (the four role-grant routes and the SoD override) lock the role row, both
   `FOR NO KEY UPDATE`. So neither can slip past an open check, and a force role delete waits on the role row instead
   of deadlocking.
8. **Gap item 5 is closed.** The proof route's bootstrap-token refusal writes a `delegation-proof-refused` deny row.

Follow-ups (Low, from the second review): a test for the SoD-override role-grant lock, and an explicit
`404 role_not_found` when `lockRoleForGrantInsert` finds no role, instead of relying on the foreign-key error.

## Spike S0 result (2026-10-10)

S0 ([R11](../research/R11-identity-s0-spike.md), Codex X32, PR #250) returned **GO** for owner decision 2:
`oidc-provider` 9.12.2, `oauth4webapi` 3.8.8 and `pkijs` 3.4.1 support the accepted profile under our real Fastify
hooks, with Postgres state shared across two replicas. The `jose` fallback in owner decision 2 is not needed. This is
a library-feasibility result only; S1 to S5 still ship the product code. S5 must keep the two integration details R11
records:

- **Check the whole delegation authorization before the first claim.** `oidc-provider` claims the client assertion
  before a custom grant handler runs, so the delegation checks go in its `assertJwtClientAuthClaimsAndHeader` hook,
  which runs after signature verification and before replay detection.
- **Use our own DPoP profile in the custom grant.** The provider's built-in nonce helper does not implement decision
  20's 5-minute HMAC nonce or decision 13's 60-second freshness rule. The custom grant enforces them itself, and the
  resource wrapper around `validateJwtAccessToken` adds nonce, freshness, live-chain and its own atomic replay claim.

S5 exact-pins the closure R11 lists in the product lockfile and carries its notices (decision 20).

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
| **S6 admin UI and its backend** | Agent identities page (create, bind key or SPIFFE ID, suspend, revoke, stewards), grants editor for agent principals, "proposed grants from observed usage", delegation chain in traces, audit and the agent card. *Ownership (2026-10-10):* Claude builds both halves (ADR-0191). The S6 **backend** owns workload-identity CRUD and the grant administration routes the S3 open question left unassigned (list, revoke, tree), under the `identity_manage` step-up, in one module beside `oauth/grant-admin.ts` (master ruling after the S5 security review, recorded with #302). The UI follows that review's rulings: delegation offered only to an agent's stewards with access to the project; a cap required on root grants unless an admin relaxed it; root grant lifetime 15 minutes by default; refusals `delegation_depth_unenforced` and `invalid_target` explained. The S3 open question on audience is answered there too: a child's resource is its parent's audience, strictly, for v1 | S1 stubs; S4/S5 for the real routes | Web part **yes**, against mocks; acceptance and merge after S4/S5's real routes |
| **S7 retire bearer workload secrets** | Engine runners and PDP clients move to `private_key_jwt` + DPoP; `rge_` and `pdp` virtual keys removed only after tests prove the migrated clients keep the engine-key ceilings, project pinning and sponsorship of ADR-0187 | S5 | serial |
| **S8 outbound MCP identity** | `identity_propagation` on upstream connects (signed assertion per call) | S5 | **Yes**, with S7 and S9 |
| **S9 SPIFFE backend and docs** | Trust-bundle management, SVID client auth end to end, BYOC and air-gapped runbooks (each command executed, M-041) | S5 | **Yes**, with S7 and S8 |

## As built: slice S6 (2026-10-12, PR #368)

S6 makes the last seven identity routes real: create identity, revoke identity, list/bind/revoke credentials, grant
proposals and picker sources. No route answers 501 any more, and the workload identities page is in the Identity &
Access navigation group. These points settle details that the decisions above leave open, or refine them after the
independent security review:

1. **Who may set an identifier.** Only external kinds (`worker_runtime`, `pdp`) may set a custom SPIFFE ID, and
   never under the reserved `/regulait/` path in our trust domain. An internal agent's identity is revoked for good:
   under "one identity per subject", its subject never gets another one.
2. **One key, one identity, ever.** A key is unique across JWK and certificate registrations. A certificate
   credential stores the RFC 7638 thumbprint of its public key (`spki_thumbprint`, migration 0193), and a key
   registered by either route is refused by the other.
3. **Revoking a credential** revokes the tokens it authenticated or that are bound to its thumbprint. It also
   revokes the grants it authenticated, whether as `auth_credential_id` or as `subject_credential_id`.
   **Revoking an identity** also revokes every token bound to any of its credentials' thumbprints.
4. **The revocation cascade can be incomplete.** Grants are revoked after the identity or credential transaction
   commits. If that cascade fails, the response says `cascade: "incomplete"` and lists the grants not revoked, and a
   `workload-identity-cascade-incomplete` row is audited. The backstop is the use-time refusal, because
   `loadLiveChain` checks every ancestor's identity and credential state.
5. **Observed use (refines owner decision 1).** Only `allow` decisions and `actor-allow-list` refusals count. A
   Cedar forbid, a sponsor denial, a guardrail or an approval hold never becomes a proposal, so an agent that keeps
   retrying a forbidden action cannot turn that into a grant. A proposal seen only as refusals is flagged
   `refusalOnly`, is left out of the default `proposedSet`, and needs the admin to opt in per item. Proposals read
   only audit decision rows (not `usage_events`) over 30 days on the database clock. The query uses two partial
   indexes (migration 0193) and has a 5 s statement timeout, which answers `503 proposals_timeout`.
6. **Audit.** Malformed requests on the write routes write a `workload-identity-request-invalid` deny row (issue
   paths only, never the values). The proposals and picker-source reads are audited, because they expose user
   emails.

## As built: slice S7 (2026-10-12, PR #380)

S7 carries out owner decision 8. Engine runners and PDP clients no longer hold bearer secrets: each holds its own
Ed25519 key, bound as the credential of its workload identity, and authenticates with a short DPoP-bound token from
`/oauth/token`. The tests for the old path were written first (the S7 suite against `rge_` and the `pdp` key) and
then switched to the new path unchanged in meaning, together with the B5 engine suites and AER-027. Migration
`0195` makes the change on first load, with no grace period and no warn-only phase (ADR-0180). These points settle
details that the decisions above leave open:

1. **The self token.** A workload of kind `engine_runner` or `pdp` takes a token for itself, not for a person, with
   the RFC 6749 `client_credentials` grant: client authentication by `private_key_jwt` (RFC 7523) with its key,
   a DPoP proof (RFC 9449, the gateway nonce required), and `resource` set to its kind's one route family
   (`<issuer>/v1/engine-runner` or `<issuer>/v1/authz/check`, RFC 8707). There is no delegation grant and no
   sponsor on the token: `issued_tokens.grant_id` is now nullable, a new `subject_identity_id` names the workload,
   and a CHECK requires exactly one of the two, with a self token always DPoP-bound. The client id may be the key's
   RFC 9278 thumbprint URI, so a key and the issuer are the whole client configuration. The token response carries
   `regulait_credential_not_after` and `regulait_credential_rotate_after` (two thirds of the key's window), so a
   client knows when to rotate without a second call. The DPoP proof must be signed by the same key that
   authenticated the client (`dpop_key_mismatch`). Issued and refused tokens are audited
   (`workload-token-issued` / `workload-token-refused`). Other workload kinds and agent identities are refused this
   grant, and a self token is never a `subject_token` or a parent in token exchange. An Ed25519 signature is
   accepted under both its labels, `EdDSA` (RFC 8037) and `Ed25519` (RFC 9864), for client assertions, DPoP proofs,
   supersede and rotation proofs: `oauth4webapi` 3.x (the runner) writes `Ed25519`, the Kong adapter and older
   clients `EdDSA`. A client's registered Ed25519 key carries no `alg` member, so the provider matches it to either.
2. **What the token reaches.** It is recognised by its audience and resolves to `via: "engine-runner"` (the ADR-0187
   runner context: the engine-key ceilings, project pinning and the runner route set, unchanged) or `via: "pdp"`
   (only `POST /v1/authz/check`; anything else answers `403 workload_scope`). Every request re-checks the token row,
   its binding, the credential, the identity's state and environment, and for a runner that the runner is not
   revoked (`401 engine_runner_revoked`). Revoking a runner, its key or its identity revokes its live tokens; a
   suspended identity's live tokens are refused too. Both kinds keep the ADR-0167 credential rate-limit tier, in a
   bucket named by their identity (`cred:wid:<identityId>`), and both are judged by `api_key_ip_policy` like an API
   key (INSTALL.md: allow the `engines` network).
3. **Runners enrol with a key.** The runner core generates the key on its own state volume (`runner-key`, mode
   0600) and registers only the public JWK with the one-time enrolment token. Registration creates the runner's
   identity (S4's `ensureIdentityFor`) and binds the key through S6's one binding path, so S6 decision 2 holds: one
   key, one identity, ever. A runner superseding its previous registration proves it with a JWS signed by the old
   key that names the new key's thumbprint, `aud` this issuer and a one-use `jti` (claimed in the replay store). The
   old key must be live now and its identity active: a key already rotated out, or expired, supersedes nothing. The runner's client is `oauth4webapi` (`clientCredentialsGrantRequest`
   with `PrivateKeyJwt` and `DPoP`, then `protectedResourceRequest`); the artifact stream rides the same client.
4. **Rotation (decision 12).** A runner rotates its own key at two thirds of the key's window:
   `POST /v1/engine-runner/credentials` with its current token and a proof by the new key binds the new key and moves
   the old key's `not_after` to now. The old key mints no new token; tokens it already has live to their own expiry.
   Rotations of one runner are serialised (the identity row is locked), and the authenticating key must still be live
   on the database clock, so a token whose key was already rotated out gets `409 credential_not_live`; a runner holds
   at most two live keys (`409 runner_key_limit`), a cap the admin bind route applies too. So a second key an admin
   binds to a runner blocks the runner's next rotation with `runner_key_limit` until it is revoked or expires; that
   is accepted (the admin owns that key, and the current key works to the end of its window). A rotation whose answer
   was lost is recovered by the runner, not retried: on `credential_not_live`, `credential_already_registered` or a
   refused token it asks whether the next key authenticates and, if so, promotes it.
   Nothing is revoked, and the identity, and so the audit trail, stays the same. A PDP client's key is rotated by an
   admin in the S6 page: bind the next key, switch the client, revoke the old credential.
5. **The bearer paths are gone.** `rge_` is no longer a credential (401 everywhere). `engine_runners.token_hash` is
   dropped and every live runner is revoked by the migration, so each runner re-enrols once with a new enrolment
   token. Every live `pdp` virtual key is revoked, a CHECK keeps any `pdp` key revoked, and
   `POST /v1/virtual-keys` with `purpose: "pdp"` answers `410 pdp_key_retired`. `dispatch` and `engine` virtual
   keys stay, as decision 8 says. The upgrade's revocations are recorded by the migration itself (its
   `revoked_at` on each row, and a revoke reason on each runner), not as `audit_log` rows.
6. **Provisioning.** Without an issuer key no self token can be issued, so a fresh install creates one: the installer
   (`identity-key-init.js`) and the gateway's first boot write `identity-signing-key.pem` to the install secrets
   volume with the receipt key's generator and strict reader, now shared (`ensureInstallKeyFile`: 0600, opened
   O_NOFOLLOW, create-exclusive, never overwritten). `REGULAIT_IDENTITY_SIGNING_KEY` still wins and is how an
   operator rotates the issuer key. `GET /v1/org/posture` (`identitySigningKey`), the signing-keys list and its card
   name the source by key id only. The issuer is `REGULAIT_PUBLIC_URL`: the installer writes `https://<domain>` when
   Caddy terminates TLS, takes `--public-url`, keeps an operator's value, and warns (does not refuse) when it cannot
   know it: a missing issuer fails closed. Runners refuse to start with an empty `REGULAIT_PUBLIC_URL` and never fall
   back to the address they dial. Both sides parse it with the one `parsePublicUrl` (now in `@regulait/shared`), so
   the runner names the issuer exactly as the gateway does; the Engines page and `GET /v1/org/posture` (`workloadIssuer`) say "issuer not
   configured". Compose passes the same value to the runners, which still dial `http://gateway:3000`.
7. **The Kong adapter (plugin 0.5.0).** `pdp_key` is replaced by `pdp_client_key` (an Ed25519 key, PEM or one-line
   base64url PKCS#8, through a vault reference) and `issuer`. The client is written over `resty.openssl`, which
   Kong bundles: no Lua library does RFC 7523 and RFC 9449 on the client side with EdDSA (ADR-0176 §4), so only the
   two compact JWS are put together here. `test/workload_spec.lua` runs the real library under LuaJIT and checks
   RFC 8037's published thumbprint vector. `verify.mjs` provisions the PDP identity and key; the live Kong run is
   pending its first CI run.
8. **Rule ids.** `workload-token-issued`, `workload-token-refused`, `engine-runner-key-rotated`,
   `engine-runner-key-rotation-refused`.

Not done in S7 and left open: whether `dispatch` and `engine` virtual keys also become DPoP-bound (decision 8's
follow-up); automatic rotation for PDP clients (it is admin-driven today); which steward an installer-provisioned
PDP identity should name when the PDP client is not provisioned by a person.

## As built: slice S8 (2026-10-12, PR #379)

S8 builds decision 8's gateway-to-upstream hop. A server whose `identity_propagation` is `signed_assertion` gets a
signed assertion on each call: who the call is for and who is acting. OWNER DECISION 6 keeps `none` as the default.
S8 needs no migration, because the column and its CHECK exist since migration 0180 (S1). The format is documented in
`docs/api/MCP_IDENTITY_ASSERTION.md`, and the code is in `apps/gateway/src/mcp-identity-assertion.ts` with constants
in `packages/shared/src/identity/mcp-identity-assertion.ts`. These points settle what decision 8 left open:

1. **The claim set (data minimisation).** An assertion carries exactly `iss`, `aud`, `sub`, `iat`, `exp`, `jti`, and
   `act` when an agent acts. Nothing else is sent.
   - `sub` is the person, as the S3 pairwise subject (an HMAC of the audience and the user id, keyed from the data key).
     It is stable for one server and cannot be linked across servers.
   - `act` is the stored chain in RFC 8693 nesting (`actClaimFromChain`, the same function the delegated tokens use),
     the acting agent outermost. Each agent is named by a **pairwise** id: an HMAC of (audience, workload identity id)
     under the S3 pairwise key, domain-separated from `sub` (`pairwiseActor`).
   - Never sent: the email, display name, user id, an agent's SPIFFE ID or any admin-typed identifier, roles, project,
     grant id, environment, tool arguments, scope and budget.

   *Why:* OWNER DECISION 6 asks for "pairwise subjects and no email or name". An upstream needs to recognise a person
   and an agent, not to know who they are. The first build sent each agent's global SPIFFE ID. The #379 security
   review (MEDIUM) showed that two upstreams could then join on `act.sub`, and through it on the person, which undoes
   the pairwise `sub`; and an external identifier is admin-typed text that can carry a name. So agents are pairwise by
   default (ADR-0180). The audit row keeps the internal identity ids beside the pairwise ids, so an operator can map
   one back.

   *Built in the S8 follow-up (2026-10-15, migration 0196):* the review also asked for a separate, opt-in per-server
   relaxation, "disclose agent workload IDs". See "As built: S8 follow-up" below. Pairwise agent ids stay the default.
2. **The format, from standards (ADR-0176).**
   - It is an RFC 7519 JWT, signed with EdDSA by the issuer's current key. It verifies against the existing S3 JWKS
     (`/.well-known/jwks.json`) with any JOSE library.
   - It uses explicit typing (RFC 8725 §3.11): `typ` is `regulait-mcp-identity+jwt`. Our decision 13 verifier requires
     `at+jwt` and exactly one `cnf`, so an assertion can never be used as a delegated access token, and a delegated
     access token never passes for an assertion.
   - `aud` is the server's canonical URI in the MCP authorization spec's sense: scheme, host, port and path, with no
     query, fragment or credentials. A URL that carries a secret in its query never puts it in a token.
   - The lifetime is a fixed 60 s, as decision 8 says. It is not a setting.
   - The header is `RegulAIt-Identity-Assertion`, not `Authorization`. Under the MCP authorization spec,
     `Authorization` carries the upstream's own access token.
   - Considered and not used:
     - RFC 7523 (an assertion presented to a token endpoint, not to a resource);
     - Transaction Tokens (one trust domain only);
     - the WIMSE `Workload-Identity-Token` header (an Internet-Draft; this ADR keeps WIMSE wire formats off until they
       are RFCs).
3. **Decision 5 and sender constraint.** The assertion carries no `cnf`. Decision 5's invariant is about access
   tokens, which grant use of a RegulAIt resource and so must be bound to their holder. The assertion grants nothing
   at RegulAIt (item 2). It is provenance that the gateway presents once, over the egress-guarded connection, to the
   one audience it names. Replay is bounded by the 60 s lifetime and the per-request `jti`. **Scope of decision 5:** a
   `typ`-distinct provenance JWT that grants nothing at RegulAIt is outside decision 5's sender-binding invariant; the
   invariant still covers every token RegulAIt accepts.
4. **When it is sent.**
   - One holder is created per governed call (`outboundIdentityFor`) and installed on that call's connection. It uses
     the MCP SDK's fetch middleware hook (`createMiddleware`) over the egress-guarded fetch.
   - The holder is armed only after the call is allowed, before the connect and before any approval is consumed. It is
     armed for one JSON-RPC method: `tools/call`, or the method of a governed protocol call.
   - Only a request message of that method carries an assertion, and every such request gets a new one with its own
     `jti`.
   - `initialize`, notifications, the event-stream GET, the session DELETE and the pre-decision manifest sync carry
     nothing.
   - A forged value in the header is removed.
   - A request to any origin other than the one the assertion names is refused before it leaves.
   - The signing key is captured when the holder is armed, so nothing is re-selected at send time.
   - In-process chains (S4) and workload callers (S5, through the proxy route, which now receives the data key) send
     their chain in `act`.
5. **Fail closed, and audit every disclosure.**
   - An opted-in server never receives a call without its assertion. If there is no issuer (`REGULAIT_PUBLIC_URL`), no
     data key, no canonical audience, no active signing key, or the server is stdio, the call is refused before the
     call or any identity is sent. The refusal is a `mcp-identity-assertion-unavailable` decision deny with a `code`.
     That makes `mcp-identity-assertion.ts` a B2 decision writer (ADR-0189), and it is now on the B2 list.
   - A refusal at send time (a request bound for another origin, the signature fails, or an audit write fails) writes the
     same deny and throws `IdentityAssertionRefusedError`, which `classifyUpstreamError` names as our own refusal:
     never retried, never charged to the upstream's breaker, and mapped to "Denied by policy" on the proxy route.
   - Every assertion sent writes `mcp-identity-assertion-issued`. The row is written in the egress guard's
     `beforeSend` hook (which now receives the request's init): after the destination check allowed the request and
     just before it leaves. A request the guard refuses leaves no row, and a request whose row cannot be written is not
     sent. The row holds the `jti`, `kid`, audience, pairwise `sub`, the method, the pairwise actor ids and the
     identity ids they stand for. It never holds the token.
6. **The setting is a relaxation (ADR-0180), following the #378 pattern.**
   - `PATCH /v1/servers/:serverId` accepts `identityPropagation`.
   - Turning it on needs a `settings_relax` step-up. The facts are `{op: "mcp_server_update", serverId, url, values:
     {identityPropagation: "signed_assertion"}}`. The url is always bound, because it is where the identity will go.
     If the same request also opens private ranges, both values go in one step-up.
   - Every change is audited (`mcp-server-identity-propagation-changed`, with both values and the audience).
   - **Consent does not follow the url.** A url move that does not name `identityPropagation` turns it off: the strict
     value, audited with `resetByUrlMove`, and no step-up is needed. A url move that keeps it on is a relaxation bound
     to the new url.
   - The compare-and-set of that write now also compares `identity_propagation`.
   - **One audience, one opted-in server.** Turning it on for a server whose canonical audience equals another opted-in
     server's is refused `409 identity_audience_shared`, before any step-up, and again under a transaction-scoped
     advisory lock inside the write so two concurrent opt-ins cannot both pass. An assertion for one would otherwise
     verify at the other. The canonicalisation is stated exactly in the format doc, which points operators to the
     audience the server's card shows.
   - A stdio server is refused with `409 identity_propagation_unsupported`: it has no HTTP request to carry the
     header. It may still be set to `none`.
   - No route was added, so the route census is unchanged at 0 known UI gaps.
7. **UI and documentation.**
   - The MCP servers registry has an "Identity to upstream" column, saved through `withStepUp`. Turning it on is
     confirmed first (what is shared, that it relaxes the strict default, that a url move turns it off).
   - The Playwright mock spec (`u1-integrations-gaps.mock.spec.ts`) covers turning it on (confirmation, step-up,
     resent once), off (no step-up), the card, the stdio refusal and axe; cells are found by a `data-` hook.
   - A selected server shows a card. The card has the format, the claims, the audience for that server and the
     verification example.
   - The example in the doc is run verbatim against a live JWKS in the route's format by
     `mcp-identity-assertion.test.ts` (M-041). The screen's copy of the example is held byte-equal to the doc by
     `mcpIdentityModel.test.ts`.

Open after S8:

- **Data-key rotation changes every `sub`** (S3 amendment 2). This now reaches third parties too: an upstream sees a
  new subject for the same person after a rotation. The doc says so, and the data-key rotation runbook should too.
- **Upstream replay sets across replicas** are the upstream's concern. The doc says to keep the `jti` set in shared
  storage.
- ~~**The "disclose agent workload IDs" relaxation** (item 1) waits for a coordinated migration number.~~ Built in
  the S8 follow-up below (migration 0196).

### As built: S8 follow-up, "disclose agent workload IDs" (2026-10-15, migration 0196)

S8 item 1 kept agents pairwise and left this relaxation for a later migration number. It is now built.

1. **The setting.** `mcp_servers.disclose_agent_workload_ids` is a boolean, default false (the strict value). The CHECK
   `mcp_servers_disclose_agent_ids_check` is `NOT disclose_agent_workload_ids OR identity_propagation =
   'signed_assertion'`: the IDs ride only inside an assertion, so the database refuses the pair otherwise. The
   migration is hand-written and re-runnable; every existing row gets false, with no grandfathering (ADR-0180).
2. **What changes on the wire.** Only `act.sub` (and each nested `act.sub`): each agent is named by its workload
   identity's `identifier` exactly as stored (its SPIFFE ID, default or admin-typed) instead of `pairwiseActor`. `sub`
   stays pairwise, and nothing else is added. The setting is read from the server row when the holder is created for
   the call (`outboundIdentityFor`), and only an exact `true` discloses.
3. **Audit of every disclosure.** Each `mcp-identity-assertion-issued` row now holds `agentIdsDisclosed` (true when an
   agent was named by its workload ID) and `actorIdForm` (`pairwise` or `workload_id`), beside the existing
   `actorChain` and `act`.
4. **The PATCH rules** (`agentIdDisclosureUpdate`, in `packages/shared/src/identity/mcp-identity-assertion.ts`), on
   `PATCH /v1/servers/:serverId` `{ discloseAgentWorkloadIds }`, following the S8 `identity_propagation` pattern:
   - Turning it on is a relaxation: a `settings_relax` step-up with facts `{op: "mcp_server_update", serverId, url,
     values: {discloseAgentWorkloadIds: true}}`, the url always bound. If the same request also turns on the assertion
     or opens private ranges, all the values go in ONE step-up.
   - The grant is looked at (not spent) before anything is written, and spent after the compare-and-set inside the
     write's transaction, as before. The compare-and-set now also compares `disclose_agent_workload_ids`.
   - Every change is audited (`mcp-server-agent-id-disclosure-changed`, with both values, the url and the audience);
     turning it on as a relaxation with its step-up. The audit rows of this route (private ranges, identity
     propagation, this disclosure and a stdio command change) are now written inside the write's transaction, so an
     audit row that cannot be written rolls the change back (#381 review); before, they were written after the commit.
   - Asking for it while the server's next `identity_propagation` is not `signed_assertion` is refused
     `409 agent_id_disclosure_needs_assertion` with a refusal sentence, before any step-up; nothing is saved. A stdio
     server is refused `409 identity_propagation_unsupported`, as for the assertion itself.
   - **Consent does not follow the url.** A url move that does not name it turns it off (audited, `resetByUrlMove`, no
     step-up); keeping it on across a url move is a relaxation bound to the new url. Propagation turning off turns it
     off too (audited, `resetByPropagationOff`).
   - Turning it off needs no step-up.
5. **UI.** The identity card of a server that is sent an assertion has an "Agent ids sent" control
   (`data-agent-id-disclosure`). Choosing workload IDs is confirmed first: the IDs are global, upstreams can correlate
   the same agent across servers, and an identifier an admin typed is sent exactly as typed; then the step-up. Going
   back to pairwise saves directly. A server not sent an assertion is not offered the choice. The format doc, the
   card's claim text and the verification example's comment say both forms; the doc and the screen's example stay
   byte-equal (`mcpIdentityModel.test.ts`).
6. **Tests.** Unit (`mcp-identity-assertion.test.ts`, `mcpIdentityModel.test.ts`); database
   (`zz-adr0188-s8-outbound-identity.test.ts`: off gives pairwise ids, on gives SPIFFE IDs, the step-up is required and
   combined, a url move and propagation turning off reset it, refused while propagation is off, the CHECK, a concurrent
   change to the column alone refused `409 changed_concurrently`, and a refused audit insert rolling the change back);
   mock e2e (`u1-integrations-gaps.mock.spec.ts`, stable `data-` hooks; its axe helper now also runs `heading-order`). No route was added: the census stays at 0 known UI
   gaps.

Open after the follow-up: the AI BOM's MCP server records (`apps/gateway/src/ai-bom.ts`) carry `identityPropagation`
but not this setting; adding it is left to the ADR-0189 owner, whose files a parallel slice is changing.

## As built: slice S9 (2026-10-16, branch `identity-s9-spiffe`, migration 0199)

S9 moves the SPIFFE trust bundles into audited storage (the S5 security review's ruling) and takes X.509-SVID client
authentication end to end. The code is `apps/gateway/src/oauth/spiffe-bundles.ts` (routes and upload checks) and
`oauth/spiffe-trust-domains.ts` (the reads every validator uses); the runbook is
[`docs/deployment/SPIFFE.md`](../deployment/SPIFFE.md). These points settle what decisions 10, 11, 12 and 21 left open:

1. **Storage (migration 0199).** `spiffe_trust_bundles`: one row per upload, PUBLIC X.509 authorities only (a CHECK
   refuses any `PRIVATE KEY` text), the format, a per-authority summary, and a digest (hex SHA-256 over the sorted
   authority thumbprints, so it does not depend on order or upload format). At most one **active** bundle per trust
   domain (partial unique index). A row is never deleted; its content and each lifecycle stamp are written once
   (trigger). `superseded_by_bundle_id` is a DEFERRABLE self-reference so the old row is superseded before the new one
   is inserted. `created_by`/`revoked_by` carry no foreign key, like `audit_log.user_id` (the system principal acts for
   the bootstrap token).
2. **No grandfathering (ADR-0180).** `REGULAIT_SPIFFE_TRUST_BUNDLES` is ignored, never imported. An install that set it
   has SPIFFE off until an admin uploads each bundle. The boot log warns while it is set, and the list view reports
   `legacyEnvironmentIgnored`. The mTLS CA set (`REGULAIT_MTLS_CA_BUNDLE`) stays a deploy-time variable: the S5 ruling
   named only the SPIFFE bundles.
3. **Routes** (admin-only, `IDENTITY_ROUTES` slice S9, internal, tag `identity`):
   - `GET /v1/identity/spiffe-trust-bundles`: every bundle, active first.
   - `POST /v1/identity/spiffe-trust-bundles` `{trustDomain, bundle, replacesBundleId}`: the first upload names
     `replacesBundleId: null`; a later one must name the active bundle's id (compare-and-set, else
     `409 spiffe_bundle_conflict`); identical authorities are `409 spiffe_bundle_unchanged`.
   - `POST /v1/identity/spiffe-trust-bundles/:bundleId/revoke` `{}`: only the active bundle
     (`409 spiffe_bundle_not_active` for a superseded one).
   The revoke is a POST, like the identity and signing-key revokes, so the identity route list keeps its single DELETE.
4. **Step-up on every change.** `identity_manage` with facts `{op: "spiffe_bundle_set", trustDomain, digest,
   replacesBundleId}` or `{op: "spiffe_bundle_revoke", bundleId}`. The upload is validated (and its digest computed)
   before the step-up is asked for, so a bundle that could never be trusted is refused without a confirmation, and a
   step-up for one bundle is refused (and not spent) for another. Revoking is a tightening, but it ends authority and
   is irreversible, so it is stepped up too.
5. **What an upload must be.** Concatenated PEM certificates, or the SPIFFE bundle format (an RFC 7517 JWKS). In the
   SPIFFE format each `x509-svid` key carries exactly one `x5c` certificate and its key parameters must be that
   certificate's public key; `jwt-svid` keys are counted and not stored (JWT-SVID client authentication is not built);
   any other `use`, or a private JWK member, is refused. Every authority must be a CA with `keyCertSign` (the rule the
   validator applies to every anchor) and inside its validity window on the database clock; duplicates, more than 64
   authorities and more than 256 KB are refused. Every refusal is audited (`spiffe-trust-bundle-refused`, codes only,
   never the bundle text); uploads are `spiffe-trust-bundle-set` (`add` or `replace`), revocations
   `spiffe-trust-bundle-revoked`.
6. **Read at the point of use, never cached.** The token endpoint, the resource verifier and introspection read the
   active bundles for every certificate they judge (`matchCertificateCredential` now takes the database handle), so an
   upload or a revocation applies to the next request on every replica. Binding a `spiffe_id` credential reads them in
   the bind transaction (`prepareCredential` takes a trust-domain source instead of the environment).
7. **Rotation is not revocation (decision 12).** Replacing supersedes the old bundle and revokes nothing. Because
   decision 21 re-validates a presented certificate at every use, an SVID whose CA left the bundle stops authenticating
   at once, including at its next use of a certificate-bound token. The runbook says to upload an overlap bundle (old
   and new CA) first, as SPIRE's own bundle does during its CA overlap.
8. **Revoking a bundle (decision 12's "A whole SPIFFE trust bundle" row).** The bundle row and every unexpired token
   authenticated by a `spiffe_id` credential of that trust domain are revoked in one transaction (database clock).
   After commit, every live grant those credentials authenticated (as `auth_credential_id` or
   `subject_credential_id`) is revoked with its descendants, through S6's cascade (`revokeGrants`, now exported and
   naming the bundle in its `workload-identity-cascade-incomplete` row). The cascade is domain-wide: a grant is not
   recorded against the bundle version that authenticated it. The credentials themselves stay: uploading a new bundle
   for the domain lets their SPIFFE IDs authenticate again, with SVIDs from the new CA.
9. **The backstop.** `loadLiveChain` (decision 17) now treats a `spiffe_id` credential (auth or subject) whose trust
   domain has no active bundle as `credential_not_live`, so a grant the cascade failed to end is refused at its next
   use. The trust domain is the ID's authority, read with `split_part(spiffe_id, '/', 3)`.
10. **Open source first (ADR-0176), recorded.** Searched npm for SPIFFE libraries: `spiffe` (MIT), `@jeengbe/spiffe`
    (MIT) and `@defakto/spiffe` (Apache-2.0) are Workload API **clients** (gRPC to a SPIRE agent, the workload's side,
    pulling gRPC, protobuf and cloud SDKs); none parses or validates a bundle on the relying-party side, so none fits.
    Path validation stays `pkijs` (pinned, decision 21) plus Node's `X509Certificate`; the JWK-to-certificate check is
    Node's `createPublicKey`. What is ours is the bundle-format and CA rules above. No dependency was added.
11. **Steward edits** were the other half of the S5 ruling. They already live in audited storage: S4's
    `PATCH /v1/workload-identities/:id` (stewards and environments, `identity_manage` step-up, audited); no
    environment variable ever held them. Nothing more was needed.
12. **UI.** A "SPIFFE trust bundles" card on the workload identities page lists every bundle, uploads a domain's first
    bundle or replaces the active one (domain fixed, active id sent), and revokes with the cascade named; each write is
    confirmed and resent once through the step-up. A private key or a malformed domain is refused in the browser. The
    route census stays at 0 known UI gaps.
13. **Tests.**
    - Offline (`oauth/spiffe-bundles.test.ts`): every upload refusal with its positive control; a **real SPIRE 1.13.3**
      bundle and X.509-SVID (`testing/spire-1.13.3/`, public halves only, made by the runbook's commands) validate
      offline, the same SVID is refused an hour after it expired, under another trust domain, and under another CA; the
      decision 21 claims with synthetic SVIDs: a wrong trust domain, an expired SVID, a non-SPIFFE URI SAN, two URI SANs,
      and a CA certificate as the leaf, each refused. Two negative controls were run (the CA-authority check and the
      key-mismatch check removed: each made its test fail).
    - Database (`zz-adr0188-s9-spiffe.test.ts`, through the real app): the S5 variable set and ignored; admin-only and
      no step-up with an API key; the step-up bound to the digest and unspent on a mismatch; audited refusals;
      compare-and-set; the table's guard; an SVID through an authenticated proxy to a certificate-bound token accepted
      at `/mcp/:serverId`; the six refusals at the token endpoint, each with its recorded code, plus an untrusted peer and
      a wrong proxy secret; overlap rotation; revocation revoking the token and the grant and refusing at once; the
      backstop with a forced cascade failure. `zz-adr0188-s5-token-endpoint.test.ts` now uploads its bundle through the
      route.
    - Mock browser (`workload-identities.mock.spec.ts`): list, legacy note, browser-side refusals, upload, replace and
      revoke through the step-up, axe.

Open after S9:

- **Fetching a bundle through the egress guard** (decision 10 allows "uploaded or fetched") is not built; upload is the
  strict subset and the only path air-gapped. A SPIFFE bundle endpoint fetch with `spiffe_refresh_hint` would be its
  own slice.
- **JWT-SVID client authentication** is not built; `jwt-svid` keys in an upload are counted, not stored.
- **Runbook steps 5 to 9** (upload, registration, the proxy configuration, the exchange and the drills on a real
  deployment) are pending execution (M-041); the proxy part depends on the executor TLS front work.
- A test that forces a revocation to commit between the token endpoint's certificate match and its issuing
  transaction (the `spiffe_bundle_revoked` refusal) does not exist yet; the opposite interleaving is tested.

### S9 fix round (#389 independent review, 2026-10-16)

The coordinator renumbered S9's migration from 0200 to **0199** (I5 takes 0200), and its journal entry is in.

1. **M1: a revocation is never undone by a re-upload.** The live-chain rule of item 9 also refuses a grant a SPIFFE ID
   authenticated when a bundle of its domain was **revoked at or after the grant was created**
   (`revoked_at >= delegation_grants.created_at`), whatever is active now. Introspection and the resource verifier
   reach this through the same `loadLiveChain`, and a token is judged through its grant. To close the race window, the
   token endpoint holds the authenticating bundle row `FOR SHARE` in the transaction that creates the grant and token,
   and refuses `spiffe_bundle_revoked` if it was revoked meanwhile (`lockSpiffeBundleUnrevoked`). The revocation takes
   the row `FOR UPDATE` and stamps `revoked_at` with `clock_timestamp()` after that lock. So a grant made under a bundle
   is always created before the revocation commits, and the revocation's token update and cascade see it. A superseded
   bundle still qualifies at the token endpoint: rotation is not revocation.
2. **M2: the leaf's critical extensions.** pkijs does not judge path index 0. After the engine, a critical leaf
   extension outside {basicConstraints, keyUsage, extKeyUsage, subjectAltName, subjectKeyIdentifier,
   authorityKeyIdentifier}, or an allowed one whose value does not parse as its own ASN.1 type (pkijs's lazy
   `parsedValue` swallows a mismatch, so the type constructors are called directly), is refused
   `certificate_extension` (RFC 5280 §4.2). This applies to plain `tls_client_auth` as well as to SVIDs.
3. **L3: the step-up is spent after the compare-and-set.** The routes look at the grant (`spend: false`) and claim it
   inside the write's transaction, on the root handle, after the compare-and-set and every refusal, so a 404 or a 409
   leaves it unspent.
4. **L4:** `pemBundleToDer` refuses any `-----BEGIN` block that is not `CERTIFICATE` (`PemNotCertificateError`); a
   bundle upload names it `spiffe_bundle_not_certificate`.
5. **L5:** the env test that could not fail is replaced by a source check that the retired variable is read in one
   place only (`legacySpiffeEnvSet`).
6. **Recheck Low 3: rotation then revocation.** A request could load bundle B1's authorities, an admin could rotate to
   B2 and revoke B2, and the request, locking only B1 (superseded, not revoked), would issue a grant created after B2's
   `revoked_at`, which rule (b) misses once B3 is uploaded. Now the issuing transaction locks **every** bundle row of
   the domain FOR SHARE in one statement and applies `spiffeIssueAllowed`: refuse unless the authenticating bundle is
   unrevoked, **no bundle of the domain created at or after it was revoked** (a rotation away from it that ended in a
   revocation ends its authorities too), and the domain has an active bundle. Why this is final under READ COMMITTED:
   - a locked row a concurrent writer holds is waited for and then read in its committed version, so the rule sees
     every upload and revocation that committed first;
   - when the rule passes, the transaction holds the domain's active row FOR SHARE until it commits; superseding that
     row (an upload) and revoking it both take it FOR UPDATE first, so neither commits while the grant is made;
   - the one write that takes no row lock is a first upload into a domain with no active bundle, and the rule's third
     clause refuses exactly that state;
   - so every revocation that follows a grant is stamped (`clock_timestamp()` after its lock) later than the grant's
     `created_at`, and live-chain rule (b) refuses the grant for good, whatever is uploaded afterwards. That is the
     backstop extension the recheck asked for: "superseded by a bundle that is now revoked" can only describe a grant
     whose `created_at` precedes that revocation, which rule (b) already covers; the other order is refused at issue.
   - Tests: the pure rule (`spiffe-bundles.test.ts`), and the reviewer's sequence driven deterministically through a
     test hook between the certificate match and the issuing transaction (`zz-adr0188-s9-spiffe.test.ts`: refused
     `spiffe_bundle_revoked`, no grant made; a re-upload authenticates afresh).

Open after the fix round (recheck follow-ups):
- **Low 1:** two concurrent FIRST uploads to one domain: the loser's step-up is spent before its unique-violation 409.
  It fails safe (nothing is written; the admin steps up again).
- **Low 2:** the critical-extension parse checks each allowed type's outer structure through pkijs, not every inner
  field (for example the GeneralName forms inside a SAN). No authorization depends on those fields beyond what the
  SPIFFE profile already reads.
- **Pool note:** the issuing transaction now holds bundle row locks while it creates the grant and the token; a
  revocation or upload for that domain waits on it. Under heavy issue load for one domain, an admin write may wait a
  request's duration. No pool sizing was changed.

### S9 follow-ups (2026-10-17, branch `sec-logleak-spiffe-1017`, no migration)

1. **(a) The bundle fetch and the egress guard.** There is no fetch to move: on `main` the only source of a trust bundle
   is the stepped-up, audited upload (item 3), and no gateway module that handles SPIFFE material makes an outbound
   call. Building a fetch now would mean a new admin route and a new UI control, which this follow-up's surface does
   not include. What is built is the rule for when one is: `oauth/spiffe-egress.test.ts` scans every gateway module
   that names SPIFFE and refuses a bare `fetch(`, `globalThis.fetch`, `node:http(s)`, `undici` or a connecting
   `net`/`tls`/`dgram` import; the guarded form (`guardConnectionCall(...)` then its `fetchImpl`) passes. Negative
   controls for each form are in the test. Fix round (review F6): the scan also catches an aliased `fetch`, a dynamic
   `import()` or `require()` of any network module, and `node:http2`, and it covers every module under `oauth/` and
   `packages/shared/src/identity/` whether or not it names SPIFFE. **It is a tripwire, not the gate.** A source scan
   cannot see a helper elsewhere in the tree, a fetch passed in as a dependency, or a redirect followed by the guarded
   call itself. The fetch slice, when built, carries a behavioural test as its real gate: a redirect is not followed
   (`redirect: "manual"`), a URL outside the egress allow-list is refused and audited, and a metadata or private
   address is refused, each through `guardConnectionCall`. The design for the fetch slice, when it is scheduled:
   - a bundle endpoint URL per trust domain, set by an admin with the same `identity_manage` step-up and audit as an
     upload, and checked against the egress allow-list when it is set (ADR-0034 owner amendment 2026-10-16: an allow
     entry for it needs its own step-up);
   - every fetch through `guardConnectionCall` (surface `connector`, audited allow or refusal), `redirect: "manual"`,
     a timeout and a size cap equal to the upload's 256 KB;
   - what is fetched passes the same validation as an upload (item 5) and is written as a new bundle row through the
     same compare-and-set, so a fetched bundle is superseded, revoked and backstopped exactly like an uploaded one;
   - `spiffe_refresh_hint` bounded by a floor and a ceiling, and a failed fetch keeps the active bundle (it never
     clears trust), with the failure audited;
   - air-gapped installs keep upload only (the fetch setting is off by default, ADR-0180).
2. **(b) JWT-SVID client authentication: sized as large, not built.** What it would take:
   - **Storage (a migration).** `spiffe_trust_bundles` stores X.509 authorities only, and its CHECKs and write-once
     trigger are built around that. JWT authorities need a column (public JWKs, `kid` unique per bundle), the CHECK
     and trigger extended, and a decision on the digest (today it covers X.509 thumbprints only, so a JWT-key change
     would read as `spiffe_bundle_unchanged`). This follow-up reserves no migration number.
   - **Token endpoint.** The token endpoint is built on `oidc-provider`, which knows `private_key_jwt` and the RFC 8705
     methods but not `draft-ietf-oauth-spiffe-client-auth`'s JWT-SVID assertion type. It would be a new
     authentication path in the pre-claim hook: `sub` is the SPIFFE ID, `aud` the token endpoint, a short `exp`,
     `jti` claimed through `claimReplay` (namespace `client_assertion`), the signature checked with `jose` against the
     domain's active JWT authorities, and the issuing transaction's bundle locking and `spiffeIssueAllowed` (fix round
     item 6) applied to the authenticating bundle.
   - **Sender constraint (decision 5).** An X.509-SVID binds the token to the certificate. A JWT-SVID is a bearer
     credential, so the issued token must be DPoP-bound, and a JWT-SVID request without a DPoP proof refused.
   - **Revocation.** Item 8's cascade and item 9's backstop key on `spiffe_id` credentials and the domain, so they
     carry over, but each needs a JWT-SVID case in its tests.
   - **UI and tests.** The bundle card shows JWT authorities instead of a count, a real SPIRE JWT-SVID fixture is added
     beside `testing/spire-1.13.3/`, and the DB suite gets the six refusals for the new path.
   It is its own slice, about the size of S9's X.509 half. Until then, `jwt-svid` keys stay counted and not stored, and
   the token endpoint's provider accepts only `private_key_jwt` and `tls_client_auth` (`clientAuthMethods` in
   `oauth/token-endpoint.ts`), so a JWT-SVID has no path to a token. No request carrying one was run for this note.

### As built: SEC-DEFAULTS follow-ups (2026-10-17, branch `sec-defaults-1017`, no migration)

- **Low 1, closed.** The bundle routes still look at the grant first (`spend: false`). The claim is now the upload's
  and the revocation's **last** act inside the write's transaction: after the compare-and-set, the insert and the audit
  row. A racing first upload raises its unique violation before the claim, so the loser's grant stays unspent
  (`409 spiffe_bundle_conflict`, nothing written). Pinned by `zz-adr0188-s9-spiffe.test.ts` (L3 case), with a test
  hook (`spiffeBundleWriteTestHooks.beforeInsert`) that commits the winner's row between the compare-and-set and the
  insert.
- **The second pooled connection, removed.** The claim used to run on the root handle while the write's transaction
  held the bundle row lock. With N concurrent writers on a pool of N, each could wait for a second connection, a pool
  deadlock. `SpendStepUp` now takes the transaction's connection. A refused claim throws and rolls the write back. Its
  `step-up-grant-refused` row rolls back with it, so the route records it again on the root handle with a look that
  spends nothing.
- **The revoke-commits-first refusal, tested.** A revocation of the authenticating bundle that commits between the
  token endpoint's certificate match and its issuing transaction is refused `spiffe_bundle_revoked`, and no grant is
  made (the `afterCertificateMatch` hook). This closes the open item "a test that forces a revocation to commit
  between…" above.
- **`connector_policy_changed` after the decision, audited.** A refusal at execution (before or during the provider
  call), at the trace commit, or at response release used to write only a trace span. Each now also writes one deny
  audit row (`connector-policy-changed`, `receiptClass: "decision"`, `detail.phase` = `execution`, `trace-commit` or
  `release`, with `externalRequests`, `mayHaveExecuted` and the decided policy epoch). The decision-commit refusal and
  the billed-and-withheld output check already wrote their own rows. A per-call flag keeps it to one row per refusal.
  Pinned in `connector-redaction.test.ts` (the execution and release cases, and one row for the mid-call change).
- **`PATCH /v1/servers/:serverId` with an owner change: one conditional write.** The columns and the owner used to be
  two writes, so a concurrent change between them could leave the columns written without the owner change. Now the
  owner is part of the same `UPDATE`, with a compare-and-set on the owner the `owner_change` step-up was decided on
  (`IS NOT DISTINCT FROM`), next to the existing posture compare-and-set. Both grants (the `settings_relax` one and the
  `owner_change` one) are claimed in that transaction on its connection, after the write, and the owner audit row
  (`mcp-server-owner-changed`, the same row `PUT …/owner` writes, now `auditOwnerChanged` in `ownership.ts`) is
  written there too. A moved owner is `409 changed_concurrently` with nothing written and nothing spent. An owner
  named but unchanged still goes through `changeOwner`, as before. ADR-0185 I9's "audited owner change" and ADR-0186
  A's Class A rule are unchanged in substance.
- **Unverified locally:** the DB integration tests (no Postgres in the build environment). They are typechecked here
  and run first in CI.

### As built: issuer-key writes under `key_management` (2026-10-17, migration 0203)

Rotating and revoking the issuer's signing key (`POST /v1/identity/signing-keys/rotate`, `/:kid/revoke`, S3) now ask
for a `key_management` step-up instead of `identity_manage`, bound to `{op, keyId}`; a rotation with no `kid` is bound
to the key it resolves to before the step-up. An `identity_manage` grant can no longer rotate or revoke an issuer key,
and a `key_management` grant cannot administer an identity. Binding a key to a workload identity stays
`identity_manage` (decision 2). Full note: ADR-0186, "As built — 2026-10-17: a step-up kind of its own for key
management".

### As built: S9 follow-ups, bundle endpoint fetch and JWT-SVID (2026-10-18, branch `spiffe-bundle-jwtsvid`, migration 0209)

This builds the two items the S9 follow-ups note (2026-10-17, items (a) and (b)) sized and left open, along the design
that note wrote down. Decisions 5, 10, 11, 12 and 21 are unchanged; the points below say how they were met and where the
build differs from that note.

**Open source first (ADR-0176), recorded.** npm was searched again for a relying-party SPIFFE library (`jwt-svid`,
`spiffe`, `spiffe bundle`, 2026-10-18). `spiffe` 0.5.1, `@jeengbe/spiffe` 2.1.1 and `@defakto/spiffe` 0.7.0 are Workload
API clients: they validate through a SPIRE agent over gRPC, which a relying party outside the trust domain does not have.
`@atlasauth/pca-spiffe` 0.4.1 and `spiffile` 0.1.0 were first published weeks ago, with no maintenance record. None is
validated, so the JWT-SVID profile and the bundle-endpoint client are ours; the JOSE work is `jose` (pinned), path
validation stays `pkijs`, and TLS is Node's. No dependency was added; `THIRD_PARTY.md` is unchanged.

1. **Storage (migration 0209, hand-written; its journal entry is left to the coordinator).**
   - `spiffe_trust_bundles` keeps a bundle's JWT authorities: `jwt_authorities` (public JWKs reduced to their public
     members, `kid` and an optional `alg`; a CHECK refuses any private member) and `jwt_authority_views` (kid, key type,
     curve, RFC 7638 thumbprint). It also records `source` (`upload` or `fetch`) and a fetched bundle's `sequence`. The
     write-once trigger function is replaced to cover the new columns, with the 0185 `search_path` pin; the table's
     TRUNCATE refusal is unchanged. Nothing is backfilled: a bundle recorded before 0209 verifies no JWT-SVID until a
     bundle with its JWT authorities is uploaded or fetched (ADR-0180, as for a first load).
   - `spiffe_bundle_endpoints`: one row per trust domain an admin configured (URL, profile, endpoint SPIFFE ID, enabled,
     and the refresh state). It starts empty. It has no refusal trigger: it is configuration and state, and its history
     is the audit log.
   - `org_settings.workload_client_auth_methods` may now hold `spiffe_jwt_svid`. The column default is unchanged.
2. **What a bundle's JWT authorities must be** (`parseSpiffeBundle`, upload and fetch alike): JWT-SVID section 6.1 (a
   `kid` on each, unique in the bundle) and section 2.1 key types only, RSA of at least 2048 bits or EC on P-256, P-384
   or P-521. A named `alg` must be one the key serves. An Ed25519 or a short RSA key is refused
   `spiffe_bundle_jwt_key_unsupported`, so the whole bundle is refused, never partly kept. A bundle still needs at least
   one X.509 authority (a JWT-only bundle is refused, as in S9). The digest keeps S9's form for a bundle with X.509
   authorities only, so every stored digest still compares; with JWT authorities it also covers each `kid` and
   thumbprint, so a JWT-key change is never `spiffe_bundle_unchanged` (the follow-ups note's open digest question).
3. **The bundle endpoint (follow-up (a)).** `oauth/spiffe-bundle-endpoint.ts`.
   - Routes: `GET /v1/identity/spiffe-bundle-endpoints` and `PUT /v1/identity/spiffe-bundle-endpoints/:trustDomain`
     `{url, profile, endpointSpiffeId, enabled}`, admin-only, under an `identity_manage` step-up bound to every field.
     Disabling is stepped up too, as a revocation is: it changes what is trusted. A URL that is not `https`, carries
     userinfo or a fragment, or an `https_spiffe` endpoint whose ID's trust domain has no active bundle, is refused
     before the step-up and audited (`spiffe-bundle-endpoint-refused`). An enabled URL is checked against the egress
     allow-list when it is set (`refuseConnectionEgressWrite`, audited). Setting is audited
     (`spiffe-bundle-endpoint-set`, with the previous values). An enabled endpoint is fetched once at once, and the
     answer says how that went.
   - Every fetch goes through `guardConnectionCall` (surface `connector`, so the allow or the refusal is audited), with
     a 10 s budget and the upload's 256 KiB cap. `https_web` is Web PKI, unchanged. `https_spiffe` replaces the system
     trust store with the X.509 authorities of the ACTIVE bundle of the endpoint ID's trust domain (an admin uploads the
     first one to bootstrap, Federation section 5.2.2), and replaces the hostname check with the X.509-SVID profile:
     one URI SAN, exactly the configured ID, not a CA. This needed an opt-in TLS override on the pinned transport
     (`PinnedTarget.tls` in `pinned-fetch.ts`, threaded through `createGuardedFetch` and `ConnectionEgressDeps`). It is
     additive: without it nothing changes, and a request that uses it never takes a pooled connection, so a socket
     verified one way is never reused for a request verified the other way.
   - What is fetched must be the SPIFFE JSON format (PEM is refused) and passes the upload's checks. It is written
     through the upload's compare-and-set (`setSpiffeTrustBundle`, `source = 'fetch'`) by the system principal, so a
     fetched bundle is superseded, revoked and backstopped exactly like an uploaded one. Only a change writes a row, and
     its `spiffe-trust-bundle-set` audit row names the old and new authorities, digests and sequences. A
     `spiffe_sequence` that does not follow the active fetched bundle's is refused `spiffe_bundle_sequence_rollback`
     (Trust Domain and Bundle section 4.1.1), so an endpoint cannot replay an older bundle.
   - Refresh: the `spiffe-bundle-refresh` scheduler job (60 s) claims one due endpoint at a time with
     `FOR UPDATE SKIP LOCKED` and a 120 s lease, so two replicas never fetch one domain at once. After a good fetch the
     next one follows `spiffe_refresh_hint`, clamped to [60 s, 24 h], and five minutes when the bundle names none
     (Federation section 5). After a failure the retry waits the polling interval but at most five minutes.
   - **Fail closed, keeping the last good bundle.** A failed fetch, or a body that does not parse or validate, changes
     no bundle. It is recorded on the endpoint row as a code (never the response text, a CHECK holds it to
     `[a-z0-9_]`) and audited `spiffe-bundle-fetch-failed`. The last good fetched bundle authenticates only until
     `trust_until` (its last successful fetch + 24 h, `SPIFFE_FETCHED_BUNDLE_MAX_AGE_SECONDS`). After that,
     `loadSpiffeTrustAnchors` and `loadSpiffeJwtAuthorities` leave the domain out, so it authenticates nothing until a
     fetch succeeds. An uploaded bundle has no such limit: it is pinned.
   - **A revocation is never undone by a fetch.** Revoking a domain's bundle disables its endpoint in the same
     transaction, and a fetched write into a domain whose bundle was revoked at or after the endpoint's last admin
     setting is refused `spiffe_bundle_revoked`. Only a stepped-up PUT (after an upload, for `https_spiffe`) fetches
     again.
   - **Air-gapped: "pin a static bundle file" is the upload.** The brief allowed pinning a static bundle file instead
     of fetching. S9 item 2 (the S5 security review's ruling) is that nothing is trusted unless it came through the
     audited route; a deploy-time file would be the retired environment variable in another form. So the static
     bundle is pinned by uploading the SPIFFE bundle file (`spire-server bundle show -format spiffe`) through the
     stepped-up route, and leaving the domain without an endpoint. Such a bundle never lapses and is never refreshed.
     The endpoint feature is off unless an admin sets one, and the egress allow-list refuses it on an air-gapped
     install anyway.
   - **Deviation: redirects are refused.** Federation section 5.2 says a client SHOULD follow a redirect to a valid
     endpoint URL. The pinned transport refuses every redirect (ADR-0034), and this keeps that: an allow-listed
     endpoint cannot hand the fetch to another host. An operator configures the final URL.
4. **JWT-SVID client authentication (follow-up (b)).** `oauth/spiffe-jwt-svid.ts`, `matchJwtSvidCredential` in
   `oauth/clients.ts`, and the token endpoint.
   - **Off by default; enabling is the audited org setting.** `spiffe_jwt_svid` is a new member of
     `workload_client_auth_methods` and the one member outside the strict default
     (`WORKLOAD_CLIENT_AUTH_METHODS_DEFAULT`). Adding it is a relaxation: `PUT /v1/org/settings` asks for the
     `settings_relax` step-up and audits it as relaxed (`identitySettingRelaxed`). The settings screen offers it, with
     its strict and relaxed text.
   - The assertion is draft-ietf-oauth-spiffe-client-auth-02 section 3.1:
     `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-spiffe` with the JWT-SVID as
     `client_assertion`; `client_id` names the workload identity (or is taken from `sub`). The token endpoint verifies
     and matches it before `oidc-provider` runs, takes it out of the form, and tells the provider the outcome through
     the same pre-authenticated path as an mTLS certificate (the provider knows no `jwt-spiffe` type). One assertion
     and one type, or nothing authenticates.
   - The verifier's rules, each refused with its own code: a compact JWS of at most 16 KiB; a JOSE header of `alg`,
     optional `kid` and optional `typ` (`JWT` or `JOSE`) and nothing else (JWT-SVID section 2), so an embedded `jwk`,
     `jku`, `x5c` or `crit` is refused before any key is chosen; `alg` one of section 2.1's nine; the key of the type
     and curve that `alg` names, and only for its own `alg` when it names one (alg confusion); `sub` a SPIFFE ID whose
     trust domain has a usable bundle with JWT authorities; the key by `kid` from that bundle only, never looked up
     elsewhere (draft section 8.1); **`aud` exactly one value, this gateway's issuer identifier** (draft section 3.1
     step 3; JWT-SVID section 7.2); `exp` present, not past (5 s leeway) and at most five minutes away (decision 5);
     `nbf` and `iat` not in the future; then the signature, with `jose`.
   - It maps to the same identity path as an X.509-SVID: a `spiffe_id` credential whose SPIFFE ID equals `sub`, on the
     client the request names (`spiffe_id_mismatch` otherwise). The token endpoint locks the authenticating bundle's
     domain rows for the issue (`lockSpiffeBundleUnrevoked`, S9 fix round item 6), so revocation, the cascade and the
     live-chain backstop apply unchanged. The issue audit row says `clientAuth: "spiffe_jwt_svid"`.
   - **A bearer credential, so its token is always DPoP-bound** (the follow-ups note's sender-constraint point): a
     JWT-SVID request without a DPoP proof is refused `dpop_required` before anything is claimed. The SVID is
     single-use: its `jti` (or, as SPIRE sets none, a digest of the token) is claimed in `replay_claims` (namespace
     `client_assertion`, keyed by the SPIFFE ID) after the whole request is checked and before the DPoP proof, as the
     provider orders a private_key_jwt assertion. A JWT-SVID cannot take a self token (`client_credentials`).
5. **UI.** A "SPIFFE bundle endpoints" card on the workload identities page lists each endpoint with its state (fetching,
   failing with the code in words, or off) and trust window; it sets an endpoint (a server SPIFFE ID selects
   `https_spiffe`, none selects `https_web`, and the confirmation names the profile; saving a listed domain changes it)
   and stops a fetch, each confirmed and resent once through the step-up. The card is kept small: the web "all JS"
   bundle ceiling (ADR-0196, 1,020 kB gzip) left about 1 kB, the first version went 629 B over it, and after the
   merge with main it went 566 B over again. So the profile is not a separate field, the endpoint failure codes other
   than five read as their own words ("Failed: timeout."), and the S9 bundle refusal and status copy is shorter. The
   bundles card shows how many JWT-SVID keys a bundle holds and whether it was fetched. The route census stays at 0
   known UI gaps.
6. **The SPIFFE egress tripwire** (`oauth/spiffe-egress.test.ts`, S9 follow-ups item (a)) now scans the fetch module
   itself. Its bare-`fetch` rule reads code with quoted strings blanked and `typeof fetch` removed (an audit rule id,
   a `source: "fetch"` value and a module specifier are not calls); template literals are left as they are, so
   `${fetch(u)}` is still caught. New negative controls cover both. The behavioural gate the note asked for is in
   `oauth/spiffe-bundle-endpoint.test.ts`: a redirect is refused, a host outside the allow-list is refused before any
   connection, an SVID for another ID and an unanchored chain are refused, and Web PKI is unchanged without the
   override.
7. **Tests.**
   - Offline, `oauth/spiffe-jwt-svid.test.ts` (20): each rule with its code and a positive control (wrong trust domain
     both ways, a missing, empty, foreign or two-valued `aud`, expired, missing `exp`, too long a lifetime, a future
     `nbf` or `iat`, an unknown `kid`, a tampered payload, malformed tokens); alg confusion (`none`, HS256 keyed with a
     public key, EdDSA, an RSA alg against an EC kid and the reverse, ES384 against a P-256 key, a key pinned to PS256
     used as RS256, an embedded `jwk` or `jku`); the bundle's JWT authority rules; and a **real SPIRE 1.13.3 JWT-SVID**
     (`testing/spire-1.13.3-jwt/`, minted on a throwaway server with the runbook's steps 1 to 3 plus
     `spire-server jwt mint`; stored as its three segments because a whole JWT is a gitleaks `jwt` finding, which a
     local gitleaks 8.30.1 run confirmed) verifying inside its window and refused after it, for another audience, and
     under another SPIRE server's bundle. Negative controls run: removing the single-audience check, the alg allow-list,
     the key's own-alg pin or the header allow-list each made its tests fail.
   - Offline, `oauth/spiffe-bundle-endpoint.test.ts` (11), on a loopback HTTPS endpoint through `createGuardedFetch`:
     the fetched-body rules, the interval clamp and retry, the URL rules, `https_spiffe` accepted and refused, Web PKI
     refusing the synthetic CA, a redirect refused, an unlisted host refused unconnected. Negative control: without
     the `checkServerIdentity` override the `https_spiffe` tests fail.
   - Database, `zz-adr0188-s9b-spiffe-fetch-jwt-svid.test.ts` (CI only; Postgres is not available where it was
     written, so it was typechecked and not run): the endpoint route's admin gate, step-up and audited refusals; the
     first fetch, an unchanged fetch, **a fetch failure keeping the last good bundle** (a 500, an unparseable body, a
     sequence rollback), the trust window lapsing and coming back, **rotation**, the scheduler pass, a revocation that
     a fetch cannot undo, an endpoint presenting another ID; JWT-SVID off by default, then a DPoP-bound token from a
     valid SVID, single use, no DPoP refused without burning the SVID, the refusals with their codes (wrong trust
     domain, `aud` missing, foreign and two-valued, expired, unknown `kid`, `alg: none`, another workload's ID), a
     JWT-key rotation, and a bundle revocation revoking the JWT-SVID token. `zz-adr0188-s1-foundation.test.ts` now
     relaxes `workloadClientAuthMethods` to include `spiffe_jwt_svid`: audited as a relaxation, and an admin API key
     refused for want of the step-up.
   - The mocked browser suite covers the endpoints card (list, browser-side refusals, set and stop through the
     step-up, axe).

Open after this:
- `docs/deployment/SPIFFE.md` step 3 still says the `jwt-svid` key is counted and not used and that both exports give
  the same digest. Both stopped being true here (the SPIFFE export's digest now covers its JWT authority). The runbook
  is outside this slice's surface; the fix is a wording change, and a fetch runbook needs a run on a real deployment
  first (M-041).
- The live-chain backstop (`loadLiveChain`) keys on an active bundle, not on the fetched bundle's trust window. A
  delegated token is short-lived (decision 5) and re-checked against the window at the token endpoint, so a lapsed
  window stops new tokens at once; existing ones end with their own expiry.
- A PUT that enables an endpoint fetches at once while the scheduler may claim the same row; both writes go through
  the compare-and-set, so the worst case is one extra fetch.
- The migration's journal entry (0209) is the coordinator's to add; until it is, the database suites cannot see the
  new columns.

#### As built: S9 follow-ups fix round (#442 independent review, 2026-10-18, no migration)

Corrections to the text above (left as written):
- **Journal.** Point 1 and the last "open" item say the 0209 journal entry is left to the coordinator and that the
  database suites cannot see the new columns. Both are stale: the entry is journaled (idx 209), and the database suites
  run against the new columns in CI.
- **`client_id`.** Point 4 says `client_id` "is taken from `sub`". That overstates it. When the form has no
  `client_id`, the token endpoint reads the assertion's `sub` as the client ID, but `findWorkloadClient` looks the
  client up by its workload identifier (or a JWK-thumbprint URI), never by SPIFFE ID. A workload that omits
  `client_id` authenticates only when its identifier is literally its SPIFFE ID; otherwise it is `client_unknown`.
  Sending `client_id` is the supported form.
- **UI: Web PKI is an explicit choice (second review round).** Point 5 says a blank server SPIFFE ID selects
  `https_web`. That made Web PKI, which trusts any public CA, the default of an empty field (an ADR-0180 regression,
  reverted). The form now has a "Use Web PKI (no server SPIFFE ID)" checkbox, unticked by default. Unticked, the
  profile is `https_spiffe` and a blank or malformed server ID is refused in the browser ("Name the endpoint server's
  SPIFFE ID"); ticked, the ID field is hidden and `https_web` is sent with no ID. The gateway never inferred a profile:
  `putSpiffeBundleEndpointSchema` requires `profile`, and `https_spiffe` without an ID (or `https_web` with one) is
  refused; an offline test now pins that. The endpoint row reads "(https_web)" with no trailing space when there is no
  ID, and says "uploaded bundle in use (pinned)" instead of the fetch trust window when the domain's active bundle is
  an upload. To stay under the "all JS" ceiling, the two cards share one refusal-to-words helper (`inWords`).

Changes (review items 4 and 5, code only):
- **Disabling an endpoint ends trust at once (secure by default, ADR-0180).** Setting `enabled: false` sets the
  endpoint's `trust_until` to `now()`, and a fetched bundle is usable only while its endpoint is enabled and inside its
  trust window (`spiffe-trust-domains.ts`). A success write after a fetch is applied only to an enabled row, so a fetch
  racing a disable cannot reopen the window. Re-enabling fetches before anything is trusted again. An uploaded bundle
  is unaffected. The "Stop fetching" confirmation and the audit reason say so.
- **An upload is not silently superseded.** A fetched write over an active uploaded bundle created at or after the
  endpoint was last set is refused `spiffe_bundle_upload_newer` (recorded and audited as a fetch failure; the upload
  stays active). Setting the endpoint again, stepped up, hands the domain back to the fetch. This compares
  `created_at` with the endpoint's `updated_at`, as the revocation check does, so no schema change was needed.
- **The upload-newer refusal is recorded once (second review round).** The refusal used to be retried every five
  minutes, each with a deny audit row (about 288 a day per domain) and a network fetch. Now it parks the endpoint:
  `next_refresh_at` is cleared, so the scheduler (which claims only a due `next_refresh_at`) does not fetch it again
  until an admin sets the endpoint again, which schedules a fetch at once. The row keeps the code, so the card says
  why.

Tests added: `fetchBundleText` refusing a body over 256 KiB by its declared `content-length` (the response is left open,
so only the declared check can answer) and by what actually streams (chunked, no `content-length`), and mapping a
redirect to `spiffe_bundle_fetch_redirect` (offline, `spiffe-bundle-endpoint.test.ts`, with a stub database); a JWT-SVID
over 16 KiB that is otherwise valid refused `jwt_svid_malformed`, with a valid padded token under the cap as the control
(`spiffe-jwt-svid.test.ts`); the upload-newer refusal and the disable ending trust (database suite, CI only). Each guard
was removed locally and its offline test seen failing, then restored. The database cases were typechecked only.

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

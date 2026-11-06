# ADR-0230: SAP business agents over MCP, starting with a governed Sales Order create

- **Status**: Proposed
- **Date**: 2026-11-06

## Context

The owner put P19 at the top of the post-demo backlog on 2026-11-03, together with P20
([internal/product/PENDING.md](../product/PENDING.md) §2e). P19 reads: agents call SAP business APIs through MCP under
governance. The first is Sales Order create (`API_SALES_ORDER_SRV`); after it, anything SAP exposes as an API.

What exists today:

- **The ABAP MCP server (the regulAIt-ABAP repo).** A separate product that sits behind our MCP proxy (ADR-0202
  freeze exception (b), ADR-0204 static credential, ADR-0210 OIDC bearer assertion). It ships development (ADT) tools:
  read source, activate, transports. It has no business-API tool. Its PRs #78 and #79 turn writes, free SQL and
  transport writes off by default; they wait on a smoke test against a BTP-hosted system before they land.
- **The MCP gateway path.** Every tool call goes through `mcp-proxy.ts`: per-user tool-level allow-list (default-deny),
  approval rules (`approval_rules`, with quorum, `write_only`, action-bound consent per ADR-0104, precedence per
  ADR-0229), rate limits (`rate_limits`, per tool, counted per user), the project budget gate
  (`preDispatchProjectGate`), the project PII mode, audit (tamper-evident, ADR-0060) and one `usage_events` row per
  allowed call. A tool with no `readOnlyHint: true` annotation is already classed as a write
  (`mcp-proxy.ts` `toolKind`).
- **Identity to the upstream.** ADR-0188 S8 sends a signed per-user identity assertion; ADR-0210 adds an
  OIDC-compatible ES256 bearer profile with a `scope` claim, which the ABAP MCP server's validator already accepts.
- **Egress.** Every upstream request goes through `createGuardedFetch` (DNS-pinned, redirect-refused, allow-listed).

What is missing is (1) a business-API write tool that is safe to retry, (2) the call reaching SAP as the person and
not as a shared technical user, and (3) defaults that make an SAP write approve-first without an admin having to
remember to configure it.

## Decision

### 1. The tools live in the ABAP MCP server; governance stays in RegulAIt

Business tools are added to the regulAIt-ABAP server on its existing plugin framework, beside the ADT tools. RegulAIt
does not grow an SAP client of its own. The split is the one we already have for every MCP server: the server knows
the target system's API, and the gateway decides who may call it, under what conditions, at what cost, and records it.
This keeps the product provider-agnostic (an SAP-certified or customer-built MCP server can stand in for ours, and
gets the same governance) and keeps SAP-specific code out of the gateway.

### 2. The first tool: `create_sales_order`

- **Target.** OData v2 service `API_SALES_ORDER_SRV`, entity set `A_SalesOrder`, one `POST` with a deep insert of
  `to_Item` (and optional `to_Partner`, `to_PricingElement`). Read-backs use `GET A_SalesOrder('<id>')`.
- **Narrow input schema.** The tool takes typed fields only: sales order type, sales organisation, distribution
  channel, division, sold-to party, purchase order reference, requested delivery date, and items (material,
  requested quantity and unit, optional plant). No free-form OData payload, no `$batch`, no arbitrary entity set, no
  custom headers. Values are validated against SAP's field lengths before the call. The tool is annotated
  `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` (true only because of the key below).
- **Idempotency key (required).** The caller supplies `idempotencyKey` (a UUID). The server:
  1. checks its idempotency store (specified below). A hit under the same principal and the same payload hash returns
     the original result without calling SAP. A hit under a different principal is refused
     (`idempotency_key_foreign`) and audited, and nothing about the original order is returned. A hit with the same
     principal and a different payload hash is refused (`idempotency_key_reused`);
  2. sends the key to SAP as SAP Gateway's idempotency headers where the service is configured for them: `RequestID`
     (the key as a 32-character GUID) and `RepeatabilityCreation`, reading `RepeatabilityResult`
     (`accepted`/`unsupported`/`rejected`; a 412 means not honoured). This is configured per service in SPRO ("Define
     Settings for Idempotent Services"). Verified only on an older SAP Gateway help page; whether S/4HANA honours it
     for `API_SALES_ORDER_SRV`, or the OASIS names `Repeatability-Request-ID`/`-First-Sent`, is **unverified** (open
     question 4). The key is **never** written into `PurchaseOrderByCustomer`. That field is not unique in SD, and it
     belongs to the customer's real purchase-order reference;
  3. on a timeout or a 5xx, never posts again blindly. It reads back, and treats the order as already created only when
     an order matches the **full key**: through `RepeatabilityResult` where SAP honours it, or through an optional
     header extension field the customer adds for the key (open question 4). In every other case, including when no
     full-key match is possible, the store entry moves to `needs_reconciliation`. The call is refused
     (`sap_outcome_unknown`) and a person reconciles the order. The server does not post again.

  The gateway also binds the key into the approval payload (ADR-0104), so one approval authorises exactly one order.
- **The idempotency store.** It is durable and safe across replicas:
  - **Storage:** a table in the ABAP MCP server's own database. It is never in memory and never in a per-replica cache.
  - **Key:** a unique constraint on (tenant, tool, `idempotencyKey`). `sub` is **not** part of the key; it is a column
    that holds the assertion's pairwise `sub`. A hit is then compared on `sub` first, and a different `sub` means
    `idempotency_key_foreign`. That comparison is what enforces the cross-user rule; a key containing `sub` would
    make a foreign key a silent miss. Each row also stores the payload hash, the state (`pending`, `succeeded`, `failed` or `needs_reconciliation`), the SAP document
    number on success, and timestamps.
  - **Write order:** the row is inserted as `pending` **before** the POST. A concurrent second call loses the insert and
    gets `idempotency_in_progress`.
  - **A stale `pending` row:** this happens if the server dies between the insert and SAP's answer. A row older than
    the call timeout plus a margin is not left in `idempotency_in_progress` forever. The next call with that key, or
    a sweeper, runs the full-key read-back. A full-key match moves the row to `succeeded`. Anything else moves it to
    `needs_reconciliation`, and nothing is posted again.
  - **Squatting:** a principal who learns someone else's key could otherwise claim it first. To prevent that, the
    gateway never sends the caller's key as is. It derives the stored key as HMAC-SHA256(per-server secret, tenant ‖
    pairwise `sub` ‖ caller key). Another principal cannot produce the same stored key, so squatting does not work.
    The `sub` comparison stays as a second check.
  - **Retention:** 30 days by default. An operator can shorten it, but never below 24 hours. Expired rows are deleted;
    a key presented after expiry is treated as new, and the gateway's approval binding still applies.
  - **Contents:** no payload body, only its hash.
- **CSRF handling.** SAP Gateway OData v2 writes need an `X-CSRF-Token` fetched first (`X-CSRF-Token: Fetch` on a
  `HEAD`/`GET`) and sent back with the same session cookies. The server fetches and holds it per user session; it is never cached across users.
- **Result.** The new sales order number, its overall status and the item count. The full SAP response body is not
  passed back to the model (it can carry pricing and partner data the caller did not ask for).

### 3. After it: a generic pattern for "anything SAP exposes as an API"

Each later business tool is a declarative descriptor in the server, reviewed like code, not a generic "call any OData
endpoint" tool:

| Descriptor field | Purpose |
|---|---|
| `service`, `entitySet`, `version` (OData v2 / v4) | the one API the tool may reach |
| `operation` (`read`, `create`, `update`, `action`) | maps to the MCP `readOnlyHint`; anything but `read` is a write |
| `inputSchema` | typed, narrow fields; no passthrough of raw OData |
| `select`/`expand` allow-list | what a read may return |
| `idempotency` | required for every non-read operation |
| `resultProjection` | the fields passed back to the model |
| `sensitivity` | feeds the gateway's data-scope and PII mode (pillar 3 cascade) |

Tool candidates are drafted from the API's published metadata (`$metadata`, or the API Business Hub specification),
but a person reviews and commits each descriptor. A generic passthrough tool (`odata_request`) is rejected: it would
make the allow-list meaningless, because the tool name would no longer say what the call does.

### 4. Principal propagation: the call runs as the person

The ADR-0210 assertion alone cannot do this. Its `sub` is pairwise, and SAP maps users by a stable attribute (login
name, e-mail or user UUID). So the design names three things: which claim carries the SAP-mappable identifier, how
that claim is released, and who issues the token SAP trusts.

- **Who issues the token SAP trusts. Two options, in order of preference:**
  - **(a) Preferred: the person's own corporate IdP token.** The customer's IdP is already trusted by the BTP
    subaccount or IAS. RegulAIt obtains a fresh token for the person from that IdP per call (see "where the
    token comes from" below), with its audience set to the SAP destination. It passes the token to the ABAP MCP server,
    which presents it to the `OAuth2JWTBearer` destination. RegulAIt then mints nothing that SAP trusts.
    Controls on option (a), because the token is usable at SAP without the gateway:
    - **Timing:** the token is obtained or exchanged **per call**, and only **after** the allow-list, approval,
      rate-limit and budget checks pass. It is never kept from sign-in.
    - **Lifetime and audience:** the shortest lifetime the IdP allows, with the audience pinned to the one SAP target.
    - **Storage:** by default nothing is kept. A kept refresh token exists only under the off-by-default
      `subject_token_retention` relaxation below.
    - **Logging:** the token is never logged, audited or passed to the model.
    - **The MCP server:** it uses the token only for the one call it came with, never persists it, and never reuses it.
    - **Where the token comes from when the approved call runs.** RegulAIt does not keep IdP tokens today (`auth.ts`
      keeps only the id_token claims), and an approved call can run long after sign-in. There are three sources, in
      this order:
      1. **Default: the person's live session.** A call that waited for approval does not run on its own. Once it is
         approved, it waits in `approved_pending_execution` until the requester confirms it. The confirmation includes
         a fresh authorisation at their IdP (an OIDC step-up with `max_age`, audience the one SAP target). That gives a
         short-lived token for this one call, and nothing from it is kept. A call that needs no approval uses the same
         fresh authorisation inside the person's request. If the person does not confirm within the approval's
         validity, the call expires and is audited.
      2. **A kept refresh token, an explicit relaxation (S6).** This is the per-connection setting
         `subject_token_retention`. It defaults to `none`, which means no IdP or refresh token is ever kept. Setting it
         to `refresh_token` is a `settings_relax` step-up and audited. When it is on:
         - the refresh token is requested for the one SAP audience only;
         - it is stored with the data-key envelope (`CIPHERTEXT_COLUMNS`) and never returned;
         - it has an absolute lifetime of at most 8 hours from the person's sign-in, whatever the IdP allows;
         - it is revoked at the IdP (RFC 7009, where supported) and deleted when the person's grant, the connection
           or the person is removed, and when the setting is turned off;
         - every use is audited, but never the token itself.
      3. **Option (b) below**, only where the customer's IdP cannot serve (1).
    
      "Kept from sign-in" is not a source.
  - **(b) Fallback: a RegulAIt assertion that SAP trusts.** This is allowed only where (a) is impossible, and only with
    the controls in the threat model:
    - a **dedicated signing key per SAP trust**, which is not the general ADR-0210 key, with its own issuer path
      (`<REGULAIT_PUBLIC_URL>/sap-trust/<connection>`);
    - ES256, with `aud` pinned to the one SAP target;
    - `exp` of 60 seconds or less, with a `jti` that RegulAIt records and refuses to mint twice. SAP-side rejection of a replayed `jti` is
      **unverified**; slice A0 confirms it, and it is treated as an extra control, not one we rely on;
    - rotation and revocation through the existing key management;
    - on the SAP side, IAS or the destination's trust restricted to the user group that may be asserted.
- **Which claim carries the SAP identity.** An admin chooses one attribute of the person's federated identity: login
  name, e-mail or the IdP user UUID. It is released as the claim `sap_user`. Under option (a) it is the IdP token's own
  claim; under (b) RegulAIt adds it.
- **How it is released (S3).** Release is a per-server setting, `mcp_servers.identity_release` (default `none`). Setting
  it to an attribute is a `settings_relax` step-up bound to the server, its url and the attribute, and it is audited.
  A url move resets it to `none`, as ADR-0210 does. While it is `none`, the server cannot map the person, so it refuses
  every business-tool call (`sap_identity_not_released`). Nothing is released implicitly.
- The server exchanges the token for an SAP-side user token through the BTP Destination service, using a destination
  of type `OAuth2JWTBearer` or `OAuth2SAMLBearerAssertion` (principal propagation). SAP maps `sap_user` to its own
  business user, and SAP's own authorisation objects (for sales orders, `V_VBAK_VKO`, `V_VBAK_AAT`) decide what
  that person may do. A technical user is refused for business-tool writes: the server will not run a non-read
  business tool on a destination of type `BasicAuthentication` or `OAuth2ClientCredentials`.
- RegulAIt's allow-list and SAP's authorisation both have to say yes. Neither replaces the other.
- On-premise systems are reached through the Cloud Connector with the same principal propagation; a direct
  on-premise URL with a technical user stays a development-only option and cannot carry business writes.

### 5. Secure by default (ADR-0180): every SAP write is approve-first

When an admin registers an MCP server and marks it as an SAP business server (`mcp_servers.system_class = 'sap_business'`,
new, default null), the gateway seeds, in the same transaction and audited:

1. **An approval rule**: fleet scope, that server, `write_only = true`, `approval_scope = 'action'`, quorum 2, requester
   excluded (the existing separation-of-duties check), approver the registering admin plus an approver role the admin
   must name. Relaxing it (lower quorum, `tool` scope, deleting it) is a `settings_relax` step-up and audited.
2. **A rate limit**: fleet scope, that server, 10 calls per user per hour on its **write** tools. `rate_limits` today
   has no way to select write tools, so slice A2 adds a `write_only` column (default false), matched by the existing
   `toolKind` classification as approval rules already do. One write-only row then covers every write tool, including
   tools discovered later. Raising or removing the limit is a relaxation.
3. **A project budget requirement**: a write to an SAP business server must be attributed to a project with an active
   budget; an unattributed SAP write is refused (`sap-write-needs-project`). The existing budget gate then applies.
4. **The tools start unassigned**: no person can call any tool until an admin grants it (the existing default-deny).

These are defaults, not hard-coded rules: they are ordinary rows the admin can see and change, and every change is
audited. The server's own defaults (#78/#79: writes, free SQL and transport writes off) are a second, independent
line of defence and stay off unless the server's operator turns them on.

### 6. Audit and cost rows

- **Audit**: the existing MCP rows, plus the business fields the reviewer needs: `object_type` `mcp_tool`, the SAP
  service and entity set, the idempotency key, the approval request id, and on success the created document number.
  Never the full payload's prices or partner addresses; those stay in the approval's bound payload hash. On an SAP
  error, the SAP error code is recorded but never SAP's error text.
- **Cost**: one `usage_events` row per allowed call, `object_type` `mcp_tool`, `operation` `create_sales_order`,
  `cost_usd` from the server's per-tool flat price (null means unpriced, never invented), and the project. A refused
  call (allow-list, approval denied, rate limit, budget) is audited and not costed. A call allowed but failed
  upstream is audited and charged nothing, as for A2A.
- **Idempotent replays** (a key hit that returns a cached result) are audited as `replayed` and not charged.

### 7. It rides the existing path

No new gateway choke point: `create_sales_order` is an MCP tool on a registered server, so the allow-list, approvals,
rate limits, budget gate, PII mode, kill switch, egress guard and audit all apply unchanged. The new gateway code is
small: the `system_class` column, the seeding of the defaults, the project requirement, and the business fields in the
audit detail. Egress from the gateway to the ABAP MCP server goes through `createGuardedFetch`; egress from the server
to SAP is the server's own, through the Destination service and the Cloud Connector.

### 8. Relationship to the regulAIt-ABAP repo

- **Order of landing.** #78 and #79 land first, after the BTP smoke test (an SAP BTP ABAP environment or S/4HANA
  Cloud trial, reached through the Destination service, with one read and one guarded write). The business tools
  build on that branch.
- **Ownership.** Slice A1 below is a PR in that repo, not in this one. This repo owns the gateway slices and the
  integration test that runs the server's tool against a fake SAP OData endpoint.
- **Contract.** The tool's MCP schema and annotations are the contract between the two repos; a change to either is a
  version bump in the server's tool manifest, which the gateway's MCP admission scan (ADR-0097, `mcp-admission.ts`)
  already flags for admin review.

### 9. Open source first (ADR-0176)

Search done 2026-11-06 (versions and licences from the npm registry). Full table below. Summary:

- **The SAP Cloud SDK for JavaScript fails the licence rule as published.** `@sap-cloud-sdk/http-client`,
  `@sap-cloud-sdk/odata-v2` and `@sap-cloud-sdk/connectivity` 4.10.0 are Apache-2.0, released this week, and handle
  CSRF (by default for non-GET OData v2 calls), the Destination service and principal propagation. But `http-client`
  depends on `connectivity`, and `connectivity` depends on `@sap/xssec` (SAP Developer License Agreement) and
  `@sap/xsenv` ("see licence in LICENSE"). ADR-0176 bars non-permissive licences in shipped code, so it cannot ship as
  is. Whether that binds the ABAP MCP server, a separate product that runs on BTP, is open question 7.
- **Proposed instead (if the licence rule binds):** `@odata2ts/odata2ts` 0.45.0 and `@odata2ts/http-client-fetch` 0.13.1
  (MIT) for a typed client generated from `$metadata`. The Destination-service lookup and token exchange use
  `oauth4webapi` (MIT; already pinned in this repo). What is left is ours, under the ADR-0176 item 4 exception: the CSRF
  fetch-and-hold, because odata2ts's CSRF support is unverified and no permissive module does only that. Its stated unmet
  requirement is the licence. It is re-checked when the Cloud SDK drops the SAP-licensed dependencies.
- **CAP (`@sap/cds` 10.2.2)**: rejected. It is under the SAP Developer License Agreement (not OSI, productive use limited
  to SAP platforms), and it is a service framework, not a client.
- **Third-party SAP MCP servers**: none replaces ours for governed business writes. See the table.
- **Gateway side**: nothing new. Policy, approval and audit are RegulAIt's own (ADR-0176 item 4).

## Open-source search

| Candidate | Licence | Latest release | Fit and verdict |
|---|---|---|---|
| `@sap-cloud-sdk/http-client`, `odata-v2`, `connectivity` | Apache-2.0, but transitive `@sap/xssec` (SAP DLA) and `@sap/xsenv` | 4.10.0, 2026-11 | Best function: CSRF, destinations, principal propagation; no runtime downloads. **Blocked by transitive licence** (open question 7). |
| `@sap-cloud-sdk/generator` and VDM packages | Apache-2.0 | — | Same dependency chain. Not used. |
| `@sap/cds` (CAP) | SAP Developer License Agreement v3.2 | 10.2.2, 2026-10-28 | Excluded by licence; a framework, not a client. |
| `@odata2ts/odata2ts` + `@odata2ts/http-client-fetch` | MIT | 0.45.0, 2026-09-22 / 0.13.1 | **Proposed** typed client from `$metadata`; works offline. CSRF support unverified. |
| `odata-query` | MIT | 8.1.0, 2026-05-20 | Query-string builder only; possible helper for reads. |
| `lemaiwo/btp-sap-odata-to-mcp-server` | MIT | (GitHub; date unverified) | Exposes any OData service as MCP tools including create: a generic passthrough, which section 3 rejects. Needs BTP Destination, Connectivity and XSUAA, so it does not work air-gapped. Not used. |
| `@cap-js/mcp-server` | Apache-2.0 | 0.1.0, 2026-10-26 | For CAP development, not business APIs. |
| `@sap-ux/fiori-mcp-server` | Apache-2.0 | 1.15.24, 2026-11-04 | For Fiori development. Not a fit. |
| `mcp-abap-adt`, `abap-adt-api` | MIT | 1.2.0, 2026-07-07 / 9.2.0, 2026-10-19 | ADT development tooling (the regulAIt-ABAP territory), not business APIs. |
| `mcp-sap-gui` | MIT | — | Python, Windows-only SAP GUI scripting. Not a fit. |

Unverified: the `A_SalesOrder` deep-insert specification on api.sap.com (the page rendered empty). Search snippets
say a header plus `to_Item` deep insert works, schedule lines cannot be deep-inserted, and the POST response may
return an empty `to_Item`, so the tool reads back after creating. This is confirmed in slice A1 against a real system.

## Alternatives rejected

- **An SAP client in the gateway.** Puts vendor code at the choke point and couples the gateway's release cycle to
  SAP API changes. The gateway would also hold SAP credentials, which today it never does.
- **A generic OData passthrough tool.** The allow-list, approval text and audit would say "odata_request" for every
  call, so neither an approver nor an auditor could tell an order from a price change.
- **A technical (communication) user for writes.** Every order would show the same SAP user; SAP's authorisation
  checks and change documents would no longer identify the person. Allowed only for read-only tools, and even there
  off by default.
- **No idempotency key, rely on the agent not to retry.** Agents do retry, and network timeouts after SAP commits
  are normal; a duplicate sales order is a real business error.
- **Approvals optional for SAP writes.** Contradicts ADR-0180. The seeded rule can be relaxed, audited, by an admin who
  decides to.

## Build plan (each slice one reviewable PR with tests)

| Slice | Repo | What | Tests |
|---|---|---|---|
| A0 | regulAIt-ABAP | Land #78/#79 after the BTP smoke test. Confirm against the smoke-test system which subject-token source the destination accepts: the person's own IdP token from a fresh step-up (the default), a kept refresh token, or option (b). Also confirm whether SAP rejects a replayed `jti`. | The repo's own suite plus the smoke-test record, with the subject-token result written into this ADR as an addendum. |
| A1 | regulAIt-ABAP | `create_sales_order` on the plugin framework: schema, CSRF, Destination-service principal propagation (odata2ts plus `oauth4webapi`, or the SAP Cloud SDK if open question 7 allows it), the durable idempotency store and full-key read-back, result projection, refusal on a technical-user destination, refusal without a released `sap_user`. | Unit tests against a recorded OData v2 fake: create; duplicate key under the same principal returns the original result; **the same key under another principal is refused and audited**; a key reused with other fields; two concurrent calls with one key; timeout then full-key read-back; timeout without a full-key match goes to `needs_reconciliation` and is not posted again; CSRF expiry; technical-user refusal. |
| A2 | RegulAIt | `mcp_servers.system_class`, `identity_release` and `subject_token_retention` (default `none`), the `approved_pending_execution` state with confirm-by-fresh-IdP-step-up, the HMAC-derived idempotency key, and `rate_limits.write_only` (one migration, renumbered at merge per M-108). The seeded defaults: approval rule, write-only rate limit, project requirement. Relaxations are `settings_relax` step-ups. Under option (b), the dedicated SAP-trust key, its issuer path, and `exp` 60 seconds or less with a `jti`. | Gateway tests: seeding in one transaction; a write-only limit covers a write tool added after seeding and ignores read tools; each relaxation, and releasing an identity attribute, needs a step-up and is audited; a url move resets `identity_release`; an approved call does not run until the requester confirms with a fresh step-up, and it expires if unconfirmed; with `subject_token_retention = none` no IdP or refresh token is ever stored; turning retention on needs a step-up, and removing the grant, the connection or the person deletes the kept token; two principals with the same caller key get different stored keys; an unattributed SAP write is refused, audited and not costed; the SAP-trust key never signs ADR-0210 assertions, and the reverse. |
| A3 | RegulAIt | Audit and usage detail for business tools (service, entity set, idempotency key, document number, `replayed`), and the idempotency key bound into the approval payload. | A key reused with other fields is refused; an approval for one key cannot authorise another; a replay is not charged. |
| A4 | RegulAIt | End-to-end: the ABAP MCP server image against a fake SAP endpoint in CI, through the real gateway with an approval quorum of 2. | `zz-p19-sap-sales-order.test.ts`. |
| A5 | Both | The descriptor pattern (section 3), with a second tool (a read: `get_sales_order`) to prove it. | Descriptor validation tests; read tool needs no approval but is still allow-listed and rate-limited. |
| A6 | RegulAIt | Admin UI: "SAP business system" flag on the server page, the seeded defaults shown and editable, the document number linked in the audit view. | Component tests; Lighthouse on the server page. |

## Threat model

| Threat | Mitigation |
|---|---|
| Agent creates orders the person never meant (prompt injection in a document) | Approve-first with quorum 2, requester excluded, action-bound consent showing the typed fields; rate limit; budget. |
| Duplicate orders from retries | Required idempotency key, server-side store, read-back before re-post, key bound to the approval. |
| Confused deputy: the call runs with more SAP rights than the person has | Principal propagation; technical-user destinations refused for writes; SAP authorisation objects still apply. |
| Token theft between gateway and server | ES256 assertion, short-lived, audience-bound to the server; sent only through the egress guard to the registered origin. |
| **The RegulAIt signing key becomes an SAP-trusted IdP (option (b))**: a key compromise, or a gateway bug, could mint any SAP business user the mapping covers, beyond the gateway's own grants | Option (a) is preferred, so RegulAIt mints nothing SAP trusts. Under (b): a dedicated key per SAP trust, never the general ADR-0210 key; its own issuer; `aud` pinned to the one SAP target; `exp` 60 seconds or less; a `jti` with replay rejection; rotation and revocation through key management; IAS or the destination's trust restricted to the user group that may be asserted; every assertion minted is audited. |
| **The person's own IdP token (option (a)) leaks** from the MCP server, a log or transit, and is used at SAP directly, bypassing approval, rate limit and budget | It is obtained per call and only after the gateway's checks pass; it has the shortest lifetime the IdP allows and an audience pinned to the one SAP target; it is never logged or audited; by default nothing is kept, and an approved call runs only after the person confirms it with a fresh IdP step-up; the MCP server never persists or reuses it. |
| **A kept refresh token (`subject_token_retention = refresh_token`)** is a long-lived credential SAP honours without RegulAIt | Off by default; turning it on is a step-up and audited; scoped to the one SAP audience; envelope-encrypted and never returned; absolute lifetime of at most 8 hours; revoked and deleted when the grant, the connection or the person is removed, or the setting is turned off; every use audited. |
| Idempotency key squatting | The stored key is an HMAC of tenant, pairwise `sub` and the caller's key, so another principal cannot claim it; the `sub` comparison remains as a second check. |
| Cross-user replay through the idempotency store | Uniqueness is on (tenant, tool, key), and `sub` is stored and compared on every hit. A hit under another principal is refused (`idempotency_key_foreign`), audited, and returns nothing. |
| Identity disclosure to the MCP server | `identity_release` is off by default; releasing an attribute is a step-up and audited; a url move resets it. |
| A duplicate order after an unknown outcome | No blind re-post. Only a read-back that matches the full key counts as "created"; anything else goes to `needs_reconciliation` for a person. |
| Arbitrary SAP access through a generic tool | No passthrough tool; each descriptor is a reviewed, narrow schema. |
| Data leakage back to the model | Result projection; PII mode of the project applies to arguments; full SAP body never returned. |
| CSRF token reuse across users | Token and cookies held per user session only. |
| SSRF from the server to internal hosts | The server reaches SAP only through named destinations, never a URL from the tool input. |
| An admin quietly weakens the defaults | Every relaxation is a `settings_relax` step-up and audited; the strictness registry shows it. |
| Spend runs away | Per-tool flat price attributed per call; project budget gate; refused calls not costed. |

### Security checklist items touched (ADR-0200)

- **Object-level authorisation on every read and write**: the person's grant plus SAP's own authorisation.
- **Permissions enforced server side**: gateway allow-list and approvals; the model cannot bypass them.
- **Rate limiting**: seeded per-tool limit on SAP writes.
- **API secrets server side only**: SAP credentials live in the BTP Destination service, never in RegulAIt or the
  model's context.
- **JWT pinned algorithm and audience**:
  - gateway to MCP server: the ADR-0210 ES256 assertion, with `aud` set to the server;
  - option (a): the person's IdP token, with its audience pinned to the one SAP target;
  - option (b): ES256 with a **dedicated per-SAP-trust key, never the ADR-0210 key**, `aud` pinned to the one SAP
    target, `exp` of 60 seconds or less and a `jti`.
- **No auth tokens at rest by default**: `subject_token_retention` defaults to `none`.
- **SSRF through the guarded fetch**: gateway to server; the server uses named destinations only.
- **No sensitive data in logs**: audit carries ids and the document number, not prices or addresses.
- **CSRF on state-changing requests**: SAP's own CSRF token is handled per session.
- **MFA for step-up**: every relaxation of the SAP defaults.

## Consequences

- Easier: any later SAP API is a reviewed descriptor, not a new integration; governance is identical to every other
  MCP tool, so the demo story ("a live SAP change runs through governance") extends to business data.
- Harder: the customer must set up principal propagation (IdP trust, Destination service, Cloud Connector for
  on-premise). This is the right default but a real onboarding step; the runbook must cover it.
- Given up: one-click SAP writes with a technical user.
- Follow-ups: approval-card rendering of business fields (a sales order preview); change and cancel tools; OData v4
  services (`API_SALESORDER_0001` style) through the same descriptor.

## Open questions for the owner

1. **Approval quorum default**: 2 with requester excluded, or 1 plus a named approver role?
2. **Rate-limit default**: 10 SAP writes per user per hour — right order of magnitude?
3. **Unattributed SAP writes**: refuse (proposed), or allow and attribute to a default "SAP" project?
4. **Full-key read-back on SAP's side** (decided: no blind re-post, unmatched means reconcile by hand). Should the
   runbook ask customers to enable SAP Gateway idempotency for `API_SALES_ORDER_SRV`, or to add a header extension field
   for the key, so that fewer timeouts end in manual reconciliation?
5. **Smoke-test system**: which BTP / S/4HANA trial system is used for A0? (No hostnames in this public repo.)
6. **Read-only business tools**: should they also default to approve-first, or only allow-list plus rate limit?
7. **Licence scope for the ABAP MCP server**: does ADR-0176's licence rule bind the regulAIt-ABAP product? If it does,
   the SAP Cloud SDK is out because of its SAP-licensed transitive dependencies, and we use odata2ts plus a small CSRF
   helper of our own. If it does not (it runs only on SAP's own platform), the Cloud SDK is the better fit.
8. **Which SAP identity attribute by default** when an admin turns release on: login name, e-mail or IdP user UUID?
   Proposed: no default, so the admin must choose.

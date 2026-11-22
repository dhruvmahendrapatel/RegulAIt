# ADR-0336: Discover agents built in Copilot Studio, Agentforce, OpenAI and n8n, through one adapter per vendor

- **Status**: Proposed (builder lane E17; the master accepts it on merge)
- **Date**: 2026-11-16
- **Index**: Agent platform discovery connectors (Copilot Studio, Agentforce, OpenAI, n8n): one read-and-governed-write adapter per vendor, staged default-deny records with normalised components
- **Extends**: [ADR-0195](0195-shadow-ai-active-discovery.md) (sources, credentials, worker, pseudonyms, guarded fetch),
  [ADR-0235](0235-wider-discovery-sources.md) (family switches) and the vendor agent registry importer of lane E3 (the
  decision record on PR #855: the `agent_registry` family, `agent_registry_records` and the explicit import). Nothing
  is duplicated: this ADR adds source kinds, registries and one child table to that importer.
- **Built in**: lane E17, branch `builder/e17-discovery-connectors`, three slices (below). Code starts after #855 merges.
- **Migration**: one pending migration per slice that needs it (`pending/<slug>.sql`, numbered at merge, ADR-0252)

## Context

The owner's 2026-11-16 gap analysis against Obsidian Security's AI Agent Security product
([GAP_ANALYSIS_OBSIDIAN_2026-11.md](../product/GAP_ANALYSIS_OBSIDIAN_2026-11.md) §3; the gap numbers below are its
ranking) puts vendor-platform agent discovery first (gap 1). RegulAIt
already scans clouds, repos, endpoints and Entra consents (ADR-0195, ADR-0235), and #855 imports agents from Entra
Agent ID, Agent 365, Gemini Enterprise and Bedrock AgentCore. Agents built in **Microsoft Copilot Studio**,
**Salesforce Agentforce**, the **OpenAI** builders (ChatGPT custom GPTs, AgentKit) and **n8n** are not seen at all.
Each of them can hold models, tools, MCP servers and connections into business systems, under an owner RegulAIt does
not know.

The owner's rules for this work (2026-11-16): read-only toward vendor platforms by default; everything staged and
default-deny until a human approves; credentials server side and rotatable; every vendor call through the guarded
fetch; audit in the same transaction; vendor-neutral adapters. The decisions on #855 bind this lane: **no automatic
steward** (R1), and **a vendor-side rename updates only the staged copy** (R2). Lane E19 (in-platform disable and
quarantine) will reuse the adapter defined here, so one adapter per vendor must serve both the read and the governed
write.

What the vendors expose, read on 2026-11-16 from vendor documentation (no live tenant; every adapter is tested
against fakes):

| Platform | Read used | Auth | Read-only check |
|---|---|---|---|
| Copilot Studio | Dataverse Web API per environment: `GET {org}/api/data/v9.2/bots`, `botcomponents` (by `_parentbotid_value`), `connectionreferences` | Entra app-only token for the environment (`@azure/identity`, federated by default) as a Dataverse application user | `WhoAmI` then `RetrieveUserPrivileges`: refused if any Create, Write, Delete, Append, AppendTo, Assign or Share privilege is held |
| Agentforce | REST and Tooling SOQL `GET …/query?q=`: `BotDefinition` (`AgentType`), `BotVersion`, `GenAiPlannerDefinition`, `GenAiPluginDefinition` (topics), `GenAiFunctionDefinition` (actions) | OAuth 2.0 JWT bearer flow for an integration user (assertion signed with `jose`) | `UserPermissionAccess`: refused if `ModifyAllData`, `CustomizeApplication` or any permission on a fixed write list is true |
| OpenAI (ChatGPT) | Compliance API listing of the workspace's custom GPTs (configuration, owner, actions, files metadata) | Compliance API key, static (the vendor offers no federation) | none the vendor exposes: reported `unverified` on the run |
| n8n | Public API `GET /api/v1/workflows?excludePinnedData=true` (cursor-paged) | `X-N8N-API-KEY`, static | `GET /api/v1/discover` lists the key's scopes on n8n 2.14+ (found in slice 3): any non-read scope refuses it; older instances: `unverified`; the source's docs ask for a key with only `workflow:list` and `workflow:read` |

Why not the obvious Microsoft endpoint: the Power Platform **inventory API** (`resourcequery/resources/query`) returns
every Copilot Studio agent tenant-wide with model and connectors, but Microsoft documents (2026-11) that it accepts
**delegated user tokens only** and returns 403 to service principals and managed identities. Using it would mean storing
a user's refresh token, which ADR-0195's credential model refuses. The per-environment Dataverse read is app-only and
can be made provably read-only with a custom security role. When Microsoft adds app-only access to the inventory API,
the Copilot Studio adapter switches to it (follow-up, no contract change).

Why not the AgentKit Agent Builder: as of 2026-11-16 OpenAI documents no admin endpoint that lists a workspace's
Agent Builder workflows. The OpenAI adapter reads ChatGPT custom GPTs only and says so; Agent Builder joins when an
admin listing is documented. The Compliance API also does not return the apps connected to a GPT (OpenAI community
reply, 2026-08), so a GPT's connected apps are what its configured actions name, and that limit is on the record.

## Decision

1. **Four source kinds in the existing `agent_registry` family, under its existing org switch (off by default).**
   `agent_registry_copilot_studio`, `agent_registry_agentforce`, `agent_registry_openai` and `agent_registry_n8n`,
   with the registries `copilot_studio`, `agentforce`, `openai_gpts` and `n8n`. Everything ADR-0195 and #855 give a
   registry source is reused unchanged: encrypted per-tenant credentials that are never returned, federation where the
   vendor offers it, a stored secret only as a step-up relaxation, the guarded fetch, the scheduler and leases, token
   scrubbing, the step-up to enable a source, the fenced commit, and "absent only after a complete read".

2. **One adapter per vendor, serving read and governed write.** A new `AgentPlatformAdapter` wraps, it does not
   replace, the existing `Scanner`:

   ```ts
   interface AgentPlatformAdapter {
     vendor: AgentPlatformVendor;              // "microsoft" | "salesforce" | "openai" | "n8n" | …
     kind: DiscoverySourceKind;                // the read source kind
     scanner: Scanner;                         // the read path, exactly as #855 runs it
     /** what lane E19 may do to an imported agent on this platform; declared here, executed only by E19 */
     governedActions: readonly GovernedActionSpec[];
   }
   interface GovernedActionSpec {
     action: "disable" | "quarantine" | "unquarantine";
     reversible: boolean;
     vendorPermission: string;                 // the least permission the vendor documents for it
   }
   ```

   **Every registry vendor is an adapter, including #855's.** Slice 1 wraps #855's existing registry scanners (Entra
   Agent ID with Agent 365, Gemini Enterprise, Bedrock AgentCore) as `AgentPlatformAdapter`s with
   `governedActions: []`, and the scanner registry for the `agent_registry` family is built from that one adapter
   list. There is then exactly one list, and E19 fills in actions (Entra and Bedrock both document disable paths)
   through the same interface for every registry vendor.

   Rules for the write side that this ADR fixes and E19 implements: a write uses a **separate** write credential
   (credential purpose `platform_write`, a fixed rule rather than a field), never the read one; the read credential is
   still refused when it can write; the read credential is never used to write and the write credential is never used
   to read; every write is an approval-gated, step-up, audited action decided by E19's decision record; a vendor with
   no documented write declares no action. E17 ships the declarations and no write code.

   Known write paths, recorded for E19: Agentforce deactivation of the active `BotVersion`; n8n
   `POST /workflows/{id}/deactivate` (`workflow:activate`); OpenAI GPT removal through the Compliance API (destructive
   and not reversible, so E19 decides whether to offer it). **Open constraint, not a known path:** Copilot Studio
   `SetAsQuarantined` / `SetAsUnquarantined` (Power Platform API) is documented only for a delegated admin user token
   with `CopilotStudio.AdminActions.Invoke`, which ADR-0195's credential model refuses. Until Microsoft documents an
   app-only path, the Copilot Studio adapter declares no action, and E19 decides how, or whether, to close it.

3. **Owner, models, tools, MCP servers and connected apps are normalised, not packed into JSON.** A new child table
   `agent_registry_record_components` holds one row per (record, kind, vendor reference): kind is `model`, `tool`,
   `mcp_server`, `connected_app` or `knowledge`; with a display name and the few typed facts the vendors give
   (enabled, who provides the connection: maker or end user). It is replaced for a record in the same fenced commit
   whenever that record is read completely, and kept untouched after a partial read; slice 1 pins both halves of that
   invariant in a database test. Third normal form: a list of things an agent uses is a table, never a jsonb array.

   Protection of the table, same as every new table in the pending migrations:
   - `record_id` is a NOT NULL foreign key to `agent_registry_records` with `ON DELETE CASCADE`, so components never
     outlive their record or its source;
   - row-level security is enabled **and forced**, with the admin-or-system-task policy the pending tables use
     (`regulait_rls_is_admin()` or a `system_task`/`migration` system reason); the parent's routes are admin-only, so
     this changes no reader;
   - every text column is bounded by a CHECK (vendor reference, display name, kind), as `agent_registry_records` is;
   - it is covered by the parent's retention, and by the privacy-ops erasure locator wherever the parent is. Owner and author stay as #855 stores them: `idp_user`
   pseudonyms in the record's bounded vendor attributes, never names or emails (author vs runner, gap 5, uses both).

4. **Never read a secret.** Connected apps are references only: a connector id, a connection-reference id, a
   credential type and id. No adapter calls an endpoint that returns credential material: n8n `GET /credentials` is
   never called, workflows are read with `excludePinnedData=true`, node parameters are reduced to the fields the
   adapter maps (node type, model name, MCP endpoint origin), and Dataverse and Salesforce reads select named columns
   only. An MCP or tool endpoint URL is reduced to its scheme, host and port: userinfo (`user:pass@`), path, query and
   fragment are dropped before anything is stored.

   **Never store agent instructions or prompt content.** These reads can return an agent's own text: a GPT's
   instructions and conversation starters (Compliance API configuration), Copilot Studio topics and generative
   instructions (`botcomponents`), Agentforce planner and topic instructions (`GenAiPlannerDefinition`,
   `GenAiPluginDefinition`), and an n8n agent node's system message. That text often holds customer data, internal
   process detail or pasted credentials. No instruction, prompt, topic body, conversation starter or knowledge-file
   content is stored anywhere: not in `agent_registry_records`, its vendor attributes,
   `agent_registry_record_components`, audit rows or logs. Only names, ids, counts and enabled flags are kept, plus,
   where change detection needs it, a SHA-256 hash and a length of such text. Adapters select only named fields, and
   each slice's tests list the exact fields per vendor, so a test fails if an adapter keeps a content field.
   **Plaintext secrets in agent configurations are found in memory, reported by location only** (owner, 2026-11-17,
   competitor gap audit row 6; slice 4). While a record is read, each content field the adapter selects for
   hashing is also passed, in memory only, through the existing vendored secret matcher (`vendoredSecretSpans` over
   `VENDORED_SECRET_RULES`, ADR-0186, the rule set the ADR-0042 guardrails and the ADR-0195/ADR-0055 discovery
   scanners already use). A hit raises a discovery finding that names only the location: the source, the staged
   record, the vendor's object id, the field path and the rule id. The matched value, any excerpt or offset into
   the text, and any hash of the secret are never stored, logged or audited, and the content itself is dropped
   when the read ends, as above. No new matcher, table or ADR: the finding reuses the existing discovery finding
   path.

5. **Credential checks and secrets, per run.**
   - The Copilot Studio `RetrieveUserPrivileges` check and the Agentforce `UserPermissionAccess` check run at the start
     of **every** run, not only when a source is enabled. A write privilege added later fails that run, marks the
     credential `refused` as ADR-0195 decision 7 does, and nothing is read with it.
   - A credential whose scope cannot be checked (the OpenAI and n8n keys; a community-edition n8n key carries full
     scope) is accepted only as a recorded relaxation (ADR-0180): the stored-secret step-up that enables the source
     names `scope: unverified` in its binding and its audit row, and the source's API representation carries the same
     `scope: unverified` field, not only a label on each run.
   - The Agentforce JWT signing key is held like every other stored secret: encrypted with the data key, never
     returned, rotatable. It is bound to one consumer key and one integration user, and the assertion lives for
     2 minutes (Salesforce allows 3 for clock skew) with a fresh `jti`. **Corrected in slice 2:** Salesforce documents
     the `aud` as its authorization server, `https://login.salesforce.com` for production or
     `https://test.salesforce.com` for a sandbox, not the My Domain host, so `aud` follows the source's validated
     `environment`, and the My Domain host must match that environment. The token endpoint the assertion is POSTed to
     is derived from the validated My Domain host, never from configuration or a vendor response (the returned
     `instance_url` is ignored), so a signed assertion cannot be sent anywhere else.
   - **Every adapter enforces a fixed endpoint allow-list in code.** Each adapter's fetch wrapper, on top of the
     guarded fetch, admits only the (method, path template) pairs the adapter declares, and refuses anything else
     before the request leaves:
     - n8n: `GET /api/v1/workflows`, and (slice 3) `GET /api/v1/discover` for the key's scope check, only;
     - OpenAI: the Compliance API GPT listing endpoint(s) only;
     - Copilot Studio: `GET` on the Dataverse `WhoAmI`, `RetrieveUserPrivileges`, `bots`, `botcomponents` and
       `connectionreferences` paths only;
     - Agentforce: `GET` on the REST and Tooling `query` paths (and their locator pages) only, plus the single token
       `POST` above. `UserPermissionAccess` is read through the `query` path.

     Against the vendor's API the read credential is used with `GET` only; the one exception is that token exchange.
     Entra token acquisition for Dataverse stays on the existing ADR-0195 `@azure/identity` path, unchanged.
     Pagination cursors are passed back on an allow-listed path, never followed as URLs (no `nextRecordsUrl`, `next`
     or `@odata.nextLink` is fetched as given): Dataverse's `$skiptoken` as a query parameter on the adapter's own
     first URL, and Salesforce's query locator, checked against its fixed shape, as the last segment of the adapter's
     own `query` path. Each slice's tests assert that any other method or path, and a cursor
     that would leave the path, is refused before a request is made. This matters most for the OpenAI and n8n keys,
     whose scope cannot be checked: the allow-list is the control that keeps a possibly broad key on its read
     endpoints, and it also makes "the read credential is never used to write" enforced rather than declared.
   - The OpenAI source's documentation states plainly how broad a Compliance API key is (it reaches workspace data
     well beyond the GPT listing), so the admin who accepts the `scope: unverified` relaxation knows what is stored.

6. **Targets are named, never guessed, and shape-checked.** Copilot Studio takes a list of 1 to 20 Dataverse org
   URLs (`https://<org>.crm[N].dynamics.com`, each validated; as built in slice 1, a sovereign-cloud host is refused,
   because its Entra authority differs from the one the existing `@azure/identity` path uses); Agentforce a My Domain URL on a
   Salesforce host and a pinned API version (default 67.0); OpenAI a workspace id; n8n a base URL. A self-hosted n8n on
   a private address is reachable only through the guarded fetch's existing egress allow-list; this ADR adds no SSRF
   exception. Each adapter's `validateTarget` refuses anything else before a write.

7. **Import stays #855's: explicit, one record at a time, default-deny.** An imported agent starts disabled, lifecycle
   `proposed`, no model, no grant of any kind, no automatic steward (R1), with the provider set from the adapter's
   vendor. A vendor rename touches the staged record only (R2). The import audit row carries the provenance and the
   component count in the same transaction.

8. **API only.** New routes, if a slice needs any (a record's components), are added to the route census with a
   `KNOWN_UI_GAPS` entry pointing at #453. No screen is built in this lane.

9. **No new lifecycle; states come from one declared table.** This lane adds no status field of its own. A
   credential's read-only state is ADR-0195's `DISCOVERY_WRITE_SCOPE_STATES` (`unverified`, `read_only`, `refused`),
   and slice 1 adds its allowed transitions next to that list in `@regulait/shared` as one declared table
   (`unverified`→`read_only`/`refused`, `read_only`→`refused`, `refused` final until the credential is replaced),
   which the worker and the routes both read instead of branching on their own. A staged record's present/absent
   state and an imported agent's lifecycle stay #855's and ADR-0089's, unchanged.

## Slices

1. This ADR, the adapter contract (wrapping #855's registry scanners as adapters too), `agent_registry_record_components`, and the Copilot Studio adapter.
2. The Agentforce adapter.
3. The OpenAI and n8n adapters.
4. Plaintext-secret findings in imported agent configurations (decision 4), across all four adapters.

## Slice 1 as built

- **Adapter contract:** `apps/gateway/src/agent-platform-adapters.ts`. `AGENT_PLATFORM_ADAPTERS` wraps #855's three
  registry scanners (`governedActions: []`, `readEndpoints: null`, since they reach fixed hosts through ADR-0314's
  helpers) and adds Copilot Studio. The `agent_registry` scanners in `DISCOVERY_SCANNERS` are built from that list.
- **Endpoint allow-list:** `allowListedFetch` (`agent-platform-endpoints.ts`) refuses any other method, origin or
  path, or any userinfo, before the request leaves. A refusal is recorded as a `denied` read outcome.
- **Copilot Studio:** `agent-registry-copilot-studio.ts`. `WhoAmI` and `RetrieveUserPrivileges` run on every run;
  any privilege that is not `prvRead*` refuses the credential. The credential is `read_only` only when every
  environment's privileges were listed and all of them are reads. The columns read are pinned in tests. Dataverse
  paging passes `$skiptoken` back on the adapter's own URL; a next link to another origin or path ends the listing,
  which then reads as partial.
- **Components:** `agent_registry_record_components`, migration `pending/vendor_agent_platform_components.sql`.
  The file is named to sort after `agent_registry_records.sql` and `saas_entitlement_graph.sql`, because pending
  files are applied and numbered in byte order and the latter re-creates the kind CHECKs. RLS is forced. The table is
  shown on `GET /v1/agent-registry/records/:id`, so no new route is added, and its count is on the import audit row.
- **Write-scope states:** `DISCOVERY_WRITE_SCOPE_TRANSITIONS`, `nextDiscoveryWriteScope` and
  `discoveryWriteScopeFinal` in `@regulait/shared`, read by the worker and the discovery routes.

## Slice 2 as built

- **Agentforce:** `agent-registry-agentforce.ts`, kind `agent_registry_agentforce`, registry `agentforce`, provider
  `salesforce`.
  - **Credential:** static only (Salesforce takes no external OIDC token). The public config is the consumer key and
    the integration user's name; the secret is the PKCS#8 private key. The JWT bearer helper is `salesforce-jwt.ts`,
    kept apart so the ADR-0337 Salesforce entitlement reader can reuse it.
  - **Read-only check:** first on every run, `UserPermissionAccess` (eleven write, escalation and user-management
    permissions) and then `ObjectPermissions` over the user's permission-set assignments (any object write). Either
    refuses the credential, and a check that cannot be read means nothing is read.
  - **Reads:** `BotDefinition`, `BotVersion` (the active version), `GenAiPlannerDefinition` (Tooling, for
    `LinkedBotVersionId`), `GenAiPluginDefinition` (topics, counted) and `GenAiFunctionDefinition` (actions, staged
    as `tool` components, linked to their agent through `PlannerId` or their topic). The SOQL is pinned in tests, and
    no free-text column is selected.
  - **Run-as user:** staged as a pseudonym only.
- **Migration:** `pending/vendor_agent_platform_components_agentforce.sql` widens the kind and registry CHECKs. It is
  named to sort after slice 1's file, which re-creates the same CHECKs.

## Slice 3 as built

- **OpenAI:** `agent-registry-openai.ts`, kind `agent_registry_openai`, registry `openai_gpts`, provider `openai`.
  - **Read:** `GET https://api.chatgpt.com/v1/compliance/workspaces/{workspaceId}/gpts`, `limit=20` (OpenAI's documented
    default; its reference names no maximum), `file_format=id` (file ids, never download URLs), paged by passing
    `last_id` back as `after` after a shape check. Live workspace GPTs only: the listing excludes drafts and
    third-party GPTs.
  - **Components:** built-in tools (`tool`), custom actions as `connected_app` by domain (sign-in `oauth` → supplied
    by the end user, a stored key → by the maker), knowledge files by id and name (`knowledge`). There is no model
    row: the Compliance API does not report one.
  - **Kept fields:** pinned in `OPENAI_GPT_FIELDS`. `instructions`, `conversation_starters`, `description`,
    `categories`, `action_openapi_raw` and file content are never kept. The owner is a pseudonym of the owner's email.
  - **Credential:** static, an admin key with `chatgpt.enterprise.compliance_export: read`; always `unverified`.
- **n8n:** `agent-registry-n8n.ts`, kind `agent_registry_n8n`, registry `n8n`, provider `n8n`.
  - **Agent:** a workflow is staged when a node in it receives an `ai_languageModel` connection. Its components are
    the nodes feeding such a root over `ai_languageModel` (model), `ai_tool` (tool; MCP client as `mcp_server` by
    origin; vector store as `knowledge`), `ai_vectorStore`, `ai_retriever` or `ai_document` (knowledge), plus the
    credential references of every node (`connected_app`, type and id, supplied by the maker).
  - **Kept fields:** from a node, only its id, name, type, disabled flag, model name and MCP endpoint origin; a system
    message, a tool parameter or pinned data is never kept.
  - **Paging:** `nextCursor`, shape-checked, is passed back as `cursor` on the adapter's own URL. A target may carry
    a path prefix, and the allow-list is built under it.
  - **Scope check (a finding of slice 3, tightening decision 5):** n8n 2.14+ answers `GET /api/v1/discover` with
    the key's scopes. Any scope that is not `:read` or `:list` refuses the key before a workflow is read; read scopes
    only record `read_only`; an instance without the endpoint, or one that lists no scopes, stays `unverified`.
- **The recorded relaxation (decision 5):** `DISCOVERY_SCOPE_UNVERIFIABLE_KINDS` in `@regulait/shared` declares the two
  kinds once. The stored-secret step-up, the enable step-up and the credential-on-enabled-source step-up each carry
  `credentialScope: "unverified"` in their binding, and a grant confirmed without it is refused. The credential-stored
  and source-enabled audit rows carry the same field, and the source view and its credential view carry
  `credentialScope` (`unverified` or `checked`). Other kinds' bindings are unchanged. Setup and key-breadth guidance
  is in `docs/deployment/AGENT_PLATFORM_DISCOVERY.md`.
- **Migration:** `pending/vendor_agent_platform_components_openai_n8n.sql` widens the kind and registry CHECKs. It is
  named to sort after slice 2's file.
- **Known limits (slice 3):** OpenAI is moving custom GPTs to workspace agents and plugins, and its Compliance API has
  separate listings for those, which this slice does not read yet. A failed page ends an OpenAI run, because the run
  has one listing; nothing is then staged or marked absent.

## Slice 4 as built

- **Finding path:** the existing discovery observation path, with no new table, matcher or ADR.
  - **Evidence kind:** the new `agent_config` (`DISCOVERY_EVIDENCE_KINDS`). The OpenAI and n8n kinds declare
    `evidenceKinds: ["agent_config"]` and `subjectKinds: ["system"]`. Copilot Studio, Agentforce and the #855 registry
    kinds declare none until they scan (#1130 R9 [3]).
  - **Observation:** `{ evidenceKind: "agent_config", subjectKind: "system", subject: <staged record external id>,
    location: { path: <field path> }, secretRule: <vendored rule id> }` and nothing else.
  - **Worker checks** (`checkConfigSecret`):
    - It refuses any extra field, a line or commit (an offset), an unknown or personal-data rule, and a credential
      shape in the path or the subject. Refusals never echo the input.
    - It sets the vendor from the adapter list.
    - It refuses the run when a finding names a record that the same run did not stage.
  - **Classification** (`classifyObservation`, branch 0): no catalogue row is involved. The result is the platform
    vendor, severity `critical`, matched value = the rule id, and a reason that names the path and the rule.
  - **Storage:** the finding is a `shadow_ai_findings` row like any other discovery finding.
  - **Migration:** `pending/vendor_agent_platform_config_secrets.sql` widens `shadow_ai_imports_kind_ck`.
- **Matcher:** `vendoredSecretSpans` over `VENDORED_SECRET_RULES`, filtered by `AGENT_CONFIG_SECRET_RULES_EXCLUDED`
  (social security number, public OAuth client id, and, for a future pack refresh, credit card number, IBAN and
  Ethereum address: not credentials). The allowed set is pinned in a test, so a refresh that adds a rule fails until
  the rule is classified (#1130 R9 [1], S9 [2]).
- **Paths:** a path segment taken from vendor text is kept only when it is a plain identifier with no credential
  shape; otherwise it becomes its position, so a credential planted as a key cannot fail the run (#1130 S9 [1]). A
  field whose path would still be refused (longer than 512 characters) is skipped and counted (#1130 R9 [2]). `ConfigSecretCollector` drops each
  span at once and keeps the path and the rule only, at most 20 per agent and 1,000 per run (a count-only read outcome
  beyond that); a field is scanned up to 256 KiB.
- **Fields scanned (in memory, then dropped):** decision 4 says "each content field the adapter selects for hashing";
  no adapter hashed content before this slice, so slice 4 introduces the scanned-field lists.
  - **OpenAI:** `OPENAI_GPT_SCANNED_FIELDS`: a GPT configuration's `instructions`, `description` and
    `conversation_starters`, and each custom action's `action_openapi_raw`. The listing already returns them, so
    nothing more is fetched, and none of them is kept (`OPENAI_GPT_FIELDS` is unchanged).
  - **n8n:** every string parameter of every node of an agent workflow (a system message, an HTTP tool's header value,
    a code node's source), at most 2,000 per workflow and 8 deep. The path is built from node ids and parameter keys
    only; a segment that is not a plain identifier becomes its position.
  - **Copilot Studio and Agentforce:** not scanned in this slice. Their adapters select no content column (decision
    4), so scanning would widen what is fetched from the vendor (`botcomponents.data`; planner and topic
    `Description`). That widening is left as an owner question rather than done silently.

## Open-source check (ADR-0176)

Searched 2026-11-16. Reused: `@azure/identity` (MIT, already used for Entra) for Dataverse tokens; `jose` (MIT,
already in the gateway) to sign the Salesforce JWT bearer assertion; the guarded fetch and the bounded listing helpers
#855 and ADR-0235 already use. Considered and not adopted: `jsforce` (MIT, maintained), because the adapter issues a
handful of SOQL GETs and jsforce brings its own HTTP stack that would have to be routed through the guarded fetch; the
Dataverse and Power Platform .NET SDKs (not JavaScript); the `openai` npm SDK (Apache-2.0), which does not cover the
Compliance API; and n8n's own packages, which are under the Sustainable Use License and cannot ship. Each adapter is
the RegulAIt-specific part: mapping a vendor's agent shape onto the governed inventory.

## Consequences

- Admins see and can import agents from four more platforms, with what each agent can reach broken out as rows that
  posture, risk and least-privilege work (gaps 2, 4 and 5) can join on.
- Lane E19 gets a single place per vendor to add disable and quarantine, with the credential split already fixed.
- **Known limits:** Copilot Studio needs one application user per environment and does not see classic (V1)
  chatbots; its components are knowledge sources (`botcomponent` types 14 and 16), skills (types 1 and 13) and the
  connectors behind its connection references, and no model or MCP-server row, because Dataverse states those only
  inside the agent's configuration text, which is never read (decision 4); OpenAI covers ChatGPT custom GPTs only, without connected apps; n8n and OpenAI keys cannot be proven
  read-only and their runs say `unverified`; n8n's community edition keys carry full scope, which the source's docs
  state plainly.
- **Agentforce read-only check (slice 2, tightened on #1111 review):** `read_only` is recorded only when both checks
  pass.
  - The session holds none of the write, escalation or user-management system permissions: `ModifyAllData`,
    `ModifyMetadata`, `CustomizeApplication`, `AuthorApex`, `ManageUsers`, `AssignPermissionSets`,
    `ManageProfilesPermissionsets`, `ManageInternalUsers`, `ManageRoles`, `ManageSharing` and `ResetPasswords`.
  - No permission set assigned to the user (profiles included) grants Create, Edit, Delete or Modify All Records on
    any object.

  The user is the one the token response's identity URL names. Either check refuses the credential, and a check that
  cannot be read means nothing is read. The integration user therefore needs View Setup and Configuration, to read
  the setup objects, plus read access to the agent objects. RSA keys under 2048 bits are refused.
- **Agentforce known limits (slice 2):** components are the agent's actions only: Salesforce exposes no model name, and an
  action's connected service is not a separate field. An agent whose planner is not linked through
  `GenAiPlannerDefinition.LinkedBotVersionId` keeps its stored components, because the read cannot tell "none" from
  "not found".
- **Follow-ups (PENDING fragment):** the inventory API for Copilot Studio once it accepts app-only tokens; AgentKit
  Agent Builder once listable; the import and components screens
  (#453).

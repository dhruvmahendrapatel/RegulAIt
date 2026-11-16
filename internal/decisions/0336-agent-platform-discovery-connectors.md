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
| n8n | Public API `GET /api/v1/workflows?excludePinnedData=true` (cursor-paged) | `X-N8N-API-KEY`, static | none the API exposes: `unverified`; the source's docs ask for a key with only `workflow:read` |

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
   Finding secrets embedded in agent configurations (gap 6) has to read that text, so it is its own decision, under
   the ADR-0042 guardrail and PII posture and the compliance cascade's retention, not a widening of this one.

5. **Credential checks and secrets, per run.**
   - The Copilot Studio `RetrieveUserPrivileges` check and the Agentforce `UserPermissionAccess` check run at the start
     of **every** run, not only when a source is enabled. A write privilege added later fails that run, marks the
     credential `refused` as ADR-0195 decision 7 does, and nothing is read with it.
   - A credential whose scope cannot be checked (the OpenAI and n8n keys; a community-edition n8n key carries full
     scope) is accepted only as a recorded relaxation (ADR-0180): the stored-secret step-up that enables the source
     names `scope: unverified` in its binding and its audit row, and the source's API representation carries the same
     `scope: unverified` field, not only a label on each run.
   - The Agentforce JWT signing key is held like every other stored secret: encrypted with the data key, never
     returned, rotatable. It is bound to one consumer key and one integration user; the assertion lives for the
     shortest time Salesforce accepts, and its `aud` is pinned to the source's validated My Domain login host.

6. **Targets are named, never guessed, and shape-checked.** Copilot Studio takes a list of Dataverse org URLs
   (`https://<org>.crm[N].dynamics.com`, plus the sovereign suffixes, each validated); Agentforce a My Domain URL on a
   Salesforce host and a pinned API version (default 67.0); OpenAI a workspace id; n8n a base URL. A self-hosted n8n on
   a private address is reachable only through the guarded fetch's existing egress allow-list; this ADR adds no SSRF
   exception. Each adapter's `validateTarget` refuses anything else before a write.

7. **Import stays #855's: explicit, one record at a time, default-deny.** An imported agent starts disabled, lifecycle
   `proposed`, no model, no grant of any kind, no automatic steward (R1), with the provider set from the adapter's
   vendor. A vendor rename touches the staged record only (R2). The import audit row carries the provenance and the
   component count in the same transaction.

8. **API only.** New routes, if a slice needs any (a record's components), are added to the route census with a
   `KNOWN_UI_GAPS` entry pointing at #453. No screen is built in this lane.

## Slices

1. This ADR, the adapter contract (wrapping #855's registry scanners as adapters too), `agent_registry_record_components`, and the Copilot Studio adapter.
2. The Agentforce adapter.
3. The OpenAI and n8n adapters.

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
  chatbots; OpenAI covers ChatGPT custom GPTs only, without connected apps; n8n and OpenAI keys cannot be proven
  read-only and their runs say `unverified`; n8n's community edition keys carry full scope, which the source's docs
  state plainly.
- **Follow-ups (PENDING fragment):** the inventory API for Copilot Studio once it accepts app-only tokens; AgentKit
  Agent Builder once listable; embedded-secret findings in agent configurations; the import and components screens
  (#453).

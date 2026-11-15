# ADR-0314: Import agents from vendor agent registries into the agent inventory

- **Status**: Proposed (builder lane E3, G6; the master accepts it on merge)
- **Date**: 2026-11-15
- **Extends**: [ADR-0195](0195-shadow-ai-active-discovery.md) (active discovery: sources, credentials, worker, pseudonyms)
  and [ADR-0235](0235-wider-discovery-sources.md) (family switches, the Entra Graph read). Neither is duplicated.
- **Migration**: the `agent_registry_records` migration (pending, numbered at merge)
- **Index**: Vendor agent registry import (Entra Agent ID, Agent 365, Gemini Enterprise, AgentCore)

## Context

Market gap G6 (pillar 1 with 7). Enterprises now keep agents in vendor registries: Microsoft Entra Agent ID and the
Agent 365 catalogue, Google Gemini Enterprise, and AWS Bedrock AgentCore. An agent that exists there but not in
RegulAIt has no steward, no review date and no governed entitlements. ADR-0195 and ADR-0235 already scan clouds and
Entra app consents for shadow AI. But discovery only writes `shadow_ai_findings`, and `agents` has no provenance
column, so there was no path from "a registry lists this agent" to "this agent is in the inventory and owned".

What the vendors expose (read on 2026-11-15; live tenants are owner-gated, so every adapter is tested against fakes):

| Registry | Read call | Least-privilege permission |
|---|---|---|
| Entra Agent ID | `GET graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentity` (paged by `@odata.nextLink`); owners at `…/{id}/microsoft.graph.agentIdentity/owners` | `AgentIdentity.Read.All` (application) |
| Agent 365 | `GET graph.microsoft.com/v1.0/copilot/admin/catalog/packages` (needs an Agent 365 licence) | `CopilotPackages.Read.All` |
| Gemini Enterprise | `GET {location-}discoveryengine.googleapis.com/v1alpha/projects/*/locations/*/collections/default_collection/engines/*/assistants/default_assistant/agents` | `discoveryengine.agents.list` |
| Bedrock AgentCore | `ListAgentRuntimes` (`bedrock-agentcore-control`, REST `POST /runtimes/`, a read), per region | `bedrock-agentcore:ListAgentRuntimes` |

The older beta Graph Agent Registry API (`/beta/agentRegistry/agentInstances`) is being replaced by the Agent 365
APIs, per Microsoft's own notice, so it is not used. Entra's `sponsors` listing needs `AgentIdentity.ReadWrite.All`, a
write permission, so it is not read either: owners are read instead.

## Decision

1. **A new discovery family, `agent_registry`, behind its own org switch, off by default.** Three source kinds:
   `agent_registry_entra` (Agent ID, plus the Agent 365 catalogue when the target sets `agent365=true`),
   `agent_registry_gemini` and `agent_registry_agentcore`. They reuse ADR-0195 unchanged: per-tenant customer
   credentials (encrypted with the data key, never returned, never in code), federated by default (Entra workload
   identity, GCP workload identity, AWS web identity, with the ADR-0195 SD2b audiences), a stored secret only as a
   step-up relaxation, the egress-guarded fetch, the scheduler and leases, scrubbing of every token, and the step-up
   to enable a source. Turning the family on is a `settings_relax` step-up bound to that family (ADR-0235's rule).

2. **Read-only.** Graph and Discovery Engine calls are GETs. AgentCore's list call is a POST that reads. The Entra
   credential is refused before anything is read if its token carries any permission that is not `.Read.All`
   (ADR-0195 decision 7). The Google token is minted for the read-only `cloud-platform.read-only` scope. AWS cannot
   report a role's permissions to the role, so AgentCore's write scope is "unverified" and says so on the run.

3. **The adapter interface is the existing `Scanner`, plus a `RegistryAgentRecord` result.** A registry scanner
   reports no observations (so no shadow findings). It returns `registryAgents` and the registries it read
   completely. The worker shape-checks them (`checkRegistryAgents`: only the registries the kind may report, bounded
   fields, at most 16 attributes, people only as pseudonyms) and stages them in the run's fenced commit. Another vendor
   (Atlassian agent accounts first) adds a kind, an `AGENT_REGISTRIES` value and a scanner. Nothing else changes.

4. **Staging with provenance: `agent_registry_records`.** One row per (source, registry, vendor id), with the run
   that last saw it, first and last seen, and `absent_since`. A record is marked absent only when a COMPLETE read of
   its registry no longer lists it, never after a partial read (a cap, a denied region, an unlicensed catalogue).
   Vendor attributes are a bounded verbatim subset of the vendor's record. This is a documented 3NF exception, and
   owners appear in it only as `idp_user` pseudonyms.

5. **Import is explicit, one record at a time, and default-deny.** `POST /v1/agent-registry/records/:id/import`
   (admin-only) requires a `settings_relax` step-up bound to `{op: agent_registry_import, recordId, name}`, and is
   gated by the licence expansion gate like `POST /v1/agents`. It creates the agent with:
   - `enabled = false`;
   - lifecycle `proposed`, with the import as the reason;
   - provider `microsoft`, `google` or `aws`;
   - no model, so it cannot be dispatched;
   - the tier the admin gives;
   - an optional active steward;
   - **no grant of any kind**: no user grant, no workload identity and no identity grant.

   The record links to the agent through a unique `agent_id`, so one agent has one registry origin. The audit row
   carries the provenance (record, source, registry, vendor id, last run). Deleting the agent re-opens the record.

6. **API only; the screens are a known UI gap on #453.** Three routes: list (keyset-paginated, at most 200), get and
   import. All three are in `KNOWN_UI_GAPS`.

## Open-source check (ADR-0176)

- **AWS:** `@aws-sdk/client-bedrock-agentcore-control` 3.1160.0 (Apache-2.0, released 2026-11-13). It is pinned to the
  version of the other AWS clients, sits in `@regulait/cloud-discovery` beside them, and is listed in its
  `THIRD_PARTY.md`. It signs requests, which we must not hand-write.
- **Microsoft:** `@microsoft/microsoft-graph-client` was considered and not adopted. The two Graph reads are GETs with
  OData paging, and they go through the existing `getJson`/`readListing` helpers that the ADR-0235 Entra scanner
  already uses: bounded bodies, a same-origin `nextLink`, and the guarded fetch. The client adds a middleware chain to
  route through `ctx.fetch` and solves nothing we lack. The token still comes from `@azure/identity`, which is
  already in use.
- **Google:** the GAPIC `@google-cloud/discoveryengine` client is gRPC-first, and ADR-0195 decision 8 refuses gRPC.
  The token comes from `google-auth-library`, which is already in use through `gcpAuthClient`, and the list call is
  one REST GET.

## Consequences

- An admin can bring every agent the vendor registries hold into the inventory, with a steward, a lifecycle and the
  normal review cadence. Each imported agent then gets entitlements one grant at a time.
- **Known limits:**
  - Gemini's `agents.list` documents that it lists the agents the caller created. A registry-wide admin list is not
    documented, so a source may see fewer agents than the console. This is said in the source's docs.
  - Entra owner reads are capped at 200 identities per run.
  - AgentCore needs the regions named; RegulAIt never guesses the regions that are enabled.
- **Follow-ups (PENDING G6):**
  - the import screen (#453);
  - an Atlassian agent account adapter;
  - an Agent 365 instance listing once the Agent 365 Graph APIs leave preview;
  - optionally, linking an imported Entra agent to a RegulAIt workload identity (ADR-0188). That link would be a grant
    step, so it stays out of import.

## Owner decisions (2026-11-15, relayed by the master on #855)

- **R1, steward:** an imported agent gets no steward automatically, as built. An admin may name one at import or
  later. Matching a vendor-side owner would need a pseudonym reveal, a step-up of its own.
- **R2, vendor renames:** a vendor rename updates only the staged record, as built. The inventory row is RegulAIt's
  and changes only when an admin accepts the change by editing the agent.
- **R3, Gemini:** no live Gemini tenant check for now. The limit stays documented under Consequences: `agents.list`
  documents that it lists the agents the caller created.

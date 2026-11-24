# ADR-0358: AI adoption analytics and CMDB sync

- **Status**: Accepted (owner decision 2026-11-17, competitor gap audit items C16 and C2; lane E39)
- **Date**: 2026-11-17
- **Index**: **AI adoption analytics (active users per AI tool, team and project over time; seat utilisation, licensed vs active, from imported vendor lines; the top tools in use) as aggregate-only, admin-only, versioned and paginated reads over the existing ledgers, with small-cohort suppression and no per-person ranking unless an admin turns it on; and an export-only CMDB sync, ServiceNow first behind a vendor-neutral adapter, that pushes the AI asset inventory as configuration items through the IRE API and reads ownership back.**
- **Built in**: lane E39, branch `builder/e39-adoption-cmdb` (slice 1: analytics; slice 2: CMDB sync)
- **Migrations**: `pending/adoption_analytics_policy.sql` (slice 1), `pending/cmdb_sync.sql` (slice 2), numbered at merge (ADR-0252)
- **Related**: ADR-0069 (cross-vendor cost consolidation: metered and imported never blended), ADR-0076 (reconciliation and
  roster), ADR-0322 (opt-in vendor usage pull, the credential and egress pattern reused here), ADR-0082 and ADR-0089
  (the agent inventory and ownership), ADR-0034 (the guarded fetch), ADR-0062 (mode-scoped egress), ADR-0063 (the data
  key), ADR-0064 (the scheduler), ADR-0180 (secure by default), ADR-0176 (open source first), ADR-0200 (guidelines,
  3NF, security checklist), ADR-0234 (row-level security)

## Owner decision (2026-11-17, recorded by the master in the lane E39 brief)

> (1) Adoption analytics: active users per AI tool, team and project over time; seat utilisation (licensed vs active,
> from vendor usage imports); the top tools in use. Reuse the usage ledger, the vendor usage pull (#861, ADR-0322) and
> the inventory. Keep metered spend and imported figures apart, as ADR-0069 and ADR-0076 already do. Results are
> aggregates only: no per-person ranking unless an admin enables it (privacy default). Use a versioned, paginated API.
>
> (2) CMDB sync, ServiceNow first, behind a vendor-neutral adapter: push the AI asset inventory (agents, MCP servers,
> models, endpoints) to the CMDB as configuration items, and read back ownership. Export only by default. Credentials
> stay server side and rotatable. All traffic goes through the guarded fetch. Writes are idempotent and audited.
> Compare existing open-source ServiceNow clients and CMDB connectors first.

## Part 1: adoption analytics

### Decision

Adoption analytics is a set of **read-time aggregations, admin-only, under `/v1/adoption/*`**. It adds no copy of the
ledgers: like the ADR-0082 inventory, every figure is a `SELECT` over tables the gateway already writes.

**Two sources, never blended.**

| block | source | what "active" means |
|---|---|---|
| `metered` | `usage_events` (the gateway's own ledger) | a person made at least one governed call to the tool in the bucket |
| `imported` | `imported_cost_lines` in an `applied` batch, not superseded (ADR-0069, ADR-0076; pulled lines from ADR-0322 land here too) | a vendor account had a usage line with a positive quantity or amount in the window |

A person counted in both blocks is counted in each block separately. No response has a field that adds the two.

**Tools.** A metered tool is one of: an agent (model dispatch, `object_type = 'agent'`, by `agent_id`), a connector
(`connector_id`), an MCP server (`mcp_tool` rows, by `detail.serverId`) or an A2A agent (`a2a_agent` rows, by
`detail.a2aAgentId`). Rows written for the gateway's own work (guardrail scorers and similar) are not adoption and are
left out. Names are joined at read time (third normal form); a tool whose row was deleted reads with a null name. An
imported "tool" is the vendor string of the imported line (`github-copilot`, `cursor`, `anthropic`, …).

**Routes (v1).**

- `GET /v1/adoption/active-users`: metered active users per bucket (`day`, `week`, `month`, UTC) and per tool, grouped
  by nothing, team (`team_members`; a person in two teams counts in each) or project (the row's `project_id`).
- `GET /v1/adoption/top-tools`: metered tools ranked by active users then calls; and, as a separate block, imported
  vendors ranked by active accounts.
- `GET /v1/adoption/seats`: imported seat utilisation per vendor (optionally per team): accounts with a live seat line
  overlapping the window (`licensed`), of those the ones with usage (`activeLicensed`), the rest (`idleLicensed`),
  usage with no seat (`activeWithoutSeat`) and `utilisation = activeLicensed / licensed`. A vendor whose imported
  lines carry no usage at all reads `activityKnown: false` and `utilisation: null`, never 0 %: "no evidence of use" is
  not "unused".
- `GET /v1/adoption/people`: the per-person view (calls and active days per person and tool). **Refused (403
  `per_person_ranking_disabled`) unless the policy turns it on.** Every successful read writes an audit row.
- `GET /v1/adoption/policy`, `PUT /v1/adoption/policy`.

Every list is **paginated** (`limit` 10, 50, 100 or 500; `offset`, bounded) and answers `nextOffset`. The window is
`from`/`to` (default the last 30 days, at most 366 days; a day bucket at most 92 days). The prefix `/v1/` is the
version; a breaking change is a `/v2/` route, per the API stability registry.

**Privacy defaults (ADR-0180).** The policy is a singleton table `adoption_analytics_policy`:

- `per_person_ranking`: **off**. Turning it on is a relaxation: admin-only, `settings_relax` step-up, a required
  reason, audited in the same transaction.
- `min_cohort_size`: **5**. Any count of people (or accounts) between 1 and `min_cohort_size - 1` is returned as `null`
  with `suppressed: true`, so a small team's figures cannot single a person out. Lowering it (to 1 at the least) is a
  relaxation with the same step-up, reason and audit; raising it is not.

No cache: the reads are bounded aggregate queries and a cache would have to be scoped per caller.

### What this part does not do

- It never computes a per-person ranking by default, and the aggregate routes never return a user id.
- It does not infer licences from metered traffic, nor activity from seat lines.
- No screen: the routes are API-only, listed as known UI gaps pointing at #453.

## Part 2: CMDB sync

### Open-source comparison (ADR-0176, owner build rule 9)

Searched npm and GitHub on 2026-11-17.

| candidate | licence and upkeep | fit |
|---|---|---|
| `servicenow-rest-api` 1.2.2, `servicenow-lite` 1.1.0, `node-servicenow` 1.2.0, `servicenow-client` 1.0.7 | MIT/ISC; no release since 2022 | rejected: not actively maintained; thin Table API wrappers with their own HTTP client, no way to inject the guarded fetch |
| `sn-rest-client` 2.1.14 | LGPL-3.0 | rejected: licence outside the allow-list |
| `@servicenow/sdk` 4.14.2 | MIT, active | rejected: the Fluent build-and-deploy toolchain for scoped apps (CLI, compiler), not a runtime REST client |
| `pysnow`, `knuckles-team/servicenow-api` | MIT; Python | rejected: wrong runtime (the gateway is Node) |
| ServiceNow Service Graph Connectors | ServiceNow Store apps | rejected as the transport (they run inside the instance and are licensed per instance); the IRE API below is what they call |
| NetBox (Apache-2.0, active) | a CMDB, not a client | noted as a later adapter target, not a dependency |

**Chosen:** ServiceNow's own documented REST APIs, called with the guarded fetch directly and validated with `zod`
(already a dependency): `POST /api/now/identifyreconcile` (the Identification and Reconciliation Engine, which
ServiceNow says to use instead of writing CMDB tables) for the push, and the Table API
(`GET /api/now/table/{class}/{sys_id}` with dot-walked `sysparm_fields`) for the ownership read-back. What is
hand-written is RegulAIt's: which assets are exported, the policy, the audit and the idempotency ledger.

### Decision

- **A vendor-neutral adapter** (`CmdbAdapter`: `push(items)`, `readOwnership(refs)`), ServiceNow the first
  implementation. A new CMDB is a new adapter, not a new code path.
- **What is exported**: the AI asset inventory: agents, MCP servers, models (the distinct provider and model pairs of
  the agent registry) and endpoints (enrolled, unrevoked endpoint devices, by pseudonym only). Each item carries a
  stable source key (`regulait:<kind>:<id>`), its name and kind. No prompt, configuration body, credential, email or
  free text leaves.
- **Idempotent**: every item is sent with `sys_object_source_info.source_native_key` set to its source key, so IRE
  matches the same CI on every push. A per-item ledger (`cmdb_ci_links`) keeps the CI `sys_id` and the sha-256 of the
  last payload sent; an unchanged item is not re-sent. Each sync writes a run row (open-first) and an audit row.
- **Export only by default.** The read-back of ownership is a separate switch, off by default. When it is on, the
  CMDB's `owned_by` is **recorded beside** the link (an email the CMDB reported, and the RegulAIt user it matches, if
  any). It never overwrites RegulAIt's own owner field: applying it is a separate, explicit, audited admin act per item.
- **Off by default, three switches** (as ADR-0322): the connector is created disabled, its host must be in the egress
  allow-list, and it cannot be enabled without a stored credential. Refused under `REGULAIT_DEPLOY_MODE=air_gapped`.
- **Credentials**: stored under the data key (`secrets.ts`, ADR-0063), listed in the ciphertext census, never returned
  or logged; rotation is a compare-and-set replace; revoke destroys the ciphertext and disables the connector.
  Storing, rotating and enabling need the `settings_relax` step-up and a reason; revoking needs neither.
- **Egress**: only the configured instance host (`*.service-now.com` or an admin-listed host already in the egress
  allow-list), through `createGuardedFetch` with a response cap; no redirects.
- **Scheduler**: a `cmdb-sync-sweep` job (ADR-0064), every 6 hours, a no-op while no connector is enabled; a "sync now"
  route runs the same function.
- **Row-level security** on every new table: an active admin principal, `system_task` and `migration` only.

### ServiceNow setup the admin does (stated on the posture read)

1. Add a `discovery_source` choice for RegulAIt on `cmdb_ci` (the IRE requires a registered source name).
2. Create an integration user with the `itil` and `import_transformer` roles (or a narrower custom role that can call
   IRE on the chosen classes and read `owned_by`).
3. Choose the CI class per asset kind (default `cmdb_ci_appl` for every kind; configurable per connector).

## Alternatives rejected

- **A copied analytics table refreshed by a job.** Rejected: the ledgers are indexed by time and kind, and a copy
  would be one more place a deleted user's data lingers.
- **One "active users" figure across metered and imported.** Rejected by ADR-0069.
- **Per-person ranking on by default for admins.** Rejected by the owner's privacy default.
- **Writing CMDB tables directly through the Table API.** Rejected: ServiceNow documents IRE as the way to insert or
  update CIs, and IRE gives the idempotent identification this design needs.
- **Two-way sync by default.** Rejected: export-only is the owner's default; the CMDB never changes RegulAIt state
  without an admin act.

## Consequences

- An admin can answer "who uses which AI tool, how much of what we license is used, and what is used most" without a
  BI export, and without seeing named people unless they turn that on, which is audited.
- RegulAIt can hold a CMDB credential: a new secret class with the ADR-0322 custody rules.
- A ServiceNow API change can break the push; the adapter fails the run with a fixed error code and writes nothing for
  the items it could not confirm.

## As built

- **Slice 1 (analytics).** As decided, with these details: the per-person view is metered only (imported accounts are
  vendor identities, not people, until resolved); the imported vendor ranking in `/v1/adoption/top-tools` is returned
  whole up to 100 vendors with a `truncated` flag rather than paged (one row per vendor); when `licensed`,
  `activeLicensed` or `idleLicensed` is suppressed, `activeLicensed`, `idleLicensed` and `utilisation` are withheld
  together, since any one of them with `licensed` gives the others back. Migration `pending/adoption_analytics_policy.sql`. The six routes are known UI gaps on #453.

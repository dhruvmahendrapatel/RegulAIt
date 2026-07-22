# RegulAIt — Governance & Access-Control Layer Spec (P0 Pillar 1)

> Source: original specification authored for RegulAIt during bootstrap planning (2026-07-21),
> synthesized from gaps identified across Atlas, Cursor, and Lovable (see
> [VISION.md](VISION.md)) — this is **original spec, not a description of an existing product
> feature**. See [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md) for the co-equal Pillar 2.

> **This is the highest-priority requirement in the product.** Every other feature (connectors,
> agents/models, MCP servers, publishing, security scanning) must be built **on top of** this
> governance layer, not alongside it. Design principle: **"Build governance into whatever anyone
> can do using AI"** — no connector call, no agent invocation, and no MCP tool call should be
> able to bypass the policy engine described below.

## 1. Why this matters (synthesis from Atlas/Cursor/Lovable)

None of the three researched products has fully solved this — each has a *piece* of it:
- **Atlas** comes closest: an explicit "Access Control" screen where an admin scopes a *specific
  user* to specific Sources, Connectors, Initiatives, and additional Apps/Agents individually
  ("All" vs. named-item selection, including future items). But it does not expose per-user,
  per-tool rule enforcement *within* a single MCP server.
- **Cursor (Enterprise)** allows org-wide allow/deny lists for repos, models, and MCP servers,
  and "Organization groups" for marketplace/MCP visibility — but controls are largely
  **group/role-based**, not natively **per-individual-user** without provisioning a dedicated
  group per person.
- **Lovable (Enterprise)** gates **categories** of MCP access (Remote MCP connectors, Local
  desktop MCP servers, Third-party MCP clients — the last disabled by default) at the
  **workspace** level, and gates data/connector visibility mostly through **roles and groups**,
  not fine-grained per-user, per-server, per-tool rules.

**The gap across all three**: none of them lets an admin say, in one place, *"User A can use
Agent X and Agent Y but not Agent Z; User A can use the Salesforce connector but only in
read-only mode; User A can use MCP Server B but only 3 of its 14 tools, and every write-tool call
requires manager approval; User C gets none of this."* That combination — **individual-user-level,
tool-level, and rule-level control across agents, connectors, and MCP servers simultaneously,
from one admin portal** — is RegulAIt's core requirement and its main differentiator.

## 2. Governance data model (what needs to be governable)

A policy engine sits between **every** user-initiated AI action and the underlying resource,
around four object types:

| Object type | Examples | Granularity of control |
|---|---|---|
| **Agents / Models** | Any publicly available agent or model the platform can route to (Claude family, GPT family, Gemini family, Grok, open-weight models, the platform's own in-house agent) | Per-user allow-list/deny-list of which agents/models a user may invoke at all; can further restrict *which mode* of an agent (e.g., planning-only vs. full execution) |
| **Connectors** | SaaS/data connectors (CRM, data warehouse, ticketing, spreadsheets, cloud storage, etc.) | Per-user grant of which connectors are visible/usable; per-connector mode (read-only vs. read-write); per-connector data-scope limits (e.g., specific objects/tables/folders only) |
| **MCP servers** | Any internal or third-party MCP server registered to the workspace | Per-user grant of *which servers* are visible; per-user, per-server grant of *which individual tools* within that server are callable; per-tool rule sets (see §3) |
| **Initiatives / Projects / Workspaces** | Logical groupings of agents+connectors+MCP servers assembled for a business use case | Per-user grant of which initiatives a user can see or contribute to (mirrors Atlas's "Initiatives" scoping) |

Every grant defaults to **deny** (explicit allow-listing), matching Atlas's "pre-approved
building blocks only" anti–shadow-IT posture, rather than default-allow with exceptions.

## 3. Per-MCP-server, per-user rule enforcement (the most granular layer)

The most technically demanding — and most differentiating — requirement. For **each MCP
server**, and **independently for each user** (not just each role), an admin must be able to
define:

- **Tool-level allow-list**: which of the server's exposed tools this specific user may invoke.
  Tools not on the list should not even be visible to the user's agent (not just blocked at
  execution time) — mirroring Cursor's enterprise MCP allow-lists, but scoped to the individual.
- **Read vs. write distinction**: a first-class flag per tool (or inferred from a tool-metadata
  convention) distinguishing read-only from state-mutating/write tools, so an admin can grant
  "read everything, write nothing" in one toggle.
- **Approval requirements**: any tool call (or any matching a rule, e.g. "any write to a
  production database") can be configured to pause and require a named approver's sign-off —
  modeled on Atlas's "writes pause for human approval" and Lovable's "Ask before sending"
  pattern, generalized to *any* MCP tool call for *any* user.
- **Rate/volume limits**: per-user, per-server (and optionally per-tool) caps on call frequency
  or data volume, bounding blast radius of a compromised or misconfigured agent session.
- **Data-scope restrictions**: constrain a tool's effective reach even if the tool itself is
  generic — e.g. a user may query a Snowflake MCP server's `query_database` tool, but only
  against an allow-listed set of schemas/tables, enforced by the gateway rather than trusted to
  agent behavior.
- **Conditional/contextual rules**: vary by time of day, sandbox vs. production origin,
  first-party vs. "publicly available" third-party invoking agent (see §4), or data sensitivity
  classification.
- **Per-server override of platform defaults**: a user's default MCP posture (e.g. "read-only
  across all servers") should be overridable **per specific server**.
- **Full audit trail per rule evaluation**: every allow, deny, and approval-required decision is
  logged with the acting user, the tool, the input, the rule that fired, and the outcome —
  feeding the same audit/SIEM pipeline referenced in the product's security features.

## 4. Any publicly available agent, with per-user restriction

The platform must be **agent-agnostic and provider-agnostic** at the routing layer — but this
must **not** mean every user automatically gets every agent:

- **Global agent registry**: a catalog of every publicly available agent/model the platform can
  route to, kept current as new agents/providers become available, decoupled from per-user
  entitlement.
- **Per-user agent entitlement**: independent of the global registry, each user has an explicit
  allow-list of which agents they may select — e.g. User A can use Agent X and Agent Y but not
  Agent Z, even though Agent Z exists in the platform-wide catalog and other users can use it.
- **Per-user default and ceiling**: an admin sets both a *default* agent for a user and a
  *ceiling* (the most capable/expensive agent they're permitted to escalate to), independent of
  what other users in the same role are permitted.
- **Mode-level restriction on top of agent-level restriction**: even where an agent is permitted,
  an admin can restrict it to a subset of its modes/capabilities for that user (e.g. allowed for
  Plan/read-only reasoning, not allowed for autonomous Build/execution).
- **New-agent-onboarding policy**: opt-in by default (consistent with deny-by-default) — nobody
  gets a newly-added agent/model until explicitly granted.

## 5. Roles, permissions, and per-user overrides (Admin Portal)

Both a roles/permissions system for scale **and** true per-user override for precision — one
without the other reproduces the gaps found in Cursor's and Lovable's group-based models:

- **Role builder**: admins define custom roles as named bundles of default entitlements across
  all four §2 object types.
- **Per-user override layer**: assigning a user to a role sets their *baseline*; the admin can
  then add or revoke individual entitlements for that specific user without altering the role or
  affecting other members — every override is visibly flagged as a deviation from role defaults,
  and reversible independently.
- **Bulk and individual views**: a user-management table for bulk edits, and a per-user detail
  drawer (mirroring Atlas's "User details / Access Control" panel) for precision edits.
- **Group support as a convenience layer, not the only layer**: groups (synced via SCIM) can
  drive role assignment at scale, but individual override must always be available on top.
- **Policy-as-code / API**: every governance object (roles, per-user grants, MCP rule sets, agent
  entitlements) must be readable and writable via API, not only the UI — governance itself is
  version-controlled, code-reviewed, and deployed like infrastructure.
- **Preview/simulate mode**: before saving a policy change, an admin can simulate "what would
  User X be able to do right now" to catch over/under-provisioning before it goes live.

## 6. Admin Portal — functional surfaces

1. **Users & Roles** — user directory, role assignment, per-user override drawer, bulk actions, SCIM/SSO sync status.
2. **Agent Governance** — global agent/model catalog with platform-level enable/disable, per-user/per-role entitlement matrix (agent × user grid, mode-level drill-down).
3. **Connector Governance** — connector catalog, per-user/per-role grants, read/write mode toggle, data-scope constraints per connector.
4. **MCP Server Governance** — MCP server registry, per-server tool inventory (auto-discovered from the server's tool manifest), per-user/per-role tool-level allow-lists, rule builder (§3), OAuth/connection health status.
5. **Policy & Rules Engine** — a central rule builder expressing cross-cutting policies (e.g. "any write-capable tool call from a non-first-party agent requires approval") rather than re-entering the same rule per server or per user.
6. **Audit & Activity Log** — searchable, filterable log of every governed action (allowed/denied/pending), exportable and SIEM-forwardable.
7. **Approvals Queue** — one inbox for pending approval-required actions, not scattered Slack/email notifications.
8. **Simulation / "Access preview"** — the what-if tool described in §5.

## 7. How this composes with the rest of the product

This governance layer is the **enforcement boundary** every other product feature must pass
through:
- Every **connector call** is checked against the user's connector grant and mode before executing.
- Every **agent/model invocation** is checked against the user's agent entitlement and mode-level restriction before the request is even routed to that agent/model.
- Every **MCP tool call**, first-party or third-party, is checked against the per-user, per-server, per-tool rule set — including any approval requirement — before the tool executes, and the result is written to the audit log.
- Security-scanning, audit-logging, and compliance features should be treated as *consumers* of the same underlying event stream this layer produces, not separate logging systems.

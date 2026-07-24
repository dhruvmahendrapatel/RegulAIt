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

## 8. Infrastructure Operations, Compliance-Classification Cascade, and Deployment Model

### 8.1 Why this matters

The sections above (§1–§7) govern *AI-usage* — which human user may invoke which agent/model/
connector/MCP tool, and under what per-call rules. They do not, on their own, govern the
*infrastructure our own control plane and any customer-hosted agent runtime actually run on* — is
it patched, drift-free, backed up, and deployable in the sovereign/air-gapped posture some
regulated buyers require? That's a distinct governance surface (infra-operations and deployment
architecture, not AI-tool-call governance), and it needs to be built deliberately rather than left
implicit. This section promotes that surface into committed scope, matching the operational depth
of the most mature infra-governance platforms in this category (drift detection/remediation, CVE
patching, certificate rotation, backup policy, a single-tag compliance cascade, and a control-
plane/agent-execution-plane split with an explicit data-boundary disclosure) without duplicating
what §1–§7 already own.

### 8.2 Infrastructure operations governance (an "Operate" layer)

- **Drift detection & remediation**: continuously diff the running state of our own control
  plane, gateway, and any customer-hosted agent runtime against a declared policy baseline; flag
  deviations; auto-remediate where policy allows, otherwise queue for human review. Critical drift
  always requires explicit approval before remediation, reusing the same Approvals Queue defined
  in §6.
- **Automated CVE patching and certificate rotation** for every component we operate (the
  gateway, any self-hosted agent runners, MCP-server proxies), applied continuously rather than on
  a fixed release cycle.
- **Backup policy & retention management**: centralized backup intent (schedule, retention
  window, encryption) for governance state, audit logs, workflow definitions, and Shared Project
  context (§9), with evidence of execution retained for audit — not just for customer application
  data.
- **Lifecycle management**: coordinated upgrades of our own runtime components (gateway versions,
  policy-engine versions) across a fleet of customer deployments, with approval gates.

### 8.3 "Born governed" — compliance-classification cascade

A single-tag activation model, extending [WORKFLOW_ENGINE_SPEC.md §4](WORKFLOW_ENGINE_SPEC.md)'s
assignment rules from "one condition among several" into a first-class cascade:

- An admin classifies an **Initiative or Shared Project** (§9) with one or more compliance
  frameworks (HIPAA, PCI-DSS, SOC 2, GDPR, ISO 27001, NIS2, DORA, or a custom internal
  classification).
- That single classification automatically cascades into: the required workflow template(s) and
  sign-off/approval stages ([WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md)), the MCP/
  connector data-scope restrictions and read/write defaults (§2–§3 above), the audit-log retention
  period, and any PII/sensitive-data handling mode (block/warn/log) for every user and agent
  working within that Initiative — with no manual per-control setup.
- Reclassifying an Initiative re-evaluates and reapplies the cascade to everything currently in
  flight under it, surfacing a diff of what changed for admin review before committing — a
  classification change is never applied silently.
- This is the single authoritative ceiling every other feature area's "aggressiveness" or
  "optimization" setting must respect — most directly the token/cost optimization layer's
  admin-tunable dials (see
  [TOKEN_OPTIMIZATION_SPEC.md §12](TOKEN_OPTIMIZATION_SPEC.md)), which must never relax below what
  a workload's compliance classification requires.

### 8.4 Explicit data-boundary disclosure (control plane vs. agent/execution plane)

- **RegulAIt control plane (our SaaS)**: stores and evaluates policy, roles, workflow
  definitions, and audit *metadata* (who, what tool, what decision, when) — not the underlying
  prompt/document content itself, unless a customer explicitly opts into content-level audit
  logging for compliance reasons.
- **Agent/execution plane (customer-deployable)**: the actual model calls, connector calls, and
  MCP tool calls happen either in our hosted environment (fast-start option, §8.5) or entirely
  inside the customer's own cloud/on-prem environment (BYOC) — with prompt/document *content*
  never required to leave the customer's boundary in BYOC mode.
- We publish a precise "what crosses the API" statement — policy/config intent, decision
  metadata, health/telemetry, never raw content in BYOC mode — as both a technical spec and a
  sellable trust artifact.
- This split is the same architectural pattern already implicit in §1–§7's policy-engine design;
  this subsection makes it explicit and public rather than leaving it as an internal assumption.

### 8.5 Deployment model: hosted fast-start with a zero-rework upgrade path to BYOC/air-gapped

| Mode | What it means | Who it's for |
|---|---|---|
| **Hosted fast-start** | We host the gateway and policy engine; no customer infrastructure to provision; a team can start governing AI usage in minutes | Pilots, teams without dedicated infra capacity, fastest time-to-value |
| **BYOC** | The gateway/policy-enforcement component deploys into the customer's own cloud account (AWS/Azure/GCP) or on-prem, under the customer's IAM | Enterprises with data-residency or sovereignty requirements that a hosted control plane can't satisfy |
| **Air-gapped/offline** | The policy-enforcement component operates from a locally cached policy state with no persistent outbound connection, buffering audit events locally and syncing when connectivity resumes | Defense/government/classified buyers, or any environment with no reliable outbound connectivity |

- **Zero-lock-in guarantee**: all policy/workflow definitions are stored as version-controllable,
  exportable config (policy-as-code, per §5) in the customer's own repos where possible; canceling
  the subscription should degrade gracefully to "last known policy," not "everything stops," for
  integrations that don't strictly require the live control plane.
- **No-rebuild upgrade path**: moving from hosted fast-start to BYOC requires no rebuild of
  existing policies, workflows, roles, or audit history — only a change in *where* the
  enforcement component executes.

### 8.6 How this composes with §1–§7 and §9–§10

- Every capability in §8.2–§8.5 is scoped to *our own* operated components (control plane,
  gateway, agent runtime) — it does not replace or duplicate §1–§7's AI-usage governance, which
  continues to govern *what any user/agent/connector/MCP call is allowed to do* regardless of
  which deployment mode (§8.5) is enforcing it.
- The compliance-classification cascade (§8.3) is the mechanism §9 (Shared Projects) and §10
  (cost dashboard) both plug into: a Shared Project's classification takes precedence over any
  single team's default (§9.3), and a project's classification can carry an associated
  cost-governance policy (§10.3).
- The Approvals Queue and audit log referenced throughout §8.2–§8.3 are the same single instances
  defined in §6 — critical drift, remediation actions, and reclassification diffs all post into
  the one inbox and one audit trail, not a separate infra-ops copy of either.

## 9. Shared Projects — Governed Cross-Team Context

### 9.1 Why this is needed

Context in a typical AI-native platform is scoped to a single project or a single workspace.
None of that squarely solves the case where **multiple distinct teams** need to collaborate on
one initiative while (a) reusing each other's context instead of re-explaining it, and (b)
keeping their own team-private material genuinely private. Shared Projects close that gap as a
first-class, governed object — not an informal convention of "just add everyone to one
workspace," which forfeits per-team access control.

### 9.2 What a Shared Project is

A **Shared Project** is a governed container — sitting at the same level as (or above) a regular
project/Initiative — that:

- Has its **own membership list spanning multiple teams**, not just one team's roster, with
  per-member roles (Owner/Contributor/Viewer) independent of each member's home-team role.
- Retains a **shared context store**: standing knowledge/instructions (coding standards,
  architecture decisions, domain glossaries, prior decisions and their rationale), reusable
  plans/requirements artifacts, and prior conversation/build history — visible to every member
  regardless of which team they belong to.
- Supports **provenance tracking**: every piece of shared context is tagged with which team/user
  contributed it and when, so downstream consumers can judge trust/relevance rather than treating
  shared context as anonymous ground truth.
- Supports **versioning and conflict resolution**: when two teams' updates to shared context
  disagree, the system surfaces the conflict for a named arbiter to resolve rather than silently
  overwriting. Every version is retained, so a resolved conflict can be traced back to what each
  side originally proposed.
- Allows **partial sharing**: a team can contribute a sub-scope of their own project's context
  into the Shared Project (opt-in, selective) without exposing their entire team-private
  workspace — read-only and permission-respecting by default, generalized to a cross-*team*
  boundary rather than just cross-project within one workspace.

### 9.3 Governance over shared context (composing with §2–§6)

- Access to a Shared Project's context is itself governed by the §2–§6 entitlement model: an
  admin can grant a specific user read-only vs. contribute access to a specific Shared Project,
  independent of their broader role.
- Any agent/model or MCP tool call made *within* a Shared Project still passes through the same
  per-user MCP/connector/agent rules from §2–§4 — shared context does not grant elevated tool
  access, only shared *information*. Membership in a Shared Project is never itself a grant of
  tool/connector/agent access; it only determines what *context* a member's already-permitted
  calls can see.
- A Shared Project can carry its own compliance classification (§8.3), which takes precedence
  over any single team's default classification for anything done inside the Shared Project. If
  member teams have conflicting classifications, the Shared Project's classification governs, and
  the conflict is surfaced to admins at the point the Shared Project is created or a member team
  is added.
- Every grant, contribution, and conflict-resolution decision on a Shared Project's context feeds
  the same audit log defined in §6 — there is exactly one audit trail in the product, not a
  separate one for shared context.

### 9.4 Suggested UI/UX

- A **Shared Projects** view distinct from "My Projects," listing cross-team initiatives, member
  teams, and a shared-context summary.
- A **context contribution log** — a running feed of what was added/changed in the shared context
  and by which team, so teams can stay in sync asynchronously rather than re-reading everything.
- A **"promote to shared" action** on any team-local artifact (a plan, a requirements doc, a
  skill) to opt it into the Shared Project's context with one action, with the provenance tag
  applied automatically.
- A **conflict inbox**, feeding the same Approvals-Queue-style pattern used elsewhere in the
  product (§6), for the named arbiter to resolve versioning conflicts (§9.2) without that surfacing
  as a separate, bespoke UI pattern.

### 9.5 How this composes with §8 and §10

- Section 8.3's compliance-classification cascade applies to Shared Projects exactly as it does
  to any other Initiative — classifying a Shared Project cascades the same workflow/MCP-scope/
  audit-retention/PII-mode controls across every member team's work inside it.
- Section 10's cost-per-project dashboard rolls up spend across all contributing teams on a
  Shared Project while still letting each team see its own contribution, supporting joint
  budgeting for cross-team initiatives (§10.3).

## 10. Cost-Per-Project Dashboard (Native FinOps for AI)

### 10.1 The market gap

Per-project, per-team AI spend attribution has emerged as its own product category ("FinOps for
AI") because general-purpose cloud cost tools stop at the instance/provider level — they can show
total spend on a model provider, but not which team or project actually generated it, since tags
applied at the infrastructure layer don't automatically propagate into token-level usage metrics.
Multi-tenant execution compounds this: one shared agent runtime serving many teams shows up as a
single line item unless usage is tagged *at the point of the call*, not reconstructed afterward.
A small, consistent set of tagging dimensions — *team*, *project*, *environment*, *model/agent
name*, and *cost center* — covers most real-world chargeback needs, applied consistently at the
point of every call. Visibility and enforcement are also different things: a dashboard that shows
spend after the fact doesn't stop a runaway agent loop from burning a budget overnight; only a
gateway that can evaluate and block *before* the provider call is made can enforce a budget in
real time. And finance needs budget-vs-actual and forecast, not just a raw usage total.

### 10.2 Our structural advantage

Because §2–§3's gateway already intercepts every single agent/model, connector, and MCP tool
call, the same interception point that enforces access policy is, for free, the exact point where
cost attribution should happen. Unlike a bolted-on FinOps tool that reconstructs attribution after
the fact from inconsistent tags, cost can be attributed **at the moment of the call**, natively,
with no separate instrumentation step.

### 10.3 Feature specification

- **Automatic, mandatory tagging at the point of every call**: every governed agent/model
  invocation, connector call, and MCP tool call is automatically tagged with project/Initiative,
  team, environment, initiating user, and the specific agent/model or tool used — enforced by the
  gateway, not left to optional developer instrumentation.
- **Per-project cost dashboard**: real-time spend broken down by project/Initiative/Shared
  Project (§9), with drill-down to team, user, agent/model, and connector/MCP-server level.
- **Budget vs. actual**: admins set a budget per project (monthly or per billing cycle); the
  dashboard shows spend against that budget with a clear over/under indicator, not just a raw
  total.
- **Forecast**: a projected end-of-period spend based on current trajectory and any
  already-scheduled changes (e.g., a newly granted agent with a higher per-call cost), so
  business teams can react before a budget is blown rather than after.
- **Alerts and optional enforcement**: configurable thresholds (e.g., "alert at 80% of budget,"
  "auto-throttle at 100%"), with enforcement implemented at the gateway (blocking or downgrading
  further calls once a hard cap is hit), not just a notification. Enforcement actions **reuse the
  §6 Approvals Queue** — e.g., "require approval for further spend" rather than a hard, silent
  cutoff, unless the admin explicitly configures a hard stop.
- **Anomaly detection**: flag unusual spend spikes (e.g., a runaway agent loop) with enough
  context to investigate quickly (which project, which agent, which time window, what changed).
- **Chargeback/showback modes**: support both a "showback" mode (visibility only, no actual
  internal billing) and a "chargeback" mode (spend is formally allocated back to a team/
  cost-center's budget).
- **Cost-center mapping**: allow a project's spend to map to one or more finance-defined cost
  centers, independent of the team/org structure used for access-control purposes.
- **Exportable and integrable**: raw attributed cost data available via API (JSON/CSV) so it can
  feed an enterprise's existing FinOps toolchain rather than requiring finance to adopt a second,
  isolated reporting surface.
- **A dedicated optimization-savings line**: the dashboard breaks out estimated cost avoided by
  the automatic token/cost optimization layer (model routing, edit-vs-rewrite routing, context
  compaction, deduplication, lazy tool-loading — per
  [TOKEN_OPTIMIZATION_SPEC.md §7](TOKEN_OPTIMIZATION_SPEC.md)) from raw spend, sourced from that
  spec's own per-user/per-agent dashboards rather than re-derived independently.
- **Composes with Shared Projects (§9)**: a Shared Project's dashboard rolls up spend across all
  contributing teams while still letting each team see its own contribution.
- **Composes with the compliance cascade (§8.3)**: a project's compliance classification can
  carry an associated cost-governance policy (e.g., regulated workloads may require stricter
  budget enforcement or a specific cost center) as part of the same single-tag cascade.

### 10.4 Recommended implementation approach

1. Treat cost attribution as a **mandatory side effect of the gateway's policy-evaluation step**
   (§3), not an optional add-on — every allow/deny decision should simultaneously emit a
   cost-attribution event with the five tagging dimensions (project, team, environment,
   model/agent, cost center) already attached.
2. Build the dashboard as a **native, first-class admin-portal surface** (alongside Users &
   Roles, Agent/Connector/MCP Governance from §6) rather than as an analytics bolt-on — this is
   explicitly one of the product's differentiators, so it should be prominent, not buried.
3. Support **provider-list-price-based estimated cost** at minimum (per-token/per-call pricing
   from each model provider, per-call pricing for connectors/MCP servers where applicable), with
   the option to reconcile against actual provider invoices for enterprises that need
   billing-grade accuracy.
4. Ship **export/API access from day one** so finance teams already using a broader FinOps tool
   can pull our attributed data into their existing rollups instead of us trying to replace those
   tools outright — our differentiation is *attribution accuracy at the point of the call*, not
   out-competing dedicated FinOps platforms on multi-cloud infrastructure cost management.

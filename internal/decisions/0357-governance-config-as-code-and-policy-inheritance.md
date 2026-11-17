# ADR-0357: Governance configuration as code, and tighten-only policy inheritance

- **Status**: Accepted
- **Date**: 2026-11-17
- **Index**: Governance config as code (export, plan, apply) and tighten-only policy inheritance

## Context

The 2026-11-17 competitor gap audit (the KrakenD gap 6 and the Credo parity checklist) found two gaps.

1. An organisation cannot keep its governance configuration in Git. Roles and their grants, rate limits, MCP bundles,
   workflow templates and project budgets can only be changed one at a time, through the admin UI or its API. There is
   no reviewed, versioned file to diff, no way to promote a change from staging to production as a pull request, and
   no record of the whole configuration at a point in time.
2. Policy has no hierarchy. A rule is set org-wide or on one object. There is no way to say "this business unit may
   only use these models", let a project narrow that further, and see which level set each rule.

Constraints from the rules that bind every build:

- **Secure by default (ADR-0180).** Applying a file must never be a quieter way to widen access than the UI. Every
  widening goes through the same `settings_relax` step-up the UI uses, bound to exactly what is widened.
- **Open source first (ADR-0176).** We reuse validated libraries for parsing, schemas, diffing and canonical hashing,
  and write our own code only for the governance semantics.
- **One org per deployment.** There is no `org_id` column. "The org's configuration" is the deployment's
  configuration.
- **Secrets never leave the database.** Connector, MCP upstream, model and discovery credentials live in their own
  encrypted tables.

### Open-source comparison (ADR-0176, owner rule of 2026-11-17)

| Approach | Licence, maintenance | What it gives | Fit |
|---|---|---|---|
| Terraform provider (plan/apply over a provider SDK) | `terraform-plugin-framework` MPL-2.0; Terraform core BSL-1.1 | A saved plan that apply is bound to; state file; drift detection | **Pattern adopted:** apply is bound to the plan hash the reviewer saw. Not embeddable: MPL/BSL, a Go binary, and its state file would be a second source of truth beside our database |
| `kubectl apply` / server-side apply | Apache-2.0, very active | Declarative documents with `apiVersion`/`kind`; a section is authoritative; `kubectl diff` before apply | **Pattern adopted:** an `apiVersion`/`kind` document, and every section present in the file is the full desired state of that section (prune within the section); absent sections are untouched |
| OPA bundles | Apache-2.0, very active | A signed tarball with a manifest `revision` and per-file digests | **Pattern adopted:** `metadata.revision` is the SHA-256 of the canonical document. Not adopted: Rego as the policy language (our policy semantics are already typed tables, ADR-0251) |
| Kong decK (`dump` / `diff` / `sync`) | Apache-2.0, active | The closest product match: dump a gateway's configuration to YAML, diff it against the live database, sync | **Pattern adopted** (dump = export, diff = plan, sync = apply). Not embeddable: Go, Kong's own entity model |

None of these can be embedded in a TypeScript gateway to govern our own entities, so the engine is our own code over
libraries we already ship, all pinned and listed in `THIRD_PARTY.md`: `js-yaml` 4.3.2 (MIT, parsing with
`CORE_SCHEMA`, no custom tags), `zod` 4.6.7 (MIT, the document schema, and `z.toJSONSchema` for the published JSON
Schema), `rfc6902` 5.3.0 (MIT, the diff, via `@regulait/shared` `jsonPatch`, ADR-0341) and ADR-0060's `canonicalJson`
for hashing. No new dependency.

## Decision

### 1. The document

A governance configuration is one document, YAML or JSON (the same content; YAML is the export default because it
reviews well in Git):

```yaml
apiVersion: regulait.io/governance/v1
kind: GovernanceConfig
metadata:
  revision: <sha256 of the canonical spec>   # computed on export; ignored and recomputed on plan
spec:
  roles: [...]              # name, description, tool/server/agent/connector grants
  rateLimits: [...]         # role-, team- and fleet-scoped MCP tool limits
  mcpBundles: [...]         # name, description, items (server + tool), role/team grants with max tier
  workflowTemplates: [...]  # name, definition, retired; contentHash on export
  budgets: [...]            # project, budgetUsd, period, alertThresholdPct, approverUserId
```

- **Validated by a strict schema.** `governanceConfigSchema` in `@regulait/shared` is the one definition; every
  object is `strict` (an unknown key is an error, never dropped), and its JSON Schema is served at
  `GET /v1/governance-config/schema` for editors and CI. The workflow definitions inside are validated by the
  workflow kernel's own schema at plan time, the same check a builder publish runs.
- **References by name, never by id,** so one file can move between a staging and a production deployment: servers,
  tools, agents, connectors, roles, teams, projects and templates are named; the plan resolves each name and reports
  any that does not exist. The only ids are user ids for approvers (a user's email would put personal data in Git).
- **Versioned.** `apiVersion` carries the format version. A file with an unknown `apiVersion` is refused, never
  guessed at. A future `v2` ships with a converter; `v1` stays readable.
- **What is not in it, deliberately:**
  - **Secrets.** Credentials are never exported. A section that needs one (none in `v1`) names a secret reference
    (`secretRef: {name}`), resolved on the deployment from its own encrypted store.
  - **Per-user state.** Direct user grants, revocations, role assignments and user-scoped rate limits are identity
    data owned by the IdP and SCIM paths (ADR-0038) and the per-user override layer. They are not organisation
    configuration and would put personal data in Git.
  - **Runtime state.** Spend, counters, approvals, overage latches and audit rows.

### 2. Export, plan, apply

| Route | What it does | Gate |
|---|---|---|
| `GET /v1/governance-config/schema` | The JSON Schema of the document | admin |
| `GET /v1/governance-config/export?format=yaml\|json` | The live configuration as a document, with `metadata.revision` | admin; audited |
| `POST /v1/governance-config/plan` | The dry run: parse, validate, resolve names, diff against live, classify each change, return the plan and its `planHash`. Writes nothing | admin; audited |
| `POST /v1/governance-config/apply` | Re-plans under the lock, refuses unless the `planHash` matches the one sent, then writes every change in one transaction | admin + `settings_relax` step-up; audited |

- **Apply always runs the dry run first.** Apply takes the document and the `planHash` the caller reviewed. It
  re-computes the plan inside the transaction, holding an advisory lock; if the live configuration moved since the
  plan, the hash differs and apply is refused with `409 CHANGED_CONCURRENTLY`. What is written is exactly what was
  reviewed (the Terraform saved-plan property).
- **All or nothing.** One transaction. Any refusal, unresolved reference, validation error or database error rolls
  back every change.
- **Step-up, always, on the relaxation path the UI uses.** Apply needs a `settings_relax` step-up bound to
  `{op: "governance_config_apply", planHash, widenings}`: the same kind the UI's grant mint (ADR-0250), revocation
  lift and settings relax use, bound to exactly the plan reviewed and the list of changes in it that widen (empty when
  none does). The plan marks every change `widens`, `narrows` or `neutral`, and the widenings are what the person
  approving sees. There is no apply flag that skips it. An API key, a bootstrap token or a bulk call can never pass a
  step-up, so none of them can apply. We do not add a step-up kind of its own: every kind is pinned in three CHECK
  constraints that a migration must rewrite whole, and two lanes rewriting them at once lose one another's kind with
  no merge conflict. A tightening-only apply still needs the step-up, because pruning and replacing are reviewed as
  one act.
- **Audited.** Export and plan write one audit row each. Apply writes one row for the apply (plan hash, revision,
  counts) and one row per changed object, in the transaction, so a rolled-back apply leaves only its refusal row.
- **Prune within a section.** A section present in the file is the full desired state of that section: an object
  missing from it is deleted (and that is classified). A section absent from the file is not touched. An empty list
  (`roles: []`) means "none", so pruning everything is explicit.

### 3. The classification table

What makes a change `widens` (needs `settings_relax`). Anything not listed as widening is `narrows` (removes access,
lowers a limit) or `neutral` (a description).

| Section | Widens | Narrows |
|---|---|---|
| roles | a new tool, server, agent or connector grant on a role; server `readOnlyAll` false → true (false confers nothing, and the plan refuses it as an inert grant); connector `read` → `readwrite`; agent modes or connector objects gained or set to unrestricted | a grant removed; a role removed; modes or objects reduced |
| rateLimits | a limit removed (changing its subject, server, tool, deploy mode or `writeOnly`, which select the calls it counts, is a removal plus a new limit); `maxCalls` raised; `windowSeconds` shortened | a limit added; `maxCalls` lowered; window lengthened |
| mcpBundles | an item added; a grant added; a grant's `maxTier` raised; a bundle un-archived | an item or grant removed; tier lowered; bundle archived |
| workflowTemplates | any definition change, a new template, a template un-retired (a stage removed can skip a sign-off; the plan cannot prove a definition change is stricter) | a template retired |
| budgets | a budget removed or raised; `alertThresholdPct` raised; period `none` → `monthly` (a monthly cap resets, so it allows more spend over time); the approver changed | a budget added or lowered; threshold lowered |

### 4. Policy inheritance: org → business unit → project → use case

- **The levels.** A new `business_units` table (name, unique) and `projects.business_unit_id` (nullable FK). A use
  case already belongs to a project (`ai_use_cases.project_id`). Each level may hold one policy layer
  (`governance_policy_layers`, one row per level and subject).
- **Tighten-only by default.** A child layer may narrow its parent's effective policy and never widen it. A write
  that would widen is refused (`400 POLICY_WIDENS_PARENT`) and names each rule. The refusal is the default; there is
  no relaxation for it in this ADR (owner question open: whether an audited exception should exist).
- **The merge table** is declared once in `@regulait/shared` (`POLICY_MERGE_TABLE`) and tested rule by rule:

| Rule kind | Example rules | Merge (parent ∘ child) | Unset means |
|---|---|---|---|
| allow-list | `allowedAgents`, `allowedConnectors`, `allowedMcpServers` | intersection | inherit the parent's list |
| deny-list | `deniedTools` | union | nothing more denied |
| ceiling | `maxBudgetUsd`, `maxCallsPerHour` | minimum | inherit |
| floor | `auditRetentionDays`, `minApprovers` | maximum | inherit |
| required flag | `requireHumanSignoff`, `requirePlanGate` | OR | inherit |
| ordered level, strictest wins | `maxDataSensitivity` (lower is stricter), `piiMode` (higher is stricter) | the stricter value | inherit |

- **The effective-policy view.** `GET /v1/governance-policy/effective?level=…&id=…` returns each rule's effective
  value and the level that set it (`setBy`), in a stable JSON shape agents can read as well as people.

## Consequences

- An org can keep its governance in Git, review a change as a diff, and promote it between deployments. The plan is
  the review artifact; apply cannot write anything other than what the plan showed.
- Applying a file is never a quieter path to wider access: every apply needs the same `settings_relax` step-up as
  the UI, bound to the plan and its widenings.
- Pruning within a present section is powerful. A file that omits a role deletes it. The plan lists every deletion,
  and the step-up is bound to that plan.
- Each section's writer in apply reuses the stores the UI writes (the role-grant tables, `rate_limits`, the
  append-only `mcp_bundle_versions`, `workflow_template_versions` with `origin`, the project budget columns). It
  does not add a parallel store.
- **Slicing.** Slice 1a: this ADR, the document schema, export and plan. Slice 1b: apply for roles, rate limits and
  budgets (no migration); a plan that also changes MCP bundles or workflow templates is refused whole
  (`422 section_not_appliable`) until slice 1c writes them through their own versioned stores
  (`mcp_bundle_versions`, `workflow_template_versions`).
- **What apply refuses that the UI decides.** A role deletion while the role is held (assignments are identity data,
  not in the file), and one that moves who approves calls (ADR-0229), are plan issues: the role's own screen asks for
  those decisions. A grant that breaks a separation-of-duties rule (ADR-0091) refuses the whole apply.
- **Rate limits are read as enforced.** Export and plan read a versioned limit as its active `config_versions` body
  over the row, and apply edits it through `applyRuleEdit` (a new version) and deletes it through
  `deleteRuleArtifact`, as the rule CRUD routes do. Those writers keep their own loosening guard; apply hands it a
  callback that accepts a loosening only where the plan marked that change as widening, so any gap between the two
  classifications refuses the apply instead of bypassing the step-up. Slice 2: business units, policy layers, the merge table and the effective view.
- **Follow-ups:** user-scoped and model rate limits, ABAC policies, approval rules and compliance profiles as further
  sections; a signed export (ADR-0310 bundles) for air-gapped promotion; the UI for plan review (#453).

# ADR-0233 — Refuse credentials typed into content columns (name, title, description, summary, body)

- **Status**: Proposed
- **Date**: 2026-11-06
- **Closes (when accepted)**: PENDING S6
- **Relates to**: [ADR-0102](0102-operator-prose-credential-scrub.md) (the prose scrub this deliberately does
  not extend), [ADR-0099](0099-audit-log-credential-scrub.md) (the detector and marker grammar),
  [ADR-0042](0042-guardrail-engine.md) (`CREDENTIAL_MATERIAL_RULES`), ADR-0186 V (the vendored open-source
  pipelock secret pack), [ADR-0060](0060-tamper-evident-audit.md) (the `createDb` chokepoint),
  [ADR-0112](0112-conversation-presentation-scrub.md) (conversations), [ADR-0180](0180-continuous-assurance-strict-by-default.md)
  (strict defaults), [ADR-0176](0176-open-source-first.md) (open source first)
- **Migration**: 0273 (`org_settings.content_credential_guard boolean NOT NULL DEFAULT true`). No data migration.

## Context

ADR-0102 scrubs credential shapes out of operator prose (`reason`, `note`, `rationale`, `explanation`) at the
`createDb` handle. Its safety case is that a sentence explaining a decision loses nothing when a key inside it
becomes `[redacted:aws_key:20:…]`. It stopped, on purpose, at content: a `name`, `title`, `description`,
`summary` or `body` is often the whole point of the record, and a person may need it byte for byte. PENDING S6
recorded the gap: a secret pasted into a template description or an agent name is stored exactly as typed.

S6 said "~34 columns". That count is two months stale. Asked of the schema today (the test below asks Postgres,
not the TypeScript), **151 text columns** match the S6 shape (`name`, `title`, `description`, `summary`, `body`,
or a `…_name` / `…_title` / … suffix). Seven more match by name but are `jsonb` and are discussed under limits.

So the question S6 left is not "should ADR-0102's redaction cover more columns". It is: **what should happen to
a credential typed into content**, given that silently changing content is a defect of its own?

## Decision

### 1. Refuse the write; never rewrite content

A write that puts credential-shaped text into a guarded content column is **refused**, before the statement
reaches Postgres, with:

```
422 { "error": "credential_in_content", "field": "description", "column": "compliance_pack_controls.description",
      "rules": ["aws_key"], "detail": "description looks like it contains a credential (aws_key); remove it and save again (ADR-0233)" }
```

- The refusal names the API field, the table column and the rule labels. It **never** carries the value.
- Nothing is redacted. The writer keeps their text and decides what the record should say. That is the
  difference from ADR-0102, and the reason for it: a redaction would store a record nobody wrote; a refusal
  stores nothing and costs one retry.
- Inside a transaction the refusal rolls the whole transaction back (a pack whose second control carries a key
  is not created at all; proved by test).

### 2. One detector, reused, not forked

The detector is ADR-0099's `scrubAuditText`, **by reference** (`CONTENT_GUARD_DETECTOR === scrubAuditText`,
asserted by test). A content value carries a credential exactly when that function would change it; the rule
labels come from the markers it would have added (`addedAuditScrubRules`, the same marker grammar).

Open source first (ADR-0176): the detector already includes the maintained open-source secret-pattern set this
repo vendors (the pipelock secrets pack, ADR-0186 V, Apache-2.0, pinned and air-gapped) beside ADR-0042's own
rules. Searched again for this ADR: gitleaks (MIT) and secretlint (MIT) publish rule sets of the same kind, but
gitleaks is a Go binary and secretlint's rules are per-package plugins with a runtime; adopting either would be
a second detector beside the one already vendored, which is exactly what ADR-0102 decision 3 forbids. **None
fits better than the pack already in use, because the requirement is one detector across the audit, prose and
content paths.**

### 3. Where it is sited

A third composed wrapper at the one place a handle is built:

```ts
return withContentGuard(withProseScrub(withAuditChain(drizzle(pool, { schema }))));
```

It intercepts the same three write shapes as ADR-0102 (`insert().values()`, `…onConflictDoUpdate({ set })`,
`update().set()`) for an explicit registry of tables and columns, and re-wraps `transaction()`. It is outermost
so it judges what the caller wrote. A route written next month that writes a registered column is covered
without its author knowing this file exists.

The common path costs one detector pass per registered string column and **no query**. Only when the detector
has matched does the guard read `org_settings.content_credential_guard` (through the caller's own handle, so
inside its transaction), then either refuse or let the statement run.

### 4. The admin relaxation

`org_settings.content_credential_guard` (default `true`). Turning it off:

- is a `PUT /v1/org/settings` write that the strictness registry
  (`org-setting-strictness.ts`, `contentCredentialGuard: notEqual(true)`) marks as a relaxation, so it needs the
  `settings_relax` step-up and is audited with `detail.relaxed: ["contentCredentialGuard"]`;
- stores credential-shaped content as typed while it is off;
- is offered in the admin console (Organization settings, "5f · Credentials in names and descriptions").

It is per install, which is per organisation in this product (one `org_settings` row). There is no per-column
or per-route switch: the false-positive answer is below, and a narrower knob would be one more place to get it
wrong.

### 5. False positives

The detector is the one already run on every audit row and every reason column, and its over-match behaviour
is pinned by ADR-0099 and ADR-0102 (uuids, emails, model names, `tokensIn 1200`, the words "token" and
"password" pass untouched; this ADR's test pins the same on content). When it does match something that is not
a secret, the writer sees which field and which rule, and has three ways forward, in order:

1. change the text (the usual case: the "example key" was not needed in the name);
2. ask an admin to relax the guard for the duration of the import or edit (audited, step-up), then turn it back
   on;
3. if a rule is wrong in general, fix the rule in ADR-0042 / the vendored pack, which fixes the audit, prose
   and content paths together.

There is deliberately no per-value allow-list: an allow-list of credential-shaped strings is a list of
credentials.

### 6. Import and export paths

- **Imports** (compliance-pack create and seed, framework imports, onboarding imports and every admin API
  create) all write through the same handle, so they are covered by construction.
  An import containing a credential is refused whole, naming the field; nothing partial is stored when the
  import runs in one transaction. Shipped seed content passes (`pnpm demo:prepare` runs green).
- **Ingested** columns (text read from an MCP server, a registry, an IdP, a cloud account, an SDK) are not
  guarded: refusing them would break the sync rather than stop a paste, and the operator did not type them. They
  are listed below and named as a residual.
- **Exports** read rows as stored. Rows written while the guard was off, or before this ADR, are exported as
  they are; the report below is how an admin finds them first.

### 7. Existing rows: report, never rewrite

`GET /v1/admin/content-credential-report` (admin-only) scans every guarded column in keyset pages and returns
`{ table, column, field, rowId, rules }` per match, at most `perColumnLimit` (default 50, max 500) per column,
with the columns it truncated listed. It **never returns the value** and **never edits a row**: rewriting
stored content is an edit to the record, and the owner of the record is the one who should change it. No data
migration.

## The inventory (generated from the schema)

The registry lives in `packages/db/src/content-guard.ts`. The block below is regenerated from it and pinned by
`zz-adr0233-content-guard.test.ts`, which also asks Postgres (`information_schema`) for every `text`/`varchar`
column matching the S6 shape and fails if any is neither guarded nor excluded, if any is both, or if any listed
column no longer exists. A column added by a hand-authored migration cannot slip past.

<!-- content-guard-inventory:start -->
Guarded (86): `a2a_agent_credentials.header_name`, `a2a_agents.name`, `abac_policies.description`, `abac_policies.name`, `agents.name`, `ai_risks.description`, `ai_risks.title`, `ai_use_cases.description`, `ai_use_cases.name`, `ai_vendors.description`, `ai_vendors.name`, `annotation_queues.description`, `annotation_queues.name`, `api_keys.name`, `approval_assignment_rules.name`, `approval_saved_views.name`, `approval_sla_policies.name`, `auditor_grants.auditor_name`, `automation_rules.name`, `builder_agent_schedules.name`, `builder_agent_subagents.description`, `builder_agent_subagents.name`, `builder_agents.description`, `builder_agents.name`, `builder_skills.body`, `builder_skills.description`, `builder_skills.name`, `chatops_connections.name`, `compliance_pack_controls.description`, `compliance_pack_controls.title`, `compliance_packs.description`, `compliance_packs.title`, `connectors.name`, `custom_model_providers.name`, `deploy_targets.name`, `discovery_sources.name`, `engine_runners.name`, `eval_datasets.name`, `execution_profiles.body`, `execution_profiles.name`, `executors.name`, `external_scorers.name`, `fairness_datasets.description`, `fairness_datasets.name`, `git_connections.name`, `grant_certification_campaigns.name`, `initiatives.name`, `kris.name`, `kris.score_name`, `mcp_registries.name`, `mcp_server_upstream_credentials.header_name`, `mcp_servers.name`, `model_drift_ingest_credentials.name`, `model_drift_monitors.name`, `model_signing_keys.name`, `monitoring_dashboards.name`, `oidc_providers.name`, `orchestration_runs.name`, `org_settings.tracing_otlp_service_name`, `pm_connections.name`, `policy_simulations.policy_name`, `processing_records.name`, `projects.name`, `prompts.description`, `prompts.name`, `rate_cards.description`, `rate_cards.name`, `redteam_libraries.name`, `report_definitions.description`, `report_definitions.name`, `roles.description`, `roles.name`, `saml_providers.name`, `scim_tokens.name`, `sod_rules.name`, `supplier_questionnaires.description`, `supplier_questionnaires.name`, `supplier_submissions.file_name`, `teams.name`, `training_datasets.name`, `training_jobs.name`, `trust_center_profile.display_name`, `trust_publications.title`, `virtual_keys.name`, `webhook_subscriptions.name`, `workflow_templates.name`.

- Excluded, prose_owned_by_adr0102 (4) — already scrubbed by ADR-0102's prose registry; one column, one owner: `ai_incident_actions.title`, `ai_incidents.summary`, `ai_incidents.title`, `ai_policy_documents.title`.
- Excluded, audit_owned_by_adr0099 (1) — audit_log is scrubbed by ADR-0099 before it is hashed: `audit_log.tool_name`.
- Excluded, tool_reference (14) — an identifier the upstream MCP server chose; refusing it would make that tool ungovernable (no grant, rule or revocation could name it): `approval_rules.tool_name`, `approvals.tool_name`, `config_canary_observations.tool_name`, `data_scope_rules.tool_name`, `grant_certification_items.tool_name`, `identity_tool_grants.tool_name`, `policy_simulation_flips.tool_name`, `rate_limits.tool_name`, `revocations.tool_name`, `role_tool_grants.tool_name`, `sod_rule_sides.tool_name`, `sod_rules.a_tool_name`, `sod_rules.b_tool_name`, `tool_grants.tool_name`.
- Excluded, platform_copy (13) — a copy the platform makes of a guarded or ingested column; the source is where the decision is made: `approvals.review_role_name`, `billing_statements.rate_card_name`, `builder_agent_skills.snapshot_name`, `engine_runs.workflow_check_name`, `eval_runs.agent_name`, `eval_runs.workflow_check_name`, `mcp_servers.registry_entry_name`, `mrm_retest_runs.source_name`, `policy_simulation_flips.project_name`, `redteam_runs.agent_name`, `redteam_runs.library_name`, `scheduler_runs.job_name`, `use_case_decision_records.intake_template_name`.
- Excluded, ingested (11) — text read from an external system (an MCP server, a registry, an IdP, a cloud account, an SDK); refusing it would break the sync, not stop the paste: `cert_inventory.common_name`, `imported_cost_lines.description`, `infra_resources.name`, `mcp_registry_entries.description`, `mcp_registry_entries.title`, `mcp_registry_entries.upstream_name`, `mcp_tools.description`, `mcp_tools.name`, `scim_groups.display_name`, `trace_scores.name`, `users.display_name`.
- Excluded, machine (16) — written by the platform from its own identifiers or generated text, never typed by an operator: `builder_tool_steps.display_name`, `builder_tool_steps.name`, `copilot_proposals.title`, `data_backfills.name`, `data_key_reencryption_failures.column_name`, `data_key_reencryption_failures.table_name`, `data_key_reencryption_progress.column_name`, `data_key_reencryption_progress.table_name`, `eval_judge_verdicts.judge_name`, `governance_alerts.title`, `remediation_proposals.title`, `scheduler_jobs.description`, `scheduler_jobs.name`, `trace_spans.name`, `traces.name`, `training_artifacts.name`.
- Excluded, conversation (3) — a conversation record, governed at the presentation boundary by ADR-0112: `builder_threads.title`, `conversations.summary`, `conversations.title`.
- Excluded, signed_evidence (4) — canonical bytes that are hashed and signed; derived from columns that are guarded or excluded above: `ai_bom_snapshots.body`, `decision_boms.body`, `model_artifact_signatures.resource_name`, `model_artifact_signatures.signed_name`.
- Excluded, check_constrained (1) — a DB CHECK limits it to a short lowercase identifier (at most 32 characters), which no credential rule matches: `prompt_tags.name`.
<!-- content-guard-inventory:end -->

## Consequences

- A credential typed into a template, agent, project, pack, role, connection or any other guarded content column
  is no longer stored; the person who typed it is told which field, and the value is never echoed.
- A false positive costs a retry or an audited relaxation, never silent damage to the record.
- The common write path gains one regex pass per registered column and no query.

## Honest limits

1. **jsonb is not guarded.** `config_versions.body`, `governance_review_policy_versions.body`,
   `cost_import_batches.summary`, `engine_runs.summary`, `mrm_retest_runs.summary`, `redteam_runs.class_summary`
   and `shadow_ai_imports.summary` match the S6 name but are `jsonb`. The first two hold governance
   configuration a person writes; guarding them means walking string leaves, and those bodies legitimately
   contain detection patterns that look like credentials. **Open question for the owner**: guard
   `config_versions.body` string leaves too, with the false-positive risk, or leave it to review?
2. **Ingested columns are not guarded** (the `ingested` list above). A credential an upstream MCP server puts in
   a tool description, or an IdP puts in a display name, is stored as received.
3. **Application-layer only**, like ADR-0060, ADR-0099 and ADR-0102: `psql` or an independent `pg.Pool`
   bypasses it.
4. **Shape-based**, so a shapeless secret (a random password with no prefix) is not caught.
5. **`prepare()`** cannot await the setting, so a prepared insert or update carrying a hit is refused even when
   the guard is relaxed (fail closed). No write path in this repo prepares an insert or update today.
6. **A non-transactional route** that writes an audit row or another table before the refused write keeps that
   earlier write. The guarded record itself is never stored.

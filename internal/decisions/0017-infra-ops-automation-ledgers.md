# ADR-0017 — Infra-ops automation ledgers (cert rotation, CVE patching, backup/restore)

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** user (in-session), Claude
- **Relates:** pillar 3 (GOVERNANCE_LAYER_SPEC §8.2 infra-ops); builds on ADR-0007/0008 (eight
  pillars), the detection spine (migration 0027: `infra_resources`/`infra_policies`/
  `infra_findings`, `MockInfraProvider`, the `infra_operation` approval path), and ADR-0015 (BYOC
  deploy modes + the control-plane / agent-execution-plane data boundary).

## Context

Migration 0027 shipped the governed infra-ops **detection** spine: monitored resources,
operational policies, inert findings, an auto-vs-gate decision on scan, and a single
approval-gated remediation path (objectType `infra_operation`) wired into the shared `/decide`
transaction. What it did NOT have was **automation depth**: a finding was a one-shot alert with no
durable domain record behind it. There was nowhere to see a certificate's rotation history, which
CVE on which resource is still open, or whether a backup actually ran. Pillar 3 explicitly calls
for "automated CVE patching / certificate rotation and backup policy" as first-class operations,
not just alerts.

The risk in adding this is proliferation: a naive design bolts on three new approval types, three
new audit object-types, and three parallel decision paths — fragmenting the ONE Approvals Queue
that is pillar 1's whole point.

## Decision

**Decision 1 — durable domain ledgers behind the one alert surface, one decision path.**
Four durable tables (migration 0034) hang off `infra_resources`: `cert_inventory` +
`cert_rotations`, `patch_records`, and `backup_runs`. On scan, after a finding is upserted, the
matching ledger row is upserted too (patch by `UNIQUE(resource_id, cve)`; cert by
`(resource, common_name)`; a `missed` backup run per finding) and the finding stamps a **FK-less
soft back-link** (`ref_table` / `ref_id`) to it. Findings stay the single inert alert surface;
the ledgers carry state and history.

Remediation still flows through the **ONE Approvals Queue**. Three operator verbs —
`cert_rotate`, `patch_apply`, `backup_restore` — each create an `infra_operation` approval whose
`stageId` carries an **action-tagged sentinel** `__infra_action__:<action>:<ledgerId>`, dispatched
inside the same `/decide` transaction by the same `applyInfraApprovalDecision` hook that already
handles `__infra_remediation__:`. On approve, the provider action runs and the ledger OUTCOME is
written in that same transaction (a `cert_rotations` row + advanced `not_after`/`last_rotated_at`/
`status='rotated'`; `patch_records.status='patched'`; a `kind='restore'` `backup_runs` row).
On deny, the proposed state reverts and the finding is logged as accepted risk. Both outcomes are
audited. **No new approvals or audit `object_type` value, no new decision path** — the sentinel is
the only extension, exactly as the per-node budget (ADR-0016) and context-conflict paths reuse it.

**Decision 2 — customer-hosted runtimes reuse the ADR-0015 BYOC boundary.**
A monitored resource MAY reference a `deploy_target` (`infra_resources.deploy_target_id`,
ON DELETE SET NULL). When that target's `mode='air_gapped'`, a remediation retains **metadata
only** in the control plane — no provider result string or URL crosses the boundary — the exact
rule the deploy/rollback executor already enforces (ADR-0015). Real cloud infra operations stay
dry-run behind the provider's `// REAL:` STS-assume-role markers (mirroring
`apps/gateway/src/deploy.ts`'s `AwsDeployProvider`); the `aws`/`azure`/`gcp` infra provider kinds
remain a hard 501 until a customer points a target at a live account with explicit sign-off. No
live cloud mutation ships in this change.

The pure detection math (`compareDrift`, `cvssToSeverity`, `certSeverity`,
`evaluateBackupSchedule`) is extracted into exported, unit-tested functions in
`@regulait/infra-provider` that the mock now calls, so the severity ladders are provable in
isolation and the mock is a thin deterministic shell.

## Consequences

- **Positive:** certificate/patch/backup operations become first-class governed records with
  history, not one-shot alerts; the entire feature adds exactly one sentinel prefix and zero new
  decision paths, keeping pillar 1's single Approvals Queue intact; the boundary and the
  no-live-mutation guarantees are inherited from ADR-0015 rather than reinvented; the detection
  math is now unit-tested at the boundary.
- **Negative / deferred:** the real AWS infra adapter (SSM patch, ACM rotate, AWS Backup restore)
  is still a 501; per-mode policy beyond the data boundary is out of scope; the backup ledger has
  no scheduler yet (a `missed` row is detection-driven, a `success` row is seed/manual);
  reverting a denied cert rotation resets to `active` rather than modelling a richer lifecycle.
- **Neutral:** ledger idempotency leans on the scan's finding upsert plus a per-kind natural key,
  so a re-scan never duplicates a ledger row.

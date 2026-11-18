# State machines: the inventory (ADR-0348)

Every lifecycle in the app, where it lives, how its transitions are enforced today, and what this lane does about
it. Audited on main at `753da597` (2026-11-17). Decision and options: [ADR-0348](../decisions/0348-declared-state-machines.md).

**How to read the scores.** F is how often the problem would happen (1–10), S how bad it would be (1–10). Under the
owner's rule (2026-11-17) F×S below 5 is a GitHub issue labelled `triage-low` and the code is left alone; 5 or more is
fixed, highest first. A machine in a file another lane's open PR is changing is a **follow-up**, not converted here.

**Words used below.** *Guarded*: the UPDATE re-checks the state it leaves from (`WHERE status IN (...)` and a
returned row), or the read-to-write runs under `SELECT ... FOR UPDATE`. *Check-then-write*: the code reads the row,
compares the status in JavaScript, then writes `WHERE id = $1`; a concurrent writer is overwritten.

## 1. How to add or change a machine

1. Declare it in `packages/shared/src/state-machines.ts` with `defineMachine` and register it in `STATE_MACHINES`.
   States equal the column's CHECK constraint; `apps/gateway/src/adr0348-state-machines.test.ts` holds the two equal.
2. Guard every writer: `.where(and(eq(t.id, id), whereFrom(t.status, MACHINE, "event"))).returning()`, and treat an
   empty result as "someone else moved it first" (report the state that stands, write nothing else, audit nothing).
   Where the next state is computed from the row, read and write under `.for("no key update")` in one transaction.
3. Replace JavaScript status checks with `MACHINE.can(row.status, "event")`.
4. Add `lifecycle: MACHINE.describe(row.status, blocked)` to the record's GET response; put permission or
   precondition refusals in `blocked` with a reason a person can act on.
5. Test that every previously valid path still works and that the race the old code had now fails loudly.

## 2. Already explicit (reuse the pattern; not changed)

| Machine | Where | Why it is fine |
|---|---|---|
| Workflow instance and stage (`workflow_instances.status`, stage statuses) | `packages/workflow-kernel/src/index.ts:633-1014`, persisted by `apps/gateway/src/workflows.ts` `applyEvent` | A typed reducer over about 17 events, persisted under `FOR UPDATE`; stage claims are leased. Deploy, post-deploy verify and rollback are states of this machine (`blocked_on_deploy`, `rolled_back`). |
| Orchestration run and node (`orchestration_runs.status`, node states) | `packages/orchestration-kernel/src/index.ts:289-462`, `apps/gateway/src/orchestration.ts:1826-1900` | `transitionRun` and `expectStatus`; terminal runs refused; persisted under `FOR UPDATE`, approvals superseded in the same transaction. |
| Engine runs (`engine_runs.status`, `phase`) | `packages/shared/src/engines/contract.ts:44-58`, `apps/gateway/src/engine-runs.ts` | `isTerminalEngineRunStatus`; every write locked; late envelopes become `timeout`. |
| Discovery runs (`discovery_runs.status`) | `apps/gateway/src/discovery-worker.ts:305-360, 811-840` | Lease-fenced SQL and a CHECK coupling status to finish time. The model for worker-owned rows. |
| Execution offers (`execution_offers.status`) | `apps/gateway/src/executor-channel.ts` | Every move under `lockedOffer`. |
| Approvals queue decide (`approvals.status`) | `apps/gateway/src/app.ts:5293`, `approval-signatures.ts:935/964`, `mcp-proxy.ts:527`, `model-call-consent.ts:424`, `eval-run-approvals.ts:73` | Every decide and consume is `WHERE status = 'pending'` (or `approved`) with a returned row. Child machines (remediation proposals, SoD overrides, the engine-run approval step) are serialised by the approval row. Exceptions are listed in §3. |
| Model card approvals, prompt promotions, federated link requests, governance alerts, data-subject requests, supplier invitations, certification campaigns, agent lifecycle, executors, workload identities, framework imports, kill switch, break-glass | `mrm.ts`, `prompt-registry.ts`, `auth.ts`, `governance-monitor.ts`, `privacy-ops.ts`, `supplier-portal.ts`, `grant-certification.ts`, `agents-connectors.ts`, `isolation-routes.ts`, `workload-identity-admin.ts`, `framework-imports.ts`, `execution-control.ts`, `break-glass.ts` | Guarded writes or `FOR UPDATE`. They will move onto declared tables as their files are next touched (DX, AX); no bug today. |

### Declared by their own lanes after the audit

| Machine | Declared in | Guarded writers | Notes |
|---|---|---|---|
| Rule-step suggestion (`rule_step_suggestions.status`, ADR-0327) | `RULE_STEP_SUGGESTION_MACHINE`, `packages/shared/src/state-machines.ts` | `transitionSuggestion` in `apps/gateway/src/rule-steps.ts` (`whereFrom`, returned row) | suggested ⇄ shadow; suggested → dismissed (final). The list answer carries `lifecycle`; shadow start is shown blocked while detection is off. Converted from a hand-written table in review of #903 (E12). |
| Endpoint add-on removal (`endpoint_addon_removals.status`, ADR-0331) | `ENDPOINT_ADDON_REMOVAL_MACHINE`, `packages/shared/src/state-machines.ts` | `endpoint-addon-removal.ts`: request, `applyEndpointAddonRemovalDecision` (decide path), cancel (`whereFrom`, row lock) | awaiting_approval → active \| denied \| stale \| cancelled; active → cancelled. Nothing is delivered until a second administrator approves (ADR-0186); the views carry `lifecycle`. Converted from a hand-written table in review of #871 (E13). |
| Endpoint add-on removal target (`endpoint_addon_removal_targets.status`, ADR-0331) | `ENDPOINT_ADDON_TARGET_MACHINE`, same file | delivery, outcome reports and cancel in `endpoint-addon-removal.ts` (`whereFrom`) | pending → delivered \| cancelled; delivered → removed \| nothing_to_remove \| failed. Cancel stops undelivered targets only, so a delivered directive's real outcome is still recorded. |

## 3. Machines to convert, ranked by F×S

| # | Machine | Where (main at 753da597) | States | Problem today | Trigger | F | S | F×S | Slice |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Incident (`ai_incidents.status`) PATCH | `incidents.ts:1539-1580`, close check `:454` | open, contained, resolved, closed | Any status to any other; the whole row is rebuilt from a stale read and written `WHERE id`, so two responders lose each other's edits and an edit racing a close changes a closed incident | user | 4 | 6 | 24 |**2, done** |
| 2 | MCP server admission (`mcp_servers.admission_state`) | `mcp-admission.ts:487-536` | grandfathered, unscanned, clean, held, cleared | The manifest scan read the state without a lock and wrote it back unconditionally: a scan racing an admin clear re-held the server and wiped the clearance; one racing an engine hold could write `clean` over `held` (fails open) | system (every tool sync, the ADR-0100 re-scan), admin | 3 | 7 | 21 | **1, done** |
| 3 | Orchestration budget overage gate (`orchestration_runs.budget`) | `orchestration.ts:2000-2012` | overage pending / approved | Approving an overage reads `budget` without a lock and writes the whole object back, wiping a concurrent `chargeRunBudget`; measured spend under-counts | approver vs worker | 3 | 7 | 21 |**2, done** |
| 4 | Training job (`training_jobs.status`) | `regulait-llm.ts:666, 783, 849-889, 968-993, 1818` | pending_approval, queued, running, succeeded, failed, cancelled, refused | No write checked the state it left: a job cancelled between its approval and the post-commit start still ran and billed; a poll could write `succeeded` over a cancel and record an artifact beside it | approver, system, worker, user | 3 | 6 | 18 | **1, done** |
| 5 | Eval run (`eval_runs.status`) | `evals.ts:1074, 1548`; blocks `redteam.ts:163` | running, completed, error, denied | Inserted `running`, completed by an unguarded update, `error` never written: a throw mid-run strands it in `running` forever, and its red-team library can then never be retired | user, system | 3 | 6 | 18 |**2, done** |
| 6 | Scheduler job lease (`scheduler_jobs.running`, `lease_owner`) | `scheduler.ts:395-442` | idle, running (leased) | `releaseJob` clears the lease `WHERE name = $1` with no owner fence: a pass that outlived its lease releases the new holder's lease, allowing a third overlapping run and corrupting `next_due_at` and the failure counters | worker | 2 | 7 | 14 |**2, done** |
| 7 | Incident containment | `incidents.ts:2055-2056` | open → contained | Checks `open` from a read before the transaction and sets `contained` unguarded, so it can reopen an incident resolved or closed meanwhile | user, agent (halt from an incident) | 2 | 6 | 12 |**2, done** |
| 8 | Shadow-AI finding (`shadow_ai_findings.status`) | `shadow-ai.ts:1554-1576, 1766` | open, confirmed, sanctioned, false_positive, remediated | Any state to any other with an unguarded write; `remediated` can go back to `open`, and a finding linked to a remediation workflow can be marked `false_positive` with the link left in place | user | 3 | 4 | 12 | 3 |
| 9 | Infra lifecycle (`infra_findings`, `cert_inventory`, `cert_rotations`, `patch_records`, `backup_runs` status) | `infra.ts:2010, 2081, 2133, 2167` (propose), `:484-821` (decide), `:906-1014` (auto-remediate) | open, remediation_proposed, remediated, accepted_risk, auto_remediated, ... | Propose checks state outside a transaction, so two proposals insert two approvals and approving the second re-runs a remediation; the scheduler's auto-remediate overwrites a state a human is deciding. No CHECK constraint on these columns | user, approver, scheduler | 2 | 6 | 12 | 3 |
| 10 | Incident close | `incidents.ts:2010` | → closed | Blockers and status checked outside the transaction, close unguarded: a corrective action added meanwhile slips past the "actions open" gate | user | 2 | 5 | 10 |**2, done** |
| 11 | AI use case (`ai_use_cases.status`) | `use-cases.ts:1019, 3356`; `review-policy.ts:397` | proposed, under_review, needs_info, approved, rejected, retired | `markUseCaseReturned`, retire and review re-open are check-then-write: `needs_info` or `under_review` can overwrite a concurrent retire or approval | approver, admin | 2 | 5 | 10 | 3 |
| 12 | Skill admission (`builder_skills.admission_state`) | `skill-admission.ts:374-392` | unscanned, clean, held, refused, admitted | The re-scan sweep guards on name and body, not on state or `admitted_digest`: an admit committed between its read and write is reverted to held (fails closed) | system vs admin | 2 | 4 | 8 | 3 |
| 13 | Red-team library (`redteam_libraries.status`) | `redteam.ts:215-310` | draft, published, retired | Publish is check-then-write: a publish racing a retire turns `retired` back into `published`, and a double publish orphans an eval dataset | admin | 1 | 7 | 7 | 3 |
| 14 | Approvals review re-open | `review-policy.ts:170-184` | pending → superseded | Supersedes pre-read ids `WHERE id IN (...)` with no status filter; a concurrent approve can be overwritten after its side effects ran | approver | 1 | 7 | 7 | 3 |
| 15 | Approvals: what "terminal" means | `project-archive.ts:58` vs `demo-enforce-lib.ts:91` | `returned` | One file treats `returned` as open, the other as terminal; no declared table says which | – | 2 | 3 | 6 | 3 (declare the approvals machine) |
| 16 | Billing period close (`billing_periods.status`) | `billing.ts:643` | open, closed | Two concurrent closes (cron and admin) both see `open` and both cut a statement | admin, scheduler | 1 | 5 | 5 | 3 |

## 4. Follow-ups: machines in files another lane is changing

| Machine | Where | Open PR touching it | Problem | F | S | F×S |
|---|---|---|---|---|---|---|
| Config version canary (`config_versions.status`) | `config-versions.ts:1514, 1521, 1573` | #894 (E21 versions) | The canary route reads versions outside a transaction and skips `lockRuleArtifact`; racing `activateVersion` can leave an artifact with no active version | 2 | 7 | 14 |
| PM inbound state (`pm_links.inbound_state`, `adopted_state`) | `pm.ts:1083, 1142, 1213` | #828 (L6 importer) | The link lookup ignores `orphaned_at`, so an `updated` after `deleted` still raises drift and can push a transition to a deleted item; no event-time ordering, so a late `updated` regresses the state | 3 | 5 | 15 |
| Workflow terminal statuses copied by hand | `workflows.ts:447, 614, 3105`, `plan-only.ts:263`, `governed-evaluate.ts:224`, `projects.ts:646`, `abac.ts:96`, `project-archive.ts:60`, `shadow-ai-remediation.ts:41` | #885, #891, #894 (E21, on the kernel and `workflows.ts`) | Eight copies of "completed, aborted, denied, rolled_back"; the kernel lets `completed` be re-opened, the copies do not say so. Export one `TERMINAL_INSTANCE_STATUSES` from the kernel and replace the copies once E21 lands | 2 | 3 | 6 |

## 5. Filed as `triage-low` (F×S < 5, code left alone)

| Issue | Problem | F | S | F×S |
|---|---|---|---|---|
| #912 | Spend anomaly decide: acknowledge and dismiss can both win (`spend-monitor.ts:979`) | 2 | 2 | 4 |
| #913 | Workbench escalation and claim audit rows written when the approval did not move (`workbench.ts:211, 832`) | 2 | 2 | 4 |
| #914 | Signed-quorum recheck audits a supersede that did not happen (`approval-signatures.ts:1245`) | 1 | 2 | 2 |
| #915 | Eval baseline pin: two writes outside a transaction can leave two baselines (`evals.ts:2819-2837`) | 1 | 4 | 4 |
| #916 | SIEM destination recover is check-then-write (`siem-delivery.ts:580`) | 1 | 3 | 3 |
| #917 | Builder tool step finish and refusal write by id only (`builder-runtime.ts:1240, 1360`) | 1 | 3 | 3 |
| #918 | PM outbound mirror has no ordering between passes (`pm.ts:213-262`); builder thread status last-writer-wins (F 2, S 2) | 1 | 3 | 3 |

Residual, not built: an eval run whose process dies mid-run (a restart, not a throw) still stays `running`. A reaper
belongs on the scheduler, whose job registry (`scheduler-jobs.ts`) six open PRs are changing; F 1, S 6, F×S 6. It is a
follow-up for when those land (PENDING fragment `2026-11-17-e29-state-machines-pending.md`).

Not filed: the orchestration `/auto` "planned" check (`orchestration.ts:2692`) is check-then-act, but the kernel
refuses the loser with a 409, which is the correct outcome.

## 6. UI state (apps/web): for the design builders (#453)

Server lifecycles reach the UI through the `lifecycle` view (ADR-0348 §4); the web app imports no transition rules.
Reads already use TanStack Query (about 207 files) and the kit's `Skeleton`, `EmptyState`, `ErrorState` and
`RecordError`; writes use `useAction` / `useApiAction` in `views/admin/adminKit.tsx`. No state-machine library is
needed for these. What the design lane should pick up, screen by screen:

- **Screens that re-derive server transitions from status strings** (about 30 to 40 files). Switch each to the
  `lifecycle` field as its machine is converted: `views/admin/governance/RisksPage.tsx:244, 259, 294` (computes
  `open → mitigating` itself), `views/incidents/IncidentDetailPage.tsx:385-387, 547`,
  `views/admin/governance/CampaignsPage.tsx:320, 347, 414, 451`, `views/trust/TrustPublishingPage.tsx:238, 572, 584`,
  `views/runs/RunDetailPage.tsx:346, 381-392`, `views/workflows/WorkflowDetailPage.tsx:101-263`. The training job
  screen and the MCP admission screen can use `lifecycle` now.
- **Screens whose flags can contradict each other** (one discriminated union per screen would remove the
  contradiction): `IntakeWizardPage.tsx:161-183` (about 13 setters; a restored draft can land on review with a stale
  proposal), `IntakeResubmit.tsx:166-191` (`done` and `error` together), `DecisionRegressionPage.tsx:217-223` (a
  hand-written query with two error channels), `auth/LoginPage.tsx:120-135` (the MFA/SSO phase implied by three
  fields), `BomEvidencePanel.tsx:171-175, 306-311, 409-411`, `SupplyChainPanel.tsx:51-59, 199-204`,
  `ModelArtifactsTab.tsx:241-244, 365-370`, `approvals/ReviewPanel.tsx:188-197` (three error stores),
  `identity/WorkloadIdentitiesPage.tsx:144-207` (five "which dialog is open" fields), `account/AccountPage.tsx:207-418`.
- **Kit gaps:** `useAction` has no single-flight guard (only about 7 files use `useSingleFlight`), shows an inline
  error and a toast for the same failure, and `useSettleAfterWrite` has no callers.

## 7. Columns that are not lifecycles

Config modes (`*_mode`, `deploy_mode`, `pii_mode`) never change after insert; free-text state (`oidc_login_states.state`,
`saml_login_states.relay_state`, `sso_reauth_requests.state`, `builder_tool_steps.outcome_code`) is not a lifecycle.
Users, sessions and invites have no status column (timestamps such as `disabled_at` and `revoked_at`); deploy targets
have none (deploys live in the workflow machine). Single-owner worker rows (audit anchors, scheduler runs, traces,
cost reconciliation, data-key re-encryption, MRM re-test runs) are written by one owner at a time and need no guard.

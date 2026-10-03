# RegulAIt — Configurable Workflow Engine Spec (P0 Pillar 2)

> Source: original specification authored for RegulAIt during bootstrap planning (2026-07-21),
> synthesized from gaps identified across Atlas, Cursor, and Lovable (see
> [VISION.md](VISION.md)) — this is **original spec, not a description of an existing product
> feature**. Co-equal in priority with
> [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md) — that spec governs *who can do what*;
> this one governs *what sequence of steps and sign-offs any given change must pass through*
> before it ships. Together they are the two enforcement layers every AI-driven action in the
> product must pass through.

## 1. Why this matters (synthesis and gap)

None of the three researched products offers this as a general, admin-configurable capability:
- **Lovable** has the closest primitive — Plan mode produces an editable, approvable plan
  (`.lovable/plan.md`) before Build mode executes — but there is no formal *requirements
  document* distinct from the plan, no *multi-party sign-off*, no native *PR-creation-with-
  merge-approval* gate, and no *conditional auto-deploy*. Its GitHub/GitLab sync is a one-way
  code-backup/collaboration mechanism, not a governed release pipeline.
- **Cursor** has strong git-native building blocks (PR creation, Bugbot automated review, GitHub
  Actions/CI integration, checkpoints) but no built-in *requirements sign-off gate* preceding
  build, and no first-class, admin-defined "this change must go through these N stages" engine.
- **Atlas** has staged environments (sandbox/staging/production) with CI/CD and a build-status
  lifecycle (Building → Ready), and gates writes behind human approval — but its "workflow" is
  essentially fixed per project type, not admin-composed and per-tool/system/code-type assigned.

**The gap**: none of the three lets an admin define an arbitrary, ordered sequence of
planning/sign-off/build/review/approval/deploy stages as a reusable template, then automatically
route a given change through one or more matching templates based on what is being changed.
That capability is this spec's requirement.

## 2. Reference workflow (canonical default template: "Standard Change Workflow")

| # | Stage | Type | Behavior |
|---|---|---|---|
| 1 | **Intake** | Trigger | User submits a request (chat message, ticket, or API call) describing the desired change. |
| 2 | **Auto-enter Plan mode** | Planning | Forced planning-only reasoning first — no code/state mutation possible in this stage. |
| 3 | **Generate requirements file** | Artifact generation | The agent produces a structured, versioned requirements document (goals, scope, affected components/data, acceptance criteria, risks/assumptions, out-of-scope items) — a distinct, more formal artifact than a conversational plan, stored alongside the project (e.g. `requirements/<change-id>.md`). |
| 4 | **User sign-off** | Human approval | The requesting user (and optionally additional named approvers) must explicitly approve the requirements file before anything proceeds. Editable pre-approval; edits after approval require re-approval (versioned sign-off, not a one-time checkbox). |
| 5 | **Send for build** | Human trigger | Once signed off, the user explicitly triggers the build phase — sign-off does not auto-trigger build, keeping "decide" and "execute" as separate user actions. |
| 6 | **Build execution** | Automated build | The agent implements the change, scoped strictly to the signed-off requirements file — any material deviation from scope should re-trigger stage 3/4 rather than silently expanding scope. |
| 7 | **Create PR** | Git operation | The system creates a branch and opens a PR in the connected git provider (GitHub, GitLab, Bitbucket, or Azure DevOps), description auto-linked to the requirements file and the build's diff/summary. |
| 8 | **Automated checks** | CI / review / scan | CI tests, automated code-review (Bugbot-style logic-bug detection), and security scanning (Basic/Deep scan) run against the PR automatically. **Absent results (2026-10-03, AER-047; [ADR-0167 amendment](../decisions/0167-security-review-batch.md)):** a named check with no reported result (and no eval outcome) is `pending`, never passed — the instance waits at `awaiting_execution` on this stage with a `workflow:checks-awaiting-report` audit row naming the missing checks, and the next `POST .../checks` re-evaluates it; a reported failure blocks at once. A template may opt a check stage back into passing unreported checks only through the typed stage field `offlineAutoPass: true`, honoured only when the gateway process declares `REGULAIT_OFFLINE_CHECKS=1` and shows no deployed signal (`REGULAIT_DEPLOY_MODE` / `REGULAIT_HSTS`) — otherwise refused, audited with the reason, and the checks stay pending. Every result passed that way is labelled ("auto-passed — no report (offline mode)"; a badge on the workflow rail, a warning in the merge-approval view) and audited `workflow:checks-auto-passed`. When a resubmitted artifact re-opens the flow, earlier check results for this stage are discarded, so a re-run needs fresh reports. Eval-bound checks (ADR-0044) are never auto-passed; one with no outcome fails. There is no wall-clock timeout: a missing report stays pending. |
| 9 | **Merge approval** | Human approval | A designated approver (distinct from the stage-4 requirements approver — can be the same person, but roles are independently configurable) must review and approve the PR before merge. Reuses the Approvals Queue and audit log from the governance layer, not a separate approval mechanism. |
| 10 | **Merge** | Git operation | On approval, merged using the workflow's configured merge strategy (merge/squash/rebase). |
| 11 | **Conditional deploy** | Deployment | If the initiating workflow/user has a valid, governed connection to the target deployment platform (checked against governance-layer connector rules), deploys automatically. If no authorized connection exists, stops at "merged, ready to deploy" and hands off to a manual step with notification, rather than failing the whole pipeline. |
| 12 | **Post-deploy verification** | Automated check | Smoke tests/health checks run against the deployed change; failures can auto-trigger rollback and notify stakeholders. |

## 3. Generalized requirement: a configurable Workflow Engine, not just one workflow

The above is **one template**. The platform must let admins build, save, and assign **any
number** of workflow templates, composed from a shared library of reusable stage types:

- **Trigger** — how a workflow instance starts (chat request, ticket, scheduled job, webhook, API call).
- **Planning** — forced planning-only reasoning stage (no mutation).
- **Artifact generation** — produces a structured document (requirements file, design doc, migration plan, rollback plan).
- **Human sign-off / approval** — named approver(s), single or multi-approver (all-must-approve / any-one-approves).
- **Design/Architecture sign-off** *(optional variant of the above, added 2026-07-24)* — a dedicated human-approval stage, distinct from Requirements sign-off, optionally fed by multiple specialist-agent outputs (e.g. an Architect Agent and an Integration Agent each proposing a design) that a named review-board group must approve before Build starts. Offered as an available stage type for a richer template (e.g. a "Standard Change Workflow + Design Review" variant) for changes where architectural risk warrants a dedicated gate, sitting between Artifact-generation/Requirements-sign-off and Build — it does not replace or modify the simpler default Standard Change Workflow in §2, which keeps a single combined Requirements-sign-off stage.
- **Automated build/execution** — the agent implements a scoped change.
- **Git operation** — branch, commit, PR/MR creation, merge, tag.
- **Automated check** — CI/tests, automated code review, security scan, dependency audit, PII scan.
- **Merge/release gate** — human-approval stage tied to a git merge or release/deploy action.
- **Deployment** — conditional, governance-checked deploy to a named target environment.
- **Rollback** — automated or human-triggered reversion, invocable from any later stage.
- **Notification / webhook** — alert stakeholders or trigger an external system at any point.
- **Conditional branch** — route to different subsequent stages based on outcome (e.g. "if security scan finds a critical issue, route to a remediation sub-workflow instead of merge approval").

**Workflow definition**: expressed as a declarative, version-controllable spec (YAML/JSON), not
only a drag-and-drop builder UI — consistent with the policy-as-code principle in the governance
spec. Example:

```yaml
workflow: standard-change-workflow
stages:
  - id: intake
    type: trigger
  - id: plan
    type: planning
  - id: requirements
    type: artifact_generation
    output: requirements_file
  - id: requirements_signoff
    type: human_approval
    approvers: [requesting_user]
    blocks: build
  - id: build
    type: automated_build
    scope: requirements_file   # build is scope-locked to the signed-off artifact
  - id: create_pr
    type: git_operation
    action: open_pr
  - id: automated_checks
    type: automated_check
    checks: [ci_tests, code_review, security_scan]
  - id: merge_approval
    type: human_approval
    approvers: [designated_reviewer_role]
    blocks: merge
  - id: merge
    type: git_operation
    action: merge
    strategy: squash
  - id: deploy
    type: deployment
    condition: governed_connector_available(target_env)
    on_false: manual_handoff
  - id: post_deploy_check
    type: automated_check
    checks: [smoke_test]
    on_failure: rollback
```

## 4. Workflow assignment: which workflow(s) apply, automatically

Admins define **assignment rules** determining which workflow template(s) apply to a given
change, without the requester choosing:

| Assignment condition | Example | Effect |
|---|---|---|
| **Target system/tool** | Changes to an SAP ABAP object, a production database schema, or an identity-provider config | Route to a stricter workflow (mandatory dual sign-off, mandatory Deep security scan, no auto-deploy) |
| **Repository/path pattern** | Any change under `/infra/`, `/auth/`, or `*.sql` migration files | Insert an additional review/approval stage not present in the default workflow |
| **Code/change type** | Frontend copy change vs. backend logic change vs. database migration vs. infrastructure-as-code | Apply a lighter-weight workflow vs. a heavier one |
| **Data sensitivity / risk classification** | Change touches a system flagged as handling PII | Force the Sensitive-Data workflow, adding a compliance sign-off stage |
| **Initiating user's role/entitlement** | A contractor or a user without a given certification | Force an extra approval stage a full-time employee's identical change would skip |
| **Target environment** | Staging vs. production | Production requires merge approval + conditional deploy gate; staging may auto-deploy without a merge-approval stage |

**Composability**: more than one workflow may apply simultaneously (e.g. a production-database
change is both a "database migration" and touches a "PII-flagged system"). The engine must
**union/merge the applicable templates' required stages** — taking the strictest applicable rule
at each overlapping stage — rather than requiring a bespoke template per combination.

## 5. Cross-cutting requirements

- **Workflow instance dashboard**: a live view of every in-flight workflow run — current stage,
  blocking approvals, elapsed time per stage, full history.
- **Reuses governance, doesn't duplicate it**: every human-approval stage posts into the same
  Approvals Queue and audit log defined in the governance spec — exactly one approvals inbox and
  one audit trail in the product.
- **Git-provider abstraction**: PR/merge stages must work across GitHub, GitLab, Bitbucket, and
  Azure DevOps, with per-workflow configuration of branch naming, PR template, merge strategy.
- **Deployment-stage conditionality**: the deploy stage introspects whether the initiating
  user/workflow has an authorized, governed connection to the target deployment platform; if
  not, stops at "ready to deploy" and hands off to a manual step with notification.
- **Abort/rollback semantics**: any workflow instance can be aborted or rolled back from any
  stage, with the audit trail capturing who acted, why, and system state at the time.
- **Scope-lock between sign-off and build**: the build stage is constrained to what was actually
  signed off; material scope drift during build should re-open the sign-off stage rather than
  ship unreviewed scope changes.

## 6. Meta-note: RegulAIt should eventually dogfood this

Once this workflow engine exists as a product feature, RegulAIt's *own* development should
route through it (Intake → Plan → Build → PR → checks → merge approval → deploy). Until then,
per [CLAUDE.md](../../CLAUDE.md), the working Claude Code session manually plays the role of
"Plan gate + sign-off" itself.

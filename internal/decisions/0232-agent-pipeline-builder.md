# ADR-0232: An agent pipeline builder: drag-and-drop, governed pipelines with SAP CPI-style features for AI agents

- **Status**: Proposed (design session, 2026-11-06; owner request of the same day)
- **Date**: 2026-11-06
- **Related**: ADR-0172 and ADR-0173 (the agent builder suite), ADR-0219 (governed A2A calls), ADR-0016 (transitive
  per-node budget ceiling), ADR-0064 and ADR-0181 (scheduler), ADR-0070 (traces), ADR-0104 and ADR-0105 (approval payload
  and context binding), ADR-0129 (single-attempt tools), ADR-0176 (open source first), ADR-0180 (secure by default),
  ADR-0196 (UI enterprise harness), ADR-0200 (engineering guidelines and security checklist), ADR-0204 (MCP upstream
  static credentials), ADR-0226 (list contract)

## Owner request (verbatim, 2026-11-06)

> "We need to have a agent pipeline builder. That allows us to configure a pipeline using a drag and drop. Something like
> what SAP CPI allows us to do. (Basically I want it to have all the features that sap CPI has but for building AI
> agents)"

**Owner placement decision:** it goes inside the existing **Agent builder** suite (`apps/web/src/shell/suites.tsx`) as
**/builder/pipelines**, with **Pipeline packages** (the CPI "packages") and **Pipeline runs** (the CPI "message monitor").
**Agent usage** stays the last entry.

## Context

SAP Cloud Integration (CPI, part of SAP Integration Suite) lets an integration developer group flows into packages and
draw each flow on a canvas: sender adapters and timers start it; steps modify, map, route, split and call; receiver
adapters deliver it. Each flow is versioned, its parameters are externalised, and it is deployed to a runtime. Every
message gets a processing log, an optional payload trace and retries. Security material, the keystore, roles and
transport sit around the flows.

RegulAIt already has most of the runtime pieces an AI-agent version needs, each behind the per-user governance gateway
(pillar 1):
- builder agents (ADR-0172/0173);
- model bindings and the agent registry;
- governed MCP tool calls, governed connector calls and governed A2A remote agents (ADR-0219);
- guardrails, the approvals queue, budgets and per-call cost attribution (pillar 5), and the token optimiser (pillar 6);
- the chained audit log and traces (ADR-0070);
- the pillar-7 task DAG with transitive entitlement and budget ceilings (`packages/orchestration-kernel`);
- the pillar-2 workflow engine (`packages/workflow-kernel`);
- the in-process, multi-replica-safe scheduler (`apps/gateway/src/scheduler.ts`);
- credentials and virtual keys.

What it lacks is a way to **compose** these pieces into a reusable, versioned, deployable flow on a canvas, and to
monitor each run of that flow.

Two existing models are close but are not this feature:
- **Pillar 2 workflow templates** govern the *change lifecycle*: intake, plan, sign-off, build, PR, merge, deploy. They
  are stage machines for one change, not a data path that runs many times.
- **The pillar 7 task DAG** is planned per run by a lead agent. It has no conditions, loops, triggers, data mapping,
  versions or deployment. It is the right executor for an "agent team" inside a pipeline, but not the authoring model.

## Decision

### 1. A pipeline is a versioned, declarative artifact that the canvas edits

- **The JSON document is the source of truth, not the canvas.** The canonical form is JSON. YAML is accepted and offered
  for authoring and export. Both parse to the same object, which the new pure package `packages/pipeline-kernel` (zod 4,
  as `orchestration-kernel` and `workflow-kernel` already pin it) validates. The same zod schema is published as JSON Schema (`z.toJSONSchema`), so that
  external tooling and `ajv` (already in the gateway) can validate a file without our code.
- **Shape** (`apiVersion: regulait.io/pipeline/v1`):
  - `kind: Pipeline`;
  - `metadata`: name, package, description and owning project;
  - `parameters`: externalised parameters, with type, default and `secretRef` allowed only as a reference;
  - `triggers`;
  - `steps`: id, type, config, `onError` and `approval`;
  - `edges`: from, to and an optional condition label;
  - `limits`: run budget, maximum steps executed, wall-clock deadline and maximum parallelism.
  - The canvas positions live in a separate `layout` block that is **excluded from the content hash**, so dragging a
    node never creates a semantic version.
- **Content hash.** Every saved version is canonicalised (sorted keys, `layout` stripped) and hashed (SHA-256). The hash
  is what a deployment approval binds, in the same way as the approval payload digest (ADR-0104). An approved deployment
  can only ever run the exact bytes that were approved.
- **Borrowed concepts, not a borrowed format.** The step vocabulary borrows the concepts of the CNCF Serverless Workflow
  1.0 DSL (task types, switch, fork, try/retry, listen) so that an exporter can be added later. We do not adopt that
  format or its SDK (see §11).
- **Relationship to pillar 2.** A pipeline does not replace a workflow template. A later slice adds a workflow stage
  type, `pipeline`, that runs a *deployed* pipeline version as one stage. The workflow engine keeps owning sign-off and
  merge; the pipeline owns the data path inside the stage. Changes to a pipeline definition can themselves be routed
  through a workflow template (change type `pipeline`) once the deployment approval in §6 is in place.
- **Relationship to pillar 7.** The pipeline kernel reuses `computeNodeCeiling` and `computeNodeBudgetCeiling` from
  `orchestration-kernel` for every step, so a step's entitlement and budget ceilings compose exactly as a DAG node's do.
  An **Agent team** step embeds a pillar 7 run: the existing lead/worker runner plans and executes it, inside the step's
  own ceiling.

### 2. The step catalogue

Each step is executed by the gateway through an **existing governed primitive**. The pipeline engine never calls a model,
a tool, a connector or a URL itself.

| Group | Step | Built on |
|---|---|---|
| Triggers | Manual run, Schedule, Inbound webhook, PM-tool event, Called by a workflow stage, Called by another pipeline | Run API; `scheduler.ts` (interval-based today) plus **croner** (a new dependency) for cron expressions; the ADR-0173 inbound channel pattern (HMAC plus replay window); pillar 8 inbound sync; pillar 2 |
| AI | Agent | Builder agent through the governed invoke path (`compat-core.ts`), optimiser applied |
| AI | Model call | Model binding through the governed invoke path, with an output JSON Schema |
| AI | Remote agent | `executeGovernedA2aCall` (ADR-0219) |
| AI | Agent team | The pillar 7 orchestration runner (`orchestration.ts`) |
| Calls | Tool | `executeGovernedToolCall` (MCP, single attempt, ADR-0129) |
| Calls | Connector | `connector-call.ts` (egress guard, credentials, PII) |
| Control | Router (conditions plus default), Parallel (fork), Join, For each (splitter), Gather, Loop (bounded), Sub-pipeline, Wait/timer | Pipeline kernel |
| Control | Error handler (per step and per pipeline), End, Fail, Escalate | Pipeline kernel; Escalate goes to the approvals queue |
| Governance | Approval (human in the loop), Guardrail check, Budget checkpoint | Approvals queue; guardrail engine (ADR-0042); budget gate (`preDispatchProjectGate`) |
| Data | Set (variables), Map (declarative field mapping), Transform (expression), Validate (JSON Schema), Convert (JSON, YAML, CSV, text, Base64), Filter, Lookup (value table) | Pipeline kernel; the expression language is chosen in slice 7 (§11) |
| Data | Data store (write, get, select, delete with a TTL) | New `pipeline_data_store` table |
| Advanced (off by default) | Code (sandboxed), Aggregator (correlate across runs) | `sandbox-executor` (gVisor backend only); data store |

### 3. The execution engine

- **Interpreter.** Our own interpreter, in the new pure `pipeline-kernel`, in the same style as the four existing kernels (policy, optimiser, workflow and
  orchestration):
  - `validate(definition)`;
  - `plan(version)`, which compiles the step graph and checks the limits;
  - `transition(state, event) -> { state, effects }`, with no I/O.
- **Effects.** The gateway (`apps/gateway/src/pipelines/`) carries out each effect by calling the governed primitive for
  the step, as the run's actor, and feeds the result back in as an event.
- **Durable dispatch: the step row is the queue.** Pending step attempts are rows in `pipeline_run_steps`, claimed by a
  lease (`FOR UPDATE SKIP LOCKED`, with a lease expiry from `now()`). This is the pattern `engine-runs.ts` and
  `scheduler.ts` already use, and it is multi-replica safe. Retry with backoff, a deadline per attempt and
  dead-lettering (`failed` after the last attempt, visible in the monitor) are columns on that row, not a second store.
  - **pg-boss is not adopted**, for the reasons `apps/gateway/src/engine-runs.ts` already recorded when it rejected
    pg-boss and graphile-worker (ADR-0176 check): the queue here *is* the governed evidence record (each attempt carries
    its decision, approval, usage and trace references), and a job library would keep a second copy of each run's
    state. Those reasons apply to pipelines unchanged. The one difference from engine runs (the consumer is the
    gateway itself, not an external container on an HTTP lease) does not change them. This is the narrow exception
    allowed by ADR-0176 item 4 (multi-replica state under our migration discipline), and it reuses existing code rather
    than adding any.
- **Retries never repeat a write.** A step that wrote, or that was approved, is never retried automatically: MCP tools
  are single attempt (ADR-0129), and an approval binds one payload. Automatic retry applies only to steps the catalogue
  marks idempotent (reads, model calls, validation). A manual retry re-runs governance from the start.
- **Idempotency.** Every run has an idempotency key (the trigger's delivery id, or one supplied by the caller), and every
  step has `runId:stepId:attempt`. The CPI idempotent process call maps to an `idempotencyKey` on a step, recorded in the
  data store.

### 4. Governance composition (pillars 1, 5, 6 and 7)

- **Every step goes through the per-user governance gateway (pillar 1).** There is no pipeline-only path.
  - **Run as.** A manual run runs as the person who starts it. A triggered run (schedule, webhook, PM event) runs as the
    deployment's **named human run-as owner**. Their entitlements, revocations, kill switch, literacy gate and ABAC
    policies are re-evaluated at **every** step, not once at the start. A revocation mid-run fails the next step with a
    refusal.
  - **A pipeline never exceeds the initiating user's entitlements (pillar 7).** Each step carries the delegation actor of
    the run. Step ceilings compose with `computeNodeCeiling`, so a pipeline, sub-pipeline or agent team can only narrow
    what that person holds.
  - **No confused deputy: the ceiling is the intersection of requester and run-as owner.** For a deployed version, each
    step's effective ceiling is the **intersection** of the run actor's entitlements and those of the person who
    requested the deployment. Both are re-evaluated at every step, so revoking either one stops the step.
    - Requesting a deployment is refused if the requester lacks any agent, tool, connector, remote agent or model
      binding that the version references.
    - The run-as owner's acceptance task and the deployment approval both show the **per-step entitlement diff**: which
      steps the requester holds, which the run-as owner holds, and the effective intersection. An approver reviews
      entitlements, not only a graph.
    - A manual run of a deployed version by an operator uses the intersection of the operator and the requester.
  - **Sub-pipelines and called pipelines run as the caller.** A Sub-pipeline step, or a pipeline started by "Called by
    another pipeline" or by a workflow stage, runs as the **caller's actor**, inside the caller's step ceiling narrowed
    by `computeNodeCeiling`. It never takes on the callee deployment's run-as owner, so a low-privilege pipeline cannot
    reach a higher-privilege one's grants. Slices 4 and 6 pin this with a test.
  - **Pipeline relaxations never override gateway rules.** A deployment that sets a step to `approval: none` removes only
    the pipeline's own approve-first gate. Any matching pillar-1 approval rule still pauses the call, chosen by the
    ADR-0229 precedence. Slice 3 pins this with a test that a relaxed step still pauses when a gateway rule matches.
- **The run budget is a hard ceiling (pillars 5 and 7).**
  - `limits.budgetUsd` is required, with an org default and an org maximum.
  - Per-step `budgetCapUsd` composes as a minimum, as in ADR-0016.
  - The project budget gate still runs before every dispatch.
- **Cost is attributed per step (pillar 5).** Every dispatch writes its `usage_events` row with the project plus new
  nullable `pipeline_run_id` and `pipeline_step_id` columns. The spend dashboard can then show cost per pipeline, per
  version and per step, and run detail shows the cost of each step.
- **The token optimiser applies (pillar 6).** Agent and model steps go through the same invoke path, so routing,
  compaction, the semantic cache and lazy tool loading apply, and the savings are reported against the same rows. The
  pipeline also passes the step's declared output schema and its upstream payload size to the optimiser as hints.
- **Audit.** A run writes `pipeline.run.started`, a `pipeline.step.*` event per step and `pipeline.run.finished` to the
  chained audit log. Each governed call writes its own decision row, as today, carrying the run and step ids.

### 5. Persistence and migrations

New tables (migration numbers are reserved by the master session at build time, per CONTRIBUTING §4):
- `pipeline_packages`: org, project, name, description, owner.
- `pipelines`: package, name, current draft, created by.
- `pipeline_versions`: immutable. Pipeline, semver, canonical JSON, content hash, layout, created by, notes.
- `pipeline_deployments`: pipeline, version, environment label, parameter values (`secretRef`s only), run-as owner,
  status (`requested`, `approved`, `active`, `undeployed`, `failed`), approval id.
- `pipeline_runs`: deployment or draft test, trigger, actor, idempotency key, status, cost, timestamps from `now()`.
- `pipeline_run_steps`: append-only. Run, step, attempt, status, governed call reference (decision id, usage id, trace
  span), redacted input and output digest, error.
- `pipeline_payloads`: optional trace payloads, encrypted with the data key, with a TTL.
- `pipeline_data_store`: per project and pipeline, key, value, TTL.
- `pipeline_variables`: scope `run`, `pipeline` or `project`; there is no org scope.

**Project isolation.** Data store entries and variables belong to one project. RLS policies on these tables key on
project membership, not only on org. Sharing across projects happens only through a Shared Project (pillar 4), under its
membership and the pillar 3 data-scope defaults.

**Database rules:**
- Every tenant table gets Postgres row-level security.
- Append-only tables refuse `UPDATE`, `DELETE` and `TRUNCATE`.
- Retention follows the compliance-classification cascade (pillar 3).
- Lists are indexed for the run monitor's real queries: org, pipeline, status and started-at, in keyset order.

### 6. Drafts, versions and deployment (secure by default, ADR-0180)

- **New pipelines start as drafts.** A new pipeline is a **draft**. Saving overwrites the draft. "Save as version"
  freezes an immutable version with the next semver.
- **Test runs.** A draft can only be **test-run**, by its author, as the author, with manual trigger only, and the run is
  labelled `test` everywhere. From slice 3 (when tool, connector and remote-agent steps arrive), every write-class
  step in a test run is approve-first, whatever the deployment setting. In slice 1, the only step is an Agent step,
  whose own tool writes are governed only by the existing gateway approval rules, exactly as a builder agent's are today.
- **No self-approval of a test run's writes.** A test-run write that pauses goes to the approvals queue, whose pool
  already excludes the caller and anyone delegation-linked to them (`approval-pool.ts`, ADR-0186 A). Slice 3 pins this
  with a test that the author cannot approve their own test-run write.
- **Deployment needs approval.** Deploying a version creates an approval in the approvals queue (new action
  `pipeline_deploy`). The approval binds the content hash, the parameter digest, the environment and the run-as owner.
  The requester can never approve their own deployment. The default quorum is 1 from the role holding
  `pipeline_deploy_approve`. Admins may raise the quorum, which is a tightening. Lowering it to none is a relaxation:
  step-up, audited.
- **Undeploy and roll back.** Undeploy is immediate and audited. Redeploying an earlier version is a new deployment and
  needs a new approval.
- **The run-as owner must agree.** The run-as owner has to accept the role explicitly (an Inbox task). A deployment
  cannot run as someone who has not agreed.

### 7. Monitoring (the CPI message monitor)

**Pipeline runs** is the monitor. It is a `DataList` (ADR-0226) filtered by package, pipeline, version, status, trigger,
actor and time. Run statuses map to CPI's (CI/message-status):
- `queued` maps to PROCESSING before dispatch;
- `running`;
- `waiting_approval`;
- `retrying` maps to RETRY;
- `escalated` maps to ESCALATED;
- `completed`, `failed`, `cancelled` and `discarded` (duplicate idempotency key) map to the CPI statuses of the same
  names.

**Run detail** shows:
- the canvas with a status overlay on each step;
- a step timeline;
- each step's governed decision, with a link to the approval or refusal;
- cost and tokens saved per step;
- a link to the ADR-0070 trace.

**Log levels** are per deployment:
- `info`, the default: no payloads, digests only.
- `trace`: payloads are stored encrypted in `pipeline_payloads`. Switching it on needs step-up, ends automatically after
  at most 60 minutes, and the payloads expire after 24 hours. The CPI default (CI/tracing) keeps trace data for 60
  minutes; ours is an org setting with a strict default.
- **Reading a payload** needs the dedicated `pipeline_payload_read` permission, passes an object-level check against the
  run's project, and writes an audit row on every read. Payloads hold full data below the redaction layer.

### 8. Security model (ADR-0180 and the ADR-0200 checklist)

- **Secure defaults.** New pipelines are drafts. Deployment needs approval. Write-class steps (tool and connector steps
  the registry marks as writes, plus every remote-agent step) default to `approval: required`. Relaxing a step to
  `none` is a per-deployment admin decision, made under step-up and audited. The feature itself is off for an org until
  an admin enables `pipelines_enabled`, also under step-up and audited.
- **Trigger data is untrusted.** Webhook and PM-event payloads are labelled untrusted wherever they flow: in step
  inputs, in the prompt envelope of Agent and Model steps, and in the approval view of any write they lead to. This is
  a prompt-injection path, and approve-first writes are the mitigation. A webhook trigger's HMAC secret is a `secretRef`
  to a stored credential, never part of the definition. It is rotatable with an overlap window, and each rotation is
  audited.
- **No new egress.** The catalogue has **no raw HTTP step**. Outbound calls only go through registered connectors, MCP
  servers or A2A agents, which already use the guarded fetch and egress guard (SSRF).
- **No secrets in the definition.**
  - Parameters can only hold `secretRef` ids that resolve to existing credentials or virtual keys at dispatch time,
    server side.
  - The schema refuses known secret shapes in any string (the existing secret scanner patterns). An export never
    contains secrets.
- **Bounded definitions.** The schema is strict (unknown keys refused) and bounded:
  - at most 200 steps and 400 edges;
  - loops at most 100 iterations;
  - fan-out at most 50;
  - nesting depth at most 5;
  - a definition at most 512 kB.
  - Conditions use the sandboxed expression language. Regexes go through re2js (no ReDoS), and caller-supplied regexes
    are refused (M-rule on input validation).
- **Checklist items this feature touches:**
  - SQL injection: Drizzle and parameterised queries only.
  - XSS: labels and payloads are rendered as text, and the CSP is unchanged.
  - CSRF: the header on every mutation.
  - File upload: the import bundle is size-checked, schema-validated and signature-checked.
  - Object-level authorisation: on every read and write, by project membership and pipeline role.
  - Rate limiting: on run start and webhook triggers.
  - Webhook signatures: HMAC with a replay window.
  - API secrets: server side only.
  - Permissions: enforced server side.
  - Row-level security: on every new table.
  - Sensitive data in logs: digests only below `trace`.
  - Dependencies: croner pinned and listed in `THIRD_PARTY.md`.
- **Roles.** New permissions, bundled into the role builder:
  - `pipeline_read`, roughly CPI's Read Only;
  - `pipeline_edit`, the Integration Developer;
  - `pipeline_operate` (run, retry, cancel), the Business Expert;
  - `pipeline_deploy_approve`;
  - `pipeline_admin` (log level, relaxations), the Administrator;
  - `pipeline_payload_read` (read trace payloads, audited per read).

  None is granted by default. The built-in developer persona gets read and edit only.

### 9. UI layout (per DESIGN_GUIDELINES)

- **Routes:**
  - `/builder/pipelines`: list of pipelines;
  - `/builder/pipelines/edit/:id`: the editor (a distinct segment, so it never collides with `packages` or `runs`);
  - `/builder/pipelines/packages`: packages;
  - `/builder/pipelines/runs`: the monitor;
  - `/builder/pipelines/runs/:runId`: run detail.
- **Editor at 1024 px and wider.** A `PageHeader` with breadcrumb, and one primary action, **Save draft**. Secondary
  actions: Validate, Run test, Save as version, Request deployment. Below it, three panes:
  - **Palette** (left, collapsible, searchable). The step catalogue is grouped as in §2. A step can be added by drag or
    by keyboard (Enter adds it after the selected step).
  - **Canvas** (centre). `@xyflow/react` with `@dagrejs/dagre` auto-layout, both already pinned. Custom step nodes with
    a text status, never colour alone.
  - **Property sheet** (right). A form for the selected step, generated from the step's zod schema. Inline validation on
    blur. Advanced settings sit behind a disclosure. The sheet becomes a `DetailDrawer` at 900 px and below.
- **Run overlay.** After a run test, or from run detail, step nodes show their status, duration and cost. Failed steps
  link to the `RefusalNotice` or the error.
- **Accessibility.**
  - An **Outline** view lists the same steps and edges as an ordered, editable list. It is the screen-reader and phone
    path, and it covers every action the canvas offers.
  - Nodes are focusable and can be moved with the arrow keys.
  - Every action is reachable without hover. WCAG 2.2 AA is checked by `a11y-routes.ent.spec.ts`.
- **Phone.** At 390 px the editor opens in Outline view, with the canvas read-only.
- **Bundle.** The editor is a lazy, section-level chunk that shares the `RunGraphCanvas` vendor split. A separate
  `.size-limit.json` ceiling for the editor chunk is proposed in slice 1's PR and recorded as an ADR-0196 exception
  there. The entry bundle does not grow.

### 10. Navigation change in `suites.tsx`

`BUILDER` gains three entries before "Agent usage", which stays last. Labels stay unique across suites:

```ts
  { label: "Pipelines", to: "/builder/pipelines" },
  { label: "Pipeline packages", to: "/builder/pipelines/packages" },
  { label: "Pipeline runs", to: "/builder/pipelines/runs" },
  { label: "Agent usage", to: "/builder/usage" },
```

The rail's longest-prefix match must mark "Pipeline packages" and "Pipeline runs" current, not "Pipelines". The slice 1
spec pins this.

### 11. Open source first (ADR-0176): what we looked for

Checked on 2026-11-06 against npm and project sites. "From knowledge" means the licence was not re-verified this session.

| Candidate | Licence / last release | Verdict |
|---|---|---|
| `@xyflow/react` 12.12.x | MIT, 2026-11-04 (repo pins 12.12.0) | **Use** for the canvas. Already shipped in `RunGraphCanvas.tsx`, works offline, custom nodes and handles. Its Pro examples are optional and not used |
| `@dagrejs/dagre` 3.1.x | MIT, 2026-10-24 (repo pins 3.1.1) | **Use** for left-to-right auto-layout. Already shipped |
| elkjs | EPL-2.0 or GPL-3.0 | **Reject**: licence |
| bpmn-js | MIT plus a clause that the bpmn.io watermark must stay visible | **Reject**: not plain MIT, and it forces third-party branding into our UI |
| bpmn-moddle / bpmn-engine | MIT | **Reject**: BPMN is too heavy for agent pipelines; bpmn-engine keeps state in memory or blobs, so all governance and persistence would still be ours |
| CNCF Serverless Workflow 1.0 + `@serverlessworkflow/sdk` 1.0.1 | Apache-2.0, 2026-06 | **Borrow concepts, do not adopt.** No governance, approval, budget or entitlement primitives, and a slow SDK cadence. Our schema stays close enough to export later |
| Amazon States Language validators | Apache-2.0 / MIT | **Reject**: AWS-specific (against the provider-agnostic principle), and there is no maintained embeddable executor |
| Temporal | MIT (SDK verified; server from knowledge) | **Reject**: a separate server cluster with its own history store, duplicating our audit and governance state; heavy for BYOC and air-gapped |
| Restate, Inngest, Windmill, n8n, Camunda 8 | BSL, SSPL (verified), AGPL, Sustainable Use, Camunda License | **Reject**: licence |
| Trigger.dev, Hatchet, Kestra, Conductor, Airflow | Apache-2.0 / MIT | **Reject**: each is a second stateful platform (Redis, ClickHouse, the JVM or Python) outside our Postgres and outside the governance interception point |
| Node-RED | Apache-2.0, 2026-10 | **Reject**: a whole runtime with flow files on disk and single-process state, and no per-user governance hook. Used only as UX reference |
| LangGraph.js, Mastra | MIT; Apache-2.0 (Mastra "ee" subtree unverified) | **Reject as backbone**: they run beside the gateway, not behind it, and would bypass pillars 1, 5 and 6 unless every node were wrapped |
| XState v5 | MIT | **Not now**: a pure interpreter equivalent to our kernels, with no persistence or distribution. Revisit if the kernel's transition code grows |
| DBOS Transact (TS) | MIT, 2026-11-04 | **Reject for now**: the only library-only, Postgres-native durable-step engine, but its checkpoint tables are a second copy of run state, the same objection as pg-boss. Revisit only if the lease queue proves insufficient |
| pg-boss 12.x | MIT, 2026-11-05 | **Reject**, as `engine-runs.ts` already did: the step row is the governed evidence record, and a job library would hold a second copy of run state (§3). The existing `FOR UPDATE SKIP LOCKED` lease is reused |
| graphile-worker | MIT, 2026-09 | **Reject**, for the same reason as pg-boss (also recorded in `engine-runs.ts`) |
| BullMQ | MIT | **Reject**: needs Redis |
| croner | MIT | **Use** for cron triggers (no runtime downloads) |
| Expression language for Map/Transform/conditions | to be chosen in slice 7 | Candidates must be MIT/Apache, sandboxed (no code execution) and maintained. JSONata is the first to check, and its release cadence must be verified then. If none fits, we fall back to a restricted path-and-operator grammar evaluated by the kernel |

**Conclusion: no full workflow engine fits.** Every server engine either has an excluded licence or is a second
stateful platform outside the governance interception point. The agent-graph libraries sit beside the gateway rather
than behind it. We write only the genuinely RegulAIt part: pipeline semantics, governance composition, evidence and UI.
The canvas, layout, cron and validation are open source; the queue reuses our existing, already-justified lease
pattern.

### 12. Build plan: one reviewable PR per slice, each with tests

1. **Thinnest end-to-end path.** Create, draw, save, run one agent step, see the run.
   - `pipeline-kernel` with Manual trigger, Agent and End steps, plus validation and hash.
   - Tables `pipeline_packages`, `pipelines`, `pipeline_versions`, `pipeline_runs`, `pipeline_run_steps`.
   - `POST/GET /v1/pipelines`, `PUT /v1/pipelines/:id/draft`, `POST /v1/pipelines/:id/test-runs`,
     `GET /v1/pipeline-runs/:id`.
   - The editor with a palette (Agent only), canvas, property sheet and run overlay. The three nav entries; packages and
     runs as simple lists.
   - `pipelines_enabled` off by default. Test run as the author through the governed invoke path, with
     `pipeline_run_id`/`pipeline_step_id` on usage rows.
   - Tests: kernel unit tests; gateway integration (allow, deny shown as a refusal on the step, budget stop, object-level
     authorisation, RLS); a Playwright mock spec; axe; the nav current-item pin and a route pin that `packages`,
     `runs` and `edit/:id` each resolve to their own page.
2. **Packages, versions and deployment.** Save as version, the deployment approval binding hash, parameters, run-as
   owner and its acceptance, undeploy, externalised parameters with `secretRef`, manual runs of a deployed version.
3. **Calls and governance steps.** Tool, Connector, Remote agent and Model call steps; approve-first writes; the Approval,
   Guardrail and Budget checkpoint steps.
4. **Control flow.** Router, Parallel/Join, For each/Gather, bounded Loop, Sub-pipeline, Error handler, Fail/Escalate,
   with ceilings from `orchestration-kernel`.
5. **Durable execution.** The step-row lease queue (shared helper with `engine-runs.ts` where practical), automatic
   retry with backoff for idempotent steps only, dead-letter, resume after a crash, cancel, idempotency keys, the
   `discarded` status.
6. **Triggers.** Schedule (croner plus `scheduler.ts`), inbound webhook (HMAC plus replay), PM-tool event; the run-as
   model re-evaluated per step.
7. **Data steps.** Set, Map, Transform, Validate, Convert, Filter, Lookup; the expression-language decision; data store
   and variables with retention.
8. **Monitor.** Full Pipeline runs `DataList`, run detail, log levels with step-up trace, manual retry, cost per step in
   Spend & savings.
9. **Simulation.** A dry run that mocks tool and connector responses and previews every step's policy decision through
   the existing evaluate and simulation path, with no dispatch and no spend.
10. **Content lifecycle.** Signed export and import bundles (import lands as a draft), an offline template catalogue,
    the OpenAPI and `api-client` update.
11. **Composition.** Agent team step (pillar 7) and workflow stage type `pipeline` (pillar 2).
12. **Advanced, off by default.** Code step in `sandbox-executor` (gVisor), Aggregator.

## CPI feature parity map

**Legend:**
- **Mapped**: an equivalent with the same intent.
- **Adapted**: an equivalent whose semantics change for AI agents or for governance.
- **N/A**: not built, with the reason.

**Sources:** `CI/` stands for `https://help.sap.com/docs/cloud-integration/sap-cloud-integration/`. Pages were rendered
and read on 2026-11-06; "(excerpt)" means the text came from SAP page text in a search result rather than a separate
fetch. **Unverified** marks a CPI claim no SAP page confirmed.

### Design

| # | CPI capability | Source | Agent-pipeline equivalent | RegulAIt primitive | Status |
|---|---|---|---|---|---|
| 1 | Integration packages | CI/creating-integration-package | Pipeline packages | New `pipeline_packages`; project (pillar 4) | Mapped |
| 2 | iFlow designer (graphical editor) | CI/what-is-sap-cloud-integration. **Unverified:** that it is BPMN-based | Canvas plus Outline view editing the JSON definition | `@xyflow/react`, `pipeline-kernel` | Mapped |
| 3 | Sender adapters (HTTPS, SOAP, OData, IDoc, SFTP, Mail, JMS, AMQP, Kafka, ProcessDirect …) | CI/connectivity-adapters | Triggers: manual, schedule, inbound webhook, PM-tool event, workflow stage, another pipeline. Protocol-specific inbound comes through connectors, not pipeline adapters | Run API, scheduler, ADR-0173 inbound channels, pillar 8 | Adapted |
| 4 | Receiver adapters | CI/connectivity-adapters | Tool, Connector, Remote agent, Model call and Agent steps. Protocols live in MCP servers and connectors | Governed MCP, connector, A2A (ADR-0219) and invoke paths | Adapted |
| 5 | Adapter SDK (custom adapters) | CI/connectivity-adapters | Register an MCP server or connector, then use it as a step | MCP server registry, connectors | Adapted |
| 6 | Start and end events | CI/define-exception-subprocess | Trigger and End steps | `pipeline-kernel` | Mapped |
| 7 | Timer start event | CI/define-timer-start-event | Schedule trigger (cron) | `scheduler.ts` plus croner (new) | Mapped |
| 8 | Error end and escalation events | CI/define-exception-subprocess, CI/define-escalation-event | Fail and Escalate steps; Escalate opens an approvals-queue item | Approvals queue | Mapped |
| 9 | Content modifier (headers, properties, body) | CI/define-content-modifier | Set step (run variables, step input) | `pipeline-kernel` | Mapped |
| 10 | Script step (Groovy/JavaScript) | integration-suite/define-local-script-step | Transform step (sandboxed expression); Code step in a gVisor sandbox, off by default | `sandbox-executor` | Adapted |
| 11 | Converters (JSON↔XML, CSV↔XML) | CI/define-json-to-xml-converter (others excerpt) | Convert step: JSON, YAML, CSV, text, Base64. XML is added only if an owner use case needs it | `pipeline-kernel` | Adapted |
| 12 | Message mapping (graphical) | integration-suite/message-mapping | Map step (declarative field mapping between JSON Schemas), or a Model call with an output schema for fuzzy mapping | `pipeline-kernel`, model bindings | Adapted |
| 13 | Operation mapping, XSLT mapping, ID mapping | CI/operation-mapping; XSLT and ID mapping (excerpt) | None for XSLT or operation mapping: agent payloads are JSON, and service-interface operations are an SAP PI construct. ID mapping is covered by Lookup | — | N/A |
| 14 | Router | CI/define-router | Router step (conditions plus a default) | `pipeline-kernel` | Mapped |
| 15 | Multicast (parallel or sequential) | CI/define-multicast | Parallel step (fork), with sequential as an option | `pipeline-kernel`, step lease queue | Mapped |
| 16 | Splitters (general, iterating, IDoc, EDI, Zip, PKCS#7) | CI/define-splitter | For each step over an array (bounded). IDoc, EDI and PKCS#7 splitting is N/A (not agent payloads) | `pipeline-kernel` | Adapted |
| 17 | Gather and Join | CI/define-gather-and-join | Gather (merge results) and Join | `pipeline-kernel` | Mapped |
| 18 | Aggregator (correlate across messages) | CI/define-aggregator | Aggregator step correlating across runs through the data store, off by default | `pipeline_data_store` | Adapted |
| 19 | Request-reply | CI/define-request-reply | Every call step is request-reply | Governed call paths | Mapped |
| 20 | Process call / local integration process | CI/define-process-call | Sub-pipeline step (version pinned) | `pipeline-kernel` | Mapped |
| 21 | Looping process call | CI/define-looping-process-call | Loop step with a condition and a maximum (≤ 100) | `pipeline-kernel` | Mapped |
| 22 | Exception subprocess | CI/define-exception-subprocess | Error handler per step and per pipeline | `pipeline-kernel` | Mapped |
| 23 | Idempotent process call | CI/define-idempotent-process-call (excerpt) | Step `idempotencyKey`; run idempotency key; `discarded` status | `pipeline_data_store`, ADR-0104 binding | Mapped |
| 24 | Data store operations (write, get, select, delete) | CI/define-data-store-operations | Data store step with a TTL | `pipeline_data_store`, RLS | Mapped |
| 25 | Variables (local and global) | CI/define-write-variables | Variables scoped to run, pipeline or project (CPI's tenant-wide global scope is narrowed to the project) | `pipeline_variables`, RLS by project | Adapted |
| 26 | JMS queues (asynchronous decoupling) | CI/apply-retry-pattern-with-jms-queue, CI/managing-queues | A durable step queue inside the engine. No user-defined broker queues; asynchronous hand-off between pipelines uses "Called by another pipeline" | Step-row lease queue | Adapted |
| 27 | Persist step and message store | CI/persist-messages, CI/message-stores | Per-step records; trace payloads (encrypted, with a TTL) | `pipeline_run_steps`, `pipeline_payloads` | Mapped |
| 28 | XML validator (EDI validator) | CI/validating-message-payload-against-xml-schema | Validate step (JSON Schema) | ajv / zod | Adapted |
| 29 | Encoder and decoder (Base64, MIME, Zip) | integration-suite/define-encoder | Base64 within Convert. MIME and Zip are N/A until a use case needs them | `pipeline-kernel` | Adapted |
| 30 | Filter | CI/define-filter | Filter step | `pipeline-kernel` | Mapped |
| 31 | Write to log | **Unverified** (closest is a script adding MPL properties, CI/add-information-to-message-processing-log) | Every step is logged; a Set step can add run attributes shown in run detail | `pipeline_run_steps` | Adapted |
| 32 | — (no CPI equivalent) | — | Approval, Guardrail check, Budget checkpoint, Agent, Agent team steps | Approvals queue, guardrails, budget gate, pillar 7 | Addition |

### Configuration and lifecycle

| # | CPI capability | Source | Equivalent | Primitive | Status |
|---|---|---|---|---|---|
| 33 | Externalised parameters | CI/externalize-parameters-of-integration-flow | `parameters` with values per deployment; secrets only as `secretRef` | `pipeline_deployments`, credentials and virtual keys | Mapped |
| 34 | Versioning (save as version) and drafts | CI/versioning-of-artifacts (excerpt). **Unverified:** CPI's draft state | Draft plus immutable semver versions with a content hash | `pipeline_versions` | Mapped |
| 35 | Simulation | CI/simulation-of-integration-flow | Dry run with mocked responses and a policy preview per step; no dispatch | Simulation and evaluate path | Adapted |
| 36 | Trace log level | CI/tracing-execution-of-integration-flow | `trace` log level per deployment, under step-up, ending within 60 minutes | `pipeline_payloads`, step-up | Adapted |
| 37 | Deploy and undeploy, runtime artifacts | CI/manage-integration-content. **Unverified:** the undeploy action | Deploy behind a bound approval; immediate undeploy | Approvals queue (`pipeline_deploy`) | Adapted |

### Monitor

| # | CPI capability | Source | Equivalent | Primitive | Status |
|---|---|---|---|---|---|
| 38 | Message processing log | CI/message-processing-log | Pipeline runs and run detail | `pipeline_runs`, `pipeline_run_steps`, traces (ADR-0070) | Mapped |
| 39 | Log levels (Info, Debug, Trace) | CI/tracing-execution-of-integration-flow. **Unverified:** "None" | `info` and `trace` | Deployment setting | Adapted |
| 40 | Payload trace (kept 60 minutes) | CI/tracing-execution-of-integration-flow | Encrypted payloads with an org-set TTL (default 24 hours) | Data key, `pipeline_payloads` | Mapped |
| 41 | Retries (JMS backoff, dead letter, manual retry) | CI/apply-retry-pattern-with-jms-queue, CI/tasks-and-permissions | Automatic backoff for idempotent steps only; dead-letter; manual retry under `pipeline_operate`, re-governed | Step-row lease queue, ADR-0129 | Adapted |
| 42 | Message status values | CI/message-status | Run statuses (§7) | `pipeline_runs` | Mapped |
| 43 | External logging | CI/external-logging (excerpt) | Run and step events in the chained audit log and in traces, exported by the existing audit and trace export | Audit chain, `tracing.ts` | Mapped |
| 44 | — | — | Cost and tokens saved per step | `usage_events`, pillars 5 and 6 | Addition |

### Manage security

| # | CPI capability | Source | Equivalent | Primitive | Status |
|---|---|---|---|---|---|
| 45 | Keystore (key pairs, certificates, SSH keys) | CI/managing-keystore-entries | No keystore in pipelines. Keys and certificates stay with the connector or MCP upstream credential that uses them | ADR-0204 upstream credentials, data key | Adapted |
| 46 | Security material (credentials, OAuth2 grants, secure parameters, known hosts, PGP) | CI/managing-security-material | `secretRef` to existing credentials or virtual keys, resolved server side | Credentials, virtual keys | Mapped |
| 47 | Roles and role collections | CI/persona, CI/tasks-and-permissions | `pipeline_read`, `pipeline_edit`, `pipeline_operate`, `pipeline_deploy_approve`, `pipeline_admin` in the role builder | Pillar 1 roles | Mapped |

### Content lifecycle

| # | CPI capability | Source | Equivalent | Primitive | Status |
|---|---|---|---|---|---|
| 48 | Transport (CTS+, TMS, MTAR) | CI/enabling-content-transport-cloud-foundry-environment | Signed export and import bundles between RegulAIt instances; import lands as a draft and needs its own deployment approval. CTS+ and TMS are SAP-specific: N/A | Export/import API | Adapted |
| 49 | Discover / prepackaged content | CI/what-is-sap-cloud-integration | An offline pipeline template catalogue shipped in the repo, like agent templates | Builder templates | Adapted |
| 50 | Public OData APIs (packages, design-time and runtime artifacts, MPLs) | CI/message-processing-logs (excerpt) | `/v1/pipeline-packages`, `/v1/pipelines`, `/v1/pipeline-deployments`, `/v1/pipeline-runs` (REST, versioned, keyset-paginated per ADR-0226) and `api-client` | OpenAPI | Mapped |

### Other CPI capabilities

| # | CPI capability | Source | Equivalent | Primitive | Status |
|---|---|---|---|---|---|
| 51 | Partner Directory | CI/read-and-modify-partner-directory-content (excerpt) | Parameter sets per deployment environment | `pipeline_deployments` | Adapted |
| 52 | Value mappings | CI/partner-directory-entity-types (excerpt) | Lookup step over a versioned value table | `pipeline-kernel` | Adapted |
| 53 | Number ranges | CI/tasks-and-permissions (excerpt) | None: business document numbering is not an agent-pipeline need; runs have their own ids | — | N/A |
| 54 | Edge Integration Cell (hybrid runtime) | integration-suite/isuite-edge-integration-cell (excerpt) | Runs on the agent execution plane in BYOC and air-gapped modes | Pillar 3 deployment modes | Mapped |
| 55 | Quality of service (exactly once) | CI/quality-of-service-exactly-once (excerpt) | At most once for writes (single attempt plus idempotency key); at least once for idempotent steps | ADR-0129, step-row lease queue | Adapted |
| 56 | Integration Suite siblings (API Management, Event Mesh, Integration Advisor, Trading Partner Management, OData Provisioning …) | integration-suite/what-is-sap-integration-suite | Separate products, outside "CPI for agents" | — | N/A |
| 57 | AI-assisted iFlow generation | **Unverified** (navigation title only) | "Draft a pipeline from a description" through a governed agent; the result is always a draft | Builder agents | Adapted |

### Additional CPI capabilities (review round 1)

These rows were added after the first design review asked for the remaining CPI steps and operations features. No SAP
page was loaded for them in this round, so each source is marked **Unverified**: the capability names come from the
CPI step palette and operations views as the reviewer listed them, and are to be confirmed against help.sap.com in a
follow-up.

| # | CPI capability | Source | Equivalent | Primitive | Status |
|---|---|---|---|---|---|
| 58 | Content Enricher | **Unverified** | Enrich step: calls a governed tool, connector or agent and merges the result into the run data (combine, or merge by key) | Governed call paths, `pipeline-kernel` | Mapped |
| 59 | Poll Enrich | **Unverified** | A connector or MCP read step (for example, fetch a file listing) used mid-flow. CPI's adapter-level polling is replaced by the registered connector | `connector-call.ts`, MCP | Adapted |
| 60 | Send (asynchronous, no reply) | **Unverified** | Send step: a governed call whose reply is not awaited, delivered at most once. Write-class sends are approve-first | Governed call paths | Mapped |
| 61 | Signer and Verifier (PKCS#7, XML signature, PGP) | **Unverified** | No signing keys in pipelines. Signing or verifying runs in a registered connector or MCP tool that holds the key, used as a step | Connectors, ADR-0204 | Adapted |
| 62 | Encryptor and Decryptor (PKCS#7, PGP) | **Unverified** | As row 61: a connector or MCP tool step. Payloads at rest are already encrypted with the data key | Connectors, data key | Adapted |
| 63 | Test Connectivity (TLS, SSH, OAuth) | **Unverified** | "Check connections" in the editor runs the existing preflight for each connector and MCP server the version references, as the user, with no payload | MCP upstream preflight, connector checks | Adapted |
| 64 | Access Policies on artifacts | **Unverified** | Object-level authorisation per package and pipeline, plus ABAC policies | Pillar 1 roles, ABAC (ADR-0040) | Mapped |
| 65 | Message Locks management | **Unverified** | Stuck step leases and idempotency records are listed in run detail; `pipeline_admin` can release one (audited) | Step-row lease, data store | Adapted |
| 66 | Script Collections | **Unverified** | Versioned, shared expression and mapping libraries per package (no code), referenced by version from Transform and Map steps | `pipeline-kernel` | Adapted |
| 67 | Message archiving | **Unverified** | Run and step records are retained under the compliance cascade and can be exported through the existing exports before they are pruned | Pillar 3 retention, exports (ADR-0031) | Adapted |
| 68 | Alerting | **Unverified** | Alerts on failed, dead-lettered or over-budget runs, through the existing governance alerts and spend monitoring | Governance alerts, `spend-monitor.ts` | Mapped |
| 69 | Search by custom header | **Unverified** | Run attributes set by a Set step are indexed and filterable in Pipeline runs (allow-listed keys, bounded values, never payload content) | `pipeline_runs`, ADR-0226 list contract | Mapped |

### Headline

- **67 CPI capabilities assessed:** 32 **Mapped**, 32 **Adapted** and 3 **N/A** (operation/XSLT mapping, number ranges,
  the Integration Suite sibling products). Round 1 added rows 58 to 69 and moved row 25 (variables) from Mapped to
  Adapted, because the tenant-wide global scope is narrowed to the project.
- **Two additions with no CPI equivalent** (rows 32 and 44): governance steps, and per-step cost and savings.
- **Five CPI details unverified on SAP pages:** BPMN, draft state, the undeploy action, the "None" log level and
  write-to-log. Also unverified: AI-assisted generation, beyond a navigation title, and the twelve round 1 rows (58 to
  69), whose sources are still to be confirmed.

## Alternatives rejected

1. **Extend the pillar 2 workflow templates into pipelines.** That would mix the change-lifecycle stage machine with a
   high-frequency data path, and every pipeline run would look like a change instance. Rejected; the two compose through
   the `pipeline` stage type instead.
2. **Use the pillar 7 DAG as the authoring model.** It has no conditions, loops, triggers, versions or deployment, and
   is planned per run by an agent. Rejected as the authoring model; reused for ceilings and for the Agent team step.
3. **Adopt an external engine** (Temporal, Camunda, n8n, Node-RED and others; see §11). Rejected for licence, or because
   it would add a second stateful platform outside the governance interception point.
4. **BPMN 2.0 as the definition format, with bpmn-js as the canvas.** Rejected: too heavy, and bpmn-js's watermark
   clause.
5. **A raw HTTP step, like CPI's HTTP receiver.** Rejected under ADR-0180: every outbound call goes through a registered
   and governed connector, MCP server or A2A agent.
6. **Deploy without approval, warn-only at first.** Rejected under ADR-0180: no warn-only introduction.

## Consequences

- **What we gain.** A reusable, governed composition layer over every existing primitive, with no new governance path.
  CPI users get familiar concepts: packages, the canvas, externalised parameters, deploy and a message monitor.
- **New work.** One new kernel package, about nine tables, one new dependency (croner),
  a lazy editor chunk with its own size ceiling, new permissions, and usage-row columns.
- **What we give up.** CPI's XML, IDoc and EDI-centric steps, keystore management inside flows, and SAP transport
  systems. Automatic retry is never offered for writes.
- **Follow-ups:** the `pipeline` workflow stage type, and a Serverless Workflow exporter if a customer asks.

## Open questions for the owner

1. **Run-as identity for triggered runs.** Recommended: a named human owner who accepts the role, re-evaluated at every
   step. Alternative: a dedicated service identity with its own grants.
2. **Who approves a deployment, and with what quorum?** Recommended: one approver from a role holding
   `pipeline_deploy_approve`, never the requester.
3. **Code step.** Ship it at all? Recommended: yes, but off by default, gVisor only and admin-enabled under step-up.
4. **Durable queue.** Recommended: reuse the `FOR UPDATE SKIP LOCKED` step-row lease, consistent with the earlier
   rejection of pg-boss and graphile-worker in `engine-runs.ts`. Confirm, or ask for a pg-boss or DBOS spike anyway.
5. **Phone.** Is the Outline-only editor at phone width acceptable, with the canvas read-only?
6. **Scope.** Confirm that the XML, IDoc and EDI-centric CPI features (rows 11, 13, 16, 29) and the SAP transport
   systems (row 48) are out of scope unless a use case appears.
7. **Ownership and cost.** Recommended: a package belongs to one project, so runs bill to it. Alternatively, should
   packages be shareable across Shared Projects (pillar 4), with cost attributed to the triggering project?
8. **Export signing.** Should export bundles be signed with the instance's existing evidence-signing key or with a
   separate key?

## Addendum (2026-11-07): canvas library candidates (owner-approved; no build while this ADR is paused)

The owner had several open-source repositories reviewed for reuse (#453). Two canvas libraries pass ADR-0176 (licence,
maintenance, air-gapped) as **dependency candidates** for the `/builder/pipelines` canvas. Nothing is built until the owner
accepts this ADR; the comparison below is the first slice when it is unpaused.

| Candidate | Licence | Fit | Open questions for the spike |
|---|---|---|---|
| `@flowgram.ai/fixed-layout-editor` and `@flowgram.ai/free-layout-editor` (ByteDance FlowGram, about 1.0.16) | MIT | The fixed (step-sequence) layout matches the SAP CPI-style integration-flow model this ADR describes. The free layout suits DAGs. Forms, variable scoping and node-runtime hooks are built in. | Recently reached 1.0, so API stability is uncertain. Transitive UI dependencies and bundle size against the entry ceiling. Some docs are Chinese-first. |
| `@xyflow/react` (React Flow, about 12.x) | MIT | Mature, widely used, and the canvas Langflow uses. Free layout only, so step-sequence semantics would be ours. | More of the CPI-style step model to write ourselves. |

**Design references only, with no code copied:**
- Langflow (MIT): node palette, typed ports and the flow JSON shape.
- AionUi (Apache-2.0): the multi-agent workspace UX.

**Excluded:** Skyvern (AGPL-3.0).

**Spike criteria:**
- the canvas holds no secrets;
- every run goes through the gateway's governed dispatch;
- the entry bundle stays under its ceiling, with the canvas lazy-loaded on `/builder/pipelines`;
- it works offline;
- it meets the DESIGN_GUIDELINES accessibility rules (keyboard-operable nodes and edges).

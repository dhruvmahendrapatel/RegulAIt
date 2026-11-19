# ADR-0364: Governed RPA ("Robots"): approved, versioned browser scripts served as pinned MCP tools, run in the sandbox

- **Status**: Accepted (lane E45 brief, owner decisions 2026-11-18: the confirmed direction)
- **Date**: 2026-11-18
- **Index**: **Governed RPA, "Robots" (pillars 1, 3, 5, 6):** an approved, versioned browser script (recorded, uploaded or agent-drafted, always human-approved) becomes one pinned MCP tool per version on a first-party Robots MCP server, governed exactly like every other tool call through the ADR-0251 core, and runs in a gVisor sandbox with a per-robot egress allow-list. Free-form browser control (`@playwright/mcp`) is a separate high-risk tool, off by default.
- **Backlog item**: lane E45 (owner request 2026-11-18)
- **Built in**: lane E45, one PR per slice: S1 this ADR; S2 backend (tables, CRUD, versions, review, the Robots MCP server, toolbox options); S3 the browser runner; S4 authoring; S5 (later, its own addendum) the desktop engine and the workflow "Robot step" stage
- **Migration**: S2 adds `packages/db/migrations/pending/robots.sql` (numbered at merge, ADR-0252); S1 has none
- **Related**: [ADR-0103](0103-mcp-path-project-budget-gate.md) (MCP cost and budget), [ADR-0176](0176-open-source-first.md),
  [ADR-0124](0124-kill-switch-and-safe-modes.md) (kill switch and safe modes),
  [ADR-0139](0139-final-call-emergency-gate-for-external-writes.md) (final-call gate for external writes),
  [ADR-0180](0180-continuous-assurance-strict-by-default.md), [ADR-0187](0187-batch5-sidecar-engines.md) (heartbeat cancel), [ADR-0181](0181-strict-defaults.md) (Ask first on by default),
  [ADR-0190](0190-batch6-isolation-execution-profiles.md) (sandbox executor), [ADR-0204](0204-mcp-upstream-static-credential.md) (secret envelope),
  [ADR-0230](0230-sap-business-agents-over-mcp.md) (first-party MCP pattern), [ADR-0246](0246-mcp-definition-pinning-and-vuln-fixtures.md)
  (definition pins, high-risk servers), [ADR-0251](0251-one-governed-decision-core.md) (one decision core),
  [ADR-0252](0252-merge-queue-and-merge-time-numbering.md), [ADR-0348](0348-declared-state-machines.md) (state machines)

## Context

Agents in the builder often have to do the same few UI steps again and again: sign in to a supplier portal, fill a form,
download a statement, read a status. Doing that through a model is slow, costly and not repeatable: every run spends
tokens re-reading the page, and two runs can click different things. Robotic process automation (RPA) solves this with a
recorded, deterministic script. The owner wants that capability inside the builder, but only on one condition: **a robot
step is governed exactly like every other tool call.** It must never be a way around a model refusal, a policy decision,
an allow-list, an approval, a rate limit or a budget.

Nothing in the repo does RPA today. What exists and is reused:

- **The governed MCP path.** `mcp-proxy.ts` sends every MCP call through the ADR-0251 core: entitlement (per-user
  default-deny allow-list), approval rules, rate limits (`rate-limit-evaluator.ts`), ABAC, project cost and budget
  (ADR-0103), the audit chain. `mcp-definition-pins.ts` pins each tool's definition at admission (ADR-0246) and
  `mcp-high-risk.ts` classifies a server high-risk with a policy template and an authorised-targets list.
- **The builder toolbox.** `builder_agent_tools` rows are `{kind: "mcp_tool" | "connector", refId, requiresApproval}`;
  `GET /v1/builder/toolbox-options` (`toolboxOptionsFor` in `builder-access.ts`) lists what the caller may attach, using
  the same helpers as the `PUT /v1/builder/agents/:id/tools` check.
- **The sandbox.** `packages/sandbox-executor` (ADR-0190) runs isolable workloads (`mcp_stdio`, `code_exec`,
  `engine_worker`, `byoc_worker` in `packages/shared/src/isolation/contract.ts`) under gVisor (L2, `user_space_kernel`)
  by default. There is no process spawn in the gateway.
- **The one approvals queue** (`approvals.object_type` from `APPROVAL_OBJECT_TYPES`): model cards, training jobs,
  certifications and SoD overrides all use it rather than a second inbox.
- **The secret envelope** (`encryptSecret`, ADR-0204): a secret in its own table, never returned by a read.
- **Declared state machines** (`defineMachine` in `packages/shared/src/state-machines.ts`, ADR-0348).

## Decision

### 1. What a robot is, and where it lives

A **robot** is a named, owned automation in a new **Builder ▸ Robots** library (a section next to `/builder/integrations`
and `/builder/skills`). It has an ordered list of immutable **versions**. Each version holds a script, a typed input
schema, an output schema, an egress allow-list of sites and a list of secret references. Only an **approved** version can
be attached to an agent, and an agent attaches one exact version ("vN pinned").

Engines: **browser** (Playwright) now; **desktop** (Robot Framework with rpaframework) later, in S5 under its own
addendum. The engine is a property of the robot, not of the version, so a robot never changes engine between versions.

### 2. A robot version is an MCP tool on a first-party Robots MCP server

- **One first-party server.** The gateway seeds one `mcp_servers` row, **RegulAIt Robots**, at bootstrap (like the
  ADR-0230 pattern: first-party, but an ordinary row the admin sees). Its transport is a new value, `first_party`, with
  url `regulait:robots`. A `first_party` server is served by an in-process MCP server object built with the MCP SDK
  (`McpServer` over the SDK's `InMemoryTransport`, both already locked at `@modelcontextprotocol/sdk` 1.32.x), so the
  proxy reaches it through the same client code as any other upstream. The `first_party` transport takes no url from a
  request and opens no socket; `mcp-egress.ts` refuses it for any server not on the gateway's fixed first-party list.
- **One tool per approved version.** When a version is approved, the tool sync writes one `mcp_tools` row named
  `robot_<slug>_v<N>` with the version's input schema and description. `robot_versions.mcp_tool_id` points at it (a
  foreign key). The ADR-0246 definition pin is taken at that moment, and since a version is immutable the pin never has
  a reason to change; a pin mismatch therefore means tampering and blocks the tool, as for any server.
- **Attaching.** The toolbox entry stays `{kind: "mcp_tool", refId: <that tool id>, requiresApproval}`: no new
  `BUILDER_TOOL_KINDS` member, no second check path. `toolboxOptionsFor` adds `source: "robot"`, `robotId`, `version`
  and `engine` to the options it lists for tools on the Robots server, so the UI can show them on a **Robots** tab. "Ask
  first" is the existing per-entry `requiresApproval`, on by default (ADR-0181), saved with
  `PUT /v1/builder/agents/:id/tools`.
- **Upgrading** an agent to a newer version is a toolbox edit by the agent's owner (remove vN, add vN+1), audited like
  every toolbox edit. Nothing moves an agent to a new version by itself.
- **Retiring** a version marks its tool blocked in the manifest; agents that pinned it show the tool as unavailable
  and calls are refused (`robot-version-retired`). Retiring the robot retires every version.

Because every robot call is an MCP call to a registered server, **the ADR-0251 core decides it with no new code path**:
per-user default-deny entitlement on the tool, approval rules and Ask first, rate limits, ABAC, the project budget gate
and per-call cost (ADR-0103), and the audit chain. The Robots server's handler runs only after the proxy has allowed the
call, exactly where an upstream would receive it. A robot's own handler cannot grant anything the decision did not.

**Cost.** A robot call is priced per call (`mcp_servers.price_per_call_usd`, ADR-0019) plus measured sandbox seconds,
attributed to the run's project (S3 adds the seconds as a cost line on the same attribution row). A robot run never
calls a model, so its token cost is zero; the saving against the model path is reported through the pillar 6 savings
feed as `rpa_instead_of_model` (S3), never estimated where it cannot be measured.

### 3. Review and approval

All three authoring paths end in the **same** human review:

1. **Recorder and step editor**: the recorder **is Playwright codegen**, run inside the robot sandbox (we write no
   recorder). Its output is turned into plain steps (go to, fill, click, select, read, download, check; verbs shaped by
   TagUI's plain-English vocabulary, ideas only) and stored as a versioned script.
2. **Code upload**: a Playwright TypeScript script or a Robot Framework `.robot` task (the latter with S5).
3. **Agent-drafted**: an agent watches or does a free-form run and drafts the script; the draft enters `in_review` as a
   new version authored by the agent *on behalf of* its initiating user (both recorded), never approved by an agent.
   This follows workflow-use's pattern (ideas only, AGPL, no code): **record once, replay deterministically, and fall
   back to the model only when a step breaks.** The fallback is a per-robot setting, **off by default** (ADR-0180),
   turning it on is audited. When on and a step fails, the runner stops and the gateway makes **one governed model call**
   (the ADR-0251 core, as the run's initiating user, against the run's project budget) that proposes a repaired step.
   **What that call may see** is built server side, never by the runner:
   - the failed step's definition and its error code;
   - the page's accessibility snapshot, with every input value removed, every field a secret was typed into removed,
     and PII masked under the run's compliance-tag PII mode. Under `block`, no page content is sent at all, only the
     step and the error.

   No screenshot, trace, secret value or run input is ever part of it. The run ends `failed` with the proposal
   attached. The proposal becomes a new **draft** version that goes through
   review like any other. An approved version is never edited, and a run never continues on model output.

Submitting a version for review writes one row to the **existing approvals queue** with a new object type
`robot_version`. The approver is never the author or the initiating user of an agent-drafted version (the queue's
existing separation-of-duties guard, ADR-0186 A). The approval is bound to the version's content digest (script,
schemas, allow-list, secret names); a version cannot be edited after submission, so a changed script is a new version
that needs its own approval. Approving runs the tool sync in the decision's own transaction.

A version must have at least one passing **test run** (S3) recorded against the exact digest before it can be submitted.
Test runs are governed robot runs by the author, in the sandbox, behind the same egress list. **Before approval a test run
only ever receives test-scoped secrets** (§6 `robot_secrets.scope = 'test'`, the robot equivalent of a sandbox
credential). A live secret is resolved only for a run of an `approved` version whose digest matches its pin, so an
unapproved or agent-drafted script never holds a production credential. A step that needs a secret with no test value
fails the test run with `secret_unavailable_in_test`. The approver sees which live secrets the version binds, and to
which origins, as part of the digest they approve.

**The digest** covers:
- the script and, for `steps_v1`, the compiled Playwright output and the compiler version;
- the input and output schemas;
- the allow-list;
- each secret binding: its name, the origin it may be filled on, and the live secret it uses.

A recompile under a new compiler is a new version.

### 4. Free-form browser control

The Playwright MCP tools (`@playwright/mcp`: navigate, click, type, snapshot and so on) are offered **next to** approved
robots, as a second first-party server, **RegulAIt Browser (free-form)**. Per ADR-0180 it is **off by default**:

- It is classified **high-risk** through `mcp-high-risk.ts` (sticky `risk_class = 'high'`), so every call needs the
  policy template (quorum approval and a rate limit) and full audit with redacted arguments.
- A **per-user opt-in** by an admin is required on top of the ordinary per-user tool grant (an org setting
  `freeformBrowserUsers`, empty by default), each change a `settings_relax` step-up, audited.
- **Egress is limited to the authorised-targets list** the high-risk module already keeps (`mcp_authorised_targets`):
  the browser's network proxy refuses every other host, and `@playwright/mcp` gets the same list as `--allowed-origins`
  as a second line.
- **Every call is audited with a screenshot** (redacted per §7) stored as run evidence.
- **Same sandbox, same boundary.** A free-form session is the same `robot_browser` workload (§5) and runs from its own
  image (§9). It sits behind the same per-run Smokescreen proxy, whose ACL is the authorised-targets list. The session is
  destroyed at the end of the agent turn, after 5 minutes idle, or after 30 minutes at most.
- **No robot secrets, ever.** The free-form server has no secret-injection path: a model reads that page, so it never
  receives a robot secret, live or test.

A free-form run is the input to agent-drafted authoring (§3, path 3); its output is a draft, never an approved robot.

### 5. Execution: a sandbox workload, never the gateway

A run executes in `packages/sandbox-executor` as a **new workload kind, `robot_browser`**, added to `WORKLOAD_KINDS` and
`ISOLABLE_WORKLOAD_KINDS`, with a required class of `user_space_kernel` (gVisor, L2) and no relaxation below
`hardened_container` without the existing stepped-up isolation override. The image is a first-party, digest-pinned
**robot runner** image with Playwright and its Chromium build baked in (no runtime browser download; see §9 for the
pinned versions), published and signed through the existing engine-image pipeline.

Per run, the gateway creates one placement with: the version's script by digest, the validated inputs, the egress
allow-list, the secret values resolved for this run only (§7), a wall-clock limit and a step limit. The executor starts
the sandbox, the runner executes the script, and the sandbox is destroyed after the run: no browser profile, cookie or
download outlives a run. Results are typed outputs (validated against the version's output schema before they are
returned to the agent) and evidence (§7).

**Kill switch and safe modes ([ADR-0124](0124-kill-switch-and-safe-modes.md),
[ADR-0139](0139-final-call-emergency-gate-for-external-writes.md)).** Every robot run is classed as an **external write**,
whatever its steps, because a script can submit forms on an external system. This covers agent, test and free-form
runs.
- `read_only` refuses robot runs and free-form calls at the ADR-0139 final-call gate.
- `halted` refuses new runs and cancels in-flight ones at the next step. The runner sends a heartbeat between steps
  that answers `{cancel}`, the pattern of ADR-0187's engine runners. A cancelled run ends `cancelled` with
  `failure_code = 'halted'`, and its sandbox is destroyed.

**Attribution.** Every run is attributed to a project with a budget (`robot_runs.project_id` is NOT NULL):
- an agent run takes the project of the governed call; a call the proxy would let through unattributed is refused for
  robots (`robot-run-needs-project`);
- a test run names one of the author's projects with a budget, and that budget gates it like any other call.

**The existing "Use a computer" switch** (`computerUse` on `builder_agents`) stays inert in this ADR. It is **not**
wired to free-form browser control: that switch was designed for model-driven desktop use and has no governance of its
own. S5's addendum decides whether the desktop engine takes it over.

### 6. Data model (3NF, every reference a foreign key)

S2 adds these tables in its own block of `packages/db/src/schema.ts`, in `pending/robots.sql`:

- **`robots`**: `id`, `slug` (unique, `^[a-z0-9_]{1,48}$`), `name`, `description`, `engine` (`browser` | `desktop`),
  `owner_user_id` → `users`, `status` (`active` | `retired`, the robot's own lifecycle, §8; the list's "Status"
  column is computed from the versions, not stored), `model_fallback` (boolean, default false, §3 path 3;
  changes audited), `created_at`, `retired_at`.
- **`robot_versions`**: `id`, `robot_id` → `robots`, `version` (integer, unique per robot), `status` (`draft` |
  `in_review` | `approved` | `rejected` | `retired`, the version machine; `rejected` is terminal), `source` (`recorded` | `uploaded` |
  `agent_drafted`), `script_format` (`steps_v1` | `playwright_ts` | `robot_framework`), `script` (text, the reviewed
  artefact; exception comment: an immutable evidence artefact once submitted), `script_sha256`, `compiled_sha256` and `compiler_version` (`steps_v1` only), `content_digest` (§3), `input_schema` and
  `output_schema` (jsonb; exception comment: schema-validated configuration documents), `author_user_id` → `users`,
  `drafted_by_agent_id` → `builder_agents` (nullable), `approval_id` → `approvals` (nullable), `mcp_tool_id` →
  `mcp_tools` (nullable until approved), `created_at`, `submitted_at`, `decided_at`. Unique on (`id`, `robot_id`), for
  the composite foreign keys below. Content columns are frozen by a
  trigger once `status <> 'draft'`.
- **`robot_version_allowed_sites`**: `robot_version_id` → `robot_versions`, `origin` (normalised `https://host[:port]`),
  primary key on both. A join table, not a jsonb list.
- **`robot_version_secrets`**: `robot_version_id`, `robot_id`, `name` (the name the script uses), `origin`,
  `live_secret_id` and `test_secret_id` (nullable). Primary key on (version, name). It is joined to its parents by
  composite foreign keys, so a version can only bind its own robot's secrets, and only on one of its own allowed sites:
  - (`robot_version_id`, `robot_id`) → `robot_versions` (`id`, `robot_id`);
  - (`live_secret_id`, `robot_id`) and (`test_secret_id`, `robot_id`) → `robot_secrets` (`id`, `robot_id`);
  - (`robot_version_id`, `origin`) → `robot_version_allowed_sites`.

  A trigger checks that `live_secret_id` has scope `live` and `test_secret_id` has scope `test`. The runner fills a
  secret only on a page whose origin equals the binding's `origin`.
- **`robot_secrets`**: `id`, `robot_id` → `robots`, `name`, `scope` (`live` | `test`), unique on (`robot_id`, `name`,
  `scope`) and on (`id`, `robot_id`), `ciphertext` (the ADR-0204 envelope, listed in
  `CIPHERTEXT_COLUMNS`), `last4`, `set_by` → `users`, `set_at`. Its own table so no read of a robot carries ciphertext.
  The UI shows "set / not set" and the last four characters; nothing returns the value.
- **`robot_runs`**: `id`, `robot_version_id` → `robot_versions`, `requested_by` → `users`, `agent_id` →
  `builder_agents` (nullable; null for a test run), `project_id` → `projects` (NOT NULL, §5), `mcp_call_audit_id` →
  `audit_log` (the governed call that started it), `placement_id` → the isolation placement, `status` (the ROBOT_RUN
  machine), `kind` (`test` | `agent` | `freeform`), `started_at`, `finished_at`, `step_count`, `duration_ms`,
  `failure_code` (a fixed vocabulary), `proposed_version_id` → `robot_versions` (nullable: the draft a model
  fallback proposed), `created_at`.
- **`robot_run_evidence`**: `id`, `robot_run_id` → `robot_runs`, `kind` (`screenshot` | `trace` | `download` | `log`),
  `step_index`, `object_key`, `sha256`, `bytes`, `redaction` (`none` | `masked` | `withheld`), `expires_at`.
  Append-only (exception comment: evidence). When the run ends, its audit row carries the list of evidence `sha256`
  values, which anchors them in the audit hash chain. A replaced or deleted object is then detectable.

Who used a version ("Used by N agents") is a count over `builder_agent_tools` joined through `robot_versions.mcp_tool_id`,
not a stored number. Inputs and outputs of a run are not stored in the run row: they are in the audit chain, redacted,
like every MCP call's arguments.

Row-level security follows the existing builder tables. Object-level authorisation: a robot's owner and admins may read
and edit it; a version is visible to anyone who may attach its tool (the toolbox check); a run is visible to its
requester, the agent's owner and admins.

### 7. Threat model

| Threat | Control |
|---|---|
| **Credential theft or leakage** | Secrets live in `robot_secrets` under the ADR-0204 envelope, never in a script, a version, an input, a log or an audit row. The runner receives values for one run over the executor channel, held in memory, injected only into `fill` steps that name them; the step editor and the upload lint refuse a script that reads a secret into an output, a `read` step, a URL or a log. Screenshots use Playwright's own `page.screenshot({ mask })` over every locator a secret or input was filled into. **Traces are off by default:** an admin may turn them on per robot for debugging, for test runs with test secrets only. Each trace is recorded with `snapshots: false` and `sources: false`. The trace zip is then post-processed before upload: every known test-secret value and every input value is replaced, and PII is masked under the PII mode. A trace is never kept under `block`. S3 adds a canary test: a known secret value must never appear in any byte of stored evidence. A secret is bound to one origin (§6), and the runner fills it only on that origin, so a changed page cannot send it to another allowed host. |
| **SSRF and egress** | The sandbox has no direct network: its network policy allows exactly one peer, its own per-run **Smokescreen** instance (stripe/smokescreen, MIT, §9). Smokescreen runs beside the sandbox in the executor, with an ACL generated for that run alone: one role with `action: enforce` and `allowed_domains` set to the hosts of the version's `robot_version_allowed_sites` (free-form: the authorised-targets list). The `open` and `report` actions are switched off with `--disable-acl-policy-action`. It resolves every name itself and connects only to the address it checked, so DNS rebinding cannot move a connection. Non-public addresses are refused by default. `--deny-range` adds the cloud metadata addresses (169.254.169.254/32, fd00:ec2::254/128). `--allow-range` is set only where the org's private-network setting allows ranges (ADR-0043), and each one is audited. Ports are limited to those of the version's origins: by the in-browser route check, and in S3 by Smokescreen's port setting if it has one, otherwise by a CONNECT filter in front of it, recorded as an ADR-0176 exception. Each run's Smokescreen log is part of its evidence. Playwright `route` blocking repeats the allow-list inside the browser as a second line. Downloads are size-capped and stored as evidence, never executed. They follow the PII mode: under `block` only their `sha256` and size are kept, and under `warn` and `log` they are stored with read access limited to the run's viewers. |
| **Screenshot PII** | Screenshots and traces follow the **PII handling mode of the compliance tag** that cascades to the run's project (pillar 3): `block` withholds screenshots and keeps only step outcomes; `warn` and `log` mask detected PII (the existing `mcp-pii.ts` detectors on the page text, plus masks over input fields and any element the script marks sensitive) before upload. With no tag the strict default is masking. |
| **Evidence capture** | Run evidence **is Playwright's own trace and screenshots** (`tracing.start` / `tracing.stop`, `page.screenshot`), redacted before upload as above. We write no capture code, only the redaction and the upload. |
| **Evidence retention** | Evidence is written to the object store under the org's evidence bucket, content-addressed (`sha256`), and expires at the audit-retention period of the run's compliance tag (pillar 3), default the org's audit retention. Evidence rows are append-only; deletion happens only by expiry, recorded. |
| **Sandbox escape** | gVisor L2 by default, a read-only root filesystem, no secrets on disk, no host mounts, a non-root user, seccomp, CPU, memory, wall-clock and step limits, and one sandbox per run destroyed afterwards. The image is digest-pinned and signed; the executor's existing attestation refuses a mismatch. |
| **Prompt injection from page content** | A robot's script is fixed: page content cannot change which steps run, only what a `read` step returns. Outputs are typed (validated against the output schema, strings length-capped) and returned to the agent marked as **untrusted tool output**, the same as any MCP result, so the existing guardrails on tool results apply. A robot never calls a model. In free-form mode the model does read the page, which is why it is high-risk, opt-in, allow-listed and quorum-approved. |
| **Policy bypass** | A robot run starts only from a governed MCP call (or a test run by the author, itself governed). The handler re-checks the version is `approved` and its digest matches the pin in the same transaction that creates the run; a retired or tampered version is refused. A robot cannot attach tools, call other robots or reach the gateway API. |
| **Supply chain of uploaded code** | An uploaded Playwright script is linted (S4): a single default export over a provided `page`, no imports beyond a fixed allow-list, no `eval`, `Function`, `child_process`, `fs`, network APIs or dynamic import. It runs only in the sandbox, so a lint miss is still contained. |

### 8. State machines (ADR-0348)

Declared with `defineMachine` in `packages/shared/src/state-machines.ts` (S2):

- **`ROBOT_VERSION_MACHINE`** (`robot_versions.status`, initial `draft`, terminal `rejected` and `retired`), with four
  transitions:

  | Event | From | To | Note |
  |---|---|---|---|
  | `submit` | draft | in_review | needs a passing test run on the digest |
  | `approve` | in_review | approved | the queue decision |
  | `reject` | in_review | rejected | |
  | `retire` | approved | retired | |

  A rejected version stays rejected, with its approval and digest kept as the record of what was refused. A fix is a
  new version number, as §3 says. Content is frozen once the status is not `draft`.
- **`ROBOT_MACHINE`** (`robots.status`, initial `active`, terminal `retired`): the robot's own lifecycle, not a summary
  of its versions. The only transition is `retire` active → retired, through its own audited API. In the same
  transaction it retires every approved version and moves every draft or in-review version to `rejected`, with reason
  `robot_retired`. The list's "Status" column is computed on read from the versions, with this precedence:
  - Retired, if the robot is retired;
  - otherwise Approved, if any version is approved;
  - otherwise In review, if any version is in review;
  - otherwise Draft.
- **`ROBOT_RUN_MACHINE`** (`robot_runs.status`, initial `queued`): `queued` → `running` → `succeeded` | `failed` |
  `timed_out` | `cancelled`; `queued` → `refused` (placement refused, egress or secret unresolved); all of the last five
  terminal.

Every writer guards its `UPDATE` on the source state (`whereFrom`), and API responses carry the read-only `lifecycle`
view for the UI and agents.

### 9. Engines: what we build on, and what we rejected (ADR-0176, rule 9)

**Chosen for the browser engine:** Playwright (Apache-2.0) for scripted runs and codegen recording, and
`microsoft/playwright-mcp` (`@playwright/mcp`, Apache-2.0) for free-form control. Both are maintained by Microsoft with
frequent releases. Versions are pinned exactly in the lockfile and the runner image; the browser binary is installed
at image build, so nothing is downloaded at run time (air-gapped). Pinned at the time of writing: see the table below.

**Chosen for the desktop engine (S5, later):** Robot Framework 7.x and rpaframework (both Apache-2.0) in a Python engine
container, without `RPA.Cloud.*`, `RPA.Robocorp.Vault` or `RPA.Robocorp.WorkItems` (cloud services and their own secret
store, which would bypass ours). S5 compares `rf-mcp` (RobotMCP, Apache-2.0) with a thin wrapper of our own. In reserve:
robotgo (Apache-2.0, Go, low-level input) and Astron RPA (Apache-2.0, a Windows platform).

**Before S5:** check the licences of rpaframework's transitive dependencies. Any LGPL package is not on the ADR-0176 list
and is excluded or replaced.

**Our own code** is only what is genuinely RegulAIt: the governance (the tool mapping, versioning, review, the
first-party server), the step model, the evidence format and redaction, and the run placement.

| Candidate | Licence | Maintenance | Verdict |
|---|---|---|---|
| Playwright | Apache-2.0 | very active | **chosen** (browser runs, recorder) |
| `@playwright/mcp` | Apache-2.0 | very active, 0.0.x | **chosen** (free-form, high-risk) |
| Robot Framework + rpaframework | Apache-2.0 | active | **chosen for S5** (desktop) |
| rf-mcp (RobotMCP) | Apache-2.0 | active (0.36.0, 2026-09-26; commits to 2026-11-16), one main maintainer | evaluate in S5 |
| robotgo | Apache-2.0 | active, v2 still beta | reserve |
| Astron RPA | Apache-2.0 | active (v1.1.7, 2026-10-22), Windows | reserve |
| UI.Vision RPA | AGPL-3.0 | active | rejected (licence) |
| browser-use workflow-use | AGPL-3.0 | active (v0.2.11) | rejected (licence) |
| WebRPA | AGPL-3.0 per the master's research; no canonical repo re-found 2026-11-18 | unclear | rejected (licence, unverifiable provenance) |
| OpenRPA | MPL-2.0 | active, Windows-only | rejected (licence not on the ADR-0176 list; Windows-only) |
| TagUI | Apache-2.0 | active (v7.0.0, 2026-11-09) | rejected (fit: a second browser driver and its own runtime beside Playwright, no MCP surface) |
| RPA-Python (`rpa`) | Apache-2.0 | last release 1.50.0, 2023-07 | rejected (maintenance) |
| rpatool | WTFPL | not RPA (a Ren'Py archive tool) | rejected (not a fit) |
| **Per-run egress proxy:** stripe/smokescreen | MIT | active (v0.1.0, 2026-09-18; commits to 2026-11-17) | **chosen** (S3). It is a CONNECT proxy built for SSRF: a hostname ACL per role, its own DNS resolution with a public-address check, and deny and allow ranges. It is one static Go binary with no runtime downloads (air-gapped). |
| Envoy dynamic forward proxy + RBAC | Apache-2.0 | very active (v1.40.2) | rejected for fit: it can allow-list hosts, but it has no built-in check that a resolved address is public, so we would write that part ourselves. It is also a much larger component to configure and patch for one job. |
| Squid, tinyproxy | GPL-2.0 | active | rejected (licence) |

**Versions verified 2026-11-18** (npm and PyPI registries, licence from each repository's LICENSE file). S2 to S5 pin
exactly and re-check on the day they add the dependency:

| Package | Version | Released | Licence | Air-gapped note |
|---|---|---|---|---|
| `playwright`, `playwright-core` | 1.65.1 | 2026-11-13 | Apache-2.0 | browsers via `npx playwright install chromium` at image build into `PLAYWRIGHT_BROWSERS_PATH`; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` at run time |
| `@playwright/mcp` | 0.0.85 | 2026-11-09 | Apache-2.0 | depends on `playwright@1.66.0-alpha-2026-11-09`; run with `--headless --isolated --executable-path` to the baked browser |
| `robotframework` (S5) | 7.5.1 | 2026-11-02 | Apache-2.0 | pure Python |
| `rpaframework` (S5) | 34.0.1 | 2026-11-02 | Apache-2.0 | webdrivers and `rfbrowser init` pre-installed at image build |
| `rf-mcp` (S5, evaluate) | 0.36.0 | 2026-09-26 | Apache-2.0 | |

Two findings shape the build:

- **`@playwright/mcp` pins a Playwright prerelease.** The free-form server therefore runs from its **own** image with its
  own lockfile, separate from the robot runner image (stable 1.65.x). A prerelease never enters the runner that executes
  approved robots.
- **Its `--allowed-origins` / `--blocked-origins` are not a security boundary** (its README says so, and they do not
  apply to redirects). They are a second line only; the boundary is our own per-run egress proxy (§7).

### 9a. Reuse map (master addendum, owner direction 2026-11-18: "reuse the best features from the open-source projects, not write things on our own")

**Use as-is** (pinned exactly, Apache-2.0, a `THIRD_PARTY.md` row in the package that adds it, in the slice that adds it):

| Project | Used for | We do not write |
|---|---|---|
| Playwright | the browser runner (S3) | a browser driver |
| Playwright codegen | the recorder (S4) | a recorder |
| Playwright trace and screenshots | run evidence (S3) | capture code |
| `@playwright/mcp` | the free-form browser tools, wrapped behind the gateway as a high-risk server (S3) | any browser tool |
| stripe/smokescreen | the per-run egress proxy, the sandbox's only route out (S3) | a forward proxy, a DNS-rebinding check or an address-range filter |
| Robot Framework + rpaframework | desktop, Excel, PDF, email and OCR steps (S5) | those libraries |
| rf-mcp (RobotMCP) | evaluated in S5 **before** any MCP wrapper of our own is written | a wrapper, unless the evaluation records why rf-mcp fails |
| robotgo, Astron RPA | in reserve | |

**Ideas only** (AGPL or MPL: we read their documentation and never copy their code):

- **workflow-use**: record once, replay deterministically, fall back to the model only when a step breaks. This is the
  model for agent-drafted mode, and the fallback is itself a governed call (§3, path 3).
- **UI.Vision**: visual and OCR steps (find an image or text on screen). These are future step types (S5), built on
  rpaframework's OCR.
- **TagUI**: the plain-English step vocabulary. It shapes the step editor's verbs (§3, path 1).

**We write only:**
- the robot and version data model (§6) and the lifecycle machines (§8);
- version pinning (§2);
- the approval, allow-list, audit and cost hooks into the existing governance (§2, §3, §7);
- the thin first-party MCP server that maps approved versions to tools (§2), on the MCP SDK;
- the sandbox workload glue (§5): the placement, generating each run's Smokescreen ACL file from the version's allow-list,
  the secret injection, and the evidence redaction and upload.

Anything beyond this list needs a written ADR-0176 exception in an addendum to this ADR. One item needs a note now. The
step model (`steps_v1`) and its compiler to a Playwright script are ours, because it is a RegulAIt evidence and review
format: what a reviewer approves is a list of plain steps. S4 records codegen's output in that format and compiles it
back to Playwright calls. It does not interpret steps itself.

### 10. UI

The UI lanes build the screens from these mock-ups (rule 3); this lane builds none. S2's routes go into the route census
with `KNOWN_UI_GAPS` entries pointing at #453.

```
Builder ▸ Robots
  Name            Engine    Version  Status      Used by     [+ New robot]
  Supplier login  Browser   v3       Approved    4 agents
  Invoice export  Browser   v1       In review   0 agents

Robot detail
  Inputs (typed schema)   Allowed sites (egress allow-list)   Secrets (vault references, never shown)
  Steps  1. Go to  2. Fill  3. Click  ...        [● Record] [▶ Test run]
  Last test run: 12 steps · 8.4 s · screenshots · Playwright trace
  Versions: v3 approved (pinned by 4 agents) · v2 retired · v1 retired

Agent editor ▸ Toolbox ▸ Add connection
  [MCP servers] [Connectors] [Robots]
  Supplier login   v3 pinned   Ask first [on]
```

## Consequences

- **Easier:** a deterministic UI task costs one priced call and some sandbox seconds instead of a model loop, and is
  repeatable and reviewable. Every governance control the platform already has applies with no new decision path, so a
  robot cannot be the hole in the policy.
- **Harder:** there is more to add and maintain:
  - a new transport value (`first_party`);
  - a new workload kind (`robot_browser`);
  - a new approvals object type (`robot_version`);
  - a runner image and a pinned Smokescreen binary to publish and keep patched;
  - a test value to keep beside each live secret. Pages change, so robots break; a broken robot fails
  its run with evidence rather than guessing, and the fix is a new version through review.
- **Given up:** self-healing selectors and silent model recovery inside a robot run. A broken step never continues on
  model output; the opt-in fallback (§3, path 3) only proposes a new draft version for review. Free-form control covers
  the cases that need judgment, under its stricter gate.
- **Follow-ups:** S2 to S5 as listed above. Owner questions recorded as open with their secure defaults: whether the
  free-form opt-in should also require a project with a budget (default: yes, as the SAP write path does); and the
  maximum run wall-clock (default 5 minutes, admin-adjustable down only without step-up).

## As built: S2 (backend, 2026-11-19)

S2 ships §2, §3 (review), §6 and §8 as written, with these recorded differences:

- **Narrower defaults than the end state:** the `browser` engine only, the `steps_v1` script format only (`playwright_ts`
  waits for the S4 lint, `robot_framework` for S5), and https named-host origins only (no IP literals, credentials,
  paths or single-label hosts). Anything else is refused by name (`robot_engine_unavailable`,
  `robot_script_format_unavailable`, `robot_site_refused`).
- **The submit gate is real, and nothing passes it in S2:** a submit needs a `succeeded` test run whose
  `content_digest` equals the digest being bound, and the runner that writes one arrives in S3. Only tests insert such
  rows. A submit also needs a live secret for every binding (`robot_secret_missing`) and resolves the binding's live and
  test secret ids before the freeze. The approver is named or the org's default approver, and is never the author or
  the submitter (`caller_cannot_approve`); the decide path refuses the author by name
  (`cannot_approve_own_robot_version`), keyed on the decider, so delegation and the admin override do not reach it.
- **Publication happens inside the decision's transaction**, not by a later manifest sync: the decision re-checks the
  robot is active and the stored content still hashes to the digest both the version and the approval carry (else the
  version is recorded `rejected`, `robot-version-stale`), upserts the `mcp_tools` row (`kind = write`) and writes its
  definition pin as approved by the decider, so the ADR-0246 strict pin mode does not hold a reviewed tool as "added".
- **tools/call in S2** re-checks approved, active, not halted and digest, then refuses with `robot_runner_unavailable`;
  nothing executes.
- **A fifth version transition, `discard`** (draft → rejected, by the system), is what robot retirement uses for a
  draft (§8 says drafts move to `rejected`; a declared machine needs an event for it). A pending review of a retired
  robot is moved to `rejected` by `reject` and its approval row to `superseded`.
- **The secret column is `value_ciphertext`** (the `*_ciphertext` naming the data-key custody test reads), not
  `ciphertext`.
- **`robot_runs` is the S2 subset:** `mcp_call_audit_id`, `placement_id` and `proposed_version_id` arrive with the runner
  (S3), as does `robot_run_evidence`.
- **Read access is owner or admin** on every robot route (404 otherwise). A version is also reachable, as a tool, by
  anyone entitled to it through the toolbox; there is no separate version read for them yet.
- **Secret writes are a `settings_relax` step-up** (facts: robot, name, scope); the value is never returned or audited,
  and `last4` is kept only for a secret of 12 characters or more.
- **The first-party server and the ADR-0175 release-age cooldown.** `serverReleaseStatus` exempts a first-party server
  on the gateway's fixed list: its code is the installed gateway, and each change to its manifest is a robot version
  that was just approved on its exact content, not a new third-party release (review of #1059: the first approved robot
  otherwise put the server in a seven-day quarantine). Admission scanning still applies to its manifest. `first_party` is
  not an org-enable-able upstream transport; the proxy preflight skips only the egress half for a server on the fixed
  list (`servedInProcess`), and `checkUpstreamDestination` refuses any other `first_party` row.
- **Separation of duties at decide time (review of #1059).** Every user who wrote a draft's content is recorded in
  `robot_version_editors` (the author on create, each editor on every edit; frozen with the version). The decide path
  refuses any of them and the submitter, keyed on the decider, so delegation and the admin override do not reach it;
  submit refuses naming any of them as approver.
- **What the reviewer sees.** The approval preview carries the full reviewed content: the script, both schemas and the
  exact tool definition agents will read (name, description, schemas, annotations), beside the digest. The named
  approver of a pending version, and anyone the approver has an active delegation to, may read the robot (read only;
  writes stay owner-or-admin). **Who may be named approver:** any active user other than the author, editors and
  submitter, as for every other approvals-queue kind (the eval-run pattern), or the org's default approver. A narrower
  review role is left to the approvals queue's own routing (ADR-0168), not special-cased here.
- **The version status is guarded in the database too.** The freeze trigger refuses any status change that is not an
  edge of `ROBOT_VERSION_MACHINE`, so a version cannot be moved back to `draft` to reopen its content.
- **The call-time pin** compares the stored content's digest with both the version's digest and the digest its approval
  was granted on.
- **`agent_drafted`** is refused from clients in S2: it is set only by the gateway for a version an agent proposed (S3).
- **The list** answers the ADR-0226 list contract (sort, keyset or offset, count, filters); the detail answers the
  newest 20 versions, with older pages by `?versionsBefore=`, and reads each page's sites, bindings, editors and test
  runs in four batched queries.
- **Open with the owner (S3/S4, not built in S2):** the free-form browsing budget requirement and the maximum run time.

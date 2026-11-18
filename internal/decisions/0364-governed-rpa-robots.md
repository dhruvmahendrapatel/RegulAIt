# ADR-0364: Governed RPA ("Robots"): approved, versioned browser scripts served as pinned MCP tools, run in the sandbox

- **Status**: Accepted (lane E45 brief, owner decisions 2026-11-18: the confirmed direction)
- **Date**: 2026-11-18
- **Index**: **Governed RPA, "Robots" (pillars 1, 3, 5, 6):** an approved, versioned browser script (recorded, uploaded or agent-drafted, always human-approved) becomes one pinned MCP tool per version on a first-party Robots MCP server, governed exactly like every other tool call through the ADR-0251 core, and runs in a gVisor sandbox with a per-robot egress allow-list. Free-form browser control (`@playwright/mcp`) is a separate high-risk tool, off by default.
- **Backlog item**: lane E45 (owner request 2026-11-18)
- **Built in**: lane E45, one PR per slice: S1 this ADR; S2 backend (tables, CRUD, versions, review, the Robots MCP server, toolbox options); S3 the browser runner; S4 authoring; S5 (later, its own addendum) the desktop engine and the workflow "Robot step" stage
- **Migration**: S2 adds `packages/db/migrations/pending/robots.sql` (numbered at merge, ADR-0252); S1 has none
- **Related**: [ADR-0103](0103-mcp-path-project-budget-gate.md) (MCP cost and budget), [ADR-0176](0176-open-source-first.md),
  [ADR-0180](0180-continuous-assurance-strict-by-default.md), [ADR-0181](0181-strict-defaults.md) (Ask first on by default),
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

1. **Recorder and step editor**: a recorded run in a sandboxed browser (Playwright codegen inside the robot sandbox),
   turned into plain steps (go to, fill, click, select, read, download, check) and stored as a versioned script.
2. **Code upload**: a Playwright TypeScript script or a Robot Framework `.robot` task (the latter with S5).
3. **Agent-drafted**: an agent watches or does a free-form run and drafts the script; the draft enters `in_review` as a
   new version authored by the agent *on behalf of* its initiating user (both recorded), never approved by an agent.

Submitting a version for review writes one row to the **existing approvals queue** with a new object type
`robot_version`. The approver is never the author or the initiating user of an agent-drafted version (the queue's
existing separation-of-duties guard, ADR-0186 A). The approval is bound to the version's content digest (script,
schemas, allow-list, secret names); a version cannot be edited after submission, so a changed script is a new version
that needs its own approval. Approving runs the tool sync in the decision's own transaction.

A version must have at least one passing **test run** (S3) recorded against the exact digest before it can be submitted.
Test runs are themselves governed robot runs by the author, in the sandbox, with the same egress list.

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

**The existing "Use a computer" switch** (`computerUse` on `builder_agents`) stays inert in this ADR. It is **not**
wired to free-form browser control: that switch was designed for model-driven desktop use and has no governance of its
own. S5's addendum decides whether the desktop engine takes it over.

### 6. Data model (3NF, every reference a foreign key)

S2 adds these tables in its own block of `packages/db/src/schema.ts`, in `pending/robots.sql`:

- **`robots`**: `id`, `slug` (unique, `^[a-z0-9_]{1,48}$`), `name`, `description`, `engine` (`browser` | `desktop`),
  `owner_user_id` → `users`, `status` (the ROBOT machine, §8), `created_at`, `retired_at`.
- **`robot_versions`**: `id`, `robot_id` → `robots`, `version` (integer, unique per robot), `status` (`draft` |
  `in_review` | `approved` | `rejected` | `retired`, the version machine), `source` (`recorded` | `uploaded` |
  `agent_drafted`), `script_format` (`steps_v1` | `playwright_ts` | `robot_framework`), `script` (text, the reviewed
  artefact; exception comment: an immutable evidence artefact once submitted), `script_sha256`, `input_schema` and
  `output_schema` (jsonb; exception comment: schema-validated configuration documents), `author_user_id` → `users`,
  `drafted_by_agent_id` → `builder_agents` (nullable), `approval_id` → `approvals` (nullable), `mcp_tool_id` →
  `mcp_tools` (nullable until approved), `created_at`, `submitted_at`, `decided_at`. Content columns are frozen by a
  trigger once `status <> 'draft'`.
- **`robot_version_allowed_sites`**: `robot_version_id` → `robot_versions`, `origin` (normalised `https://host[:port]`),
  primary key on both. A join table, not a jsonb list.
- **`robot_version_secrets`**: `robot_version_id` → `robot_versions`, `name` (the name the script uses), `robot_secret_id`
  → `robot_secrets`. Primary key on (version, name).
- **`robot_secrets`**: `id`, `robot_id` → `robots`, `name`, `ciphertext` (the ADR-0204 envelope, listed in
  `CIPHERTEXT_COLUMNS`), `last4`, `set_by` → `users`, `set_at`. Its own table so no read of a robot carries ciphertext.
  The UI shows "set / not set" and the last four characters; nothing returns the value.
- **`robot_runs`**: `id`, `robot_version_id` → `robot_versions`, `requested_by` → `users`, `agent_id` →
  `builder_agents` (nullable; null for a test run), `project_id` → `projects` (nullable), `mcp_call_audit_id` →
  `audit_log` (the governed call that started it), `placement_id` → the isolation placement, `status` (the ROBOT_RUN
  machine), `kind` (`test` | `agent` | `freeform`), `started_at`, `finished_at`, `step_count`, `duration_ms`,
  `failure_code` (a fixed vocabulary), `created_at`.
- **`robot_run_evidence`**: `id`, `robot_run_id` → `robot_runs`, `kind` (`screenshot` | `trace` | `download` | `log`),
  `step_index`, `object_key`, `sha256`, `bytes`, `redaction` (`none` | `masked` | `withheld`), `expires_at`.
  Append-only (exception comment: evidence).

Who used a version ("Used by N agents") is a count over `builder_agent_tools` joined through `robot_versions.mcp_tool_id`,
not a stored number. Inputs and outputs of a run are not stored in the run row: they are in the audit chain, redacted,
like every MCP call's arguments.

Row-level security follows the existing builder tables. Object-level authorisation: a robot's owner and admins may read
and edit it; a version is visible to anyone who may attach its tool (the toolbox check); a run is visible to its
requester, the agent's owner and admins.

### 7. Threat model

| Threat | Control |
|---|---|
| **Credential theft or leakage** | Secrets live in `robot_secrets` under the ADR-0204 envelope, never in a script, a version, an input, a log or an audit row. The runner receives values for one run over the executor channel, held in memory, injected only into `fill` steps that name them; the step editor and the upload lint refuse a script that reads a secret into an output, a `read` step, a URL or a log. Screenshots mask every field a secret was typed into (§ PII below), and Playwright traces are recorded with secret values replaced. A secret can be sent only to an origin on the version's allow-list, so a changed page cannot exfiltrate it to another host. |
| **SSRF and egress** | The sandbox has no direct network. Its only route out is a per-run forward proxy that admits CONNECT only to origins on the version's `robot_version_allowed_sites` (free-form: the authorised-targets list), after the same destination check `mcp-egress.ts` applies (DNS re-validation, address pinning, private, loopback, link-local and metadata ranges refused unless the org's private-network setting allows them, redirects to other origins refused). Playwright `route` blocking repeats the allow-list inside the browser as a second line. Downloads are size-capped and stored as evidence, never executed. |
| **Screenshot PII** | Screenshots and traces follow the **PII handling mode of the compliance tag** that cascades to the run's project (pillar 3): `block` withholds screenshots and keeps only step outcomes; `warn` and `log` mask detected PII (the existing `mcp-pii.ts` detectors on the page text, plus masks over input fields and any element the script marks sensitive) before upload. With no tag the strict default is masking. |
| **Evidence retention** | Evidence is written to the object store under the org's evidence bucket, content-addressed (`sha256`), and expires at the audit-retention period of the run's compliance tag (pillar 3), default the org's audit retention. Evidence rows are append-only; deletion happens only by expiry, recorded. |
| **Sandbox escape** | gVisor L2 by default, a read-only root filesystem, no secrets on disk, no host mounts, a non-root user, seccomp, CPU, memory, wall-clock and step limits, and one sandbox per run destroyed afterwards. The image is digest-pinned and signed; the executor's existing attestation refuses a mismatch. |
| **Prompt injection from page content** | A robot's script is fixed: page content cannot change which steps run, only what a `read` step returns. Outputs are typed (validated against the output schema, strings length-capped) and returned to the agent marked as **untrusted tool output**, the same as any MCP result, so the existing guardrails on tool results apply. A robot never calls a model. In free-form mode the model does read the page, which is why it is high-risk, opt-in, allow-listed and quorum-approved. |
| **Policy bypass** | A robot run starts only from a governed MCP call (or a test run by the author, itself governed). The handler re-checks the version is `approved` and its digest matches the pin in the same transaction that creates the run; a retired or tampered version is refused. A robot cannot attach tools, call other robots or reach the gateway API. |
| **Supply chain of uploaded code** | An uploaded Playwright script is linted (S4): a single default export over a provided `page`, no imports beyond a fixed allow-list, no `eval`, `Function`, `child_process`, `fs`, network APIs or dynamic import. It runs only in the sandbox, so a lint miss is still contained. |

### 8. State machines (ADR-0348)

Declared with `defineMachine` in `packages/shared/src/state-machines.ts` (S2):

- **`ROBOT_VERSION_MACHINE`** (`robot_versions.status`, initial `draft`, terminal `retired`): `submit` draft →
  in_review (needs a passing test run on the digest); `approve` in_review → approved (the queue decision); `reject`
  in_review → rejected; `revise` rejected → draft (only the author; it reopens the same row, whose content was frozen
  only while in review); `retire` approved → retired.
- **`ROBOT_MACHINE`** (`robots.status`, initial `draft`, terminal `retired`): the robot's status is the summary the list
  shows. `draft` (no approved version) → `in_review` (a version is in review and none is approved) → `approved` (at least
  one approved version) → `retired`; `rejected` back to `draft`. It moves only as a consequence of version transitions,
  in the same transaction, never by its own API.
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
- **Harder:** a new transport value (`first_party`), a new workload kind (`robot_browser`), a new approvals object type
  (`robot_version`) and a runner image to publish and keep patched. Pages change, so robots break; a broken robot fails
  its run with evidence rather than guessing, and the fix is a new version through review.
- **Given up:** self-healing selectors and model-assisted recovery inside a robot run (that would put a model back in a
  path we promised is deterministic). Free-form control covers the cases that need judgment, under its stricter gate.
- **Follow-ups:** S2 to S5 as listed above. Owner questions recorded as open with their secure defaults: whether the
  free-form opt-in should also require a project with a budget (default: yes, as the SAP write path does); and the
  maximum run wall-clock (default 5 minutes, admin-adjustable down only without step-up).

# RegulAIt — Operating Instructions for Claude Code

<!-- suite-rules:start -->
> **Suite rules apply — read them before acting.**
> `C:\Users\dhruv\Documents\regulAIt - Product Suite\SUITE_RULES.md` binds every regulAIt
> repository and takes precedence over this file. Where the two conflict, **stop and escalate
> to the suite agent** — do not pick a side, and do not edit either document.
> Check `MODULE_REGISTRY.md` (status, ports, brand) and `CAPABILITY_MAP.md` (who owns which
> capability) in that same folder before building anything that may already exist elsewhere.
>
> This block is generated from the suite repo. If a `git pull` removes it, restore it with
> `node scripts/suite-header.mjs --install` from the suite root rather than retyping it.
<!-- suite-rules:end -->

## What this project is

RegulAIt is a from-scratch build of an AI-native agent/development platform in the spirit of
Atlas (atlasapp.ai), Cursor, and Lovable, with **eight co-equal, non-negotiable P0 pillars**
(escalated from two → six per [ADR-0007](docs/decisions/0007-six-p0-pillars.md), then six → eight
per [ADR-0008](docs/decisions/0008-eight-p0-pillars.md)):

1. A **per-user governance/access-control layer** gating every agent/model, connector, and
   MCP-server-tool call (default-deny, per-user tool-level allow-lists, approvals, rate limits,
   full audit logging, admin portal with role builder + per-user override).
2. A **configurable multi-stage workflow engine** (Intake → forced Plan-only mode → generate a
   structured requirements artifact → human sign-off → build → PR → automated checks → merge
   approval → conditional governed deploy → post-deploy verification/rollback), expressed as
   declarative YAML/JSON templates, admin-assignable by target system/repo-path/change-type/
   data-sensitivity/role/environment.
3. **Infrastructure operations, a compliance-classification cascade, and a BYOC/air-gapped
   deployment model** — drift detection, automated CVE patching/certificate rotation, and backup
   policy for our own control plane and any customer-hosted agent runtime; a single compliance
   tag on an Initiative/Shared Project that cascades into required workflow stages, MCP/connector
   data-scope defaults, audit-log retention, and PII handling mode; and three deployment modes
   (hosted fast-start, BYOC, air-gapped) with a disclosed control-plane/agent-execution-plane data
   boundary.
4. **Shared Projects with cross-team context retention** — a governed, multi-team object with its
   own membership, a shared context store with provenance tracking and versioned conflict
   resolution, and opt-in partial sharing from a team's private project, all still gated by
   pillar 1's per-user entitlement model.
5. **A native cost-per-project dashboard** — real-time, per-project AI spend attribution applied
   at the point of every gateway call (agent/model, connector, MCP tool), with budget-vs-actual,
   forecast, alerting/enforcement via the existing Approvals Queue, chargeback/showback, and
   cost-center mapping, built into the gateway rather than bolted on from a third-party FinOps
   tool.
6. **An automatic, backend-enforced token/cost optimization layer** — right-sized model routing,
   edit-vs-rewrite detection, context compaction, lazy tool-loading, request batching, and
   cached/deduplicated reference content, applied transparently on every user's behalf at the
   same interception point that enforces governance and attributes cost, with savings reported
   back through pillar 5's dashboard.
7. **Dynamic multi-agent orchestration with a Project-Manager/Team-Lead delegation model** —
   spin up specialized worker agents on demand, decompose work into a task graph (DAG), and run
   independent subtasks in parallel like a well-run team, with every worker/lead agent inheriting
   — and never exceeding — the entitlements and per-run budget of the initiating user (pillars 1
   and 5).
8. **Native, bi-directional integration with Azure DevOps, Jira, and other PM tools** — the
   task graph and workflow stages map directly onto the customer's own work items rather than a
   shadow copy; the PM tool is the source of truth for priority/description/acceptance-criteria,
   decisions and approvals are tracked as first-class linked records, and everything feeds the
   same single audit trail as pillar 1.

**Provider-agnostic by design — standing principle, applies to all eight pillars.** RegulAIt
never hard-locks to one vendor at any layer:
- **Model/agent layer**: pillar 1's registry routes to any publicly available agent/model
  (Claude, GPT, Gemini, Grok, open-weight, in-house) — per-user entitlement is independent of
  vendor.
- **Cloud/deployment layer**: pillar 3's BYOC mode deploys into AWS, Azure, or GCP under the
  customer's own IAM, plus on-prem/air-gapped — never assumes a single cloud.
- **Git-provider layer**: pillar 2's workflow engine works across GitHub, GitLab, Bitbucket, and
  Azure DevOps.
- **PM-tool layer**: pillar 8's adapters cover Azure DevOps, Jira, Linear, Asana, monday.com, plus
  a generic webhook/API adapter — never assumes a single PM tool.
- **Scope note**: this principle governs the *product* RegulAIt ships. It does not apply to our
  own bootstrap dev-infra (ADR-0002/0003), which is deliberately AWS-only — that's a build-tooling
  choice for building RegulAIt itself, not a constraint on what RegulAIt supports for its users.

Full specs: [docs/product/VISION.md](docs/product/VISION.md),
[docs/product/GOVERNANCE_LAYER_SPEC.md](docs/product/GOVERNANCE_LAYER_SPEC.md) (pillars 1, 3, 4,
5), [docs/product/WORKFLOW_ENGINE_SPEC.md](docs/product/WORKFLOW_ENGINE_SPEC.md) (pillar 2),
[docs/product/TOKEN_OPTIMIZATION_SPEC.md](docs/product/TOKEN_OPTIMIZATION_SPEC.md) (pillar 6),
[docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md](docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md)
(pillar 7),
[docs/product/PM_TOOL_INTEGRATION_SPEC.md](docs/product/PM_TOOL_INTEGRATION_SPEC.md) (pillar 8).

This is a multi-month, multi-session build. **No session should assume it remembers the last
one — this file plus `project-state/STATE.md` are the only things guaranteed to persist.**

## Standing guardrail — read this every session

**Nothing gets a "production" designation, and nothing deploys to one, without the user's
direct, explicit sign-off in that session.** No `prod`/`production` account, tag, or CI role
gets created or used without that explicit go-ahead. This applies regardless of what any
individual task seems to imply — always ask before crossing that line.

## Session bootstrap sequence (do this first, every time, before taking any action)

1. Read this file (you just did).
2. Read [project-state/STATE.md](project-state/STATE.md) in full.
3. Read [mistakes.md](mistakes.md) — the append-only ledger of this agent's own past
   process errors, each with an extractable rule. Owner-mandated (2026-08-13): the point of
   the file is that no logged mistake is ever made twice.
4. Skim [docs/decisions/README.md](docs/decisions/README.md) for any ADR not yet reflected in
   `STATE.md`'s decisions table — if you find drift, reconcile it before doing anything else.
5. **If any other session may be working this repo** (a second Claude Code session, cloud or
   local, or a human at a checkout), read
   [docs/CONTRIBUTING_PARALLEL_SESSIONS.md](docs/CONTRIBUTING_PARALLEL_SESSIONS.md) and
   **establish which surface you own before editing anything**. Its §4 lists collisions git
   merges without a conflict — a same-numbered migration, a lost ADR index row, and a
   `drizzle-kit generate` timestamp that silently stops every later migration from ever
   applying. When in doubt about whether you are alone, assume you are not.
6. Give the user a one-paragraph recap of current phase/status and **confirm direction before
   acting** — do not assume and start building. This mirrors the product's own forced
   Plan-mode-before-build pattern at the meta level.

## Subagent orchestration convention

- The main session is a **dispatcher and editor of `STATE.md`/ADRs** — it should rarely do deep,
  multi-file exploration or long doc-reading itself.
- Delegate to a subagent anything that would burn significant raw exploration/research tokens
  that aren't themselves decision-relevant: comparing options, reading unfamiliar docs, drafting
  an isolated component. Every subagent should return a **short structured summary only**
  (decision/finding + rationale + files touched + new open questions) — never let raw
  exploration transcripts flow into the main thread.
- Parallel subagents only for independent, non-overlapping research/design questions.
  Sequential, one at a time, for anything touching the same files — merge conflicts are hard to
  debug for a solo, non-engineer-supervised project.
- Reserve a Workflow-tool multi-agent pipeline for later, once there are many independent
  components to fan out across — not needed for bootstrap/design-phase work.
- Once the product's own Intake → Plan → Build → PR → checks workflow exists, this project's own
  development should eventually dogfood it. Until then, the main session manually plays the role
  of "Plan gate + sign-off" itself.

## Update/commit discipline

- **The moment a decision is made**: write/update its ADR in `docs/decisions/` → update
  `docs/decisions/README.md` → update the relevant row(s) in `project-state/STATE.md` → commit
  immediately with a scoped message (e.g. `docs(adr): 0005 choose X over Y for Z`). Never batch
  decisions to session-end — sessions can end unexpectedly.
- **End of every session/chapter**: update `STATE.md`'s recap paragraph + `phase` field, write an
  immutable `project-state/sessions/<date>-session-<n>.md` (append-only, never edited
  retroactively), commit.
- Before ending a session or if context is running low, checklist: is `STATE.md` current? Any
  decision missing an ADR? Any open question uncaptured? Is everything committed?

## Infrastructure conventions

- **AWS**: two-account Organization (Management + Workload `regulait-dev`), IAM Identity Center
  only — no long-lived IAM access keys anywhere, ever. See ADR-0002, ADR-0004.
- **IaC**: Terraform is authoritative (see ADR-0003). One-time backend bootstrap
  (`infra/bootstrap/`) uses plain AWS CLI, not Terraform, to avoid the state-before-state
  chicken-and-egg problem. Everything else is Terraform in `infra/modules/` (reusable,
  project-agnostic) composed into `infra/environments/<name>/` (this project's actual stack).
- Reusability goal: `infra/modules/` should stay project-agnostic so future unrelated projects
  can consume the same modules from a new `environments/<name>/` directory.

## graphify

This project may have a **locally-generated** knowledge graph at graphify-out/ (god nodes,
community structure, cross-file relationships). The directory is `.gitignore`'d by design — a
fresh clone will NOT have it. Regenerate with `graphify update . --code-only` (the ADR-0005
`--code-only` constraint below stands); until it exists, the query/path/explain rules below are
no-ops, so don't waste a session hunting for it.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

**Security constraint (see ADR-0005) — always use `--code-only`.** graphify's code parsing is
100% local (tree-sitter AST, no LLM). But running it on anything other than pure code files
(docs, PDFs, images — including `docs/product/*.md`, our prose product-vision/spec files)
triggers a semantic-extraction pass that **auto-sends that file content to whichever LLM API key
happens to be set in the environment** (Gemini → Kimi → Claude → OpenAI → DeepSeek → Azure →
Bedrock → Ollama, in that priority order — no per-file confirmation). Never run `/graphify` or
`graphify extract` against `docs/product/` or any other prose content in this repo. Always pass
`--code-only` for headless `graphify extract`/`update` calls, or confirm no LLM API key is set.

## caveman

Installed as a Claude Code plugin (user scope), fully local, zero network calls — verified safe
for use with no restrictions (see ADR-0005). Say "talk like caveman" or `/caveman` to compress
agent output tokens; "normal mode" to turn off.

# RegulAIt — Operating Instructions for Claude Code

## What this project is

RegulAIt is a from-scratch build of an AI-native agent/development platform in the spirit of
Atlas (atlasapp.ai), Cursor, and Lovable, with two non-negotiable P0 pillars:

1. A **per-user governance/access-control layer** gating every agent/model, connector, and
   MCP-server-tool call (default-deny, per-user tool-level allow-lists, approvals, rate limits,
   full audit logging, admin portal with role builder + per-user override).
2. A **configurable multi-stage workflow engine** (Intake → forced Plan-only mode → generate a
   structured requirements artifact → human sign-off → build → PR → automated checks → merge
   approval → conditional governed deploy → post-deploy verification/rollback), expressed as
   declarative YAML/JSON templates, admin-assignable by target system/repo-path/change-type/
   data-sensitivity/role/environment.

Full specs: [docs/product/VISION.md](docs/product/VISION.md),
[docs/product/GOVERNANCE_LAYER_SPEC.md](docs/product/GOVERNANCE_LAYER_SPEC.md),
[docs/product/WORKFLOW_ENGINE_SPEC.md](docs/product/WORKFLOW_ENGINE_SPEC.md).

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
3. Skim [docs/decisions/README.md](docs/decisions/README.md) for any ADR not yet reflected in
   `STATE.md`'s decisions table — if you find drift, reconcile it before doing anything else.
4. Give the user a one-paragraph recap of current phase/status and **confirm direction before
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

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

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

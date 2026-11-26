# ADR-0355: Repository agent-config audit with agentaudit as an offline engine (lane E36)

- **Status**: Proposed (phase 1 built; phases 2 and 3 named below)
- **Date**: 2026-11-17
- **Index**: Repository agent-config audit: agentaudit v0.1.2 as an offline engine, posture findings with F×S scores and fix hints (E36), phase 1
- **Deciders:** owner (approved 2026-11-17 from the Manifold competitor review, gap 4); the builder's defaults are marked
- **Builds on:** ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0187 and ADR-0242 (sidecar engines and
  the subject-scan shim), ADR-0195 and ADR-0235 (repository scans), ADR-0079 (pillar-2 PR checks), ADR-0097 and
  ADR-0175 A6 (the admission scanner this reuses), ADR-0200 (engineering guidelines),
  [GAP_ANALYSIS_MANIFOLD_2026-11.md](../product/GAP_ANALYSIS_MANIFOLD_2026-11.md) row 11 and gap 4

## Context

A repository can carry settings that an AI coding agent obeys the moment someone opens it: hooks that run shell
commands, MCP servers that start processes, auto-approve and permissive permission modes, `ANTHROPIC_BASE_URL` and
proxy overrides that move model traffic off our gateway, credential helpers, `PATH` and `NODE_OPTIONS` changes, and
instruction files (AGENTS.md, CLAUDE.md, Copilot instructions) that can carry injected text. RegulAIt discovers MCP
configs on machines (ADR-0259) and scans MCP servers and skills at admission (ADR-0242), but nothing flags a
**repository's** agent settings, either when its default branch is scanned (ADR-0195 SD1) or as a PR check
(pillar 2). The owner approved this lane on 2026-11-17.

### Options compared (ADR-0176; owner rule 2026-11-17: compare at least two)

| | **manifold-security/agentaudit** | **snyk/agent-scan** (formerly invariantlabs mcp-scan) | Cisco mcp-scanner `config` / `known-configs` modes | Write our own |
|---|---|---|---|---|
| Licence | Apache-2.0 (LICENSE and NOTICE read from the v0.1.2 tag) | Apache-2.0 | Apache-2.0 (already vendored, ADR-0242) | ours |
| Maintenance | v0.1.2 tagged 2026-11-12 (the last commit); 9 commits since 2026-01-01; one vendor, new | active (last commit 2026-11-16) | active | ours to keep |
| Air-gapped | yes: reads files only; its URL mode is the only network path and the library API we use has none | **no**: analysis needs a Snyk token and its cloud API (README: "Free-tier users … subject to a daily usage limit") | no: those modes **connect** to each configured server | yes |
| Fit | reads `.claude/`, `.cursor/`, `.codex/`, `.mcp.json`, plugins and skills; 59 rules over hooks, MCP servers, credential helpers, env overrides, permissions and sandbox; a Go library over an `fs.FS`, so it scans in memory; rule ids are stable | scans a **machine's** installed agents and MCP servers, not a repository | scans a machine's client configs by connecting | duplicates agentaudit's parsing of four config formats |
| Verdict | **chosen** | rejected (not air-gapped) | rejected (connects to servers; ADR-0242 §5 already excluded these modes) | rejected for what agentaudit covers |

agentaudit does **not** read `.vscode/`, AGENTS.md, CLAUDE.md or Copilot instruction files, and it reports
*capabilities* (what a setting can do), not values. It has no rule for an MCP package that is not pinned to a version,
a plaintext remote MCP URL, a command that downloads and runs code, a credential literal, prompt-injection text or
hidden Unicode. Those are small, RegulAIt-shaped checks, and the detectors for the last three already exist in our
admission scanner (`scanAdmissionUnits`: the ADR-0042 injection and credential detectors and the hidden-Unicode rules).

**Maintenance risk (recorded as the gap analysis asked):** agentaudit is weeks old and has one vendor, a competitor.
We pin one tag by module checksum, never track `latest`, and the rule catalogue below fails its test when an upgrade
adds or removes a rule, so an upgrade is always a reviewed change. If upstream stops, the pinned copy keeps working;
the fallback is to fork the Apache-2.0 source.

## Decision

### 1. agentaudit as a library inside our driver (`engines/agentaudit/driver`)

The driver is the only code we write around the engine (ADR-0176). It is a Go `main` that imports
`github.com/manifold-security/agentaudit` **v0.1.2** (go.sum pins it and its two dependencies, go-toml v2.4.3 and
yaml.v3 v3.0.1; the CLI's go-git and cobra are not linked). It is run as `agentaudit-driver <input root> <report>`:
- it reads exactly one input file, `agent-config.json` (`regulait.agent-config-bundle.v1`: the repository's agent
  config files, placed by the gateway), and refuses an unknown field, trailing data, an absolute or escaping path, a
  duplicate, a file that is also a directory, more than 500 files or more than 8 MiB;
- it scans the bundle **in memory** through agentaudit's `fs.FS` API: nothing is written to disk and nothing the
  repository declares is run (agentaudit only reads);
- it writes a `regulait.agent-config-audit.v1` report of rule ids, agents, categories, files and key paths, and
  **never a finding's value**. agentaudit's own reports print values (command lines, URLs, environment values), which
  can be credentials; ours drops them, as the ADR-0242 drivers drop descriptions;
- it fails closed: an unreadable or invalid input, a scan error, or a linked agentaudit other than v0.1.2 (read from
  the binary's own build info, never claimed) writes a `failed` report and exits 2. A source the engine could not
  read or parse still completes, with the counts, and is never treated as clean (§3).

### 2. The image (`engines/agentaudit/Dockerfile`)

- Bases pinned by digest: `golang:1.27-trixie@sha256:af1bfc26…` (the one ADR-0242 uses; Go 1.27.3) to build, and
  `node:22-trixie-slim@sha256:be1e2a3d…` to run (phase 2's runner shim is Node, as for mcpscanner).
- `go mod download && go mod verify` with `GOFLAGS=-mod=readonly`, the checksum database on and `GOTOOLCHAIN=local`;
  module downloads happen at build time only. The binary is static (CGO off), `-trimpath`, no build id. The build
  fails unless `go version -m` shows agentaudit v0.1.2 linked. The upstream LICENSE and NOTICE files ship in
  `/opt/agentaudit/licences`.
- npm, npx and corepack are removed from the runtime; the zlib1g fix the other engine images carry is applied.
- An **offline smoke scan** runs in the image as built under `RUN --network=none`: the known-bad bundle must complete
  with the four named high rules and no value in the report, and the minimal bundle must give exactly its one MCP
  server. Runs as uid 10001.
- **Measured 2026-11-17 (builder, locally):** the image builds and its smoke scan passes; it also runs with
  `--network=none --read-only --cap-drop=ALL --security-opt no-new-privileges`. Image size 344 MB (the Node base).
  The driver's Go tests pass. Trivy was not available in the build sandbox: the CI image scan comes with phase 2,
  when the image joins the reproducible-build matrix.

### 3. Posture findings, scored on the owner's scale (`packages/shared/src/agent-config-audit.ts`)

- **One catalogue** (`AGENT_CONFIG_RULES`, version `agent-config-rules/2`, digest pinned in its test) gives every
  rule an id, a title, a **frequency** F and a **severity** S on the owner's 1–10 scales, and a fix hint. It holds
  all 59 agentaudit v0.1.2 rules (checked against `engines/agentaudit/rule-ids.txt`, read from the tagged source) and
  our twelve: `regulait.mcp.unpinned-package`, `regulait.mcp.remote-plaintext`, `regulait.hook.remote-code`,
  `regulait.secret.literal`, `regulait.instructions.prompt-injection`, `regulait.instructions.hidden-unicode`,
  `regulait.vscode.auto-approve`, `regulait.vscode.terminal-auto-approve`, `regulait.vscode.url-auto-approve`, `regulait.vscode.mcp.server`,
  `regulait.instructions.present` and `agentaudit.unmapped`.
- **F × S < 5 is informational** (owner, 2026-11-17): reported, never failing a check. Above that the bands are
  low (5–14), medium (15–29), high (30–59) and critical (60+). F means how often the setting is abused or goes wrong,
  S how bad it is when it does; the scores are the builder's (**builder's default, open to the owner**).
- **The engine's report is read strictly** (`interpretAgentConfigAuditReport`): a report that does not parse, names
  another engine version or another input digest, or is `failed`, is `unknown` with no findings. One that could not
  read or parse a source, or omitted findings, is `incomplete`: its findings stand and it is never clean. An engine
  rule the catalogue does not know becomes `agentaudit.unmapped` (F3 × S5, medium) with the engine's id kept, so a
  new upstream rule is seen, never dropped.
- **The complementary audit** (`auditAgentConfigFiles`) runs in process on the same files. It reuses
  `scanAdmissionUnits` with the skill skip-list for hidden Unicode, credential material and (in instruction files
  only) injection phrasing; parses JSON and JSONC with momoa (MIT, already a dependency) and Codex TOML with
  smol-toml (already a dependency) for MCP pinning and transport; and matches a download piped into an interpreter.
  The VS Code setting names were checked against code.visualstudio.com on 2026-11-17 (`chat.tools.global.autoApprove`,
  renamed from `chat.tools.autoApprove` in 1.104, and `chat.tools.urls.autoApprove`; `chat.tools.terminal.autoApprove`,
  whose entries approve a command when `true` or `{ approve: true }`, checked on 2026-11-21). An MCP package counts
  as pinned at one exact version: npm `name@1.2.3`, PyPI `name==1.2.3` or uv's `name@1.2.3`; `@latest` and ranges
  never do. Instruction text also covers `.claude/` and `.cursor/` `commands/` and `agents/` prompts. Findings carry file and line,
  never the matched text.
- **The PR check's verdict** (`agentConfigCheckVerdict`) fails on any finding at or above `failOn`, and on any audit
  that is incomplete or unknown. The default `failOn` is `low`: every finding that is not informational fails
  (ADR-0180). A template may relax it to `medium`, `high` or `critical`; templates are versioned and audited.
- **Which paths are read** (`isAgentConfigPath`): everything under `.claude/`, `.cursor/`, `.codex/`, `.agents/`,
  `.claude-plugin/` and `.cursor-plugin/`; `.mcp.json`, `.claude.json`, `.vscode/mcp.json`, `.vscode/settings.json`,
  `.cursorrules`, `.github/copilot-instructions.md`, `.github/{instructions,prompts,agents}/*.md`; and every
  `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` at any depth. A config file left out of the bundle (too large, over
  a limit, not text, or a path the driver would refuse, mirrored in `isBundlePath`) makes the audit incomplete. The
  bundle budget counts UTF-8 bytes, as the driver does.

### 4. Read-only by construction

Nothing in this lane writes to a repository, opens a PR comment with a fix, or runs anything the repository declares.
The engine sees the bytes the gateway's read-only repo reader already fetched (ADR-0195 SD1).

### 5. Out of scope

- agentaudit's URL mode (fetches GitHub anonymously) and `--global-config` (a user's home directory): the gateway reads
  repositories itself, and machines are ADR-0259's.
- Plugin directories outside the dot-directories that a marketplace file points at are not selected yet; agentaudit
  reports a referenced file it cannot read, so such a scan is incomplete (never clean). Phase 2 may add a second
  round from the driver's list of missing paths.
- Severity tuning per organisation, and suppressions: not asked for; a later ADR if wanted.

### 6. Phases 2 and 3 (named, not built here)

1. **Phase 2 — the engine and the repo scans.** `agentaudit` joins `ENGINE_IDS` with the ADR-0242 subject shim
   (`packages/engine-admission-scan`: the driver command becomes per engine, the subject file `agent-config.json`),
   a pending migration widens the engine CHECKs and adds the findings table (one row per finding, a foreign key to the
   repository observation's source and the scan run, the finding columns as point-in-time evidence under the ADR-0200
   addendum), the image joins the reproducible-build matrix and the CI image scan, and the ADR-0195 SD1 repo scan
   reads the selected paths at the head it already reads, runs the complementary audit in process, and enqueues the
   engine run. A read-only route lists the findings (route census; a KNOWN_UI_GAPS entry pointing at #453).
2. **Phase 3 — the PR check.** An `automated_check` binding (`agentConfigAudit: { check, failOn? }`) in the workflow
   kernel: on stage entry the gateway reads the PR head's agent-config paths through the same reader, runs both
   halves, and decides the named check with `agentConfigCheckVerdict`; never reported by a caller and never
   auto-passed. Engine off or not yet published means the check fails (`unknown`), the ADR-0180 default.

## Consequences

- A repository's agent settings get rule ids, scores and fix hints from one versioned catalogue, from an engine that
  is pinned, offline and never sees the network.
- We depend on a young, single-vendor project; the pin, the catalogue test and the Apache-2.0 licence bound the risk.
- The default `failOn: low` will fail PR checks on repositories that declare any MCP server or hook. That is the
  secure default; teams relax it per template.

## Open questions (owner)

1. The F and S scores in the catalogue are the builder's. The owner may re-score any rule; a change bumps
   `agent-config-rules/N`.
2. `failOn` defaults to `low`. The alternative is `medium` (MCP servers, plugins and bundled scripts would then pass).

# ADR-0330: On-device enforcement, slice 2: hook adapters for Cursor, GitHub Copilot CLI and Codex (P1)

- **Status**: Proposed (built, default off)
- **Date**: 2026-11-15
- **Index**: On-device enforcement: Cursor, Copilot CLI and Codex hook adapters (P1)
- **Builds on**: ADR-0298 (on-device enforcement slice 1: Claude Code `PreToolUse`, signed policy, fail closed), ADR-0195
  (the endpoint agent and its pending SD4 signer), ADR-0180 (secure by default), ADR-0176 (open source first).

## Context

ADR-0298 left "More agents" as a follow-up: adapters for Cursor, GitHub Copilot CLI and Codex, each written against its own
documented contract. A pilot needs policy enforced in every coding tool its developers use, not only in Claude Code.

The three contracts were checked on **2026-11-15** against first-party documentation only:

- **Cursor:** cursor.com/docs/hooks. The docs' sample `cursor_version` is 1.7.2; no minimum version is stated.
- **Copilot CLI:** docs.github.com/en/copilot/reference/hooks-reference, and the Copilot CLI changelog (latest entry
  1.0.112). Relevant entries: 0.0.396 (`preToolUse` can deny) and 1.0.57 (a `preToolUse` hook error denies).
- **Codex CLI:** developers.openai.com/codex/hooks and /codex/enterprise/managed-configuration. Hooks shipped in
  rust-v0.114.0 and are on by default.

The contracts differ in what they let a hook see and whether it can fail closed. This ADR records those differences per
agent rather than claiming the same coverage everywhere.

## Decision

### 1. One decision, one policy, four adapters

- **Shared core.** Every adapter turns its agent's hook input into the same neutral `Call` and answers with ADR-0298's
  single `Decide`, against the same signed `regulait.endpoint-enforcement/1` policy.
- **Adapters.** They are `regulait-agent hook claude-code|cursor|copilot-cli|codex -policy FILE`. Each one only parses
  input and renders output.
- **No new decision logic.** There is no new policy language and no per-agent rule set.
- **What an adapter never reads.** It never decodes tool arguments. It never reads Cursor's stdio launch `command`,
  which can carry tokens.
- **Unreadable input.** For every agent it is a deny, written as both the agent's deny JSON and exit 2.

### 2. Per-agent coverage, recorded honestly

| | Cursor (`beforeMCPExecution`) | Copilot CLI (`preToolUse`) | Codex (`PreToolUse`) |
|---|---|---|---|
| Identifies the MCP server | Yes: `mcp_server_name` | **No**: the input names only the tool, and MCP tool naming is not documented | Only inside the tool name, `mcp__<server>__<tool>` |
| Definition source (provenance) | **No** | **No** | **No** |
| Fails closed on crash or error | Yes, with `failClosed: true` (enterprise hooks only) | Yes, since 1.0.57 | **No**: errors do not block (documented) |
| Fails closed on timeout | Yes, with `failClosed: true` | **No**: timeouts always fail open (documented) | **No** |
| Admin location users cannot override | Enterprise `hooks.json` (`/etc/cursor/`, `/Library/Application Support/Cursor/`, `C:\ProgramData\Cursor\`); any deny wins across sources | `policy.d/*.json` (root-owned), not disabled by `disableAllHooks` | `requirements.toml` `[hooks]` with `allow_managed_hooks_only = true` and `[features].hooks` pinned |
| Command form | Shell string | Exec form (`exec` + `args`) | Shell string |
| Allow answered as | `{"permission":"allow"}` (empty stdout would block) | No output (normal permission flow) | No output (Codex approval policy applies) |

The agents differ in a few ways the table cannot show:

- **Cursor** covers only local agents. `beforeMCPExecution` does not run in Cursor's cloud agents.
- **Cursor** has no exec form, so the registration command is an absolute path with no shell metacharacters. On Windows
  it runs through PowerShell.
- **Codex** documents that hooks are "a useful guardrail, not a complete enforcement boundary". A deny from the hook is
  reliable. A crash or a stall lets the call run.
- **Codex's** stronger, vendor-native control is the `requirements.toml` `[mcp_servers.<name>] identity` allow-list,
  which matches a server's command or URL. We recommend deploying it alongside the hook. The hook still adds the org's
  per-user decision and (in a later slice) the audit trail.

### 3. No provenance means an explicit, signed choice

ADR-0298 trusts a server only when both its name and its definition source are accepted. None of the three new agents
reports a source, so each adapter reports a fixed **unattested source** instead: `cursor-unattested`,
`copilot-unattested` or `codex-unattested`.

- **Default.** A policy accepts an agent's calls only if it lists that agent's unattested source in `allowSources`.
  Without it, an approved server name gets no calls from that agent.
- **Trust by name is explicit.** Trusting a server by name alone, on an agent that cannot prove where the server came
  from, is a choice the control plane makes and signs. The device never makes it by default.

### 4. Copilot CLI never guesses a server

Copilot CLI's hook input does not name the MCP server, and its reference does not document how MCP tool names are formed.
So the adapter does not parse servers out of tool names.

- **Built-ins.** A tool in the reference's built-in table gets no decision. The table covers runtime names (`bash`,
  `view`, `edit`, ...) and their Claude names (`Bash`, `Read`, ...).
- **Every other tool** is an unattributed call. That covers MCP tools, extension tools, and built-ins the table does not
  list. `Decide` denies such a call in `enforce` mode and reports a would-deny in `audit` mode.

**Consequence.** In enforce mode, Copilot CLI blocks every non-built-in tool. This is the fail-closed reading of a contract
that cannot identify servers. We recommend running Copilot CLI in `audit` mode (section 5), with GitHub's own MCP
registry allow-list as the server-level control, until GitHub documents server identity in the hook input.

### 5. Per-agent mode in the signed policy

The policy gains one optional, closed member, `agentModes`: a map from an adapter name (`claude-code`, `cursor`,
`copilot-cli`, `codex`) to `audit` or `enforce`.

- **Effect.** It overrides the policy-wide `mode` for that agent only, so an org can enforce where the contract sees
  enough and audit where it does not.
- **Validation.** An unknown agent or mode is refused, and the whole policy then fails to load, which is a deny.
- **Schema version.** The schema stays `/1`. No policy has ever verified in the field, because the compiled keyring is
  still empty (ADR-0298 §2).

### 6. Still off by default

Nothing registers any hook, and the compiled keyring is still empty until SD4. A registered hook therefore denies MCP
calls on every agent, which is ADR-0298's fail-closed default, and Copilot CLI's non-built-in tools are denied too. An
admin opts in per agent by deploying that agent's managed hook registration:

- **Cursor.** `failClosed: true`, in the enterprise `hooks.json` only. Dashboard (team) hooks cannot set `failClosed`
  and are not supported.
- **Copilot CLI.** A `policy.d` file in exec form.
- **Codex.** `requirements.toml` with `allow_managed_hooks_only = true`.

The README documents each registration.

### 7. Open-source search (ADR-0176)

- **What a hook adapter is.** A JSON parser and a renderer for a vendor's contract. It is a product boundary (governance
  decisions on the device), not a solved problem.
- **No shared library.** No maintained library implements these vendors' hook contracts across agents.
- **Rejected again.** DefenseClaw stays rejected as an embedded component (ADR-0298 §5).
- **Dependencies.** JSON comes from the Go standard library. No dependency is added.

## Not in this slice

- **Version checks.** Refusing an uncertified agent version. Cursor sends `cursor_version`, and the adapter requires it to
  be present. Copilot CLI and Codex send no version in the hook input, so a version floor needs a different signal
  (tamper reporting can read the installed version).
- **Cursor cloud agents.** Their `preToolUse` with `MCP:<tool>` names runs off the device. That is not this agent's
  surface.
- **Decision audit, tamper reporting, policy content and delivery.** These remain ADR-0298 follow-ups.
- **Admin UI.** Choosing the per-agent mode and showing coverage per agent is a known UI gap tracked on #453.

## Consequences

- **Coverage.** Four coding agents now have an adapter behind one decision and one policy.
  - Claude Code and Cursor can enforce by server.
  - Codex can enforce by server name, but fails open on errors.
  - Copilot CLI can only audit usefully, until its contract improves.
- **The table is the claim.** The coverage table in section 2 is what we tell a customer about each agent. Vendor
  contracts change fast, so each adapter file carries the date it was checked. A changed contract gets new fixtures,
  and an old fixture is never edited in place.

## Numbering

ADR 0330 is from the range reserved for builder lane E13 (0330 and 0331). The PENDING P1 row is updated in place.

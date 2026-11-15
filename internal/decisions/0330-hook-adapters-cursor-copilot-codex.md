# ADR-0330: On-device enforcement, slice 2: hook adapters for Cursor, GitHub Copilot CLI and Codex (P1)

- **Status**: Proposed (built, default off)
- **Date**: 2026-11-15
- **Index**: On-device enforcement: Cursor, Copilot CLI and Codex hook adapters (P1)
- **Builds on**: ADR-0298 (on-device enforcement slice 1: Claude Code `PreToolUse`, signed policy, fail closed), ADR-0195
  (the endpoint agent and its pending SD4 signer), ADR-0180 (secure by default), ADR-0176 (open source first).

## Context

ADR-0298 left "More agents" as a follow-up: adapters for Cursor, GitHub Copilot CLI and Codex, each written against its own
documented contract. Policy should hold in every coding tool a developer uses, not only in Claude Code, and the set of
coding agents will keep growing. So this slice also fixes the shape every later adapter takes (owner direction,
2026-11-15: build the adapter layer for the long term).

The three contracts were checked on **2026-11-15** against first-party documentation only:

- **Cursor:** cursor.com/docs/hooks. The docs' sample `cursor_version` is 1.7.2; no minimum version is stated.
- **Copilot CLI:** docs.github.com/en/copilot/reference/hooks-reference, and the Copilot CLI changelog (latest entry
  1.0.112). Relevant entries: 0.0.396 (`preToolUse` can deny) and 1.0.57 (a `preToolUse` hook error denies).
- **Codex CLI:** developers.openai.com/codex/hooks and /codex/enterprise/managed-configuration. Hooks shipped in
  rust-v0.114.0 and are on by default.

The contracts differ in what they let a hook see and whether it can fail closed. This ADR records those differences per
agent rather than claiming the same coverage everywhere.

## Decision

### 1. One stable adapter interface: data plus two thin functions

An agent is supported by one `Adapter` value (`internal/enforce/hooks.go`). It has four parts:

- **`Contract`** (data): the contract version, which is the date it was checked and also names the fixture directory;
  the hook event; the agent versions the docs describe; and the first-party doc URLs.
- **`Capabilities`** (data): one row of the capability matrix (section 2).
- **`UnattestedSource`** (data): the source every call carries when the contract cannot attest provenance
  (section 3).
- **`Parse` and `Render`** (code): they turn the agent's input into a neutral `Call`, and a `Decision` into the agent's
  documented output.

`Adapter.Hook` is the only control flow, the same for every agent:

1. Parse the input. A parse failure is rendered as a deny.
2. Stamp the call's agent and, where the contract cannot attest provenance, its unattested source. A parser therefore
   cannot forge provenance.
3. Run `Decide`.
4. Render the result.

The policy and `Decide` are never agent-specific. To add an agent, add one `Adapter` to `Adapters` and one versioned
fixture directory (section 2a). The shared tests then hold it to the same rules as every other adapter:

- every input in its fixtures gives the expected answer;
- unreadable input is a deny in the agent's own deny shape;
- `Render` blocks on a deny and only on a deny;
- no tool argument ever reaches the output;
- the capability row is consistent with the adapter, so an agent without provenance must have a valid unattested
  source.

The rest of this section describes the shared core:

- **Shared core.** Every adapter turns its agent's hook input into the same neutral `Call` and answers with ADR-0298's
  single `Decide`, against the same signed `regulait.endpoint-enforcement/1` policy.
- **Adapters.** They are `regulait-agent hook claude-code|cursor|copilot-cli|codex -policy FILE`. Each one only parses
  input and renders output.
- **No new decision logic.** There is no new policy language and no per-agent rule set.
- **What an adapter never reads.** It never decodes tool arguments. It never reads Cursor's stdio launch `command`,
  which can carry tokens.
- **Unreadable input.** For every agent it is a deny, written as both the agent's deny JSON and exit 2.

### 2. The per-agent capability matrix

Each adapter's `Capabilities` records what the vendor's documented contract allows enforcement to do:

- **`canBlock`**: the contract has a documented deny.
- **`mcpServer`**: how a call's server is identified: a documented `field`, the `tool-name` convention, or `none`.
- **`mcpProvenance`**: the input says where the server was defined.
- **`onError` and `onTimeout`**: what the agent does when the hook fails: `closed`, `closed-if-configured`, or `open`.
- **`execForm`**: the hook can be registered without a shell.
- **`managedLocation`**: the vendor documents an admin location that a user cannot override.

The matrix is part of the agent binary. `regulait-agent hook-capabilities` prints it as JSON, with each adapter's
contract, so the admin console and a customer's own review read the same claim the code is tested against. A row
changes only together with a new contract version.

The matrix as built (contract versions 2026-11-14 for Claude Code, 2026-11-15 for the rest):

| | Claude Code | Cursor | Copilot CLI | Codex |
|---|---|---|---|---|
| canBlock | yes | yes | yes | yes |
| mcpServer | field | field | **none** | tool-name |
| mcpProvenance | yes | **no** | **no** | **no** |
| onError | closed-if-configured | closed-if-configured | closed | **open** |
| onTimeout | closed-if-configured | closed-if-configured | **open** | **open** |
| execForm | yes | no | yes | no |
| managedLocation | yes | yes | yes | yes |
| **coverage** (§8) | enforce-grade | enforce-grade | **audit-grade** | **audit-grade** |
| **recommendedMode** (§8) | enforce | enforce | **audit** | enforce |
| **vendorControl** (§8) | none | none | GitHub MCP registry allow-list | `requirements.toml` server identity allow-list |

### 2a. Versioned contract fixtures

Fixtures live in `internal/enforce/testdata/hooks/<agent>/<contract-version>/`. Each directory holds one file per hook
input and a `cases.json` that maps each input and test policy (`enforce`, `audit` or none) to the expected answer.

The tests enforce four rules:

- every adapter has fixtures for its current version;
- every input is listed in `cases.json`;
- every version has at least one deny case and one no-policy case;
- every version directory, old ones included, keeps passing.

A changed vendor contract is a new directory and a bumped `Contract.Version`. Old directories are never edited, so a
change for a new agent version cannot silently break devices still on the old one.

### 2b. Per-agent coverage detail

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

Nothing registers any hook. The compiled keyring is still empty, and no device-policy key is pinned until an admin
pins one (§8, B4). A registered hook therefore denies MCP calls on every agent, which is ADR-0298's fail-closed default, and Copilot CLI's non-built-in tools are denied too. An
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

### 8. Owner decisions (2026-11-15)

The owner answered the questions this ADR left open on #864. These decisions are recorded here and pinned by
`TestOwnerDecisions`.

- **H1, Copilot CLI.** The recommended configuration is `audit` mode (`agentModes: {"copilot-cli": "audit"}`) plus
  GitHub's own MCP registry allow-list, until GitHub documents server identity in the hook input. The adapter carries
  `coverage: audit-grade`, `recommendedMode: audit`, and that allow-list as its `vendorControl`.
- **H2, Codex.** Codex is presented as **audit-grade** coverage, because its hook errors fail open. It is paired with
  Codex's `requirements.toml` `[mcp_servers.<name>] identity` allow-list. Its denies still block, so the recommended
  mode stays `enforce`.
- **The grading rule.** `enforce-grade` is a tested claim. It needs a contract that names the server and blocks when
  the hook fails. Anything else is `audit-grade` and must name the vendor control it is paired with.
- **H3, Cursor allow.** The Cursor adapter answers an allowed call with `{"permission":"allow"}`, and a deny still
  blocks (JSON and exit 2).
  - **Re-check of the docs.** cursor.com/docs/hooks was re-checked on 2026-11-15. It says responses merge across
    sources: `deny` beats `ask`, and `ask` beats `allow`. With `failClosed`, empty output blocks. It does **not** say
    whether a hook `allow` skips Cursor's own run confirmation.
  - **What we test.** The adapter's output is tested (`TestOwnerDecisions`). Cursor's behaviour cannot be tested in CI
    without a Cursor install.
  - **Manual check.** Run it against a real install before the coverage is shown to a customer: register the
    enterprise hook, allow a server that Cursor's own settings would ask about, and record whether Cursor still asks.
    Until that is recorded, the console says "not documented".
- **B4, one device-policy signer.** One rotatable device-policy signer on the control plane signs both the endpoint
  enforcement policy and the managed-browser policy, in this envelope (`keyId`, `payload`, `signature`, Ed25519). The
  signer is built by the browser lane in #867.
  - **Where the key lives.** Its key is operator-managed or install-generated, so it cannot be compiled into the agent.
    The admin pins its public keys in the agent's MDM-deployed, root-owned config as `devicePolicyKeys`: at most two,
    the current key and the next one, so a rotation never leaves a device unable to verify. That is how the browser
    extension pins the key in managed storage.
  - **How the hook verifies.** It uses the compiled keyring plus these pins. A pin never overrides a compiled key.
  - **What a bad config does.** A malformed pin refuses the whole config, and an unreadable config pins nothing. Either
    way, the hook keeps denying.
  - **Effect.** Pinning a key can only let a signed policy restrict the device further.

## Not in this slice

- **Version checks.** Refusing an uncertified agent version. Cursor sends `cursor_version`, and the adapter requires it to
  be present. Copilot CLI and Codex send no version in the hook input, so a version floor needs a different signal
  (tamper reporting can read the installed version).
- **Cursor cloud agents.** Their `preToolUse` with `MCP:<tool>` names runs off the device. That is not this agent's
  surface.
- **Decision audit, tamper reporting, policy content and delivery.** These remain ADR-0298 follow-ups.
- **Admin UI.** Choosing the per-agent mode and showing the capability matrix is a known UI gap tracked on #453.
- **Matrix to the gateway.** Reporting the device's adapters and contract versions in the agent's report, so the
  console shows what each device can enforce. This rides with the decision-audit follow-up.

## Consequences

- **Adding an agent.** It costs one data value, two small functions and a fixture directory. It never touches the
  policy or the decision.
- **Coverage.** Four coding agents now have an adapter behind one decision and one policy.
  - Claude Code and Cursor can enforce by server.
  - Codex can enforce by server name, but fails open on errors.
  - Copilot CLI can only audit usefully, until its contract improves.
- **The matrix is the claim.** The capability matrix in section 2 is what we tell a customer about each agent. Vendor
  contracts change fast, so each adapter file carries the date it was checked. A changed contract gets new fixtures,
  and an old fixture is never edited in place.

## Numbering

ADR 0330 is from the range reserved for builder lane E13 (0330 and 0331). The PENDING P1 row is updated in place.

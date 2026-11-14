# ADR-0298: On-device enforcement in the endpoint agent: hook adapters, signed policy, fail closed (P1, slice 1)

- **Status**: Proposed (slice 1 built, default off; owner direction 2026-11-07: a clean-room build in `agents/endpoint/`)
- **Date**: 2026-11-14
- **Index**: On-device enforcement: signed policy, hook adapters, fail closed (P1)
- **Builds on**: ADR-0195 (SD4 endpoint agent and its pending pack signer), ADR-0259 (MCP config discovery), ADR-0261
  (DefenseClaw ingest, the interim answer), ADR-0180 (secure by default), ADR-0176 (open source first).
- **Design reference only**: `internal/reviews/2026-11-07-defenseclaw-comparison.md`, option (c). No DefenseClaw code
  or source was read for this build. The work used only that report and each coding agent's public documentation.

## Context

PENDING §2b P1: endpoint coverage only discovers. Calls that go through the gateway are governed. Calls that bypass it, such
as a coding agent on a laptop running an MCP server the org never approved, are only discovered. The owner chose a
clean-room build inside the existing Go agent (2026-11-07), and asked for an ADR first.

The comparison report left one design question open: should the first slice target **agent hooks** (agent-specific) or
a **local egress proxy** (agent-agnostic)?

## Decision

### 1. Hooks first, one agent, one decision

Slice 1 is a hook adapter, not a proxy.

- **Why not a proxy first.** A local egress proxy that can see MCP and model traffic needs TLS interception: a local
  root CA on every device, certificate pinning breakage, and a privileged service. That is a large change to the
  agent's threat model, which today has no privileges and makes no network changes.
- **What a hook offers.** A hook is the agent's own documented extension point. It sees the exact tool call with its
  server provenance, and it needs no privileges.
- **What a hook cannot do.** It governs only agents that have a hook contract, at the versions that contract
  describes. The proxy (or the customer's `network` rung, IDE_INTEGRATION.md) remains the answer for everything else.
  It is recorded as a later slice that needs its own ADR.

The first agent is **Claude Code**. Its `PreToolUse` command hook is documented in detail (code.claude.com/docs/en/hooks,
checked 2026-11-14), including:

- the MCP server's definition **source** in the hook input (`mcp_server.source`, v2.1.274 or later);
- **exec-form** registration (`args`: no shell, so `BASH_ENV`-style variables cannot stop the hook);
- **`onFailure: "block"`** (v2.1.295 or later): a hook that cannot start, crashes or times out blocks the call;
- **`allowManagedHooksOnly`** in managed settings: a developer cannot add hooks that override the org's hooks.

The first decision is **MCP tool calls only**. A tool call runs when its server name is on the policy's allow-list
**and** its definition source is accepted. Deny beats allow. Trust is based on `mcp_server.source`, never on the
`mcp__<server>__` name prefix, as the contract advises. Other tools (Bash, Edit, ...) get no decision from us, so
Claude Code's own permission flow applies to them.

### 2. Policy is signed by the control plane and bounded in time

- **Format.** The policy (`regulait.endpoint-enforcement/1`) is a closed JSON document with these fields: `subject`
  (the user's pseudonym), `mode`, `issuedAt`, `notAfter`, and the MCP allow, deny and source lists. Unknown members
  are refused.
- **Signing.** It arrives in an envelope of key id, payload and Ed25519 signature, and is verified against a keyring
  compiled into the agent.
- **No signer yet.** The control-plane signer is the ADR-0195 SD4 pack signer, which is **pending (owner-blocked)**.
  The compiled keyring is therefore **empty**, and no policy verifies in this build. When SD4 lands, the envelope is
  aligned with its format and the key is pinned, in the same change that adds the config route serving the policy.
- **Honest offline mode.** A verified policy is used until `notAfter`, and not after. A policy issued in the future
  (beyond five minutes of skew) is refused. There is no "last known good forever".

### 3. Fail closed, with no local way to widen it

- **No valid policy.** If the hook is registered but no valid policy is present (missing, unverifiable, expired or
  malformed), every MCP tool call is **denied**.
- **Unreadable hook input.** An input that cannot be read, or an MCP-shaped tool name without `mcp_server` provenance
  (an older Claude Code), is also denied.
- **How a deny is sent.** A deny is written both ways: the documented JSON `permissionDecision: "deny"` and exit
  code 2. The reason shown never includes tool arguments, and `tool_input` is never decoded.
- **How an allow is sent.** An allow is sent as *no decision*, not as `"allow"`. Sending `"allow"` would skip the
  user's own permission prompt, and the org approving a server is not the user approving a call.
- **Modes.** The policy offers `audit` (decide, never block) and `enforce`. There is no fail-open mode and no
  environment variable or local file that widens one. This answers the DefenseClaw finding that its per-user installs
  fail open by default.

### 4. Off by default, twice over

- Nothing registers the hook. An admin opts in by deploying Claude Code **managed settings** through MDM. Those
  settings register `regulait-agent hook claude-code -policy <path>` in exec form, with matcher `mcp__.*`,
  `onFailure: "block"` and `allowManagedHooksOnly`.
- Even registered, it denies until the SD4 signer exists (section 2).

This is ADR-0180's secure default: the first time an admin turns it on, the strict behaviour is what they get.

### 5. Open-source search (ADR-0176)

- **OPA/Rego and CEL-Go (Apache-2.0).** Both pass the licence rule, but they are not needed. The slice 1 decision is
  closed-list membership, and a policy language would be a second policy surface beside the gateway's (one of the
  comparison's reasons against DefenseClaw).
- **DefenseClaw (Apache-2.0, with EPL/GPL parts in shipped artefacts per the report).** Rejected as an embedded
  component (report option (a)).
- **Ed25519 and JSON.** Both come from the Go standard library.
- **Dependencies.** None added.

## Not in slice 1 (recorded as follow-ups)

- **Audit.** Each decision recorded into the agent's report and the gateway audit chain, including audit-mode "would
  deny" results.
- **Tamper reporting.** A periodic check that the managed hook registration is present and unmodified (the
  comparison's "hook guardian" idea, reporting rather than restoring in the first version).
- **More agents.** Adapters for Cursor, GitHub Copilot CLI and Codex, each with its own documented contract and a
  version check that refuses an uncertified version.
- **Policy content.** The policy derived from the same per-user entitlements the gateway enforces, so device and
  server cannot disagree. Its delivery route waits for SD4.
- **Model hosts.** Blocking unapproved model hosts and steering tools to the gateway: the proxy slice, with its own
  ADR.

## Consequences

- The agent gains its first non-read-only behaviour, a hook that can block a tool call. It is inert unless an admin
  deploys the managed settings, and it fails closed if they do.
- Coverage is honest and narrow. Only Claude Code's MCP tool calls are covered, and only at versions that send
  `mcp_server` and honour `onFailure`. Everything else stays at the discovery and `network` rung.
- A developer with local admin rights can still remove managed settings from their own machine. That is the same
  limit as every `managed` rung (IDE_INTEGRATION.md), and tamper reporting is the follow-up that makes it visible.

## Numbering

ADR 0298 is from the range reserved for lane L10 (0298 to 0300). The PENDING P1 row is updated in place.

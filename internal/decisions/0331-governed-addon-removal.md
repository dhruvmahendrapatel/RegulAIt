# ADR-0331: Governed removal of flagged add-ons from endpoints (P1)

- **Status**: Proposed (built, off by default)
- **Date**: 2026-11-15
- **Index**: Governed removal of flagged add-ons (signed directive, admin-started, off by default)
- **Builds on**: ADR-0195 (the endpoint agent; decision 19, a read-only agent), ADR-0259 (MCP client-config discovery),
  ADR-0298 and ADR-0330 (on-device enforcement: the signed envelope, the keyring and the deny list), ADR-0180 (secure
  by default), ADR-0176 (open source first), ADR-0252 (merge-time numbering).

## Context

The owner decided on 2026-11-15 to allow removing flagged add-ons (skills, plugins, MCP servers) from employee machines,
with the instruction "strict". Today the endpoint agent only discovers what is installed (ADR-0195 decision 19), so an
admin who finds an unapproved MCP server on a laptop can block its calls (ADR-0298) but cannot take it off the machine.

## Decision

### 1. A narrow relaxation of ADR-0195 decision 19

The agent stays read-only for everything except one signed, typed directive: **remove one MCP server entry from one MCP
client config file**. That directive is the only write the agent makes outside its own state directory. Nothing else
changes in decision 19:

- no shell;
- no arbitrary paths;
- no file or directory deletion;
- no installs;
- no command channel.

The owner's 2026-11-15 decision is the recorded authority for this exception.

### 2. Off by default, at two levels

- **Org switch.** `discovery_settings.endpoint_addon_removal_enabled` is false by default. Turning it on is a
  `settings_relax` step-up (`DISCOVERY_STEP_UP_KEYS.endpointAddonRemoval`) through the existing
  `PUT /v1/discovery/settings`, and the change is audited. Turning it off is free. While it is off, no directive is
  created or delivered, pending ones included.
- **Signing key.** A directive is signed with the policy-signing key path of ADR-0298: the same Ed25519 `Envelope`,
  verified against the same compiled keyring (`enforce.CompiledKeyring`). That keyring is empty until the ADR-0195 SD4
  signer lands, so in this build no directive verifies. The gateway's directive route answers `503
  directive_signer_unavailable` while it has no signer, just as the config route answers `503
  collection_pack_unavailable`.

### 3. Always started by an admin, with step-up, audited in the same transaction

`POST /v1/discovery/endpoint-addon-removals` needs an admin and a step-up of kind `endpoint_remediation`, a new step-up
action kind. A grant of any other kind never authorises a removal, and an `endpoint_remediation` grant authorises nothing
else. Nothing creates a removal automatically: no finding, rule, schedule or AI decides one.

A removal names:

- **The asset version.** An MCP server identity (`identityKind` `package`, `host` or `command`, plus `identity`, exactly
  as ADR-0259's `mcpIdentityOf` derives it), with an optional `packageVersion` and an optional `serverName`. The kind
  `unknown` is refused.
- **The endpoints.** One of:
  - one device;
  - a selected list of devices (500 at most);
  - every device whose signed reports showed the server in the last N days (N from 1 to 90).
- **Whether to block a reinstall** (`blockReinstall`, default true; section 6).
- **A reason** (at most 500 characters).

The targets are resolved once, at creation, from `endpoint_mcp_servers` evidence. Each target keeps a point-in-time copy
of the config location it was seen in. Only user-writable roots are eligible: `home`, `appdata` and `localappdata`. A
server seen only under `system_applications` is never targeted. A removal that resolves to no endpoint is refused.

Three writes commit in one transaction, together with spending the step-up: the removal, its targets, and an audit row.
`POST …/:id/cancel` stops the removal's undelivered targets; cancelling narrows, so it needs no step-up, and it is
audited.

### 4. The directive

Each target becomes one directive, served by `GET /v1/endpoint-agent/directives` under the agent's own DPoP-bound token
(at most 20 per sync). The signed payload is closed JSON; the agent refuses any member it does not know:

```json
{
  "schema": "regulait.endpoint-directive/1",
  "directiveId": "<uuid v4: the target id>",
  "removalId": "<uuid>",
  "identityId": "<the agent's workload identity id>",
  "issuedAt": "<RFC 3339>",
  "notAfter": "<RFC 3339, at most 7 days after issuedAt>",
  "action": "remove_mcp_server",
  "asset": {
    "signatureId": "<the collection-manifest entry that discovered it>",
    "root": "home | appdata | localappdata",
    "path": "<the config path relative to the root, as reported>",
    "serverName": "<entry name>",
    "identityKind": "package | host | command",
    "identity": "<identity>",
    "packageVersion": "<optional>"
  }
}
```

**Before acting, the agent checks every one of these.** Any failure means it changes nothing:

- **Signature.** The envelope verifies under a pinned key.
- **Schema.** The schema and action are the ones above.
- **Identity binding.** `identityId` is this agent's own identity, so a directive cannot be moved to another endpoint.
- **Validity window.** `notAfter` is in the future, the window is at most 7 days, and `issuedAt` is no more than 5
  minutes in the future.
- **Replay.** `directiveId` is not already in the agent's local ledger. The ledger keeps each applied id, with its
  outcome, until that directive's `notAfter` has passed.
- **Manifest bounds.** The current, verified collection manifest has an `mcp_config` entry with that `signatureId`, and
  one of that entry's locators for this OS matches the root and path. The match uses the same glob code that discovered
  the file.

### 5. Applying a removal, and its limits

- **Which file.** The agent opens the file through the root's `os.Root`, so a symlink cannot escape the root. The file
  must be a regular file within the collection size bound.
- **Which formats.** It edits plain JSON only.
  - JSONC (comments or trailing commas) and TOML (Codex `config.toml`) are left untouched and reported as
    `failed / unsupported_format`.
  - Rewriting those formats would lose the developer's comments and formatting. For Codex, the stronger control is its
    own `requirements.toml` server allow-list (ADR-0330).
- **Which entry.** The agent removes the entry with exactly `serverName` under the server maps that ADR-0259's parser
  reads (`mcpServers`, `servers`, `mcp.servers`, `context_servers`, `projects.<p>.mcpServers`). It removes it only when
  the entry's identity, derived by the same describer, matches the directive's `identityKind`, `identity` and, if given,
  `packageVersion`. A same-named entry with another identity is left alone: `nothing_to_remove / identity_differs`.
- **How the file is written.** Every other byte of the file is preserved (`tidwall/sjson` deletes the key in place).
  The result must parse as JSON again before it is written. It goes to a temporary file in the same directory with the
  original's mode, then is renamed over the original.
- **What it never touches.** The coding agent itself, editor extensions, any file outside a manifest-located MCP config,
  and any entry other than the named server.

### 6. Paired with a block, so a reinstall is denied

With `blockReinstall` (the default), the removal's server identity is recorded as blocked. When ADR-0298's policy content
is derived from the gateway (a follow-up that waits for SD4), every active blocked identity contributes its server
name to the enforcement policy's `denyServers`. A reinstalled server's calls are then denied in every agent that can
identify the server (ADR-0330's capability matrix).

Until then the block is recorded, shown and audited, but nothing on the device enforces it. The ADR says so rather than
claiming coverage.

### 7. Outcome reporting and the developer's notice

- **Outcomes.** After applying, the agent posts its outcomes to `POST /v1/endpoint-agent/directive-outcomes` under its
  own token. Each outcome is one of:
  - `removed`, with code `removed`;
  - `nothing_to_remove`, with code `not_present` or `identity_differs`;
  - `failed`, with code `not_in_manifest`, `path_refused`, `unsupported_format`, `parse_failed`, `write_failed`,
    `expired` or `wrong_identity`.

  Each outcome also carries `notified` (true or false).
- **Gateway side.** An outcome is accepted only for a target of the calling device that was delivered, and it is final.
  Repeating the same outcome is idempotent; a different one is refused. The target update and its audit row are written
  in one transaction.
- **The notice.** On `removed`, the developer sees an on-device notification: "RegulAIt: your organisation's policy
  removed the MCP server "<serverName>" from <provider> (<path>)." The agent composes this text itself. No free text
  from the gateway reaches the device. The notice goes through the platform's own notifier, run as an argument list with
  no shell:
  - macOS: `osascript`, with the text passed as an `argv` item, never interpolated into the script;
  - Linux: `notify-send`;
  - Windows: `msg`.

  A missing notifier gives `notified: false`, and the removal stands.

### 8. Coverage per coding agent

Coverage follows the MCP hosts whose config files the signed collection manifest locates (ADR-0259):

- **Claude Desktop, Claude Code `~/.claude.json`, Cursor, Windsurf, Cline, Gemini CLI and VS Code `mcp.json`:** these
  are plain JSON, so they are covered.
- **VS Code `settings.json` and Zed:** usually JSONC, so they are reported as `unsupported_format`.
- **Codex `config.toml`:** TOML, so it is reported as `unsupported_format`.
- **Skills and plugins:** not covered in this slice. The collection manifest has no skill or plugin kind, and the gateway
  holds no per-device evidence of them. Without that evidence a removal could be scoped only by a path an admin types,
  which this ADR does not allow. They need a discovery kind first (a follow-up), and then the same directive gains an
  action.

### 9. Open-source search (ADR-0176)

- **Adopted.** `tidwall/sjson` (MIT, with `tidwall/gjson`, `match` and `pretty`, all MIT) removes a JSON key while
  leaving every other byte as it was. The agent already uses `tidwall/jsonc`. All four are pinned in `go.sum` and
  listed in `THIRD_PARTY.md`.
- **Rejected.** `gen2brain/beeep` (BSD-2) is a cross-platform notifier, but it pulls in `tadvi/systray`, last released
  in 2019, which fails the maintenance rule.
- **Our own code (narrow exception).** The three-command notifier is the platform tools, run without a shell. It
  exists because no maintained module meets the air-gapped, no-shell and maintenance requirements together. It is
  re-checked when the ecosystem changes.
- **From the standard library.** Ed25519 and `os.Root` path confinement.

## Not in this slice

- Skills and plugins (section 8).
- Enforcing `blockReinstall` on the device (section 6, waits for SD4 policy delivery).
- The admin screens for the switch, creating and cancelling removals and per-endpoint outcomes. These are known UI gaps
  tracked on #453.
- A gateway directive signer: the ADR-0195 SD4 key ceremony, which is pending.

## Consequences

- **Agent.** An org can, deliberately and visibly, take a flagged MCP server off its developers' machines. The agent's
  write power is exactly one key in one file the signed manifest already names, and only when a directive bound to that
  agent's identity verifies.
- **Gateway.** It gains one org switch, one step-up kind, two tables, three admin routes and two agent routes. Every
  write is audited.
- **Until SD4.** The whole path is inert: no key, no verified directive.

## Numbering

ADR 0331 is from the range reserved for builder lane E13 (0330 and 0331).

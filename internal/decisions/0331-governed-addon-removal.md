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
  verified against the same keyring. Under owner decision B4 (2026-11-15), that path is one rotatable device-policy
  signer that signs the endpoint policy, the browser policy and these directives. The agent verifies it against the
  compiled keyring plus the device-policy keys an admin pins in the agent config (ADR-0330, section 8). The
  gateway's signer interface is wired to that shared signer when it lands (#867). The compiled keyring is empty until the ADR-0195
  SD4 signer lands, so a directive verifies only on a device whose admin has pinned a device-policy key. The gateway's directive route answers `503
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
- **The approver** (`approverUserId`): a second administrator (section 3a).
- **A reason** (at most 500 characters).

The targets are resolved from `endpoint_mcp_servers` evidence. Each target keeps a point-in-time copy of the config
location it was seen in. Only user-writable roots are eligible: `home`, `appdata` and `localappdata`. A server seen only
under `system_applications` is never targeted. A removal that resolves to no endpoint is refused. A device or devices
scope is stored as a join table (`endpoint_addon_removal_devices`), so the approval can resolve it again.

The request commits in one transaction, together with spending the step-up: the removal (`awaiting_approval`), its
ADR-0186 approval, its scope devices and an audit row (`require_approval`). No target is written yet.
`POST …/:id/cancel` cancels a removal that awaits its decision (its approval is withdrawn) or an active one. It stops
only targets that were never delivered: a delivered directive may already have run on the device, so the target stays
`delivered` and the device's real outcome is still recorded. Cancelling narrows, so it needs no step-up, and it is
audited.

### 3a. A second administrator approves it, and the execution dial can stop it (review of #871, 2026-11-18)

- **Second person (ADR-0186).** A request queues an approval of kind `endpoint_addon_removal` for the named approver.
  The approver must be another active administrator in the approval pool (`loadApprovalPool`: never the requester, never
  anyone delegation-linked to the requester). The decision goes through the one decide path
  (`POST /v1/approvals/:id/decide`): the requester is refused by name (`cannot_approve_own_endpoint_addon_removal`), an
  admin outside the pool is refused (`not_in_approval_pool`, no admin override), and the decider needs an
  `approval_decide` step-up bound to `{approvalId, decision, argumentsDigest}`, spent in the decision's transaction.
  Bulk and ChatOps decisions of this kind are refused, because they carry no step-up.
- **What is approved is what is sent.** The approval's `argumentsDigest` covers the canonical request and every config
  entry it resolved to. On approval the targets are resolved again: only when they give the same digest are they
  written and the removal becomes `active`. If the endpoints changed, or the switch was turned off, the removal becomes
  `stale`, nothing is sent, and a new request is needed. This also closes the gap that the requester's step-up binds the
  request, not what it resolves to. The approval expires with the removal (seven days).
- **Kill switch.** Signing a directive is a classified external write, `device_policy.sign_payload`: the
  `DirectiveSigner` (`apps/gateway/src/directive-signer.ts`) is a contract in `external-effects.test.ts`, and every signature is the direct body of
  `runExternalWrite`, which re-reads the execution mode immediately before it. Outside `normal`, no removal is requested
  or approved, and the agent's directive read serves an empty list (audited as `execution_halted`, `execution_read_only`
  or `execution_requires_approval`). A halt cancels nothing: the targets wait, undelivered (execution control principle 4,
  "nothing is destroyed"). The barrier matrix has a row for the operation.
- **Row-level security (ADR-0234).** The three removal tables have RLS ENABLED and FORCED, with one policy each: an
  admin principal, or the `system_task` reason. The agent's two routes enter `system_task` for their one read and one
  outcome write, and every query in them is scoped to the calling agent's own identity.

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

### 4a. The agent's one read of its flagged assets (owner answer I2, 2026-11-15)

The owner's answer is that the agent reads its device's flagged-asset list through one narrow, audited read that is
limited to that device. This is its exact form:

- **There is exactly one read.** `GET /v1/endpoint-agent/directives` is the only route through which an agent learns
  anything about removals or flagged assets. No other agent-side read of removals, targets or flags exists.
- **It covers only the calling device.** The device comes from the caller's own DPoP-bound agent token (`agentOf`).
  Nothing in the query or body selects a device, so an agent cannot ask about another device, and a stolen token reveals
  only its own device's list.
- **It returns only that device's undelivered, unexpired, uncancelled targets** (at most 20), each as a signed
  directive. A flag that has no removal attached is never sent: the agent learns of an asset only when an admin has
  decided to remove it.
- **Every call is audited, empty results included.** Each read writes one audit row with fixed fields only:
  - `deviceId` and `identityId`;
  - `served`, the number of directives returned, and their target ids;
  - `outcome`: one of `served`, `none`, `switch_off` or `signer_unavailable`.

  The row never carries asset names or paths, so the audit trail shows who looked, when and how much, without
  duplicating the evidence.

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
identify the server (the capability matrix in ADR-0330).

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
- **The lifecycles (ADR-0348).** Both are declared machines in `packages/shared/src/state-machines.ts`, registered in
  `STATE_MACHINES`. The removal, `ENDPOINT_ADDON_REMOVAL_MACHINE`:

  | Event | From | To |
  |---|---|---|
  | `approve` | `awaiting_approval` | `active` |
  | `deny` | `awaiting_approval` | `denied` |
  | `go_stale` | `awaiting_approval` | `stale` |
  | `cancel` | `awaiting_approval`, `active` | `cancelled` |

  The target, `ENDPOINT_ADDON_TARGET_MACHINE`:

  | Event | From | To |
  |---|---|---|
  | `deliver` | `pending` | `delivered` (served to the agent) |
  | `report_removed`, `report_nothing`, `report_failed` | `delivered` | `removed`, `nothing_to_remove`, `failed` |
  | `cancel` | `pending` | `cancelled` |

  Every status write guards with `whereFrom(…, event)`, so each move is atomic and no route decides a transition by
  itself. Each column has exactly one CHECK listing its states, and the ADR-0348 test holds it equal to the machine.
- **Gateway side.** An outcome is accepted only for a target of the calling device that was delivered, and it is final.
  Repeating the same outcome is idempotent; a different one is refused. The target update and its audit row are written
  in one transaction.
- **The notice.** On `removed`, the developer sees an on-device notification: "RegulAIt: your organisation's policy
  removed the MCP server "<serverName>" from <provider> (<path>)." The agent composes this text itself. No free text
  from the gateway reaches the device. The notice goes through the platform's own notifier, run as an argument list with
  no shell:
  - macOS: `osascript`, with the text passed as an `argv` item, never interpolated into the script;
  - Linux: `/usr/bin/notify-send`;
  - Windows: `msg.exe` under `SystemRoot` (when it is a plain drive path, else `C:\Windows`).

  Every tool is named by its absolute path, never found through `PATH`. A rewritten config keeps its mode and, on Unix,
  its owner and group.

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
- **Compared for the JSON edit** (re-checked 2026-11-17):
  - `tidwall/sjson` (MIT, tagged releases, the latest on 2026-11-09): deletes one key in place and keeps every other
    byte. Adopted at v1.2.5, the newest release more than two weeks old when it was pinned.
  - `tailscale/hujson` (BSD-3, maintained, the latest commit 2026-07-27): can also edit JSONC (comments, trailing
    commas), but it publishes no tagged release, only commit pseudo-versions. It is the candidate for the JSONC
    follow-up, which must first check it against the release rule.
  - `encoding/json` decode and re-encode (standard library): loses key order, spacing and number formatting, so a
    developer's file would be rewritten. Rejected.
- **Compared for the notice:** `gen2brain/beeep` (BSD-2) is a cross-platform notifier, but even its 2026-11-13 release
  (v0.12.0) still pulls in `tadvi/systray`, last released in 2019, which fails the maintenance rule. Rejected in favour
  of the platform tools (below).
- **Compared for the lifecycle:** `xstate` (MIT, maintained) is a full state-machine library. Six states and three
  moves, each enforced as a SQL guard, do not need it, and it would add a runtime dependency to the gateway for one
  table. A declared, typed table was chosen.
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
- **Restoring a removed entry (decision, review of #871).** The removed entry's JSON is not kept, so a removal cannot be
  undone by RegulAIt in this slice. A removal is already narrow (one named entry, one plain-JSON file), approved by a
  second person, and the developer is told what was removed and from where, so they or their admin can add it back. A
  backup in the agent's state directory and a signed restore directive are a follow-up, filed as an issue.

## Addendum (slice 3, 2026-11-20): the shared device-policy key signs directives

Lane E13 adopts the ADR-0334 device-policy signer (owner decision B4) and closes #1033.

- **The signer.** With no injected signer (the production wiring), the directive route resolves the shared
  device-policy key (`resolveDevicePolicySigner`) for every read and adapts it (`devicePolicyDirectiveSigner`,
  `directive-signer.ts`). A rotation of the active key applies to the next read. No key, or a key file that does not
  parse, answers `503 directive_signer_unavailable`, and nothing is served. The key is never created here: it is the
  operator's key file or the install key created when browser governance is turned on (ADR-0334 §4). The list read
  reports `signerConfigured` and `signerKeyId`, so an admin knows which key a device must pin (`devicePolicyKeys`,
  ADR-0330 §8). buildApp's code-only seam can still inject a signer, or `null` for none.
- **Domain separation.** A directive's signature is over `regulait.endpoint-directive/1` and a NUL byte, then the
  payload bytes (`DIRECTIVE_SIGNATURE_DOMAIN`; the agent's `directive.SignatureDomain` and
  `enforce.VerifyEnvelopeInDomain`). Policies stay signed over the bare JSON, which starts with `{`, so a directive's
  signature never verifies as a policy and a policy's never verifies as a directive, under the one key. The envelope
  and the golden payload are unchanged. No directive was ever signed before this change, so nothing is re-signed.
- **Idempotency key.** `POST /v1/discovery/endpoint-addon-removals` accepts an optional `Idempotency-Key` (the shared
  ADR-0179 store, scope `endpoint-addon-removal`). A retry with the same key and body replays the first removal (200,
  `Idempotent-Replay: true`) without spending a grant or queueing a second approval; the same key with another body is
  `422 idempotency_key_reused`. A refusal rolls the claim back, so the key can be used again once the cause is fixed.
  The stored claim keeps only the removal id and the two counts, never request text.
- **Open source first (ADR-0176).** Nothing new: Node's and Go's Ed25519 and the repository's idempotency store.

## Consequences

- **Agent.** An org can, deliberately and visibly, take a flagged MCP server off its developers' machines. The agent's
  write power is exactly one key in one file the signed manifest already names, and only when a directive bound to that
  agent's identity verifies.
- **Gateway.** It gains one org switch, one step-up kind, one approval kind, one external-write operation, three tables,
  two declared machines, four admin routes and two agent routes. Every write is audited.
- **Until a key is pinned.** The whole path is inert unless the gateway has a device-policy key (slice 3) and an admin
  pins it on the device: until both exist, no directive is delivered or verified.

## Numbering

ADR 0331 is from the range reserved for builder lane E13 (0330 and 0331).

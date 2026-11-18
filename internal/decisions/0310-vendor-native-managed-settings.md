# ADR-0310: Compile RegulAIt policy into vendor-native managed settings (the "Managed" rung)

- **Status**: Accepted (lane E1 brief, 2026-11-15; gap G2 of `internal/product/MARKET_ANALYSIS_2026-11.md` §3, PR #844)
- **Date**: 2026-11-15
- **Index**: **Vendor-native managed settings (G2): a user's or role's effective MCP entitlements compiled into Claude Code and GitHub Copilot `managed-settings.json`, an OpenAI Codex `requirements.toml` and a Cursor dashboard worksheet. Every entitled server is named by its gateway URL; nothing entitled means an explicit deny-all. Exported as a signed (Ed25519), versioned tar.gz for MDM push; refused when there is no signing key or public URL. Drift (slice 2): an enabled server in a managed vendor's MCP config on an enrolled device whose identity is not this gateway, from ADR-0259's inventory.**
- **Built in**: lane E1. Slice 1: compiler, signed bundles, API. Slice 2: drift detection against ADR-0259 (`GET /v1/managed-settings/drift`).
- **Migration**: `pending/managed_settings_bundles.sql` (numbered at merge, ADR-0252)
- **Related**: ADR-0259 (endpoint MCP config discovery), ADR-0298 (on-device hooks; a different mechanism),
  ADR-0236 (MCP bundles), ADR-0041 / `export-bundle.ts` (the export signing key), ADR-0176, ADR-0180, ADR-0200

## Context

ROADMAP's interception ladder has a **Managed** rung ("admin pushes IDE policy / managed settings / MDM env vars")
that was not built. `docs/product/IDE_INTEGRATION.md` already tells admins to write a Copilot allowlist that names only
`BASE/mcp/*`, but they had to write it by hand and keep it in step with pillar 1. Every coding-agent vendor now ships
an admin-enforced managed-settings format. RegulAIt holds the source of truth for who may use which MCP server and
tool, so it should produce these files.

ADR-0298 is a different mechanism. Its on-device hook decides each call on the device. This ADR compiles the vendors'
own allowlists, which the vendors' clients enforce.

## Vendor schemas (primary documentation, checked 2026-11-15)

| Vendor | File (delivery) | Keys used | Semantics that matter |
|---|---|---|---|
| Claude Code | `managed-settings.json`. macOS `/Library/Application Support/ClaudeCode/`, Linux `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`. MDM: plist `com.anthropic.claudecode`; `HKLM\SOFTWARE\Policies\ClaudeCode` value `Settings`. code.claude.com/docs/en/managed-settings, /managed-mcp, /settings, /permissions | `allowedMcpServers` / `deniedMcpServers` (`{serverUrl}`), `allowManagedMcpServersOnly`, `permissions.disableBypassPermissionsMode`, `requiredMinimumVersion` | Unset = allow all; `[]` = none. Deny is evaluated first. Without `allowManagedMcpServersOnly`, user allowlists merge and can widen the list. An unparseable admin document stops startup. |
| GitHub Copilot | `managed-settings.json`: `.github-private` `copilot/managed-settings.json`, or file (macOS `/Library/Application Support/GitHubCopilot/`, Linux `/etc/github-copilot/`, Windows `%ProgramFiles%\GitHubCopilot\`), or MDM. docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings; …/manage-mcp-usage/configure-enterprise-allowlist | `allowedMcpServers` / `deniedMcpServers` (`{serverUrl}`), `permissions.disableBypassPermissionsMode` | The allowlist is intersected across sources and the denylist is a union. `[]` blocks everything but built-ins. There is no MCP per-tool selector. Servers in custom agent profiles are not covered. |
| OpenAI Codex | `requirements.toml`: `/etc/codex/requirements.toml`, `%ProgramData%\OpenAI\Codex\requirements.toml`, macOS MDM `com.openai.codex` `requirements_toml_base64`. learn.chatgpt.com/docs/enterprise/managed-configuration (developers.openai.com/codex redirects there) | `[mcp_servers.<id>] identity = { url = … }` | The id and the identity must both match. An empty `mcp_servers` table disables MCP; an omitted one imposes no limit. There is no enforced per-tool allowlist and no minimum-version key (UNVERIFIED that none exists). |
| Cursor | No file. The team dashboard's "MCP Configuration" (Enterprise) is the only place the allowlist is set; the Admin API has no MCP endpoint. cursor.com/docs/enterprise/model-and-integration-management; /docs/account/teams/admin-api | n/a | `permissions.json` `mcpAllowlist` controls auto-run only, so it widens rather than narrows, and is not emitted. |

## Decision

1. **Pillar 1 stays the source of truth.** `loadEffectiveMcpPolicy` resolves a subject's servers with the kernel's
   `visibleTools`, the same filter `tools/list` applies. It covers every enabled server whose admission and
   release-age state do not hide its tools, and only un-halted tools. A server goes in when at least one tool is
   visible. A **user** gets direct, role and bundle grants minus revocations. A disabled user gets nothing. A **role** gets the role's own tool and server grants plus the ADR-0236 MCP bundles granted to the
   role, while `org_settings.mcp_bundles_enabled` is on (owner decision M1, below). That is the baseline every holder
   receives through the role, and the same set the gateway already allows them. Teams reach users through ADR-0236
   bundles and are covered by the user compile.
2. **Name the gateway, never the upstream.** Each entitled server is written as `<REGULAIT_PUBLIC_URL>/mcp/<server id>`.
   The vendor client admits only the governed endpoint, and the gateway still decides every tool call. A bundle
   therefore cannot widen what the gateway allows. Per-tool lists appear only where a vendor can show them (the
   Cursor worksheet). They are informational, because the gateway's per-call decision is the enforcement.
3. **Default-deny maps to deny-all, explicitly.** Nothing entitled becomes `allowedMcpServers: []` (Claude Code,
   Copilot) or an empty `[mcp_servers]` table (Codex). An absent key is never emitted, because every vendor reads
   absent as "allow all". Claude Code also gets `allowManagedMcpServersOnly: true` so user scopes cannot widen the
   list. Both JSON formats get `disableBypassPermissionsMode: "disable"`. `requiredMinimumVersion` is pinned only when
   the admin asks for it (`x.y.z`).
4. **The compiler refuses unsafe URLs.** A gateway URL must be https (plain http only on loopback, for local
   development) and must carry no credentials, query or fragment.
5. **Signed, versioned bundles.** `POST /v1/managed-settings/bundles` compiles, signs and stores a bundle. It is
   admin-only by the app default and audited (`managed-settings-bundle-exported`). The manifest lists each file's
   sha256 and bytes, the policy digest, the signing key id and fingerprint, and the install paths above. It is signed
   Ed25519 with the export signing key (`REGULAIT_EXPORT_SIGNING_KEY` / `_ID`). If no key is configured the export
   is **refused** (409), never left unsigned. If `REGULAIT_PUBLIC_URL` is unset it is refused too. A new version is
   written only when the policy digest (policy plus options) changes. Versions are serialised per subject with an
   advisory lock, and the time comes from the database clock. The archive (`GET …/:id/archive`) is a deterministic
   tar.gz (`manifest.json`, `manifest.json.sig`, the vendor files), byte-identical on every download.
6. **Storage.** `managed_settings_bundles` holds the signed manifest bytes, the signature and the subject as a foreign
   key (user or role, CHECK exactly one). `managed_settings_bundle_files` holds each compiled file. Both are deliberate
   snapshot exceptions to third normal form, commented on the table. Drift is measured against what was exported, not
   against today's grants.
7. **Open source first (ADR-0176).** `smol-toml` 1.9.1 renders the TOML. It was already pinned in `@regulait/shared`,
   is **BSD-3-Clause** (the market analysis said MIT, which is wrong) and needs no network. JSON is native. The tar.gz
   reuses `export-bundle.ts`'s deterministic writer. No vendor SDK or library generates these formats.
8. **Drift (slice 2).** `GET /v1/managed-settings/drift` (admin-only, keyset-paginated, at most 200 a page, filters
   `deviceId` and `vendor`) reads ADR-0259's `endpoint_mcp_servers` inventory. A row is **drift** when all hold:
   - it is not disabled (a disabled server is not loaded);
   - its config file is one a managed vendor reads (`MANAGED_VENDOR_CONFIG_PATHS` in `@regulait/shared`: Claude Code
     `.claude.json`, `.mcp.json`, `.claude/settings.json`; Copilot `Code/User/mcp.json`, `Code/User/settings.json`,
     `.vscode/mcp.json`; Codex `.codex/config.toml`; Cursor `.cursor/mcp.json`). Another host app's config (Claude
     Desktop, Windsurf, Zed) is not under any bundle, so it stays ADR-0259's registry diff, not drift;
   - it is not this gateway: a remote (`http`/`sse`) server whose reported host equals `REGULAIT_PUBLIC_URL`'s host,
     case-insensitively, with an explicit default port matching its absence, is managed. The device reports a host and
     never a path (ADR-0259), so the comparison is per host, not per `/mcp/<serverId>` URL.

   Each bundle names only gateway URLs and sets the vendor's managed-only switch, so a drift row means the bundle is not
   applied on that device or the client does not enforce it. The response carries the newest bundle, a summary
   (drift rows and distinct devices under the same filters) and, per row, `reportedAfterLatestExport`, so an admin can
   tell a device that has not reported since the last export from one that reported and still drifts.
   **Coverage (#902 review).** The endpoint agent reads only the files the enabled catalogue names (its
   `assistant_config` rows), and a directory row such as the seed's `.codex` does not cover `.codex/config.toml`.
   The response therefore carries a per-vendor `coverage` entry (`collected`, `partial` or `not_collected`, with the
   collected and missing paths). A `not_collected` vendor's `driftServers` is `null` (unknown), never `0`, and
   `summary.complete` is false with a `coverageNote` naming the vendors that are not fully measured (ADR-0180: an
   unmeasured control must not read as a clean one). On the shipped seed, Copilot and Codex are not collected until
   their catalogue rows are added (PENDING).
   **Collection switch (#902 review [3]).** A catalogue path is only collection capability. The agent collects
   MCP configs only while ADR-0259's org switch (`endpoint_mcp_config_enabled`, default off) is on, and the gateway
   refuses such facts while it is off. With the switch off, every vendor is reported `not_collected` (its
   `catalogueStatus` still shows what the catalogue could collect), every drift count is `null`, `collectionEnabled`
   and `summary.complete` are false, and the note says that any listed rows are historical evidence, not a current
   measurement.
   **Refusals (secure by default):** 409 `public_url_unset` with no public URL (the managed host is unknown), and 409
   `no_bundle_exported` before any bundle exists, since nothing is managed yet and listing every server as drift would
   be noise. Devices are pseudonymous (ADR-0195), so drift is per device and identity, never per named user; devices
   are not mapped to bundle subjects. **Open source first:** no library compares MCP client configs with an allowlist;
   the comparison is a set check over rows ADR-0259 already stores, with no new table or migration.
9. **Effective policy reuses the gateway's loaders (#850 review).** The user path calls `visibleMcpToolNamesByServer`
   (`builder-access.ts`, the same admission, entitlement and `visibleTools` loop as `entitledMcpToolIds`). The role
   path calls `loadRoleEntitlements`, built on the `loadRoleGrants` that `loadEntitlements` itself uses. A filter added
   to either loader therefore narrows the compiled file too. Reserved `mcp:` protocol names are dropped, as `tools/list`
   drops them, and a gateway URL containing `*` is refused (vendors read it as a wildcard).
10. **Row-level security.** Both tables are under ENABLE and FORCE ROW LEVEL SECURITY with ADR-0234's admin-only
   policy: an active admin principal or the `migration` reason. A plain `regulait_app` connection, a non-admin
   principal, or another system reason reads and writes nothing (pinned by a test).
11. **Route census.** The three routes (four with slice 2's drift route) have no screen yet. Under the lane E1 brief (rule 3: new routes go into the
   census with a `KNOWN_UI_GAPS` entry on #453), each has a `KNOWN_UI_GAPS` entry, and `KNOWN_UI_GAPS_MAX` rises by
   exactly 3 over main (63 + 3 = **66** after ADR-0332's, ADR-0230 A2's, lane L7's and ADR-0327's routes landed on main); slice 2 adds the drift route, so **67** (then **73** on main 9e818071, which had 72 after ADR-0241's seven routes gained their screen). The ratchet falls again when the #453 screen lands.

## Owner decision

- **M1 (owner, 2026-11-15, relayed by the master on #850):** a role's compiled bundle **includes** the ADR-0236 MCP
  bundles granted to that role, matching what the gateway already allows a holder of the role. It is built on the same
  query as the user path (`loadRoleBundleToolGrants`, beside `loadBundleToolGrants` in `entitlements.ts`), so the
  bundles switch, the current version, archived bundles and the fail-closed inventory join all behave the same way.
  The owner also asked for the long-term build, with reuse and open source first. The VS Code device policy remains a
  PENDING item until its encodings are confirmed.

## Not done, recorded

- **VS Code device policy** (`ChatMCP`, `ChatAllowedMcpServers`, `/etc/vscode/policy.json`). The value encodings are
  documented only partly, so no file is emitted.
- **Claude Code `managedMcpServers` / `managed-mcp.json`**, which would push the servers as well as allow them. Doing
  that needs the client auth header shape for RegulAIt keys on each vendor. It is a follow-up.
- **Per-tool vendor rules** (`permissions.deny: ["mcp__<server>__<tool>"]` in Claude Code). These depend on the
  user's local server label, which RegulAIt does not control until it pushes the servers itself.
- **Push.** RegulAIt produces the bundle. MDM, the `.github-private` repository or the Codex admin console delivers
  it. An MCP client that ignores managed settings is not governed by this rung; that is the `network` rung.

## Addendum (2026-11-18): endpoint decision audit and tamper reporting (lane E1, no new ADR)

The ADR-0298/0330/0350 hook decided on the device and told nobody. The master approved this slice as an addendum on
2026-11-18. Restore of a changed file is a later step and needs admin approval. It is not built here.

1. **One decision-event interface.** Every on-device rule set emits the same event: the MCP rules (ADR-0330), the
   command, file and package rules (ADR-0350, lane E31), and any later one. There is no second audit path.
   - The emitter names itself in `decision.emitter` (`mcp-rules`, `command-rules`, …).
   - The Go type is `decisionlog.Event`, and `decisionlog.Emitter` is the interface. The spool implements it.
   - The gateway twin is `decisionBatchSchema` in `apps/gateway/src/endpoint-decisions.ts`.
   - A fixture shared by both sides pins the bytes: `agents/endpoint/internal/contract/testdata/decisions-batch.json`.
2. **What an event carries.**
   - It carries: the agent, the verdict actually returned (`allow`, `deny` or `ask`, or `none` for an audit-mode
     would-deny or would-ask), the mode (`audit`, `enforce` or `no_policy`), the action kind, the rule id, and the
     permission mode.
   - The session is a device-keyed HMAC of the vendor's session id.
   - It never carries a tool argument, command, path, prompt or the raw session id. The schema is strict, and the
     agent's pseudonymity guard checks the bytes first.
   - A plain no-decision is not an event. A coding session is still recorded once per (agent, session, mode), so a
     bypass session shows up even with no governed call.
3. **Spool, then a signed batch.**
   - The hook writes each event to a per-user spool (one file per event, 0600, at most 10 000, with drops counted).
     It never sends anything. A spool error never changes the decision.
   - The agent's run loop uploads batches of up to 500 events to `POST /v1/endpoint-agent/decisions`. A batch is
     persisted before it is sent, so a retry resends the same batch id.
4. **Verification.** The route uses the reports channel unchanged.
   - Authentication: the DPoP-bound endpoint-agent token and an RFC 9530 `Content-Digest`.
   - Signature: `Regulait-Decisions-Signature`, an ES256 JWS by the device key, typ `regulait-endpoint-decisions+jwt`,
     binding the digest, the batch id and the URL.
   - Replay and duplicates: one use per signature (the replay store), and one copy per batch id
     (`endpoint_decision_batches`).
   - Stale events (over 7 days) and future events (over 5 min) are counted as refused and are not audited.
   - Every refusal is audited with a fixed code.
5. **The audit.**
   - Each decision is one hash-chained `audit_log` row (`objectType` `endpoint_device`, `objectId` the device), with
     these rule ids:

     | Decision | Rule id | Effect |
     |---|---|---|
     | allow | `endpoint-hook-allow` | allow |
     | deny | `endpoint-hook-deny` | deny |
     | ask | `endpoint-hook-ask` | `require_approval` |
     | audit-mode would-deny or would-ask | `endpoint-hook-would-deny` / `-would-ask` | allow |

   - Other rows: one `endpoint-decision-batch-accepted` summary per batch, and findings
     `endpoint-permission-bypass-session` (once per session) and `endpoint-managed-file-changed`.
   - `audit_log` is the source of truth. `endpoint_coding_sessions` counters are a read model, commented as such.
6. **Permission-bypass sessions** (`GET /v1/endpoint-decisions/sessions`, admin, keyset-paginated).
   - Claude Code and Codex put `permission_mode` in every hook input, and `bypassPermissions` is
     `--dangerously-skip-permissions` / `--yolo` (both vendors' hook docs, checked 2026-11-18).
   - Each mode a session reported is a row (`endpoint_coding_session_modes`).
   - Cursor and Copilot CLI do not report a mode. Their sessions show `permissionBypass: null` and a coverage note,
     never "not bypassed" (ADR-0180).
   - The managed hook still decides a bypass session's governed calls. Bypass skips the vendor's own prompts, not the
     hook.
7. **Tamper reporting** (`GET /v1/endpoint-decisions/tamper`, admin, keyset-paginated). Each cycle the agent reports
   each managed file: Claude Code `managed-settings.json`, Cursor `hooks.json`, the Copilot CLI policy file and Codex
   `requirements.toml`.
   - It reports the file's state (present, missing, unreadable, or not system-owned), its SHA-256, and the status of
     the RegulAIt hook: `registered`, `weakened` (no fail-closed or managed-only setting), `absent` or `unparseable`.
   - Each distinct state is a row (`endpoint_managed_file_observations`), so a second state is a change, audited once.
   - The view also shows whether the bytes match an exported bundle file (Claude Code and Codex are delivered as files).
     Bundles do not yet carry the hook registration, so a hand-merged file shows `bundleMatch: "none"` honestly.
   - A file never present on a device is "vendor not deployed", not tamper.
8. **Row-level security.** All four tables have RLS forced. The agent route (`credential_request`) is the only writer,
   and the views are admin-only.

**Open-source comparison (owner rule 9).**
- Signed upload. Considered (a) the existing compact JWS plus RFC 9530 digest through `jose` (MIT, already pinned,
  reviewed under SD4b), (b) RFC 9421 HTTP Message Signatures (`http-message-signatures`, MIT), and (c) DSSE envelopes
  (sigstore). Chose (a): (b) and (c) add a second signing scheme and dependency for the same guarantee.
- Spool. Considered (a) one file per event with the standard library (tmp + rename), (b) `bbolt` (MIT), and (c)
  SQLite. Chose (a): concurrent hook processes need no lock, and (b) and (c) serialise every hook call on a file lock.

**Limits, recorded.**
- A device user can delete their own unsent spool. Drops the agent sees are counted; deletions are not.
- A device that stops reporting shows its last state.
- Bundles do not compile the hook registration. Emitting it, so the bundle hash is the tamper baseline, is a follow-up.

## Consequences

The Managed rung exists and follows pillar 1. Re-exporting after a grant change gives a new version, and an unchanged
policy keeps its version, so MDM sees a change only when there is one. A developer can still remove the managed file
on an unmanaged device. ROADMAP's "developer can undo locally" stands, and drift detection (slice 2, `GET /v1/managed-settings/drift`) is how an
admin sees it, from the next endpoint report.

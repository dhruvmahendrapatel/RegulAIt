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
   exactly 3 over main (63 + 3 = **66** after ADR-0332's, ADR-0230 A2's, lane L7's and ADR-0327's routes landed on main); slice 2 adds the drift route, so **67**. The ratchet falls again when the #453 screen lands.

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

## Consequences

The Managed rung exists and follows pillar 1. Re-exporting after a grant change gives a new version, and an unchanged
policy keeps its version, so MDM sees a change only when there is one. A developer can still remove the managed file
on an unmanaged device. ROADMAP's "developer can undo locally" stands, and drift detection (slice 2, `GET /v1/managed-settings/drift`) is how an
admin sees it, from the next endpoint report.

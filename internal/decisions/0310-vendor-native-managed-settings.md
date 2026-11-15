# ADR-0310: Compile RegulAIt policy into vendor-native managed settings (the "Managed" rung)

- **Status**: Accepted (lane E1 brief, 2026-11-15; gap G2 of `internal/product/MARKET_ANALYSIS_2026-11.md` §3, PR #844)
- **Date**: 2026-11-15
- **Index**: **Vendor-native managed settings (G2): a user's or role's effective MCP entitlements compiled into Claude Code and GitHub Copilot `managed-settings.json`, an OpenAI Codex `requirements.toml` and a Cursor dashboard worksheet. Every entitled server is named by its gateway URL; nothing entitled means an explicit deny-all. Exported as a signed (Ed25519), versioned tar.gz for MDM push; refused when there is no signing key or public URL.** Drift against ADR-0259 discovery follows in slice 2.
- **Built in**: lane E1. Slice 1: compiler, signed bundles, API. Slice 2: drift detection against ADR-0259.
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
   visible. A **user** gets direct, role and bundle grants minus revocations. A disabled user gets nothing. A **role**
   gets the role's own grants, the baseline every holder receives. Teams reach users through ADR-0236 bundles and are
   covered by the user compile.
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
8. **Drift (slice 2).** ADR-0259's `endpoint_mcp_servers` rows will be compared with the latest bundles. A configured
   server whose identity is not an exported gateway URL is drift. Devices are pseudonymous, so drift is reported per
   device and identity, not per named user.

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
on an unmanaged device. ROADMAP's "developer can undo locally" stands, and drift detection (slice 2) is how an admin
sees it.

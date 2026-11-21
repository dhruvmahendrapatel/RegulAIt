<!-- fold: state-recap -->
**2026-11-15 - G2 slice 1: vendor-native managed settings ([ADR-0310](../decisions/0310-vendor-native-managed-settings.md), lane E1, branch `builder/e1-managed-settings`).**
A user's or role's effective MCP entitlements (kernel `visibleTools`) compile to Claude Code and GitHub Copilot
`managed-settings.json`, an OpenAI Codex `requirements.toml` and a Cursor dashboard worksheet. Each server is named by
its gateway URL, and nothing entitled means an explicit deny-all. Bundles are signed with Ed25519 and versioned, and the
export is refused without a signing key or public URL. Migration `pending/managed_settings_bundles.sql`. The three
admin routes are API-only gaps on #453. Drift against ADR-0259 is slice 2.

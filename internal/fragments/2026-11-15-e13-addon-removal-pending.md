<!-- fold: pending -->
**P1 follow-ups from governed add-on removal ([ADR-0331](../decisions/0331-governed-addon-removal.md), lane E13, 2026-11-15).**
- **Skills and plugins.** Removal needs a discovery kind first: a collection-manifest kind for skill and plugin
  directories, and per-device evidence on the gateway. Then the same directive can gain an action. Until then, only
  MCP server entries are removable.
- **Enforcing the reinstall block.** Each active removal with `blockReinstall` should add its server to the enforcement
  policy's `denyServers` once ADR-0298 policy content is delivered (SD4).
- **JSONC and TOML configs.** VS Code `settings.json`, Zed and Codex `config.toml` are reported `unsupported_format`.
  Editing them safely needs a format-preserving editor that meets ADR-0176.
- **Directive signer.** It is the ADR-0195 SD4 key ceremony. Until a key is pinned in `enforce.CompiledKeyring` and
  the gateway has a signer, the whole path is inert.

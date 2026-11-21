<!-- fold: pending -->
**P1 follow-ups from governed add-on removal ([ADR-0331](../decisions/0331-governed-addon-removal.md), lane E13, 2026-11-15).**
- **Skills and plugins.** Removal needs a discovery kind first: a collection-manifest kind for skill and plugin
  directories, and per-device evidence on the gateway. Then the same directive can gain an action. Until then, only
  MCP server entries are removable.
- **Enforcing the reinstall block.** Each active removal with `blockReinstall` should add its server to the enforcement
  policy's `denyServers` once ADR-0298 policy content is delivered (SD4).
- **JSONC and TOML configs.** VS Code `settings.json`, Zed and Codex `config.toml` are reported `unsupported_format`.
  Editing them safely needs a format-preserving editor that meets ADR-0176.
- **Device-policy key for directives.** Built in slice 3 (ADR-0331 addendum): the shared ADR-0334 key signs them. The
  key is not created when removal is turned on; it comes from the operator's file or from turning browser governance
  on. Generating it on the removal switch's first enable is a small follow-up if an org uses removal alone.
- **Restore a removed entry** (review of #871, F6 × S4). Keep the removed entry's JSON in the agent's state directory
  and add a signed restore directive; recorded as a decision in ADR-0331 ("Not in this slice").

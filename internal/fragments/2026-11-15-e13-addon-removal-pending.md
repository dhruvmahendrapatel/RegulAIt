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
- **Restore a removed entry** (review of #871, F6 × S4). Keep the removed entry's JSON in the agent's state directory
  and add a signed restore directive; recorded as a decision in ADR-0331 ("Not in this slice").
- **Domain separation of the device-policy signature** (review of #871, F2 × S4). One signer signs policies and
  directives, kept apart today by their `schema` member; add a domain prefix to the signed bytes when the shared signer
  lands (#867), on both the gateway and the agent, with the golden payload.
- **Idempotency key on the removal request** (review of #871, F3 × S2). A retried POST after a lost answer queues a
  second approval; accept an `Idempotency-Key` as other create routes do.

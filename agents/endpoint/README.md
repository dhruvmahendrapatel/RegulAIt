# RegulAIt endpoint agent (ADR-0195 SD4)

A read-only Go agent that runs as the logged-in user, collects the ADR-0195 decision-18 facts named by a signed
collection manifest, and sends signed, pseudonymous snapshots only to the org's gateway. Design: R15
(`internal/research/R15-endpoint-agent-sd4-spike.md`). What is built, the gateway contract and what is still pending:
ADR-0195, "As built: SD4a".

This module is outside the pnpm workspace. From this directory:

```sh
go test ./...                                   # unit tests (fixture filesystems, fake gateway)
CGO_ENABLED=1 go test -tags tpmsim ./internal/devicekey/   # TPM store on the reference simulator (needs OpenSSL headers)
bash scripts/check-licences.sh                  # every linked module is in THIRD_PARTY.md
node scripts/check-secret-rules.mjs             # key patterns agree with packages/shared (build shared first)
bash scripts/build.sh <out> <version>           # six targets
bash scripts/package-linux.sh <bin> <out> <version>   # unsigned .deb and .rpm
```

| Package | What it is |
|---|---|
| `cmd/regulait-agent` | The CLI: `redeem-ticket`, `register`, `run-once`, `run`, `preview`, `version` |
| `internal/contract` | The wire contract SD4b implements, with golden bodies in `testdata/` |
| `internal/pack` | ADR-0041-format pack verification and the collection-manifest validator |
| `internal/collect` | The collectors, over `fs.FS` roots (`os.Root` in production); `mcp.go` is ADR-0259's opt-in `mcp_config` collector (MCP host configs: servers, key types and risk flags, never values; off unless the org policy enables it) |
| `internal/secrets` | Key patterns compiled from the shared `dlp.secret.*` rules (RE2) |
| `internal/privacy` | The pre-upload pseudonymity guard |
| `internal/devicekey` | Device keys: TPM (Linux, Windows), file and DPAPI fallbacks, the darwin refusal |
| `internal/auth`, `internal/transport` | ES256 JOSE, the DPoP-bound token client, the issuer-only TLS 1.3 client |
| `internal/agent` | Config, enrolment, the cycle, the signed upload and key rotation |
| `internal/gatewaytest`, `internal/pack/packtest` | Test doubles: a strict fake gateway and a run-time pack signer |

## On-device enforcement hooks (ADR-0298, ADR-0330; default off)

`regulait-agent hook AGENT -policy FILE` answers one MCP tool-call hook for AGENT = `claude-code`, `cursor`,
`copilot-cli` or `codex`. It reads the hook input on stdin and the signed policy file, and never uses the network.
Nothing registers it: an admin opts in per agent through that agent's managed location. Until an admin pins a device-policy key (below),
no policy verifies, so a registered hook denies every MCP call. ADR-0330 §2 records what each agent's contract can and
cannot see. In particular, Codex cannot fail closed, and Copilot CLI denies every non-built-in tool in `enforce` mode.
`regulait-agent hook-capabilities` prints that capability matrix, with each adapter's contract version and docs, as
JSON. To add an agent, add one `Adapter` (`internal/enforce/hooks.go`) and its versioned fixtures
(`internal/enforce/testdata/hooks/README.md`).

Policies are signed by the control plane's device-policy signer, the same one that signs the managed-browser policy
(ADR-0330 §8, B4). Pin its public keys (the current key and at most one next key) in the agent config:
`"devicePolicyKeys": [{"keyId": "<key id>", "x": "<Ed25519 public key, base64url>"}]`.
ADR-0330 §8 also records the recommended configuration per agent: Copilot CLI in `audit` mode with GitHub's MCP
registry allow-list, and Codex as audit-grade, paired with its `requirements.toml` server allow-list.

**Command rules (ADR-0350).** Schema 2 policies carry a required `commands` section: shell commands (argv globs,
parsed as bash), file reads and writes (path globs, with defaults for outside the workspace) and package installs
(ecosystem and name), each allow, ask or deny, the strictest winning. An ask shows the agent's own permission prompt;
where the agent has no ask for that action it is a deny. `regulait-agent hook-capabilities` prints, per agent, which
actions the hook can see (`commands.shell`, `fileRead`, `fileWrite`: `ask`, `block` or `none`) and the vendor's
limits. Matching is textual: a guardrail, not containment. For command rules to apply, each registration below also
needs the built-in tools:

- Claude Code: matcher `Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit|mcp__.*`.
- Cursor: the same command under `beforeShellExecution` and `beforeReadFile`, each with `"failClosed": true`.
- Copilot CLI and Codex: the `preToolUse` / `PreToolUse` hook already sees every tool.

Registrations (paths are examples; use absolute paths with no shell metacharacters):

- **Claude Code**, managed settings: a `PreToolUse` hook with matcher `mcp__.*`, exec form
  `"args": ["/usr/local/bin/regulait-agent", "hook", "claude-code", "-policy", "/etc/regulait/policy.json"]`,
  `"onFailure": "block"`, and `allowManagedHooksOnly: true`.
- **Cursor**, enterprise `hooks.json` (`/etc/cursor/hooks.json`, `/Library/Application Support/Cursor/hooks.json` or
  `C:\ProgramData\Cursor\hooks.json`):
  `{"version": 1, "hooks": {"beforeMCPExecution": [{"command": "'/usr/local/bin/regulait-agent' 'hook' 'cursor' '-policy' '/etc/regulait/policy.json'", "failClosed": true}]}}`.
  Cursor has no exec form (`execForm: false` in `regulait-agent hook-capabilities`), so the command runs through a
  shell: keep the path and every argument quoted, with nothing interpolated. On Windows it runs through PowerShell,
  so prefix the quoted path with the call operator `&`.
  In audit mode an allowed call gets `allow` and a would-deny gets `ask`, never `allow`.
  Team (dashboard) hooks cannot set `failClosed` and are not supported.
- **Copilot CLI**, a root-owned policy file `/etc/github-copilot/policy.d/regulait.json` (Windows:
  `C:\ProgramData\GitHub\Copilot\policy.d\`):
  `{"version": 1, "hooks": {"preToolUse": [{"type": "command", "exec": "/usr/local/bin/regulait-agent", "args": ["hook", "copilot-cli", "-policy", "/etc/regulait/policy.json"]}]}}`.
- **Codex**, `/etc/codex/requirements.toml` (Windows: `%ProgramData%\OpenAI\Codex\requirements.toml`): a `[hooks]`
  `PreToolUse` command `/usr/local/bin/regulait-agent hook codex -policy /etc/regulait/policy.json`, with
  `allow_managed_hooks_only = true` and `[features] hooks = true`. Pair it with the `[mcp_servers.<name>] identity`
  allow-list.

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
| `cmd/regulait-agent` | The CLI: `redeem-ticket`, `enrol`, `update`, `health`, `register`, `run-once`, `run`, `preview`, `version` |
| `internal/contract` | The wire contract SD4b implements, with golden bodies in `testdata/` |
| `internal/pack` | ADR-0041-format pack verification and the collection-manifest validator |
| `internal/collect` | The collectors, over `fs.FS` roots (`os.Root` in production); `mcp.go` is ADR-0259's opt-in `mcp_config` collector (MCP host configs: servers, key types and risk flags, never values; off unless the org policy enables it) |
| `internal/secrets` | Key patterns compiled from the shared `dlp.secret.*` rules (RE2) |
| `internal/privacy` | The pre-upload pseudonymity guard |
| `internal/devicekey` | Device keys: TPM (Linux, Windows), file and DPAPI fallbacks, the darwin refusal |
| `internal/auth`, `internal/transport` | ES256 JOSE, the DPoP-bound token client, the issuer-only TLS 1.3 client |
| `internal/agent` | Config, enrolment (MDM and one-line), the cycle, the signed upload, key rotation and the root self-update step |
| `internal/update` | Self-update core (ADR-0360): directive and release-manifest verification, the downgrade refusal, staging, health check, swap and rollback |
| `internal/gatewaytest`, `internal/pack/packtest` | Test doubles: a strict fake gateway and a run-time pack signer |

## One-line enrolment (ADR-0360 §5)

For a machine outside MDM, an admin issues a one-line enrolment token on the gateway (single use, 15 minutes by default,
at most 60, optionally placing the device in a device group). With the package installed and the MDM config file in
place, paste the line the gateway shows, as root:

    printf '%s\n' '<token>' | sudo regulait-agent enrol

The token is read from standard input only, never from an argument (an argument is visible in every user's process
list). It is never logged, written to the status file or written to disk, and it is spent by its first use, so a copy
left in shell history is inert. A device that already holds a valid ticket keeps it and does not spend the token. The
device ticket still lives 7 days; a one-line-enrolled device needs a new token (or MDM's bulk token file) after that.

## Self-update (ADR-0360 §4; off by default)

`regulait-agent update` runs as root from the package's system timer (`regulait-agent-update.timer` on Linux, the
`com.regulait.agent.update` LaunchDaemon on macOS). It installs nothing unless **all** of these hold:

1. The config pins the device-policy keys (`devicePolicyKeys`) **and** the release keys (`releaseKeys`, at most two:
   current and next). One key per purpose: the same key in both lists makes the config invalid.
2. The spool (`/var/lib/regulait-agent/update`, `1770 root:regulait-agent`) holds an update directive signed by the
   device-policy signer for **this** device (the ticket file's device id), valid now and for at most 24 hours. The
   gateway signs one only while the admin has turned self-update on for the source (a step-up, audited) and the
   device's group has an active rollout stage.
3. The spool holds a release manifest (`regulait.endpoint-release/1`) signed by a release key for exactly the
   directive's version, listing this OS and architecture with the binary's SHA-256 and length.
4. That version is **newer** than the running binary (`golang.org/x/mod/semver`); a downgrade or a development build is
   refused.

It then copies the spooled binary to a root-only file beside the installed one, checks the copy's length and SHA-256
(the copy, so a later change to the spool cannot change what runs), runs `<staged> health` (it must report the target
version), renames it into place keeping `<binary>.previous`, runs the installed binary's `health` and restores the
previous binary when that fails. The outcome (`installed`, `rolled_back`, `refused`, `failed`, with a fixed code) is
written to the spool's `result.json`. On macOS the binary is universal, so a release lists `darwin/arm64` and
`darwin/amd64` with the same digest. A package-managed binary replaced this way differs from the package database until
the next package upgrade; fleets upgraded by MDM can leave self-update off (the default).

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

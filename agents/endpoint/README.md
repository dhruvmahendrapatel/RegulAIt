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

## Governed add-on removal (ADR-0331; off by default)

This is the agent's only write outside its own state directory, a narrow and recorded exception to ADR-0195 decision
19. At each sync, after the collection pack has verified, the agent fetches its signed removal directives. A directive
removes one named MCP server entry from one plain-JSON MCP client config that the signed manifest locates, and only
when the entry's identity matches.

- **Checks before acting.** A directive is acted on only if it is signed under the enforcement keyring and bound to
  this agent's identity. It must be inside its validity window (at most 7 days) and not already in the replay ledger
  (`directive-ledger.json`, 0600).
- **How the edit is made.** Every other byte of the file is kept. The file is replaced atomically through `os.Root`,
  and a symlink is never written through.
- **What is left alone.** JSONC and TOML configs are reported `unsupported_format` and not edited. Skills, plugins,
  editor extensions and the coding agent itself are never touched.
- **Reporting.** The developer sees a platform notice: `osascript`, `notify-send` or `msg`, run as an argument list
  with no shell. Each outcome (`removed`, `nothing_to_remove` or `failed`, with a fixed code) is posted back to the
  gateway's audit trail.
- **Current state.** The keyring is empty until SD4, so nothing verifies, and the gateway answers `503
  directive_signer_unavailable` until it has a signer.

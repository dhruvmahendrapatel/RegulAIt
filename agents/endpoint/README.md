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
| `internal/collect` | The collectors, over `fs.FS` roots (`os.Root` in production) |
| `internal/secrets` | Key patterns compiled from the shared `dlp.secret.*` rules (RE2) |
| `internal/privacy` | The pre-upload pseudonymity guard |
| `internal/devicekey` | Device keys: TPM (Linux, Windows), file and DPAPI fallbacks, the darwin refusal |
| `internal/auth`, `internal/transport` | ES256 JOSE, the DPoP-bound token client, the issuer-only TLS 1.3 client |
| `internal/agent` | Config, enrolment, the cycle, the signed upload and key rotation |
| `internal/gatewaytest`, `internal/pack/packtest` | Test doubles: a strict fake gateway and a run-time pack signer |

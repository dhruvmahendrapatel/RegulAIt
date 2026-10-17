# Third-party components — endpoint agent (`agents/endpoint`)

ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained (a release in about the last 12 months); pinned;
works air-gapped. Go modules are pinned by `go.mod` and hashed by `go.sum`; nothing is fetched at run time.
`scripts/check-licences.sh` fails CI when the binary links a module@version that is not in the first table.
Searched and checked 2026-10-17 against `proxy.golang.org` (release dates) and each module's `LICENSE` file.

## Linked into the agent binary

| Module | Version | Licence | Platforms | Used for, and why |
|---|---|---|---|---|
| `github.com/go-jose/go-jose/v4` | `v4.1.6` (2026-10-14) | Apache-2.0 | all | ES256 compact JWS: the `private_key_jwt` assertion, DPoP proofs, rotation proof, report signature (`internal/auth`). Signs through `OpaqueSigner`, so a TPM key never leaves the TPM. R15 §1.2 named it (or `jwx`) |
| `golang.org/x/sys` | `v0.49.0` (2026-10-06) | BSD-3-Clause | all | Windows registry reads, DPAPI, Toolhelp snapshot, the NCrypt and iphlpapi calls |
| `github.com/google/go-tpm` | `v0.9.8` (2025-12-29) | Apache-2.0 | linux | The TPM 2.0 device key over `/dev/tpmrm0` (`internal/devicekey/tpm.go`) |
| `github.com/shirou/gopsutil/v4` | `v4.26.9` (2026-09-27) | BSD-3-Clause | linux, darwin | Process names and listening sockets (`internal/collect/proc.go`). Not used on Windows: there it links `github.com/yusufpapurcu/wmi` (last release 2024-01-28) and `github.com/go-ole/go-ole` (last release 2023-08-04), which fail the 12-month rule, so Windows uses `x/sys/windows` directly (`proc_windows.go`) |
| `github.com/tklauser/go-sysconf` | `v0.4.0` (2026-05-12) | BSD-3-Clause | linux, darwin | Transitive, through gopsutil |
| `github.com/tklauser/numcpus` | `v0.12.0` (2026-05-11) | Apache-2.0 | linux | Transitive, through go-sysconf |
| `github.com/ebitengine/purego` | `v0.11.1` (2026-09-18) | Apache-2.0 | darwin | Transitive, through gopsutil (calls libSystem without cgo) |

## Test-only (never linked)

| Module | Version | Licence | Used for |
|---|---|---|---|
| `github.com/google/go-tpm-tools` | `v0.4.11` (2026-10-09) | Apache-2.0; its `simulator/ms-tpm-20-ref` is the Microsoft TPM 2.0 reference implementation under a BSD licence | The TPM simulator for `go test -tags tpmsim ./internal/devicekey/` (cgo, OpenSSL headers) |

## Build-time only (not shipped)

| Tool | Version | Licence | Used for |
|---|---|---|---|
| `github.com/goreleaser/nfpm/v2` | `v2.47.0` (2026-06-20) | MIT | Builds the `.deb` and `.rpm` (`scripts/package-linux.sh`). v2.48.0 (2026-10-12) was less than two weeks old when pinned |
| `pkgbuild`, `lipo`, `plutil` | macOS system tools | Apple | The unsigned macOS `.pkg` on the CI macOS runner |

## Considered and not used

| Candidate | Why not |
|---|---|
| `howett.net/plist` (BSD) | Last release v1.0.1, 2023-10-24: fails the 12-month rule. XML property lists are read with `encoding/xml`; binary ones are converted by the OS's own `/usr/bin/plutil` |
| `github.com/google/uuid` (BSD-3-Clause) | The one use is formatting 16 random bytes as a v4 UUID (six lines over `crypto/rand`) |
| An embedded osquery | R15 §2.5: a general query engine cannot hold decision 19's fixed fact set by construction |
| `zalando/go-keyring`, `godbus/dbus` (Secret Service) | The Linux fallback in this slice is the 0600 file; Secret Service and the macOS Keychain are SD4j follow-ups |
| `kardianos/service` | Zlib licence, not on the ADR-0176 list; the packages register the user units themselves |

# R15: endpoint agent (ADR-0195 SD4), design spike

Checked 2026-10-17 UTC against `main` @ `3698f3f` with the ADR-0195 branch (`8a6d097`) merged in. This is research
only: no product code, no migration. It answers the SD4 design spike that ADR-0195 asks for before the endpoint agent
is built (owner decision 2(b), decisions 18 to 20). Throwaway size probes and the scripts that built them are in
[`spikes/sd4-endpoint-agent/`](../../spikes/sd4-endpoint-agent/README.md). Every number below was measured in this
container unless it is marked **pending**.

## Decision summary

**Recommendation: write the agent in Go, as a static, `CGO_ENABLED=0` binary per platform, with our own small
collectors, not an embedded osquery.**

1. **Go cross-compiles all six targets from Linux CI with the stock toolchain and nothing else.** Measured here: a
   probe that already holds the agent's crypto core (Ed25519, a DPoP proof, JWK thumbprint, a TLS 1.3 HTTP client)
   is 3.2 to 3.5 MiB per platform, 1.3 to 1.5 MiB gzipped, with a 3.5 MiB peak RSS. Rust is smaller (a hello world is
   0.33 MiB) but its macOS and Windows targets need an Apple SDK or a MinGW/LLVM-MinGW linker that a Linux runner
   does not have. A Node single executable is 119 MiB with a 59 MiB peak RSS, and its injector has had no release
   since 2023.
2. **What we give up is reuse of our TypeScript client.** The engine runner's `oauth4webapi` client does not come
   along. The agent instead assembles the two compact JWS (the `private_key_jwt` client assertion and the DPoP proof)
   over a maintained JOSE library, which is the same call ADR-0188 S7 point 7 made for the Kong adapter. The gateway
   stays the single verifier, and a conformance suite runs the real agent client against the real gateway.
3. **Own collectors, not osquery, inside the agent.** Decision 19 says the agent collects "the same facts as the query
   pack and nothing more". An embedded osquery is a general SQL engine over hundreds of tables, so it would not hold
   that line by construction. The facts are reads of known directories and manifest files plus the OS socket table:
   small code over `gopsutil` (BSD-3-Clause) and `golang.org/x/sys` (BSD-3-Clause). Parity with the SD3 query pack
   comes from one signed collection manifest that both consume (§2.4). osquery's licence would not be the blocker:
   it is `Apache-2.0 OR GPL-2.0-only`, so we could take it under Apache-2.0.
4. **Enrolment is ADR-0188 S7 with a new workload kind, `endpoint_agent`.** The agent generates its own key, registers
   only the public JWK, and takes short self tokens with `client_credentials` + `private_key_jwt` + DPoP (nonce
   required). It rotates at two thirds of the key's window. Fleet enrolment needs a **bulk** enrolment token that
   MDM can push, unlike the runner's one-time token. That is an owner question (§5, Q3).
5. **Updates are signed twice.** The OS signature (Apple Developer ID plus notarisation, Windows Authenticode, a
   signed Linux package) is what MDM and the OS check. A RegulAIt Ed25519 release manifest, in the ADR-0041 bundle
   format and checked against an agent keyring embedded at build time, is what the agent checks before any update it
   applies itself. Self-update is off by default (MDM is the distribution channel). `infra/release-keys/` is not
   touched: the agent gets its own key id namespace and keyring (§4).

**What needs the owner:** an Apple Developer Program account and a Windows code-signing certificate (both cost money
and need named custody), the bulk enrolment model, whether hardware-bound keys are the default, whether an endpoint
finding may carry the 8-character key prefix, and the MSI tooling licence (§5).

## 1. Language and packaging

### 1.1 Requirements

These are taken from ADR-0195 decisions 18 to 20 and from ADR-0188 S7:

- **Targets:** macOS arm64 and x64, Windows x64 and arm64, Linux x64 and arm64.
- **Binary:** one small, static binary per platform, with no runtime to install and no network fetch at run time
  (air-gapped, pillar 3).
- **Build:** built in our Linux CI, reproducibly, with a pinned toolchain whose licence fits ADR-0176.
- **Signing:** signable with Apple Developer ID (and notarised) and Windows Authenticode.
- **Crypto:** Ed25519, RFC 7638 thumbprints, compact JWS for `private_key_jwt` and DPoP, and TLS 1.3.
- **OS access:** the OS keystores (Keychain, DPAPI or TPM, Secret Service) and the OS socket and process tables.

### 1.2 Candidates

| | Go | Rust | Node single executable (SEA) |
|---|---|---|---|
| Toolchain licence | BSD-3-Clause | MIT OR Apache-2.0 | Node is MIT. The binary bundles V8 (BSD-3-Clause), OpenSSL (Apache-2.0), ICU (Unicode licence) and more, so the shipped closure is larger |
| Cross-compile from Linux | All six targets with the stock toolchain and `CGO_ENABLED=0`. **Measured** (§1.3) | Linux musl targets link with the bundled `rust-lld`. **Measured** for x64 and arm64. macOS needs an Apple SDK (or a zig-based linker). Windows needs MinGW or LLVM-MinGW (`*-windows-gnu`/`gnullvm`), or Microsoft's CRT and SDK fetched by a helper (`msvc`). None is in a stock Linux runner. **Pending**: not attempted here, because the container was short of disk and has none of those linkers | No real cross-compile. You inject a platform-independent blob into each platform's own `node` binary, which has to be downloaded and pinned per target. Built here for the host only |
| Binary size | 3.2 to 3.5 MiB for the probe | 0.33 to 0.37 MiB for a hello world. The probe was **pending** (not built, for disk) | 119 MiB on the host |
| Memory | 3.5 MiB peak RSS for the probe | **pending** | 59 MiB peak RSS for the probe |
| Crypto and JOSE | Standard library: `crypto/ed25519`, `crypto/tls` (TLS 1.3), `encoding/json`. JOSE: `go-jose/go-jose/v4` 4.1.6 (Apache-2.0, released 2026-10-14) or `lestrrat-go/jwx/v3` 3.3.0 (MIT, 2026-09-08) | `ed25519-dalek` 2.2.0 (BSD-3-Clause, 2025-07-09), `rustls`, `ureq` 3.1.2 (MIT OR Apache-2.0, 2025-09-08) | **Reuses our code**: `jose` 6.2.12 and `oauth4webapi` 3.8.8, the engine runner's client |
| Keystores | `zalando/go-keyring` 0.2.8 (MIT, 2026-03-23), `danieljoos/wincred` 1.2.3 (MIT, 2025-10-02), `godbus/dbus/v5` 5.2.4 (BSD-2-Clause, 2026-10-13), `google/go-tpm` 0.9.8 (Apache-2.0, 2025-12-29) | `keyring` 3.6.3 (MIT OR Apache-2.0, 2025-07-27) | None in the runtime. Native addons would break the single-file property |
| Sockets and processes | `shirou/gopsutil/v4` 4.26.9 (BSD-3-Clause, 2026-09-27) | `sysinfo` 0.37.2 (MIT, 2025-10-02) | Shell out, or a native addon |
| macOS signing | Go adds an ad-hoc signature to darwin/arm64 binaries itself. Developer ID signing and notarisation run as a normal Mach-O step | Normal Mach-O | The `node` binary's own signature must be removed before injection and the result re-signed. Node's documentation describes this; not executed here |
| Air-gapped build | Module proxy cache or `go mod vendor`; `go.sum` pins hashes | `cargo vendor`; `Cargo.lock` | pnpm store plus a pinned `node` per target |

Licences and release dates come from `api.deps.dev` and `proxy.golang.org`, both queried on 2026-10-17. GitHub's API
was not reachable from this container.

### 1.3 Measurements (executed)

All builds used `-trimpath -ldflags "-s -w"` for Go and `opt-level="z"`, LTO, `panic="abort"` and `strip` for Rust.
Sizes are in bytes. The macOS and Windows binaries were built but not run (there is no such host here); `file`
confirms their formats (Mach-O 64-bit x86_64/arm64, PE32+ x86-64/Aarch64). The Linux binaries are statically linked.

| Binary | darwin/arm64 | darwin/amd64 | windows/amd64 | windows/arm64 | linux/amd64 | linux/arm64 |
|---|---|---|---|---|---|---|
| Go hello | 1,572,562 | 1,560,016 | 1,531,904 | 1,486,848 | 1,433,784 | 1,441,976 |
| Go probe | 3,429,266 | 3,611,696 | 3,665,920 | 3,399,680 | 3,498,168 | 3,342,520 |
| Go probe, gzip -9 | 1,461,874 | 1,548,835 | 1,569,933 | 1,434,401 | 1,510,446 | 1,396,132 |
| Rust hello (musl) | pending | pending | pending | pending | 377,080 | 334,088 |
| Rust hello, gzip -9 | pending | pending | pending | pending | 188,565 | 181,295 |
| Node SEA probe | pending | pending | pending | pending | 124,783,808 | pending |
| Node SEA probe, gzip -9 | | | | | 41,478,561 | |

- **Node SEA breakdown.** The host `node` 22.22.2 is 124,679,552 bytes, and the injected blob (the esbuild bundle of
  the probe plus `jose`) is 31,182 bytes. The runtime is 99.97 % of the file.
- **Peak RSS (linux/amd64, `peakrss/`).** The Go probe peaked at 3,632 KiB and the Node SEA probe at 60,652 KiB.
  The helper's own floor is 2,388 KiB (the Go and Rust hello worlds both read exactly that), so only the probe and
  SEA figures mean anything.
- **Runs.** The Go probe and the Node SEA probe both printed a 43-character thumbprint and a 388-byte DPoP proof, so
  both crypto paths work on linux/amd64.
- **Build time.** Not a fair measure here. Each Go target compiled its standard library from cold, because the build
  cache was cleared between targets for disk, and that took about 40 s per target.

### 1.4 Why Go

- **The one property that decides it is cross-compilation and signing from Linux CI.** Go is the only candidate that
  produced all six signed-ready binaries here with no extra toolchain.
- **Rust would win on size.** That does not matter at 1.5 MiB gzipped, and getting Rust's macOS and Windows targets
  built needs either a macOS runner or an SDK whose licence limits its use to Apple-branded hardware, or an extra cross-linker toolchain to pin and audit.
- **Node SEA is ruled out on footprint.** It is 119 MiB per platform to push through MDM, and 59 MiB of RAM resident
  on every employee laptop.
- **Node SEA is also ruled out on maintenance.** `postject` 1.0.0-alpha.6 was published 2023-05-19, so it fails
  ADR-0176's "a release in about the last 12 months". Newer Node lines reportedly build SEAs without postject; that
  was not verified here.
- **Node SEA would bring an injection step into signing.** The base binary's signature has to be stripped and the
  result re-signed.
- **What Node would buy is reuse of `oauth4webapi`.** The protocol risk that reuse would remove is better handled by
  the conformance suite in SD4c, since the gateway is the verifier in every case.

**Go risks, stated honestly:**

- `CGO_ENABLED=0` rules out the macOS Secure Enclave and Keychain APIs that need cgo (`keybase/go-keychain`).
  `zalando/go-keyring` reaches the Keychain through the `/usr/bin/security` tool instead. Before adopting it, SD4c
  must check how it passes the secret to that tool, because a secret on a command line is visible to other
  processes. That check is **pending**.
- Hardware-bound keys on macOS would mean a darwin-only cgo build on a macOS runner (SD4j).
- `kardianos/service` is Zlib-licensed. Zlib is not on the ADR-0176 list, so we do not use it. Service registration
  is done by the installer packages (launchd plist, Windows service or scheduled task, systemd unit), which is how MDM
  expects it anyway.

## 2. Collecting the decision-18 facts

### 2.1 Run as the user, not as root

Every decision-18 fact except "listening ports of other users' processes" lives in the logged-in user's home or in
world-readable system locations. So the default agent process runs **as the logged-in user**:

- macOS: a LaunchAgent;
- Windows: a per-user scheduled task at logon;
- Linux: a systemd `--user` unit.

It needs no elevation. This is the strict default (ADR-0180): the smallest privilege that collects the fact set. A
per-machine component running as root/SYSTEM is needed only for multi-user machines and for attributing listeners
owned by other users. That component is an admin relaxation (§5, Q5), not the default.

### 2.2 Per fact, per OS

"User" means the logged-in user, with no elevation. Paths are the documented defaults. Each catalogue entry in the
signed collection manifest (§2.4) names the exact paths and patterns, so the agent hard-codes no product names.

| Fact (decision 18) | macOS | Windows | Linux | Privilege |
|---|---|---|---|---|
| Installed AI desktop apps | Bundle IDs from `Info.plist` in `/Applications` and `~/Applications` | Uninstall registry keys `HKLM\…\Uninstall` (readable by users) and `HKCU\…\Uninstall`; per-user installs under `%LOCALAPPDATA%\Programs` | `.desktop` files in `/usr/share/applications` and `~/.local/share/applications`; Flatpak and Snap metadata dirs | User |
| IDE extensions | `~/.<editor>/extensions/*/package.json` for VS Code-family editors; JetBrains `plugins` dirs under `~/Library/Application Support/JetBrains/*` | `%USERPROFILE%\.<editor>\extensions`; `%APPDATA%\JetBrains\*\plugins` | `~/.<editor>/extensions`; `~/.local/share/JetBrains/*` | User |
| Browser extensions | Chromium-family `…/<Profile>/Extensions/<id>/<ver>/manifest.json`; Firefox `extensions.json` in each profile; Safari app extensions through their containing apps | The same under `%LOCALAPPDATA%` and `%APPDATA%` | The same under `~/.config` and `~/.mozilla` | User |
| Local model runtimes and their listening ports | Process table plus socket table: `gopsutil` `net.Connections` over `proc_pidinfo`. Other users' sockets need root | `GetExtendedTcpTable` gives the owning PID for every listener without elevation. The image name of an elevated process may need `PROCESS_QUERY_LIMITED_INFORMATION`, which usually works | `/proc/net/tcp{,6}` is world-readable. Mapping an inode to a PID needs the same uid or root | User for own processes and the port list; root to name other users' processes |
| AI CLIs | Executables on the user's `PATH` and in package-manager bin dirs, matched by name and, where the catalogue gives one, by a package manifest | `PATH`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs` | `PATH`, `~/.local/bin`, `~/.npm-global` | User |
| Env var **names** | Names only, from shell start-up files (`~/.zshrc`, `~/.bash_profile`, `~/.profile`, fish config) and `launchctl getenv` for the names the manifest lists. The agent's own environment is not the user's shell environment | `HKCU\Environment` and `HKLM\…\Session Manager\Environment` (names), PowerShell profile files | Shell start-up files, `~/.config/environment.d/*.conf` | User |
| Config file key prefixes | Manifest-listed files (for example a CLI's `config.json`, `.env` files in the home directory only), parsed for key **names**; values matched on device against the catalogue's provider key patterns | The same | The same | User |

### 2.3 Redaction on the device

The rule: no value leaves the device. A detected key value becomes `{provider, file, key name}`. Whether the existing
8-character redacted prefix (decision 6) may also be sent is open. Decision 18 says "names (never values)" for
endpoints, while decision 6 allows the prefix for repos. The strict default here is **names only**; sending the prefix
would be an audited relaxation (§5, Q6).

The agent reads at most the manifest-listed files, caps each read (for example 256 KiB), and never follows symlinks
out of the home directory. It holds file contents only in memory for the match, and the report carries only the
SHA-256 of the raw collector output, as decision 6 does for pasted content.

### 2.4 One signed collection manifest shared with SD3

The facts the agent may collect are data, not code. That data is a versioned collection manifest: catalogue entries
with kind (app, ide_extension, browser_extension, local_runtime, cli, env_name, config_key), per-OS paths and patterns,
and port hints. It is signed with the same key and scheme as the SD3 query pack, and the gateway serves it.

- **The agent refuses** an unsigned manifest, a manifest older than the one it holds, or one with an unknown kind.
- **The SD3 query pack is generated from the same manifest.** A CI parity test runs both over the same fixture home
  directory and requires identical fact sets. That is how "the same facts as the query pack and nothing more"
  (decision 19) becomes a test rather than a promise.
- **The catalogue gains endpoint kinds.** `SHADOW_AI_CATALOG_V1` has only `endpoint` and `sdk` kinds today
  (`packages/shared/src/shadow-discovery.ts`). This extension is shared with SD3 and is built there first.

### 2.5 osquery: embed it, or not?

What we checked on osquery `master`, 2026-10-17:

- **Licence.** The `LICENSE` file says `SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-only`. We could take it under
  Apache-2.0, so the licence does not block embedding.
- **Release.** The latest `CHANGELOG.md` entry is 5.16.0. Its date was not retrieved.
- **Tables.** The specs for `vscode_extensions`, `chrome_extensions` (with `browser_type` and `profile` columns),
  `firefox_addons`, `darwin/safari_extensions`, `darwin/apps`, `windows/programs`, `linux/deb_packages`,
  `linux/rpm_packages`, `listening_ports`, `processes`, `npm_packages`, `python_packages` and `posix/process_envs` all
  exist.

So osquery covers most of decision 18. That is why SD3's no-agent option uses it.

**We still do not embed it in the agent**, for three reasons:

1. **Scope.** Decision 19 caps the agent at the decision-18 facts. An embedded osqueryd can answer any query against
   hundreds of tables, including `process_envs`, which returns environment **values**. Holding the line would mean
   our own allow-list in front of a general engine. That is harder to review than a fixed collector set.
2. **Footprint and patching.** Embedding osquery makes its release cadence and CVEs our security-response
   commitment, and multiplies the binary size. The size of an osqueryd build was **pending** (not downloaded, for
   disk).
3. **Privilege.** osquery's user-data tables read other users' homes only as root. That pushes toward the elevated
   default that §2.1 avoids.

ADR-0176 §4's narrow exception applies, with the unmet hard requirement written down: "a fixed, minimal fact set
enforced by construction" (decision 19) plus a stricter security posture (no elevation). It is re-checked if osquery
gains a way to restrict an embedded instance to a fixed table set. `osquery/osquery-go` (MIT) would only matter if the
agent became an osquery extension, which it does not.

## 3. Enrolment and transport (ADR-0188 S7 reused)

### 3.1 Device key and keystore

The agent generates an Ed25519 key on first run. S7 accepts Ed25519 under both `EdDSA` and `Ed25519`, and the decision
13 algorithm list also allows `ES256`.

| OS | v1 default (software key, OS-protected at rest) | Hardware-bound option (SD4j) |
|---|---|---|
| macOS | Keychain generic-password item in the user's login keychain, access limited to the signed agent | The Secure Enclave holds only **P-256** keys, so this means `ES256`. It needs cgo, an entitlement and a signed binary, so a darwin build on a macOS runner |
| Windows | DPAPI (`CryptProtectData`, user scope; machine scope for the optional SYSTEM component), blob in `%LOCALAPPDATA%\RegulAIt\agent\` | The TPM 2.0 Platform Crypto Provider (NCrypt) holds **P-256**/RSA, not Ed25519, so `ES256`. Reachable through `golang.org/x/sys/windows` syscalls without cgo; **pending** a proof |
| Linux | Secret Service over D-Bus (`godbus/dbus`) when a desktop session offers it; otherwise a file opened `O_NOFOLLOW`, created exclusively with mode 0600 in `$XDG_STATE_HOME/regulait-agent/`. This is the S7 runner's `runner-key` pattern and `ensureInstallKeyFile` semantics | `google/go-tpm` against `/dev/tpmrm0` (needs the `tss` group), `ES256` |

ADR-0180 points toward hardware-bound keys by default where hardware exists, with a software fallback that is audited
and shown on posture ("device key: software"). That roughly doubles the keystore work and needs a macOS runner, so
it is an owner question (§5, Q4). The proposal: v1 ships software keys, posture shows the key protection of each
device, and SD4j adds hardware binding as the default once proven.

### 3.2 Enrolment

1. MDM installs the package together with a managed configuration (a macOS configuration profile, Windows registry
   policy or MSI properties, a Linux `/etc/regulait-agent/config.json`). The configuration holds the issuer URL
   (`REGULAIT_PUBLIC_URL`, parsed with the same `parsePublicUrl` rules), an optional pinned CA bundle, and an
   enrolment token.
2. The agent sends `POST /v1/endpoint-agent/register` with `{enrolmentToken, jwk (public), agentVersion, os, arch,
   deviceUser (see Q7)}`. Registration creates an identity of the new kind `endpoint_agent` through
   `ensureIdentityFor` and binds the key through S6's one binding path (one key, one identity, ever).
   Re-registration of the same device proves possession of the old key, as S7 point 3 does.
3. **The enrolment token is the difference from S7.** A runner's token is one-time. A fleet cannot get a distinct
   secret per device through most MDM profiles, so the agent needs a **bulk enrolment token**:
   - scoped to one org and one discovery source;
   - capped (a maximum device count) and expiring (default 7 days);
   - revocable at no cost;
   - issued with `settings_relax`-class step-up, since enabling the source already is one;
   - every use audited.

   A leaked bulk token can enrol fake devices up to the cap, which pollutes findings but reads nothing. Admins see
   enrolments per token and revoke them in bulk. This is owner question Q3.

### 3.3 Tokens and routes

- **Token.** RFC 6749 `client_credentials`, with client authentication by `private_key_jwt` (RFC 7523) signed by the
  device key, and a DPoP proof (RFC 9449) by the **same** key (`dpop_key_mismatch` otherwise). The gateway nonce is
  required. The `resource` is `<issuer>/v1/endpoint-agent` (RFC 8707). This is S7 point 1 with `endpoint_agent` added
  to the kinds allowed this grant. The token resolves to `via: "endpoint-agent"`, which reaches only the routes
  below. Anything else answers `403 workload_scope`.
- **Rotation.** At `regulait_credential_rotate_after` the agent sends `POST /v1/endpoint-agent/credentials`. This is
  S7 point 4 unchanged: at most two live keys, and lost-answer recovery by trying the next key.
- **Routes**, all under the `via: "endpoint-agent"` token, rate-limited in the `cred:wid:<identityId>` bucket:

| Route | Purpose |
|---|---|
| `POST /v1/endpoint-agent/register` | Enrolment (bulk token, no access token yet) |
| `POST /v1/endpoint-agent/credentials` | Key rotation |
| `GET /v1/endpoint-agent/config` | Signed collection manifest, schedule, buffer limits |
| `POST /v1/endpoint-agent/reports` | One fact snapshot: `{snapshotId, collectedAt, manifestVersion, facts[], rawDigest}`. Idempotent on `snapshotId`. Merged into `shadow_ai_findings` as evidence kind `endpoint_agent` (decision 5) |
| `GET /v1/endpoint-agent/releases/current` | Signed release manifest for the agent's platform (§4); used only if self-update is enabled |

- **Admin side:** list devices, revoke a device (which revokes its identity and live tokens, S7 point 2), and revoke
  a bulk token.
- **Transport.** HTTPS only, to the configured issuer only (decision 19: "sends only to the org's gateway"), TLS 1.3
  minimum. The OS trust store is used, plus the optional pinned CA bundle for private PKI, which air-gapped installs
  need. The OS or `HTTPS_PROXY` proxy settings are honoured, because corporate networks need them; PAC files are
  out of scope for v1. The agent never falls back to another address, as S7 point 6 does for runners.

### 3.4 Offline buffering

The agent reports **snapshots of state, not events**, so a missed report loses nothing that the next snapshot does
not restate.

- **Buffer.** Up to 7 snapshots or 1 MiB on disk, whichever comes first. The buffer is encrypted with the same
  OS-protected key material and is written with the same 0600 and no-follow rules. When it is full, the oldest
  snapshot is dropped and a drop counter is sent with the next report, so the gap is visible rather than silent.
- **Sending.** The latest snapshot goes first after an outage. Older ones are sent only when they differ, which lets
  first-seen and last-seen dates stay honest.
- **Schedule.** Daily by default (decision 9), with ±30 min jitter so a fleet does not stampede the gateway after an
  office opens. Exponential backoff with a cap on 429 or 5xx.
- **Limits are relaxable.** All of these are manifest-delivered settings, so an admin can change them without a
  release. A longer buffer is a relaxation (it holds more data on the device).

## 4. Signed update verification and MDM distribution

### 4.1 Two signatures, two jobs

1. **The OS signature** is checked by the OS and the MDM before the agent ever runs:
   - Apple: Developer ID Application signature on the binary, Developer ID Installer signature on the `.pkg`,
     notarised and stapled;
   - Windows: Authenticode on the `.exe` and the `.msi`;
   - Linux: `.deb`/`.rpm` signed with a package-signing key.

   This is what MDM-driven updates rely on. The running agent cannot verify a replacement that MDM installs, and
   does not try.
2. **The RegulAIt release manifest** is checked by the agent itself, and only when self-update is enabled. It is the
   ADR-0041 update-bundle format (`scripts/verify-update-bundle.sh` semantics):
   - a manifest with `version`, `minInstalledVersion`, per-file SHA-256, `platform` and `signingKeyId`;
   - an Ed25519 signature over the manifest;
   - the key pinned in a keyring that is **compiled into the agent**;
   - downgrades refused, a minimum version enforced, and unknown files refused.

   The agent fetches the update only from its own gateway (`/v1/endpoint-agent/releases/current`), never from the
   internet, so air-gapped installs work. It verifies the manifest and every digest, then hands the OS-signed package
   to the OS installer, which checks the OS signature again.

### 4.2 Why this scheme, and what was compared

| Option | Licence and maintenance | Fit |
|---|---|---|
| **ADR-0041 manifest + Ed25519 (recommended for v1)** | Our format. Go verification uses the standard library `crypto/ed25519` | Already specified, already has a rotation procedure that works offline (`infra/release-keys/README.md`), and our CI already builds and verifies it |
| TUF (`theupdateframework/go-tuf/v2` 2.4.2, Apache-2.0, 2026-05-19) | Maintained | Adds signed expiry (freeze-attack protection), threshold signing and in-band root rotation. Worth adopting if self-update becomes common; it is a larger key ceremony |
| Sigstore (`sigstore-go` 1.3.0, Apache-2.0, 2026-07-30) | Maintained | Keyless signing needs Fulcio and Rekor online, which fails air-gapped. Keyed bundles work offline but add nothing over Ed25519 here. Our images keep cosign (ADR-0184) |
| minisign (`jedisct1/go-minisign`, MIT) | Only a pseudo-version (2026-05-27), no tagged release | Simple, but no tagged releases to pin |

**Keys.** The agent gets **its own key id namespace** (for example `regulait-agent-release-<id>`) and its own keyring
embedded at build time, managed with the same offline ceremony and the same rotation order. The rule is to ship the
new public key in a release signed by the old one, and never collapse those steps. Nothing is added to or changed in
`infra/release-keys/`.

Why a separate key: the agent runs on employee laptops at a very different scale and threat level from a control-plane
bundle, and a compromise of one key should not cover both. Whether it is a separate key or the same one is owner
question Q8.

ADR-0041's caveats carry over unchanged: there is no revocation list (air-gapped boxes cannot check one), and a
signed old release is still old, which is why downgrades are refused.

**Self-update.** It is off by default. Enabling it is a `settings_relax` step-up per org, audited. With it off, the
agent only reports its version, and posture shows devices behind the current release.

### 4.3 MDM distribution formats

| OS | Package | Configuration | Build tooling (build-time only, not shipped) |
|---|---|---|---|
| macOS | Signed, notarised flat `.pkg` installing the binary and a LaunchAgent plist | A configuration profile (`.mobileconfig`) with managed preferences: issuer, CA bundle, enrolment token | `pkgbuild`/`productbuild`/`productsign` and `notarytool` on a macOS runner. From Linux, `rcodesign` (in `indygreg/apple-platform-rs`, MPL-2.0, a build tool) can sign and notarise Mach-O binaries. Whether it covers signing a flat `.pkg` was **pending** |
| Windows | Authenticode-signed `.msi`, per-machine install that registers a per-user logon task (and optionally the SYSTEM component) | MSI public properties or registry policy (`HKLM\SOFTWARE\Policies\RegulAIt\Agent`) | WiX Toolset is MS-RL, and its project announced a maintenance-fee condition for commercial use of recent major versions (not re-checked here). `msitools`' `wixl` runs on Linux but is LGPL-2.1. **Neither meets ADR-0176's list**; both are build tools, not shipped code, so this needs an owner ruling (Q9). Authenticode signing from Linux: `jsign` (Apache-2.0, Java) or `sassoftware/relic` 8.2.0 (Apache-2.0, last release 2025-01-17), both able to use an HSM or cloud KMS key. `osslsigncode` is GPL-3.0 and is avoided |
| Linux | `.deb` and `.rpm` with a systemd user unit | `/etc/regulait-agent/config.json` (0644, holding no secret except the bulk token; Q3 covers its exposure) | `goreleaser/nfpm/v2` 2.48.0 (MIT, 2026-10-12), which builds and signs both. `goreleaser` 2.18.3 (MIT) can drive the whole release |

**Certificates.** Since 2023 the CA/Browser Forum rules require code-signing private keys to live in hardware (an HSM,
a token or a cloud KMS). So the Windows certificate implies an HSM or KMS decision. Apple Developer ID keys are held
by whoever holds the Apple account. Both are owner inputs (Q1, Q2).

## 5. Proposed slices and open questions

### 5.1 Slices

| Slice | Delivers | Depends on | Needs owner input |
|---|---|---|---|
| **SD4a** ADR amendment | ADR-0195 gains the decisions from this spike: language, collector stance, enrolment model, update scheme, defaults table | this spike | Q1 to Q9 answered or deferred |
| **SD4b** Gateway side | Workload kind `endpoint_agent`, bulk enrolment tokens, the `/v1/endpoint-agent/*` routes, `via: "endpoint-agent"` scope, rule ids, posture rows, a migration (number assigned by the master) | SD0 on main; ADR-0188 S7 | Q3, Q7 |
| **SD4c** Agent core | A Go module outside the pnpm workspace (for example `agents/endpoint/`): config, keystore abstraction (file 0600, Keychain, DPAPI, Secret Service), RFC 7523 + RFC 9449 client over `jwx` or `go-jose`, rotation, a conformance suite against the real gateway in CI (Docker in CI), and a `THIRD_PARTY.md` | SD4b | none |
| **SD4d** Collectors | The per-OS collectors in §2.2 driven by the signed collection manifest; on-device redaction; the parity test with the SD3 query pack on fixture home directories | SD3's catalogue kinds, SD4c | Q6 |
| **SD4e** Privacy | Pseudonymous device users (a keyed hash per tenant, held server-side), the reveal step-up and audit, and the employee-notice template (decision 20) | SD4b | Q7 |
| **SD4f** Buffering and schedule | §3.4: snapshot buffer, drop counter, jitter, backoff, manifest-delivered limits | SD4c | none |
| **SD4g** Release pipeline | Reproducible `-trimpath` builds for six targets, a CycloneDX SBOM, a Go licence check (allow-list as ADR-0176), and an Ed25519 release manifest under the new agent key namespace. Signing steps stay pending until the keys exist | SD4c | Q8 |
| **SD4h** Packages and OS signing | `.pkg` + configuration profile, `.msi`, `.deb`/`.rpm`; Developer ID signing and notarisation; Authenticode through the HSM or KMS | SD4g | Q1, Q2, Q9 |
| **SD4i** Self-update | The optional, step-up-gated self-update path of §4.1: fetch from the gateway, verify the manifest, refuse downgrades, hand off to the OS installer | SD4g, SD4h | none |
| **SD4j** Hardware-bound keys | `ES256` keys in the Secure Enclave, TPM (NCrypt) and Linux TPM; posture shows key protection | SD4c | Q4 |
| **SD4k** Admin UI | A devices page (pseudonymous), revoke device, revoke bulk token, fleet version and posture; KNOWN_UI_GAPS stays 0 | SD4b | none |
| **SD4l** Optional elevated component | The per-machine root/SYSTEM component for multi-user machines and other users' listeners, as an audited relaxation | SD4d | Q5 |
| **SD4m** Security review and support policy | An external review of the agent and its update path; a supported OS version matrix; a vulnerability response process (the ADR's "long-term commitment") | SD4h | supported OS matrix |

SD4b and SD4c can run in parallel once the route and token contract in §3.3 is in the ADR. SD4d needs SD3's catalogue
extension first. SD4h is blocked on certificates, not code.

### 5.2 Open questions for the owner

1. **Apple Developer Program.** Who holds the account, and who holds the Developer ID Application and Installer keys?
   Notarisation needs an App Store Connect API key.
2. **Windows code signing.** Do we take an OV or EV certificate, and which HSM or cloud KMS holds its key? The CA/B
   Forum rules require hardware.
3. **Bulk enrolment token.** Is a capped, expiring, revocable per-org token acceptable for MDM rollout? Or must every
   device get a distinct token through per-device MDM variables, which not every MDM supports?
4. **Hardware-bound device keys.** Are they the default where hardware exists (stricter, and needs a macOS runner and
   cgo on darwin), or a later default after v1 ships software keys with posture visibility?
5. **The elevated component.** Do we offer it at all? The proposal is yes, as an audited relaxation, off by default.
6. **The key prefix.** May an endpoint finding carry the 8-character redacted key prefix (decision 6), or names only
   (decision 18)? The proposal is names only by default, with the prefix as a relaxation.
7. **Device user identity.** Is the device's user name sent to the gateway and hashed there (keyed per tenant, raw
   value encrypted for the reveal step-up), or hashed on the device (then a reveal is impossible)? The proposal is
   the server side, because decision 20 requires reveal to be possible.
8. **The agent release key.** Is it separate from the ADR-0041 control-plane release key? The proposal is separate.
9. **MSI tooling licence.** WiX (MS-RL plus a maintenance-fee condition) or `wixl` (LGPL-2.1) is build-time only and
   never shipped. Is a written ADR-0176 exception acceptable, or should we ship an Authenticode-signed `.exe`
   installer instead? Some MDMs accept a signed `.exe` with silent-install switches.

## 6. What was not verified here

- **Not built:** Rust for macOS and Windows, a Rust probe with TLS and JOSE, and Node SEA for any non-host platform.
  The container had about 0.3 to 0.7 GB of free disk, shared with other sessions, and no MinGW, LLVM-MinGW or Apple
  SDK.
- **Not run:** no macOS or Windows binary was run, and nothing was signed or notarised (no certificates exist).
- **Not checked:** how `zalando/go-keyring` passes secrets to `/usr/bin/security`; whether `rcodesign` can sign flat
  `.pkg` files; TPM key creation through NCrypt from pure Go; the size of an osqueryd build.
- **Not retrieved:** the date of osquery 5.16.0. GitHub's API was not reachable from this container, so maintenance
  dates come from deps.dev and the Go module proxy only.

## Sources

- ADR-0195 decisions 2, 5, 6, 9, 18 to 20 and slice SD4; ADR-0188 decisions 10 to 13 and "As built: slice S7";
  ADR-0176; ADR-0180; ADR-0041 and `infra/release-keys/README.md` (read only); `scripts/verify-update-bundle.sh`.
- `packages/shared/src/shadow-discovery.ts` (catalogue kinds); `apps/gateway/src` engine-runner routes (route shape).
- osquery `LICENSE`, `CHANGELOG.md` and `specs/*.table` on `master` (raw.githubusercontent.com, 2026-10-17).
- Licences and release dates: `api.deps.dev` v3 (Go, npm, Cargo) and `proxy.golang.org/@latest`, 2026-10-17.
- Measurements: `spikes/sd4-endpoint-agent/` scripts, run in this container on 2026-10-17.

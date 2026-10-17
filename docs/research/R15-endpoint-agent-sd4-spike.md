# R15: endpoint agent (ADR-0195 SD4), design spike

Checked 2026-10-17 UTC against `main` @ `3698f3f` with the ADR-0195 branch (`8a6d097`) merged in, then revised after
review against `main` @ `12c2497`, where ADR-0195 has landed. This is research only: no product code, no migration.
It answers the SD4 design spike that ADR-0195 asks for before the endpoint agent is built (owner decision 2(b),
decisions 5, 18 to 20). The owner's answers of 2026-10-17 and the master's technical calls are recorded in §0 and
appended to ADR-0195 ("Owner decisions (2026-10-17): endpoint agent and detection data"). Throwaway size probes
and the scripts that built them are in [`spikes/sd4-endpoint-agent/`](../../spikes/sd4-endpoint-agent/README.md).
Every number below was measured in this container unless it is marked **pending**. Sizes use MiB (2^20 bytes) and
KiB.

## 0. Owner decisions and technical calls (2026-10-17)

### Owner decisions (2026-10-17)

| # | Decision |
|---|---|
| a | **Apple.** A company Apple Developer account. The Developer ID signing identity lives in a protected CI secret store that only release jobs can use |
| b | **Windows.** An OV code-signing certificate whose key lives in a cloud HSM-backed key service, called from CI |
| c | **Enrolment.** A per-org bulk enrolment token delivered by MDM: capped, expiring, revocable. Each device then creates its own key and identity |
| d | **Device keys.** Hardware-bound by default (Secure Enclave P-256 on macOS, TPM on Windows and Linux). The OS-keystore fallback is used only where no such hardware exists, and posture flags it. A macOS build runner is therefore needed |
| e | **Product names in detection data.** AI products, including ones RegulAIt competes with, may appear as detection catalogue data (names, domains, bundle ids, extension ids, package names) and in the findings it produces, because customers need to see them. They never appear in marketing, docs prose, ADR prose, comparisons or UI copy. This note therefore names no AI product: the manifest entries of §2.4 carry the names as data |

### Master technical calls (2026-10-17)

| # | Call |
|---|---|
| 1 | **No root/SYSTEM component in v1.** The agent runs only as the logged-in user (§2.1) |
| 2 | **Key presence only.** Endpoint findings record that a key is present, its provider, the file and the key name. No 8-character prefix (§2.3) |
| 3 | **Device user names are hashed server-side.** The gateway applies the per-tenant keyed hash and stores the display name encrypted. Revealing it needs a `pseudonym_reveal` step-up and is audited (decision 20). Device hostnames get the same treatment |
| 4 | **Separate agent release key.** It is separate from the ADR-0041 control-plane release key and from the query-pack key (§4) |
| 5 | **Build-tool exceptions (ADR-0176).** WiX (MS-RL) and `rcodesign` (MPL-2.0) are accepted as written build-tool exceptions with the unmet requirement stated in §4.4. Both are build tools only, their output is not covered by their licences, and neither is shipped |
| 6 | **Bulk token defaults.** The admin must set the device cap (there is no unlimited default). Expiry defaults to 30 days, and lengthening it is a relaxation. Rotation is by MDM re-push of a new token |

## Decision summary

**Recommendation: write the agent in Go, as a static, `CGO_ENABLED=0` binary per platform, except that the darwin build
uses cgo on a macOS runner for the Secure Enclave. Use our own small collectors, not an embedded osquery.**

1. **Go cross-compiles all six targets from Linux CI with the stock toolchain.** Measured here: a probe that already
   holds the agent's crypto core (Ed25519, a DPoP proof, a JWK thumbprint, a TLS 1.3 HTTP client) is 3.19 to
   3.50 MiB per platform, 1.33 to 1.50 MiB gzipped, with a 3.55 MiB peak RSS. The real agent will be larger (§1.3).
   - Owner decision d (hardware keys by default) means the darwin binaries are built with cgo on a macOS runner.
     Windows and Linux stay pure-Go cross-builds.
   - Rust is smaller (a hello world is 0.32 to 0.36 MiB), but its macOS and Windows targets need an Apple SDK or a
     MinGW/LLVM-MinGW linker that a Linux runner does not have.
   - A Node single executable is 119 MiB with a 59 MiB peak RSS, and its injector has had no release since 2023.
2. **What we give up is reuse of our TypeScript client.** The engine runner's `oauth4webapi` client does not come
   along. The agent assembles the two compact JWS (the `private_key_jwt` client assertion and the DPoP proof) over a
   maintained JOSE library. That is the same call ADR-0188 S7 point 7 made for the Kong adapter. The gateway stays the
   single verifier, and a conformance suite runs the real agent client against the real gateway.
3. **Own collectors, not osquery, inside the agent.**
   - Decision 19 says the agent collects "the same facts as the query pack and nothing more". An embedded osquery is a
     general SQL engine over hundreds of tables, so it would not hold that line by construction.
   - The facts are reads of known directories and manifest files plus the OS socket table: small code over
     `gopsutil` (BSD-3-Clause) and `golang.org/x/sys` (BSD-3-Clause).
   - Parity with the SD3 query pack comes from one signed collection manifest that both consume (§2.4).
   - Key detection uses patterns compiled into the agent from the gitleaks-derived `dlp.secret.*` set, never patterns
     taken from data (decision 5).
   - osquery's licence would not be the blocker: it is `Apache-2.0 OR GPL-2.0-only`, so we could take it under
     Apache-2.0.
4. **Enrolment is ADR-0188 S7 with a new workload kind, `endpoint_agent`.**
   - The agent creates its own key, hardware-bound where the hardware exists (owner decision d), and registers only
     the public JWK.
   - It takes short self tokens with `client_credentials` + `private_key_jwt` + DPoP (nonce required), and rotates at
     two thirds of the key's window.
   - Fleet enrolment uses an MDM-delivered per-org bulk token (owner decision c). An install-time step redeems it for a
     device-bound enrolment ticket, so the fleet secret is never readable by ordinary users (§3.2).
5. **Updates are signed twice.**
   - The OS signature (Developer ID plus notarisation, OV Authenticode, a signed Linux package) is what MDM and the OS
     check.
   - A RegulAIt Ed25519 release manifest in the ADR-0041 bundle format, checked against an agent keyring compiled into
     the agent, is what the agent checks before it offers a downloaded update. Self-update is off by default, and in
     v1 it only downloads, verifies and notifies; installing always goes through MDM (§4.1).
   - The SD3 query pack and the collection manifest are signed in the same ADR-0041 format under their own key id. A
     customer-side verify step ships with the pack, and the gateway also verifies the manifest when it serves or
     accepts it (§4.3).
   - `infra/release-keys/` is not touched.

## 1. Language and packaging

### 1.1 Requirements

These are taken from ADR-0195 decisions 18 to 20 and from ADR-0188 S7:

- **Targets:** macOS arm64 and x64, Windows x64 and arm64, Linux x64 and arm64.
- **Binary:** one small, static binary per platform, with no runtime to install and no network fetch at run time
  (air-gapped, pillar 3).
- **Build:** built in our CI, reproducibly, with a pinned toolchain whose licence fits ADR-0176.
- **Signing:** signable with Apple Developer ID (and notarised) and Windows Authenticode.
- **Crypto:** Ed25519 and P-256, RFC 7638 thumbprints, compact JWS for `private_key_jwt` and DPoP, and TLS 1.3.
- **OS access:** the OS keystores and key hardware (Secure Enclave, TPM, Keychain, DPAPI, Secret Service), and the OS
  socket and process tables.

### 1.2 Candidates

| | Go | Rust | Node single executable (SEA) |
|---|---|---|---|
| Toolchain licence | BSD-3-Clause | MIT OR Apache-2.0 | Node is MIT. The binary bundles V8 (BSD-3-Clause), OpenSSL (Apache-2.0), ICU (Unicode licence) and more, so the shipped closure is larger |
| Cross-compile from Linux | All six targets with the stock toolchain and `CGO_ENABLED=0`. **Measured** (§1.3) | Linux musl targets link with the bundled `rust-lld`. **Measured** for x64 and arm64. macOS needs an Apple SDK (or a zig-based linker). Windows needs MinGW or LLVM-MinGW (`*-windows-gnu`/`gnullvm`), or Microsoft's CRT and SDK fetched by a helper (`msvc`). None is in a stock Linux runner. **Pending**: not attempted here, because the container was short of disk and has none of those linkers | No real cross-compile. You inject a platform-independent blob into each platform's own `node` binary, which has to be downloaded and pinned per target. Built here for the host only |
| Binary size | 3.19 to 3.50 MiB for the probe | 0.32 to 0.36 MiB for a hello world. The probe was **pending** (not built, for disk) | 119.0 MiB on the host |
| Memory | 3.55 MiB peak RSS for the probe | **pending** | 59.2 MiB peak RSS for the probe |
| Crypto and JOSE | Standard library: `crypto/ed25519`, `crypto/ecdsa`, `crypto/tls` (TLS 1.3), `encoding/json`. JOSE: `go-jose/go-jose/v4` 4.1.6 (Apache-2.0, released 2026-10-14) or `lestrrat-go/jwx/v3` 3.3.0 (MIT, 2026-09-08) | `ed25519-dalek` 2.2.0 (BSD-3-Clause, 2025-07-09), `rustls`, `ureq` 3.1.2 (MIT OR Apache-2.0, 2025-09-08) | **Reuses our code**: `jose` 6.2.12 and `oauth4webapi` 3.8.8, the engine runner's client |
| Keystores | `zalando/go-keyring` 0.2.8 (MIT, 2026-03-23), `danieljoos/wincred` 1.2.3 (MIT, 2025-10-02), `godbus/dbus/v5` 5.2.4 (BSD-2-Clause, 2026-10-13), `google/go-tpm` 0.9.8 (Apache-2.0, 2025-12-29) | `keyring` 3.6.3 (MIT OR Apache-2.0, 2025-07-27) | None in the runtime. Native addons would break the single-file property |
| Sockets and processes | `shirou/gopsutil/v4` 4.26.9 (BSD-3-Clause, 2026-09-27) | `sysinfo` 0.37.2 (MIT, 2025-10-02) | Shell out, or a native addon |
| macOS signing | Go adds an ad-hoc signature to darwin/arm64 binaries itself. Developer ID signing and notarisation run as a normal Mach-O step | Normal Mach-O | The `node` binary's own signature must be removed before injection and the result re-signed. Node's documentation describes this; not executed here |
| Air-gapped build | Module proxy cache or `go mod vendor`; `go.sum` pins hashes | `cargo vendor`; `Cargo.lock` | pnpm store plus a pinned `node` per target |

Licences and release dates come from `api.deps.dev` and `proxy.golang.org`, both queried on 2026-10-17. GitHub's API
was not reachable from this container.

**Age against ADR-0176's 12-month rule, as of 2026-10-17:**
- **Go: `danieljoos/wincred` is borderline** (2025-10-02, about 12.5 months). SD4c re-checks it before pinning, or
  uses DPAPI directly through `golang.org/x/sys/windows`.
- **Rust: two of the crates above fail the rule.** `ed25519-dalek` 2.2.0 (2025-07-09) and `keyring` 3.6.3
  (2025-07-27) are more than 12 months old. `ureq` 3.1.2 and `sysinfo` 0.37.2 are within about 13 months. These are
  the latest versions deps.dev reported for the versions queried; newer releases were not looked up, because Rust is
  not recommended.

### 1.3 Measurements (executed)

- **Rust dependencies.** The Rust hello world has no crate dependencies, so its build resolved no crate versions. No
  `Cargo.lock` is committed, because the repo's basename-collision guard refuses one beside `Cargo.toml`.
- **Build flags.** Go used `-trimpath -ldflags "-s -w"`. Rust used `opt-level="z"`, LTO, `panic="abort"` and `strip`.
- **Formats.** The macOS and Windows binaries were built but not run (there is no such host here). `file` confirms
  their formats (Mach-O 64-bit x86_64/arm64, PE32+ x86-64/Aarch64). The Linux binaries are statically linked.

Sizes in bytes:

| Binary | darwin/arm64 | darwin/amd64 | windows/amd64 | windows/arm64 | linux/amd64 | linux/arm64 |
|---|---|---|---|---|---|---|
| Go hello | 1,572,562 | 1,560,016 | 1,531,904 | 1,486,848 | 1,433,784 | 1,441,976 |
| Go probe | 3,429,266 | 3,611,696 | 3,665,920 | 3,399,680 | 3,498,168 | 3,342,520 |
| Go probe, gzip -9 | 1,461,874 | 1,548,835 | 1,569,933 | 1,434,401 | 1,510,446 | 1,396,132 |
| Rust hello (musl) | pending | pending | pending | pending | 377,080 | 334,088 |
| Rust hello, gzip -9 | pending | pending | pending | pending | 188,565 | 181,295 |
| Node SEA probe | pending | pending | pending | pending | 124,783,808 | pending |
| Node SEA probe, gzip -9 | | | | | 41,478,561 | |

- **The probe is a floor, not the agent's size.** It holds the crypto core and an HTTPS client only. The agent adds a
  JOSE library, `gopsutil`, the keystore code, the collectors, the compiled key patterns and, on darwin, cgo and the
  Security framework bindings. Its size is **pending** until SD4c builds it. Use the probe only to compare languages.
- **Node SEA breakdown.** The host `node` 22.22.2 is 124,679,552 bytes, and the injected blob (the esbuild bundle of
  the probe plus `jose`) is 31,182 bytes. The runtime is 99.97 % of the file.
- **Peak RSS (linux/amd64, `peakrss/`).** The Go probe peaked at 3,632 KiB (3.55 MiB) and the Node SEA probe at
  60,652 KiB (59.2 MiB). The helper's own floor is 2,388 KiB, because Linux counts the parent's memory in a child
  started this way; the Go and Rust hello worlds both read exactly that. So only the probe and SEA figures mean
  anything.
- **Runs.** The Go probe and the Node SEA probe both printed a 43-character thumbprint and a 388-byte DPoP proof, so
  both crypto paths work on linux/amd64.
- **Build time.** Not a fair measure here. Each Go target compiled its standard library from cold, because the build
  cache was cleared between targets for disk, and that took about 40 s per target.

### 1.4 Why Go

- **The deciding property is cross-compilation and signing from CI.** Go is the only candidate that produced all six
  signable binaries here with no extra toolchain.
  - Hardware-bound keys by default (owner decision d) add a macOS runner for the darwin build. That runner also does
    `.pkg` building and notarisation, so it is needed either way.
- **Rust would win on size.** That does not matter at about 1.5 MiB gzipped. Rust's Windows targets would need an
  extra cross-linker toolchain to pin and audit.
- **Node SEA is ruled out on footprint.** It is 119 MiB per platform to push through MDM, and 59 MiB of RAM resident
  on every employee laptop.
- **Node SEA is also ruled out on maintenance.** `postject` 1.0.0-alpha.6 was published 2023-05-19, so it fails
  ADR-0176's 12-month rule. Newer Node lines reportedly build SEAs without postject; that was not verified here.
- **Node SEA would add an injection step to signing.** The base binary's signature has to be stripped and the result
  re-signed.
- **What Node would buy is reuse of `oauth4webapi`.** The protocol risk that reuse would remove is better handled by
  the conformance suite in SD4c, since the gateway is the verifier in every case.

**Go risks:**
- **Darwin needs cgo.** The Secure Enclave and Keychain key APIs (`SecKeyCreateRandomKey` with
  `kSecAttrTokenIDSecureEnclave`) need cgo, so darwin is a cgo build on the macOS runner (SD4j).
  - The software fallback is reached through `zalando/go-keyring`, which calls the `/usr/bin/security` tool. Before
    adopting it, SD4c checks how it passes the secret to that tool, because a secret on a command line is visible to
    other processes. That check is **pending**.
  - With cgo already present on darwin, the fallback can instead use the Security framework directly.
- **`kardianos/service` is Zlib-licensed.** Zlib is not on the ADR-0176 list, so we do not use it. Service
  registration is done by the installer packages (launchd plist, a scheduled task, a systemd user unit), which is how
  MDM expects it anyway.

## 2. Collecting the decision-18 facts

### 2.1 Run as the user, never as root (call 1)

Every decision-18 fact lives in the logged-in user's home or in world-readable system locations, except one: the
names of processes owned by other users that hold a listening port. So the agent runs **only as the logged-in user**:

- macOS: a LaunchAgent;
- Windows: a per-user scheduled task at logon;
- Linux: a systemd `--user` unit.

It needs no elevation. A listening port owned by another user is still reported, with its port and address, but
without the process name. That is the only gap, and posture says so. **There is no root/SYSTEM component in v1**
(call 1).

The package installer runs as root once, at install time, because MDM installs packages that way. It is not a
resident component. Its only job beyond copying files is redeeming the enrolment token (§3.2).

### 2.2 Per fact, per OS

"User" means the logged-in user, with no elevation. Paths are the documented defaults. The agent hard-codes no
product names: each catalogue entry in the signed collection manifest (§2.4) names the exact paths, globs and names.

| Fact (decision 18) | Signature kind (decision 5) | macOS | Windows | Linux |
|---|---|---|---|---|
| Installed AI desktop apps | `desktop_app` | Bundle IDs from `Info.plist` in `/Applications` and `~/Applications` | Uninstall registry keys `HKLM\…\Uninstall` (readable by users) and `HKCU\…\Uninstall`; per-user installs under `%LOCALAPPDATA%\Programs` | `.desktop` files in `/usr/share/applications` and `~/.local/share/applications`; Flatpak and Snap metadata dirs |
| IDE extensions | `ide_extension` | `~/.<editor>/extensions/*/package.json` for VS Code-family editors; JetBrains `plugins` dirs under `~/Library/Application Support/JetBrains/*` | `%USERPROFILE%\.<editor>\extensions`; `%APPDATA%\JetBrains\*\plugins` | `~/.<editor>/extensions`; `~/.local/share/JetBrains/*` |
| Browser extensions | `browser_extension` | Chromium-family `…/<Profile>/Extensions/<id>/<ver>/manifest.json`; Firefox `extensions.json` in each profile; Safari app extensions through their containing apps | The same under `%LOCALAPPDATA%` and `%APPDATA%` | The same under `~/.config` and `~/.mozilla` |
| Local model runtimes and their listening ports | `local_runtime` | Process table plus socket table: `gopsutil` `net.Connections` over `proc_pidinfo`. Other users' sockets: port only | `GetExtendedTcpTable` gives the owning PID for every listener without elevation. The image name of an elevated process may need `PROCESS_QUERY_LIMITED_INFORMATION`, which usually works | `/proc/net/tcp{,6}` is world-readable. Mapping an inode to a PID needs the same uid, so other users' sockets give the port only |
| AI tool configuration (MCP server configs, assistant instruction files, config files with key names) | `assistant_config` | Manifest-listed files and globs in the home directory, parsed for key **names** | The same | The same |
| AI CLIs | `cli` (proposed, see below) | Executables on the user's `PATH` and in package-manager bin dirs, matched by name and, where the catalogue gives one, by a package manifest | `PATH`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs` | `PATH`, `~/.local/bin`, `~/.npm-global` |
| Env var **names** | `env_name` (proposed, see below) | Names from shell start-up files (`~/.zshrc`, `~/.bash_profile`, `~/.profile`, fish config). `launchctl getenv` only for names the manifest lists; it returns a value, which is used only for the on-device key check and discarded immediately, never stored, logged or buffered | `HKCU\Environment` and `HKLM\…\Session Manager\Environment` (names), PowerShell profile files | Shell start-up files, `~/.config/environment.d/*.conf` |

**Kind names follow ADR-0195 decision 5:** `desktop_app`, `ide_extension`, `browser_extension`, `local_runtime` and
`assistant_config`. Decision 18 also covers AI CLIs and environment variable names, which have no decision-5 kind.
So `cli` and `env_name` are **proposed additions**. They are coordinated with SD3's catalogue seed and added by SD0
or SD3, not by the agent. Until they exist, a CLI or env-name hit is reported as an unmatched observation in
`deploymentCatalogueGaps` (decision 5).

### 2.3 Key detection and redaction on the device (call 2)

- **No value leaves the device.** A detected key becomes `{signatureId, provider, file or variable name, key name,
  present: true}`. Key presence only, no prefix (call 2).
- **The key patterns are compiled into the agent, not delivered in the manifest.** They come from the gitleaks-derived
  `dlp.secret.*` set in `packages/shared/src/guardrails.ts`, as decision 11 requires, and run under Go's RE2 engine.
  The manifest carries only paths, globs and names, never a regular expression (decision 5: no regex taken from data).
  - SD4d generates the Go table from the shared source at build time, with a test that runs the same vectors through
    both.
  - RE2 has no lookaround, and at least one shared rule uses a lookbehind (`dlp.secret.jwt`). That rule needs an
    RE2-safe rewrite with the vector test proving the same matches. SD4d checks every rule for this.
- **Reads are bounded.** The agent reads at most the manifest-listed files, caps each read (for example 256 KiB), and
  never follows symlinks out of the home directory. File contents are held only in memory for the match.
- **What is digested.** The report carries the SHA-256 of the **redacted fact set** it sends, not of the raw collector
  output. A digest of raw output that contains a key would be a stable fingerprint of that key.

### 2.4 One signed collection manifest shared with SD3

The facts the agent may collect are data, not code. That data is a versioned collection manifest: catalogue entries
with their decision-5 kind (plus the proposed `cli` and `env_name`), per-OS paths, globs, names and port hints. It is
signed in the pack format of §4.3, and the gateway serves it.

- **The agent refuses** an unsigned manifest, a manifest older than the one it holds, a manifest with an unknown kind,
  and any field that looks like a pattern rather than a path, glob or name.
- **The SD3 query pack is generated from the same manifest.** A CI parity test runs both over the same fixture home
  directory and requires identical fact sets. That turns "the same facts as the query pack and nothing more"
  (decision 19) into a test.
- **The catalogue extension is SD0's and SD3's.** `SHADOW_AI_CATALOG_V1` has only `endpoint` and `sdk` kinds today
  (`packages/shared/src/shadow-discovery.ts`). SD0 adds the decision-5 kinds; SD3 seeds them, including the entries
  ADR-0195's open-source evaluation imports.

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
   our own allow-list in front of a general engine, which is harder to review than a fixed collector set.
2. **Footprint and patching.** Embedding osquery makes its release cadence and CVEs our security-response commitment,
   and multiplies the binary size. The size of an osqueryd build was **pending** (not downloaded, for disk).
3. **Privilege.** osquery's user-data tables read other users' homes only as root, and v1 has no root component
   (call 1).

**ADR-0176 §4's narrow exception applies.** The unmet hard requirement is "a fixed, minimal fact set enforced by
construction" (decision 19) plus a stricter security posture (no elevation). It is re-checked if osquery gains a way
to restrict an embedded instance to a fixed table set. `osquery/osquery-go` (MIT) would matter only if the agent
became an osquery extension, which it does not.

## 3. Enrolment and transport (ADR-0188 S7 reused)

### 3.1 Device key, keystore and threat model (owner decision d)

| OS | Default: hardware-bound | Fallback where no hardware exists (posture: "device key: software") |
|---|---|---|
| macOS | A **P-256** key created in the Secure Enclave, so `ES256`. Not exportable. Needs cgo and a Developer ID-signed binary, built on the macOS runner | A key in the user's login keychain |
| Windows | A **P-256** key in the TPM 2.0 through the Platform Crypto Provider (NCrypt), so `ES256`. Not exportable. Reachable through `golang.org/x/sys/windows` syscalls without cgo; **pending** a proof | A key protected with DPAPI (`CryptProtectData`, user scope), blob in `%LOCALAPPDATA%\RegulAIt\agent\` |
| Linux | A **P-256** key in the TPM through `google/go-tpm` against `/dev/tpmrm0`, **only where the user can already reach that device**. Most distributions limit it to root and the `tss` group, so the default is the software fallback. An admin may opt in to a package rule that adds console users to `tss` (an audited relaxation). That rule grants every member raw access to the TPM resource manager: creating and using keys, and reading PCRs and other TPM state, not only the agent's key | Secret Service over D-Bus (`godbus/dbus`) when a desktop session offers it; otherwise a file opened `O_NOFOLLOW`, created exclusively with mode 0600 in `$XDG_STATE_HOME/regulait-agent/` (the S7 runner's `runner-key` pattern and `ensureInstallKeyFile` semantics) |

**One algorithm for the kind.** Secure Enclave and TPM keys are P-256, not Ed25519, so the agent uses `ES256` for
both the hardware key and the fallback, keeping one signing path.

- ADR-0188 decision 13's algorithm list already allows `ES256`. S7 as built registers Ed25519 runner keys only, so
  SD4b extends registration and the self-token grant to accept `ES256` keys for `endpoint_agent`.
- Posture shows the key protection of each device (hardware or software), as owner decision d requires.

**Threat model: same-user malware.** The agent runs as the user, so anything else running as that user shares its
privileges.

- **With a software key**, malware running as the user can read the key from the keychain item, the DPAPI blob or the
  file, copy it off the device, and impersonate **that one device** on the `endpoint-agent` routes from anywhere until
  an admin revokes the device. Earlier drafts implied that a keychain item is limited to the signed agent; that is not
  claimed. What the impersonator can do is bounded by the routes: submit or suppress that device's reports, and read
  the collection manifest. It cannot read other devices' data or reach any other route (`403 workload_scope`).
- **With a hardware key**, the key cannot be copied. Same-user malware can still ask the OS to sign with it while it is
  running on the device, so it can forge reports from that device, but it cannot keep doing so once removed from the
  device. This is why hardware binding is the default (owner decision d).
- **Neither variant protects a device whose user account is compromised.** Revocation is the remedy, and posture and
  the devices page make it one action.

### 3.2 Enrolment (owner decision c, call 6)

**What the token is.**
- One bulk token per org and discovery source, delivered by MDM.
- The admin must set the device cap; there is no unlimited default (call 6).
- Expiry defaults to 30 days; lengthening it is an audited relaxation (call 6).
- Revocation costs nothing.
- Issuing a token is a `settings_relax`-class step-up, since enabling the source already is one, and every use is
  audited.
- Rotation is by MDM re-push of a new token. The old token is revoked when the admin chooses, and devices already
  enrolled are unaffected.

**Keeping the token from users.** The fleet token must not be readable by ordinary users on any device, so it is
delivered to a root-only location:
- macOS: a configuration profile payload, or a root-owned 0600 file placed by MDM;
- Windows: a registry key or file ACL'd to SYSTEM and Administrators;
- Linux: `/etc/regulait-agent/enrol.json`, root:root 0600.

The user-context agent cannot read it either. So the package's install-time step, which runs once as root under the
MDM installer, does the redemption:

1. **Redeem only when needed.** If the device already holds a valid, unexpired ticket, the step does nothing more.
   Otherwise it reads the bulk token and calls `POST /v1/endpoint-agent/enrolment-tickets` with the token, a device
   hostname (sent only to be keyed-hashed and encrypted server-side, call 3) and the OS/arch.
2. The gateway checks the token and the cap, counts one device, and returns an **enrolment ticket for this device**:
   - one device record;
   - a small identity cap (for example 8 users);
   - expiring in 7 days.
3. **The ticket file is restricted, not world-readable.**
   - Linux and macOS: root-owned, mode 0640, group `regulait-agent`, which the package creates and fills with the
     console users present at install (plus any users the admin adds through MDM).
   - Windows: an ACL granting SYSTEM full control and `INTERACTIVE` (console users) read.
   - The bulk token is never written anywhere else.
4. **An MDM install or upgrade never fails because redemption failed.** If the gateway is unreachable or refuses, the
   step logs the reason, writes a local status the agent reports, and exits 0. Posture shows the device as "not
   enrolled: ticket redemption failed (<reason>)". A failed redemption must not block a security upgrade of the agent
   itself. There is no resident retry component (call 1).

**What a leaked ticket allows, stated plainly.** The ticket is a bearer secret readable by every member of the
agent's group on that device, and it is not hardware-bound. Anyone who copies it can, from **any** machine and until
it expires (7 days) or is revoked, register up to the identity cap (8) as identities of that device. Those identities
can then submit or suppress that device's reports. That is a much smaller blast radius than the fleet token (one
device, not the fleet), but it is not "only on that device". The controls:

- every registration is audited against the ticket id;
- the admin is alerted when a ticket is redeemed or used to register from a network origin not seen before for that
  ticket (the source address seen at the gateway, after the trusted-proxy rules);
- a ticket, or every identity it registered, is revocable in one action;
- binding the ticket to the device's hardware (a TPM- or Secure Enclave-attested ticket) is an open question for a
  later slice (SD4n).

**New tickets after expiry or rotation.**
- A ticket that expires unused, or that is exhausted, is replaced at the next install-step run. That happens when MDM
  re-pushes the package or the admin re-pushes a fresh bulk token (the rotation path, call 6). It redeems a new
  ticket only if the device holds no valid one.
- **Late first login.** A user who first logs in after the ticket expired, or who was not a console user at install
  and so is not in the group, cannot enrol yet. The agent says so locally and records "waiting for enrolment ticket".
  The next MDM re-push adds current console users to the group and redeems a fresh ticket.
- Posture lists devices whose ticket expired with fewer identities than console users, so the admin knows a re-push
  is due.

**Registration.** On first run as each user, the agent creates its key (§3.1) and sends `POST
/v1/endpoint-agent/register` with `{ticket, jwk (public), agentVersion, os, arch, deviceUser}`.

- Registration creates an identity of kind `endpoint_agent` through `ensureIdentityFor` and binds the key through S6's
  one binding path (one key, one identity, ever).
- Re-registration of the same device and user proves possession of the old key, as S7 point 3 does.
- **`deviceUser` is self-reported** by the device and is not authenticated. The gateway keyed-hashes it and stores the
  display name encrypted (call 3). The reveal UI labels it "self-reported by the device". Findings are attributed to
  the device identity, never to a person account.

**Cap alerting.** The admin is alerted when a bulk token reaches 80 % and 100 % of its device cap. At the cap, ticket
requests are refused (`409 enrolment_cap_reached`) and audited, so a leaked token shows up as an unexpected climb.
Admins see enrolments per token and revoke them in bulk.

### 3.3 Tokens and routes

- **Token.** RFC 6749 `client_credentials`, with client authentication by `private_key_jwt` (RFC 7523) signed by the
  device key, and a DPoP proof (RFC 9449) by the **same** key (`dpop_key_mismatch` otherwise).
  - The gateway nonce is required. The `resource` is `<issuer>/v1/endpoint-agent` (RFC 8707).
  - This is S7 point 1 with `endpoint_agent` added to the kinds allowed this grant, and `ES256` accepted for it.
  - The token resolves to `via: "endpoint-agent"`, which reaches only the token-authenticated routes below. Anything
    else answers `403 workload_scope`.
- **Rotation.** At `regulait_credential_rotate_after` the agent sends `POST /v1/endpoint-agent/credentials`. This is S7
  point 4 unchanged: at most two live keys, and lost-answer recovery by trying the next key. A hardware key rotates by
  creating a new hardware key.

**Routes.** The first two take no access token: one authenticates with the bulk token, the other with a device ticket.
The rest need the `via: "endpoint-agent"` token and are rate-limited in the `cred:wid:<identityId>` bucket.

| Route | Authenticated by | Purpose |
|---|---|---|
| `POST /v1/endpoint-agent/enrolment-tickets` | Bulk token | Install-time redemption for a device ticket (§3.2) |
| `POST /v1/endpoint-agent/register` | Device ticket | Per-user registration of a device key |
| `POST /v1/endpoint-agent/credentials` | Agent token + proof by the new key | Key rotation |
| `GET /v1/endpoint-agent/config` | Agent token | Signed collection manifest, schedule, buffer limits |
| `POST /v1/endpoint-agent/reports` | Agent token | One fact snapshot: `{snapshotId, collectedAt, manifestVersion, facts[], factsDigest}`. Idempotent on `snapshotId`. Merged into `shadow_ai_findings` with signal source `endpoint_agent` and subject kind `device` (decision 5a) |
| `GET /v1/endpoint-agent/releases/current` | Agent token | Signed release manifest for the agent's platform (§4); used only if self-update is enabled |

- **Admin side:** list devices (pseudonymous), revoke a device (which revokes its identity and live tokens, S7 point
  2), revoke a bulk token or a device ticket, and reveal a device user or hostname under `pseudonym_reveal` step-up.
- **Transport.** HTTPS only, to the configured issuer only (decision 19: "sends only to the org's gateway"), TLS 1.3
  minimum.
  - The OS trust store is used, plus an optional pinned CA bundle for private PKI, which air-gapped installs need.
  - The OS or `HTTPS_PROXY` proxy settings are honoured, because corporate networks need them; PAC files are out of
    scope for v1.
  - The agent never falls back to another address, as S7 point 6 requires for runners.

### 3.4 Retention, offline buffering and schedule (decision 20)

- **Retention.** Endpoint evidence (agent reports and the observations they carry) is kept for **90 days** by default.
  Lengthening it is an audited relaxation; shortening it is free. SD4b enforces it with the same sweep the other
  evidence retention uses, and SD4e shows it on the devices page and in the employee-notice template.
- **Snapshots, not events.** The agent reports snapshots of state, so a missed report loses nothing that the next
  snapshot does not restate.
- **Buffer.**
  - Up to 7 snapshots or 1 MiB on disk, whichever comes first.
  - Encrypted with a **separate storage key**, never with the signing key: a signing key cannot encrypt, and keeping
    the two apart limits each key's use. The storage key is:
    - on macOS, a Secure Enclave P-256 key-agreement key used for ECIES
      (`SecKeyCreateEncryptedData` with an `eciesEncryption…AESGCM` algorithm);
    - on Windows, a TPM storage key, or DPAPI where there is no TPM;
    - on Linux, a TPM storage key where the TPM is reachable, otherwise a key held in Secret Service or a 0600 file.
  - The buffer file is written with the same 0600 and no-follow rules.
  - When it is full, the oldest snapshot is dropped and a drop counter goes with the next report, so the gap is
    visible rather than silent.
  - Snapshots are already redacted (§2.3), so the buffer holds no value.
- **After an outage.** The latest snapshot goes first. Older ones are sent only when they differ, which keeps
  first-seen and last-seen dates honest.
- **Schedule.** Daily by default (decision 9), with ±30 min jitter so a fleet does not stampede the gateway after an
  office opens. Exponential backoff with a cap on 429 or 5xx.
- **Relaxable limits.** All of these are manifest-delivered settings, so an admin can change them without a release. A
  longer buffer is a relaxation, because it holds more data on the device.

## 4. Signing: agent releases, the query pack, and MDM distribution

### 4.1 Agent releases: two signatures, two jobs

1. **The OS signature** is checked by the OS and the MDM before the agent ever runs. This is what MDM-driven updates
   rely on. The running agent cannot verify a replacement that MDM installs, and does not try.
   - Apple: a Developer ID Application signature on the binary and a Developer ID Installer signature on the `.pkg`,
     notarised and stapled. The signing identity lives in a protected CI secret store used only by release jobs
     (owner decision a).
   - Windows: OV Authenticode on the `.exe` and the `.msi`, with the key in a cloud HSM-backed key service called from
     CI (owner decision b).
   - Linux: `.deb`/`.rpm` signed with a package-signing key.
2. **The RegulAIt release manifest** is checked by the agent itself, and only when self-update is enabled. It is the
   ADR-0041 update-bundle format (`scripts/verify-update-bundle.sh` semantics):
   - a manifest with `version`, `minInstalledVersion`, per-file SHA-256, `platform` and `signingKeyId`;
   - an Ed25519 signature over the manifest;
   - the key pinned in an agent keyring **compiled into the agent**;
   - downgrades refused, a minimum version enforced, and unknown files refused.

   The agent fetches the update only from its own gateway (`/v1/endpoint-agent/releases/current`), never from the
   internet, so air-gapped installs work. **In v1 self-update only downloads, verifies and notifies.**
   - It verifies the manifest and every digest.
   - It keeps the verified, OS-signed package in its own directory.
   - It tells the user (a local notice) and the admin (posture: "update downloaded and verified, waiting for MDM").
   - Installing always goes through MDM. A user-context agent cannot install a per-machine package, and a privileged
     helper that could is out of scope: it would bring back the resident root component that call 1 rules out.

### 4.2 Why this scheme, and what was compared

| Option | Licence and maintenance | Fit |
|---|---|---|
| **ADR-0041 manifest + Ed25519 (decided for v1)** | Our format. Go verification uses the standard library `crypto/ed25519` | Already specified, already has a rotation procedure that works offline (`infra/release-keys/README.md`), and our CI already builds and verifies it |
| TUF (`theupdateframework/go-tuf/v2` 2.4.2, Apache-2.0, 2026-05-19) | Maintained | Adds signed expiry (freeze-attack protection), threshold signing and in-band root rotation. Worth adopting if self-update becomes common; it is a larger key ceremony |
| Sigstore (`sigstore-go` 1.3.0, Apache-2.0, 2026-07-30) | Maintained | Keyless signing needs Fulcio and Rekor online, which fails air-gapped. Keyed bundles work offline but add nothing over Ed25519 here. Our images keep cosign (ADR-0184) |
| minisign (`jedisct1/go-minisign`, MIT) | Only a pseudo-version (2026-05-27), no tagged release | Simple, but no tagged releases to pin |

**Keys (call 4).**
- The agent gets **its own key id namespace** (for example `regulait-agent-release-<id>`) and its own keyring compiled
  in, separate from the ADR-0041 control-plane key.
- It uses the same offline ceremony and the same rotation order: ship the new public key in a release signed by the
  old one, and never collapse those steps.
- Nothing is added to or changed in `infra/release-keys/`.
- Why separate: the agent runs on employee laptops at a very different scale and threat level from a control-plane
  bundle, and a compromise of one key should not cover both.

ADR-0041's caveats carry over unchanged. There is no revocation list (air-gapped boxes cannot check one), and a signed
old release is still old, which is why downgrades are refused.

**Self-update** is off by default. Enabling it, which in v1 means download, verify and notify, is a `settings_relax`
step-up per org, and it is audited. With it off, the agent only reports its version, and posture shows devices
behind the current release.

### 4.3 The query pack and collection manifest (decision 18 deliverable)

Decision 18 leaves the pack's signing mechanism to this spike. Decided:

- **Format.** The same ADR-0041 manifest format, Ed25519: a manifest listing each pack file (the osquery pack JSON,
  the collection manifest, the importer column map) with its SHA-256, plus `version`, `minInstalledVersion` and
  `signingKeyId`, signed over the canonical manifest.
- **Key.** Its **own key id**, for example `regulait-pack-<id>`, separate from the agent release key (call 4) and from
  the ADR-0041 control-plane key. A pack key compromise then cannot ship agent code, and the reverse.
- **Verification on the no-agent path, in two places:**
  1. **On the customer side, before the pack is deployed.** A small verify step ships with every pack: a static Go
     binary built from the agent's own verifier code, plus the pinned pack public keys. It checks the signature, every
     digest and the version, and refuses unknown files, before the customer hands the pack to their MDM or EDR. The
     pack's README tells the customer to run it, and the MDM wrapper scripts call it first.
  2. **On the gateway.** When the gateway serves the collection manifest to agents (`GET /v1/endpoint-agent/config`)
     and when it accepts an uploaded pack manifest or a results import that names a pack version, it verifies the
     signature against the same pinned keys, then records the pack version and digest on the scan run. An import that
     names an unsigned or unknown pack version is refused.
- **SD3's signer hook plugs into this.** SD3 builds the pack, then calls one signing step (the SD4g pipeline's
  `sign-manifest` stage) with the pack key id. No second signing mechanism is written.

### 4.4 MDM distribution formats and build tooling

| OS | Package | Configuration | Build tooling (build-time only, not shipped) |
|---|---|---|---|
| macOS | Signed, notarised flat `.pkg` installing the binary and a LaunchAgent plist; its install step redeems the enrolment token (§3.2) | A configuration profile (`.mobileconfig`) with managed preferences (issuer, CA bundle); the bulk token in a root-only payload or file | `pkgbuild`/`productbuild`/`productsign` and `notarytool` on the macOS runner (needed anyway for the cgo darwin build). `rcodesign` (in `indygreg/apple-platform-rs`, MPL-2.0) can sign and notarise Mach-O binaries from Linux; whether it signs a flat `.pkg` was **pending** |
| Windows | OV Authenticode-signed `.msi`, a per-machine install that registers the per-user logon task and redeems the token | MSI public properties or registry policy (`HKLM\SOFTWARE\Policies\RegulAIt\Agent`) for the issuer and CA bundle; the bulk token ACL'd to SYSTEM and Administrators | WiX Toolset (MS-RL) builds the `.msi`. Authenticode signing: **`jsign`** (Apache-2.0, Java), which can sign with a cloud HSM-backed key. Its latest release date was not retrieved here; SD4h checks it against the 12-month rule before pinning. `sassoftware/relic` 8.2.0 (Apache-2.0) was considered and **fails** the rule: its last release is 2025-01-17, about 21 months ago. `osslsigncode` is GPL-3.0 and is not used |
| Linux | `.deb` and `.rpm` with a systemd user unit; the `tss` group rule only when the admin opts in (§3.1) | `/etc/regulait-agent/config.json` (0644, no secrets) and `/etc/regulait-agent/enrol.json` (root:root 0600, the bulk token) | `goreleaser/nfpm/v2` 2.48.0 (MIT, 2026-10-12), which builds and signs both. `goreleaser` 2.18.3 (MIT) can drive the whole release |

**ADR-0176 build-tool exceptions (call 5).** Two tools are accepted as written exceptions:
- **WiX Toolset.** MS-RL, and its project announced a maintenance-fee condition for commercial use of recent major
  versions (not re-checked here; SD4h confirms the terms before pinning).
  - **Unmet requirement:** no MIT, Apache-2.0, BSD or ISC tool builds a Windows Installer package. `msitools`' `wixl`
    is LGPL-2.1, which is no better.
  - **Why acceptable:** it runs only in the release job, its output (our `.msi`) is not covered by its licence, and no
    WiX code is shipped.
- **`rcodesign`.** MPL-2.0.
  - **Unmet requirement:** no permissively licensed tool signs and notarises Mach-O binaries from Linux.
  - **Why acceptable:** it is a build tool, its output is not covered, and nothing of it is shipped. It is optional
    while the macOS runner exists, and is kept as the Linux-only fallback.

Both exceptions are re-checked when the ecosystem changes, as ADR-0176 requires.

**Certificates.** Since 2023 the CA/Browser Forum rules require code-signing private keys to live in hardware. Owner
decision b meets that with a cloud HSM-backed key service. Owner decision a puts the Apple identity in a CI secret
store that only release jobs can read.

## 5. Proposed slices

| Slice | Delivers | Depends on | Owner input |
|---|---|---|---|
| **SD4a** ADR amendment | The "Owner decisions (2026-10-17): endpoint agent and detection data" section of ADR-0195 (appended with this spike) and the remaining details from this note | this spike | given (§0) |
| **SD4b** Gateway side | Workload kind `endpoint_agent` with `ES256`; bulk tokens (admin-set cap, 30-day default expiry, cap alerts) and device tickets; the `/v1/endpoint-agent/*` routes; `via: "endpoint-agent"` scope; rule ids; posture rows (key protection, devices behind release); 90-day endpoint retention (lengthening is a relaxation); a migration (number assigned by the master) | SD0 on main; ADR-0188 S7 | none |
| **SD4c** Agent core | A Go module outside the pnpm workspace (for example `agents/endpoint/`): config, keystore abstraction (fallback file 0600, Keychain, DPAPI, Secret Service), RFC 7523 + RFC 9449 client over `jwx` or `go-jose`, rotation, a conformance suite against the real gateway in CI (Docker in CI), and a `THIRD_PARTY.md` | SD4b | none |
| **SD4d** Collectors | The per-OS collectors in §2.2 driven by the signed collection manifest; key patterns compiled from `dlp.secret.*` into Go RE2, with the vector test; on-device redaction; the parity test with the SD3 query pack on fixture home directories | SD0's signature kinds, SD3's seed (including `cli` and `env_name` if adopted), SD4c | none |
| **SD4e** Privacy | Server-side keyed hash and encrypted display name for device users **and hostnames**, the `pseudonym_reveal` step-up and audit, the "self-reported" label, 90-day retention on the devices page, and the employee-notice template (decision 20) | SD0's pseudonym table, SD4b | none |
| **SD4f** Buffering and schedule | §3.4: snapshot buffer, drop counter, jitter, backoff, manifest-delivered limits | SD4c | none |
| **SD4g** Release and pack signing pipeline | Reproducible `-trimpath` builds for six targets; a CycloneDX SBOM; a Go licence check (allow-list as ADR-0176); the `sign-manifest` stage producing ADR-0041 manifests under the agent release key id **and** the pack key id; the customer-side pack verify binary; gateway-side pack verification on serve and on import; the hook SD3 calls. Signing stays pending until the keys exist | SD4c (verifier code), SD3 (the pack) | none |
| **SD4h** Packages and OS signing | `.pkg` + configuration profile on the macOS runner, `.msi` with WiX, `.deb`/`.rpm` with nfpm; install-time token redemption; Developer ID signing and notarisation from the CI secret store; OV Authenticode through `jsign` and the cloud HSM key service | SD4g | none (decisions a, b) |
| **SD4i** Self-update (download, verify, notify) | The optional, step-up-gated path of §4.1: fetch from the gateway, verify the manifest, refuse downgrades, keep the verified package, notify the user and the admin. Installs stay with MDM; no privileged helper | SD4g, SD4h | none |
| **SD4j** Hardware-bound keys | `ES256` signing keys and separate storage keys in the Secure Enclave (cgo, macOS runner) and the Windows TPM (NCrypt) as the default; the Linux TPM where `/dev/tpmrm0` is already reachable, and the audited `tss` opt-in; the software fallback flagged in posture. Built with SD4c, not after it, because hardware binding is the default | SD4c | none (decision d) |
| **SD4n** Hardware-bound enrolment tickets | Bind the device ticket to the device's TPM or Secure Enclave (an attested ticket), so a copied ticket is useless off the device | SD4b, SD4j | open question: attestation formats per OS, and whether it is worth the complexity given the controls in §3.2 |
| **SD4k** Admin UI | A devices page (pseudonymous, key protection, version), revoke device, revoke bulk token or ticket, cap alerts, reveal under step-up; KNOWN_UI_GAPS stays 0 | SD4b, SD4e | none |
| **SD4l** Security review and support policy | An external review of the agent, enrolment and update path; a supported OS version matrix; a vulnerability response process (the ADR's "long-term commitment") | SD4h | supported OS matrix |

- SD4b and SD4c (with SD4j) can run in parallel once the route and token contract in §3.3 is in the ADR.
- SD4d needs SD0's kinds and SD3's seed first.
- SD4h needs the certificates and the CI secret stores provisioned.
- The root/SYSTEM component of the earlier draft is dropped from v1 (call 1).

**Still open (not blocking the build):**
- the supported OS version matrix (SD4l);
- whether `cli` and `env_name` become signature kinds (coordinated with SD3);
- the `jsign` release date and the WiX licence terms, checked before pinning (SD4h);
- hardware binding of the enrolment ticket (SD4n).

## 6. What was not verified here

- **Not built:** Rust for macOS and Windows, a Rust probe with TLS and JOSE, and Node SEA for any non-host platform.
  The container had about 0.3 to 0.7 GB of free disk, shared with other sessions, and no MinGW, LLVM-MinGW or Apple
  SDK. The real agent's size is not known yet (§1.3).
- **Not run:** no macOS or Windows binary was run, and nothing was signed or notarised (no certificates exist yet).
- **Not checked:**
  - how `zalando/go-keyring` passes secrets to `/usr/bin/security`;
  - whether `rcodesign` signs flat `.pkg` files;
  - TPM key creation through NCrypt from pure Go;
  - Secure Enclave key creation from a Developer ID-signed command-line agent;
  - the size of an osqueryd build;
  - which `dlp.secret.*` rules besides `dlp.secret.jwt` need an RE2 rewrite.
- **Not retrieved:** the dates of osquery 5.16.0 and of the latest `jsign` release. GitHub's API was not reachable from
  this container, so maintenance dates come from deps.dev and the Go module proxy only.

## Sources

- ADR-0195 decisions 2, 5, 5a, 6, 9, 11, 18 to 20 and slice SD4; ADR-0188 decisions 10 to 13 and "As built: slice
  S7"; ADR-0176; ADR-0180; ADR-0041 and `infra/release-keys/README.md` (read only); `scripts/verify-update-bundle.sh`.
- `packages/shared/src/shadow-discovery.ts` (catalogue kinds); `packages/shared/src/guardrails.ts` (`dlp.secret.*`);
  `apps/gateway/src` engine-runner routes (route shape).
- osquery `LICENSE`, `CHANGELOG.md` and `specs/*.table` on `master` (raw.githubusercontent.com, 2026-10-17).
- Licences and release dates: `api.deps.dev` v3 (Go, npm, Cargo) and `proxy.golang.org/@latest`, 2026-10-17.
- Measurements: `spikes/sd4-endpoint-agent/` scripts, run in this container on 2026-10-17.

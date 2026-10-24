# R13 — ADR-0190 isolation backends, I0 spike

Checked 2026-10-10 UTC against ADR-0190 (accepted 2026-10-10) slice **I0**. Reproducible source:
[`spikes/isolation-i0`](../../spikes/isolation-i0/README.md), raw output in its `evidence/` folder. No product code
changed.

**Where it ran.** A cloud container: root inside a microVM guest (kernel `6.18.44`, 4 vCPU, 16 GiB, cgroup v1 hybrid),
**no Docker daemon, no `/dev/kvm`** (no `vmx`/`svm` CPU flag; the `kvm` core module is loaded but no vendor module and
no device node). Load average was about 17 during the timed runs (other sessions share the machine), so every timing
below is an upper-side figure, not a benchmark. Everything a compose file, a Kubernetes node or KVM would be needed for
is listed under "Needs a real host or CI" and was **not** run.

## Verdicts

| Item | Verdict | One-line reason |
|---|---|---|
| 1. gVisor (`runsc`) as the L2 backend | **GO**, with the five configuration amendments below | Every decision 6 probe ran under gVisor with a control that flipped it; offline install from the verified tarball works; no KVM needed |
| 2. Kata Containers as the L3 backend | **Not testable here; no change to the decision** | No `/dev/kvm`. Survey facts re-confirmed from upstream; host and CI requirements listed below |
| 3a. OpenShell as an optional backend | **GO for L1 (Docker/Podman/Kubernetes drivers) and L3 (MicroVM driver) only; NO-GO for L2 "under runsc"** | OpenShell's mandatory sandbox baseline (Landlock ABI ≥ 3, seccomp user notification) is absent inside gVisor (measured) |
| 3b. Owner decision 7 (interceptor over `unix://`) | **GO** | The gateway accepts `unix://` interceptor endpoints **with** its EdDSA token; nothing forces a network listener on our side |
| 3c. OpenShell telemetry and egress defaults | **Conditional**: only a telemetry-free build may be admitted | Telemetry is compiled in and **on by default** in the default build, sending to a hard-coded publisher endpoint |
| 4. Survey re-check | **Done**; four corrections | All seven projects re-checked from upstream git; no licence changed |

## 1. gVisor

### Install path (offline)

- The release bucket no longer publishes a standalone `runsc`: the last release with an `x86_64/runsc` object is
  `20260817.0`. Since `20260824` each release ships only `gvisor.tar.bz2` / `gvisor.tar.zstd` with `.sha512` files.
  This confirms the mailing-list note in the ADR's survey (it was secondary; it is now primary).
- The tarball holds `runsc`, `containerd-shim-runsc-v1` and a `gvisor-bin/` directory of **sidecars**
  (`gvisor_sentry`, `gvisor-sentry-prewarmer`, `runsc-fd-parking`, `runsc-metric-server`, `checkpointgofer`). `runsc`
  boots the Sentry from `gvisor-bin/gvisor_sentry`; copied alone it refuses to start ("sidecar "gvisor_sentry" not
  usable … --sidecar-usage-policy is set to STRICT"), and `runsc flags` says the embedded fallback "will stop working
  after 2026-10". **The tarball is the install unit**, not a binary.
- Pinned: `release-20261005.0`, `gvisor.tar.bz2` sha512 `79869ae9…aad198c8fe` (full hashes in
  `spikes/isolation-i0/THIRD_PARTY.md`), verified against the published `.sha512` and against the pinned value by
  `fetch-gvisor.sh`, which was run end to end. No runtime fetch was seen: the only URLs in the debug logs are gVisor's
  "unimplemented syscall" documentation links. The Debian APT package path was **not** tried.
- With `--directfs=false` the sidecars must sit on a path an unprivileged user can traverse (`0700` parent: "fork/exec
  …/gvisor-sentry-prewarmer: permission denied"; `/usr/local/lib/…` at `0755`: works).
- **Rootless works** on this kernel: as uid 65534, `runsc --rootless --network=none --platform=systrap do uname -r`
  printed `4.19.0-gvisor`. That answers half of open question 6: a developer needs a Linux kernel, not root. macOS and
  Windows (through a Linux VM) were not tested.

### Decision 6 probes, each with a control that must flip it

`run-gvisor-probes.sh` ran the probe set in four places: the **host** (no sandbox), gVisor **relaxed** (root, writable
root, `--network=host`, no limits: the negative control), gVisor **restricted** (ADR-0190's shipped `restricted`
profile as far as OCI can express it, `--network=none`), and **restricted-uid0** (restricted with uid 0 but still no
capabilities, to separate a read-only mount from file permissions).

| Probe (decision 6) | Host | Relaxed gVisor | Restricted gVisor | Result |
|---|---|---|---|---|
| Runtime identity | `6.18.44-fc-v114`; dmesg "Linux version 6.18.44…" | `4.19.0-gvisor`; dmesg "Starting gVisor..." | same as relaxed | **Ran.** Distinguishes runc/host from runsc |
| uid, caps, NoNewPrivs, Seccomp (`/proc/self/status`) | 0, full, 0, 0 | 0, default set `a80405fb`, 0, 0 | **10001, `CapEff 0`, `NoNewPrivs 1`, `Seccomp 2`** | **Ran**, but `Seccomp 2` only with `--oci-seccomp` (amendment A) |
| seccomp filter enforced | — | `unshare -U /bin/true` exit 0 | `unshare failed: Operation not permitted`, exit 1 | **Ran** (stand-in filter denying `unshare`, `mount`, `ptrace`, `bpf`, …) |
| Read-only root | writable | writable | uid 10001: **EACCES**; uid 0: **EROFS**; `/proc/self/mounts` shows `/` as `ro` | **Ran.** EACCES alone does not prove a read-only root (amendment D) |
| `/work` tmpfs writable | — | writable | writable | Ran |
| Egress to a public literal address, no resolver (`1.1.1.1:443`) | connected | connected | **ENETUNREACH (101)** | **Ran**, control flips |
| Egress to a host listener (`<host-ip>:47917`) | connected | connected | **ENETUNREACH** | Ran, control flips |
| DNS (`example.com`) | resolves | resolves | **EAI_AGAIN (-3)** | Ran, control flips |
| Interfaces | `lo eth0 docker0 …` | host's | **`lo` only** | Ran |
| Host processes | host sentinel visible, `kill(pid,0)` ok, 148 pids | sentinel invisible, ESRCH, 1 pid | same | **Ran**; gVisor always has its own pid view, so the host itself is the control |
| Memory limit 256 MiB | — | 512 MiB allocated | **killed at ~224 MiB, exit 137**; inside, `MemTotal 262144 kB` | **Ran**, control flips |
| CPU quota 0.5 | — | 4 workers | executor-side: host cgroup `cpu.cfs_quota_us 50000`, **`nr_throttled 17` of 28 periods** during the run; inside, `nproc` 2 | **Ran.** Throughput counts were too noisy under load to prove a quota; the host cgroup counters are the evidence (amendment D) |
| Process limit, host `pids.max` 64 | — | 200 spawned, 200 forked | `posix_spawn`: **20** spawned, then ENOMEM; plain `fork`: **Sentry panic, sandbox exit 2** | **Ran.** The limit holds but is mis-sized and can crash the sandbox (amendment C) |
| Process limit as `RLIMIT_NPROC` 64 (host pids 512) | — | — | **63** spawned, then EAGAIN, sandbox survives | Ran |
| `RLIMIT_NOFILE` 1024 | 20000 | 20000 | 1024 | Ran |
| Absence of executor/runner credentials | host `/root` has 24 entries | masked (0) | masked (0) | Partly: shows masking only. The real check (no credential in env, args, image) belongs to the I4 executor |

Not run here: the ADR-0187 decision 19 probe **through a gateway channel** (there is no executor or gateway in this
container), and the compose `runtime: runsc` worker (no Docker).

### Overhead

| Measure (5 or 200 samples, loaded host) | Host | gVisor `restricted` |
|---|---|---|
| Start a fresh sandbox running `/bin/true` (median) | 1.5 ms (exec) | **449 ms** (range 369–543) |
| stdio JSON-RPC echo, first response (includes start) | 118 ms | **663 ms** |
| stdio round trip, steady state, median / p95 | 0.024 / 0.048 ms | **0.564 / 1.011 ms** |

Earlier runs on the same day gave the same shape (start 354–641 ms, steady median 0.38–0.45 ms). For a stdio MCP
server the cost is the start, about half a second, not the per-request path. A sandbox per session, not per call, keeps
it out of the per-call latency; the ADR already makes the session the unit (`persistence: none` is per session).

## 2. Kata Containers

`ls /dev/kvm`: no such file. No `vmx`/`svm` flag in `/proc/cpuinfo`; `/sys/class/misc` has no `kvm` entry. Kata was not
installed, as briefed. To test it, I6 needs:

- a Linux host or CI runner with **`/dev/kvm`** readable by the runtime: bare metal, or an instance type with nested
  virtualisation enabled. Checked per deployment, never assumed (the ADR's wording stands);
- containerd with the Kata shim (`io.containerd.kata.v2`) and, on Kubernetes, a `kata` RuntimeClass;
- Kata at or above the release fixing CVE-2026-41326 (3.29.0 per the ADR's NVD reading). Both current lines are above
  it: **4.2.0** and **3.32.0** (see §4);
- the guest kernel and image pre-staged for air-gapped installs;
- the same `probe.py` and `kernel-features-probe.py` (both are standard-library Python and run unchanged), plus the
  executor-side check that the guest kernel differs from the host's and the CPU shows a hypervisor flag;
- the OpenShell MicroVM (libkrun) driver has the same requirement, so it is tested on the same host.

## 3. OpenShell

### What the PyPI package is now

`openshell` **0.1.3** (2026-10-09, `license_expression: Apache-2.0`, "Development Status :: 3 - Alpha", 95 releases since
2026-03-10). The 0.1.x wheel is a **131 KB pure-Python SDK** (`py3-none-any`; dependencies `cloudpickle`, `grpcio`,
`googleapis-common-protos`, `httpx`, `protobuf`). Early releases (0.0.6) shipped 5 MB platform wheels; 0.1.x does not.
The gateway, supervisor and drivers are Rust crates published from the upstream repository and as container images, not
through PyPI. **Pinning the PyPI version pins only the client.** The gateway and supervisor were therefore read from
source: upstream commit `eeba0e79` (2026-10-10), release tag `v0.1.3`. Nothing was built or executed.

### Telemetry and egress defaults (from source)

| Default | Where | What it means for us |
|---|---|---|
| Telemetry **compiled in** | `default = ["telemetry"]` in `openshell-core`, `openshell-server`, `openshell-gateway` and `openshell-supervisor` `Cargo.toml` | A release built with default features contains the emitter |
| Telemetry **on** at run time | `telemetry_enabled_from(None)` returns true (`openshell-core/src/telemetry.rs`, test `telemetry_enabled_defaults_true`); Helm `server.telemetryEnabled: true` | Opt-out, not opt-in: insecure by default under ADR-0180 |
| Endpoint | hard-coded `DEFAULT_ENDPOINT` (the publisher's `events.telemetry.data.*` host, `/v1.1/events/json`), overridable by `OPENSHELL_TELEMETRY_ENDPOINT`; 5 s timeout, best-effort queue | Must be fenced at the network layer even when disabled |
| Supervisors inherit | the VM driver passes `OPENSHELL_TELEMETRY_ENABLED` into sandboxes; a compiled-out build reports `false` so supervisors "skip activity collection" | Disabling at the gateway is not enough for a mixed build |
| Telemetry-free build | `--no-default-features --features defaults-without-telemetry` (gateway, supervisor); a CI script keeps it in sync with `default` and makes `telemetry` + `defaults-without-telemetry` a compile error | **Admissible form.** ADR-0177's note is confirmed |
| Default sandbox images | base image from the publisher's registry; supervisor and sandbox runtime images from a public container registry | Air-gapped installs preload and mirror them |
| Image pull policy | `ImagePullPolicy::IfNotPresent` (`openshell-core/src/config.rs`) | Set `Never` for air-gapped, as ADR-0190 decision 12 |
| Landlock filesystem policy | baseline requires ABI ≥ 3; additional paths default to `compatibility: best_effort` (security best-practices page) | Our profiles set `hard_requirement` |

The **egress test** (run the gateway with telemetry off, watch for connections) needs Docker and was not run.

### Owner decision 7: the interceptor over a local socket

From `openshell-extension-core/src/transport.rs`, `openshell-server/src/lib.rs` and `openshell-core/src/config.rs`:

- The gateway is the **client**; the interceptor is a gRPC server we run. `GatewayInterceptorConfig.grpc_endpoint`
  accepts `http://`, `https://` and `unix://` (an absolute socket path; relative paths are refused). So "no network
  listener" is entirely on our side: we bind only a unix socket.
- Authentication over `unix://` is **supported**: `mint_gateway_extension_credential` accepts "https:// or unix://"
  for interceptors and mints an **EdDSA** JWT, `typ` `openshell-ext+jwt`, `iss` `openshell-gateway:<gateway_id>`, exact
  `aud` (default `urn:openshell:extension:interceptor:<name>`), `jti`, lifetime capped at **1 hour**
  (`MAX_EXTENSION_TOKEN_TTL`). This matches decision 7's pins (algorithm, issuer, audience).
- `allow_insecure_transport = true` turns authentication **off** (no token at all, warning at startup). We must never
  set it; I7 refuses a config that does.
- Interceptor failure policy defaults to **`fail_closed`**; `post_commit` bindings must be `fail_open` (observers only).
  The gateway refuses to start if a configured interceptor is unavailable.
- Residuals, as the docs state: the token is a bearer credential, **reused until rotation** ("don't reject a repeated
  `jti`", so no replay detection is possible), it shares the gateway's signing key, and there is no mTLS. Mitigation
  beyond decision 7: socket file `0600` owned by the one shared uid, and a `SO_PEERCRED` check of the connecting uid
  as a second factor.
- **Supervisor middleware cannot meet decision 7**: for middleware the code accepts only `https://` ("a gateway-local
  Unix socket is only an option for interceptors"). `injected_at_egress` via middleware would need its own decision.

### Can OpenShell attest L2 by running under `runsc`?

ADR-0190 decision 1 lets OpenShell's Docker/Podman/Kubernetes drivers attest L2 "only when its pod or container itself
runs under `runsc`". OpenShell's support matrix makes Landlock ABI ≥ 3 **required**, and its network model uses seccomp
user notification. `kernel-features-probe.py`, host vs inside the restricted gVisor sandbox:

| Check | Host 6.18.44 | gVisor |
|---|---|---|
| Landlock ABI | 7 | **ENOSYS** |
| seccomp filter, flags 0 (control) | installed | installed |
| seccomp filter with `SECCOMP_FILTER_FLAG_NEW_LISTENER` | installed | **EINVAL** |

So OpenShell's own sandbox cannot start its baseline inside gVisor. OpenShell itself was **not** run under `runsc`
(no Docker). The expected result is a refusal at its startup qualification, not a silent downgrade; I7 confirms it on a
Docker host. The Kubernetes driver does pass `runtimeClassName` through, so a misconfiguration is possible and must be
refused by us, not discovered.

## 4. Survey re-check (primary sources)

`survey-recheck.sh` read each upstream git repository anonymously: newest release tag (pre-releases excluded), that
tag's commit date, and the licence file at the tag. The GitHub web and API pages were refused by the proxy (403); git
reads were served. Output: `evidence/survey-recheck.md`.

| Project | ADR-0190 survey said | Primary source, 2026-10-10 | Change |
|---|---|---|---|
| gVisor | `release-20261005.0`, Apache-2.0 | tag `release-20261005.0` (2026-10-05; bucket objects 2026-10-08); LICENSE Apache 2.0 | Confirmed. Add: tarball with sidecars is the install unit |
| Kata Containers | 3.28.0 packaged; 4.0.0 in August (secondary); latest tag not confirmed | **4.2.0** (2026-09-15); 3.x line **3.32.0** (2026-06-22); LICENSE Apache 2.0 | **Corrected** |
| Firecracker | 1.17.0 (Arch package 2026-09-04) | `v1.17.0` (2026-09-04); LICENSE Apache 2.0 | Confirmed from upstream |
| nsjail | 3.6 (Arch package built 2026-05-28) | tag `3.6` dated **2026-03-18**; LICENSE Apache 2.0 | **Corrected** date (the May date was the package build) |
| Wasmtime | 49.0.2, 2026-10-02, Apache-2.0 WITH LLVM-exception | `v49.0.2` (2026-10-02); LICENSE Apache 2.0 + "LLVM Exceptions" section | Confirmed |
| OpenShell | 0.1.3, 2026-10-09, Apache-2.0 | `v0.1.3` (2026-10-09); LICENSE Apache 2.0; PyPI wheel is SDK only | **Corrected** scope (see §3) |
| `go-landlock` | v0.10.1, licence not checked | `v0.10.1` (2026-09-13); **MIT** | Filled in (open question 8) |

Not re-checked: OpenSandbox's provenance (open question 8) and the Landlock UDP ABI number; neither is on I1's path.

## Amendments ADR-0190 needs

- **A. runsc flags are part of the profile.** Without `--oci-seccomp`, runsc **ignores** the OCI seccomp filter
  (boot log: "Seccomp spec is being ignored because oci-seccomp is disabled"; measured `Seccomp: 0` and `unshare`
  allowed). Decisions 4 and 10 must name the runsc configuration: `--oci-seccomp`, `--network=none` (or the
  channel), `--sidecar-usage-policy=STRICT`, `--sidecar-release-enforcement-policy=ALWAYS`, and the platform. The
  executor's self-test already checks `Seccomp: 2`; this makes that check pass for the right reason.
- **B. `--directfs=false` by default (proposal).** With the default directfs, the Sentry logs "host filesystem enabled:
  syscall filters less restrictive!" on every start; with `--directfs=false` it does not. Under ADR-0180 the strict
  value is the default and directfs is an audited relaxation. Cost not measured; I4 measures it.
- **C. The `pids` limit has two meanings under runsc.** The OCI `pids` limit becomes a **host** cgroup limit that counts
  the Sentry's threads and the systrap stub processes. At 64 the workload got 20 processes, and a fork-heavy workload
  **crashed the Sentry** (exit 2) instead of getting EAGAIN. Decision 2's `process.pids` (128) should map to
  `RLIMIT_NPROC` for the workload (measured: a clean EAGAIN at 63 of 64) plus a host cgroup limit with headroom for
  the Sentry (512 worked here). A Sentry crash is still a fail-closed outcome and is reported as such.
- **D. Probe definitions need controls.** "A write to the root filesystem failing" must mean EROFS, or a `ro` root in
  `/proc/self/mounts`: as uid 10001 every root write fails with EACCES whether or not the mount is read-only. "The
  cgroup limits" splits into what the sandbox can see (`MemTotal` equals the memory limit; `RLIMIT_*` values) and what
  only the executor can see (host cgroup `cpu.cfs_quota_us`, `memory.limit_in_bytes`, `pids.max`, and `nr_throttled`).
  The CPU count inside is derived from the quota (`--cpu-num-from-quota`: 2 for 0.5 CPU) and proves nothing about it.
- **E. gVisor install unit.** The survey row and decision 12 (air-gapped) should say: the release tarball (`runsc`,
  shim, `gvisor-bin/` sidecars), pinned by sha512, installed together on a world-traversable path. A bare `runsc` copy
  no longer runs.
- **F. OpenShell cannot attest L2.** In decision 1's L2 row, replace "OpenShell's Docker/Podman/Kubernetes drivers only
  when its pod or container itself runs under `runsc`" with: OpenShell's container drivers attest **L1** only;
  OpenShell reaches L2 never and L3 only through its MicroVM driver. The executor refuses an OpenShell placement with
  `runtimeClassName: gvisor`.
- **G. OpenShell admission conditions (I7).** Build gateway and supervisor from source with
  `--no-default-features --features defaults-without-telemetry` (a release image with telemetry compiled in is not
  admitted), still fence the telemetry host at the network layer, set image pull policy `Never` with preloaded images
  for air-gapped, set Landlock `hard_requirement`, refuse `allow_insecure_transport`, use interceptors only (supervisor
  middleware is https-only and outside decision 7), and add `SO_PEERCRED` plus a `0600` socket to decision 7's
  mitigations. Record that tokens are reused until rotation, so `jti` replay detection is not available.
- **H. Survey table corrections** as in §4 (Kata 4.2.0 and 3.32.0, nsjail date, OpenShell PyPI scope, `go-landlock`
  MIT), and open question 8 can drop the items now verified.
- **I. Open question 6.** Rootless `runsc` works on a Linux kernel without root. The macOS/Windows path still needs a
  test inside a Linux VM.

## Needs a real host or CI

| Item | Why not here | Where |
|---|---|---|
| ADR-0187 worker under `runtime: runsc` in compose; the decision 19 egress probe through a real channel | No Docker daemon | A Docker host with runsc registered (I4) |
| Kata probes, OpenShell MicroVM driver | No `/dev/kvm` | A KVM-capable host or CI runner (I6/I7) |
| OpenShell gateway + sandbox in compose, telemetry egress test, preloaded images air-gapped, OpenShell under `runsc` refusing | No Docker | A Docker host (I7) |
| Kubernetes `RuntimeClass` `gvisor`/`kata`, PSS `restricted`, deny-all NetworkPolicy | No cluster | A kind or managed cluster (I6) |
| Timings on a quiet host; `--directfs=false` cost | Shared, loaded machine | Any quiet Linux host (I4) |
| cgroup v2 behaviour (this host is cgroup v1 hybrid) | Host layout | CI runners are usually cgroup v2; rerun `run-gvisor-probes.sh` there |
| Landlock ABI and seccomp user notification on our CI runners (OpenShell's kernel floor) | Not our CI | Run `kernel-features-probe.py` as a CI step |
| gVisor APT package path | Not tried | Any Debian/Ubuntu host |

## Cleanup

The gVisor tarballs and extracted binaries, the staged copy under `/usr/local/lib`, the rootless work directory, the
OpenShell wheel and the source clone were deleted after the runs. Their identities are in
`spikes/isolation-i0/THIRD_PARTY.md`.

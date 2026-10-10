# runsc install and flag observations (I0, 2026-10-10)

Commands were run by hand in the spike container (root in a microVM guest, kernel 6.18.44, no Docker, no `/dev/kvm`).
Output is quoted as printed. `$RUNSC` is `release-20261005.0` from the verified tarball; `$S` the scratch directory.

## 1. The standalone binary is gone; the tarball is the install unit

- Bucket listing `releases/release/2026*`: the last release with a standalone `x86_64/runsc` object is **`20260817.0`**.
  Every later release (`20260824` … `20261005.0`) ships only `gvisor.tar.bz2` and `gvisor.tar.zstd` (plus `.sha512`).
- The tarball holds `runsc`, `containerd-shim-runsc-v1` and `gvisor-bin/{gvisor_sentry, gvisor-sentry-prewarmer,
  runsc-fd-parking, runsc-metric-server, checkpointgofer}`. `runsc` boots the Sentry from `gvisor-bin/gvisor_sentry`
  ("Sidecar "gvisor_sentry" found: booting sandbox with …/gvisor-bin/gvisor_sentry").
- `runsc` copied alone into an empty directory, default flags:

  ```
  running container: creating container: cannot create sandbox: cannot create sandbox process: sidecar "gvisor_sentry"
  not usable (stat …/solo/gvisor-bin/gvisor_sentry: no such file or directory) and --sidecar-usage-policy is set to STRICT
  ```

  The boot log shows the default as `SidecarUsagePolicy: DEFAULT`, which already behaves as STRICT here. `runsc flags`
  documents the fallback `LEGACY_DEPRECATED_SLOW_EMBEDDED_FALLBACK` as "will stop working after 2026-10".
- With the full tarball and `--sidecar-usage-policy=STRICT --sidecar-release-enforcement-policy=ALWAYS` the kernel
  feature probe ran normally.

## 2. Install location must be traversable by the sandbox's unprivileged user

With `--directfs=false`, runsc started from the 0700 scratch directory failed:

```
… starting sandbox: fork/exec …/x/gvisor-bin/gvisor-sentry-prewarmer: permission denied
```

The same tarball copied to `/usr/local/lib/i0-gvisor-spike/` (0755) ran the same bundle (the workload printed
`unshare: unshare failed: Operation not permitted`, the restricted seccomp filter working).

## 3. `--directfs` and the Sentry's own host seccomp filter

- Default (`Config.DirectFS: true`), every restricted run logged:
  `*** SECCOMP WARNING: host filesystem enabled: syscall filters less restrictive!`
- `--directfs=false`: the warning is absent from the boot log. Performance effect not measured.

## 4. OCI seccomp is ignored unless `--oci-seccomp` is passed

First run, without the flag, boot log: `Seccomp spec is being ignored because oci-seccomp is disabled`; the workload's
`/proc/self/status` showed `Seccomp: 0` and `unshare -U /bin/true` exited 0 despite the spec denying `unshare`. With
`--oci-seccomp` (all evidence in this folder): `Seccomp: 2` and `unshare` refused (`seccomp-restricted.txt`).

## 5. Rootless mode works here

As uid 65534 (`setpriv --reuid=65534 --regid=65534 --clear-groups`), `runsc --rootless --network=none
--platform=systrap do /usr/bin/uname -r` printed `4.19.0-gvisor`. The probe set under `do` is in `probe-rootless-do.json`:
gVisor kernel, only `lo`, egress and DNS refused, but a **writable** root overlay, uid 0 inside a user namespace, full
capability set and no resource limits. `do` is a developer convenience, not the restricted profile.
(Its `host_process.cmdline_has_token: true` is an artefact: the sentinel pid passed was 1, which inside the sandbox is the
probe itself; there was no host sentinel in this run.)

## 6. What OpenShell's sandbox baseline finds inside gVisor

`kernel-features-probe.py`, host vs inside the restricted gVisor sandbox (`kernel-features-*.json`):

| Check | Host 6.18.44 | gVisor |
|---|---|---|
| Landlock ABI (`landlock_create_ruleset` VERSION) | 7 | ENOSYS (38) |
| seccomp filter, flags 0 (control) | installed | installed |
| seccomp filter, `SECCOMP_FILTER_FLAG_NEW_LISTENER` (user notification) | installed (fd 4) | EINVAL (22) |

`SECCOMP_GET_ACTION_AVAIL` returned EINVAL inside gVisor even for the `KILL_PROCESS` control, so that check is not used
as evidence; the filter-install pair above is.

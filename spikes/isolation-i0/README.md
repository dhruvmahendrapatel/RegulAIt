# Isolation I0 spike (ADR-0190 slice I0)

Throwaway research code. **Not product code, not part of the pnpm workspace** (no `package.json`; the workspace covers
`apps/*` and `packages/*` only). Findings: [`docs/research/R13-isolation-i0-spike.md`](../../docs/research/R13-isolation-i0-spike.md).

## Files

| File | Purpose |
|---|---|
| `fetch-gvisor.sh <dest>` | Download the pinned gVisor tarball, verify its sha512 (pinned and published), unpack |
| `make-bundle.py` | Write an OCI `config.json` for a profile: `restricted` (ADR-0190's shipped profile, as far as OCI expresses it), `restricted-uid0`, `restricted-nproc`, `relaxed` (negative control) |
| `runsc-run.sh` | Run one command in a fresh gVisor sandbox (`runsc run`, systrap platform) |
| `probe.py` | ADR-0190 decision 6 probe set, run inside a sandbox or on the host as a control |
| `stress.py` | Memory, process-count and CPU probes, one per sandbox |
| `kernel-features-probe.py` | Landlock ABI and seccomp user notification (OpenShell's baseline), host vs gVisor |
| `run-gvisor-probes.sh <runsc> <work> <evidence>` | Runs everything above with controls, writes `evidence/` |
| `host-cgroup-cpu-control.sh` | Control: does the host enforce a CFS quota without gVisor? |
| `startup-timing.py`, `stdio-rtt.py` | Sandbox start-up cost and stdio JSON-RPC round trip, gVisor vs host |
| `survey-recheck.sh` | Newest release tag, its date and licence for each surveyed project, from the upstream git repositories |

## Reproduce (Linux, root, no KVM or Docker needed)

```sh
spikes/isolation-i0/fetch-gvisor.sh /some/scratch/gvisor
spikes/isolation-i0/run-gvisor-probes.sh /some/scratch/gvisor/x/runsc /some/scratch/work spikes/isolation-i0/evidence
spikes/isolation-i0/host-cgroup-cpu-control.sh spikes/isolation-i0/evidence/host-cgroup-cpu-control.txt
```

`runsc` must stay next to its `gvisor-bin/` directory, and with `--directfs=false` that directory must be traversable by
an unprivileged user (see `evidence/runsc-install-observations.md`). The bundle's root filesystem is the host root,
read-only, with `/root`, `/home`, `/tmp`, `/run`, `/var/tmp` and `/opt` masked: this container has no image tooling. A
product profile runs a digest-pinned image instead. Run on a quiet host if the timings matter: the evidence here was
taken at a load average of about 17 on 4 vCPUs.

Delete the downloaded tarball and the work directory afterwards (a `null-netns` bind mount under the work directory's
`state/` must be unmounted first). Downloads are never committed; their hashes are in `THIRD_PARTY.md`.

#!/usr/bin/env python3
"""Write an OCI runtime bundle (config.json only) for the I0 spike.

Usage: make-bundle.py <bundle_dir> <restricted|relaxed> <spike_dir> -- <argv...>

The root filesystem is the HOST root, mounted read-only (restricted) or writable-in-overlay
(relaxed), because this container has no image tooling. Sensitive host directories are masked
with empty tmpfs mounts. A product profile uses a digest-pinned image instead (ADR-0190 decision 2).

restricted = ADR-0190's shipped `restricted` profile as far as OCI can express it:
  uid 10001, no capabilities, no_new_privileges, read-only root, /work tmpfs 256 MiB,
  a seccomp filter (stand-in for RuntimeDefault: denies ptrace/mount/unshare/bpf/kexec_load),
  memory 256 MiB, 64 pids, 0.5 CPU, RLIMIT_NOFILE 1024.
relaxed = the negative control: root, default capabilities, writable root, no limits.
"""
import json
import os
import sys

bundle, profile, spike = sys.argv[1], sys.argv[2], sys.argv[3]
argv = sys.argv[sys.argv.index("--") + 1:]
restricted = profile.startswith("restricted")
# Variants that each isolate one property (a control must change exactly one thing):
#   restricted-uid0  : as restricted but uid 0 (still no capabilities), so a failed root write can
#                      only be the read-only mount, not file permissions
#   restricted-nproc : as restricted but the host pids limit raised to 512 and RLIMIT_NPROC 64,
#                      to test a workload-level task limit that does not kill the sandbox
uid = 0 if profile in ("relaxed", "restricted-uid0") else 10001
pids_limit = 512 if profile == "restricted-nproc" else 64

MASKED = ["/root", "/home", "/tmp", "/run", "/var/tmp", "/opt"]

mounts = [
    {"destination": "/proc", "type": "proc", "source": "proc"},
    {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
    {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]},
    {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"]},
    {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]},
    {"destination": "/work", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=256m"]},
]
mounts += [{"destination": d, "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=755", "size=1m"]} for d in MASKED]
mounts.append({"destination": "/i0", "type": "bind", "source": spike, "options": ["rbind", "ro"]})

all_caps = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FSETID", "CAP_FOWNER", "CAP_MKNOD", "CAP_NET_RAW",
            "CAP_SETGID", "CAP_SETUID", "CAP_SETFCAP", "CAP_SETPCAP", "CAP_NET_BIND_SERVICE",
            "CAP_SYS_CHROOT", "CAP_KILL", "CAP_AUDIT_WRITE"]
caps = [] if restricted else all_caps

spec = {
    "ociVersion": "1.0.2",
    "process": {
        "terminal": False,
        "user": {"uid": uid, "gid": uid},
        "args": argv,
        "env": ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/work", "PYTHONDONTWRITEBYTECODE=1"],
        "cwd": "/work",
        "capabilities": {k: caps for k in ("bounding", "effective", "permitted", "inheritable", "ambient")},
        "noNewPrivileges": restricted,
        "rlimits": ([{"type": "RLIMIT_NOFILE", "hard": 1024, "soft": 1024}] if restricted else [])
                   + ([{"type": "RLIMIT_NPROC", "hard": 64, "soft": 64}] if profile == "restricted-nproc" else []),
    },
    "root": {"path": "/", "readonly": restricted},
    "hostname": "i0-sandbox",
    "mounts": mounts,
    "linux": {
        # relaxed omits the network namespace so runsc --network=host really reaches the host network
        # (with the namespace present, runsc joins an empty one and the egress control is vacuous).
        "namespaces": [{"type": t} for t in ("pid", "network", "ipc", "uts", "mount") if restricted or t != "network"],
        "maskedPaths": ["/proc/kcore", "/proc/keys", "/proc/timer_list", "/sys/firmware"],
        "readonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
    },
}
if restricted:
    spec["linux"]["resources"] = {
        "memory": {"limit": 256 * 1024 * 1024},
        "pids": {"limit": pids_limit},
        "cpu": {"quota": 50000, "period": 100000},
    }
    spec["linux"]["seccomp"] = {
        "defaultAction": "SCMP_ACT_ALLOW",
        "architectures": ["SCMP_ARCH_X86_64"],
        "syscalls": [{"names": ["ptrace", "mount", "umount2", "unshare", "bpf", "kexec_load", "init_module"],
                      "action": "SCMP_ACT_ERRNO", "errnoRet": 1}],
    }

os.makedirs(bundle, exist_ok=True)
with open(os.path.join(bundle, "config.json"), "w") as f:
    json.dump(spec, f, indent=1)
print(os.path.join(bundle, "config.json"))

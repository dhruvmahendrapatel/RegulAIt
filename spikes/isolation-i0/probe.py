#!/usr/bin/env python3
"""ADR-0190 decision 6 probe set, run from INSIDE a sandbox (or on the host as a control).

Throwaway spike code (slice I0). Standard library only. Prints one JSON object.

Usage: probe.py <host_ip> <host_port> <sentinel_pid> <sentinel_token>
  host_ip/host_port  a TCP listener the run script starts on the host (egress target that
                     needs no resolver and is reachable whenever the sandbox has any network)
  sentinel_pid/token a host process the run script starts; visible only without pid isolation
"""
import json
import os
import socket
import subprocess
import sys


def read(path):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read()
    except OSError as e:
        return f"<error {e.__class__.__name__}: {e.strerror}>"


def tcp(host, port, timeout=3.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return "connected"
    except OSError as e:
        return f"refused:{e.__class__.__name__}:{e.errno}"
    finally:
        s.close()


def dns(name):
    try:
        return "resolved:" + socket.getaddrinfo(name, 443)[0][4][0]
    except OSError as e:
        return f"failed:{e.__class__.__name__}:{e.errno}"


def write_test(path):
    try:
        with open(path, "w") as f:
            f.write("x")
        os.unlink(path)
        return "writable"
    except OSError as e:
        return f"denied:{e.errno}:{e.strerror}"


def status_fields():
    out = {}
    for line in read("/proc/self/status").splitlines():
        k, _, v = line.partition(":")
        if k in ("Uid", "Gid", "CapEff", "CapPrm", "CapBnd", "NoNewPrivs", "Seccomp"):
            out[k] = v.strip()
    return out


def dmesg_head():
    try:
        r = subprocess.run(["dmesg"], capture_output=True, text=True, timeout=5)
        lines = (r.stdout or r.stderr).splitlines()
        # First line only: on the host, later lines carry the boot command line of the machine.
        return lines[:1]
    except Exception as e:  # noqa: BLE001 - probe reports whatever happened
        return [f"<error {e}>"]


def interfaces():
    names = []
    for line in read("/proc/net/dev").splitlines()[2:]:
        names.append(line.split(":")[0].strip())
    return names


def host_pid(pid, token):
    cmd = read(f"/proc/{pid}/cmdline").replace("\x00", " ")
    try:
        os.kill(pid, 0)
        sig = "exists"
    except ProcessLookupError:
        sig = "ESRCH"
    except PermissionError:
        sig = "EPERM"
    return {"cmdline_has_token": token in cmd, "kill0": sig,
            "pids_visible": len([d for d in os.listdir("/proc") if d.isdigit()])}


def listing(path):
    # A count, not names: the host control would otherwise publish its home directory layout.
    try:
        return {"entries": len(os.listdir(path))}
    except OSError as e:
        return f"<error {e.errno}:{e.strerror}>"


def main():
    host_ip, host_port, spid, token = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    meminfo = {l.split(":")[0]: l.split(":")[1].strip() for l in read("/proc/meminfo").splitlines()[:2]}
    result = {
        "kernel": read("/proc/version").strip(),
        "uname_release": os.uname().release,
        "dmesg": dmesg_head(),
        "status": status_fields(),
        "root_mount": next((l.split()[3] for l in read("/proc/self/mounts").splitlines() if l.split()[1:2] == ["/"]), None),
        "rootfs_write": write_test("/i0-probe-root-write"),
        "etc_write": write_test("/etc/i0-probe-write"),
        "work_write": write_test("/work/i0-probe"),
        "interfaces": interfaces(),
        "egress_public_literal": tcp("1.1.1.1", 443),
        "egress_host_listener": tcp(host_ip, host_port),
        "dns": dns("example.com"),
        "host_process": host_pid(spid, token),
        "meminfo": meminfo,
        "cpu_count": os.cpu_count(),
        "rlimit_nofile": __import__("resource").getrlimit(__import__("resource").RLIMIT_NOFILE),
        "home_listing": listing("/root"),
    }
    print(json.dumps(result, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()

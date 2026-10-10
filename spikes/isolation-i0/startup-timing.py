#!/usr/bin/env python3
"""Sandbox start-up cost: N x `/bin/true` in a fresh gVisor sandbox vs N x host exec.
Usage: startup-timing.py <runsc-run.sh> <runsc_bin> <work_dir> [N]"""
import json
import statistics
import subprocess
import sys
import time

run, runsc, work = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 5


def timed(argv):
    t = time.monotonic()
    rc = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    return time.monotonic() - t, rc


out = {}
for label, mk in {
    "host_exec": lambda i: ["/bin/true"],
    "gvisor_restricted": lambda i: [run, runsc, work, "restricted", "none", f"start-{i}", "--", "/bin/true"],
}.items():
    times, rcs = [], []
    for i in range(n):
        dt, rc = timed(mk(i))
        times.append(round(dt * 1000, 1))
        rcs.append(rc)
    out[label] = {"ms": times, "median_ms": statistics.median(times), "exit_codes": rcs}
print(json.dumps(out, indent=1))

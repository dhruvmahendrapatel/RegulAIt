#!/usr/bin/env python3
"""Resource-limit probes for the I0 spike. Run inside a sandbox; each mode is its own run so a
limit that kills the whole sandbox shows up as the run's exit status, not as lost output.

  stress.py mem <MiB>      allocate and touch MiB of memory, print how far it got
  stress.py pids <N>       spawn N sleeping children, print how many spawns succeeded
  stress.py cpu <seconds>  run one busy loop per visible CPU for <seconds> of wall clock,
                           print total iterations (compare across profiles, not absolute)
"""
import json
import os
import sys
import time


def mem(mib):
    blocks, got = [], 0
    try:
        for _ in range(mib):
            b = bytearray(1024 * 1024)
            for i in range(0, len(b), 4096):
                b[i] = 1
            blocks.append(b)
            got += 1
            if got % 32 == 0:
                print(json.dumps({"mode": "mem", "progress_mib": got}), flush=True)
        return {"mode": "mem", "requested_mib": mib, "allocated_mib": got, "outcome": "completed"}
    except MemoryError:
        return {"mode": "mem", "requested_mib": mib, "allocated_mib": got, "outcome": "MemoryError"}


def pids(n):
    kids, err = [], None
    for _ in range(n):
        # posix_spawn of /bin/sleep keeps each child small, so the memory limit is not what stops it.
        try:
            kids.append(os.posix_spawn("/bin/sleep", ["sleep", "5"], {}))
        except OSError as e:
            err = f"{e.errno}:{e.strerror}"
            break
    print(json.dumps({"mode": "pids", "requested": n, "spawned": len(kids), "first_error": err}), flush=True)
    for k in kids:
        os.waitpid(k, 0)
    return {"mode": "pids", "requested": n, "spawned": len(kids), "first_error": err, "outcome": "completed"}


def forks(n):
    # fork() without exec: each child is a new address space, which under systrap needs a new
    # host stub process, so the HOST pids limit is reached with far fewer guest processes.
    kids, err = [], None
    for _ in range(n):
        try:
            pid = os.fork()
        except OSError as e:
            err = f"{e.errno}:{e.strerror}"
            break
        if pid == 0:
            time.sleep(5)
            os._exit(0)
        kids.append(pid)
    print(json.dumps({"mode": "forks", "requested": n, "forked": len(kids), "first_error": err}), flush=True)
    for k in kids:
        os.waitpid(k, 0)
    return {"mode": "forks", "requested": n, "forked": len(kids), "first_error": err, "outcome": "completed"}


def cpu(seconds):
    n = os.cpu_count() or 1
    r, w = os.pipe()
    kids = []
    for _ in range(n):
        pid = os.fork()
        if pid == 0:
            os.close(r)
            end, it = time.monotonic() + seconds, 0
            while time.monotonic() < end:
                it += 1
            os.write(w, f"{it}\n".encode())
            os._exit(0)
        kids.append(pid)
    os.close(w)
    for k in kids:
        os.waitpid(k, 0)
    total = sum(int(x) for x in os.read(r, 65536).decode().split())
    return {"mode": "cpu", "workers": n, "seconds": seconds, "iterations": total}


if __name__ == "__main__":
    mode, arg = sys.argv[1], int(sys.argv[2])
    print(json.dumps({"mem": mem, "pids": pids, "forks": forks, "cpu": cpu}[mode](arg)), flush=True)

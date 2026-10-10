#!/usr/bin/env python3
"""stdio round-trip cost, the shape of a stdio MCP server: newline-delimited JSON-RPC echo.
Measures time to first response (includes sandbox start) and per-request latency, under
gVisor (restricted profile) and as a plain host child process.
Usage: stdio-rtt.py <runsc-run.sh> <runsc_bin> <work_dir> [requests]"""
import json
import statistics
import subprocess
import sys
import time

run, runsc, work = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 200

ECHO = ("import sys,json\n"
        "for line in sys.stdin:\n"
        "    m=json.loads(line); sys.stdout.write(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':m['params']})+'\\n'); sys.stdout.flush()\n")


def measure(argv):
    t0 = time.monotonic()
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    lat = []
    first = None
    for i in range(n):
        t = time.monotonic()
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": "tools/call", "params": {"n": i}}) + "\n")
        p.stdin.flush()
        resp = json.loads(p.stdout.readline())
        assert resp["id"] == i
        now = time.monotonic()
        if first is None:
            first = now - t0
        lat.append((now - t) * 1000)
    p.stdin.close()
    p.wait(timeout=30)
    lat_steady = lat[1:]
    return {"first_response_ms": round(first * 1000, 1),
            "steady_median_ms": round(statistics.median(lat_steady), 3),
            "steady_p95_ms": round(sorted(lat_steady)[int(len(lat_steady) * 0.95)], 3),
            "requests": n, "exit": p.returncode}


print(json.dumps({
    "host_child": measure(["/usr/local/bin/python3", "-I", "-c", ECHO]),
    "gvisor_restricted": measure([run, runsc, work, "restricted", "none", "stdio-rtt", "--",
                                  "/usr/local/bin/python3", "-I", "-c", ECHO]),
}, indent=1))

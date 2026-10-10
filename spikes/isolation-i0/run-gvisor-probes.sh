#!/usr/bin/env bash
# I0 spike: ADR-0190 decision 6 probes under gVisor, each with a control that must flip it.
# Usage: run-gvisor-probes.sh <runsc_bin> <work_dir> <evidence_dir>
#   Run as root (runsc run needs it unless --rootless). Writes JSON/text evidence files.
# Controls (M-023/M-024: a probe that cannot fail proves nothing):
#   host      = the same probe run directly on the host (no sandbox)
#   relaxed   = gVisor, root, writable root, --network=host, no limits
#   restricted= gVisor, ADR-0190 `restricted` profile, --network=none
set -u
RUNSC=$1 WORK=$2 EVID=$3
SPIKE=$(cd "$(dirname "$0")" && pwd)
RUN="$SPIKE/runsc-run.sh"
mkdir -p "$EVID" "$WORK"
HOST_IP=$(hostname -I | awk '{print $1}')
PORT=47917
TOKEN="i0-sentinel-$$"

# Host-side listener (egress target) and sentinel process; both stopped by PID at the end.
python3 -I -m http.server "$PORT" --bind "$HOST_IP" --directory "$WORK" >/dev/null 2>&1 &
LISTENER=$!
# The token in argv makes the sentinel's cmdline unique; it is stopped by PID, never by pattern.
python3 -I -c 'import time; time.sleep(600)' "$TOKEN" &
SENTINEL=$!
cleanup() { kill "$LISTENER" "$SENTINEL" 2>/dev/null; wait "$LISTENER" "$SENTINEL" 2>/dev/null; }
trap cleanup EXIT
sleep 1

"$RUNSC" --version > "$EVID/runsc-version.txt"

echo "== probe: host control" >&2
python3 -I "$SPIKE/probe.py" "$HOST_IP" "$PORT" "$SENTINEL" "$TOKEN" > "$EVID/probe-host.json"
echo "== probe: gVisor relaxed control" >&2
"$RUN" "$RUNSC" "$WORK" relaxed host probe-relaxed -- /usr/local/bin/python3 -I /i0/probe.py "$HOST_IP" "$PORT" "$SENTINEL" "$TOKEN" > "$EVID/probe-relaxed.json" 2> "$EVID/probe-relaxed.stderr"
echo "== probe: gVisor restricted" >&2
"$RUN" "$RUNSC" "$WORK" restricted none probe-restricted -- /usr/local/bin/python3 -I /i0/probe.py "$HOST_IP" "$PORT" "$SENTINEL" "$TOKEN" > "$EVID/probe-restricted.json" 2> "$EVID/probe-restricted.stderr"

echo "== probe: gVisor restricted, uid 0 (read-only root isolated from file permissions)" >&2
"$RUN" "$RUNSC" "$WORK" restricted-uid0 none probe-restricted-uid0 -- /usr/local/bin/python3 -I /i0/probe.py "$HOST_IP" "$PORT" "$SENTINEL" "$TOKEN" > "$EVID/probe-restricted-uid0.json" 2> "$EVID/probe-restricted-uid0.stderr"

# Seccomp stand-in: unshare(2) is denied by the restricted filter.
for p in relaxed restricted; do
  net=host; [ $p = restricted ] && net=none
  "$RUN" "$RUNSC" "$WORK" $p $net "seccomp-$p" -- /usr/bin/unshare -U /bin/true > "$EVID/seccomp-$p.txt" 2>&1
  echo "exit=$?" >> "$EVID/seccomp-$p.txt"
done

# Resource limits: each in its own sandbox so a sandbox-wide kill is visible as the exit status.
for p in relaxed restricted; do
  net=host; [ $p = restricted ] && net=none
  for t in "mem 512" "pids 200" "forks 200" "cpu 3"; do
    set -- $t
    out="$EVID/stress-$p-$1.txt"
    start=$(date +%s.%N)
    timeout 120 "$RUN" "$RUNSC" "$WORK" $p $net "stress-$p-$1" -- /usr/local/bin/python3 -I /i0/stress.py "$1" "$2" > "$out" 2>&1
    rc=$?
    end=$(date +%s.%N)
    echo "exit=$rc wall_s=$(python3 -I -c "print(round($end-$start,2))")" >> "$out"
  done
done

# Task limit at workload level: host pids 512 + RLIMIT_NPROC 64 (see make-bundle.py).
start=$(date +%s.%N)
timeout 120 "$RUN" "$RUNSC" "$WORK" restricted-nproc none stress-restricted-nproc-pids -- /usr/local/bin/python3 -I /i0/stress.py pids 200 > "$EVID/stress-restricted-nproc-pids.txt" 2>&1
rc=$?
end=$(date +%s.%N)
echo "exit=$rc wall_s=$(python3 -I -c "print(round($end-$start,2))")" >> "$EVID/stress-restricted-nproc-pids.txt"
# Keep the sentry's own account of a sandbox-wide kill (BUG line) as evidence.
for m in pids forks; do
  grep -h -A2 "WARNING: BUG\|^panic:" "$WORK"/logs/stress-restricted-$m/*.boot.txt > "$EVID/stress-restricted-$m.sentry-log.txt" 2>/dev/null
done
grep -h "Seccomp spec\|SECCOMP WARNING" "$WORK"/logs/probe-restricted/*.boot.txt > "$EVID/probe-restricted.seccomp-log.txt" 2>/dev/null

# CPU quota: read the sandbox's HOST cgroup while it runs (runsc removes it on exit). Throttling
# counted there is the enforcement evidence; iteration counts alone are too noisy to prove it.
"$RUN" "$RUNSC" "$WORK" restricted none cpu-quota-live -- /usr/local/bin/python3 -I /i0/stress.py cpu 4 > "$EVID/cpu-quota-live.txt" 2>&1 &
CPID=$!
sleep 3
CGN=cpu-quota-live
{ echo "cfs_quota_us: $(cat /sys/fs/cgroup/cpu/$CGN/cpu.cfs_quota_us 2>&1)"
  echo "host_tasks_in_cgroup: $(wc -l < /sys/fs/cgroup/cpu/$CGN/tasks 2>&1)"
  echo "cpu.stat: $(tr '\n' ' ' < /sys/fs/cgroup/cpu/$CGN/cpu.stat 2>&1)"
  echo "memory.limit_in_bytes: $(cat /sys/fs/cgroup/memory/$CGN/memory.limit_in_bytes 2>&1)"
  echo "pids.max: $(cat /sys/fs/cgroup/pids/$CGN/pids.max 2>&1) pids.current: $(cat /sys/fs/cgroup/pids/$CGN/pids.current 2>&1)"
} > "$EVID/cpu-quota-live.cgroup.txt"
wait "$CPID"; echo "exit=$?" >> "$EVID/cpu-quota-live.txt"

# Start-up cost: 5 sandboxes running /bin/true, against 5 host execs.
python3 -I "$SPIKE/startup-timing.py" "$RUN" "$RUNSC" "$WORK" > "$EVID/startup-timing.json"
# stdio round trip (the MCP stdio shape): line-delimited JSON echo, 200 requests.
python3 -I "$SPIKE/stdio-rtt.py" "$RUN" "$RUNSC" "$WORK" > "$EVID/stdio-rtt.json"
echo "done" >&2

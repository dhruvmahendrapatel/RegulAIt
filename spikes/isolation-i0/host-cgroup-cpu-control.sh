#!/usr/bin/env bash
# Control for the CPU-quota probe: does this HOST enforce a cgroup v1 CFS quota at all, with no
# gVisor involved? Runs stress.py cpu in a fresh cpu cgroup at quota 50000/100000, then unlimited.
# Usage: host-cgroup-cpu-control.sh <evidence_file>
set -u
OUT=$1
SPIKE=$(cd "$(dirname "$0")" && pwd)
CG=/sys/fs/cgroup/cpu/i0-cpu-control-$$
{
  echo "cfs_bandwidth_files: $(ls /sys/fs/cgroup/cpu/ | grep -c cfs_quota_us)"
  mkdir "$CG" || { echo "mkdir failed"; exit 1; }
  echo 100000 > "$CG/cpu.cfs_period_us"
  echo 50000 > "$CG/cpu.cfs_quota_us"
  echo "quota_read_back: $(cat "$CG/cpu.cfs_quota_us")/$(cat "$CG/cpu.cfs_period_us")"
  # The child moves itself into the cgroup before exec, so only it (and its children) is limited.
  echo "limited: $(sh -c "echo \$\$ > $CG/cgroup.procs; exec python3 -I $SPIKE/stress.py cpu 3")"
  echo "throttled: $(grep -E 'nr_throttled|throttled_time' "$CG/cpu.stat" | tr '\n' ' ')"
  echo "unlimited: $(python3 -I "$SPIKE/stress.py" cpu 3)"
  rmdir "$CG"
} > "$OUT" 2>&1
cat "$OUT"

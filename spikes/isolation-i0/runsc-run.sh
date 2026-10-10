#!/usr/bin/env bash
# Run one command in a fresh gVisor sandbox. Throwaway I0 spike helper.
# Usage: runsc-run.sh <runsc_bin> <work_dir> <restricted|restricted-uid0|restricted-nproc|relaxed> <none|host> <name> -- <argv...>
# Prints the workload's stdout/stderr; exits with the workload's (or runsc's) status.
set -u
RUNSC=$1 WORK=$2 PROFILE=$3 NET=$4 NAME=$5
shift 5; [ "$1" = "--" ] && shift
SPIKE=$(cd "$(dirname "$0")" && pwd)
BUNDLE="$WORK/bundles/$NAME"
mkdir -p "$WORK/state" "$WORK/logs/$NAME"
python3 -I "$SPIKE/make-bundle.py" "$BUNDLE" "$PROFILE" "$SPIKE" -- "$@" >/dev/null
# restricted*: --oci-seccomp, or runsc IGNORES the spec's seccomp filter (boot log: "Seccomp spec is
#   being ignored because oci-seccomp is disabled"). relaxed: an in-memory root overlay, because
#   the default overlay medium cannot be created over the host root used by this spike.
case "$PROFILE" in
  relaxed) EXTRA="--overlay2=root:memory" ;;
  *) EXTRA="--oci-seccomp" ;;
esac
"$RUNSC" --root="$WORK/state" --platform=systrap --network="$NET" $EXTRA \
  --debug --debug-log="$WORK/logs/$NAME/" \
  run --bundle "$BUNDLE" "$NAME"
rc=$?
"$RUNSC" --root="$WORK/state" delete --force "$NAME" >/dev/null 2>&1
exit $rc

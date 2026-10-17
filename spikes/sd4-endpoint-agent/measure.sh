#!/usr/bin/env bash
# SD4 spike: print each binary's size and gzip -9 size in bytes. Usage: measure.sh <binary>...
# Peak RSS is measured separately with peakrss/ (see the spike note for its floor).
set -euo pipefail
for b in "$@"; do
  echo "$(basename "$b") size=$(stat -c %s "$b") gzip9=$(gzip -9 -c "$b" | wc -c)"
done

#!/usr/bin/env bash
# SD4 spike: cross-compile the Go hello world and size probe for the six target platforms
# from Linux, with no C toolchain (CGO_ENABLED=0). Usage: build-go.sh <output-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"
mkdir -p "$out"
for prog in go-hello go-probe; do
  for t in darwin/arm64 darwin/amd64 windows/amd64 windows/arm64 linux/amd64 linux/arm64; do
    os="${t%/*}"; arch="${t#*/}"; ext=""
    [ "$os" = windows ] && ext=.exe
    (cd "$here/$prog" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -trimpath -ldflags "-s -w" -o "$out/$prog-$os-$arch$ext" .)
    # The spike container had little free disk; drop the per-target build cache each time.
    go clean -cache
  done
done
ls -l "$out" | awk 'NR>1 {print $5, $9}'

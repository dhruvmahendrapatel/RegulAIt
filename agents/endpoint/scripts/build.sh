#!/usr/bin/env bash
# Cross-compile the endpoint agent for the six ADR-0195 SD4 targets (R15 §1.1), reproducibly: -trimpath, no VCS
# stamp, an empty build id, CGO off. The darwin binaries are the CGO-off development build: the Secure Enclave
# build needs cgo on the macOS runner (SD4j), so these refuse to create a device key.
#
#   agents/endpoint/scripts/build.sh <out-dir> [version]
set -euo pipefail
out="${1:?usage: build.sh <out-dir> [version]}"
version="${2:-0.0.0-dev}"
case "$version" in *[!0-9A-Za-z.+-]*) echo "bad version: $version" >&2; exit 2 ;; esac
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$out"
for target in darwin/arm64 darwin/amd64 windows/amd64 windows/arm64 linux/amd64 linux/arm64; do
  os="${target%/*}"; arch="${target#*/}"
  name="regulait-agent-${os}-${arch}"
  [ "$os" = windows ] && name="${name}.exe"
  (cd "$here" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -buildvcs=false \
    -ldflags "-s -w -buildid= -X github.com/dhruvmahendrapatel/regulait/agents/endpoint/internal/agent.Version=${version}" \
    -o "$out/$name" ./cmd/regulait-agent)
done
(cd "$out" && sha256sum regulait-agent-* > SHA256SUMS)
cat "$out/SHA256SUMS"

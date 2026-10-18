#!/usr/bin/env bash
# Build the .deb and .rpm for linux/amd64 and linux/arm64 with nfpm (MIT; pinned below; build-time only).
# Unsigned: package signing needs the Linux package-signing key, which does not exist yet (pending execution).
#
#   agents/endpoint/scripts/package-linux.sh <bin-dir from build.sh> <out-dir> <version>
set -euo pipefail
bin="${1:?bin dir}"; out="${2:?out dir}"; version="${3:?version}"
case "$version" in *[!0-9A-Za-z.+-]*) echo "bad version: $version" >&2; exit 2 ;; esac
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$(cd -- "$bin" && pwd)"; mkdir -p "$out"; out="$(cd -- "$out" && pwd)"
NFPM="github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.47.0"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
(cd "$here" && GOBIN="$stage/bin" go install "$NFPM")
for arch in amd64 arm64; do
  rm -rf "$stage/$arch" && mkdir -p "$stage/$arch"
  cp "$here"/packaging/linux/* "$stage/$arch/"
  install -m 0755 "$bin/regulait-agent-linux-$arch" "$stage/$arch/regulait-agent"
  for fmt in deb rpm; do
    (cd "$stage/$arch" && AGENT_ARCH="$arch" AGENT_VERSION="$version" \
      "$stage/bin/nfpm" package --config nfpm.yaml --packager "$fmt" --target "$out/")
  done
done
ls -l "$out"

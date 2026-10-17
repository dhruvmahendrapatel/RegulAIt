#!/usr/bin/env bash
# Build the UNSIGNED macOS flat package on a macOS host (R15 §4.4): a universal binary (lipo of the arm64 and
# amd64 builds), the LaunchAgent and the install step. Developer ID signing and notarisation are separate CI jobs
# that skip until the company Apple account exists (owner decision a; pending execution).
#
#   agents/endpoint/packaging/macos/build-pkg.sh <bin-dir from build.sh> <out-dir> <version>
set -euo pipefail
bin="${1:?bin dir}"; out="${2:?out dir}"; version="${3:?version}"
case "$version" in *[!0-9A-Za-z.+-]*) echo "bad version: $version" >&2; exit 2 ;; esac
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
install -d "$root/Library/Application Support/RegulAIt/Agent/bin" "$root/Library/LaunchAgents"
lipo -create -output "$root/Library/Application Support/RegulAIt/Agent/bin/regulait-agent" \
  "$bin/regulait-agent-darwin-arm64" "$bin/regulait-agent-darwin-amd64"
chmod 0755 "$root/Library/Application Support/RegulAIt/Agent/bin/regulait-agent"
install -m 0644 "$here/com.regulait.agent.plist" "$root/Library/LaunchAgents/com.regulait.agent.plist"
plutil -lint "$root/Library/LaunchAgents/com.regulait.agent.plist"
chmod 0755 "$here/scripts/postinstall"
mkdir -p "$out"
pkgbuild --root "$root" --scripts "$here/scripts" --identifier com.regulait.agent --version "$version" \
  --install-location / "$out/regulait-agent-$version-unsigned.pkg"
pkgutil --payload-files "$out/regulait-agent-$version-unsigned.pkg"

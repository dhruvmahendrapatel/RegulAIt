#!/usr/bin/env bash
# SD4 spike: build a Node single executable application (SEA) from node-probe/probe.mjs.
# Usage: build-node-sea.sh <work-dir> <path-to-esbuild> <path-to-jose-package> <path-to-postject-cli>
# The host node binary is the base. Node 22 SEA uses postject to inject the blob.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$1"; esbuild="$2"; jose="$3"; postject="$4"
mkdir -p "$work/node_modules"
cp "$here/node-probe/probe.mjs" "$here/node-probe/sea-config.json" "$work/"
ln -sfn "$jose" "$work/node_modules/jose"
cd "$work"
"$esbuild" probe.mjs --bundle --platform=node --format=cjs --target=node22 --outfile=probe.cjs --log-level=warning
node --experimental-sea-config sea-config.json
cp "$(command -v node)" sea-probe-linux-x64
node "$postject" sea-probe-linux-x64 NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
ls -l probe.cjs sea-prep.blob sea-probe-linux-x64 "$(command -v node)" | awk '{print $5, $9}'
./sea-probe-linux-x64

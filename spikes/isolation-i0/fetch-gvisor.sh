#!/usr/bin/env bash
# Fetch and verify the pinned gVisor release tarball for the I0 spike. Nothing is installed.
# Usage: fetch-gvisor.sh <dest_dir>
# Verifies twice: against the sha512 pinned here (from THIRD_PARTY.md) and against the
# release's published .sha512 object. Either mismatch aborts and deletes the download.
set -euo pipefail
DEST=$1
RELEASE=20261005.0
BASE="https://storage.googleapis.com/gvisor/releases/release/$RELEASE/x86_64"
PINNED_SHA512=79869ae9a589355a46d46fdac068d9a954e741741ffe77c64e38c56ea955498c1cb04e9bce44e1cce5155333e6b76bee72347c6661bb7c78fd2fe3aad198c8fe
mkdir -p "$DEST"
cd "$DEST"
curl -fsS -o gvisor.tar.bz2 "$BASE/gvisor.tar.bz2"
curl -fsS -o gvisor.tar.bz2.sha512 "$BASE/gvisor.tar.bz2.sha512"
if ! sha512sum -c gvisor.tar.bz2.sha512; then rm -f gvisor.tar.bz2; echo "published sha512 mismatch" >&2; exit 1; fi
if [ "$(sha512sum gvisor.tar.bz2 | cut -d' ' -f1)" != "$PINNED_SHA512" ]; then
  rm -f gvisor.tar.bz2; echo "pinned sha512 mismatch" >&2; exit 1
fi
mkdir -p x
tar xjf gvisor.tar.bz2 -C x
x/runsc --version
echo "runsc and its gvisor-bin/ sidecars are in $DEST/x (they must stay together)"

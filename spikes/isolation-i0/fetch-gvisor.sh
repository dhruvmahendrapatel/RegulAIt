#!/usr/bin/env bash
# Fetch and verify the pinned gVisor release tarball for the I0 spike. Nothing is installed.
# Usage: fetch-gvisor.sh <dest_dir>
# Verifies twice: against the sha512 pinned here (from THIRD_PARTY.md) and against the
# release's published .sha512 object. Either mismatch aborts and deletes the download.
set -euo pipefail
DEST=$1
RELEASE=20261012.0
BASE="https://storage.googleapis.com/gvisor/releases/release/$RELEASE/x86_64"
PINNED_SHA512=9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e
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

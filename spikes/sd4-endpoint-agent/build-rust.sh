#!/usr/bin/env bash
# SD4 spike: build the Rust hello world for the Linux musl targets, linked with the
# toolchain's bundled rust-lld (no system cross linker). Usage: build-rust.sh <output-dir>
# macOS and Windows targets need an SDK or a MinGW/LLVM-MinGW linker that this container
# does not have; they are recorded as pending in the spike note.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"
mkdir -p "$out"
for t in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  (cd "$here/rust-hello" && CARGO_TARGET_DIR="$out/target" \
    RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static" \
    cargo build --release --target "$t" --quiet)
  cp "$out/target/$t/release/sd4-rust-hello" "$out/rust-hello-$t"
done
rm -rf "$out/target"
ls -l "$out" | awk 'NR>1 {print $5, $9}'

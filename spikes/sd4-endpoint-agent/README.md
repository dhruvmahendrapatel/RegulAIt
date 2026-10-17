# SD4 endpoint agent spike: size probes

Throwaway code for the design spike in [`docs/research/R15-endpoint-agent-sd4-spike.md`](../../docs/research/R15-endpoint-agent-sd4-spike.md)
(ADR-0195 slice SD4). Nothing here is product code, nothing is in the pnpm workspace, and nothing is shipped.

| Path | What it is |
|---|---|
| `go-hello/` | Go hello world: the toolchain's floor binary size |
| `go-probe/` | Go, standard library only: Ed25519 key, RFC 9449 DPoP proof and RFC 7638 thumbprint, one directory listing, a TLS 1.3 HTTP client. No network call |
| `rust-hello/` | Rust hello world, release profile tuned for size |
| `node-probe/` | The `go-probe` equivalent in Node, using `jose` 6.2.12 (the version the gateway pins), packaged as a Node 22 single executable application |
| `peakrss/` | Runs a binary and prints its peak RSS (Linux `ru_maxrss`) |
| `build-go.sh` | Cross-compiles both Go programs for six targets with `CGO_ENABLED=0` |
| `build-rust.sh` | Builds the Rust hello world for the two Linux musl targets with the bundled `rust-lld` |
| `build-node-sea.sh` | Bundles `node-probe` with esbuild and injects it into the host `node` with postject |
| `measure.sh` | Prints size and gzip -9 size |

## What was executed (2026-10-17, Linux x86_64 container)

Toolchains: Go 1.24.7, rustc 1.94.1, Node 22.22.2, esbuild 0.28.2 (from the workspace store), postject 1.0.0-alpha.6
(installed into the session scratchpad, not the repo).

```sh
bash spikes/sd4-endpoint-agent/build-go.sh <out>/go
bash spikes/sd4-endpoint-agent/build-rust.sh <out>/rust
bash spikes/sd4-endpoint-agent/build-node-sea.sh <out>/node <esbuild-bin> <jose-package-dir> <postject-cli.js>
bash spikes/sd4-endpoint-agent/measure.sh <out>/go/* <out>/rust/rust-hello-* <out>/node/sea-probe-linux-x64
(cd spikes/sd4-endpoint-agent/peakrss && go build -o <out>/peakrss .)
<out>/peakrss <out>/go/go-hello-linux-amd64 <out>/go/go-probe-linux-amd64 <out>/rust/rust-hello-x86_64-unknown-linux-musl <out>/node/sea-probe-linux-x64
```

`build-rust.sh` needs the `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` standard libraries
(`rustup target add …`); they were added for the run and removed afterwards because the container was short of disk.
Results are in the spike note, §1.3. macOS and Windows binaries were built (Go) but not run: there is no macOS or
Windows host here.

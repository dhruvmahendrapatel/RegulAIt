# Third-party components — `@regulait/sandbox-executor`

Open-source components this package ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained; pinned;
works air-gapped). npm dependencies are pinned through `pnpm-lock.yaml`. The package is the executor shim of ADR-0190
decision 4; it runs beside a container runtime, never in the gateway.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `jose` (npm, github.com/panva/jose, © Filip Skokan) | `6.2.12` (exact; the version the gateway pins) | MIT | ADR-0190 I3: the executor's ADR-0188 key material and signatures — the one-use channel proof (a compact JWS, `SignJWT`, EdDSA under the registered workload key) on every channel request, the detached signature over each attestation report (`FlattenedSign` with `b64: false`, RFC 7797), the RFC 7638 key thumbprint (`calculateJwkThumbprint`) and JWK export. No dependencies, pure JavaScript, no network. The same library the gateway verifies with, so a signature produced here is checked by the same implementation there. |
| `write-file-atomic` (npm, github.com/npm/write-file-atomic, © npm, Inc.) | `8.0.0` (exact; the version `@regulait/engine-runner` pins) | ISC | The executor's private key file (`src/keys.ts`): written to a temp file beside the target, fsynced, given mode 0600 and renamed over the target, so a crash never leaves a truncated or world-readable key. Pure JavaScript, no install script, no network. Its one dependency, `signal-exit` 4.1.0 (ISC), is recorded in `packages/engine-runner/THIRD_PARTY.md`. |
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `4.6.5` (exact, as locked for the whole workspace; ADR-0192) | MIT | The channel and report schemas come from `@regulait/shared`; this package parses every gateway answer with them before acting on it (a malformed answer is transient, never an instruction). |

## In the executor image (ADR-0190 slice I4), not npm dependencies

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| Docker CLI (`docker:29.3.1-cli@sha256:18f5ab0fab739ea822819b342357947dfba235cdef438cce345ebc0c143c5b34`, the official image's `/usr/local/bin/docker`) | 29.3.1, pinned by the image digest in `Dockerfile` | Apache-2.0 | The `gvisor` backend (`src/runsc-backend.ts`) and the `runc` (L1) backend (`src/runc-backend.ts`), through their shared core (`src/docker-backend.ts`), start, kill and remove each sandbox with Docker's own CLI (`docker run -i --runtime runsc` or `--runtime runc`, `--pull never`) on the host daemon whose socket compose mounts. Open source first (ADR-0176): no Docker client of our own; the few executor-side reads (`/info`, a container's inspect and stats) are plain GETs to the same documented Engine API. |
| Node.js base (`node:22-trixie-slim@sha256:8eb619e4…`, Node 22.23.4) | as the gateway's `Dockerfile` | MIT (Node.js) | The executor's runtime and the stdio base image (`stdio-base/Dockerfile`), where the sandbox init runs. |

gVisor (`runsc`, Apache-2.0, `release-20261012.0`) is **not** in any image: it is installed on the Docker host from
the release tarball pinned by sha512 in `spikes/isolation-i0/THIRD_PARTY.md` and registered with the daemon
(INSTALL.md). runc (Apache-2.0), the `runc` backend's runtime, is not in any image either: it is the Docker Engine's
default runtime, installed with the host's Docker; the backend checks the daemon's posture (`/info`) and each
container's `HostConfig` from outside and adds no dependency (ADR-0190, the runc L1 backend). The fake backend for tests is exported from `./testing` and never wired by `main.ts`.

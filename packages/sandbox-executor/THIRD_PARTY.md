# Third-party components — `@regulait/sandbox-executor`

Open-source components this package ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained; pinned;
works air-gapped). npm dependencies are pinned through `pnpm-lock.yaml`. The package is the executor shim of ADR-0190
decision 4; it runs beside a container runtime, never in the gateway.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `jose` (npm, github.com/panva/jose, © Filip Skokan) | `6.2.12` (exact; the version the gateway pins) | MIT | ADR-0190 I3: the executor's ADR-0188 key material and signatures — the one-use channel proof (a compact JWS, `SignJWT`, EdDSA under the registered workload key) on every channel request, the detached signature over each attestation report (`FlattenedSign` with `b64: false`, RFC 7797), the RFC 7638 key thumbprint (`calculateJwkThumbprint`) and JWK export. No dependencies, pure JavaScript, no network. The same library the gateway verifies with, so a signature produced here is checked by the same implementation there. |
| `write-file-atomic` (npm, github.com/npm/write-file-atomic, © npm, Inc.) | `8.0.0` (exact; the version `@regulait/engine-runner` pins) | ISC | The executor's private key file (`src/keys.ts`): written to a temp file beside the target, fsynced, given mode 0600 and renamed over the target, so a crash never leaves a truncated or world-readable key. Pure JavaScript, no install script, no network. Its one dependency, `signal-exit` 4.1.0 (ISC), is recorded in `packages/engine-runner/THIRD_PARTY.md`. |
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `^3.25.67` (as locked for the whole workspace) | MIT | The channel and report schemas come from `@regulait/shared`; this package parses every gateway answer with them before acting on it (a malformed answer is transient, never an instruction). |

What is deliberately NOT here: a container runtime client. Slice I4 adds the gVisor backend; I3 ships only the
`SandboxBackend` interface and a fake backend for tests (exported from `./testing`, never wired by `main.ts`).

/**
 * ADR-0190 I3 — the executor process. Reads its configuration from the
 * environment (no secret in it: the key is a file on the executor's own
 * volume, decision 5), prints the public key for an admin to register on
 * first start, and runs the loop against the backend named by
 * `REGULAIT_EXECUTOR_BACKEND`.
 *
 * Backends: `gvisor` (slice I4, `runsc` under Docker); `kata` arrives with
 * I6 and `openshell` with I7. Any other name refuses to start (exit 2)
 * rather than run anything that is not a real OS boundary — and the fake
 * backend is deliberately not reachable from here.
 */
import { loadOrCreateExecutorKey } from "./keys.js";
import { ProofChannelCredential } from "./channel-credential.js";
import { checkGatewayUrl, ExecutorClient, ExecutorConfigError } from "./client.js";
import { ExecutorFatalError, runExecutorLoop } from "./loop.js";
import type { SandboxBackend } from "./backend.js";
import { RunscBackendError, RunscDockerBackend } from "./runsc-backend.js";

/**
 * The backends a deployment may name (I6 adds kata, I7 openshell). `gvisor`
 * (I4) is the runsc backend on a Docker host: it checks, before the executor
 * announces anything, that the daemon has the named runtime and that it is
 * runsc, and refuses to start otherwise.
 */
const BACKENDS: Readonly<Record<string, (() => Promise<SandboxBackend>) | undefined>> = {
  gvisor: async () => {
    const backend = new RunscDockerBackend({
      runtimeName: process.env.REGULAIT_EXECUTOR_RUNSC_RUNTIME || "runsc",
      canaryImage: required("REGULAIT_EXECUTOR_CANARY_IMAGE"),
      runtimeVersion: required("REGULAIT_EXECUTOR_RUNSC_VERSION"),
      ...(process.env.REGULAIT_EXECUTOR_DOCKER_SOCKET ? { dockerSocket: process.env.REGULAIT_EXECUTOR_DOCKER_SOCKET } : {}),
      seccompDir: process.env.REGULAIT_EXECUTOR_SECCOMP_DIR || null,
    });
    await backend.preflight();
    return backend;
  },
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return v;
}

export async function main(): Promise<void> {
  const gatewayUrl = required("REGULAIT_GATEWAY_URL");
  const issuer = required("REGULAIT_PUBLIC_URL");
  const identifier = required("REGULAIT_EXECUTOR_IDENTIFIER");
  const keyFile = required("REGULAIT_EXECUTOR_KEY_FILE");
  const backendName = required("REGULAIT_EXECUTOR_BACKEND");
  // amendment V: https only; plain http for a loopback host, or behind this development flag (default off, logged)
  const allowInsecureHttp = process.env.REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP === "1";
  if (allowInsecureHttp) console.warn("REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP=1: a plain http gateway URL is accepted (development only; never in a deployment)");
  try {
    checkGatewayUrl(gatewayUrl, allowInsecureHttp);
  } catch (e) {
    if (e instanceof ExecutorConfigError) {
      console.error(`REGULAIT_GATEWAY_URL: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const factory = Object.hasOwn(BACKENDS, backendName) ? BACKENDS[backendName] : undefined;
  if (!factory) {
    console.error(`REGULAIT_EXECUTOR_BACKEND=${backendName}: no such backend in this build (available: ${Object.keys(BACKENDS).join(", ")})`);
    process.exit(2);
  }
  const { key, created } = await loadOrCreateExecutorKey(keyFile);
  if (created) {
    console.log(`generated the executor key at ${keyFile}; register this public key on the executor's worker_runtime identity before it can announce:`);
    console.log(JSON.stringify({ publicJwk: key.publicJwk, thumbprint: key.thumbprint }));
  }
  const credential = new ProofChannelCredential({ identifier, key, issuer });
  const client = new ExecutorClient({ gatewayUrl, credential, allowInsecureHttp });
  let backend: SandboxBackend;
  try {
    backend = await factory();
  } catch (e) {
    // a missing runtime, a runtime that is not runsc, an unreachable Docker socket: nothing starts (exit 2)
    console.error(`REGULAIT_EXECUTOR_BACKEND=${backendName}: ${e instanceof RunscBackendError ? e.message : `the backend is not usable: ${(e as Error).message}`}`);
    process.exit(2);
  }
  try {
    await runExecutorLoop({ client, backend, credential, log: (m) => console.log(m) });
  } catch (e) {
    if (e instanceof ExecutorFatalError) {
      console.error(e.message);
      process.exit(3);
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}

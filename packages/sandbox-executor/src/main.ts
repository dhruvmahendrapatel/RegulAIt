/**
 * ADR-0190 I3 — the executor process. Reads its configuration from the
 * environment (no secret in it: the key is a file on the executor's own
 * volume, decision 5), prints the public key for an admin to register on
 * first start, and runs the loop against the backend named by
 * `REGULAIT_EXECUTOR_BACKEND`.
 *
 * I3 ships NO backend: `gvisor` arrives with slice I4, `kata` with I6,
 * `openshell` with I7. Until then this process refuses to start (exit 2)
 * rather than run anything that is not a real OS boundary — and the fake
 * backend is deliberately not reachable from here.
 */
import { loadOrCreateExecutorKey } from "./keys.js";
import { ProofChannelCredential } from "./channel-credential.js";
import { ExecutorClient } from "./client.js";
import { ExecutorFatalError, runExecutorLoop } from "./loop.js";
import type { SandboxBackend } from "./backend.js";

/** the backends a deployment may name (filled by I4/I6/I7) */
const BACKENDS: Readonly<Record<string, (() => Promise<SandboxBackend>) | undefined>> = {};

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
  const factory = BACKENDS[backendName];
  if (!factory) {
    console.error(`REGULAIT_EXECUTOR_BACKEND=${backendName}: no such backend in this build (ADR-0190 I3 ships none; I4 adds gvisor)`);
    process.exit(2);
  }
  const { key, created } = await loadOrCreateExecutorKey(keyFile);
  if (created) {
    console.log(`generated the executor key at ${keyFile}; register this public key on the executor's worker_runtime identity before it can announce:`);
    console.log(JSON.stringify({ publicJwk: key.publicJwk, thumbprint: key.thumbprint }));
  }
  const credential = new ProofChannelCredential({ identifier, key, issuer });
  const client = new ExecutorClient({ gatewayUrl, credential });
  const backend = await factory();
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

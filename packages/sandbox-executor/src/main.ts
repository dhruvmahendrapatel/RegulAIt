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
import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import { loadOrCreateExecutorKey } from "./keys.js";
import { ProofChannelCredential } from "./channel-credential.js";
import { checkGatewayUrl, ExecutorClient, ExecutorConfigError, probeGatewayReachable } from "./client.js";
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
      // review H2: the init this build ships (next to dist/), copied into the init volume this executor owns
      initSource: fileURLToPath(new URL("../sandbox-init/sandbox-init.mjs", import.meta.url)),
      initDir: process.env.REGULAIT_EXECUTOR_INIT_DIR || "/regulait-init",
      initVolume: required("REGULAIT_EXECUTOR_INIT_VOLUME"),
      // review H2: the host's runsc, mounted read-only into this container, and the path the daemon names for it
      runscBinary: process.env.REGULAIT_EXECUTOR_RUNSC_BINARY || "/host-gvisor/runsc",
      runscHostPath: required("REGULAIT_EXECUTOR_RUNSC_HOST_PATH"),
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

/** the largest CA bundle the executor reads (a pinned bundle is a handful of certificates) */
const GATEWAY_CA_MAX_BYTES = 256 * 1024;
const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_END = "-----END CERTIFICATE-----";

/** the PEM certificate blocks of a bundle, in order; text outside the blocks is ignored (indexOf, no regex: M-074) */
export function splitPemCertificates(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const begin = text.indexOf(PEM_BEGIN, at);
    if (begin < 0) return out;
    const end = text.indexOf(PEM_END, begin + PEM_BEGIN.length);
    if (end < 0) throw new ExecutorConfigError("the CA bundle has a certificate block with no END line");
    out.push(`${text.slice(begin, end + PEM_END.length)}\n`);
    at = end + PEM_END.length;
  }
}

export interface GatewayCaPin {
  file: string;
  /** SHA-256 fingerprints of the pinned CA certificates (`openssl x509 -noout -fingerprint -sha256` format) */
  fingerprints: string[];
}

/**
 * ADR-0190 I4 follow-up (the executor's TLS front): PIN the CA bundle the executor trusts for the gateway.
 *
 * With `REGULAIT_EXECUTOR_GATEWAY_CA_FILE` set and an https gateway URL, the file's CA certificates REPLACE the
 * process's default trust (`tls.setDefaultCACertificates`, which global `fetch` uses for every new connection).
 * The executor then trusts the CA in that file and nothing else, not the public roots. In the stock compose stack
 * that is the stack-local CA of its front. Unset, the image's bundled roots verify the gateway as before (a
 * deployment whose front has a publicly issued certificate).
 *
 * There is no way to skip verification: `NODE_TLS_REJECT_UNAUTHORIZED=0` refuses to start. Every refusal is an
 * `ExecutorConfigError` (exit 2). Call it before the first https request.
 */
export function pinGatewayCa(opts: {
  gatewayUrl: string;
  caFile: string | undefined;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  setDefault?: (certs: string[]) => void;
}): GatewayCaPin | null {
  const env = opts.env ?? process.env;
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ExecutorConfigError(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate verification off, and the executor refuses to run that way. Unset it, and pin the gateway's CA with REGULAIT_EXECUTOR_GATEWAY_CA_FILE",
    );
  }
  if (!opts.caFile) return null;
  // plain http (a loopback host, or the development override) has no certificate to check
  if (new URL(opts.gatewayUrl).protocol !== "https:") return null;
  const name = `REGULAIT_EXECUTOR_GATEWAY_CA_FILE=${opts.caFile}`;
  let text: string;
  try {
    const st = statSync(opts.caFile);
    if (!st.isFile()) throw new ExecutorConfigError(`${name} is not a regular file`);
    if (st.size > GATEWAY_CA_MAX_BYTES) throw new ExecutorConfigError(`${name} is larger than ${GATEWAY_CA_MAX_BYTES} bytes`);
    text = readFileSync(opts.caFile, "utf8");
  } catch (e) {
    if (e instanceof ExecutorConfigError) throw e;
    throw new ExecutorConfigError(`${name} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  const pems = splitPemCertificates(text);
  if (pems.length === 0) throw new ExecutorConfigError(`${name} holds no PEM certificate`);
  const now = (opts.now ?? new Date()).getTime();
  const fingerprints = pems.map((pem, i) => {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      throw new ExecutorConfigError(`${name}: certificate ${i + 1} does not parse`);
    }
    if (!cert.ca) {
      throw new ExecutorConfigError(`${name}: certificate ${i + 1} (${cert.subject}) is not a CA certificate. Pin the CA that issues the front's certificate, not the certificate itself`);
    }
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new ExecutorConfigError(`${name}: certificate ${i + 1} (${cert.subject}) is not valid now (${cert.validFrom} to ${cert.validTo})`);
    }
    return cert.fingerprint256;
  });
  const setDefault =
    opts.setDefault ?? (typeof tls.setDefaultCACertificates === "function" ? (c: string[]) => tls.setDefaultCACertificates(c) : undefined);
  if (!setDefault) {
    throw new ExecutorConfigError(`this Node.js (${process.version}) cannot replace its default CA certificates (tls.setDefaultCACertificates needs Node 22.19 or later), so the gateway's CA cannot be pinned`);
  }
  setDefault(pems);
  return { file: opts.caFile, fingerprints };
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
  // TLS front follow-up: pin the gateway's CA before the first https request (exit 2 on any problem with it)
  const caFile = process.env.REGULAIT_EXECUTOR_GATEWAY_CA_FILE || undefined;
  try {
    const pin = pinGatewayCa({ gatewayUrl, caFile });
    if (pin) console.log(`pinned the gateway CA bundle ${pin.file}: ${pin.fingerprints.join(", ")}`);
    else if (caFile) console.warn("REGULAIT_EXECUTOR_GATEWAY_CA_FILE is ignored: the gateway URL is not https");
  } catch (e) {
    if (e instanceof ExecutorConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  // recheck: an https gateway this executor cannot reach (no route from its network, no TLS front, a certificate it
  // does not trust) stops it at start with the reason, instead of a silent retry loop (exit 2; compose restarts it)
  const unreachable = await probeGatewayReachable(gatewayUrl);
  if (unreachable) {
    console.error(`REGULAIT_GATEWAY_URL: ${unreachable}. In the stock compose stack that is the executor's TLS front (https://executor-front:8443, its CA pinned from REGULAIT_EXECUTOR_GATEWAY_CA_FILE). Otherwise set REGULAIT_EXECUTOR_GATEWAY_URL to an https address of the gateway this executor's network can reach, and REGULAIT_EXECUTOR_GATEWAY_CA_FILE to the CA that issued its certificate (docs/deployment/INSTALL.md).`);
    process.exit(2);
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

/**
 * ADR-0190 I3 — THE BACKEND INTERFACE: what starts sandboxes under an
 * execution profile and runs decision 6's probes inside them. The executor
 * core (loop, offers, self-test, quarantine) is written against this; slice
 * I4 adds the gVisor backend (`runsc`), I6 Kata, I7 OpenShell. I3 ships only
 * the fake backend for tests (`./testing`).
 *
 * Two uses of one probe set:
 *  - the SELF-TEST: a canary sandbox under the profile under test, probed and
 *    killed (hourly; the gateway keeps the verdict 2 h at most);
 *  - the PER-PLACEMENT report: the workload's own sandbox, probed BEFORE the
 *    first byte of input is released to it (`SandboxHandle.releaseInput`
 *    must not be called until the gateway answered `release: true`).
 */
import type { AppliedIsolationKind, AttestationProbe, ExecutionOffer, ExecutionProfileBody, ExecutorBackend, ExecutorReport } from "@regulait/shared";

/** every probe's observation (or why it did not run), as the report carries them */
export type ProbeSet = ExecutorReport["probes"];

export interface BackendDescription {
  backend: ExecutorBackend;
  runtimeVersion: string;
  /** the classes this backend can attest on this host (the admin's registration must agree) */
  classes: readonly AppliedIsolationKind[];
}

export interface SandboxHandle {
  readonly id: string;
  /** the image the sandbox runs (digest-pinned) */
  readonly imageDigest: string;
  /** run the probes inside this sandbox (and the executor-side ones around it) */
  probe(probes: readonly AttestationProbe[]): Promise<ProbeSet>;
  /** release the workload's input: ONLY after the gateway accepted the per-placement report */
  releaseInput(): Promise<void>;
  /** stop the sandbox now (a mismatch, a quarantine, a limit, a cancel) */
  kill(): Promise<void>;
  /** resolves when the sandbox has ended, with how */
  readonly ended: Promise<"completed" | "failed" | "killed" | "limit_exceeded">;
}

export interface SandboxBackend {
  describe(): BackendDescription;
  /** start a canary sandbox under `profile` at `cls` for a self-test; the caller probes and kills it */
  startCanary(profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle>;
  /** start the sandbox for an accepted offer under its profile at `cls` */
  start(offer: ExecutionOffer, profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle>;
}

/**
 * ADR-0190 I3 (stdio added by I4) — THE BACKEND INTERFACE: what starts sandboxes under an
 * execution profile and runs decision 6's probes inside them. The executor
 * core (loop, offers, self-test, quarantine) is written against this; slice
 * I4 adds the gVisor backend (`runsc-backend.ts`, L2), the I5 follow-up the runc
 * backend (`runc-backend.ts`, L1 only; both on the Docker core in
 * `docker-backend.ts`), I6 Kata, I7 OpenShell. The fake backend for tests is
 * `./testing`.
 *
 * Two uses of one probe set:
 *  - the SELF-TEST: a canary sandbox under the profile under test, probed and
 *    killed (hourly; the gateway keeps the verdict 2 h at most);
 *  - the PER-PLACEMENT report: the workload's own sandbox, probed BEFORE the
 *    first byte of input is released to it (`SandboxHandle.releaseInput`
 *    must not be called until the gateway answered `release: true`).
 */
import type { AppliedIsolationKind, AttestationProbe, ExecutionOffer, ExecutionProfileBody, ExecutorBackend, ExecutorReport, StdioWorkload } from "@regulait/shared";
import type { SandboxTaskInput } from "./task-input.js";

/** every probe's observation (or why it did not run), as the report carries them */
export type ProbeSet = ExecutorReport["probes"];

export interface BackendDescription {
  backend: ExecutorBackend;
  runtimeVersion: string;
  /** the classes this backend can attest on this host (the admin's registration must agree) */
  classes: readonly AppliedIsolationKind[];
}

/**
 * I4: the workload's stdio, for an `mcp_stdio` sandbox. Usable ONLY after
 * `releaseInput()` (before it, the sandbox init owns stdin and nothing is
 * written). One line each way is one JSON-RPC message (MCP's stdio
 * transport); a line longer than `STDIO_FRAME_MAX_BYTES` ends the sandbox
 * (`limit_exceeded`).
 */
export interface SandboxStdio {
  /** write one line (without its newline) to the server's stdin */
  write(line: string): Promise<void>;
  /** end the server's stdin (the gateway closed the session) */
  endInput(): Promise<void>;
  /** the server's stdout, line by line, until it ends */
  lines(): AsyncIterable<string>;
}

export interface SandboxHandle {
  readonly id: string;
  /** the image the sandbox runs (digest-pinned) */
  readonly imageDigest: string;
  /** run the probes inside this sandbox (and the executor-side ones around it) */
  probe(probes: readonly AttestationProbe[]): Promise<ProbeSet>;
  /**
   * release the workload's input: ONLY after the gateway accepted the
   * per-placement report. For an `mcp_stdio` sandbox, `workload` is the
   * registered entry point and argv (the gateway's `start` message): the
   * sandbox init runs it then, never before.
   */
  releaseInput(workload?: StdioWorkload, secret?: string): Promise<void>;
  /**
   * ADR-0190 I5: the digest of the read-only input this backend WROTE and mounted (`engineTaskInputDigest`), for a
   * placement whose profile declares inputs; the per-placement report names it. Absent when there is none.
   */
  readonly inputSha256?: string;
  /** stop the sandbox now (a mismatch, a quarantine, a limit, a cancel) */
  kill(): Promise<void>;
  /** I4: the workload's stdio (mcp_stdio sandboxes only; absent for a canary) */
  readonly stdio?: SandboxStdio;
  /** resolves when the sandbox has ended, with how */
  readonly ended: Promise<"completed" | "failed" | "killed" | "limit_exceeded">;
}

export interface SandboxBackend {
  describe(): BackendDescription;
  /** start a canary sandbox under `profile` at `cls` for a self-test; the caller probes and kills it */
  startCanary(profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle>;
  /**
   * start the sandbox for an accepted offer under its profile at `cls`. I5: `task` is an engine task's input, written
   * and mounted read-only before the sandbox starts (required exactly when the profile declares inputs)
   */
  start(offer: ExecutionOffer, profile: ExecutionProfileBody, cls: AppliedIsolationKind, task?: SandboxTaskInput): Promise<SandboxHandle>;
  /**
   * ADR-0190 I5 (review MEDIUM-2): why this backend cannot serve a placement under `profile` on this host (e.g. an
   * engine_worker profile's input with no input volume configured), or null. A profile it cannot serve is never
   * self-tested, so never attested: the broker never offers it here, and an offer that still arrives is declined
   * (`attestation_stale`) before anything is accepted.
   */
  unsupported?(profile: ExecutionProfileBody): string | null;
}

/**
 * ADR-0190 slice I4 — THE runsc BACKEND ON A REAL DOCKER DAEMON WITH gVisor.
 *
 * Runs only where the host has a Docker daemon with gVisor registered as a
 * runtime and the RegulAIt stdio base image built (INSTALL.md, "Sandboxed
 * stdio MCP servers"). Set:
 *   REGULAIT_TEST_RUNSC_RUNTIME     the daemon's runtime name for runsc (e.g. `runsc`)
 *   REGULAIT_TEST_STDIO_BASE_IMAGE  the stdio base image's content digest (`sha256:…`)
 *   REGULAIT_TEST_RUNC_RUNTIME      optional: `runc`, for the negative control
 * Otherwise the suite is SKIPPED, and its title says why: it never passes
 * vacuously. The CI runners do not install gVisor (the I0 spike did not run
 * it there, R13 "Needs a real host or CI"), so in CI this suite is skipped and
 * the stdio-move guarantees are proven against the fake backend instead
 * (`apps/gateway/src/zz-adr0190-i4-stdio-move.test.ts`).
 *
 * What it proves where it runs: the canary sandbox under the shipped
 * `restricted` profile passes the gateway's own evaluator at
 * `user_space_kernel` (decision 6's probe set, from inside gVisor and from the
 * daemon); and a runtime that is not runsc (the negative control) is refused
 * before any sandbox starts.
 */
import { describe, expect, it } from "vitest";
import { evaluateExecutorReport, executionProfileDigest, requiredReportProbes, SHIPPED_EXECUTION_PROFILES } from "@regulait/shared";
import { RunscDockerBackend } from "./runsc-backend.js";
import { buildReport } from "./report.js";

const RUNTIME = process.env.REGULAIT_TEST_RUNSC_RUNTIME ?? "";
const IMAGE = process.env.REGULAIT_TEST_STDIO_BASE_IMAGE ?? "";
const RUNC = process.env.REGULAIT_TEST_RUNC_RUNTIME ?? "";
const enabled = RUNTIME !== "" && IMAGE !== "";
const why = enabled
  ? "on a Docker daemon with gVisor"
  : "SKIPPED: no Docker daemon with gVisor here (set REGULAIT_TEST_RUNSC_RUNTIME and REGULAIT_TEST_STDIO_BASE_IMAGE to run it)";

const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
const ID = "spiffe://test.example/regulait/worker_runtime/runsc-it";

async function canaryVerdict(runtimeName: string) {
  const backend = new RunscDockerBackend({ runtimeName, canaryImage: IMAGE, runtimeVersion: "release-20261005.0" });
  const h = await backend.startCanary(restricted, "user_space_kernel");
  try {
    const probes = await h.probe(requiredReportProbes(restricted, "gvisor", "user_space_kernel"));
    const report = buildReport({ kind: "self_test", identifier: ID, backend: backend.describe(), profileDigest: executionProfileDigest(restricted), cls: "user_space_kernel", probes });
    return evaluateExecutorReport(report, { profile: restricted, profileDigest: executionProfileDigest(restricted), backend: "gvisor", classesDeclared: ["user_space_kernel"] });
  } finally {
    await h.kill();
  }
}

describe.skipIf(!enabled)(`the runsc backend ${why}`, () => {
  it("the canary under the restricted profile passes the gateway's evaluator at user_space_kernel", async () => {
    expect(await canaryVerdict(RUNTIME)).toEqual({ verdict: "pass", failures: [] });
  }, 120_000);

  it.skipIf(RUNC === "")("negative control: a runtime that is not runsc is refused before any sandbox starts", async () => {
    await expect(canaryVerdict(RUNC)).rejects.toThrow(/not runsc/);
  }, 120_000);
});

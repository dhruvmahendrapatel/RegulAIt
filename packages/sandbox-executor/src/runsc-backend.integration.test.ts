/**
 * ADR-0190 slice I4 — THE runsc BACKEND ON A REAL DOCKER DAEMON WITH gVisor.
 *
 * Runs only where the host has a Docker daemon with gVisor registered as a
 * runtime and the RegulAIt stdio base image built (INSTALL.md, "Sandboxed
 * stdio MCP servers"). Set:
 *   REGULAIT_TEST_RUNSC_RUNTIME     the daemon's runtime name for runsc (e.g. `runsc`)
 *   REGULAIT_TEST_STDIO_BASE_IMAGE  the stdio base image's content digest (`sha256:…`)
 *   REGULAIT_TEST_RUNSC_HOST_PATH   the runsc binary the daemon names (hashed against the pinned release)
 *   REGULAIT_TEST_INIT_VOLUME       a Docker volume whose host directory is REGULAIT_TEST_INIT_DIR
 *   REGULAIT_TEST_INIT_DIR          (the executor copies its pinned init there; the sandbox mounts it read-only)
 *   REGULAIT_TEST_RUNC_RUNTIME      optional: `runc`, for the negative control
 *   REGULAIT_TEST_UNPINNED_RUNTIME  optional, with REGULAIT_TEST_UNPINNED_HOST_PATH: a daemon runtime whose binary
 *                                   is a runsc that does NOT hash to the pin (the second negative control)
 *   REGULAIT_TEST_PROBE_REPORT_DIR  optional: where the canary's report and verdict are written (JSON)
 * Otherwise the suite is SKIPPED, and its title says why: it never passes
 * vacuously. The gVisor CI job (`.github/workflows/gvisor.yml`) installs the
 * pinned release on a GitHub-hosted runner, sets every variable above, and
 * fails when any test here is skipped. The other CI jobs have no gVisor and
 * skip it (the stdio-move guarantees are also proven against the fake backend,
 * `apps/gateway/src/zz-adr0190-i4-stdio-move.test.ts`).
 *
 * What it proves where it runs: the canary sandbox under the shipped
 * `restricted` profile passes the gateway's own evaluator at
 * `user_space_kernel` (decision 6's probe set, from inside gVisor and from the
 * daemon), and its runtime probes name gVisor; a runtime that is not runsc and
 * a runsc binary that is not the pinned release (the negative controls) are
 * each refused before any sandbox starts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateExecutorReport, executionProfileDigest, requiredReportProbes, SHIPPED_EXECUTION_PROFILES } from "@regulait/shared";
import { RunscDockerBackend } from "./runsc-backend.js";
import { buildReport } from "./report.js";

const RUNTIME = process.env.REGULAIT_TEST_RUNSC_RUNTIME ?? "";
const IMAGE = process.env.REGULAIT_TEST_STDIO_BASE_IMAGE ?? "";
const RUNC = process.env.REGULAIT_TEST_RUNC_RUNTIME ?? "";
const UNPINNED = process.env.REGULAIT_TEST_UNPINNED_RUNTIME ?? "";
const UNPINNED_PATH = process.env.REGULAIT_TEST_UNPINNED_HOST_PATH ?? "";
const REPORT_DIR = process.env.REGULAIT_TEST_PROBE_REPORT_DIR ?? "";
const enabled = RUNTIME !== "" && IMAGE !== "" && !!process.env.REGULAIT_TEST_RUNSC_HOST_PATH && !!process.env.REGULAIT_TEST_INIT_VOLUME && !!process.env.REGULAIT_TEST_INIT_DIR;
const why = enabled
  ? "on a Docker daemon with gVisor"
  : "SKIPPED: no Docker daemon with gVisor here (set the REGULAIT_TEST_* variables above to run it); L2 is UNVERIFIED until it runs on a real gVisor host";

const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
const ID = "spiffe://test.example/regulait/worker_runtime/runsc-it";

async function canary(runtimeName: string, runscHostPath = process.env.REGULAIT_TEST_RUNSC_HOST_PATH ?? "") {
  const backend = new RunscDockerBackend({
    runtimeName,
    canaryImage: IMAGE,
    runtimeVersion: process.env.REGULAIT_TEST_RUNSC_VERSION ?? "release-20261012.0",
    initSource: fileURLToPath(new URL("../sandbox-init/sandbox-init.mjs", import.meta.url)),
    initDir: process.env.REGULAIT_TEST_INIT_DIR ?? "",
    initVolume: process.env.REGULAIT_TEST_INIT_VOLUME ?? "",
    runscBinary: runscHostPath,
    runscHostPath,
  });
  const h = await backend.startCanary(restricted, "user_space_kernel");
  try {
    const probes = await h.probe(requiredReportProbes(restricted, "gvisor", "user_space_kernel"));
    const report = buildReport({ kind: "self_test", identifier: ID, backend: backend.describe(), profileDigest: executionProfileDigest(restricted), cls: "user_space_kernel", probes });
    const verdict = evaluateExecutorReport(report, { profile: restricted, profileDigest: executionProfileDigest(restricted), backend: "gvisor", classesDeclared: ["user_space_kernel"] });
    if (REPORT_DIR !== "") {
      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(path.join(REPORT_DIR, `canary-${runtimeName}.json`), `${JSON.stringify({ runtimeName, report, verdict }, null, 2)}\n`);
    }
    return { probes, verdict };
  } finally {
    await h.kill();
  }
}

describe.skipIf(!enabled)(`the runsc backend ${why}`, () => {
  it("the canary under the restricted profile passes the gateway's evaluator at user_space_kernel", async () => {
    const { probes, verdict } = await canary(RUNTIME);
    expect(verdict).toEqual({ verdict: "pass", failures: [] });
    // the class came from the executor's outside evidence: this container's runtime is the pinned runsc
    expect(probes.runtime_identity).toMatchObject({ observed: { runtime: "gvisor", guestKernelDistinct: false } });
    expect(probes.runtime_config).toMatchObject({ observed: { backend: "gvisor" } });
  }, 120_000);

  it.skipIf(RUNC === "")("negative control: a runtime that is not runsc is refused before any sandbox starts", async () => {
    await expect(canary(RUNC)).rejects.toThrow(/no runtime named|not the gVisor install|not the pinned one/);
  }, 120_000);

  it.skipIf(UNPINNED === "" || UNPINNED_PATH === "")("negative control: a runsc binary that is not the pinned release is refused before any sandbox starts", async () => {
    await expect(canary(UNPINNED, UNPINNED_PATH)).rejects.toThrow(/sha512 is not the pinned one/);
  }, 120_000);
});

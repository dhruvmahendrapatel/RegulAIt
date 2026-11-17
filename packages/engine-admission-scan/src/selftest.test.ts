/**
 * ADR-0242 §6.1 — the worker-attested offline switch: the worker reports it from inside its sandbox, and the runner
 * reports it true only on a fresh, passing report of this engine at its pinned version. With no report (before the
 * first enable no task has run) it is false, and the gateway rests it on the executor's attestation instead.
 */
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_MANIFEST, evaluateRunnerSelfTest } from "@regulait/shared";
import { offlineSwitch, pinnedVersion } from "./config.js";
import { NO_EGRESS, RUNTIME } from "./harness.js";
import { admissionRunnerSelfTest, judgeWorkerSelfTest, WORKER_SELF_TEST_FILE, writeWorkerSelfTest } from "./selftest.js";
import { driverEnv } from "./task.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "l4-st-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("the worker's self-test", () => {
  it.each(["mcpscanner", "skillscanner"] as const)("%s: the driver's environment sets the switch; nothing reached → the runner reports it", async (engine) => {
    const results = tmp();
    const env = driverEnv(engine, "/work/run/scratch");
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR", offlineSwitch(engine)].sort());
    const r = await writeWorkerSelfTest(results, { engine, engineVersion: pinnedVersion(engine), env, egress: NO_EGRESS, credentialPaths: [], runtime: RUNTIME() });
    expect(r.usageDataEnv).toEqual({ [offlineSwitch(engine)]: true });
    expect(await judgeWorkerSelfTest(engine, results)).toEqual({ passed: true, failures: [] });
    const st = await admissionRunnerSelfTest({ engine, imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: pinnedVersion(engine), resultsRoot: results, egress: NO_EGRESS });
    expect(st.usageDataEnv).toEqual({ [offlineSwitch(engine)]: true });
    // and the gateway's evaluation accepts it, once the image has a digest
    const m = { ...ENGINE_MANIFEST[engine], imageDigest: st.imageDigest };
    expect(evaluateRunnerSelfTest(m, st, new Date())).toEqual({ passed: true, failures: [] });
  });

  it("each failure is named, and keeps the switch false", async () => {
    const engine = "mcpscanner" as const;
    const sw = offlineSwitch(engine);
    const env = driverEnv(engine, "/s");
    const cases: Array<[string, Parameters<typeof writeWorkerSelfTest>[1], string]> = [
      ["a remote analyzer key", { engine, engineVersion: "4.8.7", env: { ...env, OPENAI_API_KEY: "x" }, egress: NO_EGRESS, credentialPaths: [] }, "worker_remote_analyzer_env"],
      ["the switch unset", { engine, engineVersion: "4.8.7", env: { ...env, [sw]: undefined }, egress: NO_EGRESS, credentialPaths: [] }, `worker_switch_missing:${sw}`],
      ["another version", { engine, engineVersion: "4.8.6", env, egress: NO_EGRESS, credentialPaths: [] }, "worker_version_mismatch"],
      ["a runner credential in reach", { engine, engineVersion: "4.8.7", env, egress: NO_EGRESS, credentialPaths: [import.meta.filename] }, "worker_sees_runner_credential"],
      ["a reachable address", { engine, engineVersion: "4.8.7", env, egress: { ...NO_EGRESS, connect: async () => "connected" as const }, credentialPaths: [] }, "worker_connected"],
    ];
    for (const [name, args, failure] of cases) {
      const results = tmp();
      await writeWorkerSelfTest(results, args);
      const j = await judgeWorkerSelfTest(engine, results);
      expect(j.passed, name).toBe(false);
      expect(j.failures, name).toContain(failure);
    }
    // another engine's report, a stale one, an invalid one
    const other = tmp();
    await writeWorkerSelfTest(other, { engine: "skillscanner", engineVersion: "2.3.2", env: driverEnv("skillscanner", "/s"), egress: NO_EGRESS, credentialPaths: [] });
    expect((await judgeWorkerSelfTest(engine, other)).failures).toContain("worker_engine_mismatch");
    const stale = tmp();
    await writeWorkerSelfTest(stale, { engine, engineVersion: "4.8.7", env, egress: NO_EGRESS, credentialPaths: [], now: new Date(Date.now() - 3 * 3600_000) });
    expect((await judgeWorkerSelfTest(engine, stale)).failures).toEqual(["worker_report_stale"]);
    const bad = tmp();
    await writeFile(path.join(bad, WORKER_SELF_TEST_FILE), JSON.stringify({ at: "now" }));
    expect((await judgeWorkerSelfTest(engine, bad)).failures).toEqual(["worker_report_invalid"]);
  });

  it("before the first task there is no report: the switch is false and rests on the executor's attestation", async () => {
    const engine = "skillscanner" as const;
    const st = await admissionRunnerSelfTest({ engine, imageDigest: `sha256:${"b".repeat(64)}`, engineVersion: "2.3.2", resultsRoot: tmp(), egress: NO_EGRESS, log: () => undefined });
    expect(st.usageDataEnv).toEqual({ [offlineSwitch(engine)]: false });
    const m = { ...ENGINE_MANIFEST[engine], imageDigest: st.imageDigest };
    expect(evaluateRunnerSelfTest(m, st, new Date()).failures).toEqual([`executor_attestation_missing:${offlineSwitch(engine)}`]);
    expect(evaluateRunnerSelfTest(m, st, new Date(), { executorAttested: true })).toEqual({ passed: true, failures: [] });
  });
});

/**
 * The shared worker self-test (ADR-0187 decisions 104 and 141, ADR-0242 §6.1): the worker's report around an engine's
 * own fields, written atomically; the runner's read fails closed (missing, invalid, stale) and names every isolation
 * failure (a runner credential in reach, any egress, no public address probed).
 */
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  observeWorkerSandbox,
  readWorkerSelfTest,
  runnerCredentialVisible,
  workerIsolationFailures,
  workerSandboxBlocks,
  workerSelfTestFresh,
  workerSelfTestSchema,
  WORKER_SELF_TEST_FILE,
  WORKER_SELF_TEST_MAX_AGE_MS,
  writeWorkerSelfTestFile,
} from "./worker-selftest.js";

const NO_EGRESS = {
  host: "egress-probe.invalid",
  ip: "93.184.215.14",
  lookup: () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })),
  connect: async () => "denied" as const,
};
const schema = workerSelfTestSchema({ engineVersion: z.string().max(64) });
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "worker-st-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function writeReport(dir: string, opts: { env?: Record<string, string | undefined>; credentialPaths?: string[]; egress?: typeof NO_EGRESS | Record<string, unknown>; at?: Date } = {}) {
  const seen = await observeWorkerSandbox({ env: opts.env ?? {}, credentialPaths: opts.credentialPaths ?? [], egress: (opts.egress ?? NO_EGRESS) as typeof NO_EGRESS });
  const report = { at: (opts.at ?? new Date()).toISOString(), engineVersion: "1.0.0", usageDataEnv: { REGULAIT_X_OFFLINE: true }, ...seen };
  await writeWorkerSelfTestFile(dir, report);
  return report;
}

describe("the worker's report", () => {
  it("a clean sandbox: written atomically, read back whole, fresh, no isolation failure", async () => {
    const dir = tmp();
    const written = await writeReport(dir);
    expect(readdirSync(dir)).toEqual([WORKER_SELF_TEST_FILE]); // no temp file left
    expect(statSync(path.join(dir, WORKER_SELF_TEST_FILE)).mode & 0o777).toBe(0o640 & ~process.umask());
    const read = await readWorkerSelfTest(dir, schema);
    expect(read).toEqual({ report: written });
    if (!("report" in read)) throw new Error("no report");
    expect(workerSelfTestFresh(read.report)).toBe(true);
    expect(workerIsolationFailures(read.report)).toEqual([]);
    expect(workerSandboxBlocks(read.report)).toBe(false);
  });

  it("missing or invalid (an unknown field, a bad time) → a named failure, never a report", async () => {
    expect(await readWorkerSelfTest(tmp(), schema)).toEqual({ failure: "worker_report_missing" });
    const notJson = tmp();
    await writeFile(path.join(notJson, WORKER_SELF_TEST_FILE), "{");
    expect(await readWorkerSelfTest(notJson, schema)).toEqual({ failure: "worker_report_missing" });
    const extra = tmp();
    const r = await writeReport(extra);
    await writeFile(path.join(extra, WORKER_SELF_TEST_FILE), JSON.stringify({ ...r, smuggled: true }));
    expect(await readWorkerSelfTest(extra, schema)).toEqual({ failure: "worker_report_invalid" });
    const bad = tmp();
    await writeFile(path.join(bad, WORKER_SELF_TEST_FILE), JSON.stringify({ at: "now" }));
    expect(await readWorkerSelfTest(bad, schema)).toEqual({ failure: "worker_report_invalid" });
  });

  it("stale past the maximum age, or too far ahead", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(workerSelfTestFresh({ at: new Date(now.getTime() - WORKER_SELF_TEST_MAX_AGE_MS).toISOString() }, now)).toBe(true);
    expect(workerSelfTestFresh({ at: new Date(now.getTime() - WORKER_SELF_TEST_MAX_AGE_MS - 1).toISOString() }, now)).toBe(false);
    expect(workerSelfTestFresh({ at: new Date(now.getTime() + 299_000).toISOString() }, now)).toBe(true);
    expect(workerSelfTestFresh({ at: new Date(now.getTime() + 301_000).toISOString() }, now)).toBe(false);
    expect(workerSelfTestFresh({ at: "not a time" }, now)).toBe(false);
  });

  it("egress reachable: each way is named, and blocks the worker", async () => {
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ["the name resolves", { ...NO_EGRESS, lookup: async () => ({ address: "93.184.215.14" }) }, ["worker_dns_resolved"]],
      ["a connect succeeds", { ...NO_EGRESS, connect: async () => "connected" as const }, ["worker_connected", "worker_address_connected"]],
      ["no public address probed", { ...NO_EGRESS, ip: "10.0.0.1" }, ["worker_address_missing"]],
    ];
    for (const [name, egress, failures] of cases) {
      const r = await writeReport(tmp(), { egress });
      expect(workerIsolationFailures(r), name).toEqual(expect.arrayContaining(failures));
      if (name !== "no public address probed") expect(workerSandboxBlocks(r), name).toBe(true);
    }
  });

  it("a runner credential visible (a key file, or the enrolment token in either environment) is named and blocks", async () => {
    expect(runnerCredentialVisible({}, [])).toBe(false);
    expect(runnerCredentialVisible({}, [import.meta.filename])).toBe(true);
    expect(runnerCredentialVisible({ REGULAIT_ENGINE_ENROLLMENT_TOKEN: "rge_x" }, [])).toBe(true);
    expect(runnerCredentialVisible({ REGULAIT_ENGINE_ENROLLMENT_TOKEN: "" }, [])).toBe(false);
    const before = process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN;
    process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN = "rge_x";
    try {
      expect(runnerCredentialVisible({}, [])).toBe(true);
    } finally {
      if (before === undefined) delete process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN;
      else process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN = before;
    }
    const r = await writeReport(tmp(), { credentialPaths: [import.meta.filename] });
    expect(workerIsolationFailures(r)).toEqual(["worker_sees_runner_credential"]);
    expect(workerSandboxBlocks(r)).toBe(true);
  });
});

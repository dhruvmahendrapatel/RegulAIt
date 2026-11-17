/**
 * ADR-0242 §6.1 — the runner side of a subject scan, without a sandbox:
 *  - the start-task body a staged job becomes: no files, no artifact, no secret, the root subject path (the shared
 *    schema and the gateway's #843 rules accept it, and nothing else the runner could stage);
 *  - the task's answer → the envelope: the report carried byte for byte as the raw report; no report, a report that
 *    is not the bytes the task hashed, or one over the gateway's raw-report cap → `failed`, no report; a time-out →
 *    `engine_timeout`; a lease without this engine's subject → `not_run`; a cancel posts nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskInputFromJobDir } from "@regulait/engine-runner";
import { ENGINE_RESULT_LIMITS, ENGINE_RESULT_VERSION, engineResultEnvelopeSchema } from "@regulait/shared";
import { AdmissionScanCancelled, admissionEnvelopeBody, admissionScanAdapter, leaseSubjectFile } from "./adapter.js";
import { ADMISSION_REPORT_MAX_BYTES, collectSubjectScan, DONE_FILE, NO_ANSWER, REPORT_FILE, SubjectExchange, type SubjectScanExecutor, type SubjectScanOutcome } from "./exchange.js";
import { gatewayStartRefusal, subjectLease } from "./harness.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const REPORT = Buffer.from(JSON.stringify({ schema: "regulait.admission-scan.v1", engine: "mcpscanner", status: "completed" }));
const envelopeOf = (runId: string, body: ReturnType<typeof admissionEnvelopeBody>) =>
  engineResultEnvelopeSchema.parse({ version: ENGINE_RESULT_VERSION, runId, engineId: "mcpscanner", engineVersion: "4.8.7", ...body });

describe("the start-task body a staged subject job becomes", () => {
  it.each(["mcpscanner", "skillscanner"] as const)("%s: no files, no artifact, no secret, the root subject; the gateway's rules accept it", async (engine) => {
    const jobs = tmp("l4-jobs-");
    const results = tmp("l4-results-");
    const lease = subjectLease(engine, Buffer.from("x"));
    const exchange = new SubjectExchange(jobs, results, { pollMs: 5 });
    const abort = new AbortController();
    const scanning = exchange.scan({ runId: lease.runId, subjectFile: leaseSubjectFile(engine, lease)!, timeoutMs: 60_000 }, abort.signal);
    while (!existsSync(path.join(jobs, lease.runId))) await new Promise((r) => setTimeout(r, 5));
    // the published job holds the marker only
    expect(await readdir(path.join(jobs, lease.runId))).toEqual(["subject.json"]);
    const body = await taskInputFromJobDir(jobs, lease.runId);
    expect(body).toEqual({ files: [], artifact: null, subject: { path: engine === "mcpscanner" ? "tools.json" : "SKILL.md" }, secret: null });
    expect(gatewayStartRefusal(engine, body)).toBeNull();
    // the harness's gateway rules do refuse what the gateway refuses (they can fire)
    expect(gatewayStartRefusal(engine, { ...body, files: [{ path: "tools.json", data: "" }] })).not.toBeNull();
    expect(gatewayStartRefusal(engine, { ...body, subject: { path: `x/${body.subject!.path}` } })).not.toBeNull();
    expect(gatewayStartRefusal(engine === "mcpscanner" ? "skillscanner" : "mcpscanner", body)).not.toBeNull();
    abort.abort();
    expect(await scanning).toMatchObject({ cancelled: true, report: null });
    expect(existsSync(path.join(jobs, lease.runId, "cancel"))).toBe(true);
    await exchange.release(lease.runId);
    expect(await readdir(jobs)).toEqual([]);
  }, 20_000);

  it("a lease's subject is used only when it is this engine's root file", () => {
    const l = subjectLease("mcpscanner", Buffer.from("{}"));
    expect(leaseSubjectFile("mcpscanner", l)).toBe("tools.json");
    expect(leaseSubjectFile("skillscanner", l)).toBeNull();
    expect(leaseSubjectFile("mcpscanner", { ...l, subject: null })).toBeNull();
    expect(leaseSubjectFile("mcpscanner", { ...l, subject: undefined })).toBeNull();
    expect(leaseSubjectFile("mcpscanner", { ...l, subject: { ...l.subject!, file: "SKILL.md" } })).toBeNull();
    expect(leaseSubjectFile("mcpscanner", { ...l, subject: { ...l.subject!, file: "../tools.json" } })).toBeNull();
  });
});

describe("the task's answer, read back from the results directory", () => {
  async function answer(done: Record<string, unknown> | string, report?: Buffer) {
    const results = tmp("l4-results-");
    const runId = randomUUID();
    await mkdir(path.join(results, runId));
    if (report) await writeFile(path.join(results, runId, REPORT_FILE), report);
    await writeFile(path.join(results, runId, DONE_FILE), typeof done === "string" ? done : JSON.stringify(done));
    return collectSubjectScan(results, runId);
  }
  const ok = { exitCode: 0, timedOut: false, reportSha256: sha(REPORT), reportTooLarge: false, error: null };

  it("a report that is the bytes the task hashed is carried as is", async () => {
    expect(await answer(ok, REPORT)).toMatchObject({ answered: true, exitCode: 0, report: REPORT, reportMismatch: false });
  });
  it("a missing report, other bytes, or a done file outside the contract is no report", async () => {
    expect(await answer(ok)).toMatchObject({ answered: true, report: null, reportMismatch: true });
    expect(await answer(ok, Buffer.from("{}"))).toMatchObject({ report: null, reportMismatch: true });
    expect(await answer({ ...ok, extra: 1 }, REPORT)).toEqual(NO_ANSWER);
    expect(await answer("not json", REPORT)).toEqual(NO_ANSWER);
    expect(await answer({ ...ok, error: "something_else" }, REPORT)).toEqual(NO_ANSWER);
  });
  it("a report over the gateway's raw-report cap is never read or posted", async () => {
    expect(ADMISSION_REPORT_MAX_BYTES).toBe(ENGINE_RESULT_LIMITS.maxRawReportBytes);
    const big = Buffer.alloc(ADMISSION_REPORT_MAX_BYTES + 1, 0x20);
    expect(await answer({ ...ok, reportSha256: sha(big) }, big)).toMatchObject({ report: null, reportTooLarge: true });
    // exactly at the cap is carried, and the gateway's schema takes it
    const atCap = Buffer.alloc(ADMISSION_REPORT_MAX_BYTES, 0x20);
    const got = await answer({ ...ok, reportSha256: sha(atCap) }, atCap);
    expect(got.report?.length).toBe(ADMISSION_REPORT_MAX_BYTES);
    expect(envelopeOf(randomUUID(), admissionEnvelopeBody(got)).rawReport?.bytes).toBe(ADMISSION_REPORT_MAX_BYTES);
    // the task's own refusal to send one
    expect(await answer({ ...ok, reportSha256: null, reportTooLarge: true })).toMatchObject({ report: null, reportTooLarge: true });
  });
});

describe("the answer → the envelope", () => {
  const base: SubjectScanOutcome = { ...NO_ANSWER, answered: true, exitCode: 0, report: REPORT };
  it("a completed scan posts the report byte for byte (base64, sha256, bytes); no items", () => {
    const b = admissionEnvelopeBody(base);
    expect(b).toEqual({ status: "completed", errorCode: null, items: [], notRun: [], rawReport: { sha256: sha(REPORT), bytes: REPORT.length, contentBase64: REPORT.toString("base64") } });
    expect(Buffer.from(envelopeOf(randomUUID(), b).rawReport!.contentBase64!, "base64").equals(REPORT)).toBe(true);
  });
  it.each([
    ["no answer", NO_ANSWER, "report_missing", false],
    ["a missing report", { ...base, report: null, reportMismatch: true }, "report_missing", false],
    ["an oversize report", { ...base, report: null, reportTooLarge: true }, "report_too_large", false],
    ["the driver killed at its limit", { ...base, report: null, timedOut: true }, "engine_timeout", false],
    ["no answer by the deadline", { ...NO_ANSWER, timedOut: true }, "engine_timeout", false],
    ["a sandbox that reached the network", { ...base, report: null, error: "sandbox_not_isolated" as const }, "sandbox_not_isolated", false],
    ["a driver that did not start", { ...base, report: null, exitCode: null, error: "driver_not_started" as const }, "driver_not_started", false],
    ["the driver's own failed report", { ...base, exitCode: 2 }, "scan_failed", true],
  ])("%s → failed (%s)", (_name, outcome, code, withReport) => {
    const b = admissionEnvelopeBody(outcome as SubjectScanOutcome);
    expect(b.status).toBe("failed");
    expect(b.errorCode).toBe(code);
    expect(b.rawReport !== null).toBe(withReport);
    expect(envelopeOf(randomUUID(), b).status).toBe("failed");
  });
  it("a cancel posts nothing", () => {
    expect(() => admissionEnvelopeBody({ ...base, cancelled: true })).toThrow(AdmissionScanCancelled);
  });
});

describe("the adapter", () => {
  const stub = (outcome: SubjectScanOutcome): SubjectScanExecutor & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      scan: async (job) => {
        calls.push(`scan ${job.subjectFile}`);
        return outcome;
      },
      release: async () => void calls.push("release"),
      reconcile: async () => {
        calls.push("reconcile");
        return [];
      },
    };
  };
  const ctx = () => ({ workDir: tmpdir(), signal: new AbortController().signal, progress: () => undefined });

  it("a lease with no subject, or another engine's, is not run (nothing is staged)", async () => {
    const ex = stub({ ...NO_ANSWER, answered: true, exitCode: 0, report: REPORT });
    const adapter = admissionScanAdapter({ engine: "mcpscanner", executor: ex });
    expect(await adapter({ ...subjectLease("mcpscanner", null) }, ctx())).toMatchObject({ status: "not_run", errorCode: "no_subject", rawReport: null });
    expect(await adapter(subjectLease("skillscanner", Buffer.from("x")), ctx())).toMatchObject({ status: "not_run", errorCode: "no_subject" });
    expect(ex.calls).toEqual([]);
  });

  it("scans the lease's subject file, then releases the run whatever happened", async () => {
    const ex = stub({ ...NO_ANSWER, answered: true, exitCode: 0, report: REPORT });
    const b = await admissionScanAdapter({ engine: "skillscanner", executor: ex })(subjectLease("skillscanner", Buffer.from("# s")), ctx());
    expect(b.status).toBe("completed");
    expect(ex.calls).toEqual(["reconcile", "scan SKILL.md", "release"]);
    const cancelled = stub({ ...NO_ANSWER, cancelled: true });
    await expect(admissionScanAdapter({ engine: "skillscanner", executor: cancelled })(subjectLease("skillscanner", Buffer.from("# s")), ctx())).rejects.toThrow(AdmissionScanCancelled);
    expect(cancelled.calls.at(-1)).toBe("release");
  });

  it("the exchange gives up past the run's time (failed, engine_timeout), and asks the task to stop", async () => {
    const jobs = tmp("l4-jobs-");
    const results = tmp("l4-results-");
    const lease = subjectLease("mcpscanner", Buffer.from("{}"), 50);
    const b = await admissionScanAdapter({ engine: "mcpscanner", executor: new SubjectExchange(jobs, results, { pollMs: 5, graceMs: 0 }), reportMarginMs: 0 })(lease, ctx());
    expect(b).toMatchObject({ status: "failed", errorCode: "engine_timeout", rawReport: null });
    // released: nothing of the run stays
    expect(await readdir(jobs)).toEqual([]);
  });
});

/**
 * The shared job-directory exchange (ADR-0187 B5-M, ADR-0190 I5, ADR-0242 §6.1): a job appears whole (staging, then
 * renamed live), a cancel is a file, a run that does not answer in time is given up, and release/reconcile leave
 * nothing of another run behind.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isJobRunId, JOB_CANCEL_FILE, JobExchange, jobDirRunId } from "./job-exchange.js";

const RUN = "0b9c6f1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f";
const OTHER = "1c0d7a2f-2e3b-4d4c-8f9a-8b7c6d5e4f3a";
const dirs: string[] = [];
function roots(): { jobs: string; results: string } {
  const d = mkdtempSync(path.join(tmpdir(), "job-exchange-"));
  dirs.push(d);
  const jobs = path.join(d, "jobs");
  const results = path.join(d, "results");
  mkdirSync(jobs);
  mkdirSync(results);
  return { jobs, results };
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** wait until `p` exists (the exchange publishes asynchronously) */
async function until(p: string): Promise<void> {
  for (let i = 0; i < 400 && !existsSync(p); i++) await new Promise((r) => setTimeout(r, 5));
  if (!existsSync(p)) throw new Error(`never appeared: ${p}`);
}

describe("jobDirRunId and isJobRunId", () => {
  it("a published or staging job directory names its run; anything else is not a job", () => {
    expect(jobDirRunId(RUN)).toBe(RUN);
    expect(jobDirRunId(`${RUN}.staging`)).toBe(RUN);
    for (const name of [`${RUN}.tmp`, `${RUN}.staging.x`, RUN.toUpperCase(), "lost+found", ".worker-selftest.json", `../${RUN}`, ""]) expect(jobDirRunId(name), name).toBeNull();
    expect(isJobRunId(RUN)).toBe(true);
    for (const v of [`${RUN}.staging`, RUN.toUpperCase(), "../x", 1, null]) expect(isJobRunId(v)).toBe(false);
  });
});

describe("the job exchange", () => {
  it("publishes the job whole, waits for the done file, and release removes the run", async () => {
    const { jobs, results } = roots();
    const ex = new JobExchange(jobs, results, { doneFile: "done.json", pollMs: 5 });
    const ending = ex.run({ runId: RUN, files: { "subject.json": '{"path":"SKILL.md"}' }, timeoutMs: 60_000 }, new AbortController().signal);
    const live = path.join(jobs, RUN);
    await until(path.join(live, "subject.json"));
    // the job appeared whole: no staging directory, no temp file, the exchange's modes
    expect(readdirSync(jobs)).toEqual([RUN]);
    expect(readdirSync(live)).toEqual(["subject.json"]);
    expect(readFileSync(path.join(live, "subject.json"), "utf8")).toBe('{"path":"SKILL.md"}');
    expect(statSync(live).mode & 0o777).toBe(0o750 & ~process.umask());
    expect(statSync(path.join(live, "subject.json")).mode & 0o777).toBe(0o640 & ~process.umask());
    mkdirSync(path.join(results, RUN));
    writeFileSync(path.join(results, RUN, "done.json"), "{}");
    expect(await ending).toBe("done");
    expect(ex.resultsDir(RUN)).toBe(path.join(results, RUN));
    await ex.release(RUN);
    expect(readdirSync(jobs)).toEqual([]);
    expect(readdirSync(results)).toEqual([]);
  });

  it("an earlier attempt of the same run is removed before the job is published", async () => {
    const { jobs, results } = roots();
    mkdirSync(path.join(jobs, `${RUN}.staging`));
    mkdirSync(path.join(results, RUN));
    writeFileSync(path.join(results, RUN, "done.json"), "{}"); // a stale answer is never read as this attempt's
    const ex = new JobExchange(jobs, results, { doneFile: "done.json", pollMs: 5, graceMs: 0 });
    expect(await ex.run({ runId: RUN, files: { "job.json": "{}" }, timeoutMs: 20 }, new AbortController().signal)).toBe("timed_out");
    expect(readdirSync(jobs)).toEqual([RUN]);
  });

  it("a cancel is the cancel file; past the cancel grace the run is cancelled", async () => {
    const { jobs, results } = roots();
    const ex = new JobExchange(jobs, results, { doneFile: "done.json", pollMs: 5, cancelGraceMs: 30 });
    const abort = new AbortController();
    const ending = ex.run({ runId: RUN, files: { "job.json": "{}" }, timeoutMs: 60_000 }, abort.signal);
    await until(path.join(jobs, RUN, "job.json"));
    abort.abort();
    await until(path.join(jobs, RUN, JOB_CANCEL_FILE));
    expect(await ending).toBe("cancelled");
  });

  it("a run cancelled before it starts publishes nothing", async () => {
    const { jobs, results } = roots();
    const abort = new AbortController();
    abort.abort();
    expect(await new JobExchange(jobs, results, { doneFile: "done.json" }).run({ runId: RUN, files: { "job.json": "{}" }, timeoutMs: 1000 }, abort.signal)).toBe("cancelled");
    expect(readdirSync(jobs)).toEqual([]);
  });

  it("past the run's time and the grace, the task is asked to stop and the run timed out", async () => {
    const { jobs, results } = roots();
    const ex = new JobExchange(jobs, results, { doneFile: "done.json", pollMs: 5, graceMs: 0 });
    expect(await ex.run({ runId: RUN, files: { "job.json": "{}" }, timeoutMs: 10 }, new AbortController().signal)).toBe("timed_out");
    expect(existsSync(path.join(jobs, RUN, JOB_CANCEL_FILE))).toBe(true);
  });

  it("refuses a run id that is not a UUID and a job file name that is not a plain name", async () => {
    const { jobs, results } = roots();
    const ex = new JobExchange(jobs, results, { doneFile: "done.json" });
    const signal = new AbortController().signal;
    await expect(ex.run({ runId: "../x", files: {}, timeoutMs: 10 }, signal)).rejects.toThrow("invalid run id");
    for (const name of ["../x", "a/b", ".hidden", JOB_CANCEL_FILE, ""]) await expect(ex.run({ runId: RUN, files: { [name]: "x" }, timeoutMs: 10 }, signal), name).rejects.toThrow("invalid job file name");
    expect(() => ex.resultsDir("../x")).toThrow("invalid run id");
    // release of an id that is not one touches nothing
    writeFileSync(path.join(jobs, "keep"), "");
    await ex.release("..");
    expect(readdirSync(jobs)).toEqual(["keep"]);
    expect(readdirSync(results)).toEqual([]);
  });

  it("reconcile removes every job and result but the kept run's, and leaves what is not a run", async () => {
    const { jobs, results } = roots();
    for (const name of [RUN, `${OTHER}.staging`, OTHER, "not-a-run"]) mkdirSync(path.join(jobs, name));
    for (const name of [RUN, OTHER]) mkdirSync(path.join(results, name));
    writeFileSync(path.join(results, ".worker-selftest.json"), "{}");
    const ex = new JobExchange(jobs, results, { doneFile: "done.json" });
    expect((await ex.reconcile(RUN)).sort()).toEqual([OTHER, `${OTHER}.staging`].sort());
    expect(readdirSync(jobs).sort()).toEqual([RUN, "not-a-run"].sort());
    expect(readdirSync(results).sort()).toEqual([".worker-selftest.json", RUN].sort());
    expect(await ex.reconcile(null)).toEqual([RUN]);
    expect(readdirSync(results)).toEqual([".worker-selftest.json"]);
    // missing roots are nothing to reconcile
    expect(await new JobExchange(path.join(jobs, "none"), path.join(results, "none"), { doneFile: "done.json" }).reconcile(null)).toEqual([]);
  });
});

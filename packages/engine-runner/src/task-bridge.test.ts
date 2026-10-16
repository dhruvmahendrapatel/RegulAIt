/**
 * ADR-0190 slice I5 — the task bridge (runner side) and the sandbox task (inside the sandbox), wired to each other
 * through an in-memory relay standing in for the gateway (the gateway's own suite drives the real routes). What it
 * pins:
 *  - the input: the job's files inline, the artifact only PLACED (never uploaded), and the run's key moved out of
 *    `job.json` into the task secret;
 *  - the sandbox side: the secret is read once (never from the environment), the engine's one job sees it, results
 *    come back as verified chunked files, `done.json` last, and the runner's results directory gets them whole;
 *  - the gateway channel: a request inside the sandbox reaches only the gateway's base path, with the headers the
 *    sandbox gave (never the runner's credentials); anything else is answered `not_gateway` (403 inside);
 *  - a file whose bytes do not match its last chunk's sha256 is refused, and the task is closed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import type { EngineTaskFramesResponse, EngineTaskInputUpload } from "@regulait/shared";
import { ExecutorTaskBridge, forwardGatewayRequest, taskInputFromJobDir } from "./task-bridge.js";
import { prepareJobCopy, runSandboxTask, viaGatewayChannel } from "./sandbox-task.js";

const RUN = "0f1e2d3c-4b5a-4968-8776-655443322110";
// a synthetic run key, derived at run time (never a secret-shaped literal)
const KEY = `k-${createHash("sha256").update(`bridge-${process.pid}`).digest("hex").slice(0, 24)}`;
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function publishJob(jobsRoot: string, job: Record<string, unknown>, artifact?: Buffer) {
  await mkdir(path.join(jobsRoot, RUN), { recursive: true });
  await writeFile(path.join(jobsRoot, RUN, "job.json"), JSON.stringify(job));
  if (artifact) await writeFile(path.join(jobsRoot, RUN, "artifact.pkl"), artifact);
}

describe("the task input a job directory becomes", () => {
  it("inline files, the artifact placed (never uploaded), the run's key moved to the task secret", async () => {
    const jobs = tmp("i5-jobs-");
    await publishJob(jobs, { runId: RUN, apiKey: KEY, target: { baseUrl: "http://gateway:3000/v1" } }, Buffer.alloc(4096, 1));
    const input = await taskInputFromJobDir(jobs, RUN, (n) => n.startsWith("artifact."));
    expect(input.secret).toBe(KEY);
    expect(input.artifact).toEqual({ path: `${RUN}/artifact.pkl` });
    expect(input.files.map((f) => f.path)).toEqual([`${RUN}/job.json`]);
    const job = JSON.parse(Buffer.from(input.files[0]!.data, "base64").toString("utf8")) as Record<string, unknown>;
    expect(job.apiKey).toBeUndefined();
    expect(JSON.stringify(input.files)).not.toContain(KEY);
  });

  it("refuses a run id that is not one, an empty job and anything that is not a plain file", async () => {
    const jobs = tmp("i5-jobs-");
    await expect(taskInputFromJobDir(jobs, "../etc")).rejects.toThrow(/not a run id/);
    await mkdir(path.join(jobs, RUN));
    await expect(taskInputFromJobDir(jobs, RUN)).rejects.toThrow(/1 to 16 files/);
    await mkdir(path.join(jobs, RUN, "sub"));
    await expect(taskInputFromJobDir(jobs, RUN)).rejects.toThrow(/not a plain file/);
  });
});

describe("the gateway channel's forwarder (the runner is the trusted side)", () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" } });
  }) as typeof fetch;

  it("forwards a request under the gateway's base path with only the sandbox's own headers", async () => {
    const a = await forwardGatewayRequest(
      { id: "1", method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: Buffer.from("{}").toString("base64") },
      { gatewayBaseUrl: "http://gateway:3000/v1", fetch: fakeFetch },
    );
    expect(a).toMatchObject({ t: "http_res", id: "1", status: 200, headers: { "content-type": "application/json" } });
    expect(seen.at(-1)).toEqual({ url: "http://gateway:3000/v1/chat/completions", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" } });
  });

  it.each(["/admin", "/v1/engine-runner/lease", "/v1/executor-channel/stream", "/v1/oauth/token", "/v1x/models"])("refuses %s (not_gateway), with nothing sent", async (p) => {
    const before = seen.length;
    expect(await forwardGatewayRequest({ id: "2", method: "GET", path: p, headers: {}, body: "" }, { gatewayBaseUrl: "http://gateway:3000/v1", fetch: fakeFetch })).toEqual({ t: "http_err", id: "2", code: "not_gateway" });
    expect(seen.length).toBe(before);
  });
});

/** the gateway, reduced to a relay: the sandbox's stdout lines are the runner's frames, the runner's frames its stdin */
function relay() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const frames: string[] = [];
  let eof = false;
  createInterface({ input: stdout }).on("line", (l) => frames.push(l));
  stdout.on("end", () => (eof = true));
  let started: EngineTaskInputUpload | null = null;
  let closed = false;
  const client = {
    taskInput: async (_runId: string, body: EngineTaskInputUpload) => {
      started = body;
      return { status: 201, error: null, reason: null };
    },
    taskFrames: async (_runId: string, from: number): Promise<EngineTaskFramesResponse> => {
      for (let i = 0; i < 100 && frames.length <= from && !eof; i++) await new Promise((r) => setTimeout(r, 10));
      const out = frames.slice(from, from + 64).map((data, i) => ({ seq: from + i, data }));
      const next = from + out.length;
      return { state: eof && next >= frames.length ? "ended" : "running", frames: out, nextSeq: next, eof: eof && next >= frames.length, refusal: null };
    },
    taskPost: async (_runId: string, lines: string[], close = false) => {
      for (const l of lines) stdin.write(`${l}\n`);
      if (close) closed = true;
    },
  };
  return { stdout, stdin, client, started: () => started, closed: () => closed };
}

describe("the bridge and the sandbox task, end to end over the relay", () => {
  it("delivers the job and the secret, carries the gateway channel, and writes the results whole, done last", async () => {
    const jobs = tmp("i5-jobs-");
    const results = tmp("i5-results-");
    const sandboxJobs = tmp("i5-sbx-jobs-");
    const work = tmp("i5-sbx-work-");
    await publishJob(jobs, { runId: RUN, apiKey: KEY, target: { baseUrl: "http://gateway:3000/v1" } });
    const r = relay();
    const gatewaySeen: string[] = [];
    const bridge = new ExecutorTaskBridge({
      client: r.client,
      jobsRoot: jobs,
      resultsRoot: results,
      gatewayBaseUrl: "http://gateway:3000/v1",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        gatewaySeen.push(`${init?.method} ${String(url)} ${(init?.headers as Record<string, string>).authorization}`);
        return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const bridged = bridge.bridge(RUN);
    // the executor's side: the input the runner uploaded, written read-only (here: a plain directory)
    while (!r.started()) await new Promise((res) => setTimeout(res, 5));
    const up = r.started()!;
    await mkdir(path.join(sandboxJobs, RUN));
    for (const f of up.files) await writeFile(path.join(sandboxJobs, f.path), Buffer.from(f.data, "base64"));
    const big = Buffer.alloc(900 * 1024, 3);
    const code = await runSandboxTask({
      gateway: true,
      jobsRoot: sandboxJobs,
      workRoot: work,
      stdout: r.stdout,
      stdin: r.stdin,
      readSecret: () => up.secret,
      run: async (ctx) => {
        expect(ctx.secret).toBe(KEY);
        const copy = await prepareJobCopy(ctx, (job) => ({ ...job, apiKey: ctx.secret, target: { baseUrl: viaGatewayChannel((job.target as { baseUrl: string }).baseUrl, ctx.gatewayOrigin!) } }));
        const job = JSON.parse(await readFile(path.join(copy, RUN, "job.json"), "utf8")) as { apiKey: string; target: { baseUrl: string } };
        expect(job.target.baseUrl).toBe(`${ctx.gatewayOrigin}/v1`);
        // the engine's model call: through the loopback proxy only
        const res = await fetch(`${job.target.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${job.apiKey}`, "content-type": "application/json", "x-runner": "nope" }, body: "{}" });
        expect(await res.json()).toEqual({ choices: [{ message: { content: "pong" } }] });
        const denied = await fetch(`${ctx.gatewayOrigin}/admin/users`, { method: "GET" });
        expect(denied.status).toBe(403);
        await writeFile(path.join(ctx.resultsRoot, RUN, "report.json"), big);
        await writeFile(path.join(ctx.resultsRoot, RUN, "done.json"), JSON.stringify({ reportSha256: createHash("sha256").update(big).digest("hex") }));
        await writeFile(path.join(ctx.resultsRoot, ".worker-selftest.json"), JSON.stringify({ ok: true }));
      },
    });
    r.stdout.end();
    expect(code).toBe(0);
    expect(await bridged).toBe("ended");
    expect(readFileSync(path.join(results, RUN, "report.json")).equals(big)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(results, RUN, "done.json"), "utf8"))).toMatchObject({ reportSha256: createHash("sha256").update(big).digest("hex") });
    expect(existsSync(path.join(results, ".worker-selftest.json"))).toBe(true);
    // the model call reached the gateway once, with the run's key; the forbidden path never left the runner
    expect(gatewaySeen).toEqual([`POST http://gateway:3000/v1/chat/completions Bearer ${KEY}`]);
  });

  it("a result file whose bytes do not match its last chunk is refused and the task closed", async () => {
    const jobs = tmp("i5-jobs-");
    const results = tmp("i5-results-");
    await publishJob(jobs, { runId: RUN });
    const r = relay();
    const bridge = new ExecutorTaskBridge({ client: r.client, jobsRoot: jobs, resultsRoot: results, gatewayBaseUrl: "http://gateway:3000/v1" });
    const bridged = bridge.bridge(RUN);
    while (!r.started()) await new Promise((res) => setTimeout(res, 5));
    r.stdout.write(`${JSON.stringify({ t: "file", path: `${RUN}/done.json`, chunk: 0, data: Buffer.from("{}").toString("base64"), last: true, size: 2, sha256: "0".repeat(64) })}\n`);
    r.stdout.end();
    await expect(bridged).rejects.toThrow(/not the file its last chunk names/);
    expect(r.closed()).toBe(true);
    expect(existsSync(path.join(results, RUN, "done.json"))).toBe(false);
  });

  it("a result outside the run (another run's directory) is refused", async () => {
    const jobs = tmp("i5-jobs-");
    const results = tmp("i5-results-");
    await publishJob(jobs, { runId: RUN });
    const r = relay();
    const bridge = new ExecutorTaskBridge({ client: r.client, jobsRoot: jobs, resultsRoot: results, gatewayBaseUrl: "http://gateway:3000/v1" });
    const bridged = bridge.bridge(RUN);
    while (!r.started()) await new Promise((res) => setTimeout(res, 5));
    r.stdout.write(`${JSON.stringify({ t: "file", path: "11111111-2222-4333-8444-555555555555/done.json", chunk: 0, data: "", last: true, size: 0, sha256: createHash("sha256").digest("hex") })}\n`);
    r.stdout.end();
    await expect(bridged).rejects.toThrow(/outside the run/);
    expect(r.closed()).toBe(true);
  });
});

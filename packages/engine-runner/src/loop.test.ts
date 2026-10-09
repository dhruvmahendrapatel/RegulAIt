/**
 * ADR-0187 decisions 48, 49, 53 and 54 (PR #205 review), without a gateway: a refused lease while
 * the engine is off is a wait with a capped backoff; the runner token survives a restart on its own
 * file (0600, never logged); a stale self-test is refreshed on the runner-token route; the runner
 * generates its own token, persists it BEFORE registering and sends only its hash, so a lost
 * response is recoverable. (Against the real gateway: apps/gateway/src/zz-b5-promptfoo.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRunnerTokenStore, pinnedImageDigest, RunnerFatalError, runRunnerLoop } from "./loop.js";
import { RunnerClient, type RunnerHttp } from "./runner.js";

const STORED = `rge_${"7".repeat(64)}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Script {
  /** register answers, in order (the last repeats); "drop" = the request landed but the response was lost */
  register?: Array<number | "drop">;
  lease: Array<{ status: number; error?: string; reason?: string }>;
  /** self-test answers in order (the last repeats); "drop" = a network error */
  selfTest?: Array<number | "drop">;
}

function gateway(script: Script) {
  const calls: Array<{ path: string; bearer: string; body: Record<string, unknown> | null }> = [];
  let li = 0;
  let ri = 0;
  let si = 0;
  const http: RunnerHttp = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path: p, bearer: init.headers.authorization ?? "", body });
    if (p.endsWith("/register")) {
      const list = script.register ?? [201];
      const step = list[Math.min(ri++, list.length - 1)]!;
      if (step === "drop") throw new Error("socket hang up");
      return { status: step, json: async () => (step === 201 ? { runnerId: "r1", selfTest: { passed: true, failures: [] } } : { error: "engine_enrollment_invalid" }) };
    }
    if (p.endsWith("/self-test")) {
      const list = script.selfTest ?? [200];
      const status = list[Math.min(si++, list.length - 1)]!;
      if (status === "drop") throw new Error("socket hang up");
      return { status, json: async () => (status === 200 ? { selfTest: { passed: true, failures: [] } } : { error: "engine_self_test_inconsistent" }) };
    }
    const step = script.lease[Math.min(li++, script.lease.length - 1)]!;
    return { status: step.status, json: async () => (step.error ? { error: step.error, ...(step.reason ? { reason: step.reason } : {}) } : null) };
  };
  return { calls, client: new RunnerClient({ gatewayUrl: "http://gateway.test", http }) };
}

const selfTest = () => ({
  imageDigest: `sha256:${"a".repeat(64)}`,
  engineVersion: "1",
  usageDataEnv: {},
  egress: { host: "x.invalid", dnsResolved: false, connected: false, address: null, addressConnected: false },
  at: new Date().toISOString(),
});
const registration = async () => ({ name: "r", imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: "1", selfTest: selfTest() });

async function opts(over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "runner-loop-"));
  const waits: number[] = [];
  const logs: string[] = [];
  return {
    waits,
    logs,
    o: {
      engineId: "promptfoo" as const,
      engineVersion: "1",
      workRoot: dir,
      store: new FileRunnerTokenStore(path.join(dir, "state", "runner-token")),
      enrollmentToken: "rgee_synthetic_enrolment" as string | null,
      registration,
      backoffMs: 10,
      maxBackoffMs: 40,
      maxIterations: 6,
      sleep: async (ms: number) => void waits.push(ms),
      log: (m: string) => void logs.push(m),
      ...over,
    },
  };
}
const adapter = async () => ({ status: "completed" as const, items: [], notRun: [], rawReport: null });

describe("decision 48: a refused lease while the engine is off is a wait, not an exit", () => {
  it("engine_disabled backs off (capped) and a 5xx is retried; work resumes", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_disabled" }, { status: 409, error: "engine_disabled" }, { status: 409, error: "engine_disabled" }, { status: 409, error: "engine_disabled" }, { status: 503 }, { status: 204 }] });
    const { o, waits, logs } = await opts();
    await runRunnerLoop(g.client, adapter, o);
    expect(waits).toEqual([10, 20, 40, 40, 40, 5000]);
    expect(logs.some((l) => /waiting: engine_disabled/.test(l))).toBe(true);
    expect(logs.some((l) => /lease accepted again/.test(l))).toBe(true);
  });
});

describe("decision 53: a stale self-test is refreshed on the runner-token route", () => {
  it("engine_self_test_required: the self-test is re-run and submitted, and the lease is retried at once", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_self_test_required" }, { status: 204 }] });
    const { o, waits, logs } = await opts({ maxIterations: 2 });
    await runRunnerLoop(g.client, adapter, o);
    const submitted = g.calls.filter((c) => c.path === "/v1/engine-runner/self-test");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.body).toMatchObject({ selfTest: { imageDigest: `sha256:${"a".repeat(64)}` } });
    expect(waits).toEqual([5000]); // no backoff: leased again at once, then idle
    expect(logs.some((l) => /submitted a fresh self-test: passed/.test(l))).toBe(true);
  });

  it("a refreshed report that does not help is submitted once per refusal streak, then the loop backs off", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_self_test_required" }], selfTest: [422] });
    const { o, waits } = await opts({ maxIterations: 4 });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.filter((c) => c.path === "/v1/engine-runner/self-test")).toHaveLength(1);
    expect(waits).toEqual([10, 20, 40, 40]);
  });
});

describe("PR #205 review round 3 [60]: a transient failure to submit the self-test does not latch", () => {
  it("a network error, then a 503, then a pass: the refresh is retried after the normal backoff and work resumes", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_self_test_required" }, { status: 409, error: "engine_self_test_required" }, { status: 409, error: "engine_self_test_required" }, { status: 204 }], selfTest: ["drop", 503, 200] });
    const { o, waits, logs } = await opts({ maxIterations: 4 });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.filter((c) => c.path === "/v1/engine-runner/self-test")).toHaveLength(3);
    // two transient failures back off normally; the third submission passes and the lease is retried at once
    expect(waits).toEqual([10, 20, 5000]);
    expect(logs.filter((l) => /will retry/.test(l))).toHaveLength(2);
  });

  it("a definitive refusal (4xx with a reason) still latches until a lease succeeds", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_self_test_required" }], selfTest: [422] });
    const { o } = await opts({ maxIterations: 4 });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.filter((c) => c.path === "/v1/engine-runner/self-test")).toHaveLength(1);
  });
});

describe("PR #205 review round 4 [64]: a runner disabled for its own failed report keeps re-proving itself, slowly", () => {
  const disabled = (reason: string) => ({ status: 409, error: "engine_disabled", reason });
  /** a virtual clock that advances by every sleep */
  async function clocked(over: Record<string, unknown>) {
    const base = await opts(over);
    let t = 0;
    return { ...base, o: { ...base.o, now: () => t, sleep: async (ms: number) => void (base.waits.push(ms), (t += ms)) } };
  }

  it("re-runs and submits the self-test on a slow cadence; a pass never makes it lease harder", async () => {
    const g = gateway({ lease: [disabled("runner_self_test_failed")], selfTest: [200] });
    const { o, waits, logs } = await clocked({ maxIterations: 6, backoffMs: 100, maxBackoffMs: 400, failedSelfTestRefreshMs: 1000 });
    await runRunnerLoop(g.client, adapter, o);
    // at t=0 and again once >= 1000 ms had passed (t=0,100,300,700,1100 → submit at 0 and 1100)
    expect(g.calls.filter((c) => c.path === "/v1/engine-runner/self-test")).toHaveLength(2);
    // still disabled: the normal capped backoff, never an immediate re-lease
    expect(waits).toEqual([100, 200, 400, 400, 400, 400]);
    expect(logs.some((l) => /submitted a fresh self-test: passed/.test(l))).toBe(true);
  });

  it("a transient submission failure does not use up the cadence: it is retried after the backoff", async () => {
    const g = gateway({ lease: [disabled("runner_self_test_failed")], selfTest: ["drop", 503, 200] });
    const { o } = await clocked({ maxIterations: 4, backoffMs: 10, maxBackoffMs: 40, failedSelfTestRefreshMs: 60_000 });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.filter((c) => c.path === "/v1/engine-runner/self-test")).toHaveLength(3);
  });

  it("an engine an admin simply switched off gets no refreshes at all", async () => {
    const g = gateway({ lease: [disabled("disabled")] });
    const { o } = await clocked({ maxIterations: 6, backoffMs: 10, maxBackoffMs: 40, failedSelfTestRefreshMs: 1 });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.filter((c) => c.path === "/v1/engine-runner/self-test")).toHaveLength(0);
  });
});

describe("decisions 49 and 54: the runner's own token, persisted before it registers", () => {
  it("is generated by the runner, stored 0600 BEFORE register, sent only as its hash, never logged, reused on restart", async () => {
    const { o, logs } = await opts({ maxIterations: 1 });
    let storedAtRegister: string | null = null;
    const first = gateway({ lease: [{ status: 204 }] });
    const http = (first.client as unknown as { http: RunnerHttp }).http;
    (first.client as unknown as { http: RunnerHttp }).http = async (url, init) => {
      if (url.endsWith("/register")) storedAtRegister = await o.store.load();
      return http(url, init);
    };
    await runRunnerLoop(first.client, adapter, o);
    const secret = await o.store.load();
    expect(secret).toMatch(/^rge_[0-9a-f]{64}$/);
    expect(storedAtRegister).toBe(secret); // persisted before the request left
    const reg = first.calls.find((c) => c.path.endsWith("/register"))!;
    expect(reg.body!["tokenHash"]).toBe(sha(secret!));
    expect(JSON.stringify(reg.body)).not.toContain(secret!);
    expect((await stat(o.store.file)).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toContain(secret!);
    // restart: the stored token is used; register is never called (the enrolment token is spent)
    const second = gateway({ register: [401], lease: [{ status: 204 }] });
    await runRunnerLoop(second.client, adapter, o);
    expect(second.calls.map((c) => c.path)).toEqual(["/v1/engine-runner/lease"]);
    expect(second.calls[0]!.bearer).toBe(`Bearer ${secret}`);
  });

  it("[54] a lost register response is retried with the SAME secret (the gateway replays the same runner)", async () => {
    const { o } = await opts({ maxIterations: 1 });
    const g = gateway({ register: ["drop", 201], lease: [{ status: 204 }] });
    await runRunnerLoop(g.client, adapter, o);
    const regs = g.calls.filter((c) => c.path.endsWith("/register"));
    expect(regs).toHaveLength(2);
    expect(regs[0]!.body!["tokenHash"]).toBe(regs[1]!.body!["tokenHash"]);
    expect(regs[0]!.body!["tokenHash"]).toBe(sha((await o.store.load())!));
  });

  it("a refused stored token: re-enrol once with a NEW secret, or stop with what to do", async () => {
    const { o } = await opts();
    await o.store.save(STORED);
    // revoked, and the enrolment token is spent → fatal, with the admin's next step
    await expect(runRunnerLoop(gateway({ register: [401], lease: [{ status: 401, error: "engine_runner_revoked" }] }).client, adapter, o)).rejects.toThrow(
      /enrolment token was refused.*mint a new enrolment token/,
    );
    // no enrolment token at all → fatal
    await o.store.save(STORED);
    await expect(runRunnerLoop(gateway({ lease: [{ status: 401 }] }).client, adapter, { ...o, enrollmentToken: null })).rejects.toBeInstanceOf(RunnerFatalError);
    // a fresh enrolment token → re-registers once with a new secret; a second 401 after that is fatal
    await o.store.save(STORED);
    const g = gateway({ lease: [{ status: 401 }, { status: 401 }] });
    await expect(runRunnerLoop(g.client, adapter, o)).rejects.toBeInstanceOf(RunnerFatalError);
    const regs = g.calls.filter((c) => c.path.endsWith("/register"));
    expect(regs).toHaveLength(1);
    expect(regs[0]!.body!["tokenHash"]).not.toBe(sha(STORED));
  });

  it("decision 55: the runner starts only from a digest-pinned image reference that agrees with the reported digest", () => {
    const D = `sha256:${"b".repeat(64)}`;
    expect(pinnedImageDigest(`regulait/engine-promptfoo@${D}`, D)).toBe(D);
    expect(pinnedImageDigest(`registry.example:5000/regulait/engine-promptfoo@${D}`, D)).toBe(D);
    expect(() => pinnedImageDigest("regulait/engine-promptfoo:0.123.1", D)).toThrow(/by digest/);
    expect(() => pinnedImageDigest(`regulait/engine-promptfoo@${D}`, `sha256:${"c".repeat(64)}`)).toThrow(/must be the digest/);
    expect(() => pinnedImageDigest(undefined, D)).toThrow(RunnerFatalError);
    expect(() => pinnedImageDigest(`regulait/engine-promptfoo@sha256:${"0".repeat(64)}`, `sha256:${"0".repeat(64)}`)).toThrow(/placeholder/);
  });

  it("a state file that does not hold a runner token is not used", async () => {
    const { o } = await opts();
    await o.store.save(STORED);
    await writeFile(o.store.file, "not a token\n");
    expect(await o.store.load()).toBeNull();
  });
});

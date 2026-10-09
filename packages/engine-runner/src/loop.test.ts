/**
 * ADR-0187 decisions 48 and 49 (PR #205 review), without a gateway: the runner token survives a
 * restart on its own file (0600, never logged), a lease refused because the engine is off is a
 * wait with a capped backoff, and only a refused credential with nothing to re-enrol with stops.
 * (The same behaviour against the real gateway: apps/gateway/src/zz-b5-promptfoo.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRunnerTokenStore, RunnerFatalError, runRunnerLoop } from "./loop.js";
import { RunnerClient, type RunnerHttp } from "./runner.js";

const TOKEN = "rge_synthetic_runner_token_000000000000";

function gateway(script: { register?: number; lease: Array<{ status: number; error?: string }> }) {
  const calls: Array<{ path: string; bearer: string }> = [];
  let i = 0;
  const http: RunnerHttp = async (url, init) => {
    const p = new URL(url).pathname;
    calls.push({ path: p, bearer: init.headers.authorization ?? "" });
    if (p.endsWith("/register")) {
      const status = script.register ?? 201;
      return { status, json: async () => (status === 201 ? { runnerId: "r1", token: TOKEN, selfTest: { passed: true, failures: [] } } : { error: "engine_enrollment_invalid" }) };
    }
    const step = script.lease[Math.min(i++, script.lease.length - 1)]!;
    return { status: step.status, json: async () => (step.error ? { error: step.error } : null) };
  };
  return { calls, client: new RunnerClient({ gatewayUrl: "http://gateway.test", http }) };
}

const registration = async () => ({
  name: "r",
  imageDigest: `sha256:${"a".repeat(64)}`,
  engineVersion: "1",
  selfTest: {
    imageDigest: `sha256:${"a".repeat(64)}`,
    engineVersion: "1",
    usageDataEnv: {},
    egress: { host: "x.invalid", dnsResolved: false, connected: false, address: null, addressConnected: false },
    at: new Date().toISOString(),
  },
});

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
  it("engine_disabled and engine_self_test_required back off (capped); then work resumes", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_disabled" }, { status: 409, error: "engine_disabled" }, { status: 409, error: "engine_self_test_required" }, { status: 409, error: "engine_disabled" }, { status: 503 }, { status: 204 }] });
    const { o, waits, logs } = await opts();
    await runRunnerLoop(g.client, adapter, o);
    expect(waits).toEqual([10, 20, 40, 40, 40, 1 * 5000]);
    expect(logs.some((l) => /waiting: engine_disabled/.test(l))).toBe(true);
    expect(logs.some((l) => /lease accepted again/.test(l))).toBe(true);
  });
});

describe("decision 49: the runner token survives a restart", () => {
  it("is stored 0600 on the runner's volume, never logged, and used instead of the enrolment token on restart", async () => {
    const { o, logs } = await opts({ maxIterations: 1 });
    const first = gateway({ lease: [{ status: 204 }] });
    await runRunnerLoop(first.client, adapter, o);
    expect(await o.store.load()).toBe(TOKEN);
    expect((await stat(o.store.file)).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toContain(TOKEN);
    // restart: the stored token is used; register is never called (the enrolment token is spent)
    const second = gateway({ register: 401, lease: [{ status: 204 }] });
    await runRunnerLoop(second.client, adapter, o);
    expect(second.calls.map((c) => c.path)).toEqual(["/v1/engine-runner/lease"]);
    expect(second.calls[0]!.bearer).toBe(`Bearer ${TOKEN}`);
  });

  it("a refused stored token: re-enrol once with the enrolment token, or stop with what to do", async () => {
    const { o } = await opts();
    await o.store.save(TOKEN);
    // revoked, and the enrolment token is spent → fatal, with the admin's next step
    await expect(runRunnerLoop(gateway({ register: 401, lease: [{ status: 401, error: "engine_runner_revoked" }] }).client, adapter, o)).rejects.toThrow(
      /enrolment token was refused.*mint a new enrolment token/,
    );
    // no enrolment token at all → fatal
    await expect(runRunnerLoop(gateway({ lease: [{ status: 401 }] }).client, adapter, { ...o, enrollmentToken: null })).rejects.toBeInstanceOf(RunnerFatalError);
    // a fresh enrolment token → re-registers once; a second 401 after that is fatal (no loop of enrolments)
    const g = gateway({ lease: [{ status: 401 }, { status: 401 }] });
    await expect(runRunnerLoop(g.client, adapter, o)).rejects.toBeInstanceOf(RunnerFatalError);
    expect(g.calls.filter((c) => c.path.endsWith("/register"))).toHaveLength(1);
  });

  it("a state file that does not hold a runner token is not used", async () => {
    const { o } = await opts();
    await o.store.save(TOKEN);
    await writeFile(o.store.file, "not a token\n");
    expect(await o.store.load()).toBeNull();
  });
});

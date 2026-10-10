/**
 * ADR-0187 B5-E — the runner core, without a gateway or a network:
 *   - the egress probe reports reached when a name resolves or a socket
 *     connects (a real local listener), and denied only on the errors an
 *     internal network produces; an unexplained resolver error is NOT denied;
 *   - the self-test reports each usage-data switch as set only at its value;
 *   - the engine's process group dies on abort, grandchildren included;
 *   - runOnce: a cancel heartbeat aborts the engine and posts nothing, an
 *     engine that throws is posted as failed (engine_error) with no items, and
 *     the work directory is wiped either way.
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENGINE_RESULT_VERSION, type EngineLease, type EngineResultEnvelope } from "@regulait/shared";
import { probeEgress, tcpConnect } from "./egress.js";
import { runProcessGroup } from "./process.js";
import { buildSelfTest, postResultWithRetry, RETAINED_RESULT_FILE, runOnce, RunnerClient, RunnerHttpError, RunnerMalformedResponseError, RunnerTimeoutError, type RunnerHttp } from "./runner.js";

const refuse = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));

describe("the egress probe", () => {
  it("a name that resolves is reached; ENOTFOUND is denied; an unexplained error is not denied", async () => {
    const denied = async () => "denied" as const;
    expect(await probeEgress({ lookup: async () => ({ address: "203.0.113.9" }), connect: denied })).toMatchObject({ dnsResolved: true, connected: false });
    expect(await probeEgress({ lookup: refuse("ENOTFOUND"), connect: denied })).toMatchObject({ dnsResolved: false, connected: false });
    expect(await probeEgress({ lookup: refuse("EAI_AGAIN"), connect: denied })).toMatchObject({ dnsResolved: false });
    expect(await probeEgress({ lookup: refuse("EWEIRD"), connect: denied })).toMatchObject({ dnsResolved: true });
  });

  it("a socket that connects is reached; the literal address is tried too", async () => {
    const server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await tcpConnect("127.0.0.1", port, 2000)).toBe("connected");
      const r = await probeEgress({ host: "egress-probe.invalid", ip: "127.0.0.1", port, lookup: refuse("ENOTFOUND"), timeoutMs: 2000 });
      expect(r).toEqual({ host: "egress-probe.invalid", dnsResolved: false, connected: false, address: "127.0.0.1", addressConnected: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("no route and no resolver are denied", async () => {
    const r = await probeEgress({
      host: "egress-probe.invalid",
      lookup: refuse("ENOTFOUND"),
      connect: async () => "denied",
    });
    expect(r).toEqual({ host: "egress-probe.invalid", dnsResolved: false, connected: false, address: null, addressConnected: false });
  });
});

describe("the self-test report", () => {
  it("a switch counts as set only at its required value", async () => {
    const st = await buildSelfTest({
      imageDigest: `sha256:${"a".repeat(64)}`,
      engineVersion: "1.0.0",
      requiredEnv: { A_DISABLE_TELEMETRY: "1", A_DISABLE_UPDATE: "1" },
      env: { A_DISABLE_TELEMETRY: "1", A_DISABLE_UPDATE: "true" },
      egress: { lookup: refuse("ENOTFOUND"), connect: async () => "denied" },
    });
    expect(st.usageDataEnv).toEqual({ A_DISABLE_TELEMETRY: true, A_DISABLE_UPDATE: false });
    expect(st.egress).toMatchObject({ dnsResolved: false, connected: false });
  });
});

describe("the process group", () => {
  it("abort kills the engine and everything it started", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5-pg-"));
    const pidFile = path.join(dir, "grandchild.pid");
    const ac = new AbortController();
    const run = runProcessGroup("/bin/sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, signal: ac.signal, timeoutMs: 30_000 });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    ac.abort();
    const out = await run;
    expect(out.killed).toBe(true);
    // gone, or a zombie waiting for a reaper (a container's PID 1 may not reap): never running
    let state = "gone";
    for (let i = 0; i < 50; i++) {
      try {
        state = readFileSync(`/proc/${grandchild}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!;
      } catch {
        state = "gone";
      }
      if (state === "gone" || state === "Z") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(["gone", "Z"]).toContain(state);
  });

  it("a run past its timeout is killed", async () => {
    const out = await runProcessGroup("/bin/sh", ["-c", "sleep 30"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 200 });
    expect(out.killed).toBe(true);
  });
});

describe("runOnce", () => {
  const lease: EngineLease = {
    runId: "11111111-1111-4111-8111-111111111111",
    engineId: "promptfoo",
    engineVersion: "0.123.1",
    spec: { config: { sets: ["basic"], params: {} }, trials: 3 },
    target: null,
    judge: null,
    artifacts: [],
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    budgetUsd: null,
  };
  function fakeGateway(cancelOnHeartbeat: boolean) {
    const calls: Array<{ path: string; body: unknown }> = [];
    const http: RunnerHttp = async (url, init) => {
      const p = new URL(url).pathname;
      calls.push({ path: p, body: init.body ? JSON.parse(init.body) : undefined });
      if (p.endsWith("/lease")) return { status: 200, json: async () => lease };
      // the cancel arrives on a running heartbeat, after the engine started
      if (p.endsWith("/heartbeat")) {
        const phase = (JSON.parse(init.body ?? "{}") as { phase?: string }).phase;
        return { status: 200, json: async () => ({ cancel: cancelOnHeartbeat && phase === "running" }) };
      }
      return { status: 200, json: async () => ({}) };
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http });
    client.useToken("rge_test");
    return { client, calls };
  }

  it("an engine that throws is posted as failed with no items, and the work dir is wiped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-work-"));
    const { client, calls } = fakeGateway(false);
    let seenDir = "";
    const out = await runOnce(
      client,
      async (_l, ctx) => {
        seenDir = ctx.workDir;
        throw new Error("engine crashed");
      },
      { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root },
    );
    expect(out.outcome).toBe("failed");
    const posted = calls.find((c) => c.path.endsWith("/result"))!.body as Record<string, unknown>;
    expect(posted).toMatchObject({ version: ENGINE_RESULT_VERSION, status: "failed", errorCode: "engine_error", items: [] });
    expect(existsSync(seenDir)).toBe(false);
  });

  it("a cancel heartbeat aborts the engine and posts nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-work-"));
    const { client, calls } = fakeGateway(true);
    let aborted = false;
    const out = await runOnce(
      client,
      async (_l, ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, heartbeatMs: 20 },
    );
    expect(out.outcome).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/result"))).toBe(false);
  });
});

describe("PR #203 review [4]: the literal-address probe", () => {
  it("is always made and reported, so a blocked resolver cannot mask routable egress", async () => {
    const seen: string[] = [];
    const r = await probeEgress({
      host: "egress-probe.invalid",
      ip: "93.184.215.14",
      lookup: refuse("ENOTFOUND"),
      connect: async (h) => {
        seen.push(h);
        return h === "93.184.215.14" ? "connected" : "denied";
      },
    });
    expect(seen).toContain("93.184.215.14");
    expect(r).toMatchObject({ dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: true });
  });
  it("with no address configured it says so (the gateway then fails the self-test)", async () => {
    const r = await probeEgress({ host: "egress-probe.invalid", lookup: refuse("ENOTFOUND"), connect: async () => "denied" });
    expect(r).toMatchObject({ address: null, addressConnected: false });
  });
});

describe("PR #203 review round 2", () => {
  const lease2: EngineLease = {
    runId: "22222222-2222-4222-8222-222222222222",
    engineId: "promptfoo",
    engineVersion: "0.123.1",
    spec: { config: { sets: ["basic"], params: {} }, trials: 3 },
    target: null,
    judge: null,
    artifacts: [],
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    budgetUsd: null,
  };
  function gateway(resultReplies: Array<number | "throw">) {
    const calls: string[] = [];
    let workDirSeenDuringRetry: boolean | null = null;
    let dir = "";
    const http: RunnerHttp = async (url) => {
      const p = new URL(url).pathname;
      if (p.endsWith("/lease")) return { status: 200, json: async () => lease2 };
      if (p.endsWith("/heartbeat")) return { status: 200, json: async () => ({ cancel: false }) };
      calls.push(p);
      if (calls.length > 1 && dir) workDirSeenDuringRetry = existsSync(dir);
      const r = resultReplies.shift() ?? 200;
      if (r === "throw") throw new Error("ECONNRESET");
      return { status: r, json: async () => ({}) };
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http });
    client.useToken("rge_test");
    return { client, calls, setDir: (d: string) => (dir = d), seen: () => workDirSeenDuringRetry };
  }
  const adapter = (g: { setDir: (d: string) => void }) => async (_l: EngineLease, ctx: { workDir: string }) => {
    g.setDir(ctx.workDir);
    return { status: "completed" as const, items: [], notRun: [], rawReport: null };
  };

  it("[18] a transient failure or 5xx on the result is retried, keeping the work dir, until a 2xx", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-retry-"));
    const g = gateway(["throw", 503, 200]);
    const out = await runOnce(g.client, adapter(g), { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, retryBaseMs: 1 });
    expect(out).toMatchObject({ outcome: "posted", status: 200 });
    expect(g.calls).toHaveLength(3);
    expect(g.seen()).toBe(true);
  });

  it("[18] a definitive 4xx stops the retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-retry-"));
    const g = gateway([409, 200]);
    const out = await runOnce(g.client, adapter(g), { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, retryBaseMs: 1 });
    expect(out).toMatchObject({ status: 409 });
    expect(g.calls).toHaveLength(1);
  });

  /** a gateway whose starting heartbeat answers in order (then 200), with everything else accepted */
  function startGateway(starts: Array<number | "throw">) {
    const seen: string[] = [];
    let adapterRan = false;
    const http: RunnerHttp = async (url, init) => {
      const p = new URL(url).pathname;
      if (p.endsWith("/lease")) return { status: 200, json: async () => lease2 };
      if (p.endsWith("/heartbeat")) {
        const phase = (JSON.parse(init.body!) as { phase: string }).phase;
        if (phase === "starting") {
          const s = starts.shift() ?? 200;
          seen.push(String(s));
          if (s === "throw") throw new Error("ECONNRESET");
          return { status: s, json: async () => ({ cancel: false }) };
        }
        return { status: 200, json: async () => ({ cancel: false }) };
      }
      return { status: 200, json: async () => ({}) };
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http });
    client.useToken("rge_test");
    const adapter = async () => {
      adapterRan = true;
      return { status: "completed" as const, items: [], notRun: [], rawReport: null };
    };
    return { client, seen, adapter, ran: () => adapterRan };
  }

  it("PR #205 round 10 [83]: a transient failure of the starting heartbeat is retried; the leased run is run, not abandoned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-start-"));
    const g = startGateway(["throw", 503, 200]);
    const out = await runOnce(g.client, g.adapter, { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, retryBaseMs: 1 });
    expect(g.seen).toEqual(["throw", "503", "200"]);
    expect(g.ran()).toBe(true);
    expect(out).toMatchObject({ outcome: "posted", status: 200 });
  });

  it("PR #205 round 10 [83]: a definitive refusal of the starting heartbeat abandons the run quietly (cancelled, no throw, nothing run)", async () => {
    for (const refusal of [401, 404, 409]) {
      const root = await mkdtemp(path.join(tmpdir(), "b5-start-"));
      const g = startGateway([refusal]);
      const out = await runOnce(g.client, g.adapter, { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, retryBaseMs: 1 });
      expect(out).toMatchObject({ outcome: "cancelled" });
      expect(g.seen).toEqual([String(refusal)]);
      expect(g.ran()).toBe(false);
    }
  });

  it("PR #205 round 10 [83]: transient failures past the attempt budget abandon the run as cancelled, never a throw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-start-"));
    const g = startGateway(["throw", "throw", "throw"]);
    const out = await runOnce(g.client, g.adapter, { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, retryBaseMs: 1, maxStartAttempts: 3 });
    expect(out).toMatchObject({ outcome: "cancelled" });
    expect(g.seen).toHaveLength(3);
    expect(g.ran()).toBe(false);
  });

  it("PR #205 round 11 [89]: a request that never answers is aborted at its timeout and fails as transient", async () => {
    let signal: AbortSignal | undefined;
    const hang: RunnerHttp = (_url, init) => {
      signal = init.signal;
      return new Promise(() => {}); // never settles, never honours the signal
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: hang, requestTimeoutMs: 20 });
    client.useToken("rge_test");
    const t0 = Date.now();
    await expect(client.lease({ imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: "1" })).rejects.toBeInstanceOf(RunnerTimeoutError);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
  });

  it("PR #205 round 11 [89]: the bound is the run's deadline when that is sooner", async () => {
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: () => new Promise(() => {}), requestTimeoutMs: 60_000 });
    client.useToken("rge_test");
    const t0 = Date.now();
    await expect(client.heartbeat("r", "running", 0, new Date(Date.now() + 30).toISOString())).rejects.toBeInstanceOf(RunnerTimeoutError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("PR #205 round 11 [89]: a timed-out result post is retried like any transient failure", async () => {
    let calls = 0;
    const http: RunnerHttp = async () => {
      calls++;
      if (calls === 1) return new Promise(() => {});
      return { status: 200, json: async () => ({}) };
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http, requestTimeoutMs: 20 });
    client.useToken("rge_test");
    const env: EngineResultEnvelope = { version: ENGINE_RESULT_VERSION, runId: lease2.runId, engineId: "promptfoo" as const, engineVersion: "0.123.1", status: "completed" as const, errorCode: null, items: [], notRun: [], rawReport: null };
    expect(await postResultWithRetry(client, lease2.runId, env, { deadlineAt: new Date(Date.now() + 60_000).toISOString(), retryBaseMs: 1 })).toBe(200);
    expect(calls).toBe(2);
  });

  it("PR #205 round 11 [90]: an undelivered result is kept under the persistent retain root, never in the engine's work dir", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "b5-work-"));
    const retain = await mkdtemp(path.join(tmpdir(), "b5-retain-"));
    const g = gateway(["throw", "throw"]);
    const out = await runOnce(g.client, adapter(g), {
      engineId: "promptfoo",
      engineVersion: "0.123.1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      workRoot: work,
      retainRoot: retain,
      retryBaseMs: 1,
      maxResultAttempts: 2,
    });
    expect(out).toMatchObject({ outcome: "undelivered" });
    expect(await readdir(work)).toEqual([]);
    expect(await readdir(path.join(retain, lease2.runId))).toEqual([RETAINED_RESULT_FILE]);
  });

  it("PR #205 round 5 [68]: an undelivered run keeps ONLY its envelope, for the loop to retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5-retain-"));
    const g = gateway(["throw", "throw", "throw"]);
    const out = await runOnce(g.client, async (_l, ctx) => {
      g.setDir(ctx.workDir);
      await writeFile(path.join(ctx.workDir, "promptfoo-output.json"), "x".repeat(1024));
      return { status: "completed" as const, items: [], notRun: [], rawReport: null };
    }, { engineId: "promptfoo", engineVersion: "0.123.1", imageDigest: `sha256:${"a".repeat(64)}`, workRoot: root, retryBaseMs: 1, maxResultAttempts: 2 });
    expect(out).toMatchObject({ outcome: "undelivered" });
    const dir = path.join(root, lease2.runId);
    expect(await readdir(dir)).toEqual([RETAINED_RESULT_FILE]);
    const kept = JSON.parse(await readFile(path.join(dir, RETAINED_RESULT_FILE), "utf8")) as { runId: string; deadlineAt: string; envelope: { runId: string } };
    expect(kept).toMatchObject({ runId: lease2.runId, deadlineAt: lease2.deadlineAt, envelope: { runId: lease2.runId } });
  });

  it("[22] the abort listener is removed when the process ends", async () => {
    const { getEventListeners } = await import("node:events");
    const ac = new AbortController();
    await runProcessGroup("/bin/sh", ["-c", "true"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, signal: ac.signal, timeoutMs: 5000 });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
});

describe("PR #205 follow-up [101]: the sweep of every runner route for a swallowed parse error", () => {
  const truncated = async () => JSON.parse('{"cancel":fa');
  const clientAnswering = (status: number, json: () => Promise<unknown>) => {
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: async () => ({ status, json }) });
    client.useToken("rge_test");
    return client;
  };
  const build = { imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: "1" };
  const st = {
    imageDigest: build.imageDigest,
    engineVersion: "1",
    usageDataEnv: {},
    egress: { host: "x.invalid", dnsResolved: false, connected: false, address: null, addressConnected: false },
    at: new Date().toISOString(),
  };

  it("lease: a truncated 200, a 200 that is not a lease, and a 2xx other than 200/204 are transient errors, never 'no work'", async () => {
    for (const [status, json] of [
      [200, truncated],
      [200, async () => ({ runId: "22222222-2222-4222-8222-222222222222" })],
      [200, async () => null],
      [202, async () => ({})],
    ] as const) {
      await expect(clientAnswering(status, json).lease(build, "33333333-3333-4333-8333-333333333333")).rejects.toBeInstanceOf(RunnerMalformedResponseError);
    }
    // the controls: a 204 is no work, and a well-formed 200 is a lease
    expect(await clientAnswering(204, async () => null).lease(build)).toBeNull();
    const lease = {
      runId: "22222222-2222-4222-8222-222222222222",
      engineId: "promptfoo",
      engineVersion: "1",
      spec: { config: { sets: ["basic"], params: {} }, trials: 1 },
      target: { baseUrl: "http://gateway.test/v1", model: "m", apiKey: "rglv_x", headers: { "x-a": "b" } },
      judge: null,
      artifacts: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      budgetUsd: 1,
    };
    expect(await clientAnswering(200, async () => lease).lease(build)).toEqual(lease);
    // a refusal whose body is truncated stays a refusal with no signal (transient in the loop, as before)
    const refused = clientAnswering(503, truncated).lease(build);
    await expect(refused).rejects.toBeInstanceOf(RunnerHttpError);
    await expect(refused).rejects.toMatchObject({ status: 503, code: null, next: null });
  });

  it("heartbeat: a truncated or shapeless 200 is transient (thrown), neither 'carry on' nor 'stop'; a definitive refusal still stops", async () => {
    await expect(clientAnswering(200, truncated).heartbeat("r", "running", 0)).rejects.toBeInstanceOf(RunnerMalformedResponseError);
    await expect(clientAnswering(200, async () => ({})).heartbeat("r", "running", 0)).rejects.toBeInstanceOf(RunnerMalformedResponseError);
    await expect(clientAnswering(200, async () => ({ cancel: false })).heartbeat("r", "running", 0)).resolves.toEqual({ cancel: false });
    await expect(clientAnswering(409, truncated).heartbeat("r", "running", 0)).resolves.toEqual({ cancel: true });
  });

  it("self-test: a truncated or shapeless 200 is transient, not a refusal", async () => {
    await expect(clientAnswering(200, truncated).submitSelfTest(st)).rejects.toBeInstanceOf(RunnerMalformedResponseError);
    await expect(clientAnswering(200, async () => ({ selfTest: "passed" })).submitSelfTest(st)).rejects.toBeInstanceOf(RunnerMalformedResponseError);
    await expect(clientAnswering(200, async () => ({ selfTest: { passed: true, failures: [] }, next: "ok" })).submitSelfTest(st)).resolves.toEqual({ passed: true, failures: [], next: "ok" });
  });

  it("register: a truncated 201 is transient (the loop confirms the secret), and sets no token", async () => {
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http: async () => ({ status: 201, json: truncated }) });
    await expect(client.register("rgee_x", "rge_secret", { name: "r", imageDigest: build.imageDigest, engineVersion: "1", selfTest: st })).rejects.toBeInstanceOf(RunnerMalformedResponseError);
    await expect(client.heartbeat("r", "running", 0)).rejects.toThrow(/not registered/);
  });

  it("result: the status is the whole answer; a 2xx with a truncated body is still definitive (a retry would get 409 engine_run_finished)", async () => {
    expect(await clientAnswering(200, truncated).result("r", {} as EngineResultEnvelope)).toBe(200);
  });
});

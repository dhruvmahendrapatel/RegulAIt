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
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENGINE_RESULT_VERSION, type EngineLease } from "@regulait/shared";
import { probeEgress, tcpConnect } from "./egress.js";
import { runProcessGroup } from "./process.js";
import { buildSelfTest, runOnce, RunnerClient, type RunnerHttp } from "./runner.js";

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
      { engineId: "promptfoo", engineVersion: "0.123.1", workRoot: root },
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
      { engineId: "promptfoo", engineVersion: "0.123.1", workRoot: root, heartbeatMs: 20 },
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

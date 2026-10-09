/**
 * ADR-0187 — the runner's life, without a gateway. PR #205 review round 5 (decision 67): the loop is
 * a state machine driven by the gateway's `next` signal; the table is pinned row by row here, and
 * the driver is run against a scripted gateway for each transition (decisions 48, 49, 53, 54, 55,
 * 60, 64 and round 5's 67, 68, 69). Against the real gateway: apps/gateway/src/zz-b5-promptfoo.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineRunnerNext } from "@regulait/shared";
import { FileRunnerTokenStore, pinnedImageDigest, RUNNER_STATES, RunnerFatalError, RunnerObsoleteBuildError, runRunnerLoop, transition, type RunnerEvent, type RunnerState } from "./loop.js";
import { QUARANTINED_RESULT_PREFIX, RETAINED_RESULT_FILE, RunnerClient, type RunnerHttp } from "./runner.js";

const STORED = `rge_${"7".repeat(64)}`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

describe("round 5 [67]: the runner state machine, row by row (ADR-0187 decision 67)", () => {
  const due = { refreshDue: true, enrolmentAvailable: true };
  const notDue = { refreshDue: false, enrolmentAvailable: true };
  const noToken = { refreshDue: true, enrolmentAvailable: false };
  const next = (n: EngineRunnerNext): RunnerEvent => ({ kind: "next", next: n });
  const rows: Array<[RunnerState, RunnerEvent, typeof due, RunnerState]> = [
    // enrolling / reenrolling
    ["enrolling", { kind: "enrolled" }, due, "leasing"],
    ["enrolling", { kind: "enrolment_refused" }, due, "stopped"],
    ["enrolling", { kind: "transient" }, due, "enrolling"],
    ["reenrolling", { kind: "enrolled" }, due, "leasing"],
    ["reenrolling", { kind: "enrolment_refused" }, due, "stopped"],
    ["reenrolling", { kind: "transient" }, due, "reenrolling"],
    // leasing
    ["leasing", next("ok"), due, "leasing"],
    ["leasing", next("admin_disabled"), due, "waiting"],
    ["leasing", next("self_test_required"), due, "refreshing"],
    ["leasing", next("self_test_required"), notDue, "waiting"],
    ["leasing", next("reenrol_required"), due, "reenrolling"],
    ["leasing", next("reenrol_required"), noToken, "stopped"],
    ["leasing", next("revoked"), due, "reenrolling"],
    ["leasing", next("revoked"), noToken, "stopped"],
    ["leasing", { kind: "transient" }, due, "leasing"],
    ["leasing", { kind: "retention_full" }, due, "waiting"],
    // refreshing
    ["refreshing", next("ok"), due, "leasing"],
    ["refreshing", next("admin_disabled"), due, "waiting"],
    ["refreshing", next("self_test_required"), due, "waiting"],
    ["refreshing", next("reenrol_required"), due, "reenrolling"],
    ["refreshing", next("reenrol_required"), noToken, "stopped"],
    ["refreshing", next("revoked"), due, "reenrolling"],
    ["refreshing", next("revoked"), noToken, "stopped"],
    ["refreshing", { kind: "transient" }, due, "leasing"],
    // waiting
    ["waiting", { kind: "wait_over" }, due, "leasing"],
    ["waiting", next("ok"), due, "waiting"],
  ];
  it.each(rows)("%s + %j → %s", (from, event, ctx, to) => {
    expect(transition(from, event, ctx)).toBe(to);
  });

  it("stopped is final: no event leaves it", () => {
    const events: RunnerEvent[] = [{ kind: "enrolled" }, { kind: "transient" }, { kind: "wait_over" }, { kind: "retention_full" }, next("ok"), next("revoked")];
    for (const e of events) expect(transition("stopped", e, due)).toBe("stopped");
  });

  it("a gateway signal never moves a state that did not ask the gateway (enrolling, waiting)", () => {
    for (const s of ["enrolling", "reenrolling", "waiting"] as const) for (const n of ["ok", "admin_disabled", "self_test_required"] as const) expect(transition(s, next(n), due)).toBe(s);
  });

  it("every state is reachable from the start states", () => {
    const seen = new Set<RunnerState>(["enrolling", "leasing"]);
    for (const [from, event, ctx] of rows) if (seen.has(from)) seen.add(transition(from, event, ctx));
    for (const [from, event, ctx] of rows) if (seen.has(from)) seen.add(transition(from, event, ctx));
    expect([...seen].sort()).toEqual([...RUNNER_STATES].sort());
  });
});

// ---------------------------------------------------------------------------
// THE DRIVER, against a scripted gateway
// ---------------------------------------------------------------------------

type Step = { status: number; error?: string; next?: EngineRunnerNext };
type SelfTestStep = "drop" | { status: number; passed?: boolean; next?: EngineRunnerNext };
interface Script {
  /** register answers, in order (the last repeats); "drop" = the request landed but the response was lost */
  register?: Array<number | "drop">;
  lease: Step[];
  /** self-test answers in order (the last repeats) */
  selfTest?: SelfTestStep[];
  /** result answers (the last repeats) */
  result?: Array<number | "drop">;
}

function gateway(script: Script) {
  const calls: Array<{ path: string; bearer: string; body: Record<string, unknown> | null }> = [];
  let li = 0;
  let ri = 0;
  let si = 0;
  let resi = 0;
  const http: RunnerHttp = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path: p, bearer: init.headers.authorization ?? "", body });
    if (p.endsWith("/register")) {
      const list = script.register ?? [201];
      const step = list[Math.min(ri++, list.length - 1)]!;
      if (step === "drop") throw new Error("socket hang up");
      return {
        status: step,
        json: async () => (step === 201 ? { runnerId: "r1", selfTest: { passed: true, failures: [] }, supersededRunnerId: body?.["supersedes"] ? "r0" : null } : { error: "engine_enrollment_invalid" }),
      };
    }
    if (p.endsWith("/self-test")) {
      const list = script.selfTest ?? [{ status: 200, passed: true, next: "ok" }];
      const step = list[Math.min(si++, list.length - 1)]!;
      if (step === "drop") throw new Error("socket hang up");
      return {
        status: step.status,
        json: async () =>
          step.status === 200
            ? { selfTest: { passed: step.passed ?? true, failures: step.passed === false ? ["egress_connected"] : [] }, ...(step.next ? { next: step.next } : {}) }
            : { error: "engine_runner_reenrol_required", ...(step.next ? { next: step.next } : {}) },
      };
    }
    if (p.endsWith("/result")) {
      const list = script.result ?? [200];
      const step = list[Math.min(resi++, list.length - 1)]!;
      if (step === "drop") throw new Error("socket hang up");
      return { status: step, json: async () => ({}) };
    }
    const step = script.lease[Math.min(li++, script.lease.length - 1)]!;
    return { status: step.status, json: async () => (step.error || step.next ? { error: step.error ?? "x", ...(step.next ? { next: step.next } : {}) } : null) };
  };
  const count = (suffix: string) => calls.filter((c) => c.path.endsWith(suffix)).length;
  return { calls, count, client: new RunnerClient({ gatewayUrl: "http://gateway.test", http }) };
}

const selfTest = () => ({
  imageDigest: DIGEST,
  engineVersion: "1",
  usageDataEnv: {},
  egress: { host: "x.invalid", dnsResolved: false, connected: false, address: null, addressConnected: false },
  at: new Date().toISOString(),
});
const registration = async () => ({ name: "r", imageDigest: DIGEST, engineVersion: "1", selfTest: selfTest() });

/** loop options with a virtual clock that advances by every sleep */
async function opts(over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "runner-loop-"));
  const waits: number[] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  return {
    waits,
    logs,
    dir,
    o: {
      engineId: "promptfoo" as const,
      engineVersion: "1",
      imageDigest: DIGEST,
      workRoot: path.join(dir, "work"),
      store: new FileRunnerTokenStore(path.join(dir, "state", "runner-token")),
      enrollmentToken: "rgee_synthetic_enrolment" as string | null,
      registration,
      backoffMs: 10,
      maxBackoffMs: 40,
      maxIterations: 6,
      now: () => t,
      sleep: async (ms: number) => void (waits.push(ms), (t += ms)),
      log: (m: string) => void logs.push(m),
      ...over,
    },
  };
}
const adapter = async () => ({ status: "completed" as const, items: [], notRun: [], rawReport: null });
const disabled: Step = { status: 409, error: "engine_disabled", next: "admin_disabled" };
const stale: Step = { status: 409, error: "engine_self_test_required", next: "self_test_required" };

describe("leasing: every lease presents the build the runner is running (round 5 [67])", () => {
  it("the lease body is the image digest and engine version, nothing else", async () => {
    const g = gateway({ lease: [{ status: 204 }] });
    const { o } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls[0]).toMatchObject({ path: "/v1/engine-runner/lease", body: { imageDigest: DIGEST, engineVersion: "1" } });
    // round 13 [94]: plus this attempt's request id
    expect(Object.keys(g.calls[0]!.body!).sort()).toEqual(["engineVersion", "imageDigest", "requestId"]);
    expect(g.calls[0]!.body!["requestId"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("PR #205 round 13 [94]: a lease attempt keeps its request id until the gateway answers definitively", () => {
  it("a 5xx, a dropped connection or a transient 409 retries with the SAME id; a definitive answer starts a new attempt", async () => {
    const g = gateway({ lease: [{ status: 503 }, { status: 409, error: "engine_manifest_outdated" }, { status: 204 }, { status: 204 }] });
    const http = (g.client as unknown as { http: RunnerHttp }).http;
    let dropped = false;
    (g.client as unknown as { http: RunnerHttp }).http = async (url, init) => {
      if (url.endsWith("/lease") && !dropped) {
        dropped = true;
        g.calls.push({ path: "/v1/engine-runner/lease", bearer: "", body: JSON.parse(init.body!) as Record<string, unknown> });
        throw new Error("socket hang up"); // the response of the first attempt is lost
      }
      return http(url, init);
    };
    const { o } = await opts({ maxIterations: 5 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    const ids = g.calls.filter((c) => c.path.endsWith("/lease")).map((c) => c.body!["requestId"]);
    expect(ids).toHaveLength(5);
    // drop, 503, transient 409: the same attempt; its 204 settles it
    expect(new Set(ids.slice(0, 4)).size).toBe(1);
    // the next lease is a new attempt
    expect(ids[4]).not.toBe(ids[0]);
  });

  it("a definitive refusal (with a next signal) also ends the attempt", async () => {
    const g = gateway({ lease: [disabled, { status: 204 }] });
    const { o } = await opts({ maxIterations: 2 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    const ids = g.calls.filter((c) => c.path.endsWith("/lease")).map((c) => c.body!["requestId"]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("PR #205 round 13 [95]: a replica with an outdated manifest refuses registration — transient, never fatal", () => {
  it("registration retries past 409 engine_manifest_outdated without using up its attempts, then registers", async () => {
    const g = gateway({ lease: [{ status: 204 }] });
    const http = (g.client as unknown as { http: RunnerHttp }).http;
    let outdated = 7; // more than the 5 attempts a real failure gets
    (g.client as unknown as { http: RunnerHttp }).http = async (url, init) => {
      if (url.endsWith("/register") && outdated-- > 0) {
        g.calls.push({ path: "/v1/engine-runner/register", bearer: "", body: null });
        return { status: 409, json: async () => ({ error: "engine_manifest_outdated" }) };
      }
      return http(url, init);
    };
    const { o } = await opts({ maxIterations: 1 });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.count("/register")).toBe(8);
    expect(await o.store.load()).toMatch(/^rge_[0-9a-f]{64}$/);
  });
});

describe("decision 48 / round 5: admin_disabled is a wait (capped backoff), never a refresh", () => {
  it("waits with a capped backoff; a 5xx is retried; work resumes; no self-test is submitted", async () => {
    const g = gateway({ lease: [disabled, disabled, disabled, disabled, { status: 503 }, { status: 204 }] });
    const { o, waits, logs } = await opts();
    await runRunnerLoop(g.client, adapter, o);
    expect(waits).toEqual([10, 20, 40, 40, 40, 5000]);
    expect(g.count("/self-test")).toBe(0);
    expect(logs.some((l) => /state: leasing -> waiting \(admin_disabled\)/.test(l))).toBe(true);
    expect(logs.some((l) => /lease accepted again/.test(l))).toBe(true);
  });
});

describe("self_test_required: refreshing (decisions 53, 60, 64; round 5 [69])", () => {
  it("[53] refreshes at once; a pass with next=ok leases again at once", async () => {
    const g = gateway({ lease: [stale, { status: 204 }] });
    const { o, waits, logs } = await opts({ maxIterations: 2 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    expect(g.count("/self-test")).toBe(1);
    expect(g.calls.find((c) => c.path.endsWith("/self-test"))!.body).toMatchObject({ selfTest: { imageDigest: DIGEST } });
    expect(waits).toEqual([5000]); // no backoff: leased again at once, then idle
    expect(logs.some((l) => /submitted a fresh self-test: passed/.test(l))).toBe(true);
  });

  it("[69] the engine is OFF and the report is stale: the runner still refreshes, then waits for the admin", async () => {
    // a fresh install before the first enable: the lease asks for a report whatever the engine's state
    const g = gateway({ lease: [stale, disabled, disabled], selfTest: [{ status: 200, passed: true, next: "admin_disabled" }] });
    const { o, logs } = await opts({ maxIterations: 3 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    expect(g.count("/self-test")).toBe(1);
    expect(logs.some((l) => /state: refreshing -> waiting \(admin_disabled\)/.test(l))).toBe(true);
  });

  it("[64] a refused report waits for the cadence before the next submission (the engine stays as the admin left it)", async () => {
    const g = gateway({ lease: [stale], selfTest: [{ status: 200, passed: false, next: "self_test_required" }] });
    const { o, waits } = await opts({ maxIterations: 7, backoffMs: 100, maxBackoffMs: 400, selfTestRefreshMs: 1000 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    // submitted at the start, then again only once >= 1000 ms had passed (100+200+400+400 = 1100)
    expect(g.count("/self-test")).toBe(2);
    expect(waits.slice(0, 4)).toEqual([100, 200, 400, 400]);
  });

  it("[60] a transient submission failure does not use up the cadence: it is retried after the backoff", async () => {
    const g = gateway({ lease: [stale, stale, stale, { status: 204 }], selfTest: ["drop", { status: 503 }, { status: 200, passed: true, next: "ok" }] });
    const { o, waits, logs } = await opts({ maxIterations: 4, selfTestRefreshMs: 60_000 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    expect(g.count("/self-test")).toBe(3);
    expect(waits).toEqual([10, 20, 5000]);
    expect(logs.filter((l) => /will retry/.test(l))).toHaveLength(2);
  });
});

describe("round 5 [67]: reenrol_required (the build changed under a stored credential)", () => {
  it("re-enrols with a NEW secret, presents the old token as `supersedes`, then leases with the new one", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_runner_reenrol_required", next: "reenrol_required" }, { status: 204 }] });
    const { o, logs } = await opts({ maxIterations: 2 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    const reg = g.calls.find((c) => c.path.endsWith("/register"))!;
    const secret = (await o.store.load())!;
    expect(secret).not.toBe(STORED);
    expect(reg.body).toMatchObject({ tokenHash: sha(secret), supersedes: STORED });
    expect(g.calls.at(-1)!.bearer).toBe(`Bearer ${secret}`);
    expect(logs.some((l) => /previous registration r0 is revoked/.test(l))).toBe(true);
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(STORED);
  });

  it("a self-test answer can say it too (the fresh report describes the new build)", async () => {
    const g = gateway({ lease: [stale, { status: 204 }], selfTest: [{ status: 409, next: "reenrol_required" }] });
    const { o } = await opts({ maxIterations: 2 });
    await o.store.save(STORED);
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.find((c) => c.path.endsWith("/register"))!.body).toMatchObject({ supersedes: STORED });
  });

  it("round 6 [72]: the stored token is untouched until the registration lands; a crash after persisting the pending enrolment is resumed on restart, `supersedes` and all", async () => {
    const reenrol: Step = { status: 409, error: "engine_runner_reenrol_required", next: "reenrol_required" };
    const { o } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    // the process dies right after the pending enrolment is written (before any request leaves)
    const crashing = Object.assign(Object.create(Object.getPrototypeOf(o.store) as object) as FileRunnerTokenStore, o.store, {
      savePending: async (p: { secret: string; supersedes: string | null }) => {
        await o.store.savePending(p);
        throw new Error("killed");
      },
    });
    const first = gateway({ lease: [reenrol] });
    await expect(runRunnerLoop(first.client, adapter, { ...o, store: crashing })).rejects.toThrow("killed");
    expect(first.count("/register")).toBe(0);
    expect(await o.store.load()).toBe(STORED); // the old credential is still there
    const pending = (await o.store.loadPending())!;
    expect(pending).toMatchObject({ supersedes: STORED });
    // restart: the interrupted enrolment is resumed with the SAME secret and the SAME supersedes
    // round 8 [77]: the restart first tries the pending secret as the credential (not registered: 401)
    const second = gateway({ lease: [{ status: 401, error: "engine_runner_token_required" }, { status: 204 }] });
    await runRunnerLoop(second.client, adapter, o);
    const reg = second.calls.find((c) => c.path.endsWith("/register"))!;
    expect(reg.body).toMatchObject({ tokenHash: sha(pending.secret), supersedes: STORED });
    expect(second.calls[0]).toMatchObject({ path: "/v1/engine-runner/lease", bearer: `Bearer ${pending.secret}` }); // the probe, never the old token
    expect(second.calls[1]!.path).toBe("/v1/engine-runner/register");
    expect(await o.store.load()).toBe(pending.secret);
    expect(await o.store.loadPending()).toBeNull();
  });

  it("round 8 [77]: a registration committed with its response lost, then the enrolment token expired: the restart tries the secret directly and leases", async () => {
    const { o, logs } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    // the request reached the gateway (which registered it) but the answer was lost, every time, and the process ended
    const first = gateway({ lease: [{ status: 409, error: "engine_runner_reenrol_required", next: "reenrol_required" }], register: ["drop"] });
    await expect(runRunnerLoop(first.client, adapter, { ...o, registerAttempts: 2 })).rejects.toBeInstanceOf(RunnerFatalError);
    expect(await o.store.load()).toBe(STORED);
    const pending = (await o.store.loadPending())!;
    // meanwhile the enrolment token expired: a registration (or its replay) would now be refused
    const second = gateway({ lease: [{ status: 204 }], register: [401] });
    await runRunnerLoop(second.client, adapter, o);
    expect(second.count("/register")).toBe(0);
    expect(second.calls[0]).toMatchObject({ path: "/v1/engine-runner/lease", bearer: `Bearer ${pending.secret}` });
    expect(await o.store.load()).toBe(pending.secret);
    expect(await o.store.loadPending()).toBeNull();
    expect(logs.some((l) => /had registered: its secret is this runner's credential/.test(l))).toBe(true);
  });

  it("round 8 [77]: a secret the gateway refuses (401) is registered again; `already registered` after that stops (revoked)", async () => {
    const { o } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    await o.store.savePending({ secret: `rge_${"9".repeat(64)}`, supersedes: STORED });
    // not registered: the probe is refused, the registration goes ahead with the same secret
    const fresh = gateway({ lease: [{ status: 401, error: "engine_runner_token_required" }, { status: 204 }] });
    await runRunnerLoop(fresh.client, adapter, o);
    expect(fresh.calls.map((c) => c.path)).toEqual(["/v1/engine-runner/lease", "/v1/engine-runner/register", "/v1/engine-runner/lease"]);
    expect(fresh.calls[1]!.body).toMatchObject({ tokenHash: sha(`rge_${"9".repeat(64)}`), supersedes: STORED });
    // registered but revoked: the probe is refused AND the hash is already registered: stop
    await o.store.savePending({ secret: `rge_${"6".repeat(64)}`, supersedes: null });
    const revoked = gateway({ lease: [{ status: 401, error: "engine_runner_revoked" }], register: [409] });
    const http = (revoked.client as unknown as { http: RunnerHttp }).http;
    (revoked.client as unknown as { http: RunnerHttp }).http = async (url, init) =>
      url.endsWith("/register") ? (await http(url, init), { status: 409, json: async () => ({ error: "engine_runner_already_registered" }) }) : http(url, init);
    await expect(runRunnerLoop(revoked.client, adapter, o)).rejects.toThrow(/registered but the gateway refuses it/);
    // round 12 [92]: one fresh secret is tried before stopping (here the gateway refuses that too:
    // it is tried directly, refused, registered again, and only then does the loop stop)
    const regs = revoked.calls.filter((c) => c.path.endsWith("/register"));
    expect(regs).toHaveLength(3);
    expect(regs[1]!.body!["tokenHash"]).not.toBe(regs[0]!.body!["tokenHash"]);
    expect(regs[2]!.body!["tokenHash"]).toBe(regs[1]!.body!["tokenHash"]);
  });

  it("round 12 [92]: registered, credential lost, then revoked: the dead secret is discarded and a NEW one registers with the unused enrolment token", async () => {
    const { o, logs } = await opts({ maxIterations: 1 });
    const dead = `rge_${"5".repeat(64)}`;
    await o.store.savePending({ secret: dead, supersedes: null });
    // the dead secret: refused as a credential (revoked) and its hash already registered
    const g = gateway({ lease: [{ status: 401, error: "engine_runner_revoked" }, { status: 204 }] });
    const http = (g.client as unknown as { http: RunnerHttp }).http;
    (g.client as unknown as { http: RunnerHttp }).http = async (url, init) => {
      if (url.endsWith("/register") && (JSON.parse(init.body!) as { tokenHash: string }).tokenHash === sha(dead)) {
        await http(url, init);
        return { status: 409, json: async () => ({ error: "engine_runner_already_registered" }) };
      }
      return http(url, init);
    };
    await runRunnerLoop(g.client, adapter, o);
    const regs = g.calls.filter((c) => c.path.endsWith("/register"));
    expect(regs).toHaveLength(2);
    expect(regs[0]!.body!["tokenHash"]).toBe(sha(dead));
    const fresh = (await o.store.load())!;
    expect(fresh).not.toBe(dead);
    expect(regs[1]!.body!["tokenHash"]).toBe(sha(fresh));
    expect(await o.store.loadPending()).toBeNull();
    expect(g.calls.at(-1)).toMatchObject({ path: "/v1/engine-runner/lease", bearer: `Bearer ${fresh}` });
    expect(logs.some((l) => /secret was revoked: registering a new one/.test(l))).toBe(true);
  });

  it("round 12 [91]: an image the gateway says is not the current build stops for good (RunnerObsoleteBuildError, never retried)", async () => {
    const { o } = await opts();
    const g = gateway({ lease: [{ status: 204 }] });
    const http = (g.client as unknown as { http: RunnerHttp }).http;
    (g.client as unknown as { http: RunnerHttp }).http = async (url, init) =>
      url.endsWith("/register") ? (await http(url, init), { status: 409, json: async () => ({ error: "engine_runner_build_obsolete" }) }) : http(url, init);
    await expect(runRunnerLoop(g.client, adapter, o)).rejects.toBeInstanceOf(RunnerObsoleteBuildError);
    expect(g.count("/register")).toBe(1);
    expect(g.count("/lease")).toBe(0);
  });

  it("round 8 [77]: `already registered` on a fresh registration: the secret is tried directly", async () => {
    const { o } = await opts({ maxIterations: 1 });
    const g = gateway({ lease: [{ status: 204 }] });
    const http = (g.client as unknown as { http: RunnerHttp }).http;
    (g.client as unknown as { http: RunnerHttp }).http = async (url, init) =>
      url.endsWith("/register") ? (await http(url, init), { status: 409, json: async () => ({ error: "engine_runner_already_registered" }) }) : http(url, init);
    await runRunnerLoop(g.client, adapter, o);
    const secret = (await o.store.load())!;
    expect(g.calls.map((c) => c.path)).toEqual(["/v1/engine-runner/register", "/v1/engine-runner/lease", "/v1/engine-runner/lease"]);
    expect(g.calls[1]!.bearer).toBe(`Bearer ${secret}`);
    expect(await o.store.loadPending()).toBeNull();
  });

  it("round 7 [74]: a crash after the new token was stored but before the pending record was deleted: the stored token is used, the stale record dropped", async () => {
    const SECRET = `rge_${"8".repeat(64)}`;
    // exactly that state: the stored token IS the pending secret; and no enrolment token is set
    const { o, logs } = await opts({ enrollmentToken: null, maxIterations: 1 });
    await o.store.save(SECRET);
    await o.store.savePending({ secret: SECRET, supersedes: STORED });
    const g = gateway({ lease: [{ status: 204 }] });
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.map((c) => c.path)).toEqual(["/v1/engine-runner/lease"]);
    expect(g.calls[0]!.bearer).toBe(`Bearer ${SECRET}`);
    expect(await o.store.loadPending()).toBeNull();
    expect(logs.some((l) => /stale pending record is removed/.test(l))).toBe(true);
  });

  it("round 7 [74]: a stale record that cannot be deleted never blocks the committed credential", async () => {
    const SECRET = `rge_${"8".repeat(64)}`;
    const { o, logs } = await opts({ enrollmentToken: null, maxIterations: 1 });
    await o.store.save(SECRET);
    await o.store.savePending({ secret: SECRET, supersedes: null });
    let tries = 0;
    const stuck = Object.assign(Object.create(Object.getPrototypeOf(o.store) as object) as FileRunnerTokenStore, o.store, {
      clearPending: async () => {
        tries++;
        throw new Error("EROFS");
      },
    });
    const g = gateway({ lease: [{ status: 204 }] });
    await runRunnerLoop(g.client, adapter, { ...o, store: stuck });
    expect(tries).toBe(3);
    expect(g.calls[0]!.bearer).toBe(`Bearer ${SECRET}`);
    expect(logs.some((l) => /could not be removed/.test(l))).toBe(true);
  });

  it("round 6 [72]: an interrupted enrolment with no enrolment token stops and KEEPS the pending record", async () => {
    const { o } = await opts({ enrollmentToken: null });
    await o.store.save(STORED);
    await o.store.savePending({ secret: `rge_${"9".repeat(64)}`, supersedes: STORED });
    // round 8 [77]: the secret is tried directly first (refused here: it never registered)
    const g = gateway({ lease: [{ status: 401, error: "engine_runner_token_required" }] });
    await expect(runRunnerLoop(g.client, adapter, o)).rejects.toThrow(/enrolment was interrupted/);
    expect(g.calls.map((c) => c.path)).toEqual(["/v1/engine-runner/lease"]);
    expect(await o.store.loadPending()).toEqual({ secret: `rge_${"9".repeat(64)}`, supersedes: STORED });
    // a pending record that is not valid is never used
    await writeFile(o.store.pendingFile, JSON.stringify({ secret: "not-a-token", supersedes: null }));
    expect(await o.store.loadPending()).toBeNull();
  });

  it("with no enrolment token it STOPS with what to do — never a wait forever — and the state volume is untouched", async () => {
    const g = gateway({ lease: [{ status: 409, error: "engine_runner_reenrol_required", next: "reenrol_required" }] });
    const { o } = await opts({ enrollmentToken: null });
    await o.store.save(STORED);
    await expect(runRunnerLoop(g.client, adapter, o)).rejects.toThrow(/another build.*mint a new enrolment token/);
    expect(g.count("/lease")).toBe(1);
    expect(await o.store.load()).toBe(STORED);
  });
});

describe("revoked (decision 49): re-enrol once with an unused enrolment token, else stop", () => {
  it("a revoked stored token with an enrolment token: one registration (no `supersedes`), then a second revocation stops", async () => {
    const g = gateway({ lease: [{ status: 401, error: "engine_runner_revoked", next: "revoked" }, { status: 401 }] });
    const { o } = await opts();
    await o.store.save(STORED);
    await expect(runRunnerLoop(g.client, adapter, o)).rejects.toBeInstanceOf(RunnerFatalError);
    const regs = g.calls.filter((c) => c.path.endsWith("/register"));
    expect(regs).toHaveLength(1);
    expect(regs[0]!.body!["tokenHash"]).not.toBe(sha(STORED));
    expect(regs[0]!.body).not.toHaveProperty("supersedes");
  });

  it("the enrolment token refused (spent) → stopped with the admin's next step", async () => {
    const { o } = await opts();
    await o.store.save(STORED);
    await expect(runRunnerLoop(gateway({ register: [401], lease: [{ status: 401, next: "revoked" }] }).client, adapter, o)).rejects.toThrow(
      /enrolment token was refused.*mint a new enrolment token/,
    );
  });

  it("no enrolment token at all → stopped", async () => {
    const { o } = await opts({ enrollmentToken: null });
    await o.store.save(STORED);
    await expect(runRunnerLoop(gateway({ lease: [{ status: 401 }] }).client, adapter, o)).rejects.toThrow(/no unused enrolment token is set/);
  });
});

describe("round 5 [68]: undelivered results are retried before leasing, dropped when settled, and capped", () => {
  const RUN = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  async function retain(workRoot: string, n: number, deadlineAt: string) {
    const dir = path.join(workRoot, RUN(n));
    await mkdir(dir, { recursive: true });
    const envelope = { version: "regulait.engine-result.v1", runId: RUN(n), engineId: "promptfoo", engineVersion: "1", status: "completed", errorCode: null, items: [], notRun: [], rawReport: null };
    await writeFile(path.join(dir, RETAINED_RESULT_FILE), JSON.stringify({ runId: RUN(n), deadlineAt, envelope }));
    return dir;
  }
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it("a retained result is delivered before the next lease; a definitive answer (2xx or 409) removes it", async () => {
    const g = gateway({ lease: [{ status: 204 }], result: [200, 409] });
    const { o } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    const a = await retain(o.workRoot, 1, future());
    const b = await retain(o.workRoot, 2, future());
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.map((c) => c.path)).toEqual([`/v1/engine-runner/runs/${RUN(1)}/result`, `/v1/engine-runner/runs/${RUN(2)}/result`, "/v1/engine-runner/lease"]);
    expect(existsSync(a) || existsSync(b)).toBe(false);
  });

  it("a transient answer keeps it for the next iteration; a passed deadline drops it unsent; a dir with no result is removed", async () => {
    const g = gateway({ lease: [{ status: 204 }], result: [503] });
    const { o } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    const kept = await retain(o.workRoot, 1, future());
    const late = await retain(o.workRoot, 2, new Date(0).toISOString());
    const junk = path.join(o.workRoot, RUN(3));
    await mkdir(junk, { recursive: true });
    await mkdir(path.join(o.workRoot, "not-a-run"), { recursive: true });
    await runRunnerLoop(g.client, adapter, o);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(late)).toBe(false);
    expect(existsSync(junk)).toBe(false);
    expect(g.count("/result")).toBe(1); // only the live one was sent
    expect((await readdir(o.workRoot)).sort()).toEqual([RUN(1), "not-a-run"].sort()); // only run-id dirs are touched
  });

  it("round 13 [96]: a temp file of an unfinished write is not a result; a result that cannot be read is kept aside, never deleted", async () => {
    const g = gateway({ lease: [{ status: 204 }], result: [200] });
    const { o, logs } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    // a valid result beside the temp file of a later, interrupted write: delivered, then removed
    const good = await retain(o.workRoot, 1, future());
    await writeFile(path.join(good, `${RETAINED_RESULT_FILE}.1a2b3c4d`), '{"runId":"trunc');
    // only the temp file of an interrupted write: nothing was ever retained, a crash leftover
    const tmpOnly = path.join(o.workRoot, RUN(2));
    await mkdir(tmpOnly, { recursive: true });
    await writeFile(path.join(tmpOnly, `${RETAINED_RESULT_FILE}.5e6f7a8b`), '{"runId":"trunc');
    // a result file that exists but is truncated: kept aside, the directory untouched
    const bad = path.join(o.workRoot, RUN(3));
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, RETAINED_RESULT_FILE), `{"runId":"${RUN(3)}","deadlineAt":"`);
    await runRunnerLoop(g.client, adapter, o);
    expect(g.calls.map((c) => c.path)).toEqual([`/v1/engine-runner/runs/${RUN(1)}/result`, "/v1/engine-runner/lease"]);
    expect(existsSync(good)).toBe(false);
    expect(existsSync(tmpOnly)).toBe(false);
    const kept = await readdir(bad);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.startsWith(QUARANTINED_RESULT_PREFIX)).toBe(true);
    expect(logs.some((l) => /cannot be read; kept aside/.test(l))).toBe(true);
    // and on the next start the quarantined directory is left alone (not deleted, not counted)
    const again = gateway({ lease: [{ status: 204 }] });
    await runRunnerLoop(again.client, adapter, { ...o, maxIterations: 1 });
    expect(await readdir(bad)).toEqual(kept);
    expect(again.count("/result")).toBe(0);
  });

  it("round 11 [90]: a result retained on the persistent root (the state volume) is delivered after a restart, before any lease", async () => {
    const g = gateway({ lease: [{ status: 204 }], result: [200] });
    const { o, dir } = await opts({ maxIterations: 1 });
    await o.store.save(STORED);
    const retainRoot = path.join(dir, "state", "undelivered");
    const kept = await retain(retainRoot, 1, future());
    // a fresh process: the tmpfs work root is empty, the state volume still holds the result
    await runRunnerLoop(g.client, adapter, { ...o, retainRoot });
    expect(g.calls.map((c) => c.path)).toEqual([`/v1/engine-runner/runs/${RUN(1)}/result`, "/v1/engine-runner/lease"]);
    expect(existsSync(kept)).toBe(false);
  });

  it("at the cap no work is leased: the loop waits until the results are delivered", async () => {
    const g = gateway({ lease: [{ status: 204 }], result: [503, 503, 503, 503, 503, 503, 200] });
    const { o, logs } = await opts({ maxIterations: 3, maxRetainedResults: 3 });
    await o.store.save(STORED);
    for (const n of [1, 2, 3]) await retain(o.workRoot, n, future());
    await runRunnerLoop(g.client, adapter, o);
    // two visits at the cap (3 + 3 transient attempts, nothing leased), then all three delivered: lease
    expect(g.count("/lease")).toBe(1);
    expect(logs.some((l) => /undelivered results are retained; no new work/.test(l))).toBe(true);
  });
});

describe("decisions 49 and 54: the runner's own token, persisted before it registers", () => {
  it("is generated by the runner, persisted 0600 (as a pending enrolment) BEFORE register, sent only as its hash, never logged, reused on restart", async () => {
    const { o, logs } = await opts({ maxIterations: 1 });
    let pendingAtRegister: { secret: string; supersedes: string | null } | null = null;
    let storedAtRegister: string | null = "unset";
    const first = gateway({ lease: [{ status: 204 }] });
    const http = (first.client as unknown as { http: RunnerHttp }).http;
    (first.client as unknown as { http: RunnerHttp }).http = async (url, init) => {
      if (url.endsWith("/register")) {
        pendingAtRegister = await o.store.loadPending();
        storedAtRegister = await o.store.load();
        expect((await stat(o.store.pendingFile)).mode & 0o777).toBe(0o600);
      }
      return http(url, init);
    };
    await runRunnerLoop(first.client, adapter, o);
    const secret = await o.store.load();
    expect(secret).toMatch(/^rge_[0-9a-f]{64}$/);
    expect(pendingAtRegister).toEqual({ secret, supersedes: null }); // persisted before the request left
    expect(storedAtRegister).toBeNull(); // the stored token is written only after the 201 (round 6 [72])
    expect(await o.store.loadPending()).toBeNull();
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

  it("a first start with no enrolment token stops and says what to do", async () => {
    const { o } = await opts({ enrollmentToken: null });
    await expect(runRunnerLoop(gateway({ lease: [{ status: 204 }] }).client, adapter, o)).rejects.toThrow(/no stored token and no enrolment token/);
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

describe("PR #205 round 15 [99]: after the lease is acquired, nothing re-leases the run", () => {
  it("delivery fails and persisting the envelope throws: the adapter ran once, the run is reported, and no lease reuses the request id", async () => {
    const runId = "0000000a-0000-4000-8000-000000000000";
    const lease = {
      runId,
      engineId: "promptfoo",
      engineVersion: "1",
      spec: { config: { sets: ["basic"], params: {} }, trials: 1 },
      target: null,
      judge: null,
      artifacts: [],
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      budgetUsd: null,
    };
    const leaseIds: string[] = [];
    const results: Array<{ status: string; errorCode: string | null }> = [];
    let resultCalls = 0;
    const http: RunnerHttp = async (url, init) => {
      const p = new URL(url).pathname;
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (p.endsWith("/lease")) {
        const id = String(body["requestId"]);
        // a gateway re-issues the still-live lease to a retry with the same id (decision 94)
        const known = leaseIds.includes(id);
        leaseIds.push(id);
        return leaseIds.length === 1 || known ? { status: 200, json: async () => lease } : { status: 204, json: async () => null };
      }
      if (p.endsWith("/heartbeat")) return { status: 200, json: async () => ({ cancel: false }) };
      resultCalls++;
      results.push({ status: String(body["status"]), errorCode: (body["errorCode"] as string | null) ?? null });
      // the first delivery (and its retries) cannot reach the gateway; the reconciliation's post lands
      if (resultCalls === 1) throw new Error("ECONNRESET");
      return { status: 200, json: async () => ({}) };
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http });
    let adapterRuns = 0;
    const counting = async () => {
      adapterRuns++;
      return { status: "completed" as const, items: [], notRun: [], rawReport: null };
    };
    // persisting the undelivered envelope fails (a full or unwritable volume)
    const realRename = fs.rename;
    (fs as { rename: typeof fs.rename }).rename = ((a: fs.PathLike, b: fs.PathLike, cb: (e: NodeJS.ErrnoException | null) => void) =>
      String(b).includes(RETAINED_RESULT_FILE) ? cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })) : realRename(a, b, cb)) as typeof fs.rename;
    try {
      const { o, logs } = await opts({ maxIterations: 2, maxResultAttempts: 1, retryBaseMs: 1 });
      await o.store.save(STORED);
      await runRunnerLoop(client, counting, o);
      expect(adapterRuns).toBe(1);
      expect(leaseIds).toHaveLength(2);
      expect(leaseIds[1]).not.toBe(leaseIds[0]);
      // the envelope in memory was delivered by the reconciliation (one failed post, then one that landed)
      expect(results).toEqual([
        { status: "completed", errorCode: null },
        { status: "completed", errorCode: null },
      ]);
      expect(logs.some((l) => /after the lease: ENOSPC/.test(l))).toBe(true);
    } finally {
      (fs as { rename: typeof fs.rename }).rename = realRename;
    }
  });
});

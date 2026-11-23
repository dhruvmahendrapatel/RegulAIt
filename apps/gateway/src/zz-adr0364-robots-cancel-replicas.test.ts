/**
 * ADR-0364 S3 (owner, D-2026-11-22-07) — A CALLER'S CANCEL STOPS A ROBOT RUN ON EVERY REPLICA, AND FAILS CLOSED.
 *
 * Two replicas on one database: replica B is this file's own `caller-cancel` module (it serves the call and holds the
 * run's controller); replica A is a second, independent instance of the same module (`vi.resetModules`), which shares
 * nothing with B but the database. A cancel received by A, which does not serve the call, must reach B's call and its
 * run; when B cannot confirm the shared state, the run stops.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, mcpCallerCancellations, robotRuns, robotVersions, robots, sql } from "@regulait/db";
import type { RobotRunPlan } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import * as replicaB from "./caller-cancel.js";
import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { installProtocolSurface } from "./mcp-protocol.js";
import { finishRun, RobotRunController, setRobotRunnerImageForTest, type RobotRunRequest } from "./robot-runs.js";

const SITE = "https://portal.example.com";
const DEPS = { dataKey: "a".repeat(64), store: null };
const OUTPUT_SCHEMA = { type: "object", properties: { balance: { type: "string" } } };

let kit: BuilderKit;
let owner: Person;
let robotId: string;
let replicaA: typeof replicaB;

const scopeOf = (who: string) => [who, "server-1", "api_key", "key-1"].join("\u0000");

describe.skipIf(!process.env.DATABASE_URL)("ADR-0364 S3 robot runs: cross-replica cancel (D-2026-11-22-07)", () => {
  const planFor = (runId: string): RobotRunPlan => ({
    runId,
    kind: "agent",
    allowedOrigins: [SITE],
    steps: [{ op: "goto", url: `${SITE}/login` }],
    secrets: [],
    limits: { wallClockMs: 60_000, actionTimeoutMs: 1000, outputChars: 100, downloadBytes: 4096 },
    screenshots: "masked",
  });
  const loaded = async () => {
    const [row] = await kit.db.select({ robot: robots, version: robotVersions }).from(robotVersions).innerJoin(robots, eq(robots.id, robotVersions.robotId)).where(eq(robots.id, robotId));
    return row!;
  };
  const request = async (signal: AbortSignal): Promise<RobotRunRequest> => {
    const { robot, version } = await loaded();
    return { robot, version, kind: "agent", requestedBy: owner.id, projectId: owner.projectId, inputs: { username: "a" }, contentDigest: "c".repeat(64), signal };
  };
  const runningRow = async () => {
    const { version } = await loaded();
    const [run] = await kit.db
      .insert(robotRuns)
      .values({ robotVersionId: version.id, requestedBy: owner.id, projectId: owner.projectId, kind: "agent", status: "running", startedAt: new Date(), contentDigest: "b".repeat(64) })
      .returning({ id: robotRuns.id });
    return run!.id;
  };
  // one heartbeat through the controller, the way the session sends it
  const heartbeat = async (controller: RobotRunController): Promise<{ status: number; cancel: boolean }> => {
    const pushed: string[] = [];
    controller.onFrame(
      JSON.stringify({ t: "http", id: "1", method: "POST", path: `/v1/robot-runner/runs/${controller.runId}/heartbeat`, headers: {}, body: Buffer.from(JSON.stringify({ step: 0 })).toString("base64") }),
      { push: (l: string) => void pushed.push(l) },
    );
    for (let i = 0; i < 800 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const res = JSON.parse(pushed[0]!) as { status: number; body: string };
    return { status: res.status, cancel: (JSON.parse(Buffer.from(res.body, "base64").toString("utf8")) as { cancel: boolean }).cancel };
  };

  beforeAll(async () => {
    kit = await builderKit("rbtcx", { scratch: true });
    owner = await kit.person("owner");
    const r = await kit.req("POST", "/v1/robots", owner.auth, { slug: `cancel_${kit.RUN}`, name: "Cancel across replicas" });
    expect(r.statusCode, r.body).toBe(201);
    robotId = r.json().robot.id;
    const v = await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, {
      source: "recorded",
      scriptFormat: "steps_v1",
      script: JSON.stringify({ steps: [{ op: "goto", url: `${SITE}/login` }] }),
      inputSchema: { type: "object", properties: { username: { type: "string" } }, additionalProperties: false },
      outputSchema: OUTPUT_SCHEMA,
      allowedSites: [SITE],
      secretBindings: [],
    });
    expect(v.statusCode, v.body).toBe(201);
    setRobotRunnerImageForTest("sha256:" + "a".repeat(64));
    // replica A: a second, independent instance of the module (its own in-flight registry), on the same database
    vi.resetModules();
    replicaA = await import("./caller-cancel.js");
    expect(replicaA).not.toBe(replicaB);
  }, 180_000);
  afterEach(() => {
    replicaB.setCallerCancelReadForTest(null);
  });
  afterAll(async () => {
    setRobotRunnerImageForTest(undefined);
    await kit?.close();
  });

  it("a cancel received by replica A (which does not serve the call) aborts the call on replica B, and only that call", async () => {
    const scope = scopeOf(owner.id);
    const mine = replicaB.trackCallerRequest(scope, 7, new AbortController().signal, kit.db);
    const otherId = replicaB.trackCallerRequest(scope, 8, new AbortController().signal, kit.db);
    const otherCaller = replicaB.trackCallerRequest(scopeOf("someone-else"), 7, new AbortController().signal, kit.db);
    try {
      // A serves nothing: its local lookup misses, so it writes the cancel for every replica
      expect(replicaA.cancelCallerRequest(scope, 7, "user pressed stop")).toBe(false);
      expect(await replicaA.broadcastCallerCancel(kit.db, scope, owner.id, 7)).toBe(true);
      // the row holds a hash, never the raw scope (it names credential ids)
      const rows = await kit.db.select().from(mcpCallerCancellations).where(eq(mcpCallerCancellations.requestKey, replicaB.callerRequestKey(scope, 7)));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.requestKey).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toContain("key-1");
      // B's watch reads the shared table (each second; here, now)
      expect(await replicaB.pollCallerCancelsForTest()).toBe(true);
      expect(mine.signal.aborted).toBe(true);
      expect(otherId.signal.aborted).toBe(false);
      expect(otherCaller.signal.aborted).toBe(false);
    } finally {
      mine.done();
      otherId.done();
      otherCaller.done();
    }
  });

  it("the protocol surface writes a cancel it does not serve for every replica, and keeps a served one local", async () => {
    const handlers = new Map<unknown, (n: unknown) => Promise<void>>();
    const fake = { removeRequestHandler: () => undefined, setNotificationHandler: (schema: unknown, fn: (n: unknown) => Promise<void>) => void handlers.set(schema, fn) };
    const scope = scopeOf(owner.id);
    installProtocolSurface(fake as unknown as Server, { db: kit.db, call: async () => ({}), userId: owner.id, serverId: "server-1", projectId: null, cancelScope: scope });
    const onCancel = handlers.get(CancelledNotificationSchema)!;
    const keyOf = (id: number) => replicaB.callerRequestKey(scope, id);
    const rowsFor = (id: number) => kit.db.select().from(mcpCallerCancellations).where(eq(mcpCallerCancellations.requestKey, keyOf(id)));
    // not served here: written
    await onCancel({ method: "notifications/cancelled", params: { requestId: 55, reason: "r".repeat(500) } });
    const [row] = await rowsFor(55);
    expect(row).toMatchObject({ userId: owner.id });
    // the client's free-text reason is never stored
    expect(Object.keys(row!).sort()).toEqual(["createdAt", "requestKey", "userId"]);
    // served here: aborted at once, nothing written
    const served = replicaB.trackCallerRequest(scope, 56, new AbortController().signal, kit.db);
    try {
      await onCancel({ method: "notifications/cancelled", params: { requestId: 56 } });
      expect(served.signal.aborted).toBe(true);
      expect(await rowsFor(56)).toHaveLength(0);
    } finally {
      served.done();
    }
  });

  it("an old cancel row does not cancel a later call that reuses the JSON-RPC id", async () => {
    const scope = scopeOf(owner.id);
    expect(await replicaA.broadcastCallerCancel(kit.db, scope, owner.id, 9)).toBe(true);
    await kit.db
      .update(mcpCallerCancellations)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(mcpCallerCancellations.requestKey, replicaB.callerRequestKey(scope, 9)));
    const later = replicaB.trackCallerRequest(scope, 9, new AbortController().signal, kit.db);
    try {
      expect(await replicaB.pollCallerCancelsForTest()).toBe(true);
      expect(later.signal.aborted).toBe(false);
    } finally {
      later.done();
    }
  });

  it("a robot run on replica B is stopped by a cancel sent to replica A: the heartbeat answers cancel, the run ends caller_aborted", async () => {
    const scope = scopeOf(owner.id);
    const call = replicaB.trackCallerRequest(scope, 21, new AbortController().signal, kit.db);
    try {
      const runId = await runningRow();
      const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [], owner.id, { confirmCancel: replicaB.confirmCallerCancels, cancelGraceMs: 50 });
      // as startRobotRun wires it: the call's abort cancels the run
      call.signal.addEventListener("abort", () => controller.requestCancel(50), { once: true });
      expect(await heartbeat(controller)).toEqual({ status: 200, cancel: false });
      expect(await replicaA.broadcastCallerCancel(kit.db, scope, owner.id, 21)).toBe(true);
      await replicaB.pollCallerCancelsForTest();
      expect(call.signal.aborted).toBe(true);
      expect(await heartbeat(controller)).toEqual({ status: 200, cancel: true });
      expect(controller.cancelUnconfirmed).toBe(false);
      const out = await finishRun(kit.db, await request(call.signal), runId, null, OUTPUT_SCHEMA, controller);
      expect(out).toMatchObject({ kind: "finished", status: "cancelled", failureCode: "caller_aborted" });
    } finally {
      call.done();
    }
  });

  it("fail closed: when replica B cannot read the shared cancel state, the heartbeat answers cancel and the run ends cancel_unconfirmed", async () => {
    const scope = scopeOf(owner.id);
    const call = replicaB.trackCallerRequest(scope, 31, new AbortController().signal, kit.db);
    try {
      const runId = await runningRow();
      const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [], owner.id, { confirmCancel: replicaB.confirmCallerCancels, cancelGraceMs: 50 });
      // the database does not answer the watch's read
      replicaB.setCallerCancelReadForTest(() => Promise.reject(new Error("connection terminated")));
      expect(await heartbeat(controller)).toEqual({ status: 200, cancel: true });
      expect(controller.cancelUnconfirmed).toBe(true);
      expect(controller.cancelRequested).toBe(true);
      const out = await finishRun(kit.db, await request(call.signal), runId, null, OUTPUT_SCHEMA, controller);
      expect(out).toMatchObject({ kind: "finished", status: "cancelled", failureCode: "cancel_unconfirmed" });
      const [row] = await kit.db.select().from(robotRuns).where(eq(robotRuns.id, runId));
      expect(row).toMatchObject({ status: "cancelled", failureCode: "cancel_unconfirmed" });
    } finally {
      call.done();
    }
  });

  it("fail closed: a read that hangs past its bound is unconfirmed too", async () => {
    const call = replicaB.trackCallerRequest(scopeOf(owner.id), 41, new AbortController().signal, kit.db);
    try {
      replicaB.setCallerCancelReadForTest(() => new Promise(() => undefined));
      const started = Date.now();
      expect(await replicaB.confirmCallerCancels()).toBe(false);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      call.done();
    }
  });

  it("a run with no caller (a test run) does not depend on the shared state", async () => {
    const runId = await runningRow();
    const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [], owner.id);
    replicaB.setCallerCancelReadForTest(() => Promise.reject(new Error("connection terminated")));
    expect(await heartbeat(controller)).toEqual({ status: 200, cancel: false });
  });
});

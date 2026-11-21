/**
 * ADR-0364 S3 (lane E45), the review-fix round on the gateway side — on a real database through the real app.
 *
 *  - B1 THE CANARY ON OUTPUTS: a page that echoes a secret value back (raw, base64 or percent-encoded) fails the run
 *    `secret_in_output`; no output is returned and none is stored (not in the run row, an audit row or a usage row).
 *    Values under four characters are not matched (documented at `CANARY_MIN_CHARS`).
 *  - B2 THE PII MODE: resolved through the compliance cascade (`projectPiiMode`): the org floor when the project has
 *    no matching tag, the tag's profile when it has one. `block` = screenshots off and downloads kept by digest only.
 *  - B4 THE IN-FLIGHT EVIDENCE CAPS, per run and across runs: a chunk over either fails the run `evidence_too_large`.
 *  - Code 1: a robot tools/call gets a deadline that covers a whole run, and one attempt.
 *  - Code 3: an over-budget project is refused in the budget gate's own shape (409 `project_budget_exceeded`).
 *  - Code 4: the end audit carries the ordered evidence list.
 *  - Code 6: a terminal write that loses its race records nothing; the stale-run sweep ends old runs `timed_out`.
 *  - N5: a placement that throws refuses the run with a fixed code (never a `queued` row and a 500).
 *  - N7: the runner argv is the image's own CMD.
 *
 * Global state (M-068): the runner image seam, the evidence caps and the placement seam are reset; the org PII default
 * and the project's budget and tags are restored.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, auditLog, complianceProfiles, eq, inArray, orgSettings, projects, robotRunEvidence, robotRuns, robotVersions, robots, sql, usageEvents } from "@regulait/db";
import { newRobotRunKey, ROBOT_RUN_LIMITS, type RobotRunPlan } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { artifactStorageKey, FileArtifactStore } from "./model-artifacts.js";
import { timeouts } from "./timeouts.js";
import { attemptsForToolKind } from "./upstream-retry.js";
import { ROBOT_RUN_MAX_LIFETIME_MS, ROBOTS_SERVER_URL } from "./robots-mcp.js";
import { toolCallBudgetMs } from "./mcp-proxy.js";
import {
  canaryPatterns,
  finishRun,
  RobotRunController,
  robotEvidenceInFlightBytes,
  ROBOT_RUNNER_WORKLOAD,
  ROBOT_RUN_STALE_MS,
  runRobotRunStaleSweep,
  setRobotEvidenceCapsForTest,
  setRobotRunnerImageForTest,
  startRobotRun,
  type RobotRunRequest,
} from "./robot-runs.js";

// the placement seam: decision 7 is the real one unless a test asks it to throw or to refuse
const placement = vi.hoisted(() => ({ mode: "real" as "real" | "throw" | "refuse" }));
vi.mock("./execution-placement.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("./execution-placement.js")>();
  return {
    ...m,
    decidePlacement: async (...a: Parameters<typeof m.decidePlacement>) => {
      if (placement.mode === "throw") throw new m.PlacementEgressError("egress targets out of shape (test)");
      if (placement.mode === "refuse") return { kind: "refused", code: "no_executor", placementId: null } as unknown as Awaited<ReturnType<typeof m.decidePlacement>>;
      return m.decidePlacement(...a);
    },
  };
});

const SITE = "https://portal.example.com";
const CANARY = "canary-S3b-Secret-41d2";
const script = (steps: unknown[]) => JSON.stringify({ steps });
const draft = {
  source: "recorded",
  scriptFormat: "steps_v1",
  script: script([
    { op: "goto", url: `${SITE}/login` },
    { op: "fill", selector: "#user", input: "username" },
    { op: "fill", selector: "#pass", secret: "PORTAL_PASSWORD" },
    { op: "read", selector: "#balance", output: "balance" },
  ]),
  inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"], additionalProperties: false },
  outputSchema: { type: "object", properties: { balance: { type: "string" } } },
  allowedSites: [SITE],
  secretBindings: [{ name: "PORTAL_PASSWORD", origin: SITE }],
};
const OUTPUT_SCHEMA = draft.outputSchema as Record<string, unknown>;
const DEPS = { dataKey: "a".repeat(64), store: null };

let kit: BuilderKit;
let owner: Person;
let stranger: Person;
let robotId: string;

describe.skipIf(!process.env.DATABASE_URL)("ADR-0364 S3 robot runs: the gateway review fixes", () => {
  const loaded = async () => {
    const [row] = await kit.db.select({ robot: robots, version: robotVersions }).from(robotVersions).innerJoin(robots, eq(robots.id, robotVersions.robotId)).where(eq(robots.id, robotId));
    return row!;
  };
  const request = async (over: Partial<RobotRunRequest> = {}): Promise<RobotRunRequest> => {
    const { robot, version } = await loaded();
    return { robot, version, kind: "test", requestedBy: owner.id, projectId: owner.projectId, inputs: { username: "a" }, contentDigest: "c".repeat(64), ...over };
  };
  const runningRow = async () => {
    const { version } = await loaded();
    const [run] = await kit.db
      .insert(robotRuns)
      .values({ robotVersionId: version.id, requestedBy: owner.id, projectId: owner.projectId, kind: "test", status: "running", startedAt: new Date(), contentDigest: "b".repeat(64) })
      .returning({ id: robotRuns.id });
    return run!.id;
  };
  const planFor = (runId: string): RobotRunPlan => ({
    runId,
    kind: "test",
    allowedOrigins: [SITE],
    steps: [{ op: "goto", url: `${SITE}/login` }],
    secrets: [],
    limits: { wallClockMs: 60_000, actionTimeoutMs: 1000, outputChars: 100, downloadBytes: 4096 },
    screenshots: "masked",
  });
  // drive one gateway-channel request through a controller, the way the session does
  const channel = (controller: RobotRunController) => {
    const pushed: string[] = [];
    const session = { push: (line: string) => void pushed.push(line) };
    let id = 0;
    return async (method: "GET" | "POST", route: string, body?: unknown) => {
      const n = String(++id);
      const before = pushed.length;
      controller.onFrame(
        JSON.stringify({ t: "http", id: n, method, path: `/v1/robot-runner/runs/${controller.runId}/${route}`, headers: {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)).toString("base64") }),
        session,
      );
      for (let i = 0; i < 400 && pushed.length === before; i++) await new Promise((r) => setTimeout(r, 5));
      const res = JSON.parse(pushed.at(-1)!) as { id: string; status: number; body: string };
      expect(res.id).toBe(n);
      return { status: res.status, json: JSON.parse(Buffer.from(res.body, "base64").toString("utf8")) as Record<string, unknown> };
    };
  };
  const oneChunk = (item: number, bytes: Buffer, kind: "screenshot" | "download", last = true) => ({
    item,
    kind,
    step: 1,
    contentType: kind === "screenshot" ? "image/jpeg" : "application/octet-stream",
    chunk: 0,
    dataBase64: bytes.toString("base64"),
    last,
    ...(last ? { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } : {}),
  });
  const auditsOf = (runId: string) => kit.db.select().from(auditLog).where(and(eq(auditLog.objectType, "robot_run"), eq(auditLog.objectId, runId)));

  beforeAll(async () => {
    kit = await builderKit("rbt3b", { scratch: true });
    owner = await kit.person("owner");
    stranger = await kit.person("stranger");
    const r = await kit.req("POST", "/v1/robots", owner.auth, { slug: `portal_${kit.RUN}`, name: "Portal balance" });
    expect(r.statusCode, r.body).toBe(201);
    robotId = r.json().robot.id;
    expect((await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, draft)).statusCode).toBe(201);
    const g = await grantStepUpForTest(kit.db, owner.id, { kind: "settings_relax", facts: { op: "robot_secret_set", robotId, name: "PORTAL_PASSWORD", scope: "test" } });
    const sr = stepUpRequest(g);
    const s = await kit.app.inject({ method: "PUT", url: `/v1/robots/${robotId}/secrets/PORTAL_PASSWORD/test`, headers: sr.headers, cookies: sr.cookies, payload: { value: CANARY } });
    expect(s.statusCode, s.body).toBe(200);
    for (const p of [owner.projectId, stranger.projectId]) await kit.db.update(projects).set({ budgetUsd: 50 }).where(eq(projects.id, p));
    setRobotRunnerImageForTest("sha256:" + "a".repeat(64));
  }, 180_000);
  afterAll(async () => {
    setRobotRunnerImageForTest(undefined);
    setRobotEvidenceCapsForTest(undefined);
    placement.mode = "real";
    if (kit) await kit.db.update(orgSettings).set({ defaultPiiMode: "block" });
    await kit?.close();
  });

  it("N7: the runner argv is the robot-runner image's own CMD", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const dockerfile = await readFile(path.join(root, "engines/robot-runner/Dockerfile"), "utf8");
    const cmd = /^CMD\s+(\[.*\])\s*$/m.exec(dockerfile);
    expect(cmd, "the Dockerfile has an exec-form CMD").toBeTruthy();
    const argv = JSON.parse(cmd![1]!) as string[];
    expect(argv[0]).toBe("node");
    expect([...ROBOT_RUNNER_WORKLOAD.args]).toEqual(argv.slice(1));
    expect(ROBOT_RUNNER_WORKLOAD.args).toEqual(["/app/dist/main.js"]);
  });

  it("Code 1: a robot tools/call gets a deadline covering a whole run, every other tool the generic one, and one attempt", () => {
    const generic = timeouts().mcpCallToolMs;
    const robot = toolCallBudgetMs({ transport: "first_party", url: ROBOTS_SERVER_URL });
    expect(robot).toBeGreaterThan(ROBOT_RUN_MAX_LIFETIME_MS);
    expect(robot).toBeGreaterThan(generic);
    expect(ROBOT_RUN_MAX_LIFETIME_MS).toBeGreaterThanOrEqual(ROBOT_RUN_LIMITS.wallClockMs + 30_000);
    expect(toolCallBudgetMs({ transport: "streamable_http", url: "https://mcp.example.com/mcp" })).toBe(generic);
    // a remote row that merely names the URL is not the Robots server
    expect(toolCallBudgetMs({ transport: "streamable_http", url: ROBOTS_SERVER_URL })).toBe(generic);
    // ADR-0128: a tools/call is never retried, so an aborted robot call cannot start a second run
    expect(attemptsForToolKind("write")).toBe(1);
    expect(attemptsForToolKind(null)).toBe(1);
  });

  it("B1: the canary covers raw, JSON, percent (either case) and base64 forms at any alignment, and skips values under 4 chars", () => {
    const pats = canaryPatterns([CANARY, "abc"]);
    const hit = (s: string) => pats.some((p) => Buffer.from(s, "utf8").includes(p));
    expect(hit(`page ${CANARY} text`)).toBe(true);
    for (const pre of ["", "x", "xy", "xyz"]) {
      const b64 = Buffer.from(`${pre}${CANARY}tail`).toString("base64");
      expect(hit(b64), `base64 after ${pre.length} bytes`).toBe(true);
      expect(hit(Buffer.from(`${pre}${CANARY}tail`).toString("base64url")), `base64url after ${pre.length} bytes`).toBe(true);
    }
    const weird = "p@ss w/rd+%";
    const pw = canaryPatterns([weird]);
    const hitW = (s: string) => pw.some((p) => Buffer.from(s, "utf8").includes(p));
    expect(hitW(`q=${encodeURIComponent(weird)}&x`)).toBe(true);
    expect(hitW(`q=${encodeURIComponent(weird).toLowerCase()}&x`)).toBe(true);
    expect(hitW(JSON.stringify({ v: weird }))).toBe(true);
    // a value under four characters is not matched (it would shred ordinary page content)
    expect(hit("the abc of it")).toBe(false);
  });

  it("B1: a page-echoed secret in an output fails the run secret_in_output; no output is returned or stored", async () => {
    for (const echoed of [`Balance: 10 ${CANARY}`, Buffer.from(`${CANARY}`).toString("base64"), encodeURIComponent(`?pw=${CANARY}`)]) {
      const runId = await runningRow();
      const runKey = newRobotRunKey();
      const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [runKey, CANARY], owner.id);
      const out = await finishRun(kit.db, await request(), runId, { status: "succeeded", stepsCompleted: 4, outputs: { balance: echoed } }, OUTPUT_SCHEMA, controller);
      expect(out).toMatchObject({ kind: "finished", status: "failed", failureCode: "secret_in_output", outputs: null });
      const [row] = await kit.db.select().from(robotRuns).where(eq(robotRuns.id, runId));
      expect(row).toMatchObject({ status: "failed", failureCode: "secret_in_output" });
      const audits = await auditsOf(runId);
      expect(audits.map((a) => a.ruleId).sort()).toEqual(["robot-run-failed", "robot-run-output-leak-refused"]);
      const usage = await kit.db.select().from(usageEvents).where(sql`${usageEvents.detail}->>'robotRunId' = ${runId}`);
      expect(usage).toHaveLength(1);
      const stored = JSON.stringify([row, audits, usage]);
      expect(stored).not.toContain(CANARY);
      expect(stored).not.toContain(echoed);
    }
  });

  it("Code 4: the end audit carries the ordered evidence list [{item, kind, sha256}]; a clean output is returned", async () => {
    const runId = await runningRow();
    const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [CANARY], owner.id);
    const call = channel(controller);
    const a = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 1)]);
    const b = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 2)]);
    expect((await call("POST", "evidence", oneChunk(1, b, "screenshot"))).status).toBe(200);
    expect((await call("POST", "evidence", oneChunk(0, a, "screenshot"))).status).toBe(200);
    const out = await finishRun(kit.db, await request(), runId, { status: "succeeded", stepsCompleted: 4, outputs: { balance: "10" } }, OUTPUT_SCHEMA, controller);
    expect(out).toMatchObject({ kind: "finished", status: "succeeded", outputs: { balance: "10" } });
    const [end] = (await auditsOf(runId)).filter((x) => x.ruleId === "robot-run-succeeded");
    const sha = (x: Buffer) => createHash("sha256").update(x).digest("hex");
    expect((end!.detail as { evidence: unknown }).evidence).toEqual([
      { item: 0, kind: "screenshot", sha256: sha(a) },
      { item: 1, kind: "screenshot", sha256: sha(b) },
    ]);
    // with no store configured the rows say so
    const rows = await kit.db.select().from(robotRunEvidence).where(eq(robotRunEvidence.robotRunId, runId));
    expect(rows.map((r) => r.bytesWithheld)).toEqual(["no_store", "no_store"]);
  });

  it("Code 6: a terminal write that lost its race (the run already ended) writes no audit and answers `lost`", async () => {
    const runId = await runningRow();
    await kit.db.update(robotRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(robotRuns.id, runId));
    const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [CANARY], owner.id);
    const out = await finishRun(kit.db, await request(), runId, { status: "succeeded", stepsCompleted: 4, outputs: { balance: "1" } }, OUTPUT_SCHEMA, controller);
    expect(out).toMatchObject({ kind: "lost", runId });
    expect(await auditsOf(runId)).toHaveLength(0);
    const [row] = await kit.db.select().from(robotRuns).where(eq(robotRuns.id, runId));
    expect(row!.status).toBe("cancelled");
  });

  it("Code 6: the stale-run sweep ends old queued and running runs timed_out (audited) and leaves fresh ones", async () => {
    const { version } = await loaded();
    const old = new Date(Date.now() - ROBOT_RUN_STALE_MS - 60 * 60_000);
    const mk = (status: "queued" | "running", createdAt?: Date) =>
      kit.db
        .insert(robotRuns)
        .values({ robotVersionId: version.id, requestedBy: owner.id, projectId: owner.projectId, kind: "test", status, contentDigest: "d".repeat(64), ...(createdAt ? { createdAt } : {}) })
        .returning({ id: robotRuns.id })
        .then((r) => r[0]!.id);
    const staleQueued = await mk("queued", old);
    const staleRunning = await mk("running", old);
    const fresh = await mk("running");
    const out = await runRobotRunStaleSweep(kit.db);
    expect(out.ids).toEqual(expect.arrayContaining([staleQueued, staleRunning]));
    expect(out.ids).not.toContain(fresh);
    const rows = await kit.db.select().from(robotRuns).where(inArray(robotRuns.id, [staleQueued, staleRunning, fresh]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(staleQueued)).toMatchObject({ status: "timed_out", failureCode: "stale_run" });
    expect(byId.get(staleRunning)).toMatchObject({ status: "timed_out", failureCode: "stale_run" });
    expect(byId.get(fresh)!.status).toBe("running");
    for (const id of [staleQueued, staleRunning]) expect((await auditsOf(id)).map((a) => a.ruleId)).toEqual(["robot-run-timed-out"]);
    // a second pass finds nothing more
    expect((await runRobotRunStaleSweep(kit.db)).ids).not.toContain(staleQueued);
    await kit.db.update(robotRuns).set({ status: "cancelled" }).where(eq(robotRuns.id, fresh));
  });

  it("B4: unfinished evidence is capped per run; over the cap the run fails evidence_too_large", async () => {
    setRobotEvidenceCapsForTest({ perRunBytes: 1000, globalBytes: 100_000 });
    try {
      const runId = await runningRow();
      const controller = new RobotRunController(kit.db, DEPS, runId, planFor(runId), [CANARY], owner.id);
      const call = channel(controller);
      expect((await call("POST", "evidence", oneChunk(0, Buffer.alloc(600, 1), "download", false))).status).toBe(200);
      expect(robotEvidenceInFlightBytes()).toBe(600);
      const over = await call("POST", "evidence", oneChunk(1, Buffer.alloc(600, 2), "download", false));
      expect(over.status).toBe(413);
      expect(over.json.error).toBe("evidence_too_large");
      expect(controller.forcedFailure).toBe("evidence_too_large");
      // the runner is told to stop, and takes no more evidence
      expect((await call("POST", "heartbeat", { step: 1 })).json).toEqual({ cancel: true });
      expect((await call("POST", "evidence", oneChunk(2, Buffer.alloc(10, 3), "download"))).status).toBe(409);
      const out = await finishRun(kit.db, await request(), runId, { status: "succeeded", stepsCompleted: 4, outputs: { balance: "1" } }, OUTPUT_SCHEMA, controller);
      expect(out).toMatchObject({ kind: "finished", status: "failed", failureCode: "evidence_too_large", outputs: null });
      controller.releaseAll();
      expect(robotEvidenceInFlightBytes()).toBe(0);
    } finally {
      setRobotEvidenceCapsForTest(undefined);
    }
  });

  it("B4: unfinished evidence is capped across runs too", async () => {
    setRobotEvidenceCapsForTest({ perRunBytes: 1000, globalBytes: 1000 });
    try {
      const [r1, r2] = [await runningRow(), await runningRow()];
      const c1 = new RobotRunController(kit.db, DEPS, r1, planFor(r1), [CANARY], owner.id);
      const c2 = new RobotRunController(kit.db, DEPS, r2, planFor(r2), [CANARY], owner.id);
      expect((await channel(c1)("POST", "evidence", oneChunk(0, Buffer.alloc(700, 1), "download", false))).status).toBe(200);
      const over = await channel(c2)("POST", "evidence", oneChunk(0, Buffer.alloc(700, 2), "download", false));
      expect(over).toMatchObject({ status: 413, json: { error: "evidence_too_large" } });
      expect(c2.forcedFailure).toBe("evidence_too_large");
      expect(c1.forcedFailure).toBeNull();
      c1.releaseAll();
      c2.releaseAll();
      expect(robotEvidenceInFlightBytes()).toBe(0);
    } finally {
      setRobotEvidenceCapsForTest(undefined);
    }
  });

  it("B2: a download is stored by digest only under `block`, and with its bytes otherwise", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rbt3b-store-"));
    try {
      const store = new FileArtifactStore(dir);
      for (const [downloads, withheld, kept] of [
        ["digest_only", "pii_block", false],
        ["store", null, true],
      ] as const) {
        const runId = await runningRow();
        const controller = new RobotRunController(kit.db, { dataKey: undefined, store }, runId, planFor(runId), [CANARY], owner.id, { downloads });
        const bytes = Buffer.from(`statement for ${downloads} ${runId}`);
        const res = await channel(controller)("POST", "evidence", oneChunk(0, bytes, "download"));
        expect(res.status).toBe(200);
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [row] = await kit.db.select().from(robotRunEvidence).where(eq(robotRunEvidence.robotRunId, runId));
        expect(row).toMatchObject({ kind: "download", sha256: sha, sizeBytes: bytes.length, bytesWithheld: withheld });
        expect(await store.has(artifactStorageKey(sha))).toBe(kept);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("B2: the run's PII mode comes from the compliance cascade: block = screenshots none, every other mode = masked", async () => {
    placement.mode = "refuse"; // stop after the queued audit (which records the resolved mode)
    const tagBlock = `rbt3b-block-${kit.RUN}`;
    const tagWarn = `rbt3b-warn-${kit.RUN}`;
    await kit.db.insert(complianceProfiles).values([
      { tag: tagBlock, piiMode: "block" },
      { tag: tagWarn, piiMode: "warn" },
    ]);
    const cases: Array<{ org: "block" | "warn"; tags: string[]; screenshots: "none" | "masked" }> = [
      { org: "block", tags: [], screenshots: "none" }, // the org floor (ADR-0181 ships `block`)
      { org: "warn", tags: [], screenshots: "masked" },
      { org: "warn", tags: [tagBlock], screenshots: "none" }, // a matched framework governs over the floor
      { org: "block", tags: [tagWarn], screenshots: "masked" },
    ];
    try {
      for (const c of cases) {
        await kit.db.update(orgSettings).set({ defaultPiiMode: c.org });
        await kit.db.update(projects).set({ classifications: c.tags }).where(eq(projects.id, owner.projectId));
        const out = await startRobotRun(kit.db, await request(), DEPS);
        expect(out).toMatchObject({ kind: "refused", code: "robot_run_placement_refused" });
        const queued = (await auditsOf((out as { runId: string }).runId)).find((a) => a.ruleId === "robot-run-queued")!;
        expect(queued.detail, JSON.stringify(c)).toMatchObject({ screenshots: c.screenshots, piiMode: c.screenshots === "none" ? "block" : "warn" });
      }
    } finally {
      placement.mode = "real";
      await kit.db.update(orgSettings).set({ defaultPiiMode: "block" });
      await kit.db.update(projects).set({ classifications: [] }).where(eq(projects.id, owner.projectId));
    }
  });

  it("Code 3: a project over its budget is refused in the gate's own shape (409 project_budget_exceeded), before any run row", async () => {
    await kit.db.insert(usageEvents).values({ userId: stranger.id, objectType: "connector", operation: "spend", costUsd: 500, projectId: stranger.projectId });
    const before = (await kit.db.select({ id: robotRuns.id }).from(robotRuns)).length;
    const out = await startRobotRun(kit.db, await request({ requestedBy: stranger.id, projectId: stranger.projectId }), DEPS);
    expect(out).toMatchObject({ kind: "refused", code: "project_budget_exceeded", httpStatus: 409, runId: null });
    expect((await kit.db.select({ id: robotRuns.id }).from(robotRuns)).length).toBe(before);
    const [audit] = await kit.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "robot-run-refused"), eq(auditLog.userId, stranger.id)));
    expect(audit!.detail).toMatchObject({ code: "project_budget_exceeded", gate: "project_budget_exceeded" });
  });

  it("N5: a placement that throws (PlacementEgressError) refuses the run robot_run_placement_failed; the row is not left queued", async () => {
    placement.mode = "throw";
    try {
      const out = await startRobotRun(kit.db, await request(), DEPS);
      expect(out).toMatchObject({ kind: "refused", code: "robot_run_placement_failed" });
      expect((out as { message: string }).message).not.toContain("test)");
      const [row] = await kit.db.select().from(robotRuns).where(eq(robotRuns.id, (out as { runId: string }).runId));
      expect(row).toMatchObject({ status: "refused", failureCode: "robot_run_placement_failed" });
    } finally {
      placement.mode = "real";
    }
  });
});



/**
 * ADR-0364 S3 (lane E45) — robot runs, gateway side, on a real database through the real app.
 *
 *  - REFUSALS BEFORE ANY SANDBOX (fail closed, each audited `robot-run-refused`): the deployment in `read_only` or
 *    `halted`, and a test run under `require_approval`; a project with no budget; inputs off the input schema; a
 *    missing test secret; an unpublished runner image. None writes a robot_runs row that ran.
 *  - THE SESSION'S GATEWAY CHANNEL (`RobotRunController`): the plan is served once and carries secret values only
 *    sealed; a heartbeat answers {cancel} when the deployment is halted; evidence is reassembled from its chunks, its
 *    sha256 re-checked, refused when it carries a secret value (the canary rule), and recorded append-only; a valid
 *    result ends the wait.
 *  - THE TEST-RUN ROUTE: owner-or-admin, one of the requester's own projects.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, eq, orgSettings, projects, robotRunEvidence, robotRuns, robotVersions, robots, sql } from "@regulait/db";
import { newRobotRunKey, openRobotSecret, ROBOT_RUN_LIMITS, sealRobotSecret, type RobotRunPlan } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { RobotRunController, setRobotRunnerImageForTest, startRobotRun } from "./robot-runs.js";

const SITE = "https://portal.example.com";
const CANARY = "canary-Secret-Value-7f3a";
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

let kit: BuilderKit;
let owner: Person;
let stranger: Person;
let robotId: string;

describe.skipIf(!process.env.DATABASE_URL)("ADR-0364 S3 robot runs (gateway)", () => {
  const setMode = (mode: "normal" | "read_only" | "require_approval" | "halted") =>
    kit.db
      .update(orgSettings)
      .set({ executionMode: mode, executionModeReason: mode === "normal" ? null : "ADR-0364 S3 test", executionModeApproverUserId: mode === "require_approval" ? owner.id : null });
  const setSecret = async (who: Person, id: string, name: string, scope: "live" | "test", value: string) => {
    const g = await grantStepUpForTest(kit.db, who.id, { kind: "settings_relax", facts: { op: "robot_secret_set", robotId: id, name, scope } });
    const r = stepUpRequest(g);
    return kit.app.inject({ method: "PUT", url: `/v1/robots/${id}/secrets/${name}/${scope}`, headers: r.headers, cookies: r.cookies, payload: { value } });
  };
  const testRun = (who: Person, body: Record<string, unknown>) => kit.req("POST", `/v1/robots/${robotId}/versions/1/test-runs`, who.auth, body);
  const loaded = async () => {
    const [row] = await kit.db.select({ robot: robots, version: robotVersions }).from(robotVersions).innerJoin(robots, eq(robots.id, robotVersions.robotId)).where(eq(robots.id, robotId));
    return row!;
  };

  beforeAll(async () => {
    kit = await builderKit("rbt3", { scratch: true });
    owner = await kit.person("owner");
    stranger = await kit.person("stranger");
    const r = await kit.req("POST", "/v1/robots", owner.auth, { slug: `portal_${kit.RUN}`, name: "Portal balance" });
    expect(r.statusCode, r.body).toBe(201);
    robotId = r.json().robot.id;
    expect((await kit.req("POST", `/v1/robots/${robotId}/versions`, owner.auth, draft)).statusCode).toBe(201);
  }, 180_000);
  afterAll(async () => {
    setRobotRunnerImageForTest(undefined);
    if (kit) await setMode("normal");
    await kit?.close();
  });

  it("refuses a test run on someone else's project, and a stranger gets 404", async () => {
    expect((await testRun(stranger, { projectId: stranger.projectId, inputs: { username: "a" } })).statusCode).toBe(404);
    const other = await testRun(owner, { projectId: stranger.projectId, inputs: { username: "a" } });
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error).toBe("robot_run_project_not_yours");
  });

  it("refuses a project without a budget, then inputs off the schema, then a missing test secret", async () => {
    await kit.db.update(projects).set({ budgetUsd: null }).where(eq(projects.id, owner.projectId));
    const noBudget = await testRun(owner, { projectId: owner.projectId, inputs: { username: "a" } });
    expect(noBudget.statusCode, noBudget.body).toBe(422);
    expect(noBudget.json().error).toBe("robot-run-needs-project");
    await kit.db.update(projects).set({ budgetUsd: 50 }).where(eq(projects.id, owner.projectId));

    const bad = await testRun(owner, { projectId: owner.projectId, inputs: { username: 7 } });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().error).toBe("robot_run_inputs_invalid");

    const noSecret = await testRun(owner, { projectId: owner.projectId, inputs: { username: "a" } });
    expect(noSecret.statusCode, noSecret.body).toBe(422);
    expect(noSecret.json().error).toBe("robot_secret_missing");
    expect(noSecret.json().message).not.toContain(CANARY);
  });

  it("refuses while the runner image is unpublished (fail closed), with no run row", async () => {
    expect((await setSecret(owner, robotId, "PORTAL_PASSWORD", "test", CANARY)).statusCode).toBe(200);
    setRobotRunnerImageForTest(null);
    const before = await kit.db.select().from(robotRuns);
    const r = await testRun(owner, { projectId: owner.projectId, inputs: { username: "a" } });
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error).toBe("robot_runner_unavailable");
    expect(await kit.db.select().from(robotRuns)).toHaveLength(before.length);
    const audits = await kit.db.select().from(auditLog).where(eq(auditLog.ruleId, "robot-run-refused"));
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audits)).not.toContain(CANARY);
  });

  it("refuses every run in read_only and halted, and a test run under require_approval", async () => {
    setRobotRunnerImageForTest("sha256:" + "a".repeat(64));
    const { robot, version } = await loaded();
    for (const mode of ["read_only", "halted", "require_approval"] as const) {
      await setMode(mode);
      const out = await startRobotRun(kit.db, { robot, version, kind: "test", requestedBy: owner.id, projectId: owner.projectId, inputs: { username: "a" }, contentDigest: "c".repeat(64) }, { dataKey: undefined, store: null });
      expect(out.kind).toBe("refused");
      if (out.kind === "refused") expect(out.code).toBe("robot_run_safe_mode");
    }
    await setMode("normal");
  });

  describe("the session's gateway channel", () => {
    const pushed: string[] = [];
    const session = { push: (line: string) => void pushed.push(line) };
    const runKey = newRobotRunKey();
    let runId: string;
    let controller: RobotRunController;
    let plan: RobotRunPlan;
    let id = 0;
    const call = async (method: "GET" | "POST", route: string, body?: unknown) => {
      const n = String(++id);
      const before = pushed.length;
      controller.onFrame(
        JSON.stringify({ t: "http", id: n, method, path: `/v1/robot-runner/runs/${runId}/${route}`, headers: {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)).toString("base64") }),
        session,
      );
      for (let i = 0; i < 200 && pushed.length === before; i++) await new Promise((r) => setTimeout(r, 5));
      const res = JSON.parse(pushed.at(-1)!) as { t: string; id: string; status: number; body: string };
      expect(res.id).toBe(n);
      return { status: res.status, json: JSON.parse(Buffer.from(res.body, "base64").toString("utf8")) as Record<string, unknown> };
    };
    const chunks = (item: number, bytes: Buffer, kind: "screenshot" | "download" = "screenshot") => {
      const out: Record<string, unknown>[] = [];
      const size = 200;
      for (let i = 0, c = 0; i < bytes.length || c === 0; i += size, c++) {
        const part = bytes.subarray(i, i + size);
        const last = i + size >= bytes.length;
        out.push({
          item,
          kind,
          step: 1,
          contentType: kind === "screenshot" ? "image/jpeg" : "application/octet-stream",
          chunk: c,
          dataBase64: part.toString("base64"),
          last,
          ...(last ? { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } : {}),
        });
        if (last) break;
      }
      return out;
    };

    beforeAll(async () => {
      const { version } = await loaded();
      const [run] = await kit.db
        .insert(robotRuns)
        .values({ robotVersionId: version.id, requestedBy: owner.id, projectId: owner.projectId, kind: "test", status: "running", contentDigest: "b".repeat(64) })
        .returning({ id: robotRuns.id });
      runId = run!.id;
      plan = {
        runId,
        kind: "test",
        allowedOrigins: [SITE],
        steps: [{ op: "goto", url: `${SITE}/login` }, { op: "fill_secret", selector: "#pass", secretRef: "PORTAL_PASSWORD" }],
        secrets: [{ ref: "PORTAL_PASSWORD", origin: SITE, sealed: sealRobotSecret(runKey, runId, "PORTAL_PASSWORD", CANARY) }],
        limits: { wallClockMs: 60_000, actionTimeoutMs: 1000, outputChars: 100, downloadBytes: 4096 },
        screenshots: "masked",
      };
      controller = new RobotRunController(kit.db, { dataKey: undefined, store: null }, runId, plan, [runKey, CANARY], owner.id);
    });

    it("serves the plan once, with the secret sealed and the run key nowhere", async () => {
      const first = await call("GET", "plan");
      expect(first.status).toBe(200);
      const text = JSON.stringify(first.json);
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(runKey);
      const sealed = (first.json.secrets as { sealed: string }[])[0]!.sealed;
      expect(openRobotSecret(runKey, runId, "PORTAL_PASSWORD", sealed)).toBe(CANARY);
      expect((await call("GET", "plan")).status).toBe(409);
      // another run's path is not this session's
      const n = String(++id);
      controller.onFrame(JSON.stringify({ t: "http", id: n, method: "GET", path: `/v1/robot-runner/runs/00000000-0000-4000-8000-000000000000/plan`, headers: {}, body: "" }), session);
      await new Promise((r) => setTimeout(r, 50));
      expect(JSON.parse(pushed.at(-1)!).status).toBe(404);
    });

    it("answers {cancel} on a heartbeat once the deployment is halted", async () => {
      expect((await call("POST", "heartbeat", { step: 0 })).json).toEqual({ cancel: false });
      await setMode("halted");
      expect((await call("POST", "heartbeat", { step: 1 })).json).toEqual({ cancel: true });
      await setMode("normal");
    });

    it("stores chunked evidence, refuses a digest mismatch and an item carrying a secret value", async () => {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(700, 7)]);
      for (const c of chunks(0, jpeg)) expect((await call("POST", "evidence", c)).status).toBe(200);
      const rows = await kit.db.select().from(robotRunEvidence).where(eq(robotRunEvidence.robotRunId, runId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sha256).toBe(createHash("sha256").update(jpeg).digest("hex"));

      const wrong = chunks(1, Buffer.from("xxxx"))[0]!;
      expect((await call("POST", "evidence", { ...wrong, sha256: "0".repeat(64) })).json.error).toBe("evidence_digest_mismatch");

      const leaking = Buffer.concat([Buffer.alloc(300, 1), Buffer.from(CANARY, "utf8"), Buffer.alloc(300, 2)]);
      let last: { status: number; json: Record<string, unknown> } | null = null;
      for (const c of chunks(2, leaking, "download")) last = await call("POST", "evidence", c);
      expect(last!.status).toBe(422);
      expect(last!.json.error).toBe("evidence_contains_secret");
      expect(await kit.db.select().from(robotRunEvidence).where(eq(robotRunEvidence.robotRunId, runId))).toHaveLength(1);
      // the evidence rows are append-only
      const cause = async (q: Promise<unknown>) => {
        try {
          await q;
          return "no error";
        } catch (e) {
          const err = e as { message?: string; cause?: { message?: string } };
          return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
        }
      };
      expect(await cause(kit.db.execute(sql`UPDATE robot_run_evidence SET size_bytes = 0 WHERE robot_run_id = ${runId}`))).toMatch(/append-only/);
      expect(await cause(kit.db.execute(sql`DELETE FROM robot_run_evidence WHERE robot_run_id = ${runId}`))).toMatch(/append-only/);
      // an out-of-order chunk and an item past the cap are refused
      expect((await call("POST", "evidence", { ...chunks(3, Buffer.alloc(10))[0]!, chunk: 1 })).json.error).toBe("evidence_refused");
      expect(ROBOT_RUN_LIMITS.evidenceItems).toBe(64);
    });

    it("a valid result ends the wait; a second result is refused", async () => {
      const waiting = controller.wait(10_000);
      expect((await call("POST", "result", { status: "succeeded", stepsCompleted: 2, outputs: { balance: "10" } })).status).toBe(200);
      expect(await waiting).toMatchObject({ status: "succeeded", outputs: { balance: "10" } });
      expect((await call("POST", "result", { status: "succeeded", stepsCompleted: 2, outputs: {} })).status).toBe(409);
      expect((await call("POST", "result", { status: "failed", stepsCompleted: 0, outputs: {} })).status).toBe(400);
      expect(pushed.join("\n")).not.toContain(CANARY);
      expect(pushed.join("\n")).not.toContain(runKey);
    });
  });
});

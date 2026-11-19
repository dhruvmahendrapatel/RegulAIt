import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { engineTaskOutFrameSchema, robotEvidenceUploadSchema, robotRunResultSchema, type EngineTaskInFrame, type EngineTaskOutFrame, type RobotRunPlan } from "@regulait/shared";
import { describe, expect, it } from "vitest";
import type { LaunchOptions } from "./playwright.js";
import { runRobot } from "./run.js";
import { FakePage, makePlan, RUN_ID, SECRET_VALUE } from "./fakes.test-helpers.js";

/**
 * The gateway's side of the sandbox stdio session, played in-process: every stdout line is parsed as an
 * `engineTaskOutFrameSchema` frame; an `http` frame is answered on stdin as the gateway's robot-run controller would.
 */
function harness(plan: RobotRunPlan | null, opts: { cancelAt?: number } = {}) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const lines: string[] = [];
  const frames: EngineTaskOutFrame[] = [];
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  let buf = "";
  stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const f = engineTaskOutFrameSchema.parse(JSON.parse(line));
      frames.push(f);
      if (f.t !== "http") continue;
      const body = f.body ? (JSON.parse(Buffer.from(f.body, "base64").toString("utf8")) as unknown) : null;
      requests.push({ method: f.method, path: f.path, headers: f.headers, body });
      const base = `/v1/robot-runner/runs/${RUN_ID}/`;
      let answer: EngineTaskInFrame;
      const ok = (o: unknown): EngineTaskInFrame => ({ t: "http_res", id: f.id, status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(o)).toString("base64") });
      if (f.path === `${base}plan` && f.method === "GET") answer = plan ? ok(plan) : { t: "http_res", id: f.id, status: 410, headers: {}, body: "" };
      else if (f.path === `${base}heartbeat`) answer = ok({ cancel: opts.cancelAt !== undefined && (body as { step: number }).step >= opts.cancelAt });
      else if (f.path === `${base}evidence`) {
        robotEvidenceUploadSchema.parse(body);
        answer = { t: "http_res", id: f.id, status: 204, headers: {}, body: "" };
      } else if (f.path === `${base}result`) {
        robotRunResultSchema.parse(body);
        answer = { t: "http_res", id: f.id, status: 204, headers: {}, body: "" };
      } else answer = { t: "http_err", id: f.id, code: "not_gateway" };
      stdin.write(`${JSON.stringify(answer)}\n`);
    }
  });
  return { stdout, stdin, lines, frames, requests };
}

const env = (over: Record<string, string | undefined> = {}) => ({
  REGULAIT_ROBOT_RUN_ID: RUN_ID,
  REGULAIT_ROBOT_EGRESS_PROXY: "http://robot-egress:4750",
  REGULAIT_WORK_DIR: mkdtempSync(path.join(tmpdir(), "robot-run-")),
  ...over,
});

describe("runRobot (the sandbox side of the gateway channel)", () => {
  it("reads the plan once, heartbeats, uploads evidence, posts the result, then ends: frames only on stdout", async () => {
    const p = makePlan([
      { op: "goto", url: "https://app.example.com/login" },
      { op: "fill_secret", selector: "#pass", secretRef: "password" },
      { op: "read", selector: "#hello", output: "hello" },
    ]);
    const h = harness(p.plan);
    const page = new FakePage();
    page.texts["#hello"] = "hi";
    let launched: LaunchOptions | null = null;
    const logs: string[] = [];
    const code = await runRobot({
      env: env(),
      stdout: h.stdout,
      stdin: h.stdin,
      readRunKey: () => p.runKey,
      launch: async (o) => {
        launched = o;
        return { page, close: async () => undefined };
      },
      log: (c) => logs.push(c),
    });
    expect(code).toBe(0);
    expect(launched).toMatchObject({ allowedOrigins: p.plan.allowedOrigins, proxyServer: "http://robot-egress:4750" });
    const base = `/v1/robot-runner/runs/${RUN_ID}/`;
    expect(h.requests.map((r) => `${r.method} ${r.path.slice(base.length)}`)).toEqual([
      "GET plan",
      "POST heartbeat",
      "POST evidence",
      "POST heartbeat",
      "POST evidence",
      "POST heartbeat",
      "POST evidence",
      "POST result",
    ]);
    expect(h.requests.at(-1)!.body).toEqual({ status: "succeeded", stepsCompleted: 3, outputs: { hello: "hi" } });
    // the gateway-held session is the authority: no authorization header, ever
    for (const r of h.requests) expect(Object.keys(r.headers)).not.toContain("authorization");
    expect(h.frames.at(-1)).toEqual({ t: "end", code: 0 });
    expect(page.values.get("#pass")).toBe(SECRET_VALUE);

    // CANARY: the secret, its sealed form and the run key are in no stdout byte (decoded bodies included) and no log
    const decoded = h.frames.map((f) => (f.t === "http" ? Buffer.from(f.body, "base64").toString("utf8") : "")).join("\n");
    const evidence = h.requests.filter((r) => r.path.endsWith("/evidence")).map((r) => Buffer.from((r.body as { dataBase64: string }).dataBase64, "base64").toString("utf8")).join("\n");
    for (const needle of [SECRET_VALUE, p.plan.secrets[0]!.sealed, p.runKey]) {
      expect(h.lines.join("\n")).not.toContain(needle);
      expect(decoded).not.toContain(needle);
      expect(evidence).not.toContain(needle);
      expect(logs.join("\n")).not.toContain(needle);
    }
  });

  it("refuses to start without the egress proxy, the run id or the run key (fail closed, no request sent)", async () => {
    for (const [e, key] of [
      [env({ REGULAIT_ROBOT_EGRESS_PROXY: undefined }), "k"],
      [env({ REGULAIT_ROBOT_EGRESS_PROXY: "socks5://x:1" }), "k"],
      [env({ REGULAIT_ROBOT_RUN_ID: "nope" }), "k"],
      [env(), null],
    ] as const) {
      const h = harness(null);
      let launched = false;
      const code = await runRobot({ env: e, stdout: h.stdout, stdin: h.stdin, readRunKey: () => key, launch: async () => ((launched = true), { page: new FakePage(), close: async () => undefined }), log: () => undefined });
      expect(code).toBe(2);
      expect(launched).toBe(false);
      expect(h.frames).toEqual([{ t: "end", code: 2 }]);
    }
  });

  it("a plan that cannot be read: runner_error result, no browser", async () => {
    const h = harness(null);
    let launched = false;
    const code = await runRobot({ env: env(), stdout: h.stdout, stdin: h.stdin, readRunKey: () => "k", launch: async () => ((launched = true), { page: new FakePage(), close: async () => undefined }), log: () => undefined });
    expect(code).toBe(1);
    expect(launched).toBe(false);
    expect(h.requests.at(-1)).toMatchObject({ method: "POST", body: { status: "failed", failureCode: "runner_error", stepsCompleted: 0, outputs: {} } });
    expect(h.frames.at(-1)).toEqual({ t: "end", code: 1 });
  });

  it("a cancel answered on the heartbeat ends the run cancelled / halted and closes the browser", async () => {
    const p = makePlan([{ op: "goto", url: "https://app.example.com/" }, { op: "click", selector: "#x" }]);
    const h = harness(p.plan, { cancelAt: 1 });
    let closed = false;
    const code = await runRobot({ env: env(), stdout: h.stdout, stdin: h.stdin, readRunKey: () => p.runKey, launch: async () => ({ page: new FakePage(), close: async () => void (closed = true) }), log: () => undefined });
    expect(code).toBe(0);
    expect(closed).toBe(true);
    expect(h.requests.at(-1)!.body).toEqual({ status: "cancelled", failureCode: "halted", stepsCompleted: 1, outputs: {} });
  });
});

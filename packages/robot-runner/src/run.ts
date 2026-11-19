/**
 * ADR-0364 S3 — ONE ROBOT RUN, start to end, inside its robot_browser sandbox (the image's entry point, `main.ts`).
 *
 *   1. fail closed before anything else: the run id (REGULAIT_ROBOT_RUN_ID), the run's Smokescreen
 *      (REGULAIT_ROBOT_EGRESS_PROXY, `http://host:port`) and the run key (fd 3, read once, the engine tasks' task-secret
 *      release) must all be present;
 *   2. open the gateway channel (stdout `http` frames, stdin answers) and read the plan once;
 *   3. launch the browser through the proxy, execute the plan (`executor.ts`), post the result;
 *   4. close the browser and the channel, write the `end` frame, exit 0 (1 when the result could not be delivered).
 *
 * stdout carries frames and nothing else; stderr gets fixed status codes only (never page text, a value or a key).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { frameWriter, openGatewayChannel, readTaskSecretFd } from "@regulait/engine-runner/worker";
import type { RobotRunResult } from "@regulait/shared";
import { RobotGatewayClient } from "./channel.js";
import { runRobotPlan } from "./executor.js";
import { launchRobotBrowser, type LaunchOptions, type RobotBrowser } from "./playwright.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROXY = /^http:\/\/[A-Za-z0-9.-]+:\d{1,5}$/;

export interface RobotRunnerDeps {
  env: Readonly<Record<string, string | undefined>>;
  stdout: Writable;
  stdin: Readable;
  readRunKey?: () => string | null;
  launch?: (o: LaunchOptions) => Promise<RobotBrowser>;
  /** a fixed status code to stderr */
  log?: (code: string) => void;
  /** test seam: a gateway channel request's bound (default 120 s) */
  httpTimeoutMs?: number;
}

const runnerError = (): RobotRunResult => ({ status: "failed", failureCode: "runner_error", stepsCompleted: 0, outputs: {} });

export async function runRobot(deps: RobotRunnerDeps): Promise<number> {
  const log = deps.log ?? ((c: string) => void process.stderr.write(`robot-runner: ${c}\n`));
  const write = frameWriter(deps.stdout);
  const runId = deps.env.REGULAIT_ROBOT_RUN_ID ?? "";
  const proxyServer = deps.env.REGULAIT_ROBOT_EGRESS_PROXY ?? "";
  if (!UUID.test(runId) || !PROXY.test(proxyServer)) {
    log("refused: REGULAIT_ROBOT_RUN_ID and REGULAIT_ROBOT_EGRESS_PROXY (http://host:port) are required");
    await write({ t: "end", code: 2 });
    return 2;
  }
  let runKey: string | null = (deps.readRunKey ?? readTaskSecretFd)();
  if (runKey === null) {
    log("refused: no run key on fd 3");
    await write({ t: "end", code: 2 });
    return 2;
  }
  const channel = await openGatewayChannel({ write, stdin: deps.stdin, timeoutMs: deps.httpTimeoutMs ?? 120_000 });
  const gateway = new RobotGatewayClient(channel.origin, runId);
  let code = 0;
  let browser: RobotBrowser | null = null;
  try {
    let plan;
    try {
      plan = await gateway.plan();
    } catch {
      log("plan: not read");
      await gateway.result(runnerError());
      return (code = 1);
    }
    try {
      const work = deps.env.REGULAIT_WORK_DIR || "/work";
      const downloadsPath = path.join(work, "downloads");
      await mkdir(downloadsPath, { recursive: true, mode: 0o700 });
      const executablePath = deps.env.REGULAIT_ROBOT_CHROMIUM;
      browser = await (deps.launch ?? launchRobotBrowser)({ allowedOrigins: plan.allowedOrigins, proxyServer, downloadsPath, ...(executablePath ? { executablePath } : {}) });
    } catch {
      log("browser: not launched");
      await gateway.result(runnerError());
      return (code = 1);
    }
    const result = await runRobotPlan(plan, { page: browser.page, gateway, runKey });
    log(`run ${result.status}${result.failureCode ? ` ${result.failureCode}` : ""}`);
    return code;
  } catch {
    // the result could not be delivered (the gateway ends the run on its own clock)
    log("result: not delivered");
    return (code = 1);
  } finally {
    runKey = null;
    await browser?.close();
    channel.close();
    await write({ t: "end", code });
  }
}

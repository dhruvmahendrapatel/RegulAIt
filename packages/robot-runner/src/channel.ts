/**
 * ADR-0364 S3 — the robot run's four gateway requests, sent to the sandbox's gateway channel
 * (`openGatewayChannel`, @regulait/engine-runner/worker): each request becomes one `http` stdout frame
 * (`engineTaskOutFrameSchema`) that the GATEWAY's own stdio session for this sandbox answers in-process with an
 * `http_res` / `http_err` stdin frame (`engineTaskInFrameSchema`). Nothing on a trusted side forwards these paths.
 *
 *   GET  /v1/robot-runner/runs/:runId/plan       → 200 robotRunPlanSchema
 *   POST /v1/robot-runner/runs/:runId/heartbeat  robotHeartbeatSchema → 200 robotHeartbeatResponseSchema
 *   POST /v1/robot-runner/runs/:runId/evidence   robotEvidenceUploadSchema (one chunk) → 2xx
 *   POST /v1/robot-runner/runs/:runId/result     robotRunResultSchema → 2xx
 *
 * No `authorization` header and no run key: the gateway-held session is the authority. Errors carry fixed text only.
 */
import {
  robotEvidenceUploadSchema,
  robotHeartbeatResponseSchema,
  robotHeartbeatSchema,
  robotRunPlanSchema,
  robotRunResultSchema,
  type RobotEvidenceUpload,
  type RobotRunPlan,
  type RobotRunResult,
} from "@regulait/shared";
import type { RobotGateway } from "./executor.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RobotChannelError extends Error {}

export class RobotGatewayClient implements RobotGateway {
  private readonly base: string;
  constructor(
    origin: string,
    readonly runId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!UUID.test(runId)) throw new RobotChannelError("not a run id");
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) throw new RobotChannelError("not a loopback gateway channel");
    this.base = `${origin}/v1/robot-runner/runs/${runId}`;
  }

  private async call(method: "GET" | "POST", name: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${name}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch {
      throw new RobotChannelError(`${name}: the gateway channel failed`);
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => undefined);
      throw new RobotChannelError(`${name}: the gateway answered ${res.status}`);
    }
    const text = await res.text();
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RobotChannelError(`${name}: not JSON`);
    }
  }

  /** the plan, read once; it must name this run */
  async plan(): Promise<RobotRunPlan> {
    const p = robotRunPlanSchema.safeParse(await this.call("GET", "plan"));
    if (!p.success || p.data.runId !== this.runId) throw new RobotChannelError("plan: not this run's plan");
    return p.data;
  }

  async heartbeat(step: number): Promise<{ cancel: boolean }> {
    const r = robotHeartbeatResponseSchema.safeParse(await this.call("POST", "heartbeat", robotHeartbeatSchema.parse({ step })));
    // an answer the runner cannot read is a cancel (fail closed)
    return r.success ? r.data : { cancel: true };
  }

  async evidence(chunk: RobotEvidenceUpload): Promise<void> {
    await this.call("POST", "evidence", robotEvidenceUploadSchema.parse(chunk));
  }

  async result(result: RobotRunResult): Promise<void> {
    await this.call("POST", "result", robotRunResultSchema.parse(result));
  }
}

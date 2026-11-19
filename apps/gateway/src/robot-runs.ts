/**
 * ADR-0364 S3 (lane E45) — ROBOT RUNS, gateway side. One run of one robot version, in one `robot_browser` sandbox.
 *
 *   startRobotRun(db, req)  the only way a run starts: from a governed tools/call on the Robots server (kind `agent`)
 *                           or the author's test run (kind `test`). In order, every refusal recorded and fail-closed:
 *     1. the kill switch and safe modes (ADR-0124/0139): a robot run is an EXTERNAL WRITE, so `read_only` and
 *        `halted` refuse it; a test run is refused under `require_approval` too (no approval path queues it);
 *     2. attribution (§5): a run needs a project, and a project with a budget (`robot-run-needs-project`);
 *     3. the inputs are validated against the version's input schema (Ajv, the repo's validator);
 *     4. the secrets for the run's scope (live for an agent run, test for a test run) are opened from their
 *        ADR-0204 envelopes and SEALED under a fresh run key (`sealRobotSecret`), so no frame carries a value;
 *     5. the runner image is the digest-pinned `robot-runner` entry of the images lock; unpublished = refused;
 *     6. decision 7 places a `robot_browser` workload with the version's egress targets (the executor builds the
 *        run's Smokescreen ACL from them, §7). Any refusal ends the run `refused`.
 *   The run key reaches the sandbox only through the task-scoped release (the MACed `start` line → fd 3).
 *
 *   THE SESSION. The gateway holds the run's stdio session (the I4 pattern) and answers the runner's gateway-channel
 *   requests (`http` frames, `robots-run.ts`) in-process: the plan (once), heartbeats (`{cancel}` when the kill
 *   switch is thrown or the wall clock is spent), evidence chunks and the result. No runner credential exists.
 *
 *   EVIDENCE (§7). Each item is reassembled from its chunks, its size and sha256 re-checked, and refused if any byte
 *   sequence of a secret value or the run key appears in it (the canary rule), then stored content-addressed in the
 *   artifact store and recorded in `robot_run_evidence` (append-only). No store configured = no evidence is kept, and
 *   the run still records its outcome (screenshots are evidence, not the result).
 *
 *   OUTPUTS are validated against the version's output schema before they are returned, and returned to the agent
 *   as untrusted tool output (§7). Outputs are never stored.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  and,
  auditLog,
  eq,
  projects,
  robotRunEvidence,
  robotRuns,
  robots,
  robotSecrets,
  robotVersionAllowedSites,
  robotVersionSecrets,
  robotVersions,
  runWithRlsSystem,
  type Db,
  type RobotRow,
  type RobotVersionRow,
} from "@regulait/db";
import {
  ENGINE_IMAGES_LOCK,
  ROBOT_RUN_LIMITS,
  ROBOT_RUN_MACHINE,
  compileRobotPlanSteps,
  engineTaskOutFrameSchema,
  newRobotRunKey,
  robotEgressTargets,
  robotEvidenceUploadSchema,
  robotHeartbeatSchema,
  robotRunResultSchema,
  sealRobotSecret,
  validateStepsScript,
  type RobotRunPlan,
  type RobotRunResult,
} from "@regulait/shared";
import { loadExecutionMode } from "./execution-posture.js";
import { decidePlacement, type PlacementRequest } from "./execution-placement.js";
import { awaitPlacement, cancelOffer } from "./executor-channel.js";
import { endStdioSession, holdStdioSession, StdioSession, useRelayDb, watchHeldStdioSession } from "./executor-stdio.js";
import { artifactStorageKey, type ArtifactStore } from "./model-artifacts.js";
import { validateOutputAgainstSchema } from "./playground.js";
import { decryptSecret } from "./secrets.js";
import { whereFrom } from "./state-transition.js";

/** the runner's entry point inside the robot-runner image (its fixed argv, sent to the sandbox init at release) */
export const ROBOT_RUNNER_WORKLOAD = { command: "/usr/local/bin/node", args: ["/app/robot-runner/dist/main.js"] } as const;
/** margin over the run's wall clock before the gateway withdraws a placement whose runner never reported */
const WALL_CLOCK_MARGIN_MS = 30_000;

export type RobotRunRefusal =
  | "robot_run_safe_mode"
  | "robot-run-needs-project"
  | "robot_run_inputs_invalid"
  | "robot_secret_missing"
  | "robot_runner_unavailable"
  | "robot_run_placement_refused"
  | "robot_version_not_runnable";

export type RobotRunOutcome =
  | { kind: "refused"; code: RobotRunRefusal; message: string; runId: string | null }
  | {
      kind: "finished";
      runId: string;
      status: "succeeded" | "failed" | "timed_out" | "cancelled";
      failureCode: string | null;
      /** validated against the output schema; present only for a succeeded run */
      outputs: Record<string, unknown> | null;
    };

export interface RobotRunRequest {
  robot: RobotRow;
  version: RobotVersionRow;
  kind: "test" | "agent";
  requestedBy: string;
  projectId: string | null;
  inputs: Record<string, unknown>;
  /** decision 7's agent and grant facts (the governed call's), absent for a test run */
  agent?: PlacementRequest["agent"];
  parentGrantId?: string | null;
  interactivePerson?: boolean;
  /** the agent a builder-agent run is for (robot_runs.agent_id) */
  builderAgentId?: string | null;
  /**
   * the content digest this run executes: the approved digest for an agent run, and for a test run the digest a
   * submit would bind now (`resolvedDigest`), so a passing test run proves exactly what the reviewer will approve
   */
  contentDigest: string;
}

export interface RobotRunDeps {
  dataKey: string | undefined;
  store: ArtifactStore | null;
  /** tests only: the executors decision 7 may use, and a shorter placement wait */
  onlyExecutorIds?: readonly string[];
  placementTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// the runner image (digest-pinned; unpublished = refused)
// ---------------------------------------------------------------------------

let imageOverride: string | null | undefined;
/** tests only: the runner image id (the images lock has none until the first publish) */
export function setRobotRunnerImageForTest(imageId: string | null | undefined): void {
  imageOverride = imageId;
}
export function robotRunnerImage(): string | null {
  if (imageOverride !== undefined) return imageOverride;
  const entry = (ENGINE_IMAGES_LOCK as Readonly<Record<string, { imageId: string | null } | undefined>>)["robot-runner"];
  return entry?.imageId ?? null;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function auditRun(db: Db, userId: string, runId: string, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow") {
  await db.insert(auditLog).values({ userId, objectType: "robot_run", objectId: runId, detail, effect, ruleId, ruleChain: [], reason });
}

async function refuse(
  db: Db,
  req: RobotRunRequest,
  code: RobotRunRefusal,
  message: string,
  runId: string | null = null,
): Promise<RobotRunOutcome> {
  if (runId) {
    await db
      .update(robotRuns)
      .set({ status: "refused", failureCode: code.replaceAll("-", "_"), finishedAt: new Date() })
      .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "refuse")));
  }
  await db.insert(auditLog).values({
    userId: req.requestedBy,
    objectType: runId ? "robot_run" : "robot_version",
    objectId: runId ?? req.version.id,
    detail: { robotId: req.robot.id, versionId: req.version.id, version: req.version.version, kind: req.kind, code },
    effect: "deny",
    ruleId: "robot-run-refused",
    ruleChain: [],
    reason: message,
  });
  return { kind: "refused", code, message, runId };
}

/** start one run and wait for its end (the caller is a governed tool call or a test-run request) */
export async function startRobotRun(db: Db, req: RobotRunRequest, deps: RobotRunDeps): Promise<RobotRunOutcome> {
  const { robot, version } = req;
  if (robot.status !== "active") return refuse(db, req, "robot_version_not_runnable", "The robot is retired; nothing ran.");
  if (req.kind === "agent" && version.status !== "approved") {
    return refuse(db, req, "robot_version_not_runnable", "Only an approved version runs for an agent; nothing ran.");
  }
  if (req.kind === "test" && !["draft", "in_review", "approved"].includes(version.status)) {
    return refuse(db, req, "robot_version_not_runnable", "A rejected or retired version is not run; nothing ran.");
  }

  // 1. the kill switch and safe modes: a robot run is an external write (§5)
  const mode = await loadExecutionMode(db);
  if (mode === "read_only" || mode === "halted" || (req.kind === "test" && mode === "require_approval")) {
    return refuse(db, req, "robot_run_safe_mode", `The deployment is in '${mode}' mode, which refuses robot runs (an external write). Nothing ran.`);
  }

  // 2. attribution: a project with a budget
  if (!req.projectId) return refuse(db, req, "robot-run-needs-project", "A robot run must be attributed to a project with a budget; nothing ran.");
  const [project] = await db.select({ id: projects.id, budgetUsd: projects.budgetUsd }).from(projects).where(eq(projects.id, req.projectId));
  if (!project || project.budgetUsd === null || project.budgetUsd === undefined) {
    return refuse(db, req, "robot-run-needs-project", "The run's project has no budget; a robot run needs one. Nothing ran.");
  }

  // 3. the inputs, then the steps (validated again: the digest proves the content, this proves the shape)
  const inputCheck = validateOutputAgainstSchema(version.inputSchema as Record<string, unknown>, JSON.stringify(req.inputs));
  if (!inputCheck.valid) {
    return refuse(db, req, "robot_run_inputs_invalid", `The inputs do not match the robot's input schema: ${inputCheck.errors.slice(0, 3).join("; ")}. Nothing ran.`);
  }
  const sites = await db
    .select({ origin: robotVersionAllowedSites.origin })
    .from(robotVersionAllowedSites)
    .where(eq(robotVersionAllowedSites.robotVersionId, version.id));
  const bindings = await db.select().from(robotVersionSecrets).where(eq(robotVersionSecrets.robotVersionId, version.id));
  const allowedOrigins = sites.map((s) => s.origin).sort();
  const steps = validateStepsScript(version.script, {
    allowedOrigins,
    secretNames: bindings.map((b) => b.name),
    inputSchema: version.inputSchema as Record<string, unknown>,
    outputSchema: version.outputSchema as Record<string, unknown>,
  });
  if (!steps.ok) return refuse(db, req, "robot_version_not_runnable", "The version's steps no longer validate; nothing ran.");

  // 4. the secrets of the run's scope, opened here and sealed under the run key below
  if (bindings.length > 0 && !deps.dataKey) return refuse(db, req, "robot_secret_missing", "No data key is configured, so no robot secret can be opened; nothing ran.");
  const opened: { ref: string; origin: string; value: string }[] = [];
  for (const b of bindings) {
    // an agent run uses the live secret the approval bound (its id is in the digest); a test run uses the robot's
    // test secret of that name (test secrets are not in the digest, and a draft's bindings carry no ids yet)
    const [row] =
      req.kind === "agent"
        ? b.liveSecretId
          ? await db.select({ valueCiphertext: robotSecrets.valueCiphertext }).from(robotSecrets).where(and(eq(robotSecrets.id, b.liveSecretId), eq(robotSecrets.robotId, robot.id), eq(robotSecrets.scope, "live")))
          : []
        : await db.select({ valueCiphertext: robotSecrets.valueCiphertext }).from(robotSecrets).where(and(eq(robotSecrets.robotId, robot.id), eq(robotSecrets.name, b.name), eq(robotSecrets.scope, "test")));
    if (!row) return refuse(db, req, "robot_secret_missing", `The ${req.kind === "agent" ? "live" : "test"} secret '${b.name}' is not set; nothing ran.`);
    opened.push({ ref: b.name, origin: b.origin, value: decryptSecret(deps.dataKey!, row.valueCiphertext) });
  }

  // 5. the runner image
  const imageDigest = robotRunnerImage();
  if (!imageDigest) return refuse(db, req, "robot_runner_unavailable", "The robot runner image is not published in this release; nothing ran.");

  // the run row (queued), then 6. decision 7
  const [run] = await db
    .insert(robotRuns)
    .values({
      robotVersionId: version.id,
      requestedBy: req.requestedBy,
      agentId: req.builderAgentId ?? null,
      projectId: req.projectId,
      kind: req.kind,
      contentDigest: req.contentDigest,
    })
    .returning({ id: robotRuns.id });
  const runId = run!.id;
  await auditRun(db, req.requestedBy, runId, "robot-run-queued", `Robot '${robot.slug}' version ${version.version} queued (${req.kind} run).`, {
    robotId: robot.id,
    versionId: version.id,
    version: version.version,
    kind: req.kind,
    projectId: req.projectId,
    contentDigest: req.contentDigest,
  });

  const targets = robotEgressTargets(allowedOrigins);
  const decision = await decidePlacement(db, {
    ...(deps.onlyExecutorIds ? { onlyExecutorIds: deps.onlyExecutorIds } : {}),
    workloadKind: "robot_browser",
    projectId: req.projectId,
    agent: req.agent ?? null,
    mcpServerId: null,
    parentGrantId: req.parentGrantId ?? null,
    interactivePerson: req.interactivePerson === true,
    imageDigest,
    actorUserId: req.requestedBy,
    egress: { targets },
  } as Parameters<typeof decidePlacement>[1]);
  if (decision.kind !== "offered") {
    const code = decision.kind === "refused" ? decision.code : "policy_unresolved";
    return refuse(db, req, "robot_run_placement_refused", `No sandbox could be placed for the run (${code}); nothing ran.`, runId);
  }

  const runKey = newRobotRunKey();
  const plan: RobotRunPlan = {
    runId,
    kind: req.kind,
    allowedOrigins,
    steps: compileRobotPlanSteps(steps.steps, req.inputs),
    secrets: opened.map((s) => ({ ref: s.ref, origin: s.origin, sealed: sealRobotSecret(runKey, runId, s.ref, s.value) })),
    limits: {
      wallClockMs: ROBOT_RUN_LIMITS.wallClockMs,
      actionTimeoutMs: ROBOT_RUN_LIMITS.actionTimeoutMs,
      outputChars: ROBOT_RUN_LIMITS.outputChars,
      downloadBytes: ROBOT_RUN_LIMITS.downloadBytes,
    },
    screenshots: "masked",
  };
  const controller = new RobotRunController(db, deps, runId, plan, [runKey, ...opened.map((s) => s.value)], req.requestedBy);
  const session = new StdioSession(decision.offerId, decision.executorId, { command: ROBOT_RUNNER_WORKLOAD.command, args: [...ROBOT_RUNNER_WORKLOAD.args] });
  session.secret = runKey;
  session.attached = true;
  session.onLine = (line) => controller.onFrame(line, session);
  session.onEnd = () => controller.sessionEnded();
  useRelayDb(db);
  if (!holdStdioSession(session)) {
    await cancelOffer(db, decision.offerId, "session_abandoned", { userId: req.requestedBy });
    return refuse(db, req, "robot_run_placement_refused", "The gateway holds its maximum of live sandbox sessions; nothing ran.", runId);
  }

  const placed = await awaitPlacement(db, decision.offerId, deps.placementTimeoutMs !== undefined ? { timeoutMs: deps.placementTimeoutMs } : {});
  if (placed.kind !== "placed") {
    session.end();
    if (placed.code === "placement_timeout") await cancelOffer(db, decision.offerId, "placement_timeout", { userId: req.requestedBy });
    return refuse(db, req, "robot_run_placement_refused", `The sandbox did not start (${placed.code}); nothing ran.`, runId);
  }
  watchHeldStdioSession(db, session);
  await db
    .update(robotRuns)
    .set({ status: "running", startedAt: new Date(), executionPlacementId: placed.placementId })
    .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "start")));

  const result = await controller.wait(plan.limits.wallClockMs + WALL_CLOCK_MARGIN_MS);
  session.close();
  await endStdioSession(db, decision.offerId).catch(() => undefined);
  return finishRun(db, req, runId, result, version.outputSchema as Record<string, unknown>);
}

/** the terminal write: the machine edge from `running`, the audit, and the output check */
async function finishRun(db: Db, req: RobotRunRequest, runId: string, r: RobotRunResult | null, outputSchema: Record<string, unknown>): Promise<RobotRunOutcome> {
  let status: "succeeded" | "failed" | "timed_out" | "cancelled" = r?.status ?? "timed_out";
  let failureCode: string | null = r ? (r.failureCode ?? null) : "timed_out";
  let outputs: Record<string, unknown> | null = null;
  if (status === "succeeded" && r) {
    const check = validateOutputAgainstSchema(outputSchema, JSON.stringify(r.outputs));
    if (check.valid) outputs = r.outputs;
    else {
      status = "failed";
      failureCode = "output_schema_mismatch";
    }
  }
  const event = status === "succeeded" ? "succeed" : status === "failed" ? "fail" : status === "timed_out" ? "time_out" : "cancel";
  await db
    .update(robotRuns)
    .set({ status, failureCode, stepCount: r?.stepsCompleted ?? null, finishedAt: new Date() })
    .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, event)));
  const [row] = await db.select({ startedAt: robotRuns.startedAt, finishedAt: robotRuns.finishedAt }).from(robotRuns).where(eq(robotRuns.id, runId));
  if (row?.startedAt && row.finishedAt) {
    await db.update(robotRuns).set({ durationMs: row.finishedAt.getTime() - row.startedAt.getTime() }).where(eq(robotRuns.id, runId));
  }
  await auditRun(
    db,
    req.requestedBy,
    runId,
    `robot-run-${status.replaceAll("_", "-")}`,
    `Robot '${req.robot.slug}' version ${req.version.version}: ${status}${failureCode ? ` (${failureCode})` : ""}.`,
    { robotId: req.robot.id, versionId: req.version.id, kind: req.kind, status, failureCode, stepsCompleted: r?.stepsCompleted ?? null },
    status === "succeeded" ? "allow" : "deny",
  );
  return { kind: "finished", runId, status, failureCode, outputs };
}

// ---------------------------------------------------------------------------
// the session's gateway channel: plan, heartbeat, evidence, result
// ---------------------------------------------------------------------------

const ROUTE_RE = /^\/v1\/robot-runner\/runs\/([0-9a-f-]{36})\/(plan|heartbeat|evidence|result)$/;

interface EvidenceItem {
  kind: "screenshot" | "download" | "egress_log";
  step: number | null;
  contentType: string;
  chunks: Buffer[];
  bytes: number;
  next: number;
}

export class RobotRunController {
  private planServed = false;
  private result: RobotRunResult | null = null;
  private done = false;
  private waiters: Array<() => void> = [];
  private readonly items = new Map<number, EvidenceItem>();
  private storedItems = 0;
  private readonly startedAt = Date.now();
  /** the byte patterns no stored evidence may contain (the run key and every secret value): the canary rule */
  private readonly forbidden: Buffer[];
  /** evidence writes run in order */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly deps: RobotRunDeps,
    readonly runId: string,
    private readonly plan: RobotRunPlan,
    forbidden: readonly string[],
    private readonly requestedBy: string,
  ) {
    this.forbidden = forbidden.filter((v) => v.length >= 4).flatMap((v) => [Buffer.from(v, "utf8"), Buffer.from(v, "utf16le")]);
  }

  /** true when `bytes` contains a secret value or the run key (the canary rule, §7) */
  leaks(bytes: Buffer): boolean {
    return this.forbidden.some((f) => bytes.includes(f));
  }

  wait(ms: number): Promise<RobotRunResult | null> {
    if (this.done) return Promise.resolve(this.result);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.finish(null);
        resolve(this.result);
      }, ms);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve(this.result);
      });
    });
  }

  sessionEnded(): void {
    this.finish(this.result);
  }

  private finish(r: RobotRunResult | null): void {
    if (this.done) return;
    this.done = true;
    this.result = r;
    for (const w of this.waiters.splice(0)) w();
  }

  /** one stdout line of the sandbox */
  onFrame(line: string, session: Pick<StdioSession, "push">): void {
    let frame: ReturnType<typeof engineTaskOutFrameSchema.parse>;
    try {
      frame = engineTaskOutFrameSchema.parse(JSON.parse(line));
    } catch {
      return; // not a frame: the runner speaks frames only; anything else is dropped, never echoed
    }
    if (frame.t !== "http") return;
    const reply = (status: number, body: unknown) =>
      session.push(JSON.stringify({ t: "http_res", id: frame.id, status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)).toString("base64") }));
    this.chain = this.chain
      .then(() => this.answer(frame as Extract<typeof frame, { t: "http" }>))
      .then(([status, body]) => reply(status, body))
      .catch(() => reply(500, { error: "robot_runner_gateway_error" }));
  }

  private async answer(frame: { method: "GET" | "POST"; path: string; body: string }): Promise<[number, unknown]> {
    const m = ROUTE_RE.exec(frame.path);
    if (!m || m[1] !== this.runId) return [404, { error: "not_found" }];
    const route = m[2]!;
    let body: unknown = undefined;
    if (frame.method === "POST") {
      try {
        body = JSON.parse(Buffer.from(frame.body, "base64").toString("utf8"));
      } catch {
        return [400, { error: "invalid_body" }];
      }
    }
    if (route === "plan" && frame.method === "GET") {
      if (this.planServed) return [409, { error: "plan_already_served" }];
      this.planServed = true;
      return [200, this.plan];
    }
    if (route === "heartbeat" && frame.method === "POST") {
      if (!robotHeartbeatSchema.safeParse(body).success) return [400, { error: "invalid_body" }];
      const mode = await loadExecutionMode(this.db);
      const overTime = Date.now() - this.startedAt > this.plan.limits.wallClockMs;
      return [200, { cancel: mode === "halted" || mode === "read_only" || overTime || this.done }];
    }
    if (route === "evidence" && frame.method === "POST") return this.evidence(body);
    if (route === "result" && frame.method === "POST") {
      const r = robotRunResultSchema.safeParse(body);
      if (!r.success) return [400, { error: "invalid_body" }];
      if (this.done) return [409, { error: "run_already_ended" }];
      this.finish(r.data);
      return [200, { ok: true }];
    }
    return [405, { error: "method_not_allowed" }];
  }

  private async evidence(body: unknown): Promise<[number, unknown]> {
    const u = robotEvidenceUploadSchema.safeParse(body);
    if (!u.success) return [400, { error: "invalid_body" }];
    const e = u.data;
    if (this.plan.screenshots === "none" && e.kind === "screenshot") return [409, { error: "screenshots_off" }];
    const data = Buffer.from(e.dataBase64, "base64");
    let item = this.items.get(e.item);
    if (!item) {
      if (e.chunk !== 0 || this.storedItems + this.items.size >= ROBOT_RUN_LIMITS.evidenceItems) return [409, { error: "evidence_refused" }];
      item = { kind: e.kind, step: e.step, contentType: e.contentType, chunks: [], bytes: 0, next: 0 };
      this.items.set(e.item, item);
    }
    if (e.chunk !== item.next || e.kind !== item.kind) return [409, { error: "evidence_out_of_order" }];
    const cap = e.kind === "download" ? this.plan.limits.downloadBytes : ROBOT_RUN_LIMITS.screenshotBytes;
    if (item.bytes + data.length > cap) {
      this.items.delete(e.item);
      return [413, { error: "evidence_too_large" }];
    }
    item.chunks.push(data);
    item.bytes += data.length;
    item.next += 1;
    if (!e.last) return [200, { ok: true }];
    this.items.delete(e.item);
    const bytes = Buffer.concat(item.chunks);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== e.size || sha256 !== e.sha256) return [422, { error: "evidence_digest_mismatch" }];
    if (this.leaks(bytes)) {
      await this.db.insert(auditLog).values({
        userId: this.requestedBy,
        objectType: "robot_run",
        objectId: this.runId,
        detail: { item: e.item, kind: e.kind, sha256 },
        effect: "deny",
        ruleId: "robot-run-evidence-leak-refused",
        ruleChain: [],
        reason: "An evidence item contained a secret value; it was refused and not stored.",
      });
      return [422, { error: "evidence_contains_secret" }];
    }
    await this.store(e.item, item, bytes, sha256);
    this.storedItems += 1;
    return [200, { ok: true, sha256 }];
  }

  private async store(itemNo: number, item: EvidenceItem, bytes: Buffer, sha256: string): Promise<void> {
    const store = this.deps.store;
    if (store) {
      const key = artifactStorageKey(sha256);
      if (!(await store.has(key))) {
        const dir = await mkdtemp(path.join(tmpdir(), "robot-evidence-"));
        const file = path.join(dir, randomUUID());
        try {
          await writeFile(file, bytes, { mode: 0o600 });
          await store.putFile(key, file, sha256, bytes.length);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
    await runWithRlsSystem("system_task", "robot-run.evidence", () =>
      this.db.insert(robotRunEvidence).values({
        robotRunId: this.runId,
        item: itemNo,
        kind: item.kind,
        step: item.step,
        contentType: item.contentType,
        sha256,
        sizeBytes: bytes.length,
      }),
    );
  }
}

/** the robot and version a test run names, re-read in the run's own reads (never a cached row) */
export async function loadRunnable(db: Db, robotId: string, versionNo: number): Promise<{ robot: RobotRow; version: RobotVersionRow } | null> {
  const [row] = await db
    .select({ robot: robots, version: robotVersions })
    .from(robotVersions)
    .innerJoin(robots, eq(robots.id, robotVersions.robotId))
    .where(and(eq(robots.id, robotId), eq(robotVersions.version, versionNo)));
  return row ?? null;
}

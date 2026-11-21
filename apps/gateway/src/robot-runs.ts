/**
 * ADR-0364 S3 (lane E45) — ROBOT RUNS, gateway side. One run of one robot version, in one `robot_browser` sandbox.
 *
 *   startRobotRun(db, req)  the only way a run starts: from a governed tools/call on the Robots server (kind `agent`)
 *                           or the author's test run (kind `test`). In order, every refusal recorded and fail-closed:
 *     1. the kill switch and safe modes (ADR-0124/0139): a robot run is an EXTERNAL WRITE, so `read_only` and
 *        `halted` refuse it; a test run is refused under `require_approval` too (no approval path queues it);
 *     2. attribution and budget (§5): a run needs a project with a budget (`robot-run-needs-project`), and the
 *        project must pass the same pre-dispatch budget gate every attributed call passes (`preDispatchProjectGate`:
 *        an over-budget project is refused `project_budget_exceeded`, in the gate's own shape);
 *     3. the inputs are validated against the version's input schema (Ajv, the repo's validator);
 *     4. the secrets for the run's scope (live for an agent run, test for a test run) are opened from their
 *        ADR-0204 envelopes and SEALED under a fresh run key (`sealRobotSecret`), so no frame carries a value;
 *     5. the runner image is the digest-pinned `robot-runner` entry of the images lock; unpublished = refused;
 *     6. the project's PII handling mode, through the compliance cascade (`projectPiiMode`, the org floor when the
 *        project has no matching tag): `block` turns screenshots off and keeps a download as its sha256 and size only;
 *        any other mode masks screenshots over every filled field (§7);
 *     7. decision 7 places a `robot_browser` workload with the version's egress targets (the executor builds the
 *        run's Smokescreen ACL from them, §7). Any refusal, or a placement error, ends the run `refused`.
 *   The run key reaches the sandbox only through the task-scoped release (the MACed `start` line → fd 3).
 *
 *   THE CALLER'S ABORT. An agent run's tools/call passes its AbortSignal (the caller's deadline, a cancellation, the
 *   session closing). Before placement it withdraws the offer and ends the run `cancelled`; during the run every
 *   heartbeat answers {cancel}, and a runner that does not report within a grace is ended `cancelled` anyway. Either
 *   way the session and its sandbox are released. A tools/call is never retried (ADR-0128), so no second run starts.
 *
 *   THE SESSION. The gateway holds the run's stdio session (the I4 pattern) and answers the runner's gateway-channel
 *   requests (`http` frames, `robots-run.ts`) in-process: the plan (once), heartbeats (`{cancel}` when the kill
 *   switch is thrown, the wall clock is spent, the caller aborted or the run was failed), evidence chunks and the
 *   result. No runner credential exists.
 *
 *   EVIDENCE (§7). Each item is reassembled from its chunks, its size and sha256 re-checked, and refused if any byte
 *   sequence of a secret value or the run key appears in it (the canary rule, `canaryPatterns`), then stored
 *   content-addressed in the artifact store and recorded in `robot_run_evidence` (append-only). The bytes held in
 *   memory while an item is still arriving are capped per run and across runs: a chunk over the run's own cap fails
 *   the run `evidence_too_large`; a new item that finds the gateway-wide cap reserved by other runs is answered 503
 *   `evidence_busy` with a `retryAfterMs`, and the runner sends the same chunk again (another run's evidence never
 *   fails this one). No store configured = no bytes are kept (`bytes_withheld = no_store`), and the run still
 *   records its outcome (screenshots are evidence, not the result).
 *
 *   OUTPUTS go through the same canary rule (a page that echoes a secret back fails the run `secret_in_output`, and no
 *   output is returned) and are validated against the version's output schema before they are returned to the agent
 *   as untrusted tool output (§7). Outputs are never stored.
 *
 *   LIFECYCLE. Every status write is one ROBOT_RUN_MACHINE edge, checked with `.returning()`: a write that moved no
 *   row lost a race (the stale-run sweep, a cancel) and writes no audit; the caller gets a `lost` outcome. The sweep
 *   (`runRobotRunStaleSweep`, scheduled as `robot-run-stale-sweep`) ends a `queued` or `running` run older than any
 *   run can live as `timed_out`, audited.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  and,
  asc,
  auditLog,
  eq,
  executionOffers,
  inArray,
  lt,
  projects,
  robotRunEvidence,
  robotRuns,
  robots,
  robotSecrets,
  robotVersionAllowedSites,
  robotVersionSecrets,
  robotVersions,
  runWithRlsSystem,
  sql,
  usageEvents,
  withinSystemReason,
  type Db,
  type RobotRow,
  type RobotVersionRow,
} from "@regulait/db";
import {
  ENGINE_IMAGES_LOCK,
  ROBOT_EGRESS_LOG_ITEM,
  ROBOT_RUN_LIMITS,
  ROBOT_SECRET_MIN_CHARS,
  ROBOT_RUN_MACHINE,
  compileRobotPlanSteps,
  engineTaskOutFrameSchema,
  newRobotRunKey,
  robotEgressTargets,
  robotEvidenceUploadSchema,
  robotHeartbeatSchema,
  robotRunResultSchema,
  robotToolName,
  sealRobotSecret,
  secretRepresentations,
  validateStepsScript,
  type RobotRunPlan,
  type RobotRunResult,
} from "@regulait/shared";
import { loadExecutionMode } from "./execution-posture.js";
import { decidePlacement, PlacementEgressError, type PlacementRequest } from "./execution-placement.js";
import { awaitPlacement, cancelOffer } from "./executor-channel.js";
import { endStdioSession, holdStdioSession, StdioSession, useRelayDb, watchHeldStdioSession } from "./executor-stdio.js";
import { artifactStorageKey, type ArtifactStore } from "./model-artifacts.js";
import { validateOutputAgainstSchema } from "./playground.js";
import { preDispatchProjectGate, projectPiiMode } from "./projects.js";
import { ROBOT_RUN_MAX_LIFETIME_MS, ROBOT_RUN_RESULT_EXIT_GRACE_MS, ROBOT_RUN_WALL_CLOCK_MARGIN_MS } from "./robots-mcp.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { decryptSecret } from "./secrets.js";
import { whereFrom } from "./state-transition.js";

/**
 * the runner's entry point inside the robot-runner image (its fixed argv, sent to the sandbox init at release). The
 * image copies the runner's build to /app (engines/robot-runner/Dockerfile: `COPY --from=shim /out /app`) and runs
 * `node /app/dist/main.js`; the sandbox runs exactly that.
 */
export const ROBOT_RUNNER_WORKLOAD = { command: "/usr/local/bin/node", args: ["/app/dist/main.js"] } as const;
/** after the caller aborts, how long the runner has to see {cancel} on a heartbeat and report before the run is ended */
const ABORT_GRACE_MS = 15_000;
/** a run no gateway can still hold: older than the longest a run can live, plus a minute of clock slack */
export const ROBOT_RUN_STALE_MS = ROBOT_RUN_MAX_LIFETIME_MS + 60_000;

export type RobotRunRefusal =
  | "robot_run_safe_mode"
  | "robot-run-needs-project"
  | "robot_run_inputs_invalid"
  | "robot_secret_missing"
  | "robot_runner_unavailable"
  | "robot_run_placement_refused"
  | "robot_run_placement_failed"
  | "robot_run_cancelled"
  | "robot_version_not_runnable"
  // preDispatchProjectGate's own refusals, passed through in its shape
  | "project_budget_exceeded"
  | "project_archived"
  | "unknown_project";

export type RobotRunOutcome =
  | { kind: "refused"; code: RobotRunRefusal; message: string; runId: string | null; /** the gate's HTTP status */ httpStatus?: number }
  | {
      kind: "finished";
      runId: string;
      status: "succeeded" | "failed" | "timed_out" | "cancelled";
      failureCode: string | null;
      /** validated against the output schema and the canary rule; present only for a succeeded run */
      outputs: Record<string, unknown> | null;
    }
  /** the run row was moved by someone else first (the stale sweep, a cancel): nothing was audited as this caller's */
  | { kind: "lost"; runId: string; message: string };

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
  /** the governed call's abort: aborting it cancels the run (see the header) */
  signal?: AbortSignal;
}

export interface RobotRunDeps {
  dataKey: string | undefined;
  store: ArtifactStore | null;
  /** tests only: the executors decision 7 may use, and a shorter placement wait */
  onlyExecutorIds?: readonly string[];
  placementTimeoutMs?: number;
  /** tests only: a shorter grace between the caller's abort and the run's end */
  abortGraceMs?: number;
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
// the canary rule: every form a secret value can take in page content
// ---------------------------------------------------------------------------

/**
 * A secret value (or the run key) shorter than this is not matched: fewer characters shred ordinary bytes into false
 * hits. It is the store's own floor (`ROBOT_SECRET_MIN_CHARS`: a shorter secret is refused when it is set), so every
 * stored value is matched; the run key is 43 characters.
 */
export const CANARY_MIN_CHARS = ROBOT_SECRET_MIN_CHARS;

/** the base64 text of `bytes` wherever they sit in a longer stream (each of the three byte alignments), std and url */
function base64Forms(bytes: Buffer): string[] {
  const forms: string[] = [];
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64").replace(/=+$/, "");
    // drop the characters that carry any bit of the k prefix bytes, and the last one that carries a following byte's
    const start = k === 0 ? 0 : Math.floor((8 * k - 1) / 6) + 1;
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    const core = enc.slice(start, end);
    if (core.length >= CANARY_MIN_CHARS) forms.push(core, core.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return forms;
}

/**
 * The byte patterns no stored evidence and no returned output may contain, for each value of `values` (the run key
 * and every secret value) of at least CANARY_MIN_CHARS characters: the value raw, JSON-escaped, percent-encoded (either
 * hex case) and form-encoded (`secretRepresentations`, the shared scrub's list), each as UTF-8 and UTF-16LE, and its
 * base64 (standard and url-safe, at every alignment).
 */
export function canaryPatterns(values: readonly string[]): Buffer[] {
  const out = new Map<string, Buffer>();
  const add = (b: Buffer) => {
    if (b.length >= CANARY_MIN_CHARS) out.set(b.toString("hex"), b);
  };
  for (const v of values) {
    if (typeof v !== "string" || v.length < CANARY_MIN_CHARS) continue;
    const forms = new Set(secretRepresentations(v));
    forms.add(v);
    for (const f of [...forms]) if (/%[0-9A-F]{2}/.test(f)) forms.add(f.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    for (const f of forms) {
      add(Buffer.from(f, "utf8"));
      add(Buffer.from(f, "utf16le"));
    }
    for (const b of base64Forms(Buffer.from(v, "utf8"))) add(Buffer.from(b, "utf8"));
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// the in-memory bound on evidence still arriving
// ---------------------------------------------------------------------------

/**
 * how long a runner waits before it sends a chunk again when the gateway-wide in-flight cap is full (the answer is
 * 503 `evidence_busy` with this as `retryAfterMs`); only the run's own cap fails a run
 */
export const ROBOT_EVIDENCE_RETRY_AFTER_MS = 250;
/**
 * bytes of unfinished evidence items one run, and the whole gateway, may hold in memory at once. The run's cap counts
 * the bytes it holds; the gateway's counts RESERVATIONS: an item reserves its kind's most (a screenshot's, or the
 * plan's download bound) when its first chunk arrives, so an item that started always has room to finish, and runs
 * waiting on the gateway's cap can never hold each other's items half-done forever.
 */
export const ROBOT_EVIDENCE_IN_FLIGHT_CAPS = { perRunBytes: 16 * 1024 * 1024, globalBytes: 64 * 1024 * 1024 } as const;
let inFlightCaps: { perRunBytes: number; globalBytes: number } = { ...ROBOT_EVIDENCE_IN_FLIGHT_CAPS };
let globalInFlightBytes = 0;
/** tests only: smaller caps (undefined restores the defaults) */
export function setRobotEvidenceCapsForTest(caps?: { perRunBytes: number; globalBytes: number }): void {
  inFlightCaps = caps ? { ...caps } : { ...ROBOT_EVIDENCE_IN_FLIGHT_CAPS };
}
/** tests only: the gateway-wide in-flight figure (bytes reserved by unfinished items) */
export function robotEvidenceInFlightBytes(): number {
  return globalInFlightBytes;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function auditRun(db: Db, userId: string, runId: string, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow") {
  await db.insert(auditLog).values({ userId, objectType: "robot_run", objectId: runId, detail, effect, ruleId, ruleChain: [], reason });
}

function lost(runId: string, step: string): RobotRunOutcome {
  // a lost race is not an error of this caller's: logged once (ids only), never audited as this caller's outcome
  console.warn(`robot run ${runId}: the ${step} write moved no row (another writer ended the run first)`);
  return { kind: "lost", runId, message: "The run was ended by another writer (a cancel or the stale-run sweep) first; nothing more was recorded." };
}

async function refuse(
  db: Db,
  req: RobotRunRequest,
  code: RobotRunRefusal,
  message: string,
  runId: string | null = null,
  extra: { httpStatus?: number; detail?: Record<string, unknown> } = {},
): Promise<RobotRunOutcome> {
  if (runId) {
    const moved = await runWithRlsSystem("system_task", "robot-run.refuse", () =>
      db
        .update(robotRuns)
        .set({ status: "refused", failureCode: code.replaceAll("-", "_"), finishedAt: new Date() })
        .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "refuse")))
        .returning({ id: robotRuns.id }),
    );
    if (moved.length === 0) return lost(runId, "refuse");
  }
  await db.insert(auditLog).values({
    userId: req.requestedBy,
    objectType: runId ? "robot_run" : "robot_version",
    objectId: runId ?? req.version.id,
    detail: { robotId: req.robot.id, versionId: req.version.id, version: req.version.version, kind: req.kind, code, ...(extra.detail ?? {}) },
    effect: "deny",
    ruleId: "robot-run-refused",
    ruleChain: [],
    reason: message,
  });
  return { kind: "refused", code, message, runId, ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}) };
}

/** a queued run the caller aborted before it was placed: the machine's `cancel` edge, audited */
async function cancelQueued(db: Db, req: RobotRunRequest, runId: string): Promise<RobotRunOutcome> {
  const moved = await runWithRlsSystem("system_task", "robot-run.cancel", () =>
    db
      .update(robotRuns)
      .set({ status: "cancelled", failureCode: "caller_aborted", finishedAt: new Date() })
      .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "cancel")))
      .returning({ id: robotRuns.id }),
  );
  if (moved.length === 0) return lost(runId, "cancel");
  await auditRun(
    db,
    req.requestedBy,
    runId,
    "robot-run-cancelled",
    `Robot '${req.robot.slug}' version ${req.version.version}: cancelled before it was placed (the call was aborted).`,
    { robotId: req.robot.id, versionId: req.version.id, kind: req.kind, status: "cancelled", failureCode: "caller_aborted", evidence: [] },
    "deny",
  );
  return { kind: "finished", runId, status: "cancelled", failureCode: "caller_aborted", outputs: null };
}

/** resolves when `signal` aborts (never, without one) */
function onAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
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

  // 2. attribution: a project with a budget, and the budget gate every attributed call passes
  if (!req.projectId) return refuse(db, req, "robot-run-needs-project", "A robot run must be attributed to a project with a budget; nothing ran.");
  const projectId: string = req.projectId;
  const [project] = await db.select({ id: projects.id, budgetUsd: projects.budgetUsd }).from(projects).where(eq(projects.id, req.projectId));
  if (!project || project.budgetUsd === null || project.budgetUsd === undefined) {
    return refuse(db, req, "robot-run-needs-project", "The run's project has no budget; a robot run needs one. Nothing ran.");
  }
  const gate = await preDispatchProjectGate(db, projectId, req.requestedBy);
  if (!gate.ok) {
    return refuse(db, req, gate.error as RobotRunRefusal, `The run's project refuses attributed calls (${gate.error}${gate.detail ? `: ${gate.detail}` : ""}); nothing ran.`, null, {
      httpStatus: gate.status,
      detail: { projectId, gate: gate.error },
    });
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

  // 6. the project's PII mode, through the compliance cascade (the org floor when no tag matches): `block` keeps no
  // screenshot and no download bytes; every other mode masks screenshots over every filled field
  const piiMode = await projectPiiMode(db, projectId);
  const piiBlock = piiMode === "block";

  if (req.signal?.aborted) return refuse(db, req, "robot_run_cancelled", "The call was aborted before the run was queued; nothing ran.");

  // the run row (queued), then 7. decision 7
  // robot_runs is written by the gateway only (its RLS write policy: admin or system_task), never as the requester
  const [run] = await runWithRlsSystem("system_task", "robot-run.queue", () =>
    db
      .insert(robotRuns)
      .values({
        robotVersionId: version.id,
        requestedBy: req.requestedBy,
        agentId: req.builderAgentId ?? null,
        projectId,
        kind: req.kind,
        contentDigest: req.contentDigest,
      })
      .returning({ id: robotRuns.id }),
  );
  const runId = run!.id;
  await auditRun(db, req.requestedBy, runId, "robot-run-queued", `Robot '${robot.slug}' version ${version.version} queued (${req.kind} run).`, {
    robotId: robot.id,
    versionId: version.id,
    version: version.version,
    kind: req.kind,
    projectId: req.projectId,
    contentDigest: req.contentDigest,
    piiMode,
    screenshots: piiBlock ? "none" : "masked",
  });

  const targets = robotEgressTargets(allowedOrigins);
  let decision: Awaited<ReturnType<typeof decidePlacement>>;
  try {
    decision = await decidePlacement(db, {
      ...(deps.onlyExecutorIds ? { onlyExecutorIds: deps.onlyExecutorIds } : {}),
      workloadKind: "robot_browser",
      projectId: req.projectId,
      agent: req.agent ?? null,
      mcpServerId: null,
      parentGrantId: req.parentGrantId ?? null,
      interactivePerson: req.interactivePerson === true,
      imageDigest,
      actorUserId: req.requestedBy,
      egress: { runId, targets },
    });
  } catch (err) {
    // a placement that throws (an egress list decision 7 will not carry, or any other error) is a refusal, never a
    // run left `queued` and a 500 to the caller; the error's text is not echoed (it may name internals)
    const why = err instanceof PlacementEgressError ? "placement_egress_invalid" : "placement_error";
    return refuse(db, req, "robot_run_placement_failed", `No sandbox could be placed for the run (${why}); nothing ran.`, runId, { detail: { why } });
  }
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
    screenshots: piiBlock ? "none" : "masked",
  };
  const controller = new RobotRunController(db, deps, runId, plan, [runKey, ...opened.map((s) => s.value)], req.requestedBy, {
    downloads: piiBlock ? "digest_only" : "store",
  });
  try {
    const session = new StdioSession(decision.offerId, decision.executorId, { command: ROBOT_RUNNER_WORKLOAD.command, args: [...ROBOT_RUNNER_WORKLOAD.args] });
    session.secret = runKey;
    session.attached = true;
    session.onLine = (line) => controller.onFrame(line, session);
    session.onEnd = () => controller.sessionEnded();
    useRelayDb(db);
    if (!holdStdioSession(session)) {
      await cancelOffer(db, decision.offerId, "session_abandoned", { userId: req.requestedBy });
      return await refuse(db, req, "robot_run_placement_refused", "The gateway holds its maximum of live sandbox sessions; nothing ran.", runId);
    }

    // the caller's abort: while placing, the offer is withdrawn; once running, the heartbeat answers {cancel}
    let abortedWhilePlacing = false;
    const placing = awaitPlacement(db, decision.offerId, deps.placementTimeoutMs !== undefined ? { timeoutMs: deps.placementTimeoutMs } : {});
    const abortFirst = await Promise.race([placing.then(() => false), onAbort(req.signal).then(() => true)]);
    if (abortFirst) {
      abortedWhilePlacing = true;
      // an offer not yet placed is withdrawn (a sandbox that started gets no input); a placed one runs on and is
      // cancelled at its first heartbeat below, so its evidence never says it did not run
      const [o] = await db.select({ status: executionOffers.status }).from(executionOffers).where(eq(executionOffers.id, decision.offerId));
      if (o?.status === "offered" || o?.status === "accepted") await cancelOffer(db, decision.offerId, "session_abandoned", { userId: req.requestedBy });
    }
    const placed = await placing;
    if (placed.kind !== "placed") {
      session.end();
      if (abortedWhilePlacing) return await cancelQueued(db, req, runId);
      if (placed.code === "placement_timeout") await cancelOffer(db, decision.offerId, "placement_timeout", { userId: req.requestedBy });
      return await refuse(db, req, "robot_run_placement_refused", `The sandbox did not start (${placed.code}); nothing ran.`, runId);
    }
    watchHeldStdioSession(db, session);
    const started = await runWithRlsSystem("system_task", "robot-run.start", () =>
      db
        .update(robotRuns)
        .set({ status: "running", startedAt: new Date(), executionPlacementId: placed.placementId })
        .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "start")))
        .returning({ id: robotRuns.id }),
    );
    if (started.length === 0) {
      // someone else ended the run while it was placed: the sandbox is released at once, nothing more is recorded
      session.close();
      await endStdioSession(db, decision.offerId).catch(() => undefined);
      return lost(runId, "start");
    }

    const abortGrace = deps.abortGraceMs ?? ABORT_GRACE_MS;
    if (abortedWhilePlacing || req.signal?.aborted) controller.requestCancel(abortGrace);
    else req.signal?.addEventListener("abort", () => controller.requestCancel(abortGrace), { once: true });

    const result = await controller.wait(plan.limits.wallClockMs + ROBOT_RUN_WALL_CLOCK_MARGIN_MS);
    // the runner awaits its result's answer, then closes its browser and writes its `end` frame: closing the session at
    // once would drop that answer and stop the sandbox before it exits (every run's sandbox would end `killed`)
    if (result) await controller.sessionEndedWithin(ROBOT_RUN_RESULT_EXIT_GRACE_MS);
    session.close();
    await endStdioSession(db, decision.offerId).catch(() => undefined);
    return await finishRun(db, req, runId, result, version.outputSchema as Record<string, unknown>, controller);
  } finally {
    controller.releaseAll();
  }
}

/** what finishRun reads from the run's controller (a narrow seam, so a test can drive finishRun alone) */
export interface RunEndFacts {
  /** the canary rule over text */
  leaksText(text: string): boolean;
  /** a failure the gateway decided during the run (it overrides the runner's report) */
  readonly forcedFailure: "evidence_too_large" | null;
  /** the caller aborted the run */
  readonly cancelRequested: boolean;
}

/** the outputs carry a secret value in any canary form, whole or in one field */
function outputsLeak(outputs: Record<string, unknown>, facts: RunEndFacts): boolean {
  if (facts.leaksText(JSON.stringify(outputs))) return true;
  return Object.values(outputs).some((v) => facts.leaksText(typeof v === "string" ? v : JSON.stringify(v)));
}

/**
 * The terminal write: the machine edge from `running`, the audit (with the ordered evidence list), the run's usage
 * row, and the output checks. Exported for the lost-race test; `startRobotRun` is its only production caller.
 */
export async function finishRun(
  db: Db,
  req: RobotRunRequest,
  runId: string,
  r: RobotRunResult | null,
  outputSchema: Record<string, unknown>,
  facts: RunEndFacts,
): Promise<RobotRunOutcome> {
  let status: "succeeded" | "failed" | "timed_out" | "cancelled" = r?.status ?? (facts.cancelRequested ? "cancelled" : "timed_out");
  let failureCode: string | null = r ? (r.failureCode ?? null) : facts.cancelRequested ? "caller_aborted" : "timed_out";
  if (facts.cancelRequested && status === "cancelled") failureCode = "caller_aborted";
  let outputs: Record<string, unknown> | null = null;
  let outputLeak = false;
  if (facts.forcedFailure) {
    status = "failed";
    failureCode = facts.forcedFailure;
  } else if (status === "succeeded" && r) {
    // §7 canary first: a page that echoes a secret back fails the run, and no output (not even a valid one) leaves
    if (outputsLeak(r.outputs, facts)) {
      outputLeak = true;
      status = "failed";
      failureCode = "secret_in_output";
    } else {
      const check = validateOutputAgainstSchema(outputSchema, JSON.stringify(r.outputs));
      if (check.valid) outputs = r.outputs;
      else {
        status = "failed";
        failureCode = "output_schema_mismatch";
      }
    }
  }
  const event = status === "succeeded" ? "succeed" : status === "failed" ? "fail" : status === "timed_out" ? "time_out" : "cancel";
  const moved = await runWithRlsSystem("system_task", "robot-run.finish", async () => {
    const rows = await db
      .update(robotRuns)
      .set({ status, failureCode, stepCount: r?.stepsCompleted ?? null, finishedAt: new Date() })
      .where(and(eq(robotRuns.id, runId), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, event)))
      .returning({ id: robotRuns.id, startedAt: robotRuns.startedAt, finishedAt: robotRuns.finishedAt });
    const row = rows[0];
    if (row?.startedAt && row.finishedAt) {
      await db.update(robotRuns).set({ durationMs: row.finishedAt.getTime() - row.startedAt.getTime() }).where(eq(robotRuns.id, runId));
    }
    return rows.length;
  });
  if (moved === 0) return lost(runId, "finish");

  // the ordered evidence list the run stored (the egress log, item ROBOT_EGRESS_LOG_ITEM, may follow from the
  // executor's end; its digest is then on its own `robot-run-egress-log` audit row)
  const evidence = await runWithRlsSystem("system_task", "robot-run.finish-evidence", () =>
    db
      .select({ item: robotRunEvidence.item, kind: robotRunEvidence.kind, sha256: robotRunEvidence.sha256 })
      .from(robotRunEvidence)
      .where(eq(robotRunEvidence.robotRunId, runId))
      .orderBy(asc(robotRunEvidence.item))
      // the runner's items and the egress log's reserved slot
      .limit(ROBOT_RUN_LIMITS.evidenceItems + 1),
  );
  if (outputLeak) {
    await auditRun(
      db,
      req.requestedBy,
      runId,
      "robot-run-output-leak-refused",
      "A run output contained a secret value; the run failed and no output was returned.",
      // the field names only, never a value
      { fields: Object.keys(r!.outputs).sort() },
      "deny",
    );
  }
  await auditRun(
    db,
    req.requestedBy,
    runId,
    `robot-run-${status.replaceAll("_", "-")}`,
    `Robot '${req.robot.slug}' version ${req.version.version}: ${status}${failureCode ? ` (${failureCode})` : ""}.`,
    { robotId: req.robot.id, versionId: req.version.id, kind: req.kind, status, failureCode, stepsCompleted: r?.stepsCompleted ?? null, evidence },
    status === "succeeded" ? "allow" : "deny",
  );
  // PILLAR 5: the run lands on the usage ledger, attributed to its project. A sandbox run has no metered price yet
  // (no per-run or per-minute rate exists for robot_browser), so its cost is NULL = unpriced, never an invented figure.
  // An agent run's governed tools/call also bills the Robots server's per-call price on its own row (mcp-proxy).
  await db.insert(usageEvents).values({
    userId: req.requestedBy,
    objectType: "robot_run",
    operation: robotToolName(req.robot.slug, req.version.version),
    costUsd: null,
    projectId: req.projectId,
    detail: { robotRunId: runId, robotId: req.robot.id, versionId: req.version.id, kind: req.kind, status },
  });
  return { kind: "finished", runId, status, failureCode, outputs };
}

// ---------------------------------------------------------------------------
// the stale-run sweep
// ---------------------------------------------------------------------------

/**
 * End every `queued` or `running` run older than any run can live (`ROBOT_RUN_STALE_MS`) as `timed_out`
 * (`stale_run`), audited, at most 500 a pass. Each swept run gets the usage row a finished run gets (unpriced) unless
 * it has one, and any offer of it still open is withdrawn (`cancelOffer`, `session_abandoned`). Such a run lost its gateway (a restart mid-run): nothing can still
 * finish it. The age is judged on the database clock unless the caller supplies one (M-075).
 */
export async function runRobotRunStaleSweep(db: Db, opts: { now?: Date } = {}): Promise<{ timedOut: number; ids: string[]; offersWithdrawn: number }> {
  const cutoff = opts.now ? sql`${new Date(opts.now.getTime() - ROBOT_RUN_STALE_MS).toISOString()}::timestamptz` : sql`now() - make_interval(secs => ${ROBOT_RUN_STALE_MS / 1000})`;
  const swept = await runWithRlsSystem("system_task", "robot-run.stale-sweep", async () => {
    const due = await db
      .select({ id: robotRuns.id })
      .from(robotRuns)
      .where(and(whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "time_out"), lt(robotRuns.createdAt, cutoff)))
      .orderBy(asc(robotRuns.createdAt))
      .limit(500);
    if (due.length === 0) return [];
    const ended = await db
      .update(robotRuns)
      .set({ status: "timed_out", failureCode: "stale_run", finishedAt: new Date() })
      .where(and(inArray(robotRuns.id, due.map((d) => d.id)), whereFrom(robotRuns.status, ROBOT_RUN_MACHINE, "time_out")))
      .returning({
        id: robotRuns.id,
        requestedBy: robotRuns.requestedBy,
        robotVersionId: robotRuns.robotVersionId,
        kind: robotRuns.kind,
        projectId: robotRuns.projectId,
      });
    for (const e of ended) {
      await auditRun(
        db,
        e.requestedBy,
        e.id,
        "robot-run-timed-out",
        "The stale-run sweep ended a robot run that no gateway still holds (older than any run can live).",
        { versionId: e.robotVersionId, kind: e.kind, status: "timed_out", failureCode: "stale_run", swept: true, staleAfterMs: ROBOT_RUN_STALE_MS },
        "deny",
      );
    }
    return ended;
  });
  if (swept.length === 0) return { timedOut: 0, ids: [], offersWithdrawn: 0 };
  const ids = swept.map((e) => e.id);

  // PILLAR 5: a swept run lands on the usage ledger exactly like a finished one (cost NULL = unpriced), unless its
  // gateway wrote the row before it was lost (finishRun's write landed, the status write did not)
  const named = await db
    .select({ id: robotRuns.id, slug: robots.slug, robotId: robots.id, version: robotVersions.version })
    .from(robotRuns)
    .innerJoin(robotVersions, eq(robotVersions.id, robotRuns.robotVersionId))
    .innerJoin(robots, eq(robots.id, robotVersions.robotId))
    .where(inArray(robotRuns.id, ids));
  const nameOf = new Map(named.map((n) => [n.id, n]));
  const billed = await db
    .select({ runId: sql<string>`${usageEvents.detail}->>'robotRunId'` })
    .from(usageEvents)
    .where(and(eq(usageEvents.objectType, "robot_run"), inArray(sql<string>`${usageEvents.detail}->>'robotRunId'`, ids)));
  const hasRow = new Set(billed.map((b) => b.runId));
  for (const e of swept) {
    const n = nameOf.get(e.id);
    if (!n || hasRow.has(e.id)) continue;
    await db.insert(usageEvents).values({
      userId: e.requestedBy,
      objectType: "robot_run",
      operation: robotToolName(n.slug, n.version),
      costUsd: null,
      projectId: e.projectId,
      detail: { robotRunId: e.id, robotId: n.robotId, versionId: e.robotVersionId, kind: e.kind, status: "timed_out", swept: true },
    });
  }

  // the run's offer, if one is still open (offered, accepted, or placed with no cancel recorded): withdrawn through
  // the one offer-cancel path, so a sandbox that is still starting gets no input and its evidence says `cancelled`
  const open = await db
    .select({ id: executionOffers.id, robotRunId: executionOffers.robotRunId })
    .from(executionOffers)
    .where(and(inArray(executionOffers.robotRunId, ids), inArray(executionOffers.status, ["offered", "accepted", "placed"])));
  let offersWithdrawn = 0;
  const byRun = new Map(swept.map((e) => [e.id, e]));
  for (const o of open) {
    const userId = byRun.get(o.robotRunId!)?.requestedBy ?? null;
    if (await cancelOffer(db, o.id, "session_abandoned", { userId }).catch(() => false)) offersWithdrawn += 1;
  }
  return { timedOut: swept.length, ids, offersWithdrawn };
}

export const ROBOT_RUN_STALE_SWEEP_JOB_NAME = "robot-run-stale-sweep";

export function robotRunJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: ROBOT_RUN_STALE_SWEEP_JOB_NAME,
      description:
        "End every queued or running robot run older than any run can live (placement wait, wall clock, margin and " +
        "exit grace, plus a minute) as timed_out (stale_run), audited, with its usage row and its open offer withdrawn. " +
        "Such a run lost its gateway mid-run.",
      adr: "ADR-0364",
      defaultIntervalSeconds: 300,
      run: async (ctx) => {
        const out = await runRobotRunStaleSweep(ctx.db, ctx.clockInjected ? { now: ctx.now } : {});
        return { itemsProcessed: out.timedOut, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// the session's gateway channel: plan, heartbeat, evidence, result
// ---------------------------------------------------------------------------

const ROUTE_RE = /^\/v1\/robot-runner\/runs\/([0-9a-f-]{36})\/(plan|heartbeat|evidence|result)$/;

interface EvidenceItem {
  /** a runner uploads screenshots and downloads only; the egress log is the executor's (`robotEgressLogHook`) */
  kind: "screenshot" | "download";
  step: number | null;
  contentType: string;
  chunks: Buffer[];
  bytes: number;
  /** the bytes this item holds against the gateway-wide cap (its kind's most, reserved at its first chunk) */
  reserved: number;
  next: number;
}

/** write `bytes` to a private temp file and hand it to the store's putFile (the store reads files, not buffers) */
async function putBytes(store: ArtifactStore, key: string, sha256: string, bytes: Buffer, prefix: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const file = path.join(dir, randomUUID());
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    await store.putFile(key, file, sha256, bytes.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class RobotRunController implements RunEndFacts {
  private planServed = false;
  private result: RobotRunResult | null = null;
  private done = false;
  private waiters: Array<() => void> = [];
  private sessionDone = false;
  private endWaiters: Array<() => void> = [];
  private readonly items = new Map<number, EvidenceItem>();
  /** the item numbers already stored (a number is used once: the row's (run, item) key) */
  private readonly storedItemNos = new Set<number>();
  private readonly startedAt = Date.now();
  /** bytes of this run's unfinished items held in memory (counted into the gateway-wide figure too) */
  private inFlightBytes = 0;
  /** the byte patterns no stored evidence and no output may contain (`canaryPatterns`): the canary rule */
  private readonly forbidden: Buffer[];
  /** evidence writes run in order */
  private chain: Promise<unknown> = Promise.resolve();
  private cancelled = false;
  private forced: "evidence_too_large" | null = null;
  private readonly downloads: "store" | "digest_only";

  constructor(
    private readonly db: Db,
    private readonly deps: RobotRunDeps,
    readonly runId: string,
    private readonly plan: RobotRunPlan,
    forbidden: readonly string[],
    private readonly requestedBy: string,
    opts: { downloads?: "store" | "digest_only" } = {},
  ) {
    this.forbidden = canaryPatterns(forbidden);
    // strict by default: a controller told nothing keeps a download by its digest only
    this.downloads = opts.downloads ?? "digest_only";
  }

  /** true when `bytes` contains a secret value or the run key, in any canary form (§7) */
  leaks(bytes: Buffer): boolean {
    return this.forbidden.some((f) => bytes.includes(f));
  }

  leaksText(text: string): boolean {
    return this.leaks(Buffer.from(text, "utf8"));
  }

  get forcedFailure(): "evidence_too_large" | null {
    return this.forced;
  }

  get cancelRequested(): boolean {
    return this.cancelled;
  }

  /** the caller aborted: every heartbeat answers {cancel}; a runner that has not reported within `graceMs` is ended */
  requestCancel(graceMs: number): void {
    if (this.done || this.cancelled) return;
    this.cancelled = true;
    const t = setTimeout(() => this.finish(this.result), graceMs);
    t.unref?.();
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
    this.sessionDone = true;
    for (const w of this.endWaiters.splice(0)) w();
    this.finish(this.result);
  }

  /** resolves when the sandbox's side of the session ended (its stdout's eof), or after `ms` */
  sessionEndedWithin(ms: number): Promise<void> {
    if (this.sessionDone) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.endWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** free every unfinished item's bytes (the run ended; nothing more is reassembled) */
  releaseAll(): void {
    for (const item of this.items.values()) this.release(item);
    this.items.clear();
  }

  private release(item: EvidenceItem): void {
    this.inFlightBytes -= item.bytes;
    globalInFlightBytes = Math.max(0, globalInFlightBytes - item.reserved);
  }

  private dropItem(itemNo: number): void {
    const item = this.items.get(itemNo);
    if (!item) return;
    this.items.delete(itemNo);
    this.release(item);
  }

  private finish(r: RobotRunResult | null): void {
    if (this.done) return;
    this.done = true;
    this.result = r;
    this.releaseAll();
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
    // a session that closed meanwhile (the run ended) takes no answer: dropped, never an unhandled rejection
    const reply = (status: number, body: unknown) => {
      try {
        session.push(JSON.stringify({ t: "http_res", id: frame.id, status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)).toString("base64") }));
      } catch {
        /* the session is closed */
      }
    };
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
      return [200, { cancel: mode === "halted" || mode === "read_only" || overTime || this.done || this.cancelled || this.forced !== null }];
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
    if (this.done || this.forced) return [409, { error: "run_already_ended" }];
    if (this.plan.screenshots === "none" && e.kind === "screenshot") return [409, { error: "screenshots_off" }];
    const data = Buffer.from(e.dataBase64, "base64");
    let item = this.items.get(e.item);
    if (!item) {
      if (e.chunk !== 0 || this.storedItemNos.has(e.item) || this.storedItemNos.size + this.items.size >= ROBOT_RUN_LIMITS.evidenceItems) {
        return [409, { error: "evidence_refused" }];
      }
      // B4 / N-B: a new item reserves its kind's most against the gateway-wide cap. When other runs hold that cap,
      // this chunk is not taken and the runner is told to send the SAME chunk again shortly (503 `evidence_busy`,
      // `retryAfterMs`): one run's evidence never fails another's. Only this run's own cap (below) fails a run.
      const reserve = e.kind === "download" ? this.plan.limits.downloadBytes : ROBOT_RUN_LIMITS.screenshotBytes;
      if (globalInFlightBytes + reserve > inFlightCaps.globalBytes) {
        return [503, { error: "evidence_busy", retryAfterMs: ROBOT_EVIDENCE_RETRY_AFTER_MS }];
      }
      globalInFlightBytes += reserve;
      item = { kind: e.kind, step: e.step, contentType: e.contentType, chunks: [], bytes: 0, reserved: reserve, next: 0 };
      this.items.set(e.item, item);
    }
    if (e.chunk !== item.next || e.kind !== item.kind) return [409, { error: "evidence_out_of_order" }];
    const cap = item.reserved;
    if (item.bytes + data.length > cap) {
      this.dropItem(e.item);
      return [413, { error: "evidence_too_large" }];
    }
    // B4: the bytes this run holds while its items arrive are bounded; over that, the run fails
    if (this.inFlightBytes + data.length > inFlightCaps.perRunBytes) {
      this.dropItem(e.item);
      this.forced = "evidence_too_large";
      return [413, { error: "evidence_too_large" }];
    }
    item.chunks.push(data);
    item.bytes += data.length;
    this.inFlightBytes += data.length;
    item.next += 1;
    if (!e.last) return [200, { ok: true }];
    const bytes = Buffer.concat(item.chunks);
    this.dropItem(e.item);
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
    const withheld = await this.store(e.item, item, bytes, sha256);
    this.storedItemNos.add(e.item);
    return [200, { ok: true, sha256, ...(withheld ? { bytesWithheld: withheld } : {}) }];
  }

  /** record one item; its bytes go to the store unless the PII mode or a missing store withholds them */
  private async store(itemNo: number, item: EvidenceItem, bytes: Buffer, sha256: string): Promise<"pii_block" | "no_store" | null> {
    const store = this.deps.store;
    const withheld = item.kind === "download" && this.downloads === "digest_only" ? "pii_block" : !store ? "no_store" : null;
    if (store && withheld === null) {
      const key = artifactStorageKey(sha256);
      if (!(await store.has(key))) await putBytes(store, key, sha256, bytes, "robot-evidence-");
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
        bytesWithheld: withheld,
      }),
    );
    return withheld;
  }
}

/** the marker the executor puts where it cut an over-long Smokescreen log (sandbox-executor `egressLogMarker`) */
const EGRESS_LOG_TRUNCATION_RE = /\n\[regulait: egress log truncated, (\d+) bytes dropped\]\n/;

/**
 * The executor's end of a robot placement carries the run's Smokescreen log (capped by the executor); it is stored as
 * that run's `egress_log` evidence, in the end call's own transaction (`ExecutorChannelOptions.robotEgressLog`). It
 * holds host names and verdicts only: the run's secrets never reach the proxy (TLS is end to end through CONNECT).
 *
 * The log takes the ONE reserved item `ROBOT_EGRESS_LOG_ITEM` (64), outside the runner's 0..63, and only the log may
 * take it (the database CHECK): a runner can neither upload an `egress_log` nor crowd the log out by filling its own
 * items. Every end is audited on the run: `robot-run-egress-log` (the log's sha256, its size and whether the executor
 * truncated it), or `robot-run-egress-log-missing` when the end carried no log or the slot was already taken. The
 * run's end audit may already be written by then, so this is its own row on the run.
 */
export function robotEgressLogHook(store: ArtifactStore | null) {
  return async (
    tx: Db,
    end: { offerId: string; placementId: string | null; log: string | null; sha256: string | null; outcome: string },
  ): Promise<void> => {
    // the executor's end runs as the executor's principal, which the robot tables' policies do not open: the reads
    // and the evidence write below are the gateway's own (system_task) steps inside that transaction
    const [offer] = await tx.select({ robotRunId: executionOffers.robotRunId }).from(executionOffers).where(eq(executionOffers.id, end.offerId));
    if (!offer?.robotRunId) return;
    const runId = offer.robotRunId;
    const [run] = (await withinSystemReason(tx, "system_task", "robot-run.egress-log-read", () =>
      tx.select({ requestedBy: robotRuns.requestedBy }).from(robotRuns).where(eq(robotRuns.id, runId)),
    )) as Array<{ requestedBy: string }>;
    if (!run) return;
    const audit = (ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny") =>
      tx.insert(auditLog).values({ userId: run.requestedBy, objectType: "robot_run", objectId: runId, detail, effect, ruleId, ruleChain: [], reason });
    const base = { offerId: end.offerId, placementId: end.placementId, outcome: end.outcome, item: ROBOT_EGRESS_LOG_ITEM };
    if (end.log === null || end.sha256 === null) {
      await audit(
        "robot-run-egress-log-missing",
        "The executor ended the robot run's sandbox without its egress log; the run has no egress evidence.",
        { ...base, dropped: "not_sent" },
        "deny",
      );
      return;
    }
    const bytes = Buffer.from(end.log, "utf8");
    const cut = EGRESS_LOG_TRUNCATION_RE.exec(end.log);
    const facts = { sha256: end.sha256, sizeBytes: bytes.length, truncated: cut !== null, ...(cut ? { droppedBytes: Number(cut[1]) } : {}) };
    if (store) {
      const key = artifactStorageKey(end.sha256);
      if (!(await store.has(key))) await putBytes(store, key, end.sha256, bytes, "robot-egress-");
    }
    const bytesWithheld = store ? null : ("no_store" as const);
    const sha256 = end.sha256;
    const stored = (await withinSystemReason(tx, "system_task", "robot-run.egress-log", () =>
      tx
        .insert(robotRunEvidence)
        .values({
          robotRunId: runId,
          item: ROBOT_EGRESS_LOG_ITEM,
          kind: "egress_log",
          step: null,
          contentType: "text/plain",
          sha256,
          sizeBytes: bytes.length,
          bytesWithheld,
        })
        // one log per run: an end is accepted once, so a taken slot means a second log, recorded below as dropped
        .onConflictDoNothing({ target: [robotRunEvidence.robotRunId, robotRunEvidence.item] })
        .returning({ id: robotRunEvidence.id }),
    )) as Array<{ id: string }>;
    if (stored.length === 0) {
      await audit(
        "robot-run-egress-log-missing",
        "A second egress log for the robot run was not stored: the run's egress log slot is already taken.",
        { ...base, ...facts, dropped: "slot_taken" },
        "deny",
      );
      return;
    }
    await audit(
      "robot-run-egress-log",
      `The robot run's egress log was stored (${bytes.length} bytes${cut ? ", truncated by the executor" : ""}).`,
      { ...base, ...facts, bytesWithheld },
      "allow",
    );
  };
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

/**
 * ADR-0190 slice I5 — ENGINE WORKERS UNDER EXECUTION PROFILES, gateway side.
 *
 * An ADR-0187 engine's worker (the garak and promptfoo workers, the modelscan scanner) runs ONLY in a sandbox an
 * executor started under the run's `engine_worker` placement. There is no other place it can run: the runner never
 * runs the engine (a static guard proves its entry points cannot), no long-lived worker container exists, and a
 * placement that cannot be made ends the run `not_run` (`isolation_unavailable`, decision 7). This module is the
 * gateway's part:
 *
 *   THE TASK START DECISION (`POST /v1/engine-runner/runs/:runId/task/input`). The runner holding a live lease hands
 *   over the task's input. In ONE transaction the gateway:
 *     1. re-checks the run (leased to this runner, live, no task yet) and, for an agent run, the run-as person's
 *        entitlement to the target and judge agents (the engine-run entitlement decision, ADR-0187);
 *     2. decides the placement (decision 7 through I2's `resolveRequirement`, then I4's linked offer): workload kind
 *        `engine_worker`, NO agent (our own worker image: OWNER DECISION C keeps it a known subject at the
 *        `engine_worker` floor, never the unknown-agent rule), the run's project (sensitivity, compliance tags), the
 *        manifest's task image. The placement row is keyed to the decision's audit id (the I4/I8 contract);
 *     3. writes the decision: an `agent` decision (`detail.phase` = engine-run-entitlement, receipt-eligible, so its
 *        facts capture the placement) for an agent run, an `engine_run` decision for an artifact scan. A refused
 *        placement makes it a refusal (rule id `execution-profile`) and ends the run `not_run` in the same
 *        transaction;
 *     4. names the placement on the run (`engine_runs.task_placement_id`, migration 0200, set once).
 *   After the commit the task's session is held here (an I4 stdio session, so the executor's channel routes serve
 *   it unchanged): the input, the task secret for the MACed `start` line, and the sandbox's stdout for the runner.
 *
 *   THE INPUT (`GET /v1/executor-channel/offers/:offerId/input[/:n]`): the manifest and each file, to the executor that
 *   accepted the offer, before its report; the run's artifact is streamed from the artifact store (never through the
 *   runner). The report must then name the same input digest (`input_digest_mismatch` otherwise, executor-channel.ts).
 *
 *   THE FRAMES (`GET`/`POST /v1/engine-runner/runs/:runId/task/frames`): the runner reads the sandbox's stdout frames
 *   (result files, gateway-channel requests) and writes stdin frames (gateway-channel answers) or closes the task.
 *
 * WHERE A TASK LIVES. As an I4 stdio session: in the gateway process that decided it. A request for a task this
 * process does not hold is refused `engine_task_unknown` (fail closed); multi-replica gateways need sticky routing on
 * the run and offer ids, the same follow-up as I4's.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  eq,
  engineRuns,
  executionOffers,
  executionPlacementReports,
  modelArtifacts,
  users,
  type Db,
  type EngineRunRow,
  type ExecutorRow,
} from "@regulait/db";
import {
  ENGINE_RUN_ENTITLEMENT_PHASE,
  ENGINE_TASK_FRAMES_MAX,
  ENGINE_TASK_OUTPUT_BUFFER_MAX_BYTES,
  ENGINE_TASK_UPLOAD_BODY_LIMIT_BYTES,
  EXECUTION_PROFILE_RULE_ID,
  EXECUTOR_CHANNEL_PREFIX,
  STDIO_MAX_LIVE_SESSIONS,
  engineTaskFramesPostSchema,
  engineTaskInFrameSchema,
  engineTaskInputDigest,
  engineTaskInputUploadSchema,
  stdioLineBytes,
  type EngineId,
  type EngineManifestEntry,
  type EngineTaskFramesResponse,
  type EngineTaskInputFile,
  type EngineTaskInputManifest,
  type EngineTaskState,
  type ExecutionRefusalReason,
} from "@regulait/shared";
import { databaseNow } from "./delegation.js";
import { expireOffers, offerLinkedPlacement, pickLinkedReport, refusedLinkedPlacement } from "./executor-channel.js";
import { resolveRequirement } from "./execution-placement.js";
import { holdStdioSession, liveStdioSessions, StdioSession, watchHeldStdioSession } from "./executor-stdio.js";
import { buildAgentDecider } from "./evals.js";
import type { ArtifactStore } from "./model-artifacts.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** the error code a run ends with when its task cannot be placed (decision 7: never clean, never run elsewhere) */
export const ENGINE_TASK_ISOLATION_UNAVAILABLE = "isolation_unavailable" as const;

// ---------------------------------------------------------------------------
// The tasks this process holds
// ---------------------------------------------------------------------------

interface HeldFile {
  meta: EngineTaskInputFile;
  /** inline bytes, or the artifact the gateway streams from its store */
  source: { kind: "inline"; bytes: Buffer } | { kind: "artifact"; artifactId: string; storageKey: string };
}

/** one engine task: its decision, its offer, its input, and the sandbox's stdout for the runner */
export class EngineTask {
  readonly files: HeldFile[];
  readonly manifest: EngineTaskInputManifest;
  /** stdout frames not yet acknowledged by the runner (dropped once `from` passes them) */
  private out: Array<{ seq: number; data: string; bytes: number }> = [];
  private outBytes = 0;
  private nextOut = 0;
  private ackedTo = 0;
  eof = false;
  /** why the task cannot (or can no longer) run: a decision 7 code, a mismatch, or a session failure */
  refusal: string | null = null;
  private waiters: Array<() => void> = [];

  constructor(
    readonly runId: string,
    readonly runnerId: string,
    readonly placementId: string,
    readonly offerId: string,
    readonly session: StdioSession,
    files: HeldFile[],
  ) {
    this.files = [...files].sort((a, b) => (a.meta.path < b.meta.path ? -1 : a.meta.path > b.meta.path ? 1 : 0));
    const metas = this.files.map((f) => f.meta);
    this.manifest = { input: "jobs", files: metas, digest: engineTaskInputDigest(metas) };
    session.attached = true;
    session.onLine = (line) => this.take(line);
    session.onEnd = () => {
      if (session.lostReason !== null && this.refusal === null) this.refusal = "session_lost";
      this.eof = true;
      this.wake();
    };
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** one stdout line of the sandbox, held for the runner (bounded: past the bound the task is stopped) */
  private take(line: string) {
    if (line.trim() === "") return;
    const n = stdioLineBytes(line);
    if (this.outBytes + n > ENGINE_TASK_OUTPUT_BUFFER_MAX_BYTES) {
      if (this.refusal === null) this.refusal = "output_overflow";
      this.session.close();
      this.wake();
      return;
    }
    this.out.push({ seq: this.nextOut++, data: line, bytes: n });
    this.outBytes += n;
    this.wake();
  }

  /** acknowledge every frame below `from`; false when `from` names frames already dropped or never held */
  ack(from: number): boolean {
    if (from < this.ackedTo || from > this.nextOut) return false;
    while (this.out.length > 0 && this.out[0]!.seq < from) this.outBytes -= this.out.shift()!.bytes;
    this.ackedTo = from;
    return true;
  }

  framesFrom(from: number): Array<{ seq: number; data: string }> {
    return this.out.filter((f) => f.seq >= from).slice(0, ENGINE_TASK_FRAMES_MAX).map(({ seq, data }) => ({ seq, data }));
  }

  get nextSeq(): number {
    return this.nextOut;
  }

  async waitForWork(ms: number, from: number): Promise<void> {
    if (this.nextOut > from || this.eof || this.refusal !== null) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

const tasksByRun = new Map<string, EngineTask>();
const tasksByOffer = new Map<string, EngineTask>();

function forget(task: EngineTask): void {
  if (tasksByRun.get(task.runId) === task) tasksByRun.delete(task.runId);
  if (tasksByOffer.get(task.offerId) === task) tasksByOffer.delete(task.offerId);
}

/** the input digest of an engine task this process holds, by its offer (null: none held here) */
export function engineTaskInputDigestFor(offerId: string): string | null {
  return tasksByOffer.get(offerId)?.manifest.digest ?? null;
}

/** tests only: how many engine tasks this process holds */
export function liveEngineTasks(): number {
  return tasksByRun.size;
}

/**
 * Tests only: restrict engine task placements to these executors (the broker's `onlyExecutorIds`), as I4's stdio
 * seam. Every gateway test file shares one database. Null (the default, and always in the product) = every executor.
 */
let testAffinity: readonly string[] | null = null;
export function setEngineTaskPlacementAffinityForTest(ids: readonly string[] | null): void {
  testAffinity = ids;
}

// ---------------------------------------------------------------------------
// The task start decision
// ---------------------------------------------------------------------------

export interface EngineTaskDeps {
  manifest: () => Readonly<Record<EngineId, EngineManifestEntry>>;
  artifactStore: () => ArtifactStore | null;
  /** end a locked run (engine-runs.ts's single terminal path, in the caller's transaction) */
  endRunTx: (tx: Tx, run: EngineRunRow, end: { status: "not_run"; errorCode: string; cause: string }, now: Date) => Promise<EngineRunRow | null>;
  /** tell the run's workflow stage, after the commit */
  notifyEnded: (db: Db, runs: EngineRunRow[]) => Promise<void>;
}

type StartOutcome =
  | { kind: "refused_request"; status: number; error: string; detail?: string }
  | { kind: "not_entitled"; ended: EngineRunRow | null }
  | { kind: "unplaced"; code: ExecutionRefusalReason; placementId: string | null; ended: EngineRunRow | null }
  | { kind: "offered"; placementId: string; offerId: string; executorId: string; files: HeldFile[]; secret: string | null; run: EngineRunRow };

const runParam = z.object({ runId: z.string().uuid() });

function inlineFile(path: string, data: string): HeldFile {
  const bytes = Buffer.from(data, "base64");
  return { meta: { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, source: { kind: "inline", bytes } };
}

/**
 * THE TASK START, in one transaction (see the module comment). Exported for the suite; the route below is its only
 * product caller.
 */
export async function startEngineTask(db: Db, deps: EngineTaskDeps, runnerId: string, runId: string, body: z.infer<typeof engineTaskInputUploadSchema>): Promise<StartOutcome> {
  const manifests = deps.manifest();
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.id, runId)).for("update");
    if (!run || run.runnerId !== runnerId || run.status !== "leased") return { kind: "refused_request" as const, status: 409, error: "engine_run_not_leased" };
    // M-075: the database clock decides liveness, as the lease and the heartbeat do
    const now = await databaseNow(txDb);
    if ((run.deadlineAt && run.deadlineAt <= now) || (run.leaseExpiresAt && run.leaseExpiresAt <= now)) {
      return { kind: "refused_request" as const, status: 409, error: "engine_run_not_leased", detail: "the run's lease or deadline has passed" };
    }
    if (run.taskPlacementId !== null) return { kind: "refused_request" as const, status: 409, error: "engine_task_started", detail: "a run's task is started once; its input never changes" };
    const m = manifests[run.engineId as EngineId];
    // the input: inline files from the runner, the run's own artifact by reference (and only that one)
    if (run.targetKind === "artifact" ? body.artifact === null || run.targetArtifactId === null : body.artifact !== null) {
      return { kind: "refused_request" as const, status: 422, error: "engine_task_input_invalid", detail: "an artifact scan's input places the run's artifact; an agent run's has none" };
    }
    if (m.needsModelAccess !== (body.secret !== null)) {
      return { kind: "refused_request" as const, status: 422, error: "engine_task_input_invalid", detail: "the task secret is the run's key: present exactly when the engine calls models" };
    }
    const files: HeldFile[] = body.files.map((f) => inlineFile(f.path, f.data));
    if (body.artifact) {
      const [art] = await tx.select().from(modelArtifacts).where(eq(modelArtifacts.id, run.targetArtifactId!));
      if (!art || !deps.artifactStore()) return { kind: "refused_request" as const, status: 409, error: "artifact_store_unavailable" };
      files.push({ meta: { path: body.artifact.path, size: art.sizeBytes, sha256: art.sha256 }, source: { kind: "artifact", artifactId: art.id, storageKey: art.storageKey } });
    }

    const userId = run.runAsUserId ?? NO_IDENTITY;
    const decisionAuditId = randomUUID();
    const isAgentRun = run.targetKind === "agent";
    const baseDetail = { engineRunId: run.id, engineId: run.engineId, runnerId, projectId: run.projectId };

    // 1. the entitlement (agent runs): the run-as person may still execute the target and the judge
    if (isAgentRun) {
      const [person] = run.runAsUserId ? await tx.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, run.runAsUserId)) : [];
      const [target] = run.targetAgentId ? await tx.select().from(agents).where(eq(agents.id, run.targetAgentId)) : [];
      const [judge] = run.judgeAgentId ? await tx.select().from(agents).where(eq(agents.id, run.judgeAgentId)) : [];
      let deny: { ruleId: string; ruleChain: unknown[]; reason: string } | null = null;
      if (!person || person.disabledAt || !target) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run-as person or the target agent is gone" };
      else {
        const decide = await buildAgentDecider(txDb, person.id);
        for (const a of [target, ...(judge ? [judge] : [])]) {
          const d = decide(a as Parameters<typeof decide>[0], "execute");
          if (d.effect !== "allow") {
            deny = { ruleId: d.ruleId, ruleChain: d.ruleChain as unknown[], reason: d.reason };
            break;
          }
        }
      }
      if (deny) {
        await tx.insert(auditLog).values({
          id: decisionAuditId,
          userId,
          objectType: "agent",
          objectId: run.targetAgentId,
          detail: { phase: ENGINE_RUN_ENTITLEMENT_PHASE, role: "target", receiptClass: "decision", ...baseDetail, step: "task_start" },
          effect: "deny",
          ruleId: deny.ruleId,
          ruleChain: deny.ruleChain as never,
          reason: deny.reason,
        });
        const ended = await deps.endRunTx(tx, run, { status: "not_run", errorCode: "run_as_not_entitled", cause: "run_as_not_entitled" }, now);
        return { kind: "not_entitled" as const, ended };
      }
    }

    // 2. the placement (decision 7), keyed to the decision written below
    const image = m.taskImage ?? "";
    let placed: { kind: "offered"; placementId: string; offerId: string; executorId: string } | { kind: "refused"; code: ExecutionRefusalReason; placementId: string | null };
    const requirement = await resolveRequirement(txDb, { workloadKind: "engine_worker", projectId: run.projectId, agent: null, parentGrantId: null });
    if (requirement.kind !== "required") {
      placed = { kind: "refused", code: "policy_unresolved", placementId: await refusedLinkedPlacement(txDb, decisionAuditId, { workloadKind: "engine_worker", imageDigest: image }, "policy_unresolved") };
    } else if (liveStdioSessions() >= STDIO_MAX_LIVE_SESSIONS) {
      placed = {
        kind: "refused",
        code: "no_executor",
        placementId: await refusedLinkedPlacement(
          txDb,
          decisionAuditId,
          { workloadKind: "engine_worker", imageDigest: image, requiredClass: requirement.requiredClass, requiredBy: requirement.requiredBy, profileDigest: requirement.profile.digest },
          "no_executor",
        ),
      };
    } else {
      const out = await offerLinkedPlacement(txDb, decisionAuditId, {
        workloadKind: "engine_worker",
        requiredClass: requirement.requiredClass,
        requiredBy: requirement.requiredBy,
        profileDigest: requirement.profile.digest,
        imageDigest: image,
        ...(testAffinity ? { onlyExecutorIds: testAffinity } : {}),
      });
      placed = out.kind === "offered" ? { kind: "offered", placementId: out.placementId, offerId: out.offerId, executorId: out.executorId } : out;
    }

    // 3. the decision (its facts read the placement above in this transaction)
    const refused = placed.kind === "refused";
    const decisionDetail = {
      ...baseDetail,
      step: "task_start",
      placementId: placed.placementId,
      ...(placed.kind === "offered" ? { offerId: placed.offerId, executorId: placed.executorId } : { code: placed.code }),
      inputDigest: engineTaskInputDigest(files.map((f) => f.meta)),
      ...(refused ? { refusalRuleId: EXECUTION_PROFILE_RULE_ID } : {}),
    };
    const reason =
      placed.kind === "refused"
        ? `${run.engineId} run ${run.id} cannot start: no executor can place its worker (${placed.code}); it ends not_run, nothing ran (ADR-0190 decision 7, I5; no fallback)`
        : `${run.engineId} run ${run.id} starts: its worker is offered to executor ${placed.executorId} under the engine_worker placement (ADR-0190 I5)`;
    if (isAgentRun) {
      await tx.insert(auditLog).values({
        id: decisionAuditId,
        userId,
        objectType: "agent",
        objectId: run.targetAgentId,
        detail: { phase: ENGINE_RUN_ENTITLEMENT_PHASE, role: "target", receiptClass: "decision", ...decisionDetail },
        effect: refused ? "deny" : "allow",
        ruleId: refused ? EXECUTION_PROFILE_RULE_ID : "engine-run-task-started",
        ruleChain: [],
        reason,
      });
    } else {
      await tx.insert(auditLog).values({
        id: decisionAuditId,
        userId,
        objectType: "engine_run",
        objectId: run.id,
        detail: decisionDetail,
        effect: refused ? "deny" : "allow",
        ruleId: refused ? EXECUTION_PROFILE_RULE_ID : "engine-run-task-started",
        ruleChain: [],
        reason,
      });
    }
    if (placed.kind === "refused") {
      const ended = await deps.endRunTx(tx, run, { status: "not_run", errorCode: ENGINE_TASK_ISOLATION_UNAVAILABLE, cause: ENGINE_TASK_ISOLATION_UNAVAILABLE }, now);
      return { kind: "unplaced" as const, code: placed.code, placementId: placed.placementId, ended };
    }
    // 4. the run names its placement (set once: migration 0200's trigger)
    const [updated] = await tx.update(engineRuns).set({ taskPlacementId: placed.placementId }).where(eq(engineRuns.id, run.id)).returning();
    return { kind: "offered" as const, placementId: placed.placementId, offerId: placed.offerId, executorId: placed.executorId, files, secret: body.secret, run: updated! };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** a task's state as the runner sees it, from the placement's linked report and the session */
async function taskState(db: Db, task: EngineTask): Promise<{ state: EngineTaskState; refusal: string | null }> {
  if (task.refusal !== null) return { state: "refused", refusal: task.refusal };
  // an offer whose deadline passed is expired (its refused report row written) before it is read, as awaitPlacement does
  await expireOffers(db);
  const rows = await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, task.placementId));
  const r = pickLinkedReport(rows);
  if (r && r.outcome !== "placed") {
    task.refusal = r.outcome === "mismatch" ? "execution_profile_mismatch" : (r.refusalCode ?? r.endCode ?? r.outcome);
    return { state: "refused", refusal: task.refusal };
  }
  if (!r) {
    const [o] = await db.select({ status: executionOffers.status }).from(executionOffers).where(eq(executionOffers.id, task.offerId));
    if (o && (o.status === "expired" || o.status === "declined" || o.status === "withdrawn")) return { state: "refused", refusal: `offer_${o.status}` };
    return { state: "awaiting_placement", refusal: null };
  }
  return { state: task.eof ? "ended" : "running", refusal: null };
}

/** the run's task is over (its run ended, or the session did and the runner read everything): stop and forget it */
function closeTask(task: EngineTask): void {
  task.session.close();
  task.session.end();
  forget(task);
}

/** a watchdog: a task whose run is no longer leased is stopped (a cancel, a timeout, a result: nothing runs on) */
export const ENGINE_TASK_WATCHDOG_MS = 2_000;
function watchRun(db: Db, task: EngineTask): void {
  const timer = setInterval(() => {
    if (!tasksByRun.has(task.runId)) {
      clearInterval(timer);
      return;
    }
    void (async () => {
      const [r] = await db.select({ status: engineRuns.status }).from(engineRuns).where(eq(engineRuns.id, task.runId));
      if (!r || r.status !== "leased") {
        clearInterval(timer);
        closeTask(task);
      }
    })().catch(() => undefined);
  }, ENGINE_TASK_WATCHDOG_MS);
  timer.unref?.();
}

export function registerEngineTaskRoutes(app: FastifyInstance, db: Db, deps: EngineTaskDeps): void {
  // ---- the task start: the input, the decision, the placement ---------------------------------------------------
  app.post("/v1/engine-runner/runs/:runId/task/input", { bodyLimit: ENGINE_TASK_UPLOAD_BODY_LIMIT_BYTES }, async (req, reply) => {
    const p = runParam.safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_run" });
    const runnerId = req.authCtx.engineRunnerId!;
    const body = engineTaskInputUploadSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "engine_task_input_invalid", issues: body.error.issues.slice(0, 10).map((i) => ({ path: i.path, message: i.message })) });
    const out = await startEngineTask(db, deps, runnerId, p.data.runId, body.data);
    if (out.kind === "refused_request") return reply.status(out.status).send({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
    if (out.kind === "not_entitled") {
      if (out.ended) await deps.notifyEnded(db, [out.ended]);
      return reply.status(403).send({ error: "run_as_not_entitled", detail: "the run ended not_run: its run-as person may no longer execute its agents" });
    }
    if (out.kind === "unplaced") {
      if (out.ended) await deps.notifyEnded(db, [out.ended]);
      return reply.status(409).send({ statusCode: 409, error: "execution_profile_unavailable", ruleId: EXECUTION_PROFILE_RULE_ID, reason: out.code, placementId: out.placementId });
    }
    const m = deps.manifest()[out.run.engineId as EngineId];
    const session = new StdioSession(out.offerId, out.executorId, { command: m.taskEntry.command, args: [...m.taskEntry.args] });
    if (out.secret !== null) session.secret = out.secret;
    const task = new EngineTask(out.run.id, runnerId, out.placementId, out.offerId, session, out.files);
    if (!holdStdioSession(session)) {
      // the cap was reached between the decision and now: the offer stays unattached and expires (its report row says so)
      return reply.status(503).send({ error: "engine_task_capacity" });
    }
    tasksByRun.set(task.runId, task);
    tasksByOffer.set(task.offerId, task);
    watchHeldStdioSession(db, session);
    watchRun(db, task);
    return reply.status(201).send({ placementId: out.placementId, offerId: out.offerId, inputDigest: task.manifest.digest });
  });

  // ---- the sandbox's stdout, for the runner (long-polled, acknowledged with `from`) ----------------------------------
  app.get("/v1/engine-runner/runs/:runId/task/frames", async (req, reply) => {
    const p = runParam.safeParse(req.params);
    const q = z
      .object({ from: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), wait: z.coerce.number().int().min(0).max(25).default(0) })
      .safeParse(req.query ?? {});
    if (!p.success || !q.success) return reply.status(400).send({ error: "invalid_query" });
    const task = tasksByRun.get(p.data.runId);
    if (!task || task.runnerId !== req.authCtx.engineRunnerId) return reply.status(409).send({ error: "engine_task_unknown", detail: "this gateway process holds no task of that run for this runner" });
    if (!task.ack(q.data.from)) return reply.status(409).send({ error: "engine_task_from_invalid" });
    const until = Date.now() + q.data.wait * 1000;
    let st = await taskState(db, task);
    while (task.framesFrom(q.data.from).length === 0 && st.state !== "refused" && !task.eof && Date.now() < until) {
      await task.waitForWork(Math.min(250, Math.max(1, until - Date.now())), q.data.from);
      st = await taskState(db, task);
    }
    const frames = task.framesFrom(q.data.from);
    const last = frames.length > 0 ? frames[frames.length - 1]!.seq + 1 : q.data.from;
    const drained = last >= task.nextSeq;
    const body: EngineTaskFramesResponse = { state: st.state, frames, nextSeq: last, eof: task.eof && drained, refusal: st.refusal };
    // everything was read and nothing more can come: the task is forgotten here
    if ((task.eof && drained) || st.state === "refused") forget(task);
    return reply.send(body);
  });

  // ---- stdin frames for the sandbox (the gateway channel's answers), or close it --------------------------------------
  app.post("/v1/engine-runner/runs/:runId/task/frames", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const p = runParam.safeParse(req.params);
    const body = engineTaskFramesPostSchema.safeParse(req.body);
    if (!p.success || !body.success) return reply.status(400).send({ error: "invalid_body" });
    const task = tasksByRun.get(p.data.runId);
    if (!task || task.runnerId !== req.authCtx.engineRunnerId) return reply.status(409).send({ error: "engine_task_unknown" });
    for (const line of body.data.frames) {
      // only the frames the contract names reach the sandbox
      let ok = false;
      try {
        ok = engineTaskInFrameSchema.safeParse(JSON.parse(line)).success;
      } catch {
        ok = false;
      }
      if (!ok) return reply.status(400).send({ error: "engine_task_frame_invalid" });
    }
    try {
      for (const line of body.data.frames) task.session.push(line);
    } catch (e) {
      return reply.status(409).send({ error: "engine_task_closed", detail: (e as Error).message });
    }
    if (body.data.close) task.session.close();
    return reply.status(204).send();
  });
}

// ---------------------------------------------------------------------------
// The executor's input routes (inside the executor channel scope, behind its one-use proof)
// ---------------------------------------------------------------------------

export interface EngineTaskChannelDeps {
  authed: (req: FastifyRequest, reply: FastifyReply) => Promise<ExecutorRow | null>;
  refused: (reply: FastifyReply, status: number, code: string, executor: ExecutorRow | null, extra?: Record<string, unknown>) => FastifyReply;
  artifactStore: () => ArtifactStore | null;
}

interface ChannelScope {
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): unknown;
}

/** the offer is this executor's and ACCEPTED (input is fetched between accept and report, never after) */
async function acceptedOfferOf(db: Db, executorId: string, offerId: string): Promise<boolean> {
  const [o] = await db
    .select({ status: executionOffers.status, kind: executionOffers.workloadKind })
    .from(executionOffers)
    .where(and(eq(executionOffers.id, offerId), eq(executionOffers.executorId, executorId)));
  return o?.status === "accepted" && o.kind === "engine_worker";
}

export function registerEngineTaskChannelRoutes(scope: ChannelScope, db: Db, deps: EngineTaskChannelDeps): void {
  const offerParam = z.object({ offerId: z.string().uuid() });
  scope.get(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/input`, async (req, reply) => {
    const executor = await deps.authed(req, reply);
    if (!executor) return reply;
    const p = offerParam.safeParse(req.params);
    if (!p.success) return deps.refused(reply, 400, "invalid_offer", executor);
    if (!(await acceptedOfferOf(db, executor.id, p.data.offerId))) return deps.refused(reply, 409, "offer_unavailable", executor);
    const task = tasksByOffer.get(p.data.offerId);
    if (!task) return deps.refused(reply, 409, "engine_task_unknown", executor);
    return reply.send(task.manifest);
  });

  scope.get(`${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/input/:n`, async (req, reply) => {
    const executor = await deps.authed(req, reply);
    if (!executor) return reply;
    const p = z.object({ offerId: z.string().uuid(), n: z.coerce.number().int().min(0).max(63) }).safeParse(req.params);
    if (!p.success) return deps.refused(reply, 400, "invalid_offer", executor);
    if (!(await acceptedOfferOf(db, executor.id, p.data.offerId))) return deps.refused(reply, 409, "offer_unavailable", executor);
    const task = tasksByOffer.get(p.data.offerId);
    const file = task?.files[p.data.n];
    if (!task || !file) return deps.refused(reply, 409, "engine_task_unknown", executor);
    reply.header("content-type", "application/octet-stream").header("cache-control", "no-store").header("content-length", String(file.meta.size));
    if (file.source.kind === "inline") return reply.send(file.source.bytes);
    const store = deps.artifactStore();
    if (!store) return deps.refused(reply, 503, "artifact_store_unavailable", executor);
    const opened: { stream: Readable; size: number } = await store.open(file.source.storageKey);
    if (opened.size !== file.meta.size) {
      opened.stream.destroy();
      return deps.refused(reply, 500, "artifact_store_inconsistent", executor);
    }
    await db.insert(auditLog).values({
      userId: NO_IDENTITY,
      objectType: "engine_run",
      objectId: task.runId,
      detail: { phase: "task_input", offerId: task.offerId, placementId: task.placementId, executorId: executor.id, artifactId: file.source.artifactId, sha256: file.meta.sha256, sizeBytes: file.meta.size },
      effect: "allow",
      ruleId: "engine-run-artifact-streamed",
      ruleChain: [],
      reason: `artifact ${file.source.artifactId} streamed to executor ${executor.name} for the task of engine run ${task.runId} (ADR-0190 I5: the sandbox's read-only input)`,
    });
    return reply.send(opened.stream);
  });
}

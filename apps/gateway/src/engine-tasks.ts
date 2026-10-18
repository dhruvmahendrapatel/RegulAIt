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
 *     5. holds the task here BEFORE the commit (an I4 stdio session, so the executor's channel routes serve it
 *        unchanged): the input, the task secret for the MACed `start` line, and the sandbox's stdout for the runner.
 *   Any refusal after the offer (declined, expired, start failure, input digest mismatch, lost session, output
 *   overflow) ends the run `not_run` (`isolation_unavailable`) here; a result is ingested only for a run whose
 *   placement's linked report is `placed` (engine-runs.ts, review HIGH-1).
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
  ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES,
  ENGINE_TASK_UPLOAD_BODY_LIMIT_BYTES,
  EXECUTION_PROFILE_RULE_ID,
  EXECUTOR_CHANNEL_PREFIX,
  STDIO_MAX_LIVE_SESSIONS,
  engineTaskFramesPostSchema,
  engineTaskInFrameSchema,
  engineTaskInputDigest,
  engineTaskInputUploadSchema,
  engineRunNeedsJudge,
  stdioLineBytes,
  type EngineId,
  type EngineManifestEntry,
  type EngineTaskFramesResponse,
  type EngineTaskInputFile,
  type EngineTaskInputManifest,
  type EngineTaskState,
  type ExecutionRefusalReason,
} from "@regulait/shared";
import { databaseWallNow } from "./delegation.js";
import { expireOffers, linkedReportOf, offerLinkedPlacement, pickLinkedReport, refusedLinkedPlacement, type EngineTaskChannelHooks } from "./executor-channel.js";
import { resolveRequirement } from "./execution-placement.js";
import { holdStdioSession, liveStdioSessions, StdioSession, watchHeldStdioSession } from "./executor-stdio.js";
import { buildAgentDecider } from "./evals.js";
import { artifactAccessible, type ArtifactStore } from "./model-artifacts.js";
import { assertProjectAttribution } from "./projects.js";
import { errMessage } from "./err-serializer.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** the error code a run ends with when its task cannot be placed (decision 7: never clean, never run elsewhere) */
export const ENGINE_TASK_ISOLATION_UNAVAILABLE = "isolation_unavailable" as const;
/** review HIGH-1: the cause a result is refused with when no executor reported the run's task placed */
export const ENGINE_TASK_NOT_PLACED = "engine_task_not_placed" as const;

/**
 * Review HIGH-1: the run names its task placement AND that placement's linked report is `placed` (an executor started
 * the worker under the run's engine_worker profile and attested it). Read in the caller's transaction, on the locked
 * run: the result route accepts a result (any status but not_run) only when this holds.
 */
export async function engineTaskPlacedTx(tx: Tx, run: Pick<EngineRunRow, "taskPlacementId">): Promise<boolean> {
  if (run.taskPlacementId === null) return false;
  const r = await linkedReportOf(tx as unknown as Db, run.taskPlacementId);
  return r?.outcome === "placed";
}

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
  /**
   * The session's executor side was lost. Not a refusal by itself: the loss is usually the CONSEQUENCE of a refusal
   * the database already holds (the stdio watchdog ends the session once the offer reads `mismatch`), so the
   * placement's linked report is read first and `session_lost` is the refusal only when that report names none
   * (CI run 38991262736: the loss was stamped before the committed mismatch was read).
   */
  sessionLost = false;
  /** review MEDIUM-2: the refusal has ended the run (once) */
  runEnded = false;
  private released = false;
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
      if (session.lostReason !== null) this.sessionLost = true;
      this.eof = true;
      this.wake();
    };
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /**
   * one stdout line of the sandbox, held for the runner (bounded per task AND across every task this process holds,
   * review LOW-4: past either bound the task is stopped `output_overflow`, which ends its run not_run)
   */
  private take(line: string) {
    if (line.trim() === "" || this.released) return;
    const n = stdioLineBytes(line);
    if (this.outBytes + n > ENGINE_TASK_OUTPUT_BUFFER_MAX_BYTES || bufferedTotal + n > bufferedTotalCap) {
      if (this.refusal === null) this.refusal = "output_overflow";
      this.session.close();
      this.wake();
      return;
    }
    this.out.push({ seq: this.nextOut++, data: line, bytes: n });
    this.outBytes += n;
    bufferedTotal += n;
    this.wake();
  }

  /** the task is forgotten: its held output no longer counts (and nothing more is held) */
  release(): void {
    if (this.released) return;
    this.released = true;
    bufferedTotal -= this.outBytes;
    this.outBytes = 0;
    this.out = [];
  }

  /** acknowledge every frame below `from`; false when `from` names frames already dropped or never held */
  ack(from: number): boolean {
    if (from < this.ackedTo || from > this.nextOut) return false;
    while (this.out.length > 0 && this.out[0]!.seq < from) {
      const b = this.out.shift()!.bytes;
      this.outBytes -= b;
      bufferedTotal -= b;
    }
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

/**
 * Review LOW-4: the unacknowledged task output this process holds, across every task, and its cap
 * (ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES; tests lower it). Without it 32 MiB per task times the live-session cap could
 * hold gigabytes.
 */
let bufferedTotal = 0;
let bufferedTotalCap: number = ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES;
export function engineTaskBufferedBytes(): number {
  return bufferedTotal;
}
export function setEngineTaskOutputTotalCapForTest(n: number | null): void {
  bufferedTotalCap = n ?? ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES;
}

const tasksByRun = new Map<string, EngineTask>();
const tasksByOffer = new Map<string, EngineTask>();

function forget(task: EngineTask): void {
  task.release();
  if (tasksByRun.get(task.runId) === task) tasksByRun.delete(task.runId);
  if (tasksByOffer.get(task.offerId) === task) tasksByOffer.delete(task.offerId);
}

/** the input digest of an engine task this process holds, by its offer (null: none held here) */
export function engineTaskInputDigestFor(offerId: string): string | null {
  return tasksByOffer.get(offerId)?.manifest.digest ?? null;
}

/** recheck L3: the refusal this process holds for a run's task (null: none, or no task held here) */
export function engineTaskRefusalOf(runId: string): string | null {
  const t = tasksByRun.get(runId);
  if (!t) return null;
  return t.refusal ?? (t.sessionLost ? "session_lost" : null);
}

/**
 * tests only: the state a task on this placement reads (the runner's frames read), with its session lost or not. Lets a
 * suite pin the refusal ORDER directly: a refusal the database holds wins over a lost session, which is the refusal
 * only when the placement's linked report names none.
 */
export async function readEngineTaskStateForTest(
  db: Db,
  t: { runId: string; placementId: string; offerId: string; sessionLost: boolean; eof?: boolean },
): Promise<{ state: EngineTaskState; refusal: string | null }> {
  const task = { runId: t.runId, placementId: t.placementId, offerId: t.offerId, refusal: null, sessionLost: t.sessionLost, eof: t.eof ?? false } as unknown as EngineTask;
  return readTaskState(db, task);
}

/** tests only: whether this process holds a task for the run */
export function engineTaskHeldFor(runId: string): boolean {
  return tasksByRun.has(runId);
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
  | { kind: "not_entitled"; code: string; ended: EngineRunRow | null }
  | { kind: "unplaced"; code: ExecutionRefusalReason; placementId: string | null; ended: EngineRunRow | null }
  | { kind: "offered"; task: EngineTask; run: EngineRunRow };

/** the live-session cap was reached between the check and the hold: the start is rolled back (nothing was offered) */
class EngineTaskCapacityError extends Error {}

const runParam = z.object({ runId: z.string().uuid() });

function inlineFile(path: string, data: string): HeldFile {
  const bytes = Buffer.from(data, "base64");
  return { meta: { path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, source: { kind: "inline", bytes } };
}

/**
 * THE TASK START, in one transaction (see the module comment). Exported for the suite; the route below is its only
 * product caller.
 *
 * Review MEDIUM-2: the task is HELD (its session under the offer id, its input under the run and offer ids) INSIDE the
 * transaction, before the commit makes the offer visible to any executor; a rollback forgets it. An executor that
 * accepts the offer therefore always finds its input here (never `engine_task_unknown` from a commit-then-register
 * race). A start the live-session cap refuses after the check is rolled back and the run ends not_run.
 */
export async function startEngineTask(db: Db, deps: EngineTaskDeps, runnerId: string, runId: string, body: z.infer<typeof engineTaskInputUploadSchema>): Promise<StartOutcome> {
  let held: EngineTask | null = null;
  try {
    return await startEngineTaskTx(db, deps, runnerId, runId, body, (t) => (held = t));
  } catch (e) {
    const t = held as EngineTask | null;
    if (t) {
      forget(t);
      t.session.end();
    }
    if (!(e instanceof EngineTaskCapacityError)) throw e;
    const ended = await endUnstartedRun(db, deps, runnerId, runId, "engine_task_capacity");
    return { kind: "unplaced", code: "no_executor", placementId: null, ended };
  }
}

/** a run whose task could not even be offered (the start was rolled back): it ends not_run, isolation_unavailable */
async function endUnstartedRun(db: Db, deps: EngineTaskDeps, runnerId: string, runId: string, cause: string): Promise<EngineRunRow | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.id, runId)).for("update");
    if (!run || run.runnerId !== runnerId || run.status !== "leased" || run.taskPlacementId !== null) return null;
    return deps.endRunTx(tx, run, { status: "not_run", errorCode: ENGINE_TASK_ISOLATION_UNAVAILABLE, cause }, await databaseWallNow(tx as unknown as Db));
  });
}

async function startEngineTaskTx(
  db: Db,
  deps: EngineTaskDeps,
  runnerId: string,
  runId: string,
  body: z.infer<typeof engineTaskInputUploadSchema>,
  hold: (task: EngineTask) => void,
): Promise<StartOutcome> {
  const manifests = deps.manifest();
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.id, runId)).for("update");
    if (!run || run.runnerId !== runnerId || run.status !== "leased") return { kind: "refused_request" as const, status: 409, error: "engine_run_not_leased" };
    // M-075: the database wall clock, read once the run row is locked, decides liveness, as the lease and the heartbeat do
    const now = await databaseWallNow(txDb);
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
    const [artifactRow] = body.artifact ? await tx.select().from(modelArtifacts).where(eq(modelArtifacts.id, run.targetArtifactId!)) : [];
    if (body.artifact && artifactRow) {
      if (!deps.artifactStore()) return { kind: "refused_request" as const, status: 409, error: "artifact_store_unavailable" };
      files.push({ meta: { path: body.artifact.path, size: artifactRow.sizeBytes, sha256: artifactRow.sha256 }, source: { kind: "artifact", artifactId: artifactRow.id, storageKey: artifactRow.storageKey } });
    }

    const userId = run.runAsUserId ?? NO_IDENTITY;
    const decisionAuditId = randomUUID();
    const isAgentRun = run.targetKind === "agent";
    const baseDetail = { engineRunId: run.id, engineId: run.engineId, runnerId, projectId: run.projectId };

    // 1. the lease's own checks, again (review LOW-3): the run-as person is still there; an agent run's person may
    //    still execute the target and the judge and still attribute to the run's project; an artifact scan's person
    //    may still use the artifact. A refusal ends the run `not_run` with the lease's own code.
    const [person] = run.runAsUserId
      ? await tx.select({ id: users.id, disabledAt: users.disabledAt, isAdmin: users.isAdmin }).from(users).where(eq(users.id, run.runAsUserId))
      : [];
    let deny: { ruleId: string; ruleChain: unknown[]; reason: string; code: string } | null = null;
    if (!person || person.disabledAt) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run-as person is gone", code: "run_as_gone" };
    else if (isAgentRun) {
      const [target] = run.targetAgentId ? await tx.select().from(agents).where(eq(agents.id, run.targetAgentId)) : [];
      const [judge] = run.judgeAgentId ? await tx.select().from(agents).where(eq(agents.id, run.judgeAgentId)) : [];
      if (!target) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the target agent is gone", code: "run_as_not_entitled" };
      else if (run.judgeAgentId && !judge) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the judge agent is gone", code: "run_as_not_entitled" };
      else {
        const decide = await buildAgentDecider(txDb, person.id);
        for (const a of [target, ...(judge ? [judge] : [])]) {
          const d = decide(a as Parameters<typeof decide>[0], "execute");
          if (d.effect !== "allow") {
            deny = { ruleId: d.ruleId, ruleChain: d.ruleChain as unknown[], reason: d.reason, code: "run_as_not_entitled" };
            break;
          }
        }
      }
      // as the lease: the manifest's required judge (a judge deleted since the lease nulls `judge_agent_id`), and an
      // agent with no provider model is never dispatched
      if (!deny && engineRunNeedsJudge(m, run.config.sets) && !run.judgeAgentId) {
        deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run needs a judge agent and has none", code: "judge_required" };
      }
      if (!deny && (!target!.model || (judge && !judge.model))) {
        deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the target or judge agent has no provider model", code: "agent_not_dispatchable" };
      }
      if (!deny && !run.projectId) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run's project is gone", code: "project_gone" };
      if (!deny) {
        const attribution = await assertProjectAttribution(txDb, run.projectId!, person.id, person.isAdmin);
        if (!attribution.ok) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run-as person may no longer attribute to the run's project", code: "project_not_attributable" };
      }
    } else if (!artifactRow) deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run's artifact is gone", code: "artifact_gone" };
    else if (!artifactAccessible(artifactRow, { userId: person.id, isAdmin: person.isAdmin })) {
      deny = { ruleId: "engine-run-entitlement", ruleChain: [], reason: "the run-as person may no longer use the run's artifact", code: "artifact_not_accessible" };
    }
    if (deny) {
      await tx.insert(auditLog).values({
        id: decisionAuditId,
        userId,
        objectType: isAgentRun ? "agent" : "engine_run",
        objectId: isAgentRun ? run.targetAgentId : run.id,
        detail: isAgentRun
          ? { phase: ENGINE_RUN_ENTITLEMENT_PHASE, role: "target", receiptClass: "decision", ...baseDetail, step: "task_start", code: deny.code }
          : { ...baseDetail, step: "task_start", code: deny.code },
        effect: "deny",
        ruleId: deny.ruleId,
        ruleChain: deny.ruleChain as never,
        reason: deny.reason,
      });
      const ended = await deps.endRunTx(tx, run, { status: "not_run", errorCode: deny.code, cause: deny.code }, now);
      return { kind: "not_entitled" as const, code: deny.code, ended };
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
    // 5. the task is held BEFORE the commit (review MEDIUM-2; the caller forgets it on a rollback)
    const session = new StdioSession(placed.offerId, placed.executorId, { command: m.taskEntry.command, args: [...m.taskEntry.args] });
    if (body.secret !== null) session.secret = body.secret;
    const task = new EngineTask(run.id, runnerId, placed.placementId, placed.offerId, session, files);
    if (!holdStdioSession(session)) throw new EngineTaskCapacityError("the live stdio session cap was reached");
    hold(task);
    tasksByRun.set(task.runId, task);
    tasksByOffer.set(task.offerId, task);
    return { kind: "offered" as const, task, run: updated! };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** a task's state as the runner sees it, from the placement's linked report and the session */
async function readTaskState(db: Db, task: EngineTask): Promise<{ state: EngineTaskState; refusal: string | null }> {
  if (task.refusal !== null) return { state: "refused", refusal: task.refusal };
  // an offer whose deadline passed is expired (its refused report row written) before it is read, as awaitPlacement does
  await expireOffers(db);
  const rows = await db.select().from(executionPlacementReports).where(eq(executionPlacementReports.placementId, task.placementId));
  const r = pickLinkedReport(rows);
  if (r && r.outcome !== "placed") {
    task.refusal = r.outcome === "mismatch" ? "execution_profile_mismatch" : r.outcome === "session_lost" ? "session_lost" : (r.refusalCode ?? r.endCode ?? r.outcome);
    return { state: "refused", refusal: task.refusal };
  }
  if (!r) {
    const [o] = await db.select({ status: executionOffers.status }).from(executionOffers).where(eq(executionOffers.id, task.offerId));
    if (o && (o.status === "expired" || o.status === "declined" || o.status === "withdrawn")) {
      task.refusal = `offer_${o.status}`;
      return { state: "refused", refusal: task.refusal };
    }
  }
  // only now, with no refusal on record, is a lost session the refusal
  if (task.sessionLost) {
    task.refusal = "session_lost";
    return { state: "refused", refusal: task.refusal };
  }
  if (!r) return { state: "awaiting_placement", refusal: null };
  return { state: task.eof ? "ended" : "running", refusal: null };
}

/**
 * Review MEDIUM-2: a task refused at ANY point after its offer (the offer declined or expired, a start failure, an input
 * digest mismatch, a lost session, an output overflow) ends its run `not_run` (`isolation_unavailable`) at once, here
 * in the gateway, with the refusal as the cause. The runner learns it from its next frames read and its next heartbeat
 * (`cancel`), so it is freed promptly instead of holding the lease to the deadline. Once per task; a run that is no
 * longer leased, or names another placement, is left alone.
 */
async function endRunOfRefusedTask(db: Db, deps: EngineTaskDeps, task: EngineTask): Promise<void> {
  if (task.runEnded || task.refusal === null) return;
  const cause = `engine_task_${task.refusal}`.slice(0, 120);
  const ended = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.id, task.runId)).for("update");
    if (!run || run.status !== "leased" || run.taskPlacementId !== task.placementId) return null;
    return deps.endRunTx(tx, run, { status: "not_run", errorCode: ENGINE_TASK_ISOLATION_UNAVAILABLE, cause }, await databaseWallNow(tx as unknown as Db));
  });
  // recheck L5: marked only once the transaction committed (a throw leaves it to the watchdog's next tick)
  task.runEnded = true;
  task.session.close();
  if (ended) await deps.notifyEnded(db, [ended]);
}

async function taskState(db: Db, deps: EngineTaskDeps, task: EngineTask): Promise<{ state: EngineTaskState; refusal: string | null }> {
  const st = await readTaskState(db, task);
  if (st.state === "refused") await endRunOfRefusedTask(db, deps, task);
  return st;
}

/** the run's task is over (its run ended, or the session did and the runner read everything): stop and forget it */
function closeTask(task: EngineTask): void {
  task.session.close();
  task.session.end();
  forget(task);
}

/**
 * A watchdog: a task whose run is no longer leased is stopped (a cancel, a timeout, a result: nothing runs on), and a
 * task refused while nobody reads its frames still ends its run (review MEDIUM-2).
 */
export const ENGINE_TASK_WATCHDOG_MS = 2_000;
function watchRun(db: Db, deps: EngineTaskDeps, task: EngineTask): void {
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
        return;
      }
      await taskState(db, deps, task);
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
      return reply.status(403).send({ error: out.code, detail: "the run ended not_run: the lease's checks no longer hold for its run-as person (entitlement, attribution or artifact access)" });
    }
    if (out.kind === "unplaced") {
      if (out.ended) await deps.notifyEnded(db, [out.ended]);
      return reply.status(409).send({ statusCode: 409, error: "execution_profile_unavailable", ruleId: EXECUTION_PROFILE_RULE_ID, reason: out.code, placementId: out.placementId });
    }
    const task = out.task;
    watchHeldStdioSession(db, task.session);
    watchRun(db, deps, task);
    return reply.status(201).send({ placementId: task.placementId, offerId: task.offerId, inputDigest: task.manifest.digest });
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
    let st = await taskState(db, deps, task);
    while (task.framesFrom(q.data.from).length === 0 && st.state !== "refused" && !task.eof && Date.now() < until) {
      await task.waitForWork(Math.min(250, Math.max(1, until - Date.now())), q.data.from);
      st = await taskState(db, deps, task);
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
      return reply.status(409).send({ error: "engine_task_closed", detail: errMessage(e) });
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

/** I5: the engine task side the executor channel is handed by the app (it never imports this module: no cycle) */
export const engineTaskChannelHooks: EngineTaskChannelHooks = {
  inputDigestFor: engineTaskInputDigestFor,
  registerChannelRoutes: registerEngineTaskChannelRoutes,
};

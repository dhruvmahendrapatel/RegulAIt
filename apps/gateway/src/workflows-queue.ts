/**
 * ADR-0282 / ADR-0283 / ADR-0284 (backlog P30, lane L5) — THE QUEUE UNDER PILLAR 2's STAGE RUNNER.
 *
 * pg-boss 12.38.2 is a queue here, never an execution engine. The runner (`workflows.ts`) still decides every stage
 * outcome through one kernel `transition()` with its audit row in the same transaction. This module only:
 *
 *   SEND    `enqueueStageRetry` puts a retry job on `workflow-stage-retry` through the CALLER'S transaction (the
 *           transition's), so the job exists if and only if the failure it answers committed. The job's singletonKey
 *           is the stage execution's idempotency key `<instance>:<stage>:<round>:<entry>`, and the queue's
 *           `exclusive` policy keeps at most one job per key queued, retrying or active (ADR-0284).
 *   WORK    `startStageRetryWorker` runs the jobs, on the boot path only (never under `buildApp` or vitest), with the
 *           handler the runner supplies. A handler that throws is retried by pg-boss with the job's own backoff.
 *
 * Jobs carry ids only. The schema `regulait_queue` is installed by our migration journal (pending
 * `workflow_stage_queue`, from `getConstructionPlans` of the pinned version) and pg-boss starts with `migrate: false`,
 * `schedule: false`, `supervise` only on the worker, no telemetry provider and no LISTEN/NOTIFY.
 *
 * Open-source check (ADR-0176): the queue is pg-boss (ADR-0282) and the drizzle adapter is its own `fromDrizzle`.
 * What is ours is the stage policy, the key and the audit rows.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PgBoss, fromDrizzle, type Db as PgBossDb, type DrizzleSqlTagLike, type DrizzleTransactionLike, type JobWithMetadata } from "pg-boss";
import { sql, type Db } from "@regulait/db";
import type { StageRetryPolicy } from "@regulait/workflow-kernel";
import { errLine } from "./err-serializer.js";

export const WORKFLOW_QUEUE_SCHEMA = "regulait_queue";
export const STAGE_RETRY_QUEUE = "workflow-stage-retry";
/** the worker's on/off switch: on unless it says off, forced off under vitest (like the ADR-0064 scheduler) */
export const STAGE_RETRY_WORKER_ENV = "REGULAIT_WORKFLOW_RETRY_WORKER";

/** what a retry job carries: ids only, never content (ADR-0282) */
export interface StageRetryJob {
  instanceId: string;
  stageId: string;
  round: number;
  entry: number;
}

/** ADR-0284: the idempotency key of one stage execution (an entry of a stage in a round) */
export function stageExecutionKey(j: StageRetryJob): string {
  return `${j.instanceId}:${j.stageId}:${j.round}:${j.entry}`;
}

/**
 * The retry attempt the current code runs inside, if any (set by the runner's `runStageRetryJob` around its executor).
 * `applyEvent` reads it: a failure committed BY a retry attempt schedules nothing (the job itself is retried by the
 * queue), and its audit rows name the attempt.
 */
export const stageRetryAttempt = new AsyncLocalStorage<{ key: string; attempt: number; maxAttempts: number }>();

/** a pg-boss `db` over a drizzle handle (the pool, or the caller's transaction), through pg-boss's own adapter */
export function queueDb(handle: DrizzleTransactionLike): PgBossDb {
  return fromDrizzle(handle, sql as unknown as DrizzleSqlTagLike);
}

function baseOptions(db: Db) {
  return {
    db: queueDb(db),
    schema: WORKFLOW_QUEUE_SCHEMA,
    // the schema is ours (migration journal); pg-boss never changes it
    migrate: false,
    createSchema: false,
    // the ADR-0064 scheduler is the cron; nothing here schedules
    schedule: false,
    useListenNotify: false,
    persistWarnings: false,
    persistQueueStats: false,
  } as const;
}

/**
 * The SENDER. pg-boss reads its queue cache at `start()`, so the process keeps one started, non-supervising instance
 * per database handle. Every send goes through the caller's transaction, never this instance's pool.
 */
const senders = new Map<Db, Promise<PgBoss>>();
const handlers = new Map<Db, StageRetryHandler>();
let senderDb: Db | null = null;

/**
 * Called once per app by `registerWorkflowRoutes` with the app's attempt handler (its executor and completion guard);
 * returns the close hook that stops the sender.
 */
export function configureStageQueue(db: Db, handler: StageRetryHandler): () => Promise<void> {
  senderDb = db;
  handlers.set(db, handler);
  return async () => {
    const started = senders.get(db);
    senders.delete(db);
    if (handlers.get(db) === handler) handlers.delete(db);
    if (senderDb === db) senderDb = null;
    if (started) await (await started.catch(() => null))?.stop({ graceful: false, close: false }).catch(() => {});
  };
}

function sender(db: Db): Promise<PgBoss> {
  let started = senders.get(db);
  if (!started) {
    const boss = new PgBoss({ ...baseOptions(db), supervise: false, registerInstance: false });
    boss.on("error", (err: unknown) => console.error(`workflow queue sender: ${errLine(err)}`));
    started = boss.start().then(() => boss);
    started.catch(() => senders.delete(db));
    senders.set(db, started);
  }
  return started;
}

export type StageRetryEnqueue =
  | { scheduled: true; jobId: string; key: string; firstDelaySeconds: number }
  /** a job for this key is already queued, retrying or active: nothing new was sent (ADR-0284) */
  | { scheduled: false; key: string; reason: "already_scheduled" | "queue_not_configured" };

/**
 * ADR-0283: schedule the automatic retries of a failed stage execution, inside `tx` (the transition's transaction).
 * The job's own options carry the stage's policy: the first run after `delaySeconds`, then pg-boss's jittered
 * exponential backoff up to `maxDelaySeconds`, for `maxAttempts` attempts in all.
 */
export async function enqueueStageRetry(tx: DrizzleTransactionLike, job: StageRetryJob, policy: StageRetryPolicy): Promise<StageRetryEnqueue> {
  const key = stageExecutionKey(job);
  if (!senderDb) return { scheduled: false, key, reason: "queue_not_configured" };
  const boss = await sender(senderDb);
  const jobId = await boss.send(STAGE_RETRY_QUEUE, { ...job }, {
    db: queueDb(tx),
    singletonKey: key,
    startAfter: policy.delaySeconds,
    retryLimit: policy.maxAttempts - 1,
    retryDelay: policy.delaySeconds,
    retryBackoff: policy.backoff,
    retryDelayMax: policy.maxDelaySeconds,
  });
  return jobId ? { scheduled: true, jobId, key, firstDelaySeconds: policy.delaySeconds } : { scheduled: false, key, reason: "already_scheduled" };
}

/** what the runner's handler says one attempt came to */
export type StageRetryOutcome =
  /** the stage moved on (succeeded, re-opened, aborted, advanced by hand): nothing left to retry */
  | "superseded"
  | "succeeded"
  /** a governance refusal is final: it is never retried */
  | "refused"
  /** the last attempt failed; the runner audited the exhaustion */
  | "exhausted";

export type StageRetryHandler = (
  job: StageRetryJob,
  attempt: { attempt: number; maxAttempts: number; key: string },
) => Promise<StageRetryOutcome>;

export interface StageRetryWorker {
  stop(): Promise<void>;
}

export function stageRetryWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== undefined || env.NODE_ENV === "test") return false;
  return (env[STAGE_RETRY_WORKER_ENV] ?? "on").trim().toLowerCase() !== "off";
}

/**
 * The WORKER, started by the boot path, with the handler the app registered. A handler that throws (an attempt that failed with attempts left) is retried
 * by pg-boss with the job's backoff; every other outcome completes the job. Supervision (expiry of a job whose worker
 * died, retention) runs here and only here.
 */
export async function startStageRetryWorker(
  db: Db,
  opts: { pollingIntervalSeconds?: number; localConcurrency?: number; log?: Pick<Console, "warn" | "error"> } = {},
): Promise<StageRetryWorker> {
  const log = opts.log ?? console;
  const handler = handlers.get(db);
  if (!handler) throw new Error("the workflow routes are not registered on this database handle, so no retry handler exists");
  const boss = new PgBoss({ ...baseOptions(db), supervise: true, reindex: false });
  boss.on("error", (err: unknown) => log.error(`workflow retry worker: ${errLine(err)}`));
  await boss.start();
  await boss.work(
    STAGE_RETRY_QUEUE,
    {
      includeMetadata: true as const,
      batchSize: 1,
      localConcurrency: opts.localConcurrency ?? 2,
      pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 5,
    },
    async ([job]: JobWithMetadata<StageRetryJob>[]): Promise<{ outcome: StageRetryOutcome } | undefined> => {
      if (!job) return;
      const attempt = { attempt: job.retryCount + 1, maxAttempts: job.retryLimit + 1, key: job.singletonKey ?? stageExecutionKey(job.data) };
      const outcome = await handler(job.data, attempt);
      return { outcome };
    },
  );
  return {
    async stop() {
      await boss.stop({ graceful: true, timeout: 30_000 }).catch((err: unknown) => log.warn(`workflow retry worker stop: ${errLine(err)}`));
    },
  };
}

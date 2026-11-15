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
import fastq from "fastq";
import { PgBoss, fromDrizzle, type Db as PgBossDb, type DrizzleSqlTagLike, type DrizzleTransactionLike, type JobWithMetadata } from "pg-boss";
import { sql, type Db } from "@regulait/db";
import type { Stage, StageRetryPolicy } from "@regulait/workflow-kernel";
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

// ---------------------------------------------------------------------------
// ADR-0286 — CONCURRENCY LIMITS. Each is bounded, has a default, and is read
// from the environment when it is used (so an operator change needs no code).
// ---------------------------------------------------------------------------

/** retry jobs one gateway process runs at once (pg-boss `localConcurrency`) */
export const RETRY_CONCURRENCY_ENV = "REGULAIT_WORKFLOW_RETRY_CONCURRENCY";
/** retry jobs of ONE project running at once across every process (pg-boss `groupConcurrency`, database-tracked) */
export const RETRY_PROJECT_CONCURRENCY_ENV = "REGULAIT_WORKFLOW_RETRY_PROJECT_CONCURRENCY";
/** a check stage's default fan-out width when its template sets no `checkConcurrency` (ADR-0285) */
export const CHECK_CONCURRENCY_ENV = "REGULAIT_WORKFLOW_CHECK_CONCURRENCY";
/** eval-bound checks running at once across every stage in one process */
export const CHECK_PROCESS_CONCURRENCY_ENV = "REGULAIT_WORKFLOW_CHECK_PROCESS_CONCURRENCY";

export const CONCURRENCY_LIMITS = {
  [RETRY_CONCURRENCY_ENV]: { default: 2, min: 1, max: 16 },
  [RETRY_PROJECT_CONCURRENCY_ENV]: { default: 1, min: 1, max: 16 },
  [CHECK_CONCURRENCY_ENV]: { default: 4, min: 1, max: 16 },
  [CHECK_PROCESS_CONCURRENCY_ENV]: { default: 8, min: 1, max: 64 },
} as const;

/** a limit's value: the environment's when it is an integer in bounds, else the default (never unbounded) */
export function concurrencyLimit(name: keyof typeof CONCURRENCY_LIMITS, env: NodeJS.ProcessEnv = process.env): number {
  const { default: fallback, min, max } = CONCURRENCY_LIMITS[name];
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
}

/** ADR-0285: the fan-out width of a check stage — its template's `checkConcurrency`, else the deployment default */
export function stageCheckConcurrency(stage: Pick<Stage, "checkConcurrency">, env: NodeJS.ProcessEnv = process.env): number {
  return stage.checkConcurrency ?? concurrencyLimit(CHECK_CONCURRENCY_ENV, env);
}

/** the retry job's pg-boss group: its instance's project, so one project's failing stages cannot starve another's */
export function stageRetryGroup(projectId: string | null): { id: string } {
  return { id: projectId ?? "no-project" };
}

type Task = () => Promise<unknown>;
let processChecks: fastq.queueAsPromised<Task, unknown> | null = null;
let processChecksWidth = 0;

/**
 * ADR-0285 / ADR-0286 — run `run` over `items` with at most `width` at once for this caller and at most the
 * process-wide check limit across every caller, and return the results in the ORDER OF `items`. Bounded queues from
 * fastq (already in the tree through fastify); nothing here is a scheduler of its own.
 */
export async function fanOut<T, R>(items: readonly T[], width: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const processWidth = concurrencyLimit(CHECK_PROCESS_CONCURRENCY_ENV);
  if (!processChecks || processChecksWidth !== processWidth) {
    // a changed limit takes effect for new work; work already queued keeps the queue it is on
    processChecks = fastq.promise((task: Task) => task(), processWidth);
    processChecksWidth = processWidth;
  }
  const shared = processChecks;
  const local = fastq.promise((i: number) => shared.push(() => run(items[i]!)), Math.max(1, Math.floor(width)));
  return (await Promise.all(items.map((_, i) => local.push(i)))) as R[];
}

/** ADR-0284: the idempotency key of one stage execution (an entry of a stage in a round) */
export function stageExecutionKey(j: StageRetryJob): string {
  return `${j.instanceId}:${j.stageId}:${j.round}:${j.entry}`;
}

/** one automatic retry attempt of one stage execution (named by its ADR-0284 key) */
export interface StageRetryAttemptContext {
  key: string;
  attempt: number;
  maxAttempts: number;
  /**
   * What the attempt's executor committed FOR THIS EXECUTION (the stage the key names), set by `applyEvent`:
   * `failed` for `execution_failed`, `moved` for any other event of that stage. Unset means it committed nothing for
   * it (a check stage waiting for reports, a build handed to a nested run). The attempt's outcome is decided from this,
   * never from leftover context.
   */
  committed?: "failed" | "moved";
}

/**
 * The retry attempt the current code runs inside, if any (set by the runner's `runStageRetryJob` around its executor).
 * `applyEvent` reads it ONLY for events of the execution the attempt names (`key`): such a failure schedules nothing
 * (the queue retries that job with its own backoff), and its audit rows name the attempt. A downstream stage the
 * attempt's executor runs on into has another key, so it schedules and audits as if no attempt were running.
 */
export const stageRetryAttempt = new AsyncLocalStorage<StageRetryAttemptContext>();

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

/**
 * Start the sender ahead of the first failure (the boot path calls this), so a send inside a transition's
 * transaction never waits on pg-boss's start. Best-effort: a sender that cannot start now is started again on the
 * next send, and that send reports `queue_unavailable` if it still cannot.
 */
export async function warmStageQueueSender(): Promise<boolean> {
  if (!senderDb) return false;
  await sender(senderDb);
  return true;
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

/**
 * Why no retry chain was scheduled for a failure:
 *  - `already_scheduled`: this execution's chain is still queued, retrying or active (ADR-0284);
 *  - `exhausted`: this execution already had its one chain, which has ended (ADR-0283: one chain per execution key,
 *    whatever committed the later failure: a nested run that aborted after its attempt handed off, or a manual
 *    `/advance`). A re-open or a new entry into the stage is a new key, and gets a new chain;
 *  - `queue_not_configured` / `queue_unavailable`: the queue is not set up in this process, or failed; the failure
 *    still commits, and the stage waits for `/advance` as before P30.
 */
export type StageRetryNotScheduledReason = "already_scheduled" | "exhausted" | "queue_not_configured" | "queue_unavailable";

export type StageRetryEnqueue =
  | { scheduled: true; jobId: string; key: string; firstDelaySeconds: number }
  | { scheduled: false; key: string; reason: StageRetryNotScheduledReason; error?: string };

/** is this execution's retry job still queued, retrying or active? (the `exclusive` policy's own range) */
export async function stageRetryChainLive(tx: Db, key: string): Promise<boolean> {
  const r = await tx.execute(
    sql`SELECT 1 FROM regulait_queue.job WHERE name = ${STAGE_RETRY_QUEUE} AND singleton_key = ${key} AND state <= 'active' LIMIT 1`,
  );
  return r.rows.length > 0;
}

/**
 * ADR-0283: schedule the automatic retries of a failed stage execution, inside `tx` (the transition's transaction).
 * The job's own options carry the stage's policy: the first run after `delaySeconds`, then pg-boss's jittered
 * exponential backoff up to `maxDelaySeconds`, for `maxAttempts` attempts in all.
 */
export async function enqueueStageRetry(tx: Db, job: StageRetryJob, policy: StageRetryPolicy, projectId: string | null): Promise<StageRetryEnqueue> {
  const key = stageExecutionKey(job);
  if (!senderDb) return { scheduled: false, key, reason: "queue_not_configured" };
  // A queue failure must never keep the failure itself from committing: the sender starts outside the transaction
  // (on its own pool connection), and the send runs under a savepoint, so an error rolls back only the send.
  try {
    const boss = await sender(senderDb);
    const jobId = await tx.transaction((sp) =>
      boss.send(STAGE_RETRY_QUEUE, { ...job }, {
        db: queueDb(sp as unknown as DrizzleTransactionLike),
        singletonKey: key,
        startAfter: policy.delaySeconds,
        retryLimit: policy.maxAttempts - 1,
        retryDelay: policy.delaySeconds,
        retryBackoff: policy.backoff,
        retryDelayMax: policy.maxDelaySeconds,
        // ADR-0286: the per-project limit the worker applies
        group: stageRetryGroup(projectId),
      }),
    );
    return jobId ? { scheduled: true, jobId, key, firstDelaySeconds: policy.delaySeconds } : { scheduled: false, key, reason: "already_scheduled" };
  } catch (err) {
    return { scheduled: false, key, reason: "queue_unavailable", error: errLine(err) };
  }
}

/** what the runner's handler says one attempt came to */
export type StageRetryOutcome =
  /** the stage moved on (succeeded, re-opened, aborted, advanced by hand): nothing left to retry */
  | "superseded"
  | "succeeded"
  /** a governance refusal is final: it is never retried */
  | "refused"
  /**
   * the attempt committed nothing for this execution: the stage now waits on something else (reports for a check, a
   * nested run for a build). The chain ends here; a later failure of the same execution is not retried (ADR-0283)
   */
  | "handed_off"
  /** the last attempt failed (or threw); the runner audited the exhaustion */
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
      // ADR-0286: per process, and per project across every process
      localConcurrency: opts.localConcurrency ?? concurrencyLimit(RETRY_CONCURRENCY_ENV),
      groupConcurrency: concurrencyLimit(RETRY_PROJECT_CONCURRENCY_ENV),
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

/**
 * THE BOOT SEQUENCE, as a function.
 *
 * This used to be top-level statements in `main.ts`, which meant the one thing
 * a test could never drive was the thing that actually happens in production:
 * the ORDER in which a deployment comes up. ADR-0063 made that gap load-bearing
 * — its central claim is *"the gateway refuses to start"*, and a claim about
 * starting can only be proved by exercising the start.
 *
 * So the sequence lives here and `main.ts` is a five-line invocation of it. The
 * order below is the contract:
 *
 *   1. build the app        — pure construction, no I/O, no gate, NO TIMERS
 *   2. run migrations       — idempotent; booting always converges the schema
 *   3. verify the data key  — ADR-0063. THROWS, and the throw happens HERE,
 *                             after the app object exists and BEFORE anything
 *                             is listening. `startGateway` closes the app on
 *                             its way out, so a refused boot leaves no socket,
 *                             no pool and no half-open server.
 *   4. listen               — the deployment is now in service
 *   5. start the scheduler  — ADR-0064, and ONLY if REGULAIT_SCHEDULER=on.
 *                             AFTER listening on purpose: a sweep must never be
 *                             able to delay the deployment coming into service,
 *                             and a box that is up but not sweeping is a far
 *                             better failure than one that never comes up.
 *   6. print the posture    — proxy / HSTS / egress / data key / scheduler, in
 *                             one block an operator can read without querying
 *                             anything
 *
 * Steps 3 and 5 are deliberately not inside `buildApp`: see the note on
 * `verifyDataKeyOnBoot`. Constructing an app is not putting a deployment into
 * service, and ~103 test files construct apps.
 */
import { runMigrations, type Db } from "@regulait/db";
import { buildApp, type BuildAppOptions } from "./app.js";
import { RATE_LIMIT_COUNTER_RETENTION_MS, pruneRateLimitCounters } from "./rate-limit-store.js";
import { describeTrustProxy, resolveTrustProxy } from "./trusted-proxy.js";
import { describeHsts, resolveHsts } from "./hsts.js";
import { describeEgressPosture, resolveDeployMode } from "./deploy-posture.js";
import { describeDataKey, verifyDataKeyOnBoot, type DataKeyBootResult } from "./data-key.js";
import { Scheduler, resolveSchedulerConfig, syncSchedulerJobs } from "./scheduler.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";
import { captureAnchor, flushPendingAnchors, resolveAnchorSink } from "./audit-chain.js";
import { backfillOtlpHeaderCiphertext } from "./org-settings.js";
import { DevSecretsBootError, assessDevSecrets, realAdminExists } from "./dev-secrets.js";
import { describeGatewayLogger, resolveGatewayLogger } from "./gateway-logger.js";
import { describeDbPool, resolveDbPoolConfig } from "@regulait/db";

/** ADR-0035: how often the chain head is captured when anchoring is on. */
const DEFAULT_ANCHOR_INTERVAL_MS = 15 * 60_000;

export interface StartGatewayOptions extends BuildAppOptions {
  db: Db;
  migrationsFolder: string;
  port?: number;
  host?: string;
  /** default `console.log`; injected so a test can capture the posture block */
  log?: (line: string) => void;
  /** env the ADR-0063 rotation declaration is read from */
  env?: NodeJS.ProcessEnv;
}

export interface StartedGateway {
  app: ReturnType<typeof buildApp>;
  address: string;
  dataKey: DataKeyBootResult;
  /** the ADR-0064 tick loop, or `null` when REGULAIT_SCHEDULER left it off —
   * which is the DEFAULT. Returned rather than hidden so a caller can stop it
   * deterministically; the app's own onClose hook already does. */
  scheduler: Scheduler | null;
}

/**
 * Bring a gateway up, or refuse to.
 *
 * @throws {import("./data-key.js").DataKeyBootError} when the running
 * `REGULAIT_DATA_KEY` is not the key this database's ciphertext was written
 * under. Nothing is listening when it throws.
 */
export async function startGateway(opts: StartGatewayOptions): Promise<StartedGateway> {
  const { db, migrationsFolder, port = 3000, host = "0.0.0.0", log = console.log, env = process.env, ...appOpts } = opts;

  // ADR-0167 (CFG-02): the SERVING process logs. Resolved here, not inside
  // buildApp, so the ~100 test files that construct apps stay silent; forced
  // off under vitest for the same reason the timers below are.
  const underTest = env.VITEST !== undefined || env.NODE_ENV === "test";
  const logger = appOpts.logger ?? (underTest ? false : resolveGatewayLogger(env));
  // ADR-0060 / AER-012: the sink this process anchors WITH (below) is the sink
  // the app's readers grade — one instance, one observation cache.
  const anchorSink = appOpts.auditAnchorSink !== undefined ? appOpts.auditAnchorSink : resolveAnchorSink(env);
  const app = buildApp(db, { ...appOpts, logger, auditAnchorSink: anchorSink });

  // migrations are idempotent — booting always converges the schema
  await runMigrations(db, migrationsFolder);

  // ADR-0063 — the restore gate. Before this line a deployment restored onto a
  // box without its key came up healthy and failed every decryption silently.
  let dataKey: DataKeyBootResult;
  try {
    dataKey = await verifyDataKeyOnBoot(db, appOpts.dataKey, env);
  } catch (err) {
    // Do not leave a constructed-but-never-started Fastify instance holding
    // plugin resources behind on the way out.
    await app.close().catch(() => {});
    throw err;
  }

  // ADR-0167 (AUTHZ-05 / CFG-03): the published dev-grade secrets are named,
  // and on a box that shows a sign of being deployed they REFUSE the boot —
  // before listen, like the data-key gate, so a refused deployment leaves no
  // socket behind. See dev-secrets.ts for exactly what refuses and what warns.
  const secrets = assessDevSecrets(env, {
    bootstrapToken: appOpts.bootstrapToken,
    dataKey: appOpts.dataKey,
    realAdminExists: await realAdminExists(db).catch(() => false),
  });
  if (secrets.refuse) {
    await app.close().catch(() => {});
    throw new DevSecretsBootError(secrets);
  }

  // ADR-0167 (SEC-06): a pre-0128 row still holding the OTLP collector
  // headers in the clear is enveloped now, under the key the gate just proved
  // — and before listen, so no export can read the plaintext first. A failure
  // here is logged, never fatal: the legacy row still exports.
  let otlpBackfill: "enveloped" | "nothing" = "nothing";
  if (appOpts.dataKey) {
    try {
      otlpBackfill = await backfillOtlpHeaderCiphertext(db, appOpts.dataKey);
    } catch (err) {
      log(`[regulait] OTLP header envelope backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ADR-0064 — the scheduler's shutdown hook MUST be registered BEFORE listen.
  //
  // Fastify refuses `addHook` once the instance is listening
  // (FST_ERR_INSTANCE_ALREADY_LISTENING), and it throws rather than warning. The
  // hook was originally registered down beside `scheduler.start()` — i.e. after
  // this line — which crash-looped the gateway on the very first deployment that
  // actually set REGULAIT_SCHEDULER=on. It survived a 1,722-test suite because
  // the scheduler is force-disabled under vitest and the loop's own tests drive a
  // `Scheduler` directly, so "enabled" and "went through startGateway/listen"
  // never held at the same time anywhere.
  //
  // So the hook is registered here, unconditionally, closing over the mutable
  // `scheduler` binding assigned after listen. With the scheduler off it is an
  // await on nothing. `scheduler.start()` stays after listen so a slow first
  // sweep still cannot delay the deployment coming into service.
  let scheduler: Scheduler | null = null;
  app.addHook("onClose", async () => {
    if (scheduler) await scheduler.stop();
  });

  // Audit anchoring is DEFAULT-ON and deliberately does NOT ride the ADR-0064
  // scheduler. Two reasons, both load-bearing:
  //
  //  1. The scheduler is off by default because its six sweeps MUTATE governed
  //     state and one of them (ADR-0057 red-team) costs real money per run.
  //     Anchoring only ever READS the chain head and appends an anchor row, so
  //     it does not need that ceremony — and folding it in would have meant
  //     "turn on anchoring" silently also meant "start running red-team sweeps".
  //  2. An install with the scheduler off would otherwise anchor nothing, which
  //     is the exact state this default exists to end.
  //
  // Forced off under vitest for the same reason the scheduler is: a stray timer
  // must not run underneath the suite.
  let anchorTimer: NodeJS.Timeout | null = null;
  let rateLimitPruneTimer: NodeJS.Timeout | null = null;
  app.addHook("onClose", async () => {
    if (anchorTimer) clearInterval(anchorTimer);
    if (rateLimitPruneTimer) clearInterval(rateLimitPruneTimer);
  });

  const address = await app.listen({ port, host });

  // Capture the chain head on a timer. Started AFTER listen so a slow first
  // write cannot delay coming into service, and the first capture is deferred
  // by one interval rather than fired at boot for the same reason.
  //
  // A failure here is recorded on the anchor row (`status: 'failed'` +
  // `lastError`) and must never take the gateway down: an install on a
  // read-only filesystem still gets the hash chain, which is what catches
  // everything short of a full recompute.
  const anchorUnderTest = env.VITEST !== undefined || env.NODE_ENV === "test";
  const anchorEveryMs = Math.max(
    60_000,
    Number(env.REGULAIT_AUDIT_ANCHOR_INTERVAL_MS ?? DEFAULT_ANCHOR_INTERVAL_MS) ||
      DEFAULT_ANCHOR_INTERVAL_MS,
  );
  if (anchorSink && !anchorUnderTest) {
    // REL-12: ONE capture in flight at a time. A black-holed sink (a firewall
    // that drops rather than refuses) used to leave a capture hanging and the
    // interval kept starting another one every 15 minutes on top of it.
    anchorTimer = setInterval(
      withoutOverlap(async () => {
        try {
          await captureAnchor(db, anchorSink, null);
          await flushPendingAnchors(db, anchorSink);
        } catch (err) {
          app.log.warn({ err }, "audit anchor capture failed — the hash chain is unaffected");
        }
      }),
      anchorEveryMs,
    );
    anchorTimer.unref();
  }

  // ADR-0125 — housekeeping for the shared rate-limit counters. Rows are
  // bounded by DISTINCT CALLERS rather than by requests, and a stale row is
  // already harmless because every read compares the window before trusting
  // the count. So this is HYGIENE, NOT ENFORCEMENT — which is what lets it be
  // a plain timer at all: ADR-0064's rule is that no ceiling may depend on a
  // sweep having run, and none does here. Skipping it entirely would cost
  // disk, never correctness.
  //
  // The retention is deliberately far longer than any configured window (the
  // widest default is the 5-minute auth bucket): deleting a row whose window
  // is still live would reset that caller's count to zero mid-window, turning
  // a cleanup job into a way around the limit.
  if (!anchorUnderTest) {
    rateLimitPruneTimer = setInterval(
      () => {
        void pruneRateLimitCounters(db, RATE_LIMIT_COUNTER_RETENTION_MS).catch((err: unknown) => {
          app.log.warn({ err }, "rate-limit counter prune failed — limits are unaffected");
        });
      },
      Math.max(60_000, RATE_LIMIT_COUNTER_RETENTION_MS / 4),
    );
    rateLimitPruneTimer.unref();
  }

  // ADR-0064 — the tick loop. OFF unless REGULAIT_SCHEDULER says on, in every
  // environment including production: enabling a background loop that mutates
  // governed state is an operator's decision. Started AFTER listen so a slow
  // first sweep can never delay the deployment coming into service.
  //
  // The job DEFINITIONS are synced either way, so an operator with the
  // scheduler off can still see on the admin screen exactly what would run.
  const schedulerConfig = resolveSchedulerConfig(env);
  const registry = schedulerJobRegistry({ dataKey: appOpts.dataKey });
  try {
    await syncSchedulerJobs(db, registry);
  } catch (err) {
    // A boot must not fail because a job definition could not be written. The
    // gateway is already listening at this point and every sweep has an
    // endpoint; losing the schedule is a degradation, not an outage.
    console.error(
      `[regulait] could not sync scheduler job definitions: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (schedulerConfig.enabled) {
    scheduler = new Scheduler(db, {
      registry,
      tickMs: schedulerConfig.tickMs,
      leaseSeconds: schedulerConfig.leaseSeconds,
    });
    scheduler.start();
    // Shutdown is the app's: closing the gateway stops the loop and WAITS for
    // an in-flight job rather than abandoning it mid-sweep (see Scheduler.stop).
    // The hook itself is registered above, before listen — see the note there.
  }

  log(`regulait gateway listening on ${address}`);
  // ADR-0033: /ui is the whole product surface; /app and /admin are only
  // 302s into it (app.ts), kept for SSO's returnTo whitelist and bookmarks.
  // The banner names the surface, not the redirects (F08).
  log(`  UI:        ${address}/ui`);
  // ADR-0031: say out loud whose X-Forwarded-* this deployment believes —
  // getting this wrong silently corrupts every client IP in the audit trail.
  log(`  proxy:     ${describeTrustProxy(resolveTrustProxy())}`);
  // ADR-0029 amendment: say out loud what this deployment pins browsers to.
  // HSTS is the one header we cannot take back from the server, so the value
  // belongs in the boot log next to the proxy posture rather than only in a
  // response an operator has to think to look at.
  log(`  hsts:      ${describeHsts(resolveHsts())}`);
  // ADR-0062: say out loud what this box will REFUSE to reach. An operator who
  // believes their install is air-gapped and has not set the variable must be
  // able to see that from the boot log rather than from a packet capture.
  log(`  egress:    ${describeEgressPosture(resolveDeployMode())}`);
  // ADR-0063: say out loud WHICH KEY this box is running, and whether anybody
  // has ever claimed to hold a copy of it. The fingerprint is a PRF output, so
  // printing it costs nothing; not printing it costs an operator the one string
  // they need to check a backup against before restoring it.
  log(`  data key:  ${describeDataKey(dataKey)}`);
  if (dataKey.code === "recorded" || dataKey.code === "rotation_accepted") {
    log(`             ${dataKey.message}`);
  }
  if (otlpBackfill === "enveloped") {
    log("             OTLP collector headers found in the clear were enveloped under this key (ADR-0167)");
  }
  // ADR-0167: say out loud whether the break-glass door is open, and whether
  // anything running here is a secret anyone with the repository already has.
  // An operator who cannot see this from the boot log will not go looking.
  log(`  bootstrap: ${secrets.bootstrapLine}`);
  for (const finding of secrets.findings) {
    log(`  secrets:   DEV-GRADE — ${finding}`);
  }
  if (secrets.overridden && secrets.refusing.length > 0) {
    log(`             (booting anyway: REGULAIT_ALLOW_DEV_SECRETS=1 overrides the refusal on ${secrets.networkFacingSignal})`);
  }
  // ADR-0167 (CFG-08): the pool's bounds and whether the database hop is TLS.
  log(`  database:  ${describeDbPool(resolveDbPoolConfig(env))}`);
  // ADR-0167 (CFG-02): whether refusals and failures leave a trace at all.
  log(`  logging:   ${describeGatewayLogger(logger)}`);
  // ADR-0064: say out loud whether the six sweeps will actually run on this
  // box. An operator who believes their MRM expiry sweep is running and has not
  // set the variable must be able to see that from the boot log rather than
  // from a stale registry screen three months later.
  log(`  scheduler: ${schedulerConfig.reason}${schedulerConfig.enabled ? `, ${registry.size} job(s)` : ""}`);

  return { app, address, dataKey, scheduler };
}

/**
 * REL-12 — wrap an async timer callback so a tick that is still running
 * SKIPS the next one rather than stacking a second run on top of it. The
 * returned function is what `setInterval` is given; the skipped tick costs
 * nothing and the next interval tries again. (Scheduler.safeTick is the same
 * idea for the ADR-0064 loop; this is the one-liner for plain timers.)
 */
export function withoutOverlap(fn: () => Promise<void>): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) return;
    inFlight = true;
    void fn().finally(() => {
      inFlight = false;
    });
  };
}

/** the slice of `process` the shutdown handlers need — injectable so a test
 * can drive a signal without sending one to vitest */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): never | void;
}

export interface ShutdownHandlerOptions {
  /** default `process` */
  proc?: ProcessLike;
  /** default `console.error` — stderr, so it survives REGULAIT_LOG=off */
  log?: (line: string) => void;
  /** the drain budget (REGULAIT_SHUTDOWN_GRACE_MS, default 15 s): past it the
   * process exits anyway, non-zero, because something was still in flight.
   * docker-compose.yml's `stop_grace_period` for the gateway is set above
   * this so the orchestrator never SIGKILLs a drain that was going to finish. */
  graceMs?: number;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

export function resolveShutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGULAIT_SHUTDOWN_GRACE_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_SHUTDOWN_GRACE_MS;
}

/**
 * REL-02 / OPS-01 — a signal drains the gateway instead of severing it.
 *
 * There was no handler at all. On the native path Ctrl-C took Node's default
 * (immediate exit); under compose, Node was PID 1 with no init, so SIGTERM was
 * IGNORED for the 10 s default grace and the container was then SIGKILLed.
 * Either way the `onClose` hooks `startGateway` registers — the ADR-0064
 * scheduler drain that waits for an in-flight sweep, the anchor and prune
 * timers — never ran outside a test, in-flight approval transactions were
 * aborted mid-request and the pool was never ended.
 *
 * Now, on SIGTERM or SIGINT: `app.close()` (stop accepting, let in-flight
 * requests finish, run the onClose hooks), then `pool.end()`, then exit 0 —
 * all under a deadline, past which the process exits 1 rather than hang on a
 * stream that will not end. A SECOND signal during the drain exits
 * immediately: an operator hammering Ctrl-C is not asking for patience.
 *
 * `unhandledRejection` and `uncaughtException` take the same path with exit
 * code 1: the trace is logged first (Node's default prints it too, but exits
 * without draining), then the same bounded drain, so a bug in a background
 * tick leaves a stack AND a clean pool instead of a severed socket.
 *
 * Installed by main.ts ONLY — never by `startGateway`, which ~100 test files
 * drive under vitest, where a process-level handler would catch the runner's
 * own signals.
 */
export function installShutdownHandlers(
  started: Pick<StartedGateway, "app">,
  db: Db,
  opts: ShutdownHandlerOptions = {},
): { shutdown: (reason: string, code: number) => Promise<void> } {
  const proc: ProcessLike = opts.proc ?? process;
  const log = opts.log ?? ((line: string) => console.error(line));
  const graceMs = opts.graceMs ?? resolveShutdownGraceMs();
  let draining: Promise<void> | null = null;

  const shutdown = (reason: string, code: number): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      log(`[regulait] ${reason} — draining (in-flight requests, scheduler tick, pool; up to ${graceMs} ms)`);
      const deadline = setTimeout(() => {
        log(`[regulait] drain did not finish within ${graceMs} ms — exiting now`);
        proc.exit(code === 0 ? 1 : code);
      }, graceMs);
      deadline.unref();
      try {
        await started.app.close();
      } catch (err) {
        log(`[regulait] app.close failed during drain: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
      } catch (err) {
        log(`[regulait] pool.end failed during drain: ${err instanceof Error ? err.message : String(err)}`);
      }
      clearTimeout(deadline);
      log(`[regulait] stopped (exit ${code})`);
      proc.exit(code);
    })();
    return draining;
  };

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    proc.on(sig, () => {
      if (draining) {
        log(`[regulait] second ${sig} during drain — exiting immediately`);
        proc.exit(1);
        return;
      }
      void shutdown(`received ${sig}`, 0);
    });
  }
  proc.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log(`[regulait] unhandled promise rejection: ${err.stack ?? err.message}`);
    void shutdown("unhandled promise rejection", 1);
  });
  proc.on("uncaughtException", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log(`[regulait] uncaught exception: ${err.stack ?? err.message}`);
    void shutdown("uncaught exception", 1);
  });

  return { shutdown };
}

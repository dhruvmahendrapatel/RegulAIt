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
import { describeTrustProxy, resolveTrustProxy } from "./trusted-proxy.js";
import { describeHsts, resolveHsts } from "./hsts.js";
import { describeEgressPosture, resolveDeployMode } from "./deploy-posture.js";
import { describeDataKey, verifyDataKeyOnBoot, type DataKeyBootResult } from "./data-key.js";
import { Scheduler, resolveSchedulerConfig, syncSchedulerJobs } from "./scheduler.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";

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

  const app = buildApp(db, appOpts);

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

  const address = await app.listen({ port, host });

  // ADR-0064 — the tick loop. OFF unless REGULAIT_SCHEDULER says on, in every
  // environment including production: enabling a background loop that mutates
  // governed state is an operator's decision. Started AFTER listen so a slow
  // first sweep can never delay the deployment coming into service.
  //
  // The job DEFINITIONS are synced either way, so an operator with the
  // scheduler off can still see on the admin screen exactly what would run.
  const schedulerConfig = resolveSchedulerConfig(env);
  const registry = schedulerJobRegistry({ dataKey: appOpts.dataKey });
  let scheduler: Scheduler | null = null;
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
    // an in-flight job rather than abandoning it mid-sweep. See Scheduler.stop.
    const live = scheduler;
    app.addHook("onClose", async () => {
      await live.stop();
    });
  }

  log(`regulait gateway listening on ${address}`);
  log(`  app UI:    ${address}/app`);
  log(`  admin UI:  ${address}/admin`);
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
  // ADR-0064: say out loud whether the six sweeps will actually run on this
  // box. An operator who believes their MRM expiry sweep is running and has not
  // set the variable must be able to see that from the boot log rather than
  // from a stale registry screen three months later.
  log(`  scheduler: ${schedulerConfig.reason}${schedulerConfig.enabled ? `, ${registry.size} job(s)` : ""}`);

  return { app, address, dataKey, scheduler };
}

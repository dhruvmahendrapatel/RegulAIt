/**
 * ADR-0187 B5-P — the promptfoo RUNNER's entrypoint inside its image (`node dist/main.js`).
 *
 * Everything about the runner's life comes from the shared core (`runRunnerLoop`, decisions 48 and
 * 49): the runner token is kept on the runner's own volume (REGULAIT_RUNNER_STATE_DIR, default
 * /state) so a restart does not need a new enrolment token; a lease refused because the engine is
 * still off waits with a capped backoff; only a refused credential with no enrolment token to
 * replace it stops the process (after a pause, so a restart policy cannot hammer the gateway).
 * No listening port. The token is never logged.
 *
 * B5-P2 (ADR-0187 decisions 170 on): the runner NEVER runs promptfoo. Every job goes to the worker
 * container through the exchange volumes (exchange.ts), and the runner's self-test carries the
 * worker's own report (worker-selftest.ts) as the manifest's `REGULAIT_PROMPTFOO_WORKER_ISOLATED`.
 */
import path from "node:path";
import { buildSelfTest, FileRunnerTokenStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError } from "@regulait/engine-runner";
import { ENGINE_MANIFEST, type RunnerSelfTest } from "@regulait/shared";
import { promptfooAdapter } from "./adapter.js";
import { ExchangePromptfooExecutor } from "./exchange.js";
import { installedPromptfooVersion, PROMPTFOO_HOME } from "./version.js";
import { judgeWorkerSelfTest, WORKER_ISOLATED_SWITCH } from "./worker-selftest.js";

export { installedPromptfooVersion, PROMPTFOO_HOME };

/** the runner's self-test, with the worker's isolation judged from the worker's own report */
export async function promptfooRunnerSelfTest(args: { imageDigest: string; engineVersion: string; resultsRoot: string; env?: NodeJS.ProcessEnv; now?: Date }): Promise<RunnerSelfTest> {
  const { [WORKER_ISOLATED_SWITCH]: _derived, ...switches } = ENGINE_MANIFEST.promptfoo.usageDataEnv;
  const base = await buildSelfTest({ imageDigest: args.imageDigest, engineVersion: args.engineVersion, requiredEnv: switches, ...(args.env ? { env: args.env } : {}) });
  const worker = await judgeWorkerSelfTest(args.resultsRoot, args.now);
  if (!worker.isolated) console.error(`promptfoo runner: the worker's self-test does not pass (${worker.failures.join(", ")})`);
  return { ...base, usageDataEnv: { ...base.usageDataEnv, [WORKER_ISOLATED_SWITCH]: worker.isolated } };
}

async function main(): Promise<void> {
  const gatewayUrl = process.env.REGULAIT_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("REGULAIT_GATEWAY_URL is required");
  // PR #205 review [55]: refuse to start unless the image reference is digest-pinned and agrees
  // with the digest reported (a consistency check; the signature check at deploy time is the proof)
  const imageDigest = pinnedImageDigest(process.env.REGULAIT_ENGINE_IMAGE_REF, process.env.REGULAIT_ENGINE_IMAGE_DIGEST);
  const engineVersion = installedPromptfooVersion();
  const client = new RunnerClient({ gatewayUrl });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const jobsRoot = process.env.REGULAIT_PROMPTFOO_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_PROMPTFOO_RESULTS_DIR ?? "/results";
  const executor = new ExchangePromptfooExecutor(jobsRoot, resultsRoot);
  // at start this runner holds no run, so no job of any run may remain in the exchange
  const stale = await executor.reconcile(null);
  if (stale.length) console.log(`promptfoo runner: removed ${stale.length} job(s) left by an earlier process`);
  await runRunnerLoop(client, promptfooAdapter({ entrypoint: `${PROMPTFOO_HOME}/dist/src/entrypoint.js`, executor }), {
    engineId: "promptfoo",
    engineVersion,
    imageDigest,
    workRoot: process.env.REGULAIT_WORK_DIR ?? "/work",
    // PR #205 review round 11 [90]: undelivered results survive a restart on the state volume (0700,
    // the runner's own), apart from the engine's work dirs on the tmpfs
    retainRoot: path.join(stateDir, "undelivered"),
    store: new FileRunnerTokenStore(path.join(stateDir, "runner-token")),
    enrollmentToken: process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN || null,
    registration: async () => ({
      name: `promptfoo-${process.env.HOSTNAME ?? "runner"}`,
      imageDigest,
      engineVersion,
      selfTest: await promptfooRunnerSelfTest({ imageDigest, engineVersion, resultsRoot }),
    }),
    log: (m) => console.log(m),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`promptfoo runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    // PR #205 review round 12 [91]: an obsolete image can never register: park (stay up, idle, saying
    // why once a day) rather than exit into the restart policy's loop
    if (e instanceof RunnerObsoleteBuildError) {
      setInterval(() => console.error(`promptfoo runner parked: ${e.message}`), 24 * 3_600_000);
      return;
    }
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}

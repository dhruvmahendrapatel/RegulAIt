/**
 * ADR-0242 §6.1 — the admission-scan RUNNER's entrypoint (`node /app/dist/main.js`), one package for both images
 * (`REGULAIT_ADMISSION_ENGINE` = `mcpscanner` | `skillscanner`, set by each image; anything else stops it before it
 * enrols). As modelscan's (ADR-0187 B5-M, ADR-0190 I5): on the internal `engines` network, holding the runner key on
 * its state volume, NEVER running the scanner itself. Each subject run is handed to an executor's sandbox by the task
 * bridge (task-subject.ts: no files, no artifact, no secret, the gateway's subject at the input root), and the
 * driver's report comes back through the exchange (exchange.ts) to be posted as the envelope's raw report.
 *
 * Its life comes from the shared core (`runRunnerLoop`): key persistence, enrolment, the self-test refresh, result
 * retention, the `next` state machine. Its self-test adds the worker's report for the manifest's worker-attested
 * offline switch (selftest.ts). No listening port. The token and the report are never logged.
 */
import path from "node:path";
import { ExecutorTaskBridge, FileRunnerKeyStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError, runnerIssuerFromEnv } from "@regulait/engine-runner";
import { admissionScanAdapter } from "./adapter.js";
import { admissionEngineFromEnv } from "./config.js";
import { SubjectExchange } from "./exchange.js";
import { admissionRunnerSelfTest } from "./selftest.js";
import { installedAdmissionEngineVersion } from "./version.js";

async function main(): Promise<void> {
  // fail closed: an unknown engine id stops the runner before anything else
  const engine = admissionEngineFromEnv(process.env);
  const gatewayUrl = process.env.REGULAIT_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("REGULAIT_GATEWAY_URL is required");
  // PR #205 review [55]: a digest-pinned reference that agrees with the reported digest, or no start
  const imageDigest = pinnedImageDigest(process.env.REGULAIT_ENGINE_IMAGE_REF, process.env.REGULAIT_ENGINE_IMAGE_DIGEST);
  const engineVersion = installedAdmissionEngineVersion(engine);
  const jobsRoot = process.env.REGULAIT_ADMISSION_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_ADMISSION_RESULTS_DIR ?? "/results";
  // ADR-0188 S7: private_key_jwt + DPoP, each proof under the gateway's issuer (REGULAIT_PUBLIC_URL)
  const client = new RunnerClient({ gatewayUrl, issuer: runnerIssuerFromEnv(process.env) });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const store = new FileRunnerKeyStore(path.join(stateDir, "runner-key"));
  const exchange = new SubjectExchange(jobsRoot, resultsRoot);
  // at start this runner holds no run, so no job of any run may remain
  const stale = await exchange.reconcile(null);
  if (stale.length) console.log(`${engine} runner: removed ${stale.length} job(s) left by an earlier process`);
  // ADR-0190 I5: the only place a scan runs is an executor's sandbox (the scanner calls nothing: no gateway channel)
  const bridge = new ExecutorTaskBridge({
    client,
    jobsRoot,
    resultsRoot,
    gatewayBaseUrl: process.env.REGULAIT_ENGINE_GATEWAY_URL ?? `${gatewayUrl.replace(/\/$/, "")}/v1`,
    log: (m) => console.log(`${engine} runner: ${m}`),
  });
  void bridge.run(new AbortController().signal);
  await runRunnerLoop(client, admissionScanAdapter({ engine, executor: exchange }), {
    engineId: engine,
    engineVersion,
    imageDigest,
    workRoot: process.env.REGULAIT_WORK_DIR ?? "/work",
    retainRoot: path.join(stateDir, "undelivered"),
    store,
    enrollmentToken: process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN || null,
    registration: async () => ({
      name: `${engine}-${process.env.HOSTNAME ?? "runner"}`,
      imageDigest,
      engineVersion,
      selfTest: await admissionRunnerSelfTest({ engine, imageDigest, engineVersion, resultsRoot }),
    }),
    log: (m) => console.log(m),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`admission-scan runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof RunnerObsoleteBuildError) {
      setInterval(() => console.error(`admission-scan runner parked: ${e.message}`), 24 * 3_600_000);
      return;
    }
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}

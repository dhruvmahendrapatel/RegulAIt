/**
 * ADR-0187 B5-P — the promptfoo runner's entrypoint inside its image (`node dist/main.js`).
 *
 * Everything about the runner's life comes from the shared core (`runRunnerLoop`, decisions 48 and
 * 49): the runner token is kept on the runner's own volume (REGULAIT_RUNNER_STATE_DIR, default
 * /state) so a restart does not need a new enrolment token; a lease refused because the engine is
 * still off waits with a capped backoff; only a refused credential with no enrolment token to
 * replace it stops the process (after a pause, so a restart policy cannot hammer the gateway).
 * No listening port. The token is never logged.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSelfTest, FileRunnerTokenStore, pinnedImageDigest, runRunnerLoop, RunnerClient } from "@regulait/engine-runner";
import { ENGINE_MANIFEST } from "@regulait/shared";
import { promptfooAdapter } from "./adapter.js";

export const PROMPTFOO_HOME = process.env.REGULAIT_PROMPTFOO_HOME ?? "/opt/promptfoo/node_modules/promptfoo";

/** the promptfoo version actually installed in the image (never the manifest's claim) */
export function installedPromptfooVersion(home = PROMPTFOO_HOME): string {
  return (JSON.parse(readFileSync(`${home}/package.json`, "utf8")) as { version: string }).version;
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
  await runRunnerLoop(client, promptfooAdapter({ entrypoint: `${PROMPTFOO_HOME}/dist/src/entrypoint.js` }), {
    engineId: "promptfoo",
    engineVersion,
    workRoot: process.env.REGULAIT_WORK_DIR ?? "/work",
    store: new FileRunnerTokenStore(path.join(stateDir, "runner-token")),
    enrollmentToken: process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN || null,
    registration: async () => ({
      name: `promptfoo-${process.env.HOSTNAME ?? "runner"}`,
      imageDigest,
      engineVersion,
      selfTest: await buildSelfTest({ imageDigest, engineVersion, requiredEnv: ENGINE_MANIFEST.promptfoo.usageDataEnv }),
    }),
    log: (m) => console.log(m),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`promptfoo runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}

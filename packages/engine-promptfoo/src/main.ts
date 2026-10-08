/**
 * ADR-0187 B5-P — the promptfoo runner's entrypoint inside its image (`node dist/main.js`).
 *
 * Registers once (enrolment token → runner token, reporting the self-test: the image digest the
 * container was started from, the promptfoo version actually installed, each usage-data switch and
 * the egress probe), then loops lease → run → post. No listening port; the only secret is the
 * runner token, held in memory. A fatal refusal (revoked, self-test required) ends the process
 * after a pause, so a restart policy cannot hammer the gateway.
 */
import { readFileSync } from "node:fs";
import { buildSelfTest, runOnce, RunnerClient } from "@regulait/engine-runner";
import { ENGINE_MANIFEST } from "@regulait/shared";
import { promptfooAdapter } from "./adapter.js";

export const PROMPTFOO_HOME = process.env.REGULAIT_PROMPTFOO_HOME ?? "/opt/promptfoo/node_modules/promptfoo";

/** the promptfoo version actually installed in the image (never the manifest's claim) */
export function installedPromptfooVersion(home = PROMPTFOO_HOME): string {
  return (JSON.parse(readFileSync(`${home}/package.json`, "utf8")) as { version: string }).version;
}

async function main(): Promise<void> {
  const gatewayUrl = process.env.REGULAIT_GATEWAY_URL;
  const enrollment = process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN;
  const imageDigest = process.env.REGULAIT_ENGINE_IMAGE_DIGEST;
  if (!gatewayUrl || !enrollment || !imageDigest) {
    throw new Error("REGULAIT_GATEWAY_URL, REGULAIT_ENGINE_ENROLLMENT_TOKEN and REGULAIT_ENGINE_IMAGE_DIGEST are required");
  }
  const engineVersion = installedPromptfooVersion();
  const client = new RunnerClient({ gatewayUrl });
  const selfTest = await buildSelfTest({ imageDigest, engineVersion, requiredEnv: ENGINE_MANIFEST.promptfoo.usageDataEnv });
  const reg = await client.register(enrollment, { name: `promptfoo-${process.env.HOSTNAME ?? "runner"}`, imageDigest, engineVersion, selfTest });
  console.log(`registered runner ${reg.runnerId}; self-test ${reg.selfTest.passed ? "passed" : `failed: ${reg.selfTest.failures.join(", ")}`}`);
  const adapter = promptfooAdapter({ entrypoint: `${PROMPTFOO_HOME}/dist/src/entrypoint.js` });
  for (;;) {
    const r = await runOnce(client, adapter, { engineId: "promptfoo", engineVersion, workRoot: process.env.REGULAIT_WORK_DIR ?? "/work" });
    if (r.outcome !== "idle") console.log(`run ${r.runId}: ${r.outcome}${r.status ? ` (${r.status})` : ""}`);
    else await new Promise((res) => setTimeout(res, 5000));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`promptfoo runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}

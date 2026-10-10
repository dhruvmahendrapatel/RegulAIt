/**
 * ADR-0187 B5-P — where promptfoo is installed in the image, and the version actually installed
 * there (never the manifest's claim). Shared by the runner (main.ts) and the worker (worker-main.ts).
 */
import { readFileSync } from "node:fs";

export const PROMPTFOO_HOME = process.env.REGULAIT_PROMPTFOO_HOME ?? "/opt/promptfoo/node_modules/promptfoo";

/** the promptfoo version actually installed in the image (never the manifest's claim) */
export function installedPromptfooVersion(home = PROMPTFOO_HOME): string {
  return (JSON.parse(readFileSync(`${home}/package.json`, "utf8")) as { version: string }).version;
}

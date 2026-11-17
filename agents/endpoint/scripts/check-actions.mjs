/**
 * The endpoint agent's embedded action catalogue against the shared source (ADR-0350 §9).
 *
 *   node agents/endpoint/scripts/check-actions.mjs           exit 1 on drift, else 0
 *   node agents/endpoint/scripts/check-actions.mjs --write   rewrite internal/enforce/actions.json
 *
 * Needs packages/shared built (`pnpm --filter @regulait/shared build`). The Go agent embeds actions.json, so a
 * catalogue change in packages/shared fails here until the file is regenerated, and the Go and TypeScript suites
 * both run packages/shared/src/endpoint-actions-conformance.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const file = path.join(here, "../internal/enforce/actions.json");
const { ENDPOINT_ACTIONS } = await import(pathToFileURL(path.join(repo, "packages/shared/dist/index.js")).href);
const want = `${JSON.stringify(ENDPOINT_ACTIONS, null, 1)}\n`;

if (process.argv.includes("--write")) {
  writeFileSync(file, want);
  console.log(`wrote ${ENDPOINT_ACTIONS.length} actions`);
  process.exit(0);
}
if (readFileSync(file, "utf8") !== want) {
  console.error("packages/shared ENDPOINT_ACTIONS differs from agents/endpoint/internal/enforce/actions.json; run with --write");
  process.exit(1);
}
console.log(`ok: ${ENDPOINT_ACTIONS.length} actions match`);

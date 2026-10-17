#!/usr/bin/env node
// ADR-0195 SD3: write (or --check) the osquery query pack and its manifest from the endpoint signature seed.
// Reads the BUILT @regulait/shared (run `pnpm -r build` first). The shared test suite fails if the committed
// files drift from what this script writes.
//
//   node scripts/endpoint-pack-build.mjs           # write endpoint-discovery/osquery/{regulait-ai-discovery.conf,manifest.json}
//   node scripts/endpoint-pack-build.mjs --check   # exit 1 if the committed files differ
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = await import(path.join(root, "packages/shared/dist/index.js"));
const { manifest, packText } = shared.buildEndpointPackManifest();
const outDir = path.join(root, "endpoint-discovery", "osquery");
const files = [
  [path.join(outDir, shared.ENDPOINT_PACK_FILE), packText],
  [path.join(outDir, "manifest.json"), shared.renderEndpointPackManifest(manifest)],
];

if (process.argv.includes("--check")) {
  let drift = false;
  for (const [file, want] of files) {
    let have = null;
    try {
      have = readFileSync(file, "utf8");
    } catch {
      have = null;
    }
    if (have !== want) {
      drift = true;
      console.error(`drift: ${path.relative(root, file)} differs from the generated content`);
    }
  }
  process.exit(drift ? 1 : 0);
}
mkdirSync(outDir, { recursive: true });
for (const [file, text] of files) {
  writeFileSync(file, text);
  console.log(`wrote ${path.relative(root, file)}`);
}

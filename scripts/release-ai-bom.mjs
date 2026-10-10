#!/usr/bin/env node
// =============================================================================
// release-ai-bom.mjs — ADR-0189 slice B7: OUR OWN install-scope AI BOM per
// release, BOM-linked (CycloneDX BOM-Link) to ADR-0184's workspace and image
// SBOMs through a signed SBOM identity file (amendment R9).
//
// INERT UNTIL THE R17 SWITCH FLIPS (R28): `build` goes through
// `runReleaseAiBomStep`, the only exported build path, which reads
// `AI_BOM_SNAPSHOTS_RELEASED` (packages/shared/src/bom/release-switch.ts, the
// same constant the gateway's snapshot routes use). While it is false the
// command prints that it is inert, writes nothing and exits 0. There is no
// override anywhere; the shared tests mock the switch module.
//
// It never signs: `.github/workflows/release-ai-bom.yml` signs the files in a
// separate, cosign-only job.
//
// Needs `pnpm --filter @regulait/shared build` first (imports its dist).
//
// usage:
//   release-ai-bom.mjs switch
//       prints `released=true|false` (for $GITHUB_OUTPUT)
//   release-ai-bom.mjs check-inventory [--inventory security/ai-dev-stack.json]
//       validates the checked-in inventory (always runs; writes nothing)
//   release-ai-bom.mjs build --commit <sha> --committed-at <ISO ms>
//       --image-digest sha256:<hex> --workspace <sbom-workspace.cdx.json>
//       --image <sbom-image.cdx.json> [--inventory <file>] --out-dir <dir>
//       writes release-sbom-identity.json and the AI BOM files
// exit: 0 done or inert; 1 refused; 2 usage error
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = await import(path.join(root, "packages/shared/dist/bom/index.js"));
const { AI_BOM_SNAPSHOTS_RELEASED, parseAiDevStackInventory, runReleaseAiBomStep } = shared;

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
const KNOWN_ARGS = ["inventory", "commit", "committed-at", "image-digest", "workspace", "image", "out-dir"];
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i];
  // value-free: an argument is named by its position, never echoed
  if (!k?.startsWith("--") || rest[i + 1] === undefined || !KNOWN_ARGS.includes(k.slice(2))) usage(`argument ${i + 1} is not a known --name value pair`);
  args[k.slice(2)] = rest[i + 1];
}
function usage(msg) {
  console.error(`release-ai-bom: ${msg}`);
  process.exit(2);
}
const need = (k) => args[k] ?? usage(`--${k} is required`);
// value-free: a read error names the argument, never the path or the content
const read = (k) => {
  const f = need(k);
  try {
    return readFileSync(f);
  } catch {
    throw new Error(`--${k} is not readable`);
  }
};
// value-free: a parse error names the argument, never the file's content (JSON.parse echoes it)
const json = (f, what) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    throw new Error(`${what} is not readable JSON`);
  }
};
const inert = () => {
  console.log("release AI BOM: inert (ADR-0189 R28): AI_BOM_SNAPSHOTS_RELEASED is false; nothing built, signed or written");
  process.exit(0);
};

try {
  switch (cmd) {
    case "switch":
      console.log(`released=${AI_BOM_SNAPSHOTS_RELEASED === true}`);
      break;
    case "check-inventory": {
      const inv = parseAiDevStackInventory(json(args.inventory ?? path.join(root, "security/ai-dev-stack.json"), "--inventory"));
      console.log(`ai dev-stack inventory: ${inv.tools.length} tool(s), reviewed ${inv.reviewedOn} (${inv.reviewRef})`);
      break;
    }
    case "build": {
      if (!AI_BOM_SNAPSHOTS_RELEASED) inert();
      const result = runReleaseAiBomStep({
        commit: need("commit"),
        committedAt: need("committed-at"),
        inventory: json(args.inventory ?? path.join(root, "security/ai-dev-stack.json"), "--inventory"),
        sboms: { imageDigest: need("image-digest"), workspace: read("workspace"), image: read("image") },
      });
      if (result.status !== "built") inert();
      const out = need("out-dir");
      mkdirSync(out, { recursive: true });
      for (const f of result.files) writeFileSync(path.join(out, f.name), f.bytes);
      console.log(`wrote ${result.files.map((f) => f.name).join(", ")} (body sha256 ${result.build.bodySha256})`);
      break;
    }
    default:
      usage("command must be one of: switch, check-inventory, build");
  }
} catch (e) {
  console.error(`release-ai-bom: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

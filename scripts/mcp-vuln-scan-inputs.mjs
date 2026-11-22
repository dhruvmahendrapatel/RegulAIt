#!/usr/bin/env node
/**
 * ADR-0242 / ADR-0246 (lane L4): write the tools.json the gateway would hand the mcpscanner driver for every
 * clean-room vulnerable MCP fixture (@regulait/mcp-vuln-fixtures), one directory per attack class and phase:
 *
 *   node scripts/mcp-vuln-scan-inputs.mjs <out-dir>
 *
 * Each `<out-dir>/<class>-<phase>/tools.json` is `{"tools":[...]}`, the tools/list shape the admission gate stores
 * and scans (ADR-0242 L4.3). Only tools are written, because only tools are what admission scans today. The fake
 * credentials some fixtures return live in their call results, which `listedTools` leaves out, so no secret-shaped
 * text reaches the files.
 *
 * Used to record the engine's measured verdicts on the fixtures (packages/shared/src/engines/fixtures/admission-scan/
 * vuln/*.json); `vulnScanInput` is what the test uses to prove each recorded report is about the current fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_ATTACK_CLASSES, listedTools, manifestFor, vulnFixture } from "../packages/mcp-vuln-fixtures/dist/index.js";

/** every (class, phase) pair a fixture serves: the approved manifest, and the pulled one where the class has it */
export function vulnScanCases() {
  const out = [];
  for (const id of MCP_ATTACK_CLASSES) {
    const f = vulnFixture(id);
    out.push({ id, phase: "approved" });
    if (f.phases.pulled) out.push({ id, phase: "pulled" });
  }
  return out;
}

/** the bytes of the tools.json the driver would read for one case */
export function vulnScanInput(id, phase) {
  return Buffer.from(JSON.stringify({ tools: listedTools(manifestFor(vulnFixture(id), phase)) }), "utf8");
}

function main(argv) {
  const outDir = argv[2];
  if (!outDir) {
    process.stderr.write("usage: mcp-vuln-scan-inputs.mjs <out-dir>\n");
    process.exit(64);
  }
  for (const { id, phase } of vulnScanCases()) {
    const dir = path.join(outDir, `${id}-${phase}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "tools.json"), vulnScanInput(id, phase));
  }
  process.stdout.write(`wrote ${vulnScanCases().length} inputs under ${outDir}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);

// Syntax-check the <script> blocks inside the two single-file UIs (ADR-0012).
// The UIs are template-literal HTML strings, so tsc never parses their inline
// JS — a typo ships a blank page with a green build. This imports the BUILT
// modules (so shared fragments like UI_ERRORS_JS are already interpolated),
// extracts each rendered <script> block, and runs `node --check` on it.
import { writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targets = [
  { module: "../apps/gateway/dist/app-ui.js", exportName: "APP_HTML" },
  { module: "../apps/gateway/dist/admin-portal.js", exportName: "ADMIN_PORTAL_HTML" },
];

const dir = mkdtempSync(join(tmpdir(), "ui-check-"));
let failed = false;

for (const { module, exportName } of targets) {
  const html = (await import(new URL(module, import.meta.url)))[exportName];
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocks.length === 0) {
    console.error(`${exportName}: no <script> block found — extraction is broken`);
    failed = true;
    continue;
  }
  blocks.forEach(([, js], i) => {
    const file = join(dir, `${exportName}.${i}.js`);
    writeFileSync(file, js);
    const res = spawnSync("node", ["--check", file], { encoding: "utf8" });
    if (res.status !== 0) {
      console.error(`${exportName} script #${i}: SYNTAX ERROR\n${res.stderr}`);
      failed = true;
    } else {
      console.log(`${exportName} script #${i}: ok (${js.length} chars)`);
    }
  });
}

process.exit(failed ? 1 : 0);

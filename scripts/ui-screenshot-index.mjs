#!/usr/bin/env node
/**
 * The screenshot pack's index (ADR-0196): one static HTML page over the shots that
 * apps/web/e2e/enterprise/screenshots.ent.spec.ts wrote, one row per screen, one thumbnail per viewport and theme,
 * each linking to the full image. No script, no network: it opens from the unzipped CI artifact.
 *
 * Usage: node scripts/ui-screenshot-index.mjs [packDir]   (default apps/web/test-results/screenshot-pack)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** read every `<slug>/manifest.json` under the pack, sorted by route */
export function readPack(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "manifest.json")))
    .map((d) => JSON.parse(readFileSync(path.join(dir, d.name, "manifest.json"), "utf8")))
    .sort((a, b) => a.route.localeCompare(b.route));
}

export function renderIndex(entries, generatedAt = new Date().toISOString()) {
  const shotCount = entries.reduce((n, e) => n + e.shots.length, 0);
  const rows = entries
    .map((e) => {
      const cells = e.shots
        .map((s) => {
          const label = path.basename(s, ".jpg");
          return `<figure><a href="${esc(s)}"><img src="${esc(s)}" alt="${esc(`${e.route} at ${label}`)}" loading="lazy" width="240"></a><figcaption>${esc(label)}</figcaption></figure>`;
        })
        .join("");
      return `<section id="${esc(e.route)}"><h2>${esc(e.route)}</h2><div class="shots">${cells}</div></section>`;
    })
    .join("\n");
  const toc = entries.map((e) => `<li><a href="#${esc(e.route)}">${esc(e.route)}</a></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>regulAIt screenshot pack</title>
<style>
:root{color-scheme:light dark;--bg:#f7fafe;--fg:#121416;--line:#d1d5d8}
@media (prefers-color-scheme:dark){:root{--bg:#121416;--fg:#f0f4f7;--line:#484b4e}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
section{border-top:1px solid var(--line);padding:8px 0}
h2{font-size:15px;margin:8px 0}
.shots{display:flex;flex-wrap:wrap;gap:8px}
figure{margin:0}img{display:block;border:1px solid var(--line);max-width:100%;height:auto}
figcaption{font-size:12px}
ul{columns:4;font-size:12px}
</style></head><body>
<h1>regulAIt screenshot pack</h1>
<p>${entries.length} screens, ${shotCount} shots (screen x viewport x theme), against the harness's mocked API, generated ${esc(generatedAt)}.</p>
<ul>${toc}</ul>
${rows}
</body></html>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = path.resolve(process.argv[2] ?? path.join(root, "apps", "web", "test-results", "screenshot-pack"));
  const entries = readPack(dir);
  if (entries.length === 0) {
    console.error(`no screenshots under ${dir}; run the screenshots project first`);
    process.exit(1);
  }
  writeFileSync(path.join(dir, "index.html"), renderIndex(entries));
  console.log(`wrote ${path.join(dir, "index.html")} (${entries.length} screens)`);
}

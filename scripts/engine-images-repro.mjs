#!/usr/bin/env node
/**
 * ENG-IMG reproducible builds (ADR-0187 addendum 2026-10-21) — compare two independent builds of each engine image.
 *
 *   node scripts/engine-images-repro.mjs <dir> [--summary <file>]
 *
 * <dir> holds the `repro` records of `scripts/build-engine-image.sh <engine> repro <out.json>`, two per engine, named
 * `<engine>-a.json` and `<engine>-b.json` (engine-images-build.yml builds them on two runners, each in a fresh builder).
 * Per engine, both records must exist, name the same input commit and SOURCE_DATE_EPOCH, and carry the same manifest
 * digest and image id. Every engine is reported, then the command exits 1 if any engine failed.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ENGINE_IDS } from "./engine-images-lock.mjs";

/** the verdict per engine for records { a, b } (either may be undefined: that build did not finish) */
export function compareBuilds(records) {
  const rows = [];
  for (const id of ENGINE_IDS) {
    const { a, b } = records[id] ?? {};
    let ok = false;
    let why;
    if (!a || !b) why = `missing build ${!a ? "a" : "b"}`;
    else if (a.engine !== id || b.engine !== id) why = "a record names another engine";
    else if (a.inputCommit !== b.inputCommit || a.sourceDateEpoch !== b.sourceDateEpoch) why = "the two builds used different inputs";
    else if (a.manifestDigest !== b.manifestDigest || a.imageId !== b.imageId) why = "NOT reproducible: the digests differ";
    else {
      ok = true;
      why = "reproducible";
    }
    rows.push({ engine: id, ok, why, a, b });
  }
  return rows;
}

function render(rows) {
  const lines = ["### Engine images: two clean builds per engine", "", "| engine | result | input commit | manifest digest (a) | manifest digest (b) | image id (a) | image id (b) |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.engine} | ${r.ok ? "✅" : "❌"} ${r.why} | ${r.a?.inputCommit ?? "–"} | \`${r.a?.manifestDigest ?? "–"}\` | \`${r.b?.manifestDigest ?? "–"}\` | \`${r.a?.imageId ?? "–"}\` | \`${r.b?.imageId ?? "–"}\` |`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) {
    console.error("usage: engine-images-repro.mjs <dir> [--summary <file>]");
    process.exit(2);
  }
  const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);
  const records = Object.fromEntries(ENGINE_IDS.map((id) => [id, { a: read(path.join(dir, `${id}-a.json`)), b: read(path.join(dir, `${id}-b.json`)) }]));
  const rows = compareBuilds(records);
  const out = render(rows);
  process.stdout.write(out);
  const i = argv.indexOf("--summary");
  if (i !== -1 && argv[i + 1]) appendFileSync(argv[i + 1], out);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}

#!/usr/bin/env node
/**
 * ADR-0187 decision 59 (PR #205 review) — read promptfoo's own plugin and strategy lists out of an
 * installed, pinned package, so the shared catalogue's cloud-only list is GENERATED from upstream
 * and cannot drift from it.
 *
 * It parses (does not execute) the bundled constants chunk that defines `REMOTE_ONLY_PLUGIN_IDS`:
 * plain `const NAME = [...]` arrays and `const NAME = {...}` objects of string literals, with
 * `...NAME` and `...Object.keys(NAME)` spreads resolved. A list it cannot find, or an element it
 * cannot read, is an error (exit 1): an upgrade that changes the shape fails loudly.
 *
 * Usage:
 *   node extract-plugin-lists.mjs <promptfoo package dir> --ts   > packages/shared/src/engines/promptfoo-upstream.ts
 *   node extract-plugin-lists.mjs <promptfoo package dir> --json (what the opt-in drift test compares)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** the balanced `[...]` or `{...}` literal starting at `start` (string-aware) */
function balanced(src, start) {
  const open = src[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(start + 1, i);
  }
  throw new Error("unbalanced literal");
}

/** split a literal body on top-level commas */
function elements(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === "\\") cur += body[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if ("[{(".includes(c)) depth++;
    if ("]})".includes(c)) depth--;
    if (c === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseString(s) {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (!m) throw new Error(`not a string literal: ${s.slice(0, 60)}`);
  return JSON.parse(`"${m[1]}"`);
}

export function extractLists(promptfooDir) {
  const srcDir = path.join(promptfooDir, "dist", "src");
  const file = readdirSync(srcDir)
    .filter((f) => f.endsWith(".js") && f.startsWith("tables-"))
    .sort()
    .find((f) => readFileSync(path.join(srcDir, f), "utf8").includes("const REMOTE_ONLY_PLUGIN_IDS = ["));
  if (!file) throw new Error("no constants chunk defines REMOTE_ONLY_PLUGIN_IDS");
  const buf = readFileSync(path.join(srcDir, file));
  const src = buf.toString("utf8");
  const defs = new Map();
  for (const m of src.matchAll(/\bconst (_?[A-Z][A-Z0-9_]*) = ([[{])/g)) {
    defs.set(m[1], { kind: m[2], body: balanced(src, m.index + m[0].length - 1) });
  }
  const cache = new Map();
  /** an array's strings, or an object's keys */
  const resolve = (name) => {
    if (cache.has(name)) return cache.get(name);
    const d = defs.get(name);
    if (!d) throw new Error(`no definition of ${name}`);
    const out = [];
    for (const el of elements(d.body)) {
      let m;
      if ((m = /^\.\.\.Object\.keys\(([A-Z][A-Z0-9_]*)\)$/.exec(el))) out.push(...resolve(m[1]));
      else if ((m = /^\.\.\.([A-Z][A-Z0-9_]*)$/.exec(el))) out.push(...resolve(m[1]));
      else if (d.kind === "[") out.push(parseString(el));
      else {
        const key = /^("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\s*:/.exec(el);
        if (!key) throw new Error(`${name}: cannot read entry ${el.slice(0, 60)}`);
        out.push(key[1].startsWith('"') ? parseString(key[1]) : key[1]);
      }
    }
    cache.set(name, out);
    return out;
  };
  const uniq = (a) => [...new Set(a)].sort();
  const defaultPlugins = uniq([...resolve("BASE_PLUGINS"), ...resolve("HARM_PLUGINS"), ...resolve("PII_PLUGINS"), ...resolve("BIAS_PLUGINS")]);
  return {
    sourceFile: `dist/src/${file}`,
    sourceSha256: createHash("sha256").update(buf).digest("hex"),
    remoteOnlyPlugins: uniq(resolve("REMOTE_ONLY_PLUGIN_IDS")),
    unalignedHarmPlugins: uniq(resolve("UNALIGNED_PROVIDER_HARM_PLUGINS")),
    biasPlugins: uniq(resolve("BIAS_PLUGINS")),
    datasetPlugins: uniq(resolve("DATASET_PLUGINS")),
    collections: uniq(resolve("COLLECTIONS")),
    allPlugins: uniq([...defaultPlugins, ...resolve("ADDITIONAL_PLUGINS"), ...resolve("CONFIG_REQUIRED_PLUGINS"), ...resolve("AGENTIC_PLUGINS")]),
    allStrategies: uniq(resolve("_ALL_STRATEGIES")),
  };
}

function asTs(lists, version) {
  const arr = (name, a) => `export const ${name}: readonly string[] = Object.freeze([\n${a.map((s) => `  ${JSON.stringify(s)},`).join("\n")}\n]);\n`;
  return `/**
 * GENERATED — do not edit. ADR-0187 decision 59: promptfoo's own plugin and strategy lists, read
 * from the pinned package by engines/promptfoo/extract-plugin-lists.mjs (parsed, not executed).
 *
 * Package:  npm \`promptfoo@${version}\`
 * Source:   ${lists.sourceFile}
 * sha256:   ${lists.sourceSha256}
 *
 * The catalogue (promptfoo.ts) derives its cloud-only list from these, and its tests refuse a
 * catalogue entry that contradicts them; the opt-in drift test re-extracts from an installed
 * package and compares. To update: pin a new release, re-run the extractor, re-read R10.
 */
export const PROMPTFOO_UPSTREAM_VERSION = ${JSON.stringify(version)};
export const PROMPTFOO_UPSTREAM_SOURCE_SHA256 = ${JSON.stringify(lists.sourceSha256)};
${arr("PROMPTFOO_UPSTREAM_REMOTE_ONLY_PLUGINS", lists.remoteOnlyPlugins)}${arr("PROMPTFOO_UPSTREAM_UNALIGNED_HARM_PLUGINS", lists.unalignedHarmPlugins)}${arr("PROMPTFOO_UPSTREAM_BIAS_PLUGINS", lists.biasPlugins)}${arr("PROMPTFOO_UPSTREAM_DATASET_PLUGINS", lists.datasetPlugins)}${arr("PROMPTFOO_UPSTREAM_COLLECTIONS", lists.collections)}${arr("PROMPTFOO_UPSTREAM_ALL_PLUGINS", lists.allPlugins)}${arr("PROMPTFOO_UPSTREAM_ALL_STRATEGIES", lists.allStrategies)}`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [dir, mode] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: extract-plugin-lists.mjs <promptfoo package dir> [--ts|--json]");
    process.exit(2);
  }
  try {
    const lists = extractLists(dir);
    const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
    process.stdout.write(mode === "--ts" ? asTs(lists, version) : `${JSON.stringify({ version, ...lists }, null, 2)}\n`);
  } catch (e) {
    console.error(`extract refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

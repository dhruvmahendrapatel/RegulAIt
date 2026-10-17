#!/usr/bin/env node
/**
 * PRE-FLIGHT: NO NEW HARD-CODED COLOUR OR SPACING IN THE WEB APP (ADR-0196, bar 3).
 *
 * Every colour and every padding, margin and gap in apps/web/src should come from the design tokens
 * (src/theme/tokens.css: `var(--rg-*)`, `var(--s1)` …). This is a RATCHET in the import-cycle job's model (#387):
 * the counts that exist today are in scripts/ui-tokens.baseline.json; a file whose count of a finding goes UP
 * fails, and so does a file whose count went DOWN without the baseline being shrunk (run with --update and commit
 * the smaller file). CI also refuses a baseline that grows against the base branch
 * (scripts/ui-enterprise-baseline.mjs --guard).
 *
 * Findings:
 *   CSS (stylelint, MIT, pinned in apps/web; built-in rules only, no plugin):
 *     color-no-hex                          `#0af`, `#00aaff` …
 *     color-named                           `white`, `red` … (`transparent` and `currentColor` are not colours here)
 *     function-disallowed-list              `rgb()`, `hsl()`, `oklch()` … colour functions with literal channels
 *     declaration-property-unit-disallowed-list   px / rem / em on padding, margin and gap
 *   TS/TSX (a scan of string literals and inline style objects; stylelint does not read TSX):
 *     ts-color-literal                      a hex or colour-function literal inside a string
 *     ts-spacing-literal                    padding / margin / gap given a number or a px / rem / em string
 *
 * Left out: src/theme/tokens.css and src/theme/fonts.css (the token source), and test files.
 *
 * Usage (from the repository root, after `pnpm install`):
 *   node scripts/preflight-ui-tokens.mjs            # check; exit 1 on a regression or a stale entry, 2 if it cannot run
 *   node scripts/preflight-ui-tokens.mjs --update   # rewrite the baseline from the current source
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(root, "apps", "web");
const SRC = path.join(WEB, "src");
export const BASELINE_FILE = path.join(root, "scripts", "ui-tokens.baseline.json");
const TOKEN_SOURCES = new Set(["apps/web/src/theme/tokens.css", "apps/web/src/theme/fonts.css"]);

export const STYLELINT_CONFIG = {
  rules: {
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch"],
    "declaration-property-unit-disallowed-list": {
      "/^(padding|margin|gap|row-gap|column-gap)(-|$)/": ["px", "rem", "em"],
    },
  },
};

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const SPACING = /\b(padding|margin|gap|rowGap|columnGap)(?:Top|Right|Bottom|Left|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?\s*:\s*(?:-?\d+(?:\.\d+)?\s*[,}\n]|["'`][^"'`\n]*\d(?:px|rem|em)\b)/g;

const rel = (f) => path.relative(root, f).split(path.sep).join("/");

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isTest = (f) => /\.test\.tsx?$/.test(f);

/** `{ file: { finding: count } }` for TS/TSX source text */
export function scanTs(files) {
  const out = {};
  for (const [file, text] of files) {
    const f = {};
    for (const line of text.split("\n")) {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      for (const m of code.matchAll(STRING)) if (COLOR_LITERAL.test(m[2])) f["ts-color-literal"] = (f["ts-color-literal"] ?? 0) + 1;
      for (const _ of code.matchAll(SPACING)) f["ts-spacing-literal"] = (f["ts-spacing-literal"] ?? 0) + 1;
    }
    if (Object.keys(f).length) out[file] = f;
  }
  return out;
}

/** `{ file: { rule: count } }` from stylelint over every CSS file in apps/web/src */
export async function scanCss(cssFiles) {
  const req = createRequire(path.join(WEB, "package.json"));
  const { default: stylelint } = await import(pathToFileURL(req.resolve("stylelint")).href);
  const { results } = await stylelint.lint({ files: cssFiles, config: STYLELINT_CONFIG, cwd: root });
  const out = {};
  for (const r of results) {
    const f = {};
    for (const w of r.warnings) f[w.rule] = (f[w.rule] ?? 0) + 1;
    if (Object.keys(f).length) out[rel(r.source)] = f;
  }
  return out;
}

export async function currentFindings() {
  const files = walk(SRC);
  const css = files.filter((f) => f.endsWith(".css") && !TOKEN_SOURCES.has(rel(f)));
  const ts = files.filter((f) => /\.tsx?$/.test(f) && !isTest(f)).map((f) => [rel(f), readFileSync(f, "utf8")]);
  return sortDeep({ ...(await scanCss(css)), ...scanTs(ts) });
}

function sortDeep(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, typeof o[k] === "object" ? sortDeep(o[k]) : o[k]]));
}

/** regressions (above the baseline) and stale entries (below it) */
export function compare(baseline, current) {
  const over = [];
  const stale = [];
  for (const [file, f] of Object.entries(current)) {
    for (const [rule, n] of Object.entries(f)) {
      const b = baseline[file]?.[rule] ?? 0;
      if (n > b) over.push(`${file}: ${rule} ${n} (baseline ${b})`);
    }
  }
  for (const [file, f] of Object.entries(baseline)) {
    for (const [rule, b] of Object.entries(f)) {
      const n = current[file]?.[rule] ?? 0;
      if (n < b) stale.push(`${file}: ${rule} ${n} (baseline ${b})`);
    }
  }
  return { over, stale };
}

export const readBaseline = () => (existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")).entries : {});

async function main() {
  const current = await currentFindings();
  const total = (o) => Object.values(o).reduce((n, f) => n + Object.values(f).reduce((a, b) => a + b, 0), 0);
  if (process.argv.includes("--update")) {
    writeFileSync(
      BASELINE_FILE,
      `${JSON.stringify({ _about: "ADR-0196 design-token ratchet (scripts/preflight-ui-tokens.mjs). Counts may only shrink.", entries: current }, null, 2)}\n`,
    );
    console.log(`wrote ${rel(BASELINE_FILE)}: ${total(current)} findings in ${Object.keys(current).length} files`);
    return 0;
  }
  const { over, stale } = compare(readBaseline(), current);
  for (const line of over) console.log(`NEW   ${line}`);
  for (const line of stale) console.log(`STALE ${line}  (shrink the baseline: node scripts/preflight-ui-tokens.mjs --update)`);
  console.log(`design tokens: ${total(current)} hard-coded findings in ${Object.keys(current).length} files; ${over.length} new, ${stale.length} stale`);
  return over.length || stale.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}

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
 *   CSS (parsed with postcss, MIT, pinned in apps/web; the rule names follow stylelint's built-in rules):
 *     color-no-hex                          `#0af`, `#00aaff` …
 *     color-named                           `white`, `red` … (`transparent` and `currentColor` are not colours here)
 *     function-disallowed-list              `rgb()`, `hsl()`, `oklch()` … colour functions
 *     declaration-property-unit-disallowed-list   px / rem / em on padding, margin and gap
 *   stylelint itself was tried first (ADR-0196) and dropped: its file-globbing dependencies pull in `braces` 3.0.3,
 *   which has a high advisory with no fixed release, and the four rules need only a CSS parser.
 *   TS/TSX (a scan of string literals and inline style objects):
 *     ts-color-literal                      a hex or colour-function literal inside a string
 *     ts-spacing-literal                    padding / margin / gap given a number or a px / rem / em string
 *
 * Left out: src/theme/tokens.css, src/theme/fonts.css and src/theme/palettes.css (the token sources: palettes.css
 * re-defines tokens per T1 palette, AA-checked by src/theme/palette.test.ts), and test files.
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
const TOKEN_SOURCES = new Set(["apps/web/src/theme/tokens.css", "apps/web/src/theme/fonts.css", "apps/web/src/theme/palettes.css"]);

/** CSS Color 4 named colours (`transparent` and `currentcolor` are keywords, not colours, and are allowed) */
const NAMED_COLORS = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
  "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
  "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue " +
  "darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite " +
  "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory " +
  "khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
  "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
  "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
  "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
  "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
  "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
  "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke " +
  "yellow yellowgreen").split(" "));
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap)(-|$)/;
const SPACING_UNIT = /(?:^|[\s(,+*/-])-?\d*\.?\d+(?:px|rem|em)\b/g;

/** the findings in one CSS declaration; a local custom property holding a literal counts too (only tokens.css defines tokens) */
export function cssDeclFindings(prop, value) {
  const f = {};
  const add = (rule, n) => {
    if (n > 0) f[rule] = (f[rule] ?? 0) + n;
  };
  const v = value.replace(/url\([^)]*\)/gi, "url()").replace(/"[^"]*"|'[^']*'/g, '""');
  add("color-no-hex", (v.match(HEX) ?? []).length);
  add("function-disallowed-list", (v.match(COLOR_FUNCTION) ?? []).length);
  add("color-named", v.split(/[^A-Za-z-]+/).filter((w) => NAMED_COLORS.has(w.toLowerCase())).length);
  if (SPACING_PROP.test(prop.toLowerCase())) add("declaration-property-unit-disallowed-list", (v.match(SPACING_UNIT) ?? []).length);
  return f;
}

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

/** `{ file: { rule: count } }` over CSS files, parsed with postcss (the parser vite already uses) */
export async function scanCss(cssFiles) {
  const req = createRequire(path.join(WEB, "package.json"));
  const { default: postcss } = await import(pathToFileURL(req.resolve("postcss")).href);
  const out = {};
  for (const file of cssFiles) {
    const f = {};
    postcss.parse(readFileSync(file, "utf8"), { from: file }).walkDecls((decl) => {
      for (const [rule, n] of Object.entries(cssDeclFindings(decl.prop, decl.value))) f[rule] = (f[rule] ?? 0) + n;
    });
    if (Object.keys(f).length) out[rel(file)] = f;
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

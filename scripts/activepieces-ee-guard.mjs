#!/usr/bin/env node
/**
 * ADR-0255 (P31) — NO ACTIVEPIECES ENTERPRISE CODE. The Activepieces repository is MIT at the root, but everything
 * under `packages/ee/` and `packages/server/api/src/app/ee` is under a proprietary Enterprise licence. RegulAIt may
 * take only from `packages/pieces/community/*` and the pieces-framework packages. This guard fails on:
 *
 *   1. a tracked file whose path has an `ee` segment below a directory naming activepieces (a vendored EE file);
 *   2. an import, export-from, dynamic import or require of an `@activepieces/*` specifier outside the allowed set
 *      (`piece-*`, `pieces-framework`, `pieces-common`, `shared`), or of any specifier with an `ee` path segment
 *      that names activepieces;
 *   3. a lockfile entry for an `@activepieces/*` package outside the allowed set;
 *   4. a curated catalogue piece (`CURATED_PIECES` in packages/connector-provider/src/pieces.ts) whose `upstream.path`
 *      is not under `packages/pieces/community/`, or fewer upstream paths than curated pieces;
 *   5. an "available" row (`AVAILABLE_PIECES` in pieces-available.ts) whose upstream path is not exactly
 *      `packages/pieces/community/<key>`, whose name is not allowed, or a file with no recorded upstream commit.
 *
 * It is run by its test (`activepieces-ee-guard.test.mjs`), which CI's `vitest run --dir scripts` step executes, and
 * can be run by hand: `node scripts/activepieces-ee-guard.mjs` (exit 0 clean, 1 on a finding, 2 if it cannot run).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** the only @activepieces packages that are MIT community or framework code */
export function allowedActivepiecesPackage(name) {
  if (!name.startsWith("@activepieces/")) return true;
  const rest = name.slice("@activepieces/".length);
  if (rest.split("/").some((seg) => seg === "ee" || seg.startsWith("ee-") || seg.endsWith("-ee"))) return false;
  const pkg = rest.split("/")[0];
  return pkg.startsWith("piece-") || pkg === "pieces-framework" || pkg === "pieces-common" || pkg === "shared";
}

/** a path names Activepieces EE code when an `ee` segment follows a segment containing "activepieces" */
export function isActivepiecesEePath(p) {
  const segs = p.toLowerCase().split(/[\\/]/);
  const at = segs.findIndex((s) => s.includes("activepieces"));
  return at !== -1 && segs.slice(at + 1).includes("ee");
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"'\n]{1,300})["']/g,
  /\bimport\s*\(\s*["']([^"'\n]{1,300})["']/g,
  /\brequire\s*\(\s*["']([^"'\n]{1,300})["']/g,
  /^\s*import\s+["']([^"'\n]{1,300})["']/gm,
];

/** the import/require specifiers in a source text */
export function specifiers(src) {
  const out = [];
  for (const re of SPECIFIER_PATTERNS) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

export function badSpecifier(spec) {
  if (spec.startsWith("@activepieces/")) return !allowedActivepiecesPackage(spec);
  return isActivepiecesEePath(spec);
}

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SELF = new Set(["scripts/activepieces-ee-guard.mjs", "scripts/activepieces-ee-guard.test.mjs"]);

export function scan(files, read) {
  const findings = [];
  for (const f of files) {
    if (isActivepiecesEePath(f)) findings.push(`${f}: a vendored file under an Activepieces 'ee' path`);
    if (SELF.has(f)) continue;
    if (CODE.test(f)) {
      for (const spec of specifiers(read(f))) {
        if (badSpecifier(spec)) findings.push(`${f}: imports '${spec}', which is not Activepieces community or framework code`);
      }
    }
    if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(f)) {
      const text = read(f);
      for (const m of text.matchAll(/@activepieces\/[a-z0-9._-]{1,100}/g)) {
        if (!allowedActivepiecesPackage(m[0])) findings.push(`${f}: locks '${m[0]}'`);
      }
    }
  }
  return findings;
}

/** the `key:` of every CURATED_PIECES entry, parsed from pieces.ts (also used by connector-catalogue-refresh.mjs) */
export function curatedKeys(piecesSrc) {
  const start = piecesSrc.indexOf("export const CURATED_PIECES");
  if (start === -1) return [];
  const block = piecesSrc.slice(start);
  return [...block.matchAll(/^\s{4}key:\s*"([a-z0-9-]{1,80})",$/gm)].map((m) => m[1]);
}

export function curatedUpstreamFindings(piecesSrc) {
  const findings = [];
  const keys = curatedKeys(piecesSrc);
  const paths = [...piecesSrc.matchAll(/upstream:\s*\{[^}]{0,300}\bpath:\s*"([^"]{0,200})"/g)].map((m) => m[1]);
  // a regex that matches nothing must not pass as "checked" (#753 review)
  if (keys.length === 0) findings.push("CURATED_PIECES: no curated piece keys found; the check would be vacuous");
  if (paths.length < keys.length) findings.push(`CURATED_PIECES: ${keys.length} pieces but only ${paths.length} upstream paths found`);
  for (const p of paths) {
    if (!p.startsWith("packages/pieces/community/") || p.split("/").includes("ee") || p.includes("..")) {
      findings.push(`CURATED_PIECES: upstream path '${p}' is not under packages/pieces/community/`);
    }
  }
  return findings;
}

/**
 * Every AVAILABLE_PIECES row in pieces-available.ts names its upstream path, and that path is exactly
 * packages/pieces/community/<key> for an allowed package name; the file records the upstream commit it was checked at.
 */
export function availableFindings(availableSrc) {
  const findings = [];
  const rows = [...availableSrc.matchAll(/^\s{2}\["([^"\n]{0,100})", "([^"\n]{0,50})", "([^"\n]{0,200})"\],$/gm)];
  const lines = availableSrc.split("\n").filter((l) => /^\s{2}\["/.test(l)).length;
  if (rows.length === 0) findings.push("AVAILABLE_PIECES: no rows found; the check would be vacuous");
  if (rows.length !== lines) findings.push(`AVAILABLE_PIECES: ${lines} rows but only ${rows.length} are [key, version, path]`);
  if (!/commit:\s*"[0-9a-f]{40}"/.test(availableSrc)) findings.push("AVAILABLE_PIECES_SOURCE: no 40-character upstream commit recorded");
  for (const [, key, , p] of rows) {
    if (p !== `packages/pieces/community/${key}`) findings.push(`AVAILABLE_PIECES: '${key}' has upstream path '${p}', not packages/pieces/community/${key}`);
    if (!allowedActivepiecesPackage(`@activepieces/piece-${key}`)) findings.push(`AVAILABLE_PIECES: '${key}' is not an allowed package name`);
  }
  return findings;
}

export function run() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const read = (f) => {
    try {
      return readFileSync(path.join(root, f), "utf8");
    } catch {
      return ""; // a tracked file deleted in the working tree has nothing to import
    }
  };
  const pieces = read("packages/connector-provider/src/pieces.ts");
  const available = read("packages/connector-provider/src/pieces-available.ts");
  return [...scan(files, read), ...curatedUpstreamFindings(pieces), ...availableFindings(available)];
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const findings = run();
    if (findings.length) {
      console.error(`activepieces-ee-guard: ${findings.length} finding(s) (ADR-0255: no Activepieces Enterprise code)`);
      for (const f of findings) console.error(`  ${f}`);
      process.exit(1);
    }
    console.log("activepieces-ee-guard: clean");
  } catch (e) {
    console.error("activepieces-ee-guard could not run:", e);
    process.exit(2);
  }
}

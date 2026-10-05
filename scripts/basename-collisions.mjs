/**
 * Tracked files that a case-insensitive filesystem cannot tell apart through an
 * extensionless import (codexInputs G10-G15-VERIFY).
 *
 *   node scripts/basename-collisions.mjs     exit 1 and list them, else exit 0
 *
 * `CommandPalette.tsx` beside `commandPalette.ts` is two files on Linux and on
 * CI. On a Windows (or default macOS) checkout, `import "./CommandPalette"`
 * tries `CommandPalette.ts` first, the filesystem answers with
 * `commandPalette.ts`, and `tsc` fails with TS1149/TS1261 (casing) plus missing
 * exports — so the web app neither typechecks nor builds there, while every
 * Linux gate stays green. `forceConsistentCasingInFileNames` is what reports it;
 * the fix is to rename, never to turn that off.
 *
 * The rule: no two tracked files in the same directory may have names that are
 * equal once case-folded and stripped of their LAST extension. `foo.module.css`
 * keeps its stem `foo.module`, and `foo.test.ts` its stem `foo.test`, so a
 * component, its CSS module and its test never collide; `Foo.tsx` and `foo.ts`
 * do, and so do `README.md` and `readme.md`. A dotfile (`.gitignore`) has no
 * extension, as `path.extname` says.
 *
 * Paths are split on BOTH separators, so the check gives the same answer for a
 * list produced on Windows.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** directory + case-folded stem: the key two colliding files share */
export function collisionKey(file) {
  const parts = String(file).split(/[\\/]/);
  const name = parts.pop() ?? "";
  const ext = path.posix.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${parts.join("/")}/${stem.toLowerCase()}`;
}

/** groups of 2+ paths that collide, each sorted, in path order */
export function findBasenameCollisions(files) {
  const byKey = new Map();
  for (const f of files) {
    const k = collisionKey(f);
    const list = byKey.get(k) ?? [];
    list.push(String(f));
    byKey.set(k, list);
  }
  return [...byKey.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** every tracked path, from git (`-z`: no quoting of unusual names) */
export function trackedFiles(cwd) {
  return execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const groups = findBasenameCollisions(trackedFiles(root));
  if (groups.length === 0) {
    console.log("basename-collisions: none");
  } else {
    for (const g of groups) console.error(`collision (case-insensitive, extension-stripped): ${g.join("  <->  ")}`);
    process.exitCode = 1;
  }
}

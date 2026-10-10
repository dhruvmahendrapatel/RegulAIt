/** ADR-0186 decision 30 item 3 (B4I-03): every wall-clock budget test runs in the serialized `timing` project. */
import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Read from the config's text: the config sits outside this package's compiled rootDir.
const config = readFileSync(path.join(root, "vitest.config.ts"), "utf8");
const TIMING_FILES = [...config.slice(config.indexOf("TIMING_FILES = ["), config.indexOf("];", config.indexOf("TIMING_FILES = ["))).matchAll(/"([^"]+\.test\.ts)"/g)].map((m) => m[1]!);
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(full);
    return entry.name.endsWith(".test.ts") ? [path.relative(root, full).split(path.sep).join("/")] : [];
  });
}

it("every test file that bounds elapsed wall time is in the serialized timing project", () => {
  const timed = testFiles(path.join(root, "src")).filter((file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    return /performance\.now\(\)|Date\.now\(\)/.test(text) && /toBeLessThan(?:OrEqual)?\(/.test(text);
  });
  expect(timed.length).toBeGreaterThan(0);
  expect(timed.filter((file) => !TIMING_FILES.includes(file))).toEqual([]);
  // and the list names only files that exist
  expect(TIMING_FILES.filter((file) => !timed.includes(file) && !testFiles(path.join(root, "src")).includes(file))).toEqual([]);
});

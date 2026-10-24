// FS-55: the ADR index (internal/decisions/README.md) has one well-formed row per
// ADR file, in number order, and every relative link in it resolves.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../internal/decisions");
const index = readFileSync(path.join(dir, "README.md"), "utf8");
const rowLines = index.split("\n").filter((l) => /^\| *\[\d{4}\]/.test(l));
/** GFM splits a table row on every `|` not escaped as `\|`, code spans included */
const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1);
const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();

describe("ADR index parity (FS-55)", () => {
  it("has one row per ADR file and no row without a file", () => {
    // non-vacuity: the real index, not an empty read
    expect(files.length).toBeGreaterThan(190);
    const rowIds = rowLines.map((l) => /^\| *\[(\d{4})\]/.exec(l)[1]);
    expect(rowIds).toEqual(files.map((f) => f.slice(0, 4)));
  });

  it("rows are in ascending number order", () => {
    const ids = rowLines.map((l) => Number(/^\| *\[(\d{4})\]/.exec(l)[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("every row has four cells: linked id, title, status, date", () => {
    const bad = rowLines
      .map((l) => ({ id: l.slice(3, 7), c: cells(l) }))
      .filter(({ c }) => c.length !== 4 || !/^\d{4}-\d{2}-\d{2}/.test(c[3].trim()) || c[2].trim() === "")
      .map(({ id, c }) => `${id} (${c.length} cells)`);
    expect(bad).toEqual([]);
  });

  it("each row's id link names its own file", () => {
    for (const l of rowLines) {
      const [, id, target] = /^\| *\[(\d{4})\]\(([^)]+)\)/.exec(l);
      expect(target.startsWith(`${id}-`), l.slice(0, 60)).toBe(true);
    }
  });

  it("every relative link in the index resolves", () => {
    const missing = [...index.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1].split("#")[0])
      .filter((t) => t && !/^[a-z]+:/i.test(t))
      .filter((t) => !existsSync(path.resolve(dir, t)));
    expect(missing).toEqual([]);
  });

  it("a file whose status is partially superseded is not indexed as plain Accepted", () => {
    for (const l of rowLines) {
      const id = l.slice(3, 7);
      const file = files.find((f) => f.startsWith(`${id}-`));
      const status = /\*\*Status\*\*:?\s*(.*)/.exec(readFileSync(path.join(dir, file), "utf8").slice(0, 2000))?.[1] ?? "";
      if (/^(partially )?superseded/i.test(status.trim())) expect(cells(l)[2].trim(), id).not.toBe("Accepted");
    }
  });
});

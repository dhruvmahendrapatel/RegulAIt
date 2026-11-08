// FS-55: the ADR index (internal/decisions/README.md) has one well-formed row per
// ADR file, in number order, and every relative link in it resolves.
//
// ADR-0252: a PR adds only its ADR file; the assign-at-merge step adds the row after the merge. So the checks run on
// the index as that step will leave it (`foldAdrIndex`), which also proves every new ADR's header yields a row.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldAdrIndex } from "./fold-docs.mjs";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../internal/decisions");
const files = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
const index = foldAdrIndex(
  readFileSync(path.join(dir, "README.md"), "utf8"),
  files.map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") })),
).text;
const rowLines = index.split("\n").filter((l) => /^\| *\[\d{4}\]/.test(l));
/** GFM splits a table row on every `|` not escaped as `\|`, code spans included */
const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1);

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

// #738 §1: every ADR cited from the repo's process files exists, and every relative Markdown link under them resolves.
// Tracked files only (`git ls-files`), so an untracked scratch file never fails a run.
describe("ADR references and relative links resolve (#738)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ".github", "scripts", "internal", "CLAUDE.md"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && existsSync(path.join(root, f)));
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const ids = new Set(files.map((f) => f.slice(0, 4)));
  // this file names the pattern it looks for; nothing else is exempt
  const self = "scripts/adr-index.test.mjs";

  // Unlike the link test below, this scan covers code spans and blocks too: a workflow comment or a script citing an
  // ADR in code is still a citation that must resolve.
  it("every ADR-NNNN cited in .github/, scripts/, internal/ or CLAUDE.md has a file in internal/decisions/", () => {
    expect(tracked.length).toBeGreaterThan(400); // non-vacuity: the real tree
    const missing = [];
    for (const f of tracked) {
      if (f === self || /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|tgz|gz|zip)$/i.test(f)) continue;
      for (const m of read(f).matchAll(/ADR-(\d{4})/g)) if (!ids.has(m[1])) missing.push(`${f}: ADR-${m[1]}`);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("every relative Markdown link in those trees resolves to a file or folder", () => {
    const md = tracked.filter((f) => f.endsWith(".md"));
    expect(md.length).toBeGreaterThan(300);
    const bad = [];
    for (const f of md) {
      // links inside code are examples, not links
      // (backtick and tilde fences, then inline code; indented code blocks are not stripped, because list
      // continuations look the same)
      const text = read(f)
        .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
        .replace(/`[^`\n]*`/g, "");
      // inline links `[x](target)` and reference definitions `[x]: target`
      const targets = [
        ...[...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
        ...[...text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)].map((m) => m[1]),
      ];
      for (const raw of targets) {
        const m = [null, raw];
        let target = m[1].split("#")[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
        try {
          target = decodeURIComponent(target);
        } catch {
          // a malformed escape is checked as written
        }
        target = target.replace(/:\d+(-\d+)?$/, ""); // file.ts:12 or :12-20 line suffix
        if (!existsSync(path.join(root, path.dirname(f), target))) bad.push(`${f} -> ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

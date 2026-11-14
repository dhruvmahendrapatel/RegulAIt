import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateMigration, readMigration, removeMigration } from "./migration-by-slug.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(entries: string[], files: Record<string, string>): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "mig-slug-"));
  dirs.push(d);
  mkdirSync(path.join(d, "meta"));
  mkdirSync(path.join(d, "pending"));
  const journal = { version: "7", dialect: "postgresql", entries: entries.map((tag, i) => ({ idx: i, version: "7", when: i, tag, breakpoints: true })) };
  writeFileSync(path.join(d, "meta", "_journal.json"), `${JSON.stringify(journal, null, 2)}\n`);
  for (const [f, text] of Object.entries(files)) writeFileSync(path.join(d, f), text);
  return d;
}
const tags = (d: string) => (JSON.parse(readFileSync(path.join(d, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries.map((e) => e.tag);

describe("migration-by-slug (ADR-0252: a migration is found before and after assign-at-merge numbers it)", () => {
  it("pending: reads and removes pending/<slug>.sql, journal untouched", () => {
    const d = folder(["0001_a"], { "0001_a.sql": "a", "pending/b_c.sql": "bc" });
    expect(locateMigration(d, "b_c").state).toBe("pending");
    expect(readMigration(d, "b_c")).toBe("bc");
    removeMigration(d, "b_c");
    expect(readdirSync(path.join(d, "pending"))).toEqual([]);
    expect(tags(d)).toEqual(["0001_a"]);
  });

  it("numbered: reads and removes NNNN_<slug>.sql and its journal entry only", () => {
    const d = folder(["0001_a", "0002_b_c", "0003_b_c_d"], { "0001_a.sql": "a", "0002_b_c.sql": "bc", "0003_b_c_d.sql": "bcd" });
    expect(locateMigration(d, "b_c")).toMatchObject({ state: "numbered", tag: "0002_b_c" });
    expect(readMigration(d, "b_c")).toBe("bc");
    removeMigration(d, "b_c");
    expect(existsSync(path.join(d, "0002_b_c.sql"))).toBe(false);
    expect(existsSync(path.join(d, "0003_b_c_d.sql"))).toBe(true);
    expect(tags(d)).toEqual(["0001_a", "0003_b_c_d"]);
    expect(readFileSync(path.join(d, "meta", "_journal.json"), "utf8").endsWith("}\n")).toBe(true);
  });

  it("refuses a missing slug, a numbered file with no journal entry, and a slug in both states", () => {
    expect(() => locateMigration(folder([], {}), "nope")).toThrow(/expected pending\/nope\.sql/);
    expect(() => locateMigration(folder([], { "0005_x.sql": "x" }), "x")).toThrow(/no journal entry/);
    expect(() => locateMigration(folder(["0005_x"], { "0005_x.sql": "x", "pending/x.sql": "x" }), "x")).toThrow(/both pending and numbered/);
  });
});

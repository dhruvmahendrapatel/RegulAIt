// ADR-0252: migrations, ADR rows and STATE/PENDING fragments are written at merge time.
// The headline case: two PRs that each add a migration merge in either order with no conflict, and the
// assign-at-merge step then writes a correct journal that the migration guard accepts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UnassignedMigrationsError,
  WHEN_STEP,
  assignPending,
  isJournalPrefix,
  resolveMigrationsFolder,
} from "../packages/db/src/pending-migrations.ts";
import { apply, plan } from "./assign-at-merge.mjs";
import { adrRow, foldAdrIndex, foldFragments } from "./fold-docs.mjs";
import { migrationTreeProblems, treeAtRef, treeOnDisk } from "./migration-watermark-guard.mjs";

const J = "packages/db/migrations/meta/_journal.json";
const BASE_WHEN = 1785209000000;
const journal = (...tags) => ({
  version: "7",
  dialect: "postgresql",
  entries: tags.map((tag, i) => ({ idx: Number(tag.slice(0, 4)), version: "7", when: BASE_WHEN - (tags.length - 1 - i) * WHEN_STEP, tag, breakpoints: true })),
});

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/** a throwaway repo shaped like this one: two merged migrations (0280 retired), an ADR index, STATE and PENDING */
function repo() {
  const root = mkdtempSync(path.join(tmpdir(), "assign-at-merge-"));
  temps.push(root);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const write = (p, text) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), text);
  };
  git("init", "-q", "-b", "main");
  write(J, `${JSON.stringify(journal("0279_a", "0281_b"), null, 2)}\n`);
  write("packages/db/migrations/0279_a.sql", "create table a (id int);\n");
  write("packages/db/migrations/0281_b.sql", "create table b (id int);\n");
  write("packages/db/migrations/pending/README.md", "pending\n");
  write("internal/decisions/README.md", "# ADRs\n\n| ID | Title | Status | Date |\n|---|---|---|---|\n| [0001](0001-a.md) | A | Accepted | 2026-07-21 |\n");
  write("internal/decisions/0001-a.md", "# ADR-0001: A\n\n- **Status**: Accepted\n- **Date**: 2026-07-21\n");
  write("internal/memory/STATE.md", "# State\n\n## Where we are\n<!-- fold:state-recap newest-first -->\n\nold recap\n\n## Decisions\nold decision\n\n<!-- fold:state-decisions -->\n\n## Open\n");
  write("internal/product/PENDING.md", "# Pending\n\n| # | Gap |\n|---|---|\n| 1 | old |\n<!-- fold:pending rows -->\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root, git, write, read: (p) => readFileSync(path.join(root, p), "utf8") };
}

/** a PR branch off main that adds one pending migration, an ADR and a recap fragment */
function pr(r, branch, slug, adr) {
  r.git("checkout", "-q", "-b", branch, "main");
  r.write(`packages/db/migrations/pending/${slug}.sql`, `create table ${slug} (id int);\n`);
  r.write(`internal/decisions/${adr}-${slug}.md`, `# ADR-${adr}: Add ${slug}\n\n- **Status**: Accepted (builder)\n- **Date**: 2026-11-07\n`);
  r.write(`internal/fragments/2026-11-07-${slug}.md`, `<!-- fold: state-recap -->\n**${slug}** merged.\n`);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", `add ${slug}`);
  r.git("checkout", "-q", "main");
}

/** merge a branch into main with a merge commit (M-067), as the queue does; throws on a conflict */
const merge = (r, branch) => r.git("merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch);

/** the bot's step: guard against the pre-step tree, write, commit */
function assign(r) {
  const before = r.git("rev-parse", "HEAD").trim();
  apply(r.root, plan(r.root));
  const problems = migrationTreeProblems(treeAtRef(before, r.root), treeOnDisk(r.root));
  r.git("add", "-A");
  r.git("commit", "-q", "--allow-empty", "-m", "assign at merge");
  return problems;
}

const tags = (r) => JSON.parse(r.read(J)).entries.map((e) => e.tag);
const whens = (r) => JSON.parse(r.read(J)).entries.map((e) => e.when);

describe("two PRs that each add a migration (ADR-0252)", () => {
  for (const order of [["alpha", "beta"], ["beta", "alpha"]]) {
    it(`merge in the order ${order.join(", ")} with no conflict, then one assignment writes a correct journal`, () => {
      const r = repo();
      pr(r, "alpha", "alpha", "0002");
      pr(r, "beta", "beta", "0003");
      for (const b of order) merge(r, b);
      expect(assign(r)).toEqual([]);
      // both pending files merged before the step ran, so they are numbered in name order whatever the merge order
      expect(tags(r)).toEqual(["0279_a", "0281_b", "0282_alpha", "0283_beta"]);
      expect(whens(r)).toEqual([BASE_WHEN - WHEN_STEP, BASE_WHEN, BASE_WHEN + WHEN_STEP, BASE_WHEN + 2 * WHEN_STEP]);
      expect(r.read("packages/db/migrations/0282_alpha.sql")).toBe("create table alpha (id int);\n");
      expect(readdirSync(path.join(r.root, "packages/db/migrations/pending"))).toEqual(["README.md"]);
      expect(JSON.parse(r.read(J)).entries.map((e) => e.idx)).toEqual([279, 281, 282, 283]);
    });

    it(`merge in the order ${order.join(", ")} with the step running after each merge: numbers follow merge order`, () => {
      const r = repo();
      pr(r, "alpha", "alpha", "0002");
      pr(r, "beta", "beta", "0003");
      merge(r, order[0]);
      expect(assign(r)).toEqual([]);
      merge(r, order[1]); // the second PR touched no line the step wrote: still no conflict
      expect(assign(r)).toEqual([]);
      expect(tags(r)).toEqual(["0279_a", "0281_b", `0282_${order[0]}`, `0283_${order[1]}`]);
      const w = whens(r);
      expect(w.every((x, i) => i === 0 || x > w[i - 1])).toBe(true);
    });
  }

  it("folds the two ADR rows in number order and both recap fragments, newest first, then deletes the fragments", () => {
    const r = repo();
    pr(r, "beta", "beta", "0003");
    pr(r, "alpha", "alpha", "0002");
    merge(r, "beta");
    merge(r, "alpha");
    assign(r);
    const rows = r.read("internal/decisions/README.md").split("\n").filter((l) => l.startsWith("| ["));
    expect(rows).toEqual([
      "| [0001](0001-a.md) | A | Accepted | 2026-07-21 |",
      "| [0002](0002-alpha.md) | Add alpha | Accepted | 2026-11-07 |",
      "| [0003](0003-beta.md) | Add beta | Accepted | 2026-11-07 |",
    ]);
    const state = r.read("internal/memory/STATE.md");
    expect(state).toContain("<!-- fold:state-recap newest-first -->\n\n**beta** merged.\n\n**alpha** merged.\n\nold recap");
    expect(existsSync(path.join(r.root, "internal/fragments"))).toBe(true);
    expect(readdirSync(path.join(r.root, "internal/fragments"))).toEqual([]);
  });

  it("is deterministic: a second run after the first changes nothing", () => {
    const r = repo();
    pr(r, "alpha", "alpha", "0002");
    merge(r, "alpha");
    assign(r);
    const p = plan(r.root);
    expect([p.migrations, p.adrRows, p.fragments]).toEqual([[], [], []]);
  });
});

describe("the migration guard against the base branch (C-03)", () => {
  const head = (r) => treeOnDisk(r.root);
  const base = (r) => treeAtRef("HEAD", r.root);

  it("accepts a PR that only adds a pending migration", () => {
    const r = repo();
    r.write("packages/db/migrations/pending/gamma.sql", "select 1;\n");
    expect(migrationTreeProblems(base(r), head(r))).toEqual([]);
  });

  it("refuses a hand-written journal entry with its numbered file (the old flow)", () => {
    const r = repo();
    const j = JSON.parse(r.read(J));
    j.entries.push({ idx: 282, version: "7", when: BASE_WHEN + WHEN_STEP, tag: "0282_gamma", breakpoints: true });
    r.write(J, JSON.stringify(j, null, 2));
    r.write("packages/db/migrations/0282_gamma.sql", "select 1;\n");
    expect(migrationTreeProblems(base(r), head(r)).join("\n")).toMatch(/only scripts\/assign-at-merge\.mjs appends to the journal/);
  });

  it("refuses an edit to a merged migration's SQL", () => {
    const r = repo();
    r.write("packages/db/migrations/0279_a.sql", "create table a (id bigint);\n");
    expect(migrationTreeProblems(base(r), head(r)).join("\n")).toMatch(/0279_a\.sql: a merged migration's SQL changed/);
  });

  it("refuses a removed or edited merged journal entry", () => {
    const r = repo();
    const j = JSON.parse(r.read(J));
    j.entries[1].breakpoints = false;
    r.write(J, JSON.stringify(j, null, 2));
    expect(migrationTreeProblems(base(r), head(r)).join("\n")).toMatch(/0281_b: a merged journal entry changed \(breakpoints true -> false\)/);
    j.entries.pop();
    r.write(J, JSON.stringify(j, null, 2));
    expect(migrationTreeProblems(base(r), head(r)).join("\n")).toMatch(/0281_b: a merged journal entry was removed/);
  });

  it("refuses a pending migration whose slug a numbered migration already has (#721 review 4)", () => {
    const r = repo();
    const taken = JSON.parse(r.read("packages/db/migrations/meta/_journal.json")).entries.at(-1).tag.replace(/^\d+_/, "");
    r.write(`packages/db/migrations/pending/${taken}.sql`, "select 1;\n");
    expect(migrationTreeProblems(base(r), head(r)).join("\n")).toMatch(new RegExp(`pending/${taken}\\.sql: the slug is already a numbered migration's`));
  });

  it("refuses a numbered file with no journal entry, and a pending file with a bad name", () => {
    const r = repo();
    r.write("packages/db/migrations/0290_stray.sql", "select 1;\n");
    r.write("packages/db/migrations/pending/0290-Bad.sql", "select 1;\n");
    const p = migrationTreeProblems(base(r), head(r)).join("\n");
    expect(p).toMatch(/0290_stray\.sql: a numbered migration with no journal entry/);
    expect(p).toMatch(/pending\/0290-Bad\.sql: a pending migration is named <slug>\.sql/);
  });

  it("refuses an assignment that edits the SQL on the way", () => {
    const r = repo();
    r.write("packages/db/migrations/pending/gamma.sql", "select 1;\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "merge gamma");
    apply(r.root, plan(r.root));
    r.write("packages/db/migrations/0282_gamma.sql", "select 2;\n");
    expect(migrationTreeProblems(base(r), head(r)).join("\n")).toMatch(/0282_gamma\.sql: its bytes differ from pending\/gamma\.sql/);
  });
});

describe("pending migrations in runMigrations (ADR-0252)", () => {
  it("numbers pending files after the highest number or idx, never reusing a retired one", () => {
    const { journal: j, assignments } = assignPending(journal("0279_a", "0281_b"), ["x.sql", "y.sql"]);
    expect(assignments.map((a) => [a.from, a.to, a.entry.idx, a.entry.when])).toEqual([
      ["pending/x.sql", "0282_x.sql", 282, BASE_WHEN + WHEN_STEP],
      ["pending/y.sql", "0283_y.sql", 283, BASE_WHEN + 2 * WHEN_STEP],
    ]);
    expect(j.entries).toHaveLength(4);
    expect(() => assignPending(journal("0001_a"), ["Bad-Name.sql"])).toThrow(/<slug>\.sql/);
  });

  it("refuses a pending slug that a numbered migration already has (#721 review 4)", () => {
    expect(() => assignPending(journal("0279_a", "0281_b"), ["b.sql"])).toThrow(/reuses the slug of a numbered one; pick a new slug: b\.sql/);
    expect(() => assignPending(journal("0279_a"), ["a_b.sql"])).not.toThrow();
  });

  it("refuses a folder with pending files by default, and stages a numbered copy only for a disposable database", () => {
    const r = repo();
    const folder = path.join(r.root, "packages/db/migrations");
    expect(resolveMigrationsFolder(folder, {}).folder).toBe(folder);
    r.write("packages/db/migrations/pending/gamma.sql", "select 1;\n");
    expect(() => resolveMigrationsFolder(folder, {})).toThrow(UnassignedMigrationsError);
    const staged = resolveMigrationsFolder(folder, { REGULAIT_MIGRATIONS_UNASSIGNED: "apply" });
    try {
      expect(staged.folder).not.toBe(folder);
      expect(JSON.parse(readFileSync(path.join(staged.folder, "meta/_journal.json"), "utf8")).entries.map((e) => e.tag)).toEqual(["0279_a", "0281_b", "0282_gamma"]);
      expect(readFileSync(path.join(staged.folder, "0282_gamma.sql"), "utf8")).toBe("select 1;\n");
      expect(readFileSync(path.join(staged.folder, "0279_a.sql"), "utf8")).toBe("create table a (id int);\n");
    } finally {
      staged.cleanup();
    }
    expect(existsSync(staged.folder)).toBe(false);
  });

  it("never applies pending files on top of a journal prefix (an upgrade test's truncated copy)", () => {
    const r = repo();
    const folder = path.join(r.root, "packages/db/migrations");
    r.write("packages/db/migrations/pending/gamma.sql", "select 1;\n");
    // what an upgrade test does: copy the folder and cut the journal back to an earlier migration
    const journalPath = path.join(folder, "meta/_journal.json");
    const full = JSON.parse(readFileSync(journalPath, "utf8"));
    writeFileSync(journalPath, JSON.stringify({ ...full, entries: full.entries.slice(0, 1) }, null, 2) + "\n");
    expect(isJournalPrefix(folder)).toBe(true);
    const env = { REGULAIT_MIGRATIONS_UNASSIGNED: "apply" };
    const staged = resolveMigrationsFolder(folder, env);
    // the prefix is migrated as it stands: no provisional numbers, so nothing collides with 0281_b
    expect(staged.folder).toBe(folder);
    expect(staged.provisional).toEqual([]);
    // still fail closed without the disposable-database switch
    expect(() => resolveMigrationsFolder(folder, {})).toThrow(UnassignedMigrationsError);
    // the full journal again: the pending file is applied after it
    writeFileSync(journalPath, JSON.stringify(full, null, 2) + "\n");
    expect(isJournalPrefix(folder)).toBe(false);
    const fullRun = resolveMigrationsFolder(folder, env);
    try {
      expect(fullRun.provisional.map((a) => a.to)).toEqual(["0282_gamma.sql"]);
    } finally {
      fullRun.cleanup();
    }
  });
});

describe("the doc folds", () => {
  it("builds an ADR row from the template header, escaping a pipe and dropping the status parenthetical", () => {
    expect(adrRow("0252-x.md", "# ADR-0252: A | B\n\n- **Status**: Accepted (owner, 2026-11-07)\n- **Date**: 2026-11-07\n")).toBe("| [0252](0252-x.md) | A \\| B | Accepted | 2026-11-07 |");
    expect(adrRow("0252-x.md", "# ADR-0252: Long\n\n- **Index**: Short\n- **Status**: Proposed\n- **Date**: 2026-11-07\n")).toContain("| Short | Proposed |");
    expect(() => adrRow("0252-x.md", "# ADR-0252: T\n")).toThrow(/lacks a `- \*\*Status\*\*:` line/);
  });

  it("refuses two ADR files with one number", () => {
    const f = (name) => ({ name, text: "# ADR-0002: x\n- **Status**: Accepted\n- **Date**: 2026-11-07\n" });
    expect(() => foldAdrIndex("| [0001](0001-a.md) | A | Accepted | 2026-07-21 |\n", [f("0002-a.md"), f("0002-b.md")])).toThrow(/share the number 0002/);
  });

  it("appends table rows with no blank line, and refuses a fragment with no known marker", () => {
    const t = new Map([["P.md", "| a |\n<!-- fold:pending rows -->\n"]]);
    const out = foldFragments(t, [{ name: "2.md", text: "<!-- fold: pending -->\n| c |\n" }, { name: "1.md", text: "<!-- fold: pending -->\n| b |\n" }]);
    expect(out.targets.get("P.md")).toBe("| a |\n| b |\n| c |\n<!-- fold:pending rows -->\n");
    expect(() => foldFragments(t, [{ name: "x.md", text: "<!-- fold: nope -->\nx\n" }])).toThrow(/no target has the fold marker nope/);
    expect(() => foldFragments(t, [{ name: "x.md", text: "x\n" }])).toThrow(/first line must be/);
  });

  it("the real STATE.md and PENDING.md carry each marker exactly once", () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const targets = new Map(["internal/memory/STATE.md", "internal/product/PENDING.md"].map((p) => [p, readFileSync(path.join(root, p), "utf8")]));
    const names = foldFragments(targets, []).targets;
    expect(names.size).toBe(2);
    const all = [...targets.values()].join("\n").match(/^<!-- fold:[a-z-]+/gm);
    expect(all.sort()).toEqual(["<!-- fold:pending", "<!-- fold:state-decisions", "<!-- fold:state-recap"]);
  });
});

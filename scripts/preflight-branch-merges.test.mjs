// #738 §1: a lane branch may merge main, never a sibling lane's branch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siblingMerges } from "./preflight-branch-merges.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "preflight-branch-merges.mjs");
let dir;
const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
const commit = (name) => {
  writeFileSync(path.join(dir, name), name);
  g("add", name);
  g("commit", "-q", "-m", name);
};
const run = (...a) => {
  try {
    return { code: 0, out: execFileSync("node", [script, ...a], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "branch-merges-"));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  commit("a");
  g("branch", "base");
  // lane: one commit, then main moves and is merged in (allowed)
  g("checkout", "-q", "-b", "lane");
  commit("l1");
  g("checkout", "-q", "main");
  commit("m1");
  g("checkout", "-q", "lane");
  g("merge", "-q", "--no-ff", "--no-edit", "main");
  // sibling: a different lane, merged into "bad" (forbidden)
  g("checkout", "-q", "-b", "sibling", "base");
  commit("s1");
  g("checkout", "-q", "-b", "bad", "lane");
  g("merge", "-q", "--no-ff", "--no-edit", "sibling");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("preflight-branch-merges", () => {
  it("a lane that merges main passes (non-vacuous: the range holds a merge)", () => {
    expect(g("rev-list", "--merges", "--count", "base..lane")).toBe("1");
    expect(siblingMerges({ base: "base", head: "lane", main: "main", cwd: dir })).toEqual([]);
    expect(run("base", "lane", "--main", "main").code).toBe(0);
  });

  it("a lane that merges a sibling branch fails and names the merge", () => {
    const found = siblingMerges({ base: "base", head: "bad", main: "main", cwd: dir });
    expect(found).toHaveLength(1);
    expect(found[0].parent).toBe(g("rev-parse", "sibling"));
    const r = run("base", "bad", "--main", "main");
    expect(r.code).toBe(1);
    expect(r.out).toContain(g("rev-parse", "bad"));
  });

  it("the stacked label allows it, and other labels do not", () => {
    expect(run("base", "bad", "--main", "main", "--labels", "surface:web,stacked").code).toBe(0);
    expect(run("base", "bad", "--main", "main", "--labels", "surface:web").code).toBe(1);
  });

  it("fails closed on an unknown ref or bad usage", () => {
    expect(run("base", "no-such-ref", "--main", "main").code).toBe(2);
    expect(run("base", "lane", "--main", "no-such-main").code).toBe(2);
    expect(run("base").code).toBe(2);
  });
});

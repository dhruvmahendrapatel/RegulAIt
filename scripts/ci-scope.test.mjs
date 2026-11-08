// ADR-0252 addendum: the PR scope fails closed. A rename out of code into docs is still a code change, and a diff
// that cannot be read means a full run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedFiles, scopeForEvent, scopeOf } from "./ci-scope.mjs";

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/** a repo whose HEAD is a merge commit of a PR branch into main, as GitHub's refs/pull/N/merge is */
function prMerge(change) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-scope-"));
  temps.push(root);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", env });
  const write = (p, t) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), t);
  };
  git("init", "-q", "-b", "main");
  write("apps/gateway/src/policy.ts", "export const allow = false;\n".repeat(20));
  write("docs/guide.md", "# guide\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "pr");
  change({ git, write });
  git("add", "-A");
  git("commit", "-q", "-m", "pr");
  git("checkout", "-q", "main");
  write("internal/other.md", "other\n"); // main moved on, so the merge is a real two-parent commit
  git("add", "-A");
  git("commit", "-q", "-m", "main moves");
  git("merge", "-q", "--no-ff", "-m", "merge pr", "pr");
  return { root, git };
}

describe("the PR scope (fails closed)", () => {
  it("a docs-only PR is not a code change", () => {
    const { root } = prMerge(({ write }) => write("docs/guide.md", "# guide v2\n"));
    expect(scopeForEvent("pull_request", root)).toMatchObject({ full: false, code: false, web: false });
  });

  it("a rename from apps/ to docs/ still runs the code gates (both paths count)", () => {
    const { root } = prMerge(({ git }) => git("mv", "apps/gateway/src/policy.ts", "docs/policy.md"));
    expect(changedFiles(root).sort()).toEqual(["apps/gateway/src/policy.ts", "docs/policy.md"]);
    expect(scopeForEvent("pull_request", root)).toMatchObject({ full: false, code: true });
  });

  it("a web change sets web", () => {
    const { root } = prMerge(({ write }) => write("apps/web/src/x.tsx", "export {};\n"));
    expect(scopeForEvent("pull_request", root)).toMatchObject({ full: false, code: true, web: true });
  });

  it("runs everything when HEAD is not a merge commit", () => {
    const { root, git } = prMerge(({ write }) => write("docs/guide.md", "v2\n"));
    git("checkout", "-q", "HEAD^1");
    expect(scopeForEvent("pull_request", root)).toMatchObject({ full: true, code: true, web: true });
  });

  it("runs everything when the base commit is missing (a depth-1 clone)", () => {
    const { root } = prMerge(({ write }) => write("docs/guide.md", "v2\n"));
    const shallow = mkdtempSync(path.join(tmpdir(), "ci-scope-shallow-"));
    temps.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${root}`, shallow]);
    expect(scopeForEvent("pull_request", shallow)).toMatchObject({ full: true, code: true });
  });

  it("runs everything outside a git repository, on an empty diff, and on any other event", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "ci-scope-none-"));
    temps.push(empty);
    expect(scopeForEvent("pull_request", empty)).toMatchObject({ full: true, code: true, web: true });
    expect(scopeOf([])).toMatchObject({ full: true });
    for (const e of ["merge_group", "push", "schedule", "workflow_dispatch", ""]) expect(scopeForEvent(e)).toMatchObject({ full: true, code: true, web: true });
  });
});

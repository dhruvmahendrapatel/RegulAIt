// ADR-0262: the PR scope fails closed. A rename out of code into docs is still a code change, and a diff
// that cannot be read means a full run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { FULL, OUTPUTS, changedFiles, scopeForEvent, scopeOf } from "./ci-scope.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => yaml.load(readFileSync(path.join(repo, ".github/workflows", name), "utf8"));

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
  write("apps/web/src/helper.ts", "export const h = 1;\n".repeat(20));
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

// ADR-0262, PR trim (owner decision 2026-11-07): one case per rule.
describe("the PR scope's trim rules", () => {
  it("a full run sets every output, so nothing is trimmed at merge time", () => {
    for (const k of OUTPUTS) expect(FULL[k], k).toBe(true);
    for (const e of ["merge_group", "push", "schedule", "workflow_dispatch"]) {
      const s = scopeForEvent(e);
      for (const k of OUTPUTS) expect(s[k], `${e} ${k}`).toBe(true);
    }
  });

  it("rule 1: a web change runs Chromium only (web, not full), so Firefox, WebKit and screenshots wait for merge time", () => {
    expect(scopeOf(["apps/web/src/pages/Home.tsx"])).toMatchObject({ full: false, web: true });
  });

  it("rule 2: CodeQL runs when any code changed and not on a docs-only PR", () => {
    expect(scopeOf(["apps/web/src/a.tsx"]).code).toBe(true);
    expect(scopeOf(["scripts/some-check.mjs"]).code).toBe(true);
    expect(scopeOf(["docs/a.md", "internal/b.md", "packages/db/README.md"]).code).toBe(false);
  });

  it("rule 3: the engine images run only on an engine input; the root image only on its build context", () => {
    for (const f of ["engines/garak/requirements.txt", "engines/promptfoo/Dockerfile", "Dockerfile", "packages/sandbox-executor/Dockerfile",
      "pnpm-lock.yaml", "packages/engine-runner/src/a.ts", "scripts/engine-images-normalise.mjs", "scripts/build-engine-image.sh",
      ".github/workflows/security.yml", ".github/workflows/engine-images-build.yml", ".github/workflows/engine-images.yml"]) {
      expect(scopeOf([f]).engines, f).toBe(true);
    }
    for (const f of ["apps/gateway/src/a.ts", "apps/web/src/a.tsx", "packages/shared/src/a.ts", "scripts/x.mjs", ".github/workflows/ci.yml"]) {
      expect(scopeOf([f]).engines, f).toBe(false);
    }
    for (const f of ["Dockerfile", ".dockerignore", "pnpm-lock.yaml", "package.json", "apps/gateway/src/a.ts", "apps/web/src/a.tsx",
      "packages/db/src/schema.ts", ".github/workflows/security.yml"]) {
      expect(scopeOf([f]).image, f).toBe(true);
    }
    // outside the root image's build context, or dropped by its .dockerignore
    for (const f of ["scripts/x.mjs", "engines/garak/requirements.txt", "apps/gateway/src/a.test.ts", "apps/web/e2e/a.spec.ts", "infra/x.tf",
      ".github/workflows/ci.yml"]) {
      expect(scopeOf([f]).image, f).toBe(false);
    }
  });

  it("rule 3: the Trivy gate's own inputs set `image`, so the required scan runs on the PR that changes how it judges", () => {
    for (const f of ["security/image-allowlist.json", "security/image-allowlist.engine-garak.json", "scripts/security-gate.mjs",
      "scripts/security-runtime-contents.mjs", "scripts/security-suppressions.mjs", "scripts/security-cosign-verify.sh"]) {
      expect(scopeOf([f]).image, f).toBe(true);
    }
    // the gate's tests and the other allow-lists are code (CodeQL runs) but not image inputs
    for (const f of ["scripts/security-gate.test.mjs", "security/sast-allowlist.json", "security/audit-allowlist.json"]) {
      expect(scopeOf([f]), f).toMatchObject({ code: true, image: false });
    }
  });

  it("rule 3: an engine's allow-list and the gate scripts its scan runs set `engines`; the root allow-list does not", () => {
    for (const f of ["security/image-allowlist.engine-garak.json", "security/image-allowlist.engine-new-one.json", "scripts/security-gate.mjs",
      "scripts/security-suppressions.mjs", "scripts/security-cosign-verify.sh"]) {
      expect(scopeOf([f]).engines, f).toBe(true);
    }
    for (const f of ["security/image-allowlist.json", "scripts/security-runtime-contents.mjs"]) {
      expect(scopeOf([f]).engines, f).toBe(false);
    }
  });

  it("rule 4: there is no web-only gateway skip, because gateway tests read apps/web sources", () => {
    expect(OUTPUTS).not.toContain("gateway");
    expect(scopeOf(["apps/web/src/views/admin/governance/auditObjectLinks.ts"])).toMatchObject({ full: false, code: true, web: true });
    // the reason: the step-up posture guard (a gateway test) walks every product source under apps/, apps/web included
    const guard = readFileSync(path.join(repo, "apps/gateway/src/step-up-posture-guard.test.ts"), "utf8");
    expect(guard).toContain('for (const top of ["apps", "packages"])');
  });

  it("rule 5: a change to the scope rules themselves is a full run", () => {
    for (const f of ["scripts/ci-scope.mjs", "scripts/ci-scope.test.mjs", ".github/actions/ci-scope/action.yml"]) {
      expect(scopeOf(["docs/a.md", f]), f).toMatchObject({ full: true, code: true, image: true, engines: true });
    }
  });

  it("rule 5: an unreadable or empty diff sets every output", () => {
    for (const s of [scopeOf(null), scopeOf([])]) for (const k of OUTPUTS) expect(s[k], k).toBe(true);
  });
});

// Rule 5 in the workflows: a required check is never "skipped = pass" on a PR that needed it.
describe("the workflows wire the scope fail-closed", () => {
  it("CodeQL and Trivy (required) run unless the scope said 'false', so a failed scope runs them", () => {
    const jobs = workflow("security.yml").jobs;
    expect(jobs.sast.needs).toBe("engines");
    expect(jobs.sast.if).toBe("${{ !cancelled() && needs.engines.outputs.code != 'false' }}");
    expect(jobs.image.needs).toBe("engines");
    expect(jobs.image.if).toBe("${{ !cancelled() && needs.engines.outputs.image != 'false' }}");
    // the other two required gates are never trimmed
    expect(jobs.secrets.if).toBeUndefined();
    expect(jobs.dependencies.if).toBeUndefined();
    const find = jobs.engines.steps.find((s) => s.id === "find");
    expect(find.run).toContain('elif [ "$ENGINES_CHANGED" = false ]; then');
  });

  it("build-and-test checks each part against `code`: the gateway shards run on every code PR, web-only included", () => {
    const jobs = workflow("ci.yml").jobs;
    expect(jobs["gateway-tests"].if).toBe("needs.scope.outputs.code == 'true'");
    expect(jobs["gateway-coverage"].if).toBe("${{ !cancelled() && needs.scope.outputs.code == 'true' }}");
    expect(jobs.scope.outputs).not.toHaveProperty("gateway");
    const rule = jobs["build-and-test"].steps.at(-1).run;
    expect(rule).toContain('.scope.result == "success"');
    expect(rule).toContain('(."build-and-test-base" | ok($o.code))');
    expect(rule).toContain('(."gateway-tests" | ok($o.code))');
    expect(rule).toContain('(."gateway-coverage" | ok($o.code))');
  });

  it("ui enterprise / all requires Chromium on a web PR and the screenshot pack only on a full run", () => {
    const jobs = workflow("ui-enterprise.yml").jobs;
    expect(jobs.browsers.strategy.matrix.browser).toContain("'[\"chromium\"]'");
    expect(jobs.screenshots.if).toBe("needs.scope.outputs.full == 'true'");
    const rule = jobs.all.steps.at(-1).run;
    expect(rule).toContain(".scope.result == \"success\"");
    expect(rule).toContain("(.browsers | ok($o.web))");
    expect(rule).toContain("(.screenshots | ok($o.full))");
  });

  it("the path-filtered PR workflows leave out web-only and Markdown-only PRs", () => {
    expect(workflow("import-cycles.yml").on.pull_request["paths-ignore"]).toContain("apps/web/**");
    const integ = workflow("integrations.yml").on.pull_request.paths;
    expect(integ).not.toContain("apps/web/**");
    expect(integ.at(-1)).toBe("!**/*.md");
    const engines = workflow("engine-images-build.yml").on.pull_request.paths;
    expect(engines).toEqual(expect.arrayContaining(["engines/**", "pnpm-lock.yaml", "**/Dockerfile"]));
  });
});

// ADR-0262: the PR scope fails closed. A rename out of code into docs is still a code change, and a diff
// that cannot be read means a full run.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { PR_WORKFLOWS, PR_WORKFLOWS_EXCLUDED, evaluate, planFor, ranJobs, runnerCount } from "./ci-plan.mjs";
import { ALL_RE, BASE_DOCS_RE, FULL, OUTPUTS, changedFiles, gatewayWebReaders, scopeForEvent, scopeOf } from "./ci-scope.mjs";

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
    for (const f of ["apps/gateway/src/a.ts", "apps/web/src/a.tsx", "packages/shared/src/a.ts", "scripts/x.mjs"]) {
      expect(scopeOf([f]).engines, f).toBe(false);
    }
    for (const f of ["Dockerfile", ".dockerignore", "pnpm-lock.yaml", "package.json", "apps/gateway/src/a.ts", "apps/web/src/a.tsx",
      "packages/db/src/schema.ts", ".github/workflows/security.yml"]) {
      expect(scopeOf([f]).image, f).toBe(true);
    }
    // outside the root image's build context, or dropped by its .dockerignore
    for (const f of ["scripts/x.mjs", "engines/garak/requirements.txt", "apps/gateway/src/a.test.ts", "apps/web/e2e/a.spec.ts", "infra/x.tf"]) {
      expect(scopeOf([f]).image, f).toBe(false);
    }
  });

  it("rule 3: the Trivy gate's own inputs set `image`, so the required scan runs on the PR that changes how it judges", () => {
    for (const f of ["security/image-allowlist.json", "security/image-allowlist.engine-garak.json", "scripts/security-gate.mjs",
      "scripts/security-runtime-contents.mjs", "scripts/security-suppressions.mjs", "scripts/security-cosign-verify.sh"]) {
      expect(scopeOf([f]).image, f).toBe(true);
    }
    // the gate's tests are code (CodeQL runs) but not image inputs; the other allow-lists are security configuration,
    // which is a full run (ADR-0323)
    expect(scopeOf(["scripts/security-gate.test.mjs"])).toMatchObject({ code: true, image: false });
    for (const f of ["security/sast-allowlist.json", "security/audit-allowlist.json"]) expect(scopeOf([f]), f).toMatchObject({ full: true, image: true });
  });

  it("rule 3: an engine's allow-list and the gate scripts its scan runs set `engines`; the root allow-list does not", () => {
    for (const f of ["security/image-allowlist.engine-garak.json", "security/image-allowlist.engine-new-one.json", "scripts/security-gate.mjs",
      "scripts/security-suppressions.mjs", "scripts/security-cosign-verify.sh"]) {
      expect(scopeOf([f]).engines, f).toBe(true);
    }
    expect(scopeOf(["scripts/security-runtime-contents.mjs"]).engines).toBe(false);
  });

  it("rule 4 (ADR-0323): a web-only PR is not a gateway change; anything outside apps/web is", () => {
    expect(scopeOf(["apps/web/src/views/admin/governance/auditObjectLinks.ts", "apps/web/e2e/a.spec.ts"])).toMatchObject({
      full: false, code: true, web: true, gateway: false,
    });
    for (const f of ["apps/gateway/src/a.ts", "packages/shared/src/a.ts", "packages/policy-kernel/src/a.ts", "scripts/x.mjs", "infra/x.tf",
      "docker-compose.yml"]) {
      expect(scopeOf(["apps/web/src/a.tsx", f]).gateway, f).toBe(true);
    }
    expect(scopeOf(["docs/a.md"]).gateway).toBe(false);
  });

  it("rule 4 (ADR-0323): the gateway tests that read apps/web are found from their sources, so a web-only PR still runs them", () => {
    const readers = gatewayWebReaders(repo);
    // the tests #737's review named, and the contract tests that read SPA files
    for (const f of ["src/step-up-posture-guard.test.ts", "src/zz-audit-object-type-0210.test.ts", "src/adr0121-outlook-chatops.test.ts",
      "src/builder-agents.test.ts", "src/demo-check-g9.test.ts"]) {
      expect(readers, f).toContain(f);
    }
    // a pure gateway unit test is not one of them, and the subset is a small part of the suite
    expect(readers).not.toContain("src/route-classes.test.ts");
    expect(readers.length).toBeLessThan(150);
    // the CI step passes them word-split: no path may contain whitespace
    for (const f of readers) expect(f).toMatch(/^src\/\S+\.test\.ts$/);
  });

  it("rule 4 (ADR-0323): any gateway test that names apps/web is a reader, whatever else it does", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-scope-readers-"));
    temps.push(root);
    const write = (p, t) => {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), t);
    };
    write("apps/gateway/src/a.test.ts", 'import x from "../../web/src/x.js";\n');
    write("apps/gateway/src/sub/b.test.ts", 'const ROOT = path.resolve(here, "../../../.."); readdirSync(ROOT);\n');
    write("apps/gateway/src/c.test.ts", 'const t = readFileSync(path.join(ROOT, "apps", "web", "x.ts"));\n');
    write("apps/gateway/src/d.test.ts", 'import { a } from "./a.js"; expect(a).toBe(1);\n');
    write("apps/gateway/src/e.ts", 'readFileSync("../../web/x");\n'); // not a test file
    expect(gatewayWebReaders(root)).toEqual(["src/a.test.ts", "src/c.test.ts", "src/sub/b.test.ts"]);
  });

  it("rule 6 (ADR-0323): dependencies, CI, the schema and migrations, and security configuration are a full run", () => {
    for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "apps/web/package.json", "packages/db/package.json", ".npmrc",
      ".node-version", "tsconfig.base.json", ".github/workflows/ci.yml", ".github/workflows/dependabot-auto-merge.yml",
      ".github/actions/other/action.yml", ".github/CODEOWNERS", ".github/dependabot.yml", "packages/db/src/schema.ts",
      "packages/db/migrations/pending/x.sql", "packages/db/migrations/meta/_journal.json", "packages/db/drizzle.config.ts",
      "security/sast-allowlist.json", ".gitleaks.toml"]) {
      expect(ALL_RE.test(f), f).toBe(true);
      expect(scopeOf(["docs/a.md", f]), f).toMatchObject({ ...FULL, reason: expect.stringContaining(f) });
    }
    for (const f of ["packages/db/src/rls.ts", "apps/web/src/package.ts", "scripts/x.mjs", "packages/db/README.md"]) {
      expect(scopeOf([f]).full, f).toBe(false);
    }
  });

  it("rule 7 (ADR-0323): docs that build-and-test-base's checks read run it; other docs run nothing", () => {
    for (const f of ["internal/decisions/0323-x.md", "internal/decisions/README.md", "internal/fragments/2026-11-16-x-state.md",
      "internal/product/PENDING.md", "apps/gateway/THIRD_PARTY.md", "scripts/THIRD_PARTY.md", "THIRD_PARTY.md"]) {
      expect(BASE_DOCS_RE.test(f), f).toBe(true);
      expect(scopeOf([f]), f).toMatchObject({ full: false, code: false, base: true, gateway: false });
    }
    for (const f of ["docs/guide.md", "internal/memory/STATE.md", "internal/research/x.md", "README.md"]) {
      expect(scopeOf([f]), f).toMatchObject({ code: false, base: false });
    }
    // every code change runs it too
    expect(scopeOf(["apps/web/src/a.tsx"]).base).toBe(true);
  });

  it("rule 8 (ADR-0262 addendum, #1227): the real-gateway journeys run on a PR that changes the web app, its e2e specs, the shared packages or the gateway's sources", () => {
    for (const f of ["apps/web/src/views/admin/governance/ChatOpsPage.tsx", "apps/web/e2e/phase1.spec.ts", "apps/web/e2e/global-setup.ts",
      "packages/shared/src/a.ts", "packages/ui/src/Button.tsx", "apps/gateway/src/route-classes.ts", "apps/gateway/src/routes/admin.ts"]) {
      expect(scopeOf([f]), f).toMatchObject({ full: false, journeys: true });
    }
    // documentation, unit tests (not built into the gateway or the SPA), other packages and scripts wait for main
    for (const f of ["docs/guide.md", "internal/memory/STATE.md", "apps/web/README.md", "apps/gateway/src/a.test.ts", "apps/web/src/a.test.tsx",
      "packages/policy-kernel/src/a.ts", "scripts/x.mjs", "infra/x.tf", "engines/garak/requirements.txt"]) {
      expect(scopeOf([f]).journeys, f).toBe(false);
    }
  });

  it("rule 5: a change to the scope rules themselves is a full run", () => {
    for (const f of ["scripts/ci-scope.mjs", "scripts/ci-scope.test.mjs", "scripts/ci-plan.mjs", ".github/actions/ci-scope/action.yml"]) {
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

  it("build-and-test checks each part: the gateway job on every code PR, its coverage check when `gateway` is set", () => {
    const jobs = workflow("ci.yml").jobs;
    expect(jobs["gateway-tests"].if).toBe("needs.scope.outputs.code == 'true'");
    // the one-runner web-only form only on an exact 'false'; an empty or failed output gives the six shards
    expect(jobs["gateway-tests"].strategy.matrix.shard).toBe(
      "${{ fromJSON(needs.scope.outputs.gateway == 'false' && '[\"web-readers\"]' || '[1, 2, 3, 4, 5, 6]') }}",
    );
    const steps = jobs["gateway-tests"].steps;
    expect(steps.find((s) => s.name?.startsWith("Gateway suite, shard")).if).toBe("matrix.shard != 'web-readers'");
    const readers = steps.find((s) => s.name?.startsWith("Gateway tests that read apps/web"));
    expect(readers.if).toBe("matrix.shard == 'web-readers'");
    expect(readers.run).toContain("node scripts/ci-scope.mjs --gateway-web-readers");
    expect(readers.run).toContain('[ -n "$files" ] ||');
    expect(jobs["gateway-coverage"].if).toBe("${{ !cancelled() && needs.scope.outputs.gateway == 'true' }}");
    expect(jobs.scope.outputs.gateway).toBe("${{ steps.scope.outputs.gateway }}");
    const rule = jobs["build-and-test"].steps.at(-1).run;
    expect(rule).toContain('.scope.result == "success"');
    expect(rule).toContain('(."build-and-test-base" | ok($o.base))');
    expect(rule).toContain('(."gateway-tests" | ok($o.code))');
    expect(rule).toContain('(."gateway-coverage" | ok($o.gateway))');
    expect(jobs["build-and-test-base"].if).toBe("needs.scope.outputs.base == 'true'");
  });

  it("the scope action declares every output the script writes, and every workflow reads only declared ones (#851)", () => {
    // GitHub drops a composite action's output that is not declared: `needs.scope.outputs.<k>` then reads as ''
    const action = yaml.load(readFileSync(path.join(repo, ".github/actions/ci-scope/action.yml"), "utf8"));
    for (const k of OUTPUTS) expect(action.outputs?.[k]?.value, `action output ${k}`).toBe(`\${{ steps.scope.outputs.${k} }}`);
    const declared = Object.keys(action.outputs);
    for (const [file, id] of [["ci.yml", "scope"], ["ui-enterprise.yml", "scope"], ["security.yml", "engines"]]) {
      for (const [k, v] of Object.entries(workflow(file).jobs[id].outputs)) {
        const m = /^\$\{\{ steps\.scope\.outputs\.([a-z]+) \}\}$/.exec(v);
        if (m) expect(declared, `${file} ${id}.outputs.${k}`).toContain(m[1]);
      }
    }
  });

  it("the aggregates refuse a scope output that is neither 'true' nor 'false', so an empty one never allows a skip", () => {
    const parts = (gateway, coverage) => JSON.stringify({
      scope: { result: "success", outputs: { code: "true", base: "true", gateway } },
      "build-and-test-base": { result: "success" }, "gateway-tests": { result: "success" }, "gateway-coverage": { result: coverage },
    });
    const rule = workflow("ci.yml").jobs["build-and-test"].steps.at(-1).run;
    const filter = /jq -e '([\s\S]*?)' > \/dev\/null/.exec(rule)[1];
    const passes = (input) => {
      try {
        execFileSync("jq", ["-e", filter], { input, stdio: ["pipe", "ignore", "ignore"] });
        return true;
      } catch {
        return false;
      }
    };
    expect(passes(parts("true", "success"))).toBe(true);
    expect(passes(parts("false", "skipped"))).toBe(true);
    expect(passes(parts("true", "skipped")), "a full run must run the coverage check").toBe(false);
    expect(passes(parts("", "skipped")), "an undeclared (empty) output must fail, not allow the skip").toBe(false);
    expect(passes(parts("maybe", "skipped"))).toBe(false);
    const ui = workflow("ui-enterprise.yml").jobs.all.steps.at(-1).run;
    expect(ui).toContain('def ok(want): if want == "true" then .result == "success" elif want == "false" then .result == "skipped" else false end;');
  });

  it("the dry run covers every workflow a pull_request can start (a new one fails here until it is listed)", () => {
    const prTriggered = readdirSync(path.join(repo, ".github/workflows"))
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) => {
        const on = workflow(f).on;
        return on && typeof on === "object" && "pull_request" in on;
      })
      .sort();
    expect([...PR_WORKFLOWS, ...PR_WORKFLOWS_EXCLUDED].sort()).toEqual(prTriggered);
  });

  it("every workflow a PR starts cancels a superseded PR run, and only a PR run", () => {
    const PR_ONLY = "${{ github.event_name == 'pull_request' }}";
    for (const f of PR_WORKFLOWS) {
      const c = workflow(f).concurrency;
      expect(c["cancel-in-progress"], f).toBe(PR_ONLY);
      expect(c.group, f).toContain("github.run_id");
    }
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

// ADR-0323: a dry run over the real workflow files shows which jobs a PR starts for a given change.
describe("the dry run (scripts/ci-plan.mjs) selects the expected jobs", () => {
  const REQUIRED = ["ci:build-and-test", "ui-enterprise:all", "security:secrets", "security:dependencies"];

  it("a docs-only PR: only the scope jobs, the aggregates and the untrimmed security gates", () => {
    const plan = planFor(["docs/guide.md", "internal/memory/STATE.md", "packages/db/README.md"]);
    expect(ranJobs(plan).sort()).toEqual(
      ["ci:scope", "ci:build-and-test", "ui-enterprise:scope", "ui-enterprise:all", "security:secrets", "security:dependencies",
        "security:engines"].sort(),
    );
    expect(runnerCount(plan)).toBe(7);
  });

  it("a UI-only PR: the web suites and the bundle/tokens guard, one gateway runner, no DB shards, no coverage, no import cycles", () => {
    const plan = planFor(["apps/web/src/views/admin/governance/ChatOpsPage.tsx"]);
    const ran = ranJobs(plan);
    expect(ran).toEqual(expect.arrayContaining([...REQUIRED, "ci:build-and-test-base", "ci:gateway-tests", "ci:spa-mock",
      "ui-enterprise:static", "ui-enterprise:browsers", "security:sast", "security:image"]));
    expect(ran).toContain("ci:spa-journeys"); // #1227: a web change runs the real-gateway journeys on the PR
    for (const j of ["ci:gateway-coverage", "ci:docker-build", "ui-enterprise:screenshots", "security:engine-image",
      "import-cycles:gateway-import-cycles", "integrations:kong-adapter", "client-compat:client-compat"]) {
      expect(ran, j).not.toContain(j);
    }
    const ci = plan.workflows.find((w) => w.file === "ci.yml").jobs;
    expect(ci["gateway-tests"].runners).toBe(1);
    expect(plan.workflows.find((w) => w.file === "ui-enterprise.yml").jobs.browsers.runners).toBe(1);
  });

  it("the bundle-size and tokens guard (ui enterprise static) runs on any PR that touches apps/web or packages/ui", () => {
    for (const f of ["apps/web/src/a.tsx", "apps/web/src/styles/tokens.css", "packages/ui/src/Button.tsx"]) {
      expect(ranJobs(planFor([f])), f).toContain("ui-enterprise:static");
    }
  });

  it("a gateway-only PR: the six DB shards and their coverage check, no web suites", () => {
    const plan = planFor(["apps/gateway/src/route-classes.ts"]);
    const ran = ranJobs(plan);
    expect(ran).toEqual(expect.arrayContaining([...REQUIRED, "ci:gateway-tests", "ci:gateway-coverage", "import-cycles:gateway-import-cycles"]));
    expect(ran).not.toContain("ci:spa-mock");
    expect(ran).not.toContain("ui-enterprise:browsers");
    expect(ran, "the journeys boot the real gateway").toContain("ci:spa-journeys");
    expect(plan.workflows.find((w) => w.file === "ci.yml").jobs["gateway-tests"].runners).toBe(6);
  });

  it("the real-gateway journeys (#1227): on an e2e-spec PR, not on a docs-only or a gateway-unit-test-only PR", () => {
    expect(ranJobs(planFor(["apps/web/e2e/phase2.spec.ts"]))).toContain("ci:spa-journeys");
    expect(ranJobs(planFor(["docs/guide.md"]))).not.toContain("ci:spa-journeys");
    expect(ranJobs(planFor(["apps/gateway/src/a.test.ts"]))).not.toContain("ci:spa-journeys");
    expect(workflow("ci.yml").jobs["spa-journeys"].if).toBe("needs.scope.outputs.full == 'true' || needs.scope.outputs.journeys == 'true'");
  });

  it("a lockfile PR runs everything a PR can start: the full suite", () => {
    const plan = planFor(["pnpm-lock.yaml"]);
    expect(plan.scope.full).toBe(true);
    const ran = ranJobs(plan);
    for (const j of [...REQUIRED, "ci:gateway-coverage", "ci:spa-journeys", "ci:docker-build", "ci:spa-mock", "ui-enterprise:screenshots",
      "security:sast", "security:image", "security:engine-image", "import-cycles:gateway-import-cycles", "engine-images-build:compare"]) {
      expect(ran, j).toContain(j);
    }
    expect(plan.workflows.find((w) => w.file === "ui-enterprise.yml").jobs.browsers.runners).toBe(3);
    // every ci, ui-enterprise and security job that is not push-only runs
    for (const w of plan.workflows.filter((x) => ["ci.yml", "ui-enterprise.yml", "security.yml"].includes(x.file))) {
      for (const [id, j] of Object.entries(w.jobs)) if (!["sign", "engine-sign"].includes(id)) expect(j.ran, `${w.file} ${id}`).toBe(true);
    }
  });

  it("the required aggregates and the untrimmed security gates run on every PR shape", () => {
    for (const files of [["docs/a.md"], ["apps/web/src/a.tsx"], ["apps/gateway/src/a.ts"], ["pnpm-lock.yaml"], ["engines/garak/Dockerfile"]]) {
      expect(ranJobs(planFor(files)), files[0]).toEqual(expect.arrayContaining(REQUIRED));
    }
  });
});

// ADR-0323 (#851 review): the dry run evaluates expressions with GitHub's own library, not a hand-written parser.
describe("the dry run's expressions are GitHub's (@actions/expressions)", () => {
  const ctx = { needs: { scope: { result: "success", outputs: { gateway: "false", code: "true" } } }, github: { event_name: "pull_request" } };
  it("evaluates the workflows' constructs with GitHub's rules", () => {
    expect(evaluate("${{ fromJSON(needs.scope.outputs.gateway == 'false' && '[\"web-readers\"]' || '[1, 2, 3, 4, 5, 6]') }}", ctx).value)
      .toEqual(["web-readers"]);
    expect(evaluate("!cancelled() && needs.scope.outputs.code != 'false'", ctx, { cancelled: false }).truthy).toBe(true);
    // a missing output is null on GitHub: != 'false' is true (so the fail-closed gates run), == 'true' is false
    expect(evaluate("needs.scope.outputs.missing != 'false'", ctx).truthy).toBe(true);
    expect(evaluate("needs.scope.outputs.missing == 'true'", ctx).truthy).toBe(false);
    // GitHub's loose equality: case-insensitive strings
    expect(evaluate("github.event_name == 'PULL_REQUEST'", ctx).truthy).toBe(true);
  });

  it("fails on a context the dry run does not model, rather than guessing", () => {
    expect(() => evaluate("secrets.TOKEN != ''", ctx)).toThrow();
  });
});

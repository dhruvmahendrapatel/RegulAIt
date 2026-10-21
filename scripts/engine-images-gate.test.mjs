// ENG-IMG publish gate (owner decision on #453, 2026-10-21; ADR-0187 addendum 2026-10-21).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedInputs, CONTEXT_EXCLUDED, GateError, GENERATED_LOCK_MODULE, inputCommit, inputPathspecs, plan, readWorkspace, ROOT, ROOT_INPUTS, workspaceClosure } from "./engine-images-gate.mjs";
import { ENGINE_IDS } from "./engine-images-lock.mjs";

const repoGit = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

describe("ENG-IMG publish gate: the input set of the real repository", () => {
  const pkgs = readWorkspace();

  it("each engine's closure is its package, the runner and shared (the shim stage builds exactly these)", () => {
    for (const id of ENGINE_IDS) expect(workspaceClosure(id, pkgs)).toEqual([`packages/engine-${id}`, "packages/engine-runner", "packages/shared"]);
  });

  it("an engine's inputs never include another engine's directory, the lock, the signatures or the generated module", () => {
    for (const id of ENGINE_IDS) {
      const files = repoGit(["ls-files", "--", ...inputPathspecs(id, pkgs)]).split("\n").filter(Boolean);
      expect(files).toContain(`engines/${id}/Dockerfile`);
      for (const other of ENGINE_IDS.filter((o) => o !== id)) expect(files.filter((f) => f.startsWith(`engines/${other}/`))).toEqual([]);
      expect(files.filter((f) => f === "engines/images.lock.json" || f.startsWith("engines/signatures/") || f === GENERATED_LOCK_MODULE)).toEqual([]);
      expect(files.filter((f) => /\.(test|spec)\.ts$/.test(f))).toEqual([]);
      expect(files).not.toContain(".github/workflows/engine-images.yml");
    }
  });

  it("every COPY source of every engine Dockerfile is an input (the build reads nothing the gate ignores)", () => {
    for (const id of ENGINE_IDS) {
      const covered = new Set(repoGit(["ls-files", "--", ...inputPathspecs(id, pkgs)]).split("\n").filter(Boolean));
      const dockerfile = readFileSync(path.join(ROOT, `engines/${id}/Dockerfile`), "utf8");
      const sources = [];
      for (const line of dockerfile.split("\n")) {
        const m = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
        if (m) sources.push(...m[1].split(/\s+/).slice(0, -1));
      }
      expect(sources.length).toBeGreaterThan(3);
      for (const src of sources) {
        if (src === "packages" || src === "apps") {
          // the whole tree is copied: the closure is an input whole, every other package by its package.json
          const closure = workspaceClosure(id, pkgs);
          for (const f of repoGit(["ls-files", "--", src]).split("\n").filter(Boolean)) {
            const excluded = f === GENERATED_LOCK_MODULE || /\.(test|spec)\.ts$/.test(f);
            const needed = f.endsWith("/package.json") || closure.some((d) => f.startsWith(`${d}/`));
            if (needed && !excluded) expect(covered.has(f), `${id}: ${f}`).toBe(true);
          }
        } else {
          const files = repoGit(["ls-files", "--", src]).split("\n").filter(Boolean);
          expect(files.length, `${id}: COPY ${src} names no tracked file`).toBeGreaterThan(0);
          for (const f of files) expect(covered.has(f), `${id}: COPY ${f}`).toBe(true);
        }
      }
    }
  });

  it("the excluded test files really are outside every build context (.dockerignore)", () => {
    const ignore = readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
    for (const g of CONTEXT_EXCLUDED) expect(ignore).toContain(g);
  });

  it("the build's own scripts are inputs", () => {
    for (const f of ["scripts/build-engine-image.sh", "scripts/engine-images-gate.mjs", "scripts/engine-images-normalise.mjs"]) expect(ROOT_INPUTS).toContain(f);
  });
});

describe("ENG-IMG publish gate: the decision, on a throwaway repository", () => {
  let dir;
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (f, body = `${f} ${Math.random()}\n`) => {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  };
  let time = 1_700_000_000;
  const commit = (msg) => {
    time += 60;
    git(["add", "-A"]);
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: `@${time}`, GIT_COMMITTER_DATE: `@${time}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
    return git(["rev-parse", "HEAD"]).trim();
  };
  const pkg = (dirName, name, deps = {}) => write(`${dirName}/package.json`, `${JSON.stringify({ name, dependencies: deps })}\n`);
  const lockAt = (c) => ({ engines: Object.fromEntries(ENGINE_IDS.map((id) => [id, { sourceCommit: c }])) });
  const decide = (c, opts = {}) => {
    const pkgs = readWorkspace(dir);
    return plan(lockAt(c), { changed: (id, from) => changedInputs(from, "HEAD", inputPathspecs(id, pkgs), { git }), ...opts });
  };
  let base;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "engine-gate-"));
    git(["init", "-q"]);
    for (const f of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".dockerignore", "scripts/build-engine-image.sh", "scripts/other.mjs", ".github/workflows/engine-images.yml", "engines/images.lock.json", "engines/signatures/garak.sigstore.json"]) write(f);
    for (const id of ENGINE_IDS) {
      write(`engines/${id}/Dockerfile`);
      pkg(`packages/engine-${id}`, `@regulait/engine-${id}`, { "@regulait/engine-runner": "workspace:*", "@regulait/shared": "workspace:*" });
      write(`packages/engine-${id}/src/main.ts`);
    }
    pkg("packages/engine-runner", "@regulait/engine-runner", { "@regulait/shared": "workspace:*" });
    pkg("packages/shared", "@regulait/shared");
    write("packages/shared/src/index.ts");
    write(GENERATED_LOCK_MODULE);
    pkg("packages/db", "@regulait/db", { "@regulait/shared": "workspace:*" });
    write("packages/db/src/db.ts");
    pkg("apps/web", "@regulait/web");
    write("apps/web/src/app.ts");
    base = commit("base");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("nothing changed: no engine publishes", () => {
    expect(decide(base).publish).toEqual([]);
  });

  it("#480's case and the lock PR's own files: the workflow, the lock, the signatures, the generated module, tests and unrelated code publish nothing", () => {
    for (const f of [".github/workflows/engine-images.yml", "engines/images.lock.json", "engines/signatures/garak.sigstore.json", GENERATED_LOCK_MODULE, "packages/shared/src/index.test.ts", "packages/engine-garak/src/main.spec.ts", "packages/db/src/db.ts", "apps/web/src/app.ts", "scripts/other.mjs", "docs/x.md"]) write(f);
    commit("no image input");
    const r = decide(base);
    expect(r.publish).toEqual([]);
    for (const id of ENGINE_IDS) expect(r.engines[id].reason).toMatch(/^inputs unchanged since /);
  });

  it("an engine's own directory publishes that engine only", () => {
    write("engines/garak/requirements.txt");
    commit("garak");
    const r = decide(base);
    expect(r.publish).toEqual(["garak"]);
    expect(r.engines.garak.files).toEqual(["engines/garak/requirements.txt"]);
  });

  it("an engine's workspace package publishes that engine only", () => {
    write("packages/engine-modelscan/src/main.ts");
    commit("modelscan shim");
    expect(decide(base).publish).toEqual(["modelscan"]);
  });

  it("shared code, the runner, a file directly in engines/, a root input or the build's own scripts publish every engine", () => {
    for (const f of ["packages/shared/src/index.ts", "packages/engine-runner/src/loop.ts", "engines/README.txt", "pnpm-lock.yaml", "tsconfig.base.json", ".dockerignore", "scripts/build-engine-image.sh", "scripts/engine-images-normalise.mjs"]) {
      const before = git(["rev-parse", "HEAD"]).trim();
      write(f);
      commit(f);
      expect(decide(before).publish, f).toEqual(ENGINE_IDS);
    }
  });

  it("any workspace package.json publishes every engine (pnpm install reads them all)", () => {
    write("apps/web/package.json", `${JSON.stringify({ name: "@regulait/web", scripts: { postinstall: "x" } })}\n`);
    commit("web package.json");
    expect(decide(base).publish).toEqual(ENGINE_IDS);
  });

  it("a new workspace dependency joins the closure", () => {
    pkg("packages/engine-promptfoo", "@regulait/engine-promptfoo", { "@regulait/engine-runner": "workspace:*", "@regulait/shared": "workspace:*", "@regulait/db": "workspace:*" });
    commit("promptfoo depends on db");
    const after = git(["rev-parse", "HEAD"]).trim();
    write("packages/db/src/db.ts");
    commit("db");
    expect(decide(after).publish).toEqual(["promptfoo"]);
  });

  it("force publishes every engine; a never-published engine publishes", () => {
    expect(decide(base, { force: true }).publish).toEqual(ENGINE_IDS);
    const r = plan({ engines: { promptfoo: { sourceCommit: null }, modelscan: { sourceCommit: base }, garak: { sourceCommit: base } } }, { changed: () => [] });
    expect(r.publish).toEqual(["promptfoo"]);
    expect(r.engines.promptfoo.reason).toBe("never published");
  });

  it("a sourceCommit missing from the history (a shallow clone) or malformed fails closed", () => {
    const pkgs = readWorkspace(dir);
    expect(() => changedInputs("a".repeat(40), "HEAD", inputPathspecs("garak", pkgs), { git })).toThrow(GateError);
    expect(() => plan(lockAt("not-a-sha"), { changed: () => [] })).toThrow(GateError);
  });

  it("the input commit is the last commit that touched the inputs, with its committer time; later unrelated commits do not move it", () => {
    const specs = inputPathspecs("garak", readWorkspace(dir));
    write("engines/garak/x");
    const touched = commit("garak input");
    const touchedTime = time;
    write("apps/web/src/app.ts");
    commit("unrelated");
    write("engines/images.lock.json");
    commit("lock");
    expect(inputCommit(specs, { git })).toEqual({ commit: touched, epoch: String(touchedTime) });
    // another engine's input does not move garak's
    write("engines/promptfoo/y");
    commit("promptfoo input");
    expect(inputCommit(specs, { git }).commit).toBe(touched);
    expect(inputCommit(inputPathspecs("promptfoo", readWorkspace(dir)), { git }).commit).not.toBe(touched);
  });

  it("the input commit through a merge: the inputs at the input commit equal HEAD's", () => {
    const specs = inputPathspecs("garak", readWorkspace(dir));
    git(["checkout", "-q", "-b", "feature"]);
    write("engines/garak/feature");
    const feature = commit("feature input");
    git(["checkout", "-q", "-"]);
    write("apps/web/src/app.ts");
    commit("main, unrelated");
    execFileSync("git", ["merge", "-q", "--no-ff", "-m", "merge", "feature"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: `@${(time += 60)}`, GIT_COMMITTER_DATE: `@${time}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
    const got = inputCommit(specs, { git });
    expect(got.commit).toBe(feature);
    expect(changedInputs(got.commit, "HEAD", specs, { git })).toEqual([]);
  });
});

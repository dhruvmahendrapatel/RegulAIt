import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSuppressions } from "./security-suppressions.mjs";
import { BUILD_TOOL, findBuildTools } from "./security-runtime-contents.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function run(script, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [path.join(here, script), ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

function repoWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "suppressions-"));
  execFileSync("git", ["init", "-q", dir]);
  for (const [f, body] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", path.dirname(path.join(dir, f))]);
    writeFileSync(path.join(dir, f), body);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

describe("security-suppressions (review B1-01)", () => {
  it("the repository has no scanner side door", () => {
    const r = run("security-suppressions.mjs", [root]);
    expect(r.code, r.out).toBe(0);
  });

  it("RED: each side door fails the check (exit 1)", () => {
    for (const [name, files] of [
      [".gitleaksignore", { "README.md": "x", ".gitleaksignore": "abc:file:rule:1\n" }],
      [".trivyignore", { "README.md": "x", ".trivyignore": "CVE-2026-0001\n" }],
      ["nested trivy.yaml", { "apps/x/trivy.yaml": "vulnerability:\n  ignore-unfixed: true\n" }],
      ["pnpm.auditConfig", { "package.json": JSON.stringify({ pnpm: { auditConfig: { ignoreGhsas: ["GHSA-x"] } } }) }],
      ["workspace auditConfig", { "pnpm-workspace.yaml": "packages:\n  - apps/*\nauditConfig:\n  ignoreCves: [CVE-1]\n" }],
    ]) {
      const r = run("security-suppressions.mjs", [repoWith(files)]);
      expect(r.code, name).toBe(1);
      expect(r.out, name).toContain("SCANNER SUPPRESSION");
    }
  });

  it("a clean tree passes, and an unlisted directory exits 2", () => {
    expect(run("security-suppressions.mjs", [repoWith({ "package.json": "{\"pnpm\":{\"overrides\":{}}}" })]).code).toBe(0);
    expect(run("security-suppressions.mjs", [mkdtempSync(path.join(tmpdir(), "not-a-repo-"))]).code).toBe(2);
    expect(findSuppressions(["a/b/.trivyignore.yaml"], () => "")).toHaveLength(1);
  });
});

describe("security-runtime-contents (the image carries no build tool)", () => {
  it("names build tools by their pnpm store directory, and nothing else", () => {
    for (const d of ["esbuild@0.25.12", "@esbuild+linux-x64@0.25.12", "vite@6.0.0", "vitest@4.1.11", "typescript@5.8.3", "tsx@4.0.0", "drizzle-kit@0.30.0", "@playwright+test@1.56.1", "@rollup+rollup-linux-x64-gnu@4.0.0"]) {
      expect(BUILD_TOOL.test(d), d).toBe(true);
    }
    for (const d of ["fastify@5.12.5", "drizzle-orm@0.45.3", "pg@8.23.1", "esbuild-plugin-x-not@1.0.0", "zod@3.0.0"]) {
      expect(BUILD_TOOL.test(d), d).toBe(false);
    }
  });

  it("RED: a tree with esbuild in its store fails; a tree without node_modules cannot be checked", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-"));
    execFileSync("mkdir", ["-p", path.join(dir, "node_modules/.pnpm/@esbuild+linux-x64@0.25.12"), path.join(dir, "node_modules/.pnpm/fastify@5.12.5")]);
    expect(findBuildTools(dir).hits).toEqual(["@esbuild+linux-x64@0.25.12"]);
    expect(run("security-runtime-contents.mjs", [dir]).code).toBe(1);
    expect(run("security-runtime-contents.mjs", [mkdtempSync(path.join(tmpdir(), "empty-"))]).code).toBe(2);
  });
});

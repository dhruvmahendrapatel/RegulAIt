// ADR-0350: execute the workflow's actual pack/verify commands against disposable workspaces.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = yaml.load(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")).jobs;
const base = jobs["build-and-test-base"];
const shards = jobs["gateway-tests"];
const pack = base.steps.find((s) => s.id === "gateway-build");
const restore = shards.steps.find((s) => s.name === "Verify and restore the gateway build");
const temps = [];
afterEach(() => { while (temps.length) rmSync(temps.pop(), { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "gateway-handoff-"));
  temps.push(cwd);
  const env = { ...process.env, GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: path.join(cwd, "runner"), GITHUB_OUTPUT: path.join(cwd, "outputs") };
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args], { cwd, env, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "fixture-lock\n");
  git("add", "pnpm-lock.yaml");
  git("commit", "-qm", "fixture");
  for (const dir of ["apps/gateway/dist", "packages/db/dist", "packages/shared/dist", "runner"]) mkdirSync(path.join(cwd, dir), { recursive: true });
  for (const file of ["apps/gateway/dist/seed.js", "packages/db/dist/index.js", "packages/shared/dist/index.js"]) writeFileSync(path.join(cwd, file), `export const fixture = ${JSON.stringify(file)};\n`);
  execFileSync("bash", ["-c", pack.run], { cwd, env, stdio: "pipe" });
  const outputs = Object.fromEntries(readFileSync(env.GITHUB_OUTPUT, "utf8").trim().split("\n").map((s) => s.split("=")));
  env.EXPECTED_ARCHIVE_SHA256 = outputs.sha256;
  env.EXPECTED_PRODUCER_ATTEMPT = outputs["producer-attempt"];
  // Remove only generated test outputs, so a rejected handoff cannot hide behind a local build.
  for (const dir of ["apps/gateway/dist", "packages/db/dist", "packages/shared/dist"]) rmSync(path.join(cwd, dir), { recursive: true });
  return { cwd, env, git, manifest: path.join(env.RUNNER_TEMP, "gateway-build/manifest.json"), archive: path.join(env.RUNNER_TEMP, "gateway-build/dist.tar.gz") };
}
const restoreBuild = (f) => execFileSync("bash", ["-c", restore.run], { cwd: f.cwd, env: f.env, stdio: "pipe" });

describe("C1 workflow graph and gates", () => {
  it("reuses the existing full build once and preserves the five-shard/web-only selector", () => {
    expect(base.steps.filter((s) => s.run?.trim() === "pnpm -r build")).toHaveLength(1);
    expect(shards.needs).toEqual(["scope", "build-and-test-base"]);
    expect(shards.steps.some((s) => /pnpm[^\n]*\bbuild\b/.test(s.run ?? ""))).toBe(false);
    expect(shards.strategy.matrix.shard).toBe('${{ fromJSON(needs.scope.outputs.gateway == \'false\' && \'["web-readers"]\' || \'[1, 2, 3, 4, 5]\') }}');
    expect(shards.steps.find((s) => s.name?.startsWith("Gateway suite, shard")).run).toContain("--shard=${{ matrix.shard }}/${{ strategy.job-total }}");
    expect(shards.steps.find((s) => s.name?.startsWith("Gateway tests that read")).run).toContain("--gateway-web-readers");
    expect(jobs["gateway-coverage"].needs).toEqual(["scope", "gateway-tests"]);
    expect(jobs["build-and-test"].needs).toEqual(["scope", "build-and-test-base", "gateway-tests", "gateway-coverage"]);
  });

  it("uses exact current-run artifacts, no cache/cross-run fallback, and fails on an absent ID", () => {
    const upload = base.steps.find((s) => s.id === "gateway-upload");
    const download = shards.steps.find((s) => s.name === "Download this run's gateway build by exact artifact ID");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with["retention-days"]).toBe(1);
    expect(download.with["artifact-ids"]).toBe("${{ needs.build-and-test-base.outputs.gateway-artifact-id }}");
    for (const key of ["name", "pattern", "run-id", "github-token", "repository"]) expect(download.with).not.toHaveProperty(key);
    const guard = shards.steps.find((s) => s.name === "Require the gateway build artifact from the successful producer");
    expect(shards.steps.indexOf(guard)).toBeLessThan(shards.steps.indexOf(download));
    for (const id of ["", "abc", "1,2"]) expect(() => execFileSync("bash", ["-c", guard.run], { env: { ...process.env, BUILD_ARTIFACT_ID: id }, stdio: "pipe" })).toThrow();
    expect(() => execFileSync("bash", ["-c", guard.run], { env: { ...process.env, BUILD_ARTIFACT_ID: "123" }, stdio: "pipe" })).not.toThrow();
  });
});

describe("C1 handoff integrity (real tar, git and SHA-256)", () => {
  it("restores all compiled exports and the built gateway from the matching producer", () => {
    const f = fixture();
    restoreBuild(f);
    expect(readFileSync(path.join(f.cwd, "apps/gateway/dist/seed.js"), "utf8")).toContain("apps/gateway/dist/seed.js");
    expect(readFileSync(path.join(f.cwd, "packages/db/dist/index.js"), "utf8")).toContain("packages/db/dist/index.js");
    expect(readFileSync(path.join(f.cwd, "packages/shared/dist/index.js"), "utf8")).toContain("packages/shared/dist/index.js");
  });

  it.each(["run", "attempt", "source", "lockfile", "runtime", "archive", "missing-digest"])("rejects a mismatched %s before restoring", (kind) => {
    const f = fixture();
    if (kind === "run") f.env.GITHUB_RUN_ID = "102";
    if (kind === "attempt") f.env.EXPECTED_PRODUCER_ATTEMPT = "2";
    if (kind === "source") f.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "another source");
    if (kind === "lockfile") writeFileSync(path.join(f.cwd, "pnpm-lock.yaml"), "changed-lock\n");
    if (kind === "runtime") { const m = JSON.parse(readFileSync(f.manifest, "utf8")); m.arch = "other"; writeFileSync(f.manifest, JSON.stringify(m)); }
    if (kind === "archive") writeFileSync(f.archive, "corrupt archive\n");
    if (kind === "missing-digest") f.env.EXPECTED_ARCHIVE_SHA256 = "";
    expect(() => restoreBuild(f)).toThrow();
    expect(() => readFileSync(path.join(f.cwd, "apps/gateway/dist/seed.js"))).toThrow();
  });

  it("supports retrying a failed shard in the same run with the successful producer's original attempt", () => {
    const f = fixture();
    f.env.GITHUB_RUN_ATTEMPT = "2";
    expect(() => restoreBuild(f)).not.toThrow();
    expect(createHash("sha256").update(readFileSync(f.archive)).digest("hex")).toBe(f.env.EXPECTED_ARCHIVE_SHA256);
  });
});

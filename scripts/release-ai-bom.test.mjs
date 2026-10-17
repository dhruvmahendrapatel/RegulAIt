// ADR-0189 slice B7 / R17: the release-time AI BOM CLI and its workflow gate.
// Needs `pnpm --filter @regulait/shared build` (CI's job builds first).
//
// The code switch `AI_BOM_SNAPSHOTS_RELEASED` is ON (R17), so the CLI reports
// `released=true` and `build` really builds. Publication is a SECOND gate: the
// workflow (`.github/workflows/release-ai-bom.yml`) builds, signs and publishes
// only when the repository variable `RELEASE_AI_BOM_PUBLISH_APPROVED` is
// exactly `true`. It is unset by owner decision; setting it needs the owner's
// explicit sign-off. The gate's own shell is executed below against the unset
// variable and every near-miss value (negative controls) and against `true`.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(here, "release-ai-bom.mjs");
const workflowFile = path.join(repoRoot, ".github/workflows/release-ai-bom.yml");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

/** the `run: |` body of the step with `id: <id>` (text slicing: the repo has no YAML parser at its root) */
function stepRunScript(yamlText, id) {
  const lines = yamlText.split("\n");
  const at = lines.findIndex((l) => l.trim() === `id: ${id}`);
  if (at < 0) throw new Error(`no step with id ${id}`);
  const runAt = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  if (runAt < 0) throw new Error(`step ${id} has no run block`);
  const indent = lines[runAt].indexOf("run:");
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "" && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(strip)).join("\n");
}

/** run the workflow's gate step as GitHub would, with `PUBLISH_APPROVED` set from the repo variable */
function gate(publishApproved) {
  const dir = mkdtempSync(path.join(tmpdir(), "r17-gate-"));
  const out = path.join(dir, "github_output");
  writeFileSync(out, "");
  const script = stepRunScript(readFileSync(workflowFile, "utf8"), "switch");
  const env = { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out };
  // GitHub expands an unset `vars.X` to the empty string; `undefined` here models a missing env entry too
  if (publishApproved !== undefined) env.PUBLISH_APPROVED = publishApproved;
  const r = spawnSync("bash", ["-c", script], { cwd: repoRoot, env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(out, "utf8").trim();
}

// Each case spawns a fresh node that loads the built @regulait/shared (schemas
// compiled at import). Alone that is about a second; under CI's parallel
// `vitest run --dir scripts` sweep the default 5 s per-test budget was too
// tight, so the timeout is explicit (as in the bom-* CLI tests).
const CLI_TIMEOUT_MS = 60_000;

describe("release-ai-bom.mjs (ADR-0189 B7, R17 released)", { timeout: CLI_TIMEOUT_MS }, () => {
  it("reports the code switch as on", () => {
    expect(execFileSync(process.execPath, [cli, "switch"], { encoding: "utf8" }).trim()).toBe("released=true");
  });
  it("validates the checked-in inventory", () => {
    const r = run("check-inventory");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/tool\(s\), reviewed/);
  });
  it("build refuses missing or unreadable inputs and writes nothing", () => {
    const out = mkdtempSync(path.join(tmpdir(), "b7-release-"));
    for (const cmd of [
      // no --committed-at: a usage error before anything is read
      ["build", "--commit", "a".repeat(40), "--image-digest", `sha256:${"c".repeat(64)}`, "--workspace", "/nonexistent", "--image", "/nonexistent", "--out-dir", path.join(out, "bom")],
      // no SBOM inputs at all
      ["build", "--commit", "a".repeat(40), "--out-dir", path.join(out, "bom")],
      // every argument present, but the SBOM files do not exist
      ["build", "--commit", "a".repeat(40), "--committed-at", "2026-10-01T00:00:00.000Z", "--image-digest", `sha256:${"c".repeat(64)}`, "--workspace", "/nonexistent", "--image", "/nonexistent", "--out-dir", path.join(out, "bom")],
    ]) {
      const r = run(...cmd);
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stdout).not.toMatch(/^wrote /m);
    }
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(path.join(out, "bom"))).toBe(false);
  });
  it("refuses an unknown command", () => {
    expect(run("publish").status).toBe(2);
    expect(run("identity").status).toBe(2);
  });
  it("usage and parse errors are value-free", () => {
    const secretish = ["--x", "CANARY-VALUE"];
    const r = run("check-inventory", ...secretish);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain("CANARY");
    expect(r.stderr).not.toContain("--x");
    const bad = run("check-inventory", "--inventory", path.join(here, "CANARY-missing.json"));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--inventory is not readable JSON/);
    expect(bad.stderr).not.toContain("CANARY");
  });
});

describe("release-ai-bom.yml publication gate (RELEASE_AI_BOM_PUBLISH_APPROVED, owner sign-off)", { timeout: CLI_TIMEOUT_MS }, () => {
  it("negative control: the variable unset (the owner's chosen state) publishes nothing", () => {
    expect(gate(undefined)).toBe("released=false");
    expect(gate("")).toBe("released=false");
  });
  it("negative control: any value other than exactly `true` publishes nothing", () => {
    for (const v of ["false", "TRUE", "True", "1", "yes", "on", " true", "true ", "true\n", "'true'", "\"true\""]) {
      expect(gate(v), JSON.stringify(v)).toBe("released=false");
    }
  });
  it("only the exact value `true` (with the code switch on) opens the gate", () => {
    expect(gate("true")).toBe("released=true");
  });
  it("every producing step and the signing job are behind the gate", () => {
    const y = readFileSync(workflowFile, "utf8");
    expect(y).toContain("PUBLISH_APPROVED: ${{ vars.RELEASE_AI_BOM_PUBLISH_APPROVED }}");
    const signJob = y.slice(y.indexOf("\n  sign:"));
    expect(signJob.split("\n").slice(0, 6).join("\n")).toContain("if: needs.build.outputs.released == 'true'");
    for (const name of ["Download this commit's SBOMs", "Download the signed image digest", "Build the SBOM identity and the AI BOM (unsigned)", "Hand the unsigned files to the signing job"]) {
      const at = y.indexOf(`- name: ${name}`);
      expect(at, name).toBeGreaterThan(0);
      expect(y.slice(at).split("\n")[1].trim(), name).toBe("if: steps.switch.outputs.released == 'true'");
    }
  });
});

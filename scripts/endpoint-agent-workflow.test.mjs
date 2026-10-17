// ADR-0195 SD4a, owner decision 1: the endpoint agent's signing identity lives in "a protected CI secret store that
// only release jobs can use". Guards `.github/workflows/endpoint-agent.yml`:
//   - every job that reads a secret is a release job: it never runs for a pull request (only for main) and takes
//     its secrets from the protected `release` environment;
//   - the three signing jobs exist and their secret check still skips, with a notice, when the secrets are absent,
//     and refuses (exit 1) when they are present but the signing steps are not written yet.
// Text slicing, not a YAML parser: the repository has none at its root (see release-ai-bom.test.mjs).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowFile = path.join(here, "..", ".github/workflows/endpoint-agent.yml");
const yaml = readFileSync(workflowFile, "utf8");

const RELEASE_IF = "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'";
const SIGNING_JOBS = ["sign-macos", "sign-windows", "sign-linux-packages"];

/** job id -> the job's lines (two-space job keys under `jobs:`) */
function jobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  if (start < 0) throw new Error("no jobs: block");
  const out = new Map();
  let current = null;
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) {
      current = m[1];
      out.set(current, []);
    } else if (current && (l.startsWith("   ") || l.trim() === "")) {
      out.get(current).push(l);
    } else if (l.trim() !== "" && !l.startsWith(" ")) {
      current = null;
    }
  }
  return out;
}

/** the `run: |` body of the step with `id: <id>` inside one job's lines */
function stepRun(jobLines, id) {
  const at = jobLines.findIndex((l) => l.trim() === `id: ${id}`);
  if (at < 0) throw new Error(`no step with id ${id}`);
  const runAt = jobLines.findIndex((l, i) => i > at && l.trim() === "run: |");
  if (runAt < 0) throw new Error(`step ${id} has no run block`);
  const indent = jobLines[runAt].indexOf("run:");
  const body = [];
  for (const l of jobLines.slice(runAt + 1)) {
    if (l.trim() !== "" && l.search(/\S/) <= indent) break;
    body.push(l);
  }
  const strip = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(strip)).join("\n");
}

/** the lines that are not whole-line comments (a trailing comment is kept, so nothing can hide behind a `#`) */
const code = (lines) => lines.filter((l) => !l.trimStart().startsWith("#"));
/** any mention of the secrets context: `secrets.X`, `secrets['X']`, `toJSON(secrets)`, `secrets: inherit` */
const SECRETS = /\bsecrets\b/;

/** the env names the step maps from secrets */
function secretEnvNames(jobLines) {
  return jobLines.map((l) => /^\s+([A-Z0-9_]+): \$\{\{ secrets\.[A-Z0-9_]+ \}\}\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
}

describe("endpoint-agent.yml signing jobs (ADR-0195 owner decision 1)", () => {
  const all = jobs(yaml);

  it("still runs on pull requests, so the job-level guard is what keeps secrets out of them", () => {
    expect(yaml).toMatch(/^on:\n {2}pull_request:/m);
  });

  it("is triggered by exactly pull_request, push and workflow_dispatch (no pull_request_target or workflow_run)", () => {
    const lines = yaml.split("\n");
    const at = lines.indexOf("on:");
    expect(at).toBeGreaterThanOrEqual(0);
    const keys = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== "" && !l.startsWith(" ")) break;
      const m = /^ {2}([A-Za-z_]+):/.exec(l);
      if (m) keys.push(m[1]);
    }
    expect(keys.sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
  });

  it("calls no reusable workflow (a `uses:` job could be handed secrets: inherit)", () => {
    for (const [id, lines] of all) {
      expect(code(lines).filter((l) => /^ {4}uses:/.test(l) || /uses:\s*(\.\/|\S*\.github\/workflows\/)/.test(l)), id).toEqual([]);
    }
  });

  it("has the three signing jobs, each a release job in the protected environment", () => {
    for (const id of SIGNING_JOBS) {
      const lines = all.get(id);
      expect(lines, id).toBeDefined();
      const keys = lines.map((l) => l.trimEnd());
      expect(keys, id).toContain(`    ${RELEASE_IF}`);
      expect(keys, id).toContain("    environment: release");
    }
  });

  it("lets no other job read a secret", () => {
    const readers = [...all].filter(([, lines]) => code(lines).some((l) => SECRETS.test(l))).map(([id]) => id);
    expect(readers.sort()).toEqual([...SIGNING_JOBS].sort());
    // and nothing outside a job (workflow-level env) does either
    const beforeJobs = yaml.slice(0, yaml.indexOf("\njobs:\n"));
    expect(code(beforeJobs.split("\n")).filter((l) => SECRETS.test(l))).toEqual([]);
  });

  for (const id of SIGNING_JOBS) {
    it(`${id}: skips with a notice when its secrets are absent, refuses when they are present`, () => {
      const lines = all.get(id);
      const script = stepRun(lines, "signing-secrets");
      const names = secretEnvNames(lines);
      expect(names.length, id).toBeGreaterThan(0);
      const absent = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
      expect(absent.status, absent.stderr).toBe(0);
      expect(absent.stdout).toMatch(new RegExp(`::notice title=${id} skipped::`));
      // a near miss: only some of the secrets present still skips
      if (names.length > 1) {
        const partial = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", [names[0]]: "x" }, encoding: "utf8" });
        expect(partial.status).toBe(0);
      }
      const present = Object.fromEntries(names.map((n) => [n, "synthetic-not-a-secret"]));
      const refused = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", ...present }, encoding: "utf8" });
      expect(refused.status).toBe(1);
      expect(refused.stdout).toMatch(/::error::/);
    });
  }
});

/**
 * ADR-0187 — the compose side of the engine contract, read as text and as
 * YAML-shaped blocks (no daemon): the `engines` network is internal-only, the
 * gateway is the only other member (the database and object store are not on
 * it), it is not a trusted proxy, and the runner template every engine service
 * merges carries the hardening the ADR requires.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");

/** the text of one top-level block (service at two spaces, or a top-level key) */
function block(name: string, indent = "  "): string {
  const start = compose.indexOf(`\n${indent}${name}:`);
  expect(start, `block ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const re = indent === "" ? /\n[a-z][a-z0-9-]*:/ : /\n {2}[a-z0-9-]+:\n/;
  const next = rest.slice(indent.length + 1).search(re);
  return next === -1 ? rest : rest.slice(0, next + indent.length + 1);
}

describe("ADR-0187: the engines network and the runner template", () => {
  it("the engines network is internal-only", () => {
    const nets = block("networks", "");
    expect(nets).toMatch(/\n {2}engines:\n {4}internal: true\n/);
  });

  it("the gateway joins it; the database and the object store do not", () => {
    expect(block("gateway")).toMatch(/\n {4}networks: \[regulait, engines\]\n/);
    for (const svc of ["db", "objectstore", "objectstore-init"]) {
      expect(block(svc), svc).toMatch(/\n {4}networks: \[regulait\]\n/);
      expect(block(svc), svc).not.toMatch(/engines/);
    }
  });

  it("the engines network is not a trusted proxy", () => {
    expect(compose).toMatch(/REGULAIT_TRUSTED_PROXIES: \$\{REGULAIT_TRUSTED_PROXIES:-172\.28\.0\.2\}/);
  });

  it("every runner merges the hardened template: engines network only, no privileges, limits, no pulls", () => {
    const t = block("x-engine-runner", "");
    expect(t).toMatch(/^x-engine-runner: &engine-runner\n/);
    expect(t).toMatch(/\n {2}profiles: \["engines"\]\n/);
    expect(t).toMatch(/\n {2}networks: \[engines\]\n/);
    expect(t).toMatch(/\n {2}read_only: true\n/);
    expect(t).toMatch(/\n {2}cap_drop: \[ALL\]\n/);
    expect(t).toMatch(/\n {2}security_opt: \["no-new-privileges:true"\]\n/);
    expect(t).toMatch(/\n {2}user: "10001:10001"\n/);
    expect(t).toMatch(/\n {2}mem_limit: \S+\n/);
    expect(t).toMatch(/\n {2}cpus: \S+\n/);
    expect(t).toMatch(/\n {2}pids_limit: \d+\n/);
    expect(t).toMatch(/\n {2}pull_policy: \$\{REGULAIT_ENGINE_PULL_POLICY:-never\}\n/);
    expect(t).toMatch(/\n {4}- \/work:size=/);
    // no Docker socket anywhere in the stack
    expect(compose).not.toMatch(/docker\.sock/);
    // the runner holds no secret but its enrolment token
    const env = t.slice(t.indexOf("  environment:"), t.indexOf("  restart:"));
    expect(env.match(/\n {4}[A-Z_]+:/g)?.map((s) => s.trim())).toEqual(["REGULAIT_GATEWAY_URL:", "REGULAIT_ENGINE_ENROLLMENT_TOKEN:"]);
  });

  it("B5-P: the promptfoo runner merges the template and overrides only its image, platform, state volume and four variables", () => {
    const svc = block("engine-promptfoo");
    expect(svc).toMatch(/\n {4}<<: \*engine-runner\n/);
    // nothing that would widen the template: no ports, networks, privileges, profiles or user
    for (const key of ["ports", "networks", "privileged", "cap_add", "profiles", "user", "read_only", "security_opt", "pull_policy", "network_mode", "tmpfs"]) {
      expect(svc, key).not.toMatch(new RegExp(`\\n {4}${key}:`));
    }
    // PR #205 review [55]: the image is named by digest only, and the image reference, the
    // reference the runner checks and the digest it reports all come from ONE variable
    const REF = "${REGULAIT_ENGINE_PROMPTFOO_REPOSITORY:-regulait/engine-promptfoo}@${REGULAIT_ENGINE_PROMPTFOO_DIGEST:-sha256:" + "0".repeat(64) + "}";
    const DIGEST = "${REGULAIT_ENGINE_PROMPTFOO_DIGEST:-sha256:" + "0".repeat(64) + "}";
    const line = (k: string) => svc.split("\n").find((l) => l.trimStart().startsWith(`${k}:`))?.trim().slice(k.length + 1).trim();
    expect(line("image")).toBe(REF);
    expect(line("REGULAIT_ENGINE_IMAGE_REF")).toBe(REF);
    expect(line("REGULAIT_ENGINE_IMAGE_DIGEST")).toBe(DIGEST);
    expect(svc).not.toMatch(/:latest|engine-promptfoo:0\.123/);
    // PR #205 review [51]: amd64 only (libsql's native x64 binding)
    expect(svc).toMatch(/\n {4}platform: linux\/amd64\n/);
    // PR #205 review [49]: exactly one volume, the runner's own state, a named volume (no host path)
    const vols = svc.slice(svc.indexOf("    volumes:\n") + 13, svc.indexOf("    environment:"));
    expect(vols.trim().split("\n").map((l) => l.trim())).toEqual(["- engine-promptfoo-state:/state"]);
    expect(block("volumes", "")).toMatch(/\n {2}engine-promptfoo-state:\n/);
    const env = svc.slice(svc.indexOf("    environment:"));
    expect(env.match(/\n {6}[A-Z_]+:/g)?.map((s) => s.trim())).toEqual([
      "REGULAIT_GATEWAY_URL:",
      "REGULAIT_ENGINE_ENROLLMENT_TOKEN:",
      "REGULAIT_ENGINE_IMAGE_REF:",
      "REGULAIT_ENGINE_IMAGE_DIGEST:",
    ]);
  });
  it("B5-M: the modelscan runner merges the template; the scanner has no network, no token, no state, the artifact read-only and one writable tmpfs", () => {
    const REF = "${REGULAIT_ENGINE_MODELSCAN_REPOSITORY:-regulait/engine-modelscan}@${REGULAIT_ENGINE_MODELSCAN_DIGEST:-sha256:" + "0".repeat(64) + "}";
    const line = (svc: string, k: string) => svc.split("\n").find((l) => l.trimStart().startsWith(`${k}:`))?.trim().slice(k.length + 1).trim();
    const runner = block("engine-modelscan");
    expect(runner).toMatch(/\n {4}<<: \*engine-runner\n/);
    for (const key of ["ports", "networks", "privileged", "cap_add", "profiles", "user", "read_only", "security_opt", "pull_policy", "network_mode", "tmpfs"]) {
      expect(runner, key).not.toMatch(new RegExp(`\\n {4}${key.replace(/[\\^$.*+?()[\]{}|<]/g, "\\$&")}:`));
    }
    expect(line(runner, "image")).toBe(REF);
    expect(line(runner, "REGULAIT_ENGINE_IMAGE_REF")).toBe(REF);
    const rvols = runner.slice(runner.indexOf("    volumes:\n") + 13, runner.indexOf("    environment:"));
    expect(rvols.trim().split("\n").map((l) => l.trim())).toEqual([
      "- engine-modelscan-state:/state",
      "- engine-modelscan-jobs:/jobs",
      "- engine-modelscan-results:/results:ro",
    ]);

    const scanner = block("engine-modelscan-scanner");
    // the same image, by digest only
    expect(line(scanner, "image")).toBe(REF);
    expect(scanner).toMatch(/\n {4}command: \["node", "\/app\/dist\/scanner-main\.js"\]\n/);
    // no network at all, and nothing that could widen it
    expect(scanner).toMatch(/\n {4}network_mode: none\n/);
    for (const key of ["networks", "ports", "privileged", "cap_add", "<<", "depends_on", "extra_hosts", "dns"]) {
      expect(scanner, key).not.toMatch(new RegExp(`\\n {4}${key.replace(/[\\^$.*+?()[\]{}|<]/g, "\\$&")}:`));
    }
    expect(scanner).toMatch(/\n {4}read_only: true\n/);
    expect(scanner).toMatch(/\n {4}cap_drop: \[ALL\]\n/);
    expect(scanner).toMatch(/\n {4}security_opt: \["no-new-privileges:true"\]\n/);
    expect(scanner).toMatch(/\n {4}user: "10001:10001"\n/);
    expect(scanner).toMatch(/\n {4}pull_policy: \$\{REGULAIT_ENGINE_PULL_POLICY:-never\}\n/);
    expect(scanner).toMatch(/\n {4}profiles: \["engines"\]\n/);
    // smaller limits than the runner template
    expect(line(scanner, "mem_limit")).toBe("1g");
    expect(line(scanner, "cpus")).toBe("1");
    expect(line(scanner, "pids_limit")).toBe("64");
    // the artifact read-only; its one writable volume is /out; no state volume, no token
    const svols = scanner.slice(scanner.indexOf("    volumes:\n") + 13, scanner.indexOf("    environment:"));
    expect(svols.trim().split("\n").map((l) => l.trim())).toEqual(["- engine-modelscan-jobs:/jobs:ro", "- engine-modelscan-results:/out"]);
    expect(scanner).not.toMatch(/ENROLLMENT_TOKEN|\/state|GATEWAY_URL/);
    // both exchange volumes are tmpfs-backed (nothing of an artifact survives the containers)
    const vols = block("volumes", "");
    for (const v of ["engine-modelscan-jobs", "engine-modelscan-results"]) {
      const at = vols.indexOf(`\n  ${v}:\n`);
      expect(at, v).toBeGreaterThan(-1);
      expect(vols.slice(at, at + 200), v).toMatch(/type: tmpfs\n\s+device: tmpfs\n/);
    }
  });
});

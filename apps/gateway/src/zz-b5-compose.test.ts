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

  it("B5-P: the promptfoo runner merges the template and overrides nothing but its image and its three non-secret-or-enrolment variables", () => {
    const svc = block("engine-promptfoo");
    expect(svc).toMatch(/\n {4}<<: \*engine-runner\n/);
    // nothing that would widen the template: no ports, volumes, networks, privileges, profiles or user
    for (const key of ["ports", "volumes", "networks", "privileged", "cap_add", "profiles", "user", "read_only", "security_opt", "pull_policy", "network_mode"]) {
      expect(svc, key).not.toMatch(new RegExp(`\\n {4}${key}:`));
    }
    // the image reference is configurable for a digest pin and never a floating tag
    expect(svc).toMatch(/\n {4}image: \$\{REGULAIT_ENGINE_PROMPTFOO_IMAGE:-regulait\/engine-promptfoo:0\.123\.1\}\n/);
    expect(svc).not.toMatch(/:latest/);
    const env = svc.slice(svc.indexOf("    environment:"));
    expect(env.match(/\n {6}[A-Z_]+:/g)?.map((s) => s.trim())).toEqual([
      "REGULAIT_GATEWAY_URL:",
      "REGULAIT_ENGINE_ENROLLMENT_TOKEN:",
      "REGULAIT_ENGINE_IMAGE_DIGEST:",
    ]);
  });
});

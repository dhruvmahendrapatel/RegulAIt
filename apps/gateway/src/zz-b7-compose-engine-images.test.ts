/**
 * ADR-0190 "I5 follow-up: engines in compose" — read as text (no daemon):
 *  - the three engine images are BUILD-only services under their own profile, inert if started (no network, no
 *    privileges), and their tags are never what a runner runs (runners stay pinned by registry digest);
 *  - the sandbox executor has its input volume: a fixed-name named volume (no host path) mounted only on the executor,
 *    with the two variables the runsc backend reads;
 *  - every Caddy service names the one digest-pinned reference, and the image bundle and the installer name the same.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");

/** the text of one block: a service (two-space indent) or a top-level key */
function block(name: string, indent = "  "): string {
  const start = compose.indexOf(`\n${indent}${name}:`);
  expect(start, `block ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const re = indent === "" ? /\n[a-z][a-z0-9-]*:/ : /\n {2}[a-z0-9-]+:\n/;
  const next = rest.slice(indent.length + 1).search(re);
  return next === -1 ? rest : rest.slice(0, next + indent.length + 1);
}

const CADDY_RE = /^caddy:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/;

describe("ADR-0190 I5 follow-up: engines in compose", () => {
  it("the engine image template builds only: own profile, inert entry point, no network, no privileges", () => {
    const t = block("x-engine-image", "");
    expect(t).toMatch(/^x-engine-image: &engine-image\n/);
    expect(t).toMatch(/\n {2}profiles: \["engine-images"\]\n/);
    expect(t).toMatch(/\n {2}pull_policy: build\n/);
    expect(t).toMatch(/\n {2}entrypoint: \["\/usr\/local\/bin\/node", "-e", "process\.exit\(0\)"\]\n/);
    expect(t).toMatch(/\n {2}network_mode: none\n/);
    expect(t).toMatch(/\n {2}read_only: true\n/);
    expect(t).toMatch(/\n {2}cap_drop: \[ALL\]\n/);
    expect(t).toMatch(/\n {2}security_opt: \["no-new-privileges:true"\]\n/);
    expect(t).toMatch(/\n {2}user: "10001:10001"\n/);
    expect(t).not.toMatch(/volumes:|ports:|networks:|environment:|cap_add:|privileged:/);
  });

  it.each(["promptfoo", "modelscan", "garak"])("%s: one build-only image service from its Dockerfile", (engine) => {
    const svc = block(`engine-${engine}-image`);
    expect(svc).toMatch(/\n {4}<<: \*engine-image\n/);
    expect(svc).toMatch(new RegExp(`\\n {6}dockerfile: engines/${engine}/Dockerfile\\n`));
    expect(svc).toMatch(/\n {6}context: \.\n/);
    expect(svc).toMatch(new RegExp(`\\n {4}image: regulait/engine-${engine}:local\\n`));
    // nothing that widens the template
    for (const key of ["ports", "networks", "volumes", "environment", "privileged", "cap_add", "profiles", "user", "network_mode", "entrypoint", "command"]) {
      expect(svc, key).not.toMatch(new RegExp(`\\n {4}${key}:`));
    }
    // the runner never runs the local tag: it stays pinned by registry digest
    expect(block(`engine-${engine}`)).not.toMatch(/:local\b/);
    // every Dockerfile base is pinned by digest (a stage built on an earlier stage names that stage)
    const df = readFileSync(path.join(root, "engines", engine, "Dockerfile"), "utf8");
    const stages = new Set<string>();
    for (const m of df.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
      expect(stages.has(m[1]!) || /@sha256:[0-9a-f]{64}$/.test(m[1]!), `${engine}: FROM ${m[1]}`).toBe(true);
      if (m[2]) stages.add(m[2]);
    }
    expect(df).toMatch(/\nUSER 10001:10001\n/);
  });

  it("the executor's input volume: fixed name, named volume only, mounted on the executor alone, both variables set", () => {
    const ex = block("sandbox-executor");
    expect(ex).toMatch(/\n {6}- executor-input:\/executor-input\n/);
    expect(ex).toMatch(/\n {6}REGULAIT_EXECUTOR_INPUT_DIR: \/executor-input\n/);
    expect(ex).toMatch(/\n {6}REGULAIT_EXECUTOR_INPUT_VOLUME: regulait-executor-input\n/);
    expect(compose.split("- executor-input:").length - 1).toBe(1);
    const vols = block("volumes", "");
    expect(vols).toMatch(/\n {2}executor-input:\n {4}name: regulait-executor-input\n/);
    // the executor image owns the mount point, so a fresh named volume is writable by the executor
    const df = readFileSync(path.join(root, "packages/sandbox-executor/Dockerfile"), "utf8");
    expect(df).toMatch(/mkdir -p \/executor-input && chown 10001:10001 \/executor-input && chmod 0711 \/executor-input/);
  });

  it("every Caddy service names the one digest-pinned reference; the bundle and the installer name the same", () => {
    const m = compose.match(/\nx-caddy-image: &caddy-image (\S+)\n/);
    expect(m).not.toBeNull();
    const ref = m![1]!;
    expect(ref).toMatch(CADDY_RE);
    for (const svc of ["caddy", "executor-front", "executor-front-ca"]) expect(block(svc), svc).toMatch(/\n {4}image: \*caddy-image\n/);
    expect(compose).not.toMatch(/image: caddy:/);
    const bundle = readFileSync(path.join(root, "scripts/build-image-bundle.sh"), "utf8");
    expect(bundle).toContain(`CADDY_IMAGE="${ref}"`);
    expect(bundle).not.toMatch(/caddy:2-alpine(?!@)/);
    const install = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    expect(install).toContain(` ${ref}; do`);
    expect(install).not.toMatch(/caddy:2-alpine/);
  });
});

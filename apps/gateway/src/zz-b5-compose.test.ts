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
/**
 * ENG-IMG: each runner's image reference defaults come from engines/images.lock.json (scripts/engine-images-lock.mjs
 * writes them): the lock's repository and manifest digest, or the local name and the all-zero digest until a publish.
 */
const lock = JSON.parse(readFileSync(path.join(root, "engines/images.lock.json"), "utf8")) as {
  engines: Record<string, { repository: string | null; manifestDigest: string | null }>;
};
function lockedRef(engine: string): { ref: string; digest: string } {
  const e = lock.engines[engine]!;
  const up = engine.toUpperCase();
  const digest = `\${REGULAIT_ENGINE_${up}_DIGEST:-${e.manifestDigest ?? `sha256:${"0".repeat(64)}`}}`;
  return { ref: `\${REGULAIT_ENGINE_${up}_REPOSITORY:-${e.repository ?? `regulait/engine-${engine}`}}@${digest}`, digest };
}

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
    // no Docker socket anywhere in the stack, except the ADR-0190 sandbox executor's (decision 4: the executor, never
    // the gateway or a runner, starts sandboxes; it holds the socket and nothing else)
    const executor = block("sandbox-executor");
    expect(executor).toMatch(/\n {6}- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock\n/);
    expect(compose.replace(executor, "")).not.toMatch(/docker\.sock/);
    expect(block("gateway")).not.toMatch(/docker\.sock/);
    expect(executor).toMatch(/\n {4}profiles: \["isolation"\]\n/);
    expect(executor).toMatch(/\n {4}networks: \[engines\]\n/);
    // the runner holds no secret but its enrolment token (ADR-0188 S7: plus the gateway's issuer, a public URL
    // its self-token requests name; its key it generates itself, on its own volume)
    const env = t.slice(t.indexOf("  environment:"), t.indexOf("  restart:"));
    expect(env.match(/\n {4}[A-Z_]+:/g)?.map((s) => s.trim())).toEqual(["REGULAIT_GATEWAY_URL:", "REGULAIT_ENGINE_ENROLLMENT_TOKEN:", "REGULAIT_PUBLIC_URL:"]);
    expect(env).toMatch(/\n {4}REGULAIT_PUBLIC_URL: \$\{REGULAIT_PUBLIC_URL:-\}\n/);
  });

  it("B5-P: the promptfoo runner merges the template and overrides only its image, platform, volumes and six variables", () => {
    const svc = block("engine-promptfoo");
    expect(svc).toMatch(/\n {4}<<: \*engine-runner\n/);
    // nothing that would widen the template: no ports, networks, privileges, profiles or user
    for (const key of ["ports", "networks", "privileged", "cap_add", "profiles", "user", "read_only", "security_opt", "pull_policy", "network_mode", "tmpfs"]) {
      expect(svc, key).not.toMatch(new RegExp(`\\n {4}${key}:`));
    }
    // PR #205 review [55]: the image is named by digest only, and the image reference, the
    // reference the runner checks and the digest it reports all come from ONE variable
    const { ref: REF, digest: DIGEST } = lockedRef("promptfoo");
    const line = (k: string) => svc.split("\n").find((l) => l.trimStart().startsWith(`${k}:`))?.trim().slice(k.length + 1).trim();
    expect(line("image")).toBe(REF);
    expect(line("REGULAIT_ENGINE_IMAGE_REF")).toBe(REF);
    expect(line("REGULAIT_ENGINE_IMAGE_DIGEST")).toBe(DIGEST);
    expect(svc).not.toMatch(/:latest|engine-promptfoo:0\.123/);
    // PR #205 review [51]: amd64 only (libsql's native x64 binding)
    expect(svc).toMatch(/\n {4}platform: linux\/amd64\n/);
    // PR #205 review [49]: the runner's own state is a named volume (no host path); B5-P2 adds the
    // two exchange volumes with the worker (pinned in the worker's test above)
    const vols = svc.slice(svc.indexOf("    volumes:\n") + 13, svc.indexOf("    environment:"));
    expect(vols.trim().split("\n").map((l) => l.trim())[0]).toBe("- engine-promptfoo-state:/state");
    expect(block("volumes", "")).toMatch(/\n {2}engine-promptfoo-state:\n/);
    const env = svc.slice(svc.indexOf("    environment:"));
    expect(env.match(/\n {6}[A-Z_]+:/g)?.map((s) => s.trim())).toEqual([
      "REGULAIT_GATEWAY_URL:",
      "REGULAIT_ENGINE_ENROLLMENT_TOKEN:",
      "REGULAIT_ENGINE_IMAGE_REF:",
      "REGULAIT_ENGINE_IMAGE_DIGEST:",
      "REGULAIT_PROMPTFOO_JOBS_DIR:",
      "REGULAIT_PROMPTFOO_RESULTS_DIR:",
    ]);
  });

  // ADR-0190 I5: an engine's worker runs ONLY in an executor's sandbox (gVisor, the run's engine_worker placement).
  // The B5-P2 / B5-M / B5-G worker and scanner containers are gone; each runner's exchange volumes are its own (the
  // task bridge writes the results it reads), tmpfs-backed, and nothing else mounts them.
  it.each([
    ["promptfoo", "engine-promptfoo-worker"],
    ["modelscan", "engine-modelscan-scanner"],
    ["garak", "engine-garak-worker"],
  ])("I5: %s has no worker container; its runner merges the template and owns both exchange volumes", (engine, gone) => {
    expect(compose).not.toMatch(new RegExp(`\\n {2}${gone}:\\n`));
    const runner = block(`engine-${engine}`);
    expect(runner).toMatch(/\n {4}<<: \*engine-runner\n/);
    for (const key of ["ports", "networks", "privileged", "cap_add", "profiles", "user", "read_only", "security_opt", "pull_policy", "network_mode", "tmpfs"]) {
      expect(runner, key).not.toMatch(new RegExp(`\\n {4}${key}:`));
    }
    const REF = lockedRef(engine).ref;
    const line = (k: string) => runner.split("\n").find((l) => l.trimStart().startsWith(`${k}:`))?.trim().slice(k.length + 1).trim();
    expect(line("image")).toBe(REF);
    expect(line("REGULAIT_ENGINE_IMAGE_REF")).toBe(REF);
    const rvols = runner.slice(runner.indexOf("    volumes:\n") + 13, runner.indexOf("    environment:"));
    expect(rvols.trim().split("\n").map((l) => l.trim())).toEqual([`- engine-${engine}-state:/state`, `- engine-${engine}-jobs:/jobs`, `- engine-${engine}-results:/results`]);
    // nothing but the runner mounts the exchange volumes
    for (const v of [`engine-${engine}-jobs`, `engine-${engine}-results`]) {
      expect(compose.split(`- ${v}:`).length - 1, v).toBe(1);
    }
    const vols = block("volumes", "");
    for (const v of [`engine-${engine}-jobs`, `engine-${engine}-results`]) {
      const at = vols.indexOf(`\n  ${v}:\n`);
      expect(at, v).toBeGreaterThan(-1);
      expect(vols.slice(at, at + 200), v).toMatch(/type: tmpfs\n\s+device: tmpfs\n/);
    }
    expect(compose).not.toMatch(/worker-main\.js|scanner-main\.js/);
  });
});

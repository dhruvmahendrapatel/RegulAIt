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
    // no other service mounts it, in the short or the long form
    const services = block("services", "");
    let checked = 0;
    for (const m of services.matchAll(/\n {2}([a-z0-9-]+):\n/g)) {
      if (m[1] === "sandbox-executor") continue;
      const svc = block(m[1]!);
      expect(svc, m[1]).not.toMatch(/executor-input|regulait-executor-input/);
      checked += 1;
    }
    // the loop cannot pass vacuously: the stack has well over five other services
    expect(checked).toBeGreaterThan(5);
    const vols = block("volumes", "");
    expect(vols).toMatch(/\n {2}executor-input:\n {4}name: regulait-executor-input\n/);
    // the executor image owns the mount point, so a fresh named volume is writable by the executor
    const df = readFileSync(path.join(root, "packages/sandbox-executor/Dockerfile"), "utf8");
    expect(df).toMatch(/mkdir -p \/executor-input && chown 10001:10001 \/executor-input && chmod 0711 \/executor-input/);
  });

  it("every Caddy service names the one digest-pinned reference; the bundle and the installer name the same", () => {
    const m = compose.match(/\nx-caddy: &caddy\n {2}image: (\S+)\n/);
    expect(m).not.toBeNull();
    const ref = m![1]!;
    expect(ref).toMatch(CADDY_RE);
    for (const svc of ["caddy", "executor-front", "executor-front-ca"]) expect(block(svc), svc).toMatch(/\n {4}<<: \*caddy\n/);
    expect(compose).not.toMatch(/\n {4}image: caddy:/);
    const tag = ref.slice(0, ref.indexOf("@"));
    const bundle = readFileSync(path.join(root, "scripts/build-image-bundle.sh"), "utf8");
    const install = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    for (const [name, text] of [["bundle", bundle], ["install", install]] as const) {
      expect(text, name).toContain(`CADDY_IMAGE="${ref}"`);
      expect(text, name).toContain(`CADDY_TAG="${tag}"`);
      expect(text, name).not.toMatch(/caddy:2-alpine/);
    }
    // the same pinned image ids in both scripts: two platform config digests (classic store), the index digest and
    // the two platform manifest digests (containerd store)
    const ids = (text: string) => text.match(/\nCADDY_IMAGE_IDS="([^"]+)"\n/)?.[1]?.split(" ");
    expect(ids(bundle)).toEqual(ids(install));
    expect(ids(install)).toHaveLength(5);
    expect(new Set(ids(install)).size).toBe(5);
    for (const id of ids(install)!) expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ids(install)).toContain(ref.slice(ref.indexOf("@") + 1));
  });

  it("both Postgres services name the one digest-pinned postgres:16 reference; Keycloak's default is digest-pinned", () => {
    const m = compose.match(/\nx-postgres: &postgres\n {2}image: (\S+)\n/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^postgres:16@sha256:[0-9a-f]{64}$/);
    for (const svc of ["db", "keycloak-db-init"]) expect(block(svc), svc).toMatch(/\n {4}<<: \*postgres\n/);
    expect(compose).not.toMatch(/\n {4}image: postgres:/);
    expect(block("keycloak")).toMatch(/\n {4}image: \$\{REGULAIT_KC_IMAGE:-keycloak\/keycloak:26\.8\.0@sha256:[0-9a-f]{64}\}\n/);
    // air-gapped runs the bundle's plain tag (a digest reference does not survive docker save/load)
    const install = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    expect(install).toMatch(/\n {2}db:\n {4}image: postgres:16\n {4}pull_policy: never\n/);
  });

  it("air-gapped: the bundle saves the digest and the plain tag; the install runs the tag and checks its image id", () => {
    const bundle = readFileSync(path.join(root, "scripts/build-image-bundle.sh"), "utf8");
    expect(bundle).toMatch(/\ndocker tag "\$CADDY_IMAGE" "\$CADDY_TAG"\n/);
    expect(bundle).toMatch(/\ndocker save -o "\$OUT" "\$GATEWAY_IMAGE" postgres:16 "\$CADDY_IMAGE" "\$CADDY_TAG"( \$\{ENGINE_REFS\[@\]\+"\$\{ENGINE_REFS\[@\]\}"\})?\n/);
    const install = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    // the preflight looks for the tag and refuses an unpinned image id; the load step checks it again
    expect(install).toMatch(/for img in "\$GATEWAY_IMAGE" postgres:16 "\$CADDY_TAG"; do/);
    expect(install).toMatch(/image_present "\$CADDY_TAG" && ! caddy_image_id_ok/);
    expect(install).toMatch(/docker load -i "\$IMAGE_BUNDLE"\n {2}ok "images loaded"\n {2}if \[ "\$MODE" = "air_gapped" \]; then\n {4}caddy_image_id_ok \|\| die/);
    // every Caddy service runs the tag in the air-gapped override, never pulled
    for (const svc of ["caddy", "executor-front", "executor-front-ca"]) {
      expect(install).toContain(`\n  ${svc}:\n    image: $CADDY_TAG\n    pull_policy: never\n`);
    }
  });
});

/**
 * ENG-IMG (ADR-0190 "As built: engine task images") — what the engine image pipeline must keep true, pinned from the
 * files themselves (no Docker daemon or registry needed):
 *   - the publish workflow runs on push to main and workflow_dispatch only, never on pull_request; only its publish
 *     job may write packages, through GITHUB_TOKEN; every action is pinned by commit sha; nothing signs through the
 *     public-good Sigstore instance (signing is skipped with its reason logged);
 *   - the pull_request workflow only builds: no packages permission, no registry login, no push;
 *   - the air-gapped bundle carries the engine images only behind --with-engines, by the lock's digests, and the
 *     installer runs and checks the bundled tags.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
/** the YAML with its comment lines removed (the prose may name what the code must not do) */
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("ENG-IMG: the engine image workflows", () => {
  const publish = code(read(".github/workflows/engine-images.yml"));
  const build = code(read(".github/workflows/engine-images-build.yml"));

  it("publish: push to main and workflow_dispatch only; read-only by default; packages: write only on the publish job", () => {
    const on = publish.slice(publish.indexOf("\non:"), publish.indexOf("\npermissions:"));
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]\n/);
    expect(on).toMatch(/\n {2}workflow_dispatch:\n/);
    expect(on).not.toMatch(/pull_request/);
    expect(publish).toMatch(/\npermissions:\n {2}contents: read\n\n/);
    expect(publish.match(/packages: write/g)).toHaveLength(1);
    const jobPublish = publish.slice(publish.indexOf("\n  publish:"), publish.indexOf("\n  record:"));
    expect(jobPublish).toMatch(/permissions:\n {6}contents: read\n {6}packages: write\n/);
    expect(publish).not.toMatch(/id-token: write|attestations: write/);
    // the token is GITHUB_TOKEN, nothing else
    expect(publish.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.GITHUB_TOKEN"]);
  });

  it("publish: no public-good keyless signing; the sign step logs why it signs nothing", () => {
    expect(publish).not.toMatch(/\bcosign\b|actions\/attest|sigstore\/|gh attestation/i);
    expect(publish).toMatch(/name: Sign \(skipped, with the reason\)/);
    expect(publish).toMatch(/::notice title=engine image not signed::/);
  });

  it("every action in both workflows is pinned by a full commit sha", () => {
    for (const text of [publish, build]) {
      const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/);
    }
  });

  it("the pull_request run only builds: no packages permission, no login, no push", () => {
    expect(build).toMatch(/\non:\n {2}pull_request:\n/);
    expect(build).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(build).not.toMatch(/packages:|docker login|secrets\.|--push| push /);
    expect(build).toMatch(/scripts\/build-engine-image\.sh "\$\{\{ matrix\.engine \}\}" build/);
  });

  it("the build script pushes only to ghcr.io/<owner>/regulait-engine-<engine>, with no attestations, and records both digests", () => {
    const sh = read("scripts/build-engine-image.sh");
    expect(sh).toContain("--provenance=false --sbom=false");
    expect(sh).toContain('containerimage.digest');
    expect(sh).toContain('containerimage.config.digest');
    expect(sh).toMatch(/\^ghcr\\\.io\/\[a-z0-9\]\[a-z0-9-\]\{0,38\}\/regulait-engine-\$\{engine\}/);
    // no repository link label: the package would inherit the public repository's read access
    expect(sh).not.toContain("org.opencontainers.image.source");
  });
});

describe("ENG-IMG: engine images in the air-gapped bundle (opt-in)", () => {
  it("the bundle saves engine images only with --with-engines, from the lock, checked by id, under digest and tag", () => {
    const bundle = read("scripts/build-image-bundle.sh");
    expect(bundle).toMatch(/\n {4}--with-engines\) WITH_ENGINES=1; shift ;;\n/);
    expect(bundle).toMatch(/\nWITH_ENGINES=0\n/);
    expect(bundle).toMatch(/if \[ "\$WITH_ENGINES" = "1" \]; then/);
    expect(bundle).toContain('engines/images.lock.json');
    expect(bundle).toContain('tag="regulait/engine-${engine}:bundled"');
    expect(bundle).toContain('"$image_id" | "$digest") ok');
    expect(bundle).toContain('ENGINE_REFS+=("$ref" "$tag")');
  });

  it("the air-gapped install runs the bundled tags, never pulled, and checks each loaded tag against the lock", () => {
    const install = read("scripts/install.sh");
    for (const e of ["promptfoo", "modelscan", "garak"]) {
      expect(install).toContain(`\n  engine-${e}:\n    image: regulait/engine-${e}:bundled\n    pull_policy: never\n`);
    }
    expect(install).toMatch(/engine_bundled_id_ok "\$engine" \|\| die/);
  });
});

/**
 * ENG-IMG (ADR-0190 "As built: engine task images") — what the engine image pipeline must keep true, pinned from the
 * files themselves (no Docker daemon or registry needed):
 *   - the publish workflow runs on push to main and workflow_dispatch only, never on pull_request; only its publish
 *     job may write packages, through GITHUB_TOKEN; every action is pinned by commit sha;
 *   - ADR-0197 Q2: the publish job signs each pushed digest keylessly (cosign pinned by SHA-256, the job's OIDC token,
 *     Fulcio and Rekor; no key and no secret) in the `release` environment, and verifies it before the run ends;
 *   - N10: only the lock-pr job may write contents and pull requests (one branch, one draft HOLD PR);
 *   - the publish job runs only when the ref is main, so a workflow_dispatch from another branch publishes nothing;
 *   - the pull_request workflow only builds: no packages permission, no registry login, no push;
 *   - the runner artifact route is removed (the gateway streams an artifact only to the executor's input);
 *   - the air-gapped bundle carries the engine images only behind --with-engines, by the lock's digests, and the
 *     installer runs and checks the bundled tags, each by id AND by its keyless signature.
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

  it("publish: push to main and workflow_dispatch only; read-only by default; packages and id-token write only on the publish job", () => {
    const on = publish.slice(publish.indexOf("\non:"), publish.indexOf("\npermissions:"));
    expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]\n/);
    expect(on).toMatch(/\n {2}workflow_dispatch:\n/);
    expect(on).not.toMatch(/pull_request/);
    expect(publish).toMatch(/\npermissions:\n {2}contents: read\n\n/);
    expect(publish.match(/packages: write/g)).toHaveLength(1);
    expect(publish.match(/id-token: write/g)).toHaveLength(1);
    const jobPublish = publish.slice(publish.indexOf("\n  publish:"), publish.indexOf("\n  record:"));
    expect(jobPublish).toMatch(/permissions:\n {6}contents: read\n {6}packages: write\n {6}id-token: write\n/);
    expect(publish).not.toMatch(/attestations: write/);
    // the only write to contents and pull requests is the lock-pr job's
    const jobLockPr = publish.slice(publish.indexOf("\n  lock-pr:"));
    expect(publish.match(/contents: write|pull-requests: write/g)).toHaveLength(2);
    expect(jobLockPr).toMatch(/permissions:\n {6}contents: write\n {6}pull-requests: write\n/);
    // the token is GITHUB_TOKEN, nothing else
    for (const s of publish.match(/secrets\.[A-Z_]+/g) ?? []) expect(s).toBe("secrets.GITHUB_TOKEN");
  });

  it("publish: only main publishes, whatever the trigger (a manual dispatch can start on any branch)", () => {
    const jobPublish = publish.slice(publish.indexOf("\n  publish:"), publish.indexOf("\n  record:"));
    expect(jobPublish).toMatch(/\n {4}if: github\.ref == 'refs\/heads\/main'\n/);
    // the record and lock-pr jobs run only after publish, so they are skipped with it
    const jobRecord = publish.slice(publish.indexOf("\n  record:"), publish.indexOf("\n  lock-pr:"));
    expect(jobRecord).toMatch(/\n {4}needs: publish\n/);
    expect(publish.slice(publish.indexOf("\n  lock-pr:"))).toMatch(/\n {4}needs: record\n/);
    expect(publish.slice(publish.indexOf("\n  record:"))).not.toMatch(/\n {4}if:/);
  });

  it("publish: ADR-0197 Q2 keyless signing in the release environment, cosign pinned, no key or secret, verified before the run ends", () => {
    const jobPublish = publish.slice(publish.indexOf("\n  publish:"), publish.indexOf("\n  record:"));
    expect(jobPublish).toMatch(/\n {4}environment: release\n/);
    expect(jobPublish).toContain("https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64");
    expect(jobPublish).toContain('echo "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71  $RUNNER_TEMP/bin/cosign" | sha256sum -c -');
    expect(jobPublish).toContain('"$RUNNER_TEMP/bin/cosign" sign --yes -a "imageId=${image_id}" -a "sourceCommit=${GITHUB_SHA}" --bundle "$bundle" "$ref"');
    expect(jobPublish).toContain("node scripts/engine-images-lock-verify.mjs --signed");
    expect(publish).not.toMatch(/--key\b|COSIGN_PRIVATE_KEY|COSIGN_PASSWORD|actions\/attest|gh attestation|--tlog-upload=false/);
    expect(publish).not.toMatch(/name: Sign \(skipped/);
  });

  it("N10: lock-pr opens one draft PR whose title must start with HOLD, and nothing merges it or marks it ready", () => {
    const jobLockPr = publish.slice(publish.indexOf("\n  lock-pr:"));
    expect(jobLockPr).toContain('gh pr create --draft --base main --head "$branch" --title "$title"');
    expect(jobLockPr.match(/gh pr create/g)).toHaveLength(1);
    // the HOLD refusal runs before anything is committed or pushed
    const refusal = jobLockPr.indexOf('case "$title" in "HOLD "*) ;; *) echo "::error::the lock PR title must start with HOLD"; exit 1 ;; esac');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(jobLockPr.indexOf("git commit "));
    expect(refusal).toBeLessThan(jobLockPr.indexOf("push origin "));
    expect(publish).not.toMatch(/gh pr (merge|ready)|--auto\b|enable-auto-merge|automerge|auto-merge/i);
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
    // ADR-0197 Q2: an image whose signature does not verify is never bundled
    expect(bundle).toContain('node "$REPO_ROOT/scripts/engine-images-lock-verify.mjs" --engine "$engine" || die');
  });

  it("the air-gapped install runs the bundled tags, never pulled, and checks each loaded tag against the lock", () => {
    const install = read("scripts/install.sh");
    for (const e of ["promptfoo", "modelscan", "garak"]) {
      expect(install).toContain(`\n  engine-${e}:\n    image: regulait/engine-${e}:bundled\n    pull_policy: never\n`);
    }
    expect(install).toMatch(/engine_bundled_id_ok "\$engine" \|\| die/);
    // ADR-0197 Q2: and by its keyless signature, offline, failing closed
    expect(install).toMatch(/engine_signature_ok "\$engine" \|\| die/);
    expect(install).toContain('node "$SCRIPT_DIR/engine-images-lock-verify.mjs" --engine "$1"');
    // the lock is read as JSON with node (as the bundle script does), never by line layout
    const start = install.indexOf("engine_bundled_id_ok() {");
    const fn = install.slice(start, install.indexOf("\n}\n", start));
    expect(fn).toContain("JSON.parse(");
    expect(fn).toContain('engines/images.lock.json" "$1"');
    expect(fn).not.toMatch(/grep -A/);
  });
});

describe("ENG-IMG review: the runner artifact route is removed (secure by default)", () => {
  it("no runner route, no registration, no client call", () => {
    const route = "/v1/engine-runner/artifacts/";
    expect(read("packages/shared/src/engines/contract.ts")).not.toContain(`GET ${route}`);
    expect(read("apps/gateway/src/model-artifacts.ts")).not.toMatch(/app\.get\("\/v1\/engine-runner\/artifacts/);
    expect(read("apps/gateway/src/openapi-registry.ts")).not.toContain(`GET ${route}`);
    expect(read("packages/engine-runner/src/runner.ts")).not.toContain(route);
  });
});

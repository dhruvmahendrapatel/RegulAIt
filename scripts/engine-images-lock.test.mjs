/**
 * ENG-IMG — the engine image lock: the committed lock is valid, its derived files are current (CI's `--check`), and
 * `--apply` records a publish only in the shape the workflow writes, moving the generation with every new build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPublish, assertCommitOnMain, ENGINE_IDS, GHCR_OWNER, LockError, PATHS, renderCompose, renderTs, repositoryOwner, UNSET_DIGEST, validateLock } from "./engine-images-lock.mjs";

const lock = () => JSON.parse(readFileSync(PATHS.lock, "utf8"));
/** the committed lock with every engine unpublished (the apply tests start from no publish, whatever is recorded) */
const blank = () => {
  const l = lock();
  for (const id of ENGINE_IDS) l.engines[id] = { repository: null, manifestDigest: null, imageId: null, publishGeneration: 0, sourceCommit: null, publishedAt: null };
  return l;
};
const hex = (c) => `sha256:${c.repeat(64)}`;
const commit = "a".repeat(40);
const publish = (engines, sourceCommit = commit) => ({ sourceCommit, publishedAt: "2026-10-17T05:00:00.000Z", engines });
const entry = (id, d = "1", i = "2") => ({ repository: `ghcr.io/${GHCR_OWNER}/regulait-engine-${id}`, manifestDigest: hex(d), imageId: hex(i) });

describe("ENG-IMG engine image lock", () => {
  it("the committed lock is valid, and the generated module and compose defaults are derived from it", () => {
    const l = validateLock(lock());
    expect(readFileSync(PATHS.ts, "utf8")).toBe(renderTs(l));
    const compose = readFileSync(PATHS.compose, "utf8");
    expect(renderCompose(compose, l)).toBe(compose);
  });

  it("until the first publish every entry is null and compose keeps the all-zero placeholder (placement refuses)", () => {
    const l = lock();
    for (const id of ENGINE_IDS) {
      if (l.engines[id].manifestDigest !== null) continue;
      expect(l.engines[id]).toEqual({ repository: null, manifestDigest: null, imageId: null, publishGeneration: 0, sourceCommit: null, publishedAt: null });
      expect(readFileSync(PATHS.compose, "utf8")).toContain(`\${REGULAIT_ENGINE_${id.toUpperCase()}_DIGEST:-${UNSET_DIGEST}}`);
    }
  });

  it("a publish fills the entry, bumps its generation once per new build, and leaves other engines alone", () => {
    const first = applyPublish(blank(), publish({ modelscan: entry("modelscan") }));
    expect(first.engines.modelscan).toMatchObject({ ...entry("modelscan"), publishGeneration: 1, sourceCommit: commit });
    expect(first.engines.garak).toEqual(blank().engines.garak);
    // the same digests again: no new build, no new generation
    const same = applyPublish(first, publish({ modelscan: entry("modelscan") }, "b".repeat(40)));
    expect(same.engines.modelscan).toMatchObject({ publishGeneration: 1, sourceCommit: commit });
    const next = applyPublish(first, publish({ modelscan: entry("modelscan", "3", "4") }, "b".repeat(40)));
    expect(next.engines.modelscan).toMatchObject({ publishGeneration: 2, sourceCommit: "b".repeat(40), manifestDigest: hex("3") });
    // the derived files follow
    expect(renderTs(next)).toContain(`manifestDigest: "${hex("3")}"`);
    const compose = renderCompose(readFileSync(PATHS.compose, "utf8"), next);
    expect(compose).toContain(`\${REGULAIT_ENGINE_MODELSCAN_DIGEST:-${hex("3")}}`);
    expect(compose).toContain(`\${REGULAIT_ENGINE_MODELSCAN_REPOSITORY:-ghcr.io/${GHCR_OWNER}/regulait-engine-modelscan}`);
    expect(compose).not.toContain(`\${REGULAIT_ENGINE_MODELSCAN_DIGEST:-${UNSET_DIGEST}}`);
  });

  it("refuses anything but the workflow's shape: another repository, a tag, the zero digest, an unknown engine, a partial entry", () => {
    const bad = [
      publish({ modelscan: { ...entry("modelscan"), repository: "docker.io/x/regulait-engine-modelscan" } }),
      publish({ modelscan: { ...entry("modelscan"), repository: `ghcr.io/${GHCR_OWNER.toUpperCase()}/regulait-engine-modelscan` } }),
      publish({ modelscan: { ...entry("modelscan"), repository: `ghcr.io/${GHCR_OWNER}/regulait-engine-garak` } }),
      // another namespace (a fork, or anyone else) is refused: the owner is pinned to this repository's
      publish({ modelscan: { ...entry("modelscan"), repository: "ghcr.io/someone-else/regulait-engine-modelscan" } }),
      publish({ modelscan: { ...entry("modelscan"), manifestDigest: "latest" } }),
      publish({ modelscan: { ...entry("modelscan"), imageId: UNSET_DIGEST } }),
      publish({ other: entry("other") }),
      publish({ modelscan: entry("modelscan") }, "abc"),
      publish({}),
    ];
    for (const p of bad) expect(() => applyPublish(blank(), p)).toThrow(LockError);
    const partial = blank();
    partial.engines.garak.manifestDigest = hex("5");
    expect(() => validateLock(partial)).toThrow(/all null/);
  });

  it("the GHCR owner is this repository's owner, read from package.json repository and lowercased", () => {
    const pkg = JSON.parse(readFileSync(PATHS.pkg, "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
    const owner = /github\.com\/([^/]+)\//.exec(url)[1].toLowerCase();
    expect(GHCR_OWNER).toBe(owner);
    expect(repositoryOwner({ repository: { url: "git+https://github.com/Some-Owner/RegulAIt.git" } })).toBe("some-owner");
    expect(repositoryOwner({ repository: "https://github.com/acme/regulait" })).toBe("acme");
    for (const bad of [{}, { repository: "https://gitlab.com/acme/regulait" }, { repository: { url: "git@github.com:acme/regulait.git" } }]) {
      expect(() => repositoryOwner(bad)).toThrow(LockError);
    }
  });

  it("--apply records only a build of a commit reachable from origin/main", () => {
    const seen = [];
    assertCommitOnMain(commit, { git: (args) => seen.push(args) });
    expect(seen).toEqual([["merge-base", "--is-ancestor", commit, "origin/main"]]);
    const refuse = () => {
      throw new Error("exit 1");
    };
    expect(() => assertCommitOnMain(commit, { git: refuse })).toThrow(/not reachable from origin\/main/);
    expect(() => assertCommitOnMain("abc", { git: () => undefined })).toThrow(LockError);
    expect(() => assertCommitOnMain(undefined, { git: () => undefined })).toThrow(LockError);
  });
});

/**
 * ENG-IMG — the engine image lock: the committed lock is valid, its derived files are current (CI's `--check`), and
 * `--apply` records a publish only in the shape the workflow writes, moving the generation with every new build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPublish, assertCommitOnMain, checkLockTransition, ENGINE_IDS, GHCR_OWNER, LockError, PATHS, readLockAt, renderCompose, renderTs, repositoryOwner, UNSET_DIGEST, validateLock } from "./engine-images-lock.mjs";

const lock = () => JSON.parse(readFileSync(PATHS.lock, "utf8"));
const hex = (c) => `sha256:${c.repeat(64)}`;
const commit = "a".repeat(40);
const publish = (engines, sourceCommit = commit) => ({ sourceCommit, publishedAt: "2026-10-17T05:00:00.000Z", engines });
/** the never-published lock: every entry null */
const blank = () => ({
  schema: "regulait.engine-images-lock.v1",
  engines: Object.fromEntries(ENGINE_IDS.map((id) => [id, { repository: null, manifestDigest: null, imageId: null, publishGeneration: 0, sourceCommit: null, publishedAt: null }])),
});
const entry = (id, d = "1", i = "2") => ({ repository: `ghcr.io/${GHCR_OWNER}/regulait-engine-${id}`, manifestDigest: hex(d), imageId: hex(i) });

describe("ENG-IMG engine image lock", () => {
  it("the committed lock is valid, and the generated module and compose defaults are derived from it", () => {
    const l = validateLock(lock());
    expect(readFileSync(PATHS.ts, "utf8")).toBe(renderTs(l));
    const compose = readFileSync(PATHS.compose, "utf8");
    expect(renderCompose(compose, l)).toBe(compose);
  });

  it("an unpublished entry renders the all-zero placeholder in compose (placement refuses)", () => {
    // asked of a blank lock, so it holds whatever the committed lock records (#425 review: the committed lock's
    // entries may all be published, and a loop over them would then assert nothing)
    const compose = renderCompose(readFileSync(PATHS.compose, "utf8"), blank());
    for (const id of ENGINE_IDS) expect(compose).toContain(`\${REGULAIT_ENGINE_${id.toUpperCase()}_DIGEST:-${UNSET_DIGEST}}`);
    expect(validateLock(blank())).toEqual(blank());
  });

  it("a publish fills the entry, bumps its generation once per new build, and leaves other engines alone", () => {
    const first = applyPublish(lock(), publish({ modelscan: entry("modelscan") }));
    expect(first.engines.modelscan).toMatchObject({ ...entry("modelscan"), publishGeneration: 1, sourceCommit: commit });
    expect(first.engines.garak).toEqual(lock().engines.garak);
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
    for (const p of bad) expect(() => applyPublish(lock(), p)).toThrow(LockError);
    const partial = lock();
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

  describe("#425 review: the lock against main's copy (main-only and generation rules hold without --apply)", () => {
    const published = () => applyPublish(blank(), publish({ garak: entry("garak") }));
    const onMain = (main) => (c) => {
      if (!main.includes(c)) throw new LockError(`${c} is not reachable from origin/main`);
    };

    it("accepts what --apply writes: a new build one generation up, of a commit on main", () => {
      expect(checkLockTransition(blank(), published(), { onMain: onMain([commit]) })).toEqual(published());
      const next = applyPublish(published(), publish({ garak: entry("garak", "3", "4") }, "b".repeat(40)));
      expect(checkLockTransition(published(), next, { onMain: onMain([commit, "b".repeat(40)]) })).toEqual(next);
      // an unchanged lock is unchanged
      expect(checkLockTransition(published(), published(), { onMain: onMain([commit]) })).toEqual(published());
    });

    it("refuses the reviewer's hand edit: a new digest from a branch commit, publishGeneration left as it was", () => {
      const edited = published();
      Object.assign(edited.engines.garak, { manifestDigest: hex("6"), sourceCommit: "c".repeat(40) });
      // the edit is a valid lock on its own (so --write and the derived-file check pass) ...
      expect(validateLock(edited)).toBe(edited);
      // ... and is refused against main: the branch commit is not on main
      expect(() => checkLockTransition(published(), edited, { onMain: onMain([commit]) })).toThrow(/not reachable from origin\/main/);
      // with the commit on main, the generation that did not move is refused
      expect(() => checkLockTransition(published(), edited, { onMain: onMain([commit, "c".repeat(40)]) })).toThrow(/exactly 2/);
      // a generation moved by more than one is refused too
      edited.engines.garak.publishGeneration = 3;
      expect(() => checkLockTransition(published(), edited, { onMain: onMain([commit, "c".repeat(40)]) })).toThrow(/exactly 2/);
    });

    it("refuses an engine whose image did not change but whose entry did", () => {
      const edited = published();
      edited.engines.garak.publishGeneration = 2;
      expect(() => checkLockTransition(published(), edited, { onMain: onMain([commit]) })).toThrow(/keeps its whole entry/);
    });

    it("every published sourceCommit is asked about, changed or not", () => {
      const asked = [];
      checkLockTransition(published(), published(), { onMain: (c) => asked.push(c) });
      expect(asked).toEqual([commit]);
    });

    it("reads the base lock from git at the ref", () => {
      const seen = [];
      const base = readLockAt("origin/main", { git: (args) => (seen.push(args), JSON.stringify(blank())) });
      expect(base).toEqual(blank());
      expect(seen).toEqual([["show", "origin/main:engines/images.lock.json"]]);
    });
  });
});

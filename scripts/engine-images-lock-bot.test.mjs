/**
 * N10 — the lock-update bot: `--apply` records only a signed publish, and the bot's PR is the lock transition CI
 * accepts, opened as a draft HOLD PR that stages only the files `--apply` writes. The workflow job holds only
 * GITHUB_TOKEN-scoped contents/pull-requests write and never merges.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lockPr, prPaths } from "./engine-images-lock-bot.mjs";
import { bundleFor } from "./engine-images-lock-fixtures.mjs";
import { applyPublish, applySignedPublish, checkCommittedSignatures, checkLockTransition, ENGINE_IDS, GHCR_OWNER, LockError, PATHS, prepareApply } from "./engine-images-lock.mjs";
import { expectedIdentity } from "./engine-images-lock-verify.mjs";

const hex = (c) => `sha256:${c.repeat(64)}`;
const c1 = "a".repeat(40);
const c2 = "b".repeat(40);
const blank = () => {
  const l = JSON.parse(readFileSync(PATHS.lock, "utf8"));
  for (const id of ENGINE_IDS) l.engines[id] = { repository: null, manifestDigest: null, imageId: null, publishGeneration: 0, sourceCommit: null, publishedAt: null };
  return l;
};
const img = (id, d, i) => ({ repository: `ghcr.io/${GHCR_OWNER}/regulait-engine-${id}`, manifestDigest: hex(d), imageId: hex(i) });
/** a publish as the record job writes it: each engine with its signature record */
const signedPublish = (engines, sourceCommit, publishedAt) => ({
  sourceCommit,
  publishedAt,
  engines: Object.fromEntries(
    Object.entries(engines).map(([id, e]) => [
      id,
      { ...e, signature: { bundle: bundleFor({ ...e, sourceCommit }), certificateIdentity: expectedIdentity(), certificateOidcIssuer: "https://token.actions.githubusercontent.com", workflowRef: "refs/heads/main", rekor: { logIndex: "4242", logId: "x", integratedTime: "1" } } },
    ]),
  ),
});
const onMain = () => undefined;
/** the committed bundles after an apply: what `--apply` wrote for each engine */
const bundlesOf = (...applied) => (id) => applied.map((a) => a.bundles[id]).filter(Boolean).at(-1);

describe("N10: --apply records only a signed publish", () => {
  const accept = () => undefined;

  it("a publish whose engines are all signed is applied; the bundles of the changed engines are returned", () => {
    const p = signedPublish({ garak: img("garak", "1", "2"), modelscan: img("modelscan", "3", "4") }, c1, "2026-10-18T05:00:00.000Z");
    const seen = [];
    const out = applySignedPublish(blank(), p, { verify: (id, e) => seen.push([id, e]) });
    expect(seen).toEqual([
      ["garak", { ...img("garak", "1", "2"), sourceCommit: c1 }],
      ["modelscan", { ...img("modelscan", "3", "4"), sourceCommit: c1 }],
    ]);
    expect(out.lock).toEqual(applyPublish(blank(), p));
    expect(Object.keys(out.bundles).sort()).toEqual(["garak", "modelscan"]);
    // the same digests again change nothing, so no bundle is rewritten
    expect(applySignedPublish(out.lock, signedPublish({ garak: img("garak", "1", "2") }, c2, "2026-10-19T05:00:00.000Z"), { verify: accept }).bundles).toEqual({});
  });

  it("an unsigned engine, or one whose signature does not verify, stops the whole apply", () => {
    const p = signedPublish({ garak: img("garak", "1", "2") }, c1, "2026-10-18T05:00:00.000Z");
    delete p.engines.garak.signature;
    expect(() => applySignedPublish(blank(), p, { verify: accept })).toThrow(/carries no signature/);
    const q = signedPublish({ garak: img("garak", "1", "2") }, c1, "2026-10-18T05:00:00.000Z");
    expect(() =>
      applySignedPublish(blank(), q, {
        verify: () => {
          throw new Error("wrong identity");
        },
      }),
    ).toThrow(LockError);
  });
});

describe("#437 review: the --apply and --check signature gates of the CLI", () => {
  const p = () => signedPublish({ garak: img("garak", "1", "2") }, c1, "2026-10-18T05:00:00.000Z");
  const accept = () => undefined;
  /** a lock where modelscan is already published and signed, so --apply keeps its signature */
  const withModelscan = () => applySignedPublish(blank(), signedPublish({ modelscan: img("modelscan", "3", "4") }, c2, "2026-10-17T05:00:00.000Z"), { verify: accept });

  it("--apply refuses without a trusted root, before the publish or its signatures are looked at", () => {
    const touched = [];
    const spy = (what) => () => touched.push(what);
    for (const trustedRoot of [undefined, ""]) {
      expect(() => prepareApply(blank(), p(), { trustedRoot, verify: spy("verify"), verifyKept: spy("kept"), onMain: spy("onMain") })).toThrow(/needs --trusted-root/);
    }
    expect(touched).toEqual([]);
  });

  it("--apply asks that the publish is of a commit on main", () => {
    const seen = [];
    prepareApply(blank(), p(), { trustedRoot: "root.json", verify: accept, verifyKept: accept, bundleFor: () => undefined, onMain: (c) => seen.push(c) });
    expect(seen).toEqual([c1]);
    expect(() =>
      prepareApply(blank(), p(), {
        trustedRoot: "root.json",
        verify: accept,
        onMain: () => {
          throw new LockError("not on main");
        },
      }),
    ).toThrow(/not on main/);
  });

  it("--apply re-verifies every kept signature against the new root, and refuses when one fails", () => {
    const base = withModelscan();
    const kept = [];
    const out = prepareApply(base.lock, p(), { trustedRoot: "root.json", verify: accept, verifyKept: (id, e) => kept.push([id, e]), bundleFor: bundlesOf(base), onMain });
    expect(kept).toEqual([["modelscan", base.lock.engines.modelscan]]);
    expect(Object.keys(out.bundles)).toEqual(["garak"]);
    expect(() =>
      prepareApply(base.lock, p(), {
        trustedRoot: "root.json",
        verify: accept,
        verifyKept: () => {
          throw new Error("does not verify against the new root");
        },
        bundleFor: bundlesOf(base),
        onMain,
      }),
    ).toThrow(/new root/);
  });

  it("--check reports an unsigned entry, accepts a bundle of its entry, and refuses a bundle of another digest", () => {
    const base = withModelscan();
    const log = [];
    expect(checkCommittedSignatures(base.lock, { bundleFor: () => undefined, log: (m) => log.push(m) })).toEqual(["modelscan"]);
    expect(log.join("\n")).toMatch(/modelscan has no signature/);
    expect(checkCommittedSignatures(base.lock, { bundleFor: bundlesOf(base), log: () => undefined })).toEqual([]);
    const forged = bundleFor({ ...img("modelscan", "9", "4"), sourceCommit: c2 });
    expect(() => checkCommittedSignatures(base.lock, { bundleFor: () => forged, log: () => undefined })).toThrow(/modelscan: .*tampered digest/);
  });
});

describe("N10: the bot's PR is the lock transition CI accepts", () => {
  const first = signedPublish({ promptfoo: img("promptfoo", "1", "2"), modelscan: img("modelscan", "3", "4"), garak: img("garak", "5", "6") }, c1, "2026-10-18T05:00:00.000Z");
  const a1 = applySignedPublish(blank(), first, { verify: () => undefined });

  it("first signed publish: every engine moves to generation 1, the PR is a HOLD draft that stages only --apply's files", () => {
    const pr = lockPr(blank(), a1.lock, first, { onMain, bundleFor: bundlesOf(a1) });
    expect(pr.changed).toEqual(ENGINE_IDS);
    for (const id of ENGINE_IDS) expect(a1.lock.engines[id]).toMatchObject({ publishGeneration: 1, sourceCommit: c1 });
    expect(pr.title).toBe(`HOLD chore(engines): record the signed engine image publish of ${c1.slice(0, 12)}`);
    expect(pr.branch).toBe(`engine-images-lock/${c1.slice(0, 12)}`);
    expect(pr.paths).toEqual(prPaths(ENGINE_IDS));
    expect(pr.paths).toEqual([
      "engines/images.lock.json",
      "packages/shared/src/engines/images-lock.ts",
      "docker-compose.yml",
      "engines/signatures/trusted_root.json",
      "engines/signatures/promptfoo.sigstore.json",
      "engines/signatures/modelscan.sigstore.json",
      "engines/signatures/garak.sigstore.json",
    ]);
    expect(pr.body).toContain(expectedIdentity());
    expect(pr.body).toMatch(/\| garak \| `sha256:5{64}` \| 0 -> 1 \| 4242 \|/);
  });

  it("a later publish changing one engine moves only that engine's generation, by exactly one", () => {
    const second = signedPublish({ garak: img("garak", "7", "8"), modelscan: img("modelscan", "3", "4") }, c2, "2026-10-19T05:00:00.000Z");
    const a2 = applySignedPublish(a1.lock, second, { verify: () => undefined });
    const pr = lockPr(a1.lock, a2.lock, second, { onMain, bundleFor: bundlesOf(a1, a2) });
    expect(pr.changed).toEqual(["garak"]);
    expect(a2.lock.engines.garak).toMatchObject({ publishGeneration: 2, sourceCommit: c2, manifestDigest: hex("7") });
    expect(a2.lock.engines.modelscan).toEqual(a1.lock.engines.modelscan);
    expect(pr.paths).toEqual(prPaths(["garak"]));
    expect(checkLockTransition(a1.lock, a2.lock, { onMain, bundleFor: bundlesOf(a1, a2) })).toEqual(a2.lock);
  });

  it("no image changed: no PR", () => {
    expect(lockPr(a1.lock, a1.lock, first, { onMain, bundleFor: bundlesOf(a1) })).toBeNull();
  });

  it("CI refuses a new image without its signature, or with a signature of another digest", () => {
    expect(() => checkLockTransition(blank(), a1.lock, { onMain, bundleFor: () => undefined })).toThrow(/carries its signature/);
    const other = bundleFor({ ...img("garak", "9", "6"), sourceCommit: c1 });
    expect(() => checkLockTransition(blank(), a1.lock, { onMain, bundleFor: (id) => (id === "garak" ? other : a1.bundles[id]) })).toThrow(/garak: .*tampered digest/);
    expect(() => lockPr(blank(), a1.lock, first, { onMain, bundleFor: () => undefined })).toThrow(LockError);
  });
});

describe("N10: the workflow job", () => {
  const wf = readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "engine-images.yml"), "utf8");
  const job = wf.slice(wf.indexOf("\n  lock-pr:"));

  it("holds only contents write, through GITHUB_TOKEN; never merges, approves, readies or auto-merges", () => {
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: write\n {4}steps:/);
    expect(job).not.toContain("pull-requests:");
    expect(job).toMatch(/\n {4}needs: record\n/);
    expect(job.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.GITHUB_TOKEN"]);
    expect(job).not.toMatch(/gh pr (merge|ready|review)|--auto|enable_pr_auto_merge|auto-merge:|--approve/);
    expect(job).toMatch(/case "\$title" in "HOLD "\*\) ;;/);
    const code = job.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/git add (-A|\.|--all)/);
    // the trusted root is fetched by the job itself, not taken from the artifact
    expect(job).toMatch(/cosign" initialize/);
    expect(job).toContain('--trusted-root "$root"');
  });

  it("is push-only (owner decision, 2026-10-21): no `gh pr create`; the summary names the compare URL, title and body", () => {
    const code = job.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(wf).not.toContain("gh pr create");
    expect(code).not.toMatch(/\bgh (pr|api)\b/);
    expect(job).toContain("https://github.com/${REPOSITORY}/compare/main...${branch}?expand=1");
    expect(job).toContain("REPOSITORY: ${{ github.repository }}");
    expect(job).toMatch(/PR title: \\`\$\{title\}\\`/);
    expect(job).toContain('cat "$pr/body.md"');
    expect(job).toContain(">> \"$GITHUB_STEP_SUMMARY\"");
    // one branch per source commit, only under engine-images-lock/, pushed without force
    expect(job).toContain('[ "$branch" = "engine-images-lock/${GITHUB_SHA:0:12}" ]');
    expect(job).toContain('push origin "HEAD:refs/heads/${branch}"');
    expect(code).not.toMatch(/push[^\n]*(--force|-f\b|\+HEAD|\+refs)/);
  });

  it("merging the bot's PR does not publish again (the lock and signatures are excluded from the push trigger)", () => {
    const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
    expect(on).toContain("- '!engines/images.lock.json'");
    expect(on).toContain("- '!engines/signatures/**'");
    // negations come after the positive pattern they narrow
    expect(on.indexOf("- engines/**")).toBeLessThan(on.indexOf("'!engines/images.lock.json'"));
  });
});

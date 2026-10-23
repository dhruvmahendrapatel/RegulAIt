#!/usr/bin/env node
/**
 * N10 (ADR-0197 work plan P2; ADR-0190 "As built: engine image signing") — THE LOCK-UPDATE BOT'S PULL REQUEST.
 *
 * After a signed publish on main, the `lock-pr` job of `.github/workflows/engine-images.yml` runs
 * `engine-images-lock.mjs --apply` and then this script, which compares the lock at HEAD (main at the published
 * commit's run) with the one `--apply` wrote. When an image changed, it writes the PR's branch, title and body; the
 * job only pushes the branch (push-only, owner decision on #453, 2026-10-21) and the master session opens the PR as a
 * DRAFT whose title starts with "HOLD". Automation never merges, never marks the PR ready and never enables
 * auto-merge: the master session releases it (the 2026-10-17/18 merge rules).
 *
 *   node scripts/engine-images-lock-bot.mjs --pr <publish.json> <out-dir>
 *        writes <out-dir>/changed ("true"/"false"), branch, title, body.md and paths (the files to stage, one per line)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLockTransition, ENGINE_IDS, LockError, PATHS, readLockAt, validateLock } from "./engine-images-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** the files `--apply` may change, repository-relative: what the job stages, by path (never `git add -A`) */
export function prPaths(changed) {
  return [
    "engines/images.lock.json",
    "packages/shared/src/engines/images-lock.ts",
    "docker-compose.yml",
    "engines/signatures/trusted_root.json",
    ...changed.map((id) => `engines/signatures/${id}.sigstore.json`),
  ];
}

/**
 * The PR for the lock transition base -> next, or null when no image changed. The transition must pass
 * `checkLockTransition` (the same rule CI applies to the PR), so the bot never opens a PR CI would refuse.
 */
export function lockPr(base, next, publish, opts = {}) {
  validateLock(base);
  validateLock(next);
  const changed = ENGINE_IDS.filter((id) => JSON.stringify(base.engines[id]) !== JSON.stringify(next.engines[id]));
  if (changed.length === 0) return null;
  checkLockTransition(base, next, opts);
  const short = publish.sourceCommit.slice(0, 12);
  const rows = changed.map((id) => {
    const e = next.engines[id];
    const s = publish.engines[id].signature;
    return `| ${id} | \`${e.manifestDigest}\` | ${base.engines[id].publishGeneration} -> ${e.publishGeneration} | ${s.rekor.logIndex} |`;
  });
  const identity = publish.engines[changed[0]].signature.certificateIdentity;
  const body = [
    `Records the signed engine image publish of \`${publish.sourceCommit}\` (\`engine-images-lock.mjs --apply\`, run by the \`lock-pr\` job).`,
    "",
    "| engine | manifest digest | generation | Rekor log index |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Every signature was verified by cosign before the lock branch was pushed: certificate identity \`${identity}\`, OIDC issuer \`https://token.actions.githubusercontent.com\`, against the committed Sigstore trusted root.`,
    "",
    `Pushed by the \`lock-pr\` job as \`engine-images-lock/${short}\` and opened as a draft HOLD PR by the master session (owner decision on #453, 2026-10-21; see ADR-0190, As built: the lock-pr job is push-only). Automation never merges, approves, marks it ready or enables auto-merge.`,
  ].join("\n");
  return {
    changed,
    branch: `engine-images-lock/${short}`,
    title: `HOLD chore(engines): record the signed engine image publish of ${short}`,
    body,
    paths: prPaths(changed),
  };
}

function main(argv) {
  const [mode, publishFile, outDir] = argv;
  if (mode !== "--pr" || !publishFile || !outDir) {
    console.error("usage: engine-images-lock-bot.mjs --pr <publish.json> <out-dir>");
    return 2;
  }
  const publish = JSON.parse(readFileSync(publishFile, "utf8"));
  const base = readLockAt("HEAD", { git: (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }) });
  const next = validateLock(JSON.parse(readFileSync(PATHS.lock, "utf8")));
  const pr = lockPr(base, next, publish);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "changed"), pr ? "true" : "false");
  if (!pr) {
    console.log("engine image lock bot: no image changed, no PR");
    return 0;
  }
  writeFileSync(path.join(outDir, "branch"), pr.branch);
  writeFileSync(path.join(outDir, "title"), pr.title);
  writeFileSync(path.join(outDir, "body.md"), `${pr.body}\n`);
  writeFileSync(path.join(outDir, "paths"), `${pr.paths.join("\n")}\n`);
  console.log(`engine image lock bot: ${pr.changed.join(", ")} changed; PR "${pr.title}" from ${pr.branch}`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`engine image lock bot: ${e instanceof LockError || e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

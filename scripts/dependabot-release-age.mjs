#!/usr/bin/env node
// Dependabot auto-merge age gate (#746 review finding 1, ADR-0180 fail closed).
//
// Dependabot's `cooldown` holds back VERSION updates only; a security-update PR ignores it, and pnpm's
// `minimumReleaseAge` cannot be set (it breaks `pnpm deploy --legacy` in every engine image build). So before a patch
// update is queued, every version it moves to must have been published at least MIN_DAYS ago. Anything else (a
// version too young, a lookup that fails, a date that cannot be read, an empty or unreadable update list) means the
// PR is NOT queued and waits for a reviewer.
//
// Sources: npm versions from the registry's publish time (`npm view <name> time --json`); GitHub Actions versions
// from the GitHub release's `published_at` (tag `v<version>`, then `<version>`). A tag without a release is refused:
// a tag's commit date can be set to anything.
//
// usage (from .github/workflows/dependabot-auto-merge.yml):
//   UPDATED_DEPS='<fetch-metadata updated-dependencies-json>' ECOSYSTEM=npm_and_yarn|github_actions \
//     node scripts/dependabot-release-age.mjs
// writes `old_enough=true|false` to $GITHUB_OUTPUT and the reasons to $GITHUB_STEP_SUMMARY. Exit 0 either way; the
// workflow queues the PR only on an exact `true`.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** publish time of an npm version, from the registry */
export function npmPublished(name, version, run = execFileSync) {
  const times = JSON.parse(run("npm", ["view", name, "time", "--json"], { encoding: "utf8" }));
  return times?.[version];
}

/** publish time of a GitHub Action version: its release's published_at (owner/repo[/path]) */
export function actionPublished(name, version, run = execFileSync) {
  const [owner, repo] = name.split("/");
  if (!owner || !repo) throw new Error(`not an owner/repo action: ${name}`);
  const v = String(version).replace(/^v/, "");
  for (const tag of [`v${v}`, v]) {
    try {
      const out = run("gh", ["api", `repos/${owner}/${repo}/releases/tags/${tag}`, "--jq", ".published_at"], { encoding: "utf8" }).trim();
      if (out && out !== "null") return out;
    } catch {
      // no release under this tag spelling: try the next one
    }
  }
  throw new Error(`no GitHub release for ${name}@${version}`);
}

/**
 * Decide whether every update is old enough.
 * @param {string|undefined} depsJson fetch-metadata's updated-dependencies-json
 * @param {string|undefined} ecosystem fetch-metadata's package-ecosystem
 * @param {{now?: number, minDays?: number, lookup?: (eco: string, name: string, version: string) => string|undefined}} opts
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function checkAges(depsJson, ecosystem, opts = {}) {
  const now = opts.now ?? Date.now();
  const minDays = opts.minDays ?? MIN_DAYS;
  const lookup = opts.lookup ?? defaultLookup;
  let deps;
  try {
    deps = JSON.parse(depsJson ?? "");
  } catch {
    return { ok: false, reasons: ["the update list could not be read"] };
  }
  if (!Array.isArray(deps) || deps.length === 0) return { ok: false, reasons: ["the update list is empty"] };
  if (ecosystem !== "npm_and_yarn" && ecosystem !== "github_actions") {
    return { ok: false, reasons: [`no age source for ecosystem ${ecosystem || "(none)"}`] };
  }
  const reasons = [];
  for (const d of deps) {
    const name = d?.dependencyName;
    const version = d?.newVersion;
    if (!name || !version) {
      reasons.push("an update has no name or new version");
      continue;
    }
    let published;
    try {
      published = lookup(ecosystem, name, version);
    } catch (e) {
      reasons.push(`${name}@${version}: publish date lookup failed (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const t = Date.parse(published ?? "");
    if (!Number.isFinite(t)) {
      reasons.push(`${name}@${version}: no readable publish date`);
      continue;
    }
    const days = (now - t) / DAY_MS;
    if (days < minDays) reasons.push(`${name}@${version}: published ${days.toFixed(1)} days ago, under ${minDays}`);
  }
  return { ok: reasons.length === 0, reasons };
}

function defaultLookup(ecosystem, name, version) {
  return ecosystem === "npm_and_yarn" ? npmPublished(name, version) : actionPublished(name, version);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, reasons } = checkAges(process.env.UPDATED_DEPS, process.env.ECOSYSTEM);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `old_enough=${ok}\n`);
  const msg = ok
    ? `Every updated version was published at least ${MIN_DAYS} days ago.`
    : `Not auto-merged: ${reasons.join("; ")}. A reviewer merges it.`;
  console.log(msg);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${msg}\n`);
}

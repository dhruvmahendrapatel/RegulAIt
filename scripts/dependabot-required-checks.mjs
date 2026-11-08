#!/usr/bin/env node
// Dependabot auto-merge precondition (2026-11-08, after #759 merged with red and queued checks; ADR-0180 fail closed).
//
// `gh pr merge --auto` waits for the REQUIRED checks only. With no branch protection and no active ruleset on the
// target branch, nothing is required and GitHub merges at once. So before auto-merge is enabled, the target branch must
// enforce every check in REQUIRED_CHECKS, read at run time from the two places GitHub enforces them:
//   - classic branch protection: GET /repos/{repo}/branches/{branch} -> protection.required_status_checks
//     (contexts, and checks[].context), counted only when protection.enabled and enforcement_level != "off";
//   - rulesets: GET /repos/{repo}/rules/branches/{branch} (every page) -> rules of type required_status_checks,
//     counted only when the ruleset they come from (GET /repos/{repo}/rulesets/{id}) is enforcement "active" ("evaluate"
//     and "disabled" do not block a merge) AND its current_user_can_bypass is "never". That field is this token's
//     (github-actions[bot]'s) own bypass status: if the ruleset lets the token bypass it ("always",
//     "pull_requests_only", "exempt") or does not say, its checks do not bind the merge this job enables (#761 review).
// Any lookup that fails, any missing check, or any unreadable answer means "not enforced": the workflow leaves the PR
// for a reviewer and comments why. The workflow never waits and merges by itself.
//
// Limits (#761 review): the protection is read once, when auto-merge is enabled. If the protection is removed later,
// a PR already queued would merge at once; removing it is an admin action, and whoever does it turns off auto-merge
// on open Dependabot PRs first. A check is matched by name only; pinning the app that must report it belongs in the
// ruleset. Org-level rulesets also appear in rules/branches; if this token cannot read one, the gate fails closed and
// auto-merge stays off, which is safe but looks like a bug.
//
// usage (from .github/workflows/dependabot-auto-merge.yml):
//   REPO=owner/name BRANCH=main node scripts/dependabot-required-checks.mjs
// writes `enforced=true|false` to $GITHUB_OUTPUT and the reasons to $GITHUB_STEP_SUMMARY and stdout. Exit 0 either way.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** the required checks (CONTRIBUTING §4.8, ADR-0252/ADR-0261); all must be enforced on the target branch */
export const REQUIRED_CHECKS = Object.freeze([
  "build-and-test",
  "SAST (CodeQL)",
  "Secret scan (gitleaks)",
  "Dependency audit (pnpm)",
  "Image scan and SBOMs (Trivy)",
  "ui enterprise / all",
]);

/** the check names classic branch protection enforces (empty when protection is off) */
export function protectionChecks(branch) {
  const p = branch?.protection;
  if (!p?.enabled) return [];
  const rsc = p.required_status_checks;
  if (!rsc || rsc.enforcement_level === "off") return [];
  return [...(rsc.contexts ?? []), ...(rsc.checks ?? []).map((c) => c?.context)].filter((c) => typeof c === "string");
}

/** the check names rulesets enforce on this token; `ruleset(id)` returns {enforcement, current_user_can_bypass} or throws */
export function rulesetChecks(rules, ruleset) {
  if (!Array.isArray(rules)) throw new Error("the branch rules could not be read");
  const out = [];
  for (const r of rules) {
    if (r?.type !== "required_status_checks") continue;
    const rs = ruleset(r.ruleset_id);
    if (rs?.enforcement !== "active" || rs?.current_user_can_bypass !== "never") continue;
    for (const c of r.parameters?.required_status_checks ?? []) if (typeof c?.context === "string") out.push(c.context);
  }
  return out;
}

/**
 * @param {{ branch: () => any, rules: () => any, ruleset: (id: number) => {enforcement?: string, current_user_can_bypass?: string} }} api
 * @returns {{ enforced: boolean, reasons: string[] }}
 */
export function checkEnforced(api) {
  let have;
  try {
    const memo = new Map();
    const ruleset = (id) => {
      if (!memo.has(id)) memo.set(id, api.ruleset(id));
      return memo.get(id);
    };
    have = new Set([...protectionChecks(api.branch()), ...rulesetChecks(api.rules(), ruleset)]);
  } catch (e) {
    return { enforced: false, reasons: [`the branch's required checks could not be read (${e instanceof Error ? e.message : String(e)})`] };
  }
  const missing = REQUIRED_CHECKS.filter((c) => !have.has(c));
  return missing.length
    ? { enforced: false, reasons: [`the target branch does not require: ${missing.join(", ")}`] }
    : { enforced: true, reasons: [] };
}

function ghJson(route, run = execFileSync, extra = []) {
  return JSON.parse(run("gh", ["api", ...extra, route], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** every page of a list endpoint, flattened (a non-array page throws: fail closed) */
function ghList(route, run = execFileSync) {
  const pages = ghJson(route, run, ["--paginate", "--slurp"]);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`${route} did not return a list`);
  return pages.flat();
}

/** the live API for one repository and branch (GITHUB_TOKEN with contents: read is enough for all three) */
export function liveApi(repo, branch, run = execFileSync) {
  const b = encodeURIComponent(branch);
  return {
    branch: () => ghJson(`repos/${repo}/branches/${b}`, run),
    rules: () => ghList(`repos/${repo}/rules/branches/${b}`, run),
    ruleset: (id) => {
      const { enforcement, current_user_can_bypass } = ghJson(`repos/${repo}/rulesets/${Number(id)}`, run) ?? {};
      if (typeof enforcement !== "string") throw new Error(`ruleset ${id} has no enforcement`);
      return { enforcement, current_user_can_bypass };
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = process.env.REPO;
  const branch = process.env.BRANCH;
  const res = repo && branch ? checkEnforced(liveApi(repo, branch)) : { enforced: false, reasons: ["REPO or BRANCH is not set"] };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `enforced=${res.enforced}\n`);
  const msg = res.enforced
    ? `The target branch enforces every required check: ${REQUIRED_CHECKS.join(", ")}.`
    : `Not auto-merged: ${res.reasons.join("; ")}. Without enforced required checks, auto-merge would merge at once. A reviewer merges it.`;
  console.log(msg);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${msg}\n`);
}

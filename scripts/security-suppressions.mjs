#!/usr/bin/env node
// =============================================================================
// security-suppressions.mjs — no scanner side door (ADR-0184, review B1-01)
//
// Each scanner security.yml runs also honours a suppression file of its own,
// read from the checkout, with no reason and no expiry. Any of them would hide a
// finding before scripts/security-gate.mjs sees it. The only exceptions allowed
// are the reviewed, expiring entries in security/*-allowlist.json and the
// (path AND value) pairs in .gitleaks.toml. This check fails if a side door
// appears in the tracked tree:
//   - gitleaks: a `.gitleaksignore` file (inline `gitleaks:allow` comments are
//     neutralised separately: security.yml runs gitleaks with
//     --ignore-gitleaks-allow, so such a line is reported, not skipped);
//   - Trivy: `.trivyignore`, `.trivyignore.yaml`, `trivy.yaml`, `trivy.yml`
//     (security.yml also runs Trivy from an empty directory);
//   - pnpm audit: `auditConfig` under `pnpm` in any package.json, or
//     `auditConfig` in pnpm-workspace.yaml (ignoreCves / ignoreGhsas).
//
// usage: node scripts/security-suppressions.mjs [repo-root]
// exit:  0 none; 1 a side door is present; 2 the check could not run
// =============================================================================
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_FILES = [".gitleaksignore", ".trivyignore", ".trivyignore.yaml", "trivy.yaml", "trivy.yml"];

/** Problems in a list of tracked files, read through `read(relPath)`. */
export function findSuppressions(files, read) {
  const problems = [];
  for (const f of files) {
    const base = path.posix.basename(f);
    if (FORBIDDEN_FILES.includes(base)) {
      problems.push(`${f}: a scanner suppression file; use security/*-allowlist.json (reason + expiry) instead`);
    }
    if (base === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(read(f));
      } catch {
        continue; // not ours to judge; a broken package.json fails the build elsewhere
      }
      if (pkg?.pnpm && typeof pkg.pnpm === "object" && "auditConfig" in pkg.pnpm) {
        problems.push(`${f}: pnpm.auditConfig suppresses pnpm audit findings; use security/audit-allowlist.json instead`);
      }
    }
    if (base === "pnpm-workspace.yaml" && /^\s*auditConfig\s*:/m.test(read(f))) {
      problems.push(`${f}: auditConfig suppresses pnpm audit findings; use security/audit-allowlist.json instead`);
    }
  }
  return problems;
}

function main() {
  const root = path.resolve(process.argv[2] ?? ".");
  let files;
  try {
    files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  } catch (err) {
    console.error(`CHECK ERROR: cannot list tracked files in ${root}: ${err.message}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`CHECK ERROR: no tracked files in ${root}`);
    process.exit(2);
  }
  const problems = findSuppressions(files, (f) => readFileSync(path.join(root, f), "utf8"));
  if (problems.length) {
    for (const p of problems) console.error(`SCANNER SUPPRESSION: ${p}`);
    process.exit(1);
  }
  console.log(`no scanner suppression file or setting in ${files.length} tracked files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
